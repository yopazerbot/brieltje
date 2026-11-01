// Games the admin starts from the menu: hide and seek, tag, a treasure hunt, and two teams
// (the house against the bungalow). The server keeps the game: who seeks or is "it", the clock,
// the coins, the teams and their score, and it checks every tag and every coin against where
// the players really are. No fighting during the party games; in the teams game only between
// the teams.

import { readFileSync } from 'node:fs';

const HIDE_MS = 30_000; // the seeker counts with eyes shut
const SEEK_MS = 180_000;
const TAG_MS = 180_000;
const HUNT_MS = 240_000;
const DONE_MS = 10_000; // the result stays up this long
const TAG_REACH = 1.8; // m, how close you must be to tag someone
const FIND_REACH = 2.2; // m, a seeker finding a hider
const COIN_REACH = 1.3; // m, picking up a coin
const NO_TAG_BACK_MS = 3000;
const COINS = 15;
const TEAMS_MS = 600_000;
const SWITCH_MS = 15_000; // at most one team switch this often
export const TEAM_GOAL = 25; // kills of the other team that win the teams game
export const TEAM_NAMES = { house: 'House', bungalow: 'Bungalow' };
export const TEAM_COLORS = { house: '#4fa3e0', bungalow: '#ff9f43' };
export const KINDS = { hide: 'Hide and seek', tag: 'Tag', treasure: 'Treasure hunt', teams: 'House against bungalow' };

// Where coins can lie: inside the rooms of the house (from the house data) and a few places outside.
const HOUSE = JSON.parse(readFileSync(new URL('../src/data/house.json', import.meta.url), 'utf8'));
const OUTSIDE = [[2.2, -0.05, 15.6], [6.5, -0.05, -1.4], [4.5, -0.05, -8], [8.5, -0.05, -15], [0.6, -0.05, -12], [10.8, -0.05, 6], [-1.6, -0.05, 4], [5.9, 3.06, -1.6]];

/**
 * A table keyed by player names, without the keys every object has: a player called "constructor"
 * or "__proto__" (both fit the name rules) scores like anyone else.
 */
const byName = (entries = []) => Object.assign(Object.create(null), Object.fromEntries(entries));

