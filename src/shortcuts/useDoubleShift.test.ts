import { describe, expect, it } from "vitest";
import { DoubleShift } from "./useDoubleShift";

const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: k, repeat: false, metaKey: false, ctrlKey: false, altKey: false, ...extra }) as KeyboardEvent;

/** Taps Shift at `at`, released 50 ms later; true if the press fired. */
const tap = (d: DoubleShift, at: number) => {
  const fired = d.keydown(key("Shift"), at);
  d.keyup(key("Shift"), at + 50);
  return fired;
};

describe("DoubleShift", () => {
  it("fires on the second quick tap", () => {
    const d = new DoubleShift();
    expect(tap(d, 0)).toBe(false);
    expect(tap(d, 200)).toBe(true);
  });

  it("does not fire when the taps are too far apart", () => {
    const d = new DoubleShift();
    tap(d, 0);
    expect(tap(d, 1000)).toBe(false);
    // ...but that late tap starts a new pair.
    expect(tap(d, 1200)).toBe(true);
  });

  it("does not fire for Shift used to type a capital", () => {
    const d = new DoubleShift();
    d.keydown(key("Shift"), 0);
    d.keydown(key("A", { shiftKey: true }), 20);
    d.keyup(key("Shift"), 60);
    expect(tap(d, 150)).toBe(false);
  });

  it("is cancelled by a key between the taps", () => {
    const d = new DoubleShift();
    tap(d, 0);
    d.keydown(key("a"), 100);
    expect(tap(d, 200)).toBe(false);
  });

  it("ignores key repeat and Shift held with another modifier", () => {
    const d = new DoubleShift();
    tap(d, 0);
    expect(d.keydown(key("Shift", { metaKey: true }), 100)).toBe(false);
    const e = new DoubleShift();
    e.keydown(key("Shift"), 0);
    expect(e.keydown(key("Shift", { repeat: true }), 30)).toBe(false);
  });

  it("starts over after firing", () => {
    const d = new DoubleShift();
    tap(d, 0);
    expect(tap(d, 100)).toBe(true);
    expect(tap(d, 200)).toBe(false);
  });
});
