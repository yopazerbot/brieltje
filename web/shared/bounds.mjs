// The edge of the game (tools/bounds.py writes bounds.json): an outline round the built-up area
// that nobody walks, rides, drives or flies past, a smaller one round the two houses while a game
// in the house runs, and a ceiling for flying. Shared by the browser (src/world/collision.ts stops
// you at it) and the server (server/game.mjs puts a position outside back in). Plain functions, no
// three.js. Points are the model's (x, z).
//
// Every question is about one spot, every frame, so the outline is sorted into a grid of CELL-metre
// squares: a square well inside or well outside answers at once, one the edge runs through looks
// only at the edge's pieces in its own row of squares (inside or out) or in itself (the nearest
// point on the edge).

/** Metres: the side of a square of the grid. */
const CELL = 24;
/** Metres: a square counts as on the edge when the edge comes this close to it (more than a car's half diagonal). */
const PAD = 4;
/** Metres: how far a circle may lean into the edge before it is pushed back (rounding, a step slowing to nothing). */
const SNUG = 0.002;

/**
 * The outline `ring` ([x, z] points, either way round) made ready for questions.
 * @param {number[][]} ring
 */
export function makeBounds(ring) {
  const n = ring.length;
  const ax = new Float64Array(n), az = new Float64Array(n), bx = new Float64Array(n), bz = new Float64Array(n);
  let area = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % n];
    ax[i] = x0; az[i] = z0; bx[i] = x1; bz[i] = z1;
    area += x0 * z1 - x1 * z0;
    minX = Math.min(minX, x0); maxX = Math.max(maxX, x0);
    minZ = Math.min(minZ, z0); maxZ = Math.max(maxZ, z0);
  }
  // The inward side of edge a -> b is (-dz, dx) on a ring with a positive area (x right, z up), else the other.
  const turn = area > 0 ? 1 : -1;
  const x0 = minX - PAD - CELL, z0 = minZ - PAD - CELL;
  const nx = Math.ceil((maxX + PAD + CELL - x0) / CELL), nz = Math.ceil((maxZ + PAD + CELL - z0) / CELL);
  /** Per square: 0 outside, 1 inside, 2 on the edge. */
  const kind = new Uint8Array(nx * nz);
  /** Per square on the edge: the edges within PAD of it. */
  const cells = new Map();
  /** Per row of squares: the edges that cross its band of z. */
  const rows = Array.from({ length: nz }, () => []);
  for (let e = 0; e < n; e++) {
    const i0 = Math.floor((Math.min(ax[e], bx[e]) - PAD - x0) / CELL), i1 = Math.floor((Math.max(ax[e], bx[e]) + PAD - x0) / CELL);
    const j0 = Math.floor((Math.min(az[e], bz[e]) - PAD - z0) / CELL), j1 = Math.floor((Math.max(az[e], bz[e]) + PAD - z0) / CELL);
    for (let j = j0; j <= j1; j++) {
      rows[j].push(e);
      for (let i = i0; i <= i1; i++) {
        // Only the squares the edge really comes near (a long diagonal edge passes most of its box by).
        const cx = x0 + (i + 0.5) * CELL, cz = z0 + (j + 0.5) * CELL;
        if (segmentDistance(cx, cz, ax[e], az[e], bx[e], bz[e]).d > CELL * 0.7072 + PAD) continue;
        const k = j * nx + i;
        kind[k] = 2;
        const list = cells.get(k);
        if (list) list.push(e);
        else cells.set(k, [e]);
      }
    }
  }

  /** Crossing count along the row's edges (even-odd), from (x, z) towards +x. */
  const parity = (x, z, edges) => {
    let hit = false;
    for (const e of edges) {
      if (az[e] > z !== bz[e] > z && x < ((bx[e] - ax[e]) * (z - az[e])) / (bz[e] - az[e]) + ax[e]) hit = !hit;
    }
    return hit;
  };
  const all = Array.from({ length: n }, (_, e) => e);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (kind[k] !== 2) kind[k] = parity(x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL, rows[j]) ? 1 : 0;
    }
  }

  const cellAt = (x, z) => {
    const i = Math.floor((x - x0) / CELL), j = Math.floor((z - z0) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
  };

  /** Whether (x, z) is inside the outline. */
  const inside = (x, z) => {
    const k = cellAt(x, z);
    if (k < 0) return false;
    const c = kind[k];
    return c === 2 ? parity(x, z, rows[Math.floor(k / nx)]) : c === 1;
  };

  /**
   * The nearest point on the edge to (x, z), how far it is and the edge's inward direction. Only
   * within `reach` m (null if none is that close); Infinity looks at the whole outline.
   */
  const stamp = new Uint32Array(n);
  let search = 0;
  const nearest = (x, z, reach = Infinity) => {
    let best = null;
    const look = (e) => {
      const s = segmentDistance(x, z, ax[e], az[e], bx[e], bz[e]);
      if (s.d < reach && (!best || s.d < best.d)) {
        const dx = bx[e] - ax[e], dz = bz[e] - az[e];
        const len = Math.hypot(dx, dz) || 1;
        best = { x: s.x, z: s.z, d: s.d, nx: (-dz * turn) / len, nz: (dx * turn) / len };
      }
    };
    if (reach <= PAD) {
      // Within PAD: the square's own list has every edge that close.
      const k = cellAt(x, z);
      for (const e of (k >= 0 && cells.get(k)) || []) look(e);
    } else if (reach < CELL * 4) {
      search++;
      const i0 = Math.floor((x - reach - x0) / CELL), i1 = Math.floor((x + reach - x0) / CELL);
      const j0 = Math.floor((z - reach - z0) / CELL), j1 = Math.floor((z + reach - z0) / CELL);
      for (let j = Math.max(0, j0); j <= Math.min(nz - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(nx - 1, i1); i++) {
          for (const e of cells.get(j * nx + i) || []) {
            if (stamp[e] === search) continue;
            stamp[e] = search;
            look(e);
          }
        }
      }
    } else for (const e of all) look(e);
    return best;
  };

  /** How far inside (x, z) is: the distance to the edge, negative outside. */
  const depth = (x, z) => {
    const near = nearest(x, z);
    const d = near ? near.d : 0;
    return inside(x, z) ? d : -d;
  };

  /**
   * A circle of radius r at `pos` (moved in place) kept inside, at least r from the edge: out of a
   * piece of the edge it pushed into (sliding along it, as against a wall), or from outside back
   * to the nearest point r inside. True when it moved.
   */
  const keepIn = (pos, r) => {
    let moved = false;
    if (!inside(pos.x, pos.z)) {
      const near = nearest(pos.x, pos.z);
      if (!near) return false;
      // From outside: past the nearest point, on along the way there (the way in) or along the edge's
      // own normal (at a corner the way there can graze the next edge), a little deeper each try.
      let ux = near.x - pos.x, uz = near.z - pos.z;
      const d = Math.hypot(ux, uz);
      if (d > 1e-6) [ux, uz] = [ux / d, uz / d];
      else [ux, uz] = [near.nx, near.nz];
      found: for (const s of [r + 0.01, 2 * r + 0.02, 0.5, 1, 2, 4]) {
        for (const [vx, vz] of [[ux, uz], [near.nx, near.nz]]) {
          if (!inside(near.x + vx * s, near.z + vz * s)) continue;
          pos.x = near.x + vx * s;
          pos.z = near.z + vz * s;
          moved = true;
          break found;
        }
      }
      if (!moved) return false;
    }
    if (r <= 0) return moved;
    for (let iter = 0; iter < 3; iter++) {
      const k = cellAt(pos.x, pos.z);
      if (k < 0 || kind[k] !== 2) break;
      // Standing against it (within SNUG of touching) is no push: the last of a slowing step isn't one.
      const near = nearest(pos.x, pos.z, r - SNUG);
      if (!near) break;
      let ux = pos.x - near.x, uz = pos.z - near.z;
      const d = Math.hypot(ux, uz);
      if (d > 1e-6) [ux, uz] = [ux / d, uz / d];
      else [ux, uz] = [near.nx, near.nz];
      const x = near.x + ux * r, z = near.z + uz * r;
      if (!inside(x, z)) break; // never pushed out through a corner
      pos.x = x;
      pos.z = z;
      moved = true;
    }
    return moved;
  };

  /** Whether a rectangle on the plan (a car, a horse: its middle, heading, half length and half width) is inside: its corners. */
  const boxInside = (cx, cz, yaw, halfL, halfW) => {
    const k = cellAt(cx, cz);
    if (k < 0) return false;
    if (kind[k] === 1 && halfL * halfL + halfW * halfW <= PAD * PAD) return true; // nowhere near the edge
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const [a, b] of CORNERS) {
      if (!inside(cx + fx * halfL * a - fz * halfW * b, cz + fz * halfL * a + fx * halfW * b)) return false;
    }
    return true;
  };

  /**
   * The server's check: a point outside is put on the nearest point `margin` m inside; a point
   * inside stays. Returns where it is now and whether it moved, or null if no point was found (the
   * caller keeps the last good one).
   */
  const putBack = (x, z, margin = 0.3) => {
    if (inside(x, z)) return { x, z, moved: false };
    const pos = { x, z };
    keepIn(pos, margin);
    return inside(pos.x, pos.z) ? { x: pos.x, z: pos.z, moved: true } : null;
  };

  return { ring, minX, maxX, minZ, maxZ, inside, nearest, depth, keepIn, boxInside, putBack };
}

const CORNERS = [[1, 1], [1, -1], [-1, -1], [-1, 1]];

/** The point of segment a-b nearest to (x, z), and how far. */
function segmentDistance(x, z, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az;
  const len2 = ex * ex + ez * ez;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
  const px = ax + ex * t, pz = az + ez * t;
  return { x: px, z: pz, d: Math.hypot(x - px, z - pz) };
}

/** Both outlines and the ceiling, from bounds.json. */
export function loadBounds(data) {
  return { map: makeBounds(data.map), party: makeBounds(data.party), ceiling: data.ceiling };
}
