import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import CATALOGUE from '../../shared/furniture.json';
import type { World } from './collision';
import type { FixtureSpec } from './houseData';
import { drawCode, drawDesktop, drawLlama, drawPainting, drawPrint, drawRide, washTexture } from './screens';

/**
 * Furniture placed with the planner: simple shapes at real sizes (a bed is
 * 160 x 200 cm), coloured per part. Every piece of the same kind is drawn in
 * one go (instancing) with one shared material, so a furnished house stays
 * light on weak graphics. Pieces are solid to walk into, except rugs.
 * A few are models made in Blender (the office chair, the soundbar), turned into
 * the same coloured parts. Screens and light strips are separate small meshes
 * that follow their piece: the indoor-bike screen shows a ride that moves.
 */

export interface Piece {
  id: number;
  item: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  by?: string;
}

export interface Item {
  id: string;
  name: string;
  size: [number, number, number];
}

export const ITEMS = CATALOGUE.items as Item[];
export const MAX_PIECES = CATALOGUE.max;

const C = {
  oak: '#b88a5a', walnut: '#6b4a33', white: '#e9e6e0', black: '#2a2a2c', grey: '#7d8187', beige: '#c7bba5',
  green: '#6d7a63', mattress: '#eeeae2', duvet: '#d9d4cb', pillow: '#f4f1eb', metal: '#9a9ca0', screen: '#111214',
  pot: '#b06a4a', leaf: '#4f6b3a', rug: '#8c7f72', rugEdge: '#6f655b', shade: '#efe7d6',
  boucle: '#e6dfd2', marble: '#3b3330', plum: '#4f4359', wicker: '#5a3d2e', cushion: '#3f4a35',
  lacquer: '#eeebe5', felt: '#2d2e31', keys: '#3a3b3f', slat: '#b9895c', jute: '#c9b48f', juteEdge: '#a8946f',
  mat: '#f3f1ec', bottle: '#1c1d1f', ash: '#d8bf9f', honey: '#c9a273',
  // the walnut table and its warmer foot, sheer curtains, the striped and quilted
  // bedding, the cushions on the window seat.
  tableTop: '#664e41', tableFoot: '#9c8073', inlay: '#3b2a20', sheer: '#f7f5f0', mustard: '#cf8b33',
  stripeGrey: '#5f6267', stripeTaupe: '#8c8174', quilt: '#f1eff4', pillowGrey: '#a7a8a6', ring: '#4b4139',
};

// Models from Blender (tools/aeron.py, tools/soundbar.py, tools/interior.py): every material's base
// colour becomes the parts' colour. A few kinds of part are drawn with a texture of their own (KINDS):
// "Mesh" (the office chair's seat and back) keeps its UVs for a see-through weave, "Lattice" (the
// rattan shade) for an open cane lattice, and "Boucle..." (the dining chair) gets the flecked cloth.
// interior.glb holds one object per piece, each a model of its own (ShellChair, Kentia, AcornCap, ...).
const MODEL_URLS: Record<string, string> = { aeron: '/models/aeron.glb', soundbar: '/models/soundbar.glb', interior: '/models/interior.glb' };
const models = new Map<string, Part[]>();

/** What a part is drawn with: the plain coloured material, or one of the textured ones. */
type Kind = 'solid' | 'weave' | 'lattice' | 'cloth';
const KINDS: Kind[] = ['solid', 'weave', 'lattice', 'cloth'];
const kindOf = (g: THREE.BufferGeometry): Kind => g.userData.kind ?? 'solid';

function paint(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([color.r, color.g, color.b], i);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * Upholstery, rugs and cushions: the flecked
 * cloth texture, projected straight onto each triangle from the side it faces most (UVs in units of
 * the texture's 30 cm), so it needs no UVs from the model and keeps its size on every part.
 */
function cloth(geo: THREE.BufferGeometry): Part {
  const p = geo.attributes.position;
  const uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i + 2 < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    const n = c.sub(b).cross(a.clone().sub(b)); // the face's normal (c reused)
    const [ax, ay, az] = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    for (let k = i; k < i + 3; k++) {
      const [x, y, z] = [p.getX(k), p.getY(k), p.getZ(k)];
      const [u, v] = ax >= ay && ax >= az ? [z, y] : ay >= az ? [x, z] : [x, y];
      uv.set([u / 0.3, v / 0.3], k * 2);
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.userData.kind = 'cloth';
  return geo;
}

/** A repeatable 0..1 value for a point (rounded to 2 mm). */
function hash(x: number, y: number, z: number): number {
  const s = Math.sin(Math.round(x * 500) * 12.9898 + Math.round(y * 500) * 78.233 + Math.round(z * 500) * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function asParts(scene: THREE.Object3D): Part[] {
  const out: Part[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mat = o.material as THREE.MeshStandardMaterial;
    let geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (geo.index) geo = geo.toNonIndexed();
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const kind: Kind = !geo.attributes.uv ? 'solid' : mat.name === 'Mesh' ? 'weave' : mat.name === 'Lattice' ? 'lattice' : 'solid';
    if (kind === 'solid') geo.deleteAttribute('uv');
    paint(geo, mat.color);
    if (mat.name.startsWith('Boucle')) cloth(geo);
    else geo.userData.kind = kind;
    out.push(geo);
  });
  return out;
}

/** Load the furniture models once; every `ready` runs as each file comes in (with its name), so pieces can be drawn with them. */
const waiting: ((file: string) => void)[] = [];
export function loadModels(ready: (file: string) => void): void {
  waiting.push(ready);
  if (waiting.length > 1) return;
  const loader = new GLTFLoader();
  for (const [name, url] of Object.entries(MODEL_URLS)) {
    loader.loadAsync(url).then((gltf) => {
      if (name === 'interior') for (const o of gltf.scene.children) models.set(o.name, asParts(o));
      else models.set(name, asParts(gltf.scene));
      for (const w of waiting) w(name);
    }, () => {}); // missing: the simple shapes stay
  }
}

/** A loaded model's parts, scaled by `s`, turned by `ry` and moved to (x, y, z); null while it loads. */
function model(name: string, x = 0, y = 0, z = 0, ry = 0, s = 1): Part[] | null {
  const m = models.get(name);
  if (!m) return null;
  const at = new THREE.Matrix4().makeRotationY(ry).scale(new THREE.Vector3(s, s, s)).setPosition(x, y, z);
  return m.map((g) => {
    const c = g.clone().applyMatrix4(at);
    c.userData = { kind: kindOf(g) };
    return c;
  });
}

type Part = THREE.BufferGeometry;

function coloured(g: THREE.BufferGeometry, color: string): Part {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** A box w x d x h standing on y (bottom), centred on x, z. */
const box = (w: number, d: number, h: number, x: number, y: number, z: number, color: string): Part =>
  coloured(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), color);
const cyl = (r0: number, r1: number, h: number, x: number, y: number, z: number, color: string, seg = 16): Part =>
  coloured(new THREE.CylinderGeometry(r1, r0, h, seg).translate(x, y + h / 2, z), color);
const legs = (w: number, d: number, h: number, t: number, inset: number, color: string): Part[] =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(t, t, h, sx * (w / 2 - inset), 0, sz * (d / 2 - inset), color)));
const col = (hex: string) => new THREE.Color(hex);
/** An upholstered block w x d x h standing on the floor, centred on x, z: rounded edges, in the flecked cloth. */
const soft = (w: number, d: number, h: number, x: number, z: number, color = C.boucle, r = 0.06): Part =>
  cloth(paint(new RoundedBoxGeometry(w, h, d, 2, r).translate(x, h / 2, z), col(color))); // made of loose triangles already

/**
 * A surface over a grid (u and v from 0 to 1), coloured point by point: rugs, bedding, curtains, a
 * plaster relief. The front is the side from which u runs right and v up; `both` adds the back.
 */
function surface(nu: number, nv: number, at: (u: number, v: number) => THREE.Vector3Tuple, color: (u: number, v: number) => THREE.Color, both = false): Part {
  const pos: number[] = [];
  const rgb: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      pos.push(...at(i / nu, j / nv));
      const c = color(i / nu, j / nv);
      rgb.push(c.r, c.g, c.b);
    }
  }
  const front: number[] = [];
  const back: number[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const c = a + nu + 1;
      front.push(a, a + 1, c + 1, a, c + 1, c);
      back.push(a, c + 1, a + 1, a, c, c + 1);
    }
  }
  const make = (index: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(rgb, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    return g.toNonIndexed();
  };
  return both ? mergeGeometries([make(front), make(back)]) : make(front);
}

/** A flat surface lying on the floor at height y, w x d round the centre (u along x, v along -z). */
const floorSurface = (w: number, d: number, y: number, nu: number, nv: number, color: (u: number, v: number) => THREE.Color): Part =>
  surface(nu, nv, (u, v) => [-w / 2 + u * w, y, d / 2 - v * d], color);

/** Books standing in a row from x0 to x1 on a shelf at y, spines at the front (z); a seed for the mix. */
function bookRow(x0: number, x1: number, y: number, z: number, seed: number, colors: string[], tall = 0.24): Part[] {
  const p: Part[] = [];
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let x = x0; x < x1 - 0.015;) {
    const bw = Math.min(x1 - x, 0.018 + rnd() * 0.03);
    const bh = tall * (0.72 + rnd() * 0.28);
    const bd = 0.13 + rnd() * 0.05;
    p.push(box(bw, bd, bh, x + bw / 2, y, z - bd / 2, colors[Math.floor(rnd() * colors.length)]));
    x += bw + 0.002;
  }
  return p;
}

/** A soft cushion, w wide, h high and t thick, its middle plumper than its edges, standing up. */
function cushion(w: number, h: number, t: number, color: (x: number, y: number) => THREE.Color): Part {
  const g = new THREE.BoxGeometry(w, h, t, 8, 8, 1);
  g.deleteAttribute('uv');
  const p = g.attributes.position;
  const rgb = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const fx = p.getX(i) / (w / 2);
    const fy = p.getY(i) / (h / 2);
    const plump = (1 - fx ** 4) * (1 - fy ** 4);
    p.setZ(i, p.getZ(i) * (0.25 + 0.75 * plump));
    p.setX(i, p.getX(i) * (1 - 0.05 * fy * fy));
    p.setY(i, p.getY(i) * (1 - 0.05 * fx * fx));
    const c = color(p.getX(i), p.getY(i));
    rgb.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  g.computeVertexNormals();
  return g.toNonIndexed();
}

