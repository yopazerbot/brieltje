// Keep this run (server/keepRun.mjs, server/accounts.mjs register): a guest's last good Zombies run goes onto the
// board only under an account made from that same guest session, once, within ten minutes.
// Run: node --test server/keepRun.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { GuestRuns, KEEP_MIN_WAVE, KEEP_MS } from './keepRun.mjs';

const previous = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = randomBytes(18).toString('base64url');
const { Auth } = await import('./auth.mjs?keeprun');
const { Accounts } = await import('./accounts.mjs?keeprun');
if (previous === undefined) delete process.env.ADMIN_PASSWORD;
else process.env.ADMIN_PASSWORD = previous;

function memoryStore() {
  return {
    meta: new Map(), sessions: [], accounts: new Map(), runs: [],
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
    async updateAccount() { return true; },
    async deleteAccount(name) { return this.accounts.delete(name); },
    async listAccounts() { return [...this.accounts.values()]; },
    async pruneAccounts() { return []; },
    async statsForAccountsOnly() {},
    async saveZombieRun(username, place, wave, kills, team) {
      if (!this.accounts.has(username)) return false;
      this.runs.push({ username, place, wave, kills, team });
      return true;
    },
  };
}

const req = (ip = '192.0.2.70', cookie = '') => ({ url: '/api/account/register', headers: cookie ? { cookie } : {}, socket: { remoteAddress: ip } });
const signup = (username) => ({ username, email: 'someone@example.org', password: 'a long walk home', age: true });

async function ready() {
  const store = memoryStore();
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  const online = new Map(); // name -> the session key playing under it
  const accounts = new Accounts(auth, (n, except) => online.has(n) && (except === undefined || online.get(n) !== except));
  await accounts.init();
  /** A guest joins as `name`: their session as the server reads it from the cookie. */
  const guest = async (name, ip = '192.0.2.71') => {
    const r = await auth.join(req(ip), name, (n) => online.has(n));
    assert.ok(r.token, `${name} joined`);
    const s = auth.session(req(ip, `${auth.names.session}=${r.token}`));
    online.set(name, s.key);
    return s;
  };
  return { store, auth, accounts, online, guest };
}

test('the store of runs: only good, whole, recorded runs; one per session; once; ten minutes', () => {
  let now = 1_000_000;
  const runs = new GuestRuns(() => now);
  try {
    assert.equal(runs.offer('k1', { place: 'church', wave: KEEP_MIN_WAVE - 1, kills: 4, team: 2 }), false, 'below a good wave: nothing offered');
    assert.equal(runs.offer('k1', { place: 'church', wave: 4.5, kills: 4, team: 2 }), false);
    assert.equal(runs.offer('k1', { place: 'church', wave: 5, kills: -1, team: 2 }), false);
    assert.equal(runs.offer('k1', { place: '<b>', wave: 5, kills: 1, team: 2 }), false);
    assert.equal(runs.offer('', { place: 'church', wave: 5, kills: 1, team: 2 }), false);
    assert.equal(runs.offer('k1', { place: 'church', wave: 5, kills: 12, team: 3 }), true);
    assert.equal(runs.offer('k1', { place: 'house', wave: 4, kills: 7, team: 2 }), true, 'a later run replaces the earlier one');
    assert.deepEqual(runs.peek('k1'), { place: 'house', wave: 4, kills: 7, team: 2, ms: KEEP_MS });
    assert.equal(runs.peek('k2'), null, "another session sees nothing");
    assert.equal(runs.take('k1').wave, 4);
    assert.equal(runs.take('k1'), null, 'taken once');
    runs.offer('k3', { place: 'church', wave: 6, kills: 1, team: 1 });
    now += KEEP_MS;
    assert.equal(runs.peek('k3'), null, 'gone after ten minutes');
  } finally {
    runs.close();
  }
});

test("a sign-up from the guest's own session: the run onto the board under the new account, once; the guest session ends", async () => {
  const { store, auth, accounts, guest } = await ready();
  const s = await guest('mila');
  accounts.guestRuns.offer(s.key, { place: 'church', wave: 7, kills: 23, team: 3 });
  const r = await accounts.register(req(), signup('mila-z'), s);
  assert.ok(r.token);
  assert.deepEqual(r.kept, { place: 'church', wave: 7 });
  assert.deepEqual(store.runs, [{ username: 'mila-z', place: 'church', wave: 7, kills: 23, team: 3 }]);
  assert.equal(auth.sessions.has(s.key), false, 'the guest session is over');
  assert.equal(accounts.guestRuns.peek(s.key), null, 'and its run is gone');
  // The same session (a replayed cookie) gets nothing a second time.
  const again = await accounts.register(req(), signup('mila-y'), s);
  assert.equal(again.kept, undefined);
  assert.equal(store.runs.length, 1);
});

test("someone else's session, or none, can't take a guest's run", async () => {
  const { store, accounts, guest } = await ready();
  const a = await guest('ana', '192.0.2.81');
  const b = await guest('bo', '192.0.2.82');
  accounts.guestRuns.offer(a.key, { place: 'house', wave: 9, kills: 30, team: 2 });
  const fromB = await accounts.register(req(), signup('bo-acct'), b);
  assert.equal(fromB.kept, undefined);
  const none = await accounts.register(req(), signup('nobody'), null);
  assert.equal(none.kept, undefined);
  // A forged session object (a key without a live session behind it) moves nothing either.
  const forged = await accounts.register(req(), signup('forger'), { key: a.key, username: 'someone', role: 'guest' });
  assert.equal(forged.kept, undefined);
  // A player's session is no guest's.
  assert.equal(store.runs.length, 0);
  assert.ok(accounts.guestRuns.peek(a.key), "ana's run still waits for ana");
});

test('a guest may make their own guest name an account, but never a name someone else holds', async () => {
  const { auth, accounts, guest, online } = await ready();
  const s = await guest('joris');
  // Without the guest's session: refused as before.
  assert.equal((await accounts.register(req(), signup('joris'))).code, 'nameOnline');
  // From another guest's session: refused as well.
  const other = await guest('kim', '192.0.2.90');
  assert.equal((await accounts.register(req(), signup('joris'), other)).code, 'nameOnline');
  // Playing under the name from a second session (another browser that took it over): refused.
  online.set('joris', 'another-key');
  assert.equal((await accounts.register(req(), signup('joris'), s)).code, 'nameOnline');
  online.set('joris', s.key);
  // From joris's own session: the account is made and the guest session ends.
  const r = await accounts.register(req(), signup('joris'), s);
  assert.ok(r.token);
  assert.equal(auth.sessions.has(s.key), false);
  // The rules stay: reserved names, the password rules, the age tick.
  const t = await guest('tess', '192.0.2.91');
  assert.equal((await accounts.register(req(), { ...signup('tess'), password: 'password123' }, t)).code, 'passCommon');
  assert.equal((await accounts.register(req(), { ...signup('tess'), age: false }, t)).code, 'age');
  assert.equal((await accounts.register(req(), signup('admin'), t)).code, 'nameTaken');
});

test('a guest kicked meanwhile: no run moves', async () => {
  const { store, auth, accounts, guest } = await ready();
  const s = await guest('pim');
  accounts.guestRuns.offer(s.key, { place: 'church', wave: 5, kills: 3, team: 1 });
  await auth.logout(s.key); // the session ended (kicked, logged out) before the sign-up came
  const r = await accounts.register(req(), signup('pim-acct'), s);
  assert.ok(r.token, 'the sign-up itself still works');
  assert.equal(r.kept, undefined);
  assert.equal(store.runs.length, 0);
});
