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

export const gitStatus = () => invoke<RepoStatus>("git_status");
export const gitDiff = (path: string) => invoke<FileDiff>("git_diff", { path });

export const gitStage = (paths: string[]) => invoke<void>("git_stage", { paths });
export const gitUnstage = (paths: string[]) =>
  invoke<void>("git_unstage", { paths });
export const gitStageAll = () => invoke<void>("git_stage_all");
export const gitUnstageAll = () => invoke<void>("git_unstage_all");
export const gitCommit = (message: string) =>
  invoke<void>("git_commit", { message });
export const gitPull = (rebase: boolean) => invoke<string>("git_pull", { rebase });
export const gitPush = (opts: { force?: boolean; tags?: boolean } = {}) =>
  invoke<string>("git_push", { force: !!opts.force, tags: !!opts.tags });

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

export const gitBranches = () => invoke<BranchList>("git_branches");
/** A remote branch is switched to by creating the local branch tracking it. */
export const gitCheckout = (b: BranchInfo) =>
  invoke<void>("git_checkout", { name: b.name, remote: b.remote });
export const gitFetch = () => invoke<void>("git_fetch");

/**
 * Put files back the way HEAD has them. Files HEAD does not have are only
 * unstaged, unless `deleteUntracked` says to delete them too.
 */
export const gitRollback = (paths: string[], deleteUntracked: boolean) =>
  invoke<void>("git_rollback", { paths, deleteUntracked });

export const gitBranchCreate = (name: string, from: string | null, checkout: boolean) =>
  invoke<void>("git_branch_create", { name, from, checkout });
export const gitBranchRename = (name: string, to: string) =>
  invoke<void>("git_branch_rename", { name, to });
export const gitBranchDelete = (b: BranchInfo, force: boolean) =>
  invoke<void>("git_branch_delete", { name: b.name, remote: b.remote, force });
export const gitMerge = (name: string) => invoke<string>("git_merge", { name });
export const gitRebase = (onto: string) => invoke<string>("git_rebase", { onto });
export const gitCherryPick = (id: string) => invoke<string>("git_cherry_pick", { id });
export const gitRevert = (id: string) => invoke<string>("git_revert", { id });
export type ResetMode = "soft" | "mixed" | "hard";
export const gitReset = (id: string, mode: ResetMode) =>
  invoke<void>("git_reset", { id, mode });
export const gitCheckoutRevision = (id: string) =>
  invoke<void>("git_checkout_revision", { id });
export const gitTagCreate = (name: string, id: string, message: string | null) =>
  invoke<void>("git_tag_create", { name, id, message });
export const gitTagDelete = (name: string) => invoke<void>("git_tag_delete", { name });
export const gitPushTag = (name: string) => invoke<string>("git_push_tag", { name });
export const gitOperationContinue = () => invoke<string>("git_operation_continue");
export const gitOperationAbort = () => invoke<void>("git_operation_abort");

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

export const gitLog = (skip: number, limit: number, q: LogQuery = {}) =>
  invoke<CommitInfo[]>("git_log", {
    skip,
    limit,
    branch: q.branch || null,
    text: q.text || null,
    path: q.path || null,
  });
export const gitCommitDetails = (id: string) =>
  invoke<CommitDetails>("git_commit_details", { id });
export const gitCommitFileDiff = (id: string, f: Pick<CommitFile, "path" | "oldPath">) =>
  invoke<FileDiff>("git_commit_file_diff", { id, path: f.path, oldPath: f.oldPath });

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
export const gitBlame = (path: string) => invoke<BlameHunk[]>("git_blame", { path });

export interface Outgoing {
  branch: string | null;
  /** The upstream, or where a first push would create one. */
  target: string | null;
  commits: CommitInfo[];
}

export const gitOutgoing = () => invoke<Outgoing>("git_outgoing");

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
