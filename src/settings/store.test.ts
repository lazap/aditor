import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), emitTo: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "test" }) }));
vi.mock("./api", () => ({ settingsRead: vi.fn(), settingsWrite: vi.fn() }));
vi.mock("./legacy", () => ({ clearLegacy: vi.fn(), hasLegacy: () => false, readLegacy: vi.fn() }));

const { normalize } = await import("./store");

describe("appearance migration", () => {
  it("turns a pinned light or dark into a fixed theme", () => {
    for (const old of ["light", "dark"] as const) {
      const { value, changed } = normalize({ appearance: old });
      expect(value.appearance).toBe("fixed");
      expect(value.theme).toBe(old);
      expect(changed).toBe(true);
    }
  });

  it("keeps system and its pair", () => {
    const { value } = normalize({ appearance: "system", systemLight: "paper", systemDark: "" });
    expect(value.appearance).toBe("system");
    expect(value.systemLight).toBe("paper");
    expect(value.systemDark).toBe("dark");
  });
});
