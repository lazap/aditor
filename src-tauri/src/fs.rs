//! Reading the workspace: gitignore-aware directory listing, guarded file
//! reads, and a filesystem watcher so the view reflects what the agent just did.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ignore::WalkBuilder;
use notify::{EventKind, RecursiveMode, Watcher, recommended_watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

/// Refuse anything larger. A stray log or minified bundle would otherwise lock
/// the UI while CodeMirror tried to lay it out. Shared with `git`, so a diff
/// and a plain read agree on what is too big.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// How much of the head to sniff for NUL before calling a file binary.
const SNIFF_BYTES: usize = 8 * 1024;

/// Directory names whose contents never warrant a UI refresh. `notify` watches
/// recursively and knows nothing about .gitignore, so without this a single
/// `cargo build` inside the workspace would fire thousands of events and make
/// the tree thrash -- which is exactly what happens when Aditor is open on its
/// own repo.
const IGNORED_DIRS: [&str; 6] = [".git", "target", "node_modules", "dist", ".DS_Store", ".vite"];

fn is_noise(path: &Path) -> bool {
    path.components()
        .any(|c| IGNORED_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

/// Where git keeps the state the changes list shows: the repo's gitdir and,
/// for a linked worktree, the common dir holding the refs. Either can sit
/// outside the workspace -- a subdirectory of a repo opened on its own -- so
/// the watcher adds them separately. `root/.git` is always in, so a `git init`
/// after opening is noticed too.
fn git_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.join(".git")];
    if let Ok(repo) = git2::Repository::discover(root) {
        for dir in [repo.path(), repo.commondir()] {
            if let Ok(dir) = dir.canonicalize() {
                if !dirs.contains(&dir) {
                    dirs.push(dir);
                }
            }
        }
    }
    dirs
}

/// Whether a path inside a git dir means the status may have moved: the
/// index, HEAD and friends, refs, an operation in progress. Objects, reflogs
/// and hooks follow from those or say nothing, and a `.lock` is a write still
/// in flight -- its rename onto the real name is the event that counts.
fn is_git_state(rel: &Path) -> bool {
    let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy());
    !matches!(first.as_deref(), None | Some("objects" | "logs" | "hooks"))
        && rel.extension().is_none_or(|e| e != "lock")
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// Matched by a .gitignore. Still listed -- a `.env` is the user's to see
    /// -- but the tree dims it.
    ignored: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileContents {
    Text { text: String },
    /// Refusals are typed rather than errors: the UI shows *why* a file will not
    /// render, instead of a failed invoke or a screen of mojibake.
    TooLarge { bytes: u64 },
    Binary,
}

/// The workspaces currently open -- one per project tab, across every window --
/// each with its watcher. Every command names the root it acts on, and every
/// path from the webview is checked against that root: the frontend asks for
/// files by string, so without this a bug or a crafted path could read
/// anything on disk. A root only gets in through `open_workspace`, which is the
/// user picking a folder.
#[derive(Default)]
pub struct Workspace {
    open: Mutex<HashMap<PathBuf, Open>>,
}

struct Open {
    /// Dropping it stops it.
    _watcher: Box<dyn Watcher + Send>,
    /// Editor windows with a tab on this root. The same folder can be open in
    /// two windows, and closing it in one must not pull it from under the other.
    windows: HashSet<String>,
}

impl Workspace {
    /// An editor window has gone: release every root it held. Returns the
    /// roots no window holds any more, whose other watchers must go too, as
    /// `close_workspace` does for them.
    pub fn release_window(&self, label: &str) -> Vec<PathBuf> {
        let mut released = Vec::new();
        self.open.lock().unwrap().retain(|root, o| {
            o.windows.remove(label);
            let keep = !o.windows.is_empty();
            if !keep {
                released.push(root.clone());
            }
            keep
        });
        released
    }
}

/// `fs://changed`: which workspace, and what moved in it.
#[derive(Clone, Serialize)]
struct Changed {
    root: String,
    paths: Vec<String>,
}

/// `fs://git`: git state in this workspace's repo moved, from anywhere.
#[derive(Clone, Serialize)]
struct GitMoved {
    root: String,
}

/// Sniff for NUL in the head of a buffer. Shared with `git` so a file and its
/// diff never disagree about being binary.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0)
}

