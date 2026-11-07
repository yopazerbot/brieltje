// Logins and sessions.
//
// - Admin: password from ADMIN_PASSWORD (Railway variable); without it there is no admin.
//   The admin logs in under any free name (Yoshi, 30 Oct 2026) that is no player's account, with
//   the admin password. ADMIN_USERNAME (default "admin") and "yoshi" stay reserved (RESERVED): nobody else
//   can take them.
// - Player accounts (Yoshi, 7 Nov 2026): a unique name, an email address and a password, made by
//   the players themselves (server/accounts.mjs). Their sessions are role 'player'.
// - Sessions: random token in an HttpOnly, SameSite=Strict cookie. The server
//   keeps a SHA-256 hash of the token in memory and in the store, so sessions
//   survive a redeploy and a leaked database can't be used to log in.
// - Password guessing: at most 10 wrong passwords per address in 15 minutes (an IPv6 /64
//   counts as one address) and 20 tries at the admin password in an hour from everyone
//   together (else a guesser would take a new name and address for each try). Once that is
//   used up the admin password is refused like a wrong one, except from a browser that logged
//   in as admin before (a device cookie, so nobody can lock the admin out by guessing).
//   Accounts have limits of their own (server/accounts.mjs).
// - Guests (Yoshi, 7 Nov 2026: no PIN any more): a name and "I'm 13 or older", no account. The
//   admin's reserved name and every account's name can't be taken, nor anyone's name while their
//   session lasts (12 hours, or until they leave). Joins are limited per address (GUEST_JOINS, a
//   meetup's Wi-Fi is one address for everyone there) and in all (GUEST_SESSIONS), so nobody can
//   take every name or fill the database. Kicking a guest also keeps their browser (a guest
//   cookie), and new browsers at their address, out for those 10 minutes (else they would be back
//   at once under another name), not the rest of the venue. The admin can switch guest joining
//   off (the rule `guests`), and can lift every lockout at once from the game's admin tab.
// - Split screen (/splitscreen, Yoshi, 7 Nov 2026): up to four players in one browser, each in a
//   frame of the game. They share one cookie jar, so each seat gets a session cookie of its own
//   (`__Host-briel_seat1` to 4), and the page says which seat it speaks for: the X-Briel-Seat
//   header on HTTP, the WebSocket's subprotocol `briel-seat-N` (see seatOf). A request that names a
//   seat is answered from that seat's cookie only, never the normal session's, and a request
//   without one from the normal session's only. Everything else (the names, the limits, kicks,
//   the cap on players) is the same as for any join; the four seats are one browser to it.

import { randomBytes, scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { BlockList, isIP, isIPv6 } from 'node:net';
import { sameText } from './constant-time-text.mjs';
import { AdminMfa } from './adminMfa.mjs';

const scryptAsync = promisify(scrypt);
const ADMIN = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === '1';
// On Railway the app is only reachable through Railway's proxy. Elsewhere
// (local runs) the header could come from anyone, so it is ignored.
const TRUST_PROXY = !!process.env.RAILWAY_ENVIRONMENT || process.env.TRUST_PROXY === '1';
/** Only answer requests that came through Cloudflare (see viaCloudflare). */
export const CLOUDFLARE_ONLY = TRUST_CLOUDFLARE && TRUST_PROXY;
const SESSION_MS = 12 * 3600_000;
const MAX_FAILS = 10; // wrong admin passwords per address
const FAIL_WINDOW_MS = 15 * 60_000;
const ADMIN_FAILS = 20; // tries at the admin password in an hour, from browsers that never logged in as admin
const SESSION_CODE_FAILS = 5; // wrong two-step codes per admin session in FAIL_WINDOW_MS (off, new recovery codes)
const DEVICE_MS = 90 * 24 * 3600_000;
export const NAME_RE = /^[a-z0-9_-]{2,20}$/;
const ADMIN_KEY = '#admin'; // what the admin's device cookie is signed for, whatever the name
// Guests joining: per address (an IPv6 /64 is one), enough for a meetup's whole room on one Wi-Fi joining
// and coming back, and in all, so a flood of joins can't take every name or fill the store.
const GUEST_JOINS = 40; // joins per address in GUEST_WINDOW_MS
const GUEST_WINDOW_MS = 15 * 60_000;
const GUEST_SESSIONS = 3000; // guest sessions at once, everyone together
const GUEST_DEVICE = '#guest'; // what the guest cookie, telling browsers apart for kicks, is signed for
const KICK_MS = 10 * 60_000; // a kicked player's name and browser stay out this long
const JOINED_KEEP = 256; // browsers remembered per address for kicks (see noteJoin)
const LOG_DAYS = 90; // the login log holds IP addresses: kept this long
const LOG_ROWS = 20_000;
export const ADMIN_NAME = ADMIN;
/**
 * Names only the admin password logs in under (Yoshi, 7 Nov 2026: "reserve yoshi"): no guest takes one and no
 * account is made with one, so the admin always has them.
 */
export const RESERVED = new Set([ADMIN, 'yoshi']);

export const beTime = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Brussels' });

const cloudflare = new BlockList();
for (const r of ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
  '172.64.0.0/13', '131.0.72.0/22']) cloudflare.addSubnet(r.split('/')[0], +r.split('/')[1], 'ipv4');
