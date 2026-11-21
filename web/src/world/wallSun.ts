import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import './sunShadow'; // its patch of the light chunk first: this one changes a line of it

/**
 * The sun's shadow on the village's own houses (world/surroundings.ts: their walls, gables, roofs, chimneys, frames and
 * windows) where no real-time shadow map reaches: beyond the far map on Medium and up, and everywhere but round the main
 * house on Low and on phones. Without it a wall facing the sun was fully lit while the ground at its foot lay in the
 * baked shadow of the house across the street.
 *
 * As big open-world games shade what lies beyond their cascades from a height picture of the world (traced towards the
 * sun) that they make again only now and then, each of the ground's bakes (world/groundShade.ts) hands over its picture of
 * the heights seen from straight above, and from it a "shadow height" picture is worked out once: for each spot of the
 * ground, the height below which the sun is hidden there. Over a field of heights that is exact, and it is one number:
 * S(p) = the highest of H(p + t a) - t tan(e) over every distance t towards the sun (a: the sun's way along the ground,
 * e: its height). A wall's pixel then needs one texture read: it is in the sun if it stands above S, a little out from
 * its own wall and up the sun's ray. S is found in a few passes that each look twice as far as the one before (1, 2, 4
 * ... texels), so the long shadows of a low sun cost no more than noon's.
 *
 * Four numbers per spot: S for noon's sun and for dusk's (the same compass side, lower), each once over everything and
 * once over what stands solid (no tree crowns, trunks, hedge lumps or posts). Between the two, a crown lets some sun
 * through, as on the ground (world/groundShade.ts crownLight). The walls blend noon's into dusk's as far as the sun is
 * down, as the ground does; the night keeps noon's (the moon stands where the noon sun does).
 *
 * The real-time maps win where they reach: the sun's shadow lookup (world/sunShadow.ts patchCascade) reads this in place
 * of "no shadow" beyond the maps, over the same hand-over band, so there is no border and no double shadow. Each
 * picture is half the ground's bake's resolution (about 47 cm round the main house, 67 cm in the village, 1.1 m over
 * Molenhoek's far stretch, half as fine on phones): 12 MB on a computer, 3 MB on a phone. It is worked out three passes a
 * frame after a bake (about a tenth of a millisecond of the chip's time a frame), so loading takes no longer. Each
 * pixel past the maps reads it once; within them it isn't read.
 */

/** How much of the sun gets through a tree's crown on average at the end of November (world/groundShade.ts crownLight) */
const CROWN = 0.42;
/** How far out from its surface (m) and towards the sun along the ground (m) a pixel looks: past its own eaves. */
const OUT = 0.5;
const TOWARDS = 0.9;
/** How far the shadows reach (m): a 40 m tower at dusk's sun, 15 degrees up. */
const REACH = 160;
/** The heights' range in the stored picture: from this far below the area's middle, this many metres (0.28 m a step). */
const BELOW = 12;
const RANGE = 72;
/** Flood passes a frame (three about a tenth of a millisecond on this PC's chip at 1024 texels) */
const PASSES_PER_FRAME = 3;
/** Phones and tablets: pictures half as fine (as the ground's bakes there) */
const PHONE = matchMedia('(pointer: coarse)').matches;

/**
 * The shadow map lookup's "nothing casts here" beyond the maps (world/sunShadow.ts patchCascade), this picture's in the
 * materials that ask (WALL_SUN): read only where the far map doesn't cover all (or everywhere past the sharp map when
 * there is no far map: Low, phones), and over the far map's outer band the far map fades into it, not into "lit".
 */
