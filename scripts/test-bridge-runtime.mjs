import { strict as assert } from "node:assert";
import { access, readFile, readdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeRoot = path.join(root, "bridge");
const files = await cjsFiles(bridgeRoot);

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `Syntax check failed for ${path.relative(root, file)}:\n${result.stderr}`,
  );
}

const require = createRequire(import.meta.url);
const sftp = require(path.join(
  bridgeRoot,
  "sftp-bridge/termpilot-sftp-bridge.cjs",
));
const proxy = require(path.join(
  bridgeRoot,
  "proxy-bridge/proxyUtils.cjs",
));
assert.equal(typeof sftp.handleCommand, "function");
assert.equal(typeof sftp.handleScpCommand, "function");
assert.equal(typeof sftp.executeRequestCommand, "function");
assert.equal(typeof proxy.createProxySocket, "function");

const execResult = await sftp.executeRequestCommand(
  {
    exec(_command, _options, callback) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.write = () => {};
      stream.end = () => {};
      stream.close = () => {};
      callback(null, stream);
      queueMicrotask(() => {
        stream.emit("data", Buffer.from("bridge-exec-ok"));
        stream.emit("close", 0, null);
      });
    },
  },
  { username: "root" },
  { action: "exec", command: "printf bridge-exec-ok", timeoutMS: 1000 },
);
assert.equal(execResult.stdout, "bridge-exec-ok");
assert.equal(execResult.code, 0);

const remoteFiles = new Map();
const bridgeMessages = [];
const fakeSftp = {
  lstat(remotePath, callback) {
    if (remoteFiles.has(remotePath)) {
      callback(null, { mode: 0o100644 });
    } else {
      callback(new Error("No such file"));
    }
  },
  createWriteStream(remotePath) {
    const stream = new EventEmitter();
    stream.end = (content) => {
      queueMicrotask(() => {
        stream.emit("open");
        stream.emit("ready");
        remoteFiles.set(remotePath, Buffer.from(content));
        stream.emit("close");
      });
    };
    return stream;
  },
  rename(oldPath, newPath, callback) {
    remoteFiles.set(newPath, remoteFiles.get(oldPath));
    remoteFiles.delete(oldPath);
    callback(null);
  },
};
await sftp.handleCommand({
  conn: {},
  sftp: fakeSftp,
  config: { filenameEncoding: "utf-8" },
  activeTransfers: new Map(),
  request: {
    id: 41,
    action: "writeText",
    path: "sshd_config",
    content: "PermitRootLogin no\n",
    overwrite: true,
  },
  writeMessage: (message) => bridgeMessages.push(message),
});
assert.deepEqual(bridgeMessages.at(-1), {
  id: 41,
  ok: true,
  result: {},
});
assert.equal(
  remoteFiles.get("sshd_config").toString("utf8"),
  "PermitRootLogin no\n",
);

const protocolPath = path.join(
  root,
  "node_modules/ssh2/lib/protocol/Protocol.js",
);
await access(protocolPath);
const protocol = await readFile(protocolPath, "utf8");
assert.match(protocol, /signature\._signatureAlgorithm/);
assert.match(protocol, /RE_IDENT = \/\^SSH-\(2\\\.0\|1\\\.99\)-\(\[\^ \]\*\)/);

process.stdout.write(
  `Bridge smoke test passed for ${files.length} CJS files.\n`,
);

async function cjsFiles(directory) {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      values.push(...(await cjsFiles(candidate)));
    } else if (entry.name.endsWith(".cjs")) {
      values.push(candidate);
    }
  }
  return values.sort();
}
