"use strict";

const net = require("node:net");
const { spawn } = require("node:child_process");
const { Duplex } = require("node:stream");

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function substituteProxyCommand(command, targetHost, targetPort) {
  return String(command || "").replace(/%%|%h|%p/g, (token) => {
    if (token === "%%") return "%";
    if (token === "%h") return quoteShellArg(targetHost);
    if (token === "%p") return quoteShellArg(targetPort);
    return token;
  });
}

function createProcessSocket(child) {
  const socket = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk, encoding, callback) {
      if (!child.stdin.writable) {
        callback(new Error("ProxyCommand stdin is not writable"));
        return;
      }
      if (child.stdin.write(chunk, encoding)) callback();
      else child.stdin.once("drain", callback);
    },
    final(callback) {
      child.stdin.end(callback);
    },
    destroy(error, callback) {
      try { child.stdin.destroy(); } catch {}
      try { child.stdout.destroy(); } catch {}
      if (!child.killed) {
        try { child.kill(); } catch {}
      }
      callback(error);
    },
  });
  socket.setNoDelay = () => socket;
  socket.setKeepAlive = () => socket;
  socket.setTimeout = () => socket;

  child.stdout.on("data", (chunk) => {
    if (!socket.push(chunk)) child.stdout.pause();
  });
  child.stdout.on("end", () => socket.push(null));
  child.stdout.on("error", (error) => socket.destroy(error));
  child.stdin.on("error", (error) => socket.destroy(error));
  return socket;
}

function createProxyCommandSocket(proxy, targetHost, targetPort, options) {
  const command = substituteProxyCommand(
    proxy.command,
    targetHost,
    targetPort,
  ).trim();
  if (!command) {
    return Promise.reject(new Error("ProxyCommand is required"));
  }

  const child = spawn(command, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
  const socket = createProcessSocket(child);
  const timeoutMs = positiveTimeout(options?.timeoutMs);
  let stderr = "";
  let settled = false;
  let timeout = null;

  const clearConnectTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
  };
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  child.stdout.once("data", clearConnectTimeout);
  child.once("close", clearConnectTimeout);
  if (timeoutMs) {
    timeout = setTimeout(() => {
      socket.destroy(
        new Error(`ProxyCommand connection timeout to ${targetHost}:${targetPort}`),
      );
    }, timeoutMs);
    timeout.unref?.();
  }

  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearConnectTimeout();
      if (settled) socket.destroy(error);
      else {
        settled = true;
        reject(error);
      }
    });
    child.once("spawn", () => {
      settled = true;
      options?.onSocket?.(socket);
      resolve(socket);
    });
    child.once("close", (code, signal) => {
      if (code === 0 || socket.destroyed) return;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      const error = new Error(
        `ProxyCommand exited ${
          signal ? `with signal ${signal}` : `with code ${code}`
        }${detail}`,
      );
      if (settled) socket.destroy(error);
      else {
        settled = true;
        reject(error);
      }
    });
  });
}

function positiveTimeout(value) {
  return Number.isFinite(value) && value > 0 ? Number(value) : 0;
}

