//! Git: what differs from HEAD and the before/after text for one file (read
//! through git2), plus the write loop -- stage, commit, pull, push -- which
//! runs the user's own `git` binary.
//!
//! Reads go through `with_repo`, which owns repo discovery and path resolution.
//! Writes go through `run_git` instead: pull and push need the user's
//! credential helpers, SSH agent, hooks, signing and `pull.*` config, all of
//! which the CLI already honours and git2 would have to rebuild by hand.
//! An SSH key passphrase is asked for once and kept in the macOS Keychain,
//! see `ssh_command`.
//!
//! Note the repo root and the workspace root are not necessarily the same: you
//! can open a subdirectory of a repo as the workspace. Status is therefore
//! filtered to the open workspace, and paths are reported absolute so the tree
//! can match them directly.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use git2::{Branch, BranchType, Repository, RepositoryState, Status, StatusOptions};
use serde::Serialize;
use tauri::State;

use crate::fs::{MAX_FILE_BYTES, Workspace, inside_workspace, looks_binary, workspace_root};

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Conflicted,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    /// Absolute, so the file tree can match without knowing the repo root.
    pub path: String,
    /// The combined badge the tree shows.
    pub status: ChangeKind,
    /// What is in the index relative to HEAD, if anything.
    pub staged: Option<ChangeKind>,
    /// What is in the working tree relative to the index, if anything. A
    /// conflict lands here: resolving it is working-tree work.
    pub unstaged: Option<ChangeKind>,
    /// Where a renamed file came from, absolute. Staging or unstaging a rename
    /// has to name both ends or git sees half of it.
    pub old_path: Option<String>,
}

/// A multi-step operation git stopped in the middle of, usually on a conflict.
/// Until it is continued or aborted, the next merge or rebase is refused.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RepoOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl RepoOperation {
    fn of(state: RepositoryState) -> Option<Self> {
        use RepositoryState as S;
        match state {
            S::Merge => Some(Self::Merge),
            S::Rebase | S::RebaseInteractive | S::RebaseMerge | S::ApplyMailboxOrRebase => {
                Some(Self::Rebase)
            }
            S::CherryPick | S::CherryPickSequence => Some(Self::CherryPick),
            S::Revert | S::RevertSequence => Some(Self::Revert),
            _ => None,
        }
    }

    /// The git subcommand that owns `--continue` / `--abort` for it.
    fn command(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    /// A plain folder is a normal state, not an error: the UI drops badges and
    /// the diff mode, and everything else keeps working.
    pub is_repo: bool,
    pub branch: Option<String>,
    /// e.g. `origin/main`; None when the branch tracks nothing yet.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
    /// A merge, rebase, cherry-pick or revert waiting to be continued.
    pub operation: Option<RepoOperation>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileDiff {
    /// `old` is the HEAD blob (empty for an untracked file), `new` is the
    /// working copy (empty for a deleted one). The frontend renders the
    /// comparison; parsing hunks here would duplicate what CodeMirror does.
    Text { old: String, new: String },
    Binary,
    TooLarge { bytes: u64 },
    NotRepo,
}

/// The one boundary through which git work happens.
pub(crate) fn with_repo<T>(
    ws: &Workspace,
    root: &str,
    f: impl FnOnce(&Repository, &Path, &Path) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let root = workspace_root(ws, root)?;
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    // A bare repo has no working tree to compare against.
    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return Ok(None),
    };
    f(&repo, &workdir, &root).map(Some)
}

fn classify(s: Status) -> Option<ChangeKind> {
    // Most-significant first: a conflicted file is also "modified", and a
    // rename also reports as added+deleted, so order decides the badge.
    if s.contains(Status::CONFLICTED) {
        return Some(ChangeKind::Conflicted);
    }
    if s.intersects(Status::WT_RENAMED | Status::INDEX_RENAMED) {
        return Some(ChangeKind::Renamed);
    }
    if s.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
        return Some(ChangeKind::Deleted);
    }
    if s.intersects(Status::WT_NEW | Status::INDEX_NEW) {
        return Some(ChangeKind::Added);
    }
    if s.intersects(Status::WT_MODIFIED | Status::INDEX_MODIFIED) {
        return Some(ChangeKind::Modified);
    }
    None
}

