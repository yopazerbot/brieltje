import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sound } from './sound';
import { muzzleFlash, type Spot } from './world/effects';
import type { Paint } from './world/splats';
import { GUN_PAINT, onPaintball, paintball } from './paintball';
import WEAPONS from '../shared/weapons.json';
import { LOOT } from '../shared/loot.mjs';
import { t } from './i18n';
import { drawn } from './world/rayShown';
import { gunSurface, handFlash, noNearCut, setGunWear } from './world/gunSurface';
import { WIND_PUSH, windAt } from './world/wind';

/**
 * "Action" mode: first-person hands holding a pistol, rifle, shotgun or
 * sniper rifle, like Counter-Strike. The pistol is always there; the others
 * are picked up in the house. Shots leave bullet holes and dust or sparks
 * (effects.ts) and throw out a casing. The guns and the gloved hands are our
 * own Blender models (tools/weapons.py, one file); until they have loaded (or
 * if they can't), simple block guns stand in. Their parts move: the pistol's
 * slide kicks back and locks open when it is empty, the shotgun's pump and
 * the sniper rifle's bolt are worked by hand after each shot, a reload drops
 * the magazine and the left hand brings a new one (the shotgun's hand loads
 * shells one by one, the bazooka's a new rocket). The gun moves like it has
 * weight: it lags behind when you turn, tilts when you step sideways, bobs
 * with your steps, dips when you land, is carried low while sprinting and
 * springs back after each shot; switching lowers one gun and raises the next.
 * The models sit within 20 cm of the camera, closer than any wall can get
 * (the player is 25 cm wide), so they never poke through walls; they are
 * drawn at the same size whatever the field of view (a setting).
 * In paintball (paintball.ts) the same guns are bright toy markers with a
 * paint hopper and an air tank, they pop instead of bang, and each pellet is
 * a paintball you see fly (effects.ts); the hits are the same.
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
  /** A bullet goes on through the first zombie it hits and can hit this many in all (the sniper's: a double) */
  pierce?: number;
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

/** How fast each gun comes up to the eye (1/s): the pistol at once, the long and heavy ones slower. */
const AIM_SPEED: Record<WeaponId, number> = { pistol: 20, rifle: 14, shotgun: 12, sniper: 9, bazooka: 8 };
const NO_DRIFT = new THREE.Vector2();
/**
 * How fast you walk with each gun, of your free pace: the pistol hardly counts, the long and heavy ones
 * do. Aiming slows you a quarter more (carrySpeed).
 */
const WEIGHT: Record<WeaponId, number> = { pistol: 1, rifle: 0.94, shotgun: 0.93, sniper: 0.87, bazooka: 0.8 };
/**
 * The sniper rifle's bullet, m/s. Slower than a real one (about 800) so that its flight shows at the
 * distances this village has: 100 m takes a quarter of a second and drops 34 cm, 190 m takes half a
 * second and drops one mark on the scope's reticle.
 */
const BULLET_SPEED = 380;
/** m: how far ahead a flying bullet looks at a time (fly). */
const BULLET_LOOK = 20;
/**
 * Thin cover a rifle's or sniper rifle's bullet goes through, by the surface's name, and how deep it
 * is at most (m): the bullet leaves a hole, and counts in full on what is behind. Not walls, floors or
 * wooden cladding (a wall is behind that), and not for the pistol or the shotgun's pellets.
 */
const COVER: Record<string, number> = { hedge: 1.6, nb_hedge: 1.6, oak: 0.2, walnut: 0.2, fence: 0.2 };

/** Muzzle flash length per gun, in metres. */
const FLASH: Record<WeaponId, number> = { pistol: 0.16, rifle: 0.26, shotgun: 0.34, sniper: 0.32, bazooka: 0.45 };

/**
 * Paintball's toy look: each gun in bright colours instead of black metal. Each of the models'
 * materials has a role: the body (in the colour of the gun's paint), the trim, the parts that were
 * black, and the scope's glass. Every copy of a gun shares its materials (in your hands, in the
 * others' hands, lying in the house), so switching is one pass over a few materials.
 */
type Role = 'body' | 'trim' | 'deep' | 'lens';
/** The roles of the materials in weapons.glb (tools/weapons.py); the sights' white dots keep their colour. */
const ROLE: Record<string, Role> = {
  Polymer: 'body', Wood: 'body', Olive: 'body', Warhead: 'body',
  Steel: 'trim', Brass: 'trim', Dark: 'deep', Grip: 'deep', Glass: 'lens',
};
const TOY: Record<WeaponId, Record<Role, string>> = {
  pistol: { body: GUN_PAINT.pistol, trim: '#ffd23f', deep: '#2f6fe0', lens: '#8fe9ff' },
  rifle: { body: GUN_PAINT.rifle, trim: '#f4f4ee', deep: '#ff7a1a', lens: '#8fe9ff' },
  shotgun: { body: GUN_PAINT.shotgun, trim: '#ffd23f', deep: '#ff7a1a', lens: '#8fe9ff' },
  sniper: { body: GUN_PAINT.sniper, trim: '#f4f4ee', deep: '#ffd23f', lens: '#8fe9ff' },
  bazooka: { body: GUN_PAINT.bazooka, trim: '#ffd23f', deep: '#9d5cff', lens: '#8fe9ff' },
};
/** Each paint hopper's colour: one that stands out on its gun (a lighter one turns skin-coloured in the sun). */
const HOPPER: Record<WeaponId, string> = { pistol: '#2f8cff', rifle: '#9d5cff', shotgun: '#ff7a1a', sniper: '#ffd23f', bazooka: '#ffd23f' };
/** The materials that change, with their toy colour and their own look (colour, metalness, roughness). */
const toyParts: { m: THREE.MeshStandardMaterial; color: string; rough: number; real: [THREE.Color, number, number] }[] = [];
/** The hoppers' and tanks' materials: shown in paintball only. */
const kitMats: THREE.Material[] = [];

function dress(p: (typeof toyParts)[number], on: boolean): void {
  if (on) {
    p.m.color.set(p.color);
    p.m.metalness = 0;
    p.m.roughness = p.rough; // smooth plastic
  } else {
    p.m.color.copy(p.real[0]);
    p.m.metalness = p.real[1];
    p.m.roughness = p.real[2];
  }
}

/** One of gun `w`'s materials takes its role's toy colour in paintball. */
function toy(m: THREE.MeshStandardMaterial, w: WeaponId, role: Role): void {
  const part = { m, color: TOY[w][role], rough: role === 'lens' ? 0.1 : 0.42, real: [m.color.clone(), m.metalness, m.roughness] as [THREE.Color, number, number] };
  toyParts.push(part);
  dress(part, paintball.on);
}

setGunWear(!paintball.on);
onPaintball((on) => {
  setGunWear(!on); // the toy guns are new plastic: no worn edges
  for (const p of toyParts) dress(p, on);
  for (const m of kitMats) m.visible = on;
});

/**
 * A loaded weapon (tools/weapons.py): the gun with its moving parts, its paint kit, the muzzle and a
 * point on its line of sight, all in the gun's frame (barrel along -z, the right hand's grip at the
 * origin, metres); the two gloved hands with their sleeves that hold it in first person; and `lite`,
 * the same gun merged into one mesh per material, for the others' hands and the house's floors.
 */
interface LoadedGun {
  gun: THREE.Object3D;
  hands: THREE.Object3D;
  lite: THREE.Group;
  sight: THREE.Vector3;
}
const loadedGuns = new Map<WeaponId, LoadedGun>();
/** The sleeves' material (all hands share it): the colour of your suit. */
const sleeves: THREE.MeshStandardMaterial[] = [];

/** For the others' hands, the small accents take the colour of a material nearby: 3 or 4 draws per gun, as before. */
const FOLD: Record<string, string> = { Dot: 'Steel', Brass: 'Steel', Glass: 'Dark', Lens: 'Dark', RedDot: 'Dark', Grip: 'Dark', Warhead: 'Olive' };

/** The gun merged into one mesh per material (not the parts' moving): a few draws per player who holds it. */
function liteGun(gun: THREE.Object3D, muzzle: THREE.Vector3): THREE.Group {
  gun.updateMatrixWorld(true);
  const inv = gun.matrixWorld.clone().invert();
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const named = new Map<string, THREE.Material>();
  gun.traverse((o) => {
    if (o instanceof THREE.Mesh) named.set((o.material as THREE.Material).name, o.material as THREE.Material);
  });
  gun.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal']) {
      const a = o.geometry.getAttribute(name); // 16- and 8-bit in the file: floats here, as merging wants one kind
      const f = new Float32Array(a.count * 3);
      for (let i = 0; i < a.count; i++) f.set([a.getX(i), a.getY(i), a.getZ(i)], i * 3);
      g.setAttribute(name, new THREE.BufferAttribute(f, 3));
    }
    g.setIndex(o.geometry.index!.clone());
    g.applyMatrix4(o.matrixWorld.clone().premultiply(inv));
    const own = o.material as THREE.Material;
    const mat = (o.userData.kit ? undefined : named.get(FOLD[own.name])) ?? own;
    const list = byMat.get(mat) ?? [];
    list.push(g);
    byMat.set(mat, list);
  });
  const lite = new THREE.Group();
  for (const [mat, list] of byMat) {
    const mesh = new THREE.Mesh(mergeGeometries(list), mat);
    mesh.userData.ignoreRay = true;
    mesh.userData.kit = kitMats.includes(mat);
    mesh.castShadow = true;
    lite.add(mesh);
    for (const g of list) g.dispose();
  }
  const tip = new THREE.Object3D();
  tip.name = 'muzzle';
  tip.position.copy(muzzle);
  lite.add(tip);
  return lite;
}

