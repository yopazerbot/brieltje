import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WeaponId } from '../weapon';
import type { PlayerSample } from '../../shared/wire.mjs';
import { netClock, Track } from './track';
import { gunsReady } from '../weapon';
import { muzzleFlash } from '../world/effects';
import { buildSwat, hasSwat, SEAT_HIP, swatReady, type Body, type Outfit as SwatOutfit } from './swat';
import { onLang, t } from '../i18n';

/**
 * A player's part in a party game, shown on their figure for everyone: "it" in tag, a seeker in hide
 * and seek. A ring at the feet in the part's colour and its word above the head (behind walls it
 * hides, like the figure). One ring shape and one label picture per word, shared by all figures.
 */
export type Role = 'it' | 'seeker';
const ROLE_COLOR: Record<Role, string> = { it: '#ff5a4f', seeker: '#f2b33d' };
const ringGeo = new THREE.RingGeometry(0.45, 0.6, 32).rotateX(-Math.PI / 2);
const ringMat: Record<Role, THREE.MeshBasicMaterial> = {
  it: new THREE.MeshBasicMaterial({ color: ROLE_COLOR.it, transparent: true, opacity: 0.9, depthWrite: false }),
  seeker: new THREE.MeshBasicMaterial({ color: ROLE_COLOR.seeker, transparent: true, opacity: 0.9, depthWrite: false }),
};
const labels = new Map<string, THREE.SpriteMaterial>(); // role and word -> its picture

function roleLabel(role: Role): THREE.SpriteMaterial {
  const word = t(role === 'it' ? 'role.it' : 'role.seeker');
  const key = `${role}:${word}`;
  let mat = labels.get(key);
  if (mat) return mat;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 34px Bahnschrift, Arial Narrow, sans-serif';
  const w = Math.min(248, g.measureText(word.toUpperCase()).width + 36);
  g.fillStyle = ROLE_COLOR[role];
  g.beginPath();
  g.roundRect((256 - w) / 2, 6, w, 52, 10);
  g.fill();
  g.fillStyle = '#14161a';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(word.toUpperCase(), 128, 33);
  mat = new THREE.SpriteMaterial({ map: cropped(c, w + 2), transparent: true });
  mat.userData.width = (w + 2) / 256;
  labels.set(key, mat);
  return mat;
}

/**
 * Other players. Normally the rigged SWAT character (see swat.ts); if that
 * model can't be loaded, these block figures stand in.
 *
 * Block figures: masked fighters in tactical gear (balaclava, vest with
 * pouches, cargo trousers, boots), built from simple shapes, no downloads.
 * Each moving part is one mesh with its colours baked in, so a figure costs
 * only a few draw calls. The player's colour is on the neck scarf and armband.
 * Invisible hit boxes (head and body) catch bullets while they fight.
 */

interface Outfit {
  jacket: string;
  pants: string;
  vest: string;
  pouch: string;
  mask: string;
  gloves: string;
  boots: string;
  pads: string;
  glasses: boolean;
  beanie?: string;
}

