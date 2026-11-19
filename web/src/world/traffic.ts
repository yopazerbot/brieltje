import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sound } from '../sound';
import { horizonReflection } from './car';
import { boxSpots, carLights, pointsOf, spotsFrom, type LampSpots } from './carLights';
import type { World } from './collision';
import { CAST_LAYER } from './tiles';

/**
 * The traffic on the village's roads and the cars parked on the drives (tools/roads.py writes the
 * routes and the spots to web/src/data/roads.json; the cars are our own Blender models,
 * tools/traffic_cars.py: a hatchback, an estate and a van, each with a simpler copy for seeing it
 * from afar, and one wheel, 420 KB for all of them). Up close a car has clear-coated paint (on Medium
 * and up), dark glass that mirrors the sky with the seats just showing behind it, lamps, plates,
 * mirrors and five-spoke wheels; the shade it casts on itself is in its corners' colours.
 *
 * The moving cars run on the server's shared clock, like the cats and the horses: each route has a
 * timetable (made here from its points and the highest speed at each: slower in bends, at junctions
 * and in the village centre), and every player sees a car at the same spot without anything being
 * sent. A car stops for whoever stands or drives in its lane ahead (each browser for what it sees;
 * the server doesn't know about them; a parked car never holds it up) and for another car of the traffic, waits, honks after a few
 * seconds, and afterwards drives a little faster until it is back on its timetable. Routes through
 * the village drive on past the edge of the map, where the haze hides them, and come back after a
 * wait. They are solid for walking and driving into, and bullets spark off them.
 *
 * Parked cars are instanced: per model the paint, the glass (near only) and the rest, near and far,
 * and the wheels of the near ones; only those within reach of the eye, refreshed a few times a second.
 * They are solid blocks. Their shadow in the sun's map comes from the simple model, near ones too,
 * drawn only into that map (CAST_LAYER, as the trees' trunks and the posts: Medium and up). A moving
 * car far off takes the simple model too, whose wheels are part of it.
 */

/** Something a car stops for: a circle on the plan. */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
  /** Waited for without a honk (a helicopter set down on the road for a game: nobody to honk at) */
  quiet?: boolean;
}

/** A player's car (car.ts), for the traffic to stop behind. */
export interface OtherCar {
  x: number;
  z: number;
  yaw: number;
  spec: { length: number; width: number };
}

interface RoadsData {
  routes: { loop: boolean; legs: { p: number[]; v: number[] }[]; gap: number; cars: [string, string, number][] }[];
  parked: [number, number, number, number, number][];
}

const KINDS = ['hatch', 'estate', 'van'] as const;
type Kind = (typeof KINDS)[number];
const PAINTS = ['#2b2d31', '#e8e9eb', '#8b8f94', '#4a4e54', '#1f3555', '#b5b8bc', '#7b1d1d', '#2f3d33', '#5b6470', '#eceeef'];
const ACCEL = 1.5; // m/s2, a calm driver
const DECEL = 2.2; // m/s2 for bends and junctions on the timetable
const STOP = 5; // m/s2 at most, for someone in the way
const LOOK = 12; // points ahead (2.5 m apart) where it looks for someone in its lane
const CATCH_UP = 0.25; // at most this much faster than its timetable while it is behind
const NEAR_SOLID = 90; // m from the eye: within this a moving car is a block in the collision world
const NEAR_SOUND = 70; // m: its engine and tyres are heard within this
const GLASS = 0.06; // the far model's glass: its share of the paint colour (it is in the paint mesh, so tinted dark)

interface Model {
  paint: THREE.BufferGeometry;
  /** The windows, drawn see-through over the cabin (near only) */
  glass: THREE.BufferGeometry;
  rest: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  /** The headlights (they glow at night) */
  lamp: THREE.BufferGeometry;
  /** Where its headlights and tail lights are (world/carLights.ts) */
  spots: LampSpots;
  /** Seen from afar: a fifth of the triangles, the glass in the paint, the lamps and plain wheels in the rest */
  far: { paint: THREE.BufferGeometry; rest: THREE.BufferGeometry };
  axles: [number, number];
  track: number;
  wheel: number;
  length: number;
  width: number;
  height: number;
}

/** A route's leg as a timetable: points (x, z), distance along it, the speed and the time at each. */
interface Leg {
  x: Float64Array;
  z: Float64Array;
  s: Float64Array;
  v: Float64Array;
  t: Float64Array;
  loop: boolean;
  length: number;
  time: number;
}

interface Route {
  legs: Leg[];
  gap: number;
  period: number;
}

