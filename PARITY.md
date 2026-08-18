# Swift Parity Checklist

The Swift application in `../TermPilot` is the behavioral reference. It is
not modified or linked at runtime.

## Implemented

- [x] SwiftUI visual information architecture: host-only primary sidebar,
      fixed 172-point workspace/settings tabs, 156-point settings navigation,
      grouped preferences, list-plus-460-point editors, host editor sections,
      terminal toolbar, server-tools side panel, SFTP browser, and System
      segmented controls.
- [x] Nested host groups, drag ordering, recursive delete, search-scoped batch
      management, full Quick Connect, credentials, certificates, Agent, proxy
      profiles, and Swift-equivalent host appearance controls.
- [x] Encrypted SQLite Vault, known hosts, preferences, history, and workspace
      persistence.
- [x] Local PTY and SSH terminal lifecycle, retained xterm surfaces, focus,
      cursor, search, clipboard, links, file drop, reconnect, OSC metadata,
      connection log, and password assistance.
- [x] Bundle-backed command/option/argument autocomplete, history, local and
      remote paths, popup mode, and ghost-text mode.
- [x] Workspace tabs, tab groups, splits, resize, reorder, detach, merge,
      duplicate, tab-to-pane conversion, pin, rename, close, focus, cloned
      multi-window sessions, native menus, and menu-level shortcuts.
- [x] SFTP/SCP list, text edit, external edit sync, upload, download, move,
      duplicate, rename, chmod, delete, pause, resume, cancel, concurrent
      progress, multi-select, OS file drop, and batch conflicts.
- [x] Local, remote, and dynamic forwarding with auto-start, password,
      Agent, inline key, certificate, proxy, AskPass, host-key confirmation,
      process supervision, and status persistence.
- [x] Scripts, snippets, notes, command history, and connection history.
- [x] System overview, process search/sort/signals, Docker containers/images,
      inspect details/JSON, shell, logs, rename, tag, prune, lifecycle actions,
      and confirmation sheets.
- [x] English and Simplified Chinese coverage for primary and advanced
      workflows; no browser-native prompt/confirm/alert calls.

## Automated Verification

- [x] TypeScript production build.
- [x] 39 frontend behavior tests.
- [x] Rust format, Clippy with warnings denied, and 24 Rust tests.
- [x] All bundled CJS files syntax checked and bridge exports loaded.
- [x] Autocomplete bundle SHA-256 matches the Swift resource.
- [x] macOS arm64 `.app` built and launched with isolated data.
- [x] Windows x86_64 MSVC check and PE executable build through `cargo-xwin`.
- [x] Native macOS and Windows bundle jobs configured in GitHub Actions.

## Native Acceptance Boundary

These checks require external systems and cannot be replaced by macOS
cross-compilation:

- [ ] Run the NSIS installer on Windows and verify install, upgrade, and
      uninstall.
- [ ] Verify ConPTY, Windows IME, WebView2, DPAPI, and OpenSSH Agent on a
      Windows machine.
- [ ] Exercise password/key/certificate/Agent/proxy connections and
      SFTP/SCP conflict flows against representative real SSH servers.
- [ ] Sign/notarize release artifacts with production certificates.

The local `.dmg` command reaches the image-mount phase but cannot complete in
the TRAE sandbox because `/Volumes` writes are restricted. The `.app` bundle
itself is built and smoke tested.
