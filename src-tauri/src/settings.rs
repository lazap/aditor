//! Aditor's own settings, in `~/.aditor/settings.json`.
//!
//! The document is opaque here on purpose: this module reads and writes a JSON
//! value and never looks inside it. The frontend owns the shape, the same way
//! `src/shortcuts/registry.ts` owns the shortcut list -- so adding a setting is
//! one change there and none here.
//!
//! It lives beside the saved logins in `~/.aditor` rather than the platform
//! config directory, for the reason `accounts::store_dir` gives: this is a
//! store people expect to find, back up and carry between machines.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;

use crate::accounts::{aditor_dir, write_private};

const FILE: &str = "settings.json";
/// Where an unparseable file is moved before we carry on with defaults.
const SALVAGE: &str = "settings.json.bad";

/// Serializes writes among themselves. Deliberately not the account gate in
/// `accounts.rs`: a settings write happens on every split-pane drag, and
/// queueing those behind an account switch would stall the UI's persistence for
/// as long as a Keychain round trip.
static GATE: Mutex<()> = Mutex::new(());

/// Off the IPC thread, which on macOS is the AppKit main thread -- a blocking
/// command there freezes the webview, xterm included, for its whole duration.
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
    .map_err(|e| format!("the settings operation did not finish: {e}"))?
}

#[tauri::command]
pub async fn settings_read() -> Result<Value, String> {
    off_thread(move || read_from(&aditor_dir()?)).await
}

#[tauri::command]
pub async fn settings_write(value: Value) -> Result<(), String> {
    off_thread(move || write_to(&aditor_dir()?, &value)).await
}

/// Null for "nothing usable on disk" -- the caller falls back to its defaults.
///
/// A file we cannot parse is moved aside rather than reported as an error: a
/// settings file someone hand-edited into invalid JSON must not be able to stop
/// the app from opening, and deleting their content outright would be worse
/// than starting over next to a copy of it.
fn read_from(dir: &Path) -> Result<Value, String> {
    let path = dir.join(FILE);
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    match serde_json::from_str(&text) {
        Ok(v) => Ok(v),
        Err(_) => {
            let _ = fs::rename(&path, dir.join(SALVAGE));
            Ok(Value::Null)
        }
    }
}

/// Pretty, and newline-terminated: this is a file people are meant to be able
/// to open, read and diff.
fn write_to(dir: &Path, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    write_private(&dir.join(FILE), &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh directory under the system temp dir. No helper crate for it --
    /// the two existing test modules here do the same.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aditor-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_reads_as_null() {
        let dir = scratch("missing");
        assert_eq!(read_from(&dir).unwrap(), Value::Null);
    }

    #[test]
    fn round_trip_survives() {
        let dir = scratch("roundtrip");
        let value = serde_json::json!({ "templates": [{ "id": "a", "body": "hi" }] });
        write_to(&dir, &value).unwrap();
        assert_eq!(read_from(&dir).unwrap(), value);
    }

    #[test]
    fn corrupt_file_is_moved_aside_not_propagated() {
        let dir = scratch("corrupt");
        fs::write(dir.join(FILE), b"{ not json").unwrap();
        assert_eq!(read_from(&dir).unwrap(), Value::Null);
        assert!(!dir.join(FILE).exists(), "the corrupt file is out of the way");
        assert_eq!(
            fs::read_to_string(dir.join(SALVAGE)).unwrap(),
            "{ not json",
            "and its content is still recoverable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("mode");
        write_to(&dir, &serde_json::json!({})).unwrap();
        let mode = fs::metadata(dir.join(FILE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
