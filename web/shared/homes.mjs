// The homes that open only with an access code (Yoshi, 6 Nov 2026): the main house, the bungalow, the end house at
// Molenhoek and the brick house on Kapellenhoek (15 Nov 2026). They are fixed here, in code. The admin only makes and
// revokes their codes (server/homes.mjs); nothing about where they are comes from the admin page.
//
// What belongs to a home is worked out from the game's own data, never listed by hand:
// - its DOORS by id: `house-out-`, `bungalow-out-`, `mh-end-` and `kh-home-` in the shell; the doors of an inside are named by
//   its pack, which the server and the page register once they hold it (registerDoors; shared/homes.test.mjs checks every id);
// - its PANES (the breakable glass) by their number: the house's own blocks by where the window stands, the walked-into
//   houses' windows and door glass by their ranges (WALK_INS), the glass in door leaves by the door they are in (makePaneHomes);
// - its INSIDE by BANDS: a ring in model coordinates (metres, x and z) for a range of heights (y0 up to y1, the game's
//   own heights, as the house data and the players' positions use them), one band for each floor. Whoever has no right
//   to a home stays out of its bands (the server holds them back, the page does not let them walk in).
//
// The rings (one for each floor) were drawn from the footprint of each floor, closed at the walls between rooms and shrunk
// by 20 cm so that somebody in a doorway, on a terrace or in the garden stays outside, then followed and simplified to 9 cm
// and rounded to the centimetre. The first floor's ring leaves out the roof terrace and the top of the outside stair, which
// are outside and free (the top steps of the stair are above the ground floor's band, so a step next to the wall is free
// too). A band ends below its roof: a person on a roof, or coming down by parachute, is outside.
/** @typedef {[number, number]} Pt */

const END_FLOOR = 9.468; // the end house's ground floor, in the game's heights (frame.floor in molenhoek_end_shell.json)
const KH_FLOOR = 3.45; // the brick house's ground floor, in the game's heights (frame.floor in kapellenhoek_home_shell.json)
const BANDS = {
  house: [
    { y0: -5, y1: 2.6, ring: [[0.2, 0.2], [1.99, 0.2], [1.99, -2.52], [3.12, -2.52], [3.12, 0.2], [8.82, 0.2], [8.82, 11.82], [4.54, 11.82], [4.54, 10.64], [0.2, 10.64]] }, // ground floor (floor 0, ceiling 2.7)
    { y0: 2.6, y1: 5.7, ring: [[3.52, 0.47], [8.42, 0.47], [8.42, 11.42], [0.62, 11.42], [0.52, 3.57], [3.52, 3.57]] }, // 1st floor (3.05, 5.53), not the roof terrace
    { y0: 5.7, y1: 8.4, ring: [[0.52, 3.52], [8.42, 3.52], [8.42, 7.57], [0.52, 7.57]] }, // 2nd floor (5.88, 8.41)
  ],
  bungalow: [
    { y0: -5, y1: 2.6, ring: [[85.22, 181.2], [91.57, 186.45], [89.02, 189.65], [89.22, 190.05], [91.42, 191.9], [85.67, 198.8], [83.62, 197.15], [83.67, 196.9], [83.52, 196.6], [76.92, 191.2]] }, // ground floor (0.35)
    { y0: 2.6, y1: 6, ring: [[85.22, 181.2], [91.57, 186.55], [83.22, 196.45], [76.92, 191.15]] }, // upper floor (2.97), under the ridge (6.9)
  ],
  molenhoek_end: [
    { y0: END_FLOOR - 3, y1: END_FLOOR + 5.8, ring: [[1503.07, -360.74], [1510.47, -358.94], [1508.52, -351.24], [1503.87, -348.64], [1500.32, -349.49]] }, // both floors (0 and 2.9), under the roof (5.88)
  ],
  // The ground floor's footprint (the garage wing and the flat-roofed back part in it, the covered terrace in the back left
  // corner left out), and the two-storey block over it. Its own frame: the front's left end [613.14, -361.86], along the
  // front [-0.26634, 0.96384], into the house [0.96384, 0.26634]; both rings 20 cm in from the outer faces.
  kapellenhoek_home: [
    { y0: KH_FLOOR - 3, y1: KH_FLOOR + 2.6, ring: [[613.28, -361.61], [609.14, -346.62], [619.8, -343.67], [622.62, -353.87], [620.24, -354.52], [621.57, -359.32]] }, // ground floor (0), under the flat roofs (3.1) and the wing's eaves (3.5)
    { y0: KH_FLOOR + 2.6, y1: KH_FLOOR + 5.45, ring: [[613.28, -361.61], [610.21, -350.52], [618.5, -348.23], [621.57, -359.32]] }, // 1st floor (2.9), under its ceiling slab (5.4 to 5.65) and the roof
  ],
};

