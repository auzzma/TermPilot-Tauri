use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use directories::BaseDirs;
use parking_lot::Mutex;
use rusqlite::{named_params, params, Connection, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

use crate::backup::{BackupImportSummary, BackupSnapshot};
use crate::domain::{
    now, AppPreferences, AutomationScript, BootstrapSnapshot, CommandHistoryEntry,
    ConnectionHistoryEntry, Credential, Host, HostGroup, HostNote, KnownHostRecord,
    PortForwardRule, ProxyConfiguration, ProxyProfile, ProxyType, Snippet, WorkspaceSnapshot,
};

const ENCRYPTED_PREFIX: &str = "enc:v1:";
const PORTABLE_CREDENTIAL_KEY_PREFIX: &[u8] = b"TermPilot portable credential key v1\0";
const APPLE_REFERENCE_UNIX_SECONDS: f64 = 978_307_200.0;
#[cfg(target_os = "macos")]
const SWIFT_PREFERENCES_DOMAIN: &str = "com.termpilot.app";
const SWIFT_MIGRATIONS: &[&str] = &[
    "v1",
    "v2-host-password",
    "v3-host-group-parent",
    "v4-host-sftp-options",
    "v5-phase-5-7-local-workflows",
    "v6-ssh-credentials",
    "v7-credential-elevation-password",
    "v8-ssh-proxies",
    "v9-remove-external-protocols",
    "v10-host-appearance",
    "v11-server-tools-root",
    "v12-server-tools-elevation-method",
    "v13-host-sort-order",
    "v14-remove-host-last-connected",
    "v15-proxy-script-sort-order",
];

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("credential encryption failed")]
    Encryption,
    #[error("credential decryption failed")]
    Decryption,
    #[error("credential key is invalid")]
    InvalidKey,
    #[error("user data directory is unavailable")]
    DataDirectoryUnavailable,
    #[cfg(windows)]
    #[error("platform key protection failed")]
    KeyProtection,
}

pub fn shared_data_directory() -> Result<PathBuf, VaultError> {
    BaseDirs::new()
        .map(|directories| directories.data_dir().join("TermPilot"))
        .ok_or(VaultError::DataDirectoryUnavailable)
}

#[cfg(any(windows, test))]
pub fn portable_data_directory(executable: &Path) -> Result<PathBuf, VaultError> {
    executable
        .parent()
        .map(|directory| directory.join("data"))
        .ok_or(VaultError::DataDirectoryUnavailable)
}