/// The index half of `classify`, same ordering.
fn classify_index(s: Status) -> Option<ChangeKind> {
    if s.contains(Status::CONFLICTED) {
        return None;
    }
    if s.contains(Status::INDEX_RENAMED) {
        return Some(ChangeKind::Renamed);
    }
    if s.contains(Status::INDEX_DELETED) {
        return Some(ChangeKind::Deleted);
    }
    if s.contains(Status::INDEX_NEW) {
        return Some(ChangeKind::Added);
    }
    if s.intersects(Status::INDEX_MODIFIED | Status::INDEX_TYPECHANGE) {
        return Some(ChangeKind::Modified);
    }
    None
}

/// The working-tree half of `classify`, same ordering.
fn classify_worktree(s: Status) -> Option<ChangeKind> {
    if s.contains(Status::CONFLICTED) {
        return Some(ChangeKind::Conflicted);
    }
    if s.contains(Status::WT_RENAMED) {
        return Some(ChangeKind::Renamed);
    }
    if s.contains(Status::WT_DELETED) {
        return Some(ChangeKind::Deleted);
    }
    if s.contains(Status::WT_NEW) {
        return Some(ChangeKind::Added);
    }
    if s.intersects(Status::WT_MODIFIED | Status::WT_TYPECHANGE) {
        return Some(ChangeKind::Modified);
    }
    None
}

/// The upstream's short name and how far HEAD has drifted from it. Everything
/// here is optional: a detached HEAD, an unborn branch or no tracking branch
/// all just mean "nothing to show".
fn tracking(repo: &Repository) -> (Option<String>, u32, u32) {
    let Ok(head) = repo.head() else {
        return (None, 0, 0);
    };
    if !head.is_branch() {
        return (None, 0, 0);
    }
    let local = head.target();
    let Ok(upstream) = Branch::wrap(head).upstream() else {
        return (None, 0, 0);
    };
    let name = upstream.name().ok().flatten().map(str::to_string);
    let (ahead, behind) = match (local, upstream.get().target()) {
        (Some(l), Some(u)) => repo.graph_ahead_behind(l, u).unwrap_or((0, 0)),
        _ => (0, 0),
    };
    (name, ahead as u32, behind as u32)
}

#[tauri::command]
pub fn git_status(ws: State<'_, Workspace>, root: String) -> Result<RepoStatus, String> {
    let found = with_repo(&ws, &root, |repo, workdir, root| {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);

        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

        let mut files: Vec<FileStatus> = statuses
            .iter()
            .filter_map(|entry| {
                // git2 0.21 returns Result here because it validates UTF-8;
                // a non-UTF-8 path is simply skipped rather than failing the
                // whole status call.
                let rel = entry.path().ok()?;
                let s = entry.status();
                let kind = classify(s)?;
                let abs = workdir.join(rel);
                let old_path = entry
                    .head_to_index()
                    .or_else(|| entry.index_to_workdir())
                    .and_then(|d| d.old_file().path().map(|p| workdir.join(p)))
                    .filter(|p| *p != abs)
                    .map(|p| p.to_string_lossy().to_string());
                // Only report what is inside the open workspace -- the repo may
                // extend above it.
                abs.starts_with(root).then(|| FileStatus {
                    path: abs.to_string_lossy().to_string(),
                    status: kind,
                    staged: classify_index(s),
                    unstaged: classify_worktree(s),
                    old_path,
                })
            })
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));

        let branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().ok().map(str::to_string));
        let (upstream, ahead, behind) = tracking(repo);

        Ok(RepoStatus {
            is_repo: true,
            branch,
            upstream,
            ahead,
            behind,
            files,
            operation: RepoOperation::of(repo.state()),
        })
    })?;

    Ok(found.unwrap_or(RepoStatus {
        is_repo: false,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        operation: None,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// `feature` for a local branch, `origin/feature` for a remote one.
    pub name: String,
    pub remote: bool,
    /// What a local branch tracks, e.g. `origin/feature`.
    pub upstream: Option<String>,
    /// Commits this branch has that its upstream lacks, and the reverse.
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    /// None on a detached or unborn HEAD.
    pub current: Option<String>,
    pub local: Vec<BranchInfo>,
    /// Only the remote branches no local branch tracks: picking one of those
    /// would just be switching to its local twin, which is already listed.
    pub remote: Vec<BranchInfo>,
}

fn list_branches(repo: &Repository) -> Result<BranchList, String> {
    let current = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string));

    let mut local = Vec::new();
    for entry in repo.branches(Some(BranchType::Local)).map_err(|e| e.to_string())? {
        let Ok((branch, _)) = entry else { continue };
        let Some(name) = branch.name().ok().flatten().map(str::to_string) else {
            continue;
        };
        let up = branch.upstream().ok();
        let upstream = up
            .as_ref()
            .and_then(|u| u.name().ok().flatten().map(str::to_string));
        let (ahead, behind) = match (branch.get().target(), up.and_then(|u| u.get().target())) {
            (Some(l), Some(u)) => repo.graph_ahead_behind(l, u).unwrap_or((0, 0)),
            _ => (0, 0),
        };
        local.push(BranchInfo {
            name,
            remote: false,
            upstream,
            ahead: ahead as u32,
            behind: behind as u32,
        });
    }

    let mut remote = Vec::new();
    for entry in repo.branches(Some(BranchType::Remote)).map_err(|e| e.to_string())? {
        let Ok((branch, _)) = entry else { continue };
        // `origin/HEAD` is a pointer to another remote branch, not one itself.
        if branch.get().symbolic_target().is_ok_and(|t| t.is_some()) {
            continue;
        }
        let Some(name) = branch.name().ok().flatten().map(str::to_string) else {
            continue;
        };
        if name.ends_with("/HEAD") || local.iter().any(|l| l.upstream.as_deref() == Some(&name)) {
            continue;
        }
        remote.push(BranchInfo { name, remote: true, upstream: None, ahead: 0, behind: 0 });
    }

    local.sort_by(|a, b| a.name.cmp(&b.name));
    remote.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(BranchList { current, local, remote })
}

