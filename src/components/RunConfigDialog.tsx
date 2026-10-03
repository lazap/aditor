import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import type { Detected } from "../run/api";
import { missing, toScript, type ScriptContext } from "../run/command";
import {
  FIELD_DEFAULTS,
  TYPES,
  launchChain,
  makeConfig,
  newId,
  normalizeConfig,
  typeInfo,
  type RunConfig,
  type RunType,
} from "../run/schema";

interface Props {
  root: string;
  configs: RunConfig[];
  /** Selected when the dialog opens; the first configuration otherwise. */
  initialId: string | null;
  detected: Detected | null;
  context: ScriptContext;
  /** run.json could not be read: saving would overwrite whatever is in it. */
  fileError: string | null;
  onSave(configs: RunConfig[]): Promise<void>;
  onCancel(): void;
  /** Open run.json itself, to fix it by hand. */
  onOpenFile(): void;
}

/**
 * A configuration being edited. The environment is a list of rows rather than
 * the object it is saved as, so a row can have an empty or duplicate name
 * while it is being typed.
 */
type Draft = RunConfig & { envRows: [string, string][] };

const toDraft = (c: RunConfig): Draft => ({ ...c, envRows: Object.entries(c.env) });

/** Back to what is saved. Through `normalizeConfig`, which also drops the
 *  fields a type change left behind. */
function fromDraft({ envRows, ...c }: Draft): RunConfig {
  const env: Record<string, string> = {};
  for (const [k, v] of envRows) if (k.trim()) env[k.trim()] = v;
  const cwd = c.cwd.trim().replace(/^\.?\/+|\/+$/g, "");
  return normalizeConfig({ ...c, name: c.name.trim(), cwd, env })!;
}

/** Why a draft cannot be saved, or null. */
function problem(d: Draft): string | null {
  if (!d.name.trim()) return "Give the configuration a name.";
  if (d.cwd.split("/").includes("..") || d.cwd.trim().startsWith("/"))
    return "The working directory must be a folder inside the project.";
  if (d.envRows.some(([k]) => k.trim() !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k.trim())))
    return "Environment variable names are letters, digits and _, not starting with a digit.";
  return missing(d);
}

/**
 * IntelliJ's Run/Debug Configurations: the list on the left, the selected
 * one's form on the right, and what the project looks like it can run under
 * the list. Nothing is written until Save.
 */
