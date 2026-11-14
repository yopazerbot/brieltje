import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LootKind } from '../../shared/loot.mjs';
import { LOOT } from '../../shared/loot.mjs';
import { paintball } from '../paintball';
import { sound } from '../sound';
import type { Ring } from './houseData';

/**
 * The Zombies game's rewards on screen (shared/loot.mjs keeps them: the server together, the page
 * alone): each lies where its zombie fell as a glowing ring on the ground with a beam of light and
 * its sign turning above it (a box of ammo, a scope, a claymore, a bundle of stakes, a turret), so
 * it shows from across the garden; walk over it to take it. And the claymores placed: a small curved
 * box on two legs on the floor, facing the way it goes off, with a light blinking once it is armed (in
 * paintball a bright paint mine). Shared geometry, the parts of one material merged: three or four
 * draws a reward, three a claymore. The rows of stakes: sharpened poles leaning the way the row
 * faces, lashed to a rail, each on the ground under it; as the zombies wear a row its stakes tip over
 * one by one, and when it's worn through it bursts in splinters. All rows are two instanced draws.
 * The turrets: a tripod whose head unfolds, turns to the zombie it shoots (the server says which, in
 * each shot) and flashes; its eye goes from green to amber to blinking red as its rounds run out, and
 * when they are out it is gone in a puff. Four draws a turret, five as it flashes.
 * The five newer rewards' signs: a white first-aid kit with a red cross, a dark blue vest with two
 * straps, three grenades, a little wooden music box with a crank, a big crate with two white bands.
 * A music box taken opens where it lay and plays its tune; glowing dots on the ground mark the circle
 * it slows the zombies in (all of them one instanced draw).
 */

const COLORS: Record<LootKind, string> = {
  ammo: '#f2c14e', scope: '#5fd3f3', claymore: '#ff7a45', stakes: '#9be36b', turret: '#c58cff',
  nades: '#d7e05a', medkit: '#ff5d73', armor: '#4f8dff', lull: '#ff8ad8', gun: '#ffffff',
};
const REACH = 1.0; // m: the page asks for one this close (the server allows LOOT.reach)

const ringGeo = new THREE.RingGeometry(0.3, 0.4, 32).rotateX(-Math.PI / 2);
const beamGeo = new THREE.CylinderGeometry(0.05, 0.12, 1.8, 10, 1, true).translate(0, 0.9, 0);
const boxGeo = new THREE.BoxGeometry(0.26, 0.15, 0.17);
const bandGeo = new THREE.BoxGeometry(0.265, 0.035, 0.175);
const tubeGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.3, 16).rotateX(Math.PI / 2);
/** A part placed in its model: moved, turned about y (`ry`) and x (`rx`). */
const placed = (geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rx = 0) =>
  geo.clone().applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)), new THREE.Vector3(1, 1, 1)));
const lens = new THREE.CylinderGeometry(0.042, 0.042, 0.02, 16).rotateX(Math.PI / 2);
const lensGeo = mergeGeometries([placed(lens, 0, 0, -0.155), placed(lens, 0, 0, 0.155)]);
// A claymore: two slabs at an angle (the curve, bulging to the front), on two legs.
const slab = new THREE.BoxGeometry(0.13, 0.13, 0.045);
const slabGeo = mergeGeometries([-1, 1].map((side) => placed(slab, side * 0.062, 0.12, 0.012, side * 0.32)));
const leg = new THREE.BoxGeometry(0.012, 0.09, 0.012);
const legGeo = mergeGeometries([-1, 1].map((side) => placed(leg, side * 0.09, 0.045, 0.02, 0, 0.25)));
const ledGeo = new THREE.SphereGeometry(0.014, 8, 6);

// A stake: a pole with a pale sharpened tip (fresh-cut wood), its foot at the origin, standing up y;
// and the rail they are lashed to, 1 m along x. One material, the colours in the vertices.
const tinted = (geo: THREE.BufferGeometry, hex: string) => {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  geo.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [c.r, c.g, c.b][i % 3]), 3));
  return geo;
};
const POLE = 0.95;
const stakeGeo = mergeGeometries([
  tinted(new THREE.CylinderGeometry(0.042, 0.05, POLE, 7).translate(0, POLE / 2, 0), '#6b4a2b'),
  tinted(new THREE.ConeGeometry(0.042, 0.2, 7, 1, true).translate(0, POLE + 0.1, 0), '#d9b98a'),
]);
const railGeo = tinted(new THREE.CylinderGeometry(0.045, 0.045, 1, 7).rotateZ(Math.PI / 2), '#5a3d22');
const woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
/** How far a standing stake leans forward (rad), where its foot is behind the row's line and how high the rail is (m). */
const LEAN = 0.6;
const FOOT = 0.15;
const RAIL_Y = 0.42;
const RAIL_Z = FOOT - Math.tan(LEAN) * RAIL_Y;
/** At most this many stakes and rails drawn: every row down at its widest. */
const MAX_STAKES = LOOT.stakesAll * (Math.round((2 * LOOT.stakeHalf) / LOOT.stakeGap) + 1);

