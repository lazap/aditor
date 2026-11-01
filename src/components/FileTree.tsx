import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
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
  /**
   * The paths behind this bump of `refreshToken`: only the loaded directories
   * they touch are re-read. Null re-reads every loaded directory.
   */
  changed: ReadonlySet<string> | null;
  expanded: Set<string>;
  onToggle(path: string): void;
  /** Absolute path -> git status, for row badges. */
  statuses: Map<string, ChangeKind>;
  /** Paths the watcher saw move recently -- accented, then fades. */
  recent: Set<string>;
  /** Bumping this moves the caret to the tree. Zero never does. */
  focusToken: number;
  /** Move `from` into the folder `into`; resolves to its new path, or null. */
  onMove(from: string, into: string): Promise<string | null>;
  /** F6: ask where to move `from`, then move it; resolves as `onMove` does. */
  onAskMove(from: string): Promise<string | null>;
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

/** How far the pointer travels before a press becomes a drag, in px. */
const DRAG_SLOP = 4;

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

  // Inside an ignored directory everything is ignored, though the directory's
  // own pattern does not match its children's names.
  const walk = (dir: string, depth: number, ignored: boolean) => {
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
      const item = ignored && !entry.ignored ? { ...entry, ignored } : entry;
      rows.push({ kind: "item", entry: item, depth, pos: i + 1, size: kids.length });
      if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1, item.ignored);
    });
  };

  walk(root, 0, false);
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
  changed,
  expanded,
  onToggle,
  statuses,
  recent,
  focusToken,
  onMove,
  onAskMove,
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
  }, [root, missing]);

  // What makes the watcher's changes show up: the loaded directories the
  // change touched are re-read -- each changed path's parent, the path itself
  // if it is a loaded directory, and anything loaded beneath it (a directory
  // renamed or removed whole). Re-reading every loaded directory on each tick
  // cost dozens of walks during a turn. Errored directories are retried here
  // too, so a recreated one recovers.
  //
  // `cache`/`errors`/`changed` are read through an effect event rather than
  // depended on: this must fire on the token alone.
  const refresh = useEffectEvent(() => {
    const touched = (dir: string): boolean =>
      changed === null ||
      [...changed].some((p) => dir === p || dir === parentOf(p) || dir.startsWith(`${p}/`));
    const dirs = [...new Set([...[...cache.keys()].filter(touched), ...errors.keys()])];
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
  });
  useEffect(() => {
    if (refreshToken === 0) return;
    return refresh();
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

  /**
   * A row just moved, whose new place the refetch has yet to list. The cursor
   * waits for it instead of settling on an ancestor, and takes focus there if
   * `focus` -- the tree had it when the move began.
   */
  const follow = useRef<{ path: string; focus: boolean } | null>(null);
  const followMoved = useCallback((to: string | null, focus: boolean) => {
    if (!to) return;
    follow.current = { path: to, focus };
    setCursor(to);
  }, []);

  // A vanished row must not strand the cursor. Focus only moves if the tree
  // already had it -- otherwise a file the agent deleted in the background
  // would rip focus out of the terminal mid-turn.
  const lastItems = useRef(items);
  useEffect(() => {
    const prev = lastItems.current;
    lastItems.current = items;
    const want = follow.current;
    if (want) {
      if (!items.some((r) => r.entry.path === want.path)) return;
      follow.current = null;
      if (want.focus) focusRow(want.path);
      else setCursor(want.path);
      return;
    }
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

  // Taking focus on request -- ⌘⇧E. Compared against the last value rather
  // than fired on every run, because `Tree` remounts when the project changes
  // and a bare effect would rip the caret out of the terminal on every switch.
  // `tabTarget` is read through an effect event: this must fire on the token
  // alone.
  const takeFocus = useEffectEvent(() => {
    // An empty or still-loading tree has no row to land on; the container
    // takes it instead, so the chord is never silently ignored.
    if (tabTarget) focusRow(tabTarget);
    else boxRef.current?.focus();
  });
  const lastFocusToken = useRef(focusToken);
  useEffect(() => {
    if (focusToken === lastFocusToken.current) return;
    lastFocusToken.current = focusToken;
    takeFocus();
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
        case "F6":
          // IntelliJ's Move. Not ⌘X/⌘V: the Edit menu owns those.
          if (!row) return;
          void onAskMove(row.entry.path).then((to) => followMoved(to, true));
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
    [items, tabTarget, root, expanded, focusRow, onToggle, onSelect, onAskMove, followMoved],
  );

  // ------------------------------------------------------- drag and drop ---
  //
  // Pointer events rather than HTML5 drag and drop, whose drop events the
  // Tauri webview's own file-drop handling does not reliably let through.

  /** A press on a row, which becomes a drag once it travels DRAG_SLOP. */
  const press = useRef<{ path: string; x: number; y: number } | null>(null);
  /** The row being dragged, and the folder it would land in (null: nowhere). */
  const [drag, setDrag] = useState<{ from: string; into: string | null } | null>(null);
  /** Set by a drop, so the click that ends it does not also open the row. */
  const dropped = useRef(false);

  const entries = useMemo(() => new Map(items.map((r) => [r.entry.path, r.entry])), [items]);

  /**
   * The folder a drop at (x, y) lands in: a folder row itself, a file row's
   * folder, or the root below the last row. Null outside the tree, and where
   * the move would be a no-op or put a folder inside itself.
   */
  const dropTarget = (from: string, x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    if (!el || !boxRef.current?.contains(el)) return null;
    const path = el.closest<HTMLElement>("[data-path]")?.dataset.path;
    const entry = path === undefined ? undefined : entries.get(path);
    // An error row has no data-path; it is no place to drop.
    if (path === undefined && el.closest(".tree-error")) return null;
    const into = entry ? (entry.isDir ? entry.path : parentOf(entry.path)) : root;
    if (into === parentOf(from) || into === from || into.startsWith(`${from}/`)) return null;
    return into;
  };

  const endDrag = () => {
    press.current = null;
    setDrag(null);
  };

  // Escape abandons a drag wherever the keyboard is.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      press.current = null;
      setDrag(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dropped.current = false;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const path = (e.target as Element).closest<HTMLElement>("[data-path]")?.dataset.path;
    if (path === undefined) return;
    follow.current = null;
    press.current = { path, x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    if (!drag) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
      // Captured, so the drag keeps tracking when the pointer leaves the tree.
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const into = dropTarget(p.path, e.clientX, e.clientY);
    if (!drag || drag.into !== into) setDrag({ from: p.path, into });
  };

  const onPointerUp = () => {
    const d = drag;
    endDrag();
    if (!d) return;
    dropped.current = true;
    if (d.into === null) return;
    const focus = boxRef.current?.contains(document.activeElement) ?? false;
    void onMove(d.from, d.into).then((to) => followMoved(to, focus));
  };

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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
      data-dragging={dragging}
      data-drop={drag?.into === root}
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
        // The whole folder a drop would land in lights up, not just its row.
        const into = drag?.into;
        const zone =
          !!into && into !== root && (entry.path === into || entry.path.startsWith(`${into}/`));
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
              data-ignored={entry.ignored}
              data-drop={zone}
              data-dragged={drag?.from === entry.path}
              style={{ paddingLeft: 8 + depth * 12 }}
              title={entry.path}
              onClick={(e) => {
                if (dropped.current) {
                  dropped.current = false;
                  return;
                }
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
