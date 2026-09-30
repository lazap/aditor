import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/**
 * Mark the line a terminal link pointed at. The viewer is read-only and the
 * caret usually lives in the terminal, so scrolling alone leaves no sign of
 * which line was meant; this keeps it tinted until the next jump.
 */
const setJumpLine = StateEffect.define<number>();

const jumpLineMark = Decoration.line({ class: "cm-jump-line" });

const jumpLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects) {
      if (e.is(setJumpLine)) return Decoration.set(jumpLineMark.range(e.value));
    }
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const jumpLine = [
  jumpLineField,
  EditorView.theme({ ".cm-jump-line": { backgroundColor: "#243049" } }),
];

/** Put the caret on 1-based `line` (clamped), centre it, and tint it. */
export function jumpToLine(view: EditorView, line: number): void {
  const doc = view.state.doc;
  const target = doc.line(Math.min(Math.max(1, line), doc.lines));
  view.dispatch({
    selection: { anchor: target.from },
    effects: [
      setJumpLine.of(target.from),
      EditorView.scrollIntoView(target.from, { y: "center" }),
    ],
  });
}
