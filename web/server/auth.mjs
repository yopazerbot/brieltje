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
// Wrong PINs (online guessing of a 4-digit PIN, often from behind a shared address: a meetup's Wi-Fi is
// one address for everyone there). Per browser (its guest cookie) a few, then that browser waits. Per
// address a ceiling a whole venue never reaches, but slow for a guesser who drops cookies: 60 an hour
// is 1,440 a day, so the 10,000 PINs of 4 digits take a week to go through (3.5 days on average). All
// addresses together 100 an hour (from browsers that never joined), more than one venue can reach, so
// it only stops guessers spread over many addresses: 4 days to go through them all, 2 on average.
const DEVICE_PIN_FAILS = 5; // per browser in DEVICE_PIN_WINDOW_MS
const DEVICE_PIN_WINDOW_MS = 15 * 60_000;
const ADDRESS_PIN_FAILS = 60; // per address in an hour
const PIN_FAILS = 100; // from all addresses together in an hour
const PIN_DEVICE = '#pin'; // what the device cookie of a browser that joined with the PIN is signed for
const GUEST_DEVICE = '#guest'; // what the guest cookie, telling browsers apart for the counts above, is signed for
const KICK_MS = 10 * 60_000; // a kicked player's name and browser stay out this long
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
    this.pinByAddress = new Attempts(3600_000); // wrong PINs per address (bucketOf)
    this.pin = START_PIN;
    this.pinGen = 0; // raised whenever the PIN changes: a join checked against an older PIN doesn't count
    this.blocked = new Map(); // username -> until (kicked)
    this.blockedDevices = new Map(); // guest cookie id -> until: a kicked player's browser, for PIN joins
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
      if (valid) this.sessions.set(s.key, { username: s.username, role: s.role, expires: s.expires });
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
    for (const [u, until] of this.blocked) if (until < now) this.blocked.delete(u);
    for (const [d, until] of this.blockedDevices) if (until < now) this.blockedDevices.delete(d);
  }

  /**
   * The admin lifts every lockout on joining: the wrong-PIN counts (per browser, per address, all
   * together) and the kicks (names and browsers). For a meetup where a few typos or one kick would
   * otherwise keep people out. Guesses at the admin password still count.
   */
  liftLockouts(by) {
    const lifted = this.pinByDevice.map.size + this.pinByAddress.map.size + this.pinFails.map.size + this.blocked.size + this.blockedDevices.size;
    this.pinByDevice = new Attempts(DEVICE_PIN_WINDOW_MS);
    this.pinByAddress = new Attempts(3600_000);
    this.pinFails = new Attempts(3600_000);
    this.blocked.clear();
    this.blockedDevices.clear();
    this.log('lockouts_lifted', null, { username: by, detail: `${lifted} lifted` });
    return lifted;
  }

  /** The guest cookie's id (its random part, checked against its signature), or null. */
  guestDevice(req) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${this.names.guest}=([0-9a-z]+)\\.([A-Za-z0-9_-]{16})\\.([A-Za-z0-9_-]{43})`));
    if (!m || !this.deviceKey || Date.now() - parseInt(m[1], 36) > DEVICE_MS) return null;
    return sameText(m[3], this.deviceMac(m[1], m[2], GUEST_DEVICE)) ? m[2] : null;
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
    // each time, and meets the ceiling per address instead.
    const known = this.guestDevice(req);
    const guest = known ? undefined : this.newDevice(GUEST_DEVICE);
    const dev = known ?? guest.split('.')[1];
    const out = (r) => (guest ? { ...r, guest } : r);
    if ((this.blockedDevices.get(dev) || 0) > now) return out({ error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 });
    const name = String(nickname || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) return out({ error: 'Your name: 2 to 20 characters, letters, digits, - or _.', code: 'nameFormat', status: 400 });
    const joinedBefore = this.knownDevice(req, this.pinDevice(), this.names.pin);
    if (this.pinByDevice.count(dev, now) >= DEVICE_PIN_FAILS) {
      return out({ error: 'Too many wrong PINs on this device. Ask the admin to lift the lockout.', code: 'pinDevice', status: 429 });
    }
    if (!joinedBefore && this.pinByAddress.count(ip, now) >= ADDRESS_PIN_FAILS) {
      return out({ error: 'Too many wrong PINs from this network. Ask the admin to lift the lockout.', code: 'pinNetwork', status: 429 });
    }
    if (!joinedBefore && this.pinFails.count('pin', now) >= PIN_FAILS) {
      return out({ error: 'Too many wrong PINs lately. Try again in an hour.', code: 'pinTooMany', status: 429 });
    }
    const gen = this.pinGen;
    const device = this.pinDevice(); // for the PIN checked now, even if it changes while this join waits
    if (!sameText(String(pin || ''), this.pin)) {
      this.pinByDevice.add(dev, now);
      this.pinByAddress.add(ip, now);
      this.pinFails.add('pin', now);
      this.log('pin_failed', req, { username: name });
      if (this.pinByAddress.count(ip, now) === ADDRESS_PIN_FAILS) this.log('pin_limited_address', req, {});
      if (this.pinFails.count('pin', now) === PIN_FAILS) this.log('pin_limited', req, {});
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
    if (until && until > now) return out({ error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 });
    const changed = out({ error: 'The PIN has just been changed. Ask for the new one.', code: 'pinChanged', status: 401 });
    if (this.pinGen !== gen) return changed; // changed while the name was checked
    const token = randomBytes(32).toString('base64url');
    const key = keyOf(token);
    // The name is taken here, before the first await: two joins at once can't both get it.
    this.sessions.set(key, { username: name, role: 'guest', expires: now + SESSION_MS, ip, device: dev });
    try {
      await this.store.saveSession(key, name, 'guest', now + SESSION_MS);
    } catch (e) {
      this.sessions.delete(key);
      throw e;
    }
    if (this.pinGen !== gen) {
      this.sessions.delete(key); // changed while saving: setPin may have missed it
      await this.store.deleteSession(key);
      return changed;
    }
    this.log('join_ok', req, { username: name, detail: 'pin' });
    return out({ token, username: name, role: 'guest', device: this.newDevice(device) });
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
   * Remove someone: keep their name out for KICK_MS and end their sessions. Their browser (the
   * guest cookie they joined with, and `devices`: the one their game connection came with) can't
   * join with the PIN for those minutes either, under another name. Only that browser: everyone
   * else on the same Wi-Fi keeps joining. Someone who clears their cookies gets back in under
   * another name, and can be kicked again.
   */
  async kick(username, devices = []) {
    const until = Date.now() + KICK_MS;
    this.blocked.set(username, until);
    for (const s of this.sessions.values()) if (s.username === username && s.device) this.blockedDevices.set(s.device, until);
    for (const d of devices) if (d) this.blockedDevices.set(d, until);
    await this.endSessionsOf(username);
  }
}
