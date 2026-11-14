import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import GNOMES from '../../shared/gnomes.json';
import { sound } from '../sound';
import type { Particles, Spawn } from './particles';
import { PARTICLE } from './sprites';

/**
 * Garden gnomes to find across the map (shared/gnomes.json; world/goals.ts keeps which are found): 45 cm, a red hat, a
 * blue coat and a white beard, made in code as one shape and drawn as one instanced mesh. Come within reach and the
 * gnome is found: a chime and a pop of sparkles. A found gnome stays, paler. At the last one fireworks go up, and a
 * golden gnome stands on the church square from then on.
 */

export interface GnomeSpot {
  id: string;
  x: number;
  z: number;
  /** A floor above the ground (its height), else on the ground */
  y?: number;
  /** In the village (drawn once it is in), else in the ring loaded at the start */
  village: boolean;
}

export const SPOTS: readonly GnomeSpot[] = GNOMES.gnomes as GnomeSpot[];
export const GNOME_IDS: readonly string[] = SPOTS.map((g) => g.id);
const REACH = GNOMES.reach;
/** A found gnome: this much of its own colour, the rest a pale stone */
const FOUND_TINT = 0.35;

/** A part of the gnome turned round its upright axis (x: radius, y: height), in one colour. */
function lathe(profile: [number, number][], color: string, segments = 10): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  return painted(g, color);
}

