//! Answering ssh's and git's prompts -- a key's passphrase, an unknown host
//! key, an HTTPS password -- in an editor window, since the git Aditor runs
//! has no terminal to ask on.
//!
//! Both ask through `SSH_ASKPASS`: a program run with the prompt as its one
//! argument, whose stdout is the answer. Aditor's own executable is that
//! program. Started with `ADITOR_ASKPASS` set, it never becomes the app:
//! `helper` posts the prompt to the running Aditor over the MCP server's
//! loopback port and prints what the user typed. The app puts the prompt up in
//! an editor window and holds the request until it is answered.
//!
//! macOS keeps its `osascript` dialog for now (see `git.rs`), whose answer ssh
//! saves in the Keychain.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Method, Request};

use crate::mcp::{header, respond};

/// Where the MCP server routes a prompt to `handle`.
pub const PATH: &str = "/askpass";

/// Set on git, read back by the helper ssh starts.
const URL_VAR: &str = "ADITOR_ASKPASS";
const TOKEN_VAR: &str = "ADITOR_ASKPASS_TOKEN";

/// A prompt is one line of ssh's, or a host key's few; nothing legitimate
/// comes close.
const MAX_BODY: u64 = 64 * 1024;

/// How long a prompt waits for the user before ssh is told no. Long enough to
/// go and find a passphrase; short enough that a prompt in a window nobody is
/// looking at does not hold git's lock for the rest of the session.
const WAIT: Duration = Duration::from_secs(10 * 60);

struct State {
    app: AppHandle,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    url: String,
    /// Not the MCP server's: this one goes to git, and to whatever its hooks
    /// run, so it opens this route and nothing else.
    token: String,
    /// Prompt id -> the request waiting on its answer.
    pending: Mutex<HashMap<u64, Sender<Option<String>>>>,
    next: AtomicU64,
}

static STATE: OnceLock<State> = OnceLock::new();

/// Called once the MCP server has its port.
pub fn init(app: AppHandle, port: u16) -> std::io::Result<()> {
    let state = State {
        app,
        url: format!("http://127.0.0.1:{port}{PATH}"),
        token: crate::platform::random_token()?,
        pending: Mutex::default(),
        next: AtomicU64::new(1),
    };
    let _ = STATE.set(state);
    Ok(())
}

/// The environment that makes ssh and git ask us, or None before `init`, or
/// when the executable cannot be found to run as the helper.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn env() -> Option<Vec<(&'static str, OsString)>> {
    let state = STATE.get()?;
    let exe = std::env::current_exe().ok()?;
    Some(vec![
        ("SSH_ASKPASS", exe.into_os_string()),
        // Ask even with no DISPLAY, as under Wayland, or when ssh would
        // rather open a terminal that is not there.
        ("SSH_ASKPASS_REQUIRE", "force".into()),
        (URL_VAR, state.url.clone().into()),
        (TOKEN_VAR, state.token.clone().into()),
    ])
}

#[derive(Deserialize)]
struct Ask {
    prompt: String,
}

/// A prompt from the helper: show it, and answer when the user does.
pub(crate) fn handle(mut req: Request) {
    let Some(state) = STATE.get() else {
        return respond(req, 503, None);
    };
    let expected = format!("Bearer {}", state.token);
    if header(&req, "Authorization") != Some(expected.as_str()) {
        return respond(req, 401, None);
    }
    if *req.method() != Method::Post {
        return respond(req, 405, None);
    }
    let mut body = String::new();
    if req.as_reader().take(MAX_BODY + 1).read_to_string(&mut body).is_err()
        || body.len() as u64 > MAX_BODY
    {
        return respond(req, 400, None);
    }
    let Ok(ask) = serde_json::from_str::<Ask>(&body) else {
        return respond(req, 400, None);
    };
    let Some(window) = editor_window(&state.app) else {
        return respond(req, 503, None);
    };

    let id = state.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    state.pending.lock().unwrap().insert(id, tx);
    // A host key question wants "yes" typed where it can be seen, and git's
    // HTTPS username is no secret either; everything else is.
    let secret = !ask.prompt.contains("yes/no") && !ask.prompt.starts_with("Username");
    let shown = window.emit_to(
        window.label(),
        "askpass://prompt",
        json!({ "id": id, "prompt": ask.prompt, "secret": secret }),
    );
    let answer = match shown {
        Ok(()) => rx.recv_timeout(WAIT).ok().flatten(),
        Err(_) => None,
    };
    state.pending.lock().unwrap().remove(&id);
    respond(req, 200, Some(json!({ "answer": answer })));
}

/// The focused editor window, or failing that any editor window.
fn editor_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let editors: Vec<_> = app
        .webview_windows()
        .into_values()
        .filter(|w| crate::is_editor(w.label()))
        .collect();
    let focused = editors.iter().position(|w| w.is_focused().unwrap_or(false));
    editors.into_iter().nth(focused.unwrap_or(0))
}

/// The user's answer to prompt `id`; None when they cancelled.
#[tauri::command]
pub fn askpass_answer(id: u64, answer: Option<String>) {
    let Some(state) = STATE.get() else { return };
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(answer);
    }
}

/// When this process was started as the askpass helper: ask the running app,
/// print the answer, and return the exit code. None means start normally.
///
/// Non-zero is how ssh and git hear "cancelled": they give up with their own
/// message, which is what the user then sees.
pub fn helper() -> Option<i32> {
    let url = std::env::var(URL_VAR).ok()?;
    let token = std::env::var(TOKEN_VAR).unwrap_or_default();
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let reply = ureq::post(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .send_json(json!({ "prompt": prompt }))
        .and_then(|mut r| r.body_mut().read_json::<serde_json::Value>());
    match reply {
        Ok(v) => match v["answer"].as_str() {
            Some(answer) => {
                println!("{answer}");
                Some(0)
            }
            None => Some(1),
        },
        Err(e) => {
            eprintln!("aditor: could not ask Aditor ({e})");
            Some(1)
        }
    }
}