pub fn default_data_directory() -> Result<PathBuf, VaultError> {
    #[cfg(windows)]
    {
        portable_data_directory(&std::env::current_exe()?)
    }
    #[cfg(not(windows))]
    {
        shared_data_directory()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CredentialKeyStorage {
    #[cfg(any(not(windows), test))]
    PlatformProtected,
    #[cfg(any(windows, test))]
    Portable,
}

impl CredentialKeyStorage {
    fn is_portable(self) -> bool {
        match self {
            #[cfg(any(not(windows), test))]
            Self::PlatformProtected => false,
            #[cfg(any(windows, test))]
            Self::Portable => true,
        }
    }
}

pub struct VaultStore {
    connection: Mutex<Connection>,
    cipher: CredentialCipher,
    data_directory: PathBuf,
    uses_swift_preferences: bool,
}

impl VaultStore {
    #[cfg(any(not(windows), test))]
    pub fn open(data_directory: PathBuf) -> Result<Self, VaultError> {
        Self::open_with_key_storage(data_directory, CredentialKeyStorage::PlatformProtected)
    }

    #[cfg(any(windows, test))]
    pub fn open_portable(data_directory: PathBuf) -> Result<Self, VaultError> {
        fs::create_dir_all(data_directory.join("webview"))?;
        Self::open_with_key_storage(data_directory, CredentialKeyStorage::Portable)
    }

    fn open_with_key_storage(
        data_directory: PathBuf,
        key_storage: CredentialKeyStorage,
    ) -> Result<Self, VaultError> {
        fs::create_dir_all(&data_directory)?;
        set_private_directory_permissions(&data_directory)?;
        let connection = Connection::open(data_directory.join("vault.sqlite"))?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&connection)?;
        let cipher =
            CredentialCipher::load_or_create(&data_directory.join("credential.key"), key_storage)?;
        let uses_swift_preferences = cfg!(target_os = "macos")
            && shared_data_directory().is_ok_and(|shared| shared == data_directory);
        Ok(Self {
            connection: Mutex::new(connection),
            cipher,
            data_directory,
            uses_swift_preferences,
        })
    }

    #[cfg(any(windows, test))]
    pub fn webview_data_directory(&self) -> PathBuf {
        self.data_directory.join("webview")
    }

    pub fn bootstrap(&self, platform: String) -> Result<BootstrapSnapshot, VaultError> {
        Ok(BootstrapSnapshot {
            platform,
            hosts: self.hosts()?,
            groups: self.groups()?,
            credentials: self.credentials()?,
            proxies: self.proxies()?,
            forwards: self.forwards()?,
            scripts: self.scripts()?,
            snippets: self.snippets()?,
            notes: self.notes()?,
            history: self.history(1000)?,
            command_history: Vec::new(),
            known_hosts: self.known_hosts()?,
            workspace: self.workspace()?,
            preferences: self.preferences()?,
        })
    }

    pub fn backup_snapshot(&self) -> Result<BackupSnapshot, VaultError> {
        Ok(BackupSnapshot::new(
            self.hosts()?,
            self.groups()?,
            self.credentials()?,
            self.proxies()?,
            self.forwards()?,
            self.scripts()?,
            self.notes()?,
        ))
    }

    pub fn import_backup_snapshot(
        &self,
        snapshot: BackupSnapshot,
    ) -> Result<BackupImportSummary, VaultError> {
        if snapshot.schema_version != 1 {
            return Err(invalid_input("unsupported backup version"));
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;

        for credential in &snapshot.credentials {
            upsert_imported_credential(&transaction, &self.cipher, credential.clone())?;
        }
        let credential_ids = query_id_set(&transaction, "SELECT id FROM ssh_credentials")?;

        let existing_proxy_orders = query_order_map(
            &transaction,
            "SELECT id, sort_order FROM ssh_proxy_profiles",
        )?;
        let mut next_proxy_order = existing_proxy_orders.values().copied().max().unwrap_or(-1) + 1;
        for mut profile in snapshot.proxy_profiles.clone() {
            if profile
                .configuration
                .credential_id
                .as_ref()
                .is_some_and(|id| !credential_ids.contains(id))
            {
                profile.configuration.credential_id = None;
            }
            profile.sort_order = existing_proxy_orders
                .get(&profile.id)
                .copied()
                .unwrap_or_else(|| {
                    let order = next_proxy_order;
                    next_proxy_order += 1;
                    order
                });
            upsert_imported_proxy(&transaction, &self.cipher, profile)?;
        }
        let proxy_ids = query_id_set(&transaction, "SELECT id FROM ssh_proxy_profiles")?;

        let existing_group_ids = query_id_set(&transaction, "SELECT id FROM host_groups")?;
        let ordered_groups = ordered_backup_groups(&snapshot.groups, &existing_group_ids)?;
        validate_imported_group_graph(&transaction, &ordered_groups)?;
        for group in &ordered_groups {
            upsert_imported_group(&transaction, group.clone())?;
        }
        let group_ids = query_id_set(&transaction, "SELECT id FROM host_groups")?;

        let existing_hosts = hosts_from_connection(&transaction, &self.cipher)?;
        let existing_host_ids = existing_hosts
            .iter()
            .map(|host| host.id.clone())
            .collect::<HashSet<_>>();
        let mut host_id_by_identity = HashMap::new();
        for host in &existing_hosts {
            host_id_by_identity.insert(
                normalized_backup_host_identity(&host.hostname),
                host.id.clone(),
            );
        }
        let mut host_id_replacements = HashMap::new();
        let mut deduplicated_host_ids = HashSet::new();
        for host in &snapshot.hosts {
            let identity = normalized_backup_host_identity(&host.hostname);
            if let Some(existing_id) = host_id_by_identity.get(&identity) {
                host_id_replacements.insert(host.id.clone(), existing_id.clone());
                if existing_id != &host.id || existing_host_ids.contains(existing_id) {
                    deduplicated_host_ids.insert(host.id.clone());
                }
            } else {
                host_id_replacements.insert(host.id.clone(), host.id.clone());
                host_id_by_identity.insert(identity, host.id.clone());
            }
        }

        let mut saved_host_ids = HashSet::new();
        for source in &snapshot.hosts {
            let Some(target_id) = host_id_replacements.get(&source.id).cloned() else {
                continue;
            };
            if !saved_host_ids.insert(target_id.clone()) {
                continue;
            }
            let mut host = source.clone();
            host.id = target_id.clone();
            if let Some(existing) = existing_hosts.iter().find(|host| host.id == target_id) {
                host.created_at = existing.created_at.clone();
            }
            if host
                .group_id
                .as_ref()
                .is_some_and(|id| !group_ids.contains(id))
            {
                host.group_id = None;
            }
            if host
                .credential_id
                .as_ref()
                .is_some_and(|id| !credential_ids.contains(id))
            {
                host.credential_id = None;
            }
            if host
                .proxy_profile_id
                .as_ref()
                .is_some_and(|id| !proxy_ids.contains(id))
            {
                host.proxy_profile_id = None;
            }
            if let Some(proxy) = &mut host.proxy_configuration {
                if proxy
                    .credential_id
                    .as_ref()
                    .is_some_and(|id| !credential_ids.contains(id))
                {
                    proxy.credential_id = None;
                }
            }
            upsert_imported_host(&transaction, &self.cipher, host)?;
        }

        let available_host_ids = query_id_set(&transaction, "SELECT id FROM hosts")?;
        let map_host_id = |host_id: &Option<String>| {
            host_id.as_ref().and_then(|id| {
                host_id_replacements
                    .get(id)
                    .cloned()
                    .or_else(|| available_host_ids.contains(id).then(|| id.clone()))
            })
        };

        for mut rule in snapshot.port_forward_rules.clone() {
            rule.host_id = map_host_id(&rule.host_id);
            rule.status = crate::domain::PortForwardStatus::Inactive;
            rule.error = None;
            upsert_imported_forward(&transaction, rule)?;
        }

        let existing_script_orders = query_order_map(
            &transaction,
            "SELECT id, sort_order FROM automation_scripts",
        )?;
        let mut next_script_order =
            existing_script_orders.values().copied().max().unwrap_or(-1) + 1;
        for mut script in snapshot.automation_scripts.clone() {
            script.sort_order = existing_script_orders
                .get(&script.id)
                .copied()
                .unwrap_or_else(|| {
                    let order = next_script_order;
                    next_script_order += 1;
                    order
                });
            upsert_imported_script(&transaction, script)?;
        }

        for mut note in snapshot.host_notes.clone() {
            note.host_id = map_host_id(&note.host_id);
            upsert_imported_note(&transaction, note)?;
        }

        let summary = BackupImportSummary {
            hosts: saved_host_ids.len(),
            deduplicated_hosts: deduplicated_host_ids.len(),
            groups: snapshot.groups.len(),
            credentials: snapshot.credentials.len(),
            proxy_profiles: snapshot.proxy_profiles.len(),
            port_forward_rules: snapshot.port_forward_rules.len(),
            automation_scripts: snapshot.automation_scripts.len(),
            host_notes: snapshot.host_notes.len(),
        };
        transaction.commit()?;
        Ok(summary)
    }

    pub fn save_host(&self, host: Host) -> Result<Host, VaultError> {
        let mut saved = self.save_hosts(vec![host])?;
        Ok(saved.remove(0))
    }

    pub fn save_hosts(&self, hosts: Vec<Host>) -> Result<Vec<Host>, VaultError> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let mut saved = Vec::with_capacity(hosts.len());
        for mut host in hosts {
            host.validate().map_err(|_| invalid_input("invalid host"))?;
            let existing_group = transaction
                .query_row(
                    "SELECT group_id FROM hosts WHERE id = ?1",
                    params![host.id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?;
            if existing_group.as_ref() != Some(&host.group_id) {
                host.sort_order = transaction.query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1
                     FROM hosts WHERE group_id IS ?1",
                    params![host.group_id],
                    |row| row.get(0),
                )?;
            }

            let authentication = encode_enum(&host.authentication)?;
            let sftp_file_protocol = encode_enum(&host.sftp_file_protocol)?;
            let sftp_filename_encoding = encode_enum(&host.sftp_filename_encoding)?;
            let elevation_method = encode_enum(&host.server_tools_elevation_method)?;
            let password = encrypt_optional_value(&self.cipher, host.password.as_deref())?;
            let (
                proxy_type,
                proxy_host,
                proxy_port,
                proxy_command,
                proxy_credential_reference,
                proxy_username,
                proxy_password,
            ) = if let Some(proxy) = &host.proxy_configuration {
                (
                    Some(encode_enum(&proxy.proxy_type)?),
                    Some(proxy.host.as_str()),
                    Some(i64::from(proxy.port)),
                    proxy.command.as_deref(),
                    proxy.credential_id.as_deref(),
                    proxy.username.as_deref(),
                    encrypt_optional_value(&self.cipher, proxy.password.as_deref())?,
                )
            } else {
                (None, None, None, None, None, None, None)
            };

            transaction.execute(
                "INSERT INTO hosts (
                    id, label, hostname, port, username, authentication,
                    identity_file, credential_reference, group_id, created_at,
                    updated_at, password, sftp_file_protocol,
                    sftp_filename_encoding, sftp_uses_sudo,
                    sftp_follows_terminal_cwd, proxy_profile_reference,
                    proxy_type, proxy_host, proxy_port, proxy_command,
                    proxy_credential_reference, proxy_username, proxy_password,
                    distro, distro_mode, manual_distro, icon_mode, icon_id,
                    icon_color_mode, icon_color, icon_color_custom,
                    server_tools_use_root, server_tools_elevation_method,
                    sort_order
                 ) VALUES (
                    :id, :label, :hostname, :port, :username, :authentication,
                    :identity_file, :credential_reference, :group_id, :created_at,
                    :updated_at, :password, :sftp_file_protocol,
                    :sftp_filename_encoding, :sftp_uses_sudo,
                    :sftp_follows_terminal_cwd, :proxy_profile_reference,
                    :proxy_type, :proxy_host, :proxy_port, :proxy_command,
                    :proxy_credential_reference, :proxy_username, :proxy_password,
                    :distro, :distro_mode, :manual_distro, :icon_mode, :icon_id,
                    :icon_color_mode, :icon_color, :icon_color_custom,
                    :server_tools_use_root, :server_tools_elevation_method,
                    :sort_order
                 )
                 ON CONFLICT(id) DO UPDATE SET
                    label=excluded.label,
                    hostname=excluded.hostname,
                    port=excluded.port,
                    username=excluded.username,
                    authentication=excluded.authentication,
                    identity_file=excluded.identity_file,
                    credential_reference=excluded.credential_reference,
                    group_id=excluded.group_id,
                    created_at=excluded.created_at,
                    updated_at=excluded.updated_at,
                    password=excluded.password,
                    sftp_file_protocol=excluded.sftp_file_protocol,
                    sftp_filename_encoding=excluded.sftp_filename_encoding,
                    sftp_uses_sudo=excluded.sftp_uses_sudo,
                    sftp_follows_terminal_cwd=excluded.sftp_follows_terminal_cwd,
                    proxy_profile_reference=excluded.proxy_profile_reference,
                    proxy_type=excluded.proxy_type,
                    proxy_host=excluded.proxy_host,
                    proxy_port=excluded.proxy_port,
                    proxy_command=excluded.proxy_command,
                    proxy_credential_reference=excluded.proxy_credential_reference,
                    proxy_username=excluded.proxy_username,
                    proxy_password=excluded.proxy_password,
                    distro=excluded.distro,
                    distro_mode=excluded.distro_mode,
                    manual_distro=excluded.manual_distro,
                    icon_mode=excluded.icon_mode,
                    icon_id=excluded.icon_id,
                    icon_color_mode=excluded.icon_color_mode,
                    icon_color=excluded.icon_color,
                    icon_color_custom=excluded.icon_color_custom,
                    server_tools_use_root=excluded.server_tools_use_root,
                    server_tools_elevation_method=excluded.server_tools_elevation_method,
                    sort_order=excluded.sort_order",
                named_params! {
                    ":id": &host.id,
                    ":label": &host.label,
                    ":hostname": &host.hostname,
                    ":port": i64::from(host.port),
                    ":username": &host.username,
                    ":authentication": authentication,
                    ":identity_file": &host.identity_file,
                    ":credential_reference": &host.credential_id,
                    ":group_id": &host.group_id,
                    ":created_at": date_to_database(&host.created_at),
                    ":updated_at": date_to_database(&host.updated_at),
                    ":password": password,
                    ":sftp_file_protocol": sftp_file_protocol,
                    ":sftp_filename_encoding": sftp_filename_encoding,
                    ":sftp_uses_sudo": host.sftp_uses_sudo,
                    ":sftp_follows_terminal_cwd": host.sftp_follows_terminal_cwd,
                    ":proxy_profile_reference": &host.proxy_profile_id,
                    ":proxy_type": proxy_type,
                    ":proxy_host": proxy_host,
                    ":proxy_port": proxy_port,
                    ":proxy_command": proxy_command,
                    ":proxy_credential_reference": proxy_credential_reference,
                    ":proxy_username": proxy_username,
                    ":proxy_password": proxy_password,
                    ":distro": &host.distro,
                    ":distro_mode": &host.distro_mode,
                    ":manual_distro": &host.manual_distro,
                    ":icon_mode": &host.icon_mode,
                    ":icon_id": &host.icon_id,
                    ":icon_color_mode": &host.icon_color_mode,
                    ":icon_color": &host.icon_color,
                    ":icon_color_custom": &host.icon_color_custom,
                    ":server_tools_use_root": host.server_tools_use_root,
                    ":server_tools_elevation_method": elevation_method,
                    ":sort_order": host.sort_order,
                },
            )?;
            saved.push(host);
        }
        transaction.commit()?;
        Ok(saved)
    }

    pub fn delete_host(&self, id: &str) -> Result<(), VaultError> {
        self.connection
            .lock()
            .execute("DELETE FROM hosts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn save_group(&self, mut group: HostGroup) -> Result<HostGroup, VaultError> {
        group
            .validate()
            .map_err(|_| invalid_input("invalid group"))?;
        if group.parent_group_id.as_deref() == Some(group.id.as_str()) {
            return Err(invalid_input("invalid group parent"));
        }
        self.connection.lock().execute(
            "INSERT INTO host_groups (id, name, sort_order, parent_group_id)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                sort_order=excluded.sort_order,
                parent_group_id=excluded.parent_group_id",
            params![
                group.id,
                group.name,
                group.sort_order,
                group.parent_group_id
            ],
        )?;
        Ok(group)
    }

    pub fn delete_group(&self, id: &str) -> Result<(), VaultError> {
        let mut connection = self.connection.lock();
        let relations = {
            let mut statement =
                connection.prepare("SELECT id, parent_group_id FROM host_groups")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut group_ids = HashSet::from([id.to_string()]);
        loop {
            let previous_count = group_ids.len();
            for (group_id, parent_id) in &relations {
                if parent_id
                    .as_ref()
                    .is_some_and(|parent_id| group_ids.contains(parent_id))
                {
                    group_ids.insert(group_id.clone());
                }
            }
            if group_ids.len() == previous_count {
                break;
            }
        }

        let transaction = connection.transaction()?;
        let updated_at = date_to_database(&now());
        for group_id in group_ids {
            transaction.execute(
                "UPDATE hosts SET group_id = NULL, updated_at = ?1 WHERE group_id = ?2",
                params![updated_at, group_id],
            )?;
            transaction.execute("DELETE FROM host_groups WHERE id = ?1", params![group_id])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn save_credential(&self, mut credential: Credential) -> Result<Credential, VaultError> {
        credential
            .validate()
            .map_err(|_| invalid_input("invalid credential"))?;
        let plaintext = credential.clone();
        let kind = encode_enum(&credential.kind)?;
        let password = encrypt_optional_value(&self.cipher, credential.password.as_deref())?;
        let private_key = encrypt_optional_value(&self.cipher, credential.private_key.as_deref())?;
        let passphrase = encrypt_optional_value(&self.cipher, credential.passphrase.as_deref())?;
        let elevation_password =
            encrypt_optional_value(&self.cipher, credential.elevation_password.as_deref())?;
        self.connection.lock().execute(
            "INSERT INTO ssh_credentials (
                id, label, username, kind, password, private_key, public_key,
                certificate, passphrase, saves_passphrase, created_at,
                updated_at, elevation_password
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
             )
             ON CONFLICT(id) DO UPDATE SET
                label=excluded.label,
                username=excluded.username,
                kind=excluded.kind,
                password=excluded.password,
                private_key=excluded.private_key,
                public_key=excluded.public_key,
                certificate=excluded.certificate,
                passphrase=excluded.passphrase,
                saves_passphrase=excluded.saves_passphrase,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at,
                elevation_password=excluded.elevation_password",
            params![
                credential.id,
                credential.label,
                credential.username,
                kind,
                password,
                private_key,
                credential.public_key,
                credential.certificate,
                passphrase,
                credential.saves_passphrase,
                date_to_database(&credential.created_at),
                date_to_database(&credential.updated_at),
                elevation_password,
            ],
        )?;
        Ok(plaintext)
    }

    pub fn delete_credential(&self, id: &str) -> Result<(), VaultError> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE hosts SET credential_reference = NULL, updated_at = ?1
             WHERE credential_reference = ?2",
            params![date_to_database(&now()), id],
        )?;
        transaction.execute("DELETE FROM ssh_credentials WHERE id = ?1", params![id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_proxy(&self, mut profile: ProxyProfile) -> Result<ProxyProfile, VaultError> {
        profile
            .validate()
            .map_err(|_| invalid_input("invalid proxy"))?;
        let plaintext = profile.clone();
        let proxy_type = encode_enum(&profile.configuration.proxy_type)?;
        let password =
            encrypt_optional_value(&self.cipher, profile.configuration.password.as_deref())?;
        self.connection.lock().execute(
            "INSERT INTO ssh_proxy_profiles (
                id, label, type, host, port, command, credential_reference,
                username, password, created_at, updated_at, sort_order
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                label=excluded.label,
                type=excluded.type,
                host=excluded.host,
                port=excluded.port,
                command=excluded.command,
                credential_reference=excluded.credential_reference,
                username=excluded.username,
                password=excluded.password,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at,
                sort_order=excluded.sort_order",
            params![
                profile.id,
                profile.label,
                proxy_type,
                profile.configuration.host,
                i64::from(profile.configuration.port),
                profile.configuration.command,
                profile.configuration.credential_id,
                profile.configuration.username,
                password,
                date_to_database(&profile.created_at),
                date_to_database(&profile.updated_at),
                profile.sort_order,
            ],
        )?;
        Ok(plaintext)
    }

    pub fn delete_proxy(&self, id: &str) -> Result<(), VaultError> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE hosts SET proxy_profile_reference = NULL, updated_at = ?1
             WHERE proxy_profile_reference = ?2",
            params![date_to_database(&now()), id],
        )?;
        transaction.execute("DELETE FROM ssh_proxy_profiles WHERE id = ?1", params![id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_forward(&self, mut rule: PortForwardRule) -> Result<PortForwardRule, VaultError> {
        rule.validate()
            .map_err(|_| invalid_input("invalid port forward"))?;
        let mut payload = serde_json::to_value(&rule)?;
        swift_encode_dates(&mut payload);
        self.connection.lock().execute(
            "INSERT INTO port_forward_rules (id, host_id, payload, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                host_id=excluded.host_id,
                payload=excluded.payload,
                updated_at=excluded.updated_at",
            params![
                rule.id,
                rule.host_id,
                serde_json::to_vec(&payload)?,
                date_to_database(&rule.updated_at)
            ],
        )?;
        Ok(rule)
    }

    pub fn save_script(
        &self,
        mut script: AutomationScript,
    ) -> Result<AutomationScript, VaultError> {
        script.title = required_value(&script.title, "script title")?;
        script.shell = required_value(&script.shell, "script shell")?;
        script.updated_at = now();
        let mut payload = serde_json::to_value(&script)?;
        if let Value::Object(object) = &mut payload {
            object.remove("sortOrder");
        }
        swift_encode_dates(&mut payload);
        self.connection.lock().execute(
            "INSERT INTO automation_scripts (id, payload, updated_at, sort_order)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                payload=excluded.payload,
                updated_at=excluded.updated_at,
                sort_order=excluded.sort_order",
            params![
                script.id,
                serde_json::to_vec(&payload)?,
                date_to_database(&script.updated_at),
                script.sort_order
            ],
        )?;
        Ok(script)
    }

    pub fn save_snippet(&self, mut snippet: Snippet) -> Result<Snippet, VaultError> {
        snippet.title = required_value(&snippet.title, "snippet title")?;
        snippet.updated_at = now();
        let mut payload = serde_json::to_value(&snippet)?;
        swift_encode_dates(&mut payload);
        self.connection.lock().execute(
            "INSERT INTO snippets (id, payload, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                payload=excluded.payload,
                updated_at=excluded.updated_at",
            params![
                snippet.id,
                serde_json::to_vec(&payload)?,
                date_to_database(&snippet.updated_at)
            ],
        )?;
        Ok(snippet)
    }

    pub fn save_note(&self, mut note: HostNote) -> Result<HostNote, VaultError> {
        note.title = required_value(&note.title, "note title")?;
        note.updated_at = now();
        let mut payload = serde_json::to_value(&note)?;
        swift_encode_dates(&mut payload);
        self.connection.lock().execute(
            "INSERT INTO host_notes (id, host_id, payload, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                host_id=excluded.host_id,
                payload=excluded.payload,
                updated_at=excluded.updated_at",
            params![
                note.id,
                note.host_id,
                serde_json::to_vec(&payload)?,
                date_to_database(&note.updated_at)
            ],
        )?;
        Ok(note)
    }

    pub fn delete_entity(&self, kind: &str, id: &str) -> Result<(), VaultError> {
        let table = match kind {
            "forward" => "port_forward_rules",
            "script" => "automation_scripts",
            "snippet" => "snippets",
            "note" => "host_notes",
            _ => return Err(invalid_input("invalid entity kind")),
        };
        self.connection
            .lock()
            .execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?;
        Ok(())
    }

    pub fn append_history(&self, entry: ConnectionHistoryEntry) -> Result<(), VaultError> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO connection_history (
                id, host_id, started_at, ended_at, succeeded, error_category
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry.id,
                entry.host_id,
                date_to_database(&entry.started_at),
                entry.ended_at.as_deref().map(date_to_database),
                entry.succeeded,
                entry.error_category
            ],
        )?;
        transaction.execute(
            "DELETE FROM connection_history WHERE id IN (
                SELECT id FROM connection_history
                ORDER BY started_at DESC LIMIT -1 OFFSET 1000
             )",
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn append_command_history(&self, _entry: CommandHistoryEntry) -> Result<(), VaultError> {
        Ok(())
    }

    pub fn save_workspace(&self, mut snapshot: WorkspaceSnapshot) -> Result<(), VaultError> {
        snapshot.version = 1;
        snapshot.saved_at = now();
        let valid_sessions = snapshot
            .sessions
            .iter()
            .map(|session| session.id.clone())
            .collect::<HashSet<_>>();
        snapshot.workspaces = snapshot
            .workspaces
            .into_iter()
            .filter_map(|mut workspace| {
                workspace.root = workspace.root.pruned(&valid_sessions)?;
                let session_ids = workspace.root.session_ids();
                if !session_ids.contains(&workspace.focused_session_id) {
                    workspace.focused_session_id = session_ids[0].clone();
                }
                Some(workspace)
            })
            .collect();
        let referenced = snapshot
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.root.session_ids())
            .collect::<HashSet<_>>();
        snapshot
            .sessions
            .retain(|session| referenced.contains(&session.id));
        let workspace_ids = snapshot
            .workspaces
            .iter()
            .map(|workspace| workspace.id.as_str())
            .collect::<HashSet<_>>();
        if snapshot
            .active_workspace_id
            .as_deref()
            .is_none_or(|id| !workspace_ids.contains(id))
        {
            snapshot.active_workspace_id = snapshot
                .workspaces
                .first()
                .map(|workspace| workspace.id.clone());
        }
        let mut payload = serde_json::to_value(&snapshot)?;
        swift_encode_dates(&mut payload);
        self.connection.lock().execute(
            "INSERT INTO workspace_state (id, payload, saved_at)
             VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET
                payload=excluded.payload,
                saved_at=excluded.saved_at",
            params![
                serde_json::to_vec(&payload)?,
                date_to_database(&snapshot.saved_at)
            ],
        )?;
        Ok(())
    }

    pub fn erase_workspace(&self) -> Result<(), VaultError> {
        self.connection
            .lock()
            .execute("DELETE FROM workspace_state WHERE id = 1", [])?;
        Ok(())
    }

    pub fn save_preferences(&self, mut preferences: AppPreferences) -> Result<(), VaultError> {
        preferences.normalize();
        if self.uses_swift_preferences {
            save_swift_preferences(&preferences)
        } else {
            let payload = serde_json::to_vec_pretty(&preferences)?;
            fs::write(self.data_directory.join("preferences.json"), payload)?;
            Ok(())
        }
    }

    pub fn known_hosts_path(&self) -> PathBuf {
        self.data_directory.join("known_hosts")
    }

    pub fn delete_known_host(&self, id: &str) -> Result<(), VaultError> {
        self.delete_known_hosts(&HashSet::from([id.to_string()]))
    }

    pub fn delete_known_hosts(&self, ids: &HashSet<String>) -> Result<(), VaultError> {
        if ids.is_empty() {
            return Ok(());
        }
        let path = self.known_hosts_path();
        let content = fs::read_to_string(&path).unwrap_or_default();
        let retained = content
            .lines()
            .enumerate()
            .filter(|(index, line)| !ids.contains(&known_host_id(*index, line)))
            .map(|(_, line)| line)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(
            path,
            if retained.is_empty() {
                retained
            } else {
                retained + "\n"
            },
        )?;
        Ok(())
    }

    fn hosts(&self) -> Result<Vec<Host>, VaultError> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT * FROM hosts
             ORDER BY group_id, sort_order, label COLLATE NOCASE",
        )?;
        let mut rows = statement.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(host_from_row(row, &self.cipher)?);
        }
        Ok(result)
    }

    fn groups(&self) -> Result<Vec<HostGroup>, VaultError> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, name, parent_group_id, sort_order
             FROM host_groups ORDER BY parent_group_id, sort_order, name",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(HostGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_group_id: row.get(2)?,
                sort_order: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn credentials(&self) -> Result<Vec<Credential>, VaultError> {
        let connection = self.connection.lock();
        let mut statement =
            connection.prepare("SELECT * FROM ssh_credentials ORDER BY label COLLATE NOCASE")?;
        let mut rows = statement.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(credential_from_row(row, &self.cipher)?);
        }
        Ok(result)
    }

    fn proxies(&self) -> Result<Vec<ProxyProfile>, VaultError> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT * FROM ssh_proxy_profiles
             ORDER BY sort_order, created_at, label COLLATE NOCASE",
        )?;
        let mut rows = statement.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            if let Some(profile) = proxy_from_row(row, &self.cipher)? {
                result.push(profile);
            }
        }
        Ok(result)
    }

    fn forwards(&self) -> Result<Vec<PortForwardRule>, VaultError> {
        self.payload_rows("SELECT payload FROM port_forward_rules ORDER BY updated_at DESC")
    }

    fn scripts(&self) -> Result<Vec<AutomationScript>, VaultError> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT payload, sort_order FROM automation_scripts
             ORDER BY sort_order, updated_at",
        )?;
        let mut rows = statement.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            let payload: Vec<u8> = row.get(0)?;
            let mut script: AutomationScript = decode_swift_payload(&payload)?;
            script.sort_order = row.get(1)?;
            result.push(script);
        }
        Ok(result)
    }

    fn snippets(&self) -> Result<Vec<Snippet>, VaultError> {
        let connection = self.connection.lock();
        let mut statement =
            connection.prepare("SELECT payload FROM snippets ORDER BY updated_at DESC")?;
        let mut rows = statement.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            let payload: Vec<u8> = row.get(0)?;
            if let Ok(snippet) = decode_swift_payload(&payload) {
                result.push(snippet);
            }
        }
        Ok(result)
    }

    fn notes(&self) -> Result<Vec<HostNote>, VaultError> {
        self.payload_rows("SELECT payload FROM host_notes ORDER BY updated_at DESC")
    }

    fn history(&self, limit: i64) -> Result<Vec<ConnectionHistoryEntry>, VaultError> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, host_id, started_at, ended_at, succeeded, error_category
             FROM connection_history ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit], |row| {
            Ok(ConnectionHistoryEntry {
                id: row.get(0)?,
                host_id: row.get(1)?,
                started_at: date_from_database(&row.get::<_, String>(2)?),
                ended_at: row
                    .get::<_, Option<String>>(3)?
                    .as_deref()
                    .map(date_from_database),
                succeeded: row.get(4)?,
                error_category: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn workspace(&self) -> Result<WorkspaceSnapshot, VaultError> {
        let payload = self
            .connection
            .lock()
            .query_row(
                "SELECT payload FROM workspace_state WHERE id = 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        payload
            .map(|payload| decode_swift_payload(&payload))
            .transpose()
            .map(|snapshot| snapshot.unwrap_or_default())
    }

    fn preferences(&self) -> Result<AppPreferences, VaultError> {
        let mut preferences = if self.uses_swift_preferences {
            load_swift_preferences()
        } else {
            fs::read(self.data_directory.join("preferences.json"))
                .ok()
                .and_then(|payload| serde_json::from_slice(&payload).ok())
                .unwrap_or_default()
        };
        preferences.normalize();
        Ok(preferences)
    }

    fn known_hosts(&self) -> Result<Vec<KnownHostRecord>, VaultError> {
        let content = fs::read_to_string(self.known_hosts_path()).unwrap_or_default();
        Ok(content
            .lines()
            .enumerate()
            .filter_map(|(index, line)| {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    return None;
                }
                let mut fields = trimmed.split_whitespace();
                Some(KnownHostRecord {
                    id: known_host_id(index, trimmed),
                    hosts: fields.next()?.to_string(),
                    algorithm: fields.next()?.to_string(),
                    key: fields.next()?.to_string(),
                    raw_line: trimmed.to_string(),
                })
            })
            .collect())
    }

    fn payload_rows<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>, VaultError> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(sql)?;
        let mut rows = statement.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(decode_swift_payload(&row.get::<_, Vec<u8>>(0)?)?);
        }
        Ok(result)
    }
}

