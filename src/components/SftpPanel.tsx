import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Copy,
  ClipboardPaste,
  Eye,
  EyeOff,
  File,
  FilePenLine,
  Folder,
  FolderPlus,
  Home,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Send,
  Scissors,
  Trash2,
  FilePlus2,
  MoreHorizontal,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { type Event as TauriEvent, listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  type DragDropEvent,
} from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

import { useTranslation } from "../i18n";
import { useAppStore } from "../store";
import type { Host, SessionDescriptor, SftpEntry } from "../types";

interface LocalEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "other";
  size: number;
  modifiedAt?: string;
}

export function createDisposableHandler<T>(handler: (value: T) => void) {
  let disposed = false;
  return {
    handle(value: T) {
      if (!disposed) handler(value);
    },
    dispose() {
      disposed = true;
    },
  };
}

export interface RemoteTextDraft {
  name: string;
  path: string;
  text: string;
}

export function remoteTextDraft(
  name: string,
  path: string,
  text: string,
): RemoteTextDraft {
  return { name, path, text };
}

interface TransferProgress {
  id: number;
  event: "progress";
  transferKey: string;
  transferred: number;
  total?: number;
}

export interface TransferRecord {
  id: string;
  transferKey: string;
  name: string;
  direction: "upload" | "download";
  transferred: number;
  total?: number;
  bytesPerSecond: number;
  sampledAt: number;
  sampledBytes: number;
  state: "running" | "paused" | "completed" | "failed" | "cancelled";
  error?: string;
}

const useTransferStore = create<{
  transfers: TransferRecord[];
  setTransfers: (
    update:
      | TransferRecord[]
      | ((items: TransferRecord[]) => TransferRecord[]),
  ) => void;
}>((set) => ({
  transfers: [],
  setTransfers: (update) =>
    set((state) => ({
      transfers:
        typeof update === "function" ? update(state.transfers) : update,
    })),
}));

export function TransferCenterPopover({
  onClose,
}: {
  onClose: () => void;
}) {
  const t = useTranslation();
  const transfers = useTransferStore((state) => state.transfers);
  const setTransfers = useTransferStore((state) => state.setTransfers);
  return createPortal(
    <section className="global-transfer-center">
      <header>
        <strong>{t("Transfer Center")}</strong>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <div>
        {transfers.map((transfer) => (
          <article key={transfer.id}>
            <span>{transfer.direction === "upload" ? "UP" : "DOWN"}</span>
            <strong>{transfer.name}</strong>
            <progress
              max={Math.max(transfer.total ?? transfer.transferred, 1)}
              value={transfer.transferred}
            />
            <small>{transfer.state}</small>
          </article>
        ))}
        {transfers.length === 0 ? (
          <p>{t("No file transfers.")}</p>
        ) : null}
      </div>
      <footer>
        <button
          className="secondary-button"
          type="button"
          disabled={transfers.length === 0}
          onClick={() => setTransfers([])}
        >
          {t("Clear")}
        </button>
      </footer>
    </section>,
    document.body,
  );
}

interface ExternalEditSession {
  id: string;
  remotePath: string;
  localPath: string;
  modifiedAt: number;
  syncing: boolean;
}

interface RemoteTreeEntry extends SftpEntry {
  path: string;
  depth: number;
  displayName: string;
}

interface RemoteMenuState {
  x: number;
  y: number;
  entry?: SftpEntry & { path: string };
  kind: "context" | "more";
}

type ConflictResolution = "replace" | "copy" | "skip";

interface BatchConflict {
  id: string;
  name: string;
  source: string;
  destination: string;
  existingKind: string;
}

type FileClipboard =
  | {
      side: "local";
      operation: "copy" | "cut";
      entries: LocalEntry[];
    }
  | {
      side: "remote";
      operation: "copy" | "cut";
      entries: Array<SftpEntry & { path: string }>;
    };

type DialogState =
  | {
      type: "input";
      title: string;
      label: string;
      value: string;
      submit: (value: string) => void | Promise<void>;
    }
  | {
      type: "confirm";
      title: string;
      message: string;
      submit: () => void | Promise<void>;
    }
  | {
      type: "conflict";
      title: string;
      source: string;
      destination: string;
      submit: (resolution: ConflictResolution) => void | Promise<void>;
    }
  | {
      type: "batchConflict";
      title: string;
      conflicts: BatchConflict[];
      submit: (
        resolutions: Record<string, ConflictResolution>,
      ) => void | Promise<void>;
    };

