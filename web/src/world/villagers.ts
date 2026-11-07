import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mood } from './mood';
import type { World } from './collision';
import type { Obstacle } from './traffic';
import { closest, Line, Paths, type At, type PathData } from './villagerPaths';

/**
 * Villagers: people walking and cycling round the village, in every mode (Yoshi, 7 Nov 2026: Action and
 * Paintball too), but gone during Zombies. They are never targets: shots pass through them. Our own models (tools/villagers.py,
 * web/public/models/villagers.glb): a man, a woman, an older person with a stick, a teen, a child, a cyclist
 * on a city bike and a dog, invented and generic, each villager in colours of its own (clothes, skin, hair,
 * a bag, a cap, glasses, a scarf, an umbrella in the rain).
 *
 * Where they go (world/villagerPaths.ts, tools/villager_paths.py): along the pavements and the edges of the
 * country roads, on the footpaths, across a street at a crossing or a junction after looking for cars (the
 * traffic stops for one on the road), cyclists one way on the right, on Molenhoek's red cycle lanes. More of
 * them round the church square, the school and the Sparrenhof, fewer in the fields. Some stand and chat in
 * twos, some sit on the benches, a parent walks with a child or a dog on a lead, a jogger runs by. Close to
 * the player they step aside or stop, look at you, and now and then wave. Fewer at night, and in heavy rain
 * only a few, under umbrellas (world/mood.ts).
 *
 * Purely local and for show: nothing of them goes over the network, they are no target for anything (no hit
 * boxes, their meshes take no rays), cars and the player pass through them (they step out of the way of a car
 * coming at them), and walls keep them out (world/collision.ts). They fade away when
 * a Zombies game starts, and come back when it is over.
 *
 * Cheap to draw, as world/zombies.ts does it: every clip of every kind is sampled into one picture of bone
 * matrices (half floats), and each kind is one instanced mesh skinned in its vertex shader, so seven kinds are
 * seven draws however many walk about, and a round patch on the ground under each is one more. Their colours
 * come from a small picture too (16 colours a villager). Only within reach of the player (fewer and nearer
 * on Low and on phones), and the model and the paths load the first time they are needed.
 */

const URL_GLB = '/models/villagers.glb';
const KINDS = ['man', 'woman', 'elder', 'teen', 'child', 'cyclist', 'dog'] as const;
const MAN = 0, WOMAN = 1, ELDER = 2, TEEN = 3, CHILD = 4, BIKE = 5, DOG = 6;
const MAX = [16, 16, 10, 10, 12, 12, 8];
/** How tall each kind stands (m, tools/villagers.py), for what they hold (eachHand) */
const TALL = [1.79, 1.67, 1.66, 1.71, 1.18, 1.75, 0.6];
const PALETTE_ROWS = 128;
const BLEND = 0.25; // s to change from one clip to the next
const FADE = 0.9; // s to fade in or out
/** How many villagers and how far: [desktop, phone or Low]. */
const COUNT = [30, 13];
const REACH = [105, 65];
// Extras (the model's groups): an umbrella, a bag, a cap or helmet, a scarf, glasses, two choices of hair (or ears).
const UMB = 1, BAG = 2, HAT = 4, SCARF = 8, SPECS = 16, HAIR_A = 32, HAIR_B = 64;

type Mode = 'walk' | 'wait' | 'cross' | 'stand' | 'sit' | 'goto' | 'ride' | 'follow' | 'hub';

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

interface V {
  id: number;
  kind: number;
  mode: Mode;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  ground: number;
  gx: number;
  gz: number;
  /** On a line: which, how far along, which way, how far to the right of it (now and wanted); a bike line or a walk */
  line: number;
  s: number;
  dir: number;
  lat: number;
  latWant: number;
  bike: boolean;
  speed: number;
  pace: number;
  /** Going straight to a point (a crossing, a seat, a spot on the square), and what it does there */
  tx: number;
  tz: number;
  next: { line: number; s: number; dir: number } | null;
  road: boolean;
  timer: number;
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
  leaving: boolean;
  pal: number;
  flags: number;
  jog: boolean;
  lead: boolean;
  leader: V | null;
  /** A follower's place: to the right of its leader and ahead of it (m) */
  side: number;
  ahead: number;
  partner: V | null;
  seat: number;
  hub: number;
  waved: number;
  /** The way it came off a line (not taken straight back), and when */
  cameFrom: number;
  cameAt: number;
  /** Stepping out of a car's way: until when, and which way */
  dodgeUntil: number;
  dodgeX: number;
  dodgeZ: number;
  /** Pushed off its way by a wall this long (s) */
  stuck: number;
}

// ---- Colours (sRGB; the picture holds them linear). Slots as in tools/villagers.py.
const SKINS = ['#f3cfb3', '#eac0a0', '#e2b08d', '#d29e7b', '#c08463', '#a46c4c', '#87553a', '#64402b', '#4b2f20'];
const SKIN_W = [3, 4, 4, 3, 2, 2, 1.5, 1, 1];
const HAIRS = ['#1f1a17', '#33261d', '#4b3424', '#6b4a2e', '#8f6a40', '#b8935c', '#d3b67c', '#8c3f22', '#2b2b2b'];
const GREYS = ['#d9d6d0', '#bdbab4', '#a19d97', '#ece8e0', '#8a8680'];
const TOPS = ['#2f4a6d', '#7a2e2e', '#3d5a3a', '#c9c3b5', '#3a3a3f', '#8a6d3b', '#5b6e8c', '#a3473a', '#e0ddd5', '#4f4a6e', '#2d6a6a', '#b58a3c', '#6b2f4f',
  '#d5a021', '#9bb0c4', '#c46a4a', '#55606b', '#efe8d8'];
const BOTTOMS = ['#2b2f38', '#3a3a3d', '#4a4f5c', '#2e3f5c', '#5a4a3a', '#7a7466', '#1f2227', '#3b4d6b', '#8c8676', '#4d3b30'];
const SHOES = ['#2a2826', '#e8e6e0', '#4a3426', '#1c1c1e', '#6a6f78', '#8a2f2f', '#d8d4cc'];
const ACCS = ['#7a3b24', '#2e3a4d', '#4a5a2e', '#8c2f2f', '#3b3b3b', '#c9a14a', '#2f6b8a', '#5a3a5c'];
const ACC2S = ['#1f3f8a', '#b02a2a', '#2b6b3a', '#e3b21f', '#3a3a3a', '#7a3b8a', '#e8e4da', '#d0582a', '#2a8a8a'];
const FRAMES = ['#2f5f8a', '#8a2f2f', '#2e2e30', '#e0ddd5', '#3d6b45', '#6b6f75', '#c26a2a', '#1f3f6a'];
const COATS = ['#2a2420', '#6b4a2a', '#c9a66b', '#e8dcc4', '#8a5a32', '#3a3a3c', '#b07a40', '#d8c8a8'];
const PATCHES = ['#e8dcc4', '#f1ece2', '#c9a66b', '#2a2420', '#8a6a4a'];
const COLLARS = ['#b02a2a', '#1f3f8a', '#2b6b3a', '#e3b21f', '#7a3b8a'];

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
function pickW<T>(list: readonly T[], w: readonly number[]): T {
  let t = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) if ((t -= w[i]) <= 0) return list[i];
  return list[list.length - 1];
}
const chance = (p: number) => Math.random() < p;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** The skinning added to the standard material: each villager's frames from the bone picture, its colours from the palette, its extras shown or not. */
const VERT_PARS = /* glsl */ `
#ifndef USE_SKINNING
attribute vec4 skinIndex;
attribute vec4 skinWeight;
#endif
attribute vec4 aAnim;
attribute vec4 aLook;
uniform highp sampler2D uBones;
flat varying float vSlot;
flat varying float vRow;
varying float vShade;
varying float vFade;
mat4 vBone(float bone, float row) {
  ivec2 at = ivec2(int(bone) * 3, int(row));
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
vShade = uv.y;
vFade = aLook.x;
`;

