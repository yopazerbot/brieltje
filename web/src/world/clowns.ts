import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import CLOWNS from '../../shared/clowns.json';
import WEAPONS from '../../shared/weapons.json';
import { bruteDamage, newBrute, stepBrute, type Brute, type BruteEvent, type Spot } from '../../shared/brutes.mjs';
import { onPaintball, PAINT, paintball } from '../paintball';
import { sound } from '../sound';
import { paintJoints } from './paint';
import { terrain } from './terrain';

/**
 * Characters to shoot at, our own models: clowns (tools/clown.py) strolling round a spot in the
 * gardens, and giant strongmen (tools/strongman.py) on the fields across the map, who fight back:
 * they go for armed players, throw rocks and stomp (shared/brutes.mjs; the server runs them in
 * multiplayer, this file when you play alone), and take many hits (a health bar shows how many).
 * A few stand there from the start, the admin places more with the planner. Each walks a loop on
 * the shared clock (like the cats), so every player sees it in the same place without positions
 * being sent. Come close and a clown waves, a strongman flexes. Shot, a clown honks and a
 * strongman groans; both fall over backwards and are back after a while. The models are turned
 * by their joints (Body, Head, Arm_L/R, Leg_L/R, and the strongman's Forearm_L/R): no skeleton,
 * no animation clips. In paintball they get blobs of paint on them, and a strongman's bar fills up
 * with paint until he is splattered.
 */

export type Kind = keyof typeof CLOWNS.kinds;

export interface ClownSpec {
  id: number;
  x: number;
  y: number;
  z: number;
  kind?: Kind;
  /** Down for this many more milliseconds (when you join) */
  ms?: number;
}

type Point = [number, number];
type Joint = 'Body' | 'Head' | 'Arm_L' | 'Arm_R' | 'Forearm_L' | 'Forearm_R' | 'Leg_L' | 'Leg_R';

/** A strongman as the server sends him, ten times a second. */
export interface BruteView {
  id: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  act: Brute['act'];
  hp: number;
}

interface Clown {
  spec: ClownSpec;
  /** A strongman's fight: where he is, what he does, his health */
  brain?: Brute;
  /** Where the server last said he is (followed smoothly) */
  goal?: BruteView;
  /** When his throw or stomp began, and when he let go (s, local clock) */
  actAt: number;
  releasedAt: number;
  bar?: { sprite: THREE.Sprite; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture; hp: number };
  kind: Kind;
  group: THREE.Group;
  model: THREE.Object3D;
  joints: Partial<Record<Joint, THREE.Object3D>>;
  bodyY: number;
  loop: Point[];
  hit: THREE.Mesh;
  deadUntil: number;
  cried: boolean;
}

const JOINTS: Joint[] = ['Body', 'Head', 'Arm_L', 'Arm_R', 'Forearm_L', 'Forearm_R', 'Leg_L', 'Leg_R'];
export const KINDS = CLOWNS.kinds;
const kindOf = (k: unknown): Kind => (typeof k === 'string' && k in KINDS ? (k as Kind) : 'clown');
const FIGHT = CLOWNS.kinds.strongman.fight;
const rockGeo = new THREE.IcosahedronGeometry(0.45, 1);
const rockMat = new THREE.MeshStandardMaterial({ color: '#8d8a84', roughness: 0.95, flatShading: true });
const HIT = new THREE.CylinderGeometry(0.3, 0.3, 1.25, 8).translate(0, 0.625, 0);
const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
export const CLOWN_DEFAULTS: ClownSpec[] = CLOWNS.spots.map(([x, y, z, kind], i) => ({ id: i + 1, x: +x, y: +y, z: +z, kind: kindOf(kind) }));

