import { invoke } from "@tauri-apps/api/core";

import type {
  AppPreferences,
  AutomationScript,
  BackupImportSummary,
  BootstrapSnapshot,
  CommandHistoryEntry,
  ConnectionHistoryEntry,
  Credential,
  GeneratedSSHKeyPair,
  Host,
  HostGroup,
  HostNote,
  PortForwardRule,
  ProxyProfile,
  Snippet,
  SSHKeyGenerationRequest,
  WorkspaceSnapshot,
} from "./types";

export const api = {
  bootstrap: () => invoke<BootstrapSnapshot>("bootstrap"),
  availableTerminalFonts: () =>
    invoke<string[]>("available_terminal_fonts"),
  exportBackup: (path: string, password: string) =>
    invoke<void>("export_backup", { path, password }),
  importBackup: (path: string, password: string) =>
    invoke<BackupImportSummary>("import_backup", {
      path,
      password,
    }),
  saveHost: (host: Host) => invoke<Host>("save_host", { host }),
  saveHosts: (hosts: Host[]) => invoke<Host[]>("save_hosts", { hosts }),
  deleteHost: (id: string) => invoke<void>("delete_host", { id }),
  saveGroup: (group: HostGroup) =>
    invoke<HostGroup>("save_group", { group }),
  deleteGroup: (id: string) => invoke<void>("delete_group", { id }),
  saveCredential: (credential: Credential) =>
    invoke<Credential>("save_credential", { credential }),
  deleteCredential: (id: string) =>
    invoke<void>("delete_credential", { id }),
  generateCredentialKey: (request: SSHKeyGenerationRequest) =>
    invoke<GeneratedSSHKeyPair>("generate_credential_key", { request }),
  saveProxy: (profile: ProxyProfile) =>
    invoke<ProxyProfile>("save_proxy", { profile }),
  deleteProxy: (id: string) => invoke<void>("delete_proxy", { id }),
  saveForward: (rule: PortForwardRule) =>
    invoke<PortForwardRule>("save_forward", { rule }),
  startForward: (
    host: Host,
    rule: PortForwardRule,
    autoAcceptHostKeys: boolean,
  ) =>
    invoke<void>("forward_start", {
      host,
      rule,
      autoAcceptHostKeys,
    }),
  stopForward: (id: string) =>
    invoke<void>("forward_stop", { id }),
  saveScript: (script: AutomationScript) =>
    invoke<AutomationScript>("save_script", { script }),
  saveSnippet: (snippet: Snippet) =>
    invoke<Snippet>("save_snippet", { snippet }),
  saveNote: (note: HostNote) =>
    invoke<HostNote>("save_note", { note }),
  deleteEntity: (kind: "forward" | "script" | "snippet" | "note", id: string) =>
    invoke<void>("delete_entity", { kind, id }),
  appendHistory: (entry: ConnectionHistoryEntry) =>
    invoke<void>("append_history", { entry }),
  appendCommandHistory: (entry: CommandHistoryEntry) =>
    invoke<void>("append_command_history", { entry }),
  saveWorkspace: (snapshot: WorkspaceSnapshot) =>
    invoke<void>("save_workspace", { snapshot }),
  eraseWorkspace: () => invoke<void>("erase_workspace"),
  savePreferences: (preferences: AppPreferences) =>
    invoke<void>("save_preferences", { preferences }),
  deleteKnownHost: (id: string) =>
    invoke<void>("delete_known_host", { id }),
  deleteKnownHosts: (ids: string[]) =>
    invoke<void>("delete_known_hosts", { ids }),
};
