import { open } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  Box,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Code2,
  Columns2,
  Container,
  Copy,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Folder,
  FolderCog,
  FolderOpen,
  FolderPlus,
  Globe2,
  HardDrive,
  KeyRound,
  Lock,
  MinusSquare,
  Monitor,
  Network,
  Pencil,
  Play,
  Plus,
  Rows2,
  Router,
  Server,
  ServerCog,
  Settings,
  Shield,
  SlidersHorizontal,
  Square,
  TerminalSquare,
  Trash2,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { id, now, useAppStore } from "../store";
import type {
  Credential,
  Host,
  HostGroup,
  ProxyConfiguration,
  SplitAxis,
} from "../types";
import { useTranslation } from "../i18n";
import {
  TextPrompt,
  type TextPromptState,
} from "./TextPrompt";
import { SidebarToggleIcon } from "./SidebarToggleIcon";

export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const t = useTranslation();
  const hosts = useAppStore((state) => state.hosts);
  const groups = useAppStore((state) => state.groups);
  const credentials = useAppStore((state) => state.credentials);
  const scripts = useAppStore((state) => state.scripts);
  const proxies = useAppStore((state) => state.proxies);
  const navigation = useAppStore((state) => state.navigation);
  const setNavigation = useAppStore((state) => state.setNavigation);
  const openHost = useAppStore((state) => state.openHostSession);
  const selectedHostId = useAppStore((state) => state.selectedHostId);
  const selectHost = useAppStore((state) => state.selectHost);
  const saveGroup = useAppStore((state) => state.saveGroup);
  const deleteGroup = useAppStore((state) => state.deleteGroup);
  const saveHost = useAppStore((state) => state.saveHost);
  const saveHosts = useAppStore((state) => state.saveHosts);
  const deleteHost = useAppStore((state) => state.deleteHost);
  const [search, setSearch] = useState("");
  const [editingHost, setEditingHost] = useState<Host>();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => initialCollapsedGroupIds(groups),
  );
  const knownGroupIdsRef = useRef(initialCollapsedGroupIds(groups));
  const [draggedHost, setDraggedHost] = useState<string>();
  const [draggedGroup, setDraggedGroup] = useState<string>();
  const [isBatchManaging, setIsBatchManaging] = useState(false);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(
    new Set(),
  );
  const [batchError, setBatchError] = useState<string>();
  const [prompt, setPrompt] = useState<TextPromptState>();
  const [hostMenu, setHostMenu] = useState<{
    host: Host;
    x: number;
    y: number;
  }>();
  const hostMenuRef = useRef<HTMLDivElement>(null);
  const [hostMenuPosition, setHostMenuPosition] = useState({
    left: 8,
    top: 8,
  });
  const [groupMenu, setGroupMenu] = useState<{
    group: HostGroup;
    x: number;
    y: number;
  }>();
  const [deletingGroup, setDeletingGroup] = useState<HostGroup>();

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return hosts;
    return hosts.filter((host) =>
      [host.label, host.hostname, host.username].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [hosts, search]);

  const rootHosts = filtered
    .filter((host) => !host.groupId)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const groupTree = useMemo(() => buildHostGroupTree(groups), [groups]);
  const groupOptions = useMemo(
    () => flattenHostGroupTree(groupTree),
    [groupTree],
  );

  useEffect(() => {
    const currentIds = new Set(groups.map((group) => group.id));
    setCollapsedGroups((collapsed) =>
      reconcileCollapsedGroupIds(
        collapsed,
        knownGroupIdsRef.current,
        currentIds,
      ),
    );
    knownGroupIdsRef.current = currentIds;
  }, [groups]);

  const hostMenuPassword = hostMenu
    ? hostLoginPassword(hostMenu.host, credentials)
    : undefined;

  function connectHost(
    host: Host,
    axis?: SplitAxis,
    startupCommand?: string,
  ) {
    const session = openHost(host, axis, startupCommand);
    setNavigation("hosts");
    return session;
  }

  useLayoutEffect(() => {
    if (!hostMenu) return;

    const updatePosition = () => {
      const menu = hostMenuRef.current;
      if (!menu) return;
      const bounds = menu.getBoundingClientRect();
      setHostMenuPosition(
        contextMenuPosition(
          hostMenu.x,
          hostMenu.y,
          bounds.width,
          bounds.height,
        ),
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [hostMenu]);

  function moveHost(sourceId: string, beforeId?: string, groupId?: string) {
    if (isBatchManaging) return;
    const source = hosts.find((host) => host.id === sourceId);
    if (!source) return;
    const targetGroup =
      groupId ?? hosts.find((host) => host.id === beforeId)?.groupId;
    const siblings = hosts
      .filter((host) => host.id !== sourceId && host.groupId === targetGroup)
      .sort((left, right) => left.sortOrder - right.sortOrder);
    const destination = beforeId
      ? Math.max(
          0,
          siblings.findIndex((host) => host.id === beforeId),
        )
      : siblings.length;
    siblings.splice(destination, 0, { ...source, groupId: targetGroup });
    siblings.forEach((host, index) => {
      void saveHost({ ...host, groupId: targetGroup, sortOrder: index });
    });
  }

  function moveGroup(sourceId: string, parentGroupId?: string) {
    if (isBatchManaging) return;
    const source = groups.find((group) => group.id === sourceId);
    if (
      !source ||
      sourceId === parentGroupId ||
      (parentGroupId &&
        groupDescendantIds(groups, sourceId).has(parentGroupId))
    ) {
      return;
    }
    const siblings = groups.filter(
      (group) =>
        group.id !== sourceId &&
        group.parentGroupId === parentGroupId,
    );
    void saveGroup({
      ...source,
      parentGroupId,
      sortOrder: siblings.length,
    });
  }

  function toggleBatchManaging() {
    setIsBatchManaging((active) => {
      if (active) setSelectedHostIds(new Set());
      return !active;
    });
    setBatchError(undefined);
  }

  function toggleHostSelection(hostId: string) {
    setSelectedHostIds((selected) => {
      const next = new Set(selected);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });
  }

  function toggleGroupSelection(groupId: string) {
    const hostIds = hostIdsInGroup(groups, hosts, groupId);
    if (hostIds.size === 0) return;
    setSelectedHostIds((selected) => {
      const next = new Set(selected);
      if ([...hostIds].every((id) => next.has(id))) {
        hostIds.forEach((id) => next.delete(id));
      } else {
        hostIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  async function updateSelectedHosts(
    update: (host: Host) => Host,
  ) {
    const selected = hosts.filter((host) => selectedHostIds.has(host.id));
    if (selected.length === 0) return;
    setBatchError(undefined);
    try {
      await saveHosts(selected.map(update));
      setSelectedHostIds(new Set());
      setIsBatchManaging(false);
    } catch (reason) {
      setBatchError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function moveSelectedHosts(groupId?: string) {
    const updated = hostsMovedToGroup(hosts, selectedHostIds, groupId);
    if (updated.length === 0) return;
    setBatchError(undefined);
    try {
      await saveHosts(updated);
      setSelectedHostIds(new Set());
      setIsBatchManaging(false);
    } catch (reason) {
      setBatchError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <>
      <aside className="app-sidebar">
        <div className="sidebar-titlebar" data-tauri-drag-region>
          <button
            aria-label={t("Hide Sidebar")}
            className="sidebar-collapse-button"
            type="button"
            title={t("Hide Sidebar")}
            onClick={onCollapse}
          >
            <SidebarToggleIcon />
          </button>
        </div>
        <div className="sidebar-brand">
          <div>
            <strong>TermPilot</strong>
            <span>{t("SSH Workspace")}</span>
          </div>
          <button
            type="button"
            title={t("New host")}
            onClick={() => setEditingHost(makeEmptyHost())}
          >
            <Plus size={14} />
          </button>
        </div>

        <div className="sidebar-management-buttons">
          <button type="button" onClick={() => setNavigation("groups")}>
            <FolderCog size={14} />
            {t("Group Settings")}
          </button>
          <button
            className={isBatchManaging ? "is-active" : ""}
            type="button"
            disabled={filtered.length === 0}
            onClick={toggleBatchManaging}
          >
            {t(isBatchManaging ? "Done" : "Batch Manage")}
          </button>
        </div>

        <div className="sidebar-search">
          <input
            aria-label={t("Search hosts")}
            placeholder={t("Search hosts")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {isBatchManaging ? (
          <div className="host-batch-bar">
            <div className="host-batch-title">
              <span>{t("Batch Manage Hosts")}</span>
              <strong>{selectedHostIds.size}</strong>
            </div>
            <div className="host-batch-selection">
              <button
                type="button"
                onClick={() =>
                  setSelectedHostIds(
                    new Set([
                      ...selectedHostIds,
                      ...filtered.map((host) => host.id),
                    ]),
                  )
                }
              >
                {t("Select All")}
              </button>
              <button
                type="button"
                disabled={selectedHostIds.size === 0}
                onClick={() => setSelectedHostIds(new Set())}
              >
                {t("Clear")}
              </button>
            </div>
            <select
              aria-label={t("Switch Group")}
              disabled={selectedHostIds.size === 0}
              value=""
              onChange={(event) => {
                const groupId =
                  event.target.value === "__ungrouped__"
                    ? undefined
                    : event.target.value;
                void moveSelectedHosts(groupId);
              }}
            >
              <option disabled value="">
                {t("Switch Group")}
              </option>
              <option value="__ungrouped__">{t("No Group")}</option>
              {groupOptions.map(({ group, depth }) => (
                <option key={group.id} value={group.id}>
                  {`${"  ".repeat(depth)}${group.name}`}
                </option>
              ))}
            </select>
            <select
              aria-label={t("Assign Proxy")}
              disabled={selectedHostIds.size === 0}
              value=""
              onChange={(event) => {
                const proxyProfileId =
                  event.target.value === "__disabled__"
                    ? undefined
                    : event.target.value;
                void updateSelectedHosts((host) => ({
                  ...host,
                  proxyProfileId,
                  proxyConfiguration: undefined,
                  updatedAt: now(),
                }));
              }}
            >
              <option disabled value="">
                {t("Assign Proxy")}
              </option>
              <option value="__disabled__">{t("Disable Proxy")}</option>
              {proxies.map((proxy) => (
                <option key={proxy.id} value={proxy.id}>
                  {proxy.label}
                </option>
              ))}
            </select>
            {batchError ? <small>{batchError}</small> : null}
          </div>
        ) : null}

        <div className="sidebar-hosts-label">{t("Hosts")}</div>
        <div className="host-tree">
          {rootHosts.map((host) => (
            <HostRow
              batchManaging={isBatchManaging}
              batchSelected={selectedHostIds.has(host.id)}
              host={host}
              key={host.id}
              selected={host.id === selectedHostId}
              onSelect={() =>
                isBatchManaging
                  ? toggleHostSelection(host.id)
                  : selectHost(host.id)
              }
              onConnect={() => connectHost(host)}
              onEdit={() => setEditingHost(host)}
              onContext={(x, y) => setHostMenu({ host, x, y })}
              onDragStart={() => setDraggedHost(host.id)}
              onDrop={() => {
                if (draggedHost) moveHost(draggedHost, host.id, host.groupId);
                setDraggedHost(undefined);
              }}
            />
          ))}
          {groupTree.map((node) => (
            <HostGroupNode
              allGroups={groups}
              allHosts={hosts}
              batchManaging={isBatchManaging}
              collapsedGroups={collapsedGroups}
              draggedGroup={draggedGroup}
              draggedHost={draggedHost}
              filteredHosts={filtered}
              key={node.group.id}
              node={node}
              searchActive={Boolean(search)}
              selectedHostIds={selectedHostIds}
              selectedHostId={selectedHostId}
              onConnect={connectHost}
              onDragGroup={setDraggedGroup}
              onDragHost={setDraggedHost}
              onDropGroup={moveGroup}
              onDropHost={moveHost}
              onEditHost={setEditingHost}
              onContextHost={(host, x, y) =>
                setHostMenu({ host, x, y })
              }
              onContextGroup={(group, x, y) =>
                setGroupMenu({ group, x, y })
              }
              onToggleGroupSelection={toggleGroupSelection}
              onToggleHostSelection={toggleHostSelection}
              onSelectHost={selectHost}
              onToggle={(id) => {
                const next = new Set(collapsedGroups);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                setCollapsedGroups(next);
              }}
            />
          ))}
          {filtered.length === 0 ? (
            <div className="host-tree-empty">{t("No matching hosts")}</div>
          ) : null}
        </div>
        <div className="sidebar-settings-entry">
          <button
            className={navigation !== "hosts" ? "is-active" : ""}
            type="button"
            onClick={() => setNavigation("settings")}
          >
            <Settings size={14} />
            <span>{t("Settings")}</span>
          </button>
        </div>
      </aside>

      {editingHost ? (
        createPortal(
          <HostEditor
            host={editingHost}
            onClose={() => setEditingHost(undefined)}
          />,
          document.body,
        )
      ) : null}
      {prompt ? (
        <TextPrompt prompt={prompt} onClose={() => setPrompt(undefined)} />
      ) : null}
      {hostMenu ? (
        createPortal(<div
          ref={hostMenuRef}
          className="workspace-context-menu host-context-menu"
          style={hostMenuPosition}
          onMouseLeave={() => setHostMenu(undefined)}
        >
          <button type="button" onClick={() => {
            connectHost(hostMenu.host);
            setHostMenu(undefined);
          }}>
            <Monitor size={14} />
            {t("Connect")}
          </button>
          <button type="button" onClick={() => {
            connectHost(hostMenu.host, "vertical");
            setHostMenu(undefined);
          }}>
            <Columns2 size={14} />
            {t("Connect in Vertical Split")}
          </button>
          <button type="button" onClick={() => {
            connectHost(hostMenu.host, "horizontal");
            setHostMenu(undefined);
          }}>
            <Rows2 size={14} />
            {t("Connect in Horizontal Split")}
          </button>
          <div className="host-script-menu">
            <button type="button">
              <Code2 size={14} />
              <span>{t("Run Script")}</span>
              <ChevronRight size={13} />
            </button>
            <div>
              {scripts.length === 0 ? (
                <button disabled type="button">
                  {t("No Scripts")}
                </button>
              ) : (
                scripts.map((script) => (
                  <button
                    key={script.id}
                    type="button"
                    onClick={() => {
                      const command = normalizedScriptCommand(script.body);
                      if (command) {
                        connectHost(hostMenu.host, undefined, command);
                      }
                      setHostMenu(undefined);
                    }}
                  >
                    <Play size={12} />
                    {script.title}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="context-menu-divider" />
          <button type="button" onClick={() => {
            void copyText(hostMenu.host.hostname);
            setHostMenu(undefined);
          }}>
            <Globe2 size={14} />
            {t("Copy IP")}
          </button>
          <button
            disabled={!hostMenuPassword}
            type="button"
            onClick={() => {
              if (hostMenuPassword) void copyText(hostMenuPassword);
              setHostMenu(undefined);
            }}
          >
            <KeyRound size={14} />
            {t("Copy Password")}
          </button>
          <div className="context-menu-divider" />
          <button type="button" onClick={() => {
            setEditingHost(hostMenu.host);
            setHostMenu(undefined);
          }}>
            <SlidersHorizontal size={14} />
            {t("Edit")}
          </button>
          <button type="button" onClick={() => {
            const timestamp = now();
            const copiedHost = {
              ...hostMenu.host,
              id: id(),
              label: `${hostMenu.host.label} ${t("Copy")}`,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
            void saveHost(copiedHost);
            setEditingHost(copiedHost);
            setHostMenu(undefined);
          }}>
            <Copy size={14} />
            {t("Duplicate")}
          </button>
          <button className="is-destructive" type="button" onClick={() => {
            void deleteHost(hostMenu.host.id);
            setHostMenu(undefined);
          }}>
            <Trash2 size={14} />
            {t("Delete")}
          </button>
        </div>, document.body)
      ) : null}
      {groupMenu ? (
        createPortal(
          <div
            className="workspace-context-menu group-context-menu"
            style={contextMenuPosition(
              groupMenu.x,
              groupMenu.y,
              230,
              isBatchManaging ? 39 : 182,
            )}
            onMouseLeave={() => setGroupMenu(undefined)}
          >
            {!isBatchManaging ? (
              <>
                <button type="button" onClick={() => {
                  setEditingHost({
                    ...makeEmptyHost(),
                    groupId: groupMenu.group.id,
                  });
                  setGroupMenu(undefined);
                }}>
                  <Plus size={13} />
                  {t("New Host in This Group")}
                </button>
                <button type="button" onClick={() => {
                  const siblings = groups.filter(
                    (group) =>
                      group.parentGroupId === groupMenu.group.id,
                  );
                  void saveGroup({
                    id: id(),
                    name: availableGroupName(
                      groups,
                      groupMenu.group.id,
                      t("New group"),
                    ),
                    parentGroupId: groupMenu.group.id,
                    sortOrder: siblings.length,
                  });
                  setCollapsedGroups((current) => {
                    const next = new Set(current);
                    next.delete(groupMenu.group.id);
                    return next;
                  });
                  setGroupMenu(undefined);
                }}>
                  <FolderPlus size={13} />
                  {t("New Subgroup")}
                </button>
                <button type="button" onClick={() => {
                  const group = groupMenu.group;
                  setPrompt({
                    title: "Rename group",
                    label: "Group name",
                    value: group.name,
                    submit: (name) => saveGroup({ ...group, name }),
                  });
                  setGroupMenu(undefined);
                }}>
                  <Pencil size={13} />
                  {t("Rename Group")}
                </button>
                <button
                  className="is-destructive"
                  type="button"
                  onClick={() => {
                    setDeletingGroup(groupMenu.group);
                    setGroupMenu(undefined);
                  }}
                >
                  <Trash2 size={13} />
                  {t("Delete Group")}
                </button>
                <div className="context-menu-divider" />
              </>
            ) : null}
            <button type="button" onClick={() => {
              toggleBatchManaging();
              setGroupMenu(undefined);
            }}>
              <CheckSquare2 size={13} />
              {t(isBatchManaging ? "Done" : "Batch Manage")}
            </button>
          </div>,
          document.body,
        )
      ) : null}
      {deletingGroup ? (
        createPortal(
          <div
            className="modal-backdrop group-delete-backdrop"
            role="presentation"
            onMouseDown={() => setDeletingGroup(undefined)}
          >
            <section
              className="delete-group-sheet"
              role="dialog"
              aria-modal="true"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <h2>{t("Delete Group")}</h2>
              <strong>{deletingGroup.name}</strong>
              <p>
                {t(
                  "Deleting this group will also delete its subgroups. Hosts in these groups will be moved to No Group.",
                )}
              </p>
              <footer>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setDeletingGroup(undefined)}
                >
                  {t("Cancel")}
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => {
                    const id = deletingGroup.id;
                    setDeletingGroup(undefined);
                    void deleteGroup(id);
                  }}
                >
                  {t("Delete")}
                </button>
              </footer>
            </section>
          </div>,
          document.body,
        )
      ) : null}
    </>
  );
}

export function contextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
) {
  return {
    left: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    top: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}

function HostGroupNode({
  node,
  allGroups,
  allHosts,
  filteredHosts,
  collapsedGroups,
  selectedHostId,
  selectedHostIds,
  searchActive,
  batchManaging,
  draggedHost,
  draggedGroup,
  onToggle,
  onToggleGroupSelection,
  onToggleHostSelection,
  onSelectHost,
  onConnect,
  onEditHost,
  onContextHost,
  onContextGroup,
  onDragHost,
  onDragGroup,
  onDropHost,
  onDropGroup,
}: {
  node: HostGroupTreeNode;
  allGroups: HostGroup[];
  allHosts: Host[];
  filteredHosts: Host[];
  collapsedGroups: Set<string>;
  selectedHostId?: string;
  selectedHostIds: Set<string>;
  searchActive: boolean;
  batchManaging: boolean;
  draggedHost?: string;
  draggedGroup?: string;
  onToggle: (id: string) => void;
  onToggleGroupSelection: (id: string) => void;
  onToggleHostSelection: (id: string) => void;
  onSelectHost: (id: string) => void;
  onConnect: (host: Host) => void;
  onEditHost: (host: Host) => void;
  onContextHost: (host: Host, x: number, y: number) => void;
  onContextGroup: (group: HostGroup, x: number, y: number) => void;
  onDragHost: (id?: string) => void;
  onDragGroup: (id?: string) => void;
  onDropHost: (sourceId: string, beforeId?: string, groupId?: string) => void;
  onDropGroup: (sourceId: string, parentGroupId?: string) => void;
}) {
  const group = node.group;
  const directHosts = filteredHosts
    .filter((host) => host.groupId === group.id)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const visibleHostCount = groupHostCount(
    allGroups,
    filteredHosts,
    group.id,
  );
  if (searchActive && visibleHostCount === 0) return null;
  const collapsed = collapsedGroups.has(group.id) && !searchActive;
  const groupHostIds = hostIdsInGroup(
    allGroups,
    allHosts,
    group.id,
  );
  const selectionState = batchSelectionState(
    groupHostIds,
    selectedHostIds,
  );
  return (
    <div
      className={`host-group ${
        batchManaging && selectionState !== "none"
          ? `is-batch-${selectionState}`
          : ""
      }`}
    >
      <div className="host-group-header">
        <button
          className="host-group-row"
          draggable={!batchManaging}
          type="button"
          onClick={() =>
            batchManaging
              ? onToggleGroupSelection(group.id)
              : onToggle(group.id)
          }
          onContextMenu={(event) => {
            event.preventDefault();
            onContextGroup(group, event.clientX, event.clientY);
          }}
          onDragStart={() => onDragGroup(group.id)}
          onDragEnd={() => onDragGroup(undefined)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (draggedHost) {
              onDropHost(draggedHost, undefined, group.id);
              onDragHost(undefined);
            } else if (draggedGroup) {
              onDropGroup(draggedGroup, group.id);
              onDragGroup(undefined);
            }
          }}
        >
          {batchManaging ? (
            <BatchSelectionIcon state={selectionState} />
          ) : collapsed ? (
            <ChevronRight size={12} />
          ) : (
            <ChevronDown size={12} />
          )}
          {collapsed ? (
            <Folder size={13} />
          ) : (
            <FolderOpen size={13} />
          )}
          <span>{group.name}</span>
          <small>{visibleHostCount}</small>
        </button>
      </div>
      {!collapsed ? (
        <div className="host-group-children">
          {directHosts.map((host) => (
            <HostRow
              batchManaging={batchManaging}
              batchSelected={selectedHostIds.has(host.id)}
              host={host}
              indented
              key={host.id}
              selected={host.id === selectedHostId}
              onSelect={() =>
                batchManaging
                  ? onToggleHostSelection(host.id)
                  : onSelectHost(host.id)
              }
              onConnect={() => onConnect(host)}
              onEdit={() => onEditHost(host)}
              onContext={(x, y) => onContextHost(host, x, y)}
              onDragStart={() => onDragHost(host.id)}
              onDrop={() => {
                if (draggedHost) {
                  onDropHost(draggedHost, host.id, group.id);
                  onDragHost(undefined);
                }
              }}
            />
          ))}
          {node.children.map((child) => (
            <HostGroupNode
              allGroups={allGroups}
              allHosts={allHosts}
              batchManaging={batchManaging}
              collapsedGroups={collapsedGroups}
              draggedGroup={draggedGroup}
              draggedHost={draggedHost}
              filteredHosts={filteredHosts}
              key={child.group.id}
              node={child}
              searchActive={searchActive}
              selectedHostIds={selectedHostIds}
              selectedHostId={selectedHostId}
              onConnect={onConnect}
              onDragGroup={onDragGroup}
              onDragHost={onDragHost}
              onDropGroup={onDropGroup}
              onDropHost={onDropHost}
              onEditHost={onEditHost}
              onContextHost={onContextHost}
              onContextGroup={onContextGroup}
              onSelectHost={onSelectHost}
              onToggle={onToggle}
              onToggleGroupSelection={onToggleGroupSelection}
              onToggleHostSelection={onToggleHostSelection}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type BatchSelectionState = "none" | "partial" | "all";

interface HostGroupTreeNode {
  group: HostGroup;
  children: HostGroupTreeNode[];
}

export function initialCollapsedGroupIds(groups: HostGroup[]) {
  return new Set(groups.map((group) => group.id));
}

export function reconcileCollapsedGroupIds(
  collapsed: Set<string>,
  known: Set<string>,
  current: Set<string>,
) {
  const next = new Set([...collapsed].filter((id) => current.has(id)));
  for (const id of current) {
    if (!known.has(id)) next.add(id);
  }
  return next;
}

export function availableGroupName(
  groups: HostGroup[],
  parentGroupId: string | undefined,
  baseName: string,
) {
  const names = new Set(
    groups
      .filter((group) => group.parentGroupId === parentGroupId)
      .map((group) => group.name),
  );
  if (!names.has(baseName)) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

export function buildHostGroupTree(
  groups: HostGroup[],
): HostGroupTreeNode[] {
  const sorted = [...groups].sort(compareGroups);
  const validIds = new Set(groups.map((group) => group.id));
  const remaining = new Set(validIds);

  function append(
    group: HostGroup,
    ancestors: Set<string>,
  ): HostGroupTreeNode {
    remaining.delete(group.id);
    const nextAncestors = new Set(ancestors).add(group.id);
    return {
      group,
      children: sorted
        .filter(
          (candidate) =>
            candidate.parentGroupId === group.id &&
            !nextAncestors.has(candidate.id),
        )
        .map((child) => append(child, nextAncestors)),
    };
  }

  const nodes = sorted
    .filter(
      (group) =>
        !group.parentGroupId || !validIds.has(group.parentGroupId),
    )
    .map((group) => append(group, new Set()));
  for (const group of sorted) {
    if (remaining.has(group.id)) {
      nodes.push(append(group, new Set()));
    }
  }
  return nodes;
}

export function flattenHostGroupTree(
  nodes: HostGroupTreeNode[],
  depth = 0,
): Array<{ group: HostGroup; depth: number }> {
  return nodes.flatMap((node) => [
    { group: node.group, depth },
    ...flattenHostGroupTree(node.children, depth + 1),
  ]);
}

export function groupDescendantIds(groups: HostGroup[], id: string) {
  const result = new Set<string>();
  const visit = (parentId: string) => {
    for (const group of groups.filter(
      (item) => item.parentGroupId === parentId,
    )) {
      if (result.has(group.id)) continue;
      result.add(group.id);
      visit(group.id);
    }
  };
  visit(id);
  return result;
}

export function hostIdsInGroup(
  groups: HostGroup[],
  hosts: Host[],
  groupId: string,
) {
  const groupIds = groupDescendantIds(groups, groupId);
  groupIds.add(groupId);
  return new Set(
    hosts.flatMap((host) =>
      host.groupId && groupIds.has(host.groupId) ? [host.id] : [],
    ),
  );
}

export function batchSelectionState(
  hostIds: Set<string>,
  selectedHostIds: Set<string>,
): BatchSelectionState {
  if (hostIds.size === 0) return "none";
  const selectedCount = [...hostIds].filter((id) =>
    selectedHostIds.has(id),
  ).length;
  if (selectedCount === 0) return "none";
  return selectedCount === hostIds.size ? "all" : "partial";
}

export function hostsMovedToGroup(
  hosts: Host[],
  selectedHostIds: Set<string>,
  groupId?: string,
) {
  const selected = hosts.filter((host) => selectedHostIds.has(host.id));
  if (selected.length === 0) return [];
  const affectedGroups = new Map<string, string | undefined>();
  affectedGroups.set(groupId ?? "", groupId);
  selected.forEach((host) =>
    affectedGroups.set(host.groupId ?? "", host.groupId),
  );

  const updated = new Map<string, Host>();
  const updatedAt = now();
  for (const affectedGroupId of affectedGroups.values()) {
    const remaining = hosts
      .filter(
        (host) =>
          host.groupId === affectedGroupId &&
          !selectedHostIds.has(host.id),
      )
      .sort((left, right) => left.sortOrder - right.sortOrder);
    const ordered =
      affectedGroupId === groupId ? [...remaining, ...selected] : remaining;
    ordered.forEach((host, sortOrder) => {
      updated.set(host.id, {
        ...host,
        groupId: affectedGroupId,
        sortOrder,
        updatedAt,
      });
    });
  }
  return hosts.flatMap((host) => {
    const value = updated.get(host.id);
    return value ? [value] : [];
  });
}

function BatchSelectionIcon({ state }: { state: BatchSelectionState }) {
  if (state === "all") return <CheckSquare2 size={13} />;
  if (state === "partial") return <MinusSquare size={13} />;
  return <Square size={13} />;
}

function compareGroups(left: HostGroup, right: HostGroup) {
  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
}

function groupHostCount(
  groups: HostGroup[],
  hosts: Host[],
  groupId: string,
) {
  const ids = groupDescendantIds(groups, groupId);
  ids.add(groupId);
  return hosts.filter((host) => host.groupId && ids.has(host.groupId))
    .length;
}

function HostRow({
  host,
  selected,
  batchManaging,
  batchSelected,
  indented = false,
  onSelect,
  onConnect,
  onEdit,
  onContext,
  onDragStart,
  onDrop,
}: {
  host: Host;
  selected: boolean;
  batchManaging: boolean;
  batchSelected: boolean;
  indented?: boolean;
  onSelect: () => void;
  onConnect: () => void;
  onEdit: () => void;
  onContext: (x: number, y: number) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const t = useTranslation();
  return (
    <button
      className={`host-row ${
        !batchManaging && selected ? "is-selected" : ""
      } ${batchManaging ? "is-batch-managing" : ""} ${
        batchSelected ? "is-batch-selected" : ""
      } ${
        indented ? "is-indented" : ""
      }`}
      type="button"
      draggable={!batchManaging}
      onClick={onSelect}
      onDoubleClick={() => {
        if (!batchManaging) onConnect();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (batchManaging) onSelect();
        else onContext(event.clientX, event.clientY);
      }}
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      {batchManaging ? (
        <span className="host-batch-check">
          <BatchSelectionIcon state={batchSelected ? "all" : "none"} />
        </span>
      ) : null}
      <HostIcon host={host} />
      <span className="host-row-label">
        <strong>{host.label}</strong>
        <small>
          {host.username}@{host.hostname}
        </small>
      </span>
      <span className="host-row-tail">
        <span className="host-port">{host.port}</span>
        <span
          className="host-row-edit"
          role="button"
          tabIndex={0}
          title={t("Edit")}
          onClick={(event) => {
            event.stopPropagation();
            onEdit();
          }}
        >
          <Pencil size={12} />
        </span>
      </span>
    </button>
  );
}

function HostEditor({ host, onClose }: { host: Host; onClose: () => void }) {
  const t = useTranslation();
  const [draft, setDraft] = useState(host);
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const saveHost = useAppStore((state) => state.saveHost);
  const groups = useAppStore((state) => state.groups);
  const credentials = useAppStore((state) => state.credentials);
  const proxies = useAppStore((state) => state.proxies);
  const groupOptions = useMemo(
    () => flattenHostGroupTree(buildHostGroupTree(groups)),
    [groups],
  );
  const selectedCredential = credentials.find(
    (credential) => credential.id === draft.credentialId,
  );
  const proxyEnabled =
    draft.proxyProfileId != null || draft.proxyConfiguration != null;
  const selectedProxyProfile = proxies.find(
    (proxy) => proxy.id === draft.proxyProfileId,
  );
  const missingProxyProfileId =
    draft.proxyProfileId && !selectedProxyProfile
      ? draft.proxyProfileId
      : undefined;
  const proxyPasswordCredentials = credentials.filter(
    (credential) => credential.kind === "password",
  );
  const selectedProxyCredential = proxyPasswordCredentials.find(
    (credential) =>
      credential.id === draft.proxyConfiguration?.credentialId,
  );

  useLayoutEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, []);

  async function save() {
    const validationError = validateHostEditorDraft(draft);
    if (validationError) {
      setError(t(validationError));
      return;
    }
    if (isSaving) return;
    setIsSaving(true);
    setError(undefined);
    try {
      await saveHost(draft);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsSaving(false);
    }
  }

  function updateProxyConfiguration(
    update: (configuration: ProxyConfiguration) => ProxyConfiguration,
  ) {
    setDraft((current) => ({
      ...current,
      proxyProfileId: undefined,
      proxyConfiguration: update(
        current.proxyConfiguration ?? defaultProxyConfiguration(),
      ),
    }));
  }

  return (
    <div
      className="modal-backdrop host-editor-backdrop"
      role="presentation"
    >
      <section
        className="editor-sheet host-editor-sheet"
        role="dialog"
        aria-modal="true"
      >
        <header>
          <h2>{draft.label ? t("Edit Host") : t("New Host")}</h2>
          <button
            aria-label={t("Close")}
            className="host-editor-close"
            type="button"
            onClick={onClose}
          >
            <X size={12} />
          </button>
        </header>
        <div ref={bodyRef} className="editor-body host-editor-body">
          <section
            aria-label={t("Host Information")}
            className="host-editor-details"
          >
            <HostEditorCard>
              <HostEditorRow label="Name">
                <input
                  placeholder={t("My Server")}
                  value={draft.label}
                  onChange={(event) =>
                    setDraft({ ...draft, label: event.target.value })
                  }
                />
              </HostEditorRow>
              <HostEditorRow label="IP / Host">
                <input
                  placeholder={t("IP or Hostname")}
                  value={draft.hostname}
                  onChange={(event) =>
                    setDraft({ ...draft, hostname: event.target.value })
                  }
                />
              </HostEditorRow>
              <HostEditorRow label="Username">
                <div className="host-editor-user-port">
                  <input
                    placeholder="root"
                    value={draft.username}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        username: event.target.value,
                      })
                    }
                  />
                  <span>{t("Port")}</span>
                  <input
                    className="host-editor-port-input"
                    max={65535}
                    min={1}
                    type="number"
                    value={draft.port}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        port: Number(event.target.value),
                      })
                    }
                  />
                </div>
              </HostEditorRow>
              <HostEditorRow label="Credential">
                <select
                  value={draft.credentialId ?? ""}
                  onChange={(event) => {
                    const credential = credentials.find(
                      (item) => item.id === event.target.value,
                    );
                    setDraft({
                      ...draft,
                      credentialId: credential?.id,
                      username: credential?.username || draft.username,
                      authentication:
                        credential?.kind === "identityKey"
                          ? "identityFile"
                          : credential?.kind === "password"
                            ? "password"
                            : draft.authentication,
                    });
                  }}
                >
                  <option value="">{t("Custom Credential")}</option>
                  {credentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.label} [
                      {credential.kind === "password"
                        ? t("Password")
                        : t("Private Key")}
                      ]
                    </option>
                  ))}
                </select>
              </HostEditorRow>
              <HostEditorRow label="Group">
                <select
                  value={draft.groupId ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      groupId: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">{t("None")}</option>
                  {groupOptions.map(({ group, depth }) => (
                    <option key={group.id} value={group.id}>
                      {"  ".repeat(depth)}
                      {group.name}
                    </option>
                  ))}
                </select>
              </HostEditorRow>
              {selectedCredential ? (
                <HostEditorCaption>
                  <strong>{t("Using saved credential")}</strong>
                  <span>
                    {selectedCredential.username} -{" "}
                    {selectedCredential.kind === "password"
                      ? t("Password")
                      : t("Private Key")}
                  </span>
                </HostEditorCaption>
              ) : (
                <>
                  <HostEditorRow label="Authentication">
                    <div className="host-editor-auth-segmented">
                      {(
                        [
                          ["agent", "SSH Agent"],
                          ["password", "Password"],
                          ["identityFile", "Private Key"],
                        ] as const
                      ).map(([method, title]) => (
                        <button
                          className={
                            draft.authentication === method
                              ? "is-active"
                              : ""
                          }
                          key={method}
                          type="button"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              authentication: method,
                            })
                          }
                        >
                          {t(title)}
                        </button>
                      ))}
                    </div>
                  </HostEditorRow>
                  {draft.authentication === "password" ? (
                    <HostEditorRow label="Password">
                      <RevealableHostEditorInput
                        placeholder={
                          host.password
                            ? t("Leave blank to keep current")
                            : undefined
                        }
                        value={draft.password ?? ""}
                        onChange={(value) =>
                          setDraft({
                            ...draft,
                            password: value || undefined,
                          })
                        }
                      />
                    </HostEditorRow>
                  ) : null}
                  {draft.authentication === "identityFile" ? (
                    <>
                      <HostEditorRow label="Private Key">
                        <div className="host-editor-file-field">
                          <input
                            value={draft.identityFile ?? ""}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                identityFile:
                                  event.target.value || undefined,
                              })
                            }
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
                                if (typeof path === "string") {
                                  setDraft((current) => ({
                                    ...current,
                                    identityFile: path,
                                  }));
                                }
                              });
                            }}
                          >
                            {t("Choose...")}
                          </button>
                        </div>
                      </HostEditorRow>
                      <HostEditorCaption>
                        <span>
                          {t(
                            "Encrypted keys are unlocked by the native secure prompt.",
                          )}
                        </span>
                      </HostEditorCaption>
                    </>
                  ) : null}
                </>
              )}
            </HostEditorCard>
          </section>

          <details className="host-editor-advanced">
            <summary>{t("Advanced Settings")}</summary>
            <div className="host-editor-advanced-content">
              <HostEditorSection title="Colors & Icons">
                <HostAppearanceEditor host={draft} onChange={setDraft} />
              </HostEditorSection>

              <HostEditorSection title="SFTP">
                <HostEditorCard>
                  <HostEditorRow label="File Protocol">
                    <select
                      value={draft.sftpFileProtocol}
                      onChange={(event) => {
                        const protocol = event.target
                          .value as Host["sftpFileProtocol"];
                        setDraft({
                          ...draft,
                          sftpFileProtocol: protocol,
                          sftpUsesSudo:
                            protocol === "scp"
                              ? false
                              : draft.sftpUsesSudo,
                        });
                      }}
                    >
                      <option value="auto">{t("Auto")}</option>
                      <option value="sftp">SFTP</option>
                      <option value="scp">SCP</option>
                    </select>
                  </HostEditorRow>
                  <HostEditorRow label="Filename Encoding">
                    <select
                      value={draft.sftpFilenameEncoding}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          sftpFilenameEncoding: event.target
                            .value as Host["sftpFilenameEncoding"],
                        })
                      }
                    >
                      <option value="auto">{t("Auto")}</option>
                      <option value="utf-8">UTF-8</option>
                      <option value="gb18030">GB18030</option>
                    </select>
                  </HostEditorRow>
                  <HostEditorToggle
                    checked={draft.sftpFollowsTerminalCwd ?? false}
                    label="Follow terminal working directory"
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        sftpFollowsTerminalCwd: value,
                      })
                    }
                  />
                </HostEditorCard>
              </HostEditorSection>

              <HostEditorSection title="Server Tools">
                <HostEditorCard>
                  <HostEditorToggle
                    checked={draft.serverToolsUseRoot}
                    label="Automatically use root for server tools"
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        serverToolsUseRoot: value,
                      })
                    }
                  />
                  {draft.serverToolsUseRoot ? (
                    <HostEditorRow label="Privilege Escalation">
                      <div className="host-editor-segmented">
                        {(["sudo", "su"] as const).map((method) => (
                          <button
                            className={
                              draft.serverToolsElevationMethod === method
                                ? "is-active"
                                : ""
                            }
                            key={method}
                            type="button"
                            onClick={() =>
                              setDraft({
                                ...draft,
                                serverToolsElevationMethod: method,
                              })
                            }
                          >
                            {method}
                          </button>
                        ))}
                      </div>
                    </HostEditorRow>
                  ) : null}
                  <HostEditorCaption>
                    <span>
                      {t(
                        "Uses the selected sudo or su method for SFTP, System, and Docker.",
                      )}
                    </span>
                  </HostEditorCaption>
                </HostEditorCard>
              </HostEditorSection>

              <HostEditorSection title="Proxy">
                <HostEditorCard>
              <HostEditorToggle
                checked={proxyEnabled}
                label="Use Proxy"
                onChange={(value) =>
                  setDraft(
                    value
                      ? {
                          ...draft,
                          proxyProfileId: undefined,
                          proxyConfiguration:
                            draft.proxyConfiguration ??
                            defaultProxyConfiguration(),
                        }
                      : {
                          ...draft,
                          proxyProfileId: undefined,
                          proxyConfiguration: undefined,
                        },
                  )
                }
              />
              {proxyEnabled ? (
                <HostEditorRow label="Proxy">
                  <select
                    value={draft.proxyProfileId ?? ""}
                    onChange={(event) => {
                      const profileId =
                        event.target.value || undefined;
                      setDraft({
                        ...draft,
                        proxyProfileId: profileId,
                        proxyConfiguration: profileId
                          ? undefined
                          : draft.proxyConfiguration ??
                            defaultProxyConfiguration(),
                      });
                    }}
                  >
                    <option value="">{t("Custom Proxy")}</option>
                    {missingProxyProfileId ? (
                      <option value={missingProxyProfileId}>
                        {t("Missing saved proxy")}
                      </option>
                    ) : null}
                    {proxies.map((proxy) => (
                      <option key={proxy.id} value={proxy.id}>
                        {proxy.label}
                      </option>
                    ))}
                  </select>
                </HostEditorRow>
              ) : null}
                </HostEditorCard>
                {selectedProxyProfile ? (
                  <div className="host-editor-proxy-summary">
                <Network size={13} />
                <strong>
                  {proxyTypeTitle(
                    selectedProxyProfile.configuration.type,
                  )}
                </strong>
                <span>
                  {proxyEndpointSummary(
                    selectedProxyProfile.configuration,
                  )}
                </span>
                  </div>
                ) : null}
                {proxyEnabled && !selectedProxyProfile ? (
                  <HostEditorCard>
                <HostEditorRow label="Type">
                  <select
                    value={draft.proxyConfiguration?.type ?? "http"}
                    onChange={(event) =>
                      updateProxyConfiguration((configuration) => ({
                        ...configuration,
                        type: event.target
                          .value as ProxyConfiguration["type"],
                      }))
                    }
                  >
                    <option value="http">HTTP</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="command">ProxyCommand</option>
                  </select>
                </HostEditorRow>
                {draft.proxyConfiguration?.type === "command" ? (
                  <>
                    <HostEditorRow label="ProxyCommand">
                      <input
                        className="is-monospaced"
                        value={draft.proxyConfiguration.command ?? ""}
                        onChange={(event) =>
                          updateProxyConfiguration(
                            (configuration) => ({
                              ...configuration,
                              command:
                                event.target.value || undefined,
                            }),
                          )
                        }
                      />
                    </HostEditorRow>
                    <HostEditorCaption>
                      <span>
                        {t(
                          "Use %h for the target host, %p for the target port, and %% for a literal percent.",
                        )}
                      </span>
                    </HostEditorCaption>
                  </>
                ) : (
                  <>
                    <HostEditorRow label="Proxy Host">
                      <input
                        value={draft.proxyConfiguration?.host ?? ""}
                        onChange={(event) =>
                          updateProxyConfiguration(
                            (configuration) => ({
                              ...configuration,
                              host: event.target.value,
                            }),
                          )
                        }
                      />
                    </HostEditorRow>
                    <HostEditorRow label="Port">
                      <input
                        max={65535}
                        min={1}
                        type="number"
                        value={draft.proxyConfiguration?.port ?? 8080}
                        onChange={(event) =>
                          updateProxyConfiguration(
                            (configuration) => ({
                              ...configuration,
                              port: Number(event.target.value),
                            }),
                          )
                        }
                      />
                    </HostEditorRow>
                    <HostEditorRow label="Saved Credential">
                      <select
                        value={
                          draft.proxyConfiguration?.credentialId ?? ""
                        }
                        onChange={(event) => {
                          const credentialId =
                            event.target.value || undefined;
                          updateProxyConfiguration(
                            (configuration) => ({
                              ...configuration,
                              credentialId,
                              username: credentialId
                                ? undefined
                                : configuration.username,
                              password: credentialId
                                ? undefined
                                : configuration.password,
                            }),
                          );
                        }}
                      >
                        <option value="">
                          {t("Manual Credentials")}
                        </option>
                        {proxyPasswordCredentials.map((credential) => (
                          <option
                            key={credential.id}
                            value={credential.id}
                          >
                            {credential.label}
                          </option>
                        ))}
                      </select>
                    </HostEditorRow>
                    {selectedProxyCredential ? (
                      <HostEditorCaption>
                        <strong>
                          {selectedProxyCredential.label}
                        </strong>
                        <span>
                          {selectedProxyCredential.username}
                        </span>
                      </HostEditorCaption>
                    ) : (
                      <>
                        <HostEditorRow label="Username">
                          <input
                            value={
                              draft.proxyConfiguration?.username ?? ""
                            }
                            onChange={(event) =>
                              updateProxyConfiguration(
                                (configuration) => ({
                                  ...configuration,
                                  username:
                                    event.target.value || undefined,
                                }),
                              )
                            }
                          />
                        </HostEditorRow>
                        <HostEditorRow label="Password">
                          <RevealableHostEditorInput
                            value={
                              draft.proxyConfiguration?.password ?? ""
                            }
                            onChange={(value) =>
                              updateProxyConfiguration(
                                (configuration) => ({
                                  ...configuration,
                                  password: value || undefined,
                                }),
                              )
                            }
                          />
                        </HostEditorRow>
                      </>
                    )}
                  </>
                )}
                  </HostEditorCard>
                ) : null}
              </HostEditorSection>
            </div>
          </details>
          {error ? <p className="form-error">{error}</p> : null}
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            className="primary-button"
            disabled={isSaving}
            type="button"
            onClick={save}
          >
            {t("Save")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function HostEditorSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const t = useTranslation();
  return (
    <section className="host-editor-section">
      <h3>{t(title)}</h3>
      {children}
    </section>
  );
}