function inside(x, z, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** A random spot in a room, at least 0.5 m from its walls (tried a few times). */
function spotIn(room) {
  const ring = room.p[0];
  const xs = ring.map((v) => v[0]);
  const zs = ring.map((v) => v[1]);
  const floor = HOUSE.levels.find((l) => l.id === room.level)?.floor ?? 0;
  for (let k = 0; k < 30; k++) {
    const x = Math.min(...xs) + Math.random() * (Math.max(...xs) - Math.min(...xs));
    const z = Math.min(...zs) + Math.random() * (Math.max(...zs) - Math.min(...zs));
    const clear = [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].every(([dx, dz]) => inside(x + dx, z + dz, ring));
    if (clear) return [x, floor + 0.05, z];
  }
  return null;
}

export class Modes {
  constructor(game) {
    this.game = game;
    this.state = { kind: 'free' };
  }

  get active() {
    return this.state.kind !== 'free';
  }

  /** A party game is on: nobody fights (the teams game is a fight). */
  get peaceful() {
    return this.active && this.state.kind !== 'teams';
  }

  /** In the teams game: the player's team ('house' or 'bungalow'), else null. */
  teamOf(name) {
    return this.state.kind === 'teams' ? this.state.teams[name] ?? null : null;
  }

  /** Two players on the same team: they can't hurt each other. */
  friends(a, b) {
    const t = this.teamOf(a);
    return !!t && t === this.teamOf(b);
  }

  /** The team with fewer players here now (the house when even). */
  smaller() {
    const n = { house: 0, bungalow: 0 };
    for (const t of Object.values(this.here(this.state.teams))) n[t]++;
    return n.bungalow < n.house ? 'bungalow' : 'house';
  }

  /** Of a table by player names, the players here now (those away keep their part for when they're back). */
  here(table) {
    return byName(Object.entries(table).filter(([n]) => this.game.players.has(n)));
  }

  /**
   * A player picks a team. Waiting to respawn: they will at its house. Alive: they start again
   * there at once, but only at full health and once in SWITCH_MS (a switch must not heal anyone
   * or bring them back early). Waiting, at most one switch a second: each one is a line in
   * everyone's chat, and a page sending forty a second would flood it.
   */
  choose(name, team) {
    const s = this.state;
    const p = this.game.players.get(name);
    if (s.kind !== 'teams' || s.phase !== 'playing' || !p || typeof team !== 'string' || !Object.hasOwn(TEAM_NAMES, team) || s.teams[name] === team) return;
    const now = Date.now();
    const since = now - (s.switched[name] ?? -Infinity);
    if (!p.alive && since < 1000) return;
    if (p.alive && (p.hp < this.game.fullHealth || since < SWITCH_MS)) {
      return this.game.send(p.ws, { t: 'system', text: 'Switch teams at full health (at most every 15 seconds), or while you wait to come back', code: 'teamWait' });
    }
    s.teams[name] = team;
    s.switched[name] = now;
    this.say(`${name} joined team ${TEAM_NAMES[team]}`, 'teamJoined', { name, team });
    this.game.teamsChanged([name], p.alive);
    this.send();
  }

  /** A kill in the teams game: a point for the killer's team, unless it was their own. */
  scored(killer, victim) {
    const s = this.state;
    if (s.kind !== 'teams' || s.phase !== 'playing') return;
    const team = s.teams[killer];
    if (!team || team === s.teams[victim]) return;
    s.score[team]++;
    if (s.score[team] >= TEAM_GOAL) this.finish(`Team ${TEAM_NAMES[team]} wins, ${s.score.house} to ${s.score.bungalow}`, 'teamWon', { team, ...s.score });
    else this.send();
  }

  /** What every browser gets: the game, the phase and its time left, roles and scores (seekers and teams of the players here). */
  view(now = Date.now()) {
    const s = this.state;
    if (s.kind === 'free') return { kind: 'free' };
    return {
      kind: s.kind, phase: s.phase, ms: Math.max(0, s.until - now), title: KINDS[s.kind],
      seekers: s.seekers ? [...s.seekers].filter((n) => this.game.players.has(n)) : undefined, it: s.it, times: s.times, coins: s.coins, counts: s.counts,
      result: s.result, resultCode: s.resultCode, resultArgs: s.resultArgs,
      teams: s.teams && this.here(s.teams), score: s.score, goal: s.kind === 'teams' ? TEAM_GOAL : undefined,
    };
  }

  send() {
    this.game.broadcast({ t: 'mode', mode: this.view() });
  }

  /**
   * A line for everyone's chat: the English `text`, and its `code` and `args` (player names,
   * numbers, a team, a game, lists of names) for a page in another language (src/i18n.ts).
   */
  say(text, code, args) {
    this.game.broadcast({ t: 'system', text, code, args });
  }

  names() {
    return [...this.game.players.keys()];
  }

  pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  /** The admin starts a game (or 'free' to stop one). */
  start(kind, by) {
    const now = Date.now();
    if (kind === 'free') {
      if (!this.active) return;
      const teams = this.state.kind === 'teams';
      this.state = { kind: 'free' };
      if (teams) this.game.teamsChanged(this.names(), false);
      this.send();
      this.say(`${by} stopped the game`, 'gameStopped', { name: by });
      return;
    }
    if (!Object.hasOwn(KINDS, kind)) return;
    const names = this.names();
    if (names.length < 2 && kind !== 'treasure') return this.say(`${KINDS[kind]} needs at least two players`, 'needTwo', { kind });
    const fromTeams = this.state.kind === 'teams' && kind !== 'teams';
    if (kind === 'hide') {
      // `players`: who took part, so someone back after a dropped connection plays on as before (see join).
      const seeker = this.pick(names);
      this.state = { kind, phase: 'hiding', until: now + HIDE_MS, seekers: new Set([seeker]), first: seeker, players: new Set(names) };
      this.say(`${by} started hide and seek: ${seeker} seeks. Hide! (30 seconds)`, 'hideStarted', { name: by, seeker });
    } else if (kind === 'teams') {
      // Everyone on a team, the teams as even as can be (in random order); each starts at its house.
      const teams = byName();
      for (const n of [...names].sort(() => Math.random() - 0.5)) {
        const count = Object.values(teams).filter((t) => t === 'house').length;
        teams[n] = count <= Object.keys(teams).length - count ? 'house' : 'bungalow';
      }
      this.state = { kind, phase: 'playing', until: now + TEAMS_MS, teams, score: { house: 0, bungalow: 0 }, switched: byName() };
      this.say(`${by} started House against bungalow: first team to ${TEAM_GOAL} kills. Switch teams in the menu (Together).`, 'teamsStarted', { name: by, n: TEAM_GOAL });
      this.game.roundOver = null; // the teams' score counts now
      this.game.teamsChanged(names);
    } else if (kind === 'tag') {
      const it = this.pick(names);
      this.state = { kind, phase: 'playing', until: now + TAG_MS, it, last: null, lastAt: 0, times: byName(names.map((n) => [n, 0])) };
      this.say(`${by} started tag: ${it} is it. The least time as "it" wins.`, 'tagStarted', { name: by, it });
    } else {
      const rooms = HOUSE.rooms.filter((r) => r.p?.[0]?.length >= 3);
      const spots = [...OUTSIDE];
      for (let k = 0; spots.length < COINS * 3 && k < 200; k++) {
        const s = spotIn(this.pick(rooms));
        if (s) spots.push(s);
      }
      const coins = [];
      while (coins.length < COINS && spots.length) {
        const [x, y, z] = spots.splice(Math.floor(Math.random() * spots.length), 1)[0];
        coins.push({ i: coins.length, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) });
      }
      this.state = { kind, phase: 'playing', until: now + HUNT_MS, coins, counts: byName(names.map((n) => [n, 0])) };
      this.say(`${by} started a treasure hunt: ${COINS} coins in and around the house`, 'huntStarted', { name: by, n: COINS });
    }
    // Straight from the teams game to another one: everyone back in their own colours.
    if (fromTeams) this.game.teamsChanged(names, false);
    this.send();
  }

  near(a, b, reach) {
    const p = this.game.players.get(a)?.state;
    const q = this.game.players.get(b)?.state;
    return !!p && !!q && Math.hypot(p.x - q.x, p.z - q.z) <= reach && Math.abs(p.y - q.y) < 1.5;
  }

  /** A player tags another (hide and seek: a seeker finds a hider; tag: "it" passes it on). */
  tag(name, target) {
    const s = this.state;
    const now = Date.now();
    if (typeof target !== 'string' || target === name || !this.game.players.has(target)) return;
    if (s.kind === 'hide' && s.phase === 'seeking' && s.seekers.has(name) && !s.seekers.has(target) && this.near(name, target, FIND_REACH)) {
      s.seekers.add(target);
      const left = this.names().filter((n) => !s.seekers.has(n));
      this.say(`${name} found ${target}${left.length ? ` (${left.length} still hidden)` : ''}`, left.length ? 'foundLeft' : 'found', { name, target, n: left.length });
      if (!left.length) this.finish('The seekers found everyone!', 'foundAll');
      else this.send();
    } else if (s.kind === 'tag' && s.phase === 'playing' && s.it === name && this.near(name, target, TAG_REACH)) {
      if (target === s.last && now - s.lastAt < NO_TAG_BACK_MS) return; // no tagging straight back
      s.last = name;
      s.lastAt = now;
      s.it = target;
      this.say(`${name} tagged ${target}: ${target} is it`, 'tagged', { name, target });
      this.send();
    }
  }

  /** A player picks up a coin (if they are really next to it). */
  coin(name, i) {
    const s = this.state;
    const p = this.game.players.get(name)?.state;
    if (s.kind !== 'treasure' || s.phase !== 'playing' || !p || !Number.isInteger(i)) return;
    const c = s.coins.find((q) => q.i === i);
    if (!c || Math.hypot(p.x - c.x, p.z - c.z) > COIN_REACH || Math.abs(p.y - c.y) > 1.6) return;
    s.coins = s.coins.filter((q) => q !== c);
    s.counts[name] = (s.counts[name] || 0) + 1;
    if (!s.coins.length) this.huntOver();
    else this.send();
  }

  huntOver() {
    const counts = this.state.counts;
    const best = Math.max(0, ...Object.values(counts));
    const winners = Object.keys(counts).filter((n) => counts[n] === best && best > 0);
    if (winners.length) this.finish(`${winners.join(' and ')} found the most coins (${best})`, 'huntWon', { names: winners, n: best });
    else this.finish('Nobody found a coin', 'huntNone');
  }

  /** The game is over: its result (as for `say`) shows in the bar for a while and goes in the chat. */
  finish(result, code, args) {
    this.state = { ...this.state, phase: 'done', until: Date.now() + DONE_MS, result, resultCode: code, resultArgs: args };
    this.say(result, code, args);
    this.send();
  }

  /**
   * Someone connected during a game. Back after a dropped connection (or a new connection that
   * replaced the old one): their part as before, their team, their time as "it", their coins, still
   * hiding or seeking. New: too late to hide, so they help seeking; in the teams game the smaller
   * team, starting at its house.
   */
  join(name) {
    const s = this.state;
    if (s.kind === 'teams' && s.phase === 'playing') {
      const back = name in s.teams;
      if (!back) s.teams[name] = this.smaller();
      this.game.teamsChanged([name], !back);
    }
    if (s.kind === 'hide') {
      if (!s.players.has(name)) s.seekers.add(name);
      s.players.add(name);
    }
    if (s.kind === 'tag') s.times[name] ??= 0;
    if (s.kind === 'treasure') s.counts[name] ??= 0;
    if (this.active) this.send();
  }

  /** Someone left during a game: it goes on without them if it can. Their part is kept for when they're back (see join). */
  leave(name) {
    const s = this.state;
    if (!this.active || s.phase === 'done') return;
    if (s.kind === 'hide') {
      const names = this.names();
      if (names.length < 2) return this.finish('Not enough players', 'notEnough');
      if (!names.some((n) => s.seekers.has(n))) return this.finish('The seeker left: the hiders win', 'seekerLeft');
      if (!names.some((n) => !s.seekers.has(n))) return this.finish('The seekers found everyone!', 'foundAll');
    } else if (s.kind === 'tag') {
      const names = this.names();
      if (names.length < 2) return this.finish('Not enough players', 'notEnough');
      if (s.it === name) {
        s.it = this.pick(names);
        this.say(`${name} left: ${s.it} is it`, 'itLeft', { name, it: s.it });
      }
    }
    this.send();
  }

  /** Every tick: the clock, and the time "it" has been it. */
  tick(now, dt) {
    const s = this.state;
    if (!this.active) return;
    if (s.kind === 'tag' && s.phase === 'playing' && s.it in s.times) s.times[s.it] += dt / 1000;
    if (now < s.until) return;
    if (s.phase === 'done') {
      const teams = s.kind === 'teams';
      this.state = { kind: 'free' };
      if (teams) this.game.teamsChanged(this.names(), false);
      return this.send();
    }
    if (s.kind === 'teams') {
      const { house, bungalow } = s.score;
      if (house === bungalow) return this.finish(`Time's up: a draw, ${house} to ${bungalow}`, 'teamsDraw', { house, bungalow });
      const team = house > bungalow ? 'house' : 'bungalow';
      return this.finish(`Time's up: team ${TEAM_NAMES[team]} wins, ${house} to ${bungalow}`, 'teamsTime', { team, house, bungalow });
    }
    if (s.kind === 'hide' && s.phase === 'hiding') {
      s.phase = 'seeking';
      s.until = now + SEEK_MS;
      this.say(`Ready or not, here ${s.first} comes!`, 'ready', { name: s.first });
      return this.send();
    }
    if (s.kind === 'hide') {
      const hidden = this.names().filter((n) => !s.seekers.has(n));
      if (!hidden.length) return this.finish('The seekers found everyone!', 'foundAll');
      return this.finish(`Time's up: ${hidden.join(', ')} stayed hidden and win${hidden.length === 1 ? 's' : ''}`, 'hiddenWin', { names: hidden });
    }
    if (s.kind === 'tag') {
      const ranked = Object.entries(this.here(s.times)).sort((a, b) => a[1] - b[1]); // who is still here: leaving early is no way to win
      if (!ranked.length) return this.finish('Nobody played', 'nobodyPlayed');
      return this.finish(`${ranked[0][0]} wins: only ${Math.round(ranked[0][1])} s as "it"`, 'tagWon', { name: ranked[0][0], n: Math.round(ranked[0][1]) });
    }
    this.huntOver();
  }
}