/** The weapons' model: one file, a node per weapon (tools/weapons.py). */
export const gunsReady: Promise<boolean> = new GLTFLoader().loadAsync('/models/weapons.glb').then(
  (gltf) => {
    gltf.scene.updateMatrixWorld(true);
    for (const w of WEAPON_IDS) {
      const gun = gltf.scene.getObjectByName(w)!;
      const hands = gun.getObjectByName(`${w}_hands`)!;
      hands.removeFromParent();
      gun.removeFromParent();
      gun.getObjectByName(`${w}_kit`)?.traverse((o) => (o.userData.kit = true));
      // Its own copy of each material, so each gun takes its own colours in paintball.
      const own = new Map<THREE.Material, THREE.MeshStandardMaterial>();
      gun.traverse((o) => {
        o.userData.ignoreRay = true;
        if (!(o instanceof THREE.Mesh)) return;
        const from = o.material as THREE.MeshStandardMaterial;
        let m = own.get(from);
        if (!m) {
          m = from.clone();
          own.set(from, m);
          if (o.userData.kit) {
            if (m.name === 'Hopper') m.color.set(HOPPER[w]);
            if (m.name === 'KitTrim') m.color.set(TOY[w].trim);
            m.visible = paintball.on;
            kitMats.push(m);
          } else {
            // The scope's lenses mirror the sky, as coated glass does (before `toy` notes the real look).
            if (m.name === 'Glass') {
              m.metalness = 1;
              m.roughness = 0.04;
              m.color.set('#4a6a7c');
              m.envMapIntensity = 1.5;
            }
            if (ROLE[m.name]) toy(m, w, ROLE[m.name]);
            gunSurface(m); // worn edges, darker seams, a fine grain (world/gunSurface.ts)
            // The red-dot sight: a window you look through, and a dot that shows in any light.
            if (m.name === 'Lens') m.depthWrite = false;
            if (m.name === 'RedDot') m.emissiveIntensity = 3;
          }
        }
        o.material = m;
      });
      hands.traverse((o) => {
        o.userData.ignoreRay = true;
        o.userData.hand = true;
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m?.name === 'Sleeve' && !sleeves.includes(m)) sleeves.push(m);
        // Cloth and leather with their grain and the shade between the fingers; and your arm reaches back past the
        // camera's near edge: drawn, not cut open (the surface brings that along; noNearCut for what has none).
        if (m && !m.userData.dressed) {
          m.userData.dressed = true;
          if (!gunSurface(m)) noNearCut(m);
        }
      });
      const muzzle = gun.getObjectByName(`${w}_muzzle`)!;
      muzzle.name = 'muzzle';
      const sight = gun.getObjectByName(`${w}_sight`)!.position.clone();
      loadedGuns.set(w, { gun, hands, sight, lite: liteGun(gun, muzzle.position) });
    }
    return true;
  },
  () => false,
);

const skin =new THREE.MeshStandardMaterial({ color: '#c99a7b', roughness: 0.7 });
const sleeve = new THREE.MeshStandardMaterial({ color: '#2d3436', roughness: 0.9 });
const glove = new THREE.MeshStandardMaterial({ color: '#1e1f22', roughness: 0.8 });
const metal = new THREE.MeshStandardMaterial({ color: '#2b2d31', roughness: 0.35, metalness: 0.75 });
const dark = new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.9 });
const wood = new THREE.MeshStandardMaterial({ color: '#7a4a2a', roughness: 0.6 });
const olive = new THREE.MeshStandardMaterial({ color: '#4a4d3a', roughness: 0.8 });
const lens = new THREE.MeshStandardMaterial({ color: '#1f3b52', roughness: 0.1, metalness: 0.5 });
const UP = new THREE.Vector3(0, 1, 0);
/** The block guns' materials, a set per gun, so each can take its own toy colours in paintball. */
const blockSets = new Map<WeaponId, { metal: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; wood: THREE.MeshStandardMaterial; olive: THREE.MeshStandardMaterial; lens: THREE.MeshStandardMaterial }>();
function blockMats(w: WeaponId): NonNullable<ReturnType<typeof blockSets.get>> {
  let set = blockSets.get(w);
  if (!set) {
    set = { metal: metal.clone(), dark: dark.clone(), wood: wood.clone(), olive: olive.clone(), lens: lens.clone() };
    const roles: Record<keyof typeof set, Role> = { metal: 'trim', dark: 'deep', wood: 'body', olive: 'body', lens: 'lens' };
    for (const k of Object.keys(set) as (keyof typeof set)[]) toy(set[k], w, roles[k]);
    blockSets.set(w, set);
  }
  return set;
}

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
  /** The loaded models' other moving parts, and the hands (each moved from where it rests: userData.rest) */
  slide?: THREE.Object3D;
  rocket?: THREE.Object3D;
  shell?: THREE.Object3D;
  handR?: THREE.Object3D;
  handL?: THREE.Object3D;
  hip: THREE.Vector3;
  ads: THREE.Vector3;
}

/** Gun plus two arms, in metres at real size (scaled down near the camera later). */
function buildViewModel(id: WeaponId): ViewModel {
  const { metal, dark, wood, olive, lens } = blockMats(id);
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
 * Where each loaded gun is held from the hip, in the camera's frame (the grip; the view model is
 * drawn at a quarter size): right of and below the middle of the view, a little ahead. Aiming puts
 * the gun's own line of sight (its `sight` point) on the middle instead.
 */
const HIP: Record<WeaponId, [number, number, number]> = {
  pistol: [0.045, -0.05, -0.1],
  rifle: [0.05, -0.052, -0.095],
  shotgun: [0.05, -0.054, -0.095],
  sniper: [0.05, -0.054, -0.095],
  bazooka: [0.072, -0.052, -0.1],
};

/** How much further in and up the gun is held from the hip while playing with the touch controls. */
const TOUCH_HIP = new THREE.Vector3(-0.02, 0.01, 0);

/** Just the gun at real size, without hands (weapons lying in the house, other players' hands). */
export function gunModel(id: WeaponId): THREE.Group {
  const loaded = loadedGuns.get(id);
  if (loaded) return loaded.lite.clone(true);
  const { gun } = buildViewModel(id);
  gun.removeFromParent();
  for (const c of [...gun.children]) if (c.userData.hand) c.removeFromParent();
  gun.traverse((o) => (o.castShadow = true));
  return gun;
}

/** 0 before a, 1 after b, a smooth step between. */
function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Where a loaded hand holds when it rests (the middle of what its fingers wrap), in the gun's frame. */
function holdPoint(hand: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  return out.fromArray((hand.userData.grip as number[] | undefined) ?? [0, 0, 0]).add(hand.userData.rest as THREE.Vector3);
}

// The left hand's way in a reload, in the gun's frame (m): down and back out of sight to fetch a
// magazine or a rocket; not as far for a shell, which it pushes up into the shotgun's loading port
// (under the receiver); and where it holds a new rocket, from the rocket's back end.
const AWAY = new THREE.Vector3(-0.06, -0.26, 0.12);
const AWAY_LOW = new THREE.Vector3(-0.03, -0.12, 0.05);
const PORT = new THREE.Vector3(0, -0.042, -0.16);
const ROCKET_HOLD = new THREE.Vector3(0, -0.046, -0.06);
const _left = new THREE.Vector3();
const _out = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

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
/**
 * Paintball's pop per gun: a short puff of air through a band of noise (`f` its middle, Hz) and
 * a soft low thump, with a hiss of air after it.
 */
const POP: Record<WeaponId, { len: number; f: number; thump: number; gain: number }> = {
  pistol: { len: 0.12, f: 1500, thump: 190, gain: 0.45 },
  rifle: { len: 0.1, f: 1700, thump: 170, gain: 0.4 },
  shotgun: { len: 0.22, f: 900, thump: 120, gain: 0.6 },
  sniper: { len: 0.18, f: 1200, thump: 140, gain: 0.55 },
  bazooka: { len: 0.35, f: 500, thump: 80, gain: 0.7 },
};
/** How big each gun's paint splats are (m across); the shotgun's eight are smaller. */
const SPLAT: Record<WeaponId, number> = { pistol: 0.5, rifle: 0.45, shotgun: 0.32, sniper: 0.65, bazooka: 0.9 };

/** Whether a hit landed on the lower two fifths of its hit box: the legs of a body's box. */
function lowOnBox(hit: THREE.Intersection): boolean {
  const geo = (hit.object as THREE.Mesh).geometry;
  if (!geo) return false;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const y = hit.object.worldToLocal(hit.point.clone()).y;
  return y < box.min.y + (box.max.y - box.min.y) * 0.4;
}