function patchChunk(): void {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const start = chunk.indexOf('float scFar = 1.0;');
  const endText = 'scLit = mix( scLit, scFar, scOut );';
  const end = chunk.indexOf(endText, start);
  const into = 'if ( scIn > 0.0 ) scFar = mix( 1.0, ';
  const slice = start < 0 || end < 0 ? '' : chunk.slice(start, end + endText.length);
  if (!slice.includes(into) || !slice.includes('float scIn = ')) {
    console.warn('wallSun: the sun shadow lookup changed; the houses get no shadow beyond the maps');
    return;
  }
  const ours = slice
    .replace('float scFar = 1.0;', 'float scFar = directionalLightShadows[ 1 ].shadowIntensity > 0.0 ? 1.0 : wallSun();')
    .replace(into, 'if ( scIn < 1.0 ) scFar = wallSun();\n\t\t\t\t\t\tif ( scIn > 0.0 ) scFar = mix( scFar, ');
  THREE.ShaderChunk.lights_fragment_begin = `${chunk.slice(0, start)}#ifdef WALL_SUN\n\t\t\t\t${ours}\n\t\t\t\t#else\n\t\t\t\t${slice}\n\t\t\t\t#endif${chunk.slice(end + endText.length)}`;
}
patchChunk();

const neutral = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
neutral.needsUpdate = true;

/** Shared by every material that reads the picture: uniforms only, so nothing compiles again when it changes. */
const U = {
  wsMap: { value: neutral as THREE.Texture },
  /** The picture's area: centre x, z, half size; w 1 while one is read */
  wsArea: { value: new THREE.Vector4(0, 0, 1, 0) },
  /** Towards the sun along the ground (x, z), and the noon and dusk sun's rise per metre */
  wsRay: { value: new THREE.Vector4(1, 0, 1, 0.3) },
  /** The stored heights' base and range (m), the dusk share (0 noon, 1 dusk), the edge's softness (m) */
  wsCode: { value: new THREE.Vector4(0, RANGE, 0, 0.4) },
};

const PARS = /* glsl */ `
uniform sampler2D wsMap;
uniform vec4 wsArea;
uniform vec4 wsRay;
uniform vec4 wsCode;
varying vec3 vWsPos;
varying vec3 vWsNormal;
/** The sun on this pixel from the houses' shadow heights (world/wallSun.ts): 1 in the sun, 0 in a solid's shadow. */
float wallSun() {
  if ( wsArea.w < 0.5 ) return 1.0;
  vec3 wsN = normalize( vWsNormal ) * ( gl_FrontFacing ? 1.0 : -1.0 );
  vec3 wsQ = vWsPos + wsN * ${OUT.toFixed(2)};
  wsQ.xz += wsRay.xy * ${TOWARDS.toFixed(2)};
  vec2 wsUv = ( wsQ.xz - wsArea.xy ) / wsArea.z * 0.5 + 0.5;
  vec2 wsEdge = abs( wsUv - 0.5 );
  float wsIn = smoothstep( 0.5, 0.46, max( wsEdge.x, wsEdge.y ) );
  if ( wsIn <= 0.0 ) return 1.0;
  vec4 wsS = texture2D( wsMap, wsUv );
  // 0 stands for "at or below the base": nothing casts there.
  vec4 wsH = mix( vec4( -1e4 ), wsCode.x + wsS * wsCode.y, step( 0.002, wsS ) );
  vec2 wsY = wsQ.y + ${TOWARDS.toFixed(2)} * wsRay.zw; // the sun's ray from the pixel, at that spot: noon's, dusk's
  float wsW = wsCode.w;
  float wsNoon = smoothstep( wsH.y - wsW, wsH.y + wsW, wsY.x ) * mix( ${CROWN.toFixed(2)}, 1.0, smoothstep( wsH.x - wsW, wsH.x + wsW, wsY.x ) );
  float wsDusk = wsCode.z > 0.0 ? smoothstep( wsH.w - wsW, wsH.w + wsW, wsY.y ) * mix( ${CROWN.toFixed(2)}, 1.0, smoothstep( wsH.z - wsW, wsH.z + wsW, wsY.y ) ) : 1.0;
  return mix( 1.0, mix( wsNoon, wsDusk, wsCode.z ), wsIn );
}
`;

