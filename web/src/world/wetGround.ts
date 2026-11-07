import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { groundNoise } from './groundNoise';
import { terrain } from './terrain';

/**
 * Wet ground in the rain and for a while after (world/weather.ts sets how wet: quickly up while it rains, drying over
 * a few minutes after). The roads, cycle paths, pavements, squares and yards turn darker and glossy, the low spots
 * first and the high spots dry first; puddles lie in the hollows and grow the longer it rains; on them the rain rings.
 *
 * - Where: every surface that faces up, of the materials that take it (`wetOn` in a material's onBeforeCompile:
 *   world/groundShade.ts for the ground covers and the streets; `wetOnModel` for the streets, pavements and yards of
 *   our own models). Walls take their wet from their bake (world/bakedLight.ts).
 * - The puddles: a soft noise in the world's own coordinates (two scales, about 23 m and 6 m), plus the hollows the
 *   ground's slow variation stands for. A threshold that falls as the ground gets wetter: the deepest hollows fill
 *   first, the shallow ones last, and they shrink back the same way as it dries. Only on flat ground.
 * - What they mirror: on Medium and up a second, smaller drawing of the scene mirrored in the ground's plane under the
 *   eye (WetMirror, a pass before the scene's own), at half the resolution: the sky, the houses, the trees, at night
 *   the street lamps, the lit windows and the cars' lights, where they really are. Damp ground (not a puddle) reads
 *   the same picture blurred and smeared towards the eye, as wet asphalt shows a lamp as a long streak. Low and phones
 *   mirror the sky's photo only (the scene's environment light, as every glossy surface does), which costs nothing.
 *   Why a mirror and not screen-space reflections: from a walker's eye most of what a puddle shows (the sky, the tops of
 *   the houses, the lamps' heads) is off the top of the screen, where screen space has nothing to give.
 * - Rain rings (Medium and up): in each cell of two grids (45 and 30 cm) a drop lands at its own moment, its ring runs
 *   out and fades; the puddle's normal follows the rings, so they bend what it mirrors. Worked out only on puddles,
 *   only while it rains.
 *
 * Everything bright that is mirrored is kept under what half floats hold (65504): an iPhone stores more as infinity.
 */

/** Shared by every material that takes the wet: the weather sets them, the mirror's pass fills in the picture. */
export const wet = {
  /** 0 to 1: how wet (world/weather.ts) */
  amount: { value: 0 },
  /** 0 to 1: how hard it rains now (the rings) */
  rain: { value: 0 },
  /** Seconds, for the rings (wrapped, so the float keeps its precision) */
  time: { value: 0 },
  /** The mirrored scene, and from world to its picture */
  mirror: { value: null as THREE.Texture | null },
  mirrorMatrix: { value: new THREE.Matrix4() },
  mirrorOn: { value: 0 },
  /** 1 on Medium and up: the rings (a branch on a uniform, the same for every pixel) */
  fine: { value: 1 },
  noise: { value: null as THREE.Texture | null },
};

/** Set by the weather each frame: whether the eye is indoors (no mirror drawn then). */
export const wetState = { indoors: false };

const PARS = /* glsl */ `
uniform float wetAmount;
uniform float wetRain;
uniform float wetTime;
uniform float wetFine;
uniform sampler2D wetNoise;
uniform sampler2D wetMirror;
uniform mat4 wetMirrorMatrix;
uniform float wetMirrorOn;
// Worked out once a pixel (wetSurface), used again where the light is put together (wetLight).
vec3 wetAt;
float wetK;
float wetPuddle;
float wetMirrorW;
vec3 wetBend;
vec2 wetHash2( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.xx + q.yz ) * q.zy );
}
// Rain rings on standing water: in each cell a drop lands at its own moment and place, its ring runs out and fades.
// Returns the slope of the water (x, z).
vec2 wetRings( vec2 p, float t, float rate ) {
  vec2 slope = vec2( 0.0 );
  vec2 cell = floor( p );
  for ( int j = -1; j <= 1; j ++ ) {
    for ( int i = -1; i <= 1; i ++ ) {
      vec2 c = cell + vec2( float( i ), float( j ) );
      vec2 h = wetHash2( c );
      vec2 h2 = wetHash2( c + 17.31 );
      if ( h2.x > rate ) continue; // in a lighter rain fewer cells have a drop
      float age = fract( t * ( 0.8 + 0.5 * h.x ) + h.y );
      vec2 d = p - c - ( 0.2 + 0.6 * h2.yx );
      float r = length( d ) + 1e-4;
      float x = r - age * 1.1; // from the ring's crest
      float fade = ( 1.0 - age ) * ( 1.0 - age ) * exp( - x * x * 28.0 );
      slope += d / r * cos( x * 34.0 ) * fade;
    }
  }
  return slope;
}
`;

