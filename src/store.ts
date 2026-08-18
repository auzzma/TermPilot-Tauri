import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api } from "./api";
import type {
  AppPreferences,
  AutomationScript,
  BootstrapSnapshot,
  CommandHistoryEntry,
  ConnectionHistoryEntry,
  Credential,
  Host,
  HostGroup,
  HostNote,
  PortForwardRule,
  ProxyProfile,
  SessionDescriptor,
  SessionLifecycle,
  Snippet,
  SplitAxis,
  SplitPlacement,
  WorkspaceDocument,
  WorkspaceNode,
  WorkspaceSnapshot,
} from "./types";

export type NavigationSection =
  | "hosts"
  | "credentials"
  | "proxies"
  | "forwards"
  | "scripts"
  | "snippets"
  | "notes"
  | "history"
  | "groups"
  | "knownHosts"
  | "backup"
  | "about"
  | "settings";

interface AppStore extends BootstrapSnapshot {
  sessionHosts: Record<string, Host>;
  sessionStartupCommands: Record<string, SessionStartupCommand>;
  sessionHistoryEntries: Record<string, ConnectionHistoryEntry>;
  sessionLatencies: Record<string, number>;
  connectionLogs: Record<
    string,
    Array<{
      id: string;
      status: string;
      message: string;
      detail?: string;
      createdAt: string;
    }>
  >;
  commandHistory: CommandHistoryEntry[];
  loading: boolean;
  error?: string;
  navigation: NavigationSection;
  selectedHostId?: string;
  initialize: () => Promise<void>;
  refreshPersistentData: () => Promise<void>;
  setNavigation: (section: NavigationSection) => void;
  selectHost: (id?: string) => void;
  saveHost: (host: Host) => Promise<void>;
  saveHosts: (hosts: Host[]) => Promise<void>;
  deleteHost: (id: string) => Promise<void>;
  saveGroup: (group: HostGroup) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  saveCredential: (credential: Credential) => Promise<void>;
  deleteCredential: (id: string) => Promise<void>;
  saveProxy: (profile: ProxyProfile) => Promise<void>;
  deleteProxy: (id: string) => Promise<void>;
  saveForward: (rule: PortForwardRule) => Promise<void>;
  setForwardStatus: (
    id: string,
    status: PortForwardRule["status"],
    error?: string,
  ) => void;
  saveScript: (script: AutomationScript) => Promise<void>;
  saveSnippet: (snippet: Snippet) => Promise<void>;
  saveNote: (note: HostNote) => Promise<void>;
  deleteEntity: (
    kind: "forward" | "script" | "snippet" | "note",
    id: string,
  ) => Promise<void>;
  updatePreferences: (preferences: AppPreferences) => Promise<void>;
  deleteKnownHost: (id: string) => Promise<void>;
  deleteKnownHosts: (ids: string[]) => Promise<void>;
  openLocalSession: (axis?: SplitAxis) => SessionDescriptor;
  openLocalTab: (targetSessionId: string) => SessionDescriptor;
  openSiblingTab: (
    sourceSessionId: string,
    title: string,
    startupCommand?: string,
    automaticPassword?: string,
  ) => SessionDescriptor | undefined;
  openSiblingSplit: (
    sourceSessionId: string,
    axis: SplitAxis,
  ) => SessionDescriptor | undefined;
  consumeSessionStartupCommand: (
    sessionId: string,
  ) => SessionStartupCommand | undefined;
  openHostSession: (
    host: Host,
    axis?: SplitAxis,
    startupCommand?: string,
  ) => SessionDescriptor;
  selectWorkspace: (id: string) => void;
  focusSession: (workspaceId: string, sessionId: string) => void;
  setSessionLifecycle: (id: string, lifecycle: SessionLifecycle) => void;
  updateSessionMetadata: (
    id: string,
    metadata: { title?: string; workingDirectory?: string },
  ) => void;
  setSessionFontSize: (id: string, fontSize: number) => void;
  setSessionLatency: (id: string, milliseconds?: number) => void;
  appendConnectionLog: (
    sessionId: string,
    entry: { status: string; message: string; detail?: string },
  ) => void;
  recordCommand: (sessionId: string, command: string) => void;
  beginConnectionHistory: (sessionId: string, hostId?: string) => void;
  markConnectionConnected: (sessionId: string) => void;
  finishConnectionHistory: (
    sessionId: string,
    errorCategory?: string,
  ) => void;
  selectTab: (workspaceId: string, sessionId: string) => void;
  splitSession: (
    workspaceId: string,
    targetSessionId: string,
    session: SessionDescriptor,
    axis: SplitAxis,
  ) => void;
  closeSession: (workspaceId: string, sessionId: string) => void;
  closeWorkspace: (workspaceId: string) => void;
  renameWorkspace: (workspaceId: string, title: string) => void;
  toggleWorkspacePinned: (workspaceId: string) => void;
  moveWorkspace: (workspaceId: string, destinationIndex: number) => void;
  moveTerminalTab: (
    workspaceId: string,
    sessionId: string,
    destinationIndex: number,
  ) => void;
  updateSplitSizes: (
    workspaceId: string,
    splitId: string,
    sizes: number[],
  ) => void;
  detachSession: (
    workspaceId: string,
    sessionId: string,
    destinationIndex?: number,
  ) => void;
  detachPane: (
    workspaceId: string,
    sessionId: string,
    destinationIndex?: number,
  ) => void;
  mergeWorkspace: (
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
    targetSessionId: string,
    axis: SplitAxis,
    placement?: SplitPlacement,
  ) => void;
  splitExistingTab: (
    workspaceId: string,
    sessionId: string,
    targetSessionId: string,
    axis: SplitAxis,
    placement?: SplitPlacement,
  ) => void;
  duplicateWorkspace: (workspaceId: string) => void;
}

export interface SessionStartupCommand {
  command: string;
  automaticPassword?: string;
}

const emptySnapshot: BootstrapSnapshot = {
  platform: "macos",
  hosts: [],
  groups: [],
  credentials: [],
  proxies: [],
  forwards: [],
  scripts: [],
  snippets: [],
  notes: [],
  history: [],
  commandHistory: [],
  knownHosts: [],
  workspace: {
    version: 1,
    savedAt: new Date().toISOString(),
    sessions: [],
    workspaces: [],
  },
  preferences: {
    theme: "dark",
    language: "system",
    terminalFontName: "auto",
    terminalFontSize: 13,
    autocompleteEnabled: true,
    autocompleteGhostText: false,
    autocompletePopup: true,
    passwordPromptAssist: "hint",
    autoOpenSystemOverview: true,
    autoAcceptSshHostKeys: false,
    overviewRefreshInterval: 5,
    processesRefreshInterval: 3,
    dockerRefreshInterval: 5,
    sftpShowsHiddenFiles: true,
    sftpFileTransferConcurrency: 2,
    sftpChunkConcurrency: 32,
    sftpChunkSizeBytes: 256 * 1024,
    sftpTransferConnectionIdleSeconds: 5 * 60,
  },
};

