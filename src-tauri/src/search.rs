//! Finding things in the workspace: every file's path, for the fuzzy file
//! finder, and a literal text search across their contents.
//!
//! Both walk the same files the tree would show -- .gitignore applies, dotfiles
//! do not hide -- so the finder never offers something the tree would not.

use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use tauri::State;

use crate::fs::{looks_binary, off_thread, workspace_root, Workspace, MAX_FILE_BYTES};

/// Enough for any repo a person browses by name; past it the walk stops rather
/// than ship a payload the webview would choke on.
const MAX_FILES: usize = 50_000;
/// Past this many hits the query is too vague to be worth more.
const MAX_MATCHES: usize = 1_000;
/// How much of a long line a hit carries, around the match.
const CONTEXT_CHARS: usize = 200;

/// The latest content search asked for. Each keystroke supersedes the last, and
/// a walk that is no longer the latest stops at its next file instead of
/// scanning the whole repo for an answer nobody will read.
#[derive(Default)]
pub struct SearchState {
    latest: Arc<AtomicU64>,
}

#[derive(Serialize)]
pub struct FileList {
    /// Relative to the root, `/`-separated.
    files: Vec<String>,
    truncated: bool,
}

#[derive(Serialize, Debug)]
pub struct ContentMatch {
    /// Relative to the root.
    path: String,
    /// 1-based.
    line: usize,
    /// Of the hit within `text`, in UTF-16 units, as JavaScript indexes strings.
    start: usize,
    end: usize,
    text: String,
}

#[derive(Serialize)]
pub struct ContentResults {
    matches: Vec<ContentMatch>,
    truncated: bool,
}

/// Same filters as the tree's `list_dir`, minus the depth limit.
fn walker(root: &Path) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(false)
        .git_ignore(true)
        .git_global(true)
        .parents(true)
        // `hidden(false)` would otherwise walk into the repository itself.
        .filter_entry(|e| e.file_name() != ".git");
    b
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_files(ws: State<'_, Workspace>, root: String) -> Result<FileList, String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || Ok(list_files_in(&root, MAX_FILES))).await
}

fn list_files_in(root: &Path, cap: usize) -> FileList {
    let mut files = Vec::new();
    let mut truncated = false;
    for entry in walker(root).build().filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files.len() == cap {
            truncated = true;
            break;
        }
        if let Some(rel) = relative(root, entry.path()) {
            files.push(rel);
        }
    }
    FileList { files, truncated }
}

/// Search every text file for `query`, literally. Smart-case, as `rg -S`:
/// case-insensitive unless the query has a capital in it.
///
/// `seq` orders the calls: one that is overtaken by a later `seq` gives up and
/// answers with nothing, which the frontend discards anyway.
#[tauri::command]
pub async fn search_content(
    ws: State<'_, Workspace>,
    search: State<'_, SearchState>,
    root: String,
    query: String,
    seq: u64,
) -> Result<ContentResults, String> {
    let root = workspace_root(&ws, &root)?;
    let latest = search.latest.clone();
    latest.fetch_max(seq, Ordering::SeqCst);
    off_thread(move || {
        Ok(search_in(&root, &query, MAX_MATCHES, &|| {
            latest.load(Ordering::SeqCst) != seq
        }))
    })
    .await
}

fn search_in(
    root: &Path,
    query: &str,
    cap: usize,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> ContentResults {
    if query.is_empty() {
        return ContentResults { matches: Vec::new(), truncated: false };
    }
    let fold = !query.chars().any(char::is_uppercase);
    let needle = if fold { query.to_lowercase() } else { query.to_string() };

    let found = Mutex::new(Vec::new());
    let count = AtomicUsize::new(0);
    let truncated = std::sync::atomic::AtomicBool::new(false);

    walker(root).build_parallel().run(|| {
        let (found, count, truncated, needle) = (&found, &count, &truncated, &needle);
        Box::new(move |entry| {
            if cancelled() || truncated.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let Some(text) = read_text(entry.path()) else { return WalkState::Continue };
            let Some(rel) = relative(root, entry.path()) else { return WalkState::Continue };

            let mut hits = Vec::new();
            for (i, line) in text.lines().enumerate() {
                if let Some(m) = match_line(line, needle, fold) {
                    if count.fetch_add(1, Ordering::Relaxed) >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        break;
                    }
                    hits.push(ContentMatch { path: rel.clone(), line: i + 1, ..m });
                }
            }
            if !hits.is_empty() {
                found.lock().unwrap().extend(hits);
            }
            if truncated.load(Ordering::Relaxed) {
                WalkState::Quit
            } else {
                WalkState::Continue
            }
        })
    });

    if cancelled() {
        return ContentResults { matches: Vec::new(), truncated: false };
    }
    let mut matches = found.into_inner().unwrap();
    // Parallel walks finish in any order; the list should not reshuffle
    // between two identical queries.
    matches.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    ContentResults { matches, truncated: truncated.into_inner() }
}