const OUTFITS: Outfit[] = [
  { jacket: '#4b4c3b', pants: '#75674c', vest: '#2a2b25', pouch: '#3a3a30', mask: '#141414', gloves: '#1a1a1a', boots: '#1d1b18', pads: '#22231f', glasses: true },
  { jacket: '#5a4632', pants: '#3b3f47', vest: '#35312a', pouch: '#4a4335', mask: '#1f2620', gloves: '#2a241d', boots: '#2b2219', pads: '#2a2a28', glasses: false, beanie: '#2c3a2c' },
  { jacket: '#867756', pants: '#8f7f5d', vest: '#4d4636', pouch: '#5e5541', mask: '#2a2620', gloves: '#3a3226', boots: '#3b2f22', pads: '#4a4232', glasses: true },
  { jacket: '#2e3135', pants: '#4b4e54', vest: '#1c1d1f', pouch: '#2a2c2f', mask: '#0f0f10', gloves: '#141414', boots: '#121212', pads: '#1c1d1f', glasses: false, beanie: '#141414' },
];
// The server hands out these colours in order; each gets its own outfit, so everyone sees the same one.
const COLORS = ['#f2b33d', '#4fa3e0', '#e0614f', '#5cc28a'];
const SKIN = '#b5876a';
/** The SWAT suit recoloured per player colour: olive, brown, desert, black. */
const SWAT_OUTFITS: SwatOutfit[] = [
  { main: '#4b4c3b', dark: '#25261f' },
  { main: '#5a4632', dark: '#2a241d' },
  { main: '#8a7a5a', dark: '#4a4232' },
  { main: '#3a3d42', dark: '#121212' },
];
const GUN = '#1d1e21';

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
const headBox = new THREE.SphereGeometry(0.15, 8, 6);
const bodyBox = new THREE.BoxGeometry(0.5, 1.45, 0.42);
const UP = new THREE.Vector3(0, 1, 0);
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A shape in one colour, moved into place. */
function part(geo: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g.translate(x, y, z);
}

/** A rounded arm or leg segment from a to b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r: number, color: string): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const g = new THREE.CapsuleGeometry(r, Math.max(0.001, dir.length()), 3, 8);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return part(g, color, mid.x, mid.y, mid.z);
}

function mesh(parts: THREE.BufferGeometry[]): THREE.Mesh {
  const m = new THREE.Mesh(mergeGeometries(parts), material);
  m.castShadow = true;
  m.userData.ignoreRay = true;
  return m;
}

function nameTag(name: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 30px Bahnschrift, Arial Narrow, sans-serif';
  const w = Math.min(248, g.measureText(name).width + 28);
  g.fillStyle = 'rgba(12,14,18,0.75)';
  g.fillRect((256 - w) / 2, 8, w, 46);
  g.fillStyle = color;
  g.fillRect((256 - w) / 2, 8, 5, 46);
  g.fillStyle = '#f4efe6';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, 128, 32);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: cropped(c, w + 2), depthTest: false, transparent: true }));
  s.userData.width = (w + 2) / 256; // the share of the picture the box takes: the sprite is only that wide
  s.scale.set(0.9 * s.userData.width, 0.225, 1);
  s.renderOrder = 10;
  s.userData.ignoreRay = true;
  return s;
}

/** A label's picture, cut to the box in its middle (`w` of 256 px wide): no see-through pixels drawn beside it. */
function cropped(c: HTMLCanvasElement, w: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.repeat.set(w / 256, 1);
  tex.offset.set((256 - w) / 512, 0);
  return tex;
}


