import * as THREE from 'three';
import { daylight } from './daylight';
import type { Particles, Spawn } from './particles';
import { PARTICLE } from './sprites';
import { waterLevel, type Wet } from './water';

/**
 * Splashes on the ponds and ditches (world/water.ts): drops thrown up from the shared particle pools
 * (world/particles.ts: the soft round sprite, falling back under gravity, stretched along their flight) and
 * rings spreading on the surface. A step in the water throws a few drops ahead and leaves a ring; running
 * throws more; a jump in is a burst with a mist and two or three rings; afloat, rings spread from you as you
 * swim or tread water; a shot into the water throws up a little spout; a car through a ford sprays from its
 * wheels. The rings are flat squares on the water, one instanced draw for all of them, drawn as a thin bright
 * line in their fragment shader: small, so cheap even on Low. Both take the day's light (dark at night).
 */

const RINGS = 96;
const DROP = new THREE.Color('#dfe7e8');
const MIST = new THREE.Color('#e9eef0');

const VERT = /* glsl */ `
attribute vec4 iRing; // x, y, z, radius (m)
attribute float iAlpha;
varying vec2 vUv;
varying float vAlpha;
varying float vWidth;
void main() {
  vUv = position.xy * 2.0; // -1 .. 1 across the square
  vAlpha = iAlpha;
  vWidth = clamp(0.05 / max(iRing.w, 0.01), 0.03, 0.45); // about 5 cm wide whatever the size
  vec3 p = vec3(iRing.x + position.x * 2.0 * iRing.w, iRing.y, iRing.z - position.y * 2.0 * iRing.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 color;
uniform float light;
varying vec2 vUv;
varying float vAlpha;
varying float vWidth;
void main() {
  float r = length(vUv);
  // A bright crest at the edge and a fainter one inside it.
  float a = smoothstep(vWidth, 0.0, abs(r - 1.0 + vWidth)) + 0.3 * smoothstep(vWidth * 1.5, 0.0, abs(r - 0.7));
  if (a * vAlpha < 0.01) discard;
  gl_FragColor = vec4(color * light, a * vAlpha);
}`;

interface Ring {
  x: number;
  y: number;
  z: number;
  /** Seconds lived and to live */
  t: number;
  life: number;
  /** Radius at the start and at the end (m) */
  r0: number;
  r1: number;
  alpha: number;
}

export class Splashes {
  readonly mesh: THREE.Mesh;
  private rings: Ring[] = [];
  private iRing: THREE.InstancedBufferAttribute;
  private iAlpha: THREE.InstancedBufferAttribute;
  private geo = new THREE.InstancedBufferGeometry();
  private light = { value: 1 };
  /** Afloat: seconds to the next ring round you */
  private tread = 0;
  /** Each car's last place, to tell its speed by (whoever drives it) */
  private cars = new Map<string, { x: number; z: number }>();

