import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentInfo } from "../pty/api";
import { AccountSwitcher } from "./AccountSwitcher";
import { Section } from "./Section";
import {
  agentRefreshLimits,
  agentSessions,
  approx,
  formatElapsed,
  formatRelative,
  formatTokens,
  formatUsd,
  statusLabel,
  totalTokens,
  type AgentSessions as Data,
  type SessionSummary,
  type Totals,
  type UsageLimits,
} from "../agents/api";

/**
 * The agent's sessions in this workspace, refetched on every `refreshToken`.
 * Lives above the panel's tabs, which all read from it, so the Subagents
 * badge stays current while another tab is showing.
 */
export function useAgentSessions(
  agentId: string | null,
  workspace: string,
  refreshToken: number,
) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let stale = false;
    agentSessions(workspace, agentId)
      .then((d) => {
        if (stale) return;
        setData(d);
        setError(null);
      })
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [agentId, workspace, refreshToken]);

  // The backend keeps what it fetched, so later `agentSessions` calls return it
  // too; patching it in here just avoids waiting for the next one.
  const patchLimits = useCallback(
    (limits: UsageLimits) => setData((d) => d && { ...d, limits }),
    [],
  );

  return { data, error, patchLimits };
}

interface Props {
  agent: AgentInfo | null;
  data: Data | null;
  error: string | null;
  onLimits(limits: UsageLimits): void;
  /** Bumped by the workspace watcher and by `agents://changed`. */
  refreshToken: number;
  /** An account switch invalidates everything below it: the sessions and
   *  limits on screen belong to the account we just left. */
  onAccountChanged(): void;
  onResume(session: SessionSummary): void;
}

const EMPTY: Totals = {
  input: 0,
  output: 0,
  thinking: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  exact: true,
};