/// `root` as an open workspace, or an error. The frontend hands back the
/// canonical string `open_workspace` returned, so this is an exact lookup.
pub fn workspace_root(ws: &Workspace, root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    if ws.open.lock().unwrap().contains_key(&root) {
        Ok(root)
    } else {
        Err(format!("{} is not an open workspace", root.display()))
    }
}

/// Whether `path` names something inside the workspace `root`, for paths that
/// may not exist -- a deleted file still has a diff, and can be staged or
/// rolled back -- and so cannot simply be canonicalized like `resolve_in_workspace`
/// does.
///
/// `starts_with` alone is lexical: `<root>/../../etc/passwd` passes it and the
/// OS resolves the `..` later. So `.` and `..` are refused outright, and the
/// nearest ancestor that exists is canonicalized, which catches a symlinked
/// directory pointing out of the workspace.
pub fn inside_workspace(root: &Path, path: &Path) -> bool {
    use std::path::Component;
    if !path.starts_with(root)
        || !path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return false;
    }
    path.parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .find_map(|a| a.canonicalize().ok())
        .is_some_and(|a| a.starts_with(root))
}

/// Resolve `path` and assert it stays inside the workspace `root`.
fn resolve_in_workspace(ws: &Workspace, root: &str, path: &str) -> Result<PathBuf, String> {
    resolve_in(&workspace_root(ws, root)?, path)
}

/// `resolve_in_workspace` for a root already checked, so the filesystem work
/// can move off the UI thread without taking the `State` with it.
fn resolve_in(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if !candidate.starts_with(root) {
        return Err(format!("{path} is outside the workspace"));
    }
    Ok(candidate)
}

/// Run filesystem reads on the blocking pool. Sync commands run on the macOS
/// main thread, and these are called on every watcher tick during a turn.
pub(crate) async fn off_thread<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("the read did not finish: {e}"))?
}

#[tauri::command]
pub fn open_workspace(
    app: AppHandle,
    window: WebviewWindow,
    ws: State<'_, Workspace>,
    path: String,
) -> Result<String, String> {
    let root = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{path} is not a directory"));
    }
    let root_str = root.to_string_lossy().to_string();
    // Already open -- in another window, or this one before a reload. One
    // watcher serves them all.
    if let Some(open) = ws.open.lock().unwrap().get_mut(&root) {
        open.windows.insert(window.label().to_string());
        return Ok(root_str);
    }

    // One recursive watcher for the whole workspace. Events are coarse on
    // purpose -- the frontend debounces per path and refetches what it cares
    // about, which is far simpler than trying to interpret rename/atomic-save
    // sequences here.
    // Git's own files are split out first: `is_noise` drops `.git`, which
    // would hide a commit or a stage made in a terminal.
    let emitter = app.clone();
    let tag = root_str.clone();
    let git = git_dirs(&root);
    let watched_git = git.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                let mut git_moved = false;
                let mut paths = Vec::new();
                for p in &event.paths {
                    match git.iter().find_map(|d| p.strip_prefix(d).ok()) {
                        Some(rel) => git_moved |= is_git_state(rel),
                        None if !is_noise(p) => paths.push(p.to_string_lossy().to_string()),
                        None => {}
                    }
                }
                if git_moved {
                    let _ = emitter.emit("fs://git", GitMoved { root: tag.clone() });
                }
                if !paths.is_empty() {
                    let _ = emitter.emit(
                        "fs://changed",
                        Changed {
                            root: tag.clone(),
                            paths,
                        },
                    );
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    for dir in watched_git.iter().filter(|d| !d.starts_with(&root) && d.is_dir()) {
        // Best effort: the workspace still works without live git status.
        let _ = watcher.watch(dir, RecursiveMode::Recursive);
    }

    ws.open.lock().unwrap().insert(
        root,
        Open {
            _watcher: Box::new(watcher),
            windows: HashSet::from([window.label().to_string()]),
        },
    );
    Ok(root_str)
}

