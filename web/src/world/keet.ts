import * as THREE from 'three';
import type { World } from './collision';
import type { Doors } from './doors';
import type { Glass } from './glass';
import { groundLayers, RANK } from './groundLayers';
import type { Prism } from './houseData';
import type { IndoorLight } from './indoorLight';
import { sound } from '../sound';
import { lampGlow, loadWalkIn, type EndInside, type WalkIn } from './walkIn';
import { makeKeet, PUBLIC_WALK_INS, type Keet, type KeetDoor } from '../../shared/keet.mjs';

/**
 * The café at the church (In de Oude Keet, the name on its sign board): a house everyone walks into, without a code. It is
 * a walk-in as the private homes are (world/walkIn.ts), but public: its shell comes with the village, its rooms
 * (src/data/keet_rooms.json, tools/keet.py) are a chunk of their own, fetched and built in idle time once the game is
 * playing, never before its first frame (the church square, in sight of it, is where most players start). No lock, no
 * lining, no home: shared/keet.mjs keeps its door ids and pane numbers apart from every home's.
 *
 * During a Zombies game at the church its doors work as ever, and the zombies follow players in (shared/arenas.mjs
 * villageGround): a shut door one of them shoves open, on every page.
 */

/** The café's window panes' numbers (shared/keet.mjs), once its shell is in. */
const panes = new Set<number>();
/** Whether pane `i` is one of the café's: public, it breaks alone as together (main.ts glass.locked). */
export const isKeetPane = (i: number): boolean => panes.has(i);

/** The café's walk-in, once the village's town model (world/townCentre.ts) is in: its `shut` meshes stand in from afar. */
export async function loadKeet(renderer: THREE.WebGLRenderer, town: THREE.Object3D | undefined, clock: () => number, prepare: (o: THREE.Object3D) => Promise<unknown>, viewer: () => THREE.Vector3): Promise<WalkIn | null> {
  if (!town) return null;
  const shell = (await import('../data/keet_shell.json')).default as unknown as { doors: { id: string }[]; outline: [number, number][]; panes: unknown[] };
  openings = makeKeet(shell, { rooms: [], prisms: [], parts: [], fixtures: [], props: [], doors: [] }).doors;
  shell.panes.forEach((_, i) => panes.add(PUBLIC_WALK_INS.keet.glass + i));
  // Its outline claimed as a model's ground (world/groundLayers.ts), before the village's covers and the streets in detail
  // are cut: the lane's and the back street's surfaces that reached under the house (on the relief, which rises above the
  // floor at the back) give way to its floors, as under the homes' plots. Called before main.ts claims the models' ground.
  const [a, b, c, d] = shell.outline;
  const group = groundLayers.group();
  groundLayers.claim([a, b, c], RANK.model, group);
  groundLayers.claim([a, c, d], RANK.model, group);
  return loadWalkIn(renderer, { id: 'keet', model: town, village: 'outline', open: () => true, clock, prepare, viewer }).catch(() => null);
}

/**
 * The café's rooms, after `after` (the game playing) and in the browser's idle time: their walls, floors and doors go in,
 * their new meshes hidden until their shaders are compiled (`prepare`), so walking in never waits for a compile.
 * `done`: the rooms' names and their floors in the world (for what counts as indoors), and the café as a whole (the minimap's floor).
 */
