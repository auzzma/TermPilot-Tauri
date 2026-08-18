import {
  Activity,
  Bolt,
  Box,
  Cpu,
  HardDrive,
  MemoryStick,
  Pause,
  Pencil,
  Play,
  RotateCw,
  ScrollText,
  Square,
  Tag,
  TerminalSquare,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "../i18n";
import {
  passwordPromptCommandKind,
  passwordPromptQuickFill,
} from "../passwordPromptAssist";
import type {
  DockerContainer,
  Host,
  SessionDescriptor,
  SystemOverview,
} from "../types";
import { useAppStore } from "../store";
import { HostIcon } from "./Sidebar";

interface DockerDialog {
  type: "input" | "confirm";
  title: string;
  message?: string;
  label?: string;
  value?: string;
  submit: (value?: string) => void | Promise<void>;
}

interface OverviewSample {
  timestamp: number;
  cpuTotal: number;
  cpuIdle: number;
  cpuUser: number;
  cpuSystem: number;
  networkRx: number;
  networkTx: number;
  interfaces: Record<string, { rx: number; tx: number }>;
}

interface CpuUsageSample {
  timestamp: number;
  value: number;
}

interface DockerInspectDetails {
  fields: Array<{
    label: string;
    value: string;
    monospaced?: boolean;
  }>;
  lists: Array<{
    label: string;
    values: string[];
  }>;
  rawJSON: string;
}

interface DockerInspectState {
  key: string;
  kind: "container" | "image";
  details?: DockerInspectDetails;
}

export interface SystemProcessRow {
  pid: number;
  ppid: number;
  user: string;
  stat: string;
  cpuPercent: number;
  memPercent: number;
  rssKB: number;
  vszKB: number;
  elapsed: string;
  command: string;
}

type DockerContainerAction =
  | "start"
  | "stop"
  | "restart"
  | "pause"
  | "unpause"
  | "kill"
  | "remove";

export function SystemPanel({
  host,
  session,
}: {
  host?: Host;
  session: SessionDescriptor;
}) {
  const t = useTranslation();
  const [tab, setTab] = useState<"overview" | "processes" | "docker">(
    "overview",
  );
  const [overview, setOverview] = useState<SystemOverview>();
  const [overviewSamples, setOverviewSamples] = useState<CpuUsageSample[]>(
    [],
  );
  const [processes, setProcesses] = useState<SystemProcessRow[]>([]);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [inspect, setInspect] = useState<DockerInspectState>();
  const [inspectLoading, setInspectLoading] = useState(false);
  const [dialog, setDialog] = useState<DockerDialog>();
  const overviewSampleRef = useRef<OverviewSample>();
  const overviewRefreshInFlightRef = useRef(false);
  const overviewGenerationRef = useRef(0);
  const inspectRequestRef = useRef(0);
  const openSiblingTab = useAppStore((state) => state.openSiblingTab);
  const preferences = useAppStore((state) => state.preferences);
  const platform = useAppStore((state) => state.platform);
  const usesWindowsCommands = shouldUseWindowsSystemCommands(
    platform,
    Boolean(host),
  );

  useEffect(() => {
    overviewGenerationRef.current += 1;
    overviewSampleRef.current = undefined;
    overviewRefreshInFlightRef.current = false;
    setOverview(undefined);
    setOverviewSamples([]);
    void refresh();
    const interval =
      tab === "overview"
        ? preferences.overviewRefreshInterval
        : tab === "processes"
          ? preferences.processesRefreshInterval
          : preferences.dockerRefreshInterval;
    const timer = window.setInterval(() => {
      if (tab === "overview") {
        void refreshOverview(false).catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        );
      } else if (tab === "processes") {
        void refreshProcesses(false);
      } else {
        void refreshDocker(false);
      }
    }, Math.min(10, Math.max(1, interval)) * 1_000);
    return () => window.clearInterval(timer);
  }, [
    host?.id,
    platform,
    preferences.dockerRefreshInterval,
    preferences.overviewRefreshInterval,
    preferences.processesRefreshInterval,
    session.id,
    tab,
  ]);

  async function execute(command: string) {
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
            command,
            timeoutMS: 20_000,
            elevated: host.serverToolsUseRoot,
          },
        })
      : await invoke<{
          stdout: string;
          stderr: string;
          code?: number;
        }>("local_exec", {
          command,
          shell: session.shell,
          workingDirectory: session.workingDirectory,
          timeoutMs: 20_000,
        });
    if (result.code && result.code !== 0) {
      throw new Error(result.stderr || `Command exited with ${result.code}`);
    }
    return result.stdout;
  }

  async function refresh() {
    setLoading(true);
    setError(undefined);
    try {
      if (tab === "overview") {
        await refreshOverview(false);
      } else if (tab === "processes") {
        await refreshProcesses(false);
      } else {
        await refreshDocker(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  async function refreshOverview(showsLoading: boolean) {
    if (overviewRefreshInFlightRef.current) return;
    const generation = overviewGenerationRef.current;
    overviewRefreshInFlightRef.current = true;
    if (showsLoading) setLoading(true);
    try {
      const output = await execute(
        usesWindowsCommands
          ? windowsSystemOverviewCommand
          : systemOverviewCommand,
      );
      if (generation !== overviewGenerationRef.current) return;
      const parsed = parseOverview(
        output,
        overviewSampleRef.current,
        Date.now(),
      );
      overviewSampleRef.current = parsed.sample;
      setOverview(parsed.overview);
      setOverviewSamples((samples) =>
        [
          ...samples,
          {
            timestamp: parsed.sample.timestamp,
            value: parsed.overview.cpuUsage,
          },
        ].slice(-24),
      );
    } finally {
      if (generation === overviewGenerationRef.current) {
        overviewRefreshInFlightRef.current = false;
      }
      if (showsLoading) setLoading(false);
    }
  }

  async function refreshProcesses(showsLoading: boolean) {
    if (showsLoading) setLoading(true);
    try {
      const output = await execute(
        usesWindowsCommands ? windowsProcessCommand : processCommand,
      );
      setProcesses(parseProcesses(output));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (showsLoading) setLoading(false);
    }
  }

  async function refreshDocker(showsLoading: boolean) {
    if (showsLoading) setLoading(true);
    try {
      const output = await execute(
        usesWindowsCommands
          ? `Write-Output '__CONTAINERS__'; docker ps -a --no-trunc --format '${dockerFormat}'; Write-Output '__IMAGES__'; docker images --no-trunc --format '${dockerImageFormat}'`
          : `printf '__CONTAINERS__\\n'; docker ps -a --no-trunc --format '${dockerFormat}'; printf '__IMAGES__\\n'; docker images --no-trunc --format '${dockerImageFormat}'`,
      );
      const parsed = parseDocker(output);
      setContainers(parsed.containers);
      setImages(parsed.images);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (showsLoading) setLoading(false);
    }
  }

  async function signalProcess(
    pid: number,
    signal: "STOP" | "CONT" | "TERM" | "KILL",
  ) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    try {
      const command =
        usesWindowsCommands
          ? signal === "CONT"
            ? `Resume-Process -Id ${pid}`
            : signal === "STOP"
              ? `Suspend-Process -Id ${pid}`
              : `Stop-Process -Id ${pid}${signal === "KILL" ? " -Force" : ""}`
          : `kill -s ${signal} ${pid}`;
      await execute(command);
      await refreshProcesses(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function runDockerCommand(command: string) {
    setLoading(true);
    setError(undefined);
    try {
      await execute(command);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  async function dockerAction(
    action: DockerContainerAction,
    id: string,
  ) {
    const safeId = sanitizeDockerId(id);
    if (!safeId) {
      setError("Invalid Docker container ID.");
      return;
    }
    const command =
      action === "remove"
        ? `docker rm -f ${safeId}`
        : `docker ${action} ${safeId}`;
    await runDockerCommand(command);
  }

  async function renameDocker(id: string, value: string) {
    const safeId = sanitizeDockerId(id);
    const name = sanitizeContainerName(value);
    if (!safeId || !name) {
      setError("Invalid Docker container name.");
      return;
    }
    await runDockerCommand(
      `docker rename ${safeId} ${shellQuote(name)}`,
    );
  }

  async function tagDocker(id: string, target: string) {
    const safeId = sanitizeDockerId(id);
    const reference = sanitizeImageReference(target);
    if (!safeId || !reference) {
      setError("Invalid Docker image tag.");
      return;
    }
    await runDockerCommand(
      `docker tag ${safeId} ${shellQuote(reference)}`,
    );
  }

  async function removeDockerImage(image: DockerImage) {
    const safeId = sanitizeDockerId(image.id);
    if (!safeId) {
      setError("Invalid Docker image ID.");
      return;
    }
    const force =
      image.repository === "<none>" || image.tag === "<none>";
    await runDockerCommand(
      `docker rmi${force ? " -f" : ""} ${safeId}`,
    );
  }

  async function inspectDocker(
    kind: "container" | "image",
    id: string,
    selectionId = id,
  ) {
    const safeId = sanitizeDockerId(id);
    if (!safeId) {
      setError("Invalid Docker ID.");
      return;
    }
    const key = dockerInspectKey(kind, selectionId);
    if (!nextDockerInspectKey(inspect?.key, key)) {
      closeDockerInspect();
      return;
    }
    const requestId = ++inspectRequestRef.current;
    setInspect({ key, kind });
    setInspectLoading(true);
    try {
      const output = await execute(
        kind === "container"
          ? `docker inspect ${safeId}`
          : `docker image inspect ${safeId}`,
      );
      if (inspectRequestRef.current !== requestId) return;
      setInspect({
        key,
        kind,
        details: parseDockerInspect(output, kind),
      });
    } catch (reason) {
      if (inspectRequestRef.current !== requestId) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (inspectRequestRef.current === requestId) {
        setInspectLoading(false);
      }
    }
  }

  function closeDockerInspect() {
    inspectRequestRef.current += 1;
    setInspect(undefined);
    setInspectLoading(false);
  }

  function openDockerTerminal(
    title: string,
    mode: "shell" | "logs",
    id: string,
  ) {
    const command = dockerInteractiveCommand(id, mode, host, platform);
    if (!command) {
      setError("Invalid Docker container ID.");
      return;
    }
    openSiblingTab(
      session.id,
      title,
      `${command}\r`,
      passwordPromptCommandKind(command)
        ? passwordPromptQuickFill(host)
        : undefined,
    );
  }

  function confirmAction(
    title: string,
    message: string,
    action: () => Promise<void>,
  ) {
    setDialog({
      type: "confirm",
      title,
      message,
      submit: async () => {
        setDialog(undefined);
        await action();
      },
    });
  }

  return (
    <div className="system-panel">
      <div className="system-panel-header">
        <div className="system-tabs">
          <button
            className={tab === "overview" ? "is-active" : ""}
            type="button"
            onClick={() => setTab("overview")}
          >
            {t("Overview")}
          </button>
          <button
            className={tab === "processes" ? "is-active" : ""}
            type="button"
            onClick={() => setTab("processes")}
          >
            {t("Processes")}
          </button>
          <button
            className={tab === "docker" ? "is-active" : ""}
            type="button"
            onClick={() => setTab("docker")}
          >
            {t("Docker")}
          </button>
        </div>
      </div>
      {error ? <div className="system-error">{error}</div> : null}
      {tab === "overview" ? (
        <OverviewContent
          host={host}
          overview={overview}
          samples={overviewSamples}
        />
      ) : tab === "processes" ? (
        <ProcessesContent
          processes={processes}
          onSignal={signalProcess}
        />
      ) : (
        <DockerContent
          containers={containers}
          images={images}
          inspect={inspect}
          inspectLoading={inspectLoading}
          onAction={dockerAction}
          onRename={renameDocker}
          onTag={tagDocker}
          onRemoveImage={removeDockerImage}
          onPrune={(all) =>
            runDockerCommand(
              `docker image prune${all ? " -a" : ""} -f`,
            )
          }
          onInspect={inspectDocker}
          onCloseInspect={closeDockerInspect}
          onTerminal={openDockerTerminal}
          onDialog={setDialog}
          onConfirm={confirmAction}
        />
      )}
      {loading ? (
        <div className="system-loading-overlay">
          <span className="system-loading-indicator">
            <RotateCw className="is-spinning" size={16} />
          </span>
        </div>
      ) : null}
      {dialog ? (
        <DockerDialogView
          dialog={dialog}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  );
}

function OverviewContent({
  host,
  overview,
  samples,
}: {
  host?: Host;
  overview?: SystemOverview;
  samples: CpuUsageSample[];
}) {
  const t = useTranslation();
  if (!overview) {
    return (
      <div className="panel-loading">
        {t("Collecting server metrics…")}
      </div>
    );
  }
  const memoryPercent =
    overview.memoryTotal > 0
      ? Math.round((overview.memoryUsed / overview.memoryTotal) * 100)
      : 0;
  const primaryDisk =
    overview.disks.find((disk) => disk.mount === "/") ??
    overview.disks[0];
  const networkRate =
    overview.networkRxPerSecond + overview.networkTxPerSecond;
  return (
    <div className="overview-content">
      <div className="server-identity">
        {host ? (
          <HostIcon host={host} size={42} />
        ) : (
          <span className="server-identity-fallback">
            <TerminalSquare size={21} />
          </span>
        )}
        <div className="server-identity-main">
          <div className="server-identity-title">
            <strong>{host?.label ?? overview.hostname}</strong>
            <span className="host-address-badge">
              {host?.hostname ?? overview.hostname}
            </span>
          </div>
          <div className="server-identity-meta">
            <span className="host-user-badge">
              {host?.username ?? "local"}
            </span>
            <span>•</span>
            <code>{overview.os} {overview.kernel}</code>
          </div>
        </div>
        <div className="server-uptime">
          <small>{t("Uptime")}</small>
          <strong>{formatUptime(overview.uptime, t)}</strong>
        </div>
      </div>
      <div className="overview-metric-grid">
        <MetricCard
          accent="cyan"
          icon={<Cpu size={17} />}
          label="CPU"
          accessory={
            overview.cpuCoreCount > 0
              ? `${overview.cpuCoreCount} ${t("cores")}`
              : undefined
          }
          value={`${Math.round(overview.cpuUsage)}%`}
          progress={overview.cpuUsage}
          footerLeading={`${t("User:")} ${overview.cpuUserUsage.toFixed(1)}%`}
          footerTrailing={`${t("Sys:")} ${overview.cpuSystemUsage.toFixed(1)}%`}
        />
        <MetricCard
          accent="purple"
          icon={<MemoryStick size={17} />}
          label="Memory"
          value={`${memoryPercent}%`}
          progress={memoryPercent}
          footerLeading={formatGigabytes(overview.memoryUsed)}
          footerTrailing={formatGigabytes(overview.memoryTotal)}
        />
        <MetricCard
          accent="orange"
          icon={<HardDrive size={17} />}
          label="Disk"
          value={`${Math.round(primaryDisk?.percent ?? 0)}%`}
          progress={primaryDisk?.percent ?? 0}
          footerLeading={formatGigabytes(primaryDisk?.used ?? 0)}
          footerTrailing={formatGigabytes(primaryDisk?.total ?? 0)}
        />
        <MetricCard
          accent="green"
          icon={<Wifi size={17} />}
          label="Network"
          value={`${formatBytes(networkRate)}/s`}
          progress={Math.min(
            Math.log10(Math.max(networkRate, 0) + 1) * 14,
            100,
          )}
          footerLeading={`↓ ${formatBytes(
            overview.networkRxPerSecond,
          )}/s`}
          footerTrailing={`↑ ${formatBytes(
            overview.networkTxPerSecond,
          )}/s`}
        />
      </div>
      <CpuTrend samples={samples} />
      <div className="overview-section-title is-orange">
        <HardDrive size={14} />
        {t("Disk partitions")}
      </div>
      <div className="overview-detail-card">
        {overview.disks.map((disk) => (
          <div className="overview-disk-row" key={disk.mount}>
            <div>
              <span>{disk.mount}</span>
              <strong>
                {formatGigabytes(disk.used)} /{" "}
                {formatGigabytes(disk.total)}
              </strong>
            </div>
            <ProgressBar accent="orange" value={disk.percent} />
          </div>
        ))}
        {overview.disks.length === 0 ? <span>{t("No data")}</span> : null}
      </div>
      <div className="overview-section-title is-green">
        <Wifi size={14} />
        {t("Network interfaces")}
      </div>
      <div className="overview-network-list">
        {overview.networkInterfaces.map((item) => (
          <div className="overview-detail-card overview-network-row" key={item.name}>
            <strong>{item.name}</strong>
            <span className="is-download">
              ↓ {formatBytes(item.rxPerSecond)}/s
            </span>
            <span className="is-upload">
              ↑ {formatBytes(item.txPerSecond)}/s
            </span>
          </div>
        ))}
        {overview.networkInterfaces.length === 0 ? (
          <div className="overview-detail-card">{t("No data")}</div>
        ) : null}
      </div>
      <div className="overview-info-grid">
        <span>{t("Load")}: {overview.loadAverage}</span>
        <span>{t("System")}: {overview.os}</span>
        <span>{t("Kernel")}: {overview.kernel}</span>
        <span>{t("Swap")}: {overview.swap || "--"}</span>
      </div>
      {overview.topMemoryProcesses.length > 0 ? (
        <>
          <div className="overview-section-title is-red">
            <MemoryStick size={14} />
            {t("Top memory processes")}
          </div>
          <div className="overview-detail-card">
            {overview.topMemoryProcesses.map((process) => (
              <div className="overview-process-row" key={process.pid}>
                <div>
                  <strong>{process.command}</strong>
                  <span>PID {process.pid}</span>
                </div>
                <div className="overview-resource-row">
                  <span>MEM</span>
                  <ProgressBar
                    accent="red"
                    value={process.memoryPercent}
                  />
                  <strong>{process.memoryPercent.toFixed(1)}%</strong>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function CpuTrend({ samples }: { samples: CpuUsageSample[] }) {
  const t = useTranslation();
  const points = samples
    .map((sample, index) => {
      const x =
        samples.length > 1 ? (index / (samples.length - 1)) * 100 : 0;
      const y = 100 - Math.min(100, Math.max(0, sample.value));
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <div className="overview-detail-card cpu-trend-card">
      <div className="cpu-trend-title">
        <Activity size={14} />
        <span>{t("CPU Load Trend")}</span>
      </div>
      <svg
        className="cpu-trend-chart"
        aria-label={t("CPU Load Trend")}
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 100 100"
      >
        {[0, 33.333, 66.667, 100].map((y) => (
          <line key={y} x1="0" x2="100" y1={y} y2={y} />
        ))}
        {samples.length > 1 ? <polyline points={points} /> : null}
      </svg>
      <div className="cpu-trend-times">
        <span>{formatSampleTime(samples[0]?.timestamp)}</span>
        <span>{formatSampleTime(samples.at(-1)?.timestamp)}</span>
      </div>
    </div>
  );
}

function ProgressBar({
  accent,
  value,
}: {
  accent: "cyan" | "purple" | "orange" | "green" | "red";
  value: number;
}) {
  const width = Math.min(100, Math.max(0, value));
  return (
    <span className={`overview-progress is-${accent}`}>
      <span style={{ width: `${Math.max(width > 0 ? 2 : 0, width)}%` }} />
    </span>
  );
}

function ProcessesContent({
  processes,
  onSignal,
}: {
  processes: SystemProcessRow[];
  onSignal: (
    pid: number,
    signal: "STOP" | "CONT" | "TERM" | "KILL",
  ) => Promise<void>;
}) {
  const t = useTranslation();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "running">("all");
  const [sort, setSort] = useState<
    "cpu" | "memory" | "command" | "user"
  >("cpu");
  const [ascending, setAscending] = useState(false);
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return processes
      .filter((process) => {
        if (
          filter === "running" &&
          !process.stat.toUpperCase().includes("R")
        ) {
          return false;
        }
        return (
          !value ||
          process.command.toLowerCase().includes(value) ||
          process.user.toLowerCase().includes(value) ||
          String(process.pid).includes(value)
        );
      })
      .sort((left, right) => {
        const direction = ascending ? 1 : -1;
        if (sort === "cpu") {
          return (left.cpuPercent - right.cpuPercent) * direction;
        }
        if (sort === "memory") {
          return (left.memPercent - right.memPercent) * direction;
        }
        const leftValue = sort === "command" ? left.command : left.user;
        const rightValue = sort === "command" ? right.command : right.user;
        return (
          leftValue.localeCompare(rightValue, undefined, {
            sensitivity: "base",
          }) * direction
        );
      });
  }, [ascending, filter, processes, query, sort]);

  function selectSort(
    value: "cpu" | "memory" | "command" | "user",
  ) {
    if (sort === value) {
      setAscending((current) => !current);
    } else {
      setSort(value);
      setAscending(value === "command" || value === "user");
    }
  }

  return (
    <div className="process-panel">
      <div className="process-toolbar">
        <input
          placeholder={t("Search processes...")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div>
          <button
            className={filter === "all" ? "is-active" : ""}
            type="button"
            onClick={() => setFilter("all")}
          >
            {t("All")}
          </button>
          <button
            className={filter === "running" ? "is-active" : ""}
            type="button"
            onClick={() => setFilter("running")}
          >
            {t("Running")}
          </button>
        </div>
      </div>
      <div className="process-sort">
        {(["cpu", "memory", "command", "user"] as const).map((key) => (
          <button
            className={sort === key ? "is-active" : ""}
            key={key}
            type="button"
            onClick={() => selectSort(key)}
          >
            {key === "memory" ? "MEM" : key.toUpperCase()}
            {sort === key ? (ascending ? " ↑" : " ↓") : ""}
          </button>
        ))}
        <span>{filtered.length} processes</span>
      </div>
      <div className="process-list">
        {filtered.map((process) => (
          <article key={process.pid}>
            <div>
              <strong>{process.command}</strong>
              <span>
                {process.user} · PID {process.pid} · CPU{" "}
                {process.cpuPercent.toFixed(1)}% · MEM{" "}
                {process.memPercent.toFixed(1)}%
              </span>
              <small>
                PPID {process.ppid} · {process.stat} · RSS{" "}
                {formatBytes(process.rssKB * 1024)} · {process.elapsed}
              </small>
            </div>
            <div>
              <button
                type="button"
                onClick={() => void onSignal(process.pid, "STOP")}
              >
                {t("Sleep")}
              </button>
              <button
                type="button"
                onClick={() => void onSignal(process.pid, "CONT")}
              >
                {t("Resume")}
              </button>
              <button
                type="button"
                onClick={() => void onSignal(process.pid, "TERM")}
              >
                {t("Term")}
              </button>
              <button
                className="danger"
                type="button"
                onClick={() => void onSignal(process.pid, "KILL")}
              >
                {t("Kill")}
              </button>
            </div>
          </article>
        ))}
        {filtered.length === 0 ? (
          <div className="panel-empty">{t("No matching processes.")}</div>
        ) : null}
      </div>
    </div>
  );
}

function MetricCard({
  accent,
  icon,
  label,
  accessory,
  value,
  progress,
  footerLeading,
  footerTrailing,
}: {
  accent: "cyan" | "purple" | "orange" | "green";
  icon: React.ReactNode;
  label: string;
  accessory?: string;
  value: string;
  progress: number;
  footerLeading: string;
  footerTrailing: string;
}) {
  const t = useTranslation();
  return (
    <div className={`metric-card is-${accent}`}>
      <div className="metric-card-header">
        <span className="metric-icon">{icon}</span>
        <span className="metric-label">{t(label)}</span>
        {accessory ? (
          <span className="metric-accessory">{accessory}</span>
        ) : null}
        <strong>{value}</strong>
      </div>
      <ProgressBar accent={accent} value={progress} />
      <div className="metric-card-footer">
        <span>{footerLeading}</span>
        <span>{footerTrailing}</span>
      </div>
    </div>
  );
}

function DockerContent({
  containers,
  images,
  inspect,
  inspectLoading,
  onAction,
  onRename,
  onTag,
  onRemoveImage,
  onPrune,
  onInspect,
  onCloseInspect,
  onTerminal,
  onDialog,
  onConfirm,
}: {
  containers: DockerContainer[];
  images: DockerImage[];
  inspect?: DockerInspectState;
  inspectLoading: boolean;
  onAction: (
    action: DockerContainerAction,
    id: string,
  ) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onTag: (id: string, target: string) => Promise<void>;
  onRemoveImage: (image: DockerImage) => Promise<void>;
  onPrune: (all: boolean) => Promise<void>;
  onInspect: (
    kind: "container" | "image",
    id: string,
    selectionId?: string,
  ) => Promise<void>;
  onCloseInspect: () => void;
  onTerminal: (
    title: string,
    mode: "shell" | "logs",
    id: string,
  ) => void;
  onDialog: (dialog: DockerDialog) => void;
  onConfirm: (
    title: string,
    message: string,
    action: () => Promise<void>,
  ) => void;
}) {
  const t = useTranslation();
  const [section, setSection] = useState<"containers" | "images">(
    "containers",
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<
    "all" | "running" | "stopped" | "paused"
  >("all");
  const filteredContainers = useMemo(() => {
    const value = query.trim().toLowerCase();
    return containers.filter((container) => {
      const paused =
        container.state === "paused" ||
        container.status.toLowerCase().includes("paused");
      const running =
        !paused &&
        (container.state === "running" ||
          container.status.toLowerCase().includes("up"));
      if (filter === "running" && !running) return false;
      if (filter === "paused" && !paused) return false;
      if (filter === "stopped" && (running || paused)) return false;
      return (
        !value ||
        container.name.toLowerCase().includes(value) ||
        container.image.toLowerCase().includes(value) ||
        container.status.toLowerCase().includes(value)
      );
    });
  }, [containers, filter, query]);
  const filteredImages = useMemo(() => {
    const value = query.trim().toLowerCase();
    return [...images]
      .sort((left, right) =>
        `${left.repository}:${left.tag}`.localeCompare(
          `${right.repository}:${right.tag}`,
          undefined,
          { sensitivity: "base" },
        ),
      )
      .filter(
        (image) =>
          !value ||
          `${image.repository}:${image.tag}`
            .toLowerCase()
            .includes(value) ||
          image.id.toLowerCase().includes(value),
      );
  }, [images, query]);
  return (
    <div className="docker-list">
      <div className="docker-toolbar">
        <div>
          <button
            className={section === "containers" ? "is-active" : ""}
            type="button"
            onClick={() => {
              if (section !== "containers") onCloseInspect();
              setSection("containers");
              setQuery("");
            }}
          >
            {t("Containers")}
          </button>
          <button
            className={section === "images" ? "is-active" : ""}
            type="button"
            onClick={() => {
              if (section !== "images") onCloseInspect();
              setSection("images");
              setQuery("");
            }}
          >
            {t("Images")}
          </button>
        </div>
        <input
          placeholder={
            section === "containers"
              ? t("Search containers...")
              : t("Search images...")
          }
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {section === "containers" ? (
          <div>
            {(["all", "running", "stopped", "paused"] as const).map(
              (value) => (
                <button
                  className={filter === value ? "is-active" : ""}
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                >
                  {t(value[0].toUpperCase() + value.slice(1))}
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>
      {section === "containers" ? (
        filteredContainers.map((container) => {
          const key = dockerInspectKey("container", container.id);
          const selected = inspect?.key === key;
          const toggleInspect = () =>
            void onInspect("container", container.id);
          return (
            <div
              className={`docker-item ${selected ? "is-selected" : ""}`}
              key={container.id}
            >
              <div
                aria-expanded={selected}
                className={`docker-row ${selected ? "is-selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={toggleInspect}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleInspect();
                  }
                }}
              >
                <span className={`docker-state state-${container.state}`} />
                <div>
                  <strong>{container.name}</strong>
                  <span>{container.image}</span>
                  <small>{container.status}</small>
                </div>
                <div className="docker-actions">
                  {container.state === "running" ? (
                    <button
                      type="button"
                      title={t("Shell")}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTerminal(
                          `docker: ${container.name}`,
                          "shell",
                          container.id,
                        );
                      }}
                    >
                      <TerminalSquare size={12} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title={t("Logs")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTerminal(
                        `logs: ${container.name}`,
                        "logs",
                        container.id,
                      );
                    }}
                  >
                    <ScrollText size={12} />
                  </button>
                  {container.state === "running" ? (
                    <button
                      type="button"
                      title={t("Stop")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void onAction("stop", container.id);
                      }}
                    >
                      <Square size={12} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      title={t("Start")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void onAction("start", container.id);
                      }}
                    >
                      <Play size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    title={t("Restart")}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onAction("restart", container.id);
                    }}
                  >
                    <RotateCw size={12} />
                  </button>
                  {container.state === "paused" ? (
                    <button
                      type="button"
                      title={t("Resume")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void onAction("unpause", container.id);
                      }}
                    >
                      <Play size={12} />
                    </button>
                  ) : container.state === "running" ? (
                    <button
                      type="button"
                      title={t("Pause")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void onAction("pause", container.id);
                      }}
                    >
                      <Pause size={12} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title={t("Rename")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDialog({
                        type: "input",
                        title: "Rename container",
                        label: "Container name",
                        value: container.name,
                        submit: async (value) => {
                          const name = value?.trim();
                          if (!name) return;
                          await onRename(container.id, name);
                        },
                      });
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    title={t("Kill")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onConfirm(
                        "Kill container",
                        `Immediately kill ${container.name}?`,
                        () => onAction("kill", container.id),
                      );
                    }}
                  >
                    <Bolt size={12} />
                  </button>
                  <button
                    type="button"
                    title={t("Remove")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onConfirm(
                        "Remove container",
                        `Remove ${container.name} and its writable layer?`,
                        () => onAction("remove", container.id),
                      );
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {selected ? (
                <DockerInspectView
                  inspect={inspect}
                  loading={inspectLoading}
                  onClose={onCloseInspect}
                />
              ) : null}
            </div>
          );
        })
      ) : null}
      {section === "containers" && filteredContainers.length === 0 ? (
        <div className="panel-empty">
          <Box size={24} />
          <p>{t("No containers found.")}</p>
        </div>
      ) : null}
      {section === "images" ? (
        <>
      <div className="docker-section-title">
        <span>{t("Images")}</span>
        <div>
          <button
            type="button"
            onClick={() =>
              onConfirm(
                "Prune images",
                "Remove dangling Docker images?",
                () => onPrune(false),
              )
            }
          >
            {t("Prune")}
          </button>
          <button
            type="button"
            onClick={() =>
              onConfirm(
                "Prune all unused images",
                "Remove all Docker images not used by a container?",
                () => onPrune(true),
              )
            }
          >
            {t("Prune all")}
          </button>
        </div>
      </div>
      {filteredImages.map((image) => {
        const selectionId = dockerImageSelectionId(image);
        const key = dockerInspectKey("image", selectionId);
        const selected = inspect?.key === key;
        const toggleInspect = () =>
          void onInspect("image", image.id, selectionId);
        return (
          <div
            className={`docker-item ${selected ? "is-selected" : ""}`}
            key={`${image.id}:${image.repository}:${image.tag}`}
          >
            <div
              aria-expanded={selected}
              className={`docker-row ${selected ? "is-selected" : ""}`}
              role="button"
              tabIndex={0}
              onClick={toggleInspect}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggleInspect();
                }
              }}
            >
              <span className="docker-state" />
              <div>
                <strong>
                  {image.repository}:{image.tag}
                </strong>
                <span>{image.id}</span>
                <small>
                  {[image.size, image.createdAt]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </div>
              <div className="docker-actions">
                <button
                  type="button"
                  title={t("Tag image")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDialog({
                      type: "input",
                      title: "Tag image",
                      label: "Repository:tag",
                      value:
                        image.repository === "<none>"
                          ? ""
                          : `${image.repository}:${
                              image.tag === "<none>" ? "latest" : image.tag
                            }`,
                      submit: async (value) => {
                        const target = value?.trim();
                        if (!target) return;
                        await onTag(image.id, target);
                      },
                    });
                  }}
                >
                  <Tag size={12} />
                </button>
                <button
                  type="button"
                  title={t("Remove image")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onConfirm(
                      "Remove image",
                      `Remove ${image.repository}:${image.tag}?`,
                      () => onRemoveImage(image),
                    );
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            {selected ? (
              <DockerInspectView
                inspect={inspect}
                loading={inspectLoading}
                onClose={onCloseInspect}
              />
            ) : null}
          </div>
        );
      })}
      {filteredImages.length === 0 ? (
        <div className="panel-empty">{t("No images found.")}</div>
      ) : null}
        </>
      ) : null}
    </div>
  );
}

function DockerInspectView({
  inspect,
  loading,
  onClose,
}: {
  inspect: DockerInspectState;
  loading: boolean;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [showsJSON, setShowsJSON] = useState(false);
  return (
    <div className="docker-inspect">
      <header>
        <strong>
          {t(
            inspect.kind === "container"
              ? "Container Inspect"
              : "Image Inspect",
          )}
        </strong>
        <div>
          <button
            disabled={!inspect.details}
            type="button"
            onClick={() => setShowsJSON((value) => !value)}
          >
            {showsJSON ? t("Details") : "JSON"}
          </button>
          <button type="button" onClick={onClose}>
            {t("Close")}
          </button>
        </div>
      </header>
      {loading && !inspect.details ? (
        <div className="docker-inspect-loading">
          <RotateCw className="is-spinning" size={13} />
          <span>{t("Loading Details")}</span>
        </div>
      ) : showsJSON && inspect.details ? (
        <pre>{inspect.details.rawJSON}</pre>
      ) : inspect.details ? (
        <div className="docker-inspect-details">
          {inspect.details.fields.map((field) => (
            <div className="docker-inspect-field" key={field.label}>
              <span>{t(field.label)}</span>
              <code className={field.monospaced ? "is-mono" : ""}>
                {field.value}
              </code>
            </div>
          ))}
          {inspect.details.lists.map((list) => (
            <section key={list.label}>
              <span>{t(list.label)}</span>
              {list.values.map((value, index) => (
                <code key={`${list.label}:${index}`}>{value}</code>
              ))}
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DockerDialogView({
  dialog,
  onClose,
}: {
  dialog: DockerDialog;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [value, setValue] = useState(dialog.value ?? "");
  return (
    <div className="docker-dialog-backdrop">
      <section className="docker-dialog" role="dialog" aria-modal="true">
        <header>
          <h3>{t(dialog.title)}</h3>
          <button type="button" onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        <div>
          {dialog.type === "input" ? (
            <label>
              <span>{t(dialog.label ?? "")}</span>
              <input
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          ) : (
            <p>{t(dialog.message ?? "")}</p>
          )}
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            className={
              dialog.type === "confirm"
                ? "danger-button"
                : "primary-button"
            }
            type="button"
            onClick={() => {
              void Promise.resolve(dialog.submit(value)).then(onClose);
            }}
          >
            {dialog.type === "confirm" ? t("Confirm") : t("Save")}
          </button>
        </footer>
      </section>
    </div>
  );
}

const systemOverviewCommand = String.raw`
printf '%s\n' \
  "$(hostname 2>/dev/null || uname -n)" \
  "$(if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s' "$PRETTY_NAME"; elif command -v sw_vers >/dev/null 2>&1; then printf '%s %s' "$(sw_vers -productName)" "$(sw_vers -productVersion)"; else uname -s; fi)" \
  "$(uname -r 2>/dev/null)" \
  "$(uptime -p 2>/dev/null || uptime 2>/dev/null)" \
  "$(model=''; if [ -r /proc/cpuinfo ]; then model=$(awk -F: '/model name|Hardware|Processor/ {gsub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo); elif command -v sysctl >/dev/null 2>&1; then model=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model 2>/dev/null); fi; if [ -z "$model" ] && command -v lscpu >/dev/null 2>&1; then model=$(lscpu 2>/dev/null | awk -F: '/Model name/ {gsub(/^[ \t]+/, "", $2); print $2; exit}'); fi; if [ -n "$model" ]; then printf '%s' "$model"; else uname -m; fi)" \
  "$(if [ -r /proc/loadavg ]; then awk '{print $1" "$2" "$3}' /proc/loadavg; else sysctl -n vm.loadavg 2>/dev/null | tr -d '{}'; fi)" \
  "$(if [ -r /proc/meminfo ]; then awk '/MemTotal/ {t=$2*1024} /MemAvailable/ {a=$2*1024} END {printf "%.0f %.0f", t, t-a}' /proc/meminfo; else total=$(sysctl -n hw.memsize 2>/dev/null || echo 0); used=$(vm_stat 2>/dev/null | awk -v t="$total" '/page size of/{gsub("[^0-9]","",$8);p=$8}/Pages free/{gsub("\\.","",$3);f=$3}END{printf "%.0f",t-f*p}'); printf '%s %s' "$total" "$used"; fi)" \
  "$(if [ -r /proc/stat ]; then awk '/^cpu / {total=0; for(i=2;i<=NF;i++) total+=$i; idle=$5+$6; user=$2+$3; system=$4} /^cpu[0-9]+ / {cores++} END {printf "%.0f %.0f %.0f %.0f %d",total,idle,user,system,cores}' /proc/stat; else printf '0 0 0 0 %s' "$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"; fi)" \
  "$(if [ -r /proc/net/dev ]; then awk -F'[: ]+' 'NR>2 {rx+=$3; tx+=$11} END {printf "%.0f %.0f", rx, tx}' /proc/net/dev; else netstat -ibn 2>/dev/null | awk 'NR>1 && $1!="Name" {rx[$1]=$7;tx[$1]=$10}END{for(n in rx){r+=rx[n];t+=tx[n]}printf "%.0f %.0f",r,t}'; fi)"
df -kP 2>/dev/null | awk 'NR>1 {p=$5; gsub(/%/,"",p); printf "__DISK__|%s|%.0f|%.0f|%s\n",$6,$3*1024,$2*1024,p}'
if [ -r /proc/net/dev ]; then awk -F'[: ]+' 'NR>2 {printf "__NETIF__|%s|%.0f|%.0f\n",$1,$3,$11}' /proc/net/dev; else netstat -ibn 2>/dev/null | awk 'NR>1 && $1!="Name" {rx[$1]=$7;tx[$1]=$10}END{for(n in rx)printf "__NETIF__|%s|%.0f|%.0f\n",n,rx[n],tx[n]}'; fi
if [ -r /proc/meminfo ]; then awk '/SwapTotal/ {t=$2} /SwapFree/ {f=$2} END {printf "__SWAP__|%.0f MB / %.0f MB\n",(t-f)/1024,t/1024}' /proc/meminfo; else sysctl vm.swapusage 2>/dev/null | awk '{printf "__SWAP__|%s %s / %s %s\n",$7,$8,$3,$4}'; fi
if [ -r /proc/stat ]; then true; else top -l 2 -n 0 2>/dev/null | awk '/CPU usage/{u=$3;s=$5;i=$7;gsub(/%/,"",u);gsub(/%/,"",s);gsub(/%/,"",i)}END{printf "__CPU_DIRECT__|%s|%s|%s\n",u,s,i}'; fi
ps -eo pid= -o pmem= -o comm= 2>/dev/null | sort -k2 -nr | head -5 | awk '{printf "__TOPPROC__|%s|%s|%s\n",$1,$2,$3}'
`;

const windowsSystemOverviewCommand = String.raw`
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$uptime = (Get-Date) - $os.LastBootUpTime
$total = [double]$os.TotalVisibleMemorySize * 1024
$used = [double]($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) * 1024
$cpuUsage = if ($null -eq $cpu.LoadPercentage) { 0 } else { [double]$cpu.LoadPercentage }
$coreCount = if ($null -eq $cpu.NumberOfLogicalProcessors) { 0 } else { [int]$cpu.NumberOfLogicalProcessors }
$adapters = @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue)
$rx = ($adapters | Measure-Object ReceivedBytes -Sum).Sum
$tx = ($adapters | Measure-Object SentBytes -Sum).Sum
if ($null -eq $rx) { $rx = 0 }
if ($null -eq $tx) { $tx = 0 }
Write-Output $env:COMPUTERNAME
Write-Output $os.Caption
Write-Output $os.Version
Write-Output ("up {0} days {1} hours" -f [int]$uptime.TotalDays, $uptime.Hours)
Write-Output $cpu.Name
Write-Output "N/A"
Write-Output ("{0} {1}" -f $total, $used)
Write-Output ("0 0 0 0 {0}" -f $coreCount)
Write-Output ("{0} {1}" -f $rx, $tx)
Write-Output ("__CPU_DIRECT__|{0}|0|{1}" -f $cpuUsage, (100 - $cpuUsage))
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  $usedDisk = [double]$_.Size - [double]$_.FreeSpace
  $percent = if ($_.Size -gt 0) { $usedDisk * 100 / $_.Size } else { 0 }
  Write-Output ("__DISK__|{0}|{1}|{2}|{3}" -f $_.DeviceID, $usedDisk, $_.Size, $percent)
}
$adapters | ForEach-Object {
  Write-Output ("__NETIF__|{0}|{1}|{2}" -f $_.Name, $_.ReceivedBytes, $_.SentBytes)
}
$pages = @(Get-CimInstance Win32_PageFileUsage)
$pageUsed = ($pages | Measure-Object CurrentUsage -Sum).Sum
$pageTotal = ($pages | Measure-Object AllocatedBaseSize -Sum).Sum
Write-Output ("__SWAP__|{0} MB / {1} MB" -f $pageUsed, $pageTotal)
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object {
  Write-Output ("__TOPPROC__|{0}|0|{1}" -f $_.Id, $_.ProcessName)
}
`;

const processCommand =
  "ps -eo pid= -o ppid= -o user= -o stat= -o pcpu= -o pmem= -o rss= -o vsz= -o etime= -o args= 2>/dev/null || top -b -n 1 2>/dev/null || ps ww 2>/dev/null || ps 2>/dev/null";

const windowsProcessCommand = String.raw`
Get-CimInstance Win32_Process | ForEach-Object {
  $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  $rss = if ($process) { [math]::Round($process.WorkingSet64 / 1024) } else { 0 }
  $vsz = if ($process) { [math]::Round($process.VirtualMemorySize64 / 1024) } else { 0 }
  $command = if ($_.CommandLine) { $_.CommandLine -replace '[\r\n]+',' ' } else { $_.Name }
  Write-Output ("{0} {1} SYSTEM R 0 0 {2} {3} 00:00 {4}" -f $_.ProcessId, $_.ParentProcessId, $rss, $vsz, $command)
}
`;

const dockerFormat =
  '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}"}';
const dockerImageFormat =
  '{"id":"{{.ID}}","repository":"{{.Repository}}","tag":"{{.Tag}}","size":"{{.Size}}","createdAt":"{{.CreatedSince}}"}';

export function parseOverview(
  output: string,
  previous: OverviewSample | undefined,
  timestamp: number,
) {
  const lines = output.trim().split(/\r?\n/);
  const memory = (lines[6] ?? "").split(/\s+/).map(Number);
  const cpu = (lines[7] ?? "").split(/\s+/).map(Number);
  const network = (lines[8] ?? "").split(/\s+/).map(Number);
  const interfaces: Record<string, { rx: number; tx: number }> =
    Object.fromEntries(
    lines.flatMap((line) => {
      if (!line.startsWith("__NETIF__|")) return [];
      const [, name, rx, tx] = line.split("|");
      if (!name) return [];
      return [[name, { rx: Number(rx) || 0, tx: Number(tx) || 0 }]];
    }),
    );
  const sample: OverviewSample = {
    timestamp,
    cpuTotal: cpu[0] || 0,
    cpuIdle: cpu[1] || 0,
    cpuUser: cpu[2] || 0,
    cpuSystem: cpu[3] || 0,
    networkRx: network[0] || 0,
    networkTx: network[1] || 0,
    interfaces,
  };
  const elapsed = previous
    ? Math.max((sample.timestamp - previous.timestamp) / 1_000, 0.001)
    : 1;
  const cpuTotalDelta = previous
    ? sample.cpuTotal - previous.cpuTotal
    : 0;
  const cpuIdleDelta = previous ? sample.cpuIdle - previous.cpuIdle : 0;
  const cpuUserDelta = previous ? sample.cpuUser - previous.cpuUser : 0;
  const cpuSystemDelta = previous
    ? sample.cpuSystem - previous.cpuSystem
    : 0;
  const directCpu = lines
    .find((line) => line.startsWith("__CPU_DIRECT__|"))
    ?.split("|")
    .slice(1)
    .map(Number);
  const overview: SystemOverview = {
    hostname: lines[0] || "Unknown",
    os: lines[1] || "Unknown",
    kernel: lines[2] || "Unknown",
    uptime: lines[3] || "Unknown",
    cpuModel: lines[4] || "Unknown",
    cpuUsage:
      directCpu && directCpu.length >= 3
        ? clampPercent(100 - (directCpu[2] || 0))
        : cpuTotalDelta > 0
        ? clampPercent(
            ((cpuTotalDelta - cpuIdleDelta) / cpuTotalDelta) * 100,
          )
        : 0,
    cpuUserUsage:
      directCpu && directCpu.length >= 3
        ? clampPercent(directCpu[0] || 0)
        : cpuTotalDelta > 0
          ? clampPercent((cpuUserDelta / cpuTotalDelta) * 100)
          : 0,
    cpuSystemUsage:
      directCpu && directCpu.length >= 3
        ? clampPercent(directCpu[1] || 0)
        : cpuTotalDelta > 0
          ? clampPercent((cpuSystemDelta / cpuTotalDelta) * 100)
          : 0,
    cpuCoreCount: Math.max(0, Math.round(cpu[4] || 0)),
    loadAverage: lines[5] || "Unknown",
    memoryTotal: memory[0] || 0,
    memoryUsed: memory[1] || 0,
    networkRxPerSecond: previous
      ? Math.max(0, (sample.networkRx - previous.networkRx) / elapsed)
      : 0,
    networkTxPerSecond: previous
      ? Math.max(0, (sample.networkTx - previous.networkTx) / elapsed)
      : 0,
    swap:
      lines
        .find((line) => line.startsWith("__SWAP__|"))
        ?.slice("__SWAP__|".length) ?? "",
    disks: lines.flatMap((line) => {
      if (!line.startsWith("__DISK__|")) return [];
      const [, mount, used, total, percent] = line.split("|");
      return [
        {
          mount,
          used: Number(used) || 0,
          total: Number(total) || 0,
          percent: Number(percent) || 0,
        },
      ];
    }),
    networkInterfaces: Object.entries(interfaces)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, counters]) => {
        const previousCounters = previous?.interfaces[name];
        return {
          name,
          rxPerSecond: previousCounters
            ? Math.max(0, (counters.rx - previousCounters.rx) / elapsed)
            : 0,
          txPerSecond: previousCounters
            ? Math.max(0, (counters.tx - previousCounters.tx) / elapsed)
            : 0,
        };
      }),
    topMemoryProcesses: lines.flatMap((line) => {
      if (!line.startsWith("__TOPPROC__|")) return [];
      const [, pid, memoryPercent, command] = line.split("|");
      return [
        {
          pid: Number(pid) || 0,
          memoryPercent: Number(memoryPercent) || 0,
          command,
        },
      ];
    }),
  };
  return { overview, sample };
}

export function parseProcesses(output: string): SystemProcessRow[] {
  const pattern =
    /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/;
  return output.split(/\r?\n/).flatMap((rawLine) => {
    const match = rawLine.trim().match(pattern);
    if (!match) return [];
    return [
      {
        pid: Number(match[1]) || 0,
        ppid: Number(match[2]) || 0,
        user: match[3],
        stat: match[4],
        cpuPercent: Number(match[5]) || 0,
        memPercent: Number(match[6]) || 0,
        rssKB: Number(match[7]) || 0,
        vszKB: Number(match[8]) || 0,
        elapsed: match[9],
        command: match[10],
      },
    ];
  });
}

interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt: string;
}

export function dockerInspectKey(
  kind: "container" | "image",
  id: string,
) {
  return `${kind}:${id}`;
}

export function dockerImageSelectionId(
  image: Pick<DockerImage, "id" | "repository" | "tag">,
) {
  return `${image.id}\u001f${image.repository}\u001f${image.tag}`;
}

export function nextDockerInspectKey(
  current: string | undefined,
  selected: string,
) {
  return current === selected ? undefined : selected;
}

export function parseDocker(output: string) {
  const containers: DockerContainer[] = [];
  const images: DockerImage[] = [];
  let section: "containers" | "images" = "containers";
  for (const line of output.split(/\r?\n/)) {
    if (line === "__CONTAINERS__") {
      section = "containers";
      continue;
    }
    if (line === "__IMAGES__") {
      section = "images";
      continue;
    }
    if (!line) continue;
    try {
      if (section === "containers") {
        containers.push(JSON.parse(line) as DockerContainer);
      } else {
        images.push(JSON.parse(line) as DockerImage);
      }
    } catch {
      continue;
    }
  }
  return { containers, images };
}

export function parseDockerInspect(
  output: string,
  kind: "container" | "image",
): DockerInspectDetails {
  const parsed = JSON.parse(output) as unknown;
  const root = (
    Array.isArray(parsed) ? parsed[0] : parsed
  ) as Record<string, unknown> | undefined;
  if (!root || typeof root !== "object") {
    throw new Error("Docker inspect returned an invalid response.");
  }
  const rawJSON = JSON.stringify(root, null, 2);
  const fields: DockerInspectDetails["fields"] = [];
  const lists: DockerInspectDetails["lists"] = [];
  const appendField = (
    label: string,
    value: string,
    monospaced = false,
  ) => {
    if (value) fields.push({ label, value, monospaced });
  };
  const appendList = (label: string, values: string[]) => {
    if (values.length > 0) lists.push({ label, values });
  };

  appendField("ID", shortDockerId(stringValue(root.Id)), true);
  if (kind === "container") {
    appendField(
      "Status",
      stringValue(valueAt(root, "State", "Status")),
    );
    appendField(
      "Image",
      stringValue(valueAt(root, "Config", "Image")),
      true,
    );
    appendField("Created", stringValue(root.Created));
    appendField(
      "Started",
      stringValue(valueAt(root, "State", "StartedAt")),
    );
    appendField(
      "Restart Policy",
      stringValue(
        valueAt(root, "HostConfig", "RestartPolicy", "Name"),
      ),
    );
    appendField(
      "Command",
      [
        stringValue(root.Path),
        ...stringArray(root.Args),
      ]
        .filter(Boolean)
        .join(" "),
      true,
    );
    appendList(
      "Ports",
      objectEntries(valueAt(root, "NetworkSettings", "Ports")),
    );
    appendList(
      "Networks",
      objectKeys(valueAt(root, "NetworkSettings", "Networks")),
    );
    appendList(
      "Mounts",
      arrayRecords(root.Mounts).map((mount) =>
        [
          stringValue(mount.Source),
          stringValue(mount.Destination),
          stringValue(mount.Type),
        ]
          .filter(Boolean)
          .join(" -> "),
      ),
    );
  } else {
    appendField(
      "Size",
      typeof root.Size === "number"
        ? formatBytes(root.Size)
        : stringValue(root.Size),
    );
    appendField(
      "Platform",
      [stringValue(root.Os), stringValue(root.Architecture)]
        .filter(Boolean)
        .join("/"),
      true,
    );
    appendField("Created", stringValue(root.Created));
    appendField(
      "Entrypoint",
      stringArray(valueAt(root, "Config", "Entrypoint")).join(" "),
      true,
    );
    appendField(
      "CMD",
      stringArray(valueAt(root, "Config", "Cmd")).join(" "),
      true,
    );
    appendField(
      "Working Directory",
      stringValue(valueAt(root, "Config", "WorkingDir")),
      true,
    );
    appendList("Tags", stringArray(root.RepoTags));
    appendList("Digests", stringArray(root.RepoDigests));
    appendList(
      "Exposed Ports",
      objectKeys(valueAt(root, "Config", "ExposedPorts")),
    );
  }
  appendList(
    "Environment",
    stringArray(valueAt(root, "Config", "Env")),
  );
  appendList(
    "Labels",
    objectEntries(valueAt(root, "Config", "Labels")),
  );
  return { fields, lists, rawJSON };
}

function valueAt(
  root: Record<string, unknown>,
  ...path: string[]
): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean)
    : [];
}

function arrayRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) &&
          typeof item === "object" &&
          !Array.isArray(item),
      )
    : [];
}

function objectKeys(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

export function shouldUseWindowsSystemCommands(
  platform: "windows" | "macos",
  hasRemoteHost: boolean,
) {
  return platform === "windows" && !hasRemoteHost;
}

function objectEntries(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).map(([key, item]) => {
    if (item == null) return key;
    if (typeof item === "string" || typeof item === "number") {
      return `${key}=${item}`;
    }
    return `${key}=${JSON.stringify(item)}`;
  });
}

function shortDockerId(value: string) {
  return value.replace(/^sha256:/, "").slice(0, 12);
}

export function dockerInteractiveCommand(
  id: string,
  mode: "shell" | "logs",
  host?: Pick<
    Host,
    "username" | "serverToolsUseRoot" | "serverToolsElevationMethod"
  >,
  platform: "windows" | "macos" = "macos",
) {
  const safeId = sanitizeDockerId(id);
  if (!safeId) return undefined;
  const dockerArguments =
    mode === "shell"
      ? `exec -it ${safeId} sh -c ${shellQuote(
          "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
        )}`
      : `logs -f --tail 200 ${safeId}`;
  if (!host && platform === "windows") {
    return `docker ${dockerArguments}`;
  }
  const script = `printf '\\033[H\\033[2J\\033[3J'; exec docker ${dockerArguments}`;
  const command = `sh -c ${shellQuote(script)}`;
  if (!host || !host.serverToolsUseRoot || host.username === "root") {
    return command;
  }
  return host.serverToolsElevationMethod === "su"
    ? `su - root -c ${shellQuote(command)}`
    : `sudo -H -S -k -p '[sudo] Password:' ${command}`;
}

export function sanitizeDockerId(value: string) {
  const normalized = value.startsWith("sha256:")
    ? value.slice(7)
    : value;
  const safe = [...normalized]
    .filter((character) => /^[A-Za-z0-9]$/.test(character))
    .join("")
    .slice(0, 64);
  return safe || undefined;
}

export function sanitizeContainerName(value: string) {
  const safe = [...value.trim().slice(0, 128)]
    .filter(
      (character) =>
        /^[A-Za-z0-9_.-]$/.test(character),
    )
    .join("");
  return safe || undefined;
}

export function sanitizeImageReference(value: string) {
  const reference = value.trim();
  if (
    !reference ||
    reference.length > 385 ||
    /[\u0000-\u001f\u007f]/.test(reference)
  ) {
    return undefined;
  }
  return reference.endsWith(":") ? `${reference}latest` : reference;
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function formatGigabytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0.0 GB";
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatUptime(
  value: string,
  t: (key: string) => string,
) {
  const days = Number(value.match(/(\d+)\s+days?/i)?.[1] ?? 0);
  const hours = Number(value.match(/(\d+)\s+hours?/i)?.[1] ?? 0);
  if (!days && !hours && !/\bup\b/i.test(value)) return value;
  const dayUnit = t("days");
  const hourUnit = t("hours");
  return dayUnit === "days"
    ? `${days} days ${hours} hours`
    : `${days}${dayUnit} ${hours}${hourUnit}`;
}

function formatSampleTime(timestamp?: number) {
  if (!timestamp) return "--";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
