// The Zombies party game, shared by the server (which runs it in multiplayer) and the browser
// (which runs it when you play alone): plain objects and plain functions, no three.js, no network.
//
// The players are one team round the house and the bungalow (shared/bounds.json `party`). Zombies
// come in waves from all over that area, out of sight, each wave bigger, a little faster and a
// little tougher than the last, with a break of BREAK_MS between them. From wave 3 some of them are
// runners: as fast as you nearly, and fragile. A zombie goes for the nearest player who fights
// (Action or Paintball), round walls, fences, hedges and the parked cars, and into the houses after
// them: up their stairs, through their doors (a closed one it shoves open) and through a pane that
// was shot out. A distance field over the grid (makeNav) is worked out from the players a few times a
// second, and each zombie steps downhill on it. Close by, with a clear way, it walks straight at
// them. Next to you it swipes (an attack you can step away from: the hit lands after a wind-up),
// never through a wall or a floor. Every fifth wave brings big ones, slow and tough, who pound the
// ground round them. Who stands where no zombie can reach (a roof, a car's roof) is warned, and out
// of the wave if they stay.
//
// Who is down waits for the end of the wave; when every player who fights is down at once, the
// game is over (Horde.tick says so). The caller keeps the players' health and the messages.

/** The four kinds of regular zombie (web/public/models/zombies.glb), then the big one. */
export const VARIANTS = ['shirt', 'hoodie', 'overall', 'farmer'];
export const BIG = 4;
/** The runners are always the teen in the hoodie (so you know one from afar); the others walk. */
export const RUNNER = 1;
const WALKERS = [0, 2, 3];

export const ZOMBIE = {
  /** m: the side of a square of the grid outdoors, and in the houses */
  cell: 0.5,
  fine: 0.25,
  /** ms: the first wave comes after this, the next ones after BREAK */
  firstBreak: 8000,
  break: 15000,
  /** The most up at once, however many players */
  maxAlive: 30,
  /** m: a zombie's half width (they keep this far apart); the big one's */
  radius: 0.35,
  bigRadius: 0.8,
  /** m: from this close (middle to middle) a zombie swipes, and the swipe reaches this far when it lands */
  attackFrom: 1.15,
  reach: 1.55,
  bigFrom: 2.1,
  bigReach: 3.4,
  /** ms: from the start of a swipe (or a pound) to its hit, and to its end */
  impact: 450,
  attackMs: 900,
  bigImpact: 800,
  bigAttackMs: 1500,
  /** ms between two swipes of one zombie; a player hit can't be hit again this soon */
  swipeEvery: 1300,
  bigEvery: 2600,
  shield: 400,
  /** ms a hit zombie staggers; a fallen one lies this long before it is gone */
  hurtMs: 350,
  downMs: 3000,
  /** m: closer than this, with a clear way, a zombie walks straight at you */
  straight: 7,
  /** m along the way: the distance field reaches this far round the players */
  fieldReach: 110,
  /** ms between two distance fields */
  fieldEvery: 500,
  /** m: a zombie comes out at least this far from every player, best from about `spawnBest` to `spawnFar`, never past `spawnMax` (unless nowhere nearer will do), out of sight */
  spawnMin: 13,
  spawnBest: 15,
  spawnFar: 28,
  spawnMax: 40,
  /** Runners: from this wave, this share of the wave (a little more each wave, at most `runMax`) */
  runFrom: 3,
  runShare: 0.12,
  runGrow: 0.02,
  runMax: 0.3,
  /** m/s: a runner's pace (a player runs 3.5) */
  runSpeed: 3.0,
  runTop: 3.4,
  /** ms: out of every zombie's reach this long, a player is warned; this much longer, out of the wave */
  perchWarn: 2000,
  perchMs: 10000,
  /** ms: a door a zombie shoved counts as open this long (until the server's own word is back) */
  shoveMs: 1500,
  /** ms a zombie stands at a closed door, shoving it */
  shoveFor: 600,
};

/** In the grids' unit (UNIT m): a step straight, one diagonal, and one more next to a wall. */
const UNIT = 0.125;
const INF = 0xffff;
/** m: the most a zombie steps up or down from one square to the next (as a player: two stair risers) */
const STEP = 0.5;
/** m: what stands lower than this on a floor doesn't close its square (the next step of a stair) */
const LOW = 0.3;
/** m of room a zombie needs over a floor */
const HEAD = 1.75;
/** m: a player this far above or below a zombie's feet is within its swipe (not on a roof, nor a floor below) */
const LEVEL_LO = -0.6;
const LEVEL_HI = 2.1;
/** The glass in door leaves is numbered from here, after the house's own blocks (src/world/doors.ts DOOR_GLASS). */
const DOOR_GLASS = 3000;

/** Whether (x, z) is inside the outline `ring` ([x, z] points). */
function inside(x, z, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Even-odd across an outline and its holes (a floor with its stairwell cut out), as the page's collision. */
function insideRings(x, z, rings) {
  let hit = false;
  for (const ring of rings) if (inside(x, z, ring)) hit = !hit;
  return hit;
}

/**
 * The squares of a grid (origin ox, oz; side cs) whose middle is inside `rings` (even-odd, as
 * insideRings), row by row: fn(i, j) for each, i in [i0, i1] and j in [j0, j1]. Each row's crossings
 * with the outline are found once, so a big lawn costs its edges per row, not its edges per square.
 */
const xs = [];
function scan(rings, ox, oz, cs, i0, i1, j0, j1, fn) {
  for (let j = j0; j <= j1; j++) {
    const z = oz + (j + 0.5) * cs;
    xs.length = 0;
    for (const ring of rings) {
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const za = ring[a][1], zb = ring[b][1];
        if (za > z !== zb > z) xs.push(((ring[b][0] - ring[a][0]) * (z - za)) / (zb - za) + ring[a][0]);
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const a = Math.max(i0, Math.ceil((xs[q] - ox) / cs - 0.5));
      const b = Math.min(i1, Math.ceil((xs[q + 1] - ox) / cs - 0.5) - 1);
      for (let i = a; i <= b; i++) fn(i, j);
    }
  }
}

/** Whether segments a-b and c-d cross. */
function crosses(ax, az, bx, bz, cx, cz, dx, dz) {
  const s = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  return s(cx, cz, dx, dz, ax, az) * s(cx, cz, dx, dz, bx, bz) < 0 && s(ax, az, bx, bz, cx, cz) * s(ax, az, bx, bz, dx, dz) < 0;
}

/**
 * How many zombies wave `n` (1, 2 ...) brings with `players` who fight: 3 + 2n, times 1 for one
 * player, 2.2 for four, 3.8 for eight, 5 for sixteen. The big ones come on top (bigOf).
 */
export function waveSize(n, players) {
  const p = Math.max(1, players);
  return Math.round((3 + 2 * n) * (0.6 + 0.4 * Math.min(p, 8) + 0.15 * Math.max(0, p - 8)));
}

/** Big zombies in wave `n`: one every fifth wave, two every tenth, at most three. */
export function bigOf(n) {
  return n % 5 === 0 ? Math.min(3, n / 5) : 0;
}

/** Runners among the `size` regular zombies of wave `n`: none before ZOMBIE.runFrom, then 12% growing 2% a wave to 30% (at least one). */
export function runnersOf(n, size) {
  if (n < ZOMBIE.runFrom || size < 1) return 0;
  const share = Math.min(ZOMBIE.runMax, ZOMBIE.runShare + ZOMBIE.runGrow * (n - ZOMBIE.runFrom));
  return Math.min(size, Math.max(1, Math.round(size * share)));
}

/** The most up at once: 11 alone, 20 for four, 30 from eight players. */
export function aliveCap(players) {
  return Math.min(ZOMBIE.maxAlive, 8 + 3 * Math.max(1, players));
}

/**
 * A zombie of wave `n`: how fast it walks (m/s: half the 1.4 of walking at first, about it by wave 13,
 * never as fast as the 3.5 of running; their walk clip's own pace is about 0.45 and their lurch's
 * about 0.95, so the walk is never played much faster than it was made), its health and its swipe.
 * The big one is slower, eight times as tough and hits much harder. A runner sprints at 3.0 to 3.4
 * (you just outrun one in a straight line) with half the health. `jitter` (0..1) spreads their speeds.
 */
export function zombieStats(n, big, jitter = 0.5, runner = false) {
  const k = n - 1;
  if (big) return { speed: Math.min(1.2, 0.6 + 0.03 * k), hp: 8 * (50 + 12 * k), damage: 30 };
  const damage = Math.min(25, 10 + k);
  if (runner) return { speed: Math.min(ZOMBIE.runTop, ZOMBIE.runSpeed + 0.02 * Math.max(0, n - ZOMBIE.runFrom) + 0.2 * jitter), hp: Math.round((50 + 12 * k) / 2), damage };
  return { speed: Math.min(2.3, 0.65 + 0.06 * k) * (0.9 + 0.2 * jitter), hp: 50 + 12 * k, damage };
}

/** ms between two zombies coming out: quicker in later waves. */
export function spawnEvery(n) {
  return Math.max(250, 900 - 60 * n);
}

/**
 * Where the houses' own grids lie: round the main house (with its outside stair and roof terrace)
 * and round the bungalow, `pad` m wider. In them zombies walk every floor (makeNav).
 */
export function houseAreas(prisms, pad = 1) {
  const groups = { house: [], bungalow: [] };
  for (const p of prisms) {
    if (typeof p.n !== 'string') continue;
    if (p.n === 'ground floor' || p.n === 'roof terrace' || /^outside stair/.test(p.n)) groups.house.push(p);
    else if (/\(old house\)$/.test(p.n) && !/^driveway/i.test(p.n)) groups.bungalow.push(p);
  }
  return Object.values(groups).filter((g) => g.length).map((g) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of g) for (const [x, z] of p.p[0]) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  });
}

