import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { FsChanged } from "../fs/api";
import { RUN_FILE, runConfigsRead, runConfigsWrite, runDetect, type Detected } from "./api";
import { normalize, toFile, type RunConfig } from "./schema";
import type { ScriptContext } from "./command";

export interface RunConfigs {
  configs: RunConfig[];
  /** Why the file could not be read; saving is refused while this is set. */
  error: string | null;
  /** What the project looks like, for configurations left on "auto". */
  context: ScriptContext;
  detected: Detected | null;
  save(next: RunConfig[]): Promise<void>;
  /** Look at the project again, e.g. when the dialog opens. */
  redetect(): void;
}

const errorText = (e: unknown) => String(e).replace(/^Error:\s*/, "");

/**
 * The project's run configurations, kept in step with `.aditor/run.json` on
 * disk: a hand edit, a `git pull` or an agent rewriting the file shows up
 * here without a reload.
 */
export function useRunConfigs(root: string): RunConfigs {
  const [configs, setConfigs] = useState<RunConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null);

  const load = useCallback(() => {
    runConfigsRead(root)
      .then((raw) => {
        setConfigs(normalize(raw));
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [root]);

  const redetect = useCallback(() => {
    runDetect(root)
      .then(setDetected)
      .catch(() => {
        /* suggestions are a convenience; the dialog works without them */
      });
  }, [root]);

  useEffect(() => {
    load();
    redetect();
  }, [load, redetect]);

  useEffect(() => {
    const file = `${root}/${RUN_FILE}`;
    const unlisten = listen<FsChanged>("fs://changed", ({ payload }) => {
      if (payload.root === root && payload.paths.includes(file)) load();
    });
    return () => void unlisten.then((u) => u());
  }, [root, load]);

  const save = useCallback(
    async (next: RunConfig[]) => {
      await runConfigsWrite(root, toFile(next));
      setConfigs(next);
      setError(null);
    },
    [root],
  );

  // Stable between detections: run callbacks and the dialog's suggestions
  // depend on it.
  const context = useMemo<ScriptContext>(
    () => ({
      packageManager: detected?.packageManager ?? null,
      python: detected?.python ?? null,
    }),
    [detected],
  );

  return {
    configs,
    error,
    context,
    detected,
    save,
    redetect,
  };
}
