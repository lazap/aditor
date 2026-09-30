//! Switching the Claude Code login without disturbing the running session.
//!
//! Two things identify an account and they live apart: the OAuth credential,
//! which is what actually authenticates (macOS keeps it in the login Keychain,
//! every other platform in a file), and `oauthAccount` in `~/.claude.json`,
//! which is the identity the agent displays and bills against. A switch moves
//! both and touches nothing else -- not the transcripts, not the session
//! registry, not the PTY. The conversation surviving the switch is the point.
//!
//! The shapes below -- keychain item names, lock paths and their staleness
//! budgets, the order the two credential locks are taken in -- mirror Claude
//! Code's own implementation. They are a protocol we are joining, not choices
//! we are free to make: getting them wrong races a live token refresh and
//! destroys the outgoing account's refresh token.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------- shapes ---

/// One saved login. Deliberately carries no credential: the store holds live
/// OAuth tokens, and nothing that could re-authenticate crosses the IPC
/// boundary -- the same discipline `agents::usage_limits` documents for the
/// account identity it reads out of the same file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    uuid: String,
    email: String,
    label: String,
    added_at: i64,
    is_active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    /// False for a setup we cannot switch safely -- a state, not an error.
    supported: bool,
    /// Why, when `supported` is false. Shown to the user verbatim.
    reason: Option<String>,
    active_uuid: Option<String>,
    active_email: Option<String>,
    /// True when the live login is not one of the saved ones, so the UI can
    /// offer to save it before the next switch overwrites it.
    active_saved: bool,
    /// Where the live credential lives, named for the user.
    store: String,
    /// How long a running agent can take to notice a swap. macOS caches
    /// Keychain reads for about 30s; the file stores are read per request, so
    /// the switch lands on the agent's next message.
    settle_seconds: u32,
    accounts: Vec<Account>,
}

impl Accounts {
    fn unsupported(reason: String) -> Self {
        Accounts {
            supported: false,
            reason: Some(reason),
            active_uuid: None,
            active_email: None,
            active_saved: false,
            store: store_label().to_string(),
            settle_seconds: settle_seconds(),
            accounts: Vec::new(),
        }
    }
}

/// The roster. Order is display order; nothing secret lives here.
#[derive(Serialize, Deserialize, Default)]
struct Index {
    accounts: Vec<Entry>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Entry {
    uuid: String,
    email: String,
    label: String,
    added_at: i64,
}

/// A saved slot: the credential exactly as the live store held it, plus the
/// identity keys that travel with the account.
///
/// `credential` is stored byte for byte and never parsed. Its internal shape is
/// Claude Code's business; treating it as an opaque payload is what keeps this
/// working when that shape changes.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Slot {
    credential: String,
    oauth_account: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cached_usage_utilization: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trusted_device_token: Option<Value>,
}

// ----------------------------------------------------------------- paths ---

pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Claude Code's config home. Mirrors its own resolution: `CLAUDE_CONFIG_DIR`
/// when set, else `~/.claude`.
fn config_home() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => Some(home()?.join(".claude")),
    }
}

/// The global config file. Note the asymmetry Claude Code carries: the legacy
/// `<config-home>/.config.json` wins when it exists, but the modern path is
/// `.claude.json` at the *home* directory, not inside `.claude/`.
fn global_config() -> Option<PathBuf> {
    let legacy = config_home()?.join(".config.json");
    if legacy.exists() {
        return Some(legacy);
    }
    Some(home()?.join(".claude.json"))
}

#[cfg(not(target_os = "macos"))]
fn credentials_file() -> Option<PathBuf> {
    Some(config_home()?.join(".credentials.json"))
}

/// Why this machine cannot be switched, if it cannot.
///
/// A custom `CLAUDE_CONFIG_DIR` changes the Keychain service name to a hash of
/// the raw env value, and `agents.rs` already assumes the default config home
/// throughout. Refusing loudly beats writing a credential to the wrong item.
fn unsupported_reason() -> Option<String> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => Some(format!(
            "CLAUDE_CONFIG_DIR is set ({}), which Aditor cannot switch yet.",
            dir.to_string_lossy()
        )),
        _ => None,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ----------------------------------------------------------------- locks ---

// Claude Code guards its token refresh and its config writes with npm
// `proper-lockfile`: the lock artifact is a *directory*, and mkdir atomicity is
// the mutex. These budgets are its, not ours -- a credential lock younger than
// 60s belongs to a live holder whose toucher may simply have stalled (suspend,
// a blocked event loop), and stealing it would let two writers run at once.
const CREDENTIAL_STALENESS: Duration = Duration::from_secs(60);
const CONFIG_STALENESS: Duration = Duration::from_secs(10);
/// How often a held lock is touched -- a little faster than Claude Code's 5s,
/// for margin. Not a release latency: `Lock::drop` wakes the toucher rather
/// than waiting the period out.
const TOUCH_INTERVAL: Duration = Duration::from_secs(3);
/// Per lock. Claude Code holds the credential lock for one token-endpoint round
/// trip and the config lock for a local read-modify-write, so this outlasts
/// both without hanging the panel forever.
const LOCK_TIMEOUT: Duration = Duration::from_secs(9);

