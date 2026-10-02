//! What each agent Aditor spawned is doing right now: working, done, or
//! waiting on the user -- the signal behind notifications and tab badges.
//!
//! Claude Code keeps a live registry, `~/.claude/sessions/<pid>.json`, and
//! rewrites an entry whenever its session changes status. Our PTY's child *is*
//! the agent (the login shell `exec`s it), so an entry's pid names the pane it
//! belongs to. One watcher for the whole app; each change goes only to the
//! window that owns the session.

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::agents::{live_entries, registry_dir};
use crate::mcp::McpServer;
use crate::pty::PtyRegistry;

/// A registry rewrite comes as a burst of events; wait this long for it to end.
const DEBOUNCE: Duration = Duration::from_millis(150);

/// `pty://status`, to the owning window.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    id: String,
    status: String,
    waiting_for: Option<String>,
}

#[derive(Default)]
pub struct StatusState {
    /// PTY id -> the status last sent for it.
    last: Mutex<HashMap<String, String>>,
    /// Editor window label -> sessions in it that want the user. Summed into
    /// the Dock badge, which is the app's, not any one window's.
    attention: Mutex<HashMap<String, u32>>,
    watcher: Mutex<Option<Box<dyn Watcher + Send>>>,
}

impl StatusState {
    /// A window has gone: its sessions no longer count toward the badge.
    pub fn forget_window(&self, app: &AppHandle, label: &str) {
        self.attention.lock().unwrap().remove(label);
        self.update_badge(app);
    }

    fn update_badge(&self, app: &AppHandle) {
        let total: u32 = self.attention.lock().unwrap().values().sum();
        let count = (total > 0).then_some(i64::from(total));
        // Any window will do: on macOS the badge is on the Dock icon.
        if let Some(w) = app.webview_windows().values().next() {
            let _ = w.set_badge_count(count);
        }
    }
}

/// Watch the registry for the life of the app. A machine where Claude Code has
/// never run has no registry yet, so until it appears its parent is watched
/// and every event there is a cue to look again.
pub fn start(app: &AppHandle) {
    let Some(registry) = registry_dir() else { return };
    let (tx, rx) = channel::<()>();
    let watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(e) = res {
            if matches!(e.kind, EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)) {
                let _ = tx.send(());
            }
        }
    });
    let Ok(mut watcher) = watcher else { return };
    let mut watching = watch(&mut watcher, &registry);
    app.state::<StatusState>().watcher.lock().unwrap().replace(Box::new(watcher));

    let app = app.clone();
    std::thread::spawn(move || loop {
        if rx.recv().is_err() {
            return;
        }
        // Drain the rest of the burst.
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(()) => continue,
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let state = app.state::<StatusState>();
        if !watching {
            if let Some(w) = state.watcher.lock().unwrap().as_mut() {
                watching = watch(w.as_mut(), &registry);
            }
        }
        scan(&app);
    });
}

/// Watch the registry if it exists, else the folder it will appear in.
/// True once the registry itself is watched.
fn watch(watcher: &mut dyn Watcher, registry: &Path) -> bool {
    if registry.is_dir() {
        if let Some(parent) = registry.parent() {
            let _ = watcher.unwatch(parent);
        }
        return watcher.watch(registry, RecursiveMode::NonRecursive).is_ok();
    }
    if let Some(parent) = registry.parent().filter(|p| p.is_dir()) {
        let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
    }
    false
}

/// What changed between two looks at the registry: the sessions whose status
/// moved, and the ones that are gone.
fn diff(
    last: &HashMap<String, String>,
    now: &HashMap<String, (String, Option<String>)>,
) -> (Vec<String>, Vec<String>) {
    let changed = now
        .iter()
        .filter(|(id, (status, _))| last.get(*id) != Some(status))
        .map(|(id, _)| id.clone())
        .collect();
    let gone = last.keys().filter(|id| !now.contains_key(*id)).cloned().collect();
    (changed, gone)
}

fn scan(app: &AppHandle) {
    let ptys = app.state::<Arc<PtyRegistry>>();
    let mut now: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut windows: HashMap<String, String> = HashMap::new();
    for e in live_entries() {
        let Some((id, window)) = ptys.lookup_pid(e.pid) else { continue };
        let status = e.status.unwrap_or_else(|| "idle".to_string());
        windows.insert(id.clone(), window);
        now.insert(id, (status, e.waiting_for));
    }

    let state = app.state::<StatusState>();
    let mut last = state.last.lock().unwrap();
    let (changed, gone) = diff(&last, &now);
    for id in gone {
        last.remove(&id);
    }
    for id in changed {
        let (status, waiting_for) = now[&id].clone();
        // Back at the prompt with a question still open means the user
        // interrupted the call: the question's card has nothing to answer.
        if status == "idle" {
            if let Some(mcp) = app.try_state::<McpServer>() {
                mcp.abandon(&id);
            }
        }
        last.insert(id.clone(), status.clone());
        let _ = app.emit_to(
            windows[&id].as_str(),
            "pty://status",
            StatusEvent { id, status, waiting_for },
        );
    }
}

/// How many of this window's sessions want the user; the Dock badge is the
/// sum across windows.
#[tauri::command]
pub fn set_attention_count(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, StatusState>,
    count: u32,
) {
    state
        .attention
        .lock()
        .unwrap()
        .insert(window.label().to_string(), count);
    state.update_badge(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now(pairs: &[(&str, &str)]) -> HashMap<String, (String, Option<String>)> {
        pairs
            .iter()
            .map(|(id, s)| (id.to_string(), (s.to_string(), None)))
            .collect()
    }

    fn last(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(id, s)| (id.to_string(), s.to_string())).collect()
    }

    #[test]
    fn a_status_change_is_reported() {
        let (changed, gone) = diff(&last(&[("pty-1", "busy")]), &now(&[("pty-1", "idle")]));
        assert_eq!(changed, vec!["pty-1"]);
        assert!(gone.is_empty());
    }

    #[test]
    fn an_unchanged_status_is_not() {
        let (changed, _) = diff(&last(&[("pty-1", "idle")]), &now(&[("pty-1", "idle")]));
        assert!(changed.is_empty());
    }

    #[test]
    fn a_new_session_is_reported_and_a_vanished_one_forgotten() {
        let (changed, gone) = diff(&last(&[("pty-1", "busy")]), &now(&[("pty-2", "idle")]));
        assert_eq!(changed, vec!["pty-2"]);
        assert_eq!(gone, vec!["pty-1"]);
    }
}