/** Each block's outline box and middle, `out` [minX, maxX, minZ, maxZ, middle x, middle z] per block. */
function boxesOf(prisms) {
  const out = new Float64Array(prisms.length * 6);
  for (let pi = 0; pi < prisms.length; pi++) {
    const ring = prisms[pi].p?.[0];
    if (!ring || ring.length < 2) {
      out.fill(NaN, pi * 6, pi * 6 + 6);
      continue;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sx = 0, sz = 0;
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      sx += x;
      sz += z;
    }
    out.set([minX, maxX, minZ, maxZ, sx / ring.length, sz / ring.length], pi * 6);
  }
  return out;
}

/** The houses' grids (makeNav): their areas on the outdoor grid's lines, a column per FINE m square. */
class HouseGrid {
  constructor(areas, x0, z0, nx, nz) {
    const C = ZOMBIE.cell;
    this.F = ZOMBIE.fine;
    this.areas = areas.map((a) => {
      const i0 = Math.max(2, Math.floor((a.minX - x0) / C)), i1 = Math.min(nx - 2, Math.ceil((a.maxX - x0) / C));
      const j0 = Math.max(2, Math.floor((a.minZ - z0) / C)), j1 = Math.min(nz - 2, Math.ceil((a.maxZ - z0) / C));
      return { i0, i1, j0, j1, ax: x0 + i0 * C, az: z0 + j0 * C, bx: x0 + i1 * C, bz: z0 + j1 * C, ncx: (i1 - i0) * 2, ncz: (j1 - j0) * 2, colBase: 0 };
    }).filter((A) => A.ncx > 0 && A.ncz > 0);
    let cols = 0;
    for (const A of this.areas) {
      A.colBase = cols;
      cols += A.ncx * A.ncz;
    }
    this.cols = cols;
    this.colArea = new Int32Array(cols);
    this.areas.forEach((A, a) => this.colArea.fill(a, A.colBase, A.colBase + A.ncx * A.ncz));
  }

  areaAt(x, z) {
    for (const A of this.areas) if (x >= A.ax && x < A.bx && z >= A.az && z < A.bz) return A;
    return null;
  }

  /** Whether the outline box lies wholly in one area. */
  holds(minX, maxX, minZ, maxZ) {
    for (const A of this.areas) if (minX >= A.ax && maxX <= A.bx && minZ >= A.az && maxZ <= A.bz) return true;
    return false;
  }

  /** The column at (x, z), or -1. */
  colAt(x, z) {
    const A = this.areaAt(x, z);
    if (!A) return -1;
    return A.colBase + Math.min(A.ncx - 1, Math.floor((x - A.ax) / this.F)) * A.ncz + Math.min(A.ncz - 1, Math.floor((z - A.az) / this.F));
  }

  colX(c) {
    const A = this.areas[this.colArea[c]];
    return A.ax + (Math.floor((c - A.colBase) / A.ncz) + 0.5) * this.F;
  }

  colZ(c) {
    const A = this.areas[this.colArea[c]];
    return A.az + (((c - A.colBase) % A.ncz) + 0.5) * this.F;
  }
}

/**
 * The outdoor grid's marks (makeNav): every block standing 0.4 to 2.2 m over the ground closes the
 * squares it stands in (`g.block`), and those over 1.6 m (glass aside) block sight (`g.tall`).
 * Blocks wholly in a house's grid are left to it.
 */
function markOutdoors(prisms, bb, glassy, housed, height, g) {
  const C = ZOMBIE.cell;
  const { x0, z0, nx, nz, block, tall } = g;
  const cellAt = (x, z) => {
    const i = Math.floor((x - x0) / C);
    const j = Math.floor((z - z0) / C);
    return i < 1 || j < 1 || i >= nx - 1 || j >= nz - 1 ? -1 : i * nz + j;
  };
  const mark = (k, high) => {
    if (k < 0) return;
    block[k] = 1;
    if (high) tall[k] = 1;
  };
  for (let pi = 0; pi < prisms.length; pi++) {
    if (housed[pi]) continue;
    const o = pi * 6;
    const minX = bb[o], maxX = bb[o + 1], minZ = bb[o + 2], maxZ = bb[o + 3];
    if (!(maxX >= x0 && minX <= x0 + nx * C && maxZ >= z0 && minZ <= z0 + nz * C)) continue;
    const p = prisms[pi];
    // Heights over the ground: a draped block (a hedge, a fence: `d`) follows the relief, a house stands at its middle's.
    const lift = p.d ? 0 : height(bb[o + 4], bb[o + 5]);
    if (p.y1 - lift < 0.4 || p.y0 - lift > 2.2) continue;
    const high = !glassy[pi] && p.y1 - lift > 1.6;
    const i0 = Math.max(1, Math.floor((minX - x0) / C)), i1 = Math.min(nx - 2, Math.floor((maxX - x0) / C));
    const j0 = Math.max(1, Math.floor((minZ - z0) / C)), j1 = Math.min(nz - 2, Math.floor((maxZ - z0) / C));
    scan(p.p, x0, z0, C, i0, i1, j0, j1, (i, j) => mark(i * nz + j, high));
    // Its sides, every quarter of a square: a thin fence has no square's middle inside it.
    for (const r of p.p) {
      for (let a = 0; a < r.length; a++) {
        const ax = r[a][0], az = r[a][1];
        const b = r[(a + 1) % r.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - ax, b[1] - az) / (C / 4)));
        for (let s = 0; s <= steps; s++) mark(cellAt(ax + ((b[0] - ax) * s) / steps, az + ((b[1] - az) * s) / steps), high);
      }
    }
  }
}

/** The cars (makeNav `boxes`) close the outdoor squares under them, with 15 cm round. */
function markCars(boxes, g) {
  const C = ZOMBIE.cell;
  const { x0, z0, nx, nz, block } = g;
  for (const b of boxes) {
    const r = Math.hypot(b.halfL, b.halfW) + C;
    const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw); // the game's yaw: forward is -z at 0 (shared/parking.mjs)
    for (let x = b.x - r; x <= b.x + r; x += C / 2) {
      for (let z = b.z - r; z <= b.z + r; z += C / 2) {
        const dx = x - b.x, dz = z - b.z;
        const i = Math.floor((x - x0) / C), j = Math.floor((z - z0) / C);
        if (i < 1 || j < 1 || i >= nx - 1 || j >= nz - 1) continue;
        if (Math.abs(dx * fx + dz * fz) <= b.halfL + 0.15 && Math.abs(dx * -fz + dz * fx) <= b.halfW + 0.15) block[i * nz + j] = 1;
      }
    }
  }
}

/** Outdoor squares next to a closed one (not one in a house's grid): a step onto them costs more, so the way keeps off walls. */
function markNear(block, boxed, near, nx, nz) {
  const ring = [nz - 1, nz, nz + 1, -nz - 1, -nz, -nz + 1, -1, 1];
  for (let i = 1; i < nx - 1; i++) {
    for (let j = 1, k = i * nz + 1; j < nz - 1; j++, k++) {
      if (block[k] || boxed[k]) continue;
      for (let s = 0; s < 8; s++) {
        const q = k + ring[s];
        if (block[q] && !boxed[q]) {
          near[k] = 1;
          break;
        }
      }
    }
  }
}

/**
 * What stands in each column of the houses' grids (makeNav): per column a flat list of
 * [y0, y1, pane, block (-1 a door's leaf), whole (its middle is inside)] in the world's heights (a
 * draped block follows the relief). Every block, whatever its height: floors, stairs, walls, roofs;
 * then the doors' leaves where they stand shut (alone all of them, together only the fixed halves).
 */
