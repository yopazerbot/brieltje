// An audit of the whole map for collision bugs, in the real game on a running dev server, in one page load: where
// what is drawn and what stops you disagree. Each class prints its count and its three worst spots; --json writes
// every spot. Exits 1 when a class that should be zero is not (`trees`, `roofs`, `about`, `spots` and `drops` always;
// more with --strict). What a relaxed rule lets pass is printed under its class as `excused`, every run.
//
//   node tools/dev/collide.mjs --url http://localhost:5200/ --port 9800 [--quality high] [--json out.json]
//        [--only trees,walls,sides,roofs,about,ground,spots,drops] [--strict walls,sides,ground]
//        [--compare before.json] [--shots <folder>] [--sample 13]
//
// The classes:
// - trees: every drawn tree trunk (and the street models' conifers) walked at from four sides by a walker that does
//   what Player.update does (8 cm steps, World.resolve, the edge, a step up of 0.5 m); every --sample'th tree by the
//   real player too. A body that passes within 10 cm of a trunk's axis went through it; a side whose start lies outside
//   the game's edge is left out (counted: no player stands there, and the edge would push the walker in). Also: falls (3 m) onto 40 trunks in
//   the woods (the body must end beside the trunk, on the ground), and a body put into each narrow gap between a
//   trunk and a wall must come out free, by itself or walking out.
// - walls: every drawn triangle of the static world sampled at body height (0.55 to 1.75 m over the floor there);
//   a sample with no block within 0.3 m is walked at from both sides; squares a player reaches from the streets and
//   passes, below 1.4 m, by what is drawn there. Allowed: loose things, leaves and branches, the gutters of low sheds;
//   drawn trunks count under `trees`.
// - sides: every 1.5 m of every block's side that stops a player, rays every 20 cm of the body's height: nothing
//   drawn within 0.6 m outside or 1.2 m inside (an invisible wall), where a player reaches. Things drawn only near
//   the eye (parked cars, bale rows) are looked at again from 7 m.
// - roofs: per roof of the data, the highest drawn surface against the floor a falling player lands on: over 0.5 m
//   either way (sunk into the roof, or standing on air on a block or a roof). The buildings with hand-made blocks and
//   the private homes are listed apart, and so are blocks a model stands for with nothing of it drawn over them (the
//   models' outlines). Also: a body put in 300 narrow places on roofs (against something higher, in a valley) must
//   stand free on what is drawn and walk away (`wedged`).
// - about: on every block a model stands for that its roof capped, a body walked from up to eight spots four ways:
//   no step over 0.3 m in a frame, never ending inside a block, never a second or more inside one.
// - ground: a ray down every 4 m of the walkable map: drawn ground more than 0.75 m off the floor, and holes.
// - spots: spawns, portals and their pads, places, gnomes, route gates and checkpoints, the Zombies places' homes and
//   stalls, pick-ups, bikes and parked cars: free for a body (or a car), no trunk within 0.3 m; with --compare, the
//   floor under each as in that earlier run.
// - drops: 60 real parachute drops over the church square and Molenhoek, hands off: the feet within 0.5 m of the
//   highest drawn surface where they land (a landing on the ground under the eaves, free there, is fine).
//
// What the probes need (learnt the hard way): three is imported from the page's own module, every tile is shown
// and kept so (tiles.update emptied on this page), skinned meshes, `ignoreRay`, vehicles, hidden materials and all
// but the first level of a LOD are left out, and things drawn only near the eye are probed from near.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STALL_SPOTS } from '../../web/shared/stall.mjs';
import { PORTALS } from '../../web/shared/portals.mjs';
import { ARENAS } from '../../web/shared/arenas.mjs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9800', quality: 'high', json: '', only: '', strict: '', compare: '', shots: '', sample: '13' });
const ALL = ['trees', 'walls', 'sides', 'roofs', 'about', 'ground', 'spots', 'drops'];
const only = new Set(o.only ? o.only.split(',') : ALL);
const strict = new Set(['trees', 'roofs', 'about', 'spots', 'drops', ...(o.strict ? o.strict.split(',') : [])]);
const read = (p) => JSON.parse(readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8'));
if (o.shots) mkdirSync(o.shots, { recursive: true });

const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
/** Run `fn` in the page with `args` (JSON), awaited; its value comes back as JSON. */
const run = (fn, ...args) => b.evaluate(`(${fn})(...${JSON.stringify(args)})`);
const results = {};

// ------------------------------------------------------------------------------------------------ in the page

/** window.__c: the drawn static world as targets, a ray against it, a walker as Player.update's, the drawn trunks. */
async function setup() {
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /deps\/three\.js/.test(n));
  const THREE = await import(url);
  const W = briel.world;
  const scene = briel.three.scene;
  const tiles = briel.tiles;
  if (!tiles.__frozen) {
    tiles.__frozen = tiles.update;
    tiles.update = () => {};
  }
  tiles.showAll();
  for (const t of tiles.tracked) t.object.visible = true;
  // Every LOD at its near level, as the collision has it (world/modelRoofs.ts), wherever the camera is now.
  scene.traverse((o) => {
    if (!o.isLOD) return;
    o.autoUpdate = false;
    o.levels.forEach((l, i) => (l.object.visible = i === 0));
  });
  scene.updateMatrixWorld(true);
  const shownUp = (o) => {
    for (let p = o; p; p = p.parent) if (!p.visible && !p.userData.detail && !(p.parent && p.parent.isLOD)) return false;
    return true;
  };
  const lodOk = (o) => {
    for (let p = o; p && p.parent; p = p.parent) if (p.parent.isLOD && p.parent.levels[0].object !== p) return false;
    return true;
  };
  const matShown = (o) => (Array.isArray(o.material) ? o.material : [o.material]).some((m) => m && m.visible !== false);
  const landmarks = new Set(); // the classes of hand-built models (a landmark above them)
  const trunkShapes = new Set(); // the classes of the trees' trunks
  const landmark = (o) => {
    for (let p = o; p; p = p.parent) if (p.userData.landmark) return true;
    return false;
  };
  const rootName = (o) => {
    for (let p = o; p; p = p.parent) if (p.userData.landmark) return String(p.userData.landmark);
    for (let p = o.parent; p; p = p.parent) if (p.name && p.name !== 'Scene') return p.name;
    return '';
  };
  const dims = (g) => {
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    return [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
  };
  const targets = [];
  const skipped = {};
  const m4 = new THREE.Matrix4();
  const mw = new THREE.Matrix4();
  const v3 = new THREE.Vector3();
  // The drawn trunks: the smooth trunk's copies (built on every preset, whichever trees are shown) and the street
  // models' conifers (Medium and up), by place.
  const trunks = new Map();
  scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.geometry?.attributes?.position) return;
    const [dx, dy, dz] = dims(o.geometry);
    const smooth = dx > 0.2 && dx < 0.45 && dz > 0.2 && dz < 0.45 && dy > 0.9 && dy < 1.1;
    const conifer = o.name === 'mh_foliage';
    if (!smooth && !conifer) return;
    for (let k = 0; k < o.count; k++) {
      o.getMatrixAt(k, m4);
      mw.multiplyMatrices(o.matrixWorld, m4);
      const p = v3.setFromMatrixPosition(mw);
      const s = new THREE.Vector3().setFromMatrixScale(mw);
      if (s.y < 1e-3) continue;
      const key = `${p.x.toFixed(1)},${p.z.toFixed(1)}`;
      if (!trunks.has(key)) trunks.set(key, { x: p.x, y: p.y, z: p.z, h: s.y * (smooth ? 1 : dy), conifer });
    }
  });
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const why = o.isSkinnedMesh ? 'skinned' : o.userData.ignoreRay ? 'ignoreRay' : o.userData.vehicle ? 'vehicle' : !o.geometry?.attributes?.position ? 'nogeo' : !matShown(o) ? 'matHidden' : !lodOk(o) ? 'lodFar' : !shownUp(o) ? 'hidden' : null;
    if (why) {
      skipped[why] = (skipped[why] ?? 0) + 1;
      return;
    }
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const dim = dims(o.geometry).map((v) => +v.toFixed(1)).join('x');
    const tag = o.name || o.userData.material || m.name || m.type;
    const cls = [rootName(o) || (o.userData.source ?? ''), tag, (m.alphaTest ? 'cut' : '') + (m.transparent ? 'tr' : ''), o.isInstancedMesh ? `inst${dim}` : ''].filter(Boolean).join('|');
    targets.push({ o, cls, inst: !!o.isInstancedMesh });
    if (landmark(o)) landmarks.add(cls);
    // A trunk's shape: copies of a narrow shape one unit high, stretched to each tree (the crowns are other shapes).
    const [dx, dy, dz] = dims(o.geometry);
    if (o.isInstancedMesh && dy > 0.9 && dy < 1.2 && dx < 1.3 && dz < 1.3 && !m.alphaTest) trunkShapes.add(cls);
  });
  // Copies by squares of 8 m, for the rays.
  const CELL = 8;
  const key = (i, j) => (i + 4096) * 8192 + (j + 4096);
  const index = (t) => {
    const o = t.o;
    if (t.inst) {
      t.grid = new Map();
      o.geometry.computeBoundingSphere();
      const sp = o.geometry.boundingSphere;
      t.rad = 0;
      for (let k = 0; k < o.count; k++) {
        o.getMatrixAt(k, m4);
        m4.premultiply(o.matrixWorld);
        const c = v3.copy(sp.center).applyMatrix4(m4);
        t.rad = Math.max(t.rad, sp.radius * m4.getMaxScaleOnAxis());
        const kk = key(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
        const l = t.grid.get(kk);
        if (l) l.push(k);
        else t.grid.set(kk, [k]);
      }
    } else t.box = new THREE.Box3().setFromObject(o);
  };
  targets.forEach(index);
  const ray = new THREE.Raycaster();
  const tmp = new THREE.Mesh();
  const hits = [];
  const segBox = new THREE.Box3();
  const o3 = new THREE.Vector3(), d3 = new THREE.Vector3(), e3 = new THREE.Vector3();
  /** The drawn hits along a ray, nearest first: { d, x, y, z, cls, ny }. `skip`: classes left out (a regexp). */
  function cast(ox, oy, oz, dx, dy, dz, far, skip, list = targets) {
    o3.set(ox, oy, oz);
    d3.set(dx, dy, dz).normalize();
    ray.set(o3, d3);
    ray.near = 0;
    ray.far = far;
    e3.copy(d3).multiplyScalar(far).add(o3);
    segBox.makeEmpty();
    segBox.expandByPoint(o3);
    segBox.expandByPoint(e3);
    segBox.expandByScalar(0.01);
    const out = [];
    for (const t of list) {
      if (skip && skip.test(t.cls)) continue;
      hits.length = 0;
      if (!t.inst) {
        if (!t.box.intersectsBox(segBox)) continue;
        t.o.raycast(ray, hits);
      } else {
        const r = t.rad;
        const i0 = Math.floor((segBox.min.x - r) / CELL), i1 = Math.floor((segBox.max.x + r) / CELL);
        const j0 = Math.floor((segBox.min.z - r) / CELL), j1 = Math.floor((segBox.max.z + r) / CELL);
        tmp.geometry = t.o.geometry;
        tmp.material = t.o.material;
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const k of t.grid.get(key(i, j)) ?? []) {
          t.o.getMatrixAt(k, m4);
          tmp.matrixWorld.multiplyMatrices(t.o.matrixWorld, m4);
          tmp.raycast(ray, hits);
        }
      }
      for (const h of hits) out.push({ d: h.distance, x: h.point.x, y: h.point.y, z: h.point.z, cls: t.cls, ny: h.face ? h.face.normal.y : 0 });
    }
    return out.sort((a, c) => a.d - c.d);
  }
  const R = 0.25, STEP_UP = 0.5, H = 1.8;
  /** A walker as Player.update's: `dist` m from (x, z) along (dx, dz) in steps of 8 cm; `near` (x, z): its closest pass. */
  function walk(x, z, feet, dx, dz, dist, near = null) {
    const pos = { x, z };
    const n = Math.ceil(dist / 0.08);
    let edge = false;
    let closest = Infinity;
    const roofIn = (x, z) => !!W.roofBlocks?.(x, z, feet, STEP_UP, H);
    for (let i = 0; i < n; i++) {
      const was = { x: pos.x, z: pos.z };
      // Up a roof slower the steeper (as Player.update): none from 60 degrees.
      const k = W.roofClimb && W.groundAt(pos.x, pos.z, feet, 0).mat === 'roof' ? W.roofClimb(pos.x, pos.z, dx, dz) : 1;
      pos.x += (dx * dist * k) / n;
      pos.z += (dz * dist * k) / n;
      W.resolve(pos, feet, R, STEP_UP, H);
      if (W.keepIn(pos, R)) edge = true;
      // A drawn roof beside: pushed off; ahead: along it on x or z, else stay (world/roofField.ts, as Player.update).
      W.roofPush?.(pos, feet, R, STEP_UP, H);
      if (roofIn(pos.x, pos.z) && !roofIn(was.x, was.z)) {
        if (!roofIn(pos.x, was.z)) pos.z = was.z;
        else if (!roofIn(was.x, pos.z)) pos.x = was.x;
        else Object.assign(pos, was);
      }
      feet = W.groundAt(pos.x, pos.z, feet, STEP_UP).y; // up a step, down a step, or the fall done at once
      if (near) closest = Math.min(closest, Math.hypot(pos.x - near[0], pos.z - near[1]));
    }
    return { x: pos.x, z: pos.z, feet, edge, closest };
  }
  const free = (x, z, feet, r = R) => W.touching(x, z, feet + STEP_UP, feet + H, r) === null;
  /** The floor a walker stands on at (x, z): the ground's, or what stands on it within a step. */
  const floorAt = (x, z) => W.groundAt(x, z, W.baseAt(x, z) + 0.6, 0.6).y;
  const trunkList = [...trunks.values()];
  window.__c = { THREE, W, scene, targets, cast, walk, free, floorAt, index, skipped, R, STEP_UP, H, trunks: trunkList, landmarks, trunkShapes };
  return { targets: targets.length, skipped, trunks: trunkList.length, conifers: trunkList.filter((t) => t.conifer).length, solids: W.solids.length };
}

