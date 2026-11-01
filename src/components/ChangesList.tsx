import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { BADGE, type ChangeKind, type FileStatus, type RepoOperation } from "../git/api";
import { formatChord } from "../shortcuts/keys";
import { chordFor, chordHint } from "../shortcuts/store";
import { ContextMenu, type MenuAt } from "./ContextMenu";

/** The git write in flight, if any. One at a time, as the backend enforces. */
export type GitOp =
  | "stage"
  | "commit"
  | "pull"
  | "push"
  | "checkout"
  | "fetch"
  | "rollback"
  | "branch"
  | "merge"
  | "rebase"
  | "history"
  | "tag"
  | "operation";

const BUSY_LABEL: Record<GitOp, string> = {
  stage: "Staging…",
  commit: "Committing…",
  pull: "Pulling…",
  push: "Pushing…",
  checkout: "Switching branch…",
  fetch: "Fetching…",
  rollback: "Rolling back…",
  branch: "Updating branches…",
  merge: "Merging…",
  rebase: "Rebasing…",
  history: "Rewriting history…",
  tag: "Tagging…",
  operation: "Finishing…",
};

const OPERATION_LABEL: Record<RepoOperation, string> = {
  merge: "Merge",
  rebase: "Rebase",
  cherryPick: "Cherry-pick",
  revert: "Revert",
};

/** A shortcut request from App, aimed at whatever the list's cursor is on. */
export interface ListRequest {
  kind: "rollback" | "diff";
  token: number;
}

interface Props {
  files: FileStatus[];
  root: string;
  isRepo: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  selected: string | null;
  /** Paths the watcher saw move recently -- highlighted, then fades. */
  recent: Set<string>;
  onSelect(path: string): void;

  /** Kept by App, so a refresh or a collapse does not lose a half-typed one. */
  message: string;
  onMessage(message: string): void;
  busy: GitOp | null;
  /**
   * Bumped by the commit shortcut: focuses the message box, or commits when
   * the box already has the caret and there is something to commit.
   */
  commitRequest: number;
  /** Bumped by ⌘⇧C: puts the keyboard cursor on the list. */
  focusToken: number;
  onStage(file: FileStatus): void;
  onUnstage(file: FileStatus): void;
  onStageAll(): void;
  onUnstageAll(): void;
  onCommit(): void;
  onPull(rebase: boolean): void;
  onPush(): void;
  onRollback(files: FileStatus[]): void;
  /** The log, filtered to this file's history. */
  onHistory(path: string): void;
  /** A merge/rebase/cherry-pick/revert waiting on the user, if any. */
  operation: RepoOperation | null;
  onContinue(): void;
  onAbort(): void;
  /** ⌘⌥Z / ⌘D: act on the row under the cursor when the list has focus. */
  request: ListRequest | null;
  /** Nothing in the list to act on: App falls back to the open file. */
  onRequestUnhandled(kind: ListRequest["kind"]): void;
}

/**
 * The rail's Git tab: changed files, and the write loop that goes with them --
 * stage, commit, pull, push. The fastest answer to "what did the agent
 * touch?" -- and to shipping it.
 *
 * The list scrolls at the top; the commit box and sync tools stay pinned at
 * the foot, where the eye lands once it has read down the list.
 */
