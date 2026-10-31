import * as THREE from 'three';
import DATA from '../data/countryside.json';
import { Ambience } from './ambience';
import { Birds, Ducks } from './fieldBirds';
import type { World } from './collision';
import { patchFields, rowDetail } from './fields';
import { Herds, type HerdSpec } from './herds';
import { house, type Prism } from './houseData';
import { blockMaterial } from './houseMeshes';
import { terrain } from './terrain';
import { wind } from './wind';

/**
 * The life of the countryside round the house, loaded once the start screen is up (its code and
 * data are a chunk of their own, the cows and sheep a 77 KB model): the herds in the meadows, the
 * birds over the fields and on the ponds, round bales by the barns, the rows in the fields, the
 * wind in the trees and the sounds of it all. Where things go comes from tools/countryside.py.
 *
 * On Low and on phones the trees stand still and the animals have no shadows and are drawn less far;
 * on phones the fields keep plain soil.
 */

export interface CountrysideOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  world: World;
  /** The shared clock (s): the herds are where everyone sees them */
  now: () => number;
  /** The graphics preset now */
  quality: () => string;
  phone: boolean;
  /** The surroundings' draw distance now (m) */
  far: () => number;
  /** Whether you are inside a house */
  indoors: () => boolean;
}

const BALE_COLOURS: Record<string, string> = { black: '#1d1e20', white: '#e6e6e0', green: '#3d5636', hay: '#b39557' };

/** A row of bales: from (x0, z0) to (x1, z1), how many, the wrapping and how they lie. */
type BaleRow = [number, number, number, number, number, string, 'inline' | 'stack' | 'hay'];

/**
 * Rows of round bales (1.3 m across, 1.2 m long), as the photo shows them: a row wrapped in one
 * long white sleeve, end to end on their round sides; black ones stored upright in a farmyard, a
 * few stacked on top; hay on its round side, the bales side by side. One instanced mesh; each
 * row is one block for walking into.
 */
function bales(rows: BaleRow[], ground: number, world: World): THREE.Object3D {
  const geometry = new THREE.CylinderGeometry(0.65, 0.65, 1.18, 16);
  const at: THREE.Matrix4[] = [];
  const colours: THREE.Color[] = [];
  const blocks: Prism[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const across = new THREE.Vector3(1, 0, 0);
  const along = new THREE.Vector3(0, 0, 1);
  for (const [x0, z0, x1, z1, n, wrap, style] of rows) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    const yaw = Math.atan2(-dz, dx);
    const lying = style !== 'stack';
    const gap = style === 'inline' ? 1.25 : 1.34; // in a sleeve: a narrow waist between the bales
    const used = n * gap;
    const start = (len - used) / 2;
    const place = (d: number, lift: number, turn: number) => {
      const x = x0 + dx * d;
      const z = z0 + dz * d;
      // Upright, or on its side: its axis along the row (in a sleeve) or across it (hay).
      const q = new THREE.Quaternion().setFromAxisAngle(up, yaw + turn);
      if (style === 'hay') q.multiply(new THREE.Quaternion().setFromAxisAngle(across, Math.PI / 2));
      if (style === 'inline') q.multiply(new THREE.Quaternion().setFromAxisAngle(along, Math.PI / 2));
      at.push(new THREE.Matrix4().compose(new THREE.Vector3(x, ground + terrain.height(x, z) + (lying ? 0.62 : 0.57) + lift, z), q, new THREE.Vector3(1, 1, 1)));
      colours.push(new THREE.Color(BALE_COLOURS[wrap] ?? BALE_COLOURS.black).multiplyScalar(0.94 + ((at.length * 7) % 5) * 0.025));
    };
    for (let i = 0; i < n; i++) place(start + gap / 2 + i * gap, 0, style === 'inline' ? 0 : ((i * 5) % 3) * 0.04);
    // Stored upright: every third one has another on top.
    if (style === 'stack') for (let i = 1; i < n; i += 3) place(start + gap / 2 + i * gap, 1.18, 0.3);
    const ax = x0 + dx * start;
    const az = z0 + dz * start;
    const bx = ax + dx * used;
    const bz = az + dz * used;
    const [nx, nz] = [-dz * 0.65, dx * 0.65];
    blocks.push({ m: 'hedge', y0: ground, y1: ground + (lying ? 1.3 : 2.36), d: 1, p: [[[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]] });
  }
  world.addPrisms(blocks);
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.45 }), Math.max(1, at.length));
  at.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, colours[i]);
  });
  mesh.count = at.length;
  mesh.computeBoundingSphere();
  mesh.userData.material = 'hedge';
  return mesh;
}