/** window.__reach: where a player walks to from the streets, a flood over 0.5 m squares of the whole map. */
function flood() {
  const { W } = window.__c;
  const edge = W.bounds;
  const C = 0.5;
  const x0 = -832, z0 = -1284, nx = Math.ceil((1990 - x0) / C), nz = Math.ceil((1097 - z0) / C);
  const state = new Uint8Array(nx * nz);
  const feet = new Float32Array(nx * nz);
  const t = performance.now();
  const seeds = [[555.3, -805.8], [4.5, 19], ...briel.places.map((p) => [p.out?.[0] ?? p.x, p.out?.[1] ?? p.z]).filter((s) => Number.isFinite(s[0]))];
  const stack = new Int32Array(nx * nz);
  let sp = 0, reached = 0;
  for (const [sx, sz] of seeds) {
    const i = Math.floor((sx - x0) / C), j = Math.floor((sz - z0) / C);
    const k = i * nz + j;
    if (state[k]) continue;
    const x = x0 + (i + 0.5) * C, z = z0 + (j + 0.5) * C;
    const f = W.groundAt(x, z, 1e6, 0).y;
    if (W.touching(x, z, f + 0.5, f + 1.8, 0.25)) continue;
    state[k] = 1;
    feet[k] = f;
    stack[sp++] = k;
    reached++;
  }
  const DI = [1, -1, 0, 0], DJ = [0, 0, 1, -1];
  while (sp) {
    const k = stack[--sp];
    const i = Math.floor(k / nz), j = k % nz;
    const f = feet[k];
    for (let d = 0; d < 4; d++) {
      const a = i + DI[d], c = j + DJ[d];
      if (a < 0 || c < 0 || a >= nx || c >= nz) continue;
      const q = a * nz + c;
      if (state[q]) continue;
      const x = x0 + (a + 0.5) * C, z = z0 + (c + 0.5) * C;
      if (!edge.inside(x, z)) {
        state[q] = 3;
        continue;
      }
      const g = W.groundAt(x, z, f, 0.5).y;
      if (W.touching(x, z, g + 0.5, g + 1.8, 0.25)) continue; // not marked: another way in may be lower or higher
      state[q] = 1;
      feet[q] = g;
      stack[sp++] = q;
      reached++;
    }
  }
  const at = (x, z) => {
    const i = Math.floor((x - x0) / C), j = Math.floor((z - z0) / C);
    return i >= 0 && j >= 0 && i < nx && j < nz && state[i * nz + j] === 1 ? feet[i * nz + j] : null;
  };
  /** 1: reachable from the streets (a square round it at about that floor), 0: a closed pocket, 2: on a floor or roof. */
  const where = (x, z, F) => {
    if (F - W.baseAt(x, z) >= 0.3) return 2;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      const f = at(x + a * 0.5, z + c * 0.5);
      if (f !== null && Math.abs(f - F) < 0.6) return 1;
    }
    return 0;
  };
  window.__reach = { x0, z0, nx, nz, C, state, feet, at, where };
  return { ms: Math.round(performance.now() - t), seeds: seeds.length, km2: +((reached * C * C) / 1e6).toFixed(2) };
}