/** Front is +z (the side you sit on, look at, open); back is -z. */
function parts(id: string, [w, d, h]: [number, number, number]): Part[] {
  switch (id) {
    case 'bed90': {
      // Children's bed: a walnut base, a white quilted cover with a diamond
      // stitch hanging over the sides and the foot, one grey pillow at the head.
      const quilt = col(C.quilt);
      const stitch = col('#cfccd6');
      const stitched = (x: number, z: number) => {
        const near = (s: number) => Math.abs(s - Math.round(s));
        const t = Math.min(near((x + z) / 0.17), near((x - z) / 0.17));
        return quilt.clone().lerp(stitch, Math.max(0, 1 - t / 0.09));
      };
      return [
        box(w, d - 0.05, 0.3, 0, 0, 0.025, C.walnut),
        box(w - 0.04, d - 0.1, 0.18, 0, 0.3, 0.05, C.mattress),
        box(w + 0.03, d * 0.84, 0.23, 0, 0.29, d * 0.08 + 0.01, C.quilt),
        floorSurface(w + 0.03, d * 0.84, 0.522, 12, 26, (u, v) => stitched((u - 0.5) * (w + 0.03), (0.5 - v) * d * 0.84)).translate(0, 0, d * 0.08 + 0.01),
        cushion(w - 0.28, 0.4, 0.13, () => col(C.pillowGrey)).rotateX(-Math.PI / 2 + 0.25).translate(0, 0.58, -d / 2 + 0.3),
      ];
    }
    case 'bed180': case 'bed160': case 'bed140': {
      // Main bed: a duvet in white, grey and taupe stripes from head to foot,
      // hanging over the sides, and big grey pillows against the headboard.
      const p = [
        box(w, d - 0.05, 0.3, 0, 0, 0.025, C.oak),
        box(w - 0.04, d - 0.1, 0.22, 0, 0.3, 0.05, C.mattress),
        box(w, 0.06, h, 0, 0, -d / 2 + 0.03, C.grey),
      ];
      const stripes: [number, string][] = [[0.07, C.white], [0.035, C.stripeGrey], [0.025, C.white], [0.05, C.stripeTaupe], [0.02, C.white], [0.015, C.stripeGrey]];
      const width = w + 0.04;
      for (let x = -width / 2, k = 0; x < width / 2 - 0.001; k++) {
        const [sw, c] = stripes[k % stripes.length];
        const x1 = Math.min(width / 2, x + sw);
        p.push(box(x1 - x, d * 0.72, 0.25, (x + x1) / 2, 0.29, d * 0.14 + 0.01, c));
        x = x1;
      }
      for (const sx of [-1, 1]) p.push(cushion(w / 2 - 0.1, 0.48, 0.17, () => col(C.pillowGrey)).rotateX(-Math.PI / 2 + 0.55).translate(sx * (w / 4), 0.64, -d / 2 + 0.28));
      return p;
    }
    case 'nightstand':
      return [box(w, d, h - 0.03, 0, 0.03, 0, C.walnut), ...legs(w, d, 0.03, 0.03, 0.03, C.black), box(w - 0.06, 0.01, 0.12, 0, h - 0.2, d / 2, C.oak)];
    case 'wardrobe200': case 'wardrobe100': {
      const p = [box(w, d, h, 0, 0, 0, C.white)];
      const doors = Math.round(w / 0.5);
      for (let i = 1; i < doors; i++) p.push(box(0.008, 0.01, h - 0.04, -w / 2 + (w / doors) * i, 0.02, d / 2, C.black));
      for (let i = 0; i < doors; i++) p.push(box(0.02, 0.03, 0.3, -w / 2 + (w / doors) * (i + 0.5) + ((i % 2) ? -0.2 : 0.2) * (w / doors), 1.0, d / 2 + 0.015, C.metal));
      return p;
    }
    case 'sofa3': case 'sofa2': case 'armchair': {
      const seats = id === 'sofa3' ? 3 : id === 'sofa2' ? 2 : 1;
      const arm = 0.18;
      const inner = w - 2 * arm;
      const p = [
        box(w, d, 0.4, 0, 0.06, 0, C.grey),
        box(w, 0.2, h - 0.46, 0, 0.46, -d / 2 + 0.1, C.grey),
        box(arm, d, 0.62 - 0.06, -w / 2 + arm / 2, 0.06, 0, C.grey),
        box(arm, d, 0.62 - 0.06, w / 2 - arm / 2, 0.06, 0, C.grey),
        ...legs(w, d, 0.06, 0.04, 0.08, C.black),
      ];
      for (let i = 0; i < seats; i++) p.push(box(inner / seats - 0.02, d - 0.24, 0.12, -inner / 2 + (inner / seats) * (i + 0.5), 0.46, 0.1, C.beige));
      return p;
    }
    case 'cornersofa': {
      // Long part along the back, chaise along the right side.
      const deep = 0.9;
      return [
        box(w, deep, 0.4, 0, 0.06, -d / 2 + deep / 2, C.grey),
        box(w, 0.2, h - 0.46, 0, 0.46, -d / 2 + 0.1, C.grey),
        box(deep, d - deep, 0.4, w / 2 - deep / 2, 0.06, deep / 2, C.grey),
        box(0.18, d, 0.56, w / 2 - 0.09, 0.06, 0, C.grey),
        box(0.18, deep, 0.56, -w / 2 + 0.09, 0.06, -d / 2 + deep / 2, C.grey),
        box(w - 0.4, deep - 0.24, 0.12, -0.02, 0.46, -d / 2 + deep / 2 + 0.1, C.beige),
        box(deep - 0.24, d - deep, 0.12, w / 2 - deep / 2 - 0.06, 0.46, deep / 2, C.beige),
      ];
    }
    case 'lsofa': {
      // The low cream boucle sofa: soft rounded blocks, a low
      // back along the wall, the seat, and at the right end (seen sitting) a raised arm over the
      // whole depth with the chaise beside it.
      const arm = 0.3;
      const back = 0.25;
      const deep = 0.9;
      const chaise = 0.75;
      return [
        soft(w - arm, back, h - 0.07, -arm / 2, -d / 2 + back / 2),
        soft(w - arm, deep - back, 0.42, -arm / 2, -d / 2 + back + (deep - back) / 2),
        soft(chaise, d - deep + 0.02, 0.42, w / 2 - arm - chaise / 2, d / 2 - (d - deep) / 2 - 0.01),
        soft(arm, d, 0.6, w / 2 - arm / 2, 0),
      ];
    }
    case 'roundcoffee': {
      // Black frame with a dark marble top and a lower shelf.
      const p = [cyl(w / 2, w / 2, 0.03, 0, h - 0.03, 0, C.marble, 32), cyl(w / 2 - 0.05, w / 2 - 0.05, 0.02, 0, 0.14, 0, C.black, 32)];
      for (let i = 0; i < 3; i++) p.push(cyl(0.012, 0.012, h - 0.03, Math.cos(i * 2.094) * (w / 2 - 0.06), 0, Math.sin(i * 2.094) * (w / 2 - 0.06), C.black, 6));
      return p;
    }
    case 'ruground':
      // The children's rooms' round rug: a dark aubergine shaggy pile.
      return [cloth(cyl(w / 2, w / 2, 0.015, 0, 0, 0, C.plum, 40))];
    case 'weightbench': {
      // Sit-up bench from the office render: black pad on a white frame, rollers at the low end.
      const pad = new THREE.BoxGeometry(w * 0.72, 0.06, 0.28).rotateZ(0.22).translate(w * 0.1, 0.45, 0);
      const roller = (x: number, y: number) => coloured(new THREE.CylinderGeometry(0.05, 0.05, d, 12).rotateX(Math.PI / 2).translate(x, y, 0), C.black);
      return [
        coloured(pad, C.black),
        box(w * 0.9, 0.06, 0.05, 0, 0, 0, C.white), box(0.06, d - 0.1, 0.05, w * 0.4, 0, 0, C.white),
        box(0.05, 0.05, 0.62, w * 0.38, 0, 0, C.white), box(0.05, 0.05, 0.35, -w * 0.15, 0, 0, C.white), box(0.05, 0.05, h - 0.1, -w / 2 + 0.08, 0, 0, C.white),
        roller(-w / 2 + 0.08, h - 0.08), roller(-w / 2 + 0.08, h - 0.26),
      ];
    }
    case 'smartbike': {
      // Indoor bike for Zwift on a black mat, the rider facing a 43 inch screen on a stand (+z).
      const flywheel = new THREE.CylinderGeometry(0.22, 0.22, 0.08, 20).rotateZ(Math.PI / 2).translate(0, 0.32, -0.15);
      return [
        box(w, 1.4, 0.008, 0, 0, -0.25, C.black),
        box(0.5, 0.08, 0.05, 0, 0, -0.75, C.grey), box(0.5, 0.08, 0.05, 0, 0, 0.3, C.grey),
        box(0.06, 1.1, 0.06, 0, 0.05, -0.22, C.grey),
        box(0.05, 0.05, 0.75, 0, 0.1, -0.5, C.grey), box(0.16, 0.28, 0.05, 0, 0.85, -0.52, C.black),
        box(0.05, 0.05, 0.85, 0, 0.1, 0.2, C.grey), box(0.44, 0.06, 0.03, 0, 0.95, 0.22, C.black),
        coloured(flywheel, C.white), box(0.36, 0.03, 0.03, 0, 0.3, -0.15, C.black),
        box(0.4, 0.3, 0.02, 0, 0, 0.8, C.black), box(0.05, 0.05, 0.95, 0, 0.02, 0.8, C.black),
        box(0.98, 0.035, 0.58, 0, 0.95, 0.78, C.black),
      ];
    }
    case 'gymball':
      return [coloured(new THREE.SphereGeometry(w / 2, 16, 12).translate(0, h / 2, 0), C.black)];
    case 'loungesofa': {
      // Round wicker garden sofa from the video: an oval seat with a curved back, dark cushions.
      const p = [coloured(new THREE.CylinderGeometry(0.5, 0.45, 0.36, 28).scale(w, 1, d).translate(0, 0.18, 0), C.wicker)];
      const rx = w / 2 - 0.07;
      const rz = d / 2 - 0.07;
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * (i / 8);
        const phi = Math.atan2(rz * Math.cos(a), -rx * Math.sin(a));
        const len = (Math.PI * (rx + rz)) / 2 / 8 + 0.06;
        p.push(coloured(new THREE.BoxGeometry(len, h - 0.36, 0.14).rotateY(phi).translate(rx * Math.cos(a), 0.36 + (h - 0.36) / 2, -rz * Math.sin(a)), C.wicker));
      }
      p.push(box(w * 0.66, d * 0.55, 0.1, 0, 0.36, 0.05, C.cushion), box(0.34, 0.12, 0.3, -0.3, 0.42, -d / 2 + 0.24, C.cushion), box(0.34, 0.12, 0.3, 0.3, 0.42, -d / 2 + 0.24, C.cushion));
      return p;
    }
    case 'coffeetable':
      return [box(w, d, 0.04, 0, h - 0.04, 0, C.oak), ...legs(w, d, h - 0.04, 0.04, 0.06, C.black)];
    case 'dining200': case 'dining160': case 'desk':
      return [box(w, d, 0.04, 0, h - 0.04, 0, id === 'desk' ? C.white : C.oak), ...legs(w, d, h - 0.04, 0.06, 0.08, id === 'desk' ? C.metal : C.walnut)];
    case 'roundtable':
      // Light oak on a slim black stem and a flat round foot.
      return [cyl(w / 2, w / 2, 0.03, 0, h - 0.03, 0, C.honey, 32), cyl(0.04, 0.04, h - 0.03, 0, 0, 0, C.black), cyl(0.3, 0.3, 0.015, 0, 0, 0, C.black, 24)];
    case 'chair': {
      // The dining chair: a boucle shell on thin cream steel legs (tools/interior.py).
      const shell = model('ShellChair');
      if (shell) return shell;
      return [box(w - 0.06, d - 0.08, 0.06, 0, 0.41, 0.0, C.boucle), box(w - 0.06, 0.05, 0.36, 0, 0.44, -d / 2 + 0.04, C.boucle), ...legs(w - 0.08, d - 0.08, 0.41, 0.018, 0.02, C.lacquer)];
    }
    case 'terracechair': {
      // The roof terrace chair: grey seat and back on a black frame with arms.
      const chair = model('TerraceChair');
      if (chair) return chair;
      return [box(w - 0.08, d - 0.1, 0.05, 0, 0.4, 0, '#74787d'), box(w - 0.08, 0.04, 0.22, 0, 0.56, -d / 2 + 0.05, '#74787d'), ...legs(w - 0.04, d - 0.04, 0.4, 0.016, 0.02, C.black)];
    }
    case 'officechair': {
      const aeron = model('aeron');
      if (aeron) return aeron;
      return [
        box(0.5, 0.5, 0.08, 0, 0.46, 0, C.black), box(0.46, 0.06, 0.55, 0, 0.55, -0.22, C.black),
        cyl(0.03, 0.03, 0.4, 0, 0.06, 0, C.metal), box(0.6, 0.05, 0.05, 0, 0.03, 0, C.black), box(0.05, 0.6, 0.05, 0, 0.03, 0, C.black),
      ];
    }
    case 'desksetup': {
      // Oak top on a black frame, a black drawer unit at the right, an ultrawide screen and a
      // portrait one, keyboard and mouse on a felt mat, and the small things of a desk in use.
      const top = 0.75;
      const p = [
        box(w, d, 0.03, 0, top - 0.03, 0, C.oak),
        box(0.06, 0.06, top - 0.07, -w / 2 + 0.12, 0.03, -0.05, C.black), box(0.06, 0.06, top - 0.07, w / 2 - 0.5, 0.03, -0.05, C.black),
        box(0.07, d - 0.08, 0.03, -w / 2 + 0.12, 0, -0.05, C.black), box(0.07, d - 0.08, 0.03, w / 2 - 0.5, 0, -0.05, C.black),
        box(w - 0.3, 0.05, 0.05, -0.15, top - 0.09, -0.12, C.black),
        box(0.42, 0.55, 0.62, w / 2 - 0.24, 0.02, -0.05, C.black),
        box(0.38, 0.01, 0.005, w / 2 - 0.24, 0.22, 0.225, C.grey), box(0.38, 0.01, 0.005, w / 2 - 0.24, 0.42, 0.225, C.grey),
        box(0.9, 0.4, 0.004, -0.12, top, 0.1, C.felt),
        box(0.44, 0.14, 0.018, -0.12, top + 0.004, 0.1, C.black), box(0.42, 0.12, 0.012, -0.12, top + 0.012, 0.1, C.keys),
        box(0.065, 0.11, 0.032, 0.3, top + 0.004, 0.12, C.black),
        // Ultrawide on a stand, a light bar on top; a portrait screen beside it, turned in a little.
        box(0.26, 0.18, 0.015, -0.12, top, -0.2, C.black), box(0.06, 0.04, 0.22, -0.12, top, -0.24, C.black),
        box(0.82, 0.04, 0.37, -0.12, top + 0.15, -0.21, C.black), box(0.46, 0.03, 0.022, -0.12, top + 0.522, -0.22, C.black),
        box(0.18, 0.14, 0.015, 0.55, top, -0.18, C.black), box(0.05, 0.04, 0.2, 0.55, top, -0.21, C.black),
        coloured(new THREE.BoxGeometry(0.37, 0.62, 0.035).rotateY(-0.35).translate(0.55, top + 0.12 + 0.31, -0.17), C.black),
        cyl(0.04, 0.04, 0.1, -0.78, top, -0.2, C.mat, 14), cyl(0.004, 0.004, 0.15, -0.79, top + 0.02, -0.2, C.black, 4), cyl(0.004, 0.004, 0.14, -0.77, top + 0.02, -0.19, C.pot, 4),
        box(0.1, 0.1, 0.17, -0.6, top, -0.24, C.black), cyl(0.035, 0.035, 0.002, -0.6, top + 0.11, -0.19, C.grey, 14).rotateX(Math.PI / 2).translate(0, 0.03, 0),
        cyl(0.04, 0.04, 0.09, 0.4, top, -0.02, C.white, 14),
        box(0.16, 0.22, 0.025, 0.78, top, 0.14, '#2f4a6b'), box(0.15, 0.21, 0.022, 0.78, top + 0.025, 0.14, '#c9b27a'), box(0.15, 0.2, 0.02, 0.77, top + 0.047, 0.14, C.black),
        cyl(0.06, 0.07, 0.012, 0.82, top, -0.25, C.black, 16), cyl(0.008, 0.008, 0.26, 0.82, top + 0.01, -0.25, C.black, 6),
        coloured(new THREE.TorusGeometry(0.085, 0.014, 6, 18, Math.PI).translate(0.82, top + 0.2, -0.25), C.felt),
        cyl(0.06, 0.05, 0.1, -0.84, top, 0.18, C.pot, 14),
      ];
      for (let i = 0; i < 4; i++) p.push(coloured(new THREE.IcosahedronGeometry(0.05, 0).translate(-0.84 + Math.cos(i * 1.6) * 0.03, top + 0.14 + i * 0.03, 0.18 + Math.sin(i * 1.6) * 0.03), C.leaf));
      return p;
    }
    case 'shelves': {
      // Two floating oak shelves with a warm light strip under each, books, plants and a speaker.
      const p: Part[] = [];
      for (const y of [1.4, 1.8]) p.push(box(w, d, 0.035, 0, y, 0, C.oak));
      let x = -w / 2 + 0.05;
      const books = ['#2f4a6b', '#d8d2c4', '#3d5c3a', '#c9b27a', '#1f2124', '#8a3b2e'];
      for (let k = 0; k < 7; k++) {
        const bw = 0.025 + (k % 3) * 0.008;
        p.push(box(bw, 0.17, 0.2 + (k % 2) * 0.03, x + bw / 2, 1.835, -0.02, books[k % books.length]));
        x += bw + 0.004;
      }
      p.push(box(0.11, 0.1, 0.16, w / 2 - 0.12, 1.835, -0.02, C.black), box(0.07, 0.07, 0.2, 0.05, 1.435, 0, C.bottle));
      p.push(cyl(0.06, 0.05, 0.1, w / 2 - 0.18, 1.435, 0, C.white, 14), cyl(0.07, 0.06, 0.1, -w / 2 + 0.16, 1.435, 0, C.pot, 14));
      for (let i = 0; i < 9; i++) {
        // A trailing plant over the edge of the lower shelf, a small one on the other end.
        const hang = i < 6;
        const px = hang ? -w / 2 + 0.16 + Math.sin(i * 1.3) * 0.06 : w / 2 - 0.18 + Math.cos(i) * 0.04;
        const py = hang ? 1.5 - i * 0.07 : 1.56 + (i - 6) * 0.03;
        p.push(coloured(new THREE.IcosahedronGeometry(hang ? 0.045 : 0.055, 0).translate(px, py, hang ? 0.09 : 0), C.leaf));
      }
      p.push(box(0.15, 0.015, 0.2, -0.1, 1.435, -0.08, C.black), box(0.12, 0.004, 0.16, -0.1, 1.45, -0.072, C.mat));
      return p;
    }
    case 'slatwall': {
      // Oak slats on black felt, floor to ceiling: 3 cm slats, 5 cm apart.
      const p = [box(w, 0.012, h, 0, 0, -d / 2 + 0.006, C.black)];
      for (let x = -w / 2 + 0.025; x < w / 2 - 0.01; x += 0.05) p.push(box(0.03, 0.025, h, x, 0, -d / 2 + 0.024, C.slat));
      return p;
    }
    case 'print':
      return [box(w, d, h - 1.25, 0, 1.25, 0, C.black)];
    case 'pendants': case 'globes': {
      // Pendant lights hanging from the ceiling (h). The acorns: an oak cap (tools/interior.py) over
      // an opal globe, on light cords, in three sizes; the globes: clear glass with a black cap. The
      // lit and glass parts are drawn as extras.
      const p = [box(0.14, 0.14, 0.015, 0, h - 0.015, 0, C.white)];
      for (const [x, z, y, r] of LAMPS[id]) {
        if (id === 'pendants') {
          p.push(cyl(0.003, 0.003, h - y - r * 1.4, x, y + r * 1.4, z, '#d8d4cc', 4));
          p.push(...(model('AcornCap', x, y, z, 0, r) ?? [cyl(r * 0.6, r * 1.1, r * 1.1, x, y, z, C.oak, 14)]));
        } else {
          p.push(cyl(0.003, 0.003, h - y - r - 0.03, x, y + r + 0.03, z, C.black, 4), cyl(0.024, 0.03, 0.05, x, y + r * 0.92 - 0.01, z, C.black, 12));
        }
      }
      return p;
    }
    case 'tracklight': {
      // A black ceiling track with three spots tilted down (Yoshi's mood board).
      const p = [box(w, 0.035, 0.03, 0, h - 0.03, 0, C.black)];
      for (const [x, tilt] of TRACK) {
        p.push(box(0.03, 0.03, 0.06, x, h - 0.09, 0, C.black));
        p.push(coloured(new THREE.CylinderGeometry(0.032, 0.032, 0.11, 14).rotateX(tilt).translate(x, h - 0.14, Math.sin(tilt) * 0.05), C.black));
      }
      return p;
    }
    case 'rattandome': {
      // The wide, flat open-weave shade (tools/interior.py), its lattice see-through.
      const woven = model('RattanShade', 0, h, 0);
      if (woven) return woven;
      // A woven rattan dome, open below: the outside and the inside of the shell.
      const shell = (r: number, flip: boolean) => {
        const g = new THREE.SphereGeometry(r, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
        if (flip) {
          const pos = g.attributes.position.array as Float32Array;
          for (let i = 0; i < pos.length; i += 9) for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
          g.computeVertexNormals();
        }
        return coloured(g.translate(0, h - 0.55, 0), flip ? '#7d6243' : '#b38b5d');
      };
      return [shell(w / 2, false), shell(w / 2 - 0.01, true), cyl(0.005, 0.005, 0.35, 0, h - 0.35, 0, C.black, 4), box(0.12, 0.12, 0.015, 0, h - 0.015, 0, C.white)];
    }
    case 'rugjute':
      return [cyl(w / 2, w / 2, 0.012, 0, 0, 0, C.juteEdge, 48), cyl(w / 2 - 0.08, w / 2 - 0.08, 0.016, 0, 0, 0, C.jute, 48)];
    case 'bookcase': {
      const p = [box(0.02, d, h, -w / 2 + 0.01, 0, 0, C.walnut), box(0.02, d, h, w / 2 - 0.01, 0, 0, C.walnut), box(w, 0.01, h, 0, 0, -d / 2 + 0.005, C.walnut)];
      const books = ['#8a3b2e', '#2f4a6b', '#c9b27a', '#3d5c3a', '#6b4a6b', '#d8d2c4'];
      for (let s = 0; s < 5; s++) {
        const y = s * (h / 5);
        p.push(box(w, d, 0.02, 0, y, 0, C.walnut));
        let x = -w / 2 + 0.03;
        for (let k = 0; x < w / 2 - 0.08 && s > 0; k++) {
          const bw = 0.03 + ((k * 7 + s * 3) % 4) * 0.01;
          p.push(box(bw, d - 0.06, 0.22 + ((k * 5 + s) % 3) * 0.03, x + bw / 2, y + 0.02, 0.01, books[(k + s * 2) % books.length]));
          x += bw + 0.005;
        }
      }
      p.push(box(w, d, 0.02, 0, h - 0.02, 0, C.walnut));
      return p;
    }
    case 'bookwall': {
      // Built in from floor to ceiling: oak uprights about 80 cm apart and shelves about 34 cm
      // apart, a dark back, books of every size and colour (no titles), here and there a stack
      // lying flat, a storage box or a vase, and a book leaning at the end of a row.
      const t = 0.025;
      const kick = 0.08;
      const bays = Math.max(1, Math.round(w / 0.8));
      const bay = (w - t) / bays;
      const rows = Math.max(1, Math.round((h - kick) / 0.34));
      const pitch = (h - kick - t) / rows;
      const p = [box(w, 0.012, h, 0, 0, -d / 2 + 0.006, '#5b4330'), box(w, d - 0.03, kick, 0, 0, -0.015, C.oak)];
      for (let i = 0; i <= bays; i++) p.push(box(t, d, h - kick, -w / 2 + t / 2 + i * bay, kick, 0, C.oak));
      for (let r = 0; r <= rows; r++) p.push(box(w, d, t, 0, kick + r * pitch, 0, C.oak));
      const spines = ['#7a2e2a', '#24364f', '#2f4a3a', '#b8925a', '#e3dccb', '#2b2b2d', '#a4553a', '#5d6f86', '#f0ece2', '#6b4a33', '#8c8f6a', '#c7b9a0', '#3e2f4a', '#d9a441'];
      let seed = 11;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const front = d / 2 - 0.015;
      for (let i = 0; i < bays; i++) {
        for (let r = 0; r < rows; r++) {
          const x0 = -w / 2 + t + i * bay + 0.01;
          const x1 = x0 + bay - t - 0.02;
          const y = kick + r * pitch + t;
          const room = pitch - t;
          let x = x0;
          const kind = rnd();
          if (kind < 0.16) {
            // A stack lying flat at the start of the row.
            const sw = 0.2 + rnd() * 0.08;
            let sy = y;
            for (let k = 0, n = 3 + Math.floor(rnd() * 3); k < n; k++) {
              const th = 0.025 + rnd() * 0.025;
              const sd = 0.15 + rnd() * 0.06;
              p.push(box(sw - k * 0.012, sd, th, x + sw / 2, sy, front - sd / 2, spines[Math.floor(rnd() * spines.length)]));
              sy += th;
            }
            x += sw + 0.04;
          } else if (kind < 0.24) {
            p.push(box(0.26, 0.24, Math.min(room - 0.04, 0.2), x + 0.13, y, front - 0.12, rnd() < 0.5 ? '#d8d2c4' : '#3b3b3d')); // a box
            x += 0.3;
          } else if (kind < 0.3) {
            p.push(cyl(0.05, 0.065, Math.min(room - 0.04, 0.22), x + 0.08, y, front - 0.1, rnd() < 0.5 ? '#c8643f' : '#e9e4da', 12)); // a vase
            x += 0.18;
          }
          const fill = x1 - (kind > 0.85 ? 0.12 + rnd() * 0.15 : 0); // some rows end in a gap
          while (x < fill - 0.02) {
            const bw = Math.min(fill - x, 0.018 + rnd() * 0.04);
            const bh = Math.min(room - 0.03, 0.17 + rnd() * 0.14);
            const bd = 0.14 + rnd() * 0.09;
            p.push(box(bw, bd, bh, x + bw / 2, y, front - bd / 2, spines[Math.floor(rnd() * spines.length)]));
            x += bw + 0.002;
          }
          if (x1 - x > 0.1) {
            // One book leaning against the last one.
            const bh = Math.min(room - 0.05, 0.22);
            const lean = 0.35;
            p.push(coloured(new THREE.BoxGeometry(0.03, bh, 0.17).translate(0.015, bh / 2, 0).rotateZ(-lean).translate(x + 0.005 + Math.sin(lean) * bh, y, front - 0.085), spines[Math.floor(rnd() * spines.length)]));
          }
        }
      }
      return p;
    }
    case 'jacuzzi': {
      // A square hot tub: a cabinet of grey composite boards, a white shell inside a light rim,
      // the water 17 cm below the top, headrests in the corners and a step in front.
      const rim = 0.16;
      const wall = '#4b4744';
      const shell = '#eef1f2';
      const top = '#d8d5cf';
      const wl = h - 0.17;
      const p = [box(w, d, wl, 0, 0, 0, wall), box(w - 2 * rim, d - 2 * rim, 0.015, 0, wl, 0, '#4fa7bb')];
      for (const s of [-1, 1]) {
        p.push(box(w, 0.03, 0.11, 0, wl, s * (d / 2 - 0.015), wall), box(0.03, d, 0.11, s * (w / 2 - 0.015), wl, 0, wall));
        p.push(box(w - 0.06, rim - 0.03, 0.11, 0, wl, s * (d / 2 - 0.03 - (rim - 0.03) / 2), shell));
        p.push(box(rim - 0.03, d - 0.06, 0.11, s * (w / 2 - 0.03 - (rim - 0.03) / 2), wl, 0, shell));
        p.push(box(w + 0.02, rim + 0.01, 0.06, 0, h - 0.06, s * (d / 2 - rim / 2), top), box(rim + 0.01, d - 2 * rim, 0.06, s * (w / 2 - rim / 2), h - 0.06, 0, top));
        for (const k of [-1, 1]) p.push(box(0.3, 0.09, 0.13, k * (w / 2 - rim - 0.2), h - 0.2, s * (d / 2 - rim - 0.045), '#2e2c2b')); // headrests
      }
      for (let k = 1; k < 8; k++) for (const s of [-1, 1]) {
        p.push(box(0.01, 0.004, wl - 0.04, -w / 2 + (k * w) / 8, 0.02, s * (d / 2 + 0.002), '#3a3735')); // board joints
        p.push(box(0.004, 0.01, wl - 0.04, s * (w / 2 + 0.002), 0.02, -d / 2 + (k * d) / 8, '#3a3735'));
      }
      p.push(box(0.9, 0.36, 0.22, 0, 0, d / 2 + 0.18, wall), box(0.16, 0.1, 0.012, w / 2 - rim - 0.25, h, d / 2 - rim / 2, '#151617')); // step, control panel
      return p;
    }
    case 'tvunit': {
      // A white handle-less lowboard, the 75 inch TV on the wall above it, and the white
      // soundbar on the wall under the TV. The back of the piece is against the wall.
      const wall = -d / 2 - 0.029;
      const p = [
        box(w, d, 0.4, 0, 0.06, 0, C.lacquer), ...legs(w, d, 0.06, 0.03, 0.08, C.black),
        box(w - 0.02, 0.004, 0.36, 0, 0.08, d / 2, '#d9d5ce'),
        box(1.665, 0.03, 0.96, 0, 0.72, wall + 0.045, C.black), box(0.4, 0.03, 0.3, 0, 1.05, wall + 0.015, C.black),
      ];
      return [...p, ...(model('soundbar', 0, 0.62, wall) ?? [box(1.14, 0.11, 0.087, 0, 0.577, wall + 0.06, C.lacquer)])];
    }
    case 'rug200': {
      // The living room rug: soft rings and swirls in sand, taupe and grey.
      const sand = col('#c4b6a2');
      const taupe = col('#86786a');
      const grey = col('#aaa6a0');
      return [
        box(w, d, 0.01, 0, 0, 0, '#7d7166'),
        floorSurface(w - 0.02, d - 0.02, 0.013, 22, 33, (u, v) => {
          const x = u * w;
          const z = v * d;
          const a = Math.sin(Math.hypot(x - 0.55, z - 0.85) * 17 + Math.sin(z * 3) * 1.6);
          const b = Math.sin(Math.hypot(x - 1.55, z - 2.25) * 14 + Math.cos(x * 4) * 1.2);
          const t = Math.max(0, 0.5 + 0.3 * a + 0.3 * b - 0.3);
          return sand.clone().lerp(taupe, Math.min(1, t)).lerp(grey, 0.3 * (0.5 + 0.5 * Math.sin(x * 6 + z * 4)));
        }),
      ];
    }
    case 'rug160': {
      // The main bedroom's rug: a grey shaggy one, flecked light and dark.
      return [cloth(box(w, d, 0.015, 0, 0, 0, '#7a7b7f'))];
    }
    case 'washer':
      return [box(w, d, h, 0, 0, 0, C.white), cyl(0.2, 0.2, 0.02, 0, 0, 0, C.screen, 24).rotateX(Math.PI / 2).translate(0, 0.45, d / 2), box(w, 0.02, 0.1, 0, h - 0.12, d / 2, C.metal)];
    case 'floorlamp':
      return [cyl(0.15, 0.15, 0.03, 0, 0, 0, C.black, 20), cyl(0.015, 0.015, h - 0.3, 0, 0.03, 0, C.black, 8), cyl(0.2, 0.13, 0.3, 0, h - 0.3, 0, C.shade, 20)];
    case 'oval220': {
      // The table: a walnut top shaped like a running track (straight long sides, round
      // ends) with a routed line of the same shape, on a long foot of that shape in a warmer wood; on
      // it eucalyptus in a tall glass vase and a candle (tools/interior.py).
      const slab = (l: number, b: number, t: number, y: number) =>
        new THREE.ExtrudeGeometry(track(l, b), { depth: t, bevelEnabled: false, curveSegments: 12 }).rotateX(-Math.PI / 2).translate(0, y, 0);
      const ring = track(w - 0.24, d - 0.2);
      ring.holes.push(track(w - 0.264, d - 0.224));
      const line = new THREE.ShapeGeometry(ring, 12).rotateX(-Math.PI / 2).translate(0, h + 0.0012, 0);
      return [coloured(slab(w, d, 0.04, h - 0.04), C.tableTop), coloured(slab(w * 0.45, d * 0.4, h - 0.04, 0), C.tableFoot), coloured(line, C.inlay),
        ...(model('Eucalyptus', 0.12, h, 0.02, 0.4) ?? [])];
    }
    case 'dresser': case 'lowdresser': {
      // Handle-less fronts on a plinth set back a little: three
      // drawers with fine shadow gaps; the walnut chest is two such units side by side.
      const body = id === 'dresser' ? C.lacquer : C.walnut;
      const gap = id === 'dresser' ? '#c9c4bb' : '#4a3322';
      const base = 0.05;
      const p = [box(w, d, h - base, 0, base, 0, body), box(w - 0.05, d - 0.05, base, 0, 0, -0.01, gap)];
      for (let r = 1; r < 3; r++) p.push(box(w - 0.02, 0.006, 0.006, 0, base + ((h - base) / 3) * r, d / 2, gap));
      if (id === 'lowdresser') p.push(box(0.006, 0.006, h - base - 0.02, 0, base + 0.01, d / 2, gap));
      if (id === 'dresser') {
        // The oval mirror on the wall above it (its glass is an extra), a tray, a blue bottle, a small
        // speaker and a book on top.
        p.push(coloured(new THREE.ShapeGeometry(pebble(0.3, 0.46), 40).translate(-0.18, 1.5, -d / 2 + 0.004), '#d9d6d0'));
        p.push(box(0.34, 0.2, 0.012, 0.22, h, 0.02, '#ece8e1'), cyl(0.028, 0.026, 0.13, 0.3, h + 0.012, 0.03, '#3f86b8', 12));
        p.push(box(0.08, 0.08, 0.11, 0.16, h + 0.012, 0.0, C.black), box(0.22, 0.16, 0.03, -0.38, h, 0.03, '#2f4a6b'), box(0.2, 0.15, 0.02, -0.38, h + 0.03, 0.03, '#d9a441'));
      } else {
        // Books, a small speaker and a blue vase on the walnut chest.
        p.push(box(0.22, 0.15, 0.06, -0.55, h, 0, '#2b2b2d'), box(0.2, 0.14, 0.03, -0.55, h + 0.06, 0, '#d9a441'));
        p.push(box(0.12, 0.09, 0.07, 0.02, h, 0, '#f0eee9'), box(0.12, 0.091, 0.045, 0.02, h + 0.07, 0, C.black));
        p.push(cyl(0.035, 0.028, 0.14, 0.17, h, 0.02, '#3f8fb5', 12), box(0.22, 0.15, 0.05, 0.58, h, 0, '#24364f'), box(0.2, 0.14, 0.025, 0.58, h + 0.05, 0, '#e3dccb'));
      }
      return p;
    }
    case 'kidsdesk': {
      // The playroom's long low desk in pale ash: at its left end open shelves
      // under the top and one open box standing on it, the top running on to a panel leg in the
      // middle and one at the right end.
      const t = 0.025;
      const x0 = -w / 2;
      const x1 = x0 + 0.75; // the shelves under the top
      const p = [
        box(w, d, t, 0, h - t, 0, C.ash),
        box(t, d, h - t, x0 + t / 2, 0, 0, C.ash), box(t, d, h - t, x1 - t / 2, 0, 0, C.ash),
        box(0.75, d, t, x0 + 0.375, 0, 0, C.ash), box(0.75 - 2 * t, d - 0.02, t, x0 + 0.375, (h - t) / 2, -0.01, C.ash),
        box(t, d, h - t, 0.25, 0, 0, C.ash), box(t, d, h - t, w / 2 - t / 2, 0, 0, C.ash),
        box(t, d, 0.4, x0 + t / 2, h, 0, C.ash), box(t, d, 0.4, x0 + 0.45 - t / 2, h, 0, C.ash), box(0.45, d, t, x0 + 0.225, h + 0.4 - t, 0, C.ash),
      ];
      // Pencil pots and a sheet of paper on top, books and magazines on the shelves.
      const pencils = ['#d23b3b', '#3b6fd2', '#f2c14e', '#3f9b5a', '#e07b39'];
      for (const x of [-0.45, 0.65]) {
        p.push(cyl(0.035, 0.035, 0.09, x, h, -0.1, '#e9e5dc', 14));
        pencils.forEach((c, k) => p.push(cyl(0.004, 0.004, 0.16, x + Math.cos(k * 1.3) * 0.018, h + 0.01, -0.1 + Math.sin(k * 1.3) * 0.018, c, 5)));
      }
      p.push(box(0.3, 0.21, 0.002, 0.1, h, 0.04, '#fbfaf6'), box(0.13, 0.008, 0.008, 0.18, h + 0.002, 0.04, '#3b6fd2'));
      p.push(box(0.28, 0.2, 0.05, x0 + 0.2, t, 0.04, '#2b2b2d'), box(0.26, 0.19, 0.03, x0 + 0.2, t + 0.05, 0.04, '#3d5c3a'), box(0.25, 0.2, 0.025, x0 + 0.21, t + 0.08, 0.04, '#e3dccb'));
      p.push(box(0.3, 0.22, 0.015, x0 + 0.52, t, 0.05, '#a4553a'), box(0.29, 0.21, 0.012, x0 + 0.53, t + 0.015, 0.05, '#5d6f86'));
      p.push(...bookRow(x0 + 0.04, x1 - 0.1, (h - t) / 2 + t, d / 2 - 0.02, 3, ['#8a3b2e', '#24364f', '#e3dccb', '#3d5c3a', '#c9b27a'], 0.22));
      p.push(...bookRow(x0 + 0.04, x0 + 0.3, h, d / 2 - 0.02, 5, ['#2b2b2d', '#f0ece2', '#3d5c3a', '#2b2b2d'], 0.28), box(0.2, 0.14, 0.05, x0 + 0.225, h + 0.4, 0, '#1f2124'));
      return p;
    }
    case 'kidstable': {
      // A children's activity table: pink top, green rim and legs, a few toys.
      const p = [box(w, d, 0.03, 0, h - 0.03, 0, '#e8cbc2'), box(w + 0.02, d + 0.02, 0.014, 0, h - 0.044, 0, '#7cae8a'), ...legs(w, d, h - 0.044, 0.035, 0.05, '#7cae8a'), box(w - 0.1, 0.025, 0.03, 0, 0.15, 0, '#d8915e')];
      ['#e05a47', '#f2c14e', '#3f9b5a', '#3b6fd2'].forEach((c, i) => p.push(cyl(0.05 - i * 0.008, 0.05 - i * 0.008, 0.016, -0.13, h + i * 0.016, 0.1, c, 16)));
      p.push(cyl(0.006, 0.006, 0.09, -0.13, h, 0.1, '#d8915e', 6), box(0.05, 0.05, 0.05, 0.12, h, -0.06, '#e05a47'), box(0.05, 0.05, 0.05, 0.18, h, -0.02, '#f2c14e'), box(0.05, 0.05, 0.05, 0.15, h + 0.05, -0.04, '#3b6fd2'));
      return p;
    }
    case 'kidschair': {
      // A spindle-back children's chair in light wood.
      const seat = 0.3;
      const back = -d / 2 + 0.03;
      const p = [box(w, d - 0.02, 0.025, 0, seat - 0.025, 0.01, C.oak), ...legs(w, d - 0.02, seat - 0.025, 0.025, 0.02, C.oak).map((g) => g.translate(0, 0, 0.01))];
      for (const sx of [-1, 1]) p.push(cyl(0.012, 0.012, h - seat, sx * (w / 2 - 0.025), seat, back, C.oak, 8));
      p.push(box(w, 0.03, 0.045, 0, h - 0.045, back, C.oak));
      for (const x of [-0.06, 0, 0.06]) p.push(cyl(0.006, 0.006, h - seat - 0.045, x, seat, back, C.oak, 6));
      return p;
    }
    case 'pouf': {
      // Stacked soft rolls in dark taupe.
      const r = h / 8;
      const p = [cloth(cyl(w / 2 - r, w / 2 - r, h - 0.02, 0, 0.01, 0, C.ring, 24))];
      for (let i = 0; i < 4; i++) p.push(cloth(coloured(new THREE.TorusGeometry(w / 2 - r, r, 7, 20).rotateX(Math.PI / 2).translate(0, r + i * 2 * r, 0), C.ring)));
      return p;
    }
    case 'bench':
      return [box(w, d, h - 0.08, 0, 0, 0, C.oak), box(w - 0.04, d - 0.04, 0.08, 0, h - 0.08, 0, C.beige)];
    // ---- Built in (fixtures from the house data, not in the planner)
    case 'curtain': {
      // A sheer curtain gathered beside a window: soft, uneven folds about
      // 12 cm apart from just over the floor to a white track under the ceiling, the deeper folds a
      // shade darker, the fabric a little fuller towards the hem.
      const waves = Math.max(2, Math.round(w / 0.12));
      const amp = d / 2 - 0.02;
      const top = h - 0.035;
      const light = col(C.sheer);
      const fold = light.clone().multiplyScalar(0.9);
      const phase = w * 7.3; // each width of curtain falls a little differently
      const wave = (u: number) => 0.72 * Math.sin(u * waves * Math.PI * 2) + 0.28 * Math.sin(u * waves * Math.PI * 0.94 + phase);
      return [
        surface(waves * 6, 1, (u, v) => [-w / 2 + u * w, 0.012 + v * (top - 0.012), amp * wave(u) * (1.15 - 0.3 * v)], (u) => fold.clone().lerp(light, 0.5 + 0.5 * wave(u)), true),
        box(w + 0.06, 0.04, 0.035, 0, top, 0, C.white),
      ];
    }
    case 'relief': {
      // Textured plaster art in a thin black frame: combed
      // lines down the canvas and combed arcs round a lower corner, all off-white, so only the light
      // on the ridges draws it. Square, w wide, its top at h.
      const s = w - 0.04;
      const y0 = h - w;
      const plaster = col('#ece8e1');
      const shade = col('#cfc8bd');
      const relief = (u: number, v: number) => {
        const x = u * s;
        const y = v * s;
        const r = Math.hypot(x - 0.1, y - 0.08);
        if (r < 0.6) return Math.sin(r * 80) * Math.min(1, (0.6 - r) / 0.05);
        return 0.8 * Math.sin(x * 100 + 2.4 * Math.sin(y * 7 + x * 2)) + 0.2 * Math.sin(y * 31);
      };
      return [
        box(w, d, 0.02, 0, y0, 0, C.black), box(w, d, 0.02, 0, h - 0.02, 0, C.black),
        box(0.02, d, w - 0.04, -w / 2 + 0.01, y0 + 0.02, 0, C.black), box(0.02, d, w - 0.04, w / 2 - 0.01, y0 + 0.02, 0, C.black),
        surface(36, 36, (u, v) => [-s / 2 + u * s, y0 + 0.02 + v * s, 0.006 + 0.004 * relief(u, v)], (u, v) => shade.clone().lerp(plaster, 0.6 + 0.4 * relief(u, v))),
      ];
    }
    case 'llama':
      return []; // only the picture itself (an extra)
    case 'painting': {
      // A canvas on the wall, w wide, its top at h; the paint is the 'painting' extra.
      const ch = w * 1.3;
      return [box(w, d, ch, 0, h - ch, 0, '#f4f2ee')];
    }
    case 'cushion': case 'cushiongrey': {
      // Cushions leaning back against the glass behind the window seat: mustard and white bands in arcs, or a grey knit.
      const mustard = col(C.mustard);
      const white = col('#f3efe6');
      const grey = col('#8b8d90');
      const knit = col('#a9abad');
      const paint = id === 'cushion'
        ? (x: number, y: number) => ((Math.hypot(x + w * 0.7, y + h * 0.8) / 0.08) % 1 < 0.5 ? mustard : white)
        : (x: number, y: number) => grey.clone().lerp(knit, hash(x, y, 1.3));
      return [cloth(cushion(w, h, d, paint).rotateX(-0.32).translate(0, (h / 2) * Math.cos(0.32) + 0.03, 0))];
    }
    case 'books':
      // Two books lying on the window seat.
      return [box(0.24, 0.17, 0.028, 0, 0, 0, '#1f2a44'), coloured(new THREE.BoxGeometry(0.21, 0.024, 0.15).rotateY(0.3).translate(0.05, 0.04, 0.0), '#262628'), box(0.2, 0.15, 0.002, 0.24, 0, 0.02, '#d9a441')];
    case 'speaker':
      // A ceiling speaker in its 30 cm recess (lighting plan: "uitsparing plafond boxen"), h is the ceiling.
      return [cyl(0.15, 0.15, 0.004, 0, h - 0.004, 0, '#f2f1ee', 20), cyl(0.132, 0.132, 0.002, 0, h - 0.006, 0, '#cdccc8', 20)];
    case 'islandlamps': {
      // A white rail on the ceiling over the island (lighting plan: "rail verlichting") with the two
      // sage pendants of the render keuken_000, their shades 1 m under it (tools/interior.py).
      const p = [box(w, 0.04, 0.03, 0, h - 0.03, 0, C.white)];
      for (const x of ISLAND) p.push(...(model('StepLamp', x, h - 0.03, 0) ?? [cyl(0.11, 0.11, 0.2, x, h - 1.03, 0, '#b7b58f', 20), cyl(0.003, 0.003, 0.8, x, h - 0.83, 0, C.black, 4)]));
      return p;
    }
    case 'domelamp':
      // The black dome pendant over the foot of the main bed.
      return model('DomeLamp', 0, h, 0) ?? [cyl(0.21, 0.05, 0.25, 0, h - 0.85, 0, C.black, 24), cyl(0.003, 0.003, 0.6, 0, h - 0.6, 0, C.black, 4)];
    case 'barstool':
      // The island's counter stools in light ash.
      return model('BarStool') ?? [cyl(0.18, 0.18, 0.035, 0, 0.62, 0, '#d6b38c', 20), cyl(0.025, 0.025, 0.62, 0, 0, 0, '#d6b38c', 8), cyl(0.2, 0.2, 0.02, 0, 0, 0, '#d6b38c', 16)];
    case 'cubeshelves': {
      // Three open white boxes on the wall over the chest of drawers: books in the
      // top one, a paper garland in the middle one. Their top at h.
      const t = 0.018;
      const open = (bw: number, bh: number, x: number, y: number): Part[] => [
        box(bw, d, t, x, y, 0, C.white), box(bw, d, t, x, y + bh - t, 0, C.white),
        box(t, d, bh - 2 * t, x - bw / 2 + t / 2, y + t, 0, C.white), box(t, d, bh - 2 * t, x + bw / 2 - t / 2, y + t, 0, C.white),
      ];
      const p = [...open(0.42, 0.27, 0.14, h - 0.27), ...open(0.33, 0.25, -0.3, h - 0.62), ...open(0.27, 0.2, 0.22, h - 0.72)];
      p.push(...bookRow(0.2, 0.33, h - 0.27 + t, d / 2 - 0.01, 5, ['#2b2b2d', '#e3dccb', '#8a3b2e', '#24364f', '#f0ece2'], 0.21));
      for (let k = 0; k < 4; k++) p.push(coloured(new THREE.BoxGeometry(0.055, 0.004, 0.09).rotateZ(k % 2 ? 0.75 : -0.75).translate(-0.39 + k * 0.055, h - 0.62 + t + 0.035, 0), '#b8653f'));
      return p;
    }
    case 'wallshelf':
      // A floating oak shelf full of books over the playroom desk, at height h.
      return [box(w, d, 0.035, 0, h, 0, C.oak), ...bookRow(-w / 2 + 0.03, w / 2 - 0.2, h + 0.035, d / 2 - 0.01, 9, ['#f0ece2', '#2b2b2d', '#e3dccb', '#a33a32', '#f0ece2', '#24364f'], 0.24)];
    case 'traintrack': {
      // A wooden toy railway on the playroom floor: a bean-shaped loop of track
      // with its two grooves, a little train and a few trees.
      const p: Part[] = [];
      const at = (t: number): [number, number] => [Math.cos(t) * w * 0.45 * (1 + 0.1 * Math.cos(2 * t)), Math.sin(t) * d * 0.4 - 0.08 * d * Math.cos(2 * t)];
      const n = 36;
      for (let i = 0; i < n; i++) {
        const [ax, az] = at((i / n) * Math.PI * 2);
        const [bx, bz] = at(((i + 1) / n) * Math.PI * 2);
        const len = Math.hypot(bx - ax, bz - az);
        const turn = Math.atan2(-(bz - az), bx - ax);
        const seg = (wd: number, ht: number, y: number, off: number, c: string) =>
          coloured(new THREE.BoxGeometry(len + 0.004, ht, wd).translate(0, y + ht / 2, off).rotateY(turn).translate((ax + bx) / 2, 0, (az + bz) / 2), c);
        p.push(seg(0.04, 0.012, 0, 0, '#cfa676'), seg(0.006, 0.001, 0.012, 0, '#8e6c46'));
      }
      ['#d84a3a', '#3b6fd2', '#3f9b5a'].forEach((c, k) => {
        const [x, z] = at(0.5 + k * 0.13);
        const [x2, z2] = at(0.5 + k * 0.13 + 0.01);
        p.push(coloured(new THREE.BoxGeometry(0.075, 0.04, 0.035).translate(0, 0.034, 0).rotateY(Math.atan2(-(z2 - z), x2 - x)).translate(x, 0, z), c));
      });
      for (const [x, z] of [[-0.2, 0.05], [0.15, -0.1], [0.32, 0.12], [-0.45, -0.25], [0.55, -0.3]] as const) {
        p.push(cyl(0.025, 0.025, 0.01, x, 0, z, '#cfa676', 10), coloured(new THREE.ConeGeometry(0.025, 0.07, 8).translate(x, 0.045, z), '#3f6b3a'));
      }
      return p;
    }
    case 'plant': case 'ficus': {
      // The kentia palm in its ribbed brass pot, the ficus in its
      // silver pot by the kitchen glass; tools/interior.py.
      const grown = model(id === 'plant' ? 'Kentia' : 'Ficus');
      if (grown) return grown;
      const p = [cyl(0.15, 0.19, 0.32, 0, 0, 0, C.pot, 16)];
      for (let i = 0; i < 7; i++) {
        const a = i * 2.4;
        p.push(coloured(new THREE.IcosahedronGeometry(0.16 + (i % 3) * 0.03, 0).translate(Math.cos(a) * 0.12, 0.45 + i * 0.1, Math.sin(a) * 0.12), C.leaf));
      }
      return p;
    }
  }
  return [box(w, d, h, 0, 0, 0, C.grey)];
}

