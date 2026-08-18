use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, State};

use crate::bridge::BridgePaths;
use crate::commands::AppServices;
use crate::domain::{AuthenticationMethod, Host, PortForwardKind, PortForwardRule};

pub struct ForwardManager {
    processes: Arc<Mutex<HashMap<String, Arc<ManagedForward>>>>,
    host_key_requests: Arc<Mutex<HashMap<String, PathBuf>>>,
}

struct ManagedForward {
    child: Mutex<Child>,
    temporary_files: Vec<PathBuf>,
    stderr: Arc<Mutex<String>>,
    stopped_by_user: AtomicBool,
    cleaned: AtomicBool,
}

impl ManagedForward {
    fn cleanup(&self) {
        if self.cleaned.swap(true, Ordering::AcqRel) {
            return;
        }
        for path in &self.temporary_files {
            let _ = fs::remove_file(path);
        }
        if let Some(directory) = self.temporary_files.first().and_then(|path| path.parent()) {
            let _ = fs::remove_dir(directory);
        }
    }
}

impl Default for ForwardManager {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            host_key_requests: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardEvent {
    id: String,
    status: String,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardHostKeyPrompt {
    id: String,
    prompt: String,
}

impl ForwardManager {
    fn start(
        &self,
        app: AppHandle,
        known_hosts_file: &str,
        mut host: Host,
        mut rule: PortForwardRule,
        auto_accept_host_keys: bool,
    ) -> Result<(), String> {
        host.validate().map_err(error_message)?;
        rule.validate().map_err(error_message)?;
        self.stop(&rule.id)?;
        let mut launch = build_launch(&app, known_hosts_file, &host, &rule, auto_accept_host_keys)?;
        let request_directory = std::env::temp_dir()
            .join("TermPilot")
            .join("forward-askpass")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&request_directory).map_err(error_message)?;
        set_private_directory_permissions(&request_directory).map_err(error_message)?;
        let response_path = request_directory.join("response");
        let prompt_path = request_directory.join("prompt");
        let resolved_path = request_directory.join("resolved");
        launch.environment.insert(
            "TERMPILOT_ASKPASS_REQUEST_PATH".to_string(),
            response_path.to_string_lossy().to_string(),
        );
        launch.temporary_files.push(response_path.clone());
        launch.temporary_files.push(prompt_path.clone());
        launch.temporary_files.push(resolved_path.clone());
        self.host_key_requests
            .lock()
            .insert(rule.id.clone(), response_path);
        let mut command = Command::new(&launch.executable);
        command
            .args(&launch.arguments)
            .envs(&launch.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|error| {
            cleanup_paths(&launch.temporary_files);
            self.host_key_requests.lock().remove(&rule.id);
            error_message(error)
        })?;
        let prompt_app = app.clone();
        let prompt_id = rule.id.clone();
        thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < std::time::Duration::from_secs(125) {
                if let Ok(prompt) = fs::read_to_string(&prompt_path) {
                    let _ = prompt_app.emit(
                        "forward-host-key-prompt",
                        ForwardHostKeyPrompt {
                            id: prompt_id,
                            prompt,
                        },
                    );
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        if let Err(error) = wait_for_forward_ready(
            &mut child,
            &request_directory.join("prompt"),
            &resolved_path,
        ) {
            let _ = child.kill();
            let _ = child.wait();
            cleanup_paths(&launch.temporary_files);
            self.host_key_requests.lock().remove(&rule.id);
            return Err(error);
        }
        let stderr_output = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let stderr_output = stderr_output.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut message = String::new();
                while reader.read_line(&mut message).unwrap_or(0) > 0 {
                    let trimmed = message.trim();
                    if !trimmed.is_empty() {
                        let mut output = stderr_output.lock();
                        if !output.is_empty() {
                            output.push('\n');
                        }
                        output.push_str(trimmed);
                    }
                    message.clear();
                }
            });
        }
        let process = Arc::new(ManagedForward {
            child: Mutex::new(child),
            temporary_files: launch.temporary_files,
            stderr: stderr_output,
            stopped_by_user: AtomicBool::new(false),
            cleaned: AtomicBool::new(false),
        });
        self.processes
            .lock()
            .insert(rule.id.clone(), process.clone());
        let processes = self.processes.clone();
        let host_key_requests = self.host_key_requests.clone();
        let event_app = app.clone();
        let process_id = rule.id.clone();
        thread::spawn(move || loop {
            let status = process.child.lock().try_wait();
            match status {
                Ok(Some(status)) => {
                    if processes
                        .lock()
                        .get(&process_id)
                        .is_some_and(|current| Arc::ptr_eq(current, &process))
                    {
                        processes.lock().remove(&process_id);
                    }
                    host_key_requests.lock().remove(&process_id);
                    process.cleanup();
                    let stopped = process.stopped_by_user.load(Ordering::Acquire);
                    let failed = !stopped && !status.success();
                    let error = failed.then(|| {
                        let output = process.stderr.lock().trim().to_string();
                        if output.is_empty() {
                            format!("port forward exited with status {status}")
                        } else {
                            output
                        }
                    });
                    let _ = event_app.emit(
                        "forward-status",
                        ForwardEvent {
                            id: process_id,
                            status: if failed { "error" } else { "inactive" }.to_string(),
                            error,
                        },
                    );
                    break;
                }
                Ok(None) => {
                    thread::sleep(std::time::Duration::from_millis(250));
                }
                Err(error) => {
                    process.cleanup();
                    let _ = event_app.emit(
                        "forward-status",
                        ForwardEvent {
                            id: process_id,
                            status: "error".to_string(),
                            error: Some(error.to_string()),
                        },
                    );
                    break;
                }
            }
        });
        let _ = app.emit(
            "forward-status",
            ForwardEvent {
                id: rule.id,
                status: "active".to_string(),
                error: None,
            },
        );
        Ok(())
    }

