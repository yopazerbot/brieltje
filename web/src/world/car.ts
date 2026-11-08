import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import CARS from '../../shared/car.json';
import type { CarSample } from '../../shared/wire.mjs';
import { netClock, Track } from '../net/track';
import { CarBody, groundPlane, PITCH_MAX, ROLL_MAX, skid } from './carBody';
import { G, MASS, surfaceGrip, tyreForces, YAW_INERTIA } from './carGrip';
import { CarLamps } from './carLights';
import { CarSound } from './carSound';
import type { Point, World } from './collision';
import { mood } from './mood';
import { skidMarks } from './skidMarks';

/**
 * The cars you can drive (shared/car.json): the black Tesla Model Y on our driveway, the blue
 * Model 3 at the bungalow, and a white Model Y and a red Model 3 in the bays by the church in
 * Smetlede. You get in with E (or Triangle) and drive with a camera behind the car; it stops
 * against the house, hedges, fences, trees and other players. In multiplayer one player drives
 * each car at a time and the others see it move (see game.mjs), drawn a little behind on the
 * server's clock between the states it sends (net/track.ts), so it drives smoothly for them and for
 * the passenger.
 *
 * The models are built in Blender from the cars' published sizes and photos (tools/model_y.py,
 * tools/model_3.py), so they need no licence; both use the same material names, so each gets
 * the game's materials with its own paint. Their wheels are separate parts with their axle as
 * origin, so they roll and the front ones steer. Each model is fetched once: two cars of a kind
 * share its geometry.
 *
 * The village's cars are in the game (drawn, solid, within reach) once the village has loaded
 * (`ready`, set by main.ts); until then they wait at their parking spot's height. A car is drawn
 * within DRAW m of the eye.
 *
 * More Teslas can be spawned with /tesla (shared/car.json: placed; together the admin's, or a player's when the admin allows it, in
 * multiplayer, anyone's alone): each is one of these cars in a paint of its own, with a `kind`, and
 * is taken away again with dispose().
 */

export type CarSpec = (typeof CARS.cars)[keyof typeof CARS.cars];
type Kind = keyof typeof CARS.placed.kinds;
/** The most placed Teslas at once. */
export const PLACED_MAX = CARS.placed.max;

/** A placed Tesla's spec (its base car's model, size and speeds in its own paint), standing at `at`; null for a kind the catalogue doesn't know. */
export function placedSpec(kind: string, at: { x: number; y: number; z: number; yaw: number }): CarSpec | null {
  if (!Object.hasOwn(CARS.placed.kinds, kind)) return null;
  const k = CARS.placed.kinds[kind as Kind];
  const base = CARS.cars[k.base as keyof typeof CARS.cars];
  return { ...base, name: k.name, paint: k.paint, metal: k.metal, village: false, park: { x: at.x, y: at.y, z: at.z, yaw: at.yaw } };
}

export interface CarState {
  /** Which car (shared/car.json) */
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Front wheel angle (rad) */
  s: number;
  /** Who drives it, or null */
  driver: string | null;
  /** Who rides along in the passenger seat (multiplayer), or null */
  passenger?: string | null;
  /** A spawned Tesla: its kind (shared/car.json: placed) */
  kind?: string;
}

export interface DriveInput {
  throttle: number;
  brake: number;
  /** -1 left .. 1 right */
  steer: number;
  handbrake: boolean;
}

/**
 * A car hit something hard (world/crash.ts shows and sounds it): where on the plan and at what height, the
 * way out of what it hit, how fast it went into it (m/s), and what it was: the block's material, `tree`, or
 * a moving part's key (another car: car-<id>).
 */
export interface CrashHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  speed: number;
  what: string;
}

/** Something round the car can't drive through: a player, a tree trunk. */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

const WHEELBASE = 2.89; // m
const WHEEL_R = 0.356;  // m
const ACCEL = 6;        // m/s2 from standstill at full throttle, less towards top speed
const BRAKE = 9;        // m/s2 asked of the brakes (ABS holds it to what the ground grips: world/carGrip.ts)
const REVERSE = 3;      // m/s2 backwards
const HANDBRAKE = 1;    // g asked of the front brakes with the handbrake, the wheel straight (less as you steer); the rear wheels lock
const REGEN = 1;        // m/s2: off the pedal, the motor slows the car (as a Tesla does)
const GRIP = 12;        // how fast sideways sliding dies out at a crawl (1/s)
const ESC = 6;          // 1/s: how fast the stability control brings a sliding car back (not while the handbrake is on)
const STEER = 0.62;     // rad, the front wheels at full lock (less at speed, see step())
const CLEAR = 0.3;      // m: lower things (kerbs, paving, a step) don't stop the car
const SPIN_STEP = 0.3;  // rad: the most a wheel turns per frame on screen (faster, the spokes seem to stand or run back)
const DRAW = 250;       // m from the eye: further off a car isn't drawn (about 30 draw calls each; the village's parked cars go at 200 m)
const ROLL_H = 0.45;    // m: the height the body pitches and rolls about, between the axles and the sills
const TILT = 0.2;       // rad: the most the ground under the wheels tilts the car
/** Ground the tyres don't squeal on or mark: grass, earth, gravel (the block's material name, or none for the bare ground). */
const ROUGH = /grass|lawn|meadow|field|earth|soil|mud|gravel|sand|hedge|leaves|moss|forest|wood_floor/i;
/** The player's system asks for less motion: no camera sway or roll, no wider view at speed. */
const CALM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A model's scene, fetched and parsed once however many cars use it; each car gets its own copy (sharing the geometry). */
const models = new Map<string, Promise<THREE.Group>>();
function modelCopy(url: string): Promise<THREE.Group> {
  let scene = models.get(url);
  if (!scene) models.set(url, (scene = new GLTFLoader().loadAsync(url).then((gltf) => gltf.scene)));
  return scene.then((s) => s.clone()); // the original keeps the model's material names (prepare reads them)
}

