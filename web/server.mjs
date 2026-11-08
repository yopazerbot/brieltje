// Production web server for Railway: serves the built app (dist/), the login, accounts
// and user-management API, and the multiplayer WebSocket (/ws, the open world and the Zombies rooms).
// Solo play needs no login; playing together needs a name (a guest) or an account
// (server/accounts.mjs). Search engines are asked not to index anything.
//
// Variables (Railway):
//   ADMIN_PASSWORD     admin password (username "admin", or ADMIN_USERNAME)
//   PRIVATE_DATA_KEY   32 random bytes, base64 (44 characters) or hex (64): opens the sealed private data
//                      (server/privateData.mjs). Without it nothing opens.
//   DATABASE_URL       Postgres for accounts, sessions and the login log (local: JSON file)
//   TRUST_CLOUDFLARE   1 when the domain runs through Cloudflare: then only requests
//                      that came through Cloudflare are answered (see viaCloudflare)
//   STATS_SECRET       at least 32 random bytes, base64url: locks the day's visitor seed in the
//                      store (server/stats.mjs). Without it visitors are counted in memory only,
//                      and a restart can count one again.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { openStore } from './server/store.mjs';
// First among the game's modules: the private data (server/privateData.mjs) is open before they load.
import { privateData } from './server/privateData.mjs';
import { Auth, beTime, bucketOf, CLOUDFLARE_ONLY, clientIp, formBucketOf, NAME_RE, seatOf, viaCloudflare } from './server/auth.mjs';
import { ACCOUNT_MS, Accounts } from './server/accounts.mjs';
import { Rooms } from './server/rooms.mjs';
import { Pairing } from './server/pairing.mjs';
import { ARENAS } from './shared/arenas.mjs';
import { Feedback } from './server/feedback.mjs';
import { Game } from './server/game.mjs';
import { Homes } from './server/homes.mjs';
import { packFor } from './server/insides.mjs';
import { HOMES } from './shared/homes.mjs';
import { GameNight } from './server/gamenight.mjs';
import { Interest } from './server/interest.mjs';
import { Stats } from './server/stats.mjs';
import { decodePath } from './server/paths.mjs';

const DIST = resolve(import.meta.dirname, 'dist');
const PORT = Number(process.env.PORT) || 8080;
const SECURE = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// script-src 'wasm-unsafe-eval': the texture transcoder (public/basis/, world/textureFiles.ts) is
// WebAssembly, and compiling it needs this. It allows WebAssembly compilation only, not eval() or
// new Function(); the module is our own same-origin file (connect-src 'self'), so no other source opens.
const HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const ROBOTS = 'User-agent: *\nDisallow: /\n';

/**
 * The game's own page may be framed by this site's pages only: the split screen (/splitscreen) shows
 * up to four copies of it. Every other page stays unframeable. Clickjacking needs a page of another
 * site around ours, and 'self' (with X-Frame-Options SAMEORIGIN for older browsers) keeps those out;
 * no page on this origin holds anything a visitor uploaded (uploads are only ever sent as downloads).
 */
const GAME_PAGE = resolve(DIST, 'index.html');
const FRAMEABLE = {
  ...HEADERS,
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
};

const store = await openStore();
const auth = new Auth(store, SECURE);
await auth.loadSessions();
const game = new Game(auth);
await game.loadFurniture();
await game.loadRules();
// The open world and the Zombies rooms (server/rooms.mjs); the players' accounts (server/accounts.mjs).
const rooms = new Rooms(game, (room) => new Game(auth, undefined, room));
const accounts = new Accounts(auth, (name) => rooms.online(name));
await accounts.init();
rooms.onJoined = (name, session) => session?.role === 'player' && accounts.seen(name);
// Logging in on a console with the phone (server/pairing.mjs).
const pairing = new Pairing(auth, accounts);
/** This site's own address, for the link in a pairing's QR code: the host the console asked (it only affects that console's own code). */
const originOf = (req) => {
  const host = String(req.headers.host || '');
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? `${SECURE ? 'https' : 'http'}://${host.toLowerCase()}` : 'https://brieltje.be';
};
// The board of best Zombies runs (accounts only): public, kept a little while per place.
const boards = new Map(); // place ('' for all) -> { at, rows }
rooms.onScore = () => boards.clear();
async function board(place) {
  const cached = boards.get(place);
  if (cached && Date.now() - cached.at < 15_000) return cached.rows;
  const rows = (await store.zombieBoard(place || null, 20)).map((r) => ({
    username: r.username, place: r.place, wave: r.wave, kills: r.kills, team: r.team, at: new Date(r.at).toISOString().slice(0, 10),
  }));
  boards.set(place, { at: Date.now(), rows });
  return rows;
}

