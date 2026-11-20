import * as THREE from 'three';
import { groundNoise } from './groundNoise';

/**
 * The ground under a roof stays dry in the rain and bare in the snow: a carport, a porch, a bus shelter, a canopy, a
 * balcony, an eave. As big games do it (a map from above of what covers the ground, read by the surface's shader, which
 * compares its own height with the cover's; the map's edges eroded, dilated and blurred so the border is soft; the
 * cover's shadow cast along the way the rain falls, so it slants with the wind), but made on the processor from the
 * cover map round the eye (world/coverMap.ts), with no extra drawing.
 *
 * No new texture unit: the ground's shaders already use all sixteen a phone or this PC has. The map shares the texture
 * the wet ground reads its puddles' noise from (world/wetGround.ts `wetNoise`): its red channel is that noise as before
 * (world/groundNoise.ts, the same tile, repeated, with its mip levels), and the other three hold the map, laid on the
 * same 128 by 128 texels as a wrapping (toroidal) map of TILE cells: a cell of the world always lands on the same texel,
 * so nothing moves on the texture as the map follows the eye, and the texture's own wrap filters across. Read at its
 * first level only. Per cell of the cover map:
 *
 * - g: how sheltered from the rain, b: from the snow (0 open, 1 under a roof). Each roof's cell casts its shadow on the
 *   ground where a drop that would pass through it lands: moved downwind by the slant of the fall times its height over
 *   that ground (rain falls steeply, snow drifts more), so the windward side of a carport gets wet a little way in and
 *   the lee side stays dry a little way out. Then blurred (about 40 cm each way) for a soft border.
 * - a: the height a surface must be under to count as sheltered (the lowest roof near, 35 cm under its top), so a roof
 *   itself, or a car park's canopy, still takes the rain and the snow on top. In steps of 10 cm over `base`.
 *
 * The shader (SHELTER_GLSL) makes the soft border uneven with a noise in the world's own coordinates and fades it out
 * towards the map's edge (13 to 17.5 m from the eye), where the ground goes back to the open look of further away. The
 * values change slowly (a second or two) when the map learns of a new roof or the wind turns, and they stay fixed to the
 * world as the map follows the eye cell by cell: nothing swims or pops as one walks.
 *
 * Tree crowns are left out on purpose: under a tree the ground is as wet as in the open (the leaves drip), and the snow
 * lies there as it does today.
 */

/** Seconds: how quickly the map takes a change (a roof learnt, the wind turned), and how often it is worked out again. */
const EASE = 1.4;
const EVERY = 0.5;
/** Milliseconds: worked out again at least this often (roofs the cover map learns); seconds between two uploads. */
const AGAIN = 2000;
const WRITE = 0.2;
/** The steepest slant the shadow is cast at (metres sideways per metre down): rain, and snow (a little drift only). */
const RAIN_SLANT = 0.3;
const SNOW_SLANT = 0.35;
/** Metres: a surface counts as under a roof this far under its top. */
const UNDER = 0.35;
/** Metres per step of the height (a), and the cells round a shadow that keep its height (blur and filter reach). */
const STEP = 0.1;
const KEEP = 3;

/** Texels across the shared texture (the noise tile's own size, world/groundNoise.ts). */
const TILE = 128;

