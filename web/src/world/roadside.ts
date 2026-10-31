import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tileKey, type Piece, type Tiles } from './tiles';

/**
 * Things along the streets of the road to Smetlede and the village's outer streets
 * (tools/roads.py, web/src/data/roads.json): street name plates on posts at the corners, the
 * village's name where the built-up area starts, zone 30 signs where the traffic slows for the
 * centre, a bus stop with its shelter, letterboxes at the front of the houses, and a bike against a
 * front wall here and there.
 *
 * All made here from a few boxes and cylinders (nothing to download) in vertex colours; the
 * plates' and signs' faces come from one picture drawn on a canvas (1024 x 512). They join the
 * surroundings' tiles (world/tiles.ts) as a set of their own: each kind one instanced mesh, the
 * faces one mesh, drawn within the small details' distance (400 m).
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

/** A town bike along x, leaning a little towards -z (the wall behind it). */
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
  const g = mergeGeometries(parts);
  g.rotateX(-0.18); // leaning against the wall
  return g;
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

/** A flat face w x h, its bottom middle at the origin, facing +z, showing `cell` (or facing -z: `back`). */
function face(w: number, h: number, cell: Cell, back = false): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  if (back) g.rotateY(Math.PI); // seen from behind its left is still the picture's left
  g.translate(0, h / 2, back ? -0.006 : 0.006);
  const uv = g.attributes.uv;
  const [x, y, cw, ch] = cell;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + uv.getX(i) * cw) / SIZE[0], 1 - (y + (1 - uv.getY(i)) * ch) / SIZE[1]);
  return g;
}

/** Everything along the streets, as pieces of the tiles they stand in. `groundAt` is the ground (or paving) at a spot. */
export function buildRoadside(data: RoadsideData, tiles: Tiles, groundAt: (x: number, z: number) => number): THREE.Texture {
  const names = [...new Set(data.plates.map((p) => p[3]))];
  const { texture, plate, cells } = drawFaces(names);
  const kit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 });
  const faces = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.45, metalness: 0.1 });
  const glassMat = new THREE.MeshStandardMaterial({ color: '#cfdde6', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: false });
  const geo = { box: letterbox(), bike: bike(), post: post() };
  const [shelterFrame, shelterGlass] = shelter();
  const byTile = new Map<string, { at: Record<string, THREE.Matrix4[]>; faces: THREE.BufferGeometry[]; solid: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[] }>();
  const tile = (x: number, z: number) => {
    const key = tileKey(x, z);
    let t = byTile.get(key);
    if (!t) byTile.set(key, (t = { at: { box: [], bike: [], post: [] }, faces: [], solid: [], glass: [] }));
    return t;
  };
  const up = new THREE.Vector3(0, 1, 0);
  const place = (x: number, z: number, yaw: number, sy = 1, y = groundAt(x, z)) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(up, yaw), new THREE.Vector3(1, sy, 1));
  for (const [x, z, yaw] of data.boxes) tile(x, z).at.box.push(place(x, z, yaw));
  for (const [x, z, yaw] of data.bikes) tile(x, z).at.bike.push(place(x, z, yaw));
  // Name plates: 0.8 x 0.17 m on top of a post, along the street they name, readable from both sides.
  for (const [x, z, a, name] of data.plates) {
    const t = tile(x, z);
    const m = place(x, z, -a);
    t.at.post.push(place(x, z, -a, 2.33));
    const cell = plate.get(name)!;
    for (const back of [false, true]) t.faces.push(face(0.8, 0.17, cell, back).translate(0, 2.32, 0).applyMatrix4(m));
  }
  for (const [x, z, yaw, kind] of data.signs) {
    const t = tile(x, z);
    const m = place(x, z, yaw);
    if (kind === 'shelter') {
      t.solid.push(shelterFrame.clone().applyMatrix4(m));
      t.glass.push(shelterGlass.clone().applyMatrix4(m));
      continue;
    }
    const [w, h, top] = kind === 'smetlede' ? [1.0, 0.4, 2.3] : kind === 'zone30' ? [0.5, 0.73, 2.4] : [0.45, 0.45, 2.7];
    t.at.post.push(place(x, z, yaw, top));
    t.faces.push(face(w, h, cells[kind]).translate(0, top - h - 0.02, 0.04).applyMatrix4(m));
    t.faces.push(face(w, h, cells.back, true).translate(0, top - h - 0.02, 0.04).applyMatrix4(m));
  }
  const made: { key: string; pieces: Piece[] }[] = [];
  for (const [key, t] of byTile) {
    const pieces: Piece[] = [];
    for (const [kind, at] of Object.entries(t.at)) {
      if (at.length) pieces.push({ material: kit, geometry: geo[kind as keyof typeof geo], tag: 'steel', shadow: false, at, small: true });
    }
    if (t.faces.length) pieces.push({ material: faces, geometry: mergeGeometries(t.faces), tag: 'steel', shadow: false, small: true });
    if (t.solid.length) pieces.push({ material: kit, geometry: mergeGeometries(t.solid), tag: 'steel', shadow: false, small: true });
    if (t.glass.length) pieces.push({ material: glassMat, geometry: mergeGeometries(t.glass), tag: 'glass', shadow: false, small: true, order: 3 });
    made.push({ key, pieces });
  }
  tiles.addSet(made, false);
  return texture;
}