/// Async and off the main thread: a repo with thousands of remote branches is
/// a noticeable walk, and a sync command would freeze the webview for it.
#[tauri::command]
pub async fn git_branches(ws: State<'_, Workspace>, root: String) -> Result<BranchList, String> {
    let root = workspace_root(&ws, &root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(repo) = Repository::discover(&root) else {
            return Ok(BranchList { current: None, local: Vec::new(), remote: Vec::new() });
        };
        list_branches(&repo)
    })
    .await
    .map_err(|e| format!("listing branches did not finish: {e}"))?
}

/// HEAD's version of `rel`, or empty when the file is untracked / newly added.
fn head_blob(repo: &Repository, rel: &Path) -> Result<Option<Vec<u8>>, String> {
    let Ok(head) = repo.head() else {
        // Unborn HEAD: a repo with no commits yet, so everything is new.
        return Ok(None);
    };
    let tree = head.peel_to_tree().map_err(|e| e.to_string())?;
    blob_at(repo, &tree, rel)
}

/// `rel`'s contents in `tree`, or None when the tree has no such file.
pub(crate) fn blob_at(
    repo: &Repository,
    tree: &git2::Tree,
    rel: &Path,
) -> Result<Option<Vec<u8>>, String> {
    match tree.get_path(rel) {
        Ok(entry) => {
            let obj = entry.to_object(repo).map_err(|e| e.to_string())?;
            Ok(obj.as_blob().map(|b| b.content().to_vec()))
        }
        Err(_) => Ok(None),
    }
}

/// Two versions of a file as the diff the frontend renders, or the reason it
/// cannot be one.
pub(crate) fn text_diff(old_bytes: Vec<u8>, new_bytes: Vec<u8>) -> FileDiff {
    let total = (old_bytes.len() + new_bytes.len()) as u64;
    if total > MAX_FILE_BYTES {
        return FileDiff::TooLarge { bytes: total };
    }
    if looks_binary(&old_bytes) || looks_binary(&new_bytes) {
        return FileDiff::Binary;
    }
    match (String::from_utf8(old_bytes), String::from_utf8(new_bytes)) {
        (Ok(old), Ok(new)) => FileDiff::Text { old, new },
        _ => FileDiff::Binary,
    }
}

#[tauri::command]
pub fn git_diff(ws: State<'_, Workspace>, root: String, path: String) -> Result<FileDiff, String> {
    let found = with_repo(&ws, &root, |repo, workdir, root| {
        let abs = PathBuf::from(&path);
        if !inside_workspace(root, &abs) {
            return Err(format!("{path} is outside the workspace"));
        }
        let rel = abs
            .strip_prefix(workdir)
            .map_err(|_| format!("{path} is outside the repository"))?;

        let old_bytes = head_blob(repo, rel)?.unwrap_or_default();
        // Missing working file means deleted; that is a diff, not an error.
        let new_bytes = std::fs::read(&abs).unwrap_or_default();
        Ok(text_diff(old_bytes, new_bytes))
    })?;

    Ok(found.unwrap_or(FileDiff::NotRepo))
}

