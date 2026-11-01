// How popular the game is, for the admin page (web/public/admin/), counted without cookies and
// without keeping anything about a person. One exception, the owner's choice: starting alone goes in
// the login log by the name typed and the address, as joining together does (server/auth.mjs keeps
// the log 90 days; the privacy policy says so). Per day (Belgian date) and per hour of that day,
// only totals are stored:
// - page loads of the game and of the interest page, and distinct visitors: a visitor is a hash
//   of the address (an IPv4 address or IPv6 /64) and the browser's name with a salt that changes
//   every Belgian day. Players are counted the same way, once a day, when the game really starts
//   (the page's beacon), so a bot or a link preview that never runs the page only adds a visitor;
// - games started (by mode, controls, alone or together, language) and minutes played, which the
//   page reports itself (POST /api/stats/beacon: a start, one per minute, an end): only what the
//   player chose in the game, nothing read from the device;
// - the most players at once.
// The day's salt and the day's hashes are kept in the store for that day only (Yoshi, 1 Nov 2026):
// a redeploy restarts the server, and with the salt in memory only, every restart counted everyone
// again. The store keeps a random seed per day; the salt is that seed run through STATS_SECRET (a
// Railway variable of at least 32 random bytes, never in the store), so a copy of the database alone
// can't rebuild anyone's hash. The key is its own random secret on purpose: a salt key made from a
// password would let a database copy test password guesses offline (hash your own address and browser
// name under each guess until it matches a stored hash). A server that starts takes the day's seed
// from the store; the first seed stored for a day wins, so the old and the new server share one while
// Railway overlaps them, and a hash counts once because the store adds it in one statement. When the
// Belgian day turns, the seed and the hashes of the day before are deleted (within a minute; also at
// start), so yesterday's visitors can't be matched to today's or traced back. Without STATS_SECRET
// (local development, or before it is set) nothing is stored: the salt and the hashes stay in memory
// as before, and a restart can count a visitor again. Changing STATS_SECRET during a day changes the
// salt, and that day counts its visitors again from then on.
// Not counted: the admin's own visits and games (any request with the admin's session), browsers
// that ask not to be tracked (Global Privacy Control or Do Not Track), bots by their browser name,
// and pages loaded ahead of time (Sec-Purpose or Purpose: prefetch, prerender).
// Who is playing right now: the players together by name (the game's roster, with each one's ping), and the ones alone
// by the name they typed. Each page makes a random number when it loads and sends it with its reports;
// the server keeps a visit in memory until it has been quiet for 75 seconds, and never stores it.
// Logins and failed attempts per day come from the login log (it keeps 90 days), and so do the
// different players over a period: the distinct names of players together and the names typed by
// players alone. Only those counts leave the server, never the names.
//
// Admin only: GET /api/admin/stats (60 days, with the four periods the page offers), GET
// /api/admin/audit (the log), and GET /api/admin/live, a stream (Server-Sent Events) with today's
// numbers, who is playing, new log lines, a nudge when the sign-ups or the feedback change, and the
// scoreboard (the game's scores, round and game mode, for web/public/admin/scores/). It is built from
// memory every second, and only sent when something changed, so a page left open costs next to
// nothing; the session is checked again every 15 seconds and the stream ends when it's gone.
//
// Totals not yet written wait in memory and go to the store every 20 seconds, in one statement per
// day (all or nothing, so a failed write is kept and tried again whole), and on SIGTERM (server.mjs)
// after the counting still waiting for the store. Two servers each add only what they counted, so
// overlapping servers count nothing twice.
//
// A flood of reports can't inflate the numbers much: per address 20 starts and 240 minutes an hour
// (a household playing together), 60 new visitors or players an hour (each one a row in the store
// for the day), at most 500 visits at once, and only known values count. The one
// typed thing kept is a solo player's name, cleaned to letters, digits and a few signs: at most 20
// log lines an hour per address and 200 an hour in all. Anyone can send a report, so the names are
// as typed, never checked; the cap in all keeps a flood from many addresses from pushing the real
// security lines out of the log (it keeps 20,000 at most).

import { createHash, createHmac, randomBytes } from 'node:crypto';

