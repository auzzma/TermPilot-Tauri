#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { TextDecoder } = require("node:util");
const {
  createScpBackend,
  createSshExecAdapters,
} = require("./scpBackend.cjs");
const proxyUtilsPath = fs.existsSync(
  path.resolve(__dirname, "../proxy-bridge/proxyUtils.cjs"),
)
  ? path.resolve(__dirname, "../proxy-bridge/proxyUtils.cjs")
  : path.resolve(__dirname, "proxyUtils.cjs");
const { createProxySocket } = require(proxyUtilsPath);

function readConfig() {
  const encoded = process.env.TERMPILOT_SFTP_BRIDGE_CONFIG_B64
    || process.env.TERMPILOT_SSH2_BRIDGE_CONFIG_B64;
  if (!encoded) {
    throw new Error("TERMPILOT_SFTP_BRIDGE_CONFIG_B64 is missing");
  }
  const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return {
    ...config,
    fileProtocol: config.fileProtocol || "auto",
    filenameEncoding: normalizeEncoding(config.filenameEncoding || "auto"),
    usesSudo: !!config.usesSudo,
    elevationMethod: config.elevationMethod === "su" ? "su" : "sudo",
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function execRemoteCommand(conn, command, timeoutMS = 15000, options = {}) {
  return new Promise((resolve, reject) => {
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
      try { stream?.close?.(); } catch {}
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
      },
    );
  });
}

async function executeRequestCommand(conn, config, request) {
  if (!request.elevated || config.username === "root") {
    return execRemoteCommand(
      conn,
      request.command || "",
      request.timeoutMS || 15000,
    );
  }
  const method = config.elevationMethod === "su" ? "su" : "sudo";
  const readyMarker = "__TP_ROOT_READY__";
  const payload = [
    `printf %s ${shellQuote(readyMarker)}`,
    `exec sh -c ${shellQuote(String(request.command || ""))}`,
  ].join("; ");
  const passwordInput = `${config.elevationPassword || config.password || ""}\n`;
  const result = method === "su"
    ? await execRemoteCommand(
      conn,
      `su - root -c ${shellQuote(payload)}`,
      request.timeoutMS || 15000,
      { stdin: passwordInput, pty: true, closeStdin: true },
    )
    : await execRemoteCommand(
      conn,
      `sudo -H -S -p '__TP_SUDO_PASSWORD__' sh -c ${shellQuote(payload)}`,
      request.timeoutMS || 15000,
      { stdin: passwordInput, closeStdin: true },
    );
  const markerIndex = String(result.stdout || "").indexOf(readyMarker);
  if (markerIndex < 0) {
    throw new Error(
      [result.stderr, result.stdout]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join("\n")
        || `Unable to obtain root privileges with ${method}.`,
    );
  }
  return {
    ...result,
    stdout: String(result.stdout || "").slice(
      markerIndex + readyMarker.length,
    ),
    stderr: String(result.stderr || "")
      .replaceAll("__TP_SUDO_PASSWORD__", "")
      .replace(/^\s*(?:Password|密码|口令)\s*[:：]?\s*$/gim, ""),
  };
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

function requireIconv() {
  const candidates = [
    process.env.TERMPILOT_SSH2_NODE_MODULES,
    path.resolve(__dirname, "node_modules"),
    path.resolve(process.cwd(), "node_modules"),
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      return require(path.join(base, "iconv-lite"));
    } catch {
      // Try the next bundled/runtime location.
    }
  }
  try {
    return require("iconv-lite");
  } catch {
    return null;
  }
}

const iconv = requireIconv();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_FILE_TRANSFER_CONCURRENCY = 2;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_IN_FLIGHT_CHUNKS = 32;
const ALLOWED_CHUNK_BYTES = new Set([
  256 * 1024,
  512 * 1024,
  1024 * 1024,
  5 * 1024 * 1024,
  10 * 1024 * 1024,
]);

function clampedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizedChunkBytes(value) {
  const parsed = Number(value);
  return ALLOWED_CHUNK_BYTES.has(parsed) ? parsed : DEFAULT_CHUNK_BYTES;
}

