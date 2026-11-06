import * as THREE from 'three';
import { sound } from '../sound';

/**
 * The robot mower on the main house's back lawn (tools/garden_life.py). It works like a real one:
 * out of its station, straight across the lawn until it meets the boundary wire, a turn on the
 * spot to a new heading into the lawn, and again; after its mowing time it follows the wire round
 * to the station and charges until its next round. Its rounds come from the shared clock (a round
 * of ROUND seconds, the round's number seeds its turns), so every player sees it in the same
 * place without the server sending anything. A quiet electric whine when you are near.
 */

type P = [number, number];

// The wire, as the path of the mower's middle (about 35 cm in from the hedges and the beds, round
// the curved borders): from the back left corner along the back hedge, up the right hedge, along
// the lawn's edge behind the terrace, round the border's curve, down beside the path to the
// station, round the border at the end of the path and back.
const WIRE: P[] = [
  [-2.15, -22.25], [11.05, -22.25], [11.05, -6.6], [4.75, -6.6], [4.6, -7.0], [4.45, -7.75], [4.1, -8.5], [3.6, -9.3],
  [3.0, -9.95], [2.4, -10.45], [1.9, -10.75], [1.9, -14.0], [1.75, -14.6], [1.45, -15.2], [0.95, -15.55], [0.2, -15.78],
  [-0.6, -15.88], [-1.4, -15.88], [-2.15, -15.8],
];
/** The station, on the wire beside the path; the mower drives in heading -z (the wire's direction there). */
export const DOCK = { x: 1.9, z: -12.4, yaw: Math.PI };
const DOCK_EDGE = 10; // the wire's side from point 10 to 11

const SPEED = 0.33; // m/s
const TURN = 1.4; // rad/s
const ROUND = 2400; // s: one round, mowing and charging
const MOWING = 1500; // s of mowing a round before it heads home

interface Leg {
  t0: number;
  t1: number;
  a: [number, number, number]; // x, z, heading at the start
  b: [number, number, number]; // and at the end
}

/** A repeatable random series (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a ray from p along d first meets a side of the wire or the island: distance and the side (index in WIRE, or -1). */
function hit(p: P, d: P): { t: number; side: number } {
  let best = { t: Infinity, side: -1 };
  const test = (ring: P[]) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const den = d[0] * ez - d[1] * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((a[0] - p[0]) * ez - (a[1] - p[1]) * ex) / den;
      const u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den;
      if (t > 1e-4 && u >= 0 && u <= 1 && t < best.t) best = { t, side: i };
    }
  };
  test(WIRE);
  return best;
}

/** The heading (as the model's yaw: its front +z turned by yaw) of a direction on the plan. */
const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);

/** The shortest turn from heading a to heading b. */
function turnTo(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d;
}

