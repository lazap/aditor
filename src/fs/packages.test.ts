import { describe, expect, it } from "vitest";
import type { DirEntry } from "./api";
import { isSourceRoot, packageChain } from "./packages";

const dir = (path: string): DirEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: true,
  ignored: false,
});
const file = (path: string): DirEntry => ({ ...dir(path), isDir: false });
const paths = (chain: DirEntry[]) => chain.map((e) => e.path);

describe("isSourceRoot", () => {
  it.each([
    "/src/main/java",
    "/src/test/kotlin",
    "/src/commonMain/kotlin",
    "/src/main/scala",
    "/src/main/groovy",
    "/services/billing/src/main/java",
  ])("accepts %s", (rel) => {
    expect(isSourceRoot(rel)).toBe(true);
  });

  it.each([
    "/src/main/resources",
    "/src/main/java/com",
    "/src/java",
    "/java",
    "/mysrc/main/java",
  ])("rejects %s", (rel) => {
    expect(isSourceRoot(rel)).toBe(false);
  });
});

describe("packageChain", () => {
  const com = dir("/j/com");
  const acme = dir("/j/com/acme");
  const app = dir("/j/com/acme/app");
  const main = file("/j/com/acme/app/Main.java");

  it("follows lone subdirectories down to the package with content", () => {
    const cache = new Map([
      [com.path, [acme]],
      [acme.path, [app]],
      [app.path, [main]],
    ]);
    expect(packageChain(com, cache)).toEqual({ chain: [com, acme, app], unlisted: null });
  });

  it("stops at a directory holding a file beside its subdirectory", () => {
    const readme = file("/j/com/acme/README.md");
    const cache = new Map([
      [com.path, [acme]],
      [acme.path, [app, readme]],
    ]);
    expect(paths(packageChain(com, cache).chain)).toEqual([com.path, acme.path]);
  });

  it("stops at a directory with several subdirectories", () => {
    const cache = new Map([[com.path, [acme, dir("/j/com/other")]]]);
    expect(paths(packageChain(com, cache).chain)).toEqual([com.path]);
  });

  it("does not fold into a lone file", () => {
    const cache = new Map([[com.path, [file("/j/com/Main.java")]]]);
    expect(paths(packageChain(com, cache).chain)).toEqual([com.path]);
  });

  it("folds down to an empty package", () => {
    const cache = new Map([
      [com.path, [acme]],
      [acme.path, []],
    ]);
    expect(packageChain(com, cache)).toEqual({ chain: [com, acme], unlisted: null });
  });

  it("looks past .DS_Store", () => {
    const cache = new Map([
      [com.path, [file("/j/com/.DS_Store"), acme]],
      [acme.path, [main]],
    ]);
    expect(paths(packageChain(com, cache).chain)).toEqual([com.path, acme.path]);
  });

  it("reports the first directory not listed yet", () => {
    expect(packageChain(com, new Map())).toEqual({ chain: [com], unlisted: com.path });
    expect(packageChain(com, new Map([[com.path, [acme]]]))).toEqual({
      chain: [com, acme],
      unlisted: acme.path,
    });
  });
});