interface Stake {
  /** m along the row; its own twist and how it tips over (sideways, rad) */
  u: number;
  twist: number;
  fallTwist: number;
  /** The order it falls in, and how far it has fallen (0 standing, 1 on the ground) */
  rank: number;
  fall: number;
}
interface StakeRow {
  x: number;
  y: number;
  z: number;
  yaw: number;
  a: number;
  b: number;
  up: number;
  stakes: Stake[];
}

/** A little random that is the same on every page for a row: its stakes look and fall alike for everyone. */
function seeded(id: number): () => number {
  let s = (id * 2654435761) >>> 0;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s / 4294967296;
  };
}

/** Wood made in code: a stake knocked into the ground (`knock`), one tipping over, a row bursting. */
function woodSound(at: THREE.Vector3, kind: 'knock' | 'tip' | 'burst'): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 0.4, at.z, kind === 'burst' ? 4 : 2);
  if (!ctx || !dest) return;
  const t0 = ctx.currentTime;
  const hits = kind === 'knock' ? 3 : kind === 'tip' ? 1 : 5;
  for (let h = 0; h < hits; h++) {
    const t = t0 + (kind === 'knock' ? h * 0.13 : kind === 'burst' ? h * 0.035 + Math.random() * 0.02 : 0);
    const len = kind === 'burst' ? 0.18 : 0.09;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, kind === 'burst' ? 2 : 4);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = kind === 'burst' ? 1400 + Math.random() * 800 : 650;
    band.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = kind === 'burst' ? 0.5 : kind === 'tip' ? 0.25 : 0.35;
    noise.connect(band).connect(g).connect(dest);
    noise.start(t);
    // The thump in it: a low note dying fast.
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(kind === 'burst' ? 110 : 150, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.1);
    const og = ctx.createGain();
    og.gain.setValueAtTime(kind === 'tip' ? 0.15 : 0.3, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 0.13);
  }
}

const glow = (color: string) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false });
const ringMats = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, glow(c)])) as Record<LootKind, THREE.MeshBasicMaterial>;
const beamMats = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })])) as Record<LootKind, THREE.MeshBasicMaterial>;
const lit = (color: string, glowColor: string, k = 0.6) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2, emissive: glowColor, emissiveIntensity: k });
const mats = {
  box: lit('#5d6b3a', '#2a3313', 0.5),
  band: lit('#f2c14e', '#f2c14e', 0.8),
  tube: lit('#1f2328', '#0d0f12', 0.3),
  lens: lit('#5fd3f3', '#5fd3f3', 1.2),
  mine: lit('#55603a', '#20250f', 0.25),
  minePaint: lit('#ff5fa2', '#7a1f4a', 0.4),
  leg: lit('#2a2a2a', '#000000', 0),
  led: new THREE.MeshBasicMaterial({ color: '#ff2a1a' }),
  ledOff: new THREE.MeshBasicMaterial({ color: '#3a0d0a' }),
  white: lit('#f2f2f0', '#ffffff', 0.35),
  cross: lit('#e0263c', '#e0263c', 0.6),
  vest: lit('#1f3a6b', '#0c1a33', 0.35),
  strap: lit('#9aa3ad', '#2a2f35', 0.2),
  musicWood: lit('#8a5a32', '#2a1608', 0.3),
  brass: lit('#d4a640', '#5a4010', 0.4),
};

