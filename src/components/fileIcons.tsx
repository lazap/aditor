/**
 * File-type icons for the tree.
 *
 * Hand-drawn 16x16 SVG rather than an icon package: the app has no icon
 * dependency and a file tree needs about a dozen shapes recoloured many ways,
 * which is a table rather than a library.
 *
 * Two layers of coverage, because bespoke logos do not survive 14px:
 *
 *   - a *shape* glyph carries the kind of file -- braces for config, a picture
 *     for images, a prompt for scripts, a padlock for lockfiles;
 *   - a *lettered badge* carries languages, where the letters plus the brand
 *     colour identify it far more reliably than a shrunken mascot would.
 *
 * Colour is what actually makes the rail scannable, so it lives here beside the
 * glyph it belongs to instead of in theme.css. These are per-language data, not
 * theme: they are meaningless without their glyph, they have exactly one
 * consumer, and they are deliberately outside the palette that theme.css,
 * editor/theme.ts and TerminalPane must keep in step (that one is about the
 * editor surface -- background, foreground, accent, selection). Directory and
 * fallback colours are the exception and do read theme tokens, because those
 * ones really are theme.
 */

import { memo, type ReactNode } from "react";
import { languageName } from "../editor/language";

export type GlyphId =
  | "folder"
  | "folderOpen"
  | "code"
  | "braces"
  | "markup"
  | "style"
  | "doc"
  | "image"
  | "archive"
  | "lock"
  | "terminal"
  | "gear"
  | "database"
  | "font";

export type IconSpec =
  | { kind: "glyph"; id: GlyphId; color: string }
  | { kind: "badge"; text: string; color: string };

/* ---- glyphs ----------------------------------------------------------- */

// Knocked-out details paint in --bg rather than transparent: these sit on the
// row background, which changes on hover/selection, and a real hole would show
// the wrong colour through.
const KNOCKOUT = "var(--bg)";

