import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import HELIS from '../../shared/heli.json';
import { EV, HELI, heliBump, heliPlace, heliStart, heliStep, type HeliEnv, type HeliInput, type HeliState } from '../../shared/heli.mjs';
import type { CrashHit, Obstacle } from './car';
import type { World } from './collision';
import { HeliSound } from './heliSound';
import { padNear } from './heliPads';
import { waterLevel } from './water';
import { windAt } from './wind';

/**
 * The helicopters (shared/heli.json; the flight is shared/heli.mjs): a light twin with a shrouded tail rotor, by the
 * main house for now. You get in with the use key and fly with a camera behind it (or from the pilot's seat). It rests
 * on whatever floor is under its skids, its fuselage stops against walls (the cabin and the tail boom as two boxes),
 * its rotor disc touches what it reaches (eight points round its rim), tree crowns slow it and shake leaves out, and a
 * hard knock is a bump: sparks or dust, a clang, set down level, the engine off for a few seconds. Never a fire,
 * nobody hurt.
 *
 * The model is web/public/models/helicopter.glb (tools/helicopter.py), built to the interface in heli.json `size`:
 * nose to -Z, origin on the ground under the hub, the nodes Body, Detail, Rotor (Blade_1 to 4), RotorDisc, TailRotor,
 * TailDisc, Far, the seats and the eye. Until it is there, or when it fails to load, heliShape() stands in: boxes of
 * those sizes with those names, made here.
 */

export type HeliSpec = (typeof HELIS.machines)[number];
/** A tree from the world's list: its foot, its height and its crown's radius. */
export interface Crown {
  x: number;
  z: number;
  y: number;
  h: number;
  r: number;
}

const SIZE = HELIS.size;
const MODEL = '/models/helicopter.glb';
/** The player's system asks for less motion: no shudder, no wider view at speed. */
const CALM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const DRAW = 400; // m from the eye: further off it isn't drawn
const DETAIL = 40; // m: the small parts go further off
const FAR = 90; // m: the simple copy from here (FAR_LOW on Low and phones)
const FAR_LOW = 45;
const RPM = (395 * 2 * Math.PI) / 60; // rad/s of the main rotor at full speed
const TAIL_RPM = (3530 * 2 * Math.PI) / 60;
const SPIN_STEP = 0.35; // rad: the most the rotor turns per frame on screen
const BLADES_UNTIL = 0.6; // the rotor's speed up to which its blades show (the disc from 0.45)
const SHADOW_PARTS = new Set(['Paint', 'Glass', 'Trim', 'Interior']);
const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

let lowDetail = false;
/** The graphics preset changed (main.ts): the simple copy from nearer on Low and on phones. */
export function setHeliDetail(low: boolean): void {
  lowDetail = low;
}

/** The game's materials by the model's names (as car.ts prepare does); each machine has its own paint. */
const SHARED: Record<string, THREE.Material> = {
  Glass: new THREE.MeshStandardMaterial({ color: '#0b0f14', roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.55, depthWrite: false, envMapIntensity: 1.6 }),
  Trim: new THREE.MeshStandardMaterial({ color: '#1a1c1f', roughness: 0.6 }),
  Metal: new THREE.MeshStandardMaterial({ color: '#8a8d92', roughness: 0.35, metalness: 0.8 }),
  Rubber: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.9 }),
  Interior: new THREE.MeshStandardMaterial({ color: '#24262a', roughness: 0.85 }),
  Screen: new THREE.MeshStandardMaterial({ color: '#0a0c10', roughness: 0.1, metalness: 0.2 }),
  Gap: new THREE.MeshStandardMaterial({ color: '#000000', roughness: 0.9 }),
  LightRed: new THREE.MeshStandardMaterial({ color: '#5a0a0d', emissive: '#ff2020', emissiveIntensity: 0.5 }),
  LightGreen: new THREE.MeshStandardMaterial({ color: '#0a4a14', emissive: '#20ff40', emissiveIntensity: 0.5 }),
  LightWhite: new THREE.MeshStandardMaterial({ color: '#d8dade', emissive: '#ffffff', emissiveIntensity: 0.3 }),
  LightBeacon: new THREE.MeshStandardMaterial({ color: '#5a0a0d', emissive: '#ff3020', emissiveIntensity: 0.4 }),
  LightLanding: new THREE.MeshStandardMaterial({ color: '#d8dade', roughness: 0.1 }),
};
const gapLines = new THREE.LineBasicMaterial({ color: '#000000', transparent: true, opacity: 0.6, depthWrite: false });

/**
 * The rotor's blur: a flat ring, see-through, darker towards its tips with four faint sweeps that turn slowly (a few
 * shader lines: radius and angle from the position, no texture). `opacity` follows the rotor's speed.
 */
