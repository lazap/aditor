import { useEffect, useRef } from "react";

/** IntelliJ's window for the second tap. */
const WINDOW_MS = 400;

/**
 * Shift tapped twice with nothing in between, as IntelliJ's Search Everywhere.
 *
 * A chord cannot say this -- it is two presses of a key that is otherwise only
 * a modifier -- so it lives beside the keymap rather than in it. Any other key
 * or a click between the taps cancels, which is what keeps typing two capitals
 * from setting it off.
 */
export class DoubleShift {
  /** When the last clean tap was released, or null after anything else. */
  private releasedAt: number | null = null;
  /** Shift is down and nothing else has happened since. */
  private clean = false;

  /** Feed a keydown; true when it is the second tap. */
  keydown(e: KeyboardEvent, now: number): boolean {
    if (e.key !== "Shift" || e.metaKey || e.ctrlKey || e.altKey) {
      this.reset();
      return false;
    }
    if (e.repeat) return false;
    if (this.releasedAt !== null && now - this.releasedAt <= WINDOW_MS) {
      this.reset();
      return true;
    }
    this.releasedAt = null;
    this.clean = true;
    return false;
  }

  keyup(e: KeyboardEvent, now: number): void {
    if (e.key === "Shift" && this.clean) this.releasedAt = now;
    this.clean = false;
  }

  reset(): void {
    this.releasedAt = null;
    this.clean = false;
  }
}

/**
 * Run `fire` on a double Shift anywhere in the window.
 *
 * Bubble phase, like the chords: a dialog that stops its keys from reaching
 * the app stops this too, and the terminal lets a bare Shift through.
 */
export function useDoubleShift(fire: () => void): void {
  const ref = useRef(fire);
  useEffect(() => {
    ref.current = fire;
  });

  useEffect(() => {
    const detector = new DoubleShift();
    const onDown = (e: KeyboardEvent) => {
      if (detector.keydown(e, e.timeStamp)) ref.current();
    };
    const onUp = (e: KeyboardEvent) => detector.keyup(e, e.timeStamp);
    const reset = () => detector.reset();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("mousedown", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("mousedown", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);
}
