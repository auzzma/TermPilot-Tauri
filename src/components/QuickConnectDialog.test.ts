import { describe, expect, it } from "vitest";

import {
  parseQuickConnectTarget,
  quickConnectConnectionFields,
  quickConnectCredentialFields,
  quickConnectHostId,
  serverToolsConfiguration,
} from "./QuickConnectDialog";
import type { Credential } from "../types";

describe("Quick Connect targets", () => {
  it("parses direct, bracketed IPv6, and ssh URL targets", () => {
    expect(parseQuickConnectTarget("pilot@example.com:2202")).toEqual({
      username: "pilot",
      hostname: "example.com",
      port: 2202,
    });
    expect(parseQuickConnectTarget("root@[2001:db8::1]:2222")).toEqual({
      username: "root",
      hostname: "2001:db8::1",
      port: 2222,
    });
    expect(parseQuickConnectTarget("ssh://build%20user@example.com")).toEqual({
      username: "build user",
      hostname: "example.com",
      port: 22,
    });
  });

  it("rejects missing users, whitespace, and invalid ports", () => {
    expect(parseQuickConnectTarget("example.com")).toBeUndefined();
    expect(parseQuickConnectTarget("pilot@bad host")).toBeUndefined();
    expect(parseQuickConnectTarget("pilot@example.com:70000")).toBeUndefined();
  });

  it("derives a stable version-5 UUID from normalized connection identity", async () => {
    const first = await quickConnectHostId(
      " pilot ",
      "EXAMPLE.COM",
      22,
    );
    const second = await quickConnectHostId(
      "pilot",
      "example.com",
      22,
    );

    expect(first).toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("Quick Connect server tools", () => {
  it("maps disabled, sudo, and su to the persisted host fields", () => {
    expect(serverToolsConfiguration("disabled")).toEqual({
      serverToolsUseRoot: false,
      serverToolsElevationMethod: "sudo",
    });
    expect(serverToolsConfiguration("sudo")).toEqual({
      serverToolsUseRoot: true,
      serverToolsElevationMethod: "sudo",
    });
    expect(serverToolsConfiguration("su")).toEqual({
      serverToolsUseRoot: true,
      serverToolsElevationMethod: "su",
    });
  });
});

describe("Quick Connect credential templates", () => {
  const timestamp = "2026-08-14T00:00:00Z";

  it("fills password credentials into editable connection fields", () => {
    const credential: Credential = {
      id: "password-credential",
      label: "Production",
      username: "saved-user",
      kind: "password",
      password: "saved-password",
      elevationPassword: "saved-elevation-password",
      savesPassphrase: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const filled = quickConnectCredentialFields(credential);
    expect(filled).toEqual({
      username: "saved-user",
      authentication: "password",
      password: "saved-password",
      identityKey: "",
      publicKey: "",
      certificate: "",
      passphrase: "",
      elevationPassword: "saved-elevation-password",
    });

    expect(
      quickConnectConnectionFields({
        ...filled,
        username: "edited-user",
        password: "edited-password",
        identityFile: "",
      }),
    ).toEqual({
      username: "edited-user",
      authentication: "password",
      password: "edited-password",
    });
  });

  it("fills identity credentials and preserves subsequent user edits", () => {
    const credential: Credential = {
      id: "identity-credential",
      label: "Build key",
      username: "saved-user",
      kind: "identityKey",
      privateKey: "SAVED PRIVATE KEY",
      publicKey: "SAVED PUBLIC KEY",
      certificate: "SAVED CERTIFICATE",
      passphrase: "saved-passphrase",
      elevationPassword: "saved-elevation-password",
      savesPassphrase: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const filled = quickConnectCredentialFields(credential);

    expect(filled).toMatchObject({
      username: "saved-user",
      authentication: "identityFile",
      identityKey: "SAVED PRIVATE KEY",
      publicKey: "SAVED PUBLIC KEY",
      certificate: "SAVED CERTIFICATE",
      passphrase: "saved-passphrase",
    });

    const connection = quickConnectConnectionFields({
      ...filled,
      username: "edited-user",
      identityFile: "",
      identityKey: "EDITED PRIVATE KEY",
      passphrase: "edited-passphrase",
    });

    expect(connection).toEqual({
      username: "edited-user",
      authentication: "identityFile",
      identityFile: undefined,
      identityKey: "EDITED PRIVATE KEY",
      publicKey: "SAVED PUBLIC KEY",
      certificate: "SAVED CERTIFICATE",
      passphrase: "edited-passphrase",
    });
    expect(connection).not.toHaveProperty("credentialId");
  });
});
