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
  };
}
const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

test('guest joining requires an admin-saved PIN and the setting survives restart', async () => {
  const store = memoryStore();
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  assert.equal(auth.pin, '');
  assert.equal((await auth.join(request, 'guest-one', '123456', () => false)).code, 'pinOff');
  assert.equal((await auth.setPin(request, 'admin', 'bad')).code, 'pinFormat');
  assert.equal(auth.pin, '');
  assert.equal((await auth.setPin(request, 'admin', '123456')).ok, true);
  assert.equal((await auth.join(request, 'guest-one', '123456', () => false)).role, 'guest');
  const restored = new Auth(store, false);
  restored.log = () => {};
  await restored.loadSessions();
  assert.equal(restored.pin, '123456');
  assert.equal((await restored.join(request, 'guest-two', '123456', () => false)).role, 'guest');
  assert.equal((await restored.setPin(request, 'admin', '654321')).loggedOut, 2);
  assert.equal((await restored.join(request, 'guest-three', '123456', () => false)).code, 'wrongPin');
  assert.equal((await restored.join(request, 'guest-three', '654321', () => false)).role, 'guest');
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
