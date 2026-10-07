import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { patch, useSettings } from "../../settings/store";
import type { Settings } from "../../settings/schema";
import { useThemeDef } from "../../theme";
import { themeExport, themeImport } from "../../theme/api";
import {
  COLOR_GROUPS,
  TERMINAL_GROUP,
  isColor,
  normalizeTheme,
  toFile,
  uniqueId,
  type ThemeDef,
  type ThemeKind,
} from "../../theme/model";
import { isPreset, presetFor } from "../../theme/presets";
import { deleteTheme, saveTheme, useThemes } from "../../theme/store";

interface Props {
  onNote(note: string | null): void;
}

const FILTERS = [{ name: "Aditor theme", extensions: ["json"] }];

/**
 * Choosing the active theme, and making new ones.
 *
 * The two presets are read-only; everything else is a file in
 * `~/.aditor/themes`, and an edit lands in every window as it is typed (see
 * `theme/store.ts`). A theme made here becomes the active one, so what is being
 * edited is what is on screen.
 */
export function ThemesTab({ onNote }: Props) {
  const { appearance, theme, systemLight, systemDark } = useSettings();
  const all = useThemes();
  const active = useThemeDef();
  const [selectedId, setSelectedId] = useState<string>(active.id);
  const nameRef = useRef<HTMLInputElement>(null);

  // A theme deleted from under the selection, here or in another window.
  const selected = all.find((t) => t.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) setSelectedId(active.id);
  }, [selected, active.id]);

  const taken = () => new Set(all.map((t) => t.id));

  /** Put `def` on screen: in its kind's slot under System, or pinned. */
  const activate = (def: ThemeDef) =>
    patch(
      appearance === "system"
        ? def.kind === "light"
          ? { systemLight: def.id }
          : { systemDark: def.id }
        : { theme: def.id },
    );

  const create = (from: ThemeDef, name: string) => {
    const def: ThemeDef = { ...from, id: uniqueId(name, taken()), name };
    saveTheme(def);
    activate(def);
    setSelectedId(def.id);
    onNote(null);
    window.setTimeout(() => nameRef.current?.select(), 0);
  };

  const update = (next: Partial<ThemeDef>) => {
    if (!selected || isPreset(selected.id)) return;
    saveTheme({ ...selected, ...next });
  };

  const remove = async (def: ThemeDef) => {
    // Point whatever used it at the preset it would fall back to anyway, so
    // the setting does not keep naming a theme that is gone.
    const reset: Partial<Settings> = {};
    const preset = presetFor(def.kind).id;
    if (theme === def.id) reset.theme = preset;
    if (systemLight === def.id) reset.systemLight = "light";
    if (systemDark === def.id) reset.systemDark = "dark";
    if (Object.keys(reset).length > 0) patch(reset);
    try {
      await deleteTheme(def.id);
      onNote(`Deleted “${def.name}”.`);
    } catch (e) {
      onNote(`Could not delete “${def.name}”: ${String(e)}`);
    }
  };

  const importTheme = async () => {
    const path = await open({ multiple: false, directory: false, filters: FILTERS });
    if (typeof path !== "string") return;
    try {
      const raw = await themeImport(path);
      const looksLikeTheme =
        typeof raw === "object" && raw !== null && ("colors" in raw || "terminal" in raw);
      if (!looksLikeTheme) {
        onNote("That file is not an Aditor theme: it has no colors or terminal section.");
        return;
      }
      const parsed = normalizeTheme(raw, "imported", presetFor);
      const def = { ...parsed, id: uniqueId(parsed.name, taken()) };
      saveTheme(def);
      activate(def);
      setSelectedId(def.id);
      onNote(`Imported “${def.name}”.`);
    } catch (e) {
      onNote(`Could not import: ${String(e)}`);
    }
  };

  const exportTheme = async (def: ThemeDef) => {
    const path = await save({ defaultPath: `${def.id}.json`, filters: FILTERS });
    if (!path) return;
    try {
      await themeExport(path, toFile(def));
      onNote(`Exported “${def.name}”.`);
    } catch (e) {
      onNote(`Could not export: ${String(e)}`);
    }
  };

  const ofKind = (kind: ThemeKind) => all.filter((t) => t.kind === kind);
  const readOnly = !selected || isPreset(selected.id);

  return (
    <>
      <div className="picker-section-label">Active theme</div>
      <div className="setting-row">
        <span className="setting-label">
          Mode
          <span className="setting-sub">
            System switches between a light and a dark theme with macOS.
          </span>
        </span>
        <div className="seg">
          <button
            className="seg-btn"
            data-active={appearance === "system"}
            onClick={() => patch({ appearance: "system" })}
          >
            System
          </button>
          <button
            className="seg-btn"
            data-active={appearance === "fixed"}
            onClick={() => patch({ appearance: "fixed", theme: active.id })}
          >
            Fixed
          </button>
        </div>
      </div>
      {appearance === "fixed" ? (
        <ThemeSelect label="Theme" value={theme} options={all} onPick={(id) => patch({ theme: id })} />
      ) : (
        <>
          <ThemeSelect
            label="Light"
            value={systemLight}
            options={ofKind("light")}
            onPick={(id) => patch({ systemLight: id })}
          />
          <ThemeSelect
            label="Dark"
            value={systemDark}
            options={ofKind("dark")}
            onPick={(id) => patch({ systemDark: id })}
          />
        </>
      )}

      <div className="picker-section-label">Themes</div>
      <div className="templates themes">
        <div className="templates-list" role="listbox" aria-label="Themes">
          {all.map((t) => (
            <button
              key={t.id}
              className="template-row"
              role="option"
              aria-selected={t.id === selectedId}
              data-selected={t.id === selectedId}
              onClick={() => {
                onNote(null);
                setSelectedId(t.id);
              }}
            >
              <span className="template-name">
                <span className="theme-dot" style={{ background: t.colors.bg, borderColor: t.colors.accent }} />
                {t.name}
              </span>
              <span className="template-summary">
                {isPreset(t.id) ? "Built-in" : "Custom"} · {t.kind}
                {t.id === active.id ? " · in use" : ""}
              </span>
            </button>
          ))}
          <button className="template-add" onClick={() => create(active, "New theme")}>
            + New theme
          </button>
          <button className="template-add" onClick={() => void importTheme()}>
            Import…
          </button>
        </div>

        <div className="template-editor">
          {selected && (
            <>
              <label className="template-field">
                <span className="template-field-label">Name</span>
                <input
                  ref={nameRef}
                  className="template-input"
                  value={selected.name}
                  disabled={readOnly}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </label>

              <div className="setting-row">
                <span className="setting-label">
                  Kind
                  <span className="setting-sub">
                    Tells macOS and the diff view whether this is a light or a dark theme.
                  </span>
                </span>
                <div className="seg">
                  {(["light", "dark"] as const).map((k) => (
                    <button
                      key={k}
                      className="seg-btn"
                      data-active={selected.kind === k}
                      disabled={readOnly}
                      onClick={() => update({ kind: k })}
                    >
                      {k === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="template-actions">
                {selected.id !== active.id && (
                  <button className="template-act" onClick={() => activate(selected)}>
                    Use
                  </button>
                )}
                <button
                  className="template-act"
                  onClick={() => create(selected, `${selected.name} copy`)}
                >
                  Duplicate
                </button>
                <button className="template-act" onClick={() => void exportTheme(selected)}>
                  Export…
                </button>
                {!readOnly && (
                  <button
                    className="template-act template-delete"
                    onClick={() => void remove(selected)}
                  >
                    Delete
                  </button>
                )}
              </div>

              {readOnly && (
                <p className="template-legend">
                  Built-in themes can’t be changed. Duplicate this one to make
                  your own.
                </p>
              )}

              {COLOR_GROUPS.map((group) => (
                <ColorGroup
                  key={group.label}
                  label={group.label}
                  tokens={group.tokens}
                  values={selected.colors}
                  readOnly={readOnly}
                  onChange={(token, value) =>
                    update({ colors: { ...selected.colors, [token]: value } })
                  }
                />
              ))}
              <ColorGroup
                label={TERMINAL_GROUP.label}
                tokens={TERMINAL_GROUP.tokens}
                values={selected.terminal}
                readOnly={readOnly}
                onChange={(token, value) =>
                  update({ terminal: { ...selected.terminal, [token]: value } })
                }
              />
            </>
          )}
        </div>
      </div>

      <p className="settings-hint">
        Custom themes live in <code>~/.aditor/themes</code>, one JSON file each.
        A file dropped there appears after a restart; any colour it leaves out
        comes from the built-in theme of the same kind.
      </p>
    </>
  );
}

function ThemeSelect(props: {
  label: string;
  value: string;
  options: readonly ThemeDef[];
  onPick(id: string): void;
}) {
  // A setting naming a theme that is gone shows what is actually applied.
  const known = props.options.some((t) => t.id === props.value);
  return (
    <div className="setting-row">
      <span className="setting-label">{props.label}</span>
      <select
        className="theme-select"
        value={known ? props.value : ""}
        onChange={(e) => props.onPick(e.target.value)}
      >
        {!known && <option value="">(missing theme)</option>}
        {props.options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function ColorGroup<T extends string>(props: {
  label: string;
  tokens: ReadonlyArray<readonly [T, string]>;
  values: Record<T, string>;
  readOnly: boolean;
  onChange(token: T, value: string): void;
}) {
  return (
    <div className="theme-group">
      <span className="template-field-label">{props.label}</span>
      <div className="theme-colors">
        {props.tokens.map(([token, label]) => (
          <ColorRow
            key={token}
            label={label}
            value={props.values[token]}
            readOnly={props.readOnly}
            onChange={(v) => props.onChange(token, v)}
          />
        ))}
      </div>
    </div>
  );
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/** `#abc` and `#abcd` as the `#rrggbb` a colour input wants; null otherwise. */
function asHex6(value: string): string | null {
  if (HEX6.test(value)) return value.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/i.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(value);
  return long ? `#${long[1]}`.toLowerCase() : null;
}

/**
 * A swatch that opens the system colour picker, and the value as text for
 * anything the picker cannot say -- `rgba(…)` and the like. Text that is not
 * a colour stays in the field, marked, and is not saved.
 */
function ColorRow(props: {
  label: string;
  value: string;
  readOnly: boolean;
  onChange(value: string): void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const valid = isColor(draft);

  return (
    <label className="theme-color" title={props.label}>
      <span className="theme-swatch" style={{ background: props.value }}>
        <input
          type="color"
          value={asHex6(props.value) ?? "#000000"}
          disabled={props.readOnly}
          onChange={(e) => props.onChange(e.target.value)}
        />
      </span>
      <span className="theme-color-label">{props.label}</span>
      <input
        className="theme-color-text"
        value={draft}
        spellCheck={false}
        disabled={props.readOnly}
        data-invalid={!valid}
        onChange={(e) => {
          setDraft(e.target.value);
          if (isColor(e.target.value)) props.onChange(e.target.value.trim());
        }}
        onBlur={() => setDraft(props.value)}
      />
    </label>
  );
}
