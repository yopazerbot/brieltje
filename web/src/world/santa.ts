import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { t, type PlainKey } from '../i18n';
import { sound } from '../sound';
import type { World } from './collision';
import { mood } from './mood';
import { dayNow } from './season';
import { along, buildPath, FLIGHT, flightNow, flightPhase, PARK, pointAt, type FlightPoint } from './santaFlight';

/**
 * Santa (de Kerstman) on the church square from 7 December to 6 January (Yoshi; world/season.ts), with his sleigh and
 * four reindeer parked beside him, and now and then at night the whole team flying over the village.
 *
 * Santa is made as the villagers are (tools/santa.py, from the same sculpted public domain body), the reindeer from a
 * sculpted, textured CC0 deer, the sleigh in Blender by that tool: web/public/models/santa.glb. On the square he
 * stands by the sleigh, in the open part where Sinterklaas rides until 6 December (they never meet), turns to a
 * player who comes near, laughs his "ho ho ho", waves and says something friendly in a speech bubble (EN and
 * Flemish NL from i18n, set with textContent). The reindeer stand in their harness, graze, look round and shake
 * their bells now and then. Sounds are made here (Web Audio): his laugh and the sleigh bells.
 *
 * The flight (world/santaFlight.ts): every ten minutes by a clock all pages share, if it is dark on this page, he
 * gets into the sleigh, the reindeer gallop and the team takes off over the street, flies a long round over the
 * fields and the village at 60 to 115 m with the bells fading in and out, and lands where it stood. The same team
 * flies (it is away from the square meanwhile): one Santa, nothing twice in memory, no extra draws. The leader's
 * nose glows at night and two lanterns burn on the sleigh, so it is seen from below; a far version of each figure
 * is drawn beyond a few tens of metres.
 *
 * Only in Explore (main.ts): never in a game with weapons or in Zombies, so never a target. His meshes take no rays;
 * the team and he are in the way for walking only. Local and for show: nothing goes over the network or is stored.
 */

const URL_GLB = '/models/santa.glb';

/** Santa's colour slots (tools/santa.py, as tools/villagers.py: u is the slot, v is 1 - shade). sRGB. */
const SANTA_LOOK: Record<number, string> = {
  0: '#e2a68a', // skin, a little rosy
  1: '#f3f1ed', // hair, beard and brows: white
  2: '#b0121a', // jacket and hat: Christmas red
  3: '#a3111a', // trousers
  4: '#141211', // boots
  9: '#f6f4ef', // fur, and the eyes' white
  10: '#141212', // belt, and the eyes' dark
  11: '#d6a238', // buckle and spectacles: gold
  14: '#b4625a', // lips
  15: '#221d1a', // soles
};
/** The sleigh's colour slots (tools/santa.py SLEIGH slots). */
const SLEIGH_LOOK = ['#9e1018', '#d8a53a', '#4b2d1d', '#6a0d17', '#9b7a50', '#2e7a3c', '#2b4f9e', '#e0b640', '#c8213a', '#f3efe6', '#4d1913', '#c9a25c'];

const STAND = { x: -1.25, z: 0.5, yaw: -0.785 }; // where he stands by the sleigh (its frame: the street's side) and which way he faces
const TURN = 1.25; // rad: as far as he turns from there to face you
const STOP = 8; // m: a player this near and he turns to them
const TALK = 10; // m: his speech bubble shows within this
const NEAR_M = [42, 24]; // beyond this (m) the figures are drawn with far fewer triangles: [desktop, Low or phone]
const TEAM_HALF = { x: 0.95, back: 1.5, front: 6.0 }; // the team's outline for walking (m, its frame)
const BLEND = 0.35; // s from one clip to the next

