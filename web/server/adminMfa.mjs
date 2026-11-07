// Two-step login for the admin (Yoshi, 7 Nov 2026: "make TOTP MFA possible to set for the admin account"):
// the admin password, then a 6-digit code from an authenticator app (RFC 6238: HMAC-SHA1, 30-second steps,
// the usual for Google Authenticator, Microsoft Authenticator, 1Password and the others).
//
// - Turning it on (brieltje.be/admin, Security): the server makes a random 160-bit secret and shows it as a
//   QR code (server/qr.mjs), a link that opens the app on the same phone, and the key to type. It counts
//   only once a code from the app is typed back. Then 8 recovery codes are shown, once.
// - The secret is kept encrypted (AES-256-GCM) with a key made from ADMIN_PASSWORD by scrypt (16 MB, a random
//   salt kept with it), and ADMIN_PASSWORD lives in Railway's variables, never in the database: the database
//   alone gives nothing to make codes with, and guessing the password from it is as slow as from its hash.
// - A code is taken in its own 30 seconds and one step either side (a phone's clock may be a little off),
//   and never twice: a step once used is refused, so a code someone saw can't be replayed.
// - Wrong codes count like wrong admin passwords (server/auth.mjs): per address and in all.
// - A recovery code (10 characters, about 50 bits) works once instead of a code. Kept only as an HMAC with the
//   key above: without ADMIN_PASSWORD the stored ones can't even be tried.
// - Lost the phone and the recovery codes: change ADMIN_PASSWORD in Railway. At the next start the server
//   sees the new password (its fingerprint, server/auth.mjs) and turns two-step login off, and says so in the
//   log. Whoever can change Railway's variables owns the server anyway.
// - Turning it on ends every other admin session (they never typed a code). Turning it off, or new recovery
//   codes, needs a code.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { svgPath } from './qr.mjs';

const STEP_S = 30;
const DIGITS = 6;
const WINDOW = 1; // steps either side
const RECOVERY = 8;
const PENDING_MS = 10 * 60_000; // a secret shown for setting up is good this long
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ABC = 'abcdefghjkmnpqrstuvwxyz23456789'; // recovery codes: no look-alikes

export function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The code for `secret` (bytes) at 30-second step `step`. */
export function totp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The step `code` belongs to near `now`, or null. Compared without early exit. */
export function stepOf(secret, code, now = Date.now()) {
  const c = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const at = Math.floor(now / 1000 / STEP_S);
  let found = null;
  for (let s = at - WINDOW; s <= at + WINDOW; s++) {
    if (timingSafeEqual(Buffer.from(totp(secret, s)), Buffer.from(c)) && found === null) found = s;
  }
  return found;
}

