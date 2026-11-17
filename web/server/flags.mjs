// Steal the flag (Yoshi, 16 Nov 2026: "a paintball (kid friendly) team blue vs team red (50/50 split) against each other
// with steal the flag kind of thing. Team blue base: at the church. Team red base: at Sparrenhof."): the server's rules,
// driven from server/modes.mjs (kind 'flag'). The fields, the stands, the start places and the parked vehicles are in
// shared/flagFields.mjs (the page draws the same).
//
// - Blue against red: the host's two evening teams when there are two (server/host.mjs), else everyone split evenly.
// - Each team's flag stands on its stand at its base. Walk into the other team's flag to take it; bring it to your own
//   stand to score, but only while your own flag is home.
// - The carrier may drive or ride a bike; no portal, no trip from the chat, no helicopter seat (game.mjs asks
//   `carrying`). Everyone else may fly: each team has a helicopter near its base (park), and a bazooka on a rack at its
//   base to bring the other team's down (server/flagBazooka.mjs). Down, leaving the game or moved by the server (a respawn, the host bringing them): the flag drops where
//   they were. A teammate of the carrier picks it up by touch; the flag's own team touching it sends it home at once;
//   left alone for RETURN_MS it goes home by itself.
// - Down: back at your own base after BACK_MS, protected for SAFE_MS (ends at your first shot, as always).
// - The clock: the programme's minutes (12 by default). Most captures wins; level, SUDDEN_MS of sudden death where the
//   next capture wins; still level, most tags; still level, a draw.
//
// Guarded against (the attack table: DECISIONS.md, "Steal the flag"):
// - forged pickups and captures: no message takes, drops, returns or scores a flag. Every flag event is derived here,
//   each tick, from where the server has the players (their states, held to the movement budgets, the edge and the
//   seats by game.mjs), alive, on foot or on a bike for a touch, within TOUCH m across and HIGH m in height;
// - teleporting with the flag: a carrier is refused portals, trips from the chat and helicopter seats (game.mjs), and
//   any move the server makes (its `warp` counter: a respawn, a gathering, the host's bring, being put out of a home)
//   drops the flag where the carrier stood before it;
// - team switching to score: a carrier can't switch teams (Modes.choose), a switch is a fresh start at the new base
//   (the flag drops first), the host's teams can't be switched at all, and a capture counts for the carrier's team as
//   it is at that tick, only with that team's own flag home.
// Nothing here is stored or logged.

import { readFileSync } from 'node:fs';
import { loadBounds } from '../shared/bounds.mjs';
import { homeAt } from '../shared/homes.mjs';
import { noShoot } from '../shared/zones.mjs';
import { STAGE } from './vehicleDamage.mjs';
import { FlagBazooka } from './flagBazooka.mjs';
import { FIELDS, FLAG_COLORS, FLAG_TEAMS, fieldEdge, fieldOf } from '../shared/flagFields.mjs';

export { FIELDS, FLAG_COLORS, FLAG_TEAMS };
const BOUNDS = loadBounds(JSON.parse(readFileSync(new URL('../shared/bounds.json', import.meta.url), 'utf8')));
/** Each field's edge, worked out once (game.mjs fence while the game is played). */
const EDGES = Object.fromEntries(Object.values(FIELDS).map((f) => [f.id, fieldEdge(f, BOUNDS)]));
/** ms: the default clock. */
export const FLAG_MS = 12 * 60_000;
/** ms of sudden death after a level clock. */
export const SUDDEN_MS = 5 * 60_000;
/** ms a dropped flag lies before it goes home by itself. */
export const RETURN_MS = 30_000;
/** ms down before you are back at your base. */
export const BACK_MS = 5000;
/** ms of protection when back (ends at your first shot: game.mjs). */
export const SAFE_MS = 3000;
/** ms before whoever dropped a flag may pick it up again (past a reconnect's spawn protection). */
export const REGRAB_MS = 5000;
/** m across from a flag (on its stand or on the ground) to a player's middle for a touch. */
export const TOUCH = 1.6;
/** m across from your own stand for a capture on foot or on a bike, and in a car (its middle). */
export const CAPTURE = 2.2;
export const CAPTURE_CAR = 4.5;
/** m in height between a player's feet and a flag's foot for a touch or a capture. */
export const HIGH = 2.2;
/** m across from a stand and m over the ground: a helicopter nearer and lower is sent back to its spot (keepStandsFree). */
export const STAND_KEEP = 14;
export const STAND_LOW = 8;

