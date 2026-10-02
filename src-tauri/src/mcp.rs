//! A local MCP server, so the agent can reach the UI around it.
//!
//! Streamable HTTP in its stateless JSON form: every request is one POST
//! carrying one JSON-RPC message, answered with plain `application/json` --
//! no SSE stream, no session id. That is all four methods need, and it lets
//! the whole server be a blocking accept loop, like the PTY pumps, instead of
//! pulling an async web stack in for it. Each request gets a thread of its own,
//! because `ask_user` and `request_review` hold theirs until the user answers.
//!
//! Each agent is handed a URL with its PTY id in the path (see `pty_spawn`),
//! so a tool call knows which pane it came from without the agent having to
//! say. The bearer token is per launch and only ever given to agents we spawn.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::fs::inside_workspace;
use crate::pty::PtyRegistry;

const PROTOCOL_VERSION: &str = "2025-06-18";

/// No JSON-RPC message this server understands comes anywhere near this.
const MAX_BODY: u64 = 1024 * 1024;

/// How long a question waits for the user. Matches the `MCP_TOOL_TIMEOUT`
/// `pty.rs` gives Claude Code, so neither side gives up first.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);

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

/// A question on screen, waiting for the user.
struct Pending {
    pty: String,
    /// The window showing it; only that window may answer, and it is told
    /// when the question is withdrawn.
    window: String,
    answer: Sender<Value>,
}

struct Inner {
    app: AppHandle,
    token: String,
    /// PTY id -> the list its agent last published.
    tasks: Mutex<HashMap<String, Vec<Task>>>,
    /// Request id -> the question it belongs to.
    pending: Mutex<HashMap<String, Pending>>,
    next_request: AtomicU64,
}

impl Inner {
    /// Withdraw every question `pty` has open. Dropping the sender is what
    /// wakes the waiting tool call; the window is told so it drops the card.
    fn withdraw(&self, pty: &str) {
        let gone: Vec<(String, Pending)> = {
            let mut pending = self.pending.lock().unwrap();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, p)| p.pty == pty)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| pending.remove_entry(&id)).collect()
        };
        for (request_id, p) in gone {
            let _ = self.app.emit_to(
                p.window.as_str(),
                "mcp://prompt-cancel",
                json!({ "requestId": request_id }),
            );
        }
    }
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

    /// The agent in `pty` is back at its prompt, so any question it still has
    /// open was interrupted -- the user pressed Esc on the tool call.
    pub fn abandon(&self, pty: &str) {
        self.inner.withdraw(pty);
    }

    /// Forget a pane's tasks, and withdraw its questions, once its agent is gone.
    pub fn clear(&self, id: &str) {
        self.inner.tasks.lock().unwrap().remove(id);
        self.inner.withdraw(id);
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
        pending: Mutex::default(),
        next_request: AtomicU64::new(1),
    });

    let shared = Arc::clone(&inner);
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || handle(&shared, req));
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
    if req.as_reader().take(MAX_BODY + 1).read_to_string(&mut body).is_err() {
        return respond(req, 400, None);
    }
    if body.len() as u64 > MAX_BODY {
        return respond(req, 413, None);
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
        "tools/list" => rpc_result(
            id,
            json!({ "tools": [
                update_tasks_tool(),
                open_file_tool(),
                show_diff_tool(),
                ask_user_tool(),
                request_review_tool(),
            ] }),
        ),
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

fn open_file_tool() -> Value {
    json!({
        "name": "open_file",
        "description": "Show a file to the user in Aditor's viewer, scrolled to a line. Use it \
            when you point the user at specific code -- the place a bug lives, the function \
            you are about to change -- rather than only printing the path. Does not move \
            focus away from the agent.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative to the project root, or absolute inside it" },
                "line": { "type": "integer", "minimum": 1, "description": "1-based line to show" },
            },
            "required": ["path"],
        },
    })
}

