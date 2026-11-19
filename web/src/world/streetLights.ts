import * as THREE from 'three';
import type { Surroundings } from './houseData';
import { terrain } from './terrain';

/**
 * The street lamps lit at night (world/weather.ts): a warm glow at each lamp's head and a pool of its light on the
 * ground below, for every lamp on the poles along the roads (world/surroundings.ts draws the lamps themselves).
 *
 * No real lights: each would cost every lit pixel of the world a little, and the village has hundreds of lamps. The
 * glows are small squares turned to the eye, added onto what is drawn; the pools a sheet laid on the ground's relief
 * round the lamps that brightens what is under it. Two draw calls for all of them, a few arithmetic steps a pixel and
 * no texture, on every preset. Hidden by day.
 *
 * The pools were flat discs at the pole's foot, and the paving round a lamp is rarely flat: most of each disc lay a
 * few centimetres under it and only slivers showed (18 Nov 2026, Yoshi: the lamps made little visible light on the
 * ground). The sheet now follows the relief (world/terrain.ts) in squares of 4 m, the relief's own spacing, and is
 * drawn as if a little nearer to the eye than it is, along the line of sight (so it stays exactly where it is on the
 * screen), by more the farther it is: it shows over the paving, kerbs and the models' own ground that lie up to a few
 * decimetres over the relief. Each square lies once, whatever the lamps round it, and carries the three lamps that
 * light it most: where two pools meet their light adds up, as light does (discs one over another multiplied it, and
 * burnt the ground out). The light falls off mostly as a lamp's does on the ground (the cosine cubed over the height:
 * all of it under the head, a third at the head's height out), with a wider share that carries it on along the street
 * and fades to nothing at 2.6 times the height, with no edge to be seen (19 Nov 2026: the pools ended in a rim). How
 * much it brightens is the lamp's light over the light already there (LAMP_GROUND), not a fixed factor.
 * The lamps' places come from the same list as the lamps (main.ts `poles`: the ring's at the start, the village's
 * added when it comes), read again when it grows.
 */

type Pole = NonNullable<Surroundings['poles']>[number];

/** Warm white of the lamps (linear, under the half floats' end by far). */
const LAMP = new THREE.Color(1.0, 0.66, 0.34);
/**
 * The pools brighten what is drawn by a factor: the ground's own colour times the night's light on it, which is
 * blue (the moon and the night sky; its colour here, at a brightness of one). Lit by the lamp it should take the
 * lamp's colour, so the factor is the lamp's colour over the night's: more for red than for blue.
 */
const NIGHT_LIGHT = new THREE.Color(0.4, 0.54, 1.0).multiplyScalar(1 / (0.2126 * 0.4 + 0.7152 * 0.54 + 0.0722));
const POOL_TINT = new THREE.Color(LAMP.r / NIGHT_LIGHT.r, LAMP.g / NIGHT_LIGHT.g, LAMP.b / NIGHT_LIGHT.b);
/**
 * The light of a lamp on the ground straight under it, at full night (in the lamp's colour). The pool's factor is
 * this over the light that is there already (`set`): at night it brightens the paving several times, at dusk, with
 * more of the sky's light about, by less; it never burns the paving out to one pale colour (18 Nov 2026: a fixed
 * factor of 18 did, a pool 15 m across with no joints or texture left in it).
 */
const LAMP_GROUND = 1.8;
/** A pool reaches this many times the head's height from the foot, fading softly all the way; past it nothing is drawn. */
const POOL_REACH = 2.6;
/** The sheet's squares (m): the relief's own spacing. */
const CELL = 4;

/** The lamp's head (where it shines from) for each kind of pole, as world/surroundings.ts builds them. */
function headOf(p: Pole, ground: number): THREE.Vector3 {
  const foot = p.y ?? ground;
  const [ax, az] = p.arm;
  const along = (d: number, y: number) => new THREE.Vector3(p.x + ax * d, foot + y, p.z + az * d);
  if (p.k === 'lantern') return new THREE.Vector3(p.x, foot + 3.6, p.z);
  if (p.k === 'striped') return along(3.88, 6.32);
  if (p.k === 'post') return along(0.86, 5.9);
  return along(1.86, 7.48); // the concrete poles: a lamp on a rising arm at 7.4 m
}

