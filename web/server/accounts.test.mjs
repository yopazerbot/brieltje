// Player accounts (server/accounts.mjs): signing up, logging in, the limits on guessing, a new password and
// deleting one's own account. Run: node --test server/accounts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const previous = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = randomBytes(18).toString('base64url');
const { Auth } = await import('./auth.mjs?accounts');
const { Accounts } = await import('./accounts.mjs?accounts');
if (previous === undefined) delete process.env.ADMIN_PASSWORD;
else process.env.ADMIN_PASSWORD = previous;

function memoryStore() {
  return {
    meta: new Map(), sessions: [], accounts: new Map(), runs: [], stats: new Map([['someone', {}]]),
    async getMeta(key) { return this.meta.get(key) ?? null; },
    async setMeta(key, value) { this.meta.set(key, value); },
    async pruneLog() {}, async log() {},
    async loadSessions() { return this.sessions; },
    async saveSession(key, username, role, expires, device) { this.sessions.push({ key, username, role, expires, ...(device ? { device } : {}) }); },
    async deleteSession(key) { this.sessions = this.sessions.filter((s) => s.key !== key); },
    async deleteSessionsOf(username) { this.sessions = this.sessions.filter((s) => s.username !== username); },
    async createAccount(a) {
      if (this.accounts.has(a.username)) return false;
      this.accounts.set(a.username, { ...a, created: new Date(), seen: new Date(), disabled: false });
      return true;
    },
    async getAccount(name) { return this.accounts.get(name) ?? null; },
    async updateAccount(name, patch) {
      const a = this.accounts.get(name);
      if (!a) return false;
      if ('pass' in patch) a.pass = patch.pass;
      if ('disabled' in patch) a.disabled = patch.disabled;
      return true;
    },
    async deleteAccount(name) { return this.accounts.delete(name); },
    async listAccounts() { return [...this.accounts.values()]; },
    async pruneAccounts() { return []; },
    async statsForAccountsOnly() { this.stats.clear(); },
  };
}

const req = (ip = '192.0.2.30', cookie = '') => ({ url: '/api/account/login', headers: cookie ? { cookie } : {}, socket: { remoteAddress: ip } });
const good = { username: 'Liesbeth', email: ' Liesbeth@Example.org ', password: 'a long walk home', age: true };

async function ready() {
  const store = memoryStore();
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  const online = new Set();
  const accounts = new Accounts(auth, (n) => online.has(n));
  await accounts.init();
  return { store, auth, accounts, online };
}

test('signing up: the checks, one name each, the email kept as typed in lower case, a session at once', async () => {
  const { store, auth, accounts } = await ready();
  assert.equal(store.stats.size, 0, 'the old fighting totals by a typed name are gone');
  assert.equal((await accounts.register(req(), { ...good, age: false })).code, 'age');
  assert.equal((await accounts.register(req(), { ...good, username: 'a b' })).code, 'nameFormat');
  assert.equal((await accounts.register(req(), { ...good, email: 'nope' })).code, 'emailFormat');
  assert.equal((await accounts.register(req(), { ...good, email: 'a@b.c<script>' })).code, 'emailFormat');
  assert.equal((await accounts.register(req(), { ...good, password: 'short' })).code, 'passShort');
  assert.equal((await accounts.register(req(), { ...good, password: 'x'.repeat(201) })).code, 'passLong');
  assert.equal((await accounts.register(req(), { ...good, password: 'wachtwoord' })).code, 'passCommon');
  assert.equal((await accounts.register(req(), { ...good, password: 'liesbeth1' })).code, 'passCommon');
  assert.equal((await accounts.register(req(), { ...good, username: 'admin' })).code, 'nameTaken');
  const r = await accounts.register(req(), good);
  assert.equal(r.role, 'player');
  assert.equal(r.username, 'liesbeth');
  const row = await store.getAccount('liesbeth');
  assert.equal(row.email, 'liesbeth@example.org');
  assert.ok(row.pass.startsWith('scrypt$') && !row.pass.includes(good.password));
  assert.equal(auth.session(req('192.0.2.30', `${auth.names.session}=${r.token}`))?.role, 'player');
  assert.equal((await accounts.register(req(), { ...good, username: 'LIESBETH' })).code, 'nameOnline', 'held by her session');
  auth.sessions.clear();
  assert.equal((await accounts.register(req(), { ...good, username: 'LIESBETH' })).code, 'nameTaken');
  // A guest can't take it, nor the admin's password.
  assert.equal((await auth.join(req('192.0.2.99'), 'liesbeth', () => false)).code, 'nameAccount');
});

