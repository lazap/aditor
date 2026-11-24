import { describe, expect, it } from "vitest";
import { dropIndex, moveItem, tabShift, type Slot } from "./useTabReorder";

/** Tabs side by side from 0, of these widths. */
const strip = (...widths: number[]): Slot[] => {
  let left = 0;
  return widths.map((width) => {
    const s = { left, width };
    left += width;
    return s;
  });
};

describe("dropIndex", () => {
  const s = strip(100, 100, 100, 100);

  it("stays put until the middle of a neighbour is passed", () => {
    expect(dropIndex(s, 1, 0)).toBe(1);
    expect(dropIndex(s, 1, 49)).toBe(1);
    expect(dropIndex(s, 1, -49)).toBe(1);
  });

  it("moves right past each middle crossed", () => {
    expect(dropIndex(s, 1, 51)).toBe(2);
    expect(dropIndex(s, 1, 151)).toBe(3);
    expect(dropIndex(s, 0, 1000)).toBe(3);
  });

  it("moves left past each middle crossed", () => {
    expect(dropIndex(s, 2, -51)).toBe(1);
    expect(dropIndex(s, 2, -151)).toBe(0);
  });

  it("goes by the neighbour's middle when widths differ", () => {
    // A narrow tab dragged onto a wide one swaps once its edge is past the wide one's middle.
    const mixed = strip(40, 200);
    expect(dropIndex(mixed, 0, 99)).toBe(0);
    expect(dropIndex(mixed, 0, 101)).toBe(1);
  });
});

describe("tabShift", () => {
  const s = strip(100, 60, 100, 100);

  it("steps the tabs passed back by the dragged tab's width", () => {
    expect([0, 1, 2, 3].map((j) => tabShift(s, 1, 3, j))).toEqual([0, 0, -60, -60]);
    expect([0, 1, 2, 3].map((j) => tabShift(s, 1, 0, j))).toEqual([60, 0, 0, 0]);
  });

  it("leaves every tab alone while the dragged one has not moved", () => {
    expect([0, 1, 2, 3].map((j) => tabShift(s, 2, 2, j))).toEqual([0, 0, 0, 0]);
  });
});

describe("moveItem", () => {
  it("moves forwards and backwards", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the original alone", () => {
    const list = ["a", "b"];
    moveItem(list, 0, 1);
    expect(list).toEqual(["a", "b"]);
  });
});
