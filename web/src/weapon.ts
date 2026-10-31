import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sound } from './sound';
import { muzzleFlash } from './world/effects';
import WEAPONS from '../shared/weapons.json';
import { t } from './i18n';

/**
 * "Action" mode: first-person hands holding a pistol, rifle, shotgun or
 * sniper rifle, like Counter-Strike. Everything is built from simple shapes
 * (no downloads). The pistol is always there; the others are picked up in
 * the house. Shots leave bullet holes and dust or sparks (effects.ts) and
 * throw out a casing; magazines drop out when reloading; the shotgun pumps
 * and the sniper rifle works its bolt. The gun moves like it has weight: it
 * lags behind when you turn, tilts when you step sideways, dips when you
 * land, is carried low while sprinting and springs back after each shot.
 * The guns themselves are CC0 models by Quaternius (poly.pizza); until they
 * have loaded (or if they can't), simple block guns stand in.
 * The models sit within 20 cm of the camera, closer than any wall can get
 * (the player is 25 cm wide), so they never poke through walls.
 */

export type WeaponId = 'pistol' | 'rifle' | 'shotgun' | 'sniper' | 'bazooka';
interface Spec {
  name: string;
  slot: number;
  mag: number;
  delay: number;
  auto: boolean;
  reload: number;
  body: number;
  head: number;
  pellets: number;
  spread: number;
  hipSpread?: number;
  kick: number;
  zoom: number;
  /** Only the admin carries it (and anyone playing alone) */
  admin?: boolean;
  /** A rocket instead of bullets: m/s, blast radius (m), damage at the centre, range (m) */
  rocket?: { speed: number; radius: number; damage: number; range: number };
}
export const SPECS = WEAPONS as Record<WeaponId, Spec>;
export const WEAPON_IDS = Object.keys(SPECS) as WeaponId[];

/** Real length of each gun in metres (the models are scaled to it). */
const GUN_LENGTH: Record<WeaponId, number> = { pistol: 0.24, rifle: 0.95, shotgun: 1.0, sniper: 1.2, bazooka: 1.2 };
/** From the highest point of each model down to its line of sight (the scope's middle). */
const SIGHT_DROP: Record<WeaponId, number> = { pistol: 0, rifle: 0, shotgun: 0, sniper: 0.024, bazooka: 0 };
/** Muzzle flash length per gun, in metres. */
const FLASH: Record<WeaponId, number> = { pistol: 0.16, rifle: 0.26, shotgun: 0.34, sniper: 0.32, bazooka: 0.45 };
/**
 * Finish per material of the gun models: metalness, roughness and how much lighter the
 * colour gets. The models come nearly black and half metallic, which reads as flat plastic;
 * real gun metal reflects the sky.
 */
const FINISH: Record<string, [number, number, number]> = {
  Metal: [0.85, 0.34, 2.2], LightMetal: [0.85, 0.3, 2.0], DarkMetal: [0.8, 0.4, 2.2], Grey: [0.6, 0.4, 1.8],
  Main: [0.7, 0.4, 2.4], MainLight: [0.75, 0.35, 2.2], MainDark: [0.6, 0.45, 2.0],
  Black: [0.15, 0.55, 1.4], Green: [0.05, 0.65, 1.2], Wood: [0, 0.55, 1.3], DarkWood: [0, 0.6, 1.3], Glass: [0.9, 0.05, 3],
};
const loadedGuns = new Map<WeaponId, THREE.Group>();

/**
 * The gun models, turned so the barrel points along -z with the grip at the
 * origin (the models have the barrel along +x, up +y, origin at the grip).
 */
export const gunsReady: Promise<boolean> = Promise.all(
  (['pistol', 'rifle', 'shotgun', 'sniper'] as WeaponId[]).map(async (w) => {
    const gltf = await new GLTFLoader().loadAsync(`/models/guns/${w}.glb`);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const s = GUN_LENGTH[w] / (box.max.x - box.min.x);
    gltf.scene.scale.setScalar(s);
    gltf.scene.rotation.y = Math.PI / 2;
    const holder = new THREE.Group();
    holder.add(gltf.scene);
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, ((box.min.y + box.max.y) / 2) * s, -box.max.x * s);
    holder.add(muzzle);
    holder.traverse((o) => {
      o.userData.ignoreRay = true;
      o.castShadow = true;
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const f = FINISH[m.name];
        if (!f || !(m instanceof THREE.MeshStandardMaterial) || m.userData.finished) continue;
        m.metalness = f[0];
        m.roughness = f[1];
        m.color.multiplyScalar(f[2]);
        m.userData.finished = true;
      }
    });
    loadedGuns.set(w, holder);
  }),
).then(
  () => true,
  () => false,
);

