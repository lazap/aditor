import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { resolveFileLinks } from "../fs/api";

/**
 * Clickable file paths in the agent terminal.
 *
 * Nothing here sits on the output stream. xterm asks a link provider for links
 * only when the mouse moves onto a row, and only for that row, so the cost is
 * one regex over a line plus one batched lookup -- and nothing at all while the
 * mouse is elsewhere.
 */

export interface Candidate {
  /** The whole match as printed, location included. */
  text: string;
  /** Just the path part, as handed to the backend. */
  path: string;
  line?: number;
  /** Index into the row's text. */
  start: number;
}

/**
 * A path-ish token -- `src/a.ts`, `./a.ts`, `../x/y.rs`, `/abs/p.ts` -- then an
 * optional `:line`, `:line:col` or `(line,col)`. The lookbehind stops matches
 * starting mid-token, as in the `b.ts` of `a/b.ts`.
 */
const TOKEN =
  /(?<![\w./@+-])((?:\.{1,2}\/|\/)?(?:[\w@+-][\w.@+-]*\/)*[\w@+-][\w.@+-]*)(?::(\d+)(?::\d+)?|\((\d+)(?:,\s*\d+)?\))?/g;

/** Something has to make it look like a path: a slash, or a file extension. */
const PATHY = /\/|\.[A-Za-z][\w-]*$/;

export function findCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(TOKEN)) {
    let path = m[1];
    let whole = m[0];
    const lineNo = m[2] ?? m[3];
    // A sentence ending in a path: `see src/a.ts.` The dot belongs to the prose.
    if (lineNo === undefined) {
      const trimmed = path.replace(/\.+$/, "");
      whole = whole.slice(0, whole.length - (path.length - trimmed.length));
      path = trimmed;
    }
    if (!path || !PATHY.test(path)) continue;
    out.push({
      text: whole,
      path,
      line: lineNo === undefined ? undefined : Number(lineNo),
      start: m.index,
    });
  }
  return out;
}

/**
 * A row's text, plus the cell each character sits in. `translateToString`
 * alone is not enough: a wide character (CJK, most emoji) takes two cells but
 * one or two string units, so string offsets drift from columns after the
 * first one -- and the agent's TUI is full of them.
 */
function readRow(line: IBufferLine, cols: number): { text: string; cellAt: number[] } {
  let text = "";
  const cellAt: number[] = [];
  const cell = line.getCell(0);
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x, cell);
    if (!c || c.getWidth() === 0) continue; // right half of a wide char
    const chars = c.getChars() || " ";
    for (let i = 0; i < chars.length; i++) cellAt.push(x);
    text += chars;
  }
  cellAt.push(cols); // one past the end, for matches that run to the edge
  return { text, cellAt };
}

/** Lookups are cached briefly: long enough to cover sweeping the mouse along a
 * line, short enough that a file the agent has just created starts linking. */
const CACHE_MS = 5_000;
const CACHE_MAX = 500;

export function createFileLinkProvider(
  term: Terminal,
  onOpen: (path: string, line?: number) => void,
): ILinkProvider {
  const cache = new Map<string, { abs: string | null; at: number }>();

  async function resolve(paths: string[]): Promise<Map<string, string | null>> {
    const now = Date.now();
    const result = new Map<string, string | null>();
    const missing: string[] = [];
    for (const p of paths) {
      const hit = cache.get(p);
      if (hit && now - hit.at < CACHE_MS) result.set(p, hit.abs);
      else if (!missing.includes(p)) missing.push(p);
    }
    if (missing.length > 0) {
      const resolved = await resolveFileLinks(missing);
      if (cache.size > CACHE_MAX) cache.clear();
      missing.forEach((p, i) => {
        cache.set(p, { abs: resolved[i], at: now });
        result.set(p, resolved[i]);
      });
    }
    return result;
  }

  return {
    provideLinks(y, callback) {
      const row = term.buffer.active.getLine(y - 1);
      if (!row) return callback(undefined);
      const { text } = readRow(row, term.cols);
      const candidates = findCandidates(text);
      if (candidates.length === 0) return callback(undefined);

      resolve(candidates.map((c) => c.path))
        .then((resolved) => {
          // The agent may have redrawn the row while the lookup was in flight;
          // a link over whatever is there now would open the wrong file.
          const now = term.buffer.active.getLine(y - 1);
          if (!now) return callback(undefined);
          const { text: current, cellAt } = readRow(now, term.cols);

          const links: ILink[] = [];
          for (const c of candidates) {
            const abs = resolved.get(c.path);
            if (!abs) continue;
            if (current.slice(c.start, c.start + c.text.length) !== c.text) continue;
            links.push({
              text: c.text,
              range: {
                start: { x: cellAt[c.start] + 1, y },
                end: { x: cellAt[c.start + c.text.length - 1] + 1, y },
              },
              decorations: { underline: true, pointerCursor: true },
              activate: () => onOpen(abs, c.line),
            });
          }
          callback(links.length > 0 ? links : undefined);
        })
        // No workspace yet, or the backend is busy: no links, not an error.
        .catch(() => callback(undefined));
    },
  };
}
