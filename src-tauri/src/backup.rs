use std::fs;
use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, SecondsFormat, Utc};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use crate::domain::{
    now, AutomationScript, Credential, Host, HostGroup, HostNote, PortForwardRule, ProxyProfile,
};

pub const BACKUP_FILE_EXTENSION: &str = "tpbackup";
const BACKUP_MAGIC: &str = "TermPilotBackup";
const BACKUP_FORMAT_VERSION: u32 = 1;
const BACKUP_SCHEMA_VERSION: u32 = 1;
const BACKUP_KDF: &str = "PBKDF2-HMAC-SHA256";
const BACKUP_CIPHER: &str = "AES-256-GCM";
const BACKUP_PBKDF2_ITERATIONS: u32 = 600_000;
const MINIMUM_PBKDF2_ITERATIONS: u32 = 100_000;
const MAXIMUM_PBKDF2_ITERATIONS: u32 = 2_000_000;
const BACKUP_SALT_SIZE: usize = 16;
const BACKUP_NONCE_SIZE: usize = 12;
const MAXIMUM_BACKUP_FILE_SIZE: usize = 100 * 1_024 * 1_024;
const AUTHENTICATED_HEADER: &[u8] = b"TermPilotBackup:v1:PBKDF2-HMAC-SHA256:AES-256-GCM";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSnapshot {
    pub schema_version: u32,
    pub exported_at: String,
    pub hosts: Vec<Host>,
    pub groups: Vec<HostGroup>,
    pub credentials: Vec<Credential>,
    pub proxy_profiles: Vec<ProxyProfile>,
    pub port_forward_rules: Vec<PortForwardRule>,
    pub automation_scripts: Vec<AutomationScript>,
    pub host_notes: Vec<HostNote>,
}

impl BackupSnapshot {
    pub fn new(
        hosts: Vec<Host>,
        groups: Vec<HostGroup>,
        credentials: Vec<Credential>,
        proxy_profiles: Vec<ProxyProfile>,
        port_forward_rules: Vec<PortForwardRule>,
        automation_scripts: Vec<AutomationScript>,
        host_notes: Vec<HostNote>,
    ) -> Self {
        Self {
            schema_version: BACKUP_SCHEMA_VERSION,
            exported_at: now(),
            hosts,
            groups,
            credentials,
            proxy_profiles,
            port_forward_rules,
            automation_scripts,
            host_notes,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportSummary {
    pub hosts: usize,
    pub deduplicated_hosts: usize,
    pub groups: usize,
    pub credentials: usize,
    pub proxy_profiles: usize,
    pub port_forward_rules: usize,
    pub automation_scripts: usize,
    pub host_notes: usize,
}

#[derive(Debug, Error)]
pub enum BackupError {
    #[error("Backup password must contain at least 8 characters.")]
    PasswordTooShort,
    #[error("The selected file is not a valid TermPilot backup.")]
    InvalidFormat,
    #[error("The backup uses unsupported password protection settings.")]
    InvalidKeyDerivation,
    #[error("The backup password is incorrect or the file has been modified.")]
    AuthenticationFailed,
    #[error("The decrypted backup data is invalid.")]
    InvalidPayload,
    #[error("This TermPilot backup version is not supported.")]
    UnsupportedVersion,
    #[error("The backup file is too large.")]
    FileTooLarge,
    #[error("Unable to encrypt the backup.")]
    EncryptionFailed,
    #[error("Unable to generate secure backup encryption data.")]
    RandomGenerationFailed,
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Deserialize, Serialize)]
struct EncryptedBackupEnvelope {
    magic: String,
    version: u32,
    kdf: String,
    iterations: u32,
    salt: String,
    cipher: String,
    payload: String,
}

pub fn encrypt_snapshot(snapshot: &BackupSnapshot, password: &str) -> Result<Vec<u8>, BackupError> {
    let salt: [u8; BACKUP_SALT_SIZE] = rand::random();
    let nonce: [u8; BACKUP_NONCE_SIZE] = rand::random();
    encrypt_snapshot_with_material(snapshot, password, BACKUP_PBKDF2_ITERATIONS, &salt, &nonce)
}

fn encrypt_snapshot_with_material(
    snapshot: &BackupSnapshot,
    password: &str,
    iterations: u32,
    salt: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>, BackupError> {
    validate_snapshot(snapshot)?;
    validate_password(password)?;
    validate_iterations(iterations)?;
    if salt.len() != BACKUP_SALT_SIZE || nonce.len() != BACKUP_NONCE_SIZE {
        return Err(BackupError::RandomGenerationFailed);
    }
    let plaintext = serialize_swift_snapshot(snapshot)?;
    let key = derive_key(password, salt, iterations)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| BackupError::EncryptionFailed)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: &plaintext,
                aad: AUTHENTICATED_HEADER,
            },
        )
        .map_err(|_| BackupError::EncryptionFailed)?;
    let mut combined = Vec::with_capacity(nonce.len() + encrypted.len());
    combined.extend_from_slice(nonce);
    combined.extend_from_slice(&encrypted);
    let envelope = EncryptedBackupEnvelope {
        magic: BACKUP_MAGIC.to_string(),
        version: BACKUP_FORMAT_VERSION,
        kdf: BACKUP_KDF.to_string(),
        iterations,
        salt: BASE64.encode(salt),
        cipher: BACKUP_CIPHER.to_string(),
        payload: BASE64.encode(combined),
    };
    serde_json::to_vec(&envelope).map_err(BackupError::from)
}

