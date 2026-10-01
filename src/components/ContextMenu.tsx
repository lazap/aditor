import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | {
      label: string;
      run(): void;
      disabled?: boolean;
      danger?: boolean;
      /** Shown dim at the right, e.g. a chord. */
      hint?: string;
    }
  | "separator";

export interface MenuAt {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * A right-click menu with the agent menu's look. Fixed at the pointer, nudged
 * back inside the window when it would spill out. It closes on any click
 * outside, Escape or a pick, and returns focus to wherever it came from.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuAt; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    });
  }, [menu]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      before?.focus?.();
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    const all = Array.from(
      ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
    );
    const i = all.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = all[(i + 1) % all.length];
    else if (e.key === "ArrowUp") next = all[(i - 1 + all.length) % all.length];
    else if (e.key === "Home") next = all[0];
    else if (e.key === "End") next = all[all.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div
      ref={ref}
      className="agent-menu context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="agent-menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            className="agent-option"
            role="menuitem"
            data-danger={item.danger}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span className="agent-option-label">{item.label}</span>
            {item.hint && <span className="context-menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
