// The homes' data in two parts: a public shell (committed) and a private inside (web/.private/, git-ignored,
// sealed by tools/private_data.mjs). private-src/tools/house_split.py writes both next to its unsplit house data and
// molenhoek_end_inside.json. This test holds no inside data: the first group checks the shell on its own, the
// second (skipped without web/.private/, as on a cloud clone or in CI) checks that shell plus inside give back
// today's data.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(WEB, 'src', 'data');
const PRIVATE = join(WEB, '.private');
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

const shell = read(join(DATA, 'house_shell.json'));
const endShell = read(join(DATA, 'molenhoek_end_shell.json'));
const insidePath = join(PRIVATE, 'house_inside.json');
const endInsidePath = join(PRIVATE, 'molenhoek_end_inside.json');
const havePrivate = existsSync(insidePath) && existsSync(endInsidePath);
// The whole data as it was before the split (house.json, molenhoek_end_inside.json) is kept in the private companion repository
// (private-src/out/, written by its tools): the checks that compare the parts with it run only where that is checked out.
const FULL = join(WEB, '..', 'private-src', 'out');
const fullHouse = join(FULL, 'house.json');
const fullEnd = join(FULL, 'molenhoek_end_inside.json');
const SKIP_FULL = havePrivate && existsSync(fullHouse) && existsSync(fullEnd) ? false : 'private-src/out/ or web/.private/ is absent: the comparison with the unsplit data needs both';
const SKIP = havePrivate ? false : 'web/.private/ is absent (cloud clone or CI): the shell + inside check needs the private files';

// Materials that only occur inside a home (tools/house_split.py INSIDE_MATERIALS). 'ceiling' is the slabs' material.
const INSIDE_MATERIALS = [
  'floor_wood', 'floor_bath', 'floor_tile', 'terrazzo', 'rust_tile', 'pink', 'pink_tile', 'oak', 'walnut',
  'veneer', 'terracotta', 'ceramic', 'brass', 'mirror', 'niche', 'black_glass', 'steel', 'stair', 'rail',
];
// The names the shell's blocks may carry: floors and roofs seen from outside, the garden's surfaces.
const SHELL_NAMES = new Set([
  'ground floor', '1st floor', '2nd floor', 'roof terrace', '1st floor roof, rear', '1st floor roof, front', '2nd floor roof',
  'Dakterras', 'outside stair to roof terrace', 'Veranda (old house)', 'Driveway (old house)', 'covered terrace', 'garden shed',
  'back terrace (uncovered)', 'path along the outbuilding', 'side path (right)', 'driveway', 'front path', 'stepping slab', 'planting',
]);
const EXTERIOR_PROPS = new Set(['fanlight']);
const END_SHELL_KEYS = new Set(['key', 'frame', 'centre', 'outline', 'levels', 'doors', 'panes', 'groundCuts', 'dip', 'lawn', 'plot']);

const ringArea = (r) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, z0] = r[i];
    const [x1, z1] = r[(i + 1) % r.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
};
/** Area and centroid of a block's outline (holes subtracted). */
function measure(p) {
  let area = 0, cx = 0, cz = 0;
  p.p.forEach((ring, k) => {
    const a = ringArea(ring);
    let mx = 0, mz = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[(i + 1) % ring.length];
      const c = x0 * z1 - x1 * z0;
      mx += (x0 + x1) * c;
      mz += (z0 + z1) * c;
    }
    const s = k === 0 ? 1 : -1; // holes count negative
    const A = Math.abs(a) * s;
    if (Math.abs(a) > 1e-12) {
      cx += (mx / (6 * a)) * A;
      cz += (mz / (6 * a)) * A;
    }
    area += A;
  });
  return { area, cx: area ? cx / area : 0, cz: area ? cz / area : 0 };
}
const strings = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
};
const stripNotes = (v) => {
  if (Array.isArray(v)) return v.map(stripNotes);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_note').map(([k, x]) => [k, stripNotes(x)]));
  return v;
};
/** [minX, minZ, maxX, maxZ] of the rings. */
const bounds = (rings) => {
  const pts = rings.flat();
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};
const canon = (v) => JSON.stringify(v);
const sortedJson = (list) => list.map(canon).sort();

