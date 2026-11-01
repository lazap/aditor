import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** Matched by a .gitignore: listed, but dimmed. */
  ignored: boolean;
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
  ignored: boolean;
}

export const openWorkspace = (path: string) =>
  invoke<string>("open_workspace", { path });

/** Forget a workspace when its last tab closes, stopping its watcher. */
export const closeWorkspace = (root: string) =>
  invoke<void>("close_workspace", { root });

/** `fs://changed`: absolute paths that moved inside one open workspace. */
export interface FsChanged {
  root: string;
  paths: string[];
}

/** Git state in a workspace's repo moved -- a commit, stage or checkout, from anywhere. */
export const FS_GIT = "fs://git";

/** `fs://git`: which workspace. */
export interface FsGit {
  root: string;
}

export const listDir = async (root: string, path?: string): Promise<DirEntry[]> => {
  const raw = await invoke<RawDirEntry[]>("list_dir", { root, path: path ?? null });
  return raw.map((e) => ({ name: e.name, path: e.path, isDir: e.is_dir, ignored: e.ignored }));
};

export const readFile = (root: string, path: string) =>
  invoke<FileContents>("read_file", { root, path });

/** What `writeFile` rejects with when the file no longer holds `expected`. */
export const CHANGED_ON_DISK = "changed on disk";

/**
 * Save over a file the user made writable; it must exist in the workspace.
 * With `expected` (the disk text the edit started from), refuses with
 * `CHANGED_ON_DISK` rather than overwrite a change made since; without it,
 * overwrites unconditionally.
 */
export const writeFile = (root: string, path: string, text: string, expected?: string) =>
  invoke<void>("write_file", { root, path, text, expected: expected ?? null });

/** Create an empty file at `rel` under the root; resolves to its absolute path. */
export const createFile = (root: string, rel: string) =>
  invoke<string>("create_file", { root, rel });

/** Move `from` into the folder `into`, keeping its name; resolves to its new path. */
export const movePath = (root: string, from: string, into: string) =>
  invoke<string>("move_path", { root, from, into });

export const fsDebounceMs =() => invoke<number>("fs_debounce_ms");

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
export const resolveFileLinks = (root: string, candidates: string[]) =>
  invoke<(string | null)[]>("resolve_file_links", { root, candidates });