const noises = new Map<string, AudioBuffer>();
/**
 * A stretch of noise `seconds` long, shaped by `shape` (0..1 along it, giving its loudness there), made the
 * first time it is asked for and kept: every shot, yours and everyone's, used to fill half a second of
 * random numbers again.
 */
function noiseBuffer(ctx: AudioContext, key: string, seconds: number, shape: (s: number) => number): AudioBuffer {
  const id = `${key}|${ctx.sampleRate}`;
  let buf = noises.get(id);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * seconds)), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * shape(i / data.length);
    noises.set(id, buf);
  }
  return buf;
}

/** The figure (a player, a clown, a strongman) a hit box belongs to: the paint goes on its body, not on the box round it. */
function figureOf(o: THREE.Object3D | null): THREE.Object3D | null {
  for (let p = o; p; p = p.parent) if (p.userData.figure) return p;
  return null;
}

/** A zombie a shot hit: its id, the pellets on its body and head, where the first landed and along which ray. */
export interface ZombieHit {
  id: number;
  body: number;
  head: number;
  /** How many of the body's pellets landed on the legs (the lower part of the body's hit box): it limps */
  legs: number;
  point: THREE.Vector3;
  ray: THREE.Ray;
}

export interface Shot {
  /** Camera kick to apply (radians) */
  pitch: number;
  yaw: number;
  /** A shot that shows as a tracer: where it goes, so the others can see it fly too */
  tracer?: THREE.Vector3;
  /** Bazooka: the rocket leaves the tube here and flies to `to` */
  rocket?: { from: THREE.Vector3; to: THREE.Vector3 };
}

/**
 * A found scope's size (Zombies' reward), as real ones: its tube's radius, the front lens's (the
 * wider bell), its length (m), and where its middle sits, as a share of the gun's length from the
 * back: over the rifle's receiver, over the pistol's slide.
 */
const SCOPE: Partial<Record<WeaponId, { r: number; bell: number; len: number; at: number }>> = {
  rifle: { r: 0.013, bell: 0.021, len: 0.28, at: 0.4 },
  pistol: { r: 0.011, bell: 0.015, len: 0.13, at: 0.5 },
};
const scopeMetal = new THREE.MeshStandardMaterial({ color: '#1d2024', roughness: 0.45, metalness: 0.6 });
const scopeGlass = new THREE.MeshStandardMaterial({ color: '#1f3644', roughness: 0.05, metalness: 0.4, emissive: '#12313e', emissiveIntensity: 0.3 });

/**
 * A scope (Zombies' reward) on top of gun `w`: a dark tube, the front lens in a wider bell and the
 * eyepiece at the back, on two rings, along the barrel over the receiver (SCOPE). Fitted to the gun's
 * own shape: its own visible parts only (not the hands, nor the muzzle flash, which reaches far past
 * the barrel and once pushed the scope out over the muzzle), and standing on the highest point of the
 * gun under it. The front is the muzzle's end (-z).
 */
