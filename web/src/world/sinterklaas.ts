import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { t } from '../i18n';
import { sound } from '../sound';
import type { World } from './collision';
import { paintJoints } from './paint';

/**
 * Sinterklaas on the church square (Yoshi), from his arrival in November until 6 December (world/season.ts): the
 * saint (tools/sinterklaas.py) on his white horse (the meadow's horse, tools/horse.py, painted white with a red
 * saddle cloth). He rides slowly round a small loop on the square and stands a while; when you come near he stops,
 * turns his head to you, waves and says something in a speech bubble ("Hello! Have you been good?"). Use next to him
 * and he gives you a handful of chocolate coins and speculaas, which pop out of his hand and fall at your feet.
 * No helpers: only the saint and his horse.
 *
 * Only in Explore, as the villagers (world/villagers.ts; main.ts decides with the same test): in Action, Paintball and
 * Zombies he is gone, so he is never something to shoot at. His meshes take no rays; the horse is in the way for
 * walking only. Local and for show: nothing goes over the network or is stored, the treats included.
 */

/** The loop he rides: its middle and radius, in the open part of the square by the parking row. */
export const LOOP = { x: 535, z: -762.5, r: 2.8 };
const HORSE_JOINTS = ['Body', 'Tack', 'Neck', 'Head', 'Reins', 'Ear_L', 'Ear_R', 'Tail', 'Leg_FL', 'Leg_FR', 'Leg_BL', 'Leg_BR', 'Shin_FL', 'Shin_FR', 'Shin_BL', 'Shin_BR'];
const SAINT_JOINTS = ['Body', 'Head', 'Arm_R'];
const LEGS = [['BL', 0, -1], ['FL', 0.25, 1], ['BR', 0.5, -1], ['FR', 0.75, 1]] as const; // leg, place in the stride, which way the lower leg folds
const WALK = 0.7; // m/s
const STRIDE = 1.6; // m a stride at a walk
const RIDE_S = 28; // s riding round
const STAND_S = 18; // s standing between rounds
const STOP = 7; // m: a player this near and he stops and turns to them
const TALK = 10; // m: his speech bubble shows within this
const REACH = 3.2; // m: Use reaches him
const LINES = ['sint.hello', 'sint.shoe', 'sint.carrot', 'sint.spain', 'sint.song', 'sint.kind'] as const;
const KEY = 'sinterklaas';
type Line = (typeof LINES)[number] | 'sint.treat';
/** The waving arm: the upper arm out to the side, the forearm up (x to z, y to x, z to y; tools/sinterklaas.py). */
const WAVE = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)));
const Z = new THREE.Vector3(0, 0, 1);

interface Piece {
  kind: 0 | 1; // a chocolate coin, a speculaas
  p: THREE.Vector3;
  v: THREE.Vector3;
  spin: THREE.Vector3;
  rot: THREE.Euler;
  age: number;
  floor: number;
}

export class Sinterklaas {
  readonly group = new THREE.Group();
  /** The horse and rider, moved round the loop (the treats lie in the world, outside it). */
  private mount = new THREE.Group();
  private loaded: 'no' | 'loading' | 'yes' = 'no';
  private horse: Record<string, THREE.Object3D | undefined> = {};
  private saint: Record<string, THREE.Object3D | undefined> = {};
  private active = false;
  private a = 0; // where on the loop (rad)
  private speed = 0;
  private gait = 0;
  private clock = 0;
  private headYaw = 0;
  private wave = 0; // 0 .. 1 the arm up
  private waveFor = 0; // s left to wave
  private wasNear = false;
  private line = 0;
  private lineFor = 0;
  private bubble: HTMLDivElement | null = null;
  private bubbleText: HTMLSpanElement | null = null;
  private said: Line = 'sint.hello';
  private treatWait = 0;
  private pieces: Piece[] = [];
  private coins: THREE.InstancedMesh | null = null;
  private biscuits: THREE.InstancedMesh | null = null;
  private placed = { x: NaN, z: NaN };
  private x = LOOP.x;
  private z = LOOP.z + LOOP.r;
  private yaw = 0;
  private ground = 0;
  private playerNear = false;

  constructor(private world: World, private groundAt: (x: number, z: number) => number, private precompile: (root: THREE.Object3D) => unknown = () => {}) {
    this.group.name = 'sinterklaas';
    this.group.visible = false;
  }

  /** In Explore during his days (main.ts): there, else gone (and out of the way). */
  setActive(on: boolean): void {
    if (on && this.loaded === 'no') this.load();
    this.active = on;
  }

