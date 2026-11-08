// Where two of the ground's hard surfaces lie on top of each other, as the game draws them (tools/dev/cdp.mjs).
//
//   node tools/dev/groundOverlap.mjs [--url http://localhost:5200/] [--port 9900] [--cell 0.2] [--gap 0.08]
//                                    [--top 40] [--json out.json] [--only x0,z0,x1,z1] [--hidden]
//
// Two surfaces a few centimetres apart in height flicker where they overlap (z-fighting): the depth buffer can't
// tell them apart, the more so the further off they are. This loads the game with the village, takes every
// mesh's triangles that face up and lie near the ground (the village's covers, the streets in detail, our models'
// forecourts, squares and yards, the homes' grounds; not the grass, which lies under them all on purpose, nor the
// paint and other decals pulled forward in depth), samples them on a plan grid of `cell` metres, and reports every
// spot where two of them (or two parts of one merged mesh) lie within `gap` metres of each other: the area, where,
// which surfaces and how far apart. A spot is the samples of one pair of surfaces that touch each other. What lies
// more than 5 mm under the grass is hidden by it and left out (--hidden counts it too).
import { writeFileSync } from 'node:fs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9900', cell: '0.2', gap: '0.08', top: '40', json: '', only: '', hidden: false });

/** Runs in the page: returns the spots. */
async function scan(cell, gap, only, hidden) {
  const { terrain } = await import('/src/world/terrain.ts');
  const briel = window.briel;
  const scene = briel.three.scene;
  const grass = new Set();
  briel.grass.traverse((m) => m.material && grass.add(m.material));
  const BLOCK = 32; // m: the plan is sampled one block at a time
  const n = Math.ceil(BLOCK / cell);
  const LAYERS = 6;
  /** Each surface's name: where it comes from and what it is. */
  const names = [];
  const label = (mesh) => {
    let p = mesh;
    let model = '';
    let top = '';
    while (p && p !== scene) {
      if (p.userData?.landmark && !model) model = String(p.userData.landmark);
      if (p.name && !top && p !== mesh) top = p.name;
      if (p.parent === scene && !top) top = p.name || p.type;
      p = p.parent;
    }
    const mat = mesh.material;
    const what = mesh.name || mat?.name || '';
    if (mesh.userData.source) return `${mesh.userData.source}:${what}`;
    if (model) return `model ${model}:${what || mat?.name || '?'}`;
    return `${top || 'scene'}:${what || '?'}`;
  };
  // The triangles, by block.
  const blocks = new Map();
  const v = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  const [ox0, oz0, ox1, oz1] = only ?? [-Infinity, -Infinity, Infinity, Infinity];
  scene.updateMatrixWorld(true);
  let triangles = 0;
  scene.traverse((mesh) => {
    if (!mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh || !mesh.geometry?.attributes?.position) return;
    const mat = mesh.material;
    if (Array.isArray(mat) || !mat || grass.has(mat) || mat.transparent || mat.polygonOffsetFactor <= -2 || mat.depthWrite === false) return;
    if (mesh.layers.mask === 2) return; // shadow-only stand-ins
    const pos = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : pos.count;
    const id = names.length;
    let used = false;
    for (let t = 0; t + 2 < count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = index ? index.getX(t + k) : t + k;
        const [px, py, pz] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        const e = mesh.matrixWorld.elements;
        v[k].x = e[0] * px + e[4] * py + e[8] * pz + e[12];
        v[k].y = e[1] * px + e[5] * py + e[9] * pz + e[13];
        v[k].z = e[2] * px + e[6] * py + e[10] * pz + e[14];
      }
      // Facing up (counter-clockwise seen from above), and near the ground (it lies 0.1 m under the model's 0).
      const ux = v[1].x - v[0].x, uz = v[1].z - v[0].z, wx = v[2].x - v[0].x, wz = v[2].z - v[0].z;
      const area2 = uz * wx - ux * wz;
      if (area2 < 1e-6) continue;
      const nyLen = Math.hypot((v[1].y - v[0].y) * wz - (v[2].y - v[0].y) * uz, (v[1].y - v[0].y) * wx - (v[2].y - v[0].y) * ux, area2);
      if (area2 / nyLen < 0.8) continue;
      let near = true;
      for (const q of v) {
        const rel = q.y - terrain.height(q.x, q.z);
        if (rel < -0.55 || rel > 0.45) near = false;
      }
      if (!near) continue;
      const x0 = Math.min(v[0].x, v[1].x, v[2].x), x1 = Math.max(v[0].x, v[1].x, v[2].x);
      const z0 = Math.min(v[0].z, v[1].z, v[2].z), z1 = Math.max(v[0].z, v[1].z, v[2].z);
      if (x1 < ox0 || x0 > ox1 || z1 < oz0 || z0 > oz1) continue;
      const tri = [v[0].x, v[0].y, v[0].z, v[1].x, v[1].y, v[1].z, v[2].x, v[2].y, v[2].z, id];
      for (let bi = Math.floor(x0 / BLOCK); bi <= Math.floor(x1 / BLOCK); bi++) {
        for (let bj = Math.floor(z0 / BLOCK); bj <= Math.floor(z1 / BLOCK); bj++) {
          const key = `${bi},${bj}`;
          let list = blocks.get(key);
          if (!list) blocks.set(key, (list = []));
          list.push(tri);
        }
      }
      used = true;
      triangles++;
    }
    names.push(used ? label(mesh) : null);
  });
  // Each block's samples: up to LAYERS surfaces per sample, their heights.
  const ids = new Int32Array(n * n * LAYERS);
  const ys = new Float32Array(n * n * LAYERS);
  const fill = new Uint8Array(n * n);
  const SPOT = 4; // m: samples gathered in squares this big, joined into spots below
  const pairs = new Map(); // "a|b" -> Map(square key -> { count, gapSum, gapMin, x, z })
  const JX = 0.3713, JZ = 0.6187; // where in its cell a sample lies: off the grid lines the covers are cut along
  let samples = 0;
  for (const [key, list] of blocks) {
    const [bi, bj] = key.split(',').map(Number);
    const bx = bi * BLOCK;
    const bz = bj * BLOCK;
    fill.fill(0);
    for (const t of list) {
      const [ax, ay, az, bx_, by, bz_, cx, cy, cz, id] = t;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx_, cx) - bx) / cell - JX));
      const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx_, cx) - bx) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz_, cz) - bz) / cell - JZ));
      const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz_, cz) - bz) / cell));
      const det = (bz_ - cz) * (ax - cx) + (cx - bx_) * (az - cz);
      if (Math.abs(det) < 1e-12) continue;
      for (let i = i0; i <= i1; i++) {
        const x = bx + (i + JX) * cell;
        for (let j = j0; j <= j1; j++) {
          const z = bz + (j + JZ) * cell;
          const l1 = ((bz_ - cz) * (x - cx) + (cx - bx_) * (z - cz)) / det;
          const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < 0 || l2 < 0 || l3 < 0) continue;
          const y = ay * l1 + by * l2 + cy * l3;
          // Under the grass (0.1 m under the relief) it doesn't show, and can't flicker with what lies over it.
          if (!hidden && y < terrain.height(x, z) - 0.1 - 0.005) continue;
          const c = i * n + j;
          const f = fill[c];
          if (f >= LAYERS) continue;
          ids[c * LAYERS + f] = id;
          ys[c * LAYERS + f] = y;
          fill[c] = f + 1;
        }
      }
    }
    for (let c = 0; c < n * n; c++) {
      const f = fill[c];
      if (!f) continue;
      samples++;
      if (f < 2) continue;
      for (let a = 0; a < f; a++) {
        for (let b = a + 1; b < f; b++) {
          const d = Math.abs(ys[c * LAYERS + a] - ys[c * LAYERS + b]);
          if (d > gap) continue;
          const ia = ids[c * LAYERS + a];
          const ib = ids[c * LAYERS + b];
          const pk = ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
          let squares = pairs.get(pk);
          if (!squares) pairs.set(pk, (squares = new Map()));
          const x = bx + (Math.floor(c / n) + JX) * cell;
          const z = bz + ((c % n) + JZ) * cell;
          const sk = `${Math.floor(x / SPOT)},${Math.floor(z / SPOT)}`;
          let s = squares.get(sk);
          if (!s) squares.set(sk, (s = { count: 0, gapSum: 0, rel: 0, gapMin: Infinity, x: 0, z: 0, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }));
          s.count++;
          s.gapSum += d;
          s.rel += Math.max(ys[c * LAYERS + a], ys[c * LAYERS + b]) - terrain.height(x, z);
          s.gapMin = Math.min(s.gapMin, d);
          s.x += x;
          s.z += z;
          s.x0 = Math.min(s.x0, x);
          s.x1 = Math.max(s.x1, x);
          s.z0 = Math.min(s.z0, z);
          s.z1 = Math.max(s.z1, z);
        }
      }
    }
  }
  // Spots: a pair's squares that touch (8 ways round).
  const spots = [];
  for (const [pk, squares] of pairs) {
    const [ia, ib] = pk.split('|').map(Number);
    const seen = new Set();
    for (const start of squares.keys()) {
      if (seen.has(start)) continue;
      const spot = { a: names[ia], b: names[ib], count: 0, gapSum: 0, rel: 0, gapMin: Infinity, x: 0, z: 0, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const k = stack.pop();
        const s = squares.get(k);
        spot.count += s.count;
        spot.gapSum += s.gapSum;
        spot.rel += s.rel;
        spot.gapMin = Math.min(spot.gapMin, s.gapMin);
        spot.x += s.x;
        spot.z += s.z;
        spot.x0 = Math.min(spot.x0, s.x0);
        spot.x1 = Math.max(spot.x1, s.x1);
        spot.z0 = Math.min(spot.z0, s.z0);
        spot.z1 = Math.max(spot.z1, s.z1);
        const [i, j] = k.split(',').map(Number);
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            const nk = `${i + di},${j + dj}`;
            if (squares.has(nk) && !seen.has(nk)) {
              seen.add(nk);
              stack.push(nk);
            }
          }
        }
      }
      spots.push({
        a: spot.a, b: spot.b, area: +(spot.count * cell * cell).toFixed(2),
        at: [+(spot.x / spot.count).toFixed(1), +(spot.z / spot.count).toFixed(1)],
        box: [+spot.x0.toFixed(1), +spot.z0.toFixed(1), +spot.x1.toFixed(1), +spot.z1.toFixed(1)],
        gapMin: +(spot.gapMin * 100).toFixed(1), gapMean: +((spot.gapSum / spot.count) * 100).toFixed(1),
        height: +((spot.rel / spot.count + 0.1) * 100).toFixed(0), // over the grass (house_shell.json ground: 0.1 m under the relief)
      });
    }
  }
  spots.sort((p, q) => q.area - p.area);
  return { triangles, samples, area: +(samples * cell * cell).toFixed(0), spots };
}

