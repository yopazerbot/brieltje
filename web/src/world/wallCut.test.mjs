import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from 'three';

// The modules import each other without extensions, as Vite has them: add .ts here.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.(m?js|ts|json)$/.test(specifier)) specifier += '.ts';
    return next(specifier, context);
  },
});
const { Houses } = await import('./houseKeys.ts');
const { planBases, planReveals, cutAt } = await import('./housePlan.ts');
const { cutWall, faceShapes } = await import('./wallCut.ts');
const { makeTerrain } = await import('../../shared/terrain.mjs');

const read = (file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const shell = read('../data/house_shell.json');
const terrain = makeTerrain(read('../../shared/terrain.json'));
const groundAt = (x, z) => shell.ground + terrain.height(x, z);
const sets = { village: read('../data/village.json'), ring: shell.surroundings };

/** A wall block's geometry as world/houseMeshes.ts `prismGeometry` makes it (and world/houseTrim.ts `bandedWalls` cuts it), with a colour and render byte. */
function wallGeometry(p, base) {
  const ring = base ? base.ring : p.p[0];
  const shape = new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const hole of p.p.slice(1)) shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: p.y1 - p.y0, steps: base ? 2 : 1, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, p.y0, 0);
  g.clearGroups();
  const pos = g.attributes.position;
  if (base) {
    const mid = p.y0 + (p.y1 - p.y0) / 2;
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i) - mid) < 1e-3) pos.setY(i, cutAt(base, groundAt(pos.getX(i), pos.getZ(i))));
  }
  const colours = new Uint8Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) colours.set(pos.getY(i) < p.y0 + 0.01 ? [100, 60, 50] : [200, 120, 100], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3, true));
  g.setAttribute('facade', new THREE.BufferAttribute(new Uint8Array(pos.count), 1, true));
  return g;
}

/** The area of a geometry's triangles that lie on a face (its plane, along it), facing out. */
function faceArea(g, f) {
  const pos = g.attributes.position;
  const [nx, nz] = f.n;
  const [dx, dz] = f.d;
  const O = f.points[0];
  const end = f.points[f.points.length - 1].s;
  const along = (v) => (v.x - O.x) * dx + (v.z - O.z) * dz;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let sum = 0;
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    if ([a, b, c].some((v) => Math.abs((v.x - O.x) * nx + (v.z - O.z) * nz) > 0.005 || along(v) < -0.002 || along(v) > end + 0.002)) continue;
    const cross = b.clone().sub(a).cross(c.clone().sub(a));
    if (cross.x * nx + cross.z * nz > 0) sum += cross.length() / 2;
  }
  return sum;
}

test('a face is cut round its holes: what is left plus the holes is the face', () => {
  for (const [name, set] of Object.entries(sets)) {
    const prisms = set.prisms ?? [];
    const houses = new Houses(prisms);
    const bases = planBases(prisms, set.openings ?? [], houses, groundAt);
    const plan = planReveals(set.openings ?? [], houses, bases, groundAt);
    let faces = 0;
    const missed = [];
    for (const [p, list] of plan.faces) {
      const g = wallGeometry(p, bases.get(p));
      const before = list.map((f) => faceArea(g, f));
      const cut = cutWall(g, list, missed);
      list.forEach((f, k) => {
        faces++;
        const holes = f.holes.reduce((s, h) => s + (h.s1 - h.s0) * (h.y1 - h.y0), 0);
        const after = faceArea(cut, f);
        // The back of each hole lies behind the face; the streaks are part of it.
        assert.ok(Math.abs(after + holes - before[k]) < 1e-3 * before[k] + 1e-3, `${name}: face at (${f.points[0].x.toFixed(1)}, ${f.points[0].z.toFixed(1)}) ${before[k].toFixed(3)} m² before, ${after.toFixed(3)} + ${holes.toFixed(3)} after`);
      });
      cut.dispose();
    }
    assert.deepEqual(missed.map((f) => `${f.points[0].x.toFixed(1)}, ${f.points[0].z.toFixed(1)}`), [], `${name}: faces not found in their walls`);
    assert.ok(faces > (name === 'village' ? 3000 : 400), `${name}: ${faces} faces cut`);
  }
});

test('no triangle of a cut face lies in a hole, and every streak darkens only inside it', () => {
  for (const set of Object.values(sets)) {
    const prisms = set.prisms ?? [];
    const houses = new Houses(prisms);
    const bases = planBases(prisms, set.openings ?? [], houses, groundAt);
    const plan = planReveals(set.openings ?? [], houses, bases, groundAt);
    for (const list of plan.faces.values()) {
      for (const f of list) {
        for (const tri of faceShapes(f).flat()) {
          const s = (tri[0].s + tri[1].s + tri[2].s) / 3;
          const y = (tri[0].y + tri[1].y + tri[2].y) / 3;
          for (const h of f.holes) assert.ok(!(s > h.s0 && s < h.s1 && y > h.y0 && y < h.y1), `a triangle in a hole at s ${s.toFixed(2)}, y ${y.toFixed(2)}`);
          for (const c of tri) if (c.dark > 0) assert.ok(c.streak && f.holes.some((h) => h.streaks.some((k) => Math.abs(c.s - k.s) <= k.half && c.y <= k.top && c.y >= k.bottom)), 'a dark corner outside its streak');
        }
      }
    }
  }
});
