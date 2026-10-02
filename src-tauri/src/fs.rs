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

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
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
    /// An editor window has gone: release every root it held.
    pub fn release_window(&self, label: &str) {
        self.open.lock().unwrap().retain(|_, o| {
            o.windows.remove(label);
            !o.windows.is_empty()
        });
    }
}

/// `fs://changed`: which workspace, and what moved in it.
#[derive(Clone, Serialize)]
struct Changed {
    root: String,
    paths: Vec<String>,
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
    let root = workspace_root(ws, root)?;
    let candidate = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if !candidate.starts_with(&root) {
        return Err(format!("{path} is outside the workspace"));
    }
    Ok(candidate)
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
    let emitter = app.clone();
    let tag = root_str.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .filter(|p| !is_noise(p))
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
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
pub fn list_dir(
    ws: State<'_, Workspace>,
    root: String,
    path: Option<String>,
) -> Result<Vec<DirEntry>, String> {
    let dir = match path {
        Some(p) => resolve_in_workspace(&ws, &root, &p)?,
        None => workspace_root(&ws, &root)?,
    };

    let mut entries: Vec<DirEntry> = WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false) // show dotfiles; .gitignore still applies
        .git_ignore(true)
        .git_global(true)
        .parents(true)
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.path() != dir.as_path())
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().to_string(),
            path: e.path().to_string_lossy().to_string(),
            is_dir: e.file_type().is_some_and(|t| t.is_dir()),
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
pub fn read_file(
    ws: State<'_, Workspace>,
    root: String,
    path: String,
) -> Result<FileContents, String> {
    let file = resolve_in_workspace(&ws, &root, &path)?;
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
    std::fs::write(file, text).map_err(|e| e.to_string())
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
    fn creates_nested_files_inside_the_root() {
        let root = scratch("nested");
        let file = create_in(&root, "config/local/.env").unwrap();
        assert_eq!(file, root.join("config/local/.env"));
        assert!(file.is_file());
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
