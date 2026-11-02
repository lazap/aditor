//! PTY sessions: spawn an agent CLI on a real pseudo-terminal and pump its
//! output to the webview.
//!
//! The agent *is* the process here -- we run `$SHELL -l -c '<agent>'` rather
//! than dropping into an interactive shell and typing the command. That gives
//! clean lifecycle semantics (the pane's life == the agent's life) at the cost
//! of having no shell to fall back on when the agent quits, so the frontend has
//! to offer a restart when the session reports its exit.
//!
//! PATH matters: a GUI-launched macOS app inherits a bare one, so `claude` at
//! /opt/homebrew/bin would not resolve if we exec'd it directly. Every PTY gets
//! the PATH the user's own terminal has (`search_dirs`), and agents are exec'd
//! by the absolute path the probe found.
//!
//! Windows has no login shell to source and nothing to `exec`, so there the
//! agent is started directly, its arguments handed over as a list, and a run
//! configuration's line goes to `cmd.exe`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

use crate::fs::{workspace_root, Workspace};
use crate::mcp::{McpServer, PROMPT_TIMEOUT};
use crate::platform::{find_executable, hide_console, home_dir, install_dirs, kill_tree, launcher, user_shell};
use crate::run_log::RunLog;

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
    /// A run's output, as text the agent can read. Kept until the tab closes
    /// or reruns, so a run that crashed can still be asked about.
    log: Option<Arc<Mutex<RunLog>>>,
}

impl PtySession {
    fn kill(mut self) {
        match (self.group, self.pid) {
            (true, Some(pid)) => kill_tree(pid, KILL_GRACE),
            _ => {
                let _ = self.killer.kill();
            }
        }
    }
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

    /// The runs window `window` has open in workspace `root`, newest first.
    pub fn runs(&self, window: &str, root: &Path) -> Vec<Arc<Mutex<RunLog>>> {
        let sessions = self.sessions.lock().unwrap();
        let mut runs: Vec<(u64, Arc<Mutex<RunLog>>)> = sessions
            .iter()
            .filter(|(_, s)| s.window == window)
            .filter_map(|(id, s)| Some((id_seq(id), Arc::clone(s.log.as_ref()?))))
            .filter(|(_, log)| log.lock().unwrap().root == root)
            .collect();
        runs.sort_by_key(|r| std::cmp::Reverse(r.0));
        runs.into_iter().map(|(_, log)| log).collect()
    }

    /// Session `id`'s run output, if it is a run.
    fn log(&self, id: &str) -> Option<Arc<Mutex<RunLog>>> {
        self.sessions.lock().unwrap().get(id)?.log.clone()
    }
}

/// The counter behind a `pty-N` id: later spawns sort higher.
fn id_seq(id: &str) -> u64 {
    id.strip_prefix("pty-").and_then(|n| n.parse().ok()).unwrap_or(0)
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

/// Printed just before PATH, so whatever an rc file prints on startup -- a
/// banner, a fortune, a terminal title -- is not mistaken for it.
const PATH_MARKER: &str = "__ADITOR_PATH__";

/// How long the user's shell gets to start and report its PATH. A profile
/// waiting on input that never comes must not leave Aditor at "Starting…".
const SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(10);

/// How long an agent gets to answer `--version`.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// Where installers put agent binaries, relative to the home directory, whether
/// or not they managed to add them to PATH. Searched after PATH.
const HOME_BIN_DIRS: [&str; 6] = [
    ".local/bin",
    ".claude/local",
    ".opencode/bin",
    ".bun/bin",
    ".npm-global/bin",
    ".volta/bin",
];

static SEARCH_DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Where to look for programs: the user's PATH, then the usual install
/// directories. Resolved once, by `agents_available` at startup.
///
/// Blocks on the user's shell the first time, so never call it on the UI
/// thread; `resolved_search_dirs` is the non-blocking read.
fn search_dirs() -> &'static [PathBuf] {
    SEARCH_DIRS.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = user_path()
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        if let Some(home) = home_dir() {
            dirs.extend(HOME_BIN_DIRS.iter().map(|d| home.join(d)));
        }
        dirs.extend(install_dirs());
        let mut seen = std::collections::HashSet::new();
        dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
        dirs
    })
}

/// `bin` where the agents are looked for: PATH, then the install folders.
/// Blocks on the user's shell the first time, like `search_dirs`.
pub(crate) fn find_program(bin: &str) -> Option<PathBuf> {
    find_executable(bin, search_dirs())
}

