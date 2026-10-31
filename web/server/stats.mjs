// How popular the game is, for the admin page (web/public/admin/), counted without cookies and
// without keeping anything about a person. One exception, the owner's choice: starting alone goes in
// the login log by the name typed and the address, as joining together does (server/auth.mjs keeps
// the log 90 days; the privacy policy says so). Per day (Belgian date) only totals are stored:
// - page loads of the game and of the interest page, and distinct visitors: a visitor is a hash
//   of the address (an IPv4 address or IPv6 /64) and the browser's name with a random salt that
//   changes every day. The hashes live in memory for that day only; the salt is never stored, so
//   yesterday's visitors can't be matched to today's or traced back;
// - games started (by mode, controls, alone or together, language) and minutes played, which the
//   page reports itself (POST /api/stats/beacon: a start, one per minute, an end): only what the
//   player chose in the game, nothing read from the device;
// - the most players at once.
// Who is playing right now: the players together by name (the game's roster, with each one's ping), and the ones alone
// by the name they typed. Each page makes a random number when it loads and sends it with its reports;
// the server keeps a visit in memory until it has been quiet for 75 seconds, and never stores it.
// A browser that asks not to be tracked (Global Privacy Control or Do Not Track) isn't counted.
// Logins and failed attempts per day come from the login log (it keeps 90 days).
//
// Admin only: GET /api/admin/stats (60 days), GET /api/admin/audit (the log), and
// GET /api/admin/live, a stream (Server-Sent Events) with today's numbers, who is playing, new log
// lines, a nudge when the sign-ups change, and the scoreboard (the game's scores, round and game
// mode, for web/public/admin/scores/). It is built from memory every second, and only sent when
// something changed, so a page left open costs next to nothing; the session is checked again every
// 15 seconds and the stream ends when it's gone.
//
// A flood of reports can't inflate the numbers much: per address 20 starts and 240 minutes an hour
// (a household playing together), at most 500 visits at once, and only known values count. The one
// typed thing kept is a solo player's name, cleaned to letters, digits and a few signs: at most 20
// log lines an hour per address and 200 an hour in all. Anyone can send a report, so the names are
// as typed, never checked; the cap in all keeps a flood from many addresses from pushing the real
// security lines out of the log (it keeps 20,000 at most).

import { createHash, randomBytes } from 'node:crypto';

