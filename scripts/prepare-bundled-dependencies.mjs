import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "node_modules");
const destinationRoot = path.join(root, "runtime", "node_modules");

const packages = {
  ssh2: [
    "lib",
    "LICENSE",
    "package.json",
  ],
  asn1: [
    "lib",
    "LICENSE",
    "package.json",
  ],
  "bcrypt-pbkdf": [
    "index.js",
    "LICENSE",
    "package.json",
  ],
  "iconv-lite": [
    "encodings",
    "lib/bom-handling.js",
    "lib/index.js",
    "lib/streams.js",
    "LICENSE",
    "package.json",
  ],
  "safer-buffer": [
    "dangerous.js",
    "safer.js",
    "LICENSE",
    "package.json",
  ],
  tweetnacl: [
    "nacl-fast.js",
    "LICENSE",
    "package.json",
  ],
};

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true });

for (const [packageName, entries] of Object.entries(packages)) {
  const source = path.join(sourceRoot, packageName);
  const destination = path.join(destinationRoot, packageName);
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    await cp(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
    });
  }
}

const sshCryptoDirectory = path.join(
  destinationRoot,
  "ssh2",
  "lib",
  "protocol",
  "crypto",
);
await rm(path.join(sshCryptoDirectory, "build"), {
  recursive: true,
  force: true,
});
await rm(path.join(sshCryptoDirectory, "src"), {
  recursive: true,
  force: true,
});
await rm(path.join(sshCryptoDirectory, "binding.gyp"), { force: true });

const manifest = {
  packages: Object.keys(packages),
  generatedBy: "scripts/prepare-bundled-dependencies.mjs",
};
await writeFile(
  path.join(destinationRoot, "BUNDLE-MANIFEST.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const require = createRequire(path.join(destinationRoot, "bundle-check.cjs"));
const ssh2 = require("ssh2");
const iconv = require("iconv-lite");
if (typeof ssh2.Client !== "function") {
  throw new Error("Bundled ssh2 runtime is incomplete");
}
const encodingProbe = "TermPilot 编码检查";
if (iconv.decode(iconv.encode(encodingProbe, "gbk"), "gbk") !== encodingProbe) {
  throw new Error("Bundled iconv-lite runtime is incomplete");
}

for (const packageName of Object.keys(packages)) {
  const packageJson = JSON.parse(
    await readFile(
      path.join(destinationRoot, packageName, "package.json"),
      "utf8",
    ),
  );
  process.stdout.write(
    `Prepared ${packageName}@${packageJson.version}\n`,
  );
}
