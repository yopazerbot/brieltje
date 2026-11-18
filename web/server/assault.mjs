// Attack and defend, a game-night mode (Yoshi, 18 Nov 2026: "we have a defender/attack scenario, once with the church
// as base, once as sparrenhof as base. And the attackers basically have to come steal the flag, the defenders should
// defend. The attackers should have some kind of 'mobile base camp' at a reasonable but far enough distance from the
// defenders base camp. And both camps should have some supply crates etc and vechices/choppers from which players can
// take stuff"). The server's rules, a Steal the flag game of its own (server/flags.mjs FlagGame: the teams, the field's
// vehicles and helicopters, the touch rules, no travel, the carrier's limits), driven from server/modes.mjs (kind
// 'flag', place 'assault'). The fields are in shared/assaultFields.mjs, the supplies in server/assaultSupply.mjs.
//
// Yoshi's choices (18 Nov 2026):
// - Two rounds of at most ASSAULT.roundMs (the programme's minutes override it). Round 1 one team defends the church;
//   round 2 the other team defends the Sparrenhof (the host picks who defends first). ASSAULT.breakMs between them:
//   everyone at their new places, the scores carried.
// - The attackers win the round as soon as one of them carries the defenders' flag into their camp (within
//   ASSAULT.campR of its flag; ASSAULT.campRCar in a car), and the time it took counts, on the server's clock.
// - Over the two rounds the fastest capture wins. Without a capture the closest attempt counts: the furthest the flag got
//   towards the camp (shared/assaultFields.mjs progressOf, straight lines, measured here each tick while it is carried or
//   lies on the ground).
// - Tie-break, in order (mine, written down for Yoshi): a capture beats none; two captures, the shorter time to a tenth of
//   a second; no capture, the further attempt to a whole per cent; still level, the most tags over both rounds; still
//   level, a draw.
// - The defenders bring a dropped flag home by touch; left alone it goes home after RETURN_MS (as Steal the flag). The
//   attackers' own flag stands in their camp and nobody takes it.
// - Start places: the defenders 12 to 22 m behind their stand; the attackers at their camp, or at the spawn truck when it
//   stands still (ASSAULT.truckStillMs, nobody at the wheel), whole and at least ASSAULT.truckMin m from the defenders'
//   stand. Protected for SAFE_MS, as in Steal the flag.
// - The spawn truck: driven by the attackers only (`mayEnter`), a car the server keeps like any other; it takes damage
//   (server/vehicleDamage.mjs, its own team's never), and a wreck is back whole at its camp 60 s after (parkOf, goneMs).
//
// Guarded against (the attack table: DECISIONS.md, "Attack and defend"):
// - forged captures, takes, returns and times: no message touches a flag or the clock. Every flag event is derived here
//   from the positions the server keeps (as Steal the flag), the capture from the carrier's place and the camp's, the
//   time from the server's clock, the attempt's distance from the same places;
// - spawn forgery: where a player comes back is the server's choice (baseSpot); nobody asks for the truck;
// - privilege escalation: the truck refuses every seat to a defender (game.mjs asks mayEnter), the roles come from the
//   round and the host's teams, the rounds move on the server's clock only;
// - the rest (supplies, heavy weapons, traps) in server/assaultSupply.mjs.
// Nothing here is stored or logged.

import { homeAt } from '../shared/homes.mjs';
import { ASSAULT, ROUND_FIELDS, progressOf } from '../shared/assaultFields.mjs';
import { fieldOf } from '../shared/flagFields.mjs';
import { FlagGame, REGRAB_MS, RETURN_MS, TOUCH } from './flags.mjs';
import { AssaultArms, AssaultSupply } from './assaultSupply.mjs';

const other = (team) => (team === 'blue' ? 'red' : 'blue');
const round2 = (v) => Math.round(v * 100) / 100;
/** The truck's start places round it: [across, along] in its own frame (behind it and beside its back). */
const TRUCK_SPOTS = [[0, 5.2], [-2.4, 3.2], [2.4, 3.2], [-2.4, 0], [2.4, 0], [0, 7.2]];