// ---- writes ----

/// One git write at a time: two concurrent ones would fight over `index.lock`,
/// and the loser's error would read like a bug rather than a race.
static GIT_GATE: Mutex<()> = Mutex::new(());

/// Run a git write on a worker thread. Sync commands run on the macOS main
/// thread and freeze the webview, and a push can take seconds.
async fn off_thread<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = GIT_GATE.lock().unwrap_or_else(|e| e.into_inner());
        f()
    })
    .await
    .map_err(|e| format!("the git operation did not finish: {e}"))?
}

/// Answers ssh's prompts (a key passphrase, an unknown host key) with a native
/// dialog. Cancel exits non-zero, and ssh fails with its own message.
const ASKPASS_SCRIPT: &str = r#"#!/bin/sh
case "$1" in
  *yes/no*) hidden=""; prompt="$1" ;;
  *) hidden="with hidden answer"
     prompt="$1

It will be saved in your macOS Keychain." ;;
esac
exec /usr/bin/osascript \
  -e 'on run argv' \
  -e 'activate' \
  -e "return text returned of (display dialog (item 1 of argv) default answer \"\" $hidden with title \"Aditor — git\")" \
  -e 'end run' \
  "$prompt"
"#;

/// Apple's ssh reads a key's passphrase from the login Keychain, and after it
/// decrypts a key with a typed one, saves it there and loads the key into the
/// agent -- so the askpass dialog comes up once per key, ever. A wrong
/// passphrase is never saved. `IgnoreUnknown` keeps a non-Apple ssh on PATH
/// (Homebrew's lacks `UseKeychain`) working, just without the memory.
///
/// None when the user picked their own ssh command; theirs wins.
fn ssh_command(root: &Path) -> Option<&'static str> {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() || std::env::var_os("GIT_SSH").is_some() {
        return None;
    }
    let configured = match Repository::discover(root) {
        Ok(repo) => repo.config().ok(),
        Err(_) => git2::Config::open_default().ok(),
    }
    .is_some_and(|c| c.get_string("core.sshCommand").is_ok());
    if configured {
        return None;
    }
    Some("ssh -o IgnoreUnknown=UseKeychain -o UseKeychain=yes -o AddKeysToAgent=yes")
}

/// The askpass helper on disk, written once per run. None if it could not be,
/// in which case ssh keeps its default behaviour.
fn askpass() -> Option<&'static Path> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        use std::os::unix::fs::OpenOptionsExt;
        // $TMPDIR on macOS is per-user and private.
        let path = std::env::temp_dir().join(format!("aditor-askpass-{}.sh", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o700)
            .open(&path)
            .ok()?;
        file.write_all(ASKPASS_SCRIPT.as_bytes()).ok()?;
        Some(path)
    })
    .as_deref()
}

