import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../pty/api";
import type { Attention } from "../notify/api";
import { chordHint } from "../shortcuts/store";

export interface SessionTab {
  key: number;
  label: string;
  /** The agent has exited and the tab shows its overlay. */
  exited: boolean;
  /** The agent is mid-turn. */
  busy: boolean;
  /** It finished, or is blocked on the user, while you were elsewhere. */
  attention: Attention | null;
}

interface Props {
  tabs: SessionTab[];
  activeKey: number | null;
  /** What a new session can be: the installed agents, then a plain terminal. */
  choices: AgentInfo[];
  /** Bumped by the new-session shortcut: the menu opens as if + was clicked. */
  newRequest: number;
  onSelect(key: number): void;
  onClose(key: number): void;
  onNew(choice: AgentInfo): void;
  /** Claude Code in a new worktree; absent outside a git repo or without Claude. */
  onNewWorktree?(): void;
}

/**
 * The sessions of one project, above its terminal -- IntelliJ's terminal tool
 * window tabs. Every session keeps running while another is shown; this strip
 * only chooses which one is on screen, and + asks what the next one runs.
 */
export function SessionTabs({
  tabs,
  activeKey,
  choices,
  newRequest,
  onSelect,
  onClose,
  onNew,
  onNewWorktree,
}: Props) {
  const [open, setOpen] = useState(false);
  /** The row arrows move and Enter picks. */
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  const options: { key: string; label: string; meta: string; pick(): void }[] = [
    ...choices.map((c) => ({
      key: c.id,
      label: c.label,
      meta: c.command === null ? "shell in this folder" : (c.version ?? "agent"),
      pick: () => onNew(c),
    })),
    ...(onNewWorktree
      ? [
          {
            key: "worktree",
            label: "Claude Code in new worktree",
            meta: "own branch and folder, in a new tab",
            pick: onNewWorktree,
          },
        ]
      : []),
  ];

  useEffect(() => {
    if (newRequest > 0) setOpen(true);
  }, [newRequest]);

  // Each opening starts on the first choice.
  useEffect(() => {
    if (open) setHighlight(0);
  }, [open]);

  // Dismiss on an outside press; the listener only exists while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The keys are taken on the window, in the capture phase, rather than from
  // a focused row: the terminal keeps or takes back the caret, and its own
  // handler would otherwise eat the arrows and send Enter to the agent.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const list = optionsRef.current;
      let handled = true;
      if (e.key === "Escape") {
        close();
        triggerRef.current?.focus();
      } else if (e.key === "ArrowDown" && list.length > 0) {
        setHighlight((i) => (i + 1) % list.length);
      } else if (e.key === "ArrowUp" && list.length > 0) {
        setHighlight((i) => (i - 1 + list.length) % list.length);
      } else if (e.key === "Enter" && !e.isComposing) {
        close();
        list[highlightRef.current]?.pick();
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  return (
    <div className="session-tabs">
      <div className="session-tab-list" role="tablist" aria-label="Sessions">
        {tabs.map((t) => (
          <div
            key={t.key}
            className="session-tab"
            role="tab"
            aria-selected={t.key === activeKey}
            data-exited={t.exited}
            title={
              t.exited
                ? `${t.label} (exited)`
                : t.attention === "waiting"
                  ? `${t.label} (needs you)`
                  : t.attention === "done"
                    ? `${t.label} (finished)`
                    : t.label
            }
            onClick={() => onSelect(t.key)}
            // Middle-click closes, as in a browser or an IDE.
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              onClose(t.key);
            }}
          >
            {t.attention ? (
              <span className="session-tab-dot" data-attention={t.attention} aria-hidden />
            ) : (
              t.busy && <span className="session-tab-busy" aria-hidden />
            )}
            <span className="session-tab-label">{t.label}</span>
            <button
              className="session-tab-close"
              aria-label={`Close ${t.label}`}
              title={chordHint("Close session", "session.close")}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.key);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Outside the scrolling list, so the menu is not clipped by it. */}
      <div className="session-new" ref={wrapRef}>
        <button
          ref={triggerRef}
          className="session-tab-new"
          data-open={open}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={chordHint("New session", "session.new")}
          aria-label="New session"
        >
          +
        </button>
        {open && (
          <div className="agent-menu session-menu" role="menu">
            {options.map((o, i) => (
              <button
                key={o.key}
                className="agent-option"
                role="menuitem"
                tabIndex={-1}
                data-highlighted={i === highlight}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => {
                  close();
                  o.pick();
                }}
              >
                <span className="agent-option-text">
                  <span className="agent-option-label">{o.label}</span>
                  <span className="agent-option-meta">{o.meta}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