// The forms count a sender per IPv6 /56 (formBucketOf): one household can't fill their caps for everyone.
const formKey = (req) => formBucketOf(clientIp(req));
const interest = new Interest(store, { json: (...a) => json(...a), clientKey: formKey });
// STATS_SECRET locks the day's visitor seed in the store (server/stats.mjs): a Railway variable of its own, never in the database.
const stats = new Stats(store, { json: (...a) => json(...a), clientKey: (req) => bucketOf(clientIp(req)), game: rooms, readJson: (req) => body(req), isAdmin: (req) => auth.panelAdmin(req), log: (event, req, extra) => auth.log(event, req, extra), secret: process.env.STATS_SECRET });
const feedback = new Feedback(store, { json: (...a) => json(...a), readJson: (req) => body(req), clientKey: formKey, clientIp, session: (req) => auth.session(req), time: beTime });
const gamenight = new GameNight(store, { json: (...a) => json(...a), readJson: (req) => body(req), clientKey: formKey });
// The three homes with an access code (server/homes.mjs): who typed a home's code, and the admin's list of them.
// Senders counted per IPv6 /56 (as the forms), so one attacker's many addresses count as few; accounts wait apart.
const homes = new Homes(store, { list: HOMES, json: (...a) => json(...a), readJson: (req) => body(req), clientKey: (req) => formBucketOf(clientIp(req)), account: (req) => ['player', 'admin'].includes(auth.session(req)?.role), pack: packFor });
game.homes = homes;
homes.onGrant = (key, id) => rooms.homeGranted(key, id); // the state of the inside to the page that just got the right, wherever it plays
// The admin page's live view hears of new log lines, changed sign-ups, feedback and the game night.
auth.onLog = (entry) => stats.logged(entry);
interest.onChange = () => stats.signupsChanged();
feedback.onChange = () => stats.feedbackChanged();
gamenight.onChange = () => stats.gamenightChanged();
// A redeploy stops the server: no new connections, then the counting that waits for the store and the day's totals written.
process.once('SIGTERM', () => {
  server.close();
  stats.close().catch((e) => console.error('stats flush failed', String(e))).finally(() => process.exit(0));
});

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * API answers are never compressed, by us or by Cloudflare (no-transform): they hold account
 * data next to what visitors typed, the mix that compression side channels (BREACH) need.
 * Only static files are compressed (see serveFile).
 */
function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-transform', ...headers });
}

/** Read a small JSON body. Only same-origin JSON requests are accepted (no cross-site form posts). */
async function body(req) {
  const origin = String(req.headers.origin || '');
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    // missing Origin
  }
  if (host !== req.headers.host) throw Object.assign(new Error('Bad origin'), { status: 403 });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON only'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4096) throw Object.assign(new Error('Too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Bad JSON'), { status: 400 });
  }
}

/**
 * A refusal: its English text, and its code (and parameters) for a page in another language
 * (src/i18n.ts). The parameters are only ever names the server checked itself, never request text.
 */
const refuse = (res, r) => json(res, r.status, { error: r.error, code: r.code, args: r.args });

