mod accounts;
mod agents;
mod fs;
mod git;
mod pty;
mod settings;

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
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_pull,
            git::git_push,
            agents::agent_sessions,
            agents::agent_watch,
            agents::agent_refresh_limits,
            accounts::claude_accounts,
            accounts::claude_account_save,
            accounts::claude_account_switch,
            accounts::claude_account_rename,
            accounts::claude_account_forget,
            settings::settings_read,
            settings::settings_write,
        ])
        // Agents run in their own process groups, so closing the window does not
        // hang them up -- without this they survive the app that spawned them.
        //
        // Only the main window owns agents. Settings and the template picker are
        // windows of their own, and closing one must not take the session with
        // it. When main goes, they go too: without the editor they are orphans
        // that would keep the app alive.
        .on_window_event(|window, event| {
            if window.label() != "main" || !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            if let Some(registry) = window.try_state::<Arc<pty::PtyRegistry>>() {
                pty::kill_all(&registry);
            }
            for (label, other) in window.app_handle().webview_windows() {
                if label != "main" {
                    let _ = other.close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
