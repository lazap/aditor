//! Git history: the log, one commit's changes, blame, and what a push would
//! send. All reads through git2, all off the main thread -- a walk over a large
//! history is long enough to freeze the webview if it ran on it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use git2::{Commit, Delta, DiffFindOptions, DiffOptions, Oid, Repository, Sort};
use serde::Serialize;
use tauri::State;

use crate::fs::{Workspace, inside_workspace, workspace_root};
use crate::git::{ChangeKind, FileDiff, blob_at, text_diff};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// A detached HEAD; an attached one marks its branch `current` instead.
    Head,
    Local,
    Remote,
    Tag,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    pub kind: RefKind,
    /// The branch HEAD is on.
    pub current: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Seconds since the epoch, author time.
    pub time: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// Absolute, like status paths.
    pub path: String,
    /// Relative to the repository root, for display.
    pub rel: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub message: String,
    pub files: Vec<CommitFile>,
}

/// One run of lines from the same commit, as `git blame --porcelain` groups them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameHunk {
    /// 1-based first line in the working file.
    pub start: usize,
    pub lines: usize,
    /// All zeros for lines not committed yet.
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    /// None on a detached HEAD, which has nothing to push.
    pub branch: Option<String>,
    /// Where it goes: the upstream, or `<remote>/<branch>` for a first push.
    pub target: Option<String>,
    pub commits: Vec<CommitInfo>,
}

/// Run `f` against the workspace's repo on a worker thread. `None` from a
/// folder that is not a repo, so callers decide what "nothing" looks like.
async fn read_repo<T, F>(ws: &State<'_, Workspace>, root: &str, f: F) -> Result<Option<T>, String>
where
    F: FnOnce(&Repository, &Path, &Path) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let root = workspace_root(ws, root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(repo) = Repository::discover(&root) else {
            return Ok(None);
        };
        let Some(workdir) = repo.workdir().map(Path::to_path_buf) else {
            return Ok(None);
        };
        f(&repo, &workdir, &root).map(Some)
    })
    .await
    .map_err(|e| format!("reading history did not finish: {e}"))?
}

/// Every ref by the commit it ends at, for the chips in the log.
fn ref_labels(repo: &Repository) -> HashMap<Oid, Vec<RefLabel>> {
    let mut map: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
    let head = repo.head().ok();
    let current = head.as_ref().filter(|h| h.is_branch()).and_then(|h| h.name().ok().map(str::to_string));
    if let Some(h) = head.as_ref().filter(|h| !h.is_branch()) {
        if let Some(id) = h.target() {
            map.entry(id).or_default().push(RefLabel {
                name: "HEAD".into(),
                kind: RefKind::Head,
                current: true,
            });
        }
    }
    let Ok(refs) = repo.references() else { return map };
    for r in refs.flatten() {
        let kind = if r.is_branch() {
            RefKind::Local
        } else if r.is_remote() {
            RefKind::Remote
        } else if r.is_tag() {
            RefKind::Tag
        } else {
            continue;
        };
        // `origin/HEAD` points at another remote branch already listed.
        if r.symbolic_target().is_ok_and(|t| t.is_some()) {
            continue;
        }
        let (Ok(name), Ok(commit)) = (r.shorthand(), r.peel_to_commit()) else { continue };
        let is_current = current.as_deref() == r.name().ok();
        map.entry(commit.id()).or_default().push(RefLabel {
            name: name.to_string(),
            kind,
            current: is_current,
        });
    }
    // The current branch first, then locals, remotes, tags.
    for labels in map.values_mut() {
        labels.sort_by_key(|l| (!l.current, l.kind as u8));
    }
    map
}

fn short(id: Oid) -> String {
    id.to_string()[..8].to_string()
}

fn info(c: &Commit, refs: &HashMap<Oid, Vec<RefLabel>>) -> CommitInfo {
    let author = c.author();
    CommitInfo {
        id: c.id().to_string(),
        short_id: short(c.id()),
        parents: c.parent_ids().map(|p| p.to_string()).collect(),
        author: author.name().unwrap_or("").to_string(),
        email: author.email().unwrap_or("").to_string(),
        time: author.when().seconds(),
        subject: c.summary().ok().flatten().unwrap_or("").to_string(),
        refs: refs.get(&c.id()).cloned().unwrap_or_default(),
    }
}

/// Whether `c` changed `rel` relative to its first parent.
fn touches(repo: &Repository, c: &Commit, rel: &Path) -> bool {
    let Ok(tree) = c.tree() else { return false };
    let parent = c.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    // A directory pathspec matches everything under it.
    opts.pathspec(rel);
    repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), Some(&mut opts))
        .is_ok_and(|d| d.deltas().len() > 0)
}

