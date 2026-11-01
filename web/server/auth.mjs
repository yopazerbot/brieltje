// Logins and sessions.
//
// - Admin: password from ADMIN_PASSWORD (Railway variable); without it there is no admin.
//   The admin logs in under any free name (Yoshi, 30 Oct 2026) with the admin password.
//   There are no other accounts (Yoshi, 30 Oct 2026: everyone else joins with the PIN).
//   ADMIN_USERNAME (default "admin") stays reserved: guests can't take it.
// - Sessions: random token in an HttpOnly, SameSite=Strict cookie. The server
//   keeps a SHA-256 hash of the token in memory and in the store, so sessions
//   survive a redeploy and a leaked database can't be used to log in.
// - Password guessing: at most 10 wrong passwords per address in 15 minutes (an IPv6 /64
//   counts as one address) and 20 tries at the admin password in an hour from everyone
//   together (else a guesser would take a new name and address for each try). Once that is
//   used up the admin password is refused like a wrong one, except from a browser that logged
//   in as admin before (a device cookie, so nobody can lock the admin out by guessing).
// - Multiplayer with a PIN (Yoshi, 30 Oct 2026): a name and one shared PIN, no account.
//   These "guests" play like players. The PIN is only checked here, never sent to
//   browsers. A 4-digit PIN has 10,000 values, so wrong PINs are counted (Yoshi, 1 Nov 2026,
//   for meetups where everyone shares one Wi-Fi and so one address): per browser (a guest
//   cookie), per address with a ceiling a venue doesn't reach, and for everyone together
//   (DEVICE_PIN_FAILS and below, with the numbers). Browsers that joined with the PIN before skip
//   the last two (a device cookie), so a guesser can't lock the family out, and wrong PINs never
//   count against the admin's password. The admin's reserved name can't be taken, nor anyone's
//   name while their session lasts (12 hours, or until they log out). Kicking a guest also keeps
//   their browser from joining with the PIN for those 10 minutes (else they would be back at once
//   under another name), not their whole address. The admin can switch PIN joining off, and can
//   lift every lockout at once from the game's admin tab.
// - The admin changes the PIN in the settings (kept in the store; MULTIPLAYER_PIN, or 0473,
//   is only the PIN to start with). A new PIN logs out everyone who joined with the old one,
//   and their browsers lose the right to skip the shared limit on wrong PINs.