fn query_id_set(connection: &Connection, sql: &str) -> Result<HashSet<String>, VaultError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<HashSet<_>, _>>()?)
}

fn query_order_map(connection: &Connection, sql: &str) -> Result<HashMap<String, i64>, VaultError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
}

fn hosts_from_connection(
    connection: &Connection,
    cipher: &CredentialCipher,
) -> Result<Vec<Host>, VaultError> {
    let mut statement = connection.prepare(
        "SELECT * FROM hosts
         ORDER BY group_id, sort_order, label COLLATE NOCASE",
    )?;
    let mut rows = statement.query([])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(host_from_row(row, cipher)?);
    }
    Ok(result)
}

fn ordered_backup_groups(
    groups: &[HostGroup],
    existing_group_ids: &HashSet<String>,
) -> Result<Vec<HostGroup>, VaultError> {
    let mut remaining = groups
        .iter()
        .cloned()
        .map(|group| (group.id.clone(), group))
        .collect::<HashMap<_, _>>();
    let mut resolved = existing_group_ids.clone();
    let mut result = Vec::new();
    while !remaining.is_empty() {
        let mut ready = remaining
            .values()
            .filter(|group| {
                group
                    .parent_group_id
                    .as_ref()
                    .is_none_or(|parent| resolved.contains(parent))
            })
            .cloned()
            .collect::<Vec<_>>();
        ready.sort_by(|left, right| {
            left.sort_order
                .cmp(&right.sort_order)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        if ready.is_empty() {
            return Err(invalid_input("invalid group parent"));
        }
        for group in ready {
            remaining.remove(&group.id);
            resolved.insert(group.id.clone());
            result.push(group);
        }
    }
    Ok(result)
}

fn validate_imported_group_graph(
    connection: &Connection,
    groups: &[HostGroup],
) -> Result<(), VaultError> {
    let mut parents = HashMap::<String, Option<String>>::new();
    let mut statement = connection.prepare("SELECT id, parent_group_id FROM host_groups")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    for row in rows {
        let (id, parent) = row?;
        parents.insert(id, parent);
    }
    for group in groups {
        parents.insert(group.id.clone(), group.parent_group_id.clone());
    }
    for group in groups {
        let mut visited = HashSet::from([group.id.clone()]);
        let mut parent = group.parent_group_id.clone();
        while let Some(id) = parent {
            if !visited.insert(id.clone()) {
                return Err(invalid_input("invalid group parent"));
            }
            parent = parents.get(&id).cloned().flatten();
        }
    }
    Ok(())
}

fn normalized_backup_host_identity(hostname: &str) -> String {
    let mut value = hostname.trim().to_lowercase();
    if value.starts_with('[') && value.ends_with(']') {
        value = value[1..value.len() - 1].to_string();
    }
    let ipv4_parts = value.split('.').collect::<Vec<_>>();
    if ipv4_parts.len() == 4 {
        let parsed = ipv4_parts
            .iter()
            .map(|part| part.parse::<u8>())
            .collect::<Result<Vec<_>, _>>();
        if let Ok(parts) = parsed {
            return format!("ipv4:{}.{}.{}.{}", parts[0], parts[1], parts[2], parts[3]);
        }
    }
    if let Ok(address) = value.parse::<Ipv4Addr>() {
        return format!("ipv4:{address}");
    }
    if let Ok(address) = value.parse::<Ipv6Addr>() {
        return format!("ipv6:{address}");
    }
    if value.ends_with('.') {
        value.pop();
    }
    format!("host:{value}")
}

fn upsert_imported_group(connection: &Connection, mut group: HostGroup) -> Result<(), VaultError> {
    group
        .validate()
        .map_err(|_| invalid_input("invalid group"))?;
    if group.parent_group_id.as_deref() == Some(group.id.as_str()) {
        return Err(invalid_input("invalid group parent"));
    }
    connection.execute(
        "INSERT INTO host_groups (id, name, sort_order, parent_group_id)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            sort_order=excluded.sort_order,
            parent_group_id=excluded.parent_group_id",
        params![
            group.id,
            group.name,
            group.sort_order,
            group.parent_group_id
        ],
    )?;
    Ok(())
}

fn upsert_imported_credential(
    connection: &Connection,
    cipher: &CredentialCipher,
    mut credential: Credential,
) -> Result<(), VaultError> {
    let created_at = credential.created_at.clone();
    let updated_at = credential.updated_at.clone();
    credential
        .validate()
        .map_err(|_| invalid_input("invalid credential"))?;
    credential.created_at = created_at;
    credential.updated_at = updated_at;
    let kind = encode_enum(&credential.kind)?;
    let password = encrypt_optional_value(cipher, credential.password.as_deref())?;
    let private_key = encrypt_optional_value(cipher, credential.private_key.as_deref())?;
    let passphrase = encrypt_optional_value(cipher, credential.passphrase.as_deref())?;
    let elevation_password =
        encrypt_optional_value(cipher, credential.elevation_password.as_deref())?;
    connection.execute(
        "INSERT INTO ssh_credentials (
            id, label, username, kind, password, private_key, public_key,
            certificate, passphrase, saves_passphrase, created_at,
            updated_at, elevation_password
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
         )
         ON CONFLICT(id) DO UPDATE SET
            label=excluded.label,
            username=excluded.username,
            kind=excluded.kind,
            password=excluded.password,
            private_key=excluded.private_key,
            public_key=excluded.public_key,
            certificate=excluded.certificate,
            passphrase=excluded.passphrase,
            saves_passphrase=excluded.saves_passphrase,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at,
            elevation_password=excluded.elevation_password",
        params![
            credential.id,
            credential.label,
            credential.username,
            kind,
            password,
            private_key,
            credential.public_key,
            credential.certificate,
            passphrase,
            credential.saves_passphrase,
            date_to_database(&credential.created_at),
            date_to_database(&credential.updated_at),
            elevation_password,
        ],
    )?;
    Ok(())
}

fn upsert_imported_proxy(
    connection: &Connection,
    cipher: &CredentialCipher,
    mut profile: ProxyProfile,
) -> Result<(), VaultError> {
    let created_at = profile.created_at.clone();
    let updated_at = profile.updated_at.clone();
    profile
        .validate()
        .map_err(|_| invalid_input("invalid proxy"))?;
    profile.created_at = created_at;
    profile.updated_at = updated_at;
    let proxy_type = encode_enum(&profile.configuration.proxy_type)?;
    let password = encrypt_optional_value(cipher, profile.configuration.password.as_deref())?;
    connection.execute(
        "INSERT INTO ssh_proxy_profiles (
            id, label, type, host, port, command, credential_reference,
            username, password, created_at, updated_at, sort_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
            label=excluded.label,
            type=excluded.type,
            host=excluded.host,
            port=excluded.port,
            command=excluded.command,
            credential_reference=excluded.credential_reference,
            username=excluded.username,
            password=excluded.password,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at,
            sort_order=excluded.sort_order",
        params![
            profile.id,
            profile.label,
            proxy_type,
            profile.configuration.host,
            i64::from(profile.configuration.port),
            profile.configuration.command,
            profile.configuration.credential_id,
            profile.configuration.username,
            password,
            date_to_database(&profile.created_at),
            date_to_database(&profile.updated_at),
            profile.sort_order,
        ],
    )?;
    Ok(())
}

fn upsert_imported_host(
    connection: &Connection,
    cipher: &CredentialCipher,
    mut host: Host,
) -> Result<(), VaultError> {
    let created_at = host.created_at.clone();
    let updated_at = host.updated_at.clone();
    host.validate().map_err(|_| invalid_input("invalid host"))?;
    host.created_at = created_at;
    host.updated_at = updated_at;
    let authentication = encode_enum(&host.authentication)?;
    let sftp_file_protocol = encode_enum(&host.sftp_file_protocol)?;
    let sftp_filename_encoding = encode_enum(&host.sftp_filename_encoding)?;
    let elevation_method = encode_enum(&host.server_tools_elevation_method)?;
    let password = encrypt_optional_value(cipher, host.password.as_deref())?;
    let (
        proxy_type,
        proxy_host,
        proxy_port,
        proxy_command,
        proxy_credential_reference,
        proxy_username,
        proxy_password,
    ) = if let Some(proxy) = &host.proxy_configuration {
        (
            Some(encode_enum(&proxy.proxy_type)?),
            Some(proxy.host.as_str()),
            Some(i64::from(proxy.port)),
            proxy.command.as_deref(),
            proxy.credential_id.as_deref(),
            proxy.username.as_deref(),
            encrypt_optional_value(cipher, proxy.password.as_deref())?,
        )
    } else {
        (None, None, None, None, None, None, None)
    };
    connection.execute(
        "INSERT INTO hosts (
            id, label, hostname, port, username, authentication,
            identity_file, credential_reference, group_id, created_at,
            updated_at, password, sftp_file_protocol,
            sftp_filename_encoding, sftp_uses_sudo,
            sftp_follows_terminal_cwd, proxy_profile_reference,
            proxy_type, proxy_host, proxy_port, proxy_command,
            proxy_credential_reference, proxy_username, proxy_password,
            distro, distro_mode, manual_distro, icon_mode, icon_id,
            icon_color_mode, icon_color, icon_color_custom,
            server_tools_use_root, server_tools_elevation_method,
            sort_order
         ) VALUES (
            :id, :label, :hostname, :port, :username, :authentication,
            :identity_file, :credential_reference, :group_id, :created_at,
            :updated_at, :password, :sftp_file_protocol,
            :sftp_filename_encoding, :sftp_uses_sudo,
            :sftp_follows_terminal_cwd, :proxy_profile_reference,
            :proxy_type, :proxy_host, :proxy_port, :proxy_command,
            :proxy_credential_reference, :proxy_username, :proxy_password,
            :distro, :distro_mode, :manual_distro, :icon_mode, :icon_id,
            :icon_color_mode, :icon_color, :icon_color_custom,
            :server_tools_use_root, :server_tools_elevation_method,
            :sort_order
         )
         ON CONFLICT(id) DO UPDATE SET
            label=excluded.label,
            hostname=excluded.hostname,
            port=excluded.port,
            username=excluded.username,
            authentication=excluded.authentication,
            identity_file=excluded.identity_file,
            credential_reference=excluded.credential_reference,
            group_id=excluded.group_id,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at,
            password=excluded.password,
            sftp_file_protocol=excluded.sftp_file_protocol,
            sftp_filename_encoding=excluded.sftp_filename_encoding,
            sftp_uses_sudo=excluded.sftp_uses_sudo,
            sftp_follows_terminal_cwd=excluded.sftp_follows_terminal_cwd,
            proxy_profile_reference=excluded.proxy_profile_reference,
            proxy_type=excluded.proxy_type,
            proxy_host=excluded.proxy_host,
            proxy_port=excluded.proxy_port,
            proxy_command=excluded.proxy_command,
            proxy_credential_reference=excluded.proxy_credential_reference,
            proxy_username=excluded.proxy_username,
            proxy_password=excluded.proxy_password,
            distro=excluded.distro,
            distro_mode=excluded.distro_mode,
            manual_distro=excluded.manual_distro,
            icon_mode=excluded.icon_mode,
            icon_id=excluded.icon_id,
            icon_color_mode=excluded.icon_color_mode,
            icon_color=excluded.icon_color,
            icon_color_custom=excluded.icon_color_custom,
            server_tools_use_root=excluded.server_tools_use_root,
            server_tools_elevation_method=excluded.server_tools_elevation_method,
            sort_order=excluded.sort_order",
        named_params! {
            ":id": &host.id,
            ":label": &host.label,
            ":hostname": &host.hostname,
            ":port": i64::from(host.port),
            ":username": &host.username,
            ":authentication": authentication,
            ":identity_file": &host.identity_file,
            ":credential_reference": &host.credential_id,
            ":group_id": &host.group_id,
            ":created_at": date_to_database(&host.created_at),
            ":updated_at": date_to_database(&host.updated_at),
            ":password": password,
            ":sftp_file_protocol": sftp_file_protocol,
            ":sftp_filename_encoding": sftp_filename_encoding,
            ":sftp_uses_sudo": host.sftp_uses_sudo,
            ":sftp_follows_terminal_cwd": host.sftp_follows_terminal_cwd,
            ":proxy_profile_reference": &host.proxy_profile_id,
            ":proxy_type": proxy_type,
            ":proxy_host": proxy_host,
            ":proxy_port": proxy_port,
            ":proxy_command": proxy_command,
            ":proxy_credential_reference": proxy_credential_reference,
            ":proxy_username": proxy_username,
            ":proxy_password": proxy_password,
            ":distro": &host.distro,
            ":distro_mode": &host.distro_mode,
            ":manual_distro": &host.manual_distro,
            ":icon_mode": &host.icon_mode,
            ":icon_id": &host.icon_id,
            ":icon_color_mode": &host.icon_color_mode,
            ":icon_color": &host.icon_color,
            ":icon_color_custom": &host.icon_color_custom,
            ":server_tools_use_root": host.server_tools_use_root,
            ":server_tools_elevation_method": elevation_method,
            ":sort_order": host.sort_order,
        },
    )?;
    Ok(())
}

