import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import BIKES from '../../shared/bike.json';
import type { BikeSample } from '../../shared/wire.mjs';
import { netClock, Track } from '../net/track';
import { SEAT_HIP, type Body, type Pose } from '../net/swat';
import type { Seat } from '../net/avatars';
import type { Obstacle } from './car';
import type { Point, World } from './collision';
import { BikeSound, ringBell } from './bikeSound';

/**
 * Bikes you can ride (shared/bike.json): one against the side wall of the main house, one at the
 * bungalow, and a few in racks by the portals in the village (the church, the school, Molenhoek
 * and the Sparrenhof). You get on with the Use key next to one and ride with the camera close
 * behind you: W (or R2, or the stick forward) pedals up to 25 km/h, a little faster downhill and
 * slower uphill (the relief, world/terrain.ts, under the two wheels), S brakes and, standing,
 * walks it back; A and D steer and the bike leans into the turn. The jump key rings the bell. It
 * stops against walls, hedges, trees and people like a car, but it is narrow: it goes through
 * gates and along paths. Nobody gets hurt by it. Use again gets you off on the left; it stays on
 * its stand where you leave it.
 *
 * In multiplayer the server keeps who rides which bike (game.mjs): your position updates are the
 * bike's, and the others draw it from the server's ticks a little behind (net/track.ts), working
 * out from how it moves how it leans, steers, rolls and is pedalled, with your figure on it
 * pedalling (net/swat.ts). Like a car, a bike keeps you out of the fighting.
 *
 * The model is our own (tools/bike.py, web/public/models/bike.glb), its moving parts apart: the
 * frame, the fork and bars (turning about the steering axis), the wheels, the crank, the pedals
 * (kept level) and the stand. Every bike's part is one instance of one mesh, painted per vertex
 * (the paint tinted per bike), so all the bikes together are ten draws.
 */

export interface BikeState {
  /** Which bike (shared/bike.json) */
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Who rides it, or null */
  rider: string | null;
}

export interface PedalInput {
  /** 0..1: pedalling */
  throttle: number;
  /** 0..1: braking, then walking it back */
  brake: number;
  /** -1 left .. 1 right */
  steer: number;
}

type Spec = (typeof BIKES.bikes)[keyof typeof BIKES.bikes];

const G = 9.81;
const WB = 1.12; // m between the axles (tools/bike.py)
const WHEEL_R = 0.349; // m: 28 inch, 40 mm tyres
const GEAR = 2.6; // wheel turns per turn of the cranks (a city bike's middle gear)
const PEDAL = BIKES.pedalSpeed; // m/s: pedalling adds nothing past 25 km/h
const MAX = BIKES.maxSpeed; // m/s: the most at all, downhill
const BACK = 1; // m/s: walking it back
const ACCEL = 2.2; // m/s2 the most pedalling gives, pulling away
const POWER = 450; // W a rider puts in, briskly: 25 km/h in about six seconds
const MASS = 95; // kg, rider and bike
const ROLL = 0.05; // m/s2: the tyres' rolling resistance
const DRAG = 0.0035; // 1/m: the air, times v squared
const BRAKE = 4.5; // m/s2 at full brake
const STEER = 0.6; // rad: the bars at full lock (less at speed, see step)
const TURN_SLOW = 1.4; // rad/s: walking it round, standing
const LEAN_MAX = 0.55; // rad
const PARK_LEAN = -0.09; // rad: on its stand, leaning a little to the left
// The stand's leg from its pivot, down and out to the left (tools/bike.py stand(), in the GLB's axes), and folded up
// back along the chainstay: riding, it turns from the one to the other.
const STAND_DOWN = new THREE.Vector3(-0.15, -0.285, 0.05).normalize();
const STAND_UP = new THREE.Vector3(-0.035, 0.03, 0.3).normalize();
const FOLD = new THREE.Quaternion().setFromUnitVectors(STAND_DOWN, STAND_UP);
const NO_TURN = new THREE.Quaternion();
const CLEAR = 0.2; // m: kerbs and steps lower than this it rides over
const RIDER_H = 1.75; // m: the box it fills with its rider
const HALF_L = BIKES.length / 2;
const HALF_W = BIKES.width / 2;
const DRAW = 160; // m from the eye: further off a bike isn't drawn
const SPIN_STEP = 0.3; // rad: the most a wheel turns per frame on screen (faster, the spokes seem to stand)
const CAM_PITCH = 0.24;
/** Ground the tyres sound rougher on: grass, earth, gravel. */
const ROUGH = /grass|lawn|meadow|field|earth|soil|mud|gravel|sand|hedge|leaves|moss|forest|Garden/i;
/** The player's system asks for less motion: no camera roll. */
const CALM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const PARTS = ['FramePaint', 'Frame', 'ForkPaint', 'Steer', 'WheelF', 'WheelR', 'Crank', 'PedalL', 'PedalR', 'Stand'] as const;
type Part = (typeof PARTS)[number];

