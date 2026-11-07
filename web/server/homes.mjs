// The three homes that open only with a code (Yoshi, 6 Nov 2026; shared/homes.mjs): the main house, the bungalow and the
// end house at Molenhoek. A home's code is made here (admin page's Homes tab), shown once and kept only as a scrypt hash.
// A right code makes a grant for the session that typed it, 8 hours; the game server lets only a session with a grant (or
// the admin) open the home's doors, break its panes and stand inside it (server/homeGate.mjs).
//
// Public:  POST /api/home/unlock {id, code} -> {ok: true, inside} (with a session: that session now has the grant; `inside`
//          is the home's inside pack, see shared/insideData.mjs, when the private data holds it), or 403 {code:'home_denied'},
//          429 {code:'home_slow'}. Without a session (playing alone) it only answers, with the pack: the page installs it.
//          GET /api/home/:id/inside -> the pack again, for a session that has the grant (a page that rejoined) and for the
//          admin; anyone else gets the wrong code's 403. Never cached (no-store, private): the pack is what the repository
//          no longer holds.
// Admin:   GET /api/admin/homes (the list), POST /api/admin/homes/:id/code (a new code, shown once),
//          DELETE /api/admin/homes/:id/code (revoke), POST /api/admin/homes/:id {enabled, expiresAt} (settings).
//          The admin needs no code: POST /api/home/unlock {id} as the admin answers {ok: true}.
//
// Guarded against:
// - guessing: codes are 10 characters of a 32 letter alphabet (50 bits); attempts are limited per sender (30 an hour in
//   all, 8 per home in ten minutes) before any hashing, and each hash costs scrypt. 50 bits make guessing hopeless at
//   these rates.
// - a flood slowing the site: every try is a scrypt (16 MB, tens of ms) on Node's four worker threads. At most
//   UNLOCK_TURNS run at once and UNLOCK_QUEUE wait (server/auth.mjs Turns, as the account passwords have their own);
//   more hear "busy" (503). In all, at most UNLOCK_ALL tries an hour reach a hash, from everyone together. That cap can
//   keep an owner out for the rest of that hour during a flood from many addresses (Yoshi chose it, 7 Nov 2026); the
//   admin is never kept out. Wrong tries are counted in memory and written to the store at most once in FLUSH_MS, so
//   a flood is no stream of writes either.
// - telling homes apart: unknown, switched off, expired or without a code: the same 403 and the same work (a scrypt
//   against a dummy hash), so neither the answer nor the time says which ids exist.
// - cross-site posts: same-origin JSON bodies only (server.mjs).
// - leaks in logs and files: the code never reaches a log or the store (a hash does); the store keeps counters only,
//   no address and no name.
import { randomInt } from 'node:crypto';
import { Attempts, hashPassword, Turns, verifyHash } from './auth.mjs';
import { Window } from './feedback.mjs';
import { findHome } from '../shared/homes.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CODE_LENGTH = 10;
const META = 'homes';
const UNLOCK_TURNS = 2; // code checks at once
const UNLOCK_QUEUE = 8; // and waiting
const UNLOCK_ALL = 300; // code checks in an hour, everyone together
const FLUSH_MS = 60_000; // wrong tries reach the store at most this often
const BUSY = { error: 'The server is busy. Try again in a moment.', code: 'busy' };
const SLOW = { error: 'Too many tries, wait a while', code: 'home_slow' };
const GRANT_MS = 8 * 3600_000; // how long a typed code lets a player in without typing it again
/** The pack is private data: no cache keeps it. (BREACH needs a secret reflected next to attacker text; nothing of the request is in the answer.) */
const NO_CACHE = { 'Cache-Control': 'no-store, private, no-transform' };
const BLANK = { enabled: false, hash: null, setAt: null, expiresAt: null, unlocks: 0, fails: 0, lastUnlockAt: null, lastFailAt: null };