const other = (team) => (team === 'blue' ? 'red' : 'blue');
/** 'zone' in a place nobody fights in (shared/zones.mjs), 'home' inside a private home (shared/homes.mjs), else null. */
const safeAt = (x, y, z) => (noShoot(x, z) ? 'zone' : homeAt(x, z, y) ? 'home' : null);
const round = (v) => Math.round(v * 100) / 100;

export class FlagGame {
  /**
   * `game`: the Game (server/game.mjs); `fieldId`: 'compact' or 'village' (anything else plays compact); `teams`: the
   * modes' table of player name -> 'blue' | 'red' (shared with Modes.state.teams); `look`: the programme's look.
   */
  constructor(game, fieldId, teams, look, now = Date.now()) {
    this.game = game;
    this.field = fieldOf(fieldId);
    /** The edge that holds while it is played (game.mjs fence) */
    this.edge = EDGES[this.field.id];
    this.teams = teams;
    this.look = look ?? null;
    this.score = { blue: 0, red: 0 };
    this.tags = { blue: 0, red: 0 };
    this.sudden = false;
    /** team -> its flag: at 'home', 'carried' (by a name) or on the 'ground' (since when) */
    this.flags = Object.fromEntries(FLAG_TEAMS.map((t) => [t, this.homeFlag(t)]));
    this.started = now;
    this.vehicles = { cars: [], bikes: [], helis: [] };
    /** Each team's bazooka on its rack (server/flagBazooka.mjs) */
    this.arms = new FlagBazooka(game, this);
  }

  homeFlag(team) {
    const s = this.field.bases[team].stand;
    return { at: 'home', by: null, x: s[0], y: s[2], z: s[1], since: 0, warp: 0 };
  }

  /** The team of the flag `name` carries, or null. */
  carrying(name) {
    for (const t of FLAG_TEAMS) if (this.flags[t].at === 'carried' && this.flags[t].by === name) return t;
    return null;
  }

  /**
   * A start place at the player's base: one of its spots (the least crowded of a few picked at random), on the ground,
   * facing the stand. For game.mjs respawn ({ spawn, x, y, z, face }), or null for a player on no team.
   */
  baseSpot(name) {
    const team = this.teams[name];
    if (!team) return null;
    const base = this.field.bases[team];
    const others = [...this.game.players].filter(([n, o]) => n !== name && o.alive && o.state).map(([, o]) => o.state);
    const ranked = base.spawns.map(([x, z, y]) => ({ x, z, y, d: others.length ? Math.min(...others.map((o) => Math.hypot(o.x - x, o.z - z))) : Math.random() }))
      .sort((a, b) => b.d - a.d);
    const s = ranked[Math.floor(Math.random() * Math.min(3, ranked.length))];
    return { spawn: 0, x: s.x, y: s.y, z: s.z, face: [base.stand[0], base.stand[1]] };
  }

  /** Whether player `name` (`p`) may touch a flag now: alive, on foot or on a bike, not in a car, a helicopter or a drop. */
  canTouch(name, p, now) {
    const g = this.game;
    return !!p && !p.guard && p.alive && !!p.state && !g.carOf?.(name) && !g.helis?.of(name) && !g.horseOf?.(name) && !g.dropping?.(p, now) && !p.state.flying;
  }

  near(st, x, y, z, reach) {
    return Math.hypot(st.x - x, st.z - z) <= reach && Math.abs(st.y - y) <= HIGH;
  }