const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/**
 * The speed pedalling keeps up on a `slope` (rise per metre, + uphill): 25 km/h on the flat, a tenth
 * less up a 1.2 % rise (the gentle roads between the church and Molenhoek), a tenth more down it;
 * at most a third less or more. The rider's effort stays the same; the hill changes what it buys.
 */
export function pedalCap(slope: number): number {
  return PEDAL * (1 - clamp(slope * 8, -0.3, 0.35));
}

/** The model's parts, each in its own space with the game's colours on its points, and where each sits on the bike. */
interface Rig {
  geometry: Record<Part, THREE.BufferGeometry>;
  rest: Record<Part, THREE.Matrix4>;
  /** The steering's rest matrix inverted: what turns with the bars is turned about the axis */
  steerInv: THREE.Matrix4;
  saddle: THREE.Vector3;
  grips: [THREE.Vector3, THREE.Vector3];
  bb: THREE.Vector3;
}

/** A part's meshes in one geometry, in the part's own space, each material's colour painted on its points (the paint white). */
function partGeometry(node: THREE.Object3D): THREE.BufferGeometry {
  const toNode = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const parts: THREE.BufferGeometry[] = [];
  node.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    let g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toNode, o.matrixWorld));
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const c = new THREE.Color((o.material as THREE.MeshStandardMaterial).color);
    const rgb = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < rgb.length; i += 3) rgb.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    parts.push(g);
  });
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

async function loadRig(): Promise<Rig> {
  const gltf = await new GLTFLoader().loadAsync('/models/bike.glb');
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const node = (name: string) => {
    const o = scene.getObjectByName(name);
    if (!o) throw new Error(`bike.glb has no ${name}`);
    return o;
  };
  const geometry = {} as Record<Part, THREE.BufferGeometry>;
  const rest = {} as Record<Part, THREE.Matrix4>;
  for (const p of PARTS) {
    const n = node(p);
    geometry[p] = partGeometry(n);
    rest[p] = n.matrixWorld.clone();
  }
  const at = (name: string) => node(name).getWorldPosition(new THREE.Vector3());
  return {
    geometry, rest, steerInv: rest.Steer.clone().invert(),
    saddle: at('Saddle'), grips: [at('GripL'), at('GripR')], bb: new THREE.Vector3().setFromMatrixPosition(rest.Crank),
  };
}

/** One bike: where it is, how it moves and leans, and who rides it. */
class Bike {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** m/s along its heading (negative: walked back) */
  speed = 0;
  /** The bars' angle (rad, + to the left) */
  steer = 0;
  /** Its lean (rad, + to the right) */
  lean = PARK_LEAN;
  /** Nose up (rad), from the ground under its wheels */
  pitch = 0;
  spin = 0;
  crank = 0;
  /** The stand: 0 down, 1 folded up */
  fold = 0;
  rider: string | null = null;
  /** In the game: a village bike once the village has loaded, the others from the start */
  ready: boolean;
  /** Pedalled this frame (the cranks turn), else it rolls on the freewheel */
  pedalling = false;
  rough = false;
  readonly key: string;
  readonly park: { x: number; y: number; z: number; yaw: number };
  readonly track = new Track<null>([false, false, false, true], 10); // x, y, z, yaw
  readonly pose = [0, 0, 0, 0];
  readonly noise = new BikeSound();
  readonly paint: THREE.Color;
  lastX = 0;
  lastZ = 0;
  lastYaw = 0;
  lastSpeed = 0;
  yawRate = 0;
  fresh = true;
  /** The bike's own matrix this frame, and where its rider sits, holds on and pedals (world) */
  readonly matrix = new THREE.Matrix4();
  readonly steerMatrix = new THREE.Matrix4();
  readonly saddle = new THREE.Vector3();
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly grips: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  readonly pedals: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  shown = false;

