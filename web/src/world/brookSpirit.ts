import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { daylight } from './daylight';
import { PARTICLE, particleSheet } from './sprites';

/**
 * The brook spirit's look: a floating creature of mist for the woods by the brook (working name, in code only).
 * Our own design, a spirit of the brook valley in November, close to the will-o'-the-wisps of the marsh tales:
 * a rolling mass of dark mist with a lantern-like heart inside, seven long tendrils hanging and reaching out of
 * it, and fallen leaves and drops of brook water drawn up in a slow spiral round it.
 *
 * Only how it is drawn and moves: no rules, no health, no attacks. The rules will drive a few inputs:
 * - `group`: where it floats (the middle of the body) and which way it faces (rotation.y; its front is +z).
 * - `open` 0..1: how far the mist and the dark core open over the heart (the heart is what a player aims at).
 * - `shield` 0..1: the ring of leaves and drops closed into a shell round it.
 * - `anger` 0..1: its cold green-white light turns amber; it moves faster.
 * - `reach`: a point in the world its two long front tendrils reach for, or null.
 * - `fade` 0..1: coming apart into mist and drifting lights (arriving, leaving, beaten).
 * - `hurt()`: a short flinch.
 * open, shield, anger and reach ease towards what they are set to (a few tenths of a second), so the rules may set
 * them as 0 or 1; fade is shown as it is set (the rules animate it).
 *
 * How it is drawn, cheapest where it covers the most pixels:
 * - The model (tools/brook_spirit.py, public/models/brook-spirit.glb): the heart, the dark core and the tendrils,
 *   near and far. The tendrils are modelled straight; the vertex shader bends each along a curve made of a few
 *   numbers a frame (droop, curl at the tip, a wave running from the root, the pull of its motion, a reach), so
 *   they need no bones (as some big games drive tentacles as effects tied to the creature's state). The core's
 *   opening closes in its vertex shader: each point slides along its meridian towards the front.
 * - The mist: soft camera-facing sprites from the game's own sheet (sprites.ts), one instanced draw, sorted back to
 *   front: dense dark puffs close round the core, thin torn wisps further out that trail behind as it moves, and a
 *   veil in front of the heart that parts when it opens. A sprite is never drawn through the core: one that would
 *   cut it is slid along its line of sight to just in front of or behind it, so it keeps its size on screen and
 *   shows no hard edge. On Low (and phones) a single dark shell with moving bumps and a few sprites stand in.
 * - Light: drifting will-o'-the-wisp lights and a halo round the heart in a second, additive draw; the heart, the
 *   nodes under the tendrils and the hollow behind the opening glow (the game's bloom picks them up, Medium and up;
 *   every value stays far under the half floats' 65504). One small point light on Medium and up, none on Low.
 * - The leaves and drops: two instanced meshes; the shell a faint glassy skin of water round them.
 * Draw calls: 7 on Medium and up, 8 on Low (its body of mist), one more while it shields itself.
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
}

const ARMS = 7;
/** The core's opening as modelled (radians from the front), and closed (tools/brook_spirit.py LIP). */
const LIP_OPEN = 0.78;
const LIP_SHUT = 0.1;
/** Within this distance from the core's middle (m), along the line of sight, no mist sprite is drawn. */
const CORE_CLEAR = 0.95;
/** The ring of leaves and drops: radius (m), and the shell's. */
const RING = 2.6;
const SHELL = 2.4;
/** Beyond this (m) the far model is drawn. */
const FAR = { low: 16, high: 32 };

/** The light inside it: cold green-white, and amber when angered (linear). */
const COLD = new THREE.Color('#c9ffe2');
const AMBER = new THREE.Color('#ffa63a');
/** The mist: charcoal close in, blue-grey further out. */
const MIST_DENSE = new THREE.Color('#2f363d');
const MIST_THIN = new THREE.Color('#66717c');

let job: Promise<BrookSpiritModel | null> | null = null;

/** The model, fetched once; null if it can't be. */
export function loadBrookSpirit(url = '/models/brook-spirit.glb'): Promise<BrookSpiritModel | null> {
  return (job ??= new GLTFLoader().loadAsync(url).then(
    (gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const take = (name: string, role: 'heart' | 'core' | 'tendrils'): THREE.BufferGeometry => {
        const o = gltf.scene.getObjectByName(name) as THREE.Mesh;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const uv = g.getAttribute('uv');
        const uv1 = g.getAttribute('uv1');
        // Our own names for the extra numbers on the corners (the materials draw no texture with them).
        if (role === 'tendrils') {
          g.setAttribute('aArm', uv);
          g.setAttribute('aGlow', uv1);
        } else if (role === 'core') g.setAttribute('aInside', uv);
        g.deleteAttribute('uv');
        if (uv1) g.deleteAttribute('uv1');
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1, 0), role === 'tendrils' ? 7 : 1.6);
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
      return {
        near: { heart: take('Heart', 'heart'), core: take('Core', 'core'), tendrils: take('Tendrils', 'tendrils') },
        far: { heart: take('HeartFar', 'heart'), core: take('CoreFar', 'core'), tendrils: take('TendrilsFar', 'tendrils') },
        arms,
      };
    },
    () => null,
  ));
}

// ---------------------------------------------------------------------------------------------- shaders