const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse/i;
const DAYS = 60;
const QUIET = 75_000; // a visit without a report for this long has stopped playing
const WRITE_MS = 20_000; // totals not yet written go to the store this often
const REFRESH_MS = 60_000; // while an admin page is open, today's totals are read back this often (another server may count too)
const HOURLY = ['visitors', 'players', 'starts', 'minutes'];
const HOUR_KEY = /^(visitors|players|starts|minutes)_h(\d\d)$/;
const NAMED = new Set(['join_ok', 'mp_join', 'solo_start', 'login_ok']);

const BE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const hh = (h) => String(h).padStart(2, '0');
/** The Belgian date (YYYY-MM-DD), hour (0 to 23) and time (HH:MM) of a moment. */
export function beClock(t) {
  const p = {};
  for (const x of BE.formatToParts(new Date(t))) p[x.type] = x.value;
  const hour = Number(p.hour) % 24;
  return { day: `${p.year}-${p.month}-${p.day}`, hour, time: `${hh(hour)}:${p.minute}` };
}
/** The date `n` days from `day`, by the calendar: a 23 or 25 hour day can't skip or repeat a date. */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const ONE_OF = (v, list, fallback) => (list.includes(v) ? v : fallback);
// A solo player's name as typed, cleaned for the log: letters, digits, spaces and _ . ' -, at most 20.
const soloName = (v) => {
  const s = typeof v === 'string' ? v.normalize('NFC').replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20) : '';
  return s && s !== 'Guest' ? s : undefined;
};
const MODES = { explore: 'Explore', paintball: 'Paintball', action: 'Action' };
const OPTED_OUT = (req) => req.headers['sec-gpc'] === '1' || req.headers.dnt === '1';
/** A page loaded ahead of time (a prefetch, a prerender, a preview): nobody has looked at it yet. */
const AHEAD = (req) => /prefetch|prerender|preview/i.test([req.headers['sec-purpose'], req.headers.purpose, req.headers['x-purpose'], req.headers['x-moz']].filter(Boolean).join(' '));
const IN = (event) => event === 'join_ok' || event === 'login_ok';
const FAILED = (event) => /failed|limited|blocked/.test(event);
const nameKey = (s) => String(s).normalize('NFC').trim().toLowerCase();

let warned = false;
/**
 * STATS_SECRET as a key: at least 32 bytes in base64url (made with randomBytes), or null. Anything
 * shorter counts as absent. One warning per process, never with the value.
 */
function statsKey(secret) {
  const s = typeof secret === 'string' ? secret.trim() : '';
  const key = /^[A-Za-z0-9_-]+$/.test(s) ? Buffer.from(s, 'base64url') : null;
  if (key && key.length >= 32) return key;
  if (!warned) {
    warned = true;
    console.warn(JSON.stringify({
      event: 'stats_secret_missing',
      detail: s ? 'STATS_SECRET is not 32 or more bytes in base64url: ignored' : 'STATS_SECRET is not set',
      effect: 'visitor codes stay in memory only: a restart can count a visitor again',
    }));
  }
  return null;
}

class Window {
  constructor(ms) {
    this.ms = ms;
    this.map = new Map();
  }
  hit(key, max) {
    const now = Date.now();
    const list = (this.map.get(key) || []).filter((t) => now - t < this.ms);
    const ok = list.length < max;
    if (ok) list.push(now);
    this.map.set(key, list);
    if (this.map.size > 5000) for (const [k, v] of this.map) if (!v.some((t) => now - t < this.ms)) this.map.delete(k);
    return ok;
  }
}

/** A day's stored counts as the admin page reads them: the totals, and the hours as rows of 24 (only on days that have them). */
function shape(counts) {
  const out = {};
  let hours = null;
  for (const [k, v] of Object.entries(counts)) {
    const m = HOUR_KEY.exec(k);
    if (!m) {
      out[k] = Number(v);
      continue;
    }
    hours ||= Object.fromEntries(HOURLY.map((h) => [h, Array(24).fill(0)]));
    hours[m[1]][Number(m[2]) % 24] += Number(v);
  }
  if (hours) out.hours = hours;
  return out;
}