export function workspaceForStartup(
  clonedWorkspace?: WorkspaceSnapshot,
): WorkspaceSnapshot {
  return (
    clonedWorkspace ?? {
      version: 1,
      savedAt: now(),
      sessions: [],
      workspaces: [],
    }
  );
}

export const useAppStore = create<AppStore>((set, get) => ({
  ...emptySnapshot,
  loading: true,
  navigation: "hosts",
  sessionHosts: {},
  sessionStartupCommands: {},
  sessionHistoryEntries: {},
  sessionLatencies: {},
  connectionLogs: {},

  initialize: async () => {
    set({ loading: true, error: undefined });
    try {
      const persisted = await api.bootstrap();
      await api.eraseWorkspace().catch(() => undefined);
      const clonedWorkspace = takeWindowClone();
      const snapshot: BootstrapSnapshot = {
        ...persisted,
        workspace: workspaceForStartup(clonedWorkspace),
      };
      const sessionHosts: Record<string, Host> = Object.fromEntries(
        snapshot.workspace.sessions.flatMap((session) => {
          const source = snapshot.hosts.find(
            (host) => host.id === session.hostId,
          );
          return source
            ? [[session.id, resolveHostConnection(snapshot, source)]]
            : [];
        }),
      );
      set({ ...snapshot, sessionHosts, loading: false });
      applyTheme(snapshot.preferences.theme);
      applyLanguage(snapshot.preferences.language);
      for (const rule of snapshot.forwards.filter(
        (item) => item.autoStart && !clonedWorkspace,
      )) {
        const source =
          snapshot.hosts.find((host) => host.id === rule.hostId) ??
          snapshot.hosts[0];
        if (!source) continue;
        const connecting = {
          ...rule,
          status: "connecting" as const,
          error: undefined,
        };
        set((state) => ({
          forwards: upsert(state.forwards, connecting),
        }));
        try {
          await api.startForward(
            resolveHostConnection(snapshot, source),
            connecting,
            snapshot.preferences.autoAcceptSshHostKeys,
          );
          get().setForwardStatus(rule.id, "active");
        } catch (reason) {
          get().setForwardStatus(rule.id, "error", message(reason));
        }
      }
    } catch (error) {
      set({ loading: false, error: message(error) });
    }
  },

  refreshPersistentData: async () => {
    const persisted = await api.bootstrap();
    set({
      platform: persisted.platform,
      hosts: persisted.hosts,
      groups: persisted.groups,
      credentials: persisted.credentials,
      proxies: persisted.proxies,
      forwards: persisted.forwards,
      scripts: persisted.scripts,
      snippets: persisted.snippets,
      notes: persisted.notes,
      history: persisted.history,
      knownHosts: persisted.knownHosts,
    });
  },

  setNavigation: (navigation) => set({ navigation }),
  selectHost: (selectedHostId) => set({ selectedHostId }),

  saveHost: async (host) => {
    const saved = await api.saveHost(host);
    set((state) => ({ hosts: upsert(state.hosts, saved) }));
  },
  saveHosts: async (hosts) => {
    const saved = await api.saveHosts(hosts);
    set((state) => ({
      hosts: saved.reduce(upsert, state.hosts),
    }));
  },
  deleteHost: async (id) => {
    await api.deleteHost(id);
    set((state) => ({
      hosts: state.hosts.filter((item) => item.id !== id),
      selectedHostId:
        state.selectedHostId === id ? undefined : state.selectedHostId,
    }));
  },
  saveGroup: async (group) => {
    const saved = await api.saveGroup(group);
    set((state) => ({ groups: upsert(state.groups, saved) }));
  },
  deleteGroup: async (id) => {
    await api.deleteGroup(id);
    set((state) => {
      const removedIds = groupIdsIncludingDescendants(state.groups, id);
      return {
        groups: state.groups.filter((item) => !removedIds.has(item.id)),
        hosts: state.hosts.map((host) =>
          host.groupId && removedIds.has(host.groupId)
            ? { ...host, groupId: undefined }
            : host,
        ),
      };
    });
  },
  saveCredential: async (credential) => {
    const saved = await api.saveCredential(credential);
    set((state) => ({ credentials: upsert(state.credentials, saved) }));
  },
  deleteCredential: async (id) => {
    await api.deleteCredential(id);
    set((state) => ({
      credentials: state.credentials.filter((item) => item.id !== id),
    }));
  },
  saveProxy: async (profile) => {
    const saved = await api.saveProxy(profile);
    set((state) => ({ proxies: upsert(state.proxies, saved) }));
  },
  deleteProxy: async (id) => {
    await api.deleteProxy(id);
    set((state) => ({
      proxies: state.proxies.filter((item) => item.id !== id),
    }));
  },
  saveForward: async (rule) => {
    const saved = await api.saveForward(rule);
    set((state) => ({ forwards: upsert(state.forwards, saved) }));
  },
  setForwardStatus: (forwardId, status, error) => {
    const rule = get().forwards.find((item) => item.id === forwardId);
    if (!rule) return;
    const updated: PortForwardRule = {
      ...rule,
      status,
      error,
      lastUsedAt:
        status === "active" ? new Date().toISOString() : rule.lastUsedAt,
      updatedAt: new Date().toISOString(),
    };
    set((state) => ({ forwards: upsert(state.forwards, updated) }));
    void api.saveForward(updated);
  },
  saveScript: async (script) => {
    const saved = await api.saveScript(script);
    set((state) => ({ scripts: upsert(state.scripts, saved) }));
  },
  saveSnippet: async (snippet) => {
    const saved = await api.saveSnippet(snippet);
    set((state) => ({ snippets: upsert(state.snippets, saved) }));
  },
  saveNote: async (note) => {
    const saved = await api.saveNote(note);
    set((state) => ({ notes: upsert(state.notes, saved) }));
  },
  deleteEntity: async (kind, id) => {
    await api.deleteEntity(kind, id);
    set((state) => ({
      forwards:
        kind === "forward"
          ? state.forwards.filter((item) => item.id !== id)
          : state.forwards,
      scripts:
        kind === "script"
          ? state.scripts.filter((item) => item.id !== id)
          : state.scripts,
      snippets:
        kind === "snippet"
          ? state.snippets.filter((item) => item.id !== id)
          : state.snippets,
      notes:
        kind === "note"
          ? state.notes.filter((item) => item.id !== id)
          : state.notes,
    }));
  },
  updatePreferences: async (preferences) => {
    preferences = normalizePreferences(preferences);
    const previous = get().preferences;
    set({ preferences });
    applyTheme(preferences.theme);
    applyLanguage(preferences.language);
    try {
      await api.savePreferences(preferences);
    } catch (error) {
      set({ preferences: previous });
      applyTheme(previous.theme);
      applyLanguage(previous.language);
      throw error;
    }
  },
  deleteKnownHost: async (knownHostId) => {
    await api.deleteKnownHost(knownHostId);
    set((state) => ({
      knownHosts: state.knownHosts.filter((item) => item.id !== knownHostId),
    }));
  },
  deleteKnownHosts: async (knownHostIds) => {
    const ids = [...new Set(knownHostIds)];
    if (ids.length === 0) return;
    await api.deleteKnownHosts(ids);
    const deleted = new Set(ids);
    set((state) => ({
      knownHosts: state.knownHosts.filter((item) => !deleted.has(item.id)),
    }));
  },

  openLocalSession: (axis) => {
    const profile = get();
    const shell =
      profile.platform === "windows" ? "powershell.exe" : "/bin/zsh";
    const session: SessionDescriptor = {
      id: id(),
      kind: "local",
      title: profile.platform === "windows" ? "PowerShell" : "zsh",
      shell,
      fontSize: profile.preferences.terminalFontSize,
      lifecycle: "connecting",
    };
    addSession(set, get, session, axis);
    return session;
  },
  openLocalTab: (targetSessionId) => {
    const profile = get();
    const shell =
      profile.platform === "windows" ? "powershell.exe" : "/bin/zsh";
    const session: SessionDescriptor = {
      id: id(),
      kind: "local",
      title: profile.platform === "windows" ? "PowerShell" : "zsh",
      shell,
      fontSize: profile.preferences.terminalFontSize,
      lifecycle: "connecting",
    };
    set((state) => ({
      workspace: {
        ...state.workspace,
        sessions: [...state.workspace.sessions, session],
        workspaces: state.workspace.workspaces.map((workspace) =>
          workspace.id === state.workspace.activeWorkspaceId
            ? {
              ...workspace,
              focusedSessionId: session.id,
              root: insertTab(
                workspace.root,
                targetSessionId,
                session.id,
              ),
            }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
    return session;
  },
  openSiblingTab: (
    sourceSessionId,
    title,
    startupCommand,
    automaticPassword,
  ) => {
    const source = get().workspace.sessions.find(
      (session) => session.id === sourceSessionId,
    );
    if (!source) return undefined;
    const session: SessionDescriptor = {
      ...source,
      id: id(),
      title,
      lifecycle: "connecting",
    };
    const sourceHost =
      get().sessionHosts[sourceSessionId] ??
      get().hosts.find((host) => host.id === source.hostId);
    set((state) => ({
      sessionHosts: sourceHost
        ? { ...state.sessionHosts, [session.id]: sourceHost }
        : state.sessionHosts,
      sessionStartupCommands: startupCommand
        ? {
          ...state.sessionStartupCommands,
          [session.id]: {
            command: startupCommand,
            automaticPassword,
          },
        }
        : state.sessionStartupCommands,
      workspace: {
        ...state.workspace,
        sessions: [...state.workspace.sessions, session],
        workspaces: state.workspace.workspaces.map((workspace) =>
          sessionIds(workspace.root).includes(sourceSessionId)
            ? {
              ...workspace,
              focusedSessionId: session.id,
              root: insertTab(
                workspace.root,
                sourceSessionId,
                session.id,
              ),
            }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
    return session;
  },
  openSiblingSplit: (sourceSessionId, axis) => {
    const profile = get();
    const source = profile.workspace.sessions.find(
      (session) => session.id === sourceSessionId,
    );
    if (!source) return undefined;
    const session: SessionDescriptor =
      source.kind === "ssh"
        ? {
          ...source,
          id: id(),
          lifecycle: "connecting",
        }
        : {
          id: id(),
          kind: "local",
          title:
            profile.platform === "windows" ? "PowerShell" : "zsh",
          shell:
            profile.platform === "windows"
              ? "powershell.exe"
              : "/bin/zsh",
          fontSize: profile.preferences.terminalFontSize,
          lifecycle: "connecting",
        };
    const sourceHost =
      source.kind === "ssh"
        ? profile.sessionHosts[sourceSessionId] ??
        profile.hosts.find((host) => host.id === source.hostId)
        : undefined;
    set((state) => ({
      sessionHosts: sourceHost
        ? { ...state.sessionHosts, [session.id]: sourceHost }
        : state.sessionHosts,
      workspace: {
        ...state.workspace,
        sessions: [...state.workspace.sessions, session],
        workspaces: state.workspace.workspaces.map((workspace) =>
          sessionIds(workspace.root).includes(sourceSessionId)
            ? {
              ...workspace,
              focusedSessionId: session.id,
              root: insertSplit(
                workspace.root,
                sourceSessionId,
                session.id,
                axis,
              ),
            }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
    return session;
  },
  consumeSessionStartupCommand: (sessionId) => {
    const command = get().sessionStartupCommands[sessionId];
    if (command == null) return undefined;
    set((state) => {
      const sessionStartupCommands = {
        ...state.sessionStartupCommands,
      };
      delete sessionStartupCommands[sessionId];
      return { sessionStartupCommands };
    });
    return command;
  },
  openHostSession: (host, axis, startupCommand) => {
    const resolvedHost = resolveHostConnection(get(), host);
    const session: SessionDescriptor = {
      id: id(),
      kind: "ssh",
      title: host.label,
      hostId: host.id,
      fontSize: get().preferences.terminalFontSize,
      lifecycle: "connecting",
    };
    set((state) => ({
      sessionHosts: {
        ...state.sessionHosts,
        [session.id]: resolvedHost,
      },
      connectionLogs: {
        ...state.connectionLogs,
        [session.id]: [
          {
            id: id(),
            status: "queued",
            message: "Session queued; waiting for terminal surface.",
            createdAt: now(),
          },
        ],
      },
      sessionStartupCommands: startupCommand
        ? {
          ...state.sessionStartupCommands,
          [session.id]: { command: startupCommand },
        }
        : state.sessionStartupCommands,
    }));
    addSession(set, get, session, axis);
    return session;
  },
  selectWorkspace: (id) => {
    set((state) => ({
      workspace: { ...state.workspace, activeWorkspaceId: id },
    }));
    persistWorkspace(get);
  },
  focusSession: (workspaceId, sessionId) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        activeWorkspaceId: workspaceId,
        workspaces: state.workspace.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, focusedSessionId: sessionId }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
  },
  setSessionLifecycle: (id, lifecycle) => {
    set((state) => {
      const session = state.workspace.sessions.find(
        (item) => item.id === id,
      );
      if (!session || session.lifecycle === lifecycle) return state;
      return {
        sessionLatencies:
          lifecycle === "connected"
            ? state.sessionLatencies
            : omitRecordKey(state.sessionLatencies, id),
        workspace: {
          ...state.workspace,
          sessions: state.workspace.sessions.map((item) =>
            item.id === id ? { ...item, lifecycle } : item,
          ),
        },
      };
    });
  },
  updateSessionMetadata: (id, metadata) => {
    set((state) => {
      const session = state.workspace.sessions.find(
        (item) => item.id === id,
      );
      if (!session) return state;
      const title = metadata.title?.trim() || session.title;
      const workingDirectory =
        metadata.workingDirectory ?? session.workingDirectory;
      if (
        session.title === title &&
        session.workingDirectory === workingDirectory
      ) {
        return state;
      }
      return {
        workspace: {
          ...state.workspace,
          sessions: state.workspace.sessions.map((item) =>
            item.id === id
              ? { ...item, title, workingDirectory }
              : item,
          ),
        },
      };
    });
  },
  setSessionFontSize: (id, fontSize) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        sessions: state.workspace.sessions.map((session) =>
          session.id === id
            ? {
              ...session,
              fontSize: Math.min(36, Math.max(8, fontSize)),
            }
            : session,
        ),
      },
    }));
    persistWorkspace(get);
  },
  setSessionLatency: (id, milliseconds) => {
    set((state) => {
      if (milliseconds == null || !Number.isFinite(milliseconds)) {
        if (!(id in state.sessionLatencies)) return state;
        return {
          sessionLatencies: omitRecordKey(state.sessionLatencies, id),
        };
      }
      const normalized = Math.max(0, Math.round(milliseconds));
      if (state.sessionLatencies[id] === normalized) return state;
      return {
        sessionLatencies: {
          ...state.sessionLatencies,
          [id]: normalized,
        },
      };
    });
  },
  appendConnectionLog: (sessionId, entry) => {
    set((state) => ({
      connectionLogs: {
        ...state.connectionLogs,
        [sessionId]: [
          ...(state.connectionLogs[sessionId] ?? []),
          {
            id: id(),
            ...entry,
            createdAt: new Date().toISOString(),
          },
        ].slice(-200),
      },
    }));
  },
  recordCommand: (sessionId, command) => {
    const value = command.trim();
    if (!value) return;
    const session = get().workspace.sessions.find(
      (item) => item.id === sessionId,
    );
    const entry: CommandHistoryEntry = {
      id: id(),
      sessionId,
      sessionTitle: session?.title,
      hostId: session?.hostId,
      command: value,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      commandHistory: [
        entry,
        ...state.commandHistory.filter(
          (item) => item.command !== value || item.sessionId !== sessionId,
        ),
      ].slice(0, 1000),
    }));
    void api.appendCommandHistory(entry);
  },
  beginConnectionHistory: (sessionId, hostId) => {
    if (get().sessionHistoryEntries[sessionId]) return;
    const entry: ConnectionHistoryEntry = {
      id: id(),
      hostId,
      startedAt: new Date().toISOString(),
      succeeded: false,
    };
    set((state) => ({
      sessionHistoryEntries: {
        ...state.sessionHistoryEntries,
        [sessionId]: entry,
      },
    }));
  },
  markConnectionConnected: (sessionId) => {
    const current = get().sessionHistoryEntries[sessionId];
    if (!current || current.succeeded) return;
    const entry: ConnectionHistoryEntry = {
      ...current,
      succeeded: true,
      errorCategory: undefined,
    };
    set((state) => ({
      sessionHistoryEntries: {
        ...state.sessionHistoryEntries,
        [sessionId]: entry,
      },
      history: upsertHistory(state.history, entry),
    }));
    void api.appendHistory(entry);
  },
  finishConnectionHistory: (sessionId, errorCategory) => {
    const current = get().sessionHistoryEntries[sessionId];
    if (!current) return;
    const entry: ConnectionHistoryEntry = {
      ...current,
      endedAt: new Date().toISOString(),
      succeeded: current.succeeded,
      errorCategory: current.succeeded ? undefined : errorCategory,
    };
    set((state) => {
      const sessionHistoryEntries = {
        ...state.sessionHistoryEntries,
      };
      delete sessionHistoryEntries[sessionId];
      return {
        sessionHistoryEntries,
        history: upsertHistory(state.history, entry),
      };
    });
    void api.appendHistory(entry);
  },
  selectTab: (workspaceId, sessionId) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        workspaces: state.workspace.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? {
              ...workspace,
              focusedSessionId: sessionId,
              root: selectTab(workspace.root, sessionId),
            }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
  },
  splitSession: (workspaceId, targetSessionId, session, axis) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        sessions: [...state.workspace.sessions, session],
        workspaces: state.workspace.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? {
              ...workspace,
              focusedSessionId: session.id,
              root: insertSplit(
                workspace.root,
                targetSessionId,
                session.id,
                axis,
              ),
            }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
  },
  closeSession: (workspaceId, sessionId) => {
    set((state) => {
      const workspaces = state.workspace.workspaces
        .map((workspace) => {
          if (workspace.id !== workspaceId) return workspace;
          const root = removeSession(workspace.root, sessionId);
          if (!root) return undefined;
          const remaining = sessionIds(root);
          return {
            ...workspace,
            root,
            focusedSessionId: remaining.includes(workspace.focusedSessionId)
              ? workspace.focusedSessionId
              : remaining[0],
          };
        })
        .filter((item): item is WorkspaceDocument => Boolean(item));
      const referenced = new Set(workspaces.flatMap((item) => sessionIds(item.root)));
      const sessionHosts = { ...state.sessionHosts };
      const sessionStartupCommands = {
        ...state.sessionStartupCommands,
      };
      const sessionHistoryEntries = {
        ...state.sessionHistoryEntries,
      };
      const sessionLatencies = { ...state.sessionLatencies };
      const connectionLogs = { ...state.connectionLogs };
      delete sessionHosts[sessionId];
      delete sessionStartupCommands[sessionId];
      delete sessionHistoryEntries[sessionId];
      delete sessionLatencies[sessionId];
      delete connectionLogs[sessionId];
      return {
        sessionHosts,
        sessionStartupCommands,
        sessionHistoryEntries,
        sessionLatencies,
        connectionLogs,
        workspace: {
          ...state.workspace,
          sessions: state.workspace.sessions.filter((item) =>
            referenced.has(item.id),
          ),
          workspaces,
          activeWorkspaceId:
            state.workspace.activeWorkspaceId === workspaceId &&
              !workspaces.some((item) => item.id === workspaceId)
              ? workspaces[0]?.id
              : state.workspace.activeWorkspaceId,
        },
      };
    });
    persistWorkspace(get);
  },
  closeWorkspace: (workspaceId) => {
    set((state) => {
      const workspaces = state.workspace.workspaces.filter(
        (item) => item.id !== workspaceId,
      );
      const referenced = new Set(workspaces.flatMap((item) => sessionIds(item.root)));
      const sessionLatencies = Object.fromEntries(
        Object.entries(state.sessionLatencies).filter(([sessionId]) =>
          referenced.has(sessionId),
        ),
      );
      return {
        sessionLatencies,
        workspace: {
          ...state.workspace,
          workspaces,
          sessions: state.workspace.sessions.filter((item) =>
            referenced.has(item.id),
          ),
          activeWorkspaceId:
            state.workspace.activeWorkspaceId === workspaceId
              ? workspaces[0]?.id
              : state.workspace.activeWorkspaceId,
        },
      };
    });
    persistWorkspace(get);
  },
  renameWorkspace: (workspaceId, title) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        workspaces: state.workspace.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, title: title.trim() || workspace.title }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
  },
  toggleWorkspacePinned: (workspaceId) => {
    set((state) => {
      const workspaces = state.workspace.workspaces
        .map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, pinned: !workspace.pinned }
            : workspace,
        )
        .sort((left, right) =>
          left.pinned === right.pinned ? 0 : left.pinned ? -1 : 1,
        );
      return {
        workspace: {
          ...state.workspace,
          workspaces,
        },
      };
    });
    persistWorkspace(get);
  },
  moveWorkspace: (workspaceId, rawDestination) => {
    set((state) => {
      const items = [...state.workspace.workspaces];
      const source = items.findIndex((item) => item.id === workspaceId);
      if (source < 0) return state;
      let destination = Math.min(
        Math.max(rawDestination, 0),
        items.length,
      );
      if (source < destination) destination -= 1;
      if (source === destination) return state;
      const [moved] = items.splice(source, 1);
      items.splice(destination, 0, moved);
      return {
        workspace: { ...state.workspace, workspaces: items },
      };
    });
    persistWorkspace(get);
  },
  moveTerminalTab: (workspaceId, sessionId, destinationIndex) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        workspaces: state.workspace.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? {
              ...workspace,
              root: reorderTabToIndex(
                workspace.root,
                sessionId,
                destinationIndex,
              ),
            }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
  },
  updateSplitSizes: (workspaceId, splitId, sizes) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        workspaces: state.workspace.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? {
              ...workspace,
              root: replaceSplitSizes(workspace.root, splitId, sizes),
            }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
  },
  detachSession: (workspaceId, sessionId, rawDestination) => {
    set((state) => {
      const sourceIndex = state.workspace.workspaces.findIndex(
        (workspace) => workspace.id === workspaceId,
      );
      if (sourceIndex < 0) return state;
      const source = state.workspace.workspaces[sourceIndex];
      if (sessionIds(source.root).length <= 1) return state;
      const remaining = removeSession(source.root, sessionId);
      const descriptor = state.workspace.sessions.find(
        (session) => session.id === sessionId,
      );
      if (!remaining || !descriptor) return state;
      const detached: WorkspaceDocument = {
        id: id(),
        title: descriptor.title,
        root: { type: "pane", id: id(), sessionId },
        focusedSessionId: sessionId,
        pinned: false,
      };
      const workspaces = [...state.workspace.workspaces];
      workspaces[sourceIndex] = {
        ...source,
        root: remaining,
        focusedSessionId: sessionIds(remaining).includes(
          source.focusedSessionId,
        )
          ? source.focusedSessionId
          : sessionIds(remaining)[0],
      };
      const destination = Math.min(
        Math.max(rawDestination ?? sourceIndex + 1, 0),
        workspaces.length,
      );
      workspaces.splice(destination, 0, detached);
      return {
        workspace: {
          ...state.workspace,
          workspaces,
          activeWorkspaceId: detached.id,
        },
      };
    });
    persistWorkspace(get);
  },
  detachPane: (workspaceId, sessionId, rawDestination) => {
    set((state) => {
      const sourceIndex = state.workspace.workspaces.findIndex(
        (workspace) => workspace.id === workspaceId,
      );
      if (sourceIndex < 0) return state;
      const source = state.workspace.workspaces[sourceIndex];
      if (paneCount(source.root) <= 1) return state;
      const extraction = extractPane(source.root, sessionId);
      if (!extraction.remaining || !extraction.detached) return state;
      const detached: WorkspaceDocument = {
        id: id(),
        title:
          state.workspace.sessions.find(
            (session) => session.id === sessionId,
          )?.title ?? source.title,
        root: extraction.detached,
        focusedSessionId: sessionId,
        pinned: false,
      };
      const workspaces = [...state.workspace.workspaces];
      workspaces[sourceIndex] = {
        ...source,
        root: extraction.remaining,
        focusedSessionId: sessionIds(extraction.remaining).includes(
          source.focusedSessionId,
        )
          ? source.focusedSessionId
          : sessionIds(extraction.remaining)[0],
      };
      const destination = Math.min(
        Math.max(rawDestination ?? sourceIndex + 1, 0),
        workspaces.length,
      );
      workspaces.splice(destination, 0, detached);
      return {
        workspace: {
          ...state.workspace,
          workspaces,
          activeWorkspaceId: detached.id,
        },
      };
    });
    persistWorkspace(get);
  },
  mergeWorkspace: (
    sourceWorkspaceId,
    targetWorkspaceId,
    targetSessionId,
    axis,
    placement = "after",
  ) => {
    set((state) => {
      if (sourceWorkspaceId === targetWorkspaceId) return state;
      const source = state.workspace.workspaces.find(
        (workspace) => workspace.id === sourceWorkspaceId,
      );
      const target = state.workspace.workspaces.find(
        (workspace) => workspace.id === targetWorkspaceId,
      );
      if (
        !source ||
        !target ||
        paneCount(source.root) !== 1 ||
        !sessionIds(target.root).includes(targetSessionId)
      ) {
        return state;
      }
      return {
        workspace: {
          ...state.workspace,
          workspaces: state.workspace.workspaces
            .filter((workspace) => workspace.id !== sourceWorkspaceId)
            .map((workspace) =>
              workspace.id === targetWorkspaceId
                ? {
                  ...workspace,
                  root: insertPane(
                    workspace.root,
                    targetSessionId,
                    source.root,
                    axis,
                    placement,
                  ),
                }
                : workspace,
            ),
          activeWorkspaceId: targetWorkspaceId,
        },
      };
    });
    persistWorkspace(get);
  },
  splitExistingTab: (
    workspaceId,
    sessionId,
    targetSessionId,
    axis,
    placement = "after",
  ) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        activeWorkspaceId: workspaceId,
        workspaces: state.workspace.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? {
              ...workspace,
              focusedSessionId: sessionId,
              root: splitExistingTab(
                workspace.root,
                sessionId,
                targetSessionId,
                axis,
                placement,
              ),
            }
            : workspace,
        ),
      },
    }));
    persistWorkspace(get);
  },
  duplicateWorkspace: (workspaceId) => {
    set((state) => {
      const sourceIndex = state.workspace.workspaces.findIndex(
        (workspace) => workspace.id === workspaceId,
      );
      if (sourceIndex < 0) return state;
      const source = state.workspace.workspaces[sourceIndex];
      const replacements = new Map<string, string>();
      const duplicates = sessionIds(source.root).flatMap((sessionId) => {
        const descriptor = state.workspace.sessions.find(
          (session) => session.id === sessionId,
        );
        if (!descriptor) return [];
        const replacement = id();
        replacements.set(sessionId, replacement);
        return [
          {
            ...descriptor,
            id: replacement,
            lifecycle: "connecting" as const,
          },
        ];
      });
      if (duplicates.length !== sessionIds(source.root).length) return state;
      const duplicate: WorkspaceDocument = {
        id: id(),
        title: `${source.title} Copy`,
        root: cloneRoot(source.root, replacements),
        focusedSessionId:
          replacements.get(source.focusedSessionId) ?? duplicates[0].id,
        pinned: false,
      };
      const workspaces = [...state.workspace.workspaces];
      workspaces.splice(sourceIndex + 1, 0, duplicate);
      const sessionHosts = { ...state.sessionHosts };
      for (const [oldId, newId] of replacements) {
        if (state.sessionHosts[oldId]) {
          sessionHosts[newId] = state.sessionHosts[oldId];
        }
      }
      return {
        sessionHosts,
        workspace: {
          ...state.workspace,
          sessions: [...state.workspace.sessions, ...duplicates],
          workspaces,
          activeWorkspaceId: duplicate.id,
        },
      };
    });
    persistWorkspace(get);
  },
}));