/// This window closed its tab on `root`. Once no window holds it, its watcher
/// stops and the agent watcher for the same root goes with it.
#[tauri::command]
pub fn close_workspace(
    window: WebviewWindow,
    ws: State<'_, Workspace>,
    agents: State<'_, crate::agents::AgentState>,
    root: String,
) {
    let root = PathBuf::from(root);
    let mut open = ws.open.lock().unwrap();
    let Some(entry) = open.get_mut(&root) else {
        return;
    };
    entry.windows.remove(window.label());
    if entry.windows.is_empty() {
        open.remove(&root);
        agents.forget(&root);
    }
}

/// List one level of `path`. Lazy rather than a full walk: the tree stays
/// instant on a large repo, and ignored trees like `node_modules` and `target`
/// are never enumerated at all.
#[tauri::command]
pub async fn list_dir(
    ws: State<'_, Workspace>,
    root: String,
    path: Option<String>,
) -> Result<Vec<DirEntry>, String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || list_dir_in(&root, path.as_deref())).await
}

fn list_dir_in(root: &Path, path: Option<&str>) -> Result<Vec<DirEntry>, String> {
    let dir = match path {
        Some(p) => resolve_in(root, p)?,
        None => root.to_path_buf(),
    };

    // One level twice: everything, then what .gitignore lets through. The
    // difference is what gets dimmed. Cheaper and more faithful than
    // reassembling the ignore rules (nested files, globals, parents) by hand.
    let level = |git_ignore: bool| {
        WalkBuilder::new(&dir)
            .max_depth(Some(1))
            .hidden(false) // show dotfiles
            .git_ignore(git_ignore)
            .git_global(git_ignore)
            .parents(true)
            .build()
            .filter_map(Result::ok)
            .filter(|e| e.path() != dir.as_path())
    };
    let kept: HashSet<PathBuf> = level(true).map(|e| e.into_path()).collect();

    let mut entries: Vec<DirEntry> = level(false)
        // `hidden(false)` would otherwise list the repository itself.
        .filter(|e| e.file_name() != ".git")
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().to_string(),
            path: e.path().to_string_lossy().to_string(),
            is_dir: e.file_type().is_some_and(|t| t.is_dir()),
            ignored: !kept.contains(e.path()),
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn read_file(
    ws: State<'_, Workspace>,
    root: String,
    path: String,
) -> Result<FileContents, String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || read_file_in(&root, &path)).await
}

fn read_file_in(root: &Path, path: &str) -> Result<FileContents, String> {
    let file = resolve_in(root, path)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Ok(FileContents::TooLarge { bytes: meta.len() });
    }

    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Ok(FileContents::Binary);
    }

    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContents::Text { text }),
        // Valid non-UTF-8 text encodings are rare enough in a code tree that
        // treating them as binary is better than guessing an encoding.
        Err(_) => Ok(FileContents::Binary),
    }
}

/// What `write_file` answers when the file is no longer the text the editor's
/// buffer was based on. The frontend matches on it, so it stays a fixed string.
pub const CHANGED_ON_DISK: &str = "changed on disk";

/// Save the editor's text over a file the user has made writable. Same rule as
/// `read_file`: the file must already exist inside the workspace, so this can
/// only ever overwrite something the viewer could show.
///
/// `expected` is the disk text the edit started from. When it is given and the
/// file no longer holds it -- the agent wrote to it meanwhile -- nothing is
/// written and the error is `CHANGED_ON_DISK`, so an autosave cannot silently
/// throw the agent's change away. `None` overwrites unconditionally, which is
/// what the user picks when told about the conflict.
#[tauri::command]
pub fn write_file(
    ws: State<'_, Workspace>,
    root: String,
    path: String,
    text: String,
    expected: Option<String>,
) -> Result<(), String> {
    let file = resolve_in_workspace(&ws, &root, &path)?;
    write_unless_changed(&file, &text, expected.as_deref()).map_err(|e| {
        if e == CHANGED_ON_DISK {
            e
        } else {
            format!("{path}: {e}")
        }
    })
}

