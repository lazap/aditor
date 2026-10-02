//! PTY sessions: spawn an agent CLI on a real pseudo-terminal and pump its
//! output to the webview.
//!
//! The agent *is* the process here -- we run `$SHELL -l -c '<agent>'` rather
//! than dropping into an interactive shell and typing the command. That gives
//! clean lifecycle semantics (the pane's life == the agent's life) at the cost
//! of having no shell to fall back on when the agent quits, so the frontend has
//! to offer a restart when the session reports its exit.
//!
//! The login shell matters: a GUI-launched macOS app inherits a bare PATH, so
//! `claude` at /opt/homebrew/bin would not resolve if we exec'd it directly.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

use crate::mcp::McpServer;

/// Flush pending PTY output at least this often. One event per read syscall
/// floods the IPC bridge when an agent dumps a long file; batching keeps
/// scrollback smooth without adding latency you can perceive.
const FLUSH_INTERVAL: Duration = Duration::from_millis(4);
/// ...or sooner, if this much has piled up.
const FLUSH_BYTES: usize = 32 * 1024;
const READ_BUF: usize = 8 * 1024;

pub struct PtySession {
    /// Feeds the session's writer thread. A write to the PTY master blocks once
    /// the tty input queue is full and the child is not reading, so it must
    /// never happen on the IPC thread (the AppKit main thread) or under the
    /// `sessions` lock. Dropping this sender, with the session, ends the thread.
    input: Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    /// Needed because dropping `master` is *not* enough to end the child: the
    /// reader thread holds a cloned reader for the same PTY, so the master fd
    /// stays open, no SIGHUP is delivered, and the agent would outlive its
    /// pane. The killer lets `pty_kill` signal the child directly while the
    /// reader thread keeps the `Child` itself for `wait()`.
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Label of the window whose pane spawned it. Several editor windows can be
    /// open, and reloading or closing one must reap only its own agents.
    window: String,
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, PtySession>>,
    next_id: AtomicU64,
}

impl PtyRegistry {
    fn new_id(&self) -> String {
        format!("pty-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
}

/// What a session tells the pane that spawned it, over the channel that pane
/// handed to `pty_spawn`. A channel rather than global events: it exists
/// before the process does, so the first prompt and an immediate exit cannot
/// slip out before anyone is listening, and output goes to that one pane
/// instead of being broadcast to every window.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyEvent {
    Output {
        /// base64 of the raw bytes. Deliberately not a String: a read boundary can
    /// land mid-UTF-8-sequence, and lossy decoding would pepper the agent's
    /// box-drawing and emoji with replacement characters. xterm.js decodes
    /// incrementally from a Uint8Array, so bytes travel end to end untouched.
        bytes: String,
    },
    Exit {
        code: Option<i32>,
    },
}

/// An agent CLI Aditor knows how to launch.
#[derive(Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    /// What we run inside the login shell. `None` would mean "just the shell";
    /// no registry entry uses it today, but the path is kept so a plain-shell
    /// entry can come back as a one-line change.
    pub command: Option<String>,
    pub available: bool,
    pub version: Option<String>,
}

pub(crate) fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

/// Session and IPC markers exported by a parent agent process.
///
/// Aditor inherits whatever environment it was launched with, and passes it to
/// every agent it spawns. Launched from a terminal that is itself inside a
/// Claude Code session -- which is exactly what `npm run tauri dev` does while
/// developing Aditor -- these leak through and make the spawned Claude Code
/// believe it is a nested child session, which silently turns transcript
/// saving off.
///
/// Only session-scoped markers are stripped. Deliberate user configuration
/// (`ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`) must survive, or the agent cannot
/// authenticate or find its own settings.
const INHERITED_SESSION_VARS: [&str; 9] = [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
];

