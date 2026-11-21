// Steal the flag (Yoshi, 16 Nov 2026: "a paintball (kid friendly) team blue vs team red (50/50 split) against each other
// with steal the flag kind of thing. Team blue base: at the church. Team red base: at Sparrenhof."): the server's rules,
// driven from server/modes.mjs (kind 'flag'). The fields, the stands, the start places and the parked vehicles are in
// shared/flagFields.mjs (the page draws the same).
//
// - Blue against red: the host's two evening teams when there are two (server/host.mjs), else everyone dealt evenly at
//   random (and that deal becomes the host's). Only the host moves a player (Yoshi, 17 Nov 2026: "team switches should
//   only be done by the admin"), and only the host swaps the sides (swap).
// - Each team's flag stands on its stand at its base. Walk into the other team's flag to take it; bring it to your own
//   stand to score, but only while your own flag is home.
// - The carrier may drive or ride a bike; no portal, no trip from the chat, no helicopter seat (game.mjs asks
//   `carrying`). Everyone else may fly: each team has a helicopter near its base (park), and a bazooka on a rack at its
//   base to bring the other team's down (server/flagBazooka.mjs). Down, leaving the game or moved by the server (a respawn, the host bringing them): the flag drops where
//   they were. A teammate of the carrier picks it up by touch; the flag's own team touching it sends it home at once;
//   left alone for RETURN_MS it goes home by itself.
// - Down: back at your own base after BACK_MS, protected for SAFE_MS (ends at your first shot, as always, and when you
//   take or return a flag).
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
// - team switching to score, and swapping sides (privilege escalation): no player switches team (Modes.choose refuses
//   every ask), the host's move is a fresh start at the new base (the flag and the launcher drop first), the host's
//   swap is checked there (admin only, this game played, SWAP_MS), and a capture counts for the carrier's team as it is
//   at that tick, only with that team's own flag home;
// - protected touches: taking or returning a flag ends spawn protection, so nobody carries one protected.
// - spawn forgery and spawn camping: where a player starts and comes back is the server's choice alone (baseSpot), from
//   the positions it holds; no message asks for a place. A free place only (nobody within FREE_R m), away from the
//   opponents there, never where a teammate was just tagged; every place outside the locked homes and their gardens
//   (server/teamStarts.mjs base). Tests: server/basePlaces.test.mjs.
// Nothing here is stored or logged.

import { readFileSync } from 'node:fs';
import { loadBounds } from '../shared/bounds.mjs';
import { homeAt } from '../shared/homes.mjs';
import { STAGE } from './vehicleDamage.mjs';
import { FlagBazooka } from './flagBazooka.mjs';
import { FIELDS, FLAG_COLORS, FLAG_TEAMS, baseOf, fieldEdge, fieldOf, vehicleTeam } from '../shared/flagFields.mjs';

export { FIELDS, FLAG_COLORS, FLAG_TEAMS };
const BOUNDS = loadBounds(JSON.parse(readFileSync(new URL('../shared/bounds.json', import.meta.url), 'utf8')));
/** The village's own bikes (their parking places): one out of play for a game is back there after it. */
const BIKES = JSON.parse(readFileSync(new URL('../shared/bike.json', import.meta.url), 'utf8')).bikes;
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
/** ms at least between two swaps of the sides (the host's, never automatic: swap). */
export const SWAP_MS = 10_000;
/** m across from a stand and m over the ground: a helicopter nearer and lower is sent back to its spot (keepStandsFree). */
export const STAND_KEEP = 14;
export const STAND_LOW = 8;
/** m: an opponent further from a start place than this counts as none near it (baseSpot). */
export const FOE_R = 40;
/** ms and m: a start place within DOWN_R of where a teammate was tagged in the last DOWN_MS is the last choice. */
export const DOWN_MS = 8000;
export const DOWN_R = 3; // the spots stand 3.2 m or more apart (shared/flagFields.mjs)
/** m: a place with anyone standing within this of it is taken (baseSpot): nobody starts inside another. */
export const FREE_R = 1.2;
/**
 * m and the angle's cosine: someone this near straight ahead of a place or behind it (all of a base's places face its
 * way out) would fill a player's first view, or stand in theirs; such a place counts as LINE_COST m nearer the opponents
 * (baseSpot: past the best three, while others are free).
 */
