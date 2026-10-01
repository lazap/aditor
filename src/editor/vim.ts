/**
 * Vim-style motions for the read-only viewers.
 *
 * Motions and `/` search only -- there is nothing to edit, so no modes,
 * operators or counts.
 * A keymap rather than a window listener: it fires only while an editor has
 * focus, so bare letters can never reach it from the terminal or the commit
 * box. Lives in a compartment so the setting can flip it on an open view
 * without rebuilding it and losing the scroll position.
 */
import {
  Compartment,
  EditorSelection,
  findClusterBreak,
  Prec,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  layer,
  RectangleMarker,
  type Command,
  type KeyBinding,
} from "@codemirror/view";
import {
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupBackward,
  cursorGroupForward,
  cursorLineBoundaryBackward,
  cursorLineDown,
  cursorLineEnd,
  cursorLineUp,
  cursorPageDown,
  cursorPageUp,
} from "@codemirror/commands";
import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { searchBindings, vimSearch } from "./vimSearch";

export const vimMode = new Compartment();

/** Ctrl-d / Ctrl-u: half a screen, with the cursor kept mid-view. */
const halfPage =
  (forward: boolean): Command =>
  (view) => {
    const distance = view.scrollDOM.clientHeight / 2;
    const selection = EditorSelection.create(
      view.state.selection.ranges.map((r) => view.moveVertically(r, forward, distance)),
    );
    view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(selection.main.head, { y: "center" }),
      userEvent: "select",
    });
    return true;
  };

// Ctrl-, not Mod-: ⌘D and ⌘U belong to the app.
const bindings: KeyBinding[] = [
  { key: "j", run: cursorLineDown },
  { key: "k", run: cursorLineUp },
  { key: "h", run: cursorCharLeft },
  { key: "l", run: cursorCharRight },
  { key: "w", run: cursorGroupForward },
  { key: "b", run: cursorGroupBackward },
  { key: "0", run: cursorLineBoundaryBackward },
  { key: "$", run: cursorLineEnd },
  { key: "g g", run: cursorDocStart },
  { key: "G", run: cursorDocEnd },
  { key: "Ctrl-d", run: halfPage(true) },
  { key: "Ctrl-u", run: halfPage(false) },
  { key: "Ctrl-f", run: cursorPageDown },
  { key: "Ctrl-b", run: cursorPageUp },
  { key: "] c", run: goToNextChunk },
  { key: "[ c", run: goToPreviousChunk },
  ...searchBindings,
];

/**
 * Vim's block cursor: the character under the caret, highlighted.
 *
 * Drawn under the text so the character stays readable. At the end of a line
 * there is no character to cover, so the block takes one character's width.
 */
const blockCursor = layer({
  above: false,
  class: "cm-vim-cursor-layer",
  update: (u) => u.docChanged || u.selectionSet || u.focusChanged || u.geometryChanged,
  markers(view) {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    if (head < line.to) {
      const next = line.from + findClusterBreak(line.text, head - line.from);
      return RectangleMarker.forRange(view, "cm-vim-cursor", EditorSelection.range(head, next));
    }
    const at = view.coordsAtPos(head, 1);
    if (!at) return [];
    // Document-relative, the way `RectangleMarker.forRange` measures.
    const box = view.scrollDOM.getBoundingClientRect();
    const left = box.left - view.scrollDOM.scrollLeft * view.scaleX;
    const top = box.top - view.scrollDOM.scrollTop * view.scaleY;
    return [
      new RectangleMarker(
        "cm-vim-cursor",
        (at.left - left) / view.scaleX,
        (at.top - top) / view.scaleY,
        view.defaultCharacterWidth,
        (at.bottom - at.top) / view.scaleY,
      ),
    ];
  },
});

const blockCursorTheme = EditorView.theme({
  // Specific enough to beat the caret colour in aditorEditorTheme.
  "&.cm-editor .cm-content": { caretColor: "transparent" },
  ".cm-vim-cursor": { outline: "1px solid var(--caret)", outlineOffset: "-1px" },
  "&.cm-focused .cm-vim-cursor": { backgroundColor: "var(--vim-cursor)" },
});

export function vimMotions(on: boolean): Extension {
  return on ? [Prec.high(keymap.of(bindings)), vimSearch, blockCursor, blockCursorTheme] : [];
}