export class AssaultGame extends FlagGame {
  /**
   * `game`: the Game; `teams`: the modes' table of player name -> 'blue' | 'red'; `look`: the programme's look; `opts`:
   * `defend` ('blue' or 'red': who defends the church in round 1) and `roundMs` (the programme's minutes).
   */
  constructor(game, teams, look, opts = {}, now = Date.now()) {
    super(game, ROUND_FIELDS[0], teams, look, now);
    this.assault = true;
    this.roundMs = Number.isFinite(opts.roundMs) ? opts.roundMs : ASSAULT.roundMs;
    this.round = 1;
    this.phase = 'live';
    // The field's blue side is the defenders': red defending is the sides swapped.
    this.swapped = opts.defend === 'red';
    for (const t of ['blue', 'red']) this.flags[t] = this.homeFlag(t);
    this.roundStart = now;
    /** The furthest the defenders' flag got towards the camp this round (0..1) */
    this.best = 0;
    /** Each round played: { def, att, ms (the capture's time, or null), best (0..1), by (the capturer) } */
    this.results = [];
    this.over = false;
    /** The spawn truck: where it was last, and since when it stands still there */
    this.truckAt = null;
    this.truckSince = now;
    /** Whether the truck was a start place and stood still at the last tick (every page told when either changes) */
    this.truckWas = 'false:false';
    this.arms = new AssaultArms(game, this);
    this.supply = new AssaultSupply(game, this);
  }

  /** The team defending this round, and the one attacking. */
  defender() {
    return this.swapped ? 'red' : 'blue';
  }

  attacker() {
    return other(this.defender());
  }

  /** The camp's flag [x, z, y] this round. */
  get camp() {
    return this.field.assault.camp.flag;
  }

  /**
   * The spawn truck stands still now: nobody at the wheel and not moved for ASSAULT.truckStillMs (tick keeps the clock).
   */
  truckStill(now) {
    const c = this.truckCar();
    return !!c && !c.driver && now - this.truckSince >= ASSAULT.truckStillMs;
  }

  truckCar() {
    const id = this.field.assault.truck;
    return Object.hasOwn(this.game.cars, id) && this.vehicles.cars.includes(id) ? this.game.cars[id] : null;
  }

  /**
   * The spawn truck as a start place now: still, whole, at least ASSAULT.truckMin m from the defenders' stand, outside
   * every private home. Its car, or null.
   */
  truckSpawn(now) {
    const c = this.truckCar();
    if (!c || !this.truckStill(now) || this.game.vehicleDamage?.out('car', c.id)) return null;
    const [sx, sz] = this.baseOf(this.defender()).stand;
    if (Math.hypot(c.x - sx, c.z - sz) < ASSAULT.truckMin || homeAt(c.x, c.z, c.y)) return null;
    return c;
  }

  /**
   * Where `name` comes back (game.mjs respawn): a defender at one of their start places, facing their stand; an attacker
   * by the spawn truck when it may be one (a free spot behind or beside it, inside the edge, never into a home), else at
   * the camp, facing the defenders.
   */
  baseSpot(name) {
    const team = this.teams[name];
    if (!team) return null;
    const def = this.defender();
    const stand = this.baseOf(def).stand;
    if (team === def) return super.baseSpot(name);
    const g = this.game;
    const now = Date.now();
    const p = g.players.get(name);
    const truck = this.truckSpawn(now);
    if (truck) {
      const c = Math.cos(truck.yaw), s = Math.sin(truck.yaw);
      const fence = g.fence();
      // Each spot on the ground the server knows there (the relief), with room to stand (Game.standAt: no wall, hedge or
      // fence within a metre, nothing solid at body height) and not much above or below the truck (a bank, a ditch);
      // none such: the camp.
      const spots = TRUCK_SPOTS.map(([a, b]) => {
        const x = round2(truck.x + a * c + b * s), z = round2(truck.z - a * s + b * c);
        const ground = g.standAt ? g.standAt(x, z) : { y: truck.y, ok: true };
        return { x, z, y: round2(ground.y), ok: ground.ok };
      }).filter((q) => q.ok && Math.abs(q.y - truck.y) < 1 && fence.inside(q.x, q.z) && !homeAt(q.x, q.z, q.y) && (!p || g.gate.mayStand(p, q.x, q.y, q.z)));
      const others = [...g.players].filter(([n, o]) => n !== name && o.alive && o.state).map(([, o]) => o.state);
      const room = (q) => Math.min(Infinity, ...others.map((o) => Math.hypot(o.x - q.x, o.z - q.z)));
      const free = spots.sort((a, b) => room(b) - room(a));
      if (free.length) return { spawn: 0, x: free[0].x, y: free[0].y, z: free[0].z, face: [stand[0], stand[1]] };
    }
    const spot = super.baseSpot(name);
    return spot ? { ...spot, face: [stand[0], stand[1]] } : null;
  }

