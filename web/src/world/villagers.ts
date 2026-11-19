import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mood } from './mood';
import type { World } from './collision';
import type { Obstacle } from './traffic';
import { sound } from '../sound';
import { noShoot } from '../../shared/zones.mjs';
import { buildVillagers, dice, rebuildHub, villagerPose, VILLAGER_DOWN_S, type VillagerDef, type VillagerPaths, type VillagerPose, type VillagerSet } from '../../shared/villagers.mjs';

/**
 * Villagers: people walking and cycling round the village, in every mode (Yoshi, 7 Nov 2026: Action and
 * Paintball too), but gone during Zombies. Sculpted public domain bodies, rigged, dressed for November and
 * animated by tools/villagers.py (web/public/models/villagers.glb): a man, a woman, an older person with a stick,
 * a teen, a child, a cyclist on a city bike and a dog, invented and generic, each villager in colours of its own
 * (jacket, trousers, shoes, skin, hair, a beard, a bag, a knitted hat, glasses, a scarf, an umbrella in the rain).
 * Each walks at its own pace (a walk or a stroll, some with their hands in their pockets) with its feet planted,
 * stands about in three ways in turn, and two friends take turns talking.
 *
 * The same villagers for everyone (Yoshi, 14 Nov 2026): who there is and where each one is now follows from
 * a clock shared with the server (shared/villagers.mjs), as the cats do it, so every player sees the same
 * villager in the same place and nothing of their walking goes over the network. Each walks up and down a
 * way of its own along the pavements and the edges of the country roads, across a street at a crossing (the
 * traffic stops for one on the road), cyclists one way on the right. More of them round the church square,
 * the school and the Sparrenhof, fewer in the fields. Friends stand and chat, some sit on the benches, a
 * parent walks with a child or a dog on a lead, a jogger runs by. Fewer at night, and in heavy rain only a
 * few, under umbrellas (world/mood.ts).
 *
 * What a page adds of its own, for show: close to the player a villager steps aside or stops, looks at you,
 * and now and then waves, then catches up with where the clock has it; it steps out of the way of a car
 * coming at it; walls keep it out (world/collision.ts). Cars and the player still pass through them.
 *
 * In Action a grown-up or a teen can be shot (Yoshi, 14 Nov 2026): a short cry, a puff of dust, it tips over
 * and fades away, cartoon style and no blood, and it is back after a while. In Paintball the paint sticks to
 * its clothes and it jumps. Never a child, a dog or someone walking with a child, and never on the school
 * grounds (shared/zones.mjs). Their meshes take no rays: `rayHit` finds the one a shot meets, and in
 * multiplayer the server decides (server/game.mjs).
 *
 * Cheap to draw, as world/zombies.ts does it: every clip of every kind is sampled into one picture of bone
 * matrices (half floats), and each kind is one instanced mesh skinned in its vertex shader, with a second one of
 * far fewer triangles for those further off, so seven kinds are at most fourteen draws however many walk about,
 * and a round patch on the ground under each is one more. Their colours
 * come from a small picture too (16 colours a villager). Only within reach of the player (fewer and nearer
 * on Low and on phones), and the model and the paths load the first time they are needed.
 */
const URL_GLB = '/models/villagers.glb';
const KINDS = ['man', 'woman', 'elder', 'teen', 'child', 'cyclist', 'dog'] as const;
const MAN = 0, WOMAN = 1, ELDER = 2, TEEN = 3, CHILD = 4, BIKE = 5, DOG = 6;
const MAX = [16, 16, 10, 10, 12, 12, 8];
/** Room for the figures someone else moves (`setExtras`: world/footballLife.ts, the training and the spectators), on top of MAX */
const EXTRA = [10, 10, 2, 6, 16, 0, 0];
const ALL = MAX.map((n, k) => n + EXTRA[k]);
/** The kinds' numbers, for `setExtras` and `dressRow`. */
export const VILLAGER_KIND = { man: 0, woman: 1, elder: 2, teen: 3, child: 4, cyclist: 5, dog: 6 } as const;
/** Bits of a figure's extras (`flags`): its umbrella up, a cap. */
export const VILLAGER_UMBRELLA = 1;
export const VILLAGER_CAP = 4;

/**
 * A figure someone else moves: drawn with the villagers (the same instanced meshes), but not one of them: where it
 * stands, which way it faces, its clip and how far into it (s), its palette row (`dressRow`) and how far faded in.
 */
export interface Extra {
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  clip: string;
  time: number;
  pal: number;
  fade: number;
  flags: number;
}
/** How tall each kind stands (m, tools/villagers.py), for what they hold (eachHand) */
const TALL = [1.79, 1.67, 1.66, 1.71, 1.18, 1.75, 0.6];
const PALETTE_ROWS = 128;
const BLEND = 0.25; // s to change from one clip to the next
/** The ways of standing about (tools/villagers.py idles), each a loop of IDLE_S seconds; the talk loop is as long. */
const IDLES = ['Idle', 'Idle2', 'Idle3'];
const IDLE_S = 8;
/** Beyond this far (m) a villager is drawn with far fewer triangles: [desktop, phone or Low]. */
const FAR_M = [26, 18];
const FADE = 0.9; // s to fade in or out
/** How far off they are drawn: [desktop, phone or Low]; and the share of them a phone or Low shows. */
const REACH = [105, 65];
const CHEAP_SHARE = 0.6;
/** A villager that is hit: how long it takes to tip over (s), and how long it lies before it fades away. */
const FALL = 0.45;
const LIE = 1.7;

const UMB = 1, BAG = 2, HAT = 4, SCARF = 8, SPECS = 16, HAIR_A = 32, HAIR_B = 64, BEARD = 128;

type Mode = 'walk' | 'cross' | 'stand' | 'sit' | 'ride' | 'follow' | 'hub' | 'down';
interface Clip {
  row: number;
  frames: number;
  duration: number;
  /** Metres a loop covers (walks, the ride), else 0 */
  dist: number;
}

interface Kind {
  mesh: THREE.InstancedMesh;
  clips: Map<string, Clip>;
  anim: THREE.InstancedBufferAttribute;
  look: THREE.InstancedBufferAttribute;
}
/** A villager near enough to draw: what this page shows of it. */
interface V {
  id: number;
  def: VillagerDef;
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  ground: number;
  gx: number;
  gz: number;
  /** When its ground was last looked up (this page's villager clock, s): a still one looks again now and then */
  groundAt: number;
  speed: number;
  /** As the shared clock has it now: sitting, standing with its friend, on a carriageway */
  sit: boolean;
  talk: boolean;
  road: boolean;
  /** Put where the clock has it (false: at once, without walking there) */
  placed: boolean;
  /** How long it has stood still (s) */
  still: number;
  /** Walks with its hands in its pockets */
  pk: boolean;
  /** Its clip, time, the clip it changes from and how far */
  clip: string;
  time: number;
  from: string;
  fromTime: number;
  blend: number;
  /** A clip it plays once (a wave), and when that ends */
  once: string;
  onceEnd: number;
  fade: number;
  pal: number;
  flags: number;
  waved: number;
  /** Standing still for a moment (a wave, a fright), until when */
  holdUntil: number;
  /** How far to the right of its way it steps round the player */
  avoid: number;
  /** Stepping out of a car's way: until when, and which way */
  dodgeUntil: number;
  dodgeX: number;
  dodgeZ: number;
  /** Hit: when it started to fall (-1 not), which way it tips, and away until it is back */
  downAt: number;
  fallX: number;
  fallZ: number;
  away: boolean;
  /** A little jump (paint, a fright): when it started */
  hopAt: number;
  /** Paint on its clothes: the colour its top had before */
  topWas: [number, number, number] | null;
  drawn: boolean;
  dist: number;
}

// ---- Colours (sRGB; the picture holds them linear). Slots as in tools/villagers.py.
const SKINS = ['#ebc5a8', '#e2b696', '#e2b08d', '#d29e7b', '#c08463', '#a46c4c', '#87553a', '#64402b', '#4b2f20'];
const SKIN_W = [3, 4, 4, 3, 2, 2, 1.5, 1, 1];
const HAIRS = ['#1f1a17', '#33261d', '#4b3424', '#6b4a2e', '#8f6a40', '#b8935c', '#d3b67c', '#8c3f22', '#2b2b2b'];
const GREYS = ['#d9d6d0', '#bdbab4', '#a19d97', '#ece8e0', '#8a8680'];
// What people wear here in November: mostly dark and muted jackets and coats (navy, black, charcoal, olive, camel,
// brown, burgundy, bottle green), now and then a brighter one; jeans, chinos and dark trousers; dark shoes, boots,
// white trainers; knitted hats and scarves in wool colours. Two people side by side should differ at a glance: the
// darkest colours are a little lifted (pure black crushes to a flat shape in the sun), there is beige, grey, camel,
// a red, rust or mustard jacket now and then, lighter jeans and chinos, and top and trousers seldom both dark (dress1).
const TOPS = ['#26324a', '#26262a', '#383a40', '#4a4d52', '#4b5235', '#6d6450', '#a07c52', '#4a3428', '#6a2630', '#2a4a36', '#24505c', '#33507a',
  '#9a2e2a', '#b08a2e', '#c8bba3', '#ddd5c4', '#5d6b7a', '#30333a', '#9da2a8', '#a4532f'];