function houseColumns(prisms, bb, glassy, panes, doors, shut, H, height) {
  const F = ZOMBIE.fine;
  const ivs = Array.from({ length: H.cols }, () => []);
  const seen = new Int32Array(H.cols).fill(-1);
  let id = 0;
  const putIn = (c, lifted, pi, pane, y0, y1, whole) => {
    if (c < 0 || seen[c] === id) return;
    seen[c] = id;
    const lift = lifted ? height(H.colX(c), H.colZ(c)) : 0;
    ivs[c].push(y0 + lift, y1 + lift, pane, pi, whole);
  };
  for (let pi = 0; pi < prisms.length; pi++) {
    const o = pi * 6;
    const minX = bb[o], maxX = bb[o + 1], minZ = bb[o + 2], maxZ = bb[o + 3];
    if (!(minX === minX)) continue; // no outline
    const p = prisms[pi];
    const pane = glassy[pi] && pi < panes && p.m === 'glass' ? pi : -1;
    for (const A of H.areas) {
      if (maxX < A.ax || minX > A.bx || maxZ < A.az || minZ > A.bz) continue;
      id++;
      const i0 = Math.max(0, Math.floor((minX - A.ax) / F)), i1 = Math.min(A.ncx - 1, Math.floor((maxX - A.ax) / F));
      const j0 = Math.max(0, Math.floor((minZ - A.az) / F)), j1 = Math.min(A.ncz - 1, Math.floor((maxZ - A.az) / F));
      scan(p.p, A.ax, A.az, F, i0, i1, j0, j1, (i, j) => putIn(A.colBase + i * A.ncz + j, !!p.d, pi, pane, p.y0, p.y1, 1));
      for (const r of p.p) {
        for (let a = 0; a < r.length; a++) {
          const ax = r[a][0], az = r[a][1];
          const b = r[(a + 1) % r.length];
          if (Math.max(ax, b[0]) < A.ax || Math.min(ax, b[0]) > A.bx || Math.max(az, b[1]) < A.az || Math.min(az, b[1]) > A.bz) continue;
          const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - ax, b[1] - az) / (F / 2)));
          for (let s = 0; s <= steps; s++) putIn(H.colAt(ax + ((b[0] - ax) * s) / steps, az + ((b[1] - az) * s) / steps), !!p.d, pi, pane, p.y0, p.y1, 0);
        }
      }
    }
  }
  let doorGlass = DOOR_GLASS;
  for (const d of doors) {
    for (const panel of d.panels ?? []) {
      const pane = panel.glass ? doorGlass++ : -1;
      const moves = (panel.slide && (panel.slide[0] || panel.slide[1])) || panel.swing;
      if (!shut && moves) continue;
      const [ax, az] = panel.a;
      const [bx, bz] = panel.b;
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const ox = (-(bz - az) / len) * (panel.offset ?? 0), oz = ((bx - ax) / len) * (panel.offset ?? 0);
      id++;
      const steps = Math.max(1, Math.ceil(len / (F / 4)));
      for (let s = 0; s <= steps; s++) putIn(H.colAt(ax + ox + ((bx - ax) * s) / steps, az + oz + ((bz - az) * s) / steps), false, -1, pane, d.y0, d.y1, 0);
    }
  }
  return ivs;
}

/**
 * The houses' floors (makeNav): per column, each top (and the ground) with HEAD of room over it, the
 * higher of two within LOW (a step on a floor: the step's top). A pane in a floor's room closes it
 * while whole (`blk`). Also each column's blocks (for a swipe's way), and the outdoor squares a wall
 * at eye height stands in (`tall`: sight).
 */
function houseFloors(ivs, H, ground, glassy, markTall) {
  const fy = [];
  const fcol = [];
  const fblk = [];
  const colStart = new Int32Array(H.cols + 1);
  const colPrStart = new Int32Array(H.cols + 1);
  const colPr = [];
  const cand = new Float64Array(256);
  const okH = new Float64Array(256);
  const okB = [];
  const NONE = [];
  for (let c = 0; c < H.cols; c++) {
    colStart[c] = fy.length;
    colPrStart[c] = colPr.length;
    const L = ivs[c];
    const g = ground(H.colX(c), H.colZ(c));
    if (!L.length) {
      fy.push(g);
      fcol.push(c);
      fblk.push(NONE);
      continue;
    }
    let nc = 0;
    cand[nc++] = g;
    let eye = false;
    for (let q = 0; q < L.length; q += 5) {
      const pi = L[q + 3];
      if (pi >= 0) {
        colPr.push(pi);
        if (!eye && L[q] < g + 1.2 && L[q + 1] > g + 1.6 && !glassy[pi]) eye = true;
      }
      if (L[q + 4] && L[q + 2] < 0 && nc < 256) cand[nc++] = L[q + 1];
    }
    if (eye) markTall(c);
    for (let a = 1; a < nc; a++) {
      for (let b = a; b > 0 && cand[b - 1] > cand[b]; b--) {
        const t = cand[b - 1];
        cand[b - 1] = cand[b];
        cand[b] = t;
      }
    }
    let nok = 0;
    for (let a = 0; a < nc; a++) {
      const h = cand[a];
      if (a && h - cand[a - 1] < 0.01) continue;
      let open = true;
      let blk = NONE;
      for (let q = 0; q < L.length; q += 5) {
        if (L[q + 1] <= h + LOW || L[q] >= h + HEAD) continue;
        if (L[q + 2] < 0) {
          open = false;
          break;
        }
        if (!blk.includes(L[q + 2])) blk = [...blk, L[q + 2]];
      }
      if (!open) continue;
      okH[nok] = h;
      okB[nok++] = blk;
    }
    for (let a = 0; a < nok; a++) {
      if (a + 1 < nok && okH[a + 1] - okH[a] <= LOW) continue;
      fy.push(okH[a]);
      fcol.push(c);
      fblk.push(okB[a]);
    }
  }
  colStart[H.cols] = fy.length;
  colPrStart[H.cols] = colPr.length;
  return { FY: Float32Array.from(fy), FCOL: Int32Array.from(fcol), fblk, colStart, colPrStart, COLPR: Int32Array.from(colPr) };
}

/**
 * The houses' floors joined (makeNav): to the next square's floor within STEP (a diagonal only with
 * both squares beside it holding a floor too, and no glass in any of them), and to the outdoor
 * square past their grid's edge when its ground is within STEP. Floor v's links are
 * ADJ[adjStart[v] .. adjStart[v + 1]] (nodes: outdoors < n, the houses' n + floor), with their costs.
 */
function houseLinks(fl, H, n, g, ground) {
  const F = ZOMBIE.fine;
  const C = ZOMBIE.cell;
  const { FY, FCOL, fblk, colStart } = fl;
  const m = FY.length;
  const { x0, z0, nx, nz, block } = g;
  const floorIn = (c, h) => {
    let best = -1;
    let bd = STEP;
    for (let v = colStart[c]; v < colStart[c + 1]; v++) {
      const d = Math.abs(FY[v] - h);
      if (d <= bd) {
        best = v;
        bd = d;
      }
    }
    return best;
  };
  const DI = [1, -1, 0, 0, 1, 1, -1, -1];
  const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  const adjStart = new Int32Array(m + 1);
  const ADJ = new Int32Array(m * 8);
  const ACOST = new Uint8Array(m * 8);
  const fnear = new Uint8Array(m);
  const seams = new Map(); // outdoor square -> the house floors it joins
  let ne = 0;
  for (let v = 0; v < m; v++) {
    adjStart[v] = ne;
    const c = FCOL[v];
    const A = H.areas[H.colArea[c]];
    const li = Math.floor((c - A.colBase) / A.ncz);
    const lj = (c - A.colBase) % A.ncz;
    const h = FY[v];
    for (let s = 0; s < 8; s++) {
      const i2 = li + DI[s], j2 = lj + DJ[s];
      if (i2 < 0 || j2 < 0 || i2 >= A.ncx || j2 >= A.ncz) {
        if (s >= 4) continue;
        const i = Math.floor((H.colX(c) + DI[s] * F - x0) / C), j = Math.floor((H.colZ(c) + DJ[s] * F - z0) / C);
        const k = i < 1 || j < 1 || i >= nx - 1 || j >= nz - 1 ? -1 : i * nz + j;
        if (k >= 0 && !block[k] && Math.abs(ground(x0 + (i + 0.5) * C, z0 + (j + 0.5) * C) - h) <= STEP) {
          ADJ[ne] = k;
          ACOST[ne++] = 3;
          if (!seams.has(k)) seams.set(k, []);
          seams.get(k).push(n + v);
        } else fnear[v] = 1;
        continue;
      }
      const w = floorIn(A.colBase + i2 * A.ncz + j2, h);
      if (w < 0) {
        fnear[v] = 1;
        continue;
      }
      if (s >= 4) {
        const sa = floorIn(A.colBase + i2 * A.ncz + lj, h);
        const sb = floorIn(A.colBase + li * A.ncz + j2, h);
        if (sa < 0 || sb < 0 || fblk[sa].length || fblk[sb].length || fblk[v].length || fblk[w].length) continue;
      }
      ADJ[ne] = n + w;
      ACOST[ne++] = s < 4 ? 2 : 3;
    }
  }
  adjStart[m] = ne;
  return { adjStart, ADJ, ACOST, fnear, seams };
}

/**
 * Which open nodes join up (`region`: the same number), by a search from each one not yet numbered:
 * outdoors by the eight steps (`open`), across the seams into the houses and their links back.
 */
function labelRegions(region, queue, N, n, isOpen, open, OFF, seamOf, seams, enabled, adjStart, ADJ) {
  region.fill(-1);
  let label = 0;
  for (let k0 = 0; k0 < N; k0++) {
    if (region[k0] >= 0 || !isOpen(k0)) continue;
    let head = 0, tail = 0;
    queue[tail++] = k0;
    region[k0] = label;
    while (head < tail) {
      const k = queue[head++];
      if (k < n) {
        for (let s = 0; s < 8; s++) {
          const q = k + OFF[s];
          if (region[q] < 0 && open(k, s)) {
            region[q] = label;
            queue[tail++] = q;
          }
        }
        if (seamOf[k]) {
          for (const q of seams.get(k)) {
            if (region[q] < 0 && enabled[q - n]) {
              region[q] = label;
              queue[tail++] = q;
            }
          }
        }
        continue;
      }
      for (let e = adjStart[k - n]; e < adjStart[k - n + 1]; e++) {
        const q = ADJ[e];
        if (region[q] < 0 && isOpen(q)) {
          region[q] = label;
          queue[tail++] = q;
        }
      }
    }
    label++;
  }
}