export function keetRooms(keet: WalkIn, deps: { world: World; doors: Doors; glass: Glass; prepare: (o: THREE.Object3D) => Promise<unknown>; after: Promise<unknown>; done: (rooms: string[], floors: Prism[], keet: Keet) => void }): void {
  const idle = () => new Promise<void>((r) => ('requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout: 3000 }) : setTimeout(r, 300)));
  void deps.after.then(async () => {
    const [rooms, shell] = await Promise.all([import('../data/keet_rooms.json'), import('../data/keet_shell.json')]);
    const pack = rooms.default as unknown as EndInside; // as a home's pack, public (tools/keet.py)
    await idle();
    const before = new Set<THREE.Object3D>();
    const empty = new Set<THREE.Object3D>();
    keet.group.traverse((o) => {
      before.add(o);
      if ((o as THREE.Mesh).isMesh && !(o as THREE.Mesh).geometry.getAttribute('position')) empty.add(o);
    });
    keet.addInside(pack, deps.world, deps.doors, deps.glass);
    // What is new to draw (the rooms' mesh, the inner doors): out of sight while its shaders compile on a stand-in.
    const fresh: THREE.Mesh[] = [];
    keet.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && (empty.has(m) || !before.has(m))) fresh.push(m);
    });
    keet.group.updateMatrixWorld(true);
    const aside = new THREE.Group();
    for (const m of fresh) {
      m.visible = false;
      const proxy = new THREE.Mesh(m.geometry, m.material);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(m.matrixWorld);
      aside.add(proxy);
    }
    await deps.prepare(aside).catch(() => undefined);
    for (const m of fresh) m.visible = true;
    const keetData = makeKeet(shell.default, pack);
    openings = keetData.doors;
    deps.done(pack.rooms, keetData.prisms.filter((p) => p.n) as unknown as Prism[], keetData);
  }).catch(() => undefined); // no rooms: the café stays a lump with its doors and windows
}

/** The café as the zombies' grid takes it alone at the church (shared/keet.mjs), from its two public files, as the server reads them. */
export async function keetForZombies(): Promise<Keet> {
  const [shell, rooms] = await Promise.all([import('../data/keet_shell.json'), import('../data/keet_rooms.json')]);
  return makeKeet(shell.default, rooms.default);
}

/** The café's doors in the world, where their leaves stand shut (shared/keet.mjs): their openings. */
let openings: KeetDoor[] = [];
const REACH = 2.6; // as world/doors.ts
const eye = new THREE.Vector3();
const ahead = new THREE.Vector3();
/**
 * An open café door you look through, within reach: its leaf has swung aside, edge-on or out of view (the front door's
 * against its reveal), so the doorway itself stands for it and Use shuts it, as world/doors.ts's own toggle would. Then
 * the door's prompt, not the timed route's offer, has the prompt line in the doorway (main.ts). Null otherwise.
 */
export function keetDoorway(camera: THREE.Camera, doors: Doors): { id: string; name: string; open: boolean; locked: boolean; home: string | null; toggle: () => void } | null {
  camera.getWorldPosition(eye);
  camera.getWorldDirection(ahead);
  let best: { d: KeetDoor; t: number } | null = null;
  for (const d of openings) {
    const [a, b] = [d.panels[0].a, d.panels[0].b];
    if (!doors.isOpen(d.id) || Math.hypot(eye.x - (a[0] + b[0]) / 2, eye.z - (a[1] + b[1]) / 2) > REACH + 1) continue;
    // The ray against the doorway's upright rectangle: a to b, from the door's foot to its head.
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = ahead.x * ez - ahead.z * ex;
    if (Math.abs(den) < 1e-6) continue;
    const t = ((a[0] - eye.x) * ez - (a[1] - eye.z) * ex) / den;
    const s = ((a[0] - eye.x) * ahead.z - (a[1] - eye.z) * ahead.x) / den;
    const y = eye.y + ahead.y * t;
    if (t > 0 && t < REACH && s > 0.05 && s < 0.95 && y > d.y0 && y < d.y1 && (!best || t < best.t)) best = { d, t };
  }
  if (!best) return null;
  const { id, name } = best.d;
  return { id, name, open: true, locked: false, home: null, toggle: () => { doors.set(id, false); doors.onToggle(id, false, 1); } };
}

