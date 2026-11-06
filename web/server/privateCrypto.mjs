// Sealed files for the private data (the insides of the three locked homes).
//
// The repository is public, so the private data is committed encrypted (web/private/<name>.enc) and
// only the production server can open it. Anyone can seal (the public key is public); only the
// holder of PRIVATE_DATA_KEY can open. This is ECIES: an ephemeral X25519 key per file, HKDF to an
// AES-256-GCM key.
//
// File format (all bytes, no text):
//   'BPD2' (4) | ephemeral X25519 public key, raw (32) | nonce (12) | GCM tag (16) | ciphertext
// The plaintext is padded before sealing: 4-byte big-endian length | content | zeros up to the next multiple of 16 KiB
// (at least one block), so neither the .enc size nor anything else public tells how long a file is.
// Shared secret = X25519(ephemeral private, server public).
// AES key = HKDF-SHA256(secret, salt = ephemeral public || server public, info = CONTEXT + name, 32).
// AAD = CONTEXT + name, so a file only opens under the name it was sealed for (no swapping).
//
// The server's private key is PRIVATE_DATA_KEY itself: 32 random bytes (64 hex or 44 base64 characters),
// used as the raw X25519 private key. No password and no key derivation: the public key reveals nothing
// that can be guessed against, and the admin password plays no part.

import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';

export const MAGIC = Buffer.from('BPD2');
export const BLOCK = 16384;
export const CONTEXT = 'brieltje-private-v2|';
export const NAME_RE = /^[a-z0-9_.-]{1,64}$/;
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const HEADER = MAGIC.length + 32 + 12 + 16;

function checkName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') throw new Error('bad private file name');
}

const privateFromRaw = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const publicFromRaw = (raw) => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
const rawPublic = (publicKey) => Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');

/** First 16 hex characters of the SHA-256 of the raw public key. */
export const keyId = (publicRaw) => createHash('sha256').update(publicRaw).digest('hex').slice(0, 16);

/** Parse PRIVATE_DATA_KEY: exactly 32 bytes as 64 hex characters or 44 base64 characters. Throws otherwise. */
function parseSecret(secret) {
  if (typeof secret !== 'string') throw new Error('the private data key must be 32 random bytes as 64 hex or 44 base64 characters');
  let raw = null;
  if (/^[0-9a-fA-F]{64}$/.test(secret)) raw = Buffer.from(secret, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    raw = Buffer.from(secret, 'base64');
    if (raw.toString('base64') !== secret) raw = null;
  }
  if (!raw || raw.length !== 32) throw new Error('the private data key must be 32 random bytes as 64 hex or 44 base64 characters');
  return raw;
}

/** The server's key pair from PRIVATE_DATA_KEY, the raw X25519 private key. { privateKey: KeyObject, publicRaw: Buffer(32), id } */
export function keyPairFromSecret(secret) {
  const raw = parseSecret(secret);
  const privateKey = privateFromRaw(raw);
  const publicRaw = rawPublic(createPublicKey(privateKey));
  return { privateKey, publicRaw, id: keyId(publicRaw) };
}

function aesKey(secret, ephPub, serverPub, name) {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.concat([ephPub, serverPub]), CONTEXT + name, 32));
}

/** Seal `plain` (Buffer) for the server's raw public key under `name`. Returns the file's bytes. */
export function seal(publicKeyRaw, name, plain) {
  checkName(name);
  if (!Buffer.isBuffer(publicKeyRaw) || publicKeyRaw.length !== 32) throw new Error('bad public key');
  const eph = generateKeyPairSync('x25519');
  const ephPub = rawPublic(eph.publicKey);
  const secret = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(publicKeyRaw) });
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey(secret, ephPub, publicKeyRaw, name), nonce);
  c.setAAD(Buffer.from(CONTEXT + name));
  const size = Math.max(1, Math.ceil((plain.length + 4) / BLOCK)) * BLOCK;
  const padded = Buffer.alloc(size);
  padded.writeUInt32BE(plain.length, 0);
  plain.copy(padded, 4);
  const body = Buffer.concat([c.update(padded), c.final()]);
  return Buffer.concat([MAGIC, ephPub, nonce, c.getAuthTag(), body]);
}

/** Open a sealed file with the private KeyObject. Throws when it is not for this key and name, or was changed. */
export function open(privateKey, name, file) {
  checkName(name);
  if (!Buffer.isBuffer(file) || file.length < HEADER || !file.subarray(0, 4).equals(MAGIC)) throw new Error('not a sealed file');
  const ephPub = file.subarray(4, 36);
  const nonce = file.subarray(36, 48);
  const tag = file.subarray(48, 64);
  const secret = diffieHellman({ privateKey, publicKey: publicFromRaw(ephPub) });
  const serverPub = rawPublic(createPublicKey(privateKey));
  const d = createDecipheriv('aes-256-gcm', aesKey(secret, ephPub, serverPub, name), nonce);
  d.setAAD(Buffer.from(CONTEXT + name));
  d.setAuthTag(tag);
  const padded = Buffer.concat([d.update(file.subarray(HEADER)), d.final()]);
  const length = padded.length >= 4 ? padded.readUInt32BE(0) : -1;
  if (length < 0 || length > padded.length - 4) throw new Error('not a sealed file');
  return padded.subarray(4, 4 + length);
}