export function SftpPanel({
  active = true,
  host,
  session,
}: {
  active?: boolean;
  host?: Host;
  session: SessionDescriptor;
}) {
  const t = useTranslation();
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState(".");
  const [remotePathDraft, setRemotePathDraft] = useState(".");
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [remoteEntries, setRemoteEntries] = useState<SftpEntry[]>([]);
  const [localFilter, setLocalFilter] = useState("");
  const [remoteFilter, setRemoteFilter] = useState("");
  const [remoteViewMode, setRemoteViewMode] = useState<"list" | "tree">(
    "list",
  );
  const [expandedRemotePaths, setExpandedRemotePaths] = useState<string[]>([]);
  const [remoteTreeChildren, setRemoteTreeChildren] = useState<
    Record<string, Array<SftpEntry & { path: string }>>
  >({});
  const [remoteBookmarks, setRemoteBookmarks] = useState<string[]>([]);
  const [autoSyncExternalEdits, setAutoSyncExternalEdits] = useState(true);
  const [externalDragActive, setExternalDragActive] = useState(false);
  const [selectedLocal, setSelectedLocal] = useState<LocalEntry>();
  const [selectedRemote, setSelectedRemote] =
    useState<SftpEntry & { path?: string }>();
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<string[]>([]);
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const transfers = useTransferStore((state) => state.transfers);
  const setTransfers = useTransferStore((state) => state.setTransfers);
  const sidebarTransfers = transfers.filter(
    (transfer) =>
      transfer.state === "running" || transfer.state === "paused",
  );
  const [textDraft, setTextDraft] = useState<RemoteTextDraft>();
  const [dialog, setDialog] = useState<DialogState>();
  const [remoteMenu, setRemoteMenu] = useState<RemoteMenuState>();
  const [clipboard, setClipboard] = useState<FileClipboard>();
  const [externalEdits, setExternalEdits] = useState<ExternalEditSession[]>([]);
  const localBackRef = useRef<string[]>([]);
  const localForwardRef = useRef<string[]>([]);
  const remoteBackRef = useRef<string[]>([]);
  const remoteForwardRef = useRef<string[]>([]);
  const preferences = useAppStore((state) => state.preferences);
  const updatePreferences = useAppStore(
    (state) => state.updatePreferences,
  );

  const remoteWithPaths = useMemo(
    () =>
      remoteEntries.map((entry) => ({
        ...entry,
        path: remoteJoin(remotePath, entry.name),
      })),
    [remoteEntries, remotePath],
  );
  const selectedLocalItems = useMemo(
    () =>
      localEntries.filter((entry) =>
        selectedLocalPaths.includes(entry.path),
      ),
    [localEntries, selectedLocalPaths],
  );
  const remoteTreeEntries = useMemo(
    () =>
      flattenRemoteTree(
        remotePath,
        remoteTreeChildren,
        new Set(expandedRemotePaths),
      ),
    [expandedRemotePaths, remotePath, remoteTreeChildren],
  );
  const displayedRemoteEntries =
    remoteViewMode === "tree" ? remoteTreeEntries : remoteWithPaths;
  const selectedRemoteItems = useMemo(
    () =>
      displayedRemoteEntries.filter((entry) =>
        selectedRemotePaths.includes(entry.path),
      ),
    [displayedRemoteEntries, selectedRemotePaths],
  );
  const hasMultipleLocal = selectedLocalItems.length > 1;
  const hasMultipleRemote = selectedRemoteItems.length > 1;
  const visibleLocalEntries = useMemo(
    () =>
      localEntries.filter(
        (entry) =>
          (preferences.sftpShowsHiddenFiles ||
            !entry.name.startsWith(".")) &&
          entry.name.toLowerCase().includes(localFilter.toLowerCase()),
      ),
    [
      localEntries,
      localFilter,
      preferences.sftpShowsHiddenFiles,
    ],
  );
  const visibleRemoteEntries = useMemo(
    () =>
      displayedRemoteEntries.filter(
        (entry) =>
          (preferences.sftpShowsHiddenFiles ||
            !entry.name.startsWith(".")) &&
          entry.name.toLowerCase().includes(remoteFilter.toLowerCase()),
      ),
    [
      preferences.sftpShowsHiddenFiles,
      remoteFilter,
      displayedRemoteEntries,
    ],
  );

  useEffect(() => {
    void invoke<string>("local_downloads").then((downloads) =>
      setLocalPath(downloads),
    );
    const progress = listen<TransferProgress>("sftp-progress", ({ payload }) => {
      setTransfers((items) =>
        items.map((item) =>
          item.state === "running" &&
          item.transferKey === payload.transferKey
            ? updateTransferProgress(item, payload, Date.now())
            : item,
        ),
      );
    });
    return () => {
      void progress.then((unlisten) => unlisten());
    };
  }, [setTransfers]);

  useEffect(() => {
    if (!active || !host) return;
    document.documentElement.dataset.fileDropTarget = "sftp";
    const dragHandler = createDisposableHandler<TauriEvent<DragDropEvent>>(
      (event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setExternalDragActive(true);
          return;
        }
        setExternalDragActive(false);
        if (event.payload.type !== "drop" || event.payload.paths.length === 0) {
          return;
        }
        void Promise.all(
          event.payload.paths.map((path) =>
            invoke<LocalEntry>("local_entry", { path }),
          ),
        )
          .then((entries) => uploadBatch(entries))
          .catch((reason: unknown) => setError(message(reason)));
      },
    );
    const listener = getCurrentWindow().onDragDropEvent(dragHandler.handle);
    return () => {
      dragHandler.dispose();
      delete document.documentElement.dataset.fileDropTarget;
      void listener
        .then((unlisten) => unlisten())
        .catch(() => undefined);
    };
  }, [active, host, remoteEntries, remotePath]);

  useEffect(() => {
    setSelectedLocal(undefined);
    setSelectedLocalPaths([]);
    if (localPath) void refreshLocal();
  }, [localPath]);

  useEffect(() => {
    setSelectedRemote(undefined);
    setSelectedRemotePaths([]);
    setRemotePathDraft(remotePath);
    if (!host) return;
    if (remotePath === ".") {
      void request<{ path: string }>({ action: "realpath", path: "." })
        .then((result) => {
          if (result.path !== remotePath) setRemotePath(result.path);
          else void refreshRemote();
        })
        .catch((reason: unknown) => setError(message(reason)));
      return;
    }
    void refreshRemote();
  }, [host, remotePath]);

  useEffect(() => {
    if (!autoSyncExternalEdits || externalEdits.length === 0) return;
    const timer = window.setInterval(() => {
      for (const edit of externalEdits) {
        if (edit.syncing) continue;
        void invoke<number>("local_modified_at", { path: edit.localPath }).then(
          async (modifiedAt) => {
            if (modifiedAt <= edit.modifiedAt) return;
            setExternalEdits((items) =>
              items.map((item) =>
                item.id === edit.id ? { ...item, syncing: true } : item,
              ),
            );
            try {
              await request({
                action: "upload",
                localPath: edit.localPath,
                remotePath: edit.remotePath,
                overwrite: true,
                transferKey: crypto.randomUUID(),
              });
              setExternalEdits((items) =>
                items.map((item) =>
                  item.id === edit.id
                    ? { ...item, modifiedAt, syncing: false }
                    : item,
                ),
              );
              await refreshRemote();
            } catch (reason) {
              setExternalEdits((items) =>
                items.map((item) =>
                  item.id === edit.id ? { ...item, syncing: false } : item,
                ),
              );
              setError(message(reason));
            }
          },
        ).catch((reason: unknown) => setError(message(reason)));
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [
    autoSyncExternalEdits,
    externalEdits,
    host?.id,
    session.id,
  ]);

  useEffect(() => {
    if (!remoteMenu) return;
    const close = () => setRemoteMenu(undefined);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [remoteMenu]);

  async function refreshLocal() {
    try {
      setLocalEntries(await invoke<LocalEntry[]>("local_list", { path: localPath }));
      setError(undefined);
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function refreshRemote() {
    if (!host) return;
    setLoading(true);
    try {
      const result = await request<{ entries: SftpEntry[] }>({
        action: "list",
        path: remotePath,
      });
      setRemoteEntries(result.entries);
      setRemoteTreeChildren((current) => ({
        ...current,
        [remotePath]: result.entries.map((entry) => ({
          ...entry,
          path: remoteJoin(remotePath, entry.name),
        })),
      }));
      setError(undefined);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }

  async function request<T>(requestValue: Record<string, unknown>) {
    if (!host) {
      throw new Error("Remote file operations require an SSH session.");
    }
    const action = String(requestValue.action ?? "");
    const request =
      action === "upload" || action === "download"
        ? {
            ...requestValue,
            fileConcurrency:
              preferences.sftpFileTransferConcurrency,
            chunkConcurrency: preferences.sftpChunkConcurrency,
            chunkSizeBytes: preferences.sftpChunkSizeBytes,
          }
        : requestValue;
    return invoke<T>("sftp_request", {
      host,
      sourceSessionId: session.id,
      idleSeconds: preferences.sftpTransferConnectionIdleSeconds,
      request,
    });
  }

  function navigateLocal(path: string) {
    if (!path || path === localPath) return;
    if (localPath) localBackRef.current.push(localPath);
    localForwardRef.current = [];
    setLocalPath(path);
  }

  function navigateRemote(path: string) {
    if (!path) return;
    void request<{ path: string }>({ action: "realpath", path })
      .then((result) => {
        if (!result.path || result.path === remotePath) {
          setRemotePathDraft(remotePath);
          return;
        }
        remoteBackRef.current.push(remotePath);
        remoteForwardRef.current = [];
        setRemotePath(result.path);
      })
      .catch((reason: unknown) => setError(message(reason)));
  }

  function goBackLocal() {
    const path = localBackRef.current.pop();
    if (!path) return;
    localForwardRef.current.push(localPath);
    setLocalPath(path);
  }

  function goForwardLocal() {
    const path = localForwardRef.current.pop();
    if (!path) return;
    localBackRef.current.push(localPath);
    setLocalPath(path);
  }

  function goBackRemote() {
    const path = remoteBackRef.current.pop();
    if (!path) return;
    remoteForwardRef.current.push(remotePath);
    setRemotePath(path);
  }

  function goForwardRemote() {
    const path = remoteForwardRef.current.pop();
    if (!path) return;
    remoteBackRef.current.push(remotePath);
    setRemotePath(path);
  }

  async function toggleRemoteTree(entry: SftpEntry & { path: string }) {
    if (entry.kind !== "directory") return;
    if (expandedRemotePaths.includes(entry.path)) {
      setExpandedRemotePaths((current) =>
        current.filter((path) => path !== entry.path),
      );
      return;
    }
    setExpandedRemotePaths((current) => [...current, entry.path]);
    if (remoteTreeChildren[entry.path]) return;
    const result = await request<{ entries: SftpEntry[] }>({
      action: "list",
      path: entry.path,
    });
    setRemoteTreeChildren((current) => ({
      ...current,
      [entry.path]: result.entries.map((child) => ({
        ...child,
        path: remoteJoin(entry.path, child.name),
      })),
    }));
  }

  async function upload() {
    if (selectedLocalItems.length > 1) {
      await uploadBatch(selectedLocalItems);
      return;
    }
    if (!selectedLocal) return;
    const destination = remoteJoin(remotePath, selectedLocal.name);
    const existing = remoteEntries.find(
      (entry) => entry.name === selectedLocal.name,
    );
    const start = async (
      replaceTarget: boolean,
      resolvedDestination = destination,
    ) => {
      if (replaceTarget && existing) {
        await request({
          action: "delete",
          path: destination,
          kind: existing.kind,
        });
      }
      const succeeded = await transfer(selectedLocal.name, "upload", {
        action: "upload",
        localPath: selectedLocal.path,
        remotePath: resolvedDestination,
        overwrite: false,
        transferKey: crypto.randomUUID(),
      });
      if (succeeded) await refreshRemote();
    };
    if (existing) {
      setDialog({
        type: "conflict",
        title: "Upload conflict",
        source: selectedLocal.path,
        destination,
        submit: async (resolution) => {
          setDialog(undefined);
          if (resolution === "skip") return;
          await start(
            resolution === "replace",
            resolution === "copy"
              ? remoteJoin(
                  remotePath,
                  duplicateName(
                    selectedLocal.name,
                    remoteEntries.map((entry) => entry.name),
                    selectedLocal.kind === "directory",
                  ),
                )
              : destination,
          );
        },
      });
      return;
    }
    await start(false);
  }

  async function uploadBatch(
    entries: LocalEntry[],
    removesSourcesOnSuccess = false,
  ) {
    const conflicts = entries.flatMap((entry) => {
      const existing = remoteEntries.find((item) => item.name === entry.name);
      return existing
        ? [
            {
              id: entry.path,
              name: entry.name,
              source: entry.path,
              destination: remoteJoin(remotePath, entry.name),
              existingKind: existing.kind,
            },
          ]
        : [];
    });
    const start = async (
      resolutions: Record<string, ConflictResolution>,
    ) => {
      const results = await Promise.all(entries.map(async (entry) => {
        const existing = remoteEntries.find(
          (item) => item.name === entry.name,
        );
        const resolution = existing
          ? resolutions[entry.path] ?? "skip"
          : "replace";
        if (resolution === "skip") return false;
        const originalDestination = remoteJoin(remotePath, entry.name);
        const destination =
          resolution === "copy"
            ? remoteJoin(
                remotePath,
                duplicateName(
                  entry.name,
                  remoteEntries.map((item) => item.name),
                  entry.kind === "directory",
                ),
              )
            : originalDestination;
        if (resolution === "replace" && existing) {
          await request({
            action: "delete",
            path: originalDestination,
            kind: existing.kind,
          });
        }
        const succeeded = await transfer(entry.name, "upload", {
          action: "upload",
          localPath: entry.path,
          remotePath: destination,
          overwrite: false,
          transferKey: crypto.randomUUID(),
        });
        if (succeeded && removesSourcesOnSuccess) {
          await invoke("local_delete", { path: entry.path });
        }
        return succeeded;
      }));
      const changed = results.some(Boolean);
      if (changed) {
        if (removesSourcesOnSuccess) {
          setSelectedLocal(undefined);
          setSelectedLocalPaths([]);
          await refreshLocal();
        }
        await refreshRemote();
      }
    };
    if (conflicts.length === 0) {
      await start({});
      return;
    }
    setDialog({
      type: "batchConflict",
      title: removesSourcesOnSuccess
        ? "Batch move conflicts"
        : "Batch upload conflicts",
      conflicts,
      submit: async (resolutions) => {
        setDialog(undefined);
        await start(resolutions);
      },
    });
  }

  async function defaultDownloadDirectory() {
    return invoke<string>("local_downloads");
  }

  async function chooseDownloadDirectory() {
    const selection = await open({
      multiple: false,
      directory: true,
      defaultPath: await defaultDownloadDirectory(),
      title: t("Download"),
    });
    return typeof selection === "string" ? selection : undefined;
  }

  async function chooseDownloadDestination(entry: SftpEntry) {
    const downloads = await defaultDownloadDirectory();
    if (entry.kind === "directory") {
      const directory = await open({
        multiple: false,
        directory: true,
        defaultPath: downloads,
        title: t("Download"),
      });
      return typeof directory === "string"
        ? localJoin(directory, entry.name)
        : undefined;
    }
    return (
      (await save({
        defaultPath: localJoin(downloads, entry.name),
        title: t("Download"),
      })) ?? undefined
    );
  }

  async function localEntryAt(path: string) {
    try {
      return await invoke<LocalEntry>("local_entry", { path });
    } catch {
      return undefined;
    }
  }

  async function localNamesAt(path: string) {
    try {
      return (await invoke<LocalEntry[]>("local_list", { path })).map(
        (entry) => entry.name,
      );
    } catch {
      return [];
    }
  }

  async function download() {
    if (selectedRemoteItems.length > 1) {
      const destinationDirectory = await chooseDownloadDirectory();
      if (!destinationDirectory) return;
      await downloadBatch(
        selectedRemoteItems,
        false,
        destinationDirectory,
      );
      return;
    }
    if (!selectedRemote) return;
    const entry = selectedRemote;
    const source = remoteEntryPath(entry, remotePath);
    const destination = await chooseDownloadDestination(entry);
    if (!destination) return;
    const existing = await localEntryAt(destination);
    const start = async (
      replaceTarget: boolean,
      resolvedDestination = destination,
    ) => {
      if (replaceTarget && existing) {
        await invoke("local_delete", { path: resolvedDestination });
      }
      const succeeded = await transfer(entry.name, "download", {
        action: "download",
        remotePath: source,
        localPath: resolvedDestination,
        overwrite: false,
        transferKey: crypto.randomUUID(),
      });
      if (succeeded) await refreshLocal();
    };
    if (!existing) {
      await start(false);
      return;
    }
    if (entry.kind !== "directory") {
      await start(true);
      return;
    }
    const destinationDirectory = parentPath(destination);
    const siblingNames = await localNamesAt(destinationDirectory);
    setDialog({
      type: "conflict",
      title: "Download conflict",
      source,
      destination,
      submit: async (resolution) => {
        setDialog(undefined);
        if (resolution === "skip") return;
        await start(
          resolution === "replace",
          resolution === "copy"
            ? localJoin(
                destinationDirectory,
                duplicateName(
                  entry.name,
                  siblingNames,
                  true,
                ),
              )
            : destination,
        );
      },
    });
  }

  async function downloadBatch(
    entries: Array<SftpEntry & { path: string }>,
    removesSourcesOnSuccess = false,
    destinationDirectory = localPath,
  ) {
    const candidates = await Promise.all(
      entries.map(async (entry) => {
        const destination = localJoin(destinationDirectory, entry.name);
        return {
          entry,
          destination,
          existing: await localEntryAt(destination),
        };
      }),
    );
    const conflicts = candidates.flatMap(
      ({ entry, destination, existing }) =>
        existing
          ? [
              {
                id: entry.path,
                name: entry.name,
                source: entry.path,
                destination,
                existingKind: existing.kind,
              },
            ]
          : [],
    );
    const start = async (
      resolutions: Record<string, ConflictResolution>,
    ) => {
      const siblingNames = await localNamesAt(destinationDirectory);
      const planned = candidates.flatMap(
        ({ entry, destination, existing }) => {
          const resolution = existing
            ? resolutions[entry.path] ?? "skip"
            : "replace";
          if (resolution === "skip") return [];
          let resolvedDestination = destination;
          if (resolution === "copy") {
            const name = duplicateName(
              entry.name,
              siblingNames,
              entry.kind === "directory",
            );
            siblingNames.push(name);
            resolvedDestination = localJoin(destinationDirectory, name);
          }
          return [
            {
              entry,
              destination: resolvedDestination,
              replaceTarget: resolution === "replace" && existing != null,
            },
          ];
        },
      );
      const results = await Promise.all(
        planned.map(async ({ entry, destination, replaceTarget }) => {
          if (replaceTarget) {
            await invoke("local_delete", { path: destination });
          }
          const succeeded = await transfer(entry.name, "download", {
            action: "download",
            remotePath: entry.path,
            localPath: destination,
            overwrite: false,
            transferKey: crypto.randomUUID(),
          });
          if (succeeded && removesSourcesOnSuccess) {
            await request({
              action: "delete",
              path: entry.path,
              kind: entry.kind,
            });
          }
          return succeeded;
        }),
      );
      const changed = results.some(Boolean);
      if (changed) {
        if (removesSourcesOnSuccess) {
          setSelectedRemote(undefined);
          setSelectedRemotePaths([]);
          await refreshRemote();
        }
        await refreshLocal();
      }
    };
    if (conflicts.length === 0) {
      await start({});
      return;
    }
    setDialog({
      type: "batchConflict",
      title: removesSourcesOnSuccess
        ? "Batch move conflicts"
        : "Batch download conflicts",
      conflicts,
      submit: async (resolutions) => {
        setDialog(undefined);
        await start(resolutions);
      },
    });
  }

  async function moveLocalToRemote() {
    if (selectedLocalItems.length > 1) {
      await uploadBatch(selectedLocalItems, true);
      return;
    }
    if (!selectedLocal) return;
    const source = selectedLocal;
    const destination = remoteJoin(remotePath, source.name);
    const existing = remoteEntries.find((entry) => entry.name === source.name);
    const start = async (
      replaceTarget: boolean,
      resolvedDestination = destination,
    ) => {
      if (replaceTarget && existing) {
        await request({
          action: "delete",
          path: destination,
          kind: existing.kind,
        });
      }
      const succeeded = await transfer(source.name, "upload", {
        action: "upload",
        localPath: source.path,
        remotePath: resolvedDestination,
        overwrite: false,
        transferKey: crypto.randomUUID(),
      });
      if (!succeeded) return;
      await invoke("local_delete", { path: source.path });
      setSelectedLocal(undefined);
      await refreshLocal();
      await refreshRemote();
    };
    if (!existing) {
      await start(false);
      return;
    }
    setDialog({
      type: "conflict",
      title: "Move conflict",
      source: source.path,
      destination,
      submit: async (resolution) => {
        setDialog(undefined);
        if (resolution === "skip") return;
        await start(
          resolution === "replace",
          resolution === "copy"
            ? remoteJoin(
                remotePath,
                duplicateName(
                  source.name,
                  remoteEntries.map((entry) => entry.name),
                  source.kind === "directory",
                ),
              )
            : destination,
        );
      },
    });
  }

  async function moveRemoteToLocal() {
    if (selectedRemoteItems.length > 1) {
      await downloadBatch(selectedRemoteItems, true);
      return;
    }
    if (!selectedRemote) return;
    const entry = selectedRemote;
    const source = remoteEntryPath(entry, remotePath);
    const destination = localJoin(localPath, entry.name);
    const existing = localEntries.find((item) => item.name === entry.name);
    const start = async (
      replaceTarget: boolean,
      resolvedDestination = destination,
    ) => {
      if (replaceTarget && existing) {
        await invoke("local_delete", { path: destination });
      }
      const succeeded = await transfer(entry.name, "download", {
        action: "download",
        remotePath: source,
        localPath: resolvedDestination,
        overwrite: false,
        transferKey: crypto.randomUUID(),
      });
      if (!succeeded) return;
      await request({
        action: "delete",
        path: source,
        kind: entry.kind,
      });
      setSelectedRemote(undefined);
      await refreshLocal();
      await refreshRemote();
    };
    if (!existing) {
      await start(false);
      return;
    }
    setDialog({
      type: "conflict",
      title: "Move conflict",
      source,
      destination,
      submit: async (resolution) => {
        setDialog(undefined);
        if (resolution === "skip") return;
        await start(
          resolution === "replace",
          resolution === "copy"
            ? localJoin(
                localPath,
                duplicateName(
                  entry.name,
                  localEntries.map((item) => item.name),
                  entry.kind === "directory",
                ),
              )
            : destination,
        );
      },
    });
  }

  async function transfer(
    name: string,
    direction: "upload" | "download",
    requestValue: Record<string, unknown>,
  ): Promise<boolean> {
    const transferId = crypto.randomUUID();
    const transferKey = String(requestValue.transferKey ?? transferId);
    setTransfers((items) => [
      ...items,
      {
        id: transferId,
        transferKey,
        name,
        direction,
        transferred: 0,
        bytesPerSecond: 0,
        sampledAt: Date.now(),
        sampledBytes: 0,
        state: "running",
      },
    ]);
    try {
      const result = await request<{ bytesTransferred: number }>(requestValue);
      setTransfers((items) =>
        items.map((item) =>
          item.id === transferId
            ? {
                ...item,
                transferred: result.bytesTransferred,
                total: result.bytesTransferred,
                state: "completed",
              }
            : item,
        ),
      );
      return true;
    } catch (reason) {
      setTransfers((items) =>
        items.map((item) =>
          item.id === transferId
            ? item.state === "cancelled"
              ? item
              : { ...item, state: "failed", error: message(reason) }
            : item,
        ),
      );
      return false;
    }
  }

  async function controlTransfer(
    transfer: TransferRecord,
    action: "pause" | "resume" | "cancel",
  ) {
    try {
      await request({ action, transferKey: transfer.transferKey });
      setTransfers((items) =>
        items.map((item) =>
          item.id === transfer.id
            ? {
                ...item,
                state:
                  action === "pause"
                    ? "paused"
                    : action === "resume"
                      ? "running"
                      : "cancelled",
                ...(action === "resume"
                  ? {
                      bytesPerSecond: 0,
                      sampledAt: Date.now(),
                      sampledBytes: item.transferred,
                    }
                  : action === "pause"
                    ? { bytesPerSecond: 0 }
                    : {}),
              }
            : item,
        ),
      );
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function createRemoteFolder() {
    setDialog({
      type: "input",
      title: "New remote folder",
      label: "Folder name",
      value: "",
      submit: async (name) => {
        setDialog(undefined);
        if (!name.trim()) return;
        await request({
          action: "mkdir",
          path: remoteJoin(remotePath, name.trim()),
        });
        await refreshRemote();
      },
    });
  }

  async function createRemoteFile() {
    setDialog({
      type: "input",
      title: "New remote file",
      label: "File name",
      value: "",
      submit: async (name) => {
        setDialog(undefined);
        if (!name.trim()) return;
        await request({
          action: "writeText",
          path: remoteJoin(remotePath, name.trim()),
          content: "",
          overwrite: false,
        });
        await refreshRemote();
      },
    });
  }

  async function deleteRemote() {
    const targets =
      selectedRemoteItems.length > 0
        ? selectedRemoteItems
        : selectedRemote
          ? [selectedRemote]
          : [];
    if (targets.length === 0) return;
    setDialog({
      type: "confirm",
      title: "Delete remote item",
      message:
        targets.length === 1
          ? `Delete ${targets[0].name}? This cannot be undone.`
          : `Delete ${targets.length} selected remote items? This cannot be undone.`,
      submit: async () => {
        setDialog(undefined);
        for (const target of targets) {
          await request({
            action: "delete",
            path: remoteEntryPath(target, remotePath),
            kind: target.kind,
          });
        }
        setSelectedRemote(undefined);
        setSelectedRemotePaths([]);
        await refreshRemote();
      },
    });
  }

  function renameRemote() {
    if (!selectedRemote) return;
    setDialog({
      type: "input",
      title: "Rename remote item",
      label: "New name",
      value: selectedRemote.name,
      submit: async (name) => {
        setDialog(undefined);
        if (!name.trim() || name === selectedRemote.name) return;
        await request({
          action: "rename",
          oldPath: remoteEntryPath(selectedRemote, remotePath),
          newPath: remoteJoin(
            remoteParentPath(remoteEntryPath(selectedRemote, remotePath)),
            name.trim(),
          ),
        });
        setSelectedRemote(undefined);
        await refreshRemote();
      },
    });
  }

  function chmodRemote() {
    if (!selectedRemote) return;
    const current = selectedRemote.permissions
      ? (selectedRemote.permissions & 0o7777).toString(8)
      : "644";
    setDialog({
      type: "input",
      title: "Change permissions",
      label: "Octal permissions",
      value: current,
      submit: async (value) => {
        if (!/^[0-7]{3,4}$/.test(value.trim())) return;
        const permissions = Number.parseInt(value, 8);
        setDialog(undefined);
        await request({
          action: "chmod",
          path: remoteEntryPath(selectedRemote, remotePath),
          permissions,
        });
        await refreshRemote();
      },
    });
  }

  async function duplicateRemote() {
    if (!selectedRemote) return;
    const source = remoteEntryPath(selectedRemote, remotePath);
    const sourceParent = remoteParentPath(source);
    const siblingNames = (
      remoteTreeChildren[sourceParent] ?? remoteWithPaths
    ).map((entry) => entry.name);
    const destination = remoteJoin(
      sourceParent,
      duplicateName(
        selectedRemote.name,
        siblingNames,
        selectedRemote.kind === "directory",
      ),
    );
    const temporary = await invoke<string>("local_temporary_path", {
      name: selectedRemote.name,
    });
    try {
      const downloaded = await transfer(selectedRemote.name, "download", {
        action: "download",
        remotePath: source,
        localPath: temporary,
        overwrite: true,
        transferKey: crypto.randomUUID(),
      });
      if (!downloaded) return;
      const uploaded = await transfer(selectedRemote.name, "upload", {
        action: "upload",
        localPath: temporary,
        remotePath: destination,
        overwrite: false,
        transferKey: crypto.randomUUID(),
      });
      if (uploaded) await refreshRemote();
    } finally {
      await invoke("local_delete", { path: temporary }).catch(() => undefined);
    }
  }

  async function chooseFilesToUpload() {
    const selection = await open({
      multiple: true,
      directory: false,
      title: t("Upload..."),
    });
    const paths =
      typeof selection === "string"
        ? [selection]
        : selection ?? [];
    if (paths.length === 0) return;
    const entries = await Promise.all(
      paths.map((path) => invoke<LocalEntry>("local_entry", { path })),
    );
    await uploadBatch(entries);
  }

  async function openRemoteExternally(
    entry = selectedRemote,
    application?: string,
  ) {
    if (!entry || entry.kind !== "file") return;
    const source = remoteEntryPath(entry, remotePath);
    const localPath = await invoke<string>("local_temporary_path", {
      name: entry.name,
    });
    await request({
      action: "download",
      remotePath: source,
      localPath,
      overwrite: true,
      transferKey: crypto.randomUUID(),
    });
    const modifiedAt = await invoke<number>("local_modified_at", {
      path: localPath,
    });
    await invoke(application ? "local_open_with" : "local_open", {
      path: localPath,
      application,
    });
    setExternalEdits((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        remotePath: source,
        localPath,
        modifiedAt,
        syncing: false,
      },
    ]);
  }

  async function openRemoteWithSelectedApp(
    entry = selectedRemote,
  ) {
    if (!entry || entry.kind !== "file") return;
    const application = await open({
      multiple: false,
      directory: false,
      title: t("Open With..."),
    });
    if (typeof application !== "string") return;
    await openRemoteExternally(entry, application);
  }

  function copyLocalSelection(operation: "copy" | "cut") {
    const entries =
      selectedLocalItems.length > 0
        ? selectedLocalItems
        : selectedLocal
          ? [selectedLocal]
          : [];
    if (entries.length > 0) {
      setClipboard({ side: "local", operation, entries });
    }
  }

  async function pasteLocalClipboard() {
    if (clipboard?.side !== "local") return;
    const names = localEntries.map((entry) => entry.name);
    for (const entry of clipboard.entries) {
      const sameDirectory = parentPath(entry.path) === localPath;
      const name =
        names.includes(entry.name) || sameDirectory
          ? duplicateName(
              entry.name,
              names,
              entry.kind === "directory",
            )
          : entry.name;
      names.push(name);
      await invoke(
        clipboard.operation === "cut"
          ? "local_move_to"
          : "local_copy_to",
        {
          source: entry.path,
          destination: localJoin(localPath, name),
        },
      );
    }
    if (clipboard.operation === "cut") setClipboard(undefined);
    await refreshLocal();
  }

  function copyRemoteSelection(operation: "copy" | "cut") {
    const entries =
      selectedRemoteItems.length > 0
        ? selectedRemoteItems
        : selectedRemote
          ? [
              {
                ...selectedRemote,
                path: remoteEntryPath(selectedRemote, remotePath),
              },
            ]
          : [];
    if (entries.length > 0) {
      setClipboard({ side: "remote", operation, entries });
    }
  }

  async function pasteRemoteClipboard() {
    if (clipboard?.side !== "remote") return;
    const names = remoteEntries.map((entry) => entry.name);
    for (const entry of clipboard.entries) {
      const originalDestination = remoteJoin(remotePath, entry.name);
      const name =
        names.includes(entry.name) || entry.path === originalDestination
          ? duplicateName(
              entry.name,
              names,
              entry.kind === "directory",
            )
          : entry.name;
      names.push(name);
      const destination = remoteJoin(remotePath, name);
      if (clipboard.operation === "cut") {
        await request({
          action: "rename",
          oldPath: entry.path,
          newPath: destination,
        });
        continue;
      }
      const temporary = await invoke<string>("local_temporary_path", {
        name: entry.name,
      });
      try {
        const downloaded = await transfer(entry.name, "download", {
          action: "download",
          remotePath: entry.path,
          localPath: temporary,
          overwrite: true,
          transferKey: crypto.randomUUID(),
        });
        if (downloaded) {
          await transfer(entry.name, "upload", {
            action: "upload",
            localPath: temporary,
            remotePath: destination,
            overwrite: false,
            transferKey: crypto.randomUUID(),
          });
        }
      } finally {
        await invoke("local_delete", { path: temporary }).catch(
          () => undefined,
        );
      }
    }
    if (clipboard.operation === "cut") setClipboard(undefined);
    await refreshRemote();
  }

  function createLocalFolder() {
    setDialog({
      type: "input",
      title: "New local folder",
      label: "Folder name",
      value: "",
      submit: async (name) => {
        setDialog(undefined);
        if (!name.trim()) return;
        await invoke("local_mkdir", {
          path: localJoin(localPath, name.trim()),
        });
        await refreshLocal();
      },
    });
  }

  function createLocalFile() {
    setDialog({
      type: "input",
      title: "New local file",
      label: "File name",
      value: "",
      submit: async (name) => {
        setDialog(undefined);
        if (!name.trim()) return;
        await invoke("local_create_file", {
          path: localJoin(localPath, name.trim()),
        });
        await refreshLocal();
      },
    });
  }

  function renameLocal() {
    if (!selectedLocal) return;
    setDialog({
      type: "input",
      title: "Rename local item",
      label: "New name",
      value: selectedLocal.name,
      submit: async (name) => {
        setDialog(undefined);
        if (!name.trim() || name === selectedLocal.name) return;
        await invoke("local_rename", {
          path: selectedLocal.path,
          newName: name.trim(),
        });
        setSelectedLocal(undefined);
        await refreshLocal();
      },
    });
  }

  function deleteLocal() {
    const targets =
      selectedLocalItems.length > 0
        ? selectedLocalItems
        : selectedLocal
          ? [selectedLocal]
          : [];
    if (targets.length === 0) return;
    setDialog({
      type: "confirm",
      title: "Delete local item",
      message:
        targets.length === 1
          ? `Delete ${targets[0].name}? This cannot be undone.`
          : `Delete ${targets.length} selected local items? This cannot be undone.`,
      submit: async () => {
        setDialog(undefined);
        for (const target of targets) {
          await invoke("local_delete", { path: target.path });
        }
        setSelectedLocal(undefined);
        setSelectedLocalPaths([]);
        await refreshLocal();
      },
    });
  }

  async function duplicateLocal() {
    if (!selectedLocal) return;
    await invoke("local_duplicate", { path: selectedLocal.path });
    await refreshLocal();
  }

  async function openRemoteText(entry: SftpEntry & { path?: string }) {
    const path = remoteEntryPath(entry, remotePath);
    try {
      const result = await request<{ text: string }>({
        action: "readText",
        path,
      });
      if (
        new TextEncoder().encode(result.text).byteLength >
        2 * 1024 * 1024
      ) {
        setError(t("Text preview is limited to files up to 2 MB."));
        return;
      }
      setTextDraft(remoteTextDraft(entry.name, path, result.text));
    } catch (reason) {
      setError(message(reason));
    }
  }

  async function saveRemoteTextDraft() {
    if (!textDraft) return;
    const draft = textDraft;
    setTextDraft(undefined);
    try {
      await request({
        action: "writeText",
        path: draft.path,
        content: draft.text,
        overwrite: true,
      });
      await refreshRemote();
    } catch (reason) {
      setError(message(reason));
    }
  }

  return (
    <div className={`sftp-panel ${host ? "is-remote" : "is-local"} ${
      externalDragActive ? "is-drop-target" : ""
    }`}>
      {externalDragActive ? (
        <div className="sftp-drop-overlay">
          <ArrowUpFromLine size={22} />
          <strong>{t("Drop to upload")}</strong>
          <span>{remotePath}</span>
        </div>
      ) : null}
      {host ? (
        <>
          <header className="sftp-remote-header">
            <div className="sftp-remote-titlebar">
              <strong>{t("Remote Files")}</strong>
              <div>
                <button
                  type="button"
                  title={t("Back")}
                  disabled={remoteBackRef.current.length === 0}
                  onClick={goBackRemote}
                >
                  <ArrowLeft size={17} />
                </button>
                <button
                  type="button"
                  title={t("Go forward")}
                  disabled={remoteForwardRef.current.length === 0}
                  onClick={goForwardRemote}
                >
                  <ArrowRight size={17} />
                </button>
                <button
                  type="button"
                  title={t("Up")}
                  onClick={() => navigateRemote(remoteParentPath(remotePath))}
                >
                  <ArrowUp size={17} />
                </button>
                <button
                  type="button"
                  title={t("Refresh remote")}
                  onClick={() => void refreshRemote()}
                >
                  <RefreshCw
                    className={loading ? "is-spinning" : ""}
                    size={17}
                  />
                </button>
              </div>
            </div>
            <div className="sftp-remote-pathbar">
              <button
                type="button"
                title={t("Go to Home Directory")}
                onClick={() => navigateRemote(".")}
              >
                <Home size={18} />
              </button>
              <input
                aria-label={t("Path")}
                value={remotePathDraft}
                onChange={(event) => setRemotePathDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    navigateRemote(remotePathDraft.trim() || ".");
                  }
                }}
              />
              <button
                type="button"
                title={t("Go to Current Terminal Directory")}
                disabled={!session.workingDirectory}
                onClick={() => {
                  if (session.workingDirectory) {
                    navigateRemote(session.workingDirectory);
                  }
                }}
              >
                <Send size={17} />
              </button>
              <button
                className="sftp-go-button"
                type="button"
                onClick={() => navigateRemote(remotePathDraft.trim() || ".")}
              >
                {t("Go")}
              </button>
            </div>
          </header>
          <div className="sftp-remote-controls">
            <label>
              <Search size={15} />
              <input
                placeholder={t("Filter")}
                value={remoteFilter}
                onChange={(event) => setRemoteFilter(event.target.value)}
              />
            </label>
            <div className="sftp-view-picker">
              <button
                className={remoteViewMode === "list" ? "is-active" : ""}
                type="button"
                onClick={() => setRemoteViewMode("list")}
              >
                {t("List")}
              </button>
              <button
                className={remoteViewMode === "tree" ? "is-active" : ""}
                type="button"
                onClick={() => setRemoteViewMode("tree")}
              >
                {t("Tree")}
              </button>
            </div>
            <button
              className="sftp-more-button"
              type="button"
              title={t("More")}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setRemoteMenu({
                  x: rect.right - 232,
                  y: rect.bottom + 4,
                  kind: "more",
                });
              }}
            >
              <MoreHorizontal size={18} />
              <ChevronDown size={12} />
            </button>
          </div>
          <RemoteFilePane
            entries={visibleRemoteEntries}
            error={error}
            loading={loading}
            mode={remoteViewMode}
            path={remotePath}
            selectedPaths={selectedRemotePaths}
            expandedPaths={expandedRemotePaths}
            onSelect={(entry, additive) => {
              setSelectedRemotePaths((current) => {
                const next = updateSelection(current, entry.path, additive);
                setSelectedRemote(
                  next.includes(entry.path)
                    ? entry
                    : displayedRemoteEntries.find(
                        (candidate) =>
                          candidate.path === next[next.length - 1],
                      ),
                );
                return next;
              });
            }}
            onOpen={(entry) => {
              if (entry.name === "..") {
                navigateRemote(remoteParentPath(remotePath));
              } else if (entry.kind === "directory") {
                if (remoteViewMode === "tree") void toggleRemoteTree(entry);
                else navigateRemote(entry.path);
              } else {
                void openRemoteText(entry);
              }
            }}
            onToggle={(entry) => void toggleRemoteTree(entry)}
            onRetry={() => void refreshRemote()}
            onContextMenu={(entry, event) => {
              event.preventDefault();
              setSelectedRemote(entry);
              setSelectedRemotePaths([entry.path]);
              setRemoteMenu({
                x: event.clientX,
                y: event.clientY,
                entry,
                kind: "context",
              });
            }}
          />
          <div className="sftp-pane-footer">
            <span className="sftp-drop-label">
              <ArrowUpFromLine size={14} />
              {t("Drop files here to upload")}
            </span>
            <span>
              {visibleRemoteEntries.length + (remotePath === "/" ? 0 : 1)}{" "}
              {t("items")}
            </span>
            <code>{remotePath}</code>
          </div>
        </>
      ) : (
        <>
          <div className="sftp-toolbar sftp-file-actions">
            <span>{t("Local")}</span>
            <button type="button" title={t("New local folder")} onClick={createLocalFolder}>
              <FolderPlus size={13} />
            </button>
            <button type="button" title={t("New local file")} onClick={createLocalFile}>
              <FilePlus2 size={13} />
            </button>
            <button type="button" title={t("Rename local item")} onClick={renameLocal} disabled={!selectedLocal || hasMultipleLocal}>
              <Pencil size={13} />
            </button>
            <button type="button" title={t("Duplicate local item")} onClick={duplicateLocal} disabled={!selectedLocal || hasMultipleLocal}>
              <Copy size={13} />
            </button>
            <button type="button" title={t("Copy")} onClick={() => copyLocalSelection("copy")} disabled={!selectedLocal}>
              <Copy size={13} />
            </button>
            <button type="button" title={t("Cut")} onClick={() => copyLocalSelection("cut")} disabled={!selectedLocal}>
              <Scissors size={13} />
            </button>
            <button type="button" title={t("Paste")} onClick={() => void pasteLocalClipboard()} disabled={clipboard?.side !== "local"}>
              <ClipboardPaste size={13} />
            </button>
            <button type="button" title={t("Delete local item")} onClick={deleteLocal} disabled={!selectedLocal}>
              <Trash2 size={13} />
            </button>
            <button type="button" title={t("Refresh local")} onClick={() => void refreshLocal()}>
              <RefreshCw size={13} />
            </button>
            <button
              className={preferences.sftpShowsHiddenFiles ? "is-active" : ""}
              type="button"
              title={t("Show hidden files")}
              onClick={() =>
                void updatePreferences({
                  ...preferences,
                  sftpShowsHiddenFiles: !preferences.sftpShowsHiddenFiles,
                })
              }
            >
              {preferences.sftpShowsHiddenFiles ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          </div>
          <div className="sftp-columns is-local-only">
            <FilePane
              title={t("Local")}
              path={localPath}
              filter={localFilter}
              onFilterChange={setLocalFilter}
              onPathChange={navigateLocal}
              onBack={goBackLocal}
              onForward={goForwardLocal}
              onHome={() => {
                void invoke<string>("local_home").then(navigateLocal);
              }}
              entries={visibleLocalEntries}
              selectedPaths={selectedLocalPaths}
              onSelect={(entry, additive) => {
                setSelectedLocalPaths((current) => {
                  const next = updateSelection(current, entry.path, additive);
                  setSelectedLocal(
                    next.includes(entry.path)
                      ? entry
                      : localEntries.find(
                          (candidate) =>
                            candidate.path === next[next.length - 1],
                        ),
                  );
                  return next;
                });
              }}
              onOpen={(entry) => {
                if (entry.kind === "directory") navigateLocal(entry.path);
                else void invoke("local_open", { path: entry.path });
              }}
            />
          </div>
          <div className="sftp-pane-footer">
            <span className="sftp-drop-label">{t("Local Files")}</span>
            <span>{visibleLocalEntries.length} {t("items")}</span>
            <code>{localPath}</code>
          </div>
        </>
      )}
      {error && (!host || remoteEntries.length > 0) ? (
        <div className="sftp-error">{error}</div>
      ) : null}
      {externalEdits.length > 0 ? (
        <div className="external-edit-status">
          {externalEdits.map((edit) => (
            <span key={edit.id}>
              {edit.syncing ? t("Syncing") : t("Watching")} · {edit.remotePath}
            </span>
          ))}
        </div>
      ) : null}
      {sidebarTransfers.length > 0 ? (
        <div className="transfer-center">
          <div className="transfer-title">
            <span>
              {t("Transfers")}{" "}
              <strong>({sidebarTransfers.length})</strong>
            </span>
          </div>
          <div className="transfer-list">
            {sidebarTransfers.slice(-4).map((transfer) => (
              <article className="transfer-row" key={transfer.id}>
                <span className="transfer-direction-icon">
                  {transfer.direction === "upload" ? (
                    <ArrowUpFromLine size={13} />
                  ) : (
                    <ArrowDownToLine size={13} />
                  )}
                </span>
                <div className="transfer-row-content">
                  <div>
                    <strong>{transfer.name}</strong>
                    <span>{t(transferStateTitle(transfer.state))}</span>
                  </div>
                  <progress
                    max={Math.max(
                      transfer.total ?? transfer.transferred,
                      1,
                    )}
                    value={transfer.transferred}
                  />
                  <small>{transferProgressText(transfer)}</small>
                </div>
                {transfer.state === "running" ? (
                  <button
                    aria-label={t("Pause")}
                    className="transfer-control"
                    type="button"
                    onClick={() =>
                      void controlTransfer(transfer, "pause")
                    }
                  >
                    <Pause size={14} />
                  </button>
                ) : transfer.state === "paused" ? (
                  <button
                    aria-label={t("Resume")}
                    className="transfer-control"
                    type="button"
                    onClick={() =>
                      void controlTransfer(transfer, "resume")
                    }
                  >
                    <Play size={14} />
                  </button>
                ) : null}
                {transfer.state === "running" ||
                transfer.state === "paused" ? (
                  <button
                    aria-label={t("Cancel")}
                    className="transfer-control is-cancel"
                    type="button"
                    onClick={() =>
                      void controlTransfer(transfer, "cancel")
                    }
                  >
                    <X size={15} strokeWidth={2.2} />
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}
      {textDraft ? (
        <RemoteTextEditorDialog
          draft={textDraft}
          onCancel={() => setTextDraft(undefined)}
          onChange={(text) => setTextDraft({ ...textDraft, text })}
          onSave={() => void saveRemoteTextDraft()}
        />
      ) : null}
      {active && remoteMenu
        ? createPortal(
            <div
              className="sftp-context-menu"
              role="menu"
              style={remoteMenuPosition(
                remoteMenu.x,
                remoteMenu.y,
                232,
                remoteMenu.kind === "context" ? 430 : 420,
                window.innerWidth,
                window.innerHeight,
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              {remoteMenu.kind === "context" && remoteMenu.entry ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      const entry = remoteMenu.entry!;
                      setRemoteMenu(undefined);
                      if (entry.name === "..") {
                        navigateRemote(remoteParentPath(remotePath));
                      } else if (entry.kind === "directory") {
                        navigateRemote(entry.path);
                      } else {
                        void openRemoteText(entry);
                      }
                    }}
                  >
                    {t("Open")}
                  </button>
                  {remoteMenu.entry.name !== ".." ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoteMenu(undefined);
                          void download();
                        }}
                      >
                        {t("Download")}
                      </button>
                      {remoteMenu.entry.kind === "file" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              const entry = remoteMenu.entry!;
                              setRemoteMenu(undefined);
                              void openRemoteText(entry);
                            }}
                          >
                            {t("View/Edit")}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const entry = remoteMenu.entry!;
                              setRemoteMenu(undefined);
                              void openRemoteExternally(entry);
                            }}
                          >
                            {t("Open with Default App")}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const entry = remoteMenu.entry!;
                              setRemoteMenu(undefined);
                              void openRemoteWithSelectedApp(entry);
                            }}
                          >
                            {t("Open With...")}
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          const entry = remoteMenu.entry!;
                          setClipboard({
                            side: "remote",
                            operation: "copy",
                            entries: [entry],
                          });
                          setRemoteMenu(undefined);
                        }}
                      >
                        {t("Copy")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const entry = remoteMenu.entry!;
                          setClipboard({
                            side: "remote",
                            operation: "cut",
                            entries: [entry],
                          });
                          setRemoteMenu(undefined);
                        }}
                      >
                        {t("Cut")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoteMenu(undefined);
                          renameRemote();
                        }}
                      >
                        {t("Rename")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoteMenu(undefined);
                          chmodRemote();
                        }}
                      >
                        {t("Chmod")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            remoteMenu.entry!.path,
                          );
                          setRemoteMenu(undefined);
                        }}
                      >
                        {t("Copy Path")}
                      </button>
                      <span className="sftp-menu-divider" />
                      <button
                        className="is-destructive"
                        type="button"
                        onClick={() => {
                          setRemoteMenu(undefined);
                          void deleteRemote();
                        }}
                      >
                        {t("Delete")}
                      </button>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void updatePreferences({
                        ...preferences,
                        sftpShowsHiddenFiles:
                          !preferences.sftpShowsHiddenFiles,
                      });
                      setRemoteMenu(undefined);
                    }}
                  >
                    {t(
                      preferences.sftpShowsHiddenFiles
                        ? "Hide Hidden Files"
                        : "Show Hidden Files",
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAutoSyncExternalEdits((value) => !value);
                      setRemoteMenu(undefined);
                    }}
                  >
                    {t(
                      autoSyncExternalEdits
                        ? "Disable Auto Sync"
                        : "Enable Auto Sync",
                    )}
                  </button>
                  <span className="sftp-menu-divider" />
                  <button
                    type="button"
                    onClick={() => {
                      setRemoteMenu(undefined);
                      void chooseFilesToUpload();
                    }}
                  >
                    {t("Upload...")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRemoteMenu(undefined);
                      void createRemoteFolder();
                    }}
                  >
                    {t("New Folder")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRemoteMenu(undefined);
                      void createRemoteFile();
                    }}
                  >
                    {t("New File")}
                  </button>
                  <span className="sftp-menu-divider" />
                  <details className="sftp-bookmark-menu">
                    <summary>
                      <span>{t("Bookmarks")}</span>
                      <ChevronRight size={13} />
                    </summary>
                    <button
                      type="button"
                      onClick={() => {
                        setRemoteBookmarks((current) =>
                          current.includes(remotePath)
                            ? current
                            : [...current, remotePath],
                        );
                        setRemoteMenu(undefined);
                      }}
                    >
                      {t("Add Current Path")}
                    </button>
                    <span className="sftp-menu-divider" />
                    {remoteBookmarks.length === 0 ? (
                      <span className="sftp-menu-empty">
                        {t("No Bookmarks")}
                      </span>
                    ) : null}
                    {remoteBookmarks.map((path) => (
                      <button
                        type="button"
                        key={path}
                        title={path}
                        onClick={() => {
                          navigateRemote(path);
                          setRemoteMenu(undefined);
                        }}
                      >
                        <span className="sftp-menu-bookmark">{path}</span>
                      </button>
                    ))}
                  </details>
                  <span className="sftp-menu-divider" />
                  <button
                    type="button"
                    disabled={!selectedRemote || hasMultipleRemote}
                    onClick={() => {
                      setRemoteMenu(undefined);
                      renameRemote();
                    }}
                  >
                    {t("Rename")}
                  </button>
                  <button
                    type="button"
                    disabled={!selectedRemote || hasMultipleRemote}
                    onClick={() => {
                      setRemoteMenu(undefined);
                      chmodRemote();
                    }}
                  >
                    {t("Chmod")}
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
      {active && dialog
        ? createPortal(
            <SftpDialog
              key={`${dialog.type}:${dialog.title}`}
              dialog={dialog}
              onClose={() => setDialog(undefined)}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function RemoteTextEditorDialog({
  draft,
  onCancel,
  onChange,
  onSave,
}: {
  draft: RemoteTextDraft;
  onCancel: () => void;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const t = useTranslation();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="sftp-text-editor-backdrop" role="presentation">
      <section
        aria-label={draft.name}
        aria-modal="true"
        className="sftp-text-editor"
        role="dialog"
      >
        <header>
          <strong title={draft.path}>{draft.name}</strong>
          <div>
            <button
              className="secondary-button"
              type="button"
              onClick={onCancel}
            >
              {t("Cancel")}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={onSave}
            >
              {t("Save")}
            </button>
          </div>
        </header>
        <textarea
          autoFocus
          aria-label={draft.name}
          spellCheck={false}
          value={draft.text}
          onChange={(event) => onChange(event.target.value)}
        />
      </section>
    </div>,
    document.body,
  );
}

function RemoteFilePane({
  entries,
  error,
  loading,
  mode,
  path,
  selectedPaths,
  expandedPaths,
  onSelect,
  onOpen,
  onRetry,
  onToggle,
  onContextMenu,
}: {
  entries: Array<SftpEntry & { path: string; depth?: number }>;
  error?: string;
  loading: boolean;
  mode: "list" | "tree";
  path: string;
  selectedPaths: string[];
  expandedPaths: string[];
  onSelect: (
    entry: SftpEntry & { path: string },
    additive: boolean,
  ) => void;
  onOpen: (entry: SftpEntry & { path: string }) => void;
  onRetry: () => void;
  onToggle: (entry: SftpEntry & { path: string }) => void;
  onContextMenu: (
    entry: SftpEntry & { path: string },
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const t = useTranslation();
  const parent: SftpEntry & { path: string } = {
    name: "..",
    path: remoteParentPath(path),
    kind: "directory",
    size: 0,
  };
  const rows = path === "/" ? entries : [parent, ...entries];
  return (
    <section className="sftp-remote-files">
      <div className="sftp-remote-list-header">
        <span>{t("Name")}</span>
        <span>{t("Size")}</span>
        <span>{t("Modified")}</span>
      </div>
      <div className="sftp-remote-list">
        {rows.map((entry) => {
          const isParent = entry.name === "..";
          const depthValue = (entry as { depth?: unknown }).depth;
          const depth = typeof depthValue === "number" ? depthValue : 0;
          const canExpand =
            mode === "tree" && entry.kind === "directory" && !isParent;
          const isExpanded = expandedPaths.includes(entry.path);
          return (
            <button
              className={`sftp-remote-row ${
                selectedPaths.includes(entry.path) && !isParent
                  ? "is-selected"
                  : ""
              }`}
              key={isParent ? `${path}/..` : entry.path}
              type="button"
              onClick={(event) => {
                if (!isParent) {
                  onSelect(entry, event.metaKey || event.ctrlKey);
                }
              }}
              onDoubleClick={() => onOpen(entry)}
              onContextMenu={(event) => onContextMenu(entry, event)}
            >
              <span
                className="sftp-remote-name"
                style={{ paddingLeft: depth * 16 }}
              >
                <span className="sftp-tree-toggle">
                  {canExpand ? (
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggle(entry);
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                    </span>
                  ) : null}
                </span>
                {entry.kind === "directory" ? (
                  <Folder className="is-directory" size={17} />
                ) : entry.kind === "file" ? (
                  <File size={17} />
                ) : (
                  <FilePenLine size={17} />
                )}
                <span title={entry.name}>{entry.name}</span>
              </span>
              <small>
                {entry.kind === "file" ? formatBytes(entry.size) : "-"}
              </small>
              <small>{formatModifiedAt(entry.modifiedAt)}</small>
            </button>
          );
        })}
        {loading ? (
          <div className="sftp-loading-state">{t("Loading...")}</div>
        ) : null}
        {!loading && error && entries.length === 0 ? (
          <div className="sftp-remote-error-state">
            <strong>{t("SFTP Connection Failed")}</strong>
            <span>{error}</span>
            <button type="button" onClick={onRetry}>{t("Retry")}</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function FilePane<T extends LocalEntry | (SftpEntry & { path: string })>({
  title,
  path,
  filter,
  onFilterChange,
  onPathChange,
  onBack,
  onForward,
  onHome,
  entries,
  selectedPaths,
  onSelect,
  onOpen,
}: {
  title: string;
  path: string;
  filter: string;
  onFilterChange: (value: string) => void;
  onPathChange: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  entries: T[];
  selectedPaths: string[];
  onSelect: (entry: T, additive: boolean) => void;
  onOpen: (entry: T) => void;
}) {
  const t = useTranslation();
  const [pathDraft, setPathDraft] = useState(path);
  useEffect(() => setPathDraft(path), [path]);
  return (
    <section className="file-pane">
      <header>
        <div>
          <strong>{t(title)}</strong>
          <button type="button" title={t("Back")} onClick={onBack}>
            <ArrowLeft size={12} />
          </button>
          <button type="button" title={t("Go forward")} onClick={onForward}>
            <ArrowRight size={12} />
          </button>
          <button
            type="button"
            title={t("Up")}
            onClick={() => onPathChange(parentPath(path))}
          >
            <ArrowUpFromLine size={12} />
          </button>
          <button type="button" title={t("Home")} onClick={onHome}>
            <Home size={12} />
          </button>
        </div>
        <input
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onPathChange(event.currentTarget.value);
            }
          }}
        />
        <input
          placeholder={t("Filter")}
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
        />
      </header>
      <div className="file-list-header">
        <span>{t("Name")}</span>
        <span>{t("Size")}</span>
      </div>
      <div className="file-list">
        <button
          className="file-row"
          type="button"
          onDoubleClick={() => onPathChange(parentPath(path))}
        >
          <Folder size={13} />
          <span>..</span>
          <small />
        </button>
        {entries.map((entry) => (
          <button
            className={`file-row ${
              selectedPaths.includes(entry.path) ? "is-selected" : ""
            }`}
            key={entry.path}
            type="button"
            onClick={(event) =>
              onSelect(entry, event.metaKey || event.ctrlKey)
            }
            onDoubleClick={() => onOpen(entry)}
          >
            {entry.kind === "directory" ? (
              <Folder size={13} />
            ) : entry.kind === "file" ? (
              <File size={13} />
            ) : (
              <FilePenLine size={13} />
            )}
            <span>
              {"displayName" in entry && typeof entry.displayName === "string"
                ? entry.displayName
                : entry.name}
            </span>
            <small>{entry.kind === "file" ? formatBytes(entry.size) : ""}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function SftpDialog({
  dialog,
  onClose,
}: {
  dialog: DialogState;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [value, setValue] = useState(
    dialog.type === "input" ? dialog.value : "",
  );
  const [resolutions, setResolutions] = useState<
    Record<string, ConflictResolution>
  >(() =>
    dialog.type === "batchConflict"
      ? Object.fromEntries(
          dialog.conflicts.map((conflict) => [conflict.id, "skip"]),
        )
      : {},
  );
  const dialogClass =
    dialog.type === "batchConflict"
      ? "is-batch-conflict"
      : dialog.type === "conflict"
        ? "is-single-conflict"
        : "";
  return (
    <div className="sftp-dialog-backdrop">
      <section
        className={`sftp-dialog ${dialogClass}`}
        role="dialog"
        aria-modal="true"
        style={
          dialog.type === "batchConflict"
            ? {
                height: batchConflictWindowHeight(
                  dialog.conflicts.length,
                ),
              }
            : undefined
        }
      >
        <header>
          <div>
            <h3>{t(dialog.title)}</h3>
            {dialog.type === "batchConflict" ? (
              <p>
                {t(
                  "Choose how to handle each item, then start the upload.",
                )}
              </p>
            ) : null}
          </div>
          <button type="button" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div className="sftp-dialog-body">
          {dialog.type === "input" ? (
            <label>
              <span>{t(dialog.label)}</span>
              <input
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void dialog.submit(value);
                }}
              />
            </label>
          ) : dialog.type === "confirm" ? (
            <p>{dialog.message}</p>
          ) : dialog.type === "batchConflict" ? (
            <div className="batch-conflicts">
              <div className="batch-conflict-summary">
                <span>
                  {t("Conflicts:")} {dialog.conflicts.length}
                </span>
                <label>
                  <span>{t("Default action for all conflicts:")}</span>
                  <select
                    value=""
                    onChange={(event) => {
                      const resolution = event.target
                        .value as ConflictResolution;
                      if (!resolution) return;
                      setResolutions(
                        Object.fromEntries(
                          dialog.conflicts.map((conflict) => [
                            conflict.id,
                            resolution,
                          ]),
                        ),
                      );
                    }}
                  >
                    <option value="">{t("Choose")}</option>
                    <option value="skip">{t("Skip")}</option>
                    <option value="copy">{t("Keep both")}</option>
                    <option value="replace">{t("Replace")}</option>
                  </select>
                </label>
              </div>
              <div className="batch-conflict-table">
                <div className="batch-conflict-header">
                  <span>{t("File")}</span>
                  <span>{t("Remote Path")}</span>
                  <span>{t("Action")}</span>
                </div>
                {dialog.conflicts.map((conflict) => (
                  <div className="batch-conflict-row" key={conflict.id}>
                    <div>
                      <strong>{conflict.name}</strong>
                      <code title={conflict.source}>
                        {conflict.source}
                      </code>
                    </div>
                    <div>
                      <code title={conflict.destination}>
                        {conflict.destination}
                      </code>
                      <span>
                        {t("Type:")} {conflict.existingKind}
                      </span>
                    </div>
                    <select
                      value={resolutions[conflict.id] ?? "skip"}
                      onChange={(event) =>
                        setResolutions((current) => ({
                          ...current,
                          [conflict.id]: event.target
                            .value as ConflictResolution,
                        }))
                      }
                    >
                      <option value="skip">{t("Skip")}</option>
                      <option value="copy">{t("Keep both")}</option>
                      <option value="replace">{t("Replace")}</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="conflict-detail">
              <div>
                <span>{t("Source")}</span>
                <code>{dialog.source}</code>
              </div>
              <div>
                <span>{t("Destination")}</span>
                <code>{dialog.destination}</code>
              </div>
            </div>
          )}
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          {dialog.type === "input" ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => void dialog.submit(value)}
            >
              {t("Save")}
            </button>
          ) : dialog.type === "confirm" ? (
            <button
              className="danger-button"
              type="button"
              onClick={() => void dialog.submit()}
            >
              {t("Delete")}
            </button>
          ) : dialog.type === "batchConflict" ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => void dialog.submit(resolutions)}
            >
              {t("Start transfers")}
            </button>
          ) : (
            <>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void dialog.submit("skip")}
              >
                {t("Skip")}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void dialog.submit("copy")}
              >
                {t("Keep both")}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void dialog.submit("replace")}
              >
                {t("Replace")}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function remoteJoin(base: string, name: string) {
  if (!base || base === ".") return name;
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function remoteEntryPath(
  entry: SftpEntry & { path?: string },
  base: string,
) {
  return entry.path || remoteJoin(base, entry.name);
}

function remoteParentPath(path: string) {
  if (path === "/") return "/";
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

export function flattenRemoteTree(
  root: string,
  children: Record<string, Array<SftpEntry & { path: string }>>,
  expanded: Set<string>,
): RemoteTreeEntry[] {
  const result: RemoteTreeEntry[] = [];
  const visit = (parent: string, depth: number) => {
    for (const entry of children[parent] ?? []) {
      const expandedDirectory =
        entry.kind === "directory" && expanded.has(entry.path);
      result.push({
        ...entry,
        depth,
        displayName: `${"  ".repeat(depth)}${
          entry.kind === "directory"
            ? expandedDirectory
              ? "[-] "
              : "[+] "
            : ""
        }${entry.name}`,
      });
      if (expandedDirectory) visit(entry.path, depth + 1);
    }
  };
  visit(root, 0);
  return result;
}

export function updateSelection(
  current: string[],
  path: string,
  additive: boolean,
) {
  if (!additive) return [path];
  return current.includes(path)
    ? current.filter((item) => item !== path)
    : [...current, path];
}

export function duplicateName(
  name: string,
  existing: string[],
  isDirectory: boolean,
) {
  const dot = name.lastIndexOf(".");
  const hasExtension = !isDirectory && dot > 0;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? " (copy)" : ` (copy ${index})`;
    const candidate = `${stem}${suffix}${extension}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

export function updateTransferProgress(
  transfer: TransferRecord,
  progress: Pick<TransferProgress, "transferred" | "total">,
  sampledAt: number,
): TransferRecord {
  const elapsed = sampledAt - transfer.sampledAt;
  if (elapsed < 200) {
    return {
      ...transfer,
      transferred: progress.transferred,
      total: progress.total,
    };
  }
  const delta = Math.max(
    0,
    progress.transferred - transfer.sampledBytes,
  );
  const currentRate = (delta * 1_000) / Math.max(elapsed, 1);
  return {
    ...transfer,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond:
      transfer.bytesPerSecond > 0
        ? transfer.bytesPerSecond * 0.35 + currentRate * 0.65
        : currentRate,
    sampledAt,
    sampledBytes: progress.transferred,
  };
}

export function transferProgressText(transfer: TransferRecord) {
  const parts: string[] = [];
  if (transfer.state === "running" && transfer.bytesPerSecond > 0) {
    parts.push(`${formatBytes(transfer.bytesPerSecond)}/s`);
  }
  const current = formatBytes(transfer.transferred);
  if (transfer.total == null || transfer.total <= 0) {
    parts.push(current);
    return parts.join(" · ");
  }
  parts.push(`${current} / ${formatBytes(transfer.total)}`);
  parts.push(
    `${Math.floor(
      Math.min(1, transfer.transferred / transfer.total) * 100,
    )}%`,
  );
  return parts.join(" · ");
}

export function transferStateTitle(state: TransferRecord["state"]) {
  switch (state) {
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function batchConflictWindowHeight(conflictCount: number) {
  return Math.min(Math.max(240 + conflictCount * 46, 313), 453);
}

export function remoteMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const inset = 8;
  return {
    left: Math.max(inset, Math.min(x, viewportWidth - width - inset)),
    top: Math.max(inset, Math.min(y, viewportHeight - height - inset)),
  };
}

export function localJoin(base: string, name: string) {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function parentPath(path: string) {
  if (path === "/" || /^[A-Za-z]:\\?$/.test(path)) return path;
  const separator = path.includes("\\") ? "\\" : "/";
  const normalized = path.replace(/[\\/]+$/, "");
  const index = normalized.lastIndexOf(separator);
  if (index <= 0) return separator;
  return normalized.slice(0, index);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatModifiedAt(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