/// A page of history, newest first in topological order.
///
/// `branch` is a revision to walk from, or an `a..b` range; None walks every
/// branch, remote and tag, the way IntelliJ's log opens. `text` matches the
/// message, the author or a hash prefix; `path` keeps commits that touched a
/// file or folder. Filters run before paging, so `skip` counts matches.
pub fn log(
    repo: &Repository,
    workdir: &Path,
    skip: usize,
    limit: usize,
    branch: Option<&str>,
    text: Option<&str>,
    path: Option<&Path>,
) -> Result<Vec<CommitInfo>, String> {
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.to_string())?;
    match branch {
        Some(spec) if spec.contains("..") => walk.push_range(spec).map_err(|e| e.to_string())?,
        Some(spec) => {
            let commit = repo
                .revparse_single(spec)
                .and_then(|o| o.peel_to_commit())
                .map_err(|e| e.to_string())?;
            walk.push(commit.id()).map_err(|e| e.to_string())?;
        }
        None => {
            // An unborn HEAD has nothing to push; that is an empty log.
            let _ = walk.push_head();
            for glob in ["refs/heads", "refs/remotes", "refs/tags"] {
                let _ = walk.push_glob(glob);
            }
        }
    }

    let needle = text.map(str::to_lowercase).filter(|t| !t.is_empty());
    let rel = path.map(|p| p.strip_prefix(workdir).unwrap_or(p).to_path_buf());
    let refs = ref_labels(repo);

    let mut out = Vec::new();
    let mut matched = 0;
    for id in walk {
        let Ok(id) = id else { continue };
        let Ok(c) = repo.find_commit(id) else { continue };
        if let Some(n) = &needle {
            let author = c.author();
            let hit = c.message().is_ok_and(|m| m.to_lowercase().contains(n))
                || author.name().is_ok_and(|a| a.to_lowercase().contains(n))
                || id.to_string().starts_with(n.as_str());
            if !hit {
                continue;
            }
        }
        if let Some(rel) = &rel {
            if !rel.as_os_str().is_empty() && !touches(repo, &c, rel) {
                continue;
            }
        }
        matched += 1;
        if matched <= skip {
            continue;
        }
        out.push(info(&c, &refs));
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_log(
    ws: State<'_, Workspace>,
    root: String,
    skip: usize,
    limit: usize,
    branch: Option<String>,
    text: Option<String>,
    path: Option<String>,
) -> Result<Vec<CommitInfo>, String> {
    let found = read_repo(&ws, &root, move |repo, workdir, _| {
        log(
            repo,
            workdir,
            skip,
            limit.clamp(1, 2000),
            branch.as_deref(),
            text.as_deref(),
            path.as_deref().map(Path::new),
        )
    })
    .await?;
    Ok(found.unwrap_or_default())
}

fn kind_of(d: Delta) -> ChangeKind {
    match d {
        Delta::Added | Delta::Copied | Delta::Untracked => ChangeKind::Added,
        Delta::Deleted => ChangeKind::Deleted,
        Delta::Renamed => ChangeKind::Renamed,
        Delta::Conflicted => ChangeKind::Conflicted,
        _ => ChangeKind::Modified,
    }
}

pub fn details(repo: &Repository, workdir: &Path, id: &str) -> Result<CommitDetails, String> {
    let oid = Oid::from_str(id).map_err(|e| e.to_string())?;
    let c = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = c.tree().map_err(|e| e.to_string())?;
    let parent = c.parent(0).ok().and_then(|p| p.tree().ok());
    let mut diff = repo
        .diff_tree_to_tree(parent.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))
        .map_err(|e| e.to_string())?;

    let abs = |p: &Path| workdir.join(p).to_string_lossy().to_string();
    let files = diff
        .deltas()
        .filter_map(|d| {
            let new = d.new_file().path().or_else(|| d.old_file().path())?;
            let old = d.old_file().path().filter(|o| *o != new);
            Some(CommitFile {
                path: abs(new),
                rel: new.to_string_lossy().to_string(),
                old_path: old.map(abs),
                kind: kind_of(d.status()),
            })
        })
        .collect();

    let author = c.author();
    let committer = c.committer();
    Ok(CommitDetails {
        id: oid.to_string(),
        parents: c.parent_ids().map(|p| p.to_string()).collect(),
        author: author.name().unwrap_or("").to_string(),
        email: author.email().unwrap_or("").to_string(),
        time: author.when().seconds(),
        committer: committer.name().unwrap_or("").to_string(),
        commit_time: committer.when().seconds(),
        message: c.message().unwrap_or("").trim_end().to_string(),
        files,
    })
}

#[tauri::command]
pub async fn git_commit_details(
    ws: State<'_, Workspace>,
    root: String,
    id: String,
) -> Result<CommitDetails, String> {
    read_repo(&ws, &root, move |repo, workdir, _| details(repo, workdir, &id))
        .await?
        .ok_or_else(|| "Not a git repository.".into())
}

