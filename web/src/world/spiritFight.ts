import * as THREE from 'three';
import DATA from '../../shared/brookSpirit.json';
import {
  blastSpirit, hurtSpirit, lightsOf, newSpirit, readSpirit, spiritLook, spiritPart, spiritView, stepSpirit,
  type SpiritData, type SpiritEvent, type SpiritState, type SpiritTrunk, type SpiritView,
} from '../../shared/brookSpirit.mjs';
import { trunkRadius, type TreeSpot } from '../../shared/trees.mjs';
import type { Target } from '../controls/aimAssist';
import { t } from '../i18n';
import { paintball } from '../paintball';
import { key, type Control } from '../shortcuts';
import { SpiritLine, type SpiritTone } from '../ui/spiritLine';
import { gunModel, gunsReady, SPECS, type WeaponId } from '../weapon';
import { BrookSpirit, loadBrookSpirit, spiritLightFits } from './brookSpirit';
import { daylight } from './daylight';
import { hitBoxMaterial } from './hitBox';
import type { Prism } from './houseData';
import { SpiritFx } from './spiritFx';
import { SpiritSign } from './spiritSign';
import { SpiritSound, type SpiritCue } from './spiritSound';

/**
 * The Brook Spirit's fight on the page: the creature in the wood by the brook (world/brookSpirit.ts draws it), its
 * hit boxes, its lights among the trees, its tells and pools (world/spiritFx.ts), the sign on the lane, its sound
 * (world/spiritSound.ts) and its one line (ui/spiritLine.ts). Two runners, one picture:
 * - Alone, the page runs the fight (shared/brookSpirit.mjs) with you as its only fighter while you are armed, on
 *   foot and near: its hits hurt you here (main.ts soloHurt), your shots and blasts hurt it here. Beaten, it leaves
 *   the grenade launcher lying where it came apart; walk into it to take it.
 * - Together the server runs it: the page only draws what `sp` and `spe` say (smoothed between the five `sp` a
 *   second), and tells the server which parts each of your shots hit (`sphit`). It never decides a hit's effect.
 * Both draw from the same view (spiritView alone, readSpirit together), so they look and sound the same.
 *
 * Open world only: nothing in a room (no `welcome.spirit`) or while any game is played (Zombies alone too).
 */

export const SPIRIT = DATA as unknown as SpiritData;
/** Your name in the fight alone */
const ME = 'me';
/** m: the line shows within this of the grove's middle */
const LINE_NEAR = 60;
/** m: the look is made within this, shown within SHOW, hidden past HIDE (its light comes and goes with it) */
const MAKE = 190;
const SHOW = 220;
const HIDE = 260;
/** m: a lit light's hit box */
const LIGHT_R = 0.5;
/** s a launcher's line stays */
const SAY = 4.5;

/** What the game tells the fight. */
export interface SpiritHost {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  /** The ground's height in the world at (x, z) */
  ground: (x: number, z: number) => number;
  /** The ring's trees (house_shell.json surroundings): the trunks are cover */
  trees: readonly TreeSpot[];
  /** A block in the world (the sign's post) */
  addBlock: (p: Prism) => void;
  send: (m: Record<string, unknown>) => void;
  /** Alone: it hurt you, `damage` from (x, z) */
  hurt: (damage: number, x: number, z: number) => void;
  /** Alone: a hit of yours counted (the hit marker) */
  marker: () => void;
  /** Alone: the grenade launcher into your hands with `n` grenades */
  giveLauncher: (n: number) => void;
}

/** You, each frame. */
export interface SpiritMe {
  x: number;
  feet: number;
  z: number;
  /** Alive, armed, on foot, not flying, not in a drop: it fights you (alone) */
  fighter: boolean;
  /** Action or Paintball (not Explore) */
  armed: boolean;
  flying: boolean;
  connected: boolean;
  /** A game is on (Zombies alone too): it is not there */
  game: boolean;
  control: Control;
  /** The Low preset or a phone */
  low: boolean;
}

const HEART_PARTS = new Set(['open', 'stun']);
const UNDER = new Set(['sink', 'under', 'rise']);

/** Whether the heart takes hits in view `v` (the server's rule, shared/brookSpirit.mjs heartOpen, without the grace). */
function heartOpenIn(v: SpiritView): boolean {
  if (v.lights !== 0) return false;
  if (v.mode === 'fight') return HEART_PARTS.has(v.act);
  if (v.mode === 'mend') return !UNDER.has(v.act);
  return false;
}