/// `git <args>` in `root`, through a login shell so the user's real PATH (and
/// so their git) resolves in a GUI-launched app. Arguments travel as
/// positional parameters, so nothing is ever quoted into the script.
///
/// No terminal is attached and git's own prompting is off: a credential
/// prompt fails fast with git's own message instead of hanging forever.
///
/// ssh does not honour `GIT_TERMINAL_PROMPT`: with a passphrase-protected key
/// and an empty agent it opens /dev/tty and waits there -- on the terminal
/// that launched the app, or on nothing at all. Forcing askpass sends its
/// prompts to a dialog instead, and `ssh_command` keeps the answer.
fn run_git(root: &Path, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new(crate::pty::user_shell());
    cmd.args(["-l", "-c", "exec git \"$@\"", "git"])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        // There is no terminal for an editor to open in. Merges, reverts and
        // `--continue` take git's prepared message instead of waiting forever.
        .env("GIT_EDITOR", "true")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(helper) = askpass() {
        cmd.env("SSH_ASKPASS", helper).env("SSH_ASKPASS_REQUIRE", "force");
    }
    if let Some(ssh) = ssh_command(root) {
        cmd.env("GIT_SSH_COMMAND", ssh);
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
    if let Some(input) = stdin {
        // Taken, so it drops (closing the pipe) before we wait.
        let mut pipe = child.stdin.take().expect("stdin was piped");
        pipe.write_all(input.as_bytes())
            .map_err(|e| format!("could not talk to git: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("git did not finish: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("git {} failed", args.first().unwrap_or(&""))
    })
}

/// Every path must stay inside the workspace, as in `git_diff`.
fn check_paths(root: &Path, paths: &[String]) -> Result<(), String> {
    match paths.iter().find(|p| !inside_workspace(root, Path::new(p))) {
        Some(p) => Err(format!("{p} is outside the workspace")),
        None => Ok(()),
    }
}

fn unstage(root: &Path, paths: &[&str]) -> Result<String, String> {
    // `restore --staged` needs a HEAD to restore from. With no commits yet,
    // unstaging means dropping the paths from the index altogether.
    let unborn = Repository::discover(root)
        .map(|r| r.head().is_err())
        .unwrap_or(false);
    let mut args: Vec<&str> = if unborn {
        vec!["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"]
    } else {
        vec!["restore", "--staged", "--"]
    };
    args.extend_from_slice(paths);
    run_git(root, &args, None)
}

#[tauri::command]
pub async fn git_stage(
    ws: State<'_, Workspace>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let root = workspace_root(&ws, &root)?;
    check_paths(&root, &paths)?;
    off_thread(move || {
        let mut args = vec!["add", "-A", "--"];
        args.extend(paths.iter().map(String::as_str));
        run_git(&root, &args, None).map(drop)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(
    ws: State<'_, Workspace>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let root = workspace_root(&ws, &root)?;
    check_paths(&root, &paths)?;
    off_thread(move || {
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        unstage(&root, &paths).map(drop)
    })
    .await
}

/// The workspace root as the pathspec, so a subdirectory workspace stages only
/// its own subtree.
#[tauri::command]
pub async fn git_stage_all(ws: State<'_, Workspace>, root: String) -> Result<(), String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["add", "-A", "--", "."], None).map(drop)).await
}

#[tauri::command]
pub async fn git_unstage_all(ws: State<'_, Workspace>, root: String) -> Result<(), String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || unstage(&root, &["."]).map(drop)).await
}

#[tauri::command]
pub async fn git_commit(
    ws: State<'_, Workspace>,
    root: String,
    message: String,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("A commit needs a message.".into());
    }
    let root = workspace_root(&ws, &root)?;
    // Through stdin rather than `-m`: a multi-line message survives intact, and
    // hooks and signing run exactly as they would in a terminal.
    off_thread(move || run_git(&root, &["commit", "-F", "-"], Some(&message)).map(drop)).await
}

/// The explicit flag wins over `pull.rebase`, since the user picked one.
#[tauri::command]
pub async fn git_pull(
    ws: State<'_, Workspace>,
    root: String,
    rebase: bool,
) -> Result<String, String> {
    let root = workspace_root(&ws, &root)?;
    let mode = if rebase { "--rebase" } else { "--no-rebase" };
    off_thread(move || run_git(&root, &["pull", mode], None)).await
}

/// The remote a branch with no upstream goes to: `origin`, or the only one.
fn default_remote(repo: &Repository) -> Result<String, String> {
    let remotes: Vec<String> = repo
        .remotes()
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|r| r.ok().flatten().map(str::to_string))
        .collect();
    if remotes.iter().any(|r| r == "origin") {
        return Ok("origin".to_string());
    }
    match remotes.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err("This repository has no remote to push to.".into()),
        _ => Err("This branch tracks no upstream and there is no `origin` to pick.".into()),
    }
}

/// Push, setting up tracking on the first push of a branch: a plain `git push`
/// would refuse with advice the user cannot act on from here.
///
/// `force` is `--force-with-lease`, never a bare `--force`: it still refuses
/// when the remote moved since the last fetch, so nobody else's work is lost.
/// A bare lease alone is not enough here, because Aditor's own Fetch moves the
/// remote-tracking ref the lease compares against, and the push would then go
/// through like `--force`. `--force-if-includes` (git 2.30) also requires that
/// remote tip to have been integrated locally, which a fetch alone does not do.
#[tauri::command]
pub async fn git_push(
    ws: State<'_, Workspace>,
    root: String,
    force: bool,
    tags: bool,
) -> Result<String, String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || {
        let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
        let (upstream, _, _) = tracking(&repo);
        let mut args = vec!["push"];
        if force {
            args.extend(["--force-with-lease", "--force-if-includes"]);
        }
        if tags {
            args.push("--follow-tags");
        }
        if upstream.is_some() {
            return run_git(&root, &args, None);
        }
        let remote = default_remote(&repo)?;
        drop(repo);
        args.extend(["-u", &remote, "HEAD"]);
        run_git(&root, &args, None)
    })
    .await
}

