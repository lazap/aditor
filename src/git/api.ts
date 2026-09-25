import { invoke } from "@tauri-apps/api/core";

export type ChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted";

export interface FileStatus {
  path: string;
  status: ChangeKind;
}

export interface RepoStatus {
  isRepo: boolean;
  branch: string | null;
  files: FileStatus[];
}

export type FileDiff =
  | { kind: "text"; old: string; new: string }
  | { kind: "binary" }
  | { kind: "tooLarge"; bytes: number }
  | { kind: "notRepo" };

export const gitStatus = () => invoke<RepoStatus>("git_status");
export const gitDiff = (path: string) => invoke<FileDiff>("git_diff", { path });

/** Single-letter badge shown in the tree and changes list. */
export const BADGE: Record<ChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
};