/**
 * Different players by name in the login log's rows, on days `from` to `to` (and, with `until`, a
 * Belgian time, first seen by then). Names are compared without case. The admin's names (their
 * logins) are left out, so Yoshi's own games don't count.
 */
function names(rows, from, to, until) {
  const admin = new Set(rows.filter((r) => r.event === 'login_ok').map((r) => nameKey(r.username)));
  const together = new Set();
  const alone = new Set();
  for (const r of rows) {
    if (r.event === 'login_ok' || r.day < from || r.day > to || (until && r.first > until)) continue;
    const n = nameKey(r.username);
    if (!n || admin.has(n)) continue;
    (r.event === 'solo_start' ? alone : together).add(n);
  }
  return { all: new Set([...together, ...alone]).size, together: together.size, alone: alone.size };
}

export class Stats {
  /**
   * `secret`: STATS_SECRET, kept outside the store, which locks the day's seed; without it nothing
   * about visitors is stored. `now`: the clock, for tests; the server leaves it at Date.now.
   */
  constructor(store, { json, clientKey, game, readJson, isAdmin, log, secret, now = Date.now }) {
    this.store = store;
    this.json = json;
    this.clientKey = clientKey;
    this.game = game;
    this.readJson = readJson;
    this.isAdmin = isAdmin;
    this.log = log; // the login log (server/auth.mjs)
    this.now = now;
    this.key = statsKey(secret); // null: the salt and the hashes stay in memory, nothing is stored
    this.pending = {}; // day -> key -> count not yet written
    this.peaks = {}; // day -> most players at once not yet written
    this.today = { day: this.day(), counts: {} }; // today's totals so far (stored and pending), for the live view
    this.salt = null; // { day, p }: the day's salt, once the store has given the seed
    this.seen = new Set(); // hashes this server has seen today (the store decides for the others)
    this.jobs = new Set(); // counting that waits for the store
    this.nameRows = []; // the login log's names of the last 60 days, for counts only (never sent)
    this.lock = Promise.resolve(); // one write or read-back at a time
    this.forgot = ''; // the day whose earlier seeds and hashes were deleted
    this.refreshedAt = 0;
    this.detailSince = null; // when players and hours were first counted (Belgian time)
    this.starts = new Window(3600_000);
    this.minutes = new Window(3600_000);
    this.soloLog = new Window(3600_000);
    this.soloLogAll = new Window(3600_000);
    this.newPerAddress = new Window(3600_000);
    this.visits = new Map(); // anonymous visit number -> { mode, control, together, lang, since, last }
    this.streams = new Set();
    this.dirty = { stats: true, log: [], signups: false, feedback: false };
    this.lastPlaying = '';
    this.lastBoard = '';
    this.boardAt = 0;
    this.ready = this.start().catch((e) => console.error('stats load failed', String(e)));
    setInterval(() => this.periodic().catch((e) => console.error('stats flush failed', String(e))), WRITE_MS).unref();
    setInterval(() => this.tick(), 1000).unref();
    setInterval(() => this.ping(), 15_000).unref();
  }

  day() {
    return beClock(this.now()).day;
  }

  async start() {
    this.detailSince = await this.store.getMeta('stats_detail_since');
    if (!this.detailSince) {
      const c = beClock(this.now());
      await this.store.setMeta('stats_detail_since', (this.detailSince = `${c.day} ${c.time}`));
    }
    await this.forget();
    await this.refreshToday();
  }

  async periodic() {
    await this.forget();
    if (this.streams.size && this.now() - this.refreshedAt >= REFRESH_MS - 1000) await this.refreshToday();
    else await this.flush();
  }

  /** The seeds and hashes of the days before today out of the store, once the Belgian day has turned. */
  async forget() {
    const d = this.day();
    if (this.forgot === d) return;
    await this.store.forgetVisits(d);
    this.forgot = d;
  }

  /** One write or read-back at a time, so a read-back never misses what is being written. */
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** Everything counted so far, to the store. */
  flush() {
    return this.exclusive(() => this.write());
  }