/** Trees: each drawn trunk walked at from four sides; every `sample`th by the real player; falls onto trunks; wedges. */
function trees(sample) {
  const { W, walk, free, floorAt, trunks, R } = window.__c;
  const p = briel.player;
  const keep = { x: p.x, z: p.z, feet: p.feet, yaw: p.yaw, flying: p.flying };
  p.flying = false;
  /** Put the player at (x, z, feet), standing still (a teleport keeps the speed it had). */
  const put = (x, z, feet, yaw = 0) => {
    p.vx = 0;
    p.vz = 0;
    p.vy = 0;
    briel.teleport(x, z, feet, yaw, 0);
  };
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const rows = [];
  let tested = 0, through = 0, real = 0, realThrough = 0, outside = 0;
  trunks.forEach((t, n) => {
    const g = floorAt(t.x, t.z);
    let tried = 0, passed = 0, closest = Infinity, start = null;
    for (const [dx, dz] of SIDES) {
      const sx = t.x - dx * 2, sz = t.z - dz * 2;
      // A start outside the game's edge is no place a player stands: the edge would push the walker in, through the
      // trunk. Counted, so the rule shows how much it leaves out.
      if (!W.bounds.inside(sx, sz)) {
        outside++;
        continue;
      }
      const f0 = floorAt(sx, sz);
      if (Math.abs(f0 - g) > 0.5 || !free(sx, sz, f0)) continue;
      const e = walk(sx, sz, f0, dx, dz, 4, [t.x, t.z]);
      if (e.closest > R + 0.4) continue; // stopped by something else first (a hedge round it)
      tried++;
      closest = Math.min(closest, e.closest);
      if (e.closest < 0.1) passed++;
      start ??= [sx, sz, f0, dx, dz];
    }
    if (!tried) return;
    tested++;
    let realPass = null;
    if (start && n % sample === 0) {
      const [sx, sz, f0, dx, dz] = start;
      put(sx, sz, f0, Math.atan2(-dx, -dz));
      let near = Infinity;
      for (let i = 0; i < 180; i++) {
        briel.press({ moveY: 1 }, 1 / 60);
        near = Math.min(near, Math.hypot(p.x - t.x, p.z - t.z));
      }
      real++;
      realPass = near < 0.1;
      if (realPass) realThrough++;
    }
    if (passed || realPass) {
      through++;
      rows.push({ x: +t.x.toFixed(2), z: +t.z.toFixed(2), sides: `${passed} of ${tried}`, real: realPass, closest: +closest.toFixed(2), conifer: t.conifer });
    }
  });
  // Falls onto trunks in the woods (the Sparrenhof's and the others): from 3 m over each, hands off (higher, the
  // parachute opens and glides off).
  const woods = trunks.filter((t) => !t.conifer && W.bounds.depth(t.x, t.z) > 2 && W.groundAt(t.x, t.z, W.baseAt(t.x, t.z) + 0.6, 0.6).mat === 'forest');
  const falls = [];
  for (let i = 0; i < woods.length && falls.length < 40; i += Math.max(1, Math.floor(woods.length / 40))) {
    const t = woods[i];
    const g = floorAt(t.x, t.z);
    put(t.x + 0.02, t.z + 0.01, g + 3);
    for (let k = 0; k < 240 && p.feet > p.ground.y + 0.01; k++) briel.press({}, 1 / 60);
    briel.press({}, 1 / 60);
    const d = Math.hypot(p.x - t.x, p.z - t.z);
    falls.push({ x: +t.x.toFixed(2), z: +t.z.toFixed(2), d: +d.toFixed(2), feet: +(p.feet - W.baseAt(p.x, p.z)).toFixed(2), inTrunk: d < 0.3 || !free(p.x, p.z, p.feet, 0.2) });
  }
  // Narrow gaps between a trunk and something else that stops a body: put a body in, let it settle, it must be free.
  const wedges = [];
  let gaps = 0;
  for (const t of trunks) {
    if (gaps >= 300) break;
    const g = floorAt(t.x, t.z);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const x = t.x + Math.cos(a) * 0.62, z = t.z + Math.sin(a) * 0.62;
      if (Math.abs(floorAt(x, z) - g) > 0.3 || W.touching(x, z, g + 0.5, g + 1.8, 0.24) === null) continue;
      const hit = W.touching(x, z, g + 0.5, g + 1.8, 0.24);
      if (hit?.name === 'trunk') continue;
      // something else within 0.24 of a spot 0.62 m from the trunk: a gap narrower than a body
      // A body pressed into it: its middle 0.45 m from the trunk, where a body can be (not inside the other thing).
      // (3 cm aside: a push never lines a body up exactly with a row of posts.)
      const mx = t.x + Math.cos(a) * 0.45 - Math.sin(a) * 0.03, mz = t.z + Math.sin(a) * 0.45 + Math.cos(a) * 0.03;
      const there = W.touching(mx, mz, g + 0.5, g + 1.8, 0.01);
      if (there && there.name !== 'trunk') continue;
      gaps++;
      put(mx, mz, g);
      for (let i = 0; i < 20; i++) briel.press({}, 1 / 60);
      // Still pressed in: walk out, as a player would, each way in turn for half a second.
      for (let k2 = 0; k2 < 4 && !free(p.x, p.z, p.feet, 0.2); k2++) {
        p.yaw = (k2 * Math.PI) / 2;
        for (let i = 0; i < 30; i++) briel.press({ moveY: 1 }, 1 / 60);
      }
      if (!free(p.x, p.z, p.feet, 0.2)) {
        const now = W.touching(p.x, p.z, p.feet + 0.5, p.feet + 1.8, 0.2);
        wedges.push({ x: +mx.toFixed(2), z: +mz.toFixed(2), trunk: [+t.x.toFixed(2), +t.z.toFixed(2)], with: hit?.mat ?? hit?.name ?? hit?.key ?? '', ended: [+p.x.toFixed(2), +p.feet.toFixed(2), +p.z.toFixed(2)], touching: now?.mat ?? now?.name ?? now?.key ?? '' });
      }
      break;
    }
  }
  put(keep.x, keep.z, keep.feet, keep.yaw);
  p.flying = keep.flying;
  const fallsIn = falls.filter((f) => f.inTrunk);
  return {
    count: through + fallsIn.length + wedges.length,
    line: `${through} of ${tested} trees walked through (real player ${realThrough} of ${real}; ${outside} sides left out, their start outside the edge); falls into a trunk ${fallsIn.length} of ${falls.length}; wedged ${wedges.length} of ${gaps} gaps`,
    worst: [...rows.map((r) => ({ ...r, what: 'walked through' })), ...fallsIn.map((f) => ({ ...f, what: 'fell into' })), ...wedges.map((w) => ({ ...w, what: 'wedged' }))],
    trunks: trunks.length,
    tested,
    outside,
    through,
    real,
    realThrough,
    falls,
    gaps,
    wedges,
  };
}

