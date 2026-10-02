import { useEffect, useRef, useState } from "react";
import { DiffViewer } from "./DiffViewer";
import { useSetting } from "../settings/store";
import type { AskAnswer, AskPrompt, McpPrompt, ReviewAnswer, ReviewPrompt } from "../mcp/api";

interface Props {
  prompt: McpPrompt;
  /** Files with changes, for a review that did not name its own. Absolute. */
  changed: string[];
  /** Bumped by the workspace watcher, so open diffs follow later edits. */
  refreshToken: number;
  /** Its session is on screen: only then does it take the caret. */
  visible: boolean;
  onAnswer(answer: AskAnswer | ReviewAnswer): void;
}

/**
 * A question the agent asked through Aditor's MCP server, docked over the
 * bottom of its own session. Not a window-wide modal: the agent is blocked on
 * it, but every other session, and the rest of the window, carries on.
 */
export function AgentPrompt({ prompt, changed, refreshToken, visible, onAnswer }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Take the caret from the terminal, or the keys meant for the card would go
  // to the agent, which is waiting on this and not reading.
  useEffect(() => {
    if (!visible) return;
    cardRef.current
      ?.querySelector<HTMLElement>(".prompt-option, textarea, .modal-primary")
      ?.focus();
  }, [visible, prompt.requestId]);

  const dismiss = () =>
    onAnswer(prompt.kind === "ask" ? { dismissed: true } : { decision: "dismissed", comment: "" });

  return (
    <div
      className="agent-prompt"
      data-kind={prompt.kind}
      ref={cardRef}
      role="dialog"
      aria-label={prompt.kind === "ask" ? "The agent asks" : "Review requested"}
      onKeyDown={(e) => {
        // The window's shortcut listener must not act on keys meant for the card.
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          dismiss();
        }
      }}
    >
      {prompt.kind === "ask" ? (
        <Ask prompt={prompt} onAnswer={onAnswer} onDismiss={dismiss} />
      ) : (
        <Review
          prompt={prompt}
          changed={changed}
          refreshToken={refreshToken}
          onAnswer={onAnswer}
          onDismiss={dismiss}
        />
      )}
    </div>
  );
}

function Ask({
  prompt,
  onAnswer,
  onDismiss,
}: {
  prompt: AskPrompt;
  onAnswer(a: AskAnswer): void;
  onDismiss(): void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [other, setOther] = useState("");
  const { options, multiSelect } = prompt;

  const submit = (chosen: Set<number>) =>
    onAnswer({
      selected: options.filter((_, i) => chosen.has(i)).map((o) => o.label),
      other: other.trim() === "" ? null : other.trim(),
    });

  const choose = (i: number) => {
    // One choice is the whole answer; several are gathered until Submit.
    if (!multiSelect) return submit(new Set([i]));
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const canSubmit = picked.size > 0 || other.trim() !== "";

  return (
    <>
      <div className="prompt-head">
        <span className="prompt-badge">Agent asks</span>
        <span className="prompt-question">{prompt.question}</span>
      </div>
      <div
        className="prompt-options"
        onKeyDown={(e) => {
          if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
          const n = Number(e.key);
          if (Number.isInteger(n) && n >= 1 && n <= options.length) {
            e.preventDefault();
            choose(n - 1);
          }
        }}
      >
        {options.map((o, i) => (
          <button
            key={i}
            className="prompt-option"
            aria-pressed={multiSelect ? picked.has(i) : undefined}
            onClick={() => choose(i)}
          >
            <span className="prompt-key">{i + 1}</span>
            <span className="prompt-option-text">
              <span className="prompt-option-label">{o.label}</span>
              {o.description && <span className="prompt-option-desc">{o.description}</span>}
            </span>
          </button>
        ))}
      </div>
      {prompt.allowOther && (
        <input
          className="prompt-other"
          placeholder="Or type an answer…"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault();
              submit(picked);
            }
          }}
        />
      )}
      <div className="prompt-actions">
        <button className="modal-cancel" onClick={onDismiss}>
          Dismiss
        </button>
        {(multiSelect || prompt.allowOther) && (
          <button className="modal-primary" disabled={!canSubmit} onClick={() => submit(picked)}>
            Submit
          </button>
        )}
      </div>
    </>
  );
}

function Review({
  prompt,
  changed,
  refreshToken,
  onAnswer,
  onDismiss,
}: {
  prompt: ReviewPrompt;
  changed: string[];
  refreshToken: number;
  onAnswer(a: ReviewAnswer): void;
  onDismiss(): void;
}) {
  const layout = useSetting((s) => s.layout.diffLayout);
  const files = prompt.paths ?? changed;
  // The first file starts open: a review with one file should not need a click.
  const [open, setOpen] = useState<Set<string>>(() => new Set(files.slice(0, 1)));
  const [comment, setComment] = useState("");
  const rel = (p: string) => (p.startsWith(`${prompt.root}/`) ? p.slice(prompt.root.length + 1) : p);

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <>
      <div className="prompt-head">
        <span className="prompt-badge">Review requested</span>
        <span className="prompt-question">{prompt.summary}</span>
      </div>
      <div className="prompt-files">
        {files.length === 0 && <div className="modal-hint">No changed files.</div>}
        {files.map((p) => (
          <div key={p} className="prompt-file">
            <button className="prompt-file-head" onClick={() => toggle(p)} aria-expanded={open.has(p)}>
              <span className="tree-chevron">{open.has(p) ? "▾" : "▸"}</span>
              <span className="prompt-file-path">{rel(p)}</span>
            </button>
            {open.has(p) && (
              <div className="prompt-diff">
                <DiffViewer root={prompt.root} path={p} layout={layout} refreshToken={refreshToken} />
              </div>
            )}
          </div>
        ))}
      </div>
      <textarea
        className="prompt-comment"
        placeholder="Comments for the agent (optional to approve)"
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="prompt-actions">
        <button className="modal-cancel" onClick={onDismiss}>
          Dismiss
        </button>
        <button
          className="modal-cancel"
          onClick={() => onAnswer({ decision: "changes_requested", comment })}
        >
          Request changes
        </button>
        <button className="modal-primary" onClick={() => onAnswer({ decision: "approved", comment })}>
          Approve
        </button>
      </div>
    </>
  );
}
