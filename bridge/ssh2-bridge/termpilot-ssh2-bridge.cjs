#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const proxyUtilsPath = fs.existsSync(
  path.resolve(__dirname, "../proxy-bridge/proxyUtils.cjs"),
)
  ? path.resolve(__dirname, "../proxy-bridge/proxyUtils.cjs")
  : path.resolve(__dirname, "proxyUtils.cjs");
const { createProxySocket } = require(proxyUtilsPath);

const BROKER_ENV = "TERMPILOT_SSH2_BRIDGE_BROKER";
const BROKER_CONNECT_TIMEOUT_MS = 20000;
const BROKER_IDLE_TIMEOUT_MS = 15000;
const LATENCY_PROBE_INTERVAL_MS = 10000;
const LATENCY_PROBE_TIMEOUT_MS = 5000;
const TERMINAL_CONTROL_START = "\x1e";
const TERMINAL_CONTROL_END = "\x1f";

function terminalLog(status, message, detail, output = process.stdout) {
  const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
  output.write(
    `${TERMINAL_CONTROL_START}[ssh2:${status}] ${message}${suffix}${TERMINAL_CONTROL_END}`,
  );
}

function readConfig() {
  const encoded = process.env.TERMPILOT_SSH2_BRIDGE_CONFIG_B64
    || process.env.TERMPILOT_SFTP_BRIDGE_CONFIG_B64;
  if (!encoded) {
    throw new Error("TERMPILOT_SSH2_BRIDGE_CONFIG_B64 is missing");
  }
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function requireSsh2() {
  const candidates = [
    process.env.TERMPILOT_SSH2_NODE_MODULES,
    path.resolve(__dirname, "node_modules"),
    path.resolve(process.cwd(), "node_modules"),
  ].filter(Boolean);

  let firstError = null;
  for (const base of candidates) {
    try {
      return {
        module: require(path.join(base, "ssh2")),
        resolvedFrom: base,
      };
    } catch (error) {
      firstError ||= error;
    }
  }

  try {
    return {
      module: require("ssh2"),
      resolvedFrom: "node module resolution",
    };
  } catch (error) {
    throw firstError || error;
  }
}

function safeConnectSummary(config) {
  return {
    hostname: config.hostname,
    port: config.port || 22,
    username: config.username,
    authentication: config.authentication,
    hasPassword: Boolean(config.password),
    hasIdentityFile: Boolean(config.identityFile),
    proxyType: config.proxy?.type || null,
    proxyEndpoint: config.proxy?.type === "command"
      ? "ProxyCommand"
      : config.proxy
        ? `${config.proxy.host}:${config.proxy.port}`
        : null,
    connectionID: config.connectionID,
  };
}

function readSSHString(buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer) || offset + 4 > buffer.length) return null;
  const length = buffer.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (length <= 0 || end > buffer.length) return null;
  return {
    value: buffer.subarray(start, end),
    nextOffset: end,
  };
}

function hostPatternForKnownHosts(config) {
  const hostname = String(config.hostname || "").trim();
  if (!hostname || /[\s,]/.test(hostname)) return null;
  const port = Number(config.port || 22);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (port === 22) return hostname;
  return `[${hostname.replace(/^\[/, "").replace(/\]$/, "")}]:${port}`;
}

function algorithmForHostKey(key, ssh2) {
  try {
    let parsed = ssh2?.utils?.parseKey?.(key);
    if (Array.isArray(parsed)) {
      parsed = parsed[0];
    }
    if (parsed && !(parsed instanceof Error) && parsed.type) {
      return parsed.type;
    }
  } catch {
    // Fall back to reading the SSH wire-format algorithm below.
  }

  const algorithm = readSSHString(key)?.value?.toString("utf8");
  return algorithm && !/\s/.test(algorithm) ? algorithm : null;
}

function appendKnownHostLine(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", {
      mode: 0o600,
    });
  }

  const existing = fs.readFileSync(filePath, "utf8");
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
  if (existingLines.has(line)) {
    return false;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(filePath, `${prefix}${line}\n`, {
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on file systems that do not support chmod.
  }
  return true;
}

function knownHostStatus(filePath, hostPattern, algorithm, keyBlob) {
  if (!fs.existsSync(filePath)) {
    return {
      matches: false,
      hasHostPattern: false,
    };
  }

  let matches = false;
  let hasHostPattern = false;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 3) continue;
    const patterns = fields[0].split(",");
    if (!patterns.includes(hostPattern)) continue;
    hasHostPattern = true;
    if (fields[1] === algorithm && fields[2] === keyBlob) {
      matches = true;
      break;
    }
  }
  return {
    matches,
    hasHostPattern,
  };
}

function hostKeyFingerprint(key) {
  return `SHA256:${crypto
    .createHash("sha256")
    .update(key)
    .digest("base64")
    .replace(/=+$/g, "")}`;
}

async function verifyKnownHost(config, key, ssh2, confirmKnownHost) {
  const filePath = String(config.knownHostsFile || "").trim();
  if (!filePath) {
    return {
      accepted: true,
      added: false,
      known: false,
    };
  }
  const hostPattern = hostPatternForKnownHosts(config);
  const algorithm = algorithmForHostKey(key, ssh2);
  if (!hostPattern || !algorithm) {
    throw new Error("Unable to build OpenSSH known_hosts entry.");
  }

  const keyBlob = Buffer.from(key).toString("base64");
  const line = `${hostPattern} ${algorithm} ${keyBlob}`;
  const status = knownHostStatus(filePath, hostPattern, algorithm, keyBlob);
  const fingerprint = hostKeyFingerprint(key);
  if (status.matches) {
    return {
      accepted: true,
      added: false,
      known: true,
      hostPattern,
      algorithm,
      fingerprint,
    };
  }

  if (config.autoAcceptHostKeys === true) {
    const added = appendKnownHostLine(filePath, line);
    return {
      accepted: true,
      added,
      known: false,
      hostPattern,
      algorithm,
      fingerprint,
    };
  }

  const accepted = await confirmKnownHost({
    hostPattern,
    algorithm,
    fingerprint,
    hasHostPattern: status.hasHostPattern,
  });
  if (!accepted) {
    return {
      accepted: false,
      added: false,
      known: false,
      hostPattern,
      algorithm,
      fingerprint,
    };
  }

  const added = appendKnownHostLine(filePath, line);
  return {
    accepted: true,
    added,
    known: false,
    hostPattern,
    algorithm,
    fingerprint,
  };
}

function isPasswordPrompt(prompt) {
  return /password|passphrase/i.test(String(prompt || ""));
}

function brokerLocation(config) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const directory = path.join(os.tmpdir(), `termpilot-ssh2-${uid}`);
  const connectionID = config.connectionID
    || `${config.username || "root"}@${config.hostname}:${config.port || 22}`;
  const digest = crypto
    .createHash("sha256")
    .update(connectionID)
    .digest("hex")
    .slice(0, 32);
  return {
    directory,
    socketPath: process.platform === "win32"
      ? `\\\\.\\pipe\\termpilot-ssh2-${uid}-${digest}`
      : path.join(directory, `${digest}.sock`),
  };
}

function ensureBrokerDirectory(directory) {
  fs.mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on file systems that do not support chmod.
  }
}