function addSession(
  set: Parameters<typeof useAppStore.setState>[0] extends never
    ? never
    : typeof useAppStore.setState,
  get: typeof useAppStore.getState,
  session: SessionDescriptor,
  axis?: SplitAxis,
) {
  set((state) => {
    const active = state.workspace.workspaces.find(
      (item) => item.id === state.workspace.activeWorkspaceId,
    );
    if (active && axis) {
      return {
        workspace: {
          ...state.workspace,
          sessions: [...state.workspace.sessions, session],
          workspaces: state.workspace.workspaces.map((workspace) =>
            workspace.id === active.id
              ? {
                ...workspace,
                focusedSessionId: session.id,
                root: insertSplit(
                  workspace.root,
                  workspace.focusedSessionId,
                  session.id,
                  axis,
                ),
              }
              : workspace,
          ),
        },
      };
    }
    const workspace: WorkspaceDocument = {
      id: id(),
      title: session.title,
      root: { type: "pane", id: id(), sessionId: session.id },
      focusedSessionId: session.id,
      pinned: false,
    };
    return {
      workspace: {
        ...state.workspace,
        sessions: [...state.workspace.sessions, session],
        workspaces: [...state.workspace.workspaces, workspace],
        activeWorkspaceId: workspace.id,
      },
    };
  });
  persistWorkspace(get);
}

