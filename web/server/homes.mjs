// The three homes that open only with a code (Yoshi, 6 Nov 2026; shared/homes.mjs): the main house, the bungalow and the
// end house at Molenhoek. A home's code is made here (admin page's Homes tab), shown once and kept only as a scrypt hash.
// A right code makes a grant for the session that typed it, 8 hours; the game server lets only a session with a grant (or
// the admin) open the home's doors, break its panes and stand inside it (server/homeGate.mjs).
// Typed while logged in to an account (role 'player'), it also gives that account lasting access (Yoshi, 8 Nov 2026:
// "Once they've entered the home code once while logged in, they always keep access to the home"): a row in the store's
// home_grants, with the generation of the code it was made with. Every later session of the account gets in without the
// code, on any device. It ends when the admin makes a new code, revokes it or changes the home's settings (the generation
// goes up: a leaked code cuts off everyone who used it), removes it in /admin, or the account is deleted. While the
// account is switched off it has no session, so no access. Guests keep the session's grant only.
//
// Public:  POST /api/home/unlock {id, code} -> {ok: true, inside} (with a session: that session now has the grant; `inside`
//          is the home's inside pack, see shared/insideData.mjs, when the private data holds it), or 403 {code:'home_denied'},
//          429 {code:'home_slow'}. Without a session (playing alone) it only answers, with the pack: the page installs it.
//          GET /api/home/:id/inside -> the pack again, for a session that has the grant (a page that rejoined) and for the
//          admin; anyone else gets the wrong code's 403. Never cached (no-store, private): the pack is what the repository
//          no longer holds.
// Admin:   GET /api/admin/homes (the list), POST /api/admin/homes/:id/code (a new code, shown once),
//          DELETE /api/admin/homes/:id/code (revoke), POST /api/admin/homes/:id {enabled, expiresAt} (settings),
//          DELETE /api/admin/homes/:id/access (every account's lasting access) and /access/:name (one account's).
//          The admin needs no code: POST /api/home/unlock {id} as the admin answers {ok: true}.
//
// Guarded against:
// - guessing: codes are 10 characters of a 32 letter alphabet (50 bits); attempts are limited per sender (30 an hour in
//   all, 8 per home in ten minutes) before any hashing, and each hash costs scrypt. 50 bits make guessing hopeless at
//   these rates.
// - a flood slowing the site: every try is a scrypt (16 MB, tens of ms) on Node's four worker threads. At most
//   UNLOCK_TURNS run at once and UNLOCK_QUEUE wait (server/auth.mjs Turns, as the account passwords have their own);
//   more hear "busy" (503). Each home has a budget of UNLOCK_PER_HOME checks an hour from everyone together (made-up
//   ids share one budget of their own, so they never use up a real home's). Past it nobody is refused for it: the tries
//   go one at a time through a slow lane (SLOW_QUEUE waiting, each after CAP_WAIT_MS), so a flood from many addresses
//   costs about one hash a second and an owner still gets through. A session that holds the home's grant skips the
//   slow lane; the admin needs no code at all. Wrong tries are counted in memory and written to the store at most once
//   in FLUSH_MS, so a flood is no stream of writes either.
// - a code changed while a try waits: after the check the record is read again, and the try opens the home only if it
//   is still live with the very hash that was checked (a new code, a revoked one or a home switched off meanwhile: no).
// - telling homes apart: unknown, switched off, expired or without a code: the same 403 and the same work (a scrypt
//   against a dummy hash), so neither the answer nor the time says which ids exist.
// - cross-site posts: same-origin JSON bodies only (server.mjs).
// - leaks in logs and files: the code never reaches a log or the store (a hash does); the store keeps counters only,
//   no address and no name, besides the names of the accounts with lasting access (home_grants, shown to the admin only).
// - an account's access taken or handed on: the page sends only the code and the home's id. Whose access it is comes
//   from the session the server holds (`who`, by the session's key), never from the request; a session that a new
//   password, a switch-off, a deletion or a kick ended (server/auth.mjs revoke) is no longer there, so it opens nothing.
import { randomInt } from 'node:crypto';
import { Attempts, hashPassword, Turns, verifyHash } from './auth.mjs';
import { Window } from './feedback.mjs';
import { findHome } from '../shared/homes.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CODE_LENGTH = 10;
const META = 'homes';
const UNLOCK_TURNS = 2; // code checks at once
const UNLOCK_QUEUE = 8; // and waiting
const UNLOCK_PER_HOME = 300; // code checks of one home in an hour, everyone together, before the slow lane
const SLOW_QUEUE = 4; // tries waiting in the slow lane (one runs)
const CAP_WAIT_MS = 1000; // the pause before each check in the slow lane
const FLUSH_MS = 60_000; // wrong tries reach the store at most this often
const BUSY = { error: 'The server is busy. Try again in a moment.', code: 'busy' };
const SLOW = { error: 'Too many tries, wait a while', code: 'home_slow' };
const GRANT_MS = 8 * 3600_000; // how long a typed code lets a player in without typing it again
/** The pack is private data: no cache keeps it. (BREACH needs a secret reflected next to attacker text; nothing of the request is in the answer.) */
const NO_CACHE = { 'Cache-Control': 'no-store, private, no-transform' };
const BLANK = { enabled: false, hash: null, setAt: null, expiresAt: null, unlocks: 0, fails: 0, lastUnlockAt: null, lastFailAt: null };