// The paint is each car's own (see prepare); the light bars glow; tinted glass you can just see
// the cabin through. Plain (not clear-coated) materials: the graphics are limited by pixels.
const MATERIALS: Record<string, THREE.Material> = {
  Glass: new THREE.MeshStandardMaterial({ color: '#07080a', roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.78, depthWrite: false }),
  Trim: new THREE.MeshStandardMaterial({ color: '#101112', roughness: 0.6 }),
  Tyre: new THREE.MeshStandardMaterial({ color: '#121212', roughness: 0.9 }),
  Rim: new THREE.MeshStandardMaterial({ color: '#7c8088', roughness: 0.32, metalness: 0.85 }),
  RimDark: new THREE.MeshStandardMaterial({ color: '#0d0d0e', roughness: 0.3, metalness: 0.3 }),
  LightBar: new THREE.MeshStandardMaterial({ color: '#e4ecf5', roughness: 0.1, emissive: '#dfe9ff', emissiveIntensity: 2 }),
  LampGlass: new THREE.MeshStandardMaterial({ color: '#08090b', roughness: 0.05, metalness: 0.3 }),
  Gap: new THREE.MeshStandardMaterial({ color: '#000000', roughness: 0.9 }),
  Chrome: new THREE.MeshStandardMaterial({ color: '#e6e7ea', roughness: 0.05, metalness: 1 }),
  Disc: new THREE.MeshStandardMaterial({ color: '#7a7c80', roughness: 0.45, metalness: 0.85 }),
  Caliper: new THREE.MeshStandardMaterial({ color: '#3a3b3e', roughness: 0.45, metalness: 0.3 }),
  Interior: new THREE.MeshStandardMaterial({ color: '#1a1a1c', roughness: 0.8 }),
  Screen: new THREE.MeshStandardMaterial({ color: '#0a0c10', roughness: 0.1, metalness: 0.2 }),
  Reflector: new THREE.MeshStandardMaterial({ color: '#8a0f12', roughness: 0.3 }),
  Plate: new THREE.MeshStandardMaterial({ color: '#e8e8e2', roughness: 0.5 }),
};
const taillight = () => new THREE.MeshStandardMaterial({ color: '#5a0a0d', roughness: 0.2, emissive: '#ff2020', emissiveIntensity: 0.5 });
/** The parts that cast the car's shadow: the body, its glass and trim, the seats, the tyres. */
const SHADOW_PARTS = new Set(['Paint', 'Glass', 'Trim', 'Interior', 'Tyre']);

/**
 * A model's shape in one geometry (positions and normals), for a see-through copy of a
 * Tesla: a box of the car's size until the model is in, then `ready` runs once.
 */
const shapes = new Map<string, THREE.BufferGeometry>();
export function carShape(spec: { model: string; width: number; length: number; height: number }, ready: () => void): THREE.BufferGeometry {
  const have = shapes.get(spec.model);
  if (have) return have;
  if (!shapes.has(`${spec.model} box`)) {
    shapes.set(`${spec.model} box`, new THREE.BoxGeometry(spec.width, spec.height, spec.length).translate(0, spec.height / 2, 0));
    void modelCopy(spec.model).then((scene) => {
      scene.updateMatrixWorld(true);
      const parts: THREE.BufferGeometry[] = [];
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        if (g.index) g = g.toNonIndexed();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
        if (!g.attributes.normal) g.computeVertexNormals();
        parts.push(g);
      });
      const merged = mergeGeometries(parts);
      parts.forEach((g) => g.dispose());
      if (!merged) return;
      shapes.set(spec.model, merged);
      ready();
    }, () => {});
  }
  return shapes.get(`${spec.model} box`)!;
}

// A disc over the spokes that fades in at speed: the wheels look like they spin fast instead of strobing.
const blurMaterial = () => new THREE.MeshStandardMaterial({ color: '#1d1e21', roughness: 0.45, metalness: 0.5, transparent: true, opacity: 0, depthWrite: false });

/** A blur disc on the outer face of a wheel's rim, sized from the rim itself. */
function blurDisc(wheel: THREE.Object3D, blurMat: THREE.Material): THREE.Mesh | null {
  wheel.updateMatrixWorld(true);
  const toWheel = wheel.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  wheel.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !/^Rim/.test(o.userData.part)) return;
    o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox!.clone().applyMatrix4(toWheel.clone().multiply(o.matrixWorld)));
  });
  if (box.isEmpty()) return null;
  const r = Math.max(box.max.y, -box.min.y, box.max.z, -box.min.z) * 0.97;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 32).rotateY(Math.PI / 2), blurMat);
  disc.position.x = box.max.x + 0.004;
  disc.userData.ignoreRay = true;
  return disc;
}

/** The model with the game's materials (and this car's paint, brake lights and wheel blur); its wheels, the front ones apart, and which way each one faces. */
function prepare(scene: THREE.Group, own: Record<string, THREE.Material>, blurMat: THREE.Material): { front: THREE.Object3D[]; wheels: { pivot: THREE.Object3D; flip: number }[] } {
  const front: THREE.Object3D[] = [];
  const wheels: { pivot: THREE.Object3D; flip: number }[] = [];
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const name = (o.material as THREE.Material).name;
      o.material = own[name] ?? MATERIALS[name] ?? MATERIALS.Trim;
      o.userData.part = name;
      // Only the parts that make the shadow's outline cast one: the small ones flush with the body and
      // the wheels' insides (behind the tyre) would be 24 more draw calls a car in the shadow pass.
      o.castShadow = SHADOW_PARTS.has(name);
      o.userData.material = name === 'Glass' || name === 'LampGlass' ? 'black_glass' : 'steel'; // bullets spark off it
      if (name === 'Glass') o.renderOrder = 1; // after the cabin behind it
      o.userData.vehicle = true; // bullet holes stay on it when it drives off (see Decals)
    }
    // GLTF also names the tyre/rim material meshes Wheel_1..3. Animate only the axle parents:
    // rotating their children too cancels the mirrored left wheels' roll and doubles it on the right.
    if (/^Wheel_[FR][LR]$/.test(o.name)) {
      // The left wheels are turned round (their cover faces out), so they roll the other way about their own axle.
      o.rotation.reorder('YXZ'); // steer, then roll
      o.userData.baseYaw = o.rotation.y;
      wheels.push({ pivot: o, flip: Math.abs(o.rotation.y) > 1 ? -1 : 1 });
      if (/^Wheel_F/.test(o.name)) front.push(o);
    }
  });
  for (const w of wheels) {
    const disc = blurDisc(w.pivot, blurMat);
    if (disc) w.pivot.add(disc);
  }
  return { front, wheels };
}

/** A soft dark patch under the car, so it sits on the ground wherever it goes. */
function contactShadow(spec: CarSpec): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.filter = 'blur(10px)';
  g.fillStyle = 'rgba(0,0,0,0.8)';
  g.fillRect(14, 14, 36, 100);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, color: '#000000' });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(spec.width + 0.9, spec.length + 0.9), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.01;
  m.userData.ignoreRay = true;
  return m;
}