interface Mover {
  route: Route;
  phase: number;
  model: Model;
  group: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  front: THREE.Object3D[];
  tail: THREE.MeshStandardMaterial;
  /** Its paint: clear-coated (Medium and up) and plain (Low and phones) */
  paints: [THREE.MeshPhysicalMaterial, THREE.MeshStandardMaterial];
  /** Its paint, rest, tail light, headlight and glass meshes */
  parts: THREE.Mesh[];
  /** It brakes or stands waiting (its brake lights are on) */
  brake: boolean;
  /** Its slot for its lights at night (world/carLights.ts) */
  slot: number;
  /** Drawn with the simple model (far from the eye) */
  far: boolean;
  leg: number;
  s: number;
  v: number;
  spin: number;
  hidden: boolean;
  /** m to whatever it stops for ahead, or Infinity */
  gap: number;
  /** The car of the traffic it waits for, if it is one */
  blocker: Mover | null;
  /** Its number: of two cars waiting for each other the lower goes first */
  id: number;
  waited: number;
  /** Honks when it has waited this long */
  honkAt: number;
  /** It waits for something quiet (Obstacle.quiet), or behind a car that does: no honk */
  quiet: boolean;
  key: string;
  solid: boolean;
  /** Where it is now, for the others to stop behind */
  x: number;
  z: number;
  yaw: number;
  audio: { at: PannerNode; engine: OscillatorNode; hum: GainNode; road: GainNode; filter: BiquadFilterNode; src: AudioBufferSourceNode } | null;
}

/** The leg's timetable: the fastest it may go at each point, braking ahead of bends in time. */
function makeLeg(p: number[], kmh: number[], loop: boolean): Leg {
  const n = kmh.length + (loop ? 1 : 0);
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const cap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = i % kmh.length;
    x[i] = p[k * 2];
    z[i] = p[k * 2 + 1];
    cap[i] = kmh[k] / 3.6;
  }
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  const v = Float64Array.from(cap);
  for (let round = 0; round < (loop ? 2 : 1); round++) {
    for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * ACCEL * (s[i] - s[i - 1])));
    if (loop) v[0] = v[n - 1] = Math.min(v[0], v[n - 1]);
    for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * DECEL * (s[i + 1] - s[i])));
    if (loop) v[0] = v[n - 1] = Math.min(v[0], v[n - 1]);
  }
  const t = new Float64Array(n);
  for (let i = 1; i < n; i++) t[i] = t[i - 1] + (2 * (s[i] - s[i - 1])) / Math.max(0.5, v[i - 1] + v[i]);
  return { x, z, s, v, t, loop, length: s[n - 1], time: t[n - 1] };
}

/** The index of the last entry of a sorted array at or below `value`. */
function below(a: Float64Array, value: number): number {
  let lo = 0;
  let hi = a.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where on a leg a point `s` metres along lies. */
function pointAt(leg: Leg, s: number, out: { x: number; z: number }): { x: number; z: number } {
  if (leg.loop) s = ((s % leg.length) + leg.length) % leg.length;
  else s = Math.min(Math.max(s, 0), leg.length);
  const i = below(leg.s, s);
  const f = (s - leg.s[i]) / Math.max(1e-6, leg.s[i + 1] - leg.s[i]);
  out.x = leg.x[i] + (leg.x[i + 1] - leg.x[i]) * f;
  out.z = leg.z[i] + (leg.z[i + 1] - leg.z[i]) * f;
  return out;
}

/** The timetable's speed `s` metres along a leg. */
function speedAt(leg: Leg, s: number): number {
  if (leg.loop) s = ((s % leg.length) + leg.length) % leg.length;
  const i = below(leg.s, Math.min(Math.max(s, 0), leg.length));
  const f = (s - leg.s[i]) / Math.max(1e-6, leg.s[i + 1] - leg.s[i]);
  return leg.v[i] + (leg.v[i + 1] - leg.v[i]) * Math.min(1, Math.max(0, f));
}

/**
 * The geometry of one material's part of a model, each vertex in `color` (linear) times the shade baked into
 * the model's corners, and with the part's roughness and metalness (`finish`, see finished).
 */
function coloured(g: THREE.BufferGeometry, color: THREE.Color, finish: [number, number]): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  const shade = out.attributes.color;
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  const n = out.attributes.position.count;
  const c = new Float32Array(n * 3);
  const f = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s = shade ? shade.getX(i) : 1;
    c.set([color.r * s, color.g * s, color.b * s], i * 3);
    f.set(finish, i * 2);
  }
  out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  out.setAttribute('finish', new THREE.BufferAttribute(f, 2));
  return out;
}

const merge = (list: THREE.BufferGeometry[]) => (list.length ? mergeGeometries(list) : new THREE.BufferGeometry());

/**
 * One material for many parts, each with its own roughness and metalness from the vertex attribute `finish`
 * (the lamps glossy, the tyres matt, the rims metal), so they stay one draw call. Two lines more per pixel.
 */
function finished<T extends THREE.MeshStandardMaterial>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 finish;\nvarying vec2 vFinish;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFinish = finish;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFinish;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vFinish.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vFinish.y;');
  };
  m.customProgramCacheKey = () => 'traffic-finish';
  return m;
}

