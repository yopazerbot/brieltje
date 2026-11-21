// Games the admin starts from the menu: hide and seek, tag, a treasure hunt, two teams (the house
// against the bungalow, or from the starts the host chose: server/teamStarts.mjs) and Zombies (everyone one team against waves of zombies, server/zombies.mjs).
// The server keeps the game: who seeks or is "it", the clock, the coins, the teams and their score,
// the zombies, and it checks every tag and every coin against where the players really are. No
// fighting during the party games; in the teams game only between the teams, in Zombies only at the
// zombies. Hide and seek, tag, the treasure hunt and Zombies are played at the house in Briel:
// everyone is gathered there when one starts (game.mjs gather; the game's edge keeps them near, see fence).

import { DONE_MS as ZOMBIES_DONE_MS, RECONNECT_MS as ZOMBIES_RECONNECT_MS, ZombieGame } from './zombies.mjs';
import { arenaOf, portalOf } from '../shared/arenas.mjs';
import { BACK_MS, FIELDS, FLAG_COLORS, FLAG_MS, FLAG_TEAMS, FlagGame, SAFE_MS, SUDDEN_MS, flagTie } from './flags.mjs';
import { AssaultGame } from './assault.mjs';
import { placeName } from './teamStarts.mjs';
import { NEAR_M, RESULTS_MS, results } from './awards.mjs';

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
const GRACE_MS = 15_000; // a seeker or "it" whose connection drops has this long to come back
export const TEAM_GOAL = 25; // kills of the other team that win the teams game
export const TEAM_NAMES = { house: 'House', bungalow: 'Bungalow' };
export const TEAM_COLORS = { house: '#4fa3e0', bungalow: '#ff9f43' };
export const KINDS = { hide: 'Hide and seek', tag: 'Tag', treasure: 'Treasure hunt', teams: 'House against bungalow', zombies: 'Zombies', flag: 'Steal the flag' };
/** The teams game's name when the host chose its starts (server/teamStarts.mjs): not the two houses. */
export const TEAMS_TITLE = 'Team against team';
/** A team of the teams game in the chat's English: its side, or the evening's name it plays under (blue, red). */
const SIDE_NAMES = { ...TEAM_NAMES, blue: 'Blue', red: 'Red' };
/** Steal the flag's teams in the chat's English (server/flags.mjs). */
const FLAG_NAMES = { blue: 'Blue', red: 'Red' };
/** Attack and defend's name in the chat's English (server/assault.mjs: kind 'flag', place 'assault'). */
export const ASSAULT_TITLE = 'Attack and defend';
/**
 * A look the host's programme gives a game (server/host.mjs entry), for as long as it is played and its result shows:
 * 'paint', child-friendly for everyone whatever the house rule says; 'real', the house rule's child-friendly off (a
 * player's own choice of Paintball still holds on their page). None: the house rule. The stored rule is never touched
 * (game.mjs shownRules).
 */
export const LOOKS = ['paint', 'real'];

// Where coins can lie: round the house, outside (the main house is shut without its code, so no coin lies in its rooms).
const OUTSIDE = [[2.2, -0.05, 15.6], [6.5, -0.05, -1.4], [4.5, -0.05, -8], [8.5, -0.05, -15], [0.6, -0.05, -12], [10.8, -0.05, 6], [-1.6, -0.05, 4], [5.9, 3.06, -1.6], [9.9, -0.05, 12.5], [10.2, -0.05, 16], [9.5, -0.05, 2], [0.5, -0.05, 14], [5, -0.05, -4.5], [0.85, -0.05, -9.5], [4.5, -0.1, 19]];

/**
 * A table keyed by player names, without the keys every object has: a player called "constructor"
 * or "__proto__" (both fit the name rules) scores like anyone else.
 */
const byName = (entries = []) => Object.assign(Object.create(null), Object.fromEntries(entries));
/** `list` in a random order (Fisher-Yates: every order as likely). Also the host's shuffle (server/host.mjs). */
export const shuffled = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
/**
 * Everyone in `names` dealt to the two teams `pair` as evenly as can be, in a random order, the first card to a random
 * team: with an odd number either team may get the extra player (Yoshi, 17 Nov 2026: "Make sure the ctf is fair").
 */
const deal = (names, pair) => {
  const first = Math.random() < 0.5 ? 0 : 1;
  return byName(shuffled(names).map((n, i) => [n, pair[(i + first) % 2]]));
};

export class Modes {
  constructor(game) {
    this.game = game;
    this.state = { kind: 'free' };
  }

  get active() {
    return this.state.kind !== 'free';
  }

  /**
   * A party game is on: nobody fights another player (the teams game is a fight), the strongmen go for
   * nobody and a new round leaves everyone where they are. In Zombies the players do shoot, at the
   * zombies only (see noShooting and friends).
   */
  get peaceful() {
    return this.active && this.state.kind !== 'teams' && this.state.kind !== 'flag';
  }

  /** No shots, grenades or rockets at all (hide and seek, tag, the treasure hunt). */
  get noShooting() {
    return this.peaceful && this.state.kind !== 'zombies';
  }