const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse/i;
const DAYS = 60;
const QUIET = 75_000; // a visit without a report for this long has stopped playing
const day = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' }); // YYYY-MM-DD
const ONE_OF = (v, list, fallback) => (list.includes(v) ? v : fallback);
// A solo player's name as typed, cleaned for the log: letters, digits, spaces and _ . ' -, at most 20.
const soloName = (v) => {
  const s = typeof v === 'string' ? v.normalize('NFC').replace(/[^\p{L}\p{N} _.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20) : '';
  return s && s !== 'Guest' ? s : undefined;
};
const MODES = { explore: 'Explore', paintball: 'Paintball', action: 'Action' };
const OPTED_OUT = (req) => req.headers['sec-gpc'] === '1' || req.headers.dnt === '1';
const IN = (event) => event === 'join_ok' || event === 'login_ok';
const FAILED = (event) => /failed|limited|blocked/.test(event);

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

export class Stats {
  constructor(store, { json, clientKey, game, readJson, isAdmin, log }) {
    this.store = store;
    this.json = json;
    this.clientKey = clientKey;
    this.game = game;
    this.readJson = readJson;
    this.isAdmin = isAdmin;
    this.log = log; // the login log (server/auth.mjs)
    this.pending = {}; // day -> key -> count not yet written
    this.peaks = {}; // day -> most players at once not yet written
    this.today = { day: day(), counts: {} }; // today's totals so far (stored and pending), for the live view
    this.salt = randomBytes(16);
    this.saltDay = day();
    this.seen = new Set();
    this.starts = new Window(3600_000);
    this.minutes = new Window(3600_000);
    this.soloLog = new Window(3600_000);
    this.soloLogAll = new Window(3600_000);
    this.visits = new Map(); // anonymous visit number -> { mode, control, together, lang, since, last }
    this.streams = new Set();
    this.dirty = { stats: true, log: [], signups: false };
    this.lastPlaying = '';
    this.lastBoard = '';
    this.boardAt = 0;
    this.ready = this.loadToday().catch((e) => console.error('stats load failed', String(e)));
    setInterval(() => this.flush().catch((e) => console.error('stats flush failed', String(e))), 60_000).unref();
    setInterval(() => this.tick(), 1000).unref();
    setInterval(() => this.ping(), 15_000).unref();
  }

  /** Today's totals from the store, so the live view starts from what's already counted. */
  async loadToday() {
    const d = day();
    const counts = {};
    for (const r of await this.store.listDaily(d)) if (r.day === d) counts[r.key] = Number(r.value);
    for (const r of await this.store.logCounts(d)) {
      if (r.day !== d) continue;
      if (IN(r.event)) counts.logins = (counts.logins || 0) + Number(r.n);
      if (FAILED(r.event)) counts.failed = (counts.failed || 0) + Number(r.n);
    }
    // Anything counted while this was loading is already in today's counts as pending.
    for (const [k, n] of Object.entries(this.pending[d] || {})) counts[k] = (counts[k] || 0) + n;
    this.today = { day: d, counts };
    this.dirty.stats = true;
  }

  /** The live view's copy of today, a new day starting empty. */
  todayCounts() {
    const d = day();
    if (this.today.day !== d) this.today = { day: d, counts: {} };
    return this.today.counts;
  }

  bump(key, n = 1) {
    const d = day();
    const p = (this.pending[d] ||= {});
    p[key] = (p[key] || 0) + n;
    const t = this.todayCounts();
    t[key] = (t[key] || 0) + n;
    this.dirty.stats = true;
  }

  /** A page of the site was loaded: `page` is 'game' or 'interest'. */
  view(req, page) {
    if (req.method !== 'GET') return;
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || BOT.test(ua) || OPTED_OUT(req)) return;
    const d = day();
    if (d !== this.saltDay) {
      // A new day: a new salt, and yesterday's hashes forgotten.
      this.salt = randomBytes(16);
      this.saltDay = d;
      this.seen.clear();
    }
    this.bump(`${page}_views`);
    const who = createHash('sha256').update(this.salt).update(this.clientKey(req)).update(ua).digest('base64url').slice(0, 16);
    if (!this.seen.has(`${page}:${who}`)) {
      this.seen.add(`${page}:${who}`);
      this.bump(`${page}_visitors`);
    }
  }

  /** A line in the login log (server/auth.mjs): today's logins and failures, and the live log. */
  logged(entry) {
    const t = this.todayCounts();
    if (IN(entry.event)) t.logins = (t.logins || 0) + 1;
    if (FAILED(entry.event)) t.failed = (t.failed || 0) + 1;
    this.dirty.log.push(entry);
    this.dirty.stats = true;
  }

  /** The sign-ups changed (server/interest.mjs): open admin pages fetch the list again. */
  signupsChanged() {
    this.dirty.signups = true;
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

  peak() {
    const { together, alone } = this.playing();
    const n = together.length + alone.length;
    if (!n) return;
    const d = day();
    if (n > (this.peaks[d] || 0)) this.peaks[d] = n;
    const t = this.todayCounts();
    if (n > (t.peak_players || 0)) {
      t.peak_players = n;
      this.dirty.stats = true;
    }
  }

  async flush() {
    const pending = this.pending;
    const peaks = this.peaks;
    this.pending = {};
    this.peaks = {};
    for (const [d, keys] of Object.entries(pending)) await this.store.addDaily(d, keys);
    for (const [d, n] of Object.entries(peaks)) await this.store.maxDaily(d, 'peak_players', n);
  }

  /** Every second: what changed, to every open admin page. */
  tick() {
    this.peak();
    if (!this.streams.size) {
      this.dirty.log = [];
      this.dirty.signups = false;
      return;
    }
    const playing = this.playing();
    const key = JSON.stringify(playing);
    if (key !== this.lastPlaying) {
      this.lastPlaying = key;
      this.send('playing', playing);
    }
    if (this.dirty.stats) this.send('today', { day: this.today.day, counts: this.todayCounts() });
    if (this.dirty.log.length) this.send('log', this.dirty.log);
    if (this.dirty.signups) this.send('signups', {});
    this.dirty = { stats: false, log: [], signups: false };
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

  /** Answers its paths (true), or leaves them (false). */
  async handle(req, res, url, admin) {
    const p = url.pathname;
    if (p === '/api/stats/beacon' && req.method === 'POST') return (await this.beacon(req, res), true);
    if (p === '/api/admin/stats' || p === '/api/admin/audit' || p === '/api/admin/live') {
      if (!admin) return (this.json(res, 403, { error: 'Admin only' }), true);
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
    this.send('today', { day: this.today.day, counts: this.todayCounts() }, s);
    this.send('playing', this.playing(), s);
    this.send('board', this.game.board(), s);
  }

  async beacon(req, res) {
    const b = await this.readJson(req);
    const who = this.clientKey(req);
    const id = typeof b.id === 'string' && /^[a-z0-9]{8,16}$/.test(b.id) ? b.id : null;
    const choice = {
      mode: ONE_OF(b.mode, ['explore', 'paintball', 'action'], 'explore'),
      control: ONE_OF(b.control, ['kbm', 'pad', 'touch'], 'kbm'),
      together: b.together === true,
      lang: ONE_OF(b.lang, ['nl', 'en'], 'en'),
    };
    const name = soloName(b.name);
    // Starting alone goes in the login log by the name typed, with the address, like joining together;
    // not for a browser that asks not to be tracked.
    if (b.e === 'start' && !choice.together && !OPTED_OUT(req) && this.soloLog.hit(who, 20) && this.soloLogAll.hit('all', 200)) {
      this.log?.('solo_start', req, { username: name, detail: MODES[choice.mode] });
    }
    if (OPTED_OUT(req)) {
      // not counted
    } else if (b.e === 'start' && this.starts.hit(who, 20)) {
      this.bump('starts');
      this.bump(`starts_${choice.mode}`);
      this.bump(`starts_${choice.control}`);
      this.bump(choice.together ? 'starts_together' : 'starts_alone');
      this.bump(`starts_${choice.lang}`);
      if (id && (this.visits.has(id) || this.visits.size < 500)) this.visits.set(id, { ...choice, name, since: Date.now(), last: Date.now() });
    } else if (b.e === 'minute' && this.minutes.hit(who, 240)) {
      this.bump('minutes');
      const v = id && this.visits.get(id);
      if (v) Object.assign(v, choice, { last: Date.now() });
    } else if (b.e === 'end' && id) {
      this.visits.delete(id);
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  }

  async report(res) {
    await this.flush();
    const from = day(Date.now() - (DAYS - 1) * 86400_000);
    const rows = await this.store.listDaily(from);
    const events = await this.store.logCounts(from);
    const byDay = new Map();
    for (let i = DAYS - 1; i >= 0; i--) byDay.set(day(Date.now() - i * 86400_000), {});
    for (const r of rows) if (byDay.has(r.day)) byDay.get(r.day)[r.key] = Number(r.value);
    for (const r of events) {
      const d = byDay.get(r.day);
      if (!d) continue;
      if (IN(r.event)) d.logins = (d.logins || 0) + Number(r.n);
      if (FAILED(r.event)) d.failed = (d.failed || 0) + Number(r.n);
    }
    this.json(res, 200, {
      days: [...byDay].map(([d, v]) => ({ day: d, ...v })),
      playing: this.playing(),
      interest: await this.store.countInterest(),
      since: rows.length ? rows.map((r) => r.day).sort()[0] : null,
    });
  }
}