/// Variable prefixes exported by whatever terminal emulator launched Aditor.
///
/// Aditor *is* the terminal once it spawns a PTY, so the previous emulator's
/// identity must not pass through. This is not cosmetic: Ghostty exports
/// `TERMINFO` pointing into its own app bundle, and we advertise
/// `TERM=xterm-256color`, so ncurses programs would look that entry up in the
/// wrong database. Its `GHOSTTY_*` variables likewise re-activate Ghostty's
/// shell integration inside our terminal, emitting OSC sequences aimed at a
/// different emulator.
///
/// Matched by prefix so a future release adding variables is covered too.
const FOREIGN_TERMINAL_PREFIXES: [&str; 7] = [
    "GHOSTTY_",
    "ITERM_",
    "ITERM2_",
    "KITTY_",
    "WEZTERM_",
    "ALACRITTY_",
    "VSCODE_",
];

/// Exact terminal-identity variables, same reasoning as the prefixes above.
/// `ZDOTDIR` is deliberately absent: that one is the user's own shell
/// configuration, and dropping it would break their setup.
const FOREIGN_TERMINAL_VARS: [&str; 5] = [
    "TERMINFO",
    "TERMINFO_DIRS",
    "TERM_SESSION_ID",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
];

/// Build `$SHELL -l -c '<command>'`, or an interactive login shell when
/// `command` is None -- a branch nothing reaches while the registry is all
/// agents. `-l` sources the login profile, which is what makes the user's real
/// PATH (and therefore the agent binaries) visible.
fn shell_command(command: Option<&str>, args: &str, cwd: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(user_shell());
    match command {
        Some(c) => {
            // `stty -echo` closes a window in which the PTY line discipline
            // echoes terminal replies back as text. An agent TUI asks the
            // terminal for its device attributes (ESC[c) before switching the
            // tty to raw mode; xterm.js dutifully answers, and with ECHO still
            // on the answer is echoed to the screen -- appearing as a literal
            // `^[[?1;2c` in front of the first prompt (caret notation being
            // the tty's own ECHOCTL rendering of ESC, which is what identifies
            // the line discipline as the culprit rather than the renderer).
            //
            // `exec` keeps the process tree flat: without it zsh stays as a
            // parent, and the ChildKiller would signal the shell instead of the
            // agent. Commands come from a fixed registry of bare binary names;
            // `args` is already shell-quoted by `agent_args`.
            cmd.args(["-l", "-c", &format!("stty -echo 2>/dev/null; exec {c}{args}")]);
        }
        None => {
            // Dormant: see the note above. An interactive shell needs ECHO left
            // alone, or you type blind.
            cmd.args(["-l", "-i"]);
        }
    }
    cmd.cwd(cwd);
    // Claude Code and opencode both render full-colour TUIs; without these they
    // fall back to something much plainer.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Identify ourselves the way terminal emulators do, rather than passing on
    // a stale value describing whatever launched Aditor. Both halves must be
    // set together: TERM_PROGRAM=Aditor beside an inherited
    // TERM_PROGRAM_VERSION would claim a version that is not ours.
    cmd.env("TERM_PROGRAM", "Aditor");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

    for key in INHERITED_SESSION_VARS {
        cmd.env_remove(key);
    }
    for key in FOREIGN_TERMINAL_VARS {
        cmd.env_remove(key);
    }
    for (key, _) in std::env::vars() {
        if FOREIGN_TERMINAL_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
        {
            cmd.env_remove(&key);
        }
    }
    cmd
}

/// Output read but not yet sent, shared by a session's reader and ticker.
#[derive(Default)]
struct Outbox {
    bytes: Vec<u8>,
    /// The reader has seen EOF; the ticker can stop.
    done: bool,
}

/// Send whatever has been coalesced so far. Both the reader and the ticker
/// call this, under the same lock, so bytes reach the webview in read order.
fn flush(events: &Channel<PtyEvent>, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let _ = events.send(PtyEvent::Output {
        bytes: B64.encode(&pending),
    });
    pending.clear();
}