// Where the globes of the pendant lights hang: x, z, height of the globe's centre above the floor,
// its radius. The acorns in three sizes at different heights.
const TRACK: [number, number][] = [[-0.5, 0.5], [0.05, -0.4], [0.55, 0.45]]; // spots on the track: x, tilt
const LAMPS: Record<string, [number, number, number, number][]> = {
  pendants: [[-0.46, 0.08, 1.45, 0.115], [-0.22, -0.1, 1.86, 0.075], [0.02, 0.1, 1.62, 0.1], [0.25, -0.08, 1.98, 0.07], [0.47, 0.05, 1.52, 0.105]],
  globes: [[-0.22, 0.05, 1.72, 0.12], [0.04, -0.14, 1.9, 0.12], [0.24, 0.12, 1.62, 0.12]],
};
const ISLAND = [-0.5, 0.5]; // the island pendants along their rail

/** The outline of a running track, l long (x) and b wide: straight sides and half-round ends (the dining table). */
function track(l: number, b: number): THREE.Shape {
  const a = (l - b) / 2;
  const r = b / 2;
  const s = new THREE.Shape();
  s.moveTo(-a, -r);
  s.lineTo(a, -r);
  s.absarc(a, 0, r, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-a, r);
  s.absarc(-a, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
  return s;
}

/** An egg-shaped outline, wider below (the bedroom mirror), rx by ry round its centre. */
function pebble(rx: number, ry: number): THREE.Shape {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    pts.push(new THREE.Vector2(rx * Math.cos(t) * (1 - 0.13 * Math.sin(t)) + 0.012 * Math.sin(2 * t), ry * Math.sin(t)));
  }
  return new THREE.Shape(pts);
}