  private load(): void {
    this.loaded = 'loading';
    const loader = new GLTFLoader();
    void Promise.all([loader.loadAsync('/models/horse.glb'), loader.loadAsync('/models/sinterklaas.glb')]).then(([h, s]) => {
      const horse = h.scene;
      // A white horse with a light mane, a red saddle cloth and dark tack. One draw call a joint.
      paintJoints(horse, HORSE_JOINTS, { Coat: '#ece8e1', Dark: '#cdc8c0', Marking: '#ece8e1', Pad: '#a3161b', Leather: '#3b2417', Metal: '#c9a227' });
      const saint = s.scene;
      paintJoints(saint, SAINT_JOINTS);
      this.horse = Object.fromEntries(HORSE_JOINTS.map((n) => [n, horse.getObjectByName(n)]));
      this.saint = Object.fromEntries(SAINT_JOINTS.map((n) => [n, saint.getObjectByName(n)]));
      // He sits where the saddle is deepest (the horse's Tack); his model's origin is his seat.
      (this.horse.Tack ?? horse).add(saint);
      for (const root of [horse, saint]) root.traverse((o) => (o.userData.ignoreRay = true));
      this.mount.add(horse);
      this.group.add(this.mount);
      this.buildTreats();
      this.loaded = 'yes';
      void this.precompile(this.group);
    }, () => {
      this.loaded = 'no';
    });
  }

