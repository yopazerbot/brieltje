// Where each team starts in the team deathmatch (server/modes.mjs kind 'teams'), the host's choice (Yoshi, 21 Nov 2026:
// "make sure the team versus team deathmatch also works. Let me choose the spawn places for the team versus team
// deathmatch."). A start is a place the game knows (a portal's arrival spot, shared/portals.mjs: the start screen's and
// the portals' places) or the host's own spot, taken from where the server has the admin (server/host.mjs `mark`): the
// page never sends a position for it. The server decides and checks every start here:
// - on the ground inside the map (shared/bounds.json `map`), never inside a code-locked home (its bands, shared/homes.mjs)
//   nor in the end house's walled garden, not indoors, not in a pond or ditch's water;
// - with room round it: the team's players are spread round it on free ground (no wall, hedge or fence within a metre,
//   nothing solid at body height: Game.standAt), each reached in a straight line from the middle without crossing a wall,
//   each at least a metre and a half from a locked home's wall, at the middle's height (not down a bank), clear of the
//   cars; a spot with fewer than MIN_ROOM such places is refused as cramped;
// - each place faces open ground: of sixteen ways the one with the longest free view (up to 20 m), the other team's start
//   breaking a tie, never a wall a step ahead (as the big team games do: Halo's team spawns, a deathmatch's start places
//   each looking into the map).
// Who comes back picks the place of their team's start furthest from the other team's living players (one of the best
// three, for variety; modes.mjs baseSpot), as Steal the flag's bases do.
import { PORTALS } from '../shared/portals.mjs';
import { readFileSync } from 'node:fs';
import { END_GARDEN, HOMES, distanceToHome, homeAt } from '../shared/homes.mjs';

const SPAWNS = JSON.parse(readFileSync(new URL('../shared/spawns.json', import.meta.url), 'utf8'));
/**
 * The school's play tower (shared/playground.json): its posts, ladder and slide are no block of the ground map, so a
 * place on its slide would stand a player in it. Its box along dv and dw (from the ladder's foot to the slide's end), with
 * room to spare.
 */
const TOWER = JSON.parse(readFileSync(new URL('../shared/playground.json', import.meta.url), 'utf8')).tower;
const onTower = (x, z) => {
  const dx = x - TOWER.at[0];
  const dz = z - TOWER.at[1];
  const v = dx * TOWER.v[0] + dz * TOWER.v[1];
  const w = dx * TOWER.w[0] + dz * TOWER.w[1];
  return Math.abs(v) < TOWER.roof.half + 0.6 && w > TOWER.ladder.foot - 0.6 && w < TOWER.slide.end[0] + 0.6;
};

/** The starts as they were: blue at the house, red at the bungalow (the game's own start places, game.mjs SPAWNS). */
export const DEFAULT_STARTS = Object.freeze({ blue: 'house', red: 'bungalow' });
/** The places a team may start at, by id: the portals' arrival spots. */
export const START_PLACES = new Map(PORTALS.map((p) => {
  const own = SPAWNS.find((s) => s.team === p.id); // the house's and the bungalow's own first start place (the street, the drive)
  return [p.id, { id: p.id, x: own?.x ?? p.out[0], z: own?.z ?? p.out[1] }];
}));
/** m between the two starts under which the host page warns (they would shoot each other as they start), and over which. */
export const NEAR_M = 40;
export const FAR_M = 400;
/** The fewest places round a start for it to be taken. */
export const MIN_ROOM = 8;
/** At most this many places round a start (a team of fifteen shares them out). */
const MOST = 32;
/** Rings round the middle: [radius m, places on it]. */
const RINGS = [[0, 1], [1.8, 6], [3.4, 10], [5, 14], [6.6, 18], [8.2, 22], [9.8, 26], [11.4, 30]];
/** m: the feet within this of the ground for "on the ground" (a step, a kerb, a terrace), and a place's height from the middle's. */
const GROUND_SLACK = 1.6;
const LEVEL = 1.2;
/** m a place keeps from a locked home's wall, and from a car. */
const HOME_GAP = 1.5;
const CAR_GAP = 3.2;
/** m looked along each way for open ground. */
const VIEW = 20;
const WAYS = 16;
/** m of open ground straight ahead for a base's place to face its way out exactly (faceOut). */
const AHEAD = 6;
/**
 * A base's places (Steal the flag, Attack and defend: base): at most this many, and m at least between two (a player is
 * 0.6 m across: a teammate a step and a half off, never inside your view at the first frame).
 */
export const BASE_MOST = 128;
export const BASE_GAP = 1.5;
/** m from (px, pz) to the segment (ax, az)-(bx, bz). */
const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
};

const finite = (...v) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
const round = (v) => Math.round(v * 100) / 100;
const inRing = (x, z, ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};

