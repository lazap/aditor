/**
 * The recently-opened list and the per-project slice of UI state behind it.
 *
 * Everything here is keyed by the *canonical* path `open_workspace` returns,
 * never the raw string a dialog handed back -- otherwise `/tmp/x` and
 * `/private/tmp/x` would be two projects with two sets of state.
 */
import { STORAGE, loadJSON, removeKey, saveJSON } from "./config";

export interface RecentProject {
  path: string;
  /** Last opened, ms since epoch. Kept so the list can stay sorted. */
  openedAt: number;
}

export interface ProjectState {
  openFile: string | null;
  expandedDirs: string[];
  lastAgent: string | null;
}

/** Long enough to cover everything in rotation, short enough to scan. */
const MAX_RECENTS = 12;

const EMPTY_STATE: ProjectState = {
  openFile: null,
  expandedDirs: [],
  lastAgent: null,
};

type ProjectMap = Record<string, ProjectState>;

/**
 * Fold the flat pre-picker keys into the new shape, once. Without this the
 * workspace someone had open before upgrading disappears: the recents list
 * would start empty and their open file and expanded dirs would be dropped.
 */
function migrateLegacyState(): void {
  const legacy = loadJSON<string | null>(STORAGE.legacyWorkspace, null);
  if (legacy && localStorage.getItem(STORAGE.recents) === null) {
    saveJSON(STORAGE.recents, [{ path: legacy, openedAt: Date.now() }]);
    saveJSON(STORAGE.projects, {
      [legacy]: {
        openFile: loadJSON<string | null>(STORAGE.legacyOpenFile, null),
        expandedDirs: loadJSON<string[]>(STORAGE.legacyExpandedDirs, []),
        lastAgent: loadJSON<string | null>(STORAGE.lastAgent, null),
      },
    } satisfies ProjectMap);
  }
  removeKey(STORAGE.legacyWorkspace);
  removeKey(STORAGE.legacyOpenFile);
  removeKey(STORAGE.legacyExpandedDirs);
}

migrateLegacyState();

export function loadRecents(): RecentProject[] {
  return loadJSON<RecentProject[]>(STORAGE.recents, [])
    .filter((r) => typeof r?.path === "string")
    .sort((a, b) => b.openedAt - a.openedAt);
}

/** Move `path` to the front of the list and persist. Returns the new list. */
export function rememberProject(path: string): RecentProject[] {
  const next = [
    { path, openedAt: Date.now() },
    ...loadRecents().filter((r) => r.path !== path),
  ].slice(0, MAX_RECENTS);
  saveJSON(STORAGE.recents, next);
  return next;
}

/**
 * Drop `path` from the list. Its per-project state goes too -- a row removed
 * by hand should not leave a stale open file behind if the folder is opened
 * again later.
 */
export function forgetProject(path: string): RecentProject[] {
  const next = loadRecents().filter((r) => r.path !== path);
  saveJSON(STORAGE.recents, next);
  const projects = loadJSON<ProjectMap>(STORAGE.projects, {});
  if (path in projects) {
    delete projects[path];
    saveJSON(STORAGE.projects, projects);
  }
  return next;
}

export function loadProjectState(path: string): ProjectState {
  return { ...EMPTY_STATE, ...loadJSON<ProjectMap>(STORAGE.projects, {})[path] };
}

export function saveProjectState(
  path: string,
  patch: Partial<ProjectState>,
): void {
  const projects = loadJSON<ProjectMap>(STORAGE.projects, {});
  projects[path] = { ...EMPTY_STATE, ...projects[path], ...patch };
  saveJSON(STORAGE.projects, projects);
}