function createFileTransferLimiter() {
  let limit = DEFAULT_FILE_TRANSFER_CONCURRENCY;
  let active = 0;
  const waiters = [];

  const resumeWaiters = () => {
    while (active < limit && waiters.length > 0) {
      active += 1;
      waiters.shift()();
    }
  };

  return {
    setLimit(value) {
      limit = clampedInteger(
        value,
        1,
        16,
        DEFAULT_FILE_TRANSFER_CONCURRENCY,
      );
      resumeWaiters();
    },
    async run(operation) {
      if (active >= limit) {
        await new Promise((resolve) => waiters.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await operation();
      } finally {
        active = Math.max(0, active - 1);
        resumeWaiters();
      }
    },
  };
}

const fileTransferLimiter = createFileTransferLimiter();

async function waitForTransferOperations(operations) {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

function loadSFTPWrapper() {
  const candidates = [
    process.env.TERMPILOT_SSH2_NODE_MODULES
      ? path.join(process.env.TERMPILOT_SSH2_NODE_MODULES, "ssh2/lib/protocol/SFTP")
      : null,
    "ssh2/lib/protocol/SFTP",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      return mod.SFTP || mod;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, error, writeMessage = write) {
  writeMessage({
    id,
    ok: false,
    error: error && error.message ? error.message : String(error),
  });
}

function ok(id, result = {}, writeMessage = write) {
  writeMessage({
    id,
    ok: true,
    result,
  });
}

function normalizeEncoding(encoding) {
  const normalized = String(encoding || "auto").toLowerCase();
  if (normalized === "utf8") return "utf-8";
  if (normalized === "utf-8" || normalized === "gb18030") return normalized;
  return "auto";
}

function resolvedEncoding(config) {
  return config.filenameEncoding === "auto" ? "utf-8" : config.filenameEncoding;
}

function isAscii(value) {
  return typeof value === "string" && /^[\x00-\x7F]*$/.test(value);
}

function assertEncodingAvailable(encoding) {
  if (encoding !== "utf-8" && !iconv) {
    throw new Error(`Filename encoding ${encoding} requires bundled iconv-lite.`);
  }
}

function encodeRemotePath(config, value) {
  if (value === undefined || value === null) return value;
  if (Buffer.isBuffer(value)) return value;
  const encoding = resolvedEncoding(config);
  if (encoding === "utf-8" || isAscii(value)) return value;
  assertEncodingAvailable(encoding);
  return iconv.encode(value, encoding);
}

function decodeName(raw, fallback, encoding) {
  if (!raw) return fallback || "";
  if (!Buffer.isBuffer(raw)) return String(raw);
  if (encoding === "utf-8") return raw.toString("utf8");
  assertEncodingAvailable(encoding);
  return iconv.decode(raw, encoding);
}

function isValidUtf8(buffer) {
  if (!buffer) return true;
  try {
    utf8Decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function detectListEncoding(config, entries) {
  const requested = normalizeEncoding(config.filenameEncoding);
  if (requested !== "auto") return requested;
  for (const entry of entries) {
    const raw = entry.filenameRaw
      || (entry.filename ? Buffer.from(entry.filename, "utf8") : null);
    if (raw && !isValidUtf8(raw)) {
      return "gb18030";
    }
  }
  return "utf-8";
}

function modeKind(mode, stats) {
  if (stats?.isDirectory?.()) return "directory";
  if (stats?.isFile?.()) return "file";
  if (stats?.isSymbolicLink?.()) return "symbolicLink";
  if (typeof mode !== "number") return "other";
  const type = mode & 0o170000;
  if (type === 0o040000) return "directory";
  if (type === 0o100000) return "file";
  if (type === 0o120000) return "symbolicLink";
  return "other";
}

function entryFromStats(name, stats, linkTarget = null) {
  return {
    name,
    kind: modeKind(stats.mode, stats),
    linkTarget,
    size: typeof stats.size === "number" ? stats.size : null,
    permissions: typeof stats.mode === "number" ? stats.mode : null,
    modifiedAt: stats.mtime ? new Date(stats.mtime * 1000).toISOString() : null,
  };
}

function connectionOptions(config) {
  const options = {
    host: config.hostname,
    port: config.port || 22,
    username: config.username,
    readyTimeout: 30000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };

  if (config.authentication === "password") {
    options.password = config.password || "";
  } else if (config.authentication === "identityFile") {
    if (config.privateKey) {
      options.privateKey = config.privateKey;
    } else if (config.identityFile) {
      options.privateKey = fs.readFileSync(config.identityFile, "utf8");
    } else {
      throw new Error("Private key path is missing.");
    }
    if (config.passphrase || config.password) {
      options.passphrase = config.passphrase || config.password;
    }
    if (config.certificate) {
      options.cert = config.certificate;
    }
  } else {
    const agent = process.env.SSH_AUTH_SOCK;
    if (!agent) {
      throw new Error("SSH_AUTH_SOCK is not available for SSH Agent authentication.");
    }
    options.agent = agent;
  }

  return options;
}

function command(sftp, name, ...args) {
  return new Promise((resolve, reject) => {
    sftp[name](...args, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function runWindowedTransfer({
  state,
  totalBytes,
  chunkBytes,
  maxInFlightChunks,
  transferChunk,
  onProgress,
}) {
  const inFlight = new Set();
  let nextPosition = 0;
  let reachedEnd = false;

  async function enqueueNext() {
    await waitWhilePaused(state);
    if (reachedEnd) return false;
    if (totalBytes != null && nextPosition >= totalBytes) return false;

    const remaining = totalBytes == null
      ? chunkBytes
      : totalBytes - nextPosition;
    const length = Math.min(chunkBytes, remaining);
    const position = nextPosition;
    nextPosition += length;

    const promise = transferChunk(position, length)
      .then((result) => {
        checkCancelled(state);
        if (result?.stop) {
          reachedEnd = true;
        }
        const bytes = result?.bytes || 0;
        if (bytes > 0) {
          onProgress(bytes);
        }
      })
      .finally(() => {
        inFlight.delete(promise);
      });
    inFlight.add(promise);
    return true;
  }

  try {
    while (true) {
      while (inFlight.size < maxInFlightChunks) {
        const queued = await enqueueNext();
        if (!queued) break;
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }
  } finally {
    await Promise.allSettled(Array.from(inFlight));
  }
  checkCancelled(state);
}

function openRemoteFile(sftp, config, remotePath, flags) {
  return command(sftp, "open", encodeRemotePath(config, remotePath), flags);
}

function readRemoteFile(sftp, handle, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, offset, length, position, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(typeof bytesRead === "number" ? bytesRead : 0);
    });
  });
}

function writeRemoteFile(sftp, handle, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, offset, length, position, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeRemoteFile(sftp, handle) {
  if (handle == null) return;
  try {
    await command(sftp, "close", handle);
  } catch {
    // Closing a cancelled transfer handle is best effort.
  }
}

function probeSftpServerPath(conn, candidatePath) {
  return new Promise((resolve, reject) => {
    conn.exec(`test -x ${candidatePath}`, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      stream.on("exit", (code) => {
        if (code === 0) resolve(candidatePath);
        else reject(new Error("Not found"));
      });
      stream.on("error", reject);
    });
  });
}

async function findSftpServerPath(conn) {
  const candidates = [
    "/usr/lib/openssh/sftp-server",
    "/usr/libexec/openssh/sftp-server",
    "/usr/lib/ssh/sftp-server",
    "/usr/libexec/sftp-server",
    "/usr/local/libexec/sftp-server",
    "/usr/local/lib/sftp-server",
  ];
  for (const candidate of candidates) {
    try {
      return await probeSftpServerPath(conn, candidate);
    } catch {
      // Continue probing known locations.
    }
  }
  return "/usr/lib/openssh/sftp-server";
}

async function connectElevatedSftpUsing(conn, password, method) {
  const SFTPWrapper = loadSFTPWrapper();
  if (!SFTPWrapper) {
    throw new Error("Elevated SFTP is not available in the bundled ssh2 runtime.");
  }
  const serverPath = await findSftpServerPath(conn);
  return new Promise((resolve, reject) => {
    const prompt = method === "sudo" ? "SUDOPASSWORD:" : "Password:";
    const readyMarker = "SFTPREADY";
    const readyMarkerBuffer = Buffer.from(readyMarker);
    const payload = `printf ${readyMarker}; exec ${serverPath} -e`;
    const commandLine = method === "sudo"
      ? `sudo -H -S -p '${prompt}' sh -c '${payload}'`
      : `su - root -c '${payload}'`;

    conn.exec(commandLine, { pty: false }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let settled = false;
      let sftpInitialized = false;
      let sftpCreated = false;
      let sftp = null;
      let stdoutBuffer = Buffer.alloc(0);
      let stderrBuffer = "";
      let pendingAfterMarker = null;
      let passwordSent = false;

      const timeout = setTimeout(() => {
        finalize(new Error(`SFTP ${method} handshake timed out.`));
      }, 20000);

      function finalize(finalError, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stream.removeListener("data", onStdout);
        stream.stderr?.removeListener("data", onStderr);
        if (finalError) reject(finalError);
        else resolve(result);
      }

      function createSftp() {
        if (sftpCreated) return;
        sftpCreated = true;
        try {
          const chanInfo = {
            type: "sftp",
            incoming: stream.incoming,
            outgoing: stream.outgoing,
          };
          sftp = new SFTPWrapper(conn, chanInfo, {});
          if (conn._chanMgr && typeof stream.incoming?.id === "number") {
            conn._chanMgr.update(stream.incoming.id, sftp);
          }
          sftp.on("ready", () => {
            sftpInitialized = true;
            finalize(null, sftp);
          });
          sftp.on("error", (protocolError) => {
            if (!sftpInitialized) finalize(protocolError);
          });
          stream.on("end", () => {
            try { sftp.push(null); } catch {}
          });
        } catch (createError) {
          finalize(createError);
        }
      }

      function initSftp() {
        if (sftpInitialized) return;
        createSftp();
        try {
          sftp._init();
          if (pendingAfterMarker && pendingAfterMarker.length > 0) {
            sftp.push(pendingAfterMarker);
            pendingAfterMarker = null;
          }
        } catch (initError) {
          finalize(initError);
        }
      }

      function onStdout(data) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        stdoutBuffer = stdoutBuffer.length > 0
          ? Buffer.concat([stdoutBuffer, chunk])
          : chunk;
        const markerIndex = stdoutBuffer.indexOf(readyMarkerBuffer);
        if (markerIndex !== -1) {
          const afterMarker = markerIndex + readyMarkerBuffer.length;
          if (afterMarker < stdoutBuffer.length) {
            pendingAfterMarker = stdoutBuffer.subarray(afterMarker);
          }
          stream.removeListener("data", onStdout);
          stdoutBuffer = Buffer.alloc(0);
          setTimeout(initSftp, 1000);
        } else if (stdoutBuffer.length > 256) {
          stdoutBuffer = stdoutBuffer.subarray(stdoutBuffer.length - 256);
        }
      }

      function onStderr(data) {
        stderrBuffer += data.toString();
        const asksForPassword = method === "sudo"
          ? stderrBuffer.includes(prompt)
          : /(?:password|passwort|mot de passe|contraseña|senha|密码|口令)\s*[:：]?/i
              .test(stderrBuffer);
        if (asksForPassword && passwordSent) {
          try { stream.close?.(); } catch {}
          finalize(new Error(`SFTP ${method} rejected the configured password.`));
        } else if (asksForPassword) {
          passwordSent = true;
          stream.write(`${password || ""}\n`);
          stderrBuffer = "";
        } else if (stderrBuffer.length > 256) {
          stderrBuffer = stderrBuffer.slice(-256);
        }
      }

      stream.on("data", onStdout);
      stream.stderr?.on("data", onStderr);
      stream.on("error", finalize);
      stream.on("exit", (code) => {
        if (!sftpInitialized && code !== 0) {
          let message = `SFTP ${method} failed with exit code ${code}.`;
          if (code === 1) {
            message += " The password may be incorrect or sudo privileges are denied.";
          } else if (code === 127) {
            message += " sftp-server was not found on the remote system.";
          }
          finalize(new Error(message));
        }
      });
    });
  });
}

async function connectElevatedSftp(conn, password, elevationMethod) {
  const method = elevationMethod === "su" ? "su" : "sudo";
  return connectElevatedSftpUsing(conn, password, method);
}

function remoteJoin(base, name) {
  if (!base || base === ".") return name;
  if (base === "/") return `/${name}`;
  return `${String(base).replace(/\/+$/, "")}/${name}`;
}

function remoteParent(remotePath) {
  const parent = path.posix.dirname(remotePath);
  return parent && parent !== "." ? parent : ".";
}

function missingPathError(error) {
  return /No such file|No such file or directory|does not exist|not found/i
    .test(String(error && error.message ? error.message : error));
}

async function lstatRemote(sftp, config, remotePath) {
  const encoded = encodeRemotePath(config, remotePath);
  const method = typeof sftp.lstat === "function" ? "lstat" : "stat";
  return command(sftp, method, encoded);
}

async function statRemote(sftp, config, remotePath) {
  return command(sftp, "stat", encodeRemotePath(config, remotePath));
}

async function tryLstatRemote(sftp, config, remotePath) {
  try {
    return await lstatRemote(sftp, config, remotePath);
  } catch (error) {
    if (missingPathError(error)) return null;
    throw error;
  }
}

async function ensureRemoteDir(sftp, config, directoryPath) {
  if (!directoryPath || directoryPath === "." || directoryPath === "/") return;
  const absolute = directoryPath.startsWith("/");
  const parts = directoryPath.split("/").filter(Boolean);
  let current = absolute ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    try {
      await command(sftp, "mkdir", encodeRemotePath(config, current));
    } catch (error) {
      const stat = await tryLstatRemote(sftp, config, current);
      if (!stat || modeKind(stat.mode, stat) !== "directory") {
        throw error;
      }
    }
  }
}

async function listRemote(sftp, config, remotePath) {
  const items = await command(sftp, "readdir", encodeRemotePath(config, remotePath || "."));
  const encoding = detectListEncoding(config, items || []);
  return Promise.all((items || [])
    .filter((entry) => entry.filename !== "." && entry.filename !== "..")
    .map(async (entry) => {
      const rawName = entry.filenameRaw
        || (entry.filename ? Buffer.from(entry.filename, "utf8") : null);
      const name = decodeName(rawName, entry.filename, encoding);
      const attrs = entry.attrs || {};
      let linkTarget = null;
      if (modeKind(attrs.mode, attrs) === "symbolicLink") {
        try {
          const targetStats = await statRemote(sftp, config, remoteJoin(remotePath, name));
          linkTarget = modeKind(targetStats.mode, targetStats) === "directory"
            ? "directory"
            : "file";
        } catch {
          linkTarget = null;
        }
      }
      return entryFromStats(name, attrs, linkTarget);
    }));
}

async function removeRemoteRecursive(sftp, config, remotePath, state) {
  checkCancelled(state);
  const stats = await lstatRemote(sftp, config, remotePath);
  const kind = modeKind(stats.mode, stats);
  if (kind === "directory") {
    const entries = await listRemote(sftp, config, remotePath);
    for (const entry of entries) {
      await removeRemoteRecursive(sftp, config, remoteJoin(remotePath, entry.name), state);
    }
    await command(sftp, "rmdir", encodeRemotePath(config, remotePath));
  } else {
    await command(sftp, "unlink", encodeRemotePath(config, remotePath));
  }
}

async function renameRemote(sftp, config, oldPath, newPath, replaceExisting, state) {
  const oldEncoded = encodeRemotePath(config, oldPath);
  const newEncoded = encodeRemotePath(config, newPath);
  if (replaceExisting && typeof sftp.ext_openssh_rename === "function") {
    try {
      await command(sftp, "ext_openssh_rename", oldEncoded, newEncoded);
      return;
    } catch {
      // Fall through to the portable path below.
    }
  }
  try {
    await command(sftp, "rename", oldEncoded, newEncoded);
    return;
  } catch (error) {
    if (!replaceExisting) {
      throw error;
    }
    const existing = await tryLstatRemote(sftp, config, newPath);
    if (existing) {
      const kind = modeKind(existing.mode, existing);
      if (kind === "directory") {
        await removeRemoteRecursive(sftp, config, newPath, state);
      } else {
        await command(sftp, "unlink", newEncoded);
      }
    }
    await command(sftp, "rename", oldEncoded, newEncoded);
  }
}

async function scanRemoteBytes(sftp, config, remotePath, state) {
  await waitWhilePaused(state);
  const stats = await lstatRemote(sftp, config, remotePath);
  const kind = modeKind(stats.mode, stats);
  if (kind !== "directory") {
    return typeof stats.size === "number" ? stats.size : 0;
  }
  let total = 0;
  const entries = await listRemote(sftp, config, remotePath);
  for (const entry of entries) {
    total += await scanRemoteBytes(sftp, config, remoteJoin(remotePath, entry.name), state);
  }
  return total;
}

function scanLocalBytes(localPath, state) {
  checkCancelled(state);
  const stats = fs.statSync(localPath);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const name of fs.readdirSync(localPath)) {
    total += scanLocalBytes(path.join(localPath, name), state);
  }
  return total;
}

function beginTransfer(id, activeTransfers, total = null) {
  const state = {
    cancelled: false,
    paused: false,
    pauseWaiters: [],
    readStream: null,
    writeStream: null,
    temporaryPaths: [],
    total,
  };
  activeTransfers.set(id, state);
  return state;
}

function checkCancelled(state) {
  if (state?.cancelled) {
    throw new Error("Transfer cancelled.");
  }
}

async function waitWhilePaused(state) {
  checkCancelled(state);
  if (!state?.paused) return;
  await new Promise((resolve) => {
    state.pauseWaiters.push(resolve);
  });
  checkCancelled(state);
}

function pauseTransfer(activeTransfers, targetID) {
  const transfer = activeTransfers.get(targetID);
  if (!transfer) {
    throw new Error("Transfer is no longer active.");
  }
  transfer.paused = true;
}

function resumeTransfer(activeTransfers, targetID) {
  const transfer = activeTransfers.get(targetID);
  if (!transfer) {
    throw new Error("Transfer is no longer active.");
  }
  transfer.paused = false;
  for (const resolve of transfer.pauseWaiters.splice(0)) {
    resolve();
  }
}

function cancelTransfer(activeTransfers, targetID, message = "Transfer cancelled.") {
  const transfer = activeTransfers.get(targetID);
  if (!transfer) return;
  transfer.cancelled = true;
  transfer.paused = false;
  for (const resolve of transfer.pauseWaiters.splice(0)) {
    resolve();
  }
  transfer.scpTransfer?.abort?.();
}

function partialPath(finalPath, transferKey, direction) {
  const key = String(transferKey || "active")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 64);
  return `${finalPath}.termpilot-${direction}-${key}.part`;
}

function emitProgress(id, progress, writeMessage = write) {
  writeMessage({
    id,
    event: "progress",
    transferred: progress.transferred,
    total: progress.total,
  });
}

async function downloadFile(options) {
  return fileTransferLimiter.run(
    () => downloadFileWithPermit(options),
  );
}

async function downloadFileWithPermit({ id, sftp, config, remotePath, localPath, overwrite, state, progress, transferKey, chunkConcurrency, chunkSizeBytes, writeMessage = write }) {
  await waitWhilePaused(state);
  if (!overwrite && fs.existsSync(localPath)) {
    throw new Error("Local path already exists.");
  }

  const stats = await statRemote(sftp, config, remotePath);
  const fileTotal = typeof stats.size === "number" ? stats.size : null;
  if (progress.total == null && fileTotal != null) {
    progress.total = fileTotal;
  }

  const temporaryPath = partialPath(localPath, transferKey || id, "download");
  state.temporaryPaths.push({ type: "local", path: temporaryPath });
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  let remoteHandle = null;
  let localHandle = null;

  try {
    remoteHandle = await openRemoteFile(sftp, config, remotePath, "r");
    localHandle = await fs.promises.open(temporaryPath, "w");
    await runWindowedTransfer({
      state,
      totalBytes: fileTotal,
      chunkBytes: normalizedChunkBytes(chunkSizeBytes),
      maxInFlightChunks: clampedInteger(
        chunkConcurrency,
        1,
        32,
        DEFAULT_IN_FLIGHT_CHUNKS,
      ),
      transferChunk: async (position, length) => {
        const buffer = Buffer.allocUnsafe(length);
        const bytesRead = await readRemoteFile(
          sftp,
          remoteHandle,
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead <= 0) {
          return { bytes: 0, stop: true };
        }
        await waitWhilePaused(state);
        await localHandle.write(buffer, 0, bytesRead, position);
        return { bytes: bytesRead };
      },
      onProgress: (bytes) => {
        progress.transferred += bytes;
        emitProgress(id, progress, writeMessage);
      },
    });
    await waitWhilePaused(state);
    fs.renameSync(temporaryPath, localPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  } finally {
    try { await localHandle?.close(); } catch {}
    await closeRemoteFile(sftp, remoteHandle);
    state.readStream = null;
    state.writeStream = null;
  }
}

async function downloadDirectory({ id, sftp, config, remotePath, localPath, overwrite, state, progress, transferKey, chunkConcurrency, chunkSizeBytes, writeMessage = write }) {
  await waitWhilePaused(state);
  if (fs.existsSync(localPath) && !fs.statSync(localPath).isDirectory()) {
    if (!overwrite) throw new Error("Local path already exists.");
    fs.rmSync(localPath, { recursive: true, force: true });
  }
  fs.mkdirSync(localPath, { recursive: true });
  const entries = await listRemote(sftp, config, remotePath);
  await waitForTransferOperations(entries.map(async (entry) => {
    const childRemote = remoteJoin(remotePath, entry.name);
    const childLocal = path.join(localPath, entry.name);
    if (entry.kind === "directory") {
      await downloadDirectory({
        id,
        sftp,
        config,
        remotePath: childRemote,
        localPath: childLocal,
        overwrite,
        state,
        progress,
        transferKey,
        chunkConcurrency,
        chunkSizeBytes,
        writeMessage,
      });
    } else {
      await downloadFile({
        id,
        sftp,
        config,
        remotePath: childRemote,
        localPath: childLocal,
        overwrite,
        state,
        progress,
        transferKey,
        chunkConcurrency,
        chunkSizeBytes,
        writeMessage,
      });
    }
  }));
}

async function download({ id, sftp, config, remotePath, localPath, overwrite, activeTransfers, transferKey, fileConcurrency, chunkConcurrency, chunkSizeBytes, writeMessage = write }) {
  fileTransferLimiter.setLimit(fileConcurrency);
  const state = beginTransfer(id, activeTransfers);
  const progress = { transferred: 0, total: null };
  try {
    const stats = await lstatRemote(sftp, config, remotePath);
    const kind = modeKind(stats.mode, stats);
    progress.total = kind === "directory"
      ? await scanRemoteBytes(sftp, config, remotePath, state)
      : (typeof stats.size === "number" ? stats.size : null);
    emitProgress(id, progress, writeMessage);
    if (kind === "directory") {
      await downloadDirectory({ id, sftp, config, remotePath, localPath, overwrite, state, progress, transferKey, chunkConcurrency, chunkSizeBytes, writeMessage });
    } else {
      await downloadFile({ id, sftp, config, remotePath, localPath, overwrite, state, progress, transferKey, chunkConcurrency, chunkSizeBytes, writeMessage });
    }
    return { bytesTransferred: progress.transferred };
  } finally {
    activeTransfers.delete(id);
    for (const item of state.temporaryPaths) {
      if (item.type === "local") {
        try { fs.rmSync(item.path, { force: true }); } catch {}
      }
    }
  }
}

async function uploadFile(options) {
  return fileTransferLimiter.run(
    () => uploadFileWithPermit(options),
  );
}

async function uploadFileWithPermit({ id, sftp, config, localPath, remotePath, overwrite, state, progress, transferKey, chunkConcurrency, chunkSizeBytes, writeMessage = write }) {
  await waitWhilePaused(state);
  await ensureRemoteDir(sftp, config, remoteParent(remotePath));

  const existing = await tryLstatRemote(sftp, config, remotePath);
  let existingMode = null;
  if (existing) {
    if (!overwrite) throw new Error("Remote path already exists.");
    const existingKind = modeKind(existing.mode, existing);
    if (existingKind === "directory") {
      await removeRemoteRecursive(sftp, config, remotePath, state);
    } else if (typeof existing.mode === "number") {
      existingMode = existing.mode & 0o7777;
    }
  }

  const temporaryPath = partialPath(remotePath, transferKey || id, "upload");
  state.temporaryPaths.push({ type: "remote", path: temporaryPath });
  let localHandle = null;
  let remoteHandle = null;

  try {
    localHandle = await fs.promises.open(localPath, "r");
    remoteHandle = await openRemoteFile(sftp, config, temporaryPath, "w");
    const fileSize = fs.statSync(localPath).size;
    await runWindowedTransfer({
      state,
      totalBytes: fileSize,
      chunkBytes: normalizedChunkBytes(chunkSizeBytes),
      maxInFlightChunks: clampedInteger(
        chunkConcurrency,
        1,
        32,
        DEFAULT_IN_FLIGHT_CHUNKS,
      ),
      transferChunk: async (position, length) => {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await localHandle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead <= 0) {
          return { bytes: 0, stop: true };
        }
        await waitWhilePaused(state);
        await writeRemoteFile(
          sftp,
          remoteHandle,
          buffer,
          0,
          bytesRead,
          position,
        );
        return { bytes: bytesRead };
      },
      onProgress: (bytes) => {
        progress.transferred += bytes;
        emitProgress(id, progress, writeMessage);
      },
    });
    await waitWhilePaused(state);
    if (existingMode != null) {
      try {
        await command(sftp, "chmod", encodeRemotePath(config, temporaryPath), existingMode);
      } catch {
        // Permission restoration is best-effort for the external editor path.
      }
    }
    await renameRemote(
      sftp,
      config,
      temporaryPath,
      remotePath,
      overwrite,
      state,
    );
  } catch (error) {
    try { await command(sftp, "unlink", encodeRemotePath(config, temporaryPath)); } catch {}
    throw error;
  } finally {
    try { await localHandle?.close(); } catch {}
    await closeRemoteFile(sftp, remoteHandle);
    state.readStream = null;
    state.writeStream = null;
  }
}

async function uploadDirectory({ id, sftp, config, localPath, remotePath, overwrite, state, progress, transferKey, chunkConcurrency, chunkSizeBytes, writeMessage = write }) {
  await waitWhilePaused(state);
  const existing = await tryLstatRemote(sftp, config, remotePath);
  if (existing) {
    if (!overwrite) throw new Error("Remote path already exists.");
    if (modeKind(existing.mode, existing) !== "directory") {
      await removeRemoteRecursive(sftp, config, remotePath, state);
    }
  }
  await ensureRemoteDir(sftp, config, remotePath);
  await waitForTransferOperations(fs.readdirSync(localPath).map(async (name) => {
    const childLocal = path.join(localPath, name);
    const childRemote = remoteJoin(remotePath, name);
    if (fs.statSync(childLocal).isDirectory()) {
      await uploadDirectory({
        id,
        sftp,
        config,
        localPath: childLocal,
        remotePath: childRemote,
        overwrite,
        state,
        progress,
        transferKey,
        chunkConcurrency,
        chunkSizeBytes,
        writeMessage,
      });
    } else {
      await uploadFile({
        id,
        sftp,
        config,
        localPath: childLocal,
        remotePath: childRemote,
        overwrite,
        state,
        progress,
        transferKey,
        chunkConcurrency,
        chunkSizeBytes,
        writeMessage,
      });
    }
  }));
}

async function upload({ id, sftp, config, localPath, remotePath, overwrite, activeTransfers, transferKey, fileConcurrency, chunkConcurrency, chunkSizeBytes, writeMessage = write }) {
  fileTransferLimiter.setLimit(fileConcurrency);
  const total = scanLocalBytes(localPath, null);
  const state = beginTransfer(id, activeTransfers, total);
  const progress = { transferred: 0, total };
  try {
    emitProgress(id, progress, writeMessage);
    const stats = fs.statSync(localPath);
    if (stats.isDirectory()) {
      await uploadDirectory({ id, sftp, config, localPath, remotePath, overwrite, state, progress, transferKey, chunkConcurrency, chunkSizeBytes, writeMessage });
    } else {
      await uploadFile({ id, sftp, config, localPath, remotePath, overwrite, state, progress, transferKey, chunkConcurrency, chunkSizeBytes, writeMessage });
    }
    return { bytesTransferred: progress.transferred };
  } finally {
    activeTransfers.delete(id);
    for (const item of state.temporaryPaths) {
      if (item.type === "remote") {
        try { await command(sftp, "unlink", encodeRemotePath(config, item.path)); } catch {}
      }
    }
  }
}

async function readText({ sftp, config, remotePath }) {
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(encodeRemotePath(config, remotePath));
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  return buffer.toString("utf8");
}

async function writeText({ sftp, config, remotePath, content, overwrite }) {
  if (!overwrite) {
    const existing = await tryLstatRemote(sftp, config, remotePath);
    if (existing) throw new Error("Remote path already exists.");
  }

  await ensureRemoteDir(sftp, config, remoteParent(remotePath));
  const existing = await tryLstatRemote(sftp, config, remotePath);
  let existingMode = null;
  if (existing && typeof existing.mode === "number") {
    existingMode = existing.mode & 0o7777;
  }

  const normalized = String(content || "").replace(/\r\n/g, "\n");
  const temporaryPath = `${remotePath}.termpilot-write-${Date.now()}-${process.pid}.tmp`;
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(encodeRemotePath(config, temporaryPath), { flags: "w" });
    stream.on("error", reject);
    stream.on("close", () => resolve());
    stream.end(Buffer.from(normalized, "utf8"));
  });
  if (existingMode != null) {
    try {
      await command(sftp, "chmod", encodeRemotePath(config, temporaryPath), existingMode);
    } catch {
      // Permission restoration remains best-effort for text editor saves.
    }
  }
  try {
    await renameRemote(
      sftp,
      config,
      temporaryPath,
      remotePath,
      overwrite,
      null,
    );
  } catch (error) {
    try { await command(sftp, "unlink", encodeRemotePath(config, temporaryPath)); } catch {}
    throw error;
  }
}

