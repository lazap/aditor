//! What differs between macOS, Linux and Windows, behind one set of calls.
//!
//! Everything that needs an OS-specific API -- signals, process handles, file
//! modes, a power assertion -- lives here, so the rest of the backend reads the
//! same on every platform, and porting it is a matter of filling in this file
//! rather than hunting `cfg`s across the crate.
//!
//! macOS is what Aditor ships on; Linux shares its Unix half. Windows differs
//! most in two ways the rest of the crate has to know about: no shell runs the
//! agents (see `pty.rs`), and paths travel to the frontend with forward
//! slashes (`path_string`), so the webview splits every path the same way.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// The user's home directory. `HOME` on Unix, falling back to the password
/// database; the profile folder on Windows, which rarely sets `HOME` at all.
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// 32 hex characters from the OS's CSPRNG: a bearer token for the loopback
/// server, good for one launch.
pub fn random_token() -> std::io::Result<String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// The user's shell: `$SHELL`, or the platform's default when it is unset.
/// Windows has no such thing; it is only asked for there to be named in the
/// UI, and gets `cmd.exe`.
pub fn user_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| DEFAULT_SHELL.to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

/// zsh has been macOS's login shell since Catalina; elsewhere only `sh` is
/// certain to exist.
#[cfg(target_os = "macos")]
const DEFAULT_SHELL: &str = "/bin/zsh";
#[cfg(all(unix, not(target_os = "macos")))]
const DEFAULT_SHELL: &str = "/bin/sh";

/// Where installers put programs whether or not they made it onto PATH,
/// searched after it: Homebrew on macOS; on Linux the system folders a GUI
/// session may leave out, Linuxbrew, and snap; on Windows npm's global folder,
/// and Git's and Node's own install folders.
pub fn install_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let dirs = ["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from).to_vec();
    #[cfg(all(unix, not(target_os = "macos")))]
    let dirs = ["/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"]
        .map(PathBuf::from)
        .to_vec();
    #[cfg(windows)]
    let dirs = {
        let env = |key: &str, rest: &str| std::env::var_os(key).map(|v| PathBuf::from(v).join(rest));
        [
            env("APPDATA", "npm"),
            env("ProgramFiles", "Git\\cmd"),
            env("ProgramFiles", "nodejs"),
        ]
        .into_iter()
        .flatten()
        .collect()
    };
    dirs
}

/// Before the first window opens. WebKitGTK's DMA-BUF renderer draws blank or
/// black windows under Nvidia's proprietary driver, so turn it off there --
/// unless the user already chose for themselves. Nothing to do elsewhere.
pub fn prepare_webview() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && Path::new("/proc/driver/nvidia/version").exists()
    {
        // Before any thread is spawned, so nothing can be reading the
        // environment while it changes.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

// ----------------------------------------------------------------- paths ---

/// `std::fs::canonicalize`, but on Windows without the `\\?\` prefix it puts
/// on every path -- which nothing the user types or the agent prints carries,
/// so no comparison with one would ever match.
pub fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// `path` as the frontend sees it. Its own text on Unix; on Windows with
/// forward slashes, which every Windows API accepts and the webview splits
/// on, so the frontend handles one kind of path everywhere.
pub fn path_string(path: &Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() }
}

/// Whether two path strings from different sources -- ours, and one Claude
/// Code recorded -- name the same folder. Exact on Unix. Windows paths are
/// case-insensitive and take either slash, and a drive letter comes back
/// upper- or lower-case depending on who asked.
pub fn same_path(a: &str, b: &str) -> bool {
    if !cfg!(windows) {
        return a == b;
    }
    let norm = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

/// Bump a directory's modification time. False once it is gone.
pub fn touch_dir(dir: &Path) -> bool {
    use std::time::SystemTime;
    #[cfg(unix)]
    let opened = std::fs::File::open(dir);
    // A directory opens on Windows only with backup semantics, and its times
    // change only through a handle allowed to write its attributes.
    #[cfg(windows)]
    let opened = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        std::fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(dir)
    };
    opened.and_then(|f| f.set_modified(SystemTime::now())).is_ok()
}