const bits = (m: number) => {
  let n = 0;
  for (let i = 0; i < 8; i++) n += (m >> i) & 1;
  return n;
};
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const spot = (o: unknown): { x: number; y: number; z: number } | null => {
  const p = o as { x?: unknown; y?: unknown; z?: unknown } | null;
  return p && typeof p === 'object' && fin(p.x) && fin(p.y) && fin(p.z) && [p.x, p.y, p.z].every((v) => Math.abs(v) < 1e5) ? { x: p.x, y: p.y, z: p.z } : null;
};

export class SpiritFight {
  readonly d = SPIRIT;
  readonly fx: SpiritFx;
  readonly sound = new SpiritSound();
  readonly line = new SpiritLine();
  readonly sign: SpiritSign;
  /** The look, once made (it loads its model on the way to the wood) */
  look: BrookSpirit | null = null;
  private making = false;
  private lookLow: boolean | null = null;
  /** Alone: the fight and its own clock (ms; it stands still while `held`, for pictures) */
  sim: SpiritState = newSpirit(SPIRIT);
  clock = 0;
  held = false;
  /** Together: the server's last view (checked), and where it is drawn (smoothed) */
  wire: SpiritView | null = null;
  private wireAt = new THREE.Vector3();
  private wireVel = new THREE.Vector3();
  private drawn = new THREE.Vector3();
  private hurtAt = -Infinity;
  /** Together: the server said nothing of it on joining (a room): it is not there */
  room = false;
  private together = false;
  private readonly trunks: SpiritTrunk[];
  private readonly lightSpots = lightsOf(SPIRIT);
  readonly heartBox: THREE.Mesh;
  readonly lightBoxes: THREE.Mesh[];
  private heart = new THREE.Vector3();
  private prev: { mode: string; act: string; lights: number; hp: number; pools: number; hurtAt: number } | null = null;
  private lastShot: THREE.Vector3 | null = null;
  private pending = new Map<WeaponId, Map<number, number>>();
  private flushing = false;
  /** Alone: the launcher lying where it came apart */
  drop: { x: number; y: number; z: number; until: number; group: THREE.Group } | null = null;
  private says: { text: string; until: number }[] = [];
  private pings: number[] = [];
  private engaged = false;
  /** Called when you start or stop fighting it alone (main.ts shows your health meanwhile) */
  onEngaged: (on: boolean) => void = () => {};
  /** Dev build: a fake server for the checks together (tools/dev/spirit_shots.mjs) */
  fake: { sent: Record<string, unknown>[] } | null = null;
  /** For the checks: where you were, what the last view was */
  last: { dist: number; view: SpiritView | null; absent: boolean } = { dist: Infinity, view: null, absent: false };

  constructor(private readonly host: SpiritHost) {
    const g = SPIRIT.grove;
    const reach = g.leash + 10;
    this.trunks = host.trees.filter((tr) => Math.hypot(tr.x - g.x, tr.z - g.z) <= reach).map((tr) => ({ x: tr.x, z: tr.z, r: trunkRadius(tr.h) }));
    this.fx = new SpiritFx(SPIRIT, this.lightSpots, host.ground);
    this.fx.group.visible = false;
    host.scene.add(this.fx.group);
    // The hit boxes: the open heart and each lit light (the look's own meshes take no rays).
    const ball = new THREE.SphereGeometry(1, 12, 8);
    this.heartBox = new THREE.Mesh(ball, hitBoxMaterial);
    this.heartBox.scale.setScalar(SPIRIT.heart.r);
    this.heartBox.userData.spirit = 0;
    this.heartBox.visible = false;
    this.lightBoxes = this.lightSpots.map((_, i) => {
      const m = new THREE.Mesh(ball, hitBoxMaterial);
      m.scale.setScalar(LIGHT_R);
      m.userData.spirit = i + 1;
      m.visible = false;
      return m;
    });
    host.scene.add(this.heartBox, ...this.lightBoxes);
    const s = SPIRIT.sign;
    this.sign = new SpiritSign(s, host.ground(s.x, s.z));
    host.scene.add(this.sign.group);
    host.addBlock(this.sign.block());
  }

  private get now(): number {
    return this.together ? performance.now() : this.clock;
  }

