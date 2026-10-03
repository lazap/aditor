import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { formatChord } from "../shortcuts/keys";

interface ModalProps {
  title: string;
  children: ReactNode;
  /** The primary button. Disabled while `canConfirm` is false. */
  confirm: string;
  canConfirm?: boolean;
  /** A destructive action: the primary button reads as one. */
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
  /** Wider card, for dialogs that list commits. */
  wide?: boolean;
  /** Wider and taller still, for a dialog with a list beside a form. */
  large?: boolean;
}

/**
 * A card over a dimmed window, for the git actions that need a word from the
 * user first. Escape cancels; ⌘⏎ confirms from anywhere in it, and plain
 * Enter does too unless the caret is in a multi-line field.
 */
export function Modal({
  title,
  children,
  confirm,
  canConfirm = true,
  danger,
  onConfirm,
  onCancel,
  wide,
  large,
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Whatever had focus gets it back, so a dialog opened from the keyboard
  // leaves the keyboard where it was.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = cardRef.current?.querySelector<HTMLElement>(
      "input:not([type=checkbox]):not([type=radio]), textarea, .modal-primary",
    );
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Nothing behind the card may react to a key meant for it.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Enter") return;
    const inTextarea = (e.target as HTMLElement).tagName === "TEXTAREA";
    const onButton = (e.target as HTMLElement).tagName === "BUTTON";
    if (onButton && !(e.metaKey || e.ctrlKey)) return;
    if (inTextarea && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (canConfirm) onConfirm();
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal-card"
        data-wide={wide}
        data-large={large}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={cardRef}
        onKeyDown={onKeyDown}
      >
        <div className="modal-title">{title}</div>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="modal-primary"
            data-danger={danger}
            disabled={!canConfirm}
            onClick={onConfirm}
            title={formatChord("mod+enter")}
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- dialogs ---

export interface DialogSpec {
  title: string;
  /** Text above the fields. */
  body?: ReactNode;
  /** A single-line field, e.g. a branch name. */
  input?: { label: string; initial?: string; placeholder?: string };
  /** A multi-line field under it, e.g. a tag message. */
  message?: { label: string; placeholder?: string };
  checks?: { id: string; label: string; initial?: boolean }[];
  /** Mutually exclusive options, e.g. a reset mode. */
  choices?: { id: string; label: string; hint?: string }[];
  initialChoice?: string;
  confirm: string;
  danger?: boolean;
  /** An error for the current input, which also disables confirming. */
  validate?(text: string): string | null;
}

export interface DialogResult {
  text: string;
  message: string;
  checks: Record<string, boolean>;
  choice: string | null;
}

function Dialog({
  spec,
  onDone,
}: {
  spec: DialogSpec;
  onDone(r: DialogResult | null): void;
}) {
  const [text, setText] = useState(spec.input?.initial ?? "");
  const [message, setMessage] = useState("");
  const [checks, setChecks] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((spec.checks ?? []).map((c) => [c.id, !!c.initial])),
  );
  const [choice, setChoice] = useState<string | null>(
    spec.initialChoice ?? spec.choices?.[0]?.id ?? null,
  );
  const error = spec.input ? (spec.validate?.(text) ?? null) : null;
  const missing = !!spec.input && text.trim() === "";

  return (
    <Modal
      title={spec.title}
      confirm={spec.confirm}
      danger={spec.danger || (choice === "hard")}
      canConfirm={!error && !missing}
      onCancel={() => onDone(null)}
      onConfirm={() => onDone({ text: text.trim(), message, checks, choice })}
    >
      {spec.body && <div className="modal-text">{spec.body}</div>}
      {spec.input && (
        <label className="modal-field">
          <span>{spec.input.label}</span>
          <input
            value={text}
            placeholder={spec.input.placeholder}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          {error && text !== "" && <span className="modal-error">{error}</span>}
        </label>
      )}
      {spec.message && (
        <label className="modal-field">
          <span>{spec.message.label}</span>
          <textarea
            rows={3}
            value={message}
            placeholder={spec.message.placeholder}
            spellCheck={false}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
      )}
      {spec.choices && (
        <div className="modal-choices" role="radiogroup">
          {spec.choices.map((c) => (
            <label key={c.id} className="modal-check">
              <input
                type="radio"
                name="choice"
                checked={choice === c.id}
                onChange={() => setChoice(c.id)}
              />
              <span>
                {c.label}
                {c.hint && <span className="modal-hint"> — {c.hint}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      {spec.checks?.map((c) => (
        <label key={c.id} className="modal-check">
          <input
            type="checkbox"
            checked={checks[c.id]}
            onChange={(e) =>
              setChecks((prev) => ({ ...prev, [c.id]: e.target.checked }))
            }
          />
          <span>{c.label}</span>
        </label>
      ))}
    </Modal>
  );
}

/**
 * Promise-shaped dialogs: `await ask(spec)` resolves to the answers, or null
 * when cancelled. Render `host` once wherever the dialogs should appear.
 */
export function useDialogs(): [ReactNode, (spec: DialogSpec) => Promise<DialogResult | null>] {
  const [open, setOpen] = useState<{
    spec: DialogSpec;
    resolve(r: DialogResult | null): void;
  } | null>(null);

  const ask = useCallback(
    (spec: DialogSpec) =>
      new Promise<DialogResult | null>((resolve) => setOpen({ spec, resolve })),
    [],
  );

  const host = open ? (
    <Dialog
      // A new spec is a new dialog, with fresh fields.
      key={open.spec.title + (open.spec.input?.initial ?? "")}
      spec={open.spec}
      onDone={(r) => {
        setOpen(null);
        open.resolve(r);
      }}
    />
  ) : null;

  return [host, ask];
}

/** What git would refuse as a branch or tag name, in words. */
export function refNameError(name: string): string | null {
  const n = name.trim();
  if (n === "") return null;
  if (/\s/.test(n)) return "No spaces.";
  if (n.startsWith("-")) return "Cannot start with a dash.";
  if (/\.\.|[~^:?*[\\]|@\{/.test(n)) return "Contains a character git does not allow.";
  if (n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock") || n.startsWith("/"))
    return "Not a valid name.";
  return null;
}