/// Switch to a local branch, or to a remote one by creating the local branch
/// that tracks it. Git's own refusal (a dirty tree in the way) comes back as-is.
#[tauri::command]
pub async fn git_checkout(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
    remote: bool,
) -> Result<(), String> {
    // `switch` has no `--` before the branch (it would mean a pathspec), so a
    // leading dash must not reach it as an option.
    if name.is_empty() || name.starts_with('-') {
        return Err(format!("{name:?} is not a branch name."));
    }
    let root = workspace_root(&ws, &root)?;
    off_thread(move || {
        if !remote {
            return run_git(&root, &["switch", &name], None).map(drop);
        }
        let short = name.split_once('/').map_or(name.as_str(), |(_, b)| b);
        let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
        if repo.find_branch(short, BranchType::Local).is_ok() {
            return Err(format!(
                "A local branch `{short}` already exists; switch to it instead."
            ));
        }
        drop(repo);
        run_git(&root, &["switch", "--track", &name], None).map(drop)
    })
    .await
}

/// Refresh every remote's branches, dropping the ones deleted upstream.
#[tauri::command]
pub async fn git_fetch(ws: State<'_, Workspace>, root: String) -> Result<(), String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["fetch", "--all", "--prune"], None).map(drop)).await
}

// ---- branches, history and recovery ----

/// A name git will take as a ref or revision rather than as an option: these
/// all reach commands where a leading dash would be parsed as a flag.
fn check_name(name: &str, what: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.starts_with('-') || name.chars().any(char::is_whitespace) {
        return Err(format!("{name:?} is not a valid {what}."));
    }
    Ok(())
}

/// A commit id as the log hands it over: hex, nothing else.
fn check_id(id: &str) -> Result<(), String> {
    if id.len() < 4 || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{id:?} is not a commit id."));
    }
    Ok(())
}

/// Put `paths` back to how HEAD has them, in the index and on disk -- IntelliJ's
/// Rollback. A path HEAD does not have (added, or untracked) is dropped from
/// the index, and its file deleted only when `delete_untracked` asks for it.
#[tauri::command]
pub async fn git_rollback(
    ws: State<'_, Workspace>,
    root: String,
    paths: Vec<String>,
    delete_untracked: bool,
) -> Result<(), String> {
    let root = workspace_root(&ws, &root)?;
    check_paths(&root, &paths)?;
    off_thread(move || rollback(&root, &paths, delete_untracked)).await
}

fn rollback(root: &Path, paths: &[String], delete_untracked: bool) -> Result<(), String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let workdir = repo.workdir().ok_or("This repository has no working tree.")?.to_path_buf();
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let (tracked, added): (Vec<&String>, Vec<&String>) = paths.iter().partition(|p| {
        let rel = Path::new(p.as_str()).strip_prefix(&workdir).unwrap_or(Path::new(p.as_str()));
        head_tree.as_ref().is_some_and(|t| t.get_path(rel).is_ok())
    });
    drop(head_tree);
    drop(repo);

    if !tracked.is_empty() {
        let mut args = vec!["restore", "--source=HEAD", "--staged", "--worktree", "--"];
        args.extend(tracked.iter().map(|p| p.as_str()));
        run_git(root, &args, None)?;
    }
    if !added.is_empty() {
        let mut args = vec!["rm", "--cached", "-q", "-r", "--ignore-unmatch", "--"];
        args.extend(added.iter().map(|p| p.as_str()));
        run_git(root, &args, None)?;
        if delete_untracked {
            for p in added {
                let path = Path::new(p.as_str());
                if path.is_file() || path.is_symlink() {
                    std::fs::remove_file(path).map_err(|e| format!("could not delete {p}: {e}"))?;
                }
            }
        }
    }
    Ok(())
}

/// A new branch at `from` (HEAD when None), switched to when `checkout` is set.
#[tauri::command]
pub async fn git_branch_create(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
    from: Option<String>,
    checkout: bool,
) -> Result<(), String> {
    check_name(&name, "branch name")?;
    if let Some(f) = &from {
        check_name(f, "revision")?;
    }
    let root = workspace_root(&ws, &root)?;
    off_thread(move || {
        let mut args = if checkout { vec!["switch", "-c", &name] } else { vec!["branch", &name] };
        if let Some(f) = &from {
            args.push(f);
        }
        run_git(&root, &args, None).map(drop)
    })
    .await
}

