import { basename } from "../window";
import { chordHint } from "../shortcuts/store";

interface Props {
  tabs: string[];
  active: string | null;
  /** Roots with at least one agent still running, for the dot. */
  running: Set<string>;
  /** Roots with sessions waiting on the user, and how many. */
  attention: Map<string, number>;
  onSelect(root: string): void;
  onClose(root: string): void;
  onOpen(): void;
}

/**
 * One tab per open project along the top of the window, as JetBrains does with
 * projects opened into one frame. Each project behind its tab keeps its tree,
 * its git state and its agents running; this strip only picks which is shown.
 */
export function ProjectTabs({ tabs, active, running, attention, onSelect, onClose, onOpen }: Props) {
  return (
    <div className="project-tabs" role="tablist" aria-label="Projects">
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
          <span className="project-tab-label">{basename(root)}</span>
          <button
            className="project-tab-close"
            aria-label={`Close ${basename(root)}`}
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