/** A clear glass globe, a little squarer than a ball. */
function bubble(r: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 16, 12);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / r;
    const y = p.getY(i) / r;
    const z = p.getZ(i) / r;
    const k = 1 + 0.45 * (1 / Math.cbrt(Math.abs(x) ** 3 + Math.abs(y) ** 3 + Math.abs(z) ** 3) - 1);
    p.setXYZ(i, x * r * k, y * r * k * 0.94, z * r * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Screens, light strips, lamps and glass on a piece, in its own frame (front +z): what they show, size, where, turn. */
type Show = 'ride' | 'desktop' | 'code' | 'off' | 'print' | 'glow' | 'wash' | 'lamp' | 'glass' | 'painting' | 'mirror' | 'llama';
interface Extra { show: Show; w: number; h: number; x: number; y: number; z: number; ry?: number; geo?: () => THREE.BufferGeometry }

function extras(id: string, [w, d, h]: [number, number, number]): Extra[] {
  switch (id) {
    case 'smartbike': // faces the rider (towards -z)
      return [{ show: 'ride', w: 0.94, h: 0.54, x: 0, y: 1.24, z: 0.761, ry: Math.PI }];
    case 'tvunit':
      return [{ show: 'off', w: 1.645, h: 0.94, x: 0, y: 1.2, z: -d / 2 - 0.029 + 0.0605 }];
    case 'desksetup':
      return [
        { show: 'desktop', w: 0.79, h: 0.34, x: -0.12, y: 0.75 + 0.335, z: -0.189 },
        { show: 'code', w: 0.34, h: 0.58, x: 0.55 + Math.sin(-0.35) * 0.019, y: 0.75 + 0.43, z: -0.17 + Math.cos(-0.35) * 0.019, ry: -0.35 },
        { show: 'glow', w: 0.42, h: 0.006, x: -0.12, y: 0.75 + 0.519, z: -0.21 },
      ];
    case 'shelves':
      return [1.4, 1.8].flatMap((y) => [
        { show: 'glow' as Show, w: w - 0.04, h: 0.008, x: 0, y: y - 0.006, z: d / 2 - 0.03 },
        { show: 'wash' as Show, w: w + 0.2, h: 0.45, x: 0, y: y - 0.23, z: -d / 2 + 0.003 },
      ]);
    case 'slatwall':
      return [{ show: 'glow', w: 0.018, h: 1.7, x: -w / 2 + 0.07, y: 1.1, z: -d / 2 + 0.04 }];
    case 'print':
      return [{ show: 'print', w: 0.56, h: 0.76, x: 0, y: 1.65, z: d / 2 + 0.001 }];
    case 'pendants':
      return LAMPS[id].map(([x, z, y, r]) => ({ show: 'lamp' as Show, w: r * 0.99, h: 0, x, y, z }));
    case 'globes':
      return LAMPS[id].flatMap(([x, z, y, r]) => [
        { show: 'glass' as Show, w: r, h: 0, x, y, z, geo: () => bubble(r) },
        { show: 'lamp' as Show, w: 0.028, h: 0, x, y: y + 0.02, z },
      ]);
    case 'rattandome':
      return [{ show: 'lamp', w: 0.06, h: 0, x: 0, y: h - 0.47, z: 0 }];
    case 'domelamp':
      return [{ show: 'lamp', w: 0.05, h: 0, x: 0, y: h - 0.79, z: 0 }];
    case 'islandlamps':
      return ISLAND.map((x) => ({ show: 'lamp' as Show, w: 0.045, h: 0, x, y: h - 0.03 - 0.95, z: 0 }));
    case 'painting':
      return [{ show: 'painting', w: w - 0.004, h: w * 1.3 - 0.004, x: 0, y: h - (w * 1.3) / 2, z: d / 2 + 0.001 }];
    case 'llama':
      return [{ show: 'llama', w, h: w * 1.3, x: 0, y: h - (w * 1.3) / 2, z: d / 2 + 0.001 }];
    case 'dresser':
      return [{ show: 'mirror', w: 0, h: 0, x: -0.18, y: 1.5, z: -d / 2 + 0.008, geo: () => new THREE.ShapeGeometry(pebble(0.28, 0.44), 40) }];
    case 'tracklight':
      return TRACK.map(([x, tilt]) => ({ show: 'lamp' as Show, w: 0.024, h: 0, x, y: 2.52 - 0.14 - Math.cos(tilt) * 0.05, z: Math.sin(tilt) * 0.1 }));
  }
  return [];
}

const canvasTexture = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
};

