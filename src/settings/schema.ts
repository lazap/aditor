/**
 * Everything Aditor remembers, as one document.
 *
 * This is the shape of `~/.aditor/settings.json`. The Rust side never looks
 * inside it -- `settings.rs` reads and writes an opaque JSON value -- so this
 * file is the only definition of what a setting is, the way
 * `shortcuts/registry.ts` is the only definition of what a shortcut is.
 *
 * Every field has a default here, and `store.ts` merges the file over these
 * rather than trusting it. A settings file is a file people can edit, so it is
 * treated as a suggestion at every level.
 */
import type { CommandId } from "../shortcuts/registry";
import type { DiffLayout } from "../components/DiffViewer";
import { DEFAULT_TEMPLATES, TEMPLATE_SEED, type PromptTemplate } from "../templates/registry";

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

/** Window furniture: sizes and which panels are open. */
export interface Layout {
  splitFraction: number;
  /** Width of the file-tree rail. Draggable, like `insightWidth`. */
  railWidth: number;
  insightOpen: boolean;
  insightWidth: number;
  diffLayout: DiffLayout;
  /**
   * Collapsible bands in the agent panel: section id -> open.
   *
   * Sparse on purpose. A band the user has never touched is absent, so the
   * default in `Section` still governs it and a later change to that default
   * reaches everyone who never had an opinion.
   */
  sections: Record<string, boolean>;
}

export type SettingsTab = "general" | "templates" | "shortcuts";

export interface Settings {
  /** Bumped only for a change `store.ts` has to migrate. */
  version: number;
  /** Rebindings: command id -> chord, or null for one the user cleared. */
  shortcuts: Partial<Record<CommandId, string | null>>;
  /** The user's list, seeded from `DEFAULT_TEMPLATES` on first run. */
  templates: PromptTemplate[];
  /**
   * Highest `TEMPLATE_SEED` already folded in. A later release can ship new
   * built-ins without resurrecting the ones this user deleted.
   */
  templatesSeed: number;
  recents: RecentProject[];
  /** Per-project UI state, keyed by canonical workspace path. */
  projects: Record<string, ProjectState>;
  /** Agent to offer for a project opened for the first time. */
  lastAgent: string | null;
  layout: Layout;
  /** Which tab the Settings dialog opens on. */
  settingsTab: SettingsTab;
}

export const EMPTY_PROJECT_STATE: ProjectState = {
  openFile: null,
  expandedDirs: [],
  lastAgent: null,
};

export const DEFAULTS: Settings = {
  version: 1,
  shortcuts: {},
  templates: [...DEFAULT_TEMPLATES],
  templatesSeed: TEMPLATE_SEED,
  recents: [],
  projects: {},
  lastAgent: null,
  layout: {
    splitFraction: 0.55,
    // Keep in step with `--rail-w`, which styles the rail until a drag lands.
    railWidth: 240,
    insightOpen: true,
    insightWidth: 300,
    diffLayout: "unified",
    sections: {},
  },
  settingsTab: "general",
};
