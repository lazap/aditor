import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { COMMANDS, GROUPS, commandById, type CommandId } from "../shortcuts/registry";
import { eventChord, formatChord, isBare, isSystemReserved } from "../shortcuts/keys";
import {
  clearBinding,
  isOverridden,
  resetAll,
  setBinding,
  useBindings,
} from "../shortcuts/store";

interface Props {
  onClose(): void;
}

/**
 * Rebinding, in the shape of the project chooser: an opaque overlay over an
 * app that stays mounted underneath, so the agent keeps running.
 *
 * Focusing something on mount is not a nicety -- it takes the caret off the
 * terminal, which would otherwise swallow Escape and every chord being
 * recorded. ProjectPicker does the same for the same reason.
 */
export function ShortcutSettings({ onClose }: Props) {
  const bindings = useBindings();
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => closeRef.current?.focus(), []);

  /** Turn the press into a binding, or explain why it cannot be one. */
  const capture = (id: CommandId, e: KeyboardEvent<HTMLButtonElement>) => {
    // Nothing recorded here may reach the global dispatcher, or binding
    // ⌘1 would also focus the file tree on the way past.
    e.preventDefault();
    e.stopPropagation();

    const native = e.nativeEvent;
    if (native.code === "Escape") {
      setRecording(null);
      setNote(null);
      return;
    }
    const chord = eventChord(native);
    if (chord === null) return; // still only modifiers down

    if (isBare(chord)) {
      setNote("Shortcuts need ⌘ or ⌥ — a bare key would go to the agent.");
      return;
    }
    if (isSystemReserved(native)) {
      setNote(`${formatChord(chord)} is reserved by the system.`);
      return;
    }

    const displaced = setBinding(id, chord);
    setRecording(null);
    setNote(
      displaced
        ? `${formatChord(chord)} taken from “${commandById(displaced).label}”, which is now unbound.`
        : null,
    );
  };

  return (
    <div
      className="picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onKeyDown={(e) => {
        if (recording) return; // the row owns every key while it records
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="picker-card shortcuts-card">
        <h1 className="picker-title">Keyboard shortcuts</h1>

        {GROUPS.map((group) => {
          const rows = COMMANDS.filter((c) => c.group === group);
          if (rows.length === 0) return null;
          return (
            <div className="shortcuts-group" key={group}>
              <div className="picker-section-label">{group}</div>
              {rows.map((c) => {
                const chord = bindings.get(c.id) ?? null;
                const armed = recording === c.id;
                return (
                  <div className="shortcut-row" key={c.id}>
                    <span className="shortcut-label">{c.label}</span>
                    <button
                      className="shortcut-chord"
                      data-armed={armed}
                      data-unbound={chord === null}
                      aria-label={
                        armed
                          ? `Recording a new shortcut for ${c.label}. Press keys, or Escape to cancel.`
                          : `Change the shortcut for ${c.label}`
                      }
                      onKeyDown={(e) => armed && capture(c.id, e)}
                      onClick={() => {
                        setNote(null);
                        setRecording(armed ? null : c.id);
                      }}
                      onBlur={() => armed && setRecording(null)}
                    >
                      {armed
                        ? "Press keys…"
                        : chord === null
                          ? "Unbound"
                          : formatChord(chord)}
                    </button>
                    <button
                      className="shortcut-act"
                      disabled={armed || chord === null}
                      title={`Unbind ${c.label}`}
                      aria-label={`Unbind ${c.label}`}
                      onClick={() => {
                        setNote(null);
                        clearBinding(c.id);
                      }}
                    >
                      ✕
                    </button>
                    {/* A fixed slot, so the rows do not jump as marks appear. */}
                    <span className="shortcut-mark" aria-hidden>
                      {isOverridden(c.id) ? "•" : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}

        {note && <p className="shortcuts-note">{note}</p>}

        <p className="shortcuts-hint">
          A dot marks a shortcut you have changed. Chords reach the agent panel
          and the terminal alike — anything bound here stops being sent to the
          agent.
        </p>

        <div className="picker-actions">
          <button
            className="picker-browse"
            onClick={() => {
              setRecording(null);
              setNote("Every shortcut is back to its default.");
              resetAll();
            }}
          >
            Reset all
          </button>
          <button className="picker-cancel" ref={closeRef} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
