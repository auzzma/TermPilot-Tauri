import { describe, expect, it } from "vitest";

import {
  activeHostKeyPrompt,
  connectionLogTone,
  connectionStageIndex,
  connectionStageStatus,
} from "./ConnectionProgressOverlay";

describe("Swift-compatible SSH connection progress", () => {
  it("advances through authentication, channel, and ready logs", () => {
    expect(connectionStageIndex("connecting", [])).toBe(0);
    expect(
      connectionStageIndex("connecting", [
        entry("auth", "Authentication completed"),
      ]),
    ).toBe(1);
    expect(
      connectionStageIndex("connecting", [
        entry("auth", "Authentication completed"),
        entry("shell", "Opening interactive shell channel"),
      ]),
    ).toBe(2);
    expect(
      connectionStageIndex("connecting", [
        entry("connected", "Interactive shell channel established"),
      ]),
    ).toBe(3);
  });

  it("marks prior stages complete and the current stage active", () => {
    expect(connectionStageStatus(0, 1, "connecting")).toBe("completed");
    expect(connectionStageStatus(1, 1, "connecting")).toBe("active");
    expect(connectionStageStatus(2, 1, "connecting")).toBe("pending");
  });

  it("marks the current stage failed after a connection error", () => {
    expect(connectionStageStatus(1, 1, "failed")).toBe("failed");
  });

  it("colors connection log messages consistently with Swift", () => {
    expect(connectionLogTone(entry("error", "Authentication failed"))).toBe(
      "error",
    );
    expect(
      connectionLogTone(
        entry("connected", "Interactive shell channel established"),
      ),
    ).toBe("success");
    expect(connectionLogTone(entry("auth", "Using SSH agent"))).toBe(
      "active",
    );
    expect(connectionLogTone(entry("queued", "Session queued"))).toBe(
      "default",
    );
  });

  it("extracts an active structured SSH host key prompt", () => {
    expect(
      activeHostKeyPrompt([
        entry(
          "host-key-prompt",
          "SSH host key confirmation required",
          JSON.stringify({
            hostPattern: "[example.com]:2222",
            algorithm: "ssh-ed25519",
            fingerprint: "SHA256:abc123",
            hasHostPattern: true,
          }),
        ),
      ]),
    ).toEqual({
      hostPattern: "[example.com]:2222",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:abc123",
      hasHostPattern: true,
    });
  });

  it("clears the host key prompt after a response log arrives", () => {
    expect(
      activeHostKeyPrompt([
        entry(
          "host-key-prompt",
          "SSH host key confirmation required",
          JSON.stringify({
            hostPattern: "example.com",
            algorithm: "ssh-ed25519",
            fingerprint: "SHA256:abc123",
          }),
        ),
        entry("host-key-response", "SSH host key accepted by user."),
      ]),
    ).toBeUndefined();
  });
});

function entry(status: string, message: string, detail?: string) {
  return { status, message, detail };
}