function discMaterial(): THREE.MeshBasicMaterial & { userData: { phase: { value: number } } } {
  const m = new THREE.MeshBasicMaterial({ color: '#1b1d20', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const phase = { value: 0 };
  m.userData.phase = phase;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.discPhase = phase;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDisc;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDisc = position.xy;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDisc;\nuniform float discPhase;\nuniform float discOuter;')
      .replace('#include <opaque_fragment>', `float discR = length( vDisc ) / discOuter;
        float discA = atan( vDisc.y, vDisc.x );
        float sweep = 0.78 + 0.22 * sin( discA * 4.0 + discPhase );
        diffuseColor.a *= ( 0.3 + 0.7 * smoothstep( 0.08, 0.85, discR ) ) * sweep * ( 1.0 - smoothstep( 0.95, 1.0, discR ) );
        diffuseColor.a += 0.25 * opacity * ( smoothstep( 0.9, 0.95, discR ) - smoothstep( 0.97, 1.0, discR ) );
        #include <opaque_fragment>`);
    shader.uniforms.discOuter = { value: m.userData.outer ?? 1 };
  };
  m.customProgramCacheKey = () => 'heli-disc';
  return m as THREE.MeshBasicMaterial & { userData: { phase: { value: number } } };
}

/** A placeholder material by the model's name, swapped for the game's (prepare). */
const named = (name: string) => new THREE.MeshStandardMaterial({ name });

/**
 * The stand-in until the model is in (and if it fails to load): boxes and discs of the interface's sizes (heli.json
 * size) with its node names and pivots, as carShape stands in for a car. Nose to -Z, origin on the ground under the hub.
 */
export function heliShape(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Scene';
  const body = new THREE.Group();
  body.name = 'Body';
  const box = (w: number, h: number, l: number, x: number, y: number, z: number, mat: string) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), named(mat));
    m.position.set(x, y, z);
    body.add(m);
    return m;
  };
  const c = SIZE.cabin;
  const cabinL = c.z1 - c.z0;
  // The cabin: a body box, the glass of the nose in front, the engines' hump on its roof.
  box(c.halfX * 2, c.y1 - c.y0 - 0.25, cabinL - 1.3, 0, c.y0 + (c.y1 - c.y0 - 0.25) / 2, c.z0 + 1.3 + (cabinL - 1.3) / 2, 'Paint');
  box(c.halfX * 2 - 0.1, c.y1 - c.y0 - 0.55, 1.3, 0, c.y0 + 0.2 + (c.y1 - c.y0 - 0.55) / 2, c.z0 + 0.65, 'Glass');
  box(c.halfX * 2 - 0.12, 0.35, 1.3, 0, c.y0 + 0.17, c.z0 + 0.65, 'PaintB');
  box(1.2, 0.45, 2.6, 0, c.y1 + 0.0, 0.3, 'PaintB');
  box(c.halfX * 2 + 0.02, 0.5, 1.4, 0, 1.55, -0.6, 'Glass'); // the side windows of the doors
  // The tail boom, its fin and the shroud round the tail rotor.
  const b = SIZE.boom;
  box(0.5, 0.55, b.z1 - b.z0 - 0.9, 0, 1.8, b.z0 + (b.z1 - b.z0 - 0.9) / 2, 'Paint');
  box(0.16, b.y1 - 2.4, 0.9, 0, (b.y1 + 2.4) / 2, b.z1 - 0.45, 'PaintC');
  box(2.65, 0.06, 0.5, 0, 1.9, 5.0, 'PaintB'); // the stabiliser
  const tr = SIZE.tailRotor;
  const shroud = new THREE.Mesh(new THREE.TorusGeometry(tr.r + 0.08, 0.12, 8, 24).rotateY(Math.PI / 2), named('PaintB'));
  shroud.position.set(0, tr.y, tr.z);
  body.add(shroud);
  // The skids: two tubes on two cross tubes.
  for (const x of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.3, 8).rotateX(Math.PI / 2), named('Metal'));
    skid.position.set(x * (SIZE.skidX - 0.05), 0.05, -0.1);
    body.add(skid);
  }
  for (const z of [-1, 0.9]) {
    const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, SIZE.skidX * 2, 6).rotateZ(Math.PI / 2), named('Metal'));
    cross.position.set(0, 0.32, z);
    body.add(cross);
  }
  root.add(body);
  // The main rotor: a hub and four blades from their roots, on a mast leaning 5 degrees forward.
  const rotor = new THREE.Group();
  rotor.name = 'Rotor';
  rotor.position.set(0, SIZE.rotor.y, 0);
  rotor.rotation.x = -0.087;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.35, 10), named('Metal'));
  rotor.add(hub);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Group();
    blade.name = `Blade_${i + 1}`;
    blade.rotation.y = (i * Math.PI) / 2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(SIZE.rotor.r - 0.25, 0.04, 0.29).translate(0.25 + (SIZE.rotor.r - 0.25) / 2, 0, 0), named('Trim'));
    blade.add(m);
    rotor.add(blade);
  }
  root.add(rotor);
  const disc = new THREE.Mesh(new THREE.RingGeometry(0.4, SIZE.rotor.r, 48, 1), named('RotorBlur'));
  disc.name = 'RotorDisc';
  disc.position.copy(rotor.position);
  disc.rotation.set(-Math.PI / 2 - 0.087, 0, 0);
  root.add(disc);
  // The tail rotor in its shroud, turning about X.
  const tail = new THREE.Group();
  tail.name = 'TailRotor';
  tail.position.set(0, tr.y, tr.z);
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, tr.r * 2 - 0.05, 0.09), named('Trim'));
    m.rotation.x = (i * Math.PI) / 5;
    tail.add(m);
  }
  root.add(tail);
  const tailDisc = new THREE.Mesh(new THREE.CircleGeometry(tr.r, 24), named('RotorBlur'));
  tailDisc.name = 'TailDisc';
  tailDisc.position.copy(tail.position);
  tailDisc.rotation.y = Math.PI / 2;
  root.add(tailDisc);
  // The points the game and the people aboard use (heli.md section 5), and the parts the model has that this lacks.
  const empty = (name: string, x: number, y: number, z: number) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    root.add(o);
  };
  empty('Eye_Pilot', SIZE.eye[0], SIZE.eye[1], SIZE.eye[2]);
  empty('Step_L', SIZE.steps[0][0], 0, SIZE.steps[0][1]);
  empty('Step_R', SIZE.steps[1][0], 0, SIZE.steps[1][1]);
  for (const [i, [x, z]] of [[0.4, -1.7], [-0.4, -1.7], [0.4, 0.6], [-0.4, 0.6], [0.4, -0.4], [-0.4, -0.4]].entries()) empty(`Seat_${i}`, x, SIZE.seat, z);
  for (const name of ['Detail', 'Far']) {
    const o = new THREE.Group();
    o.name = name;
    root.add(o);
  }
  return root;
}

