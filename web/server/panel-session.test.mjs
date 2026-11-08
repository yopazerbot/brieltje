// The /admin panel's session (server/auth.mjs): a cookie of its own that the game never reads, so a browser logged in on
// brieltje.be/admin is the game's admin only for the 12 hours of the game session the same login gives; an idle limit of
// 14 days without a panel call; and the admin ending every other admin session. Run: node --test server/panel-session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const secretPass = randomBytes(18).toString('base64url');
const previous = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = secretPass;
const { Auth, PANEL_IDLE_MS, PANEL_MS } = await import('./auth.mjs?panel');
const { totp } = await import('./adminMfa.mjs');
if (previous === undefined) delete process.env.ADMIN_PASSWORD;
else process.env.ADMIN_PASSWORD = previous;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** As server/store.mjs FileStore keeps sessions: device and since with them, `expires` moved on by touchSession. */
function memoryStore() {
  return {
    meta: new Map(), sessions: [], touched: 0,
    async getMeta(key) { return this.meta.get(key) ?? null; },
    async setMeta(key, value) { this.meta.set(key, value); },
    async pruneLog() {}, async log() {},
    async loadSessions(now) { return (this.sessions = this.sessions.filter((s) => s.expires > now)); },
    async saveSession(key, username, role, expires, device = null, since = null) {
      this.sessions.push({ key, username, role, expires, ...(device ? { device } : {}), ...(since ? { since } : {}) });
    },
    async touchSession(key, expires) {
      this.touched++;
      const s = this.sessions.find((x) => x.key === key);
      if (s) s.expires = expires;
    },
    async deleteSession(key) { this.sessions = this.sessions.filter((s) => s.key !== key); },
    async deleteSessionsOf(username) { this.sessions = this.sessions.filter((s) => s.username !== username); },
    async getAccount() { return null; },
  };
}
const req = (ip = '192.0.2.5') => ({ headers: {}, socket: { remoteAddress: ip } });

async function fresh(store = memoryStore()) {
  const auth = new Auth(store, false);
  auth.log = () => {};
  await auth.loadSessions();
  return { auth, store };
}

/** A request with these cookies: `game` in the game's session cookie, `panel` in the panel's. */
const withCookies = (auth, { game, panel } = {}) => ({
  headers: { cookie: [game && `${auth.names.session}=${game}`, panel && `${auth.names.panel}=${panel}`].filter(Boolean).join('; ') },
  socket: { remoteAddress: '192.0.2.5' },
});

