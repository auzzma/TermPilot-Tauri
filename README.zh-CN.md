# TermPilot Tauri

[English](README.md) | [简体中文](README.zh-CN.md)

TermPilot Tauri 是 TermPilot 的 Windows 与 macOS 跨平台版本。它将终端、SSH、文件传输和服务器管理整合在统一的桌面工作区中，并针对 Windows 提供便携式部署能力。

## 主要功能

- **跨平台终端**：Windows 使用 ConPTY，macOS 使用 Unix PTY；支持 PowerShell、命令提示符、WSL 和本地 Shell。
- **完整 SSH 连接**：支持快捷连接、已保存主机、密码、私钥、证书、SSH Agent、代理和主机密钥确认。
- **多会话工作区**：支持多工作区、标签页、水平/垂直分屏、拖拽排序、合并、分离、复制、固定和多窗口会话。
- **高效终端操作**：提供搜索、复制粘贴、链接识别、文件拖放、连接日志，以及命令、参数、历史记录和路径补全。
- **主机集中管理**：支持嵌套分组、批量操作、外观预设、凭据与代理复用，以及快速键盘切换。
- **SFTP/SCP 文件管理**：支持浏览、上传、下载、编辑、移动、复制、重命名、权限修改、批量冲突处理及可暂停的并发传输。
- **服务器运维**：提供系统概览、进程搜索与信号操作，以及 Docker 容器和镜像管理。
- **常用工具**：支持本地/远程/动态端口转发、脚本、命令片段、笔记、历史记录和加密备份。

## 版本优势

- **Windows 与 macOS 一致体验**：共享 React 界面与产品逻辑，同时保留各平台的原生终端和菜单能力。
- **Windows 便携运行**：应用和 `data` 目录可整体迁移，适合免安装或多设备使用。
- **本地优先且安全**：数据存入本地 SQLite，凭据使用 AES-GCM 加密；前端仅通过受控的 Tauri 命令访问系统能力。
- **一站式远程工作流**：连接、文件操作、端口转发、系统监控和 Docker 管理集中在同一窗口。
- **数据可迁移**：加密 `.tpbackup` 备份可在 Swift、Tauri macOS 和 Tauri Windows 版本之间使用。
- **中英文界面**：主要及高级工作流均支持简体中文和英文。

## 开发

需要 Node.js 22、Rust，以及对应平台的 Tauri 构建依赖。

```bash
nvm use
npm install
npm run tauri:dev
```

常用检查：

```bash
npm test
npm run test:bridge
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

## 数据位置

- macOS：`~/Library/Application Support/TermPilot/`
- Windows：`TermPilot.exe` 所在目录下的 `data/`

Windows 便携版的数据库与加密密钥位于同一 `data` 目录，请仅允许可信用户访问整个应用目录。

## License

GPL-3.0-or-later