fn write_unless_changed(file: &Path, text: &str, expected: Option<&str>) -> Result<(), String> {
    if !file.is_file() {
        return Err("not a file".to_string());
    }
    if let Some(expected) = expected {
        let current = std::fs::read(file).map_err(|e| e.to_string())?;
        if current != expected.as_bytes() {
            return Err(CHANGED_ON_DISK.to_string());
        }
    }
    // Temp file and rename rather than truncate-and-write: a crash or a full
    // disk mid-write would otherwise leave the user's file cut short, and the
    // agent or the viewer could read it empty in between.
    crate::accounts::rewrite_preserving_mode(file, text.as_bytes())
}

/// Create an empty file at `rel`, relative to the workspace root, making any
/// missing parent directories. Returns its absolute path.
///
/// The file does not exist yet, so it cannot be canonicalized the way every
/// other path here is. Instead `..` is refused outright, and the parent --
/// which does exist once created -- is canonicalized and checked, which also
/// catches a symlinked directory that points out of the workspace.
#[tauri::command]
pub fn create_file(ws: State<'_, Workspace>, root: String, rel: String) -> Result<String, String> {
    let root = workspace_root(&ws, &root)?;
    create_in(&root, &rel).map(|f| f.to_string_lossy().to_string())
}

fn create_in(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel.trim());
    let name = rel_path
        .file_name()
        .ok_or_else(|| "A new file needs a name.".to_string())?
        .to_owned();
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Give a path inside the project, without `..`.".into());
    }
    let parent = root.join(rel_path.parent().unwrap_or(Path::new("")));
    std::fs::create_dir_all(&parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    if !parent.starts_with(root) {
        return Err(format!("{rel} is outside the workspace"));
    }
    let file = parent.join(name);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("{rel} already exists."),
            _ => format!("{rel}: {e}"),
        })?;
    Ok(file)
}

/// Move the file or directory `from` into the directory `into`, keeping its
/// name. Returns its new absolute path; moving it to where it already is
/// returns the path unchanged.
///
/// Never overwrites: a clash in the target is refused, and the user renames
/// or moves the other one first. Synchronous, like `write_file` -- a rename is
/// one syscall, and two drops in quick succession must land in order.
#[tauri::command]
pub fn move_path(
    ws: State<'_, Workspace>,
    root: String,
    from: String,
    into: String,
) -> Result<String, String> {
    let root = workspace_root(&ws, &root)?;
    move_in(&root, &from, &into).map(|p| p.to_string_lossy().to_string())
}

fn move_in(root: &Path, from: &str, into: &str) -> Result<PathBuf, String> {
    // Only the parent is canonicalized: canonicalizing `from` itself would
    // follow a symlink and move what it points at, not the link the user
    // dragged.
    let from_path = Path::new(from);
    let (Some(parent), Some(name)) = (from_path.parent(), from_path.file_name()) else {
        return Err(format!("{from} cannot be moved."));
    };
    let parent = resolve_in(root, &parent.to_string_lossy())?;
    let src = parent.join(name);
    std::fs::symlink_metadata(&src).map_err(|e| format!("{from}: {e}"))?;

    let dir = resolve_in(root, into)?;
    if !dir.is_dir() {
        return Err(format!("{into} is not a folder."));
    }
    if dir == parent {
        return Ok(src);
    }
    let shown = |p: &Path| match p.strip_prefix(root) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.display().to_string(),
        _ => root.file_name().unwrap_or_default().to_string_lossy().to_string(),
    };
    if dir.starts_with(&src) {
        return Err(format!("{} cannot be moved into itself.", shown(&src)));
    }
    let dest = dir.join(name);
    // symlink_metadata, so a dangling link still counts as taken -- and on a
    // case-insensitive volume, so does `Foo` against `foo`.
    if std::fs::symlink_metadata(&dest).is_ok() {
        return Err(format!(
            "{} already exists in {}.",
            name.to_string_lossy(),
            shown(&dir)
        ));
    }
    std::fs::rename(&src, &dest).map_err(|e| format!("{}: {e}", shown(&src)))?;
    Ok(dest)
}

/// Debounce window the frontend should use when coalescing `fs://changed`.
/// Exposed so the two sides cannot drift apart.
#[tauri::command]
pub fn fs_debounce_ms() -> u64 {
    Duration::from_millis(150).as_millis() as u64
}

