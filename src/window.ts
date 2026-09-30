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

// ------------------------------------------------------------ side windows ---

/** Matches `--bg` in theme.css, so a new window does not flash white before
 *  its stylesheet lands. */
const WINDOW_BG = "#14161a";

/**
 * Bring an existing side window forward, or build it.
 *
 * One of each, ever: a second Settings window would be two editors of the same
 * document. `parent` keeps it above the editor on macOS, the way a dialog sits.
 * Resolves to the new window, or null when one was already open.
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
    parent: "main",
    backgroundColor: WINDOW_BG,
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
  const url = `index.html?view=templates&ctx=${encodeURIComponent(JSON.stringify(ctx))}`;
  const created = await showWindow("templates", url, {
    title: "Prompt templates",
    width: 640,
    height: 460,
    minWidth: 480,
    minHeight: 320,
  });
  if (!created) await emitTo("templates", TEMPLATES_CONTEXT, ctx);
}

/**
 * The diff for `path`, in a window of its own.
 *
 * Only one: opening another file retargets it, the way the template picker is
 * handed a new context rather than a second window.
 */
export async function openDiffWindow(path: string): Promise<void> {
  const url = `index.html?view=diff&path=${encodeURIComponent(path)}`;
  const created = await showWindow("diff", url, {
    title: basename(path),
    width: 1000,
    height: 700,
    minWidth: 560,
    minHeight: 360,
  });
  if (!created) {
    await emitTo("diff", DIFF_PATH, path);
    return;
  }
  // Main hears when it goes, so the highlight in the tree can follow.
  void created.once("tauri://destroyed", () => diffClosed?.());
}

let diffClosed: (() => void) | null = null;

/** Called whenever a diff window opened from here is destroyed. */
export function onDiffWindowClosed(fn: () => void): void {
  diffClosed = fn;
}

/** Close the diff window, if there is one -- its path belongs to one project. */
export async function closeDiffWindow(): Promise<void> {
  await (await WebviewWindow.getByLabel("diff"))?.close();
}

export const basename = (path: string): string => path.split("/").pop() || path;

/** Main -> diff window: show this path instead. */
export const DIFF_PATH = "diff://path";

/** Main -> picker: the context changed under a window that is already open. */
export const TEMPLATES_CONTEXT = "templates://context";
/** Picker -> main: type this finished prompt into the agent. */
export const TEMPLATES_INSERT = "templates://insert";