  /** `welcome.spirit` on joining somewhere: missing in a room. Checked as `sp` (readSpirit). Its launcher (`gl`) is a later step's. */
  welcome(spirit: unknown): void {
    this.room = !spirit || typeof spirit !== 'object';
    this.wire = null;
    this.prev = null;
    this.fx.clear();
    if (!this.room) this.receive(spirit);
  }

  /** A message of the fight from the server: `sp`, `spe` (and `sgl`, a later step's). Anything malformed is ignored. */
  message(m: unknown): void {
    if (!m || typeof m !== 'object') return;
    const k = (m as { t?: unknown }).t;
    if (k === 'sp') this.receive(m);
    else if (k === 'spe') this.effect(m as Record<string, unknown>);
    // `sgl` (the launcher together) is the server's later step: nothing drawn for it yet.
  }

  private receive(m: unknown): void {
    const now = performance.now();
    const v = readSpirit(m, now);
    if (!v) return;
    const old = this.wire;
    // A counted heart hit shows as its health going down while it can be hit.
    if (old && v.hp < old.hp - 1e-6 && (heartOpenIn(old) || heartOpenIn(v))) this.hurtAt = now;
    if (old && v.mode !== 'gone' && v.mode !== 'asleep' && old.mode === v.mode) {
      const dt = Math.max(0.05, (now - old.at) / 1000);
      this.wireVel.set(v.x - old.x, 0, v.z - old.z).divideScalar(dt);
      if (v.act !== 'drift' || this.wireVel.length() > 4) this.wireVel.set(0, 0, 0);
    } else this.wireVel.set(0, 0, 0);
    v.hurtAt = this.hurtAt;
    this.wire = v;
    this.wireAt.set(v.x, v.y, v.z);
  }

  /** `spe`: one-shot effects; fields checked before use, names never drawn but as text. */
  private effect(m: Record<string, unknown>): void {
    const time = this.now / 1000;
    switch (m.e) {
      case 'bolt': {
        const from = spot(m.from);
        const to = spot(m.to);
        if (!from || !to || !fin(m.ms) || m.ms < 0 || m.ms > 10000) return;
        this.fx.flight(this.look ? this.heart : new THREE.Vector3(from.x, from.y, from.z), to, m.ms, time);
        this.sound.cue('land', to, 1);
        return;
      }
      case 'cap':
        this.capped();
        return;
      default:
        // 'sweep', 'light', 'burst', 'beaten', 'back': drawn from the state (`sp`) as it changes.
        return;
    }
  }

  private capped(): void {
    this.fx.burst(this.heart, 'cap', this.now / 1000);
    this.sound.cue('cap');
  }