function painted(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** The gnome, 0.45 m tall, its feet at 0 and its face towards +z (about 330 triangles). */
function gnomeGeometry(): THREE.BufferGeometry {
  const boots = lathe([[0, 0], [0.072, 0], [0.078, 0.02], [0.07, 0.05], [0, 0.05]], '#4a2f1d');
  const coat = lathe([[0, 0.05], [0.085, 0.05], [0.1, 0.11], [0.094, 0.17], [0.07, 0.225], [0, 0.24]], '#2f5bb0');
  const head = lathe([[0, 0.225], [0.035, 0.228], [0.055, 0.25], [0.058, 0.275], [0.05, 0.3], [0, 0.31]], '#f0c4a0');
  const hat = painted(new THREE.ConeGeometry(0.068, 0.16, 10, 1, false).translate(0, 0.37, 0), '#c62f2a');
  hat.rotateX(-0.12); // its tip a little back
  const beard = painted(new THREE.ConeGeometry(0.052, 0.13, 8, 1, false), '#f4f2ec');
  beard.rotateX(Math.PI).scale(1, 1, 0.55).translate(0, 0.205, 0.042);
  const nose = painted(new THREE.SphereGeometry(0.017, 6, 4).translate(0, 0.272, 0.056), '#e39a7e');
  const parts = [boots, coat, head, hat, beard, nose];
  for (const p of parts) p.deleteAttribute('uv');
  const g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

/** A fixed turn for a gnome, from its id: they don't all look the same way. */
function yawOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

interface Burst {
  at: number;
  x: number;
  y: number;
  z: number;
}

export class Gnomes {
  readonly group = new THREE.Group();
  /** Each spot's height as worked out last (settle) */
  readonly heights: number[];
  private found = new Set<string>();
  private villageIn = false;
  /** All found: the golden gnome stands (once the village is in) */
  private gold = false;
  /** The warm-up frames behind the start screen: the golden gnome drawn too */
  private warm = false;
  private mesh: THREE.InstancedMesh;
  private golden: THREE.Mesh;
  /** Instance i of the mesh draws spot shown[i] */
  private shown: number[] = [];
  private clock = 0;
  private bursts: Burst[] = [];
  private spawn: Spawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
    c0: new THREE.Color(), c1: new THREE.Color(), alpha: 1, cell: PARTICLE.glow, drag: 0, gravity: 0, spin: 0, stretch: 0,
  };

  constructor(
    private ground: (x: number, z: number) => number,
    private floor: (x: number, z: number, y: number) => number,
    private particles: Particles,
    private low: () => boolean,
  ) {
    const geometry = gnomeGeometry();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    // The instance's colour is not a tint here: its red is how much of the gnome's own colours shows, the rest a pale
    // stone (a found gnome). One line in the vertex shader; the same program for every gnome.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <color_vertex>',
        [
          'vColor = vec4(1.0);',
          '#ifdef USE_COLOR',
          '  vColor.rgb *= color;',
          '#endif',
          '#ifdef USE_INSTANCING_COLOR',
          '  vColor.rgb = mix(vec3(0.84, 0.83, 0.8), vColor.rgb, instanceColor.r);',
          '#endif',
        ].join('\n'),
      );
    };
    material.customProgramCacheKey = () => 'gnome-pale';
    this.mesh = new THREE.InstancedMesh(geometry, material, SPOTS.length);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < SPOTS.length; i++) this.mesh.setColorAt(i, white); // from the start, so the shader is built with it
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.userData.ignoreRay = true;
    this.mesh.raycast = () => {};
    this.golden = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#e0b030', metalness: 0.9, roughness: 0.3 }));
    this.golden.scale.setScalar(1.6);
    this.golden.visible = false;
    this.golden.userData.ignoreRay = true;
    this.golden.raycast = () => {};
    this.group.add(this.mesh, this.golden);
    this.heights = SPOTS.map(() => 0);
    this.settle();
  }

  /** Where each gnome stands, worked out again (the village's roofs and paving have come in). */
  settle(): void {
    SPOTS.forEach((s, i) => (this.heights[i] = s.y !== undefined ? this.floor(s.x, s.z, s.y) : this.ground(s.x, s.z)));
    const g = GNOMES.golden;
    this.golden.position.set(g.x, this.ground(g.x, g.z), g.z);
    this.golden.rotation.y = yawOf('golden');
    this.rebuild();
  }

  villageReady(): void {
    this.villageIn = true;
    this.settle();
  }

  isShown(i: number): boolean {
    return this.villageIn || !SPOTS[i].village;
  }

  setFound(ids: Iterable<string>): void {
    this.found = new Set(ids);
    this.rebuild();
  }

  /** The golden gnome on the church square: once all are found. */
  setGolden(on: boolean): void {
    this.gold = on;
    this.golden.visible = this.warm || (on && this.villageIn);
  }

  /** The warm-up frames (world/goals.ts warming): the golden gnome drawn once before play, where it stands. */
  warming(on: boolean): void {
    this.warm = on;
    this.setGolden(this.gold);
  }

  private rebuild(): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const c = new THREE.Color();
    this.shown = [];
    SPOTS.forEach((s, i) => {
      if (!this.isShown(i)) return;
      const k = this.shown.length;
      this.shown.push(i);
      q.setFromAxisAngle(up, yawOf(s.id));
      this.mesh.setMatrixAt(k, m.compose(new THREE.Vector3(s.x, this.heights[i], s.z), q, one));
      const v = this.found.has(s.id) ? FOUND_TINT : 1;
      this.mesh.setColorAt(k, c.setRGB(v, v, v));
    });
    this.mesh.count = this.shown.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.golden.visible = this.warm || (this.gold && this.villageIn);
  }

  /** The first shown gnome not yet found within reach of your feet, or -1. */
  near(x: number, z: number, feet: number): number {
    for (const i of this.shown) {
      const s = SPOTS[i];
      if (this.found.has(s.id)) continue;
      if (Math.hypot(x - s.x, z - s.z) < REACH && Math.abs(feet - this.heights[i]) < 1.5) return i;
    }
    return -1;
  }

  /** Found: drawn pale from now on. */
  mark(i: number): void {
    this.found.add(SPOTS[i].id);
    this.rebuild();
  }

  /** A pop of sparkles and a chime at gnome i. */
  pop(i: number): void {
    const s = SPOTS[i];
    const y = this.heights[i] + 0.3;
    const p = this.spawn;
    const n = this.low() ? 8 : 14;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 0.8 + Math.random() * 0.9;
      Object.assign(p, {
        x: s.x, y, z: s.z, vx: Math.cos(a) * sp, vy: 1.2 + Math.random() * 1.4, vz: Math.sin(a) * sp,
        life: 0.5, size0: 0.09, size1: 0.03, alpha: 1, cell: PARTICLE.glow, drag: 1.5, gravity: 2, spin: 0, stretch: 0,
      });
      p.c0.setRGB(2.4, 1.8, 0.6);
      p.c1.setRGB(1.6, 1.6, 1.6);
      this.particles.spawn(p, true);
    }
    this.chime(s.x, y, s.z);
  }

  /** A little chime, made in code: four bright notes going up. */
  private chime(x: number, y: number, z: number): void {
    const ctx = sound.context();
    const dest = sound.at(x, y, z, 4);
    if (!ctx || !dest) return;
    const t0 = ctx.currentTime;
    [784, 1046.5, 1318.5, 2093].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      const t = t0 + i * 0.07;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.55);
    });
  }

  /** Fireworks above (x, y, z): six bursts over six seconds, 25 to 35 m up. */
  fireworks(x: number, y: number, z: number): void {
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * Math.PI * 2, d = 6 + Math.random() * 14;
      this.bursts.push({ at: this.clock + k + Math.random() * 0.4, x: x + Math.cos(a) * d, y: y + 25 + Math.random() * 10, z: z + Math.sin(a) * d });
    }
  }

  private burst(b: Burst): void {
    const hue = Math.random();
    const c = new THREE.Color().setHSL(hue, 0.9, 0.6);
    const p = this.spawn;
    const n = this.low() ? 20 : 40;
    for (let k = 0; k < n; k++) {
      // Evenly round a sphere (a spiral of points), each a little faster or slower.
      const v = 1 - (2 * (k + 0.5)) / n, r = Math.sqrt(1 - v * v), a = k * 2.39996;
      const sp = 9 + Math.random() * 3;
      Object.assign(p, {
        x: b.x, y: b.y, z: b.z, vx: Math.cos(a) * r * sp, vy: v * sp, vz: Math.sin(a) * r * sp,
        life: 1.6 + Math.random() * 0.6, size0: 0.7, size1: 0.25, alpha: 1, cell: PARTICLE.glow, drag: 1.4, gravity: 2.5, spin: 0, stretch: 0.03,
      });
      p.c0.setRGB(c.r * 3, c.g * 3, c.b * 3);
      p.c1.setRGB(c.r * 1.2, c.g * 1.2, c.b * 1.2);
      this.particles.spawn(p, true);
    }
    this.thump(b.x, b.y, b.z);
  }

  /** A soft thump made in code: a short burst of low noise. */
  private thump(x: number, y: number, z: number): void {
    const ctx = sound.context();
    const dest = sound.at(x, y, z, 30);
    if (!ctx || !dest) return;
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-i / len) * 6);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    src.connect(lp).connect(g).connect(dest);
    src.start();
  }

  update(dt: number): void {
    this.clock += dt;
    if (!this.bursts.length) return;
    const due = this.bursts.filter((b) => b.at <= this.clock);
    if (!due.length) return;
    this.bursts = this.bursts.filter((b) => b.at > this.clock);
    for (const b of due) this.burst(b);
  }
}
