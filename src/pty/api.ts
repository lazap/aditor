import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

export interface AgentInfo {
  id: string;
  label: string;
  /** null means "just a login shell". */
  command: string | null;
  available: boolean;
  version: string | null;
}

/**
 * A plain terminal in the project folder, offered beside the agents when a
 * session is added. Not an agent the backend probes: `command: null` is what
 * spawns the user's interactive login shell.
 */
export const SHELL_SESSION: AgentInfo = {
  id: "shell",
  label: "Terminal",
  command: null,
  available: true,
  version: null,
};

/** What a session sends back over the channel handed to `ptySpawn`. */
export type PtyEvent =
  /** base64 of raw PTY bytes -- see note in pty.rs on why this is not a string. */
  | { kind: "output"; bytes: string }
  | { kind: "exit"; code: number | null };

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

/**
 * `onEvent` is attached before the process starts, so the first output and an
 * immediate exit cannot be missed.
 */
export function ptySpawn(
  args: { command: string | null; cwd: string; cols: number; rows: number },
  onEvent: (event: PtyEvent) => void,
): Promise<string> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("pty_spawn", { ...args, onEvent: channel });
}

/** xterm hands us a JS string; encode as UTF-8 so non-ASCII input survives. */
export const ptyWrite = (id: string, data: string) =>
  invoke<void>("pty_write", { id, bytes: toBase64(encoder.encode(data)) });

export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });

export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

/** Kill the sessions this window spawned; other editor windows keep theirs. */
const ptyKillWindow = () => invoke<void>("pty_kill_window");

/** Marker on `window`, which is fresh per page load but survives Fast Refresh. */
const REAPED = "__aditorOrphansReaped";

/**
 * The session the agent pane is currently showing, so text can be sent to it
 * from outside that pane -- which is how a prompt template gets typed in.
 *
 * On `window` for the same reason as `REAPED` below: Fast Refresh re-evaluates
 * module scope but leaves TerminalPane's spawn effect alone, so a module-level
 * variable would go null in dev and stay null until the next respawn.
 */
const ACTIVE = "__aditorActiveSession";

/** Fired on `window` whenever the active session changes. */
const ACTIVE_CHANGED = "aditor:active-session";

export function setActiveSession(id: string | null): void {
  (window as unknown as Record<string, string | null>)[ACTIVE] = id;
  window.dispatchEvent(new Event(ACTIVE_CHANGED));
}

export const activeSession = (): string | null =>
  (window as unknown as Record<string, string | null>)[ACTIVE] ?? null;

/** `activeSession()` as state, for UI that follows the agent across respawns. */
export function useActiveSession(): string | null {
  const [id, setId] = useState(activeSession);
  useEffect(() => {
    const sync = () => setId(activeSession());
    sync();
    window.addEventListener(ACTIVE_CHANGED, sync);
    return () => window.removeEventListener(ACTIVE_CHANGED, sync);
  }, []);
  return id;
}

/**
 * Type `text` into the running agent, as a paste rather than as keystrokes.
 *
 * The bracketed-paste markers are what make a multi-line template arrive as one
 * block: a bare newline written to the PTY is Enter, which would submit the
 * turn halfway through the prompt. Inside the markers a TUI treats the run as
 * pasted text and leaves it in the input line, un-sent, which is the whole
 * point of a template.
 *
 * False means there was no session to write to.
 */
export async function ptyWriteActive(text: string): Promise<boolean> {
  const id = activeSession();
  if (!id) return false;
  const body = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  await ptyWrite(id, `\x1b[200~${body}\x1b[201~`);
  return true;
}

/**
 * Reap sessions left over from a previous page context, at most once per page.
 *
 * A page reload throws away the JS context without running React's effect
 * cleanups, so those sessions are orphans no one will ever kill. But the reap
 * has to happen exactly once per *page*, not once per effect run: React Fast
 * Refresh re-runs effects while leaving TerminalPane's own effect alone, so an
 * unguarded version kills the live session and nothing respawns it. Hence the
 * flag on `window` rather than a module-scoped variable -- module scope is
 * re-evaluated by Fast Refresh, `window` is not. Scoped to this window in Rust,
 * so reloading one editor window leaves every other one's agents running.
 */
export async function reapOrphansOnce(): Promise<void> {
  const w = window as unknown as Record<string, boolean>;
  if (w[REAPED]) return;
  w[REAPED] = true;
  try {
    await ptyKillWindow();
  } catch {
    /* nothing to reap, or the backend is not ready yet */
  }
}
