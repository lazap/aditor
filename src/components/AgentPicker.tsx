import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentInfo } from "../pty/api";

interface Props {
  agents: AgentInfo[];
  activeId: string | null;
  onPick(agent: AgentInfo): void;
}

/**
 * Topbar control for choosing which agent CLI the terminal hosts.
 *
 * A menu rather than a listbox: the agent rows are a single-choice group, but
 * the footer is a plain action, and `role="menu"` is the one container that
 * holds both honestly.
 */
export function AgentPicker({ agents, activeId, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = agents.find((a) => a.id === activeId) ?? null;

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  /** The menu's focusable rows, in visual order. */
  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );

  // Dismiss on an outside press. Listener only exists while the menu is open,
  // so a closed picker costs nothing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Land on the current agent when the menu opens. This also takes focus off
  // the terminal, which is what keeps xterm from swallowing the arrow keys --
  // its key handler only sees events while the canvas has focus.
  useEffect(() => {
    if (!open) return;
    const list = items();
    (list.find((b) => b.dataset.active === "true") ?? list[0])?.focus();
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const list = items();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = list[(i + 1) % list.length];
    else if (e.key === "ArrowUp") next = list[(i - 1 + list.length) % list.length];
    else if (e.key === "Home") next = list[0];
    else if (e.key === "End") next = list[list.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  // Re-picking the running agent is a no-op on purpose: onPick respawns, and
  // that would kill a live session and its scrollback. Restarting is the
  // separate, explicit item below.
  const pick = (agent: AgentInfo) => {
    close();
    if (agent.id !== activeId) onPick(agent);
  };

  return (
    <div className="agent-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        className="agent-trigger"
        data-open={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title={
          active
            ? (active.version ?? active.label)
            : "No coding agent found on PATH"
        }
      >
        <span className="agent-trigger-label">{active?.label ?? "No agent"}</span>
        <span className="agent-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className="agent-menu"
          role="menu"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {agents.map((a) => (
            <button
              key={a.id}
              className="agent-option"
              role="menuitemradio"
              aria-checked={a.id === activeId}
              data-active={a.id === activeId}
              disabled={!a.available}
              onClick={() => pick(a)}
            >
              <span className="agent-check" aria-hidden="true">
                {a.id === activeId ? "✓" : ""}
              </span>
              <span className="agent-option-text">
                <span className="agent-option-label">{a.label}</span>
                <span className="agent-option-meta">
                  {a.available ? (a.version ?? "installed") : "not installed"}
                </span>
              </span>
            </button>
          ))}

          {active && (
            <>
              <div className="agent-menu-sep" role="separator" />
              <button
                className="agent-option agent-restart"
                role="menuitem"
                onClick={() => {
                  close();
                  onPick(active);
                }}
              >
                <span className="agent-check" aria-hidden="true" />
                <span className="agent-option-text">
                  <span className="agent-option-label">
                    Restart {active.label}
                  </span>
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