pub fn decrypt_snapshot(data: &[u8], password: &str) -> Result<BackupSnapshot, BackupError> {
    if data.len() > MAXIMUM_BACKUP_FILE_SIZE {
        return Err(BackupError::FileTooLarge);
    }
    validate_password(password)?;
    let envelope: EncryptedBackupEnvelope =
        serde_json::from_slice(data).map_err(|_| BackupError::InvalidFormat)?;
    if envelope.magic != BACKUP_MAGIC
        || envelope.version != BACKUP_FORMAT_VERSION
        || envelope.kdf != BACKUP_KDF
        || envelope.cipher != BACKUP_CIPHER
    {
        return Err(BackupError::InvalidFormat);
    }
    validate_iterations(envelope.iterations)?;
    let salt = BASE64
        .decode(envelope.salt)
        .map_err(|_| BackupError::InvalidFormat)?;
    let combined = BASE64
        .decode(envelope.payload)
        .map_err(|_| BackupError::InvalidFormat)?;
    if salt.len() != BACKUP_SALT_SIZE || combined.len() <= BACKUP_NONCE_SIZE + 16 {
        return Err(BackupError::InvalidFormat);
    }
    let key = derive_key(password, &salt, envelope.iterations)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| BackupError::AuthenticationFailed)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&combined[..BACKUP_NONCE_SIZE]),
            Payload {
                msg: &combined[BACKUP_NONCE_SIZE..],
                aad: AUTHENTICATED_HEADER,
            },
        )
        .map_err(|_| BackupError::AuthenticationFailed)?;
    let snapshot = deserialize_swift_snapshot(&plaintext)?;
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

pub fn write_encrypted_backup(
    path: &Path,
    snapshot: &BackupSnapshot,
    password: &str,
) -> Result<(), BackupError> {
    let data = encrypt_snapshot(snapshot, password)?;
    let temporary = path.with_extension(format!("{BACKUP_FILE_EXTENSION}.tmp"));
    fs::write(&temporary, data)?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

pub fn read_encrypted_backup(path: &Path, password: &str) -> Result<BackupSnapshot, BackupError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAXIMUM_BACKUP_FILE_SIZE as u64 {
        return Err(BackupError::FileTooLarge);
    }
    decrypt_snapshot(&fs::read(path)?, password)
}

fn serialize_swift_snapshot(snapshot: &BackupSnapshot) -> Result<Vec<u8>, BackupError> {
    let mut value = serde_json::to_value(snapshot)?;
    rename_tauri_keys_to_swift(&mut value);
    if let Value::Object(root) = &mut value {
        if let Some(Value::Array(hosts)) = root.get_mut("hosts") {
            for host in hosts {
                if let Value::Object(host) = host {
                    host.remove("elevationPassword");
                }
            }
        }
        if let Some(Value::Array(profiles)) = root.get_mut("proxyProfiles") {
            for profile in profiles {
                if let Value::Object(profile) = profile {
                    profile.remove("sortOrder");
                }
            }
        }
        if let Some(Value::Array(scripts)) = root.get_mut("automationScripts") {
            for script in scripts {
                if let Value::Object(script) = script {
                    script.remove("sortOrder");
                }
            }
        }
    }
    canonicalize_backup_dates(&mut value);
    serde_json::to_vec(&value).map_err(BackupError::from)
}

fn deserialize_swift_snapshot(data: &[u8]) -> Result<BackupSnapshot, BackupError> {
    let mut value: Value = serde_json::from_slice(data).map_err(|_| BackupError::InvalidPayload)?;
    rename_swift_keys_to_tauri(&mut value);
    serde_json::from_value(value).map_err(|_| BackupError::InvalidPayload)
}

fn rename_tauri_keys_to_swift(value: &mut Value) {
    rename_keys(
        value,
        &[
            ("hostId", "hostID"),
            ("credentialId", "credentialID"),
            ("proxyProfileId", "proxyProfileID"),
            ("groupId", "groupID"),
            ("parentGroupId", "parentGroupID"),
            ("iconId", "iconID"),
            ("sftpFollowsTerminalCwd", "sftpFollowsTerminalCWD"),
        ],
    );
}

