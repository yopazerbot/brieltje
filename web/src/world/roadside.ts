import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facesMaterial, looseProps, type Face, type Place } from './looseProps';
import type { V3 } from './rigid';
import { tileKey, type Piece, type Tiles } from './tiles';
import { placeWheelieBins } from './wheelieBins';

/**
 * Things along the streets of the road to Smetlede and the village's outer streets
 * (tools/roads.py, web/src/data/roads.json): street name plates on posts at the corners, the
 * village's name where the built-up area starts, zone 30 signs where the traffic slows for the
 * centre, a bus stop with its shelter, letterboxes at the front of the houses, a waste container beside
 * some of them (world/wheelieBins.ts), and a bike against a front wall here and there.
 *
 * All made here from a few boxes and cylinders (nothing to download) in vertex colours; the
 * plates' and signs' faces come from one picture drawn on a canvas (1024 x 512). The bus shelter
 * joins the surroundings' tiles (world/tiles.ts); the rest are loose (world/looseProps.ts): a car
 * bends the posts and knocks the bins and bikes over.
 */

interface RoadsideData {
  plates: [number, number, number, string][];
  signs: [number, number, number, string][];
  boxes: [number, number, number][];
  bikes: [number, number, number][];
}

/** A box w x h x d, its foot's middle at (x, y, z), turned by `ry` round the upright, in one colour. */
function block(w: number, h: number, d: number, x: number, y: number, z: number, color: string, ry = 0, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  return paint(g.translate(x, y, z), color);
}

/** An upright cylinder (or, turned, a wheel), its foot's middle at (x, y, z). */
function rod(r: number, h: number, x: number, y: number, z: number, color: string, segments = 8): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(r, r, h, segments, 1).translate(x, y + h / 2, z), color);
}

function paint(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = out.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  out.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return out;
}

/** A letterbox on a post, its slot facing +z: anthracite, as most are. */
function letterbox(): THREE.BufferGeometry {
  return mergeGeometries([
    block(0.07, 1.0, 0.07, 0, 0, -0.06, '#2f3236'),
    block(0.34, 0.4, 0.36, 0, 0.98, 0, '#3a3e43'),
    block(0.38, 0.05, 0.4, 0, 1.38, 0, '#2c2f33'), // the lid
    block(0.24, 0.03, 0.01, 0, 1.24, 0.18, '#141516'), // the slot
  ]);
}

/** Where a parked bike touches the ground lying down, or walls as it falls: wheels, pedals, saddle, bars (its own frame). */
const BIKE_POINTS: V3[] = [
  [-0.52, 0, 0], [0.52, 0, 0], [-0.86, 0.35, 0], [0.86, 0.35, 0], [-0.52, 0.68, 0], [0.52, 0.68, 0],
  [0.3, 1.0, 0.26], [0.3, 1.0, -0.26], [-0.22, 0.87, 0.06], [-0.22, 0.87, -0.06], [-0.12, 0.24, 0.14], [-0.12, 0.24, -0.14],
];

/** A town bike along x, upright (world/looseProps.ts leans it against the wall). */
function bike(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wheel = (x: number) => parts.push(paint(new THREE.TorusGeometry(0.33, 0.022, 3, 12).translate(x, 0.35, 0), '#161616'));
  wheel(-0.52);
  wheel(0.52);
  const tube = (a: [number, number], b: [number, number], color = '#20314d', r = 0.018) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const g = new THREE.CylinderGeometry(r, r, len, 4, 1, true).rotateZ(-Math.atan2(b[0] - a[0], b[1] - a[1]));
    parts.push(paint(g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0), color));
  };
  tube([-0.52, 0.35], [-0.12, 0.38]); // chain stay
  tube([-0.12, 0.38], [-0.2, 0.82]); // seat tube
  tube([-0.52, 0.35], [-0.2, 0.8]); // seat stay
  tube([-0.12, 0.38], [0.36, 0.78]); // down tube (a low step-through)
  tube([0.36, 0.78], [0.52, 0.35]); // fork
  tube([0.36, 0.78], [0.33, 1.0], '#2a2a2a'); // stem
  parts.push(block(0.06, 0.03, 0.52, 0.3, 1.0, 0, '#1d1d1d')); // handlebar
  parts.push(block(0.24, 0.05, 0.12, -0.22, 0.84, 0, '#1b1b1b')); // saddle
  parts.push(block(0.5, 0.02, 0.2, -0.36, 0.7, 0, '#262626')); // carrier
  parts.push(paint(new THREE.CylinderGeometry(0.33, 0.33, 0.1, 8, 1, true, Math.PI * 0.55, Math.PI * 0.9).rotateX(Math.PI / 2).translate(-0.52, 0.35, 0), '#2a2b2d')); // mudguard
  return mergeGeometries(parts);
}

/** A plain post: galvanised steel, 1 m (scaled to its height). */
function post(): THREE.BufferGeometry {
  return rod(0.035, 1, 0, 0, 0, '#9aa1a8', 8);
}

