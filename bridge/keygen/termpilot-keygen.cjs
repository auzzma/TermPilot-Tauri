'use strict';

const path = require('path');
const { createRequire } = require('module');

function loadSSH2() {
  const explicitRoot = process.env.TERMPILOT_SSH2_NODE_MODULES;
  if (explicitRoot) {
    return createRequire(path.join(explicitRoot, 'termpilot-keygen.cjs'))('ssh2');
  }
  return require('ssh2');
}

function readConfiguration() {
  const encoded = process.env.TERMPILOT_KEYGEN_CONFIG_B64;
  if (!encoded) throw new Error('Key generation configuration is missing.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function optionsFor(configuration) {
  const type = String(configuration.keyType || '').toLowerCase();
  const options = {
    comment: String(configuration.comment || ''),
  };
  if (type === 'ecdsa') {
    if (![256, 384, 521].includes(configuration.bits)) {
      throw new Error('ECDSA bits must be 256, 384, or 521.');
    }
    options.bits = configuration.bits;
  } else if (type === 'rsa') {
    if (![1024, 2048, 4096].includes(configuration.bits)) {
      throw new Error('RSA bits must be 1024, 2048, or 4096.');
    }
    options.bits = configuration.bits;
  } else if (type !== 'ed25519') {
    throw new Error('Key type must be ED25519, ECDSA, or RSA.');
  }
  if (configuration.passphrase) {
    options.passphrase = String(configuration.passphrase);
    options.cipher = 'aes256-ctr';
  }
  return { type, options };
}

try {
  const configuration = readConfiguration();
  const { type, options } = optionsFor(configuration);
  const { generateKeyPairSync } = loadSSH2().utils;
  const pair = generateKeyPairSync(type, options);
  process.stdout.write(JSON.stringify({
    privateKey: pair.private,
    publicKey: pair.public,
  }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
