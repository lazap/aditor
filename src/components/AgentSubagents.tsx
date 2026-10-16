import { useEffect, useMemo, useState } from "react";
import type { AgentInfo } from "../pty/api";
import { useActiveSession } from "../pty/api";
import {
  approx,
  formatElapsed,
  formatRelative,
  formatTokens,
  formatUsd,
  totalTokens,
  type SessionSummary,
  type SubagentStatus,
  type SubagentSummary,
} from "../agents/api";

/** Still working, as far as the transcript says. */
const isActive = (s: SubagentSummary) => s.status === "running" || s.status === "stalled";

/** Every subagent of the live sessions still at work. Drives the tab's badge. */
export const runningSubagents = (sessions: SessionSummary[]) =>
  sessions.reduce((n, s) => n + s.subagents.filter((a) => a.status === "running").length, 0);

const LABEL: Record<SubagentStatus, string> = {
  running: "running",
  done: "done",
  interrupted: "interrupted",
  stalled: "no activity",
};

function StatusMark({ status }: { status: SubagentStatus }) {
  if (status === "running") return <span className="isub-spinner" aria-label="running" />;
  const glyph = status === "done" ? "✓" : status === "interrupted" ? "✕" : "!";
  return (
    <span className="isub-mark" data-status={status} aria-label={LABEL[status]}>
      {glyph}
    </span>
  );
}

function Row({
  agent,
  open,
  onToggle,
}: {
  agent: SubagentSummary;
  open: boolean;
  onToggle(): void;
}) {
  const { totals } = agent;
  const active = isActive(agent);
  return (
    <div className="isession isub" data-status={agent.status}>
      <div className="isession-row">
        <button className="isession-head" onClick={onToggle} aria-expanded={open}>
          <span className="tree-chevron">{open ? "▾" : "▸"}</span>
          <StatusMark status={agent.status} />
          <span className="isession-title">
            {agent.description ?? agent.agentType ?? agent.id.slice(0, 8)}
          </span>
          <span className="isession-cost">
            {approx(totals)}
            {formatUsd(totals.costUsd)}
          </span>
        </button>
      </div>

      <div className="isession-sub">
        {agent.agentType && <span className="viewer-badge">{agent.agentType}</span>}
        <span>
          {active ? formatElapsed(agent.startedAt) : formatRelative(agent.lastAt)}
        </span>
        <span className="isession-sep">·</span>
        <span>{formatTokens(totalTokens(totals))} tok</span>
        {agent.status !== "running" && agent.status !== "done" && (
          <>
            <span className="isession-sep">·</span>
            <span>{LABEL[agent.status]}</span>
          </>
        )}
      </div>

      {agent.activity && (
        <div className="isub-activity" title={agent.activity}>
          {agent.activity}
        </div>
      )}

      {open && (
        <div className="isession-detail">
          {agent.prompt && <pre className="isub-prompt">{agent.prompt}</pre>}
          {agent.models.map((m) => (
            <div className="imodel" key={m.model}>
              <div className="imodel-head">
                <span className="viewer-badge">{m.model}</span>
                <span className="imodel-cost">{formatUsd(m.costUsd)}</span>
              </div>
            </div>
          ))}
          <div className="isession-started">
            {agent.turns} turn{agent.turns === 1 ? "" : "s"}
            {" · "}
            {agent.background ? "background" : "foreground"}
            {agent.depth > 1 && ` · depth ${agent.depth}`}
            {" · "}started {formatRelative(agent.startedAt)}
            {active && ` · last activity ${formatRelative(agent.lastAt)}`}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  agent: AgentInfo | null;
  sessions: SessionSummary[];
  /** The group heading's Show: switch to the tab the session runs in. */
  onShow(session: SessionSummary): void;
}

/**
 * The subagents the live sessions in this project have spawned: what each was
 * asked, what it is doing now, and what it has cost. Finished ones stay listed
 * for as long as their session runs.
 */
export function AgentSubagents({ agent, sessions, onShow }: Props) {
  const activeSession = useActiveSession();
  const [open, setOpen] = useState<Set<string>>(new Set());

  // The elapsed times are relative to now, and a subagent deep in a long tool
  // call writes nothing to refresh them with.
  const anyActive = sessions.some((s) => s.subagents.some(isActive));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!anyActive) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [anyActive]);

  // The session in the tab being looked at first; within a session, the ones
  // still working first, then newest first.
  const groups = useMemo(
    () =>
      sessions
        .filter((s) => s.live && s.subagents.length > 0)
        .sort(
          (a, b) =>
            Number(b.live?.ptyId === activeSession) - Number(a.live?.ptyId === activeSession) ||
            b.lastAt - a.lastAt,
        )
        .map((s) => ({
          session: s,
          agents: [...s.subagents].sort(
            (a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt - a.startedAt,
          ),
        })),
    [sessions, activeSession],
  );

  if (agent && agent.id !== "claude") {
    return (
      <div className="insight-empty">Subagents are only available for Claude Code.</div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="insight-empty">
        No subagents in the running sessions. They appear here as Claude spawns them.
      </div>
    );
  }

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="isubs">
      {groups.map(({ session, agents }) => {
        const running = agents.filter((a) => a.status === "running").length;
        const here = session.live?.ptyId != null && session.live.ptyId === activeSession;
        return (
          <div className="isub-group" key={session.id}>
            <div className="isub-group-head">
              <span className="isub-group-title" title={session.title ?? session.id}>
                {session.title ?? session.id.slice(0, 8)}
              </span>
              <span className="changes-count">
                {running > 0 ? `${running}/${agents.length}` : agents.length}
              </span>
              {session.live?.ptyId != null && !here && (
                <button
                  className="isession-resume isub-show"
                  onClick={() => onShow(session)}
                  title="Show the tab this session runs in"
                >
                  Show
                </button>
              )}
            </div>
            {agents.map((a) => (
              <Row
                key={a.id}
                agent={a}
                open={open.has(a.id)}
                onToggle={() => toggle(a.id)}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
