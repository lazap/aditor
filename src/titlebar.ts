/**
 * The editor window's title bar, on macOS.
 *
 * Editor windows open with an overlay title bar: the traffic lights float over
 * the page, and the project tabs strip is the title bar. The page has to leave
 * room for the buttons and mark the bar as something to drag the window by;
 * `:root[data-titlebar="overlay"]` in theme.css does the first, the
 * `data-tauri-drag-region` attributes the second.
 *
 * Full screen hides the traffic lights, so there the attribute turns to
 * "fullscreen" and the strip draws its own (`WindowControls` in ProjectTabs).
 *
 * Elsewhere `titleBarStyle` is ignored and the native bar stays, so the
 * attribute is never set and nothing is inset.
 */
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { isMac } from "./platform";

/** Once per editor window, before React mounts. */
export function installTitlebar(): void {
  if (!isMac) return;
  const root = document.documentElement;
  root.dataset.titlebar = "overlay";
  const win = getCurrentWindow();
  const sync = async () => {
    const full = await win.isFullscreen().catch(() => false);
    root.dataset.titlebar = full ? "fullscreen" : "overlay";
  };
  void win.onResized(() => void sync());
  void sync();
}

// ------------------------------------------- the traffic lights, drawn ---

export function closeWindow(): void {
  void getCurrentWindow().close();
}

/** As the green light does in full screen: back to a window. */
export function leaveFullscreen(): void {
  void getCurrentWindow().setFullscreen(false);
}

/** A full-screen window cannot go to the Dock, so it leaves full screen first. */
export async function minimizeWindow(): Promise<void> {
  const win = getCurrentWindow();
  if (await win.isFullscreen()) {
    await win.setFullscreen(false);
    await windowed(win);
  }
  await win.minimize();
}

/** Resolves once the leave-full-screen animation is over, or after 2s. */
function windowed(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let unlisten: (() => void) | undefined;
    const done = () => {
      clearTimeout(timer);
      unlisten?.();
      resolve();
    };
    const timer = setTimeout(done, 2000);
    void win
      .onResized(async () => {
        if (!(await win.isFullscreen().catch(() => false))) done();
      })
      .then((u) => (unlisten = u));
  });
}