function scopeOn(gun: THREE.Group, w: WeaponId, skip: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  const size = SCOPE[w];
  if (!size) return g;
  gun.updateWorldMatrix(true, true);
  const inv = gun.matrixWorld.clone().invert();
  const shown = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p && p !== gun; p = p.parent) if (!p.visible || p === skip || p.userData.hand || p.userData.kit) return false;
    return true;
  };
  const pts: THREE.Vector3[] = [];
  gun.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry || !shown(m)) return;
    const pos = m.geometry.attributes.position;
    const to = m.matrixWorld.clone().premultiply(inv);
    for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(to));
  });
  if (!pts.length) return g;
  const back = Math.max(...pts.map((p) => p.z));
  const front = Math.min(...pts.map((p) => p.z));
  const { r, bell, len, at } = size;
  const cz = back - (back - front) * at;
  // What it stands on: the gun's top under it, and the middle of that ridge sideways.
  const under = pts.filter((p) => Math.abs(p.z - cz) < len / 2);
  const top = Math.max(...under.map((p) => p.y));
  const ridge = under.filter((p) => p.y > top - 0.004).map((p) => p.x);
  const gap = r * 1.4; // the rings' height
  g.position.set((Math.min(...ridge) + Math.max(...ridge)) / 2, top + gap + r, cz);
  // A cylinder along the barrel (its bottom, -y, to the front, -z), its middle `z` m along it.
  const along = (geo: THREE.BufferGeometry, z: number) => geo.rotateX(Math.PI / 2).translate(0, 0, z);
  const parts: [THREE.BufferGeometry, THREE.Material][] = [
    [along(new THREE.CylinderGeometry(r, r, len * 0.7, 20), 0), scopeMetal],
    // The bell: wide at the front, narrowing to the tube; the eyepiece at the back.
    [along(new THREE.CylinderGeometry(r, bell, len * 0.18, 20, 1, true), -len * 0.44), scopeMetal],
    [along(new THREE.CylinderGeometry(r * 1.2, r * 1.2, len * 0.12, 20, 1, true), len * 0.44), scopeMetal],
    // The lenses: the front one facing ahead (-z) just inside the bell, the eyepiece's facing you.
    [new THREE.CircleGeometry(bell * 0.86, 20).rotateY(Math.PI).translate(0, 0, -len * 0.53 + 0.002), scopeGlass],
    [new THREE.CircleGeometry(r, 20).translate(0, 0, len * 0.5 - 0.002), scopeGlass],
  ];
  for (const [geo, mat] of parts) g.add(new THREE.Mesh(geo, mat));
  for (const s of [-1, 1]) {
    const ring = new THREE.Mesh(new THREE.BoxGeometry(r * 1.3, gap + r, r * 1.4), scopeMetal);
    ring.position.set(0, -(gap + r) / 2, s * len * 0.2);
    g.add(ring);
  }
  // As the rest of the gun in your hands: no shadow, and your shots go through it. Without that, every
  // shot aimed through the scope hit the scope itself: a hole right in front of your eye (the "cracked
  // pane" in the middle of the view), and the bullet never reached anything.
  g.traverse((o) => {
    o.castShadow = false;
    o.userData.ignoreRay = true;
  });
  gun.add(g);
  return g;
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
  /** The gun rested on a ledge or a sill in front of you (main.ts): 0.6, else 1. Steadies the shot and the scope's drift. */
  rest = 1;
  /** Zombies' rewards (shared/loot.mjs): the guns with the bigger magazines, and the scope on the rifle and the pistol */
  private bigMags = new Set<WeaponId>();
  private scopeOn = false;
  private scopes = new Map<WeaponId, THREE.Group>();
  /** A bullet hit window pane `index` at `point`, fired from `from`; `normal` is the pane's face there, `pane` its mesh. */
  onGlassHit: (index: number, point: THREE.Vector3, from: THREE.Vector3, normal: THREE.Vector3, pane: THREE.Object3D, w: WeaponId) => void = () => {};
  /** Bullets (pellets) of one shot that hit another player's body and head; in paintball `spot` is where the paint sticks. */
  onPlayerHit: (name: string, body: number, head: number, point: THREE.Vector3, spot: Spot | undefined, w: WeaponId) => void = () => {};
  /** A bullet hit one of the cats. */
  onCatHit: (index: number, point: THREE.Vector3) => void = () => {};
  onClownHit: (id: number, point: THREE.Vector3, spot?: Spot) => void = () => {};
  /**
   * One shot's pellets that hit zombies (the Zombies game), per zombie: pellets on the body and the
   * head, where the first hit, and its ray (paintball's paint is found on the posed body from it).
   */
  onZombieHit: (hits: ZombieHit[], paint: Paint | null, w: WeaponId) => void = () => {};
  /** Paintball: a pellet's paintball flies from the gun to `to` (where it hit, or as far as it goes). */
  onPaintball: (from: THREE.Vector3, to: THREE.Vector3, paint: Paint) => void = () => {};
  /** A bullet hit the house or the ground (`on` is the mesh it hit): a hole, and dust, sparks or chips. */
  onImpact: (point: THREE.Vector3, normal: THREE.Vector3, material: string, on: THREE.Object3D, w: WeaponId) => void = () => {};
  /** A spent casing leaves the gun (after the shot, or when the pump or bolt is worked). */
  onEject: (w: WeaponId) => void = () => {};
  /** A bullet you can see fly: from the muzzle to where it lands (the rifle's every third, the sniper rifle's each one). */
  onTracer: (from: THREE.Vector3, to: THREE.Vector3) => void = () => {};
  /** The sniper rifle's bullet went this stretch in the last `dt` seconds. */
  onBullet: (from: THREE.Vector3, to: THREE.Vector3, dt: number) => void = () => {};
  private models: Record<WeaponId, ViewModel>;
  private cooldown = 0;
  private reloading = 0;
  private flashTime = 0;
  private sway = 0;
  private aim = 0;
  private bloom = Object.fromEntries(WEAPON_IDS.map((w) => [w, 0])) as Record<WeaponId, number>;
  private raise = 1;
  private cycleTime = 0;
  private previous: WeaponId = 'pistol';
  /** The gun in your hands on screen: the one you switched from until it has dropped away */
  private shown: WeaponId = 'pistol';
  private hiddenFlag = false;
  private raycaster = new THREE.Raycaster();
  /** Weight: lag behind turning (x, y), sideways tilt, landing dip, sprint pose (0..1) */
  private lag = new THREE.Vector2();
  private lastLook: { yaw: number; pitch: number } | null = null;
  private tilt = 0;
  private dip = 0;
  private dipVel = 0;
  private sprint = 0;
  /** Seconds standing idle with the gun, and how far it is turned over to look at (0..1) */
  private idle = 0;
  private look = 0;
  private sinceShot = 9;
  private clock = 0;
  /** Recoil as springs: back (m), barrel up (rad), roll (rad); and their speeds */
  private recoil = [0, 0, 0];
  private recoilVel = [0, 0, 0];
  /** Shots in the burst so far: the recoil's pattern follows it. A burst ends a moment after its last shot. */
  private burst = 0;
  /** The part of the recoil's climb the view still gives back (rad), what the gun itself turned the view since the last update, and what it asks back this frame */
  private kickDebt = 0;
  private selfPitch = 0;
  private recover = 0;
  /** Through a scope: where the reticle drifts with your breath (in half view heights), the breath you have left (0..1), and being out of it */
  private drift = new THREE.Vector2();
  private driftAmp = 0;
  private breath = 1;
  private winded = false;
  /** The sniper rifle's bullets in the air: where, how fast, the range left (m), how far ahead is known to be clear (m), and the cover each may still go through */
  private bullets: { pos: THREE.Vector3; vel: THREE.Vector3; left: number; clear: number; pass: { free: number; left: number } }[] = [];
  /** How long the reload under way takes in all (s) */
  private reloadTime = 1;
  /** Your suit's colour, for the sleeves */
  private sleeve = '#4b4c3b';

  constructor(private camera: THREE.PerspectiveCamera, private scene: THREE.Scene) {
    this.models = Object.fromEntries(WEAPON_IDS.map((w) => [w, buildViewModel(w)])) as Record<WeaponId, ViewModel>;
    for (const m of Object.values(this.models)) this.root.add(m.root);
    camera.add(this.root);
    this.raycaster.far = 200;
    this.show();
    void gunsReady.then((ok) => ok && this.useLoadedGuns());
  }

  /**
   * Swap the block guns and arms for the loaded models: each gun with its moving parts and the
   * gloved hands that hold it, its grip where the block grip was.
   */
  private useLoadedGuns(): void {
    for (const w of WEAPON_IDS) {
      const m = this.models[w];
      const loaded = loadedGuns.get(w)!;
      for (const c of [...m.gun.children, ...m.root.children]) if (c instanceof THREE.Mesh) c.visible = false;
      const model = loaded.gun.clone(true);
      const hands = loaded.hands.clone(true);
      m.gun.add(model, hands);
      for (const o of [model, hands]) o.traverse((c) => (c.castShadow = false));
      const part = (name: string) => {
        const o = model.getObjectByName(`${w}_${name}`) ?? hands.getObjectByName(`${w}_${name}`);
        if (o) {
          o.userData.rest = o.position.clone();
          o.userData.restQ = o.quaternion.clone();
        }
        return o;
      };
      m.mag = part('mag');
      m.pump = part('pump');
      m.bolt = part('bolt');
      m.slide = part('slide');
      m.rocket = part('rocket');
      m.handR = part('handR');
      m.handL = part('handL');
      m.shell = hands.getObjectByName('shotgun_shell');
      if (m.mag) {
        // How far the magazine reaches below its pivot (it comes out downwards).
        let low = 0;
        m.mag.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          o.geometry.computeBoundingBox();
          low = Math.min(low, o.geometry.boundingBox!.min.y + (o === m.mag ? 0 : o.position.y));
        });
        m.mag.userData.len = -low;
      }
      m.hip.fromArray(HIP[w]);
      m.ads.set(-0.25 * loaded.sight.x, -0.25 * loaded.sight.y, w === 'pistol' ? -0.125 : w === 'rifle' ? -0.088 : m.ads.z); // the pistol held out at arm's length; the rifle near enough for its red-dot sight's window to be a good size
      // The bazooka lies on your shoulder, the tube beside your face: held up to its side sight the tube fills
      // half the view. So aiming holds it lower, and you look along its top with the crosshair.
      if (w === 'bazooka') m.ads.set(0.012, -0.06, -0.1);
      const tip = model.getObjectByName('muzzle')!;
      m.muzzle.position.copy(tip.position);
      m.flash.position.copy(tip.position);
    }
    for (const s of sleeves) s.color.set(this.sleeve);
    // A scope already on: on the loaded guns now.
    for (const s of this.scopes.values()) s.removeFromParent();
    this.scopes.clear();
    if (this.scopeOn) this.setKit([...this.bigMags], true);
  }

  /** The sleeves in the colour of your suit, as the others see your figure (net/swat.ts). */
  setSleeve(color: string): void {
    if (color === this.sleeve) return;
    this.sleeve = color;
    for (const m of sleeves) m.color.set(color);
  }

  /** A gun's magazine: its own, or half as big again with the bigger ammo pack (Zombies). */
  magOf(w: WeaponId): number {
    return Math.round(SPECS[w].mag * (this.bigMags.has(w) ? LOOT.bigMag : 1));
  }

  /** Whether gun `w` has a scope on (Zombies: the rifle and the pistol, once you found one). */
  hasScope(w: WeaponId): boolean {
    return this.scopeOn && LOOT.scoped.includes(w);
  }

  /**
   * What the Zombies game's rewards gave you: the guns with the bigger magazines, and the scope.
   * `fresh`: the gun of an ammo pack just taken, filled up now.
   */
  setKit(ammo: string[], scope: boolean, fresh?: string): void {
    this.bigMags = new Set(ammo.filter((w): w is WeaponId => w in SPECS));
    if (fresh && fresh in SPECS) {
      this.ammo[fresh as WeaponId] = this.magOf(fresh as WeaponId);
      if (fresh === this.current) this.reloading = 0;
    }
    for (const w of WEAPON_IDS) this.ammo[w] = Math.min(this.ammo[w], this.magOf(w));
    this.scopeOn = scope;
    for (const w of LOOT.scoped as WeaponId[]) {
      // The scope takes the place of the rifle's red-dot sight on the rail.
      const optic = this.models[w].gun.getObjectByName(`${w}_optic`);
      if (optic) optic.visible = !scope;
      let s = this.scopes.get(w);
      if (scope && !s) {
        s = scopeOn(this.models[w].gun, w, this.models[w].flash);
        this.scopes.set(w, s);
      }
      if (s) s.visible = scope;
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

  /** Looking through the sniper scope, or a found one (the view model hides, the scope overlay shows). */
  get scoped(): boolean {
    return this.enabled && !this.hiddenFlag && (this.current === 'sniper' || this.hasScope(this.current)) && this.aim > 0.85 && this.reloading <= 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.settle();
    this.show();
  }

  /**
   * Nothing left in the air or owed: the sniper rifle's bullets on their way, the recoil's climb still to come
   * back, the burst. The weapon stands still while it is off, so a bullet would fly on and the view slide
   * down whenever it came back.
   */
  private settle(): void {
    this.bullets.length = 0;
    this.kickDebt = this.recover = this.selfPitch = 0;
    this.burst = 0;
    this.recoil.fill(0);
    this.recoilVel.fill(0);
  }

  /** Hidden while you are dead. */
  set hidden(v: boolean) {
    this.hiddenFlag = v;
    this.show();
  }

  get status(): string {
    if (!this.enabled) return '';
    return this.reloading > 0 ? t(paintball.on ? 'paint.refilling' : 'weapon.reloading') : `${this.ammo[this.current]} / ${this.magOf(this.current)}`;
  }

  /** For the weapon list on screen. */
  get slots(): { id: WeaponId; name: string; slot: number; owned: boolean; current: boolean }[] {
    return WEAPON_IDS.map((id) => ({ id, name: SPECS[id].name, slot: SPECS[id].slot, owned: this.owned.has(id), current: id === this.current }));
  }

  /** Full magazines (after respawning). */
  refill(): void {
    for (const w of WEAPON_IDS) {
      this.ammo[w] = this.magOf(w);
      this.bloom[w] = 0;
    }
    this.reloading = 0;
  }

  /** Back to just the pistol (after dying), plus `extra` (the admin's bazooka). */
  resetLoadout(extra: WeaponId[] = []): void {
    this.owned = new Set(['pistol', ...extra]);
    this.select('pistol');
    this.refill();
    this.settle();
  }

  /** How fast you walk with the gun in your hands, of your free pace: slower with the heavy ones, and a quarter slower again aiming. */
  get carrySpeed(): number {
    return this.enabled ? WEIGHT[this.current] * (1 - 0.25 * this.aim) : 1;
  }

  /**
   * The guns you carry are these now, with the pistol (as the server has them, or as you chose alone): the
   * gun in your hands stays if it is among them, the magazines as they were.
   */
  setOwned(list: string[]): void {
    this.owned = new Set<WeaponId>(['pistol', ...list.filter((w): w is WeaponId => w in SPECS)]);
    if (!this.owned.has(this.current)) this.select('pistol');
  }

  /** The admin's weapons: carried by the admin and when playing alone, by nobody else. */
  setAdminWeapons(on: boolean): void {
    for (const w of WEAPON_IDS.filter((id) => SPECS[id].admin)) {
      if (on) this.owned.add(w);
      else this.owned.delete(w);
    }
    if (!this.owned.has(this.current)) this.select('pistol');
  }

  /** A rocket or grenade exploding at `at` (anyone's): a long rumble. In paintball the splash makes its own sound (effects.ts). */
  boom(at: THREE.Vector3): void {
    if (!paintball.on) this.sound('shot', 1, at, 'bazooka', BOOM);
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
    this.ammo[w] = this.magOf(w);
    this.select(w);
  }

  select(w: WeaponId): void {
    if (!this.owned.has(w) || w === this.current) return;
    this.previous = this.current;
    this.current = w;
    this.reloading = 0;
    this.cooldown = Math.max(this.cooldown, 0.25);
    // On screen the gun in your hands drops away first (update); out of sight the next is there at once.
    if (!this.enabled || this.hiddenFlag) {
      this.shown = w;
      this.raise = 0;
      this.show();
    }
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
    if (this.enabled && this.reloading <= 0 && this.ammo[this.current] < this.magOf(this.current)) {
      // A magazine with rounds left comes out quicker than an empty gun is made ready again
      // (not the shotgun, loaded shell by shell, nor the bazooka).
      const quick = this.ammo[this.current] > 0 && this.current !== 'shotgun' && this.current !== 'bazooka';
      this.reloadTime = this.spec.reload * (quick ? 0.8 : 1);
      this.reloading = this.reloadTime;
      this.sound('reload');
    }
  }

  /** Advance before checking the trigger. Only held automatic fire carries a small timing remainder. */
  advanceFire(dt: number, held: boolean): void {
    const floor = held && this.isAuto && this.cooldown > 0 ? -Math.min(dt, this.spec.delay * 0.3) : 0;
    this.cooldown = Math.max(floor, this.cooldown - dt);
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
    this.cooldown = spec.delay + (spec.auto ? this.cooldown : 0);
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
      const hit = this.raycaster.intersectObjects(this.scene.children, true).find((h) => drawn(h.object) && !h.object.userData.ignoreRay && h.distance <= spec.rocket!.range);
      const to = hit ? hit.point.clone() : this.raycaster.ray.at(spec.rocket.range, new THREE.Vector3());
      if (this.ammo[this.current] === 0) this.reload();
      return { pitch: spec.kick, yaw: 0, rocket: { from, to } };
    }

    const spread = this.spread;
    // Held automatic fire opens up, shot by shot (the crosshair shows it); short bursts stay tight.
    if (spec.auto) this.bloom[this.current] = Math.min(0.01, this.bloom[this.current] + 0.002);
    // Through a scope the shot goes where the reticle is, and that drifts with your breath (update).
    const aspect = this.camera.aspect || 1;
    const at = this.scoped ? this.drift : NO_DRIFT;

    this.camera.updateMatrixWorld();
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    // Paintball: each pellet is a paintball from the muzzle, in the gun's paint.
    const paint = paintball.on ? { from: this.models[this.current].muzzle.getWorldPosition(new THREE.Vector3()), color: new THREE.Color(GUN_PAINT[this.current]), size: SPLAT[this.current] } : null;
    const players = new Map<string, { body: number; head: number; point: THREE.Vector3; spot?: Spot }>();
    const zombies = new Map<number, ZombieHit>();
    let tracer: THREE.Vector3 | undefined;
    for (let i = 0; i < spec.pellets; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = spread * Math.sqrt(Math.random());
      this.raycaster.setFromCamera(new THREE.Vector2((at.x + Math.cos(a) * r) / aspect, at.y + Math.sin(a) * r), this.camera);
      // The sniper rifle's bullet takes its time and falls on the way (update flies it); paint and the other guns land at once.
      if (this.current === 'sniper' && !paint) {
        this.bullets.push({
          pos: this.raycaster.ray.origin.clone(), vel: this.raycaster.ray.direction.clone().multiplyScalar(BULLET_SPEED),
          left: this.raycaster.far, clear: 0, pass: { free: 0, left: 1 },
        });
        tracer = this.raycaster.ray.at(this.raycaster.far, new THREE.Vector3());
        continue;
      }
      const end = this.strike(spec, this.current, paint, eye, players, zombies);
      if (!paint && this.current === 'rifle' && this.ammo.rifle % 3 === 0) {
        tracer = end.point ?? this.raycaster.ray.at(200, new THREE.Vector3());
        this.onTracer(this.muzzlePoint(), tracer);
      }
      if (end.clown) break;
    }
    for (const [name, e] of players) this.onPlayerHit(name, e.body, e.head, e.point, e.spot, this.current);
    if (zombies.size) this.onZombieHit([...zombies.values()], paint, this.current);
    if (this.ammo[this.current] === 0) this.reload();
    return { ...this.kickOf(spec), tracer };
  }

  /**
   * What the ray now in the raycaster hits within `reach` metres, for gun `w`: a zombie or a player goes
   * into `zombies` or `players` (the caller tells the game once the shot's pellets are counted), the rest
   * is told at once (a clown, a cat, a pane, a surface). Returns where it ended, and whether on a clown
   * (which ends a shotgun's volley).
   *
   * The rifle's and the sniper rifle's bullets go through one piece of thin cover (COVER: a hedge, a
   * wooden door or table, a wire fence) and on to what is behind it; `pass` keeps count along the ray.
   */
  private strike(
    spec: Spec, w: WeaponId, paint: (Paint & { from: THREE.Vector3 }) | null, eye: THREE.Vector3,
    players: Map<string, { body: number; head: number; point: THREE.Vector3; spot?: Spot }>, zombies: Map<number, ZombieHit>,
    reach = Infinity, pass = { free: 0, left: !paint && (w === 'rifle' || w === 'sniper') ? 1 : 0 },
  ): { point?: THREE.Vector3; clown?: boolean } {
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    let hit: THREE.Intersection | undefined;
    for (const h of hits) {
      if (h.distance > reach) break;
      if (!drawn(h.object) || h.object.userData.ignoreRay || !h.face) continue;
      const depth = COVER[String(h.object.userData.material ?? '')];
      if (depth && h.distance < pass.free) continue; // still inside the cover it is going through
      if (depth && pass.left > 0) {
        pass.left--;
        pass.free = h.distance + depth;
        this.onImpact(h.point.clone(), h.face.normal.clone().transformDirection(h.object.matrixWorld), String(h.object.userData.material), h.object, w);
        continue;
      }
      hit = h;
      break;
    }
    if (paint) this.onPaintball(paint.from, hit ? hit.point : this.raycaster.ray.at(120, new THREE.Vector3()), paint);
    if (!hit || !hit.face) return {};
    const point = hit.point.clone();
    const player = hit.object.userData.player as string | undefined;
    const zombie = hit.object.userData.zombie as number | undefined;
    if (zombie !== undefined) {
      const e = zombies.get(zombie) ?? { id: zombie, body: 0, head: 0, legs: 0, point: hit.point.clone(), ray: this.raycaster.ray.clone() };
      if (hit.object.userData.part === 'head') e.head++;
      else {
        e.body++;
        if (lowOnBox(hit)) e.legs++;
      }
      zombies.set(zombie, e);
      // The sniper's bullet goes on through it: the next zombie behind on the same line, if nothing else
      // (a wall, a pane, a player) comes first. Its own other hit box doesn't count.
      for (let k = hits.indexOf(hit) + 1, left = (spec.pierce ?? 1) - 1; left > 0 && k < hits.length; k++) {
        const h = hits[k];
        if (!drawn(h.object) || h.object.userData.ignoreRay || !h.face) continue;
        const next = h.object.userData.zombie as number | undefined;
        if (next === zombie || (next !== undefined && zombies.has(next))) continue;
        if (next === undefined) break;
        zombies.set(next, { id: next, body: h.object.userData.part === 'head' ? 0 : 1, head: h.object.userData.part === 'head' ? 1 : 0, legs: h.object.userData.part !== 'head' && lowOnBox(h) ? 1 : 0, point: h.point.clone(), ray: this.raycaster.ray.clone() });
        left--;
      }
      return { point };
    }
    if (hit.object.userData.clown !== undefined) {
      this.onClownHit(hit.object.userData.clown, hit.point.clone(), paint ? this.spot(hits, hit, false) : undefined);
      return { point, clown: true };
    }
    if (hit.object.userData.cat !== undefined) {
      this.onCatHit(hit.object.userData.cat, hit.point.clone());
    } else if (player) {
      const e = players.get(player) ?? { body: 0, head: 0, point: hit.point.clone(), spot: paint ? this.spot(hits, hit, true) : undefined };
      if (hit.object.userData.part === 'head') e.head++;
      else e.body++;
      players.set(player, e);
    } else if (hit.object.userData.glassIndex !== undefined) {
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      this.onGlassHit(hit.object.userData.glassIndex, hit.point.clone(), eye, normal, hit.object, w);
    } else {
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      this.onImpact(hit.point.clone(), normal, String(hit.object.userData.material ?? ''), hit.object, w);
    }
    return { point };
  }

  /**
   * The sniper rifle's bullets on their way: each flies BULLET_SPEED and falls as anything does, so a
   * far shot lands a moment later and lower (aim a little high, and ahead of someone running). It goes
   * its stretch each frame and strikes what lies ahead, looked up BULLET_LOOK metres at a time. It shows as a streak. A bullet still in
   * the air when you put the rifle away lands without counting: the server takes a hit only from
   * the gun in your hands.
   */
  private fly(dt: number): void {
    if (!this.bullets.length) return;
    const spec = SPECS.sniper;
    const far = this.raycaster.far;
    for (const b of [...this.bullets]) {
      const step = b.vel.clone().multiplyScalar(dt);
      const len = step.length();
      if (len <= 0) continue;
      b.vel.y -= 9.81 * dt;
      // The wind pushes it sideways a little (world/wind.ts; the scope shows which way).
      const wind = windAt(b.pos.x, b.pos.z);
      b.vel.x += wind.x * WIND_PUSH * dt;
      b.vel.z += wind.z * WIND_PUSH * dt;
      // What lies ahead is looked up BULLET_LOOK metres at a time, not every frame: a look through the whole
      // world costs about 3 ms, and a bullet is in the air for up to half a second. So about every third frame,
      // and a hit shows at most a twentieth of a second before the streak gets there.
      let end: { point?: THREE.Vector3 } = {};
      if (b.clear < len) {
        this.raycaster.set(b.pos, step.clone().divideScalar(len));
        this.raycaster.far = Math.min(b.left, BULLET_LOOK + 25); // a little past the look: a second zombie behind the first (strike stops the first hit at the look's end)
        const players = new Map<string, { body: number; head: number; point: THREE.Vector3; spot?: Spot }>();
        const zombies = new Map<number, ZombieHit>();
        end = this.strike(spec, 'sniper', null, b.pos, players, zombies, Math.min(b.left, BULLET_LOOK), b.pass);
        if (this.current === 'sniper') {
          for (const [name, e] of players) this.onPlayerHit(name, e.body, e.head, e.point, e.spot, 'sniper');
          if (zombies.size) this.onZombieHit([...zombies.values()], null, 'sniper');
        }
        b.clear = BULLET_LOOK;
      }
      const to = end.point ?? b.pos.clone().add(step);
      this.onBullet(b.pos.clone(), to, dt);
      b.left -= len;
      b.clear -= len;
      b.pass.free -= len;
      b.pos.copy(to);
      if (end.point || b.left <= 0) this.bullets.splice(this.bullets.indexOf(b), 1);
    }
    this.raycaster.far = far;
  }

  /**
   * The view's kick for this shot. Held automatic fire follows a pattern you can learn instead of
   * chance: the barrel climbs for the first eight shots, then stays about level and weaves left and
   * right. Half of the climb comes back by itself once you let go (update, takeRecover).
   */
  private kickOf(spec: Spec): Shot {
    const i = this.burst++;
    const k = spec.kick * (1 - 0.4 * this.aim);
    if (!spec.auto) {
      const pitch = k * (0.9 + Math.random() * 0.2);
      this.kickDebt += pitch * 0.5;
      this.selfPitch += pitch;
      return { pitch, yaw: (Math.random() - 0.5) * k * 0.2 };
    }
    const pitch = k * (i < 8 ? 1.15 : 0.4) * (0.95 + Math.random() * 0.1);
    const weave = i < 2 ? 0 : 0.55 * Math.sin((i - 2) * 0.55);
    this.kickDebt = Math.min(0.12, this.kickDebt + pitch * 0.5);
    this.selfPitch += pitch;
    return { pitch, yaw: k * (weave + (Math.random() - 0.5) * 0.2) };
  }

  /**
   * How wide the next shot can land from the middle of the view, in half view heights: what the
   * crosshair shows. A circle on the screen whatever the window's shape (it was wider than tall
   * on a wide screen); 1.3 keeps its area as it was at 16:9.
   */
  get spread(): number {
    const spec = this.spec;
    if (spec.rocket) return 0;
    // The sniper rifle is only accurate through the scope; aiming steadies the others.
    let spread = this.current === 'sniper'
      ? (this.aim > 0.85 ? .015 * Math.max(0, this.spreadMul - 1) : spec.hipSpread ?? 0.09)
      : spec.spread * (1 - (spec.pellets > 1 ? .25 : .6) * this.aim);
    if (this.hasScope(this.current) && this.aim > 0.85) spread *= 0.25; // steady through a found scope
    return (spread * this.spreadMul * this.rest + this.bloom[this.current]) * 1.3;
  }

  /**
   * Where the muzzle would be at the gun's real size (the gun in your hands is drawn small and
   * close): what leaves it starts here, smoke and tracers. Lower right from the hip, in the
   * middle of the view when aimed.
   */
  muzzlePoint(): THREE.Vector3 {
    const q = this.camera.getWorldQuaternion(new THREE.Quaternion());
    const loose = 1 - this.aim;
    return this.camera.getWorldPosition(new THREE.Vector3())
      .add(new THREE.Vector3(0.13 * loose, -0.05 - 0.07 * loose, this.current === 'pistol' ? -0.6 : -0.95).applyQuaternion(q));
  }

  /**
   * The turn the gun asks of the view this frame (rad, to take off the pitch): the recoil's climb
   * coming back down after the burst.
   */
  takeRecover(): number {
    const d = this.recover;
    this.recover = 0;
    this.selfPitch -= d;
    return d;
  }

  /**
   * The picture through the scope (ui/scope.ts), in half view heights: where the reticle is, how far
   * the dark edge has crept in (you turned or fired: your eye is off the scope's line for a moment),
   * and your breath.
   */
  get scopeView(): { x: number; y: number; shadeX: number; shadeY: number; breath: number; winded: boolean; wind: number | null } {
    // The wind across your line of sight, m/s (to the right positive): only the sniper rifle's bullet flies and feels it.
    const e = this.camera.matrixWorld.elements;
    const blow = windAt(e[12], e[14]);
    return {
      wind: this.current === 'sniper' && !paintball.on ? blow.x * e[0] + blow.z * e[2] : null,
      x: this.drift.x, y: this.drift.y,
      shadeX: -this.lag.x * 0.035, shadeY: this.lag.y * 0.035 + this.recoil[1] * 1.6,
      breath: this.breath, winded: this.winded,
    };
  }

  /**
   * Paintball: where the paint of a pellet that hit a figure's hit box sticks. Figures are drawn
   * inside their hit boxes, so it is the first surface of the figure itself along the same ray
   * (the raycast found those too). A player's paint moves with the hit box (the head's follows the
   * head, and both hide while the player is out); a clown's or strongman's with his body part.
   */
  private spot(hits: THREE.Intersection[], hit: THREE.Intersection, player: boolean): Spot {
    const figure = figureOf(hit.object);
    const scale = figure?.scale.x ?? 1;
    const body = figure
      ? hits.find((h) => {
          const m = (h.object as THREE.Mesh).material;
          return h !== hit && !!h.face && h.object.visible && !Array.isArray(m) && !!m?.visible && h.distance > hit.distance - 0.3 && h.distance < hit.distance + 1.5 * scale && figureOf(h.object) === figure;
        })
      : undefined;
    const back = this.raycaster.ray.direction.clone().negate();
    if (!body) return { point: hit.point.clone(), normal: back, on: hit.object, scale };
    const normal = body.face!.normal.clone().transformDirection(body.object.matrixWorld);
    return { point: body.point.clone(), normal: normal.dot(back) < 0 ? back : normal, on: player ? hit.object : body.object, scale };
  }

  /**
   * `look`: where the player looks, sideways step input (-1..1, right positive), sprinting
   * and being in the air; this drives how the gun moves with the body.
   */
  update(dt: number, moving: number, aiming: boolean, look?: { yaw: number; pitch: number; side: number; sprint: boolean; air: boolean; steady?: boolean }): void {
    if (!this.enabled) return;
    const spec = this.spec;
    this.clock += dt;
    this.fly(dt);
    const cycleBefore = this.cycleTime;
    this.cycleTime = Math.max(0, this.cycleTime - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.ammo[this.current] = this.magOf(this.current);
    }
    // It closes again once you let go. (It used to close faster than held fire could open it, so it never showed.)
    if (this.sinceShot > 0.15) for (const w of WEAPON_IDS) this.bloom[w] = Math.max(0, this.bloom[w] - dt * 0.06);
    this.flashTime = Math.max(0, this.flashTime - dt);
    handFlash.value = this.enabled && !this.hiddenFlag && !paintball.on ? this.flashTime / 0.05 : 0; // the flash on your hands (world/gunSurface.ts)
    // Switching: the gun in your hands drops away (a tenth of a second), then the next comes up.
    if (this.shown !== this.current) {
      this.raise -= dt * 10;
      if (this.raise <= 0) {
        this.raise = 0;
        this.shown = this.current;
        this.show();
      }
    } else this.raise = Math.min(1, this.raise + dt * 4.5);
    const m = this.models[this.shown];
    m.flash.visible = this.flashTime > 0 && this.shown === this.current;
    this.sway += dt * (1.5 + moving * 4);
    this.sinceShot += dt;
    // Raising the sights takes as long as the gun is heavy: the pistol is up at once, the sniper rifle last.
    this.aim += ((aiming && this.reloading <= 0 ? 1 : 0) - this.aim) * (1 - Math.exp(-dt * AIM_SPEED[this.current]));
    const ease = (k: number) => 1 - Math.exp(-dt * k);

    // The burst ends a moment after its last shot; then half of the climb comes back down, unless
    // you already pulled the view down yourself (that pays the debt off first).
    if (this.sinceShot > Math.max(0.3, Math.min(0.5, spec.delay * 1.5))) this.burst = 0;
    if (look && this.lastLook) {
      const own = look.pitch - this.lastLook.pitch - this.selfPitch;
      if (own < 0) this.kickDebt = Math.max(0, this.kickDebt + own);
    }
    this.selfPitch = 0;
    if (this.kickDebt > 0 && this.sinceShot > Math.min(0.22, spec.delay * 1.6)) {
      const back = this.kickDebt < 0.0002 ? this.kickDebt : this.kickDebt * ease(7);
      this.kickDebt -= back;
      this.recover += back;
    }

    // Through a scope the reticle drifts with your breath, a slow figure of eight: less crouched,
    // more on the move. Holding your breath (`steady`) stills it for about four seconds; out of
    // breath it drifts wider until you have some back.
    const holding = !!look?.steady && this.scoped && !this.winded && this.breath > 0;
    this.breath = Math.max(0, Math.min(1, this.breath + (holding ? -dt / 4 : dt / 5)));
    if (this.breath <= 0) this.winded = true;
    else if (this.breath > 0.5) this.winded = false;
    if (this.scoped) {
      const amp = 0.011 * Math.min(2.2, this.spreadMul) * this.rest * (holding ? 0.12 : this.winded ? 1.7 : 1) * (document.body.classList.contains('touch') ? 0.6 : 1);
      this.driftAmp += (amp - this.driftAmp) * ease(5);
      const t = this.clock;
      this.drift.set(
        this.driftAmp * (Math.sin(t * 0.9) + 0.25 * Math.sin(t * 2.3 + 1)),
        this.driftAmp * (0.6 * Math.sin(t * 1.8) + 0.2 * Math.sin(t * 3.1)),
      );
    } else {
      this.driftAmp = 0;
      this.drift.set(0, 0);
    }

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

    // Hip position lower right; aiming brings the sights to the centre of the view. With the touch
    // controls the gun is held further in and up, clear of the buttons in the lower right.
    const pos = m.hip.clone();
    if (document.body.classList.contains('touch')) pos.add(TOUCH_HIP);
    pos.lerp(m.ads, this.aim);
    // Walking: a figure of eight, the gun dropping a little on each step and swinging across with
    // the stride, rolling with it; bigger running, much smaller aimed.
    const bob = (1 - this.aim * 0.8) * Math.min(1, moving) * (1 + this.sprint * 0.8);
    const across = Math.sin(this.sway);
    const step = Math.abs(Math.cos(this.sway));
    const breathe = Math.sin(this.clock * 1.6) * (1 - this.aim * 0.7);
    const raised = 1 - (1 - this.raise) * (1 - this.raise); // eased: quick at first, settling in
    pos.x += across * 0.0045 * bob + this.lag.x * 0.0022 * loose - this.sprint * 0.012;
    pos.y += step * 0.0045 * bob - (1 - raised) * 0.08 - this.lag.y * 0.0018 * loose + breathe * 0.0012 + this.dip * 0.3 - this.sprint * 0.022;
    pos.z += this.recoil[0] * (spec.pellets > 1 || this.current === 'sniper' ? 1.4 : 1);

    // Reload (p from 0 to 1): the gun comes in towards the middle, muzzle up a little, turned to show where it loads.
    const p = this.reloading > 0 ? 1 - this.reloading / this.reloadTime : 0;
    const hold = this.reloading > 0 ? smooth(0, 0.14, p) * (1 - smooth(0.84, 1, p)) : 0;
    const tube = this.current === 'bazooka';
    pos.x -= hold * (tube ? 0.004 : 0.012);
    pos.y += hold * (tube ? -0.02 : 0.01);
    m.root.position.copy(pos);
    m.root.rotation.set(
      this.recoil[1] + hold * (tube ? -0.15 : 0.2) - (1 - raised) * 0.6 - this.lag.y * 0.012 * loose + breathe * 0.004 - this.sprint * 0.32 + step * 0.012 * bob,
      0.02 * (1 - this.aim) - this.lag.x * 0.016 * loose + this.sprint * 0.55 + hold * (tube ? 0 : 0.15),
      this.recoil[2] * 2 - this.tilt * 0.06 + this.sprint * 0.22 - across * 0.025 * bob,
    );
    m.gun.rotation.z = hold * (tube ? -0.1 : 0.4);
    // Standing still with nothing to do, you turn the gun over in your hands now and then and look at it.
    const idle = moving < 0.05 && !aiming && this.reloading <= 0 && this.sinceShot > 6 && this.shown === this.current && !look?.air;
    this.idle = idle ? this.idle + dt : 0;
    const turn = (this.idle + 6) % 11; // first after five seconds, then every eleven
    this.look += ((idle && turn < 3.2 ? 1 : 0) - this.look) * ease(3);
    if (this.look > 0.001 && !tube) {
      m.root.rotation.z += 0.42 * this.look;
      m.root.rotation.y += 0.3 * this.look;
      m.root.rotation.x += 0.08 * this.look;
      m.root.position.x -= 0.012 * this.look;
      m.root.position.y += 0.012 * this.look;
    }
    this.animateParts(m, p);
    // Pump or bolt worked: its click, and the spent case comes out.
    if ((this.current === 'shotgun' || this.current === 'sniper') && cycleBefore > spec.delay * 0.6 && this.cycleTime <= spec.delay * 0.6) {
      this.sound('cycle');
      this.onEject(this.current);
    }

    m.root.visible = !this.scoped && !this.hiddenFlag;
    // The same size on screen whatever the field of view: the view model is stretched across the view
    // by as much as a wider view would shrink it (the picture is exactly the one at 72 degrees).
    const wide = Math.tan((this.baseFov * Math.PI) / 360) / Math.tan((72 * Math.PI) / 360);
    this.root.scale.set(wide, wide, 1);
    // A found scope zooms further: 0.3 on the rifle, 0.42 on the pistol (the sniper's 0.22).
    const zoom = this.hasScope(this.current) ? (this.current === 'rifle' ? 0.3 : 0.42) : spec.zoom;
    const fov = this.baseFov * (1 - (1 - zoom) * this.aim);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * The moving parts and the hands (`p`: how far a reload is, 0 when there is none). Each starts
   * from where it rests every frame, so nothing adds up. Only what is drawn: the gun on show.
   */
  private animateParts(m: ViewModel, p: number): void {
    for (const o of [m.mag, m.pump, m.bolt, m.slide, m.rocket, m.handR, m.handL]) {
      if (!o) continue;
      o.position.copy(o.userData.rest as THREE.Vector3);
      if (o.userData.restQ) o.quaternion.copy(o.userData.restQ as THREE.Quaternion);
    }
    if (m.shell) m.shell.visible = false;
    if (this.shown !== this.current) return; // dropping away: as it was
    const w = this.current;
    const spec = this.spec;
    const reloading = this.reloading > 0;
    const empty = this.ammo[w] === 0;
    const left = m.handL ? _left.set(0, 0, 0) : null; // how far the left hand moves from where it holds

    // The pistol's slide: back with each shot and straight home; open while empty, closing as a reload ends.
    if (m.slide) {
      let back = this.sinceShot < 0.025 ? this.sinceShot / 0.025 : Math.max(0, 1 - (this.sinceShot - 0.025) / 0.06);
      if (empty) back = reloading ? 1 - smooth(0.76, 0.8, p) : 1;
      m.slide.position.z += back * 0.022;
    }
    // After each shot the left hand works the shotgun's pump (back and forward).
    const cyc = this.cycleTime > 0 ? Math.sin(Math.min(1, (spec.delay - this.cycleTime) / (spec.delay * 0.7)) * Math.PI) : 0;
    if (m.pump) {
      m.pump.position.z += cyc * 0.09;
      if (left && !reloading) left.z += cyc * 0.09;
    }
    // The sniper rifle's bolt: after a shot, and at the end of a reload. The right hand leaves the grip for its knob.
    if (m.bolt) {
      const phase = this.cycleTime > 0 ? (spec.delay - this.cycleTime) / (spec.delay * 0.75) : reloading && p > 0.7 ? (p - 0.7) / 0.25 : -1;
      if (phase >= 0 && phase <= 1) {
        const lift = smooth(0.12, 0.26, phase) * (1 - smooth(0.66, 0.8, phase));
        const pull = smooth(0.28, 0.46, phase) * (1 - smooth(0.5, 0.66, phase));
        m.bolt.rotation.z = lift * 1.1;
        m.bolt.position.z += pull * 0.075;
        const knob = m.bolt.userData.knob as number[] | undefined;
        if (m.handR && knob) {
          m.bolt.updateMatrix();
          const at = _a.fromArray(knob).applyMatrix4(m.bolt.matrix);
          const reach = smooth(0, 0.14, phase) * (1 - smooth(0.82, 1, phase));
          m.handR.position.addScaledVector(at.sub(holdPoint(m.handR, _b)), reach);
        }
      }
    }
    // The bazooka's rocket: gone with the shot, back as the reload brings a new one.
    if (m.rocket) m.rocket.visible = !empty || (reloading && p > 0.42);
    if (!reloading) return;
    const out = _out.fromArray((m.mag?.userData.out as number[] | undefined) ?? [0, -1, 0]);
    if (m.mag) {
      // The magazine slides out and falls; a new one comes up with the left hand and is pushed home.
      let d = 0;
      if (p >= 0.12 && p < 0.2) d = smooth(0.12, 0.2, p) * 0.05;
      else if (p >= 0.2 && p < 0.34) d = 0.05 + 4.9 * ((p - 0.2) * spec.reload) ** 2;
      else if (p >= 0.46 && p < 0.64) d = (1 - smooth(0.46, 0.64, p)) * 0.12;
      m.mag.visible = !(p >= 0.34 && p < 0.46);
      m.mag.position.addScaledVector(out, d);
      if (left) {
        // The hand's hold on the bottom of the new magazine.
        const base = _a.copy(m.mag.position).addScaledVector(out, (m.mag.userData.len as number) ?? 0.08);
        const toMag = base.sub(holdPoint(m.handL!, _b));
        if (p < 0.3) left.copy(AWAY).multiplyScalar(smooth(0.1, 0.3, p));
        else if (p < 0.46) left.copy(AWAY);
        else if (p < 0.68) left.copy(AWAY).lerp(toMag, smooth(0.46, 0.6, p));
        else left.copy(toMag).multiplyScalar(1 - smooth(0.68, 0.84, p));
      }
    } else if (w === 'shotgun' && left) {
      // Four shells, one by one, pushed up into the loading port under the receiver.
      const port = _a.copy(PORT).sub(holdPoint(m.handL!, _b));
      const k = Math.min(3, Math.floor(Math.max(0, p - 0.1) / 0.18));
      const q = (p - 0.1 - k * 0.18) / 0.18;
      if (p < 0.1) left.copy(AWAY_LOW).multiplyScalar(smooth(0.02, 0.1, p));
      else if (q < 0.35) left.copy(AWAY_LOW).lerp(port, smooth(0, 0.35, q));
      else if (q < 0.55) left.copy(port).y += smooth(0.35, 0.55, q) * 0.025;
      else if (k < 3) left.copy(port).setY(port.y + 0.025).lerp(AWAY_LOW, smooth(0.55, 1, q));
      else left.copy(port).setY(port.y + 0.025).multiplyScalar(1 - smooth(0.55, 1, q));
      if (m.shell) m.shell.visible = p >= 0.1 && q < 0.5;
    } else if (m.rocket && left) {
      // A new rocket: the hand brings it up in front of the tube and slides it in.
      const slide = (1 - smooth(0.42, 0.62, p)) * 0.3;
      m.rocket.position.z -= slide;
      const at = _a.copy(m.rocket.position).add(ROCKET_HOLD).sub(holdPoint(m.handL!, _b));
      if (p < 0.28) left.copy(AWAY).multiplyScalar(smooth(0.08, 0.28, p));
      else if (p < 0.42) left.copy(AWAY);
      else if (p < 0.62) left.copy(AWAY).lerp(at, smooth(0.42, 0.5, p));
      else left.copy(at).multiplyScalar(1 - smooth(0.62, 0.8, p));
    }
    if (left && m.handL) m.handL.position.add(left);
  }

  /** A bullet that passed close by you: a short hiss falling in pitch, in your ears (`near` 0..1: how close). */
  whizz(near: number): void {
    const ctx = sound.context();
    const dest = sound.out();
    if (!ctx || !dest || paintball.on) return;
    const t = ctx.currentTime;
    const air = ctx.createBufferSource();
    air.buffer = noiseBuffer(ctx, 'whizz', 0.16, (s) => Math.sin(Math.PI * s));
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 2.5;
    band.frequency.setValueAtTime(5200, t);
    band.frequency.exponentialRampToValueAtTime(1400, t + 0.15);
    const gain = ctx.createGain();
    gain.gain.value = 0.18 + 0.3 * Math.max(0, Math.min(1, near));
    air.connect(band).connect(gain).connect(dest);
    air.start(t);
  }

  /** Another player's shot (or a turret's, at a lower `volume`): that weapon's sound, from where they stand. */
  remoteShot(at: THREE.Vector3, w: WeaponId = 'pistol', volume = 1): void {
    this.sound('shot', volume, at, w);
  }

  private show(): void {
    for (const [w, m] of Object.entries(this.models)) m.root.visible = this.enabled && !this.hiddenFlag && w === this.shown;
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
    if (kind === 'shot' && paintball.on) {
      // Paintball's pop: a puff of air through a band of noise, a soft thump, and a hiss after it.
      const p = POP[w];
      const len = p.len + 0.25;
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const s = i / ctx.sampleRate;
        data[i] = (Math.random() * 2 - 1) * (s < p.len ? Math.pow(1 - s / p.len, 3) : 0) + (Math.random() * 2 - 1) * 0.06 * Math.max(0, 1 - s / len);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 0.9;
      band.frequency.setValueAtTime(p.f * 1.4, t);
      band.frequency.exponentialRampToValueAtTime(p.f * 0.7, t + p.len);
      noise.connect(band).connect(out);
      const thump = ctx.createOscillator();
      thump.frequency.setValueAtTime(p.thump, t);
      thump.frequency.exponentialRampToValueAtTime(p.thump * 0.5, t + 0.08);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.5, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      thump.connect(tg).connect(out);
      out.gain.setValueAtTime(p.gain, t);
      noise.start(t);
      thump.start(t);
      thump.stop(t + 0.12);
    } else if (kind === 'shot') {
      const v = voice;
      // A shot far away: it reaches you later (sound does 343 m/s), duller, and more of it is the
      // echo rolling over the fields. Your own: a hard crack on top, at once.
      const far = at ? Math.min(500, at.distanceTo(this.camera.getWorldPosition(new THREE.Vector3()))) : 0;
      const t0 = t + far / 343;
      const dull = 1 / (1 + far / 70);
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer(ctx, `shot${v.len}`, v.len, (s) => Math.pow(1 - s, 4));
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(Math.max(500, v.f0 * dull), t0);
      filter.frequency.exponentialRampToValueAtTime(Math.max(90, v.f1 * dull), t0 + v.len);
      noise.connect(filter).connect(out);
      const thump = ctx.createOscillator();
      thump.frequency.setValueAtTime(v.thump, t0);
      thump.frequency.exponentialRampToValueAtTime(35, t0 + 0.14);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.8, t0);
      tg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
      thump.connect(tg).connect(out);
      out.gain.setValueAtTime(v.gain, t0);
      noise.start(t0);
      thump.start(t0);
      thump.stop(t0 + 0.2);
      if (voice === VOICE[w]) {
        // The crack: a few milliseconds of bright noise, only from near by.
        if (far < 60) {
          const crack = ctx.createBufferSource();
          crack.buffer = noiseBuffer(ctx, 'crack', 0.02, (s) => Math.pow(1 - s, 2));
          const high = ctx.createBiquadFilter();
          high.type = 'highpass';
          high.frequency.value = 2200;
          const cg = ctx.createGain();
          cg.gain.value = 0.55 * (1 - far / 60);
          crack.connect(high).connect(cg).connect(out);
          crack.start(t0);
        }
        // The echo after it: low noise that swells a moment after the shot and rolls away; longer for the big guns.
        const tailLen = 0.5 + v.len * 1.4;
        const tail = ctx.createBufferSource();
        tail.buffer = noiseBuffer(ctx, `tail${tailLen.toFixed(2)}`, tailLen, (s) => Math.min(1, s * 12) * Math.pow(1 - s, 2.5));
        const low = ctx.createBiquadFilter();
        low.type = 'lowpass';
        low.frequency.setValueAtTime(900, t0);
        low.frequency.exponentialRampToValueAtTime(180, t0 + tailLen);
        const tailGain = ctx.createGain();
        tailGain.gain.value = 0.16 + 0.2 * (1 - dull);
        tail.connect(low).connect(tailGain).connect(out);
        tail.start(t0 + 0.03);
      }
    } else if (kind === 'throw') {
      // The pin's click, then a short whoosh rising in pitch (a paint balloon: only the whoosh).
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
      if (paintball.on) return; // a paint balloon has no pin
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
      // Clicks: empty, the pump or bolt, and in a reload what the hands do (animateParts): the magazine
      // out and home (and the pistol's slide closing, the sniper's bolt), each shell, the rocket.
      const r = this.spec.reload;
      const reload: Record<WeaponId, number[][]> = {
        pistol: [[0.13 * r, 500], [0.64 * r, 700], [0.78 * r, 900]],
        rifle: [[0.13 * r, 500], [0.64 * r, 700]],
        shotgun: [0.18, 0.36, 0.54, 0.72].map((s) => [s * r, 650]),
        sniper: [[0.13 * r, 500], [0.64 * r, 700], [0.8 * r, 420], [0.9 * r, 620]],
        bazooka: [[0.62 * r, 400]],
      };
      const clicks = kind === 'empty' ? [[0, 900]] : kind === 'cycle' ? [[0, 420], [0.12, 620]] : reload[this.current];
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