/** The café's fill light indoors: warmer than a home's, and dimmer (world/indoorLight.ts setPlace). */
const FILL = new THREE.Color('#f3d9b0');
const FILL_SCALE = 0.75;
/** The lamps' glow (world/walkIn.ts lampGlow): by day, and how much more at night. Far under what half floats hold. */
const GLOW_DAY = 1.5;
const GLOW_NIGHT = 2;
/** The two real lights (Medium and up, not on phones): over the bar and over the pool table, in the café's frame (u, height, v). */
const LAMPS: [number, number, number][] = [[2.5, 1.9, 9.25], [2.5, 1.7, 4.4]];
const LAMP_COLOR = '#ffc58a';
/** cd by day and at night, and how far each reaches (m) */
const LAMP_DAY = 3;
const LAMP_NIGHT = 6;
const LAMP_REACH = 6.5;
/** The panes' warm glow seen from the square at night, and the patch of light on the paving before the front window */
const PANE_GLOW = new THREE.Color('#ffb46a');
const PANE_NIGHT = 0.28;
const PATCH_NIGHT = 0.55;

/** The wall clock (u, height, v: on the dividing wall, the bar room's side) and the stove (the front room's), and how far each is heard (m). */
const CLOCK: [number, number, number] = [3.4, 2.05, 7.72];
const STOVE: [number, number, number] = [2.3, 0.4, 7.2];
const CLOCK_REACH = 4;
const STOVE_REACH = 3;
/** Their levels: soft, under the wind's (world/ambience.ts) */
const TICK = 0.05;
const CRACKLE = 0.06;
const MURMUR = 0.05;
/** The murmur's share in the front room and the toilets, the bar room's being 1 */
const MURMUR_FAR = 0.3;

/** A small fixed random sequence (as world/acoustics.ts), so the sounds are the same each time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ends of a loop faded into each other over `n` samples, so it has no seam. */
function seamless(d: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const k = i / n;
    d[i] = d[i] * k + d[d.length - n + i] * (1 - k);
  }
}

/** Two seconds of a wall clock: a tick and a slightly lower tock, a second apart. */
function clockTicks(rate: number): Float32Array<ArrayBuffer> {
  const d = new Float32Array(rate * 2);
  const rnd = seeded(71);
  [[0, 2600], [1, 2150]].forEach(([at, f]) => {
    const start = Math.round(at * rate);
    for (let i = 0; i < rate * 0.03; i++) {
      const t = i / rate;
      d[start + i] += (rnd() * 2 - 1) * Math.exp(-t / 0.0012) * 0.6 + Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.005) * 0.5;
    }
  });
  return d;
}

/** Six seconds of a stove: a faint low roar and the pops and ticks of burning wood, now here, now there. */
function stoveFire(rate: number): Float32Array<ArrayBuffer> {
  const d = new Float32Array(rate * 6);
  const rnd = seeded(29);
  let low = 0;
  for (let i = 0; i < d.length; i++) {
    low = (low + 0.02 * (rnd() * 2 - 1)) / 1.02;
    d[i] = low * 0.9;
  }
  for (let k = 0; k < 40; k++) {
    const start = Math.floor(rnd() * (d.length - rate * 0.02));
    const amp = 0.15 + 0.85 * rnd() ** 2;
    const len = 0.002 + 0.006 * rnd();
    for (let i = 0; i < rate * 0.02; i++) d[start + i] += (rnd() * 2 - 1) * amp * Math.exp(-i / rate / len);
  }
  seamless(d, Math.floor(rate * 0.3));
  return d;
}

/**
 * Ten seconds of a few voices talking, without words: each a buzz at a voice's pitch, rising and falling, cut into
 * syllables and phrases with pauses between; through a low-pass filter afterwards, so no word could ever be heard.
 */