function scpEncoding(config) {
  const encoding = resolvedEncoding(config);
  assertEncodingAvailable(encoding);
  return encoding;
}

function scpKind(value) {
  if (value?.isDirectory || value?.type === "directory") return "directory";
  if (value?.isSymbolicLink || value?.type === "symlink") return "symbolicLink";
  return "file";
}

function scpEntryFromList(entry) {
  return {
    name: entry.name,
    kind: scpKind(entry),
    linkTarget: entry.linkTarget || null,
    size: typeof entry._size === "number" ? entry._size : null,
    permissions: null,
    modifiedAt: entry.lastModified || null,
  };
}

function scpEntryFromStat(remotePath, stat) {
  return {
    name: path.posix.basename(remotePath),
    kind: scpKind(stat),
    linkTarget: stat.isSymbolicLink ? "file" : null,
    size: typeof stat.size === "number" ? stat.size : null,
    permissions: typeof stat.mode === "number" ? stat.mode : null,
    modifiedAt: stat.modifyTime ? new Date(stat.modifyTime).toISOString() : null,
  };
}

function scpTransferForState(state) {
  if (!state.scpTransfer) {
    state.scpTransfer = {
      get cancelled() {
        return !!state.cancelled;
      },
      set cancelled(value) {
        state.cancelled = !!value;
      },
      abort() {
        try { this.readStream?.destroy?.(new Error("Transfer cancelled.")); } catch {}
        try { this.writeStream?.destroy?.(new Error("Transfer cancelled.")); } catch {}
      },
    };
  }
  return state.scpTransfer;
}