// ---------------------------------------------------------------- the shell on its own
test('the main houses\' shell holds no inside', () => {
  assert.equal('rooms' in shell, false, 'no rooms');
  assert.equal('fixtures' in shell, false, 'no fixtures');
  assert.equal('source' in shell, false, 'no source note');
  assert.ok(shell.props.every((p) => EXTERIOR_PROPS.has(p.model)), 'props are the outside ones only');
  assert.ok(shell.doors.length > 0 && shell.doors.every((d) => d.panels.some((p) => 'outside' in p)), 'every door has an outside panel');
  const inside = new Set(INSIDE_MATERIALS);
  const bad = shell.prisms.filter((p) => inside.has(p.m));
  assert.equal(bad.length, 0, `${bad.length} blocks of an inside-only material, such as ${bad[0]?.m}`);
  const names = new Set(shell.prisms.filter((p) => p.n).map((p) => p.n));
  for (const n of names) assert.ok(SHELL_NAMES.has(n), `a block name that is not on the shell's list: ${n}`);
  assert.ok(shell.surroundings.roofs.every((r) => !('panels' in r)), 'the bungalow\'s roof panels are the inside\'s');
  assert.ok(shell.prisms.filter((p) => p.m === 'ceiling' || p.m === 'old_ceiling').every((p) => p.p.length === 1), 'slabs are solid in the shell (no stairwell)');
  assert.equal(canon(shell).includes('_note'), false, 'notes stay out of the shell');
  // The shell's numbers say nothing about the inside: panes 0..n-1, door glass from 3000 without a gap, neutral ids.
  const numbers = shell.prisms.filter((p) => p.m === 'glass').map((p) => p.glass).sort((a, b) => a - b);
  assert.deepEqual(numbers, numbers.map((_, i) => i), 'the shell\'s panes are numbered 0..n-1');
  const panes = shell.doors.flatMap((d) => d.panels.filter((p) => p.glass)).map((p) => p.glassNo);
  assert.deepEqual(panes, panes.map((_, i) => 3000 + i), 'the shell\'s door glass counts up from 3000');
  for (const d of shell.doors) {
    assert.match(d.id, /^(house|bungalow)-out-\d+$/);
    assert.ok(d.name === 'outside door' || d.name === 'sliding door', d.name);
  }
  for (const p of shell.prisms.filter((q) => q.k)) assert.match(p.k, /^(slab-[a-z]|chimney)$/);
});

test('the shell\'s outlines have no repeated point and no three points in line', () => {
  let checked = 0;
  for (const [i, p] of shell.prisms.entries()) {
    for (const ring of p.p) {
      checked++;
      for (let k = 0; k < ring.length; k++) {
        const a = ring[(k + ring.length - 1) % ring.length], b = ring[k], c = ring[(k + 1) % ring.length];
        assert.ok(a[0] !== b[0] || a[1] !== b[1], `block ${i} (${p.m}) repeats the point ${b}`);
        const dx = c[0] - a[0], dz = c[1] - a[1];
        const off = Math.abs(dx * (b[1] - a[1]) - dz * (b[0] - a[0])) / (Math.hypot(dx, dz) || 1);
        assert.ok(off >= (p.m === 'plaster' ? 0.00019 : 0.000049), `block ${i} (${p.m}) has the point ${b} in line with its neighbours`);
      }
    }
  }
  assert.ok(checked > 900);
});

test('the end house\'s shell holds the outside only', () => {
  for (const k of Object.keys(endShell)) assert.ok(END_SHELL_KEYS.has(k), `a key that is not on the shell's list: ${k}`);
  for (const k of ['frame', 'outline', 'groundCuts', 'panes', 'doors']) assert.ok(k in endShell, k);
  assert.ok(endShell.doors.length > 0 && endShell.doors.every((d) => d.panels.some((p) => 'outside' in p)), 'outside doors only');
  assert.deepEqual(endShell.doors.map((d) => d.id), ['mh-end-front', 'mh-end-terrace']);
  assert.equal(canon(endShell).includes('_source'), false);
});

