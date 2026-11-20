import * as THREE from 'three';
import type { World } from './collision';

/**
 * What is over the ground round the eye, seen from above, for the rain and the snow (world/rain.ts, world/snow.ts) to
 * stop at: as big games do it (a height map from above round the player that the drops' shader tests against), but made
 * on the processor from what the game already knows, with no extra drawing. A square of SIDE metres in cells of CELL
 * metres round the eye; each cell keeps
 *
 * - the highest thing there (World.groundAt from above: a drawn roof, a canopy, a carport's or a shelter's roof, the
 *   top of a block, a hedge, else the ground): a drop under it is not drawn;
 * - the top and the bottom of a tree's crown over it (the trees' list, as the helicopter has it): under a crown the
 *   rain thins and falls in larger, slower drops (world/rain.ts);
 * - whether it is known yet (a cell not asked yet: the rain falls as before, outdoors only).
 *
 * It moves with the eye cell by cell (what stays is shifted, only the new edge is asked), and the cells are asked
 * nearest first within a small time budget a frame, so a teleport fills in round the eye first. While it rains or
 * snows the cells are asked again slowly (the village and the houses' models come in after the start). Asked only then:
 * in dry weather it costs nothing.
 *
 * It also finds the edges where rain runs off a roof (a drawn roof a metre and more over the cell beside it: eaves,
 * canopies, shelters), for the drips (world/rain.ts).
 *
 * The texture is 32-bit floats read without filtering (nearest), which every WebGL2 device reads, in a vertex shader too.
 */

/** Metres: a cell's side, and the cells across. */
const CELL = 0.4;
const N = 96;
export const COVER_SIDE = CELL * N;
/** Milliseconds a frame for asking cells (fewer on a slow processor), and how long a cell's answer is good for. */
const BUDGET = 0.3;
const STALE = 8000;
/** A drop runs off a drawn roof this many metres over the cell beside it (an eave). */
const EAVE = 1.0;
/** Metres round the eye for drips, and how many at most. */
const DRIP_REACH = 13;

/** A tree's crown as the world lists it: its foot, its height and its crown's radius (as world/heli.ts Crown). */
export interface CoverCrown {
  x: number;
  z: number;
  y: number;
  h: number;
  r: number;
}

/**
 * Roofs the world's collision doesn't know (nothing walks on them), for the rain: a rectangle round (x, z), turned by
 * `yaw` as three.js turns about the vertical, `hl` and `hw` half its length (along its own x) and width, its top at
 * `top`. The bus shelters (world/roadside.ts) add theirs.
 */
export const coverRoofs: { x: number; z: number; yaw: number; hl: number; hw: number; top: number }[] = [];

/** A drip: where the drop leaves the edge (x, top, z) and where it lands (bottom), and a number of its own. */
export interface Drip {
  x: number;
  z: number;
  top: number;
  bottom: number;
  seed: number;
}

/**
 * For a vertex shader: `coverOver(xz)`, the cell over a point on the plan: r the highest thing there, g and b a crown's
 * top and bottom over it (-1e4 where none), a 1 where known (0 outside the map or not asked yet: then `coverAt.w` says
 * whether a drop counts as covered, the eye being indoors).
 */
export const COVER_GLSL = /* glsl */ `
  uniform sampler2D coverMap;
  uniform vec4 coverAt;
  vec4 coverOver(vec2 xz) {
    vec2 uv = (xz - coverAt.xy) * coverAt.z;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec4(-1e4, -1e4, -1e4, 0.0);
    vec4 c = texture2D(coverMap, uv);
    return c.a > 0.5 ? c : vec4(-1e4, -1e4, -1e4, 0.0);
  }`;

/** The uniforms COVER_GLSL reads, before a map is there: nothing known (a drop indoors counts as covered). */
export function coverUniforms(): { coverMap: { value: THREE.Texture }; coverAt: { value: THREE.Vector4 } } {
  const none = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  none.needsUpdate = true;
  return { coverMap: { value: none }, coverAt: { value: new THREE.Vector4(0, 0, 1 / COVER_SIDE, 0) } };
}