  /** One pellet or bullet of yours hit part `part` (weapon.ts onSpiritHit). */
  shot(part: number, point: THREE.Vector3, w: WeaponId): void {
    this.fx.burst(point, 'glint', this.now / 1000);
    this.lastShot = point.clone();
    if (!Number.isInteger(part) || part < 0 || part > this.lightSpots.length || this.last.absent) return;
    const spec = SPECS[w];
    if (!spec || spec.rocket || spec.lob || spec.body <= 0) return;
    if (!this.together) {
      const r = hurtSpirit(this.sim, ME, part, spec.body, this.clock);
      if (r.dealt > 0) this.host.marker();
      this.events(r.events);
      return;
    }
    // Together: counted per part for this shot, sent once its pellets are all in (they come in one go).
    let parts = this.pending.get(w);
    if (!parts) this.pending.set(w, (parts = new Map()));
    parts.set(part, (parts.get(part) ?? 0) + 1);
    if (!this.flushing) {
      this.flushing = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushing = false;
    for (const [w, parts] of this.pending) {
      const most = Math.max(1, SPECS[w]?.pellets ?? 1);
      const h = [...parts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => [p, Math.min(n, most)] as [number, number]);
      if (h.length) this.send({ t: 'sphit', w, h });
    }
    this.pending.clear();
  }

  private send(m: Record<string, unknown>): void {
    if (this.fake) this.fake.sent.push(m);
    else this.host.send(m);
  }

  /** Alone: your blast (a grenade, the launcher's, a rocket) at `at`. Together the server works blasts out itself. */
  blast(at: THREE.Vector3, radius: number, damage: number): void {
    if (this.together || this.last.absent) return;
    const r = blastSpirit(this.sim, at.x, at.y, at.z, radius, damage, ME, this.clock);
    if (r.dealt > 0) this.host.marker();
    this.events(r.events);
  }

  /** Alone: what the fight made happen. */
  private events(ev: SpiritEvent[]): void {
    const time = this.clock / 1000;
    for (const e of ev) {
      if (e.type === 'hit') {
        if (e.name === ME) this.host.hurt(e.damage, e.x, e.z);
      } else if (e.type === 'bolt') {
        this.fx.flight(this.look ? this.heart : new THREE.Vector3(e.from.x, e.from.y, e.from.z), e.to, e.ms, time);
        this.sound.cue('land', e.to, 1);
      } else if (e.type === 'cap') this.capped();
      else if (e.type === 'beaten') this.leave(e.drop);
    }
  }

  /** Alone: beaten, it leaves the grenade launcher lying where it came apart, on a low glowing ring. */
  private leave(at: { x: number; y: number; z: number }): void {
    this.takeAway();
    const y = this.host.ground(at.x, at.z);
    const group = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.0, 1.75), transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    const gun = new THREE.Group();
    gun.add(gunModel('launcher'));
    void gunsReady.then((ok) => {
      if (ok) gun.clear().add(gunModel('launcher'));
      gun.traverse((o) => (o.userData.ignoreRay = true));
    });
    gun.position.y = 0.4;
    gun.rotation.set(0, 0.6, 0.25); // tilted a little, slowly turning over its ring
    gun.scale.setScalar(1.5);
    group.add(ring, gun);
    group.position.set(at.x, y, at.z);
    group.traverse((o) => (o.userData.ignoreRay = true));
    this.host.scene.add(group);
    this.drop = { x: at.x, y, z: at.z, until: this.clock + SPIRIT.launcher.lie * 1000, group };
    this.fx.drop = { x: at.x, y, z: at.z };
  }

  private takeAway(): void {
    if (!this.drop) return;
    this.drop.group.removeFromParent();
    this.drop.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry.type === 'RingGeometry') {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    this.drop = null;
    this.fx.drop = null;
  }

  /** Alone: walked into the launcher, armed and on foot: yours, with its grenades. */
  private stepDrop(me: SpiritMe, dt: number): void {
    const d = this.drop;
    if (!d) return;
    if (this.clock >= d.until || this.together) {
      this.takeAway();
      return;
    }
    d.group.children[1].position.y = 0.4 + Math.sin(this.clock / 600) * 0.04;
    d.group.children[1].rotation.y += dt * 0.4;
    const L = SPIRIT.launcher;
    if (!me.fighter || Math.hypot(me.x - d.x, me.z - d.z) > L.across / 2 + 0.35 || Math.abs(me.feet - d.y) > L.high) return;
    this.takeAway();
    this.host.giveLauncher(L.rounds);
    const now = performance.now() / 1000;
    this.says = [
      { text: t(paintball.on ? 'sgl.takenYouPaint' : 'sgl.takenYou', { n: L.rounds }), until: now + SAY },
      { text: t(`sgl.hint.${me.control}` as 'sgl.hint.kbm', { shoot: key('shoot', me.control), weapons: key('weapons', me.control) }), until: 0 },
    ];
  }

  /** The aim assist's targets (controls/aimAssist.ts): the open heart and the lit lights, within 60 m. */
  assistTargets(eye: { x: number; y: number; z: number }): Target[] {
    const out: Target[] = [];
    if (this.last.absent) return out;
    if (this.heartBox.visible && this.heartBox.position.distanceTo(eye as THREE.Vector3) < 60) {
      const p = this.heartBox.position;
      out.push({ id: -1, foot: { x: p.x, y: p.y - 0.3, z: p.z }, top: { x: p.x, y: p.y + 0.3, z: p.z }, radius: SPIRIT.heart.r });
    }
    this.lightBoxes.forEach((b, i) => {
      if (!b.visible) return;
      const p = b.position;
      out.push({ id: -2 - i, foot: { x: p.x, y: p.y - 0.2, z: p.z }, top: { x: p.x, y: p.y + 0.2, z: p.z }, radius: LIGHT_R });
    });
    return out;
  }

  /** It is awake and you are near: the controller's aim assist may help (main.ts). */
  get assisting(): boolean {
    const v = this.last.view;
    return !!v && !this.last.absent && this.last.dist < LINE_NEAR && (v.mode === 'fight' || v.mode === 'mend');
  }