const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Car {
  /** A car hit something (yours as you drive it, the others' from how they stop): main.ts shows it (world/crash.ts). */
  static onCrash: (hit: CrashHit) => void = () => {};
  readonly group = new THREE.Group();
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Front wheel angle (rad) */
  steer = 0;
  /** m/s along its heading (negative backwards) */
  speed = 0;
  /** Someone else at the wheel (multiplayer), or null */
  driver: string | null = null;
  /** Who rides along in the passenger seat (multiplayer), or null */
  passenger: string | null = null;
  /** In the game: a village car once the village has loaded (main.ts), the others from the start */
  ready: boolean;
  /** At the wheel this frame it ran into the edge of the game (main.ts says so) */
  atEdge = false;
  /** Where it was put: its parking spot, or for a spawned Tesla where it was spawned */
  park: { x: number; y: number; z: number; yaw: number };
  private vx = 0;
  private vz = 0;
  /** rad/s it turns to the right (world/carGrip.ts: the tyres turn it, it isn't set by the steering alone) */
  private turn = 0;
  /** The pedals as the car takes them, eased in (a key is all or nothing) */
  private pedal = 0;
  private brakePedal = 0;
  /** m/s2 the tyres push it along itself and to its right, smoothed: the weight on the axles, and the body's lean */
  private ax = 0;
  private ay = 0;
  /** The grip under each wheel (world/carGrip.ts: surfaceGrip), from ground() */
  private grip = [1, 1, 1, 1];
  /** m/s the front and rear tyres slide past their grip (the marks and the squeal) */
  private slideF = 0;
  private slideR = 0;
  /** It hit something this frame (the body jolts from its speed change, not the tyres') */
  private crashed = false;
  private braking = false;
  private pushing = 0;
  private body = new THREE.Group();
  /** The wheels, out of the body: they stay on the ground while the body leans over them. */
  private chassis = new THREE.Group();
  private front: THREE.Object3D[] = [];
  private wheels: { pivot: THREE.Object3D; flip: number }[] = [];
  private lastSpeed = 0;
  // How it moves, from its own motion (world/carBody.ts): the body on its springs, and what makes it lean.
  private motion = new CarBody();
  private along = 0; // m/s2 along the car, smoothed
  private side = 0; // m/s sideways (> 0 to the right), smoothed
  private yawRate = 0; // rad/s, smoothed
  private lastX = 0;
  private lastZ = 0;
  private lastYaw = 0;
  private fresh = true; // just put somewhere: no motion to read from the last frame
  // The ground under the wheels: each wheel's spot (on the car: x right, z back; front left, front right,
  // rear left, rear right), the axles' spacing, each wheel's ground height last frame, and the plane they
  // make, smoothed (the twist is what the wheels' own springs take).
  private axle = { at: [[-0.82, -1.45], [0.82, -1.45], [-0.82, 1.42], [0.82, 1.42]], base: 2.87, track: 1.64, hub: [0, 0, 0, 0] };
  private under = [0, 0, 0, 0];
  private rise = [0, 0, 0, 0];
  private rough = [false, false, false, false];
  private ride = { pitch: 0, roll: 0, lift: 0, twist: 0 };
  private plane = { pitch: 0, roll: 0, lift: 0, twist: 0 };
  private still = 0; // frames it hasn't moved
  /** rad/s: the turn an off-centre knock gives it, dying away */
  private spinKick = 0;
  /** The hardest hit this frame at the wheel, for onCrash */
  private hit: CrashHit | null = null;
  private knock = 0; // s until the next thump over a kerb
  /** Where each tyre's skid mark got to, or null while it grips. */
  private trail: ({ x: number; y: number; z: number } | null)[] = [null, null, null, null];
  private noise = new CarSound();
  private spin = 0;
  // Someone else drives it (or it stands where it was left): its states from the server, drawn a little behind.
  private track = new Track<null>([false, false, false, true, false], 10); // x, y, z, yaw, steer
  private pose = [0, 0, 0, 0, 0];
  // The camera behind the car.
  private camHeading = 0;
  private camYaw = 0;
  private camPitch = 0.22;
  private lookIdle = 0;
  private camBack = 0;
  private camSide = 0;
  /** The view a little wider at speed (main.ts multiplies the player's field of view by it). */
  fovScale = 1;
  private halfL: number;
  private halfW: number;
  private key: string; // its moving block in the collision world
  private taillight = taillight();
  /** Its headlights and tail lights at night (world/carLights.ts) */
  private lamps: CarLamps;
  private blurMat = blurMaterial();
  private paint: THREE.MeshStandardMaterial;
  private gone = false;

  /** `kind`: a spawned Tesla (shared/car.json: placed), null for the game's own four. */
  constructor(private world: World, private trees: Obstacle[], readonly id: string, readonly spec: CarSpec, readonly kind: string | null = null) {
    ({ x: this.x, y: this.y, z: this.z, yaw: this.yaw } = spec.park);
    this.park = { ...spec.park };
    this.halfL = spec.length / 2;
    this.halfW = spec.width / 2;
    this.key = `car-${id}`;
    this.ready = !spec.village;
    this.group.userData.car = id; // /remove finds a spawned one by it
    this.group.add(this.body, this.chassis, contactShadow(spec));
    this.group.rotation.order = 'YXZ'; // its heading, then the ground's slope under it
    this.body.position.y = ROLL_H;
    this.lamps = new CarLamps((MATERIALS.LightBar as THREE.MeshStandardMaterial).clone(), spec.length, spec.width, ROLL_H);
    const paint = (this.paint = new THREE.MeshStandardMaterial({ color: spec.paint, roughness: 0.2, metalness: spec.metal }));
    void modelCopy(spec.model).then((scene) => {
      if (this.gone) return;
      const { front, wheels } = prepare(scene, { Paint: paint, TailLight: this.taillight, LightBar: this.lamps.bar }, this.blurMat);
      // The wheels move to the chassis, where they were on the model; their spots give the axles.
      scene.updateMatrixWorld(true);
      this.lamps.find(scene, -ROLL_H); // the scene sits ROLL_H under the body's origin (below)
      for (const w of wheels) {
        this.chassis.add(w.pivot);
        w.pivot.matrixWorld.decompose(w.pivot.position, w.pivot.quaternion, w.pivot.scale);
        w.pivot.userData.baseYaw = w.pivot.rotation.y;
      }
      const corners = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
      const spot = (name: string) => wheels.find((w) => w.pivot.name === name)?.pivot.position;
      const at = corners.map(spot);
      for (const w of wheels) if (at.every((p) => p)) w.pivot.userData.corner = corners.indexOf(w.pivot.name);
      if (at.every((p) => p)) {
        const [fl, fr, rl] = at as THREE.Vector3[];
        this.axle = { at: at.map((p) => [p!.x, p!.z]), base: Math.abs(rl.z - fl.z), track: Math.abs(fr.x - fl.x), hub: at.map((p) => p!.y) };
      }
      scene.position.y = -ROLL_H;
      this.body.add(scene);
      this.front = front;
      this.wheels = wheels;
    }, () => {});
    this.update(0, true);
  }

  private get forward(): [number, number] {
    return [-Math.sin(this.yaw), -Math.cos(this.yaw)];
  }

  /** The car's outline on the plan. */
  footprint(x = this.x, z = this.z, yaw = this.yaw): [number, number][] {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [x + fx * this.halfL * a - fz * this.halfW * b, z + fz * this.halfL * a + fx * this.halfW * b]);
  }

  /** How far a point on the plan is from the car's sides (0 inside it); out of reach while it isn't in the game yet. */
  distanceTo(x: number, z: number): number {
    if (!this.ready) return Infinity;
    const [fx, fz] = this.forward;
    const dx = x - this.x;
    const dz = z - this.z;
    return Math.hypot(Math.max(0, Math.abs(dx * fx + dz * fz) - this.halfL), Math.max(0, Math.abs(-dx * fz + dz * fx) - this.halfW));
  }

  /** Where you stand after getting out: by your door (the driver's on the left, the passenger's on the right), else the other side, behind or in front. */
  exitSpot(passenger = false): { x: number; z: number } {
    const [fx, fz] = this.forward;
    const sides = passenger ? [this.halfW + 0.45, -(this.halfW + 0.45)] : [-(this.halfW + 0.45), this.halfW + 0.45];
    const spots = [[sides[0], 0.3], [sides[1], 0.3], [0, -(this.halfL + 0.5)], [0, this.halfL + 0.5]].map(([side, ahead]) => ({
      x: this.x + fx * ahead - fz * side,
      z: this.z + fz * ahead + fx * side,
    }));
    return spots.find((p) => this.world.boxFree(p.x, p.z, 0, 0.3, 0.3, this.y + 0.5, this.y + 1.8, this.key)) ?? spots[0];
  }

  /** You got in: the camera starts behind the car. */
  enter(): void {
    this.camHeading = this.yaw;
    this.camYaw = 0;
    this.camPitch = 0.22;
    this.track.clear();
  }

  /** You got out: it rolls to a stop where it is. */
  leave(): void {
    this.vx = this.vz = this.speed = this.spinKick = this.turn = this.pedal = this.brakePedal = this.slideF = this.slideR = 0; // a crash's turn ends with the drive
    this.braking = false;
    this.pushing = 0;
    this.track.clear(); // the server's next states start from here
  }

  /** Through a portal: standing still at (x, y, z) facing `yaw`, the camera behind it. */
  place(x: number, y: number, z: number, yaw: number): void {
    Object.assign(this, { x, y, z, yaw, steer: 0, speed: 0, vx: 0, vz: 0, turn: 0, pedal: 0, brakePedal: 0, lastSpeed: 0, spinKick: 0, braking: false, camHeading: yaw, camYaw: 0, fresh: true });
    this.motion.reset();
    this.track.clear();
  }

  /**
   * Who sits in it, from the server (someone got in or out). With `snap` (joining), or when it is far
   * from where it is drawn (through a portal), it is there at once; otherwise the ticks move it.
   */
  setPose(s: CarState, snap = false): void {
    this.driver = s.driver;
    this.passenger = s.passenger ?? null;
    if (snap || Math.hypot(s.x - this.x, s.z - this.z) > 10) {
      Object.assign(this, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, steer: s.s, speed: 0, spinKick: 0, turn: 0, fresh: true });
      this.motion.reset();
      this.track.clear();
    }
  }

  /** Where it was at the server's time `t` (a tick: someone else drives it, or it stands). */
  sample(t: number, s: CarSample): void {
    this.driver = s.driver;
    this.passenger = s.passenger;
    this.track.push(t, [s.x, s.y, s.z, s.yaw, s.s], null, false, !s.driver);
  }

  /** One frame at the wheel; `others` are the players around. Returns how hard it hit something (m/s), 0 if it didn't. */
  drive(dt: number, input: DriveInput, others: Obstacle[]): number {
    const reach = 8 + this.spec.maxSpeed * dt;
    const near = [...others, ...this.trees.filter((o) => Math.abs(o.x - this.x) < reach && Math.abs(o.z - this.z) < reach)];
    const steps = Math.max(1, Math.ceil(dt * 120));
    let impact = 0;
    this.atEdge = false;
    this.hit = null;
    for (let i = 0; i < steps; i++) impact = Math.max(impact, this.step(dt / steps, input, near));
    this.crashed = impact > 1;
    const hit = this.hit as CrashHit | null; // step() keeps the hardest
    if (hit && hit.speed > 2.5) {
      Car.onCrash(hit);
      this.camBack -= Math.min(0.8, hit.speed * 0.06); // the camera lurches on with the car's weight, and eases back
    }
    this.braking = (input.brake > 0.05 && this.speed > 0.3) || (input.throttle > 0.05 && this.speed < -0.3) || (input.handbrake && Math.abs(this.speed) > 0.3);
    this.pushing = this.pedal || this.brakePedal; // as the car takes the pedals (eased in)
    const g = this.world.groundAt(this.x, this.z, this.y, CLEAR).y;
    this.y += (g - this.y) * (1 - Math.exp(-dt * 12));
    return impact;
  }

  private free(x: number, z: number, yaw: number, others: Obstacle[]): boolean {
    if (!this.world.boxFree(x, z, yaw, this.halfL, this.halfW, this.y + CLEAR, this.y + this.spec.height, this.key)) return false;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    return !others.some((o) => {
      const dx = o.x - x;
      const dz = o.z - z;
      const u = dx * fx + dz * fz;
      const w = -dx * fz + dz * fx;
      return Math.hypot(u - Math.max(-this.halfL, Math.min(this.halfL, u)), w - Math.max(-this.halfW, Math.min(this.halfW, w))) < o.r;
    });
  }

  private step(dt: number, input: DriveInput, others: Obstacle[]): number {
    let [fx, fz] = this.forward;
    const u = this.vx * fx + this.vz * fz; // along the car
    const side = -this.vx * fz + this.vz * fx; // to its right
    const speed = Math.abs(u);
    const max = this.spec.maxSpeed;
    // The pedals ease in over about a tenth of a second and let go a little faster: a key is all or
    // nothing, and a sudden full pull or full brake would jolt the car. A pad's triggers stay as pressed.
    const thr = Math.max(0, Math.min(1, input.throttle || 0));
    const brk = Math.max(0, Math.min(1, input.brake || 0));
    this.pedal += (thr - this.pedal) * (1 - Math.exp(-dt * (thr > this.pedal ? 12 : 14)));
    this.brakePedal += (brk - this.brakePedal) * (1 - Math.exp(-dt * (brk > this.brakePedal ? 20 : 18)));
    const hb = !!input.handbrake;

    // What the motors and brakes ask of the tyres (N); the tyres give what the ground grips (world/carGrip.ts).
    let drive = 0;
    let brake = 0;
    if (hb) {
      // The handbrake: the rear wheels lock, and the front ones brake as hard as ABS lets them (the motors
      // let go), less as you steer so the front still turns the car round.
      brake = HANDBRAKE * MASS * G * (1 - 0.9 * Math.min(1, Math.abs(input.steer)));
    } else {
      if (this.pedal > 0) {
        // Keep the same pull away from rest, easing to 35% power near the cap so the higher top speed is reachable.
        if (u < -0.3) brake += BRAKE * this.pedal * MASS;
        else drive += ACCEL * this.pedal * Math.max(0, 1 - 0.65 * (u / max) ** 2) * MASS;
      }
      if (this.brakePedal > 0) {
        if (u > 0.3) brake += BRAKE * this.brakePedal * MASS;
        else drive -= REVERSE * this.brakePedal * Math.max(0, 1 + u / this.spec.reverseSpeed) * MASS;
      }
      // Off both pedals: the motor slows it a little, fading out at a walk.
      if (this.pedal < 0.05 && this.brakePedal < 0.05) brake += REGEN * Math.min(1, Math.max(0, (speed - 1) / 3)) * MASS;
    }

    // Full lock at a crawl (4.3 m turning radius), about 9 m at 36 km/h, 24 m at 72 km/h: sharp in
    // the village streets, not twitchy flat out. The wheel turns in over about a fifth of a second and comes
    // back to the middle a little faster, faster still at speed, as a car's wheel centres itself.
    const lock = STEER / (1 + (speed / 9) ** 1.6);
    const want = -Math.max(-1, Math.min(1, input.steer || 0)) * lock;
    const out = Math.abs(want) > Math.abs(this.steer) && want * this.steer >= 0;
    this.steer += (want - this.steer) * (1 - Math.exp(-dt * (out ? 9 : Math.min(16, 10 + speed * 0.2))));
    const delta = -this.steer; // to the right

    // The tyres on what is under them (front wheels, rear wheels).
    const muF = (this.grip[0] + this.grip[1]) / 2;
    const muR = (this.grip[2] + this.grip[3]) / 2;
    const t = tyreForces({ u, s: side, r: this.turn, delta, drive, brake, locked: hb, muF, muR, ax: this.ax });
    // At a crawl the tyres can't slide: the car simply follows its front wheels (the sideways slide dies
    // out), blended into the tyres' own pushing and turning by 5 m/s.
    const grips = Math.min(1, Math.max(0, (speed - 2) / 3));
    let du = ((grips * t.fx + (1 - grips) * t.roll) / MASS) * dt;
    const ds = (t.fy / MASS) * dt;
    // The brakes stop it, they don't push it back the other way.
    if ((u > 0 && u + du < 0 && drive >= 0) || (u < 0 && u + du > 0 && drive <= 0)) du = -u;
    const k = 1 - Math.exp(-dt * 10);
    this.ax += (t.fx / MASS - this.ax) * k;
    this.ay += (t.fy / MASS - this.ay) * k;
    this.slideF = t.slideF;
    this.slideR = t.slideR;

    // How fast it turns: what the tyres turn it by (at a crawl, the front wheels' way).
    const follow = (u / WHEELBASE) * Math.tan(delta);
    let turn = this.turn + (t.mz / YAW_INERTIA) * dt;
    if (!hb && speed > 5) {
      // The stability control: turning faster than the wheel asks (the back sliding out), or the other way,
      // it is brought back to what the tyres can hold. Not while the handbrake is on: that is the point of it.
      const most = (1.15 * Math.min(muF, muR) * G) / speed;
      const asked = Math.max(-most, Math.min(most, follow));
      if (Math.abs(turn) > Math.abs(asked) + 0.05 || (turn * asked < 0 && Math.abs(turn) > 0.05)) turn += (asked - turn) * (1 - Math.exp(-dt * ESC));
    }
    turn = grips * turn + (1 - grips) * follow;
    this.turn = turn;
    const yaw = angle(this.yaw - turn * dt + this.spinKick * dt);
    this.spinKick *= Math.exp(-dt * 3);
    // Its new speed: as the tyres push it (in the frame it had), or at a crawl turned with the car.
    const un = u + du;
    const sn = side + ds;
    const [gx, gz] = [-Math.sin(yaw), -Math.cos(yaw)];
    const crawl = side * Math.exp(-dt * GRIP);
    let vx = grips * (fx * un - fz * sn) + (1 - grips) * (gx * un - gz * crawl);
    let vz = grips * (fz * un + fx * sn) + (1 - grips) * (gz * un + gx * crawl);
    // Rolling and air: it coasts to a stop. Never over its top speed, whichever way it goes.
    const v = Math.hypot(vx, vz);
    if (v > 1e-9) {
      const slow = Math.max(0, v - (0.4 + 0.0004 * v * v) * dt);
      const keep = Math.min(slow, max) / v;
      vx *= keep;
      vz *= keep;
    }
    fx = gx;
    fz = gz;
    const x = this.x + vx * dt;
    const z = this.z + vz * dt;

    let impact = 0;
    // Already stuck in something (a door swung into it): let it drive out. The edge of the game
    // (shared/bounds.mjs) stops it like a wall, stuck or not.
    const stuck = !this.free(this.x, this.z, this.yaw, others);
    const from = { x: this.x, z: this.z, yaw: this.yaw };
    const fenced = (x: number, z: number, yaw: number) => this.world.boxInBounds(x, z, yaw, this.halfL, this.halfW, from);
    const can = (x: number, z: number, yaw: number, inBounds = fenced(x, z, yaw)) => inBounds && (stuck || this.free(x, z, yaw, others));
    const ahead = fenced(x, z, yaw);
    if (!ahead) this.atEdge = true;
    // Into something: a small bounce back off it (more the harder it hit), not a dead stop.
    // (Crash tests: a tenth to a seventh of the speed comes back; the rest goes into the crumple.)
    const back = (speed: number) => (speed > 2 ? 0.1 + Math.min(0.06, speed * 0.004) : 0);
    // Where it touched and what it is: looked for the way it was going (a wall at an angle is still ahead).
    const going = Math.hypot(vx, vz) || 1;
    const [tx, tz] = [vx / going, vz / going];
    if (can(x, z, yaw, ahead)) {
      Object.assign(this, { x, z, yaw });
    } else if (can(x, this.z, this.yaw)) {
      impact = Math.abs(vz); // slides along a wall
      this.contact(tx, tz, impact, others);
      this.x = x;
      vz *= -back(impact);
    } else if (can(this.x, z, this.yaw)) {
      impact = Math.abs(vx);
      this.contact(tx, tz, impact, others);
      this.z = z;
      vx *= -back(impact);
    } else {
      impact = Math.hypot(vx, vz);
      if (impact > 1e-3) this.contact(tx, tz, impact, others);
      const e = Math.max(0.15, back(impact));
      vx *= -e;
      vz *= -e;
    }
    // Struck off its middle (one corner against a post, a tree): it turns away from that side. Which
    // side is clear, a little further on with the car moved a little to its left or its right.
    if (impact > 2 && !stuck) {
      const [ox, oz] = [x - this.x, z - this.z];
      const [rx, rz] = [-fz, fx]; // to its right
      const left = this.free(this.x + ox - rx * 0.4, this.z + oz - rz * 0.4, this.yaw, others);
      const right = this.free(this.x + ox + rx * 0.4, this.z + oz + rz * 0.4, this.yaw, others);
      if (left !== right) this.spinKick += (right ? -1 : 1) * Math.sign(un || 1) * Math.min(1.1, impact * 0.07);
    }
    if (impact > 1) this.turn *= 0.3; // what it hit holds it: its own spin mostly stops (the knock above turns it)
    this.vx = vx;
    this.vz = vz;
    [fx, fz] = this.forward;
    this.speed = vx * fx + vz * fz;
    return impact;
  }

  /**
   * What it ran into going along (dx, dz) at `speed` m/s: where it touched (the edge of its box that way)
   * and what is there (a tree among `others`, else the block or moving part), kept when it is the hardest
   * this frame. A person in the way is no crash.
   */
  private contact(dx: number, dz: number, speed: number, others: Obstacle[]): void {
    if (speed <= (this.hit?.speed ?? 0)) return;
    const [fx, fz] = this.forward;
    const du = dx * fx + dz * fz;
    const dw = -dx * fz + dz * fx;
    const t = Math.min(Math.abs(du) > 1e-3 ? this.halfL / Math.abs(du) : Infinity, Math.abs(dw) > 1e-3 ? this.halfW / Math.abs(dw) : Infinity);
    const x = this.x + dx * t;
    const z = this.z + dz * t;
    const near = others.find((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.5);
    let what = '';
    if (near) {
      if (!this.trees.includes(near)) return;
      what = 'tree';
    } else {
      const lo = this.y + CLEAR;
      const hi = this.y + this.spec.height;
      const at = this.world.touching(x + dx * 0.25, z + dz * 0.25, lo, hi, 0.35, this.key) ?? this.world.touching(x + dx * 0.4, z + dz * 0.4, lo, hi, 0.9, this.key);
      what = at?.key ?? at?.mat ?? at?.name ?? '';
    }
    this.hit = { x, y: this.y + 0.55, z, nx: -dx, nz: -dz, speed, what };
  }

  /**
   * The camera behind the car. `turnX` and `turnY` (radians) look around it; when you
   * stop looking it swings back behind the car as you drive. It lags the body a little: it
   * drops back as the car speeds up and closes in as it brakes, swings out of a turn, rides
   * the bumps and leans a touch with the body; the view widens a little at speed (fovScale).
   * It looks a touch into a turn, and while the car slides it looks where the car goes.
   * With reduced motion asked for (the system's setting) it doesn't sway, lean or widen.
   */
  chase(camera: THREE.PerspectiveCamera, dt: number, turnX: number, turnY: number): void {
    this.camYaw = angle(this.camYaw - turnX);
    this.camPitch = Math.max(-0.1, Math.min(1.1, this.camPitch + turnY));
    this.lookIdle = turnX || turnY ? 0 : this.lookIdle + dt;
    if (this.lookIdle > 1.5 && Math.abs(this.speed) > 1) {
      const k = 1 - Math.exp(-dt * 2);
      this.camYaw -= this.camYaw * k;
      this.camPitch += (0.22 - this.camPitch) * k;
    }
    // It follows the car's heading a little behind, looks a touch into the turn ahead of it, and while the
    // car slides it follows more the way the car goes than the way it points, so a spin doesn't whirl the view.
    const fast = Math.min(1, Math.max(0, (this.speed - 1) / 4));
    const slip = fast * Math.max(-1, Math.min(1, Math.atan2(this.side, Math.max(1, this.speed))));
    const into = CALM ? 0 : Math.max(-0.25, Math.min(0.25, 0.3 * this.yawRate)) * fast;
    const heading = this.yaw - 0.6 * slip + into;
    this.camHeading += angle(heading - this.camHeading) * (1 - Math.exp(-dt * (4 - 1.5 * Math.min(1, Math.abs(slip) * 3))));
    const h = this.camHeading + this.camYaw;
    const d = Math.min(Math.max(dt, 0), 0.1);
    const lag = 1 - Math.exp(-d * 3);
    const v = Math.abs(this.speed);
    this.camBack += (0.5 * (this.motion.pitch / PITCH_MAX) + 0.6 * Math.min(1, v / this.spec.maxSpeed) - this.camBack) * lag;
    this.camSide += ((CALM ? 0 : -0.3 * (this.motion.roll / ROLL_MAX)) - this.camSide) * lag;
    const wide = CALM ? 0 : Math.min(1, Math.max(0, (v - 12) / 40));
    this.fovScale += (1 + 0.1 * wide * wide * (3 - 2 * wide) - this.fovScale) * (1 - Math.exp(-d * 1.5));
    const dist = 6.5 + this.camBack;
    const target: Point = { x: this.x, y: this.y + this.ride.lift + 1.4 + (CALM ? 0 : 0.5 * this.motion.heave), z: this.z };
    const want: Point = {
      x: target.x + Math.sin(h) * Math.cos(this.camPitch) * dist + Math.cos(h) * this.camSide,
      y: target.y + Math.sin(this.camPitch) * dist,
      z: target.z + Math.cos(h) * Math.cos(this.camPitch) * dist - Math.sin(h) * this.camSide,
    };
    // Something between the car and the camera (a wall, a hedge): come closer.
    const k = Math.max(0.15, this.world.clearance(target, want, this.key) - 0.3 / dist);
    camera.position.set(target.x + (want.x - target.x) * k, target.y + (want.y - target.y) * k, target.z + (want.z - target.z) * k);
    camera.lookAt(target.x, target.y, target.z);
    if (!CALM) camera.rotateZ(0.25 * this.motion.roll);
  }

  /**
   * Every frame: follow the driver (`local`: you drive, or nobody does), then wheels, lean, lights,
   * its block and its sound; drawn when it is in the game and within DRAW m of `eye`.
   */
  update(dt: number, local: boolean, eye?: THREE.Vector3): void {
    this.group.visible = this.ready && (!eye || (this.x - eye.x) ** 2 + (this.z - eye.z) ** 2 < DRAW * DRAW);
    if (!this.ready) {
      this.world.setMoving(this.key, null); // nothing to walk or drive into before it is there
      return;
    }
    if (!local && this.track.at(netClock.time, this.pose)) {
      const [x, y, z, yaw, steer] = this.pose;
      // Its speed along its heading from how far it moved this frame, smoothed for the wheels and the sound.
      const v = dt > 0 ? ((x - this.x) * -Math.sin(yaw) + (z - this.z) * -Math.cos(yaw)) / dt : 0;
      this.speed += (Math.max(-this.spec.reverseSpeed, Math.min(this.spec.maxSpeed, v)) - this.speed) * (1 - Math.exp(-dt * 8));
      this.braking = this.speed - this.lastSpeed < -3 * dt && Math.abs(this.speed) > 0.5;
      Object.assign(this, { x, y, z, yaw, steer });
    }
    if (this.group.visible) this.feel(dt, local);
    else {
      this.fresh = true; // back in sight, it starts afresh
      this.noise.update({ x: this.x, y: this.y, z: this.z, speed: 0, load: 0, regen: 0, skid: 0, rough: false }); // and out of it, quiet
    }
    this.group.position.set(this.x, this.y + this.ride.lift, this.z);
    this.group.rotation.set(this.ride.pitch, this.yaw, this.ride.roll, 'YXZ');
    const turnRate = Math.abs(this.speed) / WHEEL_R; // rad/s
    this.spin -= Math.sign(this.speed) * Math.min(turnRate * dt, SPIN_STEP);
    for (const w of this.wheels) w.pivot.rotation.x = this.spin * w.flip;
    this.blurMat.opacity = Math.min(0.92, Math.max(0, (turnRate - 12) / 25));
    this.blurMat.visible = this.blurMat.opacity > 0.02;
    for (const w of this.front) w.rotation.y = w.userData.baseYaw + this.steer;
    // Each wheel's spring takes the twist of the ground the car can't follow (front left and rear right one way).
    const twist = Math.max(-0.06, Math.min(0.06, this.ride.twist));
    for (const w of this.wheels) {
      const i: number | undefined = w.pivot.userData.corner;
      if (i !== undefined) w.pivot.position.y = this.axle.hub[i] + (i === 0 || i === 3 ? twist : -twist);
    }
    // The body on its springs: back when it speeds up, forward when it brakes, out of a turn, knocked by kerbs.
    this.body.position.y = ROLL_H + this.motion.heave;
    this.body.rotation.set(this.motion.pitch, 0, this.motion.roll);
    this.lastSpeed = this.speed;
    // Its lights: the brake lights as by day, and at night while someone drives it the headlights and tail lights.
    this.lamps.update(dt, this.group.visible, local || this.driver !== null, this.braking, this.taillight, this.body, this.group);
    this.world.setMoving(this.key, this.footprint(), this.y, this.y + this.spec.height);
  }

  /**
   * What the car's own motion does to it this frame (it is drawn): how it speeds up, slows down and
   * turns, from which the body leans (world/carBody.ts); the ground under its wheels; its skid marks
   * and its sound. The same for the car you drive and for those others drive (from their smoothed
   * track), so nothing of it goes over the network.
   */
  private feel(dt: number, local: boolean): void {
    if (!(dt > 0)) return;
    const d = Math.min(dt, 0.1);
    const dx = this.x - this.lastX;
    const dz = this.z - this.lastZ;
    const turned = angle(this.yaw - this.lastYaw);
    // Put somewhere new (a portal, joining, back in sight): nothing to read from the last frame.
    const jump = this.fresh || Math.hypot(dx, dz) > 3 + this.spec.maxSpeed * dt * 1.5;
    this.fresh = false;
    let along = 0;
    if (jump) {
      this.along = this.side = this.yawRate = 0;
      this.motion.reset();
    } else {
      const [fx, fz] = this.forward;
      const side = local ? -this.vx * fz + this.vz * fx : (-dx * fz + dz * fx) / dt;
      this.side += (side - this.side) * (1 - Math.exp(-d * 10));
      this.yawRate += (turned / dt - this.yawRate) * (1 - Math.exp(-d * 12));
      along = Math.max(-40, Math.min(40, (this.speed - this.lastSpeed) / dt));
      this.along += (along - this.along) * (1 - Math.exp(-d * 12));
    }
    // The pulls the body leans from. At the wheel, the tyres' own (sliding, the car turns faster than it is
    // pulled round); a crash jolts it by its speed change. Others' cars: from their smoothed track, the
    // speed times the turn (to the right: turning right turns the heading down).
    const across = local && !jump ? this.ay : -this.speed * this.yawRate;
    this.motion.step(dt, local && !jump && !this.crashed ? this.ax : this.along, across);
    this.knock = Math.max(0, this.knock - dt);
    this.still = Math.hypot(dx, dz) < 1e-3 && Math.abs(turned) < 1e-4 ? this.still + 1 : 0;
    if (jump || this.still < 30) this.ground(dt, jump);
    else this.settle(dt); // standing still: it keeps the plane it found
    // Someone else's car stopping dead (it hit something): a thump from it.
    if (!local && along < -18 && this.knock <= 0) {
      this.noise.thump(this.x, this.y, this.z, Math.min(10, -along / 4));
      this.knock = 0.4;
      // Its front (or back, reversing) went into something: what is there.
      const [fx, fz] = this.forward;
      const way = Math.sign(this.lastSpeed) || 1;
      const x = this.x + fx * way * this.halfL;
      const z = this.z + fz * way * this.halfL;
      const at = this.world.touching(x + fx * way * 0.3, z + fz * way * 0.3, this.y + CLEAR, this.y + this.spec.height, 0.4, this.key);
      const tree = this.trees.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.6);
      Car.onCrash({ x, y: this.y + 0.55, z, nx: -fx * way, nz: -fz * way, speed: Math.min(20, -along / 6), what: tree ? 'tree' : at?.key ?? at?.mat ?? at?.name ?? '' });
    }
    // How hard the tyres slide: at the wheel from the tyres themselves (world/carGrip.ts), from 0.4 m/s of
    // slide to all out at 4.4 m/s; others' cars from how they move.
    const slid = (m: number) => Math.min(1, Math.max(0, (m - 0.4) / 4));
    const slip = local ? { front: slid(this.slideF), rear: slid(this.slideR) } : skid(this.speed, this.side, this.along, across, false);
    this.marks(slip, jump);
    let paved = 0;
    let rough = 0;
    for (let i = 0; i < 4; i++) {
      const s = i < 2 ? slip.front : slip.rear;
      if (this.rough[i]) rough = Math.max(rough, s);
      else paved = Math.max(paved, s);
    }
    this.noise.update({
      x: this.x, y: this.y, z: this.z, speed: Math.abs(this.speed),
      load: local ? Math.min(1, this.pushing) : Math.min(1, Math.max(0, this.along / 5)),
      regen: Math.min(1, Math.max(0, (-this.along * Math.sign(this.speed)) / 6)),
      skid: Math.max(paved, rough), rough: rough > paved || this.rough.filter(Boolean).length > 2,    });
    this.lastX = this.x;
    this.lastZ = this.z;
    this.lastYaw = this.yaw;
  }

  /** The ground under the four wheels: the plane the car tilts to, and a knock where one wheel's ground jumps. */
  private ground(dt: number, jump: boolean): void {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const step = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = this.axle.at[i];
      const g = this.world.groundAt(this.x + lx * c + lz * s, this.z - lx * s + lz * c, this.y, CLEAR);
      step[i] = g.y - this.under[i];
      this.under[i] = g.y;
      this.rise[i] = Math.max(-0.35, Math.min(0.35, g.y - this.y));
      this.rough[i] = !g.mat || ROUGH.test(g.mat);
      this.grip[i] = surfaceGrip(g.mat, mood.wet, mood.snow);
    }
    const p = groundPlane(this.rise, this.axle.base, this.axle.track);
    this.plane = { pitch: Math.max(-TILT, Math.min(TILT, p.pitch)), roll: Math.max(-TILT, Math.min(TILT, p.roll)), lift: p.lift, twist: p.twist };
    this.settle(dt, jump);
    // One wheel's ground jumps against the others' (a kerb, the edge of the paving), not a slope under all four.
    if (jump || Math.abs(this.speed) < 1) return;
    const mean = (step[0] + step[1] + step[2] + step[3]) / 4;
    let hard = 0;
    for (let i = 0; i < 4; i++) {
      const e = step[i] - mean;
      if (Math.abs(e) < 0.02 || Math.abs(e) > 0.4) continue;
      this.motion.kick((3 * e * (i < 2 ? 1 : -1)) / (this.axle.base / 2), (3 * e * (i % 2 ? 1 : -1)) / (this.axle.track / 2), 3 * e);
      hard = Math.max(hard, Math.abs(e));
    }
    if (hard > 0.04 && this.knock <= 0) {
      this.noise.thump(this.x, this.y, this.z, 20 * hard * Math.min(1, Math.abs(this.speed) / 8));
      this.knock = 0.25;
    }
  }

  /** The car's tilt and height follow the ground's plane quickly (the tyres give a little); `now`: at once. */
  private settle(dt: number, now = false): void {
    const k = now ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 18);
    const r = this.ride;
    const p = this.plane;
    r.pitch += (p.pitch - r.pitch) * k;
    r.roll += (p.roll - r.roll) * k;
    r.lift += (p.lift - r.lift) * k;
    r.twist += (p.twist - r.twist) * k;
  }

  /** Each sliding tyre on paving lays a strip of mark from where it was to where it is (world/skidMarks.ts). */
  private marks(slip: { front: number; rear: number }, jump: boolean): void {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    for (let i = 0; i < 4; i++) {
      const strength = i < 2 ? slip.front : slip.rear;
      if (jump || strength < 0.12 || this.rough[i]) {
        this.trail[i] = null;
        continue;
      }
      const [lx, lz] = this.axle.at[i];
      const x = this.x + lx * c + lz * s;
      const z = this.z - lx * s + lz * c;
      const y = this.under[i];
      const t = this.trail[i];
      if (!t) {
        this.trail[i] = { x, y, z };
        continue;
      }
      const len = Math.hypot(x - t.x, z - t.z);
      if (len < 0.3) continue;
      if (len < 4) skidMarks.lay(t.x, t.y, t.z, x, y, z, strength);
      t.x = x;
      t.y = y;
      t.z = z;
    }
  }

  /**
   * A placed Tesla taken away: out of the scene and the collision world, its own materials, shadow
   * patch and wheel blur let go (the model's geometry is shared with the other cars of its kind),
   * its sound stopped. Whoever was in it got out first (main.ts).
   */
  dispose(): void {
    this.gone = true;
    this.group.removeFromParent();
    this.world.setMoving(this.key, null);
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.userData.ignoreRay) return; // the shadow patch and the blur discs are this car's own
      o.geometry.dispose();
      const mat = o.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
    });
    for (const m of [this.paint, this.taillight, this.blurMat]) m.dispose();
    this.lamps.dispose();
    this.noise.dispose();
  }

  /** It hit something (`strength` in m/s): a thump from where it is, and the body jolts. */
  bump(strength: number): void {
    this.noise.thump(this.x, this.y, this.z, strength);
    const k = Math.min(1, strength / 10);
    this.motion.kick(0, 0.3 * k * (Math.random() - 0.5), 0.25 * k);
  }
}