// ---------------------------------------------------------------- shell + inside = today's data
test('house_shell.json + house_inside.json give the unsplit house data back', { skip: SKIP_FULL }, () => {
  const house = read(fullHouse);
  const inside = read(insidePath);
  const parts = [inside.house, inside.bungalow];
  // The inside's blocks that stand in for a shell block (a holed slab, the bungalow's room floors) replace it.
  const replaced = new Set(parts.flatMap((h) => h.replaces));
  assert.equal(replaced.size, 4, 'two slabs, a roof-space slab and the bungalow\'s ground slab');
  for (const k of replaced) assert.equal(shell.prisms.filter((p) => p.k === k).length, 1, `one shell block for ${k}`);
  assert.ok(shell.prisms.filter((p) => p.k && p.m.endsWith('ceiling')).every((p) => p.p.length === 1), 'slabs are solid in the shell');
  const merged = [...shell.prisms.filter((p) => !replaced.has(p.k)), ...parts.flatMap((h) => h.prisms)];

  // Blocks: the same set by material, heights, extra keys (names, matte, ...), outline area and centroid, and every
  // pane under the number the map gives it. The main house's plaster is cut differently, so it is compared as
  // geometry per pair of heights below.
  const map = inside.map;
  const extras = (p) => canon(Object.fromEntries(Object.entries(p).filter(([k]) => !['p', 'glass', 'k'].includes(k))));
  const buckets = new Map();
  for (const p of merged.filter((q) => q.m !== 'plaster')) {
    const k = extras(p);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ ...measure(p), glass: p.glass });
  }
  let matched = 0;
  for (const [i, p] of house.prisms.entries()) {
    if (p.m === 'plaster') continue;
    const me = measure(p);
    const list = buckets.get(extras(p)) ?? [];
    const at = list.findIndex((q) => Math.abs(q.area - me.area) <= 1e-4 && Math.hypot(q.cx - me.cx, q.cz - me.cz) <= 0.01
      && (p.m !== 'glass' || q.glass === map.glass[i]));
    assert.ok(at >= 0, `block ${i} (${p.m}, ${p.y0} to ${p.y1}) has no twin${p.m === 'glass' ? ' with its glass number' : ''}`);
    list.splice(at, 1);
    matched++;
  }
  assert.equal([...buckets.values()].reduce((n, l) => n + l.length, 0), 0, 'blocks that house.json does not have');
  assert.ok(matched > 1000, `${matched} blocks`);
  const glassOld = house.prisms.flatMap((p, i) => (p.m === 'glass' ? [i] : []));
  assert.deepEqual(Object.keys(map.glass).map(Number).sort((a, b) => a - b), glassOld, 'every pane is in the map');
  assert.equal(new Set(Object.values(map.glass)).size, glassOld.length, 'no two panes share a number');

  // The plaster: per pair of heights the same points covered (on a 3 cm grid), but for a rounding of 2 mm along the
  // cut. (House.json's blocks overlap each other here and there, so their areas cannot simply be added.)
  const plaster = (list) => {
    const out = new Map();
    for (const p of list.filter((q) => q.m === 'plaster')) {
      const k = `${p.y0}|${p.y1}`;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(p);
    }
    return out;
  };
  const want = plaster(house.prisms);
  const got = plaster(merged);
  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), 'plaster at the same heights');
  for (const [k, list] of want) {
    const all = [...list, ...got.get(k)];
    const xs = all.flatMap((p) => p.p[0].map((q) => q[0])), zs = all.flatMap((p) => p.p[0].map((q) => q[1]));
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.03) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.03) {
        const a = list.some((p) => inPoly(x, z, p.p)), b = got.get(k).some((p) => inPoly(x, z, p.p));
        if (a !== b) assert.ok(Math.min(...all.map((p) => edgeDistance(x, z, p.p))) <= 0.002, `plaster ${k} differs at ${x.toFixed(2)}, ${z.toFixed(2)}`);
      }
    }
  }

  // Doors: the same doors under their new ids, and the door glass under the numbers the map gives it.
  const doors = new Map([...shell.doors, ...parts.flatMap((h) => h.doors)].map((d) => [d.id, d]));
  assert.equal(doors.size, house.doors.length);
  let next = 3000;
  for (const d of house.doors) {
    const m = doors.get(map.doors[d.id] ?? d.id);
    assert.ok(m, d.id);
    const panels = m.panels.map(({ glassNo, ...rest }) => rest);
    const { id, name, ...rest } = d;
    assert.deepEqual({ ...m, id, name, panels }, d, d.id);
    d.panels.forEach((p, k) => {
      if (p.glass) assert.equal(m.panels[k].glassNo, map.doorGlass[next++], `${d.id} glass`);
      else assert.equal('glassNo' in m.panels[k], false);
    });
  }
  assert.equal(Object.keys(map.doorGlass).length, next - 3000);
  assert.deepEqual(inside.house.rooms, house.rooms);
  assert.deepEqual(sortedJson([...shell.props, ...parts.flatMap((h) => h.props)]), sortedJson(house.props));
  assert.deepEqual(sortedJson(parts.flatMap((h) => h.fixtures)), sortedJson(house.fixtures));

  // The rest of house.json is the shell's, without its notes; the bungalow's roof panels come back from the inside.
  const roofs = structuredClone(shell.surroundings.roofs);
  for (const { roof, panels } of inside.bungalow.roofPanels) roofs[roof].panels = panels;
  assert.deepEqual({ ...stripNotes(shell.surroundings), roofs }, stripNotes(house.surroundings));
  for (const k of ['levels', 'ground', 'spawn', 'sun', 'dips', 'groundCuts']) assert.deepEqual(shell[k], stripNotes(house[k]), k);
  assert.deepEqual(Object.keys(shell).sort(), Object.keys(house).filter((k) => !['source', 'rooms', 'fixtures'].includes(k)).sort());
});

