import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../settings/store";
import type { PromptTemplate } from "../templates/registry";
import { fillContext, resolve, scan, type Context } from "../templates/placeholders";

interface Props {
  ctx: Context;
  /** Insert the finished prompt into the agent. */
  onInsert(text: string): void;
  onClose(): void;
}

/**
 * Pick a saved prompt and type it into the agent.
 *
 * The overlay shape is the project chooser's, and for the same reason: the app
 * stays mounted behind it, because unmounting the subtree with TerminalPane in
 * it would kill the running agent. Focus goes into the filter on mount, which
 * also takes the caret off the terminal -- otherwise xterm swallows Escape and
 * the arrow keys.
 */
export function TemplatePicker({ ctx, onInsert, onClose }: Props) {
  const templates = useSettings().templates;
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  /** Non-null once a template with `{{?…}}` has been chosen. */
  const [asking, setAsking] = useState<PromptTemplate | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const filterRef = useRef<HTMLInputElement>(null);
  const firstAskRef = useRef<HTMLInputElement>(null);

  useEffect(() => filterRef.current?.focus(), []);
  useEffect(() => {
    if (asking) firstAskRef.current?.focus();
  }, [asking]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q),
    );
  }, [templates, query]);

  // Keep the highlight on the list as it narrows.
  const index = Math.min(at, Math.max(0, matches.length - 1));
  const highlighted = matches[index] ?? null;

  const insert = (t: PromptTemplate, filled: Record<string, string>) => {
    onInsert(resolve(t.body, ctx, filled));
    onClose();
  };

  const choose = (t: PromptTemplate) => {
    const asks = scan(t.body).asks;
    if (asks.length === 0) {
      insert(t, {});
      return;
    }
    setAnswers(Object.fromEntries(asks.map((a) => [a, ""])));
    setAsking(t);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Back out of the questions first, rather than losing the choice too.
      if (asking) setAsking(null);
      else onClose();
      return;
    }
    if (asking) return; // the form owns its own keys
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAt(matches.length === 0 ? 0 : (index + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt(matches.length === 0 ? 0 : (index - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter" && highlighted) {
      e.preventDefault();
      choose(highlighted);
    }
  };

  const preview = asking
    ? resolve(asking.body, ctx, answers)
    : highlighted
      ? fillContext(highlighted.body, ctx)
      : "";

  return (
    <div
      className="picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Prompt templates"
      onKeyDown={onKeyDown}
    >
      <div className="picker-card templates-card">
        <h1 className="picker-title">Prompt templates</h1>

        {asking ? (
          <form
            className="asks"
            onSubmit={(e) => {
              e.preventDefault();
              insert(asking, answers);
            }}
          >
            <div className="picker-section-label">{asking.name}</div>
            {scan(asking.body).asks.map((label, i) => (
              <label className="ask-field" key={label}>
                <span className="ask-label">{label}</span>
                <input
                  ref={i === 0 ? firstAskRef : undefined}
                  className="template-input"
                  value={answers[label] ?? ""}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [label]: e.target.value }))
                  }
                />
              </label>
            ))}
            <pre className="template-preview">{preview}</pre>
            <div className="picker-actions">
              <button className="picker-browse" type="submit">
                Insert
              </button>
              <button
                className="picker-cancel"
                type="button"
                onClick={() => setAsking(null)}
              >
                Back
              </button>
            </div>
          </form>
        ) : (
          <>
            <input
              ref={filterRef}
              className="template-filter"
              placeholder="Filter templates…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setAt(0);
              }}
            />

            {matches.length === 0 ? (
              <p className="picker-empty">
                {templates.length === 0
                  ? "No templates yet. Add some in Settings."
                  : "Nothing matches."}
              </p>
            ) : (
              <div className="template-choose">
                <div className="templates-list" role="listbox">
                  {matches.map((t, i) => (
                    <button
                      key={t.id}
                      className="template-row"
                      role="option"
                      aria-selected={i === index}
                      data-selected={i === index}
                      onMouseEnter={() => setAt(i)}
                      onClick={() => choose(t)}
                    >
                      <span className="template-name">{t.name || "Untitled"}</span>
                      {scan(t.body).asks.length > 0 && (
                        <span className="template-asks" title="Asks before inserting">
                          ?
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <pre className="template-preview">{preview}</pre>
              </div>
            )}

            <p className="settings-hint">
              The prompt is typed into the agent, not sent — press Enter
              yourself once you have added anything else it needs.
            </p>

            <div className="picker-actions">
              <button className="picker-cancel" type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