const patched = new WeakSet<THREE.Material>();

/**
 * Let a material's sun be shaded by the houses' shadow heights beyond the real-time maps. Patched once; its shader then
 * has one texture more (read only beyond the maps). Not for the ground (world/groundShade.ts has its own bake).
 */
export function sunOnWalls<T extends THREE.Material>(m: T): T {
  if (patched.has(m)) return m;
  patched.add(m);
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWsPos;\nvarying vec3 vWsNormal;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        #ifdef USE_INSTANCING
          vWsPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
          vWsNormal = mat3( modelMatrix ) * mat3( instanceMatrix ) * objectNormal;
        #else
          vWsPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          vWsNormal = mat3( modelMatrix ) * objectNormal;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${PARS}`);
  };
  m.defines = { ...m.defines, WALL_SUN: '' };
  m.customProgramCacheKey = () => `${key()}|wallSun`;
  m.needsUpdate = true;
  return m;
}

interface Area {
  centre: THREE.Vector2;
  half: number;
  size: number;
  base: number;
  /** The flood's two pictures while it is worked out (half floats), then null */
  ping: THREE.WebGLRenderTarget | null;
  pong: THREE.WebGLRenderTarget | null;
  /** The next pass (0, 1, ... passes; then the stored picture) */
  pass: number;
  passes: number;
  picture: THREE.WebGLRenderTarget | null;
}

const QUAD_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/** From above (world/groundShade.ts' depth pictures) to heights: everything's (r, b) and the solid's (g, a). */
const HEIGHTS = /* glsl */ `
uniform sampler2D topDepth;
uniform sampler2D solidDepth;
uniform mat4 topMatrix;
uniform vec2 topRange; // the camera's height less its near plane, its depth range
uniform vec3 area; // centre x, z, half size
uniform float tap; // a quarter of this picture's texel (m)
varying vec2 vUv;
vec2 at(vec2 xz) {
  vec4 q = topMatrix * vec4(xz.x, 0.0, xz.y, 1.0);
  return q.xy * 0.5 + 0.5;
}
void main() {
  vec2 xz = area.xy + (vUv * 2.0 - 1.0) * area.z;
  vec2 h = vec2(0.0);
  // The mean of four of the bake's texels, so a house grows by no texel.
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 3 ? tap : -tap, i >= 2 ? tap : -tap);
    vec2 uv = at(xz + o);
    h += topRange.x - vec2(texture2D(topDepth, uv).r, texture2D(solidDepth, uv).r) * topRange.y;
  }
  h *= 0.25;
  gl_FragColor = vec4(h, h);
}`;

/** One step of the flood: the highest of here and, this many texels towards the sun, there less the sun's rise. */
const FLOOD = /* glsl */ `
uniform sampler2D src;
uniform vec2 offset; // towards the sun, in the picture's own units
uniform vec4 drop; // how much the ray rises over that distance: noon's (r, g), dusk's (b, a)
varying vec2 vUv;
void main() {
  vec4 here = texture2D(src, vUv);
  vec2 q = vUv + offset;
  vec4 there = q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0 ? vec4(-1e4) : texture2D(src, q) - drop;
  gl_FragColor = max(here, there);
}`;

/** Into the stored picture: 0 to 1 over the range from the base (0: at or below it). */
const ENCODE = /* glsl */ `
uniform sampler2D src;
uniform vec2 code; // base, range
varying vec2 vUv;
void main() {
  gl_FragColor = clamp((texture2D(src, vUv) - code.x) / code.y, 0.0, 1.0);
}`;

/** A pass with its uniforms (their values are set for each use: the program keeps the object it was compiled with). */
function quad(fragmentShader: string, names: string[]): FullScreenQuad {
  const uniforms = Object.fromEntries(names.map((n) => [n, { value: null as unknown }]));
  return new FullScreenQuad(new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERTEX, fragmentShader, depthTest: false, depthWrite: false }));
}

/** Set a pass's uniforms' values. */
function set(q: FullScreenQuad, values: Record<string, unknown>): void {
  const u = (q.material as THREE.ShaderMaterial).uniforms;
  for (const [k, v] of Object.entries(values)) u[k].value = v;
}

class WallSun {
  /** What every patched material reads (for the checks) */
  readonly uniforms = U;
  private areas: Area[] = [];
  private reading: Area | null = null;
  private on = true;
  private renderer: THREE.WebGLRenderer | null = null;
  private noon = new THREE.Vector3();
  private dusk = new THREE.Vector3();
  private heights: FullScreenQuad | null = null;
  private flood: FullScreenQuad | null = null;
  private encode: FullScreenQuad | null = null;

  /** Off: the houses beyond the maps fully lit again (for comparing, briel.three.groundShade.wallSun). */
  set enabled(on: boolean) {
    this.on = on;
    this.pick(this.reading);
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Graphics memory the stored pictures take (MB), for the checks. */
  get megabytes(): number {
    return this.areas.reduce((t, a) => t + (a.picture ? (a.size * a.size * 4) / 1048576 : 0), 0);
  }

  /**
   * A ground bake's heights from above (world/groundShade.ts render), while its depth pictures still exist: made into
   * heights here, one pass, and the rest worked out in the frames after. The whole map's (too coarse for a wall) and the
   * Sparrenhof's (its wood and the café's own baked model) are left out. Baked again, an area replaces the one with the
   * same middle and size.
   */
  capture(renderer: THREE.WebGLRenderer, topDepth: THREE.Texture, solidDepth: THREE.Texture, topCam: THREE.OrthographicCamera, centre: THREE.Vector3,
    half: number, size: number, noon: THREE.Vector3): void {
    if (half > 900 || half < 200) return;
    this.renderer = renderer;
    this.noon.copy(noon).normalize();
    const old = this.areas.findIndex((a) => Math.abs(a.centre.x - centre.x) < 1 && Math.abs(a.centre.y - centre.z) < 1 && a.half === half);
    if (old >= 0) this.drop(this.areas.splice(old, 1)[0]);
    const n = Math.min(size / 2, PHONE ? 512 : 1024);
    const target = () => new THREE.WebGLRenderTarget(n, n, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    const area: Area = { centre: new THREE.Vector2(centre.x, centre.z), half, size: n, base: centre.y - BELOW, ping: target(), pong: target(), pass: 0, passes: 0, picture: null };
    const texel = (2 * half) / n;
    area.passes = Math.ceil(Math.log2(REACH / texel + 1)); // 1, 2, 4 ... texels: together the reach
    this.heights ??= quad(HEIGHTS, ['topDepth', 'solidDepth', 'topMatrix', 'topRange', 'area', 'tap']);
    set(this.heights, {
      topDepth,
      solidDepth,
      topMatrix: new THREE.Matrix4().multiplyMatrices(topCam.projectionMatrix, topCam.matrixWorldInverse),
      topRange: new THREE.Vector2(topCam.position.y - topCam.near, topCam.far - topCam.near),
      area: new THREE.Vector3(centre.x, centre.z, half),
      tap: texel / 4,
    });
    const before = renderer.getRenderTarget();
    renderer.setRenderTarget(area.ping);
    this.heights.render(renderer);
    renderer.setRenderTarget(before);
    set(this.heights, { topDepth: null, solidDepth: null }); // they are thrown away after the bake
    this.areas.push(area);
  }

  /**
   * Each frame (world/groundShade.ts follow): a few passes of an area being worked out, then which area is read and how
   * far the sun is down (`low`, 0 noon to 1 dusk; `dusk`: towards dusk's sun, the same compass side as noon's).
   */
  follow(eye: THREE.Vector3, low: number, dusk: THREE.Vector3): void {
    if (dusk.lengthSq() > 0) this.dusk.copy(dusk).normalize();
    this.work();
    U.wsCode.value.z = low;
    // The area whose edge is furthest from the eye, kept until another is clearly better (no flicking to and fro).
    let best = this.reading?.picture ? this.reading : null;
    const margin = (a: Area) => a.half - Math.max(Math.abs(eye.x - a.centre.x), Math.abs(eye.z - a.centre.y));
    for (const a of this.areas) {
      if (!a.picture || a === best) continue;
      if (!best || margin(a) > margin(best) + 30) best = a;
    }
    if (best !== this.reading) this.pick(best);
  }

  private pick(a: Area | null): void {
    this.reading = a;
    if (!a?.picture || !this.on) {
      U.wsMap.value = neutral;
      U.wsArea.value.w = 0;
      return;
    }
    U.wsMap.value = a.picture.texture;
    U.wsArea.value.set(a.centre.x, a.centre.y, a.half, 1);
    const across = Math.hypot(this.noon.x, this.noon.z) || 1;
    const tanNoon = this.noon.y / across;
    const tanDusk = this.dusk.y / (Math.hypot(this.dusk.x, this.dusk.z) || 1);
    U.wsRay.value.set(this.noon.x / across, this.noon.z / across, tanNoon, tanDusk);
    const texel = (2 * a.half) / a.size;
    U.wsCode.value.x = a.base;
    U.wsCode.value.y = RANGE;
    U.wsCode.value.w = 0.15 + 0.5 * texel * tanNoon; // soft by about half a texel of the picture
  }

  /** A few flood passes of the first area still being worked out, then its stored picture. */
  private work(): void {
    const a = this.areas.find((x) => !x.picture);
    const renderer = this.renderer;
    if (!a || !renderer || this.dusk.lengthSq() === 0 || this.noon.lengthSq() === 0) return;
    const before = renderer.getRenderTarget();
    const across = Math.hypot(this.noon.x, this.noon.z) || 1;
    const ax = this.noon.x / across;
    const az = this.noon.z / across;
    const tanNoon = this.noon.y / across;
    const tanDusk = this.dusk.y / (Math.hypot(this.dusk.x, this.dusk.z) || 1);
    const texel = (2 * a.half) / a.size;
    this.flood ??= quad(FLOOD, ['src', 'offset', 'drop']);
    for (let k = 0; k < PASSES_PER_FRAME && a.pass < a.passes; k++, a.pass++) {
      const step = 2 ** a.pass; // texels
      const metres = step * texel;
      set(this.flood, {
        src: a.ping!.texture,
        offset: new THREE.Vector2((ax * step) / a.size, (az * step) / a.size),
        drop: new THREE.Vector4(metres * tanNoon, metres * tanNoon, metres * tanDusk, metres * tanDusk),
      });
      renderer.setRenderTarget(a.pong);
      this.flood.render(renderer);
      [a.ping, a.pong] = [a.pong, a.ping];
    }
    if (a.pass >= a.passes) {
      const picture = new THREE.WebGLRenderTarget(a.size, a.size, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
      this.encode ??= quad(ENCODE, ['src', 'code']);
      set(this.encode, { src: a.ping!.texture, code: new THREE.Vector2(a.base, RANGE) });
      renderer.setRenderTarget(picture);
      this.encode.render(renderer);
      set(this.encode, { src: null });
      a.ping!.dispose();
      a.pong!.dispose();
      a.ping = a.pong = null;
      a.picture = picture;
      if (this.reading === a) this.pick(a);
    }
    renderer.setRenderTarget(before);
  }

  private drop(a: Area): void {
    a.ping?.dispose();
    a.pong?.dispose();
    a.picture?.dispose();
    if (this.reading === a) this.pick(null);
  }
}

export const wallSun = new WallSun();
