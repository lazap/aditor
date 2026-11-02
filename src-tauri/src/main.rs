// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Run by ssh or git to ask for a passphrase: answer and exit, never
    // becoming a second copy of the app. See `askpass.rs`.
    if let Some(code) = aditor_lib::askpass_helper() {
        std::process::exit(code);
    }
    aditor_lib::run()
}