fn show_diff_tool() -> Value {
    json!({
        "name": "show_diff",
        "description": "Show the user the uncommitted changes to a file (HEAD against the \
            working tree) in Aditor's diff viewer, or, with no path, the list of changed files.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Relative to the project root; omit for the changes list" },
            },
        },
    })
}

fn ask_user_tool() -> Value {
    json!({
        "name": "ask_user",
        "description": "Ask the user to choose between options, shown as a native prompt in \
            Aditor. Prefer it over asking in prose whenever the answer is a pick between a \
            few concrete choices. Blocks until the user answers or dismisses it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": { "type": "string" },
                "options": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 9,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": { "type": "string", "description": "Short, 1-5 words" },
                            "description": { "type": "string", "description": "Optional trade-offs" },
                        },
                        "required": ["label"],
                    },
                },
                "multiSelect": { "type": "boolean", "description": "Allow several choices" },
                "allowOther": { "type": "boolean", "description": "Offer a free-text answer too (default true)" },
            },
            "required": ["question", "options"],
        },
    })
}

fn request_review_tool() -> Value {
    json!({
        "name": "request_review",
        "description": "Ask the user to review your changes in Aditor's diff viewer and \
            approve them or request changes. Call it only when the user asked to review \
            work before you continue or finish. Blocks until they decide.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "summary": { "type": "string", "description": "What changed and why, a few lines" },
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Files to review, relative to the project root; omit for every changed file",
                },
            },
            "required": ["summary"],
        },
    })
}

/// `path` from the agent, as an absolute path inside the folder its PTY runs in.
fn resolve(cwd: &Path, path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    if inside_workspace(cwd, &abs) {
        Ok(abs)
    } else {
        Err(format!("{path} is outside the project."))
    }
}

/// `mcp://open`: show a file or a diff in the window that owns the session.
#[derive(Clone, Serialize)]
struct OpenEvent<'a> {
    id: &'a str,
    /// None with `as: "changes"`: the changes list itself.
    path: Option<String>,
    line: Option<u64>,
    #[serde(rename = "as")]
    as_: &'a str,
}

fn call_tool(inner: &Inner, pty: &str, params: &Value) -> Value {
    let args = &params["arguments"];
    let result = match params["name"].as_str().unwrap_or("") {
        "update_tasks" => return update_tasks(inner, pty, args),
        "open_file" => open_file(inner, pty, args),
        "show_diff" => show_diff(inner, pty, args),
        "ask_user" => ask_user(inner, pty, args),
        "request_review" => request_review(inner, pty, args),
        _ => Err("Unknown tool.".to_string()),
    };
    match result {
        Ok(text) => tool_text(&text, false),
        Err(text) => tool_text(&text, true),
    }
}

fn update_tasks(inner: &Inner, pty: &str, args: &Value) -> Value {
    let tasks: Vec<Task> = match serde_json::from_value(args["tasks"].clone()) {
        Ok(t) => t,
        Err(e) => return tool_text(&format!("Invalid tasks: {e}"), true),
    };
    let done = tasks.iter().filter(|t| t.status == Status::Completed).count();
    let total = tasks.len();

    let _ = inner.app.emit("mcp://tasks", TasksEvent { id: pty, tasks: &tasks });
    inner.tasks.lock().unwrap().insert(pty.to_string(), tasks);
    tool_text(&format!("Tasks updated ({done}/{total} done)."), false)
}

/// The window showing `pty`, and the folder it runs in.
fn owner(inner: &Inner, pty: &str) -> Result<(String, PathBuf), String> {
    inner
        .app
        .state::<Arc<PtyRegistry>>()
        .owner(pty)
        .ok_or_else(|| "This session is no longer open in Aditor.".to_string())
}

