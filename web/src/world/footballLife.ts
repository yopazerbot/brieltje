import * as THREE from 'three';
import { sound } from '../sound';
import { FC_SITE as S, fcAt } from './footballGround';
import { mood } from './mood';
import { VILLAGER_KIND as K, VILLAGER_UMBRELLA, type Extra, type Villagers } from './villagers';

/**
 * Life at FC Smetlede's ground (world/footballGround.ts; Yoshi, 8 Nov 2026: "make this a hotspot that is really nice and
 * lively"): a youth training on the far half of the pitch, a coach with them and parents watching.
 * - A shooting drill at the far goal: the children queue at the edge of the box, each in turn takes a ball, dribbles
 *   in and shoots; the keeper goes for it. A goal swells the net and the parents cheer, a save rolls back out.
 * - A rondo nearer the halfway line: six in a circle pass a ball round, two in the middle chase it.
 * - The coach watches the shooting and blows the whistle now and then; an assistant watches the rondo.
 * - Parents and grandparents along the rail in front of the canteen, a few sitting in the low stand; fewer at night
 *   and in the rain (umbrellas up), a wave and a cheer at a goal.
 * The figures are the villagers' (world/villagers.ts `setExtras`: the same models and clips, no extra draw calls), the
 * balls ours (one instanced mesh). Everything here is for show and runs on each page on its own: nothing goes over the
 * network, nothing is a target, and the player's own ball (shared/ball.mjs 'fc', the near half) is the server's.
 * Sounds made in code from where they happen: the kicks, the whistle, the children calling, the cheering; quieter at
 * night.
 */

const NEAR = 230; // m from the centre spot: closer than this the training is on
const BALL_R = 0.11;
const GROUND = 0.012; // the pitch's paint over the lawn

type Clip = 'Idle' | 'Talk' | 'Jog' | 'Walk' | 'Sit' | 'Wave' | 'WalkUmb';

interface Actor extends Extra {
  role: 'kid' | 'keeper' | 'coach' | 'helper' | 'fan' | 'sitter';
  u: number;
  w: number;
  tu: number;
  tw: number;
  speed: number;
  face: number;
  /** Plays this clip until `until` (a wave, the swing of a kick), else what it does */
  once: Clip | '';
  until: number;
  /** Standing clip */
  rest: Clip;
  moving: boolean;
  floor: number;
  dressed: boolean;
  cols: Record<number, string>;
  want: number | undefined;
}

interface Ball {
  u: number;
  w: number;
  y: number;
  vu: number;
  vw: number;
  vy: number;
  /** held (at someone's feet), flying or rolling free, or resting */
  state: 'held' | 'free' | 'rest';
  owner: Actor | null;
  spin: THREE.Quaternion;
  visible: boolean;
}

