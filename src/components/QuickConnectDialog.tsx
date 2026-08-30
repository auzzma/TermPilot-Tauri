import { open } from "@tauri-apps/plugin-dialog";
import { KeyRound, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { now, useAppStore } from "../store";
import type {
  AuthenticationMethod,
  Credential,
  Host,
} from "../types";
import { useTranslation } from "../i18n";
import { RevealablePasswordInput } from "./RevealablePasswordInput";

const QUICK_CONNECT_EVENT = "termpilot:quick-connect";
type ServerToolsMode = "disabled" | "sudo" | "su";

export function openQuickConnect(initialTarget = "") {
  window.dispatchEvent(
    new CustomEvent<string>(QUICK_CONNECT_EVENT, {
      detail: initialTarget,
    }),
  );
}

export function QuickConnectDialog() {
  const t = useTranslation();
  const credentials = useAppStore((state) => state.credentials);
  const connect = useAppStore((state) => state.openHostSession);
  const hostnameRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const [hostname, setHostname] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("22");
  const [credentialId, setCredentialId] = useState("");
  const [authentication, setAuthentication] =
    useState<AuthenticationMethod>("agent");
  const [password, setPassword] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [identityKey, setIdentityKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [certificate, setCertificate] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [serverToolsMode, setServerToolsMode] =
    useState<ServerToolsMode>("disabled");
  const [elevationPassword, setElevationPassword] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    const show = (event: Event) => {
      const initialTarget = (event as CustomEvent<string>).detail ?? "";
      setVisible(true);
      setError(undefined);
      setHostname(initialTarget);
      setUsername("");
      setPort("22");
      setCredentialId("");
      setAuthentication("agent");
      setPassword("");
      setIdentityFile("");
      setIdentityKey("");
      setPublicKey("");
      setCertificate("");
      setPassphrase("");
      setServerToolsMode("disabled");
      setElevationPassword("");
      if (initialTarget) {
        const target = parseQuickConnectTarget(initialTarget);
        if (target) {
          setHostname(target.hostname);
          setUsername(target.username);
          setPort(String(target.port));
        }
      }
      requestAnimationFrame(() => hostnameRef.current?.focus());
    };
    window.addEventListener(QUICK_CONNECT_EVENT, show);
    return () => window.removeEventListener(QUICK_CONNECT_EVENT, show);
  }, []);

  function close() {
    setVisible(false);
    setError(undefined);
  }

  function updateHostname(value: string) {
    setHostname(value);
    if (!value.toLowerCase().startsWith("ssh://") && !value.includes("@")) {
      return;
    }
    const target = parseQuickConnectTarget(value);
    if (!target) return;
    setHostname(target.hostname);
    if (!username.trim()) setUsername(target.username);
    setPort(String(target.port));
  }

  function selectCredential(nextCredentialId: string) {
    setCredentialId(nextCredentialId);
    const credential = credentials.find(
      (item) => item.id === nextCredentialId,
    );
    if (!credential) return;

    const fields = quickConnectCredentialFields(credential);
    setUsername(fields.username);
    setAuthentication(fields.authentication);
    setPassword(fields.password);
    setIdentityFile("");
    setIdentityKey(fields.identityKey);
    setPublicKey(fields.publicKey);
    setCertificate(fields.certificate);
    setPassphrase(fields.passphrase);
    setElevationPassword(fields.elevationPassword);
    setError(undefined);
  }

  async function submit() {
    const parsedPort = Number(port);
    const connectionFields = quickConnectConnectionFields({
      username,
      authentication,
      password,
      identityFile,
      identityKey,
      publicKey,
      certificate,
      passphrase,
    });
    const trimmedHostname = hostname.trim();
    if (!trimmedHostname || /\s/.test(trimmedHostname)) {
      setError(t("Enter a valid IP address or host name."));
      return;
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError(t("Port must be between 1 and 65535."));
      return;
    }
    if (!connectionFields.username) {
      setError(t("Username is required."));
      return;
    }
    if (
      connectionFields.authentication === "password" &&
      !connectionFields.password
    ) {
      setError(t("Password is required."));
      return;
    }
    if (
      connectionFields.authentication === "identityFile" &&
      !connectionFields.identityFile &&
      !connectionFields.identityKey
    ) {
      setError(t("Private key file or data is required."));
      return;
    }

    const timestamp = now();
    const host: Host = {
      id: await quickConnectHostId(
        connectionFields.username,
        trimmedHostname,
        parsedPort,
      ),
      label: trimmedHostname,
      hostname: trimmedHostname,
      port: parsedPort,
      ...connectionFields,
      sortOrder: 0,
      distroMode: "auto",
      iconMode: "auto",
      iconColorMode: "auto",
      sftpFileProtocol: "auto",
      sftpFilenameEncoding: "auto",
      sftpUsesSudo: false,
      sftpFollowsTerminalCwd: true,
      ...serverToolsConfiguration(serverToolsMode),
      elevationPassword: elevationPassword || undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    connect(host);
    close();
  }

  if (!visible) return null;

  return (
    <div
      className="modal-backdrop quick-connect-backdrop"
      role="presentation"
    >
      <form
        className="quick-connect-sheet"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <h2>{t("Quick Connect")}</h2>
        </header>

        <div className="quick-connect-form">
          <label className="quick-connect-row">
            <span className="quick-connect-label">{t("IP / Host")}</span>
            <input
              ref={hostnameRef}
              placeholder="10.0.0.1"
              value={hostname}
              onChange={(event) => updateHostname(event.target.value)}
            />
          </label>
          <div className="quick-connect-combined-row">
            <label className="quick-connect-row">
              <span className="quick-connect-label">{t("Username")}</span>
              <input
                placeholder="root"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label className="quick-connect-row quick-connect-port-row">
              <span className="quick-connect-label">{t("Port")}</span>
              <input
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
          </div>
          <label className="quick-connect-row">
            <span className="quick-connect-label">{t("Credential")}</span>
            <select
              value={credentialId}
              onChange={(event) => selectCredential(event.target.value)}
            >
              <option value="">{t("Custom Credential")}</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.label} [{t(
                    credential.kind === "password"
                      ? "Password"
                      : "Private key",
                  )}]
                </option>
              ))}
            </select>
          </label>

          {credentialId ? (
            <p className="quick-connect-help quick-connect-indented">
              <KeyRound size={13} />
              {t("Credential values were copied and can be edited.")}
            </p>
          ) : null}

          <div className="quick-connect-row">
            <span className="quick-connect-label">{t("Authentication")}</span>
            <fieldset className="quick-connect-auth">
              {(["agent", "password", "identityFile"] as const).map(
                (method) => (
                  <button
                    className={authentication === method ? "is-active" : ""}
                    key={method}
                    type="button"
                    onClick={() => setAuthentication(method)}
                  >
                    {t(
                      method === "agent"
                        ? "SSH Agent"
                        : method === "password"
                          ? "Password"
                          : "Private key",
                    )}
                  </button>
                ),
              )}
            </fieldset>
          </div>

          {authentication === "password" ? (
            <>
              <label className="quick-connect-row">
                <span className="quick-connect-label">{t("Password")}</span>
                <RevealablePasswordInput
                  value={password}
                  onChange={setPassword}
                />
              </label>
              <p className="quick-connect-help quick-connect-indented">
                {t("Used only for this connection and not saved.")}
              </p>
            </>
          ) : null}

          {authentication === "identityFile" ? (
            <>
              <label className="quick-connect-row">
                <span className="quick-connect-label">
                  {t("Private key file")}
                </span>
                <div>
                  <input
                    value={identityFile}
                    onChange={(event) => setIdentityFile(event.target.value)}
                  />
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      void open({
                        title: t("Choose SSH Private Key"),
                        multiple: false,
                        directory: false,
                      }).then((path) => {
                        if (typeof path === "string") setIdentityFile(path);
                      });
                    }}
                  >
                    {t("Choose...")}
                  </button>
                </div>
              </label>
              <label className="quick-connect-row quick-connect-textarea-row">
                <span className="quick-connect-label">
                  {t("Private key data")}
                </span>
                <textarea
                  rows={4}
                  value={identityKey}
                  onChange={(event) => setIdentityKey(event.target.value)}
                />
              </label>
              <label className="quick-connect-row">
                <span className="quick-connect-label">{t("Passphrase")}</span>
                <RevealablePasswordInput
                  value={passphrase}
                  onChange={setPassphrase}
                />
              </label>
              <label className="quick-connect-row quick-connect-textarea-row">
                <span className="quick-connect-label">{t("Certificate")}</span>
                <textarea
                  rows={2}
                  value={certificate}
                  onChange={(event) => setCertificate(event.target.value)}
                />
              </label>
              <label className="quick-connect-row quick-connect-textarea-row">
                <span className="quick-connect-label">{t("Public key")}</span>
                <textarea
                  rows={2}
                  value={publicKey}
                  onChange={(event) => setPublicKey(event.target.value)}
                />
              </label>
            </>
          ) : null}

          <section className="quick-server-tools is-wide">
            <header>
              <Server size={14} />
              <strong>{t("Server Tools")}</strong>
            </header>
            <div>
              <span>{t("Privilege Escalation")}</span>
              <select
                value={serverToolsMode}
                onChange={(event) =>
                  setServerToolsMode(
                    event.target.value as ServerToolsMode,
                  )
                }
              >
                <option value="disabled">{t("Disabled")}</option>
                <option value="sudo">sudo</option>
                <option value="su">su</option>
              </select>
            </div>
            {serverToolsMode !== "disabled" ? (
              <label className="quick-server-tools-password">
                <span>{t("Elevation Password")}</span>
                <RevealablePasswordInput
                  autoComplete="new-password"
                  value={elevationPassword}
                  onChange={setElevationPassword}
                />
                <small>
                  {t(
                    "Leave blank to use the login password when available.",
                  )}
                </small>
              </label>
            ) : null}
          </section>

          {error ? <p className="form-error quick-connect-indented">{error}</p> : null}
        </div>

        <footer>
          <button className="secondary-button" type="button" onClick={close}>
            {t("Cancel")}
          </button>
          <button className="primary-button" type="submit">
            {t("Connect")}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function serverToolsConfiguration(mode: ServerToolsMode) {
  return {
    serverToolsUseRoot: mode !== "disabled",
    serverToolsElevationMethod: mode === "su" ? "su" as const : "sudo" as const,
  };
}