/** A cheap smooth noise for the dissolve (value noise on a hashed lattice). */
const NOISE = /* glsl */ `
float spiritHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float spiritNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(spiritHash(i), spiritHash(i + vec3(1, 0, 0)), f.x), mix(spiritHash(i + vec3(0, 1, 0)), spiritHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(spiritHash(i + vec3(0, 0, 1)), spiritHash(i + vec3(1, 0, 1)), f.x), mix(spiritHash(i + vec3(0, 1, 1)), spiritHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`;

/**
 * The tendrils' bend. Each arm's direction at s (0 root .. 1 tip) is its straight axis turned by two angles: `al`
 * towards its underside (droop and curl) and `be` sideways. The spine is summed from the root in ten small steps,
 * so it stays smooth for every t; the cross-section turns with it.
 */
const TENDRIL_VERTEX = /* glsl */ `
attribute vec2 aArm;
attribute vec2 aGlow;
uniform vec4 uFrame[${ARMS * 4}];
uniform vec4 uBendA[${ARMS}];
uniform vec4 uBendB[${ARMS}];
uniform vec4 uArmX[${ARMS}];
uniform float uPhase;
varying vec3 vSpirit;
varying vec3 vLocal;
vec3 spiritDir(float s, vec4 A, vec4 B, vec3 D, vec3 U, vec3 S, out float al, out float be) {
  al = A.x + A.y * s + A.z * smoothstep(0.55, 1.0, s) + A.w * s * sin(5.0 * s - uPhase + B.w);
  be = B.x + B.y * s + B.z * s * sin(4.0 * s - 0.8 * uPhase + 1.7 * B.w);
  float ca = cos(al);
  return D * (ca * cos(be)) - U * sin(al) + S * (ca * sin(be));
}`;

const TENDRIL_BEND = /* glsl */ `
int ai = int(aArm.y + 0.5);
vec4 F0 = uFrame[ai * 4];
vec3 aD = uFrame[ai * 4 + 1].xyz;
vec3 aU = uFrame[ai * 4 + 2].xyz;
vec3 aS = uFrame[ai * 4 + 3].xyz;
vec4 A = uBendA[ai];
vec4 B = uBendB[ai];
vec4 X = uArmX[ai];
vec3 rel = position - F0.xyz;
float along = dot(rel, aD);
float t = clamp(along / F0.w, 0.0, 1.0);
float al;
float be;
vec3 P = vec3(0.0);
for (int k = 0; k < 10; k++) P += spiritDir(t * (float(k) + 0.5) / 10.0, A, B, aD, aU, aS, al, be);
P *= t * F0.w * X.x / 10.0;
vec3 T = spiritDir(t, A, B, aD, aU, aS, al, be);
vec3 Ut = aD * (sin(al) * cos(be)) + aU * cos(al) + aS * (sin(al) * sin(be));
vec3 St = aS * cos(be) - aD * sin(be);
vec3 bent = F0.xyz + P + (St * dot(rel, aS) + Ut * dot(rel, aU)) * X.y + T * (along - t * F0.w);
vec3 objectNormal = normalize(T * dot(normal, aD) + Ut * dot(normal, aU) + St * dot(normal, aS));
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(tangent.xyz);
#endif
vSpirit = vec3(t, aGlow.x, aGlow.y);
vLocal = position;`;

/** The core: the opening's edge slides from LIP_OPEN to uLip, everything behind it squeezed to make room. */
const CORE_VERTEX = /* glsl */ `
attribute vec2 aInside;
uniform float uLip;
varying vec3 vSpirit;
varying vec3 vLocal;`;

const CORE_BEND = /* glsl */ `
vec3 cq = position / vec3(1.12, 0.92, 1.0);
float cr = length(cq);
vec3 cd = cq / max(cr, 1e-5);
float th = acos(clamp(cd.z, -1.0, 1.0));
float th2 = th >= ${LIP_OPEN.toFixed(3)} ? PI - (PI - th) * (PI - uLip) / (PI - ${LIP_OPEN.toFixed(3)}) : th - ${LIP_OPEN.toFixed(3)} + uLip;
float cl = length(cd.xy);
vec2 ring = cl > 1e-5 ? cd.xy / cl : vec2(1.0, 0.0);
vec3 bent = vec3(ring * sin(th2), cos(th2)) * cr * vec3(1.12, 0.92, 1.0);
float dth = th2 - th;
vec3 ck = vec3(-ring.y, ring.x, 0.0);
vec3 objectNormal = normal * cos(dth) + cross(ck, normal) * sin(dth) + ck * dot(ck, normal) * (1.0 - cos(dth));
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(tangent.xyz);
#endif
vSpirit = vec3(0.0, aInside.x, 0.0);
vLocal = position;`;

/** Shared by the core and the tendrils: their glow, the rim that keeps the outline in the dark, the dissolve. */
const BODY_FRAGMENT = /* glsl */ `
uniform vec3 uLight;
uniform float uGlow;
uniform float uInner;
uniform float uRim;
uniform float uFade;
uniform float uPulse;
varying vec3 vSpirit;
varying vec3 vLocal;
${NOISE}`;

const BODY_CUT = /* glsl */ `
float spiritCut = -1.0;
if (uFade > 0.0) {
  // Tendrils go from the tip in, the core in patches; all of it gone by about 0.55, while the mist and lights linger.
  spiritCut = mix(spiritNoise(vLocal * 4.0), vSpirit.x, 0.5) + uFade * 1.8 - 1.0;
  if (spiritCut > 0.0) discard;
}
#include <clipping_planes_fragment>`;

