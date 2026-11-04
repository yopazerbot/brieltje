import * as THREE from 'three';

/**
 * The game's player figure (net/swat.ts) posed on the parachute's pose guides after the parachute's clip
 * has played: other players under a parachute (world/parachutes.ts) and the preview page
 * (web/parachute-preview.html).
 *
 * Which bone follows which guide (figure bone <- parachute node). three.js drops the dot from the
 * figure's bone names ('UpperArm.L' loads as 'UpperArmL'); the parachute's nodes use underscores.
 *   Body                   follows Pilot's change from its rest pose (the pelvis; the spine stays at rest)
 *   UpperLegX, LowerLegX   two-bone IK: the ankle (LowerLegX_end) reaches Foot_X, the knee bends towards Shin_X
 *   FootX                  follows Foot_X's change
 *   UpperArmX, LowerArmX   two-bone IK: the wrist reaches 5 cm short of Grip_X (towards the shoulder), the
 *                          elbow bends towards Elbow_X
 *   Index/Middle/Ring/Pinky 1-3, Thumb 1-2   curled round the toggle (a fixed turn from rest)
 *   Head                   shrunk to nothing for a first-person camera
 * The same pose is made in Blender for the review renders (tools/parachute/renders.py).
 */
export const BONE_MAP = {
  Body: 'Pilot',
  UpperLegL: 'IK to Foot_L, pole Shin_L', LowerLegL: 'IK to Foot_L, pole Shin_L', FootL: 'Foot_L',
  UpperLegR: 'IK to Foot_R, pole Shin_R', LowerLegR: 'IK to Foot_R, pole Shin_R', FootR: 'Foot_R',
  UpperArmL: 'IK to Grip_L, pole Elbow_L', LowerArmL: 'IK to Grip_L, pole Elbow_L',
  UpperArmR: 'IK to Grip_R, pole Elbow_R', LowerArmR: 'IK to Grip_R, pole Elbow_R',
} as const;

const SIDES = [['L', -1], ['R', 1]] as const;
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'].flatMap((f) => [1, 2, 3].map((k) => `${f}${k}`)).concat(['Thumb1', 'Thumb2']);
const CURL: Record<string, number> = { '1': 0.95, '2': 1.05, '3': 0.75 };
/** Where the eyes are in the rest pose, in the parachute's space (m): moved with Pilot for a first-person camera. */
const EYE = new THREE.Vector3(0, 1.66, -0.12);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _hinv = new THREE.Matrix4();

interface Rest {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
}

export class PilotPose {
  private rest = new Map<THREE.Object3D, Rest>();
  /** Rest matrices in the holder's space, of the guides and of the figure's bones that follow them. */
  private restH = new Map<THREE.Object3D, THREE.Matrix4>();
  private guides = new Map<string, THREE.Object3D>();
  private bones = new Map<string, THREE.Object3D>();
  private curl: { bone: THREE.Object3D; q: THREE.Quaternion }[] = [];
  private head: THREE.Object3D;
  /** How far the guides are from the figure's own joints at rest (m): 0 means the fit is exact. */
  readonly fitError: number;