/// A held `proper-lockfile` directory lock, released on drop.
///
/// Drop is the only release path that matters: the crate builds with
/// `panic = "abort"`, so nothing else unwinds. Keep locked sections short.
struct Lock {
    dir: PathBuf,
    stop: Option<Sender<()>>,
    toucher: Option<JoinHandle<()>>,
}

/// Bump a lock directory's mtime without a `utime` binding: creating and
/// removing an entry inside a directory updates that directory's mtime on
/// every platform we ship to.
fn touch(dir: &Path) -> bool {
    let probe = dir.join(".touch");
    let _ = fs::remove_file(&probe);
    fs::File::create(&probe).is_ok()
}

/// Cheap jitter so two waiters do not retry in lockstep. A lock loop does not
/// need a real RNG, and the crate does not carry one.
fn jitter_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.subsec_nanos() / 1_000_000) as u64 % 250)
        .unwrap_or(0)
}

fn acquire(dir: PathBuf, staleness: Duration, timeout: Duration) -> Result<Lock, String> {
    acquire_every(dir, staleness, timeout, TOUCH_INTERVAL)
}

/// `acquire` with the touch period spelled out, so a test can watch the toucher
/// keep a lock alive without waiting out the protocol's own interval.
fn acquire_every(
    dir: PathBuf,
    staleness: Duration,
    timeout: Duration,
    touch_every: Duration,
) -> Result<Lock, String> {
    if let Some(parent) = dir.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let start = Instant::now();
    loop {
        match fs::create_dir(&dir) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("could not create {}: {e}", dir.display())),
        }
        if start.elapsed() > timeout {
            return Err(format!(
                "{} stayed locked -- Claude Code looks busy refreshing credentials. \
                 Try again in a few seconds.",
                dir.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
        // A holder that has not touched the lock within its staleness budget is
        // dead by the protocol, so take it over. Losing the rmdir/mkdir race to
        // another waiter just means going round again.
        match fs::metadata(&dir).and_then(|m| m.modified()) {
            Ok(held) => {
                if held.elapsed().map(|e| e > staleness).unwrap_or(false) {
                    let _ = fs::remove_file(dir.join(".touch"));
                    if fs::remove_dir(&dir).is_err() {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    continue;
                }
            }
            // Released between our mkdir and our stat; retry immediately.
            Err(_) => continue,
        }
        std::thread::sleep(Duration::from_millis(250 + jitter_ms()));
    }

    let (tx, rx) = channel::<()>();
    let held = dir.clone();
    let toucher = std::thread::spawn(move || {
        loop {
            // A wait rather than a sleep: `Lock::drop` drops the sender, which
            // wakes this immediately. Sleeping the period out and only then
            // checking made every release cost up to `touch_every` -- three
            // locks per switch, so seconds of frozen UI for no work at all.
            match rx.recv_timeout(touch_every) {
                // Still held; keep it looking alive.
                Err(RecvTimeoutError::Timeout) => {}
                // Released, or the holder is gone. Either way, done.
                Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            }
            // Gone means taken over as stale; there is nothing left to keep alive.
            if !touch(&held) {
                return;
            }
        }
    });

    Ok(Lock {
        dir,
        stop: Some(tx),
        toucher: Some(toucher),
    })
}

impl Drop for Lock {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(t) = self.toucher.take() {
            let _ = t.join();
        }
        let _ = fs::remove_file(self.dir.join(".touch"));
        let _ = fs::remove_dir(&self.dir);
    }
}

/// Claude Code's credential-refresh locks, in its own order: the primary
/// `.oauth_refresh.lock` first, then the legacy `~/.claude.lock` it still takes
/// for compatibility. Mirroring both the pair and the order is what keeps a
/// waiting Aditor and a waiting Claude Code from deadlocking on each other.
///
/// Holding these is not ceremony. A refresh reads the credential, goes to the
/// network and saves, all under these locks; a swap landing inside that window
/// gets overwritten by the refreshed *old* token, and the backup we just took
/// keeps a refresh token that has already been rotated away. Under the lock,
/// Claude Code's re-read sees the swapped credential and abandons the refresh.
fn credential_locks() -> Result<(Lock, Lock), String> {
    let home = config_home().ok_or_else(|| "no home directory".to_string())?;
    let primary = acquire(
        home.join(".oauth_refresh.lock"),
        CREDENTIAL_STALENESS,
        LOCK_TIMEOUT,
    )?;
    let legacy = acquire(
        home.with_file_name(format!(
            "{}.lock",
            home.file_name().unwrap_or_default().to_string_lossy()
        )),
        CREDENTIAL_STALENESS,
        LOCK_TIMEOUT,
    )?;
    Ok((primary, legacy))
}

fn config_lock() -> Result<Lock, String> {
    let path = global_config().ok_or_else(|| "no home directory".to_string())?;
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    acquire(
        path.with_file_name(format!("{name}.lock")),
        CONFIG_STALENESS,
        LOCK_TIMEOUT,
    )
}

// ------------------------------------------------- live credential store ---

/// Read the credential Claude Code is using right now. `Ok(None)` means there
/// is genuinely no stored login; an unreadable store is an `Err`, because
/// conflating the two would let a switch overwrite a login we failed to back up.
fn live_read() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        keychain_read()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let path = credentials_file().ok_or_else(|| "no home directory".to_string())?;
        match fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("could not read {}: {e}", path.display())),
        }
    }
}