function selectTab(node: WorkspaceNode, sessionId: string): WorkspaceNode {
  if (node.type === "tabGroup" && node.sessionIds.includes(sessionId)) {
    return { ...node, activeSessionId: sessionId };
  }
  if (node.type === "split") {
    return {
      ...node,
      children: node.children.map((child) => selectTab(child, sessionId)),
    };
  }
  return node;
}

function insertSplit(
  node: WorkspaceNode,
  targetSessionId: string,
  sessionId: string,
  axis: SplitAxis,
): WorkspaceNode {
  if (sessionIds(node).includes(targetSessionId) && node.type !== "split") {
    return {
      type: "split",
      id: id(),
      axis,
      children: [
        node,
        { type: "pane", id: id(), sessionId },
      ],
      sizes: [0.5, 0.5],
    };
  }
  if (node.type === "split") {
    return {
      ...node,
      children: node.children.map((child) =>
        sessionIds(child).includes(targetSessionId)
          ? insertSplit(child, targetSessionId, sessionId, axis)
          : child,
      ),
    };
  }
  return node;
}

function insertTab(
  node: WorkspaceNode,
  targetSessionId: string,
  sessionId: string,
): WorkspaceNode {
  if (node.type === "pane" && node.sessionId === targetSessionId) {
    return {
      type: "tabGroup",
      id: node.id,
      sessionIds: [node.sessionId, sessionId],
      activeSessionId: sessionId,
    };
  }
  if (
    node.type === "tabGroup" &&
    node.sessionIds.includes(targetSessionId)
  ) {
    return {
      ...node,
      sessionIds: [...node.sessionIds, sessionId],
      activeSessionId: sessionId,
    };
  }
  if (node.type === "split") {
    return {
      ...node,
      children: node.children.map((child) =>
        sessionIds(child).includes(targetSessionId)
          ? insertTab(child, targetSessionId, sessionId)
          : child,
      ),
    };
  }
  return node;
}

