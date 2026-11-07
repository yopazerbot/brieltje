// Player accounts (Yoshi, 7 Nov 2026): playing together needs no account (a guest has a name only), but
// an account keeps your name for you, puts your Zombies runs on the board and lets you open a room.
//
// - Signing up: a unique name (the guests' rules: 2 to 20 of a-z, 0-9, - and _, in lower case, so "Yoshi"
//   and "yoshi" are one name), an email address and a password, and "I'm 13 or older". The email is
//   only kept (no mail is sent yet) and never shown to other players. Two accounts may share one: a
//   unique email would let anyone block someone's address, and its refusal would say who has an account.
// - Passwords: 8 to 200 characters, not the name, not one of the most common ones. Kept as a scrypt hash
//   (server/auth.mjs hashPassword, 16 MB of memory a check). At most HASHING checks run at once and
//   QUEUE wait; more are told the server is busy, so a flood can't stall the site.
// - Logging in: "Wrong name or password." whether the name exists or not, and an unknown name costs the
//   same check (a hash of nothing). Wrong passwords count per address (LOGIN_FAILS_ADDRESS) and per
//   account (LOGIN_FAILS_ACCOUNT). A browser that logged in to that account before (its device cookie,
//   signed for the account) skips the account's count, so a guesser can't lock its owner out.
// - Sessions last ACCOUNT_MS; at most SESSIONS_PER_ACCOUNT at once (the oldest go). A new password ends
//   every other session; deleting the account, or the admin turning it off, ends them all.
// - Sign-ups count per address and in all (SIGNUPS_*), so nobody can take every name.
// - An account nobody logged in to for KEEP_DAYS is deleted with its scores (the privacy policy says so).
// - The admin (brieltje.be/admin) lists the accounts, sets a new password (shown to the admin once),
//   turns one off or on, and deletes one.

import { randomBytes } from 'node:crypto';
import { ADMIN_NAME, Attempts, bucketOf, clientIp, hashPassword, NAME_RE, verifyHash } from './auth.mjs';

