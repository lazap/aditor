import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { UNCOMMITTED, type BlameHunk } from "../git/api";
import { fullDate, shortDate } from "../git/format";

/**
 * IntelliJ's "Annotate with Git Blame": a gutter left of the line numbers
 * with each line's date and author. A run of lines from one commit is labelled
 * once, and the tint says how recent it is -- the newest work stands out.
 * Clicking a line opens its commit in the log.
 */
export const blame = new Compartment();

/** Age buckets for the tint, 0 = oldest. */
const LEVELS = 5;

class BlameMarker extends GutterMarker {
  constructor(
    readonly hunk: BlameHunk,
    readonly first: boolean,
    readonly level: number,
  ) {
    super();
  }

  eq(other: BlameMarker) {
    return other.hunk === this.hunk && other.first === this.first && other.level === this.level;
  }

  toDOM() {
    const el = document.createElement("div");
    const h = this.hunk;
    const mine = h.id === UNCOMMITTED;
    el.className = "cm-blame-line";
    el.dataset.age = mine ? "new" : String(this.level);
    el.dataset.first = String(this.first);
    if (this.first) {
      const date = document.createElement("span");
      date.className = "cm-blame-date";
      date.textContent = mine ? "" : shortDate(h.time);
      const who = document.createElement("span");
      who.className = "cm-blame-author";
      who.textContent = mine ? "Not committed" : h.author;
      el.append(date, who);
    }
    el.title = mine
      ? "Not committed yet"
      : `${h.shortId} · ${h.author} · ${fullDate(h.time)}\n${h.summary}`;
    return el;
  }
}

export function blameGutter(
  hunks: readonly BlameHunk[],
  onOpen: (id: string) => void,
): Extension {
  const times = hunks.filter((h) => h.id !== UNCOMMITTED).map((h) => h.time);
  const min = Math.min(...times);
  const span = Math.max(1, Math.max(...times) - min);

  // 1-based line -> its marker.
  const byLine: BlameMarker[] = [];
  for (const h of hunks) {
    const level = Math.round(((h.time - min) / span) * (LEVELS - 1));
    for (let i = 0; i < h.lines; i++) {
      byLine[h.start + i] = new BlameMarker(h, i === 0, level);
    }
  }
  const at = (view: EditorView, pos: number) => byLine[view.state.doc.lineAt(pos).number];

  return [
    gutter({
      class: "cm-blame",
      lineMarker: (view, line) => at(view, line.from) ?? null,
      initialSpacer: () =>
        new BlameMarker(
          { start: 1, lines: 1, id: "", shortId: "", author: "Wwwwwwwwwwww", time: 0, summary: "" },
          true,
          0,
        ),
      domEventHandlers: {
        click(view, line) {
          const m = at(view, line.from);
          if (m && m.hunk.id !== UNCOMMITTED) onOpen(m.hunk.id);
          return true;
        },
      },
    }),
    EditorView.theme({
      ".cm-blame": {
        cursor: "pointer",
        fontSize: "11px",
        fontFamily: "ui-sans-serif, -apple-system, sans-serif",
      },
      ".cm-blame .cm-gutterElement": { padding: "0" },
    }),
  ];
}