async function api(req, res, url) {
  const path = url.pathname;
  const method = req.method;
  // Split screen (/splitscreen): the seat a call speaks for, from its X-Briel-Seat header (server/auth.mjs
  // seatOf). One that isn't 1 to 4 is refused outright rather than read as no seat.
  const seat = seatOf(req);
  if (seat < 0) return json(res, 400, { error: 'Bad seat' });
  // The public key that private files are sealed with (server/privateCrypto.mjs). Public by design: it only
  // lets anyone seal, never open, and the private key is a random secret, so it is no password oracle.
  // Without PRIVATE_DATA_KEY there is no key and nothing to answer.
  if (path === '/api/private/key' && method === 'GET') {
    const k = privateData.publicKey();
    if (!k) return json(res, 404, { error: 'Not found' });
    return json(res, 200, k, { 'Cache-Control': 'public, max-age=300' });
  }
  // The admin's view of the private data: names and counts, never contents.
  if (path === '/api/admin/private' && method === 'GET') {
    if (!auth.panelAdmin(req)) return json(res, 403, { error: 'Admin only' });
    return json(res, 200, privateData.status());
  }
  // The interest page: its public calls, and the admin's list of sign-ups (server/interest.mjs).
  if ((path.startsWith('/api/interest') || path === '/api/address' || path.startsWith('/api/admin/interest'))
    && await interest.handle(req, res, url, auth.panelAdmin(req))) return;
  // Players' stars and comments (server/feedback.mjs), and the admin's list of them.
  if ((path === '/api/feedback' || path.startsWith('/api/admin/feedback'))
    && await feedback.handle(req, res, url, auth.panelAdmin(req))) return;
  // The private homes: the code at a door, and the admin's list of them (server/homes.mjs).
  if ((path === '/api/home/unlock' || /^\/api\/home\/[a-z][a-z0-9_]{1,20}\/inside$/.test(path) || path.startsWith('/api/admin/homes'))
    && await homes.handle(req, res, url, path.startsWith('/api/admin/') ? auth.panelAdmin(req) : auth.session(req)?.role === 'admin', auth.session(req)?.key)) return; // the game's doors for any admin session, the list for the panel's
  // The game night page: its details, sign-ups and own links (server/gamenight.mjs), and the admin's list.
  if ((path === '/api/gamenight' || path.startsWith('/api/gamenight/') || path.startsWith('/api/admin/gamenight'))
    && await gamenight.handle(req, res, url, auth.panelAdmin(req))) return;
  // How much the game is played (server/stats.mjs): the page's beacon, and the admin's numbers and log.
  if ((path === '/api/stats/beacon' || path === '/api/admin/stats' || path === '/api/admin/audit' || path === '/api/admin/live')
    && await stats.handle(req, res, url, auth.panelAdmin(req))) return;

  if (path === '/api/login' && method === 'POST') {
    const b = await body(req);
    const r = await auth.login(req, b.username, b.password, typeof b.code === 'string' ? b.code.slice(0, 20) : '');
    if (r.error) return refuse(res, r);
    return json(res, 200, { username: r.username, role: r.role }, { 'Set-Cookie': [auth.cookie(r.token, r.ms / 1000, seat), auth.deviceCookie(r.device)] });
  }
  if (path === '/api/join' && method === 'POST') {
    const b = await body(req);
    // Playing together (with its chat) is for 13 and over: the page asks, and only sends this once ticked.
    if (b.age !== true) return refuse(res, { error: 'Confirm that you are 13 or older to play together.', code: 'age', status: 400 });
    const r = await auth.join(req, b.name, (name) => rooms.online(name), game.rules.guests, () => game.full());
    // A new guest cookie goes with the answer, a refusal too: a kick keeps that browser out by it.
    const guest = r.guest ? [auth.guestCookie(r.guest)] : [];
    if (r.error) return json(res, r.status, { error: r.error, code: r.code, args: r.args }, guest.length ? { 'Set-Cookie': guest } : {});
    // A seat's join sets that seat's session cookie, never the normal one (server/auth.mjs seatOf).
    return json(res, 200, { username: r.username, role: r.role }, { 'Set-Cookie': [auth.cookie(r.token, undefined, seat), ...guest] });
  }
  // Player accounts (server/accounts.mjs): signing up and logging in. The session cookie as for any login,
  // for 30 days, and the account's device cookie (its own browser isn't locked out by others' guesses).
  if ((path === '/api/account/register' || path === '/api/account/login') && method === 'POST') {
    const b = await body(req);
    // One login for everyone (Yoshi, 7 Nov 2026: "just let the admin login with admin credentials like anyone
    // else"): a name that is no player's account is the admin's login, with the admin password and, when it is
    // on, the two-step code; its limits are the admin's own (server/auth.mjs login). A wrong password answers
    // as any wrong login does.
    const name = String(b.username ?? '').trim().toLowerCase();
    if (path.endsWith('login') && NAME_RE.test(name) && !(await store.getAccount(name))) {
      const r = await auth.login(req, name, b.password, '', false); // the game: no two-step code (the panel asks it)
      if (r.code === 'wrongPassword') return refuse(res, { error: 'Wrong name or password.', code: 'wrongLogin', status: 401 });
      if (r.error) return refuse(res, r);
      return json(res, 200, { username: r.username, role: r.role }, { 'Set-Cookie': [auth.cookie(r.token, undefined, seat), auth.deviceCookie(r.device)] });
    }
    const r = path.endsWith('register') ? await accounts.register(req, b) : await accounts.login(req, b);
    if (r.error) return refuse(res, r);
    return json(res, 200, { username: r.username, role: r.role }, { 'Set-Cookie': [auth.cookie(r.token, ACCOUNT_MS / 1000, seat), auth.accountDeviceCookie(r.device)] });
  }
  // Logging in on a console with the phone (server/pairing.mjs): the console starts a pairing and asks how it
  // goes with its secret; the phone, logged in to its account, says yes (below, with a session).
  if (path === '/api/pair/start' && method === 'POST') {
    await body(req);
    const r = pairing.start(req, originOf(req));
    return r.error ? refuse(res, r) : json(res, 200, r);
  }
  if (path === '/api/pair/poll' && method === 'POST') {
    const b = await body(req);
    const r = await pairing.poll(req, b.token);
    if (r.state !== 'done') return json(res, 200, { state: r.state });
    return json(res, 200, { state: 'done', username: r.username, role: 'player' }, { 'Set-Cookie': auth.cookie(r.token, ACCOUNT_MS / 1000, seat) });
  }
  // The board of best Zombies runs (accounts only): public, like the names in the game. `place`: one of
  // the places, or none for each account's best anywhere.
  if (path === '/api/scores' && method === 'GET') {
    const place = url.searchParams.get('place') ?? '';
    if (place && !ARENAS.some((a) => a.id === place)) return json(res, 400, { error: 'No such place', code: 'roomPlace' });
    return json(res, 200, { rows: await board(place) });
  }
  const s = auth.session(req);
  if (path === '/api/me' && method === 'GET') {
    return s ? json(res, 200, { username: s.username, role: s.role, online: rooms.count(), max: game.rules.maxPlayers }) : json(res, 401, { error: 'Not logged in', code: 'notLoggedIn' });
  }
  if (path === '/api/logout' && method === 'POST') {
    await body(req);
    if (s) await auth.logout(s.key);
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('', 0, seat) });
  }
  if (!s) return json(res, 401, { error: 'Not logged in', code: 'notLoggedIn' });
  if (path === '/api/leaderboard' && method === 'GET') return json(res, 200, { rows: await store.leaderboard() });
  // A player's own account: what is kept, a new password, deleting it (each asks for the current password).
  if (path === '/api/account' && method === 'GET') {
    const mine = await accounts.mine(s);
    return mine ? json(res, 200, mine) : json(res, 404, { error: 'No account', code: 'noAccount' });
  }
  // Every session of this account ends, this one too: a screen logged in by mistake, a lost phone.
  if (path === '/api/account/logout-all' && method === 'POST') {
    await body(req);
    if (s.role !== 'player') return json(res, 403, { error: 'No account', code: 'noAccount' });
    await auth.endSessionsOf(s.username);
    auth.log('account_logout_all', req, { username: s.username });
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('', 0, seat) });
  }
  if ((path === '/api/account/password' || path === '/api/account/delete') && method === 'POST') {
    const b = await body(req);
    if (s.role !== 'player') return json(res, 403, { error: 'No account', code: 'noAccount' });
    const r = path.endsWith('password') ? await accounts.changePassword(req, s, b) : await accounts.deleteMine(req, s, b);
    if (r.error) return refuse(res, r);
    // A new password: this browser stays logged in with a fresh session; every other one ended.
    if (r.token) return json(res, 200, { ok: true }, { 'Set-Cookie': [auth.cookie(r.token, ACCOUNT_MS / 1000, seat), ...(r.device ? [auth.accountDeviceCookie(r.device)] : [])] });
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('', 0, seat) });
  }
  if (path === '/api/pair/approve' && method === 'POST') {
    const b = await body(req);
    const r = pairing.approve(req, s, typeof b.code === 'string' ? b.code : '', typeof b.check === 'string' ? b.check.slice(0, 4) : '');
    return r.error ? refuse(res, r) : json(res, 200, r);
  }
  // Zombies rooms (server/rooms.mjs): the list for anyone playing together; opening one for accounts and the admin.
  if (path === '/api/rooms' && method === 'GET') return json(res, 200, rooms.list());
  if (path === '/api/rooms' && method === 'POST') {
    const b = await body(req);
    const r = rooms.create(s, typeof b.place === 'string' ? b.place : '');
    if (r.error) return refuse(res, r);
    return json(res, 200, r);
  }
  if (s.role !== 'admin') return json(res, 403, { error: 'Admin only', code: 'adminOnly' });

  // Admin: who is online (in the open world and the rooms), kicking, the login log.
  if (path === '/api/players' && method === 'GET') return json(res, 200, { players: rooms.roster(), max: game.rules.maxPlayers });
  if (path === '/api/kick' && method === 'POST') {
    const b = await body(req);
    if (typeof b.name !== 'string' || b.name === s.username) return json(res, 400, { error: 'Pick another player', code: 'pickAnother' });
    await rooms.kick(b.name, s.username);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/audit' && method === 'GET') return json(res, 200, { log: await store.recentLog(60) });
  // Lift every lockout on joining (kicks, guest joins, wrong account passwords): the in-game admin tab's button.
  if (path === '/api/lockouts' && method === 'POST') {
    await body(req);
    return json(res, 200, { lifted: auth.liftLockouts(s.username) });
  }
  // The players' accounts (brieltje.be/admin): the list, and a new password, off, on or delete.
  // From here on brieltje.be/admin only: the game's admin login doesn't open it while two-step login is on.
  if (!auth.panelAdmin(req)) return json(res, 403, { error: 'Log in on brieltje.be/admin', code: 'panelOnly' });
  // The admin's two-step login (server/adminMfa.mjs): on or off; setting up (a secret as a QR code, then a code
  // to confirm); off or new recovery codes, each with a code. Wrong codes count like wrong admin passwords.
  if (path === '/api/admin/mfa' && method === 'GET') return json(res, 200, auth.mfa.view());
  if (path === '/api/admin/mfa' && method === 'POST') {
    const b = await body(req);
    if (b.op === 'start') {
      const r = auth.mfa.start(s.key, s.username);
      return r.error ? refuse(res, r) : json(res, 200, r);
    }
    if (!['confirm', 'off', 'codes'].includes(b.op)) return json(res, 400, { error: 'Unknown action', code: 'badOp' });
    if (auth.codeLimited(req, s.key)) return refuse(res, { error: 'Too many attempts. Try again in 15 minutes.', code: 'tooMany', status: 429 });
    const code = typeof b.code === 'string' ? b.code.slice(0, 20) : '';
    const r = b.op === 'confirm' ? await auth.mfa.confirm(s.key, code) : await auth.mfa.change(b.op, code, s.username);
    if (r.code === 'wrongCode') auth.codeWrong(req, s.username, s.key);
    return r.error ? refuse(res, r) : json(res, 200, r);
  }
  // The admin closes a Zombies room (server/rooms.mjs): its players go back to the open world.
  if (path === '/api/admin/rooms' && method === 'POST') {
    const b = await body(req);
    return rooms.close(b.id, s.username) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No such room', code: 'notFound' });
  }
  if (path === '/api/admin/accounts' && method === 'GET') return json(res, 200, { accounts: await accounts.list() });
  if (path === '/api/admin/accounts' && method === 'POST') {
    const b = await body(req);
    const r = await accounts.admin(req, s.username, b.op, b.name);
    if (r.error) return refuse(res, r);
    return json(res, 200, r);
  }
  return json(res, 404, { error: 'Not found', code: 'notFound' });
}

