import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gunModel, WEAPON_IDS, type WeaponId } from '../weapon';
import { muzzleFlash } from '../world/effects';

/**
 * Other players as a rigged, animated character: the "SWAT" model by
 * Quaternius (CC0, poly.pizza/m/Btfn3G5Xv4), recoloured per player, with a
 * helmet in their colour and the gun they hold.
 *
 * One mesh, one draw: the model's nine parts are merged into one skinned mesh
 * when it loads. Each part's colour comes from a small picture per player (the
 * palette: suit, gear, skin, visor, helmet), so a figure costs one draw and one
 * shadow draw, and every figure shares one shader. Its bounds are set by hand
 * (an animated body isn't where its rest pose is), so figures out of view and
 * out of the sun's shadow area cost nothing.
 *
 * Moving: the walk, run, strafe and run-back clips are blended by speed and
 * direction and all played at one shared phase of the stride, which advances
 * with the distance covered: the feet stay planted at any speed. Standing, the
 * upper body turns to where they look and the legs follow with a step when the
 * twist gets large. Crouching bends the knees (the hips go down, the legs reach
 * the feet where the clip put them). In the air the legs tuck up, and a hard
 * landing dips the knees. Flying, the legs hang and the body leans into the
 * flight. On a horse they sit in the saddle with their feet in the stirrups.
 * The head looks up and down with them, and a shot hit plays a flinch on top.
 *
 * Both hands hold the gun: after the animation has posed the body, each arm
 * is bent (two-bone IK) so the hands land on the gun's grip and fore-end.
 * Long guns sit in the right shoulder, with the chest turned a little so the
 * left hand reaches (the model's arms are short); the pistol is held out in
 * front with both hands. A shot pushes the gun back and up, and the hands
 * go with it.
 */

export interface Pose {
  /** m/s, and its parts along and across where they face */
  speed: number;
  forward: number;
  side: number;
  armed: boolean;
  alive: boolean;
  crouch: boolean;
  flying: boolean;
  pitch: number;
  weapon: WeaponId;
  /** Where they look (rad, world, as a camera's yaw): the root faces this way */
  yaw: number;
  /** How high their feet are over the ground under them (m), and how fast they rise (m/s) */
  air: number;
  vy: number;
  /** On a horse: the way it faces (as a camera's yaw); null on foot */
  seat: number | null;
  /** Metres from the camera: far figures are updated less often and hold no gun in view */
  far: number;
}

export interface Body {
  /** Feet at y = 0, facing -z */
  root: THREE.Object3D;
  /** Invisible hit boxes, userData { player, part } */
  hits: THREE.Mesh[];
  animate(dt: number, pose: Pose): void;
  /** Muzzle flash; returns where the muzzle is */
  flash(): THREE.Vector3 | null;
  /** A short flinch when hit */
  flinch?(): void;
  /** Geometry shared with other figures (not to be disposed) */
  shared?: boolean;
  /** A foot came down in the last animate (the footsteps follow the legs) */
  footfall?: boolean;
  /** How far the hips are lowered (crouching), 0..1, for the name over them */
  crouched?: number;
  /** Let go of what this figure alone uses on the graphics card */
  dispose?(): void;
}

export interface Outfit {
  main: string;
  dark: string;
}

const HEIGHT = 1.8;
/** How far the hips sit under the saddle's point when riding (m, from where the feet would be standing). */
export const SEAT_HIP = 0.8;
/**
 * Which of the model's animations to use when holding a gun. The arms are posed by IK
 * either way; these give the legs and a square, upright stance (the 'Gun_Shoot' clip
 * turns the body side-on and bows the head).
 */
export const CLIPS = { armedIdle: 'Idle_Gun_Pointing', armedRun: 'Run_Shoot' };
/**
 * The locomotion clips: how fast each carries the body when played at its own pace (m/s, from
 * the planted foot, at the figure's 1.8 m) and where in it (0..1) the left foot comes down.
 * They are all played at one phase of the stride, so the feet stay planted in any blend.
 * The walk played backwards is the walk back: there its left foot lands where it lifted.
 */
const GAIT: Record<string, { speed: number; left: number }> = {
  Walk: { speed: 1.35, left: 0.03 },
  Walk_Back: { speed: 1.35, left: 0.63 },
  Run: { speed: 2.96, left: 0.46 },
  Run_Shoot: { speed: 2.93, left: 0.44 },
  Run_Back: { speed: 2.97, left: 0.32 },
  Run_Left: { speed: 2.97, left: 0 },
  Run_Right: { speed: 2.97, left: 0.46 },
};
const CROUCH_DROP = 0.3; // m the hips go down crouching (the head ends near a crouching player's eye)
const CROUCH_LEAN = 0.45; // rad the upper body leans forward crouching
const TWIST = 1.05; // rad the upper body turns before the legs step round (standing)
const MAX_TWIST = 1.4;
/** Long guns are drawn a little smaller in the figures' hands: the model's arms are short. */
const GUN_SCALE: Record<WeaponId, number> = { pistol: 1, rifle: 0.85, shotgun: 0.85, sniper: 0.82, bazooka: 0.85 };
/** Where the support hand holds a long gun: this share of the way from the grip to the muzzle. */
const FORE_END: Record<WeaponId, number> = { pistol: 0, rifle: 0.26, shotgun: 0.3, sniper: 0.24, bazooka: 0.22 };
/** The palette's columns: what each part of the model is painted with. */
const SLOT = { main: 0, dark: 1, skin: 2, visor: 3, helmet: 4 } as const;
const SLOTS = 8;
const SKIN = '#7e5e48';
const VISOR = '#151515';

