import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: {
    bootstrap: vi.fn(),
    saveWorkspace: vi.fn().mockResolvedValue(undefined),
    saveHost: vi.fn().mockImplementation(async (host) => host),
    saveHosts: vi.fn().mockImplementation(async (hosts) => hosts),
    deleteGroup: vi.fn().mockResolvedValue(undefined),
    saveForward: vi.fn().mockImplementation(async (rule) => rule),
    startForward: vi.fn().mockResolvedValue(undefined),
    appendHistory: vi.fn().mockResolvedValue(undefined),
    appendCommandHistory: vi.fn().mockResolvedValue(undefined),
    eraseWorkspace: vi.fn().mockResolvedValue(undefined),
    savePreferences: vi.fn().mockResolvedValue(undefined),
    deleteKnownHosts: vi.fn().mockResolvedValue(undefined),
  },
}));

import { api } from "./api";
import {
  cloneWorkspaceSnapshot,
  compactWorkspaceNode,
  sessionIds,
  useAppStore,
  workspaceForStartup,
} from "./store";
import type {
  Host,
  SessionDescriptor,
  WorkspaceDocument,
  WorkspaceNode,
} from "./types";

const session = (
  id: string,
  title = id,
  kind: "local" | "ssh" = "local",
): SessionDescriptor => ({
  id,
  kind,
  title,
  shell: kind === "local" ? "/bin/zsh" : undefined,
  hostId: kind === "ssh" ? "host" : undefined,
  fontSize: 13,
  lifecycle: "connected",
});