fn upsert_imported_forward(
    connection: &Connection,
    mut rule: PortForwardRule,
) -> Result<(), VaultError> {
    let created_at = rule.created_at.clone();
    let updated_at = rule.updated_at.clone();
    rule.validate()
        .map_err(|_| invalid_input("invalid port forward"))?;
    rule.created_at = created_at;
    rule.updated_at = updated_at;
    let mut payload = serde_json::to_value(&rule)?;
    swift_encode_dates(&mut payload);
    connection.execute(
        "INSERT INTO port_forward_rules (id, host_id, payload, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            host_id=excluded.host_id,
            payload=excluded.payload,
            updated_at=excluded.updated_at",
        params![
            rule.id,
            rule.host_id,
            serde_json::to_vec(&payload)?,
            date_to_database(&rule.updated_at)
        ],
    )?;
    Ok(())
}

fn upsert_imported_script(
    connection: &Connection,
    mut script: AutomationScript,
) -> Result<(), VaultError> {
    script.title = required_value(&script.title, "script title")?;
    script.shell = required_value(&script.shell, "script shell")?;
    let mut payload = serde_json::to_value(&script)?;
    if let Value::Object(object) = &mut payload {
        object.remove("sortOrder");
    }
    swift_encode_dates(&mut payload);
    connection.execute(
        "INSERT INTO automation_scripts (id, payload, updated_at, sort_order)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            payload=excluded.payload,
            updated_at=excluded.updated_at,
            sort_order=excluded.sort_order",
        params![
            script.id,
            serde_json::to_vec(&payload)?,
            date_to_database(&script.updated_at),
            script.sort_order
        ],
    )?;
    connection.execute("DELETE FROM snippets WHERE id = ?1", params![script.id])?;
    Ok(())
}