fn resolved_search_dirs() -> Option<&'static [PathBuf]> {
    SEARCH_DIRS.get().map(Vec::as_slice)
}

/// PATH as the user's own terminal has it, asked of their shell.
///
/// A login shell alone is not enough: `zsh -l -c` reads .zprofile but not
/// .zshrc, and `bash -l -c` reads .bash_profile but not .bashrc -- which is
/// where installers and version managers (nvm, the Claude Code installer)
/// usually add their bin directories. So ask an interactive login shell, as a
/// terminal starts one, and settle for less when that fails. The line runs only
/// external commands, which keeps it valid in fish and nushell as well as in
/// POSIX shells.
fn user_path() -> Option<String> {
    // Only a Unix GUI app starts with less PATH than the terminal has; Windows
    // hands every program the user's whole PATH, and has no shell to ask.
    if cfg!(windows) {
        return std::env::var("PATH").ok();
    }
    let script = format!("/bin/echo {PATH_MARKER}; /usr/bin/printenv PATH");
    let attempts: [&[&str]; 3] = [&["-i", "-l", "-c"], &["-l", "-c"], &["-c"]];
    attempts
        .iter()
        .find_map(|flags| {
            let mut cmd = Command::new(user_shell());
            cmd.args(*flags).arg(&script);
            line_within(cmd, Some(PATH_MARKER), SHELL_PATH_TIMEOUT)
        })
        .or_else(|| std::env::var("PATH").ok())
}

/// Run `cmd` and return the first line of its stdout -- or, given `after`, the
/// line following the first one that ends in it. `None` after `timeout`.
///
/// Reads line by line rather than to EOF: something an rc file starts in the
/// background (an ssh-agent, a gpg-agent) can hold stdout open long after the
/// shell itself has exited.
fn line_within(mut cmd: Command, after: Option<&str>, timeout: Duration) -> Option<String> {
    let mut child = hide_console(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let after = after.map(str::to_string);
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines().map_while(Result::ok);
        if let Some(marker) = &after {
            if !lines.any(|l| l.trim_end().ends_with(marker.as_str())) {
                return;
            }
        }
        let _ = tx.send(lines.next());
    });
    let line = rx.recv_timeout(timeout).ok().flatten();
    let _ = child.kill();
    let _ = child.wait();
    line.map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
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
/// `command` is None -- a Terminal session. `-l` sources the login profile, so
/// the agent sees the environment the user exports there.
///
/// On Windows: the agent itself, or PowerShell for a Terminal session.
fn shell_command(command: Option<&str>, args: &[String], cwd: &str) -> Result<CommandBuilder, String> {
    let mut cmd = if cfg!(windows) {
        windows_command(command, args)?
    } else {
        unix_command(command, args)
    };
    cmd.cwd(cwd);
    terminal_env(&mut cmd);
    // `ask_user` and `request_review` wait on the user. Claude Code's default
    // tool timeout would abort them first, so allow as long as the server
    // waits -- unless the user already chose a timeout of their own.
    if std::env::var_os("MCP_TOOL_TIMEOUT").is_none() {
        cmd.env("MCP_TOOL_TIMEOUT", PROMPT_TIMEOUT.as_millis().to_string());
    }
    Ok(cmd)
}

fn unix_command(command: Option<&str>, args: &[String]) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(user_shell());
    match command {
        Some(c) => {
            // By the path the probe found, which may be an install directory
            // the user's PATH never mentions.
            let program = resolved_search_dirs()
                .and_then(|dirs| find_executable(c, dirs))
                .map(|p| sh_quote(&p.to_string_lossy()))
                .unwrap_or_else(|| c.to_string());
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
            // names; nothing here enforces that.
            let args: String = args.iter().map(|a| format!(" {}", sh_quote(a))).collect();
            cmd.args(["-l", "-c", &format!("stty -echo 2>/dev/null; exec {program}{args}")]);
        }
        None => {
            // A Terminal session. An interactive shell needs ECHO left alone,
            // or you type blind.
            cmd.args(["-l", "-i"]);
        }
    }
    cmd
}

