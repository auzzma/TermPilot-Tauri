#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformProfile {
    pub platform: &'static str,
    pub pty_backend: &'static str,
    pub local_shells: Vec<&'static str>,
}

#[cfg(target_os = "macos")]
pub use macos::current;
#[cfg(target_os = "windows")]
pub use windows::current;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
compile_error!("TermPilot currently supports Windows and reserves macOS support.");