/**
 * The grid the zombies walk on, over the area `edge` (shared/bounds.mjs: the party outline).
 *
 * Outdoors, squares of CELL m: a square is closed when it lies outside the edge, or when a wall,
 * hedge, fence or house of `prisms` stands in it from 0.4 to 2.2 m above the ground (as the
 * strongmen's map in server/game.mjs, but every side of a block is drawn in, so a fence 5 cm thick
 * closes its squares), or a car of `boxes` ({ x, z, yaw, halfL, halfW }). Those over 1.6 m (glass
 * aside: it is seen through) also block sight. `height(x, z)`: the relief (shared/terrain.mjs);
 * `base` the bare ground's height on it. About 160,000 squares for the party area.
 *
 * In `areas` (houseAreas: the houses and round them), squares of FINE m with every floor in them:
 * each square holds a floor wherever a block's top (or the ground) has HEAD of room over it, and
 * two floors next to each other join when they are at most STEP apart (a stair's steps, a door's
 * sill). So zombies go up the stairs, through doorways and onto the roof terrace, and never through
 * a wall or a floor. Their glass (the house's own blocks among the first `panes` of `prisms`, and
 * the door leaves' panes from DOOR_GLASS) closes a square until it is broken (setPanes). `doors`:
 * the house data's doors; `shut` (alone: the houses are shut) puts every leaf in as a wall, else
 * only their fixed halves (together a zombie shoves a closed door open: Horde).
 *
 * The squares are the grid's nodes: those outdoors numbered as squares, the houses' after them.
 */
