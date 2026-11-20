import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { gpuName, guessFromName } from '../graphics';
import { daylight } from './daylight';
import { BALL_FRAMES, MistPool, WISP_FRAMES } from './spiritMist';
import { ARMS, LIP_OPEN, LIP_SHUT, bodyMaterial, heartMaterial, leafMaterial, spiritHalf, spiritMaps, spiritUniforms, useMaps, type SpiritMaps } from './spiritSkin';
import { PARTICLE, particleSheet } from './sprites';

/**
 * The brook spirit's look: a floating creature of mist for the woods by the brook (working name, in code only).
 * Our own design, a spirit of the brook valley in November, close to the will-o'-the-wisps of the marsh tales:
 * a boss: a rolling mass of dark mist about 5 m across with a lantern-like heart inside, seven thick tendrils of
 * 6 to 8 m rising out of it in arches and curling down, and fallen leaves and drops of brook water drawn up in a
 * slow spiral round it. Meant to float with its middle 3.5 to 4.5 m above the ground, so players look up at it.
 *
 * Only how it is drawn and moves: no rules, no health, no attacks. The rules drive a few inputs:
 * - `group`: where it floats (the middle of the body) and which way it faces (rotation.y; its front is +z).
 * - `open` 0..1: how far the mist and the dark core open over the heart (the heart is what a player aims at).
 * - `shield` 0..1: the ring of leaves and drops closed into a storm round it.
 * - `anger` 0..1: its cold green-white light turns amber; it moves faster.
 * - `reach`: a point in the world its two long front tendrils reach for, or null. Set at the start of a tell: the
 *   front tendrils first rear up and draw back (about 0.4 s, their nodes flaring), then point at it.
 * - `fade` 0..1: coming apart from the tips inward, its edges glowing, into mist and rising lights.
 * - `ground`: the ground's height under it, for a soft dark patch there (null: none).
 * - `hurt(strength, at?)`: a sharp flinch that ripples out along the tendrils; `at`, where it was hit, flares the
 *   storm there while it shields itself.
 * open, shield and anger ease towards what they are set to (a few tenths of a second), so the rules may set them as
 * 0 or 1; fade is shown as it is set (the rules animate it).
 *
 * How it is drawn (cheapest where it covers the most pixels):
 * - The model (tools/brook_spirit.py, public/models/brook-spirit.glb) with its maps (world/spiritSkin.ts): a
 *   sculpt baked onto a game model, near (about 48 000 triangles) and far (about 4 000). The tendrils are modelled
 *   straight; the vertex shader bends each along a curve of a few numbers a frame (an arch, a curl at the tip, two
 *   waves running out from the root, the follow-through of its motion, a reach, a flinch), so they need no bones (as
 *   some big games drive tentacles as effects tied to the creature's state). The core's opening closes in its vertex
 *   shader. Lit as the world is (sun, sky, reflections, fog), wet, glowing where it glows.
 * - The mist (world/spiritMist.ts): soft sprites cut from a flipbook of a real volume of mist rendered in Blender
 *   (tools/brook_spirit_mist.py), lit from six ways by the scene's sun and sky and by the heart, blended between
 *   frames, sorted back to front, one draw: dark dense lobes at the heart of the cloud, lighter torn ones round them,
 *   long wisps hanging between the tendrils that trail behind as it moves, and a veil in front of the heart that
 *   parts when it opens (40 over the body on Medium and up, 16 on Low). The solid parts take a haze of the cloud they
 *   lie in, so they go softly into it. On Low (and phones) also a single dark shell with moving bumps.
 * - Light: drifting will-o'-the-wisp lights and a halo round the heart in a second, additive draw; the heart, the
 *   nodes under the tendrils and the hollow behind the opening glow (the game's bloom picks them up, Medium and up;
 *   every value stays far under the half floats' 65504). One small point light on Medium and up on a graphics card
 *   (spiritLightFits), none on Low; put in the scene once at the start with prepareSpiritLight, so the creature
 *   appearing never makes three compile the materials again.
 * - The leaves (oak, beech, birch, alder) and drops: two instanced meshes. Shielding, they race round in bands with
 *   the torn mist, the drops drawn out into streaks, over a faint uneven skin that flares where it is hit.
 * - A soft dark patch on the ground under it.
 * Draw calls: 8 on Medium and up, 9 on Low (its body of mist), one more while it shields itself.
 */

export type SpiritLook = 'low' | 'high';

/** One tendril's frame as tools/brook_spirit.py modelled it (glTF axes, m): straight from its root along `dir`. */
interface Arm {
  root: THREE.Vector3;
  dir: THREE.Vector3;
  up: THREE.Vector3;
  side: THREE.Vector3;
  length: number;
  radius: number;
}

interface Parts {
  heart: THREE.BufferGeometry;
  core: THREE.BufferGeometry;
  tendrils: THREE.BufferGeometry;
}

export interface BrookSpiritModel {
  near: Parts;
  far: Parts;
  arms: Arm[];
  /** One curled leaf card and a drawn-out drop, for the ring. */
  leaf: THREE.BufferGeometry;
  drop: THREE.BufferGeometry;
  /** The maps it was loaded with (full size, or half on phones and tablets). */
  maps: SpiritMaps;
  renderer?: THREE.WebGLRenderer;
}

/** Within this distance from the core's middle (m), along the line of sight, no mist sprite is drawn. */
const CORE_CLEAR = 1.35;
/** The ring of leaves and drops: radius (m), and the shell's. */
const RING = 3.6;
const SHELL = 3.3;
/** Beyond this (m) the far model is drawn. */
const FAR = { low: 24, high: 45 };
/** The heart's middle in the body (tools/brook_spirit.py HZ). */
const HEART_Z = 0.18;
/** How fast the flipbook plays (frames a second at a sprite's own rate 1). */
const MIST_FPS = 5;

/** The light inside it: cold green-white, and amber when angered (linear). */
const COLD = new THREE.Color('#c9ffe2');
const AMBER = new THREE.Color('#ffa63a');
/** The mist's own darkness: near black at the heart of the cloud, charcoal lobes, blue-grey torn edges (albedo). */
const MIST_CORE = new THREE.Color(0.03, 0.032, 0.036);
const MIST_DENSE = new THREE.Color(0.05, 0.053, 0.058);
const MIST_THIN = new THREE.Color(0.1, 0.106, 0.115);
const MIST_LOW = new THREE.Color('#2c343b');

/**
 * Whether its point light suits this graphics chip: a graphics card, not an integrated chip, where it costs about
 * 0.6 ms a frame (it lights every lit pixel on the screen). For the constructor's `withLight`.
 */
export function spiritLightFits(renderer: THREE.WebGLRenderer): boolean {
  const q = guessFromName(gpuName(renderer));
  return q === 'high' || q === 'ultra';
}

let lamp: THREE.PointLight | null = null;

/**
 * Its point light, made once and put in the scene with no strength: call at the game's start (where spiritLightFits
 * says it suits the chip). Three compiles every lit material again whenever the scene's number of lights changes; with
 * this light in the scene from the start, making, showing or hiding the creature changes nothing there. The creature
 * then moves it to its heart and lights it each frame, and turns it off when it fades out or is disposed of. Without
 * it, a creature with `withLight` brings a light of its own (and that recompile when it appears).
 */
export function prepareSpiritLight(scene: THREE.Scene): THREE.PointLight {
  if (!lamp) {
    lamp = new THREE.PointLight(COLD, 0, 20, 2);
    lamp.name = 'brook-spirit-light';
    lamp.userData.ignoreRay = true;
  }
  if (lamp.parent !== scene) scene.add(lamp);
  return lamp;
}