function removeSession(
  node: WorkspaceNode,
  sessionId: string,
): WorkspaceNode | undefined {
  if (node.type === "pane") {
    return node.sessionId === sessionId ? undefined : node;
  }
  if (node.type === "tabGroup") {
    if (!node.sessionIds.includes(sessionId)) return node;
    const remaining = node.sessionIds.filter((item) => item !== sessionId);
    if (remaining.length === 0) return undefined;
    if (remaining.length === 1) {
      return { type: "pane", id: node.id, sessionId: remaining[0] };
    }
    return {
      ...node,
      sessionIds: remaining,
      activeSessionId:
        node.activeSessionId === sessionId
          ? remaining[0]
          : node.activeSessionId,
    };
  }
  const sizes = normalizeSizes(node.sizes, node.children.length);
  const remaining = node.children.flatMap((child, index) => {
    const updated = removeSession(child, sessionId);
    return updated ? [{ node: updated, size: sizes[index] }] : [];
  });
  if (remaining.length === 0) return undefined;
  if (remaining.length === 1) return remaining[0].node;
  return {
    ...node,
    children: remaining.map((item) => item.node),
    sizes: normalizeSizes(
      remaining.map((item) => item.size),
      remaining.length,
    ),
  };
}

export function compactWorkspaceNode(
  node: WorkspaceNode,
  availableSessionIds: ReadonlySet<string>,
): WorkspaceNode | undefined {
  if (node.type === "pane") {
    return availableSessionIds.has(node.sessionId) ? node : undefined;
  }
  if (node.type === "tabGroup") {
    const remaining = node.sessionIds.filter((sessionId) =>
      availableSessionIds.has(sessionId),
    );
    if (remaining.length === 0) return undefined;
    if (remaining.length === 1) {
      return { type: "pane", id: node.id, sessionId: remaining[0] };
    }
    return {
      ...node,
      sessionIds: remaining,
      activeSessionId: remaining.includes(node.activeSessionId)
        ? node.activeSessionId
        : remaining[0],
    };
  }

  const sizes = normalizeSizes(node.sizes, node.children.length);
  const remaining = node.children.flatMap((child, index) => {
    const compacted = compactWorkspaceNode(child, availableSessionIds);
    return compacted ? [{ node: compacted, size: sizes[index] }] : [];
  });
  if (remaining.length === 0) return undefined;
  if (remaining.length === 1) return remaining[0].node;
  return {
    ...node,
    children: remaining.map((item) => item.node),
    sizes: normalizeSizes(
      remaining.map((item) => item.size),
      remaining.length,
    ),
  };
}

