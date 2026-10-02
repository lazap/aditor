/**
 * Window sizing. Aditor now starts on the project picker, which is a small
 * card -- opening at the editor's 1400x900 would put it in the middle of a
 * mostly empty window. So the window starts sized to the picker and grows to
 * the editor layout the first time a project is opened.
 */
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import type { Context } from "./templates/placeholders";
import { windowBackground } from "./theme";

const PICKER_WIDTH = 560;
/** Bounds for the measured fit: small enough to look deliberate, tall enough
 *  that a full recents list is not a two-row scroller. */
const PICKER_MIN_HEIGHT = 240;
const PICKER_MAX_HEIGHT = 720;

const EDITOR_WIDTH = 1400;
const EDITOR_HEIGHT = 900;
/** Below this the rail and terminal stop being usable together. */
const EDITOR_MIN_WIDTH = 720;
const EDITOR_MIN_HEIGHT = 480;

/**
 * Shrink the window around the picker's own measured height, so the card is
 * the window rather than a stamp in the middle of one.
 */
export async function fitWindowToPicker(contentHeight: number): Promise<void> {
  const height = Math.round(
    Math.min(Math.max(contentHeight, PICKER_MIN_HEIGHT), PICKER_MAX_HEIGHT),
  );
  const win = getCurrentWindow();
  // Lower the floor first: setSize is clamped by the current minimum.
  await win.setMinSize(new LogicalSize(360, PICKER_MIN_HEIGHT));
  await win.setSize(new LogicalSize(PICKER_WIDTH, height));
  await win.center();
}

/** Grow to the editor layout. Called once, when the first project opens. */
export async function growWindowToEditor(): Promise<void> {
  const win = getCurrentWindow();
  await win.setMinSize(new LogicalSize(EDITOR_MIN_WIDTH, EDITOR_MIN_HEIGHT));
  await win.setSize(new LogicalSize(EDITOR_WIDTH, EDITOR_HEIGHT));
  await win.center();
}

// ---------------------------------------------------------- editor windows ---

/**
 * Another editor window, opened on `root` -- the picker's "New window". It
 * loads the same page as the first and is told its project in the URL; it
 * owns its own tabs and its own agents.
 */
export async function openProjectWindow(root: string): Promise<void> {
  const label = `main-${Date.now().toString(36)}`;
  const win = new WebviewWindow(label, {
    url: `index.html?project=${encodeURIComponent(root)}`,
    title: "Aditor",
    width: EDITOR_WIDTH,
    height: EDITOR_HEIGHT,
    minWidth: EDITOR_MIN_WIDTH,
    minHeight: EDITOR_MIN_HEIGHT,
    // As the first window's config: the tabs strip is the title bar.
    titleBarStyle: "overlay",
    hiddenTitle: true,
    backgroundColor: windowBackground(),
  });
  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", () => resolve());
    void win.once("tauri://error", (e) => reject(new Error(String(e.payload))));
  });
}

// ------------------------------------------------------------ side windows ---

const selfLabel = (): string => getCurrentWindow().label;

/** An editor window -- the first, or one opened with New Window -- rather than
 *  a side window. Mirrors `is_editor` in lib.rs. */
export const isEditorWindow = (label = selfLabel()): boolean =>
  label === "main" || label.startsWith("main-");

/** Side window title: what it shows, and for which project. */
const titled = (what: string, root: string): string => `${what} — ${basename(root)}`;

/**
 * Bring an existing side window forward, or build it.
 *
 * One of each, ever: a second Settings window would be two editors of the same
 * document. `parent` keeps it above the editor that opened it on macOS, the way
 * a dialog sits. Resolves to the new window, or null when one was already open.
 */
async function showWindow(
  label: string,
  url: string,
  options: { title: string; width: number; height: number; minWidth: number; minHeight: number },
): Promise<WebviewWindow | null> {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return null;
  }
  return new WebviewWindow(label, {
    url,
    ...options,
    center: true,
    // Opened from another side window (the log from a diff), it has no editor
    // to sit above, so it floats free rather than naming one that may be gone.
    ...(isEditorWindow() ? { parent: selfLabel() } : {}),
    // The page's own `--bg`, so the window does not flash the other theme
    // before its stylesheet lands.
    backgroundColor: windowBackground(),
  });
}