const RED = '#c62828';
const WHITE = '#f1f1ee';
const BIB = '#f4a300';
const SKINS = ['#f3cfb3', '#eac0a0', '#e2b08d', '#d29e7b', '#a46c4c', '#64402b'];
const pick = <T>(l: readonly T[]): T => l[Math.floor(Math.random() * l.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** The game's heading of a direction in the ground's frame. */
const heading = (du: number, dw: number) => Math.atan2(S.u[0] * du + S.w[0] * dw, S.u[1] * du + S.w[1] * dw);
/** Facing the pitch from the buildings' side. */
const TO_PITCH = heading(0, -1);

export class FootballLife {
  readonly group = new THREE.Group();
  private actors: Actor[] = [];
  private balls: Ball[] = [];
  private ballMesh: THREE.InstancedMesh;
  private clock = 0;
  private on = false;
  private shown = 0;
  private built = false;
  // The rondo
  private ring: Actor[] = [];
  private chasers: Actor[] = [];
  private rondoBall: Ball | null = null;
  private rondoNext = 0;
  private rondoFrom = 0;
  private rondoTo = 1;
  // The shooting drill
  private queue: Actor[] = [];
  private shooter: Actor | null = null;
  private keeper: Actor | null = null;
  private coach: Actor | null = null;
  private shotBall: Ball | null = null;
  private phase: 'wait' | 'fetch' | 'dribble' | 'shot' | 'after' = 'wait';
  private phaseAt = 0;
  private shotAim = { w: 0, y: 1 };
  private shots = 0;
  private fans: Actor[] = [];
  private murmur: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

  constructor(private villagers: Villagers, private y: number, private cheap: () => boolean, private onGoal: (id: string) => void) {
    this.group.name = 'football life';
    this.ballMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL_R, 14, 10), new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.55 }), 8);
    this.ballMesh.count = 0;
    this.ballMesh.frustumCulled = false;
    this.ballMesh.raycast = () => {};
    this.ballMesh.userData.noAO = true;
    this.group.add(this.ballMesh);
    villagers.setExtras(() => (this.shown > 0 ? this.actors : []));
  }

  /** Each frame: `eye` where the camera is. */
  update(dt: number, eye: THREE.Vector3): void {
    const d = Math.hypot(eye.x - S.centre[0], eye.z - S.centre[1]);
    this.on = d < NEAR;
    this.shown = Math.max(0, Math.min(1, this.shown + (this.on ? dt : -dt) / 1.2));
    if (this.shown <= 0) {
      this.ballMesh.count = 0;
      this.stopMurmur();
      return;
    }
    if (!this.built && !this.build()) return;
    this.clock += dt;
    this.dressAll();
    this.rondo();
    this.shooting();
    this.crowd(dt);
    for (const a of this.actors) this.step(a, dt);
    for (const b of this.balls) this.roll(b, dt);
    this.drawBalls();
    this.ambience(d);
  }

  // ---------------------------------------------------------------- who is there
  private build(): boolean {
    if (!this.villagers.clipOf(K.child, 'Jog')) return false; // the model isn't in yet
    this.built = true;
    const cheap = this.cheap();
    const kit = (bib: boolean, skin: string): Record<number, string> => ({ 0: skin, 2: bib ? BIB : RED, 3: WHITE, 4: pick(['#1c1c1e', '#f2f2f2', '#2a2826']), 7: RED });
    const make = (role: Actor['role'], kind: number, u: number, w: number, cols: Record<number, string>, flags?: number): Actor => {
      const [x, z] = fcAt(u, w);
      const a: Actor = {
        role, kind, x, y: this.y, z, yaw: TO_PITCH, scale: kind === K.child ? rand(0.86, 1.04) : rand(0.96, 1.04), clip: 'Idle', time: Math.random() * 4, pal: 0, fade: 0,
        flags: 0, u, w, tu: u, tw: w, speed: 0, face: TO_PITCH, once: '', until: 0, rest: 'Idle', moving: false, floor: GROUND, dressed: false, cols, want: flags,
      };
      this.actors.push(a);
      return a;
    };
    // The rondo: six round a circle, two inside.
    const rc = { u: -13, w: -9, r: 6.5 };
    const nRing = cheap ? 5 : 6;
    for (let i = 0; i < nRing; i++) {
      const t = (i / nRing) * Math.PI * 2;
      const a = make('kid', K.child, rc.u + Math.cos(t) * rc.r, rc.w + Math.sin(t) * rc.r, kit(false, pick(SKINS)));
      a.face = a.yaw = heading(-Math.cos(t), -Math.sin(t)); // into the circle
      a.speed = 2.4;
      this.ring.push(a);
    }
    for (let i = 0; i < (cheap ? 1 : 2); i++) {
      const a = make('kid', K.child, rc.u + rand(-1, 1), rc.w + rand(-1, 1), kit(true, pick(SKINS)));
      a.speed = 3.0;
      this.chasers.push(a);
    }
    this.rondoBall = this.ball(this.ring[0].u, this.ring[0].w);
    this.rondoNext = 1;
    // The shooting drill at the far goal.
    for (let i = 0; i < (cheap ? 3 : 5); i++) {
      const [u, w] = this.queueSpot(i);
      const a = make('kid', i % 4 === 3 ? K.teen : K.child, u, w, kit(i % 2 === 1, pick(SKINS)));
      a.face = a.yaw = heading(-1, 0);
      a.speed = 2.6;
      this.queue.push(a);
    }
    this.keeper = make('keeper', K.teen, -49.3, 0, { 2: '#2e7d32', 3: '#1d1d1f', 4: '#1c1c1e', 5: '#e8e8e8' }, 0);
    this.keeper.face = this.keeper.yaw = heading(1, 0);
    this.keeper.speed = 4.2;
    this.coach = make('coach', K.man, -33.5, -6.5, { 2: '#1f2a44', 3: '#1f2a44', 4: '#e8e6e0' }, 4);
    this.coach.face = this.coach.yaw = heading(-0.7, 0.7);
    if (!cheap) {
      const helper = make('helper', K.woman, -13, -18.5, { 2: '#1f2a44', 3: '#2b2f38' }, 0);
      helper.face = helper.yaw = heading(0, 1);
    }
    // The ball pile by the coach and the ball the shooter takes.
    for (const [u, w] of [[-30.6, 3.7], [-30.1, 4.1], [-30.9, 4.4]]) this.ball(u, w).state = 'rest';
    this.shotBall = this.ball(-30.0, 2.6);
    this.shotBall.visible = false;
    // Watching: along the rail in front of the canteen and the terrace, and in the stand.
    const railW = S.rail.w1 + 0.45;
    const spots = [18.5, 19.2, 22.6, 26.0, 26.7, 30.4, 34.5, 35.2, 39.0, 43.0, 43.6, 47.5].slice(0, cheap ? 5 : 12);
    for (const [i, u] of spots.entries()) {
      const kind = i % 5 === 4 ? K.elder : i % 7 === 6 ? K.child : i % 2 ? K.woman : K.man;
      const scarf: Record<number, string> = Math.random() < 0.4 ? { 5: RED, 6: WHITE } : {};
      const a = make('fan', kind, u + rand(-0.15, 0.15), railW + rand(0, 0.3), scarf);
      a.floor = 0.03; // the concrete apron
      a.face = a.yaw = TO_PITCH + rand(-0.35, 0.35);
      a.rest = i % 3 === 1 ? 'Talk' : 'Idle';
      this.fans.push(a);
    }
    const seats = S.seats;
    const nSeats = Math.floor((seats.u1 - seats.u0) / seats.step) + 1;
    const taken = new Set<string>();
    for (let i = 0; i < (cheap ? 3 : 8); i++) {
      const row = seats.rows[i % 3 === 2 ? 1 : 0];
      let k = 0;
      do k = Math.floor(Math.random() * nSeats);
      while (taken.has(`${row.w},${k}`) && taken.size < nSeats);
      taken.add(`${row.w},${k}`);
      const kind = i % 4 === 3 ? K.elder : i % 2 ? K.woman : K.man;
      const a = make('sitter', kind, seats.u0 + k * seats.step, row.w, Math.random() < 0.5 ? { 5: RED } : {});
      a.floor = row.y - 0.45;
      a.face = a.yaw = TO_PITCH;
      a.rest = 'Sit';
      a.clip = 'Sit';
      this.fans.push(a);
    }
    return true;
  }

  private dressAll(): void {
    for (const a of this.actors) {
      if (a.dressed) continue;
      const row = this.villagers.dressRow(a.kind, a.cols, a.want);
      if (!row) continue;
      a.pal = row.pal;
      a.flags = row.flags;
      a.dressed = true;
    }
  }

  private queueSpot(i: number): [number, number] {
    return [-27.0 + i * 1.3, 6.0 + (i % 2) * 0.4];
  }

  private ball(u: number, w: number): Ball {
    const b: Ball = { u, w, y: BALL_R, vu: 0, vw: 0, vy: 0, state: 'rest', owner: null, spin: new THREE.Quaternion(), visible: true };
    this.balls.push(b);
    return b;
  }

  // ---------------------------------------------------------------- the rondo
  private rondo(): void {
    const b = this.rondoBall;
    if (!b || !this.ring.length) return;
    const to = this.ring[this.rondoTo];
    if (b.state === 'held' || b.state === 'rest') {
      // At someone's feet: a moment, then on to another.
      const holder = this.ring[this.rondoFrom];
      this.placeAtFeet(b, holder, 0.45);
      if (this.clock > this.rondoNext) {
        let next = this.rondoFrom;
        while (next === this.rondoFrom) next = Math.floor(Math.random() * this.ring.length);
        this.rondoTo = next;
        const target = this.ring[next];
        holder.face = heading(target.u - holder.u, target.w - holder.w);
        this.kick(holder);
        const du = target.u - b.u;
        const dw = target.w - b.w;
        const d = Math.hypot(du, dw);
        const v = rand(8, 11);
        b.vu = (du / d) * v;
        b.vw = (dw / d) * v;
        b.vy = Math.random() < 0.15 ? 2.2 : 0;
        b.state = 'free';
        thump(this.worldOf(b), 0.35, this.night());
        if (Math.random() < 0.18) shout(this.worldOf(holder, 1.2), true, this.night());
      }
      return;
    }
    // On its way: the receiver turns to it, the chasers go for it; it stops at the receiver's feet.
    to.face = heading(b.u - to.u, b.w - to.w);
    const d = Math.hypot(to.u - b.u, to.w - b.w);
    if (d < 0.6 || (b.vu * (to.u - b.u) + b.vw * (to.w - b.w) < 0 && d < 2.5)) {
      b.vu = b.vw = b.vy = 0;
      b.state = 'held';
      this.rondoFrom = this.rondoTo;
      this.rondoNext = this.clock + rand(0.5, 1.4);
    }
    for (const [i, c] of this.chasers.entries()) {
      const lead = i === 0 ? 0.8 : -1.2;
      c.tu = b.u + b.vu * 0.15 * lead;
      c.tw = b.w + b.vw * 0.15 * lead;
      // Stay inside the circle.
      const ru = c.tu + 13;
      const rw = c.tw + 9;
      const r = Math.hypot(ru, rw);
      if (r > 4.5) {
        c.tu = -13 + (ru / r) * 4.5;
        c.tw = -9 + (rw / r) * 4.5;
      }
    }
  }

  // ---------------------------------------------------------------- the shooting drill
  private shooting(): void {
    const b = this.shotBall;
    const k = this.keeper;
    if (!b || !k || !this.queue.length) return;
    const t = this.clock - this.phaseAt;
    const go = (p: typeof this.phase) => {
      this.phase = p;
      this.phaseAt = this.clock;
    };
    switch (this.phase) {
      case 'wait':
        k.tu = -49.3;
        k.tw = 0;
        if (t > 1.2) {
          this.shooter = this.queue.shift()!;
          this.shooter.tu = -30.0;
          this.shooter.tw = 2.0;
          b.u = -30.0;
          b.w = 2.6;
          b.y = BALL_R;
          b.state = 'rest';
          b.visible = true;
          // The rest move up the queue.
          this.queue.forEach((a, i) => ([a.tu, a.tw] = this.queueSpot(i)));
          if (this.shots % 3 === 0) whistle(this.worldOf(this.coach!, 1.6), this.night());
          go('fetch');
        }
        break;
      case 'fetch': {
        const s = this.shooter!;
        if (!s.moving && Math.hypot(s.u - s.tu, s.w - s.tw) < 0.1) {
          s.tu = -36.8;
          s.tw = rand(-6, 6);
          s.speed = 2.7;
          b.state = 'held';
          b.owner = s;
          if (Math.random() < 0.5) shout(this.worldOf(this.coach!, 1.6), false, this.night());
          go('dribble');
        }
        break;
      }
      case 'dribble': {
        const s = this.shooter!;
        this.placeAtFeet(b, s, 0.55 + 0.1 * Math.sin(this.clock * 9));
        k.tw = Math.max(-2.5, Math.min(2.5, s.w * 0.35));
        if (Math.hypot(s.u - s.tu, s.w - s.tw) < 0.2) {
          // The shot: low or high, left or right, hard.
          this.shotAim = { w: rand(-3.3, 3.3), y: Math.random() < 0.6 ? rand(0.25, 0.9) : rand(1.0, 2.2) };
          s.face = heading(-50.4 - s.u, this.shotAim.w - s.w);
          this.kick(s);
          const du = -50.6 - b.u;
          const dw = this.shotAim.w - b.w;
          const d = Math.hypot(du, dw);
          const v = rand(15, 19);
          const time = d / v;
          b.vu = du / time;
          b.vw = dw / time;
          b.vy = (this.shotAim.y - b.y + 0.5 * 9.81 * time * time) / time;
          b.state = 'free';
          b.owner = null;
          this.shots++;
          thump(this.worldOf(b), 0.9, this.night());
          // The keeper reads it, most of the time.
          k.tw = Math.random() < 0.55 ? this.shotAim.w + rand(-0.6, 0.6) : rand(-2.5, 2.5);
          k.speed = 4.6;
          go('shot');
        }
        break;
      }
      case 'shot': {
        // At the goal line: a save if the keeper is there, else in the net.
        if (b.u < -49.3 && b.state === 'free' && b.vu < 0) {
          const reach = Math.abs(b.w - k.w) < 1.0 + (b.y < 1.2 ? 0.3 : 0) && b.y < 2.1;
          if (reach) {
            b.u = -49.0;
            b.vu = rand(5, 9);
            b.vw = rand(-5, 5);
            b.vy = rand(1, 3);
            thump(this.worldOf(b), 0.5, this.night());
            this.cheer(false);
          } else if (Math.abs(b.w) < 3.6 && b.y < 2.4) {
            b.u = -50.2;
            b.vu *= 0.15;
            b.vw *= 0.2;
            b.vy = Math.min(b.vy, 0);
            this.onGoal('far');
            this.cheer(true);
          }
          go('after');
        } else if (t > 3) go('after');
        break;
      }
      case 'after': {
        const s = this.shooter!;
        if (!this.queue.includes(s)) {
          // Back to the end of the queue, round the outside.
          this.queue.push(s);
          const [u, w] = this.queueSpot(this.queue.length - 1);
          s.tu = u;
          s.tw = w;
          s.speed = 2.3;
        }
        k.speed = 2.0;
        k.tu = -49.3;
        k.tw = 0;
        if (b.u < -50.3) {
          // In the net: it stays there.
          b.u = Math.max(b.u, -51.7);
          if (b.u <= -51.7) b.vu = 0;
        }
        if (t > 3.2) {
          b.visible = false;
          b.state = 'rest';
          go('wait');
        }
        break;
      }
    }
  }

  /** A goal or a save: the watchers wave and cheer (a groan, softer, at a save). */
  private cheer(goal: boolean): void {
    const at = fcAt(25, S.rail.w1 + 1);
    crowd(new THREE.Vector3(at[0], this.y + 1.5, at[1]), goal, this.fans.length, this.night());
    if (!goal) return;
    for (const a of this.fans) {
      if (a.role === 'sitter' || Math.random() < 0.3) continue;
      a.once = 'Wave';
      a.until = this.clock + 1.2;
      a.time = 0;
    }
    for (const a of this.queue) {
      a.once = 'Wave';
      a.until = this.clock + 1.2;
      a.time = 0;
    }
  }

  /** In the rain fewer stand at the rail, with umbrellas up; at night fewer too. */
  private crowd(dt: number): void {
    const rain = mood.current === 'rain' || mood.wet > 0.6;
    const share = (rain ? 0.45 : 1) * (mood.night > 0.6 ? 0.7 : 1);
    this.fans.forEach((a, i) => {
      const keep = (i * 0.618) % 1 < share;
      a.fade = Math.min(this.shown, keep ? Math.min(1, a.fade + dt) : Math.max(0, a.fade - dt));
      if (a.role === 'fan') {
        if (rain) a.flags |= VILLAGER_UMBRELLA;
        else a.flags &= ~VILLAGER_UMBRELLA;
      }
    });
  }

  // ---------------------------------------------------------------- moving them
  private kick(a: Actor): void {
    // No kick of its own in the model: a quick stride of the jog reads as one.
    a.once = 'Jog';
    a.until = this.clock + 0.32;
    a.time = 0.05;
  }

  private step(a: Actor, dt: number): void {
    if (a.role !== 'fan' && a.role !== 'sitter') a.fade = Math.min(this.shown, a.fade + dt / 1.2);
    const du = a.tu - a.u;
    const dw = a.tw - a.w;
    const d = Math.hypot(du, dw);
    a.moving = d > 0.08;
    let moved = 0;
    if (a.moving) {
      moved = Math.min(d, a.speed * dt);
      a.u += (du / d) * moved;
      a.w += (dw / d) * moved;
      a.face = heading(du, dw);
    }
    a.yaw += wrap(a.face - a.yaw) * Math.min(1, dt * 8);
    const [x, z] = fcAt(a.u, a.w);
    a.x = x;
    a.z = z;
    a.y = this.y + a.floor;
    let clip: Clip;
    if (a.once && this.clock < a.until) clip = a.once;
    else {
      a.once = '';
      if (a.moving) clip = a.kind === K.child || a.kind === K.teen ? (a.speed > 2 ? 'Jog' : 'Walk') : a.speed > 2.5 ? 'Jog' : 'Walk';
      else if (a.flags & VILLAGER_UMBRELLA && a.rest !== 'Sit') clip = 'WalkUmb';
      else clip = a.rest;
    }
    if (clip !== a.clip) {
      a.clip = clip;
      if (clip !== 'Jog' || !a.once) a.time = Math.random() * 0.5;
    }
    const c = this.villagers.clipOf(a.kind, a.clip);
    if (c?.dist) {
      if (a.moving) a.time += (moved / (c.dist * a.scale)) * c.duration;
      else if (a.once) a.time += dt;
    } else a.time += dt;
  }

  private placeAtFeet(b: Ball, a: Actor, ahead: number): void {
    b.u = a.u + this.dirU(a.face) * ahead;
    b.w = a.w + this.dirW(a.face) * ahead;
    b.y = BALL_R;
  }

  /** The frame's (u, w) direction of a game heading. */
  private dirU(yaw: number): number {
    return Math.sin(yaw) * S.u[0] + Math.cos(yaw) * S.u[1];
  }
  private dirW(yaw: number): number {
    return Math.sin(yaw) * S.w[0] + Math.cos(yaw) * S.w[1];
  }

  private roll(b: Ball, dt: number): void {
    if (b.state !== 'free') return;
    b.vy -= 9.81 * dt;
    const pu = b.u;
    const pw = b.w;
    b.u += b.vu * dt;
    b.w += b.vw * dt;
    b.y += b.vy * dt;
    if (b.y < BALL_R) {
      b.y = BALL_R;
      if (b.vy < -1.2) b.vy = -b.vy * 0.45;
      else b.vy = 0;
      const k = Math.max(0, 1 - 1.4 * dt);
      b.vu *= k;
      b.vw *= k;
    }
    // In the far goal's net: held by it.
    if (b.u < -51.8 && Math.abs(b.w) < 3.7) {
      b.u = -51.8;
      b.vu = Math.abs(b.vu) * 0.1;
    }
    const moved = Math.hypot(b.u - pu, b.w - pw);
    if (moved > 1e-5) {
      const ax = new THREE.Vector3(-(b.w - pw), 0, b.u - pu).normalize();
      b.spin.premultiply(new THREE.Quaternion().setFromAxisAngle(ax, moved / BALL_R));
    }
    if (b.y <= BALL_R && Math.hypot(b.vu, b.vw) < 0.15 && this.rondoBall !== b) b.state = 'rest';
  }

  private drawBalls(): void {
    const m = new THREE.Matrix4();
    const s = new THREE.Vector3(1, 1, 1);
    let n = 0;
    for (const b of this.balls) {
      if (!b.visible) continue;
      const [x, z] = fcAt(b.u, b.w);
      m.compose(new THREE.Vector3(x, this.y + GROUND + b.y, z), b.spin, s.setScalar(Math.max(0.001, this.shown)));
      this.ballMesh.setMatrixAt(n++, m);
    }
    this.ballMesh.count = n;
    this.ballMesh.instanceMatrix.needsUpdate = true;
  }

  private worldOf(p: { u: number; w: number; y?: number }, up = 0): THREE.Vector3 {
    const [x, z] = fcAt(p.u, p.w);
    return new THREE.Vector3(x, this.y + (p.y ?? 0) + up, z);
  }

  private night(): number {
    return 1 - 0.45 * Math.min(1, mood.night);
  }

  /** The murmur of the watchers and the training, from the rail, while you are near. */
  private ambience(d: number): void {
    if (d > 150 || !sound.enabled) {
      this.stopMurmur();
      return;
    }
    const c = sound.context();
    if (!c) return;
    if (!this.murmur) {
      const at = fcAt(10, S.rail.w1 + 1);
      const out = sound.at(at[0], this.y + 1.4, at[1], 10);
      if (!out) return;
      const buf = c.createBuffer(1, c.sampleRate * 3, c.sampleRate);
      const data = buf.getChannelData(0);
      // Babble: noise shaped by a slow wobble, as many voices far off.
      let wob = 0;
      for (let i = 0; i < data.length; i++) {
        if (i % 2400 === 0) wob = 0.4 + Math.random() * 0.6;
        data[i] = (Math.random() * 2 - 1) * wob;
      }
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const band = c.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 520;
      band.Q.value = 0.9;
      const gain = c.createGain();
      gain.gain.value = 0;
      src.connect(band).connect(gain).connect(out);
      src.start();
      this.murmur = { src, gain };
    }
    const people = this.fans.reduce((n, a) => n + a.fade, 0);
    this.murmur.gain.gain.setTargetAtTime(0.012 * Math.min(10, people) * this.shown * this.night(), c.currentTime, 0.5);
  }

  private stopMurmur(): void {
    if (!this.murmur) return;
    try {
      this.murmur.src.stop();
    } catch {
      // already stopped
    }
    this.murmur.src.disconnect();
    this.murmur = null;
  }
}