export const ACCOUNT_MS = 30 * 24 * 3600_000;
const SESSIONS_PER_ACCOUNT = 10;
const WINDOW_MS = 15 * 60_000;
const LOGIN_FAILS_ADDRESS = 20; // wrong passwords per address in WINDOW_MS (a meetup's Wi-Fi is one address)
const LOGIN_FAILS_ACCOUNT = 10; // wrong passwords per account in WINDOW_MS, except from its own browsers
const SIGNUPS_ADDRESS = 20; // sign-ups per address in an hour (a meetup's room signing up together)
const SIGNUPS_ALL = 300; // sign-ups in an hour, everyone together
const HASHING = 2; // password checks at once
const QUEUE = 16; // and waiting
const KEEP_DAYS = 730; // an account unused this long is deleted
const PASS_MIN = 8;
const PASS_MAX = 200;
const EMAIL_MAX = 254;
// Something@something.something: no spaces, quotes or angle brackets. Not checked any further (no mail is sent).
const EMAIL_RE = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]+\.[^\s@<>"'`.]{2,}$/;
/** What a player's device cookie is signed for. */
const deviceFor = (name) => `#acct:${name}`;

// The most common passwords (from the public lists of leaked ones, English and Dutch), refused outright.
const COMMON = new Set(`
123456 123456789 12345678 1234567890 1234567 12345 password password1 password12 password123 qwerty qwerty123
qwertyuiop azerty azertyuiop abc123 abcd1234 111111 000000 123123 123321 654321 666666 777777 888888 121212
112233 11111111 00000000 87654321 iloveyou princess sunshine football baseball monkey dragon letmein welcome
welcome1 admin admin123 administrator login master secret shadow superman batman trustno1 starwars passw0rd
p@ssword p@ssw0rd changeme whatever freedom computer internet michael jessica charlie minecraft fortnite
roblox pokemon wachtwoord wachtwoord1 welkom welkom01 welkom123 geheim voetbal hallo hallo123 hallo1234
azerty123 brieltje briel smetlede zombies zombie
`.split(/\s+/).filter(Boolean));

export class Accounts {
  /**
   * `auth`: server/auth.mjs (sessions, cookies, the log, kicks); `online(name)`: someone plays under that
   * name right now (server/rooms.mjs, in the open world or a room).
   */
  constructor(auth, online = () => false) {
    this.auth = auth;
    this.store = auth.store;
    this.online = online;
    this.byAddress = new Attempts(WINDOW_MS); // wrong passwords per address
    this.byAccount = new Attempts(WINDOW_MS); // wrong passwords per account name
    this.signups = new Attempts(3600_000); // sign-ups per address, and 'all'
    this.active = 0; // password checks running
    this.waiting = []; // and waiting for one of those
    this.seenToday = new Map(); // name -> the day their last use was noted (see seen)
    auth.onLift = () => {
      const n = this.byAddress.map.size + this.byAccount.map.size;
      this.byAddress = new Attempts(WINDOW_MS);
      this.byAccount = new Attempts(WINDOW_MS);
      return n;
    };
    setInterval(() => {
      const now = Date.now();
      for (const a of [this.byAddress, this.byAccount, this.signups]) a.cleanup(now);
    }, 60_000).unref();
    setInterval(() => this.prune().catch((e) => console.error('account prune failed', String(e))), 24 * 3600_000).unref();
  }

  /** Start-up: what an unknown name is checked against, fighting totals for accounts only, and old accounts out. */
  async init() {
    this.dummy = await hashPassword(randomBytes(18).toString('base64url'));
    if ((await this.store.getMeta('stats_accounts_only')) !== '1') {
      await this.store.statsForAccountsOnly(); // the totals kept by a typed name before accounts (Yoshi: "Only accounts on the board")
      await this.store.setMeta('stats_accounts_only', '1');
    }
    await this.prune();
  }

  /** Accounts unused for KEEP_DAYS: deleted with their scores, their sessions ended. */
  async prune() {
    const gone = await this.store.pruneAccounts(KEEP_DAYS);
    for (const name of gone) await this.auth.endSessionsOf(name);
    if (gone.length) this.auth.log('accounts_pruned', null, { detail: `${gone.length} unused for ${KEEP_DAYS} days` });
  }

  /** A turn at checking a password (scrypt): true once it is ours, false when too many wait. Give it back with release(). */
  async acquire() {
    if (this.active < HASHING) {
      this.active++;
      return true;
    }
    if (this.waiting.length >= QUEUE) return false;
    await new Promise((resolve) => this.waiting.push(resolve));
    return true; // handed over by release, still counted in `active`
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
  /** `fn` with a turn at hashing, or null when the server is too busy. */
  async hashing(fn) {
    if (!(await this.acquire())) return null;
    try {
      return { value: await fn() };
    } finally {
      this.release();
    }
  }

  /** What is wrong with a new password for `name`, or null. */
  passwordProblem(password, name) {
    if (password.length < PASS_MIN) return { error: `Your password: at least ${PASS_MIN} characters.`, code: 'passShort', args: { n: PASS_MIN }, status: 400 };
    if (password.length > PASS_MAX) return { error: `Your password: at most ${PASS_MAX} characters.`, code: 'passLong', args: { n: PASS_MAX }, status: 400 };
    const low = password.toLowerCase();
    if (COMMON.has(low) || low === name || (low.includes(name) && low.length - name.length < 4)) {
      return { error: 'That password is too easy to guess. Pick another one.', code: 'passCommon', status: 400 };
    }
    return null;
  }

  /** A new session for a player, and at most SESSIONS_PER_ACCOUNT of theirs (the oldest go). */
  async session(req, name) {
    const ip = bucketOf(clientIp(req));
    const epoch = this.auth.epoch.get(name) || 0;
    const { token, key } = await this.auth.startSession(name, 'player', ACCOUNT_MS, { ip });
    // Turned off, deleted or kicked while the session was saved: it doesn't count.
    if ((this.auth.epoch.get(name) || 0) !== epoch || (this.auth.blocked.get(name) || 0) > Date.now()) {
      this.auth.sessions.delete(key);
      await this.store.deleteSession(key);
      return null;
    }
    const mine = [...this.auth.sessions].filter(([, s]) => s.username === name).sort((a, b) => a[1].expires - b[1].expires);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - SESSIONS_PER_ACCOUNT))) {
      this.auth.sessions.delete(k);
      await this.store.deleteSession(k);
    }
    return token;
  }

  /** Sign up: the answer has `token` (the session) and `device` (the account's device cookie), or an error. */
  async register(req, b) {
    if (b?.age !== true) return { error: 'Confirm that you are 13 or older to play together.', code: 'age', status: 400 };
    const name = String(b.username ?? '').trim().toLowerCase();
    if (!NAME_RE.test(name)) return { error: 'Your name: 2 to 20 characters, letters, digits, - or _.', code: 'nameFormat', status: 400 };
    const email = String(b.email ?? '').trim().toLowerCase();
    if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return { error: 'That email address doesn\'t look right.', code: 'emailFormat', status: 400 };
    const password = typeof b.password === 'string' ? b.password : '';
    const weak = this.passwordProblem(password, name);
    if (weak) return weak;
    const now = Date.now();
    const ip = bucketOf(clientIp(req));
    if (this.signups.count(ip, now) >= SIGNUPS_ADDRESS || this.signups.count('all', now) >= SIGNUPS_ALL) {
      return { error: 'Too many new accounts lately. Try again in an hour.', code: 'signupsTooMany', status: 429 };
    }
    const taken = { error: 'That name is taken. Pick another name.', code: 'nameTaken', status: 409 };
    if (name === ADMIN_NAME) return taken;
    if ((this.auth.blocked.get(name) || 0) > now) return { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    // A guest playing or holding the name today keeps it (their session ends within 12 hours).
    if (this.online(name) || this.auth.nameHeld(name, now)) {
      return { error: `Someone is playing as ${name} right now. Pick another name.`, code: 'nameOnline', args: { name }, status: 409 };
    }
    this.auth.claiming.add(name); // no guest takes it while this runs (server/auth.mjs join)
    try {
      if (await this.store.getAccount(name)) return taken;
      this.signups.add(ip, now);
      this.signups.add('all', now);
      const hashed = await this.hashing(() => hashPassword(password));
      if (!hashed) return { error: 'The server is busy. Try again in a moment.', code: 'busy', status: 503 };
      if (!(await this.store.createAccount({ username: name, email, pass: hashed.value }))) return taken; // two sign-ups at once: the store decides
      this.auth.log('account_created', req, { username: name });
      const token = await this.session(req, name);
      if (!token) return { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
      this.seen(name, true);
      return { token, username: name, role: 'player', device: this.auth.newDevice(deviceFor(name)) };
    } finally {
      this.auth.claiming.delete(name);
    }
  }

  /** Log in with a name and password. The same answer for a wrong password and an unknown name. */
  async login(req, b) {
    const name = String(b?.username ?? '').trim().toLowerCase();
    const password = typeof b?.password === 'string' ? b.password : '';
    const wrong = { error: 'Wrong name or password.', code: 'wrongLogin', status: 401 };
    if (!NAME_RE.test(name) || !password || password.length > PASS_MAX) return wrong;
    const ip = bucketOf(clientIp(req));
    const now = Date.now();
    if (this.byAddress.count(ip, now) >= LOGIN_FAILS_ADDRESS) return { error: 'Too many attempts. Try again in 15 minutes.', code: 'tooMany', status: 429 };
    const own = this.auth.knownDevice(req, deviceFor(name), this.auth.names.acct);
    if (!own && this.byAccount.count(name, now) >= LOGIN_FAILS_ACCOUNT) {
      return { error: 'Too many wrong passwords for this name. Try again in 15 minutes.', code: 'tooManyName', status: 429 };
    }
    // Counted before the check, so a burst can't slip past; taken back when it doesn't count.
    this.byAddress.add(ip, now);
    if (!own) this.byAccount.add(name, now);
    const undo = () => {
      this.byAddress.undo(ip, now);
      if (!own) this.byAccount.undo(name, now);
    };
    const row = await this.store.getAccount(name);
    const checked = await this.hashing(() => verifyHash(password, row?.pass ?? this.dummy));
    if (!checked) {
      undo();
      return { error: 'The server is busy. Try again in a moment.', code: 'busy', status: 503 };
    }
    if (!row || !checked.value) {
      this.auth.log('account_login_failed', req, { username: name });
      return wrong;
    }
    undo();
    if (row.disabled) return { error: 'The admin has turned this account off.', code: 'accountOff', status: 403 };
    if ((this.auth.blocked.get(name) || 0) > now) return { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    const token = await this.session(req, name);
    if (!token) return { error: 'You were removed by the admin. Try again later.', code: 'removed', status: 403 };
    this.auth.log('account_login', req, { username: name });
    this.seen(name, true);
    return { token, username: name, role: 'player', device: this.auth.newDevice(deviceFor(name)) };
  }

  /** The player's own account: name, email, when it was made. */
  async mine(session) {
    const row = session?.role === 'player' ? await this.store.getAccount(session.username) : null;
    return row ? { username: row.username, email: row.email, created: new Date(row.created).toISOString().slice(0, 10) } : null;
  }

  /** Check the player's current password (`b.password`): null when right, else the refusal. */
  async confirm(req, session, password) {
    const row = await this.store.getAccount(session.username);
    if (!row) return { error: 'Not logged in', code: 'notLoggedIn', status: 401 };
    const ip = bucketOf(clientIp(req));
    const now = Date.now();
    if (this.byAddress.count(ip, now) >= LOGIN_FAILS_ADDRESS) return { error: 'Too many attempts. Try again in 15 minutes.', code: 'tooMany', status: 429 };
    this.byAddress.add(ip, now);
    const checked = await this.hashing(() => verifyHash(typeof password === 'string' ? password.slice(0, PASS_MAX + 1) : '', row.pass));
    if (!checked) {
      this.byAddress.undo(ip, now);
      return { error: 'The server is busy. Try again in a moment.', code: 'busy', status: 503 };
    }
    if (!checked.value) {
      this.auth.log('account_password_wrong', req, { username: session.username });
      return { error: 'Your current password is wrong.', code: 'wrongPassword2', status: 401 };
    }
    this.byAddress.undo(ip, now);
    return null;
  }

  /** A new password (`b.old`, `b.password`): every other session ends; the answer has a fresh `token`. */
  async changePassword(req, session, b) {
    const name = session.username;
    const password = typeof b?.password === 'string' ? b.password : '';
    const weak = this.passwordProblem(password, name);
    if (weak) return weak;
    const refused = await this.confirm(req, session, b?.old);
    if (refused) return refused;
    const hashed = await this.hashing(() => hashPassword(password));
    if (!hashed) return { error: 'The server is busy. Try again in a moment.', code: 'busy', status: 503 };
    await this.store.updateAccount(name, { pass: hashed.value });
    await this.auth.endSessionsOf(name);
    this.auth.log('account_password', req, { username: name });
    const token = await this.session(req, name);
    return token ? { ok: true, token } : { error: 'Not logged in', code: 'notLoggedIn', status: 401 };
  }

  /** The player deletes their own account (`b.password`): their email, password, scores and sessions go. */
  async deleteMine(req, session, b) {
    const refused = await this.confirm(req, session, b?.password);
    if (refused) return refused;
    await this.store.deleteAccount(session.username);
    await this.auth.endSessionsOf(session.username);
    this.auth.log('account_deleted', req, { username: session.username, detail: 'by the player' });
    return { ok: true };
  }

  /** A player used their account: their "last seen" day for KEEP_DAYS, written at most once a day. */
  seen(name, force = false) {
    const day = new Date().toISOString().slice(0, 10);
    if (!force && this.seenToday.get(name) === day) return;
    this.seenToday.set(name, day);
    if (this.seenToday.size > 5000) this.seenToday.delete(this.seenToday.keys().next().value);
    this.store.updateAccount(name, { seen: true }).catch((e) => console.error('account seen failed', String(e)));
  }

  // ---- The admin (brieltje.be/admin)

  async list() {
    return (await this.store.listAccounts()).map((r) => ({
      username: r.username, email: r.email, disabled: !!r.disabled,
      created: new Date(r.created).toISOString().slice(0, 10), seen: new Date(r.seen).toISOString().slice(0, 10),
      online: this.online(r.username),
    }));
  }

  /** The admin's `op` on account `name`: 'reset' (a new password, in the answer once), 'off', 'on' or 'delete'. */
  async admin(req, by, op, name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { error: 'No such account', code: 'noAccount', status: 404 };
    const row = await this.store.getAccount(name);
    if (!row) return { error: 'No such account', code: 'noAccount', status: 404 };
    if (op === 'reset') {
      // 12 characters from an alphabet without look-alikes (no 0/o, 1/l/i): about 60 bits.
      const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
      const password = [...randomBytes(12)].map((x) => abc[x % abc.length]).join('');
      const hashed = await this.hashing(() => hashPassword(password));
      if (!hashed) return { error: 'The server is busy. Try again in a moment.', code: 'busy', status: 503 };
      await this.store.updateAccount(name, { pass: hashed.value });
      await this.auth.endSessionsOf(name);
      this.auth.log('account_reset', req, { username: by, detail: name });
      return { ok: true, password };
    }
    if (op === 'off' || op === 'on') {
      await this.store.updateAccount(name, { disabled: op === 'off' });
      if (op === 'off') await this.auth.endSessionsOf(name);
      this.auth.log(op === 'off' ? 'account_off' : 'account_on', req, { username: by, detail: name });
      return { ok: true };
    }
    if (op === 'delete') {
      await this.store.deleteAccount(name);
      await this.auth.endSessionsOf(name);
      this.auth.log('account_deleted', req, { username: by, detail: `${name}, by the admin` });
      return { ok: true };
    }
    return { error: 'Unknown action', code: 'badOp', status: 400 };
  }
}
