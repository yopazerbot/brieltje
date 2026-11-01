// Production web server for Railway: serves the built app (dist/), the login
// and user-management API, and the multiplayer WebSocket (/ws).
// The walkthrough itself is public (solo play needs no login); multiplayer
// needs an account. Search engines are asked not to index anything.
//
// Variables (Railway):
//   ADMIN_PASSWORD     admin password (username "admin", or ADMIN_USERNAME)
//   DATABASE_URL       Postgres for users and the login log (local: JSON file)
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
import { Auth, beTime, bucketOf, CLOUDFLARE_ONLY, clientIp, viaCloudflare } from './server/auth.mjs';
import { Feedback } from './server/feedback.mjs';
import { Game } from './server/game.mjs';
import { Interest } from './server/interest.mjs';
import { Stats } from './server/stats.mjs';

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
  '.hdr': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

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
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "connect-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const ROBOTS = 'User-agent: *\nDisallow: /\n';

const store = await openStore();
const auth = new Auth(store, SECURE);
await auth.loadSessions();
const game = new Game(auth);
await game.loadFurniture();
await game.loadRules();

const interest = new Interest(store, { json: (...a) => json(...a), clientKey: (req) => bucketOf(clientIp(req)) });
// STATS_SECRET locks the day's visitor seed in the store (server/stats.mjs): a Railway variable of its own, never in the database.
const stats = new Stats(store, { json: (...a) => json(...a), clientKey: (req) => bucketOf(clientIp(req)), game, readJson: (req) => body(req), isAdmin: (req) => auth.session(req)?.role === 'admin', log: (event, req, extra) => auth.log(event, req, extra), secret: process.env.STATS_SECRET });
const feedback = new Feedback(store, { json: (...a) => json(...a), readJson: (req) => body(req), clientKey: (req) => bucketOf(clientIp(req)), clientIp, session: (req) => auth.session(req), time: beTime });
// The admin page's live view hears of new log lines, changed sign-ups and feedback.
auth.onLog = (entry) => stats.logged(entry);
interest.onChange = () => stats.signupsChanged();
feedback.onChange = () => stats.feedbackChanged();
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
  // The interest page: its public calls, and the admin's list of sign-ups (server/interest.mjs).
  if ((path.startsWith('/api/interest') || path === '/api/address' || path.startsWith('/api/admin/interest'))
    && await interest.handle(req, res, url, auth.session(req)?.role === 'admin')) return;
  // Players' stars and comments (server/feedback.mjs), and the admin's list of them.
  if ((path === '/api/feedback' || path.startsWith('/api/admin/feedback'))
    && await feedback.handle(req, res, url, auth.session(req)?.role === 'admin')) return;
  // How much the game is played (server/stats.mjs): the page's beacon, and the admin's numbers and log.
  if ((path === '/api/stats/beacon' || path === '/api/admin/stats' || path === '/api/admin/audit' || path === '/api/admin/live')
    && await stats.handle(req, res, url, auth.session(req)?.role === 'admin')) return;

  if (path === '/api/login' && method === 'POST') {
    const b = await body(req);
    const r = await auth.login(req, b.username, b.password);
    if (r.error) return refuse(res, r);
    return json(res, 200, { username: r.username, role: r.role }, { 'Set-Cookie': [auth.cookie(r.token), auth.deviceCookie(r.device)] });
  }
  if (path === '/api/join' && method === 'POST') {
    const b = await body(req);
    // Playing together (with its chat) is for 13 and over: the page asks, and only sends this once ticked.
    if (b.age !== true) return refuse(res, { error: 'Confirm that you are 13 or older to play together.', code: 'age', status: 400 });
    const r = await auth.join(req, b.name, b.pin, (name) => game.players.has(name), game.rules.pin, () => game.full());
    // A new guest cookie goes with the answer, a refusal too: wrong PINs are counted per browser by it.
    const guest = r.guest ? [auth.guestCookie(r.guest)] : [];
    if (r.error) return json(res, r.status, { error: r.error, code: r.code, args: r.args }, guest.length ? { 'Set-Cookie': guest } : {});
    return json(res, 200, { username: r.username, role: r.role }, { 'Set-Cookie': [auth.cookie(r.token), auth.pinCookie(r.device), ...guest] });
  }
  const s = auth.session(req);
  if (path === '/api/me' && method === 'GET') {
    return s ? json(res, 200, { username: s.username, role: s.role, online: game.roster().length, max: game.rules.maxPlayers }) : json(res, 401, { error: 'Not logged in', code: 'notLoggedIn' });
  }
  if (path === '/api/logout' && method === 'POST') {
    await body(req);
    if (s) await auth.logout(s.key);
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('', 0) });
  }
  if (!s) return json(res, 401, { error: 'Not logged in', code: 'notLoggedIn' });
  if (path === '/api/leaderboard' && method === 'GET') return json(res, 200, { rows: await store.leaderboard() });
  if (s.role !== 'admin') return json(res, 403, { error: 'Admin only', code: 'adminOnly' });

  // Admin: who is online, kicking, the login log.
  if (path === '/api/players' && method === 'GET') return json(res, 200, { players: game.roster(), max: game.rules.maxPlayers });
  if (path === '/api/kick' && method === 'POST') {
    const b = await body(req);
    if (typeof b.name !== 'string' || b.name === s.username) return json(res, 400, { error: 'Pick another player', code: 'pickAnother' });
    await game.kick(b.name, s.username);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/audit' && method === 'GET') return json(res, 200, { log: await store.recentLog(60) });
  // Lift every lockout on joining (wrong PINs, kicks): the in-game admin tab's button.
  if (path === '/api/lockouts' && method === 'POST') {
    await body(req);
    return json(res, 200, { lifted: auth.liftLockouts(s.username) });
  }
  // The multiplayer PIN: the admin sees and changes it (never sent to anyone else).
  if (path === '/api/pin' && method === 'GET') return json(res, 200, { pin: auth.pin });
  if (path === '/api/pin' && method === 'POST') {
    const b = await body(req);
    const r = await auth.setPin(req, s.username, b.pin);
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
  let file = resolve(join(DIST, decodeURIComponent(url.pathname)));
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
    const headers = { ...HEADERS, 'Cache-Control': 'no-cache', ETag: page.tag };
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

server.on('upgrade', (req, socket, head) => {
  if (CLOUDFLARE_ONLY && !viaCloudflare(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  } else if (new URL(req.url, 'http://local').pathname === '/ws') game.upgrade(req, socket, head);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ event: 'started', port: PORT, admin: !!process.env.ADMIN_PASSWORD, database: !!process.env.DATABASE_URL }));
});
