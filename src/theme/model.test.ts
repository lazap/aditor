import { describe, expect, it } from "vitest";
import { COLOR_TOKENS, TERMINAL_TOKENS, normalizeTheme, toFile, uniqueId } from "./model";
import { PRESETS, presetFor } from "./presets";

const norm = (raw: unknown, id = "mine") => normalizeTheme(raw, id, presetFor);

describe("presets", () => {
  it("define every token", () => {
    for (const p of PRESETS) {
      expect(Object.keys(p.colors).sort()).toEqual([...COLOR_TOKENS].sort());
      expect(Object.keys(p.terminal).sort()).toEqual([...TERMINAL_TOKENS].sort());
    }
  });
});

describe("normalizeTheme", () => {
  it("fills what is missing from the preset of the same kind", () => {
    const t = norm({ name: "Paper", kind: "light", colors: { bg: "#fafafa" } });
    expect(t.kind).toBe("light");
    expect(t.colors.bg).toBe("#fafafa");
    expect(t.colors.fg).toBe(presetFor("light").colors.fg);
    expect(t.terminal).toEqual(presetFor("light").terminal);
    expect(t.terminalMinContrast).toBe(4.5);
  });

  it("drops colours that are not colours, and unknown keys", () => {
    const t = norm({
      colors: { bg: "red; background: url(x)", fg: 42, nope: "#fff", accent: "rgba(1, 2, 3, 0.5)" },
      terminal: { red: "#zzzzzz", green: "#00ff00" },
    });
    expect(t.colors.bg).toBe(presetFor("dark").colors.bg);
    expect(t.colors.fg).toBe(presetFor("dark").colors.fg);
    expect(t.colors.accent).toBe("rgba(1, 2, 3, 0.5)");
    expect("nope" in t.colors).toBe(false);
    expect(t.terminal.red).toBe(presetFor("dark").terminal.red);
    expect(t.terminal.green).toBe("#00ff00");
  });

  it("defaults a missing or unknown kind to dark, and an empty name to the id", () => {
    const t = norm({ kind: "sepia", name: "  " }, "sepia");
    expect(t.kind).toBe("dark");
    expect(t.name).toBe("sepia");
    expect(norm(null).colors).toEqual(presetFor("dark").colors);
  });

  it("round-trips through the file shape", () => {
    const t = norm({ name: "X", kind: "light", colors: { caret: "#123456" } });
    expect(norm(JSON.parse(JSON.stringify(toFile(t))))).toEqual(t);
  });
});

describe("uniqueId", () => {
  it("slugifies and avoids taken ids", () => {
    expect(uniqueId("Tokyo Night!", new Set())).toBe("tokyo-night");
    expect(uniqueId("Dark", new Set(["dark", "light"]))).toBe("dark-2");
    expect(uniqueId("***", new Set())).toBe("theme");
  });
});
