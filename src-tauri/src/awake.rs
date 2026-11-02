//! Keep the computer awake while the user asks for it -- for agents left to
//! work through a long task unattended. How it is held is per platform; see
//! `platform::Awake`.
//!
//! The state is the app's, not a window's: one computer, one switch. Every
//! window is told when it flips, so each button shows the same thing.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use crate::platform::Awake;

/// `awake://changed`, to every window, with the new state.
const CHANGED: &str = "awake://changed";

#[derive(Default)]
pub struct AwakeState {
    /// The hold, while the switch is on.
    held: Mutex<Option<Awake>>,
}

impl AwakeState {
    /// On, unless the hold has died behind our back.
    fn is_on(held: &mut Option<Awake>) -> bool {
        if held.as_mut().is_some_and(Awake::holding) {
            return true;
        }
        *held = None;
        false
    }
}

/// Whether the computer is being kept awake.
#[tauri::command]
pub fn awake_get(state: State<'_, AwakeState>) -> bool {
    AwakeState::is_on(&mut state.held.lock().unwrap())
}

/// Turn keeping awake on or off; resolves to the state it ended in.
///
/// Synchronous on purpose: taking or releasing the hold is quick, and a quick
/// on-off-on must land in the order it was clicked.
#[tauri::command]
pub fn awake_set(app: AppHandle, state: State<'_, AwakeState>, on: bool) -> Result<bool, String> {
    let mut held = state.held.lock().unwrap();
    if on && !AwakeState::is_on(&mut held) {
        *held = Some(Awake::start()?);
    } else if !on {
        if let Some(a) = held.take() {
            a.release();
        }
    }
    let now = AwakeState::is_on(&mut held);
    drop(held);
    let _ = app.emit(CHANGED, now);
    Ok(now)
}