/** The wet ground's noise with the map in its other channels (see above). */
function shared(): THREE.DataTexture {
  const noise = groundNoise();
  const red = noise.image.data as Uint8Array;
  const bytes = new Uint8Array(TILE * TILE * 4);
  for (let k = 0; k < TILE * TILE; k++) bytes[k * 4] = red[k];
  const t = new THREE.DataTexture(bytes, TILE, TILE);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** The uniforms every surface that takes the wet or the snow reads (world/wetGround.ts, world/snowCover.ts). */
export const shelter = {
  /** The shared texture: the wet ground's `wetNoise` */
  map: { value: shared() as THREE.Texture },
  /** The wrapping map's origin (x, z), 1 / its period in metres, and 1 once it is there */
  at: { value: new THREE.Vector4(0, 0, 1, 0) },
  /** The eye (x, z), for the fade towards the map's edge; the height's base (a's zero) */
  eye: { value: new THREE.Vector3() },
};

/** The slant of the fall now, metres sideways per metre down (x, z), set by world/rain.ts and world/snow.ts. */
export const slant = { rain: new THREE.Vector2(), snow: new THREE.Vector2() };

/**
 * For a fragment shader, after `#include <common>`: the shared texture `wetNoise`, and `shelterOver(p)`, how sheltered
 * a surface at p (world) is from the rain (x) and the snow (y), 0 open to 1 under a roof.
 */
export const SHELTER_GLSL = /* glsl */ `
uniform sampler2D wetNoise;
uniform vec4 shelterAt;
uniform vec3 shelterEye;
float shelterHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float shelterNoise( vec2 p ) {
  vec2 i = mod( floor( p ), 256.0 );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( shelterHash( i ), shelterHash( mod( i + vec2( 1.0, 0.0 ), 256.0 ) ), f.x ),
    mix( shelterHash( mod( i + vec2( 0.0, 1.0 ), 256.0 ) ), shelterHash( mod( i + vec2( 1.0, 1.0 ), 256.0 ) ), f.x ), f.y );
}
vec2 shelterOver( vec3 p ) {
  if ( shelterAt.w < 0.5 ) return vec2( 0.0 );
  vec4 s = textureLod( wetNoise, ( p.xz - shelterAt.xy ) * shelterAt.z, 0.0 );
  if ( s.g + s.b < 0.004 ) return vec2( 0.0 );
  // Under the roof's height, and not too near the map's edge (there it fades to the open look of further away).
  float near = 1.0 - smoothstep( 13.0, 17.5, max( abs( p.x - shelterEye.x ), abs( p.z - shelterEye.y ) ) );
  float under = clamp( ( shelterEye.z + s.a * ${(255 * STEP).toFixed(1)} - p.y ) * 4.0, 0.0, 1.0 ) * near;
  // The soft border made uneven: a noise of about a metre and of a hand's width moves it in and out (worked out only
  // on the border: well under the roof and well out from it the noise changes nothing).
  vec2 e = ( s.gb - 0.5 ) * 2.2 + 0.5;
  if ( min( abs( s.g - 0.5 ), abs( s.b - 0.5 ) ) < 0.44 ) {
    float n = shelterNoise( p.xz * 1.3 ) * 0.65 + shelterNoise( p.xz * 4.1 + 3.7 ) * 0.35;
    e += ( n - 0.5 ) * 0.9;
  }
  return clamp( e, 0.0, 1.0 ) * under;
}
`;

interface Shader {
  uniforms: Record<string, { value: unknown }>;
  fragmentShader: string;
}

/** Give a shader `wetNoise` and `shelterOver` (once; world/wetGround.ts and world/snowCover.ts both ask). */
export function shelterOn(shader: Shader): void {
  if (shader.uniforms.shelterAt) return;
  Object.assign(shader.uniforms, { wetNoise: shelter.map, shelterAt: shelter.at, shelterEye: shelter.eye });
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${SHELTER_GLSL}`);
}

/** Out of a fall's slant now: eased (seconds), and no steeper than `most`. */
function ease(out: THREE.Vector2, want: THREE.Vector2, k: number, most: number): void {
  out.lerp(want, k);
  if (out.length() > most) out.setLength(most);
}

/**
 * Made and fed by the cover map (world/coverMap.ts), on its cells: `update` each frame it is active, with its data
 * (r the top of each cell, a 1 where known), the floor under a roof per cell (NaN where the cell is not a roof over
 * open ground) and its corner in whole cells.
 */
export class ShelterMap {
  /** For the shaders (as CoverMap.at): the wrapping map's origin, 1 / its period, 1 once it is there */
  readonly at = shelter.at;
  private texture = shelter.map.value as THREE.DataTexture;
  private bytes = this.texture.image.data as Uint8Array;
  /** Shown now (eased) and wanted, rain and snow; the height (b) in metres, +Infinity where none */
  private rain: Float32Array;
  private snow: Float32Array;
  private wantRain: Float32Array;
  private wantSnow: Float32Array;
  private cut: Float32Array;
  private tmp: Float32Array;
  private ci = 0;
  private cj = 0;
  private placed = false;
  private last = 0;
  private since = Infinity;
  private written = Infinity;
  private dirty = false;
  private settled = true;
  private base = 0;
  private slantRain = new THREE.Vector2();
  private slantSnow = new THREE.Vector2();
  /** The slants and the time (ms) it was last worked out with */
  private builtRain = new THREE.Vector2(1e3, 0);
  private builtSnow = new THREE.Vector2();
  private builtAt = 0;

  constructor(private n: number, private cell: number) {
    if (n > TILE) throw new Error('the shelter map is larger than its texture');
    const nn = n * n;
    this.rain = new Float32Array(nn);
    this.snow = new Float32Array(nn);
    this.wantRain = new Float32Array(nn);
    this.wantSnow = new Float32Array(nn);
    this.cut = new Float32Array(nn).fill(Infinity);
    this.tmp = new Float32Array(nn);
  }

  update(data: Float32Array, floor: Float32Array, ci: number, cj: number, eye: THREE.Vector3, now: number): void {
    const dt = this.last ? Math.min(0.25, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.placed || ci !== this.ci || cj !== this.cj) {
      this.shift(ci - this.ci, cj - this.cj);
      this.ci = ci;
      this.cj = cj;
      this.dirty = true;
    }
    this.since += dt;
    this.written += dt;
    let built = false;
    if (this.since >= EVERY) {
      // Worked out again when the fall's slant has moved, or now and then for roofs the cover map has learnt since.
      ease(this.slantRain, slant.rain, 1 - Math.exp(-this.since / 3), RAIN_SLANT);
      ease(this.slantSnow, slant.snow, 1 - Math.exp(-this.since / 3), SNOW_SLANT);
      this.since = 0;
      const moved = this.builtRain.distanceTo(this.slantRain) + this.builtSnow.distanceTo(this.slantSnow) > 0.03; // 3 cm a metre: unseen
      if (moved || now - this.builtAt > AGAIN) {
        this.builtRain.copy(this.slantRain);
        this.builtSnow.copy(this.slantSnow);
        this.builtAt = now;
        this.build(data, floor);
        this.settled = false;
        built = true;
      }
    }
    if (!this.settled) {
      // Towards what is wanted: a roof just learnt comes in over a second or so, a turn of the wind moves its shadow.
      const k = 1 - Math.exp(-dt / EASE * 2.5);
      let most = 0;
      for (let i = 0; i < this.rain.length; i++) {
        const dr = this.wantRain[i] - this.rain[i], ds = this.wantSnow[i] - this.snow[i];
        this.rain[i] += dr * k;
        this.snow[i] += ds * k;
        most = Math.max(most, Math.abs(dr), Math.abs(ds));
      }
      if (most < 0.004) {
        this.rain.set(this.wantRain);
        this.snow.set(this.wantSnow);
        this.settled = true;
      }
      this.dirty = true;
    }
    const u = shelter;
    u.eye.value.x = eye.x;
    u.eye.value.y = eye.z;
    // Into the texture at most every WRITE seconds (the values change slowly; the wrap keeps every cell on its texel).
    // Not in the frame it was worked out in: the two are spread over two frames.
    if (!this.dirty || this.written < WRITE || built) return;
    this.dirty = false;
    this.written = 0;
    u.eye.value.z = this.base;
    // Into the wrapping texture: world cell (gi, gj) on texel (gi, gj) modulo TILE; texels outside the map are open.
    const b = this.bytes, n = this.n, rain = this.rain, snow = this.snow, cut = this.cut, base = this.base;
    for (let tj = 0; tj < TILE; tj++) {
      const j = (tj - this.cj) & (TILE - 1); // TILE is a power of two: the wrap, for negative cells too
      for (let ti = 0; ti < TILE; ti++) {
        const i = (ti - this.ci) & (TILE - 1);
        const o = (tj * TILE + ti) * 4;
        if (i >= n || j >= n) {
          b[o + 1] = b[o + 2] = b[o + 3] = 0;
          continue;
        }
        const k = j * n + i;
        b[o + 1] = (rain[k] * 255 + 0.5) | 0;
        b[o + 2] = (snow[k] * 255 + 0.5) | 0;
        const c = cut[k];
        b[o + 3] = c === Infinity ? 0 : Math.max(1, Math.min(255, ((c - base) / STEP + 0.5) | 0));
      }
    }
    this.texture.needsUpdate = true;
    // The origin: a whole period of the wrap near the map, so the coordinates stay small.
    const period = TILE * this.cell;
    u.at.value.set(Math.floor(this.ci / TILE) * period, Math.floor(this.cj / TILE) * period, 1 / period, 1);
  }

  /** The map's corner moved by (di, dj) cells: what is shown stays on its spot in the world, the new edge starts open. */
  private shift(di: number, dj: number): void {
    const n = this.n;
    for (const [a, none] of [[this.rain, 0], [this.snow, 0], [this.wantRain, 0], [this.wantSnow, 0], [this.cut, Infinity]] as const) {
      if (!this.placed || Math.abs(di) >= n || Math.abs(dj) >= n) {
        a.fill(none);
        continue;
      }
      const old = this.tmp;
      old.set(a);
      a.fill(none);
      const i0 = Math.max(0, -di), i1 = Math.min(n, n - di);
      if (i1 <= i0) continue;
      for (let j = 0; j < n; j++) {
        const sj = j + dj;
        if (sj < 0 || sj >= n) continue;
        a.set(old.subarray(sj * n + i0 + di, sj * n + i1 + di), j * n + i0);
      }
    }
    this.placed = true;
  }

  /** Work out what is wanted from the cover map's cells now. */
  private build(data: Float32Array, floor: Float32Array): void {
    const n = this.n, cell = this.cell;
    const rain = this.wantRain, snow = this.wantSnow, cut = this.cut;
    rain.fill(0);
    snow.fill(0);
    cut.fill(Infinity);
    const sr = this.slantRain, ss = this.slantSnow;
    const splat = (a: Float32Array, x: number, z: number) => {
      const i = Math.floor(x), j = Math.floor(z);
      const fx = x - i, fz = z - j;
      const add = (ii: number, jj: number, w: number) => {
        if (ii >= 0 && jj >= 0 && ii < n && jj < n) a[jj * n + ii] += w;
      };
      add(i, j, (1 - fx) * (1 - fz));
      add(i + 1, j, fx * (1 - fz));
      add(i, j + 1, (1 - fx) * fz);
      add(i + 1, j + 1, fx * fz);
    };
    const keep = (x: number, z: number, h: number) => {
      const i = Math.round(x), j = Math.round(z);
      if (i >= 0 && j >= 0 && i < n && j < n && h < cut[j * n + i]) cut[j * n + i] = h;
    };
    let low = Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const f = floor[k];
        if (Number.isNaN(f) || data[k * 4 + 3] < 0.5) continue;
        const top = data[k * 4];
        const h = top - f; // how high over its floor: a drop through it lands this times the slant downwind
        const below = top - UNDER;
        keep(i, j, below);
        const rx = i + (sr.x * h) / cell, rz = j + (sr.y * h) / cell;
        const sx = i + (ss.x * h) / cell, sz = j + (ss.y * h) / cell;
        splat(rain, rx, rz);
        splat(snow, sx, sz);
        keep(rx, rz, below);
        keep(sx, sz, below);
        low = Math.min(low, f);
      }
    }
    if (low === Infinity) return;
    this.base = Math.floor(low) - 1;
    // Only round the roofs: the box of every cell a roof or its shadow touched, and the filters' reach round it.
    let i0 = n, i1 = -1, j0 = n, j1 = -1;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (cut[j * n + i] === Infinity) continue;
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
      }
    }
    const r = KEEP + 2;
    const box = [Math.max(0, i0 - r), Math.min(n - 1, i1 + r), Math.max(0, j0 - r), Math.min(n - 1, j1 + r)] as const;
    for (const a of [rain, snow]) {
      for (let i = 0; i < a.length; i++) if (a[i] > 1) a[i] = 1;
      this.blur(a, box);
    }
    // The height reaches a little past the shadow, so the filter and the blur never read a cell without one.
    this.spread(cut, box);
  }

  /** A binomial blur (1 4 6 4 1) along both ways within the box (open beyond the map): a soft border of about 40 cm each side. */
  private blur(a: Float32Array, [i0, i1, j0, j1]: readonly [number, number, number, number]): void {
    const n = this.n, t = this.tmp;
    t.fill(0);
    const at = (v: Float32Array, k: number, ok: boolean) => (ok ? v[k] : 0);
    for (let j = j0; j <= j1; j++) {
      const row = j * n;
      for (let i = i0; i <= i1; i++) {
        const k = row + i;
        t[k] = (at(a, k - 2, i >= 2) + at(a, k + 2, i < n - 2) + 4 * (at(a, k - 1, i >= 1) + at(a, k + 1, i < n - 1)) + 6 * a[k]) / 16;
      }
    }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * n + i;
        a[k] = (at(t, k - 2 * n, j >= 2) + at(t, k + 2 * n, j < n - 2) + 4 * (at(t, k - n, j >= 1) + at(t, k + n, j < n - 1)) + 6 * t[k]) / 16;
      }
    }
  }

  /** The lowest height within KEEP cells, along both ways, within the box. */
  private spread(a: Float32Array, [i0, i1, j0, j1]: readonly [number, number, number, number]): void {
    const n = this.n, t = this.tmp;
    t.fill(Infinity);
    for (let pass = 0; pass < 2; pass++) {
      const [from, to] = pass === 0 ? [a, t] : [t, a];
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          let m = Infinity;
          const at = pass === 0 ? i : j, step = pass === 0 ? 1 : n, k = j * n + i;
          for (let d = Math.max(-KEEP, -at), e = Math.min(KEEP, n - 1 - at); d <= e; d++) {
            const v = from[k + d * step];
            if (v < m) m = v;
          }
          to[k] = m;
        }
      }
    }
  }
}
