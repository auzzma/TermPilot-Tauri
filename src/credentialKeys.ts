import type { Credential, Host } from "./types";

const PUBLIC_KEY_PATTERN =
  /^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/]+={0,3}(?:\s+.*)?$/;

export function normalizedPublicKey(value: string) {
  const key = value.trim();
  if (!key || key.includes("\n") || !PUBLIC_KEY_PATTERN.test(key)) {
    throw new Error("The credential does not contain a valid SSH public key.");
  }
  return key;
}

export function authorizedKeyInstallCommand(publicKey: string) {
  const quotedKey = shellQuote(normalizedPublicKey(publicKey));
  const authorizedKeys = '"$HOME/.ssh/authorized_keys"';
  return [
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    `touch ${authorizedKeys}`,
    `chmod 600 ${authorizedKeys}`,
    `(grep -Fqx ${quotedKey} ${authorizedKeys} || printf '%s\\n' ${quotedKey} >> ${authorizedKeys})`,
  ].join(" && ");
}

export function hostLinkedToCredential(host: Host, credential: Credential): Host {
  return {
    ...host,
    authentication: "identityFile",
    credentialId: credential.id,
    password: undefined,
    identityFile: undefined,
    identityKey: undefined,
    publicKey: undefined,
    certificate: undefined,
    passphrase: undefined,
  };
}

export function hostForCredentialVerification(
  host: Host,
  credential: Credential,
): Host {
  return {
    ...host,
    username: host.username || credential.username,
    authentication: "identityFile",
    credentialId: undefined,
    password: undefined,
    identityFile: undefined,
    identityKey: credential.privateKey,
    publicKey: credential.publicKey,
    certificate: credential.certificate,
    passphrase: credential.passphrase,
  };
}

export function hasCompleteKeyPair(credential: Credential) {
  return (
    credential.kind === "identityKey" &&
    Boolean(credential.privateKey?.trim()) &&
    Boolean(credential.publicKey?.trim())
  );
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