let shows: Record<Show, THREE.Material> | null = null;
let rideCanvas: CanvasRenderingContext2D | null = null;
let rideTexture: THREE.CanvasTexture | null = null;
function showMaterials(): Record<Show, THREE.Material> {
  if (shows) return shows;
  rideTexture = canvasTexture(512, 288, (g) => {
    rideCanvas = g;
    drawRide(g, 0);
  });
  shows = {
    ride: new THREE.MeshBasicMaterial({ map: rideTexture }),
    desktop: new THREE.MeshBasicMaterial({ map: canvasTexture(512, 220, drawDesktop) }),
    code: new THREE.MeshBasicMaterial({ map: canvasTexture(256, 438, drawCode) }),
    off: new THREE.MeshStandardMaterial({ color: '#060708', roughness: 0.1, metalness: 0.4 }),
    print: new THREE.MeshStandardMaterial({ map: canvasTexture(256, 348, drawPrint), roughness: 0.7 }),
    glow: new THREE.MeshBasicMaterial({ color: '#ffd7a0' }),
    lamp: new THREE.MeshBasicMaterial({ color: '#fff3e0' }),
    wash: new THREE.MeshBasicMaterial({ map: washTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    // Clear glass (the globe pendants): faint, with the room's reflections on it.
    glass: new THREE.MeshStandardMaterial({ color: '#e9eff0', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: false }),
    painting: new THREE.MeshStandardMaterial({ map: canvasTexture(256, 332, drawPainting), roughness: 0.85 }),
    mirror: new THREE.MeshStandardMaterial({ color: '#d4d6d6', roughness: 0.3, metalness: 0.5 }), // a pale, soft reflection rather than the blue sky
    llama: new THREE.MeshStandardMaterial({ map: canvasTexture(200, 260, drawLlama), roughness: 0.8, alphaTest: 0.5 }),
  };
  return shows;
}

/** The shape of an extra, in its own frame. */
function extraGeometry(e: Extra): THREE.BufferGeometry {
  if (e.geo) return e.geo();
  if (e.show === 'glow') return new THREE.BoxGeometry(e.w, e.h, 0.01);
  if (e.show === 'lamp') return e.w > 0.06 ? new THREE.SphereGeometry(e.w, 16, 10) : new THREE.SphereGeometry(e.w, 8, 6);
  return new THREE.PlaneGeometry(e.w, e.h);
}

/** Extras of the same kind in one mesh each (one draw call per kind); the bike's screen stays apart. */
function extraMeshes(byShow: Map<Show, THREE.BufferGeometry[]>, into: THREE.Object3D, name: string, look: (m: THREE.Material) => THREE.Material = (m) => m): void {
  const mats = showMaterials();
  for (const [show, geos] of byShow) {
    if (!geos.length) continue;
    const mesh = new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos) : geos[0], look(mats[show]));
    if (geos.length > 1) geos.forEach((g) => g.dispose());
    mesh.userData.ignoreRay = true; // bullets hit the piece behind it
    if (show === 'wash') mesh.renderOrder = 2;
    mesh.name = `${name}:${show}`;
    into.add(mesh);
  }
}