  /** The Zombies game being played (not once its result shows), or null. */
  get zombies() {
    return this.state.kind === 'zombies' && this.state.phase !== 'done' ? this.state.z : null;
  }

  /**
   * A match of team against team is on: the teams game or Steal the flag. Asked by what only happens in such a match
   * (cars and helicopters taking damage).
   */
  get teamMatch() {
    return (this.state.kind === 'teams' || this.state.kind === 'flag') && this.state.phase === 'playing';
  }

  /** A game of two teams (the teams game or Steal the flag), its result showing too: the teams' score counts, not the kill limit. */
  get teamGame() {
    return this.state.kind === 'teams' || this.state.kind === 'flag';
  }

  /** Steal the flag being played (not once its result shows): its rules (server/flags.mjs), or null. */
  get flag() {
    return this.state.kind === 'flag' && this.state.phase !== 'done' ? this.state.f : null;
  }

  /** ms down before coming back: Steal the flag's own, else null (game.mjs keeps its own). */
  get backMs() {
    return this.flag ? BACK_MS : null;
  }

  /** ms of protection after coming back: Steal the flag's own, else null. */
  get safeMs() {
    return this.flag ? SAFE_MS : null;
  }

  /**
   * The teams game being played (not once its result shows). It plays on the open map, as Steal the flag does, with no
   * trip and no start place while it runs (game.mjs fenced, travel, spawn): its starts may be anywhere (teamStarts).
   */
  get teamsOn() {
    return this.state.kind === 'teams' && this.state.phase === 'playing';
  }

  /**
   * Where a player comes back: in Steal the flag at their base, in the teams game at their team's start (game.mjs
   * respawn), else null.
   */
  baseSpot(name) {
    return this.flag?.baseSpot(name) ?? this.teamSpot(name);
  }

  /**
   * The teams game: a place of the player's team's start (server/teamStarts.mjs spread), a free one (nobody within a
   * metre), the furthest from the other team's living players of a few (one of the best three, for variety). By
   * parachute when the admin's rule says so and it is a respawn after a death (`drop`: game.mjs respawn). Null for a
   * player on no team, or outside the teams game.
   */
  teamSpot(name) {
    const s = this.state;
    const team = this.teamsOn && s.starts ? s.teams[name] : null;
    if (!team) return null;
    const spots = s.starts[team].spots;
    const live = [...this.game.players].filter(([n, o]) => n !== name && o.alive && o.state && !o.guard);
    const foes = live.filter(([n]) => s.teams[n] && s.teams[n] !== team).map(([, o]) => o.state);
    const taken = (q) => live.some(([, o]) => Math.hypot(o.state.x - q.x, o.state.z - q.z) < 1);
    const free = spots.filter((q) => !taken(q));
    const ranked = (free.length ? free : spots).map((q) => ({ q, d: foes.length ? Math.min(...foes.map((o) => Math.hypot(o.x - q.x, o.z - q.z))) : Math.random() }))
      .sort((a, b) => b.d - a.d);
    const { q } = ranked[Math.floor(Math.random() * Math.min(3, ranked.length))];
    return { spawn: 0, x: q.x, y: q.y, z: q.z, face: q.face, drop: true };
  }

  /** The name a teams game's side plays under: the evening's (blue, red) when the host's two teams play it, else its own. */
  sideName(team) {
    return this.state.names?.[team] ?? team;
  }

  /** The team whose flag `name` carries in Steal the flag, or null: no portal, trip from the chat or helicopter seat then. */
  carrying(name) {
    return this.flag?.carrying(name) ?? null;
  }

  /**
   * Steal the flag: a flag `name` carries falls where the server had them (leaving, or a new connection replacing theirs:
   * game.mjs join, whose old socket's close skips leave). Every page told; `send` false when the caller sends the mode.
   */
  dropFlag(name, now = Date.now(), send = true) {
    const ev = this.flag?.release(name, now);
    if (!ev) return;
    this.flagEvents([ev]);
    if (send) this.send();
  }

  /**
   * The host swaps the sides of Steal the flag being played (server/host.mjs `swap`, server/flags.mjs swap): only then,
   * at most once in SWAP_MS, never by itself. Every page gets a short line and a sound, and the game's view with the
   * swapped bases. { ok } or { error, code }.
   */
  swapSides(now = Date.now()) {
    const s = this.state;
    if (s.kind !== 'flag' || s.phase !== 'playing') return { error: 'Only while Steal the flag is played', code: 'noFlagGame' };
    if (s.f.assault) return { error: 'Attack and defend swaps the roles itself, between its rounds', code: 'assaultNoSwap' }; // server/assault.mjs
    const ev = s.f.swap(now);
    if (ev.error) return ev;
    this.flagEvents([ev]);
    this.send();
    return { ok: true };
  }

  /** The look of the game being played (see LOOKS), or null: the house rule. */
  get look() {
    return this.active ? this.state.look ?? null : null;
  }