/**
 * How a surface takes the wet. GLSL expressions, or numbers: `hollow` (-1 to 1) shifts the puddles' mask (the ground:
 * its hollows); `dark`: the colour wet, as a factor (porous stone and asphalt about half); `pools`: how much of it
 * fills with water at most (lawns little); `gloss`: how smooth it gets wet (0 to 1).
 */
export interface WetLook {
  hollow?: string;
  dark?: number | string;
  pools?: number | string;
  gloss?: number | string;
}

const num = (v: number | string) => (typeof v === 'number' ? v.toFixed(3) : v);

/** After the surface's colour, roughness and normal are known: wetter, darker, smoother; puddles flat, dark and mirror-like. */
const surface = (look: Required<WetLook>) => /* glsl */ `
wetK = 0.0;
wetPuddle = 0.0;
wetMirrorW = 0.0;
wetBend = vec3( 0.0 );
if ( wetAmount > 0.0 ) {
  vec3 wetN = normalize( ( vec4( nonPerturbedNormal, 0.0 ) * viewMatrix ).xyz );
  float wetUp = smoothstep( 0.2, 0.6, wetN.y );
  if ( wetUp > 0.0 ) {
    wetAt = cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz;
    float wetLow = texture2D( wetNoise, wetAt.xz * 0.043 ).r * 0.62 + texture2D( wetNoise, wetAt.xz * 0.17 + 0.31 ).r * 0.38;
    wetLow = clamp( wetLow + ${look.hollow}, 0.0, 1.0 );
    // Damp first in the low spots, the high ones dry first.
    wetK = wetUp * clamp( wetAmount * 1.7 - ( 1.0 - wetLow ) * 0.7, 0.0, 1.0 );
    // Puddles: the deepest hollows fill first and dry last; only where it is flat.
    float wetLevel = smoothstep( 0.3, 1.0, wetAmount ) * ${num(look.pools)} * smoothstep( 0.94, 0.985, wetN.y );
    if ( wetLevel > 0.0 ) {
      float wetEdge = 1.0 - 0.42 * wetLevel;
      wetPuddle = smoothstep( wetEdge, wetEdge + 0.045, wetLow );
      wetK = max( wetK, smoothstep( wetEdge - 0.08, wetEdge, wetLow ) ); // a darker rim round each
    }
    diffuseColor.rgb *= mix( 1.0, ${num(look.dark)}, wetK ) * ( 1.0 - 0.55 * wetPuddle );
    #ifdef STANDARD
      roughnessFactor = mix( roughnessFactor, mix( roughnessFactor, clamp( roughnessFactor * 0.35, 0.1, 0.32 ), ${num(look.gloss)} ), wetK );
      roughnessFactor = mix( roughnessFactor, 0.02, wetPuddle );
    #endif
    // Water fills the grain: the relief flattens; a puddle is flat but for the rings.
    vec3 wetFlat = nonPerturbedNormal;
    if ( wetPuddle > 0.0 && wetRain > 0.0 && wetFine > 0.5 ) {
      vec2 wetSlope = wetRings( wetAt.xz / 0.45, wetTime, wetRain ) + wetRings( wetAt.xz / 0.3 + 7.7, wetTime * 1.3 + 0.5, wetRain * 0.8 );
      wetSlope *= 0.09 * wetRain;
      wetFlat = normalize( ( viewMatrix * vec4( - wetSlope.x, 1.0, - wetSlope.y, 0.0 ) ).xyz );
    }
    normal = normalize( mix( normal, nonPerturbedNormal, 0.6 * wetK ) );
    normal = normalize( mix( normal, wetFlat, wetPuddle ) );
    wetBend = normal - nonPerturbedNormal;
  }
}
`;

/**
 * Where the light is put together: the reflection is the mirror's picture (Medium and up), sharp on a puddle, blurred
 * and smeared towards the eye on damp ground. Before three's lights_fragment_end, which weighs it by the angle (fresnel).
 */