// The chair's woven mesh: threads with gaps you can see through up close (thick enough that it
// reads as a dark mesh, not as nothing, from further away).
const weave = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.75, alphaTest: 0.5, side: THREE.DoubleSide,
  map: (() => {
    const t = canvasTexture(16, 16, (g) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 16, 7);
      g.fillRect(0, 0, 7, 16);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(36, 36);
    return t;
  })(),
});

// The rattan shade's open lattice: thin cane strands and big
// gaps. See-through by blending rather than cut out, so from further off, where the strands are
// smaller than a pixel, it fades to a half-transparent shade instead of vanishing.
const lattice = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.8, transparent: true, depthWrite: false, alphaTest: 0.02, side: THREE.DoubleSide,
  map: (() => {
    const t = canvasTexture(32, 32, (g) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 32, 5);
      g.fillRect(0, 0, 5, 32);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(36, 36);
    return t;
  })(),
});

// Boucle and shaggy pile: pale loops with grey
// shadows between them, a texture of 30 cm (UVs from cloth()). The parts' colour tints it.
const fabric = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.95,
  map: (() => {
    const t = canvasTexture(128, 128, (g) => {
      const img = g.createImageData(128, 128);
      let s = 9;
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < img.data.length; i += 4) {
        const r = rnd();
        const v = r < 0.26 ? 165 + 50 * rnd() : 232 + 23 * rnd(); // a shadow between the loops, or a loop
        img.data.set([v, v, v, 255], i);
      }
      g.putImageData(img, 0, 0);
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  })(),
});

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
const MATERIALS: Record<Kind, THREE.Material> = { solid: material, weave, lattice, cloth: fabric };

