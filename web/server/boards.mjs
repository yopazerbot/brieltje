// The boards of the timed routes, the gnomes and the party games over HTTP (server/goals.mjs decides what goes on them,
// server/store.mjs keeps them): the public boards, a player's own lines, and the admin's removal of a row.
//
// - GET /api/boards, public, read only: the best ten of each board (names of accounts and the admin's reserved names, a
//   time or a count, a day). Built at most once in CACHE_MS, and again after a board changed. No input is read.
// - GET /api/boards/mine, for the session's own name only (there is no name parameter anywhere): where you stand on
//   each board; a guest gets {}. Kept MINE_MS per name.
// - POST /api/admin/boards, the panel's admin only: { op: 'remove', name, board?, route? } (no board: all three). Behind
//   the panel's session, through the same-origin JSON check (server.mjs body: no cross-site form posts), at most
//   REMOVE_MAX a minute, logged once as board_removed with the admin's name and the account's. GET gives the panel the
//   admin's reserved names (they have no account row to clear them from).
//
// Every answer goes through server.mjs json(): no-store, no-transform, never compressed (BREACH); none holds a secret or
// echoes what a request sent.

import { NAME_RE } from './auth.mjs';
import { GAME_KINDS } from './store.mjs';

const CACHE_MS = 15_000;
const MINE_MS = 10_000;
const MINE_MAX = 1000; // names kept at once in the cache of own lines
const TOP = 10;
const REMOVE_MAX = 10; // the admin's removals a minute
const BOARDS = ['race', 'gnomes', 'games'];

/** A stored time as its day, YYYY-MM-DD. */
const day = (at) => {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};

export class Boards {
  /**
   * `routes`: the game's routes ({ id, key }); `gnomeTotal`: how many gnomes there are; `json(res, status, data)`,
   * `readJson(req)`: server.mjs's; `known(name)`: an account or a reserved name; `log(event, req, extra)`: the login log.
   */
  /** `forget(name, board, routeId)`: the live tracker forgets what it holds for a removed name (server/goals.mjs). */
  constructor(store, { routes, gnomeTotal, json, readJson, known, log, reserved = [], forget = () => {}, now = () => Date.now() }) {
    this.store = store;
    this.reserved = [...reserved];
    this.forget = forget;
    this.routes = routes;
    this.gnomeTotal = gnomeTotal;
    this.json = json;
    this.readJson = readJson;
    this.known = known;
    this.log = log;
    this.now = now;
    this.all = null; // { at, p }: the public boards being built or built
    this.mine = new Map(); // username -> { at, p }
    this.removals = []; // when the admin's last removals came
  }

  /** A board changed (server/rooms.mjs scored): the next answer is built again. */
  clear() {
    this.all = null;
    this.mine.clear();
  }

  /** Answers the boards' paths; false for any other. `panel`: the panel's session or null; `session`: the game's. */
  async handle(req, res, url, panel, session) {
    const p = url.pathname;
    if ((p === '/api/boards' || p === '/api/boards/mine') && req.method !== 'GET') return (this.json(res, 405, { error: 'Not allowed' }, { Allow: 'GET' }), true);
    if (p === '/api/boards') return (this.json(res, 200, await this.boards()), true);
    if (p === '/api/boards/mine' && req.method === 'GET') {
      if (!session) return (this.json(res, 401, { error: 'Not logged in', code: 'notLoggedIn' }), true);
      if (session.role === 'guest') return (this.json(res, 200, {}), true);
      return (this.json(res, 200, await this.mineOf(session.username)), true);
    }
    if (p === '/api/admin/boards') {
      if (!panel) return (this.json(res, 403, { error: 'Admin only' }), true);
      // The admin's reserved names, for the panel's own row (they have no account to clear from the accounts list).
      if (req.method === 'GET') return (this.json(res, 200, { reserved: this.reserved }), true);
      if (req.method !== 'POST') return (this.json(res, 405, { error: 'Not allowed' }), true);
      const b = await this.readJson(req); // the same-origin JSON check: throws 403 or 415 for a cross-site post
      const { status = 200, ...r } = await this.remove(req, panel.username, b);
      return (this.json(res, status, r), true);
    }
    return false;
  }

