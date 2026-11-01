import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import HORSES from '../../shared/horses.json';
import type { HorseSample } from '../../shared/wire.mjs';
import { netClock, Track } from '../net/track';
import { sound } from '../sound';
import type { World } from './collision';
import { paintJoints } from './paint';

/**
 * Three horses in the meadow across the road (our own model, tools/horse.py): a bay, a chestnut
 * and a grey. Each walks from spot to spot in the field and grazes a while at each, on the shared
 * clock like the cats, so every player sees them in the same place without anything being sent.
 *
 * You can ride them (E next to one): W to walk and trot, Shift to gallop while it has the breath
 * for it, A/D to steer, Space to jump a hedge or a fence; seen from the saddle, which rises and
 * falls with the horse. A horse you get off stays there and grazes. In multiplayer the server
 * keeps who rides which horse and where it is (see game.mjs); one someone else rides is drawn a
 * little behind on the server's clock, between the states it sends (net/track.ts).
 *
 * The model is turned by its joints: the legs (and, when the model has them, the lower legs at
 * the knee and the hock, and the ears), neck, head and tail. The gaits blend into each other with
 * the speed: a walk in four beats, a trot in diagonal pairs with the body bouncing, a gallop with
 * the body rocking; each hoof is heard as it lands (sharper on paving than on grass).
 */

export interface HorseState {
  i: number;
  x: number;
  z: number;
  yaw: number;
  /** m/s, for its legs */
  speed: number;
  /** Height of a jump in progress (m) */
  jump?: number;
  rider: string | null;
  /** Got off here: it grazes where it was left */
  parked: boolean;
}

export interface RideInput {
  throttle: number;
  brake: number;
  /** -1 left .. 1 right */
  steer: number;
  gallop: boolean;
  jump: boolean;
}

const JOINTS = ['Body', 'Tack', 'Neck', 'Head', 'Reins', 'Ear_L', 'Ear_R', 'Tail', 'Leg_FL', 'Leg_FR', 'Leg_BL', 'Leg_BR', 'Shin_FL', 'Shin_FR', 'Shin_BL', 'Shin_BR'];
const LEGS = ['BL', 'FL', 'BR', 'FR'] as const;
const GRAZE = 1.56; // neck down (rad), with the head turned back up so the muzzle reaches the grass
const HEAD = -1.07;
const BLEND = 1.5; // s to lower or raise the head
const SADDLE = 1.64; // m, the deepest point of the seat (the model's Tack), 1 cm ahead of its middle
const EYE = 0.85; // m above the seat
// Per gait: stride (m), how far the legs swing and the lower legs fold (rad), and each leg's place in the stride (BL, FL, BR, FR).
const GAITS = [
  { stride: 1.6, swing: 0.3, fold: 0.55, phase: [0, 0.25, 0.5, 0.75] }, // walk: four beats
  { stride: 2.6, swing: 0.42, fold: 0.95, phase: [0.5, 0, 0, 0.5] }, // trot: diagonal pairs
  { stride: 4.8, swing: 0.62, fold: 1.25, phase: [0, 0.45, 0.1, 0.55] }, // gallop
];
const FOLD = { F: 1, B: -1 }; // a front knee folds the lower leg back, a hock folds it forward

interface Horse {
  group: THREE.Group;
  joints: Record<string, THREE.Object3D | undefined>;
  state: HorseState;
  /** Where it is drawn (follows the server's state smoothly when someone else rides it) */
  x: number;
  z: number;
  y: number;
  yaw: number;
  speed: number;
  gait: number; // phase of the stride (rad)
  weights: [number, number, number]; // walk, trot, gallop, blended with the speed
  grazing: number; // 0 head up .. 1 grazing
  lean: number; // into a turn (rad)
  bounce: number; // the body's rise this frame (m), for the rider's view
  rock: number; // the body's pitch this frame (rad)
  jump: number; // height of a jump in progress (m)
  lastJump: number; // its height a frame ago: rising or falling
  footfall: number[]; // last stride phase of each leg, to hear it land
  fidget: number; // seconds to the next ear flick, head shake or snort
  track: Track<null>; // someone else rides it: x, z, yaw, speed, jump from the ticks
}