const b = await launch({ port: Number(o.port) });
try {
  console.log('chromium pid', b.pid);
  await startGame(b, o.url, { village: true });
  await b.sleep(3000);
  const only = o.only ? o.only.split(',').map(Number) : null;
  const r = await b.evaluate(`(${scan.toString()})(${Number(o.cell)}, ${Number(o.gap)}, ${JSON.stringify(only)}, ${o.hidden})`);
  const total = r.spots.reduce((s, p) => s + p.area, 0);
  const band = (lo, hi) => r.spots.filter((p) => p.gapMean >= lo && p.gapMean < hi).reduce((s, p) => s + p.area, 0);
  console.log(`${r.triangles} triangles near the ground, ${r.area} m² of hard ground sampled every ${o.cell} m`);
  console.log(`overlapping within ${Number(o.gap) * 100} cm: ${total.toFixed(1)} m² in ${r.spots.length} spots`);
  console.log(`  by mean gap: under 1 cm ${band(0, 1).toFixed(1)} m², 1-3 cm ${band(1, 3).toFixed(1)} m², 3 cm and more ${band(3, 100).toFixed(1)} m²`);
  const byPair = new Map();
  for (const p of r.spots) {
    const k = [p.a, p.b].sort().join('  +  ');
    byPair.set(k, (byPair.get(k) ?? 0) + p.area);
  }
  console.log('by pair:');
  for (const [k, a] of [...byPair].sort((x, y) => y[1] - x[1]).slice(0, 30)) console.log(`  ${a.toFixed(1).padStart(9)} m²  ${k}`);
  console.log(`the ${Math.min(Number(o.top), r.spots.length)} largest spots:`);
  for (const p of r.spots.slice(0, Number(o.top))) {
    console.log(`  ${p.area.toFixed(1).padStart(8)} m² at ${p.at.join(', ')} (box ${p.box.join(' ')}), gap ${p.gapMin}-${p.gapMean} cm, ${p.height} cm over the grass: ${p.a}  +  ${p.b}`);
  }
  if (o.json) writeFileSync(o.json, JSON.stringify(r, null, 1));
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log('page errors:', errors.slice(0, 5).join('\n'));
} finally {
  b.close();
}
