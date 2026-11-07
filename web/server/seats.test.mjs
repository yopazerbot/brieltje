// Split screen (/splitscreen): four seats in one browser, each with a session cookie of its own
// (server/auth.mjs seatOf). Run: node --test server/seats.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { Auth, seatOf } = await import('./auth.mjs?seats');

function memoryStore() {
  return {
    meta: new Map(), sessions: [],
    async getMeta(key) { return this.meta.get(key); },
    async setMeta(key, value) { this.meta.set(key, value); },
    async pruneLog() {}, async log() {},
    async loadSessions() { return this.sessions; },
    async saveSession(key, username, role, expires, device) { this.sessions.push({ key, username, role, expires, ...(device ? { device } : {}) }); },
    async deleteSession(key) { this.sessions = this.sessions.filter((s) => s.key !== key); },
    async deleteSessionsOf(username) { this.sessions = this.sessions.filter((s) => s.username !== username); },
    accounts: new Map(),
    async getAccount(name) { return this.accounts.get(name) ?? null; },
  };
}

/** A request from one address, with these headers. */
const req = (headers = {}, url = '/api/me', ip = '192.0.2.10') => ({ url, headers, socket: { remoteAddress: ip } });
/** The value of cookie `name` in a Set-Cookie line. */
const value = (line, name) => new RegExp(`^${name}=([^;]*)`).exec(line)?.[1];

async function ready(secure = false) {
  const auth = new Auth(memoryStore(), secure);
  auth.log = () => {};
  await auth.loadSessions();
  return auth;
}

/** Join seats 1 to n from one browser (one guest cookie): their cookie line and session token. */
async function joinSeats(auth, names) {
  let jar = '';
  const out = [];
  for (const [i, name] of names.entries()) {
    const seat = i + 1;
    const r = await auth.join(req({ cookie: jar, 'x-briel-seat': String(seat) }, '/api/join'), name, () => false);
    assert.equal(r.role, 'guest', `seat ${seat} joins`);
    if (r.guest) jar = `${auth.names.guest}=${r.guest}`;
    const line = auth.cookie(r.token, undefined, seat);
    out.push({ seat, name, line, token: r.token });
  }
  return { jar, seats: out };
}

const cookieHeader = (auth, jar, seats) => [jar, ...seats.map((s) => `${auth.names.seats[s.seat - 1]}=${s.token}`)].filter(Boolean).join('; ');

test('seatOf: the header or the WebSocket subprotocol, 1 to 4, nothing else', () => {
  assert.equal(seatOf(req()), 0);
  for (const n of [1, 2, 3, 4]) {
    assert.equal(seatOf(req({ 'x-briel-seat': String(n) })), n);
    assert.equal(seatOf(req({ 'sec-websocket-protocol': `briel-seat-${n}` })), n);
  }
  for (const bad of ['0', '5', '1, 2', ' 1', '1 ', '01', 'one', '', '-1', '1.0']) assert.equal(seatOf(req({ 'x-briel-seat': bad })), -1, `header ${JSON.stringify(bad)}`);
  for (const bad of ['briel-seat-5', 'briel-seat-1, briel-seat-2', 'chat', '', 'briel-seat-01']) assert.equal(seatOf(req({ 'sec-websocket-protocol': bad })), -1, `protocol ${JSON.stringify(bad)}`);
  // Both at once is not one seat.
  assert.equal(seatOf(req({ 'x-briel-seat': '1', 'sec-websocket-protocol': 'briel-seat-1' })), -1);
});

test('the URL never picks a seat or carries a session', async () => {
  const auth = await ready();
  const { jar, seats } = await joinSeats(auth, ['seat-anna']);
  // A seat or a token in the query or the path is not read: no header, no seat.
  for (const url of ['/api/me?seat=1', '/ws?v=2&seat=1', `/api/me?session=${seats[0].token}`, `/api/me?${auth.names.seats[0]}=${seats[0].token}`, '/api/me#seat=1']) {
    assert.equal(seatOf(req({}, url)), 0, url);
    assert.equal(auth.session(req({ cookie: jar }, url)), null, url);
    assert.equal(auth.session(req({}, url)), null, url);
  }
});

test('four seats from one address get four distinct sessions, each read only by its own seat', async () => {
  const auth = await ready();
  const names = ['seat-anna', 'seat-bram', 'seat-cato', 'seat-dirk'];
  const { jar, seats } = await joinSeats(auth, names);
  assert.equal(new Set(seats.map((s) => s.token)).size, 4);
  const all = cookieHeader(auth, jar, seats);
  for (const s of seats) {
    const got = auth.session(req({ cookie: all, 'x-briel-seat': String(s.seat) }));
    assert.equal(got?.username, s.name, `seat ${s.seat} over HTTP`);
    assert.equal(auth.session(req({ cookie: all, 'sec-websocket-protocol': `briel-seat-${s.seat}` }, '/ws?v=2'))?.username, s.name, `seat ${s.seat} over the WebSocket`);
  }
  // No seat named: the normal session cookie only, which this browser doesn't have.
  assert.equal(auth.session(req({ cookie: all })), null);
  // Four joins from the one address: counted as four, far under the limit for a meetup's Wi-Fi.
  assert.equal(auth.guestJoins.count('192.0.2.10', Date.now()), 4);
  // The four names stay their owners' for the day, as any join's.
  assert.equal((await auth.join(req({ cookie: jar }), 'seat-anna', () => false)).code, 'nameToday');
});