const TOP_W = [3, 2, 2, 3, 3, 2, 3, 2, 2, 2, 2, 3, 2, 2, 3, 2, 2, 1, 2, 1];
const BOTTOMS = ['#28324a', '#3b4d6b', '#5e7493', '#25262a', '#3a3b3f', '#8a7f66', '#a89a7c', '#4d3b30', '#5f6165', '#4d4f3a'];
const BOTTOM_W = [3, 5, 4, 3, 3, 3, 2, 1, 3, 1];
/** Too dark to stand apart from another dark colour at a distance (sRGB luminance under 70 of 255). */
const dark = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 70;
};
const SHOES = ['#1c1b1a', '#3b2a20', '#5a3f2b', '#e6e3dd', '#6b6e74', '#252c3a', '#8a6440'];
const SHOE_W = [5, 3, 2, 4, 1, 1, 1];
const ACCS = ['#5b5e63', '#26304a', '#5e2430', '#b58b32', '#222224', '#d8cfbd', '#2f4a36', '#9b2c2c', '#5a3a26'];
const ACC2S = ['#8c2f2f', '#2b3d6b', '#c9a14a', '#3a3a3a', '#6b4a7a', '#d8d2c4', '#2e6b5c', '#b5562f', '#7d7f84'];
const FRAMES = ['#2f5f8a', '#8a2f2f', '#2e2e30', '#e0ddd5', '#3d6b45', '#6b6f75', '#c26a2a', '#1f3f6a'];
const COATS = ['#2a2420', '#6b4a2a', '#c9a66b', '#e8dcc4', '#8a5a32', '#3a3a3c', '#b07a40', '#d8c8a8'];
const PATCHES = ['#e8dcc4', '#f1ece2', '#c9a66b', '#2a2420', '#8a6a4a'];
const COLLARS = ['#b02a2a', '#1f3f8a', '#2b6b3a', '#e3b21f', '#7a3b8a'];

/** The dice the picks below throw: the villager's own while it is dressed (the same clothes on every page), else any. */
let rnd: () => number = Math.random;
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
function pickW<T>(list: readonly T[], w: readonly number[]): T {
  let t = rnd() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) if ((t -= w[i]) <= 0) return list[i];
  return list[list.length - 1];
}
const chance = (p: number) => rnd() < p;

/**
 * A colour into the palette picture as sRGB bytes (the picture is read as sRGB). `Color.set` gives it linear, as
 * three.js works; the bytes go back to sRGB once. Before, they were made linear a second time: nearly all cloth black.
 */
const _pc = new THREE.Color();
const _rgb = { r: 0, g: 0, b: 0 };
function putSRGB(out: Uint8Array, o: number, color: THREE.ColorRepresentation): void {
  _pc.set(color).getRGB(_rgb, THREE.SRGBColorSpace);
  out[o] = Math.round(_rgb.r * 255);
  out[o + 1] = Math.round(_rgb.g * 255);
  out[o + 2] = Math.round(_rgb.b * 255);
}

