export const STORAGE = {
  /** Recently opened projects, most recent first. */
  recents: "aditor.recentProjects",
  /** Per-project UI state, keyed by canonical workspace path. */
  projects: "aditor.projectState",
  /** Agent to offer for a project opened for the first time. */
  lastAgent: "aditor.lastAgentId",
  splitFraction: "aditor.splitFraction",
  /** Right-hand agent panel: shown at all, and how wide. */
  insightOpen: "aditor.insightOpen",
  insightWidth: "aditor.insightWidth",
  diffLayout: "aditor.diffLayout",

  // Pre-picker keys. Nothing writes these any more; they exist so
  // `migrateLegacyState` in projects.ts can fold them into the new shape once
  // and then clear them.
  legacyWorkspace: "aditor.workspace",
  legacyOpenFile: "aditor.openFile",
  legacyExpandedDirs: "aditor.expandedDirs",
} as const;

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a full or blocked store should never break the app */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* as above */
  }
}
