use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use thiserror::Error;
use uuid::Uuid;

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("{0} is required")]
    Required(&'static str),
    #[error("{0} must be between 1 and 65535")]
    InvalidPort(&'static str),
    #[error("hostname is invalid")]
    InvalidHostname,
    #[error("private key content or path is required")]
    MissingIdentity,
    #[error("proxy command is required")]
    MissingProxyCommand,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthenticationMethod {
    #[default]
    Agent,
    Password,
    IdentityFile,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    #[default]
    Password,
    IdentityKey,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SftpFileProtocol {
    #[default]
    Auto,
    Sftp,
    Scp,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub enum SftpFilenameEncoding {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "gb18030")]
    Gb18030,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ElevationMethod {
    #[default]
    Sudo,
    Su,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyType {
    #[default]
    Http,
    Socks5,
    Command,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfiguration {
    #[serde(rename = "type")]
    pub proxy_type: ProxyType,
    pub host: String,
    pub port: u16,
    pub command: Option<String>,
    pub credential_id: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl ProxyConfiguration {
    pub fn validate(&mut self) -> Result<(), DomainError> {
        match self.proxy_type {
            ProxyType::Command => {
                trim_optional(&mut self.command);
                if self.command.is_none() {
                    return Err(DomainError::MissingProxyCommand);
                }
                self.host.clear();
                self.port = 0;
                self.credential_id = None;
                self.username = None;
                self.password = None;
            }
            ProxyType::Http | ProxyType::Socks5 => {
                self.host = self.host.trim().to_string();
                if !valid_hostname(&self.host) {
                    return Err(DomainError::InvalidHostname);
                }
                if self.port == 0 {
                    return Err(DomainError::InvalidPort("proxy port"));
                }
                self.command = None;
                trim_optional(&mut self.username);
                trim_optional(&mut self.password);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    #[serde(default = "new_id")]
    pub id: String,
    pub label: String,
    pub hostname: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub authentication: AuthenticationMethod,
    pub identity_file: Option<String>,
    pub identity_key: Option<String>,
    pub public_key: Option<String>,
    pub certificate: Option<String>,
    pub passphrase: Option<String>,
    pub password: Option<String>,
    pub elevation_password: Option<String>,
    pub credential_id: Option<String>,
    pub proxy_profile_id: Option<String>,
    pub proxy_configuration: Option<ProxyConfiguration>,
    pub group_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    pub distro: Option<String>,
    #[serde(default = "default_auto")]
    pub distro_mode: String,
    pub manual_distro: Option<String>,
    #[serde(default = "default_auto")]
    pub icon_mode: String,
    pub icon_id: Option<String>,
    #[serde(default = "default_auto")]
    pub icon_color_mode: String,
    pub icon_color: Option<String>,
    pub icon_color_custom: Option<String>,
    #[serde(default)]
    pub sftp_file_protocol: SftpFileProtocol,
    #[serde(default)]
    pub sftp_filename_encoding: SftpFilenameEncoding,
    #[serde(default)]
    pub sftp_uses_sudo: bool,
    pub sftp_follows_terminal_cwd: Option<bool>,
    #[serde(default)]
    pub server_tools_use_root: bool,
    #[serde(default)]
    pub server_tools_elevation_method: ElevationMethod,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
}

impl Host {
    pub fn validate(&mut self) -> Result<(), DomainError> {
        self.label = required(&self.label, "host name")?;
        self.hostname = self.hostname.trim().to_string();
        self.username = required(&self.username, "username")?;
        if !valid_hostname(&self.hostname) {
            return Err(DomainError::InvalidHostname);
        }
        if self.port == 0 {
            return Err(DomainError::InvalidPort("port"));
        }
        trim_optional(&mut self.identity_file);
        trim_optional(&mut self.identity_key);
        if matches!(self.authentication, AuthenticationMethod::IdentityFile)
            && self.credential_id.is_none()
            && self.identity_file.is_none()
            && self.identity_key.is_none()
        {
            return Err(DomainError::MissingIdentity);
        }
        if let Some(proxy) = &mut self.proxy_configuration {
            proxy.validate()?;
            self.proxy_profile_id = None;
        }
        if self.icon_mode == "auto" {
            self.icon_id = None;
        } else if self.icon_id.is_none() {
            self.icon_id = Some("server".to_string());
        }
        if self.icon_color_mode == "auto" {
            self.icon_color = None;
            self.icon_color_custom = None;
        } else if !valid_host_color(self.icon_color_custom.as_deref()) {
            self.icon_color_custom = None;
            if self.icon_color.is_none() {
                self.icon_color = Some("blue".to_string());
            }
        }
        if matches!(self.sftp_file_protocol, SftpFileProtocol::Scp) {
            self.sftp_uses_sudo = false;
        }
        self.updated_at = now();
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    #[serde(default = "new_id")]
    pub id: String,
    pub name: String,
    pub parent_group_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

impl HostGroup {
    pub fn validate(&mut self) -> Result<(), DomainError> {
        self.name = required(&self.name, "group name")?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    #[serde(default = "new_id")]
    pub id: String,
    pub label: String,
    pub username: String,
    #[serde(default)]
    pub kind: CredentialKind,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub public_key: Option<String>,
    pub certificate: Option<String>,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub saves_passphrase: bool,
    pub elevation_password: Option<String>,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
}

impl Credential {
    pub fn validate(&mut self) -> Result<(), DomainError> {
        self.label = required(&self.label, "credential label")?;
        self.username = required(&self.username, "credential username")?;
        match self.kind {
            CredentialKind::Password if blank(&self.password) => {
                return Err(DomainError::Required("password"));
            }
            CredentialKind::IdentityKey if blank(&self.private_key) => {
                return Err(DomainError::Required("private key"));
            }
            CredentialKind::Password => {
                self.private_key = None;
                self.public_key = None;
                self.certificate = None;
                self.passphrase = None;
                self.saves_passphrase = false;
            }
            CredentialKind::IdentityKey => {
                self.password = None;
                if !self.saves_passphrase {
                    self.passphrase = None;
                }
            }
        }
        self.updated_at = now();
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProfile {
    #[serde(default = "new_id")]
    pub id: String,
    pub label: String,
    pub configuration: ProxyConfiguration,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
}

impl ProxyProfile {
    pub fn validate(&mut self) -> Result<(), DomainError> {
        self.label = required(&self.label, "proxy name")?;
        self.configuration.validate()?;
        self.updated_at = now();
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PortForwardKind {
    #[default]
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PortForwardStatus {
    #[default]
    Inactive,
    Connecting,
    Active,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRule {
    #[serde(default = "new_id")]
    pub id: String,
    pub host_id: Option<String>,
    pub name: String,
    pub order: Option<i64>,
    #[serde(default)]
    pub kind: PortForwardKind,
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    pub local_port: u16,
    #[serde(default = "default_bind_address")]
    pub remote_host: String,
    pub remote_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub status: PortForwardStatus,
    pub error: Option<String>,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
    pub last_used_at: Option<String>,
}

impl PortForwardRule {
    pub fn validate(&mut self) -> Result<(), DomainError> {
        self.name = required(&self.name, "forward name")?;
        self.bind_address = required(&self.bind_address, "bind address")?;
        if self.local_port == 0 {
            return Err(DomainError::InvalidPort("local port"));
        }
        if !matches!(self.kind, PortForwardKind::Dynamic) {
            self.remote_host = required(&self.remote_host, "remote host")?;
            if self.remote_port.unwrap_or(0) == 0 {
                return Err(DomainError::InvalidPort("remote port"));
            }
        }
        self.updated_at = now();
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationScript {
    #[serde(default = "new_id")]
    pub id: String,
    pub title: String,
    pub shell: String,
    pub body: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    #[serde(default = "new_id")]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub group: String,
    pub body: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "now")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostNote {
    #[serde(default = "new_id")]
    pub id: String,
    pub host_id: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default = "now")]
    pub created_at: String,
    #[serde(default = "now")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionHistoryEntry {
    #[serde(default = "new_id")]
    pub id: String,
    pub host_id: Option<String>,
    #[serde(default = "now")]
    pub started_at: String,
    pub ended_at: Option<String>,
    #[serde(default)]
    pub succeeded: bool,
    pub error_category: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    #[serde(default = "new_id")]
    pub id: String,
    pub session_id: String,
    pub session_title: Option<String>,
    pub host_id: Option<String>,
    pub command: String,
    #[serde(default = "now")]
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    #[default]
    Local,
    Ssh,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionLifecycle {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Exited,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default)]
    pub kind: SessionKind,
    pub title: String,
    pub host_id: Option<String>,
    pub shell: Option<String>,
    pub working_directory: Option<String>,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default)]
    pub lifecycle: SessionLifecycle,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceNode {
    Pane {
        id: String,
        session_id: String,
    },
    TabGroup {
        id: String,
        session_ids: Vec<String>,
        active_session_id: String,
    },
    Split {
        id: String,
        axis: SplitAxis,
        children: Vec<WorkspaceNode>,
        sizes: Vec<f64>,
    },
}

impl WorkspaceNode {
    pub fn session_ids(&self) -> Vec<String> {
        match self {
            WorkspaceNode::Pane { session_id, .. } => vec![session_id.clone()],
            WorkspaceNode::TabGroup { session_ids, .. } => session_ids.clone(),
            WorkspaceNode::Split { children, .. } => {
                children.iter().flat_map(Self::session_ids).collect()
            }
        }
    }

    pub fn pruned(self, valid_session_ids: &HashSet<String>) -> Option<Self> {
        match self {
            WorkspaceNode::Pane { id, session_id } => valid_session_ids
                .contains(&session_id)
                .then_some(WorkspaceNode::Pane { id, session_id }),
            WorkspaceNode::TabGroup {
                id,
                session_ids,
                active_session_id,
            } => {
                let session_ids = session_ids
                    .into_iter()
                    .filter(|session_id| valid_session_ids.contains(session_id))
                    .collect::<Vec<_>>();
                match session_ids.as_slice() {
                    [] => None,
                    [session_id] => Some(WorkspaceNode::Pane {
                        id,
                        session_id: session_id.clone(),
                    }),
                    _ => {
                        let active_session_id = if session_ids.contains(&active_session_id) {
                            active_session_id
                        } else {
                            session_ids[0].clone()
                        };
                        Some(WorkspaceNode::TabGroup {
                            id,
                            session_ids,
                            active_session_id,
                        })
                    }
                }
            }
            WorkspaceNode::Split {
                id,
                axis,
                children,
                sizes,
            } => {
                let sizes = normalized_sizes(&sizes, children.len());
                let remaining = children
                    .into_iter()
                    .zip(sizes)
                    .filter_map(|(child, size)| {
                        child.pruned(valid_session_ids).map(|child| (child, size))
                    })
                    .collect::<Vec<_>>();
                match remaining.len() {
                    0 => None,
                    1 => remaining.into_iter().next().map(|item| item.0),
                    count => {
                        let total = remaining.iter().map(|item| item.1).sum::<f64>();
                        Some(WorkspaceNode::Split {
                            id,
                            axis,
                            children: remaining.iter().map(|item| item.0.clone()).collect(),
                            sizes: remaining
                                .iter()
                                .map(|item| {
                                    if total > 0.0 {
                                        item.1 / total
                                    } else {
                                        1.0 / count as f64
                                    }
                                })
                                .collect(),
                        })
                    }
                }
            }
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SplitAxis {
    Horizontal,
    #[default]
    Vertical,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocument {
    #[serde(default = "new_id")]
    pub id: String,
    pub title: String,
    pub root: WorkspaceNode,
    pub focused_session_id: String,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    #[serde(default = "default_snapshot_version")]
    pub version: u32,
    #[serde(default = "now")]
    pub saved_at: String,
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub sessions: Vec<SessionDescriptor>,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceDocument>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostRecord {
    pub id: String,
    pub hosts: String,
    pub algorithm: String,
    pub key: String,
    pub raw_line: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_font_name")]
    pub terminal_font_name: String,
    #[serde(default = "default_font_size")]
    pub terminal_font_size: f64,
    #[serde(default = "default_true")]
    pub autocomplete_enabled: bool,
    #[serde(default)]
    pub autocomplete_ghost_text: bool,
    #[serde(default = "default_true")]
    pub autocomplete_popup: bool,
    #[serde(default = "default_password_assist")]
    pub password_prompt_assist: String,
    #[serde(default = "default_true")]
    pub auto_open_system_overview: bool,
    #[serde(default)]
    pub auto_accept_ssh_host_keys: bool,
    #[serde(default = "default_overview_refresh_interval")]
    pub overview_refresh_interval: u8,
    #[serde(default = "default_processes_refresh_interval")]
    pub processes_refresh_interval: u8,
    #[serde(default = "default_docker_refresh_interval")]
    pub docker_refresh_interval: u8,
    #[serde(default = "default_true")]
    pub sftp_shows_hidden_files: bool,
    #[serde(default = "default_sftp_file_transfer_concurrency")]
    pub sftp_file_transfer_concurrency: u8,
    #[serde(default = "default_sftp_chunk_concurrency")]
    pub sftp_chunk_concurrency: u8,
    #[serde(default = "default_sftp_chunk_size")]
    pub sftp_chunk_size_bytes: u32,
    #[serde(default = "default_sftp_idle_seconds")]
    pub sftp_transfer_connection_idle_seconds: u32,
}

impl Default for AppPreferences {
    fn default() -> Self {
        serde_json::from_value(serde_json::json!({})).expect("default preferences")
    }
}

impl AppPreferences {
    pub fn normalize(&mut self) {
        self.terminal_font_size = self.terminal_font_size.clamp(8.0, 36.0);
        self.overview_refresh_interval = self.overview_refresh_interval.clamp(1, 10);
        self.processes_refresh_interval = self.processes_refresh_interval.clamp(1, 10);
        self.docker_refresh_interval = self.docker_refresh_interval.clamp(1, 10);
        self.sftp_file_transfer_concurrency = self.sftp_file_transfer_concurrency.clamp(1, 16);
        self.sftp_chunk_concurrency = self.sftp_chunk_concurrency.clamp(1, 32);
        if ![
            256 * 1024,
            512 * 1024,
            1024 * 1024,
            5 * 1024 * 1024,
            10 * 1024 * 1024,
        ]
        .contains(&self.sftp_chunk_size_bytes)
        {
            self.sftp_chunk_size_bytes = default_sftp_chunk_size();
        }
        if ![60, 5 * 60, 15 * 60, 30 * 60, 0].contains(&self.sftp_transfer_connection_idle_seconds)
        {
            self.sftp_transfer_connection_idle_seconds = default_sftp_idle_seconds();
        }
        if self.autocomplete_popup {
            self.autocomplete_ghost_text = false;
        }
        self.password_prompt_assist = match self.password_prompt_assist.as_str() {
            "off" => "off",
            "picker" | "automatic" => "picker",
            _ => "hint",
        }
        .to_string();
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapSnapshot {
    pub platform: String,
    pub hosts: Vec<Host>,
    pub groups: Vec<HostGroup>,
    pub credentials: Vec<Credential>,
    pub proxies: Vec<ProxyProfile>,
    pub forwards: Vec<PortForwardRule>,
    pub scripts: Vec<AutomationScript>,
    pub snippets: Vec<Snippet>,
    pub notes: Vec<HostNote>,
    pub history: Vec<ConnectionHistoryEntry>,
    pub command_history: Vec<CommandHistoryEntry>,
    pub known_hosts: Vec<KnownHostRecord>,
    pub workspace: WorkspaceSnapshot,
    pub preferences: AppPreferences,
}

fn required(value: &str, name: &'static str) -> Result<String, DomainError> {
    let value = value.trim();
    if value.is_empty() {
        Err(DomainError::Required(name))
    } else {
        Ok(value.to_string())
    }
}

fn valid_hostname(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('-') && !value.chars().any(char::is_whitespace)
}

fn valid_host_color(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        value.len() == 7
            && value.starts_with('#')
            && value[1..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
    })
}

fn trim_optional(value: &mut Option<String>) {
    *value = value
        .take()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty());
}

fn blank(value: &Option<String>) -> bool {
    value.as_ref().is_none_or(|item| item.is_empty())
}

fn default_ssh_port() -> u16 {
    22
}

fn default_bind_address() -> String {
    "127.0.0.1".to_string()
}

fn default_auto() -> String {
    "auto".to_string()
}

fn default_font_size() -> f64 {
    13.0
}

fn default_snapshot_version() -> u32 {
    1
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_language() -> String {
    "system".to_string()
}

fn default_font_name() -> String {
    "auto".to_string()
}

fn default_password_assist() -> String {
    "hint".to_string()
}

fn default_overview_refresh_interval() -> u8 {
    5
}

fn default_processes_refresh_interval() -> u8 {
    3
}

fn default_docker_refresh_interval() -> u8 {
    5
}

fn default_sftp_file_transfer_concurrency() -> u8 {
    2
}

fn default_sftp_chunk_concurrency() -> u8 {
    32
}

fn default_sftp_chunk_size() -> u32 {
    256 * 1024
}

fn default_sftp_idle_seconds() -> u32 {
    5 * 60
}

fn default_true() -> bool {
    true
}

fn normalized_sizes(sizes: &[f64], count: usize) -> Vec<f64> {
    if count == 0
        || sizes.len() != count
        || sizes.iter().any(|size| !size.is_finite() || *size <= 0.0)
    {
        return vec![1.0 / count.max(1) as f64; count];
    }
    let total = sizes.iter().sum::<f64>();
    sizes.iter().map(|size| size / total).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_hostnames() {
        assert!(!valid_hostname("-oProxyCommand=bad"));
        assert!(!valid_hostname("host name"));
        assert!(valid_hostname("example.com"));
    }

    #[test]
    fn workspace_node_collects_nested_sessions() {
        let root = WorkspaceNode::Split {
            id: new_id(),
            axis: SplitAxis::Vertical,
            children: vec![
                WorkspaceNode::Pane {
                    id: new_id(),
                    session_id: "one".to_string(),
                },
                WorkspaceNode::TabGroup {
                    id: new_id(),
                    session_ids: vec!["two".to_string(), "three".to_string()],
                    active_session_id: "two".to_string(),
                },
            ],
            sizes: vec![0.5, 0.5],
        };
        assert_eq!(root.session_ids(), vec!["one", "two", "three"]);
    }

    #[test]
    fn workspace_pruning_collapses_tabs_and_preserves_split_ratios() {
        let root = WorkspaceNode::Split {
            id: "root".to_string(),
            axis: SplitAxis::Vertical,
            children: vec![
                WorkspaceNode::Pane {
                    id: "one-pane".to_string(),
                    session_id: "one".to_string(),
                },
                WorkspaceNode::TabGroup {
                    id: "tabs".to_string(),
                    session_ids: vec!["two".to_string(), "missing".to_string()],
                    active_session_id: "missing".to_string(),
                },
                WorkspaceNode::Pane {
                    id: "three-pane".to_string(),
                    session_id: "three".to_string(),
                },
            ],
            sizes: vec![0.2, 0.3, 0.5],
        };
        let valid = ["one".to_string(), "two".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();

        let pruned = root.pruned(&valid).expect("pruned workspace");

        assert_eq!(pruned.session_ids(), vec!["one", "two"]);
        let WorkspaceNode::Split {
            children, sizes, ..
        } = pruned
        else {
            panic!("expected split");
        };
        assert!(matches!(children[1], WorkspaceNode::Pane { .. }));
        assert!((sizes[0] - 0.4).abs() < f64::EPSILON);
        assert!((sizes[1] - 0.6).abs() < f64::EPSILON);
    }

    #[test]
    fn validates_authentication_specific_host_and_credential_fields() {
        let mut host: Host = serde_json::from_value(serde_json::json!({
            "label": " server ",
            "hostname": "example.com",
            "username": " root ",
            "authentication": "identityFile"
        }))
        .expect("host");
        assert!(matches!(host.validate(), Err(DomainError::MissingIdentity)));

        host.identity_key = Some("private-key".to_string());
        host.validate().expect("valid identity host");
        assert_eq!(host.label, "server");
        assert_eq!(host.username, "root");

        let mut credential: Credential = serde_json::from_value(serde_json::json!({
            "label": " Login ",
            "username": " deploy ",
            "kind": "password",
            "password": "secret"
        }))
        .expect("credential");
        credential.validate().expect("valid credential");
        assert_eq!(credential.label, "Login");
        assert_eq!(credential.username, "deploy");
        assert!(credential.private_key.is_none());
    }

    #[test]
    fn normalizes_host_appearance_like_swift() {
        let mut automatic: Host = serde_json::from_value(serde_json::json!({
            "label": "Automatic",
            "hostname": "example.com",
            "username": "root",
            "iconMode": "auto",
            "iconId": "database",
            "iconColorMode": "auto",
            "iconColor": "red",
            "iconColorCustom": "#ABCDEF"
        }))
        .expect("automatic appearance");
        automatic.validate().expect("validate automatic appearance");
        assert_eq!(automatic.icon_id, None);
        assert_eq!(automatic.icon_color, None);
        assert_eq!(automatic.icon_color_custom, None);

        let mut manual: Host = serde_json::from_value(serde_json::json!({
            "label": "Manual",
            "hostname": "example.com",
            "username": "root",
            "iconMode": "custom",
            "iconColorMode": "manual",
            "iconColorCustom": "invalid"
        }))
        .expect("manual appearance");
        manual.validate().expect("validate manual appearance");
        assert_eq!(manual.icon_id.as_deref(), Some("server"));
        assert_eq!(manual.icon_color.as_deref(), Some("blue"));
        assert_eq!(manual.icon_color_custom, None);
    }

    #[test]
    fn app_preferences_match_swift_autocomplete_defaults() {
        let preferences = AppPreferences::default();
        assert!(preferences.autocomplete_enabled);
        assert!(preferences.autocomplete_popup);
        assert!(!preferences.autocomplete_ghost_text);
        assert_eq!(preferences.password_prompt_assist, "hint");
        assert!(preferences.auto_open_system_overview);
        assert!(!preferences.auto_accept_ssh_host_keys);
        assert_eq!(preferences.overview_refresh_interval, 5);
        assert_eq!(preferences.processes_refresh_interval, 3);
        assert_eq!(preferences.docker_refresh_interval, 5);
        assert!(preferences.sftp_shows_hidden_files);
        assert_eq!(preferences.sftp_file_transfer_concurrency, 2);
        assert_eq!(preferences.sftp_chunk_concurrency, 32);
        assert_eq!(preferences.sftp_chunk_size_bytes, 256 * 1024);
        assert_eq!(preferences.sftp_transfer_connection_idle_seconds, 300);
    }

    #[test]
    fn normalizes_preference_ranges_and_exclusive_autocomplete_modes() {
        let mut preferences = AppPreferences {
            terminal_font_size: 100.0,
            autocomplete_ghost_text: true,
            password_prompt_assist: "automatic".to_string(),
            overview_refresh_interval: 0,
            sftp_file_transfer_concurrency: 100,
            sftp_chunk_concurrency: 0,
            sftp_chunk_size_bytes: 123,
            sftp_transfer_connection_idle_seconds: 12,
            ..AppPreferences::default()
        };

        preferences.normalize();

        assert_eq!(preferences.terminal_font_size, 36.0);
        assert!(!preferences.autocomplete_ghost_text);
        assert_eq!(preferences.password_prompt_assist, "picker");
        assert_eq!(preferences.overview_refresh_interval, 1);
        assert_eq!(preferences.sftp_file_transfer_concurrency, 16);
        assert_eq!(preferences.sftp_chunk_concurrency, 1);
        assert_eq!(preferences.sftp_chunk_size_bytes, 256 * 1024);
        assert_eq!(preferences.sftp_transfer_connection_idle_seconds, 300);
    }
}