fn rename_swift_keys_to_tauri(value: &mut Value) {
    rename_keys(
        value,
        &[
            ("hostID", "hostId"),
            ("credentialID", "credentialId"),
            ("proxyProfileID", "proxyProfileId"),
            ("groupID", "groupId"),
            ("parentGroupID", "parentGroupId"),
            ("iconID", "iconId"),
            ("sftpFollowsTerminalCWD", "sftpFollowsTerminalCwd"),
        ],
    );
}

fn rename_keys(value: &mut Value, mappings: &[(&str, &str)]) {
    match value {
        Value::Object(object) => {
            for (source, destination) in mappings {
                if let Some(value) = object.remove(*source) {
                    object.insert((*destination).to_string(), value);
                }
            }
            object
                .values_mut()
                .for_each(|value| rename_keys(value, mappings));
        }
        Value::Array(values) => {
            values
                .iter_mut()
                .for_each(|value| rename_keys(value, mappings));
        }
        _ => {}
    }
}

fn canonicalize_backup_dates(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "exportedAt" | "createdAt" | "updatedAt" | "lastUsedAt"
                ) {
                    if let Value::String(date) = value {
                        if let Ok(parsed) = DateTime::parse_from_rfc3339(date) {
                            *date = parsed
                                .with_timezone(&Utc)
                                .to_rfc3339_opts(SecondsFormat::Secs, true);
                        }
                    }
                } else {
                    canonicalize_backup_dates(value);
                }
            }
        }
        Value::Array(values) => {
            values.iter_mut().for_each(canonicalize_backup_dates);
        }
        _ => {}
    }
}

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> Result<[u8; 32], BackupError> {
    validate_iterations(iterations)?;
    pbkdf2_sha256(password, salt, iterations)
}

fn pbkdf2_sha256(password: &str, salt: &[u8], iterations: u32) -> Result<[u8; 32], BackupError> {
    if iterations == 0 {
        return Err(BackupError::InvalidKeyDerivation);
    }
    let normalized = password.nfc().collect::<String>();
    let mut key = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(normalized.as_bytes(), salt, iterations, &mut key);
    Ok(key)
}

fn validate_password(password: &str) -> Result<(), BackupError> {
    let normalized = password.nfc().collect::<String>();
    if normalized.graphemes(true).count() < 8 {
        return Err(BackupError::PasswordTooShort);
    }
    Ok(())
}

fn validate_iterations(iterations: u32) -> Result<(), BackupError> {
    if !(MINIMUM_PBKDF2_ITERATIONS..=MAXIMUM_PBKDF2_ITERATIONS).contains(&iterations) {
        return Err(BackupError::InvalidKeyDerivation);
    }
    Ok(())
}

