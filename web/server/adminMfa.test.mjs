// The admin's two-step login (server/adminMfa.mjs): RFC 6238's codes, setting it up, logging in with a code,
// no replay, recovery codes, wrong codes counted, and off again when ADMIN_PASSWORD changes.
// Run: node --test server/adminMfa.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const secretPass = randomBytes(18).toString('base64url');
const previous = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = secretPass;
const { Auth } = await import('./auth.mjs?mfa');
const { base32, stepOf, totp } = await import('./adminMfa.mjs');
if (previous === undefined) delete process.env.ADMIN_PASSWORD;
else process.env.ADMIN_PASSWORD = previous;

function memoryStore() {
  return {
    meta: new Map(), sessions: [],
    async getMeta(key) { return this.meta.get(key) ?? null; },
    async setMeta(key, value) { this.meta.set(key, value); },
    async pruneLog() {}, async log() {},
    async loadSessions() { return this.sessions; },
    async saveSession(key, username, role, expires) { this.sessions.push({ key, username, role, expires }); },
    async deleteSession(key) { this.sessions = this.sessions.filter((s) => s.key !== key); },
    async deleteSessionsOf(username) { this.sessions = this.sessions.filter((s) => s.username !== username); },
    async getAccount() { return null; },
  };
}
const req = (ip = '192.0.2.5') => ({ headers: {}, socket: { remoteAddress: ip } });

test("RFC 6238's test values (SHA-1), and base32", () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(totp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totp(secret, Math.floor(2000000000 / 30)), '279037');
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(stepOf(secret, '287082', 59_000), 1);
  assert.equal(stepOf(secret, '287 082', 59_000 + 30_000), 1, 'one step late, spaces allowed');
  assert.equal(stepOf(secret, '287082', 59_000 + 90_000), null, 'too late');
  assert.equal(stepOf(secret, '28708', 59_000), null);
});

async function setUp() {
  const store = memoryStore();
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  const first = await auth.login(req(), 'yoshi', secretPass);
  assert.equal(first.role, 'admin');
  const key = [...auth.sessions.keys()][0];
  const started = auth.mfa.start(key, 'yoshi');
  assert.match(started.uri, /^otpauth:\/\/totp\/Brieltje%3Ayoshi\?secret=[A-Z2-7]{32}&issuer=Brieltje/);
  assert.ok(started.qr.d.length > 100);
  const secret = auth.mfa.pending.get(key).secret;
  assert.equal(base32(secret), started.key.replace(/ /g, ''));
  return { store, auth, key, secret };
}

test('setting up: a wrong code keeps it off; the right one turns it on, gives 8 recovery codes, ends other admin sessions', async () => {
  const { auth, key, secret } = await setUp();
  const other = await auth.login(req('192.0.2.6'), 'yoshi2', secretPass);
  assert.equal(other.role, 'admin');
  assert.equal((await auth.mfa.confirm(key, '000000')).code, 'wrongCode');
  assert.equal(auth.mfa.on, false);
  const r = await auth.mfa.confirm(key, totp(secret, Math.floor(Date.now() / 30000)));
  assert.equal(r.ok, true);
  assert.equal(r.recovery.length, 8);
  assert.match(r.recovery[0], /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(auth.mfa.on, true);
  assert.deepEqual([...auth.sessions.keys()], [key], 'only the session that set it up is left');
  // On: a session alone can't put another phone in its place.
  assert.equal(auth.mfa.start(key, 'yoshi').code, 'mfaOn');
  assert.equal((await auth.mfa.confirm(key, totp(secret, Math.floor(Date.now() / 30000)))).code, 'mfaOn');
});

test('logging in: the password, then a code; a code works once; wrong ones count; a recovery code works once', async () => {
  const { auth, store, key, secret } = await setUp();
  const r = await auth.mfa.confirm(key, totp(secret, Math.floor(Date.now() / 30000) - 1));
  const asked = await auth.login(req('192.0.2.7'), 'yoshi', secretPass);
  assert.equal(asked.code, 'mfaNeeded');
  assert.equal(auth.failures.count('192.0.2.7', Date.now()), 1, 'still counted until a right code');
  assert.equal((await auth.login(req('192.0.2.7'), 'yoshi', 'wrong', '123456')).code, 'wrongPassword', 'the password first');
  assert.equal((await auth.login(req('192.0.2.7'), 'yoshi', secretPass, '000000')).code, 'wrongCode');
  const now = totp(secret, Math.floor(Date.now() / 30000));
  assert.equal((await auth.login(req('192.0.2.8'), 'yoshi', secretPass, now)).role, 'admin');
  assert.equal((await auth.login(req('192.0.2.9'), 'yoshi', secretPass, now)).code, 'wrongCode', 'the same code again: refused');
  // A recovery code, once.
  assert.equal((await auth.login(req('192.0.2.10'), 'yoshi', secretPass, r.recovery[0].toUpperCase())).role, 'admin');
  assert.equal((await auth.login(req('192.0.2.10'), 'yoshi', secretPass, r.recovery[0])).code, 'wrongCode');
  assert.equal(auth.mfa.view().recoveryLeft, 7);
  // The secret isn't in the store in the clear.
  assert.ok(!store.meta.get('admin_mfa').includes(base32(secret)));
  assert.ok(!store.meta.get('admin_mfa').includes(secret.toString('base64')));
  // Ten tries from one address, then that address waits (a right code too).
  for (let i = 0; i < 10; i++) await auth.login(req('192.0.2.11'), 'yoshi', secretPass, '000000');
  assert.equal((await auth.login(req('192.0.2.11'), 'yoshi', secretPass, totp(secret, Math.floor(Date.now() / 30000) + 1))).code, 'tooMany');
});

test('after a restart it is still on; a new ADMIN_PASSWORD turns it off', async () => {
  const { auth, store, key, secret } = await setUp();
  await auth.mfa.confirm(key, totp(secret, Math.floor(Date.now() / 30000)));
  const again = new Auth(store, false);
  again.log = () => {};
  await again.loadSessions();
  assert.equal(again.mfa.on, true);
  assert.equal((await again.login(req('192.0.2.20'), 'yoshi', secretPass)).code, 'mfaNeeded');
  // As after ADMIN_PASSWORD changed in Railway: the fingerprint no longer matches.
  const reset = new Auth(store, false);
  reset.log = () => {};
  await reset.mfa.load(true);
  assert.equal(reset.mfa.on, false);
  assert.equal(store.meta.get('admin_mfa'), '');
});

test('off and new recovery codes each need a code', async () => {
  const { auth, key, secret } = await setUp();
  await auth.mfa.confirm(key, totp(secret, Math.floor(Date.now() / 30000) - 1));
  assert.equal((await auth.mfa.change('codes', '000000', 'yoshi')).code, 'wrongCode');
  const fresh = await auth.mfa.change('codes', totp(secret, Math.floor(Date.now() / 30000)), 'yoshi');
  assert.equal(fresh.recovery.length, 8);
  assert.equal((await auth.mfa.change('off', fresh.recovery[1], 'yoshi')).ok, true);
  assert.equal(auth.mfa.on, false);
  assert.equal((await auth.login(req('192.0.2.30'), 'yoshi', secretPass)).role, 'admin');
});