/** Walls, part one: sample targets [from, to) at body height; window.__A collects the samples with no block near. */
function wallSamples(from, to) {
  const { THREE, W, targets } = window.__c;
  const SKIP = /^sky$|water|football pitch|^grass$|football life|inst1\.2x1\.2x0\.5|inst1\.2x0\.5x1\.3/;
  window.__A ??= new Map();
  const wall = window.__A;
  const a = new THREE.Vector3(), b2 = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const m4 = new THREE.Matrix4(), mw = new THREE.Matrix4();
  const cellKey = (x, z) => (Math.floor(x) + 4096) * 8192 + (Math.floor(z) + 4096);
  let samples = 0;
  const point = (cls, x, y, z, nx, nz) => {
    samples++;
    const F = W.groundAt(x, z, y + 0.02, 0).y;
    const rel = y - F;
    if (rel < 0.55 || rel > 1.75) return;
    if (W.touching(x, z, F + 0.501, F + 1.8, 0.3)) return;
    let m = wall.get(cls);
    if (!m) wall.set(cls, (m = new Map()));
    const k = cellKey(x, z);
    if (!m.has(k)) m.set(k, [x, y, z, nx, nz, F]);
  };
  const tri = (cls) => {
    ab.subVectors(b2, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const area2 = n.length();
    if (area2 < 1e-8) return;
    n.divideScalar(area2);
    if (n.y > 0.5 || n.y < -0.5) return; // walls only: tops and undersides are the roofs' class
    const k = Math.min(40, Math.max(1, Math.ceil(Math.max(ab.length(), ac.length()) / 0.35)));
    if (k === 1) {
      point(cls, (a.x + b2.x + c.x) / 3, (a.y + b2.y + c.y) / 3, (a.z + b2.z + c.z) / 3, n.x, n.z);
      return;
    }
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
      const u = (i + 1 / 3) / k, v = (j + 1 / 3) / k;
      point(cls, a.x + ab.x * u + ac.x * v, a.y + ab.y * u + ac.y * v, a.z + ab.z * u + ac.z * v, n.x, n.z);
    }
  };
  for (const t of targets.slice(from, to)) {
    if (SKIP.test(t.cls)) continue;
    const g = t.o.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const count = idx ? idx.count : pos.count;
    // Only what reaches body height somewhere: the box's foot within 1.8 m of some floor (cheap cut for high meshes).
    const one = (mat) => {
      for (let f = 0; f + 2 < count; f += 3) {
        const i0 = idx ? idx.getX(f) : f, i1 = idx ? idx.getX(f + 1) : f + 1, i2 = idx ? idx.getX(f + 2) : f + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(mat);
        b2.fromBufferAttribute(pos, i1).applyMatrix4(mat);
        c.fromBufferAttribute(pos, i2).applyMatrix4(mat);
        tri(t.cls);
      }
    };
    if (t.inst) for (let k = 0; k < t.o.count; k++) {
      t.o.getMatrixAt(k, m4);
      mw.multiplyMatrices(t.o.matrixWorld, m4);
      one(mw);
    }
    else one(t.o.matrixWorld);
  }
  return samples;
}

/** Walls, part two: each sample walked at from both sides; the reachable passes below 1.4 m, by kind. */
function wallWalks() {
  const { W, walk, free, trunks } = window.__c;
  const R = window.__reach;
  const near = new Map();
  for (const t of trunks) {
    const k = `${Math.floor(t.x)},${Math.floor(t.z)}`;
    (near.get(k) ?? near.set(k, []).get(k)).push(t);
  }
  const byTrunk = (x, z, y, F) => {
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) {
      for (const t of near.get(`${Math.floor(x) + a},${Math.floor(z) + c}`) ?? []) if (Math.hypot(t.x - x, t.z - z) < 0.45 && y - F < t.h + 0.2) return true;
    }
    return false;
  };
  const kind = (cls, x, z, y, F) => {
    if (/^loose-/.test(cls)) return 'loose';
    if (window.__c.trunkShapes.has(cls) && byTrunk(x, z, y, F)) return 'trunk';
    if (/\|cut(tr)?(\||$)|mh_foliage|leaves|needle|sprig|\|hedge\|inst/.test(cls)) return 'greenery';
    if (/^open data\|(steel|alu)$/.test(cls)) return 'gutter';
    return window.__c.landmarks.has(cls) ? 'model' : 'generated';
  };
  const DIRS = [[1, 0], [0, 1], [0.7071, 0.7071], [0.7071, -0.7071]];
  const out = { generated: [], model: [], trunk: [], loose: 0, greenery: 0, gutter: 0 };
  for (const [cls, m] of window.__A) {
    for (const [x, y, z, nx, nz, F] of m.values()) {
      if (y - F > 1.4) continue;
      const l = Math.hypot(nx, nz);
      const dirs = l > 0.3 ? [[nx / l, nz / l]] : DIRS;
      let pass = false;
      for (const [dx, dz] of dirs) {
        for (const s of [1, -1]) {
          const sx = x + dx * s, sz = z + dz * s;
          const f0 = W.groundAt(sx, sz, F + 0.25, 0.5).y;
          if (Math.abs(f0 - F) > 0.5 || !free(sx, sz, f0)) continue;
          const e = walk(sx, sz, f0, -dx * s, -dz * s, 2.0);
          if ((e.x - sx) * -dx * s + (e.z - sz) * -dz * s > 1.5 && Math.abs(e.feet - F) < 1.0) pass = true;
          if (pass) break;
        }
        if (pass) break;
      }
      if (!pass || R.where(x, z, F) !== 1) continue;
      const k = kind(cls, x, z, y, F);
      if (typeof out[k] === 'number') out[k]++;
      else out[k].push({ x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), feet: +F.toFixed(2), cls });
    }
  }
  window.__A = null;
  const tally = (rows) => Object.entries(rows.reduce((s, r) => ((s[r.cls] = (s[r.cls] ?? 0) + 1), s), {})).sort((a, c) => c[1] - a[1]);
  return { generated: out.generated, model: out.model, trunk: out.trunk, allowed: { loose: out.loose, greenery: out.greenery, gutter: out.gutter }, byClass: { generated: tally(out.generated), model: tally(out.model) } };
}