const GLYPHS: Record<GlyphId, ReactNode> = {
  folder: (
    <path
      fill="currentColor"
      d="M1.5 4.2c0-.94.76-1.7 1.7-1.7h2.93c.45 0 .88.18 1.2.5l1 1h4.47c.94 0 1.7.76 1.7 1.7v6.4c0 .94-.76 1.7-1.7 1.7H3.2c-.94 0-1.7-.76-1.7-1.7z"
    />
  ),
  folderOpen: (
    <>
      <path
        fill="currentColor"
        d="M1.5 4.2c0-.94.76-1.7 1.7-1.7h2.93c.45 0 .88.18 1.2.5l1 1h4.47c.94 0 1.7.76 1.7 1.7v1.2H1.5z"
      />
      <path
        fill="currentColor"
        opacity=".6"
        d="M1.5 7.3h12.9c.63 0 1.06.63.83 1.21l-1.6 4.06c-.26.65-.89 1.08-1.59 1.08H3.2c-.94 0-1.7-.76-1.7-1.7z"
      />
    </>
  ),
  doc: (
    <>
      <path
        fill="currentColor"
        d="M3.8 2.2c0-.39.31-.7.7-.7h4.6L13 5.4v8.4c0 .39-.31.7-.7.7H4.5c-.39 0-.7-.31-.7-.7z"
      />
      <path fill={KNOCKOUT} opacity=".5" d="M9.1 1.5 13 5.4H9.8a.7.7 0 0 1-.7-.7z" />
    </>
  ),
  code: (
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M5.8 4.6 2.4 8l3.4 3.4M10.2 4.6 13.6 8l-3.4 3.4"
    />
  ),
  markup: (
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M5.5 4 2.2 8l3.3 4M10.5 4 13.8 8l-3.3 4M9.2 3.1 6.8 12.9"
    />
  ),
  braces: (
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      d="M6.4 2.8c-1.5 0-1.2 4.1-2.9 5.2 1.7 1.1 1.4 5.2 2.9 5.2M9.6 2.8c1.5 0 1.2 4.1 2.9 5.2-1.7 1.1-1.4 5.2-2.9 5.2"
    />
  ),
  style: (
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      d="M6.4 2.6 5.1 13.4M11.2 2.6 9.9 13.4M2.9 5.9h10.4M2.3 10.1h10.4"
    />
  ),
  image: (
    <>
      <path
        fill="currentColor"
        d="M2 3.6c0-.61.5-1.1 1.1-1.1h9.8c.61 0 1.1.49 1.1 1.1v8.8c0 .61-.49 1.1-1.1 1.1H3.1c-.6 0-1.1-.49-1.1-1.1z"
      />
      <circle cx="5.8" cy="6.1" r="1.3" fill={KNOCKOUT} />
      <path
        fill={KNOCKOUT}
        opacity=".55"
        d="M2 12.1 6.3 8.3l2.3 2.2 2.4-2.5 3 3.2v.7c0 .61-.49 1.1-1.1 1.1H3.1c-.6 0-1.1-.49-1.1-1.1z"
      />
    </>
  ),
  archive: (
    <>
      <path
        fill="currentColor"
        d="M2.2 4.3c0-.5.4-.9.9-.9h9.8c.5 0 .9.4.9.9v1.6c0 .5-.4.9-.9.9H3.1c-.5 0-.9-.4-.9-.9z"
      />
      <path
        fill="currentColor"
        d="M3.2 8.1h9.6v4.5c0 .61-.49 1.1-1.1 1.1H4.3c-.61 0-1.1-.49-1.1-1.1z"
      />
      <path fill={KNOCKOUT} d="M6.7 9.6h2.6v1.5H6.7z" />
    </>
  ),
  lock: (
    <>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        d="M5.5 7.2V5.7a2.5 2.5 0 0 1 5 0v1.5"
      />
      <path
        fill="currentColor"
        d="M3.6 8.1c0-.5.4-.9.9-.9h7c.5 0 .9.4.9.9v4.9c0 .5-.4.9-.9.9h-7c-.5 0-.9-.4-.9-.9z"
      />
    </>
  ),
  terminal: (
    <>
      <path
        fill="currentColor"
        d="M2 4.1c0-.72.58-1.3 1.3-1.3h9.4c.72 0 1.3.58 1.3 1.3v7.8c0 .72-.58 1.3-1.3 1.3H3.3c-.72 0-1.3-.58-1.3-1.3z"
      />
      <path
        fill="none"
        stroke={KNOCKOUT}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4.7 6.3 6.5 8l-1.8 1.7M8.3 10h3"
      />
    </>
  ),
  gear: (
    <>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M2.6 4.6h10.8M2.6 8h10.8M2.6 11.4h10.8"
      />
      <circle cx="6" cy="4.6" r="1.7" fill="currentColor" stroke={KNOCKOUT} strokeWidth="1" />
      <circle cx="10.4" cy="8" r="1.7" fill="currentColor" stroke={KNOCKOUT} strokeWidth="1" />
      <circle cx="5.2" cy="11.4" r="1.7" fill="currentColor" stroke={KNOCKOUT} strokeWidth="1" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="4.3" rx="5.3" ry="2.1" fill="currentColor" />
      <path
        fill="currentColor"
        d="M2.7 6.8c0 1.16 2.37 2.1 5.3 2.1s5.3-.94 5.3-2.1v4.9c0 1.16-2.37 2.1-5.3 2.1s-5.3-.94-5.3-2.1z"
      />
      <path
        fill={KNOCKOUT}
        opacity=".45"
        d="M2.7 9.4c0 1.16 2.37 2.1 5.3 2.1s5.3-.94 5.3-2.1v.85c0 1.16-2.37 2.1-5.3 2.1s-5.3-.94-5.3-2.1z"
      />
    </>
  ),
  font: (
    <text
      x="8"
      y="12.4"
      textAnchor="middle"
      fontSize="12"
      fontWeight="700"
      fill="currentColor"
      fontFamily="Georgia, 'Times New Roman', serif"
    >
      A
    </text>
  ),
};

/* ---- colours ---------------------------------------------------------- */

// Hues are picked for legibility on --bg (#14161a): a few real brand colours
// are too dark to read at 14px on near-black and are lifted toward their
// brighter variant rather than reproduced exactly.
const DIR = "var(--icon-dir)";
const NEUTRAL = "var(--fg-dim)";