fn live_write(credential: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        keychain_write(credential)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let path = credentials_file().ok_or_else(|| "no home directory".to_string())?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        write_private(&path, credential.as_bytes())
    }
}

/// The live OAuth access token, for `agents::agent_refresh_limits` -- the one
/// place a credential leaves this process, and only in a request to Anthropic.
/// It never crosses the IPC boundary.
///
/// Read only, so an expired token is reported rather than refreshed: rotating
/// it is Claude Code's job, and doing it here would race Claude Code's own
/// refresh and could invalidate the refresh token it holds.
pub(crate) fn live_access_token() -> Result<String, String> {
    if let Some(reason) = unsupported_reason() {
        return Err(reason);
    }
    // Held so the read cannot land halfway through a switch.
    let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
    let raw = live_read()?.ok_or_else(|| "Not signed in to Claude Code.".to_string())?;
    let v: Value = serde_json::from_str(&raw)
        .map_err(|_| "The stored Claude Code login is unreadable.".to_string())?;
    let oauth = &v["claudeAiOauth"];
    if oauth["expiresAt"].as_i64().is_some_and(|t| t <= now_ms()) {
        return Err("The Claude Code login token has expired. Send a message in Claude to renew it, then refresh.".into());
    }
    oauth["accessToken"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Claude Code isn't signed in with a Claude account.".to_string())
}

/// How long a running agent can take to pick a swap up. Claude Code caches
/// Keychain reads for about 30s; a file store is read per request.
fn settle_seconds() -> u32 {
    if cfg!(target_os = "macos") { 30 } else { 0 }
}

/// Where Claude Code's credential lives, for the UI to state plainly.
fn store_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else {
        "~/.claude/.credentials.json"
    }
}

// ---- macOS: the `security` CLI ----
//
// Deliberately the CLI and not an in-process Security.framework call (nor a
// crate wrapping one). A Keychain item's access is anchored to the *binary*
// that touches it, and `cargo tauri dev` rebuilds this binary constantly -- an
// in-process call would raise the "wants to use your keychain" panel on every
// rebuild. `/usr/bin/security` never changes, so creator and reader are the
// same stable binary and nothing is ever prompted. claude-swap moved off the
// `keyring` package for exactly this reason.

#[cfg(target_os = "macos")]
mod keychain {
    use super::*;
    use std::process::{Command, Stdio};

    /// Claude Code's own OAuth item, which it reads and we swap.
    pub const SERVICE: &str = "Claude Code-credentials";
    /// `errSecItemNotFound`, as `security` surfaces it.
    const NOT_FOUND: i32 = 44;
    /// `security -i` reads stdin through a 4096-byte fgets buffer and truncates
    /// mid-argument past it -- which fails the write while leaving the previous
    /// item intact (claude-code #30337). Headroom for line-ending accounting.
    const STDIN_LINE_LIMIT: usize = 4096 - 64;
    const TIMEOUT: Duration = Duration::from_secs(5);
    /// Pinned, not resolved through PATH: this handles credentials, so a
    /// `security` planted earlier on PATH must not get to intercept them.
    const SECURITY: &str = "/usr/bin/security";

    /// Mirrors Claude Code's `getUsername()`. Matching it exactly matters on
    /// hosts where `$USER` is unset -- a different default would key a
    /// different item, and the two would not see each other's credential.
    pub fn account() -> String {
        if let Some(u) = std::env::var_os("USER") {
            if !u.is_empty() {
                return u.to_string_lossy().to_string();
            }
        }
        if let Some(u) = std::env::var_os("LOGNAME") {
            if !u.is_empty() {
                return u.to_string_lossy().to_string();
            }
        }
        "claude-code-user".to_string()
    }

    fn hex(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    /// `security -i` re-parses each line shell-style, so values need quoting --
    /// the service name contains a space.
    fn quote(v: &str) -> String {
        format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
    }

    struct Out {
        code: i32,
        stdout: String,
        stderr: String,
    }

    /// Run `security`, bounded. std has no wait-with-timeout, so the wait
    /// happens on a thread: a wedged login Keychain then surfaces as an error
    /// instead of hanging the command that is holding Claude Code's locks.
    fn run(args: Vec<String>, stdin: Option<String>) -> Result<Out, String> {
        let mut cmd = Command::new(SECURITY);
        cmd.args(&args)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("could not run security: {e}"))?;
        if let Some(data) = stdin {
            child
                .stdin
                .take()
                .ok_or_else(|| "security stdin unavailable".to_string())?
                .write_all(data.as_bytes())
                .map_err(|e| format!("could not write to security: {e}"))?;
        }
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        match rx.recv_timeout(TIMEOUT) {
            Ok(Ok(out)) => Ok(Out {
                code: out.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            }),
            Ok(Err(e)) => Err(format!("security failed: {e}")),
            Err(_) => Err("security timed out -- is the login keychain locked?".into()),
        }
    }

