import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ITheme } from "@xterm/xterm";
import { settings, subscribe } from "./settings/store";
import type { Appearance } from "./settings/schema";

/**
 * Light or dark, for the whole program.
 *
 * theme.css owns the palette: `:root` is dark, `:root[data-theme="light"]` is
 * the IntelliJ Light take, and the chrome and every CodeMirror view read those
 * tokens directly, so flipping the attribute is the whole switch for them.
 * This module decides which one applies and carries the few colours that
 * cannot be CSS variables -- xterm paints to a canvas and a native window is
 * coloured before any stylesheet loads. Keep those in step with theme.css.
 */
export type Theme = "light" | "dark";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function resolveTheme(appearance: Appearance): Theme {
  if (appearance === "system") return darkQuery.matches ? "dark" : "light";
  return appearance;
}

export const currentTheme = (): Theme => resolveTheme(settings().appearance);

const listeners = new Set<() => void>();
let applied: Theme | null = null;

/** Put the resolved theme on this window: the stylesheet and the title bar. */
export function applyTheme(): void {
  const theme = currentTheme();
  if (theme === applied) return;
  applied = theme;
  document.documentElement.dataset.theme = theme;
  // Pinning the native theme keeps the macOS title bar matching the page
  // rather than the OS, which only agree when appearance is "system".
  void getCurrentWindow()
    .setTheme(theme)
    .catch(() => {});
  for (const fn of listeners) fn();
}

/**
 * Follow the setting -- including a change made in the Settings window, which
 * reaches this window's store through `syncWithPeers` -- and, for "system",
 * the OS appearance. Once per window, before React mounts.
 */
export function watchTheme(): void {
  applyTheme();
  subscribe(applyTheme);
  darkQuery.addEventListener("change", applyTheme);
}

function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The resolved theme, for components that hold colours outside CSS. */
export const useTheme = (): Theme =>
  useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);

/** `--bg` in each palette, so a new window does not open in the wrong one. */
export const windowBackground = (): string =>
  currentTheme() === "light" ? "#ffffff" : "#14161a";

export const terminalThemes: Record<Theme, ITheme> = {
  dark: {
    background: "#14161a",
    foreground: "#d7dae0",
    cursor: "#7aa2f7",
    cursorAccent: "#14161a",
    selectionBackground: "#2d3343",
    black: "#14161a",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#c0caf5",
    brightBlack: "#565f89",
    brightRed: "#ff899d",
    brightGreen: "#b9f27c",
    brightYellow: "#ffc777",
    brightBlue: "#8db0ff",
    brightMagenta: "#caa9fa",
    brightCyan: "#b4f9f8",
    brightWhite: "#eaeefb",
  },
  // IntelliJ Light's console colours. "white" and "brightWhite" are greys:
  // CLIs print secondary text in them, and real white vanishes on a white pane.
  light: {
    background: "#ffffff",
    foreground: "#080808",
    cursor: "#000000",
    cursorAccent: "#ffffff",
    selectionBackground: "#a6d2ff",
    black: "#000000",
    red: "#c7222d",
    green: "#067d17",
    yellow: "#9e880d",
    blue: "#0033b3",
    magenta: "#871094",
    cyan: "#00627a",
    white: "#6c707e",
    brightBlack: "#8c8c8c",
    brightRed: "#e55765",
    brightGreen: "#208a3c",
    brightYellow: "#c7a20e",
    brightBlue: "#3574f0",
    brightMagenta: "#a23bbf",
    brightCyan: "#0b8297",
    brightWhite: "#494b57",
  },
};

/**
 * Agents pick their own truecolour shades, chosen against a dark terminal.
 * On white, xterm nudges any that fall below this contrast until they read.
 */
export const terminalMinContrast = (theme: Theme): number => (theme === "light" ? 4.5 : 1);