/**
 * Parts merged into one geometry with a group for each kind of part, in the order of KINDS
 * (userData.kinds); the textured kinds need UVs, so the others get empty ones beside them.
 */
function byKind(list: Part[]): THREE.BufferGeometry {
  const kinds = KINDS.filter((k) => list.some((g) => kindOf(g) === k));
  const merged = kinds.map((k) => mergeGeometries(list.filter((g) => kindOf(g) === k)));
  if (merged.length > 1) for (const g of merged) if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  const geo = merged.length > 1 ? mergeGeometries(merged, true) : merged[0];
  geo.userData.kinds = kinds;
  return geo;
}

/** The material, or one per group, for a geometry from byKind. */
const materialsOf = (geo: THREE.BufferGeometry): THREE.Material | THREE.Material[] => {
  const kinds = geo.userData.kinds as Kind[];
  return kinds.length > 1 ? kinds.map((k) => MATERIALS[k]) : MATERIALS[kinds[0]];
};

const geometries = new Map<string, THREE.BufferGeometry>();
export function itemGeometry(id: string): THREE.BufferGeometry {
  if (!geometries.has(id)) {
    const item = ITEMS.find((i) => i.id === id);
    geometries.set(id, byKind(parts(id, item ? item.size : [0.5, 0.5, 0.5])));
  }
  return geometries.get(id)!;
}

/** Turn a piece's local outline (w x d round its centre) into the world. */
function outline(x: number, z: number, yaw: number, w: number, d: number): [number, number][] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return ([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as const).map(([px, pz]) => [x + px * c + pz * s, z - px * s + pz * c]);
}