  async write() {
    const pending = this.pending;
    const peaks = this.peaks;
    this.pending = {};
    this.peaks = {};
    let failed = null;
    for (const [d, keys] of Object.entries(pending)) {
      try {
        await this.store.addDaily(d, keys);
      } catch (e) {
        // Kept for the next write: addDaily is all or nothing, so nothing is added twice.
        const p = (this.pending[d] ||= {});
        for (const [k, n] of Object.entries(keys)) p[k] = (p[k] || 0) + n;
        failed ||= e;
      }
    }
    for (const [d, n] of Object.entries(peaks)) {
      try {
        await this.store.maxDaily(d, 'peak_players', n);
      } catch (e) {
        this.peaks[d] = Math.max(this.peaks[d] || 0, n);
        failed ||= e;
      }
    }
    if (failed) throw failed;
  }

  /**
   * Today's totals read back from the store, plus what is still waiting: the live view then also
   * holds what another server counted (Railway overlaps two during a redeploy).
   */
  refreshToday() {
    return this.exclusive(async () => {
      await this.write().catch((e) => console.error('stats flush failed', String(e)));
      const d = this.day();
      const counts = {};
      for (const r of await this.store.listDaily(d)) if (r.day === d) counts[r.key] = Number(r.value);
      for (const r of await this.store.logCounts(d)) {
        if (r.day !== d) continue;
        if (IN(r.event)) counts.logins = (counts.logins || 0) + Number(r.n);
        if (FAILED(r.event)) counts.failed = (counts.failed || 0) + Number(r.n);
      }
      this.nameRows = await this.store.logNames(addDays(d, -(DAYS - 1)));
      // Anything counted while this was reading is still pending (no write runs meanwhile).
      for (const [k, n] of Object.entries(this.pending[d] || {})) counts[k] = (counts[k] || 0) + n;
      if ((this.peaks[d] || 0) > (counts.peak_players || 0)) counts.peak_players = this.peaks[d];
      if (this.day() === d) this.today = { day: d, counts };
      this.refreshedAt = this.now();
      this.dirty.stats = true;
    });
  }

  /** The live view's copy of today, a new day starting empty. */
  todayCounts() {
    const d = this.day();
    if (this.today.day !== d) this.today = { day: d, counts: {} };
    return this.today.counts;
  }

  /** Counted on day `d` (the Belgian date when it happened). */
  bump(d, key, n = 1) {
    const p = (this.pending[d] ||= {});
    p[key] = (p[key] || 0) + n;
    const t = this.todayCounts();
    if (this.today.day === d) t[key] = (t[key] || 0) + n;
    this.dirty.stats = true;
  }

  /** Counted at all: a browser with a name, not a bot, not asking not to be tracked, not a page loaded ahead of time, not the admin. */
  counts(req) {
    const ua = String(req.headers['user-agent'] || '');
    return !!ua && !BOT.test(ua) && !OPTED_OUT(req) && !AHEAD(req) && !this.isAdmin(req);
  }

  /**
   * The day's salt: the day's seed from the store, run through STATS_SECRET (which isn't in the store).
   * Without STATS_SECRET: a random salt in memory only, and nothing stored.
   */
  saltFor(d) {
    if (this.salt?.day !== d) {
      const fresh = randomBytes(32);
      const p = this.key
        ? this.store.visitSeed(d, fresh.toString('base64url')).then((seed) => createHmac('sha256', this.key).update(`brieltje visitor salt\0${seed}`).digest())
        : Promise.resolve(fresh);
      this.salt = { day: d, p };
      this.seen = new Set();
      p.catch(() => {
        if (this.salt?.p === p) this.salt = null; // the store failed: ask again next time
      });
    }
    return this.salt.p;
  }

  /**
   * Whether this browser is new on day `d` as a `kind` ('game', 'interest' or 'player'). The kind
   * is in the hash, so the store's rows can't be matched to each other. The store decides, so a
   * restart or a second server never counts a browser twice (without STATS_SECRET: this server's
   * memory decides, as before).
   */
  async firstToday(req, d, kind) {
    const salt = await this.saltFor(d);
    const who = createHash('sha256').update(salt).update(`${kind}\0${this.clientKey(req)}\0${String(req.headers['user-agent'] || '')}`)
      .digest('base64url').slice(0, 22);
    if (this.seen.has(who)) return false;
    // At most 60 new browsers an hour from one address (far more than a household, or a mobile network's
    // shared address, brings here): a flood of made-up browser names can't fill the store or the numbers.
    if (!this.newPerAddress.hit(`${kind}:${this.clientKey(req)}`, 60)) return false;
    this.seen.add(who);
    if (!this.key) return true;
    try {
      return await this.store.seeVisitor(d, who);
    } catch (e) {
      this.seen.delete(who); // not counted: the next visit tries again
      throw e;
    }
  }