function voices(rate: number): Float32Array<ArrayBuffer> {
  const d = new Float32Array(rate * 10);
  [[118, 3], [162, 11], [208, 17]].forEach(([f0, seed], v) => {
    const rnd = seeded(seed);
    // Phrases: talking for 1.2 to 3.4 s, quiet for 0.6 to 2.6 s.
    const talk: [number, number][] = [];
    for (let t = rnd() * 2; t < 10; ) {
      const len = 1.2 + rnd() * 2.2;
      talk.push([t, Math.min(10, t + len)]);
      t += len + 0.6 + rnd() * 2;
    }
    let phase = 0;
    const p1 = rnd() * 6, p2 = rnd() * 6, p3 = rnd() * 6;
    for (let i = 0; i < d.length; i++) {
      const t = i / rate;
      const on = talk.find(([a, b]) => t >= a && t < b);
      if (!on) continue;
      const edge = Math.min(1, (t - on[0]) / 0.08, (on[1] - t) / 0.12);
      const syl = Math.max(0, Math.sin(2 * Math.PI * (4.2 + v * 0.4) * t + 1.3 * Math.sin(2 * Math.PI * 0.9 * t + p3))) ** 1.5;
      const f = f0 * (1 + 0.09 * Math.sin(2 * Math.PI * 0.6 * t + p1) + 0.04 * Math.sin(2 * Math.PI * 2.1 * t + p2));
      phase += (2 * Math.PI * f) / rate;
      let s = 0;
      for (let k = 1; k <= 8; k++) s += (Math.sin(phase * k) / k) * (1 + 1.5 * Math.exp(-(((k * f - 650) / 380) ** 2)));
      d[i] += s * syl * edge * 0.18;
    }
  });
  seamless(d, Math.floor(rate * 0.5));
  return d;
}

/**
 * The café's quiet sounds, made in code (no files): a wall clock's tick near the clock, a faint crackle by the stove,
 * and a murmur of voices without words while its villagers are there (never in Zombies, when they are gone), in the bar
 * room and faintly elsewhere. Only while you are inside its outline, and with the game's sound on; its rooms take the
 * short echo a home's rooms have (world/acoustics.ts: they are rooms).
 */
class KeetSounds {
  private ctx: AudioContext | null = null;
  private buffers: Record<'tick' | 'stove' | 'murmur', AudioBuffer> | null = null;
  private live: { sources: AudioBufferSourceNode[]; tick: GainNode; stove: GainNode; murmur: GainNode } | null = null;
  private peopleAt = 0;
  private people = false;
  private readonly spot = new THREE.Vector3();

  update(dt: number, inside: boolean, ear: THREE.Vector3, frame: { o: number[]; a: number; floor: number }, people: () => boolean): void {
    const active = navigator.userActivation?.hasBeenActive ?? true;
    const c = inside && active ? sound.context() : null;
    if (!c || c !== this.ctx) this.stop();
    if (!c) return;
    if (c !== this.ctx) {
      this.ctx = c;
      this.buffers = null;
    }
    const { o, a, floor } = frame;
    const cs = Math.cos(a), sn = Math.sin(a);
    const at = ([u, h, v]: [number, number, number]) => this.spot.set(o[0] + u * cs + v * sn, floor + h, o[1] - u * sn + v * cs);
    if (!this.live) this.start(c, at);
    if (!this.live) return;
    this.peopleAt -= dt;
    if (this.peopleAt <= 0) {
      this.peopleAt = 1;
      this.people = people();
    }
    // The ear in the café's frame: the bar room and behind the bar lie beyond the dividing wall (v 7.67).
    const dx = ear.x - o[0], dz = ear.z - o[1];
    const v = dx * sn + dz * cs;
    const near = (p: [number, number, number], reach: number) => Math.max(0, 1 - at(p).distanceTo(ear) / reach);
    const t = c.currentTime;
    this.live.tick.gain.setTargetAtTime(TICK * near(CLOCK, CLOCK_REACH), t, 0.15);
    this.live.stove.gain.setTargetAtTime(CRACKLE * near(STOVE, STOVE_REACH), t, 0.15);
    this.live.murmur.gain.setTargetAtTime(this.people ? MURMUR * (v > 7.6 && v < 17.2 ? 1 : MURMUR_FAR) : 0, t, 0.6);
  }