function reorderTabToIndex(
  node: WorkspaceNode,
  sessionId: string,
  rawDestination: number,
): WorkspaceNode {
  if (
    node.type === "tabGroup" &&
    node.sessionIds.includes(sessionId)
  ) {
    const source = node.sessionIds.indexOf(sessionId);
    let destination = Math.min(
      Math.max(rawDestination, 0),
      node.sessionIds.length,
    );
    if (source < destination) destination -= 1;
    if (source === destination) return node;
    const items = [...node.sessionIds];
    const [moved] = items.splice(source, 1);
    items.splice(destination, 0, moved);
    return { ...node, sessionIds: items };
  }
  if (node.type === "split") {
    return {
      ...node,
      children: node.children.map((child) =>
        reorderTabToIndex(child, sessionId, rawDestination),
      ),
    };
  }
  return node;
}

function replaceSplitSizes(
  node: WorkspaceNode,
  splitId: string,
  sizes: number[],
): WorkspaceNode {
  if (node.type !== "split") return node;
  if (node.id === splitId) {
    return {
      ...node,
      sizes: normalizeSizes(sizes, node.children.length),
    };
  }
  return {
    ...node,
    children: node.children.map((child) =>
      replaceSplitSizes(child, splitId, sizes),
    ),
  };
}