  track(job) {
    const j = job.catch((e) => console.error('stats count failed', String(e))).finally(() => this.jobs.delete(j));
    this.jobs.add(j);
  }

  /** A page of the site was loaded: `page` is 'game' or 'interest'. */
  view(req, page) {
    if (req.method !== 'GET' || !this.counts(req)) return;
    const c = beClock(this.now());
    this.bump(c.day, `${page}_views`);
    this.track(this.firstToday(req, c.day, page).then((first) => {
      if (!first) return;
      this.bump(c.day, `${page}_visitors`);
      if (page === 'game') this.bump(c.day, `visitors_h${hh(c.hour)}`);
    }));
  }

  /** A line in the login log (server/auth.mjs): today's logins and failures, the names, and the live log. */
  logged(entry) {
    const t = this.todayCounts();
    if (IN(entry.event)) t.logins = (t.logins || 0) + 1;
    if (FAILED(entry.event)) t.failed = (t.failed || 0) + 1;
    // Today's different players for open admin pages (the next read-back replaces the list).
    if (this.streams.size && NAMED.has(entry.event) && entry.username && this.nameRows.length < 50_000) {
      this.nameRows.push({ day: String(entry.time).slice(0, 10), event: entry.event, username: entry.username, first: String(entry.time) });
    }
    this.dirty.log.push(entry);
    this.dirty.stats = true;
  }

  /** The sign-ups changed (server/interest.mjs): open admin pages fetch the list again. */
  signupsChanged() {
    this.dirty.signups = true;
  }

  /** New or deleted feedback (server/feedback.mjs): open admin pages fetch it again. */
  feedbackChanged() {
    this.dirty.feedback = true;
  }

  /** Who is playing now: the players together by name, the ones alone by the name they typed. */
  playing() {
    const now = Date.now();
    for (const [id, v] of this.visits) if (now - v.last > QUIET) this.visits.delete(id);
    const alone = [...this.visits.values()].filter((v) => !v.together)
      .map((v) => ({ name: v.name ?? null, mode: v.mode, control: v.control, lang: v.lang, minutes: Math.floor((now - v.since) / 60_000) }))
      .sort((a, b) => b.minutes - a.minutes);
    // With each player's time there and back to the server (to 5 ms, so the list isn't sent again for every millisecond).
    const ping = (name) => {
      const ms = this.game.pingOf?.(name);
      return typeof ms === 'number' ? Math.round(ms / 5) * 5 : null;
    };
    return { together: this.game.roster().map((p) => ({ ...p, ping: ping(p.name) })), alone };
  }

  /** The most players at once: the admin isn't one of them. */
  peak() {
    const { together, alone } = this.playing();
    const n = together.filter((p) => p.role !== 'admin').length + alone.length;
    if (!n) return;
    const d = this.day();
    if (n > (this.peaks[d] || 0)) this.peaks[d] = n;
    const t = this.todayCounts();
    if (n > (t.peak_players || 0)) {
      t.peak_players = n;
      this.dirty.stats = true;
    }
  }

  /** Today for the live view: the clock, the totals with their hours, and today's different players. */
  todayMessage() {
    const t = this.now();
    const counts = this.todayCounts();
    return { day: this.today.day, now: { ...beClock(t), ms: t }, counts: shape(counts), names: names(this.nameRows, this.today.day, this.today.day) };
  }