  private start(c: AudioContext, at: (p: [number, number, number]) => THREE.Vector3): void {
    if (!this.buffers) {
      const make = (data: Float32Array<ArrayBuffer>, rate: number) => {
        const b = c.createBuffer(1, data.length, rate);
        b.copyToChannel(data, 0);
        return b;
      };
      // The voices at a low rate: they are low-passed anyway, and are made a quarter as fast.
      this.buffers = { tick: make(clockTicks(c.sampleRate), c.sampleRate), stove: make(stoveFire(c.sampleRate), c.sampleRate), murmur: make(voices(16000), 16000) };
    }
    const out = sound.out();
    const clock = at(CLOCK);
    const tickAt = sound.at(clock.x, clock.y, clock.z, CLOCK_REACH);
    const stove = at(STOVE);
    const stoveAt = sound.at(stove.x, stove.y, stove.z, STOVE_REACH);
    if (!out || !tickAt || !stoveAt) return;
    const loop = (buffer: AudioBuffer, to: AudioNode, filter?: BiquadFilterNode): [AudioBufferSourceNode, GainNode] => {
      const src = c.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const g = c.createGain();
      g.gain.value = 0;
      (filter ? src.connect(filter) : src).connect(g).connect(to);
      src.start();
      return [src, g];
    };
    const stoveLow = c.createBiquadFilter();
    stoveLow.type = 'lowpass';
    stoveLow.frequency.value = 2200;
    const voiceLow = c.createBiquadFilter();
    voiceLow.type = 'lowpass';
    voiceLow.frequency.value = 850;
    const [s1, tick] = loop(this.buffers.tick, tickAt);
    const [s2, stoveG] = loop(this.buffers.stove, stoveAt, stoveLow);
    const [s3, murmur] = loop(this.buffers.murmur, out, voiceLow);
    this.live = { sources: [s1, s2, s3], tick, stove: stoveG, murmur };
  }

  /** Everything faded out and stopped: out of the café, or the sound switched off. */
  private stop(): void {
    if (!this.live || !this.ctx) {
      this.live = null;
      return;
    }
    const t = this.ctx.currentTime;
    for (const g of [this.live.tick, this.live.stove, this.live.murmur]) g.gain.setTargetAtTime(0, t, 0.08);
    for (const s of this.live.sources) {
      s.stop(t + 0.5);
      s.onended = () => s.disconnect();
    }
    this.live = null;
  }
}

/**
 * The café's life (package C): its light by day and by night. Indoors its fill is warm and dim, its bulbs and opal
 * shades glow (more at night), and on Medium and up two lights without shadows hang over the bar and the pool table,
 * lit only while you are inside. At night its panes glow warm from the square, and on Medium and up a soft warm patch
 * lies on the paving before the front window. No full-screen effect, nothing per lamp on Low or a phone.
 *
 * The two lights are made with the game and stay in the scene for good, as the torch (world/torch.ts): a light added
 * later makes every lit shader compile again. Outside the café they have no strength.
 */
export class KeetLife {
  private lights: THREE.PointLight[] = [];
  private keet: WalkIn | null = null;
  private frame: { o: number[]; a: number; floor: number } | null = null;
  private glass: THREE.MeshStandardMaterial | null = null;
  private patch: THREE.Mesh | null = null;
  private lit = 0;
  private sounds = new KeetSounds();
  /** Whether the eye was inside the café's outline at the last update */
  inside = false;

  /** `real`: whether to make the two real lights (Medium and up at the start, never on a phone). */
  constructor(scene: THREE.Scene, private fill: IndoorLight, real: boolean) {
    if (!real) return;
    for (let i = 0; i < LAMPS.length; i++) {
      const l = new THREE.PointLight(LAMP_COLOR, 0, LAMP_REACH, 2);
      l.castShadow = false;
      l.name = 'café lamp';
      scene.add(l);
      this.lights.push(l);
    }
  }

