/**
 * Vim's `/` search for the read-only viewers: `/` opens a prompt along the
 * bottom of the editor, Enter jumps to the match and closes it, `n` / `N`
 * repeat forwards and backwards.
 *
 * Built on @codemirror/search's query state and panel slot, with a prompt of
 * our own in place of its find-and-replace form. Plain text, smartcase: an
 * upper-case letter makes the search case-sensitive.
 */
import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import {
  BlockType,
  Decoration,
  EditorView,
  ViewPlugin,
  type Command,
  type DecorationSet,
  type KeyBinding,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  search,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { getChunks, mergeViewSiblings, uncollapseUnchanged, type Chunk } from "@codemirror/merge";

interface Match {
  from: number;
  to: number;
}

function queryFor(text: string): SearchQuery {
  return new SearchQuery({ search: text, literal: true, caseSensitive: /\p{Lu}/u.test(text) });
}

function matchesIn(state: EditorState, query: SearchQuery, from = 0, to?: number): Match[] {
  const cursor = query.getCursor(state, from, to);
  const out: Match[] = [];
  for (let r = cursor.next(); !r.done; r = cursor.next()) out.push(r.value);
  return out;
}

/** The first match starting after `pos`, wrapping round to the top. */
function matchAfter(state: EditorState, query: SearchQuery, pos: number): Match | null {
  const first = (from: number) => query.getCursor(state, from).next();
  const r = pos < state.doc.length ? first(pos + 1) : { done: true as const, value: null };
  if (!r.done) return r.value;
  const wrapped = first(0);
  return wrapped.done ? null : wrapped.value;
}

/** The last match starting before `pos`, wrapping round to the bottom. */
function matchBefore(state: EditorState, query: SearchQuery, pos: number): Match | null {
  const all = matchesIn(state, query);
  return all.filter((m) => m.from < pos).pop() ?? all.pop() ?? null;
}

/** `pos` on this side of a split diff, carried across to the other. */
function mapAcross(pos: number, chunks: readonly Chunk[], fromA: boolean): number {
  let ours = 0;
  let theirs = 0;
  for (const chunk of chunks) {
    if ((fromA ? chunk.fromA : chunk.fromB) >= pos) break;
    [ours, theirs] = fromA ? [chunk.toA, chunk.toB] : [chunk.toB, chunk.toA];
  }
  return theirs + (pos - ours);
}

/**
 * Expands the collapsed run of unchanged lines hiding `pos`, if any -- on both
 * sides of a split diff, or the two halves would fall out of line.
 */
function reveal(view: EditorView, pos: number) {
  const block = view.lineBlockAt(pos);
  if (block.type !== BlockType.WidgetRange) return;
  view.dispatch({ effects: uncollapseUnchanged.of(block.from) });
  const pair = mergeViewSiblings(view);
  const chunks = getChunks(view.state);
  if (!pair || !chunks) return;
  const isA = pair.a === view;
  (isA ? pair.b : pair.a).dispatch({
    effects: uncollapseUnchanged.of(mapAcross(block.from, chunks.chunks, isA)),
  });
}

function goTo(view: EditorView, pos: number) {
  reveal(view, pos);
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
    userEvent: "select.search",
  });
}

function prompt(view: EditorView): Panel {
  // Escape puts both back; so does Enter on an empty prompt, which in vim
  // repeats the last search.
  const previous = getSearchQuery(view.state);
  const origin = view.state.selection.main.head;

  const dom = document.createElement("div");
  dom.className = "cm-vim-search";
  dom.textContent = "/";
  const input = document.createElement("input");
  input.spellcheck = false;
  input.setAttribute("aria-label", "Search");
  dom.append(input);

  const close = () => {
    closeSearchPanel(view);
    view.focus();
  };

  // Incremental: the cursor follows the first match as the query is typed.
  input.addEventListener("input", () => {
    const query = queryFor(input.value);
    const match = query.valid ? matchAfter(view.state, query, origin) : null;
    const at = match ? match.from : origin;
    view.dispatch({
      selection: { anchor: at },
      effects: [setSearchQuery.of(query), EditorView.scrollIntoView(at, { y: "center" })],
    });
  });

  // Stopped here, or DiffWindow's Escape would close the window as well.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (!input.value) view.dispatch({ effects: setSearchQuery.of(previous) });
      close();
      const query = getSearchQuery(view.state);
      const match = query.valid && matchAfter(view.state, query, origin);
      goTo(view, match ? match.from : origin);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        selection: { anchor: origin },
        effects: [setSearchQuery.of(previous), EditorView.scrollIntoView(origin, { y: "center" })],
      });
      close();
    }
  });

  return { dom, top: false, mount: () => input.focus() };
}

const repeat =
  (forward: boolean): Command =>
  (view) => {
    const query = getSearchQuery(view.state);
    if (!query.valid) return false;
    const head = view.state.selection.main.head;
    const match = forward
      ? matchAfter(view.state, query, head)
      : matchBefore(view.state, query, head);
    if (match) goTo(view, match.from);
    return true;
  };

const matchMark = Decoration.mark({ class: "cm-searchMatch" });

/**
 * Keeps the last search's matches lit once the prompt closes, like vim's
 * hlsearch. While it is open the search package's own highlighter does it.
 */
const lastSearch = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        searchPanelOpen(u.startState) !== searchPanelOpen(u.state) ||
        getSearchQuery(u.startState) !== getSearchQuery(u.state)
      )
        this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const query = getSearchQuery(view.state);
      if (searchPanelOpen(view.state) || !query.valid) return Decoration.none;
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges)
        for (const m of matchesIn(view.state, query, from, to)) builder.add(m.from, m.to, matchMark);
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const promptTheme = EditorView.theme({
  ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--fg)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-vim-search": {
    display: "flex",
    padding: "2px 8px",
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace',
    fontSize: "13px",
  },
  ".cm-vim-search input": {
    flex: "1",
    padding: "0",
    border: "none",
    outline: "none",
    background: "transparent",
    color: "inherit",
    font: "inherit",
  },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
});

export const searchBindings: KeyBinding[] = [
  { key: "/", run: openSearchPanel },
  { key: "n", run: repeat(true) },
  { key: "N", run: repeat(false) },
];

export const vimSearch: Extension = [search({ createPanel: prompt }), lastSearch, promptTheme];
