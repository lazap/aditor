import { useEffect } from "react";
import { patch, useSettings } from "../../settings/store";
import { chordFor } from "../../shortcuts/store";
import { formatChord } from "../../shortcuts/keys";
import { formatBytes, LANGUAGES, MODEL_LABELS, useVoiceModels } from "../../voice/api";

interface Props {
  onNote(text: string): void;
}

/**
 * Voice dictation: which local model to download and use.
 *
 * Nothing is downloaded until asked for -- the app ships the engine, not the
 * weights. A model that is on disk is used; with two, the one picked here.
 */
export function VoiceSection({ onNote }: Props) {
  const { voice } = useSettings();
  const { models, download, cancel, remove } = useVoiceModels(onNote);
  const chord = chordFor("voice.dictate");

  // The picked model is gone, or was never fetched, but another is on disk:
  // use that one rather than leave dictation refusing.
  useEffect(() => {
    const picked = models.find((m) => m.id === voice.model);
    if (picked?.downloaded) return;
    const other = models.find((m) => m.downloaded);
    if (other) patch({ voice: { ...voice, model: other.id } });
  }, [models, voice]);

  const active = models.find((m) => m.id === voice.model && m.downloaded);

  return (
    <>
      <div className="picker-section-label">Voice dictation</div>
      {models.map((m) => {
        const label = MODEL_LABELS[m.id];
        const inUse = active?.id === m.id;
        return (
          <div className="setting-row" key={m.id}>
            <span className="setting-label">
              {label.name}
              <span className="setting-sub">
                {formatBytes(m.bytes)}. {label.blurb}
              </span>
            </span>
            {m.receiving !== null ? (
              <>
                <span className="voice-progress" aria-live="polite">
                  <span
                    className="voice-progress-bar"
                    style={{ width: `${Math.min(100, (m.receiving / m.bytes) * 100)}%` }}
                  />
                </span>
                <span className="voice-progress-text">
                  {Math.floor((m.receiving / m.bytes) * 100)}%
                </span>
                <button className="setting-toggle" onClick={cancel}>
                  Cancel
                </button>
              </>
            ) : m.downloaded ? (
              <>
                <button
                  className="setting-toggle"
                  data-on={inUse}
                  aria-pressed={inUse}
                  onClick={() => patch({ voice: { ...voice, model: m.id } })}
                >
                  {inUse ? "In use" : "Use"}
                </button>
                <button className="setting-toggle" onClick={() => remove(m.id)}>
                  Remove
                </button>
              </>
            ) : (
              <button
                className="setting-toggle"
                disabled={models.some((o) => o.receiving !== null)}
                onClick={() => download(m.id)}
              >
                Download
              </button>
            )}
          </div>
        );
      })}

      {active?.id !== "small.en-q5_1" && (
        <div className="setting-row">
          <span className="setting-label">
            Language
            <span className="setting-sub">
              What you will speak. Detecting it costs a little accuracy on short
              phrases.
            </span>
          </span>
          <select
            className="setting-select"
            value={voice.language}
            onChange={(e) => patch({ voice: { ...voice, language: e.target.value } })}
          >
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      <p className="settings-hint">
        {active ? (
          <>
            {chord ? <code>{formatChord(chord)}</code> : "The Dictate shortcut"} starts
            listening and stops again; hold it down to talk for as long as it is held.
            Esc throws the recording away. The words go where you were typing, or to
            the agent. Everything runs on this computer.
          </>
        ) : (
          <>
            Download a model to dictate prompts by voice. It is transcribed on this
            computer: no audio leaves it.
          </>
        )}
      </p>
    </>
  );
}
