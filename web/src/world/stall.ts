import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STALL, type StallKind, type StallSpot } from '../../shared/stall.mjs';
import { onPaintball } from '../paintball';
import type { World } from './collision';
import { daylight } from './daylight';
import { mood } from './mood';
import { rewardSign } from './rewards';
import { ITEM_X, ITEM_Z, stallPick } from './stallAim';

/**
 * The market stall at the Zombies place (shared/stall.mjs STALL_SPOTS) while a game runs there: a wooden table
 * under a red and cream striped awning, the six things sold lying on it (the rewards' own shapes, world/rewards.ts)
 * and a lamp. Open in the break, shut during a wave (a cloth over the table, the lamp dark). Made in code: boxes,
 * and the signs baked with their colours on the vertices.
 *
 * Three meshes: the frame (lit, shadows; its geometry swapped open or shut), the goods (unlit, shown when open,
 * shaded as from the lamp, dimmed with the day's light and brighter at night each frame) and, open at night, the
 * lamp's light (lampParts: a pool on the ground, the table's top, the awning's underside; one small colour shader
 * that adds a little warm light there). No real light, no texture.
 * Zombies walk round it through their grid (makeNav's boxes, stallBox); players get a walking-only barrier; shots
 * and blasts pass through (ignoreRay), as the server knows no stall for them. `aim` says which thing you face.
 */

// The local frame: the origin on the ground under the table's middle, the front along -z, the table along x.
const TOP_Y = 0.925;
const C = {
  top: '#8a6a45',
  skirt: '#6f5235',
  post: '#5a3d22',
  red: '#b8322a',
  cream: '#efe6d0',
  cloth: '#6b7a5a',
  dark: '#2a2622',
  bulbOff: '#4a4438',
};
const ITEM_FIT = 0.34;
const BULB = new THREE.Vector3(0, 1.75, -0.3);
/** The lamp's light on the goods: from the front and above */
const LAMP_DIR = new THREE.Vector3(0, 0.89, -0.45).normalize();
const KEY = 'stall';

/** One part with a colour on its vertices: position, normal and colour only, not indexed (they all merge). */
function part(geo: THREE.BufferGeometry, hex: string | THREE.Color, m?: THREE.Matrix4): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position.clone());
  g.setAttribute('normal', src.attributes.normal.clone());
  if (m) g.applyMatrix4(m);
  const c = hex instanceof THREE.Color ? hex : new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: string, rx = 0) =>
  part(new THREE.BoxGeometry(w, h, d), hex, new THREE.Matrix4().makeRotationX(rx).premultiply(new THREE.Matrix4().makeTranslation(x, y, z)));

/** The table, its posts and crossbars, the awning and its flaps, the lamp's cord and cap. */
function frameParts(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  out.push(box(2.4, 0.05, 0.8, 0, TOP_Y - 0.025, 0, C.top));
  out.push(box(2.4, 0.5, 0.03, 0, 0.65, -0.385, C.skirt));
  for (const s of [-1, 1]) out.push(box(0.03, 0.5, 0.77, s * 1.185, 0.65, 0, C.skirt));
  // Four posts from under the ground (it slopes up to 0.23 m) to the awning: lower at the front.
  for (const sx of [-1, 1]) {
    for (const [z, top] of [[-0.4, 2.05], [0.4, 2.3]]) out.push(box(0.07, top + 0.3, 0.07, sx * 1.2, (top - 0.3) / 2, z, C.post));
  }
  out.push(box(2.47, 0.06, 0.06, 0, 2.02, -0.4, C.post), box(2.47, 0.06, 0.06, 0, 2.27, 0.4, C.post));
  // The awning: from 2.3 m at the back (z +0.45) down to 2.0 m at the front (z -0.85), seven strips, a flap under each.
  const dz = 1.3, dy = 0.3;
  const len = Math.hypot(dz, dy), tilt = -Math.atan2(dy, dz);
  for (let i = 0; i < 7; i++) {
    const x = -1.2 + 0.4 * i;
    const hex = i % 2 ? C.cream : C.red;
    out.push(box(0.4, 0.025, len, x, 2.15, -0.2, hex, tilt));
    out.push(box(0.4, 0.16, 0.015, x, 2.0 - 0.08, -0.855, hex));
  }
  // The lamp: a cord from the awning, a dark cap over the bulb.
  out.push(box(0.012, 0.33, 0.012, BULB.x, 1.955, BULB.z, C.dark));
  out.push(part(new THREE.CylinderGeometry(0.03, 0.05, 0.05, 8, 1), C.dark, new THREE.Matrix4().makeTranslation(BULB.x, BULB.y + 0.045, BULB.z)));
  return out;
}

