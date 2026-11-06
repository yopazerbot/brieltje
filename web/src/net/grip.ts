import * as THREE from 'three';
import type { WeaponId } from '../weapon';

/** Wrist anchors in metres in the gun's frame: right, up, back along the barrel. */
export const GRIPS: Record<WeaponId, { right: THREE.Vector3; left: THREE.Vector3 }> = {
  pistol: { right: new THREE.Vector3(0, 0.02, 0.05), left: new THREE.Vector3(-0.035, -0.015, 0.065) },
  rifle: { right: new THREE.Vector3(0, 0.02, 0.05), left: new THREE.Vector3(0, 0.04, -0.22) },
  shotgun: { right: new THREE.Vector3(0, 0.02, 0.05), left: new THREE.Vector3(0, 0.04, -0.26) },
  sniper: { right: new THREE.Vector3(0, 0.02, 0.05), left: new THREE.Vector3(0, 0.04, -0.26) },
  bazooka: { right: new THREE.Vector3(0, -0.06, 0.02), left: new THREE.Vector3(0, -0.08, -0.18) },
};

/** Sample the model's closed-hand shooting pose once, independent of walking animations. */
export function gripPose(model: THREE.Object3D, clip: THREE.AnimationClip) {
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(clip).play();
  mixer.update(0);
  model.updateMatrixWorld(true);
  const right = model.getObjectByName('WristR')!.getWorldQuaternion(new THREE.Quaternion());
  // The support palm faces up, with its fingers along the fore-end. The authored run pose
  // points this wrist down; keeping that rotation makes the hand hang below the magazine.
  const left = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0),
  ));
  const fingers = new Map<string, THREE.Quaternion>();
  model.traverse((bone) => {
    if (/^(Index|Middle|Ring|Pinky|Thumb)\d[LR]$/.test(bone.name)) fingers.set(bone.name, bone.quaternion.clone());
  });
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  return { right, left, fingers };
}

/** Move the gun just enough for both wrists to remain inside their arm's reach. */
export function fitGrip(origin: THREE.Vector3, offsets: THREE.Vector3[], shoulders: THREE.Vector3[], lengths: number[]): void {
  // Alternating projections keep both anchors on the same rigid gun, with a little elbow bend.
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < 2; i++) {
      const dx = origin.x + offsets[i].x - shoulders[i].x;
      const dy = origin.y + offsets[i].y - shoulders[i].y;
      const dz = origin.z + offsets[i].z - shoulders[i].z;
      const distance = Math.hypot(dx, dy, dz);
      const excess = distance - lengths[i] * 0.97;
      if (excess > 0) {
        const shift = excess / distance;
        origin.x -= dx * shift;
        origin.y -= dy * shift;
        origin.z -= dz * shift;
      }
    }
  }
}

const handParent = new THREE.Quaternion();

/** Hold a hand's grip orientation in the gun's aiming frame, rather than the animation's. */
export function alignHand(wrist: THREE.Object3D, frame: THREE.Quaternion, pose: THREE.Quaternion): void {
  wrist.parent!.getWorldQuaternion(handParent).invert();
  wrist.quaternion.copy(handParent.multiply(frame).multiply(pose));
  wrist.updateMatrixWorld(true);
}