fn upsert_imported_note(connection: &Connection, mut note: HostNote) -> Result<(), VaultError> {
    note.title = required_value(&note.title, "note title")?;
    let mut payload = serde_json::to_value(&note)?;
    swift_encode_dates(&mut payload);
    connection.execute(
        "INSERT INTO host_notes (id, host_id, payload, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            host_id=excluded.host_id,
            payload=excluded.payload,
            updated_at=excluded.updated_at",
        params![
            note.id,
            note.host_id,
            serde_json::to_vec(&payload)?,
            date_to_database(&note.updated_at)
        ],
    )?;
    Ok(())
}

fn host_from_row(row: &Row<'_>, cipher: &CredentialCipher) -> Result<Host, VaultError> {
    let proxy_type = row.get::<_, Option<String>>("proxy_type")?;
    let proxy_configuration = proxy_type
        .as_deref()
        .and_then(|value| decode_enum::<ProxyType>(value).ok())
        .map(|proxy_type| {
            Ok::<ProxyConfiguration, VaultError>(ProxyConfiguration {
                proxy_type,
                host: row
                    .get::<_, Option<String>>("proxy_host")?
                    .unwrap_or_default(),
                port: row.get::<_, Option<i64>>("proxy_port")?.unwrap_or_default() as u16,
                command: row.get("proxy_command")?,
                credential_id: row.get("proxy_credential_reference")?,
                username: row.get("proxy_username")?,
                password: decrypt_optional_value(
                    cipher,
                    row.get::<_, Option<String>>("proxy_password")?,
                )?,
            })
        })
        .transpose()?;

    Ok(Host {
        id: row.get("id")?,
        label: row.get("label")?,
        hostname: row.get("hostname")?,
        port: row.get::<_, i64>("port")? as u16,
        username: row.get("username")?,
        authentication: decode_enum(&row.get::<_, String>("authentication")?)?,
        identity_file: row.get("identity_file")?,
        identity_key: None,
        public_key: None,
        certificate: None,
        passphrase: None,
        password: decrypt_optional_value(cipher, row.get("password")?)?,
        elevation_password: None,
        credential_id: row.get("credential_reference")?,
        proxy_profile_id: row.get("proxy_profile_reference")?,
        proxy_configuration,
        group_id: row.get("group_id")?,
        sort_order: row.get("sort_order")?,
        distro: row.get("distro")?,
        distro_mode: row
            .get::<_, Option<String>>("distro_mode")?
            .unwrap_or_else(|| "auto".to_string()),
        manual_distro: row.get("manual_distro")?,
        icon_mode: row
            .get::<_, Option<String>>("icon_mode")?
            .unwrap_or_else(|| "auto".to_string()),
        icon_id: row.get("icon_id")?,
        icon_color_mode: row
            .get::<_, Option<String>>("icon_color_mode")?
            .unwrap_or_else(|| "auto".to_string()),
        icon_color: row.get("icon_color")?,
        icon_color_custom: row.get("icon_color_custom")?,
        sftp_file_protocol: decode_enum(
            &row.get::<_, Option<String>>("sftp_file_protocol")?
                .unwrap_or_else(|| "auto".to_string()),
        )?,
        sftp_filename_encoding: decode_enum(
            &row.get::<_, Option<String>>("sftp_filename_encoding")?
                .unwrap_or_else(|| "auto".to_string()),
        )?,
        sftp_uses_sudo: row.get("sftp_uses_sudo")?,
        sftp_follows_terminal_cwd: row.get("sftp_follows_terminal_cwd")?,
        server_tools_use_root: row
            .get::<_, Option<bool>>("server_tools_use_root")?
            .unwrap_or(false),
        server_tools_elevation_method: decode_enum(
            &row.get::<_, Option<String>>("server_tools_elevation_method")?
                .unwrap_or_else(|| "sudo".to_string()),
        )?,
        created_at: date_from_database(&row.get::<_, String>("created_at")?),
        updated_at: date_from_database(&row.get::<_, String>("updated_at")?),
    })
}

fn credential_from_row(row: &Row<'_>, cipher: &CredentialCipher) -> Result<Credential, VaultError> {
    Ok(Credential {
        id: row.get("id")?,
        label: row.get("label")?,
        username: row.get("username")?,
        kind: decode_enum(&row.get::<_, String>("kind")?)?,
        password: decrypt_optional_value(cipher, row.get("password")?)?,
        private_key: decrypt_optional_value(cipher, row.get("private_key")?)?,
        public_key: row.get("public_key")?,
        certificate: row.get("certificate")?,
        passphrase: decrypt_optional_value(cipher, row.get("passphrase")?)?,
        saves_passphrase: row.get("saves_passphrase")?,
        elevation_password: decrypt_optional_value(cipher, row.get("elevation_password")?)?,
        created_at: date_from_database(&row.get::<_, String>("created_at")?),
        updated_at: date_from_database(&row.get::<_, String>("updated_at")?),
    })
}

fn proxy_from_row(
    row: &Row<'_>,
    cipher: &CredentialCipher,
) -> Result<Option<ProxyProfile>, VaultError> {
    let Ok(proxy_type) = decode_enum(&row.get::<_, String>("type")?) else {
        return Ok(None);
    };
    Ok(Some(ProxyProfile {
        id: row.get("id")?,
        label: row.get("label")?,
        configuration: ProxyConfiguration {
            proxy_type,
            host: row.get("host")?,
            port: row.get::<_, i64>("port")? as u16,
            command: row.get("command")?,
            credential_id: row.get("credential_reference")?,
            username: row.get("username")?,
            password: decrypt_optional_value(cipher, row.get("password")?)?,
        },
        sort_order: row.get("sort_order")?,
        created_at: date_from_database(&row.get::<_, String>("created_at")?),
        updated_at: date_from_database(&row.get::<_, String>("updated_at")?),
    }))
}

struct CredentialCipher {
    key: [u8; 32],
}