  /** A team's colour in the teams game: blue and red when the host's two teams play it (server/host.mjs), else its own. */
  teamColor(team) {
    return (this.state.colors ?? TEAM_COLORS)[team];
  }


  /** In the teams game: the player's team ('house' or 'bungalow'); in Steal the flag 'blue' or 'red'; else null. */
  teamOf(name) {
    return this.teamGame ? this.state.teams[name] ?? null : null;
  }

  /** Two players on the same team: they can't hurt each other. In Zombies everyone is on one team. */
  friends(a, b) {
    if (this.state.kind === 'zombies' || this.game.room?.duel) return true; // a duel room is one team (server/duel.mjs)
    const t = this.teamOf(a);
    return !!t && t === this.teamOf(b);
  }

  /** The team with fewer players here now; level, either at random (never one team always). */
  smaller() {
    const [a, b] = this.state.kind === 'flag' ? FLAG_TEAMS : ['house', 'bungalow'];
    const n = { [a]: 0, [b]: 0 };
    for (const [p, t] of Object.entries(this.here(this.state.teams))) if (!this.game.flagGuards?.has(p)) n[t]++; // the players, not the guards
    return n[a] === n[b] ? this.pick([a, b]) : n[b] < n[a] ? b : a;
  }

  /** Of a table by player names, the players here now (those away keep their part for when they're back). */
  here(table) {
    return byName(Object.entries(table).filter(([n]) => this.game.players.has(n)));
  }

  /**
   * A player asks to switch team (a page's message): refused in every team game, waiting to come back or playing, its
   * result showing too (Yoshi, 17 Nov 2026: "team switches should only be done by the admin, also team assignment is
   * admin only"). Only the host moves a player (server/host.mjs `move`). Privilege escalation and score forgery by
   * switching to the winning side: no message from a page changes a team. One answer a second at most.
   */
  choose(name) {
    const p = this.game.players.get(name);
    if (!this.teamGame || !p) return;
    const now = Date.now();
    if (now - (p.teamAsked ?? -Infinity) < 1000) return;
    p.teamAsked = now;
    this.game.send(p.ws, { t: 'system', text: 'Teams are set by the host.', code: 'hostOnlyTeams' });
  }

  /** A kill in the teams game: a point for the killer's team, unless it was their own. In Steal the flag a tag, for the tie. */
  scored(killer, victim) {
    const s = this.state;
    if (s.kind === 'flag' && s.phase === 'playing') return s.f.tagged(killer, victim);
    if (s.kind !== 'teams' || s.phase !== 'playing') return;
    const team = s.teams[killer];
    if (!team || team === s.teams[victim]) return;
    s.score[team]++;
    this.teamActs(killer, victim, team);
    // `team` the name it plays under (the page's words for it), `side` the game's own (the host's points: host.mjs gameOver).
    const shown = this.sideName(team);
    if (s.score[team] >= (s.goal ?? TEAM_GOAL)) this.finish(`Team ${SIDE_NAMES[shown]} wins, ${s.score.house} to ${s.score.bungalow}`, 'teamWon', { team: shown, side: team, ...s.score });
    else this.send();
  }

  /**
   * The team deathmatch's counts for its results moment (server/awards.mjs), from the server's own tag: the tagger's
   * tags, their run of tags without being tagged (`run`, the best `best`) and their tags with a teammate alive within
   * NEAR_M m (`near`); the tagged one's `tagged`, their run back to nought. Nothing a page says goes in.
   */
  teamActs(killer, victim, team) {
    const acts = (this.state.acts ??= new Map());
    const row = (n) => {
      let r = acts.get(n);
      if (!r) acts.set(n, (r = { tags: 0, tagged: 0, run: 0, best: 0, near: 0 }));
      return r;
    };
    const k = row(killer);
    k.tags++;
    k.best = Math.max(k.best, ++k.run);
    const at = this.game.players.get(killer)?.state;
    if (at && [...this.game.players].some(([n, o]) => n !== killer && !o.guard && o.alive && o.state && this.state.teams[n] === team && Math.hypot(o.state.x - at.x, o.state.z - at.z) <= NEAR_M && Math.abs(o.state.y - at.y) <= NEAR_M)) k.near++;
    const v = row(victim);
    v.tagged++;
    v.run = 0;
  }

  /**
   * The results moment of a team game that just ended with `code` and `args` (server/awards.mjs): the awards and every
   * player's own line, each award with the team it plays under and its colour. Null for any other game.
   */
  resultsOf(code, args) {
    const s = this.state;
    const winner = typeof args?.team === 'string' ? args.team : null;
    const here = new Set(this.game.players.keys());
    if (s.kind === 'flag') {
      const r = results(s.f.assault ? 'assault' : 'flag', s.f.statsList(), winner, here);
      return { ...r, awards: r.awards.map((a) => ({ ...a, color: FLAG_COLORS[a.team] ?? null })) };
    }
    if (s.kind !== 'teams') return null;
    const acts = s.acts ?? new Map();
    const rows = Object.keys(s.teams).map((name) => ({ name, team: s.teams[name], ...(acts.get(name) ?? { tags: 0, tagged: 0, best: 0, near: 0 }) }));
    const side = typeof args?.side === 'string' ? args.side : null; // the game's own side (house, bungalow): `team` is the name it plays under
    const r = results('teams', rows, side, here);
    return { ...r, awards: r.awards.map((a) => ({ ...a, team: a.team ? this.sideName(a.team) : null, color: (s.colors ?? TEAM_COLORS)[a.team] ?? null })) };
  }