/** The model, fetched once: the real one when it is there (a glTF file), else null (the stand-in is used). */
let model: Promise<THREE.Group | null> | null = null;
function loadModel(): Promise<THREE.Group | null> {
  model ??= fetch(MODEL)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => {
      // A dev server answers a missing file with the page: only a binary glTF ("glTF") is the model.
      if (!buf || buf.byteLength < 12 || new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'glTF') return null;
      return new GLTFLoader().parseAsync(buf, '/models/').then((g) => g.scene);
    })
    .catch(() => null);
  return model;
}

/** A soft round shadow under the machine at any height, so the height shows without real-time shadows. */
function contactShadow(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, color: '#000000' });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
  m.userData.ignoreRay = true;
  return m;
}

export class Heli {
  /** It hit something (sparks, dust or leaves and a crunch by what it was: world/crash.ts via main.ts). */
  static onHit: (hit: CrashHit) => void = () => {};
  readonly group = new THREE.Group();
  readonly s: HeliState;
  /** Where it stands when nobody flies it */
  readonly park: { x: number; y: number; z: number; yaw: number };
  /** Someone else flies it (later, together), or null */
  pilot: string | null = null;
  /** You fly it */
  flown = false;
  /** In the game (it is drawn and solid) */
  ready = true;
  /** The view a little wider at speed (main.ts multiplies the field of view by it). */
  fovScale = 1;
  /** 'chase' behind it, or 'cockpit' from the pilot's seat */
  view: 'chase' | 'cockpit' = 'chase';
  private body = new THREE.Group();
  private shadow = contactShadow();
  private near: THREE.Object3D | null = null;
  private far: THREE.Object3D | null = null;
  private detail: THREE.Object3D | null = null;
  private rotor: THREE.Object3D | null = null;
  private blades: THREE.Object3D[] = [];
  private tail: THREE.Object3D | null = null;
  private disc: THREE.Mesh | null = null;
  private tailDisc: THREE.Mesh | null = null;
  private discMat = discMaterial();
  private tailMat = discMaterial();
  private paints: Record<string, THREE.MeshStandardMaterial>;
  private eye = new THREE.Vector3(...(SIZE.eye as [number, number, number]));
  private key: string;
  private noise = new HeliSound();
  private spin = 0;
  private tailSpin = 0;
  private strikes: number[] = [];
  private struckAt = 0;
  private leavesAt = 0;
  private clock = 0;
  private startWhoosh = 0;
  private warmOn = false;
  // The camera.
  private camHeading = 0;
  private camTilt = 0;
  private camLand = 0;
  private lookIdle = 0;
  private lookPitch = 0;
  // The trees' crowns by 32 m square, built when the list grows.
  private crownCells = new Map<number, Crown[]>();
  private crownCount = -1;

