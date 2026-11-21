/**
 * Where the plants along a pond or ditch stand (world/bankPlants.ts draws them). Pure: no three.js, no world, so
 * the tests can run it (bankPlants.test.mjs).
 *
 * Two steps. `layout` works out, once per body and from its rim alone (the same for everyone), what is wanted
 * along its shore: walking round the rim it lays out runs of shore, each a stand of reed, a few clumps of
 * bulrush, rushes with yellow flag, coarse grass only, or a bare gap, with their lengths and their mix drawn from
 * the body's own place. Ponds get reed along 30 to 50 % of their shore, ditches mostly grass and rushes with reed
 * here and there; denser where the shore bends (the sheltered corners), each run thinning out at its ends so the
 * stands are clumps, not blocks; fewer and no reed where a garden's lawn comes down to the water.
 *
 * `settle` then puts each wanted plant on the ground as it is now, by asking the world: across the shore at
 * each place it finds the water's edge and how far in the water is shallow enough, from the bank's height
 * (world/collision.ts groundAt) and the water's surface (world/water.ts waterLevel). So the plants follow those
 * two however they change: reed and bulrush from the wet band into the shallows (rooted in the bed, at most
 * about 0.4 m under water), rushes and yellow flag on the wet band, the bank grass on the rim, hanging over it.
 * Nothing where the land behind the rim is a road, a drive, paving or anything else built (`open`).
 */

export type Ring = [number, number][];

/** A pond or ditch as the data has it (world/houseData.ts DipSpec): its rim, its bottom, how deep. */
export interface BankBody {
  name: string;
  rim: Ring;
  bottom: Ring;
  depth: number;
  water?: number;
}

/** The kinds, in the order of their models in public/models/bank-plants.glb (tools/bank_plants.py). */
export const KINDS = ['Reed', 'Bulrush', 'Rush', 'Grass', 'Iris'] as const;
export const REED = 0;
export const BULRUSH = 1;
export const RUSH = 2;
export const GRASS = 3;
export const IRIS = 4;
/** Each kind's variants (Reed1 .. Reed3, each with its far copy Reed1Far ..). */
export const VARIANTS = [3, 2, 2, 3, 2];
/** How deep (m) each kind may stand in the water at its foot: reed and bulrush in the shallows, the rest on the bank. */
export const MAX_DEPTH = [0.42, 0.42, 0.08, 0.04, 0.1];

/** The wind blows from the south-west (world/wind.ts DIR): the reeds' plumes nod that way. */
const WIND_X = -0.998;
const WIND_Z = 0.057;

/** Metres between the places along the shore where plants are wanted. */
const STEP = 0.9;
/** How far across the shore the water's edge is looked for: from this far outside the rim to this far in (m). */
const OUT = 0.7;
const IN = 4;
const STRIDE = 0.1;

/** Where along the shore what is wanted. */
const ZONE = { deep: 0, edge: 1, rim: 2 } as const;
type Zone = (typeof ZONE)[keyof typeof ZONE];

/** A plant wanted at a place along the shore, before the ground is asked. */
export interface Want {
  /** Its place along the shore (an index into the body's stations) */
  station: number;
  kind: number;
  variant: number;
  zone: Zone;
  /** Where across its zone (0 to 1) and along the shore (m, either way) */
  across: number;
  along: number;
  size: number;
  /** Its turn about the vertical (radians; the model's +x then points along (cos, -sin)) */
  turn: number;
  colour: number;
  /** Drawn on the sparser presets only when under their share */
  rank: number;
}

/** A place along the shore: on the rim, the way in across the shore, along it. */
export interface Station {
  x: number;
  z: number;
  /** Inwards (towards the water), unit */
  nx: number;
  nz: number;
  /** In a garden: the land behind it is a lawn */
  garden: boolean;
}

export interface Layout {
  stations: Station[];
  wants: Want[];
  /** The share of the shore that is reed stands (0 to 1), for the tests */
  reedShare: number;
}

/** What `settle` asks of the world. */
export interface Ask {
  /** The bank's or the bed's height at (x, z) */
  bed(x: number, z: number): number;
  /** The water's surface at (x, z), null on dry land */
  level(x: number, z: number): number | null;
  /** Whether a plant may grow at (x, z): not on a road, a drive, paving, in a building or a hedge */
  open(x: number, z: number, bed: number): boolean;
}

