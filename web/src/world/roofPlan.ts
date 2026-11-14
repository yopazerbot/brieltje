import type { Opening, Prism, RoofSpec } from './houseData';
import { BlockGrid, inside } from './houseKeys';

/**
 * What the open-data houses' single slopes are drawn as (world/surroundings.ts `sloped`, world/houseTrim.ts), in numbers
 * only, so node can test it (world/roofPlan.test.mjs). The data's roofs are fitted to the laser's heights piece by piece
 * (tools/roofs.py): a gable often comes out as two single slopes that meet, a hip end as a slope of its own, and a house
 * with a lower back as one long ramp up to a blank wall. Drawn as they are, they read as wedges, fins and ramps. Here:
 *
 * - two slopes that meet (a pair) become one gable: one top, one ridge row, one tile colour, no spike where they cross;
 * - a slope that runs along a long narrow strip (a ramp) becomes a gable along its length;
 * - a slope up to a free high wall (a wedge) is closed with a second slope down past that wall;
 * - the rest stays as it is: lean-tos against a taller part, low and nearly flat slopes, sheds and garages, and the
 *   slopes with windows on their own drawn walls or surveyed solar panels (so nothing is left in the air).
 *
 * Worked out once per set (world/houseIndex.ts), so a house on a tile's edge gets one shape from both tiles and every
 * player sees the same. Drawn only: the wall blocks (collision, the server) never change, and none reaches above the
 * eaves under a roof that changes.
 */

/** A slope whose high wall shows this much (m) or less over what stands behind it is a lean-to: kept. */
export const SHOW = 1.2;
/** A slope that rises less than this (m) from eaves to top is kept. */
export const RISE = 1.2;
/** A slope flatter than this (rise per metre across, about 12 degrees) is kept. */
export const FLAT = 0.21;
/** A slope whose top is less than this (m) over the ground is one storey (a shed, a garage): kept. */
export const STOREY = 4.2;
/** Two halves whose tops are this close (m) are one gable as they are (both tops to their mean). */
export const MEET = 0.6;
/** Two halves whose tops are further apart than MEET and up to this (m), with no windows or panels, are levelled to their mean. */
export const LEVEL = 2.5;
/** A slope at least this wide (m, across, low side to high side)... */
export const RAMP_W = 9;
/** ...and this many times as wide as it is long is a ramp: turned into a gable along its length. */
export const RAMP = 1.5;
/** A turned ramp's ridge rises at most this much per metre from its eaves (35 degrees). */
export const TURN_PITCH = 0.7;
/** A closed wedge's far slope drops at least this much per metre (45 degrees), or as steep as the near slope. */
export const FAR_PITCH = 1;
/** A closed wedge's far eaves stand this much (m) over what stands behind it. */
export const FAR_CLEAR = 0.25;
/** Something behind within this much (m) of a slope's top: the slope stops at its high edge (no overhang into it). */
export const TIGHT = 0.3;
/** Where behind the high side is looked at: these parts of its length... */
const BEHIND_AT = [0.2, 0.5, 0.8];
/** ...this far (m) beyond the high edge. */
const BEHIND = 0.6;
/** A partner's high edge lies within this much (m) of the point looked at. */
const PARTNER_EDGE = 1.2;
/** A window this close (m) to a slope's rectangle, looking out over it, must not be hidden more than the data's slope does. */
const NEAR = 0.3;
/** Two halves whose high edges run into each other by more than this (m) at an end are no pair: they'd show a wedge. */
export const PAIR_OVERLAP = 0.35;
/**
 * A changed roof may not let another roof's faces, or a wall or lid, show through it by more than this (m) where the
 * data's slope hid them (less is lost in its eaves' overhang and gutter).
 */
export const SHOW_THROUGH = 0.5;
/** Another roof's faces count from this far (m) inside a changed roof's rectangle: at its edges roofs of one house meet. */
const EDGE = 0.6;
/** A slope this close (m) to a wall of a house one of our models stands in for is kept as it is. */
const BY_MODEL = 1;