  /**
   * What every browser gets: the game, the phase and its time left, roles and scores (seekers and teams of the players
   * here). `admin`: the admin's board (game.mjs board): a flag game's counts for each player live too, not only at its end.
   */
  view(now = Date.now(), admin = false) {
    const s = this.state;
    if (s.kind === 'free') return { kind: 'free' };
    return {
      kind: s.kind, phase: s.phase, ms: Math.max(0, s.until - now), title: s.f?.assault ? ASSAULT_TITLE : s.kind === 'teams' && s.open ? TEAMS_TITLE : KINDS[s.kind],
      // The teams game: the names its sides play under (the evening's blue and red), whether the host chose its starts
      // (`open`: "Team against team"), and where each starts (a place's id, or `near` one for the host's own spot).
      ...(s.kind === 'teams' ? { names: s.names ?? undefined, open: s.open || undefined, starts: s.startsView ?? undefined } : {}),
      seekers: s.seekers ? [...s.seekers].filter((n) => this.game.players.has(n)) : undefined, it: s.it, times: s.times, coins: s.coins, counts: s.counts,
      result: s.result, resultCode: s.resultCode, resultArgs: s.resultArgs,
      results: s.phase === 'done' ? s.results ?? undefined : undefined, // a team game's awards and lines (server/awards.mjs)
      teams: s.teams && this.here(s.teams), score: s.score, goal: s.kind === 'teams' ? s.goal ?? TEAM_GOAL : undefined,
      colors: s.kind === 'teams' ? s.colors ?? TEAM_COLORS : s.kind === 'flag' ? FLAG_COLORS : undefined, // the teams' colours, for the big screen (admin/scores)
      // Steal the flag: the field, each flag, the tags (server/flags.mjs); each player's counts once it is over (`stats`).
      flag: s.kind === 'flag' ? s.f.view(now, admin || s.phase === 'done') : undefined,
      look: s.look ?? undefined, // the host's look for this game (LOOKS), for the host page
      // Zombies: the wave, how many are left, who stands, everyone's count and the best ever; the break's countdown.
      ...(s.kind === 'zombies' ? { zombies: s.z.view(now), ms: s.phase === 'done' ? Math.max(0, s.until - now) : s.z.ms(now) } : {}),
    };
  }

