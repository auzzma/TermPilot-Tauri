use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::json;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunch {
    pub session_id: String,
    pub program: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub working_directory: Option<String>,
    #[serde(default = "default_columns")]
    pub columns: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub environment: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    session_id: String,
    exit_code: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalErrorPayload {
    session_id: String,
    message: String,
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<TerminalProcess>>>,
}

struct TerminalProcess {
    master: Option<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: TerminalKiller,
    framed_input: bool,
}

enum TerminalKiller {
    Pty(Mutex<Box<dyn ChildKiller + Send + Sync>>),
    Piped(Mutex<Child>),
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl TerminalManager {
    pub fn start(&self, app: AppHandle, launch: TerminalLaunch) -> Result<(), String> {
        if self.sessions.lock().contains_key(&launch.session_id) {
            return Ok(());
        }

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: launch.rows.max(2),
                cols: launch.columns.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(error_message)?;

        let mut command = CommandBuilder::new(&launch.program);
        command.args(&launch.arguments);
        if let Some(directory) = &launch.working_directory {
            command.cwd(directory);
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "TermPilot");
        for (key, value) in &launch.environment {
            command.env(key, value);
        }

        let mut child = pair.slave.spawn_command(command).map_err(error_message)?;
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(error_message)?;
        let writer = pair.master.take_writer().map_err(error_message)?;
        drop(pair.slave);

        self.sessions.lock().insert(
            launch.session_id.clone(),
            Arc::new(TerminalProcess {
                master: Some(Mutex::new(pair.master)),
                writer: Mutex::new(writer),
                killer: TerminalKiller::Pty(Mutex::new(killer)),
                framed_input: false,
            }),
        );

        let output_app = app.clone();
        let output_session_id = launch.session_id.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let _ = output_app.emit(
                            "terminal-output",
                            TerminalOutputPayload {
                                session_id: output_session_id.clone(),
                                data: BASE64.encode(&buffer[..count]),
                            },
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let _ = output_app.emit(
                            "terminal-error",
                            TerminalErrorPayload {
                                session_id: output_session_id.clone(),
                                message: error.to_string(),
                            },
                        );
                        break;
                    }
                }
            }
        });

        let exit_session_id = launch.session_id;
        thread::spawn(move || {
            let status = child.wait();
            let _ = app.emit(
                "terminal-exit",
                TerminalExitPayload {
                    session_id: exit_session_id,
                    exit_code: status.ok().map(|value| value.exit_code()),
                },
            );
        });
        Ok(())
    }

    pub fn start_piped(&self, app: AppHandle, launch: TerminalLaunch) -> Result<(), String> {
        if self.sessions.lock().contains_key(&launch.session_id) {
            return Ok(());
        }

        let mut command = Command::new(&launch.program);
        command
            .args(&launch.arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("TERM_PROGRAM", "TermPilot")
            .env("TERMPILOT_PIPE_TRANSPORT", "1")
            .env("TERMPILOT_COLUMNS", launch.columns.max(2).to_string())
            .env("TERMPILOT_ROWS", launch.rows.max(2).to_string())
            .envs(&launch.environment);
        if let Some(directory) = &launch.working_directory {
            command.current_dir(directory);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);

        let mut child = command.spawn().map_err(error_message)?;
        let writer = child
            .stdin
            .take()
            .ok_or_else(|| "terminal process stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "terminal process stdout is unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "terminal process stderr is unavailable".to_string())?;
        let process = Arc::new(TerminalProcess {
            master: None,
            writer: Mutex::new(Box::new(writer)),
            killer: TerminalKiller::Piped(Mutex::new(child)),
            framed_input: true,
        });
        self.sessions
            .lock()
            .insert(launch.session_id.clone(), process.clone());

        emit_pipe_output(app.clone(), launch.session_id.clone(), stdout);
        emit_pipe_output(app.clone(), launch.session_id.clone(), stderr);

        let exit_session_id = launch.session_id;
        thread::spawn(move || loop {
            let status = match &process.killer {
                TerminalKiller::Piped(child) => child.lock().try_wait(),
                TerminalKiller::Pty(_) => return,
            };
            match status {
                Ok(Some(status)) => {
                    let _ = app.emit(
                        "terminal-exit",
                        TerminalExitPayload {
                            session_id: exit_session_id,
                            exit_code: status.code().map(|value| value as u32),
                        },
                    );
                    return;
                }
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(error) => {
                    let _ = app.emit(
                        "terminal-error",
                        TerminalErrorPayload {
                            session_id: exit_session_id,
                            message: error.to_string(),
                        },
                    );
                    return;
                }
            }
        });
        Ok(())
    }

    fn write(&self, session_id: &str, encoded: &str) -> Result<(), String> {
        let process = self
            .sessions
            .lock()
            .get(session_id)
            .cloned()
            .ok_or_else(|| "terminal session does not exist".to_string())?;
        let mut writer = process.writer.lock();
        if process.framed_input {
            serde_json::to_writer(&mut *writer, &json!({ "type": "data", "data": encoded }))
                .map_err(error_message)?;
            writer.write_all(b"\n").map_err(error_message)?;
        } else {
            let bytes = BASE64.decode(encoded).map_err(error_message)?;
            writer.write_all(&bytes).map_err(error_message)?;
        }
        writer.flush().map_err(error_message)
    }

    fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let process = self
            .sessions
            .lock()
            .get(session_id)
            .cloned()
            .ok_or_else(|| "terminal session does not exist".to_string())?;
        if process.framed_input {
            let mut writer = process.writer.lock();
            serde_json::to_writer(
                &mut *writer,
                &json!({
                    "type": "resize",
                    "columns": columns.max(2),
                    "rows": rows.max(2),
                }),
            )
            .map_err(error_message)?;
            writer.write_all(b"\n").map_err(error_message)?;
            return writer.flush().map_err(error_message);
        }
        let result = process
            .master
            .as_ref()
            .ok_or_else(|| "terminal PTY is unavailable".to_string())?
            .lock()
            .resize(PtySize {
                rows: rows.max(2),
                cols: columns.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(error_message);
        result
    }

    fn terminate(&self, session_id: &str) -> Result<(), String> {
        if let Some(process) = self.sessions.lock().remove(session_id) {
            kill_terminal_process(&process)?;
        }
        Ok(())
    }

    pub fn terminate_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock());
        for (_, process) in sessions {
            let _ = kill_terminal_process(&process);
        }
    }
}