// Whether (x, z) lies in the polygon [outer, ...holes], and how far it is from its outline.
const inPoly = (x, z, poly) => {
  let inside = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
};
const edgeDistance = (x, z, poly) => {
  let best = Infinity;
  for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
  }
  return best;
};

test('no part of an inner wall stays in the shell', { skip: SKIP }, () => {
  const inside = read(insidePath);
  // Slabs and roofs lie at the levels' edges, panes and their frames stand in their openings (a few centimetres in
  // front of a thin wall's face). Everything else, of any material, may not overlap the inner face shrunk by 2 cm.
  const OTHER = new Set(['ceiling', 'old_ceiling', 'roof', 'glass', 'alu_out', 'alu_in', 'alu', 'old_frame']);
  let checked = 0;
  for (const home of [inside.house, inside.bungalow]) {
    assert.ok(home.innerFace.length > 0);
    for (const level of home.innerFace) {
      const [fx0, fz0, fx1, fz1] = bounds(level.p.flat());
      for (const p of shell.prisms) {
        const bungalow = p.p[0][0][0] > 50;
        if (bungalow !== (home === inside.bungalow) || OTHER.has(p.m)) continue;
        if (p.k === 'chimney') continue; // it rises through the roof and stays in the shell
        if (p.y1 <= level.y0 + 0.05 || p.y0 >= level.y1 - 0.05) continue; // another level
        const [x0, z0, x1, z1] = bounds(p.p);
        if (x1 < fx0 || x0 > fx1 || z1 < fz0 || z0 > fz1) continue;
        checked++;
        let area = 0;
        for (let x = Math.max(x0, fx0); x <= Math.min(x1, fx1); x += 0.01) {
          for (let z = Math.max(z0, fz0); z <= Math.min(z1, fz1); z += 0.01) {
            if (inPoly(x, z, p.p) && level.p.some((poly) => inPoly(x, z, poly) && edgeDistance(x, z, poly) > 0.02)) area += 1e-4;
          }
        }
        assert.ok(area < 5e-4, `a shell block (${p.m}, ${p.y0} to ${p.y1}) covers ${area.toFixed(4)} m2 of the space inside the outer walls`);
      }
    }
  }
  assert.ok(checked > 150, `${checked} blocks checked`);
});