  private buildTreats(): void {
    const gold = new THREE.MeshStandardMaterial({ color: '#e0b23a', metalness: 0.75, roughness: 0.3 });
    const biscuit = new THREE.MeshStandardMaterial({ color: '#8a4d22', roughness: 0.8 });
    this.coins = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.045, 0.045, 0.01, 14), gold, 30);
    this.biscuits = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.014, 0.06), biscuit, 24);
    for (const m of [this.coins, this.biscuits]) {
      m.count = 0;
      m.frustumCulled = false;
      m.userData.ignoreRay = true;
      m.raycast = () => {};
      this.group.add(m);
    }
  }

  /** On foot next to him, close enough for Use. */
  near(x: number, z: number, feet: number): boolean {
    return this.active && this.loaded === 'yes' && this.group.visible && Math.hypot(x - this.x, z - this.z) < REACH && Math.abs(feet - this.ground) < 1.5;
  }

  /** Use next to him: a handful of chocolate coins and speculaas for you, and a word. Only here, nothing kept. */
  treat(toX: number, toZ: number): void {
    if (this.treatWait > 0 || !this.coins) return;
    this.treatWait = 1.2;
    this.waveFor = Math.max(this.waveFor, 2.5);
    this.say('sint.treat', 4);
    const hand = new THREE.Vector3();
    (this.saint.Arm_R ?? this.group).getWorldPosition(hand);
    hand.y += 0.1;
    const toward = new THREE.Vector3(toX - hand.x, 0, toZ - hand.z);
    const d = Math.max(0.5, toward.length());
    toward.multiplyScalar(1 / d);
    const floor = this.groundAt(toX, toZ);
    for (let i = 0; i < 14; i++) {
      const kind = (i % 7 < 4 ? 0 : 1) as 0 | 1;
      const reach = Math.min(d, 2.4) * (0.6 + Math.random() * 0.5);
      const up = 2.6 + Math.random() * 1.4;
      const side = (Math.random() - 0.5) * 1.6;
      const v = new THREE.Vector3(toward.x * reach * 1.3 - toward.z * side, up, toward.z * reach * 1.3 + toward.x * side);
      this.pieces.push({
        kind, p: hand.clone(), v, age: 0, floor: floor + (kind ? 0.006 : 0.004),
        spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14),
        rot: new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3),
      });
    }
    if (this.pieces.length > 54) this.pieces.splice(0, this.pieces.length - 54);
    this.chime(hand);
  }

  /** A little chime, made in code: three bright notes going up. */
  private chime(at: THREE.Vector3): void {
    const ctx = sound.context();
    const dest = sound.at(at.x, at.y, at.z, 4);
    if (!ctx || !dest) return;
    const t0 = ctx.currentTime;
    [1046.5, 1318.5, 1568].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.65);
    });
  }

  private say(key: Line, seconds: number): void {
    this.said = key;
    this.lineFor = seconds;
  }

  /**
   * Each frame. `me`: the player on foot (null in a car, on a horse or a bike: he waves less at traffic); `ui`: the
   * speech bubble may show (no menu over the game); `view`: the size of the picture in CSS pixels.
   */
  update(dt: number, camera: THREE.Camera, me: { x: number; z: number } | null, ui: boolean, view: { w: number; h: number }): void {
    const shown = this.active && this.loaded === 'yes';
    this.group.visible = shown;
    if (!shown) {
      this.placeSolid(false);
      this.showBubble(null);
      this.pieces.length = 0;
      this.wasNear = false;
      return;
    }
    this.clock += dt;
    this.treatWait = Math.max(0, this.treatWait - dt);
    const dist = me ? Math.hypot(me.x - this.x, me.z - this.z) : Infinity;
    this.playerNear = dist < STOP;
    // Ride round for a while, then stand for a while; stop for anyone near.
    const riding = this.clock % (RIDE_S + STAND_S) < RIDE_S && !this.playerNear;
    const want = riding ? WALK : 0;
    this.speed += Math.sign(want - this.speed) * Math.min(Math.abs(want - this.speed), dt * 0.6);
    this.a += (this.speed * dt) / LOOP.r;
    this.x = LOOP.x + LOOP.r * Math.sin(this.a);
    this.z = LOOP.z + LOOP.r * Math.cos(this.a);
    this.yaw = Math.atan2(Math.cos(this.a), -Math.sin(this.a)); // along the loop
    this.ground = this.groundAt(this.x, this.z);
    this.mount.position.set(this.x, this.ground, this.z);
    this.mount.rotation.y = this.yaw;
    this.placeSolid(true);
    this.animateHorse(dt);

    // Near: he turns his head to you, waves when you come, now and then, and talks.
    if (this.playerNear && !this.wasNear) {
      this.waveFor = 3.5;
      this.say('sint.hello', 6);
      this.line = 1 + Math.floor(Math.random() * (LINES.length - 1));
    }
    this.wasNear = this.playerNear;
    let look = 0;
    if (me && dist < TALK + 4) {
      const rel = Math.atan2(me.x - this.x, me.z - this.z) - this.yaw;
      look = THREE.MathUtils.clamp(Math.atan2(Math.sin(rel), Math.cos(rel)), -1.0, 1.0);
    }
    this.headYaw += (look - this.headYaw) * Math.min(1, dt * 3);
    if (this.saint.Head) this.saint.Head.rotation.y = this.headYaw;
    this.lineFor -= dt;
    if (dist < TALK && this.lineFor <= 0) {
      this.say(LINES[this.line % LINES.length], 6);
      this.line = this.line % (LINES.length - 1) + 1; // the hello once, then the others in turn
      if (Math.random() < 0.4) this.waveFor = Math.max(this.waveFor, 2);
    }
    this.waveFor = Math.max(0, this.waveFor - dt);
    this.wave += ((this.waveFor > 0 ? 1 : 0) - this.wave) * Math.min(1, dt * 4);
    const arm = this.saint.Arm_R;
    if (arm) {
      const sway = new THREE.Quaternion().setFromAxisAngle(Z, 0.28 * Math.sin(this.clock * 8.5) * this.wave);
      arm.quaternion.identity().slerp(WAVE, this.wave).premultiply(sway);
    }
    this.updateTreats(dt);
    // The speech bubble over his mitre.
    if (ui && dist < TALK && this.lineFor > 0) {
      const at = new THREE.Vector3(0, 0.85, 0);
      (this.saint.Head ?? this.group).localToWorld(at);
      at.project(camera);
      this.showBubble(at.z < 1 && Math.abs(at.x) < 1.1 && Math.abs(at.y) < 1.1 ? { x: (at.x * 0.5 + 0.5) * view.w, y: (0.5 - at.y * 0.5) * view.h } : null);
    } else this.showBubble(null);
  }

  /** The horse's legs at a walk (four beats), its head nodding with them; the tail and ears when it stands. */
  private animateHorse(dt: number): void {
    const j = this.horse;
    const w = Math.min(1, this.speed / 0.5);
    this.gait = (this.gait + (this.speed * dt) / STRIDE) % 1;
    for (const [leg, phase, fold] of LEGS) {
      const a = (this.gait + phase) * Math.PI * 2;
      const upper = j[`Leg_${leg}`];
      const lower = j[`Shin_${leg}`];
      if (upper) upper.rotation.x = 0.3 * Math.sin(a) * w;
      if (lower) lower.rotation.x = fold * 0.55 * Math.max(0, -Math.cos(a)) * w; // folds as the leg swings forward
    }
    const nod = Math.sin(this.gait * Math.PI * 4);
    if (j.Neck) j.Neck.rotation.x = 0.05 * nod * w + 0.03 * Math.sin(this.clock * 0.4) * (1 - w);
    if (j.Head) j.Head.rotation.x = -0.03 * nod * w;
    if (j.Reins && j.Head) j.Reins.rotation.x = -j.Head.rotation.x;
    if (j.Body) j.Body.position.y = 0.012 * Math.abs(nod) * w;
    if (j.Tail) j.Tail.rotation.z = 0.12 * Math.sin(this.clock * 1.3) + 0.06 * Math.sin(this.clock * 3.1);
    const flick = Math.max(0, Math.sin(this.clock * 0.9) - 0.9) * 4;
    if (j.Ear_L) j.Ear_L.rotation.x = -0.2 * flick;
    if (j.Ear_R) j.Ear_R.rotation.x = -0.2 * Math.max(0, Math.sin(this.clock * 0.7 + 2) - 0.9) * 4;
  }

  private updateTreats(dt: number): void {
    if (!this.coins || !this.biscuits) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let coins = 0;
    let biscuits = 0;
    this.pieces = this.pieces.filter((p) => (p.age += dt) < 6);
    for (const p of this.pieces) {
      if (p.p.y > p.floor || p.v.y > 0) {
        p.v.y -= 9.8 * dt;
        p.p.addScaledVector(p.v, dt);
        p.rot.x += p.spin.x * dt;
        p.rot.y += p.spin.y * dt;
        p.rot.z += p.spin.z * dt;
        if (p.p.y <= p.floor) {
          // Landed: a little bounce, then flat on the ground.
          p.p.y = p.floor;
          p.v.set(p.v.x * 0.3, Math.abs(p.v.y) > 2 ? Math.abs(p.v.y) * 0.25 : 0, p.v.z * 0.3);
          if (p.v.y === 0) p.rot.set(0, p.rot.y, 0);
        }
      }
      const grow = Math.min(1, p.age * 6) * Math.min(1, (6 - p.age) / 0.6); // pops out, shrinks away at the end
      s.setScalar(Math.max(0.001, grow));
      m.compose(p.p, q.setFromEuler(p.rot), s);
      if (p.kind === 0) this.coins.setMatrixAt(coins++, m);
      else this.biscuits.setMatrixAt(biscuits++, m);
    }
    this.coins.count = Math.min(coins, 30);
    this.biscuits.count = Math.min(biscuits, 24);
    this.coins.instanceMatrix.needsUpdate = true;
    this.biscuits.instanceMatrix.needsUpdate = true;
  }

  /** The horse is in the way for walking (not for shots: there are none in Explore, and he is gone elsewhere). */
  private placeSolid(on: boolean): void {
    if (!on) {
      if (!Number.isNaN(this.placed.x)) this.world.setMoving(KEY, null, 0, 0, true);
      this.placed.x = NaN;
      return;
    }
    if (Math.hypot(this.x - this.placed.x, this.z - this.placed.z) < 0.02) return;
    this.placed = { x: this.x, z: this.z };
    const f = { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
    const ring: [number, number][] = [[1.15, 0.35], [1.15, -0.35], [-1.05, -0.35], [-1.05, 0.35]].map(([a, b]) => [this.x + f.x * a + f.z * b, this.z + f.z * a - f.x * b]);
    this.world.setMoving(KEY, ring, this.ground - 0.3, this.ground + 2.6, true);
  }

  /** The speech bubble at a spot on the screen (CSS pixels), or hidden. Its text is set with textContent only. */
  private showBubble(at: { x: number; y: number } | null): void {
    if (!at) {
      if (this.bubble) this.bubble.style.display = 'none';
      return;
    }
    if (!this.bubble) {
      const b = document.createElement('div');
      b.className = 'sint-bubble';
      Object.assign(b.style, {
        position: 'fixed', zIndex: '6', pointerEvents: 'none', transform: 'translate(-50%, -100%)', maxWidth: 'min(260px, 62vw)',
        padding: '8px 13px', borderRadius: '14px', background: 'rgba(255, 253, 248, 0.96)', color: '#3a1512', textAlign: 'center',
        fontWeight: '600', fontSize: '15px', lineHeight: '1.3', boxShadow: '0 3px 12px rgba(0, 0, 0, 0.28)', border: '2px solid #b0161d',
      });
      const text = document.createElement('span');
      const tail = document.createElement('div');
      Object.assign(tail.style, {
        position: 'absolute', left: '50%', bottom: '-8px', width: '12px', height: '12px', marginLeft: '-6px', background: 'rgba(255, 253, 248, 0.96)',
        borderRight: '2px solid #b0161d', borderBottom: '2px solid #b0161d', transform: 'rotate(45deg)',
      });
      b.append(text, tail);
      document.body.appendChild(b);
      this.bubble = b;
      this.bubbleText = text;
    }
    const text = t(this.said);
    if (this.bubbleText && this.bubbleText.textContent !== text) this.bubbleText.textContent = text;
    this.bubble.style.display = 'block';
    this.bubble.style.left = `${Math.round(at.x)}px`;
    this.bubble.style.top = `${Math.round(at.y)}px`;
  }

  /** For the checks: where he is and what he does. */
  state(): { x: number; z: number; speed: number; wave: number; said: string; near: boolean; pieces: number; shown: boolean } {
    return { x: this.x, z: this.z, speed: this.speed, wave: this.wave, said: this.lineFor > 0 ? this.said : '', near: this.playerNear, pieces: this.pieces.length, shown: this.group.visible };
  }
}