    pub fn read() -> Result<Option<String>, String> {
        let acct = account();
        let out = run(
            vec![
                "find-generic-password".into(),
                "-a".into(),
                acct,
                "-w".into(),
                "-s".into(),
                SERVICE.into(),
            ],
            None,
        )?;
        match out.code {
            0 => Ok(Some(out.stdout.strip_suffix('\n').unwrap_or(&out.stdout).to_string())),
            NOT_FOUND => Ok(None),
            c => Err(format!(
                "keychain read failed (rc={c}): {}",
                out.stderr.trim()
            )),
        }
    }

    pub fn write(credential: &str) -> Result<(), String> {
        let acct = account();
        // `-U` updates the existing item in place, which preserves the access
        // list Claude Code holds on it. Deleting and re-adding would hand the
        // item a fresh ACL that excludes Claude Code.
        let value = hex(credential.as_bytes());
        let line = format!(
            "add-generic-password -U -a {} -s {} -X {value}\n",
            quote(&acct),
            quote(SERVICE)
        );
        // Prefer stdin so the secret never lands in argv, where any process
        // listing would show it. Past the line buffer that would corrupt the
        // write, so fall back to argv -- hex there still defeats a plaintext
        // scan, and silent corruption is strictly worse.
        let out = if line.len() <= STDIN_LINE_LIMIT {
            run(vec!["-i".into()], Some(line))?
        } else {
            run(
                vec![
                    "add-generic-password".into(),
                    "-U".into(),
                    "-a".into(),
                    acct,
                    "-s".into(),
                    SERVICE.into(),
                    "-X".into(),
                    value,
                ],
                None,
            )?
        };
        if out.code != 0 {
            return Err(format!(
                "keychain write failed (rc={}): {}",
                out.code,
                out.stderr.trim()
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn keychain_read() -> Result<Option<String>, String> {
    keychain::read()
}

#[cfg(target_os = "macos")]
fn keychain_write(credential: &str) -> Result<(), String> {
    keychain::write(credential)
}

// ----------------------------------------------------- atomic private io ---

/// Write via a temp file in the same directory and rename over the target, so
/// a reader never sees a half-written file. Owner-only from the moment it
/// exists -- these files hold live OAuth tokens.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "no parent directory".to_string())?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        set_private(&f)?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not write {}: {e}", path.display())
    })
}

#[cfg(unix)]
fn set_private(f: &fs::File) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    f.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_private(_f: &fs::File) -> Result<(), String> {
    // Windows has no mode bits to set; the file inherits the user's profile ACL.
    Ok(())
}

/// Rewrite an existing file in place, keeping whatever mode it already had.
/// Used for `~/.claude.json`, which is Claude Code's file, not ours.
fn rewrite_preserving_mode(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "no parent directory".to_string())?;
    let tmp = dir.join(format!(
        ".{}.aditor.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        if let Ok(meta) = fs::metadata(path) {
            let _ = f.set_permissions(meta.permissions());
        } else {
            set_private(&f)?;
        }
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not write {}: {e}", path.display())
    })
}

// ----------------------------------------------------------- aditor store ---

/// Aditor's saved logins live in `~/.aditor`, not the platform config
/// directory: this is a store people expect to find, back up and carry between
/// machines, the way `cswap` keeps `~/.claude-swap-backup`.
fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = aditor_dir()?.join("accounts");

    // One-time move from where the store used to live. Skipped the moment the
    // new location exists, so it costs a `stat` per call and nothing else.
    if !dir.exists() {
        if let Ok(previous) = app.path().app_config_dir() {
            migrate_store(&previous.join("accounts"), &dir)?;
        }
    }

    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// `~/.aditor`, created and closed to the owner.
