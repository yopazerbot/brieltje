// Logging in on a console with your phone (Yoshi, 7 Nov 2026: "sign in by scanning a QR code for console
// players so they don't have to type"), as a TV logs in to a streaming service:
//
// 1. The console asks for a pairing (start): it gets a long random secret it keeps (`token`) and a short
//    code it shows, as text and as a QR code of brieltje.be/pair/#CODE.
// 2. The phone opens that page, is logged in to its account there (or logs in), and says yes (approve).
// 3. The console, asking every two seconds (poll) with its secret, gets a session of its own for that
//    account: a new one, as after logging in. The pairing is gone then.
//
// Attack classes and why it holds:
// - Guessing a code: 8 characters from 31 (about 8.5 * 10^11), valid 5 minutes, and wrong codes are limited
//   per address and per session (WRONG). Only a logged-in account can try one at all.
// - Someone who sees the code (over a shoulder, a photo of the TV): the code alone gives nothing; only the
//   console's secret collects the session, and it never leaves that console.
// - Phishing with a code (sending someone a link with your own console's code): the console also shows a
//   2-digit check number that is in no link or QR code, and the phone must type it before its yes counts
//   (number matching). One wrong number ends that pairing. The phone's page also says what it does, with the
//   name it logs in as, and to say yes only if that screen is in front of you.
// - A flood of pairings: STARTS per address, at most LIVE at once, each gone after 5 minutes.
// - Revocation: the account's revocation count is noted when the phone says yes; a new password, the admin
//   turning it off or a kick in between, and the console gets nothing (server/accounts.mjs session).
// - CSRF: every call is a same-origin JSON POST (server.mjs body), the cookies SameSite=Strict.

import { createHash, randomBytes } from 'node:crypto';
import { Attempts, bucketOf, clientIp, SESSION_MS } from './auth.mjs';
import { svgPath } from './qr.mjs';

const TTL_MS = 5 * 60_000;
const STARTS = 20; // pairings per address in 15 minutes
const WRONG = 10; // wrong codes per address, and per session, in 15 minutes
const LIVE = 2000; // pairings at once, everyone together
const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)
const keyOf = (token) => createHash('sha256').update(String(token)).digest('base64url');
/** A code as typed or scanned: capitals, without the dash or spaces. */
export const normalCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

export class Pairing {
  constructor(auth, accounts) {
    this.auth = auth;
    this.accounts = accounts;
    this.byKey = new Map(); // hash of the console's secret -> pairing
    this.byCode = new Map(); // code -> pairing
    this.starts = new Attempts(15 * 60_000);
    this.wrong = new Attempts(15 * 60_000);
    setInterval(() => this.sweep(), 30_000).unref();
  }

  sweep(now = Date.now()) {
    for (const [k, p] of this.byKey) {
      if (p.until > now) continue;
      this.byKey.delete(k);
      this.byCode.delete(p.code);
    }
    this.starts.cleanup(now);
    this.wrong.cleanup(now);
  }

  /** The console asks for a pairing. `origin`: this site's address, for the link in the QR code. */
  start(req, origin) {
    const now = Date.now();
    const ip = bucketOf(clientIp(req));
    if (this.starts.count(ip, now) >= STARTS) return { error: 'Too many tries. Try again in 15 minutes.', code: 'tooMany', status: 429 };
    this.sweep(now);
    if (this.byKey.size >= LIVE) return { error: 'The server is busy. Try again in a moment.', code: 'busy', status: 503 };
    this.starts.add(ip, now);
    let code;
    do code = [...randomBytes(8)].map((x) => ABC[x % ABC.length]).join('');
    while (this.byCode.has(code));
    const token = randomBytes(32).toString('base64url');
    const p = { code, check: String(10 + (randomBytes(1)[0] % 90)), until: now + TTL_MS, name: null, epoch: 0 };
    this.byKey.set(keyOf(token), p);
    this.byCode.set(code, p);
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
    const url = `${origin}/pair/#${shown}`;
    return { token, code: shown, check: p.check, url, qr: svgPath(url), ms: TTL_MS };
  }

  /** A code from the phone: checked, wrong ones counted. The pairing, or a refusal. */
  find(req, session, code) {
    const now = Date.now();
    const ip = bucketOf(clientIp(req));
    if (this.wrong.count(ip, now) >= WRONG || this.wrong.count(session.key, now) >= WRONG) {
      return { error: 'Too many wrong codes. Try again in 15 minutes.', code: 'tooMany', status: 429 };
    }
    const p = this.byCode.get(normalCode(code));
    if (!p || p.until < now || p.name) {
      this.wrong.add(ip, now);
      this.wrong.add(session.key, now);
      this.auth.log('pair_wrong', req, { username: session.username });
      return { error: 'That code is not valid (any more). Make a new one on the other screen.', code: 'pairCode', status: 404 };
    }
    return { p };
  }

  /** The phone, logged in to an account, says yes: the console may collect a session for it. */
  approve(req, session, code, check) {
    // An account, or the game's admin (Yoshi, 8 Nov 2026: the phone login didn't work with the admin's name). The admin's
    // console gets a game session of SESSION_MS only, never the /admin panel's (that one needs its own login there).
    if (session?.role !== 'player' && session?.role !== 'admin') return { error: 'Log in with your account first.', code: 'pairAccount', status: 403 };
    const r = this.find(req, session, code);
    if (r.error) return r;
    // The number only the console shows: a wrong one ends this pairing (a link alone never logs a screen in).
    if (String(check ?? '').trim() !== r.p.check) {
      this.byCode.delete(r.p.code);
      r.p.until = 0;
      this.auth.log('pair_check_wrong', req, { username: session.username });
      return { error: "That number isn't the one on the other screen. Make a new code there.", code: 'pairCheck', status: 403 };
    }
    r.p.name = session.username;
    r.p.role = session.role;
    r.p.epoch = this.auth.epoch.get(session.username) || 0;
    this.auth.log('pair_approved', req, { username: session.username });
    return { ok: true, username: session.username };
  }

  /** The console asks how it goes: waiting, gone (expired), or done with a session (`token`) for the account. */
  async poll(req, token) {
    const k = keyOf(token);
    const p = typeof token === 'string' && token.length >= 40 ? this.byKey.get(k) : null;
    if (!p || p.until < Date.now()) return { state: 'gone' };
    if (!p.name) return { state: 'waiting' };
    this.byKey.delete(k); // once
    this.byCode.delete(p.code);
    if (p.role === 'admin') {
      // The admin: a game session as the game's own admin login gives (12 hours), checked against a revocation since.
      if ((this.auth.epoch.get(p.name) || 0) !== p.epoch) return { state: 'gone' };
      const { token, key } = await this.auth.startSession(p.name, 'admin', SESSION_MS, { ip: bucketOf(clientIp(req)) });
      if ((this.auth.epoch.get(p.name) || 0) !== p.epoch) {
        this.auth.sessions.delete(key);
        await this.auth.store.deleteSession(key);
        return { state: 'gone' };
      }
      this.auth.log('pair_login', req, { username: p.name, detail: 'admin' });
      return { state: 'done', token, username: p.name, role: 'admin' };
    }
    const session = await this.accounts.session(req, p.name, p.epoch);
    if (!session) return { state: 'gone' };
    this.auth.log('pair_login', req, { username: p.name });
    this.accounts.seen(p.name);
    return { state: 'done', token: session, username: p.name, role: 'player' };
  }
}