/** A code as typed: capitals and digits only (dashes and spaces are ignored), at most 16. */
export const normalizeCode = (v) => (typeof v === 'string' ? v : '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
/** A new code (10 characters). */
export function newCode() {
  let c = '';
  for (let i = 0; i < CODE_LENGTH; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}
/** How a code is shown: XXXXX-XXXXX. */
export const showCode = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;

export class Homes {
  /** `list`: the registry (shared/homes.mjs); `json`; `readJson`; `clientKey`. */
  constructor(store, { list, json, readJson, clientKey, pack = () => null, flushMs = FLUSH_MS }) {
    Object.assign(this, { store, list, json, readJson, clientKey, pack, flushMs });
    this.onGrant = null; // (key, id) => void: the game server tells that page the state of the inside (Game.homeGranted)
    this.perSender = new Window(10 * 60_000); // attempts at one home from one sender
    this.perSenderAll = new Window(3600_000); // all homes from one sender
    this.checks = new Attempts(3600_000); // code checks that reached a hash, everyone together ('all')
    this.turns = new Turns(UNLOCK_TURNS, UNLOCK_QUEUE);
    this.fails = new Map(); // home id -> { n, at }: wrong tries not in the store yet (see flush)
    this.flushTimer = null;
    this.flushedAt = 0;
    this.grants = new Map(); // `${session key}|${id}` -> until (ms): the code was typed in this session (the game server asks, see granted)
    this.state = null;
    this.chain = Promise.resolve();
    this.dummy = null;
  }

  async load() {
    if (!this.state) {
      try {
        this.state = JSON.parse((await this.store.getMeta(META)) || '{}');
      } catch {
        this.state = {};
      }
    }
    return this.state;
  }

  /** Change one home's record (writes are queued so two requests can't overwrite each other). */
  update(id, fn) {
    const run = async () => {
      const s = await this.load();
      s[id] = fn(s[id] ?? { ...BLANK });
      await this.store.setMeta(META, JSON.stringify(s));
      return s[id];
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  /** A wrong try at home `id`: counted here, in the store within flushMs (one write for however many came). */
  noteFail(id) {
    const f = this.fails.get(id) ?? { n: 0, at: null };
    f.n++;
    f.at = new Date().toISOString();
    this.fails.set(id, f);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush().catch((e) => console.error('home counters not written', String(e))), Math.max(0, this.flushedAt + this.flushMs - Date.now()));
    this.flushTimer.unref?.();
  }

  /** The wrong tries counted since the last write, into the store. */
  async flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushedAt = Date.now();
    const pending = [...this.fails];
    this.fails.clear();
    for (const [id, f] of pending) await this.update(id, (h) => ({ ...h, fails: (h.fails ?? 0) + f.n, lastFailAt: f.at }));
  }

  /** Was this home's code typed in this session (its key) lately? The game server lets only such a player in (server/homeGate.mjs). A session that ends, or a name taken over later, has another key. */
  granted(key, id) {
    if (!key || (this.grants.get(`${key}|${id}`) ?? 0) <= Date.now()) return false;
    const h = this.state?.[id]; // a code that is revoked, replaced, switched off or past its end takes the grants with it (see forget)
    return !!(h?.enabled && h.hash && (!h.expiresAt || Date.now() <= Date.parse(`${h.expiresAt}T23:59:59Z`)));
  }

  /** The home's grants end (its code or settings changed). */
  forget(id) {
    for (const k of this.grants.keys()) if (k.endsWith(`|${id}`)) this.grants.delete(k);
  }

  grant(key, id) {
    if (!key) return; // no session: a solo page, nothing on the server to let in
    const now = Date.now();
    if (this.grants.size > 500) for (const [k, until] of this.grants) if (until <= now) this.grants.delete(k);
    this.grants.set(`${key}|${id}`, now + GRANT_MS);
    this.onGrant?.(key, id);
  }

  /** Answers the paths it knows (true), or leaves them (false). `admin`: the request's session is the admin's; `user`: its key. */
  async handle(req, res, url, admin, user = '') {
    const p = url.pathname;
    if (p === '/api/home/unlock' && req.method === 'POST') return (await this.unlock(req, res, admin, user), true);
    const inside = /^\/api\/home\/([a-z][a-z0-9_]{1,20})\/inside$/.exec(p);
    if (inside && req.method === 'GET') return (await this.inside(res, admin, user, inside[1]), true);
    if (!p.startsWith('/api/admin/homes')) return false;
    if (!admin) return (await this.json(res, 403, { error: 'Admin only' }), true);
    if (p === '/api/admin/homes' && req.method === 'GET') return (await this.json(res, 200, await this.overview()), true);
    const r = /^\/api\/admin\/homes\/([a-z0-9_]{1,20})(\/code)?$/.exec(p);
    const home = r && findHome(r[1], this.list);
    if (!home) return (await this.json(res, 404, { error: 'Not found' }), true);
    if (r[2] && (req.method === 'POST' || req.method === 'DELETE')) await this.readJson(req); // the same-origin check (server.mjs body): no cross-site posts, even with no body
    if (r[2] && req.method === 'POST') {
      const code = newCode();
      const hash = await hashPassword(code);
      this.fails.delete(home.id); // a new code starts its count afresh
      await this.update(home.id, (h) => ({ ...h, hash, enabled: true, setAt: new Date().toISOString(), fails: 0 }));
      this.forget(home.id);
      console.log(JSON.stringify({ event: 'home_code', id: home.id }));
      return (await this.json(res, 200, { code: showCode(code) }), true);
    }
    if (r[2] && req.method === 'DELETE') {
      await this.update(home.id, (h) => ({ ...h, hash: null, setAt: null }));
      this.forget(home.id);
      console.log(JSON.stringify({ event: 'home_revoked', id: home.id }));
      return (await this.json(res, 200, { ok: true }), true);
    }
    if (!r[2] && req.method === 'POST') {
      const b = await this.readJson(req);
      const patch = {};
      if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
      if (b.expiresAt === null) patch.expiresAt = null;
      else if (typeof b.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt) && Number.isFinite(Date.parse(`${b.expiresAt}T23:59:59Z`))) patch.expiresAt = b.expiresAt;
      else if (b.expiresAt !== undefined) return (await this.json(res, 400, { error: 'Bad date' }), true);
      await this.update(home.id, (h) => ({ ...h, ...patch }));
      this.forget(home.id);
      return (await this.json(res, 200, { ok: true }), true);
    }
    return (await this.json(res, 405, { error: 'Not allowed' }), true);
  }

  async overview() {
    const s = await this.load();
    const rows = [];
    for (const h of this.list) {
      const x = s[h.id] ?? {};
      const f = this.fails.get(h.id); // wrong tries not written yet
      rows.push({
        id: h.id, enabled: !!x.enabled, hasCode: !!x.hash, setAt: x.setAt ?? null, expiresAt: x.expiresAt ?? null,
        unlocks: x.unlocks ?? 0, fails: (x.fails ?? 0) + (f?.n ?? 0), lastUnlockAt: x.lastUnlockAt ?? null, lastFailAt: f?.at ?? x.lastFailAt ?? null,
      });
    }
    return { rows };
  }

  async unlock(req, res, admin, user) {
    const b = await this.readJson(req);
    const sender = this.clientKey(req);
    const id = typeof b.id === 'string' ? b.id.slice(0, 20) : '';
    // Every attempt counts, before any hashing; a refusal says only that it was slow.
    if (!this.perSenderAll.hit(sender, 30) || !this.perSender.hit(`${sender}|${id}`, 8)) return this.json(res, 429, SLOW);
    const home = findHome(id, this.list);
    const rec = home ? (await this.load())[home.id] : null;
    const live = !!(rec?.enabled && rec.hash && (!rec.expiresAt || Date.now() <= Date.parse(`${rec.expiresAt}T23:59:59Z`)));
    const look = !!(admin && home && b.code === undefined); // the admin needs no code
    let ok = look;
    if (!look) {
      // Everyone together: at most UNLOCK_ALL checks an hour, then a few at a time (a refusal for "busy" is not counted).
      const now = Date.now();
      if (this.checks.count('all', now) >= UNLOCK_ALL) {
        if (now - (this.cappedAt ?? 0) > 3600_000) {
          this.cappedAt = now;
          console.log(JSON.stringify({ event: 'home_unlock_capped', max: UNLOCK_ALL })); // at most once an hour, no address
        }
        return this.json(res, 429, SLOW);
      }
      this.checks.add('all', now);
      const checked = await this.turns.run(async () => {
        this.dummy ??= await hashPassword('no such home');
        return verifyHash(normalizeCode(b.code), live ? rec.hash : this.dummy);
      });
      if (!checked) {
        this.checks.undo('all', now);
        return this.json(res, 503, BUSY);
      }
      ok = live && checked.value;
    }
    if (!ok) {
      if (home) this.noteFail(home.id);
      return this.json(res, 403, { error: 'Wrong code', code: 'home_denied' });
    }
    if (!look) await this.update(home.id, (h) => ({ ...h, unlocks: (h.unlocks ?? 0) + 1, lastUnlockAt: new Date().toISOString() }));
    this.grant(user, home.id);
    console.log(JSON.stringify({ event: 'home_unlock', id: home.id }));
    const inside = this.pack(home.id);
    return this.json(res, 200, { ok: true, ...(inside ? { inside } : {}) }, NO_CACHE);
  }

  /** The home's inside pack for a session that has the grant (or the admin). Anything else gets the wrong code's answer. */
  async inside(res, admin, user, id) {
    const home = findHome(id, this.list);
    if (!home || !(admin || this.granted(user, home.id))) return this.json(res, 403, { error: 'Wrong code', code: 'home_denied' }, NO_CACHE);
    const pack = this.pack(home.id);
    if (!pack) return this.json(res, 404, { error: 'Not found' }, NO_CACHE);
    return this.json(res, 200, pack, NO_CACHE);
  }
}
