import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Whether the Mac is being kept awake. */
export const awakeGet = () => invoke<boolean>("awake_get");

/** Turn keeping awake on or off; resolves to the state it ended in. */
export const awakeSet = (on: boolean) => invoke<boolean>("awake_set", { on });

/**
 * The keep-awake switch, kept in step across windows: it is the app's, so a
 * flip in one window reaches every other through `awake://changed`.
 */
export function useAwake(onError: (message: string) => void): [boolean, () => void] {
  const [on, setOn] = useState(false);

  useEffect(() => {
    void awakeGet()
      .then(setOn)
      .catch(() => {});
    const unlisten = listen<boolean>("awake://changed", ({ payload }) => setOn(payload));
    return () => void unlisten.then((u) => u());
  }, []);

  const toggle = useCallback(() => {
    void awakeSet(!on)
      .then(setOn)
      .catch(() => onError("Could not keep the Mac awake."));
  }, [on, onError]);

  return [on, toggle];
}
