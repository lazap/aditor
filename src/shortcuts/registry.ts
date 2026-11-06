import { isMac, machineName } from "../platform";

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
  | "focus.agentSubagents"
  | "account.next"
  | "prompt.templates"
  | "voice.dictate"
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
  | "session.goto1"
  | "session.goto2"
  | "session.goto3"
  | "session.goto4"
  | "session.goto5"
  | "session.goto6"
  | "session.goto7"
  | "session.goto8"
  | "session.goto9"
  | "app.settings"
  | "app.keepAwake"
  | "app.checkUpdates"
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
  | "git.fetch"
  | "run.run"
  | "run.stop"
  | "run.choose"
  | "run.edit";

export interface ShortcutCommand {
  id: CommandId;
  /** Shown in the shortcuts panel. */
  label: string;
  group: "Focus" | "Tabs" | "Account" | "Prompt" | "Search" | "Git" | "Run" | "App";
  /**
   * The binding shipped with the app; the user may override it. Null ships
   * the command unbound, for the user to give a chord in Settings.
   */
  chord: string | null;
  /**
   * The binding shipped for Windows and Linux, when it is not `chord`.
   *
   * There `mod` is Ctrl, and a Ctrl+letter is a control key the agent and
   * the shell live on (Ctrl-E, Ctrl-K, Ctrl-R, Ctrl-W...), so nothing here
   * takes one. Those move to Ctrl+Shift, as a terminal emulator's own do,
   * with Ctrl+Shift+C and Ctrl+Shift+V left for the terminal's copy and
   * paste. Ctrl+Alt is out too: on Windows it is AltGr, which types `@`, `€`
   * or `ż` on many layouts. What found no home ships unbound.
   */
  other?: string | null;
}

