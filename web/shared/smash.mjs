// What a car breaks going through it at speed (Yoshi left it to the merger, 21 Nov 2026): a garden hedge it ploughs
// through, a light garden fence it flattens, a young tree it snaps. One list of the pieces, the same on the page
// (src/world/breakage.ts) and on the server (server/carSmash.mjs), made here from the game's own generated data in a
// fixed order, so a piece is its number in that list: the ring's blocks (src/data/house_shell.json surroundings),
// the ring's young trees, then the village's blocks and young trees (src/data/village.json). A block is found again by
// its outline (pieceKey: its material, the middle of its box and its number of points, in model coordinates), never by
// an address.
//
// - Hedges (hedge, nb_hedge): every garden hedge alike. The data says nothing of a fence or a wall inside one, and
//   none is thicker than 1.1 m (the thick ones world/carDamage.ts would hold), so all break the same way.
// - Fences (fence) up to FENCE_HIGH: the wire mesh on concrete posts of the gardens. The taller ones (1.85 m, round
//   the sports grounds and the school) stay standing, as do walls, gates in masonry, posts and poles.
// - Young trees: those under 6 m (as world/car.ts `young`), a thin trunk. Grown trees stay.
// Nothing within HOME_MARGIN of a code-locked home or the end house's garden (as world/carDamage.ts nearHome): no way
// into a home's garden.
import { END_GARDEN, HOMES } from './homes.mjs';

/**
 * Per kind: the speed (m/s) a car breaks it from (slower, it is a soft wall); the gap's width the car leaves (m: its
 * own width and a little, wider at an angle, at most `most`); the share of its speed a car keeps going through and the
 * m/s it loses besides. A hedge (beech or privet a metre thick) takes most of your speed (a real one does); a wire fence
 * on its posts less; a sapling least. Speeds from what the breakable worlds of the big driving games use for a
 * mid-size car (a fence about 25 km/h, a birch about 30), a hedge a little under: it gives.
 */
export const SMASH = {
  hedge: { min: 5, width: 2.3, most: 5, keep: 0.55, lose: 1.2 },
  fence: { min: 4.5, width: 2.6, most: 5.5, keep: 0.75, lose: 0.6 },
  sapling: { min: 4, width: 0, most: 0, keep: 0.85, lose: 0.4 },
  /** The most the car's way may turn from straight across a hedge or fence (rad): past it, it glances off */
  angle: 1,
  /** m: the server's car (its middle) within this of the piece's broken spot, some time in the last second */
  reach: 8,
  /** ms between two reports from a page, and the most in BURST_MS */
  rate: 200,
  burst: 12,
  burstMs: 10_000,
  /** Gaps in one game at most, and per piece */
  cap: 80,
  perPiece: 4,
  /** ms after which a broken piece mends when nobody is within `clear` m of it; after `late` it mends anyway */
  mend: 5 * 60_000,
  clear: 60,
  late: 15 * 60_000,
};

/** m round a code-locked home and the end house's garden where nothing breaks (world/carDamage.ts HOME_MARGIN). */
export const HOME_MARGIN = 25;
/** m: a fence up to this tall is a light garden fence. */
export const FENCE_HIGH = 1.4;
/** m: a tree under this tall is a young tree. */
export const YOUNG = 6;

const ringBox = (ring) => [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))];
const homeBoxes = [...HOMES.map((h) => h.box), ringBox(END_GARDEN.ring)].map((b) => [b[0] - HOME_MARGIN, b[1] - HOME_MARGIN, b[2] + HOME_MARGIN, b[3] + HOME_MARGIN]);
/** Within HOME_MARGIN of a code-locked home or the end house's garden. */
export function nearHome(x, z) {
  return homeBoxes.some((b) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
}

/** The kind of piece a block is, or null for one that stays standing. */
export function blockKind(p) {
  if (!p || !Array.isArray(p.p?.[0]) || p.p[0].length < 3) return null;
  if (p.m === 'hedge' || p.m === 'nb_hedge') return 'hedge';
  if (p.m === 'fence' && p.y1 - p.y0 <= FENCE_HIGH + 1e-6) return 'fence';
  return null;
}

/** A block's key: its material, the middle of its box and its number of points (model coordinates, cm). */
export function pieceKey(p) {
  const [x0, z0, x1, z1] = ringBox(p.p[0]);
  return `${p.m}:${Math.round((x0 + x1) * 50)},${Math.round((z0 + z1) * 50)}:${p.p[0].length}`;
}

/** A tree's key (model coordinates, cm). */
export const treeKey = (t) => `tree:${Math.round(t.x * 100)},${Math.round(t.z * 100)}`;

/**
 * A long block's line: the way of its longest side (ux, uz), the middle of its extent along it and across (cx, cz),
 * its half length along it, and how thick it is.
 */
function lineOf(ring) {
  let best = -1, ux = 1, uz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const dx = ring[i][0] - ring[j][0], dz = ring[i][1] - ring[j][1];
    const l = Math.hypot(dx, dz);
    if (l > best) [best, ux, uz] = [l, dx / (l || 1), dz / (l || 1)];
  }
  if (ux < 0 || (ux === 0 && uz < 0)) [ux, uz] = [-ux, -uz]; // one way for every page
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, z] of ring) {
    const a = x * ux + z * uz, b = -x * uz + z * ux;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a);
    b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
  return { cx: am * ux - bm * uz, cz: am * uz + bm * ux, ux, uz, half: (a1 - a0) / 2, thick: b1 - b0 };
}