/**
 * Where a home without a portal puts out whoever stands in it without the right (a revoked code): [x, z, yaw], on open
 * ground in front of it, outside every band (shared/homes.test.mjs). The other homes use their portal's `out`.
 */
const OUT = {
  kapellenhoek_home: [607.15, -355.21, -1.84], // on the drive, facing the house
};

// The end house's garden: fenced all round, so that the only way in is through the house (src/world/walkIn.ts: the lawn,
// at its own height). Its ring is the lawn polygon of molenhoek_end_shell.json. Somebody in it without the home's code
// (they dropped in) has no way out and is put out by the server (Game.unstuck) or, playing alone, by the page.
export const END_GARDEN = { y: 9.428, ring: [[1510.675, -359], [1508.66, -351.09], [1503.89, -348.43], [1500.129, -349.356], [1498.227, -341.599], [1505.476, -345.731], [1519.4, -353.666], [1519.361, -353.7], [1516.001, -356.615], [1516.254, -357.64], [1510.679, -358.999]] };

/** Ids a page or the server may name (the admin page's URLs, the unlock call's `id`). */
export const HOME_ID = /^[a-z][a-z0-9_]{1,20}$/;

function boxOf(ring) {
  const xs = ring.map((p) => p[0]);
  const zs = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

/** The homes: `{ id, bands: [{ ring, y0, y1, box }], box: [minX, minZ, maxX, maxZ], out? }` (`out`: see OUT). */
export const HOMES = Object.entries(BANDS).map(([id, bands]) => {
  const full = bands.map((b) => ({ ...b, box: boxOf(b.ring) }));
  const boxes = full.map((b) => b.box);
  const box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  return { id, bands: full, box, ...(OUT[id] ? { out: OUT[id] } : {}) };
});

export const findHome = (id, list = HOMES) => (typeof id === 'string' && HOME_ID.test(id) ? list.find((h) => h.id === id) ?? null : null);

function inRing(x, z, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * The home whose inside holds the point at height `y`, or null. A box test first: almost every point is far from all
 * three. `y`: the feet's height in the game's heights (a position's y).
 */
export function homeAt(x, z, y) {
  for (const h of HOMES) {
    const b = h.box;
    if (!(x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3])) continue;
    for (const band of h.bands) {
      const q = band.box;
      if (y >= band.y0 && y < band.y1 && x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3] && inRing(x, z, band.ring)) return h.id;
    }
  }
  return null;
}

/** The bands of home `id`, or an empty list. */
export const bandsOf = (id) => HOMES.find((h) => h.id === id)?.bands ?? [];

/** Distance from a point to a ring's edge. */
function edgeDistance(x, z, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j];
    const [bx, bz] = ring[i];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

/**
 * How far a point is from a home's inside: 0 inside a band, else the distance to the nearest ring edge. Only the bands
 * that reach into the heights `y0` to `y1` count (all of them when no heights are given).
 */
export function distanceToHome(id, x, z, y0 = -Infinity, y1 = Infinity) {
  let best = Infinity;
  for (const band of bandsOf(id)) {
    if (band.y1 <= y0 || band.y0 >= y1) continue;
    best = Math.min(best, inRing(x, z, band.ring) ? 0 : edgeDistance(x, z, band.ring));
  }
  return best;
}

/**
 * The doors of the inside of a home are named by the private data only (the page and the server register them once they
 * hold it, registerDoors). The shell's own are `house-out-N` and `bungalow-out-N`, the end house's all `mh-end-...`, the
 * brick house's all `kh-home-...`.
 */
const DOOR_HOMES = new Map();
/** Name the doors of home `home`'s inside (the ids in its pack). */
export function registerDoors(home, ids) {
  for (const id of ids) if (typeof id === 'string') DOOR_HOMES.set(id, home);
}

/** The home a door belongs to, or null. */
export function homeOfDoor(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('house-out-')) return 'house';
  if (id.startsWith('bungalow-out-')) return 'bungalow';
  if (id.startsWith('mh-end-')) return 'molenhoek_end';
  if (id.startsWith('kh-home-')) return 'kapellenhoek_home';
  return DOOR_HOMES.get(id) ?? null;
}