const BODY_GLOW = /* glsl */ `
#include <emissivemap_fragment>
{
  float pulse = 0.6 + 0.4 * sin(vSpirit.x * 16.0 - uPulse);
  #ifdef SPIRIT_CORE
    totalEmissiveRadiance += uLight * vSpirit.y * uInner; // the hollow, lit by the heart
  #else
    totalEmissiveRadiance += uLight * vSpirit.y * uGlow * pulse; // the nodes, a pulse running out along the arm
  #endif
  float facing = abs(dot(normal, normalize(vViewPosition)));
  totalEmissiveRadiance += uLight * pow(1.0 - facing, 3.0) * uRim;
  if (uFade > 0.0) totalEmissiveRadiance += uLight * 2.0 * smoothstep(-0.08, 0.0, spiritCut);
}`;

/** Camera-facing sprites from the effects sheet; slid off the core along their line of sight. */
const SPRITE_VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iSize;
attribute vec4 iColor;
uniform vec4 uCore;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vWarp;
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
  vWarp = position.xy + iPos.xy * 1.7 + iSize.z;
  vColor = iColor;
  vec4 mvPosition = mv;
  #include <fog_vertex>
}`;

const SPRITE_FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vWarp;
#include <fog_pars_fragment>
void main() {
  // A slow churn inside each sprite, kept inside its own cell of the sheet.
  vec2 w = vec2(sin(vWarp.y * 3.1 + uTime * 0.7), cos(vWarp.x * 2.7 - uTime * 0.6)) * 0.012;
  vec2 cellMin = floor(vUv * 2.0) * 0.5;
  vec4 t = texture2D(map, clamp(vUv + w, cellMin + 0.004, cellMin + 0.496));
  vec3 col = vColor.rgb * t.rgb;
  float a = vColor.a * t.a;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    #ifdef ADDITIVE
      col *= 1.0 - fogF;
    #else
      col = mix(col, fogColor, fogF);
    #endif
  #endif
  #ifdef ADDITIVE
    gl_FragColor = vec4(col * a, 1.0);
  #else
    gl_FragColor = vec4(col, a);
  #endif
}`;

