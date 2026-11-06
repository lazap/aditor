import type { DictationPhase } from "../voice/useDictation";
import { chordFor } from "../shortcuts/store";
import { formatChord } from "../shortcuts/keys";

interface Props {
  phase: DictationPhase;
  /** Peak of the last few tens of milliseconds, 0 to 1. */
  level: number;
  onFinish(): void;
  onCancel(): void;
}

/**
 * The pill that says the microphone is open, where the toasts appear.
 *
 * Its buttons take the mouse but never focus -- mousedown is swallowed -- so
 * the caret stays wherever the words are about to go.
 */
export function DictationIndicator({ phase, level, onFinish, onCancel }: Props) {
  if (phase === "idle") return null;
  const chord = chordFor("voice.dictate");
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="dictation" data-phase={phase} role="status" aria-live="polite">
      <span
        className="dictation-dot"
        style={{ transform: `scale(${1 + Math.min(1, level * 4) * 0.8})` }}
        aria-hidden
      />
      {phase === "listening" ? (
        <>
          <span>Listening…</span>
          <button className="dictation-btn" onMouseDown={keep} onClick={onFinish}>
            Done{chord && <kbd>{formatChord(chord)}</kbd>}
          </button>
          <button className="dictation-btn" onMouseDown={keep} onClick={onCancel}>
            Cancel<kbd>Esc</kbd>
          </button>
        </>
      ) : (
        <span>Transcribing…</span>
      )}
    </div>
  );
}