///
/// Shared with `settings.rs` so there is one answer to where Aditor's own store
/// lives. The mode matters here and not only in the slot files: the accounts
/// roster next door is not something to leave world-readable.
pub(crate) fn aditor_dir() -> Result<PathBuf, String> {
    let root = home().ok_or_else(|| "no home directory".to_string())?.join(".aditor");
    fs::create_dir_all(&root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    restrict_dir(&root);
    Ok(root)
}

/// Move a previous store into place, if there is one and nothing is there yet.
///
/// A rename rather than a copy: the files hold live OAuth tokens, and leaving a
/// second readable copy behind would be worse than not moving them at all. Both
/// paths sit under the home directory, so this stays within one filesystem.
fn migrate_store(previous: &Path, dir: &Path) -> Result<(), String> {
    if dir.exists() || !previous.is_dir() {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    fs::rename(previous, dir).map_err(|e| {
        format!(
            "could not move the saved accounts from {} to {}: {e}",
            previous.display(),
            dir.display()
        )
    })
}

#[cfg(unix)]
fn restrict_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_dir(_dir: &Path) {
    // Windows has no mode bits; the directory inherits the user's profile ACL.
}

fn read_index(dir: &Path) -> Index {
    fs::read_to_string(dir.join("index.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_index(dir: &Path, index: &Index) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    write_private(&dir.join("index.json"), &bytes)
}

/// Slot files are named by account uuid, which comes from Claude Code rather
/// than from us, so it is checked before it reaches the filesystem.
fn slot_path(dir: &Path, uuid: &str) -> Result<PathBuf, String> {
    if uuid.is_empty()
        || !uuid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("unrecognized account id".to_string());
    }
    Ok(dir.join(format!("{uuid}.json")))
}

fn read_slot(dir: &Path, uuid: &str) -> Result<Slot, String> {
    let path = slot_path(dir, uuid)?;
    let text = fs::read_to_string(&path)
        .map_err(|_| "that account is no longer saved on this machine".to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("saved account is unreadable: {e}"))
}

fn write_slot(dir: &Path, uuid: &str, slot: &Slot) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(slot).map_err(|e| e.to_string())?;
    write_private(&slot_path(dir, uuid)?, &bytes)
}

// ------------------------------------------------------- claude.json edit ---

fn read_config() -> Result<Option<Map<String, Value>>, String> {
    let path = global_config().ok_or_else(|| "no home directory".to_string())?;
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        // A torn or non-object config is not an empty one. Callers salvage it
        // rather than writing through it.
        _ => Ok(None),
    }
}

fn identity_of(config: &Map<String, Value>, key: &str) -> Option<Value> {
    config.get(key).cloned()
}

fn account_uuid(config: &Map<String, Value>) -> Option<String> {
    config
        .get("oauthAccount")?
        .get("accountUuid")?
        .as_str()
        .map(str::to_string)
}

fn account_email(config: &Map<String, Value>) -> Option<String> {
    config
        .get("oauthAccount")?
        .get("emailAddress")?
        .as_str()
        .map(str::to_string)
}

/// Replace only the identity keys, leaving every other key -- and its position
/// -- exactly as it was. `serde_json`'s `preserve_order` is what makes the
/// second half of that true; without it this would reorder the whole file.
///
/// A key the incoming account does not carry is removed rather than left
/// behind, because the value sitting there belongs to the account we are
/// leaving.
///
/// Three keys travel with the slot. `oauthAccount` is the identity itself.
/// `trustedDeviceToken` is enrolled per (device, account) at `/login`, so it
/// belongs to the account rather than the machine. `cachedUsageUtilization` is
/// account-wide, and leaving the outgoing account's copy behind would make the
/// panel's limit meters describe the wrong account until Claude Code next
/// refreshes them.
fn splice_identity(config: &mut Map<String, Value>, slot: &Slot) {
    let incoming: [(&str, Option<Value>); 3] = [
        ("oauthAccount", Some(slot.oauth_account.clone())),
        ("cachedUsageUtilization", slot.cached_usage_utilization.clone()),
        ("trustedDeviceToken", slot.trusted_device_token.clone()),
    ];
    for (key, value) in incoming {
        match value {
            Some(v) => {
                config.insert(key.to_string(), v);
            }
            None => {
                config.remove(key);
            }
        }
    }
}

/// Move a config we could not parse aside before replacing it, so a torn file
/// is never simply overwritten.
fn salvage(path: &Path) {
    let aside = path.with_file_name(format!(
        "{}.aditor-salvaged.{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        now_ms()
    ));
    let _ = fs::rename(path, aside);
}

// -------------------------------------------------------------- capture ---

/// Pair a credential with the identity keys sitting beside it in the config.
fn slot_from(credential: String, config: Option<&Map<String, Value>>) -> Slot {
    let get = |k: &str| config.and_then(|c| identity_of(c, k));
    Slot {
        credential,
        oauth_account: get("oauthAccount").unwrap_or(Value::Null),
        cached_usage_utilization: get("cachedUsageUtilization"),
        trusted_device_token: get("trustedDeviceToken"),
    }
}

/// The live login, as a slot. Call under the credential locks: a credential
/// read that races a refresh can return a token that is already being rotated
/// away.
///
/// `None` means there is nothing identifiable to save -- no credential, or no
/// `oauthAccount` to say whose it is.
fn capture_live() -> Result<Option<(String, Entry, Slot)>, String> {
    let credential = match live_read()? {
        Some(c) => c,
        None => return Ok(None),
    };
    let config = match read_config()? {
        Some(c) => c,
        None => return Ok(None),
    };
    let uuid = match account_uuid(&config) {
        Some(u) => u,
        None => return Ok(None),
    };
    let email = account_email(&config).unwrap_or_else(|| "unknown".to_string());
    let entry = Entry {
        uuid: uuid.clone(),
        email: email.clone(),
        label: email,
        added_at: now_ms(),
    };
    Ok(Some((uuid, entry, slot_from(credential, Some(&config)))))
}

/// File the outgoing login back into its own slot before it is overwritten.
///
/// Refresh tokens rotate, so a slot captured once goes stale and its login
/// dies. This runs on every switch, and only into the slot the live identity
/// actually names: if someone changed the login behind us, the bytes belong to
/// a different account and writing them into the slot we *thought* was active
/// would destroy that account's token instead of saving this one. Unmatched
/// bytes are stashed rather than dropped.
fn recapture_outgoing(dir: &Path, index: &Index) -> Result<(), String> {
    let credential = match live_read()? {
        Some(c) => c,
        None => return Ok(()),
    };
    let config = read_config()?;
    let uuid = config.as_ref().and_then(account_uuid);
    let slot = slot_from(credential, config.as_ref());

    // Into its own slot only when the live identity names a slot we hold.
    if let Some(uuid) = uuid.as_ref() {
        if index.accounts.iter().any(|a| &a.uuid == uuid) {
            return write_slot(dir, uuid, &slot);
        }
    }

    // Anything else -- an account never saved here, or a config too damaged to
    // say whose credential this is -- gets stashed. The bytes are somebody's
    // working login and the switch is about to overwrite them; guessing a slot
    // would destroy that account's token instead of this one's.
    let stash = dir.join("unsaved");
    fs::create_dir_all(&stash).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&slot).map_err(|e| e.to_string())?;
    let name = uuid.unwrap_or_else(|| "unidentified".to_string());
    let name = if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        name
    } else {
        "unidentified".to_string()
    };
    write_private(&stash.join(format!("{name}-{}.json", now_ms())), &bytes)
}

