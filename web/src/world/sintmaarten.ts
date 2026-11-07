import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { World } from './collision';
import { mood } from './mood';
import { Sinterklaas, type RiderSpec } from './sinterklaas';

/**
 * Sint-Maarten in Smetlede (Yoshi), from 4 November up to and with his feast on the 11th (world/season.ts). Round
 * Aalst, Lede included, he is the children's gift-bringer: he comes by in the night of 10 to 11 November, and children
 * walk with lanterns in the evenings before. Here he is a bishop on horseback, as he is shown in the region, told apart
 * from Sinterklaas at a glance: white and gold instead of red, a gold band on his mitre instead of the cross, a short
 * grey beard, and over his shoulder the red cloak he cut in two for a beggar (tools/sinterklaas.py --maarten). His
 * horse is a dapple grey with a green saddle cloth.
 *
 * He is Sinterklaas's rider (world/sinterklaas.ts) with his own spec: he rides a small loop on the west side of the
 * square (clear of Sinterklaas's loop, the Christmas tree, the portal, the parking and the bike rack; the two are
 * never there on the same day anyway), stops for a player near him, turns his head, waves and talks in a speech bubble
 * (EN and Flemish NL); Use next to him pops mandarins and sweets at your feet.
 *
 * His evenings, 4 up to and with 10 November (`sintMaartenEve`):
 * - At dusk and at night (world/mood.ts `night`) villagers carry a paper lantern on a stick: every child and about
 *   half the grown-ups (world/villagers.ts eachHand). Who carries one is fixed by the villager's number, so a lantern
 *   doesn't come and go. All lanterns are one instanced draw, unlit (a glow in the paper, no real light), every value
 *   far under 65504 (half floats; an iPhone stores more as infinity).
 * - A carrot on a little heap of hay for his horse by a few front doors round the square: one instanced draw. The
 *   doors are those of the town model (tools/town/houses.json) that face the square, a few of them picked by a hash
 *   of where they are, never by who lives there. On the 11th they are gone: the horse has had them.
 *
 * Only in Explore, as the villagers and Sinterklaas (main.ts decides): never a target, his meshes and the decor take
 * no rays, the horse is in the way for walking only. Local and for show: nothing goes over the network or is stored.
 */

export const SINT_MAARTEN: RiderSpec = {
  key: 'sintmaarten',
  model: '/models/sintmaarten.glb',
  // A dapple grey with a light mane and white socks, a green saddle cloth, dark tack with brass.
  horse: { Coat: '#a9a8a2', Dark: '#5b5955', Marking: '#e4e1da', Pad: '#1f5a3b', Leather: '#3b2417', Metal: '#c9a227' },
  loop: { x: 521, z: -764.5, r: 2.2 }, // 4 m clear of the cars' lane, 3 m of the parking bays, the long house's gable and the Christmas tree's spot
  lines: ['maarten.hello', 'maarten.lantern', 'maarten.night', 'maarten.cloak', 'maarten.share', 'maarten.song'],
  treat: 'maarten.treat',
  prompt: 'prompt.maarten',
  treats: [
    // mandarins, and wrapped sweets in bright colours
    { geometry: () => new THREE.SphereGeometry(0.032, 12, 8).scale(1, 0.85, 1), material: () => new THREE.MeshStandardMaterial({ color: '#f28c1e', roughness: 0.65 }), max: 24, lift: 0.027 },
    {
      geometry: () => new THREE.CapsuleGeometry(0.011, 0.024, 3, 8).rotateZ(Math.PI / 2),
      material: () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35 }),
      max: 30,
      lift: 0.011,
      colors: ['#d8323c', '#f2c230', '#3a8fd8', '#3fae5a', '#e86fb0'],
    },
  ],
  bubble: { border: '#b8892a', text: '#3a2a12' },
};

/**
 * Front doors of the town model that face the square (tools/town/houses.json, laid out as tools/town/town.py does):
 * the middle of the door on the wall [x, z] and the way out of it [nx, nz]. Some of them get a carrot and hay.
 */
const DOORS: [number, number, number, number][] = [
  [511.03, -769.69, 0.513, -0.859],
  [507.38, -753.64, 0.864, 0.503],
  [548.39, -773.34, -0.261, 0.965],
  [556.95, -771.2, -0.253, 0.968],
  [569.66, -767.76, -0.274, 0.962],
  [532.86, -777.55, -0.279, 0.96],
  [525.54, -779.6, -0.264, 0.965],
  [513.26, -782.99, -0.247, 0.969],
  [548.97, -737.29, -0.996, -0.094],
];
const MAX_LANTERNS = 40;
/** The paper's colours, warm and bright (the glow's strength comes from the material's colour, by the dark) */
const PAPER = ['#ffb347', '#ff7043', '#ffd54f', '#ff8a80', '#aed581', '#81d4fa'].map((c) => new THREE.Color(c));
const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

