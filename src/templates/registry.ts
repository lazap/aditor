/**
 * The prompt templates Aditor ships with.
 *
 * These are a starting set, not a fixed one: they are copied into the user's
 * settings on first run as ordinary rows they can edit, reorder or delete.
 * `TEMPLATE_SEED` records which revision of this list has been folded in, so a
 * later release can add to it without resurrecting what someone deleted --
 * raise it by one in the same commit that adds a template here.
 *
 * They lean on the placeholders (see `placeholders.ts`) deliberately: the
 * shipped set is also where most people will first see what a placeholder is.
 */

export interface PromptTemplate {
  id: string;
  name: string;
  body: string;
}

/** Raise this whenever a template is added below. */
export const TEMPLATE_SEED = 1;

export const DEFAULT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: "builtin.explain",
    name: "Explain this file",
    body: "Explain what {{file}} does, then list the edge cases it misses.",
  },
  {
    id: "builtin.tests",
    name: "Write tests",
    body: "Write tests for {{?what}} in {{file}}, then run them.",
  },
  {
    id: "builtin.review",
    name: "Review the diff",
    body: "Review the current diff on {{branch}} for correctness bugs. Be specific about the input that breaks each one.",
  },
  {
    id: "builtin.bug",
    name: "Find the bug",
    body: "{{?symptom}}\n\nFind the cause in {{project}} before changing anything, and tell me what it is first.",
  },
  {
    id: "builtin.refactor",
    name: "Refactor",
    body: "Refactor {{?target}} in {{file}}. Keep the behaviour identical and say what you changed and why.",
  },
  {
    id: "builtin.commit",
    name: "Commit",
    body: "Stage the current changes and write a commit message for them, in the imperative mood and matching the existing history.",
  },
];

/** A fresh id for a template the user adds. */
export function newTemplateId(): string {
  return `t.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 7)}`;
}