// ------------------------------------------------------------- processes ---

/// The first of `dirs` holding a program called `bin`.
///
/// On Unix that is a file with an execute bit. Windows has no such bit: a
/// program is a file with an extension `PATHEXT` lists, so `claude` is found as
/// `claude.exe`, or as an npm shim's `claude.cmd`.
pub fn find_executable(bin: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().find_map(|d| executable_in(d, bin))
}

#[cfg(unix)]
fn executable_in(dir: &Path, bin: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(bin);
    let runnable = path
        .metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
    runnable.then_some(path)
}

#[cfg(windows)]
fn executable_in(dir: &Path, bin: &str) -> Option<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    exts.split(';')
        .filter(|e| !e.is_empty())
        .map(|e| dir.join(format!("{bin}{}", e.to_ascii_lowercase())))
        .find(|p| p.is_file())
}

/// What actually runs `program`, as a program and the arguments that go
/// before the caller's.
///
/// Only an npm shim is not run as itself. `claude.cmd` is a batch file, and a
/// batch file's arguments pass through `cmd.exe`, whose quoting rules are not
/// the ones every other Windows program -- and the PTY's command line --
/// follows: the JSON handed to `--mcp-config` would arrive mangled. A shim's
/// whole job is to start Node on one script, so start that directly. The
/// agent's process is then the pane's own, as an `exec` makes it on Unix.
pub fn launcher(program: &Path, dirs: &[PathBuf]) -> Result<(PathBuf, Vec<OsString>), String> {
    let batch = program
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if !batch {
        return Ok((program.to_path_buf(), Vec::new()));
    }
    let unsupported = || {
        format!(
            "{} is a batch file Aditor cannot start an agent from. Install the agent's own \
             Windows build, or through npm.",
            program.display()
        )
    };
    let text = std::fs::read_to_string(program).map_err(|_| unsupported())?;
    let script = npm_shim_script(&text).ok_or_else(unsupported)?;
    let here = program.parent().unwrap_or(Path::new(""));
    // The shim prefers a node.exe beside it, as npm's own logic does.
    let bundled = here.join("node.exe");
    let node = if bundled.is_file() {
        bundled
    } else {
        find_executable("node", dirs).ok_or_else(|| format!("{}: node is not on PATH.", program.display()))?
    };
    Ok((node, vec![here.join(script).into_os_string()]))
}

/// The script an npm `cmd-shim` runs, relative to the shim's folder: the last
/// `"%dp0%\…"` (or older shims' `"%~dp0\…"`) on its command line that names a
/// JavaScript file. None for any other batch file.
pub fn npm_shim_script(text: &str) -> Option<String> {
    let mut found = None;
    for marker in ["\"%dp0%\\", "\"%~dp0\\"] {
        for (at, _) in text.match_indices(marker) {
            let rest = &text[at + marker.len()..];
            let Some(end) = rest.find('"') else { continue };
            let path = &rest[..end];
            if [".js", ".cjs", ".mjs"].iter().any(|ext| path.ends_with(ext)) {
                found = Some((at, path.to_string()));
            }
        }
    }
    found.map(|(_, path)| path)
}

/// Keep a console program from flashing a console window of its own when a
/// GUI app starts it on Windows. Nothing to do elsewhere.
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Is process `pid` still running? Tells a live registry entry from one left
/// behind by a process that died without cleaning up.
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    // Signal 0 performs the existence and permission checks without delivering
    // anything -- the standard liveness probe.
    // SAFETY: a plain syscall; nothing is signalled.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // A handle outlives its process, so being able to open one is not enough:
    // the exit code says whether it is still running.
    // SAFETY: the handle is checked before use and closed after it.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let read = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        read && code == STILL_ACTIVE as u32
    }
}

