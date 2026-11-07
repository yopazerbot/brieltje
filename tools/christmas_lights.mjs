// Where the Christmas lights hang in December (web/src/world/christmas.ts): web/src/data/christmas.json.
//
//   node tools/christmas_lights.mjs
//
// Reads the town's houses (tools/town/houses.json), the village's roofs (web/src/data/village.json) and the roads the
// traffic drives (web/src/data/roads.json); writes only lines, no names or numbers of houses:
// - `town`: the houses round the church square (within 48 m of its middle) and the café by the tower, each a string
//   of lights along the eaves of its front (the side with its door, the one nearest a road), or up and down the gable
//   when the gable is the front (the café's crow steps step by step). [floor x, floor z, x0, h0, z0, x1, h1, z1]: the
//   page lifts h onto the ground at the floor's spot as tools/town/town.py does (5 cm over it).
// - `roofs`: a share of the village's other houses (about one in four, picked by a hash of where the roof is, so the
//   same houses each year), a string under the gutter of the eave nearest a road. Not on sheds and lean-tos, not on
//   the church, not on the town's houses (they have their own above) and not on the three code-locked homes or
//   anything within 30 m of them. [x0, y0, z0, x1, y1, z1] in the game's heights.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const TOWN = JSON.parse(readFileSync(join(ROOT, 'tools', 'town', 'houses.json'), 'utf8'));
const VILLAGE = JSON.parse(readFileSync(join(ROOT, 'web', 'src', 'data', 'village.json'), 'utf8'));
const ROADS = JSON.parse(readFileSync(join(ROOT, 'web', 'src', 'data', 'roads.json'), 'utf8'));
const OUT = join(ROOT, 'web', 'src', 'data', 'christmas.json');

const SQUARE = [532, -760]; // the middle of the church square
const SQUARE_REACH = 48;
const SHARE = 25; // percent of the village's houses with lights
const PRIVATE = [[4, 6], [85, 190], [1505, -353]]; // the main house, the bungalow, the end house: none near them
const PRIVATE_REACH = 30;

const r2 = (v) => Math.round(v * 100) / 100;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The roads' points, in a coarse grid for the nearest one.
const roadGrid = new Map();
for (const route of ROADS.routes) {
  for (const leg of route.legs) {
    for (let i = 0; i + 1 < leg.p.length; i += 2) {
      const key = `${Math.floor(leg.p[i] / 50)},${Math.floor(leg.p[i + 1] / 50)}`;
      if (!roadGrid.has(key)) roadGrid.set(key, []);
      roadGrid.get(key).push([leg.p[i], leg.p[i + 1]]);
    }
  }
}
function toRoad([x, z]) {
  let best = Infinity;
  const i0 = Math.floor(x / 50), j0 = Math.floor(z / 50);
  for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const q of roadGrid.get(`${i},${j}`) ?? []) best = Math.min(best, dist([x, z], q));
  return best;
}

