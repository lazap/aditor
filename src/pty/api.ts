import { invoke } from "@tauri-apps/api/core";

export interface AgentInfo {
  id: string;
  label: string;
  /** null means "just a login shell". */
  command: string | null;
  available: boolean;
  version: string | null;
}

export interface PtyOutput {
  id: string;
  /** base64 of raw PTY bytes -- see note in pty.rs on why this is not a string. */
  bytes: string;
}

export interface PtyExit {
  id: string;
  code: number | null;
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const agentsAvailable = () => invoke<AgentInfo[]>("agents_available");

export const ptySpawn = (args: {
  command: string | null;
  cwd: string;
  cols: number;
  rows: number;
}) => invoke<string>("pty_spawn", args);

/** xterm hands us a JS string; encode as UTF-8 so non-ASCII input survives. */
export const ptyWrite = (id: string, data: string) =>
  invoke<void>("pty_write", { id, bytes: toBase64(encoder.encode(data)) });

export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });

export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

const ptyKillAll = () => invoke<void>("pty_kill_all");

/** Marker on `window`, which is fresh per page load but survives Fast Refresh. */
const REAPED = "__aditorOrphansReaped";

/**
 * Reap sessions left over from a previous page context, at most once per page.
 *
 * A page reload throws away the JS context without running React's effect
 * cleanups, so those sessions are orphans no one will ever kill. But the reap
 * has to happen exactly once per *page*, not once per effect run: React Fast
 * Refresh re-runs effects while leaving TerminalPane's own effect alone, so an
 * unguarded version kills the live session and nothing respawns it. Hence the
 * flag on `window` rather than a module-scoped variable -- module scope is
 * re-evaluated by Fast Refresh, `window` is not.
 */
export async function reapOrphansOnce(): Promise<void> {
  const w = window as unknown as Record<string, boolean>;
  if (w[REAPED]) return;
  w[REAPED] = true;
  try {
    await ptyKillAll();
  } catch {
    /* nothing to reap, or the backend is not ready yet */
  }
}
