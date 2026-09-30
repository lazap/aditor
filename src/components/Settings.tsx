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
 * Everything configurable, in a window of its own. The editor keeps running
 * beside it, and changes reach it as they are made -- see `syncWithPeers`.
 *
 * Focusing something on mount gives the keyboard somewhere to land, so Escape
 * works the moment the window appears.
 */
export function Settings({ onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>(() => settings().settingsTab);
  const [note, setNote] = useState<string | null>(null);
  /** A recording row owns every key, Escape included. */
  const [recording, setRecording] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => closeRef.current?.focus(), []);

  // On the window, not the page: WebKit does not focus a button on click, so
  // after clicking a tab or a toggle focus is on <body>, outside the page, and
  // a handler there would never see the key. A recording row has already
  // claimed its Escape (it prevents default), and must not close us with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (recording || e.defaultPrevented || e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, onClose]);

  const choose = (next: SettingsTab) => {
    setTab(next);
    setNote(null);
    patch({ settingsTab: next });
  };

  return (
    <div className="window-page settings-page">
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
  );
}
