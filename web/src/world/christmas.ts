import * as THREE from 'three';
import type { World } from './collision';
import { mood } from './mood';

/**
 * Christmas in Smetlede (Yoshi), from the first Sunday of Advent until Epiphany (world/season.ts): strings of warm
 * white lights along the eaves of the houses round the church square and up the café's crow-stepped gable, on about
 * one house in four in the rest of the village (some in colours), and a Christmas tree on the square with baubles,
 * twinkling lights and a lit star on top. Where the strings hang comes from web/src/data/christmas.json
 * (tools/christmas_lights.mjs); the same houses every year, picked by where they are, never by who lives there.
 *
 * No real lights, as the street lamps (world/streetLights.ts): every bulb, the tree's and the star's glow too, is a
 * small square turned to the eye and added onto the picture, all in one draw call with no texture. A far bulb is kept
 * at least a few pixels wide, its light spread over them, so a street of them stays a row of dots instead of
 * flickering away. They glow at night, at dusk and on dull or wet days (world/mood.ts), and barely by day.
 * Every value stays far under the half floats' end (65504; an iPhone stores more as infinity).
 *
 * The tree is built here in code: a spruce of drooping tiers with branch tips round their edges, coloured per vertex
 * (one draw), its baubles one instanced draw, a wooden crate round its foot and a gold star. It stands in the open
 * middle of the square, clear of the parking bays, the bike rack, the portal and the street. It is solid for walking
 * and driving in Explore; in a game with weapons only for walking (the server, which decides the hits, doesn't know
 * it is there, so shots pass through as through branches), and in Zombies not at all (the zombies' paths don't know it).
 * Local and for show: nothing goes over the network.
 */

/** Where the tree stands: the open middle of the church square. */
export const TREE_AT = { x: 529, z: -765.5 };
const TREE_H = 8.2; // m to the top of the crown, the star above it
const SOLID_R = 1.5; // m round the trunk that you can't walk into (the crate and the low branches)
const KEY = 'christmas-tree';

/** The strings of lights (tools/christmas_lights.mjs). */
interface LightData {
  /** [floor x, floor z, x0, h0, z0, x1, h1, z1]: h above the town house's floor */
  town: number[][];
  /** [x0, y0, z0, x1, y1, z1] in the game's heights */
  roofs: number[][];
}

const WARM = new THREE.Color(1.0, 0.68, 0.36); // warm white bulbs (linear)
const COLOURS = [new THREE.Color(1.0, 0.12, 0.08), new THREE.Color(0.15, 0.85, 0.2), new THREE.Color(0.2, 0.35, 1.0), new THREE.Color(1.0, 0.6, 0.08)];
const GOLD = new THREE.Color(1.0, 0.62, 0.2);
const SPACING = 0.3; // m between bulbs
const HOOK = 1.2; // m between the hooks the string hangs from
const SAG = 0.06; // m it sags between two hooks

const bulbVertex = /* glsl */ `
  attribute vec3 tint;
  attribute float twinkle;
  attribute float scale;
  uniform float size;
  uniform float pixel;
  uniform float time;
  uniform float strength;
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv - 0.5;
    vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float d = max(0.1, -centre.z);
    float s = size * scale;
    float wide = max(s, pixel * d * 3.0); // at least three pixels across
    float k = s / wide; // its light spread over the wider square (not all of it: a far string should still read)
    float tw = twinkle > 0.0 ? 0.6 + 0.4 * sin(time * (1.1 + twinkle * 2.3) + twinkle * 41.0) : 1.0;
    vColor = tint * strength * k * tw * (1.0 - smoothstep(240.0, 330.0, d));
    centre.xy += position.xy * wide; // turned to the eye
    gl_Position = projectionMatrix * centre;
  }`;
