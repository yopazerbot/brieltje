// Sessions, furniture, fighting stats, the login log, the interest page's sign-ups (server/interest.mjs),
// the daily totals of how much the game is played (server/stats.mjs) with the day's visitor codes
// (kept for that Belgian day only) and players' feedback (server/feedback.mjs).
// Railway: Postgres via DATABASE_URL. Local development without it: a JSON
// file in web/.data/ (not in git).
// Sessions are stored by a hash of their token, never the token itself.

const STAT_KEYS = ['kills', 'deaths', 'headshots', 'wins'];

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MAX_LOG = 500;
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

class FileStore {
  constructor(file) {
    this.file = file;
    this.data = { audit: [], sessions: [], stats: {}, meta: {}, furniture: [], interest: [], interestId: 0, daily: {}, feedback: [], feedbackId: 0, visits: null };
  }
  async init() {
    await mkdir(resolve(this.file, '..'), { recursive: true });
    this.data = { ...this.data, ...JSON.parse(await readFile(this.file, 'utf8').catch(() => '{}')) };
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
  /** `device`: the guest cookie's id of the browser that joined (server/auth.mjs kick), if any. */
  async saveSession(key, username, role, expires, device = null) {
    this.data.sessions.push({ key, username, role, expires, ...(device ? { device } : {}) });
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
  async setMeta(key, value) {
    this.data.meta[key] = value;
    await this.save();
  }
  async addStats(username, add) {
    const row = (this.data.stats[username] ||= { kills: 0, deaths: 0, headshots: 0, wins: 0 });
    for (const k of STAT_KEYS) row[k] += add[k] || 0;
    await this.save();
  }
  async leaderboard() {
    return Object.entries(this.data.stats).map(([username, s]) => ({ username, ...s }));
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
      create table if not exists furniture (
        id serial primary key,
        item text not null,
        x real not null, y real not null, z real not null, yaw real not null,
        by_user text,
        at timestamptz not null default now()
      );
      create table if not exists furniture (
        id serial primary key,
        item text not null,
        x real not null, y real not null, z real not null, yaw real not null,
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
    const r = await this.pool.query('select key, username, role, expires, device from sessions');
    return r.rows.map((s) => ({ ...s, expires: Number(s.expires) }));
  }
  async saveSession(key, username, role, expires, device = null) {
    await this.pool.query('insert into sessions (key, username, role, expires, device) values ($1, $2, $3, $4, $5)', [key, username, role, expires, device]);
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
    const r = await this.pool.query('select username, kills, deaths, headshots, wins from stats');
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