impl CredentialCipher {
    fn load_or_create(path: &Path, storage: CredentialKeyStorage) -> Result<Self, VaultError> {
        let key = if path.exists() {
            let stored = fs::read(path)?;
            if let Some(portable_key) = stored.strip_prefix(PORTABLE_CREDENTIAL_KEY_PREFIX) {
                portable_key.to_vec()
            } else {
                let key = unprotect_key(&stored)?;
                if storage.is_portable() && key.len() == 32 {
                    fs::write(path, portable_key_payload(&key))?;
                    set_private_file_permissions(path)?;
                }
                key
            }
        } else {
            let key: [u8; 32] = rand::random();
            let payload = match storage {
                #[cfg(any(not(windows), test))]
                CredentialKeyStorage::PlatformProtected => protect_key(&key)?,
                #[cfg(any(windows, test))]
                CredentialKeyStorage::Portable => portable_key_payload(&key),
            };
            fs::write(path, payload)?;
            set_private_file_permissions(path)?;
            key.to_vec()
        };
        let key: [u8; 32] = key.try_into().map_err(|_| VaultError::InvalidKey)?;
        Ok(Self { key })
    }

    fn encrypt(&self, value: &str) -> Result<String, VaultError> {
        if value.starts_with(ENCRYPTED_PREFIX) && self.decrypt(value).is_ok() {
            return Ok(value.to_string());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| VaultError::Encryption)?;
        let nonce_bytes: [u8; 12] = rand::random();
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), value.as_bytes())
            .map_err(|_| VaultError::Encryption)?;
        let mut combined = Vec::with_capacity(nonce_bytes.len() + encrypted.len());
        combined.extend_from_slice(&nonce_bytes);
        combined.extend_from_slice(&encrypted);
        Ok(format!("{ENCRYPTED_PREFIX}{}", BASE64.encode(combined)))
    }

    fn decrypt(&self, value: &str) -> Result<String, VaultError> {
        if !value.starts_with(ENCRYPTED_PREFIX) {
            return Ok(value.to_string());
        }
        let combined = BASE64
            .decode(&value[ENCRYPTED_PREFIX.len()..])
            .map_err(|_| VaultError::Decryption)?;
        if combined.len() <= 12 {
            return Err(VaultError::Decryption);
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| VaultError::Decryption)?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&combined[..12]), &combined[12..])
            .map_err(|_| VaultError::Decryption)?;
        String::from_utf8(plaintext).map_err(|_| VaultError::Decryption)
    }
}

fn portable_key_payload(key: &[u8]) -> Vec<u8> {
    [PORTABLE_CREDENTIAL_KEY_PREFIX, key].concat()
}

fn migrate(connection: &Connection) -> Result<(), VaultError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS grdb_migrations (
            identifier TEXT NOT NULL PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS host_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            parent_group_id TEXT REFERENCES host_groups(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS hosts (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            hostname TEXT NOT NULL,
            port INTEGER NOT NULL,
            username TEXT NOT NULL,
            authentication TEXT NOT NULL,
            identity_file TEXT,
            credential_reference TEXT,
            group_id TEXT REFERENCES host_groups(id) ON DELETE SET NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            password TEXT,
            sftp_file_protocol TEXT NOT NULL DEFAULT 'auto',
            sftp_filename_encoding TEXT NOT NULL DEFAULT 'auto',
            sftp_uses_sudo BOOLEAN NOT NULL DEFAULT 0,
            sftp_follows_terminal_cwd BOOLEAN,
            proxy_profile_reference TEXT,
            proxy_type TEXT,
            proxy_host TEXT,
            proxy_port INTEGER,
            proxy_command TEXT,
            proxy_credential_reference TEXT,
            proxy_username TEXT,
            proxy_password TEXT,
            distro TEXT,
            distro_mode TEXT NOT NULL DEFAULT 'auto',
            manual_distro TEXT,
            icon_mode TEXT NOT NULL DEFAULT 'auto',
            icon_id TEXT,
            icon_color_mode TEXT NOT NULL DEFAULT 'auto',
            icon_color TEXT,
            icon_color_custom TEXT,
            server_tools_use_root BOOLEAN NOT NULL DEFAULT 0,
            server_tools_elevation_method TEXT NOT NULL DEFAULT 'sudo',
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS hosts_search
            ON hosts(label, hostname, username);
        CREATE TABLE IF NOT EXISTS connection_history (
            id TEXT PRIMARY KEY,
            host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
            started_at DATETIME NOT NULL,
            ended_at DATETIME,
            succeeded BOOLEAN NOT NULL,
            error_category TEXT
        );
        CREATE TABLE IF NOT EXISTS workspace_state (
            id INTEGER PRIMARY KEY,
            payload BLOB NOT NULL,
            saved_at DATETIME NOT NULL
        );
        CREATE TABLE IF NOT EXISTS port_forward_rules (
            id TEXT PRIMARY KEY,
            host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
            payload BLOB NOT NULL,
            updated_at DATETIME NOT NULL
        );
        CREATE INDEX IF NOT EXISTS port_forward_rules_host
            ON port_forward_rules(host_id);
        CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            payload BLOB NOT NULL,
            updated_at DATETIME NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_scripts (
            id TEXT PRIMARY KEY,
            payload BLOB NOT NULL,
            updated_at DATETIME NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS host_notes (
            id TEXT PRIMARY KEY,
            host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
            payload BLOB NOT NULL,
            updated_at DATETIME NOT NULL
        );
        CREATE INDEX IF NOT EXISTS host_notes_host ON host_notes(host_id);
        CREATE TABLE IF NOT EXISTS ssh_credentials (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            username TEXT NOT NULL,
            kind TEXT NOT NULL,
            password TEXT,
            private_key TEXT,
            public_key TEXT,
            certificate TEXT,
            passphrase TEXT,
            saves_passphrase BOOLEAN NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            elevation_password TEXT
        );
        CREATE INDEX IF NOT EXISTS ssh_credentials_label
            ON ssh_credentials(label);
        CREATE TABLE IF NOT EXISTS ssh_proxy_profiles (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            type TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            command TEXT,
            credential_reference TEXT,
            username TEXT,
            password TEXT,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ssh_proxy_profiles_label
            ON ssh_proxy_profiles(label);",
    )?;
    for identifier in SWIFT_MIGRATIONS {
        connection.execute(
            "INSERT OR IGNORE INTO grdb_migrations(identifier) VALUES (?1)",
            params![identifier],
        )?;
    }
    Ok(())
}

fn encode_enum<T: Serialize>(value: &T) -> Result<String, VaultError> {
    match serde_json::to_value(value)? {
        Value::String(value) => Ok(value),
        _ => Err(invalid_input("enum must serialize as a string")),
    }
}

fn decode_enum<T: DeserializeOwned>(value: &str) -> Result<T, VaultError> {
    serde_json::from_value(Value::String(value.to_string())).map_err(VaultError::from)
}

fn encrypt_optional_value(
    cipher: &CredentialCipher,
    value: Option<&str>,
) -> Result<Option<String>, VaultError> {
    value.map(|value| cipher.encrypt(value)).transpose()
}

fn decrypt_optional_value(
    cipher: &CredentialCipher,
    value: Option<String>,
) -> Result<Option<String>, VaultError> {
    value.map(|value| cipher.decrypt(&value)).transpose()
}

fn date_to_database(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| {
            date.with_timezone(&Utc)
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        })
        .unwrap_or_else(|_| value.to_string())
}

fn date_from_database(value: &str) -> String {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return date
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true);
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .map(|date| date.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|_| value.to_string())
}

fn swift_encode_dates(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if is_swift_date_key(key) {
                    if let Value::String(date) = value {
                        if let Ok(parsed) = DateTime::parse_from_rfc3339(date) {
                            let seconds = parsed.timestamp_millis() as f64 / 1000.0
                                - APPLE_REFERENCE_UNIX_SECONDS;
                            if let Some(number) = serde_json::Number::from_f64(seconds) {
                                *value = Value::Number(number);
                                continue;
                            }
                        }
                    }
                }
                swift_encode_dates(value);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(swift_encode_dates),
        _ => {}
    }
}

fn swift_decode_dates(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if is_swift_date_key(key) {
                    if let Some(seconds) = value.as_f64() {
                        let unix_millis =
                            ((seconds + APPLE_REFERENCE_UNIX_SECONDS) * 1000.0).round() as i64;
                        if let Some(date) = DateTime::<Utc>::from_timestamp_millis(unix_millis) {
                            *value =
                                Value::String(date.to_rfc3339_opts(SecondsFormat::Millis, true));
                            continue;
                        }
                    }
                }
                swift_decode_dates(value);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(swift_decode_dates),
        _ => {}
    }
}

fn is_swift_date_key(key: &str) -> bool {
    matches!(key, "createdAt" | "updatedAt" | "lastUsedAt" | "savedAt")
}

fn decode_swift_payload<T: DeserializeOwned>(payload: &[u8]) -> Result<T, VaultError> {
    let mut value: Value = serde_json::from_slice(payload)?;
    swift_decode_dates(&mut value);
    serde_json::from_value(value).map_err(VaultError::from)
}

fn required_value(value: &str, name: &str) -> Result<String, VaultError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(invalid_input(&format!("{name} is required")))
    } else {
        Ok(trimmed.to_string())
    }
}

fn invalid_input(message: &str) -> VaultError {
    VaultError::Serialization(serde_json::Error::io(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        message.to_string(),
    )))
}

fn known_host_id(index: usize, line: &str) -> String {
    format!("{index}:{}", BASE64.encode(line.as_bytes()))
}

#[cfg(target_os = "macos")]
fn load_swift_preferences() -> AppPreferences {
    AppPreferences {
        theme: defaults_read("appearance").unwrap_or_else(|| "system".to_string()),
        language: defaults_read("language").unwrap_or_else(|| "zh-Hans".to_string()),
        terminal_font_name: defaults_read("terminalFontName")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "auto".to_string()),
        terminal_font_size: defaults_read_f64("terminalFontSize").unwrap_or(13.0),
        autocomplete_enabled: defaults_read_bool("terminalAutocompleteEnabled").unwrap_or(true),
        autocomplete_ghost_text: defaults_read_bool("terminalAutocompleteGhostText")
            .unwrap_or(false),
        autocomplete_popup: defaults_read_bool("terminalAutocompletePopupMenu").unwrap_or(true),
        password_prompt_assist: match defaults_read("passwordPromptAssistMode").as_deref() {
            Some("off") => "off",
            Some("picker") | Some("automatic") => "picker",
            _ => "hint",
        }
        .to_string(),
        auto_open_system_overview: defaults_read_bool("autoOpenSystemOverviewOnSSHConnect")
            .unwrap_or(true),
        auto_accept_ssh_host_keys: defaults_read_bool("autoAcceptSSHHostKeys").unwrap_or(false),
        overview_refresh_interval: defaults_read_u8("overviewRefreshInterval").unwrap_or(5),
        processes_refresh_interval: defaults_read_u8("processesRefreshInterval").unwrap_or(3),
        docker_refresh_interval: defaults_read_u8("dockerRefreshInterval").unwrap_or(5),
        sftp_shows_hidden_files: defaults_read_bool("sftpShowsHiddenFiles").unwrap_or(true),
        sftp_file_transfer_concurrency: defaults_read_u8("sftpFileTransferConcurrency")
            .unwrap_or(2),
        sftp_chunk_concurrency: defaults_read_u8("sftpChunkConcurrency").unwrap_or(32),
        sftp_chunk_size_bytes: defaults_read_u32("sftpChunkSizeBytes").unwrap_or(256 * 1024),
        sftp_transfer_connection_idle_seconds: defaults_read_u32(
            "sftpTransferConnectionIdleSeconds",
        )
        .unwrap_or(300),
    }
}