/** The bus shelter, 3.2 x 1.5 m, its open side facing +z: posts, roof, a bench; and its glass apart. */
function shelter(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const frame: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-1.55, -0.7], [1.55, -0.7], [-1.55, 0.7], [1.55, 0.7]]) frame.push(block(0.07, 2.3, 0.07, x, 0, z, '#3b3f44'));
  frame.push(block(3.4, 0.08, 1.7, 0, 2.3, 0, '#2f3337'));
  frame.push(block(3.0, 0.06, 0.38, 0, 0.45, -0.48, '#8a6a48')); // the bench's seat (wood)
  frame.push(block(0.06, 0.45, 0.3, -1.2, 0, -0.5, '#3b3f44'), block(0.06, 0.45, 0.3, 1.2, 0, -0.5, '#3b3f44'));
  const glass = [block(3.06, 2.05, 0.02, 0, 0.15, -0.7, '#c9d6de'), block(0.02, 2.05, 0.7, -1.55, 0.15, -0.34, '#c9d6de'), block(0.02, 2.05, 0.7, 1.55, 0.15, -0.34, '#c9d6de')];
  return [mergeGeometries(frame), mergeGeometries(glass)];
}

/** Cells of the picture for the faces: x, y, w, h in pixels of the 1024 x 512 canvas. */
const SIZE = [1024, 512];
type Cell = [number, number, number, number];