export function makeNav({ prisms, height, base = 0, edge, boxes = [], areas = [], doors = [], shut = true, panes = 0 }) {
  const C = ZOMBIE.cell;
  const F = ZOMBIE.fine;
  const x0 = Math.floor(edge.minX) - 1;
  const z0 = Math.floor(edge.minZ) - 1;
  const nx = Math.ceil((edge.maxX + 1 - x0) / C) + 1;
  const nz = Math.ceil((edge.maxZ + 1 - z0) / C) + 1;
  const n = nx * nz;
  const block = new Uint8Array(n);
  const tall = new Uint8Array(n);
  const near = new Uint8Array(n); // next to a closed square: a step costs more, so the way keeps off walls
  const boxed = new Uint8Array(n); // in a house's grid instead
  const cellAt = (x, z) => {
    const i = Math.floor((x - x0) / C);
    const j = Math.floor((z - z0) / C);
    return i < 1 || j < 1 || i >= nx - 1 || j >= nz - 1 ? -1 : i * nz + j;
  };
  const cx = (k) => x0 + (Math.floor(k / nz) + 0.5) * C;
  const cz = (k) => z0 + ((k % nz) + 0.5) * C;
  const ground = (x, z) => base + height(x, z);
  const g = { x0, z0, nx, nz, block, tall };

  // The houses' grids, on the outdoor grid's lines (a square outdoors is in one whole or not at all).
  const H = new HouseGrid(areas, x0, z0, nx, nz);
  for (const A of H.areas) for (let i = A.i0; i < A.i1; i++) for (let j = A.j0; j < A.j1; j++) boxed[i * nz + j] = 1;
  const colAt = (x, z) => H.colAt(x, z);
  const colX = (c) => H.colX(c);
  const colZ = (c) => H.colZ(c);
  const areaAt = (x, z) => H.areaAt(x, z);

  // Open only inside the edge (and never on the grid's own rim): its outline row by row, or square by square.
  block.fill(1);
  if (edge.ring) scan([edge.ring], x0, z0, C, 1, nx - 2, 1, nz - 2, (i, j) => (block[i * nz + j] = 0));
  else for (let i = 1; i < nx - 1; i++) for (let j = 1; j < nz - 1; j++) if (edge.inside(x0 + (i + 0.5) * C, z0 + (j + 0.5) * C)) block[i * nz + j] = 0;
  const bb = boxesOf(prisms);
  const glassy = new Uint8Array(prisms.length); // glass is seen through
  const housed = new Uint8Array(prisms.length); // wholly in a house's grid: walked round there
  for (let pi = 0; pi < prisms.length; pi++) {
    if (/glass/.test(prisms[pi].m ?? '')) glassy[pi] = 1;
    if (H.holds(bb[pi * 6], bb[pi * 6 + 1], bb[pi * 6 + 2], bb[pi * 6 + 3])) housed[pi] = 1;
  }
  markOutdoors(prisms, bb, glassy, housed, height, g);
  markCars(boxes, g);
  markNear(block, boxed, near, nx, nz);
  for (let k = 0; k < n; k++) if (boxed[k]) block[k] = 1; // walked in the house's grid, not here

  // The houses' floors and their links.
  const ivs = houseColumns(prisms, bb, glassy, panes, doors, shut, H, height);
  const fl = houseFloors(ivs, H, ground, glassy, (c) => {
    const k = cellAt(colX(c), colZ(c));
    if (k >= 0) tall[k] = 1;
  });
  ivs.length = 0;
  const { FY, FCOL, fblk, colStart, colPrStart, COLPR } = fl;
  const m = FY.length;
  const N = n + m;
  const enabled = new Uint8Array(m).fill(1);
  const paned = []; // floors a pane closes
  for (let v = 0; v < m; v++) {
    if (!fblk[v].length) continue;
    enabled[v] = 0;
    paned.push(v);
  }
  const { adjStart, ADJ, ACOST, fnear, seams } = houseLinks(fl, H, n, g, ground);
  const seamOf = new Uint8Array(n);
  for (const k of seams.keys()) seamOf[k] = 1;
  const blkStart = new Int32Array(m + 1);
  const blkPane = [];
  for (let v = 0; v < m; v++) {
    blkStart[v] = blkPane.length;
    for (const q of fblk[v]) blkPane.push(q);
  }
  blkStart[m] = blkPane.length;
  fblk.length = 0;
  let broken = new Set();

  // The outdoor steps: their offset in the grid and cost (a square 4, a diagonal 6); a diagonal only
  // when both squares beside it are open (no cutting a wall's corner): SIDE_A and SIDE_B (0 for a straight step).
  const OFF = Int32Array.from([nz, -nz, 1, -1, nz + 1, nz - 1, -nz + 1, -nz - 1]);
  const COST = Uint8Array.from([4, 4, 4, 4, 6, 6, 6, 6]);
  const SIDE_A = Int32Array.from([0, 0, 0, 0, nz, nz, -nz, -nz]);
  const SIDE_B = Int32Array.from([0, 0, 0, 0, 1, -1, 1, -1]);
  const open = (k, s) => !block[k + OFF[s]] && (s < 4 || (!block[k + SIDE_A[s]] && !block[k + SIDE_B[s]]));
  const isOpen = (q) => (q < n ? !block[q] : enabled[q - n] === 1);
  /** Every node joined to node `k` (`fn(q)`). */
  const around = (k, fn) => {
    if (k < n) {
      for (let s = 0; s < 8; s++) if (open(k, s)) fn(k + OFF[s]);
      if (seamOf[k]) for (const q of seams.get(k)) if (enabled[q - n]) fn(q);
      return;
    }
    const v = k - n;
    for (let e = adjStart[v]; e < adjStart[v + 1]; e++) if (isOpen(ADJ[e])) fn(ADJ[e]);
  };

  const buckets = Array.from({ length: 16 }, () => []);
  const dist = new Uint16Array(N).fill(INF);
  // A distance counts only when stamped with the field's number: no clearing 160,000 squares each time.
  const stamp = new Uint16Array(N);
  let epoch = 0;
  const at = (k) => (stamp[k] === epoch ? dist[k] : INF);
  const want = new Uint8Array(N);
  // Which open nodes join up: worked out once, and again after a pane breaks or is mended, so a spot
  // the players can't be reached from (a closed-off garden) is known without a field reaching it.
  const region = new Int32Array(N);
  let regionsDirty = true;
  let version = 0;
  const queue = new Int32Array(N);
  const regions = () => {
    if (!regionsDirty) return;
    regionsDirty = false;
    version++;
    labelRegions(region, queue, N, n, isOpen, open, OFF, seamOf, seams, enabled, adjStart, ADJ);
  };
  regions();

  /** The node at (x, z) in the column or square there (the highest floor at most `up` above y), or -1. */
  const locate = (x, y, z, up = 0.5) => {
    const c = colAt(x, z);
    if (c >= 0) {
      let best = -1;
      for (let v = colStart[c]; v < colStart[c + 1]; v++) if (enabled[v] && FY[v] <= y + up && (best < 0 || FY[v] > FY[best])) best = v;
      return best < 0 ? -1 : n + best;
    }
    const k = cellAt(x, z);
    return k >= 0 && !block[k] ? k : -1;
  };
  const nodeY = (k, x, z) => (k < n ? ground(x ?? cx(k), z ?? cz(k)) : FY[k - n]);
  const nodeX = (k) => (k < n ? cx(k) : colX(FCOL[k - n]));
  const nodeZ = (k) => (k < n ? cz(k) : colZ(FCOL[k - n]));
  const half = (k) => (k < n ? C / 2 : F / 2);
  // Places round a point, nearest first, to look for a floor a player can be reached from (seed).
  const RINGS = [];
  for (let a = -6; a <= 6; a++) for (let b = -6; b <= 6; b++) if (a * a + b * b <= 36) RINGS.push([a * F, b * F, Math.hypot(a, b) * F]);
  RINGS.sort((p, q) => p[2] - q[2]);

  return {
    cell: C,
    x0, z0, nx, nz,
    /** How many nodes, outdoors (the first) and in the houses. */
    nodes: N,
    outdoor: n,
    /** The bare ground's height at (x, z). */
    ground,
    /** Whether a zombie can stand at (x, z) outdoors (not in a house's grid). */
    walkable(x, z) {
      const k = cellAt(x, z);
      return k >= 0 && !block[k];
    },
    /** Whether (x, z) lies in a house's grid. */
    inHouse(x, z) {
      return !!areaAt(x, z);
    },
    /**
     * Whether the line from a to b stays on open ground outdoors (a house's grid counts as shut: its
     * floors are walked there); `sight`: only the tall things count, glass aside (the houses' walls too).
     */
    clear(ax, az, bx, bz, sight = false) {
      const grid = sight ? tall : block;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (C / 2)));
      for (let s = 1; s < steps; s++) {
        const k = cellAt(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
        if (k < 0 || grid[k]) return false;
      }
      return true;
    },
    /** The node a zombie or player at (x, y, z) stands on (a floor at most `up` above their feet), or -1. */
    locate,
    /**
     * Where a player at (x, y, z) can be got at from: the node they stand on, or the nearest one within
     * 1.5 m at their level (they stand on a counter, a car's roof). `gap`: how far from that node's
     * square they are (m), and (x, z) the point of it nearest them. With `accept(node, x, z, gap)`,
     * only places it accepts (joined to where the zombies come out: a bathroom cabinet's top has room
     * over it but no way up; a swipe from there reaches them). Null when there is none.
     */
    seed(x, y, z, accept = null) {
      const k = locate(x, y, z);
      if (k >= 0) {
        const dy = y - nodeY(k, x, z);
        if (dy > LEVEL_LO && dy < LEVEL_HI && (!accept || accept(k, x, z, 0))) return { node: k, gap: 0, x, z };
      }
      for (const [dx, dz] of RINGS) {
        const q = locate(x + dx, y, z + dz, 0.3);
        if (q < 0) continue;
        const dy = y - nodeY(q, x + dx, z + dz);
        if (dy <= LEVEL_LO || dy >= LEVEL_HI) continue;
        const hx = half(q);
        const px = Math.max(nodeX(q) - hx, Math.min(nodeX(q) + hx, x)), pz = Math.max(nodeZ(q) - hx, Math.min(nodeZ(q) + hx, z));
        const gap = Math.hypot(x - px, z - pz);
        if (accept && !accept(q, px, pz, gap)) continue;
        return { node: q, gap, x: px, z: pz };
      }
      return null;
    },
    /** From node `k`, the node at (x, z) if it is k's own square or one joined to it, else -1. */
    step(k, x, z) {
      if (k < 0) return locate(x, Infinity, z);
      if (k < n) {
        const c = cellAt(x, z);
        if (c === k) return k;
        if (c >= 0 && !block[c]) {
          const di = Math.floor(c / nz) - Math.floor(k / nz), dj = (c % nz) - (k % nz);
          if (Math.abs(di) > 1 || Math.abs(dj) > 1) return -1;
          for (let s = 0; s < 8; s++) if (OFF[s] === c - k) return open(k, s) ? c : -1;
          return -1;
        }
        if (seamOf[k]) {
          const col = colAt(x, z);
          for (const q of seams.get(k)) if (enabled[q - n] && FCOL[q - n] === col) return q;
        }
        return -1;
      }
      const v = k - n;
      const col = colAt(x, z);
      if (col === FCOL[v]) return k;
      const out = col < 0 ? cellAt(x, z) : -2;
      for (let e = adjStart[v]; e < adjStart[v + 1]; e++) {
        const q = ADJ[e];
        if (q < n ? q === out : enabled[q - n] && FCOL[q - n] === col) return q;
      }
      return -1;
    },
    /** The height of node `k` (outdoors the ground's at (x, z)). */
    y: nodeY,
    /** The middle of node `k`'s square. */
    px: nodeX,
    pz: nodeZ,
    /** Whether node `k` is open (a pane's floor while the pane is whole is not). */
    open: (k) => k >= 0 && isOpen(k),
    /**
     * The distance field from `sources` (nodes: where the players can be got at), out to
     * ZOMBIE.fieldReach along the way: Dial's algorithm with buckets, as every step costs 2 to 6 (and
     * more next to a wall). With `until` (nodes: the zombies') it stops once each of them is settled:
     * a step downhill from a node only looks at nodes settled before it, so the rest isn't needed
     * (with the zombies near the players, a fraction of the area). The houses' grids only when a source
     * or one of `until` is in one (else round them, as walls: most of the time nobody is inside, and
     * their squares are four to a square outdoors).
     */
    field(sources, until = null) {
      if (++epoch > 0xfffe) {
        stamp.fill(0);
        epoch = 1;
      }
      const max = Math.round(ZOMBIE.fieldReach / UNIT);
      let pending = 0;
      let wanted = 0;
      let houses = false;
      for (const k of sources) if (k >= n) houses = true;
      for (const k of until ?? []) if (k >= n) houses = true;
      for (const k of until ?? []) {
        if (k >= 0 && isOpen(k) && !want[k]) {
          want[k] = 1;
          wanted++;
        }
      }
      for (const k of sources) {
        if (k < 0 || at(k) === 0) continue;
        dist[k] = 0;
        stamp[k] = epoch;
        buckets[0].push(k);
        pending++;
      }
      let d = 0;
      for (; pending > 0 && d <= max && (until === null || wanted > 0); d++) {
        const b = buckets[d & 15];
        while (b.length) {
          const k = b.pop();
          pending--;
          if (at(k) !== d) continue;
          if (want[k]) {
            want[k] = 0;
            wanted--;
          }
          if (k < n) {
            for (let s = 0; s < 8; s++) {
              const q = k + OFF[s];
              if (!open(k, s)) continue;
              const nd = d + COST[s] + near[q] * 4;
              if (nd < at(q)) {
                dist[q] = nd;
                stamp[q] = epoch;
                buckets[nd & 15].push(q);
                pending++;
              }
            }
            if (!houses || !seamOf[k]) continue;
            for (const q of seams.get(k)) {
              if (!enabled[q - n]) continue;
              const nd = d + 3 + fnear[q - n] * 2;
              if (nd < at(q)) {
                dist[q] = nd;
                stamp[q] = epoch;
                buckets[nd & 15].push(q);
                pending++;
              }
            }
            continue;
          }
          const v = k - n;
          for (let e = adjStart[v]; e < adjStart[v + 1]; e++) {
            const q = ADJ[e];
            let nd;
            if (q < n) {
              if (block[q]) continue;
              nd = d + ACOST[e] + near[q] * 4;
            } else {
              if (!enabled[q - n]) continue;
              nd = d + ACOST[e] + fnear[q - n] * 2;
            }
            if (nd < at(q)) {
              dist[q] = nd;
              stamp[q] = epoch;
              buckets[nd & 15].push(q);
              pending++;
            }
          }
        }
      }
      for (const b of buckets) b.length = 0;
      // Zombies out of reach (or the search ended first) leave their marks: cleared for the next field.
      if (wanted > 0) for (const k of until) if (k >= 0) want[k] = 0;
    },
    /** How far along the way (m) from node `k` to the nearest source of the last field; Infinity out of reach. */
    distance(k) {
      return k < 0 || at(k) === INF ? Infinity : at(k) * UNIT;
    },
    /** The open region node `k` is in (-1 for none): two nodes in one are joined by a way. */
    region(k) {
      regions();
      return k < 0 ? -1 : region[k];
    },
    /** Counts up whenever the regions were worked out again (a pane broke or was mended). */
    get version() {
      regions();
      return version;
    },
    joined(a, b) {
      regions();
      return a >= 0 && b >= 0 && region[a] >= 0 && region[a] === region[b];
    },
    /** The next node downhill from node `k` on the last field, or -1 (out of reach, or there). */
    next(k) {
      if (k < 0) return -1;
      let best = at(k);
      let to = -1;
      around(k, (q) => {
        const v = at(q);
        if (v < best) [best, to] = [v, q];
      });
      return to;
    },
    /** Walking straight from (ax, az) on node `k` to (bx, bz): the node it ends on, or -1 when a wall, a drop or a gap is in the way. */
    walk(k, ax, az, bx, bz) {
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.2));
      let cur = k;
      for (let s = 1; s <= steps && cur >= 0; s++) cur = this.step(cur, ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
      return cur;
    },
    /**
     * Whether a swipe from (ax, ay, az) reaches (bx, by, bz) with nothing in between: in the houses every
     * block (a whole pane too) between the two, checked every 10 cm; outdoors the tall things.
     */
    reach(ax, ay, az, bx, by, bz) {
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const steps = Math.max(1, Math.ceil(len / 0.1));
      const ka = cellAt(ax, az), kb = cellAt(bx, bz);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
        const c = colAt(x, z);
        if (c < 0) {
          const k = cellAt(x, z);
          if (k >= 0 && tall[k] && !boxed[k] && k !== ka && k !== kb) return false;
          continue;
        }
        for (let e = colPrStart[c]; e < colPrStart[c + 1]; e++) {
          const pi = COLPR[e];
          const p = prisms[pi];
          if (pi < panes && p.m === 'glass' && broken.has(pi)) continue;
          const lift = p.d ? height(x, z) : 0;
          if (y > p.y0 + lift && y < p.y1 + lift && insideRings(x, z, p.p)) return false;
        }
      }
      return true;
    },
    /** The panes broken now (their numbers, as the page's): the floors they closed are open while they are. */
    setPanes(list) {
      broken = new Set(list);
      for (const v of paned) {
        let on = 1;
        for (let e = blkStart[v]; e < blkStart[v + 1]; e++) if (!broken.has(blkPane[e])) on = 0;
        if (on !== enabled[v]) {
          enabled[v] = on;
          regionsDirty = true;
        }
      }
    },
    /**
     * Where zombies can come out: every 2 m over the open ground outdoors, with no wall, hedge, car or
     * fence within a square (not in the houses).
     */
    spawnSpots() {
      const out = [];
      for (let i = 2; i < nx - 2; i += 4) {
        for (let j = 2; j < nz - 2; j += 4) {
          const k = i * nz + j;
          if (block[k] || near[k]) continue;
          let clear = true;
          for (let s = 0; s < 8 && clear; s++) if (block[k + OFF[s]] || near[k + OFF[s]]) clear = false;
          if (clear) out.push({ x: Math.round(cx(k) * 100) / 100, z: Math.round(cz(k) * 100) / 100, node: k });
        }
      }
      return out;
    },
    /** For the checks: the houses' floors ({ x, z, y, open }) and how many join each. */
    floors() {
      const out = [];
      for (let v = 0; v < m; v++) out.push({ x: colX(FCOL[v]), z: colZ(FCOL[v]), y: FY[v], open: !!enabled[v], links: adjStart[v + 1] - adjStart[v], node: n + v });
      return out;
    },
  };
}