/** Where one is at time t on its loop: walking between corners, pausing at each. */
function onLoop(loop: Point[], t: number, speed: number): { x: number; z: number; heading: number; walking: boolean } {
  if (loop.length < 2) return { x: loop[0][0], z: loop[0][1], heading: 0, walking: false };
  const legs = loop.map((p, i) => {
    const q = loop[(i + 1) % loop.length];
    return { from: p, to: q, time: Math.hypot(q[0] - p[0], q[1] - p[1]) / speed };
  });
  const cycle = legs.reduce((s, l) => s + l.time + CLOWNS.pause, 0);
  let u = ((t % cycle) + cycle) % cycle;
  for (const l of legs) {
    const heading = Math.atan2(l.to[0] - l.from[0], l.to[1] - l.from[1]);
    if (u < CLOWNS.pause) return { x: l.from[0], z: l.from[1], heading, walking: false };
    u -= CLOWNS.pause;
    if (u < l.time) {
      const f = u / l.time;
      return { x: l.from[0] + (l.to[0] - l.from[0]) * f, z: l.from[1] + (l.to[1] - l.from[1]) * f, heading, walking: true };
    }
    u -= l.time;
  }
  return { x: loop[0][0], z: loop[0][1], heading: 0, walking: false };
}

/** A clown's bicycle horn, made in code: two squeezes of a bright, nasal tone. */
function honk(at: THREE.Vector3): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 1, at.z, 3);
  if (!ctx || !dest) return;
  for (const [start, len] of [[0, 0.16], [0.2, 0.3]]) {
    const t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(440, t);
    o.frequency.linearRampToValueAtTime(380, t + len);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 4;
    f.frequency.value = 1300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(f).connect(g).connect(dest);
    o.start(t);
    o.stop(t + len + 0.05);
  }
}

/** A rock landing or a stomp, made in code: a low knock and a short rumble of noise. */
function thud(at: THREE.Vector3, loud = 1): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y, at.z, 10);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(90, t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.9 * loud, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.5);
}

/** A strongman's groan, made in code: a low, falling buzz through a vowel-like filter. */
function groan(at: THREE.Vector3): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 3, at.z, 8);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.9);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 2;
  f.frequency.setValueAtTime(700, t);
  f.frequency.linearRampToValueAtTime(400, t + 0.9);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.6, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
  o.connect(f).connect(g).connect(dest);
  o.start(t);
  o.stop(t + 1.05);
}

export class Clowns {
  readonly group = new THREE.Group();
  private clowns = new Map<number, Clown>();
  private templates = new Map<Kind, THREE.Object3D>();
  private specs: ClownSpec[] = [];
  private offset = 0; // shared clock minus local clock, in seconds
  private rocks: { mesh: THREE.Mesh; from: Spot; to: Spot; start: number; ms: number }[] = [];
  /** A rock landed or a strongman stomped here: for the dust, the shake and (alone) the damage. */
  onLand: (at: THREE.Vector3, what: 'rock' | 'stomp') => void = () => {};

  /** `floorAt`: the floor under a point; `free`: room for one standing there (no wall in the way). */
  constructor(private floorAt: (x: number, z: number, y: number) => number, private free: (x: number, z: number, y: number) => boolean) {
    // Paintball or not: the bars are drawn again the other way (health, or paint filling up).
    onPaintball(() => this.clowns.forEach((c) => c.bar && (c.bar.hp = -1)));
    for (const kind of Object.keys(KINDS) as Kind[]) {
      void new GLTFLoader().loadAsync(KINDS[kind].model).then((gltf) => {
        paintJoints(gltf.scene, JOINTS); // one draw call a joint (a clown: about 6 instead of 27)
        gltf.scene.traverse((o) => (o.userData.ignoreRay = true));
        this.templates.set(kind, gltf.scene);
        this.setAll(this.specs);
      }, () => {});
    }
  }

  private get now(): number {
    return performance.now() / 1000 + this.offset;
  }

  /** Line up with the server's clock (ms since 1970), so all players see them in the same place. */
  setClock(serverMs: number): void {
    this.offset = serverMs / 1000 - performance.now() / 1000;
  }

