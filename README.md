# TermPilot Tauri

[English](README.md) | [简体中文](README.zh-CN.md)

TermPilot Tauri is the cross-platform edition of TermPilot for Windows and macOS. It combines terminals, SSH, file transfer, and server management in a consistent desktop workspace, with portable deployment support on Windows.

## Core Features

- **Cross-platform terminals**: Uses ConPTY on Windows and Unix PTY on macOS, with support for PowerShell, Command Prompt, WSL, and local shells.
- **Complete SSH access**: Connect through Quick Connect or saved hosts using passwords, private keys, certificates, SSH Agent, proxies, and host-key confirmation.
- **Multi-session workspaces**: Manage multiple workspaces, tabs, horizontal or vertical splits, drag reordering, merge, detach, duplicate, pin, and multi-window sessions.
- **Productive terminal tools**: Search, copy and paste, open links, drop files, inspect connection logs, and autocomplete commands, options, history, and paths.
- **Centralized host management**: Organize nested groups, run batch actions, apply appearance presets, reuse credentials and proxies, and switch quickly from the keyboard.
- **SFTP/SCP file management**: Browse, upload, download, edit, move, copy, rename, change permissions, resolve batch conflicts, and pause concurrent transfers.
- **Server operations**: View system status, search and signal processes, and manage Docker containers and images.
- **Workflow tools**: Configure local, remote, and dynamic port forwarding; save scripts, snippets, notes, history, and encrypted backups.

## Why the Tauri Version

- **Consistent on Windows and macOS**: Shares a React interface and product logic while retaining native terminal and menu capabilities on each platform.
- **Portable on Windows**: Move the application together with its `data` directory for installation-free use across machines.
- **Local-first and secure**: Stores data in local SQLite with AES-GCM encrypted credentials. The frontend reaches system capabilities only through controlled Tauri commands.
- **One workspace for remote operations**: Connections, file operations, port forwarding, monitoring, and Docker management stay in the same window.
- **Portable data**: Encrypted `.tpbackup` files work across the Swift, Tauri macOS, and Tauri Windows editions.
- **Bilingual interface**: Primary and advanced workflows are available in English and Simplified Chinese.

## Development

Development requires Node.js 22, Rust, and the Tauri build dependencies for your platform.

```bash
nvm use
npm install
npm run tauri:dev
```

Common checks:

```bash
npm test
npm run test:bridge
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

## Data Locations

- macOS: `~/Library/Application Support/TermPilot/`
- Windows: `data/` beside `TermPilot.exe`

The Windows portable edition stores both the database and encryption key in `data/`. Restrict access to the entire application directory to trusted users.

## License

GPL-3.0-or-later
