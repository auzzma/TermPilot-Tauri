import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import extractZip from "extract-zip";
import { extract as extractTar } from "tar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.TERMPILOT_NODE_VERSION || "v22.16.0";
const platform = process.env.TERMPILOT_RUNTIME_PLATFORM || process.platform;
const architecture =
  process.env.TERMPILOT_RUNTIME_ARCHITECTURE ||
  (process.arch === "arm64" ? "arm64" : "x64");
const distributionPlatform =
  platform === "win32" ? "win" : platform === "darwin" ? "darwin" : "linux";
const extension = platform === "win32" ? "zip" : "tar.gz";
const archiveName = `node-${version}-${distributionPlatform}-${architecture}.${extension}`;
const distributionName = archiveName.replace(`.${extension}`, "");
const cacheDirectory = path.join(root, ".runtime-cache", "node", version);
const archivePath = path.join(cacheDirectory, archiveName);
const runtimeDirectory = path.join(root, "runtime", "node");
const temporaryDirectory = path.join(root, "runtime", "node.tmp");
const expectedExecutable =
  platform === "win32"
    ? path.join(runtimeDirectory, "node.exe")
    : path.join(runtimeDirectory, "bin", "node");

if (
  await exists(expectedExecutable) &&
  process.env.TERMPILOT_FORCE_RUNTIME !== "1"
) {
  process.stdout.write(`Node bridge runtime already exists at ${runtimeDirectory}\n`);
  process.exit(0);
}

await mkdir(cacheDirectory, { recursive: true });
const baseUrl = `https://nodejs.org/dist/${version}`;
await download(`${baseUrl}/${archiveName}`, archivePath);
const checksumPath = path.join(cacheDirectory, "SHASUMS256.txt");
await download(`${baseUrl}/SHASUMS256.txt`, checksumPath);
await verifyChecksum(archivePath, checksumPath, archiveName);

await rm(temporaryDirectory, { recursive: true, force: true });
await mkdir(temporaryDirectory, { recursive: true });
if (platform === "win32") {
  await extractZip(archivePath, { dir: temporaryDirectory });
} else {
  await extractTar({ file: archivePath, cwd: temporaryDirectory });
}

const extractedDirectory = path.join(temporaryDirectory, distributionName);
await rm(runtimeDirectory, { recursive: true, force: true });
await mkdir(path.dirname(runtimeDirectory), { recursive: true });
await rename(extractedDirectory, runtimeDirectory);
await rm(temporaryDirectory, { recursive: true, force: true });
await pruneRuntime(runtimeDirectory);

if (platform !== "win32") {
  await chmod(expectedExecutable, 0o755);
}

const licenseSource = path.join(runtimeDirectory, "LICENSE");
if (await exists(licenseSource)) {
  await mkdir(path.join(root, "runtime", "licenses"), { recursive: true });
  await cp(
    licenseSource,
    path.join(root, "runtime", "licenses", `Node-${version}.txt`),
  );
}

process.stdout.write(`Prepared Node bridge runtime at ${runtimeDirectory}\n`);

async function download(url, output) {
  if (await exists(output)) return;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  }
  await finished(Readable.fromWeb(response.body).pipe(createWriteStream(output)));
}

async function verifyChecksum(file, checksumFile, name) {
  const lines = (await readFile(checksumFile, "utf8")).split(/\r?\n/);
  const line = lines.find((value) => value.endsWith(`  ${name}`));
  if (!line) throw new Error(`Checksum for ${name} is missing`);
  const expected = line.split(/\s+/)[0];
  const actual = createHash("sha256").update(await readFile(file)).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${name}`);
  }
}

async function pruneRuntime(directory) {
  const keep = new Set(
    platform === "win32" ? ["node.exe", "LICENSE"] : ["bin", "LICENSE"],
  );
  for (const entry of await readdir(directory)) {
    if (!keep.has(entry)) {
      await rm(path.join(directory, entry), { recursive: true, force: true });
    }
  }
  if (platform !== "win32") {
    for (const entry of await readdir(path.join(directory, "bin"))) {
      if (entry !== "node") {
        await rm(path.join(directory, "bin", entry), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
