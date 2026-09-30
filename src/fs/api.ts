import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Mirrors the tagged enum in fs.rs -- refusals are values, not errors. */
export type FileContents =
  | { kind: "text"; text: string }
  | { kind: "tooLarge"; bytes: number }
  | { kind: "binary" };

interface RawDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const openWorkspace = (path: string) =>
  invoke<string>("open_workspace", { path });

export const listDir = async (path?: string): Promise<DirEntry[]> => {
  const raw = await invoke<RawDirEntry[]>("list_dir", { path: path ?? null });
  return raw.map((e) => ({ name: e.name, path: e.path, isDir: e.is_dir }));
};

export const readFile = (path: string) =>
  invoke<FileContents>("read_file", { path });

export const fsDebounceMs = () => invoke<number>("fs_debounce_ms");

/**
 * Which of `paths` are still directories, in order. Used by the project picker
 * to grey out recents whose folder has moved -- these are outside the open
 * workspace, so `listDir` could not answer for them.
 */
export const dirsExist = (paths: string[]) =>
  invoke<boolean[]>("dirs_exist", { paths });

/**
 * For each path-like string the agent printed, the canonical absolute path of
 * the workspace file it names, or null. What the terminal's link provider asks
 * before underlining anything.
 */
export const resolveFileLinks = (candidates: string[]) =>
  invoke<(string | null)[]>("resolve_file_links", { candidates });
