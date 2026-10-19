import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Where the self-update stands. `ready` means the new bundle is already in
 * place on disk and only the restart is left.
 */
export type UpdateState =
  | { phase: "idle" }
  | { phase: "available"; version: string; notes: string }
  | { phase: "installing"; version: string; percent: number | null }
  | { phase: "ready"; version: string };

/** How often a running app looks again, after the check at launch. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

/** Lets the window finish booting before it touches the network. */
const FIRST_CHECK_MS = 10_000;

/** The update's progress, kept in step across editor windows. */
const STATE_EVENT = "update://state";

interface Options {
  onInfo(text: string): void;
  onError(text: string): void;
  /** Asked before installing a manually found update; resolves to go ahead. */
  confirmInstall(version: string, notes: string): Promise<boolean>;
  /** Asked before relaunching; resolves to go ahead. */
  confirmRestart(): Promise<boolean>;
}

/**
 * The self-updater: checks the release's latest.json at launch and every few
 * hours, installs on request, then relaunches on request.
 *
 * Installing replaces the `.app` in place, wherever it is -- for a Homebrew
 * install that is /Applications, where the cask put it. The cask declares
 * `auto_updates true`, so brew leaves the app to this and does not fight it.
 *
 * Automatic checks fail silently: an offline Mac, or a release feed that is
 * not reachable, is no news worth a toast. A manual check says what happened.
 */
export function useUpdate({ onInfo, onError, confirmInstall, confirmRestart }: Options) {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });
  /** The handle `check()` returned, needed to install; per window. */
  const pending = useRef<Update | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Set here, and in every other editor window. */
  const publish = useCallback((next: UpdateState) => {
    setState(next);
    void emit(STATE_EVENT, next).catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<UpdateState>(STATE_EVENT, ({ payload }) => setState(payload));
    return () => void unlisten.then((u) => u());
  }, []);

  const lookup = useCallback(async (): Promise<Update | null> => {
    const found = await check();
    pending.current = found;
    // Never step back from an install already under way or done.
    const phase = stateRef.current.phase;
    if (found && (phase === "idle" || phase === "available")) {
      setState({ phase: "available", version: found.version, notes: found.body ?? "" });
    }
    return found;
  }, []);

  const install = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase !== "available") return;
    try {
      const update = pending.current ?? (await lookup());
      if (!update) return;
      let total: number | null = null;
      let done = 0;
      let shown = -1;
      publish({ phase: "installing", version: update.version, percent: null });
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        if (event.event !== "Progress" || !total) return;
        done += event.data.chunkLength;
        const percent = Math.min(100, Math.floor((done / total) * 100));
        // Once per percent, not once per chunk: each one crosses to every window.
        if (percent === shown) return;
        shown = percent;
        publish({ phase: "installing", version: update.version, percent });
      });
      publish({ phase: "ready", version: update.version });
    } catch (e) {
      publish({ phase: "available", version: current.version, notes: current.notes });
      onError(`Could not install Aditor ${current.version}: ${String(e)}`);
    }
  }, [lookup, onError, publish]);

  const restart = useCallback(async () => {
    if (stateRef.current.phase !== "ready") return;
    if (!(await confirmRestart())) return;
    try {
      await relaunch();
    } catch {
      onError("Could not restart Aditor. Quit and reopen it to finish the update.");
    }
  }, [confirmRestart, onError]);

  /** The menu command: always reports back, and offers to install. */
  const checkNow = useCallback(async () => {
    const phase = stateRef.current.phase;
    if (phase === "installing") return;
    if (phase === "ready") return void restart();
    try {
      const found = await lookup();
      if (!found) {
        onInfo(`Aditor ${await getVersion()} is the latest version.`);
        return;
      }
      if (await confirmInstall(found.version, found.body ?? "")) await install();
    } catch (e) {
      onError(`Could not check for updates: ${String(e)}`);
    }
  }, [confirmInstall, install, lookup, onError, onInfo, restart]);

  useEffect(() => {
    // A dev build would offer the latest release in place of the checkout.
    if (import.meta.env.DEV) return;
    const quiet = () => void lookup().catch(() => {});
    const first = window.setTimeout(quiet, FIRST_CHECK_MS);
    const every = window.setInterval(quiet, RECHECK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [lookup]);

  return { state, install, restart, checkNow };
}
