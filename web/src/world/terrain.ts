import * as THREE from 'three';
import data from '../../shared/terrain.json';
import { makeTerrain } from '../../shared/terrain.mjs';

/**
 * The relief of the surroundings (tools/terrain.py, from the laser scan): heights relative to
 * the model's flat ground, flat round the plot and the bungalow. `terrain.height(x, z)` is the
 * ground as drawn here: two flat triangles per 4 m square.
 */
export const terrain = makeTerrain(data);

export interface GroundCuts {
  /** Squares of the grid (j * (nx - 1) + i) that a dip cuts */
  cells: number[];
  /** What is left of them: triangles, x and z of each corner */
  tris: number[];
}

/** Squares of the grid along each side of a piece of the ground (400 m). */
export const PIECE = 100;

/** How many pieces the ground has along x and along z. */
export function groundPieces(): [number, number] {
  return [Math.ceil((terrain.nx - 1) / PIECE), Math.ceil((terrain.nz - 1) / PIECE)];
}

/** The piece of the ground (pi, pj) that a cut square lies in. */
export function pieceOf(cell: number): [number, number] {
  const m = terrain.nx - 1;
  return [Math.floor((cell % m) / PIECE), Math.floor(Math.floor(cell / m) / PIECE)];
}

/**
 * One piece of the ground (PIECE by PIECE squares of the grid, as `terrain.height`), the squares
 * the dips cut taken out and their remains put in. The ground comes in pieces so the camera's
 * view leaves out what is behind it, and a piece can be made again when dips are added (the
 * village's ponds). Texture coordinates in metres, as the lawn's.
 */
export function groundPiece(ground: number, cuts: GroundCuts, pi: number, pj: number): THREE.BufferGeometry {
  const { x0, z0, step, nx } = terrain;
  const i0 = pi * PIECE;
  const j0 = pj * PIECE;
  const i1 = Math.min(i0 + PIECE, terrain.nx - 1);
  const j1 = Math.min(j0 + PIECE, terrain.nz - 1);
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const vertex = (x: number, z: number, y = terrain.height(x, z)) => {
    pos.push(x, ground + y, z);
    uv.push(x, -z);
    return pos.length / 3 - 1;
  };
  /** A triangle facing up (a, b, c are vertex numbers). */
  const tri = (a: number, b: number, c: number) => {
    const ux = pos[b * 3] - pos[a * 3];
    const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3];
    const vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    if (uz * vx - ux * vz >= 0) index.push(a, b, c);
    else index.push(a, c, b);
  };
  const w = i1 - i0 + 1;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) vertex(x0 + i * step, z0 + j * step, terrain.at(i, j));
  const cut = new Set(cuts.cells);
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      if (cut.has(j * (nx - 1) + i)) continue;
      const a = (j - j0) * w + (i - i0); // the square's corners: a (lowest x and z), b (+x), c (+x +z), d (+z)
      const b = a + 1;
      const c = a + w + 1;
      const d = a + w;
      tri(a, c, b); // split along a-c, as terrain.height
      tri(a, d, c);
    }
  }
  // The remains of the cut squares in this piece.
  const xa = x0 + i0 * step;
  const xb = x0 + i1 * step;
  const za = z0 + j0 * step;
  const zb = z0 + j1 * step;
  const t = cuts.tris;
  for (let k = 0; k < t.length; k += 6) {
    const mx = (t[k] + t[k + 2] + t[k + 4]) / 3;
    const mz = (t[k + 1] + t[k + 3] + t[k + 5]) / 3;
    if (mx < xa || mx >= xb || mz < za || mz >= zb) continue;
    tri(vertex(t[k], t[k + 1]), vertex(t[k + 2], t[k + 3]), vertex(t[k + 4], t[k + 5]));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/**
 * Beyond the grid: a skirt from each point on its edge out along its direction from the grid's
 * middle to `outer` metres, at the edge's height. The horizon (900 m from the eye) stands on it.
 */
export function groundSkirt(ground: number, outer = 3000): THREE.BufferGeometry {
  const { x0, z0, step, nx, nz } = terrain;
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const vertex = (x: number, z: number, y: number) => {
    pos.push(x, ground + y, z);
    uv.push(x, -z);
    return pos.length / 3 - 1;
  };
  const cx = x0 + ((nx - 1) * step) / 2;
  const cz = z0 + ((nz - 1) * step) / 2;
  const edge: [number, number][] = [];
  for (let i = 0; i < nx - 1; i++) edge.push([i, 0]);
  for (let j = 0; j < nz - 1; j++) edge.push([nx - 1, j]);
  for (let i = nx - 1; i > 0; i--) edge.push([i, nz - 1]);
  for (let j = nz - 1; j > 0; j--) edge.push([0, j]);
  const ring = edge.map(([i, j]) => {
    const x = x0 + i * step;
    const z = z0 + j * step;
    const h = terrain.at(i, j);
    const d = Math.hypot(x - cx, z - cz);
    return [vertex(x, z, h), vertex(cx + ((x - cx) / d) * outer, cz + ((z - cz) / d) * outer, h)];
  });
  const tri = (a: number, b: number, c: number) => {
    const ux = pos[b * 3] - pos[a * 3];
    const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3];
    const vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    if (uz * vx - ux * vz >= 0) index.push(a, b, c);
    else index.push(a, c, b);
  };
  for (let k = 0; k < ring.length; k++) {
    const [a, oa] = ring[k];
    const [b, ob] = ring[(k + 1) % ring.length];
    tri(a, b, ob);
    tri(a, ob, oa);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** The heights as a texture (half floats, metres), for the ground's light worked out on the graphics chip. */
export function terrainTexture(): THREE.DataTexture {
  const { nx, nz } = terrain;
  const half = new Uint16Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) half[j * nx + i] = THREE.DataUtils.toHalfFloat(terrain.at(i, j));
  const t = new THREE.DataTexture(half, nx, nz, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