/** Flat per plant: x, y, z, kind, variant, size, turn, colour, rank. */
export const FIELDS = 9;

function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Even-odd test across the rings (an outline and its holes). */
export function insideRings(x: number, z: number, rings: Ring[]): boolean {
  // Plain index loops, no destructuring: asked for every place along every shore against every lawn, an iterator or a
  // small array per point made gigabytes of garbage over the start (a phone's start ran out of memory).
  let odd = false;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const pi = ring[i];
      const pj = ring[j];
      const xi = pi[0];
      const zi = pi[1];
      const xj = pj[0];
      const zj = pj[1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) odd = !odd;
    }
  }
  return odd;
}

/** How far (x, z) is from a closed ring's edge. */
export function ringDistance(x: number, z: number, r: Ring): number {
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, az] = r[j];
    const dx = r[i][0] - ax;
    const dz = r[i][1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

/** The run types along a shore. */
const STAND = 0;
const CLUMPS = 1;
const WET = 2;
const GRASSY = 3;
const GAP = 4;
/** Out of a hundred runs: which type, and how long (m, from .. to); a pond's and a ditch's. */
const POND_RUNS: [number, number, number, number][] = [
  [34, STAND, 4, 11],
  [44, CLUMPS, 1.5, 3],
  [64, WET, 2, 6],
  [90, GRASSY, 2.5, 7],
  [100, GAP, 1, 3],
];
const DITCH_RUNS: [number, number, number, number][] = [
  [7, STAND, 3, 8],
  [11, CLUMPS, 1.5, 3],
  [46, WET, 2, 7],
  [86, GRASSY, 3, 9],
  [100, GAP, 1.5, 5],
];

/**
 * What is wanted along a body's shore, from its rim alone. `garden(x, z)`: whether the land at (x, z) is a garden's
 * lawn (fewer plants there, no reed: someone keeps it).
 */
export function layout(body: BankBody, garden: (x: number, z: number) => boolean = () => false): Layout {
  const rim = body.rim;
  const n = rim.length;
  const pond = body.name === 'pond';
  // Its own numbers, from its place.
  const cx = rim.reduce((s, p) => s + p[0], 0) / n;
  const cz = rim.reduce((s, p) => s + p[1], 0) / n;
  const rand = random(Math.round(cx * 100) * 73856093 ^ Math.round(cz * 100) * 19349663 ^ n * 83492791);
  // The rim's length and which way is in: the ring's turn says which side of each edge the water is on.
  let area = 0;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = rim[i];
    const [bx, bz] = rim[(i + 1) % n];
    area += ax * bz - bx * az;
    lengths.push(Math.hypot(bx - ax, bz - az));
    total += lengths[i];
  }
  const side = area > 0 ? 1 : -1;
  const normals = rim.map((a, i) => {
    const b = rim[(i + 1) % n];
    const l = lengths[i] || 1;
    return [(-(b[1] - a[1]) / l) * side, ((b[0] - a[0]) / l) * side];
  });
  // At each corner the mean of its two edges' ways in, so the way in turns smoothly along the shore.
  const corner = normals.map((nb, i) => {
    const na = normals[(i + n - 1) % n];
    const x = na[0] + nb[0];
    const z = na[1] + nb[1];
    const l = Math.hypot(x, z) || 1;
    return [x / l, z / l];
  });
  const stations: Station[] = [];
  const count = Math.max(3, Math.round(total / STEP));
  const step = total / count;
  let seg = 0;
  let start = 0;
  for (let k = 0; k < count; k++) {
    const s = k * step;
    while (seg < n - 1 && s > start + lengths[seg]) start += lengths[seg++];
    const t = lengths[seg] ? (s - start) / lengths[seg] : 0;
    const a = rim[seg];
    const b = rim[(seg + 1) % n];
    const ca = corner[seg];
    const cb = corner[(seg + 1) % n];
    const nx = ca[0] + (cb[0] - ca[0]) * t;
    const nz = ca[1] + (cb[1] - ca[1]) * t;
    const l = Math.hypot(nx, nz) || 1;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    stations.push({ x, z, nx: nx / l, nz: nz / l, garden: garden(x - (nx / l) * 1.5, z - (nz / l) * 1.5) });
  }
  // How sharply the shore bends round each place (over 2 m either way): its sheltered corners, 0 to 1.
  const reach = Math.max(1, Math.round(2 / step));
  const bendAt = stations.map((_, k) => {
    const a = stations[(k + count - reach) % count];
    const b = stations[(k + reach) % count];
    const turn = Math.acos(Math.max(-1, Math.min(1, a.nx * b.nx + a.nz * b.nz)));
    return Math.min(1, turn / 1.1);
  });
  // The runs round the shore.
  const runs = pond ? POND_RUNS : DITCH_RUNS;
  const kindOf = new Int8Array(count);
  const runPos = new Float32Array(count); // where in its run (0 to 1)
  let reedLength = 0;
  // A pond's runs drawn again (on from the same numbers) until its reed stands take 30 to 50 % of its shore.
  for (let tries = 0; tries < 40; tries++) {
    reedLength = 0;
    for (let k = 0; k < count; ) {
      const roll = rand() * 100;
      const [, type, lo, hi] = runs.find(([upTo]) => roll < upTo)!;
      const len = Math.max(1, Math.round((lo + rand() * (hi - lo)) / step));
      for (let i = 0; i < len && k + i < count; i++) {
        kindOf[k + i] = type;
        runPos[k + i] = (i + 0.5) / len;
      }
      if (type === STAND) reedLength += Math.min(len, count - k);
      k += len;
    }
    if (!pond || (reedLength / count >= 0.3 && reedLength / count <= 0.5)) break;
  }
  const wants: Want[] = [];
  const want = (station: number, kind: number, zone: Zone, density: number) => {
    // Every roll is drawn whether or not it is kept, so a plant keeps its look when its neighbours change.
    const keep = rand() < density;
    const across = rand();
    const along = (rand() - 0.5) * step * 1.4;
    const size = rand();
    const spin = rand();
    const colour = rand();
    const rank = rand();
    const variant = Math.floor(rand() * VARIANTS[kind]) % VARIANTS[kind];
    if (!keep) return;
    const st = stations[station];
    let turn = spin * Math.PI * 2;
    // The reeds' plumes downwind; the bank grass's longer side out over the water.
    if (kind === REED) turn = Math.atan2(-WIND_Z, WIND_X) + (spin - 0.5) * 0.9;
    else if (kind === GRASS) turn = Math.atan2(-st.nz, st.nx) + (spin - 0.5) * 1.6;
    wants.push({ station, kind, variant, zone, across, along, size, turn, colour, rank });
  };
  for (let k = 0; k < count; k++) {
    const st = stations[k];
    // Thinning out to the run's ends, denser in the bends, a slow patchiness along the shore.
    const taper = Math.min(1, Math.sin(Math.PI * runPos[k]) * 1.6);
    const patch = 0.75 + 0.25 * Math.sin(st.x * 0.31 + st.z * 0.17) * Math.sin(st.z * 0.23 - st.x * 0.11);
    const dense = (0.8 + 0.5 * bendAt[k]) * patch * (st.garden ? 0.4 : 1);
    let type = kindOf[k];
    if (st.garden && (type === STAND || type === CLUMPS)) type = GRASSY;
    switch (type) {
      case STAND:
        want(k, REED, ZONE.deep, 0.95 * dense * taper);
        want(k, REED, ZONE.deep, 0.75 * dense * taper);
        want(k, REED, ZONE.edge, 0.8 * dense * taper);
        want(k, GRASS, ZONE.rim, 0.55 * dense);
        want(k, GRASS, ZONE.rim, 0.25 * dense);
        break;
      case CLUMPS:
        want(k, BULRUSH, ZONE.deep, 0.7 * dense * taper);
        want(k, BULRUSH, ZONE.edge, 0.35 * dense * taper);
        want(k, REED, ZONE.edge, 0.2 * dense);
        want(k, GRASS, ZONE.rim, 0.6 * dense);
        want(k, GRASS, ZONE.rim, 0.25 * dense);
        break;
      case WET:
        want(k, RUSH, ZONE.edge, 0.6 * dense * (0.4 + 0.6 * taper));
        want(k, IRIS, ZONE.edge, 0.3 * dense * taper);
        want(k, GRASS, ZONE.rim, 0.6 * dense);
        break;
      case GRASSY:
        want(k, GRASS, ZONE.rim, 0.85 * dense);
        want(k, GRASS, ZONE.rim, 0.3 * dense);
        want(k, RUSH, ZONE.edge, 0.06 * dense);
        break;
      default:
        want(k, GRASS, ZONE.rim, 0.35 * dense);
    }
  }
  return { stations, wants, reedShare: reedLength / count };
}