const C = {
  ts: "#3178c6",
  react: "#61dafb",
  js: "#f1e05a",
  rust: "#dea584",
  py: "#4b8bbe",
  go: "#00add8",
  rb: "#e0524a",
  java: "#b07219",
  cfam: "#a8b9cc",
  cpp: "#5c9fd8",
  cs: "#9b4f96",
  php: "#8993be",
  swift: "#f05138",
  kotlin: "#a97bff",
  css: "#2f9fd8",
  scss: "#c6538c",
  html: "#e34c26",
  xml: "#e37933",
  json: "#cbcb41",
  yaml: "#cb4b16",
  toml: "#c4623a",
  md: "#519aba",
  shell: "#89e051",
  sql: "#e38c00",
  image: "#a074c4",
  svg: "#ffb13b",
  font: "#b48ead",
  archive: "#ff9e64",
  pdf: "#f7768e",
  lock: "#7c8495",
  test: "#9ece6a",
  git: "#f05133",
  vite: "#646cff",
  npm: "#cb3837",
  docker: "#2496ed",
  vue: "#42b883",
  svelte: "#ff3e00",
  astro: "#ff5d01",
  graphql: "#e10098",
} as const;

const glyph = (id: GlyphId, color: string): IconSpec => ({ kind: "glyph", id, color });
const badge = (text: string, color: string): IconSpec => ({ kind: "badge", text, color });

/* ---- tables ----------------------------------------------------------- */

/** Whole filename, lower-cased. Beats any extension rule. */
const BY_NAME: Record<string, IconSpec> = {
  dockerfile: glyph("gear", C.docker),
  ".dockerignore": glyph("gear", C.docker),
  makefile: glyph("terminal", "#6d8086"),
  "cargo.toml": badge("RS", C.rust),
  "cargo.lock": glyph("lock", C.rust),
  "package.json": glyph("braces", C.npm),
  "package-lock.json": glyph("lock", C.npm),
  "tsconfig.json": glyph("gear", C.ts),
  "tsconfig.node.json": glyph("gear", C.ts),
  "vite.config.ts": glyph("gear", C.vite),
  "vite.config.js": glyph("gear", C.vite),
  "tauri.conf.json": glyph("gear", "#ffc131"),
  ".gitignore": glyph("gear", C.git),
  ".gitattributes": glyph("gear", C.git),
  ".gitmodules": glyph("gear", C.git),
  ".env": glyph("gear", "#e0af68"),
  ".npmrc": glyph("gear", C.npm),
  ".nvmrc": glyph("gear", "#5fa04e"),
  ".node-version": glyph("gear", "#5fa04e"),
  ".prettierrc": glyph("gear", "#f7b93e"),
  ".editorconfig": glyph("gear", NEUTRAL),
  license: glyph("doc", C.json),
  "license.md": glyph("doc", C.json),
  licence: glyph("doc", C.json),
  "readme.md": glyph("doc", C.md),
};

/**
 * Compound suffixes, longest first -- `.d.ts` and `.test.tsx` must win over the
 * plain `.ts`/`.tsx` rules they end with.
 */
const BY_SUFFIX: Array<[string, IconSpec]> = [
  [".test.tsx", badge("TS", C.test)],
  [".spec.tsx", badge("TS", C.test)],
  [".test.ts", badge("TS", C.test)],
  [".spec.ts", badge("TS", C.test)],
  [".test.jsx", badge("JS", C.test)],
  [".spec.jsx", badge("JS", C.test)],
  [".test.js", badge("JS", C.test)],
  [".spec.js", badge("JS", C.test)],
  [".stories.tsx", badge("SB", "#ff4785")],
  [".module.css", glyph("style", C.scss)],
  // Declarations are TypeScript, but not code you edit -- a dimmer blue.
  [".d.ts", badge("TS", "#2c5d8f")],
  [".min.js", badge("JS", C.lock)],
  ["-lock.json", glyph("lock", C.lock)],
  [".lock", glyph("lock", C.lock)],
  [".tar.gz", glyph("archive", C.archive)],
  [".tar.bz2", glyph("archive", C.archive)],
  [".tar.xz", glyph("archive", C.archive)],
];