const LINE_M = 3.2;
const LINE_COS = Math.cos((40 * Math.PI) / 180); // 30 degrees each way of the view, and the places' ways differ a little
const LINE_COST = 4;
/**
 * m kept clear round what stands at a base (places): the stand (its touch and capture ring), the bazooka rack (its
 * take), a helicopter's spot (its rotor), a parked car (the truck), a bike, a crate, a camp's lamp, tent and supply truck.
 */
const CLEAR = Object.freeze({ stand: 3, rack: 2.8, heli: 8, car: 3.4, truck: 5, bike: 1.2, crate: 1.5, lamp: 1.2, tent: 4.6, supply: 4.2 });
/**
 * m from the base's edge (a field's band) to a place, and how much nearer the other base than the base's own start places
 * a place may be (places).
 */
const EDGE_IN = 1.5;
const FORE = 2;
/**
 * m a place may be further from its stand than the base's furthest own start place (the base, not beyond it), and m
 * from the stand every base may reach (a camp's own start places stand 6.5 m from its flag: room for a team of 30).
 */
const REACH = 10;
const REACH_MIN = 18;

const other = (team) => (team === 'blue' ? 'red' : 'blue');
/**
 * 'home' inside a private home (shared/homes.mjs), else null. The school grounds are no hiding place in this game: it is
 * a team match, and they are open to its fight there (Yoshi, 17 Nov 2026: "School zone ok to shoot in team v team"), so
 * the carrier keeps the flag on them and a flag dropped there lies there.
 */
const safeAt = (x, y, z) => (homeAt(x, z, y) ? 'home' : null);
const round = (v) => Math.round(v * 100) / 100;

/**
 * What stands at `field`'s bases, as circles no start place is in (places): both stands and racks, the helicopters'
 * spots, the parked cars and bikes; Attack and defend's crates, and its camp's lamps, tents and supply truck (solid: no
 * place behind them either, the page's walls).
 */
