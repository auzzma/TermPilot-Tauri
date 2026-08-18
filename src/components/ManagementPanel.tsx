import {
  BookOpen,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  CornerDownRight,
  Folder,
  FileText,
  HardDrive,
  Info,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Upload,
  Waypoints,
  WandSparkles,
  X,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useState,
} from "react";

import { id, now, resolveHostConnection, useAppStore } from "../store";
import { api } from "../api";
import {
  authorizedKeyInstallCommand,
  hasCompleteKeyPair,
  hostForCredentialVerification,
  hostLinkedToCredential,
} from "../credentialKeys";
import { useTranslation } from "../i18n";
import packageMetadata from "../../package.json";
import {
  batchSelectionState,
  buildHostGroupTree,
  hostIdsInGroup,
} from "./Sidebar";
import type { NavigationSection } from "../store";
import type {
  AppPreferences,
  AutomationScript,
  Credential,
  Host,
  HostGroup,
  HostNote,
  PortForwardRule,
  ProxyProfile,
  Snippet,
  SSHKeyGenerationRequest,
} from "../types";

export const managementSectionIds = [
  "settings",
  "credentials",
  "proxies",
  "groups",
  "knownHosts",
  "forwards",
  "scripts",
  "notes",
  "backup",
  "about",
] as const;

type ManagementSection = (typeof managementSectionIds)[number];

export function managementSection(
  navigation: NavigationSection,
): ManagementSection {
  return managementSectionIds.includes(navigation as ManagementSection)
    ? (navigation as ManagementSection)
    : "settings";
}

export function ManagementPanel() {
  const t = useTranslation();
  const navigation = useAppStore((state) => state.navigation);
  const setNavigation = useAppStore((state) => state.setNavigation);
  const section = managementSection(navigation);

  let content: React.ReactNode;
  switch (section) {
    case "credentials":
      content = <CredentialPanel />;
      break;
    case "proxies":
      content = <ProxyPanel />;
      break;
    case "groups":
      content = <GroupPanel />;
      break;
    case "knownHosts":
      content = <KnownHostsPanel />;
      break;
    case "forwards":
      content = <ForwardPanel />;
      break;
    case "scripts":
      content = <ScriptPanel />;
      break;
    case "notes":
      content = <NotesPanel />;
      break;
    case "backup":
      content = <BackupPanel />;
      break;
    case "about":
      content = <AboutPanel />;
      break;
    case "settings":
    default:
      content = <SettingsPanel />;
      break;
  }

  const sections = [
    { id: "settings" as const, label: "General", icon: <Settings size={13} /> },
    { id: "credentials" as const, label: "Credentials", icon: <KeyRound size={13} /> },
    { id: "proxies" as const, label: "Proxies", icon: <Network size={13} /> },
    { id: "groups" as const, label: "Groups", icon: <Folder size={13} /> },
    { id: "knownHosts" as const, label: "Known Hosts", icon: <ShieldCheck size={13} /> },
    { id: "forwards" as const, label: "Forwarding", icon: <Waypoints size={13} /> },
    { id: "scripts" as const, label: "Scripts", icon: <Braces size={13} /> },
    { id: "notes" as const, label: "Notes", icon: <BookOpen size={13} /> },
    { id: "backup" as const, label: "Backup", icon: <HardDrive size={13} /> },
  ];
  const aboutSection = {
    id: "about" as const,
    label: "About",
    icon: <Info size={13} />,
  };

  return (
    <section className="settings-surface">
      <aside className="settings-sidebar">
        <h2><Settings size={14} />{t("Settings")}</h2>
        {sections.map((item) => (
          <button
            className={section === item.id ? "is-active" : ""}
            key={item.id}
            type="button"
            onClick={() => setNavigation(item.id)}
          >
            {item.icon}
            <span>{t(item.label)}</span>
          </button>
        ))}
        <button
          className={`settings-about-entry ${
            section === aboutSection.id ? "is-active" : ""
          }`}
          type="button"
          onClick={() => setNavigation(aboutSection.id)}
        >
          {aboutSection.icon}
          <span>{t(aboutSection.label)}</span>
        </button>
      </aside>
      <div className="settings-detail">{content}</div>
    </section>
  );
}

function AboutPanel() {
  const t = useTranslation();
  const [version, setVersion] = useState(packageMetadata.version);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => undefined);
  }, []);

  return (
    <section className="settings-about" aria-labelledby="settings-about-title">
      <div className="settings-about-content">
        <div className="settings-about-mark" aria-hidden="true">
          <SquareTerminal size={44} strokeWidth={1.7} />
        </div>
        <h2 id="settings-about-title">TermPilot</h2>
        <p>{t("Version {version}").replace("{version}", version)}</p>
        <p className="settings-about-contributors">
          {t("TermPilot contributors.")}
        </p>
      </div>
    </section>
  );
}