/** Where a horse is at time t on its walk: walking between spots, or grazing at one (and how far into it). */
export function horseOnLoop(i: number, t: number): { x: number; z: number; heading: number; grazing: number } {
  const { loop, graze } = HORSES.herd[i];
  const legs = loop.map((p, k) => {
    const q = loop[(k + 1) % loop.length];
    return { from: p, to: q, time: Math.hypot(q[0] - p[0], q[1] - p[1]) / HORSES.speed };
  });
  const cycle = legs.reduce((s, l) => s + l.time + graze, 0);
  let u = (((t + i * 11) % cycle) + cycle) % cycle;
  for (const l of legs) {
    const heading = Math.atan2(l.to[0] - l.from[0], l.to[1] - l.from[1]);
    if (u < graze) return { x: l.from[0], z: l.from[1], heading: NaN, grazing: Math.min(1, u / BLEND, (graze - u) / BLEND) };
    u -= graze;
    if (u < l.time) {
      const f = u / l.time;
      return { x: l.from[0] + (l.to[0] - l.from[0]) * f, z: l.from[1] + (l.to[1] - l.from[1]) * f, heading, grazing: 0 };
    }
    u -= l.time;
  }
  return { x: loop[0][0], z: loop[0][1], heading: 0, grazing: 0 };
}

/** How much of each gait at this speed (m/s), blended over about half a metre a second. */
function gaitWeights(v: number): [number, number, number] {
  const ramp = (a: number, b: number) => Math.min(1, Math.max(0, (v - a) / (b - a)));
  const trot = ramp(2.3, 2.9);
  const gallop = ramp(5.7, 6.5);
  return [1 - trot, trot * (1 - gallop), gallop];
}

/** A hoof landing, made in code: a knock (sharper on paving and roads, duller on grass). */
function hoof(at: THREE.Vector3, hard: boolean, loud: number): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y, at.z, 4);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(hard ? 520 : 140, t);
  o.frequency.exponentialRampToValueAtTime(hard ? 260 : 70, t + 0.06);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime((hard ? 0.35 : 0.5) * loud, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (hard ? 0.07 : 0.12));
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.15);
}

/** A snort, made in code: a short burst of breath through the nose. */
function snort(at: THREE.Vector3): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 1.5, at.z, 4);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const len = 0.35;
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * len), ctx.sampleRate);
  const d = buffer.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / d.length);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.5;
  f.frequency.setValueAtTime(900, t);
  f.frequency.exponentialRampToValueAtTime(350, t + len);
  const g = ctx.createGain();
  g.gain.value = 0.5;
  src.connect(f).connect(g).connect(dest);
  src.start(t);
}

export class Horses {
  readonly group = new THREE.Group();
  private horses: Horse[] = HORSES.herd.map((_, i) => ({
    group: new THREE.Group(), joints: {}, state: { i, x: 0, z: 0, yaw: 0, speed: 0, rider: null, parked: false },
    x: 0, z: 0, y: 0, yaw: 0, speed: 0, gait: i, weights: [1, 0, 0], grazing: 0, lean: 0, bounce: 0, rock: 0, jump: 0, lastJump: 0,
    footfall: [0, 0, 0, 0], fidget: 3 + i * 4, track: new Track<null>([false, false, true, false, false], 10, [0, 1]),
  }));
  private drawn = [0, 0, 0, 0, 0];
  private offset = 0; // shared clock minus local clock, in seconds
  /** The horse you ride, or -1 */
  mounted = -1;
  /** Breath for galloping (0..1); out of it, it has to get some back before it gallops again */
  stamina = 1;
  private blown = false;
  private jumpT = -1; // seconds into your jump, or -1
  private look = { yaw: 0, pitch: 0 };
  /** The horse you ride ran into the edge of the game this frame (main.ts says so) */
  atEdge = false;
  /** A hoof landed at a gallop on soft ground: a little dust there. */
  onDust: (at: THREE.Vector3) => void = () => {};