/**
 * A door from the house data as a zombie meets it: its moving leaves where they stand shut (segments
 * on the plan), its heights, and which way a double-action one swings away from (x, z).
 */
function doorOf(spec) {
  const leaves = [];
  for (const p of spec.panels ?? []) {
    const moves = (p.slide && (p.slide[0] || p.slide[1])) || p.swing;
    if (!moves) continue;
    const [ax, az] = p.a;
    const [bx, bz] = p.b;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    const o = p.offset ?? 0;
    leaves.push({ ax: ax + nx * o, az: az + nz * o, bx: bx + nx * o, bz: bz + nz * o, nx, nz, swing: p.swing ?? 0, hx: ax, hz: az });
  }
  return { id: spec.id, y0: spec.y0, y1: spec.y1, both: !!spec.both, leaves };
}

/**
 * The game's waves and zombies. `nav`: the grid (makeNav); `spots`: where they come out
 * (nav.spawnSpots); `home`: where they go when nobody fights. Together, `doors` (the house data's)
 * and `doorOpen(id)` (whether one stands open now): a zombie shoves a closed one open ('door' event).
 */
export class Horde {
  constructor(nav, spots, { home = { x: 4.5, z: 6 }, rand = Math.random, doors = [], doorOpen = () => true } = {}) {
    this.nav = nav;
    this.spots = spots;
    this.home = home;
    this.homeNode = nav.locate(home.x, nav.ground(home.x, home.z), home.z);
    this.rand = rand;
    this.doors = doors.map(doorOf).filter((d) => d.leaves.length);
    this.doorOpen = doorOpen;
    /** Door id -> when a zombie last shoved it (it counts as open for ZOMBIE.shoveMs) */
    this.shoved = new Map();
    /** 'break' (counting down to the next wave), 'wave', or 'over' */
    this.phase = 'break';
    this.wave = 0;
    this.until = 0;
    this.toSpawn = 0;
    this.runners = 0;
    this.bigs = 0;
    this.bigAt = 0;
    this.cap = ZOMBIE.maxAlive;
    this.nextSpawn = 0;
    this.fieldAt = -Infinity;
    /** id -> zombie: { id, kind, x, y, z, node, yaw, speed, top, hp, max, damage, act, actAt, until, struck, next, downAt, target } */
    this.zombies = new Map();
    this.nextId = 1;
    /** Player name -> zombies they beat in this game */
    this.beaten = Object.create(null);
    this.shielded = Object.create(null); // player name -> hit until (no second hit that soon)
    /** Player name -> where they can be got at ({ node, gap, ok }), worked out with each field */
    this.seeds = new Map();
    /** Player name -> out of every zombie's reach since (ms), and whether they were warned */
    this.perch = Object.create(null);
    this.warned = Object.create(null);
    /** Per spot: how far it is from the nearest player (with each field); the last spots used; this wave's spawns per side */
    this.spotD = new Float32Array(spots.length).fill(Infinity);
    this.recent = [];
    this.sides = new Array(8).fill(0);
    this.spotRegions = null;
    this.spotVersion = -1;
    this.starved = 0;
    /** Whether runners came yet in this game (the first ones get a heads-up) */
    this.ran = false;
  }

  /** The first break before wave 1. */
  start(now) {
    this.phase = 'break';
    this.until = now + ZOMBIE.firstBreak;
  }

  /** Zombies still to beat in this wave: those up and those still to come. */
  get left() {
    let n = this.toSpawn + this.bigs;
    for (const z of this.zombies.values()) if (z.act !== 'down') n++;
    return n;
  }

  /** Whether a big one is in this wave (still to come or up). */
  get bigWave() {
    return bigOf(this.wave) > 0;
  }

  /**
   * One step. `players`: { name, x, y, z, alive, fighter (fights: armed, on foot), safe (just back:
   * chased, not hit) }. Returns what happened: { type: 'wave', wave, count, big, bigs, runners },
   * { type: 'spawn', id }, { type: 'runners' } (the game's first runner is out), { type: 'swipe',
   * id, name, damage } (a player hit), { type: 'door', id, dir } (a zombie shoved door `id` open),
   * { type: 'perch', name, ms } (player `name` stands out of every zombie's reach: out of the wave in
   * `ms` unless they come down), { type: 'perchOut', name } (they stayed), { type: 'cleared', wave }
   * (everyone down comes back now), { type: 'gone', ids } (fallen zombies to take away) and
   * { type: 'over', wave }.
   */
  tick(now, dt, players) {
    const ev = [];
    if (this.phase === 'over') {
      for (const z of this.zombies.values()) z.speed = 0;
      return ev;
    }
    const fighters = players.filter((p) => p.fighter);
    const targets = fighters.filter((p) => p.alive);
    if (this.phase === 'break' && now >= this.until) this.begin(now, fighters.length, ev);
    if (this.wave > 0 && fighters.length && !targets.length) {
      this.phase = 'over';
      ev.push({ type: 'over', wave: this.wave });
      return ev;
    }
    if (now - this.fieldAt >= ZOMBIE.fieldEvery) {
      // From where the players can be got at (the house when nobody fights), as far as the zombies up need it.
      this.fieldAt = now;
      this.seedAll(targets);
      const from = [];
      for (const p of targets) {
        const s = this.seeds.get(p.name);
        if (s) from.push(s.node);
      }
      // The zombies' nodes it waits for: not those further than the field reaches as the crow flies
      // (they can't be settled: the search would go on to its end), who head for the players straight.
      const up = [];
      const srcs = targets.length ? targets : [this.home];
      for (const z of this.zombies.values()) {
        if (z.act === 'down') continue;
        let crow = Infinity;
        for (const p of srcs) crow = Math.min(crow, Math.hypot(p.x - z.x, p.z - z.z));
        if (crow < ZOMBIE.fieldReach - 5) up.push(z.node);
      }
      this.nav.field(from.length ? from : [this.homeNode], up);
      if (this.phase === 'wave' && (this.toSpawn || this.bigs)) this.measureSpots(targets);
      this.perched(now, targets, ev);
    }
    if (this.phase === 'wave') this.spawn(now, targets, ev);
    this.move(now, dt, targets, ev);
    const gone = [];
    for (const z of this.zombies.values()) if (z.act === 'down' && now - z.downAt > ZOMBIE.downMs) gone.push(z.id);
    for (const id of gone) this.zombies.delete(id);
    if (gone.length) ev.push({ type: 'gone', ids: gone });
    if (this.phase === 'wave' && this.left === 0) {
      this.phase = 'break';
      this.until = now + ZOMBIE.break;
      ev.push({ type: 'cleared', wave: this.wave });
    }
    return ev;
  }

  /** The next wave: its size for the players who fight, its runners and big ones, how fast they come. */
  begin(now, players, ev) {
    this.phase = 'wave';
    this.fieldAt = -Infinity; // a field (and the spots' distances) for the wave's first zombies
    this.wave++;
    this.players = Math.max(1, players);
    this.toSpawn = waveSize(this.wave, this.players);
    this.runners = runnersOf(this.wave, this.toSpawn);
    this.bigs = bigOf(this.wave);
    this.bigAt = Math.floor(this.toSpawn * 0.6); // the big ones come once a good part of the wave is out
    this.cap = aliveCap(this.players);
    this.nextSpawn = now + 400;
    this.sides.fill(0);
    ev.push({ type: 'wave', wave: this.wave, count: this.toSpawn + this.bigs, big: this.bigs > 0, bigs: this.bigs, runners: this.runners });
  }

  /**
   * Where each player can be got at, and whether a zombie can reach them there at all: a floor at their
   * level within a swipe (beside them, or under a counter or a car's roof they stand on), joined to
   * where zombies come out, with nothing between it and them.
   */
  seedAll(targets) {
    this.seeds.clear();
    for (const p of targets) {
      const s = this.reachOf(p);
      if (s) this.seeds.set(p.name, s);
    }
  }

