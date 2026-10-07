import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ITheme } from "@xterm/xterm";
import { settings, subscribe } from "./settings/store";
import type { Settings } from "./settings/schema";
import { COLOR_TOKENS, type ThemeDef, type ThemeKind } from "./theme/model";
import { presetFor } from "./theme/presets";
import { findTheme, subscribeThemes } from "./theme/store";

/**
 * The active theme, for the whole program.
 *
 * Every colour token goes onto the document as a `--<token>` custom property,
 * and the chrome and every CodeMirror view read those, so setting them is the
 * whole switch for them. `data-theme` and `color-scheme` carry the theme's
 * kind for what only cares about light versus dark -- CodeMirror's base themes,
 * the native title bar. xterm paints to a canvas and reads the def directly.
 */
export type Theme = ThemeKind;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** The theme `s` selects, falling back to the preset of the kind it wanted. */
export function resolveThemeDef(s: Settings, osDark: boolean): ThemeDef {
  if (s.appearance === "system") {
    return osDark
      ? (findTheme(s.systemDark) ?? presetFor("dark"))
      : (findTheme(s.systemLight) ?? presetFor("light"));
  }
  return findTheme(s.theme) ?? presetFor("dark");
}

export const currentThemeDef = (): ThemeDef => resolveThemeDef(settings(), darkQuery.matches);

export const currentTheme = (): Theme => currentThemeDef().kind;

const listeners = new Set<() => void>();
let applied: ThemeDef | null = null;
let appliedKind: Theme | null = null;

/** Put the resolved theme on this window: the stylesheet and the title bar. */
export function applyTheme(): void {
  const def = currentThemeDef();
  if (def === applied) return;
  applied = def;
  const root = document.documentElement;
  for (const token of COLOR_TOKENS) root.style.setProperty(`--${token}`, def.colors[token]);
  root.style.colorScheme = def.kind;
  root.dataset.theme = def.kind;
  if (def.kind !== appliedKind) {
    appliedKind = def.kind;
    // Pinning the native theme keeps the macOS title bar matching the page
    // rather than the OS, which only agree when appearance is "system".
    void getCurrentWindow()
      .setTheme(def.kind)
      .catch(() => {});
  }
  for (const fn of listeners) fn();
}

/**
 * Follow the setting -- including a change made in the Settings window, which
 * reaches this window's store through `syncWithPeers` -- the themes themselves
 * as they are edited, and, for "system", the OS appearance. Once per window,
 * after the themes are loaded and before React mounts.
 */
export function watchTheme(): void {
  applyTheme();
  subscribe(applyTheme);
  subscribeThemes(applyTheme);
  darkQuery.addEventListener("change", applyTheme);
}

function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The resolved theme's kind, for what only needs light or dark. */
export const useTheme = (): Theme =>
  useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);

/** The resolved theme, for components that hold colours outside CSS. */
export const useThemeDef = (): ThemeDef =>
  useSyncExternalStore(subscribeTheme, currentThemeDef, currentThemeDef);

/**
 * `--bg`, so a new window does not open in the wrong colour. Tauri takes only
 * hex here; a theme whose background is some other CSS colour gets its
 * preset's instead, which is at least the right kind.
 */
export function windowBackground(): string {
  const def = currentThemeDef();
  const bg = def.colors.bg;
  return /^#[0-9a-f]{6}$/i.test(bg) ? bg : presetFor(def.kind).colors.bg;
}

/** xterm's options for a theme. */
export const terminalOptions = (def: ThemeDef): { theme: ITheme; minimumContrastRatio: number } => ({
  theme: def.terminal,
  minimumContrastRatio: def.terminalMinContrast,
});