/** A number from 0 to 1 that stays the same for the same input. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Who carries the lanterns: the villagers, as world/villagers.ts lists them. */
interface Hands {
  eachHand(fn: (id: number, x: number, y: number, z: number, yaw: number, tall: number, fade: number, speed: number) => void): void;
}

export class SintMaarten {
  readonly group = new THREE.Group();
  readonly rider: Sinterklaas;
  private eve = false;
  private clock = 0;
  private lanterns: THREE.InstancedMesh | null = null;
  private lanternMat: THREE.MeshBasicMaterial | null = null;
  private hay: THREE.InstancedMesh | null = null;
  private hayAt = -1e9;
  private lit = 0;

  constructor(private world: World, groundAt: (x: number, z: number) => number, precompile: (root: THREE.Object3D) => unknown = () => {}) {
    this.group.name = 'sint-maarten';
    this.rider = new Sinterklaas(world, groundAt, precompile, SINT_MAARTEN);
    this.group.add(this.rider.group);
  }

  /** In Explore during his days (main.ts): there, else gone. `eve`: one of his evenings (lanterns, carrots). */
  setActive(on: boolean, eve: boolean): void {
    this.eve = on && eve;
    this.rider.setActive(on);
  }

  /** The lanterns: a stick held forward from the hand, a string, a round paper lantern; one mesh, its colours per vertex. */
  private buildLanterns(): void {
    const parts: THREE.BufferGeometry[] = [];
    const paint = (g: THREE.BufferGeometry, shade: (y: number, ny: number) => number) => {
      const pos = g.attributes.position;
      const nor = g.attributes.normal;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) col.fill(shade(pos.getY(i), nor.getY(i)), i * 3, i * 3 + 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(g.index ? g.toNonIndexed() : g);
    };
    // The stick from the hand (the origin) forward and up to its tip; the lantern hangs from the tip.
    const tip = new THREE.Vector3(0, 0.42, 0.3);
    const stick = new THREE.CylinderGeometry(0.007, 0.009, tip.length(), 5, 1, true);
    stick.translate(0, tip.length() / 2, 0).applyQuaternion(_q.setFromUnitVectors(UP, tip.clone().normalize()));
    paint(stick, () => 0.03);
    paint(new THREE.CylinderGeometry(0.0025, 0.0025, 0.07, 4, 1, true).translate(tip.x, tip.y - 0.035, tip.z), () => 0.03);
    const r = 0.1;
    const cy = tip.y - 0.07 - r * 0.85;
    // The paper: brightest round its middle, a little darker towards the rims.
    paint(new THREE.SphereGeometry(r, 14, 9).scale(1, 0.85, 1).translate(tip.x, cy, tip.z), (_y, ny) => 0.55 + 0.45 * (1 - Math.abs(ny)));
    for (const s of [1, -1]) paint(new THREE.CylinderGeometry(r * 0.42, r * 0.42, 0.012, 10).translate(tip.x, cy + s * r * 0.8, tip.z), () => 0.05);
    const geo = mergeGeometries(parts);
    for (const g of parts) g.dispose();
    this.lanternMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.lanterns = new THREE.InstancedMesh(geo, this.lanternMat, MAX_LANTERNS);
    this.lanterns.setColorAt(0, _c.set(1, 1, 1)); // the colours per lantern from the start, so the shader is built with them
    this.lanterns.count = 0;
    this.lanterns.frustumCulled = false;
    this.lanterns.userData.ignoreRay = true;
    this.lanterns.raycast = () => {};
    this.group.add(this.lanterns);
  }