/// Quote for a POSIX shell: single quotes, with any `'` closed and reopened.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Told to Claude alongside the MCP config, or it keeps its plan in its own
/// built-in todo list and the Tasks tab never hears of it.
const TASKS_NUDGE: &str = "You are running inside Aditor. Whenever you plan multi-step work \
    or a task's status changes, also call the aditor `update_tasks` tool with the full task \
    list, so the user can follow along in Aditor's Tasks panel.";

/// Extra arguments for the agent in PTY `id`, leading space included. Only
/// Claude Code is wired to Aditor's MCP server today.
fn agent_args(command: Option<&str>, id: &str, mcp: &McpServer) -> String {
    match command {
        Some("claude") => format!(
            // `--mcp-config` is variadic, so it goes last: anything after it
            // that is not a flag would be read as one more config.
            " --append-system-prompt {} --mcp-config {}",
            sh_quote(TASKS_NUDGE),
            sh_quote(&mcp.config_for(id)),
        ),
        _ => String::new(),
    }
}

#[tauri::command]
pub fn pty_spawn(
    window: WebviewWindow,
    registry: State<'_, Arc<PtyRegistry>>,
    mcp: State<'_, McpServer>,
    command: Option<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // Allocated before the spawn: the agent's MCP URL carries it.
    let id = registry.new_id();
    let args = agent_args(command.as_deref(), &id, &mcp);
    let mut child = pair
        .slave
        .spawn_command(shell_command(command.as_deref(), &args, &cwd))
        .map_err(|e| format!("spawn failed: {e}"))?;
    // The slave fd must be dropped or the master never sees EOF on child exit.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    // Writer thread: one per session, so a child that stops reading stalls only
    // its own input, and keystrokes keep their order.
    let (input, queued) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in queued {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    registry.sessions.lock().unwrap().insert(
        id.clone(),
        PtySession {
            input,
            master: pair.master,
            killer: child.clone_killer(),
            window: window.label().to_string(),
        },
    );

    // The condvar wakes the ticker when output arrives in an empty outbox, so
    // an idle session costs no wakeups at all.
    let outbox = Arc::new((Mutex::new(Outbox::default()), Condvar::new()));

    // Ticker: the flush clock has to live outside the reader, because the
    // reader can only act when a read returns and then it blocks again. A
    // burst that ends inside the coalescing window would otherwise sit in
    // the outbox until the agent next wrote something -- which is why a prompt
    // redrawn after a resize, or a trust dialog on first open, stayed missing
    // until a click or keystroke shook the held bytes loose.
    {
        let events = on_event.clone();
        let outbox = Arc::clone(&outbox);
        std::thread::spawn(move || {
            let (lock, arrived) = &*outbox;
            loop {
                // Sleep until there is something to send, then give the
                // burst its coalescing window before sending it.
                let guard = lock.lock().unwrap();
                let guard = arrived
                    .wait_while(guard, |o| o.bytes.is_empty() && !o.done)
                    .unwrap();
                if guard.done {
                    break;
                }
                drop(guard);
                std::thread::sleep(FLUSH_INTERVAL);
                flush(&events, &mut lock.lock().unwrap().bytes);
            }
        });
    }

    // Reader thread: coalesce into the outbox; the size cap is the only reason
    // to emit early, since the ticker owns the deadline.
    {
        let events = on_event;
        std::thread::spawn(move || {
            let (lock, arrived) = &*outbox;
            let mut buf = [0u8; READ_BUF];

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut o = lock.lock().unwrap();
                        let was_empty = o.bytes.is_empty();
                        o.bytes.extend_from_slice(&buf[..n]);
                        if o.bytes.len() >= FLUSH_BYTES {
                            flush(&events, &mut o.bytes);
                        } else if was_empty {
                            arrived.notify_one();
                        }
                    }
                    Err(_) => break,
                }
            }
            {
                // Under the lock, so the ticker cannot miss it between
                // checking and waiting.
                let mut o = lock.lock().unwrap();
                o.done = true;
                flush(&events, &mut o.bytes);
            }
            arrived.notify_one();

            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            let _ = events.send(PtyEvent::Exit { code });
        });
    }

    Ok(id)
}