  /**
   * One tick: every flag's carrier followed (and dropped when down, gone or moved by the server), dropped flags sent home
   * after RETURN_MS or by their own team's touch or picked up by the carrier's team, flags on their stands taken, and
   * captures. Returns the events in order: { ev: 'taken' | 'dropped' | 'returned' | 'captured', team, name }, `team`
   * being the flag's.
   */
  step(now) {
    const g = this.game;
    const events = [];
    for (const team of FLAG_TEAMS) {
      const f = this.flags[team];
      if (f.at !== 'carried') continue;
      const p = g.players.get(f.by);
      const st = p?.state;
      if (!p || !st) { // left: where the server had them last
        events.push(this.drop(team, now));
        continue;
      }
      if (p.warp !== f.warp) { // moved by the server (a respawn, a gathering, the host's bring): where they stood before
        this.game.send(p.ws, { t: 'system', text: 'You were moved, so the flag dropped where you stood.', code: 'flagMoved' });
        events.push(this.drop(team, now));
        continue;
      }
      // Into a place nobody fights in (the school grounds) or a private home: no hiding with it. Home at once.
      const safe = safeAt(st.x, st.y, st.z);
      if (safe) {
        const name = f.by;
        this.flags[team] = this.homeFlag(team);
        events.push({ ev: 'safe', team, name, why: safe });
        continue;
      }
      if (!p.alive || this.teams[f.by] === team || !this.teams[f.by]) { // down (where they fell), or no longer on the other team
        Object.assign(f, { x: round(st.x), y: round(st.y), z: round(st.z) });
        events.push(this.drop(team, now));
        continue;
      }
      Object.assign(f, { x: round(st.x), y: round(st.y), z: round(st.z) });
    }
    for (const team of FLAG_TEAMS) {
      const f = this.flags[team];
      if (f.at === 'ground' && now - f.since >= RETURN_MS) {
        this.flags[team] = this.homeFlag(team);
        events.push({ ev: 'returned', team, name: '' });
      }
    }
    // Touches, in a random order each tick: two players reaching a flag in the same tick get an even chance.
    const names = [...g.players.keys()].sort(() => Math.random() - 0.5);
    for (const name of names) {
      const p = g.players.get(name);
      const mine = this.teams[name];
      if (!mine || !this.canTouch(name, p, now)) continue;
      const st = p.state;
      const theirs = other(mine);
      const own = this.flags[mine];
      const enemy = this.flags[theirs];
      // Your own flag on the ground: home at once.
      if (own.at === 'ground' && this.near(st, own.x, own.y, own.z, TOUCH)) {
        this.flags[mine] = this.homeFlag(mine);
        events.push({ ev: 'returned', team: mine, name });
      }
      // The other team's flag, on its stand or on the ground: yours to carry (one flag a player; the enemy's only).
      // Not straight back by whoever dropped it (logging in again where it fell, with a reconnect's fresh protection).
      const regrab = enemy.at === 'ground' && enemy.dropper === name && now - enemy.since < REGRAB_MS;
      if ((enemy.at === 'home' || enemy.at === 'ground') && !regrab && this.near(st, enemy.x, enemy.y, enemy.z, TOUCH)) {
        Object.assign(enemy, { at: 'carried', by: name, since: now, warp: p.warp, x: round(st.x), y: round(st.y), z: round(st.z) });
        events.push({ ev: 'taken', team: theirs, name });
      }
    }
    this.keepStandsFree(now);
    // Captures: the carrier at their own stand (in a car too), with their own flag home.
    for (const team of FLAG_TEAMS) {
      const f = this.flags[team];
      if (f.at !== 'carried') continue;
      const p = g.players.get(f.by);
      const mine = this.teams[f.by];
      if (!p?.alive || !p.state || mine !== other(team) || this.flags[mine].at !== 'home') continue;
      const s = this.field.bases[mine].stand;
      const reach = g.carOf?.(f.by) ? CAPTURE_CAR : CAPTURE;
      if (!this.near(p.state, s[0], s[2], s[1], reach)) continue;
      this.score[mine]++;
      events.push({ ev: 'captured', team, name: f.by });
      this.flags[team] = this.homeFlag(team);
    }
    return events;
  }

