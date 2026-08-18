#!/usr/bin/env node
"use strict";

const { createProxySocket } = require("./proxyUtils.cjs");

function readProxyConfiguration() {
  const encoded = process.env.TERMPILOT_PROXY_COMMAND_CONFIG_B64;
  if (!encoded) {
    throw new Error("TERMPILOT_PROXY_COMMAND_CONFIG_B64 is missing");
  }
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

async function main() {
  const targetHost = process.argv[2];
  const targetPort = Number(process.argv[3]);
  if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1) {
    throw new Error("ProxyCommand target host and port are required");
  }

  const socket = await createProxySocket(
    readProxyConfiguration(),
    targetHost,
    targetPort,
    { timeoutMs: 20_000 },
  );
  socket.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.on("error", () => socket.destroy());
  process.stdout.on("error", () => socket.destroy());
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exit(1);
});
