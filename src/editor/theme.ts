import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * CodeMirror theme built from the same palette as theme.css and the xterm
 * config in TerminalPane, rather than pulling in one-dark. Three panes sharing
 * one window should look like one program; keep these values in step.
 */
const bg = "#14161a";
const bgRaised = "#1a1d23";
const fg = "#d7dae0";
const fgDim = "#7c8495";
const border = "#262a33";
const accent = "#7aa2f7";

export const aditorEditorTheme = EditorView.theme(
  {
    "&": { color: fg, backgroundColor: bg, height: "100%" },
    ".cm-content": {
      caretColor: accent,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace',
      fontSize: "13px",
    },
    ".cm-scroller": { lineHeight: "1.5", overflow: "auto" },
    ".cm-gutters": {
      backgroundColor: bg,
      color: "#4a5163",
      border: "none",
      borderRight: `1px solid ${border}`,
    },
    ".cm-activeLine": { backgroundColor: bgRaised },
    ".cm-activeLineGutter": { backgroundColor: bgRaised, color: fgDim },
    ".cm-selectionBackground, ::selection": { backgroundColor: "#2d3343" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#33405c" },
    ".cm-cursor": { borderLeftColor: accent },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#bb9af7" },
  { tag: [t.name, t.deleted, t.character, t.propertyName], color: fg },
  { tag: [t.variableName], color: "#c0caf5" },
  { tag: [t.function(t.variableName), t.labelName], color: accent },
  { tag: [t.typeName, t.className, t.namespace], color: "#7dcfff" },
  { tag: [t.string, t.special(t.string)], color: "#9ece6a" },
  { tag: [t.number, t.bool, t.null], color: "#ff9e64" },
  { tag: [t.operator, t.punctuation], color: fgDim },
  { tag: [t.comment, t.blockComment], color: "#565f89", fontStyle: "italic" },
  { tag: [t.meta, t.processingInstruction], color: "#e0af68" },
  { tag: t.heading, color: accent, fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#7dcfff", textDecoration: "underline" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.invalid, color: "#f7768e" },
]);

export const aditorHighlighting = syntaxHighlighting(highlight);