const skin = new THREE.MeshStandardMaterial({ color: '#c99a7b', roughness: 0.7 });
const sleeve = new THREE.MeshStandardMaterial({ color: '#2d3436', roughness: 0.9 });
const glove = new THREE.MeshStandardMaterial({ color: '#1e1f22', roughness: 0.8 });
const metal = new THREE.MeshStandardMaterial({ color: '#2b2d31', roughness: 0.35, metalness: 0.75 });
const dark = new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.9 });
const wood = new THREE.MeshStandardMaterial({ color: '#7a4a2a', roughness: 0.6 });
const olive = new THREE.MeshStandardMaterial({ color: '#4a4d3a', roughness: 0.8 });
const lens = new THREE.MeshStandardMaterial({ color: '#1f3b52', roughness: 0.1, metalness: 0.5 });
const UP = new THREE.Vector3(0, 1, 0);

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/** A cylinder along -z from z0 to z1. */
function tube(r: number, z0: number, z1: number, mat: THREE.Material, x: number, y: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.abs(z1 - z0), 12), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, (z0 + z1) / 2);
  return m;
}

/** A limb from a to b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const dir = b.clone().sub(a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r, dir.length(), 10), mat);
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  m.position.copy(a).add(b).multiplyScalar(0.5);
  return m;
}

interface ViewModel {
  root: THREE.Group;
  gun: THREE.Group;
  muzzle: THREE.Object3D;
  flash: ReturnType<typeof muzzleFlash>;
  mag?: THREE.Object3D;
  pump?: THREE.Object3D;
  bolt?: THREE.Object3D;
  hip: THREE.Vector3;
  ads: THREE.Vector3;
}

/** Gun plus two arms, in metres at real size (scaled down near the camera later). */
function buildViewModel(id: WeaponId): ViewModel {
  const root = new THREE.Group();
  const gun = new THREE.Group();
  const muzzle = new THREE.Object3D();
  let mag: THREE.Object3D | undefined;
  let pump: THREE.Object3D | undefined;
  let bolt: THREE.Object3D | undefined;
  let leftHand = new THREE.Vector3(-0.02, -0.07, -0.03);
  let hip = new THREE.Vector3(0.055, -0.06, -0.12);
  let ads = new THREE.Vector3(0, -0.014, -0.1);
  const grip = box(0.028, 0.11, 0.045, dark, 0, -0.045, -0.015);

  if (id === 'pistol') {
    gun.add(box(0.032, 0.03, 0.19, metal, 0, 0.035, -0.095), box(0.03, 0.02, 0.17, metal, 0, 0.012, -0.09), grip);
    gun.add(box(0.012, 0.012, 0.02, metal, 0, 0.056, -0.18), box(0.026, 0.01, 0.012, metal, 0, 0.056, -0.012));
    gun.add(box(0.006, 0.025, 0.05, metal, 0, -0.008, -0.055));
    mag = box(0.022, 0.09, 0.035, metal, 0, -0.06, -0.015);
    muzzle.position.set(0, 0.035, -0.2);
  } else if (id === 'rifle') {
    gun.add(box(0.05, 0.075, 0.32, metal, 0, 0.02, -0.12), grip, tube(0.012, -0.28, -0.66, metal, 0, 0.035));
    gun.add(box(0.055, 0.06, 0.22, wood, 0, 0.012, -0.38), box(0.04, 0.075, 0.26, wood, 0, -0.005, 0.17));
    gun.add(box(0.01, 0.04, 0.012, metal, 0, 0.065, -0.62), box(0.03, 0.015, 0.03, metal, 0, 0.065, -0.05));
    mag = box(0.035, 0.17, 0.06, dark, 0, -0.1, -0.2);
    mag.rotation.x = 0.28;
    muzzle.position.set(0, 0.035, -0.67);
    leftHand = new THREE.Vector3(0, -0.035, -0.38);
    hip = new THREE.Vector3(0.06, -0.068, -0.12);
    ads = new THREE.Vector3(0, -0.017, -0.095);
  } else if (id === 'shotgun') {
    gun.add(box(0.05, 0.07, 0.24, metal, 0, 0.02, -0.08), grip, tube(0.015, -0.2, -0.72, metal, 0, 0.04));
    gun.add(tube(0.012, -0.2, -0.62, metal, 0, 0.012), box(0.042, 0.08, 0.3, wood, 0, -0.005, 0.18));
    pump = box(0.06, 0.05, 0.15, wood, 0, 0.0, -0.46);
    gun.add(pump);
    muzzle.position.set(0, 0.04, -0.73);
    leftHand = new THREE.Vector3(0, -0.035, -0.46);
    hip = new THREE.Vector3(0.06, -0.07, -0.12);
    ads = new THREE.Vector3(0, -0.02, -0.1);
  } else if (id === 'bazooka') {
    // Shoulder-fired tube: olive green, flared at the back, a grip, and the sight on the left of
    // the tube so you aim past it (the aiming position centres on the sight).
    gun.add(tube(0.055, 0.42, -0.78, olive, 0, 0.06), tube(0.068, 0.36, 0.5, dark, 0, 0.06), tube(0.062, -0.72, -0.8, dark, 0, 0.06));
    gun.add(grip, box(0.03, 0.08, 0.05, dark, 0, -0.01, -0.3));
    gun.add(box(0.045, 0.012, 0.012, dark, -0.05, 0.1, -0.62), box(0.01, 0.05, 0.01, dark, -0.075, 0.135, -0.62));
    gun.add(box(0.045, 0.012, 0.012, dark, -0.05, 0.1, -0.05), box(0.03, 0.03, 0.012, dark, -0.075, 0.13, -0.05));
    muzzle.position.set(0, 0.06, -0.8);
    leftHand = new THREE.Vector3(0, -0.02, -0.3);
    hip = new THREE.Vector3(0.065, -0.05, -0.12);
    ads = new THREE.Vector3(0, -0.035, -0.1);
  } else {
    gun.add(box(0.05, 0.07, 0.3, olive, 0, 0.02, -0.1), grip, tube(0.011, -0.25, -0.9, metal, 0, 0.035));
    gun.add(box(0.045, 0.085, 0.3, olive, 0, -0.005, 0.18), tube(0.024, -0.02, -0.3, dark, 0, 0.1), tube(0.02, -0.299, -0.305, lens, 0, 0.1));
    gun.add(box(0.012, 0.03, 0.02, dark, 0, 0.07, -0.12), box(0.012, 0.03, 0.02, dark, 0, 0.07, -0.2));
    bolt = box(0.05, 0.012, 0.012, metal, 0.035, 0.035, -0.02);
    mag = box(0.03, 0.06, 0.07, dark, 0, -0.035, -0.12);
    gun.add(bolt);
    muzzle.position.set(0, 0.035, -0.91);
    leftHand = new THREE.Vector3(0, -0.03, -0.36);
    hip = new THREE.Vector3(0.06, -0.07, -0.12);
    ads = new THREE.Vector3(0, -0.03, -0.1);
  }
  if (mag) {
    mag.userData.rest = mag.position.clone();
    gun.add(mag);
  }
  if (pump) pump.userData.rest = pump.position.clone();
  if (bolt) bolt.userData.rest = bolt.position.clone();
  muzzle.name = 'muzzle';
  gun.add(muzzle);
  const flash = muzzleFlash(FLASH[id]);
  flash.position.copy(muzzle.position);
  gun.add(flash);

  // Right hand on the grip; left hand under the barrel (or under the pistol grip).
  const rightHand = box(0.045, 0.07, 0.07, glove, 0.006, -0.04, -0.01);
  const left = box(0.05, 0.045, 0.08, glove, leftHand.x - 0.01, leftHand.y - 0.02, leftHand.z);
  rightHand.userData.hand = left.userData.hand = flash.userData.hand = true;
  gun.add(rightHand, left);
  root.add(gun);
  root.add(limb(new THREE.Vector3(0.09, -0.16, 0.42), new THREE.Vector3(0.012, -0.06, 0.03), 0.035, sleeve));
  root.add(limb(new THREE.Vector3(0.012, -0.06, 0.03), new THREE.Vector3(0.008, -0.045, -0.005), 0.026, skin));
  const elbow = new THREE.Vector3(-0.16, -0.18, 0.3);
  root.add(limb(elbow, new THREE.Vector3(leftHand.x - 0.01, leftHand.y - 0.03, leftHand.z + 0.06), 0.034, sleeve));
  root.add(limb(new THREE.Vector3(-0.2, -0.2, 0.5), elbow, 0.036, sleeve));

  root.traverse((o) => {
    o.userData.ignoreRay = true;
    o.castShadow = false;
  });
  root.scale.setScalar(0.25);
  root.visible = false;
  return { root, gun, muzzle, flash, mag, pump, bolt, hip, ads };
}