/** One round's route: out of the station, mowing, home along the wire, charging until the round ends. */
function route(round: number): Leg[] {
  const rnd = random(round * 7919 + 13);
  const legs: Leg[] = [];
  let t = 0;
  let pose: [number, number, number] = [DOCK.x, DOCK.z, DOCK.yaw];
  const go = (x: number, z: number, yaw: number, seconds: number) => {
    const b: [number, number, number] = [x, z, yaw];
    legs.push({ t0: t, t1: t + seconds, a: pose, b });
    t += seconds;
    pose = b;
  };
  const turn = (yaw: number) => {
    const to = turnTo(pose[2], yaw);
    go(pose[0], pose[1], to, Math.abs(to - pose[2]) / TURN + 0.4);
  };
  const drive = (x: number, z: number) => go(x, z, pose[2], Math.hypot(x - pose[0], z - pose[1]) / SPEED);
  // Back out of the station and turn into the lawn.
  drive(DOCK.x, DOCK.z + 0.8);
  turn(yawOf(1, 0) + (rnd() - 0.5) * 1.6);
  let side = -1;
  for (;;) {
    const d: P = [Math.sin(pose[2]), Math.cos(pose[2])];
    const h = hit([pose[0], pose[1]], d);
    if (!isFinite(h.t)) break; // can't happen inside the wire
    const s = Math.max(0, h.t - 0.02);
    drive(pose[0] + d[0] * s, pose[1] + d[1] * s);
    side = h.side;
    if (t > MOWING) break;
    // A new heading into the lawn: away from the wire, up to 70 degrees either side of straight in.
    const a = WIRE[side];
    const b = WIRE[(side + 1) % WIRE.length];
    // The wire runs clockwise seen from above (x right, z down), so the lawn is on its right.
    const into = Math.atan2(-(b[1] - a[1]), b[0] - a[0]) + (rnd() - 0.5) * 2.4;
    turn(into);
  }
  // Home: along the wire in its own direction to the station.
  let i = side;
  for (let k = 0; k < WIRE.length + 1; k++) {
    const b = WIRE[(i + 1) % WIRE.length];
    if (i === DOCK_EDGE && (k > 0 || pose[1] >= DOCK.z)) {
      turn(yawOf(DOCK.x - pose[0], DOCK.z - pose[1]));
      drive(DOCK.x, DOCK.z);
      break;
    }
    turn(yawOf(b[0] - pose[0], b[1] - pose[1]));
    drive(b[0], b[1]);
    i = (i + 1) % WIRE.length;
  }
  turn(DOCK.yaw);
  legs.push({ t0: t, t1: ROUND, a: pose, b: pose }); // charging
  return legs;
}

export class Mower {
  readonly mesh: THREE.Mesh;
  private round = -1;
  private legs: Leg[] = [];
  private moving = false;
  private hum: { osc: OscillatorNode; gain: GainNode; at: PannerNode } | null = null;

  constructor(geometry: THREE.BufferGeometry, private groundY: (x: number, z: number) => number) {
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.userData.material = 'steel';
  }

  /** Put it where it is at time `now` (seconds on the shared clock); `eye` for the whine. */
  update(now: number, eye: THREE.Vector3): void {
    const round = Math.floor(now / ROUND);
    if (round !== this.round) {
      this.round = round;
      this.legs = route(round);
    }
    const t = now - round * ROUND;
    let lo = 0;
    let hi = this.legs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.legs[mid].t0 <= t) lo = mid;
      else hi = mid - 1;
    }
    const leg = this.legs[lo];
    const f = leg.t1 > leg.t0 ? Math.min(1, (t - leg.t0) / (leg.t1 - leg.t0)) : 1;
    const x = leg.a[0] + (leg.b[0] - leg.a[0]) * f;
    const z = leg.a[1] + (leg.b[1] - leg.a[1]) * f;
    this.moving = lo < this.legs.length - 1;
    this.mesh.position.set(x, this.groundY(x, z) + (this.moving ? 0.004 * Math.sin(now * 23) : 0), z); // a slight shiver from the blades
    this.mesh.rotation.y = leg.a[2] + (leg.b[2] - leg.a[2]) * f;
    this.whine(eye);
  }

  /** The quiet whine of the motors, from where it is, while it moves within 14 m. */
  private whine(eye: THREE.Vector3): void {
    const near = this.moving && this.mesh.visible && eye.distanceTo(this.mesh.position) < 14;
    if (near && !this.hum) {
      const ctx = sound.context();
      const at = sound.at(this.mesh.position.x, this.mesh.position.y + 0.2, this.mesh.position.z, 1.5) as PannerNode | null;
      if (!ctx || !at) return;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 182;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 720;
      filter.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(0.05, ctx.currentTime, 0.4);
      osc.connect(filter).connect(gain).connect(at);
      osc.start();
      this.hum = { osc, gain, at };
    } else if (!near && this.hum) {
      const { osc, gain } = this.hum;
      const ctx = osc.context;
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      osc.stop(ctx.currentTime + 1.5);
      this.hum = null;
    } else if (this.hum) {
      const p = this.mesh.position;
      this.hum.at.positionX.value = p.x;
      this.hum.at.positionZ.value = p.z;
      this.hum.osc.frequency.value = 182 + 6 * Math.sin(performance.now() / 1300);
    }
  }
}