const bulbFragment = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    float r = length(vUv) * 2.0;
    float glow = (exp(-r * r * 12.0) * 3.0 + exp(-r * r * 3.0) * 0.3) * (1.0 - smoothstep(0.65, 1.0, r));
    gl_FragColor = vec4(vColor * glow, 1.0);
  }`;

/** A small random number generator with a seed, so the tree is the same for everyone. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

interface Bulb {
  x: number;
  y: number;
  z: number;
  c: THREE.Color;
  tw: number;
  scale: number;
}

/** Bulbs along a string from a to b, sagging a little between its hooks. */
function string(a: THREE.Vector3, b: THREE.Vector3, colour: (i: number) => THREE.Color, out: Bulb[]): void {
  const length = a.distanceTo(b);
  const n = Math.max(1, Math.round(length / SPACING));
  const hooks = Math.max(1, Math.round(length / HOOK));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const u = (f * hooks) % 1;
    out.push({
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f - SAG * 4 * u * (1 - u),
      z: a.z + (b.z - a.z) * f,
      c: colour(i),
      tw: 0,
      scale: 1,
    });
  }
}

/** The spruce's outline: the radius of its crown at a height above the ground (the tiers' tips). */
function crownRadius(y: number): number {
  const f = (y - 0.75) / (TREE_H - 0.75);
  return f < 0 || f > 1 ? 0 : 2.15 * Math.pow(1 - f, 0.95) + 0.1;
}

/** The tree's crown: drooping tiers, each a ring of branch tips round a cone, coloured per vertex (flat shaded). */
function crown(rand: () => number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const dark = new THREE.Color('#183d24');
  const light = new THREE.Color('#3f7a3c');
  const tri = (p: number[][], c: THREE.Color[]) => {
    for (let i = 0; i < 3; i++) {
      pos.push(...p[i]);
      col.push(c[i].r, c[i].g, c[i].b);
    }
  };
  const tiers = 10;
  for (let k = 0; k < tiers; k++) {
    const y0 = 0.75 + (k / tiers) * (TREE_H - 1.6); // the tier's lower edge
    const top = Math.min(TREE_H, y0 + 1.75 - k * 0.04);
    const R = crownRadius(y0) * 1.04;
    const tips = Math.max(7, Math.round(16 - k * 0.9));
    const turn = rand() * Math.PI * 2;
    const apex = [0, top, 0];
    const ring: number[][] = [];
    const inner: number[][] = [];
    for (let i = 0; i < tips * 2; i++) {
      const a = turn + (i / (tips * 2)) * Math.PI * 2;
      const tip = i % 2 === 0;
      const r = R * (tip ? 1 + (rand() - 0.5) * 0.12 : 0.74);
      const droop = tip ? -0.12 - rand() * 0.08 : 0.06;
      ring.push([Math.sin(a) * r, y0 + droop, Math.cos(a) * r]);
      inner.push([Math.sin(a) * r * 0.35, y0 + 0.35, Math.cos(a) * r * 0.35]);
    }
    const shade = (y: number, out: number) => dark.clone().lerp(light, Math.min(1, 0.25 + out * 0.6 + (y - y0) * 0.05 + (rand() - 0.5) * 0.15));
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      // The slope down from the top to the tips, the tips lighter.
      tri([apex, q, p], [shade(top, 0), shade(q[1], i % 2 ? 1 : 0.4), shade(p[1], i % 2 ? 0.4 : 1)]);
      // The underside back in to the trunk, darker.
      const pi = inner[i], qi = inner[(i + 1) % inner.length];
      tri([p, q, qi], [dark, dark, dark]);
      tri([p, qi, pi], [dark, dark, dark]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** A five-pointed star, standing up, a little thick. */
function star(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 ? 0.2 : 0.48;
    if (i === 0) shape.moveTo(Math.sin(a) * r, Math.cos(a) * r);
    else shape.lineTo(Math.sin(a) * r, Math.cos(a) * r);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 1 });
  g.translate(0, 0, -0.04);
  return g;
}

export class Christmas {
  readonly group = new THREE.Group();
  private uniforms = { size: { value: 0.16 }, pixel: { value: 0.001 }, time: { value: 0 }, strength: { value: 0 } };
  private bulbs: THREE.InstancedMesh | null = null;
  private tree = new THREE.Group();
  private starMesh: THREE.Mesh | null = null;
  private starMat: THREE.MeshStandardMaterial | null = null;
  private built = false;
  private villageIn = false;
  private on = false;
  private solid: 'full' | 'walk' | 'off' | null = null;
  private wanted: 'full' | 'walk' | 'off' = 'full';
  private ground = 0;

  constructor(private world: World, private groundAt: (x: number, z: number) => number, private precompile: (root: THREE.Object3D) => unknown = () => {}) {
    this.group.name = 'christmas';
    this.group.visible = false;
  }

  /** The village is in (main.ts): the lights and the tree are built the first time the season wants them. */
  villageReady(): void {
    this.villageIn = true;
  }

  private async build(): Promise<void> {
    this.built = true;
    const data = (await import('../data/christmas.json')).default as unknown as LightData;
    const out: Bulb[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const floors = new Map<string, number>();
    for (const [fx, fz, x0, h0, z0, x1, h1, z1] of data.town) {
      const key = `${fx},${fz}`;
      if (!floors.has(key)) floors.set(key, this.groundAt(fx, fz) + 0.05); // as tools/town/town.py lifts its floors
      const floor = floors.get(key)!;
      string(a.set(x0, floor + h0, z0), b.set(x1, floor + h1, z1), () => WARM, out);
    }
    data.roofs.forEach(([x0, y0, z0, x1, y1, z1], i) => {
      // One house in five of these in colours, the rest warm white.
      const coloured = (i * 7 + 3) % 5 === 0;
      string(a.set(x0, y0, z0), b.set(x1, y1, z1), coloured ? (k) => COLOURS[k % COLOURS.length] : () => WARM, out);
    });
    this.buildTree(out);
    const n = out.length;
    const quad = new THREE.PlaneGeometry(1, 1);
    const tint = new Float32Array(n * 3);
    const twinkle = new Float32Array(n);
    const scale = new Float32Array(n);
    const mesh = new THREE.InstancedMesh(quad, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: bulbVertex,
      fragmentShader: bulbFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }), n);
    const m = new THREE.Matrix4();
    out.forEach((p, i) => {
      mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      tint.set([p.c.r, p.c.g, p.c.b], i * 3);
      twinkle[i] = p.tw;
      scale[i] = p.scale;
    });
    quad.setAttribute('tint', new THREE.InstancedBufferAttribute(tint, 3));
    quad.setAttribute('twinkle', new THREE.InstancedBufferAttribute(twinkle, 1));
    quad.setAttribute('scale', new THREE.InstancedBufferAttribute(scale, 1));
    mesh.frustumCulled = false; // spread over the village: one bounding sphere would always be in view anyway
    mesh.raycast = () => {};
    mesh.userData.noAO = true;
    mesh.userData.ignoreRay = true;
    mesh.renderOrder = 60;
    this.bulbs = mesh;
    this.group.add(mesh, this.tree);
    void this.precompile(this.group);
  }

  /** The tree on the square, its baubles, and its bulbs and the star's glow added to the list. */
  private buildTree(out: Bulb[]): void {
    const { x, z } = TREE_AT;
    this.ground = this.groundAt(x, z);
    const rand = seeded(1225);
    this.tree.position.set(x, this.ground, z);
    const leaves = new THREE.Mesh(crown(rand), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }));
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 1.6, 10).translate(0, 0.8, 0), new THREE.MeshStandardMaterial({ color: '#5a3b24', roughness: 0.9 }));
    // A crate of boards round its foot, as the village's tree stands in; a red band round it.
    const crate = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.0, 0.6, 8).translate(0, 0.3, 0), new THREE.MeshStandardMaterial({ color: '#8a5d36', roughness: 0.85 }));
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.985, 0.995, 0.12, 8).translate(0, 0.42, 0), new THREE.MeshStandardMaterial({ color: '#a8171c', roughness: 0.6 }));
    // Baubles near the branch tips: red, gold, silver and a few blue.
    const ball = new THREE.IcosahedronGeometry(0.12, 1);
    const balls = new THREE.InstancedMesh(ball, new THREE.MeshStandardMaterial({ roughness: 0.22, metalness: 0.55 }), 80);
    const tones = ['#c3121b', '#d6a21e', '#c9ccd2', '#c3121b', '#d6a21e', '#2a4fc0'].map((c) => new THREE.Color(c));
    const m = new THREE.Matrix4();
    for (let i = 0; i < balls.count; i++) {
      const y = 1.0 + Math.pow(rand(), 0.8) * (TREE_H - 2.0);
      const r = crownRadius(y) * 0.92;
      const a = rand() * Math.PI * 2;
      const s = 0.8 + rand() * 0.5;
      balls.setMatrixAt(i, m.makeScale(s, s, s).setPosition(Math.sin(a) * r, y - 0.12, Math.cos(a) * r));
      balls.setColorAt(i, tones[i % tones.length]);
    }
    // The star on top, gold, glowing at night.
    this.starMat = new THREE.MeshStandardMaterial({ color: '#f2c14e', metalness: 0.5, roughness: 0.3, emissive: new THREE.Color('#ffb02e'), emissiveIntensity: 0.2 });
    this.starMesh = new THREE.Mesh(star(), this.starMat);
    this.starMesh.position.y = TREE_H + 0.3;
    for (const o of [leaves, trunk, crate, band, balls, this.starMesh]) {
      o.userData.ignoreRay = true;
      o.castShadow = o !== this.starMesh;
      o.receiveShadow = true;
      this.tree.add(o);
    }
    // The lights: a garland spiralling down round the crown, and more scattered over it, twinkling.
    const turns = 7.5;
    const n = 260;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const y = TREE_H - 0.5 - u * (TREE_H - 1.3);
      const r = crownRadius(y) * 1.0 + 0.04;
      const a = u * turns * Math.PI * 2;
      out.push({ x: x + Math.sin(a) * r, y: this.ground + y - 0.05, z: z + Math.cos(a) * r, c: WARM, tw: 0.2 + rand() * 0.8, scale: 0.85 });
    }
    for (let i = 0; i < 120; i++) {
      const y = 1.0 + rand() * (TREE_H - 1.6);
      const r = crownRadius(y) * (0.9 + rand() * 0.12);
      const a = rand() * Math.PI * 2;
      out.push({ x: x + Math.sin(a) * r, y: this.ground + y - 0.1, z: z + Math.cos(a) * r, c: WARM, tw: 0.2 + rand() * 0.8, scale: 0.85 });
    }
    out.push({ x, y: this.ground + TREE_H + 0.3, z, c: GOLD, tw: 0, scale: 9 }); // the star's glow
  }

  /** How solid the tree is: 'full' in Explore (walking and cars), 'walk' in a game with weapons, 'off' in Zombies. */
  setSolid(how: 'full' | 'walk' | 'off'): void {
    this.wanted = how;
  }

  /**
   * Each frame: whether it is the season (world/season.ts), the camera, and the height of the picture in pixels (for
   * how wide a far bulb is kept).
   */
  update(dt: number, season: boolean, camera: THREE.PerspectiveCamera, pixelsHigh: number): void {
    if (season && this.villageIn && !this.built) void this.build();
    const on = season && !!this.bulbs;
    this.on = on;
    this.group.visible = on;
    const solid = on ? this.wanted : 'off';
    if (solid !== this.solid) {
      this.solid = solid;
      this.world.setMoving(KEY, null);
      this.world.setMoving(KEY, null, 0, 0, true);
      if (solid !== 'off') {
        const ring: [number, number][] = [];
        for (let i = 0; i < 8; i++) ring.push([TREE_AT.x + Math.sin((i / 8) * Math.PI * 2) * SOLID_R, TREE_AT.z + Math.cos((i / 8) * Math.PI * 2) * SOLID_R]);
        this.world.setMoving(KEY, ring, this.ground - 0.3, this.ground + TREE_H, solid === 'walk');
      }
    }
    if (!on) return;
    // Lit at night, at dusk and on dull or wet days; barely by day.
    const dim = Math.min(1, Math.max(mood.night, mood.overcast * 0.6, mood.wet * 0.55));
    this.uniforms.strength.value = 0.1 + 0.9 * dim;
    this.uniforms.time.value += dt;
    this.uniforms.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, pixelsHigh);
    if (this.starMat && this.starMesh) {
      this.starMat.emissiveIntensity = 0.25 + 2.2 * dim;
      this.starMesh.rotation.y += dt * 0.35;
    }
  }

  /** Lit now (for the checks). */
  get lit(): boolean {
    return this.on;
  }
}
