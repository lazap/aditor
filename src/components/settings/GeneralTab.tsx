import { patch, patchLayout, useSettings } from "../../settings/store";

/**
 * The app-level preferences that already existed but had nowhere to live.
 *
 * Small on purpose. Most of these are reachable elsewhere too -- the diff
 * layout from the viewer's own buttons, the agent panel from the topbar toggle
 * -- and each reads the same field, so they cannot drift apart.
 */
export function GeneralTab() {
  const { layout, keyboardMode, appearance, terminalFileLinks, notifications } = useSettings();
  const notify = (next: Partial<typeof notifications>) =>
    patch({ notifications: { ...notifications, ...next } });

  return (
    <>
      <div className="picker-section-label">Appearance</div>
      <div className="setting-row">
        <span className="setting-label">
          Theme
          <span className="setting-sub">
            Light follows IntelliJ Light. System switches with macOS.
          </span>
        </span>
        <div className="seg">
          <button
            className="seg-btn"
            data-active={appearance === "system"}
            onClick={() => patch({ appearance: "system" })}
          >
            System
          </button>
          <button
            className="seg-btn"
            data-active={appearance === "light"}
            onClick={() => patch({ appearance: "light" })}
          >
            Light
          </button>
          <button
            className="seg-btn"
            data-active={appearance === "dark"}
            onClick={() => patch({ appearance: "dark" })}
          >
            Dark
          </button>
        </div>
      </div>

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

      <div className="setting-row">
        <span className="setting-label">
          Open files in
          <span className="setting-sub">
            Where a file picked in the tree opens. One picked in the git list
            opens as a diff, as above.
          </span>
        </span>
        <div className="seg">
          <button
            className="seg-btn"
            data-active={layout.fileDisplay === "pane"}
            onClick={() => patchLayout({ fileDisplay: "pane" })}
          >
            Bottom pane
          </button>
          <button
            className="seg-btn"
            data-active={layout.fileDisplay === "window"}
            onClick={() => patchLayout({ fileDisplay: "window" })}
          >
            Separate window
          </button>
        </div>
      </div>

      <div className="picker-section-label">Keyboard</div>
      <div className="setting-row">
        <span className="setting-label">
          Viewer navigation
          <span className="setting-sub">
            Vim adds <code>j k h l</code>, <code>w b</code>, <code>gg G</code>,{" "}
            <code>Ctrl-d/u</code> and <code>]c [c</code> for the next and
            previous change, while a diff or file has focus.
          </span>
        </span>
        <div className="seg">
          <button
            className="seg-btn"
            data-active={keyboardMode === "standard"}
            onClick={() => patch({ keyboardMode: "standard" })}
          >
            Standard
          </button>
          <button
            className="seg-btn"
            data-active={keyboardMode === "vim"}
            onClick={() => patch({ keyboardMode: "vim" })}
          >
            Vim
          </button>
        </div>
      </div>

      <div className="picker-section-label">Terminal</div>
      <div className="setting-row">
        <span className="setting-label">
          Clickable file paths
          <span className="setting-sub">
            Underline paths the agent prints and open them on click. Only reads
            the line under the mouse, never the output stream.
          </span>
        </span>
        <button
          className="setting-toggle"
          role="switch"
          aria-checked={terminalFileLinks}
          data-on={terminalFileLinks}
          onClick={() => patch({ terminalFileLinks: !terminalFileLinks })}
        >
          {terminalFileLinks ? "On" : "Off"}
        </button>
      </div>

      <div className="picker-section-label">Notifications</div>
      <div className="setting-row">
        <span className="setting-label">
          When an agent finishes
          <span className="setting-sub">
            A macOS notification and a Dock badge, when the session is in a
            background tab or Aditor is not in front.
          </span>
        </span>
        <button
          className="setting-toggle"
          role="switch"
          aria-checked={notifications.onDone}
          data-on={notifications.onDone}
          onClick={() => notify({ onDone: !notifications.onDone })}
        >
          {notifications.onDone ? "On" : "Off"}
        </button>
      </div>
      <div className="setting-row">
        <span className="setting-label">
          When an agent needs you
          <span className="setting-sub">
            A permission prompt, or a question the agent asked through Aditor.
          </span>
        </span>
        <button
          className="setting-toggle"
          role="switch"
          aria-checked={notifications.onWaiting}
          data-on={notifications.onWaiting}
          onClick={() => notify({ onWaiting: !notifications.onWaiting })}
        >
          {notifications.onWaiting ? "On" : "Off"}
        </button>
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