interface Deer {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  clip: string;
  next: number;
  near: THREE.SkinnedMesh[];
  far: THREE.SkinnedMesh[];
  head: THREE.Bone | null;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _p: FlightPoint = { x: 0, z: 0, h: 0 };
const _q: FlightPoint = { x: 0, z: 0, h: 0 };

export class Santa {
  readonly group = new THREE.Group();
  /** The sleigh, the reindeer and Santa: parked on the square, or flying. */
  private team = new THREE.Group();
  private loaded: 'no' | 'loading' | 'yes' = 'no';
  private job: Promise<boolean> = Promise.resolve(false);
  private active = false;
  private man: THREE.Object3D | null = null;
  private manNear: THREE.SkinnedMesh[] = [];
  private manFar: THREE.SkinnedMesh[] = [];
  private manMixer: THREE.AnimationMixer | null = null;
  private manActions = new Map<string, THREE.AnimationAction>();
  private manClip = '';
  private head: THREE.Bone | null = null;
  private deer: Deer[] = [];
  private seat = new THREE.Vector3(0, 0.42, -0.05);
  private glow: THREE.Points | null = null;
  private glowSpots: THREE.Vector3[] = [];
  private path = buildPath();
  private offset = Date.now() / 1000 - performance.now() / 1000; // the shared clock minus this page's (s)
  private window = { start: NaN, flies: false };
  private forced = NaN; // dev build: a flight started by hand (s on the shared clock)
  private clock = 0;
  private yaw = STAND.yaw;
  private wasNear = false;
  private busy = 0; // s left of a clip played once (the laugh, the wave)
  private said: PlainKey = 'santa.hello';
  private sayFor = 0;
  private line = 0;
  private bubble: HTMLDivElement | null = null;
  private bubbleText: HTMLSpanElement | null = null;
  private placed = false;
  private seated = false;
  private flying = false;
  private bells: PannerNode | null = null;
  private bellsAt = 0;
  private bellBufs: AudioBuffer[] = [];
  private lastYaw = NaN;
  private bank = 0;
  private groundY = 0;
  private failedAt = -Infinity;

  constructor(private world: World, private groundAt: (x: number, z: number) => number, private precompile: (root: THREE.Object3D) => unknown = () => {}, private cheap: () => boolean = () => false) {
    this.group.name = 'santa';
    this.group.visible = false;
    this.group.add(this.team);
  }

  /** In Explore during his days (main.ts): there, else gone (and out of the way). */
  setActive(on: boolean): void {
    if (on && this.loaded === 'no' && performance.now() - this.failedAt > 30_000) this.load(); // after a failed fetch, not again at once
    this.active = on;
  }

  /** Loaded and his shaders built, without bringing him out (before play: main.ts). True once he is in. */
  prepare(): Promise<boolean> {
    if (this.loaded === 'no') this.load();
    return this.job;
  }

  /** Line up with the server's clock (ms since 1970), so everyone sees the flight at the same moment. */
  setClock(serverMs: number): void {
    this.offset = serverMs / 1000 - performance.now() / 1000;
  }

  /** Development only (main.ts briel.santa.fly): the next flight starts in a few seconds, dark or not. */
  fly(): void {
    this.forced = this.now + 3;
  }

  private get now(): number {
    return performance.now() / 1000 + this.offset;
  }

  private load(): void {
    this.loaded = 'loading';
    this.job = new GLTFLoader().loadAsync(URL_GLB).then((gltf) => {
      try {
        this.build(gltf.scene, gltf.animations);
      } catch {
        this.team.clear();
        this.loaded = 'no';
        this.failedAt = performance.now();
        return false;
      }
      // Its shaders built in the background before he shows (drawn at once, a new figure stops the game a moment).
      // The compile looks at what is visible: all of it, for that moment.
      this.group.visible = true;
      const compiled = this.precompile(this.group);
      this.group.visible = false;
      return Promise.resolve(compiled)
        .catch(() => undefined)
        .then(() => {
          this.loaded = 'yes';
          return true;
        });
    }, () => {
      this.loaded = 'no';
      this.failedAt = performance.now();
      return false;
    });
  }