export function ChangesList({
  files,
  root,
  isRepo,
  upstream,
  ahead,
  behind,
  selected,
  recent,
  onSelect,
  message,
  onMessage,
  busy,
  commitRequest,
  focusToken,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onCommit,
  onPull,
  onPush,
  onRollback,
  onHistory,
  operation,
  onContinue,
  onAbort,
  request,
  onRequestUnhandled,
}: Props) {
  const [pullMenu, setPullMenu] = useState(false);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const box = useRef<HTMLTextAreaElement>(null);

  const staged = files.filter((f) => f.staged !== null);
  const unstaged = files.filter((f) => f.unstaged !== null);
  const canCommit = busy === null && staged.length > 0 && message.trim() !== "";

  // Read through a ref: the request is an event, and re-running on every
  // change to what it checks would commit as soon as the message was typed.
  const latest = useRef({ canCommit, onCommit });
  latest.current = { canCommit, onCommit };
  useEffect(() => {
    if (commitRequest === 0) return;
    if (document.activeElement === box.current && latest.current.canCommit) {
      latest.current.onCommit();
      return;
    }
    // After the tab switch has shown the box.
    requestAnimationFrame(() => box.current?.focus());
  }, [commitRequest]);

  // The keyboard cursor. Keyed by section as well as path: a partly staged
  // file is a row in both lists.
  const rows = useMemo(
    () => [
      ...staged.map((f) => ({ key: `s:${f.path}`, f })),
      ...unstaged.map((f) => ({ key: `u:${f.path}`, f })),
    ],
    [staged, unstaged],
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Exactly one row is tabbable, so the list is a single tab stop and the
  // arrow keys move within it -- as in the file tree.
  const tabTarget =
    (cursor && rows.some((r) => r.key === cursor) && cursor) ||
    rows.find((r) => r.f.path === selected)?.key ||
    rows[0]?.key ||
    null;

  const focusRow = useCallback((key: string) => {
    setCursor(key);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      ?.focus();
  }, []);

  // Staging moves a row to the other section, and unmounting the focused row
  // drops focus on the body. Put it back at the same index, so arrowing down
  // the list staging as you go keeps working.
  const lastRows = useRef(rows);
  useEffect(() => {
    const prev = lastRows.current;
    lastRows.current = rows;
    if (!cursor || rows.some((r) => r.key === cursor)) return;
    const was = prev.findIndex((r) => r.key === cursor);
    const next = rows[Math.min(was < 0 ? 0 : was, rows.length - 1)];
    const active = document.activeElement;
    const hadFocus =
      active === document.body || !!listRef.current?.contains(active);
    if (!next) setCursor(null);
    else if (hadFocus) focusRow(next.key);
    else setCursor(next.key);
  }, [rows, cursor, focusRow]);

  // ⌘⇧C. Compared against the last value, as FileTree does, so a remount never
  // takes the caret on its own. `tabTarget` is read through an effect event:
  // this must fire on the token alone.
  const takeFocus = useEffectEvent(() => {
    if (tabTarget) focusRow(tabTarget);
    else listRef.current?.focus();
  });
  const lastFocusToken = useRef(focusToken);
  useEffect(() => {
    if (focusToken === lastFocusToken.current) return;
    lastFocusToken.current = focusToken;
    takeFocus();
  }, [focusToken]);

  // ⌘⌥Z and ⌘D, as in IntelliJ's commit window: on the row under the cursor
  // while the list has focus. Anywhere else App picks the target. Fires on the
  // token alone; everything else is read as it is now.
  const handleRequest = useEffectEvent((kind: ListRequest["kind"]) => {
    const focused = !!listRef.current?.contains(document.activeElement);
    const at = focused ? rows.find((r) => r.key === tabTarget) : undefined;
    if (kind === "diff") {
      if (at) onSelect(at.f.path);
      else onRequestUnhandled("diff");
    } else if (at) onRollback([at.f]);
    else onRequestUnhandled("rollback");
  });
  const lastRequest = useRef(request?.token ?? 0);
  useEffect(() => {
    if (!request || request.token === lastRequest.current) return;
    lastRequest.current = request.token;
    handleRequest(request.kind);
  }, [request]);

  const openMenu = (e: React.MouseEvent, f: FileStatus, key: string, staged: boolean) => {
    e.preventDefault();
    setCursor(key);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Show Diff", hint: hint("git.showDiff"), run: () => onSelect(f.path) },
        {
          label: "Rollback…",
          hint: hint("git.rollback"),
          disabled: busy !== null,
          run: () => onRollback([f]),
        },
        staged
          ? { label: "Unstage", disabled: busy !== null, run: () => onUnstage(f) }
          : { label: "Stage", disabled: busy !== null, run: () => onStage(f) },
        "separator",
        { label: "Show History", run: () => onHistory(f.path) },
      ],
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Enter on a row's stage button is the button's.
    if ((e.target as HTMLElement).closest("button")) return;
    const at = rows.findIndex((r) => r.key === tabTarget);
    const step = (to: number) => {
      const next = rows[Math.max(0, Math.min(to, rows.length - 1))];
      if (next) focusRow(next.key);
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
        step(rows.length - 1);
        break;
      case "Enter":
      case " ":
        if (at < 0) return;
        onSelect(rows[at].f.path);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const rel = (path: string) =>
    path.startsWith(root) ? path.slice(root.length + 1) : path;

  const row = (
    key: string,
    f: FileStatus,
    kind: ChangeKind,
    act: { label: string; title: string; run(): void },
  ) => (
    <div
      key={key}
      className="tree-row changes-row"
      tabIndex={key === tabTarget ? 0 : -1}
      data-key={key}
      data-cursor={key === tabTarget}
      data-selected={f.path === selected}
      data-recent={recent.has(f.path)}
      onClick={(e) => {
        // Explicitly, as in FileTree: WKWebView does not reliably focus a
        // div[tabindex] on mousedown.
        setCursor(key);
        e.currentTarget.focus();
        onSelect(f.path);
      }}
      onContextMenu={(e) => openMenu(e, f, key, key.startsWith("s:"))}
      title={f.oldPath ? `${rel(f.oldPath)} → ${f.path}` : f.path}
    >
      <span className="tree-status" data-status={kind}>
        {BADGE[kind]}
      </span>
      <span className="changes-path">{rel(f.path)}</span>
      <button
        className="changes-act"
        title="Rollback"
        aria-label={`Rollback: ${rel(f.path)}`}
        disabled={busy !== null}
        onClick={(e) => {
          e.stopPropagation();
          onRollback([f]);
        }}
      >
        ↺
      </button>
      <button
        className="changes-act"
        title={act.title}
        aria-label={`${act.title}: ${rel(f.path)}`}
        disabled={busy !== null}
        onClick={(e) => {
          e.stopPropagation();
          act.run();
        }}
      >
        {act.label}
      </button>
    </div>
  );

  return (
    <div className="changes">
      <div className="changes-header" role="heading" aria-level={2}>
        Changes
        {isRepo && <span className="changes-count">{files.length}</span>}
        {isRepo && files.length > 0 && (
          <button
            className="changes-act changes-header-act"
            title={tip("Rollback all changes", "git.rollback")}
            aria-label="Rollback all changes"
            disabled={busy !== null}
            onClick={() => onRollback(files)}
          >
            ↺
          </button>
        )}
      </div>

      {operation && (
        <div className="changes-operation" role="status">
          <span>
            {OPERATION_LABEL[operation]} in progress
            {files.some((f) => f.status === "conflicted")
              ? " — resolve the conflicts (!) and stage them."
              : "."}
          </span>
          <div className="changes-operation-actions">
            <button disabled={busy !== null} onClick={onContinue}>
              Continue
            </button>
            <button disabled={busy !== null} onClick={onAbort}>
              Abort
            </button>
          </div>
        </div>
      )}

      <div
        className="changes-body"
        tabIndex={-1}
        ref={listRef}
        onKeyDown={onKeyDown}
      >
        {!isRepo ? (
          <div className="changes-empty">Not a git repository</div>
        ) : files.length === 0 ? (
          <div className="changes-empty">No changes</div>
        ) : (
          <>
            {staged.length > 0 && (
              <>
                <div className="changes-section">
                  Staged
                  <span className="changes-count">{staged.length}</span>
                  <button
                    className="changes-act"
                    title="Unstage all"
                    aria-label="Unstage all"
                    disabled={busy !== null}
                    onClick={onUnstageAll}
                  >
                    −
                  </button>
                </div>
                {staged.map((f) =>
                  row(`s:${f.path}`, f, f.staged!, {
                    label: "−",
                    title: "Unstage",
                    run: () => onUnstage(f),
                  }),
                )}
              </>
            )}
            {unstaged.length > 0 && (
              <>
                <div className="changes-section">
                  Unstaged
                  <span className="changes-count">{unstaged.length}</span>
                  <button
                    className="changes-act"
                    title="Stage all"
                    aria-label="Stage all"
                    disabled={busy !== null}
                    onClick={onStageAll}
                  >
                    +
                  </button>
                </div>
                {unstaged.map((f) =>
                  row(`u:${f.path}`, f, f.unstaged!, {
                    label: "+",
                    title: "Stage",
                    run: () => onStage(f),
                  }),
                )}
              </>
            )}
          </>
        )}
      </div>

      {isRepo && (
        <div className="changes-commit">
          <textarea
            ref={box}
            className="changes-message"
            placeholder={`Commit message (${formatChord("mod+enter")} to commit)`}
            rows={2}
            value={message}
            spellCheck={false}
            onChange={(e) => onMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canCommit) onCommit();
              }
            }}
          />
          {busy && <span className="changes-busy">{BUSY_LABEL[busy]}</span>}
          <div className="changes-actions">
            <button
              className="changes-commit-btn"
              disabled={!canCommit}
              title={
                staged.length === 0
                  ? "Stage changes to commit them"
                  : tip("Commit", "git.commit")
              }
              onClick={onCommit}
            >
              Commit{staged.length > 0 && ` ${staged.length}`}
            </button>
            <div className="changes-pull">
              <button
                className="changes-tool"
                disabled={busy !== null}
                title={tip(upstream ? `Pull from ${upstream}` : "Pull", "git.pull")}
                onClick={() => onPull(false)}
              >
                ↓{behind > 0 && <span className="changes-tally">{behind}</span>}
              </button>
              <button
                className="changes-tool changes-tool-more"
                disabled={busy !== null}
                title="Pull options"
                aria-haspopup="menu"
                aria-expanded={pullMenu}
                onClick={() => setPullMenu((m) => !m)}
                onBlur={() => setPullMenu(false)}
              >
                ▾
              </button>
              {pullMenu && (
                <div className="changes-menu" role="menu">
                  {/* onMouseDown: the button's blur would close the menu before
                      a click on it could land. */}
                  <button
                    role="menuitem"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setPullMenu(false);
                      onPull(false);
                    }}
                  >
                    Pull (merge)
                  </button>
                  <button
                    role="menuitem"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setPullMenu(false);
                      onPull(true);
                    }}
                  >
                    Pull with rebase
                  </button>
                </div>
              )}
            </div>
            <button
              className="changes-tool"
              disabled={busy !== null}
              title={tip(
                upstream ? `Push to ${upstream}…` : "Push and set upstream…",
                "git.push",
              )}
              onClick={onPush}
            >
              ↑{ahead > 0 && <span className="changes-tally">{ahead}</span>}
            </button>
          </div>
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </div>
  );
}

/** A chord's glyphs for a menu row, or nothing when the command is unbound. */
function hint(id: Parameters<typeof chordFor>[0]): string | undefined {
  const chord = chordFor(id);
  return chord ? formatChord(chord) : undefined;
}

const tip = chordHint;