/// Stop the process tree `pid` leads, giving it `grace` to exit on its own
/// before it is forced. Returns at once; the forcing happens on a thread.
///
/// On Unix, `pid` must lead its own process group, as a portable-pty child
/// does (it `setsid`s), so everything it started is in the group. SIGTERM lets
/// a dev server shut down cleanly; the SIGKILL is for one that ignores it.
#[cfg(unix)]
pub fn kill_tree(pid: u32, grace: Duration) {
    let pgid = pid as libc::pid_t;
    // SAFETY: plain signal syscalls on a group id we spawned.
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
        // A job-control shell would also get SIGHUP from the closing pty; a
        // `-c` shell may be waiting on a child that only listens for that.
        libc::killpg(pgid, libc::SIGHUP);
    }
    std::thread::spawn(move || {
        std::thread::sleep(grace);
        // SAFETY: as above. Signal 0 only checks the group still exists.
        unsafe {
            if libc::killpg(pgid, 0) == 0 {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    });
}

/// Windows has no SIGTERM to offer a console program first, so there is no
/// grace to give: `taskkill /T` walks the tree from `pid` and ends it all.
#[cfg(windows)]
pub fn kill_tree(pid: u32, _grace: Duration) {
    use std::process::Stdio;
    let _ = hide_console(&mut Command::new("taskkill"))
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

// ------------------------------------------------------------ keep awake ---

/// Keeps the computer from sleeping for as long as it is held, and lets go
/// when Aditor exits however it exits -- a crash or a force quit included,
/// which no cleanup of ours would see.
///
/// On macOS, `caffeinate` holds the power assertions rather than IOKit calls
/// from here: it is on every Mac, and `-w` ties it to our pid.
///
/// On Linux, `systemd-inhibit` takes logind's idle and sleep locks for as long
/// as the command it runs lives, and that command is a `tail` waiting for our
/// pid to go. It runs in a group of its own, so releasing takes the `tail`
/// down with it rather than leaving it to wait us out.
///
/// On Windows, a thread of ours holds `SetThreadExecutionState`, which the
/// system drops the moment the thread -- or the process -- ends.
pub struct Awake {
    #[cfg(unix)]
    child: std::process::Child,
    #[cfg(windows)]
    stop: std::sync::mpsc::Sender<()>,
    #[cfg(windows)]
    thread: std::thread::JoinHandle<()>,
}

impl Awake {
    #[cfg(target_os = "macos")]
    pub fn start() -> Result<Self, String> {
        use std::process::Stdio;
        // -d display, -i idle, -m disk, -s system (on AC power): the lot, as a
        // "keep awake" switch is expected to mean. -w: only as long as we live.
        Command::new("/usr/bin/caffeinate")
            .args(["-dims", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|child| Awake { child })
            .map_err(|e| format!("could not start caffeinate: {e}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    pub fn start() -> Result<Self, String> {
        use std::io::Read;
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        // idle: no screen blanking or lock, as caffeinate's -d. sleep: no
        // suspend. Lid switches stay the user's call.
        let mut child = Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--who=Aditor",
                "--why=Keep awake is on",
                "--mode=block",
                "tail",
                &format!("--pid={}", std::process::id()),
                "-f",
                "/dev/null",
            ])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start systemd-inhibit: {e}"))?;
        // Without logind -- no systemd, or a container -- it fails at once.
        // Catch that here rather than report a hold that is not there.
        std::thread::sleep(Duration::from_millis(150));
        if let Ok(Some(_)) = child.try_wait() {
            let mut why = String::new();
            if let Some(mut err) = child.stderr.take() {
                let _ = err.read_to_string(&mut why);
            }
            return Err(format!("systemd-inhibit could not hold the computer awake: {}", why.trim()));
        }
        Ok(Awake { child })
    }

    #[cfg(windows)]
    pub fn start() -> Result<Self, String> {
        use windows_sys::Win32::System::Power::{
            ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let (tx, held) = std::sync::mpsc::channel::<bool>();
        let thread = std::thread::spawn(move || {
            // SAFETY: plain calls on this thread's own execution state.
            let ok = unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
            } != 0;
            let _ = tx.send(ok);
            if ok {
                // Until `release` drops the sender.
                let _ = stopped.recv();
                // SAFETY: as above.
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            }
        });
        if held.recv() == Ok(true) {
            Ok(Awake { stop, thread })
        } else {
            Err("Windows would not hold the computer awake.".to_string())
        }
    }

    /// Still holding, unless whatever holds it has died behind our back.
    pub fn holding(&mut self) -> bool {
        #[cfg(unix)]
        {
            matches!(self.child.try_wait(), Ok(None))
        }
        #[cfg(windows)]
        {
            !self.thread.is_finished()
        }
    }

    pub fn release(self) {
        #[cfg(unix)]
        {
            let mut child = self.child;
            #[cfg(not(target_os = "macos"))]
            // SAFETY: a signal to the group this child leads.
            unsafe {
                libc::killpg(child.id() as libc::pid_t, libc::SIGTERM);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        {
            drop(self.stop);
            let _ = self.thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn finds_the_first_executable_and_skips_what_cannot_run() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("aditor-find-{}", std::process::id()));
        let (plain, exec, later) = (base.join("plain"), base.join("exec"), base.join("later"));
        for d in [&plain, &exec, &later] {
            std::fs::create_dir_all(d).unwrap();
        }
        // Not executable, then a directory of the same name, then the real one.
        std::fs::write(plain.join("agent"), "").unwrap();
        std::fs::create_dir_all(exec.join("subdir/agent")).unwrap();
        for d in [&exec, &later] {
            std::fs::write(d.join("agent"), "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(d.join("agent"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dirs = [plain.clone(), exec.join("subdir"), exec.clone(), later.clone()];
        assert_eq!(find_executable("agent", &dirs), Some(exec.join("agent")));
        assert_eq!(find_executable("missing", &dirs), None);

        std::fs::remove_file(plain.join("agent")).unwrap();
        std::fs::remove_dir(exec.join("subdir/agent")).unwrap();
        std::fs::remove_dir(exec.join("subdir")).unwrap();
        for d in [&exec, &later] {
            std::fs::remove_file(d.join("agent")).unwrap();
        }
        for d in [&plain, &exec, &later, &base] {
            std::fs::remove_dir(d).unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn finds_a_program_by_its_pathext_extension() {
        let dir = std::env::temp_dir().join(format!("aditor-find-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent.cmd"), "").unwrap();
        let found = find_executable("agent", std::slice::from_ref(&dir));
        assert_eq!(found, Some(dir.join("agent.cmd")));
        std::fs::remove_file(dir.join("agent.cmd")).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn our_own_process_is_alive_and_a_reaped_one_is_not() {
        assert!(pid_alive(std::process::id()));
        let mut child = Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .args(if cfg!(windows) { &["/C", "exit"][..] } else { &[][..] })
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!pid_alive(pid));
    }

    #[test]
    fn reads_the_script_out_of_an_npm_shim() {
        // What `npm install -g @anthropic-ai/claude-code` writes, trimmed.
        let shim = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n\
            SETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  \
            SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\n\
            endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \
            \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";
        assert_eq!(
            npm_shim_script(shim).as_deref(),
            Some("node_modules\\@anthropic-ai\\claude-code\\cli.js")
        );
        // Older shims spelled it %~dp0.
        let old = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \
            \"%~dp0\\node_modules\\opencode\\bin\\opencode.mjs\" %*\r\n)";
        assert_eq!(
            npm_shim_script(old).as_deref(),
            Some("node_modules\\opencode\\bin\\opencode.mjs")
        );
        assert_eq!(npm_shim_script("@echo off\r\nstart something.exe %*\r\n"), None);
    }

    #[test]
    fn a_program_that_is_no_batch_file_runs_as_itself() {
        let (program, before) = launcher(Path::new("/x/claude.exe"), &[]).unwrap();
        assert_eq!(program, Path::new("/x/claude.exe"));
        assert!(before.is_empty());
    }

    #[test]
    fn path_strings_match_across_spellings_only_on_windows() {
        assert!(same_path("/a/b", "/a/b"));
        assert_eq!(same_path("C:\\Users\\me\\proj", "c:/users/me/proj/"), cfg!(windows));
    }
}
