import { Search, Server, TerminalSquare, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";

import { sessionIds, useAppStore } from "../store";
import { useTranslation } from "../i18n";
import { openClonedWindow } from "../windowing";
import { openQuickConnect } from "./QuickConnectDialog";
import { disposeTerminalSurface } from "./TerminalSurface";

const QUICK_SWITCHER_EVENT = "termpilot:quick-switcher";

export function openQuickSwitcher() {
  window.dispatchEvent(new Event(QUICK_SWITCHER_EVENT));
}

export function QuickSwitcher() {
  const t = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const hosts = useAppStore((state) => state.hosts);
  const workspace = useAppStore((state) => state.workspace);
  const openHost = useAppStore((state) => state.openHostSession);
  const openLocal = useAppStore((state) => state.openLocalSession);
  const selectWorkspace = useAppStore((state) => state.selectWorkspace);
  const closeWorkspace = useAppStore((state) => state.closeWorkspace);
  const setNavigation = useAppStore((state) => state.setNavigation);
  const finishConnectionHistory = useAppStore(
    (state) => state.finishConnectionHistory,
  );

  const results = useMemo(() => {
    const value = query.trim().toLowerCase();
    const workspaces = workspace.workspaces
      .filter((item) => item.title.toLowerCase().includes(value))
      .map((item) => ({
        id: `workspace:${item.id}`,
        label: item.title,
        detail: t("Workspace"),
        icon: <TerminalSquare size={14} />,
        run: () => selectWorkspace(item.id),
      }));
    const hostResults = hosts
      .filter((host) =>
        [host.label, host.hostname, host.username].some((item) =>
          item.toLowerCase().includes(value),
        ),
      )
      .map((host) => ({
        id: `host:${host.id}`,
        label: host.label,
        detail: `${host.username}@${host.hostname}`,
        icon: <Server size={14} />,
        run: () => openHost(host),
      }));
    return [...workspaces, ...hostResults].slice(0, 12);
  }, [hosts, openHost, query, selectWorkspace, t, workspace.workspaces]);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(QUICK_SWITCHER_EVENT, show);
    return () => window.removeEventListener(QUICK_SWITCHER_EVENT, show);
  }, []);

  useEffect(() => {
    const closeActiveWorkspace = () => {
      const active = workspace.activeWorkspaceId;
      if (!active) return;
      const document = workspace.workspaces.find((item) => item.id === active);
      if (document) {
        for (const sessionId of sessionIds(document.root)) {
          finishConnectionHistory(sessionId, "closed");
          disposeTerminalSurface(sessionId);
          void invoke("terminal_terminate", { sessionId });
        }
      }
      closeWorkspace(active);
    };
    const runAction = (action: string) => {
      switch (action) {
        case "new-window":
          void openClonedWindow();
          break;
        case "new-local":
          openLocal();
          break;
        case "quick-connect":
          setOpen(false);
          openQuickConnect();
          break;
        case "settings":
          setNavigation("settings");
          break;
        case "about":
          setNavigation("about");
          break;
        case "split-vertical":
          openLocal("vertical");
          break;
        case "split-horizontal":
          openLocal("horizontal");
          break;
        case "close-workspace":
          closeActiveWorkspace();
          break;
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        runAction("new-window");
      } else if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        runAction("quick-connect");
      } else if (modifier && event.key.toLowerCase() === "t") {
        event.preventDefault();
        runAction("new-local");
      } else if (
        modifier &&
        event.shiftKey &&
        event.key.toLowerCase() === "d"
      ) {
        event.preventDefault();
        runAction("split-vertical");
      } else if (modifier && event.key.toLowerCase() === "d") {
        event.preventDefault();
        runAction("split-horizontal");
      } else if (modifier && event.key === ",") {
        event.preventDefault();
        runAction("settings");
      } else if (modifier && event.key.toLowerCase() === "w") {
        event.preventDefault();
        runAction("close-workspace");
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    const menuListener = listen<string>("app-menu", ({ payload }) =>
      runAction(payload),
    );
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      void menuListener.then((unlisten) => unlisten());
    };
  }, [
    closeWorkspace,
    finishConnectionHistory,
    openLocal,
    setNavigation,
    workspace.activeWorkspaceId,
    workspace.workspaces,
  ]);

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="quick-switcher-backdrop" onMouseDown={() => setOpen(false)}>
      <section
        className="quick-switcher"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <Search size={15} />
          <input
            ref={inputRef}
            placeholder={t("Search workspaces and hosts")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && results[0]) {
                results[0].run();
                setOpen(false);
              }
            }}
          />
          <button type="button" onClick={() => setOpen(false)}>
            <X size={14} />
          </button>
        </header>
        <div className="quick-results">
          {results.map((result, index) => (
            <button
              className={index === 0 ? "is-primary" : ""}
              key={result.id}
              type="button"
              onClick={() => {
                result.run();
                setOpen(false);
              }}
            >
              <span>{result.icon}</span>
              <strong>{result.label}</strong>
              <small>{result.detail}</small>
            </button>
          ))}
          {results.length === 0 ? <p>{t("No results")}</p> : null}
        </div>
        <footer>
          <span>{t("Enter open")}</span>
          <span>{t("Esc close")}</span>
          <span>⌘T local shell</span>
          <span>⌘\\ split</span>
        </footer>
      </section>
    </div>
  );
}