/** ETag per file: a hash of its contents, worked out once per file. */
const tags = new Map();
async function etag(file, info) {
  const key = `${file}:${info.size}:${info.mtimeMs}`;
  if (!tags.has(key)) tags.set(key, createHash('sha1').update(await readFile(file)).digest('base64url').slice(0, 20));
  return tags.get(key);
}

/**
 * Files from dist/. The build leaves a brotli copy (.br) next to files that compress well,
 * sent to browsers that accept it: only these files, the same for every visitor, without
 * secrets or anything a visitor typed, and made once at build time (the server never
 * decompresses anything). Files outside /assets/ keep their names between builds,
 * so the browser asks each visit whether they changed: the ETag answers that without
 * sending them again (304).
 */
/**
 * The pages' links to our own scripts and styles get the file's fingerprint (?v=...), so a browser
 * never runs yesterday's admin.js with today's page. Cloudflare tells browsers to keep CSS and JS for
 * four hours whatever we send; a changed file gets a new address instead. Files under /assets/ are
 * named by their content already. The pages are ours and the fingerprints come from files on disk,
 * so nothing a visitor sends ends up in them.
 */
const fingerprints = new Map(); // file -> { mtime, v }
const pages = new Map(); // page file -> { mtime, body, tag }
async function fingerprint(file) {
  const info = await stat(file).catch(() => null);
  if (!info) return null;
  const known = fingerprints.get(file);
  if (known?.mtime === info.mtimeMs) return known.v;
  const v = createHash('sha256').update(await readFile(file)).digest('base64url').slice(0, 10);
  fingerprints.set(file, { mtime: info.mtimeMs, v });
  return v;
}
async function pageWithFingerprints(file, info) {
  const known = pages.get(file);
  if (known?.mtime === info.mtimeMs) return known;
  let body = await readFile(file, 'utf8');
  const links = [...new Set([...body.matchAll(/\s(?:src|href)="(\/(?!assets\/)[\w./-]+\.(?:css|js))"/g)].map((m) => m[1]))];
  for (const link of links) {
    const target = resolve(join(DIST, link));
    if (!target.startsWith(DIST + sep)) continue;
    const v = await fingerprint(target);
    if (v) body = body.replaceAll(`"${link}"`, `"${link}?v=${v}"`);
  }
  const page = { mtime: info.mtimeMs, body: Buffer.from(body), tag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 20)}"` };
  pages.set(file, page);
  return page;
}

