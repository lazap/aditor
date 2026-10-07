/**
 * What a theme is.
 *
 * One flat set of named colours for the chrome and every CodeMirror view --
 * each becomes a `--<token>` custom property on the document -- plus xterm's
 * palette, which paints to a canvas and so cannot read CSS. `kind` is the one
 * non-colour: it is what CodeMirror's base themes, the native title bar and
 * `color-scheme` need to know.
 *
 * A theme on disk is a file people are invited to write by hand, so
 * `normalizeTheme` treats it the way `settings/store.ts` treats settings.json:
 * as a suggestion. Anything missing or unreadable comes from the preset of the
 * same kind.
 */

export type ThemeKind = "light" | "dark";

interface TokenGroup {
  label: string;
  tokens: ReadonlyArray<readonly [token: string, label: string]>;
}

/** Every colour token, grouped and labelled for the theme editor. */
export const COLOR_GROUPS = [
  {
    label: "Interface",
    tokens: [
      ["bg", "Background"],
      ["bg-raised", "Raised background"],
      ["border", "Border"],
      ["fg", "Text"],
      ["fg-dim", "Dim text"],
      ["accent", "Accent"],
      ["danger", "Danger"],
      ["bg-hover", "Row under pointer"],
      ["bg-selected", "Selected row"],
      ["bg-cursor", "Keyboard cursor row"],
      ["bg-recent", "Recently touched row"],
      ["shadow", "Shadow"],
      ["overlay", "Overlay"],
      ["icon-dir", "Folder icon"],
    ],
  },
  {
    label: "Editor",
    tokens: [
      ["editor-bg", "Background"],
      ["caret", "Caret"],
      ["gutter-fg", "Gutter text"],
      ["active-line", "Active line"],
      ["selection", "Selection"],
      ["selection-focused", "Focused selection"],
      ["jump-line", "Jump target line"],
      ["search-match", "Search match"],
      ["vim-cursor", "Vim block cursor"],
      ["blame-tint", "Blame tint"],
    ],
  },
  {
    label: "Syntax",
    tokens: [
      ["syn-keyword", "Keyword"],
      ["syn-property", "Property"],
      ["syn-variable", "Variable"],
      ["syn-function", "Function"],
      ["syn-type", "Type"],
      ["syn-string", "String"],
      ["syn-number", "Number"],
      ["syn-punctuation", "Punctuation"],
      ["syn-comment", "Comment"],
      ["syn-meta", "Meta"],
      ["syn-heading", "Heading"],
      ["syn-link", "Link"],
    ],
  },
  {
    label: "Git",
    tokens: [
      ["st-modified", "Modified"],
      ["st-added", "Added"],
      ["st-deleted", "Deleted"],
      ["st-renamed", "Renamed"],
      ["st-conflicted", "Conflicted"],
      ["graph-0", "Graph lane 1"],
      ["graph-1", "Graph lane 2"],
      ["graph-2", "Graph lane 3"],
      ["graph-3", "Graph lane 4"],
      ["graph-4", "Graph lane 5"],
      ["graph-5", "Graph lane 6"],
      ["graph-6", "Graph lane 7"],
      ["graph-7", "Graph lane 8"],
    ],
  },
] as const satisfies ReadonlyArray<TokenGroup>;

export type ColorToken = (typeof COLOR_GROUPS)[number]["tokens"][number][0];

export const COLOR_TOKENS: readonly ColorToken[] = COLOR_GROUPS.flatMap((g) =>
  g.tokens.map(([t]) => t),
);

/** xterm's `ITheme`, the fields Aditor sets. */
export const TERMINAL_GROUP = {
  label: "Terminal",
  tokens: [
    ["background", "Background"],
    ["foreground", "Text"],
    ["cursor", "Cursor"],
    ["cursorAccent", "Cursor text"],
    ["selectionBackground", "Selection"],
    ["black", "Black"],
    ["red", "Red"],
    ["green", "Green"],
    ["yellow", "Yellow"],
    ["blue", "Blue"],
    ["magenta", "Magenta"],
    ["cyan", "Cyan"],
    ["white", "White"],
    ["brightBlack", "Bright black"],
    ["brightRed", "Bright red"],
    ["brightGreen", "Bright green"],
    ["brightYellow", "Bright yellow"],
    ["brightBlue", "Bright blue"],
    ["brightMagenta", "Bright magenta"],
    ["brightCyan", "Bright cyan"],
    ["brightWhite", "Bright white"],
  ],
} as const satisfies TokenGroup;

export type TerminalToken = (typeof TERMINAL_GROUP)["tokens"][number][0];

export const TERMINAL_TOKENS: readonly TerminalToken[] = TERMINAL_GROUP.tokens.map(([t]) => t);

export interface ThemeDef {
  /** The file stem in `~/.aditor/themes`; "dark" and "light" are the presets. */
  id: string;
  name: string;
  kind: ThemeKind;
  colors: Record<ColorToken, string>;
  terminal: Record<TerminalToken, string>;
  /**
   * Agents pick their own truecolour shades, chosen against a dark terminal.
   * xterm nudges any that fall below this contrast until they read.
   */
  terminalMinContrast: number;
}

/** The file's shape: everything but the id, which is its name. */
export type ThemeFile = Omit<ThemeDef, "id">;

export const defaultMinContrast = (kind: ThemeKind): number => (kind === "light" ? 4.5 : 1);

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;{}()]*\)$/i;

/**
 * A CSS colour, by the webview's own parser where there is one. The fallback
 * is for tests; it is stricter than CSS, never looser, and in particular never
 * lets through a `;` or a brace that could escape the custom property.
 */
export function isColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "" || v.length > 64) return false;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    return !/[;{}]/.test(v) && CSS.supports("color", v);
  }
  return HEX.test(v) || FUNC.test(v);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Take whatever was in a theme file down to a `ThemeDef`.
 *
 * `fallbackFor` supplies the preset of a kind; it is a parameter rather than
 * an import so presets.ts can itself be built from this module's types.
 */
export function normalizeTheme(
  raw: unknown,
  id: string,
  fallbackFor: (kind: ThemeKind) => ThemeDef,
): ThemeDef {
  const src = isObject(raw) ? raw : {};
  const kind: ThemeKind = src.kind === "light" ? "light" : "dark";
  const base = fallbackFor(kind);
  const colorsIn = isObject(src.colors) ? src.colors : {};
  const terminalIn = isObject(src.terminal) ? src.terminal : {};

  const colors = { ...base.colors };
  for (const t of COLOR_TOKENS) {
    const v = colorsIn[t];
    if (isColor(v)) colors[t] = v.trim();
  }
  const terminal = { ...base.terminal };
  for (const t of TERMINAL_TOKENS) {
    const v = terminalIn[t];
    if (isColor(v)) terminal[t] = v.trim();
  }
  const contrast = src.terminalMinContrast;

  return {
    id,
    name: typeof src.name === "string" && src.name.trim() !== "" ? src.name.trim() : id,
    kind,
    colors,
    terminal,
    terminalMinContrast:
      typeof contrast === "number" && contrast >= 1 && contrast <= 21
        ? contrast
        : defaultMinContrast(kind),
  };
}

/** What goes into a file: the def without its id. */
export function toFile(def: ThemeDef): ThemeFile {
  const { id: _id, ...rest } = def;
  return rest;
}

/** An id safe as a file stem; the backend checks the same rule. */
export const ID_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "theme" : slug;
}

/** A fresh id for `name`, never one of `taken`. */
export function uniqueId(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}