  /** Each frame, after you moved. */
  update(dt: number, camera: THREE.Camera, me: SpiritMe): void {
    const together = me.connected || !!this.fake;
    if (together !== this.together) {
      // Joined or left: the other runner starts from nothing.
      this.together = together;
      this.sim = newSpirit(SPIRIT);
      this.wire = null;
      this.room = false;
      this.prev = null;
      this.hurtAt = -Infinity;
      this.takeAway();
      this.fx.clear();
    }
    const g = SPIRIT.grove;
    const dist = Math.hypot(me.x - g.x, me.z - g.z);
    const absent = me.game || (together && this.room);
    this.last.dist = dist;
    this.last.absent = absent;
    if (!together && !this.held) this.clock += Math.min(dt, 0.25) * 1000;
    const now = this.now;
    const time = now / 1000;

    // Alone: the fight steps here, with you as its fighter (none while a game is on: it sleeps again).
    if (!together) {
      if (absent) {
        if (this.sim.mode !== 'asleep') {
          this.sim = newSpirit(SPIRIT);
          this.fx.clear();
          this.prev = null;
        }
        this.takeAway();
      } else if (!this.held) {
        const fighters = me.fighter ? [{ name: ME, x: me.x, y: me.feet, z: me.z }] : [];
        this.events(stepSpirit(this.sim, fighters, this.clock, Math.min(dt, 0.25), Math.random, this.trunks));
      }
    }
    let v: SpiritView | null = absent ? null : together ? this.wire : spiritView(this.sim, this.clock);
    if (v && together) v = this.smooth(v, dt);
    this.last.view = v;

    // The look: made on the way to the wood, shown near, hidden far off.
    if (!this.look && !this.making && dist < MAKE && !absent) this.make(me.low);
    const look = this.look;
    const show = !!v && !absent && dist < (look?.group.visible ? HIDE : SHOW);
    if (look) {
      if (this.lookLow !== me.low) {
        this.lookLow = me.low;
        look.setLook(me.low ? 'low' : 'high');
      }
      look.group.visible = show;
    }
    this.fx.low = me.low;
    this.fx.group.visible = show;
    const day = daylight();
    if (v && show) {
      const L = spiritLook(v, now, SPIRIT);
      if (look) {
        look.group.position.set(L.x, L.y, L.z);
        look.group.rotation.y = L.facing;
        look.open = L.open;
        look.shield = L.shield;
        look.anger = L.anger;
        look.fade = L.fade;
        look.reach = L.reach ? new THREE.Vector3(L.reach.x, this.host.ground(L.reach.x, L.reach.z) + 0.5, L.reach.z) : null;
        look.ground = this.host.ground(L.x, L.z);
        look.update(dt, camera);
        look.heartWorld(this.heart);
        look.group.visible = L.fade < 0.999;
      } else this.heart.set(L.x, L.y, L.z);
      this.transitions(v, now);
    } else this.prev = null;
    this.fx.update(dt, show ? v : null, now, time, this.heart, show && dist < 140, day);

    // The hit boxes: the heart while it can be hit (alone the fight's own rule, with its grace), each lit light.
    const heartOn = !!v && show && (together ? heartOpenIn(v) : spiritPart(this.sim, 0, this.clock) !== null);
    this.heartBox.visible = heartOn;
    if (heartOn) this.heartBox.position.copy(this.heart);
    this.lightBoxes.forEach((b, i) => {
      const lit = !!v && show && ((v.lights >> i) & 1) === 1;
      b.visible = lit;
      if (lit) b.position.copy(this.fx.lanterns.at[i]);
    });

    // Its sound, from where it is drawn.
    const awake = !!v && (v.mode === 'fight' || v.mode === 'mend');
    const camDist = v ? camera.position.distanceTo(this.heart) : Infinity;
    this.sound.update(camDist, this.heart.x, this.heart.y, this.heart.z, awake, v ? spiritLook(v, now, SPIRIT).anger : 0, show && !!v && v.mode !== 'gone' && v.mode !== 'apart');
    if (v && show) this.pingLights(v, time);

    if (!together) this.stepDrop(me, dt);
    const engaged = !together && !absent && awake && me.armed && dist < LINE_NEAR;
    if (engaged !== this.engaged) {
      this.engaged = engaged;
      this.onEngaged(engaged);
    }
    this.drawLine(v, me, dist, absent);
  }