function connectProxyTCP(proxy, options) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    const timeoutMs = positiveTimeout(options?.timeoutMs);
    let settled = false;
    let timer = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        socket.removeListener("error", finish);
        resolve(socket);
      }
    };

    socket.setNoDelay(true);
    socket.once("error", finish);
    socket.once("connect", () => {
      options?.onSocket?.(socket);
      finish();
    });
    if (timeoutMs) {
      timer = setTimeout(() => {
        finish(new Error(`Proxy connection timeout to ${proxy.host}:${proxy.port}`));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

async function createHTTPProxySocket(
  proxy,
  targetHost,
  targetPort,
  options,
) {
  const socket = await connectProxyTCP(proxy, options);
  const authHeader = proxy.username && proxy.password
    ? `Proxy-Authorization: Basic ${
      Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")
    }\r\n`
    : "";
  socket.write(
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`
      + `Host: ${targetHost}:${targetPort}\r\n`
      + authHeader
      + "\r\n",
  );

  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const timeoutMs = positiveTimeout(options?.timeoutMs);
    let timer = null;
    const clearHandshakeTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const fail = (error) => {
      clearHandshakeTimeout();
      socket.destroy();
      reject(error);
    };
    const onData = (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 64 * 1024) {
        socket.removeListener("data", onData);
        fail(new Error("HTTP proxy response is too large"));
        return;
      }
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      socket.removeListener("data", onData);
      const header = response.subarray(0, boundary).toString("latin1");
      const statusLine = header.split("\r\n", 1)[0] || "";
      if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
        fail(new Error(`HTTP proxy error: ${statusLine || "invalid response"}`));
        return;
      }
      const remaining = response.subarray(boundary + 4);
      if (remaining.length) socket.unshift(remaining);
      clearHandshakeTimeout();
      resolve(socket);
    };
    socket.on("data", onData);
    socket.once("error", fail);
    if (timeoutMs) {
      timer = setTimeout(() => {
        fail(new Error(`HTTP proxy handshake timeout to ${targetHost}:${targetPort}`));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

async function createSOCKS5ProxySocket(
  proxy,
  targetHost,
  targetPort,
  options,
) {
  const socket = await connectProxyTCP(proxy, options);
  const hasCredentials = Boolean(proxy.username && proxy.password);
  socket.write(Buffer.from([
    0x05,
    hasCredentials ? 2 : 1,
    0x00,
    ...(hasCredentials ? [0x02] : []),
  ]));

  return new Promise((resolve, reject) => {
    let state = "greeting";
    let buffered = Buffer.alloc(0);
    const timeoutMs = positiveTimeout(options?.timeoutMs);
    let timer = null;
    const clearHandshakeTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const fail = (error) => {
      clearHandshakeTimeout();
      socket.destroy();
      reject(error);
    };
    const sendConnectRequest = () => {
      const host = Buffer.from(targetHost);
      if (host.length > 255) {
        fail(new Error("SOCKS5 target hostname is too long"));
        return;
      }
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
        host,
        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
      ]));
      state = "connect";
    };
    const consume = (count) => {
      const value = buffered.subarray(0, count);
      buffered = buffered.subarray(count);
      return value;
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        if (state === "greeting") {
          if (buffered.length < 2) return;
          const response = consume(2);
          if (response[0] !== 0x05) {
            fail(new Error("Invalid SOCKS5 response"));
            return;
          }
          if (response[1] === 0x02 && hasCredentials) {
            const username = Buffer.from(proxy.username);
            const password = Buffer.from(proxy.password);
            if (username.length > 255 || password.length > 255) {
              fail(new Error("SOCKS5 credentials are too long"));
              return;
            }
            socket.write(Buffer.concat([
              Buffer.from([0x01, username.length]),
              username,
              Buffer.from([password.length]),
              password,
            ]));
            state = "auth";
          } else if (response[1] === 0x00) {
            sendConnectRequest();
          } else {
            fail(new Error("SOCKS5 authentication method not supported"));
            return;
          }
        } else if (state === "auth") {
          if (buffered.length < 2) return;
          const response = consume(2);
          if (response[1] !== 0x00) {
            fail(new Error("SOCKS5 authentication failed"));
            return;
          }
          sendConnectRequest();
        } else {
          if (buffered.length < 5) return;
          const addressType = buffered[3];
          const addressLength = addressType === 0x01
            ? 4
            : addressType === 0x04
              ? 16
              : addressType === 0x03 && buffered.length >= 5
                ? 1 + buffered[4]
                : -1;
          if (addressLength < 0) {
            fail(new Error("Invalid SOCKS5 connect response"));
            return;
          }
          const responseLength = 4 + addressLength + 2;
          if (buffered.length < responseLength) return;
          const response = consume(responseLength);
          socket.removeListener("data", onData);
          if (response[1] !== 0x00) {
            const errors = {
              0x01: "General failure",
              0x02: "Connection not allowed",
              0x03: "Network unreachable",
              0x04: "Host unreachable",
              0x05: "Connection refused",
              0x06: "TTL expired",
              0x07: "Command not supported",
              0x08: "Address type not supported",
            };
            fail(new Error(`SOCKS5 error: ${errors[response[1]] || "Unknown"}`));
            return;
          }
          if (buffered.length) socket.unshift(buffered);
          clearHandshakeTimeout();
          resolve(socket);
          return;
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", fail);
    if (timeoutMs) {
      timer = setTimeout(() => {
        fail(new Error(`SOCKS5 handshake timeout to ${targetHost}:${targetPort}`));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

function createProxySocket(proxy, targetHost, targetPort, options = {}) {
  if (!proxy || !proxy.type) {
    return Promise.reject(new Error("Proxy configuration is missing"));
  }
  if (proxy.type === "command") {
    return createProxyCommandSocket(proxy, targetHost, targetPort, options);
  }
  if (!proxy.host || !Number.isInteger(proxy.port) || proxy.port < 1) {
    return Promise.reject(new Error("Proxy host and port are required"));
  }
  if (proxy.type === "http") {
    return createHTTPProxySocket(proxy, targetHost, targetPort, options);
  }
  if (proxy.type === "socks5") {
    return createSOCKS5ProxySocket(proxy, targetHost, targetPort, options);
  }
  return Promise.reject(new Error(`Unknown proxy type: ${proxy.type}`));
}

module.exports = {
  createProxySocket,
  substituteProxyCommand,
};