test('the inner face holds every room and the lining has no block edge at an inner wall', { skip: SKIP }, () => {
  const inside = read(insidePath);
  const faces = new Map(inside.house.innerFace.map((f) => [f.id, f]));
  // Every room's outline lies within the face (so the face cannot include a bay or leave a room out).
  for (const room of inside.house.rooms) {
    const face = faces.get(room.level);
    const ring = room.p[0] ?? [];
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      for (let t = 0; t < 1; t += 0.05) {
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        assert.ok(face.p.some((poly) => inPoly(x, z, poly) || edgeDistance(x, z, poly) <= 0.03), `${room.level} room outline leaves the inner face at ${x.toFixed(2)}, ${z.toFixed(2)}`);
      }
    }
  }
  // A lining outline has a point on the face only at the face's own corners and beside an opening.
  // An opening is a line along the wall (a pane's long side, a door leaf from a to b). A point is beside it when it
  // lies within 5 cm of the line's end, along the wall, and within a wall's thickness of it across.
  const lines = [
    ...shell.prisms.filter((p) => p.m === 'glass').map((p) => {
      const r = p.p[0];
      let best = [r[0], r[1]];
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1])) best = [a, b];
      }
      const [a, b] = best, u = [(b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]), (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1])];
      const t = r.map(([x, z]) => (x - a[0]) * u[0] + (z - a[1]) * u[1]);
      const lo = Math.min(...t), hi = Math.max(...t);
      return [[a[0] + u[0] * lo, a[1] + u[1] * lo], [a[0] + u[0] * hi, a[1] + u[1] * hi]];
    }),
    ...shell.doors.flatMap((d) => d.panels.map((p) => [p.a, p.b])),
  ];
  const near = (x, z, line, along) => {
    const [a, b] = line, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t = ((x - a[0]) * (b[0] - a[0]) + (z - a[1]) * (b[1] - a[1])) / L;
    const s = Math.abs(((x - a[0]) * (b[1] - a[1]) - (z - a[1]) * (b[0] - a[0])) / L);
    return s < 0.6 && (Math.abs(t) < along || Math.abs(t - L) < along);
  };
  // Where the lining meets the brick, the brick's own corner is there too.
  const brick = shell.prisms.filter((p) => p.m === 'brick' || p.m === 'cladding' || p.m === 'claustra');
  let onFace = 0;
  const loose = [];
  for (const p of shell.prisms.filter((q) => q.m === 'plaster')) {
    const face = [...faces.values()].find((f) => p.y0 >= f.y0 - 0.05 && p.y0 < f.y1);
    if (!face) continue;
    for (const [x, z] of p.p.flat()) {
      if (!face.p.some((poly) => edgeDistance(x, z, poly) < 0.002)) continue;
      onFace++;
      const corner = face.p.some((poly) => poly.some((ring) => ring.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < 0.15))); // at a corner, or beside it (a chamfer); the corners themselves are checked below
      const beside = lines.some((l) => near(x, z, l, 0.05));
      const seam = brick.some((q) => edgeDistance(x, z, q.p) < 0.002);
      if (!(corner || beside || seam)) loose.push(`${p.y0}-${p.y1} at ${x.toFixed(3)}, ${z.toFixed(3)}`);
    }
  }
  assert.deepEqual(loose, [], 'lining blocks with an edge point on the inner face that is no corner, opening or brick seam');
  assert.ok(onFace > 20, `${onFace} points on the face`);

  // A corner of the face may not mark the end of an inside wall (a wedge, a pier), unless a brick corner or an
  // opening lies within 5 cm of it.
  // An inside wall's end is where a piece of the inside's plaster has a short edge (8 to 22 cm: the wall's thickness)
  // on the face and goes on into the room from it.
  const brickCorners = brick.flatMap((p) => p.p.flat());
  const marks = [];
  const lining = shell.prisms.filter((p) => p.m === 'plaster' || p.m === 'old_plaster');
  let wallEnds = 0;
  for (const home of [inside.house, inside.bungalow]) {
    for (const level of home.innerFace) {
      const onFace = (x, z) => level.p.some((poly) => edgeDistance(x, z, poly) < 0.002);
      for (const p of home.prisms.filter((q) => (q.m === 'plaster' || q.m === 'old_plaster') && q.y1 > level.y0 + 0.3 && q.y0 < level.y1 - 0.3)) {
        for (const ring of p.p) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (len < 0.08 || len > 0.22 || !onFace(...a) || !onFace(...b)) continue;
            const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
            const into = [[mx + nx * 0.15, mz + nz * 0.15], [mx - nx * 0.15, mz - nz * 0.15]].find(([x, z]) => level.p.some((poly) => inPoly(x, z, poly)));
            if (!into || !inPoly(into[0], into[1], p.p)) continue;
            wallEnds++;
            for (const [ex, ez] of [a, b]) {
              // No corner of the face there, and no point of the lining either.
              const explained = brickCorners.some(([bx, bz]) => Math.hypot(bx - ex, bz - ez) < 0.05) || lines.some((l) => near(ex, ez, l, 0.05));
              if (explained) continue;
              if (level.p.flat().some(([cx, cz]) => Math.hypot(cx - ex, cz - ez) < 0.02)) marks.push(`${level.id} face corner at ${ex}, ${ez}`);
              if (lining.some((q) => q.p.flat().some(([sx, sz]) => Math.hypot(sx - ex, sz - ez) < 0.002))) marks.push(`${level.id} lining point at ${ex}, ${ez}`);
            }
          }
        }
      }
    }
  }
  assert.ok(wallEnds > 10, `${wallEnds} wall ends found`);
  assert.deepEqual(marks, [], 'the end of an inside wall shows as a corner of the face or a point of the lining');
});