/** Does this home's record open with a code now: switched on, with a code, not past its end? */
const isLive = (h) => !!(h?.enabled && h.hash && (!h.expiresAt || Date.now() <= Date.parse(`${h.expiresAt}T23:59:59Z`)));
/** The generation of a home's code: up by one with every change the admin makes (a new code, revoked, its settings). */
const genOf = (h) => (Number.isInteger(h?.gen) ? h.gen : 0);

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
  /**
   * `account(req)`: the request comes from a player's account or the admin: past a home's budget they wait in a lane of
   * their own, which a flood without an account can't fill.
   */
  /**
   * `who(key)`: the live session with that key ({ username, role }) or null; `keysOf(name)`: the keys of an account's live
   * sessions. Both read server/auth.mjs's sessions, so a revoked session is gone from them at once.
   */
  constructor(store, { list, json, readJson, clientKey, account = () => false, pack = () => null, who = () => null, keysOf = () => [], flushMs = FLUSH_MS, capWaitMs = CAP_WAIT_MS }) {
    Object.assign(this, { store, list, json, readJson, clientKey, account, pack, who, keysOf, flushMs, capWaitMs });
    this.lasting = new Map(); // account name -> Map(home id -> { gen, at }): its lasting access (the store's home_grants)
    this.onGrant = null; // (key, id) => void: the game server tells that page the state of the inside (Game.homeGranted)
    this.perSender = new Window(10 * 60_000); // attempts at one home from one sender
    this.perSenderAll = new Window(3600_000); // all homes from one sender
    this.checks = new Attempts(3600_000); // code checks that reached a hash, per home id ('-' for made-up ids), everyone together
    this.turns = new Turns(UNLOCK_TURNS, UNLOCK_QUEUE);
    this.slowLanes = new Map(); // budget ('-' or a home id) -> Turns(1, SLOW_QUEUE): past that budget (at most four)
    this.fails = new Map(); // home id -> { n, at }: wrong tries not in the store yet (see flush)
    this.flushTimer = null;
    this.flushedAt = 0;
    // `${session key}|${id}` -> { until (ms), gen }: the code of generation `gen` was typed in this session (the game server asks, see granted)
    this.grants = new Map();
    this.state = null;
    this.chain = Promise.resolve();
    this.dummy = null;
  }

  /** The homes' records and the accounts' lasting access, from the store once (server.mjs calls it at start). */
  async load() {
    if (!this.state) {
      let s;
      try {
        s = JSON.parse((await this.store.getMeta(META)) || '{}');
      } catch {
        s = {};
      }
      let rows = [];
      try {
        rows = await this.store.listHomeGrants();
      } catch (e) {
        console.error('home access not read', String(e)); // nobody has lasting access until a restart: shut, not open
      }
      if (!this.state) {
        this.state = s;
        // Only rows made with the home's current code count (an older one is left from a change made while it was written).
        for (const r of rows) if (findHome(r.home, this.list) && r.gen === genOf(s[r.home])) this.lastingOf(r.username).set(r.home, { gen: r.gen, at: r.at });
      }
    }
    return this.state;
  }

  /** The lasting access of account `name` (made on first use). */
  lastingOf(name) {
    if (!this.lasting.has(name)) this.lasting.set(name, new Map());
    return this.lasting.get(name);
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

  /** A budget is used up: said in the log at most once an hour for each (the home's id or '-', no address). */
  capped(budget, now) {
    this.cappedAt ??= new Map();
    if (now - (this.cappedAt.get(budget) ?? 0) <= 3600_000) return;
    this.cappedAt.set(budget, now);
    console.log(JSON.stringify({ event: 'home_unlock_capped', id: budget, max: UNLOCK_PER_HOME }));
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

  /**
   * Was this home's code typed in this session (its key) lately, or by the account this session is logged in to? The game
   * server lets only such a player in (server/homeGate.mjs). A session that ends, or a name taken over later, has another key.
   */
  granted(key, id) {
    if (!key) return false;
    if (!isLive(this.state?.[id])) return false; // a code that is revoked, replaced, switched off or past its end takes the grants with it (see forget)
    if (!this.who(key)) return false; // the session ended (logged out, a new password, kicked, switched off): nothing, at once
    // Only a grant made with the code in use now: one given after a code change (a try still on its way) opens nothing.
    const g = this.grants.get(`${key}|${id}`);
    return (!!g && g.until > Date.now() && g.gen === genOf(this.state?.[id])) || this.byAccount(key, id);
  }

  /**
   * Does the account behind session `key` have lasting access to home `id`: its code, of the generation in use now, typed
   * while logged in? Only a live session of role 'player' (server/auth.mjs): not a guest, and not one that was revoked.
   */
  byAccount(key, id) {
    const h = this.state?.[id];
    if (!key || !isLive(h)) return false;
    const s = this.who(key);
    return s?.role === 'player' && this.lasting.get(s.username)?.get(id)?.gen === genOf(h);
  }

  /** The home's grants end (its code or settings changed). */
  forget(id) {
    for (const k of this.grants.keys()) if (k.endsWith(`|${id}`)) this.grants.delete(k);
  }

  /** Every right to home `id` ends: the sessions' and the accounts' (the admin made a new code, revoked it or changed its settings). */
  async cut(id) {
    this.forget(id);
    await this.drop(id, null);
  }

  /**
   * Accounts' lasting access to home `id` ends: account `name`'s, or every account's (null). Their sessions' grants of
   * it end too, so they are out now, not in 8 hours. How many accounts had it.
   */
  async drop(id, name) {
    let n = 0;
    for (const u of name === null ? [...this.lasting.keys()] : [name]) {
      const m = this.lasting.get(u);
      if (m?.delete(id)) n++;
      if (m && !m.size) this.lasting.delete(u);
      for (const k of this.keysOf(u)) this.grants.delete(`${k}|${id}`);
    }
    await this.store.deleteHomeGrants(id, name);
    return n;
  }

  /** Account `name` is gone (deleted by the player or the admin, or unused too long): its lasting access with it (server/accounts.mjs onGone). The store's rows went with the account. */
  dropAccount(name) {
    this.lasting.delete(name);
  }

  /**
   * The account logged in on session `key` typed home `id`'s code of generation `gen`: lasting access, in the store and
   * here. True when kept. Nothing for a guest, the admin or no session.
   */
  async keep(key, id, gen) {
    const s = this.who(key);
    if (s?.role !== 'player') return false;
    const name = s.username;
    let saved = false;
    try {
      saved = await this.store.saveHomeGrant(name, id, gen); // false: the account is no longer there
    } catch (e) {
      console.error('home access not written', String(e));
    }
    if (!saved) return false;
    // Again after the write: the session revoked (a new password, switched off, deleted, kicked) or the code changed
    // meanwhile keeps nothing. From here to the end nothing waits, so a deletion that starts later finds the row and the entry.
    const now = this.who(key);
    if (now?.role !== 'player' || now.username !== name || !isLive(this.state?.[id]) || genOf(this.state?.[id]) !== gen) {
      this.lasting.get(name)?.delete(id);
      await this.store.deleteHomeGrants(id, name).catch((e) => console.error('home access not removed', String(e)));
      return false;
    }
    this.lastingOf(name).set(id, { gen, at: new Date().toISOString() });
    return true;
  }

  /** Session `key` typed home `id`'s code of generation `gen`: it is let in for GRANT_MS, while that code stays in use. */
  grant(key, id, gen) {
    if (!key) return; // no session: a solo page, nothing on the server to let in
    const now = Date.now();
    if (this.grants.size > 500) for (const [k, g] of this.grants) if (g.until <= now) this.grants.delete(k);
    this.grants.set(`${key}|${id}`, { until: now + GRANT_MS, gen });
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
    // Accounts' lasting access: every account's for the home, or one account's (a name as accounts have them, server/auth.mjs NAME_RE).
    const acc = /^\/api\/admin\/homes\/([a-z0-9_]{1,20})\/access(?:\/([a-z0-9_-]{2,20}))?$/.exec(p);
    if (acc) {
      const home = findHome(acc[1], this.list);
      if (!home) return (await this.json(res, 404, { error: 'Not found' }), true);
      if (req.method !== 'DELETE') return (await this.json(res, 405, { error: 'Not allowed' }), true);
      await this.readJson(req); // the same-origin check, as below
      await this.load();
      const removed = await this.drop(home.id, acc[2] ?? null);
      console.log(JSON.stringify({ event: 'home_access_removed', id: home.id, removed })); // how many, no name
      return (await this.json(res, 200, { ok: true, removed }), true);
    }
    const r = /^\/api\/admin\/homes\/([a-z0-9_]{1,20})(\/code)?$/.exec(p);
    const home = r && findHome(r[1], this.list);
    if (!home) return (await this.json(res, 404, { error: 'Not found' }), true);
    if (r[2] && (req.method === 'POST' || req.method === 'DELETE')) await this.readJson(req); // the same-origin check (server.mjs body): no cross-site posts, even with no body
    if (r[2] && req.method === 'POST') {
      const code = newCode();
      const hash = await hashPassword(code);
      this.fails.delete(home.id); // a new code starts its count afresh
      await this.update(home.id, (h) => ({ ...h, hash, enabled: true, setAt: new Date().toISOString(), fails: 0, gen: genOf(h) + 1 }));
      await this.cut(home.id); // the old code's access ends, the accounts' lasting access too
      console.log(JSON.stringify({ event: 'home_code', id: home.id }));
      return (await this.json(res, 200, { code: showCode(code) }), true);
    }
    if (r[2] && req.method === 'DELETE') {
      await this.update(home.id, (h) => ({ ...h, hash: null, setAt: null, gen: genOf(h) + 1 }));
      await this.cut(home.id);
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
      await this.update(home.id, (h) => ({ ...h, ...patch, gen: genOf(h) + 1 })); // as before for the sessions: a change ends the access made with the code
      await this.cut(home.id);
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
      // The accounts with lasting access made with the code in use now, by name.
      const accounts = [];
      for (const [username, m] of this.lasting) {
        const g = m.get(h.id);
        if (g && g.gen === genOf(x)) accounts.push({ username, at: g.at ?? null });
      }
      accounts.sort((a, b) => (a.username < b.username ? -1 : 1));
      rows.push({
        id: h.id, enabled: !!x.enabled, hasCode: !!x.hash, setAt: x.setAt ?? null, expiresAt: x.expiresAt ?? null,
        unlocks: x.unlocks ?? 0, fails: (x.fails ?? 0) + (f?.n ?? 0), lastUnlockAt: x.lastUnlockAt ?? null, lastFailAt: f?.at ?? x.lastFailAt ?? null,
        accounts,
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
    const hash = isLive(rec) ? rec.hash : null; // the hash this try is checked against
    const look = !!(admin && home && b.code === undefined); // the admin needs no code
    let ok = look;
    let gen = null; // the generation of the code that opened it
    if (!look) {
      const budget = home ? home.id : '-'; // made-up ids never use up a real home's budget
      const now = Date.now();
      const over = this.checks.count(budget, now) >= UNLOCK_PER_HOME && !(home && this.granted(user, home.id));
      const check = async () => {
        this.dummy ??= await hashPassword('no such home');
        return verifyHash(normalizeCode(b.code), hash ?? this.dummy);
      };
      let checked;
      if (over) {
        // Past the budget nobody is refused for it: one at a time, each after a pause (about one hash a second).
        this.capped(budget, now);
        // Accounts (and the admin) wait apart from everyone else: a flood without an account never fills their lane.
        const lane = `${budget}|${this.account(req) ? 'account' : 'anyone'}`;
        if (!this.slowLanes.has(lane)) this.slowLanes.set(lane, new Turns(1, SLOW_QUEUE));
        const slow = await this.slowLanes.get(lane).run(async () => {
          await new Promise((r) => setTimeout(r, this.capWaitMs));
          return this.turns.run(check);
        });
        checked = slow?.value ?? null;
      } else {
        this.checks.add(budget, now);
        checked = await this.turns.run(check);
        if (!checked) this.checks.undo(budget, now); // a refusal for "busy" is not counted
      }
      if (!checked) return this.json(res, 503, BUSY);
      // The record again: the admin may have made a new code, revoked it or switched the home off while this try waited.
      const cur = home ? this.state?.[home.id] : null;
      ok = !!hash && checked.value && isLive(cur) && cur.hash === hash;
      if (ok) gen = genOf(cur);
    }
    if (!ok) {
      if (home) this.noteFail(home.id);
      return this.json(res, 403, { error: 'Wrong code', code: 'home_denied' });
    }
    if (!look) await this.update(home.id, (h) => ({ ...h, unlocks: (h.unlocks ?? 0) + 1, lastUnlockAt: new Date().toISOString() }));
    // Logged in to an account: lasting access for it (keep), and its other sessions are let in now too.
    const kept = !look && (await this.keep(user, home.id, gen));
    // Once more after those writes: a code made, revoked or switched off meanwhile opens nothing (the same answer as a
    // wrong code). From here to the grant nothing waits.
    const live = this.state?.[home.id];
    if (!look && (!isLive(live) || genOf(live) !== gen)) return this.json(res, 403, { error: 'Wrong code', code: 'home_denied' });
    this.grant(user, home.id, look ? genOf(live) : gen);
    const owner = kept ? this.who(user)?.username : null;
    if (owner) for (const k of this.keysOf(owner)) if (k !== user) this.onGrant?.(k, home.id);
    console.log(JSON.stringify({ event: 'home_unlock', id: home.id, ...(kept ? { account: true } : {}) })); // no name
    const inside = this.pack(home.id);
    return this.json(res, 200, { ok: true, ...(kept ? { account: true } : {}), ...(inside ? { inside } : {}) }, NO_CACHE);
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