export function quickConnectCredentialFields(credential: Credential) {
  return {
    username: credential.username,
    authentication:
      credential.kind === "identityKey"
        ? "identityFile" as const
        : "password" as const,
    password: credential.kind === "password"
      ? credential.password ?? ""
      : "",
    identityKey: credential.kind === "identityKey"
      ? credential.privateKey ?? ""
      : "",
    publicKey: credential.kind === "identityKey"
      ? credential.publicKey ?? ""
      : "",
    certificate: credential.kind === "identityKey"
      ? credential.certificate ?? ""
      : "",
    passphrase: credential.kind === "identityKey"
      ? credential.passphrase ?? ""
      : "",
    elevationPassword: credential.elevationPassword ?? "",
  };
}

export function quickConnectConnectionFields(draft: {
  username: string;
  authentication: AuthenticationMethod;
  password: string;
  identityFile: string;
  identityKey: string;
  publicKey: string;
  certificate: string;
  passphrase: string;
}) {
  const username = draft.username.trim();
  if (draft.authentication === "password") {
    return {
      username,
      authentication: draft.authentication,
      password: draft.password || undefined,
    };
  }
  if (draft.authentication === "identityFile") {
    return {
      username,
      authentication: draft.authentication,
      identityFile: draft.identityFile.trim() || undefined,
      identityKey: draft.identityKey.trim() ? draft.identityKey : undefined,
      publicKey: draft.publicKey.trim() ? draft.publicKey : undefined,
      certificate: draft.certificate.trim()
        ? draft.certificate
        : undefined,
      passphrase: draft.passphrase || undefined,
    };
  }
  return {
    username,
    authentication: draft.authentication,
  };
}

