import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facesMaterial, looseProps, type Face, type Place } from './looseProps';
import { drawBack, drawPlate, drawSign, drawStopPlate, drawTimetable, FaceSheet, outlineOf } from './signFaces';
import type { V3 } from './rigid';
import { tileKey, type Piece, type Tiles } from './tiles';
import { placeWheelieBins } from './wheelieBins';

/**
 * Things along the streets of the road to Smetlede and the village's outer streets
 * (tools/roads.py, web/src/data/roads.json): street name plates on posts at the corners, the traffic
 * signs where the road agency's register has them (Yoshi, 8 Nov 2026: "Traffic signs need to be better
 * positioned"), several on a post and turned the way the register says, the bus stops with their pole, and
 * a shelter and a litter bin where there is one, letterboxes at the front of the houses, a waste container
 * beside some of them (world/wheelieBins.ts), and a bike against a front wall here and there.
 *
 * All made here from a few boxes and cylinders (nothing to download) in vertex colours; the
 * plates' and signs' faces come from one picture drawn on a canvas (world/signFaces.ts). The bus shelters
 * join the surroundings' tiles (world/tiles.ts); the rest are loose (world/looseProps.ts): a car
 * bends the posts and knocks the bins and bikes over.
 */

interface RoadsideData {
  plates: [number, number, number, string][];
  /** A post: x, z, the lowest sign's lower edge (m), its faces: [yaw, [code, shape, w, h, dy, text][]] */
  signs: [number, number, number, [number, [string, string, number, number, number, string][]][]][];
  /** A bus stop: x, z, yaw, its name, its litter bin and its shelter (x, z, yaw) or null */
  stops: [number, number, number, string, [number, number, number] | null, [number, number, number] | null][];
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

/** The bus shelter, 3.2 x 1.5 m, its open side facing +z: a light grey frame, a yellow edge along the roof, a blue bench; and its glass apart. */
function shelter(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const frame: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-1.55, -0.7], [1.55, -0.7], [-1.55, 0.7], [1.55, 0.7]]) frame.push(block(0.07, 2.3, 0.07, x, 0, z, '#d4d7da'));
  frame.push(block(3.4, 0.08, 1.7, 0, 2.3, 0, '#c3c6c9'));
  frame.push(block(3.42, 0.12, 0.03, 0, 2.27, 0.86, '#f2c400'), block(3.42, 0.12, 0.03, 0, 2.27, -0.86, '#f2c400')); // the roof's edge
  frame.push(block(3.0, 0.05, 0.36, 0, 0.45, -0.48, '#2d5ea8')); // the bench
  frame.push(block(0.06, 0.45, 0.3, -1.2, 0, -0.5, '#b9bcc0'), block(0.06, 0.45, 0.3, 1.2, 0, -0.5, '#b9bcc0'));
  const glass = [block(3.06, 2.05, 0.02, 0, 0.15, -0.7, '#c9d6de'), block(0.02, 2.05, 0.7, -1.55, 0.15, -0.34, '#c9d6de'), block(0.02, 2.05, 0.7, 1.55, 0.15, -0.34, '#c9d6de')];
  return [mergeGeometries(frame), mergeGeometries(glass)];
}

/** The bus stop's pole: yellow, 3 m, the timetable's case on it at eye height (the plate and the timetable are faces). */
function stopPole(): THREE.BufferGeometry {
  return mergeGeometries([rod(0.04, 3.0, 0, 0, 0, '#f2c400', 8), block(0.4, 0.56, 0.06, 0, 1.2, 0, '#2b2d30'), block(0.5, 0.03, 0.04, 0, 2.95, 0, '#2b2d30')]);
}

/** A litter bin on its own short post, the bin (yellow, about 50 l) on the post's +z side. */
function litterBin(): THREE.BufferGeometry {
  return mergeGeometries([
    rod(0.03, 1.0, 0, 0, 0, '#8d949a', 6),
    rod(0.19, 0.5, 0, 0.42, 0.22, '#f2c400', 12),
    paint(new THREE.TorusGeometry(0.19, 0.018, 4, 12).rotateX(Math.PI / 2).translate(0, 0.92, 0.22), '#d9ad00'),
    rod(0.17, 0.01, 0, 0.915, 0.22, '#1d1d1d', 12), // the opening, dark
  ]);
}

/** A steel post: wobbles at about 2 Hz, stays bent past a tenth of a radian, snaps off at its foot under a car faster than 9 m/s. */
const POST = { hz: 2.1, damping: 0.1, yield: 0.1, maxBend: 1.35 };
/** Pixels a metre for the signs' faces on the picture (FaceSheet makes all smaller if they don't fit). */
const PX = 180;

/** One sign of the register: its code, the register's shape, width, height, how far above the lowest one, what it says. */
type Sign = [string, string, number, number, number, string];

/**
 * Everything along the streets: the bus shelters as pieces of the tiles they stand in, the rest as loose
 * things (world/looseProps.ts). `groundAt` is the ground (or paving) at a spot; `bins` the waste
 * containers' models (world/wheelieBins.ts), none without them.
 */
