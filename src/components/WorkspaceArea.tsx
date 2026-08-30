import {
  Activity,
  ArrowLeftRight,
  Columns2,
  CopyPlus,
  Folder,
  FolderSync,
  History,
  LayoutPanelTop,
  MoreHorizontal,
  NotebookText,
  PanelRightOpen,
  PanelTopOpen,
  Pin,
  Plus,
  Rows2,
  CircleUserRound,
  ClipboardPaste,
  FilePlus2,
  ScrollText,
  Play,
  RefreshCw,
  Search,
  Save,
  Settings,
  SquareTerminal,
  TerminalSquare,
  Trash2,
  ArrowUpDown,
  X,
  Zap,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";

import {
  compactWorkspaceNode,
  paneCount,
  sessionIds as collectSessionIds,
  useAppStore,
} from "../store";
import type {
  CommandHistoryEntry,
  Host,
  HostNote,
  PortForwardRule,
  SessionDescriptor,
  SplitAxis,
  SplitPlacement,
  WorkspaceDocument,
  WorkspaceNode,
} from "../types";
import {
  SftpPanel,
  TransferCenterPopover,
} from "./SftpPanel";
import { HostIcon } from "./Sidebar";
import { SystemPanel } from "./SystemPanel";
import { ManagementPanel } from "./ManagementPanel";
import { useTranslation } from "../i18n";
import { openQuickConnect } from "./QuickConnectDialog";
import { openQuickSwitcher } from "./QuickSwitcher";
import {
  disposeTerminalSurface,
  focusTerminalSurface,
  TerminalSurface,
} from "./TerminalSurface";
import {
  activeHostKeyPrompt,
  ConnectionProgressOverlay,
} from "./ConnectionProgressOverlay";
import {
  TextPrompt,
  type TextPromptState,
} from "./TextPrompt";
import {
  WorkspaceTabInfoPopover,
  type WorkspaceTabInfo,
} from "./WorkspaceTabInfoPopover";

export type SidePanel =
  | "sftp"
  | "system"
  | "scripts"
  | "history"
  | "notes"
  | "forwards"
  | "log";

export interface WorkspaceSidePanelState {
  selected: SidePanel;
  sourceSessionId: string;
  hostId?: string;
}

export type WorkspaceSidePanels = Record<string, WorkspaceSidePanelState>;

interface TabDropIndicator {
  x: number;
  top: number;
  height: number;
}

interface SplitDropHint {
  targetWorkspaceId: string;
  targetSessionId: string;
  axis: SplitAxis;
  placement: SplitPlacement;
  frame: Pick<DOMRect, "left" | "top" | "width" | "height">;
}

interface WorkspaceDetachTarget {
  destinationIndex: number;
  indicatorX: number;
}

const tabDragMinimumDistance = 4;

export function WorkspaceArea() {
  const t = useTranslation();
  const workspace = useAppStore((state) => state.workspace);
  const sessionHosts = useAppStore((state) => state.sessionHosts);
  const navigation = useAppStore((state) => state.navigation);
  const setNavigation = useAppStore((state) => state.setNavigation);
  const selectWorkspace = useAppStore((state) => state.selectWorkspace);
  const closeWorkspace = useAppStore((state) => state.closeWorkspace);
  const renameWorkspace = useAppStore((state) => state.renameWorkspace);
  const togglePinned = useAppStore((state) => state.toggleWorkspacePinned);
  const moveWorkspace = useAppStore((state) => state.moveWorkspace);
  const openLocal = useAppStore((state) => state.openLocalSession);
  const finishConnectionHistory = useAppStore(
    (state) => state.finishConnectionHistory,
  );
  const duplicateWorkspace = useAppStore(
    (state) => state.duplicateWorkspace,
  );
  const mergeWorkspace = useAppStore((state) => state.mergeWorkspace);
  const [sidePanels, setSidePanels] = useState<WorkspaceSidePanels>({});
  const [transferCenterOpen, setTransferCenterOpen] = useState(false);
  const [sidePanelWidth, setSidePanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem("termpilot:right-sidebar-width"));
    return Number.isFinite(stored)
      ? Math.min(760, Math.max(350, stored))
      : 350;
  });
  const autoOpenedSessionsRef = useRef(new Set<string>());
  const [draggedWorkspace, setDraggedWorkspace] = useState<string>();
  const [workspaceDropIndicator, setWorkspaceDropIndicator] =
    useState<TabDropIndicator>();
  const [workspaceSplitDropHint, setWorkspaceSplitDropHint] =
    useState<SplitDropHint>();
  const workspaceSplitDropHintRef = useRef<SplitDropHint>();
  const suppressedWorkspaceClickRef = useRef<string>();
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    id: string;
    x: number;
    y: number;
  }>();
  const [prompt, setPrompt] = useState<TextPromptState>();
  const [workspaceTabInfo, setWorkspaceTabInfo] =
    useState<WorkspaceTabInfo>();
  const availableSessionIds = useMemo(
    () => new Set(workspace.sessions.map((session) => session.id)),
    [workspace.sessions],
  );
  const visibleWorkspaces = useMemo(
    () =>
      workspace.workspaces.flatMap((document) => {
        const root = compactWorkspaceNode(
          document.root,
          availableSessionIds,
        );
        if (!root) return [];
        const sessionIds = collectSessionIds(root);
        return [
          {
            ...document,
            root,
            focusedSessionId: sessionIds.includes(
              document.focusedSessionId,
            )
              ? document.focusedSessionId
              : sessionIds[0]!,
          },
        ];
      }),
    [availableSessionIds, workspace.workspaces],
  );
  const active = visibleWorkspaces.find(
    (item) => item.id === workspace.activeWorkspaceId,
  );
  const activePaneCount = active ? paneCount(active.root) : 0;
  const previousActiveLayoutRef = useRef<{
    workspaceId?: string;
    paneCount: number;
  }>();
  const activeSession = workspace.sessions.find(
    (session) => session.id === active?.focusedSessionId,
  );
  const activeSidePanel = active ? sidePanels[active.id] : undefined;
  const activeSidePanelSession = workspace.sessions.find(
    (session) => session.id === activeSidePanel?.sourceSessionId,
  );
  const autoOpenSystemOverview = useAppStore(
    (state) => state.preferences.autoOpenSystemOverview,
  );
  const settingsActive = navigation !== "hosts";
  const [settingsTabOpen, setSettingsTabOpen] = useState(settingsActive);

  useEffect(() => {
    if (settingsActive) {
      setSettingsTabOpen(true);
    }
  }, [settingsActive]);

  useEffect(() => {
    if (
      !autoOpenSystemOverview ||
      activePaneCount !== 1 ||
      activeSession?.kind !== "ssh" ||
      activeSession.lifecycle !== "connected" ||
      autoOpenedSessionsRef.current.has(activeSession.id)
    ) {
      return;
    }
    autoOpenedSessionsRef.current.add(activeSession.id);
    if (active) {
      openSidePanel(active.id, activeSession.id, "system", false);
    }
  }, [
    active?.id,
    activeSession?.id,
    activeSession?.kind,
    activeSession?.lifecycle,
    activePaneCount,
    autoOpenSystemOverview,
  ]);

  useEffect(() => {
    const previous = previousActiveLayoutRef.current;
    if (
      shouldCloseSidePanelForLayout(
        previous?.workspaceId,
        previous?.paneCount ?? 0,
        active?.id,
        activePaneCount,
      )
    ) {
      if (active) closeSidePanel(active.id);
    }
    previousActiveLayoutRef.current = {
      workspaceId: active?.id,
      paneCount: activePaneCount,
    };
  }, [active?.id, activePaneCount]);

  useEffect(() => {
    if (
      active &&
      activeSidePanelSession?.kind === "local" &&
      activeSidePanel?.selected === "forwards"
    ) {
      selectSidePanel(active.id, "system");
    }
  }, [
    active?.id,
    activeSidePanel?.selected,
    activeSidePanelSession?.kind,
  ]);

  useLayoutEffect(() => {
    if (
      !active ||
      !activeSession ||
      !activeSidePanel ||
      activeSidePanel.sourceSessionId === activeSession.id
    ) {
      return;
    }
    closeSidePanelConnection(activeSidePanel);
    const host = hostForSession(activeSession.id);
    setSidePanels((panels) =>
      retargetWorkspaceSidePanel(
        panels,
        active.id,
        activeSession.id,
        host?.id,
      ),
    );
  }, [
    active?.id,
    activeSession?.id,
    activeSidePanel?.sourceSessionId,
  ]);

  useEffect(() => {
    const documents = new Map(
      workspace.workspaces.map((document) => [document.id, document]),
    );
    const sessions = new Set(workspace.sessions.map((session) => session.id));
    const invalid = Object.entries(sidePanels).filter(
      ([workspaceId, panel]) => {
        const document = documents.get(workspaceId);
        return (
          !document ||
          !sessions.has(panel.sourceSessionId) ||
          !collectSessionIds(document.root).includes(panel.sourceSessionId)
        );
      },
    );
    if (invalid.length === 0) return;
    for (const [, panel] of invalid) closeSidePanelConnection(panel);
    setSidePanels((current) => {
      const next = { ...current };
      for (const [workspaceId] of invalid) delete next[workspaceId];
      return next;
    });
  }, [sidePanels, workspace.sessions, workspace.workspaces]);

  function openSidePanel(
    workspaceId: string,
    sourceSessionId: string,
    selected: SidePanel,
    toggles = true,
  ) {
    const current = sidePanels[workspaceId];
    if (
      toggles &&
      current?.sourceSessionId === sourceSessionId &&
      current.selected === selected
    ) {
      closeSidePanel(workspaceId);
      return;
    }
    if (current && current.sourceSessionId !== sourceSessionId) {
      closeSidePanelConnection(current);
    }
    const host = hostForSession(sourceSessionId);
    setSidePanels((panels) =>
      bindWorkspaceSidePanel(
        panels,
        workspaceId,
        sourceSessionId,
        selected,
        host?.id,
      ),
    );
  }

  function selectSidePanel(workspaceId: string, selected: SidePanel) {
    setSidePanels((panels) =>
      selectWorkspaceSidePanel(panels, workspaceId, selected),
    );
  }

  function closeSidePanel(workspaceId: string) {
    const current = sidePanels[workspaceId];
    if (!current) return;
    closeSidePanelConnection(current);
    setSidePanels((panels) => {
      const next = { ...panels };
      delete next[workspaceId];
      return next;
    });
  }

  function hostForSession(sessionId: string) {
    const state = useAppStore.getState();
    const session = state.workspace.sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    return (
      state.sessionHosts[sessionId] ??
      state.hosts.find((host) => host.id === session?.hostId)
    );
  }

  function startSidePanelResize(event: React.PointerEvent) {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    document.body.classList.add("is-resizing-sidebar");
    const move = (pointer: PointerEvent) => {
      const maximum = Math.max(350, Math.min(760, rect.width - 360));
      const width = Math.min(
        maximum,
        Math.max(350, rect.right - pointer.clientX),
      );
      setSidePanelWidth(width);
      localStorage.setItem(
        "termpilot:right-sidebar-width",
        String(width),
      );
    };
    const stop = () => {
      document.body.classList.remove("is-resizing-sidebar");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function startWindowDrag(event: React.MouseEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  }

  function startWorkspaceTabDrag(
    event: React.PointerEvent<HTMLButtonElement>,
    workspaceId: string,
  ) {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest(".tab-close")
    ) {
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const move = (pointer: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(
          pointer.clientX - startX,
          pointer.clientY - startY,
        ) < tabDragMinimumDistance
      ) {
        return;
      }
      pointer.preventDefault();
      if (!dragging) {
        dragging = true;
        suppressedWorkspaceClickRef.current = workspaceId;
        setDraggedWorkspace(workspaceId);
        document.body.classList.add("is-dragging-tab");
      }

      const splitHint = resolveWorkspaceSplitDrop(
        workspaceId,
        pointer.clientX,
        pointer.clientY,
      );
      workspaceSplitDropHintRef.current = splitHint;
      setWorkspaceSplitDropHint(splitHint);
      if (splitHint) {
        setWorkspaceDropIndicator(undefined);
        return;
      }

      const tabList = document.querySelector<HTMLElement>(
        ".workspace-tab-scroll",
      );
      if (!tabList) return;
      const listFrame = tabList.getBoundingClientRect();
      if (
        pointer.clientY < listFrame.top - 10 ||
        pointer.clientY > listFrame.bottom + 10 ||
        pointer.clientX < listFrame.left ||
        pointer.clientX > listFrame.right
      ) {
        setWorkspaceDropIndicator(undefined);
        return;
      }
      const resolution = resolveTabInsertion(
        workspaceId,
        pointer.clientX,
        Array.from(
          tabList.querySelectorAll<HTMLElement>(
            "[data-workspace-tab-id]",
          ),
        ),
        "workspaceTabId",
      );
      if (!resolution) {
        setWorkspaceDropIndicator(undefined);
        return;
      }
      setWorkspaceDropIndicator({
        x: resolution.indicatorX,
        top: listFrame.top + 5,
        height: 26,
      });
      animateTabLayout(
        tabList,
        "[data-workspace-tab-id]",
        workspaceId,
        () =>
          moveWorkspace(
            workspaceId,
            resolution.rawDestinationIndex,
          ),
      );
    };

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("is-dragging-tab");
      if (dragging) {
        const splitHint = workspaceSplitDropHintRef.current;
        if (splitHint) {
          mergeWorkspace(
            workspaceId,
            splitHint.targetWorkspaceId,
            splitHint.targetSessionId,
            splitHint.axis,
            splitHint.placement,
          );
        }
        window.setTimeout(() => {
          if (suppressedWorkspaceClickRef.current === workspaceId) {
            suppressedWorkspaceClickRef.current = undefined;
          }
        }, 250);
      }
      workspaceSplitDropHintRef.current = undefined;
      setDraggedWorkspace(undefined);
      setWorkspaceDropIndicator(undefined);
      setWorkspaceSplitDropHint(undefined);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function resolveWorkspaceSplitDrop(
    sourceWorkspaceId: string,
    x: number,
    y: number,
  ): SplitDropHint | undefined {
    const snapshot = useAppStore.getState().workspace;
    const source = snapshot.workspaces.find(
      (item) => item.id === sourceWorkspaceId,
    );
    const target = snapshot.workspaces.find(
      (item) => item.id === snapshot.activeWorkspaceId,
    );
    if (
      !source ||
      !target ||
      source.id === target.id ||
      paneCount(source.root) !== 1
    ) {
      return undefined;
    }
    const pane = document
      .elementsFromPoint(x, y)
      .map((element) =>
        element.closest<HTMLElement>("[data-terminal-pane]"),
      )
      .find(
        (element): element is HTMLElement =>
          element !== null &&
          element.dataset.workspaceId === target.id,
      );
    if (!pane?.dataset.sessionId) return undefined;
    const resolution = resolveSplitDrop(
      x,
      y,
      pane.getBoundingClientRect(),
    );
    return resolution
      ? {
          targetWorkspaceId: target.id,
          targetSessionId: pane.dataset.sessionId,
          ...resolution,
        }
      : undefined;
  }

  return (
    <section className="workspace-area">
      <div className="window-toolbar">
        <div
          className="window-drag-region"
          onMouseDown={startWindowDrag}
        >
          <strong>TermPilot</strong>
        </div>
        <div className="workspace-actions">
          <IconButton label={t("Local shell")} onClick={() => {
            openLocal();
            setNavigation("hosts");
          }}>
            <TerminalSquare size={14} />
          </IconButton>
          <IconButton label={t("Quick Connect")} onClick={() => openQuickConnect()}>
            <Zap size={14} />
          </IconButton>
          <div
            className={`transfer-center-host ${
              transferCenterOpen ? "is-open" : ""
            }`}
          >
            <button
              className="icon-button"
              type="button"
              title={t("Transfers")}
              aria-label={t("Transfers")}
              aria-expanded={transferCenterOpen}
              onClick={() => setTransferCenterOpen((open) => !open)}
            >
              <ArrowUpDown size={14} />
            </button>
            {transferCenterOpen ? (
              <TransferCenterPopover
                onClose={() => setTransferCenterOpen(false)}
              />
            ) : null}
          </div>
        </div>
      </div>
      <div className="workspace-tabs" role="tablist">
        <div className="workspace-tab-scroll">
          {settingsTabOpen ? (
            <button
              className={`workspace-tab settings-workspace-tab ${
                settingsActive ? "is-active" : ""
              }`}
              role="tab"
              type="button"
              onClick={() => {
                setNavigation("settings");
              }}
              onMouseEnter={(event) =>
                setWorkspaceTabInfo({
                  anchor: event.currentTarget,
                  title: t("Settings"),
                })
              }
              onMouseLeave={() => setWorkspaceTabInfo(undefined)}
              onPointerDown={() => setWorkspaceTabInfo(undefined)}
            >
              <Settings size={12} />
              <span className="workspace-tab-title">{t("Settings")}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  setSettingsTabOpen(false);
                  setNavigation("hosts");
                }}
              >
                <X size={12} />
              </span>
            </button>
          ) : null}
          {visibleWorkspaces.map((item) => (
            <button
              className={`workspace-tab ${
                !settingsActive && item.id === active?.id ? "is-active" : ""
              } ${
                draggedWorkspace === item.id ? "is-dragging" : ""
              }`}
              data-workspace-tab-id={item.id}
              key={item.id}
              role="tab"
              type="button"
              onClick={(event) => {
                if (suppressedWorkspaceClickRef.current === item.id) {
                  suppressedWorkspaceClickRef.current = undefined;
                  event.preventDefault();
                  return;
                }
                const refocusesCurrentWorkspace =
                  !settingsActive && item.id === active?.id;
                flushSync(() => {
                  selectWorkspace(item.id);
                  setNavigation("hosts");
                });
                if (refocusesCurrentWorkspace) {
                  focusTerminalSurface(item.focusedSessionId);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setWorkspaceTabInfo(undefined);
                setWorkspaceMenu({
                  id: item.id,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onDoubleClick={() => {
                setPrompt({
                  title: "Rename workspace",
                  label: "Workspace name",
                  value: item.title,
                  submit: (title) => renameWorkspace(item.id, title),
                });
              }}
              onPointerDown={(event) => {
                setWorkspaceTabInfo(undefined);
                startWorkspaceTabDrag(event, item.id);
              }}
              onMouseEnter={(event) =>
                setWorkspaceTabInfo({
                  anchor: event.currentTarget,
                  ...workspaceTabTooltip(
                    item,
                    workspace.sessions,
                    sessionHosts,
                  ),
                })
              }
              onMouseLeave={() => setWorkspaceTabInfo(undefined)}
            >
              {item.pinned ? <Pin size={11} /> : null}
              <span className="workspace-tab-title">{item.title}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  for (const sessionId of collectSessionIds(item.root)) {
                    finishConnectionHistory(sessionId, "closed");
                    disposeTerminalSurface(sessionId);
                    void invoke("terminal_terminate", { sessionId });
                  }
                  closeWorkspace(item.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    for (const sessionId of collectSessionIds(item.root)) {
                      finishConnectionHistory(sessionId, "closed");
                      disposeTerminalSurface(sessionId);
                      void invoke("terminal_terminate", { sessionId });
                    }
                    closeWorkspace(item.id);
                  }
                }}
              >
                <X size={12} />
              </span>
            </button>
          ))}
          <IconButton label={t("Open Quick Switcher")} onClick={openQuickSwitcher}>
            <Plus size={15} />
          </IconButton>
        </div>
      </div>

      <div className={`workspace-content ${settingsActive ? "is-settings" : ""}`}>
        <div className={`workspace-tree ${settingsActive ? "is-surface-hidden" : ""}`}>
          {visibleWorkspaces.map((document) => (
            <div
              className={`workspace-document ${
                document.id === active?.id ? "is-active" : ""
              }`}
              key={document.id}
            >
              <WorkspaceNodeView
                activeWorkspace={
                  !settingsActive && document.id === active?.id
                }
                workspace={document}
                node={document.root}
                onOpenSidePanel={(panel) =>
                  openSidePanel(
                    document.id,
                    document.focusedSessionId,
                    panel,
                  )
                }
              />
            </div>
          ))}
          {!active ? (
            <div className="empty-workspace">
              <div className="empty-terminal-mark">
                <SquareTerminal size={28} strokeWidth={1.8} />
              </div>
              <h2>{t("Ready to Connect")}</h2>
              <p>
                {t(
                  "Open a local shell, double-click a saved host, or use Quick Connect.",
                )}
              </p>
              <div className="empty-workspace-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => openLocal()}
                >
                  {t("Local Terminal")}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => openQuickConnect()}
                >
                  {t("Quick Connect")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        {settingsActive ? <ManagementPanel /> : null}
        {!settingsActive && activeSidePanel && active ? (
          <>
            <div
              aria-label={t("Resize side panel")}
              aria-orientation="vertical"
              className="workspace-side-panel-resizer"
              role="separator"
              onDoubleClick={() => {
                setSidePanelWidth(350);
                localStorage.setItem(
                  "termpilot:right-sidebar-width",
                  "350",
                );
              }}
              onPointerDown={startSidePanelResize}
            />
          </>
        ) : null}
        {visibleWorkspaces.map((document) => {
          const panel = sidePanels[document.id];
          if (!panel) return null;
          return (
            <WorkspaceSidePanel
              active={
                !settingsActive &&
                document.id === active?.id
              }
              key={`${document.id}:${panel.sourceSessionId}`}
              width={sidePanelWidth}
              sourceSessionId={panel.sourceSessionId}
              selected={panel.selected}
              onSelect={(selected) =>
                selectSidePanel(document.id, selected)
              }
              onClose={() => closeSidePanel(document.id)}
            />
          );
        })}
      </div>
      {workspaceDropIndicator ? (
        <div
          className="tab-drop-indicator"
          style={{
            left: workspaceDropIndicator.x - 1.5,
            top: workspaceDropIndicator.top,
            height: workspaceDropIndicator.height,
          }}
        />
      ) : null}
      {workspaceSplitDropHint ? (
        <div
          className="tab-split-drop-preview"
          style={{
            left: workspaceSplitDropHint.frame.left,
            top: workspaceSplitDropHint.frame.top,
            width: workspaceSplitDropHint.frame.width,
            height: workspaceSplitDropHint.frame.height,
          }}
        />
      ) : null}
      {prompt ? (
        <TextPrompt prompt={prompt} onClose={() => setPrompt(undefined)} />
      ) : null}
      <WorkspaceTabInfoPopover info={workspaceTabInfo} />
      {workspaceMenu ? (
        <div
          className="workspace-context-menu"
          style={{ left: workspaceMenu.x, top: workspaceMenu.y }}
          onMouseLeave={() => setWorkspaceMenu(undefined)}
        >
          <button
            type="button"
            onClick={() => {
              togglePinned(workspaceMenu.id);
              setWorkspaceMenu(undefined);
            }}
          >
            {t("Pin workspace")}
          </button>
          <button
            type="button"
            onClick={() => {
              duplicateWorkspace(workspaceMenu.id);
              setWorkspaceMenu(undefined);
            }}
          >
            {t("Duplicate workspace")}
          </button>
          {workspace.workspaces.some((item) => item.id !== workspaceMenu.id) ? (
            <button
              type="button"
              onClick={() => {
                const target = workspace.workspaces.find(
                  (item) => item.id !== workspaceMenu.id,
                );
                if (target) {
                  mergeWorkspace(
                    workspaceMenu.id,
                    target.id,
                    target.focusedSessionId,
                    "vertical",
                  );
                }
                setWorkspaceMenu(undefined);
              }}
            >
              {t("Merge into previous workspace")}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceNodeView({
  activeWorkspace,
  workspace,
  node,
  onOpenSidePanel,
}: {
  activeWorkspace: boolean;
  workspace: WorkspaceDocument;
  node: WorkspaceNode;
  onOpenSidePanel: (panel: SidePanel) => void;
}) {
  if (node.type === "split") {
    return (
      <SplitNode
        activeWorkspace={activeWorkspace}
        node={node}
        workspace={workspace}
        onOpenSidePanel={onOpenSidePanel}
      />
    );
  }

  const sessionIds =
    node.type === "tabGroup" ? node.sessionIds : [node.sessionId];
  const activeSessionId =
    node.type === "tabGroup" ? node.activeSessionId : node.sessionId;

  return (
    <TerminalPane
      activeWorkspace={activeWorkspace}
      workspace={workspace}
      sessionIds={sessionIds}
      activeSessionId={activeSessionId}
      onOpenSidePanel={onOpenSidePanel}
    />
  );
}

function SplitNode({
  activeWorkspace,
  workspace,
  node,
  onOpenSidePanel,
}: {
  activeWorkspace: boolean;
  workspace: WorkspaceDocument;
  node: Extract<WorkspaceNode, { type: "split" }>;
  onOpenSidePanel: (panel: SidePanel) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const updateSizes = useAppStore((state) => state.updateSplitSizes);

  function startResize(event: React.PointerEvent, index: number) {
    event.preventDefault();
    const container = containerRef.current;
    if (!container || node.children.length !== 2 || index !== 0) return;
    const move = (pointer: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const raw =
        node.axis === "vertical"
          ? (pointer.clientX - rect.left) / rect.width
          : (pointer.clientY - rect.top) / rect.height;
      const first = Math.min(0.85, Math.max(0.15, raw));
      updateSizes(workspace.id, node.id, [first, 1 - first]);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <div
      ref={containerRef}
      className={`workspace-split ${
        node.axis === "vertical" ? "is-vertical" : "is-horizontal"
      }`}
    >
      {node.children.map((child, index) => (
        <div
          className="workspace-split-child"
          key={child.id}
          style={{ flexBasis: `${(node.sizes[index] ?? 0.5) * 100}%` }}
        >
          <WorkspaceNodeView
            activeWorkspace={activeWorkspace}
            workspace={workspace}
            node={child}
            onOpenSidePanel={onOpenSidePanel}
          />
          {index < node.children.length - 1 ? (
            <div
              className="split-resizer"
              role="separator"
              onPointerDown={(event) => startResize(event, index)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TerminalPane({
  activeWorkspace,
  workspace,
  sessionIds,
  activeSessionId,
  onOpenSidePanel,
}: {
  activeWorkspace: boolean;
  workspace: WorkspaceDocument;
  sessionIds: string[];
  activeSessionId: string;
  onOpenSidePanel: (panel: SidePanel) => void;
}) {
  const t = useTranslation();
  const sessions = useAppStore((state) => state.workspace.sessions);
  const selectTab = useAppStore((state) => state.selectTab);
  const closeSession = useAppStore((state) => state.closeSession);
  const openLocalTab = useAppStore((state) => state.openLocalTab);
  const openSiblingTab = useAppStore((state) => state.openSiblingTab);
  const openSiblingSplit = useAppStore(
    (state) => state.openSiblingSplit,
  );
  const moveTerminalTab = useAppStore((state) => state.moveTerminalTab);
  const focusSession = useAppStore((state) => state.focusSession);
  const finishConnectionHistory = useAppStore(
    (state) => state.finishConnectionHistory,
  );
  const appendConnectionLog = useAppStore(
    (state) => state.appendConnectionLog,
  );
  const detachSession = useAppStore((state) => state.detachSession);
  const detachPane = useAppStore((state) => state.detachPane);
  const splitExistingTab = useAppStore(
    (state) => state.splitExistingTab,
  );
  const [draggedTab, setDraggedTab] = useState<string>();
  const [terminalDropIndicator, setTerminalDropIndicator] =
    useState<TabDropIndicator>();
  const [terminalSplitDropHint, setTerminalSplitDropHint] =
    useState<SplitDropHint>();
  const terminalSplitDropHintRef = useRef<SplitDropHint>();
  const [workspaceDetachDrop, setWorkspaceDetachDrop] = useState<
    (WorkspaceDetachTarget & TabDropIndicator) | undefined
  >();
  const workspaceDetachDropRef = useRef<
    (WorkspaceDetachTarget & TabDropIndicator) | undefined
  >();
  const suppressedTerminalClickRef = useRef<string>();
  const [showMore, setShowMore] = useState(false);
  const [dismissedConnectionOverlays, setDismissedConnectionOverlays] =
    useState(() => new Set<string>());
  const [lingeringConnectionOverlays, setLingeringConnectionOverlays] =
    useState(() => new Set<string>());
  const paneSessions = sessionIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is SessionDescriptor => Boolean(session));
  const activeSession = paneSessions.find(
    (session) => session.id === activeSessionId,
  );
  const activeLatency = useAppStore(
    (state) => state.sessionLatencies[activeSessionId],
  );
  const activeConnectionLogs = useAppStore((state) =>
    activeSession ? state.connectionLogs[activeSession.id] : undefined,
  );
  const activeHostKeyConfirmation = activeHostKeyPrompt(
    activeConnectionLogs ?? [],
  );

  useEffect(() => {
    if (!activeSession || activeSession.kind !== "ssh") return;
    if (activeSession.lifecycle === "connecting") {
      setLingeringConnectionOverlays((current) => {
        if (current.has(activeSession.id)) return current;
        return new Set(current).add(activeSession.id);
      });
      return;
    }
    if (
      activeSession.lifecycle === "connected" &&
      lingeringConnectionOverlays.has(activeSession.id)
    ) {
      const timer = window.setTimeout(() => {
        setLingeringConnectionOverlays((current) => {
          const next = new Set(current);
          next.delete(activeSession.id);
          return next;
        });
      }, 900);
      return () => window.clearTimeout(timer);
    }
    setLingeringConnectionOverlays((current) => {
      if (!current.has(activeSession.id)) return current;
      const next = new Set(current);
      next.delete(activeSession.id);
      return next;
    });
  }, [
    activeSession?.id,
    activeSession?.kind,
    activeSession?.lifecycle,
    lingeringConnectionOverlays,
  ]);

  useEffect(() => {
    if (
      activeSession?.kind !== "ssh" ||
      activeSession.lifecycle !== "connecting"
    ) {
      return;
    }
    setDismissedConnectionOverlays((current) => {
      if (!current.has(activeSession.id)) return current;
      const next = new Set(current);
      next.delete(activeSession.id);
      return next;
    });
  }, [activeSession?.id, activeSession?.kind, activeSession?.lifecycle]);

  useEffect(() => {
    if (!activeSession || !activeHostKeyConfirmation) return;
    setDismissedConnectionOverlays((current) => {
      if (!current.has(activeSession.id)) return current;
      const next = new Set(current);
      next.delete(activeSession.id);
      return next;
    });
  }, [
    activeHostKeyConfirmation?.fingerprint,
    activeSession?.id,
  ]);

  function dismissConnectionOverlay(sessionId: string) {
    setDismissedConnectionOverlays((current) => {
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
  }

  function cancelActiveConnection() {
    if (!activeSession) return;
    dismissConnectionOverlay(activeSession.id);
    finishConnectionHistory(activeSession.id, "cancelled");
    void invoke("terminal_terminate", {
      sessionId: activeSession.id,
    });
  }

  async function respondToActiveHostKey(accepted: boolean) {
    if (!activeSession || activeSession.kind !== "ssh") return;
    await invoke("terminal_write", {
      sessionId: activeSession.id,
      data: encodeTerminalText(accepted ? "yes\r" : "no\r"),
    });
    appendConnectionLog(activeSession.id, {
      status: "host-key-response",
      message: accepted
        ? "SSH host key accepted by user."
        : "SSH host key rejected by user.",
    });
  }

  function closeActiveSession() {
    if (!activeSession) return;
    finishConnectionHistory(activeSession.id, "closed");
    disposeTerminalSurface(activeSession.id);
    void invoke("terminal_terminate", { sessionId: activeSession.id });
    closeSession(workspace.id, activeSession.id);
  }

  function startTerminalTabDrag(
    event: React.PointerEvent<HTMLButtonElement>,
    sessionId: string,
  ) {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest(".tab-close")
    ) {
      return;
    }
    const tabList = event.currentTarget.parentElement;
    if (!tabList) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const move = (pointer: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(
          pointer.clientX - startX,
          pointer.clientY - startY,
        ) < tabDragMinimumDistance
      ) {
        return;
      }
      pointer.preventDefault();
      if (!dragging) {
        dragging = true;
        suppressedTerminalClickRef.current = sessionId;
        setDraggedTab(sessionId);
        document.body.classList.add("is-dragging-tab");
      }

      const workspaceTabList = document.querySelector<HTMLElement>(
        ".workspace-tab-scroll",
      );
      const workspaceTabFrame = workspaceTabList?.getBoundingClientRect();
      const workspaceTarget =
        collectSessionIds(workspace.root).length > 1 &&
        workspaceTabList &&
        workspaceTabFrame
          ? resolveWorkspaceDetachTarget(
              pointer.clientX,
              pointer.clientY,
              workspaceTabFrame,
              Array.from(
                workspaceTabList.querySelectorAll<HTMLElement>(
                  "[data-workspace-tab-id]",
                ),
              ).map((element) => ({
                id: element.dataset.workspaceTabId ?? "",
                frame: element.getBoundingClientRect(),
              })),
            )
          : undefined;
      if (workspaceTarget && workspaceTabFrame) {
        const drop = {
          ...workspaceTarget,
          x: workspaceTarget.indicatorX,
          top: workspaceTabFrame.top + 5,
          height: 26,
        };
        workspaceDetachDropRef.current = drop;
        setWorkspaceDetachDrop((current) =>
          workspaceDetachDropEqual(current, drop) ? current : drop,
        );
        terminalSplitDropHintRef.current = undefined;
        setTerminalSplitDropHint(undefined);
        setTerminalDropIndicator(undefined);
        return;
      }
      workspaceDetachDropRef.current = undefined;
      setWorkspaceDetachDrop(undefined);

      const listFrame = tabList.getBoundingClientRect();
      const insideTabStrip =
        pointer.clientY >= listFrame.top - 10 &&
        pointer.clientY <= listFrame.bottom + 10 &&
        pointer.clientX >= listFrame.left &&
        pointer.clientX <= listFrame.right;
      if (insideTabStrip) {
        terminalSplitDropHintRef.current = undefined;
        setTerminalSplitDropHint(undefined);
        const resolution = resolveTabInsertion(
          sessionId,
          pointer.clientX,
          Array.from(
            tabList.querySelectorAll<HTMLElement>(
              "[data-terminal-tab-id]",
            ),
          ),
          "terminalTabId",
        );
        if (!resolution) {
          setTerminalDropIndicator(undefined);
          return;
        }
        const indicator = {
          x: resolution.indicatorX,
          top: listFrame.top + 4,
          height: 22,
        };
        setTerminalDropIndicator((current) =>
          tabDropIndicatorEqual(current, indicator)
            ? current
            : indicator,
        );
        animateTabLayout(
          tabList,
          "[data-terminal-tab-id]",
          sessionId,
          () =>
            moveTerminalTab(
              workspace.id,
              sessionId,
              resolution.rawDestinationIndex,
            ),
        );
        return;
      }

      setTerminalDropIndicator(undefined);
      if (sessionIds.length <= 1) {
        terminalSplitDropHintRef.current = undefined;
        setTerminalSplitDropHint(undefined);
        return;
      }
      const pane = document
        .elementsFromPoint(pointer.clientX, pointer.clientY)
        .map((element) =>
          element.closest<HTMLElement>("[data-terminal-pane]"),
        )
        .find(
          (element): element is HTMLElement =>
            element !== null &&
            element.dataset.workspaceId === workspace.id,
        );
      const targetSessionId = pane?.dataset.sessionId;
      const resolution =
        pane && targetSessionId
          ? resolveSplitDrop(
              pointer.clientX,
              pointer.clientY,
              pane.getBoundingClientRect(),
            )
          : undefined;
      const splitHint =
        resolution && targetSessionId
          ? {
              targetWorkspaceId: workspace.id,
              targetSessionId,
              ...resolution,
            }
          : undefined;
      terminalSplitDropHintRef.current = splitHint;
      setTerminalSplitDropHint((current) =>
        splitDropHintEqual(current, splitHint) ? current : splitHint,
      );
    };

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("is-dragging-tab");
      if (dragging) {
        const workspaceTarget = workspaceDetachDropRef.current;
        const splitHint = terminalSplitDropHintRef.current;
        if (workspaceTarget) {
          if (paneCount(workspace.root) > 1) {
            detachPane(
              workspace.id,
              sessionId,
              workspaceTarget.destinationIndex,
            );
          } else {
            detachSession(
              workspace.id,
              sessionId,
              workspaceTarget.destinationIndex,
            );
          }
        } else if (splitHint) {
          splitExistingTab(
            workspace.id,
            sessionId,
            splitHint.targetSessionId,
            splitHint.axis,
            splitHint.placement,
          );
        }
        window.setTimeout(() => {
          if (suppressedTerminalClickRef.current === sessionId) {
            suppressedTerminalClickRef.current = undefined;
          }
        }, 250);
      }
      workspaceDetachDropRef.current = undefined;
      terminalSplitDropHintRef.current = undefined;
      setDraggedTab(undefined);
      setWorkspaceDetachDrop(undefined);
      setTerminalDropIndicator(undefined);
      setTerminalSplitDropHint(undefined);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  return (
    <div
      className="terminal-pane"
      data-terminal-pane
      data-workspace-id={workspace.id}
      data-session-id={activeSessionId}
    >
      <div className="terminal-tabs">
        <div className="terminal-tab-list">
          {paneSessions.map((session) => (
            <button
              className={`terminal-tab ${
                session.id === activeSessionId ? "is-active" : ""
              } ${
                draggedTab === session.id ? "is-dragging" : ""
              }`}
              data-terminal-tab-id={session.id}
              key={session.id}
              title={`${session.title} · ${session.lifecycle}`}
              type="button"
              onClick={(event) => {
                if (suppressedTerminalClickRef.current === session.id) {
                  suppressedTerminalClickRef.current = undefined;
                  event.preventDefault();
                  return;
                }
                selectTab(workspace.id, session.id);
                focusSession(workspace.id, session.id);
              }}
              onPointerDown={(event) =>
                startTerminalTabDrag(event, session.id)
              }
            >
              <span className={`session-dot lifecycle-${session.lifecycle}`} />
              <span>{session.title}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  finishConnectionHistory(session.id, "closed");
                  disposeTerminalSurface(session.id);
                  void invoke("terminal_terminate", {
                    sessionId: session.id,
                  });
                  closeSession(workspace.id, session.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    finishConnectionHistory(session.id, "closed");
                    disposeTerminalSurface(session.id);
                    void invoke("terminal_terminate", {
                      sessionId: session.id,
                    });
                    closeSession(workspace.id, session.id);
                  }
                }}
              >
                <X size={11} />
              </span>
            </button>
          ))}
        </div>
        <div className="terminal-tab-actions">
          <span className="terminal-status">{activeSession?.lifecycle}</span>
          {activeSession?.kind === "ssh" &&
          activeSession.lifecycle === "connected" &&
          activeLatency != null ? (
            <span
              className={`terminal-latency is-${terminalLatencyQuality(
                activeLatency,
              )}`}
              title={`${t("Latency")}: ${activeLatency} ms`}
              aria-label={`${t("Latency")}: ${activeLatency} ms`}
            >
              <span aria-hidden="true" />
              {activeLatency} ms
            </span>
          ) : null}
          <IconButton label="Connection log" onClick={() => onOpenSidePanel("log")}>
            <ScrollText size={14} />
          </IconButton>
          <IconButton label="SFTP" onClick={() => onOpenSidePanel("sftp")}>
            <FolderSync size={14} />
          </IconButton>
          <IconButton label="Open system panel" onClick={() => onOpenSidePanel("system")}>
            <PanelRightOpen size={14} />
          </IconButton>
          <IconButton
            label="Search terminal"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("termpilot:search-terminal", {
                  detail: activeSessionId,
                }),
              )
            }
          >
            <Search size={14} />
          </IconButton>
          <IconButton
            label="Add terminal tab"
            onClick={() => {
              if (activeSession?.kind === "ssh") {
                openSiblingTab(
                  activeSessionId,
                  activeSession.title,
                );
              } else {
                openLocalTab(activeSessionId);
              }
            }}
          >
            <Plus size={14} />
          </IconButton>
          <IconButton
            label="Split left and right"
            onClick={() =>
              openSiblingSplit(activeSessionId, "vertical")
            }
          >
            <Columns2 size={14} />
          </IconButton>
          <IconButton
            label="Split top and bottom"
            onClick={() =>
              openSiblingSplit(activeSessionId, "horizontal")
            }
          >
            <Rows2 size={14} />
          </IconButton>
          <IconButton label="More" onClick={() => setShowMore((value) => !value)}>
            <MoreHorizontal size={14} />
          </IconButton>
          <IconButton label="Close session" onClick={closeActiveSession}>
            <X size={14} />
          </IconButton>
          {showMore ? (
            <div className="terminal-more-menu">
              {sessionIds.length > 1 ? (
                <button type="button" onClick={() => {
                  splitExistingTab(
                    workspace.id,
                    activeSessionId,
                    sessionIds.find((id) => id !== activeSessionId) ??
                      activeSessionId,
                    "vertical",
                  );
                  setShowMore(false);
                }}>
                  <PanelTopOpen size={13} /> Split current tab into pane
                </button>
              ) : null}
              {collectSessionIds(workspace.root).length > 1 ? (
                <button type="button" onClick={() => {
                  detachSession(workspace.id, activeSessionId);
                  setShowMore(false);
                }}>
                  <CopyPlus size={13} /> Move session to new workspace
                </button>
              ) : null}
              {workspace.root.type === "split" ? (
                <button type="button" onClick={() => {
                  detachPane(workspace.id, activeSessionId);
                  setShowMore(false);
                }}>
                  <PanelRightOpen size={13} /> Move pane to new workspace
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="terminal-stack">
        {paneSessions.map((session) => (
          <div
            className={`terminal-layer ${
              session.id === activeSessionId ? "is-active" : ""
            }`}
            key={session.id}
          >
            <TerminalSurface
              session={session}
              active={
                activeWorkspace && session.id === activeSessionId
              }
            />
          </div>
        ))}
        {activeSession?.kind === "ssh" &&
        (activeSession.lifecycle === "connecting" ||
          lingeringConnectionOverlays.has(activeSession.id)) &&
        !dismissedConnectionOverlays.has(activeSession.id) ? (
          <ConnectionProgressOverlay
            session={activeSession}
            onCancel={cancelActiveConnection}
            onDismiss={() =>
              dismissConnectionOverlay(activeSession.id)
            }
            onHostKeyResponse={respondToActiveHostKey}
          />
        ) : null}
      </div>
      {terminalDropIndicator ? (
        createPortal(
          <div
            className="tab-drop-indicator"
            style={{
              left: terminalDropIndicator.x - 1.5,
              top: terminalDropIndicator.top,
              height: terminalDropIndicator.height,
            }}
          />,
          document.body,
        )
      ) : null}
      {workspaceDetachDrop ? (
        createPortal(
          <div
            className="tab-drop-indicator"
            style={{
              left: workspaceDetachDrop.x - 1.5,
              top: workspaceDetachDrop.top,
              height: workspaceDetachDrop.height,
            }}
          />,
          document.body,
        )
      ) : null}
      {terminalSplitDropHint ? (
        createPortal(
          <div
            className="tab-split-drop-preview"
            style={{
              left: terminalSplitDropHint.frame.left,
              top: terminalSplitDropHint.frame.top,
              width: terminalSplitDropHint.frame.width,
              height: terminalSplitDropHint.frame.height,
            }}
          />,
          document.body,
        )
      ) : null}
    </div>
  );
}

function WorkspaceSidePanel({
  active,
  width,
  sourceSessionId,
  selected,
  onSelect,
  onClose,
}: {
  active: boolean;
  width: number;
  sourceSessionId: string;
  selected: SidePanel;
  onSelect: (panel: SidePanel) => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  const mountedPanels = useRef(new Set<SidePanel>());
  mountedPanels.current.add(selected);
  const session = useAppStore(
    (state) =>
      state.workspace.sessions.find(
        (session) => session.id === sourceSessionId,
      ),
  );
  const host = useAppStore((state) =>
    session
      ? state.sessionHosts[session.id] ??
        state.hosts.find((item) => item.id === session.hostId)
      : undefined,
  );
  const sessionKind = session?.kind;
  return (
    <aside
      className={`workspace-side-panel ${active ? "" : "is-inactive"}`}
      style={{ width }}
    >
      <div className="side-panel-tabs">
        <PanelTab
          active={selected === "sftp"}
          label="SFTP"
          onClick={() => onSelect("sftp")}
        >
          <Folder size={14} strokeWidth={2.2} />
        </PanelTab>
        <PanelTab
          active={selected === "system"}
          label="System"
          onClick={() => onSelect("system")}
        >
          <Activity size={14} strokeWidth={2.2} />
        </PanelTab>
        <PanelTab
          active={selected === "scripts"}
          label="Scripts"
          onClick={() => onSelect("scripts")}
        >
          <SquareTerminal size={14} strokeWidth={2.2} />
        </PanelTab>
        <PanelTab
          active={selected === "history"}
          label="Command History"
          onClick={() => onSelect("history")}
        >
          <History size={14} strokeWidth={2.2} />
        </PanelTab>
        <PanelTab
          active={selected === "notes"}
          label="Notes"
          onClick={() => onSelect("notes")}
        >
          <NotebookText size={14} strokeWidth={2.2} />
        </PanelTab>
        {sessionKind === "ssh" ? <PanelTab
          active={selected === "forwards"}
          label="Forwarding"
          onClick={() => onSelect("forwards")}
        >
          <ArrowLeftRight size={14} strokeWidth={2.2} />
        </PanelTab> : null}
        <IconButton label="Close panel" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="side-panel-account-bar">
        <span
          className={
            (host?.username ?? "local") === "root" ? "is-root" : ""
          }
        >
          <CircleUserRound size={11} />
          {t("Terminal Account")}
          <strong>{host?.username ?? "local"}</strong>
        </span>
        <span
          className={
            (host?.serverToolsUseRoot
              ? "root"
              : host?.username ?? "local") === "root"
              ? "is-root"
              : ""
          }
        >
          <CircleUserRound size={11} />
          {t("Server Tools Account")}
          <strong>
            {host?.serverToolsUseRoot ? "root" : host?.username ?? "local"}
          </strong>
        </span>
      </div>
      <div className="side-panel-content">
        {[...mountedPanels.current].map((panel) => (
          <div
            className={`side-panel-view ${
              panel === selected ? "" : "is-inactive"
            }`}
            key={panel}
          >
            <SidePanelContent
              active={active && panel === selected}
              selected={panel}
              sourceSessionId={sourceSessionId}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}

function SidePanelContent({
  active,
  selected,
  sourceSessionId,
}: {
  active: boolean;
  selected: SidePanel;
  sourceSessionId: string;
}) {
  const t = useTranslation();
  const session = useAppStore((state) =>
    state.workspace.sessions.find(
      (item) => item.id === sourceSessionId,
    ),
  );
  const host = useAppStore((state) =>
    (session ? state.sessionHosts[session.id] : undefined) ??
    state.hosts.find((item) => item.id === session?.hostId),
  );

  if (!session) {
    return <div className="panel-empty">{t("No active terminal")}</div>;
  }

  if (selected === "log") {
    return <ConnectionLogPanel sessionId={session.id} />;
  }

  if (selected === "sftp") {
    return <SftpPanel active={active} host={host} session={session} />;
  }
  if (selected === "system") {
    return <SystemPanel host={host} session={session} />;
  }
  if (selected === "scripts") {
    return <ContextScripts sessionId={session.id} />;
  }
  if (selected === "history") {
    return (
      <ContextCommandHistory
        host={host}
        session={session}
      />
    );
  }
  if (selected === "notes") {
    return <ContextNotes hostId={host?.id} />;
  }
  if (selected === "forwards" && host) {
    return <ContextForwards host={host} />;
  }

  if (!host) {
    return (
      <div className="panel-empty">
        <LayoutPanelTop size={24} />
        <p>{t("This panel is available for SSH sessions.")}</p>
      </div>
    );
  }

  return (
    <div className="panel-placeholder">
        <div className="eyebrow">{t(selected)}</div>
      <h3>{host.label}</h3>
      <p>
        {host.username}@{host.hostname}:{host.port}
      </p>
      <div className="panel-status">{t("Connected terminal context")}</div>
    </div>
  );
}

function ConnectionLogPanel({ sessionId }: { sessionId: string }) {
  const t = useTranslation();
  const entries = useAppStore(
    (state) => state.connectionLogs[sessionId] ?? [],
  );
  return (
    <div className="connection-log-panel">
      <header>
        <div className="eyebrow">{t("Connection log")}</div>
        <span>{entries.length} events</span>
      </header>
      <div>
        {entries.map((entry) => (
          <article className={`log-${entry.status}`} key={entry.id}>
            <time>
              {new Date(entry.createdAt).toLocaleTimeString()}
            </time>
            <strong>{entry.status}</strong>
            <p>{entry.message}</p>
            {entry.detail ? <code>{entry.detail}</code> : null}
          </article>
        ))}
        {entries.length === 0 ? (
          <div className="panel-empty">{t("No connection events yet.")}</div>
        ) : null}
      </div>
    </div>
  );
}

function ContextScripts({ sessionId }: { sessionId: string }) {
  const t = useTranslation();
  const scripts = useAppStore((state) => state.scripts);
  return (
    <div className="side-tool-panel side-tool-scroll">
      <header className="side-tool-heading">
        <h3>{t("Scripts")}</h3>
        <p>{t("Run a saved shell script in this terminal session.")}</p>
      </header>
      {scripts.length === 0 ? (
        <div className="side-tool-empty">
          <SquareTerminal size={24} />
          <strong>{t("No Scripts")}</strong>
        </div>
      ) : (
        <div className="side-tool-cards">
          {scripts.map((script) => (
            <article className="side-script-card" key={script.id}>
              <strong>{script.title}</strong>
              <code>{script.body}</code>
              <footer>
                <button
                  type="button"
                  onClick={() =>
                    void invoke("terminal_write", {
                      sessionId,
                      data: encodeTerminalText(
                        `${script.body}${
                          script.body.endsWith("\n") ? "" : "\n"
                        }`,
                      ),
                    })
                  }
                >
                  <Play size={12} />
                  {t("Run")}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ContextCommandHistory({
  host,
  session,
}: {
  host?: Host;
  session: SessionDescriptor;
}) {
  const t = useTranslation();
  const [query, setQuery] = useState("");
  const [expandedEntryId, setExpandedEntryId] = useState<string>();
  const [fetchedEntries, setFetchedEntries] = useState<
    CommandHistoryEntry[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const loadingRef = useRef(false);
  const commandHistory = useAppStore(selectCommandHistory);
  const capturedEntries = useMemo(
    () =>
      commandHistory.filter(
        (entry) => entry.sessionId === session.id,
      ),
    [commandHistory, session.id],
  );
  const entries = useMemo(
    () => {
      const value = query.trim().toLowerCase();
      const seen = new Set<string>();
      return [...fetchedEntries, ...capturedEntries].filter((entry) => {
        const command = entry.command.trim();
        return (
          command.length > 0 &&
          (!value || command.toLowerCase().includes(value)) &&
          !seen.has(command) &&
          Boolean(seen.add(command))
        );
      });
    },
    [capturedEntries, fetchedEntries, query],
  );

  useEffect(() => {
    void refreshHistory();
  }, [host?.id, session.id]);

  async function refreshHistory() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(undefined);
    try {
      const result = host
        ? await invoke<{
            stdout: string;
            stderr: string;
            code?: number;
          }>("sftp_request", {
            host,
            sourceSessionId: session.id,
            request: {
              action: "exec",
              command: commandHistoryFetchCommand,
              timeoutMS: 12_000,
              elevated: host.serverToolsUseRoot,
            },
          })
        : await invoke<{
            stdout: string;
            stderr: string;
            code?: number;
          }>("local_exec", {
            command: commandHistoryFetchCommand,
            shell: session.shell,
            workingDirectory: session.workingDirectory,
            timeoutMs: 12_000,
          });
      if (result.code && result.code !== 0) {
        throw new Error(result.stderr || t("Failed to read remote history."));
      }
      setFetchedEntries(parseCommandHistory(result.stdout, session.id));
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="side-history-panel">
      <div className="side-history-search">
        <Search size={13} />
        <input
          placeholder={t("Search command history...")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          aria-label={t("Refresh command history")}
          disabled={loading}
          type="button"
          onClick={() => void refreshHistory()}
        >
          <RefreshCw
            className={loading ? "is-spinning" : ""}
            size={13}
          />
        </button>
      </div>
      <div className="side-history-meta">
        {host ? <HostIcon host={host} size={20} /> : null}
        <strong>{host?.label ?? t("Local")}</strong>
        <code>{host?.username ?? "local"}</code>
        <span>{entries.length} {t("commands")}</span>
      </div>
      <div className="side-history-list">
        {loading && entries.length === 0 ? (
          <div className="side-tool-empty">
            <RefreshCw className="is-spinning" size={22} />
            <strong>{t("Loading remote history...")}</strong>
          </div>
        ) : null}
        {loadError && entries.length === 0 ? (
          <div className="side-tool-empty">
            <Activity size={22} />
            <strong>{loadError}</strong>
            <button type="button" onClick={() => void refreshHistory()}>
              {t("Retry")}
            </button>
          </div>
        ) : null}
        {entries.map((entry) => {
          const expanded = expandedEntryId === entry.id;
          return (
            <article
              className={expanded ? "is-expanded" : ""}
              key={entry.id}
            >
              <div>
                <button
                  className="side-history-command"
                  type="button"
                  onClick={() =>
                    setExpandedEntryId(expanded ? undefined : entry.id)
                  }
                >
                  {entry.command.replaceAll("\n", " ")}
                </button>
                <button
                  aria-label={t("Paste to terminal")}
                  type="button"
                  onClick={() =>
                    void invoke("terminal_write", {
                      sessionId: session.id,
                      data: encodeTerminalText(entry.command),
                    })
                  }
                >
                  <ClipboardPaste size={12} />
                </button>
                <button
                  aria-label={t("Run in terminal")}
                  type="button"
                  onClick={() =>
                    void invoke("terminal_write", {
                      sessionId: session.id,
                      data: encodeTerminalText(`${entry.command}\r`),
                    })
                  }
                >
                  <Play size={11} />
                </button>
              </div>
              {expanded ? (
                <section>
                  <code>{entry.command}</code>
                  {entry.createdAt ? (
                    <time>
                      {new Date(entry.createdAt).toLocaleString()}
                    </time>
                  ) : null}
                </section>
              ) : null}
            </article>
          );
        })}
        {!loading && !loadError && entries.length === 0 ? (
          <div className="side-tool-empty">
            <History size={24} />
            <strong>
              {query
                ? t("No matching commands.")
                : t("No command history found on this host.")}
            </strong>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function selectCommandHistory(state: {
  commandHistory: CommandHistoryEntry[];
}) {
  return state.commandHistory;
}

export function parseCommandHistory(
  output: string,
  sessionId: string,
  limit = 1_000,
) {
  const shell = output
    .match(/__TP_HISTORY_SHELL__(\w+)/)?.[1]
    ?.toLowerCase();
  const sources =
    shell === "bash" || shell === "zsh" || shell === "fish"
      ? [shell]
      : ["bash", "zsh", "fish"];
  const entries = sources.flatMap((source) => {
    const marker = `__TP_HISTORY_${source.toUpperCase()}__`;
    const start = output.indexOf(marker);
    if (start < 0) return [];
    const contentStart = start + marker.length;
    const nextMarker = [
      "__TP_HISTORY_BASH__",
      "__TP_HISTORY_ZSH__",
      "__TP_HISTORY_FISH__",
    ]
      .map((candidate) => output.indexOf(candidate, contentStart))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    const section = output
      .slice(contentStart, nextMarker ?? output.length)
      .replace(/\r/g, "")
      .trim();
    return parseHistorySection(source, section, sessionId);
  });
  const seen = new Set<string>();
  return entries
    .reverse()
    .filter((entry) => {
      const command = entry.command.trim();
      return (
        command.length > 0 &&
        !command.includes("__NCMCP_") &&
        !seen.has(command) &&
        Boolean(seen.add(command))
      );
    })
    .slice(0, Math.max(0, limit));
}

function parseHistorySection(
  source: string,
  section: string,
  sessionId: string,
) {
  if (!section) return [];
  if (source === "fish") {
    const entries: CommandHistoryEntry[] = [];
    let command = "";
    let createdAt = "";
    const flush = () => {
      if (!command) return;
      entries.push({
        id: `history-${source}-${entries.length}`,
        sessionId,
        command,
        createdAt,
      });
      command = "";
      createdAt = "";
    };
    for (const line of section.split("\n")) {
      if (line.startsWith("- cmd:")) {
        flush();
        command = line
          .slice("- cmd:".length)
          .trim()
          .replaceAll("\\n", "\n")
          .replaceAll("\\\\", "\\");
      } else if (line.trim().startsWith("when:")) {
        createdAt = historyTimestamp(
          line.trim().slice("when:".length),
        );
      }
    }
    flush();
    return entries;
  }
  if (source === "zsh") {
    return section.split("\n").flatMap((line, index) => {
      const match = line.match(/^: (\d+):\d+;(.*)$/);
      const command = (match?.[2] ?? line).trim();
      return command
        ? [{
            id: `history-${source}-${index}`,
            sessionId,
            command,
            createdAt: historyTimestamp(match?.[1]),
          }]
        : [];
    });
  }
  const entries: CommandHistoryEntry[] = [];
  let createdAt = "";
  for (const line of section.split("\n")) {
    const timestamp = line.match(/^#(\d{10,})$/)?.[1];
    if (timestamp) {
      createdAt = historyTimestamp(timestamp);
      continue;
    }
    const command = line.trim();
    if (!command) continue;
    entries.push({
      id: `history-${source}-${entries.length}`,
      sessionId,
      command,
      createdAt,
    });
    createdAt = "";
  }
  return entries;
}

function historyTimestamp(value?: string) {
  const seconds = Number(value?.trim());
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1_000).toISOString()
    : "";
}

const commandHistoryFetchCommand = String.raw`exec sh -c '
SH="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; [ -n "$SH" ] || SH="$SHELL"
FISH="${"$"}{XDG_DATA_HOME:-$HOME/.local/share}/fish/fish_history"; [ -f "$FISH" ] || FISH="$HOME/.config/fish/fish_history"
case "$SH" in
  *zsh) printf "%s\n" "__TP_HISTORY_SHELL__zsh"; printf "%s\n" "__TP_HISTORY_ZSH__"; tail -n 1000 "${"$"}{HISTFILE:-$HOME/.zsh_history}" 2>/dev/null || true ;;
  *bash) printf "%s\n" "__TP_HISTORY_SHELL__bash"; printf "%s\n" "__TP_HISTORY_BASH__"; tail -n 1000 "${"$"}{HISTFILE:-$HOME/.bash_history}" 2>/dev/null || true ;;
  *fish) printf "%s\n" "__TP_HISTORY_SHELL__fish"; printf "%s\n" "__TP_HISTORY_FISH__"; tail -n 3000 "$FISH" 2>/dev/null || true ;;
  *) printf "%s\n" "__TP_HISTORY_SHELL__unknown"; printf "%s\n" "__TP_HISTORY_BASH__"; tail -n 1000 "$HOME/.bash_history" 2>/dev/null || true; printf "%s\n" "__TP_HISTORY_ZSH__"; tail -n 1000 "$HOME/.zsh_history" 2>/dev/null || true; printf "%s\n" "__TP_HISTORY_FISH__"; tail -n 3000 "$FISH" 2>/dev/null || true ;;
esac
'`;

function ContextNotes({ hostId }: { hostId?: string }) {
  const t = useTranslation();
  const allNotes = useAppStore(selectNotes);
  const saveNote = useAppStore((state) => state.saveNote);
  const deleteEntity = useAppStore((state) => state.deleteEntity);
  const notes = useMemo(
    () => allNotes.filter((note) => note.hostId === hostId),
    [allNotes, hostId],
  );
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (selectedNoteId === null) return;
    const selected = notes.find((note) => note.id === selectedNoteId);
    if (selected) return;
    const first = notes[0];
    setSelectedNoteId(first?.id);
    setTitle(first?.title ?? "");
    setBody(first?.body ?? "");
  }, [hostId, notes, selectedNoteId]);

  function beginNewNote() {
    setSelectedNoteId(null);
    setTitle("");
    setBody("");
  }

  function loadNote(note: HostNote) {
    setSelectedNoteId(note.id);
    setTitle(note.title);
    setBody(note.body);
  }

  function persistNote() {
    const existing = notes.find((note) => note.id === selectedNoteId);
    const timestamp = new Date().toISOString();
    const note: HostNote = {
      id: existing?.id ?? crypto.randomUUID(),
      hostId,
      title: title.trim() || t("New Note"),
      body,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    setSelectedNoteId(note.id);
    void saveNote(note);
  }

  return (
    <div className="side-note-panel">
      <div className="side-tool-scroll">
        <header className="side-tool-title-row">
          <h3>{t("Host Notes")}</h3>
          <button type="button" onClick={beginNewNote}>
            <FilePlus2 size={12} />
            {t("New Note")}
          </button>
        </header>
        <div className="side-note-list">
          {notes.map((note) => (
            <button
              className={selectedNoteId === note.id ? "is-active" : ""}
              key={note.id}
              type="button"
              onClick={() => loadNote(note)}
            >
              <strong>{note.title}</strong>
              <span>{note.body}</span>
            </button>
          ))}
        </div>
        <div className="side-tool-divider" />
        <input
          placeholder={t("Title")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          placeholder={t("Markdown")}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <footer className="side-tool-footer">
        {selectedNoteId ? (
          <button
            className="is-danger"
            type="button"
            onClick={() => {
              const id = selectedNoteId;
              beginNewNote();
              void deleteEntity("note", id);
            }}
          >
            <Trash2 size={12} />
            {t("Delete")}
          </button>
        ) : (
          <span />
        )}
        <button className="is-primary" type="button" onClick={persistNote}>
          <Save size={12} />
          {t("Save")}
        </button>
      </footer>
    </div>
  );
}

export function selectNotes(state: { notes: HostNote[] }) {
  return state.notes;
}

export function workspaceTabTooltip(
  workspace: WorkspaceDocument,
  sessions: SessionDescriptor[],
  sessionHosts: Record<
    string,
    Pick<Host, "username" | "hostname" | "port">
  >,
) {
  const parts: string[] = [];
  const panes = paneCount(workspace.root);
  if (panes > 1) {
    parts.push(`Workspace ${panes}`);
  }
  const session = sessions.find(
    (item) => item.id === workspace.focusedSessionId,
  );
  if (session?.kind === "ssh") {
    const host = sessionHosts[session.id];
    if (host) {
      parts.push(`${host.username}@${host.hostname}:${host.port}`);
    }
  } else if (session?.workingDirectory) {
    parts.push(session.workingDirectory);
  } else if (session?.shell) {
    parts.push(session.shell);
  }
  return {
    title: workspace.title,
    subtitle: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}

function encodeTerminalText(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function tabDropIndicatorEqual(
  left: TabDropIndicator | undefined,
  right: TabDropIndicator | undefined,
) {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.x === right.x &&
      left.top === right.top &&
      left.height === right.height)
  );
}

function workspaceDetachDropEqual(
  left:
    | (WorkspaceDetachTarget & TabDropIndicator)
    | undefined,
  right:
    | (WorkspaceDetachTarget & TabDropIndicator)
    | undefined,
) {
  return (
    tabDropIndicatorEqual(left, right) &&
    left?.destinationIndex === right?.destinationIndex &&
    left?.indicatorX === right?.indicatorX
  );
}

function splitDropHintEqual(
  left: SplitDropHint | undefined,
  right: SplitDropHint | undefined,
) {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.targetWorkspaceId === right.targetWorkspaceId &&
      left.targetSessionId === right.targetSessionId &&
      left.axis === right.axis &&
      left.placement === right.placement &&
      left.frame.left === right.frame.left &&
      left.frame.top === right.frame.top &&
      left.frame.width === right.frame.width &&
      left.frame.height === right.frame.height)
  );
}

function resolveTabInsertion(
  sourceId: string,
  x: number,
  elements: HTMLElement[],
  datasetKey: "workspaceTabId" | "terminalTabId",
) {
  const frames = elements
    .map((element) => ({
      id: element.dataset[datasetKey],
      frame: element.getBoundingClientRect(),
    }))
    .filter(
      (
        item,
      ): item is {
        id: string;
        frame: DOMRect;
      } =>
        Boolean(item.id) &&
        item.frame.width > 0 &&
        item.frame.height > 0,
    )
    .sort((left, right) => left.frame.left - right.frame.left);
  return resolveTabInsertionFromFrames(sourceId, x, frames);
}

export function resolveTabInsertionFromFrames(
  sourceId: string,
  x: number,
  frames: Array<{
    id: string;
    frame: Pick<DOMRect, "left" | "right" | "width" | "height">;
  }>,
) {
  const sourceIndex = frames.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0) return undefined;
  const targets = frames.filter((item) => item.id !== sourceId);
  if (targets.length === 0) return undefined;
  const insertionIndex = targets.findIndex(
    (item) => x < item.frame.left + item.frame.width / 2,
  );
  const resolvedInsertion =
    insertionIndex < 0 ? targets.length : insertionIndex;
  if (resolvedInsertion === sourceIndex) return undefined;
  const indicatorX =
    resolvedInsertion < targets.length
      ? targets[resolvedInsertion].frame.left
      : targets[targets.length - 1].frame.right;
  return {
    rawDestinationIndex:
      resolvedInsertion > sourceIndex
        ? resolvedInsertion + 1
        : resolvedInsertion,
    indicatorX,
  };
}

export function resolveWorkspaceDetachTarget(
  x: number,
  y: number,
  tabBarFrame: Pick<
    DOMRect,
    "left" | "right" | "top" | "bottom" | "width" | "height"
  >,
  frames: Array<{
    id: string;
    frame: Pick<DOMRect, "left" | "right" | "width" | "height">;
  }>,
): WorkspaceDetachTarget | undefined {
  if (
    tabBarFrame.width <= 0 ||
    tabBarFrame.height <= 0 ||
    x < tabBarFrame.left ||
    x > tabBarFrame.right ||
    y < tabBarFrame.top ||
    y > tabBarFrame.bottom
  ) {
    return undefined;
  }
  const orderedFrames = frames
    .filter(
      (item) =>
        item.id && item.frame.width > 0 && item.frame.height > 0,
    )
    .sort((left, right) => left.frame.left - right.frame.left);
  for (const [index, item] of orderedFrames.entries()) {
    if (x <= item.frame.left + item.frame.width / 2) {
      return {
        destinationIndex: index,
        indicatorX: item.frame.left,
      };
    }
    if (x <= item.frame.right) {
      return {
        destinationIndex: index + 1,
        indicatorX: item.frame.right,
      };
    }
  }
  const last = orderedFrames.at(-1);
  return last
    ? {
        destinationIndex: orderedFrames.length,
        indicatorX: last.frame.right,
      }
    : {
        destinationIndex: 0,
        indicatorX: tabBarFrame.left + 8,
      };
}

export function resolveSplitDrop(
  x: number,
  y: number,
  frame: Pick<
    DOMRect,
    "left" | "right" | "top" | "bottom" | "width" | "height"
  >,
): Pick<SplitDropHint, "axis" | "placement" | "frame"> | undefined {
  if (
    frame.width <= 0 ||
    frame.height <= 0 ||
    x < frame.left ||
    x > frame.right ||
    y < frame.top ||
    y > frame.bottom
  ) {
    return undefined;
  }
  const relativeX = (x - frame.left) / frame.width;
  const relativeY = (y - frame.top) / frame.height;
  const vertical =
    Math.abs(relativeX - 0.5) > Math.abs(relativeY - 0.5);
  const placement: SplitPlacement =
    (vertical ? relativeX : relativeY) < 0.5 ? "before" : "after";
  return {
    axis: vertical ? "vertical" : "horizontal",
    placement,
    frame: vertical
      ? {
          left:
            placement === "before"
              ? frame.left
              : frame.left + frame.width / 2,
          top: frame.top,
          width: frame.width / 2,
          height: frame.height,
        }
      : {
          left: frame.left,
          top:
            placement === "before"
              ? frame.top
              : frame.top + frame.height / 2,
          width: frame.width,
          height: frame.height / 2,
        },
  };
}

function animateTabLayout(
  container: HTMLElement,
  selector: string,
  draggedId: string,
  update: () => void,
) {
  const before = new Map(
    Array.from(container.querySelectorAll<HTMLElement>(selector)).map(
      (element) => [
        element,
        element.getBoundingClientRect().left,
      ],
    ),
  );
  update();
  window.requestAnimationFrame(() => {
    for (const [element, previousLeft] of before) {
      if (
        element.dataset.workspaceTabId === draggedId ||
        element.dataset.terminalTabId === draggedId ||
        !element.isConnected
      ) {
        continue;
      }
      const delta = previousLeft - element.getBoundingClientRect().left;
      if (Math.abs(delta) < 0.5) continue;
      element.animate(
        [
          { transform: `translateX(${delta}px)` },
          { transform: "translateX(0)" },
        ],
        {
          duration: 160,
          easing: "ease-in-out",
        },
      );
    }
  });
}

function ContextForwards({ host }: { host: Host }) {
  const t = useTranslation();
  const allForwards = useAppStore(selectForwards);
  const saveForward = useAppStore((state) => state.saveForward);
  const deleteEntity = useAppStore((state) => state.deleteEntity);
  const autoAcceptHostKeys = useAppStore(
    (state) => state.preferences.autoAcceptSshHostKeys,
  );
  const forwards = useMemo(
    () => allForwards.filter((rule) => rule.hostId === host.id),
    [allForwards, host.id],
  );
  const [editingRuleId, setEditingRuleId] = useState<string>();
  const [name, setName] = useState("");
  const [kind, setKind] =
    useState<PortForwardRule["kind"]>("local");
  const [localEndpoint, setLocalEndpoint] =
    useState("127.0.0.1:8080");
  const [remoteEndpoint, setRemoteEndpoint] =
    useState("127.0.0.1:80");
  const [autoStart, setAutoStart] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string>();

  useEffect(() => {
    resetForm();
  }, [host.id]);

  function resetForm() {
    setEditingRuleId(undefined);
    setName(t("Local Forward"));
    setKind("local");
    setLocalEndpoint("127.0.0.1:8080");
    setRemoteEndpoint("127.0.0.1:80");
    setAutoStart(false);
    setValidationMessage(undefined);
  }

  function loadRule(rule: PortForwardRule) {
    setEditingRuleId(rule.id);
    setName(rule.name);
    setKind(rule.kind);
    setLocalEndpoint(`${rule.bindAddress}:${rule.localPort}`);
    setRemoteEndpoint(
      `${rule.remoteHost}:${rule.remotePort ?? rule.localPort}`,
    );
    setAutoStart(rule.autoStart);
    setValidationMessage(undefined);
  }

  function persistRule() {
    const local = parseForwardEndpoint(localEndpoint);
    const remote =
      kind === "dynamic"
        ? { host: "127.0.0.1", port: undefined }
        : parseForwardEndpoint(remoteEndpoint);
    if (!local) {
      setValidationMessage(t("Enter a valid local IP:port."));
      return;
    }
    if (!remote) {
      setValidationMessage(t("Enter a valid remote IP:port."));
      return;
    }
    const existing = forwards.find((rule) => rule.id === editingRuleId);
    const timestamp = new Date().toISOString();
    const rule: PortForwardRule = {
      id: existing?.id ?? crypto.randomUUID(),
      hostId: host.id,
      name: name.trim() || t("Local Forward"),
      order: existing?.order,
      kind,
      bindAddress: local.host,
      localPort: local.port,
      remoteHost: remote.host,
      remotePort: remote.port,
      autoStart,
      status: existing?.status ?? "inactive",
      error: existing?.error,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastUsedAt: existing?.lastUsedAt,
    };
    setEditingRuleId(rule.id);
    setValidationMessage(undefined);
    void saveForward(rule);
  }

  function toggleRule(rule: PortForwardRule) {
    if (rule.status === "active" || rule.status === "connecting") {
      void invoke("forward_stop", { id: rule.id }).then(() =>
        saveForward({
          ...rule,
          status: "inactive",
          error: undefined,
          updatedAt: new Date().toISOString(),
        }),
      );
      return;
    }
    const connecting: PortForwardRule = {
      ...rule,
      status: "connecting",
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    void saveForward(connecting);
    void invoke("forward_start", {
      host,
      rule,
      autoAcceptHostKeys,
    })
      .then(() =>
        saveForward({
          ...rule,
          status: "active",
          error: undefined,
          lastUsedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      )
      .catch((reason: unknown) =>
        saveForward({
          ...rule,
          status: "error",
          error: String(reason),
          updatedAt: new Date().toISOString(),
        }),
      );
  }

  return (
    <div className="side-forward-panel side-tool-scroll">
      <header className="side-tool-title-row">
        <h3>{t("Port Forwarding")}</h3>
        <button type="button" onClick={resetForm}>
          <Plus size={12} />
          {t("New Forward")}
        </button>
      </header>
      <div className="side-tool-cards">
        {forwards.map((rule) => (
          <article className="side-forward-card" key={rule.id}>
            <strong>{rule.name}</strong>
            <code>{forwardRuleDetail(rule)}</code>
            <div>
              <span className={`forward-state is-${rule.status}`}>
                {t(rule.status)}
              </span>
              <button type="button" onClick={() => toggleRule(rule)}>
                {t(
                  rule.status === "active" ||
                    rule.status === "connecting"
                    ? "Stop"
                    : "Start",
                )}
              </button>
              <button type="button" onClick={() => loadRule(rule)}>
                {t("Edit")}
              </button>
              <button
                className="is-danger"
                type="button"
                onClick={() => void deleteEntity("forward", rule.id)}
              >
                {t("Delete")}
              </button>
            </div>
            {rule.status === "error" && rule.error ? (
              <p>{rule.error}</p>
            ) : null}
          </article>
        ))}
      </div>
      <div className="side-tool-divider" />
      <div className="side-forward-form">
        <input
          placeholder={t("Name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="side-segmented-control">
          {(["local", "remote", "dynamic"] as const).map((item) => (
            <button
              className={kind === item ? "is-active" : ""}
              key={item}
              type="button"
              onClick={() => setKind(item)}
            >
              {t(forwardKindTitle(item))}
            </button>
          ))}
        </div>
        <p>{t(forwardKindDescription(kind))}</p>
        <label className="side-tool-toggle">
          <span>{t("Auto Start")}</span>
          <input
            checked={autoStart}
            type="checkbox"
            onChange={(event) => setAutoStart(event.target.checked)}
          />
        </label>
        <label className="side-forward-endpoint">
          <span>{t("Local IP:Port")}</span>
          <input
            value={localEndpoint}
            onChange={(event) => setLocalEndpoint(event.target.value)}
          />
        </label>
        {kind !== "dynamic" ? (
          <label className="side-forward-endpoint">
            <span>{t("Remote IP:Port")}</span>
            <input
              value={remoteEndpoint}
              onChange={(event) => setRemoteEndpoint(event.target.value)}
            />
          </label>
        ) : null}
        {validationMessage ? (
          <p className="side-tool-error">{validationMessage}</p>
        ) : null}
        <footer>
          <button className="is-primary" type="button" onClick={persistRule}>
            <Save size={12} />
            {t("Save")}
          </button>
        </footer>
      </div>
      {forwards.length === 0 ? (
        <div className="side-tool-empty is-compact">
          <ArrowLeftRight size={22} />
          <strong>{t("No forwarding rules for this host.")}</strong>
        </div>
      ) : null}
    </div>
  );
}

export function selectForwards(state: {
  forwards: PortForwardRule[];
}) {
  return state.forwards;
}

export function bindWorkspaceSidePanel(
  panels: WorkspaceSidePanels,
  workspaceId: string,
  sourceSessionId: string,
  selected: SidePanel,
  hostId?: string,
) {
  return {
    ...panels,
    [workspaceId]: {
      selected,
      sourceSessionId,
      hostId,
    },
  };
}

export function retargetWorkspaceSidePanel(
  panels: WorkspaceSidePanels,
  workspaceId: string,
  sourceSessionId: string,
  hostId?: string,
) {
  const panel = panels[workspaceId];
  if (!panel || panel.sourceSessionId === sourceSessionId) return panels;
  return bindWorkspaceSidePanel(
    panels,
    workspaceId,
    sourceSessionId,
    panel.selected,
    hostId,
  );
}

export function selectWorkspaceSidePanel(
  panels: WorkspaceSidePanels,
  workspaceId: string,
  selected: SidePanel,
) {
  const panel = panels[workspaceId];
  if (!panel || panel.selected === selected) return panels;
  return {
    ...panels,
    [workspaceId]: {
      ...panel,
      selected,
    },
  };
}

function closeSidePanelConnection(panel: WorkspaceSidePanelState) {
  if (!panel.hostId) return;
  void invoke("sftp_close", {
    hostId: panel.hostId,
    sourceSessionId: panel.sourceSessionId,
  });
}

export function shouldCloseSidePanelForLayout(
  previousWorkspaceId: string | undefined,
  previousPaneCount: number,
  workspaceId: string | undefined,
  paneCount: number,
) {
  return Boolean(
    workspaceId &&
      paneCount > 1 &&
      (previousWorkspaceId !== workspaceId ||
        paneCount > previousPaneCount),
  );
}

export type TerminalLatencyQuality = "good" | "elevated" | "poor";

export function terminalLatencyQuality(
  milliseconds: number,
): TerminalLatencyQuality {
  if (milliseconds <= 150) return "good";
  if (milliseconds <= 400) return "elevated";
  return "poor";
}

export function parseForwardEndpoint(value: string) {
  const match = value.trim().match(/^(.*):(\d+)$/);
  if (!match) return undefined;
  const host = match[1].trim();
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return { host, port };
}

function forwardKindTitle(kind: PortForwardRule["kind"]) {
  if (kind === "local") return "Local";
  if (kind === "remote") return "Remote";
  return "Dynamic SOCKS";
}

function forwardKindDescription(kind: PortForwardRule["kind"]) {
  if (kind === "local") return "Port Forward Local Description";
  if (kind === "remote") return "Port Forward Remote Description";
  return "Port Forward Dynamic Description";
}

function forwardRuleDetail(rule: PortForwardRule) {
  const local = `${rule.bindAddress}:${rule.localPort}`;
  if (rule.kind === "dynamic") return `dynamic ${local}`;
  const remote = `${rule.remoteHost}:${
    rule.remotePort ?? rule.localPort
  }`;
  return rule.kind === "local"
    ? `local ${local} -> ${remote}`
    : `remote ${remote} -> ${local}`;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslation();
  return (
    <button
      className="icon-button"
      type="button"
      title={t(label)}
      aria-label={t(label)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PanelTab({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslation();
  return (
    <button
      className={`panel-tab ${active ? "is-active" : ""}`}
      type="button"
      aria-label={t(label)}
      onClick={onClick}
    >
      {children}
      <span>{t(label)}</span>
    </button>
  );
}