// ------------------------------------------------------------- commands ---

/// One account operation at a time.
///
/// The lock directories guard against *other* processes. This guards against
/// two of our own commands interleaving the halves they do outside those locks
/// -- `save`'s index write, `forget`'s slot removal -- which running on the
/// main thread used to prevent for free.
static GATE: Mutex<()> = Mutex::new(());

/// Run an account operation off the UI thread.
///
/// A synchronous `#[tauri::command]` is called inline by Tauri's IPC handler,
/// which on macOS is the main thread: everything below spawns `security`,
/// fsyncs, and can sit on Claude Code's locks for `LOCK_TIMEOUT`, none of which
/// the window can afford to wait for. The work itself stays blocking -- it is
/// filesystem and subprocess work, not async work -- so it goes to the blocking
/// pool rather than onto the runtime's worker threads.
async fn off_thread<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        f()
    })
    .await
    .map_err(|e| format!("the account operation did not finish: {e}"))?
}

#[tauri::command]
pub async fn claude_accounts(app: AppHandle) -> Result<Accounts, String> {
    off_thread(move || accounts_blocking(app)).await
}

fn accounts_blocking(app: AppHandle) -> Result<Accounts, String> {
    if let Some(reason) = unsupported_reason() {
        return Ok(Accounts::unsupported(reason));
    }
    let dir = store_dir(&app)?;
    let index = read_index(&dir);
    let config = read_config()?;
    let active_uuid = config.as_ref().and_then(account_uuid);
    let active_email = config.as_ref().and_then(account_email);
    let active_saved = active_uuid
        .as_ref()
        .map(|u| index.accounts.iter().any(|a| &a.uuid == u))
        .unwrap_or(false);

    Ok(Accounts {
        supported: true,
        reason: None,
        accounts: index
            .accounts
            .iter()
            .map(|a| Account {
                uuid: a.uuid.clone(),
                email: a.email.clone(),
                label: a.label.clone(),
                added_at: a.added_at,
                is_active: Some(&a.uuid) == active_uuid.as_ref(),
            })
            .collect(),
        active_uuid,
        active_email,
        active_saved,
        store: store_label().to_string(),
        settle_seconds: settle_seconds(),
    })
}

/// Save whichever account is logged in right now, or refresh the copy we
/// already hold for it.
#[tauri::command]
pub async fn claude_account_save(app: AppHandle) -> Result<Account, String> {
    off_thread(move || save_blocking(app)).await
}

fn save_blocking(app: AppHandle) -> Result<Account, String> {
    if let Some(reason) = unsupported_reason() {
        return Err(reason);
    }
    let dir = store_dir(&app)?;
    let (uuid, entry, slot) = {
        let _locks = credential_locks()?;
        capture_live()?.ok_or_else(|| {
            format!(
                "No Claude Code login found in the {}. Run `claude /login` first.",
                store_label()
            )
        })?
    };
    write_slot(&dir, &uuid, &slot)?;

    let mut index = read_index(&dir);
    // Keep the label the user gave this account; only the credential is new.
    let label = match index.accounts.iter_mut().find(|a| a.uuid == uuid) {
        Some(existing) => {
            existing.email = entry.email.clone();
            existing.label.clone()
        }
        None => {
            index.accounts.push(entry.clone());
            entry.label.clone()
        }
    };
    write_index(&dir, &index)?;

    Ok(Account {
        uuid,
        email: entry.email,
        label,
        added_at: entry.added_at,
        is_active: true,
    })
}

/// Swap the login underneath a running agent.
///
/// Nothing here touches the PTY, the transcripts or the session registry: the
/// agent keeps running, and picks the new account up on its next token read.
#[tauri::command]
pub async fn claude_account_switch(app: AppHandle, uuid: String) -> Result<(), String> {
    off_thread(move || switch_blocking(app, uuid)).await
}

