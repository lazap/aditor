import { invoke } from "@tauri-apps/api/core";

/**
 * `~/.aditor/settings.json`, as an opaque document.
 *
 * The backend does not know what a setting is; `schema.ts` does. Null comes
 * back when there is no file yet, or when the one there could not be parsed and
 * has been moved aside.
 */
export const settingsRead = () => invoke<unknown | null>("settings_read");

export const settingsWrite = (value: unknown) =>
  invoke<void>("settings_write", { value });