  /** Corners of its walk round its spot: as many of eight points as have room, at most four. */
  private loopFor(s: ClownSpec, kind: Kind): Point[] {
    const phase = (s.id * 2.399) % (Math.PI * 2);
    const corners: Point[] = [];
    for (let k = 0; k < 8 && corners.length < 4; k += 2) {
      const a = phase + (k * Math.PI) / 4;
      const r = KINDS[kind].radius * (0.7 + 0.3 * ((s.id + k) % 2));
      const p: Point = [s.x + Math.sin(a) * r, s.z + Math.cos(a) * r];
      const last = corners[corners.length - 1] ?? [s.x, s.z];
      const mid: Point = [(p[0] + last[0]) / 2, (p[1] + last[1]) / 2];
      if (this.free(p[0], p[1], s.y) && this.free(mid[0], mid[1], s.y)) corners.push(p);
    }
    return corners.length >= 2 ? corners : [[s.x, s.z]];
  }

  /** The ones there are now. */
  get list(): ClownSpec[] {
    return this.specs;
  }

  /** What one is called in the kill feed ("a clown"). */
  name(id: number): string {
    return KINDS[this.clowns.get(id)?.kind ?? 'clown'].name;
  }

  /** All there are now (from the server, or the starting ones alone). */
  setAll(list: ClownSpec[]): void {
    this.specs = list;
    const keep = new Set(list.map((s) => s.id));
    for (const [id, c] of this.clowns) {
      if (keep.has(id)) continue;
      this.drop(c);
      this.clowns.delete(id);
    }
    for (const s of list) {
      const kind = kindOf(s.kind);
      const template = this.templates.get(kind);
      if (!template) continue; // its model is still loading: added when it is in
      let c = this.clowns.get(s.id);
      if (!c || c.spec.x !== s.x || c.spec.z !== s.z || c.kind !== kind) {
        if (c) this.drop(c);
        const model = template.clone(true);
        const group = new THREE.Group();
        group.scale.setScalar(KINDS[kind].scale);
        group.userData.figure = true; // paintball's paint sticks on the body inside the hit box (weapon.ts)
        group.add(model);
        const hit = new THREE.Mesh(HIT, hitMaterial);
        hit.scale.set(KINDS[kind].width / 0.3, KINDS[kind].height / 1.25, KINDS[kind].width / 0.3); // head to toe
        hit.userData.clown = s.id;
        group.add(hit);
        this.group.add(group);
        const joints = Object.fromEntries(JOINTS.map((n) => [n, model.getObjectByName(n)]));
        c = { spec: s, kind, group, model, joints, bodyY: joints.Body?.position.y ?? 0, loop: this.loopFor(s, kind), hit, deadUntil: 0, cried: true, actAt: 0, releasedAt: 0 };
        if (kind === 'strongman') {
          c.brain = newBrute(s.id, s.x, s.y, s.z, FIGHT);
          c.bar = this.healthBar();
          this.group.add(c.bar.sprite);
        }
        this.clowns.set(s.id, c);
      }
      if (s.ms) c.deadUntil = this.now + s.ms / 1000;
    }
  }

  /** One taken away: his body and his health bar too (it hangs apart, over where he walks). */
  private drop(c: Clown): void {
    c.group.removeFromParent();
    if (c.bar) {
      c.bar.sprite.removeFromParent();
      c.bar.texture.dispose();
      (c.bar.sprite.material as THREE.SpriteMaterial).dispose();
    }
  }

  /** A health bar over a strongman's head (drawn again only when his health changes). */
  private healthBar(): NonNullable<Clown['bar']> {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 16;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.scale.set(2.2, 0.28, 1);
    sprite.renderOrder = 10;
    sprite.userData.ignoreRay = true;
    return { sprite, ctx: canvas.getContext('2d')!, texture, hp: -1 };
  }

  /**
   * Your bullet (or blast, `w`) hit `id`: 'down' if that brought it down, 'hurt' if a strongman
   * took it (alone his health goes down here; in multiplayer the server keeps it), null if it was down already.
   */
  hit(id: number, w: string, alone: boolean): 'down' | 'hurt' | null {
    const c = this.clowns.get(id);
    if (!c || this.now < c.deadUntil) return null;
    if (c.brain) {
      if (!alone) return 'hurt';
      c.brain.hp = Math.max(0, c.brain.hp - bruteDamage(w, WEAPONS));
      if (c.brain.hp > 0) return 'hurt';
    }
    this.down(id, CLOWNS.respawnSeconds);
    return 'down';
  }