interface Template {
  scene: THREE.Group;
  clips: Map<string, THREE.AnimationClip>;
  flinch: THREE.AnimationClip | null;
  scale: number;
  lift: number;
  /** The nine parts merged into one skinned mesh painted from a palette (false: the parts as loaded) */
  merged: boolean;
}
let template: Template | null = null;

/** A copy of an attribute as a plain array (the loader's may be interleaved), in `Kind`. */
function plain(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, Kind: Float32ArrayConstructor | Uint16ArrayConstructor): THREE.BufferAttribute {
  const s = a.itemSize;
  const out = new Kind(a.count * s);
  const get = [a.getX, a.getY, a.getZ, a.getW];
  for (let i = 0; i < a.count; i++) for (let c = 0; c < s; c++) out[i * s + c] = get[c].call(a, i);
  return new THREE.BufferAttribute(out, s);
}

const near = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) <= 1e-4 * Math.max(1, Math.abs(v)));

/**
 * The model's parts (legs, feet, body, head; each one to three materials) as one skinned mesh.
 * Each part keeps its colour through its texture coordinates, which point at a column of the
 * palette; the helmet (the gear's part of the head above the middle of the visor) gets a column
 * of its own, for the player's colour. Returns false (the parts stay) if they don't share one
 * skeleton and bind pose.
 */
function mergeParts(scene: THREE.Group): boolean {
  const parts: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) parts.push(o as THREE.SkinnedMesh);
  });
  scene.updateMatrixWorld(true);
  const first = parts[0];
  if (!first) return false;
  const one = parts.every((p) => {
    const a = p.skeleton;
    const b = first.skeleton;
    return a.bones.length === b.bones.length && a.bones.every((bone, i) => bone === b.bones[i]) && a.boneInverses.every((m, i) => near(m, b.boneInverses[i]))
      && near(p.bindMatrix, first.bindMatrix) && near(p.matrixWorld, first.matrixWorld) && !Array.isArray(p.material);
  });
  if (!one) return false;
  // The middle of the visor, in the rest pose: above it the head's gear is the helmet.
  const v = new THREE.Vector3();
  let visorY = NaN;
  const visor = parts.find((p) => (p.material as THREE.Material).name === 'Visor');
  if (visor) {
    const box = new THREE.Box3();
    const pos = visor.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(visor.matrixWorld));
    visorY = (box.min.y + box.max.y) / 2;
  }
  const geos: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    const name = (p.material as THREE.Material).name;
    const slot = name === 'Swat' ? SLOT.main : name === 'Skin' ? SLOT.skin : name === 'Visor' ? SLOT.visor : SLOT.dark;
    const head = /head/i.test(p.name) || /head/i.test(p.parent?.name ?? '');
    let src = p.geometry;
    // The head's gear is split by triangle into helmet and mask: its triangles get their own corners.
    const split = head && slot === SLOT.dark && !Number.isNaN(visorY);
    if (split && src.index) src = src.toNonIndexed();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', plain(src.attributes.position, Float32Array));
    g.setAttribute('normal', plain(src.attributes.normal, Float32Array));
    g.setAttribute('skinIndex', plain(src.attributes.skinIndex, Uint16Array));
    g.setAttribute('skinWeight', plain(src.attributes.skinWeight, Float32Array));
    const n = g.attributes.position.count;
    const uv = new Float32Array(n * 2);
    const column = (s: number) => (s + 0.5) / SLOTS;
    for (let i = 0; i < n; i++) uv.set([column(slot), 0.5], i * 2);
    if (split) {
      const pos = g.attributes.position;
      for (let i = 0; i < n; i += 3) {
        let y = 0;
        for (let k = 0; k < 3; k++) y += v.fromBufferAttribute(pos, i + k).applyMatrix4(p.matrixWorld).y / 3;
        if (y > visorY) for (let k = 0; k < 3; k++) uv[(i + k) * 2] = column(SLOT.helmet);
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(src.index ? Array.from(src.index.array) : Array.from({ length: n }, (_, i) => i));
    geos.push(g);
  }
  const geometry = mergeGeometries(geos);
  if (!geometry) return false;
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = 'SwatFigure';
  mesh.position.copy(first.position);
  mesh.quaternion.copy(first.quaternion);
  mesh.scale.copy(first.scale);
  first.parent!.add(mesh);
  mesh.bind(first.skeleton, first.bindMatrix);
  for (const p of parts) p.removeFromParent();
  return true;
}

