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
  | "focus.agentInfo"
  | "focus.agentTasks"
  | "account.next"
  | "prompt.templates"
  | "project.open"
  | "file.new"
  | "find.files"
  | "find.content"
  | "project.close"
  | "project.next"
  | "project.prev"
  | "session.new"
  | "session.close"
  | "session.next"
  | "session.prev"
  | "app.settings"
  | "git.commit"
  | "git.pull"
  | "git.pullRebase"
  | "git.push"
  | "git.stageAll"
  | "git.rollback"
  | "git.showDiff"
  | "git.log"
  | "git.annotate"
  | "git.branches"
  | "git.newBranch"
  | "git.newTag"
  | "git.fetch";

export interface ShortcutCommand {
  id: CommandId;
  /** Shown in the shortcuts panel. */
  label: string;
  group: "Focus" | "Tabs" | "Account" | "Prompt" | "Search" | "Git" | "App";
  /**
   * The binding shipped with the app; the user may override it. Null ships
   * the command unbound, for the user to give a chord in Settings.
   */
  chord: string | null;
}

export const COMMANDS: readonly ShortcutCommand[] = [
  { id: "focus.files", group: "Focus", chord: "mod+1", label: "Focus file tree" },
  { id: "focus.git", group: "Focus", chord: "mod+2", label: "Focus git changes" },
  { id: "focus.agent", group: "Focus", chord: "mod+e", label: "Focus agent" },
  {
    id: "focus.agentInfo",
    group: "Focus",
    chord: "mod+3",
    label: "Show agent info",
  },
  { id: "focus.agentTasks", group: "Focus", chord: "mod+4", label: "Show tasks" },
  // Sessions take IntelliJ's next/previous-tab chords, being the tabs used most;
  // projects sit one modifier over. ⌘W stays the window's own.
  { id: "session.new", group: "Tabs", chord: "mod+shift+t", label: "New agent session" },
  { id: "session.close", group: "Tabs", chord: "mod+shift+w", label: "Close agent session" },
  { id: "session.next", group: "Tabs", chord: "mod+shift+]", label: "Next agent session" },
  { id: "session.prev", group: "Tabs", chord: "mod+shift+[", label: "Previous agent session" },
  { id: "project.next", group: "Tabs", chord: "mod+alt+]", label: "Next project tab" },
  { id: "project.prev", group: "Tabs", chord: "mod+alt+[", label: "Previous project tab" },
  { id: "project.close", group: "Tabs", chord: null, label: "Close project tab" },
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
  // IntelliJ's Go to File and Find in Files. ⌘O stays Open project….
  { id: "find.files", group: "Search", chord: "mod+shift+o", label: "Find file…" },
  { id: "find.content", group: "Search", chord: "mod+shift+f", label: "Find in files…" },
  // Git chords follow IntelliJ's default keymap: ⌘K commit, ⌘⇧K push, ⌘T
  // update, ⌘⌥Z rollback, ⌘D diff, ⌘9 log. What IntelliJ ships unbound ships
  // unbound here too. Its branch and VCS popups sit on Ctrl chords, which on
  // macOS belong to the agent, so Branches… waits for the user to pick one.
  { id: "git.commit", group: "Git", chord: "mod+k", label: "Commit" },
  { id: "git.push", group: "Git", chord: "mod+shift+k", label: "Push…" },
  { id: "git.pull", group: "Git", chord: "mod+t", label: "Update project (pull)" },
  {
    id: "git.pullRebase",
    group: "Git",
    chord: null,
    label: "Pull with rebase",
  },
  { id: "git.rollback", group: "Git", chord: "mod+alt+z", label: "Rollback…" },
  { id: "git.showDiff", group: "Git", chord: "mod+d", label: "Show diff" },
  { id: "git.log", group: "Git", chord: "mod+9", label: "Show git log" },
  {
    id: "git.annotate",
    group: "Git",
    chord: null,
    label: "Annotate with git blame",
  },
  { id: "git.branches", group: "Git", chord: null, label: "Branches…" },
  { id: "git.newBranch", group: "Git", chord: null, label: "New branch…" },
  { id: "git.newTag", group: "Git", chord: null, label: "New tag…" },
  { id: "git.fetch", group: "Git", chord: null, label: "Fetch" },
  { id: "git.stageAll", group: "Git", chord: null, label: "Stage all changes" },
  { id: "project.open", group: "App", chord: "mod+o", label: "Open project…" },
  { id: "file.new", group: "App", chord: "mod+n", label: "New file…" },
  { id: "app.settings", group: "App", chord: "mod+,", label: "Settings…" },
];

export const GROUPS: ReadonlyArray<ShortcutCommand["group"]> = [
  "Focus",
  "Tabs",
  "Account",
  "Prompt",
  "Search",
  "Git",
  "App",
];

export const commandById = (id: CommandId): ShortcutCommand =>
  COMMANDS.find((c) => c.id === id)!;