/**
 * The pieces, in their fixed order, from the ring's and the village's data: { kind, key, cx, cz, ux, uz, half, thick,
 * y0, y1 } for a hedge or a fence (a block), { kind: 'sapling', key, cx, cz, h } for a young tree. A key that two blocks
 * share (11 of about 3000 hedges and fences) is left out: no page could tell which was meant.
 * `sets`: [{ prisms, trees }] in order (the ring's, then the village's).
 */
export function smashPieces(sets) {
  const out = [];
  const count = new Map();
  const add = (piece) => {
    count.set(piece.key, (count.get(piece.key) ?? 0) + 1);
    out.push(piece);
  };
  for (const { prisms = [], trees = [] } of sets) {
    for (const p of prisms) {
      const kind = blockKind(p);
      if (!kind) continue;
      const line = lineOf(p.p[0]);
      if (nearHome(line.cx, line.cz) || !(line.half > 0.3)) continue;
      add({ kind, key: pieceKey(p), ...line, y0: p.y0, y1: p.y1 });
    }
    for (const t of trees) {
      if (!(t.h < YOUNG) || !Number.isFinite(t.x) || !Number.isFinite(t.z) || nearHome(t.x, t.z)) continue;
      add({ kind: 'sapling', key: treeKey(t), cx: t.x, cz: t.z, ux: 1, uz: 0, half: 0, thick: 0, h: t.h });
    }
  }
  return out.map((p) => (count.get(p.key) > 1 ? { ...p, kind: null } : p)); // its number kept, never broken
}

/** Where a gap at `s` (m along a piece from its middle) lies on the plan. */
export function gapPoint(piece, s) {
  return [piece.cx + piece.ux * s, piece.cz + piece.uz * s];
}

/** A ring cut to the half-plane (x, z) . n <= c (Sutherland-Hodgman: a concave ring may keep a bridge of no width). */
function clip(ring, nx, nz, c) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const da = a[0] * nx + a[1] * nz - c, db = b[0] * nx + b[1] * nz - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

const area = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(s) / 2;
};

/**
 * What stands of a block (its outline `ring`, the piece's line) with these gaps ([{ s, w }]: each `w` m wide round `s`
 * m along it): the rings of its parts, cut straight across its line. None left (a short piece all gone): [].
 */
export function partRings(ring, piece, gaps) {
  const cuts = gaps.map((g) => [g.s - g.w / 2, g.s + g.w / 2]).sort((a, b) => a[0] - b[0]);
  const keep = [];
  let from = -Infinity;
  for (const [a, b] of cuts) {
    if (a > from) keep.push([from, a]);
    from = Math.max(from, b);
  }
  keep.push([from, Infinity]);
  const c0 = piece.cx * piece.ux + piece.cz * piece.uz; // the middle's place along the line
  const out = [];
  for (const [a, b] of keep) {
    let r = ring;
    if (Number.isFinite(a)) r = clip(r, -piece.ux, -piece.uz, -(c0 + a));
    if (Number.isFinite(b) && r.length >= 3) r = clip(r, piece.ux, piece.uz, c0 + b);
    if (r.length >= 3 && area(r) > 0.005) out.push(r);
  }
  return out;
}

/**
 * The gap a car of half width `halfW` and half length `halfL` heading `yaw` leaves crossing a piece: how wide along
 * the piece (its width across the line it crosses, wider at an angle, the kind's at least and its `most` at most), or
 * 0 when it glances off (its way more than SMASH.angle from straight across).
 */
export function gapWidth(piece, yaw, halfL, halfW) {
  const k = SMASH[piece.kind];
  if (!k || piece.kind === 'sapling') return 0;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const along = Math.abs(fx * piece.ux + fz * piece.uz); // sin of the angle from straight across
  const across = Math.sqrt(Math.max(0, 1 - along * along));
  if (Math.asin(Math.min(1, along)) > SMASH.angle) return 0;
  return Math.min(k.most, Math.max(k.width, 2 * (halfW * across + halfL * along) + 0.3));
}
