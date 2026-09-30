import { useEffect, useRef, useState } from "react";
import { patch, settings } from "../settings/store";
import type { SettingsTab } from "../settings/schema";
import { GeneralTab } from "./settings/GeneralTab";
import { TemplatesTab } from "./settings/TemplatesTab";
import { ShortcutsTab } from "./settings/ShortcutsTab";

interface Props {
  onClose(): void;
}

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "templates", label: "Prompt templates" },
  { id: "shortcuts", label: "Shortcuts" },
];

/**
 * Everything configurable, in the shape of the project chooser: an opaque
 * overlay over an app that stays mounted underneath, so the agent keeps
 * running.
 *
 * Focusing something on mount is not a nicety -- it takes the caret off the
 * terminal, which would otherwise swallow Escape and every chord the Shortcuts
 * tab tries to record. ProjectPicker does the same for the same reason.
 */
export function Settings({ onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>(() => settings().settingsTab);
  const [note, setNote] = useState<string | null>(null);
  /** A recording row owns every key, Escape included. */
  const [recording, setRecording] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => closeRef.current?.focus(), []);

  const choose = (next: SettingsTab) => {
    setTab(next);
    setNote(null);
    patch({ settingsTab: next });
  };

  return (
    <div
      className="picker-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onKeyDown={(e) => {
        if (recording) return;
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="picker-card settings-card">
        <h1 className="picker-title">Settings</h1>

        <div className="settings-body">
          <div className="settings-tabs" role="tablist" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                className="settings-tab"
                role="tab"
                aria-selected={tab === t.id}
                data-active={tab === t.id}
                onClick={() => choose(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="settings-panel" role="tabpanel">
            {tab === "general" && <GeneralTab />}
            {tab === "templates" && <TemplatesTab onNote={setNote} />}
            {tab === "shortcuts" && (
              <ShortcutsTab onNote={setNote} onRecording={setRecording} />
            )}
          </div>
        </div>

        {note && <p className="shortcuts-note">{note}</p>}

        <div className="picker-actions">
          <button className="picker-cancel" ref={closeRef} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