// The newer signs' own shapes: a red cross for each side of the first-aid kit, a vest's body and
// straps, a grenade, a music box (its lid apart, so it can open) and its crank, a crate's bands.
const crossGeo = mergeGeometries([-1, 1].flatMap((side) => [
  new THREE.BoxGeometry(0.12, 0.035, 0.006).translate(0, 0, side * 0.087),
  new THREE.BoxGeometry(0.035, 0.11, 0.006).translate(0, 0, side * 0.087),
]));
const vestGeo = new THREE.BoxGeometry(0.24, 0.3, 0.1);
const strapGeo = mergeGeometries([-1, 1].map((side) => new THREE.BoxGeometry(0.04, 0.33, 0.106).translate(side * 0.065, 0.01, 0)));
const nadeGeo = new THREE.SphereGeometry(0.06, 12, 9).scale(1, 1.2, 1);
const musicGeo = new THREE.BoxGeometry(0.2, 0.11, 0.14).translate(0, 0.055, 0);
const lidGeo = new THREE.BoxGeometry(0.2, 0.025, 0.14).translate(0, 0.0125, 0.07); // hinged at its back edge
const crankGeo = mergeGeometries([
  new THREE.CylinderGeometry(0.008, 0.008, 0.05, 6).rotateZ(Math.PI / 2).translate(0.125, 0.06, 0),
  new THREE.BoxGeometry(0.01, 0.06, 0.012).translate(0.15, 0.035, 0),
  new THREE.CylinderGeometry(0.01, 0.01, 0.03, 6).rotateZ(Math.PI / 2).translate(0.165, 0.01, 0),
]);
const crateBandGeo = mergeGeometries([-1, 1].map((side) => new THREE.BoxGeometry(0.035, 0.155, 0.175).translate(side * 0.07, 0, 0)));

/** A music box: open (playing on the ground) or shut (a reward's sign). Its foot at the origin. */
function musicBox(open: boolean): THREE.Group {
  const g = new THREE.Group();
  const lid = new THREE.Mesh(lidGeo, mats.musicWood);
  lid.position.set(0, 0.11, -0.07);
  lid.rotation.x = open ? -1.9 : 0;
  g.add(new THREE.Mesh(musicGeo, mats.musicWood), lid, new THREE.Mesh(crankGeo, mats.brass));
  g.traverse((o) => (o.userData.ignoreRay = true));
  return g;
}

/** Dots on the ground round each music box playing: this many on its circle; at most LOOT.lullsAll play. */
const LULL_DOTS = 16;
const dotGeo = new THREE.SphereGeometry(0.07, 8, 6);
const dotMat = new THREE.MeshBasicMaterial({ color: COLORS.lull, transparent: true, opacity: 0.8, depthWrite: false });
/** The music box's tune: eight notes of its own (semitones over C5), one every NOTE_S, played again every PHRASE_S. */
const TUNE = [4, 9, 7, 12, 9, 14, 11, 7];
const NOTE_S = 0.3;
const PHRASE_S = 2.6;

/** One phrase of the tune from the box at `at`: plucked notes dying away, a little bell over each. */
function tune(at: THREE.Vector3): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 0.2, at.z, 3);
  if (!ctx || !dest) return;
  const t0 = ctx.currentTime + 0.02;
  TUNE.forEach((semi, i) => {
    const f = 523.25 * Math.pow(2, semi / 12);
    const t = t0 + i * NOTE_S;
    for (const [mul, gain] of [[1, 0.22], [4, 0.04]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (mul === 1 ? 0.9 : 0.3));
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.95);
    }
  });
}

/** A claymore's own shape: its front is its -z (the way it faces). */
function mineModel(paint: boolean): { g: THREE.Group; led: THREE.Mesh } {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(slabGeo, paint ? mats.minePaint : mats.mine), new THREE.Mesh(legGeo, mats.leg));
  const led = new THREE.Mesh(ledGeo, mats.ledOff);
  led.position.set(0, 0.2, 0.01);
  g.add(led);
  return { g, led };
}