  /** The strongmen as the server sees them (multiplayer). */
  setBrutes(list: BruteView[]): void {
    for (const v of list) {
      const c = this.clowns.get(v.id);
      if (!c?.brain) continue;
      if (!c.goal) Object.assign(c.brain, { x: v.x, z: v.z, yaw: v.yaw }); // first word: be there
      if (v.act !== c.brain.act) c.actAt = this.now;
      Object.assign(c.brain, { act: v.act, hp: v.hp, speed: v.speed });
      c.goal = v;
    }
  }

  /** Playing alone: the strongmen fight here, going for you (`me`) if you fight. */
  stepAlone(dt: number, me: { x: number; y: number; z: number } | null): void {
    const now = this.now;
    for (const c of this.clowns.values()) {
      if (!c.brain || now < c.deadUntil) continue;
      if (c.brain.hp <= 0) Object.assign(c.brain, newBrute(c.spec.id, c.spec.x, c.spec.y, c.spec.z, FIGHT)); // back, fresh, at his spot
      const was = c.brain.act;
      c.brain.y = c.spec.y + terrain.height(c.brain.x, c.brain.z); // on the relief: rocks leave and stomps land at his feet
      const events = stepBrute(c.brain, me ? [{ name: 'me', ...me }] : [], now * 1000, dt, FIGHT, (x, z) => this.free(x, z, c.spec.y));
      if (c.brain.act !== was) c.actAt = now;
      for (const e of events) this.event(e);
    }
  }

  /** A strongman threw a rock or stomped (here alone, or the server says so). */
  event(e: BruteEvent): void {
    const c = this.clowns.get(e.id);
    if (c) c.releasedAt = this.now;
    if (e.type === 'throw') {
      const mesh = new THREE.Mesh(rockGeo, rockMat);
      mesh.castShadow = true;
      mesh.userData.ignoreRay = true;
      mesh.position.set(e.from.x, e.from.y, e.from.z);
      this.group.add(mesh);
      this.rocks.push({ mesh, from: e.from, to: e.to, start: this.now, ms: e.ms });
    } else {
      const at = new THREE.Vector3(e.at.x, e.at.y, e.at.z);
      thud(at, 1.4);
      this.onLand(at, 'stomp');
    }
  }

  /** Rocks in the air: an arc from his hand to where you stood; a thud and a puff where they land. */
  private flyRocks(): void {
    const now = this.now;
    this.rocks = this.rocks.filter((r) => {
      const f = Math.min(1, ((now - r.start) * 1000) / r.ms);
      const d = Math.hypot(r.to.x - r.from.x, r.to.z - r.from.z);
      r.mesh.position.set(
        r.from.x + (r.to.x - r.from.x) * f,
        r.from.y + (r.to.y + 0.3 - r.from.y) * f + Math.max(2, d * 0.28) * 4 * f * (1 - f),
        r.from.z + (r.to.z - r.from.z) * f,
      );
      r.mesh.rotation.set(now * 5, now * 3, 0);
      if (f < 1) return true;
      r.mesh.removeFromParent();
      const at = new THREE.Vector3(r.to.x, r.to.y, r.to.z);
      thud(at);
      this.onLand(at, 'rock');
      return false;
    });
  }

  /** `id` was shot (by you or someone else): back in `seconds`. */
  down(id: number, seconds: number): void {
    const c = this.clowns.get(id);
    if (!c) return;
    c.deadUntil = this.now + seconds;
    c.cried = false;
  }

  /** The ones that are up within `radius` of a point (a blast). */
  near(p: THREE.Vector3, radius: number): number[] {
    const now = this.now;
    return [...this.clowns.values()]
      .filter((c) => now >= c.deadUntil && c.group.position.distanceTo(p) < radius + 0.4 * KINDS[c.kind].scale)
      .map((c) => c.spec.id);
  }