async function scpTryStat(backend, config, remotePath, state) {
  try {
    checkCancelled(state);
    return await backend.stat(remotePath, { encoding: scpEncoding(config) });
  } catch (error) {
    if (missingPathError(error) || error?.code === "ENOENT") return null;
    throw error;
  }
}

async function scpListRemote(backend, config, remotePath) {
  const entries = await backend.list(remotePath || ".", { encoding: scpEncoding(config) });
  return entries.map(scpEntryFromList);
}

async function scpScanRemoteBytes(backend, config, remotePath, state) {
  checkCancelled(state);
  const stat = await backend.stat(remotePath, { encoding: scpEncoding(config) });
  if (!stat.isDirectory) {
    return typeof stat.size === "number" ? stat.size : 0;
  }
  let total = 0;
  for (const entry of await scpListRemote(backend, config, remotePath)) {
    total += await scpScanRemoteBytes(
      backend,
      config,
      remoteJoin(remotePath, entry.name),
      state,
    );
  }
  return total;
}

async function scpDownloadFile({ id, backend, config, remotePath, localPath, overwrite, state, progress, writeMessage = write }) {
  checkCancelled(state);
  if (!overwrite && fs.existsSync(localPath)) {
    throw new Error("Local path already exists.");
  }
  if (overwrite && fs.existsSync(localPath)) {
    fs.rmSync(localPath, { recursive: true, force: true });
  }
  const stat = await backend.stat(remotePath, { encoding: scpEncoding(config) });
  const base = progress.transferred;
  await backend.downloadFile(remotePath, localPath, {
    fileSize: typeof stat.size === "number" ? stat.size : null,
    transfer: scpTransferForState(state),
    encoding: scpEncoding(config),
    onProgress(transferred, total) {
      progress.transferred = base + transferred;
      if (progress.total == null && Number.isFinite(total)) {
        progress.total = base + total;
      }
      emitProgress(id, progress, writeMessage);
    },
  });
  progress.transferred = base + (typeof stat.size === "number" ? stat.size : 0);
  emitProgress(id, progress, writeMessage);
}