  /**
   * Where a zombie can get at a player at (x, y, z): a floor joined to where zombies come out, theirs
   * or one within a swipe's start with nothing between (`ok`); else, out of reach for good (perched),
   * the nearest floor at their level all the same (the zombies gather there). Null with none at all.
   */
  reachOf(p) {
    const nav = this.nav;
    if (this.spotVersion !== nav.version) {
      // The regions where zombies come out (worked out again when a pane broke or was mended).
      this.spotVersion = nav.version;
      this.spotRegions = new Set(this.spots.map((s) => nav.region(s.node)));
    }
    const joined = (k) => this.spotRegions.has(nav.region(k));
    const fits = (k, x, z, gap) => joined(k) && (!gap || (gap <= ZOMBIE.attackFrom - 0.05 && nav.reach(x, nav.y(k, x, z) + 1.3, z, p.x, p.y + 1, p.z)));
    const s = nav.seed(p.x, p.y, p.z, fits);
    if (s) return { ...s, ok: true };
    const any = nav.seed(p.x, p.y, p.z, joined) ?? nav.seed(p.x, p.y, p.z);
    return any ? { ...any, ok: false } : null;
  }

  /** Who stands out of every zombie's reach during a wave: warned after a moment, out of the wave if they stay. */
  perched(now, targets, ev) {
    const names = new Set();
    for (const p of targets) {
      names.add(p.name);
      const s = this.seeds.get(p.name);
      if (this.phase !== 'wave' || s?.ok) {
        delete this.perch[p.name];
        delete this.warned[p.name];
        continue;
      }
      const since = (this.perch[p.name] ??= now);
      if (!this.warned[p.name] && now - since >= ZOMBIE.perchWarn) {
        this.warned[p.name] = true;
        ev.push({ type: 'perch', name: p.name, ms: ZOMBIE.perchMs });
      } else if (this.warned[p.name] && now - since >= ZOMBIE.perchWarn + ZOMBIE.perchMs) {
        delete this.perch[p.name];
        delete this.warned[p.name];
        ev.push({ type: 'perchOut', name: p.name });
      }
    }
    for (const name of Object.keys(this.perch)) if (!names.has(name)) {
      delete this.perch[name];
      delete this.warned[name];
    }
  }