/** The middle of each block of a kind of ground cover in the ring (for where sounds come from). */
function middles(kinds: string[]): THREE.Vector3[] {
  return (house.surroundings?.prisms ?? [])
    .filter((p) => kinds.includes(p.m))
    .map((p) => {
      const ring = p.p[0];
      const x = ring.reduce((s, q) => s + q[0], 0) / ring.length;
      const z = ring.reduce((s, q) => s + q[1], 0) / ring.length;
      return new THREE.Vector3(x, house.ground + terrain.height(x, z), z);
    });
}

export class Countryside {
  readonly group = new THREE.Group();
  /** Parts switched off, to measure what they cost: 'wind', 'rows', 'herds', 'birds', 'bales', 'sound'. */
  readonly off = new Set<string>();
  private herds: Herds;
  private birds: Birds;
  private ducks: Ducks;
  private bales: THREE.Object3D;
  private ambience: Ambience;
  /** The bale rows' middles and sizes, to draw them only when in view. */
  private baleSpots: THREE.Sphere[];
  private checkIn = 0;
  private frustum = new THREE.Frustum();
  private viewProj = new THREE.Matrix4();
  private camera: THREE.Camera | null = null;

  constructor(private o: CountrysideOptions) {
    const ground = house.ground;
    this.herds = new Herds(DATA.herds as unknown as HerdSpec[], ground, o.now, (key, ring, y0, y1) => o.world.setMoving(key, ring, y0, y1));
    // Flocks over the big fields to the north-west and the east.
    this.birds = new Birds([[-230, -300], [300, 30]], DATA.crows as [number, number, number][], ground);
    this.ducks = new Ducks(DATA.ducks as [number, number, number, number, number][]);
    this.bales = bales(DATA.bales as BaleRow[], ground, o.world);
    this.baleSpots = (DATA.bales as BaleRow[]).map(([x0, z0, x1, z1]) => {
      const x = (x0 + x1) / 2;
      const z = (z0 + z1) / 2;
      return new THREE.Sphere(new THREE.Vector3(x, ground + terrain.height(x, z) + 1, z), Math.hypot(x1 - x0, z1 - z0) / 2 + 3);
    });
    this.group.add(this.herds.group, this.birds.group, this.ducks.group, this.bales);
    o.scene.add(this.group);
    this.ambience = new Ambience(middles(['forest']), middles(['field_soil', 'field_dark', 'field_crop']), o.indoors);
    patchFields(blockMaterial('field_soil', o.renderer).material as THREE.MeshStandardMaterial);
  }

  /** The graphics settings and what is switched off: less on Low and on phones. */
  private settings(): void {
    const off = this.off;
    const low = this.o.phone || this.o.quality() === 'low';
    wind.strength.value = low || off.has('wind') ? 0 : 1;
    this.herds.low = low;
    rowDetail.value = this.o.phone || off.has('rows') ? 0 : 1;
    // Switched off: hidden. Switched on: update() draws what is in view.
    this.birds.group.visible = this.ducks.group.visible = !off.has('birds');
    if (off.has('bales')) this.bales.visible = false;
    if (off.has('herds')) this.herds.group.visible = false;
  }

  /** Every frame, before drawing: what moves, and what is in view of the camera. */
  update(dt: number, camera: THREE.Camera): void {
    this.camera = camera;
    const eye = camera.position;
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    wind.time.value += dt;
    this.checkIn -= dt;
    if (this.checkIn <= 0) {
      this.checkIn = 1;
      this.settings();
    }
    if (!this.off.has('herds')) this.herds.update(dt, eye, this.frustum, this.o.far());
    if (!this.off.has('birds')) {
      this.birds.update(eye, this.frustum);
      this.ducks.update(dt, eye, this.frustum);
    }
    // The bales: beyond 450 m a few pixels.
    if (!this.off.has('bales')) this.bales.visible = this.baleSpots.some((s) => s.center.distanceTo(eye) < 450 && this.frustum.intersectsSphere(s));
    if (!this.off.has('sound')) this.ambience.update(dt, eye);
  }

  /** Apply a change to `off` at once (for measuring): the settings, and what is in view now. */
  refresh(): void {
    this.settings();
    if (this.camera) this.update(0, this.camera);
  }
}
