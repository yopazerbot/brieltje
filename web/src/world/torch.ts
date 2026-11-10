import * as THREE from 'three';

/**
 * The torch on your gun: a cone of warm light where you look, on by itself once it is dark and you
 * hold a gun, off again by day. One spot light without a shadow, made with the game and kept in
 * the scene for good: a light added or taken away later makes every lit shader compile again (a
 * stutter each dusk), so by day it stays where it is with no strength. Not on phones (main.ts makes
 * none there): every lit surface pays a little for it, and a phone has little to spare.
 *
 * Only your own torch is a real light. Others see your figure as ever.
 */

/** Candela at full strength; the beam reaches REACH metres. */
const POWER = 180;
const REACH = 46;

export class Torch {
  readonly light = new THREE.SpotLight('#fff1d6', 0, REACH, 0.4, 0.6, 1.7);
  private level = 0;
  private ahead = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.light.castShadow = false;
    scene.add(this.light, this.light.target);
  }

  /** `on` 0..1: how dark it is, with a gun in your hands (0: by day, or unarmed). Follows the eye. */
  update(camera: THREE.Camera, on: number, dt: number): void {
    this.level += (on - this.level) * (1 - Math.exp(-dt * 3));
    this.light.intensity = this.level < 0.01 ? 0 : POWER * this.level;
    if (this.light.intensity === 0) return;
    camera.getWorldPosition(this.light.position);
    camera.getWorldDirection(this.ahead);
    // A little right of and under the eye, where the gun is held, so the beam's edge shows on what is close.
    this.light.position.addScaledVector(this.ahead, 0.25).y -= 0.12;
    this.light.target.position.copy(this.light.position).addScaledVector(this.ahead, 12);
    this.light.target.updateMatrixWorld();
  }
}