async function scpDownloadDirectory({ id, backend, config, remotePath, localPath, overwrite, state, progress, writeMessage = write }) {
  checkCancelled(state);
  if (fs.existsSync(localPath) && !fs.statSync(localPath).isDirectory()) {
    if (!overwrite) throw new Error("Local path already exists.");
    fs.rmSync(localPath, { recursive: true, force: true });
  }
  fs.mkdirSync(localPath, { recursive: true });
  for (const entry of await scpListRemote(backend, config, remotePath)) {
    const childRemote = remoteJoin(remotePath, entry.name);
    const childLocal = path.join(localPath, entry.name);
    if (entry.kind === "directory") {
      await scpDownloadDirectory({
        id,
        backend,
        config,
        remotePath: childRemote,
        localPath: childLocal,
        overwrite,
        state,
        progress,
        writeMessage,
      });
    } else {
      await scpDownloadFile({
        id,
        backend,
        config,
        remotePath: childRemote,
        localPath: childLocal,
        overwrite,
        state,
        progress,
        writeMessage,
      });
    }
  }
}

async function scpDownload({ id, backend, config, remotePath, localPath, overwrite, activeTransfers, writeMessage = write }) {
  const state = beginTransfer(id, activeTransfers);
  const progress = { transferred: 0, total: null };
  try {
    const stat = await backend.stat(remotePath, { encoding: scpEncoding(config) });
    progress.total = stat.isDirectory
      ? await scpScanRemoteBytes(backend, config, remotePath, state)
      : (typeof stat.size === "number" ? stat.size : null);
    emitProgress(id, progress, writeMessage);
    if (stat.isDirectory) {
      await scpDownloadDirectory({ id, backend, config, remotePath, localPath, overwrite, state, progress, writeMessage });
    } else {
      await scpDownloadFile({ id, backend, config, remotePath, localPath, overwrite, state, progress, writeMessage });
    }
    return { bytesTransferred: progress.transferred };
  } finally {
    activeTransfers.delete(id);
    state.scpTransfer?.abort?.();
  }
}

