// Logging in on a console with the phone (server/pairing.mjs): only an account says yes, only the console's
// secret collects the session, once, never after a revoke, and codes can't be guessed.
// Run: node --test server/pairing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { Auth } = await import('./auth.mjs?pairing');
const { Accounts } = await import('./accounts.mjs?pairing');
const { Pairing, normalCode } = await import('./pairing.mjs');

function memoryStore() {
  return {
    meta: new Map(), sessions: [], accounts: new Map(),
    async getMeta(key) { return this.meta.get(key) ?? null; },
    async setMeta(key, value) { this.meta.set(key, value); },
    async pruneLog() {}, async log() {},
    async loadSessions() { return this.sessions; },
    async saveSession(key, username, role, expires) { this.sessions.push({ key, username, role, expires }); },
    async deleteSession(key) { this.sessions = this.sessions.filter((s) => s.key !== key); },
    async deleteSessionsOf(username) { this.sessions = this.sessions.filter((s) => s.username !== username); },
    async createAccount(a) { this.accounts.set(a.username, { ...a, created: new Date(), disabled: false }); return true; },
    async getAccount(name) { return this.accounts.get(name) ?? null; },
    async updateAccount() { return true; },
    async pruneAccounts() { return []; },
    async statsForAccountsOnly() {},
  };
}
const req = (ip = '192.0.2.40') => ({ headers: {}, socket: { remoteAddress: ip } });

async function ready() {
  const store = memoryStore();
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  const accounts = new Accounts(auth, () => false);
  await accounts.init();
  const made = await accounts.register(req(), { username: 'ilse', email: 'i@example.org', password: 'a long walk home', age: true });
  const phone = auth.session({ headers: { cookie: `${auth.names.session}=${made.token}` }, socket: { remoteAddress: '192.0.2.40' } });
  return { auth, accounts, pairing: new Pairing(auth, accounts), phone };
}