    fn stop(&self, id: &str) -> Result<(), String> {
        self.host_key_requests.lock().remove(id);
        if let Some(process) = self.processes.lock().remove(id) {
            process.stopped_by_user.store(true, Ordering::Release);
            let mut child = process.child.lock();
            let kill_result = if child.try_wait().map_err(error_message)?.is_none() {
                child.kill().map_err(error_message)
            } else {
                Ok(())
            };
            let _ = child.wait();
            drop(child);
            process.cleanup();
            kill_result?;
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        self.host_key_requests.lock().clear();
        let processes = std::mem::take(&mut *self.processes.lock());
        for process in processes.values() {
            process.stopped_by_user.store(true, Ordering::Release);
            let mut child = process.child.lock();
            let _ = child.kill();
            let _ = child.wait();
            drop(child);
            process.cleanup();
        }
    }

    fn respond_to_host_key(&self, id: &str, accepted: bool) -> Result<(), String> {
        let path = self
            .host_key_requests
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| "port forward host key prompt is no longer active".to_string())?;
        fs::write(path, if accepted { "yes\n" } else { "no\n" }).map_err(error_message)
    }
}

fn wait_for_forward_ready(
    child: &mut Child,
    prompt_path: &Path,
    resolved_path: &Path,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let mut prompt_seen = false;
    let mut resolved_at = None;
    loop {
        if let Some(status) = child.try_wait().map_err(error_message)? {
            return Err(format!(
                "port forward exited before becoming active with status {status}"
            ));
        }
        prompt_seen |= prompt_path.is_file();
        if resolved_at.is_none() {
            if let Ok(response) = fs::read_to_string(resolved_path) {
                if response.trim() != "yes" {
                    return Err("SSH host key was rejected".to_string());
                }
                resolved_at = Some(std::time::Instant::now());
            }
        }
        if let Some(resolved_at) = resolved_at {
            if resolved_at.elapsed() >= std::time::Duration::from_secs(1) {
                return Ok(());
            }
        } else if !prompt_seen && started.elapsed() >= std::time::Duration::from_secs(1) {
            return Ok(());
        }
        if started.elapsed() >= std::time::Duration::from_secs(125) {
            return Err("timed out waiting for SSH host key confirmation".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

struct ForwardLaunch {
    executable: String,
    arguments: Vec<String>,
    environment: HashMap<String, String>,
    temporary_files: Vec<PathBuf>,
}

struct MaterializedCredentials {
    identity_file: Option<PathBuf>,
    certificate_file: Option<PathBuf>,
    temporary_files: Vec<PathBuf>,
}

fn build_launch(
    app: &AppHandle,
    known_hosts_file: &str,
    host: &Host,
    rule: &PortForwardRule,
    auto_accept_host_keys: bool,
) -> Result<ForwardLaunch, String> {
    let executable = if cfg!(windows) {
        "ssh.exe".to_string()
    } else {
        "/usr/bin/ssh".to_string()
    };
    let mut arguments = vec![
        "-N".to_string(),
        "-T".to_string(),
        "-p".to_string(),
        host.port.to_string(),
        "-l".to_string(),
        host.username.clone(),
        "-o".to_string(),
        "ExitOnForwardFailure=yes".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=30".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
        "-o".to_string(),
        if auto_accept_host_keys {
            "StrictHostKeyChecking=accept-new".to_string()
        } else {
            "StrictHostKeyChecking=ask".to_string()
        },
        "-o".to_string(),
        "UpdateHostKeys=yes".to_string(),
        "-o".to_string(),
        format!("UserKnownHostsFile={known_hosts_file}"),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
    ];

    let askpass_executable = std::env::current_exe().map_err(error_message)?;
    let proxy_runtime = host
        .proxy_configuration
        .as_ref()
        .map(|proxy| {
            let paths = BridgePaths::locate(app)?;
            let encoded = BASE64.encode(serde_json::to_vec(proxy).map_err(error_message)?);
            Ok::<_, String>((paths, encoded))
        })
        .transpose()?;
    let credentials = materialize_credentials(host, &rule.id)?;
    match host.authentication {
        AuthenticationMethod::Agent => {}
        AuthenticationMethod::Password => {
            arguments.extend([
                "-o".to_string(),
                "PreferredAuthentications=password,keyboard-interactive".to_string(),
                "-o".to_string(),
                "PubkeyAuthentication=no".to_string(),
            ]);
        }
        AuthenticationMethod::IdentityFile => {
            let identity_file = credentials
                .identity_file
                .as_ref()
                .ok_or_else(|| "private key content or path is required".to_string())?;
            arguments.extend([
                "-i".to_string(),
                identity_file.to_string_lossy().to_string(),
                "-o".to_string(),
                "IdentitiesOnly=yes".to_string(),
                "-o".to_string(),
                "PreferredAuthentications=publickey".to_string(),
                "-o".to_string(),
                "PasswordAuthentication=no".to_string(),
                "-o".to_string(),
                "KbdInteractiveAuthentication=no".to_string(),
            ]);
            if let Some(certificate_file) = &credentials.certificate_file {
                arguments.extend([
                    "-o".to_string(),
                    format!("CertificateFile={}", certificate_file.to_string_lossy()),
                ]);
            }
        }
    }

    let mut environment = std::env::vars().collect::<HashMap<_, _>>();
    environment.insert("TERM".to_string(), "xterm-256color".to_string());
    environment.insert("COLORTERM".to_string(), "truecolor".to_string());
    environment.insert(
        "SSH_ASKPASS".to_string(),
        askpass_executable.to_string_lossy().to_string(),
    );
    environment.insert("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string());
    environment.insert("TERMPILOT_ASKPASS_MODE".to_string(), "1".to_string());
    environment
        .entry("DISPLAY".to_string())
        .or_insert_with(|| "termpilot".to_string());
    let secret = match host.authentication {
        AuthenticationMethod::Password => host.password.as_deref(),
        AuthenticationMethod::IdentityFile => host.passphrase.as_deref(),
        AuthenticationMethod::Agent => None,
    };
    if let Some(secret) = secret.filter(|value| !value.is_empty()) {
        environment.insert(
            "TERMPILOT_ASKPASS_SECRET_B64".to_string(),
            BASE64.encode(secret),
        );
    }
    if cfg!(windows)
        && matches!(host.authentication, AuthenticationMethod::Agent)
        && std::env::var_os("SSH_AUTH_SOCK").is_none()
    {
        environment.insert(
            "SSH_AUTH_SOCK".to_string(),
            r"\\.\pipe\openssh-ssh-agent".to_string(),
        );
    }

    if let Some((paths, encoded_proxy)) = proxy_runtime {
        environment.insert(
            "TERMPILOT_PROXY_COMMAND_CONFIG_B64".to_string(),
            encoded_proxy,
        );
        environment.insert(
            "NODE_PATH".to_string(),
            paths.node_modules.to_string_lossy().to_string(),
        );
        arguments.extend([
            "-o".to_string(),
            format!(
                "ProxyCommand={} {} %h %p",
                command_quote(&paths.node),
                command_quote(&paths.proxy_script.to_string_lossy())
            ),
        ]);
    }

    let (flag, endpoint) = forwarding_endpoint(rule);
    arguments.extend([flag.to_string(), endpoint]);
    arguments.extend(["--".to_string(), host.hostname.clone()]);
    Ok(ForwardLaunch {
        executable,
        arguments,
        environment,
        temporary_files: credentials.temporary_files,
    })
}

fn forwarding_endpoint(rule: &PortForwardRule) -> (&'static str, String) {
    match rule.kind {
        PortForwardKind::Local => (
            "-L",
            format!(
                "{}:{}:{}:{}",
                rule.bind_address,
                rule.local_port,
                rule.remote_host,
                rule.remote_port.unwrap_or(rule.local_port)
            ),
        ),
        PortForwardKind::Remote => (
            "-R",
            format!(
                "{}:{}:{}:{}",
                rule.remote_host,
                rule.remote_port.unwrap_or(rule.local_port),
                rule.bind_address,
                rule.local_port
            ),
        ),
        PortForwardKind::Dynamic => ("-D", format!("{}:{}", rule.bind_address, rule.local_port)),
    }
}

fn materialize_credentials(host: &Host, rule_id: &str) -> Result<MaterializedCredentials, String> {
    if !matches!(host.authentication, AuthenticationMethod::IdentityFile) {
        return Ok(MaterializedCredentials {
            identity_file: None,
            certificate_file: None,
            temporary_files: Vec::new(),
        });
    }
    let mut temporary_files = Vec::new();
    let mut identity_file = host.identity_file.as_deref().map(PathBuf::from);
    let mut certificate_file = None;
    let needs_directory = identity_file.is_none() && host.identity_key.is_some()
        || host
            .certificate
            .as_ref()
            .is_some_and(|value| !value.is_empty());
    let directory = needs_directory.then(|| {
        std::env::temp_dir()
            .join("TermPilot")
            .join("forward-keys")
            .join(format!(
                "{}-{}",
                safe_filename(rule_id),
                uuid::Uuid::new_v4()
            ))
    });
    if let Some(directory) = &directory {
        fs::create_dir_all(directory).map_err(error_message)?;
        set_private_directory_permissions(directory).map_err(error_message)?;
    }
    if identity_file.is_none() {
        if let (Some(directory), Some(key)) = (&directory, &host.identity_key) {
            let path = directory.join("identity.key");
            write_private_file(&path, key)?;
            identity_file = Some(path.clone());
            temporary_files.push(path);
        }
    }
    if let (Some(directory), Some(certificate)) = (&directory, &host.certificate) {
        if !certificate.is_empty() {
            let path = directory.join("identity-cert.pub");
            write_private_file(&path, certificate)?;
            certificate_file = Some(path.clone());
            temporary_files.push(path);
        }
    }
    Ok(MaterializedCredentials {
        identity_file,
        certificate_file,
        temporary_files,
    })
}

fn write_private_file(path: &Path, content: &str) -> Result<(), String> {
    let normalized = if content.ends_with('\n') {
        content.to_string()
    } else {
        format!("{content}\n")
    };
    fs::write(path, normalized).map_err(error_message)?;
    set_private_file_permissions(path).map_err(error_message)
}

fn cleanup_paths(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
    if let Some(directory) = paths.first().and_then(|path| path.parent()) {
        let _ = fs::remove_dir(directory);
    }
}

fn safe_filename(value: &str) -> String {
    let value = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .take(64)
        .collect::<String>();
    if value.is_empty() {
        "forward".to_string()
    } else {
        value
    }
}

fn command_quote(value: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
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

#[tauri::command]
pub fn forward_start(
    app: AppHandle,
    services: State<'_, AppServices>,
    manager: State<'_, ForwardManager>,
    host: Host,
    rule: PortForwardRule,
    auto_accept_host_keys: Option<bool>,
) -> Result<(), String> {
    manager.start(
        app,
        &services.vault.known_hosts_path().to_string_lossy(),
        host,
        rule,
        auto_accept_host_keys.unwrap_or(false),
    )
}

#[tauri::command]
pub fn forward_stop(manager: State<'_, ForwardManager>, id: String) -> Result<(), String> {
    manager.stop(&id)
}

#[tauri::command]
pub fn forward_host_key_response(
    manager: State<'_, ForwardManager>,
    id: String,
    accepted: bool,
) -> Result<(), String> {
    manager.respond_to_host_key(&id, accepted)
}

fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: &str) -> PortForwardRule {
        serde_json::from_value(serde_json::json!({
            "id": "forward",
            "name": "Forward",
            "kind": kind,
            "bindAddress": "127.0.0.1",
            "localPort": 8080,
            "remoteHost": "database.internal",
            "remotePort": 5432,
            "autoStart": false,
            "status": "inactive"
        }))
        .expect("forward rule")
    }

    #[test]
    fn builds_swift_compatible_forwarding_endpoints() {
        assert_eq!(
            forwarding_endpoint(&rule("local")),
            ("-L", "127.0.0.1:8080:database.internal:5432".to_string())
        );
        assert_eq!(
            forwarding_endpoint(&rule("remote")),
            ("-R", "database.internal:5432:127.0.0.1:8080".to_string())
        );
        assert_eq!(
            forwarding_endpoint(&rule("dynamic")),
            ("-D", "127.0.0.1:8080".to_string())
        );
    }

    #[test]
    fn materializes_inline_identity_and_certificate() {
        let host: Host = serde_json::from_value(serde_json::json!({
            "id": "host",
            "label": "Server",
            "hostname": "example.com",
            "username": "root",
            "authentication": "identityFile",
            "identityKey": "PRIVATE KEY",
            "certificate": "CERTIFICATE"
        }))
        .expect("host");

        let credentials =
            materialize_credentials(&host, "forward").expect("materialize credentials");
        let identity_file = credentials.identity_file.expect("identity path");
        let certificate_file = credentials.certificate_file.expect("certificate path");
        assert_eq!(
            fs::read_to_string(&identity_file).expect("identity content"),
            "PRIVATE KEY\n"
        );
        assert_eq!(
            fs::read_to_string(&certificate_file).expect("certificate content"),
            "CERTIFICATE\n"
        );
        cleanup_paths(&credentials.temporary_files);
        assert!(!identity_file.exists());
        assert!(!certificate_file.exists());
    }
}
