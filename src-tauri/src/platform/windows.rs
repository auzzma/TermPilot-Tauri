use super::PlatformProfile;

pub fn current() -> PlatformProfile {
    PlatformProfile {
        platform: "windows",
        pty_backend: "ConPTY",
        local_shells: vec!["PowerShell", "Command Prompt", "WSL"],
    }
}