  /** The café's world position of (u, height over its floor, v) in its own frame. */
  private at(u: number, h: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { o, a, floor } = this.frame!;
    const c = Math.cos(a), s = Math.sin(a);
    return out.set(o[0] + u * c + v * s, floor + h, o[1] - u * s + v * c);
  }

  /** The café's walk-in is in (main.ts): its frame, its glass, and the patch of light before it (`ground`: the height there). */
  async attach(keet: WalkIn, scene: THREE.Scene, ground: (x: number, z: number, from: number) => number): Promise<void> {
    const shell = (await import('../data/keet_shell.json')).default as unknown as { frame: { o: number[]; a: number; floor: number } };
    this.keet = keet;
    this.frame = shell.frame;
    LAMPS.forEach(([u, h, v], i) => this.lights[i] && this.at(u, h, v, this.lights[i].position));
    // The café's own glass (world/walkIn.ts: one mesh of all its panes, its material its own): it glows at night.
    keet.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
      if ((o as THREE.Mesh).isMesh && m?.isMeshPhysicalMaterial && m.vertexColors && m.transparent) this.glass = m;
    });
    // The patch: 2.5 m along the front, 2 m out onto the square, before the front window (u 1.21 to 3.13), brightest at the wall.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const img = g.createImageData(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const across = Math.sin((Math.PI * (x + 0.5)) / 64) ** 1.5;
        const out = (1 - (y + 0.5) / 64) ** 2; // y 0 at the wall
        const k = Math.round(255 * across * out);
        img.data.set([k, k, k, 255], (y * 64 + x) * 4);
      }
    }
    g.putImageData(img, 0, 0);
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    const pos: number[] = [];
    const uv: number[] = [];
    const p = new THREE.Vector3();
    for (const [du, dv, tu, tv] of [[0, 0, 0, 0], [1, 0, 1, 0], [1, 1, 1, 1], [0, 0, 0, 0], [1, 1, 1, 1], [0, 1, 0, 1]]) {
      this.at(2.17 - 1.25 + 2.5 * du, 0, -0.05 - 2 * dv, p);
      p.y = ground(p.x, p.z, this.frame.floor + 0.5) + 0.03;
      pos.push(p.x, p.y, p.z);
      uv.push(tu, tv);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const mat = new THREE.MeshBasicMaterial({ map, color: PANE_GLOW, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.opacity = 0;
    this.patch = new THREE.Mesh(geo, mat);
    this.patch.name = 'café window light';
    this.patch.userData.ignoreRay = true;
    this.patch.renderOrder = 3;
    this.patch.visible = false;
    this.patch.frustumCulled = false;
    scene.add(this.patch);
  }

  /** Each frame: the eye, the night (0 to 1, world/mood.ts), and whether this preset may have the lights and the patch (Medium and up, no phone). */
  update(dt: number, eye: THREE.Vector3, night: number, fine: boolean, people: () => boolean): void {
    if (!this.frame) return;
    const inside = !!this.keet?.contains(eye.x, eye.z) && eye.y < this.frame.floor + 4;
    this.inside = inside;
    this.sounds.update(dt, inside, eye, this.frame, people);
    this.fill.setPlace(inside ? FILL : null, FILL_SCALE);
    lampGlow.value = GLOW_DAY + (GLOW_NIGHT - GLOW_DAY) * night;
    this.lit += ((inside && fine ? 1 : 0) - this.lit) * (1 - Math.exp(-dt * 3));
    if (this.lit < 0.01 && !(inside && fine)) this.lit = 0;
    const cd = this.lit * (LAMP_DAY + (LAMP_NIGHT - LAMP_DAY) * night);
    for (const l of this.lights) l.intensity = cd;
    if (this.glass) this.glass.emissive.copy(PANE_GLOW).multiplyScalar(inside ? 0 : PANE_NIGHT * night);
    if (this.patch) {
      this.patch.visible = fine && night > 0.02;
      (this.patch.material as THREE.MeshBasicMaterial).opacity = PATCH_NIGHT * night;
    }
  }
}