/** Starts loading at once; resolves false if the model can't be loaded (block figures are used then). */
export const swatReady: Promise<boolean> = new GLTFLoader().loadAsync('/models/swat.glb').then(
  (gltf) => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const scale = HEIGHT / (box.max.y - box.min.y);
    const clips = new Map(gltf.animations.map((c) => [c.name.split('|').pop()!, c]));
    // The walk backwards is the walk played in reverse: a clip of its own, so it can blend with the walk.
    const walk = clips.get('Walk');
    if (walk) clips.set('Walk_Back', Object.assign(walk.clone(), { name: 'Walk_Back' }));
    // The hit reaction, played on top of whatever the body is doing (rotations only, so it doesn't slide).
    const hit = clips.get('HitRecieve');
    let flinch: THREE.AnimationClip | null = null;
    if (hit) {
      flinch = hit.clone();
      flinch.tracks = flinch.tracks.filter((tr) => tr.name.endsWith('.quaternion'));
      THREE.AnimationUtils.makeClipAdditive(flinch);
    }
    const merged = mergeParts(gltf.scene);
    template = { scene: gltf.scene, clips, flinch, scale, lift: -box.min.y * scale, merged };
    return true;
  },
  () => false,
);

export const hasSwat = (): boolean => !!template;

/** A holder on a bone whose units are metres again (bones carry the model's scale). */
function holder(bone: THREE.Object3D, model: THREE.Object3D): THREE.Group {
  model.updateMatrixWorld(true);
  const s = bone.getWorldScale(new THREE.Vector3()).divide(model.parent ? model.parent.getWorldScale(new THREE.Vector3()) : new THREE.Vector3(1, 1, 1));
  const h = new THREE.Group();
  h.scale.set(1 / s.x, 1 / s.y, 1 / s.z);
  bone.add(h);
  return h;
}

/** A player's palette: one pixel per part (see SLOT), sRGB, read without filtering. */
function palette(outfit: Outfit, color: string): THREE.DataTexture {
  const data = new Uint8Array(SLOTS * 4);
  const cols = [outfit.main, outfit.dark, SKIN, VISOR, color];
  const c = new THREE.Color();
  cols.forEach((hex, i) => {
    c.setStyle(hex, THREE.NoColorSpace); // the hex's own (sRGB) numbers: the texture is decoded as sRGB
    data.set([Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), 255], i * 4);
  });
  const tex = new THREE.DataTexture(data, SLOTS, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _p = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _ray = new THREE.Ray();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

const _s = new THREE.Vector3();
/** A bone's world rotation from its world matrix (kept up to date by whoever moved it). */
const worldQuat = (o: THREE.Object3D, out: THREE.Quaternion) => {
  o.matrixWorld.decompose(_s, out, _s);
  return out;
};
const worldPos = (o: THREE.Object3D, out: THREE.Vector3) => out.setFromMatrixPosition(o.matrixWorld);

/**
 * Turn a bone (in world space) so that the direction `from` comes to point along `to`. The
 * bone's and its parent's world matrices must be up to date; the bone's branch is brought up to date.
 */
function turnBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  _q.setFromUnitVectors(from.normalize(), to.normalize());
  worldQuat(bone, _p);
  _p.premultiply(_q); // the new world rotation
  worldQuat(bone.parent!, _q);
  bone.quaternion.copy(_q.invert().multiply(_p));
  bone.updateMatrixWorld(true);
}

/** Turn a bone by `angle` round a world axis (its children go with it; matrices are brought up to date by the caller). */
function rotateWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  if (Math.abs(angle) < 1e-4) return;
  _r.setFromAxisAngle(axis, angle);
  bone.getWorldQuaternion(_p);
  _p.premultiply(_r);
  bone.parent!.getWorldQuaternion(_q);
  bone.quaternion.copy(_q.invert().multiply(_p));
}

/**
 * Two-bone IK: bend upper arm and forearm so the wrist reaches `target` (as far as the
 * arm can), with the elbow pointing towards `pole`. Legs too: thigh, shin, ankle, knee.
 */