fn open_file(inner: &Inner, pty: &str, args: &Value) -> Result<String, String> {
    let path = args["path"].as_str().ok_or("`path` is required.")?;
    let (window, cwd) = owner(inner, pty)?;
    let abs = resolve(&cwd, path)?;
    if !abs.is_file() {
        return Err(format!("{path} is not a file."));
    }
    let line = args["line"].as_u64().filter(|&l| l > 0);
    let event = OpenEvent { id: pty, path: Some(abs.to_string_lossy().into()), line, as_: "file" };
    inner.app.emit_to(window.as_str(), "mcp://open", event).map_err(|e| e.to_string())?;
    Ok(format!("Opened {path} for the user."))
}

fn show_diff(inner: &Inner, pty: &str, args: &Value) -> Result<String, String> {
    let (window, cwd) = owner(inner, pty)?;
    let (path, as_) = match args["path"].as_str() {
        // Not checked for existence: a deleted file still has a diff.
        Some(p) => (Some(resolve(&cwd, p)?.to_string_lossy().into()), "diff"),
        None => (None, "changes"),
    };
    let event = OpenEvent { id: pty, path, line: None, as_ };
    inner.app.emit_to(window.as_str(), "mcp://open", event).map_err(|e| e.to_string())?;
    Ok("Showing the diff to the user.".to_string())
}

