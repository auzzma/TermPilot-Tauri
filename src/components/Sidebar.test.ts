import { describe, expect, it } from "vitest";

import type { Host, HostGroup } from "../types";
import {
  availableGroupName,
  batchSelectionState,
  buildHostGroupTree,
  contextMenuPosition,
  defaultProxyConfiguration,
  effectiveDistro,
  effectiveHostColor,
  flattenHostGroupTree,
  hostLoginPassword,
  hostIdsInGroup,
  hostsMovedToGroup,
  initialCollapsedGroupIds,
  normalizedScriptCommand,
  reconcileCollapsedGroupIds,
  validateHostEditorDraft,
} from "./Sidebar";

const host = (
  id: string,
  groupId: string | undefined,
  sortOrder: number,
): Host => ({
  id,
  label: id,
  hostname: `${id}.example.com`,
  port: 22,
  username: "pilot",
  authentication: "agent",
  groupId,
  sortOrder,
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

describe("host group hierarchy", () => {
  it("starts with every group collapsed and collapses newly added groups", () => {
    const groups: HostGroup[] = [
      { id: "root", name: "Root", sortOrder: 0 },
      { id: "child", name: "Child", parentGroupId: "root", sortOrder: 0 },
    ];
    const initial = initialCollapsedGroupIds(groups);
    expect(initial).toEqual(new Set(["root", "child"]));

    const updated = reconcileCollapsedGroupIds(
      new Set(["root"]),
      new Set(["root", "child"]),
      new Set(["root", "child", "new"]),
    );
    expect(updated).toEqual(new Set(["root", "new"]));
  });

  it("generates a unique subgroup name among siblings", () => {
    const groups: HostGroup[] = [
      { id: "one", name: "New group", parentGroupId: "root", sortOrder: 0 },
      { id: "two", name: "New group 2", parentGroupId: "root", sortOrder: 1 },
    ];
    expect(availableGroupName(groups, "root", "New group")).toBe(
      "New group 3",
    );
  });

  it("keeps nested, orphaned, and cyclic groups visible exactly once", () => {
    const groups: HostGroup[] = [
      { id: "root", name: "Root", sortOrder: 0 },
      {
        id: "child",
        name: "Child",
        parentGroupId: "root",
        sortOrder: 0,
      },
      {
        id: "orphan",
        name: "Orphan",
        parentGroupId: "missing",
        sortOrder: 1,
      },
      { id: "cycle-a", name: "Cycle A", parentGroupId: "cycle-b", sortOrder: 2 },
      { id: "cycle-b", name: "Cycle B", parentGroupId: "cycle-a", sortOrder: 3 },
    ];

    const options = flattenHostGroupTree(buildHostGroupTree(groups));
    expect(options.map((option) => option.group.id).sort()).toEqual(
      groups.map((group) => group.id).sort(),
    );
    expect(options.find((option) => option.group.id === "child")?.depth).toBe(1);
  });

  it("reports group selection across descendant hosts", () => {
    const groups: HostGroup[] = [
      { id: "root", name: "Root", sortOrder: 0 },
      {
        id: "child",
        name: "Child",
        parentGroupId: "root",
        sortOrder: 0,
      },
    ];
    const ids = hostIdsInGroup(
      groups,
      [host("one", "root", 0), host("two", "child", 0)],
      "root",
    );

    expect(ids).toEqual(new Set(["one", "two"]));
    expect(batchSelectionState(ids, new Set(["one"]))).toBe("partial");
    expect(batchSelectionState(ids, new Set(["one", "two"]))).toBe("all");
  });
});

describe("group context menu", () => {
  it("keeps the menu inside the application viewport", () => {
    expect(contextMenuPosition(990, 790, 230, 182, 1000, 800)).toEqual({
      left: 762,
      top: 610,
    });
    expect(contextMenuPosition(-20, -10, 230, 182, 1000, 800)).toEqual({
      left: 8,
      top: 8,
    });
  });
});

describe("Swift-compatible host context menu", () => {
  it("resolves login passwords from password credentials only", () => {
    const source = {
      ...host("server", "group", 0),
      authentication: "password" as const,
      password: "inline-secret",
    };
    expect(hostLoginPassword(source, [])).toBe("inline-secret");
    expect(
      hostLoginPassword(
        { ...source, credentialId: "credential" },
        [
          {
            id: "credential",
            label: "Password",
            username: "pilot",
            kind: "password",
            password: "saved-secret",
            savesPassphrase: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      ),
    ).toBe("saved-secret");
  });

  it("normalizes scripts for execution after SSH connects", () => {
    expect(normalizedScriptCommand("echo ready")).toBe("echo ready\n");
    expect(normalizedScriptCommand("  ")).toBeUndefined();
  });
});

describe("Swift-compatible host editor", () => {
  it("uses the same default custom proxy configuration as Swift", () => {
    expect(defaultProxyConfiguration()).toEqual({
      type: "http",
      host: "",
      port: 8080,
    });
  });

  it("validates host identity and private-key fields", () => {
    const source = host("server", undefined, 0);
    expect(validateHostEditorDraft(source)).toBeUndefined();
    expect(validateHostEditorDraft({ ...source, label: " " })).toBe(
      "Host name is required.",
    );
    expect(validateHostEditorDraft({ ...source, hostname: "bad host" })).toBe(
      "Enter a valid IP address or host name.",
    );
    expect(validateHostEditorDraft({ ...source, port: 70000 })).toBe(
      "Port must be between 1 and 65535.",
    );
    expect(
      validateHostEditorDraft({
        ...source,
        authentication: "identityFile",
      }),
    ).toBe("Private key path is required.");
  });

  it("validates HTTP, SOCKS5, and ProxyCommand settings", () => {
    const source = host("server", undefined, 0);
    expect(
      validateHostEditorDraft({
        ...source,
        proxyConfiguration: defaultProxyConfiguration(),
      }),
    ).toBe("Enter a valid proxy host.");
    expect(
      validateHostEditorDraft({
        ...source,
        proxyConfiguration: {
          type: "socks5",
          host: "proxy.example.com",
          port: 1080,
        },
      }),
    ).toBeUndefined();
    expect(
      validateHostEditorDraft({
        ...source,
        proxyConfiguration: {
          type: "command",
          host: "",
          port: 0,
        },
      }),
    ).toBe("ProxyCommand is required.");
    expect(
      validateHostEditorDraft({
        ...source,
        proxyConfiguration: {
          type: "command",
          host: "",
          port: 0,
          command: "ssh -W %h:%p jump",
        },
      }),
    ).toBeUndefined();
  });
});

describe("host batch management", () => {
  it("moves selected hosts and compacts affected group ordering", () => {
    const updated = hostsMovedToGroup(
      [
        host("one", "source", 0),
        host("two", "source", 1),
        host("three", "target", 0),
        host("four", "target", 1),
      ],
      new Set(["two", "four"]),
      "target",
    );

    expect(
      updated.map(({ id, groupId, sortOrder }) => ({
        id,
        groupId,
        sortOrder,
      })),
    ).toEqual([
      { id: "one", groupId: "source", sortOrder: 0 },
      { id: "two", groupId: "target", sortOrder: 1 },
      { id: "three", groupId: "target", sortOrder: 0 },
      { id: "four", groupId: "target", sortOrder: 2 },
    ]);
  });
});

describe("host appearance", () => {
  it("uses manual distro, custom icon defaults, and custom colors", () => {
    expect(
      effectiveDistro({
        ...host("appearance", undefined, 0),
        distro: "ubuntu",
        distroMode: "manual",
        manualDistro: "debian",
      }),
    ).toBe("debian");
    expect(
      effectiveHostColor({
        ...host("appearance", undefined, 0),
        iconMode: "custom",
        iconId: "database",
      }),
    ).toBe("#0891B2");
    expect(
      effectiveHostColor({
        ...host("appearance", undefined, 0),
        iconColorMode: "manual",
        iconColorCustom: "#ABCDEF",
      }),
    ).toBe("#ABCDEF");
  });
});
