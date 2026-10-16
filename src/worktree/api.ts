import { invoke } from "@tauri-apps/api/core";

/** A worktree Aditor made for a session, opened as a project tab of its own. */
export interface WorktreeInfo {
  /** Its root, canonical: the project tab's key. */
  path: string;
  /** null on a detached HEAD. */
  branch: string | null;
  /** The main checkout it was made from. */
  main: string;
  /** The main checkout's folder name. */
  repo: string;
}

export interface WorktreeRemoved {
  /** Why the branch was kept when deleting it was asked for: not merged. */
  branchKept: string | null;
}

/** A new branch `name` off HEAD, in `~/.aditor/worktrees/<repo>/<name>`. */
export const worktreeCreate = (root: string, name: string) =>
  invoke<WorktreeInfo>("worktree_create", { root, name });

/** null for anything but a worktree Aditor made. */
export const worktreeInfo = (path: string) =>
  invoke<WorktreeInfo | null>("worktree_info", { path });

/** Refused, not forced, when it has uncommitted changes. */
export const worktreeRemove = (path: string, deleteBranch: boolean) =>
  invoke<WorktreeRemoved>("worktree_remove", { path, deleteBranch });

/** A worktree tab's label: which repo, on which branch. */
export const worktreeLabel = (w: WorktreeInfo) =>
  `${w.repo} · ${w.branch ?? w.path.split("/").pop()}`;