async function scpUploadFile({ id, backend, config, localPath, remotePath, overwrite, state, progress, writeMessage = write }) {
  checkCancelled(state);
  const existing = await scpTryStat(backend, config, remotePath, state);
  if (existing) {
    if (!overwrite) throw new Error("Remote path already exists.");
    await backend.remove(remotePath, { recursive: true, encoding: scpEncoding(config) });
  }
  const stats = fs.statSync(localPath);
  const base = progress.transferred;
  await backend.uploadFile(localPath, remotePath, {
    fileSize: stats.size,
    transfer: scpTransferForState(state),
    encoding: scpEncoding(config),
    onProgress(transferred, total) {
      progress.transferred = base + transferred;
      if (progress.total == null && Number.isFinite(total)) {
        progress.total = base + total;
      }
      emitProgress(id, progress, writeMessage);
    },
  });
  progress.transferred = base + stats.size;
  emitProgress(id, progress, writeMessage);
}

async function scpUploadDirectory({ id, backend, config, localPath, remotePath, overwrite, state, progress, writeMessage = write }) {
  checkCancelled(state);
  const existing = await scpTryStat(backend, config, remotePath, state);
  if (existing) {
    if (!overwrite) throw new Error("Remote path already exists.");
    if (!existing.isDirectory) {
      await backend.remove(remotePath, { recursive: true, encoding: scpEncoding(config) });
    }
  }
  await backend.mkdir(remotePath, { recursive: true, encoding: scpEncoding(config) });
  for (const name of fs.readdirSync(localPath)) {
    const childLocal = path.join(localPath, name);
    const childRemote = remoteJoin(remotePath, name);
    if (fs.statSync(childLocal).isDirectory()) {
      await scpUploadDirectory({
        id,
        backend,
        config,
        localPath: childLocal,
        remotePath: childRemote,
        overwrite,
        state,
        progress,
        writeMessage,
      });
    } else {
      await scpUploadFile({
        id,
        backend,
        config,
        localPath: childLocal,
        remotePath: childRemote,
        overwrite,
        state,
        progress,
        writeMessage,
      });
    }
  }
}

