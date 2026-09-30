/**
 * `{{…}}` in a template body. Two kinds, and deliberately no third.
 *
 * - **Context**: `{{file}}`, `{{project}}`, `{{branch}}` -- filled from what the
 *   app already knows, with no interaction.
 * - **Ask**: `{{?label}}` -- the chooser stops and asks for it before inserting.
 *
 * Anything else inside braces is left exactly as written. A template is a
 * prompt, and a prompt is allowed to contain `{{…}}` that means nothing to us --
 * silently blanking it would be worse than leaving it alone.
 */

export const CONTEXT_KEYS = ["file", "project", "branch"] as const;
export type ContextKey = (typeof CONTEXT_KEYS)[number];

export interface Context {
  /** The open file, workspace-relative. Empty when nothing is open. */
  file: string;
  /** The workspace folder's name. */
  project: string;
  /** The current branch, empty outside a repo or on a detached HEAD. */
  branch: string;
}

/** `{{ file }}`, `{{?what}}`, `{{ ? what }}` -- whitespace is not significant. */
const TOKEN = /\{\{\s*(\??)\s*([^{}]*?)\s*\}\}/g;

const isContextKey = (s: string): s is ContextKey =>
  (CONTEXT_KEYS as readonly string[]).includes(s);

export interface Scan {
  /** Context keys used, in first-seen order, without duplicates. */
  context: ContextKey[];
  /** Ask labels, in first-seen order, without duplicates. */
  asks: string[];
}

export function scan(body: string): Scan {
  const context: ContextKey[] = [];
  const asks: string[] = [];
  for (const [, ask, name] of body.matchAll(TOKEN)) {
    if (ask) {
      if (name && !asks.includes(name)) asks.push(name);
    } else if (isContextKey(name) && !context.includes(name)) {
      context.push(name);
    }
  }
  return { context, asks };
}

/** Fill the context placeholders. Asks and unknown tokens are left standing. */
export function fillContext(body: string, ctx: Context): string {
  return body.replace(TOKEN, (whole, ask: string, name: string) =>
    !ask && isContextKey(name) ? ctx[name] : whole,
  );
}

/**
 * Fill the asks. A label with no answer collapses to nothing rather than
 * leaving `{{?…}}` in the prompt -- by this point the user has seen the field
 * and chosen to leave it blank.
 */
export function fillAsks(body: string, answers: Record<string, string>): string {
  return body.replace(TOKEN, (whole, ask: string, name: string) =>
    ask ? (answers[name] ?? "") : whole,
  );
}

/** Everything, in one call. What the chooser's preview shows. */
export function resolve(
  body: string,
  ctx: Context,
  answers: Record<string, string> = {},
): string {
  return fillAsks(fillContext(body, ctx), answers);
}

/**
 * The context for a template, from what App has on screen.
 *
 * `root` and `openFile` are absolute paths; the prompt wants the relative one,
 * because that is what the agent's own tools take.
 */
export function contextFrom(
  root: string | null,
  openFile: string | null,
  branch: string | null,
): Context {
  return {
    file: root && openFile ? relativeTo(root, openFile) : (openFile ?? ""),
    project: root ? (root.split("/").filter(Boolean).pop() ?? root) : "",
    branch: branch ?? "",
  };
}

function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
