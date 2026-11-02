//! What differs between macOS, Linux and Windows, behind one set of calls.
//!
//! Everything that needs an OS-specific API -- signals, process handles, file
//! modes, a power assertion -- lives here, so the rest of the backend reads the
//! same on every platform, and porting it is a matter of filling in this file
//! rather than hunting `cfg`s across the crate.
//!
//! macOS is what Aditor ships on. Linux shares its Unix half. Windows compiles,
//! and where its behaviour is not written yet it says so with an error rather
//! than pretending.

use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::Duration;

/// The user's home directory. `HOME` on Unix, falling back to the password
/// database; the profile folder on Windows, which rarely sets `HOME` at all.
pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// The user's shell: `$SHELL`, or the platform's default when it is unset.
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
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    /// Without it, taskkill flashes a console window of its own.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// Keeps the computer from sleeping for as long as it is held.
///
/// On macOS, `caffeinate` holds the power assertions rather than IOKit calls
/// from here: it is on every Mac, and `-w` ties it to our pid, so it lets go
/// when Aditor exits however it exits -- a crash or a force quit included,
/// which no cleanup of ours would see.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct Awake(Child);

impl Awake {
    #[cfg(target_os = "macos")]
    pub fn start() -> Result<Self, String> {
        use std::process::{Command, Stdio};
        // -d display, -i idle, -m disk, -s system (on AC power): the lot, as a
        // "keep awake" switch is expected to mean. -w: only as long as we live.
        Command::new("/usr/bin/caffeinate")
            .args(["-dims", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(Awake)
            .map_err(|e| format!("could not start caffeinate: {e}"))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn start() -> Result<Self, String> {
        Err("Keeping the computer awake is not available on this platform yet.".to_string())
    }

    /// Still holding, unless whatever holds it has died behind our back.
    pub fn holding(&mut self) -> bool {
        matches!(self.0.try_wait(), Ok(None))
    }

    pub fn release(mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

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
}