/// One file as a commit changed it: its first parent's version against its own.
#[tauri::command]
pub async fn git_commit_file_diff(
    ws: State<'_, Workspace>,
    root: String,
    id: String,
    path: String,
    old_path: Option<String>,
) -> Result<FileDiff, String> {
    let found = read_repo(&ws, &root, move |repo, workdir, _| {
        let oid = Oid::from_str(&id).map_err(|e| e.to_string())?;
        let c = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let rel = |p: &str| -> PathBuf {
            Path::new(p).strip_prefix(workdir).unwrap_or(Path::new(p)).to_path_buf()
        };
        let new_rel = rel(&path);
        let old_rel = old_path.as_deref().map(rel).unwrap_or_else(|| new_rel.clone());
        let tree = c.tree().map_err(|e| e.to_string())?;
        let new = blob_at(repo, &tree, &new_rel)?.unwrap_or_default();
        let old = match c.parent(0).ok().and_then(|p| p.tree().ok()) {
            Some(t) => blob_at(repo, &t, &old_rel)?.unwrap_or_default(),
            None => Vec::new(),
        };
        Ok(text_diff(old, new))
    })
    .await?;
    Ok(found.unwrap_or(FileDiff::NotRepo))
}

pub fn blame(repo: &Repository, workdir: &Path, abs: &Path) -> Result<Vec<BlameHunk>, String> {
    let rel = abs
        .strip_prefix(workdir)
        .map_err(|_| format!("{} is outside the repository", abs.display()))?;
    let working = std::fs::read(abs).map_err(|e| e.to_string())?;
    // Blame what is on disk, not HEAD's copy: the gutter sits beside the
    // working file, and its uncommitted lines must line up as such.
    let Ok(committed) = repo.blame_file(rel, None) else {
        // Never committed: every line is new.
        let lines = working.split(|b| *b == b'\n').count();
        return Ok(vec![uncommitted(1, lines)]);
    };
    let blame = committed.blame_buffer(&working).map_err(|e| e.to_string())?;

    let mut commits: HashMap<Oid, (String, i64, String)> = HashMap::new();
    let mut out = Vec::new();
    for h in blame.iter() {
        let id = h.final_commit_id();
        if id.is_zero() {
            out.push(uncommitted(h.final_start_line(), h.lines_in_hunk()));
            continue;
        }
        let (author, time, summary) = commits
            .entry(id)
            .or_insert_with(|| match repo.find_commit(id) {
                Ok(c) => (
                    c.author().name().unwrap_or("").to_string(),
                    c.author().when().seconds(),
                    c.summary().ok().flatten().unwrap_or("").to_string(),
                ),
                Err(_) => (String::new(), 0, String::new()),
            })
            .clone();
        out.push(BlameHunk {
            start: h.final_start_line(),
            lines: h.lines_in_hunk(),
            id: id.to_string(),
            short_id: short(id),
            author,
            time,
            summary,
        });
    }
    Ok(out)
}

fn uncommitted(start: usize, lines: usize) -> BlameHunk {
    BlameHunk {
        start,
        lines,
        id: Oid::ZERO_SHA1.to_string(),
        short_id: String::new(),
        author: String::new(),
        time: 0,
        summary: "Not committed yet".into(),
    }
}

#[tauri::command]
pub async fn git_blame(
    ws: State<'_, Workspace>,
    root: String,
    path: String,
) -> Result<Vec<BlameHunk>, String> {
    let found = read_repo(&ws, &root, move |repo, workdir, root| {
        let abs = PathBuf::from(&path);
        if !inside_workspace(root, &abs) {
            return Err(format!("{path} is outside the workspace"));
        }
        blame(repo, workdir, &abs)
    })
    .await?;
    Ok(found.unwrap_or_default())
}

/// The commits a push from HEAD would send: `upstream..HEAD`, or for a branch
/// that tracks nothing, what no remote branch has yet.
pub fn outgoing(repo: &Repository) -> Result<Outgoing, String> {
    let Ok(head) = repo.head() else {
        return Ok(Outgoing { branch: None, target: None, commits: Vec::new() });
    };
    if !head.is_branch() {
        return Ok(Outgoing { branch: None, target: None, commits: Vec::new() });
    }
    let branch = head.shorthand().ok().map(str::to_string);
    let head_id = head.target().ok_or("HEAD points at nothing.")?;

    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(|e| e.to_string())?;
    walk.push(head_id).map_err(|e| e.to_string())?;

    let upstream = git2::Branch::wrap(head).upstream().ok();
    let target = match &upstream {
        Some(u) => {
            if let Some(id) = u.get().target() {
                walk.hide(id).map_err(|e| e.to_string())?;
            }
            u.name().ok().flatten().map(str::to_string)
        }
        None => {
            let _ = walk.hide_glob("refs/remotes");
            let remote = repo
                .remotes()
                .ok()
                .and_then(|rs| {
                    let names: Vec<String> =
                        rs.iter().filter_map(|r| r.ok().flatten().map(str::to_string)).collect();
                    names
                        .iter()
                        .find(|r| *r == "origin")
                        .cloned()
                        .or_else(|| (names.len() == 1).then(|| names[0].clone()))
                });
            remote.zip(branch.clone()).map(|(r, b)| format!("{r}/{b}"))
        }
    };

    let refs = ref_labels(repo);
    let commits = walk
        .filter_map(Result::ok)
        .filter_map(|id| repo.find_commit(id).ok())
        .map(|c| info(&c, &refs))
        .collect();
    Ok(Outgoing { branch, target, commits })
}