fn switch_blocking(app: AppHandle, uuid: String) -> Result<(), String> {
    if let Some(reason) = unsupported_reason() {
        return Err(reason);
    }
    let dir = store_dir(&app)?;
    let index = read_index(&dir);
    // Read the target first: failing here leaves the live login untouched.
    let target = read_slot(&dir, &uuid)?;
    if target.oauth_account.is_null() {
        return Err("that saved account has no identity to switch to".to_string());
    }

    {
        let _locks = credential_locks()?;
        recapture_outgoing(&dir, &index)?;
        live_write(&target.credential)?;
    }

    let path = global_config().ok_or_else(|| "no home directory".to_string())?;
    let _lock = config_lock()?;
    match read_config()? {
        Some(mut config) => {
            splice_identity(&mut config, &target);
            let bytes = serde_json::to_vec_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
            rewrite_preserving_mode(&path, &bytes)?;
        }
        None => {
            // Unreadable or absent. Never assign through it -- put whatever was
            // there aside, then write a config carrying just the identity.
            if path.exists() {
                salvage(&path);
            }
            let mut fresh = Map::new();
            splice_identity(&mut fresh, &target);
            let bytes = serde_json::to_vec_pretty(&Value::Object(fresh)).map_err(|e| e.to_string())?;
            rewrite_preserving_mode(&path, &bytes)?;
        }
    }

    let _ = app.emit("agents://changed", ());
    Ok(())
}

#[tauri::command]
pub async fn claude_account_rename(
    app: AppHandle,
    uuid: String,
    label: String,
) -> Result<(), String> {
    off_thread(move || rename_blocking(app, uuid, label)).await
}

fn rename_blocking(app: AppHandle, uuid: String, label: String) -> Result<(), String> {
    let dir = store_dir(&app)?;
    let mut index = read_index(&dir);
    let entry = index
        .accounts
        .iter_mut()
        .find(|a| a.uuid == uuid)
        .ok_or_else(|| "that account is no longer saved on this machine".to_string())?;
    let trimmed = label.trim();
    entry.label = if trimmed.is_empty() {
        entry.email.clone()
    } else {
        trimmed.to_string()
    };
    write_index(&dir, &index)
}

/// Drop a saved account. The stored credential is the only copy Aditor holds,
/// so forgetting the active one leaves the machine logged in but unable to
/// come back to it without `/login`.
#[tauri::command]
pub async fn claude_account_forget(app: AppHandle, uuid: String) -> Result<(), String> {
    off_thread(move || forget_blocking(app, uuid)).await
}

