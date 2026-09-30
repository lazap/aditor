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

export interface RepoStatus {
  isRepo: boolean;
  branch: string | null;
  /** e.g. `origin/main`; null until the branch tracks one. */
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
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
export const gitPush = () => invoke<string>("git_push");

export interface BranchInfo {
  /** `feature` locally, `origin/feature` for a remote branch. */
  name: string;
  remote: boolean;
  /** What a local branch tracks, e.g. `origin/feature`. */
  upstream: string | null;
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