/** A low box over the table, its top 6 cm narrower all round: the cloth when shut. */
function clothPart(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(2.3, 0.28, 0.72).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) <= 0) continue;
    p.setX(i, p.getX(i) - Math.sign(p.getX(i)) * 0.06);
    p.setZ(i, p.getZ(i) - Math.sign(p.getZ(i)) * 0.06);
  }
  g.computeVertexNormals();
  g.translate(0, TOP_Y + 0.14, 0);
  return part(g, C.cloth);
}

const bulbGeo = () => new THREE.SphereGeometry(0.045, 8, 6).translate(BULB.x, BULB.y, BULB.z);

/** One reward's sign baked: its meshes' colours on the vertices (the visible ones only), shaded as from the lamp. */
function bakedSign(kind: StallKind): THREE.BufferGeometry {
  const g = rewardSign(kind);
  g.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  g.traverseVisible((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
    if (mat.blending === THREE.AdditiveBlending) return; // the turret's muzzle flash
    parts.push(part(o.geometry, mat.color ?? new THREE.Color('#ffffff'), o.matrixWorld));
  });
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  // Shade as from the lamp, then fit it in a square of ITEM_FIT on the table.
  const n = merged.attributes.normal;
  const col = merged.attributes.color;
  const v = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) {
    v.fromBufferAttribute(n, i);
    const k = 0.55 + 0.45 * Math.max(0, v.dot(LAMP_DIR));
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  merged.computeBoundingBox();
  const b = merged.boundingBox!;
  const s = ITEM_FIT / Math.max(b.max.x - b.min.x, b.max.z - b.min.z, 1e-3);
  merged.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  merged.scale(s, s, s);
  return merged;
}

/**
 * The lamp's light at night, much as the street lamps' pools (world/streetLights.ts): no real light, but thin surfaces
 * laid on what it lights, drawn after it, that add a little warm light there: a pool on the ground round the stall,
 * the table's top, and the awning's underside and the inside of its flaps. Added, not multiplied as the street lamps'
 * pools: the underside is near black at night and stays black multiplied, and a torch's spot on the pool would be
 * blown out. `bright` is worked out per vertex as light from the bulb falls (its angle on the surface, less with the
 * distance squared), so a plain colour shader does it. One draw call, no texture; at most about 0.8 added (linear,
 * just over the bulb), far under the half floats' end.
 */
const LAMP = new THREE.Color(1.0, 0.72, 0.42);
/** m: the pool on the ground, round the point under the bulb */
const POOL_R = 3;
/** The light's strength on the ground, the table's top and the awning */
const GAIN = { ground: 0.6, table: 0.25, awning: 0.5 };
const lampVertex = /* glsl */ `
  attribute float bright;
  varying float vBright;
  void main() {
    vBright = bright;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const lampFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  varying float vBright;
  void main() {
    gl_FragColor = vec4(color * vBright * strength, 1.0);
  }`;

/** How much of the bulb's light reaches a point `p` facing `n` (local frame). */
function lampAt(p: THREE.Vector3, n: THREE.Vector3): number {
  const l = BULB.clone().sub(p);
  const d2 = l.lengthSq();
  return Math.max(0, n.dot(l.normalize())) / (d2 + 0.5);
}

/**
 * A grid of `nu` by `nv` cells, its points at `at(u, v)` (0 to 1 each) facing `n`, `gain` times the lamp's light on
 * each (times `fade(u, v)`). Indexed: position and bright only.
 */
