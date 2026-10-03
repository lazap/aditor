import { useCallback, useEffect, useRef, useState } from "react";
import { chordHint } from "../shortcuts/store";
import { typeInfo, type RunConfig } from "../run/schema";

interface Props {
  configs: RunConfig[];
  selected: RunConfig | null;
  /** Instances of the selected configuration still running. */
  running: number;
  /** Bumped by "Choose run configuration…": the menu opens. */
  openRequest: number;
  onSelect(id: string): void;
  onRun(): void;
  onStop(): void;
  onEdit(): void;
}

/**
 * IntelliJ's run widget: which configuration, then Run and Stop. The menu is
 * the agent picker's -- same shell, same rows, same keyboard -- with Edit
 * Configurations… as its footer.
 */
export function RunPicker({
  configs,
  selected,
  running,
  openRequest,
  onSelect,
  onRun,
  onStop,
  onEdit,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Land on the selected row, which also takes focus off the terminal so the
  // arrow keys reach the menu.
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

  if (configs.length === 0) {
    return (
      <div className="run-picker">
        <button className="agent-trigger run-trigger" onClick={onEdit} title="Add a run configuration">
          <span className="run-add" aria-hidden="true">
            ▶
          </span>
          <span className="agent-trigger-label">Add Configuration…</span>
        </button>
      </div>
    );
  }

  const rerun = running > 0 && selected?.singleInstance;

  return (
    <div className="run-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        className="agent-trigger run-trigger"
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
        title={chordHint("Run configuration", "run.choose")}
      >
        {selected && (
          <span className="run-type" aria-hidden="true">
            {typeInfo(selected.type).icon}
          </span>
        )}
        <span className="agent-trigger-label">{selected?.name ?? "Choose configuration"}</span>
        <span className="agent-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <button
        className="run-button"
        data-kind="run"
        disabled={!selected}
        onClick={onRun}
        title={chordHint(rerun ? `Rerun ${selected?.name}` : `Run ${selected?.name ?? ""}`, "run.run")}
        aria-label={rerun ? "Rerun" : "Run"}
      >
        {rerun ? "↻" : "▶"}
      </button>
      {running > 0 && (
        <button
          className="run-button"
          data-kind="stop"
          onClick={onStop}
          title={chordHint(`Stop ${selected?.name}`, "run.stop")}
          aria-label="Stop"
        >
          ■
        </button>
      )}

      {open && (
        <div className="agent-menu run-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          {configs.map((c) => (
            <button
              key={c.id}
              className="agent-option"
              role="menuitemradio"
              aria-checked={c.id === selected?.id}
              data-active={c.id === selected?.id}
              onClick={() => {
                close();
                onSelect(c.id);
              }}
            >
              <span className="agent-check" aria-hidden="true">
                {c.id === selected?.id ? "✓" : ""}
              </span>
              <span className="run-type" aria-hidden="true">
                {typeInfo(c.type).icon}
              </span>
              <span className="agent-option-text">
                <span className="agent-option-label">{c.name}</span>
              </span>
            </button>
          ))}
          <div className="agent-menu-sep" role="separator" />
          <button
            className="agent-option"
            role="menuitem"
            onClick={() => {
              close();
              onEdit();
            }}
          >
            <span className="agent-check" aria-hidden="true" />
            <span className="agent-option-text">
              <span className="agent-option-label">Edit Configurations…</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
