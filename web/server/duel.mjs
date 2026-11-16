// The Zombies duel of a LAN night (Yoshi, 16 Nov 2026: "For zombies I want the group to be split in 2 as well: blue and
// red, they both get a different room, but at the same location so they are put at an equal challenge and can
// compete." "Zombies place = sparrenhof." "Zombie as long as can survive, or until I stop the game."). Only the host
// starts and stops one, from the programme (server/host.mjs, behind POST /api/host and the admin's session).
//
// - The host's two evening teams, blue and red, each get a host room (server/rooms.mjs hostRoom) at Sparrenhof: a game
//   of its own as a players' room is, but not in the list, not joinable by its id, not counted in the four players'
//   rooms, up to DUEL_PLAYERS. A page never names its duel room: whoever is on a team is put in their team's room by
//   the server, on any connection (route), and pulled out of the open world or a players' room (pull). Anything else a
//   page asks for is refused as before (a room id not in the list: told it is gone).
// - Fair: one seed for both rooms (duelDice): wave n's k-th zombie is the same zombie in both (its kind, runner or not,
//   its speed), and what beaten zombies leave comes from the same dice per wave (not the same drops: which zombie
//   falls when is the play). The horde scales with the players who fight in
//   the room, as every Zombies game does (shared/zombies.mjs waveSize, aliveCap). Both rooms' first wave comes at the
//   same moment, GATHER_MS after the start plus the usual first break.
// - `warmup`: the item's minutes (WARMUP_MINUTES). Who is down comes back when the wave is beaten, as always; a team
//   caught whole starts again at wave 1, its best run counting. Highest wave wins, then the most zombies beaten (of
//   that run).
// - `final`: nobody comes back (not at the wave's end, not helped up, not by reconnecting, not as someone new once the
//   first wave began). When one team is caught, its room has no zombies any more (free to walk about, nobody hurts
//   anyone in it), and the other must pass its mark (its wave, then its zombies beaten) to win: it wins the moment it
//   does, and loses if it is caught first (both out: check). The duel's look holds in both rooms to the end.
// - The host's stop ends both at once, ranked as the warm-up.
// - The end: the result on every page for RESULT_MS (the live line and a chat line), then both rooms close and
//   everyone is back in the open world where they stood, with what they carried (back).
// - The live line on every page in both rooms (and in the open world): each team's wave, in a message of its own
//   ('duel'), made by the server alone from the rooms' own games.
// - The evening's scoreboard: a point for playing, three for the winners, a point per three waves (server/host.mjs).

import { randomInt } from 'node:crypto';
import { ZombieGame } from './zombies.mjs';
import { ZOMBIE } from '../shared/zombies.mjs';
import { arenaOf } from '../shared/arenas.mjs';
import { LOOKS } from './modes.mjs';

export const DUEL_PLAYERS = 20; // in each host room
export const DUEL_KINDS = ['warmup', 'final'];
export const SIDES = ['blue', 'red']; // the host's first two evening teams (server/host.mjs EVENING_TEAMS)
export const PLACE = 'sparrenhof';
export const WARMUP_MINUTES = 10;
export const RESULT_MS = 10_000;
export const GATHER_MS = 5_000; // the rooms fill (every page moves) before both breaks run
const TICK_MS = 250;
const RESEND_MS = 5_000; // the live line again at least this often (the page counts the warm-up's clock down itself)

/**
 * Test only: a shorter minute for the warm-up's clock (tools/dev/duel_ws_check.mjs), from the server's own environment.
 * Never in production (Railway), and nothing a page sends reaches it.
 */
export function minuteMs(env = process.env) {
  if (env.NODE_ENV === 'production' || env.RAILWAY_ENVIRONMENT) return 60_000;
  const v = Number(env.DUEL_TEST_MINUTE_MS);
  return Number.isInteger(v) && v >= 1000 && v < 60_000 ? v : 60_000;
}