const LIGHT = /* glsl */ `
#if defined( RE_IndirectSpecular )
if ( wetMirrorOn > 0.0 && wetK + wetPuddle > 0.0 ) {
  vec4 wetM = wetMirrorMatrix * vec4( wetAt, 1.0 );
  vec2 wetUv = wetM.xy / wetM.w + wetBend.xy * vec2( 0.25, 0.5 );
  vec2 wetIn = smoothstep( vec2( 0.0 ), vec2( 0.04 ), wetUv ) * smoothstep( vec2( 1.0 ), vec2( 0.96 ), wetUv );
  float wetRough = material.roughness;
  float wetLod = clamp( wetRough * 9.0 - 0.4, 0.0, 6.0 );
  vec3 wetPicture = textureLod( wetMirror, wetUv, wetLod ).rgb;
  if ( wetRough > 0.12 ) {
    // A streak: the picture smeared along the screen's height, longer the rougher.
    float wetLen = wetRough * 0.09;
    wetPicture = wetPicture * 0.4 + 0.3 * ( textureLod( wetMirror, wetUv + vec2( 0.0, wetLen ), wetLod ).rgb + textureLod( wetMirror, wetUv - vec2( 0.0, wetLen ), wetLod ).rgb );
  }
  wetMirrorW = clamp( wetPuddle + wetK, 0.0, 1.0 ) * wetIn.x * wetIn.y;
  radiance = mix( radiance, min( wetPicture, vec3( 20000.0 ) ), wetMirrorW );
}
#endif
`;

const CLAMP = 'gl_FragColor.rgb = min( gl_FragColor.rgb, vec3( 60000.0 ) );';

interface Shader {
  uniforms: Record<string, { value: unknown }>;
  fragmentShader: string;
}

/**
 * Let this material's surfaces take the wet (in its onBeforeCompile; once is enough, again does nothing). The
 * variables `wetK`, `wetPuddle` and `wetMirrorW` are there after it for the rest of the shader.
 */
export function wetOn(shader: Shader, look: WetLook = {}): void {
  const f = shader.fragmentShader;
  if (shader.uniforms.wetAmount || !f.includes('#include <normal_fragment_maps>') || !f.includes('#include <lights_fragment_end>')) return;
  wet.noise.value ??= groundNoise();
  Object.assign(shader.uniforms, {
    wetAmount: wet.amount, wetRain: wet.rain, wetTime: wet.time, wetFine: wet.fine, wetNoise: wet.noise,
    wetMirror: wet.mirror, wetMirrorMatrix: wet.mirrorMatrix, wetMirrorOn: wet.mirrorOn,
  });
  const full: Required<WetLook> = { hollow: '0.0', dark: 0.55, pools: 1, gloss: 1, ...look };
  shader.fragmentShader = f
    .replace('#include <common>', `#include <common>\n${PARS}`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${surface(full)}`)
    .replace('#include <lights_fragment_end>', `${LIGHT}\n#include <lights_fragment_end>`)
    .replace('#include <dithering_fragment>', f.includes(CLAMP) ? '#include <dithering_fragment>' : `${CLAMP}\n#include <dithering_fragment>`);
}

const patched = new WeakSet<THREE.Material>();

/** A whole material takes the wet (outdoor surfaces only: a street, a yard). Its program is told apart from the same material dry. */
export function wetty<T extends THREE.Material>(m: T, look: WetLook = {}): T {
  if (patched.has(m)) return m;
  patched.add(m);
  const before = m.onBeforeCompile;
  const key = m.customProgramCacheKey(); // as it is now: its own onBeforeCompile's, before this one wraps it
  m.onBeforeCompile = (shader, renderer) => {
    before.call(m, shader, renderer);
    wetOn(shader, look);
  };
  m.customProgramCacheKey = () => `${key}|wet${look.pools ?? 1}`;
  m.needsUpdate = true;
  return m;
}

/**
 * Our own models' streets, pavements, yards and terraces, by their name in the model (world/snowCover.ts names the
 * same). Their baked parts are left alone: the bake darkens them when wet.
 */
const MODEL_PARTS: [RegExp, WetLook][] = [
  [/^mh_(asphalt|pavers)$/, {}], // Molenhoek's and Kapellenhoek's streets, cycle paths and pavements
  [/^school_yard$/, {}], // the playground
  [/^caf_slabs$/, {}], // the café's path of slabs
  [/^kouter_(gravel|paving)$/, { dark: 0.65 }], // the house on the Kouter's
  [/_hs_slab$/, {}], // the terraces of the houses at home
];

/** Give a loaded model's streets and yards the wet (see MODEL_PARTS). Before or after its bake. */
export function wetOnModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || mesh.geometry.attributes.uv1) return;
    const look = MODEL_PARTS.find(([name]) => name.test(mesh.name))?.[1];
    if (!look) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) wetty(m, look);
  });
}