let job: Promise<BrookSpiritModel | null> | null = null;

/**
 * The model and its maps, fetched once; null if the model can't be. With `renderer`, the maps come as KTX2 where the
 * browser can transcode them (they stay compressed on the graphics chip), otherwise as WebP.
 */
export function loadBrookSpirit(url = '/models/brook-spirit.glb', renderer?: THREE.WebGLRenderer): Promise<BrookSpiritModel | null> {
  return (job ??= new GLTFLoader().loadAsync(url).then(
    async (gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const take = (name: string, role: 'heart' | 'core' | 'tendrils' | 'other'): THREE.BufferGeometry => {
        const o = gltf.scene.getObjectByName(name) as THREE.Mesh;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        // Our own names for the extra numbers on the corners: (t, arm) on the tendrils, (inside, 0) on the core.
        const uv1 = g.getAttribute('uv1');
        if (role === 'tendrils') g.setAttribute('aArm', uv1);
        else if (role === 'core') g.setAttribute('aInside', uv1);
        if (uv1) g.deleteAttribute('uv1');
        if (role !== 'other') g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), role === 'tendrils' ? 11 : 2.2);
        return g;
      };
      const src = gltf.scene.getObjectByName('Tendrils')!;
      const arms = (JSON.parse(String(src.userData.arms)) as { root: number[]; dir: number[]; up: number[]; side: number[]; length: number; radius: number }[]).map((a) => ({
        root: new THREE.Vector3().fromArray(a.root),
        dir: new THREE.Vector3().fromArray(a.dir),
        up: new THREE.Vector3().fromArray(a.up),
        side: new THREE.Vector3().fromArray(a.side),
        length: a.length,
        radius: a.radius,
      }));
      const maps = spiritMaps(spiritHalf, renderer);
      await maps.ready;
      return {
        near: { heart: take('Heart', 'heart'), core: take('Core', 'core'), tendrils: take('Tendrils', 'tendrils') },
        far: { heart: take('HeartFar', 'heart'), core: take('CoreFar', 'core'), tendrils: take('TendrilsFar', 'tendrils') },
        arms,
        leaf: take('Leaf', 'other'),
        drop: take('Drop', 'other'),
        maps,
        renderer,
      };
    },
    () => null,
  ));
}

// ---------------------------------------------------------------------------------------------- the glow's sprites

/** Camera-facing sprites from the effects sheet (the lights round it); slid off the core along their line of sight. */
const SPRITE_VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iSize;
attribute vec4 iColor;
uniform vec4 uCore;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec4 cc = modelViewMatrix * vec4(uCore.xyz, 1.0);
  float d = -mv.z;
  float dc = -cc.z;
  float k = 1.0;
  if (abs(d - dc) < uCore.w && d > 0.05) {
    float nd = d < dc ? max(dc - uCore.w, 0.06) : dc + uCore.w;
    k = nd / d;
    mv.xyz *= k;
  }
  float cs = cos(iSize.z);
  float sn = sin(iSize.z);
  vec2 c = position.xy * iSize.xy * k;
  mv.xy += vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
  gl_Position = projectionMatrix * mv;
  vec2 cell = vec2(mod(iSize.w, 2.0), 1.0 - floor(iSize.w / 2.0));
  vUv = (position.xy + 0.5 + cell) * 0.5;
  vColor = iColor;
  vec4 mvPosition = mv;
  #include <fog_vertex>
}`;

const SPRITE_FRAGMENT = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  vec3 col = vColor.rgb * t.rgb;
  float a = vColor.a * t.a;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col *= 1.0 - fogF;
  #endif
  gl_FragColor = vec4(col * a, 1.0);
}`;

/**
 * The shell: a storm more than a skin. Streaks of water race round it in bands, the next band the other way,
 * densest round the middle; the skin itself only shows faintly and unevenly, moving; where it is hit it flares.
 */
const SHELL_VERTEX = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mvPosition.xyz);
  vP = position;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uLight;
uniform float uShield;
uniform float uTime;
uniform vec4 uHit;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_fragment>
void main() {
  vec3 d = normalize(vP);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float lon = atan(d.z, d.x);
  float f = 1.0 - abs(dot(normalize(vN), vV));
  // Two sheets of thin streaks racing round the opposite ways, one or the other by latitude (no hard band edge),
  // each streak broken along its length; only round the middle.
  float wave = sin(lat * 7.0 + sin(lon * 2.0 + uTime * 0.5));
  float lane = sin(lat * 40.0 + wave * 2.0);
  float east = pow(0.5 + 0.5 * sin(lon * 7.0 + uTime * 2.6 + lat * 5.0), 16.0);
  float west = pow(0.5 + 0.5 * sin(lon * 6.0 - uTime * 2.2 - lat * 4.0 + 1.7), 16.0);
  float streak = mix(east, west, 0.5 + 0.5 * wave) * smoothstep(0.2, 0.9, lane);
  float middle = 1.0 - smoothstep(0.2, 1.1, abs(lat));
  float uneven = 0.5 + 0.5 * sin(d.x * 6.0 + uTime * 1.3) * sin(d.y * 7.0 - uTime * 0.9) * sin(d.z * 5.0 + uTime * 1.1);
  // A hit: a bright spot and a ring running out from it.
  float near = 1.0 - dot(d, uHit.xyz);
  float hit = uHit.w * (exp(-near * 40.0) + 0.5 * exp(-pow((near - (1.5 - uHit.w) * 0.2) * 25.0, 2.0)));
  float a = 0.22 * pow(f, 3.0) * uneven * uneven + streak * middle * (0.35 + 0.4 * f) + hit * 2.5;
  vec3 c = uLight * uShield * a;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      c *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      c *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(c, 1.0);
}`;

/** The soft dark patch on the ground under it, so it sits in the wood: darkest under its middle, no edge. */
const PATCH_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PATCH_FRAGMENT = /* glsl */ `
uniform float uDark;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q) * (1.0 + 0.06 * sin(atan(q.y, q.x) * 5.0 + uTime * 0.4));
  float a = uDark * pow(1.0 - smoothstep(0.0, 1.0, r), 1.6);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

/** Low's body: one dark shell with slow moving bumps, see-through at its edge and over the heart when open. */
const VEIL_VERTEX = /* glsl */ `
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vO;
#include <fog_pars_vertex>
void main() {
  vec3 p = position;
  float bump = sin(p.x * 3.0 + uTime * 0.6) * sin(p.y * 2.6 - uTime * 0.5) * sin(p.z * 2.9 + uTime * 0.4);
  float bump2 = sin(p.x * 5.3 - uTime * 0.9) * sin(p.z * 4.7 + p.y * 3.1 + uTime * 0.7);
  p += normal * (bump * 0.3 + bump2 * 0.12);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mvPosition.xyz);
  vO = normal;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const VEIL_FRAGMENT = /* glsl */ `