/**
 * Aiming position for a loaded model: its own sights on the centre of the view. The
 * line of sight runs over the top of the front sight (or through the scope), centred
 * on the sights sideways. The view model is drawn at a quarter size (root scale).
 */
function sightPose(model: THREE.Object3D, w: WeaponId, z: number): THREE.Vector3 {
  model.updateMatrixWorld(true);
  const points: THREE.Vector3[] = [];
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
  });
  const top = Math.max(...points.map((p) => p.y));
  const ridge = points.filter((p) => p.y > top - 0.015).map((p) => p.x);
  const x = (Math.min(...ridge) + Math.max(...ridge)) / 2;
  const y = top - SIGHT_DROP[w] + (SIGHT_DROP[w] ? 0 : 0.002);
  return new THREE.Vector3(-0.25 * x, -0.25 * y, z);
}

/** Just the gun at real size, without hands (weapons lying in the house, other players' hands). */
export function gunModel(id: WeaponId): THREE.Group {
  const loaded = loadedGuns.get(id);
  if (loaded) return loaded.clone(true);
  const { gun } = buildViewModel(id);
  gun.removeFromParent();
  for (const c of [...gun.children]) if (c.userData.hand) c.removeFromParent();
  gun.traverse((o) => (o.castShadow = true));
  return gun;
}

