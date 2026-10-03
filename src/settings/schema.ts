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
  /**
   * Files the user unlocked for editing. Everything else stays read-only --
   * the agent writes the code -- but a `.env` or a config is the user's to
   * change, and stays unlocked until they lock it again.
   */
  writable: string[];
  /**
   * The run configuration the topbar has selected. Kept here rather than in
   * the project's `run.json`: which one you run is yours, the list is shared.
   */
  lastRunConfig: string | null;
}

/** Where a diff or a file opens: under the terminal, or in a window of its own. */
export type DiffDisplay = "pane" | "window";

/** How the read-only viewers take the keyboard: as-is, or with vim motions. */
export type KeyboardMode = "standard" | "vim";

/** Colour scheme: follow macOS, or pin one. */
export type Appearance = "system" | "light" | "dark";

/** Which panel the left rail shows. */
export type RailTab = "files" | "git";

/** Which tab the right-hand agent panel shows. */
export type InsightTab = "info" | "tasks";

/** Window furniture: sizes and which panels are open. */
export interface Layout {
  splitFraction: number;
  /** Width of the file-tree rail. Draggable, like `insightWidth`. */
  railWidth: number;
  railTab: RailTab;
  insightOpen: boolean;
  insightWidth: number;
  insightTab: InsightTab;
  diffLayout: DiffLayout;
  diffDisplay: DiffDisplay;
  /** Where a file picked in the tree opens; the git list goes by `diffDisplay`. */
  fileDisplay: DiffDisplay;
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

/** When to tell the user, from outside the tab, that a session wants them. */
export interface Notifications {
  /** The agent finished its turn. */
  onDone: boolean;
  /** The agent is blocked on the user: a permission prompt or a question. */
  onWaiting: boolean;
}

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
  /**
   * The first editor window's project tabs, in order, reopened at launch --
   * each with one fresh agent, never the sessions it had. Windows opened with
   * New Window are not restored.
   */
  openTabs: string[];
  activeTab: string | null;
  /** Agent to offer for a project opened for the first time. */
  lastAgent: string | null;
  layout: Layout;
  keyboardMode: KeyboardMode;
  appearance: Appearance;
  /** Underline file paths in the agent terminal and open them on click. */
  terminalFileLinks: boolean;
  notifications: Notifications;
  /** Which tab the Settings dialog opens on. */
  settingsTab: SettingsTab;
}

export const EMPTY_PROJECT_STATE: ProjectState = {
  openFile: null,
  expandedDirs: [],
  lastAgent: null,
  writable: [],
  lastRunConfig: null,
};

export const DEFAULTS: Settings = {
  version: 1,
  shortcuts: {},
  templates: [...DEFAULT_TEMPLATES],
  templatesSeed: TEMPLATE_SEED,
  recents: [],
  projects: {},
  openTabs: [],
  activeTab: null,
  lastAgent: null,
  layout: {
    splitFraction: 0.55,
    // Keep in step with `--rail-w`, which styles the rail until a drag lands.
    railWidth: 240,
    railTab: "files",
    insightOpen: true,
    insightWidth: 300,
    insightTab: "info",
    diffLayout: "unified",
    diffDisplay: "window",
    fileDisplay: "window",
    sections: {},
  },
  keyboardMode: "standard",
  appearance: "dark",
  terminalFileLinks: true,
  notifications: { onDone: true, onWaiting: true },
  settingsTab: "general",
};
