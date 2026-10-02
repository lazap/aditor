import { describe, expect, it } from "vitest";
import { contextFrom, resolve, scan } from "./placeholders";

const ctx = { file: "src/a.ts", project: "aditor", branch: "main" };

describe("scan", () => {
  it("lists context keys and asks once each, in first-seen order", () => {
    expect(scan("{{ file }} {{?why}} {{branch}} {{file}} {{ ? why }}")).toEqual({
      context: ["file", "branch"],
      asks: ["why"],
    });
  });

  it("ignores braces that mean nothing to us", () => {
    expect(scan("{{unknown}} {{}}")).toEqual({ context: [], asks: [] });
  });
});

describe("resolve", () => {
  it("fills context and answers, leaving unknown tokens standing", () => {
    expect(resolve("Fix {{file}} on {{branch}}: {{?why}} {{other}}", ctx, { why: "it breaks" })).toBe(
      "Fix src/a.ts on main: it breaks {{other}}",
    );
  });

  it("collapses an unanswered ask to nothing", () => {
    expect(resolve("a{{?why}}b", ctx)).toBe("ab");
  });
});

describe("contextFrom", () => {
  it("makes the open file relative to the project", () => {
    expect(contextFrom("/w/aditor", "/w/aditor/src/a.ts", "main")).toEqual(ctx);
  });

  it("leaves a file outside the project absolute", () => {
    expect(contextFrom("/w/aditor", "/tmp/x.ts", null).file).toBe("/tmp/x.ts");
  });
});
