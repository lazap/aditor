import { invoke } from "@tauri-apps/api/core";

/** Token counters, flattened into the shapes below by the backend. */
export interface Counters {
  input: number;
  output: number;
  /** A subset of `output`, not an addition to it. */
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Totals extends Counters {
  costUsd: number;
  /** False when the figure was derived from a price table rather than recorded
   *  by the agent -- in which case it is a lower bound. */
  exact: boolean;
}

export interface ModelUsage extends Counters {
  model: string;
  costUsd: number;
}

export interface Live {
  pid: number;
  status: string;
  waitingFor: string | null;
  name: string | null;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  branch: string | null;
  startedAt: number;
  lastAt: number;
  /** Assistant turns, not transcript lines. */
  turns: number;
  live: Live | null;
  models: ModelUsage[];
  totals: Totals;
}

export interface UsageLimits {
  fiveHourPct: number;
  fiveHourResetsAt: string | null;
  sevenDayPct: number;
  sevenDayResetsAt: string | null;
  fetchedAtMs: number;
}

export interface AgentSessions {
  /** False for an agent we have no reader for -- a state, not an error. */
  supported: boolean;
  sessions: SessionSummary[];
  limits: UsageLimits | null;
}

export const agentSessions = (agentId: string) =>
  invoke<AgentSessions>("agent_sessions", { agentId });

export const agentWatch = (agentId: string) =>
  invoke<void>("agent_watch", { agentId });

/** Everything the session pushed through the model, cache included. */
export const totalTokens = (c: Counters) =>
  c.input + c.output + c.cacheRead + c.cacheWrite;

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function formatUsd(n: number): string {
  if (n <= 0) return "$0";
  // Rounding a real cost down to "$0.00" reads as free, which it was not.
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Prefix for a cost the agent did not record itself. */
export const approx = (t: Totals) => (t.exact ? "" : "≈");

export function formatRelative(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Compact elapsed time for a running session: `4m`, `1h 12m`. */
export function formatElapsed(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * How the agent describes itself right now. Known states get plain English;
 * anything new passes through rather than being swallowed, so an added state
 * shows up instead of silently reading as "idle".
 */
export function statusLabel(live: Live): string {
  if (live.status === "waiting") return live.waitingFor ?? "waiting";
  if (live.status === "idle") return "idle";
  return live.status;
}