  private s: Spawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
    c0: new THREE.Color(), c1: new THREE.Color(), alpha: 1, cell: 0, drag: 0, gravity: 0, spin: 0, stretch: 0,
  };

  constructor(
    scene: THREE.Scene,
    private particles: Particles,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.iRing = new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iAlpha = new THREE.InstancedBufferAttribute(new Float32Array(RINGS), 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iRing', this.iRing);
    this.geo.setAttribute('iAlpha', this.iAlpha);
    this.geo.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color('#c3cfd3') }, light: this.light },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.userData.ignoreRay = true;
    this.mesh.raycast = () => {};
    scene.add(this.mesh);
  }

  /** A ring spreading on the water at (x, y, z): to `size` metres across its radius over `life` seconds. */
  ring(x: number, y: number, z: number, size: number, life = 1.4, alpha = 0.42): void {
    if (this.rings.length >= RINGS) this.rings.shift();
    this.rings.push({ x, y: y + 0.012, z, t: 0, life, r0: size * 0.12, r1: size, alpha });
  }

  /** `n` drops thrown up from (x, y, z): `up` m/s upwards, `out` m/s outwards, plus (vx, vz) along. */
  private drops(x: number, y: number, z: number, n: number, up: number, out: number, vx = 0, vz = 0, size = 0.05): void {
    const count = Math.max(1, Math.round(n * this.particles.budget));
    for (let i = 0; i < count; i++) {
      const s = this.s;
      const a = Math.random() * Math.PI * 2;
      const o = out * (0.3 + Math.random() * 0.9);
      Object.assign(s, {
        x: x + Math.cos(a) * 0.08, y: y + 0.03, z: z + Math.sin(a) * 0.08,
        vx: Math.cos(a) * o + vx * (0.4 + Math.random() * 0.5), vy: up * (0.45 + Math.random() * 0.75), vz: Math.sin(a) * o + vz * (0.4 + Math.random() * 0.5),
        life: 0.45 + Math.random() * 0.45, size0: size * (0.6 + Math.random() * 0.8), size1: size * 0.5, alpha: 0.85,
        cell: PARTICLE.glow, drag: 0.6, gravity: 9.8, spin: 0, stretch: 0.05,
      });
      s.c0.copy(DROP);
      s.c1.copy(DROP);
      this.particles.spawn(s);
    }
  }

  /** A soft white mist over a big splash. */
  private mist(x: number, y: number, z: number, n: number, size: number): void {
    for (let i = 0; i < Math.max(1, Math.round(n * this.particles.budget)); i++) {
      const s = this.s;
      Object.assign(s, {
        x: x + (Math.random() - 0.5) * 0.5, y: y + 0.2 + Math.random() * 0.3, z: z + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 0.8, vy: 0.6 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.8,
        life: 0.6 + Math.random() * 0.4, size0: size * 0.4, size1: size, alpha: 0.28, cell: PARTICLE.puff, drag: 2.5, gravity: 0.6, spin: (Math.random() - 0.5) * 2, stretch: 0,
      });
      s.c0.copy(MIST);
      s.c1.copy(MIST);
      this.particles.spawn(s);
    }
  }

  /**
   * A step in the water at `speed` m/s, `wet` as world/water.ts has it there, going (vx, vz): drops thrown ahead
   * and a ring; more when running, fewer the deeper you wade; afloat a stroke's ring and a few drops.
   */
  step(x: number, z: number, wet: Wet, speed: number, vx = 0, vz = 0): void {
    const y = wet.level;
    if (wet.swimming) {
      this.ring(x, y, z, 0.9, 1.6, 0.32);
      this.drops(x, y, z, 3, 0.8, 0.3, vx, vz, 0.035);
      return;
    }
    const run = Math.min(1, Math.max(0, (speed - 1) / 2.5));
    const shallow = 1 - Math.min(0.7, wet.depth); // knee deep throws less up: the leg pushes through
    this.drops(x, y, z, 4 + 12 * run * shallow, 1 + 2.4 * run, 0.4 + 0.5 * run, vx, vz);
    this.ring(x, y, z, 0.5 + 0.4 * run + 0.4 * Math.min(1, wet.depth), 1.1);
  }

  /** Landing in the water at `speed` m/s (a jump or fall in): a burst, a mist and rings. */
  plunge(x: number, z: number, y: number, speed: number): void {
    const k = Math.min(1, speed / 8);
    this.drops(x, y, z, 20 + 40 * k, 2.5 + 3.5 * k, 1 + 1.4 * k, 0, 0, 0.07);
    this.mist(x, y, z, 3 + 5 * k, 0.7 + 0.8 * k);
    this.ring(x, y, z, 1.3 + 1.2 * k, 1.8, 0.5);
    this.ring(x, y, z, 0.8 + 0.6 * k, 1.4, 0.4);
    if (k > 0.5) this.ring(x, y, z, 2.6 + k, 2.4, 0.3);
  }

  /** A shot into the water at `point`: a little spout and a ring (world/effects.ts). */
  shot(point: THREE.Vector3): void {
    this.drops(point.x, point.y, point.z, 10, 3.2, 0.35, 0, 0, 0.04);
    this.mist(point.x, point.y, point.z, 1, 0.3);
    this.ring(point.x, point.y, point.z, 0.45, 1.1, 0.6);
  }

  /** Each frame: afloat, rings spread round you as you swim or tread water. */
  swim(x: number, z: number, wet: Wet | null, dt: number): void {
    if (!wet?.swimming) {
      this.tread = 0;
      return;
    }
    this.tread -= dt;
    if (this.tread > 0) return;
    this.tread = 1.3 + Math.random() * 0.4;
    this.ring(x, wet.level, z, 1.1, 2.2, 0.28);
  }

  /**
   * Each frame for each car near the eye (`key` tells them apart): through a ford or a ditch, spray from the
   * wheels and a wake, by how fast it goes. The car's middle at (x, z) on the ground `y`, turned `yaw`.
   */
  wheels(key: string, x: number, z: number, y: number, yaw: number, halfL: number, halfW: number, dt: number): void {
    const last = this.cars.get(key);
    this.cars.set(key, { x, z });
    if (!last || dt <= 0) return;
    const speed = Math.hypot(x - last.x, z - last.z) / dt;
    if (speed < 1 || speed > 60) return;
    const level = waterLevel(x, z);
    if (level === null || y > level - 0.02) return;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const k = Math.min(1, speed / 12);
    // From each front wheel, thrown out to its side and up; a wake ring now and then.
    for (const side of [-1, 1]) {
      const wx = x + fx * halfL * 0.7 + fz * side * -halfW;
      const wz = z + fz * halfL * 0.7 - fx * side * -halfW;
      if (Math.random() < 0.5 + k) this.drops(wx, level, wz, 2 + 6 * k, 1.5 + 3 * k, 0.5, -fz * side * (1 + 3 * k), fx * side * (1 + 3 * k), 0.07);
      if (k > 0.4 && Math.random() < dt * 8 * k) this.mist(wx, level, wz, 1, 0.6 + 0.6 * k);
    }
    if (Math.random() < dt * 6) this.ring(x, level, z, halfW * 2 + 1.5 * k, 1.6, 0.4);
  }

  update(dt: number): void {
    this.light.value = daylight();
    const r = this.iRing.array as Float32Array;
    const a = this.iAlpha.array as Float32Array;
    let n = 0;
    for (let i = this.rings.length - 1; i >= 0; i--) if ((this.rings[i].t += dt) >= this.rings[i].life) this.rings.splice(i, 1);
    for (const g of this.rings) {
      const t = g.t / g.life;
      const grow = 1 - (1 - t) * (1 - t); // fast at first, slowing as it spreads
      r.set([g.x, g.y, g.z, g.r0 + (g.r1 - g.r0) * grow], n * 4);
      a[n] = g.alpha * (1 - t) * Math.min(1, t * 10);
      n++;
    }
    for (const attr of [this.iRing, this.iAlpha]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
  }
}