export const COMMANDS: readonly ShortcutCommand[] = [
  // ⌘ + a digit picks a session tab, so the panels go by their initials.
  { id: "focus.files", group: "Focus", chord: "mod+shift+e", label: "Focus file tree" },
  {
    id: "focus.git",
    group: "Focus",
    chord: "mod+shift+c",
    other: "mod+shift+g",
    label: "Focus git changes",
  },
  // Ctrl+` is where an editor's terminal lives elsewhere.
  { id: "focus.agent", group: "Focus", chord: "mod+e", other: "mod+`", label: "Focus agent" },
  {
    id: "focus.agentInfo",
    group: "Focus",
    chord: "mod+shift+i",
    label: "Show agent info",
  },
  {
    id: "focus.agentTasks",
    group: "Focus",
    chord: "mod+shift+t",
    other: "mod+shift+l",
    label: "Show tasks",
  },
  {
    id: "focus.agentSubagents",
    group: "Focus",
    chord: "mod+shift+s",
    label: "Show subagents",
  },
  // Sessions take IntelliJ's next/previous-tab chords, being the tabs used most;
  // projects sit one modifier over. As in a browser, ⌘W closes the session and
  // ⌘⇧W, on the native menu, the window.
  // Elsewhere sessions take a terminal emulator's tab chords, Ctrl+Shift+T and
  // Ctrl+Shift+W, and the window closes the platform's way.
  { id: "session.new", group: "Tabs", chord: "mod+t", other: "mod+shift+t", label: "New agent session" },
  { id: "session.close", group: "Tabs", chord: "mod+w", other: "mod+shift+w", label: "Close agent session" },
  { id: "session.next", group: "Tabs", chord: "mod+shift+]", label: "Next agent session" },
  { id: "session.prev", group: "Tabs", chord: "mod+shift+[", label: "Previous agent session" },
  // As in a browser: ⌘1-⌘8 by position, ⌘9 the last one however many there are.
  { id: "session.goto1", group: "Tabs", chord: "mod+1", label: "Go to tab 1" },
  { id: "session.goto2", group: "Tabs", chord: "mod+2", label: "Go to tab 2" },
  { id: "session.goto3", group: "Tabs", chord: "mod+3", label: "Go to tab 3" },
  { id: "session.goto4", group: "Tabs", chord: "mod+4", label: "Go to tab 4" },
  { id: "session.goto5", group: "Tabs", chord: "mod+5", label: "Go to tab 5" },
  { id: "session.goto6", group: "Tabs", chord: "mod+6", label: "Go to tab 6" },
  { id: "session.goto7", group: "Tabs", chord: "mod+7", label: "Go to tab 7" },
  { id: "session.goto8", group: "Tabs", chord: "mod+8", label: "Go to tab 8" },
  { id: "session.goto9", group: "Tabs", chord: "mod+9", label: "Go to last tab" },
  {
    id: "project.next",
    group: "Tabs",
    chord: "mod+alt+]",
    other: "mod+pagedown",
    label: "Next project tab",
  },
  {
    id: "project.prev",
    group: "Tabs",
    chord: "mod+alt+[",
    other: "mod+pageup",
    label: "Previous project tab",
  },
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
  // M for microphone. Tap to start and again to stop, or hold it down for
  // as long as you talk; see `voice/useDictation.ts`. Kept out of the native
  // menu (menu.ts): a menu item's accelerator takes the chord before the page
  // sees the keydown, and with it the hold.
  {
    id: "voice.dictate",
    group: "Prompt",
    chord: "mod+shift+m",
    label: "Dictate",
  },
  // IntelliJ's Go to File and Find in Files. ⌘O stays Open project…. On
  // Windows and Linux IntelliJ's Go to File is Ctrl+Shift+N.
  {
    id: "find.files",
    group: "Search",
    chord: "mod+shift+o",
    other: "mod+shift+n",
    label: "Find file…",
  },
  { id: "find.content", group: "Search", chord: "mod+shift+f", label: "Find in files…" },
  // Git chords follow IntelliJ's default keymap: ⌘K commit, ⌘⇧K push,
  // ⌘⌥Z rollback, ⌘D diff. Its ⌘T update went to new sessions; ⌘⌥T instead. What IntelliJ ships unbound ships
  // unbound here too. Its branch and VCS popups sit on Ctrl chords, which on
  // macOS belong to the agent, so Branches… waits for the user to pick one.
  // Its ⌘9 log went to the session tabs; ⌘⇧H, for history, instead.
  { id: "git.commit", group: "Git", chord: "mod+k", other: "mod+shift+k", label: "Commit" },
  { id: "git.push", group: "Git", chord: "mod+shift+k", other: null, label: "Push…" },
  {
    id: "git.pull",
    group: "Git",
    chord: "mod+alt+t",
    other: null,
    label: "Update project (pull)",
  },
  {
    id: "git.pullRebase",
    group: "Git",
    chord: null,
    label: "Pull with rebase",
  },
  { id: "git.rollback", group: "Git", chord: "mod+alt+z", other: null, label: "Rollback…" },
  { id: "git.showDiff", group: "Git", chord: "mod+d", other: "mod+shift+d", label: "Show diff" },
  { id: "git.log", group: "Git", chord: "mod+shift+h", label: "Show git log" },
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
  // On macOS IntelliJ runs with Ctrl-R, but Ctrl chords belong to the agent
  // here (see keys.ts), and ⌘⇧R is the webview's reload. ⌘F2 is its Stop.
  // Elsewhere Ctrl+F5 runs, as it does in Visual Studio and VS Code.
  {
    id: "run.run",
    group: "Run",
    chord: "mod+r",
    other: "mod+f5",
    label: "Run selected configuration",
  },
  { id: "run.stop", group: "Run", chord: "mod+f2", label: "Stop selected configuration" },
  { id: "run.choose", group: "Run", chord: null, label: "Choose run configuration…" },
  { id: "run.edit", group: "Run", chord: null, label: "Edit run configurations…" },
  {
    id: "project.open",
    group: "App",
    chord: "mod+o",
    other: "mod+shift+o",
    label: "Open project…",
  },
  // Alt+Insert is IntelliJ's New… on Windows and Linux.
  { id: "file.new", group: "App", chord: "mod+n", other: "alt+insert", label: "New file…" },
  { id: "app.settings", group: "App", chord: "mod+,", label: "Settings…" },
  {
    id: "app.keepAwake",
    group: "App",
    chord: null,
    label: `Keep ${machineName} awake (toggle)`,
  },
  { id: "app.checkUpdates", group: "App", chord: null, label: "Check for updates…" },
];

export const GROUPS: ReadonlyArray<ShortcutCommand["group"]> = [
  "Focus",
  "Tabs",
  "Account",
  "Prompt",
  "Search",
  "Git",
  "Run",
  "App",
];

export const commandById = (id: CommandId): ShortcutCommand =>
  COMMANDS.find((c) => c.id === id)!;

/** The binding `c` ships with on this platform. */
export const defaultChord = (c: ShortcutCommand): string | null =>
  !isMac && c.other !== undefined ? c.other : c.chord;