test("a guest's name, or one someone plays under, can't become an account", async () => {
  const { auth, accounts, online } = await ready();
  await auth.join(req('192.0.2.40'), 'joris', () => false);
  assert.equal((await accounts.register(req(), { ...good, username: 'joris' })).code, 'nameOnline');
  online.add('kim');
  assert.equal((await accounts.register(req(), { ...good, username: 'kim' })).code, 'nameOnline');
});

test('logging in: one answer for a wrong password and an unknown name; limits per account and address', async () => {
  const { auth, accounts } = await ready();
  const made = await accounts.register(req(), { ...good, username: 'mira' });
  const own = `${auth.names.acct}=${made.device}`;
  assert.equal((await accounts.login(req('192.0.2.50'), { username: 'mira', password: 'nope nope nope' })).code, 'wrongLogin');
  assert.equal((await accounts.login(req('192.0.2.50'), { username: 'nobody', password: 'nope nope nope' })).code, 'wrongLogin');
  const ok = await accounts.login(req('192.0.2.51'), { username: 'MIRA', password: good.password });
  assert.equal(ok.role, 'player');
  // Ten wrong ones from other addresses lock the name for others, never for her own browser.
  for (let i = 0; i < 9; i++) await accounts.login(req(`198.51.100.${i}`), { username: 'mira', password: `wrong ${i} guess` });
  assert.equal((await accounts.login(req('198.51.100.99'), { username: 'mira', password: good.password })).code, 'tooManyName');
  assert.equal((await accounts.login(req('198.51.100.98', own), { username: 'mira', password: good.password })).role, 'player');
  // Twenty wrong ones from one address stop that address.
  for (let i = 0; i < 20; i++) await accounts.login(req('203.0.113.7'), { username: `nobody${i}`, password: 'nope nope nope' });
  assert.equal((await accounts.login(req('203.0.113.7', own), { username: 'mira', password: good.password })).code, 'tooMany');
  auth.liftLockouts('admin');
  assert.equal((await accounts.login(req('203.0.113.7'), { username: 'mira', password: good.password })).role, 'player');
});

test('turned off, kicked or deleted: no login; the admin sets a new password once', async () => {
  const { auth, accounts } = await ready();
  await accounts.register(req(), { ...good, username: 'noor' });
  assert.equal((await accounts.admin(req(), 'admin', 'off', 'noor')).ok, true);
  assert.equal([...auth.sessions.values()].filter((s) => s.username === 'noor').length, 0, 'turning it off ends its sessions');
  assert.equal((await accounts.login(req(), { username: 'noor', password: good.password })).code, 'accountOff');
  await accounts.admin(req(), 'admin', 'on', 'noor');
  await auth.kick('noor');
  assert.equal((await accounts.login(req(), { username: 'noor', password: good.password })).code, 'removed');
  auth.blocked.clear();
  const reset = await accounts.admin(req(), 'admin', 'reset', 'noor');
  assert.match(reset.password, /^[a-hj-km-np-z2-9]{12}$/);
  assert.equal((await accounts.login(req(), { username: 'noor', password: good.password })).code, 'wrongLogin');
  assert.equal((await accounts.login(req(), { username: 'noor', password: reset.password })).role, 'player');
  assert.equal((await accounts.admin(req(), 'admin', 'delete', 'noor')).ok, true);
  assert.equal((await accounts.login(req(), { username: 'noor', password: reset.password })).code, 'wrongLogin');
  assert.equal((await accounts.admin(req(), 'admin', 'delete', 'noor')).code, 'noAccount');
  assert.equal((await accounts.admin(req(), 'admin', 'explode', 'nobody')).code, 'noAccount');
});

