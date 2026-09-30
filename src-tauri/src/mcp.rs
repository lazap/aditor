//! A local MCP server, so the agent can reach the UI around it.
//!
//! Streamable HTTP in its stateless JSON form: every request is one POST
//! carrying one JSON-RPC message, answered with plain `application/json` --
//! no SSE stream, no session id. That is all four methods need, and it lets
//! the whole server be a blocking accept loop on its own thread, like the PTY
//! pumps, instead of pulling an async web stack in for it.
//!
//! Each agent is handed a URL with its PTY id in the path (see `pty_spawn`),
//! so a tool call knows which pane it came from without the agent having to
//! say. The bearer token is per launch and only ever given to agents we spawn.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tiny_http::{Header, Method, Request, Response, Server};

const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    title: String,
    status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Clone, Serialize)]
struct TasksEvent<'a> {
    id: &'a str,
    tasks: &'a [Task],
}

struct Inner {
    app: AppHandle,
    token: String,
    /// PTY id -> the list its agent last published.
    tasks: Mutex<HashMap<String, Vec<Task>>>,
}

pub struct McpServer {
    port: u16,
    inner: Arc<Inner>,
}

impl McpServer {
    /// The `--mcp-config` JSON for the agent in PTY `id`.
    pub fn config_for(&self, id: &str) -> String {
        json!({
            "mcpServers": {
                "aditor": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}/mcp/{id}", self.port),
                    "headers": { "Authorization": format!("Bearer {}", self.inner.token) },
                }
            }
        })
        .to_string()
    }

    /// Forget a pane's tasks once its agent is gone.
    pub fn clear(&self, id: &str) {
        self.inner.tasks.lock().unwrap().remove(id);
    }
}

/// 32 hex chars from the kernel's CSPRNG. Unix-only, like the rest of Aditor's
/// process handling.
fn new_token() -> std::io::Result<String> {
    let mut buf = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Bind to a free loopback port and serve on a thread of its own.
pub fn start(app: AppHandle) -> Result<McpServer, Box<dyn std::error::Error>> {
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("MCP server has no IP address")?;
    let inner = Arc::new(Inner {
        app,
        token: new_token()?,
        tasks: Mutex::default(),
    });

    let shared = Arc::clone(&inner);
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            handle(&shared, req);
        }
    });

    Ok(McpServer { port, inner })
}

fn header<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

fn respond(req: Request, status: u16, body: Option<Value>) {
    let res = match body {
        Some(v) => Response::from_string(v.to_string())
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
        None => Response::from_string(""),
    };
    let _ = req.respond(res.with_status_code(status));
}

fn handle(inner: &Inner, mut req: Request) {
    // A browser page could otherwise reach a loopback port through DNS
    // rebinding. The agent is not a browser and sends no Origin at all.
    if header(&req, "Origin").is_some() {
        return respond(req, 403, None);
    }
    let Some(pty) = req.url().strip_prefix("/mcp/").map(str::to_string) else {
        return respond(req, 404, None);
    };
    let expected = format!("Bearer {}", inner.token);
    if header(&req, "Authorization") != Some(expected.as_str()) {
        return respond(req, 401, None);
    }
    // GET would open a server-to-client stream; this server never sends one.
    if *req.method() != Method::Post {
        return respond(req, 405, None);
    }

    let mut body = String::new();
    if req.as_reader().read_to_string(&mut body).is_err() {
        return respond(req, 400, None);
    }
    let Ok(msg) = serde_json::from_str::<Value>(&body) else {
        return respond(req, 400, Some(rpc_error(Value::Null, -32700, "parse error")));
    };

    let method = msg["method"].as_str().unwrap_or("");
    // Notifications and responses carry no id and want no answer.
    let Some(id) = msg.get("id").cloned() else {
        return respond(req, 202, None);
    };

    let reply = match method {
        "initialize" => rpc_result(
            id,
            json!({
                "protocolVersion": msg["params"]["protocolVersion"]
                    .as_str()
                    .unwrap_or(PROTOCOL_VERSION),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "aditor", "version": env!("CARGO_PKG_VERSION") },
            }),
        ),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": [update_tasks_tool()] })),
        "tools/call" => rpc_result(id, call_tool(inner, &pty, &msg["params"])),
        _ => rpc_error(id, -32601, "method not found"),
    };
    respond(req, 200, Some(reply));
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A tool result. Failures go back to the model as `isError`, not as a
/// JSON-RPC error, so it can read what went wrong and try again.
fn tool_text(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn update_tasks_tool() -> Value {
    json!({
        "name": "update_tasks",
        "description": "Publish your task list to the Tasks panel in Aditor, the editor \
            the user is watching you from. Send the FULL list every time -- it replaces \
            the previous one. Call it when you plan multi-step work and whenever a \
            task's status changes. Keep exactly one task in_progress while working.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string", "description": "Short imperative, e.g. \"Add the settings tab\"" },
                            "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] },
                            "detail": { "type": "string", "description": "Optional one-line note" },
                        },
                        "required": ["title", "status"],
                    },
                },
            },
            "required": ["tasks"],
        },
    })
}

fn call_tool(inner: &Inner, pty: &str, params: &Value) -> Value {
    if params["name"].as_str() != Some("update_tasks") {
        return tool_text("Unknown tool.", true);
    }
    let tasks: Vec<Task> = match serde_json::from_value(params["arguments"]["tasks"].clone()) {
        Ok(t) => t,
        Err(e) => return tool_text(&format!("Invalid tasks: {e}"), true),
    };
    let done = tasks.iter().filter(|t| t.status == Status::Completed).count();
    let total = tasks.len();

    let _ = inner.app.emit("mcp://tasks", TasksEvent { id: pty, tasks: &tasks });
    inner.tasks.lock().unwrap().insert(pty.to_string(), tasks);
    tool_text(&format!("Tasks updated ({done}/{total} done)."), false)
}

/// The panel unmounts while hidden, so it reloads the list from here.
#[tauri::command]
pub fn mcp_tasks(mcp: State<'_, McpServer>, id: String) -> Vec<Task> {
    mcp.inner.tasks.lock().unwrap().get(&id).cloned().unwrap_or_default()
}