function lampGrid(nu: number, nv: number, at: (u: number, v: number) => THREE.Vector3, n: THREE.Vector3, gain: number, fade = (_u: number, _v: number) => 1) {
  const pos: number[] = [];
  const bright: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const p = at(i / nu, j / nv);
      pos.push(p.x, p.y, p.z);
      bright.push(gain * lampAt(p, n) * fade(i / nu, j / nv));
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('bright', new THREE.Float32BufferAttribute(bright, 1));
  g.setIndex(index);
  return g;
}

/** The pool on the ground (its heights set where it stands: groundPool), the table's top, the awning's underside, the flaps' inside. */
function lampParts(): THREE.BufferGeometry[] {
  const up = new THREE.Vector3(0, 1, 0);
  // The ground: rings round the point under the bulb, faded out to the edge.
  const pool = lampGrid(24, 10, (u, v) => new THREE.Vector3(BULB.x + Math.cos(u * Math.PI * 2) * v * POOL_R, 0, BULB.z + Math.sin(u * Math.PI * 2) * v * POOL_R), up, GAIN.ground, (_u, v) => 1 - THREE.MathUtils.smoothstep(v, 0.6, 1));
  const table = lampGrid(8, 3, (u, v) => new THREE.Vector3(-1.2 + 2.4 * u, TOP_Y + 0.003, -0.4 + 0.8 * v), up, GAIN.table);
  // The awning's underside: from 2.3 m at the back (z +0.45) down to 2.0 m at the front (z -0.85), its strips 2.5 cm thick.
  const slope = 0.3 / 1.3;
  const under = new THREE.Vector3(0, -1, slope).normalize();
  const awning = lampGrid(8, 6, (u, v) => {
    const z = 0.45 - 1.3 * v;
    return new THREE.Vector3(-1.4 + 2.8 * u, 2.15 + (z + 0.2) * slope - 0.017, z);
  }, under, GAIN.awning);
  const flaps = lampGrid(8, 1, (u, v) => new THREE.Vector3(-1.4 + 2.8 * u, 1.84 + 0.16 * v, -0.843), new THREE.Vector3(0, 0, 1), GAIN.awning);
  return [pool, table, awning, flaps];
}