/** Final extension, lower-cased, without the dot. */
const BY_EXT: Record<string, IconSpec> = {
  ts: badge("TS", C.ts),
  mts: badge("TS", C.ts),
  cts: badge("TS", C.ts),
  // tsx/jsx take React's cyan: the letters say which language, the colour says
  // it is a component.
  tsx: badge("TS", C.react),
  jsx: badge("JS", C.react),
  js: badge("JS", C.js),
  mjs: badge("JS", C.js),
  cjs: badge("JS", C.js),
  rs: badge("RS", C.rust),
  py: badge("PY", C.py),
  pyi: badge("PY", C.py),
  go: badge("GO", C.go),
  rb: badge("RB", C.rb),
  java: badge("JV", C.java),
  kt: badge("KT", C.kotlin),
  kts: badge("KT", C.kotlin),
  swift: badge("SW", C.swift),
  c: badge("C", C.cfam),
  h: badge("H", C.cfam),
  cpp: badge("C++", C.cpp),
  cc: badge("C++", C.cpp),
  cxx: badge("C++", C.cpp),
  hpp: badge("H++", C.cpp),
  cs: badge("C#", C.cs),
  php: badge("PHP", C.php),
  lua: badge("LU", "#5b8ee6"),
  dart: badge("DA", "#00b4ab"),
  // Not in @codemirror/language-data, so these would fall through to the
  // generic page without an entry of their own.
  ex: badge("EX", "#a06ec7"),
  exs: badge("EX", "#a06ec7"),
  zig: badge("ZG", "#f7a41d"),
  nim: badge("NM", "#ffe953"),
  sol: badge("SO", "#8f96b3"),
  hcl: badge("HC", "#7b42bc"),
  wasm: badge("WA", "#654ff0"),
  wat: badge("WA", "#654ff0"),
  ipynb: badge("NB", "#f37726"),
  tf: badge("TF", "#7b42bc"),

  sh: glyph("terminal", C.shell),
  bash: glyph("terminal", C.shell),
  zsh: glyph("terminal", C.shell),
  fish: glyph("terminal", C.shell),
  ps1: glyph("terminal", "#5391fe"),

  css: glyph("style", C.css),
  scss: glyph("style", C.scss),
  sass: glyph("style", C.scss),
  less: glyph("style", "#6f8ec6"),

  html: glyph("markup", C.html),
  htm: glyph("markup", C.html),
  xml: glyph("markup", C.xml),
  xsl: glyph("markup", C.xml),
  plist: glyph("markup", C.xml),
  vue: glyph("markup", C.vue),
  svelte: glyph("markup", C.svelte),
  astro: glyph("markup", C.astro),

  json: glyph("braces", C.json),
  jsonc: glyph("braces", C.json),
  json5: glyph("braces", C.json),
  yaml: glyph("braces", C.yaml),
  yml: glyph("braces", C.yaml),
  toml: glyph("braces", C.toml),
  proto: glyph("braces", C.php),
  graphql: glyph("braces", C.graphql),
  gql: glyph("braces", C.graphql),
  ini: glyph("gear", NEUTRAL),
  cfg: glyph("gear", NEUTRAL),
  conf: glyph("gear", NEUTRAL),
  properties: glyph("gear", NEUTRAL),

  md: glyph("doc", C.md),
  mdx: glyph("doc", C.md),
  markdown: glyph("doc", C.md),
  rst: glyph("doc", C.md),
  txt: glyph("doc", "#9aa3b2"),
  log: glyph("doc", "#9aa3b2"),
  pdf: glyph("doc", C.pdf),

  sql: glyph("database", C.sql),
  db: glyph("database", C.sql),
  sqlite: glyph("database", C.sql),
  sqlite3: glyph("database", C.sql),
  csv: glyph("database", C.test),
  tsv: glyph("database", C.test),

  png: glyph("image", C.image),
  jpg: glyph("image", C.image),
  jpeg: glyph("image", C.image),
  gif: glyph("image", C.image),
  webp: glyph("image", C.image),
  avif: glyph("image", C.image),
  bmp: glyph("image", C.image),
  ico: glyph("image", C.image),
  icns: glyph("image", C.image),
  svg: glyph("image", C.svg),

  woff: glyph("font", C.font),
  woff2: glyph("font", C.font),
  ttf: glyph("font", C.font),
  otf: glyph("font", C.font),
  eot: glyph("font", C.font),

  zip: glyph("archive", C.archive),
  tar: glyph("archive", C.archive),
  gz: glyph("archive", C.archive),
  tgz: glyph("archive", C.archive),
  bz2: glyph("archive", C.archive),
  xz: glyph("archive", C.archive),
  "7z": glyph("archive", C.archive),
  rar: glyph("archive", C.archive),
};

