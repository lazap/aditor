mod accounts;
mod agents;
mod fs;
mod git;
mod pty;

use std::sync::Arc;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(pty::PtyRegistry::default()))
        .manage(fs::Workspace::default())
        .manage(agents::AgentState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::agents_available,
            fs::open_workspace,
            fs::list_dir,
            fs::read_file,
            fs::fs_debounce_ms,
            fs::dirs_exist,
            git::git_status,
            git::git_diff,
            agents::agent_sessions,
            agents::agent_watch,
            accounts::claude_accounts,
            accounts::claude_account_save,
            accounts::claude_account_switch,
            accounts::claude_account_rename,
            accounts::claude_account_forget,
        ])
        // Agents run in their own process groups, so closing the window does not
        // hang them up -- without this they survive the app that spawned them.
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                if let Some(registry) = window.try_state::<Arc<pty::PtyRegistry>>() {
                    pty::kill_all(&registry);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