/// The file as text, or None for anything the viewer would refuse to show.
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if looks_binary(&bytes) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// The first hit of `needle` in `line`, trimmed to a window around it.
/// `needle` is already lowercased when `fold` is set.
fn match_line(line: &str, needle: &str, fold: bool) -> Option<ContentMatch> {
    // Lowercasing can change byte lengths, so the hit is located in chars,
    // which survive it one-to-one for everything but a few exotic letters.
    let (at, len) = if fold {
        let hay: Vec<char> = line.chars().flat_map(char::to_lowercase).collect();
        let pat: Vec<char> = needle.chars().collect();
        if hay.len() != line.chars().count() {
            // An expanding lowercase (İ -> i̇); fall back to a plain search.
            let b = line.find(needle)?;
            (line[..b].chars().count(), pat.len())
        } else {
            (hay.windows(pat.len()).position(|w| w == pat.as_slice())?, pat.len())
        }
    } else {
        let b = line.find(needle)?;
        (line[..b].chars().count(), needle.chars().count())
    };

    let chars: Vec<char> = line.chars().collect();
    // Leading indentation is noise in a result list.
    let indent = chars.iter().take_while(|c| c.is_whitespace()).count().min(at);
    let lead = CONTEXT_CHARS / 4;
    let from = indent.max(at.saturating_sub(lead));
    let to = chars.len().min(from + CONTEXT_CHARS).max(at + len);
    let utf16 = |cs: &[char]| cs.iter().map(|c| c.len_utf16()).sum::<usize>();
    let start = utf16(&chars[from..at]);
    Some(ContentMatch {
        path: String::new(),
        line: 0,
        start,
        end: start + utf16(&chars[at..at + len]),
        text: chars[from..to].iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aditor-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn never() -> bool {
        false
    }

    fn hits(root: &Path, q: &str) -> Vec<(String, usize)> {
        search_in(root, q, MAX_MATCHES, &never)
            .matches
            .into_iter()
            .map(|m| (m.path, m.line))
            .collect()
    }

    #[test]
    fn lists_files_relative_and_respects_gitignore() {
        let root = scratch("list");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "target\n").unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        std::fs::write(root.join("target/out"), "").unwrap();
        std::fs::write(root.join(".git/HEAD"), "").unwrap();
        std::fs::write(root.join(".env"), "").unwrap();

        let mut files = list_files_in(&root, MAX_FILES).files;
        files.sort();
        assert_eq!(files, vec![".env", ".gitignore", "src/main.rs"]);
    }

    #[test]
    fn caps_the_file_list() {
        let root = scratch("list-cap");
        for i in 0..5 {
            std::fs::write(root.join(format!("{i}.txt")), "").unwrap();
        }
        let list = list_files_in(&root, 3);
        assert_eq!(list.files.len(), 3);
        assert!(list.truncated);
    }

    #[test]
    fn smart_case() {
        let root = scratch("case");
        std::fs::write(root.join("a.txt"), "Hello\nhello\nHELLO\n").unwrap();
        assert_eq!(hits(&root, "hello").len(), 3);
        assert_eq!(hits(&root, "Hello"), vec![("a.txt".to_string(), 1)]);
    }

    #[test]
    fn skips_binary_and_ignored_files() {
        let root = scratch("skip");
        // .gitignore only counts inside a repository, as in the tree.
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(root.join("bin"), b"needle\0").unwrap();
        std::fs::write(root.join("ignored.txt"), "needle").unwrap();
        std::fs::write(root.join("big.txt"), "needle".repeat(MAX_FILE_BYTES as usize)).unwrap();
        std::fs::write(root.join("ok.txt"), "x\n  needle\n").unwrap();
        assert_eq!(hits(&root, "needle"), vec![("ok.txt".to_string(), 2)]);
    }

    #[test]
    fn caps_matches() {
        let root = scratch("cap");
        std::fs::write(root.join("a.txt"), "x\n".repeat(10)).unwrap();
        let r = search_in(&root, "x", 4, &never);
        assert_eq!(r.matches.len(), 4);
        assert!(r.truncated);
    }

    #[test]
    fn a_cancelled_search_answers_nothing() {
        let root = scratch("cancel");
        std::fs::write(root.join("a.txt"), "x").unwrap();
        assert!(search_in(&root, "x", 10, &|| true).matches.is_empty());
    }

    #[test]
    fn hit_offsets_are_utf16_and_skip_indentation() {
        let m = match_line("    let é = needle;", "needle", true).unwrap();
        assert_eq!(m.text, "let é = needle;");
        let units: Vec<u16> = m.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[m.start..m.end]).unwrap(), "needle");

        let m = match_line("a 😀 Needle", "needle", true).unwrap();
        let units: Vec<u16> = m.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[m.start..m.end]).unwrap(), "Needle");
    }
}
