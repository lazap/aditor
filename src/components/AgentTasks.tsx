import { useEffect, useState } from "react";
import type { AgentInfo } from "../pty/api";
import { useActiveSession } from "../pty/api";
import { mcpTasks, onTasks, type Task, type TaskStatus } from "../mcp/api";

/**
 * The task list the running agent last published, following the agent across
 * respawns. Lives above the tabs so the Tasks badge stays current while the
 * Info tab is showing.
 */
export function useAgentTasks(): Task[] {
  const session = useActiveSession();
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    setTasks([]);
    if (!session) return;
    let disposed = false;
    // An update that lands while the initial load is in flight is newer than
    // whatever the load returns, so it wins.
    let live = false;
    const unlisten = onTasks((id, next) => {
      if (id !== session || disposed) return;
      live = true;
      setTasks(next);
    });
    void mcpTasks(session)
      .then((t) => {
        if (!disposed && !live) setTasks(t);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      void unlisten.then((u) => u());
    };
  }, [session]);

  return tasks;
}

const GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
};

interface Props {
  agent: AgentInfo | null;
  tasks: Task[];
}

export function AgentTasks({ agent, tasks }: Props) {
  if (agent && agent.id !== "claude") {
    return (
      <div className="insight-empty">
        Tasks are only available for Claude Code.
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className="insight-empty">
        No tasks yet. Claude posts its plan here as it works.
      </div>
    );
  }

  const done = tasks.filter((t) => t.status === "completed").length;
  const pct = (done / tasks.length) * 100;

  return (
    <div className="tasks">
      <div className="meter">
        <div className="meter-line">
          <span className="meter-label">
            {done} of {tasks.length} done
          </span>
          <span className="meter-pct">{Math.round(pct)}%</span>
        </div>
        <div className="meter-track">
          <div className="meter-fill" data-level="ok" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="task-list">
        {tasks.map((t, i) => (
          <li key={i} className="task-row" data-status={t.status}>
            <span className="task-status" aria-label={t.status.replace("_", " ")}>
              {GLYPH[t.status]}
            </span>
            <div className="task-body">
              <div className="task-title">{t.title}</div>
              {t.detail && <div className="task-detail">{t.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
