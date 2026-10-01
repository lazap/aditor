import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BADGE,
  gitBranchCreate,
  gitBranches,
  gitCheckout,
  gitCheckoutRevision,
  gitCherryPick,
  gitCommitDetails,
  gitLog,
  gitPushTag,
  gitReset,
  gitRevert,
  gitTagCreate,
  gitTagDelete,
  type BranchList,
  type CommitDetails,
  type CommitFile,
  type CommitInfo,
  type RefLabel,
  type ResetMode,
} from "../git/api";
import { fullDate, relativeTime } from "../git/format";
import { GRAPH_COLORS, layoutGraph, type GraphRow } from "../git/graph";
import { useSetting } from "../settings/store";
import { basename, LOG_TARGET, logTitle, type LogTarget } from "../window";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { DiffViewer } from "./DiffViewer";
import { DiffLayoutToggle } from "./BottomPane";
import { refNameError, useDialogs } from "./Modal";
import { Toast, type ToastMessage } from "./Toast";

/** Any window -> every window: a git write landed, re-read what you show. */
export const GIT_CHANGED = "git://changed";

/** `git://changed`: a write landed in this workspace. */
export interface GitChanged {
  root: string;
}

const PAGE = 300;
const ROW_H = 24;
const LANE_W = 12;
/** Past this many lanes the graph is clipped rather than eating the subject. */
const MAX_LANES = 14;
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 20;

const initialTarget = (): LogTarget => {
  try {
    return JSON.parse(new URLSearchParams(location.search).get("target") ?? "{}");
  } catch {
    return { root: "" };
  }
};

/**
 * The workspace this page reads, fixed for its lifetime. A retarget at another
 * project reloads the page instead (see the LOG_TARGET listener), so nothing
 * below has to reset itself when the root changes.
 */
const ROOT = initialTarget().root;

const errorText = (e: unknown) => String(e).replace(/^Error:\s*/, "");

/**
 * IntelliJ's Git Log (⌘9): every commit with its graph and refs, the selected
 * commit's files, and one file's diff in that commit below. Right-click a
 * commit for checkout, branch, tag, cherry-pick, revert and reset.
 */
