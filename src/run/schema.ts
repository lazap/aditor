/**
 * Run configurations: the shape of a project's `.aditor/run.json`.
 *
 * The Rust side reads and writes the file as an opaque JSON value (`run.rs`),
 * so this module is the only definition of what a configuration is -- the way
 * `settings/schema.ts` is for settings. The file lives in the repo and anyone
 * can edit it, so `normalize` treats it as a suggestion at every level.
 */

export type RunType = "shell" | "npm" | "cargo" | "python" | "go" | "maven" | "gradle" | "java";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** What every configuration has, whatever it runs. */
export interface RunCommon {
  id: string;
  name: string;
  /** Relative to the project root; "" is the root itself. */
  cwd: string;
  env: Record<string, string>;
  /** Another configuration to run first; this one starts only if it exits 0. */
  beforeLaunch: string | null;
  /** Run again restarts the one running instead of starting a second. */
  singleInstance: boolean;
}

export interface ShellFields {
  type: "shell";
  command: string;
}

export interface NpmFields {
  type: "npm";
  script: string;
  manager: "auto" | PackageManager;
  args: string;
}

export interface CargoFields {
  type: "cargo";
  subcommand: "run" | "test" | "build";
  bin: string;
  package: string;
  release: boolean;
  features: string;
  args: string;
}

export interface PythonFields {
  type: "python";
  mode: "script" | "module";
  target: string;
  /** "" picks the project's virtualenv, else `python3`. */
  interpreter: string;
  args: string;
}

export interface GoFields {
  type: "go";
  subcommand: "run" | "test" | "build";
  package: string;
  args: string;
}

export interface MavenFields {
  type: "maven";
  goals: string;
  /** Use the project's `./mvnw` rather than `mvn` on PATH. */
  wrapper: boolean;
  args: string;
}

export interface GradleFields {
  type: "gradle";
  tasks: string;
  /** Use the project's `./gradlew` rather than `gradle` on PATH. */
  wrapper: boolean;
  args: string;
}

export interface JavaFields {
  type: "java";
  mode: "jar" | "class";
  /** The jar, or the main class. */
  target: string;
  classpath: string;
  jvmArgs: string;
  args: string;
}

export type RunFields =
  | ShellFields
  | NpmFields
  | CargoFields
  | PythonFields
  | GoFields
  | MavenFields
  | GradleFields
  | JavaFields;

export type RunConfig = RunCommon & RunFields;

export interface RunFile {
  version: 1;
  configs: RunConfig[];
}

/** Each type's fields when nothing says otherwise. */
export const FIELD_DEFAULTS: { [T in RunType]: Extract<RunFields, { type: T }> } = {
  shell: { type: "shell", command: "" },
  npm: { type: "npm", script: "", manager: "auto", args: "" },
  cargo: {
    type: "cargo",
    subcommand: "run",
    bin: "",
    package: "",
    release: false,
    features: "",
    args: "",
  },
  python: { type: "python", mode: "script", target: "", interpreter: "", args: "" },
  go: { type: "go", subcommand: "run", package: ".", args: "" },
  maven: { type: "maven", goals: "", wrapper: true, args: "" },
  gradle: { type: "gradle", tasks: "", wrapper: true, args: "" },
  java: { type: "java", mode: "jar", target: "", classpath: "", jvmArgs: "", args: "" },
};

/** How each type is named in the add menu and the form. */
export const TYPES: readonly { type: RunType; label: string; icon: string }[] = [
  { type: "shell", label: "Shell Command", icon: "$" },
  { type: "npm", label: "npm / pnpm / yarn", icon: "JS" },
  { type: "cargo", label: "Cargo", icon: "RS" },
  { type: "python", label: "Python", icon: "PY" },
  { type: "go", label: "Go", icon: "GO" },
  { type: "maven", label: "Maven", icon: "MVN" },
  { type: "gradle", label: "Gradle", icon: "GR" },
  { type: "java", label: "Java", icon: "JV" },
];

export const typeInfo = (type: RunType) => TYPES.find((t) => t.type === type)!;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A fresh configuration of `type`, with `fields` laid over its defaults. */
export function makeConfig(type: RunType, name: string, fields: object = {}): RunConfig {
  return normalizeConfig({ ...fields, type, name, id: newId() }) as RunConfig;
}

/**
 * One configuration from the file, or null when it is not one we can run.
 * Fields of the wrong type fall back to their defaults one by one, so a typo
 * in one field does not lose the whole configuration.
 */
export function normalizeConfig(raw: unknown): RunConfig | null {
  if (!isObject(raw)) return null;
  const type = raw.type as RunType;
  if (!(type in FIELD_DEFAULTS)) return null;
  const defaults = FIELD_DEFAULTS[type] as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = { type };
  for (const [key, fallback] of Object.entries(defaults)) {
    if (key === "type") continue;
    const v = raw[key];
    // Enumerations are only as good as one of their values: a misspelt
    // subcommand must not reach the command line.
    const allowed = ENUMS[`${type}.${key}`];
    fields[key] =
      typeof v === typeof fallback && (!allowed || allowed.includes(v as string)) ? v : fallback;
  }
  const env: Record<string, string> = {};
  if (isObject(raw.env)) {
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === "string") env[k] = v;
  }
  return {
    ...(fields as unknown as RunFields),
    id: typeof raw.id === "string" && raw.id !== "" ? raw.id : newId(),
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : typeInfo(type).label,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    env,
    beforeLaunch: typeof raw.beforeLaunch === "string" ? raw.beforeLaunch : null,
    singleInstance: typeof raw.singleInstance === "boolean" ? raw.singleInstance : true,
  };
}

const ENUMS: Record<string, readonly string[]> = {
  "npm.manager": ["auto", "npm", "pnpm", "yarn", "bun"],
  "cargo.subcommand": ["run", "test", "build"],
  "python.mode": ["script", "module"],
  "go.subcommand": ["run", "test", "build"],
  "java.mode": ["jar", "class"],
};

/** The file as read -- null when there is none -- as a list we can trust. */
export function normalize(raw: unknown): RunConfig[] {
  if (!isObject(raw) || !Array.isArray(raw.configs)) return [];
  const seen = new Set<string>();
  const out: RunConfig[] = [];
  for (const item of raw.configs) {
    const c = normalizeConfig(item);
    if (!c) continue;
    if (seen.has(c.id)) c.id = newId();
    seen.add(c.id);
    out.push(c);
  }
  // A before-launch pointing at nothing is just no before-launch.
  for (const c of out) if (c.beforeLaunch && !seen.has(c.beforeLaunch)) c.beforeLaunch = null;
  return out;
}

export function toFile(configs: RunConfig[]): RunFile {
  return { version: 1, configs };
}

/**
 * The before-launch chain of `id`, first to run first, ending with `id`
 * itself. Null when it loops back on itself.
 */
export function launchChain(configs: RunConfig[], id: string): RunConfig[] | null {
  const chain: RunConfig[] = [];
  const seen = new Set<string>();
  let cur = configs.find((c) => c.id === id);
  while (cur) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    chain.unshift(cur);
    const next = cur.beforeLaunch;
    cur = next ? configs.find((c) => c.id === next) : undefined;
  }
  return chain;
}
