import * as THREE from 'three';
import type { Surroundings } from './houseData';

/**
 * The street lamps lit at night (world/weather.ts): a warm glow at each lamp's head and a pool of its light on the
 * ground below, for every lamp on the poles along the roads (world/surroundings.ts draws the lamps themselves).
 *
 * No real lights: each would cost every lit pixel of the world a little, and the village has hundreds of lamps. The
 * glows are small squares turned to the eye, added onto what is drawn; the pools flat discs on the ground that
 * brighten what is under them. Two draw calls for all of them, a few arithmetic steps a pixel and no texture. Hidden
 * by day.
 * The lamps' places come from the same list as the lamps (main.ts `poles`: the ring's at the start, the village's
 * added when it comes), read again when it grows.
 */

type Pole = NonNullable<Surroundings['poles']>[number];

/** Warm white of the lamps (linear, under the half floats' end by far). */
const LAMP = new THREE.Color(1.0, 0.66, 0.34);
/** Radius of a lamp's pool of light on the ground (m). */
const POOL = 7.5;

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
const poolVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv - 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;
const poolFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  varying vec2 vUv;
  void main() {
    float r = length(vUv) * 2.0;
    float pool = (1.0 - smoothstep(0.0, 1.0, r)) * (0.35 + 0.65 * exp(-r * r * 5.0));
    gl_FragColor = vec4(color * pool * strength * 14.0, 1.0); // up to fifteen times as bright under the lamp
  }`;

export class StreetLights {
  readonly group = new THREE.Group();
  private uniforms = { color: { value: LAMP.clone() }, strength: { value: 0 }, size: { value: 1.3 } };
  private glows: THREE.InstancedMesh | null = null;
  private pools: THREE.InstancedMesh | null = null;
  private built = -1;
  private on = 0;

  /** `poles`: the list the lamps are built from (it grows when the village comes); `ground`: the ground's height where a pole has none. */
  constructor(private poles: Pole[], private ground: number) {
    this.group.name = 'street lights';
    this.group.visible = false;
  }

  /** How much they shine, 0 (day) to 1 (night). */
  set(on: number): void {
    this.on = on;
  }

  update(): void {
    this.group.visible = this.on > 0.01;
    if (!this.group.visible) return;
    if (this.built !== this.poles.length) this.build();
    this.uniforms.strength.value = this.on;
  }

  private build(): void {
    this.built = this.poles.length;
    for (const m of [this.glows, this.pools]) {
      if (!m) continue;
      this.group.remove(m);
      m.dispose();
    }
    const n = this.poles.length;
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false } as const;
    const glowMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: glowVertex, fragmentShader: glowFragment, ...additive });
    // The pool brightens what is drawn there by a factor (what is there times one plus the pool): light falling on the
    // ground's own colour, so the paving's pattern and a dark lawn stay what they are, only lit.
    const poolMat = new THREE.ShaderMaterial({
      uniforms: { color: this.uniforms.color, strength: this.uniforms.strength },
      vertexShader: poolVertex,
      fragmentShader: poolFragment,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, n);
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(POOL * 2, POOL * 2).rotateX(-Math.PI / 2), poolMat, n);
    const m = new THREE.Matrix4();
    this.poles.forEach((p, i) => {
      const head = headOf(p, this.ground);
      this.glows!.setMatrixAt(i, m.makeTranslation(head.x, head.y - 0.14, head.z)); // just under the head, not in it
      this.pools!.setMatrixAt(i, m.makeTranslation(head.x, (p.y ?? this.ground) + 0.06, head.z));
    });
    for (const mesh of [this.glows, this.pools]) {
      mesh.frustumCulled = false; // spread over the whole map: one bounding sphere would always be in view anyway
      mesh.raycast = () => {}; // never in the way of a shot
      mesh.userData.noAO = true;
      mesh.renderOrder = 60;
      this.group.add(mesh);
    }
  }
}