function boxOf(ring: [number, number][]): [number, number, number, number] {
  const xs = ring.map((q) => q[0]);
  const zs = ring.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

/**
 * One roof that came out wrong, by a point inside it (model coordinates, never an address): drawn as said here. Empty;
 * Yoshi's to fill.
 */
export const ROOF_OVERRIDES: { at: [number, number]; as: 'keep' | 'close' | 'turn' }[] = [];

export type RoofCase = 'pair' | 'turn' | 'close' | 'keep';

export interface RoofOutcome {
  kind: RoofCase;
  /** A pair whose tops were further apart than MEET */
  levelled?: boolean;
  /** Why it is kept ('windows': on its own drawn walls, or looking out over it from close by and hidden by the new shape) */
  why?: 'panels' | 'model' | 'lean-to' | 'step' | 'windows' | 'low' | 'one storey' | 'neighbour' | 'override';
}

export interface RoofPlan {
  /** The data's roof to the one that is drawn, for every single slope drawn otherwise */
  drawn: Map<RoofSpec, RoofSpec>;
  /** Every single slope looked at (not a landmark's or one over a room), and what became of it */
  cases: Map<RoofSpec, RoofOutcome>;
  /** The other half of each pair, by the drawn specs */
  partner: Map<RoofSpec, RoofSpec>;
}

/** A roof's rectangle as the data gives it (a shed's corners are always in order: `fixed`). */
interface Frame {
  x: number;
  z: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  L: number;
  W: number;
}

function frameOf(r: RoofSpec): Frame {
  const c = r.p;
  const L = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
  const W = Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1]);
  return { x: c[0][0], z: c[0][1], ax: (c[1][0] - c[0][0]) / L, az: (c[1][1] - c[0][1]) / L, bx: (c[3][0] - c[0][0]) / W, bz: (c[3][1] - c[0][1]) / W, L, W };
}

const local = (f: Frame, x: number, z: number): [number, number] => [(x - f.x) * f.ax + (z - f.z) * f.az, (x - f.x) * f.bx + (z - f.z) * f.bz];
const point = (f: Frame, a: number, b: number): [number, number] => [f.x + f.ax * a + f.bx * b, f.z + f.az * a + f.bz * b];

/** A roof's surface at (x, z) as drawn, or null outside it (a hip as a gable: near enough for what stands behind). */
function surface(r: RoofSpec, f: Frame, x: number, z: number): number | null {
  const [a, b] = local(f, x, z);
  if (a < -0.05 || a > f.L + 0.05 || b < -0.05 || b > f.W + 0.05) return null;
  return drawnTop(r, f, x, z);
}

/** A roof's tiles over the spot of its rectangle nearest to (x, z), as drawn: a closed slope, a single one, a gable. */
function drawnTop(r: RoofSpec, f: Frame, x: number, z: number): number {
  const b = Math.max(0, Math.min(f.W, local(f, x, z)[1]));
  if (r.closed) {
    const { at, far } = r.closed;
    return b <= at ? r.y + ((r.ridge - r.y) * b) / at : far + ((r.ridge - far) * (f.W - b)) / (f.W - at);
  }
  if (r.shape === 'shed') return r.y + ((r.ridge - r.y) * b) / f.W;
  return r.y + (r.ridge - r.y) * (1 - Math.abs(b - f.W / 2) / (f.W / 2));
}

const CELL = 10;

/** A cell's number (the map reaches a few kilometres: well within ±32768 cells either way). */
const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + cz + 32768;

/** Items in cells of 10 m by their box, read back in the order they were added. */
class Cells {
  private cells = new Map<number, number[]>();
  add(i: number, x0: number, z0: number, x1: number, z1: number): void {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = cellKey(cx, cz);
        const c = this.cells.get(k);
        if (c) c.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }
  at(x: number, z: number): number[] {
    return this.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
  }
}

/** The walls and flat-roof lids that stand behind a slope (not the ground covers, hedges and fences). */
const STANDING = /^nb_(red|brown|yellow|white|grey|dark|roof)$/;

interface Look {
  f: Frame;
  base: number;
  /** The median of the highest thing behind the high side at three points (-Infinity: nothing) */
  T: number;
  partner: RoofSpec | null;
  taken: boolean;
  glazed: boolean;
  /** Rise per metre across */
  k: number;
}

/**
 * The single slopes of a set and what each is drawn as. `solar`: the data's panel arrays (a roof with some is kept).
 * `standingAt`: the walls and flat-roof lids standing round a point, when the caller has them in a grid already
 * (world/houseIndex.ts); else they are found here. `behind`: the whole data the set was cut from, before our models'
 * houses were taken out of it (main.ts): what stands behind a slope is looked up there, so a slope against a house a
 * model now stands in for is still a lean-to.
 */
