import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { gunModel, WEAPON_IDS, type WeaponId } from '../weapon';
import { muzzleFlash } from '../world/effects';

/**
 * Other players as a rigged, animated character: the "SWAT" model by
 * Quaternius (CC0, poly.pizza/m/Btfn3G5Xv4), recoloured per player, with a
 * scarf in their colour and the gun they hold. It idles, walks, runs,
 * strafes, runs backwards, aims up and down with the upper body, flinches
 * when your bullet hits and plays its death animation when killed.
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
}

export interface Outfit {
  main: string;
  dark: string;
}

const HEIGHT = 1.8;
/**
 * Which of the model's animations to use when holding a gun. The arms are posed by IK
 * either way; these give the legs and a square, upright stance (the 'Gun_Shoot' clip
 * turns the body side-on and bows the head).
 */
export const CLIPS = { armedIdle: 'Idle_Gun_Pointing', armedRun: 'Run_Shoot' };
/** Long guns are drawn a little smaller in the figures' hands: the model's arms are short. */
const GUN_SCALE: Record<WeaponId, number> = { pistol: 1, rifle: 0.85, shotgun: 0.85, sniper: 0.82, bazooka: 0.85 };
/** Where the support hand holds a long gun: this share of the way from the grip to the muzzle. */
const FORE_END: Record<WeaponId, number> = { pistol: 0, rifle: 0.26, shotgun: 0.3, sniper: 0.24, bazooka: 0.22 };
let template: { scene: THREE.Group; clips: Map<string, THREE.AnimationClip>; flinch: THREE.AnimationClip | null; scale: number; lift: number } | null = null;

