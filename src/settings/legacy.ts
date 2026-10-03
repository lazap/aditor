/**
 * The localStorage settings, and the one-time lift out of them.
 *
 * Aditor kept everything in the webview's store until settings moved to
 * `~/.aditor/settings.json`. This module exists to empty that store exactly
 * once, and can be deleted once no install still has anything in it.
 *
 * Nothing else may import these keys. New settings go in `schema.ts`.
 */
import type { CommandId } from "../shortcuts/registry";
import type { DiffLayout } from "../components/DiffViewer";
import type { ProjectState, RecentProject, Settings } from "./schema";

const STORAGE = {
  recents: "aditor.recentProjects",
  projects: "aditor.projectState",
  lastAgent: "aditor.lastAgentId",
  splitFraction: "aditor.splitFraction",
  insightOpen: "aditor.insightOpen",
  insightWidth: "aditor.insightWidth",
  diffLayout: "aditor.diffLayout",
  shortcuts: "aditor.shortcuts",

  // Pre-picker keys, from before projects were a list. Folded in here for the
  // same reason as the rest: someone upgrading two versions at once should not
  // lose the workspace they had open.
  legacyWorkspace: "aditor.workspace",
  legacyOpenFile: "aditor.openFile",
  legacyExpandedDirs: "aditor.expandedDirs",
} as const;

const ALL_KEYS: readonly string[] = Object.values(STORAGE);

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Is there anything left to lift? */
export function hasLegacy(): boolean {
  try {
    return ALL_KEYS.some((k) => localStorage.getItem(k) !== null);
  } catch {
    return false; // a blocked store has nothing in it as far as we are concerned
  }
}

/**
 * Everything the old store held, in the new shape. Absent keys are simply
 * missing from the result, so the caller's defaults still apply.
 */
export function readLegacy(): Partial<Settings> {
  const out: Partial<Settings> = {};

  const recents = loadJSON<RecentProject[] | null>(STORAGE.recents, null);
  const projects = loadJSON<Record<string, ProjectState> | null>(STORAGE.projects, null);
  const workspace = loadJSON<string | null>(STORAGE.legacyWorkspace, null);

  if (recents) out.recents = recents;
  if (projects) out.projects = projects;

  // The pre-picker shape: one workspace with its state flat beside it. Only
  // used when the newer keys are absent, so a partial upgrade cannot undo a
  // list someone has since built up.
  if (workspace && !recents) {
    out.recents = [{ path: workspace, openedAt: Date.now() }];
    out.projects = {
      ...(projects ?? {}),
      [workspace]: {
        openFile: loadJSON<string | null>(STORAGE.legacyOpenFile, null),
        expandedDirs: loadJSON<string[]>(STORAGE.legacyExpandedDirs, []),
        lastAgent: loadJSON<string | null>(STORAGE.lastAgent, null),
        writable: [],
        lastRunConfig: null,
      },
    };
  }

  const lastAgent = loadJSON<string | null>(STORAGE.lastAgent, null);
  if (lastAgent) out.lastAgent = lastAgent;

  const shortcuts = loadJSON<Partial<Record<CommandId, string | null>> | null>(
    STORAGE.shortcuts,
    null,
  );
  if (shortcuts) out.shortcuts = shortcuts;

  const layout: Partial<Settings["layout"]> = {};
  const split = loadJSON<number | null>(STORAGE.splitFraction, null);
  const insightOpen = loadJSON<boolean | null>(STORAGE.insightOpen, null);
  const insightWidth = loadJSON<number | null>(STORAGE.insightWidth, null);
  const diffLayout = loadJSON<DiffLayout | null>(STORAGE.diffLayout, null);
  if (typeof split === "number") layout.splitFraction = split;
  if (typeof insightOpen === "boolean") layout.insightOpen = insightOpen;
  if (typeof insightWidth === "number") layout.insightWidth = insightWidth;
  if (diffLayout) layout.diffLayout = diffLayout;
  if (Object.keys(layout).length > 0) out.layout = layout as Settings["layout"];

  return out;
}

/** Only ever called once the lifted document is safely on disk. */
export function clearLegacy(): void {
  for (const key of ALL_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* a blocked store is already as empty as we need it to be */
    }
  }
}