fn validate_snapshot(snapshot: &BackupSnapshot) -> Result<(), BackupError> {
    if snapshot.schema_version != BACKUP_SCHEMA_VERSION {
        return Err(BackupError::UnsupportedVersion);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SWIFT_FIXTURE: &str = r#"{"cipher":"AES-256-GCM","iterations":100000,"kdf":"PBKDF2-HMAC-SHA256","magic":"TermPilotBackup","payload":"EBESExQVFhcYGRobhoWV9g8H9TA9At6zZC2ljTLr07bsZskZvccvsTHkRIWcQ66iJ\/1y53JJ1LDY9VYv\/+JBbanpF\/bBP5D6+ApwZQbPmNPhLZEQATCA\/qS\/W6+jtkLIfWRtuMdq+KIGYfcd+\/\/Yh8CHxAE6Pa85wPrcLlTbmVJcXKEXX8LSdaXZls8PKkeIfhNa4E0FAmF7czrBbBjsvfmd\/6flCtDUYjKvb2VaSSCHU\/Dj1FNyufyDJ3L8un38FZXR0+pFkzvgMQ==","salt":"AAECAwQFBgcICQoLDA0ODw==","version":1}"#;

    fn empty_snapshot() -> BackupSnapshot {
        BackupSnapshot {
            schema_version: 1,
            exported_at: "2023-11-14T22:13:20Z".to_string(),
            hosts: Vec::new(),
            groups: Vec::new(),
            credentials: Vec::new(),
            proxy_profiles: Vec::new(),
            port_forward_rules: Vec::new(),
            automation_scripts: Vec::new(),
            host_notes: Vec::new(),
        }
    }

    #[test]
    fn pbkdf2_sha256_matches_swift_vector() {
        let vector = pbkdf2_sha256("password", b"salt", 2).unwrap();
        assert_eq!(
            hex(&vector),
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"
        );
    }

    #[test]
    fn deterministic_output_matches_crypto_kit_fixture() {
        let salt = (0_u8..16).collect::<Vec<_>>();
        let nonce = (16_u8..28).collect::<Vec<_>>();
        let encrypted = encrypt_snapshot_with_material(
            &empty_snapshot(),
            "backup-password",
            100_000,
            &salt,
            &nonce,
        )
        .unwrap();
        let rust_value: Value = serde_json::from_slice(&encrypted).unwrap();
        let swift_value: Value = serde_json::from_str(SWIFT_FIXTURE).unwrap();
        assert_eq!(rust_value, swift_value);
    }

    #[test]
    fn decrypts_crypto_kit_fixture_and_rejects_wrong_password() {
        let snapshot = decrypt_snapshot(SWIFT_FIXTURE.as_bytes(), "backup-password").unwrap();
        assert_eq!(snapshot.schema_version, 1);
        assert_eq!(snapshot.exported_at, "2023-11-14T22:13:20Z");
        assert!(snapshot.hosts.is_empty());
        assert!(matches!(
            decrypt_snapshot(SWIFT_FIXTURE.as_bytes(), "wrong-password"),
            Err(BackupError::AuthenticationFailed)
        ));
    }

    #[test]
    fn snapshot_schema_excludes_known_hosts() {
        let value = serde_json::to_value(empty_snapshot()).unwrap();
        assert_eq!(value.get("knownHosts"), None);
        assert_eq!(value["schemaVersion"], json!(1));
    }

    #[test]
    fn serialized_snapshot_matches_swift_field_and_date_shape() {
        let host: Host = serde_json::from_value(json!({
            "id": "10000000-0000-0000-0000-000000000001",
            "label": "Server",
            "hostname": "192.0.2.10",
            "username": "root",
            "elevationPassword": "not-a-swift-host-field",
            "createdAt": "2026-01-01T00:00:00.123Z",
            "updatedAt": "2026-01-01T00:00:01.456Z"
        }))
        .unwrap();
        let profile: ProxyProfile = serde_json::from_value(json!({
            "id": "20000000-0000-0000-0000-000000000002",
            "label": "Proxy",
            "configuration": {
                "type": "http",
                "host": "proxy.example.com",
                "port": 8080
            },
            "sortOrder": 7,
            "createdAt": "2026-01-01T00:00:00.123Z",
            "updatedAt": "2026-01-01T00:00:01.456Z"
        }))
        .unwrap();
        let script: AutomationScript = serde_json::from_value(json!({
            "id": "30000000-0000-0000-0000-000000000003",
            "title": "Deploy",
            "shell": "/bin/sh",
            "body": "echo ready",
            "sortOrder": 9,
            "createdAt": "2026-01-01T00:00:00.123Z",
            "updatedAt": "2026-01-01T00:00:01.456Z"
        }))
        .unwrap();
        let mut snapshot = empty_snapshot();
        snapshot.exported_at = "2026-01-01T00:00:02.789Z".to_string();
        snapshot.hosts = vec![host];
        snapshot.proxy_profiles = vec![profile];
        snapshot.automation_scripts = vec![script];

        let value: Value =
            serde_json::from_slice(&serialize_swift_snapshot(&snapshot).unwrap()).unwrap();
        assert_eq!(value["exportedAt"], "2026-01-01T00:00:02Z");
        assert_eq!(value["hosts"][0]["createdAt"], "2026-01-01T00:00:00Z");
        assert!(value["hosts"][0].get("elevationPassword").is_none());
        assert!(value["proxyProfiles"][0].get("sortOrder").is_none());
        assert!(value["automationScripts"][0].get("sortOrder").is_none());
    }

    #[test]
    fn full_snapshot_round_trips_the_current_swift_model_shape() {
        let swift_value: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/swift-full-snapshot-v1.json"
        ))
        .unwrap();
        let snapshot = deserialize_swift_snapshot(include_bytes!(
            "../tests/fixtures/swift-full-snapshot-v1.json"
        ))
        .unwrap();
        assert_eq!(snapshot.hosts[0].hostname, "host.example.invalid");
        assert_eq!(
            snapshot.credentials[0].elevation_password.as_deref(),
            Some("fixture-elevation-value")
        );

        let mut tauri_value: Value =
            serde_json::from_slice(&serialize_swift_snapshot(&snapshot).unwrap()).unwrap();
        remove_null_values(&mut tauri_value);
        assert_eq!(tauri_value, swift_value);
    }

    fn remove_null_values(value: &mut Value) {
        match value {
            Value::Object(object) => {
                object.retain(|_, value| !value.is_null());
                object.values_mut().for_each(remove_null_values);
            }
            Value::Array(values) => {
                values.iter_mut().for_each(remove_null_values);
            }
            _ => {}
        }
    }

    fn hex(data: &[u8]) -> String {
        data.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