/** Sides: block sides that stop a player with nothing drawn by them, where a player reaches (bare or off by 0.3 m). */
function sides() {
  const { W, cast } = window.__c;
  const R = window.__reach;
  const inside = (x, z, rings) => {
    let hit = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  const out = [];
  let n = 0;
  W.solids.forEach((s) => {
    if (s.off || s.mat === 'car') return; // parked cars: drawn only near, and 36 of 36 had their car (looked at by hand)
    const key = `${s.mat ?? '?'}${s.name ? '/' + s.name : ''}${s.lift ? '/d' : ''}`;
    for (const ring of s.rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j], [bx, bz] = ring[i];
      const ex = bx - ax, ez = bz - az;
      const len = Math.hypot(ex, ez);
      if (len < 0.05) continue;
      let nx = ez / len, nz = -ex / len;
      const k = Math.max(1, Math.round(len / 1.5));
      for (let q = 0; q < k; q++) {
        const t = (q + 0.5) / k;
        const px = ax + ex * t, pz = az + ez * t;
        if (inside(px + nx * 0.05, pz + nz * 0.05, s.rings)) {
          nx = -nx;
          nz = -nz;
        }
        const lo = W.lo(s, px, pz), hi = W.hi(s, px, pz);
        if (hi - lo < 0.3) continue;
        const qx = px + nx * 0.35, qz = pz + nz * 0.35;
        const base = W.baseAt(qx, qz);
        const F = W.groundAt(qx, qz, Math.max(lo, base) + 0.6, 0).y;
        if (hi <= F + 0.5 || lo >= F + 1.8) continue;
        if (W.touching(qx, qz, F + 0.5, F + 1.8, 0.05)) continue;
        if (R.where(qx, qz, F) !== 1) continue;
        n++;
        let best = null, cls = '';
        for (let y = Math.max(lo, F) + 0.1; y < Math.min(hi, F + 1.8); y += 0.2) {
          for (const h of cast(px + nx * 0.6, y, pz + nz * 0.6, -nx, 0, -nz, 1.8)) {
            const e = h.d - 0.6;
            if (best === null || Math.abs(e) < Math.abs(best)) {
              best = e;
              cls = h.cls;
            }
          }
          if (best !== null && Math.abs(best) < 0.3) break;
        }
        if (best === null || Math.abs(best) >= 0.3) out.push({ x: +px.toFixed(2), feet: +F.toFixed(2), z: +pz.toFixed(2), block: key, height: +(hi - F).toFixed(2), drawn: best === null ? null : +best.toFixed(2), cls, out: [+nx.toFixed(2), +nz.toFixed(2)] });
      }
    }
  });
  return { samples: n, rows: out };
}

/** Sides again from near: stand 7 m off each spot, wait, refresh the meshes near it, ray again. */
async function sidesNear(rows) {
  const { cast, scene, index, targets } = window.__c;
  const p = briel.player;
  const keep = { x: p.x, z: p.z, feet: p.feet, flying: p.flying };
  p.flying = true;
  const left = [];
  const done = new Map();
  for (const r of rows) {
    const key = `${Math.floor(r.x / 20)},${Math.floor(r.z / 20)}`;
    if (!done.has(key)) {
      briel.teleport(r.x + r.out[0] * 7, r.z + r.out[1] * 7, r.feet + 1.6, Math.atan2(r.out[0], r.out[1]), 0);
      await new Promise((ok) => setTimeout(ok, 1000));
      scene.updateMatrixWorld(true);
      // What is drawn near now and was not a target: the near-only meshes (their bounding spheres cleared).
      const known = new Set(targets.map((t) => t.o));
      const fresh = [];
      scene.traverse((o) => {
        if (!o.isMesh || known.has(o) || o.isSkinnedMesh || o.userData.ignoreRay || o.userData.vehicle || !o.geometry?.attributes?.position) return;
        for (let q = o; q; q = q.parent) if (!q.visible) return;
        o.geometry.boundingSphere = null;
        if (o.isInstancedMesh) o.boundingSphere = null; // the copies' sphere, kept from where they were drawn first
        const t = { o, cls: `near|${o.name || o.userData.material || ''}`, inst: !!o.isInstancedMesh };
        index(t);
        fresh.push(t);
      });
      done.set(key, fresh);
    }
    const list = done.get(key);
    let seen = false;
    for (let y = r.feet + 0.3; y < r.feet + Math.min(1.8, r.height); y += 0.2) {
      if (cast(r.x + r.out[0] * 0.6, y, r.z + r.out[1] * 0.6, -r.out[0], 0, -r.out[1], 1.8, null, list).some((h) => Math.abs(h.d - 0.6) < 0.3)) {
        seen = true;
        break;
      }
    }
    if (!seen) left.push(r);
  }
  briel.teleport(keep.x, keep.z, keep.feet, p.yaw, 0);
  p.flying = keep.flying;
  return { looked: done.size, rows: left };
}

/**
 * Roofs: per roof of the data, the highest drawn surface against the floor from above, every 1.5 m inside it. A floor
 * on air counts where it is a block's top or a roof's (the bare ground off by more is the ground's class); where only
 * the ground is drawn under such a floor the row is `bare`: a block a model stands for with nothing of the model there
 * (the models' outlines, not their roofs). The private homes (the bungalow, the end house at Molenhoek) are `own`.
 */