export function buildRoadside(data: RoadsideData, tiles: Tiles, groundAt: (x: number, z: number) => number, bins: Map<string, THREE.BufferGeometry> | null = null): THREE.Texture {
  // The faces' picture: the name plates, each sign once, their backs, the bus stops' plates and timetable.
  const sheet = new FaceSheet();
  const signKey = ([code, shape, w, h, , said]: Sign) => {
    const key = `sign:${code}:${shape}:${w}x${h}:${said}`;
    sheet.add(key, w * PX, h * PX, drawSign(code, shape, said));
    const o = outlineOf(code, shape);
    const aspect = Math.round((w / h) * 10) / 10;
    return [key, sheet.add(`back:${o}:${o === 'rect' ? 1 : aspect}`, o === 'rect' ? 32 : 64 * aspect, o === 'rect' ? 32 : 64, drawBack(o))];
  };
  for (const name of new Set(data.plates.map((p) => p[3]))) sheet.add(`plate:${name}`, 340, 76, drawPlate(name));
  const keyed = data.signs.map(([, , , faces]) => faces.map(([, signs]) => signs.map(signKey)));
  for (const [, , , name] of data.stops) sheet.add(`stop:${name}`, 120, 160, drawStopPlate(name));
  sheet.add('timetable', 80, 110, drawTimetable);
  const { texture, rects } = sheet.build();
  const face = (w: number, h: number, y: number, z: number, key: string, back = false, yaw = 0): Face => ({ w, h, y, z, back, rect: rects.get(key)!, yaw });

  const kit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 });
  const faces = facesMaterial(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.45, metalness: 0.1, alphaTest: 0.5 }));
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
    const key = `plate:${name}`;
    posts.push(at(x, z, -a, { sy: 2.33, faces: [face(0.8, 0.17, 2.32, 0, key), face(0.8, 0.17, 2.32, 0, key, true)] }));
  }
  // The traffic signs where the register has them: a post each, every face turned its own way, its signs
  // stacked from `lower` up as the register stacks them, each with its plain grey back.
  data.signs.forEach(([x, z, lower, signFaces], i) => {
    const yaw = signFaces[0][0];
    const list: Face[] = [];
    let top = lower;
    signFaces.forEach(([faceYaw, signs], f) => {
      signs.forEach(([, , w, h, dy], s) => {
        const [front, back] = keyed[i][f][s];
        list.push(face(w, h, lower + dy, 0.045, front, false, faceYaw - yaw), face(w, h, lower + dy, 0.045, back, true, faceYaw - yaw));
        top = Math.max(top, lower + dy + h);
      });
    });
    posts.push(at(x, z, yaw, { sy: top + 0.03, faces: list }));
  });
  // The bus stops: the pole facing the traffic, its plate and timetable on both sides; a bin and a shelter where they are.
  const stops: Place[] = [];
  const litter: Place[] = [];
  for (const [x, z, yaw, name, bin, shelterAt] of data.stops) {
    const plate = `stop:${name}`;
    stops.push(at(x, z, yaw, {
      faces: [face(0.45, 0.6, 2.35, 0.045, plate), face(0.45, 0.6, 2.35, 0.045, plate, true),
        face(0.36, 0.5, 1.23, 0.032, 'timetable'), face(0.36, 0.5, 1.23, -0.026, 'timetable', true)],
    }));
    if (bin) litter.push(at(bin[0], bin[1], bin[2]));
    if (shelterAt) {
      const [sx, sz, sYaw] = shelterAt;
      const t = tile(sx, sz);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(sx, groundAt(sx, sz), sz), new THREE.Quaternion().setFromAxisAngle(up, sYaw), new THREE.Vector3(1, 1, 1));
      t.solid.push(shelterFrame.clone().applyMatrix4(m));
      t.glass.push(shelterGlass.clone().applyMatrix4(m));
    }
  }

  looseProps.add('letterbox', { geometry: letterbox(), material: kit, tag: 'steel', mode: 'pole', sound: 'metal', mass: 9, push: 0.5, pole: POST, snap: 9, reach: 0.18 }, boxes);
  looseProps.add('post', { geometry: post(), material: kit, tag: 'steel', mode: 'pole', sound: 'metal', mass: 8, push: 0.4, pole: { ...POST, hz: 1.6 }, snap: 10, reach: 0.06, faces }, posts);
  if (stops.length) looseProps.add('stop-pole', { geometry: stopPole(), material: kit, tag: 'steel', mode: 'pole', sound: 'metal', mass: 14, push: 0.35, pole: { ...POST, hz: 1.4 }, snap: 10, reach: 0.2, faces }, stops);
  if (litter.length) looseProps.add('litter-bin', { geometry: litterBin(), material: kit, tag: 'plastic', mode: 'pole', sound: 'plastic', mass: 10, push: 0.5, pole: POST, snap: 8, reach: 0.25 }, litter);
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
