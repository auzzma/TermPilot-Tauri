import { describe, expect, it } from "vitest";
import type { HostNote, PortForwardRule } from "../types";

import {
  bindWorkspaceSidePanel,
  parseCommandHistory,
  parseForwardEndpoint,
  retargetWorkspaceSidePanel,
  resolveSplitDrop,
  resolveTabInsertionFromFrames,
  resolveWorkspaceDetachTarget,
  selectCommandHistory,
  selectForwards,
  selectNotes,
  selectWorkspaceSidePanel,
  shouldCloseSidePanelForLayout,
  terminalLatencyQuality,
  workspaceTabTooltip,
} from "./WorkspaceArea";

const tabFrames = [
  { id: "first", frame: frame(20, 40, 100, 24) },
  { id: "second", frame: frame(125, 40, 100, 24) },
  { id: "third", frame: frame(230, 40, 100, 24) },
];

describe("Swift-compatible tab dragging", () => {
  it("resolves insertions from visual order, including both ends", () => {
    expect(
      resolveTabInsertionFromFrames("first", 200, tabFrames),
    ).toEqual({
      rawDestinationIndex: 2,
      indicatorX: 230,
    });
    expect(
      resolveTabInsertionFromFrames("first", 320, tabFrames),
    ).toEqual({
      rawDestinationIndex: 3,
      indicatorX: 330,
    });
    expect(
      resolveTabInsertionFromFrames("third", 40, tabFrames),
    ).toEqual({
      rawDestinationIndex: 0,
      indicatorX: 20,
    });
    expect(
      resolveTabInsertionFromFrames("second", 175, tabFrames),
    ).toBeUndefined();
  });

  it("resolves directional pane halves and placement", () => {
    const target = frame(100, 200, 400, 300);

    expect(resolveSplitDrop(120, 350, target)).toEqual({
      axis: "vertical",
      placement: "before",
      frame: { left: 100, top: 200, width: 200, height: 300 },
    });
    expect(resolveSplitDrop(480, 350, target)).toEqual({
      axis: "vertical",
      placement: "after",
      frame: { left: 300, top: 200, width: 200, height: 300 },
    });
    expect(resolveSplitDrop(300, 220, target)).toEqual({
      axis: "horizontal",
      placement: "before",
      frame: { left: 100, top: 200, width: 400, height: 150 },
    });
    expect(resolveSplitDrop(300, 480, target)).toEqual({
      axis: "horizontal",
      placement: "after",
      frame: { left: 100, top: 350, width: 400, height: 150 },
    });
  });

  it("resolves pane detachment at the first, middle, and last workspace positions", () => {
    const tabBar = frame(10, 35, 350, 34);

    expect(
      resolveWorkspaceDetachTarget(30, 50, tabBar, tabFrames),
    ).toEqual({
      destinationIndex: 0,
      indicatorX: 20,
    });
    expect(
      resolveWorkspaceDetachTarget(180, 50, tabBar, tabFrames),
    ).toEqual({
      destinationIndex: 2,
      indicatorX: 225,
    });
    expect(
      resolveWorkspaceDetachTarget(350, 50, tabBar, tabFrames),
    ).toEqual({
      destinationIndex: 3,
      indicatorX: 330,
    });
    expect(
      resolveWorkspaceDetachTarget(180, 10, tabBar, tabFrames),
    ).toBeUndefined();
  });
});

describe("command history selector", () => {
  it("returns the stable store array instead of allocating a snapshot", () => {
    const commandHistory = [
      {
        id: "history",
        sessionId: "session",
        command: "pwd",
        createdAt: "2026-08-07T00:00:00Z",
      },
    ];

    expect(selectCommandHistory({ commandHistory })).toBe(commandHistory);
  });

  it("parses and deduplicates shell history in newest-first order", () => {
    const entries = parseCommandHistory(
      [
        "__TP_HISTORY_SHELL__zsh",
        "__TP_HISTORY_ZSH__",
        ": 1700000000:0;pwd",
        ": 1700000001:0;git status",
        ": 1700000002:0;pwd",
      ].join("\n"),
      "session",
    );

    expect(entries.map((entry) => entry.command)).toEqual([
      "pwd",
      "git status",
    ]);
    expect(entries[0].sessionId).toBe("session");
  });
});

describe("side panel stable selectors", () => {
  it("preserves note and forwarding store references", () => {
    const notes: HostNote[] = [];
    const forwards: PortForwardRule[] = [];

    expect(selectNotes({ notes })).toBe(notes);
    expect(selectForwards({ forwards })).toBe(forwards);
  });

  it("parses valid forwarding endpoints and rejects invalid ports", () => {
    expect(parseForwardEndpoint("127.0.0.1:8080")).toEqual({
      host: "127.0.0.1",
      port: 8080,
    });
    expect(parseForwardEndpoint("localhost:70000")).toBeUndefined();
    expect(parseForwardEndpoint("missing-port")).toBeUndefined();
  });
});