function reach(upper: THREE.Object3D, lower: THREE.Object3D, wrist: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void {
  const a = worldPos(upper, _a);
  const b = worldPos(lower, _b);
  const c = worldPos(wrist, _c);
  const lab = a.distanceTo(b);
  const lbc = b.distanceTo(c);
  const dir = _d.copy(target).sub(a);
  const lat = Math.min(Math.max(dir.length(), 0.01), (lab + lbc) * 0.999);
  dir.normalize();
  const cosA = Math.min(1, Math.max(-1, (lab * lab + lat * lat - lbc * lbc) / (2 * lab * lat)));
  const bend = pole.clone().sub(a);
  bend.addScaledVector(dir, -bend.dot(dir)).normalize();
  const elbow = a.clone().addScaledVector(dir, cosA * lab).addScaledVector(bend, Math.sqrt(1 - cosA * cosA) * lab);
  turnBone(upper, b.clone().sub(a), elbow.sub(a));
  worldPos(lower, _b);
  worldPos(wrist, _c);
  turnBone(lower, _c.clone().sub(_b), target.clone().sub(_b));
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const LOCO = ['Walk', 'Walk_Back', 'Run', 'Run_Shoot', 'Run_Back', 'Run_Left', 'Run_Right'] as const;
type Loco = (typeof LOCO)[number];

export function buildSwat(name: string, color: string, outfit: Outfit, hitMaterial: THREE.Material, headBox: THREE.BufferGeometry, bodyBox: THREE.BufferGeometry): Body {
  const t = template!;
  const model = SkeletonUtils.clone(t.scene) as THREE.Group;
  model.scale.setScalar(t.scale);
  model.position.y = t.lift;
  model.rotation.y = Math.PI; // the model faces +z; players face -z
  const root = new THREE.Group();
  root.add(model);

  // Paint: one material with the player's palette (merged), or the parts recoloured (as loaded).
  const mats = new Map<string, THREE.Material>();
  let figure: THREE.SkinnedMesh | null = null;
  model.traverse((o) => {
    o.userData.ignoreRay = true;
    if (!(o instanceof THREE.Mesh)) return;
    o.castShadow = true;
    if (t.merged && o.name === 'SwatFigure') {
      figure = o as THREE.SkinnedMesh;
      o.material = new THREE.MeshStandardMaterial({ map: palette(outfit, color), roughness: 0.85, metalness: 0.4 });
      return;
    }
    o.frustumCulled = false; // animated: the bind-pose bounds are not where the body is
    const recolour = (m: THREE.Material) => {
      if (!mats.has(m.name)) {
        const c = (m as THREE.MeshStandardMaterial).clone();
        if (m.name === 'Swat') c.color.set(outfit.main);
        if (m.name === 'Swat_Black') c.color.set(outfit.dark);
        c.roughness = 0.85;
        mats.set(m.name, c);
      }
      return mats.get(m.name)!;
    };
    o.material = Array.isArray(o.material) ? o.material.map(recolour) : recolour(o.material);
  });

  // The loader drops the dot from bone names: 'Wrist.R' becomes 'WristR'.
  const bone = (n: string) => model.getObjectByName(n)!;
  const head = bone('Head');
  const neck = bone('Neck');
  const chest = bone('Chest');
  const spine = [bone('Abdomen'), bone('Torso'), chest];
  const hips = bone('Body'); // the pelvis: the upper body and both thighs hang from it
  const arms = {
    r: { upper: bone('UpperArmR'), lower: bone('LowerArmR'), wrist: bone('WristR') },
    l: { upper: bone('UpperArmL'), lower: bone('LowerArmL'), wrist: bone('WristL') },
  };
  // The feet hang from the root, not from the shins: lowering the hips leaves them planted.
  const legs = (['L', 'R'] as const).map((s) => ({
    upper: bone(`UpperLeg${s}`), lower: bone(`LowerLeg${s}`), ankle: bone(`LowerLeg${s}_end`), foot: bone(`Foot${s}`),
    sign: s === 'L' ? -1 : 1, // the model's left is the player's left: -x in the root
    planted: new THREE.Vector3(), target: new THREE.Vector3(),
  }));
  const ikLegs = legs.every((l) => l.upper && l.lower && l.ankle && l.foot) && !!hips;
  // The bones posed here after the clips, and their pose straight from the clips. The mixer only
  // writes a bone whose value changed (and never one no clip moves, like the abdomen), so each
  // frame they are put back to the clips' pose first: what is done here never adds up.
  const touched = [hips, ...spine, neck, head, ...legs.flatMap((l) => [l.upper, l.lower, l.foot]), arms.r.upper, arms.r.lower, arms.l.upper, arms.l.lower].filter(Boolean);
  const clipPose = touched.map((b) => ({ b, q: b.quaternion.clone(), p: b.position.clone() }));

  // Without the merged figure, the player's colour goes on a scarf round the neck.
  if (!figure) {
    const scarf = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.07, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
    scarf.userData.ignoreRay = true;
    scarf.castShadow = true;
    holder(neck, root).add(scarf);
  }

  // Guns: one per weapon, the one in use shown. They hang from the figure itself and are
  // placed each frame where the hands hold them.
  const guns = new Map<WeaponId, THREE.Group>();
  for (const w of WEAPON_IDS) {
    const g = gunModel(w);
    g.scale.setScalar(GUN_SCALE[w]);
    const box = new THREE.Box3().setFromObject(g); // in the gun's own frame: barrel along -z, grip at 0
    g.userData.bounds = box;
    g.traverse((o) => (o.userData.ignoreRay = true));
    g.userData.meshes = [] as THREE.Mesh[];
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) (g.userData.meshes as THREE.Mesh[]).push(o);
    });
    const muzzle = g.getObjectByName('muzzle');
    const flash = muzzleFlash(w === 'pistol' ? 0.18 : 0.3);
    flash.position.copy(muzzle ? muzzle.position : new THREE.Vector3(0, 0, box.min.z / GUN_SCALE[w]));
    g.add(flash);
    g.userData.flash = flash;
    g.visible = g.matrixWorldAutoUpdate = false;
    root.add(g);
    guns.set(w, g);
  }

  // Hit boxes: the head follows the head bone, the body stays upright (and lower, crouching).
  const hitHead = new THREE.Mesh(headBox, hitMaterial);
  hitHead.position.y = 0.1;
  hitHead.userData = { player: name, part: 'head' };
  holder(head, root).add(hitHead);
  const hitBody = new THREE.Mesh(bodyBox, hitMaterial);
  hitBody.position.y = 0.73;
  hitBody.userData = { player: name, part: 'body' };
  root.add(hitBody);

  if (figure) {
    const mesh = figure as THREE.SkinnedMesh;
    // Bounds for the camera's (and the sun's) culling: a ball round the body that holds every
    // pose, lying down included, in the mesh's own units.
    root.updateMatrixWorld(true);
    const inv = _m.copy(mesh.matrixWorld).invert();
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0).applyMatrix4(inv), 1.9 / mesh.matrixWorld.getMaxScaleOnAxis());
    mesh.frustumCulled = true;
    // A ray is tried against the body (for paintball's paint) only when it passes through one of
    // the hit boxes: everything else that passes near costs nothing.
    const skinnedRaycast = THREE.SkinnedMesh.prototype.raycast;
    const crosses = (box: THREE.Mesh, ray: THREE.Ray) => {
      const g = box.geometry;
      _ray.copy(ray).applyMatrix4(_m.copy(box.matrixWorld).invert());
      if (g.boundingBox === null) g.computeBoundingBox();
      if (g.boundingSphere === null) g.computeBoundingSphere();
      return box === hitHead ? _ray.intersectsSphere(_sphere.copy(g.boundingSphere!)) : _ray.intersectsBox(_box.copy(g.boundingBox!));
    };
    mesh.raycast = function (raycaster, intersects) {
      if (!crosses(hitBody, raycaster.ray) && !crosses(hitHead, raycaster.ray)) return;
      skinnedRaycast.call(this, raycaster, intersects);
    };
  }

  const mixer = new THREE.AnimationMixer(model);
  const actions = new Map<string, THREE.AnimationAction>();
  const action = (n: string) => {
    let a = actions.get(n);
    if (!a) {
      a = mixer.clipAction(t.clips.get(n) ?? t.clips.get('Idle')!);
      if (n === 'Death') {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      a.enabled = true;
      a.weight = 0;
      a.play();
      actions.set(n, a);
    }
    return a;
  };
  // The strides: each locomotion clip held still, its time set from the shared phase.
  const loco = new Map<Loco, { a: THREE.AnimationAction; stride: number; left: number; back: boolean; w: number }>();
  for (const n of LOCO) {
    const a = action(n);
    a.timeScale = 0;
    loco.set(n, { a, stride: GAIT[n].speed * a.getClip().duration, left: GAIT[n].left, back: n === 'Walk_Back', w: 0 });
  }
  const idleArmed = action(CLIPS.armedIdle);
  const idleFree = action('Idle_Neutral');
  const death = action('Death');
  /** An action's share of the pose; one with none is switched off, so the mixer skips it. */
  const weigh = (a: THREE.AnimationAction, w: number) => {
    a.enabled = w > 1e-3;
    a.weight = w;
  };
  const flinch = t.flinch ? mixer.clipAction(t.flinch) : null;
  if (flinch) {
    flinch.blendMode = THREE.AdditiveAnimationBlendMode;
    flinch.setLoop(THREE.LoopOnce, 1);
  }

  let flashTime = 0;
  let recoil = 0;
  let shownGun: THREE.Group | null = null;
  // The legs and how they move
  let phase = 0;
  let legYaw = NaN;
  let stepping = false;
  let armedW = 1;
  let dirW = [1, 0, 0, 0]; // forwards, backwards, right, left
  let crouchW = 0;
  let airW = 0;
  let flyW = 0;
  let deathW = 0;
  let wasDead = false;
  let fall = 0; // the fastest fall of this time in the air (m/s, negative)
  let landT = -1; // s since landing hard
  let landDepth = 0;
  let clock = 0;
  let skip = 0;
  let pending = 0;
  const q = new THREE.Quaternion();
  const rootQ = new THREE.Quaternion();
  const barrel = new THREE.Vector3();
  const side = new THREE.Vector3();
  const upAxis = new THREE.Vector3();
  const back = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const gunAt = new THREE.Vector3();
  const v = new THREE.Vector3();
  const target = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  const body: Body = {
    root,
    hits: [hitHead, hitBody],
    shared: true,
    footfall: false,
    crouched: 0,
    flash() {
      flashTime = 0.06;
      recoil = 1;
      if (!shownGun) return null;
      const f = shownGun.userData.flash as ReturnType<typeof muzzleFlash>;
      f.fire();
      return f.getWorldPosition(new THREE.Vector3());
    },
    flinch() {
      flinch?.reset().setEffectiveWeight(0.9).play();
    },
    dispose() {
      const m = (figure as THREE.SkinnedMesh | null)?.material as THREE.MeshStandardMaterial | undefined;
      m?.map?.dispose();
      m?.dispose();
      for (const c of mats.values()) c.dispose();
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
    },
    animate(dtFrame, p) {
      body.footfall = false;
      // Far away: posed every second or fourth frame (the time adds up), and the gun not drawn.
      pending += dtFrame;
      const every = p.far > 70 ? 4 : p.far > 35 ? 2 : 1;
      if (++skip < every && p.alive === !wasDead && flashTime <= 0) return;
      skip = 0;
      const dt = Math.min(pending, 0.25);
      pending = 0;
      clock += dt;
      const k = (rate: number) => 1 - Math.exp(-dt * rate);
      const alive = p.alive;
      const riding = p.seat !== null && alive;
      const flying = p.flying && alive && !riding;
      const inAir = alive && !flying && !riding && (p.air > 0.2 || (p.air > 0.06 && Math.abs(p.vy) > 1.5));
      const wasInAir = airW > 0.5;
      crouchW += ((p.crouch && alive && !riding ? 1 : 0) - crouchW) * k(10);
      airW += ((inAir ? 1 : 0) - airW) * k(inAir ? 14 : 20);
      flyW += ((flying ? 1 : 0) - flyW) * k(5);
      armedW += ((p.armed ? 1 : 0) - armedW) * k(8);
      if (inAir) fall = Math.min(fall, p.vy);
      else {
        // Down from a jump or a fall: the knees take it, deeper the harder it was.
        if (wasInAir && fall < -2.5) {
          landT = 0;
          landDepth = Math.min(0.2, -fall * 0.03);
        }
        fall = 0;
      }
      if (landT >= 0) landT = landT + dt > 0.36 ? -1 : landT + dt;
      const dip = landT >= 0 ? landDepth * Math.sin((Math.PI * landT) / 0.36) : 0;

      // Dying: the fall plays from its start and takes over in a sixth of a second.
      if (!alive && !wasDead) death.reset().play();
      wasDead = !alive;
      deathW = Math.min(1, Math.max(0, deathW + (alive ? -dt / 0.2 : dt / 0.16)));

      // Where the legs face: where they look while moving; standing, the upper body turns first
      // and the legs step round when the twist gets large. On a horse, the horse's way.
      if (Number.isNaN(legYaw)) legYaw = p.yaw;
      const moving = !alive || flying || riding ? 0 : smooth(0.12, 0.45, p.speed);
      let turned = 0;
      if (riding) legYaw = p.seat!;
      else if (alive) {
        const tw = wrap(p.yaw - legYaw);
        if (moving > 0.3 || flyW > 0.5 || airW > 0.5) legYaw += tw * k(10);
        else {
          if (Math.abs(tw) > TWIST) stepping = true;
          if (stepping) {
            turned = Math.sign(tw) * Math.min(Math.abs(tw), dt * 4.5);
            legYaw += turned;
            if (Math.abs(tw) < 0.12) stepping = false;
          }
        }
        const left = wrap(p.yaw - legYaw);
        if (Math.abs(left) > MAX_TWIST) legYaw = p.yaw - Math.sign(left) * MAX_TWIST;
      }
      const twist = wrap(p.yaw - legYaw) * (1 - deathW);
      model.rotation.y = Math.PI - twist;

      // The blend of the strides: by direction (relative to the legs) and by speed (walk to run).
      const len = Math.hypot(p.forward, p.side);
      if (len > 0.1) {
        const c = p.forward / len;
        const s = p.side / len;
        const sum = Math.abs(c) + Math.abs(s);
        const want = [Math.max(0, c) / sum, Math.max(0, -c) / sum, Math.max(0, s) / sum, Math.max(0, -s) / sum];
        dirW = dirW.map((w, i) => w + (want[i] - w) * k(9));
      }
      const run = smooth(1.9, 2.9, p.speed);
      const [fw, bw, rw, lw] = dirW;
      const stepW = stepping ? Math.min(0.55, Math.abs(turned) / dt / 6) : 0; // turning on the spot: a few small steps
      const go = Math.max(moving, stepW) * (1 - deathW);
      const wantLoco: Record<Loco, number> = {
        Walk: fw * (1 - run),
        Walk_Back: bw * (1 - run),
        Run: fw * run * (1 - armedW),
        Run_Shoot: fw * run * armedW,
        Run_Back: bw * run,
        Run_Left: lw,
        Run_Right: rw,
      };
      if (moving < stepW) {
        // On the spot: the walk only, its feet stepping round.
        for (const n of LOCO) wantLoco[n] = n === 'Walk' ? 1 : 0;
      }
      let stride = 0;
      let total = 0;
      for (const n of LOCO) {
        const l = loco.get(n)!;
        l.w = wantLoco[n];
        stride += l.w * l.stride;
        total += l.w;
      }
      stride = total > 0 ? stride / total : 1.8;
      // The phase goes on with the ground covered (not in the air), so the planted foot stays put.
      const before = phase;
      const ground = moving >= stepW ? p.speed * dt * (1 - airW) : Math.abs(turned) * 0.3;
      phase = (((phase + ground / stride) % 1) + 1) % 1;
      if (go > 0.3 && airW < 0.5 && (Math.floor(before * 2) !== Math.floor(phase * 2) || phase < before)) body.footfall = true;
      for (const n of LOCO) {
        const l = loco.get(n)!;
        const u = l.back ? l.left - phase : phase + l.left;
        l.a.time = (((u % 1) + 1) % 1) * l.a.getClip().duration;
        weigh(l.a, l.w * go);
      }
      const still = (1 - go) * (1 - deathW);
      weigh(idleArmed, still * armedW);
      weigh(idleFree, still * (1 - armedW));
      weigh(death, deathW);
      recoil = Math.max(0, recoil - dt * 8);
      for (const s of clipPose) {
        s.b.quaternion.copy(s.q);
        s.b.position.copy(s.p);
      }
      mixer.update(dt);
      for (const s of clipPose) {
        s.q.copy(s.b.quaternion);
        s.p.copy(s.b.position);
      }

      // Everything from here on works in the world: bring the bones' matrices up to date once.
      root.updateWorldMatrix(true, true);
      root.getWorldQuaternion(rootQ);
      const legsQ = model.getWorldQuaternion(_q);
      fwd.set(0, 0, 1).applyQuaternion(legsQ).setY(0).normalize(); // the model's forward is +z
      right.crossVectors(fwd, UP).normalize();

      // Lower body: hips down (crouching, landing), legs reaching their feet (or tucked, hanging, in
      // the stirrups). Standing, walking and running the clips' legs are left as they are.
      if (ikLegs && deathW < 0.99 && (crouchW > 0.005 || airW > 0.005 || flyW > 0.005 || riding || dip > 0)) {
        const live = 1 - deathW;
        for (const l of legs) worldPos(l.ankle, l.planted);
        const drop = (CROUCH_DROP * crouchW + dip) * live;
        const ride = riding ? 1 : 0;
        const bob = flyW * Math.sin(clock * 1.7) * 0.04;
        if (drop > 1e-3 || bob !== 0) {
          worldPos(hips, v);
          v.y -= drop - bob;
          hips.position.copy(hips.parent!.worldToLocal(v));
          hips.updateMatrixWorld(true);
        }
        // Leaning: forward crouching, into the flight when flying.
        const lean = CROUCH_LEAN * crouchW * live + flyW * 0.35 * Math.max(0, Math.min(1, p.forward / 3));
        rotateWorld(spine[0], right, -lean);
        // Feet: where the clip put them; in the air drawn up (less as they drop fast), flying
        // hanging back, on a horse in the stirrups.
        const tuck = airW * 0.22 * (1 - 0.6 * smooth(-1, -5, p.vy)) + flyW * 0.09;
        const trail = flyW * 0.2;
        for (const l of legs) {
          l.target.copy(l.planted);
          if (ride) {
            l.target.copy(worldPos(hips, v)).addScaledVector(UP, -0.6).addScaledVector(right, l.sign * 0.27).addScaledVector(fwd, 0.1);
          } else {
            l.target.addScaledVector(UP, tuck).addScaledVector(fwd, airW * 0.05 - trail);
          }
          worldPos(hips, pole).addScaledVector(fwd, 0.8).addScaledVector(right, l.sign * (0.12 + ride * 0.3)).addScaledVector(UP, -0.3);
          reach(l.upper, l.lower, l.ankle, l.target, pole);
          // The foot (hung from the root) follows its ankle when the ankle moved.
          v.copy(l.target).sub(l.planted);
          if (v.lengthSq() > 1e-6) {
            worldPos(l.foot, _c).add(v);
            l.foot.position.copy(l.foot.parent!.worldToLocal(_c));
            l.foot.updateMatrixWorld(true);
          }
        }
      }

      // Upper body: turned back to where they look (shared down the spine and neck), and the head
      // looking up and down with them.
      if (Math.abs(twist) > 1e-3) {
        const share = [0.2, 0.25, 0.25];
        spine.forEach((b, i) => rotateWorld(b, UP, twist * share[i]));
        rotateWorld(neck, UP, twist * 0.15);
        rotateWorld(head, UP, twist * 0.15);
      }
      const pitch = Math.max(-1.2, Math.min(1.2, p.pitch)) * (1 - deathW);
      if (Math.abs(pitch) > 0.005) {
        side.set(0, 0, -1).applyQuaternion(rootQ).setY(0).normalize().cross(UP).normalize();
        rotateWorld(neck, side, pitch * (p.armed ? 0.2 : 0.3));
        rotateWorld(head, side, pitch * (p.armed ? 0.35 : 0.45));
      }
      spine[0].updateMatrixWorld(true); // the upper body (arms and head with it) as turned

      // The body's hit box goes down with the hips.
      const low = 1 - 0.25 * crouchW;
      hitBody.scale.y = low;
      hitBody.position.y = 0.73 * low;
      body.crouched = crouchW;

      const gun = p.armed && alive ? guns.get(p.weapon) ?? guns.get('pistol')! : null;
      if (gun !== shownGun) {
        // A gun put away isn't kept up to date either (the renderer would every frame).
        if (shownGun) shownGun.visible = shownGun.matrixWorldAutoUpdate = false;
        if (gun) gun.visible = gun.matrixWorldAutoUpdate = true;
        shownGun = gun;
      }
      flashTime -= dt;
      for (const g of guns.values()) (g.userData.flash as THREE.Object3D).visible = g === shownGun && flashTime > 0;
      if (!shownGun) return;
      // Far off the gun itself isn't drawn (a few pixels), its muzzle flash still is; its shadow only close by.
      for (const m of shownGun.userData.meshes as THREE.Mesh[]) {
        m.visible = p.far < 50;
        m.castShadow = p.far < 14;
      }

      const kick = recoil * recoil; // quick back, eased return
      const aim = pitch + kick * 0.12;
      // Aiming frame: barrel where they look, `side` to their right, `upAxis` the top of the gun.
      barrel.set(0, 0, -1).applyQuaternion(rootQ).setY(0).normalize();
      side.crossVectors(barrel, UP).normalize();
      barrel.multiplyScalar(Math.cos(aim)).setY(Math.sin(aim));
      upAxis.crossVectors(side, barrel).normalize();
      back.copy(barrel).negate();

      // Upper body: lean with the aim, and for a long gun turn the chest so the left shoulder comes forward.
      const long = shownGun !== guns.get('pistol');
      q.setFromAxisAngle(side, aim * 0.25);
      if (long) q.multiply(_p.setFromAxisAngle(UP, -0.55));
      chest.getWorldQuaternion(_q);
      chest.quaternion.multiply(_q.clone().invert().multiply(q).multiply(_q));
      chest.updateMatrixWorld(true);

      // Place the gun: long guns with the butt in the right shoulder, the pistol held out in
      // front between the shoulders. A shot pushes it back.
      const box = shownGun.userData.bounds as THREE.Box3;
      const shoulder = worldPos(arms.r.upper, v);
      if (shownGun === guns.get('bazooka')) gunAt.copy(shoulder).addScaledVector(upAxis, 0.04).addScaledVector(barrel, 0.12).addScaledVector(side, 0.02);
      else if (long) gunAt.copy(shoulder).addScaledVector(side, -0.05).addScaledVector(upAxis, -0.02).addScaledVector(barrel, box.max.z + 0.02);
      else gunAt.copy(shoulder).addScaledVector(side, -0.14).addScaledVector(upAxis, 0.02).addScaledVector(barrel, 0.36);
      gunAt.addScaledVector(barrel, -kick * (long ? 0.05 : 0.04));
      basis.makeBasis(side, upAxis, back);
      shownGun.quaternion.setFromRotationMatrix(basis).premultiply(rootQ.clone().invert());
      shownGun.position.copy(root.worldToLocal(gunAt.clone()));
      shownGun.updateMatrixWorld(true);

      // Hands: on a long gun the right wrist just behind and above the grip, the left under
      // the fore-end; on the pistol the left hand cups the right. Elbows point down and out.
      target.copy(gunAt).addScaledVector(back, 0.05).addScaledVector(upAxis, 0.02);
      pole.copy(shoulder).addScaledVector(UP, -0.5).addScaledVector(side, 0.35).addScaledVector(back, 0.2);
      reach(arms.r.upper, arms.r.lower, arms.r.wrist, target, pole);
      if (long) target.copy(gunAt).addScaledVector(barrel, -box.min.z * FORE_END[p.weapon]).addScaledVector(upAxis, -0.05).addScaledVector(back, 0.06);
      else target.copy(gunAt).addScaledVector(side, -0.03).addScaledVector(upAxis, -0.04).addScaledVector(back, 0.04);
      const left = worldPos(arms.l.upper, new THREE.Vector3());
      pole.copy(left).addScaledVector(UP, -0.5).addScaledVector(side, -0.3).addScaledVector(back, 0.1);
      reach(arms.l.upper, arms.l.lower, arms.l.wrist, target, pole);
    },
  };
  return body;
}