fn forget_blocking(app: AppHandle, uuid: String) -> Result<(), String> {
    let dir = store_dir(&app)?;
    let mut index = read_index(&dir);
    index.accounts.retain(|a| a.uuid != uuid);
    write_index(&dir, &index)?;
    let _ = fs::remove_file(slot_path(&dir, &uuid)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aditor-accounts-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn slot_with(oauth: Value, usage: Option<Value>, device: Option<Value>) -> Slot {
        Slot {
            credential: "opaque".into(),
            oauth_account: oauth,
            cached_usage_utilization: usage,
            trusted_device_token: device,
        }
    }

    /// The config is Claude Code's file, full of keys we know nothing about.
    /// A switch must leave every one of them -- and its position -- alone.
    #[test]
    fn splice_keeps_every_other_key_and_its_position() {
        let source = r#"{
            "numStartups": 41,
            "oauthAccount": {"accountUuid": "old", "emailAddress": "old@example.com"},
            "projects": {"/tmp/x": {"allowedTools": []}},
            "cachedUsageUtilization": {"fetchedAtMs": 1},
            "mcpServers": {"keep": {"command": "x"}}
        }"#;
        let mut config = match serde_json::from_str::<Value>(source).unwrap() {
            Value::Object(m) => m,
            _ => panic!("fixture is an object"),
        };
        let before: Vec<String> = config.keys().cloned().collect();

        splice_identity(
            &mut config,
            &slot_with(
                serde_json::json!({"accountUuid": "new", "emailAddress": "new@example.com"}),
                Some(serde_json::json!({"fetchedAtMs": 2})),
                None,
            ),
        );

        assert_eq!(config.keys().cloned().collect::<Vec<_>>(), before);
        assert_eq!(account_uuid(&config).as_deref(), Some("new"));
        assert_eq!(config["numStartups"], serde_json::json!(41));
        assert_eq!(config["mcpServers"]["keep"]["command"], serde_json::json!("x"));
        assert_eq!(config["projects"]["/tmp/x"]["allowedTools"], serde_json::json!([]));
    }

    /// A key the incoming account does not carry belongs to the account we are
    /// leaving, so it goes rather than lingering under a new identity.
    #[test]
    fn splice_removes_keys_the_incoming_account_lacks() {
        let mut config = match serde_json::from_str::<Value>(
            r#"{"oauthAccount": {"accountUuid": "old"}, "trustedDeviceToken": "device-of-old"}"#,
        )
        .unwrap()
        {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        splice_identity(
            &mut config,
            &slot_with(serde_json::json!({"accountUuid": "new"}), None, None),
        );
        assert!(!config.contains_key("trustedDeviceToken"));
        assert!(!config.contains_key("cachedUsageUtilization"));
    }

    #[test]
    fn splice_into_an_empty_config_writes_only_identity() {
        let mut config = Map::new();
        splice_identity(
            &mut config,
            &slot_with(serde_json::json!({"accountUuid": "new"}), None, None),
        );
        assert_eq!(config.keys().collect::<Vec<_>>(), vec!["oauthAccount"]);
    }

    #[test]
    fn lock_is_released_on_drop() {
        let dir = scratch("release").join("x.lock");
        {
            let _held = acquire(dir.clone(), CONFIG_STALENESS, LOCK_TIMEOUT).unwrap();
            assert!(dir.is_dir(), "lock directory should exist while held");
        }
        assert!(!dir.exists(), "lock directory should be gone after drop");
    }

    #[test]
    fn a_held_lock_blocks_a_second_holder() {
        let dir = scratch("blocks").join("x.lock");
        let _held = acquire(dir.clone(), CONFIG_STALENESS, LOCK_TIMEOUT).unwrap();
        match acquire(dir.clone(), CONFIG_STALENESS, Duration::from_millis(150)) {
            Ok(_) => panic!("a live lock must not be taken over"),
            Err(e) => assert!(e.contains("locked"), "unexpected message: {e}"),
        }
    }

    /// Releasing has to be immediate. A toucher that checked its stop channel
    /// only after sleeping made every release wait the period out, and a switch
    /// takes three locks -- which is what froze the window for seconds.
    #[test]
    fn releasing_a_lock_does_not_wait_for_the_touch_period() {
        let dir = scratch("release-fast").join("x.lock");
        let start = Instant::now();
        drop(acquire(dir, CONFIG_STALENESS, LOCK_TIMEOUT).unwrap());
        let took = start.elapsed();
        assert!(
            took < TOUCH_INTERVAL / 4,
            "releasing took {took:?}; a release must not wait on the touch period"
        );
    }

    /// The other half of that: a lock held longer than its touch period must
    /// keep looking alive, or the next waiter takes it over as stale.
    #[test]
    fn a_held_lock_keeps_being_touched() {
        let dir = scratch("touched").join("x.lock");
        let every = Duration::from_millis(50);
        let _held = acquire_every(dir.clone(), CONFIG_STALENESS, LOCK_TIMEOUT, every).unwrap();
        let first = fs::metadata(&dir).unwrap().modified().unwrap();
        std::thread::sleep(every * 4);
        let later = fs::metadata(&dir).unwrap().modified().unwrap();
        assert!(later > first, "a held lock must keep its mtime moving");
    }

    /// The protocol's escape hatch: a holder that died without releasing must
    /// not wedge the lock forever.
    #[test]
    fn a_stale_lock_is_taken_over() {
        let dir = scratch("stale").join("x.lock");
        fs::create_dir_all(&dir).unwrap();
        let taken = acquire(dir.clone(), Duration::ZERO, Duration::from_millis(500));
        assert!(taken.is_ok(), "a stale lock should be taken over, not waited on");
    }

    /// A credential whose owner we cannot name is still somebody's working
    /// login. It has to survive the switch that is about to overwrite it, even
    /// when the config beside it is missing or torn.
    #[test]
    fn an_unidentifiable_credential_is_still_carried() {
        let slot = slot_from("opaque-token".into(), None);
        assert_eq!(slot.credential, "opaque-token");
        assert_eq!(slot.oauth_account, Value::Null);
        assert!(slot.cached_usage_utilization.is_none());
        assert!(slot.trusted_device_token.is_none());
    }

    #[test]
    fn a_previous_store_is_moved_not_copied() {
        let base = scratch("migrate");
        let previous = base.join("old/accounts");
        fs::create_dir_all(&previous).unwrap();
        fs::write(previous.join("index.json"), b"{}").unwrap();

        let dir = base.join("new/accounts");
        migrate_store(&previous, &dir).unwrap();

        assert!(dir.join("index.json").is_file(), "accounts should have moved");
        assert!(!previous.exists(), "tokens must not be left behind in a second copy");
    }

    #[test]
    fn migration_never_overwrites_an_existing_store() {
        let base = scratch("migrate-keep");
        let previous = base.join("old/accounts");
        fs::create_dir_all(&previous).unwrap();
        fs::write(previous.join("index.json"), b"{\"from\":\"old\"}").unwrap();

        let dir = base.join("new/accounts");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("index.json"), b"{\"from\":\"new\"}").unwrap();

        migrate_store(&previous, &dir).unwrap();
        assert_eq!(fs::read_to_string(dir.join("index.json")).unwrap(), "{\"from\":\"new\"}");
    }

    /// Account ids come from Claude Code's config, not from us.
    #[test]
    fn slot_path_rejects_ids_that_would_escape_the_store() {
        let dir = PathBuf::from("/tmp/store");
        assert!(slot_path(&dir, "../../etc/passwd").is_err());
        assert!(slot_path(&dir, "").is_err());
        assert!(slot_path(&dir, "cf908f61-07ff-4aa0-af4a-88f8bc3ce167").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn saved_slots_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perms");
        write_slot(&dir, "abc", &slot_with(serde_json::json!({}), None, None)).unwrap();
        let mode = fs::metadata(dir.join("abc.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "slot files hold live OAuth tokens");
    }
}