/** The faces' picture: the street names (white on dark blue), the village's name sign, zone 30, the bus stop. */
function drawFaces(names: string[]): { texture: THREE.CanvasTexture; plate: Map<string, Cell>; cells: Record<string, Cell> } {
  const c = document.createElement('canvas');
  [c.width, c.height] = SIZE;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8f969c';
  g.fillRect(0, 0, c.width, c.height);
  const plate = new Map<string, Cell>();
  const font = (px: number, bold = true) => `${bold ? 'bold ' : ''}${px}px Arial, Helvetica, sans-serif`;
  const fit = (text: string, w: number, px: number) => {
    g.font = font(px);
    while (g.measureText(text).width > w && px > 10) g.font = font(--px);
    return px;
  };
  names.forEach((name, i) => {
    const cell: Cell = [(i % 3) * 340, Math.floor(i / 3) * 76, 340, 76];
    const [x, y, w, h] = cell;
    g.fillStyle = '#1e3b78';
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#f2f4f7';
    g.lineWidth = 4;
    g.strokeRect(x + 6, y + 6, w - 12, h - 12);
    g.fillStyle = '#f7f8fa';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fit(name, w - 36, 40);
    g.fillText(name, x + w / 2, y + h / 2 + 2);
    plate.set(name, cell);
  });
  const cells: Record<string, Cell> = { smetlede: [0, 384, 320, 128], zone30: [330, 384, 88, 128], bus: [430, 384, 128, 128], back: [580, 400, 64, 64] };
  {
    // F1: the built-up area starts. White, a black edge, the name in black.
    const [x, y, w, h] = cells.smetlede;
    g.fillStyle = '#f4f4f0';
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#111';
    g.lineWidth = 8;
    g.strokeRect(x + 8, y + 8, w - 16, h - 16);
    g.fillStyle = '#111';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fit('Smetlede', w - 50, 64);
    g.fillText('Smetlede', x + w / 2, y + h / 2 + 3);
  }
  {
    // F4a: zone 30. White, "ZONE" over a 30 in a red ring.
    const [x, y, w, h] = cells.zone30;
    g.fillStyle = '#f4f4f0';
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#222';
    g.lineWidth = 2;
    g.strokeRect(x + 2, y + 2, w - 4, h - 4);
    g.fillStyle = '#111';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = font(22);
    g.fillText('ZONE', x + w / 2, y + 22);
    g.beginPath();
    g.arc(x + w / 2, y + 80, 34, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
    g.lineWidth = 9;
    g.strokeStyle = '#d0141c';
    g.stroke();
    g.fillStyle = '#111';
    g.font = font(32);
    g.fillText('30', x + w / 2, y + 82);
  }
  {
    // A bus stop: a white bus on blue (no operator's logo).
    const [x, y, w, h] = cells.bus;
    g.fillStyle = '#f4f4f0';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#1f4fa0';
    g.fillRect(x + 10, y + 10, w - 20, h - 20);
    g.fillStyle = '#fff';
    const r = (bx: number, by: number, bw: number, bh: number) => g.fillRect(x + bx, y + by, bw, bh);
    r(30, 30, 68, 56); // the bus from the front
    g.fillStyle = '#1f4fa0';
    r(36, 36, 56, 24); // its windscreen
    g.fillStyle = '#fff';
    r(34, 88, 14, 10);
    r(80, 88, 14, 10); // wheels
  }
  {
    const [x, y, w, h] = cells.back;
    g.fillStyle = '#8a9096';
    g.fillRect(x, y, w, h);
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { texture, plate, cells };
}

/** A face w x h with its bottom `y` up the post and `z` in front of it, showing `cell` (or facing -z: `back`; seen from behind its left is still the picture's left). */
function face(w: number, h: number, y: number, z: number, cell: Cell, back = false): Face {
  const [cx, cy, cw, ch] = cell;
  return { w, h, y, z, back, rect: [cx / SIZE[0], 1 - (cy + ch) / SIZE[1], cw / SIZE[0], ch / SIZE[1]] };
}

/** A steel post: wobbles at about 2 Hz, stays bent past a tenth of a radian, snaps off at its foot under a car faster than 9 m/s. */
const POST = { hz: 2.1, damping: 0.1, yield: 0.1, maxBend: 1.35 };

/**
 * Everything along the streets: the bus shelter as pieces of the tiles it stands in, the rest as loose
 * things (world/looseProps.ts). `groundAt` is the ground (or paving) at a spot; `bins` the waste
 * containers' models (world/wheelieBins.ts), none without them.
 */
export function buildRoadside(data: RoadsideData, tiles: Tiles, groundAt: (x: number, z: number) => number, bins: Map<string, THREE.BufferGeometry> | null = null): THREE.Texture {
  const names = [...new Set(data.plates.map((p) => p[3]))];
  const { texture, plate, cells } = drawFaces(names);
  const kit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 });
  const faces = facesMaterial(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.45, metalness: 0.1 }));
  const glassMat = new THREE.MeshStandardMaterial({ color: '#cfdde6', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: false });
  const [shelterFrame, shelterGlass] = shelter();
  const byTile = new Map<string, { solid: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[] }>();
  const tile = (x: number, z: number) => {
    const key = tileKey(x, z);
    let t = byTile.get(key);
    if (!t) byTile.set(key, (t = { solid: [], glass: [] }));
    return t;
  };
  const up = new THREE.Vector3(0, 1, 0);
  const at = (x: number, z: number, yaw: number, extra: Partial<Place> = {}): Place => ({ x, y: groundAt(x, z), z, yaw, ...extra });

  // Letterboxes, and beside one in four a waste container (world/wheelieBins.ts).
  const boxes = data.boxes.map(([x, z, yaw]) => at(x, z, yaw));
  placeWheelieBins(bins, data.boxes, groundAt);
  const posts: Place[] = [];
  // Name plates: 0.8 x 0.17 m on top of a post, along the street they name, readable from both sides.
  for (const [x, z, a, name] of data.plates) {
    const cell = plate.get(name)!;
    posts.push(at(x, z, -a, { sy: 2.33, faces: [face(0.8, 0.17, 2.32, 0, cell), face(0.8, 0.17, 2.32, 0, cell, true)] }));
  }
  for (const [x, z, yaw, kind] of data.signs) {
    if (kind === 'shelter') {
      const t = tile(x, z);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, groundAt(x, z), z), new THREE.Quaternion().setFromAxisAngle(up, yaw), new THREE.Vector3(1, 1, 1));
      t.solid.push(shelterFrame.clone().applyMatrix4(m));
      t.glass.push(shelterGlass.clone().applyMatrix4(m));
      continue;
    }
    const [w, h, top] = kind === 'smetlede' ? [1.0, 0.4, 2.3] : kind === 'zone30' ? [0.5, 0.73, 2.4] : [0.45, 0.45, 2.7];
    posts.push(at(x, z, yaw, { sy: top, faces: [face(w, h, top - h - 0.02, 0.04, cells[kind]), face(w, h, top - h - 0.02, 0.04, cells.back, true)] }));
  }

  looseProps.add('letterbox', { geometry: letterbox(), material: kit, tag: 'steel', mode: 'pole', sound: 'metal', mass: 9, push: 0.5, pole: POST, snap: 9, reach: 0.18 }, boxes);
  looseProps.add('post', { geometry: post(), material: kit, tag: 'steel', mode: 'pole', sound: 'metal', mass: 8, push: 0.4, pole: { ...POST, hz: 1.6 }, snap: 10, reach: 0.06, faces }, posts);
  looseProps.add('bike', {
    geometry: bike(), material: kit, tag: 'steel', mode: 'rigid', sound: 'metal', mass: 18, push: 0.45, bounce: 0.12, friction: 0.7,
    points: BIKE_POINTS, edges: [[0.3, 1.0, 0], [-0.22, 0.87, 0], [0.86, 0.35, 0], [-0.86, 0.35, 0]], box: [[-0.87, 0, -0.15], [0.87, 1.02, 0.15]], reach: 0.3,
  }, data.bikes.map(([x, z, yaw]) => at(x, z, yaw, { lean: -0.18 }))); // leaning against the wall behind it

  const made: { key: string; pieces: Piece[] }[] = [];
  for (const [key, t] of byTile) {
    const pieces: Piece[] = [];
    if (t.solid.length) pieces.push({ material: kit, geometry: mergeGeometries(t.solid), tag: 'steel', shadow: false, small: true });
    if (t.glass.length) pieces.push({ material: glassMat, geometry: mergeGeometries(t.glass), tag: 'glass', shadow: false, small: true, order: 3 });
    made.push({ key, pieces });
  }
  tiles.addSet(made, false);
  return texture;
}
