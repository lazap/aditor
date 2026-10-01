/**
 * Lanes for the log's commit graph.
 *
 * The usual walk down a topologically sorted list. Each lane waits for one
 * commit id. A commit takes the leftmost lane waiting for it (or a free one),
 * and any other lanes waiting for it end there. Its first parent then inherits
 * that lane, and every further parent joins the lane already waiting for it or
 * opens a new one. Lanes never move sideways, so a lane that passes a row is a
 * straight line, and only lines into or out of a node bend.
 */

export interface Segment {
  /** Lane columns. */
  x1: number;
  x2: number;
  /** 0 = top of the row, 0.5 = the node, 1 = the bottom. */
  y1: number;
  y2: number;
  color: number;
}

export interface GraphRow {
  col: number;
  color: number;
  segments: Segment[];
  /** Lanes in use on this row, for the column's width. */
  width: number;
}

export const GRAPH_COLORS = 8;

export function layoutGraph(
  commits: readonly { id: string; parents: readonly string[] }[],
): GraphRow[] {
  let lanes: (string | null)[] = [];
  let colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const free = () => {
    const i = lanes.indexOf(null);
    return i < 0 ? lanes.length : i;
  };

  for (const c of commits) {
    const before = lanes.slice();
    const beforeColors = colors.slice();

    let col = lanes.indexOf(c.id);
    if (col < 0) {
      col = free();
      lanes[col] = c.id;
      colors[col] = nextColor++ % GRAPH_COLORS;
    }
    const color = colors[col];
    const segments: Segment[] = [];

    // Into this row: lanes waiting for this commit converge on it, the rest
    // pass straight through.
    before.forEach((id, k) => {
      if (id === null) return;
      if (id === c.id) segments.push({ x1: k, y1: 0, x2: col, y2: 0.5, color: beforeColors[k] });
      else segments.push({ x1: k, y1: 0, x2: k, y2: 1, color: beforeColors[k] });
    });
    for (let k = 0; k < lanes.length; k++) {
      if (k !== col && lanes[k] === c.id) lanes[k] = null;
    }

    // Out of it: one line per parent.
    const [first, ...rest] = c.parents;
    lanes[col] = first ?? null;
    if (first !== undefined) segments.push({ x1: col, y1: 0.5, x2: col, y2: 1, color });
    for (const p of rest) {
      let k = lanes.indexOf(p);
      if (k < 0) {
        k = free();
        lanes[k] = p;
        colors[k] = nextColor++ % GRAPH_COLORS;
      }
      segments.push({ x1: col, y1: 0.5, x2: k, y2: 1, color: colors[k] });
    }

    // Drop trailing free lanes so the column does not stay wide forever.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    colors = colors.slice(0, lanes.length);
    lanes = lanes.slice();

    const width = Math.max(before.length, lanes.length, col + 1);
    rows.push({ col, color, segments, width });
  }
  return rows;
}