import { randomBytes, scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { BlockList, isIP, isIPv6 } from 'node:net';

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
const DEVICE_MS = 90 * 24 * 3600_000;
const NAME_RE = /^[a-z0-9_-]{2,20}$/;
const ADMIN_KEY = '#admin'; // what the admin's device cookie is signed for, whatever the name
const START_PIN = process.env.MULTIPLAYER_PIN ?? '0473'; // until the admin sets one in the game; empty: none
const PIN_RE = /^\d{4,12}$/;
// Wrong PINs: online guessing, often from behind a shared address (a meetup's Wi-Fi is one address for
// everyone there). Per browser (its guest cookie) a few, then only that browser waits, so one child's
// typos don't stop the others. A guesser who drops or swaps cookies is a new browser each time, so the
// address counts too, whatever the cookies: 10 in 5 minutes pause it for 2 minutes, and an hourly cap
// pauses it for longer. All addresses together have an hourly cap too, against guessers spread over
// many addresses; one address counts at most 10 an hour towards it, so one address (a venue's typos,
// or one attacker) can never lock out everyone else. Browsers that joined with this PIN before skip
// the address and overall counts. The hourly caps go with the PIN's length. Average time to guess the
// PIN (half of all PINs tried) at the caps:
// - 4 or 5 digits: 30 an hour per address and overall. From one address: a week for 4 digits, about
//   70 days for 5. From many: the overall cap fills after 3 addresses' shares, so at most 90 an hour:
//   about 2 days for 4 digits, about 23 for 5.
// - 6 digits or more: 60 an hour per address, 100 overall (10 addresses' shares, so at most 600 an
//   hour from many). A million PINs: about 11 months from one address, about 5 weeks from many. A
//   meetup's typos don't reach these caps: use 6 digits for a meetup.
const DEVICE_PIN_FAILS = 5; // per browser in DEVICE_PIN_WINDOW_MS
const DEVICE_PIN_WINDOW_MS = 15 * 60_000;
const BURST_PIN_FAILS = 10; // per address in BURST_WINDOW_MS ...
const BURST_WINDOW_MS = 5 * 60_000;
const BURST_PAUSE_MS = 2 * 60_000; // ... pause that address this long
const PIN_SHARE = 10; // wrong PINs an hour one address counts towards the overall cap at most
/** The hourly caps for the current PIN: per address and from all addresses together. */
const pinCaps = (pin) => (pin.length >= 6 ? { address: 60, all: 100 } : { address: 30, all: 30 });
const PIN_DEVICE = '#pin'; // what the device cookie of a browser that joined with the PIN is signed for
const GUEST_DEVICE = '#guest'; // what the guest cookie, telling browsers apart for the counts above, is signed for
const KICK_MS = 10 * 60_000; // a kicked player's name and browser stay out this long
const JOINED_KEEP = 256; // browsers remembered per address for kicks (see noteDevice)
const LOG_DAYS = 90; // the login log holds IP addresses: kept this long
const LOG_ROWS = 20_000;

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
class Attempts {
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

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;
}

async function verifyHash(password, stored) {
  const [kind, n, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(Buffer.from(actual), expected);
}

function sameText(a, b) {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** What the server keeps for a session token. */
const keyOf = (token) => createHash('sha256').update(token).digest('base64url');

export class Auth {
  /** `secure`: HTTPS only (Railway). The cookies then carry the __Host- prefix: only this host can set them. */
  constructor(store, secure) {
    this.store = store;
    this.secure = secure;
    this.names = secure
      ? { session: '__Host-briel_session', device: '__Host-briel_device', pin: '__Host-briel_pin', guest: '__Host-briel_guest' }
      : { session: 'briel_session', device: 'briel_device', pin: 'briel_pin', guest: 'briel_guest' };
    this.sessions = new Map(); // hash of the token -> { username, role, expires, ip, device }
    this.failures = new Attempts(FAIL_WINDOW_MS); // wrong admin passwords per address (bucketOf)
    this.adminFails = new Attempts(3600_000); // tries at the admin password, all addresses together (one key)
    this.pinFails = new Attempts(3600_000); // wrong PINs, all addresses together (one key)
    this.pinByDevice = new Attempts(DEVICE_PIN_WINDOW_MS); // wrong PINs per browser (its guest cookie)
    this.pinByAddress = new Attempts(3600_000); // wrong PINs per address (bucketOf), for the hourly cap
    this.pinBurst = new Attempts(BURST_WINDOW_MS); // wrong PINs per address, for the short pause
    this.pinShare = new Attempts(3600_000); // wrong PINs per address counted towards the overall cap
    this.pinPaused = new Map(); // address -> until: paused after a burst of wrong PINs
    this.pin = START_PIN;
    this.pinGen = 0; // raised whenever the PIN changes: a join checked against an older PIN doesn't count
    this.blocked = new Map(); // username -> until (kicked)
    this.blockedDevices = new Map(); // guest cookie id -> until: a kicked player's browser, for PIN joins
    this.kickedFrom = new Map(); // address -> { until, known }: a kick there; only browsers in `known` may join meanwhile
    this.joinedFrom = new Map(); // address -> Map(browser -> last seen): browsers that joined or played there (see kick)
    this.revokedPins = new Map(); // a kicked player's "knew the PIN" cookie (its random part) -> until
    this.epoch = new Map(); // username -> counter, raised whenever their sessions are revoked
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
   * the store, so changing ADMIN_PASSWORD in Railway logs the admin out); guest sessions while
   * there is a PIN; sessions of the old player accounts not at all.
   * Also the key that signs device cookies, and a first pass over the login log.
   */
  async loadSessions() {
    this.deviceKey = await this.store.getMeta('device_key');
    if (!this.deviceKey) await this.store.setMeta('device_key', (this.deviceKey = randomBytes(32).toString('base64url')));
    this.pruneLog();
    let adminOk = false;
    if (ADMIN_PASSWORD) {
      const fp = await this.store.getMeta('admin_fp');
      adminOk = !!fp && (await verifyHash(ADMIN_PASSWORD, fp));
      if (!adminOk) await this.store.setMeta('admin_fp', await hashPassword(ADMIN_PASSWORD));
    }
    const savedPin = await this.store.getMeta('pin');
    if (savedPin && PIN_RE.test(savedPin)) this.pin = savedPin;
    for (const s of await this.store.loadSessions(Date.now())) {
      const valid = s.role === 'admin' ? adminOk : s.role === 'guest' && !!this.pin && s.username !== ADMIN;
      if (valid) this.sessions.set(s.key, { username: s.username, role: s.role, expires: s.expires, ...(s.device ? { device: s.device } : {}) });
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
    this.pinFails.cleanup(now);
    this.pinByDevice.cleanup(now);
    this.pinByAddress.cleanup(now);
    this.pinBurst.cleanup(now);
    this.pinShare.cleanup(now);
    for (const map of [this.blocked, this.blockedDevices, this.pinPaused, this.revokedPins]) {
      for (const [k, until] of map) if (until < now) map.delete(k);
    }
    for (const [a, k] of this.kickedFrom) if (k.until < now) this.kickedFrom.delete(a); // its set of browsers goes with it
    for (const [a, seen] of this.joinedFrom) {
      for (const [d, at] of seen) if (now - at > SESSION_MS) seen.delete(d);
      if (!seen.size) this.joinedFrom.delete(a);
    }
  }

  /**
   * A browser joined or plays from an address: remembered there for a session's length (12 hours),
   * at most JOINED_KEEP per address (the oldest go first), in memory only. A kick keeps everyone but
   * these out at that address for its 10 minutes (see kick).
   */
  noteDevice(address, device, now = Date.now()) {
    if (!address || !device) return;
    const seen = this.joinedFrom.get(address) ?? new Map();
    seen.delete(device); // to the end: the most recent
    seen.set(device, now);
    while (seen.size > JOINED_KEEP) seen.delete(seen.keys().next().value);
    this.joinedFrom.set(address, seen);
  }

  /**
   * The admin lifts every lockout on joining: the wrong-PIN counts and pauses (per browser, per
   * address, all together) and the kicks (names, browsers, addresses). For a meetup where a few
   * typos or one kick would otherwise keep people out. Guesses at the admin password still count.
   */
  liftLockouts(by) {
    const maps = [this.blocked, this.blockedDevices, this.pinPaused, this.kickedFrom, this.revokedPins];
    const lifted = this.pinByDevice.map.size + this.pinByAddress.map.size + this.pinFails.map.size + maps.reduce((n, m) => n + m.size, 0);
    this.pinByDevice = new Attempts(DEVICE_PIN_WINDOW_MS);
    this.pinByAddress = new Attempts(3600_000);
    this.pinBurst = new Attempts(BURST_WINDOW_MS);
    this.pinShare = new Attempts(3600_000);
    this.pinFails = new Attempts(3600_000);
    for (const m of maps) m.clear();
    this.log('lockouts_lifted', null, { username: by, detail: `${lifted} lifted` });
    return lifted;
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

  /** Whether this browser joined with the current PIN before, and wasn't kicked since (see kick). */
  joinedBefore(req) {
    const id = this.deviceCookieOf(req, this.names.pin, this.pinDevice());
    return !!id && !this.revokedPins.has(id);
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

  /** Session for a request (cookie), or null. */
  session(req) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${this.names.session}=([A-Za-z0-9_-]{20,})`));
    const key = m && keyOf(m[1]);
    const s = key && this.sessions.get(key);
    if (!s || s.expires < Date.now()) return null;
    return { key, ...s };
  }

  /**
   * The admin logs in under any free name with the admin password. Wrong tries count per address
   * and towards the shared limit; once that is used up the admin password is refused like a wrong
   * one (so the answer gives nothing away), except from the admin's own browser. Wrong PINs count
   * apart (see join): others mistyping the PIN on the same Wi-Fi never lock the admin out.
   */
  async login(req, username, password) {
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
    this.failures.undo(ip, now);
    this.adminFails.undo(ADMIN_KEY, now);
    const until = this.blocked.get(name);
    if (until && until > now) {
      this.log('login_blocked_kicked', req, { username: name });
      return { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    }
    if ([...this.sessions.values()].some((s) => s.username === name && s.role !== 'admin')) {
      return { error: `${name} is in use by a player. Pick another name.`, code: 'nameInUse', args: { name }, status: 409 };
    }
    const epoch = this.epoch.get(name) || 0; // kicked while the session is saved: it doesn't count
    const token = randomBytes(32).toString('base64url');
    const key = keyOf(token);
    await this.store.saveSession(key, name, 'admin', now + SESSION_MS);
    if ((this.epoch.get(name) || 0) !== epoch || (this.blocked.get(name) || 0) > Date.now()) {
      await this.store.deleteSession(key);
      return { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    }
    this.sessions.set(key, { username: name, role: 'admin', expires: now + SESSION_MS });
    this.log('login_ok', req, { username: name, detail: 'admin' });
    return { token, username: name, role: 'admin', device: this.newDevice(ADMIN_KEY) };
  }

  /**
   * Join multiplayer with a name and the shared PIN. `online(name)`: someone plays under that
   * name right now (taking it would throw them out). `full()`: as many play as the admin allows.
   * The PIN is checked before anything about the name or the house is told, so neither can be
   * probed without it. Wrong PINs count per browser, per address and all together (see
   * DEVICE_PIN_FAILS); a browser that joined with this PIN before skips the last two, so a guesser
   * on the same Wi-Fi can't keep the family out. `guest` in the answer: a new guest cookie to set.
   */
  async join(req, nickname, pin, online, allowed = true, full = () => false) {
    if (!this.pin || !allowed) return { error: 'Joining with the PIN is switched off right now.', code: 'pinOff', status: 403 };
    const ip = bucketOf(clientIp(req));
    const now = Date.now();
    // The browser's guest cookie, or a new one (set with this answer, a wrong PIN too): its id is what
    // the wrong PINs per browser and a kick count against. A guesser who drops it is a new browser
    // each time; the counts per address hold whatever the cookies.
    const known = this.guestDevice(req);
    const guest = known ? undefined : this.newDevice(GUEST_DEVICE);
    const dev = known ?? guest.split('.')[1];
    const out = (r) => (guest ? { ...r, guest } : r);
    const removed = { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    if ((this.blockedDevices.get(dev) || 0) > now) return out(removed);
    // Right after a kick from this address, only browsers that had joined or played there before it go
    // on joining. A new identity (a private window, cleared cookies, a cookie fetched ahead and never
    // used) waits too.
    const kick = this.kickedFrom.get(ip);
    if (kick && kick.until > now && !kick.known.has(dev)) {
      this.log('join_refused_kick', req, { username: String(nickname || '').slice(0, 20) });
      return out({ error: 'Someone on this network was just removed by the admin. Ask the admin to let you in.', code: 'kickedHere', status: 403 });
    }
    const name = String(nickname || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) return out({ error: 'Your name: 2 to 20 characters, letters, digits, - or _.', code: 'nameFormat', status: 400 });
    const joinedBefore = this.joinedBefore(req);
    const caps = pinCaps(this.pin);
    if (this.pinByDevice.count(dev, now) >= DEVICE_PIN_FAILS) {
      return out({ error: 'Too many wrong PINs on this device. Ask the admin to lift the lockout.', code: 'pinDevice', status: 429 });
    }
    if (!joinedBefore && (this.pinPaused.get(ip) || 0) > now) {
      return out({ error: 'Too many wrong PINs from this network. Try again in 2 minutes.', code: 'pinPaused', status: 429 });
    }
    if (!joinedBefore && this.pinByAddress.count(ip, now) >= caps.address) {
      return out({ error: 'Too many wrong PINs from this network. Ask the admin to lift the lockout.', code: 'pinNetwork', status: 429 });
    }
    if (!joinedBefore && this.pinFails.count('pin', now) >= caps.all) {
      return out({ error: 'Too many wrong PINs lately. Try again in an hour.', code: 'pinTooMany', status: 429 });
    }
    const gen = this.pinGen;
    const device = this.pinDevice(); // for the PIN checked now, even if it changes while this join waits
    if (!sameText(String(pin || ''), this.pin)) {
      this.pinByDevice.add(dev, now);
      this.pinByAddress.add(ip, now);
      this.pinBurst.add(ip, now);
      if (this.pinShare.count(ip, now) < PIN_SHARE) {
        this.pinShare.add(ip, now);
        this.pinFails.add('pin', now); // the overall count: at most PIN_SHARE from one address
      }
      this.log('pin_failed', req, { username: name });
      // A pause for everyone at an address, or everywhere, shows in the admin page's log: the admin
      // can lift it there with "Lift lockouts". Every wrong PIN while the last 5 minutes hold 10 pauses
      // the address again (only the first is logged), so the end of a pause gives no free burst.
      const burst = this.pinBurst.count(ip, now);
      if (burst >= BURST_PIN_FAILS) this.pinPaused.set(ip, now + BURST_PAUSE_MS);
      if (burst === BURST_PIN_FAILS) this.log('pin_limited_address', req, { detail: `${BURST_PIN_FAILS} wrong in 5 minutes: paused 2 minutes` });
      if (this.pinByAddress.count(ip, now) === caps.address) this.log('pin_limited_address', req, { detail: `${caps.address} wrong in an hour` });
      if (this.pinFails.count('pin', now) === caps.all) this.log('pin_limited', req, { detail: `${caps.all} wrong in an hour` });
      return out({ error: 'Wrong PIN.', code: 'wrongPin', status: 401 });
    }
    // Full: said here, before a session is made (the game's connection would only be refused).
    if (full()) return out({ error: 'The house is full right now. Ask the admin to allow more players.', code: 'full', status: 503 });
    if (name === ADMIN) return out({ error: 'That name is taken. Pick another name.', code: 'nameTaken', status: 409 });
    if (online(name)) return out({ error: `Someone is playing as ${name} right now. Pick another name.`, code: 'nameOnline', args: { name }, status: 409 });
    if ([...this.sessions.values()].some((s) => s.username === name && s.expires > now)) {
      return out({ error: `${name} is taken today (a name stays with whoever joined with it). Pick another name.`, code: 'nameToday', args: { name }, status: 409 });
    }
    const until = this.blocked.get(name);
    if (until && until > now) return out(removed);
    const changed = out({ error: 'The PIN has just been changed. Ask for the new one.', code: 'pinChanged', status: 401 });
    if (this.pinGen !== gen) return changed; // changed while the name was checked
    const token = randomBytes(32).toString('base64url');
    const key = keyOf(token);
    const knew = this.newDevice(device); // the "knew the PIN" cookie: its id goes with the session, for a kick to revoke
    // The name is taken here, before the first await: two joins at once can't both get it. The browser's
    // id is kept with the session in the store too, so a kick after a restart still keeps that browser out.
    this.sessions.set(key, { username: name, role: 'guest', expires: now + SESSION_MS, ip, device: dev, pinId: knew.split('.')[1] });
    try {
      await this.store.saveSession(key, name, 'guest', now + SESSION_MS, dev);
    } catch (e) {
      this.sessions.delete(key);
      throw e;
    }
    if (this.pinGen !== gen) {
      this.sessions.delete(key); // changed while saving: setPin may have missed it
      await this.store.deleteSession(key);
      return changed;
    }
    this.noteDevice(ip, dev, now);
    this.log('join_ok', req, { username: name, detail: 'pin' });
    return out({ token, username: name, role: 'guest', device: knew });
  }

  /** The id of this browser's "knew the PIN" cookie for the current PIN, or null (see kick). */
  pinCookieId(req) {
    return this.deviceCookieOf(req, this.names.pin, this.pinDevice());
  }

  /** What a PIN device cookie is signed for: it only counts for the PIN it was earned with. */
  pinDevice() {
    return `${PIN_DEVICE}:${createHash('sha256').update(this.pin).digest('base64url').slice(0, 12)}`;
  }

  /** The admin sets a new PIN (kept across restarts). Everyone who joined with the old one is logged out. */
  async setPin(req, by, pin) {
    const next = String(pin ?? '').trim();
    if (!PIN_RE.test(next)) return { error: 'The PIN: 4 to 12 digits.', code: 'pinFormat', status: 400 };
    // In memory first and all at once (no await in between): joins still checking the old PIN
    // see the new generation and fail, and every guest session is gone before anything else runs.
    this.pin = next;
    this.pinGen++;
    this.pinFails = new Attempts(3600_000); // wrong guesses at the old PIN don't count any more
    const guests = new Set([...this.sessions.values()].filter((s) => s.role === 'guest').map((s) => s.username));
    for (const name of guests) this.revoke(name);
    await this.store.setMeta('pin', next);
    for (const name of guests) await this.store.deleteSessionsOf(name);
    this.log('pin_changed', req, { username: by, detail: `${guests.size} joined with the old PIN, logged out` });
    return { ok: true, loggedOut: guests.size };
  }

  pinCookie(value) {
    return this.setCookie(this.names.pin, value, DEVICE_MS / 1000);
  }

  setCookie(name, value, maxAgeS) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${this.secure ? '; Secure' : ''}`;
  }

  cookie(token, maxAgeS = SESSION_MS / 1000) {
    return this.setCookie(this.names.session, token, maxAgeS);
  }

  deviceCookie(value) {
    return this.setCookie(this.names.device, value, DEVICE_MS / 1000);
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
   * cookie they joined with, and `devices`: the one their game connection came with) can't join with
   * the PIN for those minutes either, under another name. A new identity doesn't help: at the
   * addresses they played from (`addresses`), only the browsers that had joined or played there
   * before the kick (noteDevice) go on joining for those minutes, so the rest of a venue plays on.
   * That set lives in memory with the kick, as the kicks do (a restart ends them all). Their "knew
   * the PIN" cookie (`pins`) no longer lets them skip the counts of wrong PINs.
   */
  async kick(username, { devices = [], addresses = [], pins = [] } = {}) {
    const now = Date.now();
    const until = now + KICK_MS;
    this.blocked.set(username, until);
    for (const s of this.sessions.values()) {
      if (s.username !== username) continue;
      devices = [...devices, s.device];
      addresses = [...addresses, s.ip];
      pins = [...pins, s.pinId];
    }
    for (const d of devices) if (d) this.blockedDevices.set(d, until);
    for (const a of addresses) {
      if (!a) continue;
      const known = new Set(this.joinedFrom.get(a)?.keys() ?? []);
      for (const d of devices) known.delete(d);
      this.kickedFrom.set(a, { until, known });
    }
    for (const p of pins) if (p) this.revokedPins.set(p, now + DEVICE_MS);
    await this.endSessionsOf(username);
  }
}
