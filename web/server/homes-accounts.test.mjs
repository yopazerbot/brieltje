// An account's lasting access to the code-locked homes (server/homes.mjs) with the real sessions and accounts
// (server/auth.mjs, server/accounts.mjs), wired as server.mjs wires them. Run: node --test server/homes-accounts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { HOMES } from '../shared/homes.mjs';

const previous = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = randomBytes(18).toString('base64url');
const { Auth } = await import('./auth.mjs?homes-accounts');
const { Accounts } = await import('./accounts.mjs?homes-accounts');
const { Homes } = await import('./homes.mjs');
if (previous === undefined) delete process.env.ADMIN_PASSWORD;
else process.env.ADMIN_PASSWORD = previous;

const H1 = 'house';
const H2 = 'bungalow';
const PASS = 'a long walk home';

/** The store's parts these need, with server/store.mjs's rules: a home's access only for an account that exists, gone with it. */
function memoryStore() {
  return {
    meta: new Map(), sessions: [], accounts: new Map(), grants: [],
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
      this.grants = this.grants.filter((r) => r.username !== a.username);
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
    async deleteAccount(name) {
      this.grants = this.grants.filter((r) => r.username !== name);
      return this.accounts.delete(name);
    },
    async listAccounts() { return [...this.accounts.values()]; },
    async pruneAccounts() { return []; },
    async statsForAccountsOnly() {},
    async listHomeGrants() { return this.grants.filter((r) => this.accounts.has(r.username)).map((r) => ({ ...r })); },
    async saveHomeGrant(username, home, gen) {
      if (!this.accounts.has(username)) return false;
      this.grants = [...this.grants.filter((r) => r.username !== username || r.home !== home), { username, home, gen, at: new Date().toISOString() }];
      return true;
    },
    async deleteHomeGrants(home, username = null) {
      const before = this.grants.length;
      this.grants = this.grants.filter((r) => r.home !== home || (username !== null && r.username !== username));
      return before - this.grants.length;
    },
  };
}

let ip = 10;
const req = (cookie = '') => ({ url: '/api/x', headers: cookie ? { cookie } : {}, socket: { remoteAddress: `192.0.2.${ip++ % 250}` } });

async function ready(store = memoryStore()) {
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  const accounts = new Accounts(auth, () => false);
  await accounts.init();
  const homes = new Homes(store, {
    list: HOMES,
    json: (res, status, data) => void Object.assign(res, { status, data }),
    readJson: async (r) => r.body,
    clientKey: (r) => r.sender ?? 'a',
    pack: () => null,
    who: (key) => { const s = auth.sessions.get(key); return s && s.expires >= Date.now() ? s : null; },
    keysOf: (name) => [...auth.sessions].filter(([, s]) => s.username === name && s.role === 'player' && s.expires >= Date.now()).map(([k]) => k),
  });
  await homes.load();
  accounts.onGone = (name) => homes.dropAccount(name);
  /** The session key of a login's token (what the game server and the HTTP routes know a player by). */
  const keyOf = (token) => auth.session(req(`${auth.names.session}=${token}`))?.key ?? null;
  const call = async (method, path, body, { admin = false, user = '', sender } = {}) => {
    const res = {};
    await homes.handle({ method, body, sender }, res, new URL(path, 'http://x'), admin, user);
    return res;
  };
  const code = async (id = H1) => (await call('POST', `/api/admin/homes/${id}/code`, {}, { admin: true })).data.code;
  const unlock = (user, c, id = H1) => call('POST', '/api/home/unlock', { id, code: c }, { user, sender: `s-${user}` });
  const signUp = async (username) => keyOf((await accounts.register(req(), { username, email: `${username}@example.org`, password: PASS, age: true })).token);
  const logIn = async (username, password = PASS) => keyOf((await accounts.login(req(), { username, password })).token);
  return { store, auth, accounts, homes, call, code, unlock, signUp, logIn, keyOf };
}

test('an account that typed the code keeps the home: logged out, on another device, after a restart', async () => {
  const { store, auth, homes, call, code, unlock, signUp, logIn } = await ready();
  const c = await code();
  const first = await signUp('anna');
  const res = await unlock(first, c);
  assert.equal(res.status, 200);
  assert.equal(res.data.account, true, 'the page is told it is the account that has it');
  assert.equal(homes.granted(first, H1), true);
  assert.equal(homes.granted(first, H2), false, 'that one home only');
  assert.deepEqual(store.grants.map((r) => [r.username, r.home]), [['anna', H1]]);
  await auth.logout(first);
  assert.equal(homes.granted(first, H1), false, 'a session that ended opens nothing');
  const phone = await logIn('anna');
  assert.equal(homes.granted(phone, H1), true, 'a later session of the account has it, without the code');
  assert.equal(homes.byAccount(phone, H1), true);
  assert.equal((await call('GET', `/api/home/${H1}/inside`, undefined, { user: phone })).status, 404, 'the inside route lets it in (no private data in the tests: 404, not 403)');
  // A restart: the access comes back from the store, with the sessions.
  const again = await ready(store);
  assert.equal(again.homes.granted(phone, H1), true, 'kept in the store');
});

