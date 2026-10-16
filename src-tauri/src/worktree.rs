//! Worktree sessions: a linked git worktree Aditor creates for a new agent
//! session, so parallel agents never edit the same checkout.
//!
//! The worktree opens as a project tab of its own, which is what keeps this
//! module small -- the file tree, git panel, run configurations and the MCP
//! tools are all scoped to a project root already, and a worktree is just
//! another root.
//!
//! Worktrees live under `~/.aditor/worktrees/<repo>/<name>`, outside the repo,
//! so the main checkout's watcher and search never see them. Removal only ever
//! touches a worktree under that directory, and never with `--force`: git's own
//! refusal of a dirty worktree is the safety net, and it reaches the user as-is.

use std::path::{Path, PathBuf};

use git2::Repository;
use serde::Serialize;
use tauri::State;

use crate::fs::{Workspace, workspace_root};
use crate::git::{check_name, off_thread, run_git};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// The worktree's own root, canonical, as `open_workspace` will return it.
    path: String,
    /// None on a detached HEAD.
    branch: Option<String>,
    /// The main checkout it was made from.
    main: String,
    /// The main checkout's folder name, for the tab label.
    repo: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    /// Why the branch was kept, when deleting it was asked for and git refused
    /// -- typically because it is not merged.
    branch_kept: Option<String>,
}

fn worktrees_dir() -> Result<PathBuf, String> {
    crate::accounts::home()
        .map(|h| h.join(".aditor").join("worktrees"))
        .ok_or_else(|| "HOME is not set.".to_string())
}

/// The main checkout of the repo `repo` belongs to: the parent of the common
/// git dir, which for a linked worktree is the main one's `.git`.
fn main_root(repo: &Repository) -> Result<PathBuf, String> {
    let common = repo.commondir().canonicalize().map_err(|e| e.to_string())?;
    common
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "The repository has no working tree.".to_string())
}

fn create(root: &Path, name: &str, base: &Path) -> Result<WorktreeInfo, String> {
    check_name(name, "branch name")?;
    let repo = Repository::discover(root).map_err(|_| "This project is not a git repository.".to_string())?;
    if repo.head().ok().and_then(|h| h.peel_to_commit().ok()).is_none() {
        return Err("The repository needs a commit before a worktree can be made from it.".into());
    }
    let main = main_root(&repo)?;
    let repo_name = main
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".into());
    // The branch keeps its slashes; the folder cannot.
    let folder = name.replace('/', "-");
    let parent = base.join(&repo_name);
    let path = parent.join(&folder);
    if path.exists() {
        return Err(format!("{} already exists.", path.display()));
    }
    std::fs::create_dir_all(&parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let path_str = path.to_string_lossy().to_string();
    run_git(root, &["worktree", "add", "-b", name, &path_str, "HEAD"], None)?;
    info(&path, base).ok_or_else(|| format!("git made {path_str}, but it is not a worktree."))
}

/// `Some` only for a worktree Aditor made: under `base`, and a linked worktree
/// rooted exactly at `path`. Anything else -- a plain repo, a worktree the user
/// made elsewhere -- is just a project.
fn info(path: &Path, base: &Path) -> Option<WorktreeInfo> {
    let base = base.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    if !path.starts_with(&base) {
        return None;
    }
    let repo = Repository::open(&path).ok()?;
    if !repo.is_worktree() {
        return None;
    }
    let main = main_root(&repo).ok()?;
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_string));
    Some(WorktreeInfo {
        path: path.to_string_lossy().into(),
        branch,
        repo: main.file_name()?.to_string_lossy().into(),
        main: main.to_string_lossy().into(),
    })
}

fn remove(path: &Path, delete_branch: bool, base: &Path) -> Result<Removed, String> {
    let wt = info(path, base).ok_or_else(|| format!("{} is not a worktree Aditor made.", path.display()))?;
    let main = PathBuf::from(&wt.main);
    // From the main checkout: removing the folder a command runs in is asking
    // for trouble. No `--force` -- see the module note.
    run_git(&main, &["worktree", "remove", &wt.path], None)?;
    let mut branch_kept = None;
    if delete_branch {
        if let Some(b) = &wt.branch {
            // `-d`, not `-D`: an unmerged branch is the work, and stays.
            if let Err(e) = run_git(&main, &["branch", "-d", b], None) {
                branch_kept = Some(e);
            }
        }
    }
    // The `<repo>` folder, once its last worktree is gone. Not recursive: if
    // anything is left in it, it stays.
    if let Some(parent) = Path::new(&wt.path).parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(Removed { branch_kept })
}

