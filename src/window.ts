/**
 * Window sizing. Aditor now starts on the project picker, which is a small
 * card -- opening at the editor's 1400x900 would put it in the middle of a
 * mostly empty window. So the window starts sized to the picker and grows to
 * the editor layout the first time a project is opened.
 */
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
