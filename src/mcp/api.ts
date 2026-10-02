import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export type TaskStatus = "pending" | "in_progress" | "completed";

/** One entry of the list an agent publishes through Aditor's MCP server. */
export interface Task {
  title: string;
  status: TaskStatus;
  detail?: string;
}

interface TasksEvent {
  /** The PTY session the agent runs in. */
  id: string;
  tasks: Task[];
}

/** The list PTY `id` last published; empty until its agent calls the tool. */
export const mcpTasks = (id: string) => invoke<Task[]>("mcp_tasks", { id });

/** Every `update_tasks` call, from any session. */
export const onTasks = (cb: (id: string, tasks: Task[]) => void): Promise<UnlistenFn> =>
  listen<TasksEvent>("mcp://tasks", (e) => cb(e.payload.id, e.payload.tasks));

/** `mcp://open`: the agent asked to show a file, a diff, or the changes list. */
export interface OpenRequest {
  /** The PTY session that asked. */
  id: string;
  /** Absolute, checked to be inside the project. Null for the changes list. */
  path: string | null;
  line: number | null;
  as: "file" | "diff" | "changes";
}

export interface AskOption {
  label: string;
  description: string | null;
}

interface PromptBase {
  /** Answer with this. */
  requestId: string;
  /** The PTY session that asked. */
  id: string;
  /** The folder the session runs in. */
  root: string;
}

/** `ask_user`: pick from options. */
export interface AskPrompt extends PromptBase {
  kind: "ask";
  question: string;
  options: AskOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

/** `request_review`: approve the changes or ask for others. */
export interface ReviewPrompt extends PromptBase {
  kind: "review";
  summary: string;
  /** Absolute paths; null means every changed file. */
  paths: string[] | null;
}

export type McpPrompt = AskPrompt | ReviewPrompt;

export type AskAnswer =
  | { dismissed: true }
  | { dismissed?: false; selected: string[]; other: string | null };

export interface ReviewAnswer {
  decision: "approved" | "changes_requested" | "dismissed";
  comment: string;
}

const here = () => getCurrentWebviewWindow();

/** This window's sessions only: the backend sends each to its owner. */
export const onOpenRequest = (cb: (r: OpenRequest) => void): Promise<UnlistenFn> =>
  here().listen<OpenRequest>("mcp://open", (e) => cb(e.payload));

export const onPrompt = (cb: (p: McpPrompt) => void): Promise<UnlistenFn> =>
  here().listen<McpPrompt>("mcp://prompt", (e) => cb(e.payload));

/** A question withdrawn: its session closed, or the user interrupted the call. */
export const onPromptCancel = (cb: (requestId: string) => void): Promise<UnlistenFn> =>
  here().listen<{ requestId: string }>("mcp://prompt-cancel", (e) => cb(e.payload.requestId));

export const mcpAnswer = (requestId: string, answer: AskAnswer | ReviewAnswer) =>
  invoke<void>("mcp_answer", { requestId, answer });