/// Put a question on screen and wait for the answer. `Err` when the session
/// closed, the user interrupted the call, or nobody answered in time.
fn ask(inner: &Inner, pty: &str, kind: &str, mut prompt: Value) -> Result<Value, String> {
    let (window, cwd) = owner(inner, pty)?;
    let request_id = format!("q{}", inner.next_request.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = channel();
    inner.pending.lock().unwrap().insert(
        request_id.clone(),
        Pending { pty: pty.to_string(), window: window.clone(), answer: tx },
    );
    prompt["requestId"] = json!(request_id);
    prompt["id"] = json!(pty);
    prompt["kind"] = json!(kind);
    prompt["root"] = json!(cwd.to_string_lossy());
    if let Err(e) = inner.app.emit_to(window.as_str(), "mcp://prompt", prompt) {
        inner.pending.lock().unwrap().remove(&request_id);
        return Err(e.to_string());
    }
    match rx.recv_timeout(PROMPT_TIMEOUT) {
        Ok(answer) => Ok(answer),
        Err(RecvTimeoutError::Timeout) => {
            if inner.pending.lock().unwrap().remove(&request_id).is_some() {
                let _ = inner.app.emit_to(
                    window.as_str(),
                    "mcp://prompt-cancel",
                    json!({ "requestId": request_id }),
                );
            }
            Err("The user did not answer in time.".to_string())
        }
        Err(RecvTimeoutError::Disconnected) => {
            Err("The question was withdrawn before the user answered.".to_string())
        }
    }
}

fn ask_user(inner: &Inner, pty: &str, args: &Value) -> Result<String, String> {
    let question = args["question"].as_str().ok_or("`question` is required.")?;
    let options: Vec<Value> = args["options"]
        .as_array()
        .ok_or("`options` is required.")?
        .iter()
        .filter_map(|o| {
            let label = o["label"].as_str()?;
            Some(json!({ "label": label, "description": o["description"].as_str() }))
        })
        .collect();
    if options.is_empty() {
        return Err("Give at least one option with a `label`.".to_string());
    }
    let answer = ask(
        inner,
        pty,
        "ask",
        json!({
            "question": question,
            "options": options,
            "multiSelect": args["multiSelect"].as_bool().unwrap_or(false),
            "allowOther": args["allowOther"].as_bool().unwrap_or(true),
        }),
    )?;
    Ok(describe_choice(&answer))
}

/// The user's answer to `ask_user`, as the model will read it.
fn describe_choice(answer: &Value) -> String {
    if answer["dismissed"].as_bool() == Some(true) {
        return "The user dismissed the question without answering. Ask in the terminal \
            instead, or carry on with your best judgement and say which you chose."
            .to_string();
    }
    let picked: Vec<&str> = answer["selected"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let other = answer["other"].as_str().map(str::trim).filter(|s| !s.is_empty());
    match (picked.is_empty(), other) {
        (true, None) => "The user submitted no choice.".to_string(),
        (true, Some(o)) => format!("The user answered: {o}"),
        (false, None) => format!("The user chose: {}", picked.join(", ")),
        (false, Some(o)) => format!("The user chose: {}. They added: {o}", picked.join(", ")),
    }
}

fn request_review(inner: &Inner, pty: &str, args: &Value) -> Result<String, String> {
    let summary = args["summary"].as_str().ok_or("`summary` is required.")?;
    let (_, cwd) = owner(inner, pty)?;
    let paths = match args["paths"].as_array() {
        Some(list) => {
            let mut out = Vec::new();
            for p in list.iter().filter_map(Value::as_str) {
                out.push(resolve(&cwd, p)?.to_string_lossy().into_owned());
            }
            Some(out)
        }
        None => None,
    };
    let answer = ask(inner, pty, "review", json!({ "summary": summary, "paths": paths }))?;
    Ok(describe_review(&answer))
}

/// The user's verdict on `request_review`, as the model will read it.
fn describe_review(answer: &Value) -> String {
    let comment = answer["comment"].as_str().map(str::trim).filter(|s| !s.is_empty());
    match (answer["decision"].as_str(), comment) {
        (Some("approved"), None) => "The user approved the changes.".to_string(),
        (Some("approved"), Some(c)) => format!("The user approved the changes, with a note: {c}"),
        (Some("changes_requested"), Some(c)) => format!("The user requested changes: {c}"),
        (Some("changes_requested"), None) => {
            "The user requested changes but left no comment. Ask them what to change.".to_string()
        }
        _ => "The user closed the review without deciding.".to_string(),
    }
}

/// The user answered question `request_id`. Only the window it was shown in
/// may answer it.
#[tauri::command]
pub fn mcp_answer(
    window: WebviewWindow,
    mcp: State<'_, McpServer>,
    request_id: String,
    answer: Value,
) -> Result<(), String> {
    let mut pending = mcp.inner.pending.lock().unwrap();
    match pending.get(&request_id) {
        Some(p) if p.window == window.label() => {}
        Some(_) => return Err("That question belongs to another window.".to_string()),
        None => return Err("That question is no longer open.".to_string()),
    }
    let p = pending.remove(&request_id).expect("checked above");
    let _ = p.answer.send(answer);
    Ok(())
}

/// The panel unmounts while hidden, so it reloads the list from here.
#[tauri::command]
pub fn mcp_tasks(mcp: State<'_, McpServer>, id: String) -> Vec<Task> {
    mcp.inner.tasks.lock().unwrap().get(&id).cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aditor-mcp-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.ts"), "x").unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn resolves_paths_inside_the_project_only() {
        let root = workspace();
        assert_eq!(resolve(&root, "src/a.ts").unwrap(), root.join("src/a.ts"));
        assert!(resolve(&root, root.join("src/a.ts").to_str().unwrap()).is_ok());
        assert!(resolve(&root, "../etc/passwd").is_err());
        assert!(resolve(&root, "src/../../x").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
    }

    #[test]
    fn describes_choices() {
        assert_eq!(
            describe_choice(&json!({ "selected": ["A"], "other": null })),
            "The user chose: A"
        );
        assert_eq!(
            describe_choice(&json!({ "selected": [], "other": " use C " })),
            "The user answered: use C"
        );
        assert!(describe_choice(&json!({ "dismissed": true })).starts_with("The user dismissed"));
    }

    #[test]
    fn describes_reviews() {
        assert_eq!(
            describe_review(&json!({ "decision": "approved", "comment": "" })),
            "The user approved the changes."
        );
        assert_eq!(
            describe_review(&json!({ "decision": "changes_requested", "comment": "rename it" })),
            "The user requested changes: rename it"
        );
        assert!(describe_review(&json!({ "decision": "dismissed" })).contains("without deciding"));
    }
}
