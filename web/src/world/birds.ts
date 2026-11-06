import * as THREE from 'three';
import { house } from './houseData';
import { terrain } from './terrain';
import { painted } from './yard';

/**
 * Birds round the main house and the bungalow: sparrows in the hedges, blackbirds and a robin on
 * the lawns, wood pigeons on the roof edges and ridges, starlings on the cables, magpies in the
 * field next door. Each sits somewhere it would (a hedge top, a ridge, a cable, the lawn), hops
 * and pecks, now and then flies to another spot, and takes off when you come close or a shot is
 * fired near it; sparrows and starlings go together.
 *
 * One small model (tools/garden_life.py) painted per species, one instanced mesh per species
 * (six draw calls in all, no shadows). The wings are folded and flapped in the vertex shader, so
 * the CPU only places each bird: about 30 matrices a frame, and nothing at all when you are far
 * from both gardens. This is decoration that only you see: every player has their own birds.
 */

type V3 = THREE.Vector3;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Where birds of a flock may sit: along a line (hedge top, roof edge, ridge, or a cable sagging
 * `sag` metres in its middle), on the ground in a rectangle, or on a point.
 */
type Perch = { line: [V3, V3]; sag?: number } | { area: [number, number, number, number] } | { point: V3 };

interface Species {
  /** Size against the model (a sparrow, 15 cm) */
  scale: number;
  /** Tail length against the model's */
  tail: number;
  /** Wing beats a second, and how much it glides between bursts (0..1) */
  flap: number;
  glide: number;
  /** Flying speed, m/s */
  speed: number;
  /** Walks on the ground instead of hopping */
  walks?: boolean;
  colors: Record<string, string>;
}

const SPECIES = {
  sparrow: {
    scale: 1, tail: 1, flap: 11, glide: 0, speed: 7,
    colors: { BirdBody: '#7c5b3b', BirdBelly: '#c4b8a4', BirdHead: '#77706a', BirdWingL: '#6a4b30', BirdWingR: '#6a4b30', BirdTail: '#54402d', BirdLegs: '#8a7663' },
  },
  blackbird: {
    scale: 1.6, tail: 1.35, flap: 9, glide: 0.2, speed: 8,
    colors: { BirdBody: '#1b1a19', BirdBelly: '#232120', BirdHead: '#1b1a19', BirdBeak: '#e2a019', BirdWingL: '#181716', BirdWingR: '#181716', BirdTail: '#141312', BirdLegs: '#3a3128' },
  },
  robin: {
    scale: 0.95, tail: 0.9, flap: 12, glide: 0, speed: 7,
    colors: { BirdBody: '#7a6650', BirdBelly: '#d2662c', BirdHead: '#b4643a', BirdWingL: '#6e5a44', BirdWingR: '#6e5a44', BirdTail: '#655240', BirdLegs: '#6d5a48' },
  },
  pigeon: {
    scale: 2.6, tail: 1.25, flap: 6, glide: 0.5, speed: 11, walks: true,
    colors: { BirdBody: '#8b9099', BirdBelly: '#a3959a', BirdHead: '#7c8190', BirdBeak: '#d6b04c', BirdWingL: '#858a93', BirdWingR: '#858a93', BirdTail: '#5b5e66', BirdLegs: '#b45e6c' },
  },
  starling: {
    scale: 1.35, tail: 0.75, flap: 10, glide: 0.35, speed: 10, walks: true,
    colors: { BirdBody: '#20242a', BirdBelly: '#2a2d33', BirdHead: '#1c2229', BirdBeak: '#d8b23a', BirdWingL: '#262a2f', BirdWingR: '#262a2f', BirdTail: '#1c1f23', BirdLegs: '#9a6a5a' },
  },
  magpie: {
    scale: 2.2, tail: 2.7, flap: 8, glide: 0.3, speed: 9, walks: true,
    colors: { BirdBody: '#111214', BirdBelly: '#ebeae5', BirdHead: '#0e0f11', BirdBeak: '#121212', BirdWingL: '#1a2130', BirdWingR: '#1a2130', BirdTail: '#18232b', BirdLegs: '#1a1a1a' },
  },
} satisfies Record<string, Species>;
type Kind = keyof typeof SPECIES;