export class TeamStarts {
  /**
   * `game`: the Game (server/game.mjs: standAt, free, cars). `env`: `map` (the game's whole edge, shared/bounds.mjs),
   * `indoors(x, z)` (inside a building of the house data), `dips` (the ponds and ditches: their rims and water).
   */
  constructor(game, { map, indoors = () => false, dips = [] } = {}) {
    this.game = game;
    this.map = map;
    this.indoors = indoors;
    this.wet = dips.filter((d) => d && d.water !== undefined && Array.isArray(d.rim) && d.rim.length > 2).map((d) => {
      const xs = d.rim.map((v) => v[0]);
      const zs = d.rim.map((v) => v[1]);
      return { rim: d.rim, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    });
  }

  /** In a pond's or ditch's water. */
  water(x, z) {
    return this.wet.some((d) => x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1 && inRing(x, z, d.rim));
  }

  /** Inside a code-locked home (any floor), or within `gap` m of its walls at ground level, or in the end house's garden. */
  private(x, z, y, gap = 0) {
    if (homeAt(x, z, y) || inRing(x, z, END_GARDEN.ring)) return true; // the garden at any height: its wall, the lawn, over it
    return HOMES.some((h) => distanceToHome(h.id, x, z, y - 1, y + 2.5) <= gap);
  }

  /**
   * The host's own spot (x, y, z: where the server has the admin) as a start: { ok, y, spots } or { error, code } (the
   * page translates the code: src/i18n.ts srv.*). `toward`: the other team's start, for the way the places face.
   */
  check(x, y, z, toward = null) {
    if (!finite(x, y, z) || !this.map?.inside(x, z)) return { error: 'That spot is outside the map.', code: 'startOutside' };
    const ground = this.game.standAt(x, z).y;
    if (this.private(x, z, y) || this.private(x, z, ground)) return { error: 'Not inside a private home or its garden: step outside first.', code: 'startHome' };
    if (this.indoors(x, z)) return { error: 'Not indoors: step outside first.', code: 'startIndoors' };
    if (this.water(x, z)) return { error: 'Not in the water: stand on dry ground.', code: 'startWater' };
    if (Math.abs(y - ground) > GROUND_SLACK) return { error: 'Stand on the ground: not on a roof or in the air.', code: 'startGround' };
    const spots = this.spread(x, ground, z, toward);
    if (spots.length < MIN_ROOM) return { error: 'Too cramped here: find open ground with room for a team.', code: 'startCramped' };
    return { ok: true, y: round(ground), spots };
  }

  /**
   * A named place (START_PLACES) as a start: { ok, x, y, z, spots } or { error, code }. The house and the bungalow keep
   * their own start places (shared/spawns.json: the street, the garden and the side path; the bungalow's drive), each
   * with its ring of places, taken in turn.
   */
  place(id, toward = null) {
    const own = SPAWNS.filter((s) => s.team === id);
    if (own.length) {
      const rings = own.map((s) => this.spread(s.x, this.game.standAt(s.x, s.z).y, s.z, toward));
      const spots = [];
      for (let i = 0; spots.length < MOST && rings.some((r) => i < r.length); i++) for (const r of rings) if (r[i] && spots.length < MOST) spots.push(r[i]);
      return { ok: true, x: own[0].x, y: own[0].y, z: own[0].z, spots };
    }
    const p = START_PLACES.get(id);
    if (!p) return { error: 'Unknown place', code: 'badValue' };
    const y = this.game.standAt(p.x, p.z).y;
    const spots = this.spread(p.x, y, p.z, toward);
    return spots.length ? { ok: true, x: p.x, y: round(y), z: p.z, spots } : { error: 'No room there', code: 'startCramped' };
  }

  /**
   * The places round (x, y, z) for a team, nearest first: free ground, reached in a straight line from the middle, on its
   * level, outside the homes and the water, clear of the cars; each facing open ground (`toward` breaks a tie).
   */
  spread(x, y, z, toward = null) {
    return this.rings(x, y, z).map((q) => ({ x: q.x, y: q.y, z: q.z, face: this.face(q.x, q.z, toward) }));
  }

  /**
   * The places round (x, y, z), ring by ring (`ring`: 0 the middle, 1 the first ring, ...), with the checks of `spread`.
   * `o` (Steal the flag's bases, base): `edge` a Bounds for the map (its depth kept to `inset` m), `keep` circles
   * { x, z, r, solid } no place is in (a solid one, a tent, also blocks the way from the middle), `ok(x, z)` a test of
   * its own, `most` places at most.
   */
  rings(x, y, z, { edge = this.map, inset = 0, keep = [], ok = null, most = MOST } = {}) {
    const cars = Object.values(this.game.cars ?? {});
    const solid = keep.filter((c) => c.solid);
    const out = [];
    for (const [i, [r, n]] of RINGS.entries()) {
      const turn = r * 0.37; // each ring a little turned: no spokes
      for (let k = 0; k < n && out.length < most; k++) {
        const a = (k / n) * Math.PI * 2 + turn;
        const px = x + Math.sin(a) * r;
        const pz = z + Math.cos(a) * r;
        if (!edge.inside(px, pz) || (inset && edge.depth && edge.depth(px, pz) < inset)) continue;
        if (keep.some((c) => Math.hypot(px - c.x, pz - c.z) < c.r) || (ok && !ok(px, pz))) continue;
        const st = this.game.standAt(px, pz);
        if (!st.ok || Math.abs(st.y - y) > LEVEL || onTower(px, pz) || this.indoors(px, pz) || this.water(px, pz) || this.private(px, pz, st.y, HOME_GAP)) continue;
        if (cars.some((c) => Math.hypot(px - c.x, pz - c.z) < CAR_GAP)) continue;
        if (!this.clear(x, z, px, pz) || solid.some((c) => segDist(c.x, c.z, x, z, px, pz) < c.r)) continue;
        out.push({ x: round(px), y: round(st.y), z: round(pz), ring: i });
      }
    }
    return out;
  }

  /**
   * A base's places for a whole team (Steal the flag's and Attack and defend's: server/flags.mjs places), spread round
   * its start places `centres` ([x, z, y]) as `spread` spreads round one start: the start places themselves first, then
   * the first ring round each, then the next, none within BASE_GAP m of another, at most BASE_MOST. `o`: as `rings`
   * (edge, inset, keep, ok), and `toward` ({ x, z }), the way out of the base each place faces (faceOut). Each place
   * { x, y, z, ring, face }.
   */
  base(centres, { toward, ...o } = {}) {
    const all = centres.flatMap(([x, z], c) => this.rings(x, this.game.standAt(x, z).y, z, { ...o, most: Infinity }).map((q, k) => ({ ...q, c, k })));
    all.sort((a, b) => a.ring - b.ring || a.c - b.c || a.k - b.k);
    const out = [];
    for (const q of all) {
      if (out.length >= BASE_MOST) break;
      if (out.some((p) => Math.hypot(p.x - q.x, p.z - q.z) < BASE_GAP)) continue;
      out.push({ x: q.x, y: q.y, z: q.z, ring: q.ring, face: this.faceOut(q.x, q.z, toward) });
    }
    return out;
  }

  /**
   * Free ground all the way from (x0, z0) to (x1, z1), every half metre (no wall, hedge or fence crossed). The first
   * metre and a half is the host's own room (free ground means nothing within a metre: a host by a wall still has the
   * open side).
   */
  clear(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    for (let s = 1.5; s < d; s += 0.5) if (!this.game.free(x0 + ((x1 - x0) * s) / d, z0 + ((z1 - z0) * s) / d)) return false;
    return true;
  }

  /**
   * A point 10 m off along the way from (x, z) with the most open ground ahead (the other start breaking a tie; `pull`
   * how much it counts against open ground).
   */
  face(x, z, toward, pull = 3) {
    const aim = toward ? Math.atan2(toward.x - x, toward.z - z) : null;
    let best = null;
    for (let i = 0; i < WAYS; i++) {
      const a = (i / WAYS) * Math.PI * 2;
      let open = 0;
      while (open < VIEW && this.game.free(x + Math.sin(a) * (open + 1), z + Math.cos(a) * (open + 1)) && this.map.inside(x + Math.sin(a) * (open + 1), z + Math.cos(a) * (open + 1))) open++;
      const score = open + (aim === null ? 0 : pull * Math.cos(a - aim));
      if (!best || score > best.score) best = { score, a };
    }
    return [round(x + Math.sin(best.a) * 10), round(z + Math.cos(best.a) * 10)];
  }

  /**
   * The way out of a base from (x, z): straight at `toward` (its stand, the field beyond) when the ground is open that
   * way for AHEAD m, else the open way nearest to it (never a wall a step ahead).
   */
  faceOut(x, z, toward) {
    if (!toward) return this.face(x, z, null);
    const d = Math.hypot(toward.x - x, toward.z - z) || 1;
    const ux = (toward.x - x) / d, uz = (toward.z - z) / d;
    let open = 0;
    while (open < AHEAD && this.game.free(x + ux * (open + 1), z + uz * (open + 1))) open++;
    return open >= AHEAD ? [round(x + ux * 10), round(z + uz * 10)] : this.face(x, z, toward, 12);
  }
}

/** A named place's name in English (the chat's fallback text; the pages say it in their language). */
export function placeName(id) {
  return PORTALS.find((p) => p.id === id)?.name ?? id;
}

/** The named place nearest to (x, z): a host's spot is shown as "near" it. */
export function nearestPlace(x, z) {
  let best = null;
  for (const p of START_PLACES.values()) if (!best || Math.hypot(p.x - x, p.z - z) < Math.hypot(best.x - x, best.z - z)) best = p;
  return best.id;
}