function writeFrame(socket, frame) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(frame)}\n`);
  }
}

function writeLogFrame(socket, status, message, detail) {
  writeFrame(socket, {
    type: "log",
    status,
    message,
    detail,
  });
}

function enableTcpNoDelay(target) {
  try {
    target?.setNoDelay?.(true);
  } catch {
    // Best effort: continue when a proxy transport cannot expose TCP_NODELAY.
  }
}

function createFrameReader(onFrame, onError) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onFrame(JSON.parse(line));
      } catch (error) {
        onError?.(error);
      }
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseCdTarget(line) {
  const trimmed = String(line || "").trim();
  if (!/^cd(?:\s|$)/.test(trimmed)) return null;
  if (/[;&|<>`]/.test(trimmed) || trimmed.includes("$(")) return null;
  let rest = trimmed.slice(2).trim();
  if (!rest) return "~";

  let quote = null;
  let value = "";
  let index = 0;
  if (rest[0] === "'" || rest[0] === '"') {
    quote = rest[0];
    index = 1;
  }
  for (; index < rest.length; index += 1) {
    const character = rest[index];
    if (quote) {
      if (character === quote) {
        index += 1;
        break;
      }
      if (character === "\\" && quote === '"' && index + 1 < rest.length) {
        index += 1;
        value += rest[index];
      } else {
        value += character;
      }
      continue;
    }
    if (/\s/.test(character)) break;
    if (character === "\\") {
      index += 1;
      if (index < rest.length) value += rest[index];
    } else {
      value += character;
    }
  }
  if (rest.slice(index).trim()) return null;
  return value || "~";
}

function stripTerminalSequences(value) {
  return String(value || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function connectToBroker(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      socket.removeListener("error", fail);
      resolve(socket);
    });
    socket.once("error", fail);
  });
}

async function waitForBroker(socketPath, timeoutMS) {
  const deadline = Date.now() + timeoutMS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await connectToBroker(socketPath);
    } catch (error) {
      lastError = error;
      await sleep(150);
    }
  }
  throw lastError || new Error("Timed out waiting for shared SSH broker");
}

function removeStaleSocketIfNeeded(socketPath, error) {
  if (process.platform === "win32") return;
  if (error?.code !== "ECONNREFUSED") return;
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Another client may already have cleaned it up.
  }
}

function startBrokerProcess() {
  const child = childProcess.spawn(
    process.execPath,
    [__filename],
    {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        [BROKER_ENV]: "1",
      },
      stdio: "ignore",
    }
  );
  child.unref();
}

let sftpBridgeModule = null;

function loadSftpBridgeModule(explicitPath = null) {
  if (sftpBridgeModule) return sftpBridgeModule;
  const candidates = [
    explicitPath,
    process.env.TERMPILOT_SFTP_BRIDGE_SCRIPT,
    path.resolve(__dirname, "termpilot-sftp-bridge.cjs"),
    path.resolve(__dirname, "../sftp-bridge/termpilot-sftp-bridge.cjs"),
  ].filter(Boolean);
  let firstError = null;
  for (const candidate of candidates) {
    try {
      sftpBridgeModule = require(candidate);
      return sftpBridgeModule;
    } catch (error) {
      firstError ||= error;
    }
  }
  throw firstError || new Error("Unable to load TermPilot SFTP bridge module.");
}

function configureLocalInput() {
  let rawEnabled = false;
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    rawEnabled = true;
  }
  process.stdin.resume();
  process.on("exit", () => {
    if (!rawEnabled) return;
    try {
      process.stdin.setRawMode(false);
    } catch {
      // The TTY can already be gone during shutdown.
    }
  });
}

async function runClient(config) {
  const { directory, socketPath } = brokerLocation(config);
  const usesPipeTransport = process.env.TERMPILOT_PIPE_TRANSPORT === "1";
  ensureBrokerDirectory(directory);
  configureLocalInput();

  let socket;
  try {
    socket = await connectToBroker(socketPath);
  } catch (error) {
    removeStaleSocketIfNeeded(socketPath, error);
    terminalLog("broker", "Starting shared SSH broker", {
      socket: socketPath,
    });
    startBrokerProcess();
    socket = await waitForBroker(socketPath, BROKER_CONNECT_TIMEOUT_MS);
  }

  terminalLog("broker", "Attached to shared SSH broker", {
    socket: socketPath,
  });

  let exiting = false;
  let activeHostKeyPromptID = null;
  let hostKeyPromptInputBuffer = "";
  const closeWith = (code) => {
    if (exiting) return;
    exiting = true;
    process.exit(code);
  };

  const handleHostKeyPromptInput = (chunk) => {
    if (!activeHostKeyPromptID) return false;
    hostKeyPromptInputBuffer += chunk.toString("utf8");
    const newline = hostKeyPromptInputBuffer.search(/[\r\n]/);
    if (newline < 0) return true;
    const answer = hostKeyPromptInputBuffer.slice(0, newline).trim();
    const accepted = /^(yes|y|accept|accepted|true|1)$/i.test(answer);
    writeFrame(socket, {
      type: "hostKeyResponse",
      promptID: activeHostKeyPromptID,
      accepted,
    });
    activeHostKeyPromptID = null;
    hostKeyPromptInputBuffer = "";
    return true;
  };

  writeFrame(socket, {
    type: "open",
    cols: Number(process.env.TERMPILOT_COLUMNS) || process.stdout.columns || 80,
    rows: Number(process.env.TERMPILOT_ROWS) || process.stdout.rows || 24,
    sessionID: config.sessionID,
  });

  socket.on("data", createFrameReader(
    (frame) => {
      switch (frame.type) {
      case "log":
        terminalLog(frame.status, frame.message, frame.detail);
        break;
      case "data":
        process.stdout.write(Buffer.from(frame.data || "", "base64"));
        break;
      case "cwd":
        terminalLog("cwd", frame.directory || "");
        break;
      case "user":
        terminalLog("user", frame.username || "");
        break;
      case "hostKeyPrompt":
        activeHostKeyPromptID = frame.promptID || null;
        hostKeyPromptInputBuffer = "";
        terminalLog(
          "host-key-prompt",
          "SSH host key confirmation required",
          frame.detail || {}
        );
        break;
      case "exit":
        closeWith(typeof frame.code === "number" ? frame.code : 0);
        break;
      case "error":
        terminalLog("error", frame.message || "Shared SSH broker error", frame.detail);
        closeWith(1);
        break;
      default:
        break;
      }
    },
    (error) => {
      terminalLog("error", "Invalid shared SSH broker frame", {
        error: error.message,
      });
    }
  ));

  socket.on("close", () => {
    if (!exiting) {
      terminalLog("exit", "Shared SSH broker connection closed");
      closeWith(1);
    }
  });
  socket.on("error", (error) => {
    terminalLog("error", "Shared SSH broker connection error", {
      error: error.message,
      code: error.code,
    });
  });

  const sendTerminalData = (chunk) => {
    if (handleHostKeyPromptInput(chunk)) {
      return;
    }
    writeFrame(socket, {
      type: "data",
      data: Buffer.from(chunk).toString("base64"),
    });
  };

  if (usesPipeTransport) {
    let inputBuffer = "";
    process.stdin.on("data", (chunk) => {
      inputBuffer += chunk.toString("utf8");
      while (true) {
        const newline = inputBuffer.indexOf("\n");
        if (newline < 0) return;
        const line = inputBuffer.slice(0, newline).trim();
        inputBuffer = inputBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.type === "data") {
            sendTerminalData(Buffer.from(frame.data || "", "base64"));
          } else if (frame.type === "resize") {
            writeFrame(socket, {
              type: "resize",
              cols: Number(frame.columns) || 80,
              rows: Number(frame.rows) || 24,
            });
          }
        } catch (error) {
          terminalLog("error", "Invalid terminal input frame", {
            error: error.message,
          });
        }
      }
    });
  } else {
    process.stdin.on("data", sendTerminalData);
  }

  if (!usesPipeTransport) {
    process.on("SIGWINCH", () => {
      writeFrame(socket, {
        type: "resize",
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      });
    });
  }

  process.on("SIGTERM", () => {
    writeFrame(socket, { type: "close" });
    socket.end();
    closeWith(143);
  });
}