/// The agent as its own process, its arguments as a list: the PTY quotes each
/// one for the command line, and no shell parses it again. Windows hands GUI
/// apps the user's whole environment, so there is no profile to source first.
fn windows_command(command: Option<&str>, args: &[String]) -> Result<CommandBuilder, String> {
    let dirs = search_dirs();
    let Some(c) = command else {
        // PowerShell, as Windows Terminal opens: 7 when it is installed, else
        // the Windows PowerShell every Windows has.
        let shell = find_executable("pwsh", dirs)
            .map(|p| p.into_os_string())
            .unwrap_or_else(|| "powershell.exe".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-NoLogo");
        return Ok(cmd);
    };
    let program = find_executable(c, dirs).ok_or_else(|| format!("{c} is not installed, or not on PATH."))?;
    let (program, before) = launcher(&program, dirs)?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(before);
    cmd.args(args);
    Ok(cmd)
}

/// Build `$SHELL -l -c '<script>'` for a run configuration. Unlike an agent's
/// command this is a whole shell line -- `cargo build && ./target/app` -- so
/// there is no `exec`, and the session is killed by process group instead
/// (see `PtySession::group`). ECHO stays on: a program reading stdin should
/// show what you type.
///
/// On Windows the line goes to `cmd.exe` by way of a batch file holding it.
/// Passed on the command line, it would be quoted the C runtime's way -- every
/// `"` turned into `\"` -- and `cmd.exe` would run it with the backslashes in.
/// `id` names the file, so a rerun overwrites its own.
fn run_command(id: &str, script: &str, cwd: &Path, env: &HashMap<String, String>) -> Result<CommandBuilder, String> {
    let mut cmd = if cfg!(windows) {
        let batch = std::env::temp_dir().join(format!("aditor-run-{}-{id}.cmd", std::process::id()));
        std::fs::write(&batch, format!("@echo off\r\n{script}\r\n"))
            .map_err(|e| format!("could not write {}: {e}", batch.display()))?;
        let mut cmd = CommandBuilder::new(user_shell());
        // /d: no AutoRun commands from the registry, as a script expects.
        cmd.args(["/d".as_ref(), "/c".as_ref(), batch.as_os_str()]);
        cmd
    } else {
        let mut cmd = CommandBuilder::new(user_shell());
        cmd.args(["-l", "-c", script]);
        cmd
    };
    cmd.cwd(cwd);
    terminal_env(&mut cmd);
    for (key, value) in env {
        cmd.env(key, value);
    }
    Ok(cmd)
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
    // The PATH the user's terminal has, rc files included, so an npm-installed
    // agent's `#!/usr/bin/env node` finds the node nvm put there. The login
    // profile still runs on top of it. Not yet resolved means the probe has not
    // finished, and waiting for it here would freeze the UI thread.
    if let Some(path) = resolved_search_dirs().and_then(|d| std::env::join_paths(d).ok()) {
        cmd.env("PATH", path);
    }

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
    before you go on. The user's dev servers, test runs and builds run in Aditor too: when \
    they mention an error from one, read it with `read_run_output` instead of asking them \
    to paste it.";

/// A Claude Code session id: a UUID. Checked rather than trusted, since it
/// lands on a shell command line.
fn is_session_id(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Extra arguments for the agent in PTY `id`, unquoted. Only Claude Code is
/// wired to Aditor's MCP server, and only it can resume.
fn agent_args(command: Option<&str>, resume: Option<&str>, mcp_config: &str) -> Vec<String> {
    match command {
        Some("claude") => {
            let mut args = Vec::new();
            if let Some(r) = resume {
                args.extend(["--resume".to_string(), r.to_string()]);
            }
            // `--mcp-config` is variadic, so it goes last: anything after it
            // that is not a flag would be read as one more config.
            args.extend([
                "--append-system-prompt".to_string(),
                TASKS_NUDGE.to_string(),
                "--mcp-config".to_string(),
                mcp_config.to_string(),
            ]);
            args
        }
        _ => Vec::new(),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
        .spawn_command(shell_command(command.as_deref(), &args, &cwd)?)
        .map_err(|e| format!("spawn failed: {e}"))?;
    start_session(
        &window,
        &registry,
        id,
        pair,
        child,
        PathBuf::from(&cwd),
        false,
        None,
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
    name: String,
    config_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    let root = workspace_root(&ws, &root)?;
    // Canonicalized, so neither `..` nor a symlink can lead out of the project.
    let dir = crate::platform::canonicalize(&root.join(&cwd))
        .map_err(|e| format!("working directory {cwd}: {e}"))?;
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err(format!("working directory {cwd} is not a folder in the project"));
    }
    let pair = open_pty(cols, rows)?;
    let id = registry.new_id();
    let child = pair
        .slave
        .spawn_command(run_command(&id, &script, &dir, &env)?)
        .map_err(|e| format!("spawn failed: {e}"))?;
    let log = Arc::new(Mutex::new(RunLog::new(name, config_id, root)));
    start_session(&window, &registry, id, pair, child, dir, true, Some(log), on_event)
}

/// The last `lines` lines run `id` printed, as plain text: what the run tab's
/// "Send to agent" pastes.
#[tauri::command]
pub fn run_output(
    registry: State<'_, Arc<PtyRegistry>>,
    id: String,
    lines: usize,
) -> Result<String, String> {
    let log = registry.log(&id).ok_or("That run is no longer open.")?;
    let tail = log.lock().unwrap().tail(lines, None);
    Ok(tail.text)
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
    log: Option<Arc<Mutex<RunLog>>>,
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
            log: log.clone(),
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
                        if let Some(log) = &log {
                            log.lock().unwrap().push(&buf[..n]);
                        }
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
            if let Some(log) = &log {
                log.lock().unwrap().exit = Some(code);
            }
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

/// Probe the agents we know about: look for each binary on the user's PATH and
/// in the usual install directories, then ask it for `--version`.
///
/// Resolving PATH starts the user's shell, which a heavy profile can make take
/// seconds, so this runs off the UI thread.
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
    // Before the probes fan out, so they share one shell start.
    let dirs = search_dirs();

    std::thread::scope(|scope| {
        let probes: Vec<_> = known
            .iter()
            .map(|agent| scope.spawn(move || probe(agent, dirs)))
            .collect();
        probes
            .into_iter()
            .map(|p| p.join().expect("agent probe panicked"))
            .collect()
    })
}

fn probe(&(id, label, command): &(&str, &str, Option<&str>), dirs: &[PathBuf]) -> AgentInfo {
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
            let version = find_executable(bin, dirs).and_then(|path| {
                let mut cmd = Command::new(path);
                cmd.arg("--version");
                // Same PATH as a session gets, for the `env node` shebang.
                if let Ok(p) = std::env::join_paths(dirs) {
                    cmd.env("PATH", p);
                }
                line_within(cmd, None, VERSION_TIMEOUT)
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
    #[cfg(unix)]
    #[test]
    fn stopping_a_run_kills_its_whole_process_group() {
        let dir = std::env::temp_dir();
        let env = HashMap::new();
        // Two children in the background, then a foreground wait: the shell is
        // not exec'd away, exactly like a compound run line.
        let script = "sleep 300 & sleep 300 & wait";
        let pair = open_pty(80, 24).unwrap();
        let cmd = run_command("test", script, &dir, &env).unwrap();
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        let pid = child.process_id().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let alive = |pgid: u32| unsafe { libc::killpg(pgid as libc::pid_t, 0) == 0 };
        assert!(alive(pid), "the run's process group should exist");

        kill_tree(pid, KILL_GRACE);
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
        let at = |flag: &str| args.iter().position(|a| a == flag).unwrap();
        assert!(at("--resume") < at("--mcp-config"));
        assert_eq!(args[at("--resume") + 1], id);
        assert_eq!(args.last().map(String::as_str), Some("{}"));
    }

    #[test]
    fn other_agents_get_no_arguments() {
        assert!(agent_args(Some("opencode"), None, "{}").is_empty());
        assert!(agent_args(None, None, "{}").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_path_line_follows_the_marker_past_rc_noise() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", &format!("echo welcome; printf '\\033]0;title\\007{PATH_MARKER}\\n'; echo /a:/b")]);
        assert_eq!(line_within(cmd, Some(PATH_MARKER), Duration::from_secs(5)).as_deref(), Some("/a:/b"));

        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "echo no marker here"]);
        assert_eq!(line_within(cmd, Some(PATH_MARKER), Duration::from_secs(5)), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_line_comes_back_without_waiting_for_eof_or_a_hung_shell() {
        // A background child holding stdout open must not delay the answer...
        let started = std::time::Instant::now();
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "echo 1.2.3; sleep 30 & wait"]);
        assert_eq!(line_within(cmd, None, Duration::from_secs(5)).as_deref(), Some("1.2.3"));
        assert!(started.elapsed() < Duration::from_secs(4));

        // ...and a shell that never prints gives up at the timeout.
        let started = std::time::Instant::now();
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);
        assert_eq!(line_within(cmd, None, Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}