const hash = (i: number, j: number) => {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export class CoverMap {
  readonly texture: THREE.DataTexture;
  /** For the shaders: the map's corner (x, z), 1 / its side, and whether a cell not known yet counts as covered (indoors). */
  readonly at = { value: new THREE.Vector4(0, 0, 1 / COVER_SIDE, 0) };
  private data = new Float32Array(N * N * 4);
  /** Per cell: when it was asked (performance.now(), 0 never) and whether its top is a drawn roof (for the drips) */
  private asked = new Float64Array(N * N);
  private roof = new Uint8Array(N * N);
  /** The map's corner in whole cells */
  private ci = 0;
  private cj = 0;
  private placed = false;
  /** The cells nearest the middle first */
  private order: Uint16Array;
  private cursor = 0;
  private dirty = false;
  private crownCells = new Map<number, CoverCrown[]>();
  private crownCount = -1;
  private dripsAt = 0;
  /** The drips near the eye, found again now and then (`dripsChanged` counts up when they are) */
  drips: Drip[] = [];
  dripsChanged = 0;

  constructor(private world: World, private crowns: CoverCrown[], private skipCrown: (x: number, z: number) => boolean = () => false) {
    this.texture = new THREE.DataTexture(this.data, N, N, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    const idx = [...Array(N * N).keys()];
    const d = (k: number) => Math.hypot((k % N) - N / 2 + 0.5, Math.floor(k / N) - N / 2 + 0.5);
    idx.sort((a, b) => d(a) - d(b));
    this.order = Uint16Array.from(idx);
  }

  /**
   * Each frame while it rains or snows (`active`): the map follows the eye and asks cells within the budget. `indoors`:
   * where nothing is known yet, a drop counts as under a roof (as before the map).
   */
  update(eye: THREE.Vector3, indoors: boolean, active: boolean, now = performance.now()): void {
    this.at.value.w = indoors ? 1 : 0;
    if (!active) return;
    const ci = Math.floor(eye.x / CELL) - N / 2;
    const cj = Math.floor(eye.z / CELL) - N / 2;
    if (!this.placed || ci !== this.ci || cj !== this.cj) this.shift(ci, cj);
    if (this.crownCount !== this.crowns.length) this.indexCrowns();
    // Ask the cells nearest the eye first: new ones, then those asked longest ago.
    const t0 = performance.now();
    let n = 0;
    for (let tries = 0; tries < N * N; tries++) {
      const k = this.order[this.cursor];
      this.cursor = (this.cursor + 1) % (N * N);
      const a = this.asked[k];
      if (a && now - a < STALE) continue;
      this.ask(k, now);
      if (++n % 8 === 0 && performance.now() - t0 > BUDGET) break;
    }
    // The cursor goes round from the middle again after a while, so the nearest stay freshest.
    if (n === 0) this.cursor = 0;
    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
    if (now - this.dripsAt > 300) {
      this.dripsAt = now;
      this.findDrips(eye);
    }
  }

  /** The highest thing over (x, z) as the map has it, or null where it has nothing yet. */
  topAt(x: number, z: number): number | null {
    const i = Math.floor(x / CELL) - this.ci, j = Math.floor(z / CELL) - this.cj;
    if (!this.placed || i < 0 || j < 0 || i >= N || j >= N) return null;
    const k = j * N + i;
    return this.data[k * 4 + 3] > 0.5 ? this.data[k * 4] : null;
  }

  /** Move the map's corner to cell (ci, cj): what it knew of cells still in it is kept, the rest is to be asked. */
  private shift(ci: number, cj: number): void {
    const di = ci - this.ci, dj = cj - this.cj;
    const data = this.data, asked = this.asked, roof = this.roof;
    if (!this.placed || Math.abs(di) >= N || Math.abs(dj) >= N) {
      data.fill(0);
      asked.fill(0);
      roof.fill(0);
    } else {
      const old = data.slice(), oldAsked = asked.slice(), oldRoof = roof.slice();
      data.fill(0);
      asked.fill(0);
      roof.fill(0);
      for (let j = 0; j < N; j++) {
        const sj = j + dj;
        if (sj < 0 || sj >= N) continue;
        const i0 = Math.max(0, -di), i1 = Math.min(N, N - di);
        if (i1 <= i0) continue;
        data.set(old.subarray((sj * N + i0 + di) * 4, (sj * N + i1 + di) * 4), (j * N + i0) * 4);
        asked.set(oldAsked.subarray(sj * N + i0 + di, sj * N + i1 + di), j * N + i0);
        roof.set(oldRoof.subarray(sj * N + i0 + di, sj * N + i1 + di), j * N + i0);
      }
    }
    this.ci = ci;
    this.cj = cj;
    this.placed = true;
    this.cursor = 0;
    this.at.value.x = ci * CELL;
    this.at.value.y = cj * CELL;
    this.dirty = true;
  }

  /** Ask the world about one cell, at its middle. */
  private ask(k: number, now: number): void {
    const i = k % N, j = Math.floor(k / N);
    const x = (this.ci + i + 0.5) * CELL, z = (this.cj + j + 0.5) * CELL;
    const g = this.world.groundAt(x, z, 1e6, 0);
    let y = g.y;
    let drawn = !!g.drawn || g.mat === 'roof';
    for (const r of coverRoofs) {
      const dx = x - r.x, dz = z - r.z;
      if (dx * dx + dz * dz > (r.hl + r.hw) ** 2 || r.top <= y) continue;
      const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
      // Into the roof's own frame (three.js turns +x towards -z for a positive yaw).
      if (Math.abs(dx * c - dz * s) <= r.hl && Math.abs(dx * s + dz * c) <= r.hw) [y, drawn] = [r.top, true];
    }
    let top = -1e4, bottom = -1e4;
    const list = this.crownCells.get(Math.floor(x / 32) * 100003 + Math.floor(z / 32));
    if (list) {
      for (const c of list) {
        const d = Math.hypot(x - c.x, z - c.z);
        if (d >= c.r * 0.9) continue;
        if (this.skipCrown(c.x, c.z)) continue;
        // A dome: highest over the trunk, lower towards the crown's edge.
        const f = d / (c.r * 0.9);
        const t = c.y + c.h - (1 - Math.sqrt(1 - f * f)) * c.h * 0.3;
        if (t > top) [top, bottom] = [t, c.y + 0.35 * c.h];
      }
    }
    const o = k * 4;
    const d = this.data;
    if (d[o] !== y || d[o + 1] !== top || d[o + 3] !== 1) {
      d[o] = y;
      d[o + 1] = top;
      d[o + 2] = bottom;
      d[o + 3] = 1;
      this.dirty = true;
    }
    this.roof[k] = drawn ? 1 : 0;
    this.asked[k] = now;
  }

  /** The trees' crowns by 32 m square (each listed in every square its crown reaches). */
  private indexCrowns(): void {
    this.crownCells.clear();
    for (const c of this.crowns) {
      for (let i = Math.floor((c.x - c.r) / 32); i <= Math.floor((c.x + c.r) / 32); i++) {
        for (let j = Math.floor((c.z - c.r) / 32); j <= Math.floor((c.z + c.r) / 32); j++) {
          const key = i * 100003 + j;
          let cell = this.crownCells.get(key);
          if (!cell) this.crownCells.set(key, (cell = []));
          cell.push(c);
        }
      }
    }
    this.crownCount = this.crowns.length;
    // Cells asked before the trees came in are asked again.
    this.asked.fill(0);
  }

  /**
   * The edges near the eye where a drawn roof stands EAVE or more over the cell beside it: a drop runs off there and
   * falls to that cell. About one in two cell edges, the nearest first.
   */
  private findDrips(eye: THREE.Vector3): void {
    const out: (Drip & { far: number })[] = [];
    const d = this.data;
    const reach = Math.ceil(DRIP_REACH / CELL);
    const mi = Math.floor(eye.x / CELL) - this.ci, mj = Math.floor(eye.z / CELL) - this.cj;
    for (let j = Math.max(0, mj - reach); j < Math.min(N, mj + reach); j++) {
      for (let i = Math.max(0, mi - reach); i < Math.min(N, mi + reach); i++) {
        const k = j * N + i;
        if (d[k * 4 + 3] < 0.5) continue;
        for (const [ni, nj] of [[i + 1, j], [i, j + 1], [i - 1, j], [i, j - 1]]) {
          if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
          const m = nj * N + ni;
          if (d[m * 4 + 3] < 0.5 || !this.roof[k] || d[k * 4] - d[m * 4] < EAVE) continue;
          const gi = this.ci + i, gj = this.cj + j;
          const h = hash(gi * 4 + ni - i, gj * 4 + nj - j);
          if (h > 0.5) continue;
          // On the edge between the two, somewhere along it, a little out from under the roof.
          const along = (hash(gj, gi) - 0.5) * CELL * 0.8;
          const x = (gi + 0.5 + (ni - i) * 0.55) * CELL + (nj - j) * along;
          const z = (gj + 0.5 + (nj - j) * 0.55) * CELL + (ni - i) * along;
          // The roof at the edge is a little lower than at the cell's middle (a slope runs down to its eave).
          out.push({ x, z, top: d[k * 4] - 0.08, bottom: d[m * 4], seed: h * 2, far: Math.hypot(x - eye.x, z - eye.z) });
        }
      }
    }
    out.sort((a, b) => a.far - b.far);
    this.drips = out;
    this.dripsChanged++;
  }
}