/// Which of these paths are still directories, in the order given.
///
/// The project picker needs this to grey out recents whose folder has been
/// moved or deleted, and recents point outside the open workspace by
/// definition -- so this is the one path-taking command that does not go
/// through `resolve_in_workspace`. It answers yes/no about paths the caller
/// already named and reveals nothing else.
#[tauri::command]
pub fn dirs_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_dir()).collect()
}

/// Which of these path-like strings, printed by the agent, name a real file in
/// the workspace -- the canonical absolute path for each, or None.
///
/// This is what decides whether the terminal underlines a token, so a false
/// positive like `e.g.` or `v1.2.3` is simply a miss here. Relative candidates
/// resolve against the workspace root, which is the agent's cwd. The same
/// inside-the-workspace rule as `read_file` applies, since a link to a file the
/// viewer would refuse is no use.
///
/// Called on hover, so it runs off the main thread: a sync command would stall
/// the webview (and the agent's output with it) for every stat.
#[tauri::command]
pub async fn resolve_file_links(
    ws: State<'_, Workspace>,
    root: String,
    candidates: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    let root = workspace_root(&ws, &root)?;
    tauri::async_runtime::spawn_blocking(move || {
        candidates
            .iter()
            .map(|c| {
                resolve_link(&root, c).or_else(|| {
                    // `a/src/x.ts` / `b/src/x.ts`, as git diff prints them.
                    c.strip_prefix("a/")
                        .or_else(|| c.strip_prefix("b/"))
                        .and_then(|rest| resolve_link(&root, rest))
                })
            })
            .collect()
    })
    .await
    .map_err(|e| format!("link lookup did not finish: {e}"))
}