export function planRoofs(roofs: RoofSpec[], prisms: Prism[], openings: Opening[], solar: { q: [number, number, number][] }[] = [],
  standingAt?: (x: number, z: number) => Prism[], behind?: Behind): RoofPlan {
  const standingGrid = (list: Prism[]) => {
    const grid = new BlockGrid();
    for (const p of list) if (p.d === undefined && STANDING.test(p.m)) grid.add(p);
    return grid;
  };
  const blocks: { at: (x: number, z: number) => Prism[] } = standingAt ? { at: standingAt } : standingGrid(prisms);
  const frames = roofs.map(frameOf);
  const isSlope = (r: RoofSpec) => r.shape === 'shed' && !r.lm && !r.ceiling;
  // Every roof (for what stands behind a slope), and the single slopes alone (for the windows and panels on or by them).
  const grid = new Cells();
  const slopes = new Cells();
  roofs.forEach((r, i) => {
    const xs = r.p.map((q) => q[0]);
    const zs = r.p.map((q) => q[1]);
    const box = [Math.min(...xs) - NEAR, Math.min(...zs) - NEAR, Math.max(...xs) + NEAR, Math.max(...zs) + NEAR] as const;
    grid.add(i, ...box);
    if (isSlope(r)) slopes.add(i, ...box);
  });
  /** The single slopes whose rectangle holds (x, z), by their place in `roofs`. */
  const slopesAt = (x: number, z: number) =>
    slopes.at(x, z).filter((i) => {
      const [a, b] = local(frames[i], x, z);
      return a >= 0 && a <= frames[i].L && b >= 0 && b <= frames[i].W;
    });

  // Surveyed panels inside a slope's outline; windows above a slope's eaves on its own drawn walls (no wall block carries them).
  const taken = new Set<number>();
  for (const s of solar) {
    const x = s.q.reduce((t, q) => t + q[0], 0) / s.q.length;
    const z = s.q.reduce((t, q) => t + q[2], 0) / s.q.length;
    for (const i of slopes.at(x, z)) if (inside(roofs[i].p, x, z)) taken.add(i);
  }
  const glazed = new Set<number>();
  /** Per slope, the windows on or by it that look out over it from above its eaves (a taller part's, a neighbour's). */
  const overlooked = new Map<number, Opening[]>();
  for (const op of openings) {
    const l = Math.hypot(op.n[0], op.n[1]) || 1;
    const [mx, mz] = [(op.a[0] + op.b[0]) / 2, (op.a[1] + op.b[1]) / 2];
    const x = mx - (op.n[0] / l) * 0.3;
    const z = mz - (op.n[1] / l) * 0.3;
    const top = op.y[1] - 0.1;
    for (const i of slopesAt(x, z)) {
      if (op.y[1] <= roofs[i].y + 0.15) continue;
      if (!blocks.at(x, z).some((p) => p.m !== 'nb_roof' && top < p.y1 + 0.05 && top > p.y0 - 0.05)) glazed.add(i);
    }
    for (const i of slopes.at(mx, mz)) {
      const f = frames[i];
      if (op.y[1] <= roofs[i].y + 0.15) continue;
      const [a, b] = local(f, mx, mz);
      if (a < -NEAR || a > f.L + NEAR || b < -NEAR || b > f.W + NEAR) continue;
      // Facing in, over the roof.
      const [cx, cz] = point(f, f.L / 2, f.W / 2);
      if (op.n[0] * (cx - mx) + op.n[1] * (cz - mz) <= 0) continue;
      const list = overlooked.get(i);
      if (list) list.push(op);
      else overlooked.set(i, [op]);
    }
  }

  // What stands behind: the whole data's walls, lids and roofs (with the houses our models stand in for), the roofs of
  // this set as they are drawn once decided.
  const backRoofs = behind?.roofs ?? roofs;
  const backBlocks = behind ? standingGrid(behind.prisms) : blocks;
  const backFrames = behind ? backRoofs.map(frameOf) : frames;
  const backGrid = behind ? new Cells() : grid;
  if (behind) {
    backRoofs.forEach((r, j) => {
      const xs = r.p.map((q) => q[0]);
      const zs = r.p.map((q) => q[1]);
      backGrid.add(j, Math.min(...xs) - NEAR, Math.min(...zs) - NEAR, Math.max(...xs) + NEAR, Math.max(...zs) + NEAR);
    });
  }
  const drawn = new Map<RoofSpec, RoofSpec>();
  const drawnFrames = new Map<RoofSpec, Frame>();
  /** Another roof's surface at (x, z): as drawn when `asDrawn` and it is decided, else as the data has it. */
  const roofAt = (j: number, x: number, z: number, asDrawn: boolean) => {
    const q = backRoofs[j];
    const d = asDrawn ? drawn.get(q) : undefined;
    if (!d || d.p === q.p) return surface(d ?? q, backFrames[j], x, z);
    let f = drawnFrames.get(d);
    if (!f) drawnFrames.set(d, (f = frameOf(d)));
    return surface(d, f, x, z);
  };
  /** The median of the highest things standing 0.6 m behind slope i's high side, at three points along it. */
  const heightBehind = (i: number, asDrawn: boolean) => {
    const r = roofs[i];
    const f = frames[i];
    return BEHIND_AT.map((t) => {
      const [x, z] = point(f, f.L * t, f.W + BEHIND);
      let top = -Infinity;
      for (const p of backBlocks.at(x, z)) top = Math.max(top, p.y1);
      for (const j of backGrid.at(x, z)) {
        if (backRoofs[j] === r || backRoofs[j].ceiling) continue;
        const s = roofAt(j, x, z, asDrawn);
        if (s !== null) top = Math.max(top, s);
      }
      return top;
    }).sort((a, b) => a - b)[1];
  };

  const looks = new Map<number, Look>();
  roofs.forEach((r, i) => {
    if (!isSlope(r)) return;
    const f = frames[i];
    // A partner: a single slope of this set the other way, its high edge near the points looked at.
    const hits = new Map<number, number>();
    for (const t of BEHIND_AT) {
      const [x, z] = point(f, f.L * t, f.W + BEHIND);
      for (const j of grid.at(x, z)) {
        const q = roofs[j];
        const fq = frames[j];
        if (j === i || !isSlope(q) || surface(q, fq, x, z) === null) continue;
        if (fq.bx * f.bx + fq.bz * f.bz < -0.9 && local(fq, x, z)[1] > fq.W - PARTNER_EDGE) hits.set(j, (hits.get(j) ?? 0) + 1);
      }
    }
    // The first roof (in the data's order) found at two of the three points.
    const found = [...hits].filter(([, n]) => n >= 2).map(([j]) => j).sort((a, b) => a - b)[0];
    looks.set(i, {
      f,
      base: r.base ?? r.y - 2.7,
      T: heightBehind(i, false),
      partner: found === undefined ? null : roofs[found],
      taken: taken.has(i),
      glazed: glazed.has(i),
      k: (r.ridge - r.y) / Math.max(0.5, f.W),
    });
  });
  const indexOf = new Map(roofs.map((r, i) => [r, i]));
  const lookOf = (r: RoofSpec) => looks.get(indexOf.get(r)!)!;
  /** Whether drawing slope i as `d` would hide more of a window that looks out over it than the data's slope does. */
  const covers = (i: number, d: RoofSpec) => {
    const r = roofs[i];
    const fd = d.p === r.p ? frames[i] : frameOf(d);
    for (const op of overlooked.get(i) ?? []) {
      const [x, z] = [(op.a[0] + op.b[0]) / 2, (op.a[1] + op.b[1]) / 2];
      const was = drawnTop(r, frames[i], x, z);
      if (was < op.y[1] && drawnTop(d, fd, x, z) > Math.max(was, op.y[0]) + 0.05) return true;
    }
    return false;
  };
  /**
   * Whether drawing slope i as `d` lets something show through it: a neighbouring gable that overlaps the rectangle, or
   * a wall or lid standing under it, hidden under the data's slope and now above the drawn one (looked at on a grid over
   * the rectangle).
   */
  const exposes = (i: number, d: RoofSpec) => {
    const r = roofs[i];
    const f = frames[i];
    const fd = d.p === r.p ? f : frameOf(d);
    // Every half metre or so inside it.
    const nu = Math.max(2, Math.ceil(f.L / 0.5));
    const nv = Math.max(2, Math.ceil(f.W / 0.5));
    for (let u = 1; u < nu; u++) {
      for (let v = 1; v < nv; v++) {
        const [x, z] = point(f, (f.L * u) / nu, (f.W * v) / nv);
        const was = drawnTop(r, f, x, z);
        const now = drawnTop(d, fd, x, z);
        if (now >= was - SHOW_THROUGH) continue;
        // A wall or a lid under the slope that would stand out of the lower tiles.
        if (backBlocks.at(x, z).some((p) => p.y1 > now + SHOW_THROUGH && p.y1 <= was + 0.05)) return true;
        // Another roof's faces, more than EDGE in (roofs of one house meet at their edges, and an eave overlaps).
        const [a, b] = [(f.L * u) / nu, (f.W * v) / nv];
        if (a < EDGE || a > f.L - EDGE || b < EDGE || b > f.W - EDGE) continue;
        for (const j of backGrid.at(x, z)) {
          const q = backRoofs[j];
          if (q === r || q.ceiling) continue;
          const s = surface(q, backFrames[j], x, z);
          if (s !== null && s > now + SHOW_THROUGH) return true; // crossing the new shape, hidden or not before
        }
      }
    }
    return false;
  };
  // The walls of the houses our models stand in for (in the whole data, not in this set): a slope beside one is kept, as
  // the model's house is not the data's.
  const own = new Set(prisms);
  const replaced = new Cells();
  const gone = behind ? behind.prisms.filter((p) => p.d === undefined && STANDING.test(p.m) && !own.has(p)) : [];
  gone.forEach((p, k) => {
    const b = boxOf(p.p[0]);
    replaced.add(k, b[0] - BY_MODEL, b[1] - BY_MODEL, b[2] + BY_MODEL, b[3] + BY_MODEL);
  });
  /** Whether a wall of a house a model replaced stands within BY_MODEL of slope i's rectangle. */
  const byModel = (i: number) => {
    if (!gone.length) return false;
    const f = frames[i];
    const seen = new Set<number>();
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]) {
      const [x, z] = point(f, f.L * u, f.W * v);
      for (const k of replaced.at(x, z)) {
        if (seen.has(k)) continue;
        seen.add(k);
        const ring = gone[k].p[0];
        const near = ring.some(([px, pz]) => {
          const [a, b] = local(f, px, pz);
          return a >= -BY_MODEL && a <= f.L + BY_MODEL && b >= -BY_MODEL && b <= f.W + BY_MODEL;
        }) || [[0, 0], [1, 0], [1, 1], [0, 1]].some(([cu, cv]) => inside(ring, ...point(f, f.L * cu, f.W * cv)));
        if (near) return true;
      }
    }
    return false;
  };
  /** How far two halves' high edges run into each other at their ends (m; 0 where they meet or leave a gap). */
  const overlap = (r: RoofSpec, q: RoofSpec) => {
    let most = 0;
    for (const [a, b] of [[r, q], [q, r]]) {
      const fb = frames[indexOf.get(b)!];
      for (const c of [a.p[2], a.p[3]]) most = Math.max(most, fb.W - local(fb, c[0], c[1])[1]);
    }
    return most;
  };

  const cases = new Map<RoofSpec, RoofOutcome>();
  const partner = new Map<RoofSpec, RoofSpec>();
  const forced = (r: RoofSpec) => ROOF_OVERRIDES.find((o) => inside(r.p, o.at[0], o.at[1]))?.as;

  /** A wedge closed with a second slope from its ridge down past its high wall. */
  const close = (r: RoofSpec, look: Look): RoofSpec => {
    const { f, k, T, base } = look;
    const far = Math.max(r.y, T + FAR_CLEAR);
    const kF = Math.max(k, FAR_PITCH);
    const at = (far - r.y + kF * f.W) / (k + kF);
    return { ...r, ridge: r.y + k * at, closed: { at, far, foot: Math.max(base, T) } };
  };
  /** A ramp turned: a gable over the same rectangle, its ridge along the old slope. */
  const turn = (r: RoofSpec, look: Look): RoofSpec => {
    const { shape: _, ...rest } = r;
    return { ...rest, p: [r.p[0], r.p[3], r.p[2], r.p[1]], fixed: true, ridge: r.y + Math.min(r.ridge - r.y, (TURN_PITCH * look.f.L) / 2) };
  };

  for (const [i, look] of looks) {
    const r = roofs[i];
    const { partner: other, T } = look;
    const as = forced(r);
    if (as === 'keep') {
      cases.set(r, { kind: 'keep', why: 'override' });
      continue;
    }
    if (as === 'close' || as === 'turn') {
      cases.set(r, { kind: as });
      drawn.set(r, as === 'close' ? close(r, look) : turn(r, look));
      continue;
    }
    if (look.taken) {
      cases.set(r, { kind: 'keep', why: 'panels' });
      continue;
    }
    if (byModel(i)) {
      cases.set(r, { kind: 'keep', why: 'model' });
      continue;
    }
    const mate = other ? lookOf(other) : null;
    if (other && mate && mate.partner === r && !mate.taken && !forced(other) && overlap(r, other) <= PAIR_OVERLAP) {
      const d = Math.abs(other.ridge - r.ridge);
      const mean = (r.ridge + other.ridge) / 2;
      const j = indexOf.get(other)!;
      // Windows on either half's own walls, or one looking out over a half (or a neighbour's roof showing through one)
      // that the level top would hide.
      const fixed = look.glazed || mate.glazed || covers(i, { ...r, ridge: mean }) || covers(j, { ...other, ridge: mean })
        || exposes(i, { ...r, ridge: mean }) || exposes(j, { ...other, ridge: mean });
      if (d <= MEET || (d <= LEVEL && !fixed)) {
        cases.set(r, { kind: 'pair', levelled: d > MEET });
        continue; // drawn below, with its partner
      }
      if (other.ridge > r.ridge) {
        cases.set(r, { kind: 'keep', why: 'step' });
        continue;
      }
    }
    decide(i, look, T);
  }

  // The pairs: one top (the mean: halves closer than MEET move by at most half of it, windows or not), the tile colour
  // of the larger half, the ridge row on the larger half.
  for (const [r, c] of cases) {
    if (c.kind !== 'pair' || drawn.has(r)) continue;
    const other = lookOf(r).partner!;
    const [fr, fo] = [lookOf(r).f, lookOf(other).f];
    const top = (r.ridge + other.ridge) / 2;
    const larger = fr.L * fr.W >= fo.L * fo.W ? r : other;
    const tiles = larger.tiles;
    const kOf = (q: RoofSpec, f: Frame) => (top - q.y) / Math.max(0.5, f.W);
    const a: RoofSpec = { ...r, ridge: top, tight: true, ...(tiles ? { tiles } : {}) };
    const b: RoofSpec = { ...other, ridge: top, tight: true, ...(tiles ? { tiles } : {}) };
    if (larger === r) a.crown = kOf(other, fo);
    else b.crown = kOf(r, fr);
    drawn.set(r, a);
    drawn.set(other, b);
    partner.set(a, b);
    partner.set(b, a);
  }

  // A lean-to is judged again against what is drawn behind it: where the roof it leaned on was closed, turned or
  // levelled, its high wall may stand free now, and it is decided as any other slope (a few rounds, as one change can
  // free another).
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const [i, look] of looks) {
      const r = roofs[i];
      if (cases.get(r)?.why !== 'lean-to') continue;
      const T = heightBehind(i, true);
      if (r.ridge - Math.max(T, look.base) <= SHOW) continue;
      drawn.delete(r);
      decide(i, look, T);
      changed = true;
    }
    if (!changed) break;
  }
  return { drawn, cases, partner };

  /** A slope that is no pair: kept, turned or closed, by what stands behind it (`T` high). */
  function decide(i: number, look: Look, T: number): void {
    const r = roofs[i];
    const { f, base } = look;
    const show = r.ridge - Math.max(T, base);
    const ramp = f.W >= RAMP_W && f.W >= RAMP * f.L;
    const shape = ramp ? turn(r, look) : close(r, { ...look, T });
    if (look.glazed) cases.set(r, { kind: 'keep', why: 'windows' });
    else if (show <= SHOW) cases.set(r, { kind: 'keep', why: 'lean-to' });
    else if (r.ridge - r.y < RISE || look.k < FLAT) cases.set(r, { kind: 'keep', why: 'low' });
    else if (r.ridge - base < STOREY) cases.set(r, { kind: 'keep', why: 'one storey' });
    else if (covers(i, shape)) cases.set(r, { kind: 'keep', why: 'windows' }); // a window looks out over it
    else if (exposes(i, shape)) cases.set(r, { kind: 'keep', why: 'neighbour' }); // another roof would show through it
    else {
      cases.set(r, { kind: ramp ? 'turn' : 'close' });
      drawn.set(r, shape);
    }
    // A kept slope with something behind up to near its top stops at its high edge.
    if (cases.get(r)!.kind === 'keep' && T >= r.ridge - TIGHT) drawn.set(r, { ...r, tight: true });
  }
}

/** What stands round a set: the whole data it was cut from (main.ts), before our models' houses were taken out. */
export interface Behind {
  roofs: RoofSpec[];
  prisms: Prism[];
}