/** A short cry made in code, cartoon style: a voice that jumps up and falls off ("oh!"). `soft`: a fright, not a fall. */
function cry(x: number, y: number, z: number, kind: number, soft: boolean): void {
  const ctx = sound.context();
  const dest = sound.at(x, y + 1.4, z, 3);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const len = soft ? 0.22 : 0.42;
  const base = (kind === WOMAN ? 330 : kind === TEEN ? 290 : kind === ELDER ? 170 : 200) * (0.92 + Math.random() * 0.16);
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(base * 1.1, t);
  o.frequency.exponentialRampToValueAtTime(base * (soft ? 1.7 : 1.5), t + len * 0.25);
  o.frequency.exponentialRampToValueAtTime(base * (soft ? 1.3 : 0.75), t + len);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 2.5;
  f.frequency.setValueAtTime(700, t);
  f.frequency.linearRampToValueAtTime(soft ? 1100 : 500, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(soft ? 0.3 : 0.45, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(f).connect(g).connect(dest);
  o.start(t);
  o.stop(t + len + 0.05);
}

/** The skinning added to the standard material: each villager's frames from the bone picture, its colours from the palette, its extras shown or not. */
const VERT_PARS = /* glsl */ `
#ifndef USE_SKINNING
attribute vec4 skinIndex;
attribute vec4 skinWeight;
#endif
attribute vec4 aAnim;
attribute vec4 aLook;
uniform highp sampler2D uBones;
uniform int uWrap;
uniform int uRowW;
flat varying float vSlot;
flat varying float vRow;
varying float vShade;
varying float vFade;
mat4 vBone(float bone, float row) {
  // A frame's bones are uWrap frames to a line of the picture (so it stays under 2048 lines high).
  int r = int(row + 0.5);
  ivec2 at = ivec2(int(bone) * 3 + (r % uWrap) * uRowW, r / uWrap);
  vec4 a = texelFetch(uBones, at, 0);
  vec4 b = texelFetch(uBones, at + ivec2(1, 0), 0);
  vec4 c = texelFetch(uBones, at + ivec2(2, 0), 0);
  return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
}
mat4 vSkinAt(float row) {
  return vBone(skinIndex.x, row) * skinWeight.x + vBone(skinIndex.y, row) * skinWeight.y
    + vBone(skinIndex.z, row) * skinWeight.z + vBone(skinIndex.w, row) * skinWeight.w;
}
`;
const VERT_SKIN = /* glsl */ `
mat4 vSkin = vSkinAt(aAnim.x) * (1.0 - aAnim.z) + vSkinAt(aAnim.y) * aAnim.z;
objectNormal = normalize(mat3(vSkin) * objectNormal);
float vGroup = floor(uv.x / 16.0);
bool vHidden = vGroup > 0.5 && ((int(aLook.y + 0.5) >> (int(vGroup) - 1)) & 1) == 0;
vSlot = mod(floor(uv.x), 16.0);
vRow = aAnim.w;
// A little form for free (per point, not per pixel): what faces down (under the arms, between the legs, under a hem
// or a chin) a shade darker, so a dark coat is not a flat cut-out.
vShade = uv.y * (0.8 + 0.2 * smoothstep(-0.7, 0.3, objectNormal.y));
vFade = aLook.x;
`;

function villagerMaterial(bones: THREE.Texture, palette: THREE.Texture, wrap: number, rowW: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = { value: bones };
    shader.uniforms.uWrap = { value: wrap };
    shader.uniforms.uRowW = { value: rowW };
    shader.uniforms.uPal = { value: palette };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_SKIN}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = vHidden ? vec3(0.0) : (vSkin * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform highp sampler2D uPal;
flat varying float vSlot;
flat varying float vRow;
varying float vShade;
varying float vFade;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
// Fading in or out: a dither, so no sorting is needed.
if (vFade < 0.999) {
  float n = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
  if (n > vFade) discard;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = texelFetch(uPal, ivec2(int(vSlot + 0.5), int(vRow + 0.5)), 0).rgb * vShade;`);
  };
  m.customProgramCacheKey = () => 'villager-skin';
  return m;
}

/** A soft dark round patch under each, one draw for all (as world/zombies.ts). */
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
  const mat = new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: new THREE.CanvasTexture(c), transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, n);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.userData.ignoreRay = true;
  mesh.userData.noAO = true;
  mesh.raycast = () => {};
  return mesh;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _p: VillagerPose = { x: 0, z: 0, yaw: 0, hx: 0, hz: 1, speed: 0, here: true, road: false, sit: false, talk: false };
const UP = new THREE.Vector3(0, 1, 0);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A car near the villagers: where, which way it faces (forward is (-sin yaw, -cos yaw)), its size. */
export interface CarNear {
  x: number;
  z: number;
  yaw: number;
  length: number;
  width: number;
}

export interface Me {
  x: number;
  z: number;
  feet: number;
}

/** A villager's number is under this before the list is in (it has about 300): what is heard earlier is kept, bounded. */
const MOST = 4096;

export class Villagers {
  readonly group = new THREE.Group();
  /** Resolves when the model and the paths are in (false if they couldn't be loaded); started by the first setActive(true). */
  ready: Promise<boolean> | null = null;
  private data: VillagerPaths | null = null;
  private set: VillagerSet | null = null;
  private kinds: Kind[] = [];
  /** Each kind with far fewer triangles (tools/villagers.py far_mesh), for those beyond FAR_M; null for none. */
  private fars: (Kind | null)[] = [];
  private boneTex: THREE.DataTexture | null = null;
  private palData = new Uint8Array(16 * PALETTE_ROWS * 4);
  private palTex: THREE.DataTexture;
  private palFree: number[] = [];
  private patches = shadowPatches(96);
  private leashes: THREE.LineSegments;
  /** Those near enough to draw, by number; `order` the same, nearest first */
  private active = new Map<number, V>();
  private order: V[] = [];
  /** Who is down, and until when (s on the shared clock); whose clothes have paint on them */
  private downs = new Map<number, number>();
  private paints = new Map<number, { until: number; color: string }>();
  /** The shared clock minus this page's (s) */
  private offset = Date.now() / 1000 - performance.now() / 1000;
  private clock = 0;
  private scanAt = 0;
  private lastT = 0;
  private want = false;
  /** 0 hidden .. 1 shown: all of them together, as a Zombies game comes and goes */
  private shown = 0;
  private hubLen: number[] = [];
  private hubDone: boolean[] = [];
  private hubTried: number[] = [];
  private extras: (() => readonly Extra[]) | null = null;
  private prevCars: { x: number; z: number }[] = [];
  private carSpeed: number[] = [];

  /**
   * `cheap`: Low or a phone (fewer, nearer). `compile`: builds a group's shaders ahead (src/main.ts precompile), so the
   * first villagers to appear don't stop the game for a moment.
   */
  constructor(private world: World, private cheap: () => boolean = () => false, private compile?: (root: THREE.Object3D) => Promise<unknown>) {
    this.group.name = 'villagers';
    this.group.visible = false;
    this.group.add(this.patches);
    this.palTex = new THREE.DataTexture(this.palData, 16, PALETTE_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.palTex.minFilter = this.palTex.magFilter = THREE.NearestFilter;
    this.palTex.generateMipmaps = false;
    // It holds sRGB bytes and the chip makes them linear as it reads them: dark cloth keeps its shades (in linear
    // bytes a navy and a black both fell to 0 to 3 of 255).
    this.palTex.colorSpace = THREE.SRGBColorSpace;
    this.palTex.needsUpdate = true;
    for (let i = PALETTE_ROWS - 1; i >= 0; i--) this.palFree.push(i);
    // The dogs' leads: three segments each, sagging a little, one draw for all.
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX[DOG] * 6 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    this.leashes = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#3a2a22' }));
    this.leashes.frustumCulled = false;
    this.leashes.userData.ignoreRay = true;
    this.leashes.raycast = () => {};
    this.group.add(this.leashes);
  }

  /** Out (true) or not: they fade in or out. The first `true` loads the model and the paths. */
  setActive(on: boolean): void {
    this.want = on;
    if (on && !this.ready) this.ready = this.load();
  }

  /** The model and the paths loaded, the figures built and their shaders compiled, without bringing them out (before play: main.ts). */
  preload(): Promise<boolean> {
    return (this.ready ??= this.load());
  }

  /** How many are about, for the diagnostics. */
  get count(): number {
    return this.active.size;
  }

  /** The shared clock now (s). */
  private get now(): number {
    return performance.now() / 1000 + this.offset;
  }

  /** Line up with the server's clock (ms since 1970), so all players see the villagers in the same place. */
  setClock(serverMs: number): void {
    this.offset = serverMs / 1000 - performance.now() / 1000;
  }

  private async load(): Promise<boolean> {
    try {
      // A frame between the steps: the model unpacked, the paths, the figures and the shaders in one go
      // stopped the game for 80 ms.
      const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const [gltf, data] = await Promise.all([new GLTFLoader().loadAsync(URL_GLB), import('../data/villagers.json')]);
      await frame();
      this.data = (data.default ?? data) as unknown as VillagerPaths;
      this.set = buildVillagers(this.data);
      // Who was down or painted before the villagers were in (the server's welcome comes first): only real numbers stay.
      for (const id of [...this.downs.keys()]) if (id >= this.set.list.length) this.downs.delete(id);
      for (const id of [...this.paints.keys()]) if (id >= this.set.list.length) this.paints.delete(id);
      await frame();
      this.build(gltf);
      this.hubLen = this.set.hubs.map(() => -1);
      this.hubDone = this.set.hubs.map(() => false);
      this.hubTried = this.set.hubs.map(() => -1e9);
      // Out of sight until their shaders are built: a frame is drawn before that now, and drawing them in it
      // (even none of them) made the game wait for the shader after all.
      const lods = [...this.kinds, ...this.fars.filter((k): k is Kind => !!k)];
      if (this.compile) for (const k of lods) k.mesh.visible = false;
      await frame();
      if (this.compile) {
        // Shown for the moment the shaders are gathered (nothing is drawn), then as they were.
        const was = this.group.visible;
        this.group.visible = true;
        for (const k of lods) k.mesh.visible = true;
        const done = this.compile(this.group);
        this.group.visible = was;
        for (const k of lods) k.mesh.visible = false;
        await done;
      }
      return true;
    } catch (e) {
      console.warn('villagers: not loaded', e);
      return false;
    }
  }
  /** Every kind's clips sampled into the bone picture, and an instanced mesh per kind. */
  private build(gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] }): void {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const mixer = new THREE.AnimationMixer(scene);
    const rest: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) rest.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
    });
    const toRest = () => rest.forEach((r) => {
      r.o.position.copy(r.p);
      r.o.quaternion.copy(r.q);
      r.o.scale.copy(r.s);
    });
    const rows: Float32Array[] = [];
    let width = 0;
    const found: { mesh: THREE.SkinnedMesh; far: THREE.SkinnedMesh | null; clips: Map<string, Clip> }[] = [];
    for (const name of KINDS) {
      const root = scene.getObjectByName(`vil_${name}`);
      let mesh: THREE.SkinnedMesh | null = null;
      let far: THREE.SkinnedMesh | null = null;
      root?.traverse((o) => {
        if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
        if (o.name.endsWith('_far')) far = o as THREE.SkinnedMesh;
        else if (!mesh) mesh = o as THREE.SkinnedMesh;
      });
      if (!mesh) throw new Error(`villagers.glb: no vil_${name}`);
      const sk = mesh as THREE.SkinnedMesh;
      let dist: Record<string, number> = {};
      root?.traverse((o) => {
        if (typeof o.userData.clips === 'string') dist = JSON.parse(o.userData.clips) as Record<string, number>;
      });
      const bones = sk.skeleton.bones;
      width = Math.max(width, bones.length * 3);
      const clips = new Map<string, Clip>();
      for (const c of gltf.animations) {
        if (!c.name.startsWith(`${name}_`)) continue;
        const clipName = c.name.slice(name.length + 1);
        // Short loops (steps, a wave) 30 times a second, the slow standing ones 10.
        const fps = c.duration > 2 ? 10 : 30;
        const frames = Math.max(2, Math.round(c.duration * fps));
        clips.set(clipName, { row: rows.length, frames, duration: c.duration, dist: dist[clipName] ?? 0 });
        toRest();
        const action = mixer.clipAction(c);
        action.reset().play();
        for (let f = 0; f < frames; f++) {
          mixer.setTime((f * c.duration) / frames);
          scene.updateMatrixWorld(true);
          const line = new Float32Array(bones.length * 12);
          bones.forEach((b, i) => {
            _m.copy(b.matrixWorld).multiply(sk.skeleton.boneInverses[i]).multiply(sk.bindMatrix);
            const e = _m.elements;
            line.set([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]], i * 12);
          });
          rows.push(line);
        }
        action.stop();
      }
      found.push({ mesh: sk, far, clips });
    }
    // Several frames to a line of the picture when there are many (the walks, the standing loops): WebGL 2 only
    // promises pictures 2048 high.
    const wrap = Math.ceil(rows.length / 2048);
    const lines = Math.ceil(rows.length / wrap);
    const rowFloats = width * 4 * wrap;
    const out = new Uint16Array(rowFloats * lines);
    rows.forEach((line, r) => {
      const at = Math.floor(r / wrap) * rowFloats + (r % wrap) * width * 4;
      for (let i = 0; i < line.length; i++) out[at + i] = THREE.DataUtils.toHalfFloat(line[i]);
    });
    this.boneTex = new THREE.DataTexture(out, width * wrap, lines, THREE.RGBAFormat, THREE.HalfFloatType);
    this.boneTex.minFilter = this.boneTex.magFilter = THREE.NearestFilter;
    this.boneTex.generateMipmaps = false;
    this.boneTex.needsUpdate = true;
    const material = villagerMaterial(this.boneTex, this.palTex, wrap, width);
    const lod = (src: THREE.SkinnedMesh, k: number, clips: Map<string, Clip>, bones: THREE.Bone[], label: string): Kind => {
      const geo = new THREE.BufferGeometry();
      for (const a of ['position', 'normal', 'uv', 'skinWeight']) if (src.geometry.attributes[a]) geo.setAttribute(a, src.geometry.attributes[a]);
      // Its points name their bones by the near figure's order (the bone picture's), whatever order its own skin has.
      const idx = src.geometry.attributes.skinIndex as THREE.BufferAttribute;
      const map = src.skeleton.bones.map((b) => Math.max(0, bones.findIndex((n) => n.name === b.name)));
      const ids = new Uint16Array(idx.count * 4);
      for (let i = 0; i < idx.count; i++) for (let c = 0; c < 4; c++) ids[i * 4 + c] = map[idx.getComponent(i, c)] ?? 0;
      geo.setAttribute('skinIndex', new THREE.BufferAttribute(ids, 4));
      geo.setIndex(src.geometry.index);
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(ALL[k] * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const look = new THREE.InstancedBufferAttribute(new Float32Array(ALL[k] * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAnim', anim);
      geo.setAttribute('aLook', look);
      // Its bounds hold any pose (a bike is long): a ball round the figure, made bigger.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), k === BIKE ? 1.5 : 1.3);
      const mesh = new THREE.InstancedMesh(geo, material, ALL[k]);
      mesh.count = 0;
      mesh.castShadow = false; // a patch on the ground instead
      mesh.receiveShadow = true;
      mesh.userData.ignoreRay = true;
      mesh.userData.noAO = true;
      mesh.raycast = () => {};
      mesh.name = `villagers-${KINDS[k]}${label}`;
      this.group.add(mesh);
      return { mesh, clips, anim, look };
    };
    found.forEach(({ mesh: src, far, clips }, k) => {
      this.kinds[k] = lod(src, k, clips, src.skeleton.bones, '');
      this.fars[k] = far ? lod(far, k, clips, src.skeleton.bones, '-far') : null;
    });
  }

  /** What the traffic stops for: villagers on a carriageway (crossing, cycling on the road). */
  obstacles(): Obstacle[] {
    const out: Obstacle[] = [];
    if (this.shown <= 0) return out;
    for (const v of this.order) {
      if (v.fade < 0.5 || v.away || v.downAt >= 0 || !v.road) continue;
      out.push({ x: v.x, z: v.z, r: v.kind === BIKE ? 0.6 : 0.35 });
    }
    return out;
  }
  /** The figures someone else moves, asked for each frame they are drawn (world/footballLife.ts); null for none. */
  setExtras(fn: (() => readonly Extra[]) | null): void {
    this.extras = fn;
  }

  /**
   * A palette row for such a figure: a villager's colours as `dress` picks them, with these slots set (2 top, 3
   * bottoms, 4 shoes, 5 and 6 its things, 7 a child's lower legs; tools/villagers.py), and its extras (`flags`, or
   * picked as a villager's when left out); null when the model isn't in yet or no row is free. Give it back with `freeRow`.
   */
  dressRow(kind: number, cols: Record<number, string>, flags?: number): { pal: number; flags: number } | null {
    if (!this.boneTex) return null;
    const pal = this.palFree.pop();
    if (pal === undefined) return null;
    const v = { kind, pal, flags: 0 } as V;
    this.dress(v, cols, flags);
    return { pal, flags: v.flags };
  }

  freeRow(pal: number): void {
    if (!this.palFree.includes(pal)) this.palFree.push(pal);
  }

  /** A clip's length (s) and the metres a loop of it covers (0 for one that stays put), or null without it. */
  clipOf(kind: number, clip: string): { duration: number; dist: number } | null {
    const c = this.kinds[kind]?.clips.get(clip);
    return c ? { duration: c.duration, dist: c.dist } : null;
  }


  /** Each villager now, for checks: its number, kind, where, what it does, its clip, whether it can be hit, how far it is from its place on the clock. */
  states(): { id: number; kind: string; what: string; x: number; y: number; z: number; mode: Mode; clip: string; fade: number; flags: number; canHit: boolean; off: number }[] {
    const T = this.now;
    return this.order.map((v) => {
      villagerPose(this.set!, v.id, T, _p);
      return {
        id: v.id, kind: KINDS[v.kind], what: v.def.what, x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2), mode: this.modeOf(v), clip: v.clip, fade: +v.fade.toFixed(2),
        flags: v.flags, canHit: this.canHit(v), off: +Math.hypot(_p.x - v.x, _p.z - v.z).toFixed(2), // `off`: how far from where the shared clock has it (m)
      };
    });
  }

  private modeOf(v: V): Mode {
    if (v.away || v.downAt >= 0) return 'down';
    if (v.sit) return 'sit';
    if (v.kind === BIKE) return 'ride';
    if (v.def.role === 'follow') return 'follow';
    if (v.def.role === 'hub') return 'hub';
    return v.speed > 0.1 ? (v.road ? 'cross' : 'walk') : 'stand';
  }

  /**
   * Each person on foot with the right hand free, for world/sintmaarten.ts's paper lanterns: not a dog, a cyclist or
   * someone with a stick, not sitting, jogging, walking a dog or under an umbrella. Its number (the same on every
   * page), where its feet are, which way it faces, how tall it is (m), how far it has faded in (0 to 1), its speed.
   */
  eachHand(fn: (id: number, x: number, y: number, z: number, yaw: number, tall: number, fade: number, speed: number) => void): void {
    if (this.shown <= 0) return;
    for (const v of this.order) {
      if ((v.kind !== MAN && v.kind !== WOMAN && v.kind !== TEEN && v.kind !== CHILD) || v.sit || v.pk || v.def.jog || v.def.lead || v.flags & UMB || v.away || v.downAt >= 0) continue;
      fn(v.id, v.x, v.y, v.z, v.yaw, TALL[v.kind] * v.scale, Math.min(v.fade, this.shown), v.speed);
    }
  }

  // ---------------------------------------------------------------- shot, or painted
  /**
   * Whether this one can be hit now: a grown-up or a teen without a child, drawn and standing, not where nobody
   * shoots. As the server decides it (shared/villagers.mjs villagerHittable): for someone standing about on a busy
   * place the place's own middle counts too, so the page never shows a fall the server would refuse.
   */
  private canHit(v: V): boolean {
    if (v.def.role === 'hub' && noShoot(v.def.cx, v.def.cz)) return false;
    return v.def.shootable && v.drawn && v.fade > 0.6 && this.shown > 0.6 && v.downAt < 0 && !v.away && !this.downs.has(v.id) && !noShoot(v.x, v.z);
  }

  /** How high its body stands (m) and how wide round (m), for a shot. */
  private body(v: V): [number, number] {
    return [(v.sit ? 1.25 : TALL[v.kind]) * v.scale, v.kind === BIKE ? 0.4 : 0.3];
  }

  /**
   * The villager a shot meets first: from `from` along `dir` (length 1), no farther than `max` metres. Its
   * number, where it is struck and how far off; null for none. A child, a dog and the others no shot may hit
   * let it through.
   */
  rayHit(from: THREE.Vector3, dir: THREE.Vector3, max: number): { id: number; point: THREE.Vector3; dist: number } | null {
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a < 1e-9 || this.shown <= 0) return null;
    let best = max;
    let who = -1;
    for (const v of this.order) {
      if (v.dist > max + 2 || !this.canHit(v)) continue;
      const [tall, r] = this.body(v);
      const ox = from.x - v.x;
      const oz = from.z - v.z;
      const b = 2 * (ox * dir.x + oz * dir.z);
      const disc = b * b - 4 * a * (ox * ox + oz * oz - r * r);
      if (disc < 0) continue;
      const root = Math.sqrt(disc);
      let t = (-b - root) / (2 * a);
      const out = (-b + root) / (2 * a);
      if (out < 0) continue;
      t = Math.max(0, t);
      let y = from.y + dir.y * t;
      if (y > v.y + tall && dir.y < 0) {
        // Over its head on the way in: down through the top, if still above it.
        t = (v.y + tall - from.y) / dir.y;
        if (t > out) continue;
        y = v.y + tall;
      }
      if (y < v.y || y > v.y + tall || t >= best) continue;
      best = t;
      who = v.id;
    }
    return who < 0 ? null : { id: who, point: from.clone().addScaledVector(dir, best), dist: best };
  }

  /** Those a blast at `at` catches: within `radius` of it. */
  near(at: THREE.Vector3, radius: number): number[] {
    const out: number[] = [];
    for (const v of this.order) {
      if (!this.canHit(v) || Math.hypot(v.x - at.x, v.z - at.z) > radius || at.y < v.y - radius || at.y > v.y + 1.8 + radius) continue;
      out.push(v.id);
    }
    return out;
  }

  /** Whether any of the café's people (shared/villagers.mjs, `cafe`) is out and shown now: the café's murmur (world/keet.ts). */
  cafeIn(): boolean {
    for (const v of this.order) if (v.def.what === 'cafe' && v.fade > 0 && !v.away && v.downAt < 0) return true;
    return false;
  }

  /** Where villager `id` stands (its feet), or null when it isn't near. */
  where(id: number): THREE.Vector3 | null {
    const v = this.active.get(id);
    return v ? new THREE.Vector3(v.x, v.y, v.z) : null;
  }

  /** Your shot or blast hit villager `id` (`from`: where it came from): true if it could be hit, and then it falls. */
  hit(id: number, from?: { x: number; z: number }): boolean {
    const v = this.active.get(id);
    if (!v || !this.canHit(v)) return false;
    this.down(id, VILLAGER_DOWN_S, from);
    return true;
  }

  /** Villager `id` is down (someone hit it, or it was down when you joined: then `quiet`), back in `seconds`. */
  down(id: number, seconds: number, from?: { x: number; z: number }, quiet = false): void {
    if (!Number.isInteger(id) || id < 0 || id >= (this.set ? this.set.list.length : MOST) || !(seconds > 0)) return;
    this.downs.set(id, this.now + Math.min(seconds, 600));
    const v = this.active.get(id);
    if (!v || v.away || v.downAt >= 0) return;
    if (quiet || v.fade <= 0) {
      v.away = true;
      v.fade = 0;
      return;
    }
    v.downAt = this.clock;
    // It tips away from where the shot came from (backwards when that isn't known).
    let fx = from ? v.x - from.x : -Math.sin(v.yaw);
    let fz = from ? v.z - from.z : -Math.cos(v.yaw);
    const L = Math.hypot(fx, fz) || 1;
    fx /= L;
    fz /= L;
    v.fallX = fx;
    v.fallZ = fz;
    v.once = '';
    cry(v.x, v.y, v.z, v.kind, false);
  }

  /** Those down when you join: [number, ms until it is back] each. */
  setDown(list: unknown): void {
    this.downs.clear();
    for (const v of this.order) {
      if (v.away) v.placed = false;
      v.away = false;
      v.downAt = -1;
    }
    if (!Array.isArray(list)) return;
    for (const e of list.slice(0, 600)) if (Array.isArray(e) && typeof e[1] === 'number') this.down(Number(e[0]), e[1] / 1000, undefined, true);
  }

  /** Whether your paint may land on villager `id` (the same ones a shot may hit). */
  canPaint(id: number): boolean {
    const v = this.active.get(id);
    return !!v && this.canHit(v);
  }

  /** Paint of `color` (#rrggbb) on villager `id`'s clothes for `seconds`; with `fright` it jumps and stops a moment. */
  splat(id: number, color: string, seconds: number, fright = true): void {
    if (!Number.isInteger(id) || id < 0 || id >= (this.set ? this.set.list.length : MOST) || !(seconds > 0) || !/^#[0-9a-f]{6}$/i.test(color)) return;
    this.paints.set(id, { until: this.now + Math.min(seconds, 600), color });
    const v = this.active.get(id);
    if (!v) return;
    this.paintOn(v, color);
    if (!fright || v.away || v.downAt >= 0) return;
    v.hopAt = this.clock;
    v.holdUntil = this.clock + 1.3;
    cry(v.x, v.y, v.z, v.kind, true);
  }

  /** Those with paint on them when you join: [number, colour, ms left] each. */
  setPaint(list: unknown): void {
    for (const v of this.order) this.paintOff(v);
    this.paints.clear();
    if (!Array.isArray(list)) return;
    for (const e of list.slice(0, 600)) if (Array.isArray(e) && typeof e[1] === 'string' && typeof e[2] === 'number') this.splat(Number(e[0]), e[1], e[2] / 1000, false);
  }

  /** The paint goes onto its top (slot 2 of its colours). */
  private paintOn(v: V, color: string): void {
    const o = (v.pal * 16 + 2) * 4;
    if (!v.topWas) v.topWas = [this.palData[o], this.palData[o + 1], this.palData[o + 2]];
    putSRGB(this.palData, o, color);
    this.palTex.needsUpdate = true;
  }

  private paintOff(v: V): void {
    if (!v.topWas) return;
    const o = (v.pal * 16 + 2) * 4;
    [this.palData[o], this.palData[o + 1], this.palData[o + 2]] = v.topWas;
    v.topWas = null;
    this.palTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- who is near
  // ---------------------------------------------------------------- the population
  private ground(x: number, z: number, hint: number | null): number {
    const bare = this.world.groundAt(x, z, -1e4, 0).y;
    return this.world.groundAt(x, z, (hint ?? bare) + 0.6, 0).y;
  }

  /** A spot free for a body: nothing in the way from the knees to the head. */
  private free(x: number, z: number, y: number): boolean {
    return this.world.boxFree(x, z, 0, 0.25, 0.25, y + 0.35, y + 1.6);
  }

  private make(def: VillagerDef, p: VillagerPose): V | null {
    const pal = this.palFree.pop();
    if (pal === undefined) return null;
    const r = dice(def.seed + 1);
    const kind = def.kind;
    const v: V = {
      id: def.id, def, kind, x: p.x, y: 0, z: p.z, yaw: p.yaw, scale: kind === DOG ? 0.72 + r() * 0.36 : kind === CHILD ? 0.9 + r() * 0.18 : 0.95 + r() * 0.1, ground: 0, gx: p.x, gz: p.z,
      speed: p.speed, sit: p.sit, talk: p.talk, road: p.road, placed: false, still: 0, groundAt: this.clock + (def.id % 20) * 0.1,
      clip: kind === BIKE ? 'Ride' : p.sit ? 'Sit' : 'Idle', time: r() * IDLE_S, from: '', fromTime: 0, blend: 1, once: '', onceEnd: 0, fade: 0, pal, flags: 0, waved: -1e9,
      holdUntil: 0, avoid: 0, dodgeUntil: 0, dodgeX: 0, dodgeZ: 0, downAt: -1, fallX: 0, fallZ: 1, away: false, hopAt: -1e9, topWas: null, drawn: false, dist: 0, pk: false,
    };
    this.dress(v);
    if (def.jog) v.flags &= ~(BAG | SCARF | UMB);
    if (def.lead) v.flags &= ~BAG;
    if (def.what === 'cafe') v.flags &= ~(BAG | UMB); // the café's people hold nothing
    // Some walk with their hands in their pockets (not with a handbag, a lead or a child to hold).
    v.pk = (kind === MAN || kind === WOMAN || kind === TEEN) && !def.jog && !def.lead && !def.guards && !(kind === WOMAN && v.flags & BAG) && r() < 0.4;
    v.ground = this.ground(p.x, p.z, null);
    v.y = p.sit ? v.ground + ((this.set!.seats[def.seat]?.[3] ?? 0.45) - 0.45) : v.ground;
    const paint = this.paints.get(def.id);
    if (paint) this.paintOn(v, paint.color);
    this.active.set(def.id, v);
    return v;
  }

  private remove(v: V): void {
    v.topWas = null;
    this.palFree.push(v.pal);
    this.active.delete(v.id);
  }

  private reach(): number {
    return REACH[this.cheap() ? 1 : 0];
  }

  private get raining(): boolean {
    return mood.wet > 0.35;
  }

  /**
   * Whether this villager is out now: fewer at night, few in the rain (those who can hold an umbrella, and
   * cyclists), fewer on a phone or on Low. Those with the lowest `rank` stay, so every page drops the same ones.
   */
  private out(d: VillagerDef): boolean {
    const night = mood.night > 0.5;
    const rain = this.raining;
    let share = (this.cheap() ? CHEAP_SHARE : 1) * (1 - 0.7 * mood.night) * (1 - 0.8 * Math.min(1, mood.wet / 0.6));
    switch (d.what) {
      case 'elder': if (rain) return false; share *= night ? 0.3 : 1; break;
      case 'teen': share *= night ? 0.67 : 1; break;
      case 'jog': case 'dog': if (rain) return false; break;
      case 'family': case 'sit': if (rain || night) return false; break;
      case 'chat': if (rain) return false; share *= night ? 0.25 : 1; break;
      case 'hub': if (rain || (d.kind === CHILD && mood.night > 0.3)) return false; break;
      default: break;
    }
    return d.rank < share;
  }

  /** Whether (x, z) is in view and nearer than `d`. */
  private seen(x: number, z: number, eye: THREE.Vector3, look: THREE.Vector3, d: number): boolean {
    const dx = x - eye.x;
    const dz = z - eye.z;
    const L = Math.hypot(dx, dz);
    if (L > d) return false;
    if (L < 4) return true;
    const fl = Math.hypot(look.x, look.z) || 1;
    return (dx * look.x + dz * look.z) / (L * fl) > 0.55;
  }

  /**
   * A busy place near: the spots on its paving that are free in this page's world (blocks with a material: not a
   * lawn, not a garden; not on top of something), looked for again until the world round it is in.
   */
  private hubSpots(eye: THREE.Vector3): void {
    const set = this.set!;
    set.hubs.forEach(([hx, hz, r], h) => {
      if (this.hubDone[h] || this.clock - this.hubTried[h] < 30 || Math.hypot(hx - eye.x, hz - eye.z) > this.reach() + r) return;
      this.hubTried[h] = this.clock;
      const flat = this.data!.hubspots?.[h] ?? [];
      const out: number[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        const x = flat[i];
        const z = flat[i + 1];
        const bare = this.world.groundAt(x, z, -1e4, 0).y;
        const g = this.world.groundAt(x, z, bare + 0.6, 0);
        if (!g.mat || g.mat === 'forest' || g.y - bare > 0.5 || !this.free(x, z, g.y)) continue;
        out.push(x, z);
      }
      if (out.length >= 24) this.hubDone[h] = true;
      if (out.length === this.hubLen[h]) return;
      this.hubLen[h] = out.length;
      rebuildHub(set, h, out);
    });
  }

  /** Who is near enough to draw: those in reach come in, nearest first. */
  private scan(eye: THREE.Vector3): void {
    const set = this.set!;
    const T = this.now;
    const R = this.reach();
    this.hubSpots(eye);
    // Back again: one nobody has near.
    for (const [id, until] of this.downs) if (T >= until && !this.active.has(id)) this.downs.delete(id);
    for (const [id, p] of this.paints) {
      if (T < p.until) continue;
      this.paints.delete(id);
      const v = this.active.get(id);
      if (v) this.paintOff(v);
    }
    if (this.want) {
      for (const d of set.list) {
        if (d.gone || this.active.has(d.id) || this.downs.has(d.id) || !this.out(d)) continue;
        if (d.kind === DOG && this.downs.has(d.leader)) continue;
        if (Math.hypot(d.cx - eye.x, d.cz - eye.z) > R + d.r) continue;
        villagerPose(set, d.id, T, _p);
        if (!_p.here || Math.hypot(_p.x - eye.x, _p.z - eye.z) > R) continue;
        if (!this.make(d, _p)) break;
      }
    }
    this.order = [...this.active.values()].sort((a, b) => a.dist - b.dist);
  }

  // ---------------------------------------------------------------- every frame
  /**
   * Every frame. `eye`: the camera, `look`: where it looks; `me`: the player on foot (or null in a car or on a
   * horse); `cars`: the moving cars near (the traffic and anyone driving).
   */
  update(dt: number, eye: THREE.Vector3, look: THREE.Vector3, me: Me | null, cars: CarNear[]): void {
    this.shown = Math.max(0, Math.min(1, this.shown + (this.want ? dt : -dt) / FADE));
    if (!this.want && this.shown <= 0) {
      if (this.active.size) {
        for (const v of [...this.active.values()]) this.remove(v);
        this.order = [];
      }
      this.group.visible = false;
      return;
    }
    if (!this.set || !this.boneTex) return;
    this.group.visible = true;
    this.clock += dt;
    this.carSpeeds(cars, dt);
    if (this.clock > this.scanAt) {
      this.scanAt = this.clock + 0.4;
      this.scan(eye);
    }
    const T = this.now;
    // How long since the last frame on the shared clock: a villager keeps up with it however slowly the frames
    // come (the game's own `dt` is capped), up to a second.
    const real = Math.max(dt, Math.min(1, T - this.lastT));
    this.lastT = T;
    const near = this.cheap() ? 30 : 45;
    let gone = false;
    for (const v of this.order) {
      villagerPose(this.set, v.id, T, _p);
      v.dist = Math.hypot(v.x - eye.x, v.z - eye.z);
      this.step(v, _p, dt, real, T, eye, look, me, cars, v.dist < near);
      if (!this.active.has(v.id)) gone = true;
    }
    if (gone) this.order = this.order.filter((v) => this.active.has(v.id));
    this.draw(eye);
  }

  private dress(v: V, set?: Record<number, string>, flags?: number): void {
    // A villager's own dice, so it wears the same on every page; a figure dressed for someone else throws any.
    rnd = v.def ? dice(v.def.seed) : Math.random;
    try {
      this.dress1(v, set, flags);
    } finally {
      rnd = Math.random;
    }
  }

  /** Its colours and extras: written into its row of the palette (`set`, `flags`: a figure dressed for someone else). */
  private dress1(v: V, set?: Record<number, string>, flags?: number): void {
    const k = v.kind;
    const cols: string[] = new Array(16).fill('#808080');
    const skin = pickW(SKINS, SKIN_W);
    cols[0] = skin;
    cols[1] = k === ELDER ? pick(GREYS) : pick(HAIRS);
    cols[2] = pickW(TOPS, TOP_W);
    cols[3] = pickW(BOTTOMS, BOTTOM_W);
    // A dark top over dark trousers reads as one black shape: throw again for the trousers, twice at most.
    for (let i = 0; i < 2 && dark(cols[2]) && dark(cols[3]); i++) cols[3] = pickW(BOTTOMS, BOTTOM_W);
    cols[4] = pickW(SHOES, SHOE_W);
    cols[5] = pick(ACCS);
    cols[6] = pick(ACC2S);
    cols[7] = cols[3]; // a child's trousers below the knee (the football kit's socks, world/footballLife.ts)
    cols[8] = pick(FRAMES);
    cols[9] = '#f1efe9';
    cols[10] = '#1d1b1a';
    cols[11] = '#9a9ea3';
    cols[12] = '#1e1e1e';
    cols[13] = '#5a3a26';
    const lips = new THREE.Color(skin).lerp(new THREE.Color('#9a4a44'), 0.45);
    cols[14] = `#${lips.getHexString()}`;
    cols[15] = '#e6e3dc';
    let f = 0;
    if (k === DOG) {
      cols[2] = pick(COATS);
      cols[3] = chance(0.6) ? pick(PATCHES) : cols[2];
      cols[5] = pick(COLLARS);
      f |= chance(0.6) ? HAIR_A : HAIR_B;
    } else {
      // Its hair: one of two styles a kind has (tools/villagers.py HAIRS: the man parted or cropped, the woman to the
      // shoulders or short, a child long or short), and a beard for some grown-up men.
      f |= chance(([0.6, 0.75, 0.5, 0.7, 0.5, 0.6] as const)[k]) ? HAIR_A : HAIR_B;
      const extras = ({
        [MAN]: [[HAT, 0.3], [BAG, 0.3], [SPECS, 0.25], [SCARF, 0.3], [BEARD, 0.3]],
        [WOMAN]: [[BAG, 0.45], [SPECS, 0.2], [SCARF, 0.45], [HAT, 0.2]],
        [ELDER]: [[HAT, 0.55], [SPECS, 0.6], [SCARF, 0.45], [BEARD, 0.35]],
        [TEEN]: [[BAG, 0.5], [HAT, 0.3], [SCARF, 0.12]],
        [CHILD]: [[HAT, 0.5], [BAG, 0.4], [SCARF, 0.3]],
        [BIKE]: [[HAT, 0.5], [BAG, 0.35], [SCARF, 0.2], [BEARD, 0.2]],
      } as Record<number, [number, number][]>)[k] ?? [];
      for (const [bit, p] of extras) if (chance(p)) f |= bit;
    }
    if (set) for (const [i, col] of Object.entries(set)) cols[Number(i)] = col;
    // Flags given for someone else's figure keep a head of hair: its own pick when they name none.
    v.flags = flags === undefined ? f : flags & (HAIR_A | HAIR_B) ? flags : flags | (f & (HAIR_A | HAIR_B));
    for (let i = 0; i < 16; i++) {
      const o = (v.pal * 16 + i) * 4;
      putSRGB(this.palData, o, cols[i]);
      this.palData[o + 3] = 255;
    }
    this.palTex.needsUpdate = true;
  }

  private carSpeeds(cars: CarNear[], dt: number): void {
    this.carSpeed = cars.map((c) => {
      let best = Infinity;
      for (const p of this.prevCars) best = Math.min(best, Math.hypot(p.x - c.x, p.z - c.z));
      return best < 3 ? best / Math.max(dt, 1e-3) : 0;
    });
    this.prevCars = cars.map((c) => ({ x: c.x, z: c.z }));
  }


  /** One villager, one frame: `p` where the shared clock has it now. */
  private step(v: V, p: VillagerPose, dt: number, real: number, T: number, eye: THREE.Vector3, look: THREE.Vector3, me: Me | null, cars: CarNear[], near: boolean): void {
    const d = v.def;
    const R = this.reach();
    // Down: back when its time is up and nobody looks (or a little later anyway).
    const until = this.downs.get(v.id);
    if (until !== undefined && T >= until && v.downAt < 0 && (!this.seen(p.x, p.z, eye, look, 80) || T > until + 12)) {
      this.downs.delete(v.id);
      v.away = false;
      v.placed = false;
    }
    let show = p.here && this.out(d) && v.dist < R + 15 && !v.away && this.want && !(d.kind === DOG && this.downs.has(d.leader));
    if (v.downAt >= 0) {
      // Falling, lying a moment, then it fades away.
      show = this.clock - v.downAt < LIE;
      if (!show && v.fade <= 0) {
        v.downAt = -1;
        v.away = true;
      }
    }
    v.fade = Math.max(0, Math.min(1, v.fade + (show ? dt : -dt) / FADE));
    if (v.fade <= 0 && !show && v.downAt < 0 && (!v.away || v.dist > R + 15)) {
      this.remove(v);
      return;
    }
    if (v.away || v.downAt >= 0) return;
    v.sit = p.sit;
    v.talk = p.talk;
    v.road = p.road && p.speed > 0;
    if (p.sit) {
      v.x = p.x;
      v.z = p.z;
      v.yaw = p.yaw;
      v.speed = 0;
      v.placed = true;
      this.animate(v, dt, 0, false);
      this.ground1(v, dt);
      return;
    }
    let tx = p.x;
    let tz = p.z;
    let hold = this.clock < v.holdUntil;
    // The player in its way ahead: it steps round, and stops when you stand right before it.
    let aside = 0;
    const meNear = me && Math.abs(me.feet - v.y) < 2 ? Math.hypot(me.x - v.x, me.z - v.z) : Infinity;
    if (me && meNear < 3 && p.speed > 0 && v.kind !== DOG) {
      const along = (me.x - v.x) * p.hx + (me.z - v.z) * p.hz;
      const side = (me.x - v.x) * p.hz - (me.z - v.z) * p.hx; // + on its left
      const reach = v.kind === BIKE ? 7 : 2.6;
      if (along > 0 && along < reach && Math.abs(side) < 0.9) {
        aside = side >= 0 ? 0.8 : -0.8;
        if (along < 0.8 && Math.abs(side) < 0.45) hold = true;
      }
    }
    v.avoid += (aside - v.avoid) * Math.min(1, dt * 2.5);
    tx += -p.hz * v.avoid;
    tz += p.hx * v.avoid;
    // A car coming at it: step out of its way, quickly.
    if (d.role !== 'follow') {
      cars.forEach((c, i) => {
        const sp = this.carSpeed[i] ?? 0;
        if (sp < 1.2) return;
        const cfx = -Math.sin(c.yaw);
        const cfz = -Math.cos(c.yaw);
        const dx = v.x - c.x;
        const dz = v.z - c.z;
        const along = dx * cfx + dz * cfz;
        const side = dx * cfz - dz * cfx;
        if (along > -c.length / 2 && along < c.length / 2 + sp * 1.4 && Math.abs(side) < c.width / 2 + 1.1) {
          const sgn = side >= 0 ? 1 : -1;
          v.dodgeUntil = this.clock + 0.9;
          v.dodgeX = cfz * sgn;
          v.dodgeZ = -cfx * sgn;
        }
      });
    }
    const dodging = this.clock < v.dodgeUntil;
    if (dodging) {
      tx = v.x + v.dodgeX * 2;
      tz = v.z + v.dodgeZ * 2;
      hold = false;
    }
    const gx = tx - v.x;
    const gz = tz - v.z;
    const gap = Math.hypot(gx, gz);
    let moved = 0;
    if (!v.placed || gap > 14) {
      // Too far to walk there (the page slept, it came back): put there, faded in again.
      if (v.placed) v.fade = 0;
      v.x = tx;
      v.z = tz;
      v.yaw = p.yaw;
      v.speed = p.speed;
      v.placed = true;
      v.ground = this.ground(v.x, v.z, null);
      v.y = v.ground;
    } else {
      // It walks after where the clock has it: at that pace when it is there, quicker to catch up.
      const max = dodging ? 2.7 : v.kind === BIKE ? d.pace * 1.5 : Math.max(2.2, d.pace * 1.7);
      const sp = hold ? 0 : Math.min(max, p.speed + gap * 1.5);
      moved = Math.min(gap, sp * real);
      if (moved > 1e-5) this.move(v, (gx / gap) * moved, (gz / gap) * moved, near);
      v.speed += (moved / Math.max(real, 1e-3) - v.speed) * Math.min(1, dt * 8);
      let want = p.yaw;
      if (moved > 1e-4 && gap > 0.35) want = Math.atan2(gx, gz);
      else if (p.speed === 0 || hold) {
        // Standing: it looks at the player when close (friends keep to each other unless you come right up).
        if (meNear < (p.talk ? 3.5 : 7) && me) want = Math.atan2(me.x - v.x, me.z - v.z);
      }
      v.yaw += wrapAngle(want - v.yaw) * Math.min(1, dt * 5);
    }
    const moving = v.speed > 0.15;
    v.still = moving ? 0 : v.still + dt;
    this.lookAndWave(v, me, moving);
    this.animate(v, real, v.speed, moving);
    this.ground1(v, dt);
  }

  private move(v: V, dx: number, dz: number, near: boolean): void {
    v.x += dx;
    v.z += dz;
    if (near || (this.clock * 60 + v.id) % 3 < 1) {
      const pos = { x: v.x, z: v.z };
      this.world.resolve(pos, v.y, v.kind === BIKE ? 0.3 : 0.25, 0.45, 1.6);
      v.x = pos.x;
      v.z = pos.z;
    }
  }

  /** Its feet on the ground: looked up again every 25 cm, eased up and down a step. */
  private ground1(v: V, dt: number): void {
    if (Math.hypot(v.x - v.gx, v.z - v.gz) > 0.25) {
      v.ground = this.ground(v.x, v.z, v.ground);
      v.gx = v.x;
      v.gz = v.z;
      v.groundAt = this.clock;
    } else if ((v.sit || v.speed < 0.05) && this.clock - v.groundAt > 2) {
      // Still (a sitter, someone standing): looked up again every two seconds, as when it came, for a floor that came
      // in after it (the café's rooms, built in idle time once playing: before them it stood on the ground beneath).
      // Only ever up: one that walked onto something higher stays on it.
      v.ground = Math.max(v.ground, this.ground(v.x, v.z, null));
      v.groundAt = this.clock;
    }
    // A sitter is on its seat: the Sit clip sits on 45 cm, so it goes up or down by the seat's own height.
    const want = v.sit ? v.ground + ((this.set!.seats[v.def.seat]?.[3] ?? 0.45) - 0.45) : v.ground;
    v.y = Math.abs(want - v.y) > 1.2 ? want : v.y + (want - v.y) * Math.min(1, dt * 12);
  }

  /** Close to the player and looked at: it may wave (now and then), and stops for it. */
  private lookAndWave(v: V, me: Me | null, moving: boolean): void {
    if (!me || v.kind === DOG || v.kind === BIKE || v.def.jog || v.sit || v.once || v.fade < 1) return;
    const d = Math.hypot(me.x - v.x, me.z - v.z);
    if (d > 9 || d < 1.5 || this.clock - v.waved < 60) return;
    v.waved = this.clock;
    if (!chance(v.kind === CHILD ? 0.55 : 0.3)) return;
    v.once = 'Wave';
    v.onceEnd = this.clock + 2.4;
    if (moving && v.def.role !== 'follow') v.holdUntil = this.clock + 2.6;
  }

  /** Which clip it plays and how far along, blending a change over BLEND. */
  private animate(v: V, dt: number, speed: number, moving: boolean): void {
    const k = this.kinds[v.kind];
    if (!k) return;
    if (v.once && this.clock > v.onceEnd) v.once = '';
    let want: string;
    if (v.kind === BIKE) want = 'Ride';
    else if (v.once && !moving) want = v.once;
    else if (v.sit) want = 'Sit';
    else if (moving) {
      if (v.kind === DOG || v.kind === CHILD || v.kind === ELDER) want = v.kind === CHILD && speed > 2 ? 'Jog' : this.walkOf(v, k, '');
      else if (v.def.jog || speed > 2.3) want = 'Jog';
      else if (v.flags & UMB) want = 'WalkUmb';
      else if (v.def.lead) want = 'WalkLead';
      else want = this.walkOf(v, k, v.pk ? 'Pk' : '');
    } else if (v.flags & UMB) want = 'WalkUmb';
    else if (v.kind === DOG && v.still > 4) want = 'Sit';
    else if (v.talk && v.kind !== CHILD) want = 'Talk';
    else {
      // Standing about: one way of standing for a loop of it, then (perhaps) another, each villager its own order.
      const loop = Math.floor(v.time / IDLE_S);
      want = IDLES[((Math.imul(v.id + 1, 2654435761) ^ Math.imul(loop + 7, 40503)) >>> 0) % IDLES.length];
    }
    if (!k.clips.has(want)) want = k.clips.has('Idle') ? 'Idle' : 'Ride';
    if (want !== v.clip) {
      v.from = v.clip;
      v.fromTime = v.time;
      v.blend = 0;
      v.clip = want;
      if (want === 'Wave') v.time = 0;
    }
    const c = k.clips.get(v.clip);
    if (v.clip === 'Talk') {
      // Two friends take turns: the talk loop has one talking for its first half and listening for the other, on the
      // shared clock, the one who follows half a loop later.
      v.time = this.now + (v.def.role === 'follow' ? IDLE_S / 2 : 0);
    } else if (c?.dist) {
      // Walking and riding go at the pace of the ground covered, so the feet (and wheels) don't slide; standing still it holds.
      v.time += (speed * dt / (c.dist * v.scale)) * c.duration;
    } else v.time += dt;
    // From one way of standing to another slowly; anything else quickly.
    const slow = IDLES.includes(v.clip) && IDLES.includes(v.from);
    v.blend = Math.min(1, v.blend + dt / (slow ? 0.9 : BLEND));
  }

  /**
   * The walk whose own pace is nearest this villager's (tools/villagers.py bakes a walk and a stroll: shorter, slower
   * steps), so its feet keep to the ground without long slow strides; `style` 'Pk' for hands in the pockets.
   */
  private walkOf(v: V, k: Kind, style: string): string {
    const pace = v.def.pace || 1.3;
    let best = 'Walk';
    let err = Infinity;
    for (const name of ['Walk', 'Stroll']) {
      const c = k.clips.get(name + style) ?? k.clips.get(name);
      if (!c?.dist) continue;
      const e = Math.abs(Math.log((c.dist * v.scale) / c.duration / pace));
      if (e < err) {
        err = e;
        best = k.clips.has(name + style) ? name + style : name;
      }
    }
    return best;
  }

  /** In the rain the umbrella is up (those who have one: the man, the woman, the teen walking). */
  private umbrellas(): void {
    const up = this.raining;
    for (const v of this.order) {
      const can = (v.kind === MAN || v.kind === WOMAN || v.kind === TEEN) && !v.def.jog && !v.def.lead && !v.sit && v.def.what !== 'cafe';
      if (up && can) v.flags |= UMB;
      else v.flags &= ~UMB;
    }
  }

  private rows(c: Clip | undefined, t: number): [number, number, number] {
    if (!c) return [0, 0, 0];
    const f = ((((t / c.duration) % 1) + 1) % 1) * c.frames;
    const i = Math.floor(f);
    return [c.row + (i % c.frames), c.row + ((i + 1) % c.frames), f - i];
  }

  /** Into the instanced meshes, the patches and the leads. */
  private draw(eye: THREE.Vector3): void {
    this.umbrellas();
    const counts = this.kinds.map(() => 0);
    const nears = this.kinds.map(() => 0);
    const fars = this.kinds.map(() => 0);
    const farFrom = FAR_M[this.cheap() ? 1 : 0];
    // The near figure or, further off, the one with far fewer triangles; and its place in that mesh.
    const pickLod = (kind: number, x: number, z: number): [Kind, number] => {
      const far = this.fars[kind];
      if (far && Math.hypot(x - eye.x, z - eye.z) > farFrom) return [far, fars[kind]++];
      return [this.kinds[kind], nears[kind]++];
    };
    let patches = 0;
    const lead = this.leashes.geometry.attributes.position as THREE.BufferAttribute;
    let leads = 0;
    for (const v of this.order) {
      v.drawn = false;
      if (!this.kinds[v.kind] || v.away) continue;
      if (counts[v.kind] >= MAX[v.kind]) continue;
      v.drawn = true;
      counts[v.kind]++;
      const [k, i] = pickLod(v.kind, v.x, v.z);
      const fade = Math.min(v.fade, this.shown);
      _q.setFromAxisAngle(UP, v.yaw);
      let y = v.y;
      const hop = this.clock - v.hopAt;
      if (hop < 0.4) y += 0.3 * Math.sin((Math.PI * hop) / 0.4);
      const down = v.downAt >= 0;
      if (down) {
        // Tipping over, away from the shot, with a little bounce as it lands; it lies on the ground, not in it.
        const ft = this.clock - v.downAt;
        const f = Math.min(1, ft / FALL);
        let ang = (Math.PI / 2) * f * f;
        if (ft > FALL && ft < FALL + 0.25) ang -= 0.16 * Math.sin((Math.PI * (ft - FALL)) / 0.25);
        _q.premultiply(_q2.setFromAxisAngle(_v.set(v.fallZ, 0, -v.fallX), ang));
        y += 0.14 * Math.sin(ang) * v.scale;
      }
      _m.compose(_v.set(v.x, y, v.z), _q, _s.setScalar(v.scale));
      k.mesh.setMatrixAt(i, _m);
      const [a0, a1, af] = this.rows(k.clips.get(v.clip), v.time);
      let [rA, rB, mix] = [a0, a1, af];
      if (v.blend < 1 && v.from) {
        const [f0] = this.rows(k.clips.get(v.from), v.fromTime);
        [rA, rB, mix] = [f0, a0, v.blend];
      }
      k.anim.setXYZW(i, rA, rB, mix, v.pal);
      k.look.setXYZW(i, fade, v.flags, 0, 0);
      const d = Math.hypot(v.x - eye.x, v.z - eye.z);
      if (d < 60 && patches < 96 && !down) {
        const r = (v.kind === DOG ? 0.55 : v.kind === BIKE ? 0.9 : v.kind === CHILD ? 0.6 : 0.75) * v.scale * Math.min(1, fade * 1.4);
        const ground = v.sit ? v.ground : v.y;
        _m.compose(_v.set(v.x, ground + 0.03, v.z), _q.setFromAxisAngle(UP, v.yaw), _s.set(v.kind === BIKE ? r * 0.7 : r, 1, v.kind === BIKE ? r * 1.6 : r));
        this.patches.setMatrixAt(patches++, _m);
      }
      // The dog's lead: from the walker's right hand to the collar, sagging.
      const l = v.kind === DOG ? this.active.get(v.def.leader) : undefined;
      if (l && !l.away && l.downAt < 0 && leads < MAX[DOG] && Math.min(fade, l.fade) > 0.5) {
        const lfx = Math.sin(l.yaw);
        const lfz = Math.cos(l.yaw);
        const hx = l.x + lfx * 0.32 - lfz * 0.22; // the right hand, a little ahead
        const hz = l.z + lfz * 0.32 + lfx * 0.22;
        const hy = l.y + 0.92 * l.scale;
        const dfx = Math.sin(v.yaw);
        const dfz = Math.cos(v.yaw);
        const cx = v.x + dfx * 0.3 * v.scale;
        const cz = v.z + dfz * 0.3 * v.scale;
        const cy = v.y + 0.55 * v.scale;
        const pts: [number, number, number][] = [];
        for (let t = 0; t <= 3; t++) {
          const u = t / 3;
          const sag = Math.sin(Math.PI * u) * 0.18;
          pts.push([hx + (cx - hx) * u, hy + (cy - hy) * u - sag, hz + (cz - hz) * u]);
        }
        for (let t = 0; t < 3; t++) {
          lead.setXYZ(leads * 6 + t * 2, ...pts[t]);
          lead.setXYZ(leads * 6 + t * 2 + 1, ...pts[t + 1]);
        }
        leads++;
      }
    }
    for (const e of this.extras?.() ?? []) {
      if (!this.kinds[e.kind] || counts[e.kind] >= ALL[e.kind]) continue;
      counts[e.kind]++;
      const [k, i] = pickLod(e.kind, e.x, e.z);
      _m.compose(_v.set(e.x, e.y, e.z), _q.setFromAxisAngle(UP, e.yaw), _s.setScalar(e.scale));
      k.mesh.setMatrixAt(i, _m);
      const [rA, rB, mix] = this.rows(k.clips.get(e.clip), e.time);
      k.anim.setXYZW(i, rA, rB, mix, e.pal);
      const fade = Math.min(e.fade, this.shown);
      k.look.setXYZW(i, fade, e.flags, 0, 0);
      if (patches < 96 && Math.hypot(e.x - eye.x, e.z - eye.z) < 60 && e.clip !== 'Sit') {
        const r = (e.kind === CHILD ? 0.6 : 0.75) * e.scale * Math.min(1, fade * 1.4);
        _m.compose(_v.set(e.x, e.y + 0.03, e.z), _q.setFromAxisAngle(UP, e.yaw), _s.set(r, 1, r));
        this.patches.setMatrixAt(patches++, _m);
      }
    }
    const show = (k: Kind | null, n: number, kind: number) => {
      if (!k) return;
      k.mesh.count = Math.min(ALL[kind], n);
      k.mesh.visible = k.mesh.count > 0;
      if (!k.mesh.count) return;
      k.mesh.instanceMatrix.needsUpdate = true;
      k.anim.needsUpdate = true;
      k.look.needsUpdate = true;
      k.mesh.computeBoundingSphere();
    };
    this.kinds.forEach((k, kind) => {
      show(k, nears[kind], kind);
      show(this.fars[kind], fars[kind], kind);
    });
    this.patches.count = patches;
    this.patches.instanceMatrix.needsUpdate = true;
    this.leashes.geometry.setDrawRange(0, leads * 6);
    lead.needsUpdate = true;
  }
}