async function runSftpBrokerClient(config) {
  const { directory, socketPath } = brokerLocation(config);
  ensureBrokerDirectory(directory);

  let socket = null;
  let ready = false;
  let openError = null;
  const queuedRequests = [];
  const inFlightRequests = new Set();

  const writeJSON = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const failRequest = (id, message) => {
    writeJSON({
      id,
      ok: false,
      error: message,
    });
  };

  const sendRequest = (request) => {
    if (!socket || socket.destroyed) {
      failRequest(request.id, openError || "Shared SSH broker is not available.");
      return;
    }
    inFlightRequests.add(request.id);
    writeFrame(socket, {
      type: "sftpRequest",
      request,
    });
  };

  const flushQueuedRequests = () => {
    while (ready && queuedRequests.length > 0) {
      sendRequest(queuedRequests.shift());
    }
  };

  try {
    socket = await connectToBroker(socketPath);
  } catch (error) {
    openError = `Source terminal SSH session is not reusable for SFTP: ${error.message}`;
    writeJSON({
      id: 0,
      ok: false,
      error: openError,
    });
  }
  if (socket) {
    socket.on("data", createFrameReader(
      (frame) => {
        switch (frame.type) {
        case "sftpReady":
        case "execReady":
          ready = true;
          writeJSON({
            id: 0,
            event: "ready",
            mode: frame.mode || (frame.type === "execReady" ? "exec" : "sftp"),
          });
          flushQueuedRequests();
          break;
        case "sftpResponse":
          if (frame.message && frame.message.id !== undefined) {
            inFlightRequests.delete(frame.message.id);
          }
          writeJSON(frame.message || {});
          break;
        case "error":
          openError = frame.message || "Shared SSH broker rejected SFTP reuse.";
          if (!ready) {
            writeJSON({
              id: 0,
              ok: false,
              error: openError,
            });
          }
          for (const request of queuedRequests.splice(0)) {
            failRequest(request.id, openError);
          }
          for (const id of Array.from(inFlightRequests)) {
            inFlightRequests.delete(id);
            failRequest(id, openError);
          }
          break;
        default:
          break;
        }
      },
      (error) => {
        openError = `Invalid shared SSH broker frame: ${error.message}`;
      }
    ));
    socket.on("close", () => {
      openError ||= "Shared SSH broker connection closed.";
      for (const request of queuedRequests.splice(0)) {
        failRequest(request.id, openError);
      }
      for (const id of Array.from(inFlightRequests)) {
        inFlightRequests.delete(id);
        failRequest(id, openError);
      }
    });
    socket.on("error", (error) => {
      openError = `Shared SSH broker connection error: ${error.message}`;
      for (const request of queuedRequests.splice(0)) {
        failRequest(request.id, openError);
      }
      for (const id of Array.from(inFlightRequests)) {
        inFlightRequests.delete(id);
        failRequest(id, openError);
      }
    });
    if (config.execOnly) {
      writeFrame(socket, {
        type: "execOpen",
        config: {
          sourceSessionID: config.sourceSessionID,
          elevationPassword: config.elevationPassword,
          elevationMethod: config.elevationMethod,
          persistentElevation: !!config.persistentElevation,
        },
      });
    } else {
      writeFrame(socket, {
        type: "sftpOpen",
        config: {
          fileProtocol: config.fileProtocol || "auto",
          filenameEncoding: config.filenameEncoding || "auto",
          usesSudo: !!config.usesSudo,
          sourceSessionID: config.sourceSessionID,
          sftpBridgeScript: process.env.TERMPILOT_SFTP_BRIDGE_SCRIPT,
        },
      });
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      failRequest(null, error.message);
      continue;
    }

    if (openError) {
      if (request.action === "close") {
        writeJSON({ id: request.id, ok: true, result: {} });
        break;
      }
      failRequest(request.id, openError);
      continue;
    }

    if (!ready) {
      queuedRequests.push(request);
      continue;
    }
    sendRequest(request);
  }

  try {
    socket?.end();
  } catch {
    // Best effort: the broker owns the actual SSH transport.
  }
}

