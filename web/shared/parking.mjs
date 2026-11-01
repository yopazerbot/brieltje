// Where a placed car may stand (the planner's Teslas: src/ui/planner.ts, src/main.ts and
// server/game.mjs): a car's outline on the plan, points spread over it, whether two outlines
// overlap, whether a point is indoors, and (for the server) whether an outline is clear of the
// house data's blocks. Plain functions, no three.js, shared by the page and the server so both judge
// a spot the same way. A car's heading is the game's yaw: nose along -z, turned by yaw (as in
// src/world/car.ts).

/** The four corners of a rectangle: its middle, heading, half length and half width. */
export function boxCorners(cx, cz, yaw, halfL, halfW) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [cx + fx * halfL * a - fz * halfW * b, cz + fz * halfL * a + fx * halfW * b]);
}

/** Points over a rectangle at most `step` m apart, its edges included, `inset` m in from its sides. */
export function boxPoints(cx, cz, yaw, halfL, halfW, step = 0.5, inset = 0) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const l = Math.max(0, halfL - inset);
  const w = Math.max(0, halfW - inset);
  const nl = Math.max(1, Math.ceil((2 * l) / step));
  const nw = Math.max(1, Math.ceil((2 * w) / step));
  const out = [];
  for (let i = 0; i <= nl; i++) {
    for (let j = 0; j <= nw; j++) {
      const a = -l + (2 * l * i) / nl;
      const b = -w + (2 * w * j) / nw;
      out.push([cx + fx * a - fz * b, cz + fz * a + fx * b]);
    }
  }
  return out;
}

/** Whether two rectangles ({ x, z, yaw, halfL, halfW }) overlap or come within `gap` m of each other (separating axes). */
export function boxesOverlap(p, q, gap = 0) {
  const cp = boxCorners(p.x, p.z, p.yaw, p.halfL, p.halfW);
  const cq = boxCorners(q.x, q.z, q.yaw, q.halfL, q.halfW);
  for (const yaw of [p.yaw, q.yaw]) {
    for (const [ax, az] of [[-Math.sin(yaw), -Math.cos(yaw)], [Math.cos(yaw), -Math.sin(yaw)]]) {
      const a = cp.map(([x, z]) => x * ax + z * az);
      const b = cq.map(([x, z]) => x * ax + z * az);
      if (Math.max(...a) + gap <= Math.min(...b) || Math.max(...b) + gap <= Math.min(...a)) return false;
    }
  }
  return true;
}

/** How far a point is from a rectangle's sides ({ x, z, yaw, halfL, halfW }), 0 inside it. */
export function boxDistance(box, x, z) {
  const fx = -Math.sin(box.yaw);
  const fz = -Math.cos(box.yaw);
  const dx = x - box.x;
  const dz = z - box.z;
  return Math.hypot(Math.max(0, Math.abs(dx * fx + dz * fz) - box.halfL), Math.max(0, Math.abs(-dx * fz + dz * fx) - box.halfW));
}

/**
 * Whether a car's rectangle keeps the portals (shared/portals.mjs) free: off each pad (`reach` m round
 * its middle, and a little more), off the spot where you come out on foot, and off the one where a
 * car comes out.
 */
export function clearOfPortals(box, portals, reach) {
  return portals.every((p) => boxDistance(box, p.x, p.z) > reach + 0.3 && boxDistance(box, p.out[0], p.out[1]) > 0.8
    && !boxesOverlap(box, { x: p.car[0], z: p.car[1], yaw: p.car[2], halfL: 2.45, halfW: 1 }));
}

/** Even-odd test of a point against an outline. */
function inside(x, z, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Whether segments a-b and c-d cross. */
function crosses(a, b, c, d) {
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

/** Metres: the side of a square of the grid that finds the blocks near a spot (as in src/world/collision.ts). */
const CELL = 16;

/**
 * The house data's blocks (`prisms`: walls, hedges, fences, the neighbours' and the village's
 * houses) made ready for one question: whether a rectangle on the plan is clear of all of them
 * between heights y0 and y1. The same test as the page's (World.boxFree in src/world/collision.ts):
 * a corner inside a block, a block's corner inside the rectangle, or their sides crossing. A block on
 * the relief (`d`) follows the ground, `height(x, z)`, at the rectangle's middle. The blocks are
 * sorted into CELL-metre squares, so a question looks only at the ones near it.
 */
export function makeSolids(prisms, height) {
  const solids = [];
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  for (const p of prisms) {
    const xs = p.p[0].map((v) => v[0]);
    const zs = p.p[0].map((v) => v[1]);
    const s = { y0: p.y0, y1: p.y1, lift: !!p.d, rings: p.p, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    const n = solids.push(s) - 1;
    for (let i = Math.floor(s.minX / CELL); i <= Math.floor(s.maxX / CELL); i++) {
      for (let j = Math.floor(s.minZ / CELL); j <= Math.floor(s.maxZ / CELL); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(n);
      }
    }
  }
  const inRings = (x, z, rings) => rings.reduce((hit, ring) => (inside(x, z, ring) ? !hit : hit), false);
  return {
    boxFree(cx, cz, yaw, halfL, halfW, y0, y1) {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const box = boxCorners(cx, cz, yaw, halfL, halfW);
      const xs = box.map((v) => v[0]);
      const zs = box.map((v) => v[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const inBox = (x, z) => Math.abs((x - cx) * fx + (z - cz) * fz) <= halfL && Math.abs(-(x - cx) * fz + (z - cz) * fx) <= halfW;
      const lift = height(cx, cz);
      const seen = new Set();
      for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) {
        for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) {
          for (const n of grid.get(key(i, j)) ?? []) {
            if (seen.has(n)) continue;
            seen.add(n);
            const s = solids[n];
            if (s.maxX < minX || s.minX > maxX || s.maxZ < minZ || s.minZ > maxZ) continue;
            if (s.y1 + (s.lift ? lift : 0) <= y0 || s.y0 + (s.lift ? lift : 0) >= y1) continue;
            if (box.some(([x, z]) => inRings(x, z, s.rings))) return false;
            for (const ring of s.rings) {
              for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
                if (inBox(ring[a][0], ring[a][1])) return false;
                for (let k = 0, l = 3; k < 4; l = k++) if (crosses(ring[b], ring[a], box[l], box[k])) return false;
              }
            }
          }
        }
      }
      return true;
    },
  };
}

/**
 * Whether a point is indoors: over a floor of the house or the bungalow. Those are the house data's
 * blocks (`prisms`) named after a room (`rooms`), a floor or the stairs, and the bungalow's, which
 * are named "... (old house)" (its drive apart). The main house's ground floor covers its whole plan.
 */
export function makeIndoors(prisms, rooms) {
  const names = new Set(rooms);
  const indoor = (n) => typeof n === 'string' && (names.has(n) || /floor|stairs/i.test(n) || (/\(old house\)$/.test(n) && !/^driveway/i.test(n)));
  const floors = prisms.filter((p) => indoor(p.n)).map((p) => {
    const ring = p.p[0];
    const xs = ring.map((v) => v[0]);
    const zs = ring.map((v) => v[1]);
    return { ring, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  });
  return (x, z) => floors.some((f) => x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ && inside(x, z, f.ring));
}