const scryptAsync = promisify(scrypt);
const normal = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export class AdminMfa {
  /** `auth`: server/auth.mjs (the store, sessions, the log). `password`: ADMIN_PASSWORD, for the key. */
  constructor(auth, password) {
    this.auth = auth;
    this.store = auth.store;
    this.password = password || '';
    this.key = null; // made from the password at start (load), with its salt
    this.state = null; // { secret: Buffer, step, recovery: [hash] } when on
    this.pending = new Map(); // session key -> { secret, until }: being set up
  }

  /** Start-up: on or off, from the store. `passwordChanged`: ADMIN_PASSWORD is new, so two-step login goes off. */
  async load(passwordChanged) {
    if (this.password) {
      let salt = await this.store.getMeta('admin_mfa_salt');
      if (!salt) await this.store.setMeta('admin_mfa_salt', (salt = randomBytes(16).toString('base64')));
      this.key = Buffer.from(await scryptAsync(this.password, Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 }));
    }
    const raw = await this.store.getMeta('admin_mfa');
    if (!raw) return;
    // No ADMIN_PASSWORD at all: there is no admin to log in, and it stays as it is for when the password is back.
    if (!this.password) return;
    if (passwordChanged) {
      await this.store.setMeta('admin_mfa', '');
      this.auth.log('mfa_reset', null, { detail: 'ADMIN_PASSWORD changed: two-step login is off' });
      return;
    }
    try {
      const s = JSON.parse(raw);
      const box = Buffer.from(s.box, 'base64');
      const d = createDecipheriv('aes-256-gcm', this.key, box.subarray(0, 12));
      d.setAuthTag(box.subarray(12, 28));
      const secret = Buffer.concat([d.update(box.subarray(28)), d.final()]);
      this.state = { secret, step: Number(s.step) || 0, recovery: Array.isArray(s.recovery) ? s.recovery.filter((h) => typeof h === 'string') : [] };
    } catch {
      // Unreadable: kept as it is, and the admin can't log in without it. Never quietly off.
      this.state = { secret: null, step: 0, recovery: [] };
      console.error(JSON.stringify({ event: 'mfa_unreadable' }));
    }
  }

  get on() {
    return !!this.state;
  }

  async save() {
    if (!this.state) return this.store.setMeta('admin_mfa', '');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(this.state.secret), c.final()]);
    const box = Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    await this.store.setMeta('admin_mfa', JSON.stringify({ box, step: this.state.step, recovery: this.state.recovery }));
  }

  /**
   * A code (or a recovery code) for the admin: true when right, and then used up. A code's step is
   * remembered, so the same code (or an older one) is never taken again.
   */
  async check(code, now = Date.now()) {
    const s = this.state;
    if (!s?.secret) return false;
    const step = stepOf(s.secret, code, now);
    if (step !== null) {
      if (step <= s.step) return false; // used already
      s.step = step;
      await this.save();
      return true;
    }
    const h = this.mac(normal(code));
    const i = normal(code).length === 10 ? s.recovery.indexOf(h) : -1;
    if (i < 0) return false;
    s.recovery.splice(i, 1);
    await this.save();
    this.auth.log('mfa_recovery_used', null, { detail: `${s.recovery.length} recovery codes left` });
    return true;
  }

  /** A recovery code as kept: an HMAC with the key (normalised: lower case, no dash). */
  mac(code) {
    return createHmac('sha256', this.key).update(code).digest('base64url');
  }

  recoveryCodes() {
    // Evenly from the alphabet: bytes past the last whole round of it are drawn again.
    const pick = () => {
      for (;;) {
        const x = randomBytes(1)[0];
        if (x < 256 - (256 % ABC.length)) return ABC[x % ABC.length];
      }
    };
    const codes = Array.from({ length: RECOVERY }, () => Array.from({ length: 10 }, pick).join(''));
    return { codes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`), hashes: codes.map((c) => this.mac(c)) };
  }

  /** What the admin page shows. */
  view() {
    return { on: this.on, recoveryLeft: this.state?.recovery.length ?? 0 };
  }

  /** Setting up, step 1: a new secret for this admin session, as a QR code, a link and the key to type. */
  start(sessionKey, name) {
    if (!this.key) return { error: 'No admin password is set.', code: 'adminOnly', status: 403 };
    // On already: a new phone only after turning it off, which needs a code. A session alone never swaps the secret.
    if (this.on) return { error: 'Two-step login is on. Turn it off first, with a code.', code: 'mfaOn', status: 409 };
    const secret = randomBytes(20);
    this.pending.set(sessionKey, { secret, until: Date.now() + PENDING_MS });
    for (const [k, p] of this.pending) if (p.until < Date.now()) this.pending.delete(k);
    const key = base32(secret);
    const label = encodeURIComponent(`Brieltje:${name}`);
    const uri = `otpauth://totp/${label}?secret=${key}&issuer=Brieltje&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
    return { key: key.match(/.{1,4}/g).join(' '), uri, qr: svgPath(uri) };
  }

  /** Setting up, step 2: the first code from the app. On from now on; every other admin session ends. */
  async confirm(sessionKey, code) {
    if (this.on) return { error: 'Two-step login is on. Turn it off first, with a code.', code: 'mfaOn', status: 409 };
    const p = this.pending.get(sessionKey);
    if (!p || p.until < Date.now()) return { error: 'Start again: the setup took too long.', code: 'mfaExpired', status: 400 };
    const step = stepOf(p.secret, code);
    if (step === null) return { error: 'That code is not right. Type the 6 digits the app shows now.', code: 'wrongCode', status: 401 };
    this.pending.delete(sessionKey);
    const { codes, hashes } = this.recoveryCodes();
    this.state = { secret: p.secret, step, recovery: hashes };
    await this.save();
    const me = this.auth.sessions.get(sessionKey)?.username;
    for (const [k, s] of [...this.auth.sessions]) {
      if (s.role === 'admin' && k !== sessionKey) {
        if (s.username !== me) this.auth.revoke(s.username); // a login under that name still in progress gets nothing either
        this.auth.sessions.delete(k);
        await this.store.deleteSession(k);
      }
    }
    this.auth.log('mfa_on', null, { username: this.auth.sessions.get(sessionKey)?.username });
    return { ok: true, recovery: codes };
  }

  /** Off, or new recovery codes: each needs a code (or a recovery code). */
  async change(op, code, by) {
    if (!this.on) return { error: 'Two-step login is off.', code: 'mfaOff', status: 400 };
    if (!(await this.check(code))) return { error: 'That code is not right. Type the 6 digits the app shows now.', code: 'wrongCode', status: 401 };
    if (op === 'off') {
      this.state = null;
      await this.save();
      this.auth.log('mfa_off', null, { username: by });
      return { ok: true };
    }
    const { codes, hashes } = this.recoveryCodes();
    this.state.recovery = hashes;
    await this.save();
    this.auth.log('mfa_codes', null, { username: by });
    return { ok: true, recovery: codes };
  }
}