const host = (id: string, groupId?: string): Host => ({
  id,
  label: id,
  hostname: `${id}.example.com`,
  port: 22,
  username: "pilot",
  authentication: "agent",
  groupId,
  sortOrder: 0,
  distroMode: "auto",
  iconMode: "auto",
  iconColorMode: "auto",
  sftpFileProtocol: "auto",
  sftpFilenameEncoding: "auto",
  sftpUsesSudo: false,
  sftpFollowsTerminalCwd: true,
  serverToolsUseRoot: false,
  serverToolsElevationMethod: "sudo",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

function setWorkspace(
  workspaces: WorkspaceDocument[],
  sessions: SessionDescriptor[],
  activeWorkspaceId = workspaces[0]?.id,
) {
  useAppStore.setState((state) => ({
    hosts: [],
    groups: [],
    sessionHosts: {},
    sessionStartupCommands: {},
    sessionHistoryEntries: {},
    sessionLatencies: {},
    connectionLogs: {},
    history: [],
    commandHistory: [],
    workspace: {
      ...state.workspace,
      activeWorkspaceId,
      workspaces,
      sessions,
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setWorkspace([], []);
});

describe("backup refresh", () => {
  it("reloads persistent data without replacing live workspaces", async () => {
    setWorkspace(
      [
        {
          id: "live-workspace",
          title: "Live",
          root: {
            type: "pane",
            id: "live-pane",
            sessionId: "live-session",
          },
          focusedSessionId: "live-session",
          pinned: false,
        },
      ],
      [session("live-session")],
    );
    const before = useAppStore.getState().workspace;
    const current = useAppStore.getState();
    vi.mocked(api.bootstrap).mockResolvedValue({
      platform: "macos",
      hosts: [host("imported")],
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
        savedAt: "2026-01-01T00:00:00Z",
        sessions: [],
        workspaces: [],
      },
      preferences: current.preferences,
    });

    await useAppStore.getState().refreshPersistentData();

    expect(useAppStore.getState().hosts.map((item) => item.id)).toEqual([
      "imported",
    ]);
    expect(useAppStore.getState().workspace).toBe(before);
  });
});

describe("known hosts", () => {
  it("deletes selected known hosts in one request", async () => {
    useAppStore.setState({
      knownHosts: [
        { id: "one", hosts: "one.example.com", algorithm: "ssh-ed25519", key: "a", rawLine: "one" },
        { id: "two", hosts: "two.example.com", algorithm: "ssh-ed25519", key: "b", rawLine: "two" },
        { id: "three", hosts: "three.example.com", algorithm: "ssh-ed25519", key: "c", rawLine: "three" },
      ],
    });

    await useAppStore.getState().deleteKnownHosts(["one", "three"]);

    expect(api.deleteKnownHosts).toHaveBeenCalledWith(["one", "three"]);
    expect(useAppStore.getState().knownHosts.map((item) => item.id)).toEqual([
      "two",
    ]);
  });
});

describe("workspace tree", () => {
  it("collapses a split whose other pane references a missing session", () => {
    const root: WorkspaceNode = {
      type: "split",
      id: "split",
      axis: "vertical",
      sizes: [0.25, 0.75],
      children: [
        { type: "pane", id: "connected", sessionId: "connected" },
        { type: "pane", id: "missing", sessionId: "missing" },
      ],
    };

    expect(
      compactWorkspaceNode(root, new Set(["connected"])),
    ).toEqual({
      type: "pane",
      id: "connected",
      sessionId: "connected",
    });
  });

  it("seeds the Swift-style connection log for a new SSH session", () => {
    const opened = useAppStore.getState().openHostSession(host("server"));

    expect(opened.lifecycle).toBe("connecting");
    expect(useAppStore.getState().connectionLogs[opened.id]).toMatchObject([
      {
        status: "queued",
        message: "Session queued; waiting for terminal surface.",
      },
    ]);
  });

  it("queues a host context-menu script until SSH is connected", () => {
    const opened = useAppStore
      .getState()
      .openHostSession(host("server"), undefined, "echo ready\n");

    expect(
      useAppStore.getState().consumeSessionStartupCommand(opened.id),
    ).toEqual({ command: "echo ready\n" });
    expect(
      useAppStore.getState().consumeSessionStartupCommand(opened.id),
    ).toBeUndefined();
  });

  it("collects sessions from panes, tabs, and nested splits", () => {
    const tree: WorkspaceNode = {
      type: "split",
      id: "root",
      axis: "vertical",
      sizes: [0.5, 0.5],
      children: [
        { type: "pane", id: "left", sessionId: "one" },
        {
          type: "tabGroup",
          id: "right",
          sessionIds: ["two", "three"],
          activeSessionId: "three",
        },
      ],
    };

    expect(sessionIds(tree)).toEqual(["one", "two", "three"]);
  });

  it("preserves remaining split proportions when closing a session", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Layout",
          root: {
            type: "split",
            id: "root",
            axis: "vertical",
            sizes: [0.2, 0.3, 0.5],
            children: [
              { type: "pane", id: "a-pane", sessionId: "a" },
              { type: "pane", id: "b-pane", sessionId: "b" },
              { type: "pane", id: "c-pane", sessionId: "c" },
            ],
          },
          focusedSessionId: "b",
          pinned: false,
        },
      ],
      [session("a"), session("b"), session("c")],
    );

    useAppStore.getState().closeSession("workspace", "b");

    const workspace = useAppStore.getState().workspace.workspaces[0];
    expect(sessionIds(workspace.root)).toEqual(["a", "c"]);
    expect(workspace.focusedSessionId).toBe("a");
    expect(workspace.root.type).toBe("split");
    if (workspace.root.type === "split") {
      expect(workspace.root.sizes[0]).toBeCloseTo(2 / 7);
      expect(workspace.root.sizes[1]).toBeCloseTo(5 / 7);
    }
  });

  it("splits a tab next to a target in another pane", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Layout",
          root: {
            type: "split",
            id: "root",
            axis: "vertical",
            sizes: [0.6, 0.4],
            children: [
              {
                type: "tabGroup",
                id: "tabs",
                sessionIds: ["source", "sibling"],
                activeSessionId: "source",
              },
              { type: "pane", id: "target-pane", sessionId: "target" },
            ],
          },
          focusedSessionId: "source",
          pinned: false,
        },
      ],
      [session("source"), session("sibling"), session("target")],
    );

    useAppStore
      .getState()
      .splitExistingTab("workspace", "source", "target", "horizontal");

    const workspace = useAppStore.getState().workspace.workspaces[0];
    expect(workspace.focusedSessionId).toBe("source");
    expect(workspace.root).toMatchObject({
      type: "split",
      sizes: [0.6, 0.4],
      children: [
        { type: "pane", sessionId: "sibling" },
        {
          type: "split",
          axis: "horizontal",
          children: [
            { type: "pane", sessionId: "target" },
            { type: "pane", sessionId: "source" },
          ],
        },
      ],
    });
  });

  it("reorders workspace and terminal tabs using raw insertion indexes", () => {
    setWorkspace(
      [
        {
          id: "one",
          title: "One",
          root: {
            type: "tabGroup",
            id: "tabs",
            sessionIds: ["a", "b", "c"],
            activeSessionId: "b",
          },
          focusedSessionId: "b",
          pinned: false,
        },
        {
          id: "two",
          title: "Two",
          root: { type: "pane", id: "two-pane", sessionId: "d" },
          focusedSessionId: "d",
          pinned: false,
        },
        {
          id: "three",
          title: "Three",
          root: { type: "pane", id: "three-pane", sessionId: "e" },
          focusedSessionId: "e",
          pinned: false,
        },
      ],
      [
        session("a"),
        session("b"),
        session("c"),
        session("d"),
        session("e"),
      ],
      "one",
    );

    useAppStore.getState().moveWorkspace("one", 3);
    expect(
      useAppStore.getState().workspace.workspaces.map((item) => item.id),
    ).toEqual(["two", "three", "one"]);
    useAppStore.getState().moveWorkspace("one", 0);
    expect(
      useAppStore.getState().workspace.workspaces.map((item) => item.id),
    ).toEqual(["one", "two", "three"]);

    useAppStore.getState().moveTerminalTab("one", "a", 3);
    expect(
      useAppStore.getState().workspace.workspaces[0].root,
    ).toMatchObject({
      type: "tabGroup",
      sessionIds: ["b", "c", "a"],
      activeSessionId: "b",
    });
    useAppStore.getState().moveTerminalTab("one", "a", 0);
    expect(
      useAppStore.getState().workspace.workspaces[0].root,
    ).toMatchObject({
      type: "tabGroup",
      sessionIds: ["a", "b", "c"],
      activeSessionId: "b",
    });
  });

  it("ignores unchanged session lifecycle and metadata updates", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Terminal",
          root: { type: "pane", id: "pane", sessionId: "a" },
          focusedSessionId: "a",
          pinned: false,
        },
      ],
      [session("a", "Terminal")],
    );

    const before = useAppStore.getState().workspace;
    useAppStore.getState().setSessionLifecycle("a", "connected");
    useAppStore
      .getState()
      .updateSessionMetadata("a", { title: "Terminal" });
    expect(useAppStore.getState().workspace).toBe(before);

    useAppStore
      .getState()
      .updateSessionMetadata("a", { workingDirectory: "/tmp" });
    expect(useAppStore.getState().workspace).not.toBe(before);
  });

  it("keeps RTT transient and clears it when the SSH session ends", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Terminal",
          root: { type: "pane", id: "pane", sessionId: "a" },
          focusedSessionId: "a",
          pinned: false,
        },
      ],
      [session("a", "Server", "ssh")],
    );

    useAppStore.getState().setSessionLatency("a", 386.4);
    expect(useAppStore.getState().sessionLatencies.a).toBe(386);

    useAppStore.getState().setSessionLifecycle("a", "failed");
    expect(useAppStore.getState().sessionLatencies.a).toBeUndefined();
  });

  it("places dragged panes before the directional drop target", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Layout",
          root: {
            type: "tabGroup",
            id: "tabs",
            sessionIds: ["source", "target"],
            activeSessionId: "source",
          },
          focusedSessionId: "source",
          pinned: false,
        },
      ],
      [session("source"), session("target")],
    );

    useAppStore
      .getState()
      .splitExistingTab(
        "workspace",
        "source",
        "target",
        "vertical",
        "before",
      );

    expect(useAppStore.getState().workspace.workspaces[0].root).toMatchObject({
      type: "split",
      axis: "vertical",
      children: [
        { type: "pane", sessionId: "source" },
        { type: "pane", sessionId: "target" },
      ],
    });
  });

  it("opens SSH and local sibling splits from the selected pane", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Split source",
          root: {
            type: "split",
            id: "root",
            axis: "vertical",
            sizes: [0.5, 0.5],
            children: [
              { type: "pane", id: "remote-pane", sessionId: "remote" },
              { type: "pane", id: "local-pane", sessionId: "local" },
            ],
          },
          focusedSessionId: "local",
          pinned: false,
        },
      ],
      [
        session("remote", "Remote", "ssh"),
        session("local", "Local"),
      ],
    );
    const resolvedHost = {
      ...host("host"),
      hostname: "bastion.internal",
      sftpUsesSudo: true,
      serverToolsUseRoot: true,
    };
    useAppStore.setState({
      sessionHosts: { remote: resolvedHost },
    });

    const remote = useAppStore
      .getState()
      .openSiblingSplit("remote", "horizontal");
    expect(remote).toMatchObject({
      kind: "ssh",
      title: "Remote",
      hostId: "host",
      lifecycle: "connecting",
    });
    expect(useAppStore.getState().sessionHosts[remote!.id]).toEqual(
      resolvedHost,
    );
    expect(useAppStore.getState().workspace.workspaces[0].root).toMatchObject({
      type: "split",
      children: [
        {
          type: "split",
          axis: "horizontal",
          children: [
            { type: "pane", sessionId: "remote" },
            { type: "pane", sessionId: remote!.id },
          ],
        },
        { type: "pane", sessionId: "local" },
      ],
    });

    const local = useAppStore
      .getState()
      .openSiblingSplit("local", "vertical");
    expect(local).toMatchObject({
      kind: "local",
      title: "zsh",
      shell: "/bin/zsh",
      lifecycle: "connecting",
    });
    expect(useAppStore.getState().sessionHosts[local!.id]).toBeUndefined();
    expect(useAppStore.getState().workspace.workspaces[0].root).toMatchObject({
      type: "split",
      children: [
        { type: "split", axis: "horizontal" },
        {
          type: "split",
          axis: "vertical",
          children: [
            { type: "pane", sessionId: "local" },
            { type: "pane", sessionId: local!.id },
          ],
        },
      ],
    });
  });

  it.each<[number, string[]]>([
    [0, ["detached", "before", "source", "after"]],
    [2, ["before", "source", "detached", "after"]],
    [3, ["before", "source", "after", "detached"]],
  ])(
    "detaches a pane at workspace insertion index %i",
    (destinationIndex, expectedOrder) => {
      setWorkspace(
        [
          {
            id: "before",
            title: "Before",
            root: { type: "pane", id: "d-pane", sessionId: "d" },
            focusedSessionId: "d",
            pinned: false,
          },
          {
            id: "source",
            title: "Source",
            root: {
              type: "split",
              id: "source-root",
              axis: "vertical",
              sizes: [0.5, 0.5],
              children: [
                {
                  type: "tabGroup",
                  id: "tabs",
                  sessionIds: ["a", "b"],
                  activeSessionId: "a",
                },
                { type: "pane", id: "c-pane", sessionId: "c" },
              ],
            },
            focusedSessionId: "a",
            pinned: false,
          },
          {
            id: "after",
            title: "After",
            root: { type: "pane", id: "e-pane", sessionId: "e" },
            focusedSessionId: "e",
            pinned: false,
          },
        ],
        [
          session("a", "First"),
          session("b"),
          session("c"),
          session("d"),
          session("e"),
        ],
        "source",
      );

      useAppStore
        .getState()
        .detachPane("source", "a", destinationIndex);

      const snapshot = useAppStore.getState().workspace;
      const detached = snapshot.workspaces.find(
        (item) =>
          item.id !== "source" &&
          item.id !== "before" &&
          item.id !== "after",
      );
      expect(detached?.root).toMatchObject({
        type: "tabGroup",
        sessionIds: ["a", "b"],
        activeSessionId: "a",
      });
      expect(
        snapshot.workspaces.map((item) =>
          item.id === detached?.id ? "detached" : item.id,
        ),
      ).toEqual(expectedOrder);
      for (const sessionId of ["a", "b", "c", "d", "e"]) {
        expect(
          snapshot.workspaces.reduce(
            (count, item) =>
              count +
              sessionIds(item.root).filter((id) => id === sessionId)
                .length,
            0,
          ),
        ).toBe(1);
      }
    },
  );

  it("detaches one tab without terminating its session", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Tabs",
          root: {
            type: "tabGroup",
            id: "tabs",
            sessionIds: ["a", "b"],
            activeSessionId: "a",
          },
          focusedSessionId: "a",
          pinned: false,
        },
      ],
      [session("a", "First"), session("b", "Second")],
    );

    useAppStore.getState().detachSession("workspace", "a");

    const snapshot = useAppStore.getState().workspace;
    expect(snapshot.sessions.map((item) => item.id)).toEqual(["a", "b"]);
    expect(snapshot.workspaces).toHaveLength(2);
    expect(snapshot.workspaces[0].root).toMatchObject({
      type: "pane",
      sessionId: "b",
    });
    expect(snapshot.workspaces[0].focusedSessionId).toBe("b");
    expect(snapshot.workspaces[1]).toMatchObject({
      title: "First",
      focusedSessionId: "a",
      root: { type: "pane", sessionId: "a" },
    });
    expect(snapshot.activeWorkspaceId).toBe(snapshot.workspaces[1].id);
  });

  it("detaches the complete pane containing a tab group", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Split",
          root: {
            type: "split",
            id: "root",
            axis: "vertical",
            sizes: [0.5, 0.5],
            children: [
              {
                type: "tabGroup",
                id: "tabs",
                sessionIds: ["a", "b"],
                activeSessionId: "a",
              },
              { type: "pane", id: "c-pane", sessionId: "c" },
            ],
          },
          focusedSessionId: "a",
          pinned: false,
        },
      ],
      [session("a", "First"), session("b"), session("c")],
    );

    useAppStore.getState().detachPane("workspace", "a");

    const snapshot = useAppStore.getState().workspace;
    expect(snapshot.workspaces[0].root).toMatchObject({
      type: "pane",
      sessionId: "c",
    });
    expect(snapshot.workspaces[1].root).toMatchObject({
      type: "tabGroup",
      sessionIds: ["a", "b"],
      activeSessionId: "a",
    });
  });

  it("merges a single-pane workspace into the target workspace", () => {
    setWorkspace(
      [
        {
          id: "target",
          title: "Target",
          root: { type: "pane", id: "target-pane", sessionId: "c" },
          focusedSessionId: "c",
          pinned: false,
        },
        {
          id: "source",
          title: "Source",
          root: {
            type: "tabGroup",
            id: "source-tabs",
            sessionIds: ["a", "b"],
            activeSessionId: "a",
          },
          focusedSessionId: "a",
          pinned: false,
        },
      ],
      [session("a"), session("b"), session("c")],
      "source",
    );

    useAppStore
      .getState()
      .mergeWorkspace("source", "target", "c", "vertical");

    const snapshot = useAppStore.getState().workspace;
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.activeWorkspaceId).toBe("target");
    expect(snapshot.workspaces[0].root).toMatchObject({
      type: "split",
      axis: "vertical",
      children: [
        { type: "pane", sessionId: "c" },
        { type: "tabGroup", sessionIds: ["a", "b"] },
      ],
    });
  });

  it("duplicates descriptors and tree identifiers into a sibling workspace", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Production",
          root: {
            type: "tabGroup",
            id: "tabs",
            sessionIds: ["a", "b"],
            activeSessionId: "b",
          },
          focusedSessionId: "b",
          pinned: true,
        },
      ],
      [session("a"), session("b", "Remote", "ssh")],
    );

    useAppStore.getState().duplicateWorkspace("workspace");

    const snapshot = useAppStore.getState().workspace;
    const duplicate = snapshot.workspaces[1];
    expect(snapshot.workspaces).toHaveLength(2);
    expect(duplicate.title).toBe("Production Copy");
    expect(duplicate.pinned).toBe(false);
    expect(duplicate.id).not.toBe("workspace");
    expect(sessionIds(duplicate.root)).not.toEqual(["a", "b"]);
    expect(snapshot.sessions).toHaveLength(4);
    expect(
      snapshot.sessions.slice(2).every((item) => item.lifecycle === "connecting"),
    ).toBe(true);
    expect(sessionIds(duplicate.root)).toContain(duplicate.focusedSessionId);
  });

  it("clones a complete window workspace without reusing runtime IDs", () => {
    const source = {
      version: 1,
      savedAt: "2026-01-01T00:00:00Z",
      activeWorkspaceId: "workspace",
      sessions: [session("a"), session("b", "Remote", "ssh")],
      workspaces: [
        {
          id: "workspace",
          title: "Production",
          root: {
            type: "tabGroup" as const,
            id: "tabs",
            sessionIds: ["a", "b"],
            activeSessionId: "b",
          },
          focusedSessionId: "b",
          pinned: false,
        },
      ],
    };

    const clone = cloneWorkspaceSnapshot(source);

    expect(clone.activeWorkspaceId).not.toBe("workspace");
    expect(clone.workspaces[0].id).not.toBe("workspace");
    expect(clone.workspaces[0].root.id).not.toBe("tabs");
    expect(sessionIds(clone.workspaces[0].root)).not.toEqual(["a", "b"]);
    expect(clone.workspaces[0].focusedSessionId).toBe(
      sessionIds(clone.workspaces[0].root)[1],
    );
    expect(
      clone.sessions.every((item) => item.lifecycle === "connecting"),
    ).toBe(true);
  });

  it("starts normal windows empty and restores only explicit window clones", () => {
    const clone = {
      version: 1,
      savedAt: "2026-01-01T00:00:00Z",
      activeWorkspaceId: "workspace",
      sessions: [session("a")],
      workspaces: [
        {
          id: "workspace",
          title: "Clone",
          root: { type: "pane" as const, id: "pane", sessionId: "a" },
          focusedSessionId: "a",
          pinned: false,
        },
      ],
    };

    expect(workspaceForStartup()).toMatchObject({
      version: 1,
      sessions: [],
      workspaces: [],
    });
    expect(workspaceForStartup(clone)).toBe(clone);
  });

  it("moves pinned workspaces ahead while preserving relative order", () => {
    setWorkspace(
      [
        {
          id: "one",
          title: "One",
          root: { type: "pane", id: "one-pane", sessionId: "a" },
          focusedSessionId: "a",
          pinned: false,
        },
        {
          id: "two",
          title: "Two",
          root: { type: "pane", id: "two-pane", sessionId: "b" },
          focusedSessionId: "b",
          pinned: false,
        },
        {
          id: "three",
          title: "Three",
          root: { type: "pane", id: "three-pane", sessionId: "c" },
          focusedSessionId: "c",
          pinned: false,
        },
      ],
      [session("a"), session("b"), session("c")],
    );

    useAppStore.getState().toggleWorkspacePinned("two");

    expect(
      useAppStore.getState().workspace.workspaces.map((item) => item.id),
    ).toEqual(["two", "one", "three"]);
  });

  it("consumes a sibling terminal startup command exactly once", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Remote",
          root: { type: "pane", id: "pane", sessionId: "source" },
          focusedSessionId: "source",
          pinned: false,
        },
      ],
      [session("source", "Remote", "ssh")],
    );
    useAppStore.setState({
      sessionHosts: { source: host("host") },
    });

    const sibling = useAppStore
      .getState()
      .openSiblingTab(
        "source",
        "Docker logs",
        "sudo docker logs -f c1\r",
        "root-secret",
      );

    expect(sibling).toBeDefined();
    expect(sibling?.kind).toBe("ssh");
    expect(useAppStore.getState().sessionHosts[sibling!.id]).toEqual(
      host("host"),
    );
    expect(
      useAppStore
        .getState()
        .consumeSessionStartupCommand(sibling!.id),
    ).toEqual({
      command: "sudo docker logs -f c1\r",
      automaticPassword: "root-secret",
    });
    expect(
      useAppStore
        .getState()
        .consumeSessionStartupCommand(sibling!.id),
    ).toBeUndefined();

    useAppStore.setState({
      connectionLogs: {
        [sibling!.id]: [
          {
            id: "log",
            status: "ready",
            message: "ready",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    useAppStore.getState().closeSession("workspace", sibling!.id);
    expect(useAppStore.getState().sessionHosts[sibling!.id]).toBeUndefined();
    expect(
      useAppStore.getState().connectionLogs[sibling!.id],
    ).toBeUndefined();
  });

  it("persists runtime port-forward status updates", () => {
    const forward = {
      id: "forward",
      hostId: "host",
      name: "Database",
      kind: "local" as const,
      bindAddress: "127.0.0.1",
      localPort: 8080,
      remoteHost: "database.internal",
      remotePort: 5432,
      autoStart: true,
      status: "connecting" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    useAppStore.setState({ forwards: [forward] });

    useAppStore.getState().setForwardStatus("forward", "active");

    const updated = useAppStore.getState().forwards[0];
    expect(updated.status).toBe("active");
    expect(updated.lastUsedAt).toBeDefined();
    expect(api.saveForward).toHaveBeenCalledWith(updated);
  });

  it("records one connection history lifecycle per session", () => {
    useAppStore.getState().beginConnectionHistory("session", "host");
    useAppStore.getState().beginConnectionHistory("session", "host");
    useAppStore.getState().markConnectionConnected("session");

    expect(useAppStore.getState().history).toHaveLength(1);
    expect(useAppStore.getState().history[0]).toMatchObject({
      hostId: "host",
      succeeded: true,
    });

    useAppStore.getState().finishConnectionHistory("session");
    const entry = useAppStore.getState().history[0];
    expect(entry.endedAt).toBeDefined();
    expect(api.appendHistory).toHaveBeenLastCalledWith(entry);
    expect(
      useAppStore.getState().sessionHistoryEntries.session,
    ).toBeUndefined();
  });

  it("persists deduplicated command history with session metadata", () => {
    setWorkspace(
      [
        {
          id: "workspace",
          title: "Remote",
          root: { type: "pane", id: "pane", sessionId: "session" },
          focusedSessionId: "session",
          pinned: false,
        },
      ],
      [session("session", "Production", "ssh")],
    );

    useAppStore.getState().recordCommand("session", "  uptime  ");
    useAppStore.getState().recordCommand("session", "uptime");

    expect(useAppStore.getState().commandHistory).toHaveLength(1);
    expect(useAppStore.getState().commandHistory[0]).toMatchObject({
      sessionId: "session",
      sessionTitle: "Production",
      hostId: "host",
      command: "uptime",
    });
    expect(api.appendCommandHistory).toHaveBeenCalledTimes(2);
  });

  it("normalizes persisted cross-platform preferences", async () => {
    const current = useAppStore.getState().preferences;
    await useAppStore.getState().updatePreferences({
      ...current,
      terminalFontSize: 100,
      autocompleteGhostText: true,
      autocompletePopup: true,
      passwordPromptAssist: "automatic" as never,
      overviewRefreshInterval: 0,
      sftpFileTransferConcurrency: 99,
      sftpChunkConcurrency: 0,
      sftpChunkSizeBytes: 123,
      sftpTransferConnectionIdleSeconds: 12,
    });

    expect(useAppStore.getState().preferences).toMatchObject({
      terminalFontSize: 36,
      autocompleteGhostText: false,
      passwordPromptAssist: "picker",
      overviewRefreshInterval: 1,
      sftpFileTransferConcurrency: 16,
      sftpChunkConcurrency: 1,
      sftpChunkSizeBytes: 256 * 1024,
      sftpTransferConnectionIdleSeconds: 300,
    });
  });

  it("atomically replaces hosts returned by a batch save", async () => {
    useAppStore.setState({ hosts: [host("one"), host("two")] });
    await useAppStore
      .getState()
      .saveHosts([{ ...host("two"), groupId: "production" }]);

    expect(api.saveHosts).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().hosts).toEqual([
      host("one"),
      { ...host("two"), groupId: "production" },
    ]);
  });

  it("removes descendant groups and ungroups their hosts", async () => {
    useAppStore.setState({
      groups: [
        { id: "root", name: "Root", sortOrder: 0 },
        {
          id: "child",
          name: "Child",
          parentGroupId: "root",
          sortOrder: 0,
        },
      ],
      hosts: [host("nested", "child"), host("other")],
    });

    await useAppStore.getState().deleteGroup("root");

    expect(api.deleteGroup).toHaveBeenCalledWith("root");
    expect(useAppStore.getState().groups).toEqual([]);
    expect(useAppStore.getState().hosts).toEqual([
      host("nested"),
      host("other"),
    ]);
  });
});
