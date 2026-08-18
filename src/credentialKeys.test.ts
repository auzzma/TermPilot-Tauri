import { describe, expect, it } from "vitest";

import {
  authorizedKeyInstallCommand,
  hasCompleteKeyPair,
  hostForCredentialVerification,
  hostLinkedToCredential,
} from "./credentialKeys";
import type { Credential, Host } from "./types";

const credential: Credential = {
  id: "credential",
  label: "Deploy",
  username: "deploy",
  kind: "identityKey",
  privateKey: "private",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest pilot's key",
  savesPassphrase: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const host: Host = {
  id: "host",
  label: "Server",
  hostname: "server.example.com",
  port: 22,
  username: "deploy",
  authentication: "password",
  password: "secret",
  sortOrder: 0,
  distroMode: "auto",
  iconMode: "auto",
  iconColorMode: "auto",
  sftpFileProtocol: "auto",
  sftpFilenameEncoding: "auto",
  sftpUsesSudo: false,
  serverToolsUseRoot: false,
  serverToolsElevationMethod: "sudo",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("credential key export", () => {
  it("builds an idempotent authorized_keys command with shell quoting", () => {
    const command = authorizedKeyInstallCommand(credential.publicKey!);
    expect(command).toContain("grep -Fqx");
    expect(command).toContain("|| printf");
    expect(command).toContain(`pilot'\\''s key`);
  });

  it("links a host only after preserving its host-specific username", () => {
    const linked = hostLinkedToCredential(host, credential);
    expect(linked.username).toBe("deploy");
    expect(linked.authentication).toBe("identityFile");
    expect(linked.credentialId).toBe(credential.id);
    expect(linked.password).toBeUndefined();
  });

  it("verifies the generated key without changing the saved host", () => {
    const verification = hostForCredentialVerification(host, credential);
    expect(verification.authentication).toBe("identityFile");
    expect(verification.credentialId).toBeUndefined();
    expect(verification.identityKey).toBe(credential.privateKey);
    expect(verification.publicKey).toBe(credential.publicKey);
    expect(verification.username).toBe(host.username);
    expect(host.authentication).toBe("password");
    expect(host.password).toBe("secret");
  });

  it("offers export only for credentials with both key parts", () => {
    expect(hasCompleteKeyPair(credential)).toBe(true);
    expect(hasCompleteKeyPair({ ...credential, publicKey: "" })).toBe(false);
  });
});
