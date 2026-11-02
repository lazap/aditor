/**
 * Which OS the webview runs on, for the few places the UI differs by it: the
 * title bar, the menu bar, the default shortcuts, and the keys the terminal
 * gives up. The backend's counterpart is `src-tauri/src/platform.rs`.
 */
export const isMac = navigator.userAgent.includes("Mac");

/** What to call the machine in a label. */
export const machineName = isMac ? "Mac" : "computer";