/** A car's paint: clear-coated, the sides mirroring the sky over a darker ground (world/car.ts), for Medium and up. */
function coatedPaint(color: THREE.ColorRepresentation = '#ffffff'): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ vertexColors: true, color, roughness: 0.32, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.4 });
  horizonReflection(m);
  return m;
}

/** The paint for Low and phones, and for every car far off: one layer, a little glossier. */
function plainPaint(color: THREE.ColorRepresentation = '#ffffff'): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, color, roughness: 0.25, metalness: 0.3, envMapIntensity: 1.3 });
  horizonReflection(m);
  return m;
}

/** The soft dark patch under a car (a blurred rectangle), shared by all of them. */
function shadowMaterial(): THREE.MeshBasicMaterial {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.filter = 'blur(5px)';
  g.fillStyle = 'rgba(0,0,0,0.75)';
  g.fillRect(7, 7, 18, 50);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, color: '#000000' });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  return mat;
}

let noise: AudioBuffer | null = null;
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise?.sampleRate === c.sampleRate) return noise;
  noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

/**
 * The sound, once the page has been clicked or tapped: an audio context made before that starts
 * suspended (the browsers' autoplay rule), so these sounds don't make it.
 */
export function audio(): AudioContext | null {
  return (navigator.userActivation?.hasBeenActive ?? true) ? sound.context() : null;
}

/** A short two-tone horn from (x, y, z). */
function honk(x: number, y: number, z: number): void {
  const c = audio();
  const at = sound.at(x, y, z, 6);
  if (!c || !at) return;
  const t = c.currentTime;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
  g.gain.setValueAtTime(0.12, t + 0.32);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 1800;
  for (const hz of [415, 523]) {
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = hz;
    o.connect(f);
    o.start(t);
    o.stop(t + 0.42);
  }
  f.connect(g).connect(at);
}