export async function openSettingsWindow(): Promise<void> {
  await showWindow("settings", "index.html?view=settings", {
    title: "Settings",
    width: 780,
    height: 560,
    minWidth: 600,
    minHeight: 400,
  });
}

/**
 * The template picker, filled against `ctx`.
 *
 * A new window gets the context in its URL, because it cannot be listening for
 * an event before it exists. One already open is told by event instead.
 */
export async function openTemplatesWindow(ctx: Context): Promise<void> {
  const target: TemplatesTarget = { ctx, from: selfLabel() };
  const url = `index.html?view=templates&target=${encodeURIComponent(JSON.stringify(target))}`;
  const created = await showWindow("templates", url, {
    title: "Prompt templates",
    width: 640,
    height: 460,
    minWidth: 480,
    minHeight: 320,
  });
  if (!created) await emitTo("templates", TEMPLATES_CONTEXT, target);
}

/** Editor -> picker: fill against this, and type the result into `from`. */
export interface TemplatesTarget {
  ctx: Context;
  /** Label of the editor window whose agent the prompt is for. */
  from: string;
}

/** What the viewer window shows for its path. */
export type ViewerMode = "diff" | "file";

/** Editor -> viewer window payload. */
export interface ViewerTarget {
  /** Workspace the path belongs to; the viewer reads through it. */
  root: string;
  path: string;
  mode: ViewerMode;
  /** 1-based line to show, when opened from a `path:line` in the terminal. */
  line?: number;
}

/**
 * `path` -- its diff, or the file itself -- in a window of its own.
 *
 * Only one: opening another file retargets it, the way the template picker is
 * handed a new context rather than a second window.
 */
export async function openViewerWindow(
  root: string,
  path: string,
  mode: ViewerMode,
  line?: number,
): Promise<void> {
  const at = line === undefined ? "" : `&line=${line}`;
  const url =
    `index.html?view=diff&root=${encodeURIComponent(root)}` +
    `&path=${encodeURIComponent(path)}&mode=${mode}${at}`;
  const created = await showWindow("diff", url, {
    title: viewerTitle(root, path),
    width: 1000,
    height: 700,
    minWidth: 560,
    minHeight: 360,
  });
  if (!created) {
    await emitTo("diff", DIFF_PATH, { root, path, mode, line } satisfies ViewerTarget);
    return;
  }
  // The editor hears when it goes, so the highlight in the tree can follow.
  void created.once("tauri://destroyed", () => {
    for (const fn of diffClosed) fn();
  });
}

export const viewerTitle = (root: string, path: string): string =>
  titled(basename(path), root);

const diffClosed = new Set<() => void>();

/** Called whenever a diff window opened from here is destroyed. Every project
 *  tab listens; each clears its own highlight. Returns the unsubscribe. */
export function onDiffWindowClosed(fn: () => void): () => void {
  diffClosed.add(fn);
  return () => diffClosed.delete(fn);
}

/** What the log window should show: a filter, and/or a commit to select. */
export interface LogTarget {
  /** Whose history: the workspace the log reads. */
  root: string;
  /** A revision or `a..b` range to walk. */
  branch?: string;
  /** Only the history of this absolute path. */
  path?: string;
  /** Select this commit once it is loaded. */
  select?: string;
  /** With `select`: open this file's diff in that commit. */
  file?: string;
}

/**
 * The git log, IntelliJ's ⌘9, in a window of its own: a graph wants the width
 * the rail cannot give it. One only; asking again retargets it.
 */
export async function openLogWindow(target: LogTarget): Promise<void> {
  const url = `index.html?view=log&target=${encodeURIComponent(JSON.stringify(target))}`;
  const created = await showWindow("log", url, {
    title: logTitle(target.root),
    width: 1200,
    height: 760,
    minWidth: 720,
    minHeight: 400,
  });
  if (!created) await emitTo("log", LOG_TARGET, target);
}

export const logTitle = (root: string): string => titled("Git Log", root);

/** Editor or viewer -> log window: show this instead. */
export const LOG_TARGET = "log://target";

export const basename = (path: string): string => path.split("/").pop() || path;

/** Editor -> viewer window: show this path, in this mode, instead. */
export const DIFF_PATH = "diff://path";

/** Editor -> picker: the context changed under a window that is already open. */
export const TEMPLATES_CONTEXT = "templates://context";
/** Picker -> editor: type this finished prompt into the agent. */
export const TEMPLATES_INSERT = "templates://insert";