async function serveFile(req, res, url) {
  const path = decodePath(url.pathname);
  if (path === null) return send(res, 400, 'Bad request'); // a broken %-escape: no file has that name, and nothing to log
  let file = resolve(join(DIST, path));
  if (file !== DIST && !file.startsWith(DIST + sep)) return send(res, 400, 'Bad request');
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    // A folder with a page of its own (/interested/): that page; a folder without one: the app.
    const page = join(file, 'index.html');
    const pageInfo = await stat(page).catch(() => null);
    if (pageInfo) [file, info] = [page, pageInfo];
  }
  if (!info || info.isDirectory()) {
    file = join(DIST, 'index.html'); // single-page app: unknown paths get the app
    info = await stat(file).catch(() => null);
    if (!info) return send(res, 404, 'Not found');
  }
  const immutable = url.pathname.startsWith('/assets/');
  if (extname(file) === '.html') {
    const page = await pageWithFingerprints(file, info);
    const headers = { ...(file === GAME_PAGE ? FRAMEABLE : HEADERS), 'Cache-Control': 'no-cache', ETag: page.tag };
    if (String(req.headers['if-none-match'] || '').split(',').map((t) => t.trim().replace(/^W\//, '')).includes(page.tag)) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES['.html'], 'Content-Length': page.body.length });
    return res.end(req.method === 'HEAD' ? undefined : page.body);
  }
  const packed = /\bbr\b/.test(String(req.headers['accept-encoding'] || '')) ? await stat(`${file}.br`).catch(() => null) : null;
  const tag = `"${await etag(file, info)}${packed ? '-br' : ''}"`;
  const headers = {
    ...HEADERS,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: tag,
    Vary: 'Accept-Encoding',
  };
  const known = String(req.headers['if-none-match'] || '').split(',').map((t) => t.trim().replace(/^W\//, ''));
  if (known.includes(tag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, {
    ...headers,
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Content-Length': packed ? packed.size : info.size,
    ...(packed ? { 'Content-Encoding': 'br' } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(packed ? `${file}.br` : file).pipe(res);
}

/**
 * The site's old and extra names send everyone to its one name, brieltje.be (Yoshi, 31 Oct 2026),
 * with the same path: 301 for page loads, 308 for anything else so a form keeps its method. The
 * target's host is fixed and only the path and query are carried over, never a host from the
 * request, so it can't be turned into an open redirect (a request line like
 * `GET //evil.example/ HTTP/1.1` still lands on brieltje.be). Sessions are per host (__Host-
 * cookies), so everyone joins or logs in once more on the new name. The WebSocket isn't moved:
 * a tab opened on the old name keeps playing until it reloads.
 */
const MOVED = { 'huisje.yoshiparlevliet.be': 'brieltje.be', 'www.brieltje.be': 'brieltje.be' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/healthz') return send(res, 200, 'ok'); // also Railway's own check, which doesn't come through Cloudflare
    if (CLOUDFLARE_ONLY && !viaCloudflare(req)) return send(res, 403, 'Forbidden');
    // The company's registered office for the legal pages, from Railway's settings rather than the public source.
    if (url.pathname === '/api/company') return json(res, 200, { address: String(process.env.COMPANY_ADDRESS || '').slice(0, 200) || null });
    const to = MOVED[String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')];
    if (to) return send(res, req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, '', { Location: `https://${to}${url.pathname}${url.search}` });
    if (url.pathname === '/robots.txt') return send(res, 200, ROBOTS);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    if (url.pathname === '/') stats.view(req, 'game');
    else if (url.pathname === '/interested' || url.pathname === '/interested/') stats.view(req, 'interest');
    await serveFile(req, res, url);
  } catch (err) {
    if (err.status) return json(res, err.status, { error: err.message });
    console.error(JSON.stringify({ event: 'error', ip: clientIp(req), message: String(err) }));
    if (!res.headersSent) send(res, 500, 'Server error');
    else res.destroy();
  }
});

// Never let a malformed upgrade throw out of here: an error in this event takes the whole process down (a
// request for `//` or `//%` with Upgrade headers made `new URL` throw, and every player was dropped).
server.on('upgrade', (req, socket, head) => {
  try {
    if (CLOUDFLARE_ONLY && !viaCloudflare(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    } else if (new URL(req.url, 'http://local').pathname === '/ws') rooms.upgrade(req, socket, head); // the open world, or a room
    else socket.destroy();
  } catch (err) {
    console.error(JSON.stringify({ event: 'upgrade_error', ip: clientIp(req), message: String(err).slice(0, 200) }));
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ event: 'started', port: PORT, admin: !!process.env.ADMIN_PASSWORD, database: !!process.env.DATABASE_URL }));
});
