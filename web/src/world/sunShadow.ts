import * as THREE from 'three';

/**
 * Where the sun's real-time shadow map lies (graphics.ts shadowReach).
 *
 * On Low it stays on the main house, 17 m round it, and is only drawn near the house (main.ts), as it always
 * was. On Medium and up it follows the eye: its middle lies ahead of you, so more of it is in front than
 * behind, and it moves only by whole texels of the map, along the map's own rows and columns. A map that
 * slides by part of a texel draws every shadow edge a little differently each frame, and edges crawl as you
 * walk (shimmer); moved by whole texels, a still edge stays the same.
 *
 * One map, not cascades (three's CSM puts its own shader on every material and would replace the game's own
 * changes to them, and each cascade is a shadow pass more). Further off, the bakes already hold the shadows of
 * everything that stands still: world/groundShade.ts on the ground, world/bakedLight.ts on our own models.
 * What a far map would add is the shadows of what moves, which are small that far away. The ground hands over
 * from its bake to this map where the map reaches (`uniforms`), so the bake's soft, coarse shadow doesn't lie
 * as a halo round the map's sharp one.
 */

/** The house's map: its middle, half its width, and its depth along the sun (as before the map could move). */
const HOME_HALF = 17;
const HOME_AWAY = 60;
const HOME_NEAR = 5;
const HOME_FAR = 140;
/** A following map: the light this far up the sun from its middle, seeing this far towards and past it. */
const AWAY = 140;
const NEAR = 10; // 130 m towards the sun: the church tower's shadow at a low sun
const FAR = 260; // 120 m past the middle: the ground down-sun of it, at a low sun
/** The house map's bias, in metres along the sun's ray (three's bias is a share of the depth range). */
const BIAS_M = 0.0003 * (HOME_FAR - HOME_NEAR);
const UP = new THREE.Vector3(0, 1, 0);

export class SunShadow {
  /**
   * For the ground's handover (world/groundShade.ts): world to the map's clip space (-1 to 1 inside it), and
   * 1 while the map is drawn.
   */
  readonly uniforms = { liveMatrix: { value: new THREE.Matrix4() }, liveOn: { value: 0 } };
  /** The map's middle now (world/tiles.ts draws the tiles round it into the map). */
  readonly middle = new THREE.Vector3();
  private reach = 0;
  private texel = 1;
  private dir = new THREE.Vector3();
  private x = new THREE.Vector3();
  private y = new THREE.Vector3();
  private fwd = new THREE.Vector3();

  constructor(
    private sun: THREE.DirectionalLight,
    private home: THREE.Vector3,
  ) {
    this.middle.copy(home);
  }

  /** Whether the map follows the eye (Medium and up). */
  get follows(): boolean {
    return this.reach > 0;
  }

  /** The preset's reach (0: on the house) and the map's size in texels. */
  setup(reach: number, size: number): void {
    this.reach = reach;
    const half = reach > 0 ? reach : HOME_HALF;
    const c = this.sun.shadow.camera;
    c.left = c.bottom = -half;
    c.right = c.top = half;
    c.near = reach > 0 ? NEAR : HOME_NEAR;
    c.far = reach > 0 ? FAR : HOME_FAR;
    c.updateProjectionMatrix();
    this.sun.shadow.bias = -BIAS_M / (c.far - c.near);
    this.texel = (2 * half) / Math.max(1, size);
  }

  /** Each frame, before drawing: the map round the eye (or on the house), and the ground's matrix for it. */
  update(camera: THREE.Camera): void {
    const sun = this.sun;
    // The sun's direction as the light has it now (world/environment.ts sets it from the sky photo).
    this.dir.subVectors(sun.position, sun.target.position);
    if (this.dir.lengthSq() < 1e-8) return;
    this.dir.normalize();
    if (this.reach > 0) {
      // The map's rows and columns, as three's shadow camera looks along the sun (Matrix4.lookAt).
      this.x.crossVectors(UP, this.dir);
      if (this.x.lengthSq() < 1e-8) this.x.set(1, 0, 0);
      this.x.normalize();
      this.y.crossVectors(this.dir, this.x);
      // Ahead of the eye on the ground, so that the eye is half the reach from the middle in the map.
      camera.getWorldDirection(this.fwd);
      this.fwd.y = 0;
      if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
      this.fwd.normalize();
      const across = Math.hypot(this.fwd.dot(this.x), this.fwd.dot(this.y));
      const ahead = Math.min((0.5 * this.reach) / Math.max(across, 1e-3), 2 * this.reach);
      const p = this.middle.copy(camera.position).addScaledVector(this.fwd, ahead);
      p.y -= 1.5;
      // Whole texels along the map's rows and columns; along the sun it doesn't matter.
      const t = this.texel;
      const px = Math.round(p.dot(this.x) / t) * t;
      const py = Math.round(p.dot(this.y) / t) * t;
      const pz = p.dot(this.dir);
      p.copy(this.x).multiplyScalar(px).addScaledVector(this.y, py).addScaledVector(this.dir, pz);
    } else this.middle.copy(this.home);
    sun.target.position.copy(this.middle);
    sun.position.copy(this.middle).addScaledVector(this.dir, this.reach > 0 ? AWAY : HOME_AWAY);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    const c = sun.shadow.camera;
    this.uniforms.liveMatrix.value.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.uniforms.liveOn.value = sun.castShadow ? 1 : 0;
  }
}