/** Feet at y = 0, facing -z (the way the camera looks at yaw 0). */
function buildFigure(name: string, color: string, o: Outfit): Body {
  const pose = new THREE.Group(); // tips over when the player dies

  pose.add(mesh([
    part(new THREE.BoxGeometry(0.34, 0.16, 0.22), o.pants, 0, 0.9, 0),
    part(new THREE.BoxGeometry(0.36, 0.06, 0.235), '#1a1a18', 0, 0.98, 0), // belt
    part(new RoundedBoxGeometry(0.42, 0.5, 0.24, 2, 0.07), o.jacket, 0, 1.24, 0),
    part(new RoundedBoxGeometry(0.44, 0.34, 0.29, 2, 0.05), o.vest, 0, 1.27, 0),
    ...[-0.11, 0, 0.11].map((x) => part(new RoundedBoxGeometry(0.085, 0.12, 0.05, 1, 0.015), o.pouch, x, 1.18, -0.155)),
    part(new RoundedBoxGeometry(0.3, 0.2, 0.06, 1, 0.02), o.pouch, 0, 1.22, 0.16), // back pack
    part(new THREE.CylinderGeometry(0.055, 0.06, 0.1, 10), o.mask, 0, 1.52, 0),
    part(new THREE.CylinderGeometry(0.085, 0.095, 0.07, 12), color, 0, 1.49, 0), // scarf
  ]));

  const head = new THREE.Group();
  head.position.y = 1.55;
  const headParts = [
    part(new THREE.SphereGeometry(0.115, 16, 12).scale(1, 1.1, 1.05), o.mask, 0, 0.11, 0),
    part(new THREE.BoxGeometry(0.16, 0.055, 0.05), SKIN, 0, 0.125, -0.098), // eye slit in the balaclava
  ];
  if (o.glasses) {
    // Tactical goggles: two tinted lenses on a strap, skin showing around them.
    for (const x of [-0.04, 0.04]) headParts.push(part(new RoundedBoxGeometry(0.064, 0.036, 0.03, 1, 0.01), '#33465a', x, 0.127, -0.124));
    headParts.push(part(new THREE.BoxGeometry(0.02, 0.012, 0.02), '#111316', 0, 0.13, -0.126));
    headParts.push(part(new THREE.CylinderGeometry(0.121, 0.121, 0.016, 18, 1, true), '#111316', 0, 0.13, 0));
  }
  if (o.beanie) headParts.push(part(new THREE.SphereGeometry(0.124, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.95, 1.06), o.beanie, 0, 0.14, 0));
  head.add(mesh(headParts));
  const hitHead = new THREE.Mesh(headBox, hitMaterial);
  hitHead.position.y = 0.11;
  hitHead.userData = { player: name, part: 'head' };
  head.add(hitHead);
  pose.add(head);

  // Armed: both hands on a pistol in front of the chest; this group follows where they look.
  const aim = new THREE.Group();
  aim.position.y = 1.42;
  const rS = v(0.2, 0, 0), rE = v(0.2, -0.2, -0.17), rH = v(0.05, -0.1, -0.4);
  const lS = v(-0.2, 0, 0), lE = v(-0.19, -0.22, -0.15), lH = v(-0.01, -0.12, -0.39);
  aim.add(mesh([
    part(new THREE.SphereGeometry(0.075, 10, 8), o.jacket, 0.2, 0, 0),
    part(new THREE.SphereGeometry(0.075, 10, 8), o.jacket, -0.2, 0, 0),
    limb(rS, rE, 0.055, o.jacket), limb(rE, rH, 0.047, o.jacket),
    limb(lS, lE, 0.055, o.jacket), limb(lE, lH, 0.047, o.jacket),
    limb(lS.clone().lerp(lE, 0.35), lS.clone().lerp(lE, 0.6), 0.061, color), // armband
    part(new THREE.SphereGeometry(0.045, 10, 8), o.gloves, rH.x, rH.y, rH.z),
    part(new THREE.SphereGeometry(0.045, 10, 8), o.gloves, lH.x, lH.y, lH.z),
    part(new THREE.BoxGeometry(0.035, 0.045, 0.2), GUN, 0.02, -0.07, -0.5),
    part(new THREE.BoxGeometry(0.03, 0.09, 0.04), GUN, 0.02, -0.115, -0.43),
  ]));
  const flash = muzzleFlash(0.2);
  flash.position.set(0.02, -0.07, -0.6);
  aim.add(flash);
  pose.add(aim);

  // Unarmed (Explore mode): arms hang and swing while walking.
  const hang = [-1, 1].map((side) => {
    const g = new THREE.Group();
    g.position.set(side * 0.2, 1.42, 0);
    const elbow = v(side * 0.03, -0.27, 0.02);
    const hand = v(side * 0.04, -0.52, -0.04);
    const parts = [
      part(new THREE.SphereGeometry(0.075, 10, 8), o.jacket),
      limb(v(0, 0, 0), elbow, 0.055, o.jacket),
      limb(elbow, hand, 0.047, o.jacket),
      part(new THREE.SphereGeometry(0.045, 10, 8), o.gloves, hand.x, hand.y, hand.z),
    ];
    if (side < 0) parts.push(limb(v(0, 0, 0).lerp(elbow, 0.35), v(0, 0, 0).lerp(elbow, 0.6), 0.061, color));
    g.add(mesh(parts));
    pose.add(g);
    return g;
  }) as [THREE.Group, THREE.Group];

  const legs = [-1, 1].map((side) => {
    const g = new THREE.Group();
    g.position.set(side * 0.1, 0.92, 0);
    g.add(mesh([
      limb(v(0, 0, 0), v(0, -0.78, 0), 0.075, o.pants),
      part(new RoundedBoxGeometry(0.11, 0.1, 0.04, 1, 0.015), o.pads, 0, -0.42, -0.07), // knee pad
      part(new THREE.BoxGeometry(0.035, 0.13, 0.11), o.pouch, side * 0.08, -0.26, 0), // cargo pocket
      part(new RoundedBoxGeometry(0.13, 0.13, 0.28, 1, 0.03), o.boots, 0, -0.855, -0.04),
    ]));
    pose.add(g);
    return g;
  }) as [THREE.Group, THREE.Group];

  const hitBody = new THREE.Mesh(bodyBox, hitMaterial);
  hitBody.position.y = 0.73;
  hitBody.userData = { player: name, part: 'body' };
  pose.add(hitBody);

  let fall = 0;
  let phase = 0;
  let flashTime = 0;
  return {
    root: pose,
    hits: [hitHead, hitBody],
    flash() {
      flashTime = 0.06;
      flash.fire();
      return flash.getWorldPosition(new THREE.Vector3());
    },
    animate(dt, p) {
      fall = p.alive ? 0 : Math.min(1, fall + dt * 2.6);
      const ease = 1 - (1 - fall) * (1 - fall);
      pose.rotation.x = (ease * Math.PI) / 2; // falls on their back
      pose.position.y = ease * 0.13;
      pose.scale.y += ((p.crouch && p.alive ? 0.72 : 1) - pose.scale.y) * Math.min(1, dt * 12);
      // Walking: legs swing with the speed; arms swing too when no weapon is held.
      const stride = p.flying ? 0 : Math.min(1, p.speed / 1.6);
      phase += (p.speed / (0.65 + 0.15 * p.speed)) * Math.PI * dt;
      const swing = Math.sin(phase) * 0.55 * stride;
      legs[0].rotation.x = p.flying ? 0.3 : swing;
      legs[1].rotation.x = p.flying ? 0.12 : -swing;
      aim.visible = p.armed;
      hang[0].visible = hang[1].visible = !p.armed;
      hang[0].rotation.x = -swing * 0.7;
      hang[1].rotation.x = swing * 0.7;
      const pitch = Math.max(-0.9, Math.min(0.9, p.pitch));
      aim.rotation.x = p.alive ? pitch : 0;
      head.rotation.x = p.alive ? pitch * 0.6 : 0;
      flashTime -= dt;
      flash.visible = flashTime > 0;
    },
  };
}