export function RunConfigDialog({
  root,
  configs,
  initialId,
  detected,
  context,
  fileError,
  onSave,
  onCancel,
  onOpenFile,
}: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(() => configs.map(toDraft));
  const [selectedId, setSelectedId] = useState<string | null>(
    () => configs.find((c) => c.id === initialId)?.id ?? configs[0]?.id ?? null,
  );
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const addRef = useRef<HTMLDivElement>(null);

  const selected = drafts.find((d) => d.id === selectedId) ?? null;

  useEffect(() => {
    if (!adding) return;
    const onDown = (e: MouseEvent) => {
      if (!addRef.current?.contains(e.target as Node)) setAdding(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [adding]);

  const update = (patch: Partial<Draft>) =>
    setDrafts((prev) =>
      prev.map((d) => (d.id === selectedId ? ({ ...d, ...patch } as Draft) : d)),
    );

  const add = (c: RunConfig) => {
    setDrafts((prev) => [...prev, toDraft(c)]);
    setSelectedId(c.id);
  };

  /** A name not already taken: "Cargo", "Cargo (2)", … */
  const freeName = (base: string) => {
    const taken = new Set(drafts.map((d) => d.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} (${i})`)) return `${base} (${i})`;
  };

  const remove = () => {
    if (!selected) return;
    const at = drafts.findIndex((d) => d.id === selected.id);
    const rest = drafts
      .filter((d) => d.id !== selected.id)
      .map((d) => (d.beforeLaunch === selected.id ? { ...d, beforeLaunch: null } : d));
    setDrafts(rest);
    setSelectedId(rest[Math.min(at, rest.length - 1)]?.id ?? null);
  };

  const move = (step: number) => {
    const at = drafts.findIndex((d) => d.id === selectedId);
    const to = at + step;
    if (at < 0 || to < 0 || to >= drafts.length) return;
    const next = [...drafts];
    [next[at], next[to]] = [next[to], next[at]];
    setDrafts(next);
  };

  // Suggestions already in the list, by the command they would run, are not
  // offered again.
  const suggestions = useMemo(() => {
    const have = new Set(drafts.map((d) => `${d.cwd}\0${toScript(fromDraft(d), context)}`));
    return (detected?.suggestions ?? [])
      .map((s) => makeConfig(s.config.type as RunType, s.name, s.config))
      .filter((c) => !have.has(`${c.cwd}\0${toScript(c, context)}`));
  }, [detected, drafts, context]);

  const npmScripts = useMemo(
    () =>
      (detected?.suggestions ?? [])
        .filter((s) => s.config.type === "npm")
        .map((s) => String(s.config.script)),
    [detected],
  );

  const invalid = drafts.find((d) => problem(d) !== null) ?? null;
  const canSave = !fileError && !invalid && !saving;

  const save = () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    onSave(drafts.map(fromDraft)).catch((e: unknown) => {
      setSaving(false);
      setSaveError(String(e).replace(/^Error:\s*/, ""));
    });
  };

  // Before-launch may not lead back here, directly or through others.
  const launchable = selected
    ? drafts.filter(
        (d) =>
          d.id !== selected.id &&
          launchChain(
            drafts.map((o) => (o.id === selected.id ? { ...o, beforeLaunch: d.id } : o)),
            selected.id,
          ) !== null,
      )
    : [];

  return (
    <Modal
      title="Run Configurations"
      confirm={saving ? "Saving…" : "Save"}
      canConfirm={canSave}
      onConfirm={save}
      onCancel={onCancel}
      large
    >
      {fileError && (
        <div className="run-file-error">
          <span>{fileError}</span>
          <button className="modal-cancel" onClick={onOpenFile}>
            Open run.json
          </button>
        </div>
      )}
      <div className="run-dialog">
        <div className="run-list-col">
          <div className="run-list-tools">
            <div className="run-add-wrap" ref={addRef}>
              <button
                className="run-tool"
                onClick={() => setAdding((a) => !a)}
                aria-haspopup="menu"
                aria-expanded={adding}
                title="Add configuration"
              >
                +
              </button>
              {adding && (
                <div className="agent-menu" role="menu">
                  {TYPES.map((t) => (
                    <button
                      key={t.type}
                      className="agent-option"
                      role="menuitem"
                      onClick={() => {
                        setAdding(false);
                        add(makeConfig(t.type, freeName(t.label)));
                      }}
                    >
                      <span className="run-type" aria-hidden="true">
                        {t.icon}
                      </span>
                      <span className="agent-option-label">{t.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="run-tool"
              disabled={!selected}
              title="Copy configuration"
              onClick={() =>
                selected &&
                add({ ...fromDraft(selected), id: newId(), name: freeName(`${selected.name} copy`) })
              }
            >
              ⧉
            </button>
            <button className="run-tool" disabled={!selected} title="Remove configuration" onClick={remove}>
              −
            </button>
            <button className="run-tool" disabled={!selected} title="Move up" onClick={() => move(-1)}>
              ↑
            </button>
            <button className="run-tool" disabled={!selected} title="Move down" onClick={() => move(1)}>
              ↓
            </button>
          </div>

          <div className="run-list" role="listbox" aria-label="Configurations">
            {drafts.length === 0 && <div className="modal-hint run-list-empty">No configurations yet.</div>}
            {drafts.map((d) => (
              <button
                key={d.id}
                className="run-list-item"
                role="option"
                aria-selected={d.id === selectedId}
                onClick={() => setSelectedId(d.id)}
                data-invalid={problem(d) !== null}
                title={problem(d) ?? undefined}
              >
                <span className="run-type" aria-hidden="true">
                  {typeInfo(d.type).icon}
                </span>
                <span className="run-list-name">{d.name || "Unnamed"}</span>
              </button>
            ))}
          </div>

          {suggestions.length > 0 && (
            <>
              <div className="run-list-heading">Detected</div>
              <div className="run-list run-suggestions">
                {suggestions.map((c) => (
                  <button
                    key={`${c.type}:${c.name}`}
                    className="run-list-item"
                    title={`Add: ${toScript(c, context)}`}
                    onClick={() => add({ ...c, name: freeName(c.name) })}
                  >
                    <span className="run-type" aria-hidden="true">
                      {typeInfo(c.type).icon}
                    </span>
                    <span className="run-list-name">{c.name}</span>
                    <span className="run-suggest-add" aria-hidden="true">
                      +
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="run-form">
          {selected ? (
            <ConfigForm
              key={selected.id}
              draft={selected}
              root={root}
              npmScripts={npmScripts}
              launchable={launchable}
              context={context}
              onChange={update}
            />
          ) : (
            <div className="modal-hint run-form-empty">
              Add a configuration with +, or pick one the project suggests.
            </div>
          )}
          {(saveError || invalid) && (
            <div className="modal-error">
              {saveError ?? (invalid && `${invalid.name || "Unnamed"}: ${problem(invalid)}`)}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ form ---

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="modal-field run-field">
      <span>
        {label}
        {hint && <span className="run-field-hint"> — {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Text({
  value,
  onChange,
  placeholder,
  mono,
  list,
}: {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  mono?: boolean;
  list?: string;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      data-mono={mono}
      list={list}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(v: T): void;
}) {
  return (
    <div className="run-segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          data-active={v === value}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange(v: boolean): void; children: ReactNode }) {
  return (
    <label className="modal-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

const SUBCOMMANDS = [
  ["run", "run"],
  ["test", "test"],
  ["build", "build"],
] as const;

function ConfigForm({
  draft: d,
  root,
  npmScripts,
  launchable,
  context,
  onChange,
}: {
  draft: Draft;
  root: string;
  npmScripts: string[];
  launchable: Draft[];
  context: ScriptContext;
  onChange(patch: Partial<Draft>): void;
}) {
  const set = (patch: Record<string, unknown>) => onChange(patch as Partial<Draft>);
  const preview = toScript(fromDraft(d), context);

  return (
    <div className="run-form-fields">
      <div className="run-form-row">
        <Field label="Name">
          <Text value={d.name} onChange={(name) => set({ name })} />
        </Field>
        <Field label="Type">
          <select
            value={d.type}
            onChange={(e) => {
              const type = e.target.value as RunType;
              // Switching type keeps what every configuration has and starts
              // the type's own fields over.
              set({ ...FIELD_DEFAULTS[type] });
            }}
          >
            {TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {d.type === "shell" && (
        <Field label="Command" hint="runs in your login shell, so && and pipes work">
          <textarea
            className="run-command-input"
            rows={3}
            value={d.command}
            spellCheck={false}
            placeholder="make && ./bin/app --port 8080"
            onChange={(e) => set({ command: e.target.value })}
          />
        </Field>
      )}

      {d.type === "npm" && (
        <>
          <div className="run-form-row">
            <Field label="Script">
              <Text value={d.script} onChange={(script) => set({ script })} mono list="run-npm-scripts" />
              <datalist id="run-npm-scripts">
                {npmScripts.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field label="Package manager">
              <select value={d.manager} onChange={(e) => set({ manager: e.target.value })}>
                <option value="auto">Auto ({context.packageManager ?? "npm"})</option>
                <option value="npm">npm</option>
                <option value="pnpm">pnpm</option>
                <option value="yarn">yarn</option>
                <option value="bun">bun</option>
              </select>
            </Field>
          </div>
          <Field label="Arguments">
            <Text value={d.args} onChange={(args) => set({ args })} mono placeholder="--port 3000" />
          </Field>
        </>
      )}

      {d.type === "cargo" && (
        <>
          <Field label="Command">
            <Choice value={d.subcommand} options={SUBCOMMANDS} onChange={(subcommand) => set({ subcommand })} />
          </Field>
          <div className="run-form-row">
            <Field label="Binary" hint="--bin">
              <Text value={d.bin} onChange={(bin) => set({ bin })} mono placeholder="default" />
            </Field>
            <Field label="Package" hint="-p">
              <Text value={d.package} onChange={(p) => set({ package: p })} mono placeholder="default" />
            </Field>
          </div>
          <Field label="Features">
            <Text value={d.features} onChange={(features) => set({ features })} mono placeholder="feat-a,feat-b" />
          </Field>
          <Check checked={d.release} onChange={(release) => set({ release })}>
            Release build (--release)
          </Check>
          <Field label="Program arguments" hint="after --">
            <Text value={d.args} onChange={(args) => set({ args })} mono />
          </Field>
        </>
      )}

      {d.type === "python" && (
        <>
          <Field label="Run">
            <Choice
              value={d.mode}
              options={[
                ["script", "Script"],
                ["module", "Module (-m)"],
              ]}
              onChange={(mode) => set({ mode })}
            />
          </Field>
          <Field label={d.mode === "script" ? "Script" : "Module"}>
            <Text
              value={d.target}
              onChange={(target) => set({ target })}
              mono
              placeholder={d.mode === "script" ? "main.py" : "package.module"}
            />
          </Field>
          <Field label="Interpreter">
            <Text
              value={d.interpreter}
              onChange={(interpreter) => set({ interpreter })}
              mono
              placeholder={context.python ? `${context.python} (project venv)` : "python3"}
            />
          </Field>
          <Field label="Arguments">
            <Text value={d.args} onChange={(args) => set({ args })} mono />
          </Field>
        </>
      )}

      {d.type === "go" && (
        <>
          <Field label="Command">
            <Choice value={d.subcommand} options={SUBCOMMANDS} onChange={(subcommand) => set({ subcommand })} />
          </Field>
          <Field label="Package">
            <Text value={d.package} onChange={(p) => set({ package: p })} mono placeholder="./cmd/server" />
          </Field>
          <Field label="Arguments">
            <Text value={d.args} onChange={(args) => set({ args })} mono />
          </Field>
        </>
      )}

      {d.type === "maven" && (
        <>
          <Field label="Goals">
            <Text value={d.goals} onChange={(goals) => set({ goals })} mono placeholder="clean spring-boot:run" />
          </Field>
          <Field label="Options">
            <Text value={d.args} onChange={(args) => set({ args })} mono placeholder="-DskipTests -Pdev" />
          </Field>
          <Check checked={d.wrapper} onChange={(wrapper) => set({ wrapper })}>
            Use the Maven wrapper (./mvnw)
          </Check>
        </>
      )}

      {d.type === "gradle" && (
        <>
          <Field label="Tasks">
            <Text value={d.tasks} onChange={(tasks) => set({ tasks })} mono placeholder="bootRun" />
          </Field>
          <Field label="Options">
            <Text value={d.args} onChange={(args) => set({ args })} mono placeholder="--info" />
          </Field>
          <Check checked={d.wrapper} onChange={(wrapper) => set({ wrapper })}>
            Use the Gradle wrapper (./gradlew)
          </Check>
        </>
      )}

      {d.type === "java" && (
        <>
          <Field label="Run">
            <Choice
              value={d.mode}
              options={[
                ["jar", "JAR (-jar)"],
                ["class", "Main class"],
              ]}
              onChange={(mode) => set({ mode })}
            />
          </Field>
          {d.mode === "jar" ? (
            <Field label="JAR file">
              <Text value={d.target} onChange={(target) => set({ target })} mono placeholder="target/app.jar" />
            </Field>
          ) : (
            <div className="run-form-row">
              <Field label="Main class">
                <Text value={d.target} onChange={(target) => set({ target })} mono placeholder="com.example.Main" />
              </Field>
              <Field label="Classpath" hint="-cp">
                <Text value={d.classpath} onChange={(classpath) => set({ classpath })} mono placeholder="out:lib/*" />
              </Field>
            </div>
          )}
          <Field label="VM options">
            <Text value={d.jvmArgs} onChange={(jvmArgs) => set({ jvmArgs })} mono placeholder="-Xmx1g" />
          </Field>
          <Field label="Program arguments">
            <Text value={d.args} onChange={(args) => set({ args })} mono />
          </Field>
        </>
      )}

      <div className="run-form-sep" />

      <Field label="Working directory" hint="relative to the project">
        <Text
          value={d.cwd}
          onChange={(cwd) => set({ cwd })}
          mono
          placeholder={`${root.split("/").pop() || root} (project root)`}
        />
      </Field>

      <div className="modal-field run-field">
        <span>Environment variables</span>
        <div className="run-env">
          {d.envRows.map(([k, v], i) => (
            <div className="run-env-row" key={i}>
              <input
                value={k}
                placeholder="NAME"
                spellCheck={false}
                data-mono
                onChange={(e) =>
                  set({ envRows: d.envRows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)) })
                }
              />
              <span aria-hidden="true">=</span>
              <input
                value={v}
                placeholder="value"
                spellCheck={false}
                data-mono
                onChange={(e) =>
                  set({ envRows: d.envRows.map((r, j) => (j === i ? [r[0], e.target.value] : r)) })
                }
              />
              <button
                className="run-tool"
                title="Remove variable"
                onClick={() => set({ envRows: d.envRows.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="run-env-add" onClick={() => set({ envRows: [...d.envRows, ["", ""]] })}>
            + Add variable
          </button>
        </div>
      </div>

      <Field label="Before launch" hint="must exit with code 0">
        <select
          value={d.beforeLaunch ?? ""}
          onChange={(e) => set({ beforeLaunch: e.target.value || null })}
        >
          <option value="">Nothing</option>
          {launchable.map((o) => (
            <option key={o.id} value={o.id}>
              Run “{o.name}”
            </option>
          ))}
        </select>
      </Field>

      <Check checked={d.singleInstance} onChange={(singleInstance) => set({ singleInstance })}>
        Allow only one instance — running it again restarts it
      </Check>

      <div className="modal-field run-field">
        <span>Command</span>
        <code className="run-preview">{preview || "—"}</code>
      </div>
    </div>
  );
}