function villagerMaterial(bones: THREE.Texture, palette: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = { value: bones };
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
const UP = new THREE.Vector3(0, 1, 0);
const _at: At = { x: 0, z: 0, dx: 0, dz: 1 };
const _bt: At = { x: 0, z: 0, dx: 0, dz: 1 };
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

export class Villagers {
  readonly group = new THREE.Group();
  /** Resolves when the model and the paths are in (false if they couldn't be loaded); started by the first setActive(true). */
  ready: Promise<boolean> | null = null;
  private paths: Paths | null = null;
  private kinds: Kind[] = [];
  private boneTex: THREE.DataTexture | null = null;
  private palData = new Uint8Array(16 * PALETTE_ROWS * 4);
  private palTex: THREE.DataTexture;
  private palFree: number[] = [];
  private patches = shadowPatches(96);
  private leashes: THREE.LineSegments;
  private vs: V[] = [];
  private nextId = 1;
  private clock = 0;
  private want = false;
  /** 0 hidden .. 1 shown: all of them together, as a Zombies game comes and goes */
  private shown = 0;
  private filled = false;
  private popAt = 0;
  private hubSpots: ([number, number, number][] | null)[] = [];
  private hubTried: number[] = [];
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

  /** How many are about, for the diagnostics. */
  get count(): number {
    return this.vs.length;
  }

  private async load(): Promise<boolean> {
    try {
      const [gltf, data] = await Promise.all([new GLTFLoader().loadAsync(URL_GLB), import('../data/villagers.json')]);
      this.paths = new Paths((data.default ?? data) as unknown as PathData);
      this.build(gltf);
      this.hubSpots = this.paths.hubs.map(() => null);
      this.hubTried = this.paths.hubs.map(() => -1e9);
      if (this.compile) {
        // Shown for the moment the shaders are gathered (nothing is drawn), then as they were.
        const was = this.group.visible;
        this.group.visible = true;
        for (const k of this.kinds) k.mesh.visible = true;
        const done = this.compile(this.group);
        this.group.visible = was;
        for (const k of this.kinds) k.mesh.visible = false;
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
    const found: { mesh: THREE.SkinnedMesh; clips: Map<string, Clip> }[] = [];
    for (const name of KINDS) {
      const root = scene.getObjectByName(`vil_${name}`);
      let mesh: THREE.SkinnedMesh | null = null;
      root?.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
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
      found.push({ mesh: sk, clips });
    }
    const rowFloats = width * 4;
    const out = new Uint16Array(rowFloats * rows.length);
    rows.forEach((line, y) => {
      for (let i = 0; i < line.length; i++) out[y * rowFloats + i] = THREE.DataUtils.toHalfFloat(line[i]);
    });
    this.boneTex = new THREE.DataTexture(out, width, rows.length, THREE.RGBAFormat, THREE.HalfFloatType);
    this.boneTex.minFilter = this.boneTex.magFilter = THREE.NearestFilter;
    this.boneTex.generateMipmaps = false;
    this.boneTex.needsUpdate = true;
    found.forEach(({ mesh: src, clips }, k) => {
      const geo = new THREE.BufferGeometry();
      for (const a of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) if (src.geometry.attributes[a]) geo.setAttribute(a, src.geometry.attributes[a]);
      geo.setIndex(src.geometry.index);
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(MAX[k] * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const look = new THREE.InstancedBufferAttribute(new Float32Array(MAX[k] * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAnim', anim);
      geo.setAttribute('aLook', look);
      // Its bounds hold any pose (a bike is long): a ball round the figure, made bigger.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), k === BIKE ? 1.5 : 1.3);
      const mesh = new THREE.InstancedMesh(geo, villagerMaterial(this.boneTex!, this.palTex), MAX[k]);
      mesh.count = 0;
      mesh.castShadow = false; // a patch on the ground instead
      mesh.receiveShadow = true;
      mesh.userData.ignoreRay = true;
      mesh.userData.noAO = true;
      mesh.raycast = () => {};
      mesh.name = `villagers-${KINDS[k]}`;
      this.group.add(mesh);
      this.kinds[k] = { mesh, clips, anim, look };
    });
  }

  /** What the traffic stops for: villagers that may be on a carriageway (crossing, going somewhere straight, cycling on the road). */
  obstacles(): Obstacle[] {
    const out: Obstacle[] = [];
    if (this.shown <= 0) return out;
    for (const v of this.vs) {
      if (v.fade < 0.5) continue;
      if (v.mode === 'cross' || v.mode === 'goto' || (v.mode === 'ride' && this.paths?.bkind[v.line] === 1)) out.push({ x: v.x, z: v.z, r: v.bike ? 0.6 : 0.35 });
    }
    return out;
  }

  /** Each villager now, for checks: kind, where, what it does, its clip. */
  states(): { kind: string; x: number; y: number; z: number; mode: Mode; clip: string; fade: number; flags: number }[] {
    return this.vs.map((v) => ({ kind: KINDS[v.kind], x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2), mode: v.mode, clip: v.clip, fade: +v.fade.toFixed(2), flags: v.flags }));
  }

  /**
   * Each person on foot with the right hand free, for world/sintmaarten.ts's paper lanterns: not a dog, a cyclist or
   * someone with a stick, not sitting, jogging, walking a dog or under an umbrella. Its number (the same while it is
   * about), where its feet are, which way it faces, how tall it is (m), how far it has faded in (0 to 1), its speed.
   */
  eachHand(fn: (id: number, x: number, y: number, z: number, yaw: number, tall: number, fade: number, speed: number) => void): void {
    if (this.shown <= 0) return;
    for (const v of this.vs) {
      if ((v.kind !== MAN && v.kind !== WOMAN && v.kind !== TEEN && v.kind !== CHILD) || v.mode === 'sit' || v.jog || v.lead || v.flags & UMB) continue;
      fn(v.id, v.x, v.y, v.z, v.yaw, TALL[v.kind] * v.scale, Math.min(v.fade, this.shown), v.speed);
    }
  }

  // ---------------------------------------------------------------- the population
  private ground(x: number, z: number, hint: number | null): number {
    const bare = this.world.groundAt(x, z, -1e4, 0).y;
    return this.world.groundAt(x, z, (hint ?? bare) + 0.6, 0).y;
  }

  /** A spot free for a body: nothing in the way from the knees to the head. */
  private free(x: number, z: number, y: number): boolean {
    return this.world.boxFree(x, z, 0, 0.25, 0.25, y + 0.35, y + 1.6);
  }

  private make(kind: number, x: number, z: number, y: number, yaw: number): V {
    const v: V = {
      id: this.nextId++, kind, mode: 'walk', x, y, z, yaw, scale: kind === DOG ? rand(0.72, 1.08) : kind === CHILD ? rand(0.9, 1.08) : rand(0.95, 1.05), ground: y, gx: x, gz: z,
      line: -1, s: 0, dir: 1, lat: 0, latWant: 0, bike: kind === BIKE, speed: 0, pace: 1.3, tx: x, tz: z, next: null, road: false, timer: 0,
      clip: 'Idle', time: Math.random() * 4, from: '', fromTime: 0, blend: 1, once: '', onceEnd: 0, fade: 0, leaving: false, pal: this.palFree.pop() ?? 0, flags: 0,
      jog: false, lead: false, leader: null, side: 0, ahead: 0, partner: null, seat: -1, hub: -1, waved: -1e9, cameFrom: -1, cameAt: -1e9, dodgeUntil: 0, dodgeX: 0,
      dodgeZ: 0, stuck: 0,
    };
    this.dress(v);
    this.vs.push(v);
    return v;
  }

  /** Its colours and extras: written into its row of the palette. */
  private dress(v: V): void {
    const k = v.kind;
    const cols: string[] = new Array(16).fill('#808080');
    const skin = pickW(SKINS, SKIN_W);
    cols[0] = skin;
    cols[1] = k === ELDER ? pick(GREYS) : pick(HAIRS);
    cols[2] = pick(TOPS);
    cols[3] = pick(BOTTOMS);
    cols[4] = pick(SHOES);
    cols[5] = pick(ACCS);
    cols[6] = pick(ACC2S);
    cols[7] = k === CHILD && chance(0.55) ? skin : cols[3];
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
      if (k === WOMAN) f |= chance(0.5) ? HAIR_A : HAIR_B;
      const extras = ({
        [MAN]: [[HAT, 0.2], [BAG, 0.3], [SPECS, 0.25], [SCARF, 0.15]],
        [WOMAN]: [[BAG, 0.45], [SPECS, 0.2], [SCARF, 0.25]],
        [ELDER]: [[HAT, 0.55], [SPECS, 0.6], [SCARF, 0.3]],
        [TEEN]: [[BAG, 0.5], [HAT, 0.25]],
        [CHILD]: [[HAT, 0.3], [BAG, 0.4]],
        [BIKE]: [[HAT, 0.5], [BAG, 0.35]],
      } as Record<number, [number, number][]>)[k] ?? [];
      for (const [bit, p] of extras) if (chance(p)) f |= bit;
    }
    v.flags = f;
    const c = new THREE.Color();
    for (let i = 0; i < 16; i++) {
      c.set(cols[i]).convertSRGBToLinear();
      const o = (v.pal * 16 + i) * 4;
      this.palData[o] = Math.round(c.r * 255);
      this.palData[o + 1] = Math.round(c.g * 255);
      this.palData[o + 2] = Math.round(c.b * 255);
      this.palData[o + 3] = 255;
    }
    this.palTex.needsUpdate = true;
  }

  private remove(v: V): void {
    this.palFree.push(v.pal);
    const i = this.vs.indexOf(v);
    if (i >= 0) this.vs.splice(i, 1);
  }

  /** Go: it and whoever walks with it fade out. */
  private leave(v: V): void {
    v.leaving = true;
    for (const o of this.vs) if (o.leader === v || o.partner === v) o.leaving = true;
  }

  private reach(): number {
    return REACH[this.cheap() ? 1 : 0];
  }

  /** How many there should be now: fewer at night, few in the rain. */
  private target(): number {
    const base = COUNT[this.cheap() ? 1 : 0];
    return Math.round(base * (1 - 0.7 * mood.night) * (1 - 0.8 * Math.min(1, mood.wet / 0.6)));
  }

  private get raining(): boolean {
    return mood.wet > 0.35;
  }

  private population(eye: THREE.Vector3, look: THREE.Vector3): void {
    const R = this.reach();
    // Too far: go (out of sight it is gone at once). In the rain those without an umbrella go home.
    for (const v of this.vs) {
      if (v.leaving || v.leader) continue;
      const d = Math.hypot(v.x - eye.x, v.z - eye.z);
      if (d > R + 15) this.leave(v);
      else if (this.raining && !v.bike && !(v.kind === MAN || v.kind === WOMAN || v.kind === TEEN) && !this.seen(v.x, v.z, eye, look, 45)) this.leave(v);
      else if (this.raining && (v.mode === 'sit' || v.mode === 'stand' || v.mode === 'hub' || v.lead || v.jog) && !this.seen(v.x, v.z, eye, look, 45)) this.leave(v);
    }
    const alive = this.vs.filter((v) => !v.leaving && v.kind !== DOG && !v.leader).length;
    const target = this.target();
    if (alive > target + 2) {
      // Too many: the farthest one out of sight goes.
      const far = this.vs.filter((v) => !v.leaving && !v.leader && !this.seen(v.x, v.z, eye, look, 50)).sort((a, b) => Math.hypot(b.x - eye.x, b.z - eye.z) - Math.hypot(a.x - eye.x, a.z - eye.z))[0];
      if (far) this.leave(far);
    }
    const first = !this.filled;
    for (let n = 0; n < (first ? target : 2) && alive + n < target; n++) this.spawn(eye, look, first ? 6 : 28, R);
    this.filled = true;
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

  private spawn(eye: THREE.Vector3, look: THREE.Vector3, rMin: number, rMax: number): void {
    const P = this.paths!;
    const night = mood.night > 0.5;
    const rain = this.raining;
    // A busy place in reach (of two, either: the church square and the school are 60 m apart).
    const hubsNear = P.hubs.map((_, i) => i).filter((i) => Math.hypot(P.hubs[i][0] - eye.x, P.hubs[i][1] - eye.z) < rMax + P.hubs[i][2]);
    const hubNear = hubsNear.length ? pick(hubsNear) : -1;
    const seatFree = P.seats.findIndex(([x, z], i) => !this.vs.some((v) => v.seat === i) && Math.hypot(x - eye.x, z - eye.z) < rMax && Math.hypot(x - eye.x, z - eye.z) > (this.filled ? 25 : 3)
      && !(this.filled && this.seen(x, z, eye, look, 60)));
    const options: [() => boolean, number][] = [
      [() => this.spawnWalker(pick([MAN, WOMAN]), eye, look, rMin, rMax), 36],
      [() => !rain && this.spawnWalker(ELDER, eye, look, rMin, rMax), night ? 3 : 10],
      [() => this.spawnWalker(TEEN, eye, look, rMin, rMax), night ? 6 : 9],
      [() => !rain && this.spawnWalker(pick([MAN, WOMAN, TEEN]), eye, look, rMin, rMax, 'jog'), 5],
      [() => !rain && !night && this.spawnFamily(eye, look, rMin, rMax), 9],
      [() => !rain && this.spawnWalker(pick([MAN, WOMAN]), eye, look, rMin, rMax, 'dog'), 7],
      [() => this.spawnCyclist(eye, look, rMin, rMax), rain ? 8 : 13],
      [() => !rain && this.spawnChat(eye, look, rMin, rMax), night ? 2 : 8],
      [() => !rain && !night && seatFree >= 0 && this.spawnSitter(seatFree), seatFree >= 0 ? 7 : 0],
      [() => !rain && hubNear >= 0 && this.spawnHub(hubNear, eye, look, rMin), hubNear >= 0 ? 14 : 0],
    ];
    for (let tries = 0; tries < 4; tries++) {
      const fn = pickW(options.map((o) => o[0]), options.map((o) => o[1]));
      if (fn()) return;
    }
  }

  /** A spot on a line, free and out of sight (unless filling the first time). */
  private spotOn(bikes: boolean, eye: THREE.Vector3, look: THREE.Vector3, rMin: number, rMax: number): { line: number; s: number; x: number; z: number; y: number } | null {
    let y = 0;
    const hit = this.paths!.sample(eye.x, eye.z, rMin, rMax, bikes, (_l, _s, px, pz) => {
      if (this.filled && this.seen(px, pz, eye, look, 70)) return false;
      if (this.vs.some((v) => Math.abs(v.x - px) < 2 && Math.abs(v.z - pz) < 2)) return false;
      y = this.ground(px, pz, null);
      return this.free(px, pz, y);
    });
    if (!hit) return null;
    const L = bikes ? this.paths!.bikes[hit.line] : this.paths!.walks[hit.line];
    L.at(hit.s, _at);
    return { ...hit, x: _at.x, z: _at.z, y };
  }

  /** Whether the kinds' instanced meshes have room for these (each a villager to come; -1 none). */
  private room(...kinds: number[]): boolean {
    const want = MAX.map(() => 0);
    for (const k of kinds) if (k >= 0) want[k]++;
    for (const v of this.vs) want[v.kind]++;
    return want.every((n, k) => n <= MAX[k]);
  }

  private spawnWalker(kind: number, eye: THREE.Vector3, look: THREE.Vector3, rMin: number, rMax: number, what: '' | 'jog' | 'dog' = ''): boolean {
    if (!this.room(kind, what === 'dog' ? DOG : -1)) return false;
    const p = this.spotOn(false, eye, look, rMin, rMax);
    if (!p) return false;
    const v = this.make(kind, p.x, p.z, p.y, 0);
    this.onLine(v, p.line, p.s, chance(0.5) ? 1 : -1);
    v.pace = kind === ELDER ? rand(0.8, 1.0) : kind === TEEN ? rand(1.3, 1.5) : rand(1.2, 1.45);
    if (what === 'jog') {
      v.jog = true;
      v.pace = rand(2.4, 3.0);
      v.flags &= ~(BAG | SCARF | UMB);
    }
    if (what === 'dog') {
      v.lead = true;
      v.pace = rand(1.0, 1.25);
      v.flags &= ~BAG;
      const d = this.make(DOG, p.x, p.z, p.y, v.yaw);
      d.mode = 'follow';
      d.leader = v;
      d.side = rand(0.35, 0.6);
      d.ahead = rand(1.2, 1.6);
    }
    return true;
  }

  private spawnFamily(eye: THREE.Vector3, look: THREE.Vector3, rMin: number, rMax: number): boolean {
    const pk = pick([MAN, WOMAN]);
    const kids = chance(0.3) ? 2 : 1;
    if (!this.room(pk, CHILD, kids === 2 ? CHILD : -1)) return false;
    const p = this.spotOn(false, eye, look, rMin, rMax);
    if (!p) return false;
    const parent = this.make(pk, p.x, p.z, p.y, 0);
    this.onLine(parent, p.line, p.s, chance(0.5) ? 1 : -1);
    parent.pace = rand(1.0, 1.2);
    for (let i = 0; i < kids; i++) {
      const c = this.make(CHILD, p.x, p.z, p.y, 0);
      c.mode = 'follow';
      c.leader = parent;
      c.side = i ? -0.7 : 0.65;
      c.ahead = i ? 0.1 : -0.15;
    }
    return true;
  }

  private spawnCyclist(eye: THREE.Vector3, look: THREE.Vector3, rMin: number, rMax: number): boolean {
    if (!this.room(BIKE)) return false;
    const p = this.spotOn(true, eye, look, rMin, rMax);
    if (!p) return false;
    const v = this.make(BIKE, p.x, p.z, p.y, 0);
    v.mode = 'ride';
    v.bike = true;
    v.line = p.line;
    v.s = p.s;
    v.dir = 1;
    v.pace = rand(3.6, 5.2);
    v.speed = v.pace;
    this.paths!.bikes[p.line].at(p.s, _at);
    v.yaw = Math.atan2(_at.dx, _at.dz);
    return true;
  }

  private spawnChat(eye: THREE.Vector3, look: THREE.Vector3, rMin: number, rMax: number): boolean {
    const kinds = [MAN, WOMAN, ELDER, TEEN];
    const [ka, kb] = [pick(kinds), pick(kinds)];
    if (!this.room(ka, kb)) return false;
    const p = this.spotOn(false, eye, look, rMin, rMax);
    if (!p) return false;
    const L = this.paths!.walks[p.line];
    const s2 = p.s + (p.s + 1.2 < L.length ? 1.1 : -1.1);
    L.at(s2, _bt);
    if (!this.free(_bt.x, _bt.z, p.y)) return false;
    const a = this.make(ka, p.x, p.z, p.y, Math.atan2(_bt.x - p.x, _bt.z - p.z));
    const b = this.make(kb, _bt.x, _bt.z, p.y, Math.atan2(p.x - _bt.x, p.z - _bt.z));
    for (const [v, s] of [[a, p.s], [b, s2]] as [V, number][]) {
      this.onLine(v, p.line, s, chance(0.5) ? 1 : -1);
      v.lat = 0;
      v.mode = 'stand';
      v.timer = rand(20, 70);
      v.speed = 0;
    }
    a.partner = b;
    b.partner = a;
    a.x = p.x;
    a.z = p.z;
    b.x = _bt.x;
    b.z = _bt.z;
    a.yaw = Math.atan2(b.x - a.x, b.z - a.z);
    b.yaw = Math.atan2(a.x - b.x, a.z - b.z);
    return true;
  }

  private spawnSitter(seat: number): boolean {
    const [x, z, face, h] = this.paths!.seats[seat];
    // The Sit clip sits on 45 cm: the figure goes up or down by the seat's own height.
    const k = pick([MAN, WOMAN, ELDER, ELDER, TEEN]);
    if (!this.room(k)) return false;
    const y = this.ground(x, z, null) + (h - 0.45);
    const v = this.make(k, x, z, y, face);
    v.mode = 'sit';
    v.seat = seat;
    v.timer = rand(30, 120);
    v.flags &= ~UMB;
    return true;
  }

  private spawnHub(h: number, eye: THREE.Vector3, look: THREE.Vector3, rMin: number): boolean {
    const spots = this.hubSpotsFor(h);
    if (!spots?.length) return false;
    const [hx, hz, , kind] = this.paths!.hubs[h];
    for (let tries = 0; tries < 6; tries++) {
      const [x, z, y] = pick(spots);
      if (this.filled && (this.seen(x, z, eye, look, 60) || Math.hypot(x - eye.x, z - eye.z) < Math.min(rMin, 20))) continue;
      if (this.vs.some((v) => Math.abs(v.x - x) < 1.5 && Math.abs(v.z - z) < 1.5)) continue;
      const k = kind === 1 ? pick([MAN, WOMAN, CHILD, CHILD]) : pick([MAN, WOMAN, ELDER, TEEN, MAN, WOMAN]);
      if ((k === CHILD && mood.night > 0.3) || !this.room(k)) continue;
      const v = this.make(k, x, z, y, Math.atan2(hx - x, hz - z) + rand(-1, 1));
      v.mode = 'hub';
      v.hub = h;
      v.timer = rand(2, 12);
      v.pace = k === ELDER ? rand(0.8, 1.0) : rand(1.0, 1.3);
      v.tx = x;
      v.tz = z;
      return true;
    }
    return false;
  }

  /** Free spots on a busy place's paving (blocks with a material: not a lawn, not a garden), found once the world round it is in. */
  private hubSpotsFor(h: number): [number, number, number][] | null {
    const have = this.hubSpots[h];
    if ((have && have.length >= 12) || this.clock - this.hubTried[h] < 30) return have;
    this.hubTried[h] = this.clock;
    const flat = this.paths!.hubSpots[h] ?? [];
    const out: [number, number, number][] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i];
      const z = flat[i + 1];
      // On paving (not a lawn), not on top of something, and free of every block (the town's and the school's models too).
      const bare = this.world.groundAt(x, z, -1e4, 0).y;
      const g = this.world.groundAt(x, z, bare + 0.6, 0);
      if (!g.mat || g.mat === 'forest' || g.y - bare > 0.5 || !this.free(x, z, g.y)) continue;
      out.push([x, z, g.y]);
    }
    this.hubSpots[h] = out;
    return out;
  }

  /** Put a villager on a walk line. */
  private onLine(v: V, line: number, s: number, dir: number): void {
    v.mode = 'walk';
    v.line = line;
    v.s = s;
    v.dir = dir;
    v.latWant = v.lat = rand(0.15, 0.45);
    this.paths!.walks[line].at(s, _at);
    v.yaw = Math.atan2(_at.dx * dir, _at.dz * dir);
  }

  // ---------------------------------------------------------------- every frame
  /**
   * Every frame. `eye`: the camera, `look`: where it looks; `me`: the player on foot (or null in a car or on a
   * horse); `cars`: the moving cars near (the traffic and anyone driving).
   */
  update(dt: number, eye: THREE.Vector3, look: THREE.Vector3, me: Me | null, cars: CarNear[]): void {
    this.shown = Math.max(0, Math.min(1, this.shown + (this.want ? dt : -dt) / FADE));
    if (!this.want && this.shown <= 0) {
      if (this.vs.length) {
        for (const v of [...this.vs]) this.remove(v);
        this.filled = false;
      }
      this.group.visible = false;
      return;
    }
    if (!this.paths || !this.boneTex) return;
    this.group.visible = true;
    this.clock += dt;
    this.carSpeeds(cars, dt);
    if (this.want && this.clock > this.popAt) {
      this.popAt = this.clock + (this.filled ? 0.7 : 0);
      this.population(eye, look);
    }
    const near = this.cheap() ? 30 : 45;
    for (const v of [...this.vs]) {
      // Fading in, or out when it goes (at once if nobody sees it).
      if (v.leaving) {
        v.fade -= dt / FADE;
        if (v.fade <= 0 || !this.seen(v.x, v.z, eye, look, 80)) {
          this.remove(v);
          continue;
        }
      } else v.fade = Math.min(1, v.fade + dt / FADE);
      if (v.leader && !this.vs.includes(v.leader)) {
        this.leave(v);
        v.leader = null;
        v.mode = 'stand';
        v.timer = 99;
      }
      if (v.partner && !this.vs.includes(v.partner)) v.partner = null;
      const d = Math.hypot(v.x - eye.x, v.z - eye.z);
      this.step(v, dt, me, cars, d < near);
    }
    this.draw(eye);
  }

  /** The cars' speeds, from how far each moved since the last frame (the nearest one then). */
  private carSpeeds(cars: CarNear[], dt: number): void {
    this.carSpeed = cars.map((c) => {
      let best = Infinity;
      for (const p of this.prevCars) best = Math.min(best, Math.hypot(p.x - c.x, p.z - c.z));
      return best < 3 ? best / Math.max(dt, 1e-3) : 0;
    });
    this.prevCars = cars.map((c) => ({ x: c.x, z: c.z }));
  }

  private step(v: V, dt: number, me: Me | null, cars: CarNear[], near: boolean): void {
    const P = this.paths!;
    let moving = false;
    let pace = v.pace;
    // Something in the way ahead: the player, another villager; slow, step aside, stop.
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    let block = Infinity;
    let push = 0;
    const consider = (x: number, z: number, r: number) => {
      const dx = x - v.x;
      const dz = z - v.z;
      const along = dx * fx + dz * fz;
      const side = dx * fz - dz * fx; // + on its left
      const reach = v.bike ? 7 : 2.6;
      if (along > 0 && along < reach && Math.abs(side) < r + (v.bike ? 0.9 : 0.55)) {
        block = Math.min(block, along);
        push += (side >= 0 ? 1 : -1) * (1 - along / reach); // + steps to its right
      }
    };
    if (me && Math.abs(me.feet - v.y) < 2) consider(me.x, me.z, 0.35);
    if (v.mode === 'walk' || v.mode === 'ride' || v.mode === 'goto' || v.mode === 'hub') {
      for (const o of this.vs) {
        if (o === v || o.leader === v || v.leader === o || o.kind === DOG) continue;
        if (Math.abs(o.x - v.x) > 8 || Math.abs(o.z - v.z) > 8) continue;
        consider(o.x, o.z, o.bike ? 0.5 : 0.3);
      }
    }
    // A car coming at it: step out of its way, quickly.
    if (!v.leader && v.mode !== 'sit') {
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
    if (this.clock < v.dodgeUntil) {
      const sp = v.bike ? 2.5 : 2.6;
      this.move(v, v.dodgeX * sp * dt, v.dodgeZ * sp * dt, near);
      if (v.mode === 'walk' || v.mode === 'ride') {
        // Back on its way afterwards: its line where it now stands.
        const L = v.bike ? P.bikes[v.line] : P.walks[v.line];
        const c = closest(L, v.x, v.z);
        v.s = c.s;
        if (!v.bike) v.lat = v.latWant = Math.max(-1.2, Math.min(1.2, this.latOf(v, L)));
      }
      this.animate(v, dt, v.bike ? Math.max(1, v.speed) : 2.6, false);
      this.ground1(v, dt);
      return;
    }
    switch (v.mode) {
      case 'walk': {
        const L = P.walks[v.line];
        if (block < 0.9) pace = 0;
        else if (block < 2.6) pace *= 0.45;
        v.latWant = Math.max(-0.9, Math.min(1.1, v.latWant + push * dt * 1.6));
        if (block === Infinity) v.latWant += (Math.max(0.15, Math.min(0.45, v.latWant)) - v.latWant) * Math.min(1, dt * 0.5);
        v.lat += (v.latWant - v.lat) * Math.min(1, dt * 2.5);
        v.speed += (pace - v.speed) * Math.min(1, dt * 3);
        const s0 = v.s;
        v.s += v.dir * v.speed * dt;
        L.at(v.s, _at);
        const rx = -_at.dz * v.dir;
        const rz = _at.dx * v.dir;
        const tx = _at.x + rx * v.lat;
        const tz = _at.z + rz * v.lat;
        const before = Math.hypot(tx - v.x, tz - v.z);
        this.move(v, tx - v.x, tz - v.z, near);
        // A wall pushed it off its way: it slips round (the push goes into how far right it walks); stuck, it turns.
        const off = Math.hypot(tx - v.x, tz - v.z);
        if (off > 0.25 && before > 0) {
          v.lat = this.latOf(v, L);
          v.latWant = v.lat;
          v.stuck += dt;
        } else v.stuck = Math.max(0, v.stuck - dt);
        if (v.stuck > 1.5) {
          v.stuck = 0;
          v.dir = -v.dir;
          v.latWant = 0.3;
        }
        moving = v.speed > 0.1;
        const want = Math.atan2(_at.dx * v.dir, _at.dz * v.dir);
        v.yaw += wrapAngle(want - v.yaw) * Math.min(1, dt * 5);
        this.passPoints(v, s0, v.s);
        // Now and then it stops to look round.
        if (chance(dt / 45)) {
          v.mode = 'stand';
          v.timer = rand(2, 7);
        }
        break;
      }
      case 'wait': {
        // At the kerb: until no car comes, then across.
        v.speed = 0;
        v.yaw += wrapAngle(Math.atan2(v.tx - v.x, v.tz - v.z) - v.yaw) * Math.min(1, dt * 4);
        v.timer -= dt;
        if (this.clear(v.x, v.z, v.tx, v.tz, cars)) {
          v.mode = 'cross';
        } else if (v.timer <= 0) {
          v.next = null;
          v.mode = 'walk';
          v.dir = -v.dir;
        }
        break;
      }
      case 'cross':
      case 'goto': {
        const dx = v.tx - v.x;
        const dz = v.tz - v.z;
        const L = Math.hypot(dx, dz);
        const sp = v.mode === 'cross' ? pace * 1.2 : pace;
        if (block < 0.8 && v.mode === 'goto') v.speed = 0;
        else v.speed += (sp - v.speed) * Math.min(1, dt * 3);
        if (L < 0.3) {
          this.arrive(v);
          break;
        }
        const k = Math.min(L, v.speed * dt) / L;
        this.move(v, dx * k, dz * k, near);
        v.yaw += wrapAngle(Math.atan2(dx, dz) - v.yaw) * Math.min(1, dt * 6);
        moving = v.speed > 0.1;
        v.timer -= dt;
        if (v.timer < -40) this.leave(v); // never got there
        break;
      }
      case 'stand': {
        v.speed = 0;
        v.timer -= dt;
        // Face the one it talks to, or the player when close.
        let face = v.partner ? Math.atan2(v.partner.x - v.x, v.partner.z - v.z) : NaN;
        if (me) {
          const d = Math.hypot(me.x - v.x, me.z - v.z);
          if (d < (v.partner ? 3.5 : 7)) face = Math.atan2(me.x - v.x, me.z - v.z);
        }
        if (Number.isFinite(face)) v.yaw += wrapAngle(face - v.yaw) * Math.min(1, dt * 2);
        if (v.timer <= 0 && (!v.partner || v.partner.timer <= 0)) {
          if (v.partner) v.partner.partner = null;
          v.partner = null;
          if (v.line >= 0) {
            const L = P.walks[v.line];
            v.mode = 'walk';
            v.s = closest(L, v.x, v.z).s;
            v.lat = this.latOf(v, L);
          } else if (v.hub >= 0) v.mode = 'hub';
          else this.leave(v);
        }
        break;
      }
      case 'sit': {
        v.speed = 0;
        v.timer -= dt;
        const [sx, sz, face] = P.seats[v.seat];
        v.x = sx;
        v.z = sz;
        v.yaw = face;
        if (v.timer <= 0 || this.raining) {
          // Up, and off to the nearest walk.
          const w = P.nearestWalk(v.x, v.z, 25);
          if (!w) {
            this.leave(v);
            break;
          }
          P.walks[w.line].at(w.s, _at);
          v.mode = 'goto';
          v.seat = -1;
          v.tx = _at.x;
          v.tz = _at.z;
          v.next = { line: w.line, s: w.s, dir: chance(0.5) ? 1 : -1 };
          v.pace = v.kind === ELDER ? 0.85 : 1.2;
          v.timer = 0;
        }
        break;
      }
      case 'hub': {
        v.timer -= dt;
        const dx = v.tx - v.x;
        const dz = v.tz - v.z;
        const L = Math.hypot(dx, dz);
        if (v.once) v.speed = 0;
        else if (L > 0.3) {
          if (block < 0.8) v.speed = 0;
          else v.speed += (v.pace - v.speed) * Math.min(1, dt * 3);
          const k = Math.min(L, v.speed * dt) / L;
          this.move(v, dx * k, dz * k, near);
          v.yaw += wrapAngle(Math.atan2(dx, dz) - v.yaw) * Math.min(1, dt * 6);
          moving = v.speed > 0.1;
          if (v.timer < -30) {
            v.tx = v.x;
            v.tz = v.z;
          }
        } else {
          v.speed = 0;
          if (me && Math.hypot(me.x - v.x, me.z - v.z) < 7) v.yaw += wrapAngle(Math.atan2(me.x - v.x, me.z - v.z) - v.yaw) * Math.min(1, dt * 2);
          if (v.timer <= 0) this.nextHubSpot(v);
        }
        break;
      }
      case 'follow': {
        const l = v.leader;
        if (!l) break;
        const lfx = Math.sin(l.yaw);
        const lfz = Math.cos(l.yaw);
        // Its place beside or ahead of its leader (a dog ahead on its lead; a child at the side).
        const tx = l.x + lfx * v.ahead - lfz * v.side;
        const tz = l.z + lfz * v.ahead + lfx * v.side;
        const dx = tx - v.x;
        const dz = tz - v.z;
        const L = Math.hypot(dx, dz);
        const want = L > 0.05 ? Math.min(l.speed + L * 1.5, 3.2) : 0;
        v.speed += (want - v.speed) * Math.min(1, dt * 4);
        if (L > 6) {
          v.x = tx;
          v.z = tz;
        } else if (L > 0.02) {
          const k = Math.min(L, v.speed * dt) / L;
          this.move(v, dx * k, dz * k, near);
        }
        const face = l.speed > 0.15 || L > 0.3 ? Math.atan2(L > 0.3 ? dx : lfx, L > 0.3 ? dz : lfz) : l.mode === 'stand' && l.partner ? Math.atan2(l.partner.x - v.x, l.partner.z - v.z) : l.yaw;
        v.yaw += wrapAngle(face - v.yaw) * Math.min(1, dt * 5);
        moving = v.speed > 0.12;
        break;
      }
      case 'ride': {
        const L = P.bikes[v.line];
        if (block < 2.5) pace = 0;
        else if (block < 7) pace = Math.min(pace, 1.5 + block * 0.4);
        // A car ahead in its lane: keep behind it.
        for (const c of cars) {
          const dx = c.x - v.x;
          const dz = c.z - v.z;
          const along = dx * fx + dz * fz;
          if (along > 0 && along < 9 + c.length / 2 && Math.abs(dx * fz - dz * fx) < 1.6) pace = Math.min(pace, Math.max(0, (along - c.length / 2 - 2) * 0.8));
        }
        v.speed += (pace - v.speed) * Math.min(1, dt * (pace < v.speed ? 3 : 1));
        v.s += v.speed * dt;
        if (v.s >= L.length) {
          const next = P.bnext[v.line];
          if (!next?.length) {
            this.leave(v);
            v.s = L.length;
          } else {
            const [line, idx] = pick(next);
            v.line = line;
            v.s = P.bikes[line].s[Math.min(idx, P.bikes[line].count - 1)];
          }
        }
        const B = P.bikes[v.line];
        B.at(v.s, _at);
        const tx = _at.x;
        const tz = _at.z;
        // A turn onto another lane is a short swerve, not a jump.
        const jump = Math.hypot(tx - v.x, tz - v.z);
        if (jump > 4) this.move(v, (tx - v.x) * Math.min(1, dt * 2.5), (tz - v.z) * Math.min(1, dt * 2.5), near);
        else this.move(v, tx - v.x, tz - v.z, near);
        const want = jump > 1 ? Math.atan2(tx - v.x, tz - v.z) : Math.atan2(_at.dx, _at.dz);
        v.yaw += wrapAngle(want - v.yaw) * Math.min(1, dt * 4);
        moving = v.speed > 0.2;
        break;
      }
    }
    this.lookAndWave(v, me);
    this.animate(v, dt, v.speed, moving);
    this.ground1(v, dt);
  }

  /** How far to the right of its line (as it walks) a villager stands. */
  private latOf(v: V, L: Line): number {
    const c = closest(L, v.x, v.z);
    L.at(c.s, _bt);
    const rx = -_bt.dz * v.dir;
    const rz = _bt.dx * v.dir;
    return (v.x - _bt.x) * rx + (v.z - _bt.z) * rz;
  }

  /** Points of its line it passed this frame: a way off there may be taken; at an end it must, or it turns. */
  private passPoints(v: V, s0: number, s1: number): void {
    const P = this.paths!;
    const L = P.walks[v.line];
    const last = L.count - 1;
    let idxs: number[] = [];
    if (s1 >= L.length) idxs = [last];
    else if (s1 <= 0) idxs = [0];
    else {
      const a = L.seg(Math.min(s0, s1));
      const b = L.seg(Math.max(s0, s1));
      for (let i = a + 1; i <= b; i++) idxs.push(i);
    }
    for (const i of idxs) {
      const end = i === 0 || i === last;
      if (end && !((i === last && v.dir > 0) || (i === 0 && v.dir < 0))) continue;
      const links = P.linksAt(v.line, i).filter((l) => !(l.to * 65536 + l.idx === v.cameFrom && this.clock - v.cameAt < 20));
      if (links.length && (end || chance(links.some((l) => l.road) ? 0.18 : 0.3))) {
        const l = pick(links);
        this.takeLink(v, i, l);
        return;
      }
      if (end) {
        // A dead end: turn round, perhaps after a moment.
        v.dir = -v.dir;
        v.s = Math.max(0, Math.min(L.length, v.s));
        if (chance(0.5)) {
          v.mode = 'stand';
          v.timer = rand(1, 4);
        }
        return;
      }
    }
  }

  private takeLink(v: V, i: number, l: { to: number; idx: number; road: boolean }): void {
    const P = this.paths!;
    const B = P.walks[l.to];
    const idx = Math.min(l.idx, B.count - 1);
    v.tx = B.x[idx];
    v.tz = B.z[idx];
    v.road = l.road;
    // Which way on the new line: as straight on as it can, now and then the other way.
    const hx = Math.sin(v.yaw);
    const hz = Math.cos(v.yaw);
    B.at(B.s[idx], _bt);
    let dir = _bt.dx * hx + _bt.dz * hz >= 0 ? 1 : -1;
    if (chance(0.3)) dir = -dir;
    if (idx === 0) dir = 1;
    if (idx === B.count - 1) dir = -1;
    v.next = { line: l.to, s: B.s[idx], dir };
    v.cameFrom = v.line * 65536 + i;
    v.cameAt = this.clock;
    if (l.road) {
      v.mode = 'wait';
      v.timer = 25;
    } else {
      v.mode = 'goto';
      v.timer = 0;
    }
  }

  /** Arrived where it went: onto its next line, or a new spot on the square. */
  private arrive(v: V): void {
    if (v.next) {
      const n = v.next;
      v.next = null;
      this.onLine(v, n.line, n.s, n.dir);
      v.lat = 0;
      v.latWant = rand(0.15, 0.45);
      v.cameAt = this.clock;
      return;
    }
    if (v.hub >= 0) {
      v.mode = 'hub';
      v.timer = rand(2, 6);
    } else this.leave(v);
  }

  private nextHubSpot(v: V): void {
    const spots = this.hubSpots[v.hub];
    if (!spots?.length || chance(0.12)) {
      // Off the square: to the nearest walk, and on.
      const w = this.paths!.nearestWalk(v.x, v.z, 40);
      if (!w) {
        v.timer = rand(4, 10);
        return;
      }
      this.paths!.walks[w.line].at(w.s, _at);
      v.mode = 'goto';
      v.tx = _at.x;
      v.tz = _at.z;
      v.next = { line: w.line, s: w.s, dir: chance(0.5) ? 1 : -1 };
      v.hub = -1;
      return;
    }
    for (let tries = 0; tries < 5; tries++) {
      const [x, z] = pick(spots);
      const d = Math.hypot(x - v.x, z - v.z);
      if (d < 3 || d > 20) continue;
      if (this.world.blocked({ x: v.x, y: v.y + 0.6, z: v.z }, { x, y: v.y + 0.6, z }, 0.25)) continue;
      v.tx = x;
      v.tz = z;
      v.timer = rand(3, 14);
      return;
    }
    v.timer = rand(2, 6);
  }

  /** Whether the way across from (x, z) to (tx, tz) is clear of cars coming (none heading for it within 35 m, none right there). */
  private clear(x: number, z: number, tx: number, tz: number, cars: CarNear[]): boolean {
    const mx = (x + tx) / 2;
    const mz = (z + tz) / 2;
    return cars.every((c, i) => {
      const d = Math.hypot(c.x - mx, c.z - mz);
      if (d < 7) return false;
      if (d > 38) return true;
      const cfx = -Math.sin(c.yaw);
      const cfz = -Math.cos(c.yaw);
      const toward = ((mx - c.x) * cfx + (mz - c.z) * cfz) / d;
      return toward < 0.5 || (this.carSpeed[i] ?? 0) < 0.5;
    });
  }

  /** Move by (dx, dz), kept out of walls (near the player every frame, farther off every other). */
  private move(v: V, dx: number, dz: number, near: boolean): void {
    v.x += dx;
    v.z += dz;
    if (near || (this.clock * 60 + v.id) % 3 < 1) {
      const pos = { x: v.x, z: v.z };
      this.world.resolve(pos, v.y, v.bike ? 0.3 : 0.25, 0.45, 1.6);
      v.x = pos.x;
      v.z = pos.z;
    }
  }

  /** Its feet on the ground: looked up again every 25 cm, eased up and down a step. */
  private ground1(v: V, dt: number): void {
    if (v.mode === 'sit') {
      v.y = v.ground; // the seat's height (spawnSitter)
      return;
    }
    if (Math.hypot(v.x - v.gx, v.z - v.gz) > 0.25) {
      v.ground = this.ground(v.x, v.z, v.ground);
      v.gx = v.x;
      v.gz = v.z;
    }
    v.y = Math.abs(v.ground - v.y) > 1.2 ? v.ground : v.y + (v.ground - v.y) * Math.min(1, dt * 12);
  }

  /** Close to the player and looked at: it may wave (now and then, a child more often). */
  private lookAndWave(v: V, me: Me | null): void {
    if (!me || v.kind === DOG || v.bike || v.jog || v.mode === 'sit' || v.once || v.fade < 1) return;
    const d = Math.hypot(me.x - v.x, me.z - v.z);
    if (d > 9 || d < 1.5 || this.clock - v.waved < 60) return;
    v.waved = this.clock;
    if (!chance(v.kind === CHILD ? 0.55 : 0.3)) return;
    v.once = 'Wave';
    v.onceEnd = this.clock + 2.4;
    if (v.mode === 'walk' || v.mode === 'hub') {
      v.mode = 'stand';
      v.timer = 2.6;
    }
  }

  /** Which clip it plays and how far along, blending a change over BLEND. */
  private animate(v: V, dt: number, speed: number, moving: boolean): void {
    const k = this.kinds[v.kind];
    if (!k) return;
    if (v.once && this.clock > v.onceEnd) v.once = '';
    let want: string;
    if (v.kind === BIKE) want = 'Ride';
    else if (v.once && !moving) want = v.once;
    else if (v.mode === 'sit') want = 'Sit';
    else if (moving) {
      if (v.kind === DOG || v.kind === CHILD || v.kind === ELDER) want = v.kind === CHILD && speed > 2 ? 'Jog' : 'Walk';
      else if (v.jog) want = 'Jog';
      else if (v.flags & UMB) want = 'WalkUmb';
      else if (v.lead) want = 'WalkLead';
      else want = 'Walk';
    } else if (v.flags & UMB) want = 'WalkUmb';
    else if (v.kind === DOG && v.leader?.mode === 'stand' && v.leader.timer > 4) want = 'Sit';
    else if (v.partner && v.kind !== CHILD) want = 'Talk';
    else want = 'Idle';
    if (!k.clips.has(want)) want = k.clips.has('Idle') ? 'Idle' : 'Ride';
    if (want !== v.clip) {
      v.from = v.clip;
      v.fromTime = v.time;
      v.blend = 0;
      v.clip = want;
      if (want === 'Wave') v.time = 0;
    }
    const c = k.clips.get(v.clip);
    if (c?.dist) {
      // Walking and riding go at the pace of the ground covered, so the feet (and wheels) don't slide; standing still it holds.
      v.time += (speed * dt / (c.dist * v.scale)) * c.duration;
    } else v.time += dt;
    v.blend = Math.min(1, v.blend + dt / BLEND);
  }

  /** In the rain the umbrella is up (those who have one: the man, the woman, the teen walking). */
  private umbrellas(): void {
    const up = this.raining;
    for (const v of this.vs) {
      const can = (v.kind === MAN || v.kind === WOMAN || v.kind === TEEN) && !v.jog && !v.lead && v.mode !== 'sit';
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
    let patches = 0;
    const lead = this.leashes.geometry.attributes.position as THREE.BufferAttribute;
    let leads = 0;
    for (const v of this.vs) {
      const k = this.kinds[v.kind];
      if (!k) continue;
      const i = counts[v.kind]++;
      if (i >= MAX[v.kind]) continue;
      _m.compose(_v.set(v.x, v.y, v.z), _q.setFromAxisAngle(UP, v.yaw), _s.setScalar(v.scale));
      k.mesh.setMatrixAt(i, _m);
      const [a0, a1, af] = this.rows(k.clips.get(v.clip), v.time);
      let [rA, rB, mix] = [a0, a1, af];
      if (v.blend < 1 && v.from) {
        const [f0] = this.rows(k.clips.get(v.from), v.fromTime);
        [rA, rB, mix] = [f0, a0, v.blend];
      }
      k.anim.setXYZW(i, rA, rB, mix, v.pal);
      k.look.setXYZW(i, Math.min(v.fade, this.shown), v.flags, 0, 0);
      const d = Math.hypot(v.x - eye.x, v.z - eye.z);
      if (d < 60 && patches < 96) {
        const r = (v.kind === DOG ? 0.55 : v.kind === BIKE ? 0.9 : v.kind === CHILD ? 0.6 : 0.75) * v.scale * Math.min(1, Math.min(v.fade, this.shown) * 1.4);
        const ground = v.mode === 'sit' ? v.y - (this.paths!.seats[v.seat][3] - 0.45) : v.y;
        _m.compose(_v.set(v.x, ground + 0.03, v.z), _q.setFromAxisAngle(UP, v.yaw), _s.set(v.kind === BIKE ? r * 0.7 : r, 1, v.kind === BIKE ? r * 1.6 : r));
        this.patches.setMatrixAt(patches++, _m);
      }
      // The dog's lead: from the walker's right hand to the collar, sagging.
      if (v.kind === DOG && v.leader && leads < MAX[DOG] && Math.min(v.fade, this.shown) > 0.5) {
        const l = v.leader;
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
    this.kinds.forEach((k, kind) => {
      k.mesh.count = Math.min(MAX[kind], counts[kind]);
      k.mesh.visible = k.mesh.count > 0;
      if (!k.mesh.count) return;
      k.mesh.instanceMatrix.needsUpdate = true;
      k.anim.needsUpdate = true;
      k.look.needsUpdate = true;
      k.mesh.computeBoundingSphere();
    });
    this.patches.count = patches;
    this.patches.instanceMatrix.needsUpdate = true;
    this.leashes.geometry.setDrawRange(0, leads * 6);
    lead.needsUpdate = true;
  }
}
