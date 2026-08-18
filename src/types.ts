export type AuthenticationMethod = "agent" | "password" | "identityFile";
export type SftpFileProtocol = "auto" | "sftp" | "scp";
export type SftpFilenameEncoding = "auto" | "utf-8" | "gb18030";
export type SessionKind = "local" | "ssh";
export type SessionLifecycle =
  | "disconnected"
  | "connecting"
  | "connected"
  | "exited"
  | "failed";
export type SplitAxis = "horizontal" | "vertical";
export type SplitPlacement = "before" | "after";

export interface ProxyConfiguration {
  type: "http" | "socks5" | "command";
  host: string;
  port: number;
  command?: string;
  credentialId?: string;
  username?: string;
  password?: string;
}

export interface Host {
  id: string;
  label: string;
  hostname: string;
  port: number;
  username: string;
  authentication: AuthenticationMethod;
  identityFile?: string;
  identityKey?: string;
  publicKey?: string;
  certificate?: string;
  passphrase?: string;
  password?: string;
  elevationPassword?: string;
  credentialId?: string;
  proxyProfileId?: string;
  proxyConfiguration?: ProxyConfiguration;
  groupId?: string;
  sortOrder: number;
  distro?: string;
  distroMode: string;
  manualDistro?: string;
  iconMode: string;
  iconId?: string;
  iconColorMode: string;
  iconColor?: string;
  iconColorCustom?: string;
  sftpFileProtocol: SftpFileProtocol;
  sftpFilenameEncoding: SftpFilenameEncoding;
  sftpUsesSudo: boolean;
  sftpFollowsTerminalCwd?: boolean;
  serverToolsUseRoot: boolean;
  serverToolsElevationMethod: "sudo" | "su";
  createdAt: string;
  updatedAt: string;
}

export interface HostGroup {
  id: string;
  name: string;
  parentGroupId?: string;
  sortOrder: number;
}

export interface Credential {
  id: string;
  label: string;
  username: string;
  kind: "password" | "identityKey";
  password?: string;
  privateKey?: string;
  publicKey?: string;
  certificate?: string;
  passphrase?: string;
  savesPassphrase: boolean;
  elevationPassword?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SSHKeyGenerationRequest {
  keyType: "ed25519" | "ecdsa" | "rsa";
  bits?: 256 | 384 | 521 | 1024 | 2048 | 4096;
  passphrase?: string;
  comment?: string;
}

export interface GeneratedSSHKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface ProxyProfile {
  id: string;
  label: string;
  configuration: ProxyConfiguration;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface PortForwardRule {
  id: string;
  hostId?: string;
  name: string;
  order?: number;
  kind: "local" | "remote" | "dynamic";
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort?: number;
  autoStart: boolean;
  status: "inactive" | "connecting" | "active" | "error";
  error?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface AutomationScript {
  id: string;
  title: string;
  shell: string;
  body: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Snippet {
  id: string;
  title: string;
  group: string;
  body: string;
  sortOrder: number;
  updatedAt: string;
}

export interface HostNote {
  id: string;
  hostId?: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionHistoryEntry {
  id: string;
  hostId?: string;
  startedAt: string;
  endedAt?: string;
  succeeded: boolean;
  errorCategory?: string;
}

export interface CommandHistoryEntry {
  id: string;
  sessionId: string;
  sessionTitle?: string;
  hostId?: string;
  command: string;
  createdAt: string;
}

export interface SessionDescriptor {
  id: string;
  kind: SessionKind;
  title: string;
  hostId?: string;
  shell?: string;
  workingDirectory?: string;
  fontSize: number;
  lifecycle: SessionLifecycle;
}

export type WorkspaceNode =
  | {
    type: "pane";
    id: string;
    sessionId: string;
  }
  | {
    type: "tabGroup";
    id: string;
    sessionIds: string[];
    activeSessionId: string;
  }
  | {
    type: "split";
    id: string;
    axis: SplitAxis;
    children: WorkspaceNode[];
    sizes: number[];
  };

export interface WorkspaceDocument {
  id: string;
  title: string;
  root: WorkspaceNode;
  focusedSessionId: string;
  pinned: boolean;
}

export interface WorkspaceSnapshot {
  version: number;
  savedAt: string;
  activeWorkspaceId?: string;
  sessions: SessionDescriptor[];
  workspaces: WorkspaceDocument[];
}

export interface KnownHostRecord {
  id: string;
  hosts: string;
  algorithm: string;
  key: string;
  rawLine: string;
}

export interface AppPreferences {
  theme: "system" | "light" | "dark";
  language: "system" | "en" | "zh-Hans";
  terminalFontName: string;
  terminalFontSize: number;
  autocompleteEnabled: boolean;
  autocompleteGhostText: boolean;
  autocompletePopup: boolean;
  passwordPromptAssist: "off" | "hint" | "picker";
  autoOpenSystemOverview: boolean;
  autoAcceptSshHostKeys: boolean;
  overviewRefreshInterval: number;
  processesRefreshInterval: number;
  dockerRefreshInterval: number;
  sftpShowsHiddenFiles: boolean;
  sftpFileTransferConcurrency: number;
  sftpChunkConcurrency: number;
  sftpChunkSizeBytes: number;
  sftpTransferConnectionIdleSeconds: number;
}

export interface BootstrapSnapshot {
  platform: "windows" | "macos";
  hosts: Host[];
  groups: HostGroup[];
  credentials: Credential[];
  proxies: ProxyProfile[];
  forwards: PortForwardRule[];
  scripts: AutomationScript[];
  snippets: Snippet[];
  notes: HostNote[];
  history: ConnectionHistoryEntry[];
  commandHistory: CommandHistoryEntry[];
  knownHosts: KnownHostRecord[];
  workspace: WorkspaceSnapshot;
  preferences: AppPreferences;
}

export interface BackupImportSummary {
  hosts: number;
  deduplicatedHosts: number;
  groups: number;
  credentials: number;
  proxyProfiles: number;
  portForwardRules: number;
  automationScripts: number;
  hostNotes: number;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode?: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  permissions?: number;
  modifiedAt?: string;
}

export interface SystemOverview {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  cpuModel: string;
  cpuUsage: number;
  cpuUserUsage: number;
  cpuSystemUsage: number;
  cpuCoreCount: number;
  memoryTotal: number;
  memoryUsed: number;
  loadAverage: string;
  networkRxPerSecond: number;
  networkTxPerSecond: number;
  swap: string;
  disks: Array<{
    mount: string;
    used: number;
    total: number;
    percent: number;
  }>;
  networkInterfaces: Array<{
    name: string;
    rxPerSecond: number;
    txPerSecond: number;
  }>;
  topMemoryProcesses: Array<{
    pid: number;
    memoryPercent: number;
    command: string;
  }>;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
}
