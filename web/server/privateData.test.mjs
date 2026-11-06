import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keyPairFromSecret, seal } from './privateCrypto.mjs';
import { loadPrivateData } from './privateData.mjs';

test('opens sealed files, skips the ones that fail, lets a plain copy win', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bpd-'));
  try {
    const pw = randomBytes(32).toString('base64');
    const pair = keyPairFromSecret(pw);
    const other = keyPairFromSecret(randomBytes(32).toString('hex'));
    const sealedDir = join(dir, 'private');
    const plainDir = join(dir, '.private');
    mkdirSync(sealedDir);
    mkdirSync(plainDir);
    writeFileSync(join(sealedDir, 'good.json.enc'), seal(pair.publicRaw, 'good.json', Buffer.from('{"a":1}')));
    writeFileSync(join(sealedDir, 'foreign.enc'), seal(other.publicRaw, 'foreign', Buffer.from('x')));
    writeFileSync(join(sealedDir, 'dev.enc'), seal(pair.publicRaw, 'dev', Buffer.from('sealed')));
    writeFileSync(join(plainDir, 'dev'), 'plain');
    const keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, JSON.stringify({ key: 'x', id: pair.id }));
    const lines = [];
    const d = loadPrivateData({ secret: pw, sealedDir, plainDir, keyFile, log: (l) => lines.push(l) });
    assert.equal(d.get('good.json').toString(), '{"a":1}');
    assert.equal(d.get('dev').toString(), 'plain');
    assert.equal(d.get('foreign'), null);
    assert.equal(d.get('missing'), null);
    assert.deepEqual(d.status(), { keyId: pair.id, expectedKeyId: pair.id, opened: ['dev', 'good.json'], failed: ['foreign'] });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /foreign/);
    assert.equal(d.publicKey().id, pair.id);

    const noneLines = [];
    const none = loadPrivateData({ secret: '', sealedDir, plainDir: join(dir, 'nope'), keyFile, log: (l) => noneLines.push(l) });
    assert.deepEqual(noneLines, ['{"event":"private-data-key-missing"}']);
    const badLines = [];
    const bad = loadPrivateData({ secret: 'not a key at all', sealedDir, plainDir: join(dir, 'nope'), keyFile, log: (l) => badLines.push(l) });
    assert.deepEqual(badLines, ['{"event":"private-data-key-invalid"}']);
    assert.equal(bad.publicKey(), null);
    assert.equal(bad.get('good.json'), null);
    assert.equal(none.get('good.json'), null);
    assert.equal(none.publicKey(), null);
    assert.equal(none.status().keyId, null);
    assert.deepEqual(none.status().opened, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
