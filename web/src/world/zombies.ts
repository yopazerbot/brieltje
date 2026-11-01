import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BIG, RUNNER, VARIANTS, type Horde } from '../../shared/zombies.mjs';
import type { ZombieAct, ZombieSample } from '../../shared/wire.mjs';
import { netClock, Track } from '../net/track';
import { sound } from '../sound';
import { paintball } from '../paintball';

/**
 * The Zombies game's zombies on screen (shared/zombies.mjs runs them: the server together, the page
 * alone). Our own Blender models (tools/zombies.py, web/public/models/zombies.glb): four kinds and
 * a big one, each rigged, with their clips (walk, lurch, idle, swipe, flinch, fall; the runners'
 * sprint, the hoodie's own; the big one's stomp and pound) baked into the file. In the houses the
 * server says which floor one walks on (its tick's `y`); the page's own ground gives the exact height
 * there (a stair's step), and the figure eases up and down the steps.
 *
 * Cheap to draw: thirty zombies are a handful of draws. When the file loads, every clip of every
 * kind is sampled 30 times a second into one half-float picture of bone matrices (60 texels by
 * about 1,200 rows, 0.6 MB on the graphics card; values a few metres at most, so half floats hold
 * them). Each kind (and its simpler far version, used beyond LOD_FAR m) is one instanced mesh: the
 * vertex shader skins every zombie from that picture at its own frame, blending two frames (or two
 * clips, for a fifth of a second when it changes what it does). So a kind costs one draw however many
 * there are, and nothing per bone on the processor. They stay out of the ambient occlusion pass (its
 * plain material can't pose them: src/main.ts).
 *
 * Shooting them: each has two invisible hit boxes (body and head, the head's following its head
 * bone) like a player's. In paintball the paint sticks to the figure where it hit and moves with it:
 * the hit's spot on the posed body is found on the processor (the same matrices), turned back to the
 * figure's rest pose, and up to eight spots a zombie are painted by its fragment shader.
 *
 * Down: they fall over and fade; in paintball they vanish in a puff of paint. They groan now and then
 * (made in code like the game's other sounds, quiet, from where they stand), swish when they swipe.
 */

const URL_GLB = '/models/zombies.glb';
const KINDS = [...VARIANTS, 'big'];
const FPS = 30; // the clips are sampled this often
const LOD_FAR = 24; // m: beyond this, the simpler model
const MAX = 32; // zombies of one kind at once (the game keeps at most 30 up)
const SPOTS = 8; // paint spots per zombie
const SLOTS = 64; // zombies with paint at once (rows of the paint picture)
const BLEND = 0.18; // s to change from one clip to the next
/** The walking clips: played at the pace their feet keep on the ground (measured from the clip as it loads), so they don't slide. */
const WALKS = new Set(['Walk', 'Lurch', 'Stomp', 'Run']);
const LURCH_FROM = 0.95; // m/s: faster than this a regular zombie lurches (about its lurch's own pace)
const RUN_FROM = 1.6; // m/s: faster than this a runner sprints (its run's own pace is about 3.2)
const FALL_FADE = 0.9; // s the fallen body takes to fade, from 2 s after the fall
const PUFF_S = 0.22; // s a beaten zombie takes to vanish in paintball

type Clip = { row: number; frames: number; loop: boolean; duration: number; stride: number };
interface Rig {
  /** First row of this mesh's clips in the picture, its bones */
  bones: THREE.Bone[];
  clips: Map<string, Clip>;
  /** Per row, per bone: the skinning matrix (12 numbers) and the bone's own place in the figure (16), for paint and the head box */
  skin: Float32Array;
  place: Float32Array;
  head: number;
  chest: number;
}
interface Kind {
  meshes: [THREE.InstancedMesh, THREE.InstancedMesh];
  rigs: [Rig, Rig];
  /** The near mesh's rest positions and triangles, for finding where paint lands */
  rest: THREE.BufferAttribute;
  index: ArrayLike<number>;
  skinIndex: THREE.BufferAttribute;
  skinWeight: THREE.BufferAttribute;
  /** Height of the figure (m), for the hit boxes */
  height: number;
}

interface Spot {
  x: number;
  y: number;
  z: number;
  r: number;
  color: THREE.Color;
}

export interface ZombieState {
  id: number;
  kind: number;
  x: number;
  z: number;
  yaw: number;
  act: ZombieAct;
  hp: number;
  /** The floor it walks on (the server's tick, or the horde alone); null from a server before it */
  y?: number | null;
}

interface Z extends ZombieState {
  /** Multiplayer: where the server had it (x, z, yaw, floor) */
  track: Track<null> | null;
  seen: number;
  y: number;
  /** The floor it walks on as the game has it (NaN: not told), the ground found under it there and where that was looked up */
  floor: number;
  ground: number;
  groundAt: [number, number];
  floorAt: number;
  /** Where it was drawn last frame (its speed comes from how far it went since) */
  lx: number;
  lz: number;
  speed: number;
  /** What it plays: clip and time; the clip it changes from and when that began */
  clip: string;
  time: number;
  from: string;
  fromTime: number;
  blend: number;
  actAt: number;
  phase: number;
  flash: number;
  fade: number;
  downAt: number;
  puffed: boolean;
  slot: number;
  spots: Spot[];
  hits: THREE.Group;
  head: THREE.Mesh;
  body: THREE.Mesh;
  groanIn: number;
  /** Metres to its next footfall (heard close by) */
  stepIn: number;
  /** The near model's rows and blend this frame (for the hit boxes and the paint), and which model is drawn */
  rowA: number;
  rowB: number;
  mix: number;
  lod: 0 | 1;
}

const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
const bodyBox = new THREE.BoxGeometry(0.55, 1.2, 0.45).translate(0, 0.6, 0);
const headBox = new THREE.SphereGeometry(0.17, 8, 6);