export function paneCount(node: WorkspaceNode): number {
  return node.type === "split"
    ? node.children.reduce((total, child) => total + paneCount(child), 0)
    : 1;
}

function extractPane(
  node: WorkspaceNode,
  sessionId: string,
): { remaining?: WorkspaceNode; detached?: WorkspaceNode } {
  if (!sessionIds(node).includes(sessionId)) {
    return { remaining: node };
  }
  if (node.type !== "split") {
    return { detached: node };
  }
  const targetIndex = node.children.findIndex((child) =>
    sessionIds(child).includes(sessionId),
  );
  if (targetIndex < 0) return { remaining: node };
  const extraction = extractPane(node.children[targetIndex], sessionId);
  if (!extraction.detached) return { remaining: node };
  const children = [...node.children];
  const sizes = normalizeSizes(node.sizes, node.children.length);
  if (extraction.remaining) {
    children[targetIndex] = extraction.remaining;
  } else {
    children.splice(targetIndex, 1);
    sizes.splice(targetIndex, 1);
  }
  if (children.length === 0) {
    return { detached: extraction.detached };
  }
  if (children.length === 1) {
    return { remaining: children[0], detached: extraction.detached };
  }
  return {
    remaining: {
      ...node,
      children,
      sizes: normalizeSizes(sizes, children.length),
    },
    detached: extraction.detached,
  };
}

function insertPane(
  node: WorkspaceNode,
  targetSessionId: string,
  pane: WorkspaceNode,
  axis: SplitAxis,
  placement: SplitPlacement = "after",
): WorkspaceNode {
  if (
    node.type !== "split" &&
    sessionIds(node).includes(targetSessionId)
  ) {
    return {
      type: "split",
      id: id(),
      axis,
      children:
        placement === "before" ? [pane, node] : [node, pane],
      sizes: [0.5, 0.5],
    };
  }
  if (node.type === "split") {
    return {
      ...node,
      children: node.children.map((child) =>
        sessionIds(child).includes(targetSessionId)
          ? insertPane(child, targetSessionId, pane, axis, placement)
          : child,
      ),
    };
  }
  return node;
}

function splitExistingTab(
  node: WorkspaceNode,
  sessionId: string,
  targetSessionId: string,
  axis: SplitAxis,
  placement: SplitPlacement = "after",
): WorkspaceNode {
  const sourceTabIds = tabGroupSessionIds(node, sessionId);
  if (
    !sourceTabIds ||
    sourceTabIds.length <= 1 ||
    !sessionIds(node).includes(targetSessionId)
  ) {
    return node;
  }
  const remaining = removeSession(node, sessionId);
  if (!remaining) return node;
  const resolvedTargetId =
    targetSessionId !== sessionId &&
      sessionIds(remaining).includes(targetSessionId)
      ? targetSessionId
      : sourceTabIds.find(
        (candidate) =>
          candidate !== sessionId &&
          sessionIds(remaining).includes(candidate),
      );
  if (!resolvedTargetId) return node;
  return insertPane(
    remaining,
    resolvedTargetId,
    { type: "pane", id: id(), sessionId },
    axis,
    placement,
  );
}

function tabGroupSessionIds(
  node: WorkspaceNode,
  sessionId: string,
): string[] | undefined {
  if (node.type === "pane") return undefined;
  if (node.type === "tabGroup") {
    return node.sessionIds.includes(sessionId)
      ? node.sessionIds
      : undefined;
  }
  return node.children
    .map((child) => tabGroupSessionIds(child, sessionId))
    .find(Boolean);
}