export function LogWindow({ onClose }: { onClose(): void }) {
  const [target, setTarget] = useState<LogTarget>(initialTarget);
  const [branch, setBranch] = useState<string>(target.branch ?? "");
  const [path, setPath] = useState<string | null>(target.path ?? null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [file, setFile] = useState<CommitFile | null>(null);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [dialogs, ask] = useDialogs();
  const layout = useSetting((s) => s.layout.diffLayout);
  const listRef = useRef<HTMLDivElement>(null);
  const toastSeq = useRef(0);
  const closeMenu = useCallback(() => setMenu(null), []);
  /** Bumped to re-read from the top without losing the selection. */
  const [reload, setReload] = useState(0);

  const showToast = useCallback((t: string, tone: ToastMessage["tone"] = "info") => {
    setToast({ id: ++toastSeq.current, text: t, tone });
  }, []);

  // Retargeted from another window: a file's history, or a commit to show.
  useEffect(() => {
    const unlisten = listen<LogTarget>(LOG_TARGET, ({ payload }) => {
      if (payload.root !== ROOT) {
        location.search = `?view=log&target=${encodeURIComponent(JSON.stringify(payload))}`;
        return;
      }
      setTarget(payload);
      setBranch(payload.branch ?? "");
      setPath(payload.path ?? null);
      void getCurrentWindow().setFocus();
    });
    return () => void unlisten.then((u) => u());
  }, []);

  useEffect(() => {
    void getCurrentWindow().setTitle(
      path ? `History: ${basename(path)} — ${basename(ROOT)}` : logTitle(ROOT),
    );
  }, [path]);

  // Typing filters after a pause, not per keystroke: each query is a walk.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(text.trim()), 250);
    return () => window.clearTimeout(id);
  }, [text]);

  // A write from here or from the main window, or coming back to this window
  // after working elsewhere, may have moved any ref.
  useEffect(() => {
    const bump = () => setReload((r) => r + 1);
    const unGit = listen<GitChanged>(GIT_CHANGED, ({ payload }) => {
      if (payload.root === ROOT) bump();
    });
    const unFocus = getCurrentWindow().onFocusChanged(({ payload }) => payload && bump());
    return () => {
      void unGit.then((u) => u());
      void unFocus.then((u) => u());
    };
  }, []);

  useEffect(() => {
    void gitBranches(ROOT).then(setBranches).catch(() => {});
  }, [reload]);

  const filter = useMemo(
    () => ({ branch: branch || null, text: query || null, path }),
    [branch, query, path],
  );

  // First page, or the same number of rows again on a reload so the list
  // does not jump back to the top under the user.
  const loadedRef = useRef(0);
  loadedRef.current = commits.length;
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    const want = Math.max(PAGE, loadedRef.current);
    gitLog(ROOT, 0, want, filter)
      .then((page) => {
        if (stale) return;
        setCommits(page);
        setDone(page.length < want);
      })
      .catch((e) => !stale && (setError(errorText(e)), setCommits([]), setDone(true)))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [filter, reload]);

  // A new filter starts at the top.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
    loadedRef.current = 0;
  }, [filter]);

  const loadMore = useCallback(() => {
    if (loading || done) return;
    setLoading(true);
    gitLog(ROOT, commits.length, PAGE, filter)
      .then((page) => {
        setCommits((prev) => [...prev, ...page]);
        setDone(page.length < PAGE);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [loading, done, commits.length, filter]);

  // Asked to show a commit: page until it is loaded, then select it.
  useEffect(() => {
    if (!target.select) return;
    const at = commits.findIndex((c) => c.id.startsWith(target.select!));
    if (at >= 0) {
      setSelected(commits[at].id);
      listRef.current?.scrollTo({ top: Math.max(0, at * ROW_H - viewH / 3) });
      if (!target.file) setTarget((t) => ({ ...t, select: undefined }));
      return;
    }
    if (!done && !loading && commits.length < 20 * PAGE) loadMore();
  }, [target, commits, done, loading, loadMore, viewH]);

  // Default selection: the first commit, once there is one.
  useEffect(() => {
    if (target.select) return;
    if (!selected || !commits.some((c) => c.id === selected)) {
      setSelected(commits[0]?.id ?? null);
    }
  }, [commits, selected, target.select]);

  useEffect(() => {
    if (!selected) {
      setDetails(null);
      return;
    }
    let stale = false;
    gitCommitDetails(ROOT, selected)
      .then((d) => {
        if (stale) return;
        setDetails(d);
        // Keep the open file across commits when the next one touched it too,
        // the way IntelliJ follows a file down the log. A file's history
        // opens its diff straight away.
        setFile((prev) =>
          d.files.find((f) => f.path === prev?.path) ?? (pathRef.current ? d.files[0] ?? null : null),
        );
      })
      .catch(() => !stale && setDetails(null));
    return () => {
      stale = true;
    };
  }, [selected, reload]);

  // Asked for a file in a commit: open it once that commit's details are in.
  useEffect(() => {
    if (!target.select || !target.file || !details) return;
    if (!details.id.startsWith(target.select)) return;
    setFile(details.files.find((f) => f.path === target.file) ?? null);
    setTarget((t) => ({ ...t, select: undefined, file: undefined }));
  }, [target, details]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const showGraph = !query && !path;
  const lanes = showGraph
    ? Math.min(MAX_LANES, Math.max(1, ...graph.map((g) => g.width)))
    : 0;

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(commits.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 10 * ROW_H) loadMore();
  };

  const selectAt = (i: number) => {
    const c = commits[Math.max(0, Math.min(i, commits.length - 1))];
    if (!c) return;
    setSelected(c.id);
    const el = listRef.current;
    if (!el) return;
    const at = commits.indexOf(c) * ROW_H;
    if (at < el.scrollTop) el.scrollTop = at;
    else if (at + ROW_H > el.scrollTop + el.clientHeight)
      el.scrollTop = at + ROW_H - el.clientHeight;
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const i = commits.findIndex((c) => c.id === selected);
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 1);
    const keys: Record<string, () => void> = {
      ArrowDown: () => selectAt(i + 1),
      ArrowUp: () => selectAt(i - 1),
      PageDown: () => selectAt(i + page),
      PageUp: () => selectAt(i - page),
      Home: () => selectAt(0),
      End: () => selectAt(commits.length - 1),
      Enter: () => details?.files[0] && setFile(details.files[0]),
    };
    const run = keys[e.key];
    if (!run || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    run();
  };

  // Escape closes, as the diff window does -- except while typing a filter,
  // where it clears the filter first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && el.value !== "") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** One write at a time, errors as a toast, everything re-read after. */
  const run = async (what: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await what();
      if (done) showToast(done);
    } catch (e) {
      showToast(errorText(e), "error");
    } finally {
      setBusy(false);
      setReload((r) => r + 1);
      void emit(GIT_CHANGED, { root: ROOT } satisfies GitChanged);
    }
  };

  const newBranch = async (c: CommitInfo) => {
    const r = await ask({
      title: "Create New Branch",
      body: <>From <code>{c.shortId}</code> {c.subject}</>,
      input: { label: "New branch name", placeholder: "feature/…" },
      checks: [{ id: "checkout", label: "Checkout branch", initial: true }],
      confirm: "Create",
      validate: refNameError,
    });
    if (r) void run(() => gitBranchCreate(ROOT, r.text, c.id, r.checks.checkout), `Created ${r.text}.`);
  };

  const newTag = async (c: CommitInfo) => {
    const r = await ask({
      title: "Create New Tag",
      body: <>On <code>{c.shortId}</code> {c.subject}</>,
      input: { label: "Tag name", placeholder: "v1.0.0" },
      message: { label: "Message (makes an annotated tag)", placeholder: "Optional" },
      confirm: "Create Tag",
      validate: refNameError,
    });
    if (r) void run(() => gitTagCreate(ROOT, r.text, c.id, r.message || null), `Tagged ${r.text}.`);
  };

  const reset = async (c: CommitInfo) => {
    const current = branches?.current ?? "HEAD";
    const r = await ask({
      title: "Git Reset",
      body: (
        <>
          Reset <code>{current}</code> to <code>{c.shortId}</code> {c.subject}
        </>
      ),
      choices: [
        { id: "soft", label: "Soft", hint: "keep all changes staged" },
        { id: "mixed", label: "Mixed", hint: "keep changes, unstaged" },
        { id: "hard", label: "Hard", hint: "discard every local change" },
      ],
      initialChoice: "mixed",
      confirm: "Reset",
    });
    if (!r?.choice) return;
    void run(() => gitReset(ROOT, c.id, r.choice as ResetMode), `Reset ${current} to ${c.shortId}.`);
  };

  const commitMenu = (e: React.MouseEvent, c: CommitInfo) => {
    e.preventDefault();
    setSelected(c.id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Copy Revision Number",
          run: () =>
            void navigator.clipboard
              .writeText(c.id)
              .then(() => showToast(`Copied ${c.shortId}.`))
              .catch(() => showToast("Could not copy.", "error")),
        },
        {
          label: "Checkout Revision",
          disabled: busy,
          run: () => void run(() => gitCheckoutRevision(ROOT, c.id), `HEAD is now at ${c.shortId}.`),
        },
        "separator",
        { label: "New Branch…", disabled: busy, run: () => void newBranch(c) },
        { label: "New Tag…", disabled: busy, run: () => void newTag(c) },
        "separator",
        {
          label: "Cherry-Pick",
          disabled: busy || c.parents.length > 1,
          run: () => void run(() => gitCherryPick(ROOT, c.id), `Cherry-picked ${c.shortId}.`),
        },
        {
          label: "Revert Commit",
          disabled: busy || c.parents.length > 1,
          run: () => void run(() => gitRevert(ROOT, c.id), `Reverted ${c.shortId}.`),
        },
        {
          label: "Reset Current Branch to Here…",
          disabled: busy,
          danger: true,
          run: () => void reset(c),
        },
      ],
    });
  };

  const refMenu = (e: React.MouseEvent, r: RefLabel) => {
    e.preventDefault();
    e.stopPropagation();
    if (r.kind === "tag") {
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: `Push Tag '${r.name}'`,
            disabled: busy,
            run: () => void run(() => gitPushTag(ROOT, r.name), `Pushed ${r.name}.`),
          },
          {
            label: `Delete Tag '${r.name}'`,
            danger: true,
            disabled: busy,
            run: () => void run(() => gitTagDelete(ROOT, r.name), `Deleted tag ${r.name}.`),
          },
        ],
      });
    } else if (r.kind === "local" || r.kind === "remote") {
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: `Checkout '${r.name}'`,
            disabled: busy || r.current,
            run: () =>
              void run(
                () =>
                  gitCheckout(ROOT, {
                    name: r.name,
                    remote: r.kind === "remote",
                    upstream: null,
                    ahead: 0,
                    behind: 0,
                  }),
                `Switched to ${r.name}.`,
              ),
          },
          {
            label: `Show Only '${r.name}'`,
            run: () => setBranch(r.name),
          },
        ],
      });
    }
  };

  return (
    <div className="viewer log-page">
      <div className="viewer-bar log-bar">
        <select
          className="log-select"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          aria-label="Branch"
        >
          <option value="">All branches</option>
          <option value="HEAD">Current branch{branches?.current ? ` (${branches.current})` : ""}</option>
          {branches?.local.length ? (
            <optgroup label="Local">
              {branches.local.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {branches?.remote.length ? (
            <optgroup label="Remote">
              {branches.remote.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {branch && !branches?.local.some((b) => b.name === branch) &&
            !branches?.remote.some((b) => b.name === branch) && branch !== "HEAD" && (
              <option value={branch}>{branch}</option>
            )}
        </select>
        <input
          className="branch-filter log-filter"
          placeholder="Filter: message, author or hash"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && text) {
              e.preventDefault();
              setText("");
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              listRef.current?.focus();
            }
          }}
        />
        {path && (
          <span className="log-chip" title={path}>
            {basename(path)}
            <button aria-label="Show all files" onClick={() => setPath(null)}>
              ✕
            </button>
          </span>
        )}
        <button className="seg-btn log-refresh" onClick={() => setReload((r) => r + 1)} title="Refresh">
          ⟳
        </button>
        {(loading || busy) && <span className="changes-busy">{busy ? "Working…" : "Loading…"}</span>}
      </div>

      <div className="log-main">
        <div
          className="log-list"
          ref={listRef}
          tabIndex={0}
          onScroll={onScroll}
          onKeyDown={onListKey}
          role="listbox"
          aria-label="Commits"
        >
          {error && <div className="viewer-message error">{error}</div>}
          {!error && !loading && commits.length === 0 && (
            <div className="viewer-message">No commits match.</div>
          )}
          <div style={{ height: commits.length * ROW_H, position: "relative" }}>
            {commits.slice(first, last).map((c, k) => {
              const i = first + k;
              return (
                <div
                  key={c.id}
                  className="log-row"
                  role="option"
                  aria-selected={c.id === selected}
                  style={{ top: i * ROW_H, height: ROW_H }}
                  onMouseDown={() => setSelected(c.id)}
                  onDoubleClick={() => details?.files[0] && setFile(details.files[0])}
                  onContextMenu={(e) => commitMenu(e, c)}
                >
                  {showGraph && <GraphCell row={graph[i]} lanes={lanes} />}
                  <span className="log-subject">
                    {c.refs.map((r) => (
                      <span
                        key={r.kind + r.name}
                        className="log-ref"
                        data-kind={r.kind}
                        data-current={r.current}
                        title={r.kind === "tag" ? `Tag ${r.name}` : r.name}
                        onContextMenu={(e) => refMenu(e, r)}
                      >
                        {r.name}
                      </span>
                    ))}
                    {c.subject}
                  </span>
                  <span className="log-author">{c.author}</span>
                  <span className="log-date" title={fullDate(c.time)}>
                    {relativeTime(c.time)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="log-details">
          {details ? (
            <>
              <div className="log-message">
                <div className="log-message-subject">{details.message.split("\n")[0]}</div>
                {details.message.includes("\n") && (
                  <pre className="log-message-body">
                    {details.message.slice(details.message.indexOf("\n") + 1).trim()}
                  </pre>
                )}
              </div>
              <div className="log-meta">
                <code
                  className="log-hash"
                  title="Copy"
                  onClick={() => void navigator.clipboard.writeText(details.id).then(() => showToast("Copied."))}
                >
                  {details.id.slice(0, 10)}
                </code>{" "}
                {details.author} &lt;{details.email}&gt; · {fullDate(details.time)}
                {details.committer !== details.author && (
                  <div>Committed by {details.committer} · {fullDate(details.commitTime)}</div>
                )}
              </div>
              <div className="log-files" role="list">
                {details.files.map((f) => (
                  <button
                    key={f.path}
                    className="log-file"
                    role="listitem"
                    data-selected={f.path === file?.path}
                    onClick={() => setFile(f.path === file?.path ? null : f)}
                    title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                  >
                    <span className="tree-status" data-status={f.kind}>
                      {BADGE[f.kind]}
                    </span>
                    <span className="log-file-path">{f.rel}</span>
                  </button>
                ))}
                {details.files.length === 0 && <div className="modal-hint">No file changes.</div>}
              </div>
            </>
          ) : (
            <div className="viewer-message">{selected ? "Loading…" : "Select a commit."}</div>
          )}
        </div>
      </div>

      {file && details && (
        <div className="log-diff">
          <div className="viewer-bar">
            <span className="viewer-path" title={file.path}>
              {basename(file.path)}
            </span>
            <span className="viewer-status" data-status={file.kind}>
              {BADGE[file.kind]}
            </span>
            <span className="modal-hint">in {details.id.slice(0, 8)}</span>
            <DiffLayoutToggle />
            <button className="viewer-close" onClick={() => setFile(null)} title="Close diff">
              ✕
            </button>
          </div>
          <DiffViewer
            root={ROOT}
            path={file.path}
            layout={layout}
            refreshToken={0}
            commit={{ id: details.id, oldPath: file.oldPath }}
          />
        </div>
      )}

      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {dialogs}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function GraphCell({ row, lanes }: { row: GraphRow | undefined; lanes: number }) {
  if (!row) return <span className="log-graph" style={{ width: lanes * LANE_W }} />;
  const x = (col: number) => col * LANE_W + LANE_W / 2;
  const y = (f: number) => f * ROW_H;
  const mid = ROW_H / 2;
  return (
    <svg
      className="log-graph"
      width={lanes * LANE_W}
      height={ROW_H}
      aria-hidden="true"
    >
      {row.segments.map((s, i) =>
        s.x1 === s.x2 ? (
          <line
            key={i}
            x1={x(s.x1)}
            y1={y(s.y1)}
            x2={x(s.x2)}
            y2={y(s.y2)}
            style={{ stroke: `var(--graph-${s.color % GRAPH_COLORS})` }}
          />
        ) : (
          // A bend: leave one lane's column and settle into the other.
          <path
            key={i}
            d={`M${x(s.x1)} ${y(s.y1)} C${x(s.x1)} ${mid} ${x(s.x2)} ${mid} ${x(s.x2)} ${y(s.y2)}`}
            style={{ stroke: `var(--graph-${s.color % GRAPH_COLORS})` }}
          />
        ),
      )}
      <circle
        cx={x(row.col)}
        cy={mid}
        r={3.5}
        style={{ fill: `var(--graph-${row.color % GRAPH_COLORS})` }}
      />
    </svg>
  );
}