const glowVertex = /* glsl */ `
  uniform float size;
  varying vec2 vUv;
  void main() {
    vUv = uv - 0.5;
    vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    centre.xy += position.xy * size; // turned to the eye
    gl_Position = projectionMatrix * centre;
  }`;
const glowFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  varying vec2 vUv;
  void main() {
    float r = length(vUv) * 2.0;
    float glow = (exp(-r * r * 9.0) * 3.0 + exp(-r * r * 2.2) * 0.35) * (1.0 - smoothstep(0.6, 1.0, r)); // round, no square's edge
    gl_FragColor = vec4(color * glow * strength, 1.0);
  }`;
// `lampA` to `lampC`: the three lamps that light the square most (x, z under the head, and the head's height over the
// ground; 0 for none). Pulled towards the eye along the line of sight by 0.15 m and 4 % of the distance: the same
// pixel, nearer in the depth buffer, so the paving a little over the relief doesn't hide it.
const poolVertex = /* glsl */ `
  attribute vec3 lampA;
  attribute vec3 lampB;
  attribute vec3 lampC;
  varying vec3 vA;
  varying vec3 vB;
  varying vec3 vC;
  varying vec2 vAt;
  varying float vFar;
  void main() {
    vA = lampA;
    vB = lampB;
    vC = lampC;
    vAt = (modelMatrix * vec4(position, 1.0)).xz;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float far = length(mv.xyz);
    vFar = far;
    mv.xyz *= 1.0 - min(0.15 + 0.04 * far, 0.5 * far) / max(far, 1e-3);
    gl_Position = projectionMatrix * mv;
  }`;
const poolFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #endif
  varying vec3 vA;
  varying vec3 vB;
  varying vec3 vC;
  varying vec2 vAt;
  varying float vFar;
  float pool(vec3 lamp) {
    if (lamp.z <= 0.0) return 0.0;
    vec2 d = (vAt - lamp.xy) / lamp.z;
    float q = dot(d, d); // (distance over height) squared, from under the head
    float edge = q * q * ${(1 / POOL_REACH ** 4).toExponential(4)}; // (distance over reach) to the fourth
    float fade = max(1.0 - edge, 0.0);
    // Mostly the cosine cubed, with a wider share (a lamp's optics spread it along the street), fading to nothing at the reach.
    return (0.7 * pow(1.0 + q, -1.5) + 0.3 * pow(1.0 + q * 0.25, -1.5)) * fade * fade;
  }
  void main() {
    float light = pool(vA) + pool(vB) + pool(vC);
    #ifdef FOG_EXP2
      light *= exp(-fogDensity * fogDensity * vFar * vFar); // what the haze hides of the ground hides its light too
    #endif
    gl_FragColor = vec4(color * light * strength, 1.0);
  }`;

export class StreetLights {
  readonly group = new THREE.Group();
  private uniforms = { color: { value: LAMP.clone() }, strength: { value: 0 }, size: { value: 1.3 } };
  /** The pools' factor: the lamp's light over the light already on the ground */
  private poolStrength = { value: 0 };
  private glows: THREE.InstancedMesh | null = null;
  private pools: THREE.Mesh | null = null;
  private built = -1;
  private on = 0;
  /** The ground's light from the sky and the moon (or the sun), as a luminance */
  private fill = 1;

  /** `poles`: the list the lamps are built from (it grows when the village comes); `ground`: the ground's height where a pole has none. */
  constructor(private poles: Pole[], private ground: number) {
    this.group.name = 'street lights';
    this.group.visible = false;
  }

  /** How much they shine, 0 (day) to 1 (night); `fill`: the light already on open ground (a luminance, world/weather.ts). */
  set(on: number, fill: number): void {
    this.on = on;
    this.fill = Math.max(fill, 0.05);
  }

