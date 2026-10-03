/**
 * A run configuration as the shell line that runs it.
 *
 * Free-form fields -- arguments, goals, JVM options -- are typed as shell text
 * and go in as written, so quoting and `$VAR` work the way they do in a
 * terminal. Fields that name one thing -- a script, a binary, a file -- are
 * quoted, so a space in a path stays part of the path.
 */
import type { PackageManager, RunConfig } from "./schema";

/** What the project looks like, for the configurations left on "auto". */
export interface ScriptContext {
  packageManager: PackageManager | null;
  /** The project's virtualenv interpreter, relative to the root. */
  python: string | null;
}

export const NO_CONTEXT: ScriptContext = { packageManager: null, python: null };

/** Quote for a POSIX shell, unless the word needs no quoting. */
export function shQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const join = (...parts: (string | false | null | undefined)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" ");

export function toScript(c: RunConfig, ctx: ScriptContext = NO_CONTEXT): string {
  switch (c.type) {
    case "shell":
      return c.command.trim();

    case "npm": {
      const mgr = c.manager === "auto" ? (ctx.packageManager ?? "npm") : c.manager;
      // npm alone needs `--` to pass arguments through to the script.
      const args = c.args.trim() && (mgr === "npm" ? `-- ${c.args.trim()}` : c.args.trim());
      return join(mgr, "run", c.script && shQuote(c.script), args);
    }

    case "cargo":
      return join(
        "cargo",
        c.subcommand,
        c.release && "--release",
        c.package && `-p ${shQuote(c.package)}`,
        c.bin && `--bin ${shQuote(c.bin)}`,
        c.features && `--features ${shQuote(c.features)}`,
        c.args.trim() && `-- ${c.args.trim()}`,
      );

    case "python": {
      // The detected virtualenv is relative to the root, and the run starts
      // in `cwd`, so from a subfolder the path has to climb back up. A typed
      // interpreter is shell text like any other free-form field.
      const interp = c.interpreter.trim() || (ctx.python ? rootRelative(c.cwd, ctx.python) : "python3");
      return join(
        c.interpreter.trim() ? interp : shQuote(interp),
        c.mode === "module" && "-m",
        c.target && shQuote(c.target),
        c.args,
      );
    }

    case "go":
      return join("go", c.subcommand, c.package && shQuote(c.package), c.args);

    case "maven":
      return join(c.wrapper ? "./mvnw" : "mvn", c.goals, c.args);

    case "gradle":
      return join(c.wrapper ? "./gradlew" : "gradle", c.tasks, c.args);

    case "java":
      return c.mode === "jar"
        ? join("java", c.jvmArgs, "-jar", c.target && shQuote(c.target), c.args)
        : join(
            "java",
            c.jvmArgs,
            c.classpath && `-cp ${shQuote(c.classpath)}`,
            c.target && shQuote(c.target),
            c.args,
          );
  }
}

/** `path` (relative to the root) as seen from `cwd` (also relative to it). */
function rootRelative(cwd: string, path: string): string {
  const depth = cwd.split("/").filter((p) => p !== "" && p !== ".").length;
  return depth === 0 ? path : `${"../".repeat(depth)}${path}`;
}

/** Why `c` cannot run yet, or null when it can. */
export function missing(c: RunConfig): string | null {
  switch (c.type) {
    case "shell":
      return c.command.trim() ? null : "Enter a command.";
    case "npm":
      return c.script.trim() ? null : "Pick a script.";
    case "python":
      return c.target.trim() ? null : c.mode === "module" ? "Enter a module." : "Enter a script.";
    case "maven":
      return c.goals.trim() ? null : "Enter at least one goal.";
    case "gradle":
      return c.tasks.trim() ? null : "Enter at least one task.";
    case "java":
      return c.target.trim() ? null : c.mode === "jar" ? "Enter a jar." : "Enter a main class.";
    case "cargo":
    case "go":
      return null;
  }
}
