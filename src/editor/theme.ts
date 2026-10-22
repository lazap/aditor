import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * CodeMirror theme drawn from the theme tokens rather than pulling in
 * one-dark. Three panes sharing one window should look like one program, and
 * because every colour here is a `var(--…)`, `applyTheme` setting the tokens
 * on the document repaints a live view without rebuilding it.
 */
export const aditorEditorTheme = EditorView.theme({
  "&": { color: "var(--fg)", backgroundColor: "var(--editor-bg)", height: "100%" },
  ".cm-content": {
    caretColor: "var(--caret)",
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace',
    fontSize: "13px",
  },
  ".cm-scroller": { lineHeight: "1.5", overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--gutter-fg)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--fg-dim)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--selection)" },
  "&.cm-focused .cm-selectionBackground": { backgroundColor: "var(--selection-focused)" },
  ".cm-cursor": { borderLeftColor: "var(--caret)" },
});

/**
 * The one thing CSS cannot carry: CodeMirror's own base themes -- the merge
 * view's inserted and deleted lines among them -- pick their colours from this
 * facet. Reconfigure it when the theme's kind changes.
 */
export const darkMode = new Compartment();
export const darkModeFor = (theme: "light" | "dark") => EditorView.darkTheme.of(theme === "dark");

/** Also used outside an editor, for code blocks in the markdown preview. */
export const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.name, t.deleted, t.character], color: "var(--fg)" },
  { tag: [t.propertyName], color: "var(--syn-property)" },
  { tag: [t.variableName], color: "var(--syn-variable)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.operator, t.punctuation], color: "var(--syn-punctuation)" },
  { tag: [t.comment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.meta, t.processingInstruction], color: "var(--syn-meta)" },
  { tag: t.heading, color: "var(--syn-heading)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--syn-link)", textDecoration: "underline" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.invalid, color: "var(--danger)" },
]);

export const aditorHighlighting = syntaxHighlighting(highlight);