test("a seat can't use another seat's session by naming it without holding its cookie", async () => {
  const auth = await ready();
  const { jar, seats } = await joinSeats(auth, ['seat-anna', 'seat-bram']);
  // Only seat 1's cookie in the jar: naming seat 2 (or 3) finds nothing, and never falls back to seat 1.
  const one = cookieHeader(auth, jar, [seats[0]]);
  assert.equal(auth.session(req({ cookie: one, 'x-briel-seat': '2' })), null);
  assert.equal(auth.session(req({ cookie: one, 'x-briel-seat': '3' })), null);
  assert.equal(auth.session(req({ cookie: one, 'sec-websocket-protocol': 'briel-seat-2' })), null);
  // A seat's cookie is never read as the normal session, nor the normal session as a seat.
  assert.equal(auth.session(req({ cookie: `${auth.names.session}=${seats[0].token}`, 'x-briel-seat': '1' })), null);
  assert.equal(auth.session(req({ cookie: one })), null);
  const normal = await auth.join(req({ cookie: jar }), 'plain-player', () => false);
  const both = `${one}; ${auth.names.session}=${normal.token}`;
  assert.equal(auth.session(req({ cookie: both }))?.username, 'plain-player');
  assert.equal(auth.session(req({ cookie: both, 'x-briel-seat': '1' }))?.username, 'seat-anna');
  assert.equal(auth.session(req({ cookie: both, 'x-briel-seat': '2' })), null);
  // A malformed seat gets no session at all, not the normal one.
  assert.equal(auth.session(req({ cookie: both, 'x-briel-seat': '9' })), null);
  assert.equal(auth.session(req({ cookie: both, 'sec-websocket-protocol': 'chat' })), null);
  // A made-up token in a seat's cookie is nobody.
  assert.equal(auth.session(req({ cookie: `${auth.names.seats[0]}=${'A'.repeat(43)}`, 'x-briel-seat': '1' })), null);
});

test('guest joins count per address, seats too, and the admin lifts the count', async () => {
  const auth = await ready();
  const ip = '192.0.2.77';
  let jar = '';
  for (let i = 0; i < 40; i++) {
    const r = await auth.join(req({ cookie: jar, 'x-briel-seat': String((i % 4) + 1) }, '/api/join', ip), `seat-p${i}`, () => false);
    assert.equal(r.role, 'guest', `join ${i}`);
    if (r.guest) jar = `${auth.names.guest}=${r.guest}`;
  }
  assert.equal((await auth.join(req({ cookie: jar }, '/api/join', ip), 'seat-late', () => false)).code, 'joinsTooMany');
  // Another address is not held back.
  assert.equal((await auth.join(req({}, '/api/join', '192.0.2.78'), 'seat-other', () => false)).role, 'guest');
  auth.liftLockouts('admin');
  assert.equal((await auth.join(req({ cookie: jar }, '/api/join', ip), 'seat-late', () => false)).role, 'guest');
});

test('seat cookies: __Host- prefixed, HttpOnly, Secure, SameSite=Strict, Path=/, 12 hours; only seats 1 to 4', async () => {
  const auth = new Auth(memoryStore(), true);
  auth.log = () => {};
  for (const n of [1, 2, 3, 4]) {
    const line = auth.cookie('t'.repeat(43), undefined, n);
    assert.equal(value(line, `__Host-briel_seat${n}`), 't'.repeat(43));
    for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure', `Max-Age=${12 * 3600}`]) assert.ok(line.includes(flag), `${flag} in ${line}`);
    assert.ok(!/Domain=/i.test(line));
  }
  assert.ok(auth.cookie('x'.repeat(43)).startsWith('__Host-briel_session='));
  assert.throws(() => auth.cookie('x', undefined, 5));
  assert.throws(() => auth.cookie('x', undefined, -1));
  assert.deepEqual(auth.names.seats, ['__Host-briel_seat1', '__Host-briel_seat2', '__Host-briel_seat3', '__Host-briel_seat4']);
});

test('a kick of one seat ends that seat only, and keeps that browser from joining under a new name', async () => {
  const auth = await ready();
  const { jar, seats } = await joinSeats(auth, ['seat-anna', 'seat-bram', 'seat-cato']);
  const all = cookieHeader(auth, jar, seats);
  await auth.kick('seat-bram');
  assert.equal(auth.session(req({ cookie: all, 'x-briel-seat': '2' })), null);
  assert.equal(auth.session(req({ cookie: all, 'x-briel-seat': '1' }))?.username, 'seat-anna');
  // The kicked seat's browser is the whole PC: it can't join a new name for the kick's minutes.
  assert.equal((await auth.join(req({ cookie: jar, 'x-briel-seat': '2' }), 'seat-bert', () => false)).code, 'removed');
  for (const n of [1, 3]) assert.ok(auth.session(req({ cookie: all, 'x-briel-seat': String(n) })), `seat ${n} plays on`);
});
