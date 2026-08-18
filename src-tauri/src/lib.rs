mod autocomplete;
mod backup;
mod bridge;
mod commands;
mod domain;
mod files;
mod fonts;
mod forwarding;
#[cfg(target_os = "macos")]
mod menu;
mod platform;
mod terminal;
mod vault;

use commands::AppServices;
use tauri::{Manager, RunEvent, WebviewWindowBuilder};

pub fn run_askpass() -> bool {
    if std::env::var("TERMPILOT_ASKPASS_MODE").as_deref() != Ok("1") {
        return false;
    }
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use std::io::Write;

    let prompt = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let host_key_prompt =
        prompt.contains("authenticity of host") || prompt.contains("continue connecting");
    let response = if host_key_prompt {
        let request_path =
            std::env::var_os("TERMPILOT_ASKPASS_REQUEST_PATH").map(std::path::PathBuf::from);
        if let Some(request_path) = request_path {
            let _ = std::fs::remove_file(&request_path);
            let prompt_path = request_path.with_file_name("prompt");
            let _ = std::fs::write(&prompt_path, &prompt);
            std::thread::sleep(std::time::Duration::from_millis(100));
            let started = std::time::Instant::now();
            loop {
                if let Ok(response) = std::fs::read_to_string(&request_path) {
                    let _ =
                        std::fs::write(request_path.with_file_name("resolved"), response.trim());
                    break response.trim().to_string();
                }
                if started.elapsed() >= std::time::Duration::from_secs(120) {
                    break "no".to_string();
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        } else {
            "no".to_string()
        }
    } else {
        std::env::var("TERMPILOT_ASKPASS_SECRET_B64")
            .ok()
            .and_then(|value| BASE64.decode(value).ok())
            .and_then(|value| String::from_utf8(value).ok())
            .unwrap_or_default()
    };
    let _ = writeln!(std::io::stdout(), "{response}");
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(menu::handle);

    builder
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let data_directory = std::env::var_os("TERMPILOT_DATA_DIR")
                .map(std::path::PathBuf::from)
                .map(Ok)
                .unwrap_or_else(vault::default_data_directory)?;
            #[cfg(windows)]
            let vault = vault::VaultStore::open_portable(data_directory)?;
            #[cfg(not(windows))]
            let vault = vault::VaultStore::open(data_directory)?;
            app.manage(AppServices { vault });
            app.manage(autocomplete::AutocompleteCatalog::load(app.handle()));
            app.manage(terminal::TerminalManager::default());
            app.manage(bridge::SftpManager::default());
            app.manage(forwarding::ForwardManager::default());

            let window_config = app
                .config()
                .app
                .windows
                .first()
                .ok_or_else(|| std::io::Error::other("main window configuration is missing"))?;
            let window_builder = WebviewWindowBuilder::from_config(app.handle(), window_config)?;
            #[cfg(windows)]
            let window_builder = window_builder
                .data_directory(app.state::<AppServices>().vault.webview_data_directory());
            window_builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::platform_profile,
            commands::bootstrap,
            commands::export_backup,
            commands::import_backup,
            commands::save_host,
            commands::save_hosts,
            commands::delete_host,
            commands::save_group,
            commands::delete_group,
            commands::save_credential,
            commands::delete_credential,
            commands::save_proxy,
            commands::delete_proxy,
            commands::save_forward,
            commands::save_script,
            commands::save_snippet,
            commands::save_note,
            commands::delete_entity,
            commands::append_history,
            commands::append_command_history,
            commands::save_workspace,
            commands::erase_workspace,
            commands::save_preferences,
            commands::delete_known_host,
            commands::delete_known_hosts,
            commands::open_cloned_window,
            fonts::available_terminal_fonts,
            autocomplete::autocomplete_suggestions,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_terminate,
            bridge::generate_credential_key,
            bridge::ssh_terminal_start,
            bridge::sftp_request,
            bridge::sftp_close,
            files::local_home,
            files::local_downloads,
            files::local_list,
            files::local_entry,
            files::local_mkdir,
            files::local_create_file,
            files::local_rename,
            files::local_delete,
            files::local_duplicate,
            files::local_copy_to,
            files::local_move_to,
            files::local_temporary_path,
            files::local_modified_at,
            files::local_open,
            files::local_open_with,
            files::local_reveal,
            files::local_exec,
            forwarding::forward_start,
            forwarding::forward_stop,
            forwarding::forward_host_key_response,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build TermPilot")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. }) {
                app.state::<terminal::TerminalManager>().terminate_all();
                app.state::<bridge::SftpManager>().close_all();
                app.state::<forwarding::ForwardManager>().stop_all();
            }
        });
}