/** Seconds the rings' clock runs before it wraps (a whole number of every cell's cycles is not needed: a jump once in 17 minutes). */
const WRAP = 1000;

/**
 * The mirrored scene for the puddles, drawn before the scene each frame (the composer's first pass) while the ground
 * is wet, the eye outdoors and the preset Medium or up. The ground's plane is the relief's height under the eye; the
 * picture is clipped to what lies above it (an oblique near plane, as three.js's Reflector does), at half the scene's
 * resolution, with its mip levels for the blur of damp ground. The eye's own things (the weapon in the hands), the
 * rain and the snow round it are left out of it.
 */
export class WetMirror extends Pass {
  private target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
  });
  private eye = new THREE.PerspectiveCamera();
  private dummy = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  private plane = new THREE.Plane();
  private clip = new THREE.Vector4();
  private q = new THREE.Vector4();
  private v = new THREE.Vector3();
  private look = new THREE.Vector3();
  /** Medium and up, not a phone */
  fine = true;

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private hide: THREE.Object3D[], private ground: number) {
    super();
    this.needsSwap = false;
    this.clear = false;
    this.dummy.needsUpdate = true;
    this.target.texture.name = 'wetMirror';
    wet.mirror.value = this.dummy;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }

  render(renderer: THREE.WebGLRenderer): void {
    wet.time.value = (performance.now() / 1000) % WRAP;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const eye = this.v.setFromMatrixPosition(cam.matrixWorld);
    const y0 = this.ground + terrain.height(eye.x, eye.z) + 0.02;
    if (!this.fine || wet.amount.value < 0.03 || wetState.indoors || eye.y < y0 + 0.2) {
      wet.mirrorOn.value = 0;
      wet.mirror.value = this.dummy;
      return;
    }
    // The eye mirrored in the plane y = y0, looking the mirrored way.
    const m = this.eye;
    m.position.set(eye.x, 2 * y0 - eye.y, eye.z);
    this.look.set(0, 0, -1).transformDirection(cam.matrixWorld);
    this.look.y = -this.look.y;
    m.up.set(0, 1, 0).transformDirection(cam.matrixWorld);
    m.up.y = -m.up.y;
    m.lookAt(this.look.add(m.position));
    m.far = cam.far;
    m.layers.mask = cam.layers.mask;
    m.updateMatrixWorld();
    m.projectionMatrix.copy(cam.projectionMatrix);
    m.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    // From the world to the picture (before its near plane is tilted).
    wet.mirrorMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(m.projectionMatrix).multiply(m.matrixWorldInverse);
    // The near plane laid on the ground's plane: nothing under it is drawn (Lengyel's oblique projection).
    this.plane.set(new THREE.Vector3(0, 1, 0), -y0).applyMatrix4(m.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = m.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + p[8]) / p[0], (Math.sign(this.clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    p[2] = this.clip.x;
    p[6] = this.clip.y;
    p[10] = this.clip.z + 1;
    p[14] = this.clip.w;

    const was = renderer.getRenderTarget();
    const shadows = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false; // the scene's own drawing draws the sun's shadow map this frame, as before
    wet.mirrorOn.value = 0;
    wet.mirror.value = this.dummy; // never read from the picture being drawn
    const shown = this.hide.map((o) => o.visible);
    for (const o of this.hide) o.visible = false;
    renderer.setRenderTarget(this.target);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear();
    renderer.render(this.scene, m);
    this.hide.forEach((o, i) => (o.visible = shown[i]));
    renderer.setRenderTarget(was);
    renderer.shadowMap.needsUpdate = shadows;
    wet.mirror.value = this.target.texture;
    wet.mirrorOn.value = 1;
  }

  dispose(): void {
    this.target.dispose();
    this.dummy.dispose();
  }
}
