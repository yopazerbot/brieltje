import * as THREE from 'three';
import { mood } from './mood';

/**
 * The cars' lights at night (world/mood.ts `night`, the ramp the street lamps follow, so they come on as it
 * darkens): a warm white glow at each headlight and a pool of their light on the road ahead, a red glow at each
 * tail light, brighter while the car brakes. For the Teslas (world/car.ts: while someone drives one) and the
 * traffic (world/traffic.ts); the cars parked on the drives stay dark. By day nothing shows.
 *
 * No real lights, as the street lamps (world/streetLights.ts): the glows are small squares turned to the eye,
 * added onto what is drawn, dimmer and smaller seen from the side and gone from behind (a headlight shines
 * forward); the pools flat shapes on the ground that brighten what is under them. Two draw calls for all the
 * cars, a few arithmetic steps a pixel and no texture. Each car takes a slot (reserve) and writes its lamps into
 * it every frame it shows them (show), or takes them out (hide).
 */

/** The most cars with their lights on at once: the Teslas (4 and 12 placed) and the traffic, with room to spare. */
const MAX = 48;
/** Headlights' warm white, the tail lights' red (linear, far under the half floats' end). */
const HEAD = new THREE.Color(1.0, 0.86, 0.66);
const TAIL = new THREE.Color(1.0, 0.05, 0.03);
/** A glow's size (m): the headlights', the tail lights'. */
const HEAD_SIZE = 0.7;
const TAIL_SIZE = 0.45;
/** How far a glow sits in front of its lamp (m), so the body round it doesn't cut it. */
const OUT = 0.14;
/** The pool of the headlights on the road: its width at the far end and its length ahead of the nose (m). */
const POOL_W = 7;
const POOL_L = 17;

/** Where a car's lamps are, on the car (its body: x right, y up, z back), and where its nose is (z). */
export interface LampSpots {
  head: [THREE.Vector3, THREE.Vector3];
  tail: [THREE.Vector3, THREE.Vector3];
  nose: number;
}

/** Spots for a car of this size until its model is in: lamps at the corners, `lift` m above the body's origin. */
export function boxSpots(length: number, width: number, lift = 0): LampSpots {
  const hl = length / 2;
  const x = width / 2 - 0.3;
  return {
    head: [new THREE.Vector3(-x, 0.7 - lift, -hl), new THREE.Vector3(x, 0.7 - lift, -hl)],
    tail: [new THREE.Vector3(-x, 0.9 - lift, hl), new THREE.Vector3(x, 0.9 - lift, hl)],
    nose: -hl - 0.05,
  };
}

/**
 * The two lamps of a pair (left, right) from the points of their parts: the middle of each side's outer end
 * (a light bar across the nose has its headlights at its ends). Null when a side has no points.
 */
export function lampPair(points: THREE.Vector3[]): [THREE.Vector3, THREE.Vector3] | null {
  const pair: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    const own = points.filter((p) => p.x * side > 0.05);
    if (!own.length) return null;
    const end = Math.max(...own.map((p) => Math.abs(p.x)));
    const outer = own.filter((p) => Math.abs(p.x) > end - 0.22);
    pair.push(outer.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(outer.length));
  }
  return pair as [THREE.Vector3, THREE.Vector3];
}

/** Every point of a geometry, through `matrix` when given. */
export function pointsOf(g: THREE.BufferGeometry, matrix?: THREE.Matrix4): THREE.Vector3[] {
  const pos = g.attributes.position;
  if (!pos) return [];
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i);
    out.push(matrix ? p.applyMatrix4(matrix) : p);
  }
  return out;
}

/** The lamps' spots from the points of the headlights and of the tail lights; `fallback` for a pair not found. */
export function spotsFrom(head: THREE.Vector3[], tail: THREE.Vector3[], fallback: LampSpots): LampSpots {
  const h = lampPair(head.filter((p) => p.z < 0)) ?? fallback.head;
  const t = lampPair(tail.filter((p) => p.z > 0)) ?? fallback.tail;
  return { head: h, tail: t, nose: Math.min(h[0].z, h[1].z) - 0.12 };
}

const glowVertex = /* glsl */ `
  attribute vec4 at;   // the lamp in the world, and the glow's size
  attribute vec3 aim;  // the way it shines
  attribute vec3 tint; // its colour times how bright
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    vUv = uv - 0.5;
    vec3 toEye = normalize(cameraPosition - at.xyz);
    float facing = smoothstep(-0.15, 0.65, dot(aim, toEye)); // full from ahead, faint from the side, none from behind
    vTint = tint * facing;
    float size = at.w * (0.35 + 0.65 * facing) * step(0.002, facing * max(tint.r, max(tint.g, tint.b)));
    vec4 centre = viewMatrix * vec4(at.xyz + aim * ${OUT.toFixed(2)}, 1.0);
    centre.xy += position.xy * size; // turned to the eye; nothing at all when it is off
    gl_Position = projectionMatrix * centre;
  }`;
const glowFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    float r = length(vUv) * 2.0;
    float glow = (exp(-r * r * 10.0) * 3.0 + exp(-r * r * 2.5) * 0.3) * (1.0 - smoothstep(0.6, 1.0, r)); // round, no square's edge
    gl_FragColor = vec4(vTint * glow, 1.0);
  }`;
const poolVertex = /* glsl */ `
  attribute float bright;
  varying vec2 vUv;
  varying float vBright;
  void main() {
    vUv = uv;
    vBright = bright;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;
const poolFragment = /* glsl */ `
  uniform vec3 color;
  varying vec2 vUv;
  varying float vBright;
  void main() {
    float t = vUv.y;                    // 0 at the nose, 1 at the far end
    float u = abs(vUv.x - 0.5) * 2.0;   // 0 in the middle, 1 at the sides
    float beam = 1.0 - smoothstep(0.45, 1.0, u / (0.3 + 0.7 * t)); // the beam widens ahead
    float pool = beam * smoothstep(0.0, 0.12, t) * pow(1.0 - t, 1.6);
    gl_FragColor = vec4(color * pool * vBright * 7.0, 1.0); // up to eight times as bright just ahead of the car
  }`;

class CarLights {
  readonly group = new THREE.Group();
  private at = new Float32Array(MAX * 4 * 4);
  private aim = new Float32Array(MAX * 4 * 3);
  private tint = new Float32Array(MAX * 4 * 3);
  private bright = new Float32Array(MAX);
  private glowGeo = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1) as unknown as THREE.InstancedBufferGeometry);
  private glows: THREE.Mesh;
  private pools: THREE.InstancedMesh;
  private attrs: THREE.InstancedBufferAttribute[];
  private free: number[] = [];
  private used = 0; // slots handed out (the high-water mark)
  private lit = new Set<number>();
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor() {
    this.group.name = 'car lights';
    this.group.visible = false;
    const at = new THREE.InstancedBufferAttribute(this.at, 4).setUsage(THREE.DynamicDrawUsage);
    const aim = new THREE.InstancedBufferAttribute(this.aim, 3).setUsage(THREE.DynamicDrawUsage);
    const tint = new THREE.InstancedBufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage);
    this.glowGeo.setAttribute('at', at).setAttribute('aim', aim).setAttribute('tint', tint);
    this.glowGeo.instanceCount = 0;
    this.glows = new THREE.Mesh(this.glowGeo, new THREE.ShaderMaterial({
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }));
    // The pool brightens what is drawn there by a factor (what is there times one plus the pool), as the street
    // lamps' do: the road's own colour, only lit.
    const poolGeo = new THREE.PlaneGeometry(POOL_W, POOL_L).rotateX(-Math.PI / 2).translate(0, 0, -POOL_L / 2);
    const bright = new THREE.InstancedBufferAttribute(this.bright, 1).setUsage(THREE.DynamicDrawUsage);
    poolGeo.setAttribute('bright', bright);
    this.pools = new THREE.InstancedMesh(poolGeo, new THREE.ShaderMaterial({
      uniforms: { color: { value: HEAD.clone() } },
      vertexShader: poolVertex,
      fragmentShader: poolFragment,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }), MAX);
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pools.count = 0;
    this.attrs = [at, aim, tint, bright];
    for (const mesh of [this.pools, this.glows]) {
      mesh.frustumCulled = false; // spread over the map
      mesh.raycast = () => {}; // never in the way of a shot
      mesh.userData.noAO = true;
      mesh.renderOrder = 60;
      this.group.add(mesh);
    }
  }

  /** How far night has come, 0 by day to 1 at night: the street lamps' ramp. */
  get night(): number {
    return mood.night;
  }

  /** A slot for one car's lights (-1 when all are taken: that car stays dark). */
  reserve(): number {
    const k = this.free.pop() ?? (this.used < MAX ? this.used++ : -1);
    if (k >= 0) this.hide(k);
    return k;
  }

  /** A car taken away: its slot is free again. */
  release(k: number): void {
    if (k < 0) return;
    this.hide(k);
    this.free.push(k);
  }

  /**
   * One car's lights this frame: its lamps (`spots`, on its `body`, a matrix to the world), the headlights
   * `head` and the tail lights `tail` bright (0 to 1), and the pool on the ground in `ground`'s frame (the car on
   * the road: y up from the ground under it, the nose to -z).
   */
  show(k: number, body: THREE.Matrix4, ground: THREE.Matrix4, spots: LampSpots, head: number, tail: number): void {
    if (k < 0) return;
    const forward = this.d.set(0, 0, -1).transformDirection(body);
    for (let i = 0; i < 4; i++) {
      const isHead = i < 2;
      const p = this.v.copy(isHead ? spots.head[i] : spots.tail[i - 2]).applyMatrix4(body);
      const j = k * 4 + i;
      this.at.set([p.x, p.y, p.z, isHead ? HEAD_SIZE : TAIL_SIZE], j * 4);
      const s = isHead ? 1 : -1;
      this.aim.set([forward.x * s, forward.y * s, forward.z * s], j * 3);
      const c = isHead ? HEAD : TAIL;
      const b = isHead ? head : tail;
      this.tint.set([c.r * b, c.g * b, c.b * b], j * 3);
    }
    this.bright[k] = head;
    this.pools.setMatrixAt(k, head > 0.01 ? this.m.makeTranslation(0, 0.05, spots.nose).premultiply(ground) : this.zero);
    this.lit.add(k);
    this.changed();
  }

  /** A car's lights off (by day, out of sight, nobody at the wheel). */
  hide(k: number): void {
    if (k < 0) return;
    const was = this.lit.delete(k);
    this.tint.fill(0, k * 12, k * 12 + 12);
    this.bright[k] = 0;
    this.pools.setMatrixAt(k, this.zero);
    if (was || this.used === k + 1) this.changed();
  }

  private changed(): void {
    for (const a of this.attrs) a.needsUpdate = true;
    this.pools.instanceMatrix.needsUpdate = true;
    this.glowGeo.instanceCount = this.used * 4;
    this.pools.count = this.used;
    this.group.visible = this.lit.size > 0;
  }
}

