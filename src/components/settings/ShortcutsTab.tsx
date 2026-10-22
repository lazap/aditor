import { useState, type KeyboardEvent } from "react";
import { COMMANDS, GROUPS, commandById, type CommandId } from "../../shortcuts/registry";
import { eventChord, formatChord, isBare, isSystemReserved } from "../../shortcuts/keys";
import {
  clearBinding,
  isOverridden,
  resetAll,
  setBinding,
  useBindings,
} from "../../shortcuts/store";

interface Props {
  /** Told to the dialog, which owns the note line under every tab. */
  onNote(note: string | null): void;
  /**
   * While a row is recording it owns every key, Escape included. The dialog
   * must not close underneath it.
   */
  onRecording(recording: boolean): void;
}

/**
 * Rebinding. The body of the Settings dialog's Shortcuts tab.
 *
 * The dialog around it does the focus-on-mount that takes the caret off the
 * terminal -- without that, xterm swallows Escape and every chord being
 * recorded here.
 */
export function ShortcutsTab({ onNote, onRecording }: Props) {
  const bindings = useBindings();
  const [recording, setRecording] = useState<CommandId | null>(null);

  const arm = (id: CommandId | null) => {
    setRecording(id);
    onRecording(id !== null);
  };

  /** Turn the press into a binding, or explain why it cannot be one. */
  const capture = (id: CommandId, e: KeyboardEvent<HTMLButtonElement>) => {
    // Nothing recorded here may reach the global dispatcher, or binding
    // ⌘1 would also switch session tab on the way past.
    e.preventDefault();
    e.stopPropagation();

    const native = e.nativeEvent;
    if (native.code === "Escape") {
      arm(null);
      onNote(null);
      return;
    }
    const chord = eventChord(native);
    if (chord === null) return; // still only modifiers down

    if (isBare(chord)) {
      onNote("Shortcuts need ⌘ or ⌥ — Ctrl and bare keys go to the agent.");
      return;
    }
    if (isSystemReserved(native)) {
      onNote(`${formatChord(chord)} is reserved by the system.`);
      return;
    }

    const displaced = setBinding(id, chord);
    arm(null);
    onNote(
      displaced
        ? `${formatChord(chord)} taken from “${commandById(displaced).label}”, which is now unbound.`
        : null,
    );
  };

  return (
    <>
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
                      onNote(null);
                      arm(armed ? null : c.id);
                    }}
                    onBlur={() => armed && arm(null)}
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
                      onNote(null);
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

      <p className="settings-hint">
        A dot marks a shortcut you have changed. Chords reach the agent panel
        and the terminal alike — anything bound here stops being sent to the
        agent.
      </p>

      <div className="settings-tab-actions">
        <button
          className="picker-browse"
          onClick={() => {
            arm(null);
            onNote("Every shortcut is back to its default.");
            resetAll();
          }}
        >
          Reset all shortcuts
        </button>
      </div>
    </>
  );
}