function inside([x, z], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

// ---- The town's houses: the front of the main volume.
const town = [];
const townRings = [];
for (const house of TOWN.houses) {
  for (const vol of house.vols) townRings.push(vol.p);
  const near = dist(house.floor_at, SQUARE) <= SQUARE_REACH;
  if ((!near && house.id !== 'cafe') || /barn$|^barn/.test(house.id)) continue;
  const doors = (faces) => Object.entries(faces ?? {}).filter(([, f]) => /[dDs]/.test(JSON.stringify(f.rows ?? [])) || /"[dDs]/.test(JSON.stringify(f.at ?? []))).map(([k]) => Number(k));
  const vol = house.vols.find((v) => doors(v.faces).length) ?? house.vols[0];
  const p = vol.p;
  const L = (dist(p[0], p[1]) + dist(p[3], p[2])) / 2;
  const W = (dist(p[0], p[3]) + dist(p[1], p[2])) / 2;
  /** The point at s along p0-p1 and t across towards p3, bilinear between the corners (town.py's P). */
  const P = (s, t) => {
    const fu = s / L, fv = t / W;
    const w = [(1 - fu) * (1 - fv), fu * (1 - fv), fu * fv, (1 - fu) * fv];
    return [w.reduce((a, k, i) => a + k * p[i][0], 0), w.reduce((a, k, i) => a + k * p[i][1], 0)];
  };
  const mid = (face) => [P(L / 2, 0), P(L, W / 2), P(L / 2, W), P(0, W / 2)][face];
  const candidates = doors(vol.faces).length ? doors(vol.faces) : [0, 1, 2, 3];
  const face = candidates.reduce((a, b) => (toRoad(mid(b)) < toRoad(mid(a)) ? b : a));
  const e = vol.eaves, r = vol.ridge ?? vol.eaves;
  const oe = vol.overhang ?? 0.3, ov = 0.25;
  const lines = []; // [s, t, h] pairs
  const along = (t, h) => lines.push([[-0.1, t, h], [L + 0.1, t, h]]);
  const acrossAt = (s, pts) => pts.slice(1).forEach((q, i) => lines.push([[s, pts[i][0], pts[i][1]], [s, q[0], q[1]]]));
  const shape = vol.roof;
  const ye = shape === 'gable' ? e - ((r - e) / (W / 2)) * oe : shape === 'hip' ? e - ((r - e) / (W / 2)) * oe : shape === 'shed' ? e - ((r - e) / W) * oe : e + 0.12;
  const hang = -0.18; // under the gutter
  if (shape === 'flat') {
    if (face === 0) along(-0.08, e + 0.05);
    else if (face === 2) along(W + 0.08, e + 0.05);
    else acrossAt(face === 1 ? L + 0.08 : -0.08, [[-0.1, e + 0.05], [W + 0.1, e + 0.05]]);
  } else if (face === 0 || face === 2 || shape === 'hip') {
    if (face === 0) along(-oe - 0.05, ye + hang);
    else if (face === 2) along(W + oe + 0.05, (shape === 'shed' ? r : ye) + hang);
    else acrossAt(face === 1 ? L + oe + 0.05 : -oe - 0.05, [[-oe, ye + hang], [W + oe, ye + hang]]);
  } else {
    // The gable is the front: up one side and down the other, a little out from the wall.
    const s = face === 1 ? L + 0.12 : -0.12;
    const st = vol.stepped && vol.stepped.face === face ? vol.stepped : null;
    if (st) {
      // Crow steps: from the foot at each side up to the flat top, step by step (as town.py lays them out).
      const half = (W - st.flat) / 2;
      const run = half / st.steps, rise = (st.top - st.foot) / st.steps;
      const pts = [[0, st.foot - 0.6], [0, st.foot]];
      for (let k = 0; k < st.steps; k++) {
        pts.push([run * (k + 1), st.foot + rise * k], [run * (k + 1), st.foot + rise * (k + 1)]);
      }
      pts.push([W - half, st.top]);
      for (let k = st.steps - 1; k >= 0; k--) pts.push([W - run * (k + 1), st.foot + rise * (k + 1)], [W - run * (k + 1), st.foot + rise * k]);
      pts.push([W, st.foot], [W, st.foot - 0.6]);
      acrossAt(s, pts.map(([t, h]) => [t, h + 0.08]));
    } else if (shape === 'gable') {
      acrossAt(s, [[-ov, ye - 0.1], [W / 2, r - 0.25], [W + ov, ye - 0.1]]);
    } else {
      acrossAt(s, [[-ov, e - 0.1], [W + ov, r - 0.25]]);
    }
  }
  // The café: a second string under its sign, across the front.
  if (house.id === 'cafe' && face === 1) acrossAt(L + 0.16, [[0.25, 2.86], [W - 0.25, 2.86]]);
  const [fx, fz] = house.floor_at;
  for (const [[s0, t0, h0], [s1, t1, h1]] of lines) {
    const a = P(s0, t0), b = P(s1, t1);
    town.push([fx, fz, r2(a[0]), r2(h0), r2(a[1]), r2(b[0]), r2(h1), r2(b[1])]);
  }
}

// ---- The village's houses: one in four, the eave nearest a road.
const hash = (x, z) => {
  let h = (Math.round(x * 10) * 73856093) ^ (Math.round(z * 10) * 19349663);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) % 100;
};
const roofs = [];
for (const roof of VILLAGE.roofs) {
  if (roof.lm || roof.shape === 'shed') continue;
  const c = roof.p.reduce((a, q) => [a[0] + q[0] / roof.p.length, a[1] + q[1] / roof.p.length], [0, 0]);
  if (PRIVATE.some((q) => dist(c, q) < PRIVATE_REACH)) continue;
  if (townRings.some((ring) => inside(c, ring) || ring.some((q) => dist(c, q) < 3))) continue;
  if (hash(c[0], c[1]) >= SHARE) continue;
  const [p0, p1, p2, p3] = roof.p;
  const L = dist(p0, p1), W = dist(p0, p3);
  if (L < 4 || W < 3) continue; // a garden shed
  const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L];
  const v = [(p3[0] - p0[0]) / W, (p3[1] - p0[1]) / W];
  const o = 0.3 + 0.14; // the overhang, then the gutter's front (world/surroundings.ts)
  const at = (a, b) => [p0[0] + u[0] * a + v[0] * b, p0[1] + u[1] * a + v[1] * b];
  const sides = [[at(-0.25, -o), at(L + 0.25, -o)], [at(-0.25, W + o), at(L + 0.25, W + o)]];
  const [a, b] = sides.reduce((x, y) => (toRoad([(y[0][0] + y[1][0]) / 2, (y[0][1] + y[1][1]) / 2]) < toRoad([(x[0][0] + x[1][0]) / 2, (x[0][1] + x[1][1]) / 2]) ? y : x));
  const y = roof.y - 0.15 - 0.2; // under the gutter (the overhang drops 15 cm: surroundings.ts)
  roofs.push([r2(a[0]), r2(y), r2(a[1]), r2(b[0]), r2(y), r2(b[1])]);
}

const out = {
  _source: 'tools/christmas_lights.mjs: lines along eaves, from tools/town/houses.json and web/src/data/village.json',
  town,
  roofs,
};
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`christmas.json: ${town.length} strings on the town's houses, ${roofs.length} houses of the village`);
