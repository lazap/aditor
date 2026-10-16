import { basename } from "../window";
import { chordHint } from "../shortcuts/store";

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
    </div>
  );
}
