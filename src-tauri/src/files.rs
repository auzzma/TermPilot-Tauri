use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::UNIX_EPOCH;
use std::time::{Duration, Instant};

use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    name: String,
    path: String,
    kind: String,
    size: u64,
    modified_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCommandResult {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

#[tauri::command]
pub fn local_home() -> String {
    directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

#[tauri::command]
pub fn local_downloads() -> String {
    directories::UserDirs::new()
        .map(|dirs| {
            dirs.download_dir()
                .unwrap_or_else(|| dirs.home_dir())
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_else(|| ".".to_string())
}

#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<LocalEntry>, String> {
    let mut entries = fs::read_dir(&path)
        .map_err(error_message)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let path = entry.path();
            Some(LocalEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                kind: if metadata.is_dir() {
                    "directory".to_string()
                } else if metadata.is_file() {
                    "file".to_string()
                } else {
                    "other".to_string()
                },
                size: metadata.len(),
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_secs().to_string()),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        (left.kind != "directory", left.name.to_lowercase())
            .cmp(&(right.kind != "directory", right.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn local_entry(path: String) -> Result<LocalEntry, String> {
    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path).map_err(error_message)?;
    Ok(LocalEntry {
        name: path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .to_string(),
        path: path.to_string_lossy().to_string(),
        kind: if metadata.is_dir() {
            "directory".to_string()
        } else if metadata.is_file() {
            "file".to_string()
        } else {
            "other".to_string()
        },
        size: metadata.len(),
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs().to_string()),
    })
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(error_message)
}

#[tauri::command]
pub fn local_create_file(path: String) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(error_message)
}

#[tauri::command]
pub fn local_rename(path: String, new_name: String) -> Result<String, String> {
    let new_name = validate_file_name(&new_name)?;
    let source = PathBuf::from(path);
    let destination = source.parent().unwrap_or(Path::new(".")).join(new_name);
    fs::rename(&source, &destination).map_err(error_message)?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
pub fn local_delete(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(error_message)
    } else {
        fs::remove_file(path).map_err(error_message)
    }
}

#[tauri::command]
pub fn local_duplicate(path: String) -> Result<String, String> {
    let source = PathBuf::from(path);
    let destination = duplicate_destination(&source);
    copy_recursively(&source, &destination)?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
pub fn local_copy_to(source: String, destination: String) -> Result<(), String> {
    let source = PathBuf::from(source);
    let destination = PathBuf::from(destination);
    if destination.exists() {
        return Err("Destination already exists".to_string());
    }
    copy_recursively(&source, &destination)
}

#[tauri::command]
pub fn local_move_to(source: String, destination: String) -> Result<(), String> {
    let source = PathBuf::from(source);
    let destination = PathBuf::from(destination);
    if destination.exists() {
        return Err("Destination already exists".to_string());
    }
    match fs::rename(&source, &destination) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_recursively(&source, &destination)?;
            if source.is_dir() {
                fs::remove_dir_all(source).map_err(error_message)
            } else {
                fs::remove_file(source).map_err(error_message)
            }
        }
    }
}

#[tauri::command]
pub fn local_temporary_path(name: String) -> Result<String, String> {
    let directory = std::env::temp_dir()
        .join("TermPilot")
        .join("external-edit")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).map_err(error_message)?;
    Ok(directory
        .join(Path::new(&name).file_name().unwrap_or_default())
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn local_modified_at(path: String) -> Result<u64, String> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .and_then(|modified| {
            modified
                .duration_since(UNIX_EPOCH)
                .map_err(std::io::Error::other)
        })
        .map(|duration| duration.as_millis() as u64)
        .map_err(error_message)
}

#[tauri::command]
pub fn local_open(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd.exe");
        command.args(["/C", "start", "", &path]);
        command
    };
    command.spawn().map_err(error_message)?;
    Ok(())
}

#[tauri::command]
pub fn local_open_with(path: String, application: String) -> Result<(), String> {
    if application.trim().is_empty() {
        return Err("Application is required".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.args(["-a", &application, &path]);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new(&application);
        command.arg(&path);
        command
    };
    command.spawn().map_err(error_message)?;
    Ok(())
}

#[tauri::command]
pub fn local_reveal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.args(["-R", &path]);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(format!("/select,{path}"));
        command
    };
    command.spawn().map_err(error_message)?;
    Ok(())
}

#[tauri::command]
pub async fn local_exec(
    command: String,
    shell: Option<String>,
    working_directory: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<LocalCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        local_exec_blocking(command, shell, working_directory, timeout_ms)
    })
    .await
    .map_err(error_message)?
}

fn local_exec_blocking(
    command: String,
    shell: Option<String>,
    working_directory: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<LocalCommandResult, String> {
    let shell = shell.unwrap_or_else(|| {
        if cfg!(windows) {
            "powershell.exe".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
        }
    });
    let mut process = Command::new(&shell);
    if cfg!(windows) && shell.to_lowercase().contains("powershell") {
        process.args(["-NoProfile", "-Command", &command]);
    } else if cfg!(windows) && shell.to_lowercase().ends_with("cmd.exe") {
        process.args(["/C", &command]);
    } else {
        process.args(["-lc", &command]);
    }
    #[cfg(windows)]
    process.creation_flags(0x08000000);
    if let Some(directory) = working_directory {
        process.current_dir(directory);
    }
    let mut child = process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(error_message)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "local command stdout is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "local command stderr is unavailable".to_string())?;
    let stdout_thread = thread::spawn(move || read_output(stdout));
    let stderr_thread = thread::spawn(move || read_output(stderr));
    let started = Instant::now();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(20_000).clamp(100, 300_000));
    let status = loop {
        if let Some(status) = child.try_wait().map_err(error_message)? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("local command timed out".to_string());
        }
        thread::sleep(Duration::from_millis(25));
    };
    Ok(LocalCommandResult {
        stdout: stdout_thread
            .join()
            .map_err(|_| "local stdout reader failed".to_string())?,
        stderr: stderr_thread
            .join()
            .map_err(|_| "local stderr reader failed".to_string())?,
        code: status.code(),
    })
}

