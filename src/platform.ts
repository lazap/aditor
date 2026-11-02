/**
 * Which OS the webview runs on, for the few places the UI differs by it: the
 * title bar, the menu bar, the default shortcuts, and the keys the terminal
 * gives up. The backend's counterpart is `src-tauri/src/platform.rs`.
 */
export const isMac = navigator.userAgent.includes("Mac");

export const isWindows = navigator.userAgent.includes("Windows");

/** What to call the machine in a label. */
export const machineName = isMac ? "Mac" : "computer";

/**
 * Whether a typed path is absolute anywhere: `/x`, `C:\x`, `C:/x` or a
 * `\\server` share. Paths from the backend always use `/` (Windows ones
 * too, see `path_string` in platform.rs); this is for what the user types.
 */
export const isAbsolutePath = (p: string): boolean => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);

/** A typed relative path's parts, split on either slash. */
export const pathParts = (p: string): string[] => p.split(/[\\/]/);
