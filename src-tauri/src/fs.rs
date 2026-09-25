//! Reading the workspace: gitignore-aware directory listing, guarded file
//! reads, and a filesystem watcher so the view reflects what the agent just did.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ignore::WalkBuilder;
use notify::{EventKind, RecursiveMode, Watcher, recommended_watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

/// The workspace currently open. Every path from the webview is checked against
/// it -- the frontend asks for files by string, so without this a bug or a
/// crafted path could read anything on disk.
#[derive(Default)]
pub struct Workspace {
    root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<Box<dyn Watcher + Send>>>,
}

/// Sniff for NUL in the head of a buffer. Shared with `git` so a file and its
/// diff never disagree about being binary.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0)
}

pub fn workspace_root(ws: &Workspace) -> Result<PathBuf, String> {
    ws.root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no workspace open".to_string())
}

/// Resolve `path` and assert it stays inside the workspace root.
fn resolve_in_workspace(ws: &Workspace, path: &str) -> Result<PathBuf, String> {
    let root = workspace_root(ws)?;
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
    ws: State<'_, Workspace>,
    path: String,
) -> Result<String, String> {
    let root = Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("{path} is not a directory"));
    }

    // One recursive watcher for the whole workspace. Events are coarse on
    // purpose -- the frontend debounces per path and refetches what it cares
    // about, which is far simpler than trying to interpret rename/atomic-save
    // sequences here.
    let emitter = app.clone();
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
                    let _ = emitter.emit("fs://changed", paths);
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *ws.root.lock().unwrap() = Some(root.clone());
    // Replacing the previous watcher drops it, which stops it.
    *ws.watcher.lock().unwrap() = Some(Box::new(watcher));

    Ok(root.to_string_lossy().to_string())
}

/// List one level of `path`. Lazy rather than a full walk: the tree stays
/// instant on a large repo, and ignored trees like `node_modules` and `target`
/// are never enumerated at all.
#[tauri::command]
pub fn list_dir(ws: State<'_, Workspace>, path: Option<String>) -> Result<Vec<DirEntry>, String> {
    let dir = match path {
        Some(p) => resolve_in_workspace(&ws, &p)?,
        None => workspace_root(&ws)?,
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
pub fn read_file(ws: State<'_, Workspace>, path: String) -> Result<FileContents, String> {
    let file = resolve_in_workspace(&ws, &path)?;
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
