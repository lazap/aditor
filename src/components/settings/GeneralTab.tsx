import { patchLayout, useSettings } from "../../settings/store";

/**
 * The app-level preferences that already existed but had nowhere to live.
 *
 * Small on purpose. Most of these are reachable elsewhere too -- the diff
 * layout from the viewer's own buttons, the agent panel from the topbar toggle
 * -- and each reads the same field, so they cannot drift apart.
 */
export function GeneralTab() {
  const { layout } = useSettings();

  return (
    <>
      <div className="picker-section-label">Diff view</div>
      <div className="setting-row">
        <span className="setting-label">
          Layout
          <span className="setting-sub">
            What the viewer opens with. The buttons above a diff still override
            it for the session.
          </span>
        </span>
        <div className="seg">
          <button
            className="seg-btn"
            data-active={layout.diffLayout === "unified"}
            onClick={() => patchLayout({ diffLayout: "unified" })}
          >
            Unified
          </button>
          <button
            className="seg-btn"
            data-active={layout.diffLayout === "split"}
            onClick={() => patchLayout({ diffLayout: "split" })}
          >
            Split
          </button>
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-label">
          Open diffs in
          <span className="setting-sub">
            Under the terminal, or in a window of its own that follows the
            agent's edits and can sit beside the editor.
          </span>
        </span>
        <div className="seg">
          <button
            className="seg-btn"
            data-active={layout.diffDisplay === "pane"}
            onClick={() => patchLayout({ diffDisplay: "pane" })}
          >
            Bottom pane
          </button>
          <button
            className="seg-btn"
            data-active={layout.diffDisplay === "window"}
            onClick={() => patchLayout({ diffDisplay: "window" })}
          >
            Separate window
          </button>
        </div>
      </div>

      <div className="picker-section-label">Agent panel</div>
      <div className="setting-row">
        <span className="setting-label">
          Show the panel
          <span className="setting-sub">
            Sessions, token spend and the account switcher, down the right-hand
            side.
          </span>
        </span>
        <button
          className="setting-toggle"
          role="switch"
          aria-checked={layout.insightOpen}
          data-on={layout.insightOpen}
          onClick={() => patchLayout({ insightOpen: !layout.insightOpen })}
        >
          {layout.insightOpen ? "On" : "Off"}
        </button>
      </div>

      <p className="settings-hint">
        Settings live in <code>~/.aditor/settings.json</code>, next to the saved
        logins — a file you can read, back up and carry between machines.
      </p>
    </>
  );
}
