import { Fragment, useEffect, useRef, useState } from "react";
import { Check, KeyRound, X } from "lucide-react";

import { useTranslation } from "../i18n";
import { useAppStore } from "../store";
import type {
  SessionDescriptor,
  SessionLifecycle,
} from "../types";

export interface ConnectionProgressEntry {
  status: string;
  message: string;
  detail?: string;
}

export interface SSHHostKeyPrompt {
  hostPattern: string;
  algorithm: string;
  fingerprint: string;
  hasHostPattern: boolean;
}

export type ConnectionStageStatus =
  | "completed"
  | "active"
  | "pending"
  | "failed";

interface ConnectionProgressOverlayProps {
  session: Pick<SessionDescriptor, "id" | "lifecycle">;
  onCancel: () => void;
  onDismiss: () => void;
  onHostKeyResponse: (accepted: boolean) => Promise<void>;
}

const stageTitles = [
  "Establish Connection",
  "Authentication",
  "Open Channel",
  "Ready",
] as const;

export function ConnectionProgressOverlay({
  session,
  onCancel,
  onDismiss,
  onHostKeyResponse,
}: ConnectionProgressOverlayProps) {
  const t = useTranslation();
  const logRef = useRef<HTMLDivElement>(null);
  const [respondingToHostKey, setRespondingToHostKey] = useState(false);
  const entries = useAppStore(
    (state) => state.connectionLogs[session.id] ?? [],
  );
  const visibleEntries = entries.slice(-120);
  const hostKeyPrompt = activeHostKeyPrompt(visibleEntries);
  const currentStage = connectionStageIndex(
    session.lifecycle,
    visibleEntries,
  );

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [visibleEntries.length]);

  useEffect(() => {
    setRespondingToHostKey(false);
  }, [hostKeyPrompt?.fingerprint]);

  async function respondToHostKey(accepted: boolean) {
    setRespondingToHostKey(true);
    try {
      await onHostKeyResponse(accepted);
    } catch {
      setRespondingToHostKey(false);
    }
  }

  return (
    <div className="connection-progress-overlay">
      <section
        aria-label={t(
          hostKeyPrompt
            ? "SSH Fingerprint Confirmation"
            : "SSH Connecting...",
        )}
        className="connection-progress-panel"
        role="dialog"
      >
        <header className="connection-progress-header">
          <span className="connection-progress-header-icon">
            {hostKeyPrompt ? (
              <KeyRound size={14} strokeWidth={2.2} />
            ) : (
              <span className="connection-progress-spinner" />
            )}
          </span>
          <h2>
            {t(
              hostKeyPrompt
                ? "SSH Fingerprint Confirmation"
                : "SSH Connecting...",
            )}
          </h2>
          <button
            aria-label={t("Close")}
            type="button"
            onClick={onDismiss}
          >
            <X size={15} strokeWidth={2.4} />
          </button>
        </header>

        <div className="connection-progress-stages">
          {stageTitles.map((title, index) => {
            const status = connectionStageStatus(
              index,
              currentStage,
              session.lifecycle,
            );
            return (
              <Fragment key={title}>
                <div
                  className={`connection-progress-stage is-${status}`}
                >
                  <span className="connection-progress-stage-circle">
                    {status === "completed" ? (
                      <Check size={13} strokeWidth={3} />
                    ) : null}
                    {status === "active" ? (
                      <span className="pulsing-circle" style={{ width: '100%', height: '100%', borderRadius: '50%', backgroundColor: 'currentColor' }} />
                    ) : null}
                    {status === "failed" ? (
                      <X size={12} strokeWidth={3} />
                    ) : null}
                    {status === "pending" ? index + 1 : null}
                  </span>
                  <strong>{t(title)}</strong>
                </div>
                {index < stageTitles.length - 1 ? (
                  <span
                    className={`connection-progress-connector ${
                      index < currentStage
                        ? "is-completed"
                        : index === currentStage
                          ? "is-active"
                          : ""
                    }`}
                  />
                ) : null}
              </Fragment>
            );
          })}
        </div>

        {hostKeyPrompt ? (
          <div className="connection-host-key-card">
            <header>
              <KeyRound size={14} strokeWidth={2.2} />
              <strong>{t("SSH Fingerprint Confirmation")}</strong>
            </header>
            <p>
              {t(
                hostKeyPrompt.hasHostPattern
                  ? "The stored SSH fingerprint for this host is different. Only accept it if you trust this change."
                  : "This is the first time connecting to this host. Confirm the SSH fingerprint before continuing.",
              )}
            </p>
            <dl>
              <div>
                <dt>{t("Host")}</dt>
                <dd>{hostKeyPrompt.hostPattern}</dd>
              </div>
              <div>
                <dt>{t("Algorithm")}</dt>
                <dd>{hostKeyPrompt.algorithm}</dd>
              </div>
              <div>
                <dt>{t("Fingerprint")}</dt>
                <dd>{hostKeyPrompt.fingerprint}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        <div className="connection-progress-divider" />

        <div className="connection-progress-console">
          <header>
            <span>&gt;_</span>
            <strong>{t("Connection log")}</strong>
          </header>
          <div ref={logRef}>
            {visibleEntries.length === 0 ? (
              <p className="is-muted">
                {t("No connection events yet.")}
              </p>
            ) : (
              visibleEntries.map((entry) => (
                <p
                  className={`is-${connectionLogTone(entry)}`}
                  key={entry.id}
                >
                  {entry.message}
                  {entry.detail ? ` ${entry.detail}` : ""}
                </p>
              ))
            )}
          </div>
        </div>

        <div className="connection-progress-divider" />

        <footer>
          {hostKeyPrompt ? (
            <>
              <button
                className="is-secondary"
                disabled={respondingToHostKey}
                type="button"
                onClick={() => void respondToHostKey(false)}
              >
                {t("Reject")}
              </button>
              <button
                className="is-primary"
                disabled={respondingToHostKey}
                type="button"
                onClick={() => void respondToHostKey(true)}
              >
                {t("Accept Fingerprint")}
              </button>
            </>
          ) : (
            <button className="is-cancel" type="button" onClick={onCancel}>
              {t("Cancel Connection")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

export function activeHostKeyPrompt(
  entries: ConnectionProgressEntry[],
): SSHHostKeyPrompt | undefined {
  const entry = entries.at(-1);
  if (entry?.status !== "host-key-prompt" || !entry.detail) {
    return undefined;
  }
  try {
    const detail = JSON.parse(entry.detail) as Partial<SSHHostKeyPrompt>;
    if (
      typeof detail.hostPattern !== "string" ||
      typeof detail.algorithm !== "string" ||
      typeof detail.fingerprint !== "string"
    ) {
      return undefined;
    }
    return {
      hostPattern: detail.hostPattern,
      algorithm: detail.algorithm,
      fingerprint: detail.fingerprint,
      hasHostPattern: detail.hasHostPattern === true,
    };
  } catch {
    return undefined;
  }
}

export function connectionStageIndex(
  lifecycle: SessionLifecycle,
  entries: ConnectionProgressEntry[],
) {
  if (lifecycle === "connected") return 3;
  let stage = 0;
  for (const entry of entries) {
    const status = entry.status.toLowerCase();
    const message = entry.message.toLowerCase();
    if (
      status === "connected" ||
      message.includes("interactive shell channel established")
    ) {
      stage = Math.max(stage, 3);
    } else if (
      status === "shell" ||
      message.includes("opening interactive shell") ||
      message.includes("open shell")
    ) {
      stage = Math.max(stage, 2);
    } else if (
      ["auth", "debug", "known-host", "host-key-prompt"].includes(status) ||
      message.includes("authentication") ||
      message.includes("keyboard-interactive") ||
      message.includes("identity") ||
      message.includes("host key")
    ) {
      stage = Math.max(stage, 1);
    }
  }
  return stage;
}

export function connectionStageStatus(
  index: number,
  current: number,
  lifecycle: SessionLifecycle,
): ConnectionStageStatus {
  if (lifecycle === "connected") return "completed";
  if (index < current) return "completed";
  if (index > current) return "pending";
  return lifecycle === "failed" ? "failed" : "active";
}

export function connectionLogTone(entry: ConnectionProgressEntry) {
  const value = `${entry.status} ${entry.message}`.toLowerCase();
  if (
    value.includes("error") ||
    value.includes("failed") ||
    value.includes("exit")
  ) {
    return "error";
  }
  if (
    value.includes("connected") ||
    value.includes("completed") ||
    value.includes("established")
  ) {
    return "success";
  }
  if (
    value.includes("auth") ||
    value.includes("host-key") ||
    value.includes("host key") ||
    value.includes("shell") ||
    value.includes("debug") ||
    value.includes("init")
  ) {
    return "active";
  }
  return "default";
}