  /** Each spot's distance to the nearest player who fights (the house when nobody does), for the spawns until the next field. */
  measureSpots(targets) {
    const from = targets.length ? targets : [this.home];
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      let d = Infinity;
      for (const p of from) {
        const dx = p.x - s.x, dz = p.z - s.z;
        const e = dx * dx + dz * dz;
        if (e < d) d = e;
      }
      this.spotD[i] = Math.sqrt(d);
    }
  }

  /** Zombies out of the ground, one at a time, while there is room under the cap. */
  spawn(now, targets, ev) {
    if (now < this.nextSpawn || (!this.toSpawn && !this.bigs)) return;
    let up = 0;
    for (const z of this.zombies.values()) if (z.act !== 'down') up++;
    if (up >= this.cap) return;
    const big = this.bigs > 0 && (this.toSpawn <= this.bigAt || this.toSpawn === 0);
    const at = this.pick(targets);
    if (!at) {
      this.nextSpawn = now + 500;
      return;
    }
    const run = !big && this.runners > 0 && this.rand() < this.runners / Math.max(1, this.toSpawn);
    if (big) this.bigs--;
    else {
      this.toSpawn--;
      if (run) this.runners--;
    }
    const s = zombieStats(this.wave, big, this.rand(), run);
    const id = this.nextId++;
    const kind = big ? BIG : run ? RUNNER : WALKERS[Math.floor(this.rand() * WALKERS.length)];
    const yaw = Math.atan2(this.home.x - at.x, this.home.z - at.z);
    this.zombies.set(id, {
      id, kind, x: at.x, y: this.nav.y(at.node, at.x, at.z), z: at.z, node: at.node, yaw, speed: 0, top: s.speed, hp: s.hp, max: s.hp, damage: s.damage,
      act: 'walk', actAt: now, until: 0, struck: false, next: now + 800, downAt: 0, target: null,
    });
    this.nextSpawn = now + spawnEvery(this.wave) * (0.6 + 0.8 * this.rand());
    ev.push({ type: 'spawn', id });
    if (run && !this.ran) {
      this.ran = true;
      ev.push({ type: 'runners' });
    }
  }

  /**
   * Where the next zombie comes out: a spot anywhere over the open ground that is joined to a player,
   * never closer than ZOMBIE.spawnMin to any of them, out of everyone's sight. Chosen at random,
   * weighted: most from spawnBest to spawnFar m away, fewer further; a side round the players that
   * had fewer of this wave's zombies weighs more (they come from all round at once), and the last
   * few spots hardly at all (never the same one twice in a row). With nobody fighting, round the house.
   */
  pick(targets) {
    const nav = this.nav;
    const from = targets.length ? targets : [this.home];
    let mx = 0, mz = 0;
    for (const p of from) {
      mx += p.x;
      mz += p.z;
    }
    mx /= from.length;
    mz /= from.length;
    const joined = new Set();
    for (const p of targets) {
      const s = this.seeds.get(p.name);
      if (s) joined.add(nav.region(s.node));
    }
    if (!joined.size) joined.add(nav.region(this.homeNode));
    const { spawnMin: lo, spawnBest: best, spawnFar: far, spawnMax: max } = ZOMBIE;
    const weight = new Float64Array(this.spots.length);
    let total = 0;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      const d = this.spotD[i];
      if (d < lo + 1 || d >= ZOMBIE.fieldReach - 15 || !joined.has(nav.region(s.node))) continue;
      // Past spawnMax only as a last resort (far ones take long to come, and the field must reach them):
      // more so after a few looks found nothing nearer out of everyone's sight.
      if (d > max) {
        const w = this.starved >= 3 ? 0.15 : 1e-6;
        weight[i] = w;
        total += w;
        continue;
      }
      let w = d < best ? (d - lo) / (best - lo) : d <= far ? 1 : 1 - (0.9 * (d - far)) / (max - far);
      w /= (1 + this.sides[side(s.x, s.z, mx, mz)]) ** 2;
      for (const r of this.recent) if (Math.abs(r.x - s.x) < 6 && Math.abs(r.z - s.z) < 6 && Math.hypot(r.x - s.x, r.z - s.z) < 6) w *= 0.03;
      weight[i] = w;
      total += w;
    }
    const tries0 = this.starved >= 1 ? 48 : 14;
    for (let tries = 0; tries < tries0 && total > 1e-9; tries++) {
      let r = this.rand() * total;
      let i = 0;
      for (; i < weight.length - 1; i++) {
        r -= weight[i];
        if (r <= 0 && weight[i] > 0) break;
      }
      if (!(weight[i] > 0)) continue; // rounding ran past the last spot with a weight
      const s = this.spots[i];
      total -= weight[i];
      weight[i] = 0;
      // As things are now (the players moved since the last field): far enough from all, seen by none
      // (only after 10 s with nowhere else, past spawnMax: a wave never stalls for good).
      const fair = (x, z) => {
        for (const p of targets) {
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < lo || (d < max + 10 && nav.clear(x, z, p.x, p.z, true) && !(this.starved >= 20 && d > max))) return false;
        }
        return true;
      };
      if (!fair(s.x, s.z)) continue;
      this.starved = 0;
      this.sides[side(s.x, s.z, mx, mz)]++;
      this.recent.push(s);
      if (this.recent.length > 4) this.recent.shift();
      for (let k = 0; k < 6; k++) {
        const x = s.x + (this.rand() - 0.5), z = s.z + (this.rand() - 0.5);
        if (nav.locate(x, nav.ground(x, z), z) === s.node && fair(x, z)) return { x, z, node: s.node };
      }
      return { x: s.x, z: s.z, node: s.node };
    }
    this.starved++;
    return null;
  }

  /** Every zombie that is up: a step towards the nearest player, or a swipe at them. */
  move(now, dt, targets, ev) {
    const list = [...this.zombies.values()].filter((z) => z.act !== 'down');
    // Apart: two zombies in one another (on one floor) are pushed out (m/s), so a crowd spreads round its player.
    const push = new Map(list.map((z) => [z, { x: 0, z: 0 }]));
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const p = list[a];
        const q = list[b];
        const r = (p.kind === BIG ? ZOMBIE.bigRadius : ZOMBIE.radius) + (q.kind === BIG ? ZOMBIE.bigRadius : ZOMBIE.radius);
        let dx = p.x - q.x;
        let dz = p.z - q.z;
        const d = Math.hypot(dx, dz);
        if (d >= r || Math.abs(p.y - q.y) > 1.2) continue;
        if (d < 1e-3) [dx, dz] = [Math.sin(p.id), Math.cos(p.id)];
        const f = ((r - d) / r) * 2.5 / Math.max(d, 1e-3);
        push.get(p).x += dx * f;
        push.get(p).z += dz * f;
        push.get(q).x -= dx * f;
        push.get(q).z -= dz * f;
      }
    }
    for (const z of list) this.step(z, now, dt, targets, push.get(z), ev);
  }

  /** Whether zombie `z`'s swipe reaches player `p`: nothing between them (a wall, a floor, a whole pane, a shut door). */
  canHit(z, p) {
    const arm = z.kind === BIG ? 1.8 : 1.3;
    return this.nav.reach(z.x, z.y + arm, z.z, p.x, p.y + 1, p.z) && !this.doorBetween(z.x, z.z, p.x, p.z, z.y, true);
  }

  /** A shut door whose leaf crosses the way from (ax, az) to (bx, bz) at height y, or null. `now`: as the server has it (else a shoved one is open too). */
  doorBetween(ax, az, bx, bz, y, strict = false, now = 0) {
    for (const d of this.doors) {
      if (y < d.y0 - 0.6 || y > d.y1 - 1) continue;
      if (this.doorOpen(d.id) || (!strict && now - (this.shoved.get(d.id) ?? -Infinity) < ZOMBIE.shoveMs)) continue;
      for (const l of d.leaves) if (crosses(ax, az, bx, bz, l.ax, l.az, l.bx, l.bz)) return { d, l };
    }
    return null;
  }

  step(z, now, dt, targets, push, ev) {
    const big = z.kind === BIG;
    const nav = this.nav;
    if (z.node < 0 || !nav.open(z.node)) {
      // A pane mended under it (or a node it never had): the floor where it stands.
      const k = nav.locate(z.x, z.y, z.z, 0.6);
      if (k >= 0) z.node = k;
    }
    // Its target: the nearest player at its level (a floor up or down is out of reach), else the nearest at all.
    let tgt = null;
    let td = Infinity;
    let any = null;
    let ad = Infinity;
    for (const p of targets) {
      const d = Math.hypot(p.x - z.x, p.z - z.z);
      if (d < ad) [any, ad] = [p, d];
      const dy = p.y - z.y;
      if (dy > LEVEL_LO && dy < LEVEL_HI && d < td) [tgt, td] = [p, d];
    }
    z.target = (tgt ?? any)?.name ?? null;
    // Whether its swipe would reach them from here (looked at only when they are close).
    const can = !!tgt && td <= (big ? ZOMBIE.bigReach : ZOMBIE.reach) && this.canHit(z, tgt);
    if (z.act === 'hurt') {
      if (now < z.until) {
        z.speed = 0;
        return;
      }
      z.act = 'walk';
    }
    if (z.act === 'attack') {
      z.speed = 0;
      if (tgt) z.yaw = turn(z.yaw, Math.atan2(tgt.x - z.x, tgt.z - z.z), (big ? 1.5 : 4) * dt);
      if (!z.struck && now >= z.actAt + (big ? ZOMBIE.bigImpact : ZOMBIE.impact)) {
        z.struck = true;
        if (big) {
          // The pound: everyone close round it on its floor with nothing in between, less at the edge.
          for (const p of targets) {
            const d = Math.hypot(p.x - z.x, p.z - z.z);
            const dy = p.y - z.y;
            if (d <= ZOMBIE.bigReach && dy > LEVEL_LO && dy < LEVEL_HI && this.canHit(z, p)) this.hurt(p, z, Math.round(z.damage * (1 - (0.5 * d) / ZOMBIE.bigReach)), now, ev);
          }
        } else if (can && td <= ZOMBIE.reach) this.hurt(tgt, z, z.damage, now, ev);
      }
      if (now >= z.until) z.act = 'walk';
      return;
    }
    if (can && td <= (big ? ZOMBIE.bigFrom : ZOMBIE.attackFrom) && now >= z.next) {
      Object.assign(z, { act: 'attack', actAt: now, until: now + (big ? ZOMBIE.bigAttackMs : ZOMBIE.attackMs), struck: false, next: now + (big ? ZOMBIE.bigEvery : ZOMBIE.swipeEvery), speed: 0 });
      return;
    }
    // Where to: straight at the player close by when the way is clear (on its floor), else downhill
    // on the field, else towards them (or the house) as the crow flies.
    let gx = this.home.x;
    let gz = this.home.z;
    const next = nav.next(z.node);
    // The way straight at them: outdoors at both ends the squares on the line (as ever, cheap), else
    // walked step by step from floor to floor (a stair, a doorway, no drop).
    let straight = false;
    if (tgt && td < ZOMBIE.straight) {
      if (z.node < nav.outdoor && !nav.inHouse(tgt.x, tgt.z)) straight = nav.clear(z.x, z.z, tgt.x, tgt.z);
      else {
        const end = nav.walk(z.node, z.x, z.z, tgt.x, tgt.z);
        const dy = end >= 0 ? tgt.y - nav.y(end, tgt.x, tgt.z) : 0;
        straight = end >= 0 && dy > LEVEL_LO && dy < LEVEL_HI;
      }
    }
    if (straight) [gx, gz] = [tgt.x, tgt.z];
    else if (next >= 0) [gx, gz] = [nav.px(next), nav.pz(next)];
    else if (tgt ?? any) [gx, gz] = [(tgt ?? any).x, (tgt ?? any).z];
    // A shut door in the way: it shoves it open (everyone sees it swing) and stands a moment.
    const dist = Math.hypot(gx - z.x, gz - z.z);
    if (this.doors.length && dist > 0.05) {
      const ux = (gx - z.x) / dist, uz = (gz - z.z) / dist;
      const hit = this.doorBetween(z.x, z.z, z.x + ux * 0.6, z.z + uz * 0.6, z.y, false, now);
      if (hit) {
        const { d, l } = hit;
        const side = l.nx * (z.x - l.hx) + l.nz * (z.z - l.hz);
        this.shoved.set(d.id, now);
        ev.push({ type: 'door', id: d.id, dir: d.both ? (side > 0 === l.swing > 0 ? -1 : 1) : 1 });
        Object.assign(z, { act: 'attack', actAt: now, until: now + ZOMBIE.shoveFor, struck: true, speed: 0 });
        z.yaw = Math.atan2(ux, uz);
        return;
      }
    }
    const stop = can && td < (big ? ZOMBIE.bigFrom * 0.85 : ZOMBIE.attackFrom * 0.8);
    const want = dist > 0.05 ? Math.atan2(gx - z.x, gz - z.z) : z.yaw;
    z.yaw = turn(z.yaw, want, (big ? 1.6 : z.kind === RUNNER ? 5.5 : 3.2) * dt);
    // Slower while still turning round: it shuffles round, rather than sliding sideways.
    const facing = Math.max(0, Math.cos(wrap(want - z.yaw)));
    const speed = stop ? 0 : z.top * (0.3 + 0.7 * facing);
    const vx = Math.sin(z.yaw) * speed + push.x;
    const vz = Math.cos(z.yaw) * speed + push.z;
    const bx = z.x;
    const bz = z.z;
    // In steps of at most 20 cm, so a fast one (or a long frame alone) never skips a square.
    const parts = Math.max(1, Math.ceil((Math.hypot(vx, vz) * dt) / 0.2));
    for (let s = 0; s < parts; s++) {
      const nx = z.x + (vx * dt) / parts;
      const nz = z.z + (vz * dt) / parts;
      let k = nav.step(z.node, nx, nz);
      if (k >= 0) [z.x, z.z, z.node] = [nx, nz, k];
      else if ((k = nav.step(z.node, nx, z.z)) >= 0) [z.x, z.node] = [nx, k];
      else if ((k = nav.step(z.node, z.x, nz)) >= 0) [z.z, z.node] = [nz, k];
      else break;
    }
    if (z.node >= 0) z.y = nav.y(z.node, z.x, z.z);
    z.speed = Math.hypot(z.x - bx, z.z - bz) / Math.max(dt, 1e-3);
  }

  /** A swipe or a pound lands on player `p` (unless they were hit a moment ago, or are just back). */
  hurt(p, z, damage, now, ev) {
    if (p.safe || damage <= 0 || now < (this.shielded[p.name] ?? 0)) return;
    this.shielded[p.name] = now + ZOMBIE.shield;
    ev.push({ type: 'swipe', id: z.id, name: p.name, damage });
  }

  /**
   * Zombie `id` takes `amount` of health from `by`: 'down' when that beat it (it counts for them),
   * 'hurt' when it took it (it staggers; the big one only from a heavy hit), null when it was down
   * already or there is no such zombie.
   */
  hit(id, amount, by, now) {
    const z = this.zombies.get(id);
    if (!z || z.act === 'down' || !(amount > 0)) return null;
    z.hp = Math.max(0, z.hp - amount);
    if (z.hp <= 0) {
      Object.assign(z, { act: 'down', downAt: now, speed: 0 });
      this.beaten[by] = (this.beaten[by] ?? 0) + 1;
      return 'down';
    }
    if (z.kind !== BIG || amount >= 60) Object.assign(z, { act: 'hurt', actAt: now, until: now + ZOMBIE.hurtMs, struck: true });
    return 'hurt';
  }

  /**
   * A blast at (x, z): every zombie up within `radius` (plus its size) takes `amount`, less at the edge;
   * with `y`, only those on its floor (not 2.5 m above or below). Returns [id, result] for each one hit.
   */
  blast(x, z, radius, amount, by, now, y = null) {
    const out = [];
    for (const q of [...this.zombies.values()]) {
      if (q.act === 'down') continue;
      if (y !== null && Math.abs(q.y - y) > 2.5) continue;
      const r = radius + (q.kind === BIG ? ZOMBIE.bigRadius : ZOMBIE.radius);
      const d = Math.hypot(q.x - x, q.z - z);
      if (d >= r) continue;
      const res = this.hit(q.id, Math.round(amount * (1 - (0.5 * d) / r)), by, now);
      if (res) out.push([q.id, res]);
    }
    return out;
  }
}

/** Which of eight sides round (mx, mz) the point (x, z) is on (0 to 7; no trigonometry). */
function side(x, z, mx, mz) {
  const dx = x - mx, dz = z - mz;
  const o = (dx < 0 ? 4 : 0) + (dz < 0 ? 2 : 0);
  return o + ((Math.abs(dx) > Math.abs(dz)) !== (dx < 0) !== (dz < 0) ? 1 : 0);
}

/** An angle between -pi and pi. */
function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** From `a` towards `b` by at most `max` radians, the short way round. */
function turn(a, b, max) {
  const d = wrap(b - a);
  return wrap(a + Math.max(-max, Math.min(max, d)));
}
