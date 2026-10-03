import { Channel, invoke } from "@tauri-apps/api/core";
import type { PtyEvent } from "../pty/api";
import type { PackageManager } from "./schema";

/** The project's `.aditor/run.json` as parsed JSON, or null when it has none. */
export const runConfigsRead = (root: string) => invoke<unknown>("run_configs_read", { root });

export const runConfigsWrite = (root: string, value: unknown) =>
  invoke<void>("run_configs_write", { root, value });

export interface Suggestion {
  name: string;
  /** `type` plus some of that type's fields. */
  config: Record<string, unknown> & { type: string };
}

export interface Detected {
  packageManager: PackageManager | null;
  python: string | null;
  suggestions: Suggestion[];
}

/** What the project looks like it can run, for the configurations dialog. */
export const runDetect = (root: string) => invoke<Detected>("run_detect", { root });

/** Where the file lives, relative to the root. The watcher reports this path. */
export const RUN_FILE = ".aditor/run.json";

/**
 * Run a configuration's shell line in a PTY. Like `ptySpawn`, `onEvent` is
 * attached before the process starts, and the id it resolves to works with
 * `ptyWrite`, `ptyResize` and `ptyKill`.
 */
export function ptyRun(
  args: {
    root: string;
    script: string;
    /** Relative to `root`. */
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  },
  onEvent: (event: PtyEvent) => void,
): Promise<string> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("pty_run", { ...args, onEvent: channel });
}