/** Date.now() moved on by `ms` while `fn` runs. */
async function later(ms, fn) {
  const real = Date.now;
  const at = real() + ms;
  Date.now = () => at;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test('a panel login: the panel session in its own cookie, and the game admin for 12 hours only', async () => {
  const { auth } = await fresh();
  const r = await auth.login(req(), 'yoshi', secretPass);
  assert.equal(r.role, 'admin');
  assert.ok(r.panel?.token && r.panel.token !== r.token, 'two tokens: the panel and the game');
  assert.equal(auth.panelCookie(r.panel.token).split(';')[0], `briel_panel=${r.panel.token}`);
  // The game: its own cookie is the admin; the panel's token counts for nothing there, in whichever cookie.
  assert.equal(auth.session(withCookies(auth, { game: r.token }))?.role, 'admin');
  assert.equal(auth.session(withCookies(auth, { panel: r.panel.token })), null, "the game never reads the panel's cookie");
  assert.equal(auth.session(withCookies(auth, { game: r.panel.token })), null, "the panel's token in the game's cookie: nothing");
  assert.equal(auth.panelAdmin(withCookies(auth, { panel: r.panel.token })), true);
  // 13 hours on: the game session has ended, so the game sees no admin; the panel still works.
  await later(13 * HOUR, () => {
    assert.equal(auth.session(withCookies(auth, { game: r.token, panel: r.panel.token })), null, 'no game admin after 12 hours');
    assert.equal(auth.panelAdmin(withCookies(auth, { game: r.token, panel: r.panel.token })), true, '/admin still works');
  });
});

test('a panel session older than 12 hours gives no game admin, also after a restart; one from before its own cookie goes', async () => {
  const store = memoryStore();
  const { auth } = await fresh(store);
  const r = await auth.login(req(), 'yoshi', secretPass);
  // As if logged in two days ago and used since: its own row, aged.
  const row = store.sessions.find((s) => s.key === r.panel.key);
  row.since -= 2 * DAY;
  // An old panel session, from when it lived in the game's cookie (no `since`), and a stale game admin session.
  store.sessions.push({ key: 'legacy-panel', username: 'yoshi', role: 'admin', expires: Date.now() + 300 * DAY, device: 'panel' });
  const { auth: again } = await fresh(store);
  assert.equal(again.sessions.has('legacy-panel'), false, 'the old panel session is dropped');
  assert.equal(store.sessions.some((s) => s.key === 'legacy-panel'), false, 'from the store too');
  assert.equal(again.session(withCookies(again, { game: r.panel.token, panel: r.panel.token })), null);
  assert.equal(again.panelAdmin(withCookies(again, { panel: r.panel.token })), true);
  assert.equal(again.panelSession(withCookies(again, { panel: r.panel.token })).since, row.since);
  // A game admin login (no code needed in the game) never opens the panel's cookie path.
  const g = await again.login(req(), 'yoshi2', secretPass, '', false);
  assert.equal(g.panel, undefined, 'the game login makes no panel session');
});

test('the idle limit: 14 days without a panel call ends it; a call moves it on, never past 400 days from the login', async () => {
  const store = memoryStore();
  const { auth } = await fresh(store);
  const r = await auth.login(req(), 'yoshi', secretPass);
  const panel = withCookies(auth, { panel: r.panel.token });
  // Untouched: gone after 14 days, in memory and (by its stored expires) after a restart.
  await later(PANEL_IDLE_MS + HOUR, async () => {
    assert.equal(auth.panelAdmin(panel), false, '14 days idle: ended');
    const { auth: again } = await fresh(store);
    assert.equal(again.sessions.has(r.panel.key), false, 'not loaded after a restart either');
  });
  // Used on day 10: still there on day 20, written to the store once (at most once an hour).
  const s2 = await auth.login(req(), 'yoshi', secretPass);
  const panel2 = withCookies(auth, { panel: s2.panel.token });
  const writes = store.touched;
  auth.touchPanel(panel2);
  assert.equal(store.touched, writes, 'a call right after the login writes nothing');
  await later(10 * DAY, () => {
    auth.touchPanel(panel2);
    auth.touchPanel(panel2);
  });
  assert.equal(store.touched, writes + 1, 'written once');
  await later(20 * DAY, async () => {
    assert.equal(auth.panelAdmin(panel2), true, 'used on day 10: there on day 20');
    const { auth: again } = await fresh(store);
    assert.equal(again.panelAdmin(withCookies(again, { panel: s2.panel.token })), true, 'and after a restart');
  });
  await later(25 * DAY, () => assert.equal(auth.panelAdmin(panel2), false, 'day 25 without a call since day 10: ended'));
  // Used every day: still ends 400 days after the login.
  const s3 = await auth.login(req(), 'yoshi', secretPass);
  const panel3 = withCookies(auth, { panel: s3.panel.token });
  for (let d = 10; d < PANEL_MS / DAY; d += 10) await later(d * DAY, () => auth.touchPanel(panel3));
  assert.equal(auth.sessions.get(s3.panel.key).expires, auth.sessions.get(s3.panel.key).since + PANEL_MS);
  await later(PANEL_MS - HOUR, () => assert.equal(auth.panelAdmin(panel3), true, 'used every 10 days: there on day 399'));
  await later(PANEL_MS + HOUR, () => assert.equal(auth.panelAdmin(panel3), false, 'never past 400 days'));
  // The game's calls don't touch it: only touchPanel does, and server.mjs calls it for /api/admin/ paths alone.
  assert.equal(auth.session(panel3), null);
});

test('Log out on the panel ends its session and the game admin session of that browser, not a player elsewhere', async () => {
  const { auth } = await fresh();
  const r = await auth.login(req(), 'yoshi', secretPass);
  const other = await auth.login(req('192.0.2.9'), 'admin', secretPass);
  await auth.panelLogout(withCookies(auth, { game: r.token, panel: r.panel.token }));
  assert.equal(auth.sessions.has(r.panel.key), false);
  assert.equal(auth.session(withCookies(auth, { game: r.token })), null);
  assert.equal(auth.panelAdmin(withCookies(auth, { panel: other.panel.token })), true, "another browser's stays");
});

test('every other admin session ends: the panel and the game, everywhere but this browser; a login saving meanwhile gets none', async () => {
  const { auth, store } = await fresh();
  const me = await auth.login(req(), 'yoshi', secretPass);
  const laptop = await auth.login(req('192.0.2.20'), 'yoshi', secretPass);
  const game = await auth.login(req('192.0.2.21'), 'admin', secretPass, '', false);
  const keep = [me.panel.key, auth.session(withCookies(auth, { game: me.token })).key];
  assert.equal(auth.otherAdminSessions(keep), 3);
  assert.equal(await auth.endOtherAdminSessions(keep), 3);
  assert.deepEqual([...auth.sessions.keys()].sort(), [...keep].sort());
  assert.deepEqual(store.sessions.map((s) => s.key).sort(), [...keep].sort(), 'from the store too');
  assert.equal(auth.panelAdmin(withCookies(auth, { panel: laptop.panel.token })), false);
  assert.equal(auth.session(withCookies(auth, { game: game.token })), null);
  assert.equal(auth.panelAdmin(withCookies(auth, { panel: me.panel.token })), true, 'this browser stays');
  // A login past its checks, still saving its sessions when the others are ended: it gets none.
  const save = store.saveSession.bind(store);
  let once = true;
  store.saveSession = async (...a) => {
    await save(...a);
    if (once) {
      once = false;
      await auth.endOtherAdminSessions(keep);
    }
  };
  const late = await auth.login(req('192.0.2.22'), 'yoshi', secretPass);
  assert.equal(late.code, 'removed');
  assert.deepEqual([...auth.sessions.keys()].sort(), [...keep].sort());
  assert.deepEqual(store.sessions.map((s) => s.key).sort(), [...keep].sort(), 'its rows went again');
});

test('with two-step login on, the game admin opens no panel; off, it does, as before', async () => {
  const { auth } = await fresh();
  const first = await auth.login(req(), 'yoshi', secretPass);
  auth.mfa.start(first.panel.key, 'yoshi');
  const secret = auth.mfa.pending.get(first.panel.key).secret;
  assert.equal((await auth.mfa.confirm(first.panel.key, totp(secret, Math.floor(Date.now() / 30000)))).ok, true);
  const game = await auth.login(req('192.0.2.30'), 'yoshi', secretPass, '', false);
  assert.equal(auth.panelAdmin(withCookies(auth, { game: game.token })), false);
  assert.equal(auth.panelAdmin(withCookies(auth, { panel: first.panel.token })), true);
  await auth.mfa.change('off', totp(secret, Math.floor(Date.now() / 30000) + 1), 'yoshi');
  assert.equal(auth.panelAdmin(withCookies(auth, { game: game.token })), true);
});