export class MarketStall {
  readonly group = new THREE.Group();
  /** Hidden for the frame-time checks (briel.marketStall.mute) */
  mute = false;
  private frameMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  private goodsMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private lampMat = new THREE.ShaderMaterial({
    uniforms: { color: { value: LAMP.clone() }, strength: { value: 1 } },
    vertexShader: lampVertex,
    fragmentShader: lampFragment,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  private openGeo: THREE.BufferGeometry;
  private shutGeo: THREE.BufferGeometry;
  private frame: THREE.Mesh;
  private goods: THREE.Mesh;
  /** The lamp's light at night (lampParts); the pool's ground points first, poolN of them */
  private lamp: THREE.Mesh;
  private poolN: number;
  private spot: StallSpot | null = null;
  private ground = 0;
  private open: boolean | null = null;
  private barrier = false;

  constructor(private world: World, private groundAt: (x: number, z: number) => number, precompile: (root: THREE.Object3D) => unknown = () => {}) {
    const parts = frameParts();
    this.openGeo = mergeGeometries(parts);
    this.shutGeo = mergeGeometries([...parts, clothPart(), part(bulbGeo(), C.bulbOff)]);
    for (const p of parts) p.dispose();
    this.frame = new THREE.Mesh(this.openGeo, this.frameMat);
    this.frame.castShadow = this.frame.receiveShadow = true;
    this.goods = new THREE.Mesh(this.goodsGeo(), this.goodsMat);
    const lamp = lampParts();
    this.poolN = lamp[0].attributes.position.count;
    this.lamp = new THREE.Mesh(mergeGeometries(lamp), this.lampMat);
    for (const p of lamp) p.dispose();
    this.lamp.renderOrder = 60; // after what it lights, as the street lamps' pools
    this.lamp.userData.noAO = true;
    this.lamp.raycast = () => {};
    for (const m of [this.frame, this.goods, this.lamp]) m.userData.ignoreRay = true;
    this.group.add(this.frame, this.goods, this.lamp);
    this.group.name = 'marketStall';
    // Its three materials compiled before it first shows (compiling walks only what is visible).
    void precompile(this.group);
    this.group.visible = false;
    onPaintball(() => {
      this.goods.geometry.dispose();
      this.goods.geometry = this.goodsGeo();
    });
  }

  /** The six things merged, and the lit bulb. */
  private goodsGeo(): THREE.BufferGeometry {
    const parts = STALL.items.map(([kind], i) => bakedSign(kind).translate(ITEM_X[i], TOP_Y, ITEM_Z));
    parts.push(part(bulbGeo(), new THREE.Color(3, 2, 1)));
    const g = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    return g;
  }

  /**
   * Every frame: the stall at `spot` ({ x, z, yaw }), open or shut; null: none (the group hidden, the barrier gone).
   */
  show(spot: StallSpot | null, open: boolean): void {
    if (!spot) {
      if (this.spot || this.barrier) {
        this.spot = null;
        this.open = null;
        this.group.visible = false;
        this.setBarrier(false);
      }
      return;
    }
    if (spot !== this.spot) {
      this.spot = spot;
      this.ground = this.groundAt(spot.x, spot.z);
      this.group.position.set(spot.x, this.ground, spot.z);
      this.group.rotation.set(0, spot.yaw, 0);
      this.group.updateMatrixWorld(true);
      this.groundPool(spot);
      this.setBarrier(true);
    }
    if (open !== this.open) {
      this.open = open;
      this.frame.geometry = open ? this.openGeo : this.shutGeo;
      this.goods.visible = open;
    }
    this.group.visible = !this.mute;
    // The lamp's light from dusk on, as the street lamps (mood.night); shut, the lamp is dark.
    const lit = open ? mood.night : 0;
    this.lamp.visible = lit > 0.01;
    this.lampMat.uniforms.strength.value = lit;
    if (open) {
      // Lamp-lit: by day no brighter than a sunlit wall; at night brighter by the night's amount than the dark round it.
      const v = (0.45 + 0.55 * daylight()) * (1 + 0.5 * mood.night);
      this.goodsMat.color.setRGB(v, v * (1 - 0.06 * mood.night), v * (1 - 0.16 * mood.night));
    }
  }

  /** The pool's points on the ground where the stall stands (a slope, a kerb), a few cm above it. */
  private groundPool(s: StallSpot): void {
    const p = this.lamp.geometry.attributes.position as THREE.BufferAttribute;
    const cos = Math.cos(s.yaw), sin = Math.sin(s.yaw);
    for (let i = 0; i < this.poolN; i++) {
      const lx = p.getX(i), lz = p.getZ(i);
      const x = s.x + lx * cos + lz * sin, z = s.z - lx * sin + lz * cos;
      const y = Math.max(this.groundAt(x, z), this.world.groundAt(x, z, this.ground + 0.3, 0).y);
      p.setY(i, y - this.ground + 0.03);
    }
    p.needsUpdate = true;
    this.lamp.geometry.computeBoundingSphere();
  }

  /** The thing on the table you face from (x, feet, z) looking along `yaw` (the game's), 'shut' during a wave, or null. */
  aim(x: number, feet: number, z: number, yaw: number): StallKind | 'shut' | null {
    const s = this.spot;
    if (!s || (!this.group.visible && !this.mute)) return null; // hidden (muted for the checks: still there)
    if (Math.abs(feet - this.ground) > 1) return null;
    const best = stallPick(s, x, z, yaw); // in front or behind, never from an end (world/stallAim.ts)
    if (best < 0) return null;
    return this.open ? STALL.items[best][0] : 'shut';
  }

  private setBarrier(on: boolean): void {
    this.barrier = on;
    const s = this.spot;
    if (!on || !s) return this.world.setMoving(KEY, null, 0, 0, true);
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const sx = -fz, sz = fx;
    const { halfL: l, halfW: w } = STALL.box;
    const ring: [number, number][] = [[l, w], [l, -w], [-l, -w], [-l, w]].map(([a, b]) => [s.x + fx * a + sx * b, s.z + fz * a + sz * b]);
    this.world.setMoving(KEY, ring, this.ground - 0.3, this.ground + 2.4, true);
  }
}
