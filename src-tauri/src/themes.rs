//! Custom colour themes, one JSON file each in `~/.aditor/themes`.
//!
//! Opaque here for the reason `settings.rs` gives: the frontend's
//! `src/theme/model.ts` owns the shape and checks every field, so this module
//! only moves JSON values between disk and the webview. What it does own is
//! the file names -- an id is a file stem, and it is checked before it goes
//! anywhere near a path.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::accounts::{aditor_dir, write_private};

const DIR: &str = "themes";
/// A theme is a few kilobytes; anything far past that is not one.
const MAX_BYTES: u64 = 1024 * 1024;

static GATE: Mutex<()> = Mutex::new(());

/// Off the IPC thread, which on macOS is the AppKit main thread.
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
    .map_err(|e| format!("the theme operation did not finish: {e}"))?
}

#[derive(Serialize, Debug, PartialEq)]
pub struct StoredTheme {
    id: String,
    value: Value,
}

fn themes_dir() -> Result<PathBuf, String> {
    let dir = aditor_dir()?.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The same rule as `ID_RULE` in model.ts: lowercase, digits and dashes, so an
/// id can never name a path outside the directory. "dark" and "light" are the
/// built-in presets and have no file.
fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
        && id != "dark"
        && id != "light";
    if ok {
        Ok(())
    } else {
        Err(format!("\"{id}\" is not a usable theme id"))
    }
}

#[tauri::command]
pub async fn themes_list() -> Result<Vec<StoredTheme>, String> {
    off_thread(move || list_in(&themes_dir()?)).await
}

#[tauri::command]
pub async fn theme_write(id: String, value: Value) -> Result<(), String> {
    off_thread(move || write_in(&themes_dir()?, &id, &value)).await
}

#[tauri::command]
pub async fn theme_delete(id: String) -> Result<(), String> {
    off_thread(move || delete_in(&themes_dir()?, &id)).await
}

/// A file the user picked in the open dialog.
#[tauri::command]
pub async fn theme_import(path: String) -> Result<Value, String> {
    off_thread(move || read_json(Path::new(&path))).await
}

/// To a path the user picked in the save dialog. Not owner-only: a theme is
/// made to be shared.
#[tauri::command]
pub async fn theme_export(path: String, value: Value) -> Result<(), String> {
    off_thread(move || {
        fs::write(&path, pretty(&value)?).map_err(|e| format!("could not write {path}: {e}"))
    })
    .await
}

/// Every readable theme, sorted by id. A file that is not JSON is skipped
/// rather than failing the list: one bad hand edit must not hide the rest.
fn list_in(dir: &Path) -> Result<Vec<StoredTheme>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("could not read {}: {e}", dir.display()))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if check_id(id).is_err() {
            continue;
        }
        if let Ok(value) = read_json(&path) {
            out.push(StoredTheme { id: id.to_string(), value });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn write_in(dir: &Path, id: &str, value: &Value) -> Result<(), String> {
    check_id(id)?;
    write_private(&dir.join(format!("{id}.json")), &pretty(value)?)
}

fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    match fs::remove_file(dir.join(format!("{id}.json"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not delete theme {id}: {e}")),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let len = fs::metadata(path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?
        .len();
    if len > MAX_BYTES {
        return Err(format!("{} is too large to be a theme", path.display()));
    }
    let text = fs::read_to_string(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", path.display()))
}

/// Pretty and newline-terminated, like settings.json: made to be read and diffed.
fn pretty(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aditor-themes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_and_delete() {
        let dir = scratch("roundtrip");
        let value = serde_json::json!({ "name": "Paper", "kind": "light" });
        write_in(&dir, "paper", &value).unwrap();
        assert_eq!(
            list_in(&dir).unwrap(),
            vec![StoredTheme { id: "paper".into(), value }]
        );
        delete_in(&dir, "paper").unwrap();
        assert!(list_in(&dir).unwrap().is_empty());
        delete_in(&dir, "paper").expect("deleting twice is not an error");
    }

    #[test]
    fn unreadable_and_foreign_files_are_skipped() {
        let dir = scratch("skip");
        fs::write(dir.join("broken.json"), b"{ nope").unwrap();
        fs::write(dir.join("notes.txt"), b"hi").unwrap();
        fs::write(dir.join("Bad Name.json"), b"{}").unwrap();
        write_in(&dir, "good", &serde_json::json!({})).unwrap();
        let ids: Vec<_> = list_in(&dir).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["good"]);
    }

    #[test]
    fn ids_cannot_leave_the_directory_or_shadow_presets() {
        for id in ["", "../x", "a/b", "A", "-x", "dark", "light", "a.b"] {
            assert!(check_id(id).is_err(), "{id:?} should be refused");
        }
        assert!(check_id("tokyo-night-2").is_ok());
        let dir = scratch("ids");
        assert!(write_in(&dir, "../escape", &serde_json::json!({})).is_err());
    }
}
