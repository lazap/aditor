import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../pty/api";
import { chordHint } from "../shortcuts/store";

export interface SessionTab {
  key: number;
  label: string;
  /** The agent has exited and the tab shows its overlay. */
  exited: boolean;
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
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (newRequest > 0) setOpen(true);
  }, [newRequest]);

  // Dismiss on an outside press; the listener only exists while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Land on the first choice. This also takes focus off the terminal, whose
  // key handler would otherwise swallow the arrow keys.
  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      triggerRef.current?.focus();
      return;
    }
    const list = items();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = list[(i + 1) % list.length];
    else if (e.key === "ArrowUp") next = list[(i - 1 + list.length) % list.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

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
            title={t.exited ? `${t.label} (exited)` : t.label}
            onClick={() => onSelect(t.key)}
            // Middle-click closes, as in a browser or an IDE.
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              onClose(t.key);
            }}
          >
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
          <div className="agent-menu session-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
            {choices.map((c) => (
              <button
                key={c.id}
                className="agent-option"
                role="menuitem"
                onClick={() => {
                  close();
                  onNew(c);
                }}
              >
                <span className="agent-option-text">
                  <span className="agent-option-label">{c.label}</span>
                  <span className="agent-option-meta">
                    {c.command === null ? "shell in this folder" : (c.version ?? "agent")}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