  constructor(private world: World) {
    for (const h of this.horses) this.group.add(h.group);
    void new GLTFLoader().loadAsync('/models/horse.glb').then((gltf) => {
      this.horses.forEach((h, i) => {
        const model = gltf.scene.clone(true);
        const coat = HORSES.herd[i].coat;
        // Its own coat (the grey without white markings: they are painted in its coat). One draw call a joint.
        paintJoints(model, JOINTS, { Coat: coat, ...(i === 2 ? { Marking: coat } : {}) });
        model.traverse((o) => (o.userData.ignoreRay = true));
        h.group.add(model);
        h.joints = Object.fromEntries(JOINTS.map((n) => [n, model.getObjectByName(n)]));
      });
    }, () => {});
  }

  private get now(): number {
    return performance.now() / 1000 + this.offset;
  }

  /** Line up with the server's clock (ms since 1970), so all players see the horses in the same place. */
  setClock(serverMs: number): void {
    this.offset = serverMs / 1000 - performance.now() / 1000;
  }

  /** Who rides which horse and where the ridden and parked ones are (from the server). */
  setAll(list: HorseState[], me: string): void {
    for (const s of list) {
      const h = this.horses[s.i];
      if (!h) continue;
      if (s.i === this.mounted && s.rider === me) continue; // yours: you move it
      const was = h.state;
      h.state = { ...s };
      if (!was.parked && !was.rider && (s.parked || s.rider)) Object.assign(h, { x: s.x, z: s.z, yaw: s.yaw }); // from its walk: no slide
      if (s.rider !== was.rider) h.track.clear();
    }
  }

  /** The horses in a tick taken at the server's time `st`: who rides which, where the ridden ones go. */
  receive(list: HorseSample[], st: number, me: string): void {
    for (const { age, ...s } of list) {
      if (s.i === this.mounted && s.rider === me) continue; // yours: you move it
      this.setAll([s], me);
      if (s.rider) this.horses[s.i]?.track.push(st - age, [s.x, s.z, s.yaw, s.speed, s.jump], null);
    }
  }

  /** Back to their walks (playing alone). */
  reset(): void {
    for (const h of this.horses) h.state = { ...h.state, rider: null, parked: false, speed: 0, jump: 0 };
    this.mounted = -1;
  }

  /** The horse within reach of a point that nobody rides, or -1. */
  nearest(x: number, z: number): number {
    let best = -1;
    let bestD = HORSES.reach;
    this.horses.forEach((h, i) => {
      const d = Math.hypot(h.x - x, h.z - z);
      if (!h.state.rider && d < bestD) [best, bestD] = [i, d];
    });
    return best;
  }

  /** You get on horse i (alone right away; in multiplayer once the server says so). */
  mount(i: number, me: string): void {
    const h = this.horses[i];
    this.mounted = i;
    h.state = { ...h.state, rider: me, parked: false, x: h.x, z: h.z, yaw: h.yaw, speed: 0, jump: 0 };
    h.speed = 0;
    this.look = { yaw: 0, pitch: 0 };
    this.jumpT = -1;
  }

  /** You get off: it stays where it is. Returns where you stand (beside its left shoulder). */
  dismount(): { x: number; z: number; y: number } | null {
    const h = this.horses[this.mounted];
    if (!h) return null;
    this.mounted = -1;
    h.jump = 0;
    h.state = { ...h.state, rider: null, parked: true, x: h.x, z: h.z, yaw: h.yaw, speed: 0, jump: 0 };
    h.speed = 0;
    const sx = Math.cos(h.yaw);
    const sz = -Math.sin(h.yaw);
    return { x: h.x + sx * 0.9, z: h.z + sz * 0.9, y: h.y };
  }

  /** The horse you ride: where it is, for your own state, the map and the prompt. */
  get ridden(): { x: number; y: number; z: number; yaw: number; speed: number; jump: number; i: number } | null {
    const h = this.horses[this.mounted];
    return h ? { x: h.x, y: h.y, z: h.z, yaw: h.yaw, speed: h.speed, jump: h.jump, i: this.mounted } : null;
  }