#[cfg(not(target_os = "macos"))]
fn load_swift_preferences() -> AppPreferences {
    AppPreferences::default()
}

#[cfg(target_os = "macos")]
fn save_swift_preferences(preferences: &AppPreferences) -> Result<(), VaultError> {
    defaults_write("appearance", "-string", &preferences.theme)?;
    defaults_write(
        "language",
        "-string",
        if preferences.language == "en" {
            "en"
        } else {
            "zh-Hans"
        },
    )?;
    defaults_write(
        "terminalFontName",
        "-string",
        if preferences.terminal_font_name == "auto" {
            ""
        } else {
            &preferences.terminal_font_name
        },
    )?;
    defaults_write(
        "terminalFontSize",
        "-float",
        &preferences.terminal_font_size.to_string(),
    )?;
    defaults_write_bool(
        "terminalAutocompleteEnabled",
        preferences.autocomplete_enabled,
    )?;
    defaults_write_bool(
        "terminalAutocompleteGhostText",
        preferences.autocomplete_ghost_text,
    )?;
    defaults_write_bool(
        "terminalAutocompletePopupMenu",
        preferences.autocomplete_popup,
    )?;
    defaults_write(
        "passwordPromptAssistMode",
        "-string",
        match preferences.password_prompt_assist.as_str() {
            "off" => "off",
            "picker" => "picker",
            _ => "hint",
        },
    )?;
    defaults_write_bool(
        "autoOpenSystemOverviewOnSSHConnect",
        preferences.auto_open_system_overview,
    )?;
    defaults_write_bool(
        "autoAcceptSSHHostKeys",
        preferences.auto_accept_ssh_host_keys,
    )?;
    defaults_write_integer(
        "overviewRefreshInterval",
        preferences.overview_refresh_interval,
    )?;
    defaults_write_integer(
        "processesRefreshInterval",
        preferences.processes_refresh_interval,
    )?;
    defaults_write_integer("dockerRefreshInterval", preferences.docker_refresh_interval)?;
    defaults_write_bool("sftpShowsHiddenFiles", preferences.sftp_shows_hidden_files)?;
    defaults_write_integer(
        "sftpFileTransferConcurrency",
        preferences.sftp_file_transfer_concurrency,
    )?;
    defaults_write_integer("sftpChunkConcurrency", preferences.sftp_chunk_concurrency)?;
    defaults_write_integer("sftpChunkSizeBytes", preferences.sftp_chunk_size_bytes)?;
    defaults_write_integer(
        "sftpTransferConnectionIdleSeconds",
        preferences.sftp_transfer_connection_idle_seconds,
    )
}

#[cfg(not(target_os = "macos"))]
fn save_swift_preferences(_preferences: &AppPreferences) -> Result<(), VaultError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn defaults_read(key: &str) -> Option<String> {
    let output = Command::new("/usr/bin/defaults")
        .args(["read", SWIFT_PREFERENCES_DOMAIN, key])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn defaults_read_bool(key: &str) -> Option<bool> {
    defaults_read(key).and_then(|value| match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Some(true),
        "0" | "false" | "no" => Some(false),
        _ => None,
    })
}

#[cfg(target_os = "macos")]
fn defaults_read_f64(key: &str) -> Option<f64> {
    defaults_read(key)?.parse().ok()
}

#[cfg(target_os = "macos")]
fn defaults_read_u8(key: &str) -> Option<u8> {
    defaults_read(key)?.parse().ok()
}

#[cfg(target_os = "macos")]
fn defaults_read_u32(key: &str) -> Option<u32> {
    defaults_read(key)?.parse().ok()
}

#[cfg(target_os = "macos")]
fn defaults_write(key: &str, value_type: &str, value: &str) -> Result<(), VaultError> {
    let status = Command::new("/usr/bin/defaults")
        .args(["write", SWIFT_PREFERENCES_DOMAIN, key, value_type, value])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("failed to write preference {key}")).into())
    }
}

#[cfg(target_os = "macos")]
fn defaults_write_bool(key: &str, value: bool) -> Result<(), VaultError> {
    defaults_write(key, "-bool", if value { "true" } else { "false" })
}

#[cfg(target_os = "macos")]
fn defaults_write_integer<T: ToString>(key: &str, value: T) -> Result<(), VaultError> {
    defaults_write(key, "-int", &value.to_string())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(not(windows))]
fn protect_key(key: &[u8]) -> Result<Vec<u8>, VaultError> {
    Ok(key.to_vec())
}

#[cfg(not(windows))]
fn unprotect_key(key: &[u8]) -> Result<Vec<u8>, VaultError> {
    Ok(key.to_vec())
}