  /** A carrot with its green on a little heap of hay; one mesh, its colours per vertex. */
  private buildHay(): void {
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, color: string, vary = 0) => {
      const c = new THREE.Color(color);
      const pos = g.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const k = 1 - vary * hash(i * 7.3 + pos.getX(i) * 31);
        col.set([c.r * k, c.g * k, c.b * k], i * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(g.index ? g.toNonIndexed() : g);
    };
    // The hay: a low lumpy mound, its straw lighter and darker here and there.
    const mound = new THREE.SphereGeometry(0.2, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const pos = mound.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const lump = 1 + 0.18 * (hash(Math.round(pos.getX(i) * 50) * 13 + Math.round(pos.getZ(i) * 50)) - 0.5);
      pos.setXYZ(i, pos.getX(i) * lump, pos.getY(i) * 0.5 * lump, pos.getZ(i) * lump);
    }
    mound.computeVertexNormals();
    add(mound, '#d6b25e', 0.35);
    // The carrot lying across the top, its leaves at the thick end.
    const carrot = new THREE.ConeGeometry(0.022, 0.19, 8).rotateZ(Math.PI / 2).translate(0.01, 0.105, 0.02);
    add(carrot, '#e8701a', 0.1);
    for (const a of [-0.5, 0, 0.5]) add(new THREE.ConeGeometry(0.008, 0.11, 4).rotateZ(Math.PI / 2 + 0.25).rotateY(a).translate(-0.135, 0.115, 0.02), '#4f8a2b', 0.2);
    const geo = mergeGeometries(parts);
    for (const g of parts) g.dispose();
    this.hay = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), DOORS.length);
    this.hay.count = 0;
    this.hay.userData.ignoreRay = true;
    this.hay.raycast = () => {};
    this.group.add(this.hay);
  }

  /** The carrots by the doors: a few doors picked by where they are, beside the step, on the ground there. */
  private placeHay(): void {
    if (!this.hay) return;
    let n = 0;
    for (const [x, z, nx, nz] of DOORS) {
      if (hash(x * 3.1 + z * 1.7) > 0.62) continue;
      const side = hash(x + z) < 0.5 ? 1 : -1;
      const px = x + nx * 0.5 + nz * side * 0.8; // out of the door, then to one side of it
      const pz = z + nz * 0.5 - nx * side * 0.8;
      const bare = this.world.groundAt(px, pz, -1e4, 0).y;
      const y = this.world.groundAt(px, pz, bare + 0.6, 0).y;
      _m.compose(_p.set(px, y, pz), _q.setFromAxisAngle(UP, hash(x * 5.3) * Math.PI * 2), _s.setScalar(1.3));
      this.hay.setMatrixAt(n++, _m);
    }
    this.hay.count = n;
    this.hay.instanceMatrix.needsUpdate = true;
    this.hay.computeBoundingSphere();
  }

  /**
   * Each frame, after the villagers. `me`, `ui` and `view` as Sinterklaas's (world/sinterklaas.ts); `hands`: the
   * villagers, who carry the lanterns.
   */
  update(dt: number, camera: THREE.Camera, me: { x: number; z: number } | null, ui: boolean, view: { w: number; h: number }, hands: Hands): void {
    this.rider.update(dt, camera, me, ui, view);
    this.clock += dt;
    // The carrots and hay, all day on his evenings; placed again now and then (the village's blocks come in late).
    if (this.eve && !this.hay) this.buildHay();
    if (this.hay) {
      this.hay.visible = this.eve;
      if (this.eve && this.clock - this.hayAt > 8) {
        this.hayAt = this.clock;
        this.placeHay();
      }
    }
    // The lanterns: lit at dusk and at night, a soft glow in the paper.
    const want = this.eve ? THREE.MathUtils.smoothstep(mood.night, 0.15, 0.6) : 0;
    this.lit += Math.sign(want - this.lit) * Math.min(Math.abs(want - this.lit), dt * 0.5);
    if (this.lit <= 0.001) {
      if (this.lanterns) this.lanterns.visible = false;
      return;
    }
    if (!this.lanterns) this.buildLanterns();
    const lanterns = this.lanterns!;
    lanterns.visible = true;
    this.lanternMat!.color.setScalar(0.3 + 1.2 * this.lit); // glows more as it darkens; far under 65504
    let n = 0;
    hands.eachHand((id, x, y, z, yaw, tall, fade, speed) => {
      if (n >= MAX_LANTERNS || fade <= 0.05) return;
      const child = tall < 1.4;
      if (hash(id * 1.37) > (child ? 1 : 0.45)) return;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      // The right hand, a little ahead (as the dog's lead in world/villagers.ts), held up at the elbow's height.
      _p.set(x + fx * 0.22 - fz * 0.2, y + 0.52 * tall, z + fz * 0.22 + fx * 0.2);
      const sway = Math.sin(this.clock * 6.5 + id) * 0.09 * Math.min(1, speed) + Math.sin(this.clock * 1.3 + id * 2.1) * 0.03;
      _q.setFromAxisAngle(UP, yaw).multiply(_q2.setFromAxisAngle(X, sway));
      _m.compose(_p, _q, _s.set(1, 1, 1));
      lanterns.setMatrixAt(n, _m);
      lanterns.setColorAt(n, _c.copy(PAPER[Math.floor(hash(id * 2.9) * PAPER.length)]).multiplyScalar(Math.min(1, fade * 1.2)));
      n++;
    });
    lanterns.count = n;
    lanterns.instanceMatrix.needsUpdate = true;
    if (lanterns.instanceColor) lanterns.instanceColor.needsUpdate = true;
  }

  /** For the checks. */
  state(): ReturnType<Sinterklaas['state']> & { eve: boolean; lanterns: number; lit: number; hay: number } {
    return { ...this.rider.state(), eve: this.eve, lanterns: this.lanterns?.visible ? this.lanterns.count : 0, lit: +this.lit.toFixed(2), hay: this.hay?.visible ? this.hay.count : 0 };
  }
}
