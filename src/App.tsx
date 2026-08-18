import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { QuickConnectDialog } from "./components/QuickConnectDialog";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { Sidebar } from "./components/Sidebar";
import { SidebarToggleIcon } from "./components/SidebarToggleIcon";
import { WorkspaceArea } from "./components/WorkspaceArea";
import { useAppStore } from "./store";
import { useTranslation } from "./i18n";

export const swiftSidebarIdealWidth = 280;

export function initialSidebarWidth(stored: string | null) {
  if (stored === null || stored.trim() === "") {
    return swiftSidebarIdealWidth;
  }
  const value = Number(stored);
  if (!Number.isFinite(value) || value === 238) {
    return swiftSidebarIdealWidth;
  }
  return Math.min(380, Math.max(230, value));
}

export function App() {
  const [forwardHostKeyPrompt, setForwardHostKeyPrompt] = useState<{
    id: string;
    prompt: string;
  }>();
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    initialSidebarWidth(
      localStorage.getItem("termpilot:left-sidebar-width"),
    ),
  );
  const [sidebarVisible, setSidebarVisible] = useState(
    () =>
      localStorage.getItem("termpilot:left-sidebar-visible") !== "false",
  );
  const initialize = useAppStore((state) => state.initialize);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
  const setForwardStatus = useAppStore(
    (state) => state.setForwardStatus,
  );
  const t = useTranslation();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const listener = listen<{ id: string; prompt: string }>(
      "forward-host-key-prompt",
      ({ payload }) => setForwardHostKeyPrompt(payload),
    );
    return () => {
      void listener.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const listener = listen<{
      id: string;
      status: "inactive" | "connecting" | "active" | "error";
      error?: string;
    }>("forward-status", ({ payload }) => {
      setForwardStatus(payload.id, payload.status, payload.error);
    });
    return () => {
      void listener.then((unlisten) => unlisten());
    };
  }, [setForwardStatus]);

  function respondToForwardHostKey(accepted: boolean) {
    const prompt = forwardHostKeyPrompt;
    if (!prompt) return;
    setForwardHostKeyPrompt(undefined);
    void invoke("forward_host_key_response", {
      id: prompt.id,
      accepted,
    });
  }

  function startSidebarResize(event: React.PointerEvent) {
    if (!sidebarVisible) return;
    event.preventDefault();
    document.body.classList.add("is-resizing-sidebar");
    const move = (pointer: PointerEvent) => {
      const width = Math.min(380, Math.max(230, pointer.clientX));
      setSidebarWidth(width);
      localStorage.setItem(
        "termpilot:left-sidebar-width",
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

  function setSidebarVisibility(visible: boolean) {
    setSidebarVisible(visible);
    localStorage.setItem(
      "termpilot:left-sidebar-visible",
      String(visible),
    );
  }

  if (loading) {
    return (
      <main className="bootstrap-screen">
        <div className="bootstrap-mark">TP</div>
        <div>
          <strong>{t("Starting TermPilot")}</strong>
          <span>{t("Opening encrypted workspace")}</span>
        </div>
      </main>
    );
  }

    return (
    <main
      className={`app-shell ${
        sidebarVisible ? "" : "is-sidebar-collapsed"
      }`}
      style={{
        gridTemplateColumns: sidebarVisible
          ? `${sidebarWidth}px 5px minmax(0, 1fr)`
          : "0 0 minmax(0, 1fr)",
      }}
    >
      <Sidebar onCollapse={() => setSidebarVisibility(false)} />
      <div
        aria-label={t("Resize sidebar")}
        aria-orientation="vertical"
        className="app-sidebar-resizer"
        role="separator"
        onDoubleClick={() => {
          setSidebarWidth(swiftSidebarIdealWidth);
          localStorage.setItem(
            "termpilot:left-sidebar-width",
            String(swiftSidebarIdealWidth),
          );
        }}
        onPointerDown={startSidebarResize}
      />
      <div className="app-main">
        {!sidebarVisible ? (
          <button
            aria-label={t("Show Sidebar")}
            className="sidebar-restore-button"
            type="button"
            title={t("Show Sidebar")}
            onClick={() => setSidebarVisibility(true)}
          >
            <SidebarToggleIcon />
          </button>
        ) : null}
        {error ? <div className="global-error">{error}</div> : null}
        <WorkspaceArea />
        <QuickSwitcher />
        <QuickConnectDialog />
      </div>
    </main>
  );
}
