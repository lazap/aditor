/**
 * Fuzzy matching of a query against file paths, fzf-style: the query's
 * characters must appear in order, and the score rewards the matches a person
 * means -- at the start of a word, in a run, in the file name rather than the
 * folders above it.
 */

export interface FuzzyMatch {
  score: number;
  /** Indexes into the path of each matched character, ascending. */
  positions: number[];
}

const SEPARATORS = "/\\_-. ";

const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();

/** How much a match at `i` is worth for where it falls. */
function boundaryBonus(path: string, i: number): number {
  if (i === 0) return 8;
  const prev = path[i - 1];
  if (prev === "/") return 9;
  if (SEPARATORS.includes(prev)) return 7;
  if (isUpper(path[i]) && !isUpper(prev)) return 6;
  return 0;
}

/**
 * Score `path` against `query`, or null when it does not match. Case is
 * ignored, as in IntelliJ's Go to File: a capital in the query narrows nothing,
 * though the path's own capitals still count as word starts (`fv` ranks
 * `FileViewer` well).
 *
 * A greedy left-to-right scan would be cheaper but misses the best alignment;
 * this is the usual small DP over (query, path), fine for the tens of thousands
 * of paths a keystroke has to rank.
 */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  if (query === "") return { score: 0, positions: [] };
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  const n = q.length;
  const m = p.length;
  if (n > m) return null;

  // Quick reject: every query char present, in order.
  for (let i = 0, j = 0; i < n; i++, j++) {
    j = p.indexOf(q[i], j);
    if (j < 0) return null;
  }

  const nameStart = path.lastIndexOf("/") + 1;
  // best[i][j]: best score with q[0..=i] matched and q[i] at p[j].
  const NEG = -Infinity;
  const best: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m).fill(NEG);
    const back = new Int32Array(m).fill(-1);
    // Running max over the previous row up to j-2, for non-adjacent matches.
    let runMax = NEG;
    let runAt = -1;
    for (let j = i; j < m; j++) {
      if (i > 0 && j - 2 >= 0 && best[i - 1][j - 2] > runMax) {
        runMax = best[i - 1][j - 2];
        runAt = j - 2;
      }
      if (p[j] !== q[i]) continue;
      let base = 1 + boundaryBonus(path, j) + (j >= nameStart ? 2 : 0);
      if (i === 0) {
        // Starting up in the folders is a weaker match than in the name.
        row[j] = j >= nameStart ? base : base - 3;
        continue;
      }
      const adjacent = best[i - 1][j - 1];
      // A gap costs a little, more the longer it is.
      const gapped = runAt >= 0 ? runMax - 1 - Math.min(j - runAt - 1, 6) * 0.2 : NEG;
      if (adjacent !== NEG && adjacent + 5 >= gapped) {
        base += 5;
        row[j] = adjacent + base;
        back[j] = j - 1;
      } else if (gapped !== NEG) {
        row[j] = gapped + base;
        back[j] = runAt;
      }
    }
    best.push(row);
    from.push(back);
  }

  let end = -1;
  let top = NEG;
  for (let j = 0; j < m; j++) {
    if (best[n - 1][j] > top) {
      top = best[n - 1][j];
      end = j;
    }
  }
  if (end < 0) return null;

  const positions = new Array<number>(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    positions[i] = j;
    j = from[i][j];
  }
  // Shorter paths win ties: `App.tsx` over `src/legacy/old/App.tsx`.
  return { score: top - m * 0.02, positions };
}

export interface Ranked<T> {
  item: T;
  match: FuzzyMatch;
}

/**
 * The `limit` best matches of `query` among `items`, best first. `bias`, when
 * given, is added to each match's score -- to push some items down a little
 * without hiding them.
 */
export function rank<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
  limit: number,
  bias?: (item: T) => number,
): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) {
      if (bias) match.score += bias(item);
      out.push({ item, match });
    }
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}

/** A file-name query as IntelliJ reads it. */
export interface FileQuery {
  /** What to match, with whitespace dropped. */
  name: string;
  /** 1-based, from a trailing `:N` (or `:N:col`). */
  line?: number;
}

/**
 * Spaces are wildcards -- `file view` finds `FileViewer.tsx`, which the
 * subsequence match gives for free once they are gone -- and a trailing
 * `:42` asks for that line, so `FileTree.tsx:42` pasted from a stack trace
 * lands on it.
 */
export function parseFileQuery(raw: string): FileQuery {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw.trim());
  const name = (m ? m[1] : raw).replace(/\s+/g, "");
  const line = m ? Number(m[2]) : 0;
  return line > 0 ? { name, line } : { name };
}