  /** One frame in the saddle: speed up, slow down, steer, jump; it stops against walls and hedges. */
  ride(dt: number, input: RideInput): void {
    const h = this.horses[this.mounted];
    if (!h) return;
    // A gallop takes breath; out of it, it only trots until it has some back.
    const galloping = input.gallop && !this.blown && input.throttle > 0.05;
    this.stamina = Math.min(1, Math.max(0, this.stamina + (galloping && h.speed > HORSES.trot ? -HORSES.stamina.drain : HORSES.stamina.regen) * dt));
    if (this.stamina <= 0) this.blown = true;
    else if (this.blown && this.stamina >= HORSES.stamina.resume) this.blown = false;
    const top = galloping ? HORSES.gallop : HORSES.trot;
    const want = input.throttle > 0.05 ? top * Math.min(1, input.throttle * 1.2) : input.brake > 0.05 ? -0.8 : 0;
    const rate = want > h.speed ? (galloping ? 3.2 : 2.4) : 4.5;
    const was = h.speed;
    h.speed += Math.sign(want - h.speed) * Math.min(Math.abs(want - h.speed), rate * dt);
    if (was <= HORSES.trot && h.speed > HORSES.trot + 0.5 && Math.random() < 0.5) snort(h.group.position);
    // Turns on the spot when standing, wider at a gallop; it leans into the turn.
    const turn = input.steer * (1.9 - 0.11 * Math.abs(h.speed));
    h.yaw -= turn * dt;
    h.lean += (Math.max(-0.14, Math.min(0.14, turn * h.speed * 0.02)) - h.lean) * (1 - Math.exp(-dt * 5));
    // A jump: up and over in `time` seconds, from a trot or faster.
    if (input.jump && this.jumpT < 0 && h.speed >= HORSES.jump.minSpeed) this.jumpT = 0;
    if (this.jumpT >= 0) {
      this.jumpT += dt;
      const f = this.jumpT / HORSES.jump.time;
      h.jump = f < 1 ? HORSES.jump.height * 4 * f * (1 - f) : 0;
      if (f >= 1) {
        this.jumpT = -1;
        hoof(h.group.position, false, 1.4); // landing
      }
    }
    const x = h.x + Math.sin(h.yaw) * h.speed * dt;
    const z = h.z + Math.cos(h.yaw) * h.speed * dt;
    // In the air it clears what is lower than its belly is high, but never the edge of the game
    // (shared/bounds.mjs), however high it jumps: there it stops, as at a wall too tall to jump.
    this.atEdge = !this.world.boxInBounds(x, z, h.yaw, 1.1, 0.35, { x: h.x, z: h.z, yaw: h.yaw });
    if (!this.atEdge && this.world.boxFree(x, z, h.yaw, 1.1, 0.35, h.y + 0.4 + h.jump, h.y + 1.7 + h.jump, `horse-${h.state.i}`)) [h.x, h.z] = [x, z];
    else h.speed *= 0.3;
    h.y = this.world.groundAt(h.x, h.z, h.y + 0.5, 0.4).y;
    Object.assign(h.state, { x: h.x, z: h.z, yaw: h.yaw, speed: h.speed, jump: h.jump });
  }

  /** The view from the saddle: it rises and falls and leans with the horse; `turn` and `tilt` (rad) look round. */
  saddleView(camera: THREE.PerspectiveCamera, turn: number, tilt: number): void {
    const h = this.horses[this.mounted];
    if (!h) return;
    this.look.yaw = Math.max(-2.2, Math.min(2.2, this.look.yaw - turn));
    this.look.pitch = Math.max(-1.2, Math.min(1.2, this.look.pitch + tilt));
    const back = -0.01 + Math.sin(h.rock) * 0.2; // the saddle swings fore and aft as the gallop rocks
    camera.position.set(h.x - Math.sin(h.yaw) * back, h.y + h.jump + SADDLE + EYE + h.bounce * 0.8, h.z - Math.cos(h.yaw) * back);
    camera.rotation.set(this.look.pitch - h.rock * 0.5, h.yaw + Math.PI + this.look.yaw, -h.lean * 0.6, 'YXZ');
  }

  /** For the minimap. */
  blips(): { x: number; y: number; z: number }[] {
    return this.horses.map((h) => ({ x: h.x, y: h.y, z: h.z }));
  }

