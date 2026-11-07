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
 *
 * The weather (world/weather.ts) sets the outside's colours and strengths through `setOutside`: grey and
 * even under clouds, dark blue at night, where the rooms are lit by their own lamps (`inside`).
 */
const SKY_IN = new THREE.Color('#f8efe4');
const GROUND_IN = new THREE.Color('#ecd8c2');
const HEMI = [0.9, 1.8]; // outside, inside
const ENV = [0.9, 0.55];

export class IndoorLight {
  private inside = 0;
  private readonly sky: THREE.Color;
  private readonly ground: THREE.Color;
  /** The weather's: the hemisphere's and the sky photo's strength outside, and both indoors, as factors */
  private hemiOut = 1;
  private envOut = 1;
  private inScale = 1;

  constructor(private hemi: THREE.HemisphereLight, private scene: THREE.Scene) {
    this.sky = hemi.color.clone();
    this.ground = hemi.groundColor.clone();
  }

  /** The weather's outside light: the hemisphere's colours, its strength and the sky photo's as factors of the sunny day's, and indoors' as one. */
  setOutside(sky: THREE.Color, ground: THREE.Color, hemi: number, env: number, inside: number): void {
    this.sky.copy(sky);
    this.ground.copy(ground);
    this.hemiOut = hemi;
    this.envOut = env;
    this.inScale = inside;
  }

  /** Each frame: whether the player is indoors (with real-time lighting); `fill` scales it all (the baked lighting test turns it down). */
  update(dt: number, indoors: boolean, fill: number): void {
    this.inside += ((indoors ? 1 : 0) - this.inside) * (1 - Math.exp(-dt * 1.5));
    const t = this.inside;
    this.hemi.color.lerpColors(this.sky, SKY_IN, t);
    this.hemi.groundColor.lerpColors(this.ground, GROUND_IN, t);
    this.hemi.intensity = (HEMI[0] * this.hemiOut + (HEMI[1] * this.inScale - HEMI[0] * this.hemiOut) * t) * fill;
    this.scene.environmentIntensity = (ENV[0] * this.envOut + (ENV[1] * this.envOut - ENV[0] * this.envOut) * t) * fill;
  }
}