/** A small seeded dice (mulberry32): the same seed, the same throws. */
export function dice(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One run's dice from the duel's seed (server/zombies.mjs opts.dice): where zombies come out, and per wave a dice for its
 * zombies and one for what they leave. Made fresh for each room and each run, so both rooms throw the same.
 */
export function duelDice(seed) {
  const of = (k, n) => dice((seed ^ Math.imul(k, 0x9e3779b1) ^ Math.imul(n, 0x85ebca6b)) >>> 0);
  return { places: dice(seed), mix: (wave) => of(1, wave), drops: (wave) => of(2, wave) };
}

/** A run's mark: the wave reached and the zombies beaten in it. */
export function markOf(z) {
  if (!z) return { wave: 0, beaten: 0 };
  let beaten = 0;
  for (const n of Object.values(z.horde.beaten)) beaten += n;
  return { wave: z.horde.wave, beaten };
}

/** Mark `a` passes mark `b`: a higher wave, or the same wave and more zombies beaten. */
export const passes = (a, b) => a.wave > b.wave || (a.wave === b.wave && a.beaten > b.beaten);
const best = (a, b) => (passes(b, a) ? b : a);

export class Duel {
  /** `hub`: server/rooms.mjs (the open world, the rooms, hostRoom). */
  constructor(hub, { minute = minuteMs() } = {}) {
    this.hub = hub;
    this.minute = minute;
    this.state = null;
    /** Name -> { key, weapons }: what a player carried in the open world when the duel took them (back) */
    this.carried = new Map();
    this.timer = setInterval(() => this.tick(Date.now()), TICK_MS);
    this.timer.unref?.();
  }

  get on() {
    return !!this.state;
  }

  /** The duel rooms' games (none when no duel is on). */
  games() {
    return this.state ? SIDES.map((t) => this.state.sides[t].game) : [];
  }

  get host() {
    return this.hub.main.host;
  }

  /**
   * The team `name` plays for in this duel: theirs when it began, else (a newcomer, put on a team by the host: host.joined)
   * the host's blue or red from then on. Kept for the duel: the host moving someone later moves nobody between rooms.
   */
  sideOf(name) {
    const s = this.state;
    if (!s || typeof name !== 'string') return null;
    if (s.members.has(name)) return s.members.get(name);
    const i = this.host?.teamCount === 2 && Object.hasOwn(this.host.teams, name) ? this.host.teams[name] : -1;
    if (i !== 0 && i !== 1) return null;
    s.members.set(name, SIDES[i]);
    return SIDES[i];
  }

  /** Why a duel can't start now ({ error, code }), or null. */
  cannot() {
    const h = this.host;
    if (this.state) return { error: 'A Zombies duel is on already', code: 'duelOn' };
    if (!h || h.teamCount !== 2) return { error: 'The Zombies duel needs two teams for the evening', code: 'duelTeams' };
    const count = [0, 0];
    for (const g of this.hub.games()) for (const n of g.players.keys()) if (h.teams[n] === 0 || h.teams[n] === 1) count[h.teams[n]]++;
    if (!count[0] || !count[1]) return { error: 'Both teams need someone playing', code: 'duelEmpty' };
    if (count[0] > DUEL_PLAYERS || count[1] > DUEL_PLAYERS) return { error: `At most ${DUEL_PLAYERS} in a team for the Zombies duel`, code: 'duelTooMany', args: { n: DUEL_PLAYERS } };
    return null;
  }

  /**
   * The host starts a duel (server/host.mjs, an entry it checked: `duel` one of DUEL_KINDS, `minutes`, `look`). Both rooms
   * open, everyone on a team is moved in (pull), and both first waves come at the same moment.
   */
  start(e, by, now = Date.now()) {
    const why = this.cannot();
    if (why) return why;
    const kind = DUEL_KINDS.includes(e?.duel) ? e.duel : 'warmup';
    const minutes = kind === 'warmup' ? (Number.isInteger(e.minutes) && e.minutes >= 1 && e.minutes <= 30 ? e.minutes : WARMUP_MINUTES) : null;
    const arena = arenaOf(PLACE);
    const members = new Map();
    for (const [n, i] of Object.entries(this.host.teams)) if (i === 0 || i === 1) members.set(n, SIDES[i]);
    const sides = {};
    for (const t of SIDES) {
      const { id, game } = this.hub.hostRoom(t, arena, DUEL_PLAYERS);
      game.room.look = LOOKS.includes(e.look) ? e.look : null; // to the duel's end: out, and in its result (game.mjs shownRules)
      sides[t] = { team: t, id, game, z: null, runs: 0, best: { wave: 0, beaten: 0 }, out: null, outAt: 0, players: new Set() };
    }
    this.state = {
      kind, minutes, look: LOOKS.includes(e.look) ? e.look : null, by, arena, seed: randomInt(0, 2 ** 32), started: now,
      until: minutes ? now + GATHER_MS + minutes * this.minute : Infinity, phase: 'playing', doneAt: 0, winner: null, members, sides, sent: '', sentAt: 0,
    };
    for (const t of SIDES) this.run(sides[t], now, now + GATHER_MS + ZOMBIE.firstBreak);
    const line = kind === 'warmup'
      ? [`Zombies duel, warm-up: ${minutes} minutes. Blue and red each get a room at Sparrenhof, with the same waves. The highest wave wins.`, 'duelWarmup', { n: minutes }]
      : ['Zombies duel, the final: nobody comes back. When one team is out, the other must pass its wave to win.', 'duelFinal', {}];
    for (const g of this.hub.games()) g.broadcast({ t: 'system', text: line[0], code: line[1], args: line[2] });
    this.hub.main.auth.log('duel_started', null, { username: by, detail: `${kind}${minutes ? ` ${minutes} min` : ''}` });
    this.pull();
    this.send(now, true);
    return { ok: true };
  }

  /**
   * A new run of the horde in side `s`'s room, with the duel's dice: the first (its break to `until`, the same moment in
   * both rooms), or after the team was caught in the warm-up (everyone there back at the start with the pistol).
   */
  run(s, now, until = null) {
    const g = s.game;
    const st = this.state;
    const old = g.modes.state;
    if (old.kind === 'zombies' && old.z) old.z.stop();
    const hooks = { final: st.kind === 'final', over: (z, t) => this.over(s, z, t), downed: (z, name) => this.downed(s, z, name) };
    const names = [...g.players.keys()];
    const z = new ZombieGame(g, g.modes, names, now, st.arena, { dice: duelDice(st.seed), duel: hooks });
    if (until) z.horde.until = until;
    g.modes.state = { kind: 'zombies', phase: z.phase, until: z.horde.until, z, look: st.look };
    g.roundOver = null;
    if (names.length) {
      g.gather(names, st.arena, false, 'hp');
      g.pistolsOnly();
    }
    s.z = z;
    s.runs++;
    g.modes.send();
  }

  /** Side `s`'s room: everyone who fights there is down (server/zombies.mjs over). */
  over(s, z, now) {
    const st = this.state;
    if (!st || st.phase !== 'playing' || s.z !== z) return;
    const mark = markOf(z);
    s.best = best(s.best, mark);
    const g = s.game;
    if (st.kind === 'warmup') {
      this.run(s, now);
      g.modes.say(`${cap(s.team)} was caught at wave ${mark.wave}. Back to wave 1; the best wave (${s.best.wave}) counts.`, 'duelAgain', { team: s.team, n: mark.wave, best: s.best.wave });
      return this.send(now, true);
    }
    this.out(s, mark, now);
  }

  /** In the final, side `s` is out with `mark`: its room without zombies, both rooms told, perhaps the end. */
  out(s, mark, now) {
    const st = this.state;
    s.out = mark;
    s.outAt = now;
    s.best = best(s.best, mark);
    s.z?.keep(now); // its run on the boards (kept once: over() did when they were caught)
    const g = s.game;
    if (g.modes.state.kind === 'zombies') g.modes.state.z?.stop();
    g.modes.state = { kind: 'free' };
    g.gunsBack();
    g.modes.send();
    const other = st.sides[SIDES[1 - SIDES.indexOf(s.team)]];
    g.modes.say(`Your team is out at wave ${mark.wave} with ${mark.beaten} zombies beaten. Now the others must pass that.`, 'duelOutUs', { n: mark.wave, k: mark.beaten });
    if (!other.out) other.game.modes.say(`${cap(s.team)} is out at wave ${mark.wave} with ${mark.beaten} zombies beaten. Pass that to win!`, 'duelOutThem', { team: s.team, n: mark.wave, k: mark.beaten });
    this.check(now);
    this.send(now, true);
  }

  /** In the final, `name` went down: they are out for good (their page told why it doesn't count down). */
  downed(s, z, name) {
    if (!z.duel?.final) return;
    const p = s.game.players.get(name);
    if (p) s.game.send(p.ws, { t: 'system', text: "You're out for this final. Your team plays on.", code: 'duelDown' });
  }

  /**
   * The final: one team out, the other past its mark (it wins), or caught too. Both out: the team out second wins if its
   * mark passes the first's (it passed it, and was caught within the same quarter second), else the first wins; out at
   * the same moment, the higher mark wins and the same mark is a draw.
   */
  check(now) {
    const st = this.state;
    if (!st || st.kind !== 'final' || st.phase !== 'playing') return;
    const [a, b] = SIDES.map((t) => st.sides[t]);
    if (a.out && b.out) {
      if (a.outAt === b.outAt) return this.end(passes(a.out, b.out) ? a.team : passes(b.out, a.out) ? b.team : 'draw', now);
      const [first, second] = a.outAt < b.outAt ? [a, b] : [b, a];
      return this.end(passes(second.out, first.out) ? second.team : first.team, now);
    }
    const out = a.out ? a : b.out ? b : null;
    if (!out) return;
    const on = out === a ? b : a;
    if (on.z && passes(markOf(on.z), out.out)) this.end(on.team, now);
  }

  /** The host's stop (server/host.mjs): both rooms end at once, ranked as the warm-up. False when none is on. */
  stop(by, now = Date.now()) {
    if (!this.state || this.state.phase !== 'playing') return false;
    this.hub.main.auth.log('duel_stopped', null, { username: by });
    this.end(this.rank(), now);
    return true;
  }

  /** Each side's mark for the ranking: its best run (its current one too), or where it went out. */
  markFor(s) {
    return s.out ?? best(s.best, markOf(s.z));
  }

  /** The warm-up's ranking (and the host's stop): the higher mark wins; the same mark is a draw. */
  rank() {
    const [a, b] = SIDES.map((t) => this.markFor(this.state.sides[t]));
    return passes(a, b) ? 'blue' : passes(b, a) ? 'red' : 'draw';
  }

  /** The duel is decided: `winner` 'blue', 'red' or 'draw'. The zombies go; the result shows for RESULT_MS. */
  end(winner, now) {
    const st = this.state;
    if (!st || st.phase !== 'playing') return;
    const marks = Object.fromEntries(SIDES.map((t) => [t, this.markFor(st.sides[t])]));
    st.phase = 'done';
    st.doneAt = now;
    st.winner = winner;
    for (const t of SIDES) {
      const s = st.sides[t];
      for (const n of s.game.players.keys()) s.players.add(n);
      if (!s.out) s.z?.keep(now); // the run on the boards, ended by the clock, the host's stop or the final won
      if (s.game.modes.state.kind === 'zombies') {
        s.game.modes.state.z?.stop();
        s.game.modes.state = { kind: 'free' };
        s.game.gunsBack();
        s.game.modes.send();
      }
    }
    const [w, l] = winner === 'red' ? ['red', 'blue'] : ['blue', 'red'];
    const line = winner === 'draw'
      ? [`The Zombies duel is a draw: wave ${marks.blue.wave} each.`, 'duelDraw', { a: marks.blue.wave }]
      : [`${cap(w)} wins the Zombies duel: wave ${marks[w].wave} against ${marks[l].wave}.`, 'duelWon', { team: w, a: marks[w].wave, b: marks[l].wave }];
    for (const g of this.hub.games()) g.broadcast({ t: 'system', text: line[0], code: line[1], args: line[2] });
    // The evening's scoreboard: everyone who played in each room, a point per three waves of their team's mark.
    const h = this.host;
    if (h) {
      const won = [];
      for (const t of SIDES) {
        const names = [...st.sides[t].players];
        if (winner === t) won.push(...names);
        h.award(names, winner === t ? names : [], h.wavePoints(marks[t].wave));
      }
      h.history.push({ kind: 'duel', at: now, winners: won });
      if (h.history.length > 50) h.history.shift();
    }
    this.hub.main.auth.log('duel_ended', null, { username: st.by, detail: `${st.kind} ${winner} ${marks.blue.wave}-${marks.red.wave}` });
    this.send(now, true);
  }

  /** The result has shown: both rooms close, and every page in them goes back to the open world (where it stood). */
  close() {
    const st = this.state;
    if (!st) return;
    this.state = null; // first: a page reconnecting now goes to the open world
    for (const t of SIDES) this.hub.dropHostRoom(st.sides[t].id, st.sides[t].game);
    for (const g of this.hub.games()) g.broadcast({ t: 'duel', duel: null });
  }

  /**
   * The game a page of `session` plays in while a duel is on: its team's room, whatever the page asked for. Null: not in
   * the duel (no duel, not on a team), or kept outside by the host's locked doors (the open world refuses it then).
   */
  route(session) {
    if (!this.state || !session || typeof session.username !== 'string') return null;
    const side = this.sideOf(session.username);
    if (!side) return null;
    if (this.host?.shut(session)) return null;
    return this.state.sides[side].game;
  }

  /**
   * Everyone on a team who plays anywhere else (the open world, a players' room) is moved: their connection there ends
   * (4006, the duel's own close), their page connects again at once and route() puts it in their team's room. Their place
   * in the open world is kept by its leaving (game.mjs lastPos), the guns they carried here (back), their seat in a car
   * or a helicopter given up as on any leaving.
   */
  pull() {
    const st = this.state;
    if (!st || st.phase !== 'playing') return;
    const mine = new Set(this.games());
    for (const g of this.hub.games()) {
      if (mine.has(g)) continue;
      for (const [name, p] of g.players) {
        if (p.pulled || !this.sideOf(name)) continue;
        p.pulled = true;
        if (g === this.hub.main && p.weapons) this.carried.set(name, { key: p.key, weapons: [...p.weapons] });
        p.ws.close(4006, 'To the Zombies duel'); // src/net/client.ts: again at once, no "room closed" line
      }
    }
  }

  /**
   * `name` joined `game` (server/rooms.mjs joined, before its welcome). Back in the open world from a duel: put where the
   * open world had them (their page is still at Sparrenhof: told by a respawn there, as the host's bring does, not a
   * death), with the guns they carried. In a duel room: the live line after the welcome.
   */
  joined(name, game) {
    const c = this.carried.get(name);
    const p = game.players.get(name);
    if (game === this.hub.main && c && p && !this.sideOf(name)) {
      this.carried.delete(name);
      setImmediate(() => this.back(name, p, c));
    }
    if (this.state && game !== this.hub.main && this.games().includes(game) && !c) this.carried.set(name, { key: p?.key, weapons: null });
    for (const t of SIDES) if (this.state?.sides[t].game === game) this.state.sides[t].players.add(name);
    if (!this.state) return;
    // After the welcome (which clears the page's line): this game's line.
    setImmediate(() => {
      const q = game.players.get(name);
      if (q && this.state) game.send(q.ws, { t: 'duel', duel: this.view() });
    });
  }

  /** `name` (player `p`) is back in the open world after a duel: where it had them, with the guns they carried (`c`). */
  back(name, p, c) {
    const g = this.hub.main;
    if (g.players.get(name) !== p || !p.state) return; // gone again already
    const { x, y, z } = p.state;
    g.respawn(name, p, Date.now(), { spawn: 0, x: +x.toFixed(2), y, z: +z.toFixed(2), face: [x, z + 1] });
    if (c.weapons && c.key === p.key && !g.modes.zombies) {
      p.weapons = new Set(c.weapons);
      g.send(p.ws, { t: 'weapons', list: [...p.weapons] });
    }
  }

  /** The live line: each team's wave (its best in the warm-up, its mark when out), the clock, the winner. */
  view(now = Date.now()) {
    const st = this.state;
    if (!st) return null;
    return {
      kind: st.kind, phase: st.phase,
      ms: st.phase === 'done' ? Math.max(0, st.doneAt + RESULT_MS - now) : Number.isFinite(st.until) ? Math.max(0, st.until - now) : 0,
      sides: SIDES.map((t) => {
        const s = st.sides[t];
        const m = s.out ?? markOf(s.z);
        return { team: t, wave: m.wave, beaten: m.beaten, best: Math.max(s.best.wave, m.wave), out: !!s.out, players: s.game.players.size };
      }),
      ...(st.winner ? { winner: st.winner } : {}),
    };
  }

  /** The line to every page in both rooms and the open world, when it changed (or every RESEND_MS). */
  send(now, force = false) {
    const st = this.state;
    if (!st) return;
    const v = this.view(now);
    const key = JSON.stringify({ ...v, ms: 0 });
    if (!force && key === st.sent && now - st.sentAt < RESEND_MS) return;
    st.sent = key;
    st.sentAt = now;
    for (const g of this.hub.games()) g.broadcast({ t: 'duel', duel: v });
  }

  /** Four times a second: the moves, the clock, a room whose game went (everyone gone), the final's mark, the line. */
  tick(now) {
    const st = this.state;
    if (!st) return;
    if (st.phase === 'done') {
      if (now >= st.doneAt + RESULT_MS) this.close();
      return;
    }
    this.pull();
    for (const t of SIDES) {
      const s = st.sides[t];
      if (s.out || (s.z && s.game.modes.state.z === s.z)) continue;
      // The room's game stopped by itself (everyone in it gone for a while: modes.mjs tick).
      if (st.kind === 'final' && s.z) this.out(s, markOf(s.z), now);
      else if (st.kind === 'warmup' && s.game.players.size) {
        s.best = best(s.best, markOf(s.z));
        this.run(s, now);
      }
      if (!this.state || st.phase !== 'playing') return;
    }
    if (st.kind === 'warmup' && now >= st.until) return this.end(this.rank(), now);
    this.check(now);
    if (st.phase === 'playing') this.send(now);
  }
}

const cap = (t) => t[0].toUpperCase() + t.slice(1);