#[tauri::command]
pub async fn git_branch_rename(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
    to: String,
) -> Result<(), String> {
    check_name(&name, "branch name")?;
    check_name(&to, "branch name")?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["branch", "-m", &name, &to], None).map(drop)).await
}

/// Delete a local branch, or a remote one on its remote. `-d` refuses an
/// unmerged branch with git's own explanation; `force` is the `-D` that follows.
#[tauri::command]
pub async fn git_branch_delete(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
    remote: bool,
    force: bool,
) -> Result<(), String> {
    check_name(&name, "branch name")?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || {
        if !remote {
            let flag = if force { "-D" } else { "-d" };
            return run_git(&root, &["branch", flag, &name], None).map(drop);
        }
        let (remote, branch) = name
            .split_once('/')
            .ok_or_else(|| format!("{name:?} does not name a remote branch."))?;
        run_git(&root, &["push", remote, "--delete", branch], None).map(drop)
    })
    .await
}

/// Merge `name` into the current branch. A conflict comes back as git's error
/// and leaves the merge in progress, for `git_operation_*` to finish.
#[tauri::command]
pub async fn git_merge(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
) -> Result<String, String> {
    check_name(&name, "branch name")?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["merge", "--no-edit", &name], None)).await
}

#[tauri::command]
pub async fn git_rebase(
    ws: State<'_, Workspace>,
    root: String,
    onto: String,
) -> Result<String, String> {
    check_name(&onto, "branch name")?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["rebase", &onto], None)).await
}

#[tauri::command]
pub async fn git_cherry_pick(
    ws: State<'_, Workspace>,
    root: String,
    id: String,
) -> Result<String, String> {
    check_id(&id)?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["cherry-pick", &id], None)).await
}

#[tauri::command]
pub async fn git_revert(
    ws: State<'_, Workspace>,
    root: String,
    id: String,
) -> Result<String, String> {
    check_id(&id)?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["revert", "--no-edit", &id], None)).await
}

/// Move the current branch to `id`. `mode` is soft, mixed or hard, as in
/// IntelliJ's Reset dialog.
#[tauri::command]
pub async fn git_reset(
    ws: State<'_, Workspace>,
    root: String,
    id: String,
    mode: String,
) -> Result<(), String> {
    check_id(&id)?;
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        _ => return Err(format!("{mode:?} is not a reset mode.")),
    };
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["reset", "-q", flag, &id], None).map(drop)).await
}

/// Check out a commit itself, leaving HEAD detached.
#[tauri::command]
pub async fn git_checkout_revision(
    ws: State<'_, Workspace>,
    root: String,
    id: String,
) -> Result<(), String> {
    check_id(&id)?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["switch", "--detach", &id], None).map(drop)).await
}

/// A tag on `id`: annotated when there is a message, lightweight otherwise.
#[tauri::command]
pub async fn git_tag_create(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
    id: String,
    message: Option<String>,
) -> Result<(), String> {
    check_name(&name, "tag name")?;
    check_id(&id)?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || match message.filter(|m| !m.trim().is_empty()) {
        Some(m) => run_git(&root, &["tag", "-a", &name, "-F", "-", &id], Some(&m)).map(drop),
        None => run_git(&root, &["tag", &name, &id], None).map(drop),
    })
    .await
}

#[tauri::command]
pub async fn git_tag_delete(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
) -> Result<(), String> {
    check_name(&name, "tag name")?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || run_git(&root, &["tag", "-d", &name], None).map(drop)).await
}

/// Push one tag to the branch's remote (or the default one).
#[tauri::command]
pub async fn git_push_tag(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
) -> Result<String, String> {
    check_name(&name, "tag name")?;
    let root = workspace_root(&ws, &root)?;
    off_thread(move || {
        let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
        let remote = tracking(&repo)
            .0
            .and_then(|u| u.split_once('/').map(|(r, _)| r.to_string()))
            .map_or_else(|| default_remote(&repo), Ok)?;
        drop(repo);
        let refspec = format!("refs/tags/{name}");
        run_git(&root, &["push", &remote, &refspec], None)
    })
    .await
}

