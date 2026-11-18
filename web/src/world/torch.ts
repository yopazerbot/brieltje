import * as THREE from 'three';

/**
 * The torch on your gun: a cone of warm light where you look, on by itself once it is dark and you
 * hold a gun, off again by day. One spot light without a shadow, made with the game and kept in
 * the scene for good: a light added or taken away later makes every lit shader compile again (a
 * stutter each dusk), so by day it stays where it is with no strength. Not on phones (main.ts makes
 * none there): every lit surface pays a little for it, and a phone has little to spare.
 *
 * What that costs by day: about 0.15 ms a frame on High and 0.05 on Low (measured with the light in
 * and out of the scene, alternated). Hiding it by day and compiling the shaders with it in the
 * background as dusk begins was tried and dropped: starting those compiles alone froze the game for
 * 0.35 to 0.65 s as night fell, which is worse than the cost it saved.
 *
 * Only your own torch is a real light. Others see your figure as ever.
 */

/**
 * Strength at full; the beam reaches REACH metres. It falls off with the distance itself, not its square or near it:
 * the night's exposure is high, and with the steeper fall (180 and 1.7 before 18 Nov 2026) what stood a few metres
 * ahead was lit ten times as much as the street at 20 m, so a light thing close by burnt out to white and glowed in
 * the bloom (Sinterklaas's white horse on the church square, "like a ghost"). Now a white coat at 6 m keeps its
 * shading, as the villagers next to it do, and the beam still shows on the street 20 m on.
 */
const POWER = 20;
const DECAY = 1;
const REACH = 46;

export class Torch {
  readonly light = new THREE.SpotLight('#fff1d6', 0, REACH, 0.4, 0.6, DECAY);
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
    // A little ahead of and under the eye, where the gun is held, so the beam's edge shows on what is close.
    this.light.position.addScaledVector(this.ahead, 0.25).y -= 0.12;
    this.light.target.position.copy(this.light.position).addScaledVector(this.ahead, 12);
    this.light.target.updateMatrixWorld();
  }
}