/**
 * A few of CodeMirror's languages worth a colour of their own. Everything else
 * it recognises still gets a badge, just a neutral one -- see `iconFor`.
 */
const BY_LANGUAGE: Record<string, IconSpec> = {
  Haskell: badge("HS", "#b57edc"),
  Erlang: badge("ER", "#c9479e"),
  Clojure: badge("CL", "#5881d8"),
  Scala: badge("SC", "#e04b47"),
  Elm: badge("EL", "#60b5cc"),
  OCaml: badge("ML", "#ee6a1a"),
  Julia: badge("JL", "#a97bff"),
  R: badge("R", "#4f9ae0"),
  Perl: badge("PL", "#3ea7c9"),
  Groovy: badge("GR", "#4298b8"),
  Fortran: badge("FT", "#7a6ff0"),
  Verilog: badge("V", "#b2b7f8"),
  VHDL: badge("VH", "#adb2cb"),
  Tcl: badge("TC", "#e4cc98"),
  Scheme: badge("SM", "#6a8fec"),
  "Common Lisp": badge("LI", "#3fb68b"),
  Pascal: badge("PA", "#dbe07a"),
  Smalltalk: badge("ST", "#8fa04f"),
  "Objective-C": badge("OC", "#438eff"),
  "Objective-C++": badge("OC", "#438eff"),
  ClojureScript: badge("CS", "#5881d8"),
  Crystal: badge("CR", "#c8c8c8"),
  Haxe: badge("HX", "#df7900"),
  "F#": badge("F#", "#5d92c0"),
  Cobol: badge("CB", "#d4be98"),
  SystemVerilog: badge("SV", "#b2b7f8"),
};

/* ---- resolution ------------------------------------------------------- */

const FALLBACK = glyph("doc", NEUTRAL);

/**
 * Pick an icon for one entry. Cheap enough to call per row: the name rules are
 * single map lookups, the suffix list is short, and the language fallback never
 * loads a CodeMirror parser.
 */
export function iconFor(name: string, isDir: boolean, open: boolean): IconSpec {
  if (isDir) return glyph(open ? "folderOpen" : "folder", DIR);

  const lower = name.toLowerCase();

  const byName = BY_NAME[lower];
  if (byName) return byName;

  for (const [suffix, spec] of BY_SUFFIX) {
    if (lower.endsWith(suffix)) return spec;
  }

  const dot = lower.lastIndexOf(".");
  // A leading dot is the whole name of a dotfile, not an extension separator.
  if (dot > 0) {
    const byExt = BY_EXT[lower.slice(dot + 1)];
    if (byExt) return byExt;
  }

  const lang = languageName(name);
  if (lang) {
    return (
      BY_LANGUAGE[lang] ??
      // Two letters of the language's own name beats a generic page.
      badge(lang.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase(), NEUTRAL)
    );
  }

  // Unknown dotfiles are nearly always configuration.
  if (lower.startsWith(".")) return glyph("gear", NEUTRAL);

  return FALLBACK;
}

/* ---- rendering -------------------------------------------------------- */

function Badge({ text }: { text: string }) {
  return (
    <>
      <rect x="1" y="2.5" width="14" height="11" rx="2.5" fill="currentColor" />
      <text
        x="8"
        y="10.6"
        textAnchor="middle"
        // Three-letter badges (C++, PHP) need to give back some size to fit.
        fontSize={text.length >= 3 ? 5.2 : 6.9}
        fontWeight="700"
        fill={KNOCKOUT}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        {text}
      </text>
    </>
  );
}

/**
 * The icon column of a tree row. Decorative: the filename beside it already
 * says everything this conveys, so it is hidden from assistive tech.
 */
export const FileIcon = memo(function FileIcon({
  name,
  isDir,
  open,
}: {
  name: string;
  isDir: boolean;
  open: boolean;
}) {
  const spec = iconFor(name, isDir, open);
  return (
    <svg
      className="tree-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden
      style={{ color: spec.color }}
    >
      {spec.kind === "badge" ? <Badge text={spec.text} /> : GLYPHS[spec.id]}
    </svg>
  );
});
