use tauri::{AppHandle, State, WebviewUrl, WebviewWindowBuilder};

use crate::backup::{read_encrypted_backup, write_encrypted_backup, BackupImportSummary};
use crate::domain::{
    AppPreferences, AutomationScript, BootstrapSnapshot, CommandHistoryEntry,
    ConnectionHistoryEntry, Credential, Host, HostGroup, HostNote, PortForwardRule, ProxyProfile,
    Snippet, WorkspaceSnapshot,
};
use crate::platform::PlatformProfile;
use crate::vault::VaultStore;

pub struct AppServices {
    pub vault: VaultStore,
}

#[tauri::command]
pub fn platform_profile() -> PlatformProfile {
    crate::platform::current()
}

#[tauri::command]
pub fn bootstrap(state: State<'_, AppServices>) -> Result<BootstrapSnapshot, String> {
    state
        .vault
        .bootstrap(crate::platform::current().platform.to_string())
        .map_err(error_message)
}

#[tauri::command]
pub fn export_backup(
    state: State<'_, AppServices>,
    path: String,
    password: String,
) -> Result<(), String> {
    let snapshot = state.vault.backup_snapshot().map_err(error_message)?;
    write_encrypted_backup(std::path::Path::new(&path), &snapshot, &password).map_err(error_message)
}

#[tauri::command]
pub fn import_backup(
    state: State<'_, AppServices>,
    path: String,
    password: String,
) -> Result<BackupImportSummary, String> {
    let snapshot =
        read_encrypted_backup(std::path::Path::new(&path), &password).map_err(error_message)?;
    state
        .vault
        .import_backup_snapshot(snapshot)
        .map_err(error_message)
}

#[tauri::command]
pub fn save_host(state: State<'_, AppServices>, host: Host) -> Result<Host, String> {
    state.vault.save_host(host).map_err(error_message)
}

#[tauri::command]
pub fn save_hosts(state: State<'_, AppServices>, hosts: Vec<Host>) -> Result<Vec<Host>, String> {
    state.vault.save_hosts(hosts).map_err(error_message)
}

#[tauri::command]
pub fn delete_host(state: State<'_, AppServices>, id: String) -> Result<(), String> {
    state.vault.delete_host(&id).map_err(error_message)
}

#[tauri::command]
pub fn save_group(state: State<'_, AppServices>, group: HostGroup) -> Result<HostGroup, String> {
    state.vault.save_group(group).map_err(error_message)
}

#[tauri::command]
pub fn delete_group(state: State<'_, AppServices>, id: String) -> Result<(), String> {
    state.vault.delete_group(&id).map_err(error_message)
}

#[tauri::command]
pub fn save_credential(
    state: State<'_, AppServices>,
    credential: Credential,
) -> Result<Credential, String> {
    state
        .vault
        .save_credential(credential)
        .map_err(error_message)
}

#[tauri::command]
pub fn delete_credential(state: State<'_, AppServices>, id: String) -> Result<(), String> {
    state.vault.delete_credential(&id).map_err(error_message)
}

#[tauri::command]
pub fn save_proxy(
    state: State<'_, AppServices>,
    profile: ProxyProfile,
) -> Result<ProxyProfile, String> {
    state.vault.save_proxy(profile).map_err(error_message)
}

#[tauri::command]
pub fn delete_proxy(state: State<'_, AppServices>, id: String) -> Result<(), String> {
    state.vault.delete_proxy(&id).map_err(error_message)
}

#[tauri::command]
pub fn save_forward(
    state: State<'_, AppServices>,
    rule: PortForwardRule,
) -> Result<PortForwardRule, String> {
    state.vault.save_forward(rule).map_err(error_message)
}

#[tauri::command]
pub fn save_script(
    state: State<'_, AppServices>,
    script: AutomationScript,
) -> Result<AutomationScript, String> {
    state.vault.save_script(script).map_err(error_message)
}

#[tauri::command]
pub fn save_snippet(state: State<'_, AppServices>, snippet: Snippet) -> Result<Snippet, String> {
    state.vault.save_snippet(snippet).map_err(error_message)
}

#[tauri::command]
pub fn save_note(state: State<'_, AppServices>, note: HostNote) -> Result<HostNote, String> {
    state.vault.save_note(note).map_err(error_message)
}

#[tauri::command]
pub fn delete_entity(
    state: State<'_, AppServices>,
    kind: String,
    id: String,
) -> Result<(), String> {
    state.vault.delete_entity(&kind, &id).map_err(error_message)
}

#[tauri::command]
pub fn append_history(
    state: State<'_, AppServices>,
    entry: ConnectionHistoryEntry,
) -> Result<(), String> {
    state.vault.append_history(entry).map_err(error_message)
}

#[tauri::command]
pub fn append_command_history(
    state: State<'_, AppServices>,
    entry: CommandHistoryEntry,
) -> Result<(), String> {
    state
        .vault
        .append_command_history(entry)
        .map_err(error_message)
}

#[tauri::command]
pub fn save_workspace(
    state: State<'_, AppServices>,
    snapshot: WorkspaceSnapshot,
) -> Result<(), String> {
    state.vault.save_workspace(snapshot).map_err(error_message)
}

#[tauri::command]
pub fn erase_workspace(state: State<'_, AppServices>) -> Result<(), String> {
    state.vault.erase_workspace().map_err(error_message)
}

#[tauri::command]
pub fn save_preferences(
    state: State<'_, AppServices>,
    preferences: AppPreferences,
) -> Result<(), String> {
    state
        .vault
        .save_preferences(preferences)
        .map_err(error_message)
}

#[tauri::command]
pub fn delete_known_host(state: State<'_, AppServices>, id: String) -> Result<(), String> {
    state.vault.delete_known_host(&id).map_err(error_message)
}

#[tauri::command]
pub fn delete_known_hosts(state: State<'_, AppServices>, ids: Vec<String>) -> Result<(), String> {
    state
        .vault
        .delete_known_hosts(&ids.into_iter().collect())
        .map_err(error_message)
}

#[tauri::command]
pub fn open_cloned_window(
    app: AppHandle,
    state: State<'_, AppServices>,
    key: String,
) -> Result<(), String> {
    let key = uuid::Uuid::parse_str(&key)
        .map_err(|_| "invalid window clone identifier".to_string())?
        .to_string();
    let mut window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "main window configuration is missing".to_string())?;
    window_config.label = format!("terminal-{key}");
    window_config.create = true;
    window_config.url = WebviewUrl::App(format!("index.html?windowClone={key}").into());

    let window_builder =
        WebviewWindowBuilder::from_config(&app, &window_config).map_err(error_message)?;
    #[cfg(windows)]
    let window_builder = window_builder.data_directory(state.vault.webview_data_directory());
    #[cfg(not(windows))]
    let _ = state;
    window_builder.build().map_err(error_message)?;
    Ok(())
}

fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
