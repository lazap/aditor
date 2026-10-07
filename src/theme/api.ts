import { invoke } from "@tauri-apps/api/core";

/**
 * `~/.aditor/themes/<id>.json`, as opaque documents -- `model.ts` is what
 * knows their shape. The two presets have no file.
 */
export const themesList = () => invoke<Array<{ id: string; value: unknown }>>("themes_list");

export const themeWrite = (id: string, value: unknown) =>
  invoke<void>("theme_write", { id, value });

export const themeDelete = (id: string) => invoke<void>("theme_delete", { id });

/** Read a file the user picked; the caller normalises what comes back. */
export const themeImport = (path: string) => invoke<unknown>("theme_import", { path });

export const themeExport = (path: string, value: unknown) =>
  invoke<void>("theme_export", { path, value });