/**
 * The numbers of breakable panes (the `glass` message): the shell's blocks from 0, the end house's windows from
 * WALK_IN_GLASS, the door glass from DOOR_GLASS, the end house's door glass from END_DOOR_GLASS, the insides' panes and
 * door glass from 5000 (their packs' numbers), the brick house's windows from 6000 and its door glass from 7000. Every
 * pane block carries its number in `glass`, every glass leaf of a door its number in `glassNo`.
 */
export const WALK_IN_GLASS = 2000;
export const DOOR_GLASS = 3000;
export const END_DOOR_GLASS = 4000;
/** One past the highest pane number (the server's limit) */
export const PANE_LIMIT = 8000;
/**
 * The houses walked into (src/world/walkIn.ts): their windows' numbers from `glass` (the shell's panes in order), their door
 * glass from `doorGlass` (the shell's doors first, then the pack's, in order), each range `size` long. The same on the page
 * and the server.
 */
export const WALK_INS = {
  molenhoek_end: { glass: WALK_IN_GLASS, doorGlass: END_DOOR_GLASS, size: 1000 },
  kapellenhoek_home: { glass: 6000, doorGlass: 7000, size: 1000 },
};
/** m outside a home's ring where a window of the house data still counts as the home's (the wall's thickness) */
const WINDOW_REACH = 0.7;

/**
 * Which home a pane belongs to, for every pane number: (i) => home id or null; `.has(i)` says whether the number is a pane
 * at all. `prisms` and `doors`: the house data (the shell, and the insides once they are there). A window is the home's
 * whose bands, at the window's heights, it stands in or within WINDOW_REACH of; door glass is its door's home. The ranges
 * of a walked-into house (WALK_INS: its windows and its door glass) are all that house's: nothing else adds panes there
 * (src/world/walkIn.ts).
 */
export function makePaneHomes({ prisms, doors }) {
  const table = new Map();
  for (const p of prisms) {
    if (p.m !== 'glass' || !Number.isInteger(p.glass) || !p.p?.[0]?.length) continue;
    const ring = p.p[0];
    const x = ring.reduce((s, q) => s + q[0], 0) / ring.length;
    const z = ring.reduce((s, q) => s + q[1], 0) / ring.length;
    let best = null;
    let near = WINDOW_REACH;
    for (const h of HOMES) {
      const d = distanceToHome(h.id, x, z, p.y0 - 0.3, p.y1); // a roof pane (a glass roof) lies just over its floor's band
      if (d <= near) [best, near] = [h.id, d];
    }
    table.set(p.glass, best);
  }
  for (const d of doors) {
    for (const panel of d.panels ?? []) {
      if (panel.glass && Number.isInteger(panel.glassNo)) table.set(panel.glassNo, homeOfDoor(d.id));
    }
  }
  const ranges = Object.entries(WALK_INS);
  const walkedInto = (i) => {
    if (!Number.isInteger(i)) return null;
    for (const [id, r] of ranges) if ((i >= r.glass && i < r.glass + r.size) || (i >= r.doorGlass && i < r.doorGlass + r.size)) return id;
    return null;
  };
  const home = (i) => table.get(i) ?? walkedInto(i);
  home.has = (i) => table.has(i) || walkedInto(i) !== null;
  return home;
}

/**
 * Whether a point is on the end house's lawn: in its garden ring, not within the house's own ring (that is the house,
 * see homeAt), and on the ground (the feet within 1.5 m of the lawn): never in the air over it, nor on the roof.
 */
export function inEndGarden(x, z, y) {
  if (!(Math.abs(y - END_GARDEN.y) <= 1.5)) return false;
  return inRing(x, z, END_GARDEN.ring) && !inRing(x, z, BANDS.molenhoek_end[0].ring);
}

/**
 * The heights for a band's walking barrier in the page's collision (src/world/collision.ts resolve), which blocks a body
 * from (feet + stepUp) to (feet + height) that overlaps it: for these heights that is exactly a player whose feet are
 * from y0 up to y1, which is the rule the server uses (homeAt). One rule on both sides.
 */
export const barrierHeights = (y0, y1, stepUp, height) => [y0 + height, y1 + stepUp];