test('a guest keeps the session only; the admin needs nothing', async () => {
  const { store, auth, homes, code, unlock } = await ready();
  const c = await code();
  const g = await auth.join(req(), 'gus', () => false);
  const guest = auth.session(req(`${auth.names.session}=${g.token}`)).key;
  const res = await unlock(guest, c);
  assert.equal(res.status, 200);
  assert.equal(res.data.account, undefined);
  assert.equal(homes.granted(guest, H1), true, 'the session that typed it');
  assert.equal(homes.byAccount(guest, H1), false);
  assert.equal(store.grants.length, 0, 'nothing kept for a guest');
  await auth.logout(guest);
  const g2 = await auth.join(req(), 'gus', () => false);
  assert.equal(homes.granted(auth.session(req(`${auth.names.session}=${g2.token}`)).key, H1), false, 'a new guest session under the name: locked');
});

test('not handed on: another account, a guest under the name, a made-up key', async () => {
  const { auth, homes, code, unlock, signUp } = await ready();
  const anna = await signUp('anna');
  await unlock(anna, await code());
  const bert = await signUp('bert');
  assert.equal(homes.granted(bert, H1), false, 'another account');
  await auth.logout(anna);
  // A guest can't take an account's name (server/auth.mjs), and a guest session never reads accounts' access anyway.
  auth.sessions.set('fake-guest', { username: 'anna', role: 'guest', expires: Date.now() + 60_000 });
  assert.equal(homes.granted('fake-guest', H1), false, 'a guest session with the account\'s name');
  assert.equal(homes.granted('anna', H1), false, 'the name is no key');
  assert.equal(homes.granted('', H1), false);
  auth.sessions.set('old', { username: 'anna', role: 'player', expires: Date.now() - 1 });
  assert.equal(homes.granted('old', H1), false, 'an expired session');
});

test('a new password, a kick, switched off: the old sessions lose the home; the account keeps it', async () => {
  const { auth, accounts, homes, code, unlock, signUp, logIn, keyOf } = await ready();
  const one = await signUp('otto');
  await unlock(one, await code());
  const two = await logIn('otto');
  assert.equal(homes.granted(two, H1), true);
  const changed = await accounts.changePassword(req(), auth.sessions.get(two) && { key: two, ...auth.sessions.get(two) }, { old: PASS, password: 'another long one' });
  assert.ok(changed.token);
  for (const k of [one, two]) assert.equal(homes.granted(k, H1), false, 'a session from before the new password');
  const three = keyOf(changed.token);
  assert.equal(homes.granted(three, H1), true, 'the session the new password gave');
  await auth.kick('otto');
  assert.equal(homes.granted(three, H1), false, 'kicked');
  auth.blocked.clear();
  const four = await logIn('otto', 'another long one');
  assert.equal(homes.granted(four, H1), true);
  await accounts.admin(req(), 'admin', 'off', 'otto');
  assert.equal(homes.granted(four, H1), false, 'switched off: its sessions end');
  assert.equal(await logIn('otto', 'another long one'), null, 'and it gets no new one');
  await accounts.admin(req(), 'admin', 'on', 'otto');
  assert.equal(homes.granted(await logIn('otto', 'another long one'), H1), true, 'switched on again: the access is still there');
});

test('a deleted account loses its access, and a new account under the name starts without it', async () => {
  const { store, accounts, homes, code, unlock, signUp, logIn } = await ready();
  const c = await code();
  await unlock(await signUp('noor'), c);
  await unlock(await signUp('mila'), c);
  await accounts.admin(req(), 'admin', 'delete', 'noor');
  const mila = await logIn('mila');
  await accounts.deleteMine(req(), { key: mila, username: 'mila', role: 'player' }, { password: PASS });
  assert.equal(store.grants.length, 0, 'the rows went with the accounts');
  assert.equal(homes.lasting.size, 0, 'and so did what the server holds');
  assert.equal(homes.granted(await signUp('noor'), H1), false, 'a new noor');
  assert.equal(homes.granted(await signUp('mila'), H1), false, 'a new mila');
});

