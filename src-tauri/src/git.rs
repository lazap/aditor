//! Git observation: what differs from HEAD, and the before/after text for one
//! file.
//!
//! Read-only by design for now. Everything goes through `with_repo`, which owns
//! repo discovery and path resolution -- so adding a write operation later
//! (stage, commit, revert) is a new command against the same seam rather than a
//! restructuring.
//!
//! Note the repo root and the workspace root are not necessarily the same: you
//! can open a subdirectory of a repo as the workspace. Status is therefore
//! filtered to the open workspace, and paths are reported absolute so the tree
//! can match them directly.

use std::path::{Path, PathBuf};

use git2::{Repository, Status, StatusOptions};
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
    pub status: ChangeKind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    /// A plain folder is a normal state, not an error: the UI drops badges and
    /// the diff mode, and everything else keeps working.
    pub is_repo: bool,
    pub branch: Option<String>,
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
                let kind = classify(entry.status())?;
                let abs = workdir.join(rel);
                // Only report what is inside the open workspace -- the repo may
                // extend above it.
                abs.starts_with(root).then(|| FileStatus {
                    path: abs.to_string_lossy().to_string(),
                    status: kind,
                })
            })
            .collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));

        let branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().ok().map(str::to_string));

        Ok(RepoStatus {
            is_repo: true,
            branch,
            files,
        })
    })?;

    Ok(found.unwrap_or(RepoStatus {
        is_repo: false,
        branch: None,
        files: Vec::new(),
    }))
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
