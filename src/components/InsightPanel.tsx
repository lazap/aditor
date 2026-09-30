import type { AgentInfo } from "../pty/api";
import type { InsightTab } from "../settings/schema";
import { patchLayout, useSetting } from "../settings/store";
import { chordHint } from "../shortcuts/store";
import { AgentSessions } from "./AgentSessions";
import { AgentTasks, useAgentTasks } from "./AgentTasks";

interface Props {
  agent: AgentInfo | null;
  workspace: string;
  refreshToken: number;
  onAccountChanged(): void;
  onClose(): void;
}

/** Tab glyphs, drawn like the rail's: stroked in `currentColor`. */
const InfoIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" focusable="false" aria-hidden="true">
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4" />
    <circle cx="8" cy="4.9" r="0.4" fill="currentColor" />
  </svg>
);

const TasksIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" focusable="false"
    aria-hidden="true">
    <path d="M1.75 3.5l1.25 1.25 2.25-2.5" />
    <path d="M1.75 8.5l1.25 1.25 2.25-2.5" />
    <rect x="2" y="12" width="2.75" height="2.5" rx="0.5" />
    <path d="M7.5 3.5h7M7.5 8.5h7M7.5 13.25h7" />
  </svg>
);

/**
 * The right-hand agent panel: whichever tab is selected, with the tab strip on
 * the window's outer edge -- the rail's strip, mirrored.
 */
export function InsightPanel({ agent, onClose, ...info }: Props) {
  const tab = useSetting((s) => s.layout.insightTab);
  const tasks = useAgentTasks();
  const done = tasks.filter((t) => t.status === "completed").length;
  const select = (t: InsightTab) => patchLayout({ insightTab: t });

  return (
    <>
      <div className="insight-inner">
        <div className="insight-bar">
          <span className="insight-heading">
            {agent?.label ?? "Agent"}
            {tab === "tasks" && " · Tasks"}
          </span>
          <button className="insight-close" onClick={onClose} title="Hide panel">
            ✕
          </button>
        </div>

        {/* Both stay mounted, as in the rail: remounting Info would refetch
            the sessions and fold every expanded row. */}
        <div className="insight-body" hidden={tab !== "info"}>
          <AgentSessions agent={agent} {...info} />
        </div>
        <div className="insight-body" hidden={tab !== "tasks"}>
          <AgentTasks agent={agent} tasks={tasks} />
        </div>
      </div>

      <nav className="rail-tabs insight-tabs" role="tablist" aria-orientation="vertical">
        <button
          className="rail-tab"
          role="tab"
          aria-selected={tab === "info"}
          aria-label="Agent info"
          title={chordHint("Agent info", "focus.agentInfo")}
          onClick={() => select("info")}
        >
          <InfoIcon />
        </button>
        <button
          className="rail-tab"
          role="tab"
          aria-selected={tab === "tasks"}
          aria-label="Tasks"
          title={chordHint("Tasks", "focus.agentTasks")}
          onClick={() => select("tasks")}
        >
          <TasksIcon />
          {tasks.length > 0 && (
            <span className="rail-tab-badge">
              {done}/{tasks.length}
            </span>
          )}
        </button>
      </nav>
    </>
  );
}