test('a new password ends every other session; deleting needs the password and ends them all', async () => {
  const { store, auth, accounts } = await ready();
  const first = await accounts.register(req(), { ...good, username: 'otto' });
  const second = await accounts.login(req(), { username: 'otto', password: good.password });
  const session = auth.session(req('192.0.2.30', `${auth.names.session}=${first.token}`));
  assert.equal((await accounts.changePassword(req(), session, { old: 'not it at all', password: 'another long one' })).code, 'wrongPassword2');
  assert.equal((await accounts.changePassword(req(), session, { old: good.password, password: 'otto123' })).code, 'passShort');
  const changed = await accounts.changePassword(req(), session, { old: good.password, password: 'another long one' });
  assert.ok(changed.token);
  for (const t of [first.token, second.token]) assert.equal(auth.session(req('192.0.2.30', `${auth.names.session}=${t}`)), null);
  const now = auth.session(req('192.0.2.30', `${auth.names.session}=${changed.token}`));
  assert.equal(now.username, 'otto');
  assert.equal((await accounts.deleteMine(req(), now, { password: good.password })).code, 'wrongPassword2');
  assert.equal((await accounts.deleteMine(req(), now, { password: 'another long one' })).ok, true);
  assert.equal(await store.getAccount('otto'), null);
  assert.equal(auth.session(req('192.0.2.30', `${auth.names.session}=${changed.token}`)), null);
});

test("a browser's own-account cookie stops counting after a new password, or for a new account under the name", async () => {
  const { auth, accounts } = await ready();
  const made = await accounts.register(req(), { ...good, username: 'quinn' });
  const own = `${auth.names.acct}=${made.device}`;
  const lock = async () => {
    for (let i = 0; i < 10; i++) await accounts.login(req(`198.51.100.${i}`), { username: 'quinn', password: `wrong ${i} guess` });
  };
  await lock();
  assert.equal((await accounts.login(req('198.51.100.50', own), { username: 'quinn', password: good.password })).role, 'player', 'her browser still gets in');
  const session = [...auth.sessions].find(([, s]) => s.username === 'quinn');
  await accounts.changePassword(req(), { key: session[0], ...session[1] }, { old: good.password, password: 'a brand new phrase' });
  await lock();
  assert.equal((await accounts.login(req('198.51.100.51', own), { username: 'quinn', password: 'a brand new phrase' })).code, 'tooManyName', 'the old cookie no longer skips the count');
  // Deleted and signed up again by someone else: the old cookie is nobody's.
  auth.liftLockouts('admin');
  await accounts.admin(req(), 'admin', 'delete', 'quinn');
  await accounts.register(req('192.0.2.31'), { ...good, username: 'quinn', password: 'someone else entirely' });
  await lock();
  assert.equal((await accounts.login(req('198.51.100.52', own), { username: 'quinn', password: 'someone else entirely' })).code, 'tooManyName');
});

test('turned off while a login is being checked: that login gets no session', async () => {
  const { auth, store, accounts } = await ready();
  await accounts.register(req(), { ...good, username: 'roos' });
  auth.sessions.clear();
  // The admin's "off" lands while the password check runs.
  const getAccount = store.getAccount.bind(store);
  store.getAccount = async (name) => {
    const row = await getAccount(name);
    store.getAccount = getAccount;
    await accounts.admin(req(), 'admin', 'off', 'roos');
    return row && { ...row, disabled: false }; // what the login read before the change
  };
  const r = await accounts.login(req(), { username: 'roos', password: good.password });
  assert.equal(r.code, 'removed');
  assert.equal([...auth.sessions.values()].filter((s) => s.username === 'roos').length, 0);
});

test('at most ten sessions per account: the oldest go', async () => {
  const { auth, accounts } = await ready();
  await accounts.register(req(), { ...good, username: 'pia' });
  for (let i = 0; i < 12; i++) await accounts.login(req(`192.0.2.${60 + i}`), { username: 'pia', password: good.password });
  assert.equal([...auth.sessions.values()].filter((s) => s.username === 'pia').length, 10);
});

test('password checks: two at once, a few more wait, the rest hear the server is busy', async () => {
  const { accounts } = await ready();
  const gates = [];
  const runs = Array.from({ length: 20 }, () => accounts.hashing(() => new Promise((resolve) => gates.push(resolve))));
  await new Promise((r) => setImmediate(r));
  assert.equal(gates.length, 2, 'two run');
  const results = [];
  runs.forEach((p, i) => p.then((v) => (results[i] = v)));
  await new Promise((r) => setImmediate(r));
  assert.equal(results.filter((v) => v === null).length, 2, 'two over the queue are refused');
  while (gates.length) {
    gates.shift()(true);
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all(runs);
  assert.equal(results.filter((v) => v?.value === true).length, 18);
  assert.equal(accounts.active, 0);
});