/// The operation git is stopped in, or an error saying there is none.
fn pending_operation(root: &Path) -> Result<RepoOperation, String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    RepoOperation::of(repo.state()).ok_or_else(|| "There is no operation in progress.".into())
}

/// Carry on with the stopped merge, rebase, cherry-pick or revert, once its
/// conflicts are resolved and staged.
#[tauri::command]
pub async fn git_operation_continue(
    ws: State<'_, Workspace>,
    root: String,
) -> Result<String, String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || {
        let op = pending_operation(&root)?;
        run_git(&root, &[op.command(), "--continue"], None)
    })
    .await
}

#[tauri::command]
pub async fn git_operation_abort(ws: State<'_, Workspace>, root: String) -> Result<(), String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || {
        let op = pending_operation(&root)?;
        run_git(&root, &[op.command(), "--abort"], None).map(drop)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway repo with a fixed identity, built with the real git CLI.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("aditor-git-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            // Canonical, as `workspace_root` hands it over: /var is /private/var.
            let s = Scratch(dir.canonicalize().unwrap());
            for args in [
                &["init", "-q", "-b", "main"][..],
                &["config", "user.name", "Test"],
                &["config", "user.email", "t@example.com"],
                &["config", "commit.gpgsign", "false"],
            ] {
                s.git(args);
            }
            s
        }
        fn git(&self, args: &[&str]) -> String {
            run_git(&self.0, args, None).unwrap()
        }
        fn path(&self, rel: &str) -> String {
            self.0.join(rel).to_string_lossy().to_string()
        }
        fn write(&self, rel: &str, text: &str) {
            std::fs::write(self.0.join(rel), text).unwrap();
        }
        fn read(&self, rel: &str) -> Option<String> {
            std::fs::read_to_string(self.0.join(rel)).ok()
        }
        fn commit(&self, rel: &str, text: &str, msg: &str) {
            self.write(rel, text);
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rollback_restores_tracked_and_keeps_untracked_unless_asked() {
        let s = Scratch::new("rollback");
        s.commit("a.txt", "one\n", "first");
        s.write("a.txt", "changed\n");
        s.git(&["add", "a.txt"]);
        s.write("new.txt", "fresh\n");
        s.git(&["add", "new.txt"]);

        rollback(&s.0, &[s.path("a.txt"), s.path("new.txt")], false).unwrap();
        assert_eq!(s.read("a.txt").as_deref(), Some("one\n"));
        // Unstaged, but still on disk.
        assert_eq!(s.read("new.txt").as_deref(), Some("fresh\n"));
        assert_eq!(s.git(&["status", "--porcelain"]), "?? new.txt");

        rollback(&s.0, &[s.path("new.txt")], true).unwrap();
        assert_eq!(s.read("new.txt"), None);
        assert_eq!(s.git(&["status", "--porcelain"]), "");
    }

    #[test]
    fn rollback_brings_back_a_deleted_file() {
        let s = Scratch::new("rollback-deleted");
        s.commit("a.txt", "one\n", "first");
        std::fs::remove_file(s.0.join("a.txt")).unwrap();
        rollback(&s.0, &[s.path("a.txt")], false).unwrap();
        assert_eq!(s.read("a.txt").as_deref(), Some("one\n"));
    }

    #[test]
    fn a_conflicted_merge_is_an_operation_until_aborted() {
        let s = Scratch::new("merge");
        s.commit("a.txt", "base\n", "base");
        s.git(&["switch", "-q", "-c", "other"]);
        s.commit("a.txt", "theirs\n", "theirs");
        s.git(&["switch", "-q", "main"]);
        s.commit("a.txt", "ours\n", "ours");
        assert!(run_git(&s.0, &["merge", "--no-edit", "other"], None).is_err());

        assert_eq!(pending_operation(&s.0), Ok(RepoOperation::Merge));
        run_git(&s.0, &["merge", "--abort"], None).unwrap();
        assert!(pending_operation(&s.0).is_err());
        assert_eq!(s.read("a.txt").as_deref(), Some("ours\n"));
    }

    #[test]
    fn names_that_look_like_options_are_refused() {
        assert!(check_name("-D", "branch name").is_err());
        assert!(check_name("feature x", "branch name").is_err());
        assert!(check_name("feature/x", "branch name").is_ok());
        assert!(check_id("--hard").is_err());
        assert!(check_id("a1b2c3d").is_ok());
    }
}