fn emit_pipe_output(app: AppHandle, session_id: String, mut reader: impl Read + Send + 'static) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(count) => {
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutputPayload {
                            session_id: session_id.clone(),
                            data: BASE64.encode(&buffer[..count]),
                        },
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    let _ = app.emit(
                        "terminal-error",
                        TerminalErrorPayload {
                            session_id: session_id.clone(),
                            message: error.to_string(),
                        },
                    );
                    return;
                }
            }
        }
    });
}

fn kill_terminal_process(process: &TerminalProcess) -> Result<(), String> {
    match &process.killer {
        TerminalKiller::Pty(killer) => killer.lock().kill().map_err(error_message),
        TerminalKiller::Piped(child) => child.lock().kill().map_err(error_message),
    }
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalManager>,
    launch: TerminalLaunch,
) -> Result<(), String> {
    state.start(app, launch)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.write(&session_id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalManager>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&session_id, columns, rows)
}

#[tauri::command]
pub fn terminal_terminate(
    state: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    state.terminate(&session_id)
}

fn default_columns() -> u16 {
    80
}

fn default_rows() -> u16 {
    24
}

fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pty_runs_a_real_process() {
        let pair = native_pty_system()
            .openpty(PtySize::default())
            .expect("open PTY");
        #[cfg(unix)]
        let command = {
            let mut command = CommandBuilder::new("/bin/sh");
            command.args(["-c", "printf termpilot-pty-ok"]);
            command
        };
        #[cfg(windows)]
        let command = {
            let mut command = CommandBuilder::new("cmd.exe");
            command.args(["/C", "echo|set /p=termpilot-pty-ok"]);
            command
        };
        let mut child = pair.slave.spawn_command(command).expect("spawn process");
        drop(pair.slave);
        let mut output = String::new();
        pair.master
            .try_clone_reader()
            .expect("clone reader")
            .read_to_string(&mut output)
            .expect("read output");
        let status = child.wait().expect("wait for process");
        assert!(status.success());
        assert!(output.contains("termpilot-pty-ok"), "{output:?}");
    }
}