test('the lining and the inside meet without a gap where an inner wall ends at the face', { skip: SKIP_FULL }, () => {
  const house = read(fullHouse);
  const inside = read(insidePath);
  const pieces = [...shell.prisms, ...inside.house.prisms].filter((p) => p.m === 'plaster');
  let junctions = 0;
  const gaps = [];
  for (const level of inside.house.innerFace) {
    const wall = (p) => p.m === 'plaster' && p.y0 >= level.y0 - 0.05 && p.y0 < level.y1;
    for (const p of inside.house.prisms.filter(wall)) {
      for (const [vx, vz] of p.p.flat()) {
        if (!level.p.some((poly) => edgeDistance(vx, vz, poly) < 0.002)) continue;
        junctions++;
        // A 6 cm square round the end, on a 2 mm grid: whatever house.json's plaster covers, the two parts cover.
        for (let x = vx - 0.03; x <= vx + 0.03; x += 0.002) {
          for (let z = vz - 0.03; z <= vz + 0.03; z += 0.002) {
            const was = house.prisms.some((q) => wall(q) && q.y0 === p.y0 && q.y1 === p.y1 && inPoly(x, z, q.p));
            if (!was) continue;
            const now = pieces.some((q) => q.y0 === p.y0 && q.y1 === p.y1 && inPoly(x, z, q.p));
            if (!now && !pieces.some((q) => q.y0 === p.y0 && q.y1 === p.y1 && edgeDistance(x, z, q.p) < 0.0003)) gaps.push(`${level.id} ${p.y0}-${p.y1} at ${x.toFixed(3)}, ${z.toFixed(3)}`);
          }
        }
      }
    }
  }
  assert.ok(junctions > 20, `${junctions} places checked`);
  assert.deepEqual(gaps.slice(0, 8), [], `${gaps.length} points that the lining and the inside both leave open`);
});

test('the shell holds none of the inside\'s names or ids', { skip: SKIP }, () => {
  const inside = read(insidePath);
  const names = new Set();
  const ids = new Set();
  for (const h of [inside.house, inside.bungalow]) {
    h.prisms.forEach((p) => p.n && !p.k && names.add(p.n)); // a holed slab keeps its public name
    (h.rooms ?? []).forEach((r) => names.add(r.name));
    h.doors.forEach((d) => ids.add(d.id));
  }
  const all = new Set(strings(shell));
  for (const n of names) assert.equal(all.has(n), false, `an inside name in the shell: ${n}`);
  for (const id of ids) assert.equal(all.has(id), false, `an inside door in the shell: ${id}`);
  assert.ok(names.size > 10 && ids.size > 10);
});

test('molenhoek_end_shell.json + the private inside give the unsplit end house data back', { skip: SKIP_FULL }, () => {
  const whole = read(fullEnd);
  const inside = read(endInsidePath);
  const merged = { ...inside, ...endShell, doors: [...endShell.doors, ...inside.doors] };
  assert.deepEqual(Object.keys(merged).sort(), Object.keys(whole).sort());
  for (const k of Object.keys(whole)) assert.deepEqual(merged[k], whole[k], k);
  // The shell and the inside share nothing but the key and the door list (each has its own doors).
  const shared = Object.keys(endShell).filter((k) => k in inside && k !== 'key' && k !== 'doors');
  assert.deepEqual(shared, []);
  // Door glass is numbered in the order of the doors: the outside doors come first, and no inside door has glass.
  assert.ok(inside.doors.every((d) => d.panels.every((p) => !p.glass)));
  const names = new Set(strings([inside.rooms, inside.prisms.map((p) => p.n)]));
  const all = new Set(strings(endShell));
  for (const n of names) assert.equal(all.has(n), false, `an inside name in the end house's shell: ${n}`);
});
