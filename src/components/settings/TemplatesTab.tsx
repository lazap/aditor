import { useEffect, useRef, useState } from "react";
import { patch, useSettings } from "../../settings/store";
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_SEED,
  newTemplateId,
  type PromptTemplate,
} from "../../templates/registry";
import { scan } from "../../templates/placeholders";

interface Props {
  onNote(note: string | null): void;
}

/** First line, for the row under the name. */
function summarize(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/**
 * Writing the prompts the chooser offers.
 *
 * Edits land in the settings document as they are typed; the store's debounce
 * is what keeps that from being a disk write per keystroke.
 */
export function TemplatesTab({ onNote }: Props) {
  const templates = useSettings().templates;
  const [selectedId, setSelectedId] = useState<string | null>(
    templates[0]?.id ?? null,
  );
  const nameRef = useRef<HTMLInputElement>(null);

  // A template deleted from under the selection, or a list that arrived empty.
  const selected = templates.find((t) => t.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected && templates.length > 0) setSelectedId(templates[0].id);
  }, [selected, templates]);

  const write = (next: PromptTemplate[]) => patch({ templates: next });

  const update = (id: string, field: "name" | "body", value: string) =>
    write(templates.map((t) => (t.id === id ? { ...t, [field]: value } : t)));

  const add = () => {
    const template: PromptTemplate = {
      id: newTemplateId(),
      name: "New template",
      body: "",
    };
    write([...templates, template]);
    setSelectedId(template.id);
    onNote(null);
    // The name is the first thing to change, and it starts as a placeholder.
    window.setTimeout(() => nameRef.current?.select(), 0);
  };

  const duplicate = (t: PromptTemplate) => {
    const copy = { ...t, id: newTemplateId(), name: `${t.name} copy` };
    const at = templates.findIndex((x) => x.id === t.id);
    write([...templates.slice(0, at + 1), copy, ...templates.slice(at + 1)]);
    setSelectedId(copy.id);
  };

  const remove = (t: PromptTemplate) => {
    write(templates.filter((x) => x.id !== t.id));
    onNote(`Deleted “${t.name}”.`);
  };

  const move = (t: PromptTemplate, by: -1 | 1) => {
    const at = templates.findIndex((x) => x.id === t.id);
    const to = at + by;
    if (to < 0 || to >= templates.length) return;
    const next = [...templates];
    [next[at], next[to]] = [next[to], next[at]];
    write(next);
  };

  const restore = () => {
    const known = new Set(templates.map((t) => t.id));
    const missing = DEFAULT_TEMPLATES.filter((t) => !known.has(t.id));
    if (missing.length === 0) {
      onNote("Every default template is already here.");
      return;
    }
    write([...templates, ...missing]);
    patch({ templatesSeed: TEMPLATE_SEED });
    onNote(
      missing.length === 1
        ? "Put back 1 default template."
        : `Put back ${missing.length} default templates.`,
    );
  };

  const marks = selected ? scan(selected.body) : null;
  const at = selected ? templates.findIndex((t) => t.id === selected.id) : -1;

  return (
    <div className="templates">
      <div className="templates-list" role="listbox" aria-label="Prompt templates">
        {templates.map((t) => (
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
            <span className="template-name">{t.name || "Untitled"}</span>
            <span className="template-summary">{summarize(t.body)}</span>
          </button>
        ))}
        <button className="template-add" onClick={add}>
          + New template
        </button>
      </div>

      <div className="template-editor">
        {selected ? (
          <>
            <label className="template-field">
              <span className="template-field-label">Name</span>
              <input
                ref={nameRef}
                className="template-input"
                value={selected.name}
                onChange={(e) => update(selected.id, "name", e.target.value)}
              />
            </label>

            <label className="template-field template-field-grow">
              <span className="template-field-label">Prompt</span>
              <textarea
                className="template-body"
                value={selected.body}
                spellCheck={false}
                onChange={(e) => update(selected.id, "body", e.target.value)}
              />
            </label>

            <p className="template-legend">
              <code>{"{{file}}"}</code> <code>{"{{project}}"}</code>{" "}
              <code>{"{{branch}}"}</code> are filled in for you.{" "}
              <code>{"{{?label}}"}</code> is asked for when you pick the
              template.
              {marks && marks.asks.length > 0 && (
                <>
                  {" "}
                  This one asks for{" "}
                  <strong>{marks.asks.join(", ")}</strong>.
                </>
              )}
            </p>

            <div className="template-actions">
              <button
                className="template-act"
                onClick={() => move(selected, -1)}
                disabled={at <= 0}
                title="Move up"
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                className="template-act"
                onClick={() => move(selected, 1)}
                disabled={at < 0 || at >= templates.length - 1}
                title="Move down"
                aria-label="Move down"
              >
                ↓
              </button>
              <button className="template-act" onClick={() => duplicate(selected)}>
                Duplicate
              </button>
              <button
                className="template-act template-delete"
                onClick={() => remove(selected)}
              >
                Delete
              </button>
            </div>
          </>
        ) : (
          <p className="picker-empty">
            No templates. Add one, or put the defaults back.
          </p>
        )}
      </div>

      <div className="settings-tab-actions">
        <button className="picker-browse" onClick={restore}>
          Restore default templates
        </button>
      </div>
    </div>
  );
}