/** A size 4 ball's look: white with black patches, drawn once. */
function ballTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f0';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#1b1b1d';
  for (const [x, y] of [[16, 32], [48, 14], [48, 50], [80, 32], [112, 14], [112, 50], [0, 6], [64, 60]]) {
    g.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
      g.lineTo(x + Math.cos(a) * 8, y + Math.sin(a) * 6);
    }
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- sounds, made in code
function noiseBuffer(c: AudioContext, s: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.max(1, Math.round(c.sampleRate * s)), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  return buf;
}

/** A kick: a low thump and the slap of leather. */
function thump(at: THREE.Vector3, hard: number, quiet: number): void {
  const c = sound.context();
  const out = sound.at(at.x, at.y, at.z, 4);
  if (!c || !out) return;
  const t = c.currentTime;
  const loud = (0.18 + 0.4 * hard) * quiet;
  const osc = c.createOscillator();
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.12);
  const g = c.createGain();
  g.gain.setValueAtTime(loud, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.17);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.035);
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 1300;
  f.Q.value = 0.8;
  const g2 = c.createGain();
  g2.gain.value = loud * 0.7;
  src.connect(f).connect(g2).connect(out);
  src.start(t);
}

/** The coach's whistle: a pea whistle's trill, two short blasts. */
function whistle(at: THREE.Vector3, quiet: number): void {
  const c = sound.context();
  const out = sound.at(at.x, at.y, at.z, 6);
  if (!c || !out) return;
  const t = c.currentTime;
  for (const [start, len] of [[0, 0.22], [0.32, 0.5]]) {
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 2900;
    const trill = c.createOscillator();
    trill.frequency.value = 26; // the pea rattling
    const tg = c.createGain();
    tg.gain.value = 140;
    trill.connect(tg).connect(osc.frequency);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t + start);
    g.gain.linearRampToValueAtTime(0.16 * quiet, t + start + 0.02);
    g.gain.setValueAtTime(0.16 * quiet, t + start + len - 0.04);
    g.gain.linearRampToValueAtTime(0, t + start + len);
    osc.connect(g).connect(out);
    osc.start(t + start);
    trill.start(t + start);
    osc.stop(t + start + len + 0.02);
    trill.stop(t + start + len + 0.02);
  }
}