  update(): void {
    // Built as soon as the list grows, by day too: laying the pools takes some 40 ms, which goes unseen while the
    // village comes in and would stall the game a moment at dusk.
    if (this.built !== this.poles.length) this.build();
    this.group.visible = this.on > 0.01;
    if (!this.group.visible) return;
    this.uniforms.strength.value = this.on;
    this.poolStrength.value = (this.on * LAMP_GROUND) / this.fill;
  }

  private build(): void {
    this.built = this.poles.length;
    for (const m of [this.glows, this.pools]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    const n = this.poles.length;
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false } as const;
    const glowMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: glowVertex, fragmentShader: glowFragment, ...additive });
    // The pool brightens what is drawn there by a factor (what is there times one plus the pool): light falling on the
    // ground's own colour, so the paving's pattern and a dark lawn stay what they are, only lit.
    const poolMat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), color: { value: POOL_TINT.clone() }, strength: this.poolStrength },
      vertexShader: poolVertex,
      fragmentShader: poolFragment,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
    });
    this.glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, n);
    this.pools = new THREE.Mesh(this.poolGeometry(), poolMat);
    const m = new THREE.Matrix4();
    this.poles.forEach((p, i) => {
      const head = headOf(p, this.ground);
      this.glows!.setMatrixAt(i, m.makeTranslation(head.x, head.y - 0.14, head.z)); // just under the head, not in it
    });
    for (const mesh of [this.glows, this.pools]) {
      mesh.frustumCulled = false; // spread over the whole map: one bounding sphere would always be in view anyway
      mesh.raycast = () => {}; // never in the way of a shot
      mesh.userData.noAO = true;
      mesh.renderOrder = 60;
      this.group.add(mesh);
    }
  }

  /**
   * Every lamp's pool in one mesh: the squares of a 4 m grid that some lamp reaches, each once, its corners on the
   * relief (a few centimetres over it), with the three lamps that light its middle most.
   */
  private poolGeometry(): THREE.BufferGeometry {
    const lamps = this.poles.map((p) => {
      const head = headOf(p, this.ground);
      const h = Math.max(2.5, head.y - (this.ground + terrain.height(head.x, head.z)));
      return { x: head.x, z: head.z, h };
    });
    // Which lamps reach each square (by its corner's grid numbers).
    const cells = new Map<string, number[]>();
    lamps.forEach((l, k) => {
      const reach = l.h * POOL_REACH + CELL * 0.71;
      for (let i = Math.floor((l.x - reach) / CELL); i <= Math.floor((l.x + reach) / CELL); i++) {
        for (let j = Math.floor((l.z - reach) / CELL); j <= Math.floor((l.z + reach) / CELL); j++) {
          if (Math.hypot((i + 0.5) * CELL - l.x, (j + 0.5) * CELL - l.z) > reach) continue;
          const key = `${i},${j}`;
          const list = cells.get(key);
          if (list) list.push(k);
          else cells.set(key, [k]);
        }
      }
    });
    const pos: number[] = [];
    const attrs: [number[], number[], number[]] = [[], [], []];
    const index: number[] = [];
    const light = (k: number, x: number, z: number) => {
      const l = lamps[k];
      return (1 + ((x - l.x) ** 2 + (z - l.z) ** 2) / (l.h * l.h)) ** -1.5;
    };
    for (const [key, list] of cells) {
      const [i, j] = key.split(',').map(Number);
      const cx = (i + 0.5) * CELL;
      const cz = (j + 0.5) * CELL;
      const most = list.sort((a, b) => light(b, cx, cz) - light(a, cx, cz)).slice(0, 3);
      const first = pos.length / 3;
      for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = (i + di) * CELL;
        const z = (j + dj) * CELL;
        pos.push(x, this.ground + terrain.height(x, z) + 0.04, z);
        for (let n = 0; n < 3; n++) {
          const l = lamps[most[n]];
          attrs[n].push(...(l ? [l.x, l.z, l.h] : [0, 0, 0]));
        }
      }
      index.push(first, first + 2, first + 1, first + 1, first + 2, first + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ['lampA', 'lampB', 'lampC'].forEach((name, n) => g.setAttribute(name, new THREE.Float32BufferAttribute(attrs[n], 3)));
    g.setIndex(index);
    return g;
  }
}