function HostEditorCard({ children }: { children: React.ReactNode }) {
  return <div className="host-editor-card">{children}</div>;
}

function HostEditorCaption({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="host-editor-caption">{children}</div>;
}

function HostEditorRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const t = useTranslation();
  return (
    <div className="host-editor-row">
      <strong>{t(label)}</strong>
      {children}
    </div>
  );
}

function RevealableHostEditorInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslation();
  const [isRevealed, setIsRevealed] = useState(false);
  return (
    <div className="host-editor-password-field">
      <input
        placeholder={placeholder}
        type={isRevealed ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        aria-label={t(isRevealed ? "Hide Password" : "Show Password")}
        title={t(isRevealed ? "Hide Password" : "Show Password")}
        type="button"
        onClick={() => setIsRevealed((current) => !current)}
      >
        {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );
}

function HostEditorToggle({
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
    <label className="host-editor-row host-editor-toggle">
      <strong>{t(label)}</strong>
      <input
        checked={checked}
        type="checkbox"
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function defaultProxyConfiguration(): ProxyConfiguration {
  return {
    type: "http",
    host: "",
    port: 8080,
  };
}

export function validateHostEditorDraft(host: Host) {
  const hostname = host.hostname.trim();
  if (!host.label.trim()) return "Host name is required.";
  if (
    !hostname ||
    hostname.startsWith("-") ||
    /\s/.test(hostname)
  ) {
    return "Enter a valid IP address or host name.";
  }
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) {
    return "Port must be between 1 and 65535.";
  }
  if (!host.username.trim()) return "Username is required.";
  if (
    host.authentication === "identityFile" &&
    !host.credentialId &&
    !host.identityFile?.trim() &&
    !host.identityKey?.trim()
  ) {
    return "Private key path is required.";
  }
  const proxy = host.proxyConfiguration;
  if (!proxy) return undefined;
  if (proxy.type === "command") {
    return proxy.command?.trim()
      ? undefined
      : "ProxyCommand is required.";
  }
  const proxyHost = proxy.host.trim();
  if (
    !proxyHost ||
    proxyHost.startsWith("-") ||
    /\s/.test(proxyHost)
  ) {
    return "Enter a valid proxy host.";
  }
  if (
    !Number.isInteger(proxy.port) ||
    proxy.port < 1 ||
    proxy.port > 65535
  ) {
    return "Proxy port must be between 1 and 65535.";
  }
  return undefined;
}

function proxyTypeTitle(type: ProxyConfiguration["type"]) {
  if (type === "command") return "ProxyCommand";
  return type === "socks5" ? "SOCKS5" : "HTTP";
}

function proxyEndpointSummary(configuration: ProxyConfiguration) {
  if (configuration.type === "command") {
    return configuration.command ?? "";
  }
  return `${configuration.host}:${configuration.port}`;
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

function HostAppearanceEditor({
  host,
  onChange,
}: {
  host: Host;
  onChange: (host: Host) => void;
}) {
  const t = useTranslation();
  const sourceMode =
    host.distroMode === "manual" || host.iconMode === "custom"
      ? "manual"
      : "auto";
  const iconSelection =
    host.iconMode === "custom"
      ? `type:${host.iconId ?? "server"}`
      : `brand:${host.manualDistro ?? effectiveDistro(host) ?? "linux"}`;
  const customColor = isValidHostColor(host.iconColorCustom);
  const colorSelection = customColor
    ? "custom"
    : `preset:${host.iconColor ?? "blue"}`;

  return (
    <div className="host-appearance-editor">
      <div className="host-appearance-preview">
        <HostIcon host={host} size={68} />
      </div>
      <div className="host-appearance-grid">
        <Field label="Source">
          <select
            value={sourceMode}
            onChange={(event) => {
              if (event.target.value === "auto") {
                onChange({
                  ...host,
                  distroMode: "auto",
                  iconMode: "auto",
                  iconId: undefined,
                });
              } else {
                onChange({
                  ...host,
                  distroMode: "manual",
                  manualDistro:
                    host.manualDistro ?? effectiveDistro(host) ?? "linux",
                });
              }
            }}
          >
            <option value="auto">{t("Auto Detect")}</option>
            <option value="manual">{t("Manual")}</option>
          </select>
        </Field>
        {sourceMode === "manual" ? (
          <Field label="Icon">
            <select
              value={iconSelection}
              onChange={(event) => {
                const [kind, value] = event.target.value.split(":", 2);
                if (kind === "type") {
                  onChange({
                    ...host,
                    distroMode: "manual",
                    iconMode: "custom",
                    iconId: value,
                  });
                } else {
                  onChange({
                    ...host,
                    distroMode: "manual",
                    manualDistro: value,
                    iconMode: "auto",
                    iconId: undefined,
                  });
                }
              }}
            >
              <optgroup label={t("Brand")}>
                {hostDistroIds.map((distro) => (
                  <option key={distro} value={`brand:${distro}`}>
                    {distroTitles[distro]}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("Type")}>
                {hostIconIds.map((icon) => (
                  <option key={icon} value={`type:${icon}`}>
                    {t(hostIconTitles[icon])}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
        ) : (
          <div className="host-appearance-value">
            <span>{t("Current Value")}</span>
            <strong>
              {effectiveDistro(host)
                ? distroTitle(effectiveDistro(host)!)
                : t("Detect after first connection")}
            </strong>
          </div>
        )}
      </div>
      <div className="host-appearance-divider" />
      <div className="host-appearance-grid">
        <Field label="Icon Color">
          <select
            value={host.iconColorMode}
            onChange={(event) => {
              if (event.target.value === "auto") {
                onChange({
                  ...host,
                  iconColorMode: "auto",
                  iconColor: undefined,
                  iconColorCustom: undefined,
                });
              } else {
                onChange({
                  ...host,
                  iconColorMode: "manual",
                  iconColor:
                    host.iconColor ??
                    (customColor ? undefined : "blue"),
                });
              }
            }}
          >
            <option value="auto">{t("Automatic")}</option>
            <option value="manual">{t("Manual")}</option>
          </select>
        </Field>
        {host.iconColorMode === "manual" ? (
          <Field label="Color">
            <select
              value={colorSelection}
              onChange={(event) => {
                if (event.target.value === "custom") {
                  onChange({
                    ...host,
                    iconColorMode: "manual",
                    iconColor: undefined,
                    iconColorCustom: customColor
                      ? host.iconColorCustom
                      : "#2563EB",
                  });
                } else {
                  onChange({
                    ...host,
                    iconColorMode: "manual",
                    iconColor: event.target.value.slice("preset:".length),
                    iconColorCustom: undefined,
                  });
                }
              }}
            >
              {hostColorIds.map((color) => (
                <option key={color} value={`preset:${color}`}>
                  {t(hostColorTitles[color])}
                </option>
              ))}
              <option value="custom">{t("Custom Color")}</option>
            </select>
          </Field>
        ) : (
          <div className="host-appearance-value">
            <span>{t("Current Color")}</span>
            <strong>
              <i style={{ background: effectiveHostColor(host) }} />
              {sourceMode === "manual"
                ? t(hostIconTitles[host.iconId ?? "server"])
                : effectiveDistro(host)
                  ? distroTitle(effectiveDistro(host)!)
                  : t("Unknown")}
            </strong>
          </div>
        )}
      </div>
      {host.iconColorMode === "manual" && colorSelection === "custom" ? (
        <Field label="Custom Color" wide>
          <div className="host-custom-color">
            <input
              type="color"
              value={
                isValidHostColor(host.iconColorCustom)
                  ? host.iconColorCustom
                  : "#2563EB"
              }
              onChange={(event) =>
                onChange({
                  ...host,
                  iconColorCustom: event.target.value.toUpperCase(),
                })
              }
            />
            <input
              value={host.iconColorCustom ?? ""}
              onChange={(event) =>
                onChange({
                  ...host,
                  iconColorCustom: event.target.value,
                })
              }
            />
          </div>
        </Field>
      ) : null}
    </div>
  );
}

export function HostIcon({
  host,
  size = 24,
}: {
  host: Host;
  size?: number;
}) {
  const distro = effectiveDistro(host);
  return (
    <span
      className="host-icon"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, size * 0.24),
        backgroundColor: effectiveHostColor(host),
      }}
    >
      {host.iconMode === "custom" ? (
        customHostIcon(host.iconId ?? "server", size * 0.5)
      ) : distro && hostDistroImages.has(distro) ? (
        <img
          alt=""
          src={`/distro/${distro}.svg`}
          style={{
            width: size * 0.52,
            height: size * 0.52,
            filter:
              distro === "h3c"
                ? undefined
                : "brightness(0) invert(1)",
          }}
        />
      ) : (
        <Server size={size * 0.5} />
      )}
    </span>
  );
}

function customHostIcon(icon: string, size: number) {
  const props = { size, strokeWidth: 2.2 };
  switch (icon) {
    case "terminal":
      return <TerminalSquare {...props} />;
    case "database":
      return <Database {...props} />;
    case "cloud":
      return <Cloud {...props} />;
    case "router":
      return <Router {...props} />;
    case "shield":
      return <Shield {...props} />;
    case "code":
      return <Code2 {...props} />;
    case "box":
      return <Box {...props} />;
    case "globe":
      return <Globe2 {...props} />;
    case "cpu":
      return <Cpu {...props} />;
    case "hard-drive":
      return <HardDrive {...props} />;
    case "network":
      return <Network {...props} />;
    case "wifi":
      return <Wifi {...props} />;
    case "lock":
      return <Lock {...props} />;
    case "key":
      return <KeyRound {...props} />;
    case "monitor":
      return <Monitor {...props} />;
    case "container":
      return <Container {...props} />;
    case "activity":
      return <Activity {...props} />;
    case "zap":
      return <Zap {...props} />;
    case "server-cog":
      return <ServerCog {...props} />;
    default:
      return <Server {...props} />;
  }
}

export function effectiveDistro(host: Host) {
  return host.distroMode === "manual"
    ? host.manualDistro ?? host.distro
    : host.distro;
}

export function effectiveHostColor(host: Host) {
  if (host.iconColorMode === "manual") {
    if (isValidHostColor(host.iconColorCustom)) {
      return host.iconColorCustom!;
    }
    return hostColorHex[host.iconColor ?? "blue"] ?? hostColorHex.blue;
  }
  if (host.iconMode === "custom") {
    return hostIconDefaultColors[host.iconId ?? "server"];
  }
  return distroColors[effectiveDistro(host) ?? ""] ?? hostColorHex.blue;
}

function isValidHostColor(value?: string) {
  return /^#[0-9a-fA-F]{6}$/.test(value ?? "");
}

function distroTitle(distro: string) {
  return distroTitles[distro as keyof typeof distroTitles] ?? distro;
}

const hostDistroIds = [
  "linux",
  "ubuntu",
  "debian",
  "centos",
  "rocky",
  "fedora",
  "arch",
  "alpine",
  "amazon",
  "opensuse",
  "redhat",
  "almalinux",
  "oracle",
  "kali",
  "alinux",
  "openeuler",
  "macos",
  "freebsd",
  "cisco",
  "juniper",
  "huawei",
  "h3c",
  "hpe",
  "mikrotik",
  "fortinet",
  "paloalto",
  "zyxel",
  "ruijie",
] as const;

const hostDistroImages = new Set<string>(
  hostDistroIds.filter((distro) => distro !== "ruijie"),
);

const distroTitles: Record<(typeof hostDistroIds)[number], string> = {
  linux: "Linux",
  ubuntu: "Ubuntu",
  debian: "Debian",
  centos: "CentOS",
  rocky: "Rocky Linux",
  fedora: "Fedora",
  arch: "Arch Linux",
  alpine: "Alpine",
  amazon: "Amazon Linux",
  opensuse: "openSUSE / SLES",
  redhat: "Red Hat / RHEL",
  almalinux: "AlmaLinux",
  oracle: "Oracle Linux",
  kali: "Kali Linux",
  alinux: "Alibaba Cloud Linux",
  openeuler: "openEuler",
  macos: "macOS",
  freebsd: "FreeBSD",
  cisco: "Cisco",
  juniper: "Juniper",
  huawei: "Huawei",
  h3c: "H3C",
  hpe: "HPE",
  mikrotik: "MikroTik",
  fortinet: "Fortinet",
  paloalto: "Palo Alto Networks",
  zyxel: "Zyxel",
  ruijie: "Ruijie",
};

const hostIconIds = [
  "server",
  "terminal",
  "database",
  "cloud",
  "router",
  "shield",
  "code",
  "box",
  "globe",
  "cpu",
  "hard-drive",
  "network",
  "wifi",
  "lock",
  "key",
  "monitor",
  "container",
  "activity",
  "zap",
  "server-cog",
] as const;

const hostIconTitles: Record<string, string> = {
  server: "Server",
  terminal: "Terminal",
  database: "Database",
  cloud: "Cloud",
  router: "Router",
  shield: "Security",
  code: "Code",
  box: "Node",
  globe: "Public network",
  cpu: "Compute",
  "hard-drive": "Storage",
  network: "Network",
  wifi: "Wi-Fi",
  lock: "Locked",
  key: "Key",
  monitor: "Monitor",
  container: "Container",
  activity: "Activity",
  zap: "High speed",
  "server-cog": "Server settings",
};

const hostColorIds = [
  "blue",
  "green",
  "red",
  "amber",
  "purple",
  "cyan",
  "orange",
  "slate",
  "violet",
  "pink",
  "rose",
  "lime",
  "teal",
  "sky",
  "indigo",
  "zinc",
] as const;

const hostColorTitles: Record<string, string> = {
  blue: "Blue",
  green: "Green",
  red: "Red",
  amber: "Amber",
  purple: "Purple",
  cyan: "Cyan",
  orange: "Orange",
  slate: "Slate",
  violet: "Violet",
  pink: "Pink",
  rose: "Rose",
  lime: "Lime",
  teal: "Teal",
  sky: "Sky",
  indigo: "Indigo",
  zinc: "Zinc",
};

const hostColorHex: Record<string, string> = {
  blue: "#2563EB",
  green: "#16A34A",
  red: "#DC2626",
  amber: "#B45309",
  purple: "#9333EA",
  cyan: "#0891B2",
  orange: "#EA580C",
  slate: "#475569",
  violet: "#7C3AED",
  pink: "#DB2777",
  rose: "#E11D48",
  lime: "#65A30D",
  teal: "#0D9488",
  sky: "#0284C7",
  indigo: "#4F46E5",
  zinc: "#52525B",
};

const distroColors: Record<string, string> = {
  ubuntu: "#E95420",
  debian: "#A81D33",
  centos: "#9C27B0",
  rocky: "#0B9B69",
  fedora: "#3C6EB4",
  arch: "#1793D1",
  alpine: "#0D597F",
  amazon: "#FF9900",
  opensuse: "#73BA25",
  redhat: "#EE0000",
  oracle: "#C74634",
  kali: "#0F6DB3",
  almalinux: "#173B66",
  alinux: "#FF6A00",
  openeuler: "#002FA7",
  macos: "#333333",
  linux: "#333333",
  freebsd: "#AB2B28",
  cisco: "#1BA0D7",
  juniper: "#0A6EB4",
  huawei: "#CF0A2C",
  h3c: "#FFFFFF",
  hpe: "#01A982",
  mikrotik: "#293239",
  fortinet: "#EE3124",
  paloalto: "#FA582D",
  zyxel: "#00497A",
  ruijie: "#E60012",
};

const hostIconDefaultColors: Record<string, string> = {
  server: hostColorHex.blue,
  terminal: hostColorHex.slate,
  database: hostColorHex.cyan,
  cloud: hostColorHex.sky,
  router: hostColorHex.orange,
  shield: hostColorHex.green,
  code: hostColorHex.violet,
  box: hostColorHex.amber,
  globe: hostColorHex.teal,
  cpu: hostColorHex.indigo,
  "hard-drive": hostColorHex.zinc,
  network: hostColorHex.lime,
  wifi: hostColorHex.purple,
  lock: hostColorHex.rose,
  key: hostColorHex.amber,
  monitor: hostColorHex.sky,
  container: hostColorHex.teal,
  activity: hostColorHex.red,
  zap: hostColorHex.orange,
  "server-cog": hostColorHex.slate,
};

export function hostLoginPassword(
  host: Host,
  credentials: Credential[],
) {
  if (host.credentialId) {
    const credential = credentials.find(
      (item) =>
        item.id === host.credentialId && item.kind === "password",
    );
    return credential?.password || undefined;
  }
  return host.authentication === "password"
    ? host.password || undefined
    : undefined;
}

export function normalizedScriptCommand(body: string) {
  const script = body.trim();
  return script ? `${script}\n` : undefined;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
}

function makeEmptyHost(): Host {
  const timestamp = now();
  return {
    id: id(),
    label: "",
    hostname: "",
    port: 22,
    username: "root",
    authentication: "password",
    sortOrder: 0,
    distroMode: "auto",
    iconMode: "auto",
    iconColorMode: "auto",
    sftpFileProtocol: "auto",
    sftpFilenameEncoding: "auto",
    sftpUsesSudo: false,
    sftpFollowsTerminalCwd: false,
    serverToolsUseRoot: false,
    serverToolsElevationMethod: "sudo",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