function roofs(list) {
  const { W, cast } = window.__c;
  const SKIP = /hedge\||steel|foliage|leaves|loose-|\|cut/;
  const end = briel.endHouse?.();
  const inside = (x, z, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  const out = [];
  const excused = [];
  for (const r of list) {
    const xs = r.p.map((q) => q[0]), zs = r.p.map((q) => q[1]);
    const box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    let sunk = 0, air = 0, bare = 0, n = 0, deep = 0, high = 0, at = null;
    for (let x = box[0] + 0.4; x < box[2]; x += 1.5) for (let z = box[1] + 0.4; z < box[3]; z += 1.5) {
      if (!inside(x, z, r.p)) continue;
      const g = W.groundAt(x, z, 1e6, 0);
      const floor = g.y;
      const top = cast(x, floor + 30, z, 0, -1, 0, 60, SKIP)[0];
      if (!top) continue;
      n++;
      const d = top.y - floor; // +: drawn over the floor (sunk in), -: the floor over what is drawn (on air)
      if (d > 0.5) {
        sunk++;
        if (d > deep) [deep, at] = [d, [x, z]];
      }
      // Excused, and said so on every run: a floor on a parked car (drawn only near the eye), the bare ground off the drawn
      // ground (the ground's class).
      if (d < -0.5 && g.mat === 'car') excused.push({ why: 'a parked car', x: +x.toFixed(1), z: +z.toFixed(1), off: +d.toFixed(2) });
      else if (d < -0.5 && floor <= W.baseAt(x, z) + 0.3) excused.push({ why: 'the bare ground', x: +x.toFixed(1), z: +z.toFixed(1), off: +d.toFixed(2) });
      if (d < -0.5 && floor > W.baseAt(x, z) + 0.3 && g.mat !== 'car') {
        air++;
        if (Math.abs(top.y - W.baseAt(x, z)) < 1.5) bare++; // the ground, a yard or a terrace: nothing of a building
        if (-d > high) high = -d;
      }
    }
    const cx = (box[0] + box[2]) / 2, cz = (box[1] + box[3]) / 2;
    const own = r.own || (end && [[cx, cz], ...r.p.map(([x, z]) => [x + (cx - x) * 0.3, z + (cz - z) * 0.3])].some(([x, z]) => end.contains(x, z)) ? 'end house' : '');
    if (sunk >= 3 || air >= 3) out.push({ x: +cx.toFixed(1), z: +cz.toFixed(1), set: r.set, lm: r.lm ?? '', own, samples: n, sunk, air, bare: sunk === 0 && air > 0 && bare === air, deepest: +deep.toFixed(2), highest: +high.toFixed(2), at: at && at.map((v) => +v.toFixed(1)) });
  }
  return { rows: out, excused };
}

/**
 * Roofs' narrow places, as the trees' gaps: a body put on a roof where something rises more than a metre within 0.6 m
 * (a wall, a higher roof, a chimney, a dormer) or in a valley (higher on two opposite sides), let settle, must stand
 * free on the roof and walk away one way or another. One spot per roof, at most `max`.
 */
function roofWedges(list, max) {
  const { W, cast } = window.__c;
  if (!W.roofs) return { tested: 0, steps: 0, wedges: [] }; // a build from before the roofs were solid
  const p = briel.player;
  const keep = { x: p.x, z: p.z, feet: p.feet, yaw: p.yaw, flying: p.flying };
  p.flying = false;
  const put = (x, z, feet, yaw = 0) => {
    p.vx = p.vy = p.vz = 0;
    briel.teleport(x, z, feet, yaw, 0);
  };
  const inside = (x, z, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  const topAt = (x, z) => W.groundAt(x, z, 1e6, 0).y;
  // Free: no block in the body's height within 0.2 m, its middle not under a roof's solid.
  const free = (x, z, feet) => W.touching(x, z, feet + 0.5, feet + 1.8, 0.2) === null && !W.roofs.blocks(x, z, feet, 0.5, 1.8);
  const settle = () => {
    for (let i = 0; i < 180 && (i < 20 || p.feet > p.ground.y + 0.01); i++) briel.press({}, 1 / 60);
  };
  const spots = [];
  for (const r of list) {
    if (spots.length >= max || r.own) continue;
    const xs = r.p.map((q) => q[0]), zs = r.p.map((q) => q[1]);
    let found = null;
    for (let x = Math.min(...xs) + 0.4; x < Math.max(...xs) && !found; x += 0.75) for (let z = Math.min(...zs) + 0.4; z < Math.max(...zs) && !found; z += 0.75) {
      if (!inside(x, z, r.p) || !W.roofs.sample(x, z)) continue;
      const t = W.roofs.top;
      const around = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => topAt(x + Math.cos((k * Math.PI) / 4) * 0.6, z + Math.sin((k * Math.PI) / 4) * 0.6) - t);
      const step = around.some((d) => d > 1.0);
      const valley = [0, 1, 2, 3].some((k) => around[k] > 0.3 && around[k + 4] > 0.3);
      if (step || valley) found = { x, z, t, kind: step ? 'step' : 'valley' };
    }
    if (found) spots.push(found);
  }
  const wedges = [];
  for (const s of spots) {
    put(s.x, s.z, s.t);
    settle(); // settled, or down from where it was pushed
    // Pressed in: walk out, each way in turn for half a second, until free.
    for (let k = 0; k < 4 && !free(p.x, p.z, p.feet); k++) {
      p.yaw = (k * Math.PI) / 2;
      for (let i = 0; i < 30; i++) briel.press({ moveY: 1 }, 1 / 60);
      settle();
    }
    const at = { x: p.x, z: p.z, feet: p.feet };
    // Away from it: one of four ways at least half a metre.
    let moved = 0;
    for (let k = 0; k < 4 && moved < 0.5; k++) {
      put(at.x, at.z, at.feet, (k * Math.PI) / 2);
      for (let i = 0; i < 30; i++) briel.press({ moveY: 1 }, 1 / 60);
      moved = Math.max(moved, Math.hypot(p.x - at.x, p.z - at.z));
    }
    // On what is drawn there: the first surface down from the head within half a metre of the feet.
    const under = cast(at.x, at.feet + 1.7, at.z, 0, -1, 0, 4, /hedge\||steel|foliage|leaves|loose-|\|cut/)[0];
    const onRoof = !!under && Math.abs(under.y - at.feet) < 0.5;
    if (!free(at.x, at.z, at.feet) || moved < 0.5 || !onRoof) wedges.push({ x: +s.x.toFixed(2), z: +s.z.toFixed(2), kind: s.kind, ended: [+at.x.toFixed(2), +at.feet.toFixed(2), +at.z.toFixed(2)], free: free(at.x, at.z, at.feet), moved: +moved.toFixed(2), onRoof });
  }
  put(keep.x, keep.z, keep.feet, keep.yaw);
  p.flying = keep.flying;
  return { tested: spots.length, steps: spots.filter((s) => s.kind === 'step').length, wedges };
}

/**
 * The walk-about: on every block a model stands for that its roof capped (World.capBlock), up to eight spots a body
 * stands on from above (the capped top or the roof over it), each walked from four ways for 2.5 s by the real player.
 * Counted: a step over 0.3 m in one frame (thrown), a walk that ends inside a block, a second or more inside one (stuck).
 */
function walkAbout() {
  const { W } = window.__c;
  const p = briel.player;
  const keep = { x: p.x, z: p.z, feet: p.feet, yaw: p.yaw, flying: p.flying };
  const inRing = (x, z, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  const inBlock = () => W.touching(p.x, p.z, p.feet + 0.55, p.feet + 1.75, 0) !== null;
  const out = { blocks: 0, starts: 0, walks: 0, thrown: 0, inside: 0, stuck: 0, biggest: 0, ex: [] };
  for (const s of W.solids) {
    if (s.cap === undefined || s.off) continue;
    out.blocks++;
    const pts = [];
    for (let x = s.minX + 0.2; x < s.maxX; x += 0.5) for (let z = s.minZ + 0.2; z < s.maxZ; z += 0.5) {
      if (inRing(x, z, s.rings[0])) pts.push([x, z, W.groundAt(x, z, 1e6, 0).y]);
    }
    const pick = pts.length <= 8 ? pts : Array.from({ length: 8 }, (_, k) => pts[Math.floor(((k + 0.5) * pts.length) / 8)]);
    for (const [x, z, top] of pick) {
      out.starts++;
      for (let k = 0; k < 4; k++) {
        p.vx = p.vy = p.vz = 0;
        p.flying = false;
        briel.teleport(x, z, top, (k * Math.PI) / 2, 0);
        out.walks++;
        let big = 0, run = 0, longest = 0, where = null;
        for (let f = 0; f < 150; f++) {
          const was = { x: p.x, z: p.z, feet: p.feet };
          briel.press({ moveY: 1 }, 1 / 60);
          const d = Math.hypot(p.x - was.x, p.z - was.z);
          if (d > big) [big, where] = [d, { from: [+was.x.toFixed(2), +was.feet.toFixed(2), +was.z.toFixed(2)], to: [+p.x.toFixed(2), +p.feet.toFixed(2), +p.z.toFixed(2)] }];
          run = inBlock() ? run + 1 : 0;
          longest = Math.max(longest, run);
        }
        const ended = inBlock();
        if (big > 0.3) out.thrown++;
        if (ended) out.inside++;
        if (longest >= 60) out.stuck++;
        out.biggest = Math.max(out.biggest, +big.toFixed(2));
        if ((big > 0.3 || ended || longest >= 60) && out.ex.length < 20) out.ex.push({ block: s.mat, start: [+x.toFixed(2), +top.toFixed(2), +z.toFixed(2)], way: k, step: +big.toFixed(2), ...where, framesInside: longest, ended });
      }
    }
  }
  briel.teleport(keep.x, keep.z, keep.feet, keep.yaw, 0);
  p.flying = keep.flying;
  return out;
}

/** Ground: a ray down every 4 m of the walkable map; gaps over 0.75 m and holes. */
function ground() {
  const { W, cast } = window.__c;
  const R = window.__reach;
  const SKIP = /hedge\||steel|foliage|leaves|loose-|fence|water|\|cut/;
  const bad = [];
  let n = 0;
  for (let i = 4; i < R.nx; i += 8) for (let j = 4; j < R.nz; j += 8) {
    const k = i * R.nz + j;
    if (R.state[k] !== 1) continue;
    n++;
    const x = R.x0 + (i + 0.5) * R.C, z = R.z0 + (j + 0.5) * R.C, f = R.feet[k];
    const h = cast(x, f + 1.2, z, 0, -1, 0, 7.2, SKIP)[0];
    const gap = h ? h.d - 1.2 : null;
    if (gap === null || Math.abs(gap) > 0.75) bad.push({ x: +x.toFixed(1), feet: +f.toFixed(2), z: +z.toFixed(1), gap: gap === null ? null : +gap.toFixed(2), cls: h?.cls ?? '', on: W.groundAt(x, z, f, 0.5).mat ?? W.groundAt(x, z, f, 0.5).name ?? '' });
  }
  return { n, rows: bad };
}

/** Spots: free for a body or a car, no trunk block within 0.6 m, the floor under each. */
function spots(list) {
  const { W } = window.__c;
  // A trunk's block within 0.3 m of the spot (its middle more than a body's width off).
  const trunkNear = (x, z) => {
    for (const s of W.near(x - 0.7, z - 0.7, x + 0.7, z + 0.7).map((i) => W.solids[i])) {
      if (s.off || s.name !== 'trunk') continue;
      const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
      if (Math.hypot(cx - x, cz - z) < 0.3 + (s.maxX - s.minX) / 2) return true;
    }
    return false;
  };
  return list.map((s) => {
    // A car stands on the ground and its paving (as main.ts teslaFits), a body on what is within a step of it.
    const feet = s.y !== undefined ? W.groundAt(s.x, s.z, s.y + 0.5, 0.5).y : s.car ? W.groundAt(s.x, s.z, W.baseAt(s.x, s.z) + 0.3, 0).y : W.groundAt(s.x, s.z, W.baseAt(s.x, s.z) + 0.6, 0.6).y;
    let ok = true, why = '';
    if (trunkNear(s.x, s.z)) [ok, why] = [false, 'a trunk within 0.3 m'];
    else if (s.car) {
      // Against the fixed blocks only: a parked car is a moving part of its own, standing there.
      const moving = W.moving;
      W.moving = new Map();
      if (!W.boxFree(s.x, s.z, s.yaw ?? 0, 2.4, 0.96, feet + 0.3, feet + 1.6)) {
        const at = W.touching(s.x, s.z, feet + 0.3, feet + 1.6, 2.4);
        [ok, why] = [false, `no room for a car (${at?.mat ?? ''}${at?.name ? '/' + at.name : ''})`];
      }
      W.moving = moving;
    } else if (s.body && W.touching(s.x, s.z, feet + 0.5, feet + 1.8, 0.25) !== null) [ok, why] = [false, 'no room for a body'];
    return { id: s.id, x: s.x, z: s.z, feet: +feet.toFixed(2), ok, why };
  });
}

/**
 * Drops: real parachute drops, hands off; where the feet end against the highest drawn surface there. A landing on the
 * ground with a roof over the head (under the eaves, a porch), the body free there, is `under`: that is a fine place.
 */
function drops(centres) {
  const { W, cast } = window.__c;
  const p = briel.player;
  const SKIP = /hedge\||steel|foliage|leaves|loose-|\|cut/;
  const rows = [];
  for (const [cx, cz] of centres) for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) {
    const x = cx + i * 7.3, z = cz + j * 6.1;
    briel.beginDrop({ x, z, yaw: 0, sx: x, sz: z });
    let n = 0;
    while (p.chute !== null && n++ < 6000) briel.press({}, 1 / 60);
    const top = cast(p.x, p.feet + 40, p.z, 0, -1, 0, 80, SKIP)[0];
    const off = top ? top.y - p.feet : null;
    const over = p.feet - W.baseAt(p.x, p.z);
    const free = W.touching(p.x, p.z, p.feet + 0.5, p.feet + 1.8, 0.2) === null && !W.roofBlocks?.(p.x, p.z, p.feet, 0.5, 1.8);
    const under = off !== null && off > 1.8 && over < 0.3 && free;
    rows.push({ x: +p.x.toFixed(2), feet: +p.feet.toFixed(2), z: +p.z.toFixed(2), over: +over.toFixed(2), off: off === null ? null : +off.toFixed(2), under, cls: top?.cls ?? '', on: p.ground.mat ?? p.ground.name ?? '' });
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------ the run

/** One class's line and its record. */
function record(name, count, line, worst, extra = {}) {
  results[name] = { count, strict: strict.has(name), line, worst: worst.slice(0, 3), ...extra };
  const mark = count > 0 && strict.has(name) ? 'FAIL' : count > 0 ? 'note' : 'ok  ';
  console.log(`${mark} ${name.padEnd(7)} ${String(count).padStart(6)}  ${line}`);
  for (const w of worst.slice(0, 3)) console.log(`             ${JSON.stringify(w)}`);
}

/** What a relaxed rule let pass: its count and its first rows, printed under the class. */
function excuse(line, rows) {
  console.log(`     excused: ${line}`);
  for (const w of rows.slice(0, 3)) console.log(`             ${JSON.stringify(w)}`);
}

/** The spots of the game that must stay free, from the shared files. */
function spotList() {
  const out = [];
  const add = (id, x, z, extra = {}) => Number.isFinite(x) && Number.isFinite(z) && out.push({ id, x, z, ...extra });
  read('shared/spawns.json').forEach((s, i) => add(`spawn:${i}:${s.name}`, s.x, s.z, { y: s.y, body: true }));
  for (const p of read('shared/places.json').places) {
    add(`place:${p.id}`, p.x, p.z, { body: true });
    if (p.car) add(`place-car:${p.id}`, p.car[0], p.car[1], { yaw: p.car[2], car: true });
  }
  for (const p of PORTALS) {
    add(`portal:${p.id}`, p.x, p.z);
    add(`portal-out:${p.id}`, p.out[0], p.out[1], { body: true });
    if (p.car) add(`portal-car:${p.id}`, p.car[0], p.car[1], { yaw: p.car[2], car: true });
  }
  for (const g of read('shared/gnomes.json').gnomes) add(`gnome:${g.id}`, g.x, g.z, g.y !== undefined ? { y: g.y } : {});
  for (const r of read('shared/routes.json').routes) {
    add(`gate:${r.id}`, r.gate[0], r.gate[1]);
    r.checkpoints.forEach((c, i) => add(`checkpoint:${r.id}:${i}`, c[0], c[1]));
  }
  for (const [id, x, z] of STALL_SPOTS) add(`stall:${id}`, x, z);
  for (const a of ARENAS) if (a.home) add(`zombies-home:${a.id}`, a.home[0], a.home[1], { body: true });
  read('shared/pickups.json').forEach((p, i) => add(`pickup:${i}:${p.w}`, p.x, p.z, { y: p.y }));
  for (const [id, k] of Object.entries(read('shared/bike.json').bikes)) add(`bike:${id}`, k.park.x, k.park.z, { y: k.park.y });
  for (const [id, c] of Object.entries(read('shared/car.json').cars)) add(`car:${id}`, c.park.x, c.park.z, { y: c.park.y, yaw: c.park.yaw, car: true });
  return out;
}

try {
  await startGame(b, o.url, { village: true });
  if (o.quality) await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)})`, false);
  await b.sleep(2000);
  // The models' roofs come a little a frame once play has begun (world/modelRoofs.ts): wait till they are all in.
  for (let last = -1, same = 0, i = 0; same < 4 && i < 240; i++) {
    const n = await b.evaluate('briel.world.roofs?.count ?? 0');
    same = n === last ? same + 1 : 0;
    last = n;
    await b.sleep(500);
  }
  const s = await run(setup);
  console.log(`${secs()}: ${s.targets} drawn meshes, ${s.trunks} drawn trunks (${s.conifers} conifers), ${s.solids} blocks; left out ${JSON.stringify(s.skipped)}`);
  const f = await run(flood);
  console.log(`${secs()}: ${f.km2} km2 reachable from ${f.seeds} street spots (${f.ms} ms)`);

  if (only.has('trees')) {
    const r = await run(trees, Math.max(1, Number(o.sample)));
    record('trees', r.count, r.line, r.worst, { rows: r.worst, trunks: r.trunks, tested: r.tested, through: r.through, real: r.real, realThrough: r.realThrough, falls: r.falls, gaps: r.gaps, wedges: r.wedges });
  }
  if (only.has('walls')) {
    const targets = await b.evaluate('window.__c.targets.length');
    let samples = 0;
    for (let i = 0; i < targets; i += 60) samples += await run(wallSamples, i, i + 60);
    const r = await run(wallWalks);
    const line = `${r.generated.length} generated, ${r.model.length} at hand-built models, ${r.trunk.length} drawn trunks (allowed: ${r.allowed.loose} loose, ${r.allowed.greenery} leaves and branches, ${r.allowed.gutter} gutters), ${samples} samples`;
    const rows = [...r.trunk.map((w) => ({ ...w, kind: 'trunk' })), ...r.generated.map((w) => ({ ...w, kind: 'generated' })), ...r.model.map((w) => ({ ...w, kind: 'model' }))];
    record('walls', r.generated.length + r.model.length + r.trunk.length, line, rows, { rows, byClass: r.byClass, allowed: r.allowed });
  }
  if (only.has('sides')) {
    const r = await run(sides);
    const near = await run(sidesNear, r.rows);
    const bare = near.rows.filter((w) => w.drawn === null).length;
    record('sides', near.rows.length, `${bare} with nothing drawn, ${near.rows.length - bare} drawn 0.3 m or more off; ${r.samples} samples, ${r.rows.length - near.rows.length} found again from near (${near.looked} spots)`, near.rows, { rows: near.rows });
  }
  if (only.has('roofs')) {
    const village = read('src/data/village.json');
    const ring = read('src/data/house_shell.json').surroundings;
    // The bungalow's roof (the ring's roof over a room) is a private home's: its own blocks, as the church's.
    const list = [...village.roofs.map((r) => ({ p: r.p, lm: r.lm, set: 'village' })), ...(ring.roofs ?? []).map((r) => ({ p: r.p, lm: r.lm, set: 'ring', own: r.ceiling ? 'bungalow' : '' }))];
    const { rows, excused } = await run(roofs, list);
    const OWN = /church|sparrenhof|tree_huts|play|town_board|private/;
    const own = rows.filter((r) => OWN.test(r.lm) || r.own);
    const bare = rows.filter((r) => !own.includes(r) && r.bare);
    const rest = rows.filter((r) => !own.includes(r) && !r.bare).sort((a, c) => Math.max(c.deepest, c.highest) - Math.max(a.deepest, a.highest));
    const sunk = rest.filter((r) => r.sunk >= 3).length, air = rest.filter((r) => r.air >= 3).length;
    const w = await run(roofWedges, list.map((r) => ({ ...r, own: r.own || OWN.test(r.lm ?? '') })), 300);
    const worst = [...rest, ...w.wedges.map((x) => ({ ...x, what: 'wedged' }))];
    record('roofs', rest.length + w.wedges.length, `${sunk} of ${list.length} roofs sunk into, ${air} with floors on air; wedged ${w.wedges.length} of ${w.tested} narrow spots (${w.steps} against something higher); apart: own blocks ${own.length}, blocks with nothing of their model drawn ${bare.length}`, worst, { rows: rest, own, bare, wedges: w.wedges, narrow: w.tested, excused });
    // What the relaxed rules let pass, every run, so a fault hiding behind one shows.
    for (const why of new Set(excused.map((e) => e.why))) {
      const these = excused.filter((e) => e.why === why);
      excuse(`${these.length} floor samples on air over ${why}`, these);
    }
    excuse(`${own.length} roofs apart as own blocks (the church, the private homes)`, own);
    excuse(`${bare.length} roofs apart: blocks a model stands for with nothing of it drawn over them`, bare);
  }
  if (only.has('about')) {
    const r = await run(walkAbout);
    record('about', r.thrown + r.inside + r.stuck, `${r.walks} walks of 2.5 s from ${r.starts} spots on ${r.blocks} capped blocks: ${r.thrown} with a step over 0.3 m in a frame (biggest ${r.biggest} m), ${r.inside} ended inside a block, ${r.stuck} stuck a second or more`, r.ex, r);
  }
  if (only.has('ground')) {
    const r = await run(ground);
    const holes = r.rows.filter((w) => w.gap === null);
    record('ground', holes.length, `${holes.length} holes, ${r.rows.length - holes.length} gaps over 0.75 m of ${r.n} spots (holes count)`, [...holes, ...r.rows.filter((w) => w.gap !== null).sort((a, c) => Math.abs(c.gap) - Math.abs(a.gap))], { rows: r.rows });
  }
  if (only.has('spots')) {
    const rows = await run(spots, spotList());
    let moved = [];
    if (o.compare) {
      const before = new Map((JSON.parse(readFileSync(o.compare, 'utf8')).spots?.all ?? []).map((r) => [r.id, r]));
      moved = rows.filter((r) => before.has(r.id) && Math.abs(before.get(r.id).feet - r.feet) > 0.05).map((r) => ({ ...r, ok: false, why: `floor ${before.get(r.id).feet} before` }));
    }
    const bad = [...rows.filter((r) => !r.ok), ...moved];
    record('spots', bad.length, `${bad.length} of ${rows.length} spots taken or moved${o.compare ? '' : ' (no --compare: floors not compared)'}`, bad, { rows: bad, all: rows });
  }
  if (only.has('drops')) {
    const rows = await run(drops, [[505, -790], [735, -725]]);
    const wrong = rows.filter((r) => !r.under && (r.off === null || Math.abs(r.off) > 0.5)).sort((a, c) => Math.abs(c.off ?? 99) - Math.abs(a.off ?? 99));
    const under = rows.filter((r) => r.under).length;
    record('drops', wrong.length, `${wrong.length} of ${rows.length} landings more than 0.5 m off the drawn surface (${wrong.filter((r) => r.off > 0.5).length} sunk, ${wrong.filter((r) => r.off < -0.5).length} on air); ${under} on the ground under eaves`, wrong, { rows: wrong, under });
    excuse(`${under} landings on the ground under eaves, free there`, rows.filter((r) => r.under));
  }

  if (o.shots) {
    for (const [name, r] of Object.entries(results)) {
      const w = r.worst?.[0];
      if (!w) continue;
      const feet = w.feet ?? 0;
      await b.evaluate(`(() => { briel.player.flying = true; briel.teleport(${w.x + 3.5}, ${w.z + 3.5}, ${feet + 1.2}, Math.atan2(3.5, 3.5), -0.15); })()`, false);
      await b.sleep(800);
      await b.screenshot(join(o.shots, `${name}.png`));
    }
  }
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(`page errors:\n${errors.slice(0, 10).join('\n')}`);
} finally {
  b.close();
}

const failed = Object.entries(results).filter(([, r]) => r.strict && r.count > 0).map(([n]) => n);
if (o.json) writeFileSync(o.json, JSON.stringify({ url: o.url, quality: o.quality, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), ...results }, null, 1));
console.log(`${secs()}: ${failed.length ? `FAIL ${failed.join(', ')}` : 'every strict class at zero'}${o.json ? `; every spot in ${o.json}` : ''}`);
process.exit(failed.length ? 1 : 0);
