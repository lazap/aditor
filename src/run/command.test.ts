import { describe, expect, it } from "vitest";
import { shQuote, toScript } from "./command";
import { launchChain, makeConfig, normalize, type RunConfig } from "./schema";

const script = (type: RunConfig["type"], fields: object, ctx?: Parameters<typeof toScript>[1]) =>
  toScript(makeConfig(type, "x", fields), ctx);

describe("toScript", () => {
  it("passes a shell command through", () => {
    expect(script("shell", { command: "  make && ./app  " })).toBe("make && ./app");
  });

  it("puts npm arguments behind -- and other managers' straight after", () => {
    expect(script("npm", { script: "dev", args: "--port 3000" })).toBe("npm run dev -- --port 3000");
    expect(script("npm", { script: "dev", manager: "pnpm", args: "--port 3000" })).toBe(
      "pnpm run dev --port 3000",
    );
    expect(script("npm", { script: "dev" }, { packageManager: "yarn", python: null })).toBe(
      "yarn run dev",
    );
  });

  it("builds cargo flags in order", () => {
    expect(
      script("cargo", { bin: "server", release: true, package: "api", args: "--verbose" }),
    ).toBe("cargo run --release -p api --bin server -- --verbose");
    expect(script("cargo", { subcommand: "test" })).toBe("cargo test");
  });

  it("finds the venv from a subfolder", () => {
    const ctx = { packageManager: null, python: ".venv/bin/python" };
    expect(script("python", { target: "main.py" }, ctx)).toBe(".venv/bin/python main.py");
    expect(script("python", { target: "app", mode: "module", cwd: "svc/api" }, ctx)).toBe(
      "../../.venv/bin/python -m app",
    );
    expect(script("python", { target: "my script.py" })).toBe("python3 'my script.py'");
  });

  it("covers go, maven, gradle and java", () => {
    expect(script("go", { package: "./cmd/api", args: "-v" })).toBe("go run ./cmd/api -v");
    expect(script("maven", { goals: "clean spring-boot:run" })).toBe("./mvnw clean spring-boot:run");
    expect(script("gradle", { tasks: "bootRun", wrapper: false })).toBe("gradle bootRun");
    expect(script("java", { target: "build/app.jar", jvmArgs: "-Xmx1g" })).toBe(
      "java -Xmx1g -jar build/app.jar",
    );
    expect(script("java", { mode: "class", target: "com.x.Main", classpath: "out:lib/*" })).toBe(
      "java -cp 'out:lib/*' com.x.Main",
    );
  });
});

describe("shQuote", () => {
  it("leaves plain words alone and quotes the rest", () => {
    expect(shQuote("dev:watch")).toBe("dev:watch");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("normalize", () => {
  it("drops what it cannot run and repairs what it can", () => {
    const configs = normalize({
      configs: [
        { type: "nope" },
        { id: "a", type: "cargo", subcommand: "rm -rf", release: "yes", beforeLaunch: "ghost" },
        { id: "a", type: "shell", command: "ls", env: { A: "1", B: 2 } },
      ],
    });
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({ subcommand: "run", release: false, beforeLaunch: null });
    expect(configs[1].id).not.toBe("a");
    expect(configs[1].env).toEqual({ A: "1" });
  });

  it("reads a missing file as no configurations", () => {
    expect(normalize(null)).toEqual([]);
  });
});

describe("launchChain", () => {
  it("orders dependencies first and refuses a loop", () => {
    const a = { ...makeConfig("shell", "a"), id: "a", beforeLaunch: "b" };
    const b = { ...makeConfig("shell", "b"), id: "b", beforeLaunch: null };
    expect(launchChain([a, b], "a")?.map((c) => c.id)).toEqual(["b", "a"]);
    expect(launchChain([a, { ...b, beforeLaunch: "a" }], "a")).toBeNull();
  });
});