  /**
   * No helicopter at a base (griefing: a machine set down on a stand, or hovering low over it, blocks the flag and the
   * capture ring): one within STAND_KEEP m across of either stand and under STAND_LOW m over the ground is put back on
   * its own spot at once, whoever is aboard put out where it was (on the ground, or by parachute when high enough), and
   * told why. The machines' spots (shared/heli.json pads, shared/flagFields.mjs) are all further off.
   */
  keepStandsFree(now) {
    const helis = this.game.helis;
    if (!helis?.machines) return;
    for (const h of helis.machines.values()) {
      if (this.game.vehicleDamage?.out?.('heli', h.id)) continue; // a wreck lies where it fell (server/vehicleDamage.mjs)
      const low = h.y - helis.floor(h.x, h.z) < STAND_LOW;
      if (!low || !FLAG_TEAMS.some((t) => Math.hypot(h.x - this.field.bases[t].stand[0], h.z - this.field.bases[t].stand[1]) < STAND_KEEP)) continue;
      const aboard = h.seats.filter(Boolean);
      for (const n of aboard) helis.putOut(n, now);
      for (const n of aboard) {
        const p = this.game.players.get(n);
        if (p) this.game.send(p.ws, { t: 'system', text: 'No helicopter at a base: it went back to its spot.', code: 'flagHeliBase' });
      }
      helis.home(h, now, true);
    }
  }

  /** The flag of `team` falls where it is now (its carrier's last place). */
  drop(team, now) {
    const f = this.flags[team];
    const name = f.by;
    // Never left lying where nobody fights or inside a private home (pages that may not see in would be told where).
    const safe = safeAt(f.x, f.y, f.z);
    if (safe) {
      this.flags[team] = this.homeFlag(team);
      return { ev: 'safe', team, name, why: safe };
    }
    Object.assign(f, { at: 'ground', by: null, since: now, dropper: name });
    return { ev: 'dropped', team, name };
  }

  /** A tag of `victim` by `killer` (game.mjs damage via Modes.scored): counts for the tie at the end. */
  tagged(killer, victim) {
    const team = this.teams[killer];
    if (team && team !== this.teams[victim]) this.tags[team]++;
  }

  /** A player switches team or leaves: a flag they carry falls where they are. */
  release(name, now) {
    const team = this.carrying(name);
    if (!team) return null;
    const st = this.game.players.get(name)?.state;
    if (st) Object.assign(this.flags[team], { x: round(st.x), y: round(st.y), z: round(st.z) });
    return this.drop(team, now);
  }

  /** What every page gets (Modes.view `flag`): the field, each flag's state, the tags and sudden death. */
  view(now = Date.now()) {
    const flags = {};
    for (const t of FLAG_TEAMS) {
      const f = this.flags[t];
      // Carried: only who carries it (the pages draw it on their figure, where they may see them); never its place.
      flags[t] = f.at === 'carried' ? { at: f.at, by: f.by } : { at: f.at, x: f.x, y: f.y, z: f.z, ...(f.at === 'ground' ? { ms: Math.max(0, RETURN_MS - (now - f.since)) } : {}) };
    }
    return { field: this.field.id, flags, tags: { ...this.tags }, sudden: this.sudden, vehicles: this.vehicles.bikes.length ? { bikes: [...this.vehicles.bikes] } : undefined, racks: this.arms.over ? undefined : this.arms.view(now) };
  }

  // ------------------------------------------------------------------ the parked vehicles