#[tauri::command]
pub async fn git_outgoing(ws: State<'_, Workspace>, root: String) -> Result<Outgoing, String> {
    let found = read_repo(&ws, &root, |repo, _, _| outgoing(repo)).await?;
    Ok(found.unwrap_or(Outgoing { branch: None, target: None, commits: Vec::new() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A throwaway repo with a fixed identity, built with the real git CLI.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("aditor-gitlog-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let s = Scratch(dir);
            s.git(&["init", "-q", "-b", "main"]);
            s.git(&["config", "user.name", "Test"]);
            s.git(&["config", "user.email", "t@example.com"]);
            s.git(&["config", "commit.gpgsign", "false"]);
            s
        }
        fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git").args(args).current_dir(&self.0).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        fn write(&self, rel: &str, text: &str) {
            std::fs::write(self.0.join(rel), text).unwrap();
        }
        fn commit(&self, rel: &str, text: &str, msg: &str) {
            self.write(rel, text);
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
        }
        fn repo(&self) -> Repository {
            Repository::open(&self.0).unwrap()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn log_pages_and_filters() {
        let s = Scratch::new("log");
        s.commit("a.txt", "1\n", "first");
        s.commit("b.txt", "1\n", "second touches b");
        s.commit("a.txt", "2\n", "third");
        s.git(&["tag", "v1"]);
        let repo = s.repo();
        let wd = repo.workdir().unwrap().to_path_buf();

        let all = log(&repo, &wd, 0, 100, None, None, None).unwrap();
        assert_eq!(all.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["third", "second touches b", "first"]);
        assert!(all[0].refs.iter().any(|r| r.name == "main" && r.current));
        assert!(all[0].refs.iter().any(|r| r.name == "v1" && r.kind == RefKind::Tag));

        let page = log(&repo, &wd, 1, 1, None, None, None).unwrap();
        assert_eq!(page[0].subject, "second touches b");

        let text = log(&repo, &wd, 0, 100, None, Some("TOUCHES"), None).unwrap();
        assert_eq!(text.len(), 1);

        let file = log(&repo, &wd, 0, 100, None, None, Some(&wd.join("a.txt"))).unwrap();
        assert_eq!(file.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["third", "first"]);
    }

    #[test]
    fn details_and_blame() {
        let s = Scratch::new("blame");
        s.commit("a.txt", "one\ntwo\n", "first");
        s.commit("a.txt", "one\nTWO\n", "second");
        s.write("a.txt", "one\nTWO\nthree\n");
        let repo = s.repo();
        let wd = repo.workdir().unwrap().to_path_buf();
        let head = repo.head().unwrap().target().unwrap().to_string();

        let d = details(&repo, &wd, &head).unwrap();
        assert_eq!(d.message, "second");
        assert_eq!(d.files.len(), 1);
        assert!(matches!(d.files[0].kind, ChangeKind::Modified));

        let hunks = blame(&repo, &wd, &wd.join("a.txt")).unwrap();
        let total: usize = hunks.iter().map(|h| h.lines).sum();
        assert_eq!(total, 3);
        assert_eq!(hunks[0].summary, "first");
        assert_eq!(hunks.last().unwrap().summary, "Not committed yet");
    }

    #[test]
    fn outgoing_is_what_upstream_lacks() {
        let remote = Scratch::new("outgoing-remote");
        remote.commit("a.txt", "1\n", "base");
        let s = Scratch::new("outgoing");
        s.git(&["remote", "add", "origin", remote.0.to_str().unwrap()]);
        s.git(&["fetch", "-q", "origin"]);
        s.git(&["switch", "-q", "--track", "origin/main"]);
        s.commit("a.txt", "2\n", "local one");
        s.commit("a.txt", "3\n", "local two");

        let out = outgoing(&s.repo()).unwrap();
        assert_eq!(out.target.as_deref(), Some("origin/main"));
        assert_eq!(out.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["local two", "local one"]);
    }
}