  /**
   * Whether `name` may get into car `id` (game.mjs, before any seat): nobody in the break (everyone is placed again as
   * round 2 starts, and nobody drives ahead to the other stand meanwhile); the spawn truck the attackers' alone.
   */
  mayEnter(name, id) {
    if (this.phase === 'break') return false;
    if (id !== this.field.assault.truck || !this.vehicles.cars.includes(id)) return true;
    return this.teams[name] === this.attacker();
  }

  /** Whether `name` may board a helicopter now: not in the break. */
  mayFly() {
    return this.phase !== 'break';
  }

  /**
   * Why `name` may not take a seat in vehicle `kind` `id` now (game.mjs asks before any car or helicopter seat): a line's
   * { code, text }, or null when they may.
   */
  refuseSeat(name, kind, id) {
    if (this.phase === 'break') return { code: 'assaultBreakSeat', text: 'Not in the break: round 2 starts in a moment.' };
    if (kind === 'car' && !this.mayEnter(name, id)) return { code: 'assaultTruck', text: 'Only the attackers drive the spawn truck.' };
    return null;
  }

  /** A tag in the break counts for nothing (the tie-break counts the rounds' tags only). */
  tagged(killer, victim) {
    if (this.phase !== 'break') super.tagged(killer, victim);
  }

  /** The spawn truck's parking place at its camp (server/vehicleDamage.mjs home: a wreck goes back there), else null. */
  parkOf(kind, id) {
    if (kind !== 'car' || id !== this.field.assault.truck || !this.vehicles.cars.includes(id)) return null;
    const [x, z, y] = this.field.assault.camp.truck;
    return { x, y, z, yaw: this.field.assault.camp.yaw };
  }

  /** ms a destroyed spawn truck stays gone after its wreck (60 s in all, server/vehicleDamage.mjs); others: null. */
  goneMs(kind, id) {
    return this.parkOf(kind, id) ? ASSAULT.truckGoneMs : null;
  }

  /** A hit of `amount` on `name` (Game.damage): the vest takes what it can first (server/assaultSupply.mjs soak). */
  soak(name, p, amount) {
    return this.supply.soak(name, p, amount);
  }

  /**
   * The field's vehicles parked (server/flags.mjs park), each car in the colour of the team now on its side: the
   * defenders' blue side's in theirs, the camp's (the spawn truck too) in the attackers'.
   */
  park(now) {
    super.park(now);
    const g = this.game;
    for (const id of this.vehicles.cars) {
      const c = g.cars[id];
      if (c) c.kind = c.kind.replace(/-(blue|red)$/, `-${this.sideOf(id[1] === 'b' ? 'blue' : 'red')}`);
    }
    if (this.vehicles.cars.length) g.sendPlaced();
    const t = this.truckCar();
    this.truckAt = t ? { x: t.x, z: t.z, yaw: t.yaw } : null;
    this.truckSince = now;
  }

  /**
   * The game is over or stopped (Modes: its result shown, or the host's stop): the heavy weapons out of everyone's hands
   * and the traps gone, then the vehicles as in Steal the flag.
   */
  unpark(now) {
    this.supply.end();
    super.unpark(now); // its arms.end(): the heavy weapons (server/assaultSupply.mjs AssaultArms end)
  }

  /** Between the rounds: the first round's vehicles go as in Steal the flag, but the heavy weapons stay with their holders. */
  unparkRound(now) {
    const arms = this.arms;
    this.arms = { end() {} };
    super.unpark(now);
    this.arms = arms;
  }