  /** The ones that are up, for the minimap. */
  blips(): { x: number; y: number; z: number; kind: Kind }[] {
    const now = this.now;
    return [...this.clowns.values()].filter((c) => now >= c.deadUntil).map((c) => ({ x: c.group.position.x, y: c.group.position.y, z: c.group.position.z, kind: c.kind }));
  }

  update(eye: THREE.Vector3, dt: number): void {
    const now = this.now;
    this.flyRocks();
    for (const c of this.clowns.values()) {
      const k = KINDS[c.kind];
      const dead = now < c.deadUntil;
      const since = CLOWNS.respawnSeconds - (c.deadUntil - now);
      c.hit.visible = !dead;
      if (c.bar) this.drawBar(c, dead);
      if (c.brain && !dead) {
        this.poseBrute(c, eye, dt, now);
        continue;
      }
      if (dead) {
        // Down: a honk or a groan, fall over backwards, lie there, then gone until it is back.
        if (!c.cried) {
          c.cried = true;
          (c.kind === 'strongman' ? groan : honk)(c.group.position);
        }
        c.group.visible = since < 3;
        c.model.rotation.x = -Math.min(1, since / (0.45 * Math.sqrt(k.scale))) * (Math.PI / 2);
        continue;
      }
      c.group.visible = true;
      c.model.rotation.x = 0;
      const p = onLoop(c.loop, now + c.spec.id * 5, k.speed);
      const y = this.floorAt(p.x, p.z, c.spec.y);
      c.group.position.set(p.x, y, p.z);
      const j = c.joints;
      const close = c.group.position.distanceTo(eye) < k.close;
      // Facing: along its walk; standing, towards you when you are close.
      c.group.rotation.y = !p.walking && close ? Math.atan2(eye.x - p.x, eye.z - p.z) : p.heading;
      // Steps follow the walking speed and the length of the legs (a clown: 7 a second).
      const step = Math.sin((now * 7 * k.speed) / (k.scale * 0.7) + c.spec.id) * (p.walking ? 0.55 : 0);
      j.Leg_L?.rotation.set(-step, 0, 0);
      j.Leg_R?.rotation.set(step, 0, 0);
      j.Arm_L?.rotation.set(step * 0.7, 0, 0);
      j.Arm_R?.rotation.set(-step * 0.7, 0, 0);
      j.Forearm_L?.rotation.set(0, 0, 0);
      j.Forearm_R?.rotation.set(0, 0, 0);
      if (!p.walking && close) {
        if (c.kind === 'strongman') {
          // A double-biceps flex: upper arms out to the side, forearms up, a little pulse.
          const pulse = Math.sin(now * 3) * 0.08;
          j.Arm_L?.rotation.set(0, 0, 1.31 + pulse); // upper arms level
          j.Arm_R?.rotation.set(0, 0, -1.31 - pulse);
          j.Forearm_L?.rotation.set(0, 0, 1.9); // fists up beside his head
          j.Forearm_R?.rotation.set(0, 0, -1.9);
        } else j.Arm_R?.rotation.set(0, 0, -2.3 + Math.sin(now * 8) * 0.35); // a clown waves at you
      }
      if (j.Body) j.Body.position.y = c.bodyY + Math.abs(step) * 0.04;
      j.Head?.rotation.set(0, 0, Math.sin(now * 1.7 + c.spec.id) * 0.08);
    }
  }