/**
 * Built-in furniture from the house data (the bungalow's book wall and jacuzzi; the main house's
 * curtains, lamps, art, cushions and stools): the planner's parts at the fixture's
 * own size, solid unless they hang, sit on a wall or lie flat, and not in the planner. Per site
 * (the main house, the bungalow) one mesh for the coloured parts, one for each textured kind (weave,
 * lattice, cloth) and one per kind of extra, drawn again as the Blender models come in. Parts flat
 * on a wall, the seat or the floor go in meshes of their own that cast no shadow.
 */
export function buildFixtures(list: FixtureSpec[], world: World): THREE.Group | null {
  if (!list.length) return null;
  list.forEach((f, i) => {
    if (!NO_BLOCK.has(f.item)) world.setMoving(`fixture-${i}`, outline(f.x, f.z, f.yaw, f.size[0], f.size[1]), f.y, f.y + f.size[2]);
  });
  return fixtureGroup(list);
}

/**
 * Fixtures' meshes alone, without their blocks for walking into (the end house at Molenhoek brings its own:
 * world/walkIn.ts); `look` changes each material (that house's inside takes no direct sun).
 */
export function fixtureGroup(list: FixtureSpec[], look: (m: THREE.Material) => THREE.Material = (m) => m, shadows = true): THREE.Group | null {
  if (!list.length) return null;
  const group = new THREE.Group();
  group.name = 'fixtures';
  const sites = new Map<string, FixtureSpec[]>();
  for (const f of list) {
    const key = `${Math.round(f.x / 60)},${Math.round(f.z / 60)}`;
    if (!sites.has(key)) sites.set(key, []);
    sites.get(key)!.push(f);
  }
  const draw = () => {
    for (const m of [...group.children] as THREE.Mesh[]) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    const at = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    for (const [key, site] of sites) {
      const buckets = new Map<string, Part[]>(); // by kind ('parts' for the coloured ones), ' decor' when they cast no shadow
      const byShow = new Map<Show, THREE.BufferGeometry[]>();
      for (const f of site) {
        at.makeRotationY(f.yaw).setPosition(f.x, f.y, f.z);
        for (const g of parts(f.item, f.size)) {
          const kind = kindOf(g);
          const bucket = (kind === 'solid' ? 'parts' : kind) + (NO_SHADOW.has(f.item) ? ' decor' : '');
          if (!buckets.has(bucket)) buckets.set(bucket, []);
          buckets.get(bucket)!.push(g.applyMatrix4(at));
        }
        for (const e of extras(f.item, f.size)) {
          local.makeRotationY(e.ry ?? 0).setPosition(e.x, e.y, e.z);
          if (!byShow.has(e.show)) byShow.set(e.show, []);
          byShow.get(e.show)!.push(extraGeometry(e).applyMatrix4(at.clone().multiply(local)));
        }
      }
      for (const [bucket, geos] of buckets) {
        const kind = bucket.split(' ')[0];
        const mesh = new THREE.Mesh(mergeGeometries(geos), look(MATERIALS[kind === 'parts' ? 'solid' : (kind as Kind)]));
        mesh.name = `fixtures ${key}:${bucket === 'parts decor' ? 'decor' : bucket}`;
        geos.forEach((g) => g.dispose());
        mesh.castShadow = shadows && !bucket.endsWith('decor');
        mesh.receiveShadow = true;
        mesh.userData.material = 'oak'; // what a bullet hit looks and sounds like
        group.add(mesh);
      }
      extraMeshes(byShow, group, `fixtures ${key}`, look);
    }
  };
  draw();
  // The files these fixtures draw from: the interior's models, and the office chair's and the soundbar's if they have them.
  const files = new Set(['interior', ...(list.some((f) => f.item === 'officechair') ? ['aeron'] : []), ...(list.some((f) => f.item === 'tvunit') ? ['soundbar'] : [])]);
  loadModels((file) => files.has(file) && draw());
  return group;
}
const HANGING = new Set(['pendants', 'globes', 'rattandome', 'tracklight']);
// Fixtures you walk under, past or over: lamps, things on walls and ceilings, cushions on the seat, toys.
const NO_BLOCK = new Set([...HANGING, 'islandlamps', 'domelamp', 'speaker', 'relief', 'painting', 'llama', 'cubeshelves', 'wallshelf', 'cushion', 'cushiongrey', 'books', 'traintrack']);
// Fixtures flat on a wall, the ceiling, the seat or the floor: their shadows would hardly show.
const NO_SHADOW = new Set(['speaker', 'relief', 'painting', 'llama', 'cubeshelves', 'wallshelf', 'cushion', 'cushiongrey', 'books', 'traintrack']);

/** The outline of a piece on the floor (for collision and the minimap). */
export function footprint(p: Piece): [number, number][] {
  const [w, d] = ITEMS.find((i) => i.id === p.item)!.size;
  return outline(p.x, p.z, p.yaw, w, d);
}

export class Furnishing {
  readonly group = new THREE.Group();
  /**
   * Pieces placed away from the house and the bungalow (a bench on the church square): drawn on their
   * own, since `group` hides with the house from far off and they would vanish with it (main.ts).
   */
  readonly away = new THREE.Group();
  /** Whether a piece at (x, z) belongs with the house (main.ts sets the area round both houses). */
  homeArea: (x: number, z: number) => boolean = () => true;
  readonly pieces = new Map<number, Piece>();
  private meshes = new Map<string, { mesh: THREE.InstancedMesh; ids: number[] }>();
  private shown = new THREE.Group();
  private rides: THREE.Mesh[] = [];
  private rideClock = 0;
  private rideFrame = 0;

  constructor(private world: World) {
    this.group.add(this.shown);
    loadModels(() => this.refresh());
  }

  /** A model came in: draw every kind again with it. */
  refresh(): void {
    for (const entry of this.meshes.values()) {
      entry.mesh.removeFromParent();
      entry.mesh.dispose();
    }
    this.meshes.clear();
    geometries.clear();
    this.rebuild();
  }

  /** The ride on the bike's screen moves on (15 frames a second, only when someone is near it). */
  update(dt: number, eye: THREE.Vector3): void {
    this.rideClock += dt;
    if (!rideCanvas || !rideTexture || !this.rides.some((m) => m.position.distanceToSquared(eye) < 144)) return;
    this.rideFrame += dt;
    if (this.rideFrame < 1 / 15) return;
    this.rideFrame = 0;
    drawRide(rideCanvas, this.rideClock);
    rideTexture.needsUpdate = true;
  }

  setAll(list: Piece[]): void {
    for (const id of [...this.pieces.keys()]) this.world.setMoving(`furn-${id}`, null);
    this.pieces.clear();
    for (const p of list) this.pieces.set(p.id, p);
    this.rebuild();
  }

  put(p: Piece): void {
    this.pieces.set(p.id, p);
    this.rebuild();
  }

  remove(id: number): void {
    this.pieces.delete(id);
    this.world.setMoving(`furn-${id}`, null);
    this.rebuild();
  }

  /** The piece hit by a ray, if any. */
  pick(raycaster: THREE.Raycaster): Piece | null {
    return this.pickHit(raycaster)?.piece ?? null;
  }

  /** The piece hit by a ray and how far along it (m), if any. */
  pickHit(raycaster: THREE.Raycaster): { piece: Piece; distance: number } | null {
    const hit = raycaster.intersectObjects([...this.meshes.values()].map((m) => m.mesh), false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const entry = [...this.meshes.values()].find((m) => m.mesh === hit.object);
    const id = entry?.ids[hit.instanceId];
    const piece = id === undefined ? undefined : this.pieces.get(id);
    return piece ? { piece, distance: hit.distance } : null;
  }

  /** One instanced mesh per kind of furniture; collision boxes for everything but rugs. */
  private rebuild(): void {
    // One instanced mesh per kind and per place: with the house, or away from it.
    const byItem = new Map<string, Piece[]>();
    for (const p of this.pieces.values()) {
      const key = `${p.item}|${this.homeArea(p.x, p.z) ? 'home' : 'away'}`;
      if (!byItem.has(key)) byItem.set(key, []);
      byItem.get(key)!.push(p);
    }
    for (const [item, entry] of this.meshes) {
      if (!byItem.has(item)) {
        entry.mesh.removeFromParent();
        entry.mesh.dispose();
        this.meshes.delete(item);
      }
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [key, list] of byItem) {
      const item = list[0].item;
      const home = key.endsWith('|home');
      let entry = this.meshes.get(key);
      if (!entry || entry.mesh.instanceMatrix.count < list.length) {
        entry?.mesh.removeFromParent();
        entry?.mesh.dispose();
        const geo = itemGeometry(item);
        const mesh = new THREE.InstancedMesh(geo, materialsOf(geo), Math.max(4, list.length * 2));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.material = 'oak';
        mesh.name = `furniture:${item}`;
        (home ? this.group : this.away).add(mesh);
        entry = { mesh, ids: [] };
        this.meshes.set(key, entry);
      }
      entry.ids = list.map((p) => p.id);
      list.forEach((p, i) => {
        entry!.mesh.setMatrixAt(i, m.compose(new THREE.Vector3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.yaw), new THREE.Vector3(1, 1, 1)));
        const size = ITEMS.find((it) => it.id === p.item)?.size;
        // Rugs lie flat and lamps hang from the ceiling: you walk over and under them.
        if (size && !p.item.startsWith('rug') && !HANGING.has(p.item)) this.world.setMoving(`furn-${p.id}`, footprint(p), p.y, p.y + size[2]);
      });
      entry.mesh.count = list.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.mesh.computeBoundingSphere();
    }
    this.placeExtras();
  }

  /** Screens and light strips, where their pieces are now. */
  private placeExtras(): void {
    for (const m of [...this.shown.children] as THREE.Mesh[]) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.rides = [];
    const mats = showMaterials();
    const at = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const byShow = new Map<Show, THREE.BufferGeometry[]>();
    for (const p of this.pieces.values()) {
      const size = ITEMS.find((it) => it.id === p.item)?.size;
      if (!size) continue;
      for (const e of extras(p.item, size)) {
        local.makeRotationY(e.ry ?? 0).setPosition(e.x, e.y, e.z);
        at.makeRotationY(p.yaw).setPosition(p.x, p.y, p.z).multiply(local);
        if (e.show === 'ride') {
          // Each bike's screen is a mesh of its own: its place tells whether anyone is near it.
          const mesh = new THREE.Mesh(extraGeometry(e), mats.ride);
          at.decompose(mesh.position, mesh.quaternion, mesh.scale);
          mesh.userData.ignoreRay = true;
          this.shown.add(mesh);
          this.rides.push(mesh);
          continue;
        }
        if (!byShow.has(e.show)) byShow.set(e.show, []);
        byShow.get(e.show)!.push(extraGeometry(e).applyMatrix4(at));
      }
    }
    extraMeshes(byShow, this.shown, 'furniture');
  }
}