test('a new code, a revoke or a change of settings ends the accounts\' access made with the old code', async () => {
  const { store, homes, call, code, unlock, signUp, logIn } = await ready();
  const kim = await signUp('kim');
  await unlock(kim, await code());
  await code(); // leaked, say: the admin makes a new one
  assert.equal(homes.granted(kim, H1), false, 'the session that typed the old code');
  assert.equal(homes.granted(await logIn('kim'), H1), false, 'and a new session of the account');
  assert.equal(store.grants.length, 0);
  await unlock(kim, await code());
  assert.equal(homes.granted(kim, H1), true);
  await call('DELETE', `/api/admin/homes/${H1}/code`, undefined, { admin: true });
  assert.equal(homes.granted(kim, H1), false, 'revoked');
  const c = await code();
  assert.equal(homes.granted(kim, H1), false, 'a code made after a revoke brings nothing back');
  await unlock(kim, c);
  await call('POST', `/api/admin/homes/${H1}`, { enabled: false }, { admin: true });
  await call('POST', `/api/admin/homes/${H1}`, { enabled: true }, { admin: true });
  assert.equal(homes.granted(kim, H1), false, 'switched off and on');
  await unlock(kim, c);
  await call('POST', `/api/admin/homes/${H1}`, { expiresAt: '2000-01-01' }, { admin: true });
  assert.equal(homes.granted(kim, H1), false, 'past its end');
  await call('POST', `/api/admin/homes/${H1}`, { expiresAt: null }, { admin: true });
  assert.equal(homes.granted(kim, H1), false, 'and the new end brings nothing back');
});

test('the admin sees the accounts with access and removes one or all; nobody else can', async () => {
  const { store, homes, call, code, unlock, signUp, logIn } = await ready();
  const c = await code();
  const anna = await signUp('anna');
  const bert = await signUp('bert');
  await unlock(anna, c);
  await unlock(bert, c);
  await unlock(bert, await code(H2), H2);
  const rows = (await call('GET', '/api/admin/homes', undefined, { admin: true })).data.rows;
  assert.deepEqual(rows.find((r) => r.id === H1).accounts.map((a) => a.username), ['anna', 'bert']);
  assert.deepEqual(rows.find((r) => r.id === H2).accounts.map((a) => a.username), ['bert']);
  assert.equal((await call('DELETE', `/api/admin/homes/${H1}/access/anna`, undefined, { admin: false, user: bert })).status, 403, 'a player can\'t remove anyone');
  assert.equal((await call('GET', '/api/admin/homes', undefined, { admin: false, user: bert })).status, 403, 'nor see the list');
  assert.equal((await call('POST', `/api/admin/homes/${H1}/access/anna`, {}, { admin: true })).status, 405);
  assert.equal((await call('DELETE', '/api/admin/homes/nowhere/access/anna', undefined, { admin: true })).status, 404);
  assert.equal((await call('DELETE', `/api/admin/homes/${H1}/access/An%20na`, undefined, { admin: true })).status, 404, 'not a name');
  const one = await call('DELETE', `/api/admin/homes/${H1}/access/anna`, undefined, { admin: true });
  assert.deepEqual(one.data, { ok: true, removed: 1 });
  assert.equal(homes.granted(anna, H1), false, 'out now, the session that typed it included');
  assert.equal(homes.granted(await logIn('anna'), H1), false, 'and later sessions');
  assert.equal(homes.granted(bert, H1), true, 'the others keep it');
  assert.deepEqual((await call('DELETE', `/api/admin/homes/${H1}/access/nobody`, undefined, { admin: true })).data, { ok: true, removed: 0 });
  const all = await call('DELETE', `/api/admin/homes/${H1}/access`, undefined, { admin: true });
  assert.deepEqual(all.data, { ok: true, removed: 1 });
  assert.equal(homes.granted(bert, H1), false);
  assert.equal(homes.granted(bert, H2), true, 'another home is not touched');
  assert.deepEqual(store.grants.map((r) => [r.username, r.home]), [['bert', H2]]);
});

test("the account's other sessions are let in at once (onGrant), and nobody else's", async () => {
  const { homes, code, unlock, signUp, logIn } = await ready();
  const told = [];
  homes.onGrant = (key, id) => told.push([key, id]);
  const laptop = await signUp('lars');
  const phone = await logIn('lars');
  const other = await signUp('olga');
  await unlock(laptop, await code());
  assert.deepEqual(told.map(([k]) => k).sort(), [laptop, phone].sort());
  assert.ok(!told.some(([k]) => k === other));
});

test('a session revoked while its access is being written keeps nothing', async () => {
  const { store, auth, homes, code, unlock, signUp } = await ready();
  const c = await code();
  const key = await signUp('rik');
  const save = store.saveHomeGrant.bind(store);
  store.saveHomeGrant = async (...a) => {
    const r = await save(...a);
    auth.revoke('rik'); // a new password, a switch-off or a deletion meanwhile
    return r;
  };
  await unlock(key, c);
  assert.equal(store.grants.length, 0, 'the row is taken back');
  assert.equal(homes.lasting.size === 0 || !homes.lasting.get('rik')?.size, true);
});

test('the limits on guessing are the same for an account', async () => {
  const { code, unlock, signUp } = await ready();
  const c = await code();
  const key = await signUp('gina');
  const statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await unlock(key, 'BBBBB-BBBBB')).status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 403, 403, 403, 429], 'eight tries at a home in ten minutes from one sender');
  assert.equal((await unlock(key, c)).status, 429, 'even the right code, as for anyone');
});
