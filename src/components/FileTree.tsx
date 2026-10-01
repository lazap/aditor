import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { listDir, type DirEntry } from "../fs/api";
import { BADGE, type ChangeKind } from "../git/api";
import { FileIcon } from "./fileIcons";

interface Props {
  root: string;
  selected: string | null;
  onSelect(path: string): void;
  /** Bumped by the workspace watcher to force a refetch of loaded levels. */
  refreshToken: number;
  expanded: Set<string>;
  onToggle(path: string): void;
  /** Absolute path -> git status, for row badges. */
  statuses: Map<string, ChangeKind>;
  /** Paths the watcher saw move recently -- accented, then fades. */
  recent: Set<string>;
  /** Bumping this moves the caret to the tree. Zero never does. */
  focusToken: number;
}

export function FileTree(props: Props) {
  // Keyed by root so switching projects mounts clean state rather than showing
  // the previous project's entries until the refetch lands -- and so the
  // directory cache and the keyboard cursor reset with it, for free. A reset
  // effect instead of a key would leave one frame rendering the old project's
  // rows against the new root, which is the bug this guards against.
  return <Tree key={props.root} {...props} />;
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

/** One visible line. The tree is flattened before rendering -- see `flatten`. */
type Row =
  | {
      kind: "item";
      entry: DirEntry;
      depth: number;
      /** Siblings are no longer DOM siblings, so position must be spelled out. */
      pos: number;
      size: number;
    }
  | { kind: "error"; dir: string; depth: number; message: string };

/**
 * Visible rows in view order, plus the directories still to fetch -- one walk
 * produces both, because they are the same traversal.
 *
 * `missing` only ever holds directories whose parent is already cached, so a
 * restored deep expansion fills in one level per pass and converges in as many
 * passes as it is deep.
 */
function flatten(
  root: string,
  cache: Map<string, DirEntry[]>,
  errors: Map<string, string>,
  expanded: Set<string>,
): { rows: Row[]; missing: string[] } {
  const rows: Row[] = [];
  const missing: string[] = [];

  const walk = (dir: string, depth: number) => {
    const kids = cache.get(dir);
    if (kids === undefined) {
      const message = errors.get(dir);
      // An errored directory leaves `missing`, so it is not retried on every
      // render -- only when the watcher's token comes round.
      if (message === undefined) missing.push(dir);
      else rows.push({ kind: "error", dir, depth, message });
      return;
    }
    kids.forEach((entry, i) => {
      rows.push({ kind: "item", entry, depth, pos: i + 1, size: kids.length });
      if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
    });
  };

  walk(root, 0);
  return { rows, missing };
}

/**
 * The whole tree, as a flat list of visible rows.
 *
 * Children used to be a recursive component per directory, each owning its own
 * entries. That made keyboard navigation impossible: nothing knew the visible
 * order, so "move down one row" had no answer. The directory cache therefore
 * lives here and the rows are flattened before rendering, which also turns the
 * old storm of one refetch per mounted level into a single batched update.
 *
 * Expansion state stays owned by App, which persists it per project.
 */
function Tree({
  root,
  selected,
  onSelect,
  refreshToken,
  expanded,
  onToggle,
  statuses,
  recent,
  focusToken,
}: Props) {
  const [cache, setCache] = useState<Map<string, DirEntry[]>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  /** The keyboard cursor. Deliberately not `selected`, which is the open file. */
  const [cursor, setCursor] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inflight = useRef(new Set<string>());

  const { rows, missing } = useMemo(
    () => flatten(root, cache, errors, expanded),
    [root, cache, errors, expanded],
  );

  // Fetch whatever just became visible. `inflight` is what stops a re-render
  // mid-fetch from re-issuing the same listDir, and the batched setState keeps
  // restoring a deep expansion from repainting once per level.
  useEffect(() => {
    const todo = missing.filter((d) => !inflight.current.has(d));
    if (todo.length === 0) return;
    for (const d of todo) inflight.current.add(d);

    void Promise.allSettled(todo.map((d) => listDir(root, d))).then((results) => {
      for (const d of todo) inflight.current.delete(d);
      const ok: Array<[string, DirEntry[]]> = [];
      const bad: Array<[string, string]> = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") ok.push([todo[i], r.value]);
        else bad.push([todo[i], String(r.reason)]);
      });
      if (ok.length) {
        setCache((prev) => {
          const next = new Map(prev);
          for (const [d, entries] of ok) next.set(d, entries);
          return next;
        });
      }
      if (bad.length) {
        setErrors((prev) => {
          const next = new Map(prev);
          for (const [d, message] of bad) next.set(d, message);
          return next;
        });
      }
    });
  }, [missing]);

  // What makes the watcher's changes show up: everything already loaded is
  // re-read, which is what the old per-level effects added up to. Errored
  // directories are retried here too, so a recreated one recovers.
  //
  // `cache`/`errors` are read but deliberately not dependencies -- this must
  // fire on the token alone, and the closure already belongs to the render in
  // which the token changed.
  useEffect(() => {
    if (refreshToken === 0) return;
    const dirs = [...new Set([...cache.keys(), ...errors.keys()])];
    if (dirs.length === 0) return;
    let stale = false;

    void Promise.allSettled(dirs.map((d) => listDir(root, d))).then((results) => {
      if (stale) return; // a newer refresh already won
      setCache((prev) => {
        const next = new Map(prev);
        // A failed refetch keeps the entries it had: dropping them would
        // collapse the subtree, and take the focused row with it.
        results.forEach((r, i) => {
          if (r.status === "fulfilled") next.set(dirs[i], r.value);
        });
        return next;
      });
      setErrors((prev) => {
        const next = new Map(prev);
        results.forEach((r, i) => {
          if (r.status === "fulfilled") next.delete(dirs[i]);
          else next.set(dirs[i], String(r.reason));
        });
        return next;
      });
    });

    return () => {
      stale = true;
    };
  }, [refreshToken]);

  /**
   * Every directory with a change somewhere beneath it. One pass over the
   * statuses, rather than the old per-collapsed-directory prefix scan that cost
   * O(rows x statuses) on every render.
   */
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const p of statuses.keys()) {
      let cut = p.lastIndexOf("/");
      while (cut > 0) {
        const dir = p.slice(0, cut);
        if (dirs.has(dir)) break; // this ancestor chain is already recorded
        dirs.add(dir);
        cut = dir.lastIndexOf("/");
      }
    }
    return dirs;
  }, [statuses]);

  const items = useMemo(
    () => rows.filter((r): r is Extract<Row, { kind: "item" }> => r.kind === "item"),
    [rows],
  );

  // Exactly one row is tabbable, so the tree is a single tab stop and the arrow
  // keys move within it.
  const tabTarget =
    (cursor && items.some((r) => r.entry.path === cursor) && cursor) ||
    (selected && items.some((r) => r.entry.path === selected) && selected) ||
    items[0]?.entry.path ||
    null;

  const focusRow = useCallback((path: string) => {
    setCursor(path);
    boxRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
      ?.focus();
  }, []);

  // A vanished row must not strand the cursor. Focus only moves if the tree
  // already had it -- otherwise a file the agent deleted in the background
  // would rip focus out of the terminal mid-turn.
  const lastItems = useRef(items);
  useEffect(() => {
    const prev = lastItems.current;
    lastItems.current = items;
    if (!cursor || items.some((r) => r.entry.path === cursor)) return;

    // Prefer the nearest surviving ancestor, else whatever now sits at the
    // same index.
    let ancestor = parentOf(cursor);
    while (ancestor.length > root.length) {
      if (items.some((r) => r.entry.path === ancestor)) break;
      ancestor = parentOf(ancestor);
    }
    const was = prev.findIndex((r) => r.entry.path === cursor);
    const next =
      items.find((r) => r.entry.path === ancestor) ??
      items[Math.min(was < 0 ? 0 : was, items.length - 1)];

    if (!next) {
      setCursor(null);
      return;
    }
    if (boxRef.current?.contains(document.activeElement)) focusRow(next.entry.path);
    else setCursor(next.entry.path);
  }, [items, cursor, root, focusRow]);

  // Taking focus on request -- ⌘1. Compared against the last value rather
  // than fired on every run, because `Tree` remounts when the project changes
  // and a bare effect would rip the caret out of the terminal on every switch.
  const lastFocusToken = useRef(focusToken);
  useEffect(() => {
    if (focusToken === lastFocusToken.current) return;
    lastFocusToken.current = focusToken;
    // An empty or still-loading tree has no row to land on; the container
    // takes it instead, so the chord is never silently ignored.
    if (tabTarget) focusRow(tabTarget);
    else boxRef.current?.focus();
    // `tabTarget` is read, not depended on: this must fire on the token alone,
    // and the closure belongs to the render in which the token changed.
  }, [focusToken]);

  const typed = useRef({ buffer: "", at: 0 });

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const at = items.findIndex((r) => r.entry.path === tabTarget);
      const row = items[at];
      // Trees clamp rather than wrap.
      const step = (to: number) => {
        const next = items[Math.max(0, Math.min(to, items.length - 1))];
        if (next) focusRow(next.entry.path);
      };

      switch (e.key) {
        case "ArrowDown":
          step(at + 1);
          break;
        case "ArrowUp":
          step(at - 1);
          break;
        case "Home":
          step(0);
          break;
        case "End":
          step(items.length - 1);
          break;
        case "ArrowRight":
          if (!row?.entry.isDir) return;
          // Expand first, move second: the ARIA behaviour, and it means every
          // focus target already exists in the DOM.
          if (expanded.has(row.entry.path)) step(at + 1);
          else onToggle(row.entry.path);
          break;
        case "ArrowLeft": {
          if (!row) return;
          if (row.entry.isDir && expanded.has(row.entry.path)) {
            onToggle(row.entry.path);
            break;
          }
          const parent = parentOf(row.entry.path);
          if (parent === root) return;
          focusRow(parent);
          break;
        }
        case "Enter":
        case " ":
          if (!row) return;
          if (row.entry.isDir) onToggle(row.entry.path);
          else onSelect(row.entry.path);
          break;
        default: {
          // Typeahead. A lone printable character only, so it never swallows a
          // shortcut, and Space is already spoken for above.
          if (e.key.length !== 1 || e.key === " ") return;
          const now = Date.now();
          const t = typed.current;
          t.buffer = now - t.at > 700 ? e.key : t.buffer + e.key;
          t.at = now;
          const want = t.buffer.toLowerCase();
          // A repeat of the same letter walks the matches; a longer buffer
          // re-tests the row already under the cursor.
          const from = t.buffer.length > 1 ? at : at + 1;
          for (let i = 0; i < items.length; i++) {
            const r = items[(from + i + items.length) % items.length];
            if (r?.entry.name.toLowerCase().startsWith(want)) {
              focusRow(r.entry.path);
              break;
            }
          }
        }
      }
      e.preventDefault();
    },
    [items, tabTarget, root, expanded, focusRow, onToggle, onSelect],
  );

  const rootError = errors.get(root);
  if (rootError) return <div className="tree tree-error">{rootError}</div>;

  return (
    // A flat list of siblings, so aria-level is what conveys depth and
    // posinset/setsize what conveys order: role="group" applies only when
    // children really are DOM descendants. Every child of role="tree" must be a
    // treeitem, which is why the error rows are treeitems too.
    <div
      className="tree"
      role="tree"
      aria-label="Files"
      tabIndex={-1}
      ref={boxRef}
      onKeyDown={onKeyDown}
    >
      {rows.map((row) => {
        if (row.kind === "error") {
          return (
            <div
              key={`!${row.dir}`}
              className="tree-error"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-disabled
              tabIndex={-1}
              style={{ paddingLeft: 8 + row.depth * 12 }}
            >
              {row.message}
            </div>
          );
        }
        const { entry, depth, pos, size } = row;
        const open = entry.isDir && expanded.has(entry.path);
        const status = statuses.get(entry.path);
        return (
          <Fragment key={entry.path}>
            <div
              className="tree-row"
              role="treeitem"
              aria-level={depth + 1}
              aria-posinset={pos}
              aria-setsize={size}
              aria-expanded={entry.isDir ? open : undefined}
              aria-selected={entry.path === selected}
              tabIndex={entry.path === tabTarget ? 0 : -1}
              data-path={entry.path}
              // The keyboard cursor is styled from this, not from
              // :focus-visible: WebKit does not reliably match that pseudo-class
              // on a programmatically focused div[tabindex], which left the
              // cursor invisible and the arrow keys looking dead.
              data-cursor={entry.path === tabTarget}
              data-selected={entry.path === selected}
              data-recent={recent.has(entry.path)}
              data-status={status}
              style={{ paddingLeft: 8 + depth * 12 }}
              title={entry.path}
              onClick={(e) => {
                // Focusing explicitly: WKWebView does not reliably focus a
                // div[tabindex="-1"] on mousedown, and without this the
                // keyboard cursor would not follow the mouse.
                setCursor(entry.path);
                e.currentTarget.focus();
                if (entry.isDir) onToggle(entry.path);
                else onSelect(entry.path);
              }}
            >
              <span
                className="tree-twisty"
                data-dir={entry.isDir}
                data-open={open}
                aria-hidden
              >
                <svg viewBox="0 0 12 12" width="12" height="12" focusable="false">
                  <path fill="currentColor" d="M4.2 2.6 8.6 6l-4.4 3.4z" />
                </svg>
              </span>
              <FileIcon name={entry.name} isDir={entry.isDir} open={open} />
              <span className="tree-name" data-dir={entry.isDir}>
                {entry.name}
              </span>
              {status && (
                <span className="tree-status" data-status={status} title={status}>
                  {BADGE[status]}
                </span>
              )}
              {entry.isDir && !open && changedDirs.has(entry.path) && (
                <span className="tree-dot" aria-hidden />
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