  constructor(private world: World, private crowns: Crown[], readonly spec: HeliSpec, private skipCrown: (x: number, z: number) => boolean = () => false) {
    this.park = { ...spec.park };
    this.s = heliStart(spec.park);
    this.key = `heli-${spec.id}`;
    const colours = HELIS.paints[spec.paint as keyof typeof HELIS.paints] ?? HELIS.paints.sun;
    const paint = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.32, metalness: 0.15, envMapIntensity: 1.4 });
    this.paints = { Paint: paint(colours.paint), PaintB: paint(colours.paintB), PaintC: paint(colours.paintC) };
    (this.discMat.userData as { outer?: number }).outer = SIZE.rotor.r;
    (this.tailMat.userData as { outer?: number }).outer = SIZE.tailRotor.r;
    this.group.add(this.body, this.shadow);
    this.group.userData.heli = spec.id;
    this.body.rotation.order = 'YXZ';
    this.dress(heliShape());
    void loadModel().then((scene) => {
      if (scene) this.dress(scene.clone());
    });
    this.pose();
  }

  /** The model (or the stand-in) on the body with the game's materials; its moving parts found by name. */
  private dress(scene: THREE.Object3D): void {
    if (this.near) this.body.remove(this.near);
    if (this.far) this.body.remove(this.far);
    const far = scene.getObjectByName('Far') ?? null;
    if (far) far.removeFromParent();
    const own: Record<string, THREE.Material> = { ...this.paints, RotorBlur: this.discMat };
    const prep = (root: THREE.Object3D) => root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const name = (o.material as THREE.Material).name;
        o.material = own[name] ?? SHARED[name] ?? SHARED.Trim;
        o.castShadow = SHADOW_PARTS.has(name);
        o.userData.material = name === 'Glass' ? 'black_glass' : 'steel'; // bullets spark off it
        o.userData.vehicle = true;
        if (name === 'Glass') o.renderOrder = 1;
      } else if (o instanceof THREE.LineSegments) {
        o.material = gapLines;
        o.raycast = () => {};
      }
    });
    prep(scene);
    this.near = scene;
    this.body.add(scene);
    this.far = far && far.children.length ? far : null;
    if (this.far) {
      prep(this.far);
      this.far.visible = false;
      this.body.add(this.far);
    }
    this.detail = scene.getObjectByName('Detail') ?? null;
    this.rotor = scene.getObjectByName('Rotor') ?? null;
    this.blades = [1, 2, 3, 4].map((i) => scene.getObjectByName(`Blade_${i}`)).filter((b): b is THREE.Object3D => !!b);
    for (const b of this.blades) b.userData.baseZ ??= b.rotation.z;
    this.tail = scene.getObjectByName('TailRotor') ?? null;
    this.disc = (scene.getObjectByName('RotorDisc') as THREE.Mesh | undefined) ?? null;
    this.tailDisc = (scene.getObjectByName('TailDisc') as THREE.Mesh | undefined) ?? null;
    if (this.disc) {
      this.disc.material = this.discMat;
      this.disc.castShadow = false;
      this.disc.renderOrder = 2;
    }
    if (this.tailDisc) {
      this.tailDisc.material = this.tailMat;
      this.tailDisc.castShadow = false;
      this.tailDisc.renderOrder = 2;
    }
    const eye = scene.getObjectByName('Eye_Pilot');
    if (eye) this.eye.copy(eye.position);
  }

  private get forward(): [number, number] {
    return [-Math.sin(this.s.yaw), -Math.cos(this.s.yaw)];
  }

  /** How far a point on the plan is from the cabin's sides (0 inside), for getting in. */
  distanceTo(x: number, z: number): number {
    if (!this.ready) return Infinity;
    const [fx, fz] = this.forward;
    const c = SIZE.cabin;
    const mid = -(c.z0 + c.z1) / 2; // the cabin's middle ahead of the hub
    const dx = x - (this.s.x + fx * mid);
    const dz = z - (this.s.z + fz * mid);
    return Math.hypot(Math.max(0, Math.abs(dx * fx + dz * fz) - (c.z1 - c.z0) / 2), Math.max(0, Math.abs(-dx * fz + dz * fx) - SIZE.skidX));
  }

  /** Its outline on the plan: the cabin over the skids and the tail boom (the minimap, its block). */
  footprint(): [number, number][] {
    const [fx, fz] = this.forward;
    const [rx, rz] = [-fz, fx];
    const c = SIZE.cabin;
    const b = SIZE.boom;
    const w = SIZE.skidX;
    const at = (x: number, z: number): [number, number] => [this.s.x + rx * x - fx * z, this.s.z + rz * x - fz * z];
    return [at(-w, c.z0), at(w, c.z0), at(w, c.z1), at(b.halfX, c.z1), at(b.halfX, b.z1), at(-b.halfX, b.z1), at(-b.halfX, c.z1), at(-w, c.z1)];
  }

  /** Whether you may get out now: on a floor, or within 1.5 m of one and slow. */
  get canLeave(): boolean {
    return this.s.ground || (this.s.h < 1.5 && Math.hypot(this.s.vx, this.s.vz) < 1.5 && Math.abs(this.s.vy) < 1.5);
  }

  /** Where you stand after getting out: by the pilot's door (the right) or the left one, on a floor within 0.5 m, free; else null. */
  exitSpot(): { x: number; y: number; z: number } | null {
    const [fx, fz] = this.forward;
    const [rx, rz] = [-fz, fx];
    const floor = this.s.floor;
    const spots = [[1.6, -0.6], [-1.6, -0.6], [1.6, 0.8], [-1.6, 0.8], [0, -4]].map(([x, z]) => ({ x: this.s.x + rx * x - fx * z, z: this.s.z + rz * x - fz * z }));
    for (const p of spots) {
      const g = this.world.groundAt(p.x, p.z, floor + 0.5, 0).y;
      if (Math.abs(g - floor) > 0.5) continue;
      if (this.world.boxFree(p.x, p.z, 0, 0.3, 0.3, g + 0.4, g + 1.8, this.key)) return { x: p.x, y: g, z: p.z };
    }
    return null;
  }

  /** You got in: the camera starts behind it. */
  enter(): void {
    this.flown = true;
    this.camHeading = this.s.yaw;
    this.camTilt = 0;
    this.lookPitch = 0;
    this.camLand = this.s.h < 15 ? 1 : 0;
    this.view = 'chase';
  }

  /** You got out: the engine stops and the rotor runs down; just over a floor it is set down on it. */
  leave(): void {
    this.flown = false;
    if (!this.s.ground) heliPlace(this.s, this.s.x, this.s.floor, this.s.z, this.s.yaw, this.s.rotor);
    this.s.engine = false;
    this.s.coll = 0;
  }

  /** Put somewhere (a dev hook): still on the floor at (x, y, z) facing `yaw`, its rotor at `rotor` (and running with it). */
  place(x: number, y: number, z: number, yaw: number, rotor = 0): void {
    heliPlace(this.s, x, y, z, yaw, rotor);
    this.camHeading = yaw;
    this.pose();
  }

  /** The world round it for a step: floors (water and people's heads too), the ceiling, the wind, the edge, a pad. */
  private env(others: Obstacle[]): HeliEnv {
    const w = windAt(this.s.x, this.s.z);
    const ground = (x: number, z: number, top: number) => {
      let y = this.world.groundAt(x, z, top, 0).y;
      const water = waterLevel(x, z);
      if (water !== null && water > y && water <= top) y = water;
      // Nobody is landed on: over a person the floor is just above their head.
      for (const o of others) if (Math.hypot(o.x - x, o.z - z) < o.r + 0.4) y += 2.1;
      return y;
    };
    const edge = this.world.bounds?.nearest(this.s.x, this.s.z, HELI.EDGE_PAD) ?? null;
    const pad = padNear(this.s.x, this.s.z, HELI.MAGNET_R + 1);
    return { ground, ceiling: this.world.skyAt(this.s.x, this.s.z), wind: [w.x, w.z], edge, pad };
  }

  /**
   * One frame of flight (`input` from heliPilot.ts, or none when nobody flies it and it is still running down):
   * sub-steps at 120 a second with the fuselage against the walls each, then the rotor's rim and the tree crowns.
   * Returns how hard it hit something this frame (m/s), 0 if it didn't.
   */
  fly(dt: number, input: HeliInput, others: Obstacle[] = []): number {
    if (!(dt > 0)) return 0;
    const s = this.s;
    s.ev = 0;
    s.hit = 0;
    const env = this.env(others);
    const steps = Math.min(48, Math.max(1, Math.ceil(dt * 120)));
    const h = Math.min(dt, 0.4) / steps;
    let impact = 0;
    for (let i = 0; i < steps; i++) {
      const was = { x: s.x, y: s.y, z: s.z };
      heliStep(s, input, env, h);
      impact = Math.max(impact, this.walls(was));
    }
    this.clock += dt;
    impact = Math.max(impact, this.rim(dt), this.crownsAt(dt));
    if (s.ev & (EV.BUMP | EV.SETTLE | EV.BOUNCE)) impact = Math.max(impact, s.hit);
    this.events();
    this.pose();
    return impact;
  }

  /** The cabin's and the tail boom's boxes clear of the walls at (x, z) and its height now. */
  private free(x: number, z: number): boolean {
    const s = this.s;
    const [fx, fz] = this.forward;
    const c = SIZE.cabin;
    const b = SIZE.boom;
    const cabinMid = -(c.z0 + c.z1) / 2;
    const boomMid = -(b.z0 + b.z1) / 2;
    const tailLift = Math.sin(s.pitch) * -boomMid; // nose down, the tail rises
    return this.world.boxFree(x + fx * cabinMid, z + fz * cabinMid, s.yaw, (c.z1 - c.z0) / 2, c.halfX, s.y + c.y0, s.y + c.y1, this.key)
      && this.world.boxFree(x + fx * boomMid, z + fz * boomMid, s.yaw, (b.z1 - b.z0) / 2, b.halfX, s.y + b.y0 + tailLift, s.y + b.y1 + tailLift, this.key);
  }

  /** After a step from `was`: against a wall it stops on that axis and bounces back a little; hard, a bump. */
  private walls(was: { x: number; y: number; z: number }): number {
    const s = this.s;
    // Up into a slab or a roof's underside over the rotor's head: the climb stops.
    const over = this.world.ceilingAbove(s.x, s.z, 1, was.y + SIZE.cabin.y1, s.y + SIZE.rotor.y + 0.4);
    if (over !== null && s.y + SIZE.rotor.y + 0.4 > over) {
      s.y = Math.min(s.y, over - SIZE.rotor.y - 0.4);
      s.vy = Math.min(0, s.vy);
    }
    if (this.free(s.x, s.z)) return 0;
    let impact: number;
    const [vx, vz] = [s.vx, s.vz];
    if (this.free(s.x, was.z)) {
      impact = Math.abs(vz);
      s.z = was.z;
      s.vz *= -0.3;
    } else if (this.free(was.x, s.z)) {
      impact = Math.abs(vx);
      s.x = was.x;
      s.vx *= -0.3;
    } else {
      impact = Math.hypot(vx, vz);
      s.x = was.x;
      s.z = was.z;
      s.vx *= -0.3;
      s.vz *= -0.3;
      if (!this.free(s.x, s.z)) {
        // It sank onto something its skids don't stand on (a kerb, a low wall under the cabin): it rests on it.
        s.y = Math.max(s.y, was.y);
        s.vy = Math.max(0, s.vy);
      }
    }
    if (impact > 0.5) this.contact(vx, vz, impact);
    if (impact > HELI.BODY_HARD && s.down <= 0) heliBump(s, impact);
    return impact;
  }

  /** Where it touched going along (vx, vz), what is there, for the sparks or dust. */
  private contact(vx: number, vz: number, speed: number): void {
    const s = this.s;
    const v = Math.hypot(vx, vz) || 1;
    const [dx, dz] = [vx / v, vz / v];
    const x = s.x + dx * 2.4, z = s.z + dz * 2.4;
    const at = this.world.touching(x, z, s.y + 0.3, s.y + 3.5, 0.9, this.key);
    Heli.onHit({ x, y: s.y + 1.3, z, nx: -dx, nz: -dz, speed, what: at?.key ?? at?.mat ?? at?.name ?? '' });
    this.noise.thump(x, s.y, z, speed);
  }

  /** The rotor disc's rim against the world, eight points round it: pushed away, slowed, sparks; often or hard, a bump. */
  private rim(dt: number): number {
    const s = this.s;
    if (s.rotor < 0.3 || !this.ready) return 0;
    const [fx, fz] = this.forward;
    const [rx, rz] = [-fz, fx];
    const hubY = s.y + SIZE.rotor.y;
    const R = SIZE.rotor.r * 0.97;
    let hit: { x: number; y: number; z: number; what: string } | null = null;
    for (let k = 0; k < 8 && !hit; k++) {
      const a = (k * Math.PI) / 4;
      const ahead = Math.cos(a) * R, right = Math.sin(a) * R;
      const x = s.x + fx * ahead + rx * right;
      const z = s.z + fz * ahead + rz * right;
      const y = hubY - ahead * Math.sin(s.pitch) - right * Math.sin(s.roll);
      const t = this.world.touching(x, z, y - 0.2, y + 0.2, 0.4, this.key);
      if (t) hit = { x, y, z, what: t.key ?? t.mat ?? t.name ?? '' };
    }
    if (!hit) return 0;
    // Away from it, and 60 % of the speed towards it gone.
    let ax = s.x - hit.x, az = s.z - hit.z;
    const d = Math.hypot(ax, az) || 1;
    ax /= d;
    az /= d;
    const towards = -(s.vx * ax + s.vz * az);
    if (towards > 0) {
      s.vx += ax * towards * 1.6;
      s.vz += az * towards * 1.6;
    }
    s.x += ax * Math.min(0.2, 3 * dt);
    s.z += az * Math.min(0.2, 3 * dt);
    if (this.clock - this.struckAt < 0.4) return 0; // one strike per touch
    this.struckAt = this.clock;
    this.strikes = this.strikes.filter((t) => this.clock - t < HELI.STRIKE_WINDOW);
    this.strikes.push(this.clock);
    Heli.onHit({ x: hit.x, y: hit.y, z: hit.z, nx: ax, nz: az, speed: Math.max(3, towards), what: hit.what || 'steel' });
    this.noise.rattle(hit.x, hit.y, hit.z);
    if ((towards > HELI.STRIKE_HARD || this.strikes.length >= HELI.STRIKES) && s.down <= 0) {
      heliBump(s, towards);
      this.strikes = [];
    }
    return Math.max(2, towards);
  }

  /** The tree crowns (air, not blocks): inside one the speed bleeds away, it is pushed out and leaves fly. No bump. */
  private crownsAt(dt: number): number {
    const s = this.s;
    if (this.crownCount !== this.crowns.length) this.indexCrowns();
    const R = SIZE.rotor.r;
    let worst = 0;
    const i0 = Math.floor((s.x - R - 20) / 32), i1 = Math.floor((s.x + R + 20) / 32);
    const j0 = Math.floor((s.z - R - 20) / 32), j1 = Math.floor((s.z + R + 20) / 32);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const c of this.crownCells.get(i * 100003 + j) ?? []) {
          const d = Math.hypot(c.x - s.x, c.z - s.z);
          if (d > c.r + R * 0.85) continue;
          const lo = c.y + 0.35 * c.h, hi = c.y + c.h;
          // The rotor's height over the crown's middle, or the cabin's span across it.
          const inRotor = s.y + SIZE.rotor.y > lo && s.y + SIZE.rotor.y < hi + 0.2;
          const inCabin = d < c.r + 1.2 && s.y + 0.3 < hi && s.y + SIZE.cabin.y1 > lo;
          if (!inRotor && !inCabin) continue;
          if (this.skipCrown(c.x, c.z)) continue;
          const keep = Math.exp(-0.92 * dt); // 60 % a second
          s.vx *= keep;
          s.vz *= keep;
          const ax = (s.x - c.x) / (d || 1), az = (s.z - c.z) / (d || 1);
          s.x += ax * 2 * dt;
          s.z += az * 2 * dt;
          worst = Math.max(worst, 1);
          if (this.clock - this.leavesAt > 0.3) {
            this.leavesAt = this.clock;
            const px = s.x - ax * Math.min(d, R * 0.8), pz = s.z - az * Math.min(d, R * 0.8);
            Heli.onHit({ x: px, y: Math.min(hi - 0.5, s.y + SIZE.rotor.y), z: pz, nx: ax, nz: az, speed: 3 + Math.hypot(s.vx, s.vz) * 0.3, what: 'hedge' });
          }
        }
      }
    }
    return worst;
  }

  private indexCrowns(): void {
    this.crownCells.clear();
    for (const c of this.crowns) {
      const k = Math.floor(c.x / 32) * 100003 + Math.floor(c.z / 32);
      let cell = this.crownCells.get(k);
      if (!cell) this.crownCells.set(k, (cell = []));
      cell.push(c);
    }
    this.crownCount = this.crowns.length;
  }

  /** The step's events heard and seen: a touchdown's thump, a bump's clang and sparks, the start's whoosh. */
  private events(): void {
    const s = this.s;
    if (s.ev & EV.START) this.startWhoosh = 1;
    if (s.ev & (EV.SETTLE | EV.BOUNCE)) this.noise.thump(s.x, s.y, s.z, Math.max(1, s.hit));
    if (s.ev & EV.BUMP) {
      this.noise.clang(s.x, s.y, s.z);
      this.noise.thump(s.x, s.y, s.z, 10);
      if (s.ground) Heli.onHit({ x: s.x, y: s.y + 0.1, z: s.z, nx: 0, nz: 0, speed: Math.max(6, s.hit), what: 'steel' });
    }
  }

  /**
   * The camera behind it: from CAM_DIST behind (further with speed), CAM_PITCH down, following the nose and, at
   * speed, the way it flies; looking up a little in a climb and down in a descent, so the landing spot comes into
   * view by itself. The horizon stays level (the machine is seen banking). Low and slow it comes nearer and steeper.
   * Walls and the tower pull it in; pulled in close it rises to look down on the machine. `tilt` (rad) from the mouse
   * or the right stick tilts it.
   */
  chase(camera: THREE.PerspectiveCamera, dt: number, tilt: number): void {
    const s = this.s;
    const d = Math.min(Math.max(dt, 0), 0.1);
    const speed = Math.hypot(s.vx, s.vz);
    const path = Math.atan2(-s.vx, -s.vz);
    const heading = s.yaw + 0.7 * smooth(10, 18, speed) * angle(path - s.yaw);
    this.camHeading += angle(heading - this.camHeading) * (1 - Math.exp(-d * HELI.CAM_FOLLOW));
    this.camTilt = Math.max(-0.25, Math.min(0.9, this.camTilt + tilt));
    this.lookIdle = tilt ? 0 : this.lookIdle + d;
    if (this.lookIdle > 2) this.camTilt -= this.camTilt * (1 - Math.exp(-d * 1.5));
    const low = s.h < 15 && speed < 8 ? 1 : 0;
    this.camLand += (low - this.camLand) * (1 - Math.exp(-d * 1.2));
    const climb = Math.max(-0.2, Math.min(0.2, -0.4 * Math.atan(s.vy / Math.max(speed, 4))));
    const [landDist, landPitch] = HELI.CAM_LAND;
    const dist = (HELI.CAM_DIST + HELI.CAM_SPEED * speed) * (1 - this.camLand) + landDist * this.camLand;
    let pitch = HELI.CAM_PITCH * (1 - this.camLand) + landPitch * this.camLand + climb + this.camTilt;
    const target = { x: s.x, y: s.y + HELI.CAM_UP, z: s.z };
    const h = this.camHeading;
    const at = (p: number) => ({
      x: target.x + Math.sin(h) * Math.cos(p) * dist,
      y: target.y + Math.sin(p) * dist,
      z: target.z + Math.cos(h) * Math.cos(p) * dist,
    });
    let want = at(pitch);
    let k = this.world.clearance(target, want, this.key);
    if (k * dist < 5) {
      // Pulled in close (beside the tower): up, to look down on the machine rather than at the brick.
      pitch += (0.9 - pitch) * Math.min(1, (5 - k * dist) / 5);
      want = at(pitch);
      k = this.world.clearance(target, want, this.key);
    }
    k = Math.max(0.15, k - 0.3 / dist);
    camera.position.set(target.x + (want.x - target.x) * k, target.y + (want.y - target.y) * k, target.z + (want.z - target.z) * k);
    const floor = this.world.groundAt(camera.position.x, camera.position.z, camera.position.y, 0).y;
    if (camera.position.y < floor + 0.4) camera.position.y = floor + 0.4;
    camera.lookAt(target.x, target.y, target.z);
    if (!CALM && s.shake > 0.01) {
      const t = this.clock;
      camera.rotation.x += (Math.sin(t * 37) + Math.sin(t * 23)) * 0.004 * s.shake;
      camera.rotation.y += Math.sin(t * 29) * 0.004 * s.shake;
    }
    const wide = CALM ? 0 : smooth(20, 45, speed);
    this.fovScale += (1 + 0.12 * wide - this.fovScale) * (1 - Math.exp(-d * 1.5));
  }

  /** The view from the pilot's seat (Eye_Pilot), turning and leaning with the machine; `tilt` looks up and down by up to 60 degrees. */
  cockpit(camera: THREE.PerspectiveCamera, dt: number, tilt: number): void {
    this.lookPitch = Math.max(-1.05, Math.min(1.05, this.lookPitch + tilt));
    this.body.updateMatrixWorld(true);
    camera.position.copy(this.eye).applyMatrix4(this.body.matrixWorld);
    const s = this.s;
    camera.rotation.set(-(CALM ? 0 : s.pitch) + this.lookPitch, s.yaw, CALM ? 0 : -s.roll, 'YXZ');
    this.fovScale += (1 - this.fovScale) * (1 - Math.exp(-Math.min(dt, 0.1) * 1.5));
    this.camHeading = s.yaw;
  }

  /** The machine's transform from its flight state. */
  private pose(): void {
    const s = this.s;
    this.body.position.set(s.x, s.y, s.z);
    this.body.rotation.set(-s.pitch, s.yaw, -s.roll, 'YXZ');
  }

  /** Dev and the warm-up: every part drawn (the discs too) so their shaders are made before play. */
  warm(on: boolean): void {
    this.warmOn = on;
    if (on) {
      this.discMat.opacity = this.tailMat.opacity = 0.01;
      this.discMat.visible = this.tailMat.visible = true;
      if (this.far) this.far.visible = true;
    }
  }

  /**
   * Every frame: when nobody flies it and its rotor still turns (or it hangs in the air), it runs down by itself; then
   * the rotor, the discs, the far copy, the shadow, its block in the world and its sound. Drawn within DRAW m of `eye`.
   */
  update(dt: number, eye: THREE.Vector3, listener?: THREE.Vector3): void {
    const s = this.s;
    if (!this.flown && dt > 0 && (s.rotor > 0 || !s.ground)) this.fly(dt, {});
    const away = Math.hypot(s.x - eye.x, s.z - eye.z, s.y - eye.y);
    this.group.visible = this.ready && (away < DRAW || this.warmOn);
    const farOn = !!this.far && !this.warmOn && away > (lowDetail ? FAR_LOW : FAR) && !this.flown;
    if (this.far && this.near) {
      this.far.visible = farOn || this.warmOn;
      this.near.visible = !farOn;
    }
    if (this.detail) this.detail.visible = away < DETAIL || this.warmOn;
    // The rotor: its blades turn (no faster on screen than SPIN_STEP a frame), cone up with the thrust, droop at rest;
    // the disc's blur from 45 % of its speed, the blades gone by 60 %.
    const r = s.rotor;
    this.spin = (this.spin + Math.min(r * RPM * dt, SPIN_STEP)) % (Math.PI * 2);
    this.tailSpin = (this.tailSpin + Math.min(r * TAIL_RPM * dt, SPIN_STEP * 1.3)) % (Math.PI * 2);
    if (this.rotor) this.rotor.rotation.y = this.spin; // anticlockwise seen from above
    if (this.tail) this.tail.rotation.x = this.tailSpin;
    const cone = -0.052 + 0.096 * Math.min(1, r * r * (0.5 + s.coll));
    for (const b of this.blades) b.rotation.z = (b.userData.baseZ as number) + cone;
    const blur = smooth(0.45, 0.75, r);
    const showBlades = r < BLADES_UNTIL || this.warmOn;
    for (const b of this.blades) b.visible = showBlades;
    if (this.tail) this.tail.visible = r < BLADES_UNTIL || this.warmOn;
    if (!this.warmOn) {
      this.discMat.opacity = 0.42 * blur;
      this.tailMat.opacity = 0.5 * blur;
      this.discMat.visible = this.tailMat.visible = blur > 0.01;
    }
    this.discMat.userData.phase.value = (this.discMat.userData.phase.value + dt * 3) % (Math.PI * 2);
    // The shadow on the floor below, bigger and fainter the higher it is.
    const h = Math.max(0, s.y - s.floor);
    const size = 7 + h * 0.12;
    this.shadow.position.set(s.x, s.floor + 0.03, s.z);
    this.shadow.scale.set(size, 1, size);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.55 * Math.max(0.12, 1 - h / 60);
    this.shadow.visible = h < 120;
    // Its block: nobody walks through a machine that stands; while it flies it is no wall.
    this.world.setMoving(this.key, this.ready && s.ground ? this.footprint() : null, s.y, s.y + SIZE.boom.y1);
    // Its sound, louder from the side the blades come towards you (the machine's right).
    let side = 0;
    if (listener) {
      const [fx, fz] = this.forward;
      const dx = listener.x - s.x, dz = listener.z - s.z;
      side = (dx * -fz + dz * fx) / (Math.hypot(dx, dz) || 1);
    }
    this.startWhoosh = Math.max(0, this.startWhoosh - dt / 6);
    this.noise.update({ x: s.x, y: s.y, z: s.z, rotor: this.group.visible ? r : 0, coll: s.coll, sink: -s.vy, air: Math.hypot(s.vx, s.vz), side, start: this.startWhoosh });
  }

  /** Dev: whether its sound loop is running. */
  get soundOn(): boolean {
    return this.noise.playing;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.world.setMoving(this.key, null);
    this.noise.dispose();
  }
}
