import { basename } from "../window";
import { chordHint } from "../shortcuts/store";
import type { UpdateState } from "../update/api";

interface Props {
  tabs: string[];
  active: string | null;
  /** Roots with at least one agent still running, for the dot. */
  running: Set<string>;
  /** Roots with sessions waiting on the user, and how many. */
  attention: Map<string, number>;
  /** Tabs named other than by their folder: a worktree's repo and branch. */
  labels: Map<string, string>;
  onSelect(root: string): void;
  onClose(root: string): void;
  onOpen(): void;
  /** Whether the Mac is being kept awake, and the switch for it. */
  awake: boolean;
  onToggleAwake(): void;
  /** A newer release, once one is found, and the two steps to it. */
  update: UpdateState;
  onInstallUpdate(): void;
  onRestartToUpdate(): void;
}

/**
 * One tab per open project along the top of the window, as JetBrains does with
 * projects opened into one frame. Each project behind its tab keeps its tree,
 * its git state and its agents running; this strip only picks which is shown.
 */
export function ProjectTabs({
  tabs,
  active,
  running,
  attention,
  labels,
  onSelect,
  onClose,
  onOpen,
  awake,
  onToggleAwake,
  update,
  onInstallUpdate,
  onRestartToUpdate,
}: Props) {
  const label = (root: string) => labels.get(root) ?? basename(root);
  return (
    // The strip is the window's title bar: its empty stretch drags the window
    // and a double-click there zooms it. The tabs inside are not drag regions.
    <div className="project-tabs" role="tablist" aria-label="Projects" data-tauri-drag-region>
      {tabs.map((root) => (
        <div
          key={root}
          className="project-tab"
          role="tab"
          aria-selected={root === active}
          title={root}
          onClick={() => onSelect(root)}
          onAuxClick={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            onClose(root);
          }}
        >
          {attention.has(root) ? (
            <span
              className="project-tab-dot"
              data-attention="true"
              aria-label="An agent wants you"
            />
          ) : (
            running.has(root) && <span className="project-tab-dot" aria-label="Agent running" />
          )}
          <span className="project-tab-label">{label(root)}</span>
          <button
            className="project-tab-close"
            aria-label={`Close ${label(root)}`}
            title={chordHint("Close project", "project.close")}
            onClick={(e) => {
              e.stopPropagation();
              onClose(root);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="project-tab-new"
        onClick={onOpen}
        title={chordHint("Open project", "project.open")}
        aria-label="Open project"
      >
        +
      </button>
      <UpdateButton state={update} onInstall={onInstallUpdate} onRestart={onRestartToUpdate} />
      <button
        className="project-tab-awake"
        aria-pressed={awake}
        onClick={onToggleAwake}
        title={chordHint(awake ? "Keeping the Mac awake — click to let it sleep" : "Keep the Mac awake", "app.keepAwake")}
        aria-label="Keep Mac awake"
      >
        <CupIcon steaming={awake} />
      </button>
    </div>
  );
}

/** Nothing until a newer release turns up; then install, progress, restart. */
function UpdateButton({
  state,
  onInstall,
  onRestart,
}: {
  state: UpdateState;
  onInstall(): void;
  onRestart(): void;
}) {
  switch (state.phase) {
    case "idle":
      return null;
    case "available":
      return (
        <button
          className="project-tab-update"
          onClick={onInstall}
          title={state.notes || `Install Aditor ${state.version}`}
        >
          Update to {state.version}
        </button>
      );
    case "installing":
      return (
        <button className="project-tab-update" disabled aria-busy="true">
          Updating{state.percent === null ? "…" : ` ${state.percent}%`}
        </button>
      );
    case "ready":
      return (
        <button
          className="project-tab-update"
          onClick={onRestart}
          title={`Aditor ${state.version} is installed — restart to switch to it`}
        >
          Restart to update
        </button>
      );
  }
}

/** A coffee cup, for the keep-awake switch -- `caffeinate` behind it. Steams while on. */
const CupIcon = ({ steaming }: { steaming: boolean }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 6h9v4a3.5 3.5 0 0 1-3.5 3.5h-2A3.5 3.5 0 0 1 2.5 10V6Z" />
    <path d="M11.5 7.5h1a1.75 1.75 0 0 1 0 3.5h-1.2" />
    {steaming && <path d="M5 2.5v1.5M7 2v2M9 2.5v1.5" />}
  </svg>
);