  /** The public boards: the best TOP of each (built at most once in CACHE_MS, the same promise for requests meanwhile). */
  boards() {
    const t = this.now();
    if (this.all && t - this.all.at < CACHE_MS) return this.all.p;
    const p = this.build().catch((e) => {
      this.all = null;
      throw e;
    });
    this.all = { at: t, p };
    return p;
  }

  async build() {
    // Only names an account can have (a row written some other way never shows): a few more asked for, the best TOP kept.
    const top = (rows) => rows.filter((r) => typeof r?.username === 'string' && NAME_RE.test(r.username)).slice(0, TOP);
    const races = {};
    for (const route of this.routes) {
      races[route.id] = top(await this.store.raceBoard(route.key, TOP + 5)).map((r) => ({ username: r.username, ms: r.ms, at: day(r.at) }));
    }
    const gnomes = top(await this.store.gnomeBoard(TOP + 5)).map((r) => ({ username: r.username, n: r.n, at: day(r.at) }));
    const games = top(await this.store.gameBoard(TOP + 5)).map((r) => ({ username: r.username, wins: r.wins, ...Object.fromEntries(GAME_KINDS.map((k) => [k, r[k]])) }));
    return { races, gnomes, games, gnomeTotal: this.gnomeTotal };
  }

  /** One name's own lines (a session's own, never asked for by name): kept MINE_MS. */
  mineOf(name) {
    const t = this.now();
    const kept = this.mine.get(name);
    if (kept && t - kept.at < MINE_MS) return kept.p;
    if (this.mine.size >= MINE_MAX) for (const [k, v] of this.mine) if (t - v.at >= MINE_MS || this.mine.size >= MINE_MAX) this.mine.delete(k);
    const p = this.buildMine(name).catch((e) => {
      this.mine.delete(name);
      throw e;
    });
    this.mine.set(name, { at: t, p });
    return p;
  }

  async buildMine(name) {
    const times = new Map((await this.store.racesOf(name)).map((r) => [r.route, r.ms]));
    const races = {};
    for (const route of this.routes) {
      const ms = times.get(route.key);
      if (ms !== undefined) races[route.id] = { ms, place: await this.store.racePlace(route.key, ms) };
    }
    const gnomes = (await this.store.gnomesOf(name)).length;
    return { races, gnomes, games: await this.store.gamesOf(name) };
  }

  /**
   * The admin removes a name's rows: from one board, or (no `board`) from all three at once; checked, rate-limited,
   * logged once. The answer's `status` is the HTTP status, never part of its body.
   */
  async remove(req, by, b) {
    const t = this.now();
    this.removals = this.removals.filter((x) => t - x < 60_000);
    if (this.removals.length >= REMOVE_MAX) return { error: 'Slow down', code: 'tooFast', status: 429 };
    if (b?.op !== 'remove') return { error: 'Unknown action', code: 'badOp', status: 400 };
    const name = b.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { error: 'No such account', code: 'noAccount', status: 404 };
    const all = b.board === undefined || b.board === null;
    if (!all && !BOARDS.includes(b.board)) return { error: 'Not a board', code: 'badValue', status: 400 };
    let route = null;
    if (b.route !== undefined && b.route !== null) {
      route = b.board === 'race' ? this.routes.find((r) => r.id === b.route) ?? null : null;
      if (!route) return { error: 'Not a route', code: 'badValue', status: 400 };
    }
    if (!(await this.known(name))) return { error: 'No such account', code: 'noAccount', status: 404 };
    this.removals.push(t);
    let removed = 0;
    for (const board of all ? BOARDS : [b.board]) removed += await this.store.removeScores(name, board, route?.key ?? null);
    this.forget(name, all ? null : b.board, route?.id ?? null); // the live tracker's memory and tonight's tables too
    this.clear();
    this.log('board_removed', req, { username: by, detail: `${name}: ${all ? 'all boards' : b.board}${route ? ` ${route.id}` : ''}` });
    return { ok: true, removed };
  }
}
