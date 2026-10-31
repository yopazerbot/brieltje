import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sound } from '../sound';
import { awake } from './fieldBirds';
import { terrain } from './terrain';

/**
 * Cows and sheep in the meadows round the house (our own models, tools/cattle.py; where they
 * graze: tools/countryside.py). Each animal goes round its own loop of spots in its pasture on
 * the shared clock, like the horses, so every player sees it in the same place without anything
 * being sent: at a spot it grazes, its head down, edging forward a few steps, or lies down to
 * chew the cud; then it walks on to the next spot.
 *
 * All cows are one instanced mesh and all sheep another: the processor only works out where each
 * animal is and what it does (a few numbers each, every frame) and packs the ones in view at the
 * front, so only they are drawn (and nothing at all when none is); the vertex shader turns their
 * legs, neck, head and tail and lowers them to the ground. The coat is worked out per pixel from the
 * animal's own number: black and white or red and white patches, the blue roan of a Belgian Blue,
 * a cream fleece with a black or a white face. A soft shadow lies under each (not on Low and on
 * phones, which also draw them less far). They moo and bleat now and then when you are near.
 */

type Spot = [number, number, 'graze' | 'lie', number];
export interface HerdSpec {
  kind: 'cow' | 'sheep';
  coat: string;
  speed: number;
  animals: { spots: Spot[]; shift: number; size: number }[];
}

const COATS: Record<string, number> = { holstein: 0, red: 1, blue: 2, white: 3, suffolk: 4 };
const PARTS = ['Body', 'Neck', 'Head', 'Leg_FL', 'Leg_FR', 'Leg_BL', 'Leg_BR', 'Tail'];
/** Per kind: stride (m), how far it lowers lying down (m), neck and head angles grazing (rad), its shadow (m), its block (half length, half width, height). */
const KINDS = {
  cow: { stride: 1.5, drop: 0.6, neck: 1.2, head: -0.45, shadow: [1.25, 2.6], creep: 2.5, block: [1.15, 0.36, 1.5] },
  sheep: { stride: 0.8, drop: 0.36, neck: 1.0, head: -0.25, shadow: [0.75, 1.3], creep: 1.5, block: [0.62, 0.26, 0.85] },
};
const BLEND = 2.5; // s to lower the head, or to lie down and get up