describe("workspace side panel connection persistence", () => {
  it("keeps independent source sessions when switching workspaces", () => {
    const first = bindWorkspaceSidePanel(
      {},
      "workspace-a",
      "session-a",
      "sftp",
      "host-a",
    );
    const second = bindWorkspaceSidePanel(
      first,
      "workspace-b",
      "session-b",
      "system",
      "host-b",
    );

    expect(second["workspace-a"]).toBe(first["workspace-a"]);
    expect(second).toMatchObject({
      "workspace-a": {
        selected: "sftp",
        sourceSessionId: "session-a",
        hostId: "host-a",
      },
      "workspace-b": {
        selected: "system",
        sourceSessionId: "session-b",
        hostId: "host-b",
      },
    });
  });

  it("changes tools without replacing the bound connection", () => {
    const panels = bindWorkspaceSidePanel(
      {},
      "workspace",
      "source-session",
      "sftp",
      "host",
    );
    const selected = selectWorkspaceSidePanel(
      panels,
      "workspace",
      "history",
    );

    expect(selected.workspace).toEqual({
      selected: "history",
      sourceSessionId: "source-session",
      hostId: "host",
    });
  });

  it("retargets the open panel when the focused session changes", () => {
    const panels = bindWorkspaceSidePanel(
      {},
      "workspace",
      "session-a",
      "sftp",
      "host-a",
    );

    const retargeted = retargetWorkspaceSidePanel(
      panels,
      "workspace",
      "session-b",
      "host-b",
    );

    expect(retargeted.workspace).toEqual({
      selected: "sftp",
      sourceSessionId: "session-b",
      hostId: "host-b",
    });
  });
});

describe("Swift-compatible split side panel behavior", () => {
  it("closes for a new split or when switching to a split workspace", () => {
    expect(
      shouldCloseSidePanelForLayout("workspace", 1, "workspace", 2),
    ).toBe(true);
    expect(
      shouldCloseSidePanelForLayout("first", 1, "second", 2),
    ).toBe(true);
    expect(
      shouldCloseSidePanelForLayout("workspace", 2, "workspace", 3),
    ).toBe(true);
  });

  it("does not prevent reopening the side panel in an unchanged split", () => {
    expect(
      shouldCloseSidePanelForLayout("workspace", 2, "workspace", 2),
    ).toBe(false);
    expect(
      shouldCloseSidePanelForLayout("workspace", 1, "workspace", 1),
    ).toBe(false);
  });
});

describe("terminal latency quality", () => {
  it("uses the same RTT thresholds as Swift", () => {
    expect(terminalLatencyQuality(150)).toBe("good");
    expect(terminalLatencyQuality(151)).toBe("elevated");
    expect(terminalLatencyQuality(400)).toBe("elevated");
    expect(terminalLatencyQuality(401)).toBe("poor");
  });
});

describe("workspace tab information", () => {
  it("matches Swift details for local and split SSH workspaces", () => {
    expect(
      workspaceTabTooltip(
        {
          id: "local-workspace",
          title: "Local",
          root: { type: "pane", id: "pane", sessionId: "local" },
          focusedSessionId: "local",
          pinned: false,
        },
        [
          {
            id: "local",
            kind: "local",
            title: "zsh",
            shell: "/bin/zsh",
            workingDirectory: "/Users/pilot",
            fontSize: 13,
            lifecycle: "connected",
          },
        ],
        {},
      ),
    ).toEqual({ title: "Local", subtitle: "/Users/pilot" });

    expect(
      workspaceTabTooltip(
        {
          id: "ssh-workspace",
          title: "Production",
          root: {
            type: "split",
            id: "split",
            axis: "vertical",
            sizes: [0.5, 0.5],
            children: [
              { type: "pane", id: "one", sessionId: "ssh" },
              { type: "pane", id: "two", sessionId: "other" },
            ],
          },
          focusedSessionId: "ssh",
          pinned: false,
        },
        [
          {
            id: "ssh",
            kind: "ssh",
            title: "Server",
            fontSize: 13,
            lifecycle: "connected",
          },
        ],
        {
          ssh: {
            username: "root",
            hostname: "server.example.com",
            port: 2222,
          },
        },
      ),
    ).toEqual({
      title: "Production",
      subtitle: "Workspace 2 · root@server.example.com:2222",
    });
  });
});

function frame(
  left: number,
  top: number,
  width: number,
  height: number,
) {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  };
}
