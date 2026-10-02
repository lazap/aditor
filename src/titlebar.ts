/**
 * The editor window's title bar, on macOS.
 *
 * Editor windows open with an overlay title bar: the traffic lights float over
 * the page, and the project tabs strip is the title bar. The page has to leave
 * room for the buttons and mark the bar as something to drag the window by;
 * `:root[data-titlebar="overlay"]` in theme.css does the first, the
 * `data-tauri-drag-region` attributes the second.
 *
 * Elsewhere `titleBarStyle` is ignored and the native bar stays, so the
 * attribute is never set and nothing is inset.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

const isMac = navigator.userAgent.includes("Mac");

/** Once per editor window, before React mounts. */
export function installTitlebar(): void {
  if (!isMac) return;
  const root = document.documentElement;
  root.dataset.titlebar = "overlay";
  // Full screen hides the traffic lights, so the inset would be a gap.
  const win = getCurrentWindow();
  const sync = async () => {
    const full = await win.isFullscreen().catch(() => false);
    if (full) delete root.dataset.titlebar;
    else root.dataset.titlebar = "overlay";
  };
  void win.onResized(() => void sync());
}
