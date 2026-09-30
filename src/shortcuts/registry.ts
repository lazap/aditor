/**
 * Every shortcut the app has, as data.
 *
 * This list is the single source of truth: it drives dispatch (useShortcuts)
 * *and* which chords TerminalPane keeps back from the agent (store's
 * `isReservedForApp`). Adding a row is the whole job of adding a shortcut --
 * there is no second place to remember.
 */

export type CommandId =
  | "focus.files"
  | "focus.agent"
  | "focus.git"
  | "account.next"
  | "prompt.templates"
  | "project.open"
  | "app.settings"
  | "git.commit"
  | "git.pull"
  | "git.pullRebase"
  | "git.push"
  | "git.stageAll";

export interface ShortcutCommand {
  id: CommandId;
  /** Shown in the shortcuts panel. */
  label: string;
  group: "Focus" | "Account" | "Prompt" | "Git" | "App";
  /**
   * The binding shipped with the app; the user may override it. Null ships
   * the command unbound, for the user to give a chord in Settings.
   */
  chord: string | null;
}

export const COMMANDS: readonly ShortcutCommand[] = [
  { id: "focus.files", group: "Focus", chord: "mod+1", label: "Focus file tree" },
  { id: "focus.git", group: "Focus", chord: "mod+2", label: "Focus git changes" },
  { id: "focus.agent", group: "Focus", chord: "mod+3", label: "Focus agent" },
  {
    id: "account.next",
    group: "Account",
    chord: "mod+shift+a",
    label: "Next Claude Code account",
  },
  {
    id: "prompt.templates",
    group: "Prompt",
    chord: "mod+shift+p",
    label: "Prompt templates…",
  },
  { id: "git.commit", group: "Git", chord: "mod+alt+c", label: "Commit" },
  { id: "git.stageAll", group: "Git", chord: null, label: "Stage all changes" },
  { id: "git.pull", group: "Git", chord: "mod+alt+l", label: "Pull" },
  {
    id: "git.pullRebase",
    group: "Git",
    chord: null,
    label: "Pull with rebase",
  },
  { id: "git.push", group: "Git", chord: "mod+alt+p", label: "Push" },
  { id: "project.open", group: "App", chord: "mod+o", label: "Open project…" },
  { id: "app.settings", group: "App", chord: "mod+,", label: "Settings…" },
];

export const GROUPS: ReadonlyArray<ShortcutCommand["group"]> = [
  "Focus",
  "Account",
  "Prompt",
  "Git",
  "App",
];

export const commandById = (id: CommandId): ShortcutCommand =>
  COMMANDS.find((c) => c.id === id)!;
