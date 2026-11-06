import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { BLOCK, keyId, keyPairFromSecret, open, seal } from './privateCrypto.mjs';

const newSecret = () => randomBytes(32).toString('base64');
const pair = keyPairFromSecret(newSecret());
const other = keyPairFromSecret(newSecret());
const plain = randomBytes(5000);

test('a sealed file opens with the matching key and name', () => {
  const f = seal(pair.publicRaw, 'house.json', plain);
  assert.equal(f.length, 64 + BLOCK, 'padded to a block');
  assert.ok(open(pair.privateKey, 'house.json', f).equals(plain));
  assert.equal(seal(pair.publicRaw, 'a.json', randomBytes(10)).length, seal(pair.publicRaw, 'a.json', randomBytes(10000)).length, 'the length is hidden');
  const big = randomBytes(BLOCK * 2 + 5);
  assert.equal(seal(pair.publicRaw, 'big', big).length, 64 + BLOCK * 3);
  assert.ok(open(pair.privateKey, 'big', seal(pair.publicRaw, 'big', big)).equals(big));
  assert.equal(seal(pair.publicRaw, 'e', Buffer.alloc(0)).length, 64 + BLOCK);
  assert.ok(open(pair.privateKey, 'empty', seal(pair.publicRaw, 'empty', Buffer.alloc(0))).equals(Buffer.alloc(0)));
});

test('the same secret gives the same key, in hex or base64, with a 16 hex id', () => {
  const raw = randomBytes(32);
  const a = keyPairFromSecret(raw.toString('base64'));
  const b = keyPairFromSecret(raw.toString('hex'));
  assert.ok(a.publicRaw.equals(b.publicRaw));
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.equal(a.id, keyId(a.publicRaw));
  assert.equal(a.id, keyPairFromSecret(raw.toString('hex').toUpperCase()).id);
});

test('malformed secrets are refused', () => {
  const raw = randomBytes(32);
  const bad = [
    '', 'hunter2', 'a long passphrase with spaces that is not a key at all',
    raw.toString('hex').slice(0, 62), raw.toString('hex') + '00', raw.subarray(0, 31).toString('base64'),
    randomBytes(33).toString('base64'), raw.toString('base64').slice(0, 43), raw.toString('base64').replace('=', ''),
    Buffer.alloc(32, 0xfb).toString('base64url') + '=', // base64url letters (- and _); fixed bytes, so it never equals plain base64 ' ' + raw.toString('base64'), raw.toString('base64') + '\n',
    raw.toString('base64').slice(0, 10) + '*' + raw.toString('base64').slice(11),
    raw.toString('hex').slice(0, 63) + 'g', null, undefined, 42, raw,
  ];
  for (const s of bad) assert.throws(() => keyPairFromSecret(s), /private data key/, String(s));
});

test('a key does not depend on ADMIN_PASSWORD', () => {
  const secret = newSecret();
  const before = process.env.ADMIN_PASSWORD;
  try {
    process.env.ADMIN_PASSWORD = 'one';
    const a = keyPairFromSecret(secret);
    process.env.ADMIN_PASSWORD = 'two';
    assert.equal(keyPairFromSecret(secret).id, a.id);
  } finally {
    if (before === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = before;
  }
});

test('wrong name, wrong key, tampering, short files and bad magic are refused', () => {
  const f = seal(pair.publicRaw, 'a', plain);
  assert.throws(() => open(pair.privateKey, 'b', f));
  assert.throws(() => open(other.privateKey, 'a', f));
  for (const i of [5, 40, 50, 100, f.length - 1]) {
    const t = Buffer.from(f);
    t[i] ^= 1;
    assert.throws(() => open(pair.privateKey, 'a', t), `byte ${i}`);
  }
  assert.throws(() => open(pair.privateKey, 'a', f.subarray(0, 63)));
  assert.throws(() => open(pair.privateKey, 'a', Buffer.alloc(0)));
  const m = Buffer.from(f);
  m[0] = 0x58;
  assert.throws(() => open(pair.privateKey, 'a', m), /not a sealed file/);
});

test('names must be plain', () => {
  for (const n of ['', '../x', 'a/b', 'A', 'x'.repeat(65), '..', '.']) assert.throws(() => seal(pair.publicRaw, n, plain), `${n}`);
});
