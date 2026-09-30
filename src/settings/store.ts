import { useSyncExternalStore } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { settingsRead, settingsWrite } from "./api";
import { clearLegacy, hasLegacy, readLegacy } from "./legacy";
import { DEFAULTS, type Settings } from "./schema";
import { DEFAULT_TEMPLATES, TEMPLATE_SEED, type PromptTemplate } from "../templates/registry";

/**
 * The settings document, in memory.
 *
 * A module store rather than context, for the same reason `shortcuts/store.ts`
 * is one: the things that read it are not all components. `projects.ts` is a
 * plain module, and the shortcut keymap is consulted from inside an xterm key
 * handler where going through React would be absurd.
 *
 * Reads are synchronous against this snapshot, which is what lets every
 * existing call site stay as it was. That is only sound because `hydrate()`
 * runs to completion before React mounts -- see `main.tsx`.
 */

let current: Settings = DEFAULTS;
let hydrated = false;

const listeners = new Set<() => void>();

/** Long enough to coalesce a drag or a burst of typing, short enough to feel
 * instant if the app is quit straight after. */
const WRITE_DEBOUNCE_MS = 300;
let timer: number | undefined;
let pending = false;

export const settings = (): Settings => current;

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-renders on every change. For the settings dialog. */
export const useSettings = (): Settings =>
  useSyncExternalStore(subscribe, settings, settings);

/**
 * Subscribe to one field.
 *
 * `useSettings` re-renders on any change at all, which is right inside the
 * settings dialog and wrong outside it -- App would re-render the file tree on
 * every keystroke typed into a template body. Select a primitive and
 * `useSyncExternalStore` compares it and bails out.
 */
export function useSetting<T>(select: (s: Settings) => T): T {
  const read = () => select(current);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Merge `next` into the document and schedule a write.
 *
 * Shallow at the top level: a caller replacing `templates` or `projects` passes
 * the whole new value, the way a reducer would. `patchLayout` exists because
 * `layout` is the one field where partial updates are the normal case.
 */
export function patch(next: Partial<Settings>): void {
  current = { ...current, ...next };
  for (const fn of listeners) fn();
  schedule();
  void emit(CHANGED, { from: self, value: current } satisfies Change).catch(() => {});
}

export function patchLayout(next: Partial<Settings["layout"]>): void {
  patch({ layout: { ...current.layout, ...next } });
}

// ------------------------------------------------------------ other windows ---

/**
 * Settings and the template picker are windows of their own, each with its own
 * copy of this module. Every change is broadcast whole, and every other window
 * takes it as its snapshot -- so they never disagree, and a debounced write
 * from any of them saves the same document rather than a stale one.
 */
const CHANGED = "settings://changed";

interface Change {
  from: string;
  value: Settings;
}

const self = getCurrentWindow().label;

/**
 * Follow changes made in other windows. `onChange` runs after the snapshot is
 * replaced, for readers that keep a derived copy -- the shortcut keymap.
 *
 * Adopting does not schedule a write: the window that made the change is
 * already writing it.
 */
export function syncWithPeers(onChange: () => void): void {
  void listen<Change>(CHANGED, ({ payload }) => {
    if (payload.from === self) return;
    current = payload.value;
    for (const fn of listeners) fn();
    onChange();
  });
}

function schedule(): void {
  pending = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void flush(), WRITE_DEBOUNCE_MS);
}

/** Force any pending write out. Called on the way out of the page. */
export async function flush(): Promise<void> {
  window.clearTimeout(timer);
  if (!pending) return;
  pending = false;
  const snapshot = current;
  try {
    await settingsWrite(snapshot);
  } catch (e) {
    // Losing a window size is not worth interrupting anyone over, and the next
    // change will try again.
    console.error("could not save settings", e);
  }
}

/**
 * Load the document, once, before anything reads it.
 *
 * Never rejects. A settings file that cannot be read is a reason to start from
 * defaults, not a reason the app fails to open.
 */
export async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  let stored: unknown = null;
  try {
    stored = await settingsRead();
  } catch (e) {
    console.error("could not read settings; starting from defaults", e);
  }

  // Nothing on disk and something in the webview's store: this install predates
  // the move to ~/.aditor. Lift it, write it, and empty the old store -- but
  // only after the write lands, so a failure here loses nothing.
  const lifting = stored === null && hasLegacy();
  const raw = lifting ? readLegacy() : stored;

  const { value, changed } = normalize(raw);
  current = value;

  if (changed || lifting) {
    try {
      await settingsWrite(current);
      if (lifting) clearLegacy();
    } catch (e) {
      console.error("could not save settings", e);
    }
  }

  window.addEventListener("beforeunload", () => void flush());
}