export function parseQuickConnectTarget(value: string) {
  const input = value.trim();
  if (!input) return undefined;
  try {
    if (input.toLowerCase().startsWith("ssh://")) {
      const url = new URL(input);
      const port = Number(url.port || 22);
      if (
        !url.username ||
        !url.hostname ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        return undefined;
      }
      return {
        username: decodeURIComponent(url.username),
        hostname: url.hostname,
        port,
      };
    }
  } catch {
    return undefined;
  }
  const separator = input.indexOf("@");
  if (separator <= 0) return undefined;
  const username = input.slice(0, separator).trim();
  const endpoint = input.slice(separator + 1);
  const ipv6 = endpoint.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) {
    const port = Number(ipv6[2] || 22);
    return validPort(port)
      ? { username, hostname: ipv6[1], port }
      : undefined;
  }
  const lastColon = endpoint.lastIndexOf(":");
  if (lastColon > 0 && endpoint.indexOf(":") === lastColon) {
    const port = Number(endpoint.slice(lastColon + 1));
    return validPort(port)
      ? {
          username,
          hostname: endpoint.slice(0, lastColon),
          port,
        }
      : undefined;
  }
  return endpoint && !/\s/.test(endpoint)
    ? { username, hostname: endpoint, port: 22 }
    : undefined;
}

export async function quickConnectHostId(
  username: string,
  hostname: string,
  port: number,
) {
  const seed = [
    username.trim(),
    hostname.trim().toLowerCase(),
    String(port),
  ].join("\u001f");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map((value) => value.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function validPort(port: number) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
