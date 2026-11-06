import { useEffect, useRef } from "react";
import { keymap } from "./store";
import { eventChord } from "./keys";
import type { CommandId } from "./registry";

/**
 * The key event comes along for the handlers that care how long the chord is
 * held -- Dictate's push-to-talk. Menu items and buttons call without one.
 */
export type Handlers = Partial<Record<CommandId, (e?: KeyboardEvent) => void>>;

/**
 * The app's one keyboard listener.
 *
 * On `window`, so a chord fires wherever focus is -- including inside the
 * terminal, which declines the reserved ones without calling preventDefault
 * and so lets them bubble up to here.
 *
 * Handlers live in a ref: they close over App's state and change every render,
 * and re-registering the listener each time would be pointless churn.
 */
export function useShortcuts(handlers: Handlers): void {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chord = eventChord(e);
      if (chord === null) return;
      const id = keymap().get(chord);
      if (id === undefined) return;
      const run = ref.current[id];
      // An unhandled command is not ours to swallow: the chord may still mean
      // something to the webview.
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
