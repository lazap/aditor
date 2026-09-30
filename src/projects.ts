/**
 * The recently-opened list and the per-project slice of UI state behind it.
 *
 * Everything here is keyed by the *canonical* path `open_workspace` returns,
 * never the raw string a dialog handed back -- otherwise `/tmp/x` and
 * `/private/tmp/x` would be two projects with two sets of state.
 *
 * The storage underneath is `~/.aditor/settings.json` via `settings/store.ts`;
 * the reads stay synchronous because the document is hydrated before React
 * mounts.
 */
import { patch, settings } from "./settings/store";
import { EMPTY_PROJECT_STATE, type ProjectState, type RecentProject } from "./settings/schema";

export type { ProjectState, RecentProject };

/** Long enough to cover everything in rotation, short enough to scan. */
const MAX_RECENTS = 12;

export function loadRecents(): RecentProject[] {
  return [...settings().recents].sort((a, b) => b.openedAt - a.openedAt);
}

/** Move `path` to the front of the list and persist. Returns the new list. */
export function rememberProject(path: string): RecentProject[] {
  const next = [
    { path, openedAt: Date.now() },
    ...loadRecents().filter((r) => r.path !== path),
  ].slice(0, MAX_RECENTS);
  patch({ recents: next });
  return next;
}

/**
 * Drop `path` from the list. Its per-project state goes too -- a row removed
 * by hand should not leave a stale open file behind if the folder is opened
 * again later.
 */
export function forgetProject(path: string): RecentProject[] {
  const next = loadRecents().filter((r) => r.path !== path);
  const projects = { ...settings().projects };
  delete projects[path];
  patch({ recents: next, projects });
  return next;
}

export function loadProjectState(path: string): ProjectState {
  return { ...EMPTY_PROJECT_STATE, ...settings().projects[path] };
}

export function saveProjectState(path: string, update: Partial<ProjectState>): void {
  const projects = settings().projects;
  patch({
    projects: {
      ...projects,
      [path]: { ...EMPTY_PROJECT_STATE, ...projects[path], ...update },
    },
  });
}