fn read_output(mut input: impl Read) -> String {
    let mut output = Vec::new();
    let _ = input.read_to_end(&mut output);
    String::from_utf8_lossy(&output).to_string()
}

fn duplicate_destination(source: &Path) -> PathBuf {
    let parent = source.parent().unwrap_or(Path::new("."));
    let is_directory = source.is_dir();
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("item");
    let stem = if is_directory {
        name
    } else {
        source
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("item")
    };
    let extension = if is_directory {
        None
    } else {
        source.extension().and_then(|value| value.to_str())
    };
    for index in 1.. {
        let suffix = if index == 1 {
            " (copy)".to_string()
        } else {
            format!(" (copy {index})")
        };
        let name = match extension {
            Some(extension) => format!("{stem}{suffix}.{extension}"),
            None => format!("{stem}{suffix}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn copy_recursively(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(error_message)?;
    if metadata.is_file() {
        fs::copy(source, destination).map_err(error_message)?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err("Only files and directories can be duplicated".to_string());
    }
    fs::create_dir_all(destination).map_err(error_message)?;
    for entry in fs::read_dir(source).map_err(error_message)? {
        let entry = entry.map_err(error_message)?;
        copy_recursively(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn validate_file_name(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty()
        || matches!(value, "." | "..")
        || value.contains('/')
        || value.contains('\\')
    {
        return Err("A valid file name is required".to_string());
    }
    Ok(value)
}

fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_preserves_directory_names_with_dots() {
        let root = std::env::temp_dir().join(format!("termpilot-files-{}", uuid::Uuid::new_v4()));
        let source = root.join("archive.tar");
        fs::create_dir_all(source.join("nested")).expect("create source directory");
        fs::write(source.join("nested/data.txt"), "content").expect("write source file");

        let destination =
            local_duplicate(source.to_string_lossy().to_string()).expect("duplicate directory");
        let destination = PathBuf::from(destination);

        assert_eq!(
            destination.file_name().and_then(|value| value.to_str()),
            Some("archive.tar (copy)")
        );
        assert_eq!(
            fs::read_to_string(destination.join("nested/data.txt")).expect("read duplicate"),
            "content"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn duplicate_inserts_suffix_before_file_extension() {
        let root = std::env::temp_dir().join(format!("termpilot-files-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test directory");
        let source = root.join("config.json");
        fs::write(&source, "{}").expect("write source file");

        let destination =
            local_duplicate(source.to_string_lossy().to_string()).expect("duplicate file");
        let destination = PathBuf::from(destination);

        assert_eq!(
            destination.file_name().and_then(|value| value.to_str()),
            Some("config (copy).json")
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn rename_rejects_paths_and_parent_traversal() {
        for value in ["", ".", "..", "../other", r"..\other", "folder/name"] {
            assert!(validate_file_name(value).is_err(), "{value}");
        }
        assert_eq!(validate_file_name(" renamed.txt ").unwrap(), "renamed.txt");
    }

    #[test]
    fn copy_and_move_support_cross_directory_clipboard_operations() {
        let root = std::env::temp_dir().join(format!("termpilot-files-{}", uuid::Uuid::new_v4()));
        let source_directory = root.join("source");
        let destination_directory = root.join("destination");
        fs::create_dir_all(&source_directory).expect("create source");
        fs::create_dir_all(&destination_directory).expect("create destination");
        let source = source_directory.join("item.txt");
        local_create_file(source.to_string_lossy().to_string()).expect("create source file");
        fs::write(&source, "content").expect("write source");
        assert!(local_create_file(source.to_string_lossy().to_string()).is_err());
        let copy = destination_directory.join("copy.txt");
        local_copy_to(
            source.to_string_lossy().to_string(),
            copy.to_string_lossy().to_string(),
        )
        .expect("copy item");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "content");

        let moved = destination_directory.join("moved.txt");
        local_move_to(
            source.to_string_lossy().to_string(),
            moved.to_string_lossy().to_string(),
        )
        .expect("move item");
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(&moved).unwrap(), "content");
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn local_exec_runs_a_real_shell_command() {
        #[cfg(unix)]
        let result = local_exec_blocking(
            "printf termpilot-local-exec".to_string(),
            Some("/bin/sh".to_string()),
            None,
            Some(5_000),
        )
        .expect("execute local command");
        #[cfg(windows)]
        let result = local_exec_blocking(
            "Write-Output -NoNewline termpilot-local-exec".to_string(),
            Some("powershell.exe".to_string()),
            None,
            Some(5_000),
        )
        .expect("execute local command");

        assert_eq!(result.stdout, "termpilot-local-exec");
        assert_eq!(result.code, Some(0));
    }
}