/** Every car's lights, in one place: main.ts adds `carLights.group` to the scene. */
export const carLights = new CarLights();

/**
 * A Tesla's lights (world/car.ts): on at night while someone drives it, fading in over a moment; its own light
 * bar (brighter and warmer then), its tail lights' brightness, and its glows and pool (carLights).
 */
export class CarLamps {
  private slot = carLights.reserve();
  private on = 0;
  private spots: LampSpots;
  private dayBar: THREE.Color;

  /** `bar`: this car's own copy of the light bar's material (car.ts gives it to the model). */
  constructor(readonly bar: THREE.MeshStandardMaterial, length: number, width: number, lift: number) {
    this.spots = boxSpots(length, width, lift);
    this.dayBar = bar.emissive.clone();
  }

  /** The lamps' spots from the model (its scene, its world matrices up to date), `dy` from the scene to the body. */
  find(scene: THREE.Object3D, dy: number): void {
    const head: THREE.Vector3[] = [];
    const tail: THREE.Vector3[] = [];
    const shift = new THREE.Matrix4().makeTranslation(0, dy, 0);
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const part = o.userData.part;
      if (part === 'LightBar') head.push(...pointsOf(o.geometry, shift.clone().multiply(o.matrixWorld)));
      if (part === 'TailLight') tail.push(...pointsOf(o.geometry, shift.clone().multiply(o.matrixWorld)));
    });
    this.spots = spotsFrom(head, tail, this.spots);
  }

  /**
   * Every frame: `shown` it is drawn, `lit` someone drives it, `braking`; `tail` its tail lights' material,
   * `body` and `ground` the car's body and the car on the ground (their world matrices are brought up to date).
   */
  update(dt: number, shown: boolean, lit: boolean, braking: boolean, tail: THREE.MeshStandardMaterial, body: THREE.Object3D, ground: THREE.Object3D): void {
    this.on += ((lit ? 1 : 0) - this.on) * (1 - Math.exp(-dt * 8));
    const k = carLights.night * this.on;
    tail.emissiveIntensity = braking ? 2.5 + 0.5 * k : 0.5 + 1.1 * k; // by day as before: 2.5 braking, else 0.5
    this.bar.emissiveIntensity = 2 + 3 * k;
    this.bar.emissive.copy(this.dayBar).lerp(HEAD, k);
    if (!shown || k < 0.01) {
      carLights.hide(this.slot);
      return;
    }
    body.updateWorldMatrix(true, false);
    ground.updateWorldMatrix(true, false);
    carLights.show(this.slot, body.matrixWorld, ground.matrixWorld, this.spots, k, k * (braking ? 1 : 0.4));
  }

  dispose(): void {
    carLights.release(this.slot);
    this.slot = -1;
    this.bar.dispose();
  }
}