  /**
   * The health bar over a strongman: shown once he is hurt, drawn again when his health changes.
   * In paintball it fills up with paint instead, and when it is full he is splattered.
   */
  private drawBar(c: Clown, dead: boolean): void {
    const bar = c.bar!;
    const hp = dead ? 0 : c.brain!.hp;
    bar.sprite.visible = !dead && hp < FIGHT.hp;
    bar.sprite.position.set(c.group.position.x, c.group.position.y + KINDS[c.kind].height * KINDS[c.kind].scale + 0.7, c.group.position.z);
    if (hp === bar.hp) return;
    bar.hp = hp;
    const g = bar.ctx;
    g.fillStyle = 'rgba(10, 10, 12, 0.75)';
    g.fillRect(0, 0, 128, 16);
    if (paintball.on) {
      const paint = g.createLinearGradient(2, 0, 126, 0);
      PAINT.forEach((p, i) => paint.addColorStop(i / (PAINT.length - 1), p));
      g.fillStyle = paint;
      g.fillRect(2, 2, Math.round((124 * (FIGHT.hp - hp)) / FIGHT.hp), 12);
    } else {
      g.fillStyle = hp > FIGHT.hp * 0.35 ? '#e0b13a' : '#e0503a';
      g.fillRect(2, 2, Math.round((124 * hp) / FIGHT.hp), 12);
    }
    bar.texture.needsUpdate = true;
  }

  /** A strongman: where his fight has him, walking or striding, winding up a throw or a stomp, flexing when it's quiet. */
  private poseBrute(c: Clown, eye: THREE.Vector3, dt: number, now: number): void {
    const b = c.brain!;
    const k = KINDS[c.kind];
    if (c.goal) {
      // Multiplayer: follow the server's word smoothly (it speaks ten times a second).
      const f = 1 - Math.exp(-dt * 8);
      b.x += (c.goal.x - b.x) * f;
      b.z += (c.goal.z - b.z) * f;
      b.yaw += Math.atan2(Math.sin(c.goal.yaw - b.yaw), Math.cos(c.goal.yaw - b.yaw)) * f;
    }
    c.group.visible = true;
    c.model.rotation.x = 0;
    const y = this.floorAt(b.x, b.z, c.spec.y);
    c.group.position.set(b.x, y, b.z);
    c.group.rotation.y = b.yaw;
    const j = c.joints;
    const walking = b.speed > 0.2;
    const step = walking ? Math.sin((now * 7 * Math.max(b.speed, 1)) / (k.scale * 0.7) + c.spec.id) * (b.speed > 2 ? 0.7 : 0.55) : 0;
    j.Leg_L?.rotation.set(-step, 0, 0);
    j.Leg_R?.rotation.set(step, 0, 0);
    j.Arm_L?.rotation.set(step * 0.7, 0, 0);
    j.Arm_R?.rotation.set(-step * 0.7, 0, 0);
    j.Forearm_L?.rotation.set(0, 0, 0);
    j.Forearm_R?.rotation.set(0, 0, 0);
    const winding = Math.min(1, (now - c.actAt) / (b.act === 'throw' ? FIGHT.windup : FIGHT.stompWindup));
    const after = now - c.releasedAt; // just let go: follow through
    if (b.act === 'throw') {
      j.Arm_R?.rotation.set(-2.7 * winding, 0, -0.3 * winding); // the rock up behind his head
      j.Forearm_R?.rotation.set(-1.2 * winding, 0, 0);
    } else if (b.act === 'stomp') {
      j.Leg_R?.rotation.set(-1.1 * winding, 0, 0); // the knee up
      j.Arm_L?.rotation.set(0, 0, 0.6 * winding);
      j.Arm_R?.rotation.set(0, 0, -0.6 * winding);
    } else if (after < 0.35) {
      j.Arm_R?.rotation.set(-2.7 + (after / 0.35) * 3.3, 0, 0); // the arm comes down after the throw
    } else if (!walking && c.group.position.distanceTo(eye) < k.close) {
      // Quiet and you are close: a double-biceps flex, with a little pulse.
      const pulse = Math.sin(now * 3) * 0.08;
      j.Arm_L?.rotation.set(0, 0, 1.31 + pulse);
      j.Arm_R?.rotation.set(0, 0, -1.31 - pulse);
      j.Forearm_L?.rotation.set(0, 0, 1.9);
      j.Forearm_R?.rotation.set(0, 0, -1.9);
    }
    if (j.Body) j.Body.position.y = c.bodyY + Math.abs(step) * 0.04;
    j.Head?.rotation.set(0, 0, 0);
  }
}
