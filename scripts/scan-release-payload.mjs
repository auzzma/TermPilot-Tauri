import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const roots = process.argv.slice(2).map((value) => path.resolve(value));
if (roots.length === 0) {
  throw new Error("At least one release payload path is required");
}

const exactValues = [
  { kind: "home", value: process.env.TERMPILOT_SCAN_HOME },
  { kind: "identity", value: process.env.TERMPILOT_SCAN_HOSTNAME },
  { kind: "identity", value: process.env.TERMPILOT_SCAN_COMPUTER_NAME },
  { kind: "project", value: process.env.TERMPILOT_SCAN_PROJECT_PATH },
]
  .filter(({ value }) => value && value.length >= 3)
  .flatMap(({ kind, value }) => [
    { kind, value },
    { kind, value: value.replaceAll("/", "\\") },
  ]);

const findings = [];
for (const root of roots) {
  for (const file of await files(root)) {
    const content = await readFile(file);
    for (const { kind, value } of exactValues) {
      // Official Node macOS binaries contain the upstream build path
      // /Users/admin/build/ws. Their checksums are verified before packaging.
      if (kind === "home" && isBundledNodeRuntime(file)) continue;
      if (content.includes(Buffer.from(value))) {
        findings.push({
          file: path.relative(process.cwd(), file),
          value,
        });
      }
    }
  }
}

if (findings.length > 0) {
  process.stderr.write("Release payload contains local build information:\n");
  for (const finding of findings.slice(0, 50)) {
    process.stderr.write(`- ${finding.file}: ${JSON.stringify(finding.value)}\n`);
  }
  if (findings.length > 50) {
    process.stderr.write(`- ${findings.length - 50} additional matches\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Release privacy scan passed for ${roots.length} payload(s).\n`,
  );
}

function isBundledNodeRuntime(file) {
  const normalized = file.split(path.sep).join("/");
  return (
    normalized.endsWith("/node/bin/node") ||
    normalized.endsWith("/node/node.exe")
  );
}

async function files(root) {
  const result = [];
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) {
    return result;
  }
  if (!metadata.isDirectory()) {
    return [root];
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      result.push(...(await files(candidate)));
    } else if (entry.isFile()) {
      result.push(candidate);
    }
  }
  return result;
}