  /** Together: between two `sp` (5 a second) it glides, never jumps; a rise elsewhere or a reset is a jump. */
  private smooth(v: SpiritView, dt: number): SpiritView {
    const ahead = Math.min(0.3, (performance.now() - v.at) / 1000);
    const tx = this.wireAt.x + this.wireVel.x * ahead;
    const tz = this.wireAt.z + this.wireVel.z * ahead;
    const far = Math.hypot(tx - this.drawn.x, tz - this.drawn.z) > 4 || Math.abs(this.wireAt.y - this.drawn.y) > 3;
    if (far || this.prev === null) this.drawn.set(tx, this.wireAt.y, tz);
    else {
      const k = 1 - Math.exp(-dt * 7);
      this.drawn.x += (tx - this.drawn.x) * k;
      this.drawn.y += (this.wireAt.y - this.drawn.y) * k;
      this.drawn.z += (tz - this.drawn.z) * k;
    }
    return { ...v, x: this.drawn.x, y: this.drawn.y, z: this.drawn.z };
  }

  private async make(low: boolean): Promise<void> {
    this.making = true;
    const model = await loadBrookSpirit();
    if (!model) return; // no model: the fight still runs, its lights and tells show
    this.look = new BrookSpirit(model, low ? 'low' : 'high', spiritLightFits(this.host.renderer));
    this.lookLow = low;
    this.look.group.visible = false;
    this.host.scene.add(this.look.group);
  }

  /** The sounds and flashes of what changed since the last frame (alone and together alike). */
  private transitions(v: SpiritView, now: number): void {
    const p = this.prev;
    const left = Math.max(0, (v.ms - (now - v.at)) / 1000);
    const time = now / 1000;
    const awake = v.mode === 'fight' || v.mode === 'mend';
    if (p) {
      if (v.mode !== p.mode) {
        if (v.mode === 'mend') this.sound.cue('mend');
        if (v.mode === 'apart') {
          this.sound.cue('end');
          this.fx.burst(this.heart, 'apart', time);
        }
        if (v.mode === 'fight' && p.mode === 'asleep') this.sound.cue('rise', null, 1.3);
      }
      if (awake && v.act !== p.act) {
        if (v.act === 'sweep') this.sound.cue('sweep', null, left);
        else if (v.act === 'bolt') this.sound.cue('bolt');
        else if (v.act === 'pool') this.sound.cue('pool', { x: v.tx, y: this.host.ground(v.tx, v.tz) + 0.5, z: v.tz }, left);
        else if (v.act === 'rise') this.sound.cue('rise', null, left);
        else if ((v.act === 'open' || v.act === 'stun') && v.lights === 0) this.sound.cue('open', null, left);
      }
      if (awake && v.lights !== p.lights) {
        if (p.lights === 0) this.sound.cue('shell');
        for (let i = 0; i < 8; i++) {
          const was = (p.lights >> i) & 1;
          const is = (v.lights >> i) & 1;
          const at = this.fx.lanterns.at[i];
          if (!at) continue;
          if (is && !was) this.sound.cue('chime', at);
          if (was && !is) {
            this.fx.burst(at, 'light', time);
            this.sound.cue('out', at);
          }
        }
        if (v.lights === 0) {
          this.fx.burst(this.heart, 'shell', time);
          this.sound.cue('burst');
          this.look?.hurt(1.2);
        }
      }
      if (v.hurtAt !== p.hurtAt && Number.isFinite(v.hurtAt)) {
        this.sound.cue('hit');
        const near = this.lastShot && this.lastShot.distanceTo(this.heart) < 3 ? this.lastShot : undefined;
        this.look?.hurt(0.6, near);
      }
    }
    this.prev = { mode: v.mode, act: v.act, lights: v.lights, hp: v.hp, pools: v.pools.length, hurtAt: v.hurtAt };
  }

  /** Lit lights ping softly every 3 s, each at its own moment: findable by ear. */
  private pingLights(v: SpiritView, time: number): void {
    for (let i = 0; i < 8; i++) {
      const slot = Math.floor((time + i * 0.41) / 3);
      if (((v.lights >> i) & 1) && this.pings[i] !== undefined && slot !== this.pings[i]) this.sound.cue('ping', this.fx.lanterns.at[i]);
      this.pings[i] = slot;
    }
  }

