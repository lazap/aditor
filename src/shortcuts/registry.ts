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
  | "account.next"
  | "project.open"
  | "app.shortcuts";

export interface ShortcutCommand {
  id: CommandId;
  /** Shown in the shortcuts panel. */
  label: string;
  group: "Focus" | "Account" | "App";
  /** The binding shipped with the app; the user may override it. */
  chord: string;
}

export const COMMANDS: readonly ShortcutCommand[] = [
  { id: "focus.files", group: "Focus", chord: "mod+1", label: "Focus file tree" },
  { id: "focus.agent", group: "Focus", chord: "mod+2", label: "Focus agent" },
  {
    id: "account.next",
    group: "Account",
    chord: "mod+shift+a",
    label: "Next Claude Code account",
  },
  { id: "project.open", group: "App", chord: "mod+o", label: "Open project…" },
  { id: "app.shortcuts", group: "App", chord: "mod+,", label: "Keyboard shortcuts…" },
];

export const GROUPS: ReadonlyArray<ShortcutCommand["group"]> = [
  "Focus",
  "Account",
  "App",
];

export const commandById = (id: CommandId): ShortcutCommand =>
  COMMANDS.find((c) => c.id === id)!;