/** Across one station's shore: where the water starts (m in from the rim) and how far in it is shallow enough. */
interface Shore {
  /** The water's edge, or NaN where no water was found */
  edge: number;
  /** The last place still shallow enough for reed */
  shallow: number;
}

function shore(st: Station, ask: Ask): Shore {
  const depthAt = (u: number) => {
    const x = st.x + st.nx * u;
    const z = st.z + st.nz * u;
    const level = ask.level(x, z);
    return level === null ? -Infinity : level - ask.bed(x, z);
  };
  let edge = NaN;
  let shallow = NaN;
  for (let i = 0, u = -OUT; u <= IN; u = -OUT + ++i * STRIDE) {
    const depth = depthAt(u);
    if (Number.isNaN(edge)) {
      if (depth >= 0) {
        // Between the last dry sample and this one, where the bank meets the water: halved down to a centimetre.
        let dry = u - STRIDE;
        let wet = u;
        if (i > 0) {
          for (let k = 0; k < 4; k++) {
            const mid = (dry + wet) / 2;
            if (depthAt(mid) >= 0) wet = mid;
            else dry = mid;
          }
        }
        edge = wet;
        shallow = wet;
      }
    } else {
      if (depth < -0.05 || depth > MAX_DEPTH[REED] - 0.04) break; // out on the far bank, or too deep
      shallow = u;
    }
  }
  return { edge, shallow };
}

