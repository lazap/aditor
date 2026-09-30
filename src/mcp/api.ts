import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