const HEART_VERTEX = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vC;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vC = color.rgb;
  gl_Position = projectionMatrix * mv;
}`;

const HEART_FRAGMENT = /* glsl */ `
uniform vec3 uLight;
uniform float uHeart;
varying vec3 vN;
varying vec3 vV;
varying vec3 vC;
void main() {
  float f = abs(dot(normalize(vN), vV));
  // Brightest where you look straight in, as a lantern through thin paper; whiter at the very core.
  vec3 c = mix(uLight, vec3(1.0), f * f * 0.6) * vC * uHeart * (0.35 + 0.65 * f * f);
  gl_FragColor = vec4(c, 1.0);
}`;

/** The shell: a faint skin of water, brightest at its edge, with slow ripples running over it. */
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
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_fragment>
void main() {
  float f = 1.0 - abs(dot(normalize(vN), vV));
  float ripple = 0.5 + 0.5 * sin(vP.y * 7.0 + sin(vP.x * 3.0 + uTime) * 2.0 - uTime * 1.6);
  vec3 c = uLight * uShield * (0.04 + 0.5 * pow(f, 3.0) + 0.05 * ripple * f);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      c *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      c *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(c, 1.0);
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

type Layer = 'dense' | 'wisp' | 'veil' | 'mote' | 'halo';

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
  /** Where it is in the world now: it follows its place at `follow` per second, so the mist trails as it moves. */
  at: THREE.Vector3;
  follow: number;
  placed: boolean;
}

class SpritePool {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private iPos: THREE.InstancedBufferAttribute;
  private iSize: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute;
  count = 0;

  constructor(capacity: number, map: THREE.Texture, additive: boolean, shared: { uCore: { value: THREE.Vector4 }; uTime: { value: number } }) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', (this.iPos = attr(3)));
    this.geo.setAttribute('iSize', (this.iSize = attr(4)));
    this.geo.setAttribute('iColor', (this.iColor = attr(4)));
    this.geo.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: map }, uCore: shared.uCore, uTime: shared.uTime },
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT,
      defines: additive ? { ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.CustomBlending : THREE.NormalBlending,
      ...(additive ? { blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation } : {}),
    });
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
    this.mesh.raycast = () => {};
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

/** How many of each, Medium and up / Low. The dense, wisp and veil sprites are the soft ones over the body (40 at most). */
const COUNTS = {
  high: { dense: 16, wisp: 14, veil: 4, mote: 12, leaves: 64, drops: 24 },
  low: { dense: 6, wisp: 6, veil: 2, mote: 6, leaves: 32, drops: 12 },
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
}

const ease = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

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

  /** What is shown now (eased towards the inputs). */
  private shown = { open: 0, shield: 0, anger: 0, reach: 0 };
  private reachAt = new THREE.Vector3();
  private hurtT = 0;
  private time = 0;
  private phase = 0;
  private pulse = 0;
  private look: SpiritLook;
  private far = false;

  private body = new THREE.Group();
  private heart: THREE.Mesh;
  private core: THREE.Mesh;
  private tendrils: THREE.Mesh;
  private mist: SpritePool;
  private glow: SpritePool;
  private veil: THREE.Mesh;
  private shell: THREE.Mesh;
  private leaves: THREE.InstancedMesh;
  private drops: THREE.InstancedMesh;
  private light: THREE.PointLight | null = null;
  private sprites: Sprite[] = [];
  private order: number[] = [];
  private depth: number[] = [];
  private ring: { u: number; r: number; h: number; tilt: number; spin: THREE.Vector3; size: number }[] = [];

  private lightColor = new THREE.Color();
  private uniforms = {
    uLight: { value: new THREE.Color() },
    uGlow: { value: 1 },
    uInner: { value: 0 },
    uRim: { value: 0.2 },
    uFade: { value: 0 },
    uPulse: { value: 0 },
    uPhase: { value: 0 },
    uLip: { value: LIP_SHUT },
    uFrame: { value: Array.from({ length: ARMS * 4 }, () => new THREE.Vector4()) },
    uBendA: { value: Array.from({ length: ARMS }, () => new THREE.Vector4()) },
    uBendB: { value: Array.from({ length: ARMS }, () => new THREE.Vector4()) },
    uArmX: { value: Array.from({ length: ARMS }, () => new THREE.Vector4(1, 1, 0, 0)) },
  };
  private shared = { uCore: { value: new THREE.Vector4(0, 0, 0, CORE_CLEAR) }, uTime: { value: 0 } };
  private heartU = { uLight: this.uniforms.uLight, uHeart: { value: 1 } };
  private shellU = { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uLight: this.uniforms.uLight, uShield: { value: 0 }, uTime: this.shared.uTime };
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
    model.arms.forEach((a, i) => {
      this.uniforms.uFrame.value[i * 4].set(a.root.x, a.root.y, a.root.z, a.length);
      this.uniforms.uFrame.value[i * 4 + 1].set(a.dir.x, a.dir.y, a.dir.z, a.radius);
      this.uniforms.uFrame.value[i * 4 + 2].set(a.up.x, a.up.y, a.up.z, 0);
      this.uniforms.uFrame.value[i * 4 + 3].set(a.side.x, a.side.y, a.side.z, 0);
    });
    this.group.add(this.body);

    // The heart: light of its own, no lighting.
    this.heart = new THREE.Mesh(model.near.heart, new THREE.ShaderMaterial({ uniforms: this.heartU, vertexShader: HEART_VERTEX, fragmentShader: HEART_FRAGMENT, vertexColors: true }));
    // The core and the tendrils: lit as the world is, with their own glow, rim and dissolve.
    this.core = new THREE.Mesh(model.near.core, this.bodyMaterial(CORE_VERTEX, CORE_BEND, 0.95));
    this.tendrils = new THREE.Mesh(model.near.tendrils, this.bodyMaterial(TENDRIL_VERTEX, TENDRIL_BEND, 0.55));
    this.body.add(this.heart, this.core, this.tendrils);

    // Low's body of mist: a dark shell (drawn before the sprites).
    this.veil = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 3).scale(1.25, 1.0, 1.15),
      new THREE.ShaderMaterial({ uniforms: this.veilU, vertexShader: VEIL_VERTEX, fragmentShader: VEIL_FRAGMENT, transparent: true, depthWrite: false, fog: true }),
    );
    this.veil.renderOrder = 1;
    this.body.add(this.veil);

    const sheet = particleSheet();
    this.mist = new SpritePool(48, sheet, false, this.shared);
    this.glow = new SpritePool(24, sheet, true, this.shared);
    this.group.add(this.mist.mesh, this.glow.mesh);

    // The ring: leaves (a small folded leaf) and drops of water.
    const leaf = new THREE.BufferGeometry();
    leaf.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.11, 0.045, 0.004, 0.02, 0, 0.012, 0, -0.045, 0.004, 0.02, 0.035, 0.002, -0.05, -0.035, 0.002, -0.05, 0, 0.0, -0.1], 3));
    leaf.setIndex([0, 1, 2, 0, 2, 3, 1, 4, 2, 3, 2, 5, 4, 6, 2, 2, 6, 5]);
    leaf.computeVertexNormals();
    const leafMat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
    this.leaves = new THREE.InstancedMesh(leaf, leafMat, COUNTS.high.leaves);
    const rnd = random(23);
    const browns = ['#7a4f26', '#9c6a2c', '#b8862f', '#6a4424', '#8f4523', '#a3772f'].map((c) => new THREE.Color(c));
    for (let i = 0; i < COUNTS.high.leaves; i++) this.leaves.setColorAt(i, browns[Math.floor(rnd() * browns.length)].clone().multiplyScalar(0.8 + rnd() * 0.4));
    this.drops = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.028, 0),
      new THREE.MeshStandardMaterial({ color: '#8fb4c6', roughness: 0.05, metalness: 0.0, emissive: '#000000' }),
      COUNTS.high.drops,
    );
    for (let i = 0; i < COUNTS.high.leaves + COUNTS.high.drops; i++) {
      this.ring.push({ u: rnd(), r: RING * (0.94 + rnd() * 0.12), h: rnd(), tilt: (rnd() - 0.5) * 0.18, spin: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), size: 0.8 + rnd() * 0.5 });
    }
    for (const m of [this.leaves, this.drops]) {
      m.frustumCulled = false;
      m.raycast = () => {};
    }
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
    for (const m of [this.heart, this.core, this.tendrils, this.veil, this.shell]) m.raycast = () => {};

    this.makeSprites();
    this.setLook(look);
  }

  /** The lit material of the core and the tendrils, with their bend and glow put into three.js's own shader. */
  private bodyMaterial(vertex: string, bend: string, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0 });
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, this.uniforms);
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>\n${vertex}`)
        .replace('#include <beginnormal_vertex>', bend)
        .replace('#include <begin_vertex>', 'vec3 transformed = bent;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>\n${BODY_FRAGMENT}`)
        .replace('#include <clipping_planes_fragment>', BODY_CUT)
        .replace('#include <emissivemap_fragment>', BODY_GLOW);
    };
    if (vertex === CORE_VERTEX) m.defines = { SPIRIT_CORE: '' };
    m.customProgramCacheKey = () => (vertex === CORE_VERTEX ? 'brook-core' : 'brook-tendrils');
    return m;
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
          rot: rnd() * Math.PI * 2, spin: (rnd() - 0.5) * 0.25, seed: rnd() * 100, at: new THREE.Vector3(), follow: 9, placed: false,
          ...f(i),
        });
      }
    };
    const n = COUNTS.high;
    add('dense', n.dense, (i) => ({ radius: 0.6 + (i / n.dense) * 0.65, size: 2.1 + rnd() * 0.9, alpha: 0.75 + rnd() * 0.2, follow: 10 }));
    add('wisp', n.wisp, () => ({ radius: 1.35 + rnd() * 0.6, size: 1.6 + rnd() * 1.1, stretch: 1 + rnd() * 0.6, alpha: 0.3 + rnd() * 0.2, cell: rnd() < 0.6 ? PARTICLE.wisp : PARTICLE.puff, follow: 2 + rnd() * 1.5, speed: 0.1 + rnd() * 0.12 }));
    add('veil', n.veil, (i) => ({ dir: new THREE.Vector3(i % 2 ? 1 : -1, (i < 2 ? 1 : -1) * 0.5, 0), radius: 0.22, size: 1.3 + rnd() * 0.3, alpha: 0.85, follow: 12 }));
    add('mote', n.mote, () => ({ radius: 0.7 + rnd() * 1.1, size: 0.1 + rnd() * 0.1, alpha: 1, cell: PARTICLE.glow, follow: 5, speed: 0.25 + rnd() * 0.3 }));
    add('halo', 1, () => ({ radius: 0, size: 1.1, alpha: 1, cell: PARTICLE.glow, follow: 30 }));
  }

  /** Medium and up ('high') or Low and phones ('low'): the mist's sprites, the shell, the light. */
  setLook(look: SpiritLook): void {
    this.look = look;
    this.veil.visible = look === 'low';
    const n = COUNTS[look];
    this.leaves.count = n.leaves;
    this.drops.count = n.drops;
    if (look === 'high' && this.withLight && !this.light) {
      this.light = new THREE.PointLight(COLD, 0, 14, 2);
      this.light.position.set(0, 0, 0.35);
      this.body.add(this.light);
    } else if (look === 'low' && this.light) {
      this.body.remove(this.light);
      this.light.dispose();
      this.light = null;
    }
    this.far = !this.far; // re-pick the model at the next update
  }

  /** A short flinch: the body jerks back, the tendrils curl in, the heart flares. */
  hurt(strength = 1): void {
    this.hurtT = Math.min(1.5, this.hurtT + strength);
  }

  /** The heart's middle in the world. */
  heartWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.heart.localToWorld(out.set(0, 0, 0.12));
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
      const al = b.a0 + b.a1 * s + b.curl * THREE.MathUtils.smoothstep(s, 0.55, 1) + b.wa * s * Math.sin(5 * s - this.phase + b.phase);
      const be = b.b0 + b.b1 * s + b.wb * s * Math.sin(4 * s - 0.8 * this.phase + 1.7 * b.phase);
      d.copy(a.dir).multiplyScalar(Math.cos(al) * Math.cos(be)).addScaledVector(a.up, -Math.sin(al)).addScaledVector(a.side, Math.cos(al) * Math.sin(be));
      p.addScaledVector(d, (a.length * b.stretch) / 10);
    }
    return this.body.localToWorld(out.copy(p));
  }

  private bends: Bend[] = Array.from({ length: ARMS }, (_, i) => ({ a0: 0, a1: 0, curl: 0, wa: 0, b0: 0, b1: 0, wb: 0, phase: i * 1.37, stretch: 1, thick: 1 }));
  private lastPos = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private drag = new THREE.Vector3();
  private col = new THREE.Color();
  private inv = new THREE.Matrix4();
  private mat = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private quat2 = new THREE.Quaternion();
  private scl = new THREE.Vector3();

  /** Each frame, before drawing. `camera`: for the far model and the mist's order. */
  update(dt: number, camera: THREE.Camera): void {
    dt = Math.min(dt, 0.1);
    const s = this.shown;
    s.open = ease(s.open, clamp01(this.open), 5, dt);
    s.shield = ease(s.shield, clamp01(this.shield), 3, dt);
    s.anger = ease(s.anger, clamp01(this.anger), 1.5, dt);
    s.reach = ease(s.reach, this.reach ? 1 : 0, 3, dt);
    if (this.reach) this.reachAt.copy(this.reach);
    const fade = clamp01(this.fade);
    this.hurtT = Math.max(0, this.hurtT - dt * 2.5);
    const hurt = Math.sin(Math.min(1, this.hurtT) * Math.PI * 0.5);
    this.time += dt;
    this.phase += dt * (1.5 + 1.6 * s.anger) * (1 - 0.6 * fade);
    this.pulse += dt * (2.5 + 4 * s.anger + 3 * s.reach);
    this.shared.uTime.value = this.time;

    this.group.updateMatrixWorld();
    const pos = this.tmp.setFromMatrixPosition(this.group.matrixWorld);
    if (dt > 0) this.velocity.lerp(this.tmp2.copy(pos).sub(this.lastPos).divideScalar(dt).clampLength(0, 12), 1 - Math.exp(-4 * dt));
    this.lastPos.copy(pos);

    // The light: cold green-white, amber when angered; a flare when hurt.
    this.lightColor.copy(COLD).lerp(AMBER, s.anger);
    this.uniforms.uLight.value.copy(this.lightColor);
    const night = 1 - daylight();
    const heartOn = (0.25 + 0.75 * s.open) * (1 - THREE.MathUtils.smoothstep(fade, 0.6, 1));
    const flicker = 1 + 0.08 * Math.sin(this.time * 7.3) * Math.sin(this.time * 3.1);
    this.heartU.uHeart.value = (1.5 + 4 * s.open + 5 * hurt) * (1 - 0.45 * night) * flicker * (1 - THREE.MathUtils.smoothstep(fade, 0.6, 1));
    this.uniforms.uGlow.value = (0.9 + 1.4 * s.anger + 1.2 * s.reach + 3 * hurt) * (0.6 + 0.4 * night);
    this.uniforms.uInner.value = (0.25 + 1.4 * s.open) * flicker;
    this.uniforms.uRim.value = 0.04 + 0.1 * night;
    this.uniforms.uFade.value = fade;
    this.uniforms.uPulse.value = this.pulse;
    this.uniforms.uPhase.value = this.phase;
    this.uniforms.uLip.value = THREE.MathUtils.lerp(LIP_SHUT, LIP_OPEN, s.open);
    if (this.light) {
      this.light.color.copy(this.lightColor);
      this.light.intensity = (1.5 + 12 * s.open + 10 * hurt) * heartOn;
    }

    // The body: a slow bob and breath; a flinch backwards.
    const breath = 1 + 0.025 * Math.sin(this.time * 1.3);
    this.body.position.set(0, 0.12 * Math.sin(this.time * 0.8), -0.35 * hurt);
    this.body.rotation.set(-0.25 * hurt + 0.04 * Math.sin(this.time * 0.55), 0, 0.03 * Math.sin(this.time * 0.43));
    this.body.scale.set(breath * (1 + 0.08 * hurt), breath * (1 - 0.1 * hurt), breath);
    this.group.updateMatrixWorld(true);
    this.heart.scale.setScalar((0.9 + 0.12 * s.open + 0.15 * hurt) * (1 - 0.5 * THREE.MathUtils.smoothstep(fade, 0.5, 1)));

    // Near or far model.
    const dist = camera.getWorldPosition(this.tmp2).distanceTo(pos);
    const far = dist > FAR[this.look];
    if (far !== this.far) {
      this.far = far;
      const p = far ? this.model.far : this.model.near;
      this.heart.geometry = p.heart;
      this.core.geometry = p.core;
      this.tendrils.geometry = p.tendrils;
    }

    this.bendTendrils(s, fade, hurt);
    this.drawMist(dt, camera, s, fade, hurt, night);
    this.drawRing(s, fade);
    this.shellU.uShield.value = s.shield * (1 - fade) * (0.55 - 0.3 * night); // at night the eyes' exposure and the glow do the rest
    this.shell.visible = s.shield > 0.01 && fade < 1;
    this.shell.scale.setScalar(1 + 0.25 * (1 - s.shield));
    this.veilU.uOpen.value = s.open;
    this.veilU.uAlpha.value = 0.88 * (1 - fade);
    this.veilU.uMist.value.copy(MIST_DENSE).multiplyScalar(0.35 + 0.65 * daylight() + 0.6 * night * 0.3);
    this.group.visible = fade < 1;
  }

  /** Each tendril's numbers for the shader: at rest, trailing, reaching, shielding, flinching, coming apart. */
  private bendTendrils(s: BrookSpirit['shown'], fade: number, hurt: number): void {
    // Its own motion, in its own frame: the tendrils trail behind it.
    this.inv.copy(this.group.matrixWorld).invert();
    const speed = this.velocity.length();
    const drag = this.drag.copy(this.velocity).applyQuaternion(this.quat.setFromRotationMatrix(this.inv)).multiplyScalar(speed > 1e-3 ? -Math.min(1, speed / 5) / speed : 0);
    const local = this.tmp2;
    if (s.reach > 0.001) this.body.worldToLocal(local.copy(this.reachAt));
    const waveA = (0.2 + 0.12 * s.anger) * (1 - 0.6 * s.shield);
    this.model.arms.forEach((a, i) => {
      const b = this.bends[i];
      const front = i < 2;
      // At rest: the front ones held out ahead, the others drawn back, as if it drifts forward through still air.
      const pullZ = front ? 0.4 : -0.9;
      const pullY = front ? 0.2 : 0.3;
      const px = drag.x * 0.6;
      const py = pullY + drag.y * 0.6;
      const pz = pullZ + drag.z * 0.6;
      const pu = a.up.x * px + a.up.y * py + a.up.z * pz;
      const ps = a.side.x * px + a.side.y * py + a.side.z * pz;
      // The tips curl up and out, like a fern's (the glowing nodes on the outside of the curl, where they show).
      b.a0 = -pu * 0.7 + (front ? -0.12 : -0.1);
      b.b0 = ps * 0.7;
      b.a1 = front ? 0.25 : 0.3;
      b.curl = front ? -0.75 : -0.8;
      b.wa = waveA;
      b.b1 = 0;
      b.wb = 0.16 + 0.1 * s.anger;
      b.stretch = 1;
      b.thick = 1;
      // Shielding: every arm drawn in and curled up under the body.
      if (s.shield > 0) {
        b.a0 += 0.5 * s.shield;
        b.a1 += 0.6 * s.shield;
        b.curl += 1.2 * s.shield;
        b.stretch = 1 - 0.25 * s.shield;
      }
      // Reaching: the two front arms point at the spot, nearly straight, their tips curled to grasp.
      if (front && s.reach > 0.001) {
        const w = this.tmp.copy(local).sub(a.root);
        const d = w.length();
        w.divideScalar(Math.max(d, 1e-3));
        const ar = Math.asin(THREE.MathUtils.clamp(-w.dot(a.up), -1, 1));
        const br = Math.atan2(w.dot(a.side), w.dot(a.dir));
        const r = s.reach;
        b.a1 = THREE.MathUtils.lerp(b.a1, 0.1, r);
        b.curl = THREE.MathUtils.lerp(b.curl, 0.8, r);
        b.a0 = THREE.MathUtils.lerp(b.a0, ar - 0.05 - 0.15, r);
        b.b0 = THREE.MathUtils.lerp(b.b0, br, r);
        b.wa *= 1 - 0.75 * r;
        b.wb *= 1 - 0.75 * r;
        b.stretch = THREE.MathUtils.lerp(b.stretch, THREE.MathUtils.clamp(d / (a.length * 0.95), 0.85, 1.3), r);
      }
      // A flinch: all curl in at once; coming apart: they droop and go still.
      b.curl += 1.1 * hurt;
      b.a0 += 0.35 * hurt;
      b.a1 += 0.6 * fade;
      b.wa *= 1 - 0.5 * fade;
      b.thick = 1 / Math.sqrt(b.stretch);
      this.uniforms.uBendA.value[i].set(b.a0, b.a1, b.curl, b.wa);
      this.uniforms.uBendB.value[i].set(b.b0, b.b1, b.wb, b.phase);
      this.uniforms.uArmX.value[i].set(b.stretch, b.thick, 0, 0);
    });
  }

  /** The mist and the lights: placed, trailed, lit, sorted far to near, written into the two sprite draws. */
  private drawMist(dt: number, camera: THREE.Camera, s: BrookSpirit['shown'], fade: number, hurt: number, night: number): void {
    const look = this.look;
    const n = COUNTS[look];
    const keep: Record<Layer, number> = { dense: n.dense, wisp: n.wisp, veil: n.veil, mote: n.mote, halo: 1 };
    const seen: Record<Layer, number> = { dense: 0, wisp: 0, veil: 0, mote: 0, halo: 0 };
    const day = daylight();
    // The mist's own light: what the day gives it, and a little at night so its outline holds against a dark wood.
    const ambient = 0.3 + 0.7 * day;
    const groupInv = this.inv.copy(this.group.matrixWorld).invert();
    const view = camera.matrixWorldInverse;
    const p = new THREE.Vector3();
    const camLocal = this.group.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
    const facing = clamp01(camLocal.clone().normalize().z * 1.4 + 0.2); // the halo shows from in front
    this.mist.begin();
    this.glow.begin();
    this.order.length = 0;
    const active: Sprite[] = [];
    for (const sp of this.sprites) {
      if (seen[sp.layer]++ >= keep[sp.layer]) continue;
      active.push(sp);
    }
    const spread = 1 + 2.4 * fade * fade + 0.25 * hurt;
    for (const sp of active) {
      const t = this.time;
      if (sp.layer === 'halo') p.set(0, 0, 0.6);
      else if (sp.layer === 'veil') {
        // In front of the heart; parts to either side as it opens.
        const side = Math.sign(sp.dir.x);
        p.set(side * (0.22 + 1.0 * s.open), sp.dir.y * (0.45 + 0.35 * s.open), 0.66 - 0.25 * s.open);
      } else {
        p.copy(sp.dir).applyAxisAngle(sp.axis, t * sp.speed + sp.seed);
        const r = sp.radius * (1 + 0.12 * Math.sin(t * 0.7 + sp.seed));
        p.multiplyScalar(r).multiply(this.scl.set(1.25, sp.layer === 'wisp' ? 0.85 : 0.72, 1.1));
        if (sp.layer === 'wisp') p.y -= 0.3; // its torn edge hangs low, among the tendrils
        if (sp.layer === 'mote') p.y += 0.25 * Math.sin(t * 1.3 + sp.seed);
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
    // Sorted far to near (the dense mist blends; order matters there).
    const depths = this.depth;
    depths.length = active.length;
    active.forEach((sp, i) => {
      depths[i] = this.tmp.copy(sp.at).applyMatrix4(view).z;
      this.order.push(i);
    });
    this.order.sort((a, b) => depths[a] - depths[b]);
    this.shared.uCore.value.set(0, 0, 0, CORE_CLEAR * (1 + 0.6 * fade));
    for (const k of this.order) {
      const sp = active[k];
      const local = this.tmp.copy(sp.at).applyMatrix4(groupInv);
      const toHeart = Math.sqrt((local.x * local.x) / 1.2 + local.y * local.y + (local.z - 0.3) * (local.z - 0.3));
      const fadeA = 1 - fade;
      if (sp.layer === 'halo') {
        const a = (0.1 + 0.9 * s.open) * facing * (1 - fade) * (1 - 0.7 * s.shield);
        this.col.copy(this.lightColor).multiplyScalar(0.7 + 0.3 * night + hurt);
        this.glow.put(local, sp.size * (0.6 + 0.6 * s.open), sp.size * (0.6 + 0.6 * s.open), 0, sp.cell, this.col, a);
      } else if (sp.layer === 'mote') {
        const tw = 0.6 + 0.4 * Math.sin(this.time * (2 + (sp.seed % 3)) + sp.seed);
        this.col.copy(this.lightColor).multiplyScalar((1.6 + 2 * night) * tw);
        const grow = 1 + 1.5 * fade;
        this.glow.put(local, sp.size * grow, sp.size * grow, 0, sp.cell, this.col, (1 - THREE.MathUtils.smoothstep(fade, 0.7, 1)) * (0.5 + 0.5 * s.anger + 0.3 * night));
      } else {
        const dense = sp.layer === 'dense' || sp.layer === 'veil';
        this.col.copy(dense ? MIST_DENSE : MIST_THIN);
        if (fade > 0) this.col.lerp(MIST_THIN, fade);
        // Lighter on top, as mist under an open sky; the inner light on what lies close round the heart.
        const top = 0.75 + 0.5 * THREE.MathUtils.clamp(local.y / 1.2, -1, 1);
        this.col.multiplyScalar(ambient * top);
        const inner = Math.exp(-toHeart * toHeart * 2.2) * (0.03 + 0.2 * s.open + 0.4 * hurt) * (0.5 + 0.5 * night);
        this.col.r += this.lightColor.r * inner;
        this.col.g += this.lightColor.g * inner;
        this.col.b += this.lightColor.b * inner;
        let a = sp.alpha * fadeA;
        if (sp.layer === 'veil') a *= 1 - 0.85 * s.open;
        const size = sp.size * (1 + 0.6 * fade);
        this.mist.put(local, size, size * sp.stretch, sp.rot, sp.cell, this.col, a);
      }
    }
    this.mist.end();
    this.glow.end();
  }

  /** The leaves and drops: a slow tilted spiral round it, or a closed shell when it shields itself. */
  private drawRing(s: BrookSpirit['shown'], fade: number): void {
    const n = COUNTS[this.look];
    const t = this.time;
    const shield = s.shield;
    const total = n.leaves + n.drops;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < total; i++) {
      const leaf = i < n.leaves;
      const r = this.ring[leaf ? i : COUNTS.high.leaves + (i - n.leaves)];
      // The ring: round it at its own radius, slowly rising through a band and fading in and out at its ends.
      const h = (r.h + t * 0.03) % 1;
      const ang = r.u * Math.PI * 2 + t * (leaf ? 0.32 : 0.45) + h * 2.2;
      const ringP = this.tmp.set(Math.cos(ang) * r.r, -0.45 + h * 0.9 + r.tilt, Math.sin(ang) * r.r);
      ringP.applyAxisAngle(this.scl.set(1, 0, 0.3).normalize(), 0.3);
      // The shell: an even spread over a sphere, turning faster.
      const k = i + 0.5;
      const yy = 1 - (2 * k) / total;
      const rr = Math.sqrt(1 - yy * yy);
      const sa = golden * k + t * 0.9;
      const shellP = this.tmp2.set(Math.cos(sa) * rr, yy, Math.sin(sa) * rr).multiplyScalar(SHELL * (leaf ? 1.0 : 1.02));
      ringP.lerp(shellP, shield);
      ringP.multiplyScalar(1 + 1.5 * fade);
      ringP.y -= fade * 1.5; // what it held falls when it comes apart
      const edge = Math.sin(Math.PI * h);
      const size = r.size * (shield + (1 - shield) * Math.min(1, edge * 3)) * (1 - THREE.MathUtils.smoothstep(fade, 0.5, 1));
      // Tumbling in the ring; lying flat on the shell.
      this.quat.setFromAxisAngle(r.spin, t * 0.8 + r.u * 20);
      if (shield > 0) {
        this.quat2.setFromUnitVectors(this.scl.set(0, 1, 0), this.tmp2.copy(shellP).normalize());
        this.quat.slerp(this.quat2, shield);
      }
      this.mat.compose(ringP, this.quat, this.scl.setScalar(size * (leaf ? 1.4 : 1)));
      if (leaf) this.leaves.setMatrixAt(i, this.mat);
      else this.drops.setMatrixAt(i - n.leaves, this.mat);
    }
    this.leaves.instanceMatrix.needsUpdate = true;
    this.drops.instanceMatrix.needsUpdate = true;
    // The drops catch its light.
    (this.drops.material as THREE.MeshStandardMaterial).emissive.copy(this.lightColor).multiplyScalar(0.25 + 0.4 * shield);
  }

  dispose(): void {
    this.mist.dispose();
    this.glow.dispose();
    for (const m of [this.heart, this.core, this.tendrils, this.veil, this.shell, this.leaves, this.drops]) (m.material as THREE.Material).dispose();
    this.veil.geometry.dispose();
    this.shell.geometry.dispose();
    this.leaves.geometry.dispose();
    this.drops.geometry.dispose();
    this.light?.dispose();
    this.group.removeFromParent();
  }
}
