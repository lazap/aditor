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
use std::path::{Path, PathBuf};
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

use crate::fs::{workspace_root, Workspace};
use crate::mcp::{McpServer, PROMPT_TIMEOUT};

/// Flush pending PTY output at least this often. One event per read syscall
/// floods the IPC bridge when an agent dumps a long file; batching keeps
/// scrollback smooth without adding latency you can perceive.
const FLUSH_INTERVAL: Duration = Duration::from_millis(4);
/// ...or sooner, if this much has piled up.
const FLUSH_BYTES: usize = 32 * 1024;
const READ_BUF: usize = 8 * 1024;
/// How long a stopped run gets to exit on SIGTERM before it is SIGKILLed.
const KILL_GRACE: Duration = Duration::from_secs(2);

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
    /// The process the login shell `exec`ed into -- for an agent, the agent
    /// itself, which is what Claude Code's live registry is keyed on.
    pid: Option<u32>,
    /// Where it was started: the workspace an MCP tool call's paths resolve in.
    cwd: PathBuf,
    /// A run configuration rather than an agent: a shell line that may have
    /// started a tree of processes (`npm run dev` -> node -> esbuild), which
    /// the killer alone would orphan. Killed by process group instead.
    group: bool,
}

impl PtySession {
    fn kill(mut self) {
        match (self.group, self.pid) {
            (true, Some(pid)) => kill_group(pid),
            _ => {
                let _ = self.killer.kill();
            }
        }
    }
}

/// SIGTERM the process group `pid` leads, and SIGKILL whatever is left of it
/// after a grace period. portable-pty `setsid`s the child, so the shell leads
/// its own group and everything it started is in it. The grace lets a dev
/// server shut down cleanly; the SIGKILL is for one that ignores SIGTERM.
fn kill_group(pid: u32) {
    let pgid = pid as libc::pid_t;
    // SAFETY: plain signal syscalls on a group id we spawned.
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
        // A job-control shell would also get SIGHUP from the closing pty; a
        // `-c` shell may be waiting on a child that only listens for that.
        libc::killpg(pgid, libc::SIGHUP);
    }
    std::thread::spawn(move || {
        std::thread::sleep(KILL_GRACE);
        // SAFETY: as above. Signal 0 only checks the group still exists.
        unsafe {
            if libc::killpg(pgid, 0) == 0 {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    });
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

    /// The session running process `pid`, and the window that owns it.
    pub fn lookup_pid(&self, pid: u32) -> Option<(String, String)> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(_, s)| s.pid == Some(pid))
            .map(|(id, s)| (id.clone(), s.window.clone()))
    }

    /// The window that owns session `id`, and the folder it runs in.
    pub fn owner(&self, id: &str) -> Option<(String, PathBuf)> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| (s.window.clone(), s.cwd.clone()))
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
    /// What we run inside the login shell. `None` means "just the shell": no
    /// probed agent has it, but it is what the frontend's Terminal session
    /// (`SHELL_SESSION` in `src/pty/api.ts`) spawns.
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
/// `command` is None -- a Terminal session. `-l` sources the login profile, which is what makes the user's real
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
            // agent. Commands come from the frontend's registry of bare binary
            // names; nothing here enforces that. `args` is already
            // shell-quoted by `agent_args`.
            cmd.args(["-l", "-c", &format!("stty -echo 2>/dev/null; exec {c}{args}")]);
        }
        None => {
            // A Terminal session. An interactive shell needs ECHO left alone,
            // or you type blind.
            cmd.args(["-l", "-i"]);
        }
    }
    cmd.cwd(cwd);
    terminal_env(&mut cmd);
    // `ask_user` and `request_review` wait on the user. Claude Code's default
    // tool timeout would abort them first, so allow as long as the server
    // waits -- unless the user already chose a timeout of their own.
    if std::env::var_os("MCP_TOOL_TIMEOUT").is_none() {
        cmd.env("MCP_TOOL_TIMEOUT", PROMPT_TIMEOUT.as_millis().to_string());
    }
    cmd
}

/// Build `$SHELL -l -c '<script>'` for a run configuration. Unlike an agent's
/// command this is a whole shell line -- `cargo build && ./target/app` -- so
/// there is no `exec`, and the session is killed by process group instead
/// (see `PtySession::group`). ECHO stays on: a program reading stdin should
/// show what you type.
fn run_command(script: &str, cwd: &Path, env: &HashMap<String, String>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(user_shell());
    cmd.args(["-l", "-c", script]);
    cmd.cwd(cwd);
    terminal_env(&mut cmd);
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd
}