/** Shot sound per weapon: noise burst and a low thump, made in code. */
const VOICE: Record<WeaponId, { len: number; f0: number; f1: number; thump: number; gain: number }> = {
  pistol: { len: 0.25, f0: 4000, f1: 300, thump: 140, gain: 0.5 },
  rifle: { len: 0.2, f0: 5500, f1: 400, thump: 120, gain: 0.45 },
  shotgun: { len: 0.45, f0: 2600, f1: 150, thump: 80, gain: 0.7 },
  sniper: { len: 0.7, f0: 6500, f1: 180, thump: 65, gain: 0.8 },
  bazooka: { len: 0.9, f0: 1800, f1: 120, thump: 55, gain: 0.7 },
};
/** The rocket's explosion. */
const BOOM = { len: 1.6, f0: 2400, f1: 50, thump: 42, gain: 1.0 };

export interface Shot {
  /** Camera kick to apply (radians) */
  pitch: number;
  yaw: number;
  /** Bazooka: the rocket leaves the tube here and flies to `to` */
  rocket?: { from: THREE.Vector3; to: THREE.Vector3 };
}

export class Weapon {
  readonly root = new THREE.Group();
  enabled = false;
  current: WeaponId = 'pistol';
  owned = new Set<WeaponId>(['pistol']);
  ammo = Object.fromEntries(WEAPON_IDS.map((w) => [w, SPECS[w].mag])) as Record<WeaponId, number>;
  /** Field of view without aiming (a setting) */
  baseFov = 72;
  /** Accuracy factor from how you move: crouching is steadier, running is not */
  spreadMul = 1;
  /** A bullet hit window pane `index` at `point`, fired from `from`. */
  onGlassHit: (index: number, point: THREE.Vector3, from: THREE.Vector3) => void = () => {};
  /** Bullets (pellets) of one shot that hit another player's body and head. */
  onPlayerHit: (name: string, body: number, head: number, point: THREE.Vector3) => void = () => {};
  /** A bullet hit one of the cats. */
  onCatHit: (index: number, point: THREE.Vector3) => void = () => {};
  onClownHit: (id: number, point: THREE.Vector3) => void = () => {};
  /** A bullet hit the house or the ground (`on` is the mesh it hit): a hole, and dust, sparks or chips. */
  onImpact: (point: THREE.Vector3, normal: THREE.Vector3, material: string, on: THREE.Object3D) => void = () => {};
  /** A spent casing leaves the gun (after the shot, or when the pump or bolt is worked). */
  onEject: (w: WeaponId) => void = () => {};
  private models: Record<WeaponId, ViewModel>;
  private cooldown = 0;
  private reloading = 0;
  private flashTime = 0;
  private sway = 0;
  private aim = 0;
  private bloom = 0;
  private raise = 1;
  private cycleTime = 0;
  private previous: WeaponId = 'pistol';
  private hiddenFlag = false;
  private raycaster = new THREE.Raycaster();
  /** Weight: lag behind turning (x, y), sideways tilt, landing dip, sprint pose (0..1) */
  private lag = new THREE.Vector2();
  private lastLook: { yaw: number; pitch: number } | null = null;
  private tilt = 0;
  private dip = 0;
  private dipVel = 0;
  private sprint = 0;
  private sinceShot = 9;
  private clock = 0;
  /** Recoil as springs: back (m), barrel up (rad), roll (rad); and their speeds */
  private recoil = [0, 0, 0];
  private recoilVel = [0, 0, 0];

