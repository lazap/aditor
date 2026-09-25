import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  /** Fraction of height given to the top pane, 0..1. */
  initial: number;
  min?: number;
  max?: number;
  onCommit(fraction: number): void;
  top: React.ReactNode;
  /** null collapses the split: the top pane takes the full height. */
  bottom: React.ReactNode | null;
}

/**
 * Vertical split with a draggable divider. Stacked rather than side-by-side so
 * the terminal keeps its full column count -- agent TUIs are far more sensitive
 * to width than height.
 *
 * The collapsed state is handled *here*, by rendering the divider and bottom
 * pane conditionally, rather than by the caller swapping between a bare
 * terminal and a split one. That distinction matters a lot: `top` must keep the
 * same position in the element tree whether or not a file is open, or React
 * unmounts it -- and unmounting TerminalPane kills the PTY, so opening a file
 * would restart the agent and lose the conversation.
 */
export function SplitPane({
  initial,
  min = 0.2,
  max = 0.85,
  onCommit,
  top,
  bottom,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [fraction, setFraction] = useState(initial);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const move = (e: PointerEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const next = (e.clientY - rect.top) / rect.height;
      setFraction(Math.min(max, Math.max(min, next)));
    };
    const up = () => {
      setDragging(false);
      setFraction((f) => {
        onCommit(f);
        return f;
      });
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, min, max, onCommit]);

  const split = bottom !== null;

  return (
    <div className="split" ref={wrapRef} data-dragging={dragging}>
      <div
        className="split-top"
        style={{ flexBasis: split ? `${fraction * 100}%` : "100%" }}
      >
        {top}
      </div>
      {split && (
        <div
          className="split-divider"
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onPointerDown}
        />
      )}
      {split && <div className="split-bottom">{bottom}</div>}
    </div>
  );
}