/// A new branch `name` off HEAD, checked out in a new worktree.
#[tauri::command]
pub async fn worktree_create(
    ws: State<'_, Workspace>,
    root: String,
    name: String,
) -> Result<WorktreeInfo, String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || create(&root, &name, &worktrees_dir()?)).await
}

#[tauri::command]
pub async fn worktree_info(path: String) -> Result<Option<WorktreeInfo>, String> {
    off_thread(move || Ok(info(Path::new(&path), &worktrees_dir()?))).await
}

#[tauri::command]
pub async fn worktree_remove(path: String, delete_branch: bool) -> Result<Removed, String> {
    off_thread(move || remove(Path::new(&path), delete_branch, &worktrees_dir()?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repo with one commit, and an empty worktrees dir beside it.
    struct Scratch {
        dir: PathBuf,
        repo: PathBuf,
        base: PathBuf,
    }

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("aditor-wt-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("proj")).unwrap();
            std::fs::create_dir_all(dir.join("worktrees")).unwrap();
            let dir = dir.canonicalize().unwrap();
            let s = Scratch { repo: dir.join("proj"), base: dir.join("worktrees"), dir };
            for args in [
                &["init", "-q", "-b", "main"][..],
                &["config", "user.name", "Test"],
                &["config", "user.email", "t@example.com"],
                &["config", "commit.gpgsign", "false"],
            ] {
                s.git(args);
            }
            std::fs::write(s.repo.join("a.txt"), "one\n").unwrap();
            s.git(&["add", "-A"]);
            s.git(&["commit", "-q", "-m", "first"]);
            s
        }
        fn git(&self, args: &[&str]) -> String {
            run_git(&self.repo, args, None).unwrap()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = run_git(&self.repo, &["worktree", "prune"], None);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn create_then_remove_with_its_merged_branch() {
        let s = Scratch::new("roundtrip");
        let wt = create(&s.repo, "feat/x", &s.base).unwrap();
        assert_eq!(wt.path, s.base.join("proj/feat-x").to_string_lossy());
        assert_eq!(wt.branch.as_deref(), Some("feat/x"));
        assert_eq!(wt.main, s.repo.to_string_lossy());
        assert_eq!(wt.repo, "proj");
        assert_eq!(info(Path::new(&wt.path), &s.base), Some(wt));

        let path = s.base.join("proj/feat-x");
        let r = remove(&path, true, &s.base).unwrap();
        assert!(r.branch_kept.is_none());
        assert!(!path.exists());
        // The emptied `<repo>` folder goes too.
        assert!(!s.base.join("proj").exists());
        assert_eq!(s.git(&["branch", "--list", "feat/x"]), "");
    }

    #[test]
    fn an_unmerged_branch_is_kept() {
        let s = Scratch::new("unmerged");
        let wt = create(&s.repo, "work", &s.base).unwrap();
        let path = PathBuf::from(&wt.path);
        std::fs::write(path.join("b.txt"), "two\n").unwrap();
        run_git(&path, &["add", "-A"], None).unwrap();
        run_git(&path, &["commit", "-q", "-m", "second"], None).unwrap();

        let r = remove(&path, true, &s.base).unwrap();
        assert!(r.branch_kept.is_some());
        assert!(!path.exists());
        assert_eq!(s.git(&["branch", "--list", "work"]), "work");
    }

    #[test]
    fn a_dirty_worktree_is_not_removed() {
        let s = Scratch::new("dirty");
        let wt = create(&s.repo, "dirty", &s.base).unwrap();
        let path = PathBuf::from(&wt.path);
        std::fs::write(path.join("a.txt"), "changed\n").unwrap();
        assert!(remove(&path, false, &s.base).is_err());
        assert!(path.join("a.txt").exists());
    }

    #[test]
    fn only_aditor_worktrees_have_info() {
        let s = Scratch::new("info");
        // A plain repo, even one under the worktrees dir.
        assert_eq!(info(&s.repo, &s.base), None);
        assert_eq!(info(&s.repo, &s.dir), None);
        // A worktree made somewhere else.
        let elsewhere = s.dir.join("elsewhere");
        s.git(&["worktree", "add", "-q", "-b", "other", &elsewhere.to_string_lossy(), "HEAD"]);
        assert_eq!(info(&elsewhere, &s.base), None);
        assert!(remove(&elsewhere, false, &s.base).is_err());
        assert!(elsewhere.exists());
    }

    #[test]
    fn an_existing_folder_or_bad_name_is_refused() {
        let s = Scratch::new("refuse");
        assert!(create(&s.repo, "-D", &s.base).is_err());
        std::fs::create_dir_all(s.base.join("proj/taken")).unwrap();
        assert!(create(&s.repo, "taken", &s.base).is_err());
    }
}
