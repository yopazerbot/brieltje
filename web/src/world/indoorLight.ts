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
  /** The sky photo's light outside only, as a factor (less in the sun: world/weather.ts `fill`); the rooms keep theirs */
  private fillOut = 1;
  private inScale = 1;
  /** A place of its own (the café, world/keet.ts): its colour indoors and its strength as a factor of a home's, eased in */
  private place = 0;
  private placeWanted = 0;
  private placeColor = new THREE.Color();
  private placeScale = 1;
  private readonly skyIn = new THREE.Color();
  private readonly groundIn = new THREE.Color();

  constructor(private hemi: THREE.HemisphereLight, private scene: THREE.Scene) {
    this.sky = hemi.color.clone();
    this.ground = hemi.groundColor.clone();
  }

  /** The weather's outside light: the hemisphere's colours, its strength and the sky photo's as factors of the sunny day's, and indoors' as one. */
  setOutside(sky: THREE.Color, ground: THREE.Color, hemi: number, env: number, inside: number, fill = 1): void {
    this.sky.copy(sky);
    this.ground.copy(ground);
    this.hemiOut = hemi;
    this.envOut = env;
    this.inScale = inside;
    this.fillOut = fill;
  }

  /**
   * The place the player is in, when it is lit otherwise than a home: `color` the fill's colour indoors there and
   * `scale` its strength as a factor of a home's (the café: warmer and dimmer). Null: as in a home.
   */
  setPlace(color: THREE.Color | null, scale = 1): void {
    this.placeWanted = color ? 1 : 0;
    if (color) {
      this.placeColor.copy(color);
      this.placeScale = scale;
    }
  }

  /** Each frame: whether the player is indoors (with real-time lighting); `fill` scales it all (the baked lighting test turns it down). */
  update(dt: number, indoors: boolean, fill: number): void {
    this.inside += ((indoors ? 1 : 0) - this.inside) * (1 - Math.exp(-dt * 1.5));
    const t = this.inside;
    this.place += (this.placeWanted - this.place) * (1 - Math.exp(-dt * 1.5));
    if (this.place < 1e-3 && !this.placeWanted) this.place = 0; // then a home's light exactly as before
    const p = this.place;
    const skyIn = p ? this.skyIn.lerpColors(SKY_IN, this.placeColor, p) : SKY_IN;
    const groundIn = p ? this.groundIn.lerpColors(GROUND_IN, this.placeColor, p) : GROUND_IN;
    const inHemi = p ? HEMI[1] * (1 + (this.placeScale - 1) * p) : HEMI[1];
    this.hemi.color.lerpColors(this.sky, skyIn, t);
    this.hemi.groundColor.lerpColors(this.ground, groundIn, t);
    this.hemi.intensity = (HEMI[0] * this.hemiOut + (inHemi * this.inScale - HEMI[0] * this.hemiOut) * t) * fill;
    this.scene.environmentIntensity = (ENV[0] * this.envOut * this.fillOut + (ENV[1] * this.envOut - ENV[0] * this.envOut * this.fillOut) * t) * fill;
  }
}