  private build(scene: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    const sleigh = scene.getObjectByName('sleigh') as THREE.Mesh | undefined;
    const man = scene.getObjectByName('santa');
    const deer = scene.getObjectByName('reindeer');
    if (!sleigh || !man || !deer) throw new Error('santa.glb: a part is missing');
    // The sleigh: one mesh, its colours by slot.
    paintSlots(sleigh.geometry, (u) => SLEIGH_LOOK[Math.floor(u)] ?? '#ff00ff');
    sleigh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
    sleigh.castShadow = true;
    sleigh.receiveShadow = true;
    const seat = sleigh.userData.seat as number[] | undefined;
    if (seat) this.seat.set(seat[0], seat[1], seat[2]);
    const spots = (sleigh.userData.team as number[][] | undefined) ?? [[-0.62, 0, 2.8], [0.62, 0, 2.8], [-0.62, 0, 5], [0.62, 0, 5]];
    this.team.add(sleigh);
    // Santa: his colours by slot, the near and far figures on one skeleton.
    const santaMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
    man.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
        const m = o as THREE.SkinnedMesh;
        paintSlots(m.geometry, (u) => SANTA_LOOK[Math.floor(u) % 16] ?? '#808080');
        m.material = santaMat;
        (o.name.endsWith('_far') ? this.manFar : this.manNear).push(m);
        m.castShadow = !o.name.endsWith('_far');
      }
    });
    this.head = man.getObjectByName('santa_Head') as THREE.Bone | null;
    this.man = man;
    this.team.add(man);
    this.manMixer = new THREE.AnimationMixer(man);
    for (const c of clips) if (c.name.startsWith('santa_')) this.manActions.set(c.name.slice(6), this.manMixer.clipAction(c));
    this.sit(false); // standing by the sleigh
    // Four reindeer, copies of the one, each with its own skeleton and clips (in step with none of the others).
    const nose = new THREE.Vector3().fromArray((deer.userData.nose as number[] | undefined) ?? [0, 1.2, 0.9]);
    spots.forEach((at, i) => {
      const root = cloneSkinned(deer);
      root.position.set(at[0], at[1], at[2]);
      const near: THREE.SkinnedMesh[] = [];
      const far: THREE.SkinnedMesh[] = [];
      root.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
          const m = o as THREE.SkinnedMesh;
          (o.name.startsWith('reindeer_far') ? far : near).push(m);
          m.castShadow = !o.name.startsWith('reindeer_far');
        }
      });
      const mixer = new THREE.AnimationMixer(root);
      const actions = new Map<string, THREE.AnimationAction>();
      for (const c of clips) if (c.name.startsWith('reindeer_')) actions.set(c.name.slice(9), mixer.clipAction(c));
      const d: Deer = { root, mixer, actions, clip: '', next: 2 + i * 3.1, near, far, head: root.getObjectByName('rd_Head') as THREE.Bone | null };
      if (i === 2 && d.head) {
        // The leader (front left) has the glowing nose: a point fixed to its head bone, found in the rest pose.
        root.updateMatrixWorld(true);
        d.head.userData.nose = d.head.worldToLocal(root.localToWorld(nose.clone()));
      }
      this.deerPlay(d, 'Idle');
      mixer.update(i * 1.7); // not in step
      this.team.add(root);
      this.deer.push(d);
    });
    this.buildLights();
    for (const root of [sleigh, man, ...this.deer.map((d) => d.root)]) root.traverse((o) => (o.userData.ignoreRay = true));
  }

  /** Two lanterns on the sleigh's front corners and the glows (the lanterns', the leader's nose): one draw for the glows. */
  private buildLights(): void {
    const frame = new THREE.MeshStandardMaterial({ color: '#c9962f', roughness: 0.35, metalness: 0.6 });
    const flame = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.05, 0.45) });
    const lanterns = new THREE.Group();
    const box = new THREE.BoxGeometry(0.11, 0.16, 0.11);
    const core = new THREE.BoxGeometry(0.075, 0.11, 0.075);
    const post = new THREE.CylinderGeometry(0.012, 0.012, 0.2, 6);
    for (const sx of [-1, 1]) {
      const at = new THREE.Vector3(sx * 0.66, 1.3, 1.05);
      const f = new THREE.Mesh(box, frame);
      f.position.copy(at);
      const c = new THREE.Mesh(core, flame);
      c.position.copy(at);
      const p = new THREE.Mesh(post, frame);
      p.position.set(at.x, at.y - 0.17, at.z);
      lanterns.add(f, c, p);
      this.glowSpots.push(at.clone());
    }
    lanterns.traverse((o) => (o.userData.ignoreRay = true));
    this.team.add(lanterns);
    this.glowSpots.push(new THREE.Vector3()); // the nose, moved each frame
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.glowSpots.length * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1.0, 0.62, 0.25, 1.0, 0.62, 0.25, 1.0, 0.12, 0.08]), 3));
    const mat = new THREE.PointsMaterial({ color: new THREE.Color(2.2, 2.2, 2.2), map: glowTexture(), size: 0.6, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.glow = new THREE.Points(geo, mat);
    this.glow.frustumCulled = false;
    this.glow.userData.ignoreRay = true;
    this.glow.raycast = () => {};
    this.team.add(this.glow);
  }

  private play(name: string, once = 0): void {
    const next = this.manActions.get(name);
    if (!next || name === this.manClip) return;
    const prev = this.manActions.get(this.manClip);
    next.reset().setEffectiveWeight(1).fadeIn(BLEND).play();
    if (prev) prev.fadeOut(BLEND);
    this.manClip = name;
    this.busy = once;
  }

  private deerPlay(d: Deer, name: string): void {
    const next = d.actions.get(name);
    if (!next || name === d.clip) return;
    const prev = d.actions.get(d.clip);
    next.reset().setEffectiveWeight(1).fadeIn(0.6).play();
    if (prev) prev.fadeOut(0.6);
    d.clip = name;
  }

  /**
   * Each frame. `me`: the player on foot (null in a car, on a horse or a bike); `ui`: the speech bubble may show (no
   * menu over the game); `view`: the size of the picture in CSS pixels.
   */
  update(dt: number, camera: THREE.Camera, me: { x: number; z: number } | null, ui: boolean, view: { w: number; h: number }): void {
    const shown = this.active && this.loaded === 'yes';
    this.group.visible = shown;
    if (!shown) {
      this.placeSolid(false);
      this.showBubble(null);
      this.wasNear = false;
      this.stopBells();
      return;
    }
    this.clock += dt;
    // Where he is in the flights' rhythm (the shared clock), and whether this window's flight is flown here: only in the
    // dark, decided once as the window begins (or as the page first sees it), so a change of weather mid-flight doesn't
    // snap him back to the square.
    const now = this.now;
    let { t, start } = flightNow(now);
    if (!Number.isNaN(this.forced)) {
      if (now - this.forced < FLIGHT.seconds + FLIGHT.rest) {
        start = this.forced;
        t = now - this.forced;
      } else this.forced = NaN;
    }
    if (start !== this.window.start) this.window = { start, flies: start === this.forced || mood.night > 0.35 };
    const phase = this.window.flies ? flightPhase(t) : 'parked';
    this.groundY = this.groundAt(PARK.x, PARK.z);
    const flying = phase === 'flying';
    const seated = phase !== 'parked';
    if (seated !== this.seated) this.sit(seated);
    if (flying !== this.flying) {
      this.flying = flying;
      if (flying) for (const d of this.deer) this.deerPlay(d, 'Run');
      else this.say(t > 0 ? 'santa.back' : 'santa.hello', 4);
      if (!flying) for (const d of this.deer) this.deerPlay(d, 'Idle');
    }
    if (flying) this.flyTo(t, dt);
    else this.parkAt();
    this.placeSolid(!flying);
    this.team.updateMatrixWorld(true);
    const eye = camera.position;
    this.team.getWorldPosition(_w);
    const far = Math.hypot(eye.x - _w.x, eye.y - _w.y, eye.z - _w.z) > NEAR_M[this.cheap() ? 1 : 0];
    for (const m of this.manNear) m.visible = !far;
    for (const m of this.manFar) m.visible = far;
    for (const d of this.deer) {
      for (const m of d.near) m.visible = !far;
      for (const m of d.far) m.visible = far;
    }
    // The man: turns to a player near, laughs and waves as they come, talks; seated, he waves now and then in flight.
    this.man!.getWorldPosition(_v);
    const dist = me && !flying ? Math.hypot(me.x - _v.x, me.z - _v.z) : Infinity;
    const isNear = dist < STOP;
    this.busy = Math.max(0, this.busy - dt);
    if (!seated) {
      if (isNear && !this.wasNear) {
        this.play('Laugh', 2.4);
        quiet(() => this.hoHoHo(_v));
        quiet(() => this.jingle(_w, 0.5, 4));
        const date = dayNow();
        this.say(date.m === 1 ? 'santa.newYear' : 'santa.hello', 5);
        this.line = 0;
      }
      if (this.busy <= 0) {
        if (isNear && this.manClip === 'Laugh') this.play('Wave', 2.4);
        else if (isNear) this.play('Talk');
        else this.play(Math.floor(this.clock / 16) % 2 ? 'Idle2' : 'Idle');
      }
      let want = STAND.yaw;
      if (me && dist < STOP + 4) {
        this.team.worldToLocal(_w.set(me.x, 0, me.z));
        const rel = Math.atan2(_w.x - STAND.x, _w.z - STAND.z) - STAND.yaw;
        want = STAND.yaw + THREE.MathUtils.clamp(Math.atan2(Math.sin(rel), Math.cos(rel)), -TURN, TURN);
      }
      this.yaw += (want - this.yaw) * Math.min(1, dt * 2.5);
      this.man!.rotation.y = this.yaw;
    } else if (this.busy <= 0) {
      this.play(flying && Math.floor(this.clock / 9) % 3 === 0 ? 'SitWave' : 'Sit');
    }
    this.wasNear = isNear;
    this.sayFor -= dt;
    if (!seated && dist < TALK && this.sayFor <= 0) {
      const lines = this.lines();
      this.say(lines[this.line % lines.length], 6);
      this.line++;
    }
    if (phase === 'boarding' && t > -FLIGHT.board + 0.5 && t < -FLIGHT.board + 1.0 && dist < TALK * 2) this.say('santa.fly', 5);
    this.manMixer?.update(dt);
    // The reindeer: standing about in turn (idle, grazing, a look round with a shake of the bells), galloping in flight.
    for (const d of this.deer) {
      if (!flying) {
        d.next -= dt;
        if (d.next <= 0) {
          const r = Math.random();
          const clip = r < 0.45 ? 'Idle' : r < 0.75 ? 'Graze' : 'Look';
          this.deerPlay(d, clip);
          d.next = 5 + Math.random() * 9;
          if (clip === 'Look' && dist < 25) quiet(() => this.jingle(d.root.getWorldPosition(_w), 0.35, 3));
        }
      }
      d.mixer.update(dt * (flying ? 1.15 : 1));
    }
    this.updateLights(camera);
    this.updateBells(flying, t, camera);
    // The speech bubble over his hat.
    if (ui && !flying && dist < TALK && this.sayFor > 0 && this.head) {
      const at = new THREE.Vector3(0, 0.45, 0);
      this.head.localToWorld(at);
      at.project(camera);
      this.showBubble(at.z < 1 && Math.abs(at.x) < 1.1 && Math.abs(at.y) < 1.1 ? { x: (at.x * 0.5 + 0.5) * view.w, y: (0.5 - at.y * 0.5) * view.h } : null);
    } else this.showBubble(null);
  }

  /** What he says in turn, after the hello: before Christmas the wish list, after it the presents, in January the new year. */
  private lines(): PlainKey[] {
    const { m, d } = dayNow();
    if (m === 12 && d < 25) return ['santa.list', 'santa.nice', 'santa.reindeer', 'santa.cocoa', 'santa.sky'];
    if (m === 12) return ['santa.presents', 'santa.reindeer', 'santa.cocoa', 'santa.sky', 'santa.nice'];
    return ['santa.presents', 'santa.cocoa', 'santa.sky', 'santa.reindeer'];
  }

  private say(key: PlainKey, seconds: number): void {
    this.said = key;
    this.sayFor = seconds;
  }

  /** In the seat (boarding, flying, just landed) or standing by the sleigh. */
  private sit(on: boolean): void {
    this.seated = on;
    if (!this.man) return;
    if (on) {
      this.man.position.copy(this.seat);
      this.man.rotation.y = 0;
      this.play('Sit');
    } else {
      this.man.position.set(STAND.x, 0, STAND.z);
      this.yaw = STAND.yaw;
      this.man.rotation.y = this.yaw;
      this.play('Idle');
    }
  }

  private parkAt(): void {
    this.team.position.set(PARK.x, this.groundY, PARK.z);
    this.team.rotation.set(0, PARK.yaw, 0, 'YXZ');
    this.lastYaw = NaN;
    this.bank = 0;
  }

  /** Along the flight's line at t s into it: facing along it, the nose up or down with it, leaning into the turns. */
  private flyTo(t: number, dt: number): void {
    const s = along(t / FLIGHT.seconds) * this.path.total;
    pointAt(this.path, s, _p);
    pointAt(this.path, Math.min(this.path.total, s + 3), _q);
    let dx = _q.x - _p.x;
    let dz = _q.z - _p.z;
    let dh = _q.h - _p.h;
    if (Math.hypot(dx, dz, dh) < 0.05) {
      // at the very end: the way it came
      pointAt(this.path, Math.max(0, s - 3), _q);
      dx = _p.x - _q.x;
      dz = _p.z - _q.z;
      dh = _p.h - _q.h;
    }
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dh, Math.hypot(dx, dz));
    let turn = 0;
    if (!Number.isNaN(this.lastYaw) && dt > 0) turn = Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw)) / dt;
    this.lastYaw = yaw;
    this.bank += (THREE.MathUtils.clamp(-turn * 0.9, -0.45, 0.45) - this.bank) * Math.min(1, dt * 1.5);
    this.team.position.set(_p.x, this.groundY + _p.h, _p.z);
    // Level near the ground (it rises and settles like a sleigh lifted, not a plane's dive), nose up or down higher up.
    const tilt = THREE.MathUtils.clamp(pitch, -0.6, 0.6) * 0.7 * THREE.MathUtils.smoothstep(_p.h, 4, 30);
    this.team.rotation.set(-tilt, yaw, this.bank * THREE.MathUtils.smoothstep(_p.h, 4, 30), 'YXZ');
  }

  /** The glows: the lanterns' and the leader's nose, seen from far off at night (a few pixels at least), out by day. */
  private updateLights(camera: THREE.Camera): void {
    if (!this.glow) return;
    const night = Math.max(0, Math.min(1, (mood.night - 0.25) / 0.5));
    this.glow.visible = night > 0.01;
    if (!this.glow.visible) return;
    const lead = this.deer[2];
    const nose = lead?.head?.userData.nose as THREE.Vector3 | undefined;
    if (lead?.head && nose) {
      lead.head.localToWorld(_v.copy(nose));
      this.team.worldToLocal(_v);
      this.glowSpots[2].copy(_v);
    }
    const pos = this.glow.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.glowSpots.forEach((p, i) => pos.setXYZ(i, p.x, p.y, p.z));
    pos.needsUpdate = true;
    this.team.getWorldPosition(_v);
    const d = camera.position.distanceTo(_v);
    const mat = this.glow.material as THREE.PointsMaterial;
    mat.size = Math.max(0.35, d * 0.012);
    mat.opacity = night;
  }

  /** The team is in the way for walking while it stands on the square; so is he, standing beside it. */
  private placeSolid(on: boolean): void {
    if (!on) {
      if (this.placed) {
        this.world.setMoving('santa-sleigh', null, 0, 0, true);
        this.world.setMoving('santa', null, 0, 0, true);
      }
      this.placed = false;
      return;
    }
    if (this.placed) return;
    this.placed = true;
    const f = { x: Math.sin(PARK.yaw), z: Math.cos(PARK.yaw) };
    const r = { x: f.z, z: -f.x };
    const corner = (a: number, b: number): [number, number] => [PARK.x + f.x * a + r.x * b, PARK.z + f.z * a + r.z * b];
    const g = this.groundY;
    this.world.setMoving('santa-sleigh', [corner(TEAM_HALF.front, TEAM_HALF.x), corner(TEAM_HALF.front, -TEAM_HALF.x), corner(-TEAM_HALF.back, -TEAM_HALF.x), corner(-TEAM_HALF.back, TEAM_HALF.x)], g - 0.3, g + 2.2, true);
    const sx = PARK.x + r.x * STAND.x + f.x * STAND.z;
    const sz = PARK.z + r.z * STAND.x + f.z * STAND.z;
    const q = 0.3;
    this.world.setMoving('santa', [[sx - q, sz - q], [sx + q, sz - q], [sx + q, sz + q], [sx - q, sz + q]], g - 0.3, g + 1.9, true);
  }

  // ---- Sounds, made here.

  /** His laugh: three deep "ho"s, a voice made of a buzz through the vowel's two resonances, with a breath before each. */
  private hoHoHo(at: THREE.Vector3): void {
    const ctx = sound.context();
    const dest = sound.at(at.x, at.y + 1.5, at.z, 4);
    if (!ctx || !dest) return;
    const t0 = ctx.currentTime + 0.15;
    const out = ctx.createGain();
    out.gain.value = 0.55;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    lp.connect(out).connect(dest);
    const noise = noiseBuffer(ctx);
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.4;
      const len = i === 2 ? 0.42 : 0.28;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(118 - i * 4, t);
      o.frequency.exponentialRampToValueAtTime(92 - i * 4, t + len);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(1, t + 0.05);
      env.gain.setValueAtTime(1, t + len - 0.08);
      env.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.06);
      for (const [f, q, g] of [[480, 5, 1], [820, 7, 0.55], [2600, 4, 0.08]] as const) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f;
        bp.Q.value = q;
        const gg = ctx.createGain();
        gg.gain.value = g;
        o.connect(bp).connect(gg).connect(env);
      }
      env.connect(lp);
      o.start(t);
      o.stop(t + len + 0.1);
      // the "h": a short breath of noise
      const h = ctx.createBufferSource();
      h.buffer = noise;
      const hb = ctx.createBiquadFilter();
      hb.type = 'bandpass';
      hb.frequency.value = 1300;
      hb.Q.value = 1.2;
      const hg = ctx.createGain();
      hg.gain.setValueAtTime(0.0001, t - 0.06);
      hg.gain.exponentialRampToValueAtTime(0.25, t - 0.02);
      hg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      h.connect(hb).connect(hg).connect(lp);
      h.start(t - 0.07);
      h.stop(t + 0.08);
    }
  }

  /** A shake of sleigh bells at a spot: `level` 0 to 1, `ref` the distance at full volume. */
  private jingle(at: THREE.Vector3, level: number, ref: number, into?: AudioNode): void {
    const ctx = sound.context();
    if (!ctx) return;
    const dest = into ?? sound.at(at.x, at.y + 1, at.z, ref);
    if (!dest) return;
    if (this.bellBufs.length < 4) this.bellBufs.push(bellBuffer(ctx, this.bellBufs.length)); // one more each time, until four
    const src = ctx.createBufferSource();
    src.buffer = this.bellBufs[Math.floor(Math.random() * this.bellBufs.length)];
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(dest);
    src.start();
  }

  /** In flight the bells ring with the gallop, from where the team is: they come and go with its distance. */
  private updateBells(flying: boolean, t: number, camera: THREE.Camera): void {
    const ctx = sound.context();
    if (!flying || !ctx) {
      this.stopBells();
      return;
    }
    this.team.getWorldPosition(_v);
    if (!this.bells) this.bells = sound.at(_v.x, _v.y, _v.z, 30) as PannerNode | null;
    if (!this.bells) return;
    this.bells.positionX.value = _v.x;
    this.bells.positionY.value = _v.y;
    this.bells.positionZ.value = _v.z;
    const d = camera.position.distanceTo(_v);
    const fade = THREE.MathUtils.clamp(1 - (d - 80) / 260, 0, 1) * Math.min(1, t / 2, (FLIGHT.seconds - t) / 3);
    this.bellsAt -= 1;
    if (fade > 0.01 && this.bellsAt <= 0) {
      quiet(() => this.jingle(_v, 0.8 * fade, 30, this.bells!));
      this.bellsAt = 18 + Math.floor(Math.random() * 8); // frames: about three shakes a second
    }
  }

  private stopBells(): void {
    if (this.bells) {
      try {
        this.bells.disconnect();
      } catch {
        // already gone
      }
      this.bells = null;
    }
  }

  /** The speech bubble at a spot on the screen (CSS pixels), or hidden. Its text is set with textContent only. */
  private showBubble(at: { x: number; y: number } | null): void {
    if (!at) {
      if (this.bubble) this.bubble.style.display = 'none';
      return;
    }
    if (!this.bubble) {
      const b = document.createElement('div');
      b.className = 'santa-bubble';
      Object.assign(b.style, {
        position: 'fixed', zIndex: '6', pointerEvents: 'none', transform: 'translate(-50%, -100%)', maxWidth: 'min(260px, 62vw)',
        padding: '8px 13px', borderRadius: '14px', background: 'rgba(255, 253, 248, 0.96)', color: '#2f1311', textAlign: 'center',
        fontWeight: '600', fontSize: '15px', lineHeight: '1.3', boxShadow: '0 3px 12px rgba(0, 0, 0, 0.28)', border: '2px solid #b0121a',
      });
      const text = document.createElement('span');
      const tail = document.createElement('div');
      Object.assign(tail.style, {
        position: 'absolute', left: '50%', bottom: '-8px', width: '12px', height: '12px', marginLeft: '-6px', background: 'rgba(255, 253, 248, 0.96)',
        borderRight: '2px solid #b0121a', borderBottom: '2px solid #b0121a', transform: 'rotate(45deg)',
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

  /** For the checks: where the team is, what he does and says, the flight's phase. */
  state(): { x: number; y: number; z: number; shown: boolean; seated: boolean; flying: boolean; clip: string; said: string; deer: string[]; t: number; flies: boolean } {
    this.team.getWorldPosition(_v);
    const { t } = flightNow(this.now);
    return {
      x: +_v.x.toFixed(2), y: +_v.y.toFixed(2), z: +_v.z.toFixed(2), shown: this.group.visible, seated: this.seated, flying: this.flying, clip: this.manClip,
      said: this.sayFor > 0 ? this.said : '', deer: this.deer.map((d) => d.clip), t: +(Number.isNaN(this.forced) ? t : this.now - this.forced).toFixed(1), flies: this.window.flies,
    };
  }
}

/** Colours by slot into the vertex colours (sRGB to linear), times each face's shade (tools/villagers.py's UVs). */
function paintSlots(geo: THREE.BufferGeometry, look: (u: number) => string): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return;
  const col = new Float32Array(uv.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const shade = uv.getY(i); // glTF turns v over: 1 - (1 - shade)
    c.set(look(u));
    col[i * 3] = c.r * shade;
    col[i * 3 + 1] = c.g * shade;
    col[i * 3 + 2] = c.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

let glowTex: THREE.Texture | null = null;
/** A soft round glow, drawn once. */
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const a = Math.max(0, 1 - r) ** 2.2;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(255 * a);
      data[i + 3] = 255;
    }
  }
  glowTex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  glowTex.needsUpdate = true;
  return glowTex;
}

let noiseBuf: AudioBuffer | null = null;
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = Math.floor(ctx.sampleRate * 0.25);
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** One shake of a string of small bells (0.7 s): a dozen strikes, each a few bright, quickly dying, inharmonic tones. */
function bellBuffer(ctx: AudioContext, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.7);
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  let s = seed * 7919 + 13;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const hits = 11 + Math.floor(rnd() * 5);
  for (let h = 0; h < hits; h++) {
    const at = Math.floor((h < 6 ? rnd() * 0.12 : 0.18 + rnd() * 0.3) * sr); // a burst as the bells are shaken, then a few late ones
    const f0 = 2300 + rnd() * 1400;
    const amp = (h < 6 ? 0.22 : 0.12) * (0.6 + rnd() * 0.4);
    const end = Math.min(len, at + Math.floor(sr * 0.3));
    for (const [m, a, decay] of [[1, 1, 18], [2.32, 0.5, 26], [4.1, 0.28, 34], [6.3, 0.12, 44]]) {
      // A decaying sine by turning a point round a circle each sample (no sin per sample).
      const w = (2 * Math.PI * f0 * m) / sr;
      const k = Math.exp(-decay / sr);
      const c = Math.cos(w) * k;
      const sn = Math.sin(w) * k;
      let x = 1;
      let y = 0;
      for (let i = at; i < end; i++) {
        out[i] += amp * a * y;
        const nx = x * c - y * sn;
        y = x * sn + y * c;
        x = nx;
      }
    }
    // the click of the clapper
    for (let i = at; i < Math.min(len, at + 40); i++) out[i] += amp * 0.5 * (rnd() * 2 - 1) * (1 - (i - at) / 40);
  }
  return buf;
}

/** A sound that fails (an audio context in a strange state) never stops the frame. */
function quiet(fn: () => void): void {
  try {
    fn();
  } catch {
    // no sound this time
  }
}