// A turret: three splayed legs and a hub (its foot at the origin), and the head that turns on it: a
// box with an ammo can at its side, a barrel with a muzzle brake out of its front (-z), an eye that
// shows how many rounds are left, and a flash at the muzzle. The parts of one material merged.
const TURRET_Y = 0.5;
/** It is built at this much of its size: a third bigger, so it reads from across the garden (about 0.75 m tall). */
const TURRET_SIZE = 1.35;
const legGeoT = new THREE.CylinderGeometry(0.014, 0.018, 0.56, 6).translate(0, -0.28, 0);
const legsGeo = mergeGeometries([
  ...[0, 1, 2].map((i) => legGeoT.clone().rotateX(0.42).rotateY((i * Math.PI * 2) / 3 + Math.PI / 3).translate(0, TURRET_Y, 0)),
  new THREE.CylinderGeometry(0.04, 0.045, 0.1, 10).translate(0, TURRET_Y + 0.02, 0),
]);
const headGeo = mergeGeometries([
  new THREE.BoxGeometry(0.16, 0.13, 0.26).translate(0, 0.07, 0.02),
  new THREE.BoxGeometry(0.07, 0.09, 0.13).translate(0.115, 0.06, 0.05),
]);
const barrelGeo = mergeGeometries([
  new THREE.CylinderGeometry(0.017, 0.017, 0.3, 10).rotateX(Math.PI / 2).translate(0, 0.075, -0.25),
  new THREE.CylinderGeometry(0.026, 0.026, 0.06, 10).rotateX(Math.PI / 2).translate(0, 0.075, -0.39),
]);
const eyeGeo = new THREE.SphereGeometry(0.022, 10, 8);
const flashGeo = new THREE.ConeGeometry(0.05, 0.18, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0.075, -0.5);
const flashMat = new THREE.MeshBasicMaterial({ color: '#ffd38a', transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
/** Where the turret's muzzle is in its head (for the shots' sound and smoke). */
const MUZZLE = new THREE.Vector3(0, 0.075, -0.43);

interface TurretModel {
  g: THREE.Group;
  head: THREE.Group;
  tilt: THREE.Group;
  eye: THREE.Mesh;
  flash: THREE.Mesh;
}
function turretModel(paint: boolean): TurretModel {
  const g = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(TURRET_SIZE);
  const head = new THREE.Group();
  const tilt = new THREE.Group();
  head.position.y = TURRET_Y + 0.06;
  g.add(body);
  body.add(new THREE.Mesh(legsGeo, mats.leg), head);
  head.add(tilt);
  const eye = new THREE.Mesh(eyeGeo, new THREE.MeshBasicMaterial({ color: '#3a0d0a' }));
  eye.position.set(-0.045, 0.14, -0.08);
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.visible = false;
  tilt.add(new THREE.Mesh(headGeo, paint ? mats.minePaint : mats.mine), new THREE.Mesh(barrelGeo, mats.tube), eye, flash);
  g.traverse((o) => (o.userData.ignoreRay = true));
  return { g, head, tilt, eye, flash };
}

/** A reward's sign above its ring: an ammo box, a scope, a claymore, a bundle of stakes, a turret. */
function sign(kind: LootKind): THREE.Group {
  const g = new THREE.Group();
  if (kind === 'ammo') {
    g.add(new THREE.Mesh(boxGeo, mats.box), new THREE.Mesh(bandGeo, mats.band));
  } else if (kind === 'scope') {
    g.add(new THREE.Mesh(tubeGeo, mats.tube), new THREE.Mesh(lensGeo, mats.lens));
  } else if (kind === 'stakes') {
    // Three stakes tied in a bundle, lying across, points one way.
    for (const [dx, dy] of [[0, 0], [0.07, 0.06], [-0.07, 0.06]]) {
      const s = new THREE.Mesh(stakeGeo, woodMat);
      s.scale.setScalar(0.42);
      s.rotation.z = -Math.PI / 2;
      s.position.set(-0.24, dy - 0.03, dx);
      g.add(s);
    }
  } else if (kind === 'turret') {
    const t = turretModel(paintball.on);
    t.g.scale.setScalar(0.5);
    t.g.position.y = -0.3;
    g.add(t.g);
  } else if (kind === 'medkit') {
    g.add(new THREE.Mesh(boxGeo, mats.white), new THREE.Mesh(crossGeo, mats.cross));
  } else if (kind === 'armor') {
    g.add(new THREE.Mesh(vestGeo, mats.vest), new THREE.Mesh(strapGeo, mats.strap));
  } else if (kind === 'nades') {
    for (const [x, y] of [[-0.075, -0.04], [0.075, -0.04], [0, 0.07]]) {
      const n = new THREE.Mesh(nadeGeo, paintball.on ? mats.minePaint : mats.mine);
      n.position.set(x, y, 0);
      g.add(n);
    }
  } else if (kind === 'lull') {
    const m = musicBox(false);
    m.scale.setScalar(1.3);
    m.position.y = -0.08;
    g.add(m);
  } else if (kind === 'gun') {
    const crate = new THREE.Group();
    crate.add(new THREE.Mesh(boxGeo, mats.box), new THREE.Mesh(crateBandGeo, mats.white));
    crate.scale.setScalar(1.4);
    g.add(crate);
  } else {
    const m = mineModel(paintball.on).g;
    m.position.y = -0.12;
    m.scale.setScalar(1.4);
    g.add(m);
  }
  g.traverse((o) => (o.userData.ignoreRay = true));
  return g;
}

interface Shown {
  kind: LootKind;
  g: THREE.Group;
  icon: THREE.Group;
  beam: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  born: number;
}

export class Rewards {
  readonly group = new THREE.Group();
  private items = new Map<number, Shown>();
  private mines = new Map<number, { g: THREE.Group; led: THREE.Mesh; at: number; paint: boolean }>();
  private rows = new Map<number, StakeRow>();
  private stakeMesh = new THREE.InstancedMesh(stakeGeo, woodMat, MAX_STAKES);
  private railMesh = new THREE.InstancedMesh(railGeo, woodMat, LOOT.stakesAll);
  /** Whether a stake is still tipping over (the stakes' matrices are set again each frame until none is) */
  private tipping = false;
  private clock = 0;
  /** A row of stakes burst: where its stakes stood (the caller throws the splinters). */
  onBurst: (points: THREE.Vector3[]) => void = () => {};
  /** The turrets up: their model, yaw as set up, where they aim (and how far up), when they last shot, rounds left. */
  private turrets = new Map<number, { m: TurretModel; set: number; aim: number; pitch: number; born: number; shotAt: number; flashLeft: number; rounds: number; paint: boolean }>();
  /** A turret ran out of rounds and folded away: where (the caller puffs). */
  onSpent: (at: THREE.Vector3) => void = () => {};
  /** The music boxes playing: the open box on the ground, when its tune plays next (this clock). */
  private lulls = new Map<number, { g: THREE.Group; at: THREE.Vector3; next: number }>();
  private dotMesh = new THREE.InstancedMesh(dotGeo, dotMat, LULL_DOTS * LOOT.lullsAll);

  /** `ground`: the floor's height at (x, z) near height y, for each stake's foot. */
  constructor(private ground: (x: number, z: number, y: number) => number,
              private stakeBarrier: (id: number, ring: Ring | null, bottom?: number, top?: number) => void) {
    this.group.name = 'rewards';
    for (const m of [this.stakeMesh, this.railMesh]) {
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.ignoreRay = true; // shots and blasts go through (zombies wade through them)
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
    this.dotMesh.count = 0;
    this.dotMesh.userData.ignoreRay = true;
    this.dotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.dotMesh);
  }

  /**
   * The music boxes playing now ([id, x, y, z]): a new one opens on the ground with its circle of dots
   * (LOOT.lullReach round it, each dot on the floor there) and plays its tune until it is gone.
   */
  setLulls(list: [number, number, number, number][]): void {
    const ids = new Set(list.map((l) => l[0]));
    let changed = false;
    for (const [id, l] of this.lulls) {
      if (ids.has(id)) continue;
      l.g.removeFromParent();
      this.lulls.delete(id);
      changed = true;
    }
    for (const [id, x, y, z] of list) {
      if (this.lulls.has(id)) continue;
      const g = musicBox(true);
      g.position.set(x, this.ground(x, z, y), z);
      g.scale.setScalar(1.6);
      this.group.add(g);
      this.lulls.set(id, { g, at: new THREE.Vector3(x, y, z), next: this.clock });
      changed = true;
    }
    if (!changed) return;
    const m = new THREE.Matrix4();
    let n = 0;
    for (const l of this.lulls.values()) {
      for (let i = 0; i < LULL_DOTS && n < LULL_DOTS * LOOT.lullsAll; i++) {
        const a = (i / LULL_DOTS) * Math.PI * 2;
        const x = l.at.x + Math.cos(a) * LOOT.lullReach, z = l.at.z + Math.sin(a) * LOOT.lullReach;
        this.dotMesh.setMatrixAt(n++, m.makeTranslation(x, this.ground(x, z, l.at.y) + 0.08, z));
      }
    }
    this.dotMesh.count = n;
    this.dotMesh.instanceMatrix.needsUpdate = true;
    this.dotMesh.computeBoundingSphere();
  }

  /** You took a first-aid kit (two notes going up) or opened a supply crate (a knock on wood), at `at`. */
  pickup(kind: 'medkit' | 'gun', at: THREE.Vector3): void {
    if (kind === 'gun') return woodSound(at, 'knock');
    const ctx = sound.context();
    const dest = sound.out();
    if (!ctx || !dest) return;
    const t0 = ctx.currentTime + 0.01;
    for (const [i, f] of [[0, 523.25], [1, 783.99]]) {
      const t = t0 + i * 0.12;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.4);
    }
  }

  /** Your vest took a swipe: a dull thunk. */
  soaked(): void {
    const ctx = sound.context();
    const dest = sound.out();
    if (!ctx || !dest) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.18);
  }

  /**
   * The rows of stakes down now ([id, x, y, z, yaw, a, b, standing, owner]): new ones are knocked in,
   * gone ones go (in splinters only by burst), and in a worn one the next stakes tip over.
   */
  setStakes(list: [number, number, number, number, number, number, number, number, string][]): void {
    let changed = false;
    const ids = new Set(list.map((r) => r[0]));
    for (const id of this.rows.keys()) {
      if (ids.has(id)) continue;
      this.stakeBarrier(id, null);
      this.rows.delete(id);
      changed = true;
    }
    for (const [id, x, y, z, yaw, a, b, up] of list) {
      const row = this.rows.get(id);
      if (row) {
        if (row.up !== up) {
          if (up < row.up) woodSound(new THREE.Vector3(x, y, z), 'tip');
          row.up = up;
          changed = true;
        }
        continue;
      }
      // Its stakes, each a little different, and the order they fall in: the same on every page.
      const rand = seeded(id);
      const n = Math.round((b - a) / LOOT.stakeGap) + 1;
      const order = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const stakes = Array.from({ length: n }, (_, i): Stake => ({
        u: a + i * LOOT.stakeGap + (rand() - 0.5) * 0.06, twist: (rand() - 0.5) * 0.3, fallTwist: (rand() - 0.5) * 1.4, rank: order.indexOf(i), fall: 0,
      }));
      for (const s of stakes) if (s.rank >= up) s.fall = 1; // worn already when this page came
      this.rows.set(id, { x, y, z, yaw, a, b, up, stakes });
      // The rail still spans a worn row until it bursts. Follow its actual clipped length and yaw.
      const cos = Math.cos(yaw), sin = Math.sin(yaw);
      const ring: Ring = [[a - 0.15, RAIL_Z - 0.05], [b + 0.15, RAIL_Z - 0.05],
                          [b + 0.15, FOOT + 0.05], [a - 0.15, FOOT + 0.05]].map(
        ([u, back]) => [x + cos * u + sin * back, z - sin * u + cos * back]);
      const floors = ring.map(([px, pz]) => this.ground(px, pz, y));
      this.stakeBarrier(id, ring, Math.min(...floors), Math.max(...floors) + (POLE + 0.2) * Math.cos(LEAN));
      woodSound(new THREE.Vector3(x, y, z), 'knock');
      changed = true;
    }
    if (changed) this.layStakes();
  }

  /**
   * The turrets up now ([id, x, y, z, yaw as set up, owner]): new ones unfold, gone ones (spent) go
   * in a puff (`onSpent`), unless `quiet` (the game ended).
   */
  setTurrets(list: [number, number, number, number, number, string][], quiet = false): void {
    const ids = new Set(list.map((t) => t[0]));
    for (const [id, t] of this.turrets) {
      if (ids.has(id) && t.paint === paintball.on) continue;
      t.m.g.removeFromParent();
      (t.m.eye.material as THREE.Material).dispose(); // its own (the eye's colour is each turret's); the rest is shared
      this.turrets.delete(id);
      if (!quiet && !ids.has(id)) this.onSpent(t.m.g.position.clone().setY(t.m.g.position.y + (TURRET_Y + 0.1) * TURRET_SIZE));
    }
    for (const [id, x, y, z, yaw] of list) {
      if (this.turrets.has(id)) continue;
      const m = turretModel(paintball.on);
      m.g.position.set(x, y, z);
      m.head.rotation.y = yaw;
      this.group.add(m.g);
      this.turrets.set(id, { m, set: yaw, aim: yaw, pitch: 0, born: this.clock, shotAt: -9, flashLeft: 0, rounds: LOOT.turretRounds, paint: paintball.on });
    }
  }

  /**
   * Turret `id` shot at a zombie at `at` (its chest; null when this page doesn't have it): it aims
   * there, flashes, and its eye shows the `rounds` left. Where its muzzle is, or null with no such turret.
   */
  fire(id: number, at: THREE.Vector3 | null, rounds: number): THREE.Vector3 | null {
    const t = this.turrets.get(id);
    if (!t) return null;
    const base = t.m.g.position;
    if (at) {
      t.aim = Math.atan2(-(at.x - base.x), -(at.z - base.z));
      t.pitch = Math.atan2(at.y - (base.y + (TURRET_Y + 0.13) * TURRET_SIZE), Math.hypot(at.x - base.x, at.z - base.z));
    }
    t.shotAt = this.clock;
    t.flashLeft = 0.06;
    t.rounds = rounds;
    t.m.flash.visible = true;
    t.m.flash.rotation.z = Math.random() * Math.PI;
    t.m.g.updateMatrixWorld(true);
    return t.m.tilt.localToWorld(MUZZLE.clone());
  }

  /** Row `id` was worn through: it bursts in splinters and is gone. */
  burst(id: number): void {
    const row = this.rows.get(id);
    if (!row) return;
    const ux = Math.cos(row.yaw), uz = -Math.sin(row.yaw);
    const points = row.stakes.map((s) => new THREE.Vector3(row.x + ux * s.u, 0, row.z + uz * s.u));
    for (const p of points) p.y = this.ground(p.x, p.z, row.y) + 0.35;
    woodSound(new THREE.Vector3(row.x, row.y, row.z), 'burst');
    this.onBurst(points);
    this.stakeBarrier(id, null);
    this.rows.delete(id);
    this.layStakes();
  }

  /** Every stake and rail where it is now (a tipping stake part of the way down). */
  private layStakes(): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const ALONG = new THREE.Vector3(1, 0, 0);
    let ns = 0;
    let nr = 0;
    this.tipping = false;
    for (const row of this.rows.values()) {
      const ux = Math.cos(row.yaw), uz = -Math.sin(row.yaw); // along the row
      const fx = -Math.sin(row.yaw), fz = -Math.cos(row.yaw); // its front, the way the stakes lean
      // A point on the ground `u` m along the row and `back` m behind its line (in front when negative).
      const foot = (u: number, back: number, out: THREE.Vector3) => {
        out.set(row.x + ux * u - fx * back, 0, row.z + uz * u - fz * back);
        out.y = this.ground(out.x, out.z, row.y);
        return out;
      };
      for (const s of row.stakes) {
        if (ns >= MAX_STAKES) break;
        const target = s.rank >= row.up ? 1 : 0;
        if (s.fall !== target) this.tipping = true;
        const f = s.fall * s.fall; // it goes slowly at first, then falls
        foot(s.u, FOOT, p);
        p.y += 0.05 * f; // lying, on the ground rather than half in it
        e.set(-(LEAN + (Math.PI / 2 - 0.06 - LEAN) * f), row.yaw + s.twist + s.fallTwist * f, 0);
        this.stakeMesh.setMatrixAt(ns++, m.compose(p, q.setFromEuler(e), one));
      }
      if (nr < LOOT.stakesAll) {
        // The rail: from just past the first stake to just past the last, at its height over the ground there.
        const p0 = foot(row.a - 0.15, RAIL_Z, new THREE.Vector3());
        const p1 = foot(row.b + 0.15, RAIL_Z, new THREE.Vector3());
        p0.y += RAIL_Y;
        p1.y += RAIL_Y;
        const dir = p1.clone().sub(p0);
        const len = dir.length();
        p.copy(p0).add(p1).multiplyScalar(0.5);
        this.railMesh.setMatrixAt(nr++, m.compose(p, q.setFromUnitVectors(ALONG, dir.normalize()), new THREE.Vector3(len, 1, 1)));
      }
    }
    this.stakeMesh.count = ns;
    this.railMesh.count = nr;
    for (const mesh of [this.stakeMesh, this.railMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere(); // the frustum test sees every row
    }
  }

  /** The items lying now ([id, kind, x, y, z]): new ones come, taken or gone ones go. */
  setItems(list: [number, LootKind, number, number, number][]): void {
    const ids = new Set(list.map((i) => i[0]));
    for (const [id, s] of this.items) {
      if (ids.has(id)) continue;
      s.g.removeFromParent();
      this.items.delete(id);
    }
    for (const [id, kind, x, y, z] of list) {
      if (this.items.has(id) || !COLORS[kind]) continue;
      const g = new THREE.Group();
      g.position.set(x, y, z);
      const ring = new THREE.Mesh(ringGeo, ringMats[kind]);
      ring.position.y = 0.03;
      const beam = new THREE.Mesh(beamGeo, beamMats[kind]);
      const icon = sign(kind);
      icon.position.y = 0.75;
      for (const o of [ring, beam]) o.userData.ignoreRay = true;
      g.add(ring, beam, icon);
      this.group.add(g);
      this.items.set(id, { kind, g, icon, beam, x, y, z, born: this.clock });
    }
  }

  /** The claymores down now ([id, x, y, z, yaw, owner]). */
  setMines(list: [number, number, number, number, number, string][]): void {
    const ids = new Set(list.map((m) => m[0]));
    for (const [id, m] of this.mines) {
      if (ids.has(id) && m.paint === paintball.on) continue;
      m.g.removeFromParent();
      this.mines.delete(id);
    }
    for (const [id, x, y, z, yaw] of list) {
      if (this.mines.has(id)) continue;
      const { g, led } = mineModel(paintball.on);
      g.position.set(x, y, z);
      g.rotation.y = yaw; // its front (-z) the way the player looked (the game's yaw)
      g.traverse((o) => (o.userData.ignoreRay = true));
      this.group.add(g);
      this.mines.set(id, { g, led, at: this.clock, paint: paintball.on });
    }
  }

  /** Mine `id` went off: it's gone (the blast is drawn by the caller). */
  boom(id: number): void {
    const m = this.mines.get(id);
    if (!m) return;
    m.g.removeFromParent();
    this.mines.delete(id);
  }

  clear(): void {
    this.setItems([]);
    this.setMines([]);
    this.setStakes([]);
    this.setTurrets([], true);
    this.setLulls([]);
  }

  /** The item within reach of your feet (the nearest), or -1. */
  near(x: number, feet: number, z: number): number {
    let best = -1;
    let bd = REACH;
    for (const [id, s] of this.items) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= bd && Math.abs(feet - s.y) < LOOT.rise - 0.2) [best, bd] = [id, d];
    }
    return best;
  }

  /** The items lying, for the minimap. */
  blips(): { x: number; y: number; z: number; color: string }[] {
    return [...this.items.values()].map((s) => ({ x: s.x, y: s.y, z: s.z, color: COLORS[s.kind] }));
  }

  /** Every frame: the signs turn and bob, the beams breathe, an armed claymore blinks, a worn stake tips over, a turret unfolds, aims and flashes. */
  update(dt: number): void {
    this.clock += dt;
    // The music boxes play their tune again and again; their dots glow with it.
    for (const l of this.lulls.values()) {
      if (this.clock < l.next) continue;
      l.next = this.clock + PHRASE_S;
      tune(l.at);
    }
    if (this.lulls.size) dotMat.opacity = 0.55 + 0.35 * Math.abs(Math.sin(this.clock * Math.PI / NOTE_S / 2));
    for (const t of this.turrets.values()) {
      // Unfolding: the head rises out of the hub, the barrel down; then it turns to where it shoots,
      // or, a while after its last shot, looks slowly round about the way it was set up.
      const up = Math.min(1, (this.clock - t.born) / (LOOT.turretArm / 1000));
      t.m.head.position.y = TURRET_Y + 0.06 - 0.12 * (1 - up);
      const idle = this.clock - t.shotAt > 1.5;
      const want = idle ? t.set + 0.6 * Math.sin((this.clock - t.born) * 0.7) : t.aim;
      const d = Math.atan2(Math.sin(want - t.m.head.rotation.y), Math.cos(want - t.m.head.rotation.y));
      const turn = (idle ? 0.8 : 7) * dt;
      t.m.head.rotation.y += Math.max(-turn, Math.min(turn, d));
      const pitch = up < 1 ? -0.5 * (1 - up) : idle ? 0 : t.pitch;
      t.m.tilt.rotation.x += (pitch - t.m.tilt.rotation.x) * Math.min(1, dt * 10);
      // The eye: green while it's full, amber past half, red at the last fifth (blinking once armed).
      const f = t.rounds / LOOT.turretRounds;
      const eye = t.m.eye.material as THREE.MeshBasicMaterial;
      eye.color.set(up < 1 ? '#3a0d0a' : f > 0.5 ? '#4cff6a' : f > 0.2 ? '#ffb030' : Math.floor(this.clock * 4) % 2 ? '#ff2a1a' : '#3a0d0a');
      if (t.flashLeft > 0) {
        t.flashLeft -= dt;
        if (t.flashLeft <= 0) t.m.flash.visible = false;
      }
    }
    if (this.tipping) {
      for (const row of this.rows.values()) {
        for (const s of row.stakes) {
          const target = s.rank >= row.up ? 1 : 0;
          s.fall = target > s.fall ? Math.min(1, s.fall + dt * 2.2) : Math.max(0, s.fall - dt * 2.2);
        }
      }
      this.layStakes();
    }
    let k = 0;
    for (const s of this.items.values()) {
      s.icon.rotation.y += dt * 1.6;
      s.icon.position.y = 0.75 + Math.sin(this.clock * 2.2 + k++) * 0.06;
      (s.beam.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.08 * Math.sin(this.clock * 3);
      const pop = Math.min(1, (this.clock - s.born) * 4); // grows in as it drops
      s.g.scale.setScalar(pop);
    }
    for (const m of this.mines.values()) {
      const armed = this.clock - m.at > LOOT.armMs / 1000;
      m.led.material = armed && Math.floor(this.clock * 2.5) % 2 === 0 ? mats.led : mats.ledOff;
    }
  }
}
