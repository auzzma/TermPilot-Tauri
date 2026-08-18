import { describe, expect, it } from "vitest";

import {
  batchConflictWindowHeight,
  duplicateName,
  flattenRemoteTree,
  localJoin,
  remoteMenuPosition,
  remoteTextDraft,
  transferProgressText,
  updateTransferProgress,
  updateSelection,
} from "./SftpPanel";
import type { TransferRecord } from "./SftpPanel";

describe("SFTP selection", () => {
  it("replaces or toggles selected paths", () => {
    expect(updateSelection(["one"], "two", false)).toEqual(["two"]);
    expect(updateSelection(["one"], "two", true)).toEqual(["one", "two"]);
    expect(updateSelection(["one", "two"], "one", true)).toEqual(["two"]);
  });
});

describe("SFTP duplicate names", () => {
  it("inserts the suffix before a file extension", () => {
    expect(duplicateName("config.json", [], false)).toBe(
      "config (copy).json",
    );
    expect(
      duplicateName("config.json", ["config (copy).json"], false),
    ).toBe("config (copy 2).json");
  });

  it("keeps dots in directory names", () => {
    expect(duplicateName("archive.tar", [], true)).toBe(
      "archive.tar (copy)",
    );
  });
});

describe("SFTP local download paths", () => {
  it("joins macOS and Windows download directories", () => {
    expect(localJoin("/Users/alice/Downloads", "archive.zip")).toBe(
      "/Users/alice/Downloads/archive.zip",
    );
    expect(localJoin("C:\\Users\\Alice\\Downloads", "archive.zip")).toBe(
      "C:\\Users\\Alice\\Downloads\\archive.zip",
    );
  });
});

describe("SFTP remote tree", () => {
  it("flattens only expanded directory descendants", () => {
    const tree = flattenRemoteTree(
      ".",
      {
        ".": [
          {
            name: "etc",
            path: "etc",
            kind: "directory",
            size: 0,
          },
          {
            name: "readme",
            path: "readme",
            kind: "file",
            size: 10,
          },
        ],
        etc: [
          {
            name: "hosts",
            path: "etc/hosts",
            kind: "file",
            size: 20,
          },
        ],
      },
      new Set(["etc"]),
    );

    expect(tree.map((entry) => entry.path)).toEqual([
      "etc",
      "etc/hosts",
      "readme",
    ]);
    expect(tree[0].displayName).toBe("[-] etc");
    expect(tree[1].displayName).toBe("  hosts");
  });
});

describe("SFTP context menu placement", () => {
  it("keeps the menu inside every viewport edge", () => {
    expect(remoteMenuPosition(990, 790, 232, 430, 1000, 800)).toEqual({
      left: 760,
      top: 362,
    });
    expect(remoteMenuPosition(-20, -10, 232, 430, 1000, 800)).toEqual({
      left: 8,
      top: 8,
    });
  });
});

describe("Swift-compatible remote text editor", () => {
  it("keeps the filename separate from the remote path", () => {
    expect(
      remoteTextDraft(
        "sshd_config",
        "/etc/ssh/sshd_config",
        "PermitRootLogin no\n",
      ),
    ).toEqual({
      name: "sshd_config",
      path: "/etc/ssh/sshd_config",
      text: "PermitRootLogin no\n",
    });
  });
});

describe("Swift-compatible transfer presentation", () => {
  it("calculates transfer speed and detailed progress text", () => {
    const initial: TransferRecord = {
      id: "transfer",
      transferKey: "key",
      name: "TermPilot-universal.zip",
      direction: "upload",
      transferred: 0,
      total: 1000,
      bytesPerSecond: 0,
      sampledAt: 1000,
      sampledBytes: 0,
      state: "running",
    };

    const updated = updateTransferProgress(
      initial,
      { transferred: 500, total: 1000 },
      2000,
    );

    expect(updated.bytesPerSecond).toBe(500);
    expect(transferProgressText(updated)).toBe(
      "500 B/s · 500 B / 1000 B · 50%",
    );
  });

  it("matches Swift batch conflict height limits", () => {
    expect(batchConflictWindowHeight(1)).toBe(313);
    expect(batchConflictWindowHeight(3)).toBe(378);
    expect(batchConflictWindowHeight(10)).toBe(453);
  });
});
