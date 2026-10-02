import { invoke } from "@tauri-apps/api/core";

/** Every file the tree would show, relative to the root. */
export interface FileList {
  files: string[];
  /** The walk stopped at its cap; there are more. */
  truncated: boolean;
}

/** One line holding the query. `start`/`end` index the hit within `text`. */
export interface ContentMatch {
  path: string;
  line: number;
  start: number;
  end: number;
  text: string;
}

export interface ContentResults {
  matches: ContentMatch[];
  truncated: boolean;
}

export const listFiles = (root: string) => invoke<FileList>("list_files", { root });

/**
 * Literal, smart-case search over every text file. `seq` must grow with each
 * call: a search overtaken by a later one stops early and answers empty.
 */
export const searchContent = (root: string, query: string, seq: number) =>
  invoke<ContentResults>("search_content", { root, query, seq });
