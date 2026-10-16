//! Keep the Mac awake while the user asks for it -- for agents left to work
//! through a long task unattended.
//!
//! macOS's own `caffeinate` holds the power assertions, rather than IOKit calls
//! from here: it is on every Mac, and `-w` ties it to our pid, so it lets go
//! when Aditor exits however it exits -- a crash or a force quit included,
//! which no cleanup of ours would see.
//!
//! The state is the app's, not a window's: one Mac, one switch. Every window is
//! told when it flips, so each button shows the same thing.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

/// `awake://changed`, to every window, with the new state.
const CHANGED: &str = "awake://changed";

#[derive(Default)]
pub struct AwakeState {
    /// The running `caffeinate`, while the switch is on.
    child: Mutex<Option<Child>>,
}

impl AwakeState {
    /// On, unless `caffeinate` has died behind our back.
    fn is_on(child: &mut Option<Child>) -> bool {
        match child {
            Some(c) => match c.try_wait() {
                Ok(None) => true,
                _ => {
                    *child = None;
                    false
                }
            },
            None => false,
        }
    }
}

/// Whether the Mac is being kept awake.
#[tauri::command]
pub fn awake_get(state: State<'_, AwakeState>) -> bool {
    AwakeState::is_on(&mut state.child.lock().unwrap())
}

/// Turn keeping awake on or off; resolves to the state it ended in.
///
/// Synchronous on purpose: spawning or killing one process is quick, and a
/// quick on-off-on must land in the order it was clicked.
#[tauri::command]
pub fn awake_set(app: AppHandle, state: State<'_, AwakeState>, on: bool) -> Result<bool, String> {
    let mut child = state.child.lock().unwrap();
    if on && !AwakeState::is_on(&mut child) {
        // -d display, -i idle, -m disk, -s system (on AC power): the lot, as a
        // "keep awake" switch is expected to mean. -w: only as long as we live.
        let spawned = Command::new("/usr/bin/caffeinate")
            .args(["-dims", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start caffeinate: {e}"))?;
        *child = Some(spawned);
    } else if !on {
        if let Some(mut c) = child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    let now = AwakeState::is_on(&mut child);
    drop(child);
    let _ = app.emit(CHANGED, now);
    Ok(now)
}