/**
 * Put the wanted plants on the ground as the world has it now (`ask`): those of the stations `from` to `to` (a piece of
 * the shore; all of it by default). Returns them flat (FIELDS numbers each).
 * Plants whose spot turns out too deep, too dry for them, or not open are left out; so is every plant of a place
 * whose land behind the rim is not open (a road, a drive, paving along the water).
 */
export function settle(plan: Layout, ask: Ask, from = 0, to = plan.stations.length): Float32Array {
  const shores = new Map<number, Shore | null>();
  const out: number[] = [];
  for (const w of plan.wants) {
    if (w.station < from || w.station >= to) continue;
    let sh = shores.get(w.station);
    const st = plan.stations[w.station];
    if (sh === undefined) {
      // The land behind the rim, a little and a bit further back: built on there, no plants at all.
      const backs = [0.6, 1.4].map((d) => [st.x - st.nx * d, st.z - st.nz * d]);
      sh = backs.every(([x, z]) => ask.open(x, z, ask.bed(x, z))) ? shore(st, ask) : null;
      shores.set(w.station, sh);
    }
    if (!sh) continue;
    let u: number;
    if (Number.isNaN(sh.edge)) {
      if (w.zone !== ZONE.rim) continue; // no water found across here: only the rim's grass
      u = -0.35 + w.across * 0.6;
    } else if (w.zone === ZONE.deep) {
      const from = sh.edge + 0.05;
      u = from + w.across * Math.max(0, sh.shallow - from);
    } else if (w.zone === ZONE.edge) {
      u = sh.edge - 0.55 + w.across * 0.65;
    } else {
      u = -0.35 + w.across * (Math.max(-0.1, Math.min(0.3, sh.edge - 0.15)) + 0.35);
    }
    // Along the shore: the tangent, the way in turned a quarter.
    const x = st.x + st.nx * u - st.nz * w.along;
    const z = st.z + st.nz * u + st.nx * w.along;
    const y = ask.bed(x, z);
    const level = ask.level(x, z);
    if (level !== null && level - y > MAX_DEPTH[w.kind]) continue;
    if (!ask.open(x, z, y)) continue;
    out.push(x, y, z, w.kind, w.variant, w.size, w.turn, w.colour, w.rank);
  }
  return new Float32Array(out);
}
