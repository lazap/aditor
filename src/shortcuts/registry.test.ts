import { describe, expect, it } from "vitest";
import { COMMANDS } from "./registry";

/** Every shipped binding on one side, from the table rather than the host. */
const shipped = (mac: boolean) =>
  COMMANDS.map((c) => (!mac && c.other !== undefined ? c.other : c.chord)).filter(
    (chord): chord is string => chord !== null,
  );

describe("default shortcuts", () => {
  it("never bind one chord twice", () => {
    for (const mac of [true, false]) {
      const chords = shipped(mac);
      expect(new Set(chords).size).toBe(chords.length);
    }
  });

  describe("on Windows and Linux", () => {
    const chords = shipped(false);

    it("leave every Ctrl+letter to the agent", () => {
      expect(chords.filter((c) => /^mod\+[a-z]$/.test(c))).toEqual([]);
    });

    it("leave Ctrl+Shift+C and Ctrl+Shift+V to the terminal's copy and paste", () => {
      expect(chords).not.toContain("mod+shift+c");
      expect(chords).not.toContain("mod+shift+v");
    });

    it("take no Ctrl+Alt chord, which AltGr types through on Windows", () => {
      expect(chords.filter((c) => c.startsWith("mod+alt+"))).toEqual([]);
    });
  });
});