  /** The one line: within 60 m only, and the launcher's lines a moment after taking it. */
  private drawLine(v: SpiritView | null, me: SpiritMe, dist: number, absent: boolean): void {
    const now = performance.now() / 1000;
    while (this.says.length && this.says[0].until && now > this.says[0].until) this.says.shift();
    if (this.says.length) {
      const s = this.says[0];
      if (!s.until) s.until = now + SAY + 2; // the hint, after the first line
      this.line.set(s.text, 'gift');
      return;
    }
    if (!v || absent || dist > LINE_NEAR) {
      this.line.set(null);
      return;
    }
    const n = Math.max(1, Math.ceil(v.hp * 100));
    const awake = v.mode === 'fight' || v.mode === 'mend';
    let text: string | null = null;
    let tone: SpiritTone = 'calm';
    if (this.drop && v.mode === 'gone') {
      text = t(paintball.on ? 'sgl.dropPaint' : 'sgl.drop');
      tone = 'gift';
    } else if (v.mode === 'gone') {
      const left = Math.max(0, v.ms - (this.now - v.at));
      const s = Math.ceil(left / 1000);
      text = t('spirit.gone', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
    } else if (v.mode === 'asleep') text = t(me.armed ? 'spirit.asleep' : 'spirit.asleepExplore');
    else if (awake && me.armed && me.flying) text = t('srv.spFly');
    else if (awake && me.armed && dist > SPIRIT.grove.leash) text = t('srv.spFar');
    else if (awake && v.lights !== 0) {
      text = t('spirit.shell', { k: bits(v.lights) });
      tone = 'shell';
    } else if (v.mode === 'mend') text = t('spirit.mend');
    else if (v.mode === 'fight' && HEART_PARTS.has(v.act)) {
      text = t('spirit.open', { n });
      tone = 'open';
    } else if (v.mode === 'fight') {
      text = t('spirit.fight', { n });
      tone = 'fight';
    }
    this.line.set(text, tone);
  }
}

/**
 * Dev build only (main.ts window.briel.spirit; the build leaves it out): the state for the checks, the clock held
 * for pictures, a fake server for the checks together, the sounds by numbers.
 */
export function spiritDev(f: SpiritFight, render: (kind: SpiritCue | 'presence') => Promise<{ peak: number; rms: number; audible: number; nodes: number }>) {
  return {
    fight: f,
    state() {
      const v = f.last.view;
      const s = f.sim;
      return {
        together: !!f.fake, dist: f.last.dist, absent: f.last.absent, view: v && { ...v, pools: v.pools.length },
        sim: { mode: s.mode, act: s.act, phase: s.phase, hp: Math.round(s.hp), max: s.max, budget: s.budget, shell: s.shell, target: s.target, aim: s.aim, x: s.x, y: s.y, z: s.z, until: s.until, since: s.since, bolts: s.bolts, pools: s.pools },
        clock: f.clock, held: f.held,
        heart: f.heartBox.visible ? f.heartBox.position.toArray() : null,
        lights: f.lightBoxes.map((b) => (b.visible ? b.position.toArray() : null)),
        drop: f.drop && { x: f.drop.x, y: f.drop.y, z: f.drop.z, left: f.drop.until - f.clock },
        look: !!f.look, heartShown: f.look?.heartShown ?? 0, nodes: f.sound.nodes,
      };
    },
    /** Hold the fight's clock alone (the picture stays as it is; the look still breathes). */
    hold(on: boolean) {
      f.held = on;
    },
    /** Alone: change the fight's state for a picture (e.g. { hp: 900 }). */
    set(fields: Record<string, unknown>) {
      Object.assign(f.sim, fields);
    },
    reset() {
      f.sim = newSpirit(SPIRIT);
    },
    /** Pretend to be together: what the page would send is kept in `sent`; feed() plays the server. */
    fake(on: boolean) {
      f.fake = on ? { sent: [] } : null;
    },
    feed(m: unknown) {
      if (m && typeof m === 'object' && 'welcome' in m) f.welcome((m as { welcome: unknown }).welcome);
      else f.message(m);
    },
    sent: () => f.fake?.sent ?? [],
    sound: (kind: SpiritCue | 'presence') => render(kind).then(({ peak, rms, audible, nodes }) => ({ peak, rms, audible, nodes })),
  };
}
