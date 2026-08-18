use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::AppServices;
use crate::domain::Host;
use crate::terminal::{TerminalLaunch, TerminalManager};

pub(crate) struct BridgePaths {
    pub(crate) node: String,
    pub(crate) ssh_script: PathBuf,
    pub(crate) sftp_script: PathBuf,
    pub(crate) proxy_script: PathBuf,
    pub(crate) keygen_script: PathBuf,
    pub(crate) node_modules: PathBuf,
}

impl BridgePaths {
    pub(crate) fn locate(app: &AppHandle) -> Result<Self, String> {
        let resource_directory = app.path().resource_dir().map_err(error_message)?;
        let source_root = development_source_root();
        let bridge_candidates = [
            Some(resource_directory.join("bridge")),
            source_root.as_ref().map(|root| root.join("bridge")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let node_module_candidates = [
            Some(resource_directory.join("node_modules")),
            source_root.as_ref().map(|root| root.join("node_modules")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

        let bridge_root = first_directory(&bridge_candidates)
            .ok_or_else(|| "TermPilot bridge resources are missing".to_string())?;
        let node_modules = first_directory(&node_module_candidates)
            .ok_or_else(|| "TermPilot bridge Node modules are missing".to_string())?;

        let bundled_node = if cfg!(windows) {
            resource_directory.join("node/node.exe")
        } else {
            resource_directory.join("node/bin/node")
        };
        let node = if bundled_node.is_file() {
            bundled_node.to_string_lossy().to_string()
        } else {
            std::env::var("TERMPILOT_NODE").unwrap_or_else(|_| {
                if cfg!(windows) {
                    "node.exe".to_string()
                } else {
                    "node".to_string()
                }
            })
        };

        Ok(Self {
            node,
            ssh_script: bridge_root.join("ssh2-bridge/termpilot-ssh2-bridge.cjs"),
            sftp_script: bridge_root.join("sftp-bridge/termpilot-sftp-bridge.cjs"),
            proxy_script: bridge_root.join("proxy-bridge/termpilot-proxy-command.cjs"),
            keygen_script: bridge_root.join("keygen/termpilot-keygen.cjs"),
            node_modules,
        })
    }
}

fn development_source_root() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshBridgeConfig<'a> {
    hostname: &'a str,
    port: u16,
    username: &'a str,
    authentication: &'a crate::domain::AuthenticationMethod,
    password: Option<&'a str>,
    identity_file: Option<&'a str>,
    private_key: Option<&'a str>,
    passphrase: Option<&'a str>,
    certificate: Option<&'a str>,
    proxy: Option<&'a crate::domain::ProxyConfiguration>,
    connection_id: &'a str,
    session_id: &'a str,
    known_hosts_file: String,
    auto_accept_host_keys: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyGenerationRequest {
    key_type: String,
    bits: Option<u16>,
    passphrase: Option<String>,
    comment: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKeyPair {
    private_key: String,
    public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyGenerationConfiguration {
    key_type: String,
    bits: Option<u16>,
    passphrase: Option<String>,
    comment: String,
}

#[tauri::command]
pub async fn generate_credential_key(
    app: AppHandle,
    request: KeyGenerationRequest,
) -> Result<GeneratedKeyPair, String> {
    let paths = BridgePaths::locate(&app)?;
    let configuration = validated_key_generation_configuration(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let encoded = BASE64.encode(serde_json::to_vec(&configuration).map_err(error_message)?);
        let mut command = Command::new(&paths.node);
        command
            .arg(&paths.keygen_script)
            .env("TERMPILOT_KEYGEN_CONFIG_B64", encoded)
            .env(
                "TERMPILOT_SSH2_NODE_MODULES",
                paths.node_modules.to_string_lossy().to_string(),
            )
            .env(
                "NODE_PATH",
                paths.node_modules.to_string_lossy().to_string(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = command.output().map_err(error_message)?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                "SSH key generation failed".to_string()
            } else {
                message
            });
        }
        serde_json::from_slice(&output.stdout).map_err(error_message)
    })
    .await
    .map_err(error_message)?
}

fn validated_key_generation_configuration(
    request: KeyGenerationRequest,
) -> Result<KeyGenerationConfiguration, String> {
    let key_type = request.key_type.trim().to_ascii_lowercase();
    let bits = match key_type.as_str() {
        "ed25519" => None,
        "ecdsa" => {
            let bits = request.bits.unwrap_or(256);
            [256, 384, 521]
                .contains(&bits)
                .then_some(bits)
                .ok_or_else(|| "ECDSA bits must be 256, 384, or 521".to_string())?
                .into()
        }
        "rsa" => {
            let bits = request.bits.unwrap_or(4096);
            [1024, 2048, 4096]
                .contains(&bits)
                .then_some(bits)
                .ok_or_else(|| "RSA bits must be 1024, 2048, or 4096".to_string())?
                .into()
        }
        _ => return Err("Key type must be ED25519, ECDSA, or RSA".to_string()),
    };
    Ok(KeyGenerationConfiguration {
        key_type,
        bits,
        passphrase: request.passphrase.filter(|value| !value.is_empty()),
        comment: request.comment.unwrap_or_default().trim().to_string(),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ssh_terminal_start(
    app: AppHandle,
    services: State<'_, AppServices>,
    terminals: State<'_, TerminalManager>,
    session_id: String,
    host: Host,
    columns: u16,
    rows: u16,
    auto_accept_host_keys: Option<bool>,
) -> Result<(), String> {
    let paths = BridgePaths::locate(&app)?;
    let configuration = SshBridgeConfig {
        hostname: &host.hostname,
        port: host.port,
        username: &host.username,
        authentication: &host.authentication,
        password: host.password.as_deref(),
        identity_file: host.identity_file.as_deref(),
        private_key: host.identity_key.as_deref(),
        passphrase: host.passphrase.as_deref(),
        certificate: host.certificate.as_deref(),
        proxy: host.proxy_configuration.as_ref(),
        connection_id: &session_id,
        session_id: &session_id,
        known_hosts_file: services
            .vault
            .known_hosts_path()
            .to_string_lossy()
            .to_string(),
        auto_accept_host_keys: auto_accept_host_keys.unwrap_or(false),
    };
    let encoded = BASE64.encode(serde_json::to_vec(&configuration).map_err(error_message)?);
    let mut environment = HashMap::new();
    environment.insert("TERMPILOT_SSH2_BRIDGE_CONFIG_B64".to_string(), encoded);
    environment.insert(
        "TERMPILOT_SSH2_NODE_MODULES".to_string(),
        paths.node_modules.to_string_lossy().to_string(),
    );
    environment.insert(
        "NODE_PATH".to_string(),
        paths.node_modules.to_string_lossy().to_string(),
    );
    environment.insert(
        "TERMPILOT_SFTP_BRIDGE_SCRIPT".to_string(),
        paths.sftp_script.to_string_lossy().to_string(),
    );
    if cfg!(windows)
        && matches!(
            host.authentication,
            crate::domain::AuthenticationMethod::Agent
        )
        && std::env::var_os("SSH_AUTH_SOCK").is_none()
    {
        environment.insert(
            "SSH_AUTH_SOCK".to_string(),
            r"\\.\pipe\openssh-ssh-agent".to_string(),
        );
    }
    terminals.start_piped(
        app,
        TerminalLaunch {
            session_id,
            program: paths.node,
            arguments: vec![paths.ssh_script.to_string_lossy().to_string()],
            working_directory: paths
                .ssh_script
                .parent()
                .map(|value| value.to_string_lossy().to_string()),
            columns,
            rows,
            environment,
        },
    )
}

#[derive(Clone)]
pub struct SftpManager {
    clients: Arc<Mutex<HashMap<String, Arc<SftpClient>>>>,
    generations: Arc<Mutex<HashMap<String, u64>>>,
}

impl Default for SftpManager {
    fn default() -> Self {
        Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
            generations: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

const SFTP_BROKER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const SFTP_DEDICATED_READY_TIMEOUT: Duration = Duration::from_secs(35);
const SFTP_TRANSFER_STALL_TIMEOUT: Duration = Duration::from_secs(30);
const SFTP_TRANSFER_WATCH_INTERVAL: Duration = Duration::from_secs(2);

impl SftpManager {
    fn request(
        &self,
        app: &AppHandle,
        host: &Host,
        source_session_id: Option<&str>,
        mut request: Value,
        idle_seconds: u64,
    ) -> Result<Value, String> {
        let action = request
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let data_transfer = matches!(action, "upload" | "download");
        let transfer_client_request =
            data_transfer || matches!(action, "pause" | "resume" | "cancel");
        let client_key = sftp_client_key(&host.id, source_session_id, transfer_client_request);
        let original_request = request.clone();
        let cached_client = self.clients.lock().get(&client_key).cloned();
        let mut client = if let Some(client) = cached_client {
            client
        } else if transfer_client_request {
            let client = Arc::new(SftpClient::start(app, host, None)?);
            self.clients
                .lock()
                .insert(client_key.clone(), client.clone());
            client
        } else {
            let client = match SftpClient::start(app, host, source_session_id) {
                Ok(client) => Arc::new(client),
                Err(_) if source_session_id.is_some() => {
                    Arc::new(SftpClient::start(app, host, None)?)
                }
                Err(error) => return Err(error),
            };
            self.clients
                .lock()
                .insert(client_key.clone(), client.clone());
            client
        };
        let generation = {
            let mut generations = self.generations.lock();
            let generation = generations.entry(client_key.clone()).or_default();
            *generation = generation.wrapping_add(1);
            *generation
        };
        let mut result = client.request(&mut request);
        if result.is_err() && !transfer_client_request && !client.is_running() && client.uses_broker
        {
            self.clients.lock().remove(&client_key);
            client.close();
            let fallback = Arc::new(SftpClient::start(app, host, None)?);
            self.clients
                .lock()
                .insert(client_key.clone(), fallback.clone());
            client = fallback;
            let mut retry_request = original_request;
            result = client.request(&mut retry_request);
        }
        let discards_failed_client = result.is_err()
            && ((!transfer_client_request && !client.is_running())
                || (data_transfer && !client.has_active_transfers()));
        if discards_failed_client {
            let removed = {
                let mut clients = self.clients.lock();
                if clients
                    .get(&client_key)
                    .is_some_and(|current| Arc::ptr_eq(current, &client))
                {
                    clients.remove(&client_key)
                } else {
                    None
                }
            };
            self.generations.lock().remove(&client_key);
            if let Some(client) = removed {
                client.close();
            }
        } else if result.is_ok()
            && should_schedule_sftp_idle_close(transfer_client_request, idle_seconds)
        {
            let clients = self.clients.clone();
            let generations = self.generations.clone();
            thread::spawn(move || loop {
                thread::sleep(std::time::Duration::from_secs(idle_seconds));
                let unchanged = generations.lock().get(&client_key).copied() == Some(generation);
                if !unchanged {
                    return;
                }
                if client.has_active_transfers() {
                    continue;
                }
                let removed = {
                    let mut clients = clients.lock();
                    if clients
                        .get(&client_key)
                        .is_some_and(|current| Arc::ptr_eq(current, &client))
                    {
                        clients.remove(&client_key)
                    } else {
                        None
                    }
                };
                if let Some(client) = removed {
                    generations.lock().remove(&client_key);
                    client.close();
                }
                return;
            });
        }
        result
    }

    fn close(&self, host_id: &str, source_session_id: Option<&str>) {
        let client_key = sftp_client_key(host_id, source_session_id, false);
        self.generations.lock().remove(&client_key);
        if let Some(client) = self.clients.lock().remove(&client_key) {
            client.close();
        }
    }

    pub fn close_all(&self) {
        self.generations.lock().clear();
        let clients = std::mem::take(&mut *self.clients.lock());
        for (_, client) in clients {
            client.close();
        }
    }
}

type PendingSftpRequests = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;
type TransferActivities = Arc<Mutex<HashMap<u64, TransferActivity>>>;

struct TransferActivity {
    transferred: u64,
    last_progress: Instant,
}

impl TransferActivity {
    fn new(now: Instant) -> Self {
        Self {
            transferred: 0,
            last_progress: now,
        }
    }

    fn record(&mut self, transferred: u64, now: Instant) {
        if transferred > self.transferred {
            self.transferred = transferred;
            self.last_progress = now;
        }
    }

    fn is_stalled(&self, now: Instant, timeout: Duration) -> bool {
        now.duration_since(self.last_progress) >= timeout
    }
}

struct SftpClient {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: PendingSftpRequests,
    transfers: Arc<Mutex<HashMap<String, u64>>>,
    activities: TransferActivities,
    uses_broker: bool,
}

impl SftpClient {
    fn start(
        app: &AppHandle,
        host: &Host,
        source_session_id: Option<&str>,
    ) -> Result<Self, String> {
        let paths = BridgePaths::locate(app)?;
        let configuration = json!({
            "hostname": host.hostname,
            "port": host.port,
            "username": host.username,
            "authentication": host.authentication,
            "password": host.password,
            "identityFile": host.identity_file,
            "privateKey": host.identity_key,
            "passphrase": host.passphrase,
            "certificate": host.certificate,
            "proxy": host.proxy_configuration,
            "fileProtocol": host.sftp_file_protocol,
            "filenameEncoding": host.sftp_filename_encoding,
            "usesSudo": host.sftp_uses_sudo,
            "persistentElevation": false,
            "elevationMethod": host.server_tools_elevation_method,
            "elevationPassword": host.elevation_password,
            "connectionID": source_session_id.unwrap_or(&host.id),
            "sourceSessionID": source_session_id,
            "execOnly": false
        });
        let encoded = BASE64.encode(serde_json::to_vec(&configuration).map_err(error_message)?);
        let use_broker = source_session_id.is_some();
        let script = if use_broker {
            &paths.ssh_script
        } else {
            &paths.sftp_script
        };

        let mut command = Command::new(&paths.node);
        command
            .arg(script)
            .current_dir(script.parent().unwrap_or(Path::new(".")))
            .env("TERMPILOT_SFTP_BRIDGE_CONFIG_B64", &encoded)
            .env("TERMPILOT_SSH2_NODE_MODULES", &paths.node_modules)
            .env("NODE_PATH", &paths.node_modules)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if use_broker {
            command
                .env("TERMPILOT_SSH2_BRIDGE_CONFIG_B64", &encoded)
                .env("TERMPILOT_SSH2_BRIDGE_SFTP_CLIENT", "1")
                .env("TERMPILOT_SFTP_BRIDGE_SCRIPT", &paths.sftp_script);
        }
        if cfg!(windows)
            && matches!(
                host.authentication,
                crate::domain::AuthenticationMethod::Agent
            )
            && std::env::var_os("SSH_AUTH_SOCK").is_none()
        {
            command.env("SSH_AUTH_SOCK", r"\\.\pipe\openssh-ssh-agent");
        }
        let mut child = command.spawn().map_err(error_message)?;
        let input = match child.stdin.take() {
            Some(input) => input,
            None => {
                terminate_child(&mut child);
                return Err("SFTP bridge stdin is unavailable".to_string());
            }
        };
        let output = match child.stdout.take() {
            Some(output) => output,
            None => {
                terminate_child(&mut child);
                return Err("SFTP bridge stdout is unavailable".to_string());
            }
        };
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    line.clear();
                }
            });
        }
        let mut output = BufReader::new(output);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let result = Self::wait_until_ready(&mut output);
            let _ = ready_sender.send((result, output));
        });
        let ready_timeout = if use_broker {
            SFTP_BROKER_READY_TIMEOUT
        } else {
            SFTP_DEDICATED_READY_TIMEOUT
        };
        let output = match ready_receiver.recv_timeout(ready_timeout) {
            Ok((Ok(()), output)) => output,
            Ok((Err(error), _)) => {
                terminate_child(&mut child);
                return Err(error);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                terminate_child(&mut child);
                return Err(format!(
                    "SFTP did not respond within {} seconds. Check the host SFTP/SCP settings or retry.",
                    ready_timeout.as_secs()
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                terminate_child(&mut child);
                return Err("SFTP bridge readiness check ended unexpectedly".to_string());
            }
        };
        let pending: PendingSftpRequests = Arc::new(Mutex::new(HashMap::new()));
        let transfers = Arc::new(Mutex::new(HashMap::<String, u64>::new()));
        let activities: TransferActivities = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();
        let reader_transfers = transfers.clone();
        let reader_activities = activities.clone();
        let reader_app = app.clone();
        thread::spawn(move || {
            let mut output = output;
            let mut line = String::new();
            loop {
                line.clear();
                match output.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let Ok(mut response) = serde_json::from_str::<Value>(&line) else {
                            continue;
                        };
                        if response.get("event").and_then(Value::as_str) == Some("progress") {
                            if let Some(id) = response.get("id").and_then(Value::as_u64) {
                                if let Some(transferred) =
                                    response.get("transferred").and_then(Value::as_u64)
                                {
                                    if let Some(activity) = reader_activities.lock().get_mut(&id) {
                                        activity.record(transferred, Instant::now());
                                    }
                                }
                                let transfer_key =
                                    reader_transfers
                                        .lock()
                                        .iter()
                                        .find_map(|(key, request_id)| {
                                            (*request_id == id).then(|| key.clone())
                                        });
                                if let (Some(transfer_key), Some(response)) =
                                    (transfer_key, response.as_object_mut())
                                {
                                    response.insert(
                                        "transferKey".to_string(),
                                        Value::String(transfer_key),
                                    );
                                }
                            }
                            let _ = reader_app.emit("sftp-progress", &response);
                            continue;
                        }
                        let Some(id) = response.get("id").and_then(Value::as_u64) else {
                            continue;
                        };
                        reader_transfers
                            .lock()
                            .retain(|_, request_id| *request_id != id);
                        reader_activities.lock().remove(&id);
                        let Some(sender) = reader_pending.lock().remove(&id) else {
                            continue;
                        };
                        let result = if response.get("ok").and_then(Value::as_bool) == Some(true) {
                            Ok(response.get("result").cloned().unwrap_or_else(|| json!({})))
                        } else {
                            Err(response
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Unknown SFTP bridge error")
                                .to_string())
                        };
                        let _ = sender.send(result);
                    }
                    Err(error) => {
                        let senders = std::mem::take(&mut *reader_pending.lock());
                        for (_, sender) in senders {
                            let _ = sender.send(Err(error.to_string()));
                        }
                        break;
                    }
                }
            }
            reader_transfers.lock().clear();
            reader_activities.lock().clear();
            let senders = std::mem::take(&mut *reader_pending.lock());
            for (_, sender) in senders {
                let _ = sender.send(Err("SFTP bridge closed unexpectedly".to_string()));
            }
        });
        Ok(Self {
            child: Mutex::new(child),
            input: Mutex::new(input),
            next_id: AtomicU64::new(1),
            pending,
            transfers,
            activities,
            uses_broker: use_broker,
        })
    }

    fn wait_until_ready(output: &mut BufReader<ChildStdout>) -> Result<(), String> {
        loop {
            let mut line = String::new();
            let count = output.read_line(&mut line).map_err(error_message)?;
            if count == 0 {
                return Err("SFTP bridge closed before becoming ready".to_string());
            }
            let value: Value = serde_json::from_str(&line).map_err(error_message)?;
            if value.get("id").and_then(Value::as_i64) == Some(0) {
                if value.get("event").and_then(Value::as_str) == Some("ready")
                    || value.get("ok").and_then(Value::as_bool) == Some(true)
                {
                    return Ok(());
                }
                if let Some(error) = value.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
            }
        }
    }

    fn request(&self, request: &mut Value) -> Result<Value, String> {
        let action = request
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let transfer_key = request
            .get("transferKey")
            .and_then(Value::as_str)
            .map(str::to_string);
        if matches!(action.as_str(), "pause" | "resume" | "cancel") {
            if let Some(request_id) = transfer_key
                .as_ref()
                .and_then(|key| self.transfers.lock().get(key).copied())
            {
                request
                    .as_object_mut()
                    .ok_or_else(|| "SFTP request must be an object".to_string())?
                    .insert("targetID".to_string(), Value::from(request_id));
            }
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        request
            .as_object_mut()
            .ok_or_else(|| "SFTP request must be an object".to_string())?
            .insert("id".to_string(), Value::from(id));
        if matches!(action.as_str(), "upload" | "download") {
            if let Some(key) = &transfer_key {
                self.transfers.lock().insert(key.clone(), id);
            }
            self.activities
                .lock()
                .insert(id, TransferActivity::new(Instant::now()));
        }
        let line = serde_json::to_string(request).map_err(error_message)? + "\n";
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().insert(id, sender);
        let write_result = {
            let mut input = self.input.lock();
            input
                .write_all(line.as_bytes())
                .and_then(|_| input.flush())
                .map_err(error_message)
        };
        if let Err(error) = write_result {
            self.pending.lock().remove(&id);
            self.transfers
                .lock()
                .retain(|_, request_id| *request_id != id);
            self.activities.lock().remove(&id);
            return Err(error);
        }
        if matches!(action.as_str(), "upload" | "download") {
            self.receive_transfer_response(id, receiver)
        } else {
            receiver.recv().map_err(error_message)?
        }
    }

    fn receive_transfer_response(
        &self,
        id: u64,
        receiver: mpsc::Receiver<Result<Value, String>>,
    ) -> Result<Value, String> {
        loop {
            match receiver.recv_timeout(SFTP_TRANSFER_WATCH_INTERVAL) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let stalled = self.activities.lock().get(&id).is_some_and(|activity| {
                        activity.is_stalled(Instant::now(), SFTP_TRANSFER_STALL_TIMEOUT)
                    });
                    if !stalled {
                        continue;
                    }
                    self.clear_transfer_request(id);
                    self.send_cancel(id);
                    return Err(format!(
                        "SFTP did not respond within {} seconds. Check the host SFTP/SCP settings or retry.",
                        SFTP_TRANSFER_STALL_TIMEOUT.as_secs()
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.clear_transfer_request(id);
                    return Err("SFTP bridge closed unexpectedly".to_string());
                }
            }
        }
    }

    fn clear_transfer_request(&self, id: u64) {
        self.pending.lock().remove(&id);
        self.transfers
            .lock()
            .retain(|_, request_id| *request_id != id);
        self.activities.lock().remove(&id);
    }

    fn send_cancel(&self, target_id: u64) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let line = json!({
            "id": id,
            "action": "cancel",
            "targetID": target_id,
        })
        .to_string()
            + "\n";
        let mut input = self.input.lock();
        let _ = input.write_all(line.as_bytes()).and_then(|_| input.flush());
    }

    fn close(&self) {
        {
            let mut child = self.child.lock();
            terminate_child(&mut child);
        }
        let senders = std::mem::take(&mut *self.pending.lock());
        for (_, sender) in senders {
            let _ = sender.send(Err("SFTP bridge closed".to_string()));
        }
        self.transfers.lock().clear();
        self.activities.lock().clear();
    }

    fn is_running(&self) -> bool {
        self.child
            .lock()
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(false)
    }

    fn has_active_transfers(&self) -> bool {
        !self.transfers.lock().is_empty()
    }
}

fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[tauri::command]
pub async fn sftp_request(
    app: AppHandle,
    state: State<'_, SftpManager>,
    host: Host,
    source_session_id: Option<String>,
    idle_seconds: Option<u64>,
    request: Value,
) -> Result<Value, String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.request(
            &app,
            &host,
            source_session_id.as_deref(),
            request,
            idle_seconds.unwrap_or(5 * 60),
        )
    })
    .await
    .map_err(error_message)?
}