// ------------------------------------------------------------- normalising ---

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Take whatever was on disk down to something that satisfies `Settings`.
 *
 * `settings.json` is a file people are invited to open, so every field is
 * checked rather than trusted. `changed` says whether the result differs from
 * what we read, which is what decides if hydration writes back.
 */
function normalize(raw: unknown): { value: Settings; changed: boolean } {
  const src = isObject(raw) ? raw : {};
  let changed = !isObject(raw);

  const layout = isObject(src.layout) ? src.layout : {};
  const value: Settings = {
    version: DEFAULTS.version,
    shortcuts: isObject(src.shortcuts) ? (src.shortcuts as Settings["shortcuts"]) : DEFAULTS.shortcuts,
    templates: templateList(src.templates),
    templatesSeed: typeof src.templatesSeed === "number" ? src.templatesSeed : -1,
    recents: Array.isArray(src.recents)
      ? (src.recents as Settings["recents"]).filter((r) => typeof r?.path === "string")
      : DEFAULTS.recents,
    projects: isObject(src.projects) ? (src.projects as Settings["projects"]) : DEFAULTS.projects,
    lastAgent: typeof src.lastAgent === "string" ? src.lastAgent : null,
    layout: {
      splitFraction:
        typeof layout.splitFraction === "number"
          ? layout.splitFraction
          : DEFAULTS.layout.splitFraction,
      railWidth:
        typeof layout.railWidth === "number"
          ? layout.railWidth
          : DEFAULTS.layout.railWidth,
      railTab:
        layout.railTab === "files" || layout.railTab === "git"
          ? layout.railTab
          : DEFAULTS.layout.railTab,
      insightOpen:
        typeof layout.insightOpen === "boolean"
          ? layout.insightOpen
          : DEFAULTS.layout.insightOpen,
      insightWidth:
        typeof layout.insightWidth === "number"
          ? layout.insightWidth
          : DEFAULTS.layout.insightWidth,
      diffLayout:
        layout.diffLayout === "split" || layout.diffLayout === "unified"
          ? layout.diffLayout
          : DEFAULTS.layout.diffLayout,
      diffDisplay:
        layout.diffDisplay === "pane" || layout.diffDisplay === "window"
          ? layout.diffDisplay
          : DEFAULTS.layout.diffDisplay,
      fileDisplay:
        layout.fileDisplay === "pane" || layout.fileDisplay === "window"
          ? layout.fileDisplay
          : DEFAULTS.layout.fileDisplay,
      sections: sectionState(layout.sections),
    },
    keyboardMode:
      src.keyboardMode === "standard" || src.keyboardMode === "vim"
        ? src.keyboardMode
        : DEFAULTS.keyboardMode,
    settingsTab:
      src.settingsTab === "general" ||
      src.settingsTab === "templates" ||
      src.settingsTab === "shortcuts"
        ? src.settingsTab
        : DEFAULTS.settingsTab,
  };

  // `app.shortcuts` became `app.settings` when the panel became a tab. Without
  // this the rebinding is dropped by `sane()` in shortcuts/store.ts and the
  // user silently loses it.
  const overrides = value.shortcuts as Record<string, string | null>;
  if ("app.shortcuts" in overrides) {
    if (!("app.settings" in overrides)) overrides["app.settings"] = overrides["app.shortcuts"];
    delete overrides["app.shortcuts"];
    changed = true;
  }

  // Fold in any built-in added since this document was last seeded. Templates
  // the user deleted stay deleted: only ids above the recorded seed are new.
  if (value.templatesSeed < TEMPLATE_SEED) {
    const known = new Set(value.templates.map((t) => t.id));
    const added = DEFAULT_TEMPLATES.filter((t) => !known.has(t.id));
    if (added.length > 0) value.templates = [...value.templates, ...added];
    value.templatesSeed = TEMPLATE_SEED;
    changed = true;
  }

  return { value, changed };
}

/**
 * Remembered open/closed state per panel band.
 *
 * Only booleans survive, and unknown ids are kept: a band renamed in a later
 * release leaves a stale key, which costs nothing, whereas dropping keys we do
 * not recognise would discard the state of any section not currently mounted.
 */
function sectionState(raw: unknown): Record<string, boolean> {
  if (!isObject(raw)) return { ...DEFAULTS.layout.sections };
  const out: Record<string, boolean> = {};
  for (const [id, open] of Object.entries(raw)) {
    if (typeof open === "boolean") out[id] = open;
  }
  return out;
}

function templateList(raw: unknown): PromptTemplate[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TEMPLATES];
  return raw
    .filter(
      (t): t is PromptTemplate =>
        isObject(t) &&
        typeof t.id === "string" &&
        typeof t.name === "string" &&
        typeof t.body === "string",
    )
    .map((t) => ({ id: t.id, name: t.name, body: t.body }));
}