  constructor(private camera: THREE.PerspectiveCamera, private scene: THREE.Scene) {
    this.models = Object.fromEntries(WEAPON_IDS.map((w) => [w, buildViewModel(w)])) as Record<WeaponId, ViewModel>;
    for (const m of Object.values(this.models)) this.root.add(m.root);
    camera.add(this.root);
    this.raycaster.far = 200;
    this.show();
    void gunsReady.then((ok) => ok && this.useLoadedGuns());
  }

  /**
   * Swap the block guns for the loaded models: the hands stay, the model's grip
   * sits where the block grip was. The magazine, pump and bolt animations
   * belonged to the block guns, so the reload is a tilt of the whole gun.
   */
  private useLoadedGuns(): void {
    for (const w of WEAPON_IDS) {
      const m = this.models[w];
      for (const c of [...m.gun.children]) if (c instanceof THREE.Mesh && !c.userData.hand) c.visible = false;
      m.mag = m.pump = m.bolt = undefined;
      const model = gunModel(w);
      model.traverse((o) => (o.castShadow = false));
      m.ads = sightPose(model, w, m.ads.z);
      m.gun.add(model);
      const tip = model.getObjectByName('muzzle')!;
      m.muzzle.position.copy(tip.position);
      m.flash.position.copy(tip.position);
    }
  }

  get spec(): Spec {
    return SPECS[this.current];
  }

  get isAuto(): boolean {
    return this.spec.auto;
  }

  /** How far the gun is raised to the eye, 0..1. */
  get aimAmount(): number {
    return this.aim;
  }

  /** Landed after a jump or fall at this speed (m/s): the gun dips and comes back. */
  land(speed: number): void {
    this.dipVel -= Math.min(1.2, speed * 0.12);
  }

  /** Looking through the sniper scope (the view model hides, the scope overlay shows). */
  get scoped(): boolean {
    return this.enabled && !this.hiddenFlag && this.current === 'sniper' && this.aim > 0.85 && this.reloading <= 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.show();
  }

  /** Hidden while you are dead. */
  set hidden(v: boolean) {
    this.hiddenFlag = v;
    this.show();
  }

  get status(): string {
    if (!this.enabled) return '';
    return this.reloading > 0 ? t('weapon.reloading') : `${this.ammo[this.current]} / ${this.spec.mag}`;
  }

  /** For the weapon list on screen. */
  get slots(): { id: WeaponId; name: string; slot: number; owned: boolean; current: boolean }[] {
    return WEAPON_IDS.map((id) => ({ id, name: SPECS[id].name, slot: SPECS[id].slot, owned: this.owned.has(id), current: id === this.current }));
  }

  /** Full magazines (after respawning). */
  refill(): void {
    for (const w of WEAPON_IDS) this.ammo[w] = SPECS[w].mag;
    this.reloading = 0;
  }

  /** Back to just the pistol (after dying), plus `extra` (the admin's bazooka). */
  resetLoadout(extra: WeaponId[] = []): void {
    this.owned = new Set(['pistol', ...extra]);
    this.select('pistol');
    this.refill();
  }

  /** The admin's weapons: carried by the admin and when playing alone, by nobody else. */
  setAdminWeapons(on: boolean): void {
    for (const w of WEAPON_IDS.filter((id) => SPECS[id].admin)) {
      if (on) this.owned.add(w);
      else this.owned.delete(w);
    }
    if (!this.owned.has(this.current)) this.select('pistol');
  }

  /** A rocket or grenade exploding at `at` (anyone's): a long rumble. */
  boom(at: THREE.Vector3): void {
    this.sound('shot', 1, at, 'bazooka', BOOM);
  }

  /** You throw a grenade: the gun drops out of the way for a moment and comes back up. */
  throwing(): void {
    this.raise = Math.min(this.raise, 0.1);
    this.cooldown = Math.max(this.cooldown, 0.45);
    this.sound('throw');
  }

  /** Someone else throws a grenade, from where they stand. */
  remoteThrow(at: THREE.Vector3): void {
    this.sound('throw', 1, at);
  }

  /** Picked up a weapon: it is yours with a full magazine, and in your hands. */
  give(w: WeaponId): void {
    this.owned.add(w);
    this.ammo[w] = SPECS[w].mag;
    this.select(w);
  }

  select(w: WeaponId): void {
    if (!this.owned.has(w) || w === this.current) return;
    this.previous = this.current;
    this.current = w;
    this.reloading = 0;
    this.cooldown = Math.max(this.cooldown, 0.25);
    this.raise = 0;
    this.show();
  }