  constructor(readonly id: string, readonly spec: Spec, readonly index: number) {
    ({ x: this.x, y: this.y, z: this.z, yaw: this.yaw } = spec.park);
    this.park = { ...spec.park };
    this.key = `bike-${id}`;
    this.ready = !spec.village;
    this.paint = new THREE.Color(spec.paint);
  }

  get forward(): [number, number] {
    return [-Math.sin(this.yaw), -Math.cos(this.yaw)];
  }

  /** Its outline on the plan. */
  footprint(): [number, number][] {
    const [fx, fz] = this.forward;
    return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [this.x + fx * HALF_L * a - fz * HALF_W * b, this.z + fz * HALF_L * a + fx * HALF_W * b]);
  }

  /** How far a point on the plan is from its outline (0 inside); out of reach until it is in the game. */
  distanceTo(x: number, z: number): number {
    if (!this.ready) return Infinity;
    const [fx, fz] = this.forward;
    const dx = x - this.x;
    const dz = z - this.z;
    return Math.hypot(Math.max(0, Math.abs(dx * fx + dz * fz) - HALF_L), Math.max(0, Math.abs(-dx * fz + dz * fx) - HALF_W));
  }
}

const _m = new THREE.Matrix4();
const _n = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class Bikes {
  readonly group = new THREE.Group();
  /** The bike you ride, or null */
  mounted: string | null = null;
  /** Riding this frame it ran into the edge of the game (main.ts says so) */
  atEdge = false;
  private bikes: Bike[];
  private byId = new Map<string, Bike>();
  private rig: Rig | null = null;
  private meshes: Partial<Record<Part, THREE.InstancedMesh>> = {};
  private material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 });
  // Your figure on the bike you ride (the others' figures are posed by net/avatars.ts from seat()).
  private own: Body | null = null;
  private ownRoot = new THREE.Group();
  // The camera close behind you.
  private camHeading = 0;
  private camYaw = 0;
  private camPitch = CAM_PITCH;
  private lookIdle = 0;
  private camRoll = 0;

  /** `figure`: your own figure, as the others see it (net/avatars.ts figure). */
  constructor(private world: World, private trees: Obstacle[], private figure: () => Body) {
    this.bikes = Object.entries(BIKES.bikes).map(([id, spec], i) => new Bike(id, spec, i));
    for (const k of this.bikes) this.byId.set(k.id, k);
    this.group.add(this.ownRoot);
    this.ownRoot.rotation.order = 'YXZ';
    this.ownRoot.visible = false;
    void loadRig().then((rig) => {
      this.rig = rig;
      const n = this.bikes.length;
      for (const p of PARTS) {
        const mesh = new THREE.InstancedMesh(rig.geometry[p], this.material, n);
        mesh.name = `bike-${p}`;
        mesh.frustumCulled = false; // spread over the map: their bounds would be the whole map
        mesh.castShadow = p === 'FramePaint' || p === 'Frame' || p === 'WheelF' || p === 'WheelR';
        mesh.userData.ignoreRay = true; // shots go through (and the bikes take no paint)
        mesh.raycast = () => {};
        for (let i = 0; i < n; i++) mesh.setMatrixAt(i, ZERO);
        if (p === 'FramePaint' || p === 'ForkPaint') for (const k of this.bikes) mesh.setColorAt(k.index, k.paint);
        this.meshes[p] = mesh;
        this.group.add(mesh);
      }
    }, () => {});
  }

  /** The village's bikes are in the game (main.ts, once the village has loaded). */
  villageReady(): void {
    for (const k of this.bikes) k.ready = true;
  }

  /** The bike you ride: where it is and how fast it goes. */
  get ridden(): { x: number; y: number; z: number; yaw: number; speed: number; id: string } | null {
    const k = this.mounted ? this.byId.get(this.mounted) : undefined;
    return k ? { x: k.x, y: k.y, z: k.z, yaw: k.yaw, speed: k.speed, id: k.id } : null;
  }

  /** The bike within reach of where you stand (its outline within reach, at your height), with who rides it; null for none. */
  nearest(x: number, z: number, feet: number): { id: string; rider: string | null } | null {
    let best: Bike | null = null;
    let bd = BIKES.reach;
    for (const k of this.bikes) {
      if (Math.abs(feet - k.y) > 1) continue;
      const d = k.distanceTo(x, z);
      if (d < bd) [best, bd] = [k, d];
    }
    return best ? { id: best.id, rider: best.rider } : null;
  }

  /** You are on bike `id` (alone right away; together once the server says so): the stand up, the camera behind. */
  mount(id: string, me: string): void {
    const k = this.byId.get(id);
    if (!k) return;
    this.mounted = id;
    k.rider = me;
    k.speed = 0;
    k.track.clear();
    this.camHeading = k.yaw;
    this.camYaw = 0;
    this.camPitch = CAM_PITCH;
    if (!this.own) {
      this.own = this.figure();
      this.ownRoot.add(this.own.root);
    }
    this.ownRoot.visible = true;
  }

  /** Off the bike, on its left (else its right, behind or in front): where you stand, facing its way. Null when not riding. */
  dismount(): { x: number; y: number; z: number; yaw: number } | null {
    const k = this.mounted ? this.byId.get(this.mounted) : undefined;
    this.mounted = null;
    this.ownRoot.visible = false;
    if (this.own) {
      this.ownRoot.remove(this.own.root);
      this.own.dispose?.();
      this.own = null;
    }
    if (!k) return null;
    k.rider = null;
    k.speed = 0;
    k.track.clear(); // the server's next states start from here
    // Its right is (-fz, fx) on the plan: a negative `side` is its left.
    const [fx, fz] = k.forward;
    const spots = [[-0.75, -0.1], [0.75, -0.1], [0, -(HALF_L + 0.5)], [0, HALF_L + 0.5]].map(([side, ahead]) => ({
      x: k.x - fz * side + fx * ahead,
      z: k.z + fx * side + fz * ahead,
    }));
    const free = spots.find((p) => this.world.boxFree(p.x, p.z, 0, 0.3, 0.3, k.y + 0.4, k.y + 1.8, k.key)) ?? spots[0];
    return { x: free.x, y: k.y, z: free.z, yaw: k.yaw };
  }

  /** The others' bikes as the server has them (joining: `snap`, there at once; or one got on or off). */
  setAll(list: BikeState[], me: string, snap = false): void {
    for (const s of list) {
      const k = typeof s?.id === 'string' ? this.byId.get(s.id) : undefined;
      if (!k) continue;
      if (k.id === this.mounted && s.rider === me) continue; // yours: you move it
      k.rider = typeof s.rider === 'string' ? s.rider : null;
      if (snap || Math.hypot(s.x - k.x, s.z - k.z) > 10) {
        Object.assign(k, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, speed: 0, fresh: true });
        k.track.clear();
      }
    }
  }

  /** A tick's bikes (shared/wire.mjs): where each was at the server's time. */
  receive(list: BikeSample[], st: number, me: string): void {
    for (const s of list) {
      const k = this.byId.get(s.id);
      if (!k || (k.id === this.mounted && s.rider === me)) continue;
      k.rider = s.rider;
      k.track.push(st - s.age, [s.x, s.y, s.z, s.yaw], null, false, !s.rider);
    }
  }

  /** Back alone: nobody else rides any more; each bike stays where it is. */
  reset(): void {
    for (const k of this.bikes) if (k.id !== this.mounted) {
      k.rider = null;
      k.track.clear();
    }
  }

  /** Your bell, at your bike. */
  bell(): void {
    const k = this.mounted ? this.byId.get(this.mounted) : undefined;
    if (k) ringBell(k.x, k.y + 1, k.z);
  }

  /** Someone else's bell (the server's 'bell'), at their bike as it is drawn. */
  ring(id: string): void {
    const k = this.byId.get(id);
    if (k?.ready) ringBell(k.x, k.y + 1, k.z);
  }

  /** Where a player's figure sits on the bike they ride (drawn this frame), or null when they ride none. */
  seat(name: string): Seat | null {
    for (const k of this.bikes) {
      if (k.rider !== name || k.id === this.mounted || !k.shown) continue;
      return this.seatOf(k);
    }
    return null;
  }

  /**
   * One frame riding: pedal, brake, steer (`input`), with the slope under the wheels; it stops
   * against the world and `others` (players). Returns how hard it hit something (m/s), 0 if not.
   */
  ride(dt: number, input: PedalInput, others: Obstacle[]): number {
    const k = this.mounted ? this.byId.get(this.mounted) : undefined;
    if (!k || !(dt > 0)) return 0;
    const reach = 4 + MAX * dt;
    const near = [...others, ...this.trees.filter((o) => Math.abs(o.x - k.x) < reach && Math.abs(o.z - k.z) < reach)];
    // The slope under the wheels: the rise from the back wheel to the front one.
    const [fx, fz] = k.forward;
    const front = this.world.groundAt(k.x + fx * WB / 2, k.z + fz * WB / 2, k.y + CLEAR + 0.2, CLEAR + 0.2).y;
    const back = this.world.groundAt(k.x - fx * WB / 2, k.z - fz * WB / 2, k.y + CLEAR + 0.2, CLEAR + 0.2).y;
    const slope = clamp((front - back) / WB, -0.3, 0.3);
    const steps = Math.max(1, Math.ceil(dt * 120));
    let impact = 0;
    this.atEdge = false;
    for (let i = 0; i < steps; i++) impact = Math.max(impact, this.step(k, dt / steps, input, near, slope));
    k.pedalling = input.throttle > 0.05 && k.speed > -0.1 && k.speed < pedalCap(slope) + 0.3;
    const g = this.world.groundAt(k.x, k.z, k.y + CLEAR, CLEAR);
    k.y += (g.y - k.y) * (1 - Math.exp(-dt * 14));
    k.rough = !g.mat || ROUGH.test(g.mat);
    if (impact > 1.5) k.noise.thump(k.x, k.y, k.z, impact);
    return impact;
  }

  private free(k: Bike, x: number, z: number, yaw: number, others: Obstacle[]): boolean {
    if (!this.world.boxFree(x, z, yaw, HALF_L, HALF_W, k.y + CLEAR, k.y + RIDER_H, k.key)) return false;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    return !others.some((o) => {
      const dx = o.x - x;
      const dz = o.z - z;
      const u = dx * fx + dz * fz;
      const w = -dx * fz + dz * fx;
      return Math.hypot(u - clamp(u, -HALF_L, HALF_L), w - clamp(w, -HALF_W, HALF_W)) < o.r;
    });
  }

  private step(k: Bike, dt: number, input: PedalInput, others: Obstacle[], slope: number): number {
    let v = k.speed;
    // Pedalling: a rider's power (more pull at a crawl), easing off towards 25 km/h on the flat (less
    // uphill, more downhill: pedalCap), none past it. Gravity along the slope on top.
    let a = -G * slope;
    const cap = pedalCap(slope);
    if (input.throttle > 0 && v < cap + 0.15) a += input.throttle * Math.min(ACCEL, POWER / (MASS * Math.max(v, 1))) * Math.min(1, (cap + 0.15 - v) / 0.35);
    a -= Math.sign(v) * (ROLL + DRAG * v * v);
    if (input.brake > 0) {
      if (v > 0.15) a -= BRAKE * input.brake;
      else if (v > -BACK) a -= 1.5 * input.brake; // standing: walking it back
    }
    const was = v;
    v += a * dt;
    if (was > 0 && v < 0 && input.brake > 0 && was > 0.15) v = 0; // braking stops it; walking back is a new start
    // Standing or at a crawl with nothing pressed: a foot goes down (it doesn't roll off by itself).
    if (input.throttle <= 0 && input.brake <= 0 && Math.abs(v) < 0.4) v *= Math.exp(-dt * 6);
    v = clamp(v, -BACK, MAX);
    // Full lock at a crawl, about a third of it at 15 km/h: sharp round a gate, steady along a road.
    const lock = STEER / (1 + (Math.abs(v) / 3.5) ** 1.5);
    k.steer += (-input.steer * lock - k.steer) * (1 - Math.exp(-dt * 10));
    let yaw = angle(k.yaw + (v / WB) * Math.tan(k.steer) * dt);
    if (Math.abs(v) < 0.5) yaw = angle(yaw - input.steer * TURN_SLOW * (1 - Math.abs(v) / 0.5) * dt); // walked round, standing
    const x = k.x - Math.sin(yaw) * v * dt;
    const z = k.z - Math.cos(yaw) * v * dt;
    // Already in something (a door swung into it): let it ride out. The edge of the game stops it like a wall.
    const stuck = !this.free(k, k.x, k.z, k.yaw, others);
    const from = { x: k.x, z: k.z, yaw: k.yaw };
    const fenced = (x: number, z: number, yaw: number) => this.world.boxInBounds(x, z, yaw, HALF_L, HALF_W, from);
    const can = (x: number, z: number, yaw: number, inBounds = fenced(x, z, yaw)) => inBounds && (stuck || this.free(k, x, z, yaw, others));
    const ahead = fenced(x, z, yaw);
    if (!ahead) this.atEdge = true;
    let impact = 0;
    if (can(x, z, yaw, ahead)) Object.assign(k, { x, z, yaw });
    else if (can(k.x, k.z, yaw)) {
      impact = Math.abs(v); // turning on the spot is free, going on isn't
      k.yaw = yaw;
      v = 0;
    } else if (can(x, k.z, k.yaw) && Math.abs(x - k.x) > Math.abs(z - k.z)) {
      impact = Math.abs(v) * 0.5; // glancing along a wall: it slows
      k.x = x;
      v *= 0.6;
    } else if (can(k.x, z, k.yaw) && Math.abs(z - k.z) >= Math.abs(x - k.x)) {
      impact = Math.abs(v) * 0.5;
      k.z = z;
      v *= 0.6;
    } else {
      impact = Math.abs(v);
      v = 0;
    }
    k.speed = v;
    return impact;
  }

  /**
   * The camera close behind you. `turnX` and `turnY` (radians) look around; when you stop looking
   * it swings back behind the bike as you ride. It leans a little with the bike (not with reduced
   * motion asked for).
   */
  chase(camera: THREE.PerspectiveCamera, dt: number, turnX: number, turnY: number): void {
    const k = this.mounted ? this.byId.get(this.mounted) : undefined;
    if (!k) return;
    this.camYaw = angle(this.camYaw - turnX);
    this.camPitch = clamp(this.camPitch + turnY, -0.15, 1.1);
    this.lookIdle = turnX || turnY ? 0 : this.lookIdle + dt;
    if (this.lookIdle > 1.5 && Math.abs(k.speed) > 0.8) {
      const f = 1 - Math.exp(-dt * 2);
      this.camYaw -= this.camYaw * f;
      this.camPitch += (CAM_PITCH - this.camPitch) * f;
    }
    this.camHeading += angle(k.yaw - this.camHeading) * (1 - Math.exp(-Math.min(dt, 0.1) * 4));
    const h = this.camHeading + this.camYaw;
    // Over the rider's head: the road ahead shows above it.
    const dist = 3.6 + 0.07 * Math.abs(k.speed);
    const target: Point = { x: k.x, y: k.y + 1.7, z: k.z };
    const want: Point = {
      x: target.x + Math.sin(h) * Math.cos(this.camPitch) * dist,
      y: target.y + Math.sin(this.camPitch) * dist,
      z: target.z + Math.cos(h) * Math.cos(this.camPitch) * dist,
    };
    // Something between you and the camera (a wall, a hedge): it comes closer.
    const c = Math.max(0.12, this.world.clearance(target, want, k.key) - 0.3 / dist);
    camera.position.set(target.x + (want.x - target.x) * c, target.y + (want.y - target.y) * c, target.z + (want.z - target.z) * c);
    camera.lookAt(target.x, target.y, target.z);
    this.camRoll += ((CALM ? 0 : -0.25 * k.lean) - this.camRoll) * (1 - Math.exp(-Math.min(dt, 0.1) * 4));
    camera.rotateZ(this.camRoll);
  }

  /**
   * Every frame: the others' bikes where their ticks put them, then each bike's lean, bars, wheels,
   * cranks and stand from how it moves, its block in the collision world and its sound; drawn
   * within DRAW m of `eye` once in the game. Then your figure on yours, pedalling.
   */
  update(dt: number, eye: THREE.Vector3): void {
    for (const k of this.bikes) {
      const mine = k.id === this.mounted;
      if (!k.ready) {
        this.world.setMoving(k.key, null);
        this.hide(k);
        continue;
      }
      if (!mine && k.track.at(netClock.time, k.pose)) {
        const [x, y, z, yaw] = k.pose;
        const v = dt > 0 ? ((x - k.x) * -Math.sin(yaw) + (z - k.z) * -Math.cos(yaw)) / dt : 0;
        k.speed += (clamp(v, -BACK, MAX * 1.3) - k.speed) * (1 - Math.exp(-dt * 8));
        Object.assign(k, { x, y, z, yaw });
      }
      if (!mine && !k.rider) k.speed *= Math.exp(-dt * 4); // standing: settles at once
      this.feel(k, dt, mine);
      k.shown = (k.x - eye.x) ** 2 + (k.z - eye.z) ** 2 < DRAW * DRAW;
      if (k.shown) {
        this.place(k);
        k.noise.update({ x: k.x, y: k.y, z: k.z, speed: Math.abs(k.speed), coasting: !k.pedalling && !!k.rider, rough: k.rough }, dt);
      } else {
        this.hide(k);
        k.noise.stop();
      }
      // Its block: people walk round a bike standing; yours isn't in your own way.
      this.world.setMoving(k.key, k.footprint(), k.y, k.y + (k.rider ? RIDER_H : 1.1));
    }
    for (const m of Object.values(this.meshes)) {
      m.instanceMatrix.needsUpdate = true;
    }
    this.poseOwn(dt, eye);
  }

  /** What a bike's motion does to it this frame: lean, bars, wheels, cranks, stand; the same for yours and the others'. */
  private feel(k: Bike, dt: number, mine: boolean): void {
    if (!(dt > 0)) return;
    const d = Math.min(dt, 0.1);
    const ease = (rate: number) => 1 - Math.exp(-d * rate);
    const turned = angle(k.yaw - k.lastYaw);
    const jump = k.fresh || Math.hypot(k.x - k.lastX, k.z - k.lastZ) > 3 + MAX * dt * 1.5;
    k.fresh = false;
    if (jump) k.yawRate = 0;
    else k.yawRate += (turned / dt - k.yawRate) * ease(10);
    const v = k.speed;
    if (!mine) {
      // The others': the bars from the turn, the pedals turning while it speeds up or holds its speed.
      k.steer += (clamp(Math.atan((k.yawRate * WB) / Math.max(Math.abs(v), 1.5)), -STEER, STEER) - k.steer) * ease(8);
      k.pedalling = !!k.rider && v > 0.5 && v - k.lastSpeed > -0.6 * dt && v < PEDAL + 0.5;
    }
    // Leaning into the turn as much as the speed and the turn ask; on its stand when nobody rides it.
    // (Turning right the heading goes down: a negative yaw rate leans it right.)
    const want = k.rider ? clamp(-Math.atan((v * k.yawRate) / G), -LEAN_MAX, LEAN_MAX) * Math.min(1, Math.abs(v) / 1.5) : PARK_LEAN;
    k.lean += (want - k.lean) * ease(k.rider ? 7 : 3);
    k.fold += ((k.rider ? 1 : 0) - k.fold) * ease(k.rider ? 10 : 4);
    const turn = (v / WHEEL_R) * dt;
    k.spin -= Math.sign(turn) * Math.min(Math.abs(turn), SPIN_STEP);
    if (k.pedalling) k.crank -= Math.sign(turn) * Math.min(Math.abs(turn) / GEAR, SPIN_STEP);
    // The nose up or down with the ground under the wheels.
    const [fx, fz] = k.forward;
    if (k.shown || mine) {
      const front = this.world.groundAt(k.x + fx * WB / 2, k.z + fz * WB / 2, k.y + CLEAR + 0.2, CLEAR + 0.2).y;
      const back = this.world.groundAt(k.x - fx * WB / 2, k.z - fz * WB / 2, k.y + CLEAR + 0.2, CLEAR + 0.2).y;
      k.pitch += (clamp(Math.atan2(front - back, WB), -0.3, 0.3) - k.pitch) * ease(12);
    }
    k.lastX = k.x;
    k.lastZ = k.z;
    k.lastYaw = k.yaw;
    k.lastSpeed = v;
  }

  /** Each of the bike's parts where it is this frame, and where its rider sits, holds on and pedals. */
  private place(k: Bike): void {
    k.matrix.compose(_v.set(k.x, k.y, k.z), _q.setFromEuler(_e.set(k.pitch, k.yaw, -k.lean, 'YXZ')), _s);
    k.up.set(0, 1, 0).applyQuaternion(_q);
    const rig = this.rig;
    if (!rig) return;
    const set = (p: Part, m: THREE.Matrix4, i = k.index) => this.meshes[p]?.setMatrixAt(i, m);
    set('FramePaint', _m.multiplyMatrices(k.matrix, rig.rest.FramePaint));
    set('Frame', _m.multiplyMatrices(k.matrix, rig.rest.Frame));
    // The steering: about the head tube's axis (the part's own y).
    k.steerMatrix.multiplyMatrices(k.matrix, rig.rest.Steer).multiply(_n.makeRotationY(k.steer));
    set('Steer', k.steerMatrix);
    set('ForkPaint', k.steerMatrix);
    // What turns with the bars, from its rest place: the front wheel, the grips.
    const bars = _n.copy(k.steerMatrix).multiply(rig.steerInv);
    set('WheelF', _m.multiplyMatrices(bars, rig.rest.WheelF).multiply(_r.makeRotationX(k.spin)));
    k.grips[0].copy(rig.grips[0]).applyMatrix4(bars);
    k.grips[1].copy(rig.grips[1]).applyMatrix4(bars);
    set('WheelR', _m.multiplyMatrices(k.matrix, rig.rest.WheelR).multiply(_n.makeRotationX(k.spin)));
    set('Crank', _m.multiplyMatrices(k.matrix, rig.rest.Crank).multiply(_n.makeRotationX(k.crank)));
    // The pedals go round with the cranks and stay level.
    const c = Math.cos(k.crank);
    const s = Math.sin(k.crank);
    PEDALS.forEach((p, i) => {
      const r = rig.rest[p];
      _v.setFromMatrixPosition(r).sub(rig.bb);
      const y = _v.y * c - _v.z * s;
      const z = _v.y * s + _v.z * c;
      _v.set(rig.bb.x + _v.x, rig.bb.y + y, rig.bb.z + z);
      _m.makeTranslation(_v.x, _v.y, _v.z).premultiply(k.matrix);
      set(p, _m);
      k.pedals[i].setFromMatrixPosition(_m).addScaledVector(k.up, 0.04);
    });
    set('Stand', _m.multiplyMatrices(k.matrix, rig.rest.Stand).multiply(_n.makeRotationFromQuaternion(_q.slerpQuaternions(NO_TURN, FOLD, k.fold))));
    k.saddle.copy(rig.saddle).applyMatrix4(k.matrix);
  }

  private hide(k: Bike): void {
    for (const p of PARTS) this.meshes[p]?.setMatrixAt(k.index, ZERO);
  }

  /** Where a rider's figure goes on bike `k`: hips on the saddle, leaning with it; feet on the pedals, hands on the grips. */
  private seatOf(k: Bike): Seat {
    const root = _v.copy(k.saddle).addScaledVector(k.up, 0.06 - SEAT_HIP);
    return {
      x: k.saddle.x, y: k.saddle.y, z: k.saddle.z, yaw: k.yaw - Math.PI, roll: -k.lean, pitch: k.pitch,
      root: { x: root.x, y: root.y, z: root.z }, bike: { pedals: k.pedals, grips: k.grips },
    };
  }

  /** Your figure on the bike you ride, posed as the others see you. */
  private poseOwn(dt: number, eye: THREE.Vector3): void {
    const k = this.mounted ? this.byId.get(this.mounted) : undefined;
    if (!k || !this.own || !this.rig) return;
    const seat = this.seatOf(k);
    this.ownRoot.position.set(seat.root!.x, seat.root!.y, seat.root!.z);
    this.ownRoot.rotation.set(k.pitch, k.yaw, -k.lean, 'YXZ');
    const pose: Pose = {
      speed: 0, forward: 0, side: 0, armed: false, alive: true, crouch: false, flying: false, pitch: 0, weapon: 'pistol',
      yaw: k.yaw, air: 0, vy: 0, seat: k.yaw, far: eye.distanceTo(k.saddle), bike: seat.bike,
    };
    this.own.animate(dt, pose);
  }
}

const PEDALS = ['PedalL', 'PedalR'] as const;
