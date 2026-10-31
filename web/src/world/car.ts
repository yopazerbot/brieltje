import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import CARS from '../../shared/car.json';
import { sound } from '../sound';
import type { Point, World } from './collision';

/**
 * The cars you can drive (shared/car.json): the black Tesla Model Y on our driveway and the blue
 * Model 3 at the bungalow. You get in with E (or Triangle) and drive with a camera behind the
 * car; it stops against the house, hedges, fences, trees and other players. In multiplayer one
 * player drives each car at a time and the others see it move (see game.mjs).
 *
 * The models are built in Blender from the cars' published sizes and photos (tools/model_y.py,
 * tools/model_3.py), so they need no licence; both use the same material names, so each gets
 * the game's materials with its own paint. Their wheels are separate parts with their axle as
 * origin, so they roll and the front ones steer.
 */

export type CarSpec = (typeof CARS.cars)[keyof typeof CARS.cars];

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
}

export interface DriveInput {
  throttle: number;
  brake: number;
  /** -1 left .. 1 right */
  steer: number;
  handbrake: boolean;
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
const BRAKE = 9;        // m/s2
const REVERSE = 3;      // m/s2 backwards
const HANDBRAKE = 7;    // m/s2; the rear also lets go, so the car slides
const GRIP = 12;        // how fast sideways sliding dies out (1/s)
const STEER = 0.62;     // rad, the front wheels at full lock (less at speed, see step())
const CLEAR = 0.3;      // m: lower things (kerbs, paving, a step) don't stop the car
const SPIN_STEP = 0.3;  // rad: the most a wheel turns per frame on screen (faster, the spokes seem to stand or run back)

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
      o.castShadow = true;
      o.userData.material = name === 'Glass' || name === 'LampGlass' ? 'black_glass' : 'steel'; // bullets spark off it
      if (name === 'Glass') o.renderOrder = 1; // after the cabin behind it
      o.userData.vehicle = true; // bullet holes stay on it when it drives off (see Decals)
    }
    if (/^Wheel_/.test(o.name)) {
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

let noise: AudioBuffer | null = null;
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise?.sampleRate === c.sampleRate) return noise;
  noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Car {
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
  private vx = 0;
  private vz = 0;
  private braking = false;
  private pushing = 0;
  private body = new THREE.Group();
  private front: THREE.Object3D[] = [];
  private wheels: { pivot: THREE.Object3D; flip: number }[] = [];
  private roll = 0;
  private pitch = 0;
  private lastSpeed = 0;
  private spin = 0;
  // Someone else drives it: smooth between their updates (0.1 s apart).
  private from: CarState | null = null;
  private to: CarState | null = null;
  private t = 1;
  /** Their speed from the last two updates (the frame-by-frame steps are too uneven for the wheels) */
  private netSpeed = 0;
  private poseAt = 0;
  // The camera behind the car.
  private camHeading = 0;
  private camYaw = 0;
  private camPitch = 0.22;
  private lookIdle = 0;
  private audio: { at: PannerNode; whine: OscillatorNode; hum: GainNode; filter: BiquadFilterNode; road: GainNode } | null = null;
  private halfL: number;
  private halfW: number;
  private key: string; // its moving block in the collision world
  private taillight = taillight();
  private blurMat = blurMaterial();

  constructor(private world: World, private trees: Obstacle[], readonly id: string, readonly spec: CarSpec) {
    ({ x: this.x, y: this.y, z: this.z, yaw: this.yaw } = spec.park);
    this.halfL = spec.length / 2;
    this.halfW = spec.width / 2;
    this.key = `car-${id}`;
    this.group.add(this.body, contactShadow(spec));
    const paint = new THREE.MeshStandardMaterial({ color: spec.paint, roughness: 0.2, metalness: 0.45 });
    void new GLTFLoader().loadAsync(spec.model).then((gltf) => {
      const { front, wheels } = prepare(gltf.scene, { Paint: paint, TailLight: this.taillight }, this.blurMat);
      this.body.add(gltf.scene);
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

  /** How far a point on the plan is from the car's sides (0 inside it). */
  distanceTo(x: number, z: number): number {
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
    this.from = this.to = null;
  }

  /** You got out: it rolls to a stop where it is. */
  leave(): void {
    this.vx = this.vz = this.speed = 0;
    this.braking = false;
    this.pushing = 0;
  }

  /** Through a portal: standing still at (x, y, z) facing `yaw`, the camera behind it. */
  place(x: number, y: number, z: number, yaw: number): void {
    Object.assign(this, { x, y, z, yaw, steer: 0, speed: 0, vx: 0, vz: 0, lastSpeed: 0, braking: false, camHeading: yaw, camYaw: 0 });
    this.from = this.to = null;
  }

  /** Where the server says it is (someone else drives it, or it stands where it was left). */
  setPose(s: CarState, snap = false): void {
    this.driver = s.driver;
    this.passenger = s.passenger ?? null;
    if (snap || !this.to || Math.hypot(s.x - this.x, s.z - this.z) > 10) {
      Object.assign(this, { x: s.x, y: s.y, z: s.z, yaw: s.yaw, steer: s.s, speed: 0 });
      this.from = this.to = s;
      this.t = 1;
      return;
    }
    const now = performance.now();
    const gap = (now - this.poseAt) / 1000;
    if (gap > 0.02 && gap < 1) this.netSpeed = ((s.x - this.to.x) * -Math.sin(s.yaw) + (s.z - this.to.z) * -Math.cos(s.yaw)) / gap;
    this.poseAt = now;
    this.from = { id: this.id, x: this.x, y: this.y, z: this.z, yaw: this.yaw, s: this.steer, driver: s.driver, passenger: s.passenger };
    this.to = s;
    this.t = 0;
  }

  /** One frame at the wheel; `others` are the players around. Returns how hard it hit something (m/s), 0 if it didn't. */
  drive(dt: number, input: DriveInput, others: Obstacle[]): number {
    const near = [...others, ...this.trees.filter((o) => Math.abs(o.x - this.x) < 8 && Math.abs(o.z - this.z) < 8)];
    const steps = Math.max(1, Math.ceil(dt * 120));
    let impact = 0;
    for (let i = 0; i < steps; i++) impact = Math.max(impact, this.step(dt / steps, input, near));
    this.braking = (input.brake > 0.05 && this.speed > 0.3) || (input.throttle > 0.05 && this.speed < -0.3) || (input.handbrake && Math.abs(this.speed) > 0.3);
    this.pushing = input.throttle || input.brake;
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
    let v = this.vx * fx + this.vz * fz; // along the car
    let side = -this.vx * fz + this.vz * fx; // sideways
    if (input.throttle > 0) {
      v += v < -0.3 ? BRAKE * input.throttle * dt : ACCEL * input.throttle * Math.max(0, 1 - (v / this.spec.maxSpeed) ** 2) * dt;
    }
    if (input.brake > 0) {
      v -= v > 0.3 ? BRAKE * input.brake * dt : REVERSE * input.brake * Math.max(0, 1 + v / this.spec.reverseSpeed) * dt;
    }
    if (input.handbrake) v -= Math.sign(v) * Math.min(Math.abs(v), HANDBRAKE * dt);
    v -= Math.sign(v) * Math.min(Math.abs(v), (0.4 + 0.002 * v * v) * dt); // rolling and air: it coasts to a stop
    v = Math.max(-this.spec.reverseSpeed, Math.min(this.spec.maxSpeed, v));
    side *= Math.exp(-dt * (input.handbrake ? 2 : GRIP));

    // Full lock at a crawl (4.3 m turning radius), about 9 m at 36 km/h, 24 m at 72 km/h: sharp in
    // the village streets, not twitchy flat out. The wheel turns in over about 0.15 s.
    const lock = STEER / (1 + (Math.abs(v) / 9) ** 1.6);
    this.steer += (-input.steer * lock - this.steer) * (1 - Math.exp(-dt * 12));
    const yaw = angle(this.yaw + (v / WHEELBASE) * Math.tan(this.steer) * dt);
    fx = -Math.sin(yaw);
    fz = -Math.cos(yaw);
    let vx = fx * v - fz * side;
    let vz = fz * v + fx * side;
    const x = this.x + vx * dt;
    const z = this.z + vz * dt;

    let impact = 0;
    // Already stuck in something (a door swung into it): let it drive out.
    if (this.free(x, z, yaw, others) || !this.free(this.x, this.z, this.yaw, others)) {
      Object.assign(this, { x, z, yaw });
    } else if (this.free(x, this.z, this.yaw, others)) {
      impact = Math.abs(vz); // slides along a wall
      this.x = x;
      vz = 0;
    } else if (this.free(this.x, z, this.yaw, others)) {
      impact = Math.abs(vx);
      this.z = z;
      vx = 0;
    } else {
      impact = Math.hypot(vx, vz);
      vx *= -0.15;
      vz *= -0.15;
    }
    this.vx = vx;
    this.vz = vz;
    [fx, fz] = this.forward;
    this.speed = vx * fx + vz * fz;
    return impact;
  }

  /**
   * The camera behind the car. `turnX` and `turnY` (radians) look around it; when you
   * stop looking it swings back behind the car as you drive.
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
    this.camHeading += angle(this.yaw - this.camHeading) * (1 - Math.exp(-dt * 5));
    const h = this.camHeading + this.camYaw;
    const dist = 6.5;
    const target: Point = { x: this.x, y: this.y + 1.4, z: this.z };
    const want: Point = {
      x: target.x + Math.sin(h) * Math.cos(this.camPitch) * dist,
      y: target.y + Math.sin(this.camPitch) * dist,
      z: target.z + Math.cos(h) * Math.cos(this.camPitch) * dist,
    };
    // Something between the car and the camera (a wall, a hedge): come closer.
    const k = Math.max(0.15, this.world.clearance(target, want, this.key) - 0.3 / dist);
    camera.position.set(target.x + (want.x - target.x) * k, target.y + (want.y - target.y) * k, target.z + (want.z - target.z) * k);
    camera.lookAt(target.x, target.y, target.z);
  }

  /** Every frame: follow the driver (`local`: you drive, or nobody does), then wheels, lean, lights, its block and its sound. */
  update(dt: number, local: boolean): void {
    if (!local && this.from && this.to) {
      this.t = Math.min(1, this.t + dt / 0.1);
      const f = this.from;
      const t = this.to;
      const x = f.x + (t.x - f.x) * this.t;
      const z = f.z + (t.z - f.z) * this.t;
      if (performance.now() - this.poseAt > 400) this.netSpeed = 0; // no news: it stands
      this.speed += (this.netSpeed - this.speed) * (1 - Math.exp(-dt * 6));
      this.braking = this.speed - this.lastSpeed < -3 * dt && Math.abs(this.speed) > 0.5;
      Object.assign(this, { x, z, y: f.y + (t.y - f.y) * this.t, yaw: f.yaw + angle(t.yaw - f.yaw) * this.t, steer: f.s + (t.s - f.s) * this.t });
    }
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
    const turnRate = Math.abs(this.speed) / WHEEL_R; // rad/s
    this.spin -= Math.sign(this.speed) * Math.min(turnRate * dt, SPIN_STEP);
    for (const w of this.wheels) w.pivot.rotation.x = this.spin * w.flip;
    this.blurMat.opacity = Math.min(0.92, Math.max(0, (turnRate - 12) / 25));
    this.blurMat.visible = this.blurMat.opacity > 0.02;
    for (const w of this.front) w.rotation.y = w.userData.baseYaw + this.steer;
    // The body leans back when it speeds up, forward when it brakes, and out of a turn.
    if (dt > 0) {
      const accel = (this.speed - this.lastSpeed) / dt;
      const turn = (this.speed * this.speed * Math.tan(this.steer)) / WHEELBASE;
      const k = 1 - Math.exp(-dt * 6);
      this.pitch += (Math.max(-0.04, Math.min(0.04, accel * 0.005)) - this.pitch) * k;
      this.roll += (Math.max(-0.05, Math.min(0.05, -turn * 0.004)) - this.roll) * k;
      this.body.rotation.set(this.pitch, 0, this.roll);
    }
    this.lastSpeed = this.speed;
    this.taillight.emissiveIntensity = this.braking ? 2.5 : 0.5;
    this.world.setMoving(this.key, this.footprint(), this.y, this.y + this.spec.height);
    this.hum(local);
  }

  /** It hit something: a thud from where it is. */
  bump(strength: number): void {
    const c = sound.context();
    const at = sound.at(this.x, this.y + 0.5, this.z, 3);
    if (!c || !at) return;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 180 + strength * 30;
    const gain = c.createGain();
    const t = c.currentTime;
    gain.gain.setValueAtTime(Math.min(1, strength / 8), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(filter).connect(gain).connect(at);
    src.start(t);
    src.stop(t + 0.4);
  }

  /** An electric car is quiet: a soft whine that rises with speed (louder on the pedal), and tyre noise. */
  private hum(local: boolean): void {
    const speed = Math.abs(this.speed);
    if (!this.audio && speed < 0.5) return; // not before it first moves (after you have pressed something)
    const c = sound.context();
    if (!c) return;
    if (!this.audio) {
      const at = sound.at(this.x, this.y + 0.5, this.z, 4) as PannerNode;
      const whine = c.createOscillator();
      whine.type = 'triangle';
      const hum = c.createGain();
      hum.gain.value = 0;
      whine.connect(hum).connect(at);
      const tyres = c.createBufferSource();
      tyres.buffer = noiseBuffer(c);
      tyres.loop = true;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      const road = c.createGain();
      road.gain.value = 0;
      tyres.connect(filter).connect(road).connect(at);
      whine.start();
      tyres.start();
      this.audio = { at, whine, hum, filter, road };
    }
    const a = this.audio;
    const t = c.currentTime;
    a.at.positionX.setTargetAtTime(this.x, t, 0.03);
    a.at.positionY.setTargetAtTime(this.y + 0.5, t, 0.03);
    a.at.positionZ.setTargetAtTime(this.z, t, 0.03);
    a.whine.frequency.setTargetAtTime(90 + speed * 32, t, 0.05);
    const pedal = local ? 0.4 + 0.6 * this.pushing : 0.7;
    a.hum.gain.setTargetAtTime(Math.min(0.035, speed * 0.004) * pedal, t, 0.1);
    a.filter.frequency.setTargetAtTime(250 + speed * 110, t, 0.1);
    a.road.gain.setTargetAtTime(Math.min(0.15, speed * 0.008), t, 0.1);
  }
}