  selectSlot(slot: number): void {
    const w = WEAPON_IDS.find((id) => SPECS[id].slot === slot);
    if (w) this.select(w);
  }

  /** Next (+1) or previous (-1) weapon you own; 0 switches back to the last one. */
  cycle(dir: number): void {
    if (dir === 0) return this.select(this.previous);
    const own = WEAPON_IDS.filter((w) => this.owned.has(w));
    this.select(own[(own.indexOf(this.current) + dir + own.length) % own.length]);
  }

  reload(): void {
    if (this.enabled && this.reloading <= 0 && this.ammo[this.current] < this.spec.mag) {
      this.reloading = this.spec.reload;
      this.sound('reload');
    }
  }

  /** Fire once if ready. */
  shoot(): Shot | null {
    const spec = this.spec;
    if (!this.enabled || this.cooldown > 0 || this.reloading > 0) return null;
    if (this.ammo[this.current] === 0) {
      this.sound('empty');
      this.cooldown = 0.25;
      this.reload();
      return null;
    }
    this.ammo[this.current]--;
    this.cooldown = spec.delay;
    this.cycleTime = spec.delay;
    this.flashTime = 0.05;
    this.models[this.current].flash.fire();
    this.sinceShot = 0;
    // Recoil: a push back, the barrel up and a little roll; less when aimed.
    const steady = 1 - 0.4 * this.aim;
    this.recoilVel[0] += (0.08 + spec.kick * 6) * steady;
    this.recoilVel[1] += Math.min(4.5, 0.6 + spec.kick * 60) * steady;
    this.recoilVel[2] += (Math.random() - 0.5) * (0.4 + spec.kick * 10) * steady;
    if (this.current === 'pistol' || this.current === 'rifle') this.onEject(this.current);
    this.sound('shot');

    if (spec.rocket) {
      // No bullets: the rocket flies to whatever is under the crosshair (or as far as it goes).
      this.camera.updateMatrixWorld();
      const from = this.models[this.current].muzzle.getWorldPosition(new THREE.Vector3());
      this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      const hit = this.raycaster.intersectObjects(this.scene.children, true).find((h) => h.object.visible && !h.object.userData.ignoreRay && h.distance <= spec.rocket!.range);
      const to = hit ? hit.point.clone() : this.raycaster.ray.at(spec.rocket.range, new THREE.Vector3());
      if (this.ammo[this.current] === 0) this.reload();
      return { pitch: spec.kick, yaw: 0, rocket: { from, to } };
    }

    // Spread: the sniper rifle is only accurate through the scope; aiming steadies the others.
    let spread = this.current === 'sniper' ? (this.aim > 0.85 ? 0 : spec.hipSpread ?? 0.09) : spec.spread * (spec.pellets > 1 ? 1 : 1 - 0.6 * this.aim);
    spread = spread * this.spreadMul + this.bloom;
    if (spec.auto) this.bloom = Math.min(0.03, this.bloom + 0.005);

    this.camera.updateMatrixWorld();
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const players = new Map<string, { body: number; head: number; point: THREE.Vector3 }>();
    for (let i = 0; i < spec.pellets; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = spread * Math.sqrt(Math.random());
      this.raycaster.setFromCamera(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r), this.camera);
      const hit = this.raycaster.intersectObjects(this.scene.children, true).find((h) => h.object.visible && !h.object.userData.ignoreRay && h.face);
      if (!hit || !hit.face) continue;
      const player = hit.object.userData.player as string | undefined;
      if (hit.object.userData.clown !== undefined) {
        this.onClownHit(hit.object.userData.clown, hit.point.clone());
        break;
      }
      if (hit.object.userData.cat !== undefined) {
        this.onCatHit(hit.object.userData.cat, hit.point.clone());
      } else if (player) {
        const e = players.get(player) ?? { body: 0, head: 0, point: hit.point.clone() };
        if (hit.object.userData.part === 'head') e.head++;
        else e.body++;
        players.set(player, e);
      } else if (hit.object.userData.glassIndex !== undefined) {
        this.onGlassHit(hit.object.userData.glassIndex, hit.point.clone(), eye);
      } else {
        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        this.onImpact(hit.point.clone(), normal, String(hit.object.userData.material ?? ''), hit.object);
      }
    }
    for (const [name, e] of players) this.onPlayerHit(name, e.body, e.head, e.point);
    if (this.ammo[this.current] === 0) this.reload();
    const k = spec.kick * (0.8 + Math.random() * 0.4) * (1 - 0.4 * this.aim);
    return { pitch: k, yaw: spec.auto ? (Math.random() - 0.5) * k * 0.8 : 0 };
  }

  /**
   * `look`: where the player looks, sideways step input (-1..1, right positive), sprinting
   * and being in the air; this drives how the gun moves with the body.
   */
  update(dt: number, moving: number, aiming: boolean, look?: { yaw: number; pitch: number; side: number; sprint: boolean; air: boolean }): void {
    if (!this.enabled) return;
    const spec = this.spec;
    const m = this.models[this.current];
    this.clock += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const cycleBefore = this.cycleTime;
    this.cycleTime = Math.max(0, this.cycleTime - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.ammo[this.current] = spec.mag;
    }
    this.bloom = Math.max(0, this.bloom - dt * 0.06);
    this.flashTime = Math.max(0, this.flashTime - dt);
    m.flash.visible = this.flashTime > 0;
    this.raise = Math.min(1, this.raise + dt * 3.5);
    this.sway += dt * (1.5 + moving * 4);
    this.sinceShot += dt;
    this.aim += ((aiming && this.reloading <= 0 ? 1 : 0) - this.aim) * (1 - Math.exp(-dt * 14));
    const ease = (k: number) => 1 - Math.exp(-dt * k);

    // Springs: recoil settles quickly with a small overshoot; the landing dip a little slower.
    for (let i = 0; i < 3; i++) {
      this.recoilVel[i] += (-170 * this.recoil[i] - 16 * this.recoilVel[i]) * dt;
      this.recoil[i] += this.recoilVel[i] * dt;
    }
    this.dipVel += (-90 * this.dip - 11 * this.dipVel) * dt;
    this.dip += this.dipVel * dt;

    // Lag behind turning: the gun trails the view a little, less when aimed.
    if (look) {
      if (this.lastLook && dt > 0) {
        let dy = look.yaw - this.lastLook.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const turnX = Math.max(-6, Math.min(6, dy / dt));
        const turnY = Math.max(-6, Math.min(6, (look.pitch - this.lastLook.pitch) / dt));
        this.lag.x += (turnX - this.lag.x) * ease(9);
        this.lag.y += (turnY - this.lag.y) * ease(9);
      }
      this.lastLook = { yaw: look.yaw, pitch: look.pitch };
      this.tilt += (look.side * (1 - this.aim * 0.7) - this.tilt) * ease(6);
      const sprinting = look.sprint && moving > 0.5 && !look.air && !aiming && this.reloading <= 0 && this.sinceShot > 0.35;
      this.sprint += ((sprinting ? 1 : 0) - this.sprint) * ease(sprinting ? 7 : 12);
    }
    const loose = 1 - this.aim * 0.8;

    // Hip position lower right; aiming brings the sights to the centre of the view.
    const pos = m.hip.clone().lerp(m.ads, this.aim);
    const bob = (1 - this.aim * 0.8) * Math.min(1, moving) * (1 + this.sprint * 0.8);
    const breathe = Math.sin(this.clock * 1.6) * (1 - this.aim * 0.7);
    const raised = 1 - (1 - this.raise) * (1 - this.raise); // eased: quick at first, settling in
    pos.x += Math.sin(this.sway) * 0.004 * bob + this.lag.x * 0.0022 * loose - this.sprint * 0.012;
    pos.y += Math.abs(Math.cos(this.sway)) * 0.004 * bob - (1 - raised) * 0.08 - this.lag.y * 0.0018 * loose + breathe * 0.0012 + this.dip * 0.3 - this.sprint * 0.022;
    pos.z += this.recoil[0] * (spec.pellets > 1 || this.current === 'sniper' ? 1.4 : 1);

    // Reload: tilt the gun, drop the magazine out, bring a new one in.
    const p = this.reloading > 0 ? 1 - this.reloading / spec.reload : 0;
    const lowered = this.reloading > 0 ? Math.sin(p * Math.PI) : 0;
    pos.y -= lowered * 0.04;
    // Shotgun pump and sniper bolt after each shot. The loaded models have no separate
    // pump or bolt, so the whole gun rocks back and rolls as it is worked.
    const cyc = this.cycleTime > 0 ? Math.sin(Math.min(1, (spec.delay - this.cycleTime) / (spec.delay * 0.7)) * Math.PI) : 0;
    const rack = (this.current === 'shotgun' || this.current === 'sniper') && !m.pump && !m.bolt ? cyc * (1 - this.aim * 0.5) : 0;
    pos.z += rack * 0.012;
    pos.y -= rack * 0.006;
    m.root.position.copy(pos);
    m.root.rotation.set(
      this.recoil[1] - lowered * 0.5 - (1 - raised) * 0.6 - this.lag.y * 0.012 * loose + breathe * 0.004 - this.sprint * 0.32 - rack * 0.05,
      0.02 * (1 - this.aim) - this.lag.x * 0.016 * loose + this.sprint * 0.55,
      this.recoil[2] * 2 - this.tilt * 0.06 + this.sprint * 0.22 + rack * 0.12,
    );
    m.gun.rotation.z = lowered * 0.6;
    if (m.mag) {
      const rest = m.mag.userData.rest as THREE.Vector3;
      const out = p <= 0 ? 0 : p < 0.35 ? p / 0.35 : p < 0.55 ? 1 : p < 0.85 ? 1 - (p - 0.55) / 0.3 : 0;
      m.mag.position.set(rest.x, rest.y - out * 0.3, rest.z);
      m.mag.visible = !(p > 0.35 && p < 0.55);
    }
    if (m.pump) m.pump.position.z = (m.pump.userData.rest as THREE.Vector3).z + cyc * 0.09;
    if (m.bolt) m.bolt.position.z = (m.bolt.userData.rest as THREE.Vector3).z + cyc * 0.07;
    // Pump or bolt worked: its click, and the spent case comes out.
    if ((this.current === 'shotgun' || this.current === 'sniper') && cycleBefore > spec.delay * 0.6 && this.cycleTime <= spec.delay * 0.6) {
      this.sound('cycle');
      this.onEject(this.current);
    }

    m.root.visible = !this.scoped && !this.hiddenFlag;
    const fov = this.baseFov * (1 - (1 - spec.zoom) * this.aim);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Another player's shot: that weapon's sound, from where they stand. */
  remoteShot(at: THREE.Vector3, w: WeaponId = 'pistol'): void {
    this.sound('shot', 1, at, w);
  }

  private show(): void {
    for (const [w, m] of Object.entries(this.models)) m.root.visible = this.enabled && !this.hiddenFlag && w === this.current;
  }

  /** Short synthesized sounds: no audio files to download. */
  private sound(kind: 'shot' | 'empty' | 'reload' | 'cycle' | 'throw', volume = 1, at?: THREE.Vector3, w: WeaponId = this.current, voice = VOICE[w]): void {
    const ctx = sound.context();
    const dest = at ? sound.at(at.x, at.y, at.z, w === 'sniper' || w === 'shotgun' ? 8 : w === 'bazooka' ? 14 : 4) : sound.out();
    if (!ctx || !dest) return;
    const t = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(dest);
    const out = ctx.createGain();
    out.connect(master);
    if (kind === 'shot') {
      const v = voice;
      const buf = ctx.createBuffer(1, ctx.sampleRate * v.len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 4);
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(v.f0, t);
      filter.frequency.exponentialRampToValueAtTime(v.f1, t + v.len);
      noise.connect(filter).connect(out);
      const thump = ctx.createOscillator();
      thump.frequency.setValueAtTime(v.thump, t);
      thump.frequency.exponentialRampToValueAtTime(35, t + 0.14);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.8, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      thump.connect(tg).connect(out);
      out.gain.setValueAtTime(v.gain, t);
      noise.start(t);
      thump.start(t);
      thump.stop(t + 0.2);
    } else if (kind === 'throw') {
      // The pin's click, then a short whoosh rising in pitch.
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.35, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / data.length);
      const air = ctx.createBufferSource();
      air.buffer = buf;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 1.2;
      band.frequency.setValueAtTime(600, t + 0.05);
      band.frequency.exponentialRampToValueAtTime(2400, t + 0.4);
      out.gain.value = 0.22;
      air.connect(band).connect(out);
      air.start(t + 0.05);
      const pin = ctx.createOscillator();
      pin.type = 'square';
      pin.frequency.value = 1900;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.06, t);
      pg.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      pin.connect(pg).connect(master);
      pin.start(t);
      pin.stop(t + 0.04);
    } else {
      // Clicks: empty, the magazine going out and in, the pump or bolt.
      const clicks = kind === 'empty' ? [[0, 900]] : kind === 'cycle' ? [[0, 420], [0.12, 620]] : [[0, 500], [this.spec.reload * 0.65, 700]];
      for (const [at2, f] of clicks) {
        const click = ctx.createOscillator();
        click.type = 'square';
        click.frequency.setValueAtTime(f, t + at2);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.12, t + at2);
        g.gain.exponentialRampToValueAtTime(0.001, t + at2 + 0.05);
        click.connect(g).connect(master);
        click.start(t + at2);
        click.stop(t + at2 + 0.06);
      }
    }
  }
}