fn resolve_link(root: &Path, candidate: &str) -> Option<String> {
    let file = root.join(candidate).canonicalize().ok()?;
    (file.starts_with(root) && file.is_file()).then(|| file.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aditor-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Canonical, as `workspace_root` hands it over: /var is /private/var.
        dir.canonicalize().unwrap()
    }

    #[test]
    fn git_state_is_refs_index_and_head_not_objects_or_locks() {
        for moved in ["index", "HEAD", "MERGE_HEAD", "packed-refs", "refs/heads/main", "rebase-merge/done"] {
            assert!(is_git_state(Path::new(moved)), "{moved}");
        }
        for quiet in ["", "index.lock", "refs/heads/main.lock", "objects/ab/cdef", "logs/HEAD", "hooks/pre-commit"] {
            assert!(!is_git_state(Path::new(quiet)), "{quiet}");
        }
    }

    #[test]
    fn inside_workspace_refuses_parent_segments_and_symlinked_dirs() {
        let root = scratch("inside");
        let outside = scratch("inside-target");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        assert!(inside_workspace(&root, &root.join("src/main.rs")));
        // Deleted files, in directories that may be gone too.
        assert!(inside_workspace(&root, &root.join("gone/deleted.rs")));
        assert!(!inside_workspace(&root, &root.join("../../etc/passwd")));
        assert!(!inside_workspace(&root, &root.join("src/../../x")));
        assert!(!inside_workspace(&root, &root.join("link/secret")));
        assert!(!inside_workspace(&root, Path::new("/etc/passwd")));
    }

    #[test]
    fn writes_when_the_disk_still_matches() {
        let root = scratch("write-match");
        let file = root.join("a.txt");
        std::fs::write(&file, "base").unwrap();
        write_unless_changed(&file, "mine", Some("base")).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    }

    #[test]
    fn refuses_to_overwrite_a_change_made_on_disk() {
        let root = scratch("write-conflict");
        let file = root.join("a.txt");
        std::fs::write(&file, "agent").unwrap();
        assert_eq!(
            write_unless_changed(&file, "mine", Some("base")),
            Err(CHANGED_ON_DISK.to_string())
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "agent");
        // Unconditional, as when the user chooses to overwrite.
        write_unless_changed(&file, "mine", None).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    }

    #[test]
    fn saving_keeps_the_mode_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("write-mode");
        let file = root.join("run.sh");
        std::fs::write(&file, "old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o750)).unwrap();
        write_unless_changed(&file, "new", Some("old")).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o750);
        let names: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("run.sh")]);
    }

    #[test]
    fn lists_gitignored_entries_as_ignored() {
        let root = scratch("list-ignored");
        // .gitignore only counts inside a repository.
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".gitignore"), ".env\ntarget\n").unwrap();
        std::fs::write(root.join(".env"), "").unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();

        let listed: Vec<(String, bool)> = list_dir_in(&root, None)
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.ignored))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("src".to_string(), false),
                ("target".to_string(), true),
                (".env".to_string(), true),
                (".gitignore".to_string(), false),
            ]
        );
    }

    #[test]
    fn creates_nested_files_inside_the_root() {
        let root = scratch("nested");
        let file = create_in(&root, "config/local/.env").unwrap();
        assert_eq!(file, root.join("config/local/.env"));
        assert!(file.is_file());
    }

    #[test]
    fn moves_files_and_folders_into_another_folder() {
        let root = scratch("move");
        std::fs::create_dir_all(root.join("src/lib")).unwrap();
        std::fs::create_dir_all(root.join("dest")).unwrap();
        std::fs::write(root.join("src/a.ts"), "a").unwrap();
        std::fs::write(root.join("src/lib/b.ts"), "b").unwrap();
        let at = |p: &str| root.join(p).to_string_lossy().to_string();

        let moved = move_in(&root, &at("src/a.ts"), &at("dest")).unwrap();
        assert_eq!(moved, root.join("dest/a.ts"));
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "a");

        let moved = move_in(&root, &at("src/lib"), &at("dest")).unwrap();
        assert_eq!(moved, root.join("dest/lib"));
        assert!(root.join("dest/lib/b.ts").is_file());
        assert!(!root.join("src/lib").exists());

        // Up to the root, and onto where it already is.
        let moved = move_in(&root, &at("dest/a.ts"), &at("")).unwrap();
        assert_eq!(moved, root.join("a.ts"));
        assert_eq!(move_in(&root, &at("a.ts"), &at("")).unwrap(), root.join("a.ts"));
    }

    #[test]
    fn moving_refuses_clashes_cycles_and_escapes() {
        let root = scratch("move-refuse");
        std::fs::create_dir_all(root.join("a/inner")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("x.txt"), "mine").unwrap();
        std::fs::write(root.join("b/x.txt"), "theirs").unwrap();
        let at = |p: &str| root.join(p).to_string_lossy().to_string();

        let clash = move_in(&root, &at("x.txt"), &at("b")).unwrap_err();
        assert_eq!(clash, "x.txt already exists in b.");
        assert_eq!(std::fs::read_to_string(root.join("b/x.txt")).unwrap(), "theirs");

        assert!(move_in(&root, &at("a"), &at("a")).is_err());
        assert!(move_in(&root, &at("a"), &at("a/inner")).is_err());
        assert!(move_in(&root, &at("x.txt"), "/tmp").is_err());
        assert!(move_in(&root, &at("x.txt"), &at("x.txt")).is_err());
        assert!(move_in(&root, &root.to_string_lossy(), &at("b")).is_err());
        assert!(root.join("x.txt").is_file());
    }

    #[test]
    fn refuses_to_leave_the_root() {
        let root = scratch("escape");
        assert!(create_in(&root, "../outside.txt").is_err());
        assert!(create_in(&root, "a/../../outside.txt").is_err());
        assert!(create_in(&root, "/tmp/outside.txt").is_err());
        assert!(create_in(&root, "").is_err());
    }

    #[test]
    fn refuses_a_symlinked_directory_out_of_the_root() {
        let root = scratch("symlink");
        let outside = scratch("symlink-target");
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(create_in(&root, "link/x.txt").is_err());
        assert!(!outside.join("x.txt").exists());
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let root = scratch("exists");
        std::fs::write(root.join(".env"), "KEEP=1").unwrap();
        let err = create_in(&root, ".env").unwrap_err();
        assert!(err.contains("already exists"));
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), "KEEP=1");
    }
}