interface FlockSpec {
  kind: Kind;
  count: number;
  perches: Perch[];
  /** Takes off when you are this close (m) */
  flee: number;
  /** Seconds between flights to another spot, roughly */
  restless: number;
  /** The flock goes together */
  together?: boolean;
  /** Which garden it belongs to (only birds near you move) */
  site: 0 | 1;
}

const SITES = [v3(4.45, 0, -3), v3(85, 0, 192)];
/** Buildings a flight must clear (outline on the plan, top): the main house, the bungalow and its veranda. */
const OBSTACLES: { ring: [number, number][]; top: number }[] = [
  { ring: [[-0.1, -3.1], [9.1, -3.1], [9.1, 12.1], [-0.1, 12.1]], top: 9.2 },
  { ring: [[83.34, 197.19], [92.3, 186.43], [85.16, 180.48], [76.2, 191.23]], top: 7.0 },
  { ring: [[83.3, 197.2], [91.7, 189.9], [94.0, 192.0], [86.0, 199.6]], top: 3.0 },
];

function insideRing(x: number, z: number, ring: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
const AWAKE = [180, 140]; // m from a garden's middle: closer than this its birds are drawn and move

/** The top of a hedge or fence block out on the relief (its y1 is above the ground there). */
const onRelief = (x: number, z: number, y: number) => v3(x, y + terrain.height(x, z), z);

/** The ridge of a gable or hip roof of the surroundings (as world/surroundings.ts builds it), a few cm up for the ridge tiles. */
function ridge(r: (typeof house.surroundings & {})['roofs'][number]): [V3, V3] | null {
  if (r.shape === 'shed') return null;
  const c = r.p.map(([x, z]) => new THREE.Vector2(x, z));
  if (!r.fixed && !r.windows && !r.gableWindows && c[0].distanceTo(c[1]) < c[1].distanceTo(c[2])) c.push(c.shift()!);
  const half = c[3].clone().sub(c[0]).multiplyScalar(0.5);
  let a = c[0].clone().add(half);
  let b = c[1].clone().add(half);
  if (r.shape === 'hip') {
    const along = b.clone().sub(a);
    const cut = Math.min(half.length(), along.length() / 2 - 0.2);
    along.normalize().multiplyScalar(cut);
    a = a.add(along);
    b = b.sub(along);
  }
  return [v3(a.x, r.ridge + 0.06, a.y), v3(b.x, r.ridge + 0.06, b.y)];
}

/** The upper cable between two poles, from a tenth of the way to nine tenths, with its sag (as world/surroundings.ts draws it). */
function cable(i: number, j: number): Perch[] {
  const poles = house.surroundings?.poles ?? [];
  const a = poles[i];
  const b = poles[j];
  if (!a || !b) return [];
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const at = (t: number) => {
    const ya = (a.y ?? house.ground) + 8.85;
    const yb = (b.y ?? house.ground) + 8.85;
    const ax = a.x + a.arm[0] * 0.13;
    const az = a.z + a.arm[1] * 0.13;
    const bx = b.x + b.arm[0] * 0.13;
    const bz = b.z + b.arm[1] * 0.13;
    return v3(ax + (bx - ax) * t, ya + (yb - ya) * t - span * 0.012 * 4 * t * (1 - t) + 0.02, az + (bz - az) * t);
  };
  // Between t = 0.1 and 0.9 the parabola sags 0.64 of its full sag below the straight line.
  return [{ line: [at(0.1), at(0.9)], sag: 0.64 * span * 0.012 }];
}

/** The flocks, from the house data where it has the places (roofs, poles), by hand for the hedges and lawns. */
function flocks(): FlockSpec[] {
  const roofs = house.surroundings?.roofs ?? [];
  const near = (x: number, z: number, r: number) =>
    roofs.filter((f) => Math.hypot(f.p[0][0] - x, f.p[0][1] - z) < r).map(ridge).filter((l): l is [V3, V3] => !!l).map((line) => ({ line }));
  const bungalowRoof = roofs.find((f) => Math.hypot(f.p[0][0] - 83.34, f.p[0][1] - 197.19) < 0.5);
  // The plot's hedges are 1.7 m blocks with leafy lumps on top up to 16 cm higher (world/surroundings.ts buildHedges).
  const hedges: Perch[] = [
    { line: [v3(11.65, 1.86, -22.4), v3(11.65, 1.86, 16.3)] },
    { line: [v3(-2.75, 1.86, -22.4), v3(-2.75, 1.86, 16.3)] },
    { line: [v3(-2.5, 1.86, -22.85), v3(11.4, 1.86, -22.85)] },
  ];
  // The main house's flat roofs: the top roof's edges at 9.15 m, the rims of the lower roofs at 6.25 m.
  const roofEdges: Perch[] = [
    { line: [v3(0.1, 9.15, 3.05), v3(8.9, 9.15, 3.05)] },
    { line: [v3(0.1, 9.15, 8.1), v3(8.9, 9.15, 8.1)] },
    { line: [v3(0.05, 9.15, 3.1), v3(0.05, 9.15, 8.05)] },
    { line: [v3(0.1, 6.27, 0.05), v3(8.9, 6.27, 0.05)] },
    { line: [v3(0.1, 6.27, 11.97), v3(8.9, 6.27, 11.97)] },
  ];
  return [
    // The main house
    { kind: 'sparrow', count: 6, site: 0, flee: 4, restless: 18, together: true,
      perches: [...hedges, { area: [4.2, 13.2, 8.8, 16.6] }, { area: [-2.2, 0.5, -0.9, 10] }, { area: [-2.2, -22.2, 10.9, -16.5] }] },
    { kind: 'blackbird', count: 2, site: 0, flee: 5, restless: 40,
      perches: [{ area: [-2.0, -22.0, 10.8, -16.2] }, { area: [4.8, -15.5, 10.8, -7.0] }, hedges[2], roofEdges[0], roofEdges[3]] },
    { kind: 'robin', count: 1, site: 0, flee: 3, restless: 30,
      perches: [{ area: [2.0, -13.5, 4.5, -10.6] }, { area: [-2.2, -14.0, 0.2, -6.0] }, { line: [v3(11.65, 1.86, -9), v3(11.65, 1.86, -2)] }, { point: v3(7.2, 1.88, -18.6) }] },
    { kind: 'pigeon', count: 3, site: 0, flee: 6, restless: 70, perches: [...roofEdges.slice(0, 3), ...near(4.45, -3, 45), { area: [3.8, 13.0, 9.0, 16.8] }] },
    { kind: 'starling', count: 7, site: 0, flee: 5, restless: 45, together: true, perches: [...cable(35, 42), ...cable(15, 35)] },
    { kind: 'magpie', count: 2, site: 0, flee: 9, restless: 35, perches: [{ area: [-40, -24, -8, 10] }, { area: [-40, -60, -10, -30] }, hedges[1]] },
    // The bungalow
    { kind: 'sparrow', count: 5, site: 1, flee: 4, restless: 18, together: true,
      perches: [{ line: [onRelief(96.9, 195.5, 1.02), onRelief(103.0, 209.0, 1.02)] }, { line: [onRelief(63.5, 199.4, 1.17), onRelief(89.5, 207.4, 1.17)] }, { area: [89.5, 198.5, 95.5, 205.5] }] },
    { kind: 'blackbird', count: 2, site: 1, flee: 5, restless: 40,
      perches: [{ area: [76, 199.5, 90, 205.5] }, { area: [92, 196, 95.5, 204] }, { line: [v3(83.6, 2.92, 197.3), v3(91.4, 2.92, 191.0)] }] },
    { kind: 'robin', count: 1, site: 1, flee: 3, restless: 30, perches: [{ area: [88.5, 196.5, 92.5, 200.5] }, { line: [onRelief(63.5, 199.4, 1.17), onRelief(89.5, 207.4, 1.17)] }] },
    { kind: 'pigeon', count: 2, site: 1, flee: 6, restless: 70,
      perches: [...(bungalowRoof ? [{ line: ridge(bungalowRoof)! }] : []), { point: v3(85.85, 6.92, 186.91) }, ...near(85, 192, 40)] },
  ];
}

interface Bird {
  spec: FlockSpec;
  flock: Bird[];
  mesh: number;
  slot: number;
  pos: V3;
  yaw: number;
  pitch: number;
  scale: number;
  phase: number;
  perch: Perch;
  /** In the air: the curve's three points, when it took off and how long it flies */
  flight: [V3, V3, V3] | null;
  t0: number;
  dur: number;
  /** Wings out (0 folded .. 1 out) */
  wings: number;
  /** A hop, peck or turn under way: what, since when, how long, from and to */
  act: 'hop' | 'peck' | 'turn' | null;
  a0: number;
  aDur: number;
  from: V3;
  to: V3;
  yaw0: number;
  yaw1: number;
  nextAct: number;
  nextMove: number;
  /** Take off at this time: after a flock mate, to land beside it on `join` (at `to`), or else away from `threat` */
  fleeAt: number;
  threat: V3;
  join: Perch | null;
}

const HALF_PI = Math.PI / 2;

export class Birds {
  readonly group = new THREE.Group();
  private birds: Bird[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private wingAttrs: THREE.InstancedBufferAttribute[] = [];
  private time = { value: 0 };
  private awake = [false, false];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private s = new THREE.Vector3();

  constructor(model: THREE.Object3D, private groundY: (x: number, z: number) => number) {
    const specs = flocks();
    const kinds = Object.keys(SPECIES) as Kind[];
    for (const kind of kinds) {
      const sp: Species = SPECIES[kind];
      const count = specs.filter((f) => f.kind === kind).reduce((n, f) => n + f.count, 0);
      const geo = painted(model, sp.colors, (name, g) => {
        const wing = name === 'BirdWingL' ? -1 : name === 'BirdWingR' ? 1 : 0;
        g.setAttribute('aWing', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(wing), 1));
        if (name === 'BirdTail') {
          const p = g.attributes.position;
          for (let i = 0; i < p.count; i++) p.setZ(i, -0.045 + (p.getZ(i) + 0.045) * sp.tail);
        }
      });
      const wings = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
      geo.setAttribute('aFly', wings);
      const mesh = new THREE.InstancedMesh(geo, this.material(sp), count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // they move about: the box of all of them isn't kept up to date
      mesh.userData.ignoreRay = true;
      this.meshes.push(mesh);
      this.wingAttrs.push(wings);
      this.group.add(mesh);
    }
    const used = kinds.map(() => 0);
    for (const spec of specs) {
      const flock: Bird[] = [];
      const k = kinds.indexOf(spec.kind);
      for (let i = 0; i < spec.count; i++) {
        const perch = spec.perches[Math.floor(Math.random() * spec.perches.length)];
        const pos = this.pointOn(perch);
        const b: Bird = {
          spec, flock, mesh: k, slot: used[k]++, pos, yaw: Math.random() * Math.PI * 2, pitch: 0,
          scale: SPECIES[spec.kind].scale * (0.92 + Math.random() * 0.16), phase: Math.random() * 6.28, perch,
          flight: null, t0: 0, dur: 0, wings: 0, act: null, a0: 0, aDur: 0, from: pos.clone(), to: pos.clone(), yaw0: 0, yaw1: 0,
          nextAct: Math.random() * 2, nextMove: 5 + Math.random() * spec.restless * 2, fleeAt: Infinity, threat: v3(0, 0, 0), join: null,
        };
        if ('line' in perch) b.yaw = this.across(perch.line, b.yaw);
        this.wingAttrs[k].setY(b.slot, b.phase);
        flock.push(b);
        this.birds.push(b);
      }
    }
    for (const b of this.birds) this.place(b);
  }

  /** The species' material: lit like everything else, the wings folded or flapping in the vertex shader. */
  private material(sp: Species): THREE.Material {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.uniforms.uFlap = { value: sp.flap };
      shader.uniforms.uGlide = { value: sp.glide };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aWing;\nattribute vec2 aFly;\nuniform float uTime;\nuniform float uFlap;\nuniform float uGlide;')
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          if (aWing != 0.0) objectNormal = normalize(mix(vec3(aWing, 0.4, 0.0), objectNormal, aFly.x));`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          if (aWing != 0.0) {
            // The shoulder; the wing's span runs out along x from it, its chord along z.
            vec3 sh = vec3(aWing * 0.018, 0.076, 0.0);
            vec3 w = transformed - sh;
            float span = abs(w.x);
            // Folded: the span swung back along the flank, the chord upright.
            vec3 folded = sh + vec3(aWing * (0.012 + span * 0.06), -0.004 - w.z * 0.35, 0.012 - span * 0.8);
            // Flying: beating about the body's axis, now and then a glide with the wings held out.
            float glide = uGlide * smoothstep(0.5, 0.8, sin(uTime * 0.8 + aFly.y * 3.0));
            float a = mix(sin(uTime * uFlap * 6.2832 + aFly.y) * 0.95 + 0.2, 0.1, glide);
            vec3 spread = sh + vec3(w.x * cos(a), span * sin(a) + w.y, w.z);
            transformed = mix(folded, spread, aFly.x);
          }`,
        );
    };
    return mat;
  }

  /** A random spot on a perch (near `around` along a line, for a flock landing together). */
  private pointOn(p: Perch, around?: V3): V3 {
    if ('point' in p) return p.point.clone();
    if ('line' in p) {
      const [a, b] = p.line;
      let t = Math.random();
      if (around) {
        const ab = b.clone().sub(a);
        const len = ab.length();
        t = THREE.MathUtils.clamp(around.clone().sub(a).dot(ab) / (len * len) + ((Math.random() - 0.5) * 2.2) / len, 0, 1);
      }
      const at = a.clone().lerp(b, t);
      at.y -= (p.sag ?? 0) * 4 * t * (1 - t);
      return at;
    }
    const [x0, z0, x1, z1] = p.area;
    let x = x0 + Math.random() * (x1 - x0);
    let z = z0 + Math.random() * (z1 - z0);
    if (around) {
      x = THREE.MathUtils.clamp(around.x + (Math.random() - 0.5) * 2.5, x0, x1);
      z = THREE.MathUtils.clamp(around.z + (Math.random() - 0.5) * 2.5, z0, z1);
    }
    return v3(x, this.groundY(x, z), z);
  }

  /** Facing across a line (as birds sit on a cable or a ridge), on the side nearer the heading. */
  private across([a, b]: [V3, V3], heading: number): number {
    const along = Math.atan2(b.x - a.x, b.z - a.z);
    const one = along + HALF_PI;
    const d = Math.atan2(Math.sin(heading - one), Math.cos(heading - one));
    return Math.abs(d) < HALF_PI ? one : one + Math.PI;
  }

  /** Fly from where it is to a spot on `perch`. */
  private fly(b: Bird, perch: Perch, to: V3): void {
    const from = b.pos.clone();
    const dist = from.distanceTo(to);
    const mid = from.clone().lerp(to, 0.5);
    mid.y = Math.max(from.y, to.y) + 0.6 + dist * 0.15;
    // Over a building in the way: the curve's top (at its middle) a metre above its roof.
    for (const o of OBSTACLES) {
      for (let k = 1; k < 10; k++) {
        const t = k / 10;
        if (from.y + (to.y - from.y) * t < o.top && insideRing(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, o.ring)) {
          mid.y = Math.max(mid.y, 2 * (o.top + 1) - (from.y + to.y) / 2);
          break;
        }
      }
    }
    b.flight = [from, mid, to];
    b.t0 = this.time.value;
    b.dur = Math.max(0.7, dist / SPECIES[b.spec.kind].speed) + 0.25;
    b.perch = perch;
    b.act = null;
  }

  /** Away from `threat`: the best of a few spots of the flock's perches, not too far. */
  private flee(b: Bird, threat: V3): void {
    let best: { perch: Perch; at: V3; score: number } | null = null;
    for (let i = 0; i < 8; i++) {
      const perch = b.spec.perches[Math.floor(Math.random() * b.spec.perches.length)];
      const at = this.pointOn(perch);
      const d = at.distanceTo(b.pos);
      if (d < 3 || d > 45) continue;
      const score = at.distanceTo(threat) - d * 0.3;
      if (!best || score > best.score) best = { perch, at, score };
    }
    if (!best) return;
    this.fly(b, best.perch, best.at);
    if (!b.spec.together) return;
    // The rest of the flock close by follows within a moment, to land beside it.
    for (const o of b.flock) {
      if (o === b || o.flight || o.pos.distanceTo(b.pos) > 5) continue;
      o.fleeAt = this.time.value + 0.05 + Math.random() * 0.35;
      o.threat.copy(threat);
      o.to.copy(best.at);
      o.join = best.perch;
    }
  }

  /** A shot or a blast at `at`: every bird within `radius` takes off at once. */
  scare(at: V3, radius: number): void {
    for (const b of this.birds) {
      if (b.flight || !this.awake[b.spec.site] || b.pos.distanceTo(at) > radius) continue;
      b.fleeAt = this.time.value + Math.random() * 0.25;
      b.threat.copy(at);
      b.join = null; // each finds its own way out
    }
  }

  update(dt: number, eye: V3): void {
    this.time.value += dt;
    const now = this.time.value;
    for (let s = 0; s < 2; s++) this.awake[s] = eye.distanceTo(SITES[s]) < AWAKE[s];
    const any = this.awake[0] || this.awake[1];
    this.group.visible = any;
    if (!any) return;
    for (const b of this.birds) {
      if (!this.awake[b.spec.site]) continue;
      if (b.flight) this.flying(b, now, dt);
      else this.perched(b, now, dt, eye);
      this.place(b);
    }
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
    for (const w of this.wingAttrs) w.needsUpdate = true;
  }

  private flying(b: Bird, now: number, dt: number): void {
    const [p0, p1, p2] = b.flight!;
    const s = Math.min(1, (now - b.t0) / b.dur);
    const u = 1 - s;
    b.pos.set(
      u * u * p0.x + 2 * u * s * p1.x + s * s * p2.x,
      u * u * p0.y + 2 * u * s * p1.y + s * s * p2.y,
      u * u * p0.z + 2 * u * s * p1.z + s * s * p2.z,
    );
    const dx = 2 * u * (p1.x - p0.x) + 2 * s * (p2.x - p1.x);
    const dy = 2 * u * (p1.y - p0.y) + 2 * s * (p2.y - p1.y);
    const dz = 2 * u * (p1.z - p0.z) + 2 * s * (p2.z - p1.z);
    b.yaw = Math.atan2(dx, dz);
    b.pitch = THREE.MathUtils.clamp(-Math.atan2(dy, Math.hypot(dx, dz)) * 0.6, -0.5, 0.5) - (s > 0.85 ? (s - 0.85) * 4 : 0);
    b.wings = Math.min(1, b.wings + dt * 14);
    if (s < 1) return;
    // Landed: face across a line, otherwise on as it flew; settle before doing anything.
    b.flight = null;
    b.pitch = 0;
    if ('line' in b.perch) b.yaw = this.across(b.perch.line, b.yaw);
    b.nextAct = now + 0.5 + Math.random();
    b.nextMove = now + b.spec.restless * (0.5 + Math.random());
  }

  private perched(b: Bird, now: number, dt: number, eye: V3): void {
    b.wings = Math.max(0, b.wings - dt * 9);
    // Too close: off, away from you. A flock mate's or a shot's alarm: off after the moment set.
    if (now >= b.fleeAt) {
      b.fleeAt = Infinity;
      if (!b.join) this.flee(b, b.threat);
      else if (b.to.distanceTo(b.pos) > 2) this.fly(b, b.join, this.pointOn(b.join, b.to)); // already beside it: stays
      b.join = null;
      return;
    }
    if (eye.distanceTo(b.pos) < b.spec.flee) {
      this.flee(b, eye);
      return;
    }
    // Now and then to another spot (a flock goes together).
    if (now > b.nextMove) {
      const perch = b.spec.perches[Math.floor(Math.random() * b.spec.perches.length)];
      const to = this.pointOn(perch);
      if (to.distanceTo(b.pos) > 2 && to.distanceTo(eye) > b.spec.flee * 1.5) {
        this.fly(b, perch, to);
        if (b.spec.together) {
          for (const o of b.flock) {
            if (o === b || o.flight) continue;
            o.fleeAt = now + 0.1 + Math.random() * 0.8;
            o.to.copy(to);
            o.join = perch;
          }
        }
      } else b.nextMove = now + 3;
      return;
    }
    // Hops, pecks and turns.
    if (b.act) {
      const f = Math.min(1, (now - b.a0) / b.aDur);
      if (b.act === 'hop') {
        b.pos.lerpVectors(b.from, b.to, f);
        if (!(SPECIES[b.spec.kind] as Species).walks) b.pos.y += Math.sin(f * Math.PI) * 0.045 * b.scale;
      } else if (b.act === 'peck') b.pitch = Math.sin(f * Math.PI) * 0.75;
      else b.yaw = b.yaw0 + (b.yaw1 - b.yaw0) * f;
      if (f >= 1) b.act = null;
      return;
    }
    if (now < b.nextAct) return;
    const ground = 'area' in b.perch;
    const r = Math.random();
    b.a0 = now;
    if (ground && r < 0.45) {
      const walks = (SPECIES[b.spec.kind] as Species).walks;
      const step = (walks ? 0.22 : 0.1 + Math.random() * 0.15) * b.scale;
      const [x0, z0, x1, z1] = (b.perch as { area: [number, number, number, number] }).area;
      const x = b.pos.x + Math.sin(b.yaw) * step;
      const z = b.pos.z + Math.cos(b.yaw) * step;
      if (x > x0 && x < x1 && z > z0 && z < z1) {
        b.act = 'hop';
        b.aDur = walks ? 0.45 : 0.16;
        b.from.copy(b.pos);
        b.to.set(x, this.groundY(x, z), z);
      } else this.turn(b, Math.PI * (0.6 + Math.random() * 0.8));
    } else if (r < (ground ? 0.75 : 0.3)) {
      b.act = 'peck';
      b.aDur = ground ? 0.3 : 0.5;
    } else this.turn(b, ground ? (Math.random() - 0.5) * 3 : 'line' in b.perch && Math.random() < 0.5 ? Math.PI : (Math.random() - 0.5) * 1.2);
    b.nextAct = now + (ground ? 0.3 + Math.random() * 1.6 : 1.5 + Math.random() * 4);
  }

  private turn(b: Bird, by: number): void {
    b.act = 'turn';
    b.aDur = 0.12 + Math.abs(by) * 0.05;
    b.yaw0 = b.yaw;
    b.yaw1 = b.yaw + by;
  }

  /** Its matrix and wing state into its species' mesh. */
  private place(b: Bird): void {
    this.e.set(b.pitch, b.yaw, 0);
    this.q.setFromEuler(this.e);
    this.s.setScalar(b.scale);
    this.m.compose(b.pos, this.q, this.s);
    this.meshes[b.mesh].setMatrixAt(b.slot, this.m);
    this.wingAttrs[b.mesh].setX(b.slot, b.wings);
  }

  /** Birds that are sitting near a point, for their songs: where, and which kind. */
  sitting(at: V3, radius: number): { pos: V3; kind: Kind }[] {
    return this.birds.filter((b) => !b.flight && this.awake[b.spec.site] && b.pos.distanceTo(at) < radius).map((b) => ({ pos: b.pos, kind: b.spec.kind }));
  }
}

export type BirdKind = Kind;