function sum(sessions: SessionSummary[]): Totals {
  return sessions.reduce<Totals>(
    (a, s) => ({
      input: a.input + s.totals.input,
      output: a.output + s.totals.output,
      thinking: a.thinking + s.totals.thinking,
      cacheRead: a.cacheRead + s.totals.cacheRead,
      cacheWrite: a.cacheWrite + s.totals.cacheWrite,
      costUsd: a.costUsd + s.totals.costUsd,
      // One derived session makes the whole rollup a lower bound.
      exact: a.exact && s.totals.exact,
    }),
    EMPTY,
  );
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A utilization bar. Colour is the warning, the number is the detail. */
function Meter({ label, pct, resetsAt }: { label: string; pct: number; resetsAt: string | null }) {
  const level = pct >= 90 ? "high" : pct >= 75 ? "warn" : "ok";
  const resets = resetsAt ? new Date(resetsAt) : null;
  return (
    <div className="meter" title={resets ? `Resets ${resets.toLocaleString()}` : undefined}>
      <div className="meter-line">
        <span className="meter-label">{label}</span>
        <span className="meter-pct">{Math.round(pct)}%</span>
      </div>
      <div className="meter-track">
        <div
          className="meter-fill"
          data-level={level}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
    </div>
  );
}

function Row({
  session,
  open,
  onToggle,
  onResume,
}: {
  session: SessionSummary;
  open: boolean;
  onToggle(): void;
  onResume?(): void;
}) {
  const { totals, live } = session;
  // Running in one of our tabs: the button goes there instead of resuming.
  const shown = live?.ptyId != null;
  return (
    <div className="isession" data-live={live !== null}>
      <div className="isession-row">
        <button className="isession-head" onClick={onToggle} aria-expanded={open}>
          <span className="tree-chevron">{open ? "▾" : "▸"}</span>
          {live && <span className="isession-dot" aria-hidden />}
          <span className="isession-title">
            {session.title ?? session.id.slice(0, 8)}
          </span>
          <span className="isession-cost">
            {approx(totals)}
            {formatUsd(totals.costUsd)}
          </span>
        </button>
        {onResume && (
          <button
            className="isession-resume"
            onClick={onResume}
            title={shown ? "Show the tab this session runs in" : "Continue this session in a new tab"}
          >
            {shown ? "Show" : "Resume"}
          </button>
        )}
      </div>

      <div className="isession-sub">
        <span>{live ? statusLabel(live) : formatRelative(session.lastAt)}</span>
        <span className="isession-sep">·</span>
        <span>{formatTokens(totalTokens(totals))} tok</span>
        <span className="isession-sep">·</span>
        <span>
          {session.turns} turn{session.turns === 1 ? "" : "s"}
        </span>
        {session.branch && (
          <>
            <span className="isession-sep">·</span>
            <span className="isession-branch" title="Branch">
              {session.branch}
            </span>
          </>
        )}
      </div>

      {open && (
        <div className="isession-detail">
          {session.models.map((m) => (
            <div className="imodel" key={m.model}>
              <div className="imodel-head">
                <span className="viewer-badge">{m.model}</span>
                <span className="imodel-cost">{formatUsd(m.costUsd)}</span>
              </div>
              <dl className="imodel-grid">
                <dt>in</dt>
                <dd>{formatTokens(m.input)}</dd>
                <dt>out</dt>
                <dd>{formatTokens(m.output)}</dd>
                {m.thinking > 0 && (
                  <>
                    <dt>thinking</dt>
                    <dd>{formatTokens(m.thinking)}</dd>
                  </>
                )}
                <dt>cache read</dt>
                <dd>{formatTokens(m.cacheRead)}</dd>
                <dt>cache write</dt>
                <dd>{formatTokens(m.cacheWrite)}</dd>
              </dl>
            </div>
          ))}
          <div className="isession-started">
            Started {formatRelative(session.startedAt)}
            {session.live && ` · running ${formatElapsed(session.startedAt)}`}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What the coding agent has been doing in this project: its sessions, which one
 * is live, and what they cost.
 *
 * Everything shown is read off the agent's own files, which is why it can
 * refresh as freely as the tree. The one exception is the Limits refresh
 * button, which asks Anthropic directly and only when pressed.
 */
export function AgentSessions({
  agent,
  data,
  error,
  onLimits,
  refreshToken,
  onAccountChanged,
  onResume,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);

  const agentId = agent?.id ?? null;

  const refreshLimits = async () => {
    if (!agentId) return;
    setRefreshing(true);
    setLimitsError(null);
    try {
      onLimits(await agentRefreshLimits(agentId));
    } catch (e) {
      setLimitsError(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const sessions = data?.sessions ?? [];
  const project = useMemo(() => sum(sessions), [sessions]);
  const today = useMemo(() => {
    const since = startOfToday();
    return sum(sessions.filter((s) => s.lastAt >= since));
  }, [sessions]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="insight-inner">
      {error && <div className="tree-error">{error}</div>}

      {agent?.id === "claude" && (
        <AccountSwitcher refreshToken={refreshToken} onChanged={onAccountChanged} />
      )}

      {data && !data.supported && (
        <div className="insight-empty">
          Session data isn’t available for {agent?.label ?? "this agent"} yet.
        </div>
      )}

      {data?.supported && (
        <>
          {data.limits && (
            <Section
              id="limits"
              title="Limits"
              actions={
                <button
                  className="section-action"
                  onClick={() => void refreshLimits()}
                  disabled={refreshing}
                  title="Fetch current usage from Anthropic"
                >
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
              }
            >
              <Meter
                label="5 hours"
                pct={data.limits.fiveHourPct}
                resetsAt={data.limits.fiveHourResetsAt}
              />
              <Meter
                label="7 days"
                pct={data.limits.sevenDayPct}
                resetsAt={data.limits.sevenDayResetsAt}
              />
              <div className="insight-note">
                Account-wide · as of{" "}
                {data.limits.fetchedAtMs
                  ? formatRelative(data.limits.fetchedAtMs)
                  : "unknown"}
              </div>
              {limitsError && <div className="tree-error">{limitsError}</div>}
            </Section>
          )}

          <Section
            id="sessions"
            title="All sessions"
            count={sessions.length}
            defaultOpen={false}
          >
            {sessions.length === 0 ? (
              <div className="insight-empty">
                No sessions recorded for this project.
              </div>
            ) : (
              sessions.map((s) => (
                <Row
                  key={s.id}
                  session={s}
                  open={open.has(s.id)}
                  onToggle={() => toggle(s.id)}
                  onResume={agent?.id === "claude" ? () => onResume(s) : undefined}
                />
              ))
            )}
          </Section>

          {sessions.length > 0 && (
            <Section id="totals" title="Totals" defaultOpen={false}>
              <div className="insight-rollup">
                <div className="rollup-row">
                  <span>Today</span>
                  <span>{formatTokens(totalTokens(today))} tok</span>
                  <span className="rollup-cost">
                    {approx(today)}
                    {formatUsd(today.costUsd)}
                  </span>
                </div>
                <div className="rollup-row rollup-total">
                  <span>All time</span>
                  <span>{formatTokens(totalTokens(project))} tok</span>
                  <span className="rollup-cost">
                    {approx(project)}
                    {formatUsd(project.costUsd)}
                  </span>
                </div>
                <div className="insight-note">
                  API-equivalent estimate. A “≈” marks a figure the agent did
                  not record itself, which reads low.
                </div>
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
