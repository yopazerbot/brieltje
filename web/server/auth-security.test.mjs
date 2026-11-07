import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const secret = randomBytes(32).toString('base64url');
const previous = process.env.ADMIN_PASSWORD;
const previousPin = process.env.MULTIPLAYER_PIN;
process.env.ADMIN_PASSWORD = secret;
process.env.MULTIPLAYER_PIN = '987654'; // obsolete deployment settings must not enable joining
const { Auth } = await import('./auth.mjs?security-regression');
if (previousPin === undefined) delete process.env.MULTIPLAYER_PIN;
else process.env.MULTIPLAYER_PIN = previousPin;
if (previous === undefined) delete process.env.ADMIN_PASSWORD;
else process.env.ADMIN_PASSWORD = previous;

function memoryStore() {
  return {
    meta: new Map(), sessions: [],
    async getMeta(key) { return this.meta.get(key); },
    async setMeta(key, value) { this.meta.set(key, value); },
    async pruneLog() {}, async log() {},
    async loadSessions() { return this.sessions; },
    async saveSession(key, username, role, expires) { this.sessions.push({ key, username, role, expires }); },
    async deleteSession(key) { this.sessions = this.sessions.filter((s) => s.key !== key); },
    async deleteSessionsOf(username) { this.sessions = this.sessions.filter((s) => s.username !== username); },
    accounts: new Map(),
    async getAccount(name) { return this.accounts.get(name) ?? null; },
  };
}
const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

test('guests join with a name only; reserved and account names stay out; the old PIN is wiped', async () => {
  const store = memoryStore();
  store.meta.set('pin', '123456'); // from before (Yoshi, 7 Nov 2026: no PIN)
  store.accounts.set('anna', { username: 'anna', pass: 'x', disabled: false });
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  assert.equal(store.meta.get('pin'), '');
  assert.equal((await auth.join(request, 'guest-one', () => false)).role, 'guest');
  assert.equal((await auth.join(request, 'guest-one', () => false)).code, 'nameToday'); // a name stays with whoever joined with it
  assert.equal((await auth.join(request, 'Anna', () => false)).code, 'nameAccount');
  assert.equal((await auth.join(request, 'admin', () => false)).code, 'nameTaken');
  assert.equal((await auth.join(request, 'x', () => false)).code, 'nameFormat');
  assert.equal((await auth.join(request, 'guest-two', () => true)).code, 'nameOnline');
  assert.equal((await auth.join(request, 'guest-two', () => false, false)).code, 'guestsOff');
  // A name being made into an account right now can't be taken.
  auth.claiming.add('guest-three');
  assert.equal((await auth.join(request, 'guest-three', () => false)).code, 'nameToday');
  // After a restart: the guest's session is back; one whose name became an account's is not.
  store.sessions.push({ key: 'k-old', username: 'anna', role: 'guest', expires: Date.now() + 60_000 });
  const restored = new Auth(store, false);
  restored.log = () => {};
  await restored.loadSessions();
  assert.deepEqual([...restored.sessions.values()].map((x) => x.username), ['guest-one']);
});

test('player sessions come back after a restart only while their account is there and on', async () => {
  const store = memoryStore();
  store.accounts.set('bram', { username: 'bram', pass: 'x', disabled: false });
  store.accounts.set('cato', { username: 'cato', pass: 'x', disabled: true });
  const later = Date.now() + 60_000;
  store.sessions.push({ key: 'k1', username: 'bram', role: 'player', expires: later }, { key: 'k2', username: 'cato', role: 'player', expires: later },
    { key: 'k3', username: 'dirk', role: 'player', expires: later }, { key: 'k4', username: 'admin', role: 'player', expires: later });
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  assert.deepEqual([...auth.sessions.values()].map((x) => x.username), ['bram']);
  assert.deepEqual(store.sessions.map((x) => x.key), ['k1']);
});

test("the admin password never logs in under a player's account name", async () => {
  const store = memoryStore();
  store.accounts.set('emma', { username: 'emma', pass: 'x', disabled: false });
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  assert.equal((await auth.login(request, 'emma', secret)).code, 'nameAccount');
  assert.equal((await auth.login(request, 'emma', 'wrong')).code, 'wrongPassword'); // without the password it says nothing about the name
  assert.equal((await auth.login(request, 'not-emma', secret)).role, 'admin');
});

test('admin login, device cookies and existing scrypt session fingerprints remain compatible', async () => {
  const store = memoryStore();
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  const fingerprint = store.meta.get('admin_fp');
  assert.ok(fingerprint.startsWith('scrypt$'));
  for (const wrong of [secret + '\0', secret.slice(1), secret + 'x']) {
    assert.equal((await auth.login(request, 'security-test', wrong)).status, 401);
  }
  const result = await auth.login(request, 'security-test', secret);
  assert.equal(result.role, 'admin');
  assert.equal(auth.knownDevice({ ...request, headers: { cookie: `briel_device=${result.device}` } }, '#admin'), true);
  const tampered = result.device.slice(0, -1) + (result.device.endsWith('A') ? 'B' : 'A');
  assert.equal(auth.knownDevice({ ...request, headers: { cookie: `briel_device=${tampered}` } }, '#admin'), false);
  const restored = new Auth(store, false);
  restored.log = () => {};
  await restored.loadSessions();
  assert.equal(store.meta.get('admin_fp'), fingerprint);
  assert.equal(restored.sessions.size, 1);
  assert.equal([...restored.sessions.values()][0].role, 'admin');
});

test('wrong admin guesses still hit the existing per-address rate limit', async () => {
  const auth = new Auth(memoryStore(), false);
  auth.log = () => {};
  for (let i = 0; i < 10; i++) assert.equal((await auth.login(request, 'security-test', 'wrong')).status, 401);
  assert.equal((await auth.login(request, 'security-test', secret)).status, 429);
});
