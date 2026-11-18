import * as THREE from 'three';
import { buildMarket, type Market } from './christmasMarket';
import { CHALETS, chaletRing, TABLES, tableRing } from './christmasMarketPlan';
import type { World } from './collision';
import { buildFir, FIR_H, firRadius, paintFir, seeded } from './firTree';
import { mood } from './mood';

/**
 * Christmas in Smetlede (Yoshi), from the first Sunday of Advent until Epiphany (world/season.ts): strings of warm
 * white lights along the eaves of the houses round the church square and up the café's crow-stepped gable, on about
 * one house in four in the rest of the village (some in colours), a Christmas tree on the square, and a small Christmas
 * market beside it. Where the strings hang comes from web/src/data/christmas.json (tools/christmas_lights.mjs); the
 * same houses every year, picked by where they are, never by who lives there.
 *
 * No real lights, as the street lamps (world/streetLights.ts): every bulb, the tree's and the star's glow too, is a
 * small square turned to the eye and added onto the picture, all in one draw call with no texture. A far bulb is kept
 * at least a few pixels wide, its light spread over them, so a street of them stays a row of dots instead of
 * flickering away. They glow at night, at dusk and on dull or wet days (world/mood.ts), and barely by day.
 * Every value stays far under the half floats' end (65504; an iPhone stores more as infinity).
 *
 * The tree is a Nordmann fir of some 8 m, as a Flemish village puts on its square (world/firTree.ts: needle cards on
 * whorls of branches, a box of boards round its foot, baubles of glass and matt ones, a gold star), with a string of
 * warm white bulbs wound round it and more on its branch tips. It stands in the open middle of the square, clear of
 * the parking bays, the bike rack, the portal and the street. It is solid for walking and driving in Explore; in a
 * game with weapons only for walking (the server, which decides the hits, doesn't know it is there, so shots pass
 * through as through branches), and in Zombies not at all (the zombies' paths don't know it).
 *
 * The market (world/christmasMarket.ts, its spots world/christmasMarketPlan.ts): four chalets and three standing
 * tables between the long house's gable and the tree, only in Explore (main.ts `setMarket`): in every game, with
 * weapons, Steal the flag or Zombies, it is gone, its blocks too. Its bulbs are a second draw of the same glows.
 * Local and for show: nothing goes over the network.
 */

/** Where the tree stands: the open middle of the church square. */
export const TREE_AT = { x: 529, z: -765.5 };
const TREE_H = FIR_H; // m to the top of the crown, the star above it
const SOLID_R = 1.5; // m round the trunk that you can't walk into (the box and the low branches)
const KEY = 'christmas-tree';
/** The way the tree's star faces (radians from +x towards +z): the square and the street. */
const STAR_FACE = -0.35;
const MARKET_KEY = 'christmas-market';

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
const FLAME = new THREE.Color(1.0, 0.5, 0.18); // a candle in a lantern
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

/** The glows of a list of bulbs: one instanced draw of squares turned to the eye. */
function bulbMesh(out: Bulb[], material: THREE.ShaderMaterial): THREE.InstancedMesh {
  const n = out.length;
  const quad = new THREE.PlaneGeometry(1, 1);
  const tint = new Float32Array(n * 3);
  const twinkle = new Float32Array(n);
  const scale = new Float32Array(n);
  const mesh = new THREE.InstancedMesh(quad, material, n);
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
  return mesh;
}

export class Christmas {
  readonly group = new THREE.Group();
  private uniforms = { size: { value: 0.16 }, pixel: { value: 0.001 }, time: { value: 0 }, strength: { value: 0 } };
  private bulbs: THREE.InstancedMesh | null = null;
  private tree = new THREE.Group();
  private starMat: THREE.MeshStandardMaterial | null = null;
  private market: Market | null = null;
  private marketWanted = true;
  private marketSolid = false;
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

  /** The village is in (main.ts): the lights, the tree and the market are built the first time the season wants them. */
  villageReady(): void {
    this.villageIn = true;
  }