  send() {
    // Every change of game comes through here: a new look (or none) tells every page the rules it now plays by.
    if (this.look !== (this.shownLook ?? null)) {
      this.shownLook = this.look;
      this.game.lookChanged?.();
    }
    const mode = this.view();
    // Zombies with something lying inside a home: each page its own view (game.mjs lootFor); else one for all, as before.
    if (!mode.zombies || !this.game.lootInside?.(mode.zombies)) return this.game.broadcast({ t: 'mode', mode });
    for (const [, p] of this.game.audience()) this.game.send(p.ws, { t: 'mode', mode: { ...mode, zombies: this.game.lootFor(mode.zombies, p) } }); // the watch views without any home's right
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

  /**
   * The admin starts a game (or 'free' to stop one); Zombies at `place` (shared/arenas.mjs). `opts` from the host's
   * programme (server/host.mjs, checked there): `minutes`, how long it lasts (not Zombies), `goal`, the teams' kills to win,
   * `look`, see LOOKS (checked again here). A game started otherwise (the menu, another one over it) has no look.
   */
  start(kind, by, place = 'house', opts = {}) {
    return this.corked(() => this.begin(kind, by, place, opts)); // by any route: the host's, the admin's menu, a room's
  }

  /**
   * `fn` with every page's socket corked while it tells them all (game.mjs corked): the same messages in the same
   * order, one write per socket as it ends. A start, the end, the switch to free play after a result.
   */
  corked(fn) {
    return this.game.corked ? this.game.corked(fn) : fn();
  }

  /** The game started (start), its sockets corked. */
  begin(kind, by, place = 'house', opts = {}) {
    this.game.flagGuards?.clear(); // Steal the flag's guards go with any change of game (server/flagGuards.mjs)
    const now = Date.now();
    const ms = (fixed) => (opts.minutes ? opts.minutes * 60_000 : fixed);
    if (kind === 'free') {
      if (!this.active) return;
      const teams = this.teamGame;
      const zombies = this.state.kind === 'zombies';
      if (zombies) this.state.z.stop();
      if (this.state.kind === 'flag') this.state.f.unpark(now); // its parked vehicles go
      this.state = { kind: 'free' };
      if (zombies) this.game.gunsBack?.(); // every gun, back
      if (teams) this.game.teamsChanged(this.names(), false);
      this.send();
      this.say(`${by} stopped the game`, 'gameStopped', { name: by });
      if (teams) this.game.freshRound(); // the kills of the teams game would end the next round at once
      return;
    }
    if (!Object.hasOwn(KINDS, kind)) return;
    const names = this.names();
    if (names.length < 2 && kind !== 'treasure' && kind !== 'zombies') return this.say(`${KINDS[kind]} needs at least two players`, 'needTwo', { kind });
    const fromTeams = this.teamGame && kind !== this.state.kind;
    if (this.state.kind === 'zombies') this.state.z.stop(); // straight from a Zombies game to another game: its zombies go
    if (this.state.kind === 'flag') this.state.f.unpark(now); // straight from Steal the flag: its parked vehicles go
    if (kind === 'hide') {
      // `players`: who took part, so someone back after a dropped connection plays on as before (see join).
      const seeker = this.pick(names);
      this.state = { kind, phase: 'hiding', until: now + HIDE_MS, seekers: new Set([seeker]), first: seeker, players: new Set(names), seekMs: ms(SEEK_MS) };
      this.say(`${by} started hide and seek: ${seeker} seeks. Hide! (30 seconds)`, 'hideStarted', { name: by, seeker });
    } else if (kind === 'teams') {
      // Everyone on a team, each starting at its house: the host's two teams for the evening (server/host.mjs); without
      // them everyone dealt as evenly as can be, at random, and those become the host's two teams (moved from the host
      // page only).
      const sides = this.game.host?.sides(names);
      const teams = sides ? byName(names.map((n) => [n, sides[n]])) : deal(names, ['house', 'bungalow']);
      if (!sides) this.game.host?.adopt?.(teams, ['house', 'bungalow']);
      const goal = opts.goal ?? TEAM_GOAL;
      // Where each side starts (server/host.mjs teamStarts, server/teamStarts.mjs): the host's choice, else the two houses;
      // `open` when it is not the two houses. Played by the host's two teams, the sides go by the evening's names.
      const chosen = this.game.host?.teamStarts?.(opts.starts) ?? null;
      const sideNames = this.game.host?.teamCount === 2 ? { house: 'blue', bungalow: 'red' } : null;
      this.state = {
        kind, phase: 'playing', until: now + ms(TEAMS_MS), teams, score: { house: 0, bungalow: 0 }, goal, colors: this.game.host ? this.game.host.sideColors() : null,
        starts: chosen?.starts ?? null, startsView: chosen?.view ?? null, open: !!chosen?.open, names: sideNames,
      };
      if (chosen?.open) {
        const { house, bungalow } = chosen.view;
        const at = (v) => (v.spot ? `the host's spot near ${placeName(v.place)}` : placeName(v.place));
        this.say(`${by} started Team against team: first team to ${goal} kills. ${SIDE_NAMES[this.sideName('house')]} starts at ${at(house)}, ${SIDE_NAMES[this.sideName('bungalow')]} at ${at(bungalow)}.`, 'teamvteamStarted', {
          name: by, n: goal, team: this.sideName('house'), place: `${house.spot ? 'near.' : ''}${house.place}`, team2: this.sideName('bungalow'), place2: `${bungalow.spot ? 'near.' : ''}${bungalow.place}`,
        });
      } else this.say(`${by} started House against bungalow: first team to ${goal} kills. The host sets the teams.`, 'teamsStarted', { name: by, n: goal });
      this.game.roundOver = null; // the teams' score counts now
      this.game.teamsChanged(names);
    } else if (kind === 'flag') {
      // Blue against red (server/flags.mjs): the host's two teams when there are two (the first blue), else everyone
      // dealt as evenly as can be, at random, and those become the host's two teams (moved from the host page only).
      // `place`: the field, 'compact' or 'village' (anything else: compact). Everyone starts at their base; the
      // field's vehicles park.
      const sides = this.game.host?.sides(names);
      const teams = sides ? byName(names.map((n) => [n, sides[n] === 'house' ? 'blue' : 'red'])) : deal(names, FLAG_TEAMS);
      if (!sides) this.game.host?.adopt?.(teams, FLAG_TEAMS);
      // `place` 'assault': Attack and defend (server/assault.mjs), two rounds of its own on its own fields; `opts.defend`
      // the team defending the church first.
      const look = LOOKS.includes(opts.look) ? opts.look : null;
      // Attack and defend's own fields are never a plain Steal the flag's (no stand of the attackers to score at): compact.
      const plain = FIELDS[place]?.assault ? 'compact' : place;
      const f = place === 'assault' ? new AssaultGame(this.game, teams, look, { defend: opts.defend, roundMs: opts.minutes ? opts.minutes * 60_000 : undefined }, now) : new FlagGame(this.game, plain, teams, look, now);
      // `colors`: everyone dressed in their team's colour, on every page, the scoreboard, the kill feed and the name tags
      // (game.mjs colorOf, through teamColor).
      this.state = { kind, phase: 'playing', until: now + (f.assault ? f.roundMs : ms(FLAG_MS)), teams, score: f.score, f, colors: FLAG_COLORS };
      if (f.assault) this.say(`${by} started Attack and defend: team ${f.defender() === 'blue' ? 'Blue' : 'Red'} defends the church, the other team attacks from its camp. Two rounds.`, 'assaultStarted', { name: by, team: f.defender() });
      else this.say(`${by} started Steal the flag: blue at the church, red at ${f.field.id === 'village' ? 'the Sparrenhof' : 'Molenhoek'}. Bring their flag to your base.`, 'flagStarted', { name: by, place: f.field.red });
      this.game.roundOver = null; // the teams' score counts now
      this.game.teamsChanged(names); // everyone at their base, out of every seat first: a machine someone sat in parks too
      f.park(now);
    } else if (kind === 'zombies') {
      // Everyone at the place first (home, or a portal in Smetlede), then the horde: its grid takes the cars
      // where they stand now. Every pane whole again for everyone: a fresh house for the game (the zombies
      // come in through a broken one).
      const arena = arenaOf(place);
      this.game.gather(names, arena, false, 'hp'); // everyone at the place, on the ground: no parachute in Zombies (the first wave comes after 8 s); mid-fight not healed
      this.game.pistolsOnly?.(); // and with the pistol only: the other guns are found on the map
      this.game.roundOver = null;
      this.game.broken.clear();
      this.game.cracked?.clear();
      this.game.broadcast({ t: 'repair', by, quiet: true });
      const z = new ZombieGame(this.game, this, names, now, arena);
      this.state = { kind, phase: z.phase, until: z.horde.until, z };
      this.say(`${by} started Zombies (${portalOf(arena).name}). Beat the waves together. The first one comes in 8 seconds.`, 'zombiesStartedAt', { name: by, place: arena.id });
    } else if (kind === 'tag') {
      const it = this.pick(names);
      this.state = { kind, phase: 'playing', until: now + ms(TAG_MS), it, last: null, lastAt: 0, times: byName(names.map((n) => [n, 0])) };
      this.say(`${by} started tag: ${it} is it. The least time as "it" wins.`, 'tagStarted', { name: by, it });
    } else {
      const spots = [...OUTSIDE];
      const coins = [];
      while (coins.length < COINS && spots.length) {
        const [x, y, z] = spots.splice(Math.floor(Math.random() * spots.length), 1)[0];
        coins.push({ i: coins.length, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) });
      }
      this.state = { kind, phase: 'playing', until: now + ms(HUNT_MS), coins, counts: byName(names.map((n) => [n, 0])) };
      this.say(`${by} started a treasure hunt: ${COINS} coins in and around the house`, 'huntStarted', { name: by, n: COINS });
    }
    this.state.look = LOOKS.includes(opts.look) ? opts.look : null;
    if (kind !== 'teams' && kind !== 'zombies' && kind !== 'flag') this.game.gather(names); // played at the house: everyone there, spread out
    // Straight from the teams game to another one: everyone back in their own colours, and the
    // fighting scores start again.
    if (fromTeams) {
      this.game.teamsChanged(names, false);
      this.game.freshRound();
    }
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
    return this.corked(() => {
      this.game.flagGuards?.clear(); // the guards go before the evening's points are given out (server/flagGuards.mjs)
      const long = this.state.kind === 'zombies'; // the end screen: the wave, everyone's zombies and the best ever
      // A team game: its results moment (server/awards.mjs), RESULTS_MS long, its awards kept on the evening's board too.
      this.state.results = this.resultsOf(code, args);
      this.game.host?.gameOver(this.state, code, args); // the evening's scoreboard (server/host.mjs)
      const ms = long ? ZOMBIES_DONE_MS : this.state.results ? RESULTS_MS : DONE_MS;
      this.state = { ...this.state, phase: 'done', until: Date.now() + ms, result, resultCode: code, resultArgs: args };
      this.say(result, code, args);
      this.send();
    });
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
      if (!back) s.teams[name] = this.game.host?.sideOf(name) ?? this.smaller();
      this.game.teamsChanged([name], !back);
      // Back (a reload, a new tab): where the server has them, as in Steal the flag below. Before, a reloaded page started
      // in the lane by the house while the server had them at their start, and walked them over unseen.
      const p = back ? this.game.players.get(name) : null;
      if (p?.state) this.game.send(p.ws, { t: 'spawn', ok: false, x: p.state.x, z: p.state.z });
    }
    if (s.kind === 'flag' && s.phase === 'playing') {
      // Late: the host's side (blue for the house's, red for the bungalow's), else the smaller team (level: either at
      // random), at its base. Back after a dropped connection: their team as before.
      const back = name in s.teams;
      const side = this.game.host?.sideOf(name);
      if (!back) s.teams[name] = side ? (side === 'house' ? 'blue' : 'red') : this.smaller();
      this.game.teamsChanged([name], !back);
      // Back (a reload, a new tab, Wi-Fi gone a moment): where the server has them, never moved or healed by it. Their page
      // is told so, as for a refused start place (game.mjs spawn): a reloaded page starts at the house, and was held to the
      // field's edge nearest to it while the server walked them over from where they were (up to a minute, unseen there).
      const p = back ? this.game.players.get(name) : null;
      if (p?.state) this.game.send(p.ws, { t: 'spawn', ok: false, x: p.state.x, z: p.state.z });
    }
    if (s.kind === 'hide') {
      if (!s.players.has(name)) s.seekers.add(name);
      s.players.add(name);
      if (s.seekers.has(name)) s.seekerBack = 0; // a seeker is back in time
    }
    if (s.kind === 'tag') {
      s.times[name] ??= 0;
      if (s.it === name) s.itBack = 0; // "it" is back in time
    }
    if (s.kind === 'treasure') s.counts[name] ??= 0;
    if (s.kind === 'zombies' && s.phase !== 'done') {
      s.emptyUntil = 0;
      s.z.join(name, this.game.players.get(name));
    }
    if (this.active) this.send();
  }

  /**
   * Someone left during a game: it goes on without them if it can. Their part is kept for when
   * they're back (see join). The last seeker, or "it", has GRACE_MS to come back (a phone's Wi-Fi
   * blinking) before the game goes on without them (see tick).
   */
  leave(name, player, now = Date.now()) {
    const s = this.state;
    if (!this.active || s.phase === 'done') return;
    if (s.kind === 'hide') {
      const names = this.names();
      if (s.seekers.has(name) && !names.some((n) => s.seekers.has(n))) {
        s.seekerBack = Date.now() + GRACE_MS;
        this.say(`The seeker ${name} dropped out. Waiting 15 seconds for them to come back.`, 'seekerAway', { name });
        return this.send();
      }
      if (names.length < 2) return this.finish('Not enough players', 'notEnough');
      if (!names.some((n) => !s.seekers.has(n))) return this.finish('The seekers found everyone!', 'foundAll');
    } else if (s.kind === 'tag') {
      if (s.it === name) {
        s.itBack = Date.now() + GRACE_MS;
        this.say(`${name}, who is it, dropped out. Waiting 15 seconds for them to come back.`, 'itAway', { name });
        return this.send();
      }
      if (this.names().length < 2) return this.finish('Not enough players', 'notEnough');
    } else if (s.kind === 'zombies') {
      s.z.leave(name, player, now);
      if (!this.names().length) s.emptyUntil = now + ZOMBIES_RECONNECT_MS;
    } else if (s.kind === 'flag') {
      this.dropFlag(name, now, false); // a flag they carried falls where they were
    }
    this.send();
  }

  /** A seeker or "it" who dropped out and wasn't back in time: the game goes on without them. */
  graceOver(now) {
    const s = this.state;
    const names = this.names();
    if (s.kind === 'hide' && s.seekerBack && now >= s.seekerBack) {
      s.seekerBack = 0;
      if (names.some((n) => s.seekers.has(n))) return false;
      if (names.length >= 2) this.finish('The seeker left: the hiders win', 'seekerLeft');
      else this.finish('Not enough players', 'notEnough');
      return true;
    }
    if (s.kind === 'tag' && s.itBack && now >= s.itBack) {
      s.itBack = 0;
      if (this.game.players.has(s.it)) return false;
      if (names.length < 2) {
        this.finish('Not enough players', 'notEnough');
        return true;
      }
      const gone = s.it;
      s.it = this.pick(names);
      s.last = null;
      this.say(`${gone} left: ${s.it} is it`, 'itLeft', { name: gone, it: s.it });
      this.send();
    }
    return false;
  }

  /**
   * Steal the flag, every tick (server/flags.mjs): the flags followed from where the players are, a line and a sound on
   * every page for each event, and the clock. Time up with more captures for one team: theirs. Level with a flag away
   * from its stand: sudden death while one is away, SUDDEN_MS at most, the next capture wins. Level with both flags home,
   * at the time or again during sudden death, or sudden death's time up: the tie-break at once (server/flags.mjs flagTie).
   * A nine-minute 0-0 (four of play, five of sudden death with both flags home) now ends at the time.
   */
  flagTick(now) {
    const s = this.state;
    const f = s.f;
    if (f.assault) return f.tick(now, this); // Attack and defend keeps its own rounds (server/assault.mjs)
    const events = f.step(now);
    const racks = f.arms.step(now); // each team's bazooka (server/flagBazooka.mjs): taken, away, back on its rack
    if (events.length) this.flagEvents(events);
    const captured = events.some((e) => e.ev === 'captured');
    const { blue, red } = f.score;
    const away = FLAG_TEAMS.some((t) => f.flags[t].at !== 'home');
    if (f.sudden && captured) return this.flagOver('flagSudden');
    if (f.sudden && !away) return this.flagOver('flagLevel'); // both home again, still level: nothing left to decide it
    if (now < s.until) {
      if (events.length || racks) this.send();
      return;
    }
    if (blue !== red) return this.flagOver('flagTime');
    if (!f.sudden && away) {
      f.sudden = true;
      s.until = now + SUDDEN_MS;
      this.say(`Time's up at ${blue} to ${red} and a flag is still out: sudden death, up to 2 minutes. The next flag brought in wins`, 'flagSuddenStart', { blue, red });
      return this.send();
    }
    this.flagOver('flagLevel');
  }

  /**
   * Steal the flag is over: `why` 'flagTime' (more captures when time was up), 'flagSudden' (the capture in sudden
   * death) or 'flagLevel' (level: the tie-break, server/flags.mjs flagTie: the flag got furthest, else the most tags,
   * else a draw).
   */
  flagOver(why) {
    const f = this.state.f;
    f.arms.end(); // the bazookas out of everyone's hands, the racks gone, the admin's own back (server/flagBazooka.mjs)
    const { blue, red } = f.score;
    if (why !== 'flagLevel') {
      const team = blue > red ? 'blue' : 'red';
      return this.finish(`Team ${FLAG_NAMES[team]} wins, ${blue} to ${red}`, 'flagWon', { team, blue, red });
    }
    const tags = f.tags;
    const w = flagTie(f.way, tags);
    if (w.why === 'far') {
      const them = w.team === 'blue' ? 'red' : 'blue';
      // One code a team ("the red flag" / "de rode vlag": the colour's own word in each language).
      return this.finish(`Level at ${blue} to ${red}: ${FLAG_NAMES[w.team]} got the ${them} flag furthest, ${w.a}% of the way (${FLAG_NAMES[them]}: ${w.b}%)`, w.team === 'blue' ? 'flagFarBlue' : 'flagFarRed', { team: w.team, blue, red, a: w.a, b: w.b });
    }
    if (w.why === 'draw') return this.finish(`A draw: ${blue} to ${red} in captures and ${tags.blue} to ${tags.red} in tags`, 'flagDraw', { blue, red, a: tags.blue, b: tags.red });
    this.finish(`Team ${FLAG_NAMES[w.team]} wins on tags, ${tags.blue} to ${tags.red} (captures ${blue} to ${red})`, 'flagTagsWon', { team: w.team, blue, red, a: tags.blue, b: tags.red });
  }

  /**
   * Flag events (server/flags.mjs step) for every page: the HUD's short line and its sound (`flag`), never a card. `team`
   * is the flag's, `name` who did it ('' for a flag home by itself); `why` for 'safe' (sent home: carried into a 'zone'
   * where nobody fights, or a private 'home'; never where). 'seen' (the beacon came on) is the server's own: the view
   * carries it, no page gets a line for it here.
   */
  flagEvents(events) {
    for (const e of events) if (e.ev !== 'seen') this.game.broadcast({ t: 'flag', ev: e.ev, team: e.team, name: e.name, ...(e.why ? { why: e.why } : {}) });
  }

  /** Every tick: the clock, and the time "it" has been it (while there). */
  tick(now, dt) {
    const s = this.state;
    if (!this.active) return;
    if (s.phase !== 'done' && this.graceOver(now)) return;
    if (s.kind === 'tag' && s.phase === 'playing' && s.it in s.times && this.game.players.has(s.it)) s.times[s.it] += dt / 1000;
    if (s.kind === 'zombies' && s.phase !== 'done') {
      if (!this.game.players.size) {
        s.emptyUntil ||= now + ZOMBIES_RECONNECT_MS;
        if (now >= s.emptyUntil) {
          s.z.stop();
          this.state = { kind: 'free' };
          this.send();
        }
        return;
      }
      // The horde keeps its own clock: its breaks and waves (and its end, through finish).
      s.z.tick(now, dt);
      return;
    }
    if (s.kind === 'flag' && s.phase === 'playing') return this.flagTick(now);
    if (now < s.until) return;
    if (s.phase === 'done') {
      // Free play once the result has shown: thirty players back in their own colours and told at once (corked).
      return this.corked(() => {
        const teams = s.kind === 'teams' || s.kind === 'flag';
        if (s.kind === 'zombies') s.z.stop();
        if (s.kind === 'flag') s.f.unpark(now); // its parked vehicles go once its result has shown
        this.state = { kind: 'free' };
        if (s.kind === 'zombies') this.game.gunsBack?.(); // every gun, back
        if (teams) {
          this.game.teamsChanged(this.names(), false);
          this.game.freshRound(); // the kills of the teams game would end the next round at once
        }
        return this.send();
      });
    }
    if (s.kind === 'teams') {
      const { house, bungalow } = s.score;
      if (house === bungalow) return this.finish(`Time's up: a draw, ${house} to ${bungalow}`, 'teamsDraw', { house, bungalow });
      const team = house > bungalow ? 'house' : 'bungalow';
      const shown = this.sideName(team);
      return this.finish(`Time's up: team ${SIDE_NAMES[shown]} wins, ${house} to ${bungalow}`, 'teamsTime', { team: shown, side: team, house, bungalow });
    }
    if (s.kind === 'hide' && s.phase === 'hiding') {
      s.phase = 'seeking';
      s.until = now + (s.seekMs ?? SEEK_MS);
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