#[tauri::command]
pub fn sftp_close(
    state: State<'_, SftpManager>,
    host_id: String,
    source_session_id: Option<String>,
) {
    state.close(&host_id, source_session_id.as_deref());
}

fn sftp_client_key(host_id: &str, source_session_id: Option<&str>, transfer: bool) -> String {
    let kind = if transfer { "transfer" } else { "session" };
    let identity = source_session_id
        .map(|session_id| format!("{host_id}:{session_id}"))
        .unwrap_or_else(|| host_id.to_string());
    format!("{kind}:{identity}")
}

fn should_schedule_sftp_idle_close(transfer_client: bool, idle_seconds: u64) -> bool {
    transfer_client && idle_seconds > 0
}

fn first_directory(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| path.is_dir()).cloned()
}

fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        sftp_client_key, should_schedule_sftp_idle_close, validated_key_generation_configuration,
        KeyGenerationRequest, TransferActivity,
    };

    fn key_request(key_type: &str, bits: Option<u16>) -> KeyGenerationRequest {
        KeyGenerationRequest {
            key_type: key_type.to_string(),
            bits,
            passphrase: None,
            comment: None,
        }
    }

    #[test]
    fn key_generation_defaults_match_the_ui() {
        let ed25519 =
            validated_key_generation_configuration(key_request("ed25519", Some(4096))).unwrap();
        assert_eq!(ed25519.key_type, "ed25519");
        assert_eq!(ed25519.bits, None);

        let ecdsa = validated_key_generation_configuration(key_request("ecdsa", None)).unwrap();
        assert_eq!(ecdsa.bits, Some(256));

        let rsa = validated_key_generation_configuration(key_request("rsa", None)).unwrap();
        assert_eq!(rsa.bits, Some(4096));
    }

    #[test]
    fn key_generation_rejects_unlisted_strengths() {
        assert!(validated_key_generation_configuration(key_request("ecdsa", Some(255))).is_err());
        assert!(validated_key_generation_configuration(key_request("rsa", Some(3072))).is_err());
    }

    #[test]
    fn sftp_clients_are_isolated_by_source_session() {
        assert_eq!(sftp_client_key("host", None, false), "session:host");
        assert_eq!(
            sftp_client_key("host", Some("session-a"), false),
            "session:host:session-a"
        );
        assert_ne!(
            sftp_client_key("host", Some("session-a"), false),
            sftp_client_key("host", Some("session-b"), false)
        );
        assert_ne!(
            sftp_client_key("host", Some("session-a"), false),
            sftp_client_key("host", Some("session-a"), true)
        );
    }

    #[test]
    fn only_transfer_clients_use_the_idle_timeout() {
        assert!(!should_schedule_sftp_idle_close(false, 300));
        assert!(!should_schedule_sftp_idle_close(true, 0));
        assert!(should_schedule_sftp_idle_close(true, 300));
    }

    #[test]
    fn transfer_stall_timer_resets_only_when_bytes_advance() {
        let started = Instant::now();
        let timeout = Duration::from_secs(30);
        let mut activity = TransferActivity::new(started);

        assert!(!activity.is_stalled(started + Duration::from_secs(29), timeout));
        activity.record(512, started + Duration::from_secs(20));
        activity.record(512, started + Duration::from_secs(40));
        assert!(!activity.is_stalled(started + Duration::from_secs(49), timeout));
        assert!(activity.is_stalled(started + Duration::from_secs(50), timeout));
    }
}