#[tauri::command]
pub fn pty_write(
    registry: State<'_, Arc<PtyRegistry>>,
    id: String,
    bytes: String,
) -> Result<(), String> {
    let data = B64.decode(bytes).map_err(|e| format!("bad base64: {e}"))?;
    let sessions = registry.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such session")?;
    session
        .input
        .send(data)
        .map_err(|_| "session closed".to_string())
}

#[tauri::command]
pub fn pty_resize(
    registry: State<'_, Arc<PtyRegistry>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = registry.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// End the session: signal the child, then drop our handles. The reader thread
/// sees EOF once the child is gone and sends `Exit` on its way out.
#[tauri::command]
pub fn pty_kill(
    registry: State<'_, Arc<PtyRegistry>>,
    mcp: State<'_, McpServer>,
    id: String,
) -> Result<(), String> {
    if let Some(mut session) = registry.sessions.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
    mcp.clear(&id);
    Ok(())
}

/// Reap the sessions one window spawned, returning their ids.
///
/// The frontend cannot be the only thing responsible for cleanup: a full page
/// reload throws away the JS context *without* running React's effect cleanups,
/// so no `pty_kill` is ever sent and the agent outlives the page that owned it.
/// Same on window close. So each editor window calls this once at startup --
/// any session it owned before its first spawn is an orphan from a previous
/// page -- and the window-destroyed handler calls it on the way out. Scoped to
/// the window, so every other editor window's agents carry on.
pub fn kill_window(registry: &PtyRegistry, label: &str) -> Vec<String> {
    let mut sessions = registry.sessions.lock().unwrap();
    let ids: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| s.window == label)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &ids {
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.killer.kill();
        }
    }
    ids
}

/// The calling window's orphans: called once per page load, before the first
/// spawn, so a reload does not leave the previous page's agents running.
#[tauri::command]
pub fn pty_kill_window(
    window: WebviewWindow,
    registry: State<'_, Arc<PtyRegistry>>,
    mcp: State<'_, McpServer>,
) -> Result<(), String> {
    for id in kill_window(&registry, window.label()) {
        mcp.clear(&id);
    }
    Ok(())
}

/// Probe the agents we know about, through a login shell so PATH matches what
/// the user sees in their own terminal.
///
/// Each probe starts a login shell, which a heavy profile can make take
/// seconds, so they run in parallel and off the UI thread.
#[tauri::command]
pub async fn agents_available() -> Result<Vec<AgentInfo>, String> {
    tauri::async_runtime::spawn_blocking(probe_agents)
        .await
        .map_err(|e| format!("probing agents did not finish: {e}"))
}

fn probe_agents() -> Vec<AgentInfo> {
    let known = [
        ("claude", "Claude Code", Some("claude")),
        ("opencode", "opencode", Some("opencode")),
    ];

    std::thread::scope(|scope| {
        let probes: Vec<_> = known
            .iter()
            .map(|agent| scope.spawn(move || probe(agent)))
            .collect();
        probes
            .into_iter()
            .map(|p| p.join().expect("agent probe panicked"))
            .collect()
    })
}

fn probe(&(id, label, command): &(&str, &str, Option<&str>)) -> AgentInfo {
    match command {
        // Dormant alongside `shell_command`'s None arm -- no entry above
        // carries a `None` command today.
        None => AgentInfo {
            id: id.to_string(),
            label: label.to_string(),
            command: None,
            available: true,
            version: Some(user_shell()),
        },
        Some(bin) => {
            let out = std::process::Command::new(user_shell())
                .args(["-l", "-c", &format!("command -v {bin} >/dev/null && {bin} --version")])
                .output();
            let version = out.ok().filter(|o| o.status.success()).map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string()
            });
            AgentInfo {
                id: id.to_string(),
                label: label.to_string(),
                command: Some(bin.to_string()),
                available: version.is_some(),
                version,
            }
        }
    }
}