uniform vec3 uMist;
uniform vec3 uLight;
uniform float uOpen;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
varying vec3 vO;
#include <fog_pars_fragment>
void main() {
  float f = abs(dot(normalize(vN), vV));
  float front = smoothstep(0.55, 0.9, vO.z);
  float a = uAlpha * smoothstep(0.05, 1.0, f) * (1.0 - uOpen * front);
  vec3 c = uMist * (0.7 + 0.5 * vO.y) + uLight * front * (0.04 + 0.12 * uOpen);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      c = mix(c, fogColor, 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth));
    #else
      c = mix(c, fogColor, smoothstep(fogNear, fogFar, vFogDepth));
    #endif
  #endif
  gl_FragColor = vec4(c, a);
}`;

// ---------------------------------------------------------------------------------------------- the sprites

/** A repeatable random sequence (the same creature every visit). */
function random(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

type Layer = 'dense' | 'wisp' | 'trail' | 'veil' | 'mote' | 'halo';

interface Sprite {
  layer: Layer;
  /** Where on its orbit it starts, and the axis it rolls round (the mist turning over). */
  dir: THREE.Vector3;
  axis: THREE.Vector3;
  speed: number;
  radius: number;
  size: number;
  /** Taller than wide (wisps hanging down) */
  stretch: number;
  alpha: number;
  cell: number;
  rot: number;
  spin: number;
  seed: number;
  /** Its own place in the flipbook's loop and how fast it plays it. */
  frame: number;
  rate: number;
  /** Where it is in the world now: it follows its place at `follow` per second, so the mist trails as it moves. */
  at: THREE.Vector3;
  follow: number;
  placed: boolean;
}

/** The lights round it: additive sprites of the game's effects sheet. */
class GlowPool {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private iPos: THREE.InstancedBufferAttribute;
  private iSize: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute;
  count = 0;

  constructor(capacity: number, map: THREE.Texture, shared: { uCore: { value: THREE.Vector4 } }) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', (this.iPos = attr(3)));
    this.geo.setAttribute('iSize', (this.iSize = attr(4)));
    this.geo.setAttribute('iColor', (this.iColor = attr(4)));
    this.geo.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: map }, uCore: shared.uCore },
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
    });
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.raycast = () => {};
    this.mesh.userData.ignoreRay = true;
  }

  begin(): void {
    this.count = 0;
  }

  put(p: THREE.Vector3, sx: number, sy: number, rot: number, cell: number, c: THREE.Color, a: number): void {
    const i = this.count++;
    this.iPos.setXYZ(i, p.x, p.y, p.z);
    this.iSize.setXYZW(i, sx, sy, rot, cell);
    this.iColor.setXYZW(i, c.r, c.g, c.b, a);
  }

  end(): void {
    for (const a of [this.iPos, this.iSize, this.iColor]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * a.itemSize);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = this.count;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** How many of each, Medium and up / Low. The dense, wisp, trail and veil sprites are the mist (40 at most, 16 on Low). */
const COUNTS = {
  high: { dense: 18, wisp: 12, trail: 6, veil: 4, mote: 14, leaves: 160, drops: 70 },
  low: { dense: 7, wisp: 5, trail: 2, veil: 2, mote: 6, leaves: 50, drops: 24 },
};

// ---------------------------------------------------------------------------------------------- the creature

/** One tendril's bend this frame: the shader's uBendA, uBendB and uArmX. */
interface Bend {
  a0: number;
  a1: number;
  curl: number;
  wa: number;
  b0: number;
  b1: number;
  wb: number;
  phase: number;
  stretch: number;
  thick: number;
  /** A flinch's ripple: where along the arm its kink is (0 root .. 1 tip) and how strong. */
  rippleAt: number;
  ripple: number;
  /** Follow-through: springs (value, speed) for the sideways lag of turning and the drag of moving. */
  lag: number;
  lagV: number;
  dragU: number;
  dragUV: number;
  dragS: number;
  dragSV: number;
}

/**
 * Each tendril's arch at rest (radians): its turn up at the root (negative is up), how far it bends down along its
 * length, and its tip's curl under. The two front ones rise highest and reach forward, as if about to strike; the
 * others differ a little each, so the outline is uneven.
 */
const ARCH: [number, number, number][] = [
  [-0.95, 1.3, 1.9],
  [-0.9, 1.25, 2.0],
  [-0.7, 1.9, 2.0],
  [-0.5, 2.1, 1.8],
  [-0.45, 2.2, 2.2],
  [-0.65, 1.8, 1.9],
  [-0.55, 2.0, 1.7],
];

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const LEAF_KINDS = 4;

const ease = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (x: number, a: number, b: number) => THREE.MathUtils.smoothstep(x, a, b);

export class BrookSpirit {
  /** Where it floats: the middle of its body. rotation.y turns it; its front is +z. */
  readonly group = new THREE.Group();
  /** 0..1, see the file's comment. */
  open = 0;
  shield = 0;
  anger = 0;
  fade = 0;
  /** A point in the world its two front tendrils reach for, or null. */
  reach: THREE.Vector3 | null = null;
  /** The height of the ground under it in the world, for the soft dark patch there; null for none. */
  ground: number | null = null;

  /** What is shown now (eased towards the inputs). */
  private shown = { open: 0, shield: 0, anger: 0, reach: 0 };
  private reachAt = new THREE.Vector3();
  /** Seconds since `reach` was set (the tell's timeline), -1 while it is not. */
  private reachT = -1;
  private rear = 0;
  private hurtT = 0;
  private hitT = 0;
  private time = 0;
  private phase = 0;
  private pulse = 0;
  private look: SpiritLook;
  private far = false;
  private maps: SpiritMaps;

  private body = new THREE.Group();
  private heart: THREE.Mesh;
  private core: THREE.Mesh;
  private tendrils: THREE.Mesh;
  private mist: MistPool;
  private glow: GlowPool;
  private veil: THREE.Mesh;
  private shell: THREE.Mesh;
  private patch: THREE.Mesh;
  private leaves: THREE.InstancedMesh;
  private drops: THREE.InstancedMesh;
  private light: THREE.PointLight | null = null;
  private sprites: Sprite[] = [];
  private order: number[] = [];
  private depth: number[] = [];
  private ring: { u: number; r: number; h: number; tilt: number; spin: THREE.Vector3; size: number; lat: number; lift: number }[] = [];

  private lightColor = new THREE.Color();
  private uniforms = spiritUniforms();
  private shared = {
    uCore: { value: new THREE.Vector4(0, 0, 0, CORE_CLEAR) },
    uHeart: { value: new THREE.Vector3(0, 0, HEART_Z) },
    uInner: { value: new THREE.Color() },
    uHole: { value: new THREE.Vector2() },
    uTime: { value: 0 },
  };
  private heartU = { uHeart: { value: 1 } };
  private shellU = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uLight: this.uniforms.uLight,
    uShield: { value: 0 },
    uTime: this.shared.uTime,
    uHit: { value: new THREE.Vector4(0, 0, 1, 0) },
  };
  private patchU = { uDark: { value: 0 }, uTime: this.shared.uTime };
  private veilU = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uLight: this.uniforms.uLight,
    uMist: { value: new THREE.Color() },
    uOpen: { value: 0 },
    uAlpha: { value: 0.9 },
    uTime: this.shared.uTime,
  };

  /**
   * `withLight`: its point light on Medium and up. It lights every lit pixel on the screen a little (measured about
   * 0.6 ms a frame on this PC's integrated chip, nothing to see on the graphics card); turning it on or off later
   * changes the scene's number of lights, which makes three.js compile every material again, so it is chosen here.
   */
  constructor(private model: BrookSpiritModel, look: SpiritLook = 'high', private withLight = true) {
    this.look = look;
    this.maps = model.maps;
    model.arms.forEach((a, i) => {
      this.uniforms.uFrame.value[i * 4].set(a.root.x, a.root.y, a.root.z, a.length);
      this.uniforms.uFrame.value[i * 4 + 1].set(a.dir.x, a.dir.y, a.dir.z, a.radius);
      this.uniforms.uFrame.value[i * 4 + 2].set(a.up.x, a.up.y, a.up.z, 0);
      this.uniforms.uFrame.value[i * 4 + 3].set(a.side.x, a.side.y, a.side.z, 0);
    });
    this.group.add(this.body);

    // The heart: a lantern with light of its own. The core and the tendrils: lit as the world is, with their maps.
    this.heart = new THREE.Mesh(model.near.heart, heartMaterial(this.uniforms, this.heartU, this.maps.body));
    this.core = new THREE.Mesh(model.near.core, bodyMaterial('core', this.uniforms, this.maps.body));
    this.tendrils = new THREE.Mesh(model.near.tendrils, bodyMaterial('tendrils', this.uniforms, this.maps.tendril));
    this.body.add(this.heart, this.core, this.tendrils);

    // Low's body of mist: a dark shell (drawn before the sprites).
    this.veil = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 3).scale(2.0, 1.45, 1.8),
      new THREE.ShaderMaterial({ uniforms: this.veilU, vertexShader: VEIL_VERTEX, fragmentShader: VEIL_FRAGMENT, transparent: true, depthWrite: false, fog: true }),
    );
    this.veil.renderOrder = 1;
    this.body.add(this.veil);

    this.mist = new MistPool(48, this.maps.mist, this.shared);
    this.glow = new GlowPool(24, particleSheet(), this.shared);
    this.group.add(this.mist.mesh, this.glow.mesh);

    // The ring: leaves (oak, beech, birch, alder) and drops of water.
    const rnd = random(23);
    const leafGeo = model.leaf.clone();
    const kinds = new Float32Array(COUNTS.high.leaves);
    for (let i = 0; i < kinds.length; i++) kinds[i] = Math.floor(rnd() * LEAF_KINDS);
    leafGeo.setAttribute('aLeaf', new THREE.InstancedBufferAttribute(kinds, 1));
    this.leaves = new THREE.InstancedMesh(leafGeo, leafMaterial(this.maps.body), COUNTS.high.leaves);
    const shade = new THREE.Color();
    for (let i = 0; i < COUNTS.high.leaves; i++) this.leaves.setColorAt(i, shade.setScalar(0.75 + rnd() * 0.45));
    // Drops: a bead drawn out behind, longer still in the storm.
    this.drops = new THREE.InstancedMesh(model.drop, new THREE.MeshStandardMaterial({ color: '#6f8d9c', roughness: 0.06, metalness: 0.0, emissive: '#000000' }), COUNTS.high.drops);
    for (let i = 0; i < COUNTS.high.leaves + COUNTS.high.drops; i++) {
      // In the shell: a latitude mostly near the middle (the storm's densest band), the next band racing the other way.
      const v = rnd() * 2 - 1;
      this.ring.push({
        u: rnd(), r: RING * (0.94 + rnd() * 0.12), h: rnd(), tilt: (rnd() - 0.5) * 0.18, spin: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
        size: 0.8 + rnd() * 0.5, lat: Math.sign(v) * Math.abs(v) ** 1.8 * 1.25, lift: 0.94 + rnd() * 0.12,
      });
    }
    for (const m of [this.leaves, this.drops]) m.frustumCulled = false;
    this.group.add(this.leaves, this.drops);
    this.shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(SHELL, 3),
      new THREE.ShaderMaterial({
        uniforms: this.shellU, vertexShader: SHELL_VERTEX, fragmentShader: SHELL_FRAGMENT, transparent: true, depthWrite: false, fog: true,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      }),
    );
    this.shell.renderOrder = 4;
    this.group.add(this.shell);
    this.patch = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({ uniforms: this.patchU, vertexShader: PATCH_VERTEX, fragmentShader: PATCH_FRAGMENT, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.patch.renderOrder = 1;
    this.group.add(this.patch);
    for (const m of [this.heart, this.core, this.tendrils, this.veil, this.shell, this.patch, this.leaves, this.drops]) m.raycast = () => {};
    this.group.traverse((o) => (o.userData.ignoreRay = true));

    this.makeSprites();
    this.setLook(look);
  }

  private makeSprites(): void {
    const rnd = random(7);
    const v = () => new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const add = (layer: Layer, n: number, f: (i: number) => Partial<Sprite>) => {
      for (let i = 0; i < n; i++) {
        // Each rolls round its own axis, all near the body's side-to-side axis: the mass turns over, slowly.
        const axis = new THREE.Vector3(1, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8).normalize();
        if (rnd() < 0.3) axis.negate();
        this.sprites.push({
          layer, dir: v(), axis, speed: 0.12 + rnd() * 0.16, radius: 0.5, size: 1, stretch: 1, alpha: 0.5, cell: PARTICLE.puff,
          rot: rnd() * Math.PI * 2, spin: (rnd() - 0.5) * 0.25, seed: rnd() * 100, frame: rnd() * BALL_FRAMES, rate: 0.6 + rnd() * 0.5,
          at: new THREE.Vector3(), follow: 9, placed: false,
          ...f(i),
        });
      }
    };
    const n = COUNTS.high;
    // Lobes from the dense middle outwards (the first ones darkest), so whatever the low settings keep is the middle.
    // Inner layers turn slowly, outer ones faster, so the cloud has depth and never reads as one flat card.
    // A storm cloud come down among the trees: one dense mass about 5 m across, its lobes 4 to 5.5 m frames.
    add('dense', n.dense, (i) => ({ radius: 0.55 + (i / n.dense) * 1.55, size: 4.0 + rnd() * 1.5, alpha: 0.92 + rnd() * 0.08, follow: 10 - (i / n.dense) * 5, rate: 0.45 + rnd() * 0.3 }));
    add('wisp', n.wisp, () => ({ radius: 2.3 + rnd() * 0.8, size: 2.6 + rnd() * 1.6, stretch: 1 + rnd() * 0.5, alpha: 0.5 + rnd() * 0.25, follow: 2 + rnd() * 1.5, speed: 0.1 + rnd() * 0.12, rate: 0.8 + rnd() * 0.6 }));
    // Long wisps hanging down between the tendrils, trailing furthest when it moves.
    add('trail', n.trail, (i) => {
      const a = ((i + 0.5) / n.trail) * Math.PI * 2 + 0.4;
      return { dir: new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), radius: 1.5, size: 1.3 + rnd() * 0.6, stretch: 1.3 + rnd() * 0.4, alpha: 0.55 + rnd() * 0.2, follow: 1.4 + rnd() * 0.6, speed: 0.06 + rnd() * 0.05, rot: (rnd() - 0.5) * 0.3, spin: 0, frame: rnd() * WISP_FRAMES, rate: 0.5 + rnd() * 0.4 };
    });
    add('veil', n.veil, (i) => ({ dir: new THREE.Vector3(i % 2 ? 1 : -1, (i < 2 ? 1 : -1) * 0.5, 0), radius: 0.3, size: 1.9 + rnd() * 0.4, alpha: 0.9, follow: 12 }));
    add('mote', n.mote, () => ({ radius: 1.0 + rnd() * 1.6, size: 0.14 + rnd() * 0.14, alpha: 1, cell: PARTICLE.glow, follow: 5, speed: 0.25 + rnd() * 0.3 }));
    add('halo', 1, () => ({ radius: 0, size: 1.2, alpha: 1, cell: PARTICLE.glow, follow: 30 }));
  }

  /** Medium and up ('high') or Low and phones ('low'): the mist's sprites and maps, the shell, the light. */
  setLook(look: SpiritLook): void {
    this.look = look;
    this.veil.visible = look === 'low';
    const n = COUNTS[look];
    this.leaves.count = n.leaves;
    this.drops.count = n.drops;
    if (look === 'high' && this.withLight && !this.light) {
      if (lamp) this.light = lamp; // the one put in the scene at the start (prepareSpiritLight): no recompile
      else {
        this.light = new THREE.PointLight(COLD, 0, 20, 2);
        this.light.position.set(0, 0, 0.5);
        this.body.add(this.light);
      }
    } else if (look === 'low' && this.light) {
      this.lightOff();
    }
    // Low and phones: the half-size maps (fetched the first time, put on once they are in); no blend between frames.
    const maps = spiritMaps(look === 'low' || spiritHalf, this.model.renderer);
    if (maps === this.maps) this.useMaps(maps, look);
    else void maps.ready.then(() => this.look === look && this.useMaps(maps, look));
    this.mist.setMaps(this.maps.mist, look === 'high');
    this.far = !this.far; // re-pick the model at the next update
  }

  /** Its light out: the shared one stays in the scene with no strength; one of its own goes. */
  private lightOff(): void {
    if (!this.light) return;
    if (this.light === lamp) lamp.intensity = 0;
    else {
      this.body.remove(this.light);
      this.light.dispose();
    }
    this.light = null;
  }

  private useMaps(maps: SpiritMaps, look: SpiritLook): void {
    this.maps = maps;
    useMaps(this.core.material as THREE.MeshStandardMaterial, maps.body);
    useMaps(this.tendrils.material as THREE.MeshStandardMaterial, maps.tendril);
    (this.heart.material as THREE.ShaderMaterial).uniforms.map.value = maps.body.color;
    const leaf = this.leaves.material as THREE.MeshStandardMaterial;
    leaf.map = maps.body.color;
    leaf.normalMap = maps.body.normal;
    this.mist.setMaps(maps.mist, look === 'high');
  }

  /**
   * A short flinch: the body jerks back, the tendrils curl in with a ripple running out along them, the heart flares.
   * `at`, a point in the world where it was hit: while it shields itself, the shell flares there.
   */
  hurt(strength = 1, at?: THREE.Vector3): void {
    this.hurtT = Math.min(1.5, this.hurtT + strength);
    for (const b of this.bends) {
      b.rippleAt = -0.1;
      b.ripple = Math.min(1.2, b.ripple + 0.7 * strength);
    }
    if (at) {
      const d = this.group.worldToLocal(this.tmp.copy(at)).normalize();
      this.shellU.uHit.value.set(d.x, d.y, d.z, 0);
      this.hitT = Math.min(1.5, strength);
    }
  }

  /** The heart's middle in the world. */
  heartWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.heart.localToWorld(out.set(0, 0, HEART_Z));
  }

  /** How far the heart shows now, 0..1 (eased): for the rules' hit test later. */
  get heartShown(): number {
    return this.shown.open * (1 - this.shown.shield) * (1 - this.fade);
  }

  /** A tendril's tip in the world (the shader's curve, worked out here too), e.g. for where a reach lands. */
  tip(arm: number, out: THREE.Vector3): THREE.Vector3 {
    const a = this.model.arms[arm];
    const b = this.bends[arm];
    const p = a.root.clone();
    const d = new THREE.Vector3();
    for (let k = 0; k < 10; k++) {
      const s = (k + 0.5) / 10;
      const al = b.a0 + b.a1 * s + b.curl * smooth(s, 0.55, 1) + b.wa * s * (Math.sin(5 * s - this.phase + b.phase) + 0.45 * Math.sin(2.3 * s - 0.55 * this.phase + 2.1 * b.phase))
        + b.ripple * Math.exp(-(((s - b.rippleAt) / 0.13) ** 2));
      const be = b.b0 + b.b1 * s + b.wb * s * Math.sin(4 * s - 0.8 * this.phase + 1.7 * b.phase);
      d.copy(a.dir).multiplyScalar(Math.cos(al) * Math.cos(be)).addScaledVector(a.up, -Math.sin(al)).addScaledVector(a.side, Math.cos(al) * Math.sin(be));
      p.addScaledVector(d, (a.length * b.stretch) / 10);
    }
    return this.body.localToWorld(out.copy(p));
  }

  private bends: Bend[] = Array.from({ length: ARMS }, (_, i) => ({
    a0: 0, a1: 0, curl: 0, wa: 0, b0: 0, b1: 0, wb: 0, phase: i * 1.37, stretch: 1, thick: 1,
    rippleAt: 2, ripple: 0, lag: 0, lagV: 0, dragU: 0, dragUV: 0, dragS: 0, dragSV: 0,
  }));
  private lastPos = new THREE.Vector3();
  private lastYaw = NaN;
  private yawRate = 0;
  private velocity = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private drag = new THREE.Vector3();
  private flight = new THREE.Vector3();
  private col = new THREE.Color();
  private inv = new THREE.Matrix4();
  private groupInv = new THREE.Matrix4();
  private mat = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private scl = new THREE.Vector3();

  /** Each frame, before drawing. `camera`: for the far model, the mist's order and the heart's kernel. */
  update(dt: number, camera: THREE.Camera): void {
    dt = Math.min(dt, 0.1);
    const s = this.shown;
    s.open = ease(s.open, clamp01(this.open), 5, dt);
    s.shield = ease(s.shield, clamp01(this.shield), 3, dt);
    s.anger = ease(s.anger, clamp01(this.anger), 1.5, dt);
    // The reach's tell: rear up and draw back first (anticipation), then point.
    if (this.reach) {
      this.reachAt.copy(this.reach);
      this.reachT = this.reachT < 0 ? 0 : this.reachT + dt;
    } else this.reachT = -1;
    const rt = this.reachT;
    this.rear = rt < 0 ? ease(this.rear, 0, 6, dt) : smooth(rt, 0, 0.28) * (1 - smooth(rt, 0.4, 0.75));
    s.reach = rt < 0 ? ease(s.reach, 0, 4, dt) : Math.max(s.reach, smooth(rt, 0.38, 0.8));
    const fade = clamp01(this.fade);
    this.hurtT = Math.max(0, this.hurtT - dt * 2.5);
    const hurt = Math.sin(Math.min(1, this.hurtT) * Math.PI * 0.5);
    this.time += dt;
    this.phase += dt * (1.5 + 1.6 * s.anger) * (1 - 0.6 * fade);
    this.pulse += dt * (2.5 + 4 * s.anger + 3 * s.reach + 6 * this.rear + 5 * hurt);
    this.shared.uTime.value = this.time;

    this.group.updateMatrixWorld();
    const pos = this.tmp.setFromMatrixPosition(this.group.matrixWorld);
    const above = this.ground === null ? Infinity : pos.y - this.ground;
    if (dt > 0) this.velocity.lerp(this.tmp2.copy(pos).sub(this.lastPos).divideScalar(dt).clampLength(0, 12), 1 - Math.exp(-4 * dt));
    this.lastPos.copy(pos);
    // How fast it turns (rad/s), for the follow-through of its tendrils and its bank.
    const fwd = this.tmp2.set(0, 0, 1).transformDirection(this.group.matrixWorld);
    const yaw = Math.atan2(fwd.x, fwd.z);
    if (dt > 0 && !Number.isNaN(this.lastYaw)) {
      let dy = yaw - this.lastYaw;
      dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
      this.yawRate = ease(this.yawRate, THREE.MathUtils.clamp(dy / dt, -4, 4), 6, dt);
    }
    this.lastYaw = yaw;

    // The light: cold green-white, amber when angered; a flare when hurt; brighter while it rears to strike.
    this.lightColor.copy(COLD).lerp(AMBER, s.anger);
    this.uniforms.uLight.value.copy(this.lightColor);
    const day = daylight();
    const night = 1 - day;
    const gone = 1 - smooth(fade, 0.6, 1);
    const heartOn = (0.25 + 0.75 * s.open) * gone;
    const flicker = 1 + 0.08 * Math.sin(this.time * 7.3) * Math.sin(this.time * 3.1);
    // A slow double beat, like a heart's.
    const beatT = (this.time * (0.75 + 0.5 * s.anger)) % 1;
    const beat = 1 + 0.35 * Math.exp(-(((beatT - 0.05) / 0.05) ** 2)) + 0.22 * Math.exp(-(((beatT - 0.24) / 0.06) ** 2));
    this.heartU.uHeart.value = (1.4 + 4.2 * s.open + 5 * hurt) * (1 - 0.4 * night) * flicker * beat * gone;
    // The nodes bright enough to bloom by day too (the eye's exposure is low in the sun), a little softer at night.
    this.uniforms.uGlow.value = (1.1 + 1.4 * s.anger + 1.2 * s.reach + 3 * this.rear + 3 * hurt) * (3.2 - 2.1 * night) * (0.85 + 0.15 * beat);
    this.uniforms.uInner.value = (0.25 + 1.4 * s.open) * flicker * beat;
    this.uniforms.uRim.value = 0.25 + 0.25 * night;
    this.uniforms.uFade.value = fade;
    this.uniforms.uPulse.value = this.pulse;
    this.uniforms.uPhase.value = this.phase;
    this.uniforms.uHurt.value = hurt;
    this.uniforms.uLip.value = THREE.MathUtils.lerp(LIP_SHUT, LIP_OPEN, s.open);
    // The heart lighting its cloud from inside, strongest round the opening; by day stronger (the eye's exposure).
    this.shared.uInner.value.copy(this.lightColor).multiplyScalar((0.5 + 0.75 * s.open + 1.5 * hurt + 0.4 * this.rear) * heartOn * flicker * beat * (1.1 - 0.4 * night));
    if (this.light) {
      this.light.color.copy(this.lightColor);
      this.light.intensity = (1.5 + 12 * s.open + 10 * hurt) * heartOn * beat * (this.group.parent && fade < 1 ? 1 : 0);
      // The shared light is in the scene, not in the creature: it follows the heart (half a metre in front of it).
      if (this.light === lamp) this.body.localToWorld(lamp.position.set(0, 0, 0.5));
    }

    // The body: a slow bob and breath; leaning into its motion and banking into its turns; a flinch backwards.
    this.inv.copy(this.group.matrixWorld).invert();
    const vLocal = this.drag.copy(this.velocity).transformDirection(this.inv).multiplyScalar(this.velocity.length());
    const breath = 1 + 0.025 * Math.sin(this.time * 1.3);
    this.body.position.set(0, 0.18 * Math.sin(this.time * 0.8) + 0.12 * this.rear, -0.45 * hurt - 0.25 * this.rear);
    this.body.rotation.set(
      -0.25 * hurt - 0.12 * this.rear + 0.04 * Math.sin(this.time * 0.55) + THREE.MathUtils.clamp(vLocal.z * 0.05, -0.2, 0.2),
      0,
      0.03 * Math.sin(this.time * 0.43) - THREE.MathUtils.clamp(vLocal.x * 0.04 + this.yawRate * 0.12, -0.25, 0.25),
    );
    this.body.scale.set(breath * (1 + 0.08 * hurt), breath * (1 - 0.1 * hurt), breath);
    this.group.updateMatrixWorld(true);
    this.heart.scale.setScalar((0.9 + 0.12 * s.open + 0.15 * hurt) * (1 - 0.5 * smooth(fade, 0.5, 1)) * (0.97 + 0.03 * beat));

    // Near or far model.
    const camPos = camera.getWorldPosition(this.tmp2);
    const dist = camPos.distanceTo(pos);
    const far = dist > FAR[this.look];
    if (far !== this.far) {
      this.far = far;
      const p = far ? this.model.far : this.model.near;
      this.heart.geometry = p.heart;
      this.core.geometry = p.core;
      this.tendrils.geometry = p.tendrils;
    }

    // The cloud's haze on the solid parts, and the heart's kernel (its middle in the camera's space).
    const mid = this.body.localToWorld(this.tmp.set(0, 0, 0));
    this.uniforms.uMist.value.set(mid.x, mid.y, mid.z, 0.22 * (1 - fade) * (1 - 0.5 * s.shield));
    this.uniforms.uMistR.value.set(2.4, 1.65, 2.4).multiplyScalar(breath * (1 + 0.8 * fade));
    const front = this.tmp.set(0, 0, 1).transformDirection(this.group.matrixWorld);
    this.uniforms.uMistFront.value.set(front.x, front.y, front.z, s.open);
    this.uniforms.uMistTint.value.copy(MIST_CORE);
    camera.updateMatrixWorld();
    this.uniforms.uHeartView.value.copy(this.heartWorld(this.tmp)).applyMatrix4(camera.matrixWorldInverse);
    this.uniforms.uHeartK.value = this.heart.scale.x * this.body.scale.x;
    this.shared.uHeart.value.set(0, 0, HEART_Z).applyMatrix4(this.body.matrix);

    this.bendTendrils(s, fade, hurt, dt);
    this.drawMist(dt, camera, s, fade, hurt, night);
    this.drawRing(s, fade);
    this.shellU.uShield.value = s.shield * (1 - fade) * (0.8 - 0.4 * night); // at night the eyes' exposure and the glow do the rest
    this.hitT = Math.max(0, this.hitT - dt * 2);
    this.shellU.uHit.value.w = this.hitT;
    this.shell.visible = s.shield > 0.01 && fade < 1;
    this.shell.scale.setScalar(1 + 0.25 * (1 - s.shield));
    // The dark patch on the ground: fainter the higher it floats, gone as it comes apart.
    this.patch.visible = above < 12;
    if (this.patch.visible) {
      this.patch.position.set(0, -above + 0.02, 0);
      this.patch.scale.setScalar(0.8 + above * 0.08);
      this.patchU.uDark.value = (0.55 - 0.025 * above) * (1 - fade) * (0.5 + 0.5 * day);
    }
    this.veilU.uOpen.value = s.open;
    this.veilU.uAlpha.value = 0.88 * (1 - fade);
    this.veilU.uMist.value.copy(MIST_LOW).multiplyScalar(0.35 + 0.65 * day + 0.6 * night * 0.3);
    this.group.visible = fade < 1;
  }

  /** Each tendril's numbers for the shader: at rest, following through, rearing, reaching, shielding, flinching, coming apart. */
  private bendTendrils(s: BrookSpirit['shown'], fade: number, hurt: number, dt: number): void {
    // Its own motion, in its own frame: the tendrils trail behind it, on springs (they overshoot, then settle).
    const speed = this.velocity.length();
    const drag = this.drag.copy(this.velocity).applyQuaternion(this.quat.setFromRotationMatrix(this.inv)).multiplyScalar(speed > 1e-3 ? -Math.min(1, speed / 5) / speed : 0);
    const local = this.tmp2;
    if (s.reach > 0.001) this.body.worldToLocal(local.copy(this.reachAt));
    const waveA = (0.16 + 0.1 * s.anger) * (1 - 0.6 * s.shield);
    this.model.arms.forEach((a, i) => {
      const b = this.bends[i];
      const front = i < 2;
      const [rise, fall, curl] = ARCH[i];
      // Springs: each arm its own stiffness, the long ones slower, so they settle one after another.
      const k = 16 + 5 * Math.sin(i * 2.1) - (front ? 4 : 0);
      const c = 4.2;
      const spring = (v: number, vel: number, target: number): [number, number] => {
        const acc = k * (target - v) - c * vel;
        vel += acc * dt;
        return [v + vel * dt, vel];
      };
      const pu = a.up.x * drag.x + a.up.y * drag.y + a.up.z * drag.z;
      const ps = a.side.x * drag.x + a.side.y * drag.y + a.side.z * drag.z;
      [b.dragU, b.dragUV] = spring(b.dragU, b.dragUV, pu);
      [b.dragS, b.dragSV] = spring(b.dragS, b.dragSV, ps);
      // Turning: a turn carries every tip towards its arm's -side; the arms lag behind it, most at their tips.
      [b.lag, b.lagV] = spring(b.lag, b.lagV, THREE.MathUtils.clamp(this.yawRate * 0.35, -0.8, 0.8));
      // At rest: up out of the mist in an arch, then down, the tip hooked under (its glowing nodes face down, to the
      // players below). `rise` turns it up at the root, `fall` bends it down along its length.
      b.a0 = rise - b.dragU * 0.5;
      b.b0 = b.dragS * 0.5 + 0.3 * b.lag;
      b.a1 = fall;
      b.curl = curl;
      b.wa = waveA;
      b.b1 = b.lag;
      b.wb = 0.14 + 0.1 * s.anger;
      b.stretch = 1;
      b.thick = 1;
      // Shielding: every arm drawn up and over the body, wrapped close round it inside the storm.
      if (s.shield > 0) {
        const sk = s.shield;
        b.a0 = THREE.MathUtils.lerp(b.a0, -1.15, sk);
        b.a1 = THREE.MathUtils.lerp(b.a1, 1.9, sk);
        b.curl = THREE.MathUtils.lerp(b.curl, 0.7, sk);
        b.stretch = 1 - 0.5 * sk;
      }
      // The tell: the front arms rear up high and coil back (the others brace a little), then strike out.
      if (this.rear > 0.001) {
        const r = this.rear * (front ? 1 : 0.25);
        b.a0 -= 0.75 * r;
        b.a1 -= 0.5 * r;
        b.curl += 0.8 * r;
        b.stretch *= 1 - 0.14 * r;
        b.wa *= 1 - 0.7 * r;
      }
      // Reaching: the two front arms point at the spot, nearly straight, their tips curled to grasp.
      if (front && s.reach > 0.001) {
        const w = this.tmp.copy(local).sub(a.root);
        const d = w.length();
        w.divideScalar(Math.max(d, 1e-3));
        const ar = Math.asin(THREE.MathUtils.clamp(-w.dot(a.up), -1, 1));
        const br = Math.atan2(w.dot(a.side), w.dot(a.dir));
        const r = s.reach;
        b.a1 = THREE.MathUtils.lerp(b.a1, 0.3, r);
        b.curl = THREE.MathUtils.lerp(b.curl, 0.9, r);
        b.a0 = THREE.MathUtils.lerp(b.a0, ar - 0.15 - 0.2, r);
        b.b0 = THREE.MathUtils.lerp(b.b0, br, r);
        b.wa *= 1 - 0.75 * r;
        b.wb *= 1 - 0.75 * r;
        b.stretch = THREE.MathUtils.lerp(b.stretch, THREE.MathUtils.clamp(d / (a.length * 0.95), 0.85, 1.3), r);
      }
      // A flinch: all curl in at once, and a kink runs out along each arm; coming apart: they droop and go still.
      b.curl += 1.1 * hurt;
      b.a0 += 0.35 * hurt;
      b.rippleAt += dt * (2.2 + 0.2 * i);
      b.ripple *= Math.exp(-dt * 2.2);
      if (b.rippleAt > 1.3) b.ripple = 0;
      b.a1 += 0.6 * fade;
      b.wa *= 1 - 0.5 * fade;
      b.thick = 1 / Math.sqrt(b.stretch);
      this.uniforms.uBendA.value[i].set(b.a0, b.a1, b.curl, b.wa);
      this.uniforms.uBendB.value[i].set(b.b0, b.b1, b.wb, b.phase);
      this.uniforms.uArmX.value[i].set(b.stretch, b.thick, b.rippleAt, b.ripple * (i % 2 ? 1 : 0.85));
    });
  }

  /** The mist and the lights: placed, trailed, lit, sorted far to near, written into the two sprite draws. */
  private drawMist(dt: number, camera: THREE.Camera, s: BrookSpirit['shown'], fade: number, hurt: number, night: number): void {
    const look = this.look;
    const n = COUNTS[look];
    const keep: Record<Layer, number> = { dense: n.dense, wisp: n.wisp, trail: n.trail, veil: n.veil, mote: n.mote, halo: 1 };
    const seen: Record<Layer, number> = { dense: 0, wisp: 0, trail: 0, veil: 0, mote: 0, halo: 0 };
    const groupInv = this.groupInv.copy(this.group.matrixWorld).invert();
    const view = camera.matrixWorldInverse;
    const p = new THREE.Vector3();
    const camLocal = this.group.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
    const facing = clamp01(camLocal.clone().normalize().z * 1.4 + 0.2); // the halo shows from in front
    this.shared.uHole.value.set(s.open * (1 - fade), 0.95);
    this.mist.begin();
    this.glow.begin();
    this.order.length = 0;
    const active: Sprite[] = [];
    for (const sp of this.sprites) {
      if (seen[sp.layer]++ >= keep[sp.layer]) continue;
      active.push(sp);
    }
    const spread = 1 + 2.4 * fade * fade + 0.25 * hurt + 0.1 * this.rear;
    for (const sp of active) {
      const t = this.time;
      if (sp.layer === 'halo') p.set(0, 0, 0.9);
      else if (sp.layer === 'veil') {
        // In front of the heart; parts to either side as it opens.
        const side = Math.sign(sp.dir.x);
        p.set(side * (0.3 + 1.4 * s.open), sp.dir.y * (0.6 + 0.5 * s.open), 0.95 - 0.35 * s.open);
      } else if (sp.layer === 'trail') {
        // Hanging under the body between the tendrils, turning slowly round, swaying.
        p.copy(sp.dir).applyAxisAngle(this.scl.set(0, 1, 0), t * sp.speed).multiplyScalar(sp.radius * (1 + 0.15 * Math.sin(t * 0.5 + sp.seed)));
        p.y = -1.75 + 0.25 * Math.sin(t * 0.6 + sp.seed);
      } else {
        p.copy(sp.dir).applyAxisAngle(sp.axis, t * sp.speed + sp.seed);
        const r = sp.radius * (1 + 0.12 * Math.sin(t * 0.7 + sp.seed));
        p.multiplyScalar(r).multiply(this.scl.set(1.25, sp.layer === 'wisp' ? 0.85 : 0.72, 1.1));
        if (sp.layer === 'wisp') p.y -= 0.2; // its torn edge hangs a little low, among the tendrils
        if (sp.layer === 'mote') p.y += 0.35 * Math.sin(t * 1.3 + sp.seed);
      }
      // Shielding: the torn edges and the trails are caught up in the storm, racing round just inside the shell.
      if (s.shield > 0.001 && (sp.layer === 'wisp' || sp.layer === 'trail')) {
        const lat = Math.sin(sp.seed * 3.7) * 0.6;
        const lon = sp.seed + (sp.seed % 2 < 1 ? 1 : -1) * t * 1.1;
        this.scl.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)).multiplyScalar(SHELL * 0.92);
        p.lerp(this.scl, s.shield);
      }
      p.multiplyScalar(sp.layer === 'halo' ? 1 : spread);
      if (sp.layer === 'mote') p.y += fade * (1.5 + (sp.seed % 1) * 2.5);
      if (sp.layer !== 'halo') p.y += fade * 0.6;
      // Into the world, trailing behind where it should be.
      p.applyMatrix4(this.body.matrix).applyMatrix4(this.group.matrixWorld);
      if (!sp.placed) {
        sp.at.copy(p);
        sp.placed = true;
      } else sp.at.lerp(p, 1 - Math.exp(-sp.follow * dt));
      sp.rot += sp.spin * dt;
    }
    // Sorted far to near (the mist blends; order matters there).
    const depths = this.depth;
    depths.length = active.length;
    active.forEach((sp, i) => {
      depths[i] = this.tmp.copy(sp.at).applyMatrix4(view).z;
      this.order.push(i);
    });
    this.order.sort((a, b) => depths[a] - depths[b]);
    this.shared.uCore.value.set(0, 0, 0, CORE_CLEAR * (1 + 0.6 * fade));
    const play = (1 + 0.6 * s.anger + 0.8 * fade) * MIST_FPS;
    for (const k of this.order) {
      const sp = active[k];
      const local = this.tmp.copy(sp.at).applyMatrix4(groupInv);
      const fadeA = 1 - fade;
      if (sp.layer === 'halo') {
        // A light in it even closed (through the lips), much brighter open.
        const a = (0.3 + 0.7 * s.open) * Math.max(facing, 0.35) * (1 - fade) * (1 - 0.7 * s.shield);
        this.col.copy(this.lightColor).multiplyScalar(0.7 + 0.3 * night + hurt);
        this.glow.put(local, sp.size * (0.6 + 0.6 * s.open), sp.size * (0.6 + 0.6 * s.open), 0, sp.cell, this.col, a);
      } else if (sp.layer === 'mote') {
        const tw = 0.6 + 0.4 * Math.sin(this.time * (2 + (sp.seed % 3)) + sp.seed);
        this.col.copy(this.lightColor).multiplyScalar((1.6 + 2 * night) * tw);
        const grow = 1 + 1.5 * fade;
        this.glow.put(local, sp.size * grow, sp.size * grow, 0, sp.cell, this.col, (1 - smooth(fade, 0.7, 1)) * (0.5 + 0.5 * s.anger + 0.3 * night));
      } else {
        const dense = sp.layer === 'dense' || sp.layer === 'veil' || sp.layer === 'trail';
        // The heart of the cloud near black, the lobes round it charcoal, the torn edges and trails blue-grey.
        this.col.copy(sp.layer === 'dense' && sp.radius < 1.6 ? MIST_CORE : dense ? MIST_DENSE : MIST_THIN);
        if (fade > 0) this.col.lerp(MIST_THIN, fade);
        let a = sp.alpha * fadeA;
        const size = sp.size * (1 + 0.6 * fade);
        // Open, the mist clears from in front of the heart (towards its front, and wherever a lobe lies over it as
        // seen from the eye), so the heart shows as the one bright point in the dark.
        // (Over the heart itself a soft hole is cut in every lobe in front of it, per pixel: spiritMist.ts uHole.)
        let clear = 0;
        if (s.open > 0.01) {
          const ahead = local.z / Math.max(0.3, local.length());
          clear = s.open * smooth(ahead, 0.2, 0.7) * 0.6;
        }
        if (sp.layer === 'veil') a *= 1 - 0.85 * s.open;
        a *= 1 - clear;
        const wisp = sp.layer === 'trail';
        const frame = (sp.frame + this.time * play * sp.rate) % (wisp ? WISP_FRAMES : BALL_FRAMES);
        const inner = sp.layer === 'veil' ? 1.4 : sp.layer === 'dense' ? 1 : wisp ? 0.35 : 0.6;
        // The middle of the cloud thicker than one frame of mist: it reads as one dark body, not loose puffs.
        const thick = sp.layer === 'dense' ? 4.5 - (sp.radius - 0.55) * 1.3 : sp.layer === 'veil' ? 3 : 1;
        this.mist.put(local, size, size * sp.stretch * (wisp ? 2 : 1), sp.rot, wisp ? 1 : 0, frame, this.col, a, inner, thick * (1 - 0.6 * fade) * (1 - 0.7 * clear));
      }
    }
    this.mist.end();
    this.glow.end();
  }

  /**
   * The leaves and drops: a slow tilted spiral round it; when it shields itself, a storm racing round it in bands
   * (the next band the other way), densest round the middle, the drops drawn out into streaks.
   */
  private drawRing(s: BrookSpirit['shown'], fade: number): void {
    const n = COUNTS[this.look];
    const t = this.time;
    const shield = s.shield;
    const total = n.leaves + n.drops;
    const tangent = this.flight;
    for (let i = 0; i < total; i++) {
      const leaf = i < n.leaves;
      const r = this.ring[leaf ? i : COUNTS.high.leaves + (i - n.leaves)];
      // The ring: round it at its own radius, slowly rising through a band and fading in and out at its ends.
      const h = (r.h + t * 0.03) % 1;
      const ang = r.u * Math.PI * 2 + t * (leaf ? 0.32 : 0.45) + h * 2.2;
      const ringP = this.tmp.set(Math.cos(ang) * r.r, -0.6 + h * 1.2 + r.tilt, Math.sin(ang) * r.r);
      ringP.applyAxisAngle(this.scl.set(1, 0, 0.3).normalize(), 0.3);
      tangent.set(-Math.sin(ang), 0, Math.cos(ang)).multiplyScalar(1 - shield);
      // The storm: its band by latitude; each band races round at its own speed, the next one the other way.
      const band = Math.round(r.lat * 3.2);
      const way = band % 2 === 0 ? 1 : -1;
      const lon = r.u * Math.PI * 2 + way * t * (1.3 + 0.4 * Math.cos(band * 1.7)) * (leaf ? 1 : 1.25);
      const cl = Math.cos(r.lat);
      const shellP = this.tmp2.set(cl * Math.cos(lon), Math.sin(r.lat), cl * Math.sin(lon)).multiplyScalar(SHELL * r.lift);
      tangent.x += -Math.sin(lon) * way * shield;
      tangent.z += Math.cos(lon) * way * shield;
      tangent.normalize();
      ringP.lerp(shellP, shield);
      ringP.multiplyScalar(1 + 1.5 * fade);
      ringP.y -= fade * 1.5; // what it held falls when it comes apart
      const edge = Math.sin(Math.PI * h);
      // In the slow ring only one drop in three shows (the rest join the storm), so they glint rather than speckle.
      const few = leaf || i % 3 === 0 ? 1 : shield;
      const size = r.size * few * (shield + (1 - shield) * Math.min(1, edge * 3)) * (1 - smooth(fade, 0.5, 1));
      if (leaf) {
        // Tumbling slowly in the ring, fast in the storm.
        this.quat.setFromAxisAngle(r.spin, t * (0.8 + 4 * shield) + r.u * 20);
        this.mat.compose(ringP, this.quat, this.scl.setScalar(size * (1.4 + 0.5 * shield)));
      } else {
        // A drop drawn out along its flight: a round bead in the ring (its tail squashed away), a streak in the storm.
        this.quat.setFromUnitVectors(Z_AXIS, tangent);
        this.mat.compose(ringP, this.quat, this.scl.set(size * 0.8, size * 0.8, size * (0.3 + 5.5 * shield)));
      }
      if (leaf) this.leaves.setMatrixAt(i, this.mat);
      else this.drops.setMatrixAt(i - n.leaves, this.mat);
    }
    this.leaves.instanceMatrix.needsUpdate = true;
    this.drops.instanceMatrix.needsUpdate = true;
    // The drops catch its light.
    (this.drops.material as THREE.MeshStandardMaterial).emissive.copy(this.lightColor).multiplyScalar(0.18 + 0.3 * shield);
  }

  dispose(): void {
    this.mist.dispose();
    this.glow.dispose();
    for (const m of [this.heart, this.core, this.tendrils, this.veil, this.shell, this.patch, this.leaves, this.drops]) (m.material as THREE.Material).dispose();
    this.veil.geometry.dispose();
    this.patch.geometry.dispose();
    this.shell.geometry.dispose();
    this.leaves.geometry.dispose();
    this.lightOff();
    this.group.removeFromParent();
  }
}