function CredentialPanel() {
  const t = useTranslation();
  const items = useAppStore((state) => state.credentials);
  const hosts = useAppStore((state) => state.hosts);
  const groups = useAppStore((state) => state.groups);
  const proxies = useAppStore((state) => state.proxies);
  const save = useAppStore((state) => state.saveCredential);
  const saveHost = useAppStore((state) => state.saveHost);
  const remove = useAppStore((state) => state.deleteCredential);
  const [draft, setDraft] = useState<Credential>(() => newCredential());
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState<Credential>();
  const [deleting, setDeleting] = useState<{
    credential: Credential;
    closeEditor?: () => void;
  }>();
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  }>();

  return (
    <>
      <ManagementLayout
        icon={<KeyRound size={18} />}
        title="Credentials"
        description="Reusable encrypted SSH passwords and private keys."
        items={items}
        selectedId={draft.id}
        itemLabel={(item) => item.label}
        itemDetail={(item) => `${item.username} · ${item.kind}`}
        itemAction={(item, controls) => (
          <div className="credential-row-actions">
            {hasCompleteKeyPair(item) ? (
              <button
                className="credential-row-action"
                title={t("Export to Hosts")}
                type="button"
                onClick={() => setExporting(item)}
              >
                <Upload size={13} />
                <span>{t("Export to Hosts")}</span>
              </button>
            ) : null}
            <button
              className="credential-row-action"
              title={t("Edit")}
              type="button"
              onClick={controls.edit}
            >
              <Pencil size={13} />
              <span>{t("Edit")}</span>
            </button>
            <button
              className="credential-row-action is-danger"
              title={t("Delete")}
              type="button"
              onClick={() =>
                setDeleting({
                  credential: item,
                  closeEditor: controls.closeEditor,
                })
              }
            >
              <Trash2 size={13} />
              <span>{t("Delete")}</span>
            </button>
          </div>
        )}
        onSelect={(item) => setDraft(item)}
        onNew={() => setDraft(newCredential())}
        onCreate={() => setCreating(true)}
      >
        <EditorForm
          title={draft.label || "New credential"}
          onSave={() => {
            void save(draft).catch((reason) =>
              setFeedback({ kind: "error", message: errorMessage(reason) }),
            );
          }}
          onDelete={
            items.some((item) => item.id === draft.id)
              ? () => setDeleting({ credential: draft })
              : undefined
          }
        >
          <Field label="Label">
            <input
              value={draft.label}
              onChange={(event) =>
                setDraft({ ...draft, label: event.target.value })
              }
            />
          </Field>
          <Field label="Username">
            <input
              value={draft.username}
              onChange={(event) =>
                setDraft({ ...draft, username: event.target.value })
              }
            />
          </Field>
          <Field label="Kind">
            <select
              value={draft.kind}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  kind: event.target.value as Credential["kind"],
                })
              }
            >
              <option value="password"><Translated value="Password" /></option>
              <option value="identityKey"><Translated value="Private key" /></option>
            </select>
          </Field>
          {draft.kind === "password" ? (
            <Field label="Password">
              <input
                type="password"
                value={draft.password ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, password: event.target.value })
                }
              />
            </Field>
          ) : (
            <>
              <Field label="Private key" wide>
                <textarea
                  rows={10}
                  value={draft.privateKey ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, privateKey: event.target.value })
                  }
                />
              </Field>
              <Field label="Public key" wide>
                <textarea
                  rows={3}
                  value={draft.publicKey ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, publicKey: event.target.value })
                  }
                />
              </Field>
              <Field label="Certificate" wide>
                <textarea
                  rows={3}
                  value={draft.certificate ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, certificate: event.target.value })
                  }
                />
              </Field>
              <Field label="Passphrase">
                <input
                  type="password"
                  value={draft.passphrase ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, passphrase: event.target.value })
                  }
                />
              </Field>
              <label className="check-field">
                <input
                  checked={draft.savesPassphrase}
                  type="checkbox"
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      savesPassphrase: event.target.checked,
                    })
                  }
                />
                <Translated value="Save passphrase" />
              </label>
            </>
          )}
          <Field label="Elevation password">
            <input
              type="password"
              value={draft.elevationPassword ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  elevationPassword: event.target.value,
                })
              }
            />
          </Field>
        </EditorForm>
      </ManagementLayout>
      {creating ? (
        <CredentialCreationDialog
          onClose={() => setCreating(false)}
          onCreate={async (credential) => {
            await save(credential);
            setDraft(credential);
            setFeedback({
              kind: "success",
              message: t("Credential created successfully."),
            });
          }}
        />
      ) : null}
      {exporting ? (
        <CredentialExportDialog
          credential={exporting}
          credentials={items}
          groups={groups}
          hosts={hosts}
          proxies={proxies}
          onClose={() => setExporting(undefined)}
          onSaveHost={saveHost}
          onComplete={(succeeded, failed) => {
            setFeedback({
              kind: failed === 0 ? "success" : "error",
              message:
                failed === 0
                  ? t("Public key exported to {count} hosts.").replace(
                      "{count}",
                      String(succeeded),
                    )
                  : t("{succeeded} hosts succeeded; {failed} hosts failed.")
                      .replace("{succeeded}", String(succeeded))
                      .replace("{failed}", String(failed)),
            });
          }}
        />
      ) : null}
      {deleting ? (
        <CredentialDeleteDialog
          affectedHosts={hosts.filter(
            (host) => host.credentialId === deleting.credential.id,
          )}
          credential={deleting.credential}
          onCancel={() => setDeleting(undefined)}
          onConfirm={async () => {
            try {
              await remove(deleting.credential.id);
              if (draft.id === deleting.credential.id) {
                setDraft(newCredential());
              }
              deleting.closeEditor?.();
              setDeleting(undefined);
              setFeedback({
                kind: "success",
                message: t("Credential deleted."),
              });
            } catch (reason) {
              setFeedback({
                kind: "error",
                message: errorMessage(reason),
              });
              throw reason;
            }
          }}
        />
      ) : null}
      {feedback ? (
        <div
          className={`credential-feedback is-${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.kind === "success" ? (
            <CheckCircle2 size={15} />
          ) : (
            <CircleAlert size={15} />
          )}
          <span>{feedback.message}</span>
          <button
            aria-label={t("Close")}
            className="icon-button"
            type="button"
            onClick={() => setFeedback(undefined)}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
    </>
  );
}

function CredentialDeleteDialog({
  credential,
  affectedHosts,
  onCancel,
  onConfirm,
}: {
  credential: Credential;
  affectedHosts: Host[];
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslation();
  const [working, setWorking] = useState(false);
  return (
    <div className="backup-dialog-backdrop">
      <section
        aria-labelledby="delete-credential-title"
        aria-modal="true"
        className="backup-dialog credential-delete-dialog"
        role="alertdialog"
      >
        <header>
          <Trash2 size={22} />
          <div>
            <h3 id="delete-credential-title">{t("Delete Credential")}</h3>
            <p>{credential.label}</p>
          </div>
        </header>
        <p>
          {t(
            "Deleting this credential will remove it from {count} saved hosts. Those hosts may require new login credentials.",
          ).replace("{count}", String(affectedHosts.length))}
        </p>
        {affectedHosts.length > 0 ? (
          <div className="credential-delete-hosts">
            <strong>{t("Affected Hosts")}</strong>
            <div>
              {affectedHosts.map((host) => (
                <article key={host.id}>
                  <HardDrive size={14} />
                  <span>
                    <strong>{host.label}</strong>
                    <small>
                      {host.username}@{host.hostname}:{host.port}
                    </small>
                  </span>
                </article>
              ))}
            </div>
          </div>
        ) : null}
        <footer>
          <button
            className="secondary-button"
            disabled={working}
            type="button"
            onClick={onCancel}
          >
            {t("Cancel")}
          </button>
          <button
            className="danger-button"
            disabled={working}
            type="button"
            onClick={() => {
              setWorking(true);
              void onConfirm().catch(() => setWorking(false));
            }}
          >
            {t("Delete")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function CredentialCreationDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (credential: Credential) => Promise<void>;
}) {
  const t = useTranslation();
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [keyType, setKeyType] =
    useState<SSHKeyGenerationRequest["keyType"]>("ed25519");
  const [ecdsaBits, setEcdsaBits] = useState<256 | 384 | 521>(256);
  const [rsaBits, setRsaBits] = useState<1024 | 2048 | 4096>(4096);
  const [protectsKey, setProtectsKey] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    const trimmedLabel = label.trim();
    const trimmedUsername = username.trim();
    if (!trimmedLabel || !trimmedUsername) {
      setError(t("Credential label and username are required."));
      return;
    }
    if (protectsKey && !passphrase) {
      setError(t("Enter a passphrase or turn off passphrase protection."));
      return;
    }
    if (protectsKey && passphrase !== confirmPassphrase) {
      setError(t("Passphrases do not match."));
      return;
    }
    setWorking(true);
    setError("");
    try {
      const request: SSHKeyGenerationRequest = {
        keyType,
        bits:
          keyType === "ecdsa"
            ? ecdsaBits
            : keyType === "rsa"
              ? rsaBits
              : undefined,
        passphrase: protectsKey ? passphrase : undefined,
        comment: trimmedLabel,
      };
      const pair = await api.generateCredentialKey(request);
      const timestamp = now();
      await onCreate({
        id: id(),
        label: trimmedLabel,
        username: trimmedUsername,
        kind: "identityKey",
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
        passphrase: protectsKey ? passphrase : undefined,
        savesPassphrase: protectsKey,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="credential-dialog-backdrop">
      <section
        aria-labelledby="credential-create-title"
        aria-modal="true"
        className="credential-dialog"
        role="dialog"
      >
        <header>
          <WandSparkles size={17} />
          <div>
            <h3 id="credential-create-title">{t("Create Credential")}</h3>
            <p>{t("Generate a new SSH key pair.")}</p>
          </div>
          <button
            aria-label={t("Close")}
            className="icon-button"
            disabled={working}
            type="button"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>
        <div className="credential-dialog-body">
          <div className="credential-dialog-grid">
            <Field label="Label">
              <input
                autoFocus
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <Field label="Username">
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>
          </div>
          <div className="credential-dialog-section">
            <span>{t("Key Type")}</span>
            <div className="credential-key-type">
              {(["ed25519", "ecdsa", "rsa"] as const).map((type) => (
                <button
                  className={keyType === type ? "is-active" : ""}
                  key={type}
                  type="button"
                  onClick={() => setKeyType(type)}
                >
                  {type.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {keyType === "ecdsa" ? (
            <Field label="Curve">
              <select
                value={ecdsaBits}
                onChange={(event) =>
                  setEcdsaBits(Number(event.target.value) as 256 | 384 | 521)
                }
              >
                <option value={256}>P-256</option>
                <option value={384}>P-384</option>
                <option value={521}>P-521</option>
              </select>
            </Field>
          ) : null}
          {keyType === "rsa" ? (
            <Field label="Key Size">
              <select
                value={rsaBits}
                onChange={(event) =>
                  setRsaBits(
                    Number(event.target.value) as 1024 | 2048 | 4096,
                  )
                }
              >
                <option value={4096}>4096 bits</option>
                <option value={2048}>2048 bits</option>
                <option value={1024}>1024 bits</option>
              </select>
            </Field>
          ) : null}
          <Toggle
            label="Protect with passphrase"
            checked={protectsKey}
            onChange={(value) => {
              setProtectsKey(value);
              if (!value) {
                setPassphrase("");
                setConfirmPassphrase("");
              }
            }}
          />
          {protectsKey ? (
            <div className="credential-dialog-grid">
              <Field label="Passphrase">
                <input
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </Field>
              <Field label="Confirm Passphrase">
                <input
                  type="password"
                  value={confirmPassphrase}
                  onChange={(event) =>
                    setConfirmPassphrase(event.target.value)
                  }
                />
              </Field>
            </div>
          ) : null}
          {error ? <p className="credential-dialog-error">{error}</p> : null}
        </div>
        <footer>
          <button
            className="secondary-button"
            disabled={working}
            type="button"
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
          <button
            className="primary-button"
            disabled={working}
            type="button"
            onClick={() => void create()}
          >
            {working ? (
              <LoaderCircle className="is-spinning" size={14} />
            ) : (
              <WandSparkles size={14} />
            )}
            {working ? t("Generating...") : t("Create Credential")}
          </button>
        </footer>
      </section>
    </div>
  );
}

type CredentialExportStatus =
  | { state: "working" }
  | { state: "success" }
  | { state: "error"; message: string };

function CredentialExportDialog({
  credential,
  credentials,
  groups,
  hosts,
  proxies,
  onClose,
  onSaveHost,
  onComplete,
}: {
  credential: Credential;
  credentials: Credential[];
  groups: HostGroup[];
  hosts: Host[];
  proxies: ProxyProfile[];
  onClose: () => void;
  onSaveHost: (host: Host) => Promise<void>;
  onComplete: (succeeded: number, failed: number) => void;
}) {
  const t = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    new Set(),
  );
  const [statuses, setStatuses] = useState<
    Record<string, CredentialExportStatus>
  >({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  async function exportSelected() {
    if (selected.size === 0) {
      setError(t("Select at least one host."));
      return;
    }
    setWorking(true);
    setError("");
    let succeeded = 0;
    let failed = 0;
    for (const host of hosts.filter((item) => selected.has(item.id))) {
      setStatuses((current) => ({
        ...current,
        [host.id]: { state: "working" },
      }));
      try {
        const publicKey = credential.publicKey ?? "";
        const resolved = resolveHostConnection(
          { credentials, proxies },
          host,
        );
        const result = await invoke<{
          stdout: string;
          stderr: string;
          code?: number;
        }>("sftp_request", {
          host: resolved,
          sourceSessionId: null,
          idleSeconds: 0,
          request: {
            action: "exec",
            command: authorizedKeyInstallCommand(publicKey),
            timeoutMS: 30_000,
          },
        });
        await invoke<void>("sftp_close", {
          hostId: host.id,
          sourceSessionId: null,
        });
        if (result.code && result.code !== 0) {
          throw new Error(
            result.stderr || t("Remote key installation failed."),
          );
        }
        const verification = await invoke<{
          stdout: string;
          stderr: string;
          code?: number;
        }>("sftp_request", {
          host: hostForCredentialVerification(host, credential),
          sourceSessionId: null,
          idleSeconds: 0,
          request: {
            action: "exec",
            command: "true",
            timeoutMS: 20_000,
          },
        }).catch(() => {
          throw new Error(
            t(
              "The public key was installed, but the server rejected key authentication. The host's original login configuration was preserved.",
            ),
          );
        });
        await invoke<void>("sftp_close", {
          hostId: host.id,
          sourceSessionId: null,
        });
        if (verification.code && verification.code !== 0) {
          throw new Error(
            t(
              "The public key was installed, but the server rejected key authentication. The host's original login configuration was preserved.",
            ),
          );
        }
        await onSaveHost(hostLinkedToCredential(host, credential));
        succeeded += 1;
        setStatuses((current) => ({
          ...current,
          [host.id]: { state: "success" },
        }));
      } catch (reason) {
        await invoke<void>("sftp_close", {
          hostId: host.id,
          sourceSessionId: null,
        }).catch(() => undefined);
        failed += 1;
        setStatuses((current) => ({
          ...current,
          [host.id]: { state: "error", message: errorMessage(reason) },
        }));
      }
    }
    setWorking(false);
    onComplete(succeeded, failed);
  }

  const groupTree = buildHostGroupTree(groups);
  const validGroupIds = new Set(groups.map((group) => group.id));
  const ungroupedHosts = hosts.filter(
    (host) => !host.groupId || !validGroupIds.has(host.groupId),
  );

  function toggleExpanded(groupId: string) {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function toggleHostIds(hostIds: Set<string>) {
    setSelected((current) => {
      const next = new Set(current);
      const selectsAll = [...hostIds].some((id) => !next.has(id));
      hostIds.forEach((id) => {
        if (selectsAll) next.add(id);
        else next.delete(id);
      });
      return next;
    });
  }

  function renderHost(host: Host, depth: number) {
    const status = statuses[host.id];
    return (
      <label
        className="credential-host-row"
        key={host.id}
        style={{ paddingLeft: 9 + depth * 18 }}
      >
        <input
          checked={selected.has(host.id)}
          disabled={working}
          type="checkbox"
          onChange={(event) =>
            setSelected((current) => {
              const next = new Set(current);
              if (event.target.checked) next.add(host.id);
              else next.delete(host.id);
              return next;
            })
          }
        />
        <span>
          <strong>{host.label}</strong>
          <small>
            {host.username}@{host.hostname}:{host.port}
          </small>
          {status?.state === "error" ? <em>{status.message}</em> : null}
        </span>
        {status?.state === "working" ? (
          <LoaderCircle className="is-spinning" size={15} />
        ) : status?.state === "success" ? (
          <CheckCircle2 className="success-text" size={15} />
        ) : status?.state === "error" ? (
          <CircleAlert className="danger-text" size={15} />
        ) : null}
      </label>
    );
  }

  function renderGroup(
    node: ReturnType<typeof buildHostGroupTree>[number],
    depth: number,
  ): React.ReactNode {
    const directHosts = hosts.filter(
      (host) => host.groupId === node.group.id,
    );
    const groupedHostIds = hostIdsInGroup(groups, hosts, node.group.id);
    const selectionState = batchSelectionState(groupedHostIds, selected);
    const expanded = expandedGroupIds.has(node.group.id);
    const canExpand = directHosts.length > 0 || node.children.length > 0;
    return (
      <div className="credential-host-group" key={node.group.id}>
        <div
          className="credential-host-group-row"
          style={{ paddingLeft: 7 + depth * 18 }}
        >
          <button
            aria-expanded={expanded}
            aria-label={t(expanded ? "Collapse" : "Expand")}
            className="credential-host-disclosure"
            disabled={!canExpand}
            type="button"
            onClick={() => toggleExpanded(node.group.id)}
          >
            {expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </button>
          <input
            aria-label={`${t("Group")} ${node.group.name}`}
            checked={selectionState === "all"}
            disabled={working || groupedHostIds.size === 0}
            ref={(input) => {
              if (input) input.indeterminate = selectionState === "partial";
            }}
            type="checkbox"
            onChange={() => toggleHostIds(groupedHostIds)}
          />
          <Folder size={14} />
          <span>
            <strong>{node.group.name}</strong>
            <small>{groupedHostIds.size}</small>
          </span>
        </div>
        {expanded ? (
          <div className="credential-host-group-children">
            {directHosts.map((host) => renderHost(host, depth + 1))}
            {node.children.map((child) => renderGroup(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderUngrouped() {
    if (ungroupedHosts.length === 0) return null;
    const groupId = "__ungrouped__";
    const hostIds = new Set(ungroupedHosts.map((host) => host.id));
    const selectionState = batchSelectionState(hostIds, selected);
    const expanded = expandedGroupIds.has(groupId);
    return (
      <div className="credential-host-group" key={groupId}>
        <div className="credential-host-group-row">
          <button
            aria-expanded={expanded}
            aria-label={t(expanded ? "Collapse" : "Expand")}
            className="credential-host-disclosure"
            type="button"
            onClick={() => toggleExpanded(groupId)}
          >
            {expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </button>
          <input
            aria-label={t("No Group")}
            checked={selectionState === "all"}
            disabled={working}
            ref={(input) => {
              if (input) input.indeterminate = selectionState === "partial";
            }}
            type="checkbox"
            onChange={() => toggleHostIds(hostIds)}
          />
          <Folder size={14} />
          <span>
            <strong>{t("No Group")}</strong>
            <small>{hostIds.size}</small>
          </span>
        </div>
        {expanded ? (
          <div className="credential-host-group-children">
            {ungroupedHosts.map((host) => renderHost(host, 1))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="credential-dialog-backdrop">
      <section
        aria-labelledby="credential-export-title"
        aria-modal="true"
        className="credential-dialog credential-export-dialog"
        role="dialog"
      >
        <header>
          <Upload size={17} />
          <div>
            <h3 id="credential-export-title">{t("Export to Hosts")}</h3>
            <p>{credential.label}</p>
          </div>
          <button
            aria-label={t("Close")}
            className="icon-button"
            disabled={working}
            type="button"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>
        <div className="credential-dialog-body">
          {hosts.length === 0 ? (
            <p className="credential-empty-hosts">{t("No saved hosts.")}</p>
          ) : (
            <>
              <div className="credential-host-selection-actions">
                <button
                  className="secondary-button"
                  disabled={working}
                  type="button"
                  onClick={() =>
                    setSelected(new Set(hosts.map((host) => host.id)))
                  }
                >
                  {t("Select All")}
                </button>
                <button
                  className="secondary-button"
                  disabled={working || selected.size === 0}
                  type="button"
                  onClick={() => setSelected(new Set())}
                >
                  {t("Clear")}
                </button>
                <span>
                  {t("{count} selected").replace(
                    "{count}",
                    String(selected.size),
                  )}
                </span>
              </div>
              <div className="credential-host-list">
                {groupTree.map((node) => renderGroup(node, 0))}
                {renderUngrouped()}
              </div>
            </>
          )}
          {error ? <p className="credential-dialog-error">{error}</p> : null}
        </div>
        <footer>
          <button
            className="secondary-button"
            disabled={working}
            type="button"
            onClick={onClose}
          >
            {t("Close")}
          </button>
          <button
            className="primary-button"
            disabled={working || hosts.length === 0}
            type="button"
            onClick={() => void exportSelected()}
          >
            {working ? (
              <LoaderCircle className="is-spinning" size={14} />
            ) : (
              <Upload size={14} />
            )}
            {working ? t("Exporting...") : t("Export")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ProxyPanel() {
  const items = useAppStore((state) => state.proxies);
  const save = useAppStore((state) => state.saveProxy);
  const remove = useAppStore((state) => state.deleteProxy);
  const [draft, setDraft] = useState<ProxyProfile>(() => newProxy());
  return (
    <ManagementLayout
      icon={<Network size={18} />}
      title="Proxy profiles"
      description="HTTP, SOCKS5, and ProxyCommand routes shared by hosts."
      items={items}
      selectedId={draft.id}
      itemLabel={(item) => item.label}
      itemDetail={(item) =>
        item.configuration.type === "command"
          ? "ProxyCommand"
          : `${item.configuration.host}:${item.configuration.port}`
      }
      onSelect={setDraft}
      onNew={() => setDraft(newProxy())}
    >
      <EditorForm
        title={draft.label || "New proxy"}
        onSave={() => void save(draft)}
        onDelete={
          items.some((item) => item.id === draft.id)
            ? () => void remove(draft.id).then(() => setDraft(newProxy()))
            : undefined
        }
      >
        <Field label="Name">
          <input
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        </Field>
        <Field label="Type">
          <select
            value={draft.configuration.type}
            onChange={(event) =>
              setDraft({
                ...draft,
                configuration: {
                  ...draft.configuration,
                  type: event.target.value as ProxyProfile["configuration"]["type"],
                },
              })
            }
          >
            <option value="http"><Translated value="HTTP" /></option>
            <option value="socks5"><Translated value="SOCKS5" /></option>
            <option value="command"><Translated value="ProxyCommand" /></option>
          </select>
        </Field>
        {draft.configuration.type === "command" ? (
          <Field label="Command" wide>
            <textarea
              rows={5}
              value={draft.configuration.command ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  configuration: {
                    ...draft.configuration,
                    command: event.target.value,
                  },
                })
              }
            />
          </Field>
        ) : (
          <>
            <Field label="Host">
              <input
                value={draft.configuration.host}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    configuration: {
                      ...draft.configuration,
                      host: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="Port">
              <input
                type="number"
                value={draft.configuration.port}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    configuration: {
                      ...draft.configuration,
                      port: Number(event.target.value),
                    },
                  })
                }
              />
            </Field>
            <Field label="Username">
              <input
                value={draft.configuration.username ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    configuration: {
                      ...draft.configuration,
                      username: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                value={draft.configuration.password ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    configuration: {
                      ...draft.configuration,
                      password: event.target.value,
                    },
                  })
                }
              />
            </Field>
          </>
        )}
      </EditorForm>
    </ManagementLayout>
  );
}

function ForwardPanel() {
  const items = useAppStore((state) => state.forwards);
  const hosts = useAppStore((state) => state.hosts);
  const save = useAppStore((state) => state.saveForward);
  const remove = useAppStore((state) => state.deleteEntity);
  const credentials = useAppStore((state) => state.credentials);
  const proxies = useAppStore((state) => state.proxies);
  const preferences = useAppStore((state) => state.preferences);
  const [draft, setDraft] = useState<PortForwardRule>(() => newForward());
  return (
    <ManagementLayout
      icon={<Waypoints size={18} />}
      title="Port forwarding"
      description="Managed local, remote, and dynamic SSH forwarding rules."
      items={items}
      selectedId={draft.id}
      itemLabel={(item) => item.name}
      itemDetail={(item) => `${item.kind} · ${item.localPort}`}
      onSelect={setDraft}
      onNew={() => setDraft(newForward())}
    >
      <EditorForm
        title={draft.name || "New forwarding rule"}
        onSave={() => void save(draft)}
        onDelete={
          items.some((item) => item.id === draft.id)
            ? () =>
              void remove("forward", draft.id).then(() =>
                setDraft(newForward()),
              )
            : undefined
        }
        secondaryAction={
          draft.hostId
            ? {
              label: draft.status === "active" ? "Stop" : "Start",
              onClick: () => {
                if (draft.status === "active") {
                  void invoke("forward_stop", { id: draft.id }).then(() => {
                    const next = { ...draft, status: "inactive" as const };
                    setDraft(next);
                    void save(next);
                  });
                  return;
                }
                const source = hosts.find((host) => host.id === draft.hostId);
                if (!source) return;
                const credential = credentials.find(
                  (item) => item.id === source.credentialId,
                );
                const proxy = proxies.find(
                  (item) => item.id === source.proxyProfileId,
                );
                const host = {
                  ...source,
                  username: credential?.username || source.username,
                  authentication:
                    credential?.kind === "identityKey"
                      ? ("identityFile" as const)
                      : credential?.kind === "password"
                        ? ("password" as const)
                        : source.authentication,
                  password: credential?.password ?? source.password,
                  identityKey: credential?.privateKey ?? source.identityKey,
                  publicKey: credential?.publicKey ?? source.publicKey,
                  certificate:
                    credential?.certificate ?? source.certificate,
                  passphrase: credential?.passphrase ?? source.passphrase,
                  elevationPassword:
                    credential?.elevationPassword ??
                    source.elevationPassword,
                  proxyConfiguration:
                    proxy?.configuration ?? source.proxyConfiguration,
                };
                const connecting = {
                  ...draft,
                  status: "connecting" as const,
                };
                setDraft(connecting);
                void invoke("forward_start", {
                  host,
                  rule: draft,
                  autoAcceptHostKeys:
                    preferences.autoAcceptSshHostKeys,
                })
                  .then(() => {
                    const active = { ...draft, status: "active" as const };
                    setDraft(active);
                    void save(active);
                  })
                  .catch((reason: unknown) => {
                    const failed = {
                      ...draft,
                      status: "error" as const,
                      error: String(reason),
                    };
                    setDraft(failed);
                    void save(failed);
                  });
              },
            }
            : undefined
        }
      >
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label="Host">
          <select
            value={draft.hostId ?? ""}
            onChange={(event) =>
              setDraft({ ...draft, hostId: event.target.value || undefined })
            }
          >
            <option value=""><Translated value="Select host" /></option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select
            value={draft.kind}
            onChange={(event) =>
              setDraft({
                ...draft,
                kind: event.target.value as PortForwardRule["kind"],
              })
            }
          >
            <option value="local"><Translated value="Local" /></option>
            <option value="remote"><Translated value="Remote" /></option>
            <option value="dynamic"><Translated value="Dynamic SOCKS" /></option>
          </select>
        </Field>
        <Field label="Local port">
          <input
            type="number"
            value={draft.localPort}
            onChange={(event) =>
              setDraft({ ...draft, localPort: Number(event.target.value) })
            }
          />
        </Field>
        {draft.kind !== "dynamic" ? (
          <>
            <Field label="Remote host">
              <input
                value={draft.remoteHost}
                onChange={(event) =>
                  setDraft({ ...draft, remoteHost: event.target.value })
                }
              />
            </Field>
            <Field label="Remote port">
              <input
                type="number"
                value={draft.remotePort ?? 0}
                onChange={(event) =>
                  setDraft({ ...draft, remotePort: Number(event.target.value) })
                }
              />
            </Field>
          </>
        ) : null}
        <label className="check-field">
          <input
            checked={draft.autoStart}
            type="checkbox"
            onChange={(event) =>
              setDraft({ ...draft, autoStart: event.target.checked })
            }
          />
          Start automatically
        </label>
      </EditorForm>
    </ManagementLayout>
  );
}

function ScriptPanel() {
  const items = useAppStore((state) => state.scripts);
  const platform = useAppStore((state) => state.platform);
  const save = useAppStore((state) => state.saveScript);
  const remove = useAppStore((state) => state.deleteEntity);
  const openLocal = useAppStore((state) => state.openLocalSession);
  const [draft, setDraft] = useState<AutomationScript>(() =>
    newScript(platform),
  );
  return (
    <ManagementLayout
      icon={<Braces size={18} />}
      title="Automation scripts"
      description="Reusable scripts that run in managed terminal sessions."
      items={items}
      selectedId={draft.id}
      itemLabel={(item) => item.title}
      itemDetail={(item) => item.shell}
      onSelect={setDraft}
      onNew={() => setDraft(newScript(platform))}
    >
      <EditorForm
        title={draft.title || "New script"}
        onSave={() => void save(draft)}
        onDelete={
          items.some((item) => item.id === draft.id)
            ? () =>
              void remove("script", draft.id).then(() =>
                setDraft(newScript(platform)),
              )
            : undefined
        }
        secondaryAction={{
          label: "Run",
          onClick: () => {
            const session = openLocal();
            window.setTimeout(() => {
              void invoke("terminal_write", {
                sessionId: session.id,
                data: encode(`${draft.body}\r`),
              });
            }, 600);
          },
        }}
      >
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </Field>
        <Field label="Shell">
          <input
            value={draft.shell}
            onChange={(event) => setDraft({ ...draft, shell: event.target.value })}
          />
        </Field>
        <Field label="Script" wide>
          <textarea
            className="code-editor"
            rows={18}
            value={draft.body}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          />
        </Field>
      </EditorForm>
    </ManagementLayout>
  );
}

function SnippetPanel() {
  const items = useAppStore((state) => state.snippets);
  const save = useAppStore((state) => state.saveSnippet);
  const remove = useAppStore((state) => state.deleteEntity);
  const workspace = useAppStore((state) => state.workspace);
  const [draft, setDraft] = useState<Snippet>(() => newSnippet());
  return (
    <ManagementLayout
      icon={<FileText size={18} />}
      title="Snippets"
      description="Frequently used commands ready to paste into a focused terminal."
      items={items}
      selectedId={draft.id}
      itemLabel={(item) => item.title}
      itemDetail={(item) => item.group || "Ungrouped"}
      onSelect={setDraft}
      onNew={() => setDraft(newSnippet())}
    >
      <EditorForm
        title={draft.title || "New snippet"}
        onSave={() => void save(draft)}
        onDelete={
          items.some((item) => item.id === draft.id)
            ? () =>
              void remove("snippet", draft.id).then(() =>
                setDraft(newSnippet()),
              )
            : undefined
        }
        secondaryAction={
          workspace.activeWorkspaceId
            ? {
              label: "Paste",
              onClick: () => {
                const active = workspace.workspaces.find(
                  (item) => item.id === workspace.activeWorkspaceId,
                );
                if (!active) return;
                void invoke("terminal_write", {
                  sessionId: active.focusedSessionId,
                  data: encode(draft.body),
                });
              },
            }
            : undefined
        }
      >
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </Field>
        <Field label="Group">
          <input
            value={draft.group}
            onChange={(event) => setDraft({ ...draft, group: event.target.value })}
          />
        </Field>
        <Field label="Command" wide>
          <textarea
            className="code-editor"
            rows={10}
            value={draft.body}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          />
        </Field>
      </EditorForm>
    </ManagementLayout>
  );
}

function NotesPanel() {
  const items = useAppStore((state) => state.notes);
  const hosts = useAppStore((state) => state.hosts);
  const save = useAppStore((state) => state.saveNote);
  const remove = useAppStore((state) => state.deleteEntity);
  const [draft, setDraft] = useState<HostNote>(() => newNote());
  return (
    <ManagementLayout
      icon={<BookOpen size={18} />}
      title="Host notes"
      description="Markdown-ready operational notes attached to hosts."
      items={items}
      selectedId={draft.id}
      itemLabel={(item) => item.title}
      itemDetail={(item) =>
        hosts.find((host) => host.id === item.hostId)?.label ?? "Global"
      }
      onSelect={setDraft}
      onNew={() => setDraft(newNote())}
    >
      <EditorForm
        title={draft.title || "New note"}
        onSave={() => void save(draft)}
        onDelete={
          items.some((item) => item.id === draft.id)
            ? () =>
              void remove("note", draft.id).then(() => setDraft(newNote()))
            : undefined
        }
      >
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </Field>
        <Field label="Host">
          <select
            value={draft.hostId ?? ""}
            onChange={(event) =>
              setDraft({ ...draft, hostId: event.target.value || undefined })
            }
          >
            <option value=""><Translated value="Global note" /></option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Markdown" wide>
          <textarea
            className="note-editor"
            rows={18}
            value={draft.body}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          />
        </Field>
      </EditorForm>
    </ManagementLayout>
  );
}

function HistoryPanel() {
  const t = useTranslation();
  const history = useAppStore((state) => state.history);
  const commandHistory = useAppStore((state) => state.commandHistory);
  const sessions = useAppStore((state) => state.workspace.sessions);
  const hosts = useAppStore((state) => state.hosts);
  return (
    <section className="management-panel">
      <ManagementHeader
        icon={<Clock3 size={18} />}
        title="Connection history"
        description="The most recent 1,000 local connection outcomes."
      />
      <div className="history-scroll">
        <div className="command-history">
          <div className="eyebrow"><Translated value="Recent commands" /></div>
          {commandHistory.slice(0, 100).map((entry) => (
            <div key={entry.id}>
              <span>
                {sessions.find((session) => session.id === entry.sessionId)
                  ?.title ?? entry.sessionTitle ?? t("Terminal")}
              </span>
              <code>{entry.command}</code>
              <time>{new Date(entry.createdAt).toLocaleTimeString()}</time>
            </div>
          ))}
          {commandHistory.length === 0 ? (
            <p><Translated value="No commands captured yet." /></p>
          ) : null}
        </div>
        <div className="history-table">
          <div className="history-row is-header">
            <span><Translated value="Status" /></span>
            <span><Translated value="Host" /></span>
            <span><Translated value="Started" /></span>
            <span><Translated value="Duration" /></span>
            <span><Translated value="Category" /></span>
          </div>
          {history.map((entry) => {
            const started = new Date(entry.startedAt);
            const ended = entry.endedAt ? new Date(entry.endedAt) : undefined;
            return (
              <div className="history-row" key={entry.id}>
                <span className={entry.succeeded ? "success-text" : "danger-text"}>
                  {entry.succeeded ? t("Succeeded") : t("Failed")}
                </span>
                <span>
                  {hosts.find((host) => host.id === entry.hostId)?.label ??
                    t("Quick Connect")}
                </span>
                <span>{started.toLocaleString()}</span>
                <span>
                  {ended
                    ? `${Math.max(
                      0,
                      Math.round((ended.getTime() - started.getTime()) / 1000),
                    )}s`
                    : t("Active")}
                </span>
                <span>{entry.errorCategory ?? "—"}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function GroupPanel() {
  const t = useTranslation();
  const groups = useAppStore((state) => state.groups);
  const save = useAppStore((state) => state.saveGroup);
  const remove = useAppStore((state) => state.deleteGroup);
  const [name, setName] = useState("");
  const [parentGroupId, setParentGroupId] = useState("");
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    new Set(),
  );
  const allRows = flattenGroups(groups);
  const rows = allRows.filter(
    ({ group }) =>
      !hasCollapsedAncestor(group, groups, collapsedGroupIds),
  );

  function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    void save({
      id: id(),
      name: trimmed,
      parentGroupId: parentGroupId || undefined,
      sortOrder: groups.filter(
        (group) => (group.parentGroupId ?? "") === parentGroupId,
      ).length,
    }).then(() => setName(""));
  }

  function move(group: HostGroup, nextParentGroupId?: string) {
    void save({
      ...group,
      parentGroupId: nextParentGroupId,
      sortOrder: groups.filter(
        (item) =>
          item.id !== group.id &&
          item.parentGroupId === nextParentGroupId,
      ).length,
    });
  }

  function toggle(groupId: string) {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  return (
    <section className="group-manager">
      <div className="group-manager-content">
        <div className="group-add-form">
          <div className="group-add-row">
            <input
              placeholder={t("New group")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
            <button
              className="secondary-button"
              disabled={!name.trim()}
              type="button"
              onClick={add}
            >
              {t("Add")}
            </button>
          </div>
          <label className="group-parent-field">
            <span>{t("Parent Group")}</span>
            <select
              value={parentGroupId}
              onChange={(event) => setParentGroupId(event.target.value)}
            >
              <option value="">{t("None")}</option>
              {allRows.map(({ group, depth }) => (
                <option key={group.id} value={group.id}>
                  {`${"  ".repeat(depth)}${group.name}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="group-manager-list">
          {rows.map(({ group, depth }) => {
            const hasChildren = groups.some(
              (item) => item.parentGroupId === group.id,
            );
            const isCollapsed = collapsedGroupIds.has(group.id);
            return (
              <div
                className="group-manager-row"
                key={group.id}
                style={{ paddingLeft: depth * 14 }}
              >
                <button
                  className="group-disclosure"
                  disabled={!hasChildren}
                  type="button"
                  onClick={() => toggle(group.id)}
                >
                  {isCollapsed ? (
                    <ChevronRight size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                </button>
                <Folder size={14} />
                <strong>{group.name}</strong>
                <details className="group-parent-menu">
                  <summary
                    aria-label={t("Parent Group")}
                    title={t("Parent Group")}
                  >
                    <CornerDownRight size={13} />
                  </summary>
                  <div>
                    <button
                      type="button"
                      onClick={(event) => {
                        move(group);
                        event.currentTarget
                          .closest("details")
                          ?.removeAttribute("open");
                      }}
                    >
                      {t("None")}
                    </button>
                    {allRows
                      .filter(
                        (row) =>
                          row.group.id !== group.id &&
                          !groupDescendantIds(groups, group.id).has(
                            row.group.id,
                          ),
                      )
                      .map((row) => (
                        <button
                          key={row.group.id}
                          type="button"
                          onClick={(event) => {
                            move(group, row.group.id);
                            event.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                          }}
                        >
                          {row.group.name}
                        </button>
                      ))}
                  </div>
                </details>
                <button
                  className="icon-button danger"
                  type="button"
                  onClick={() => void remove(group.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {groups.length === 0 ? (
            <p className="workflow-empty">{t("No Groups")}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function KnownHostsPanel() {
  const t = useTranslation();
  const knownHosts = useAppStore((state) => state.knownHosts);
  const deleteKnownHosts = useAppStore((state) => state.deleteKnownHosts);
  const refreshPersistentData = useAppStore(
    (state) => state.refreshPersistentData,
  );
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  useEffect(() => {
    const available = new Set(knownHosts.map((record) => record.id));
    setSelectedIds((selected) => {
      const next = new Set([...selected].filter((id) => available.has(id)));
      return next.size === selected.size ? selected : next;
    });
  }, [knownHosts]);

  function toggleSelection(id: string) {
    setSelectedIds((selected) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirmDelete() {
    const ids = pendingDeleteIds;
    if (!ids?.length) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await deleteKnownHosts(ids);
      setSelectedIds((selected) => {
        const next = new Set(selected);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setPendingDeleteIds(undefined);
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="workflow-section">
      <WorkflowHeader
        title="Known Hosts"
        description="Trusted SSH host keys stored by TermPilot."
        action={
          <div className="known-host-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void refreshPersistentData()}
            >
              <RefreshCw size={13} />
              {t("Refresh")}
            </button>
            <button
              className="danger-button"
              disabled={selectedIds.size === 0}
              type="button"
              onClick={() => setPendingDeleteIds([...selectedIds])}
            >
              <Trash2 size={13} />
              {t("Delete")}
            </button>
          </div>
        }
      />
      <div className="workflow-list">
        {knownHosts.map((record) => (
          <article className="workflow-row known-host-row" key={record.id}>
            <input
              aria-label={t("Select known host")}
              checked={selectedIds.has(record.id)}
              type="checkbox"
              onChange={() => toggleSelection(record.id)}
            />
            <ShieldCheck size={16} />
            <div>
              <strong>{record.hosts}</strong>
              <span>{record.algorithm}</span>
            </div>
            <button
              aria-label={t("Delete known host")}
              className="icon-button danger"
              type="button"
              onClick={() => setPendingDeleteIds([record.id])}
            >
              <Trash2 size={13} />
            </button>
          </article>
        ))}
        {knownHosts.length === 0 ? (
          <p className="workflow-empty">{t("No trusted host keys.")}</p>
        ) : null}
        {deleteError ? <div className="backup-error">{deleteError}</div> : null}
      </div>
      {pendingDeleteIds ? (
        <div className="backup-dialog-backdrop">
          <section
            aria-labelledby="delete-known-hosts-title"
            className="backup-dialog known-host-delete-dialog"
            role="dialog"
            aria-modal="true"
          >
            <header>
              <Trash2 size={22} />
              <div>
                <h3 id="delete-known-hosts-title">
                  {t("Delete Known Hosts")}
                </h3>
                <p>{t("Selected known host keys will be removed.")}</p>
              </div>
            </header>
            <footer>
              <button
                className="secondary-button"
                disabled={deleting}
                type="button"
                onClick={() => setPendingDeleteIds(undefined)}
              >
                {t("Cancel")}
              </button>
              <button
                className="danger-button"
                disabled={deleting}
                type="button"
                onClick={() => void confirmDelete()}
              >
                {t("Delete")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

type BackupOperation =
  | { kind: "export"; path: string }
  | { kind: "import"; path: string };

function BackupPanel() {
  const t = useTranslation();
  const refreshPersistentData = useAppStore(
    (state) => state.refreshPersistentData,
  );
  const [operation, setOperation] = useState<BackupOperation>();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();

  async function chooseExportDestination() {
    const path = await save({
      title: t("Export Backup"),
      defaultPath: `TermPilot-${new Date().toISOString().slice(0, 10)}.tpbackup`,
      filters: [
        {
          name: t("TermPilot Backup"),
          extensions: ["tpbackup"],
        },
      ],
    });
    if (!path) return;
    beginOperation({ kind: "export", path });
  }

  async function chooseImportSource() {
    const path = await open({
      title: t("Import Backup"),
      multiple: false,
      directory: false,
      filters: [
        {
          name: t("TermPilot Backup"),
          extensions: ["tpbackup"],
        },
      ],
    });
    if (typeof path !== "string") return;
    beginOperation({ kind: "import", path });
  }

  function beginOperation(next: BackupOperation) {
    setPassword("");
    setConfirmation("");
    setError(undefined);
    setStatus(undefined);
    setOperation(next);
  }

  async function performOperation() {
    if (!operation) return;
    setWorking(true);
    setError(undefined);
    try {
      if (operation.kind === "export") {
        await api.exportBackup(operation.path, password);
        setStatus(
          t("Backup exported to {file}.").replace(
            "{file}",
            backupFileName(operation.path),
          ),
        );
      } else {
        const summary = await api.importBackup(
          operation.path,
          password,
        );
        await refreshPersistentData();
        setStatus(
          t(
            "Imported {hosts} hosts ({deduplicated} deduplicated), {groups} groups, {credentials} credentials, {proxies} proxies, {forwards} port forwards, {scripts} scripts, and {notes} notes.",
          )
            .replace("{hosts}", String(summary.hosts))
            .replace(
              "{deduplicated}",
              String(summary.deduplicatedHosts),
            )
            .replace("{groups}", String(summary.groups))
            .replace("{credentials}", String(summary.credentials))
            .replace("{proxies}", String(summary.proxyProfiles))
            .replace(
              "{forwards}",
              String(summary.portForwardRules),
            )
            .replace(
              "{scripts}",
              String(summary.automationScripts),
            )
            .replace("{notes}", String(summary.hostNotes)),
        );
      }
      setOperation(undefined);
    } catch (reason) {
      setError(t(errorMessage(reason)));
    } finally {
      setWorking(false);
    }
  }

  const confirmsPassword = operation?.kind === "export";
  const canSubmit =
    Array.from(password.normalize("NFC")).length >= 8 &&
    (!confirmsPassword || password === confirmation);

  return (
    <section className="backup-settings">
      <ManagementHeader
        icon={<HardDrive size={18} />}
        title="Encrypted Backup"
        description="Password-protected backup shared by Swift, Tauri macOS, and Tauri Windows."
      />
      <div className="backup-settings-card">
        <div>
          <strong>{t("Full Data Backup")}</strong>
          <p>
            {t(
              "Backups include hosts, groups, credentials, proxies, port forwards, scripts, and notes. Known hosts are excluded.",
            )}
          </p>
        </div>
        <div className="backup-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => void chooseExportDestination()}
          >
            <Save size={14} />
            {t("Export Backup")}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void chooseImportSource()}
          >
            <CornerDownRight size={14} />
            {t("Import Backup")}
          </button>
        </div>
        <p>
          {t(
            "Import merges with existing data. Hosts are deduplicated by normalized IP address or hostname.",
          )}
        </p>
        {status ? (
          <div className="backup-status">{status}</div>
        ) : null}
      </div>

      {operation ? (
        <div className="backup-dialog-backdrop">
          <section className="backup-dialog" role="dialog" aria-modal="true">
            <header>
              <ShieldCheck size={22} />
              <div>
                <h3>
                  {t(
                    operation.kind === "export"
                      ? "Export Encrypted Backup"
                      : "Import Encrypted Backup",
                  )}
                </h3>
                <p>
                  {t(
                    operation.kind === "export"
                      ? "Set a password to encrypt this backup."
                      : "Enter the password used when this backup was exported.",
                  )}
                </p>
              </div>
            </header>
            <label>
              <span>{t("Backup Password")}</span>
              <input
                autoFocus
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {confirmsPassword ? (
              <label>
                <span>{t("Confirm Backup Password")}</span>
                <input
                  type="password"
                  value={confirmation}
                  onChange={(event) =>
                    setConfirmation(event.target.value)
                  }
                />
              </label>
            ) : null}
            <small>
              {t(
                "Use at least 8 characters. The password cannot be recovered.",
              )}
            </small>
            {error ? <div className="backup-error">{error}</div> : null}
            <footer>
              <button
                className="secondary-button"
                disabled={working}
                type="button"
                onClick={() => setOperation(undefined)}
              >
                {t("Cancel")}
              </button>
              <button
                className="primary-button"
                disabled={!canSubmit || working}
                type="button"
                onClick={() => void performOperation()}
              >
                {working
                  ? t("Processing...")
                  : t(
                    operation.kind === "export"
                      ? "Export"
                      : "Import",
                  )}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function SettingsPanel() {
  const t = useTranslation();
  const current = useAppStore((state) => state.preferences);
  const update = useAppStore((state) => state.updatePreferences);
  const [draft, setDraft] = useState(current);
  const [terminalFontFamilies, setTerminalFontFamilies] = useState<string[]>(
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void api.availableTerminalFonts()
      .then((families) => {
        if (cancelled) return;
        setTerminalFontFamilies(
          terminalFontOptions(families, current.terminalFontName),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setTerminalFontFamilies(
          terminalFontOptions([], current.terminalFontName),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [current.terminalFontName]);

  function change(next: AppPreferences) {
    setDraft(next);
    void update(next);
  }

  return (
    <div className="settings-general-scroll">
      <div className="settings-form">
        <SettingsCard title="Appearance">
          <Field label="Language">
            <select
              value={draft.language}
              onChange={(event) =>
                change({
                  ...draft,
                  language: event.target.value as AppPreferences["language"],
                })
              }
            >
              <option value="zh-Hans">简体中文</option>
              <option value="en">{t("English")}</option>
            </select>
          </Field>
          <Field label="Theme">
            <select
              value={draft.theme}
              onChange={(event) =>
                change({
                  ...draft,
                  theme: event.target.value as AppPreferences["theme"],
                })
              }
            >
              <option value="system">{t("System (Follow System)")}</option>
              <option value="light">{t("Light")}</option>
              <option value="dark">{t("Dark")}</option>
            </select>
          </Field>
        </SettingsCard>
        <SettingsCard title="Terminal">
          <Field label="Terminal Font">
            <select
              value={draft.terminalFontName}
              onChange={(event) =>
                change({ ...draft, terminalFontName: event.target.value })
              }
            >
              <option value="auto">{t("Auto (Prefer Nerd Font)")}</option>
              {terminalFontFamilies.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Font size">
            <input
              min={8}
              max={36}
              type="number"
              value={draft.terminalFontSize}
              onChange={(event) =>
                change({
                  ...draft,
                  terminalFontSize: Number(event.target.value),
                })
              }
            />
          </Field>
          <PreferenceToggle
            checked={draft.autoOpenSystemOverview}
            description="Open System automatically after a successful SSH connection."
            label="Open System overview after SSH connects"
            onChange={(value) =>
              change({ ...draft, autoOpenSystemOverview: value })
            }
          />
          <PreferenceToggle
            checked={draft.autoAcceptSshHostKeys}
            description="Accept SSH fingerprints automatically instead of confirming manually."
            label="Automatically accept SSH fingerprints"
            onChange={(value) =>
              change({ ...draft, autoAcceptSshHostKeys: value })
            }
          />
        </SettingsCard>
        <SettingsCard title="Autocomplete">
          <PreferenceToggle
            checked={draft.autocompleteEnabled}
            description="Show command suggestions from history and specifications."
            label="Enable Autocomplete"
            onChange={(value) =>
              change({ ...draft, autocompleteEnabled: value })
            }
          />
          <PreferenceToggle
            checked={draft.autocompleteGhostText}
            description="Show gray suggestion text after the cursor."
            disabled={!draft.autocompleteEnabled}
            label="Inline Suggestions"
            onChange={(value) =>
              change({
                ...draft,
                autocompleteGhostText: value,
                autocompletePopup: value ? false : draft.autocompletePopup,
              })
            }
          />
          <PreferenceToggle
            checked={draft.autocompletePopup}
            description="Show a floating list containing multiple suggestions."
            disabled={!draft.autocompleteEnabled}
            label="Popup Menu"
            onChange={(value) =>
              change({
                ...draft,
                autocompletePopup: value,
                autocompleteGhostText: value
                  ? false
                  : draft.autocompleteGhostText,
              })
            }
          />
        </SettingsCard>
        <SettingsCard title="Password Prompt Assist">
          <Field label="Assist Mode">
            <select
              value={draft.passwordPromptAssist}
              onChange={(event) =>
                change({
                  ...draft,
                  passwordPromptAssist: event.target
                    .value as AppPreferences["passwordPromptAssist"],
                })
              }
            >
              <option value="off">{t("Off")}</option>
              <option value="hint">{t("Quick Fill (Enter)")}</option>
              <option value="picker">{t("Credential Picker")}</option>
            </select>
          </Field>
          <p className="preference-description">
            {t(
              "When sudo or su asks for a password, offer a saved credential. Never sends a password without confirmation.",
            )}
          </p>
        </SettingsCard>
        <SettingsCard title="SFTP">
          <PreferenceToggle
            checked={draft.sftpShowsHiddenFiles}
            description="Display hidden files in local and remote browsers."
            label="Show hidden files"
            onChange={(value) =>
              change({ ...draft, sftpShowsHiddenFiles: value })
            }
          />
          <RangeSetting
            description="Maximum files transferred concurrently for one target."
            label="File transfer concurrency"
            max={16}
            min={1}
            value={draft.sftpFileTransferConcurrency}
            onChange={(value) =>
              change({ ...draft, sftpFileTransferConcurrency: value })
            }
          />
          <RangeSetting
            description="Maximum chunks transferred concurrently inside one file."
            label="Single-file chunk concurrency"
            max={32}
            min={1}
            value={draft.sftpChunkConcurrency}
            onChange={(value) =>
              change({ ...draft, sftpChunkConcurrency: value })
            }
          />
          <Field label="Chunk size">
            <select
              value={draft.sftpChunkSizeBytes}
              onChange={(event) =>
                change({
                  ...draft,
                  sftpChunkSizeBytes: Number(event.target.value),
                })
              }
            >
              {[256, 512, 1024, 5 * 1024, 10 * 1024].map((kilobytes) => (
                <option key={kilobytes} value={kilobytes * 1024}>
                  {kilobytes < 1024
                    ? `${kilobytes} KB`
                    : `${kilobytes / 1024} MB`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Transfer connection keep-alive">
            <select
              value={draft.sftpTransferConnectionIdleSeconds}
              onChange={(event) =>
                change({
                  ...draft,
                  sftpTransferConnectionIdleSeconds: Number(
                    event.target.value,
                  ),
                })
              }
            >
              <option value={60}>{t("1 minute")}</option>
              <option value={5 * 60}>{t("5 minutes")}</option>
              <option value={15 * 60}>{t("15 minutes")}</option>
              <option value={30 * 60}>{t("30 minutes")}</option>
              <option value={0}>{t("Until app quits")}</option>
            </select>
          </Field>
          <p className="preference-description">
            {t("Active transfers are never closed.")}
          </p>
        </SettingsCard>
        <SettingsCard title="System Monitor">
          {(
            [
              ["Overview", "overviewRefreshInterval"],
              ["Processes", "processesRefreshInterval"],
              ["Docker", "dockerRefreshInterval"],
            ] as const
          ).map(([label, key]) => (
            <Field key={key} label={label}>
              <input
                min={1}
                max={10}
                type="number"
                value={draft[key]}
                onChange={(event) =>
                  change({
                    ...draft,
                    [key]: Number(event.target.value),
                  })
                }
              />
            </Field>
          ))}
          <p className="preference-description">
            {t("Range: 1-10 seconds.")}
          </p>
        </SettingsCard>
      </div>
    </div>
  );
}

function ManagementLayout<T extends { id: string }>({
  icon,
  title,
  description,
  items,
  selectedId,
  itemLabel,
  itemDetail,
  itemAction,
  onSelect,
  onNew,
  onCreate,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  items: T[];
  selectedId: string;
  itemLabel: (item: T) => string;
  itemDetail: (item: T) => string;
  itemAction?: (
    item: T,
    controls: { edit: () => void; closeEditor: () => void },
  ) => React.ReactNode;
  onSelect: (item: T) => void;
  onNew: () => void;
  onCreate?: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslation();
  const [editorOpen, setEditorOpen] = useState(false);
  const editor = isValidElement<EditorFormProps>(children)
    ? cloneElement(children, { onClose: () => setEditorOpen(false) })
    : children;
  return (
    <section className="management-panel workflow-section">
      <WorkflowHeader
        title={title}
        description={description}
        action={
          <div className="workflow-header-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                onNew();
                setEditorOpen(true);
              }}
            >
              <Plus size={14} />
              {t("New")}
            </button>
            {onCreate ? (
              <button
                className="secondary-button"
                type="button"
                onClick={onCreate}
              >
                <WandSparkles size={14} />
                {t("Create Credential")}
              </button>
            ) : null}
          </div>
        }
      />
      <div className="management-split">
        <div className="management-list">
          {items.map((item) => {
            const edit = () => {
              onSelect(item);
              setEditorOpen(true);
            };
            const action = itemAction?.(item, {
              edit,
              closeEditor: () => setEditorOpen(false),
            });
            const content = (
              <>
                <span className="workflow-row-icon">{icon}</span>
                <strong>{itemLabel(item)}</strong>
                <span>{itemDetail(item)}</span>
              </>
            );
            if (!action) {
              return (
                <button
                  className={item.id === selectedId ? "is-selected" : ""}
                  key={item.id}
                  type="button"
                  onClick={edit}
                >
                  {content}
                </button>
              );
            }
            return (
              <div className="management-list-item" key={item.id}>
                <button
                  className={`management-list-main ${
                    item.id === selectedId ? "is-selected" : ""
                  }`}
                  type="button"
                  onClick={edit}
                >
                  {content}
                </button>
                {action}
              </div>
            );
          })}
          {items.length === 0 ? (
            <p className="empty-list">{t("No saved items.")}</p>
          ) : null}
        </div>
        {editorOpen ? (
          <div className="management-editor">{editor}</div>
        ) : null}
      </div>
    </section>
  );
}

function ManagementHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  const t = useTranslation();
  return (
    <header className="management-header">
      <div className="management-title-icon">{icon}</div>
      <div>
        <div className="eyebrow">{t("Workspace tools")}</div>
        <h2>{t(title)}</h2>
        <p>{t(description)}</p>
      </div>
      <div className="management-header-action">{action}</div>
    </header>
  );
}

function WorkflowHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  const t = useTranslation();
  return (
    <header className="workflow-header">
      <div>
        <h2>{t(title)}</h2>
        <p>{t(description)}</p>
      </div>
      {action}
    </header>
  );
}

interface EditorFormProps {
  title: string;
  onSave: () => void;
  onDelete?: () => void;
  onClose?: () => void;
  secondaryAction?: { label: string; onClick: () => void };
  children: React.ReactNode;
}

function EditorForm({
  title,
  onSave,
  onDelete,
  onClose,
  secondaryAction,
  children,
}: EditorFormProps) {
  const t = useTranslation();
  return (
    <div className="inline-editor">
      <div className="inline-editor-header">
        <h3>{t(title)}</h3>
        {onClose ? (
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={14} />
          </button>
        ) : null}
      </div>
      <div className="form-grid">{children}</div>
      <footer className="inline-editor-footer">
        <div>
          {secondaryAction ? (
            <button
              className="secondary-button"
              type="button"
              onClick={secondaryAction.onClick}
            >
              {t(secondaryAction.label)}
            </button>
          ) : null}
          {onDelete ? (
            <button
              className="icon-button danger"
              type="button"
              onClick={() => {
                onDelete();
                onClose?.();
              }}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
        <div>
          {onClose ? (
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
            >
              {t("Cancel")}
            </button>
          ) : null}
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              onSave();
              onClose?.();
            }}
          >
            <Save size={14} />
            {t("Save")}
          </button>
        </div>
      </footer>
    </div>
  );
}

export function terminalFontOptions(
  families: string[],
  selectedFont: string,
) {
  const values = new Set(
    families.map((family) => family.trim()).filter(Boolean),
  );
  if (selectedFont && selectedFont !== "auto") {
    values.add(selectedFont);
  }
  return [...values].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

function SettingsCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const t = useTranslation();
  return (
    <section className="settings-card">
      <h3>{t(title)}</h3>
      <div>{children}</div>
    </section>
  );
}

function PreferenceToggle({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const t = useTranslation();
  return (
    <label className={`preference-toggle ${disabled ? "is-disabled" : ""}`}>
      <span>
        <strong>{t(label)}</strong>
        <small>{t(description)}</small>
      </span>
      <input
        checked={checked}
        disabled={disabled}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function RangeSetting({
  label,
  description,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  description: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const t = useTranslation();
  return (
    <label className="range-setting">
      <span>
        <strong>{t(label)}</strong>
        <small>{t(description)}</small>
      </span>
      <input
        max={max}
        min={min}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}</output>
    </label>
  );
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslation();
  return (
    <label className={`form-field ${wide ? "is-wide" : ""}`}>
      <span>{t(label)}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const t = useTranslation();
  return (
    <label className="toggle-field">
      <span>{t(label)}</span>
      <input
        checked={checked}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function Translated({ value }: { value: string }) {
  const t = useTranslation();
  return <>{t(value)}</>;
}

function newCredential(): Credential {
  const timestamp = now();
  return {
    id: id(),
    label: "",
    username: "",
    kind: "password",
    password: "",
    savesPassphrase: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function flattenGroups(groups: HostGroup[]) {
  const result: Array<{ group: HostGroup; depth: number }> = [];
  const visited = new Set<string>();
  const append = (group: HostGroup, depth: number) => {
    if (visited.has(group.id)) return;
    visited.add(group.id);
    result.push({ group, depth });
    groups
      .filter((item) => item.parentGroupId === group.id)
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .forEach((child) => append(child, depth + 1));
  };
  groups
    .filter(
      (group) =>
        !group.parentGroupId ||
        !groups.some((item) => item.id === group.parentGroupId),
    )
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .forEach((group) => append(group, 0));
  groups.forEach((group) => append(group, 0));
  return result;
}

function hasCollapsedAncestor(
  group: HostGroup,
  groups: HostGroup[],
  collapsedGroupIds: Set<string>,
) {
  let parentGroupId = group.parentGroupId;
  const visited = new Set<string>();
  while (parentGroupId && !visited.has(parentGroupId)) {
    if (collapsedGroupIds.has(parentGroupId)) return true;
    visited.add(parentGroupId);
    parentGroupId = groups.find(
      (candidate) => candidate.id === parentGroupId,
    )?.parentGroupId;
  }
  return false;
}

function groupDescendantIds(groups: HostGroup[], groupId: string) {
  const result = new Set<string>();
  const pending = [groupId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    groups
      .filter((group) => group.parentGroupId === current)
      .forEach((group) => {
        if (result.has(group.id)) return;
        result.add(group.id);
        pending.push(group.id);
      });
  }
  return result;
}

function newProxy(): ProxyProfile {
  const timestamp = now();
  return {
    id: id(),
    label: "",
    configuration: { type: "http", host: "", port: 8080 },
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function newForward(): PortForwardRule {
  const timestamp = now();
  return {
    id: id(),
    name: "",
    kind: "local",
    bindAddress: "127.0.0.1",
    localPort: 8080,
    remoteHost: "127.0.0.1",
    remotePort: 80,
    autoStart: false,
    status: "inactive",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function newScript(platform: "windows" | "macos"): AutomationScript {
  const timestamp = now();
  return {
    id: id(),
    title: "",
    shell: platform === "windows" ? "powershell.exe" : "/bin/zsh",
    body: "",
    sortOrder: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function newSnippet(): Snippet {
  return {
    id: id(),
    title: "",
    group: "",
    body: "",
    sortOrder: 0,
    updatedAt: now(),
  };
}

function newNote(): HostNote {
  const timestamp = now();
  return {
    id: id(),
    title: "",
    body: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function backupFileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