for (const r of ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'])
  cloudflare.addSubnet(r.split('/')[0], +r.split('/')[1], 'ipv6');

/**
 * The address that connected to Railway. Railway's edge writes X-Forwarded-For itself as
 * "<address that connected to Railway>, <Railway proxy>" (checked on the live site,
 * 2026-10-28; a forged header sent straight to Railway is not believed, 2026-10-29),
 * so the second entry from the end is trustworthy.
 */
function peerOf(req) {
  const hops = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').map((h) => h.trim()).filter(Boolean) : [];
  return hops.length >= 2 ? hops.at(-2) : hops.at(-1) || req.socket.remoteAddress || 'unknown';
}

const fromCloudflare = (peer) => isIP(peer) > 0 && cloudflare.check(peer, isIPv6(peer) ? 'ipv6' : 'ipv4');

/**
 * Whether a request came through Cloudflare. Railway also answers for the domain when
 * someone connects to it directly, which skips Cloudflare's rules (and its minimum TLS
 * version); with CLOUDFLARE_ONLY such requests are refused. Cloudflare's addresses are
 * listed above, from cloudflare.com/ips (unchanged on 2026-10-29).
 */
export function viaCloudflare(req) {
  return fromCloudflare(peerOf(req));
}

/**
 * The visitor's address. When the connecting address is a Cloudflare server,
 * Cloudflare's own report (CF-Connecting-IP) is the visitor; a request that skips
 * Cloudflare keeps its real address.
 */
export function clientIp(req) {
  const peer = peerOf(req);
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (TRUST_CLOUDFLARE && isIP(cf) && fromCloudflare(peer)) return cf;
  return peer;
}

/**
 * Who counts as one guesser: an IPv4 address, or an IPv6 /64 network (one
 * connection usually gets a whole /64, so single IPv6 addresses cost nothing).
 */
export function bucketOf(ip) {
  if (!isIPv6(ip)) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const groups = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const [head, tail] = ip.split('%')[0].split('::');
  const h = groups(head);
  const t = groups(tail);
  const all = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * Login attempts per key (an address or an account) within a time window. Counted before
 * the password check, so a burst can't slip past, and taken back when it doesn't count
 * (right password, or busy). Only attempts that reach a check stay, so the two-at-a-time
 * limit on checks also bounds the memory this takes.
 */
export class Attempts {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.map = new Map(); // key -> times, oldest first
  }
  count(key, now) {
    const list = this.map.get(key);
    if (!list) return 0;
    while (list.length && now - list[0] >= this.windowMs) list.shift();
    if (!list.length) this.map.delete(key);
    return list.length;
  }
  add(key, now) {
    const list = this.map.get(key);
    if (list) list.push(now);
    else this.map.set(key, [now]);
  }
  undo(key, now) {
    const list = this.map.get(key);
    const i = list ? list.lastIndexOf(now) : -1;
    if (i >= 0) list.splice(i, 1);
    if (list && !list.length) this.map.delete(key);
  }
  cleanup(now) {
    for (const key of [...this.map.keys()]) this.count(key, now);
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

export async function verifyHash(password, stored) {
  const [kind, n, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(Buffer.from(actual), expected);
}

/** What the server keeps for a session token. */
const keyOf = (token) => createHash('sha256').update(token).digest('base64url');

/** Split screen: the most players in one browser (/splitscreen), each with a session cookie of its own. */
export const SEATS = 4;

/**
 * Which split-screen seat a request speaks for: 0 for none (the normal game), 1 to SEATS for a seat,
 * -1 for a claim that isn't one of those, which gets no session at all. HTTP calls name it in the
 * X-Briel-Seat header; the WebSocket in its subprotocol (`briel-seat-N`), the only header a page can
 * give a WebSocket. Never from the URL: it would be in logs and history, and a link could pick it.
 * Both are only a choice between the cookies this browser already holds, never a credential: the
 * session itself is still the HttpOnly cookie's random token. A page on another site can send
 * neither with our cookies (a custom header needs CORS, which this server never grants; the
 * WebSocket checks Origin, and the cookies are SameSite=Strict).
 */
export function seatOf(req) {
  const header = req.headers['x-briel-seat'];
  const proto = req.headers['sec-websocket-protocol'];
  if (header === undefined && proto === undefined) return 0;
  if (header !== undefined && proto !== undefined) return -1;
  const m = header !== undefined ? /^([1-4])$/.exec(String(header)) : /^briel-seat-([1-4])$/.exec(String(proto));
  return m && Number(m[1]) <= SEATS ? Number(m[1]) : -1;
}

export class Auth {
  /** `secure`: HTTPS only (Railway). The cookies then carry the __Host- prefix: only this host can set them. */
  constructor(store, secure) {
    this.store = store;
    this.secure = secure;
    // `acct`: a player's device cookie, signed for their account's name (server/accounts.mjs): their own
    // browser still logs in while others' wrong guesses lock the account for a while.
    this.names = secure
      ? { session: '__Host-briel_session', device: '__Host-briel_device', guest: '__Host-briel_guest', acct: '__Host-briel_acct' }
      : { session: 'briel_session', device: 'briel_device', guest: 'briel_guest', acct: 'briel_acct' };
    // Split screen: seat N's session cookie (see seatOf). The same prefix and flags as the session's.
    this.names.seats = Array.from({ length: SEATS }, (_, i) => `${secure ? '__Host-' : ''}briel_seat${i + 1}`);
    this.sessions = new Map(); // hash of the token -> { username, role, expires, ip, device }
    this.failures = new Attempts(FAIL_WINDOW_MS); // wrong admin passwords per address (bucketOf)
    this.adminFails = new Attempts(3600_000); // tries at the admin password, all addresses together (one key)
    this.guestJoins = new Attempts(GUEST_WINDOW_MS); // guest joins per address (bucketOf)
    this.joinedFrom = new Map(); // address -> Map(browser -> when it joined there), for kicks
    this.blocked = new Map(); // username -> until (kicked)
    this.blockedDevices = new Map(); // guest cookie id -> until: a kicked player's browser
    this.kickedFrom = new Map(); // address -> { until, known }: a kick there; only browsers in `known` may join meanwhile
    this.epoch = new Map(); // username -> counter, raised whenever their sessions are revoked
    // Names being made into an account right now (server/accounts.mjs register): a guest can't take one meanwhile.
    this.claiming = new Set();
    this.onLift = null; // server/accounts.mjs: its own lockouts lifted with these
    this.mfa = new AdminMfa(this, ADMIN_PASSWORD); // the admin's two-step login (server/adminMfa.mjs)
    this.codeFails = new Attempts(FAIL_WINDOW_MS); // wrong two-step codes per admin session (codeLimited)
    setInterval(() => this.cleanup(), 60_000).unref();
    setInterval(() => this.pruneLog(), 3600_000).unref();
  }

  /** Old login log entries out (their IP addresses are personal data). */
  pruneLog() {
    this.store.pruneLog(LOG_DAYS, LOG_ROWS).catch((e) => console.error('log prune failed', String(e)));
  }

  /**
   * Start-up. Sessions from before a restart, checked again: admin sessions only while the
   * admin password is the same one they logged in with (a scrypt fingerprint of it is kept in
   * the store, so changing ADMIN_PASSWORD in Railway logs the admin out); guest sessions unless
   * their name is reserved or an account's; player sessions while their account is there and on.
   * Also the key that signs device cookies, and a first pass over the login log.
   */
  async loadSessions() {
    this.deviceKey = await this.store.getMeta('device_key');
    if (!this.deviceKey) await this.store.setMeta('device_key', (this.deviceKey = randomBytes(32).toString('base64url')));
    this.pruneLog();
    let adminOk = false;
    let changed = false; // ADMIN_PASSWORD is not the one of the last start: two-step login goes off (server/adminMfa.mjs)
    if (ADMIN_PASSWORD) {
      const fp = await this.store.getMeta('admin_fp');
      adminOk = !!fp && (await verifyHash(ADMIN_PASSWORD, fp));
      changed = !!fp && !adminOk;
      if (!adminOk) await this.store.setMeta('admin_fp', await hashPassword(ADMIN_PASSWORD));
    }
    await this.mfa.load(changed);
    if (await this.store.getMeta('pin')) await this.store.setMeta('pin', ''); // the old shared PIN (Yoshi, 7 Nov 2026: gone)
    const accounts = new Map(); // name -> its account, or null: looked up once per name
    const account = async (name) => {
      if (!accounts.has(name)) accounts.set(name, await this.store.getAccount(name));
      return accounts.get(name);
    };
    for (const s of await this.store.loadSessions(Date.now())) {
      let valid = false;
      if (s.role === 'admin') valid = adminOk;
      else if (s.role === 'guest') valid = !RESERVED.has(s.username) && !(await account(s.username));
      else if (s.role === 'player') valid = !RESERVED.has(s.username) && !!(await account(s.username)) && !(await account(s.username)).disabled;
      if (valid && s.role === 'admin') this.sessions.set(s.key, { username: s.username, role: 'admin', expires: s.expires, panel: s.device === 'panel' });
      else if (valid) this.sessions.set(s.key, { username: s.username, role: s.role, expires: s.expires, ...(s.device ? { device: s.device } : {}) });
      else await this.store.deleteSession(s.key);
    }
  }

  /**
   * End a user's sessions in memory right away (their game connection closes
   * within a second) and make any login still in progress fail.
   */
  revoke(username) {
    this.epoch.set(username, (this.epoch.get(username) || 0) + 1);
    for (const [k, s] of this.sessions) if (s.username === username) this.sessions.delete(k);
  }

  /** Revoke in memory, then delete from the store (an error is reported to the caller). */
  async endSessionsOf(username) {
    this.revoke(username);
    await this.store.deleteSessionsOf(username);
  }

  cleanup() {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (s.expires >= now) continue;
      this.sessions.delete(k);
      this.store.deleteSession(k).catch((e) => console.error('session delete failed', String(e))); // expired ones are also skipped on load
    }
    this.failures.cleanup(now);
    this.adminFails.cleanup(now);
    this.guestJoins.cleanup(now);
    for (const map of [this.blocked, this.blockedDevices]) {
      for (const [k, until] of map) if (until < now) map.delete(k);
    }
    for (const [a, k] of this.kickedFrom) if (k.until < now) this.kickedFrom.delete(a); // its set of browsers goes with it
    for (const [a, seen] of this.joinedFrom) {
      for (const [d, at] of seen) if (now - at > SESSION_MS) seen.delete(d);
      if (!seen.size) this.joinedFrom.delete(a);
    }
  }

  /**
   * A browser joined as a guest from an address: remembered there for a session's length (12 hours, at
   * most JOINED_KEEP there, the oldest go first). A kick keeps everyone but these out at that address for
   * its 10 minutes (see kick). Only a successful join calls this, never a game connection's cookie.
   */
  noteJoin(address, device, now = Date.now()) {
    if (!device || !address) return;
    const seen = this.joinedFrom.get(address) ?? new Map();
    seen.delete(device);
    seen.set(device, now);
    while (seen.size > JOINED_KEEP) seen.delete(seen.keys().next().value);
    this.joinedFrom.set(address, seen);
  }

  /** Forget a browser as having joined: kicked (see kick). */
  forgetDevice(device) {
    for (const seen of this.joinedFrom.values()) seen.delete(device);
    for (const k of this.kickedFrom.values()) k.known.delete(device);
  }

  /**
   * The admin lifts every lockout on joining: the guest joins counted per address, the kicks (names,
   * browsers, addresses) and the accounts' wrong-password counts. For a meetup where one kick or a few
   * typos would otherwise keep people out. Guesses at the admin password still count.
   */
  liftLockouts(by) {
    const maps = [this.blocked, this.blockedDevices, this.kickedFrom];
    let lifted = this.guestJoins.map.size + maps.reduce((n, m) => n + m.size, 0);
    this.guestJoins = new Attempts(GUEST_WINDOW_MS);
    for (const m of maps) m.clear();
    lifted += this.onLift?.() ?? 0;
    this.log('lockouts_lifted', null, { username: by, detail: `${lifted} lifted` });
    return lifted;
  }

  /**
   * A new session for `username` (role 'guest', 'player' or 'admin'), lasting `ms`: in memory before the
   * first await (two at once can't both take a name), then stored. `device`: the browser's guest cookie id.
   */
  async startSession(username, role, ms, { ip, device } = {}) {
    const token = randomBytes(32).toString('base64url');
    const key = keyOf(token);
    const expires = Date.now() + ms;
    this.sessions.set(key, { username, role, expires, ...(ip ? { ip } : {}), ...(device ? { device } : {}) });
    try {
      await this.store.saveSession(key, username, role, expires, device ?? null);
    } catch (e) {
      this.sessions.delete(key);
      throw e;
    }
    return { token, key };
  }

  /** Someone has this name right now: a session (any role) or a sign-up on its way. */
  nameHeld(name, now = Date.now()) {
    return this.claiming.has(name) || [...this.sessions.values()].some((s) => s.username === name && s.expires > now);
  }

  /** The id (random part) of a signed device cookie `cookie` for `name`, or null. */
  deviceCookieOf(req, cookie, name) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${cookie}=([0-9a-z]+)\\.([A-Za-z0-9_-]{16})\\.([A-Za-z0-9_-]{43})`));
    if (!m || !this.deviceKey || Date.now() - parseInt(m[1], 36) > DEVICE_MS) return null;
    return sameText(m[3], this.deviceMac(m[1], m[2], name)) ? m[2] : null;
  }

  /** The guest cookie's id, or null. */
  guestDevice(req) {
    return this.deviceCookieOf(req, this.names.guest, GUEST_DEVICE);
  }

  guestCookie(value) {
    return this.setCookie(this.names.guest, value, DEVICE_MS / 1000);
  }

  deviceMac(issued, nonce, name) {
    return createHmac('sha256', this.deviceKey).update(`${issued}.${nonce}\0${name}`).digest('base64url');
  }

  /** A device cookie value for `name`: when it was made, a random part, and their signature. */
  newDevice(name) {
    const issued = Date.now().toString(36);
    const nonce = randomBytes(12).toString('base64url');
    return `${issued}.${nonce}.${this.deviceMac(issued, nonce, name)}`;
  }

  /** Whether this browser logged in as `name` within the last 90 days (OWASP's device cookies against lockouts). */
  knownDevice(req, name, cookie = this.names.device) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${cookie}=([0-9a-z]+)\\.([A-Za-z0-9_-]{16})\\.([A-Za-z0-9_-]{43})`));
    if (!m || !this.deviceKey || Date.now() - parseInt(m[1], 36) > DEVICE_MS) return false;
    return sameText(m[3], this.deviceMac(m[1], m[2], name));
  }

  log(event, req, extra = {}) {
    const entry = { time: beTime(), event, ip: req ? clientIp(req) : undefined, ...extra };
    console.log(JSON.stringify(entry));
    this.store.log(entry).catch((e) => console.error('audit log failed', String(e)));
    this.onLog?.(entry); // the admin page's live view (server/stats.mjs)
  }

  /**
   * The session cookie a request is answered from: the normal one, or the seat's it names (seatOf);
   * null for a malformed seat.
   */
  sessionName(req) {
    const seat = seatOf(req);
    if (seat < 0) return null;
    return seat ? this.names.seats[seat - 1] : this.names.session;
  }

  /** Session for a request (cookie), or null. A seat's request reads only that seat's cookie (see seatOf). */
  session(req) {
    const name = this.sessionName(req);
    if (!name) return null;
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]{20,})`));
    const key = m && keyOf(m[1]);
    const s = key && this.sessions.get(key);
    if (!s || s.expires < Date.now()) return null;
    return { key, ...s };
  }

  /**
   * The admin logs in under any free name with the admin password. Wrong tries count per address
   * and towards the shared limit; once that is used up the admin password is refused like a wrong
   * one (so the answer gives nothing away), except from the admin's own browser. Players' wrong
   * passwords count apart (server/accounts.mjs): typos on the same Wi-Fi never lock the admin out.
   */
  /**
   * `panel`: a login to brieltje.be/admin (true) or to the game (false). Two-step login is asked for the panel
   * only (Yoshi, 7 Nov 2026); a game login gets a session the panel refuses while it is on (panelAdmin).
   */
  async login(req, username, password, code, panel = true) {
    const ip = bucketOf(clientIp(req));
    const now = Date.now();
    if (this.failures.count(ip, now) >= MAX_FAILS) return { error: 'Too many attempts. Try again in 15 minutes.', code: 'tooMany', status: 429 };
    const name = String(username || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) return { error: 'Your name: 2 to 20 characters, letters, digits, - or _.', code: 'nameFormat', status: 400 };
    const adminDevice = this.knownDevice(req, ADMIN_KEY);
    const open = !!ADMIN_PASSWORD && (adminDevice || this.adminFails.count(ADMIN_KEY, now) < ADMIN_FAILS);
    this.failures.add(ip, now);
    this.adminFails.add(ADMIN_KEY, now);
    if (!open || !sameText(String(password || ''), ADMIN_PASSWORD)) {
      this.log('login_failed', req, { username: name });
      if (this.adminFails.count(ADMIN_KEY, now) === ADMIN_FAILS) this.log('login_admin_limited', req, { username: ADMIN_KEY });
      return { error: 'Wrong password.', code: 'wrongPassword', status: 401 };
    }
    const until = this.blocked.get(name);
    if (until && until > now) {
      this.log('login_blocked_kicked', req, { username: name });
      return { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    }
    if ([...this.sessions.values()].some((s) => s.username === name && s.role !== 'admin') || this.claiming.has(name)) {
      return { error: `${name} is in use by a player. Pick another name.`, code: 'nameInUse', args: { name }, status: 409 };
    }
    // A player's account name stays theirs: the admin password never logs in under it. Asked only after the
    // right admin password, so it tells a guesser nothing.
    if (await this.store.getAccount(name)) return { error: `${name} is a player's account. Pick another name.`, code: 'nameAccount', args: { name }, status: 409 };
    // Two-step login (server/adminMfa.mjs), last, so a refused name never uses up a code. The right password
    // without a code isn't counted (every wrong password was, and the right one is no secret to whoever typed
    // it); a wrong code stays counted like a wrong password.
    const mfaGen = this.mfa.gen; // turned on while this login runs: it gets no session (below)
    if (this.mfa.on && panel) {
      if (!code) {
        this.failures.undo(ip, now);
        this.adminFails.undo(ADMIN_KEY, now);
        return { error: 'Type the 6-digit code from your authenticator app.', code: 'mfaNeeded', status: 401 };
      }
      if (!(await this.mfa.check(code))) {
        this.log('login_mfa_failed', req, { username: name });
        return { error: 'That code is not right. Type the 6 digits the app shows now.', code: 'wrongCode', status: 401 };
      }
    }
    this.failures.undo(ip, now);
    this.adminFails.undo(ADMIN_KEY, now);
    const epoch = this.epoch.get(name) || 0; // kicked while the session is saved: it doesn't count
    const token = randomBytes(32).toString('base64url');
    const key = keyOf(token);
    // A panel session is marked (kept in the store's device column, which admin sessions don't use otherwise).
    await this.store.saveSession(key, name, 'admin', now + SESSION_MS, panel ? 'panel' : null);
    if ((this.epoch.get(name) || 0) !== epoch || (this.blocked.get(name) || 0) > Date.now()) {
      await this.store.deleteSession(key);
      return { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    }
    // A sign-up for this name that began while the session was saved (server/accounts.mjs): the name is theirs.
    if ((await this.store.getAccount(name)) || this.claiming.has(name)) { // claiming last: no await between it and the session below
      await this.store.deleteSession(key);
      return { error: `${name} is a player's account. Pick another name.`, code: 'nameAccount', args: { name }, status: 409 };
    }
    if (panel && this.mfa.gen !== mfaGen) {
      await this.store.deleteSession(key);
      return { error: 'Two-step login was just turned on. Log in again with a code.', code: 'mfaNeeded', status: 401 };
    }
    this.sessions.set(key, { username: name, role: 'admin', expires: now + SESSION_MS, panel });
    this.log('login_ok', req, { username: name, detail: 'admin' });
    return { token, username: name, role: 'admin', device: this.newDevice(ADMIN_KEY) };
  }

  /**
   * Join multiplayer as a guest: a name, no account (Yoshi, 7 Nov 2026: no PIN). `online(name)`: someone
   * plays under that name right now (taking it would throw them out). `allowed`: the admin's rule lets
   * guests in. `full()`: as many play as the admin allows. Joins count per address (GUEST_JOINS) and
   * the guest sessions in all (GUEST_SESSIONS). `guest` in the answer: a new guest cookie to set.
   */
  async join(req, nickname, online, allowed = true, full = () => false) {
    if (!allowed) return { error: 'Joining as a guest is switched off right now. Log in with an account.', code: 'guestsOff', status: 403 };
    const ip = bucketOf(clientIp(req));
    const now = Date.now();
    // The browser's guest cookie, or a new one (set with this answer, a refusal too): its id is what a
    // kick keeps out. The count per address holds whatever the cookies.
    const cookie = this.guestDevice(req);
    const guest = cookie ? undefined : this.newDevice(GUEST_DEVICE);
    const dev = cookie ?? guest.split('.')[1];
    const out = (r) => (guest ? { ...r, guest } : r);
    const removed = { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    if ((this.blockedDevices.get(dev) || 0) > now) return out(removed);
    // Right after a kick from this address, only browsers that had joined there before it go on
    // joining. A new identity (a private window, cleared cookies, a cookie fetched ahead and never
    // used to join) waits too.
    const kick = this.kickedFrom.get(ip);
    if (kick && kick.until > now && !kick.known.has(dev)) {
      this.log('join_refused_kick', req, { username: String(nickname || '').slice(0, 20) });
      return out({ error: 'Someone on this network was just removed by the admin. Ask the admin to let you in.', code: 'kickedHere', status: 403 });
    }
    const name = String(nickname || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) return out({ error: 'Your name: 2 to 20 characters, letters, digits, - or _.', code: 'nameFormat', status: 400 });
    if (this.guestJoins.count(ip, now) >= GUEST_JOINS) {
      return out({ error: 'Too many joins from this network. Try again in 15 minutes.', code: 'joinsTooMany', status: 429 });
    }
    // Full: said here, before a session is made (the game's connection would only be refused).
    if (full()) return out({ error: 'The house is full right now. Ask the admin to allow more players.', code: 'full', status: 503 });
    if (RESERVED.has(name)) return out({ error: 'That name is taken. Pick another name.', code: 'nameTaken', status: 409 });
    const until = this.blocked.get(name);
    if (until && until > now) return out(removed);
    // A player's account name is theirs alone (server/accounts.mjs).
    if (await this.store.getAccount(name)) return out({ error: `${name} belongs to an account. Log in, or pick another name.`, code: 'nameAccount', args: { name }, status: 409 });
    // From here on no await until the session is in memory: two joins (or a join and a sign-up) can't both take the name.
    if (online(name)) return out({ error: `Someone is playing as ${name} right now. Pick another name.`, code: 'nameOnline', args: { name }, status: 409 });
    if (this.nameHeld(name, now)) {
      return out({ error: `${name} is taken today (a name stays with whoever joined with it). Pick another name.`, code: 'nameToday', args: { name }, status: 409 });
    }
    if ([...this.sessions.values()].filter((s) => s.role === 'guest').length >= GUEST_SESSIONS) {
      return out({ error: 'Too many guests right now. Try again later, or log in with an account.', code: 'guestsFull', status: 503 });
    }
    this.guestJoins.add(ip, now);
    // The browser's id is kept with the session in the store too, so a kick after a restart still keeps that browser out.
    const { token } = await this.startSession(name, 'guest', SESSION_MS, { ip, device: dev });
    this.noteJoin(ip, dev, now);
    this.log('join_ok', req, { username: name, detail: 'guest' });
    return out({ token, username: name, role: 'guest' });
  }

  setCookie(name, value, maxAgeS) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${this.secure ? '; Secure' : ''}`;
  }

  /** The session cookie: the normal one, or seat `seat`'s (1 to SEATS, see seatOf). */
  cookie(token, maxAgeS = SESSION_MS / 1000, seat = 0) {
    const name = seat ? this.names.seats[seat - 1] : this.names.session;
    if (!name) throw new Error('no such seat');
    return this.setCookie(name, token, maxAgeS);
  }

  deviceCookie(value) {
    return this.setCookie(this.names.device, value, DEVICE_MS / 1000);
  }

  /**
   * The admin on brieltje.be/admin: a session from the panel's own login (which asked for the two-step code),
   * or any admin session while two-step login is off. The game's admin login works in the game only then.
   */
  panelAdmin(req) {
    const s = this.session(req);
    return s?.role === 'admin' && (s.panel === true || !this.mfa.on);
  }

  /** A two-step code typed by the logged-in admin (server/adminMfa.mjs): over the limit for wrong ones from here? */
  codeLimited(req, sessionKey) {
    const now = Date.now();
    // Not the shared cap on admin passwords: strangers' wrong passwords would then stop the admin managing it.
    return this.failures.count(bucketOf(clientIp(req)), now) >= MAX_FAILS || this.codeFails.count(sessionKey, now) >= SESSION_CODE_FAILS;
  }

  /** A wrong two-step code: counted like a wrong admin password, per address and in all. */
  codeWrong(req, by, sessionKey) {
    const now = Date.now();
    this.codeFails.add(sessionKey, now);
    this.failures.add(bucketOf(clientIp(req)), now);
    this.adminFails.add(ADMIN_KEY, now);
    this.log('mfa_code_failed', req, { username: by });
  }

  /** A player's device cookie (server/accounts.mjs). */
  accountDeviceCookie(value) {
    return this.setCookie(this.names.acct, value, DEVICE_MS / 1000);
  }

  async logout(key) {
    this.sessions.delete(key);
    await this.store.deleteSession(key);
  }

  /** The address a request came from, as the guessing limits count it (an IPv6 /64 is one). */
  addressOf(req) {
    return bucketOf(clientIp(req));
  }

  /**
   * Remove someone: keep their name out for KICK_MS and end their sessions. Their browser (the guest
   * cookie they joined with, and `devices`: the one their game connection came with) can't join as a
   * guest for those minutes either, under another name. A new identity doesn't help: at the
   * addresses they played from (`addresses`), only the browsers that had joined there before the
   * kick (noteJoin) go on joining for those minutes, so the rest of a venue plays on. That set lives
   * in memory with the kick, as the kicks do (a restart ends them all). Their browsers are forgotten
   * as having joined there. An account's name stays out for those minutes too (server/accounts.mjs login).
   */
  async kick(username, { devices = [], addresses = [] } = {}) {
    const now = Date.now();
    const until = now + KICK_MS;
    this.blocked.set(username, until);
    for (const s of this.sessions.values()) {
      if (s.username !== username) continue;
      devices = [...devices, s.device];
      addresses = [...addresses, s.ip];
    }
    devices = [...new Set(devices.filter(Boolean))];
    for (const d of devices) {
      this.blockedDevices.set(d, until);
      this.forgetDevice(d);
    }
    for (const a of addresses) if (a) this.kickedFrom.set(a, { until, known: new Set(this.joinedFrom.get(a)?.keys() ?? []) });
    await this.endSessionsOf(username);
  }
}