  private async build(): Promise<void> {
    this.built = true;
    const data = (await import('../data/christmas.json')).default as unknown as LightData;
    await paintFir(); // the fir's needles painted over two frames, before the tree and the market take them
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
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: bulbVertex,
      fragmentShader: bulbFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.bulbs = bulbMesh(out, material);
    this.group.add(this.bulbs, this.tree);
    // The market: its chalets and tables, and its bulbs and the tables' lanterns in a second draw of the same glows.
    this.market = buildMarket(this.groundAt);
    const lights: Bulb[] = this.market.bulbs.map((p) => ({ x: p.x, y: p.y, z: p.z, c: WARM, tw: 0, scale: 0.7 }));
    for (const p of this.market.lanterns) lights.push({ x: p.x, y: p.y, z: p.z, c: FLAME, tw: 0, scale: 1.3 });
    this.market.group.add(bulbMesh(lights, material));
    this.group.add(this.market.group);
    void this.precompile(this.group);
  }

  /** The tree on the square, and its bulbs and the star's glow added to the list. */
  private buildTree(out: Bulb[]): void {
    const { x, z } = TREE_AT;
    this.ground = this.groundAt(x, z);
    const fir = buildFir(1225, STAR_FACE);
    this.starMat = fir.starMaterial;
    this.tree.position.set(x, this.ground, z);
    this.tree.add(fir.group);
    const rand = seeded(2512);
    // A long string wound round the crown from the top down, its bulbs among the outer needles; a few twinkle.
    const turns = 8.5;
    const n = 430;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const y = TREE_H - 0.55 - u * (TREE_H - 1.45);
      const r = firRadius(y) * (0.93 + rand() * 0.06);
      const a = u * turns * Math.PI * 2 + (rand() - 0.5) * 0.08;
      out.push({ x: x + Math.cos(a) * r, y: this.ground + y + (rand() - 0.5) * 0.08, z: z + Math.sin(a) * r, c: WARM, tw: rand() < 0.12 ? 0.2 + rand() * 0.8 : 0, scale: 0.62 });
    }
    // And bulbs on about half of the branch tips, a little in under their needles.
    for (const p of fir.spots.tips) {
      if (p.y < 1.0 || rand() < 0.5) continue;
      out.push({ x: x + p.x * 0.95, y: this.ground + p.y + 0.02, z: z + p.z * 0.95, c: WARM, tw: 0, scale: 0.62 });
    }
    out.push({ x, y: this.ground + fir.starAt.y, z, c: GOLD, tw: 0, scale: 6 }); // the star's glow
  }

  /** Whether the market may stand: in Explore only (main.ts). */
  setMarket(on: boolean): void {
    this.marketWanted = on;
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
    // The market, in Explore only: shown, and its chalets and tables solid for walking and driving.
    const market = on && this.marketWanted && !!this.market;
    if (this.market) this.market.group.visible = market;
    if (market !== this.marketSolid) {
      this.marketSolid = market;
      const keys = [...CHALETS.map((_, i) => `${MARKET_KEY}-${i}`), ...TABLES.map((_, i) => `${MARKET_KEY}-t${i}`)];
      const rings = [...CHALETS.map(chaletRing), ...TABLES.map(tableRing)];
      keys.forEach((key, i) => {
        const ring = market ? rings[i] : null;
        const ground = ring ? Math.min(...ring.map(([rx, rz]) => this.groundAt(rx, rz))) : 0;
        this.world.setMoving(key, ring, ground - 0.3, ground + 3.2);
      });
    }
    if (!on) return;
    // Lit at night, at dusk and on dull or wet days; barely by day.
    const dim = Math.min(1, Math.max(mood.night, mood.overcast * 0.6, mood.wet * 0.55));
    this.uniforms.strength.value = 0.1 + 0.9 * dim;
    this.uniforms.time.value += dt;
    this.uniforms.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, pixelsHigh);
    if (this.starMat) this.starMat.emissiveIntensity = 0.1 + 1.6 * dim;
    this.market?.setGlow(Math.min(1, Math.max(mood.night, mood.overcast * 0.35, mood.wet * 0.3)));
  }

  /** Lit now (for the checks). */
  get lit(): boolean {
    return this.on;
  }
}