  /**
   * One tick of a live round, as Steal the flag's step with this game's rules: only the defenders' flag moves; the
   * attackers take it from its stand or the ground, the defenders bring it home by touch, it goes home by itself after
   * RETURN_MS; a capture is its carrier inside the camp. Returns the events ('taken', 'dropped', 'returned', 'safe',
   * 'captured', `team` the flag's).
   */
  step(now) {
    const g = this.game;
    const events = [];
    const def = this.defender();
    const att = other(def);
    this.flags[att] = this.homeFlag(att); // the camp's flag: always home
    const f = this.flags[def];
    if (f.at === 'carried') {
      const p = g.players.get(f.by);
      const st = p?.state;
      if (!p || !st) events.push(this.drop(def, now));
      else if (p.warp !== f.warp) {
        g.send(p.ws, { t: 'system', text: 'You were moved, so the flag dropped where you stood.', code: 'flagMoved' });
        events.push(this.drop(def, now));
      } else if (homeAt(st.x, st.z, st.y)) {
        this.flags[def] = this.homeFlag(def);
        events.push({ ev: 'safe', team: def, name: f.by, why: 'home' });
      } else {
        Object.assign(f, { x: round2(st.x), y: round2(st.y), z: round2(st.z) });
        if (!p.alive || this.teams[f.by] !== att) events.push(this.drop(def, now));
      }
    }
    if (this.flags[def].at === 'ground' && now - this.flags[def].since >= RETURN_MS) {
      this.flags[def] = this.homeFlag(def);
      events.push({ ev: 'returned', team: def, name: '' });
    }
    const names = [...g.players.keys()].sort(() => Math.random() - 0.5);
    for (const name of names) {
      const p = g.players.get(name);
      const mine = this.teams[name];
      if (!mine || !this.canTouch(name, p, now)) continue;
      const st = p.state;
      const flag = this.flags[def];
      if (mine === def && flag.at === 'ground' && this.near(st, flag.x, flag.y, flag.z, TOUCH)) {
        this.flags[def] = this.homeFlag(def);
        events.push({ ev: 'returned', team: def, name });
        p.protectedUntil = 0;
      }
      const regrab = flag.at === 'ground' && flag.dropper === name && now - flag.since < REGRAB_MS;
      if (mine === att && (flag.at === 'home' || flag.at === 'ground') && !regrab && this.near(st, flag.x, flag.y, flag.z, TOUCH)) {
        Object.assign(flag, { at: 'carried', by: name, since: now, warp: p.warp, x: round2(st.x), y: round2(st.y), z: round2(st.z) });
        events.push({ ev: 'taken', team: def, name });
        p.protectedUntil = 0;
      }
    }
    this.keepStandsFree(now);
    const flag = this.flags[def];
    // How far it got: carried (its carrier's place) or lying.
    if (flag.at !== 'home') this.best = Math.max(this.best, progressOf(this.field, flag.x, flag.z));
    if (flag.at === 'carried') {
      const p = g.players.get(flag.by);
      const [cx, cz, cy] = this.camp;
      const reach = g.carOf?.(flag.by) ? ASSAULT.campRCar : ASSAULT.campR;
      if (p?.alive && p.state && this.teams[flag.by] === att && Math.hypot(p.state.x - cx, p.state.z - cz) <= reach && Math.abs(p.state.y - cy) <= ASSAULT.campHigh) {
        this.score[att]++;
        events.push({ ev: 'captured', team: def, name: flag.by });
        this.flags[def] = this.homeFlag(def);
        this.best = 1;
      }
    }
    return events;
  }

  /** The spawn truck's stillness clock: reset whenever it moved or turned since the last tick. */
  watchTruck(now) {
    const t = this.truckCar();
    if (!t) return;
    const was = this.truckAt;
    if (!was || Math.hypot(t.x - was.x, t.z - was.z) > 0.05 || Math.abs(t.yaw - was.yaw) > 0.01 || t.driver) {
      this.truckAt = { x: t.x, z: t.z, yaw: t.yaw };
      this.truckSince = now;
    }
  }

