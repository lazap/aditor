import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";

/**
 * Reordering a strip's tabs by dragging them, as in a browser.
 *
 * Pointer events rather than HTML5 drag and drop, as in the file tree: the
 * Tauri webview's file-drop handling does not reliably let HTML5 drops
 * through. The handlers sit on the strip, which must be what scrolls; each tab
 * carries a group and its index within it. A tab only moves within its own
 * group -- sessions among sessions, files among files.
 */

/** How far a press travels before it is a drag rather than a click. */
const DRAG_SLOP = 4;
/** Within this of the strip's edge a drag scrolls it. */
const EDGE = 24;

/** A tab's place along the strip, in the strip's scrolled coordinates. */
export interface Slot {
  left: number;
  width: number;
}

/**
 * Where the dragged tab lands, as its index once the list is reordered: it has
 * passed a neighbour once its leading edge crosses that neighbour's middle.
 */
export function dropIndex(slots: readonly Slot[], from: number, dx: number): number {
  const left = slots[from].left + dx;
  const right = left + slots[from].width;
  let to = from;
  slots.forEach((s, j) => {
    const mid = s.left + s.width / 2;
    if (j > from && right > mid) to++;
    if (j < from && left < mid) to--;
  });
  return to;
}

/** How far tab `j` steps aside to make room while `from` hovers at `to`. */
export function tabShift(slots: readonly Slot[], from: number, to: number, j: number): number {
  const w = slots[from].width;
  if (from < to && j > from && j <= to) return -w;
  if (to < from && j >= to && j < from) return w;
  return 0;
}

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

interface Drag {
  group: string;
  from: number;
  to: number;
  /** How far the dragged tab is from where it started. */
  dx: number;
}

export function useTabReorder(onReorder: (group: string, from: number, to: number) => void) {
  /** A press on a tab, which becomes a drag once it travels DRAG_SLOP. */
  const press = useRef<{ group: string; from: number; x: number; y: number; scroll: number } | null>(
    null,
  );
  /** The group's tabs as they stood when the drag began. */
  const slots = useRef<Slot[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Set by a drop, so the click that ends it does not also select a tab. */
  const dropped = useRef(false);

  const end = () => {
    press.current = null;
    setDrag(null);
  };

  // Escape abandons a drag wherever the keyboard is.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      press.current = null;
      setDrag(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    dropped.current = false;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const target = e.target as Element;
    // The close button is pressed, not dragged.
    if (target.closest("button")) return;
    const tab = target.closest<HTMLElement>("[data-reorder-group]");
    if (!tab || !e.currentTarget.contains(tab)) return;
    press.current = {
      group: tab.dataset.reorderGroup!,
      from: Number(tab.dataset.reorderIndex),
      x: e.clientX,
      y: e.clientY,
      scroll: e.currentTarget.scrollLeft,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    const strip = e.currentTarget;
    if (!drag) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
      // Captured, so the drag keeps tracking when the pointer leaves the strip.
      strip.setPointerCapture(e.pointerId);
      const box = strip.getBoundingClientRect();
      slots.current = [
        ...strip.querySelectorAll<HTMLElement>(`[data-reorder-group="${p.group}"]`),
      ].map((el) => {
        const r = el.getBoundingClientRect();
        // No tab carries a transform before the drag, so these are where they rest.
        return { left: r.left - box.left + strip.scrollLeft, width: r.width };
      });
    }
    const box = strip.getBoundingClientRect();
    if (e.clientX < box.left + EDGE) strip.scrollLeft -= 8;
    else if (e.clientX > box.right - EDGE) strip.scrollLeft += 8;

    // Kept inside the group's own stretch of the strip.
    const s = slots.current;
    const first = s[0];
    const last = s[s.length - 1];
    const raw = e.clientX - p.x + (strip.scrollLeft - p.scroll);
    const dx = Math.min(
      last.left + last.width - (s[p.from].left + s[p.from].width),
      Math.max(first.left - s[p.from].left, raw),
    );
    setDrag({ group: p.group, from: p.from, to: dropIndex(s, p.from, dx), dx });
  };

  const onPointerUp = () => {
    const d = drag;
    end();
    if (!d) return;
    dropped.current = true;
    if (d.to !== d.from) onReorder(d.group, d.from, d.to);
  };

  /** Swallows the click a drop ends with. */
  const onClickCapture = (e: MouseEvent) => {
    if (!dropped.current) return;
    dropped.current = false;
    e.stopPropagation();
  };

  /** The attributes for tab `index` of `group`. */
  const tab = (group: string, index: number) => {
    let style: CSSProperties | undefined;
    if (drag?.group === group) {
      const x =
        index === drag.from ? drag.dx : tabShift(slots.current, drag.from, drag.to, index);
      if (x !== 0) style = { transform: `translateX(${x}px)` };
    }
    return {
      "data-reorder-group": group,
      "data-reorder-index": index,
      "data-dragged": drag?.group === group && drag.from === index,
      style,
    };
  };

  return {
    /** Spread on the strip that holds the tabs and scrolls. */
    strip: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: end,
      onClickCapture,
      "data-reordering": dragging,
    },
    tab,
  };
}
