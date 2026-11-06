import * as THREE from 'three';

/**
 * The soft fill light, outside and in. Outside it is the sky photo and a hemisphere light: blue
 * from above, the colour of the ground from below. Indoors that made the rooms of the main house
 * cool grey, with ceilings darker than the walls, while the rooms should be warm white
 * rooms: their light has bounced off light floors and walls, and lights the ceilings almost as
 * much as the walls. So indoors the hemisphere light grows warmer and about twice as strong (it is
 * what lights ceilings), and the sky photo's own light, which the walls and roof keep out, drops
 * to about half. It changes as gently as the eyes adapt to the brightness (main.ts), and costs
 * nothing: only a few numbers change.
 */
const SKY_IN = new THREE.Color('#f8efe4');
const GROUND_IN = new THREE.Color('#ecd8c2');
const HEMI = [0.9, 1.8]; // outside, inside
const ENV = [0.9, 0.55];

export class IndoorLight {
  private inside = 0;
  private readonly sky: THREE.Color;
  private readonly ground: THREE.Color;

  constructor(private hemi: THREE.HemisphereLight, private scene: THREE.Scene) {
    this.sky = hemi.color.clone();
    this.ground = hemi.groundColor.clone();
  }

  /** Each frame: whether the player is indoors (with real-time lighting); `fill` scales it all (the baked lighting test turns it down). */
  update(dt: number, indoors: boolean, fill: number): void {
    this.inside += ((indoors ? 1 : 0) - this.inside) * (1 - Math.exp(-dt * 1.5));
    const t = this.inside;
    this.hemi.color.lerpColors(this.sky, SKY_IN, t);
    this.hemi.groundColor.lerpColors(this.ground, GROUND_IN, t);
    this.hemi.intensity = (HEMI[0] + (HEMI[1] - HEMI[0]) * t) * fill;
    this.scene.environmentIntensity = (ENV[0] + (ENV[1] - ENV[0]) * t) * fill;
  }
}