  /**
   * Every tick (Modes.flagTick hands it here): the round's flag, the supplies' traps, the heavy weapons, the truck's
   * clock, and the rounds: a capture or the clock ends one; after the first, the break; after the break, the second;
   * after the second, the winner.
   */
  tick(now, modes) {
    const s = modes.state;
    this.watchTruck(now);
    this.supply.fallen();
    const armed = this.arms.step(now);
    if (this.phase === 'break') {
      if (now >= s.until) return this.secondRound(now, modes);
      if (armed) modes.send();
      return;
    }
    const events = this.step(now);
    const traps = this.supply.step(now);
    // The spawn truck became a start place or stopped being one, or stands still now (ammo from it) or not: every page's
    // view (the attackers' line, the prompt by it).
    const was = `${!!this.truckSpawn(now)}:${this.truckStill(now)}`;
    const truck = was !== this.truckWas;
    this.truckWas = was;
    if (events.length) modes.flagEvents(events);
    const cap = events.find((e) => e.ev === 'captured');
    if (cap) return this.roundOver(now, modes, cap.name);
    if (now >= s.until) return this.roundOver(now, modes, null);
    if (events.length || armed || traps || truck) modes.send();
  }

  /** The round is over (`by` captured the flag, or the clock): its result kept, a line for everyone, the break or the end. */
  roundOver(now, modes, by) {
    const def = this.defender();
    const att = other(def);
    const ms = by ? now - this.roundStart : null;
    this.results.push({ def, att, ms, best: by ? 1 : this.best, by: by ?? null });
    const pct = Math.floor((by ? 1 : this.best) * 100);
    if (by) modes.say(`Team ${att === 'blue' ? 'Blue' : 'Red'} captured the flag in ${tenths(ms)} s`, 'assaultCaptured', { team: att, name: by, s: tenths(ms) });
    else modes.say(`Time's up: team ${att === 'blue' ? 'Blue' : 'Red'} got the flag ${pct}% of the way`, 'assaultHeld', { team: att, n: pct });
    if (this.round === 1) return this.breakTime(now, modes);
    this.final(modes);
  }

  /**
   * Between the rounds: the field becomes the Sparrenhof's and the roles swap (the other team defends). Every vehicle of
   * the first round goes, the second's park; the flag home; the traps, the heavy weapons and the waits start again (each
   * round's teams with the same kit); everyone (the downed too, on their own clock) at their new places, protected.
   */
  breakTime(now, modes) {
    const s = modes.state;
    this.phase = 'break';
    s.until = now + ASSAULT.breakMs;
    this.unparkRound(now);
    this.arms.rack(); // every heavy weapon back in its crate, its place free at once
    this.supply.end();
    this.field = fieldOf(ROUND_FIELDS[1]);
    this.swapped = !this.swapped;
    for (const t of ['blue', 'red']) this.flags[t] = this.homeFlag(t);
    this.park(now);
    this.supply.round(now);
    const g = this.game;
    g.teamsChanged([...g.players].filter(([, p]) => !p.guard && p.alive).map(([n]) => n));
    g.flagGuards?.moved?.(now);
    modes.say(`Round 2 in ${Math.round(ASSAULT.breakMs / 1000)} seconds: team ${this.defender() === 'blue' ? 'Blue' : 'Red'} defends the Sparrenhof`, 'assaultBreak', { n: Math.round(ASSAULT.breakMs / 1000), team: this.defender() });
    modes.send();
  }

  /**
   * The second round begins on the break's clock: everyone placed again at their round-2 places and every vehicle back
   * on its spot (whatever was moved in the break), the flag home, then the clock.
   */
  secondRound(now, modes) {
    const s = modes.state;
    this.unparkRound(now);
    this.park(now);
    const g = this.game;
    g.teamsChanged([...g.players].filter(([, p]) => !p.guard && p.alive).map(([n]) => n));
    this.phase = 'live';
    this.round = 2;
    this.roundStart = now;
    this.best = 0;
    s.until = now + this.roundMs;
    for (const t of ['blue', 'red']) this.flags[t] = this.homeFlag(t);
    modes.say(`Round 2: team ${this.defender() === 'blue' ? 'Blue' : 'Red'} defends the Sparrenhof, the others attack from their camp`, 'assaultRound2', { team: this.defender() });
    modes.send();
  }

