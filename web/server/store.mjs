// Sessions, furniture and the spawned Teslas, fighting stats, the login log, the
// interest page's sign-ups (server/interest.mjs), the daily totals of how much the game is played
// (server/stats.mjs) with the day's visitor codes (kept for that Belgian day only), players'
// feedback (server/feedback.mjs) and the game night's sign-ups (server/gamenight.mjs).
// Railway: Postgres via DATABASE_URL. Local development without it: a JSON
// file in web/.data/ (not in git).
// Sessions are stored by a hash of their token, never the token itself.

const STAT_KEYS = ['kills', 'deaths', 'headshots', 'wins'];

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MAX_LOG = 500;
/**
 * The names on the boards besides the accounts' (server.mjs sets `boardNames`: the admin's reserved names, server/auth.mjs
 * RESERVED, which only the admin password logs in under). Yoshi, 8 Nov 2026: the admin's runs and totals are on the board.
 */
const boardNames = (store) => (Array.isArray(store.boardNames) ? store.boardNames : []);
const NAMED = ['join_ok', 'mp_join', 'solo_start', 'login_ok']; // the login log's lines with a player's (or the admin's) name

/** Replace a file. On Windows a virus scanner can hold a file it just saw written for a moment: try again for up to a second. */
async function replace(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Exported for the tests (server/board-names.test.mjs), on a file of their own. */
export class FileStore {
  constructor(file) {
    this.file = file;
    this.data = { audit: [], sessions: [], stats: {}, meta: {}, furniture: [], cars: [], interest: [], interestId: 0, daily: {}, feedback: [], feedbackId: 0, gamenight: [], gamenightId: 0, visits: null, accounts: [], zombieBest: [], homeGrants: [] };
  }
  async init() {
    await mkdir(resolve(this.file, '..'), { recursive: true });
    this.data = { ...this.data, ...JSON.parse(await readFile(this.file, 'utf8').catch(() => '{}')) };
    delete this.data.users; // the old player accounts (Yoshi, 7 Nov 2026: removed)
  }
  // ---- Accounts (server/accounts.mjs): lists, not objects keyed by name, so a name like "__proto__" is only a name.
  async createAccount(a) {
    if (this.data.accounts.some((r) => r.username === a.username)) return false;
    const now = new Date().toISOString();
    this.data.accounts.push({ username: a.username, email: a.email, pass: a.pass, created: now, seen: now, disabled: false });
    delete this.data.stats[`u:${a.username}`]; // a new account starts at nothing
    this.data.zombieBest = this.data.zombieBest.filter((r) => r.username !== a.username); // nor any run left under the name
    this.data.homeGrants = this.data.homeGrants.filter((r) => r.username !== a.username); // nor a home's access
    await this.save();
    return true;
  }
  async getAccount(username) {
    return this.data.accounts.find((r) => r.username === username) ?? null;
  }
  async updateAccount(username, patch) {
    const row = this.data.accounts.find((r) => r.username === username);
    if (!row) return false;
    for (const k of ['pass', 'disabled']) if (k in patch) row[k] = patch[k];
    if (patch.seen) row.seen = new Date().toISOString();
    await this.save();
    return true;
  }
  async deleteAccount(username) {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((r) => r.username !== username);
    this.data.zombieBest = this.data.zombieBest.filter((r) => r.username !== username);
    this.data.homeGrants = this.data.homeGrants.filter((r) => r.username !== username); // its access to the homes goes with it
    delete this.data.stats[`u:${username}`];
    await this.save();
    return this.data.accounts.length < before;
  }
  // ---- Accounts' lasting access to the code-locked homes (server/homes.mjs): one row per account and home, made with
  // the home's code of generation `gen`. Only accounts that exist: a row is never written for a name without one.
  async listHomeGrants() {
    const names = new Set(this.data.accounts.map((r) => r.username));
    return this.data.homeGrants.filter((r) => names.has(r.username)).map(({ username, home, gen, at }) => ({ username, home, gen, at }));
  }
  async saveHomeGrant(username, home, gen) {
    if (!this.data.accounts.some((r) => r.username === username)) return false;
    const at = new Date().toISOString();
    const old = this.data.homeGrants.find((r) => r.username === username && r.home === home);
    if (old) Object.assign(old, { gen, at });
    else this.data.homeGrants.push({ username, home, gen, at });
    await this.save();
    return true;
  }
  /** One account's access to `home` (`username`), or every account's (null): how many rows went. */
  async deleteHomeGrants(home, username = null) {
    const before = this.data.homeGrants.length;
    this.data.homeGrants = this.data.homeGrants.filter((r) => r.home !== home || (username !== null && r.username !== username));
    if (this.data.homeGrants.length < before) await this.save();
    return before - this.data.homeGrants.length;
  }
  async listAccounts() {
    return this.data.accounts.map(({ pass, ...r }) => r).sort((a, b) => (a.created < b.created ? 1 : -1));
  }
  /** Accounts nobody logged in to for `days`: removed with their scores; their names. */
  async pruneAccounts(days) {
    const cut = new Date(Date.now() - days * 86400_000).toISOString();
    const gone = this.data.accounts.filter((r) => r.seen < cut).map((r) => r.username);
    for (const u of gone) await this.deleteAccount(u);
    return gone;
  }
  /** Fighting totals for accounts only (Yoshi, 7 Nov 2026): the totals of names without an account go. */
  async statsForAccountsOnly() {
    const names = new Set(this.data.accounts.map((r) => `u:${r.username}`));
    for (const n of boardNames(this)) names.add(`u:${n}`); // the admin's own totals stay (Yoshi, 8 Nov 2026)
    for (const k of Object.keys(this.data.stats)) if (!names.has(k)) delete this.data.stats[k];
    await this.save();
  }
  /** A Zombies run of an account at a place: kept if it beats their best there (the wave, then zombies beaten). */
  async saveZombieRun(username, place, wave, kills, team) {
    if (!boardNames(this).includes(username) && !this.data.accounts.some((r) => r.username === username)) return false;
    const old = this.data.zombieBest.find((r) => r.username === username && r.place === place);
    if (old && (old.wave > wave || (old.wave === wave && old.kills >= kills))) return false;
    const row = { username, place, wave, kills, team, at: new Date().toISOString() };
    if (old) Object.assign(old, row);
    else this.data.zombieBest.push(row);
    await this.save();
    return true;
  }
  /** Best runs whose name is no account and not the admin (one saved as its account went): gone. At start. */
  async zombieBestForAccountsOnly() {
    const names = new Set(this.data.accounts.map((r) => r.username));
    const before = this.data.zombieBest.length;
    this.data.zombieBest = this.data.zombieBest.filter((r) => names.has(r.username) || boardNames(this).includes(r.username));
    if (this.data.zombieBest.length < before) await this.save();
  }
  /** The best runs: at one place, or each account's best anywhere; the best `limit`. Only accounts' and the admin's. */
  async zombieBoard(place, limit) {
    const better = (a, b) => b.wave - a.wave || b.kills - a.kills || (a.at < b.at ? -1 : 1);
    const names = new Set(this.data.accounts.map((r) => r.username));
    let rows = this.data.zombieBest.filter((r) => (!place || r.place === place) && (names.has(r.username) || boardNames(this).includes(r.username)));
    if (!place) {
      const best = new Map();
      for (const r of rows) if (!best.has(r.username) || better(r, best.get(r.username)) < 0) best.set(r.username, r);
      rows = [...best.values()];
    }
    return rows.sort(better).slice(0, limit).map(({ username, place: p, wave, kills, team, at }) => ({ username, place: p, wave, kills, team, at }));
  }
  /** One write at a time, via a temporary file, so overlapping saves can't mix up the file. */
  save() {
    this.saving = (this.saving || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await writeFile(`${this.file}.tmp`, JSON.stringify(this.data, null, 1));
        await replace(`${this.file}.tmp`, this.file);
      });
    return this.saving;
  }
  async loadSessions(now) {
    this.data.sessions = this.data.sessions.filter((s) => s.expires > now);
    return this.data.sessions;
  }
  /**
   * `device`: the guest cookie's id of the browser that joined (server/auth.mjs kick), if any, or 'panel' for the admin
   * panel's session. `since`: a panel session's login time (server/auth.mjs PANEL_MS).
   */
  async saveSession(key, username, role, expires, device = null, since = null) {
    this.data.sessions.push({ key, username, role, expires, ...(device ? { device } : {}), ...(since ? { since } : {}) });
    await this.save();
  }
  /** A panel session's idle limit moved on (server/auth.mjs touchPanel). */
  async touchSession(key, expires) {
    const s = this.data.sessions.find((x) => x.key === key);
    if (!s) return;
    s.expires = expires;
    await this.save();
  }
  async deleteSession(key) {
    this.data.sessions = this.data.sessions.filter((s) => s.key !== key);
    await this.save();
  }
  async deleteSessionsOf(username) {
    this.data.sessions = this.data.sessions.filter((s) => s.username !== username);
    await this.save();
  }
  async getMeta(key) {
    return this.data.meta[key] ?? null;
  }
  async listFurniture() {
    return this.data.furniture;
  }
  async addFurniture(f) {
    const id = (this.data.meta.furnId = (this.data.meta.furnId || 0) + 1);
    this.data.furniture.push({ id, ...f });
    await this.save();
    return id;
  }
  async updateFurniture(id, f) {
    const row = this.data.furniture.find((r) => r.id === id);
    if (row) Object.assign(row, f);
    await this.save();
  }
  async deleteFurniture(id) {
    this.data.furniture = this.data.furniture.filter((r) => r.id !== id);
    await this.save();
  }
  async clearFurniture() {
    this.data.furniture = [];
    await this.save();
  }
  // Teslas spawned with /tesla (server/game.mjs): where each was put, kept like furniture.
  async listCars() {
    return this.data.cars;
  }
  async addCar(c) {
    const id = (this.data.meta.carId = (this.data.meta.carId || 0) + 1);
    this.data.cars.push({ id, kind: c.kind, x: c.x, y: c.y, z: c.z, yaw: c.yaw, by: c.by });
    await this.save();
    return id;
  }
  async updateCar(id, c) {
    const row = this.data.cars.find((r) => r.id === id);
    if (row) Object.assign(row, { x: c.x, y: c.y, z: c.z, yaw: c.yaw, by: c.by });
    await this.save();
  }
  async deleteCar(id) {
    this.data.cars = this.data.cars.filter((r) => r.id !== id);
    await this.save();
  }
  async clearCars() {
    this.data.cars = [];
    await this.save();
  }
  async setMeta(key, value) {
    this.data.meta[key] = value;
    await this.save();
  }
  async addStats(username, add) {
    const row = (this.data.stats[`u:${username}`] ||= { kills: 0, deaths: 0, headshots: 0, wins: 0 }); // prefixed: a name is never a key of the object itself
    for (const k of STAT_KEYS) row[k] += add[k] || 0;
    await this.save();
  }
  async leaderboard() {
    const names = new Set(this.data.accounts.map((r) => r.username));
    for (const n of boardNames(this)) names.add(n);
    return Object.entries(this.data.stats).filter(([k]) => k.startsWith('u:') && names.has(k.slice(2))).map(([k, s]) => ({ username: k.slice(2), ...s }));
  }
  async log(entry) {
    this.data.audit.unshift(entry);
    this.data.audit.length = Math.min(this.data.audit.length, MAX_LOG);
    await this.save();
  }
  async recentLog(limit) {
    return this.data.audit.slice(0, limit);
  }
  async pruneLog() {
    // The file keeps the last MAX_LOG entries (see log).
  }
  async addInterest(data, tokenHash) {
    const id = ++this.data.interestId;
    this.data.interest.push({ id, data, tokenHash });
    await this.save();
    return id;
  }
  async getInterest(id) {
    return this.data.interest.find((r) => r.id === id) ?? null;
  }
  async listInterest() {
    return [...this.data.interest].reverse().map(({ id, data }) => ({ id, data }));
  }
  async updateInterest(id, patch) {
    const row = this.data.interest.find((r) => r.id === id);
    if (row) Object.assign(row.data, patch);
    await this.save();
  }
  async deleteInterest(id) {
    this.data.interest = this.data.interest.filter((r) => r.id !== id);
    await this.save();
  }
  async addDaily(day, counts) {
    const d = (this.data.daily[day] ||= {});
    for (const [k, n] of Object.entries(counts)) d[k] = (d[k] || 0) + n;
    await this.save();
  }
  async maxDaily(day, key, n) {
    const d = (this.data.daily[day] ||= {});
    d[key] = Math.max(d[key] || 0, n);
    await this.save();
  }
  async listDaily(from) {
    return Object.entries(this.data.daily).filter(([day]) => day >= from).flatMap(([day, keys]) => Object.entries(keys).map(([key, value]) => ({ day, key, value })));
  }
  /** The day's seed for the visitor codes (server/stats.mjs): the stored one, or `fresh` for a day without one. */
  async visitSeed(day, fresh) {
    if (this.data.visits?.day === day) return this.data.visits.seed;
    this.data.visits = { day, seed: fresh, seen: {} };
    await this.save();
    return fresh;
  }
  /** Whether a visitor code is new on `day` (it is kept until the day is forgotten). */
  async seeVisitor(day, hash) {
    const v = this.data.visits;
    if (v?.day !== day) return true;
    if (v.seen[hash]) return false;
    v.seen[hash] = 1;
    await this.save();
    return true;
  }
  /** The seed and the codes of days before `day` deleted. */
  async forgetVisits(day) {
    if (!this.data.visits || this.data.visits.day >= day) return;
    this.data.visits = null;
    await this.save();
  }
  /** Who played per day: the names in the login log (joined together, started alone, the admin's logins) with their first time that day. */
  async logNames(from) {
    const rows = new Map();
    for (const e of this.data.audit) {
      const day = String(e.time).slice(0, 10);
      if (day < from || !NAMED.includes(e.event) || !e.username) continue;
      const k = `${day}|${e.event}|${e.username}`;
      const r = rows.get(k);
      if (!r) rows.set(k, { day, event: e.event, username: e.username, first: e.time });
      else if (e.time < r.first) r.first = e.time;
    }
    return [...rows.values()];
  }
  /** Login log entries per day and event since `from` (YYYY-MM-DD; the file keeps the last MAX_LOG entries). */
  async logCounts(from) {
    const counts = new Map();
    for (const e of this.data.audit) {
      const day = String(e.time).slice(0, 10);
      if (day < from) continue;
      const k = `${day}|${e.event}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts].map(([k, n]) => ({ day: k.split('|')[0], event: k.split('|')[1], n }));
  }
  /** A sign-up removed, and what it held (null if it was gone already). */
  async takeInterest(id) {
    const row = this.data.interest.find((r) => r.id === id);
    if (!row) return null;
    this.data.interest = this.data.interest.filter((r) => r !== row);
    await this.save();
    return row.data;
  }
  /** One more plan on a sign-up, if it still exists and has fewer than `max`: whether it was added. */
  async appendInterestFile(id, file, max) {
    const row = this.data.interest.find((r) => r.id === id);
    if (!row || row.data.files.length >= max) return false;
    row.data.files.push(file);
    await this.save();
    return true;
  }
  async countInterest() {
    return this.data.interest.length;
  }
  async interestBytes() {
    return this.data.interest.reduce((a, r) => a + r.data.files.reduce((b, f) => b + f.size, 0), 0);
  }
  async addFeedback(entry) {
    const id = ++this.data.feedbackId;
    this.data.feedback.push({ id, at: Date.now(), ...entry });
    this.data.feedback = this.data.feedback.slice(-5000);
    await this.save();
    return id;
  }
  async listFeedback(limit) {
    return this.data.feedback.slice(-limit).reverse().map(({ at, ...row }) => row);
  }
  async deleteFeedback(id) {
    this.data.feedback = this.data.feedback.filter((r) => r.id !== id);
    await this.save();
  }
  /** The addresses go after `days`; the rest stays until the admin deletes it. */
  async pruneFeedbackIps(days) {
    const old = Date.now() - days * 86400_000;
    let n = 0;
    for (const r of this.data.feedback) if (r.at < old && r.ip) delete r.ip, n++;
    if (n) await this.save();
  }
  async addGamenight(data, tokenHash) {
    const id = ++this.data.gamenightId;
    this.data.gamenight.push({ id, data, tokenHash });
    await this.save();
    return id;
  }
  async getGamenight(id) {
    return this.data.gamenight.find((r) => r.id === id) ?? null;
  }
  async listGamenight() {
    return [...this.data.gamenight].reverse().map(({ id, data }) => ({ id, data }));
  }
  async deleteGamenight(id) {
    this.data.gamenight = this.data.gamenight.filter((r) => r.id !== id);
    await this.save();
  }
  /** Every sign-up gone (after the night): how many there were. */
  async clearGamenight() {
    const n = this.data.gamenight.length;
    this.data.gamenight = [];
    await this.save();
    return n;
  }
}

class PgStore {
  constructor(url) {
    this.url = url;
  }
  async init() {
    const { default: pg } = await import('pg');
    this.pool = new pg.Pool({ connectionString: this.url, max: 4 });
    await this.pool.query(`
      create table if not exists audit_log (
        id bigserial primary key,
        at timestamptz not null default now(),
        time_be text not null,
        event text not null,
        username text,
        ip text,
        detail text
      );
      create table if not exists sessions (
        key text primary key,
        username text not null,
        role text not null,
        expires bigint not null
      );
      alter table sessions add column if not exists device text;
      alter table sessions add column if not exists since bigint;
      create table if not exists furniture (
        id serial primary key,
        item text not null,
        x real not null, y real not null, z real not null, yaw real not null,
        by_user text,
        at timestamptz not null default now()
      );
      create table if not exists placed_cars (
        id serial primary key,
        kind text not null,
        x double precision not null, y double precision not null, z double precision not null, yaw double precision not null,
        by_user text,
        at timestamptz not null default now()
      );
      create table if not exists meta (
        key text primary key,
        value text not null
      );
      create table if not exists stats (
        username text primary key,
        kills integer not null default 0,
        deaths integer not null default 0,
        headshots integer not null default 0,
        wins integer not null default 0
      );
      drop table if exists users;
      create table if not exists accounts (
        username text primary key,
        email text not null,
        pass text not null,
        created timestamptz not null default now(),
        seen timestamptz not null default now(),
        disabled boolean not null default false
      );
      create table if not exists zombie_best (
        username text not null,
        place text not null,
        wave integer not null,
        kills integer not null,
        team integer not null,
        at timestamptz not null default now(),
        primary key (username, place)
      );
      -- The admin's runs count too (Yoshi, 8 Nov 2026), and the admin has no account: no tie to accounts; an
      -- account's runs are deleted with it (deleteAccount, pruneAccounts).
      alter table zombie_best drop constraint if exists zombie_best_username_fkey;
      -- An account's lasting access to a code-locked home (server/homes.mjs), made with the code of generation gen:
      -- tied to the account, so it goes when the account goes.
      create table if not exists home_grants (
        username text not null references accounts (username) on delete cascade,
        home text not null,
        gen integer not null,
        at timestamptz not null default now(),
        primary key (username, home)
      );
      create table if not exists daily (
        day text not null,
        key text not null,
        value bigint not null default 0,
        primary key (day, key)
      );
      create table if not exists interest (
        id serial primary key,
        at timestamptz not null default now(),
        data jsonb not null,
        token_hash text not null
      );
      create table if not exists feedback (
        id serial primary key,
        at timestamptz not null default now(),
        data jsonb not null
      );
      create table if not exists gamenight (
        id serial primary key,
        at timestamptz not null default now(),
        data jsonb not null,
        token_hash text not null
      );
      create table if not exists visit_seed (
        day text primary key,
        seed text not null
      );
      create table if not exists visit_seen (
        day text not null,
        hash text not null,
        primary key (day, hash)
      );`);
  }
  async loadSessions(now) {
    await this.pool.query('delete from sessions where expires <= $1', [now]);
    const r = await this.pool.query('select key, username, role, expires, device, since from sessions');
    return r.rows.map((s) => ({ ...s, expires: Number(s.expires), since: s.since === null ? null : Number(s.since) }));
  }
  async saveSession(key, username, role, expires, device = null, since = null) {
    await this.pool.query('insert into sessions (key, username, role, expires, device, since) values ($1, $2, $3, $4, $5, $6)', [key, username, role, expires, device, since]);
  }
  async touchSession(key, expires) {
    await this.pool.query('update sessions set expires = $2 where key = $1', [key, expires]);
  }
  async deleteSession(key) {
    await this.pool.query('delete from sessions where key = $1', [key]);
  }
  async deleteSessionsOf(username) {
    await this.pool.query('delete from sessions where username = $1', [username]);
  }
  async listFurniture() {
    const r = await this.pool.query('select id, item, x, y, z, yaw, by_user as by from furniture order by id');
    return r.rows;
  }
  async addFurniture(f) {
    const r = await this.pool.query('insert into furniture (item, x, y, z, yaw, by_user) values ($1, $2, $3, $4, $5, $6) returning id', [f.item, f.x, f.y, f.z, f.yaw, f.by]);
    return r.rows[0].id;
  }
  async updateFurniture(id, f) {
    await this.pool.query('update furniture set item = $2, x = $3, y = $4, z = $5, yaw = $6, by_user = $7, at = now() where id = $1', [id, f.item, f.x, f.y, f.z, f.yaw, f.by]);
  }
  async deleteFurniture(id) {
    await this.pool.query('delete from furniture where id = $1', [id]);
  }
  async clearFurniture() {
    await this.pool.query('delete from furniture');
  }
  async listCars() {
    const r = await this.pool.query('select id, kind, x, y, z, yaw, by_user as by from placed_cars order by id');
    return r.rows;
  }
  async addCar(c) {
    const r = await this.pool.query('insert into placed_cars (kind, x, y, z, yaw, by_user) values ($1, $2, $3, $4, $5, $6) returning id', [c.kind, c.x, c.y, c.z, c.yaw, c.by]);
    return r.rows[0].id;
  }
  async updateCar(id, c) {
    await this.pool.query('update placed_cars set x = $2, y = $3, z = $4, yaw = $5, by_user = $6, at = now() where id = $1', [id, c.x, c.y, c.z, c.yaw, c.by]);
  }
  async deleteCar(id) {
    await this.pool.query('delete from placed_cars where id = $1', [id]);
  }
  async clearCars() {
    await this.pool.query('delete from placed_cars');
  }
  async getMeta(key) {
    const r = await this.pool.query('select value from meta where key = $1', [key]);
    return r.rows[0]?.value ?? null;
  }
  async setMeta(key, value) {
    await this.pool.query('insert into meta (key, value) values ($1, $2) on conflict (key) do update set value = $2', [key, value]);
  }
  async addStats(username, add) {
    const v = STAT_KEYS.map((k) => add[k] || 0);
    await this.pool.query(
      `insert into stats (username, kills, deaths, headshots, wins) values ($1, $2, $3, $4, $5)
       on conflict (username) do update set kills = stats.kills + $2, deaths = stats.deaths + $3,
       headshots = stats.headshots + $4, wins = stats.wins + $5`,
      [username, ...v]);
  }
  async leaderboard() {
    // Accounts only (Yoshi, 7 Nov 2026): a row left by a hit in the instant an account went, or by the old
    // server during a deploy, never shows.
    const r = await this.pool.query(
      'select username, kills, deaths, headshots, wins from stats where username in (select username from accounts) or username = any($1::text[])',
      [boardNames(this)]);
    return r.rows;
  }
  // ---- Accounts (server/accounts.mjs)
  /** False when the name is taken (the primary key decides, so two sign-ups at once can't both get it). */
  async createAccount(a) {
    const r = await this.pool.query('insert into accounts (username, email, pass) values ($1, $2, $3) on conflict (username) do nothing', [a.username, a.email, a.pass]);
    if (r.rowCount === 1) {
      await this.pool.query('delete from stats where username = $1', [a.username]); // a new account starts at nothing
      await this.pool.query('delete from zombie_best where username = $1', [a.username]); // nor any run left under the name
      await this.pool.query('delete from home_grants where username = $1', [a.username]); // nor a home's access
    }
    return r.rowCount === 1;
  }
  async getAccount(username) {
    const r = await this.pool.query('select username, email, pass, created, seen, disabled from accounts where username = $1', [username]);
    return r.rows[0] ?? null;
  }
  async updateAccount(username, patch) {
    const sets = [];
    const vals = [username];
    if ('pass' in patch) sets.push(`pass = $${vals.push(patch.pass)}`);
    if ('disabled' in patch) sets.push(`disabled = $${vals.push(!!patch.disabled)}`);
    if (patch.seen) sets.push('seen = now()');
    if (!sets.length) return false;
    const r = await this.pool.query(`update accounts set ${sets.join(', ')} where username = $1`, vals);
    return r.rowCount === 1;
  }
  async deleteAccount(username) {
    await this.pool.query('delete from stats where username = $1', [username]);
    await this.pool.query('delete from zombie_best where username = $1', [username]); // its best runs go with it
    await this.pool.query('delete from home_grants where username = $1', [username]); // and its access to the homes (the key would too)
    const r = await this.pool.query('delete from accounts where username = $1', [username]);
    return r.rowCount === 1;
  }
  // ---- Accounts' lasting access to the code-locked homes (server/homes.mjs)
  async listHomeGrants() {
    const r = await this.pool.query('select username, home, gen, at from home_grants where username in (select username from accounts)');
    return r.rows.map((x) => ({ ...x, at: new Date(x.at).toISOString() }));
  }
  /** Only for an account that exists (false otherwise); a second time for the same home: the newer code's generation. */
  async saveHomeGrant(username, home, gen) {
    const r = await this.pool.query(
      `insert into home_grants (username, home, gen) select $1, $2, $3 where exists (select 1 from accounts where username = $1)
       on conflict (username, home) do update set gen = $3, at = now()`,
      [username, home, gen]);
    return r.rowCount === 1;
  }
  async deleteHomeGrants(home, username = null) {
    const r = username === null
      ? await this.pool.query('delete from home_grants where home = $1', [home])
      : await this.pool.query('delete from home_grants where home = $1 and username = $2', [home, username]);
    return r.rowCount;
  }
  async listAccounts() {
    const r = await this.pool.query('select username, email, created, seen, disabled from accounts order by created desc limit 2000');
    return r.rows;
  }
  async pruneAccounts(days) {
    const r = await this.pool.query('delete from accounts where seen < now() - make_interval(days => $1::int) returning username', [days]);
    const gone = r.rows.map((x) => x.username);
    if (gone.length) {
      await this.pool.query('delete from stats where username = any($1)', [gone]);
      await this.pool.query('delete from zombie_best where username = any($1)', [gone]);
      await this.pool.query('delete from home_grants where username = any($1)', [gone]); // gone with the accounts already (the key)
    }
    return gone;
  }
  async statsForAccountsOnly() {
    await this.pool.query('delete from stats where username not in (select username from accounts) and username <> all($1::text[])', [boardNames(this)]);
  }
  async saveZombieRun(username, place, wave, kills, team) {
    // Only a better run replaces the best one there; an account that is gone keeps nothing (the join finds no row).
    const r = await this.pool.query(
      `insert into zombie_best (username, place, wave, kills, team)
       select $1, $2, $3, $4, $5 where exists (select 1 from accounts where username = $1) or $1 = any($6::text[])
       on conflict (username, place) do update set wave = $3, kills = $4, team = $5, at = now()
       where zombie_best.wave < $3 or (zombie_best.wave = $3 and zombie_best.kills < $4)`,
      [username, place, wave, kills, team, boardNames(this)]);
    return r.rowCount === 1;
  }
  /** Best runs whose name is no account and not the admin (one saved as its account went): gone. At start. */
  async zombieBestForAccountsOnly() {
    await this.pool.query('delete from zombie_best where username not in (select username from accounts) and username <> all($1::text[])', [boardNames(this)]);
  }
  /** Only accounts' and the admin's runs, whatever a race left in the table (no foreign key since the admin's count). */
  async zombieBoard(place, limit) {
    const who = '(username in (select username from accounts) or username = any($1::text[]))';
    const r = place
      ? await this.pool.query(`select username, place, wave, kills, team, at from zombie_best where place = $2 and ${who} order by wave desc, kills desc, at asc limit $3`, [boardNames(this), place, limit])
      : await this.pool.query(
        `select * from (select distinct on (username) username, place, wave, kills, team, at from zombie_best where ${who}
         order by username, wave desc, kills desc, at asc) best order by wave desc, kills desc, at asc limit $2`, [boardNames(this), limit]);
    return r.rows;
  }
  async log(e) {
    await this.pool.query('insert into audit_log (time_be, event, username, ip, detail) values ($1, $2, $3, $4, $5)',
      [e.time, e.event, e.username ?? null, e.ip ?? null, e.detail ?? null]);
  }
  async recentLog(limit) {
    const r = await this.pool.query('select time_be as time, event, username, ip, detail from audit_log order by id desc limit $1', [limit]);
    return r.rows;
  }
  async addFeedback(entry) {
    const r = await this.pool.query('insert into feedback (data) values ($1) returning id', [entry]);
    return r.rows[0].id;
  }
  async listFeedback(limit) {
    const r = await this.pool.query('select id, data from feedback order by id desc limit $1', [limit]);
    return r.rows.map(({ id, data }) => ({ id, ...data }));
  }
  async deleteFeedback(id) {
    await this.pool.query('delete from feedback where id = $1', [id]);
  }
  /** The addresses go after `days`; the rest stays until the admin deletes it. */
  async pruneFeedbackIps(days) {
    const r = await this.pool.query("update feedback set data = data - 'ip' where at < now() - make_interval(days => $1::int) and data ? 'ip'", [days]);
    if (r.rowCount) console.log(JSON.stringify({ event: 'feedback_ips_pruned', n: r.rowCount }));
  }
  async addInterest(data, tokenHash) {
    const r = await this.pool.query('insert into interest (data, token_hash) values ($1, $2) returning id', [data, tokenHash]);
    return r.rows[0].id;
  }
  async getInterest(id) {
    const r = await this.pool.query('select id, data, token_hash from interest where id = $1', [id]);
    return r.rows[0] ? { id: r.rows[0].id, data: r.rows[0].data, tokenHash: r.rows[0].token_hash } : null;
  }
  async listInterest() {
    const r = await this.pool.query('select id, data from interest order by id desc');
    return r.rows;
  }
  async updateInterest(id, patch) {
    await this.pool.query('update interest set data = data || $2::jsonb where id = $1', [id, JSON.stringify(patch)]);
  }
  async deleteInterest(id) {
    await this.pool.query('delete from interest where id = $1', [id]);
  }
  /** A day's counts in one statement, so a failed write adds nothing and can be tried again whole. */
  async addDaily(day, counts) {
    const keys = Object.keys(counts);
    if (!keys.length) return;
    await this.pool.query(
      `insert into daily (day, key, value) select $1::text, k, v from unnest($2::text[], $3::bigint[]) as t(k, v)
       on conflict (day, key) do update set value = daily.value + excluded.value`,
      [day, keys, keys.map((k) => counts[k])]);
  }
  async maxDaily(day, key, n) {
    await this.pool.query('insert into daily (day, key, value) values ($1, $2, $3) on conflict (day, key) do update set value = greatest(daily.value, excluded.value)', [day, key, n]);
  }
  async listDaily(from) {
    const r = await this.pool.query('select day, key, value from daily where day >= $1', [from]);
    return r.rows;
  }
  /**
   * The day's seed for the visitor codes (server/stats.mjs): the first one stored for the day wins,
   * so servers that overlap during a redeploy share it.
   */
  async visitSeed(day, fresh) {
    await this.pool.query('insert into visit_seed (day, seed) values ($1, $2) on conflict (day) do nothing', [day, fresh]);
    const r = await this.pool.query('select seed from visit_seed where day = $1', [day]);
    return r.rows[0]?.seed ?? fresh; // gone already: a server past midnight deleted the day as it ended
  }
  /** Whether a visitor code is new on `day`: one statement, so two servers never both count it. */
  async seeVisitor(day, hash) {
    const r = await this.pool.query('insert into visit_seen (day, hash) values ($1, $2) on conflict do nothing', [day, hash]);
    return r.rowCount === 1;
  }
  /** The seeds and the codes of days before `day` deleted (never a later day's, whatever a server's clock says). */
  async forgetVisits(day) {
    await this.pool.query('delete from visit_seed where day < $1', [day]);
    await this.pool.query('delete from visit_seen where day < $1', [day]);
  }
  /** Who played per day: the names in the login log (joined together, started alone, the admin's logins) with their first time that day. */
  async logNames(from) {
    const r = await this.pool.query(
      `select left(time_be, 10) as day, event, username, min(time_be) as first from audit_log
       where left(time_be, 10) >= $1 and event = any($2::text[]) and username is not null and username <> ''
       group by 1, 2, 3`,
      [from, NAMED]);
    return r.rows;
  }
  /** Login log entries per day (its Belgian time's date) and event since `from` (YYYY-MM-DD). */
  async logCounts(from) {
    const r = await this.pool.query('select left(time_be, 10) as day, event, count(*)::int as n from audit_log where left(time_be, 10) >= $1 group by 1, 2', [from]);
    return r.rows;
  }
  /** A sign-up removed in one statement, with what it held at that moment (null if it was gone already). */
  async takeInterest(id) {
    const r = await this.pool.query('delete from interest where id = $1 returning data', [id]);
    return r.rows[0]?.data ?? null;
  }
  /** One more plan on a sign-up, in one statement: only if it still exists and has fewer than `max`. */
  async appendInterestFile(id, file, max) {
    const r = await this.pool.query(
      `update interest set data = jsonb_set(data, '{files}', coalesce(data->'files', '[]'::jsonb) || $2::jsonb)
       where id = $1 and jsonb_array_length(coalesce(data->'files', '[]'::jsonb)) < $3 returning id`,
      [id, JSON.stringify([file]), max]);
    return r.rowCount > 0;
  }
  async countInterest() {
    const r = await this.pool.query('select count(*)::int as n from interest');
    return r.rows[0].n;
  }
  async interestBytes() {
    const r = await this.pool.query("select coalesce(sum((f->>'size')::bigint), 0)::bigint as n from interest, jsonb_array_elements(data->'files') f");
    return Number(r.rows[0].n);
  }
  async addGamenight(data, tokenHash) {
    const r = await this.pool.query('insert into gamenight (data, token_hash) values ($1, $2) returning id', [data, tokenHash]);
    return r.rows[0].id;
  }
  async getGamenight(id) {
    const r = await this.pool.query('select id, data, token_hash from gamenight where id = $1', [id]);
    return r.rows[0] ? { id: r.rows[0].id, data: r.rows[0].data, tokenHash: r.rows[0].token_hash } : null;
  }
  async listGamenight() {
    const r = await this.pool.query('select id, data from gamenight order by id desc');
    return r.rows;
  }
  async deleteGamenight(id) {
    await this.pool.query('delete from gamenight where id = $1', [id]);
  }
  /** Every sign-up gone (after the night): how many there were. */
  async clearGamenight() {
    const r = await this.pool.query('delete from gamenight');
    return r.rowCount;
  }
  /** Entries older than `days` out, and all but the newest `rows` (a flood of failed logins can't fill the database). */
  async pruneLog(days, rows) {
    const old = await this.pool.query('delete from audit_log where at < now() - make_interval(days => $1::int)', [days]);
    const over = await this.pool.query('delete from audit_log where id <= (select max(id) from audit_log) - $1::bigint', [rows]);
    if (old.rowCount || over.rowCount) console.log(JSON.stringify({ event: 'log_pruned', old: old.rowCount, over: over.rowCount }));
  }
}

export async function openStore() {
  const store = process.env.DATABASE_URL
    ? new PgStore(process.env.DATABASE_URL)
    : new FileStore(resolve(import.meta.dirname, '..', '.data', 'store.json'));
  await store.init();
  return store;
}
