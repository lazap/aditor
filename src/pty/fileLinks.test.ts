import { describe, expect, it } from "vitest";
import { findCandidates } from "./fileLinks";

const paths = (text: string) => findCandidates(text).map((c) => [c.path, c.line]);

describe("findCandidates", () => {
  it("finds relative, dotted and absolute paths with their line", () => {
    expect(paths("see src/a.ts:12:3 and ./b.rs(4,2) and /abs/c.py")).toEqual([
      ["src/a.ts", 12],
      ["./b.rs", 4],
      ["/abs/c.py", undefined],
    ]);
  });

  it("drops a sentence's full stop from a path", () => {
    const [c] = findCandidates("edited src/a.ts.");
    expect(c.path).toBe("src/a.ts");
    expect(c.text).toBe("src/a.ts");
  });

  it("does not start a match mid-token", () => {
    expect(paths("a/b.ts")).toEqual([["a/b.ts", undefined]]);
  });

  it("ignores words that do not look like paths", () => {
    expect(paths("plain words here")).toEqual([]);
  });

  it("finds Windows paths, drive and all, without taking the drive for a line", () => {
    expect(paths("at src\\a.ts:12 and C:\\proj\\b.rs(4,2) and D:/c.py")).toEqual([
      ["src\\a.ts", 12],
      ["C:\\proj\\b.rs", 4],
      ["D:/c.py", undefined],
    ]);
  });

  it("reports where each match starts", () => {
    expect(findCandidates("x src/a.ts")[0].start).toBe(2);
  });
});