  /**
   * Both rounds played: the winner (winner() below), the game's end through Modes.finish (the host's scoreboard gives the
   * winning team's players the points, server/host.mjs gameOver).
   */
  final(modes) {
    this.over = true;
    this.arms.end();
    this.supply.end();
    const w = winner(this.results, this.tags);
    const name = (t) => (t === 'blue' ? 'Blue' : 'Red');
    if (!w.team) return modes.finish(`A draw: ${w.why === 'tags' ? `${this.tags.blue} to ${this.tags.red} in tags` : 'level in every way'}`, 'assaultDraw', { a: this.tags.blue, b: this.tags.red });
    const args = { team: w.team, a: w.a, b: w.b };
    if (w.why === 'time') return modes.finish(`Team ${name(w.team)} wins: the fastest capture, ${w.a} s against ${w.b} s`, 'assaultTime', args);
    if (w.why === 'only') return modes.finish(`Team ${name(w.team)} wins: the only capture, in ${w.a} s`, 'assaultOnly', args);
    if (w.why === 'far') return modes.finish(`Team ${name(w.team)} wins: the closest attempt, ${w.a}% against ${w.b}%`, 'assaultFar', args);
    return modes.finish(`Team ${name(w.team)} wins on tags, ${w.a} to ${w.b}`, 'assaultTags', args);
  }

  /** What every page gets (Modes.view `flag`): Steal the flag's view and this game's own part (`assault`). */
  view(now = Date.now()) {
    const v = super.view(now);
    delete v.racks; // no racks in this game: the heavy weapons come from crates
    const traps = this.supply.view();
    const truck = this.truckCar();
    v.assault = {
      round: this.round,
      phase: this.phase,
      def: this.defender(),
      best: Math.floor(this.best * 100),
      results: this.results.map((r) => ({ def: r.def, ms: r.ms, best: Math.floor(r.best * 100) })),
      heavy: this.arms.view(now),
      used: traps.used,
      mines: traps.mines,
      turrets: traps.turrets,
      // The spawn truck a start place now (its car id), for the attackers' line and the map.
      // `still`: standing long enough to give ammo (server/assaultSupply.mjs reaches), for the page's prompt by it.
      truck: truck ? { id: truck.id, spawn: !!this.truckSpawn(now), still: this.truckStill(now) } : null,
    };
    return v;
  }
}

/** ms as seconds to a tenth. */
export function tenths(ms) {
  return Math.round(ms / 100) / 10;
}

/**
 * The game's winner from the two rounds' `results` ({ att, ms, best }) and the teams' `tags` over both rounds:
 * { team, why: 'time' | 'only' | 'far' | 'tags', a, b } (a the winner's figure, b the other's), or { team: null, why }
 * for a draw. The rules, in order: a capture beats none; two captures, the shorter time to a tenth of a second; no
 * capture, the further attempt to a whole per cent; then the most tags; then a draw.
 */
export function winner(results, tags) {
  const by = Object.fromEntries(results.map((r) => [r.att, r]));
  const blue = by.blue ?? { ms: null, best: 0 };
  const red = by.red ?? { ms: null, best: 0 };
  const level = (why) => {
    if (tags.blue === tags.red) return { team: null, why };
    const team = tags.blue > tags.red ? 'blue' : 'red';
    return { team, why: 'tags', a: tags[team], b: tags[other(team)] };
  };
  if (blue.ms !== null && red.ms !== null) {
    const [a, b] = [tenths(blue.ms), tenths(red.ms)];
    if (a === b) return level('tags');
    const team = a < b ? 'blue' : 'red';
    return { team, why: 'time', a: Math.min(a, b), b: Math.max(a, b) };
  }
  if (blue.ms !== null || red.ms !== null) {
    const team = blue.ms !== null ? 'blue' : 'red';
    return { team, why: 'only', a: tenths(by[team].ms), b: Math.floor(by[other(team)]?.best * 100 || 0) };
  }
  const [a, b] = [Math.floor(blue.best * 100), Math.floor(red.best * 100)];
  if (a === b) return level('tags');
  const team = a > b ? 'blue' : 'red';
  return { team, why: 'far', a: Math.max(a, b), b: Math.min(a, b) };
}