/** Where an animal is at time t, which way it faces, and how much it walks, grazes and lies. */
function onLoop(spots: Spot[], speed: number, creep: number, t: number): { x: number; z: number; heading: number; pace: number; graze: number; lie: number } {
  let cycle = 0;
  for (let k = 0; k < spots.length; k++) {
    const [x0, z0, , secs] = spots[k];
    const [x1, z1] = spots[(k + 1) % spots.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    cycle += secs + (len - Math.min(creep, len * 0.5)) / speed;
  }
  let u = ((t % cycle) + cycle) % cycle;
  for (let k = 0; k < spots.length; k++) {
    const [x0, z0, what, secs] = spots[k];
    const [x1, z1] = spots[(k + 1) % spots.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const heading = Math.atan2(x1 - x0, z1 - z0);
    const reach = Math.min(creep, len * 0.5); // grazing, it edges this far along the way to the next spot
    const at = (d: number) => ({ x: x0 + ((x1 - x0) * d) / Math.max(len, 1e-3), z: z0 + ((z1 - z0) * d) / Math.max(len, 1e-3) });
    if (u < secs) {
      const ease = Math.min(1, u / BLEND, (secs - u) / BLEND);
      if (what === 'lie') return { ...at(0), heading, pace: 0, graze: 0, lie: ease };
      return { ...at((u / secs) * reach), heading, pace: reach / secs, graze: ease, lie: 0 };
    }
    u -= secs;
    const walk = Math.max(0, len - reach) / speed;
    if (u < walk) return { ...at(reach + u * speed), heading, pace: speed, graze: 0, lie: 0 };
    u -= walk;
  }
  return { x: spots[0][0], z: spots[0][1], heading: 0, pace: 0, graze: 0, lie: 0 };
}

/** The vertex and fragment additions: parts turned about their joints, the coat per pixel. */
function animalMaterial(kind: 'cow' | 'sheep', pivots: Record<string, THREE.Vector3>, time: { value: number }): THREE.MeshStandardMaterial {
  const k = KINDS[kind];
  const v = (p: THREE.Vector3) => `vec3(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.herdTime = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float part;
        attribute vec4 anim; // stride phase, walking (0..1), grazing (0..1), lying (0..1)
        attribute vec4 look; // its own number, the coat
        uniform float herdTime;
        varying vec3 vCoatPos;
        varying vec2 vLook;
        mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
        mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
        mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        // Each part: transformed = M (position - P) + T.
        mat3 pM = mat3(1.0);
        vec3 pP = vec3(0.0);
        vec3 pT = vec3(0.0);
        float seed = look.x;
        float phase = anim.x, walking = anim.y, grazing = anim.z, lying = anim.w;
        int pid = int(part + 0.5);
        if (pid == 1 || pid == 2) {
          // Neck and head: down to the grass while grazing, sweeping from side to side; a nod as it walks.
          float sweep = sin(herdTime * 0.33 + seed * 20.0) * 0.28 * grazing + sin(herdTime * 0.21 + seed * 7.0) * 0.35 * lying;
          float nod = walking * sin(phase * 2.0) * 0.05 + grazing * sin(herdTime * 2.7 + seed * 5.0) * 0.03;
          mat3 neck = rotY(sweep) * rotX(grazing * ${k.neck.toFixed(3)} + nod - lying * 0.15);
          vec3 pn = ${v(pivots.Neck)};
          if (pid == 1) { pM = neck; pP = pn; pT = pn; }
          else {
            vec3 ph = ${v(pivots.Head)};
            pM = neck * rotX(grazing * ${k.head.toFixed(3)});
            pP = ph;
            pT = neck * (ph - pn) + pn;
          }
        } else if (pid >= 3 && pid <= 6) {
          // Legs: a four-beat walk; folded under the body lying down.
          vec3 pl = pid == 3 ? ${v(pivots.Leg_FL)} : pid == 4 ? ${v(pivots.Leg_FR)} : pid == 5 ? ${v(pivots.Leg_BL)} : ${v(pivots.Leg_BR)};
          float beat = pid == 3 ? 0.25 : pid == 4 ? 0.75 : pid == 5 ? 0.0 : 0.5;
          float swing = walking * 0.32 * sin(phase + beat * 6.2832);
          pM = rotX(swing) * mat3(1.0, 0.0, 0.0, 0.0, 1.0 - lying * 0.8, 0.0, 0.0, 0.0, 1.0);
          pP = pl;
          pT = pl;
        } else if (pid == 7) {
          // The tail: hangs, with a swish now and then.
          vec3 pt = ${v(pivots.Tail)};
          float swish = smoothstep(0.55, 0.9, sin(herdTime * 0.29 + seed * 11.0));
          pM = rotZ(sin(herdTime * 2.1 + seed * 3.0) * (0.06 + 0.35 * swish)) * rotX(0.05 * sin(herdTime * 1.3 + seed));
          pP = pt;
          pT = pt;
        }
        pT.y -= lying * ${k.drop.toFixed(3)};
        objectNormal = normalize(pM * objectNormal);`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = pM * (position - pP) + pT;
        vCoatPos = position;
        vLook = look.xy;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCoatPos;
        varying vec2 vLook;
        float herdHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float herdNoise(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(herdHash(i), herdHash(i + vec3(1, 0, 0)), f.x), mix(herdHash(i + vec3(0, 1, 0)), herdHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(herdHash(i + vec3(0, 0, 1)), herdHash(i + vec3(1, 0, 1)), f.x), mix(herdHash(i + vec3(0, 1, 1)), herdHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float isCoat = step(2.96, vColor.r + vColor.g + vColor.b);
        float isFace = step(0.97, vColor.r) * step(vColor.g, 0.03) * step(0.97, vColor.b);
        if (isCoat + isFace > 0.5) {
          vec3 p = vCoatPos + vLook.x * 37.0;
          float coat = vLook.y;
          vec3 c;
          if (coat < 1.5) {
            // Black and white or red and white: big patches with ragged edges.
            float n = herdNoise(p * 2.3) * 0.7 + herdNoise(p * 6.0) * 0.3;
            float dark = smoothstep(0.5, 0.54, n + (vLook.x - 0.5) * 0.25);
            c = mix(vec3(0.82, 0.81, 0.78), coat < 0.5 ? vec3(0.025, 0.022, 0.02) : vec3(0.3, 0.09, 0.035), dark);
          } else if (coat < 2.5) {
            // A Belgian Blue: white mottled with blue-grey, some mostly blue.
            float n = herdNoise(p * 3.1) * 0.6 + herdNoise(p * 14.0) * 0.4;
            float blue = smoothstep(0.35, 0.75, n + (vLook.x - 0.45) * 0.6);
            c = mix(vec3(0.78, 0.78, 0.76), vec3(0.15, 0.17, 0.2), blue);
          } else {
            // Sheep: a cream fleece, darker with the weather in its folds; a white or a black face.
            float n = herdNoise(p * 9.0);
            c = isFace > 0.5 ? (coat < 3.5 ? vec3(0.72, 0.66, 0.56) : vec3(0.03, 0.028, 0.026)) : vec3(0.7, 0.64, 0.52) * (0.85 + 0.2 * n);
          }
          diffuseColor.rgb = c;
        }`,
      );
  };
  mat.customProgramCacheKey = () => `herd-${kind}`;
  return mat;
}

/** A soft round shadow, drawn once on a canvas. */
function shadowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

interface Kind {
  mesh: THREE.InstancedMesh;
  animals: { herd: HerdSpec; spots: Spot[]; shift: number; size: number; seed: number; phase: number; x: number; z: number; y: number }[];
  anim: THREE.InstancedBufferAttribute;
  look: THREE.InstancedBufferAttribute;
}

/** A moo, made in code: a low buzz through a mouth that opens and closes. */
function moo(at: THREE.Vector3): void {
  if (!awake()) return;
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 1.2, at.z, 6);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const len = 1.2 + Math.random() * 0.6;
  const f0 = 95 + Math.random() * 35;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(f0 * 0.9, t);
  o.frequency.linearRampToValueAtTime(f0 * 1.15, t + len * 0.3);
  o.frequency.linearRampToValueAtTime(f0 * 0.85, t + len);
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.5;
  const vibGain = ctx.createGain();
  vibGain.gain.value = f0 * 0.02;
  vib.connect(vibGain).connect(o.frequency);
  const mouth = ctx.createBiquadFilter();
  mouth.type = 'lowpass';
  mouth.Q.value = 6;
  mouth.frequency.setValueAtTime(260, t);
  mouth.frequency.linearRampToValueAtTime(820, t + len * 0.35);
  mouth.frequency.linearRampToValueAtTime(380, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.18);
  g.gain.setValueAtTime(0.5, t + len - 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(mouth).connect(g).connect(dest);
  o.start(t);
  vib.start(t);
  o.stop(t + len + 0.05);
  vib.stop(t + len + 0.05);
}

/** A bleat, made in code: a reedy tone that wavers. */
function baa(at: THREE.Vector3): void {
  if (!awake()) return;
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 0.6, at.z, 3);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const len = 0.6 + Math.random() * 0.3;
  const f0 = 330 + Math.random() * 120;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.linearRampToValueAtTime(f0 * 0.88, t + len);
  const shake = ctx.createOscillator();
  shake.frequency.value = 22 + Math.random() * 6;
  const shakeGain = ctx.createGain();
  shakeGain.gain.value = 0.35;
  const g = ctx.createGain();
  g.gain.value = 0;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(0.32, t + 0.06);
  env.gain.exponentialRampToValueAtTime(0.0001, t + len);
  shake.connect(shakeGain).connect(g.gain);
  g.gain.setValueAtTime(0.65, t);
  const voice = ctx.createBiquadFilter();
  voice.type = 'bandpass';
  voice.Q.value = 2.5;
  voice.frequency.setValueAtTime(1100, t);
  voice.frequency.linearRampToValueAtTime(800, t + len);
  o.connect(voice).connect(g).connect(env).connect(dest);
  o.start(t);
  shake.start(t);
  o.stop(t + len + 0.05);
  shake.stop(t + len + 0.05);
}

/** How far off an animal is still drawn (m): beyond it, a few pixels in the haze. Its shadow less far. */
const DRAWN = { cow: 420, sheep: 300 };
const SHADOWED = 220;
/** On Low and on phones: nearer, and no shadows. */
const DRAWN_LOW = { cow: 300, sheep: 200 };

export class Herds {
  readonly group = new THREE.Group();
  private kinds: Kind[] = [];
  /** One soft shadow mesh for both kinds. */
  private shadows: THREE.InstancedMesh | null = null;
  private time = { value: 0 };
  private box = new THREE.Box3();
  private voiceIn = 4;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private sphere = new THREE.Sphere();
  /** The animals near you that are blocks to walk into (by key). */
  private blocking = new Set<string>();
  /** Low or a phone: drawn less far, no shadows. */
  low = false;

  /**
   * `now`: the shared clock in seconds; `solid`: sets or clears a moving block (the world's), for
   * the animals near you.
   */
  constructor(herds: HerdSpec[], private ground: number, private now: () => number, private solid: (key: string, ring: [number, number][] | null, y0: number, y1: number) => void) {
    for (const h of herds) for (const a of h.animals) for (const [x, z] of a.spots) this.box.expandByPoint(new THREE.Vector3(x, ground + terrain.height(x, z), z));
    this.box.expandByScalar(5);
    void new GLTFLoader().loadAsync('/models/cattle.glb').then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      for (const kind of ['cow', 'sheep'] as const) this.build(kind, herds.filter((h) => h.kind === kind), gltf.scene);
      const count = this.kinds.reduce((n, k) => n + k.animals.length, 0);
      const shadowMat = new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: shadowTexture(), transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      this.shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat, Math.max(1, count));
      this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.shadows.frustumCulled = false;
      this.shadows.raycast = () => {};
      this.shadows.renderOrder = 2;
      this.group.add(this.shadows);
    }, () => {});
  }

  /** One kind's parts merged into one shape (a part number on every vertex), drawn once per animal. */
  private build(kind: 'cow' | 'sheep', herds: HerdSpec[], scene: THREE.Object3D): void {
    const animals = herds.flatMap((herd) => herd.animals.map((a, i) => ({ herd, ...a, seed: (Math.abs(Math.sin(a.shift * 12.9898 + i * 78.233)) * 43758.5453) % 1, phase: 0, x: 0, z: 0, y: 0 })));
    if (!animals.length) return;
    const pieces: THREE.BufferGeometry[] = [];
    const pivots: Record<string, THREE.Vector3> = {};
    const prefix = kind === 'cow' ? 'Cow_' : 'Sheep_';
    PARTS.forEach((name, id) => {
      const mesh = scene.getObjectByName(prefix + name) as THREE.Mesh | undefined;
      if (!mesh) return;
      pivots[name] = mesh.getWorldPosition(new THREE.Vector3());
      const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      g.setAttribute('part', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(id), 1));
      for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'part'].includes(a)) g.deleteAttribute(a);
      pieces.push(g.index ? g.toNonIndexed() : g);
    });
    const geometry = mergeGeometries(pieces);
    pieces.forEach((g) => g.dispose());
    const mesh = new THREE.InstancedMesh(geometry, animalMaterial(kind, pivots, this.time), animals.length);
    // Only the animals in view are drawn, packed at the front each frame: their state, their number and coat.
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(animals.length * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const look = new THREE.InstancedBufferAttribute(new Float32Array(animals.length * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('anim', anim);
    geometry.setAttribute('look', look);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // culled per animal below
    mesh.count = 0;
    mesh.userData.ignoreRay = true;
    mesh.raycast = () => {};
    this.group.add(mesh);
    this.kinds.push({ mesh, animals, anim, look });
  }

  /**
   * Every frame: where each animal is and what it does. Only the ones in view and within reach are
   * drawn (none at all when none is: no draw call). `eye`: where you look from; `frustum`: what you
   * see; `far`: the draw distance.
   */
  update(dt: number, eye: THREE.Vector3, frustum: THREE.Frustum, far: number): void {
    const seen = this.box.distanceToPoint(eye) < far;
    this.group.visible = seen;
    if (!seen || !this.kinds.length) return;
    const now = this.now();
    this.time.value = now;
    const near = { d: 70, kind: -1, i: -1 }; // the nearest animal within earshot
    let shadowed = 0;
    this.kinds.forEach((kind, ki) => {
      const what = kind.animals[0].herd.kind;
      const spec = KINDS[what];
      const anim = kind.anim.array as Float32Array;
      const look = kind.look.array as Float32Array;
      let drawn = 0;
      kind.animals.forEach((a, i) => {
        const s = onLoop(a.spots, a.herd.speed, spec.creep, now + a.shift);
        a.phase += (s.pace / spec.stride) * Math.PI * 2 * dt;
        a.x = s.x;
        a.z = s.z;
        a.y = this.ground + terrain.height(s.x, s.z);
        const d = Math.hypot(a.x - eye.x, a.z - eye.z);
        if (d < near.d) Object.assign(near, { d, kind: ki, i });
        // Within 25 m of you it is a block you can't walk through (lower lying down).
        const key = `herd-${ki}-${i}`;
        if (d < 25) {
          const [hl, hw, h] = spec.block;
          const fx = Math.sin(s.heading) * a.size;
          const fz = Math.cos(s.heading) * a.size;
          const ring: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [a.x + fx * u * hl + fz * v * hw, a.z + fz * u * hl - fx * v * hw]);
          this.solid(key, ring, a.y, a.y + h * (1 - s.lie * 0.4));
          this.blocking.add(key);
        } else if (this.blocking.delete(key)) this.solid(key, null, 0, 0);
        if (d > (this.low ? DRAWN_LOW : DRAWN)[what] || !frustum.intersectsSphere(this.sphere.set(this.p.set(a.x, a.y + 0.8, a.z), 2.5))) return;
        this.q.setFromAxisAngle(this.up, s.heading);
        this.m.compose(this.p.set(a.x, a.y, a.z), this.q, this.s.setScalar(a.size));
        kind.mesh.setMatrixAt(drawn, this.m);
        anim.set([a.phase, Math.min(1, s.pace / Math.max(0.01, a.herd.speed) * 1.6), s.graze, s.lie], drawn * 4);
        look.set([a.seed, COATS[a.herd.coat] ?? 0, 0, 0], drawn * 4);
        drawn++;
        if (this.shadows && !this.low && d < SHADOWED) {
          const [w, l] = spec.shadow;
          this.m.compose(this.p.set(a.x, a.y + 0.04, a.z), this.q, this.s.set(w * a.size * (1 + s.lie * 0.15), 1, l * a.size));
          this.shadows.setMatrixAt(shadowed++, this.m);
        }
      });
      kind.mesh.count = drawn;
      kind.mesh.visible = drawn > 0;
      if (drawn) {
        kind.mesh.instanceMatrix.clearUpdateRanges();
        kind.mesh.instanceMatrix.addUpdateRange(0, drawn * 16);
        kind.mesh.instanceMatrix.needsUpdate = true;
        for (const attr of [kind.anim, kind.look]) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, drawn * 4);
          attr.needsUpdate = true;
        }
      }
    });
    if (this.shadows) {
      this.shadows.count = shadowed;
      this.shadows.visible = shadowed > 0;
      this.shadows.instanceMatrix.clearUpdateRanges();
      this.shadows.instanceMatrix.addUpdateRange(0, shadowed * 16);
      this.shadows.instanceMatrix.needsUpdate = true;
    }
    // Now and then the nearest one calls.
    this.voiceIn -= dt;
    if (this.voiceIn <= 0) {
      this.voiceIn = 9 + Math.random() * 22;
      const a = this.kinds[near.kind]?.animals[near.i];
      if (a) (a.herd.kind === 'cow' ? moo : baa)(new THREE.Vector3(a.x, a.y, a.z));
    }
  }
}