async function scpUpload({ id, backend, config, localPath, remotePath, overwrite, activeTransfers, writeMessage = write }) {
  const total = scanLocalBytes(localPath, null);
  const state = beginTransfer(id, activeTransfers, total);
  const progress = { transferred: 0, total };
  try {
    emitProgress(id, progress, writeMessage);
    if (fs.statSync(localPath).isDirectory()) {
      await scpUploadDirectory({ id, backend, config, localPath, remotePath, overwrite, state, progress, writeMessage });
    } else {
      await scpUploadFile({ id, backend, config, localPath, remotePath, overwrite, state, progress, writeMessage });
    }
    return { bytesTransferred: progress.transferred };
  } finally {
    activeTransfers.delete(id);
    state.scpTransfer?.abort?.();
  }
}

async function handleScpCommand({
  conn,
  backend,
  config,
  activeTransfers,
  request,
  writeMessage = write,
  closesConnection = true,
}) {
  const id = request.id;
  const encoding = scpEncoding(config);
  try {
    switch (request.action) {
      case "exec":
        ok(id, await executeRequestCommand(conn, config, request), writeMessage);
        break;
      case "realpath":
        ok(id, { path: await backend.realpath(request.path || ".", { encoding }) }, writeMessage);
        break;
      case "list":
        ok(id, { entries: await scpListRemote(backend, config, request.path || ".") }, writeMessage);
        break;
      case "stat": {
        const stat = await backend.stat(request.path, { encoding });
        ok(id, { entry: scpEntryFromStat(request.path, stat) }, writeMessage);
        break;
      }
      case "readText": {
        const buffer = await backend.readFile(request.path, { encoding });
        ok(id, { text: buffer.toString("utf8") }, writeMessage);
        break;
      }
      case "writeText": {
        const normalized = String(request.content || "").replace(/\r\n/g, "\n");
        if (!request.overwrite) {
          const existing = await scpTryStat(backend, config, request.path, null);
          if (existing) throw new Error("Remote path already exists.");
        }
        const existing = await scpTryStat(backend, config, request.path, null);
        const mode = typeof existing?.mode === "number"
          ? existing.mode & 0o7777
          : undefined;
        await backend.writeFile(request.path, Buffer.from(normalized, "utf8"), {
          mode,
          encoding,
        });
        ok(id, {}, writeMessage);
        break;
      }
      case "mkdir":
        await backend.mkdir(request.path, { recursive: true, encoding });
        ok(id, {}, writeMessage);
        break;
      case "rename":
        await backend.rename(request.oldPath, request.newPath, { encoding });
        ok(id, {}, writeMessage);
        break;
      case "delete":
        await backend.remove(request.path, { recursive: true, encoding });
        ok(id, {}, writeMessage);
        break;
      case "chmod":
        await backend.chmod(request.path, request.permissions, { encoding });
        ok(id, {}, writeMessage);
        break;
      case "download":
        fileTransferLimiter.setLimit(request.fileConcurrency);
        ok(
          id,
          await fileTransferLimiter.run(
            () => scpDownload({
              id,
              backend,
              config,
              activeTransfers,
              writeMessage,
              ...request,
            }),
          ),
          writeMessage,
        );
        break;
      case "upload":
        fileTransferLimiter.setLimit(request.fileConcurrency);
        ok(
          id,
          await fileTransferLimiter.run(
            () => scpUpload({
              id,
              backend,
              config,
              activeTransfers,
              writeMessage,
              ...request,
            }),
          ),
          writeMessage,
        );
        break;
      case "cancel": {
        cancelTransfer(activeTransfers, request.targetID);
        ok(id, {}, writeMessage);
        break;
      }
      case "pause":
      case "resume":
        throw new Error("Resumable pause is unavailable in SCP mode.");
      case "close":
        ok(id, {}, writeMessage);
        if (closesConnection) {
          try { conn.end(); } catch {}
        }
        break;
      default:
        throw new Error(`Unknown SFTP bridge action: ${request.action}`);
    }
  } catch (error) {
    fail(id, error, writeMessage);
  }
}

