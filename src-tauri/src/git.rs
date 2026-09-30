//! Git: what differs from HEAD and the before/after text for one file (read
//! through git2), plus the write loop -- stage, commit, pull, push -- which
//! runs the user's own `git` binary.
//!
//! Reads go through `with_repo`, which owns repo discovery and path resolution.
//! Writes go through `run_git` instead: pull and push need the user's
//! credential helpers, SSH agent, hooks, signing and `pull.*` config, all of
//! which the CLI already honours and git2 would have to rebuild by hand.
//!
//! Note the repo root and the workspace root are not necessarily the same: you
//! can open a subdirectory of a repo as the workspace. Status is therefore
//! filtered to the open workspace, and paths are reported absolute so the tree
//! can match them directly.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use git2::{Branch, BranchType, Repository, Status, StatusOptions};
use serde::Serialize;
use tauri::State;

use crate::fs::{MAX_FILE_BYTES, Workspace, looks_binary, workspace_root};

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
fn with_repo<T>(
    ws: &Workspace,
    f: impl FnOnce(&Repository, &Path, &Path) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let root = workspace_root(ws)?;
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
pub fn git_status(ws: State<'_, Workspace>) -> Result<RepoStatus, String> {
    let found = with_repo(&ws, |repo, workdir, root| {
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
        })
    })?;

    Ok(found.unwrap_or(RepoStatus {
        is_repo: false,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
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
        let upstream = branch
            .upstream()
            .ok()
            .and_then(|u| u.name().ok().flatten().map(str::to_string));
        local.push(BranchInfo { name, remote: false, upstream });
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
        remote.push(BranchInfo { name, remote: true, upstream: None });
    }

    local.sort_by(|a, b| a.name.cmp(&b.name));
    remote.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(BranchList { current, local, remote })
}

/// Async and off the main thread: a repo with thousands of remote branches is
/// a noticeable walk, and a sync command would freeze the webview for it.
#[tauri::command]
pub async fn git_branches(ws: State<'_, Workspace>) -> Result<BranchList, String> {
    let root = workspace_root(&ws)?;
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
    match tree.get_path(rel) {
        Ok(entry) => {
            let obj = entry.to_object(repo).map_err(|e| e.to_string())?;
            Ok(obj.as_blob().map(|b| b.content().to_vec()))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn git_diff(ws: State<'_, Workspace>, path: String) -> Result<FileDiff, String> {
    let found = with_repo(&ws, |repo, workdir, root| {
        let abs = PathBuf::from(&path);
        if !abs.starts_with(root) {
            return Err(format!("{path} is outside the workspace"));
        }
        let rel = abs
            .strip_prefix(workdir)
            .map_err(|_| format!("{path} is outside the repository"))?;

        let old_bytes = head_blob(repo, rel)?.unwrap_or_default();
        // Missing working file means deleted; that is a diff, not an error.
        let new_bytes = std::fs::read(&abs).unwrap_or_default();

        let total = (old_bytes.len() + new_bytes.len()) as u64;
        if total > MAX_FILE_BYTES {
            return Ok(FileDiff::TooLarge { bytes: total });
        }
        if looks_binary(&old_bytes) || looks_binary(&new_bytes) {
            return Ok(FileDiff::Binary);
        }

        match (String::from_utf8(old_bytes), String::from_utf8(new_bytes)) {
            (Ok(old), Ok(new)) => Ok(FileDiff::Text { old, new }),
            _ => Ok(FileDiff::Binary),
        }
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
  *yes/no*) hidden="" ;;
  *) hidden="with hidden answer" ;;
esac
exec /usr/bin/osascript \
  -e 'on run argv' \
  -e 'activate' \
  -e "return text returned of (display dialog (item 1 of argv) default answer \"\" $hidden with title \"Aditor — git\")" \
  -e 'end run' \
  "$1"
"#;

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
/// prompts to a dialog instead.
fn run_git(root: &Path, args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new(crate::pty::user_shell());
    cmd.args(["-l", "-c", "exec git \"$@\"", "git"])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(helper) = askpass() {
        cmd.env("SSH_ASKPASS", helper).env("SSH_ASKPASS_REQUIRE", "force");
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
    match paths.iter().find(|p| !Path::new(p).starts_with(root)) {
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
pub async fn git_stage(ws: State<'_, Workspace>, paths: Vec<String>) -> Result<(), String> {
    let root = workspace_root(&ws)?;
    check_paths(&root, &paths)?;
    off_thread(move || {
        let mut args = vec!["add", "-A", "--"];
        args.extend(paths.iter().map(String::as_str));
        run_git(&root, &args, None).map(drop)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(ws: State<'_, Workspace>, paths: Vec<String>) -> Result<(), String> {
    let root = workspace_root(&ws)?;
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
pub async fn git_stage_all(ws: State<'_, Workspace>) -> Result<(), String> {
    let root = workspace_root(&ws)?;
    off_thread(move || run_git(&root, &["add", "-A", "--", "."], None).map(drop)).await
}

#[tauri::command]
pub async fn git_unstage_all(ws: State<'_, Workspace>) -> Result<(), String> {
    let root = workspace_root(&ws)?;
    off_thread(move || unstage(&root, &["."]).map(drop)).await
}

#[tauri::command]
pub async fn git_commit(ws: State<'_, Workspace>, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("A commit needs a message.".into());
    }
    let root = workspace_root(&ws)?;
    // Through stdin rather than `-m`: a multi-line message survives intact, and
    // hooks and signing run exactly as they would in a terminal.
    off_thread(move || run_git(&root, &["commit", "-F", "-"], Some(&message)).map(drop)).await
}

/// The explicit flag wins over `pull.rebase`, since the user picked one.
#[tauri::command]
pub async fn git_pull(ws: State<'_, Workspace>, rebase: bool) -> Result<String, String> {
    let root = workspace_root(&ws)?;
    let mode = if rebase { "--rebase" } else { "--no-rebase" };
    off_thread(move || run_git(&root, &["pull", mode], None)).await
}

/// Push, setting up tracking on the first push of a branch: a plain `git push`
/// would refuse with advice the user cannot act on from here.
#[tauri::command]
pub async fn git_push(ws: State<'_, Workspace>) -> Result<String, String> {
    let root = workspace_root(&ws)?;
    off_thread(move || {
        let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
        let (upstream, _, _) = tracking(&repo);
        if upstream.is_some() {
            return run_git(&root, &["push"], None);
        }
        let remotes: Vec<String> = repo
            .remotes()
            .map_err(|e| e.to_string())?
            .iter()
            .filter_map(|r| r.ok().flatten().map(str::to_string))
            .collect();
        let remote = if remotes.iter().any(|r| r == "origin") {
            "origin".to_string()
        } else {
            match remotes.as_slice() {
                [only] => only.clone(),
                [] => return Err("This repository has no remote to push to.".into()),
                _ => {
                    return Err(
                        "This branch tracks no upstream and there is no `origin` to pick.".into(),
                    );
                }
            }
        };
        drop(repo);
        run_git(&root, &["push", "-u", &remote, "HEAD"], None)
    })
    .await
}

/// Switch to a local branch, or to a remote one by creating the local branch
/// that tracks it. Git's own refusal (a dirty tree in the way) comes back as-is.
#[tauri::command]
pub async fn git_checkout(
    ws: State<'_, Workspace>,
    name: String,
    remote: bool,
) -> Result<(), String> {
    // `switch` has no `--` before the branch (it would mean a pathspec), so a
    // leading dash must not reach it as an option.
    if name.is_empty() || name.starts_with('-') {
        return Err(format!("{name:?} is not a branch name."));
    }
    let root = workspace_root(&ws)?;
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
pub async fn git_fetch(ws: State<'_, Workspace>) -> Result<(), String> {
    let root = workspace_root(&ws)?;
    off_thread(move || run_git(&root, &["fetch", "--all", "--prune"], None).map(drop)).await
}