  /** Every second: what changed, to every open admin page. */
  tick() {
    this.peak();
    if (!this.streams.size) {
      this.dirty.log = [];
      this.dirty.signups = this.dirty.feedback = false;
      return;
    }
    const playing = this.playing();
    const key = JSON.stringify(playing);
    if (key !== this.lastPlaying) {
      this.lastPlaying = key;
      this.send('playing', playing);
    }
    if (this.dirty.stats) this.send('today', this.todayMessage());
    if (this.dirty.log.length) this.send('log', this.dirty.log);
    if (this.dirty.signups) this.send('signups', {});
    if (this.dirty.feedback) this.send('feedback', {});
    this.dirty = { stats: false, log: [], signups: false, feedback: false };
    // The scoreboard: when the scores or the game change, and every 10 seconds to keep its clocks
    // right (the page counts down by itself in between).
    const board = this.game.board();
    const same = JSON.stringify({ ...board, round: board.round && board.round.winner, mode: { ...board.mode, ms: 0 } });
    if (same !== this.lastBoard || Date.now() - this.boardAt > 10_000) {
      this.lastBoard = same;
      this.boardAt = Date.now();
      this.send('board', board);
    }
  }

  send(event, data, only) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of only ? [only] : this.streams) s.res.write(msg);
  }

  /** Keeps the streams open through proxies, and ends those whose admin session is gone. */
  ping() {
    for (const s of this.streams) {
      if (!this.isAdmin(s.req)) s.res.end();
      else s.res.write(': ping\n\n');
    }
  }

  /** Before the server stops (a redeploy): the counting that waits for the store, then everything written. */
  async close() {
    await Promise.race([Promise.allSettled([...this.jobs]), new Promise((r) => setTimeout(r, 2000))]);
    await this.flush();
    if (Object.keys(this.pending).length || Object.keys(this.peaks).length) await this.flush();
  }

  /** Answers its paths (true), or leaves them (false). */
  async handle(req, res, url, admin) {
    const p = url.pathname;
    if (p === '/api/stats/beacon' && req.method === 'POST') return (await this.beacon(req, res), true);
    if (p === '/api/admin/stats' || p === '/api/admin/audit' || p === '/api/admin/live') {
      if (!admin) return (this.json(res, 403, { error: 'Admin only' }), true);
      if (req.method !== 'GET') return (this.json(res, 405, { error: 'GET only' }, { Allow: 'GET' }), true);
      if (p === '/api/admin/stats') return (await this.report(res), true);
      if (p === '/api/admin/live') return (await this.live(req, res), true);
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500));
      return (this.json(res, 200, { log: await this.store.recentLog(limit) }), true);
    }
    return false;
  }

  async live(req, res) {
    await this.ready;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const s = { req, res };
    this.streams.add(s);
    req.on('close', () => this.streams.delete(s));
    this.send('today', this.todayMessage(), s);
    this.send('playing', this.playing(), s);
    this.send('board', this.game.board(), s);
  }

  async beacon(req, res) {
    const b = await this.readJson(req);
    const who = this.clientKey(req);
    const counted = this.counts(req);
    const id = typeof b.id === 'string' && /^[a-z0-9]{8,16}$/.test(b.id) ? b.id : null;
    const choice = {
      mode: ONE_OF(b.mode, ['explore', 'paintball', 'action'], 'explore'),
      control: ONE_OF(b.control, ['kbm', 'pad', 'touch'], 'kbm'),
      together: b.together === true,
      lang: ONE_OF(b.lang, ['nl', 'en'], 'en'),
    };
    const name = soloName(b.name);
    // Starting alone goes in the login log by the name typed, with the address, like joining together;
    // not for a browser that asks not to be tracked, nor for the admin's own games.
    if (b.e === 'start' && !choice.together && counted && this.soloLog.hit(who, 20) && this.soloLogAll.hit('all', 200)) {
      this.log?.('solo_start', req, { username: name, detail: MODES[choice.mode] });
    }
    const c = beClock(this.now());
    if (b.e === 'end' && id) {
      this.visits.delete(id);
    } else if (!counted) {
      // not counted
    } else if (b.e === 'start' && this.starts.hit(who, 20)) {
      for (const k of ['starts', `starts_${choice.mode}`, `starts_${choice.control}`, choice.together ? 'starts_together' : 'starts_alone', `starts_${choice.lang}`, `starts_h${hh(c.hour)}`]) this.bump(c.day, k);
      // A player: once a day per browser, like a visitor.
      this.track(this.firstToday(req, c.day, 'player').then((first) => {
        if (!first) return;
        this.bump(c.day, 'game_players');
        this.bump(c.day, `players_h${hh(c.hour)}`);
      }));
      if (id && (this.visits.has(id) || this.visits.size < 500)) this.visits.set(id, { ...choice, name, since: Date.now(), last: Date.now() });
    } else if (b.e === 'minute' && this.minutes.hit(who, 240)) {
      this.bump(c.day, 'minutes');
      this.bump(c.day, `minutes_h${hh(c.hour)}`);
      const v = id && this.visits.get(id);
      if (v) Object.assign(v, choice, { last: Date.now() });
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  }

  /**
   * The 60 days (today as the live view counts it), and per period the bounds and what can't be
   * added up from the days: the different players by name, and today's comparison with yesterday
   * until the same time. Sign-ups and feedback are added per day from their own times.
   */
  async report(res) {
    await this.ready;
    await this.refreshToday();
    const t = this.now();
    const c = beClock(t);
    const from = addDays(c.day, -(DAYS - 1));
    const [rows, events, signups, feedback] = await Promise.all([
      this.store.listDaily(from), this.store.logCounts(from), this.store.listInterest(), this.store.listFeedback(5000),
    ]);
    const raw = new Map();
    for (let i = DAYS - 1; i >= 0; i--) raw.set(addDays(c.day, -i), {});
    for (const r of rows) {
      const o = raw.get(r.day);
      if (o) o[r.key] = Number(r.value);
    }
    if (this.today.day === c.day) raw.set(c.day, { ...this.today.counts }); // with what isn't written yet, and today's logins
    const days = new Map([...raw].map(([d, v]) => [d, shape(v)]));
    const add = (d, k, n = 1) => {
      const o = days.get(d);
      if (o) o[k] = (o[k] || 0) + n;
    };
    for (const r of events) {
      if (r.day === c.day && this.today.day === c.day) continue; // in today's counts already
      if (IN(r.event)) add(r.day, 'logins', Number(r.n));
      if (FAILED(r.event)) add(r.day, 'failed', Number(r.n));
    }
    const y = addDays(c.day, -1);
    let signupsPrev = 0;
    for (const s of signups) {
      const at = Date.parse(s.data?.at);
      if (!Number.isFinite(at)) continue;
      const b = beClock(at);
      add(b.day, 'signups');
      if (b.day === y && b.time <= c.time) signupsPrev++;
    }
    for (const f of feedback) {
      const d = String(f.time || '').slice(0, 10);
      if (Number.isInteger(f.stars) && f.stars >= 1 && f.stars <= 5) {
        add(d, 'fb_rated');
        add(d, 'fb_stars', f.stars);
      }
      if (f.comment) add(d, 'fb_comments');
    }
    const periods = {
      today: { from: c.day, to: c.day, prevFrom: y, prevTo: y, until: c.time },
      yesterday: { from: y, to: y, prevFrom: addDays(c.day, -2), prevTo: addDays(c.day, -2) },
      d7: { from: addDays(c.day, -6), to: c.day, prevFrom: addDays(c.day, -13), prevTo: addDays(c.day, -7) },
      d30: { from: addDays(c.day, -29), to: c.day, prevFrom: addDays(c.day, -59), prevTo: addDays(c.day, -30) },
    };
    for (const [k, p] of Object.entries(periods)) {
      p.names = { cur: names(this.nameRows, p.from, p.to), prev: names(this.nameRows, p.prevFrom, p.prevTo, k === 'today' ? `${y} ${c.time}:59` : undefined) };
    }
    periods.today.signupsPrev = signupsPrev;
    this.json(res, 200, {
      now: { ...c, ms: t },
      days: [...days].map(([d, v]) => ({ day: d, ...v })),
      periods,
      playing: this.playing(),
      interest: signups.length,
      since: rows.length ? rows.map((r) => r.day).sort()[0] : null,
      detailSince: this.detailSince || null,
      restartProof: !!this.key, // STATS_SECRET set: the day's codes are kept, so a restart counts nobody again
    });
  }
}
