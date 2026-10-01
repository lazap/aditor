import { invoke } from "@tauri-apps/api/core";

export type ChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted";

export interface FileStatus {
  path: string;
  /** The combined badge the tree shows. */
  status: ChangeKind;
  /** Index vs HEAD. */
  staged: ChangeKind | null;
  /** Working tree vs index; conflicts land here. */
  unstaged: ChangeKind | null;
  /** Where a rename came from -- staging one must name both ends. */
  oldPath: string | null;
}

/** A merge, rebase, cherry-pick or revert git stopped in the middle of. */
export type RepoOperation = "merge" | "rebase" | "cherryPick" | "revert";

export interface RepoStatus {
  isRepo: boolean;
  branch: string | null;
  /** e.g. `origin/main`; null until the branch tracks one. */
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
  operation: RepoOperation | null;
}

export type FileDiff =
  | { kind: "text"; old: string; new: string }
  | { kind: "binary" }
  | { kind: "tooLarge"; bytes: number }
  | { kind: "notRepo" };

export const gitStatus = (root: string) => invoke<RepoStatus>("git_status", { root });
export const gitDiff = (root: string, path: string) => invoke<FileDiff>("git_diff", { root, path });

export const gitStage = (root: string, paths: string[]) =>
  invoke<void>("git_stage", { root, paths });
export const gitUnstage = (root: string, paths: string[]) =>
  invoke<void>("git_unstage", { root, paths });
export const gitStageAll = (root: string) => invoke<void>("git_stage_all", { root });
export const gitUnstageAll = (root: string) => invoke<void>("git_unstage_all", { root });
export const gitCommit = (root: string, message: string) =>
  invoke<void>("git_commit", { root, message });
export const gitPull = (root: string, rebase: boolean) =>
  invoke<string>("git_pull", { root, rebase });
export const gitPush = (root: string, opts: { force?: boolean; tags?: boolean } = {}) =>
  invoke<string>("git_push", { root, force: !!opts.force, tags: !!opts.tags });

export interface BranchInfo {
  /** `feature` locally, `origin/feature` for a remote branch. */
  name: string;
  remote: boolean;
  /** What a local branch tracks, e.g. `origin/feature`. */
  upstream: string | null;
  /** Commits not yet pushed to / pulled from the upstream. */
  ahead: number;
  behind: number;
}

export interface BranchList {
  /** null on a detached or unborn HEAD. */
  current: string | null;
  local: BranchInfo[];
  /** Only remote branches no local branch already tracks. */
  remote: BranchInfo[];
}

export const gitBranches = (root: string) => invoke<BranchList>("git_branches", { root });
/** A remote branch is switched to by creating the local branch tracking it. */
export const gitCheckout = (root: string, b: BranchInfo) =>
  invoke<void>("git_checkout", { root, name: b.name, remote: b.remote });
export const gitFetch = (root: string) => invoke<void>("git_fetch", { root });

/**
 * Put files back the way HEAD has them. Files HEAD does not have are only
 * unstaged, unless `deleteUntracked` says to delete them too.
 */
export const gitRollback = (root: string, paths: string[], deleteUntracked: boolean) =>
  invoke<void>("git_rollback", { root, paths, deleteUntracked });

export const gitBranchCreate = (root: string, name: string, from: string | null, checkout: boolean) =>
  invoke<void>("git_branch_create", { root, name, from, checkout });
export const gitBranchRename = (root: string, name: string, to: string) =>
  invoke<void>("git_branch_rename", { root, name, to });
export const gitBranchDelete = (root: string, b: BranchInfo, force: boolean) =>
  invoke<void>("git_branch_delete", { root, name: b.name, remote: b.remote, force });
export const gitMerge = (root: string, name: string) => invoke<string>("git_merge", { root, name });
export const gitRebase = (root: string, onto: string) =>
  invoke<string>("git_rebase", { root, onto });
export const gitCherryPick = (root: string, id: string) =>
  invoke<string>("git_cherry_pick", { root, id });
export const gitRevert = (root: string, id: string) => invoke<string>("git_revert", { root, id });
export type ResetMode = "soft" | "mixed" | "hard";
export const gitReset = (root: string, id: string, mode: ResetMode) =>
  invoke<void>("git_reset", { root, id, mode });
export const gitCheckoutRevision = (root: string, id: string) =>
  invoke<void>("git_checkout_revision", { root, id });
export const gitTagCreate = (root: string, name: string, id: string, message: string | null) =>
  invoke<void>("git_tag_create", { root, name, id, message });
export const gitTagDelete = (root: string, name: string) =>
  invoke<void>("git_tag_delete", { root, name });
export const gitPushTag = (root: string, name: string) =>
  invoke<string>("git_push_tag", { root, name });
export const gitOperationContinue = (root: string) =>
  invoke<string>("git_operation_continue", { root });
export const gitOperationAbort = (root: string) => invoke<void>("git_operation_abort", { root });

// ---- history ----

export type RefKind = "head" | "local" | "remote" | "tag";

export interface RefLabel {
  name: string;
  kind: RefKind;
  /** The branch HEAD is on (or a detached HEAD itself). */
  current: boolean;
}

export interface CommitInfo {
  id: string;
  shortId: string;
  parents: string[];
  author: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  subject: string;
  refs: RefLabel[];
}

export interface CommitFile {
  path: string;
  /** Relative to the repository root. */
  rel: string;
  oldPath: string | null;
  kind: ChangeKind;
}

export interface CommitDetails {
  id: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  commitTime: number;
  message: string;
  files: CommitFile[];
}

export interface LogQuery {
  /** A revision or `a..b` range; null walks every branch, remote and tag. */
  branch?: string | null;
  text?: string | null;
  /** Only commits touching this absolute path. */
  path?: string | null;
}

export const gitLog = (root: string, skip: number, limit: number, q: LogQuery = {}) =>
  invoke<CommitInfo[]>("git_log", {
    root,
    skip,
    limit,
    branch: q.branch || null,
    text: q.text || null,
    path: q.path || null,
  });
export const gitCommitDetails = (root: string, id: string) =>
  invoke<CommitDetails>("git_commit_details", { root, id });
export const gitCommitFileDiff = (root: string, id: string, f: Pick<CommitFile, "path" | "oldPath">) =>
  invoke<FileDiff>("git_commit_file_diff", { root, id, path: f.path, oldPath: f.oldPath });

export interface BlameHunk {
  /** 1-based first line in the working file. */
  start: number;
  lines: number;
  /** All zeros when not committed yet. */
  id: string;
  shortId: string;
  author: string;
  time: number;
  summary: string;
}

export const UNCOMMITTED = "0".repeat(40);
export const gitBlame = (root: string, path: string) =>
  invoke<BlameHunk[]>("git_blame", { root, path });

export interface Outgoing {
  branch: string | null;
  /** The upstream, or where a first push would create one. */
  target: string | null;
  commits: CommitInfo[];
}

export const gitOutgoing = (root: string) => invoke<Outgoing>("git_outgoing", { root });

/** The paths a stage/unstage of this entry must name: both ends of a rename. */
export const pathsOf = (f: FileStatus): string[] =>
  f.oldPath ? [f.path, f.oldPath] : [f.path];

/** Single-letter badge shown in the tree and changes list. */
export const BADGE: Record<ChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
};