  /** Every frame: where each horse is and how it moves; `eye`: where you listen from. */
  update(dt: number, eye: THREE.Vector3): void {
    const now = this.now;
    this.horses.forEach((h, i) => {
      const s = h.state;
      let grazing = 0;
      const yawBefore = h.yaw;
      if (i === this.mounted) {
        // Yours: ride() moves it.
      } else if (s.rider) {
        // Someone else rides it: where their states put it at the drawing time.
        if (h.track.at(netClock.time, this.drawn)) [h.x, h.z, h.yaw, h.speed, h.jump] = this.drawn;
        h.y = this.world.groundAt(h.x, h.z, h.y + 0.5, 0.4).y;
      } else if (s.parked) {
        // Left here: it grazes, now and then looking up (after the last few steps, if someone just got off it).
        const k = Math.hypot(s.x - h.x, s.z - h.z) < 5 ? 1 - Math.exp(-dt * 8) : 1;
        h.x += (s.x - h.x) * k;
        h.z += (s.z - h.z) * k;
        h.yaw += Math.atan2(Math.sin(s.yaw - h.yaw), Math.cos(s.yaw - h.yaw)) * k;
        Object.assign(h, { speed: 0, jump: 0 });
        grazing = Math.sin(now * 0.07 + i * 2) > -0.6 ? 1 : 0;
        h.y = this.world.groundAt(h.x, h.z, 0.5, 0).y;
      } else {
        const p = horseOnLoop(i, now);
        if (!Number.isNaN(p.heading)) h.yaw = p.heading;
        h.speed = p.grazing === 0 ? HORSES.speed : 0;
        [h.x, h.z] = [p.x, p.z];
        grazing = p.grazing;
        h.y = this.world.groundAt(h.x, h.z, 0.5, 0).y;
      }
      // Others lean into their turns too.
      if (i !== this.mounted && dt > 0) {
        const turnRate = Math.atan2(Math.sin(h.yaw - yawBefore), Math.cos(h.yaw - yawBefore)) / dt;
        h.lean += (Math.max(-0.14, Math.min(0.14, -turnRate * h.speed * 0.02)) - h.lean) * (1 - Math.exp(-dt * 5));
      }
      // Lowering or raising the head takes a moment.
      h.grazing += Math.sign(grazing - h.grazing) * Math.min(Math.abs(grazing - h.grazing), dt / BLEND);
      this.pose(h, dt, now, eye);
      // A block where the horse stands, so you can't walk through it.
      const fx = Math.sin(h.yaw);
      const fz = Math.cos(h.yaw);
      const ring: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [h.x + fx * (0.15 + a * 1.15) + fz * b * 0.3, h.z + fz * (0.15 + a * 1.15) - fx * b * 0.3]);
      this.world.setMoving(`horse-${i}`, i === this.mounted ? null : ring, h.y, h.y + 1.7);
    });
  }

  /** Legs by gait (blended), lower legs folding as they swing forward, the body, neck, head, ears and tail. */
  private pose(h: Horse, dt: number, now: number, eye: THREE.Vector3): void {
    const v = Math.abs(h.speed);
    const j = h.joints;
    const target = gaitWeights(v);
    for (let g = 0; g < 3; g++) h.weights[g] += (target[g] - h.weights[g]) * (1 - Math.exp(-dt * 6));
    const w = h.weights;
    const stride = w[0] * GAITS[0].stride + w[1] * GAITS[1].stride + w[2] * GAITS[2].stride;
    h.gait += (v / stride) * Math.PI * 2 * dt * Math.sign(h.speed || 1);
    const moving = Math.min(1, v / 0.4);
    const air = h.jump > 0.05;
    const listen = h.group.position.distanceTo(eye) < 35;
    const main = w[2] > 0.5 ? 2 : w[1] > 0.5 ? 1 : 0; // the gait it is mostly in, for its footfalls
    LEGS.forEach((leg, k) => {
      const front = leg[0] === 'F';
      const upper = j[`Leg_${leg}`];
      const lower = j[`Shin_${leg}`];
      if (air) {
        // Over a jump: forelegs tucked up, hind legs trailing.
        if (upper) upper.rotation.x = front ? -0.9 : 0.6;
        if (lower) lower.rotation.x = (front ? FOLD.F : FOLD.B) * 1.5;
        return;
      }
      // Each gait's swing for this leg, weighted: where the leg is, and how far its lower leg is folded.
      let swing = 0;
      let fold = 0;
      for (let g = 0; g < 3; g++) {
        if (w[g] < 0.001) continue;
        const phase = h.gait + GAITS[g].phase[k] * Math.PI * 2;
        swing += w[g] * Math.sin(phase) * GAITS[g].swing;
        fold += w[g] * Math.max(0, -Math.cos(phase)) * GAITS[g].fold; // most folded half way through the swing forward
      }
      if (upper) upper.rotation.x = swing * moving;
      if (lower) lower.rotation.x = (front ? FOLD.F : FOLD.B) * fold * moving;
      // Heard as it lands: when the leg is furthest forward (its phase passes 3/2 pi).
      const tau = Math.PI * 2;
      const p = ((((h.gait + GAITS[main].phase[k] * tau) % tau) + tau) % tau);
      const last = h.footfall[k];
      h.footfall[k] = p;
      if (listen && v > 0.3 && last < Math.PI * 1.5 && p >= Math.PI * 1.5) {
        const at = h.group.position;
        const hard = /pav|road|terrace|concrete|kerb/.test(this.world.groundAt(at.x, at.z, at.y + 0.5, 0.4).mat ?? '');
        hoof(at, hard, Math.min(1.2, 0.4 + v * 0.1));
        if (w[2] > 0.5 && !hard && k % 2 === 0) this.onDust(at.clone());
      }
    });
    // The body: a walk sways a little, a trot bounces twice a stride, a gallop rocks once a stride.
    h.bounce = moving * (w[0] * 0.015 * Math.abs(Math.sin(h.gait * 2)) + w[1] * 0.06 * Math.max(0, Math.sin(h.gait * 2)) + w[2] * 0.1 * Math.max(0, Math.sin(h.gait + 0.6)));
    h.rock = moving * w[2] * Math.sin(h.gait) * 0.07;
    const sway = moving * w[0] * Math.sin(h.gait) * 0.02;
    // Over a jump the body tips nose up on the way up, nose down on the way down.
    const tip = air ? (h.jump >= h.lastJump ? -0.12 : 0.1) : 0;
    h.lastJump = h.jump;
    h.group.position.set(h.x, h.y + h.jump + h.bounce - moving * 0.03, h.z);
    h.group.rotation.set(h.rock + tip, h.yaw, h.lean + sway, 'YXZ');
    // Neck and head: down to the grass while grazing (chewing a little); nodding as it walks, stretched out at a gallop.
    const g = h.grazing * h.grazing * (3 - 2 * h.grazing);
    const nod = moving * (w[0] * Math.sin(h.gait * 2 + 0.5) * 0.05 + w[1] * Math.sin(h.gait * 2) * 0.03 + w[2] * (0.18 + Math.sin(h.gait + 1.2) * 0.1));
    if (j.Neck) j.Neck.rotation.x = g * GRAZE + nod;
    if (j.Reins) j.Reins.visible = g < 0.3; // a rigid piece: it can't follow the head down to the grass
    // Now and then: an ear flicks, the head shakes, a snort.
    h.fidget -= dt;
    if (h.fidget <= 0) {
      h.fidget = 4 + Math.random() * 9;
      if (v < 1 && Math.random() < 0.15 && h.group.position.distanceTo(eye) < 25) snort(h.group.position);
    }
    const shaking = v < 1 && h.fidget > 8.6;
    if (j.Head) j.Head.rotation.set(g * HEAD + (g > 0.9 ? Math.sin(now * 3 + h.state.i) * 0.05 : 0) + moving * w[2] * 0.15, 0, shaking ? Math.sin(now * 25) * 0.15 : 0);
    j.Ear_L?.rotation.set(h.fidget % 4 < 0.4 ? -0.5 : 0, 0, 0);
    j.Ear_R?.rotation.set(-Math.max(0, Math.sin(now * 0.9 + h.state.i)) * 0.25, 0, 0);
    // The tail: up and streaming at a gallop, a swish now and then.
    j.Tail?.rotation.set(moving * w[2] * 0.6, 0, Math.sin(now * 2.2 + h.state.i) * (Math.sin(now * 0.35 + h.state.i * 2) > 0.6 ? 0.35 : 0.06));
  }
}