function normalizeSizes(sizes: number[], count: number): number[] {
  if (
    count <= 0 ||
    sizes.length !== count ||
    sizes.some((size) => !Number.isFinite(size) || size <= 0)
  ) {
    return Array.from({ length: count }, () => 1 / Math.max(count, 1));
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return sizes.map((size) => size / total);
}

function cloneRoot(
  node: WorkspaceNode,
  replacements: Map<string, string>,
): WorkspaceNode {
  if (node.type === "pane") {
    return {
      type: "pane",
      id: id(),
      sessionId: replacements.get(node.sessionId) ?? node.sessionId,
    };
  }
  if (node.type === "tabGroup") {
    return {
      type: "tabGroup",
      id: id(),
      sessionIds: node.sessionIds.map(
        (sessionId) => replacements.get(sessionId) ?? sessionId,
      ),
      activeSessionId:
        replacements.get(node.activeSessionId) ?? node.activeSessionId,
    };
  }
  return {
    type: "split",
    id: id(),
    axis: node.axis,
    children: node.children.map((child) =>
      cloneRoot(child, replacements),
    ),
    sizes: [...node.sizes],
  };
}

export function sessionIds(node: WorkspaceNode): string[] {
  if (node.type === "pane") return [node.sessionId];
  if (node.type === "tabGroup") return node.sessionIds;
  return node.children.flatMap(sessionIds);
}

export function groupIdsIncludingDescendants(
  groups: HostGroup[],
  groupId: string,
) {
  const result = new Set<string>();
  const pending = [groupId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    pending.push(
      ...groups
        .filter((group) => group.parentGroupId === current)
        .map((group) => group.id),
    );
  }
  return result;
}

export function cloneWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
): WorkspaceSnapshot {
  const sessionReplacements = new Map(
    snapshot.sessions.map((session) => [session.id, id()]),
  );
  const workspaceReplacements = new Map(
    snapshot.workspaces.map((workspace) => [workspace.id, id()]),
  );
  const sessions = snapshot.sessions.map((session) => ({
    ...session,
    id: sessionReplacements.get(session.id)!,
    lifecycle: "connecting" as const,
  }));
  const workspaces = snapshot.workspaces.map((workspace) => ({
    ...workspace,
    id: workspaceReplacements.get(workspace.id)!,
    root: cloneWorkspaceNode(workspace.root, sessionReplacements),
    focusedSessionId:
      sessionReplacements.get(workspace.focusedSessionId) ??
      workspace.focusedSessionId,
  }));
  return {
    ...snapshot,
    savedAt: now(),
    sessions,
    workspaces,
    activeWorkspaceId: snapshot.activeWorkspaceId
      ? workspaceReplacements.get(snapshot.activeWorkspaceId)
      : workspaces[0]?.id,
  };
}

function cloneWorkspaceNode(
  node: WorkspaceNode,
  sessionReplacements: Map<string, string>,
): WorkspaceNode {
  if (node.type === "pane") {
    return {
      type: "pane",
      id: id(),
      sessionId:
        sessionReplacements.get(node.sessionId) ?? node.sessionId,
    };
  }
  if (node.type === "tabGroup") {
    return {
      type: "tabGroup",
      id: id(),
      sessionIds: node.sessionIds.map(
        (sessionId) =>
          sessionReplacements.get(sessionId) ?? sessionId,
      ),
      activeSessionId:
        sessionReplacements.get(node.activeSessionId) ??
        node.activeSessionId,
    };
  }
  return {
    type: "split",
    id: id(),
    axis: node.axis,
    sizes: [...node.sizes],
    children: node.children.map((child) =>
      cloneWorkspaceNode(child, sessionReplacements),
    ),
  };
}

function takeWindowClone(): WorkspaceSnapshot | undefined {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return undefined;
  }
  const key = new URLSearchParams(window.location.search).get("windowClone");
  if (!key) return undefined;
  const storageKey = `termpilot:window-clone:${key}`;
  const payload = localStorage.getItem(storageKey);
  localStorage.removeItem(storageKey);
  if (!payload) return undefined;
  try {
    return JSON.parse(payload) as WorkspaceSnapshot;
  } catch {
    return undefined;
  }
}

export function resolveHostConnection(
  snapshot: Pick<BootstrapSnapshot, "credentials" | "proxies">,
  source: Host,
): Host {
  const credential = snapshot.credentials.find(
    (item) => item.id === source.credentialId,
  );
  const proxy = snapshot.proxies.find(
    (item) => item.id === source.proxyProfileId,
  );
  return {
    ...source,
    username: source.username || credential?.username || "",
    authentication:
      credential?.kind === "identityKey"
        ? "identityFile"
        : credential?.kind === "password"
          ? "password"
          : source.authentication,
    password: credential?.password ?? source.password,
    identityKey: credential?.privateKey ?? source.identityKey,
    publicKey: credential?.publicKey ?? source.publicKey,
    certificate: credential?.certificate ?? source.certificate,
    passphrase: credential?.passphrase ?? source.passphrase,
    elevationPassword:
      source.elevationPassword ?? credential?.elevationPassword,
    proxyConfiguration:
      proxy?.configuration ?? source.proxyConfiguration,
  };
}

function normalizePreferences(
  preferences: AppPreferences,
): AppPreferences {
  const chunkSizes = [
    256 * 1024,
    512 * 1024,
    1024 * 1024,
    5 * 1024 * 1024,
    10 * 1024 * 1024,
  ];
  const idleValues = [60, 5 * 60, 15 * 60, 30 * 60, 0];
  return {
    ...preferences,
    passwordPromptAssist:
      preferences.passwordPromptAssist === "off"
        ? "off"
        : (preferences.passwordPromptAssist as string) === "picker" ||
            (preferences.passwordPromptAssist as string) === "automatic"
          ? "picker"
          : "hint",
    terminalFontSize: Math.min(
      36,
      Math.max(8, preferences.terminalFontSize),
    ),
    autocompleteGhostText:
      preferences.autocompletePopup
        ? false
        : preferences.autocompleteGhostText,
    overviewRefreshInterval: clampInteger(
      preferences.overviewRefreshInterval,
      1,
      10,
    ),
    processesRefreshInterval: clampInteger(
      preferences.processesRefreshInterval,
      1,
      10,
    ),
    dockerRefreshInterval: clampInteger(
      preferences.dockerRefreshInterval,
      1,
      10,
    ),
    sftpFileTransferConcurrency: clampInteger(
      preferences.sftpFileTransferConcurrency,
      1,
      16,
    ),
    sftpChunkConcurrency: clampInteger(
      preferences.sftpChunkConcurrency,
      1,
      32,
    ),
    sftpChunkSizeBytes: chunkSizes.includes(
      preferences.sftpChunkSizeBytes,
    )
      ? preferences.sftpChunkSizeBytes
      : 256 * 1024,
    sftpTransferConnectionIdleSeconds: idleValues.includes(
      preferences.sftpTransferConnectionIdleSeconds,
    )
      ? preferences.sftpTransferConnectionIdleSeconds
      : 5 * 60,
  };
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function persistWorkspace(get: typeof useAppStore.getState) {
  const snapshot: WorkspaceSnapshot = {
    ...get().workspace,
    savedAt: new Date().toISOString(),
  };
  void api.saveWorkspace(snapshot);
}

function upsert<T extends { id: string }>(items: T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) return [...items, value];
  return items.map((item) => (item.id === value.id ? value : item));
}

function upsertHistory(
  items: ConnectionHistoryEntry[],
  entry: ConnectionHistoryEntry,
) {
  return [
    entry,
    ...items.filter((item) => item.id !== entry.id),
  ].slice(0, 1000);
}

export function id(): string {
  return crypto.randomUUID();
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

export function now(): string {
  return new Date().toISOString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyTheme(theme: AppPreferences["theme"]) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  if (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  ) {
    void getCurrentWindow()
      .setTheme(theme === "system" ? null : theme)
      .catch(() => undefined);
  }
}

function applyLanguage(language: AppPreferences["language"]) {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return;
  }
  document.documentElement.lang =
    language === "system" ? navigator.language : language;
}
