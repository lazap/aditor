import { useSyncExternalStore } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { themeDelete, themesList, themeWrite } from "./api";
import { normalizeTheme, toFile, type ThemeDef, type ThemeFile } from "./model";
import { PRESETS, isPreset, presetFor } from "./presets";

/**
 * Every theme this window knows: the presets, then whatever is in
 * `~/.aditor/themes`.
 *
 * A module store for the reason `settings/store.ts` is one -- `theme.ts`
 * resolves the active theme outside React -- and loaded before React mounts
 * for the same reason too, so the first paint is already in a custom theme.
 *
 * Every window keeps its own copy. An edit is broadcast as the whole theme the
 * moment it is made, so the editor repaints while the Settings window is still
 * typing; the file write is debounced behind it.
 */

let custom: ThemeDef[] = [];
let all: readonly ThemeDef[] = PRESETS;

const listeners = new Set<() => void>();

const CHANGED = "themes://changed";

interface Change {
  from: string;
  id: string;
  /** Null for a deleted theme. */
  file: ThemeFile | null;
}

const self = getCurrentWindow().label;

const WRITE_DEBOUNCE_MS = 300;
const pending = new Map<string, number>();

const byName = (a: ThemeDef, b: ThemeDef) => a.name.localeCompare(b.name);

function set(next: ThemeDef[]): void {
  custom = [...next].sort(byName);
  all = [...PRESETS, ...custom];
  for (const fn of listeners) fn();
}

export const themes = (): readonly ThemeDef[] => all;

export const findTheme = (id: string): ThemeDef | undefined => all.find((t) => t.id === id);

export function subscribeThemes(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const useThemes = (): readonly ThemeDef[] =>
  useSyncExternalStore(subscribeThemes, themes, themes);

const fromFile = (id: string, raw: unknown): ThemeDef => normalizeTheme(raw, id, presetFor);

/**
 * Read the directory, once, before anything resolves a theme, and follow
 * edits made in other windows. Never rejects: without custom themes the
 * presets still work.
 */
export async function loadThemes(): Promise<void> {
  try {
    const stored = await themesList();
    set(stored.map(({ id, value }) => fromFile(id, value)));
  } catch (e) {
    console.error("could not read themes", e);
  }
  void listen<Change>(CHANGED, ({ payload }) => {
    if (payload.from === self) return;
    adopt(payload.id, payload.file === null ? null : fromFile(payload.id, payload.file));
  });
  window.addEventListener("beforeunload", () => void flushThemes());
}

/** Force pending writes out. Called on the way out of the window. */
export async function flushThemes(): Promise<void> {
  await Promise.all([...pending.keys()].map(writeNow));
}

function adopt(id: string, def: ThemeDef | null): void {
  const rest = custom.filter((t) => t.id !== id);
  set(def ? [...rest, def] : rest);
}

async function writeNow(id: string): Promise<void> {
  window.clearTimeout(pending.get(id));
  pending.delete(id);
  const def = custom.find((t) => t.id === id);
  if (!def) return;
  try {
    await themeWrite(id, toFile(def));
  } catch (e) {
    console.error(`could not save theme ${id}`, e);
  }
}

/** Create or change a custom theme. Presets are read-only. */
export function saveTheme(def: ThemeDef): void {
  if (isPreset(def.id)) return;
  adopt(def.id, def);
  void emit(CHANGED, { from: self, id: def.id, file: toFile(def) } satisfies Change).catch(
    () => {},
  );
  window.clearTimeout(pending.get(def.id));
  pending.set(
    def.id,
    window.setTimeout(() => void writeNow(def.id), WRITE_DEBOUNCE_MS),
  );
}

export async function deleteTheme(id: string): Promise<void> {
  if (isPreset(id)) return;
  window.clearTimeout(pending.get(id));
  pending.delete(id);
  adopt(id, null);
  void emit(CHANGED, { from: self, id, file: null } satisfies Change).catch(() => {});
  await themeDelete(id);
}
