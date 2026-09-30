import { useEffect, useRef, useState } from "react";
import { BADGE, type ChangeKind, type FileStatus } from "../git/api";

/** The git write in flight, if any. One at a time, as the backend enforces. */
export type GitOp = "stage" | "commit" | "pull" | "push";

const BUSY_LABEL: Record<GitOp, string> = {
  stage: "Staging…",
  commit: "Committing…",
  pull: "Pulling…",
  push: "Pushing…",
};

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
  onStage(file: FileStatus): void;
  onUnstage(file: FileStatus): void;
  onStageAll(): void;
  onUnstageAll(): void;
  onCommit(): void;
  onPull(rebase: boolean): void;
  onPush(): void;
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
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onCommit,
  onPull,
  onPush,
}: Props) {
  const [pullMenu, setPullMenu] = useState(false);
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

  const rel = (path: string) =>
    path.startsWith(root) ? path.slice(root.length + 1) : path;

  const row = (
    f: FileStatus,
    kind: ChangeKind,
    act: { label: string; title: string; run(): void },
  ) => (
    <div
      key={f.path}
      className="tree-row changes-row"
      data-selected={f.path === selected}
      data-recent={recent.has(f.path)}
      onClick={() => onSelect(f.path)}
      title={f.oldPath ? `${rel(f.oldPath)} → ${f.path}` : f.path}
    >
      <span className="tree-status" data-status={kind}>
        {BADGE[kind]}
      </span>
      <span className="changes-path">{rel(f.path)}</span>
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
      </div>

      <div className="changes-body">
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
                  row(f, f.staged!, {
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
                  row(f, f.unstaged!, {
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
            placeholder="Commit message (⌘⏎ to commit)"
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
                staged.length === 0 ? "Stage changes to commit them" : "Commit"
              }
              onClick={onCommit}
            >
              Commit{staged.length > 0 && ` ${staged.length}`}
            </button>
            <div className="changes-pull">
              <button
                className="changes-tool"
                disabled={busy !== null}
                title={upstream ? `Pull from ${upstream}` : "Pull"}
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
              title={upstream ? `Push to ${upstream}` : "Push and set upstream"}
              onClick={onPush}
            >
              ↑{ahead > 0 && <span className="changes-tally">{ahead}</span>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