  /**
   * The field's vehicles at each base, for as long as the game runs (shared/flagFields.mjs): in both fields and every
   * look a helicopter for each team (blue the church's on its deck, red the house's set down near its base), whole and
   * on its spot whatever it was before (a wreck, flown off); in the village field cars in the team's colour (the placed
   * Teslas' list, never stored) and bikes (the field's own ids, drawn by every page from the same file).
   */
  park(now) {
    const g = this.game;
    for (const team of FLAG_TEAMS) {
      const spot = this.field.heli?.[team];
      const h = spot && g.helis?.machines.get(spot.id);
      const inner = h && g.helis.inner.get(spot.id);
      if (!h || !inner) continue;
      for (const n of h.seats) if (n) g.helis.putOut(n, now);
      this.whole(h);
      this.vehicles.helis.push({ id: spot.id, park: inner.park });
      if (typeof spot.x === 'number') inner.park = { x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw };
      g.helis.park(h, now);
    }
    const v = this.field.vehicles;
    if (!v) return;
    for (const team of FLAG_TEAMS) {
      for (const [i, c] of (v[team].cars ?? []).entries()) {
        const id = `f${team[0]}${i + 1}`;
        if (Object.hasOwn(g.cars, id)) continue;
        g.cars[id] = { id, kind: c.kind, x: c.x, y: c.y, z: c.z, yaw: c.yaw, s: 0, driver: null, passenger: null, by: '', flag: true };
        g.carAt[id] = 0;
        this.vehicles.cars.push(id);
      }
      for (const k of v[team].bikes ?? []) {
        if (Object.hasOwn(g.bikes, k.id)) continue;
        g.bikes[k.id] = { id: k.id, x: k.x, y: k.y, z: k.z, yaw: k.yaw, rider: null, lie: 0 };
        g.bikeAt[k.id] = 0;
        this.vehicles.bikes.push(k.id);
      }
    }
    if (this.vehicles.cars.length) g.sendPlaced();
    for (const id of this.vehicles.bikes) g.broadcastThing({ t: 'bike', bike: g.bikes[id] }, 'bike', g.bikes[id]);
  }

  /**
   * Machine `h` whole again (server/vehicleDamage.mjs): its damage forgotten and every page told, so a wreck from before
   * the game (or from the game, as it ends) is whole on its spot.
   */
  whole(h) {
    if (this.game.vehicleDamage?.recs?.delete(`heli:${h.id}`)) this.game.broadcastThing({ t: 'vdmg', k: 'heli', id: h.id, hp: 100, st: STAGE.whole }, 'heli', h);
  }

  /**
   * The game is over: the field's vehicles go (whoever sits in one gets out first), the helicopters back to their own
   * pads, whole; the bazookas out of everyone's hands (server/flagBazooka.mjs end).
   */
  unpark(now) {
    const g = this.game;
    this.arms.end();
    for (const id of this.vehicles.cars) {
      const c = g.cars[id];
      if (!c?.flag) continue;
      if (c.driver) g.releaseCar(c.driver);
      if (c.passenger) g.releaseCar(c.passenger);
      // Damaged or a wreck (server/vehicleDamage.mjs): every page told it is whole before it goes, so the same car parked
      // by the next game is no wreck on any page (the record would be dropped without a word once the car is gone).
      if (g.vehicleDamage?.recs?.delete(`car:${id}`)) g.broadcastThing({ t: 'vdmg', k: 'car', id, hp: 100, st: STAGE.whole }, 'car', c);
      delete g.cars[id];
      delete g.carAt[id];
    }
    if (this.vehicles.cars.length) g.sendPlaced();
    for (const id of this.vehicles.bikes) {
      const k = g.bikes[id];
      if (!k) continue;
      if (k.rider) g.releaseBike(k.rider);
      delete g.bikes[id];
      delete g.bikeAt[id];
    }
    for (const heli of this.vehicles.helis) {
      const h = g.helis?.machines.get(heli.id);
      if (!h) continue;
      g.helis.inner.get(heli.id).park = heli.park;
      for (const n of h.seats) if (n) g.helis.putOut(n, now);
      this.whole(h);
      g.helis.park(h, now);
    }
    this.vehicles = { cars: [], bikes: [], helis: [] };
  }
}
