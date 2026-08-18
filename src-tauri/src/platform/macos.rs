use super::PlatformProfile;

pub fn current() -> PlatformProfile {
    PlatformProfile {
        platform: "macos",
        pty_backend: "Unix PTY",
        local_shells: vec!["zsh", "bash"],
    }
}
