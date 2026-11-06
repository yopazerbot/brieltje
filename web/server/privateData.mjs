// The private data in memory (the insides of the three locked homes, see privateCrypto.mjs).
//
// At start the server takes its key pair from PRIVATE_DATA_KEY (32 random bytes, see privateCrypto.mjs) and
// opens every web/private/*.enc. A file that doesn't open is skipped and logged once, by name only. A plain
// copy in web/.private/<name> (git-ignored, only on a development PC) wins, so the tools and the dev server
// work without the key. Without a valid key nothing opens (logged once, never the value) and
// /api/private/key answers 404.
//
// Import this module before the game modules (server.mjs does): its top-level await has finished
// by the time they run.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { keyPairFromSecret, NAME_RE, open } from './privateCrypto.mjs';

const ROOT = join(import.meta.dirname, '..');

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function list(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Load the private data. All options are for tests. */
export function loadPrivateData({
  secret = process.env.PRIVATE_DATA_KEY || '',
  sealedDir = join(ROOT, 'private'),
  plainDir = join(ROOT, '.private'),
  keyFile = join(ROOT, 'shared', 'private-key.json'),
  log = (line) => console.log(line),
} = {}) {
  let pair = null;
  if (!secret) log(JSON.stringify({ event: 'private-data-key-missing' }));
  else {
    try {
      pair = keyPairFromSecret(secret);
    } catch {
      log(JSON.stringify({ event: 'private-data-key-invalid' })); // never the value
    }
  }
  const expectedKeyId = readJsonFile(keyFile)?.id ?? null;
  const files = new Map();
  const opened = [];
  const failed = [];
  for (const f of list(sealedDir)) {
    if (!f.endsWith('.enc')) continue;
    const name = f.slice(0, -4);
    if (!NAME_RE.test(name)) continue;
    if (!pair) {
      failed.push(name);
      continue;
    }
    try {
      files.set(name, open(pair.privateKey, name, readFileSync(join(sealedDir, f))));
      opened.push(name);
    } catch {
      failed.push(name);
      log(JSON.stringify({ event: 'private-data-failed', name }));
    }
  }
  // Development: a plain copy wins.
  for (const name of list(plainDir)) {
    if (!NAME_RE.test(name)) continue;
    try {
      files.set(name, readFileSync(join(plainDir, name)));
      if (!opened.includes(name)) opened.push(name);
      const i = failed.indexOf(name);
      if (i >= 0) failed.splice(i, 1);
    } catch { /* a folder or unreadable file: skipped */ }
  }
  opened.sort();
  failed.sort();
  return {
    /** The Buffer of a file, or null. */
    get: (name) => files.get(name) ?? null,
    /** The raw public key and id for /api/private/key, or null without a password. */
    publicKey: () => (pair ? { key: pair.publicRaw.toString('base64url'), id: pair.id } : null),
    /** Names only, never contents. */
    status: () => ({ keyId: pair?.id ?? null, expectedKeyId, opened: [...opened], failed: [...failed] }),
  };
}

export const privateData = loadPrivateData();
