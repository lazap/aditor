mod accounts;
mod agents;
mod fs;
mod git;
mod git_log;
mod mcp;
mod pty;
mod run;
mod run_log;
mod search;
mod settings;
mod status;
mod themes;
mod worktree;

use std::sync::Arc;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(pty::PtyRegistry::default()))
        .manage(fs::Workspace::default())
        .manage(agents::AgentState::default())
        .manage(search::SearchState::default())
        .manage(status::StatusState::default())
        .setup(|app| {
            app.manage(mcp::start(app.handle().clone())?);
            status::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_run,
            pty::run_output,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_window,
            pty::agents_available,
            fs::open_workspace,
            fs::close_workspace,
            fs::list_dir,
            fs::read_file,
            fs::write_file,
            fs::create_file,
            fs::fs_debounce_ms,
            fs::dirs_exist,
            fs::resolve_file_links,
            search::list_files,
            search::search_content,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_pull,
            git::git_push,
            git::git_branches,
            git::git_checkout,
            git::git_fetch,
            git::git_rollback,
            git::git_branch_create,
            git::git_branch_rename,
            git::git_branch_delete,
            git::git_merge,
            git::git_rebase,
            git::git_cherry_pick,
            git::git_revert,
            git::git_reset,
            git::git_checkout_revision,
            git::git_tag_create,
            git::git_tag_delete,
            git::git_push_tag,
            git::git_operation_continue,
            worktree::worktree_create,
            worktree::worktree_info,
            worktree::worktree_remove,
            git::git_operation_abort,
            git_log::git_log,
            git_log::git_commit_details,
            git_log::git_commit_file_diff,
            git_log::git_blame,
            git_log::git_outgoing,
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
            themes::themes_list,
            themes::theme_write,
            themes::theme_delete,
            themes::theme_import,
            themes::theme_export,
            run::run_configs_read,
            run::run_configs_write,
            run::run_detect,
            mcp::mcp_tasks,
            mcp::mcp_answer,
            status::set_attention_count,
        ])
        // Agents run in their own process groups, so closing the window does not
        // hang them up -- without this they survive the app that spawned them.
        //
        // Only editor windows -- "main", and "main-*" opened with New Window --
        // own agents, each its own. Settings, templates, diff and log are windows
        // of their own, and closing one must not take a session with it. When
        // the last editor goes, they go too: without one they are orphans that
        // would keep the app alive.
        .on_window_event(|window, event| {
            if !is_editor(window.label()) || !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            if let Some(registry) = window.try_state::<Arc<pty::PtyRegistry>>() {
                let ids = pty::kill_window(&registry, window.label());
                if let Some(mcp) = window.try_state::<mcp::McpServer>() {
                    for id in &ids {
                        mcp.clear(id);
                    }
                }
            }
            if let Some(status) = window.try_state::<status::StatusState>() {
                status.forget_window(window.app_handle(), window.label());
            }
            if let Some(ws) = window.try_state::<fs::Workspace>() {
                let released = ws.release_window(window.label());
                if let Some(agents) = window.try_state::<agents::AgentState>() {
                    for root in &released {
                        agents.forget(root);
                    }
                }
            }
            let windows = window.app_handle().webview_windows();
            let editors_left = windows
                .keys()
                .any(|label| is_editor(label) && label != window.label());
            if !editors_left {
                for (label, other) in windows {
                    if !is_editor(&label) {
                        let _ = other.close();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// An editor window: the first one, or one opened with New Window.
fn is_editor(label: &str) -> bool {
    label == "main" || label.starts_with("main-")
}
