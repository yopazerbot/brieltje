// Seal the private data for the public repository. No secret is needed here: sealing uses the
// server's PUBLIC key (web/shared/private-key.json). Only the production server can open the files.
//
//   node tools/private_data.mjs seal                  seal changed files of web/.private/ into web/private/*.enc
//   node tools/private_data.mjs reseal [--from URL]   fetch the live public key; if it changed, store it and seal everything again
//   node tools/private_data.mjs status                what is sealed, what changed, whether the live key matches
//
// The public manifest (web/private/manifest.json) holds only the names and the key id of each file: no hash and no size
// of the plain data (a hash of a small file can be guessed and confirmed; the sealed files are padded to 16 KiB blocks,
// see server/privateCrypto.mjs). What was last sealed is remembered in web/.sealed.json (git-ignored, the plain SHA-256),
// which lets a re-run skip unchanged files, because every seal is random and would otherwise change the .enc file (and the
// diff) each time. Without that record, seal seals everything again.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyId, NAME_RE, seal } from '../web/server/privateCrypto.mjs';

const WEB = join(import.meta.dirname, '..', 'web');
const PLAIN = join(WEB, '.private');
const SEALED = join(WEB, 'private');
const MANIFEST = join(SEALED, 'manifest.json');
const RECORD = join(WEB, '.sealed.json'); // local, git-ignored: the plain SHA-256 of what was last sealed
const KEYFILE = join(WEB, 'shared', 'private-key.json');
const DEFAULT_FROM = 'https://brieltje.be';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);
const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);

function plainFiles() {
  if (!existsSync(PLAIN)) return [];
  return readdirSync(PLAIN).filter((n) => {
    if (!NAME_RE.test(n)) {
      console.warn(`skipped (name not allowed): ${n}`);
      return false;
    }
    return true;
  }).sort();
}

function committedKey() {
  const k = readJson(KEYFILE, { key: null, id: null });
  if (!k.key || !k.id) throw new Error('web/shared/private-key.json has no key yet. Run: node tools/private_data.mjs reseal --from https://brieltje.be');
  const raw = Buffer.from(k.key, 'base64url');
  if (raw.length !== 32 || keyId(raw) !== k.id) throw new Error('web/shared/private-key.json is inconsistent (id does not match key).');
  return { raw, id: k.id };
}

/** Seal what changed (or everything with `all`). Returns the names written. */
function sealAll({ all = false } = {}) {
  const key = committedKey();
  mkdirSync(SEALED, { recursive: true });
  const manifest = readJson(MANIFEST, {});
  const record = readJson(RECORD, {});
  const names = plainFiles();
  const written = [];
  for (const name of names) {
    const plain = readFileSync(join(PLAIN, name));
    const m = manifest[name];
    const r = record[name];
    if (!all && m && r && r.sha256 === sha(plain) && r.key === key.id && m.key === key.id && existsSync(join(SEALED, `${name}.enc`))) continue;
    writeFileSync(join(SEALED, `${name}.enc`), seal(key.raw, name, plain));
    manifest[name] = { key: key.id };
    record[name] = { sha256: sha(plain), key: key.id };
    written.push(name);
  }
  for (const name of Object.keys(record)) if (!names.includes(name)) delete record[name];
  writeJson(RECORD, record);
  const removed = [];
  for (const f of readdirSync(SEALED)) {
    if (!f.endsWith('.enc')) continue;
    const name = f.slice(0, -4);
    if (names.includes(name)) continue;
    rmSync(join(SEALED, f));
    delete manifest[name];
    removed.push(name);
  }
  for (const name of Object.keys(manifest)) if (!names.includes(name)) delete manifest[name];
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  if (Object.keys(sorted).length) writeJson(MANIFEST, sorted);
  else rmSync(MANIFEST, { force: true });
  console.log(`sealed: ${written.join(', ') || 'nothing changed'}${removed.length ? `; removed: ${removed.join(', ')}` : ''}`);
  return written;
}

async function liveKey(from) {
  const res = await fetch(new URL('/api/private/key', from));
  if (!res.ok) throw new Error(`${from} answered ${res.status} for /api/private/key (is PRIVATE_DATA_KEY set there, and is the new server deployed?)`);
  const k = await res.json();
  const raw = Buffer.from(String(k.key), 'base64url');
  if (raw.length !== 32 || keyId(raw) !== k.id) throw new Error('the live key is malformed');
  return { key: k.key, id: k.id };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];
if (cmd === 'seal') {
  sealAll();
} else if (cmd === 'reseal') {
  const from = arg('--from') || DEFAULT_FROM;
  const live = await liveKey(from);
  const have = readJson(KEYFILE, { key: null, id: null });
  const sealedNow = existsSync(SEALED) ? readdirSync(SEALED).filter((f) => f.endsWith('.enc')).map((f) => f.slice(0, -4)) : [];
  const missing = sealedNow.filter((n) => !existsSync(join(PLAIN, n)));
  if (live.id === have.id && !missing.length) {
    console.log(`key ${live.id} is current; nothing to do (run seal for changed files).`);
  } else {
    if (missing.length) {
      console.error(`Cannot reseal: these files are sealed but their plain copy is missing from web/.private/: ${missing.join(', ')}.`);
      console.error('Put every plain file back first (they are never in git), then run reseal again.');
      process.exit(1);
    }
    writeJson(KEYFILE, live);
    console.log(`public key ${have.id ?? '(none)'} -> ${live.id}`);
    sealAll({ all: true });
  }
} else if (cmd === 'status') {
  const have = readJson(KEYFILE, { key: null, id: null });
  const manifest = readJson(MANIFEST, {});
  const record = readJson(RECORD, {});
  console.log(`committed key id: ${have.id ?? '(none)'}`);
  for (const name of [...new Set([...Object.keys(manifest), ...plainFiles()])].sort()) {
    const m = manifest[name];
    const p = join(PLAIN, name);
    const plain = existsSync(p) ? readFileSync(p) : null;
    const state = !m ? 'not sealed yet' : !plain ? 'sealed, no plain copy here' : !record[name] ? 'sealed, no local record (seal again)' : sha(plain) !== record[name].sha256 ? 'changed, needs seal' : m.key !== have.id ? 'sealed for an older key' : 'up to date';
    console.log(`  ${name}: ${state}`);
  }
  try {
    const live = await liveKey(arg('--from') || DEFAULT_FROM);
    console.log(`live key id: ${live.id} (${live.id === have.id ? 'matches' : 'DIFFERS: run reseal'})`);
  } catch (e) {
    console.log(`live key: not checked (${e.message})`);
  }
} else {
  console.error('usage: node tools/private_data.mjs seal | reseal [--from URL] | status [--from URL]');
  process.exit(2);
}