/** A child calling for the ball ("hier!") or the coach's "go!": a voiced vowel gliding, through two formants. */
function shout(at: THREE.Vector3, child: boolean, quiet: number): void {
  const c = sound.context();
  const out = sound.at(at.x, at.y, at.z, 5);
  if (!c || !out) return;
  const t = c.currentTime;
  const f0 = child ? rand(330, 420) : rand(140, 180);
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f0 * 1.15, t);
  osc.frequency.linearRampToValueAtTime(f0 * 0.9, t + 0.32);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.05 * quiet, t + 0.04);
  g.gain.setValueAtTime(0.05 * quiet, t + 0.22);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
  for (const [hz, q] of child ? [[420, 5], [2300, 7]] : [[330, 5], [1900, 7]]) {
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(hz, t);
    f.frequency.linearRampToValueAtTime(hz * (child ? 1.5 : 1.8), t + 0.3); // "ie" to "ee-r"
    f.Q.value = q;
    osc.connect(f).connect(g);
  }
  g.connect(out);
  osc.start(t);
  osc.stop(t + 0.4);
}

/** The watchers: a cheer with clapping at a goal, an "ooh" at a save. */
function crowd(at: THREE.Vector3, goal: boolean, people: number, quiet: number): void {
  const c = sound.context();
  const out = sound.at(at.x, at.y, at.z, 9);
  if (!c || !out) return;
  const t = c.currentTime;
  const bus = c.createGain();
  bus.gain.value = 0.45 * quiet;
  bus.connect(out);
  const n = Math.max(3, Math.min(9, people));
  for (let i = 0; i < n; i++) {
    const start = t + Math.random() * 0.2;
    const f0 = rand(150, 320) * (i % 3 === 0 ? 1.6 : 1);
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, start);
    osc.frequency.linearRampToValueAtTime(f0 * (goal ? 1.3 : 0.85), start + 0.35);
    const g = c.createGain();
    const len = goal ? 1.4 : 0.9;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.045, start + 0.12);
    g.gain.setValueAtTime(0.045, start + len * 0.5);
    g.gain.exponentialRampToValueAtTime(0.001, start + len);
    for (const [hz, q] of goal ? [[750, 4], [1200, 5]] : [[420, 4], [800, 5]]) {
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = hz * rand(0.9, 1.1);
      f.Q.value = q;
      osc.connect(f).connect(g);
    }
    g.connect(bus);
    osc.start(start);
    osc.stop(start + len + 0.05);
  }
  if (!goal) return;
  const src = c.createBufferSource();
  const buf = c.createBuffer(1, Math.round(c.sampleRate * 2), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() < 0.035 ? Math.random() * 2 - 1 : (Math.random() * 2 - 1) * 0.1;
  src.buffer = buf;
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 900;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0, t);
  cg.gain.linearRampToValueAtTime(0.3, t + 0.25);
  cg.gain.exponentialRampToValueAtTime(0.001, t + 2);
  src.connect(hp).connect(cg).connect(bus);
  src.start(t);
}