export class Traffic {
  readonly group = new THREE.Group();
  private offset = Date.now() / 1000 - performance.now() / 1000; // shared clock minus local, in seconds
  private models = new Map<Kind, Model>();
  private wheelGeo = new THREE.BufferGeometry();
  private rest = finished(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }));
  /** The moving cars' headlights: as the rest by day, glowing at night */
  private lampMat = finished(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1, emissive: '#ffdcaa', emissiveIntensity: 0 }));
  /** Tinted glass you can just see the cabin through, mirroring the sky (as the Teslas', world/car.ts) */
  private glassMat = new THREE.MeshStandardMaterial({ color: '#07080a', roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.86, depthWrite: false, envMapIntensity: 1.6 });
  /** The parked cars' paint: near in full (clear-coated or plain by the preset), far always plain */
  private parkedPaint: [THREE.MeshPhysicalMaterial, THREE.MeshStandardMaterial] = [coatedPaint(), plainPaint()];
  /** Clear-coated paint (Medium and up, not on phones): roadLife sets it each frame */
  fine = true;
  private dressed = true;
  private shadow = shadowMaterial();
  private plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private movers: Mover[] = [];
  private parked: { kind: number; matrix: THREE.Matrix4; color: THREE.Color; x: number; z: number; wheels: THREE.Matrix4[]; patch: THREE.Matrix4 }[] = [];
  /** Per model, near and far (kind * 2 + far); the glass only near */
  private parkedMeshes: { paint: THREE.InstancedMesh; rest: THREE.InstancedMesh; glass: THREE.InstancedMesh | null }[] = [];
  /** Per model, the parked cars' shadow: the simple model, only in the sun's map (not on Low and phones) */
  private parkedCasters: THREE.InstancedMesh[] = [];
  private casterMat = new THREE.MeshBasicMaterial();
  private parkedWheels: THREE.InstancedMesh | null = null;
  private parkedShadows: THREE.InstancedMesh | null = null;
  private wait = 0;
  private last = 0; // the shared clock at the last update
  private lastEye = new THREE.Vector3(Infinity, 0, Infinity);
  private p = { x: 0, z: 0 };
  private q = { x: 0, z: 0 };
  /** m from the eye within which parked cars are drawn (less on Low and phones) */
  reach = 200;
  /** m: closer than this a car is drawn in full, with its wheels; further, the simple model */
  near = 60;
  /** Contact shadows under the cars (not on Low and phones) */
  shadows = true;

  constructor(private world: World, private groundAt: (x: number, z: number) => number, private roadAt: (x: number, z: number) => number) {
    horizonReflection(this.glassMat);
  }

  /** Line up with the server's clock (ms since 1970), so all players see the cars in the same place. */
  setClock(serverMs: number): void {
    this.offset = serverMs / 1000 - performance.now() / 1000;
  }

  private get now(): number {
    return performance.now() / 1000 + this.offset;
  }

  /** The models and the routes (fetched now), the parked cars and their blocks. */
  async load(data: RoadsData): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync('/models/traffic.glb');
    /** A node's parts by material, in vertex colours (the paint white, to be tinted) with their finish. */
    const partsOf = (name: string) => {
      const parts: Record<string, THREE.BufferGeometry[]> = {};
      const node = gltf.scene.getObjectByName(name);
      node?.updateMatrixWorld(true);
      node?.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        const color = mat.name === 'Paint' ? new THREE.Color(1, 1, 1) : mat.name === 'Glass' ? new THREE.Color(GLASS, GLASS, GLASS * 1.15) : mat.color.clone();
        (parts[mat.name] ??= []).push(coloured(g, color, [mat.roughness, mat.metalness]));
      });
      const pick = (...names: string[]) => merge(names.flatMap((n) => parts[n] ?? []));
      /** Every part but these */
      const others = (...names: string[]) => pick(...Object.keys(parts).filter((n) => !names.includes(n)));
      return { node, pick, others };
    };
    this.wheelGeo = partsOf('wheel').others();
    for (const kind of KINDS) {
      const { node, pick, others } = partsOf(kind);
      const far = partsOf(kind + '_far');
      if (!node) continue;
      const u = node.userData as { axles: number[]; track: number; wheel: number; length: number; width: number; height: number };
      this.models.set(kind, {
        paint: pick('Paint'),
        glass: pick('Glass'),
        rest: others('Paint', 'Glass', 'Tail', 'Lamp'),
        tail: pick('Tail'),
        lamp: pick('Lamp'),
        spots: spotsFrom(pointsOf(pick('Lamp')), pointsOf(pick('Tail')), boxSpots(u.length, u.width)),
        far: { paint: far.pick('Paint', 'Glass'), rest: far.others('Paint', 'Glass') },
        axles: [-u.axles[0], -u.axles[1]], // the nose is at +y in Blender, -z here
        track: u.track,
        wheel: u.wheel,
        length: u.length,
        width: u.width,
        height: u.height,
      });
    }
    if (!this.wheelGeo.attributes.position || this.models.size < KINDS.length) return;
    this.addRoutes(data.routes);
    this.addParked(data.parked);
  }

  private addRoutes(routes: RoadsData['routes']): void {
    for (const r of routes) {
      const legs = r.legs.map((l) => makeLeg(l.p, l.v, r.loop));
      const route: Route = { legs, gap: r.gap, period: legs.reduce((a, l) => a + l.time + r.gap, 0) };
      for (const [kind, paint, phase] of r.cars) {
        const model = this.models.get(kind as Kind)!;
        const group = new THREE.Group();
        const body = new THREE.Group();
        group.add(body);
        body.rotation.order = 'YXZ';
        const paints: Mover['paints'] = [coatedPaint(paint), plainPaint(paint)];
        const tail = new THREE.MeshStandardMaterial({ color: '#7a1010', roughness: 0.3, emissive: '#ff2020', emissiveIntensity: 0.15 });
        const meshes = [
          new THREE.Mesh(model.paint, paints[this.fine ? 0 : 1]),
          new THREE.Mesh(model.rest, this.rest),
          new THREE.Mesh(model.tail, tail),
          new THREE.Mesh(model.lamp, this.lampMat),
          new THREE.Mesh(model.glass, this.glassMat),
        ];
        for (const m of meshes) {
          m.castShadow = true;
          m.receiveShadow = true;
          m.userData.material = 'steel'; // bullets spark off it
          m.userData.vehicle = true; // their holes go with it (see Decals)
          body.add(m);
        }
        meshes[3].castShadow = false; // too small for a shadow of its own, and a draw call less there
        meshes[4].castShadow = false; // the sun shines in through the windows
        meshes[4].userData.material = 'black_glass';
        const wheels: THREE.Object3D[] = [];
        const front: THREE.Object3D[] = [];
        for (const [k, az] of model.axles.entries()) {
          for (const side of [-1, 1]) {
            const pivot = new THREE.Group();
            pivot.position.set((side * model.track) / 2, model.wheel, az);
            pivot.rotation.order = 'YXZ';
            const w = new THREE.Mesh(this.wheelGeo, this.rest);
            w.scale.setScalar(model.wheel / 0.32);
            if (side < 0) w.rotation.y = Math.PI; // the rim's face outwards
            w.castShadow = true;
            w.userData.ignoreRay = true;
            pivot.add(w);
            body.add(pivot);
            wheels.push(pivot);
            if (k === 0) front.push(pivot);
          }
        }
        const patch = new THREE.Mesh(this.plane, this.shadow);
        patch.scale.set(model.width + 0.7, 1, model.length + 0.7);
        patch.position.y = 0.03;
        patch.userData.ignoreRay = true;
        patch.renderOrder = 2;
        group.add(patch);
        group.visible = false;
        this.group.add(group);
        this.movers.push({
          route, phase, model, group, body, wheels, front, tail, paints, parts: meshes, far: false, leg: -1, s: 0, v: 0, spin: 0, hidden: true, gap: Infinity, blocker: null, id: this.movers.length, waited: 0, honkAt: 3, quiet: false,
          key: `traffic-${this.movers.length}`, solid: false, x: 0, z: 0, yaw: 0, audio: null, brake: false, slot: carLights.reserve(),
        });
      }
    }
  }

  private addParked(list: RoadsData['parked']): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const blocks = [];
    for (const [x, z, yaw, kind, paint] of list) {
      const model = this.models.get(KINDS[kind])!;
      const y = this.groundAt(x, z);
      q.setFromAxisAngle(up, yaw);
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
      const outwards = [new THREE.Quaternion().setFromAxisAngle(up, Math.PI), new THREE.Quaternion()]; // the rim's face outwards
      const wheels = model.axles.flatMap((az) => [-1, 1].map((side) => {
        const sc = model.wheel / 0.32;
        return matrix.clone().multiply(m.compose(new THREE.Vector3((side * model.track) / 2, model.wheel, az), outwards[side < 0 ? 0 : 1], new THREE.Vector3(sc, sc, sc)));
      }));
      const patch = new THREE.Matrix4().compose(new THREE.Vector3(x, y + 0.03, z), q, new THREE.Vector3(model.width + 0.7, 1, model.length + 0.7));
      this.parked.push({ kind, matrix, color: new THREE.Color(PAINTS[paint]), x, z, wheels, patch });
      // A block to walk and drive into, its outline the car's.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const hl = model.length / 2 - 0.05;
      const hw = model.width / 2 - 0.02;
      const ring = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]): [number, number] => [x + fx * hl * a - fz * hw * b, z + fz * hl * a + fx * hw * b]);
      blocks.push({ m: 'car', y0: y + 0.2, y1: y + model.height - 0.05, p: [ring], n: 'Car' });
    }
    this.world.addPrisms(blocks);
    const count = (k: number) => Math.max(1, this.parked.filter((p) => p.kind === k).length);
    this.parkedMeshes = KINDS.flatMap((kind, k) => {
      const model = this.models.get(kind)!;
      return [model, model.far].map((g) => {
        const near = g === model;
        const paint = new THREE.InstancedMesh(g.paint, this.parkedPaint[near && this.fine ? 0 : 1], count(k));
        paint.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count(k) * 3), 3);
        const rest = new THREE.InstancedMesh(near ? merge([model.rest.clone(), model.tail.clone(), model.lamp.clone()]) : g.rest, this.rest, count(k));
        const glass = near ? new THREE.InstancedMesh(model.glass, this.glassMat, count(k)) : null;
        for (const mesh of [paint, rest, glass]) {
          if (!mesh) continue;
          mesh.count = 0;
          mesh.receiveShadow = true;
          mesh.userData.material = mesh === glass ? 'black_glass' : 'steel';
          this.group.add(mesh);
        }
        return { paint, rest, glass };
      });
    });
    this.casterMat.visible = this.fine;
    this.parkedCasters = KINDS.map((kind, k) => {
      const far = this.models.get(kind)!.far;
      const shape = new THREE.BufferGeometry().setAttribute('position', merge([far.paint, far.rest]).getAttribute('position'));
      const mesh = new THREE.InstancedMesh(shape, this.casterMat, count(k));
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.layers.set(CAST_LAYER);
      mesh.userData.ignoreRay = true;
      this.group.add(mesh);
      return mesh;
    });
    this.parkedWheels = new THREE.InstancedMesh(this.wheelGeo, this.rest, this.parked.length * 4 || 1);
    this.parkedWheels.userData.ignoreRay = true;
    this.parkedWheels.receiveShadow = true;
    this.parkedShadows = new THREE.InstancedMesh(this.plane, this.shadow, this.parked.length || 1);
    this.parkedShadows.userData.ignoreRay = true;
    this.parkedShadows.renderOrder = 2;
    for (const mesh of [this.parkedWheels, this.parkedShadows]) {
      mesh.count = 0;
      this.group.add(mesh);
    }
    this.lastEye.set(Infinity, 0, Infinity);
    this.wait = 0;
  }

  /** The parked cars within reach of the eye into their instanced meshes: near ones in full, with wheels. */
  private refreshParked(eye: THREE.Vector3): void {
    const counts = this.parkedMeshes.map(() => 0);
    const casts = this.parkedCasters.map(() => 0);
    let wheels = 0;
    let shadows = 0;
    for (const p of this.parked) {
      const d2 = (p.x - eye.x) ** 2 + (p.z - eye.z) ** 2;
      if (d2 > this.reach ** 2) continue;
      const near = d2 < this.near ** 2;
      const k = p.kind * 2 + (near ? 0 : 1);
      const { paint, rest, glass } = this.parkedMeshes[k];
      const i = counts[k]++;
      paint.setMatrixAt(i, p.matrix);
      paint.setColorAt(i, p.color);
      rest.setMatrixAt(i, p.matrix);
      glass?.setMatrixAt(i, p.matrix);
      this.parkedCasters[p.kind].setMatrixAt(casts[p.kind]++, p.matrix);
      if (near) for (const w of p.wheels) this.parkedWheels!.setMatrixAt(wheels++, w);
      if (this.shadows) this.parkedShadows!.setMatrixAt(shadows++, p.patch);
    }
    // An empty one is hidden: no draw call for it.
    const show = (mesh: THREE.InstancedMesh, n: number) => {
      mesh.count = n;
      mesh.visible = n > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (n) mesh.computeBoundingSphere();
    };
    this.parkedMeshes.forEach(({ paint, rest, glass }, k) => {
      show(paint, counts[k]);
      show(rest, counts[k]);
      if (glass) show(glass, counts[k]);
      if (paint.instanceColor) paint.instanceColor.needsUpdate = true;
    });
    this.parkedCasters.forEach((mesh, k) => show(mesh, casts[k]));
    show(this.parkedWheels!, wheels);
    show(this.parkedShadows!, shadows);
  }

  /** Where a car's route has it now on the timetable: the leg and how far along, its speed; or hidden between legs. */
  private scheduled(c: Mover): { leg: number; s: number; v: number } | null {
    const r = c.route;
    let t = (((this.now + c.phase * r.period) % r.period) + r.period) % r.period;
    for (let k = 0; k < r.legs.length; k++) {
      const leg = r.legs[k];
      if (t < leg.time) {
        const i = below(leg.t, t);
        const f = (t - leg.t[i]) / Math.max(1e-6, leg.t[i + 1] - leg.t[i]);
        return { leg: k, s: leg.s[i] + (leg.s[i + 1] - leg.s[i]) * f, v: leg.v[i] + (leg.v[i + 1] - leg.v[i]) * f };
      }
      t -= leg.time;
      if (t < r.gap) return null;
      t -= r.gap;
    }
    return null;
  }

  /**
   * Every frame: each car along its timetable, stopping for what is in its lane (`obstacles`: the
   * players; `cars`: the players' cars); the parked cars near the eye now and then.
   */
  update(dt: number, eye: THREE.Vector3, obstacles: Obstacle[], cars: OtherCar[], far: number): void {
    if (this.fine !== this.dressed) {
      // The graphics preset changed: clear-coated paint on Medium and up, plain on Low and phones.
      this.dressed = this.fine;
      this.casterMat.visible = this.fine; // the parked cars' shadow: Medium and up, as the posts' (world/surroundings.ts)
      for (let k = 0; k < this.parkedMeshes.length; k += 2) this.parkedMeshes[k].paint.material = this.parkedPaint[this.fine ? 0 : 1];
      for (const c of this.movers) c.parts[0].material = c.paints[this.fine && !c.far ? 0 : 1];
    }
    this.wait -= dt;
    if (this.parked.length && (this.wait <= 0 || eye.distanceToSquared(this.lastEye) > 400)) {
      this.wait = 0.4;
      this.lastEye.copy(eye);
      this.refreshParked(eye);
    }
    if (!this.movers.length) return;
    // The cars go by the clock, not the frame's (capped) time: slow frames don't put them behind.
    const now = this.now;
    const step = this.last ? Math.min(1, Math.max(0, now - this.last)) : dt;
    this.last = now;
    // What the cars stop for: people, the players' cars (two circles each) and each other.
    const circles: (Obstacle & { own?: Mover })[] = [...obstacles];
    for (const c of cars) {
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      const r = c.spec.width / 2;
      const d = c.spec.length / 2 - r;
      circles.push({ x: c.x + fx * d, z: c.z + fz * d, r }, { x: c.x - fx * d, z: c.z - fz * d, r });
    }
    for (const c of this.movers) {
      if (c.hidden) continue;
      const fx = -Math.sin(c.yaw);
      const fz = -Math.cos(c.yaw);
      const r = c.model.width / 2;
      const d = c.model.length / 2 - r;
      circles.push({ x: c.x + fx * d, z: c.z + fz * d, r, own: c }, { x: c.x - fx * d, z: c.z - fz * d, r, own: c });
    }
    // In steps of at most 0.1 s, so a long frame (a hitch) doesn't carry a car past what it stops for.
    const n = Math.ceil(step / 0.1) || 1;
    for (let k = 0; k < n; k++) for (const c of this.movers) this.step(c, step / n, eye, circles, far);
    this.lights();
  }

  private step(c: Mover, dt: number, eye: THREE.Vector3, circles: (Obstacle & { own?: Mover })[], far: number): void {
    const plan = this.scheduled(c);
    if (!plan) {
      this.hide(c);
      return;
    }
    const leg = c.route.legs[plan.leg];
    // How far it is behind its timetable (round a loop, the way round to it).
    let behind = plan.s - c.s;
    if (leg.loop) behind = (((behind % leg.length) + leg.length) % leg.length + 5) % leg.length - 5;
    const seen = Math.hypot(c.x - eye.x, c.z - eye.z) < 200;
    if (plan.leg !== c.leg || c.hidden || behind < -1 || (behind > 400 && !seen)) {
      // A new leg (or it just came into being, or fell far behind out of sight): where the timetable has it.
      c.leg = plan.leg;
      c.s = plan.s;
      c.v = plan.v;
      c.waited = 0;
      behind = 0;
    }
    // How fast it wants to go: its timetable's speed here, a little more while it is behind.
    let want = speedAt(leg, c.s) * (1 + Math.min(CATCH_UP, behind / 40));
    // Someone or something in its lane ahead (near a point of its path): stop 2 m short of it.
    const half = c.model.width / 2;
    let gap = Infinity;
    let who: Mover | null = null;
    let quiet = false;
    for (let k = 1; k <= LOOK && gap === Infinity; k++) {
      const ahead = pointAt(leg, c.s + k * 2.5, this.p);
      for (const o of circles) {
        if (o.own === c) continue;
        const dx = o.x - ahead.x;
        const dz = o.z - ahead.z;
        if (dx * dx + dz * dz < (half + o.r + 0.25) ** 2) {
          const g = Math.hypot(o.x - c.x, o.z - c.z) - c.model.length / 2 - o.r;
          if (g < gap) {
            gap = g;
            who = o.own ?? null;
            quiet = !!o.quiet || !!o.own?.quiet;
          }
        }
      }
    }
    // Two cars of the traffic in each other's way at a junction: the one with the lower number goes.
    if (who && who.blocker === c && c.id < who.id) gap = Infinity;
    c.blocker = gap < Infinity ? who : null;
    c.quiet = gap < Infinity && quiet;
    if (gap < Infinity) {
      const room = Math.sqrt(2 * STOP * 0.6 * Math.max(0, gap - 2));
      want = Math.min(want, room < 0.5 ? 0 : room);
    }
    const before = c.v;
    c.v = want > c.v ? Math.min(want, c.v + ACCEL * 1.4 * dt) : Math.max(want, c.v - STOP * dt);
    c.s += Math.min(c.v * dt, Math.max(0, behind)); // never ahead of its timetable
    c.s = leg.loop ? c.s % leg.length : Math.min(c.s, leg.length);
    c.gap = gap;
    // Waiting for someone: honk after 3 s, and every 10 s after.
    if (c.v < 0.3 && gap < 12) {
      c.waited += dt;
      if (c.waited > c.honkAt) {
        c.honkAt += 10;
        if (!c.quiet && Math.hypot(c.x - eye.x, c.z - eye.z) < 120) honk(c.x, this.roadAt(c.x, c.z) + 0.8, c.z);
      }
    } else if (c.v > 1) {
      c.waited = 0;
      c.honkAt = 3;
    }

    // Where it is and which way it faces: along the path from a little behind to a little ahead.
    const a = pointAt(leg, c.s - 1.6, this.p);
    const ax = a.x, az = a.z;
    const b = pointAt(leg, c.s + 1.6, this.q);
    const x = (ax + b.x) / 2;
    const z = (az + b.z) / 2;
    const yaw = Math.atan2(-(b.x - ax), -(b.z - az));
    const turn = Math.atan2(Math.sin(yaw - c.yaw), Math.cos(yaw - c.yaw));
    c.x = x;
    c.z = z;
    const wasHidden = c.hidden;
    c.yaw = wasHidden ? yaw : c.yaw + turn;
    const dist = Math.hypot(x - eye.x, z - eye.z);
    c.hidden = false;
    c.group.visible = dist < Math.min(far, 450);
    // On the slope: the body's height and pitch from the road under its axles.
    const fx = -Math.sin(c.yaw);
    const fz = -Math.cos(c.yaw);
    const wb = c.model.axles[1] - c.model.axles[0];
    const yf = this.roadAt(x + (fx * wb) / 2, z + (fz * wb) / 2);
    const yr = this.roadAt(x - (fx * wb) / 2, z - (fz * wb) / 2);
    const y = (yf + yr) / 2;
    if (c.group.visible) {
      const far = dist > this.near + 10;
      if (far !== c.far) {
        c.far = far;
        c.parts[0].geometry = far ? c.model.far.paint : c.model.paint;
        c.parts[0].material = c.paints[far || !this.fine ? 1 : 0];
        c.parts[1].geometry = far ? c.model.far.rest : c.model.rest;
        c.parts[2].visible = !far;
        c.parts[3].visible = !far; // the simple model has its headlights in the rest
        c.parts[4].visible = !far; // and its glass in the paint
        for (const w of c.wheels) w.visible = !far; // and plain wheels of its own
      }
      c.group.position.set(x, y, z);
      c.group.rotation.y = c.yaw;
      const accel = dt > 0 ? (c.v - before) / dt : 0;
      c.body.rotation.x = Math.atan2(yf - yr, wb) + Math.max(-0.02, Math.min(0.02, -accel * 0.006));
      c.spin -= (c.v * dt) / c.model.wheel;
      const steer = Math.max(-0.5, Math.min(0.5, (turn / Math.max(0.05, c.v * dt)) * wb));
      for (const w of c.wheels) w.rotation.x = c.spin;
      for (const w of c.front) w.rotation.y = c.v > 0.2 ? steer : w.rotation.y;
      c.brake = accel < -0.8 || (c.v < 0.3 && gap < 12);
      c.tail.emissiveIntensity = c.brake ? 1.6 + 0.4 * carLights.night : 0.15 + 0.9 * carLights.night; // brighter at night
    }
    // A block for walking and driving into, near the eye.
    const solid = dist < NEAR_SOLID;
    if (solid) {
      const hl = c.model.length / 2;
      const hw = c.model.width / 2;
      this.world.setMoving(c.key, [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([p, q]): [number, number] => [x + fx * hl * p - fz * hw * q, z + fz * hl * p + fx * hw * q]), y + 0.2, y + c.model.height);
    } else if (c.solid) this.world.setMoving(c.key, null);
    c.solid = solid;
    this.hum(c, dist, y);
  }

  /** At night the moving cars drive with their lights on: the headlights glow, with their glows and pools (world/carLights.ts). */
  private lights(): void {
    const night = carLights.night;
    this.lampMat.emissiveIntensity = 2.5 * night;
    for (const c of this.movers) {
      if (night < 0.01 || !c.group.visible) {
        carLights.hide(c.slot);
        continue;
      }
      c.body.updateWorldMatrix(true, false);
      carLights.show(c.slot, c.body.matrixWorld, c.body.matrixWorld, c.model.spots, night, night * (c.brake ? 1 : 0.4));
    }
  }

  private hide(c: Mover): void {
    if (c.hidden) return;
    c.hidden = true;
    c.group.visible = false;
    c.leg = -1;
    if (c.solid) this.world.setMoving(c.key, null);
    c.solid = false;
    this.hum(c, Infinity, 0);
  }

  /** A petrol engine's low drone that rises with speed, and tyres on the road; only near the eye. */
  private hum(c: Mover, dist: number, y: number): void {
    if (dist > NEAR_SOUND + 20) {
      if (c.audio) {
        c.audio.engine.stop();
        c.audio.src.stop();
        c.audio.at.disconnect();
        c.audio = null;
      }
      return;
    }
    if (dist > NEAR_SOUND && !c.audio) return;
    const ctx = audio();
    if (!ctx) return;
    if (!c.audio) {
      // A plain stereo panner (not the game's HRTF one): it plays all the time it is near, so cheap.
      const at = ctx.createPanner();
      at.panningModel = 'equalpower';
      at.distanceModel = 'inverse';
      at.refDistance = 5;
      at.rolloffFactor = 1.1;
      at.maxDistance = 120;
      at.positionX.value = c.x;
      at.positionY.value = y + 0.5;
      at.positionZ.value = c.z;
      at.connect(sound.outside()!); // muffled through the walls indoors (sound.ts)
      const engine = ctx.createOscillator();
      engine.type = 'sawtooth';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 220;
      const hum = ctx.createGain();
      hum.gain.value = 0;
      engine.connect(filter).connect(hum).connect(at);
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      src.loop = true;
      const tyres = ctx.createBiquadFilter();
      tyres.type = 'lowpass';
      tyres.frequency.value = 600;
      const road = ctx.createGain();
      road.gain.value = 0;
      src.connect(tyres).connect(road).connect(at);
      engine.start();
      src.start();
      c.audio = { at, engine, hum, road, filter, src };
    }
    const a = c.audio;
    const t = ctx.currentTime;
    a.at.positionX.setTargetAtTime(c.x, t, 0.05);
    a.at.positionY.setTargetAtTime(y + 0.5, t, 0.05);
    a.at.positionZ.setTargetAtTime(c.z, t, 0.05);
    // Second gear in town: about 1500 to 2500 rpm, four cylinders.
    const rpm = 900 + Math.min(1, c.v / 14) * 1700;
    a.engine.frequency.setTargetAtTime((rpm / 60) * 2, t, 0.15);
    a.filter.frequency.setTargetAtTime(180 + c.v * 12, t, 0.2);
    const fade = Math.min(1, (NEAR_SOUND + 20 - dist) / 20);
    a.hum.gain.setTargetAtTime(0.05 * fade, t, 0.2);
    a.road.gain.setTargetAtTime(Math.min(0.09, c.v * 0.007) * fade, t, 0.2);
  }

  /** The moving cars where they are now (for the minimap): position and heading. */
  get cars(): { x: number; z: number; yaw: number; length: number; width: number }[] {
    return this.movers.filter((c) => !c.hidden).map((c) => ({ x: c.x, z: c.z, yaw: c.yaw, length: c.model.length, width: c.model.width }));
  }

  /** How many cars are drawn now: moving, parked. */
  get counts(): { moving: number; parked: number } {
    return { moving: this.movers.filter((c) => c.group.visible).length, parked: this.parkedMeshes.reduce((a, m) => a + m.paint.count, 0) };
  }
}