/// What every PTY we spawn gets: our terminal identity, minus whatever the
/// process that launched Aditor exported about itself.
fn terminal_env(cmd: &mut CommandBuilder) {
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
/// built-in todo list and the Tasks tab never hears of it -- and asks its
/// questions in prose rather than through the prompt Aditor can show.
const TASKS_NUDGE: &str = "You are running inside Aditor, an editor built around this \
    terminal. Whenever you plan multi-step work or a task's status changes, also call the \
    aditor `update_tasks` tool with the full task list, so the user can follow along in \
    Aditor's Tasks panel. When you point the user at code, call `open_file` so they see it. \
    When you need the user to pick between a few concrete options, call `ask_user` instead \
    of asking in prose. Call `request_review` only when the user asked to review changes \
    before you go on.";

/// A Claude Code session id: a UUID. Checked rather than trusted, since it
/// lands on a shell command line.
fn is_session_id(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Extra arguments for the agent in PTY `id`, leading space included. Only
/// Claude Code is wired to Aditor's MCP server, and only it can resume.
fn agent_args(command: Option<&str>, resume: Option<&str>, mcp_config: &str) -> String {
    match command {
        Some("claude") => {
            let resume = resume.map(|r| format!(" --resume {}", sh_quote(r))).unwrap_or_default();
            format!(
                // `--mcp-config` is variadic, so it goes last: anything after it
                // that is not a flag would be read as one more config.
                "{resume} --append-system-prompt {} --mcp-config {}",
                sh_quote(TASKS_NUDGE),
                sh_quote(mcp_config),
            )
        }
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
    resume: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    if let Some(r) = &resume {
        if !is_session_id(r) {
            return Err(format!("{r} is not a session id"));
        }
    }
    let pair = open_pty(cols, rows)?;

    // Allocated before the spawn: the agent's MCP URL carries it.
    let id = registry.new_id();
    let args = agent_args(command.as_deref(), resume.as_deref(), &mcp.config_for(&id));
    let child = pair
        .slave
        .spawn_command(shell_command(command.as_deref(), &args, &cwd))
        .map_err(|e| format!("spawn failed: {e}"))?;
    start_session(
        &window,
        &registry,
        id,
        pair,
        child,
        PathBuf::from(&cwd),
        false,
        on_event,
    )
}

/// Run a configuration's shell line in `cwd`, which must be inside the open
/// workspace `root`. Its output reaches the pane the same way an agent's does;
/// `pty_write`, `pty_resize` and `pty_kill` all work on the id it returns.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_run(
    window: WebviewWindow,
    registry: State<'_, Arc<PtyRegistry>>,
    ws: State<'_, Workspace>,
    root: String,
    script: String,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    let root = workspace_root(&ws, &root)?;
    // Canonicalized, so neither `..` nor a symlink can lead out of the project.
    let dir = root
        .join(&cwd)
        .canonicalize()
        .map_err(|e| format!("working directory {cwd}: {e}"))?;
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err(format!("working directory {cwd} is not a folder in the project"));
    }
    let pair = open_pty(cols, rows)?;
    let id = registry.new_id();
    let child = pair
        .slave
        .spawn_command(run_command(&script, &dir, &env))
        .map_err(|e| format!("spawn failed: {e}"))?;
    start_session(&window, &registry, id, pair, child, dir, true, on_event)
}

fn open_pty(cols: u16, rows: u16) -> Result<portable_pty::PtyPair, String> {
    native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))
}

/// Register a freshly spawned child under `id` and start the threads that
/// carry its input and output.
#[allow(clippy::too_many_arguments)]
fn start_session(
    window: &WebviewWindow,
    registry: &PtyRegistry,
    id: String,
    pair: portable_pty::PtyPair,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    cwd: PathBuf,
    group: bool,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
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
            pid: child.process_id(),
            cwd,
            group,
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
    let session = registry.sessions.lock().unwrap().remove(&id);
    if let Some(session) = session {
        session.kill();
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
        if let Some(session) = sessions.remove(id) {
            session.kill();
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
        // No entry above carries a `None` command; the Terminal session is
        // offered by the frontend rather than probed here.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Stopping a run must take the processes its shell line started with it,
    /// not just the shell: `npm run dev` leaves node behind otherwise.
    #[test]
    fn stopping_a_run_kills_its_whole_process_group() {
        let dir = std::env::temp_dir();
        let env = HashMap::new();
        // Two children in the background, then a foreground wait: the shell is
        // not exec'd away, exactly like a compound run line.
        let script = "sleep 300 & sleep 300 & wait";
        let pair = open_pty(80, 24).unwrap();
        let mut child = pair.slave.spawn_command(run_command(script, &dir, &env)).unwrap();
        let pid = child.process_id().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let alive = |pgid: u32| unsafe { libc::killpg(pgid as libc::pid_t, 0) == 0 };
        assert!(alive(pid), "the run's process group should exist");

        kill_group(pid);
        let _ = child.wait();
        // The children got SIGTERM along with the shell.
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while alive(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(pid), "a child of the run outlived Stop");
    }

    #[test]
    fn accepts_only_uuid_session_ids() {
        assert!(is_session_id("cbff751a-17a4-496c-970a-b21039d0cd30"));
        assert!(!is_session_id("cbff751a-17a4-496c-970a-b21039d0cd3"));
        assert!(!is_session_id("cbff751a-17a4-496c-970a-b21039d0cd3'"));
        assert!(!is_session_id("cbff751a 17a4-496c-970a-b21039d0cd30"));
        assert!(!is_session_id("$(rm -rf ~)-496c-970a-b21039d0cd30xx"));
    }

    #[test]
    fn resume_goes_before_the_variadic_mcp_config() {
        let id = "cbff751a-17a4-496c-970a-b21039d0cd30";
        let args = agent_args(Some("claude"), Some(id), "{}");
        let resume = args.find("--resume").unwrap();
        let mcp = args.find("--mcp-config").unwrap();
        assert!(resume < mcp);
        assert!(args.contains(&format!("--resume '{id}'")));
        assert!(args.trim_end().ends_with("'{}'"));
    }

    #[test]
    fn other_agents_get_no_arguments() {
        assert_eq!(agent_args(Some("opencode"), None, "{}"), "");
        assert_eq!(agent_args(None, None, "{}"), "");
    }
}