function keepOf(field) {
  const k = [];
  const add = (x, z, r, solid = false) => k.push({ x, z, r, solid });
  for (const t of FLAG_TEAMS) {
    const b = field.bases[t];
    add(b.stand[0], b.stand[1], CLEAR.stand);
    if (b.rack) add(b.rack[0], b.rack[1], CLEAR.rack);
    const h = field.heli?.[t];
    if (h) add(h.x, h.z, CLEAR.heli);
    for (const c of field.vehicles?.[t].cars ?? []) add(c.x, c.z, c.kind.startsWith('truck') ? CLEAR.truck : CLEAR.car);
    for (const c of field.vehicles?.[t].bikes ?? []) add(c.x, c.z, CLEAR.bike);
  }
  const a = field.assault;
  if (a) {
    for (const c of [...a.crates, ...a.camp.crates]) add(c.at[0], c.at[1], CLEAR.crate);
    for (const [x, z] of a.camp.lamps) add(x, z, CLEAR.lamp);
    for (const [x, z] of a.camp.tents) add(x, z, CLEAR.tent, true);
    add(a.camp.supply[0], a.camp.supply[1], CLEAR.supply, true);
  }
  return k;
}

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
    /** Where players were tagged lately: { team (the victim's), x, z, at }, for baseSpot */
    this.downs = [];
    /** Each base's start places, by field and side, worked out at its first use (places) */
    this.placeSets = new Map();
    this.vehicles ={ cars: [], bikes: [], helis: [], off: [] };
    /** The sides swapped (the host's `swap`): blue plays from red's base and red from blue's. */
    this.swapped = false;
    this.swapAt = -Infinity;
    /** Each team's bazooka on its rack (server/flagBazooka.mjs) */
    this.arms = new FlagBazooka(game, this);
  }

  /** The base `team` plays from now: its own, or with the sides swapped the other team's (shared/flagFields.mjs baseOf). */
  baseOf(team) {
    return baseOf(this.field, team, this.swapped);
  }

  /** The team playing from the base the field gives `side` (blue's or red's) now. */
  sideOf(side) {
    return this.swapped ? other(side) : side;
  }

  /**
   * The team a vehicle of the field belongs to now, or null: each team's helicopter and the cars parked at its base
   * (they trade with the bases when the sides swap). Its own team does it no damage (server/vehicleDamage.mjs mayDamage).
   */
  owner(kind, id) {
    if (kind === 'car' && !this.vehicles.cars.includes(id)) return null;
    return vehicleTeam(this.field, kind, id, this.swapped);
  }

  homeFlag(team) {
    const s = this.baseOf(team).stand;
    return { at: 'home', by: null, x: s[0], y: s[2], z: s[1], since: 0, warp: 0 };
  }

  /** The team of the flag `name` carries, or null. */
  carrying(name) {
    for (const t of FLAG_TEAMS) if (this.flags[t].at === 'carried' && this.flags[t].by === name) return t;
    return null;
  }

  /** Where the places of the base on `side` (the field's blue or red) face: their own stand, the field beyond it. */
  wayOut(side) {
    const [x, z] = this.field.bases[side].stand;
    return { x, z };
  }

  /**
   * The start places of the base `team` plays from: one for every player of a team and more (a team of 30 has room), so
   * nobody starts inside another. Round the base's own start places (shared/flagFields.mjs spawns) as the team deathmatch
   * spreads round its start (server/teamStarts.mjs base): the start places first, then rings round them, each place on
   * free ground reached without crossing a wall, out of the water, the homes (1.5 m from their walls) and their gardens,
   * inside the field (EDGE_IN m from its edge), clear of what stands at the base (keepOf), never nearer the other base
   * than the base's own start places are (FORE m of slack: the rings grow back and to the sides, not towards the
   * opponents), no further from the stand than its furthest own start place and REACH m (REACH_MIN m at least), BASE_GAP
   * m apart, each facing the way out of the base (wayOut). Worked out once a game for each base,
   * from the server's own map.
   */
  places(team) {
    const side = this.swapped ? other(team) : team;
    const key = `${this.field.id}:${side}`;
    let set = this.placeSets.get(key);
    if (set) return set;
    const base = this.field.bases[side];
    const ts = this.game.teamStarts;
    if (ts) {
      const [sx, sz] = base.stand;
      const [ox, oz] = this.field.bases[other(side)].stand;
      const d = Math.hypot(ox - sx, oz - sz) || 1;
      const ux = (ox - sx) / d, uz = (oz - sz) / d; // from this stand towards the other base
      const fore = (x, z) => (x - sx) * ux + (z - sz) * uz;
      const max = Math.max(...base.spawns.map(([x, z]) => fore(x, z))) + FORE;
      const reach = Math.max(REACH_MIN, ...base.spawns.map(([x, z]) => Math.hypot(x - sx, z - sz) + REACH));
      const ok = (x, z) => fore(x, z) <= max && Math.hypot(x - sx, z - sz) <= reach;
      set = ts.base(base.spawns, { edge: this.edge, inset: EDGE_IN, keep: keepOf(this.field), toward: this.wayOut(side), ok });
    }
    // Never none (a game without the starts' checks, in a test): the base's own start places, facing the stand.
    if (!set?.length) set = base.spawns.map(([x, z, y]) => ({ x, y, z, ring: 0, face: [base.stand[0], base.stand[1]] }));
    this.placeSets.set(key, set);
    return set;
  }

  /**
   * A start place at the player's base (places), on the ground, facing the way out. For game.mjs respawn
   * ({ spawn, x, y, z, face }), or null for a player on no team. Only a free place: nobody standing within FREE_R m of it
   * (a teammate, an opponent, a guard). The free places are ranked by the nearest opponent within FOE_R m (teammates
   * don't count: coming back beside your own team is fine), a place where a teammate was tagged in the last DOWN_MS
   * last of all, one with someone right ahead of it or behind it (LINE_M) a little lower, and nobody near, the inner
   * places first (the base's own start places, then the first ring, ...); one of the best (up to three, within 3 m of
   * the best) picked at random. Every place taken (more players at a base than it has places): the one with the most
   * room round it.
   * The server's choice alone: no page asks for a spot.
   */
  baseSpot(name) {
    const team = this.teams[name];
    if (!team) return null;
    const places = this.places(team);
    const now = Date.now();
    const live = [...this.game.players].filter(([n, o]) => n !== name && o.alive && o.state).map(([n, o]) => ({ n, s: o.state }));
    const foes = live.filter(({ n }) => this.teams[n] === other(team)).map(({ s }) => s);
    const downs = this.downs.filter((d) => d.team === team && now - d.at < DOWN_MS);
    const room = (q) => Math.min(Infinity, ...live.map(({ s }) => Math.hypot(s.x - q.x, s.z - q.z)));
    const free = places.filter((q) => room(q) >= FREE_R);
    if (!free.length) {
      const q = places.reduce((a, b) => (room(b) > room(a) ? b : a));
      return { spawn: 0, x: q.x, y: q.y, z: q.z, face: q.face };
    }
    const ranked = free.map((q) => {
      const foe = Math.min(FOE_R, ...foes.map((o) => Math.hypot(o.x - q.x, o.z - q.z)));
      const hot = downs.some((d) => Math.hypot(d.x - q.x, d.z - q.z) < DOWN_R);
      // Someone right ahead or behind: the places of a base all face about one way.
      const fl = Math.hypot(q.face[0] - q.x, q.face[1] - q.z) || 1;
      const inLine = live.some(({ s }) => {
        const dx = s.x - q.x, dz = s.z - q.z;
        const d = Math.hypot(dx, dz);
        return d < LINE_M && Math.abs((dx * (q.face[0] - q.x) + dz * (q.face[1] - q.z)) / (d * fl)) > LINE_COS;
      });
      const inner = q.ring * 0.5 * (foe / FOE_R); // nobody near: the inner places first; opponents near: their distance counts
      return { q, d: foe - (hot ? 1000 : 0) - (inLine ? LINE_COST : 0) - inner + Math.random() * 0.01 };
    }).sort((a, b) => b.d - a.d);
    const best = ranked.filter((r, i) => i < 3 && r.d >= ranked[0].d - 3); // only the clearly best
    const { q } = best[Math.floor(Math.random() * best.length)];
    return { spawn: 0, x: q.x, y: q.y, z: q.z, face: q.face };
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
      // Into a private home: no hiding with it. Home at once.
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
        p.protectedUntil = 0; // touching a flag ends your spawn protection, as a first shot does
      }
      // The other team's flag, on its stand or on the ground: yours to carry (one flag a player; the enemy's only).
      // Not straight back by whoever dropped it (logging in again where it fell, with a reconnect's fresh protection).
      const regrab = enemy.at === 'ground' && enemy.dropper === name && now - enemy.since < REGRAB_MS;
      if ((enemy.at === 'home' || enemy.at === 'ground') && !regrab && this.near(st, enemy.x, enemy.y, enemy.z, TOUCH)) {
        Object.assign(enemy, { at: 'carried', by: name, since: now, warp: p.warp, x: round(st.x), y: round(st.y), z: round(st.z) });
        events.push({ ev: 'taken', team: theirs, name });
        p.protectedUntil = 0; // nobody carries a flag protected
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
      const s = this.baseOf(mine).stand;
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
      if (!low || !FLAG_TEAMS.some((t) => Math.hypot(h.x - this.field.bases[t].stand[0], h.z - this.field.bases[t].stand[1]) < STAND_KEEP)) continue; // both stands, swapped or not
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
    // Never left lying inside a private home (pages that may not see in would be told where).
    const safe = safeAt(f.x, f.y, f.z);
    if (safe) {
      this.flags[team] = this.homeFlag(team);
      return { ev: 'safe', team, name, why: safe };
    }
    Object.assign(f, { at: 'ground', by: null, since: now, dropper: name });
    return { ev: 'dropped', team, name };
  }

  /**
   * A tag of `victim` by `killer` (game.mjs damage via Modes.scored): counts for the tie at the end, and where it
   * happened is kept for DOWN_MS so nobody of the victim's team comes back there meanwhile (baseSpot).
   */
  tagged(killer, victim) {
    const team = this.teams[killer];
    if (team && team !== this.teams[victim]) this.tags[team]++;
    const st = this.game.players.get(victim)?.state;
    const now = Date.now();
    this.downs = this.downs.filter((d) => now - d.at < DOWN_MS).slice(-63);
    if (st && this.teams[victim]) this.downs.push({ team: this.teams[victim], x: st.x, z: st.z, at: now });
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
    // `swapped`: the sides traded bases (every page draws the stands, the racks and the marks there; a page joining
    // later too). `vehicles`: the field's bikes parked, and the village's own bikes out of play for the game (`off`).
    const v = this.vehicles;
    return {
      field: this.field.id, flags, tags: { ...this.tags }, sudden: this.sudden, swapped: this.swapped || undefined,
      vehicles: v.bikes.length || v.off.length ? { bikes: [...v.bikes], off: [...v.off] } : undefined, racks: this.arms.over ? undefined : this.arms.view(now),
    };
  }

  // ------------------------------------------------------------------ the parked vehicles

  /**
   * The field's vehicles at each base, for as long as the game runs (shared/flagFields.mjs): in both fields and every
   * look a helicopter for each team, set down on the ground near its base, whole and on its spot whatever it was before
   * (a wreck, flown off); cars in the team's colour (the placed Teslas' list, never stored) and bikes (the field's own
   * ids, drawn by every page from the same file); and the village's own vehicles by a base that only one team would
   * have (`off`: the church's Teslas, the bikes on the racks by the stands) out of play until the game is over.
   */
  park(now) {
    const g = this.game;
    for (const side of FLAG_TEAMS) {
      const spot = this.field.heli?.[side];
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
    for (const side of FLAG_TEAMS) {
      for (const [i, c] of (v?.[side].cars ?? []).entries()) {
        const id = `f${side[0]}${i + 1}`;
        if (Object.hasOwn(g.cars, id)) continue;
        g.cars[id] = { id, kind: this.carKind?.(side, c.kind) ?? c.kind, x: c.x, y: c.y, z: c.z, yaw: c.yaw, s: 0, driver: null, passenger: null, by: '', flag: true }; // Attack and defend paints them (server/assault.mjs carKind)
        g.carAt[id] = 0;
        this.vehicles.cars.push(id);
      }
      for (const k of v?.[side].bikes ?? []) {
        if (Object.hasOwn(g.bikes, k.id)) continue;
        g.bikes[k.id] = { id: k.id, x: k.x, y: k.y, z: k.z, yaw: k.yaw, rider: null, lie: 0 };
        g.bikeAt[k.id] = 0;
        this.vehicles.bikes.push(k.id);
      }
    }
    for (const id of this.field.off?.cars ?? []) g.vehicleDamage?.hold('car', id); // gone until the match is over (server/vehicleDamage.mjs)
    for (const id of this.field.off?.bikes ?? []) {
      const k = g.bikes[id];
      if (!k || this.vehicles.off.includes(id)) continue;
      if (k.rider) g.releaseBike(k.rider);
      delete g.bikes[id];
      delete g.bikeAt[id];
      this.vehicles.off.push(id);
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

  /** Car `id` whole again: its damage forgotten and every page told (a car the field parks, or one held out of play). */
  wholeCar(id) {
    const c = this.game.cars[id];
    if (c && this.game.vehicleDamage?.recs?.delete(`car:${id}`)) this.game.broadcastThing({ t: 'vdmg', k: 'car', id, hp: 100, st: STAGE.whole }, 'car', c);
  }

  /**
   * The game is over: the field's vehicles go (whoever sits in one gets out first), the helicopters back to their own
   * pads, whole; the village's own vehicles held out of play back, whole; the bazookas out of everyone's hands
   * (server/flagBazooka.mjs end).
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
      this.wholeCar(id);
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
    // Straight into another team match the held cars would stay gone (vehicleDamage lets go only once none is on).
    for (const id of this.field.off?.cars ?? []) this.wholeCar(id);
    for (const id of this.vehicles.off) {
      const park = BIKES[id]?.park;
      if (!park || Object.hasOwn(g.bikes, id)) continue;
      g.bikes[id] = { id, ...park, rider: null, lie: 0 };
      g.bikeAt[id] = 0;
      g.broadcastThing({ t: 'bike', bike: g.bikes[id] }, 'bike', g.bikes[id]);
    }
    this.vehicles = { cars: [], bikes: [], helis: [], off: [] };
  }

  // ------------------------------------------------------------------ swapping sides

  /**
   * The host swaps the sides (server/host.mjs `swap`; Yoshi, 17 Nov 2026: "Swapping sides only at request of the
   * admin"): never automatic, only while the game is played (Modes.swapSides), at most once in SWAP_MS. Both flags home;
   * every launcher back on its rack; blue and red trade bases, stands, racks, start places, vehicles and helicopters
   * (whoever sits in one is put out first, every machine whole on its spot at the base, the cars in the colour of the
   * team now there); everyone at their team's new base, protected for SAFE_MS (game.mjs teamsChanged, respawn). The
   * scores, the tags and the clock carry on. Returns the event for every page, or { error, code }.
   */
  swap(now) {
    if (now - this.swapAt < SWAP_MS) return { error: 'Wait a few seconds before swapping again', code: 'tooFast' };
    const g = this.game;
    this.swapAt = now;
    this.swapped = !this.swapped;
    for (const t of FLAG_TEAMS) this.flags[t] = this.homeFlag(t);
    this.arms.rack();
    // The field's vehicles stay at their bases, which change hands: every seat emptied, every machine back on its spot.
    for (const heli of this.vehicles.helis) {
      const h = g.helis?.machines.get(heli.id);
      if (!h) continue;
      for (const n of h.seats) if (n) g.helis.putOut(n, now);
      this.whole(h);
      g.helis.park(h, now);
    }
    const v = this.field.vehicles;
    for (const id of this.vehicles.cars) {
      const c = g.cars[id];
      const side = id[1] === 'b' ? 'blue' : 'red';
      const spot = v?.[side].cars[Number(id.slice(2)) - 1];
      if (!c || !spot) continue;
      if (c.driver) g.releaseCar(c.driver);
      if (c.passenger) g.releaseCar(c.passenger);
      this.wholeCar(id);
      Object.assign(c, { x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, s: 0, kind: spot.kind.replace(/-(blue|red)$/, `-${this.sideOf(side)}`) });
      g.carAt[id] = 0;
    }
    if (this.vehicles.cars.length) g.sendPlaced();
    for (const id of this.vehicles.bikes) {
      const k = g.bikes[id];
      const spot = FLAG_TEAMS.map((side) => v?.[side].bikes.find((b) => b.id === id)).find(Boolean);
      if (!k || !spot) continue;
      if (k.rider) g.releaseBike(k.rider);
      Object.assign(k, { x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, lie: 0 });
      g.bikeAt[id] = 0;
      g.broadcastThing({ t: 'bike', bike: k }, 'bike', k);
    }
    // Everyone standing at their base, out of every seat, protected (game.mjs respawn); the downed come back there on their
    // own clock (never early). The guards make their rounds again (below).
    g.teamsChanged([...g.players].filter(([, p]) => !p.guard && p.alive).map(([n]) => n));
    g.flagGuards?.moved?.(now); // the guards' rounds round the stands as they are now (server/flagGuards.mjs)
    return { ev: 'swapped', team: 'blue', name: '' };
  }
}