test('a console pairs: the code on screen, the phone says yes, the console collects its own session once', async () => {
  const { auth, pairing, phone } = await ready();
  const s = pairing.start(req('198.51.100.1'), 'https://brieltje.be');
  assert.match(s.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(s.url, `https://brieltje.be/pair/#${s.code}`);
  assert.ok(s.qr.d && s.token.length >= 40);
  assert.equal((await pairing.poll(req('198.51.100.1'), s.token)).state, 'waiting');
  assert.equal(pairing.approve(req(), { ...phone, role: 'guest' }, s.code).code, 'pairAccount', 'a guest has nothing to lend');
  assert.match(s.check, /^[1-9]\d$/);
  const yes = pairing.approve(req(), phone, s.code.toLowerCase().replace('-', ' '), s.check);
  assert.equal(yes.username, 'ilse');
  const done = await pairing.poll(req('198.51.100.1'), s.token);
  assert.equal(done.state, 'done');
  assert.equal(done.username, 'ilse');
  const consoleSession = auth.session({ headers: { cookie: `${auth.names.session}=${done.token}` }, socket: { remoteAddress: '198.51.100.1' } });
  assert.equal(consoleSession.role, 'player');
  assert.notEqual(consoleSession.key, phone.key, 'a session of its own');
  assert.equal((await pairing.poll(req('198.51.100.1'), s.token)).state, 'gone', 'once');
  assert.equal(pairing.approve(req(), phone, s.code, s.check).code, 'pairCode', 'the code is used up');
});

test("the code alone collects nothing; a wrong or made-up secret gets nothing", async () => {
  const { pairing, phone } = await ready();
  const s = pairing.start(req(), 'https://brieltje.be');
  pairing.approve(req(), phone, s.code, s.check);
  assert.equal((await pairing.poll(req(), s.code)).state, 'gone');
  assert.equal((await pairing.poll(req(), 'A'.repeat(43))).state, 'gone');
  assert.equal((await pairing.poll(req(), null)).state, 'gone');
  assert.equal((await pairing.poll(req(), s.token)).state, 'done');
});

test('revoked between yes and the poll (a new password, turned off, kicked): the console gets nothing', async () => {
  const { auth, pairing, phone } = await ready();
  const s = pairing.start(req(), 'https://brieltje.be');
  pairing.approve(req(), phone, s.code, s.check);
  auth.revoke('ilse');
  assert.equal((await pairing.poll(req(), s.token)).state, 'gone');
});

test('a link alone logs in nothing: without the number only the console shows, the pairing ends', async () => {
  const { pairing, phone } = await ready();
  const s = pairing.start(req(), 'https://brieltje.be');
  const wrong = String(((Number(s.check) - 10 + 1) % 90) + 10);
  assert.equal(pairing.approve(req(), phone, s.code, wrong).code, 'pairCheck');
  assert.equal(pairing.approve(req(), phone, s.code, s.check).code, 'pairCode', 'one wrong number ends it');
  assert.equal((await pairing.poll(req(), s.token)).state, 'gone');
  assert.equal(pairing.approve(req(), phone, pairing.start(req(), 'https://brieltje.be').code, '').code, 'pairCheck');
});

test('codes expire, and wrong codes are limited per address and per session', async () => {
  const { pairing, phone } = await ready();
  const s = pairing.start(req(), 'https://brieltje.be');
  pairing.byCode.get(normalCode(s.code)).until = Date.now() - 1;
  assert.equal(pairing.approve(req('192.0.2.41'), phone, s.code).code, 'pairCode');
  assert.equal((await pairing.poll(req(), s.token)).state, 'gone');
  for (let i = 0; i < 9; i++) pairing.approve(req('192.0.2.41'), phone, 'ZZZZ-ZZZZ');
  const fresh = pairing.start(req(), 'https://brieltje.be');
  assert.equal(pairing.approve(req('192.0.2.42'), phone, fresh.code).code, 'tooMany', 'this session tried too many');
  for (let i = 0; i < 20; i++) pairing.start(req('198.51.100.9'), 'https://brieltje.be');
  assert.equal(pairing.start(req('198.51.100.9'), 'https://brieltje.be').code, 'tooMany');
});

test("the game's admin can log a console in too: a game session of 12 hours, never the /admin panel's", async () => {
  const { auth, pairing } = await ready();
  const s = pairing.start(req(), 'https://brieltje.be');
  const admin = { username: 'admin', role: 'admin', key: 'k-admin', expires: Date.now() + 12 * 3600_000 };
  assert.equal(pairing.approve(req(), admin, s.code, s.check).ok, true);
  const done = await pairing.poll(req(), s.token);
  assert.equal(done.state, 'done');
  assert.equal(done.role, 'admin');
  const made = auth.session({ headers: { cookie: `${auth.names.session}=${done.token}` }, socket: { remoteAddress: '192.0.2.41' } });
  assert.equal(made.role, 'admin');
  assert.ok(!made.panel, 'not a panel session');
  assert.ok(made.expires - Date.now() <= 12 * 3600_000 + 1000, 'at most 12 hours');
  // Revoked between the yes and the poll: nothing.
  const t = pairing.start(req(), 'https://brieltje.be');
  pairing.approve(req(), admin, t.code, t.check);
  auth.revoke('admin');
  assert.equal((await pairing.poll(req(), t.token)).state, 'gone');
});

test("a console the admin logs in by phone: never past the phone's own session, never the panel, cut by ending the others", async () => {
  const { auth, pairing } = await ready();
  const admin = { username: 'admin', role: 'admin', key: 'k-admin', expires: Date.now() + 3600_000 }; // an hour left
  // Never longer than the phone's own session: no renewing a 12-hour login by pairing.
  const s = pairing.start(req(), 'https://brieltje.be');
  pairing.approve(req(), admin, s.code, s.check);
  const done = await pairing.poll(req(), s.token);
  assert.equal(done.state, 'done');
  const made = auth.session({ headers: { cookie: `${auth.names.session}=${done.token}` }, socket: { remoteAddress: '192.0.2.42' } });
  assert.ok(made.expires <= admin.expires + 1000, 'within the phone session');
  // Two-step login off: a game admin session may open the panel, a paired one never.
  assert.equal(auth.mfa.on, false);
  assert.equal(auth.panelAdmin({ headers: { cookie: `${auth.names.session}=${done.token}` }, socket: { remoteAddress: '192.0.2.42' } }), false);
  // "End every other admin session" between the yes and the pickup: nothing.
  const t = pairing.start(req(), 'https://brieltje.be');
  pairing.approve(req(), admin, t.code, t.check);
  await auth.endOtherAdminSessions([]);
  assert.equal((await pairing.poll(req(), t.token)).state, 'gone');
  // Two-step login turned on meanwhile: nothing.
  const u = pairing.start(req(), 'https://brieltje.be');
  pairing.approve(req(), admin, u.code, u.check);
  auth.mfa.gen++;
  assert.equal((await pairing.poll(req(), u.token)).state, 'gone');
});