/**
 * A soft dark patch on the ground under each figure: away from the house the sun's real-time
 * shadow isn't worked out, and without it a figure seems to float. One draw for all of them.
 */
function shadowPatches(n: number): THREE.InstancedMesh {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshBasicMaterial({ color: '#000000', alphaMap: tex, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, n);
  mesh.count = 0;
  mesh.frustumCulled = false; // spread over the map: one draw, a few pixels each
  mesh.renderOrder = 1;
  mesh.userData.ignoreRay = true;
  mesh.raycast = () => {};
  return mesh;
}

/** A seat on a horse someone rides: the saddle's point and the way the horse faces (+z at 0). */
export interface Seat {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Avatar {
  body: Body;
  color: string;
  root: THREE.Group;
  tag: THREE.Sprite;
  /** Their states from the ticks, drawn a little behind (see track.ts) */
  track: Track<PlayerSample>;
  /** The newest state: whether they can be hit, whether they are in a car */
  latest: PlayerSample | null;
  /** Shown falling at once when killed, before their states say so */
  killed: boolean;
  /** Respawned or through a portal: hidden until a state from their new place (its teleport counter then) comes, or a moment has passed */
  hiddenWarp: number | null;
  hiddenAt: number;
  /** Their part in a party game, its ring and its word (see Role) */
  role: Role | null;
  marks: THREE.Object3D[];
  speed: number;
  forward: number;
  side: number;
  steps: number;
  /** Where their states put them last frame (the figure may stand a little aside, see `push`) */
  x: number;
  y: number;
  z: number;
  vy: number;
  /** How far the figure stands aside so it isn't inside another one (m; only drawn, never sent) */
  push: THREE.Vector2;
  want: THREE.Vector2;
}

const ANGLES = [false, false, false, true, true] as const; // x, y, z, yaw, pitch
const JUMP = 60; // m between two states: a teleport (the admin's turbo covers 12 m in one)
const APART = 0.6; // m: two figures closer than this are drawn nudged apart
const MAX_PUSH = 0.35; // m the most a figure is drawn aside

export class Avatars {
  /** Names above players: the admin can turn them off (they show through walls). */
  showNames = true;
  readonly group = new THREE.Group();
  /** A footstep of another player at their feet (speed in m/s) */
  onStep: (name: string, at: THREE.Vector3, speed: number) => void = () => {};
  /** The height of the ground under a point (m), looking down from `y`: for jumps, falls and the shadow patch. */
  groundAt: ((x: number, z: number, y: number) => number) | null = null;
  /** The saddle of the horse a player rides (drawn this frame), or null on foot. */
  seatOf: ((name: string) => Seat | null) | null = null;
  private avatars = new Map<string, Avatar>();
  private pose = [0, 0, 0, 0, 0];
  private shadows = shadowPatches(16);
  private m = new THREE.Matrix4();

  constructor() {
    this.group.add(this.shadows);
    // Players who joined before the character and gun models finished loading get them now.
    void Promise.all([swatReady, gunsReady]).then(() => {
      for (const [name, a] of [...this.avatars]) this.rebuild(name, a, a.color);
    });
    // Another language: the parts' words again.
    onLang(() => {
      for (const [name, a] of this.avatars) {
        const role = a.role;
        this.setRole(name, null);
        this.setRole(name, role);
      }
    });
  }

  /** A player's part in a party game (null: none): its ring and word on their figure. */
  setRole(name: string, role: Role | null): void {
    const a = this.avatars.get(name);
    if (!a || a.role === role) return;
    for (const m of a.marks) m.removeFromParent();
    a.marks = [];
    a.role = role;
    if (!role) return;
    const ring = new THREE.Mesh(ringGeo, ringMat[role]);
    ring.position.y = 0.04;
    ring.renderOrder = 2;
    const label = new THREE.Sprite(roleLabel(role));
    label.position.y = 2.32;
    label.scale.set(0.8 * label.material.userData.width, 0.2, 1);
    for (const m of [ring, label]) {
      m.userData.ignoreRay = true;
      a.root.add(m);
    }
    a.marks = [ring, label];
  }

  add(name: string, color: string): void {
    if (this.avatars.has(name)) return;
    const i = COLORS.indexOf(color);
    const k = i >= 0 ? i : [...name].reduce((h, c) => h + c.charCodeAt(0), 0) % OUTFITS.length;
    const body = hasSwat() ? buildSwat(name, color, SWAT_OUTFITS[k], hitMaterial, headBox, bodyBox) : buildFigure(name, color, OUTFITS[k]);
    const root = new THREE.Group();
    root.userData.figure = true; // paintball's paint sticks on the body inside the hit boxes (weapon.ts)
    const tag = nameTag(name, color);
    tag.position.y = 2.0;
    root.add(body.root, tag);
    root.visible = false;
    for (const h of body.hits) h.visible = false; // until their first position arrives
    this.group.add(root);
    this.avatars.set(name, {
      body, color, root, tag, track: new Track<PlayerSample>(ANGLES, JUMP), latest: null, killed: false, hiddenWarp: null, hiddenAt: 0,
      role: null, marks: [], speed: 0, forward: 0, side: 0, steps: 0, x: NaN, y: 0, z: 0, vy: 0, push: new THREE.Vector2(), want: new THREE.Vector2(),
    });
  }

  /** A new figure for a player (their colour changed, or the models came in), keeping where they are. */
  private rebuild(name: string, a: Avatar, color: string): void {
    this.remove(name);
    this.add(name, color);
    const b = this.avatars.get(name)!;
    Object.assign(b, { track: a.track, latest: a.latest, killed: a.killed, hiddenWarp: a.hiddenWarp, hiddenAt: a.hiddenAt });
    b.root.visible = a.root.visible;
    this.setRole(name, a.role);
  }

  /** A player's colour changed (a team's in the teams game): the outfit that goes with it. */
  recolor(name: string, color: string): void {
    const a = this.avatars.get(name);
    if (a && a.color !== color) this.rebuild(name, a, color);
  }

  remove(name: string): void {
    const a = this.avatars.get(name);
    if (!a) return;
    for (const m of a.marks) m.removeFromParent(); // their ring shape is shared: not disposed below
    a.root.removeFromParent();
    a.body.dispose?.();
    // Block figures own their geometry; SWAT clones share the model's.
    if (!a.body.shared) {
      a.root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry !== headBox && o.geometry !== bodyBox) o.geometry.dispose();
      });
    }
    this.avatars.delete(name);
  }

  clear(): void {
    for (const name of [...this.avatars.keys()]) this.remove(name);
  }

  /** States from a tick taken at the server's time `st` (each `age` ms before it). */
  receive(states: PlayerSample[], st: number, self: string): void {
    const now = performance.now();
    for (const s of states) {
      if (s.name === self) continue;
      const a = this.avatars.get(s.name);
      if (!a) continue;
      // The server moved them (respawn, portal): jump there instead of sliding across the map.
      const warped = !!a.latest && s.warp !== a.latest.warp;
      a.track.push(st - s.age, [s.x, s.y, s.z, s.yaw, s.pitch], s, warped);
      if (warped) a.killed = false; // back in the game
      if (a.hiddenWarp !== null && (s.warp !== a.hiddenWarp || now - a.hiddenAt > 1500)) a.hiddenWarp = null;
      a.latest = s;
    }
  }

  /** Show a player dying right away (their next states confirm it). */
  kill(name: string): void {
    const a = this.avatars.get(name);
    if (a) a.killed = true;
  }

  /** A player respawned or went through a portal: hide them until a state from their new place arrives. */
  respawn(name: string): void {
    const a = this.avatars.get(name);
    if (!a) return;
    a.hiddenWarp = a.latest?.warp ?? -1;
    a.hiddenAt = performance.now();
    a.root.visible = false;
  }

  /** Muzzle flash when another player fires; returns where the muzzle is (for its smoke). */
  flash(name: string): THREE.Vector3 | null {
    const a = this.avatars.get(name);
    return a?.root.visible ? a.body.flash() : null;
  }

  /** A player was hit by one of your shots: they flinch. */
  flinch(name: string): void {
    this.avatars.get(name)?.body.flinch?.();
  }

  /** Can this player be shot right now (fighting, alive, not just respawned, not in the car)? */
  canBeHit(name: string): boolean {
    const a = this.avatars.get(name);
    const s = a?.latest;
    return !!s && s.armed && s.alive && !a.killed && !s.safe && !s.d;
  }

  /** Players on foot, for the car to stop against. */
  obstacles(): { x: number; z: number; r: number }[] {
    return [...this.avatars.values()].filter((a) => a.root.visible && a.latest && !a.latest.d && a.latest.alive).map((a) => ({ x: a.root.position.x, z: a.root.position.z, r: 0.3 }));
  }

  /**
   * Every frame: each figure where its states put it at the drawing time (see track.ts), animated.
   * `eye`: the camera, for how much detail each figure gets and how big its name is drawn;
   * `me`: where you stand on foot, so a figure you walk into steps aside rather than wrap round you.
   */
  tick(dt: number, eye?: THREE.Vector3, me?: { x: number; z: number } | null): void {
    const now = performance.now();
    const p = this.pose;
    const k = 1 - Math.exp(-dt * 10);
    const walkers: Avatar[] = [];
    let patches = 0;
    for (const [name, a] of this.avatars) {
      if (!a.track.at(netClock.time, p) || !a.track.shown) continue;
      const t = a.track.shown;
      const [x, y, z, yaw, pitch] = p;
      if (a.hiddenWarp === null) a.root.visible = true;
      // Velocity, and how much of it is forwards and sideways (for walk, strafe and run-back animations),
      // from where their states put them (a teleport or the first state isn't a run).
      const jumped = Number.isNaN(a.x) || Math.hypot(x - a.x, z - a.z) > 3;
      const vx = jumped ? 0 : (x - a.x) / Math.max(dt, 1e-3);
      const vz = jumped ? 0 : (z - a.z) / Math.max(dt, 1e-3);
      const vy = jumped ? 0 : (y - a.y) / Math.max(dt, 1e-3);
      a.x = x;
      a.y = y;
      a.z = z;
      a.speed += (Math.min(Math.hypot(vx, vz), 8) - a.speed) * k;
      a.forward += (-vx * Math.sin(yaw) - vz * Math.cos(yaw) - a.forward) * k;
      a.side += (vx * Math.cos(yaw) - vz * Math.sin(yaw) - a.side) * k;
      a.vy += (Math.max(-20, Math.min(20, vy)) - a.vy) * Math.min(1, k * 2);
      const alive = t.alive && !a.killed;
      const far = eye ? Math.hypot(x - eye.x, y - eye.y, z - eye.z) : 0;
      // The ground under them: for jumps and falls, and for their shadow patch (only near enough to see).
      const ground = this.groundAt && !t.d && far < 80 ? this.groundAt(x, z, y) : y;
      // On a horse: in its saddle as it is drawn (it bounces and rocks), facing its way.
      const seat = alive && !t.d && this.seatOf ? this.seatOf(name) : null;
      if (seat) a.root.position.set(seat.x, seat.y - SEAT_HIP, seat.z);
      else a.root.position.set(x + a.push.x, y, z + a.push.y);
      a.root.rotation.y = yaw;
      a.body.animate(dt, {
        speed: a.speed, forward: a.forward, side: a.side, armed: t.armed, alive, crouch: t.c && !seat, flying: t.flying,
        pitch, weapon: t.w as WeaponId, yaw, air: Math.max(0, y - ground), vy: a.vy, seat: seat ? seat.yaw + Math.PI : null, far,
      });

      // A footstep as each foot comes down (the block figures: one per stride, about 0.85 m walking, 1.2 m running).
      let step = false;
      if (a.body.footfall !== undefined) step = a.body.footfall;
      else {
        a.steps += (a.speed / (0.65 + 0.15 * a.speed)) * dt;
        if (a.steps >= 1) {
          a.steps = 0;
          step = true;
        }
      }
      if (step && alive && !t.flying && !t.d && !seat && a.speed > 0.6 && a.root.visible) this.onStep(name, a.root.position, a.speed);

      // Just respawned: blink while they can't be hurt. In the car only their name shows, above it.
      a.body.root.visible = !t.d && (!(t.safe && alive) || Math.floor(now / 120) % 2 === 0);
      a.tag.visible = alive && this.showNames;
      for (const m of a.marks) m.visible = alive; // the part shows also when names are off (hide and seek)
      for (const h of a.body.hits) h.visible = alive && t.armed && !t.d && a.root.visible;
      // The name keeps a readable size on screen (about a thirtieth of its height) from 4.5 m out
      // to 45 m, then shrinks; always over the head.
      const size = Math.min(10, Math.max(1, far / 4.5));
      const low = (a.body.crouched ?? 0) * 0.42;
      a.tag.scale.set(0.9 * size * a.tag.userData.width, 0.225 * size, 1);
      a.tag.position.y = 1.9 + 0.12 * size - low;
      const label = a.marks[1] as THREE.Sprite | undefined;
      if (label) {
        label.scale.set(0.8 * size * label.material.userData.width, 0.2 * size, 1);
        label.position.y = a.tag.position.y + 0.25 * size;
      }
      // Their shadow patch, on the ground under them: smaller and fainter the higher they are.
      const air = Math.max(0, y - ground);
      if (a.root.visible && a.body.root.visible && !seat && air < 2.5 && far < 80 && patches < this.shadows.instanceMatrix.count) {
        const s = (alive ? 0.85 : 1.25) * (1 - air / 3.2);
        this.m.makeScale(s, 1, s).setPosition(a.root.position.x, ground + 0.03, a.root.position.z);
        this.shadows.setMatrixAt(patches++, this.m);
      }
      if (alive && !t.d && !seat && !t.flying && a.root.visible) walkers.push(a);
      else if (!alive) a.want.copy(a.push); // fallen: lies where they fell
      else a.want.set(0, 0);
    }
    this.shadows.count = patches;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.apart(walkers, dt, me);
  }

  /**
   * Figures standing in one another are drawn nudged apart (and one you walk into steps aside): a
   * crowd at a door looks like people, not one body with eight heads. Only the drawing moves: their
   * states, and where the server has them, stay as they are; nobody is blocked.
   */
  private apart(walkers: Avatar[], dt: number, me?: { x: number; z: number } | null): void {
    for (const a of walkers) a.want.set(0, 0);
    for (let i = 0; i < walkers.length; i++) {
      const a = walkers[i];
      for (let j = i + 1; j < walkers.length; j++) {
        const b = walkers[j];
        if (Math.abs(a.y - b.y) > 1.2) continue; // on another floor
        let dx = a.x - b.x;
        let dz = a.z - b.z;
        let d = Math.hypot(dx, dz);
        if (d >= APART) continue;
        const each = (APART - d) / 2;
        if (d < 1e-3) [dx, dz, d] = [Math.cos(i * 2.4), Math.sin(i * 2.4), 1]; // on the very same spot: some way apart
        const f = each / d;
        a.want.x += dx * f;
        a.want.y += dz * f;
        b.want.x -= dx * f;
        b.want.y -= dz * f;
      }
      if (me) {
        const dx = a.x - me.x;
        const dz = a.z - me.z;
        const d = Math.hypot(dx, dz);
        if (d < APART && d > 1e-3) {
          a.want.x += (dx / d) * (APART - d);
          a.want.y += (dz / d) * (APART - d);
        }
      }
    }
    const k = 1 - Math.exp(-dt * 6);
    for (const a of this.avatars.values()) {
      if (a.want.length() > MAX_PUSH) a.want.setLength(MAX_PUSH);
      const before = a.push.clone();
      a.push.lerp(a.want, k);
      if (walkers.includes(a)) {
        a.root.position.x += a.push.x - before.x;
        a.root.position.z += a.push.y - before.y;
      }
    }
  }

  /** Everyone visible, for the minimap. */
  blips(): { x: number; y: number; z: number; color: string }[] {
    return [...this.avatars.values()].filter((a) => a.root.visible && a.latest?.alive !== false).map((a) => ({ ...a.root.position, color: a.color }));
  }

  /** The other players you can see, by name: the big map. */
  marks(): { name: string; x: number; z: number; color: string }[] {
    return [...this.avatars.entries()].filter(([, a]) => a.root.visible && a.latest?.alive !== false).map(([name, a]) => ({ name, x: a.root.position.x, z: a.root.position.z, color: a.color }));
  }

  position(name: string): THREE.Vector3 | null {
    const a = this.avatars.get(name);
    return a?.root.visible ? a.root.position : null;
  }
}