/** The skinning added to the standard material (and the shadow's), reading the bone picture at each zombie's frames. */
const SKIN_PARS = /* glsl */ `
#ifndef USE_SKINNING
attribute vec4 skinIndex;
attribute vec4 skinWeight;
#endif
attribute vec4 aAnim;
attribute vec4 aLook;
uniform highp sampler2D uBones;
varying vec3 vRest;
varying vec4 vLook;
mat4 zBone(float bone, float row) {
  ivec2 at = ivec2(int(bone) * 3, int(row));
  vec4 a = texelFetch(uBones, at, 0);
  vec4 b = texelFetch(uBones, at + ivec2(1, 0), 0);
  vec4 c = texelFetch(uBones, at + ivec2(2, 0), 0);
  return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
}
mat4 zSkinAt(float row) {
  return zBone(skinIndex.x, row) * skinWeight.x + zBone(skinIndex.y, row) * skinWeight.y
    + zBone(skinIndex.z, row) * skinWeight.z + zBone(skinIndex.w, row) * skinWeight.w;
}
`;
const SKIN_MATRIX = /* glsl */ `
mat4 zSkin = zSkinAt(aAnim.x) * (1.0 - aAnim.z) + zSkinAt(aAnim.y) * aAnim.z;
`;

function skinnedStandard(base: THREE.Material, bones: THREE.Texture, paint: THREE.Texture): THREE.MeshStandardMaterial {
  const src = base as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardMaterial({ color: src.color ?? new THREE.Color('#ffffff'), map: src.map ?? null, vertexColors: !!src.vertexColors, roughness: src.roughness ?? 0.85, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = { value: bones };
    shader.uniforms.uPaint = { value: paint };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SKIN_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${SKIN_MATRIX}\nobjectNormal = normalize(mat3(zSkin) * objectNormal);\nvRest = position;\nvLook = aLook;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = (zSkin * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform highp sampler2D uPaint;
varying vec3 vRest;
varying vec4 vLook;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
// Fading out (fallen): a dither, so no sorting is needed.
if (vLook.y < 0.999) {
  float n = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
  if (n > vLook.y) discard;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
// Paintball: its paint spots, round blobs with a ragged edge, on the body as it stood (so they move with it).
for (int i = 0; i < ${SPOTS}; i++) {
  if (float(i) >= vLook.z) break;
  vec4 s = texelFetch(uPaint, ivec2(i * 2, int(vLook.w)), 0);
  vec4 c = texelFetch(uPaint, ivec2(i * 2 + 1, int(vLook.w)), 0);
  vec3 d = vRest - s.xyz;
  float wob = 0.18 * sin(d.x * 61.0 + d.y * 47.0) * sin(d.z * 53.0 - d.y * 37.0);
  if (length(d) < s.w * (1.0 + wob)) diffuseColor.rgb = c.rgb;
}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.55, 0.5, 0.4) * vLook.x;');
  };
  m.customProgramCacheKey = () => 'zombie-skin';
  return m;
}

function skinnedDepth(bones: THREE.Texture): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = { value: bones };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SKIN_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SKIN_MATRIX}\ntransformed = (zSkin * vec4(transformed, 1.0)).xyz;\nvRest = position;\nvLook = aLook;`);
  };
  m.customProgramCacheKey = () => 'zombie-depth';
  return m;
}

/**
 * How the zombies sound by how close they are: groans more often and louder the nearer they come (on
 * top of the panner's own fall-off), from where they stand. Quiet past FAR_SOUND, and nothing past
 * HEAR. Runners puff as they sprint, the big one groans low and thumps; close by, their feet shuffle.
 * Never a scream: it is a family game. At most VOICES sounds at once and GROANS groans a second.
 */
const HEAR = 40; // m
const FAR_SOUND = 30; // m: from here on the slowest and quietest
const VOICES = 7;
const GROANS = 4;
const STEPS_NEAR = 9; // m: feet heard this close

/** 0 far off .. 1 right next to you. */
const nearness = (d: number) => Math.max(0, Math.min(1, 1 - (d - 2) / (FAR_SOUND - 2)));

/** Seconds to a zombie's next groan at distance `d`: about every 9 s far off, every 2 s close by (runners more often, the big one less). */
export function groanGap(d: number, kind: number): number {
  const n = nearness(d);
  const [far, near] = kind === BIG ? [10, 3] : kind === RUNNER ? [7, 1.4] : [9, 2.1];
  return (far + (near - far) * n) * (0.75 + Math.random() * 0.5);
}

/** A soft groan, made in code: a low buzz through a vowel-like filter, sliding down. `near` (0..1) makes it a little louder; the big one lower, a runner shorter and higher. */
function groan(at: THREE.Vector3, kind: number, near: number): number {
  const big = kind === BIG;
  const run = kind === RUNNER;
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 1.5, at.z, big ? 5 : 3);
  if (!ctx || !dest) return 0;
  const t = ctx.currentTime;
  const len = run ? 0.4 + Math.random() * 0.2 : 0.7 + Math.random() * 0.5;
  const f0 = (big ? 62 : run ? 120 : 95) * (0.9 + Math.random() * 0.25);
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.linearRampToValueAtTime(f0 * 1.12, t + len * 0.35); // "uuu-uh"
  o.frequency.exponentialRampToValueAtTime(f0 * 0.75, t + len);
  const wob = ctx.createOscillator();
  wob.frequency.value = 5 + Math.random() * 2;
  const wobGain = ctx.createGain();
  wobGain.gain.value = f0 * 0.04;
  wob.connect(wobGain).connect(o.frequency);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 3;
  f.frequency.setValueAtTime(big ? 420 : 560, t);
  f.frequency.linearRampToValueAtTime(big ? 330 : 430, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime((big ? 0.32 : 0.2) * (0.6 + 0.6 * near), t + 0.12);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(f).connect(g).connect(dest);
  o.start(t);
  wob.start(t);
  o.stop(t + len + 0.05);
  wob.stop(t + len + 0.05);
  return len;
}

/** A runner's puff: two quick breaths of soft noise, "hff-hff", from where it runs. */
function huff(at: THREE.Vector3, near: number): number {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 1.5, at.z, 3);
  if (!ctx || !dest) return 0;
  const t = ctx.currentTime;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.12), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / data.length) ** 2;
  for (const k of [0, 0.19]) {
    const n = ctx.createBufferSource();
    n.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.value = 900 + Math.random() * 300;
    const g = ctx.createGain();
    g.gain.value = 0.12 * (0.6 + 0.6 * near);
    n.connect(f).connect(g).connect(dest);
    n.start(t + k);
  }
  return 0.35;
}

/** A footfall close by: a soft scuff of noise, or the big one's thump. */
function step(at: THREE.Vector3, big: boolean): number {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 0.1, at.z, 2);
  if (!ctx || !dest) return 0;
  const t = ctx.currentTime;
  if (big) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.25);
    return 0.25;
  }
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.09), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const n = ctx.createBufferSource();
  n.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 1400;
  const g = ctx.createGain();
  g.gain.value = 0.07;
  n.connect(f).connect(g).connect(dest);
  n.start(t);
  return 0.1;
}

/** A swipe's swish (noise through a sweeping filter), or the big one's pound (a low thump). */
function swish(at: THREE.Vector3, big: boolean): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 1, at.z, 3);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  if (big) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(80, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.8, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.55);
    return;
  }
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.25), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / data.length);
  const n = ctx.createBufferSource();
  n.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.5;
  f.frequency.setValueAtTime(600, t);
  f.frequency.exponentialRampToValueAtTime(2400, t + 0.22);
  const g = ctx.createGain();
  g.gain.value = 0.22;
  n.connect(f).connect(g).connect(dest);
  n.start(t);
}

/** A soft thump where one falls. */
function flump(at: THREE.Vector3): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y, at.z, 3);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.32);
}

/**
 * A soft dark patch on the ground under each zombie (as under the players' figures: net/avatars.ts),
 * all in one instanced draw. The zombies cast no real-time shadow: skinned again in the sun's shadow
 * pass, thirty of them cost about 1.7 ms on Low.
 */
function shadowPatches(n: number): THREE.InstancedMesh {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const mat = new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: new THREE.CanvasTexture(c), transparent: true, opacity: 0.34, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, n);
  mesh.count = 0;
  mesh.frustumCulled = false; // spread over the area: one draw, a few pixels each
  mesh.renderOrder = 1;
  mesh.userData.ignoreRay = true;
  mesh.raycast = () => {};
  return mesh;
}

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Zombies {
  readonly group = new THREE.Group();
  /** The hit boxes, a group of their own (raycast by the weapon) */
  readonly hits = new THREE.Group();
  /** Resolves when the models are in (false if they couldn't be loaded) */
  readonly ready: Promise<boolean>;
  private kinds: Kind[] = [];
  private zs = new Map<number, Z>();
  private boneTex: THREE.DataTexture | null = null;
  private paintTex: THREE.DataTexture;
  private paintData = new Uint16Array(SPOTS * 2 * 4 * SLOTS);
  private freeSlots = Array.from({ length: SLOTS }, (_, i) => SLOTS - 1 - i);
  private pose = [0, 0, 0, 0];
  private patches = shadowPatches(MAX * 2);
  private clock = 0;
  private groans = 0; // groans started in the last second, at most GROANS
  private groanClock = 0;
  /** When each sound playing now ends (this.clock): at most VOICES at once */
  private voices: number[] = [];
  /** Sounds asked for since the page began, by kind and how near (for the checks in the dev build; counted with no sound too) */
  readonly heard = { groanNear: 0, groanFar: 0, huff: 0, step: 0, skipped: 0 };
  /** A zombie fell (in paintball: vanished) here: for the puff */
  onVanish: (at: THREE.Vector3) => void = () => {};

  constructor(private floorAt: (x: number, z: number, y: number) => number) {
    this.group.name = 'zombies';
    this.group.add(this.patches);
    this.hits.name = 'zombie-hits';
    this.paintTex = new THREE.DataTexture(this.paintData, SPOTS * 2, SLOTS, THREE.RGBAFormat, THREE.HalfFloatType);
    this.paintTex.minFilter = this.paintTex.magFilter = THREE.NearestFilter;
    this.paintTex.generateMipmaps = false;
    this.paintTex.needsUpdate = true;
    this.ready = new GLTFLoader().loadAsync(URL_GLB).then(
      (gltf) => {
        this.build(gltf);
        return true;
      },
      (e) => {
        console.warn('zombies: models not loaded', e);
        return false;
      },
    );
  }

  /** Every kind's meshes, its clips sampled into the bone picture, and an instanced mesh per kind and distance. */
  private build(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }): void {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const mixer = new THREE.AnimationMixer(scene);
    const rows: Float32Array[] = [];
    let row = 0;
    let width = 0;
    const pending: { kind: number; meshes: THREE.SkinnedMesh[]; rigs: Rig[]; height: number }[] = [];
    // Every bone's rest pose, put back before each clip is sampled (a bone a clip doesn't move keeps its rest).
    const rest: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) rest.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
    });
    const toRest = () => rest.forEach((r) => {
      r.o.position.copy(r.p);
      r.o.quaternion.copy(r.q);
      r.o.scale.copy(r.s);
    });
    KINDS.forEach((name, k) => {
      // The kind's top node (its armature and both models under it).
      const root = scene.children.find((o) => o.name === `zombie_${name}`) ?? scene.getObjectByName(`zombie_${name}`);
      const skinned: THREE.SkinnedMesh[] = [];
      root?.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh);
      });
      const near = skinned.find((m) => !/lod/i.test(m.name)) ?? skinned[0];
      const far = skinned.find((m) => /lod/i.test(m.name)) ?? near;
      if (!near) throw new Error(`zombies.glb: no zombie_${name}`);
      // Its clips: '<kind>_Walk' (or 'Armature|<kind>_Walk' and the like), by the name after the kind.
      const clips = new Map<string, THREE.AnimationClip>();
      for (const c of gltf.animations) {
        const m = new RegExp(`(?:^|[|_])${name}[_|](\\w+)$`).exec(c.name);
        if (m) clips.set(m[1], c);
      }
      // The figure's feet to the origin (it may stand anywhere in the file), from its rest pose.
      const box = new THREE.Box3();
      const pos = near.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) box.expandByPoint(_v.fromBufferAttribute(pos, i).applyMatrix4(near.bindMatrix));
      const shift = new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      const rig = (mesh: THREE.SkinnedMesh): Rig => {
        const bones = mesh.skeleton.bones;
        width = Math.max(width, bones.length * 3);
        const r: Rig = { bones, clips: new Map(), skin: new Float32Array(0), place: new Float32Array(0), head: -1, chest: -1 };
        // By the bone's own name: the loader drops its dot and numbers repeated names ('Head_2', 'FootL_3').
        const named = (re: RegExp) => bones.findIndex((b) => re.test(b.name.replace(/_\d+$/, '')));
        r.head = named(/^head$/i);
        r.chest = named(/^chest$/i);
        const skin: number[] = [];
        const place: number[] = [];
        for (const [clipName, clip] of clips) {
          const loop = !/^(Attack|Pound|Flinch|Fall)$/.test(clipName);
          const frames = loop ? Math.max(2, Math.round(clip.duration * FPS)) : Math.max(2, Math.ceil(clip.duration * FPS) + 1);
          const entry: Clip = { row, frames, loop, duration: clip.duration, stride: 0 };
          r.clips.set(clipName, entry);
          const foot = named(/^foot\.?l$/i);
          const feet: [number, number][] = []; // the left foot's height and place along the figure, each frame
          toRest();
          const action = mixer.clipAction(clip);
          // A clip that plays once holds its last frame (repeating, its end would be its start again).
          if (!loop) {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
          }
          action.reset().play();
          for (let f = 0; f < frames; f++) {
            const t = loop ? (f * clip.duration) / frames : Math.min(clip.duration, f / FPS);
            mixer.setTime(t);
            scene.updateMatrixWorld(true);
            const line = new Float32Array(bones.length * 12);
            bones.forEach((b, i) => {
              _n.copy(shift).multiply(b.matrixWorld);
              place.push(..._n.elements);
              _m.copy(_n).multiply(mesh.skeleton.boneInverses[i]).multiply(mesh.bindMatrix);
              const e = _m.elements; // column-major: the three rows of the affine part
              const rowsOf = [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]];
              skin.push(...rowsOf);
              line.set(rowsOf, i * 12);
              if (i === foot) feet.push([_n.elements[13], _n.elements[14]]);
            });
            rows.push(line);
            row++;
          }
          action.stop();
          // A walk in place: while a foot is planted (at its lowest) it goes back at the pace the figure
          // walks; that pace over the loop's length is how far the loop carries it.
          if (WALKS.has(clipName) && feet.length > 2) {
            const low = Math.min(...feet.map((f) => f[0])) + 0.012;
            let back = 0;
            let steps = 0;
            for (let f = 0; f < feet.length; f++) {
              const [a, b] = [feet[f], feet[(f + 1) % feet.length]];
              if (a[0] > low || b[0] > low) continue;
              back += a[1] - b[1];
              steps++;
            }
            if (steps > 0 && back > 0) entry.stride = (back / steps) * frames;
          }
        }
        r.skin = new Float32Array(skin);
        r.place = new Float32Array(place);
        return r;
      };
      const r0 = rig(near);
      const same = far === near || (far.skeleton.bones.length === near.skeleton.bones.length && far.skeleton.bones.every((b, i) => b === near.skeleton.bones[i]) && far.bindMatrix.equals(near.bindMatrix));
      const r1 = same ? r0 : rig(far);
      pending.push({ kind: k, meshes: [near, far], rigs: [r0, r1], height: box.max.y - box.min.y });
    });
    // One picture for all of them: a row per frame, three texels per bone (the matrix's three rows of
    // four numbers, in RGBA), as half floats. `width` is in texels: the most bones of any kind, times 3.
    const rowFloats = width * 4;
    const out = new Uint16Array(rowFloats * row);
    rows.forEach((line, y) => {
      for (let i = 0; i < line.length; i++) out[y * rowFloats + i] = THREE.DataUtils.toHalfFloat(line[i]);
    });
    this.boneTex = new THREE.DataTexture(out, width, row, THREE.RGBAFormat, THREE.HalfFloatType);
    this.boneTex.minFilter = this.boneTex.magFilter = THREE.NearestFilter;
    this.boneTex.generateMipmaps = false;
    this.boneTex.needsUpdate = true;
    for (const p of pending) {
      const meshes = p.meshes.map((src, lod) => {
        const geo = new THREE.BufferGeometry();
        for (const a of ['position', 'normal', 'color', 'uv', 'skinIndex', 'skinWeight']) if (src.geometry.attributes[a]) geo.setAttribute(a, src.geometry.attributes[a]);
        geo.setIndex(src.geometry.index);
        geo.setAttribute('aAnim', new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage));
        // Its bounds hold any pose (lying down too): the rest pose's ball, made bigger.
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, p.height * 0.5, 0), p.height * 1.15);
        const mesh = new THREE.InstancedMesh(geo, skinnedStandard(src.material as THREE.Material, this.boneTex!, this.paintTex), MAX);
        mesh.customDepthMaterial = skinnedDepth(this.boneTex!);
        mesh.count = 0;
        mesh.castShadow = false; // a patch on the ground instead (shadowPatches)
        mesh.receiveShadow = true;
        mesh.userData.ignoreRay = true;
        mesh.userData.noAO = true;
        mesh.raycast = () => {};
        mesh.name = `zombies-${KINDS[p.kind]}-${lod}`;
        this.group.add(mesh);
        return mesh;
      }) as unknown as [THREE.InstancedMesh, THREE.InstancedMesh];
      const near = p.meshes[0].geometry;
      this.kinds[p.kind] = {
        meshes, rigs: p.rigs as [Rig, Rig], rest: near.attributes.position as THREE.BufferAttribute, index: near.index?.array ?? Array.from({ length: near.attributes.position.count }, (_, i) => i),
        skinIndex: near.attributes.skinIndex as THREE.BufferAttribute, skinWeight: near.attributes.skinWeight as THREE.BufferAttribute, height: p.height,
      };
    }
  }

  /** The pictures the shaders read (the bone matrices, the paint), to upload before a wave comes. */
  textures(): THREE.Texture[] {
    return this.boneTex ? [this.boneTex, this.paintTex] : [];
  }

  /** How many are shown, for the diagnostics. */
  get count(): number {
    return this.zs.size;
  }

  private make(s: ZombieState): Z {
    const big = s.kind === BIG;
    const hits = new THREE.Group();
    const body = new THREE.Mesh(bodyBox, hitMaterial);
    const head = new THREE.Mesh(headBox, hitMaterial);
    body.userData = { zombie: s.id, part: 'body' };
    head.userData = { zombie: s.id, part: 'head' };
    // The body's box from the feet to the shoulders (its figure's height), the big one's broader.
    const h = this.kinds[s.kind]?.height ?? (big ? 2.6 : 1.7);
    body.scale.set(big ? 1.9 : 1, (h * 0.84) / 1.2, big ? 1.9 : 1);
    head.scale.setScalar(big ? 1.4 : 1);
    // Hidden (and so not hit) until placed where it stands (placeHits): a ray tests a mesh's own flag, not its group's.
    body.visible = head.visible = false;
    hits.add(body, head);
    this.hits.add(hits);
    return {
      ...s, track: null, seen: performance.now(), y: s.y ?? 0, floor: s.y ?? NaN, ground: 0, groundAt: [NaN, NaN], floorAt: NaN, lx: s.x, lz: s.z, speed: 0, clip: 'Idle', time: Math.random() * 2, from: '', fromTime: 0, blend: 1,
      actAt: this.clock, phase: Math.random(), flash: 0, fade: 0, downAt: s.act === 'down' ? this.clock - 5 : 0, puffed: false, slot: -1, spots: [], hits, head, body,
      groanIn: 2 + Math.random() * 6, stepIn: Math.random(), rowA: 0, rowB: 0, mix: 0, lod: 0,
    };
  }

  /** What one does now (from the server's tick, or the horde alone); a change starts its clip. */
  private set(z: Z, s: ZombieState): void {
    if (s.act !== z.act) {
      z.actAt = this.clock;
      if (s.act === 'hurt') z.flash = 1;
      if (s.act === 'attack') swish(_v.set(z.x, z.y, z.z), z.kind === BIG);
      if (s.act === 'down' && !z.downAt) this.fall(z);
    }
    z.act = s.act;
    z.hp = s.hp;
  }

  private fall(z: Z): void {
    z.downAt = this.clock;
    z.flash = 1;
    flump(_v.set(z.x, z.y, z.z));
    if (paintball.on) this.onVanish(_v.set(z.x, z.y + 1, z.z).clone());
  }

  /** The zombies in a tick taken at the server's time `st` (multiplayer). One left out of it stood still. */
  receive(list: ZombieSample[], st: number): void {
    const seen = new Set<number>();
    const now = performance.now();
    for (const s of list) {
      seen.add(s.id);
      let z = this.zs.get(s.id);
      if (!z) {
        z = this.make(s);
        z.act = s.act;
        this.zs.set(s.id, z);
      }
      if (!z.track) {
        z.track = new Track<null>([false, false, true, false], 4, [0, 1]);
        Object.assign(z, { x: s.x, z: s.z, yaw: s.yaw });
      }
      z.seen = now;
      this.set(z, s);
      // Its floor goes along (a server from before it sends none: then its own ground is looked up near where it was).
      if (typeof s.y === 'number') z.floor = s.y;
      z.track.push(st, [s.x, s.z, s.yaw, Number.isFinite(z.floor) ? z.floor : 0], null);
    }
    for (const z of this.zs.values()) if (z.track && !seen.has(z.id)) z.track.hold(st);
  }

  /** Alone: the horde's zombies as they are (shared/zombies.mjs runs here). */
  follow(horde: Horde): void {
    for (const q of horde.zombies.values()) {
      let z = this.zs.get(q.id);
      if (!z) {
        z = this.make(q);
        z.act = q.act;
        this.zs.set(q.id, z);
      }
      z.track = null;
      Object.assign(z, { x: q.x, z: q.z, yaw: q.yaw, floor: q.y });
      z.seen = performance.now();
      this.set(z, q);
    }
    for (const id of [...this.zs.keys()]) if (!horde.zombies.has(id)) this.remove(id);
  }

  /** Zombie `id` was beaten (a 'zdown' from the server, or here alone): it falls, or vanishes in paint. */
  beaten(id: number): void {
    const z = this.zs.get(id);
    if (z && !z.downAt) {
      z.act = 'down';
      z.actAt = this.clock;
      this.fall(z);
    }
  }

  /** Gone for good (the server took them away, or the game ended). */
  gone(ids: number[]): void {
    for (const id of ids) this.remove(id);
  }

  clear(): void {
    for (const id of [...this.zs.keys()]) this.remove(id);
  }

  private remove(id: number): void {
    const z = this.zs.get(id);
    if (!z) return;
    z.hits.removeFromParent();
    this.unpaint(z);
    this.zs.delete(id);
  }

  private unpaint(z: Z): void {
    if (z.slot >= 0) this.freeSlots.push(z.slot);
    z.slot = -1;
    z.spots = [];
  }

  /** Those up within `radius` of a point (a blast, alone). */
  near(p: THREE.Vector3, radius: number): number[] {
    return [...this.zs.values()].filter((z) => !z.downAt && Math.hypot(z.x - p.x, z.z - p.z) < radius + (z.kind === BIG ? 0.8 : 0.35)).map((z) => z.id);
  }

  /** Those up, for the minimap. */
  blips(): { x: number; y: number; z: number; big: boolean }[] {
    return [...this.zs.values()].filter((z) => !z.downAt).map((z) => ({ x: z.x, y: z.y, z: z.z, big: z.kind === BIG }));
  }

  /** The nearest one up to (x, z) (where a swipe came from), or null. */
  nearest(x: number, z: number): { x: number; z: number } | null {
    let best: Z | null = null;
    let d = Infinity;
    for (const q of this.zs.values()) {
      const e = Math.hypot(q.x - x, q.z - z);
      if (!q.downAt && e < d) [best, d] = [q, e];
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  /** Each one as drawn now (for the checks in the dev build). */
  states(): { id: number; kind: number; x: number; y: number; z: number; act: ZombieAct; hp: number; clip: string; lod: number; down: boolean }[] {
    return [...this.zs.values()].map((z) => ({ id: z.id, kind: z.kind, x: z.x, y: z.y, z: z.z, act: z.act, hp: z.hp, clip: z.clip, lod: z.lod, down: !!z.downAt }));
  }

  /** Whether `id` is a big one (for the kill feed's name). */
  isBig(id: number): boolean {
    return this.zs.get(id)?.kind === BIG;
  }

  /**
   * Paintball: a paintball hit zombie `id` along `ray`: its paint sticks where the ray meets the posed
   * body (the nearest point of it, if the ray only grazed the hit box), as a spot on the rest pose.
   */
  paint(id: number, ray: THREE.Ray, color: THREE.Color, size: number): void {
    const z = this.zs.get(id);
    const k = z && this.kinds[z.kind];
    if (!z || !k || z.downAt) return;
    const rig = k.rigs[0];
    const n = k.rest.count;
    // The posed body at this frame, in the world.
    const world = new THREE.Matrix4().compose(_v.set(z.x, z.y, z.z), _q.setFromAxisAngle(UP, z.yaw), _s.set(1, 1, 1));
    const posed = new Float32Array(n * 3);
    const bones = rig.bones.length;
    const first = this.firstRow(rig);
    const ra = z.rowA - first;
    const rb = z.rowB - first;
    for (let i = 0; i < n; i++) {
      _w.fromBufferAttribute(k.rest, i);
      let x = 0, y = 0, zz = 0;
      for (let c = 0; c < 4; c++) {
        const w = k.skinWeight.getComponent(i, c);
        if (w <= 0) continue;
        const b = k.skinIndex.getComponent(i, c);
        for (const [r, f] of [[ra, 1 - z.mix], [rb, z.mix]] as const) {
          if (f <= 0) continue;
          const o = (r * bones + b) * 12;
          const s = rig.skin;
          x += w * f * (s[o] * _w.x + s[o + 1] * _w.y + s[o + 2] * _w.z + s[o + 3]);
          y += w * f * (s[o + 4] * _w.x + s[o + 5] * _w.y + s[o + 6] * _w.z + s[o + 7]);
          zz += w * f * (s[o + 8] * _w.x + s[o + 9] * _w.y + s[o + 10] * _w.z + s[o + 11]);
        }
      }
      _v.set(x, y, zz).applyMatrix4(world);
      posed[i * 3] = _v.x;
      posed[i * 3 + 1] = _v.y;
      posed[i * 3 + 2] = _v.z;
    }
    // The first triangle along the ray; else the vertex nearest to it.
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best = Infinity;
    let at: [number, number, number, number, number] | null = null; // triangle's corners and the hit's barycentric u, v
    const tri = new THREE.Triangle();
    const bary = new THREE.Vector3();
    const idx = k.index;
    for (let t = 0; t < idx.length; t += 3) {
      a.fromArray(posed, idx[t] * 3);
      b.fromArray(posed, idx[t + 1] * 3);
      c.fromArray(posed, idx[t + 2] * 3);
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
      const d = hit.distanceToSquared(ray.origin);
      if (d >= best) continue;
      best = d;
      tri.set(a, b, c).getBarycoord(hit, bary);
      at = [idx[t], idx[t + 1], idx[t + 2], bary.y, bary.z];
    }
    const rest = new THREE.Vector3();
    if (at) {
      const [i0, i1, i2, u, v] = at;
      rest.fromBufferAttribute(k.rest, i0).multiplyScalar(1 - u - v)
        .addScaledVector(_w.fromBufferAttribute(k.rest, i1), u)
        .addScaledVector(_w.fromBufferAttribute(k.rest, i2), v);
    } else {
      let near = 0;
      let nd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = ray.distanceSqToPoint(a.fromArray(posed, i * 3));
        if (d < nd) [nd, near] = [d, i];
      }
      rest.fromBufferAttribute(k.rest, near);
    }
    if (z.slot < 0) {
      const slot = this.freeSlots.pop();
      if (slot === undefined) return;
      z.slot = slot;
    }
    z.spots.push({ x: rest.x, y: rest.y, z: rest.z, r: Math.min(0.1, size * 0.16) * (z.kind === BIG ? 1.4 : 1), color: color.clone() });
    if (z.spots.length > SPOTS) z.spots.shift();
    this.writeSpots(z);
  }

  private firstRow(rig: Rig): number {
    let first = Infinity;
    for (const c of rig.clips.values()) first = Math.min(first, c.row);
    return first === Infinity ? 0 : first;
  }

  private writeSpots(z: Z): void {
    const h = THREE.DataUtils.toHalfFloat;
    const base = z.slot * SPOTS * 2 * 4;
    z.spots.forEach((s, i) => {
      const o = base + i * 8;
      const c = s.color.clone().convertSRGBToLinear();
      this.paintData.set([h(s.x), h(s.y), h(s.z), h(s.r), h(c.r), h(c.g), h(c.b), h(1)], o);
    });
    this.paintTex.needsUpdate = true;
  }

  /** One zombie's sounds this frame (see HEAR): a groan or puff when its time comes, a footfall every stride close by. */
  private voice(z: Z, eye: THREE.Vector3, dt: number): void {
    const d = Math.hypot(z.x - eye.x, z.y + 1 - eye.y, z.z - eye.z);
    const near = nearness(d);
    this.voices = this.voices.filter((end) => end > this.clock);
    const free = () => this.voices.length < VOICES;
    if ((z.groanIn -= dt) <= 0) {
      z.groanIn = groanGap(d, z.kind);
      if (d < HEAR && this.groans < GROANS && free()) {
        this.groans++;
        const sprinting = z.kind === RUNNER && z.speed > RUN_FROM;
        if (sprinting) this.heard.huff++;
        else if (d < 10) this.heard.groanNear++;
        else this.heard.groanFar++;
        this.voices.push(this.clock + (sprinting ? huff(_v.set(z.x, z.y, z.z), near) : groan(_v.set(z.x, z.y, z.z), z.kind, near)));
      } else if (d < HEAR) this.heard.skipped++;
    }
    if (z.speed > 0.3 && d < STEPS_NEAR) {
      z.stepIn -= z.speed * dt;
      if (z.stepIn <= 0) {
        z.stepIn = z.kind === BIG ? 0.75 : z.kind === RUNNER ? 1.05 : 0.6;
        if (free()) {
          this.heard.step++;
          this.voices.push(this.clock + step(_v.set(z.x, z.y, z.z), z.kind === BIG));
        }
      }
    }
  }

  /** Which clip a zombie plays for what it does and how fast it goes. */
  private clipFor(z: Z): string {
    const big = z.kind === BIG;
    if (z.downAt) return 'Fall';
    if (z.act === 'attack') return big ? 'Pound' : 'Attack';
    if (z.act === 'hurt') return 'Flinch';
    if (z.speed > 0.15) {
      if (big) return 'Stomp';
      // A runner sprints (the hoodie's own run, when the file has it).
      if (z.kind === RUNNER && z.speed > RUN_FROM && this.kinds[z.kind]?.rigs[0].clips.has('Run')) return 'Run';
      return z.speed > LURCH_FROM ? 'Lurch' : 'Walk';
    }
    return 'Idle';
  }

  /** The row of `clip` at time `t` (s; loops wrap), and the next row with how far between them. */
  private rows(rig: Rig, clip: string, t: number): [number, number, number] {
    const c = rig.clips.get(clip) ?? rig.clips.get('Idle') ?? rig.clips.values().next().value;
    if (!c) return [0, 0, 0];
    const f = c.loop ? (((t / c.duration) % 1) + 1) % 1 * c.frames : Math.min(c.frames - 1, Math.max(0, t * FPS));
    const i = Math.floor(f);
    const next = c.loop ? (i + 1) % c.frames : Math.min(c.frames - 1, i + 1);
    return [c.row + (i % c.frames), c.row + next, f - i];
  }

  /**
   * Every frame: each zombie where its states put it, its clip on, and the instanced meshes filled
   * (near ones with the full model, far ones with the simpler one). `eye`: the camera.
   */
  update(dt: number, eye: THREE.Vector3): void {
    this.clock += dt;
    this.groanClock += dt;
    if (this.groanClock > 1) {
      this.groanClock = 0;
      this.groans = 0;
    }
    if (!this.boneTex) return;
    const counts = this.kinds.map(() => [0, 0]);
    let patches = 0;
    const now = performance.now();
    for (const z of [...this.zs.values()]) {
      // A zombie the server stopped sending (a lost 'zgone'): gone after a few seconds.
      if (z.track && now - z.seen > 4000) {
        this.remove(z.id);
        continue;
      }
      const k = this.kinds[z.kind];
      if (!k) continue;
      if (z.track?.at(netClock.time, this.pose)) {
        [z.x, z.z, z.yaw] = this.pose;
        if (Number.isFinite(z.floor)) z.floor = this.pose[3];
      }
      // How fast it goes, from where it was drawn last frame (the server's ticks, or the horde alone, moved it since).
      const jump = Math.hypot(z.x - z.lx, z.z - z.lz);
      const moved = jump > 3 ? 0 : jump / Math.max(dt, 1e-3);
      z.lx = z.x;
      z.lz = z.z;
      z.speed += (Math.min(moved, 4) - z.speed) * (1 - Math.exp(-dt * 8));
      // Its feet: the highest ground at most a step over the floor it walks on (so the ground floor
      // under the first, a stair's step on the stairs), looked up again every 12 cm or a change of
      // floor; it eases up and down to it, and goes there at once when new or far off (a spawn).
      const hint = Number.isFinite(z.floor) ? z.floor : z.y;
      if (Math.hypot(z.x - z.groundAt[0], z.z - z.groundAt[1]) > 0.12 || Number.isNaN(z.groundAt[0]) || Math.abs(hint - z.floorAt) > 0.15) {
        z.ground = this.floorAt(z.x, z.z, hint + (Number.isFinite(z.floor) ? 0.45 : 0.6));
        z.groundAt = [z.x, z.z];
        z.floorAt = hint;
      }
      z.y = Math.abs(z.ground - z.y) > 1.5 ? z.ground : z.y + (z.ground - z.y) * (1 - Math.exp(-dt * 14));
      // The clip: a change blends in over BLEND; walking ones step with the ground covered.
      const want = this.clipFor(z);
      if (want !== z.clip) {
        z.from = z.clip;
        z.fromTime = z.time;
        z.blend = 0;
        z.clip = want;
        z.time = want === 'Attack' || want === 'Pound' || want === 'Flinch' || want === 'Fall' ? this.clock - (want === 'Fall' ? z.downAt : z.actAt) : z.time;
      }
      const rig = k.rigs[0];
      const c = rig.clips.get(z.clip);
      const stride = c?.stride ?? 0;
      if (stride && c) z.time += (z.speed * dt / stride) * c.duration;
      else if (c && !c.loop) z.time = this.clock - (z.clip === 'Fall' ? z.downAt : z.actAt);
      else z.time += dt;
      z.blend = Math.min(1, z.blend + dt / BLEND);
      z.flash = Math.max(0, z.flash - dt * 5);
      // Fading: a fallen one after two seconds; in paintball at once, in a puff.
      const since = z.downAt ? this.clock - z.downAt : -1;
      z.fade = since < 0 ? 1 : paintball.on ? Math.max(0, 1 - since / PUFF_S) : Math.max(0, 1 - Math.max(0, since - 2) / FALL_FADE);
      // Its sounds: groans (a runner's puffs) the more often the nearer, its feet close by.
      if (!z.downAt) this.voice(z, eye, dt);
      if (z.fade <= 0) {
        z.body.visible = z.head.visible = false;
        continue;
      }
      const far = Math.hypot(z.x - eye.x, z.y - eye.y, z.z - eye.z);
      z.lod = far > LOD_FAR ? 1 : 0;
      // The two rows and their blend, for a model's rig: two frames of the clip, or (changing clips) the old clip's and the new one's.
      const pick = (rig: Rig): [number, number, number] => {
        const [a0, a1, af] = this.rows(rig, z.clip, z.time);
        if (z.blend >= 1 || !z.from) return [a0, a1, af];
        return [this.rows(rig, z.from, z.fromTime)[0], a0, z.blend];
      };
      [z.rowA, z.rowB, z.mix] = pick(k.rigs[0]);
      const [dA, dB, dMix] = z.lod === 0 || k.rigs[1] === k.rigs[0] ? [z.rowA, z.rowB, z.mix] : pick(k.rigs[1]);
      // Into its kind's instanced mesh.
      const mesh = k.meshes[z.lod];
      const i = counts[z.kind][z.lod]++;
      if (i >= MAX) continue;
      _m.compose(_v.set(z.x, z.y, z.z), _q.setFromAxisAngle(UP, z.yaw), _s.set(1, 1, 1));
      mesh.setMatrixAt(i, _m);
      const anim = mesh.geometry.attributes.aAnim as THREE.InstancedBufferAttribute;
      anim.setXYZW(i, dA, dB, dMix, 0);
      const look = mesh.geometry.attributes.aLook as THREE.InstancedBufferAttribute;
      look.setXYZW(i, z.flash, z.fade, z.slot >= 0 ? z.spots.length : 0, Math.max(0, z.slot));
      // The hit boxes: the body upright where it stands, the head on its head bone (near model's rig at this frame).
      z.body.visible = z.head.visible = !z.downAt; // a fallen one takes no more shots
      if (!z.downAt) this.placeHits(z, k, _m);
      // Its patch on the ground, near enough to see; wider for the big one, fading with it.
      if (far < 60 && patches < MAX * 2) {
        const r = (z.kind === BIG ? 1.9 : 0.95) * (z.downAt ? 1.25 : 1) * Math.min(1, z.fade * 1.4);
        _n.makeScale(r, 1, r).setPosition(z.x, z.y + 0.03, z.z);
        this.patches.setMatrixAt(patches++, _n);
      }
    }
    this.patches.count = Math.min(MAX * 2, patches);
    this.patches.instanceMatrix.needsUpdate = true;
    this.kinds.forEach((k, kind) => {
      k.meshes.forEach((mesh, lod) => {
        mesh.count = Math.min(MAX, counts[kind][lod]);
        mesh.visible = mesh.count > 0;
        if (!mesh.count) return;
        mesh.instanceMatrix.needsUpdate = true;
        (mesh.geometry.attributes.aAnim as THREE.InstancedBufferAttribute).needsUpdate = true;
        (mesh.geometry.attributes.aLook as THREE.InstancedBufferAttribute).needsUpdate = true;
        mesh.computeBoundingSphere();
      });
    });
  }

  /** The head box on the head bone at this frame; the body box under the chest. */
  private placeHits(z: Z, k: Kind, world: THREE.Matrix4): void {
    const rig = k.rigs[0];
    const first = this.firstRow(rig);
    const bones = rig.bones.length;
    const bone = (b: number, out: THREE.Vector3, lift: number) => {
      if (b < 0) return out.set(0, k.height * (lift > 0 ? 0.9 : 0.55), 0).applyMatrix4(world);
      const o = (z.rowA - first) * bones * 16 + b * 16;
      const p = rig.place;
      if (o < 0 || o + 15 >= p.length) return out.set(0, k.height * 0.9, 0).applyMatrix4(world);
      // The bone's point, a little along it (a head's middle is above its root).
      return out.set(p[o + 12] + p[o + 4] * lift, p[o + 13] + p[o + 5] * lift, p[o + 14] + p[o + 6] * lift).applyMatrix4(world);
    };
    bone(rig.head, z.head.position, z.kind === BIG ? 0.2 : 0.12);
    bone(rig.chest, _w, 0);
    z.body.position.set(_w.x, z.y, _w.z);
    z.body.rotation.y = z.yaw;
    z.head.updateMatrixWorld();
    z.body.updateMatrixWorld();
  }
}
