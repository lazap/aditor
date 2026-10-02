import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** `pty://status`: an agent's own report of what it is doing, from its live registry. */
export interface PtyStatus {
  /** The PTY session. */
  id: string;
  /** "busy", "idle", "waiting", or whatever a newer agent adds. */
  status: string;
  waitingFor: string | null;
}

/** What a session wants from the user, if anything. */
export type Attention = "done" | "waiting";

/** Status changes of this window's sessions; the backend sends no one else's. */
export const onPtyStatus = (cb: (s: PtyStatus) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<PtyStatus>("pty://status", (e) => cb(e.payload));

/** This window's share of the Dock badge. */
export const setAttentionCount = (count: number) =>
  invoke<void>("set_attention_count", { count });

let permission: Promise<boolean> | null = null;

/** Asked once per page, and only when there is first something to say. */
function allowed(): Promise<boolean> {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  })().catch(() => false);
  return permission;
}

/** A macOS notification. Silently nothing when the user said no. */
export async function notify(title: string, body: string): Promise<void> {
  if (await allowed()) sendNotification({ title, body });
}