/** Starts loading at once; resolves false if the model can't be loaded (block figures are used then). */
export const swatReady: Promise<boolean> = new GLTFLoader().loadAsync('/models/swat.glb').then(
  (gltf) => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const scale = HEIGHT / (box.max.y - box.min.y);
    const clips = new Map(gltf.animations.map((c) => [c.name.split('|').pop()!, c]));
    // The hit reaction, played on top of whatever the body is doing (rotations only, so it doesn't slide).
    const hit = clips.get('HitRecieve');
    let flinch: THREE.AnimationClip | null = null;
    if (hit) {
      flinch = hit.clone();
      flinch.tracks = flinch.tracks.filter((tr) => tr.name.endsWith('.quaternion'));
      THREE.AnimationUtils.makeClipAdditive(flinch);
    }
    template = { scene: gltf.scene, clips, flinch, scale, lift: -box.min.y * scale };
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

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _p = new THREE.Quaternion();

/** Turn a bone (in world space) so that the direction `from` comes to point along `to`. */
function turnBone(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  _q.setFromUnitVectors(from.normalize(), to.normalize());
  bone.getWorldQuaternion(_p);
  _p.premultiply(_q); // the new world rotation
  bone.parent!.getWorldQuaternion(_q);
  bone.quaternion.copy(_q.invert().multiply(_p));
  bone.updateMatrixWorld(true);
}

/**
 * Two-bone IK: bend upper arm and forearm so the wrist reaches `target` (as far as the
 * arm can), with the elbow pointing towards `pole`.
 */
function reach(upper: THREE.Object3D, lower: THREE.Object3D, wrist: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void {
  const a = upper.getWorldPosition(_a);
  const b = lower.getWorldPosition(_b);
  const c = wrist.getWorldPosition(_c);
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
  lower.getWorldPosition(_b);
  wrist.getWorldPosition(_c);
  turnBone(lower, _c.clone().sub(_b), target.clone().sub(_b));
}

export function buildSwat(name: string, color: string, outfit: Outfit, hitMaterial: THREE.Material, headBox: THREE.BufferGeometry, bodyBox: THREE.BufferGeometry): Body {
  const t = template!;
  const model = SkeletonUtils.clone(t.scene) as THREE.Group;
  model.scale.setScalar(t.scale);
  model.position.y = t.lift;
  model.rotation.y = Math.PI; // the model faces +z; players face -z
  const root = new THREE.Group();
  root.add(model);

  // Recolour: the suit in the outfit colours; skin and visor stay.
  const mats = new Map<string, THREE.Material>();
  model.traverse((o) => {
    o.userData.ignoreRay = true;
    if (!(o instanceof THREE.Mesh)) return;
    o.castShadow = true;
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
  const chest = bone('Chest');
  const arms = {
    r: { upper: bone('UpperArmR'), lower: bone('LowerArmR'), wrist: bone('WristR') },
    l: { upper: bone('UpperArmL'), lower: bone('LowerArmL'), wrist: bone('WristL') },
  };

  // Scarf in the player's colour around the neck.
  const scarf = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.07, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  scarf.userData.ignoreRay = true;
  scarf.castShadow = true;
  holder(bone('Neck'), root).add(scarf);

  // Guns: one per weapon, the one in use shown. They hang from the figure itself and are
  // placed each frame where the hands hold them.
  const guns = new Map<WeaponId, THREE.Group>();
  for (const w of WEAPON_IDS) {
    const g = gunModel(w);
    g.scale.setScalar(GUN_SCALE[w]);
    const box = new THREE.Box3().setFromObject(g); // in the gun's own frame: barrel along -z, grip at 0
    g.userData.bounds = box;
    g.traverse((o) => (o.userData.ignoreRay = true));
    const muzzle = g.getObjectByName('muzzle');
    const flash = muzzleFlash(w === 'pistol' ? 0.18 : 0.3);
    flash.position.copy(muzzle ? muzzle.position : new THREE.Vector3(0, 0, box.min.z / GUN_SCALE[w]));
    g.add(flash);
    g.userData.flash = flash;
    g.visible = false;
    root.add(g);
    guns.set(w, g);
  }

  // Hit boxes: the head follows the head bone, the body stays upright.
  const hitHead = new THREE.Mesh(headBox, hitMaterial);
  hitHead.position.y = 0.1;
  hitHead.userData = { player: name, part: 'head' };
  holder(head, root).add(hitHead);
  const hitBody = new THREE.Mesh(bodyBox, hitMaterial);
  hitBody.position.y = 0.73;
  hitBody.userData = { player: name, part: 'body' };
  root.add(hitBody);

  const mixer = new THREE.AnimationMixer(model);
  const actions = new Map<string, THREE.AnimationAction>();
  const action = (n: string) => {
    if (!actions.has(n)) {
      const a = mixer.clipAction(t.clips.get(n) ?? t.clips.get('Idle')!);
      if (n === 'Death') {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      actions.set(n, a);
    }
    return actions.get(n)!;
  };
  const flinch = t.flinch ? mixer.clipAction(t.flinch) : null;
  if (flinch) {
    flinch.blendMode = THREE.AdditiveAnimationBlendMode;
    flinch.setLoop(THREE.LoopOnce, 1);
  }
  let current = '';
  let flashTime = 0;
  let recoil = 0;
  let shownGun: THREE.Group | null = null;
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
  const UP = new THREE.Vector3(0, 1, 0);

  return {
    root,
    hits: [hitHead, hitBody],
    shared: true,
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
    animate(dt, p) {
      let want: string;
      if (!p.alive) want = 'Death';
      else if (p.speed < 0.35 || p.flying) want = p.armed ? CLIPS.armedIdle : 'Idle_Neutral';
      else if (Math.abs(p.side) > Math.abs(p.forward) * 1.2) want = p.side > 0 ? 'Run_Right' : 'Run_Left';
      else if (p.forward < 0) want = 'Run_Back';
      else if (p.speed < 2) want = 'Walk'; // armed too: the hands are on the gun anyway
      else want = p.armed ? CLIPS.armedRun : 'Run';
      if (want !== current) {
        const next = action(want).reset().play();
        const prev = current ? action(current) : null;
        if (prev) {
          if (want === 'Death' || current === 'Death') prev.stop();
          else next.crossFadeFrom(prev, 0.2, true);
        }
        current = want;
      }
      const a = action(current);
      if (current === 'Walk') a.timeScale = p.speed / 1.3;
      else if (current.startsWith('Run')) a.timeScale = Math.max(0.5, p.speed / 4);
      else a.timeScale = 1;
      recoil = Math.max(0, recoil - dt * 8);
      mixer.update(dt);

      // Crouching: there is no crouch animation, so the figure is pressed down a bit.
      root.scale.y += ((p.crouch && p.alive ? 0.75 : 1) - root.scale.y) * Math.min(1, dt * 12);

      const gun = p.armed && p.alive ? guns.get(p.weapon) ?? guns.get('pistol')! : null;
      if (gun !== shownGun) {
        if (shownGun) shownGun.visible = false;
        if (gun) gun.visible = true;
        shownGun = gun;
      }
      flashTime -= dt;
      for (const g of guns.values()) (g.userData.flash as THREE.Object3D).visible = g === shownGun && flashTime > 0;
      if (!shownGun) return;

      root.updateWorldMatrix(true, true);
      root.getWorldQuaternion(rootQ);
      const kick = recoil * recoil; // quick back, eased return
      const pitch = Math.max(-1.2, Math.min(1.2, p.pitch)) + kick * 0.12;
      // Aiming frame: barrel where they look, `side` to their right, `upAxis` the top of the gun.
      barrel.set(0, 0, -1).applyQuaternion(rootQ).setY(0).normalize();
      side.crossVectors(barrel, UP).normalize();
      barrel.multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch));
      upAxis.crossVectors(side, barrel).normalize();
      back.copy(barrel).negate();

      // Upper body: lean with the aim, and for a long gun turn the chest so the left shoulder comes forward.
      const long = shownGun !== guns.get('pistol');
      q.setFromAxisAngle(side, pitch * 0.25);
      if (long) q.multiply(_p.setFromAxisAngle(UP, -0.55));
      chest.getWorldQuaternion(_q);
      chest.quaternion.multiply(_q.clone().invert().multiply(q).multiply(_q));
      chest.updateMatrixWorld(true);

      // Place the gun: long guns with the butt in the right shoulder, the pistol held out in
      // front between the shoulders. A shot pushes it back.
      const box = shownGun.userData.bounds as THREE.Box3;
      const shoulder = arms.r.upper.getWorldPosition(v);
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
      const left = arms.l.upper.getWorldPosition(new THREE.Vector3());
      pole.copy(left).addScaledVector(UP, -0.5).addScaledVector(side, -0.3).addScaledVector(back, 0.1);
      reach(arms.l.upper, arms.l.lower, arms.l.wrist, target, pole);
    },
  };
}
