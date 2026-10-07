import { describe, expect, it } from "vitest";
import { fuzzyMatch, parseFileQuery, rank } from "./fuzzy";

const FILES = [
  "src/components/FileViewer.tsx",
  "src/components/FileTree.tsx",
  "src/fs/api.ts",
  "src/editor/vim.ts",
  "src/editor/vimSearch.ts",
  "src-tauri/src/fs.rs",
  "README.md",
];

const best = (q: string) => rank(q, FILES, (f) => f, 3).map((r) => r.item);

describe("fuzzyMatch", () => {
  it("requires every character, in order", () => {
    expect(fuzzyMatch("fvw", "src/components/FileViewer.tsx")).not.toBeNull();
    expect(fuzzyMatch("wvf", "src/components/FileViewer.tsx")).toBeNull();
    expect(fuzzyMatch("xyz", "src/fs/api.ts")).toBeNull();
  });

  it("ignores case", () => {
    expect(fuzzyMatch("readme", "README.md")).not.toBeNull();
    expect(fuzzyMatch("ReadMe", "README.md")).not.toBeNull();
    expect(fuzzyMatch("FILEVIEWER", "src/components/FileViewer.tsx")).not.toBeNull();
  });

  it("reports where each character matched", () => {
    const m = fuzzyMatch("api", "src/fs/api.ts")!;
    expect(m.positions).toEqual([7, 8, 9]);
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });
});

describe("rank", () => {
  it("prefers word boundaries", () => {
    expect(best("fvw")[0]).toBe("src/components/FileViewer.tsx");
    expect(best("ft")[0]).toBe("src/components/FileTree.tsx");
  });

  it("prefers camel-case humps whatever the query's case", () => {
    expect(best("fv")[0]).toBe("src/components/FileViewer.tsx");
    expect(best("FV")[0]).toBe("src/components/FileViewer.tsx");
    expect(best("vs")[0]).toBe("src/editor/vimSearch.ts");
  });

  it("matches anywhere in the name, not only its start", () => {
    expect(best("viewer")[0]).toBe("src/components/FileViewer.tsx");
    expect(best("tree")[0]).toBe("src/components/FileTree.tsx");
  });

  it("prefers the file name over folders", () => {
    expect(best("vim")[0]).toBe("src/editor/vim.ts");
  });

  it("prefers the shorter path when otherwise equal", () => {
    const paths = ["src/legacy/old/App.tsx", "src/App.tsx"];
    expect(rank("app", paths, (f) => f, 2)[0].item).toBe("src/App.tsx");
  });

  it("prefers a match in the file name to one in a folder", () => {
    expect(best("fs")[0]).toBe("src-tauri/src/fs.rs");
  });
});

describe("parseFileQuery", () => {
  it("drops whitespace, so spaces act as wildcards", () => {
    expect(parseFileQuery("  file view ")).toEqual({ name: "fileview" });
    expect(best(parseFileQuery("file view").name)[0]).toBe("src/components/FileViewer.tsx");
  });

  it("reads a trailing line, with or without a column", () => {
    expect(parseFileQuery("FileTree.tsx:42")).toEqual({ name: "FileTree.tsx", line: 42 });
    expect(parseFileQuery("api.ts:7:3")).toEqual({ name: "api.ts", line: 7 });
    expect(parseFileQuery("api.ts:0")).toEqual({ name: "api.ts" });
    expect(parseFileQuery("a:b")).toEqual({ name: "a:b" });
  });
});