async function runBroker(config, ssh2) {
  const { directory, socketPath } = brokerLocation(config);
  ensureBrokerDirectory(directory);

  const { Client } = ssh2;
  const conn = new Client();
  const clients = new Set();
  const pendingClients = new Set();
  let ready = false;
  let shuttingDown = false;
  let idleTimer = null;
  let latencyTimer = null;
  let latencyProbeInFlight = false;
  let lastLatencyMilliseconds = null;
  let activePrompt = null;
  let activeHostKeyPrompt = null;

  const cancelIdleExit = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (latencyTimer) {
      clearInterval(latencyTimer);
      latencyTimer = null;
    }
    for (const client of Array.from(clients)) {
      closeBrokerClient(client);
    }
    try {
      conn.end();
    } catch {}
    try {
      server.close();
    } catch {}
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    process.exit(code);
  };

  const scheduleIdleExit = () => {
    if (clients.size > 0 || idleTimer) return;
    idleTimer = setTimeout(() => {
      shutdown(0);
    }, BROKER_IDLE_TIMEOUT_MS);
  };

  const logAll = (status, message, detail) => {
    for (const client of clients) {
      if (client.kind !== "terminal") continue;
      writeLogFrame(client.socket, status, message, detail);
    }
  };

  const probeLatency = () => {
    if (
      !ready
      || shuttingDown
      || latencyProbeInFlight
      || !Array.from(clients).some((client) => (
        client.kind === "terminal" && !client.closed
      ))
    ) {
      return;
    }
    latencyProbeInFlight = true;
    const started = process.hrtime.bigint();
    let settled = false;
    const finish = (milliseconds) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      latencyProbeInFlight = false;
      lastLatencyMilliseconds = milliseconds;
      logAll(
        milliseconds == null ? "latency-unavailable" : "latency",
        milliseconds == null ? "unavailable" : String(milliseconds),
      );
    };
    const timeout = setTimeout(() => finish(null), LATENCY_PROBE_TIMEOUT_MS);
    conn.exec("true", (error, stream) => {
      if (error) {
        finish(null);
        return;
      }
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
      finish(Math.max(0, Math.round(elapsed)));
      stream.on("error", () => {});
      stream.end();
    });
  };

  const firstAvailableClient = () => (
    Array.from(clients).find((client) => (
      client.kind === "terminal" && !client.closed
    ))
  );

  const waitForPromptClient = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const client = firstAvailableClient();
      if (client) return client;
      await sleep(100);
    }
    return null;
  };

  const finishActivePrompt = (answer) => {
    if (!activePrompt) return;
    const resolve = activePrompt.resolve;
    activePrompt = null;
    resolve(answer);
  };

  const finishActiveHostKeyPrompt = (accepted) => {
    if (!activeHostKeyPrompt) return;
    const prompt = activeHostKeyPrompt;
    activeHostKeyPrompt = null;
    clearTimeout(prompt.timer);
    prompt.resolve(Boolean(accepted));
  };

  const requestHostKeyConfirmation = async (detail) => {
    const client = await waitForPromptClient();
    if (!client) {
      throw new Error("Timed out waiting for terminal host key confirmation.");
    }
    const promptID = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        finishActiveHostKeyPrompt(false);
      }, 120000);
      activeHostKeyPrompt = {
        client,
        promptID,
        timer,
        resolve,
      };
      writeFrame(client.socket, {
        type: "hostKeyPrompt",
        promptID,
        detail,
      });
    });
  };

  const handlePromptInput = (client, chunk) => {
    if (!activePrompt || activePrompt.client !== client) {
      return false;
    }
    activePrompt.buffer = Buffer.concat([activePrompt.buffer, chunk]);
    const newline = activePrompt.buffer.indexOf(10);
    const carriage = activePrompt.buffer.indexOf(13);
    const end = [newline, carriage]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];
    if (end === undefined) {
      return true;
    }
    finishActivePrompt(activePrompt.buffer.subarray(0, end).toString("utf8"));
    return true;
  };

  const readChallengeLine = async (prompt) => {
    const client = await waitForPromptClient();
    if (!client) return "";
    writeLogFrame(client.socket, "auth", prompt);
    return new Promise((resolve) => {
      activePrompt = {
        client,
        buffer: Buffer.alloc(0),
        resolve,
      };
    });
  };

  const execRemoteText = (command, timeoutMS = 5000) => new Promise((resolve, reject) => {
    let settled = false;
    let stream = null;
    let stdout = "";
    let stderr = "";
    const finish = (error, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        stream?.close?.();
      } catch {}
      finish(new Error("Timed out resolving remote working directory."));
    }, timeoutMS);
    conn.exec(command, (error, remoteStream) => {
      if (error) {
        finish(error);
        return;
      }
      stream = remoteStream;
      stream.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("close", (code) => {
        if (code === 0) {
          finish(null, stdout);
        } else {
          finish(new Error(stderr.trim() || `Remote cwd command exited with ${code}.`));
        }
      });
      stream.on("error", finish);
    });
  });

  const execRemoteCommand = (
    command,
    timeoutMS = 15000,
    options = {},
  ) => new Promise((resolve, reject) => {
    let settled = false;
    let stream = null;
    let stdout = "";
    let stderr = "";
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        stream?.close?.();
      } catch {}
      finish(new Error("Remote command timed out."));
    }, Math.max(1000, Number(timeoutMS) || 15000));
    conn.exec(
      String(command || ""),
      { pty: !!options.pty },
      (error, remoteStream) => {
      if (error) {
        finish(error);
        return;
      }
      stream = remoteStream;
      stream.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 8 * 1024 * 1024) {
          try { stream.close?.(); } catch {}
          finish(new Error("Remote command output exceeded 8MB."));
        }
      });
      stream.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 2 * 1024 * 1024) {
          try { stream.close?.(); } catch {}
          finish(new Error("Remote command error output exceeded 2MB."));
        }
      });
      stream.on("close", (code, signal) => {
        finish(null, {
          stdout,
          stderr,
          code: typeof code === "number" ? code : null,
          signal: signal || null,
        });
      });
      stream.on("error", finish);
      if (options.stdin != null) {
        setTimeout(() => {
          if (!settled) {
            if (options.closeStdin) stream.end(String(options.stdin));
            else stream.write(String(options.stdin));
          }
        }, 50);
      }
    });
  });

  const elevationReadyMarker = "__TP_ROOT_READY__";

  const normalizeRemoteOutput = (value) => String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const elevatedCommandResult = (result) => {
    const stdout = normalizeRemoteOutput(result.stdout);
    const markerIndex = stdout.indexOf(elevationReadyMarker);
    if (markerIndex < 0) return null;
    return {
      ...result,
      stdout: stdout.slice(
        markerIndex + elevationReadyMarker.length,
      ),
      stderr: normalizeRemoteOutput(result.stderr)
        .replaceAll("__TP_SUDO_PASSWORD__", "")
        .replace(/^\s*(?:Password|密码|口令)\s*[:：]?\s*$/gim, ""),
    };
  };

  const execElevatedRemoteCommand = async (
    command,
    password,
    elevationMethod,
    timeoutMS = 15000,
  ) => {
    const method = elevationMethod === "su" ? "su" : "sudo";
    const payload = [
      `printf %s ${shellQuote(elevationReadyMarker)}`,
      `exec sh -c ${shellQuote(String(command || ""))}`,
    ].join("; ");
    const passwordInput = `${password || ""}\n`;
    let result = null;
    let resultError = null;
    try {
      if (method === "su") {
        result = await execRemoteCommand(
          `su - root -c ${shellQuote(payload)}`,
          timeoutMS,
          { stdin: passwordInput, pty: true, closeStdin: true },
        );
      } else {
        result = await execRemoteCommand(
          `sudo -H -S -p '__TP_SUDO_PASSWORD__' sh -c ${shellQuote(payload)}`,
          timeoutMS,
          { stdin: passwordInput, closeStdin: true },
        );
      }
    } catch (error) {
      resultError = error;
    }
    const elevatedResult = result
      ? elevatedCommandResult(result)
      : null;
    if (elevatedResult) return elevatedResult;

    const detail = [
      resultError?.message,
      result?.stderr,
      result?.stdout,
    ].map((value) => String(value || "").trim()).filter(Boolean).join("\n");
    throw new Error(
      detail || `Unable to obtain root privileges with ${method}.`,
    );
  };

  const persistentElevationIdleTimeoutMS = 60_000;
  const elevationPasswordPromptPattern =
    /__TP_SUDO_PASSWORD__|password|passwort|mot de passe|contraseña|senha|密码|口令/i;

  const destroyPersistentElevationSession = (
    client,
    error = null,
  ) => {
    const session = client.persistentElevationSession;
    if (!session || session.destroyed) return;
    session.destroyed = true;
    client.persistentElevationSession = null;
    clearTimeout(session.openTimer);
    clearTimeout(session.idleTimer);
    if (session.active?.timer) {
      clearTimeout(session.active.timer);
    }
    const finalError = error
      || new Error("Persistent root session closed.");
    if (!session.ready && session.readyReject) {
      session.readyReject(finalError);
    }
    if (session.active) {
      session.active.reject(finalError);
      session.active = null;
    }
    for (const item of session.queue.splice(0)) {
      item.reject(finalError);
    }
    try {
      session.stream?.close?.();
    } catch {}
  };

  const schedulePersistentElevationIdleClose = (client) => {
    const session = client.persistentElevationSession;
    if (
      !session
      || session.destroyed
      || session.active
      || session.queue.length > 0
    ) {
      return;
    }
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      destroyPersistentElevationSession(client);
    }, persistentElevationIdleTimeoutMS);
  };

  const pumpPersistentElevationQueue = (client) => {
    const session = client.persistentElevationSession;
    if (
      !session
      || session.destroyed
      || !session.ready
      || session.active
    ) {
      return;
    }
    const item = session.queue.shift();
    if (!item) {
      schedulePersistentElevationIdleClose(client);
      return;
    }
    clearTimeout(session.idleTimer);
    const token = crypto.randomBytes(16).toString("hex");
    const beginMarker = `__TP_BEGIN_${token}__`;
    const endPrefix = `__TP_END_${token}_`;
    const endSuffix = "__";
    const envelope = [
      `printf %s ${shellQuote(beginMarker)}`,
      `( sh -c ${shellQuote(String(item.command || ""))} )`,
      "__tp_status=$?",
      `printf ${shellQuote(`${endPrefix}%s${endSuffix}`)} "$__tp_status"`,
    ].join("; ");
    session.active = {
      ...item,
      beginMarker,
      endPrefix,
      endSuffix,
      buffer: "",
      started: false,
      timer: setTimeout(() => {
        destroyPersistentElevationSession(
          client,
          new Error("Persistent root command timed out."),
        );
      }, Math.max(1000, Number(item.timeoutMS) || 15000)),
    };
    try {
      session.stream.write(`${envelope}\n`);
    } catch (error) {
      destroyPersistentElevationSession(client, error);
    }
  };

  const finishPersistentElevationCommand = (
    client,
    active,
    output,
    code,
  ) => {
    const session = client.persistentElevationSession;
    if (!session || session.destroyed || session.active !== active) {
      return;
    }
    clearTimeout(active.timer);
    session.active = null;
    active.resolve({
      stdout: output,
      stderr: "",
      code,
      signal: null,
    });
    pumpPersistentElevationQueue(client);
  };

  const handlePersistentElevationOutput = (
    client,
    session,
    chunk,
  ) => {
    if (session.destroyed) return;
    const text = normalizeRemoteOutput(chunk.toString("utf8"));
    if (!session.ready) {
      session.handshakeBuffer += text;
      const markerIndex = session.handshakeBuffer.indexOf(
        session.readyMarker,
      );
      if (markerIndex >= 0) {
        const remainder = session.handshakeBuffer.slice(
          markerIndex + session.readyMarker.length,
        );
        session.handshakeBuffer = "";
        session.ready = true;
        clearTimeout(session.openTimer);
        const resolve = session.readyResolve;
        session.readyResolve = null;
        session.readyReject = null;
        resolve?.(session);
        if (remainder) {
          handlePersistentElevationOutput(
            client,
            session,
            Buffer.from(remainder),
          );
        }
        pumpPersistentElevationQueue(client);
        return;
      }
      if (elevationPasswordPromptPattern.test(session.handshakeBuffer)) {
        if (session.passwordSent) {
          destroyPersistentElevationSession(
            client,
            new Error(
              `Persistent root authentication with ${session.method} failed.`,
            ),
          );
          return;
        }
        session.passwordSent = true;
        session.handshakeBuffer = "";
        try {
          session.stream.write(
            `${client.elevationPassword || ""}\n`,
          );
        } catch (error) {
          destroyPersistentElevationSession(client, error);
        }
        return;
      }
      if (session.handshakeBuffer.length > 4096) {
        session.handshakeBuffer =
          session.handshakeBuffer.slice(-4096);
      }
      return;
    }

    const active = session.active;
    if (!active) return;
    active.buffer += text;
    if (active.buffer.length > 8 * 1024 * 1024) {
      destroyPersistentElevationSession(
        client,
        new Error("Persistent root command output exceeded 8MB."),
      );
      return;
    }
    if (!active.started) {
      const beginIndex = active.buffer.indexOf(active.beginMarker);
      if (beginIndex < 0) {
        if (active.buffer.length > active.beginMarker.length * 2) {
          active.buffer = active.buffer.slice(
            -active.beginMarker.length,
          );
        }
        return;
      }
      active.started = true;
      active.buffer = active.buffer.slice(
        beginIndex + active.beginMarker.length,
      );
    }

    const endIndex = active.buffer.indexOf(active.endPrefix);
    if (endIndex < 0) return;
    const statusStart = endIndex + active.endPrefix.length;
    const suffixIndex = active.buffer.indexOf(
      active.endSuffix,
      statusStart,
    );
    if (suffixIndex < 0) return;
    const statusText = active.buffer.slice(statusStart, suffixIndex);
    if (!/^-?\d+$/.test(statusText)) return;
    finishPersistentElevationCommand(
      client,
      active,
      active.buffer.slice(0, endIndex),
      Number(statusText),
    );
  };

  const ensurePersistentElevationSession = async (client) => {
    const existing = client.persistentElevationSession;
    if (existing && !existing.destroyed) {
      clearTimeout(existing.idleTimer);
      return existing.ready ? existing : existing.readyPromise;
    }

    const method = client.elevationMethod === "su" ? "su" : "sudo";
    const readyMarker = `__TP_ROOT_SESSION_${crypto
      .randomBytes(16)
      .toString("hex")}__`;
    const payload = [
      "stty -echo 2>/dev/null || true",
      `printf %s ${shellQuote(readyMarker)}`,
      "exec sh -s",
    ].join("; ");
    const remoteCommand = method === "su"
      ? `su - root -c ${shellQuote(payload)}`
      : `sudo -H -S -p '__TP_SUDO_PASSWORD__' sh -c ${shellQuote(payload)}`;
    const session = {
      method,
      readyMarker,
      ready: false,
      destroyed: false,
      passwordSent: false,
      handshakeBuffer: "",
      stream: null,
      queue: [],
      active: null,
      idleTimer: null,
      openTimer: null,
      readyResolve: null,
      readyReject: null,
      readyPromise: null,
    };
    session.readyPromise = new Promise((resolve, reject) => {
      session.readyResolve = resolve;
      session.readyReject = reject;
    });
    client.persistentElevationSession = session;
    session.openTimer = setTimeout(() => {
      destroyPersistentElevationSession(
        client,
        new Error("Persistent root session timed out."),
      );
    }, 15_000);

    conn.exec(remoteCommand, { pty: true }, (error, stream) => {
      if (error) {
        destroyPersistentElevationSession(client, error);
        return;
      }
      if (session.destroyed) {
        try {
          stream.close?.();
        } catch {}
        return;
      }
      session.stream = stream;
      stream.on("data", (chunk) => {
        handlePersistentElevationOutput(client, session, chunk);
      });
      stream.stderr?.on("data", (chunk) => {
        handlePersistentElevationOutput(client, session, chunk);
      });
      stream.on("error", (streamError) => {
        destroyPersistentElevationSession(client, streamError);
      });
      stream.on("close", () => {
        destroyPersistentElevationSession(
          client,
          new Error("Persistent root session closed."),
        );
      });
    });

    return session.readyPromise;
  };

  const execPersistentElevatedRemoteCommand = async (
    client,
    request,
  ) => {
    const session = await ensurePersistentElevationSession(client);
    return new Promise((resolve, reject) => {
      if (session.queue.length >= 32) {
        reject(new Error("Persistent root command queue is full."));
        return;
      }
      session.queue.push({
        id: request.id,
        command: request.command || "",
        timeoutMS: request.timeoutMS || 15000,
        resolve,
        reject,
      });
      pumpPersistentElevationQueue(client);
    });
  };

  const cancelPersistentElevationRequest = (client, requestID) => {
    const session = client.persistentElevationSession;
    if (!session || session.destroyed) return false;
    const queuedIndex = session.queue.findIndex(
      (item) => item.id === requestID,
    );
    if (queuedIndex >= 0) {
      const [item] = session.queue.splice(queuedIndex, 1);
      item.reject(new Error("Persistent root command cancelled."));
      return true;
    }
    if (session.active?.id === requestID) {
      destroyPersistentElevationSession(
        client,
        new Error("Persistent root command cancelled."),
      );
      return true;
    }
    return false;
  };

  const publishClientCurrentDirectory = (client, directory) => {
    const trimmed = String(directory || "").trim();
    if (!trimmed || client.closed || client.kind !== "terminal") return null;
    if (client.currentDirectory === trimmed) return trimmed;
    if (client.currentDirectory) {
      client.previousDirectory = client.currentDirectory;
    }
    client.currentDirectory = trimmed;
    client.homeDirectory ||= trimmed;
    writeFrame(client.socket, {
      type: "cwd",
      directory: trimmed,
    });
    return trimmed;
  };

  const publishClientCurrentUser = (client, username) => {
    const trimmed = String(username || "").trim();
    if (!trimmed || client.closed || client.kind !== "terminal") return null;
    if (client.currentUser === trimmed) return trimmed;
    client.currentUser = trimmed;
    writeFrame(client.socket, {
      type: "user",
      username: trimmed,
    });
    return trimmed;
  };

  const refreshClientCurrentDirectory = async (client) => {
    const output = await execRemoteText("pwd -P");
    return publishClientCurrentDirectory(client, output.split(/\r?\n/)[0]);
  };

  const resolveClientDirectory = async (client, target) => {
    let candidate = target;
    if (target === "-") {
      candidate = client.previousDirectory;
    } else if (target === "~") {
      candidate = client.homeDirectory || client.currentDirectory;
    } else if (target.startsWith("~/")) {
      const home = client.homeDirectory || client.currentDirectory;
      candidate = home ? path.posix.join(home, target.slice(2)) : target;
    } else if (!target.startsWith("/")) {
      candidate = path.posix.join(client.currentDirectory || client.homeDirectory || ".", target);
    }
    if (!candidate) return;
    const command = `cd ${shellQuote(candidate)} 2>/dev/null && pwd -P`;
    const output = await execRemoteText(command);
    return publishClientCurrentDirectory(client, output.split(/\r?\n/)[0]);
  };

  const expandPromptDirectory = (client, promptDirectory) => {
    if (!promptDirectory) return null;
    if (promptDirectory === "~") {
      return client.homeDirectory || client.currentDirectory;
    }
    if (promptDirectory.startsWith("~/")) {
      const home = client.homeDirectory || client.currentDirectory;
      return home ? path.posix.join(home, promptDirectory.slice(2)) : null;
    }
    return promptDirectory.startsWith("/") ? promptDirectory : null;
  };

  const observeTerminalOutput = (client, chunk) => {
    const text = chunk.toString("utf8");
    const oscPattern = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    for (const match of text.matchAll(oscPattern)) {
      try {
        const url = new URL(match[1]);
        if (url.protocol === "file:" && url.pathname) {
          publishClientCurrentDirectory(client, decodeURIComponent(url.pathname));
        }
      } catch {
        // Ignore malformed OSC 7 payloads from remote prompts.
      }
    }

    client.outputBuffer = `${client.outputBuffer || ""}${text}`.slice(-4096);
    const cleaned = stripTerminalSequences(client.outputBuffer);
    const tail = cleaned.split(/\r?\n/).pop() || "";
    const prompt = tail.match(/([^\s@:\r\n]+)@[^:\r\n]+:(~(?:\/[^\r\n#$]*)?|\/[^\r\n#$]*)\s?[#$]\s?$/);
    publishClientCurrentUser(client, prompt?.[1]);
    const directory = expandPromptDirectory(client, prompt?.[2]);
    if (directory) {
      publishClientCurrentDirectory(client, directory);
    }
  };

  const terminalClientForSftpClient = (
    sftpClient,
    sourceSessionID = null,
  ) => {
    const targetSessionID = sourceSessionID || sftpClient.sourceSessionID;
    if (targetSessionID) {
      const match = Array.from(clients).find((client) => (
        client.kind === "terminal"
        && !client.closed
        && client.sessionID === targetSessionID
      ));
      if (match) return match;
      if (sourceSessionID) return null;
    }
    return firstAvailableClient();
  };

  const currentDirectoryForSftpClient = async (
    sftpClient,
    sourceSessionID = null,
  ) => {
    const terminalClient = terminalClientForSftpClient(
      sftpClient,
      sourceSessionID,
    );
    if (!terminalClient) {
      throw new Error("Source terminal session is not available.");
    }
    if (terminalClient.currentDirectory) {
      return await resolveClientDirectory(
        terminalClient,
        terminalClient.currentDirectory
      ) || terminalClient.currentDirectory;
    }
    return await refreshClientCurrentDirectory(terminalClient)
      || terminalClient.currentDirectory;
  };

  const handleTerminalCommandLine = (client, line) => {
    const target = parseCdTarget(line);
    if (target == null) return;
    void resolveClientDirectory(client, target).catch(() => {
      // The interactive shell will surface invalid cd errors; keep the last known cwd.
    });
  };

  const observeTerminalInput = (client, chunk) => {
    for (const byte of chunk) {
      if (byte === 3) {
        client.inputLine = "";
        continue;
      }
      if (byte === 13 || byte === 10) {
        const line = client.inputLine || "";
        client.inputLine = "";
        handleTerminalCommandLine(client, line);
        continue;
      }
      if (byte === 8 || byte === 127) {
        client.inputLine = (client.inputLine || "").slice(0, -1);
        continue;
      }
      if (byte === 27) {
        client.inputLine = "";
        continue;
      }
      if (byte >= 32 && byte !== 127) {
        client.inputLine = `${client.inputLine || ""}${String.fromCharCode(byte)}`;
        if (client.inputLine.length > 4096) {
          client.inputLine = "";
        }
      }
    }
  };

  const openShellForClient = (client) => {
    if (!ready || client.closed || client.stream || client.opening) return;
    client.opening = true;
    writeLogFrame(client.socket, "shell", "Opening interactive shell channel");
    conn.shell(
      {
        term: "xterm-256color",
        cols: client.cols,
        rows: client.rows,
      },
      {
        env: {
          COLORTERM: "truecolor",
          TERM_PROGRAM: "TermPilot",
        },
      },
      (error, stream) => {
        client.opening = false;
        if (client.closed) {
          try {
            stream?.close?.();
          } catch {}
          return;
        }
        if (error) {
          writeLogFrame(client.socket, "error", "Failed to open shell channel", {
            error: error.message,
          });
          writeFrame(client.socket, {
            type: "exit",
            code: 1,
          });
          client.socket.end();
          return;
        }

        client.stream = stream;
        writeLogFrame(client.socket, "connected", "Interactive shell channel established");
        void refreshClientCurrentDirectory(client).catch(() => {
          // Some restricted shells disallow exec channels; cwd tracking then waits for OSC 7.
        });
        for (const chunk of client.queuedInput.splice(0)) {
          stream.write(chunk);
        }

        stream.on("data", (chunk) => {
          observeTerminalOutput(client, chunk);
          writeFrame(client.socket, {
            type: "data",
            data: Buffer.from(chunk).toString("base64"),
          });
        });
        stream.stderr?.on("data", (chunk) => {
          writeFrame(client.socket, {
            type: "data",
            data: Buffer.from(chunk).toString("base64"),
          });
        });
        stream.on("close", (code, signal) => {
          writeLogFrame(client.socket, "exit", "Shell channel closed", {
            code,
            signal,
          });
          writeFrame(client.socket, {
            type: "exit",
            code: typeof code === "number" ? code : 0,
          });
          client.socket.end();
          closeBrokerClient(client, { closesSocket: false });
        });
      }
    );
  };

  const sftpWriteMessage = (client) => (message) => {
    writeFrame(client.socket, {
      type: "sftpResponse",
      message,
    });
  };

  const failSftpRequest = (client, id, error) => {
    sftpWriteMessage(client)({
      id,
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  };

  const openSftpForClient = async (client, sftpConfig) => {
    client.kind = "sftp";
    client.sourceSessionID = sftpConfig?.sourceSessionID || null;
    if (!ready) {
      writeFrame(client.socket, {
        type: "error",
        message: "Source terminal SSH connection is not ready for SFTP reuse.",
      });
      return;
    }

    try {
      const sftpBridge = loadSftpBridgeModule(sftpConfig?.sftpBridgeScript);
      client.sftpSession = await sftpBridge.openSessionBackedSftp(
        conn,
        sftpConfig || {},
      );
      writeFrame(client.socket, {
        type: "sftpReady",
        mode: client.sftpSession.mode,
      });
      logAll("sftp", "Reused terminal SSH connection for SFTP side panel", {
        fileProtocol: client.sftpSession.mode,
      });
    } catch (error) {
      writeFrame(client.socket, {
        type: "error",
        message: error && error.message ? error.message : String(error),
      });
    }
  };

  const handleSftpRequest = async (client, request) => {
    if (request?.action === "close") {
      destroyPersistentElevationSession(client);
      sftpWriteMessage(client)({
        id: request.id,
        ok: true,
        result: {},
      });
      closeBrokerClient(client);
      return;
    }

    if (request?.action === "cancel" && client.persistentElevation) {
      cancelPersistentElevationRequest(client, request.targetID);
      sftpWriteMessage(client)({
        id: request.id,
        ok: true,
        result: {},
      });
      return;
    }

    if (request?.action === "exec") {
      try {
        const result = request.elevated
          ? client.persistentElevation
            ? await execPersistentElevatedRemoteCommand(client, request)
            : await execElevatedRemoteCommand(
              request.command || "",
              client.elevationPassword,
              client.elevationMethod,
              request.timeoutMS || 15000,
            )
          : await execRemoteCommand(
            request.command || "",
            request.timeoutMS || 15000,
          );
        sftpWriteMessage(client)({
          id: request.id,
          ok: true,
          result,
        });
      } catch (error) {
        failSftpRequest(client, request?.id, error);
      }
      return;
    }

    if (request?.action === "terminalCWD") {
      try {
        const directory = await currentDirectoryForSftpClient(
          client,
          request.sourceSessionID,
        );
        sftpWriteMessage(client)({
          id: request.id,
          ok: true,
          result: { path: directory },
        });
      } catch (error) {
        failSftpRequest(client, request?.id, error);
      }
      return;
    }

    const session = client.sftpSession;
    if (!session) {
      failSftpRequest(
        client,
        request?.id,
        "SFTP has not been opened on this terminal SSH connection.",
      );
      return;
    }

    try {
      const sftpBridge = loadSftpBridgeModule();
      if (session.mode === "scp") {
        await sftpBridge.handleScpCommand({
          conn,
          backend: session.scpBackend,
          config: session.config,
          activeTransfers: session.activeTransfers,
          request,
          writeMessage: sftpWriteMessage(client),
          closesConnection: false,
        });
      } else {
        await sftpBridge.handleCommand({
          conn,
          sftp: session.sftp,
          config: session.config,
          activeTransfers: session.activeTransfers,
          request,
          writeMessage: sftpWriteMessage(client),
          closesConnection: false,
        });
      }
    } catch (error) {
      failSftpRequest(client, request?.id, error);
    }
  };

  const handleClientFrame = (client, frame) => {
    switch (frame.type) {
    case "open":
      client.kind = "terminal";
      client.cols = frame.cols || 80;
      client.rows = frame.rows || 24;
      client.sessionID = frame.sessionID || null;
      client.opened = true;
      if (ready) {
        openShellForClient(client);
        if (lastLatencyMilliseconds != null) {
          writeLogFrame(
            client.socket,
            "latency",
            String(lastLatencyMilliseconds),
          );
        }
      } else {
        pendingClients.add(client);
        writeLogFrame(client.socket, "broker", "Waiting for shared SSH connection");
      }
      break;
    case "data": {
      const chunk = Buffer.from(frame.data || "", "base64");
      if (handlePromptInput(client, chunk)) {
        break;
      }
      observeTerminalInput(client, chunk);
      if (client.stream) {
        client.stream.write(chunk);
      } else {
        client.queuedInput.push(chunk);
      }
      break;
    }
    case "hostKeyResponse":
      if (
        activeHostKeyPrompt
        && activeHostKeyPrompt.client === client
        && activeHostKeyPrompt.promptID === frame.promptID
      ) {
        finishActiveHostKeyPrompt(Boolean(frame.accepted));
      }
      break;
    case "resize":
      client.cols = frame.cols || client.cols;
      client.rows = frame.rows || client.rows;
      try {
        client.stream?.setWindow?.(client.rows, client.cols, 0, 0);
      } catch {
        // Resize is best effort.
      }
      break;
    case "close":
      closeBrokerClient(client);
      break;
    case "sftpOpen":
      openSftpForClient(client, frame.config);
      break;
    case "execOpen":
      client.kind = "exec";
      client.sourceSessionID = frame.config?.sourceSessionID || null;
      client.elevationPassword = frame.config?.elevationPassword || null;
      client.elevationMethod =
        frame.config?.elevationMethod === "su" ? "su" : "sudo";
      client.persistentElevation =
        !!frame.config?.persistentElevation;
      if (!ready) {
        writeFrame(client.socket, {
          type: "error",
          message: "Source terminal SSH connection is not ready for exec reuse.",
        });
      } else {
        writeFrame(client.socket, {
          type: "execReady",
          mode: "exec",
        });
      }
      break;
    case "sftpRequest": {
      const action = frame.request?.action;
      if (
        action === "pause"
        || action === "resume"
        || action === "cancel"
        || action === "terminalCWD"
        || action === "exec"
      ) {
        void handleSftpRequest(client, frame.request).catch((error) => {
          failSftpRequest(client, frame.request?.id, error);
        });
      } else {
        client.sftpQueue = client.sftpQueue
          .then(() => handleSftpRequest(client, frame.request))
          .catch((error) => {
            failSftpRequest(client, frame.request?.id, error);
          });
      }
      break;
    }
    default:
      break;
    }
  };

  function closeBrokerClient(client, options = {}) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    pendingClients.delete(client);
    destroyPersistentElevationSession(client);
    const sftpSession = client.sftpSession;
    client.sftpSession = null;
    if (sftpSession) {
      for (const transfer of sftpSession.activeTransfers?.values?.() || []) {
        transfer.cancelled = true;
        transfer.paused = false;
        for (const resolve of transfer.pauseWaiters?.splice?.(0) || []) {
          resolve();
        }
        transfer.scpTransfer?.abort?.();
        transfer.readStream?.destroy?.(new Error("SFTP session closed."));
        transfer.writeStream?.destroy?.(new Error("SFTP session closed."));
      }
      try {
        sftpSession.sftp?.end?.();
      } catch {}
    }
    try {
      client.stream?.close?.();
    } catch {}
    if (activePrompt?.client === client) {
      finishActivePrompt("");
    }
    if (activeHostKeyPrompt?.client === client) {
      finishActiveHostKeyPrompt(false);
    }
    if (options.closesSocket !== false) {
      try {
        client.socket.end();
      } catch {}
    }
    scheduleIdleExit();
  }

  const server = net.createServer((socket) => {
    cancelIdleExit();
    const client = {
      kind: "unknown",
      socket,
      sessionID: null,
      sourceSessionID: null,
      elevationPassword: null,
      elevationMethod: "sudo",
      persistentElevation: false,
      persistentElevationSession: null,
      sftpSession: null,
      sftpQueue: Promise.resolve(),
      stream: null,
      queuedInput: [],
      inputLine: "",
      outputBuffer: "",
      currentDirectory: null,
      previousDirectory: null,
      homeDirectory: null,
      currentUser: null,
      cols: 80,
      rows: 24,
      opened: false,
      opening: false,
      closed: false,
    };
    clients.add(client);

    socket.on("data", createFrameReader(
      (frame) => handleClientFrame(client, frame),
      (error) => {
        writeLogFrame(socket, "error", "Invalid client frame", {
          error: error.message,
        });
      }
    ));
    socket.on("close", () => {
      closeBrokerClient(client, { closesSocket: false });
    });
    socket.on("error", () => {
      closeBrokerClient(client, { closesSocket: false });
    });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      process.exit(0);
    }
    process.exit(1);
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // Best effort on file systems that do not support chmod.
    }
  });

  conn.on("banner", (message) => {
    const text = String(message || "").trim();
    if (text) logAll("banner", text);
  });

  conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
    logAll("auth", "Keyboard-interactive challenge received", {
      prompts: prompts.length,
    });
    (async () => {
      const answers = [];
      for (const item of prompts) {
        if (config.password && isPasswordPrompt(item.prompt)) {
          answers.push(config.password);
        } else {
          answers.push(await readChallengeLine(item.prompt || "SSH challenge:"));
        }
      }
      finish(answers);
    })().catch((error) => {
      logAll("error", "Keyboard-interactive challenge failed", {
        error: error.message,
      });
      finish([]);
    });
  });

  conn.on("ready", () => {
    ready = true;
    logAll("auth", "Authentication completed");
    logAll("remote-version", String(conn._remoteVer || ""));
    for (const client of Array.from(pendingClients)) {
      pendingClients.delete(client);
      openShellForClient(client);
    }
    latencyTimer = setInterval(probeLatency, LATENCY_PROBE_INTERVAL_MS);
    setTimeout(probeLatency, 500);
  });

  conn.on("error", (error) => {
    logAll("error", "SSH connection error", {
      error: error.message,
      code: error.code,
      level: error.level,
    });
    for (const client of Array.from(clients)) {
      writeFrame(client.socket, {
        type: "exit",
        code: 1,
      });
    }
    shutdown(1);
  });

  conn.on("close", () => {
    if (!shuttingDown) {
      logAll(
        "exit",
        ready
          ? "Shared SSH transport closed"
          : "SSH transport closed before shell was established"
      );
      for (const client of Array.from(clients)) {
        writeFrame(client.socket, {
          type: "exit",
          code: 1,
        });
      }
      shutdown(1);
    }
  });

  process.on("SIGTERM", () => {
    logAll("exit", "Shared SSH broker terminated");
    shutdown(143);
  });

  const connectOptions = {
    host: config.hostname,
    port: config.port || 22,
    username: config.username || "root",
    tryKeyboard: true,
    readyTimeout: 0,
    timeout: 20000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
    debug: (message) => {
      if (/auth|publickey|keyboard|handshake|kex|newkeys|dh gex/i.test(message)) {
        logAll("debug", message);
      }
    },
  };

  if (config.knownHostsFile) {
    connectOptions.hostVerifier = (key, callback) => {
      verifyKnownHost(config, key, ssh2, requestHostKeyConfirmation)
        .then((result) => {
          if (!result.accepted) {
            logAll("known-host", "SSH host key rejected by user", {
              host: result.hostPattern,
              algorithm: result.algorithm,
              fingerprint: result.fingerprint,
            });
            callback(false);
            return;
          }
          logAll(
            "known-host",
            result.known
              ? "SSH host key already trusted"
              : result.added
                ? "Recorded SSH host key"
                : "SSH host key already recorded",
            {
              host: result.hostPattern,
              algorithm: result.algorithm,
              fingerprint: result.fingerprint,
            }
          );
          callback(true);
        })
        .catch((error) => {
          logAll("known-host", "Failed to verify SSH host key", {
            error: error.message,
          });
          callback(false);
        });
    };
  }

  if (config.authentication === "password" && config.password) {
    connectOptions.password = config.password;
  } else if (config.authentication === "identityFile") {
    if (config.privateKey) {
      logAll("auth", "Using saved private key credential");
      connectOptions.privateKey = config.privateKey;
    } else if (config.identityFile) {
      logAll("auth", "Loading identity file", {
        identityFile: config.identityFile,
      });
      connectOptions.privateKey = fs.readFileSync(config.identityFile, "utf8");
    }
    if (config.passphrase) {
      connectOptions.passphrase = config.passphrase;
    }
    if (config.certificate) {
      connectOptions.cert = config.certificate;
    }
  } else if (process.env.SSH_AUTH_SOCK) {
    logAll("auth", "Using SSH agent", {
      socket: process.env.SSH_AUTH_SOCK,
    });
    connectOptions.agent = process.env.SSH_AUTH_SOCK;
  }

  if (config.proxy) {
    logAll("proxy", "Connecting through configured proxy", {
      type: config.proxy.type,
      endpoint: config.proxy.type === "command"
        ? "ProxyCommand"
        : `${config.proxy.host}:${config.proxy.port}`,
    });
    connectOptions.sock = await createProxySocket(
      config.proxy,
      config.hostname,
      config.port || 22,
      { timeoutMs: 20_000 },
    );
    enableTcpNoDelay(connectOptions.sock);
    delete connectOptions.host;
    delete connectOptions.port;
  }

  conn.once("connect", () => {
    enableTcpNoDelay(conn);
  });
  conn.connect(connectOptions);
}