#[cfg(all(windows, test))]
fn protect_key(key: &[u8]) -> Result<Vec<u8>, VaultError> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: key.len() as u32,
        pbData: key.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let succeeded = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 {
        return Err(VaultError::KeyProtection);
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn unprotect_key(key: &[u8]) -> Result<Vec<u8>, VaultError> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: key.len() as u32,
        pbData: key.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let succeeded = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 {
        return Err(VaultError::KeyProtection);
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_store() -> (PathBuf, VaultStore) {
        let directory =
            std::env::temp_dir().join(format!("termpilot-vault-test-{}", crate::domain::new_id()));
        let store = VaultStore::open(directory.clone()).expect("open vault");
        (directory, store)
    }

    #[test]
    fn portable_directory_is_next_to_the_executable() {
        let executable = Path::new("/portable/TermPilot/TermPilot.exe");
        assert_eq!(
            portable_data_directory(executable).expect("portable data directory"),
            Path::new("/portable/TermPilot/data")
        );
    }

    #[test]
    fn portable_store_survives_copying_the_application_data_directory() {
        let source = std::env::temp_dir().join(format!(
            "termpilot-portable-source-{}",
            crate::domain::new_id()
        ));
        let destination = std::env::temp_dir().join(format!(
            "termpilot-portable-destination-{}",
            crate::domain::new_id()
        ));
        let store = VaultStore::open_portable(source.clone()).expect("open portable vault");
        let host: Host = serde_json::from_value(serde_json::json!({
            "id": "portable-host",
            "label": "Portable",
            "hostname": "portable.example.com",
            "username": "pilot",
            "authentication": "password",
            "password": "portable-secret"
        }))
        .expect("host model");
        let saved_host = store.save_host(host).expect("save host");
        store
            .save_preferences(AppPreferences::default())
            .expect("save preferences");
        fs::write(
            store.known_hosts_path(),
            "portable.example.com ssh-ed25519 a2V5\n",
        )
        .expect("write known hosts");
        assert_eq!(store.webview_data_directory(), source.join("webview"));
        assert!(source.join("webview").is_dir());
        drop(store);

        fs::create_dir_all(&destination).expect("create copied data directory");
        for entry in fs::read_dir(&source).expect("read source data directory") {
            let entry = entry.expect("source data entry");
            if entry.file_type().expect("source entry type").is_file() {
                fs::copy(entry.path(), destination.join(entry.file_name()))
                    .expect("copy portable data file");
            }
        }

        let key = fs::read(destination.join("credential.key")).expect("read portable key");
        assert!(key.starts_with(PORTABLE_CREDENTIAL_KEY_PREFIX));
        assert!(destination.join("vault.sqlite").is_file());
        assert!(destination.join("preferences.json").is_file());
        assert!(destination.join("known_hosts").is_file());

        let copied = VaultStore::open_portable(destination.clone()).expect("open copied vault");
        let snapshot = copied
            .bootstrap("windows".to_string())
            .expect("bootstrap copied vault");
        assert_eq!(snapshot.hosts.len(), 1);
        assert_eq!(snapshot.hosts[0].id, saved_host.id);
        assert_eq!(snapshot.hosts[0].label, saved_host.label);
        assert_eq!(
            snapshot.hosts[0].password.as_deref(),
            Some("portable-secret")
        );
        assert_eq!(snapshot.known_hosts.len(), 1);
        drop(copied);
        let _ = fs::remove_dir_all(source);
        let _ = fs::remove_dir_all(destination);
    }

    #[test]
    fn portable_store_upgrades_an_existing_platform_key() {
        let directory = std::env::temp_dir().join(format!(
            "termpilot-portable-key-upgrade-{}",
            crate::domain::new_id()
        ));
        let store = VaultStore::open(directory.clone()).expect("open platform vault");
        drop(store);
        let original = fs::read(directory.join("credential.key")).expect("read platform key");
        assert!(!original.starts_with(PORTABLE_CREDENTIAL_KEY_PREFIX));

        let portable = VaultStore::open_portable(directory.clone()).expect("upgrade portable key");
        drop(portable);
        let upgraded = fs::read(directory.join("credential.key")).expect("read upgraded key");
        assert!(upgraded.starts_with(PORTABLE_CREDENTIAL_KEY_PREFIX));
        assert_eq!(upgraded.len(), PORTABLE_CREDENTIAL_KEY_PREFIX.len() + 32);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn encrypts_and_decrypts_fields() {
        let cipher = CredentialCipher { key: [7; 32] };
        let encrypted = cipher.encrypt("secret").expect("encrypt");
        assert!(encrypted.starts_with(ENCRYPTED_PREFIX));
        assert_eq!(cipher.decrypt(&encrypted).expect("decrypt"), "secret");
    }

    #[test]
    fn deletes_multiple_known_hosts_against_the_original_file() {
        let (directory, store) = temporary_store();
        fs::write(
            store.known_hosts_path(),
            "# retained comment\n\
             one.example.com ssh-ed25519 a2V5MQ==\n\
             two.example.com ssh-ed25519 a2V5Mg==\n\
             three.example.com ssh-ed25519 a2V5Mw==\n",
        )
        .expect("write known hosts");
        let records = store.known_hosts().expect("known hosts");
        let ids = HashSet::from([records[0].id.clone(), records[2].id.clone()]);

        store.delete_known_hosts(&ids).expect("delete known hosts");

        let content = fs::read_to_string(store.known_hosts_path()).expect("read known hosts");
        assert!(content.contains("# retained comment"));
        assert!(!content.contains("one.example.com"));
        assert!(content.contains("two.example.com"));
        assert!(!content.contains("three.example.com"));
        drop(store);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn creates_exact_swift_v15_schema_and_migration_markers() {
        let (directory, store) = temporary_store();
        let connection = store.connection.lock();
        let migrations = connection
            .prepare("SELECT identifier FROM grdb_migrations ORDER BY rowid")
            .expect("prepare")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .collect::<Result<Vec<_>, _>>()
            .expect("migrations");
        assert_eq!(migrations, SWIFT_MIGRATIONS);
        assert!(connection
            .query_row(
                "SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'app_values'",
                [],
                |_| Ok(()),
            )
            .optional()
            .expect("query app_values")
            .is_none());
        let host_columns = connection
            .prepare("PRAGMA table_info(hosts)")
            .expect("prepare columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("columns");
        assert!(host_columns.contains(&"hostname".to_string()));
        assert!(!host_columns.contains(&"payload".to_string()));
        drop(connection);
        drop(store);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn vault_round_trip_keeps_plaintext_out_of_swift_columns() {
        let (directory, store) = temporary_store();
        let mut host: Host = serde_json::from_value(serde_json::json!({
            "label": "Test",
            "hostname": "example.com",
            "username": "pilot",
            "authentication": "password",
            "password": "actual-password"
        }))
        .expect("host model");
        host.id = "test-host".to_string();
        store.save_host(host).expect("save host");
        let snapshot = store.bootstrap("macos".to_string()).expect("bootstrap");
        assert_eq!(
            snapshot.hosts[0].password.as_deref(),
            Some("actual-password")
        );
        let stored_password: String = store
            .connection
            .lock()
            .query_row(
                "SELECT password FROM hosts WHERE id = 'test-host'",
                [],
                |row| row.get(0),
            )
            .expect("stored password");
        assert!(stored_password.starts_with(ENCRYPTED_PREFIX));
        assert!(!stored_password.contains("actual-password"));
        drop(store);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn swift_payload_dates_use_apple_reference_seconds() {
        let (directory, store) = temporary_store();
        let script: AutomationScript = serde_json::from_value(serde_json::json!({
            "id": "DE642181-35F9-403E-9D71-6231BF69E567",
            "title": "init",
            "shell": "/bin/sh",
            "body": "echo ready",
            "createdAt": "2026-08-03T06:56:14.464Z",
            "updatedAt": "2026-08-03T06:56:40.347Z"
        }))
        .expect("script");
        store.save_script(script).expect("save script");
        let payload: Vec<u8> = store
            .connection
            .lock()
            .query_row("SELECT payload FROM automation_scripts", [], |row| {
                row.get(0)
            })
            .expect("payload");
        let value: Value = serde_json::from_slice(&payload).expect("json");
        assert!(value["createdAt"].is_number());
        assert!(value.get("sortOrder").is_none());
        assert_eq!(
            store
                .bootstrap("macos".to_string())
                .expect("bootstrap")
                .scripts[0]
                .title,
            "init"
        );
        drop(store);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn workspace_round_trip_prunes_invalid_sessions_and_focus() {
        let (directory, store) = temporary_store();
        let snapshot: WorkspaceSnapshot = serde_json::from_value(serde_json::json!({
            "version": 1,
            "savedAt": "2026-01-01T00:00:00Z",
            "activeWorkspaceId": "empty",
            "sessions": [{
                "id": "valid",
                "kind": "local",
                "title": "Valid",
                "fontSize": 13,
                "lifecycle": "connected"
            }],
            "workspaces": [{
                "id": "workspace",
                "title": "Workspace",
                "root": {
                    "type": "split",
                    "id": "root",
                    "axis": "vertical",
                    "children": [
                        {"type": "pane", "id": "valid-pane", "sessionId": "valid"},
                        {"type": "pane", "id": "missing-pane", "sessionId": "missing"}
                    ],
                    "sizes": [0.25, 0.75]
                },
                "focusedSessionId": "missing",
                "pinned": false
            }, {
                "id": "empty",
                "title": "Empty",
                "root": {"type": "pane", "id": "empty-pane", "sessionId": "missing"},
                "focusedSessionId": "missing",
                "pinned": false
            }]
        }))
        .expect("workspace snapshot");

        store.save_workspace(snapshot).expect("save workspace");
        let workspace = store
            .bootstrap("macos".to_string())
            .expect("bootstrap")
            .workspace;
        assert_eq!(workspace.workspaces.len(), 1);
        assert_eq!(workspace.workspaces[0].root.session_ids(), vec!["valid"]);
        assert_eq!(workspace.workspaces[0].focused_session_id, "valid");
        assert_eq!(workspace.active_workspace_id.as_deref(), Some("workspace"));
        store.erase_workspace().expect("erase workspace");
        let erased = store
            .bootstrap("macos".to_string())
            .expect("bootstrap after erase")
            .workspace;
        assert!(erased.sessions.is_empty());
        assert!(erased.workspaces.is_empty());
        assert!(erased.active_workspace_id.is_none());
        drop(store);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn deleting_group_removes_descendants_and_ungroups_hosts() {
        let (directory, store) = temporary_store();
        for (id, parent_group_id) in [("root", None), ("child", Some("root".to_string()))] {
            store
                .save_group(HostGroup {
                    id: id.to_string(),
                    name: id.to_string(),
                    parent_group_id,
                    sort_order: 0,
                })
                .expect("save group");
        }
        let mut host: Host = serde_json::from_value(serde_json::json!({
            "label": "Nested",
            "hostname": "example.com",
            "username": "pilot",
            "groupId": "child"
        }))
        .expect("host model");
        host.id = "nested-host".to_string();
        store.save_host(host).expect("save host");
        store.delete_group("root").expect("delete group tree");
        let snapshot = store.bootstrap("macos".to_string()).expect("bootstrap");
        assert!(snapshot.groups.is_empty());
        assert_eq!(snapshot.hosts[0].group_id, None);
        drop(store);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn backup_import_deduplicates_ip_and_remaps_references() {
        let (source_directory, source) = temporary_store();
        let group: HostGroup = serde_json::from_value(serde_json::json!({
            "id": "10000000-0000-0000-0000-000000000001",
            "name": "Production",
            "sortOrder": 0
        }))
        .expect("group");
        let credential: Credential = serde_json::from_value(serde_json::json!({
            "id": "20000000-0000-0000-0000-000000000002",
            "label": "Production Login",
            "username": "root",
            "kind": "password",
            "password": "host-secret",
            "savesPassphrase": false,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .expect("credential");
        let proxy: ProxyProfile = serde_json::from_value(serde_json::json!({
            "id": "30000000-0000-0000-0000-000000000003",
            "label": "Office Proxy",
            "configuration": {
                "type": "socks5",
                "host": "127.0.0.1",
                "port": 1080,
                "credentialId": credential.id
            },
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .expect("proxy");
        let imported_host_id = "40000000-0000-0000-0000-000000000004";
        let host: Host = serde_json::from_value(serde_json::json!({
            "id": imported_host_id,
            "label": "Imported Server",
            "hostname": "192.168.001.010",
            "username": "root",
            "authentication": "password",
            "credentialId": credential.id,
            "proxyProfileId": proxy.id,
            "groupId": group.id,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .expect("host");
        let forward: PortForwardRule = serde_json::from_value(serde_json::json!({
            "id": "50000000-0000-0000-0000-000000000005",
            "hostId": imported_host_id,
            "name": "Web",
            "kind": "local",
            "localPort": 8080,
            "remotePort": 80,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .expect("forward");
        let script: AutomationScript = serde_json::from_value(serde_json::json!({
            "id": "60000000-0000-0000-0000-000000000006",
            "title": "Deploy",
            "shell": "/bin/sh",
            "body": "echo deploy",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .expect("script");
        let note: HostNote = serde_json::from_value(serde_json::json!({
            "id": "70000000-0000-0000-0000-000000000007",
            "hostId": imported_host_id,
            "title": "Runbook",
            "body": "# Production",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }))
        .expect("note");

        source.save_group(group).expect("save group");
        source.save_credential(credential).expect("save credential");
        source.save_proxy(proxy).expect("save proxy");
        source.save_host(host).expect("save host");
        source.save_forward(forward).expect("save forward");
        source.save_script(script).expect("save script");
        source.save_note(note).expect("save note");
        let snapshot = source.backup_snapshot().expect("backup snapshot");

        let (destination_directory, destination) = temporary_store();
        let existing_host_id = "80000000-0000-0000-0000-000000000008";
        let existing: Host = serde_json::from_value(serde_json::json!({
            "id": existing_host_id,
            "label": "Existing Server",
            "hostname": "192.168.1.10",
            "username": "admin"
        }))
        .expect("existing host");
        destination.save_host(existing).expect("save existing host");

        let summary = destination
            .import_backup_snapshot(snapshot)
            .expect("import backup");
        assert_eq!(summary.hosts, 1);
        assert_eq!(summary.deduplicated_hosts, 1);
        let restored = destination
            .bootstrap("macos".to_string())
            .expect("restored data");
        assert_eq!(restored.hosts.len(), 1);
        assert_eq!(restored.hosts[0].id, existing_host_id);
        assert_eq!(restored.hosts[0].label, "Imported Server");
        assert_eq!(
            restored.forwards[0].host_id.as_deref(),
            Some(existing_host_id)
        );
        assert_eq!(restored.notes[0].host_id.as_deref(), Some(existing_host_id));
        assert_eq!(
            restored.credentials[0].password.as_deref(),
            Some("host-secret")
        );

        drop(source);
        drop(destination);
        let _ = fs::remove_dir_all(source_directory);
        let _ = fs::remove_dir_all(destination_directory);
    }

    #[test]
    fn backup_import_rolls_back_on_invalid_record() {
        let (directory, store) = temporary_store();
        let invalid_host: Host = serde_json::from_value(serde_json::json!({
            "id": "90000000-0000-0000-0000-000000000009",
            "label": "",
            "hostname": "192.0.2.10",
            "username": "root"
        }))
        .expect("invalid host model");
        let credential: Credential = serde_json::from_value(serde_json::json!({
            "id": "A0000000-0000-0000-0000-00000000000A",
            "label": "Must Roll Back",
            "username": "root",
            "kind": "password",
            "password": "secret",
            "savesPassphrase": false
        }))
        .expect("credential");
        let snapshot = BackupSnapshot::new(
            vec![invalid_host],
            Vec::new(),
            vec![credential],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        );

        assert!(store.import_backup_snapshot(snapshot).is_err());
        let restored = store.bootstrap("macos".to_string()).expect("restored data");
        assert!(restored.hosts.is_empty());
        assert!(restored.credentials.is_empty());

        drop(store);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires an installed Swift TermPilot vault"]
    fn reads_an_unmodified_copy_of_the_installed_swift_vault() {
        let source_directory = shared_data_directory().expect("shared data directory");
        if !source_directory.join("vault.sqlite").exists() {
            return;
        }
        let destination = std::env::temp_dir().join(format!(
            "termpilot-swift-vault-copy-{}",
            crate::domain::new_id()
        ));
        fs::create_dir_all(&destination).expect("create fixture directory");
        let source =
            Connection::open(source_directory.join("vault.sqlite")).expect("open Swift vault");
        source
            .execute(
                "VACUUM INTO ?1",
                params![destination.join("vault.sqlite").to_string_lossy()],
            )
            .expect("copy Swift vault");
        fs::copy(
            source_directory.join("credential.key"),
            destination.join("credential.key"),
        )
        .expect("copy credential key");

        let store = VaultStore::open(destination.clone()).expect("open copied Swift vault");
        let snapshot = store.bootstrap("macos".to_string()).expect("bootstrap");
        assert!(!snapshot.hosts.is_empty());
        assert!(!snapshot.groups.is_empty());
        assert!(!snapshot.credentials.is_empty());
        drop(store);
        let _ = fs::remove_dir_all(destination);
    }
}