  /**
   * holder: the group both are in, at the foot origin; chute: the parachute's scene (its guides at rest);
   * figure: the figure's root (Body.root from net/swat.ts), at rest.
   */
  constructor(private holder: THREE.Object3D, chute: THREE.Object3D, private figure: THREE.Object3D) {
    // Start from the figure's bind pose (arms out, as in Blender), not the pose its nodes load in.
    figure.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && (o as THREE.SkinnedMesh).skeleton.pose());
    holder.updateMatrixWorld(true);
    _hinv.copy(holder.matrixWorld).invert();
    const inHolder = (o: THREE.Object3D) => new THREE.Matrix4().multiplyMatrices(_hinv, o.matrixWorld);
    for (const n of ['Pilot', 'Foot_L', 'Foot_R', 'Shin_L', 'Shin_R', 'Elbow_L', 'Elbow_R', 'Grip_L', 'Grip_R']) {
      const g = chute.getObjectByName(n);
      if (!g) throw new Error(`parachute.glb has no ${n}`);
      this.guides.set(n, g);
      this.restH.set(g, inHolder(g));
    }
    const names = ['Body', 'Head'];
    for (const [s] of SIDES) {
      names.push(`UpperLeg${s}`, `LowerLeg${s}`, `LowerLeg${s}_end`, `Foot${s}`, `UpperArm${s}`, `LowerArm${s}`, `Wrist${s}`);
      for (const f of FINGERS) names.push(`${f}${s}`);
    }
    for (const n of names) {
      const b = figure.getObjectByName(n);
      if (!b) continue;
      this.bones.set(n, b);
      this.rest.set(b, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() });
      this.restH.set(b, inHolder(b));
    }
    this.head = this.bone('Head');
    // Fingers along -x/+x, palms down at rest: curl them towards the palm, round the holder's z axis.
    const hq = holder.getWorldQuaternion(new THREE.Quaternion());
    for (const [s, sx] of SIDES) {
      const axis = new THREE.Vector3(0, 0, -sx).applyQuaternion(hq);
      for (const f of FINGERS) {
        const b = this.bones.get(`${f}${s}`);
        if (!b) continue;
        const k = (CURL[f.slice(-1)] ?? 0.6) * (f.startsWith('Thumb') ? 0.45 : 1);
        const local = axis.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert());
        this.curl.push({ bone: b, q: b.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(local, k)) });
      }
    }
    // The guides were placed on the figure's joints in Blender: check that they still are here.
    const pos = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(this.restH.get(o)!);
    let err = 0;
    for (const [s] of SIDES) {
      err = Math.max(err, pos(this.guide(`Foot_${s}`)).distanceTo(pos(this.bone(`LowerLeg${s}_end`))));
      err = Math.max(err, pos(this.guide(`Shin_${s}`)).distanceTo(pos(this.bone(`LowerLeg${s}`))));
    }
    err = Math.max(err, pos(this.guide('Pilot')).distanceTo(pos(this.bone('Body'))));
    this.fitError = err;
  }

  private bone(n: string): THREE.Object3D {
    const b = this.bones.get(n);
    if (!b) throw new Error(`the figure has no bone ${n}`);
    return b;
  }

  private guide(n: string): THREE.Object3D {
    return this.guides.get(n)!;
  }

  /** A guide's change from rest, D = (guide now) * (guide at rest)^-1, in the holder's space. */
  private delta(g: THREE.Object3D, out: THREE.Matrix4): THREE.Matrix4 {
    _hinv.copy(this.holder.matrixWorld).invert();
    _m2.copy(this.restH.get(g)!).invert();
    return out.multiplyMatrices(_hinv, g.matrixWorld).multiply(_m2);
  }

  /** Move a bone of the figure by the change its guide has made from rest: to D * (bone at rest). */
  private follow(boneName: string, guideName: string): void {
    const b = this.bone(boneName);
    this.delta(this.guide(guideName), _m);
    _m.premultiply(this.holder.matrixWorld).multiply(this.restH.get(b)!);
    _m.premultiply(_m2.copy(b.parent!.matrixWorld).invert());
    _m.decompose(b.position, b.quaternion, b.scale);
    b.updateMatrixWorld(true);
  }

  /** Turn a bone round its own origin so that the world direction `from` points along `to`. */
  private turn(b: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
    _q.setFromUnitVectors(from.normalize(), to.normalize());
    b.getWorldQuaternion(_qp).premultiply(_q);
    b.parent!.getWorldQuaternion(_q).invert();
    b.quaternion.copy(_q.multiply(_qp));
    b.updateMatrixWorld(true);
  }

  /** Two-bone IK: bend upper and lower so the effector reaches the target, the middle joint towards the pole. */
  private reach(upper: THREE.Object3D, lower: THREE.Object3D, effector: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void {
    upper.getWorldPosition(_a);
    lower.getWorldPosition(_b);
    effector.getWorldPosition(_c);
    const l1 = _a.distanceTo(_b);
    const l2 = _b.distanceTo(_c);
    const dir = _t.copy(target).sub(_a);
    const d = Math.min(dir.length(), (l1 + l2) * 0.999);
    dir.normalize();
    const pv = _p.copy(pole).sub(_a);
    pv.addScaledVector(dir, -pv.dot(dir));
    if (pv.lengthSq() < 1e-8) pv.set(0, -1, 0);
    pv.normalize();
    const ca = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
    const elbow = new THREE.Vector3().copy(_a).addScaledVector(dir, ca * l1).addScaledVector(pv, Math.sqrt(1 - ca * ca) * l1);
    this.turn(upper, _b.clone().sub(_a), elbow.clone().sub(_a));
    lower.getWorldPosition(_b);
    effector.getWorldPosition(_c);
    const end = new THREE.Vector3().copy(_a).addScaledVector(dir, d);
    this.turn(lower, _c.clone().sub(_b), end.sub(_b));
  }

  /** Pose the figure on the guides. Call after the parachute's mixer has run and its matrices are current. */
  apply(hideHead = false): void {
    for (const [b, r] of this.rest) {
      b.position.copy(r.p);
      b.quaternion.copy(r.q);
      b.scale.copy(r.s);
    }
    this.holder.updateMatrixWorld(true);
    this.follow('Body', 'Pilot');
    for (const [s] of SIDES) {
      const ankle = this.guide(`Foot_${s}`).getWorldPosition(new THREE.Vector3());
      const knee = this.guide(`Shin_${s}`).getWorldPosition(new THREE.Vector3());
      this.reach(this.bone(`UpperLeg${s}`), this.bone(`LowerLeg${s}`), this.bone(`LowerLeg${s}_end`), ankle, knee);
      this.follow(`Foot${s}`, `Foot_${s}`);
      const grip = this.guide(`Grip_${s}`).getWorldPosition(new THREE.Vector3());
      const shoulder = this.bone(`UpperArm${s}`).getWorldPosition(new THREE.Vector3());
      const wrist = grip.clone().addScaledVector(grip.clone().sub(shoulder).normalize(), -0.05);
      const elbow = this.guide(`Elbow_${s}`).getWorldPosition(new THREE.Vector3());
      this.reach(this.bone(`UpperArm${s}`), this.bone(`LowerArm${s}`), this.bone(`Wrist${s}`), wrist, elbow);
    }
    for (const c of this.curl) c.bone.quaternion.copy(c.q);
    const hr = this.rest.get(this.head)!;
    this.head.scale.copy(hr.s).multiplyScalar(hideHead ? 0.001 : 1);
    this.figure.updateMatrixWorld(true);
  }

  /** The eyes, moved with the pilot (world space). */
  eye(out: THREE.Vector3): THREE.Vector3 {
    this.delta(this.guide('Pilot'), _m);
    return out.copy(EYE).applyMatrix4(_m).applyMatrix4(this.holder.matrixWorld);
  }
}