async function main() {
  const config = readConfig();
  if (process.env.TERMPILOT_SSH2_BRIDGE_SFTP_CLIENT === "1") {
    await runSftpBrokerClient(config);
    return;
  }

  terminalLog("init", "TermPilot ssh2 bridge starting", safeConnectSummary(config));

  let ssh2;
  try {
    const loaded = requireSsh2();
    ssh2 = loaded.module;
    terminalLog("init", "Loaded Node ssh2 module", {
      resolvedFrom: loaded.resolvedFrom,
    });
  } catch (error) {
    terminalLog(
      "error",
      "Unable to load ssh2. Install bridge dependencies or set TERMPILOT_SSH2_NODE_MODULES.",
      { error: error.message }
    );
    process.exit(127);
  }

  if (process.env.TERMPILOT_SSH2_BRIDGE_SMOKE_TEST === "1") {
    terminalLog("ready", "Bridge smoke test completed");
    return;
  }

  if (process.env[BROKER_ENV] === "1") {
    await runBroker(config, ssh2);
    return;
  }

  await runClient(config);
}

main().catch((error) => {
  if (process.env.TERMPILOT_SSH2_BRIDGE_SFTP_CLIENT === "1") {
    process.stdout.write(`${JSON.stringify({
      id: 0,
      ok: false,
      error: error && error.message ? error.message : String(error),
    })}\n`);
  } else {
    terminalLog("error", "Bridge startup failed", { error: error.message });
  }
  process.exit(1);
});