async function handleCommand({
  conn,
  sftp,
  config,
  activeTransfers,
  request,
  writeMessage = write,
  closesConnection = true,
}) {
  const id = request.id;
  try {
    switch (request.action) {
      case "exec":
        ok(id, await executeRequestCommand(conn, config, request), writeMessage);
        break;
      case "realpath": {
        const result = await command(sftp, "realpath", encodeRemotePath(config, request.path || "."));
        ok(id, { path: Buffer.isBuffer(result) ? result.toString("utf8") : result }, writeMessage);
        break;
      }
      case "list": {
        ok(id, { entries: await listRemote(sftp, config, request.path || ".") }, writeMessage);
        break;
      }
      case "stat": {
        const stats = await lstatRemote(sftp, config, request.path);
        ok(id, { entry: entryFromStats(path.posix.basename(request.path), stats) }, writeMessage);
        break;
      }
      case "readText": {
        ok(id, { text: await readText({ sftp, config, remotePath: request.path }) }, writeMessage);
        break;
      }
      case "writeText": {
        await writeText({
          sftp,
          config,
          remotePath: request.path,
          content: request.content || "",
          overwrite: !!request.overwrite,
        });
        ok(id, {}, writeMessage);
        break;
      }
      case "mkdir":
        await ensureRemoteDir(sftp, config, request.path);
        ok(id, {}, writeMessage);
        break;
      case "rename":
        await command(
          sftp,
          "rename",
          encodeRemotePath(config, request.oldPath),
          encodeRemotePath(config, request.newPath),
        );
        ok(id, {}, writeMessage);
        break;
      case "delete": {
        const state = beginTransfer(id, activeTransfers);
        try {
          await removeRemoteRecursive(sftp, config, request.path, state);
        } finally {
          activeTransfers.delete(id);
        }
        ok(id, {}, writeMessage);
        break;
      }
      case "chmod":
        await command(sftp, "chmod", encodeRemotePath(config, request.path), request.permissions);
        ok(id, {}, writeMessage);
        break;
      case "download":
        ok(
          id,
          await download({
            id,
            sftp,
            config,
            activeTransfers,
            writeMessage,
            ...request,
          }),
          writeMessage,
        );
        break;
      case "upload":
        ok(
          id,
          await upload({
            id,
            sftp,
            config,
            activeTransfers,
            writeMessage,
            ...request,
          }),
          writeMessage,
        );
        break;
      case "cancel": {
        cancelTransfer(activeTransfers, request.targetID);
        ok(id, {}, writeMessage);
        break;
      }
      case "pause": {
        pauseTransfer(activeTransfers, request.targetID);
        ok(id, {}, writeMessage);
        break;
      }
      case "resume": {
        resumeTransfer(activeTransfers, request.targetID);
        ok(id, {}, writeMessage);
        break;
      }
      case "close":
        ok(id, {}, writeMessage);
        try { sftp.end(); } catch {}
        if (closesConnection) {
          try { conn.end(); } catch {}
        }
        break;
      default:
        throw new Error(`Unknown SFTP bridge action: ${request.action}`);
    }
  } catch (error) {
    fail(id, error, writeMessage);
  }
}

async function openSessionBackedSftp(conn, config) {
  const sessionConfig = {
    ...config,
    fileProtocol: config.fileProtocol || "auto",
    filenameEncoding: normalizeEncoding(config.filenameEncoding || "auto"),
    usesSudo: !!config.usesSudo,
  };
  if (sessionConfig.usesSudo) {
    throw new Error("Elevated SFTP requires a dedicated SFTP connection.");
  }

  const activeTransfers = new Map();
  let mode = "sftp";
  let sftp = null;
  let scpBackend = null;

  if (sessionConfig.fileProtocol === "scp") {
    mode = "scp";
  } else {
    try {
      sftp = await new Promise((resolve, reject) => {
        conn.sftp((error, client) => {
          if (error) reject(error);
          else resolve(client);
        });
      });
    } catch (error) {
      if (sessionConfig.fileProtocol === "sftp") {
        throw error;
      }
      mode = "scp";
    }
  }

  if (mode === "scp") {
    const adapters = createSshExecAdapters(conn);
    const probe = await adapters.exec(
      "command -v scp >/dev/null 2>&1 || which scp >/dev/null 2>&1",
    );
    if (probe.code !== 0) {
      throw new Error("SCP binary is not available on the remote host.");
    }
    scpBackend = createScpBackend(adapters);
  }

  return {
    mode,
    sftp,
    scpBackend,
    activeTransfers,
    config: sessionConfig,
  };
}

async function main() {
  const config = readConfig();
  const { module: ssh2, resolvedFrom } = requireSsh2();

  if (process.env.TERMPILOT_SFTP_BRIDGE_SMOKE_TEST === "1") {
    process.stderr.write(`[sftp:init] Loaded Node ssh2 module from ${resolvedFrom}\n`);
    return;
  }

  if (config.fileProtocol === "scp" && config.usesSudo) {
    throw new Error("SCP mode cannot be combined with elevated SFTP.");
  }

  const conn = new ssh2.Client();
  const activeTransfers = new Map();
  const options = connectionOptions(config);
  let proxySocket = null;

  if (config.proxy) {
    proxySocket = await createProxySocket(
      config.proxy,
      config.hostname,
      config.port || 22,
      { timeoutMs: 30_000 },
    );
    options.sock = proxySocket;
    delete options.host;
    delete options.port;
  }

  try {
    await new Promise((resolve, reject) => {
      conn.once("ready", resolve);
      conn.once("error", reject);
      conn.connect(options);
    });
  } catch (error) {
    proxySocket?.destroy?.();
    throw error;
  }

  let mode = "sftp";
  let sftp = null;
  let scpBackend = null;
  if (config.fileProtocol === "scp") {
    mode = "scp";
  } else if (config.usesSudo) {
    sftp = await connectElevatedSftp(
      conn,
      config.elevationPassword || config.password || "",
      config.elevationMethod,
    );
  } else {
    try {
      sftp = await new Promise((resolve, reject) => {
        conn.sftp((error, client) => {
          if (error) reject(error);
          else resolve(client);
        });
      });
    } catch (error) {
      if (config.fileProtocol === "sftp") {
        throw error;
      }
      mode = "scp";
    }
  }

  if (mode === "scp") {
    const adapters = createSshExecAdapters(conn);
    const probe = await adapters.exec(
      "command -v scp >/dev/null 2>&1 || which scp >/dev/null 2>&1",
    );
    if (probe.code !== 0) {
      throw new Error("SCP binary is not available on the remote host.");
    }
    scpBackend = createScpBackend(adapters);
  }

  write({ id: 0, event: "ready", mode });

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
      fail(null, error);
      continue;
    }
    const execute = () => {
      if (mode === "scp") {
        return handleScpCommand({
          conn,
          backend: scpBackend,
          config,
          activeTransfers,
          request,
        });
      }
      return handleCommand({ conn, sftp, config, activeTransfers, request });
    };
    if (request.action === "upload" || request.action === "download") {
      void execute();
    } else {
      await execute();
    }
  }
}

module.exports = {
  executeRequestCommand,
  handleCommand,
  handleScpCommand,
  openSessionBackedSftp,
};

if (require.main === module) {
  main().catch((error) => {
    fail(0, error);
    process.exitCode = 1;
  });
}
