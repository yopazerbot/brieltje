import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHALET, CHALETS, TABLES, type ChaletSpot, type Goods } from './christmasMarketPlan';
import { box, FirCards, firMaterial, painted, seeded } from './firTree';
import { snowy } from './snowCover';

/**
 * The small Christmas market on the church square (Yoshi, 18 Nov 2026), in the Christmas season with the tree
 * (world/christmas.ts shows it, world/season.ts says when) and only in Explore: four wooden chalets of dark-stained
 * boards under pitched roofs of shingles, a fir garland and a string of warm lights along each front eave, a counter
 * with goods and a painted sign in Dutch (warm chocolate milk, waffles, smoutebollen, Christmas decorations and
 * candles), and three standing tables in white and red covers with a lantern. Where they stand:
 * world/christmasMarketPlan.ts. Scenery: no shop, nothing to use, nothing sent over the network.
 *
 * Made here in code from boxes, cylinders and lathes, every board its own shade on its corners, all chalets merged by
 * material: the outside wood and the tables (one draw call), the roofs (one; snow lies on them), the inside and its
 * goods (one; at dusk and at night lit warm from within, a glow in their colours, no real light), the signs (one,
 * their picture painted here on a canvas), the garlands (one, the fir's needle cards, world/firTree.ts) and, at dusk
 * and at night only, the warm light on the paving before the counters and round the lanterns (one, added on). The
 * bulbs along the eaves and the lanterns' flames are christmas.ts's glows. Every value far under the half floats' end.
 * The signs sit on the front of the roofs, as on the chalets of a real Christmas market; the garland hangs under them.
 */

const W = CHALET.w;
const D = CHALET.d;
/** Heights (m): the walls at the eaves, the ridge (halfway back), the counter's top, the opening's top. */
const EAVE = 2.38;
const RIDGE = 3.08;
const COUNTER = 1.0;
const OPEN_TOP = 2.04;
const FLOOR = 0.12;
/** How far the roof reaches past the front, the back and the sides. */
const OVER_FRONT = 0.42;
const OVER_BACK = 0.15;
const OVER_SIDE = 0.15;
const PITCH = Math.atan2(RIDGE - EAVE, D / 2);
/** Where the sign stands on the roof, front to back (its face). */
const SIGN_Z = 0.12;

/** What the signs say: Dutch, as painted on a stall (scenery). The last one is a small board under a counter. */
const SIGNS = ['Warme chocomelk', 'Wafels', 'Smoutebollen', 'Kerstversiering', 'Kaarsen'];
const SIGN_OF: Record<Goods, number> = { choco: 0, waffles: 1, smoutebollen: 2, decorations: 3 };
const SIGN_ROWS = SIGNS.length;
const SIGN_PX = { w: 1024, h: 128 };

const col = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k);

/** Parts of one chalet in its own frame (front along +z, the floor's middle under the front wall at the origin). */
interface Parts {
  outside: THREE.BufferGeometry[];
  roof: THREE.BufferGeometry[];
  inside: THREE.BufferGeometry[];
  signs: THREE.BufferGeometry[];
  garland: FirCards;
  bulbs: THREE.Vector3[];
}

function cylinder(rTop: number, rBottom: number, h: number, x: number, y: number, z: number, colour: THREE.Color, seg = 12): THREE.BufferGeometry {
  return painted(new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1).translate(x, y + h / 2, z), colour);
}

function ball(r: number, x: number, y: number, z: number, colour: THREE.Color, seg = 8): THREE.BufferGeometry {
  return painted(new THREE.SphereGeometry(r, seg, Math.max(4, seg - 2)).translate(x, y, z), colour);
}

/** Upright boards side by side from a to b (on the plan), each `h(t)` high from `y0`, `t` 0..1 along the row. */
function boards(out: THREE.BufferGeometry[], ax: number, az: number, bx: number, bz: number, y0: number, h: (t: number) => number, rand: () => number, stain: string, thick = 0.028): void {
  const length = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.round(length / 0.125));
  const ry = Math.atan2(-(bz - az), bx - ax);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const height = h(t);
    if (height <= 0.01) continue;
    out.push(box(length / n - 0.006, height, thick, ax + (bx - ax) * t, y0 + height / 2, az + (bz - az) * t, ry, col(stain, 0.82 + rand() * 0.32)));
  }
}

/** A roof slab from the ridge down to its edge (`dir` -1 to the back, +1 to the front), and its courses of shingles. */
function slab(p: Parts, front: boolean, rand: () => number): void {
  const reach = D / 2 + (front ? OVER_FRONT : OVER_BACK);
  const len = reach / Math.cos(PITCH);
  const sgn = front ? 1 : -1;
  const down = new THREE.Vector3(0, -Math.sin(PITCH), sgn * Math.cos(PITCH));
  const up = new THREE.Vector3(0, Math.cos(PITCH), sgn * Math.sin(PITCH));
  const ridge = new THREE.Vector3(0, RIDGE + 0.03, -D / 2);
  const place = (g: THREE.BufferGeometry, along: number, lift: number) => {
    g.rotateX(front ? PITCH : -PITCH);
    const c = ridge.clone().addScaledVector(down, along).addScaledVector(up, lift);
    return g.translate(c.x, c.y, c.z);
  };
  const width = W + OVER_SIDE * 2;
  // The boards under it, dark: seen from below and at the edge.
  p.roof.push(painted(place(new THREE.BoxGeometry(width, 0.04, len), len / 2, 0.02), col('#2e2119')));
  // Courses of shingles, each a little proud of the one above it.
  const course = 0.17;
  const courses = Math.ceil(len / course);
  for (let k = 0; k < courses; k++) {
    const a = Math.min(len - course / 2, (k + 0.5) * course);
    p.roof.push(painted(place(new THREE.BoxGeometry(width + 0.01, 0.016, course + 0.02), a, 0.048 + (k % 2) * 0.006), col('#3a2f27', 0.85 + rand() * 0.3)));
  }
  // Barge boards along the gable ends, and the fascia board along the eave.
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.03, 0.15, len + 0.02);
    g.rotateX(front ? PITCH : -PITCH);
    const c = ridge.clone().addScaledVector(down, len / 2).addScaledVector(up, -0.02);
    p.outside.push(painted(g.translate(s * (width / 2 + 0.015), c.y, c.z), col('#33241a')));
  }
  const edge = ridge.clone().addScaledVector(down, len);
  p.outside.push(box(width + 0.06, 0.14, 0.03, 0, edge.y - 0.03, edge.z + sgn * 0.015, 0, col('#33241a')));
}

/** The goods on one chalet's counter, shelves and back table: made of simple shapes, coloured. */
function goods(p: Parts, kind: Goods, rand: () => number): void {
  const g = p.inside;
  const top = COUNTER + 0.025;
  const shelf = (y: number) => y + 0.02;
  if (kind === 'choco') {
    // A copper pot with its lid on a stand, a tray of white cups, a tower of paper cups; tins of cocoa on the shelves.
    g.push(cylinder(0.17, 0.15, 0.26, -0.55, top + 0.04, -0.05, col('#9a5632')), cylinder(0.176, 0.176, 0.02, -0.55, top + 0.3, -0.05, col('#6e3b22')));
    g.push(cylinder(0.02, 0.02, 0.04, -0.55, top + 0.32, -0.05, col('#2b2220')), cylinder(0.12, 0.12, 0.04, -0.55, top, -0.05, col('#222', 1)));
    for (let i = 0; i < 8; i++) g.push(cylinder(0.042, 0.035, 0.09, 0.05 + (i % 4) * 0.11, top, -0.12 + Math.floor(i / 4) * 0.12, col('#ebe6dc')));
    for (let i = 0; i < 8; i++) g.push(cylinder(0.034, 0.034, 0.012, 0.05 + (i % 4) * 0.11, top + 0.075, -0.12 + Math.floor(i / 4) * 0.12, col('#4a2a18')));
    g.push(cylinder(0.047, 0.04, 0.3, 0.72, top, 0.02, col('#e8e2d4')));
    for (const y of [1.3, 1.65]) for (let i = 0; i < 6; i++) g.push(cylinder(0.055, 0.055, 0.14, -0.8 + i * 0.3, shelf(y), -D + 0.2, i % 2 ? col('#8f1d1d') : col('#c49a45')));
    g.push(cylinder(0.14, 0.14, 0.42, 0.55, 0.85, -D + 0.35, col('#b9bcc0')), box(0.4, 0.3, 0.25, -0.4, 0.85 + 0.15, -D + 0.35, 0, col('#5b3a22')));
  } else if (kind === 'waffles') {
    // A waffle iron with its lid open, stacks of golden waffles on plates, a sugar shaker; boxed waffles on the shelves.
    g.push(box(0.32, 0.07, 0.26, -0.6, top + 0.035, -0.05, 0, col('#1e1e1f')));
    const lid = painted(new THREE.BoxGeometry(0.32, 0.05, 0.26).translate(0, 0, -0.13).rotateX(-1.1), col('#262627'));
    g.push(lid.translate(-0.6, top + 0.08, 0.08));
    for (let s = 0; s < 3; s++) {
      const x = -0.05 + s * 0.3;
      g.push(cylinder(0.14, 0.14, 0.012, x, top, -0.04, col('#f0ede6'), 16));
      const n = 4 + Math.floor(rand() * 3);
      for (let k = 0; k < n; k++) g.push(box(0.11, 0.022, 0.09, x + (rand() - 0.5) * 0.02, top + 0.024 + k * 0.024, -0.04 + (rand() - 0.5) * 0.02, (rand() - 0.5) * 0.3, col('#c98d45', 0.85 + rand() * 0.25)));
    }
    g.push(cylinder(0.035, 0.035, 0.11, 0.85, top, 0.05, col('#f4f2ee')), cylinder(0.036, 0.03, 0.03, 0.85, top + 0.11, 0.05, col('#a8acb0')));
    for (const y of [1.3, 1.65]) for (let i = 0; i < 5; i++) g.push(box(0.26, 0.09, 0.14, -0.75 + i * 0.37, shelf(y) + 0.045, -D + 0.2, 0, i % 2 ? col('#d9c49a') : col('#a8322b')));
    g.push(box(0.6, 0.3, 0.35, 0.3, 0.85 + 0.15, -D + 0.35, 0, col('#6b4a2d')));
  } else if (kind === 'smoutebollen') {
    // A fryer, a big steel bowl heaped with smoutebollen dusted with sugar, paper cones in a rack.
    g.push(box(0.46, 0.26, 0.34, -0.55, top + 0.13, -0.08, 0, col('#b4b7bb')), box(0.4, 0.02, 0.28, -0.55, top + 0.27, -0.08, 0, col('#5a4428')));
    g.push(box(0.04, 0.03, 0.22, -0.3, top + 0.31, -0.08, 0, col('#222')));
    const lathe = new THREE.LatheGeometry([new THREE.Vector2(0.001, 0), new THREE.Vector2(0.13, 0.005), new THREE.Vector2(0.21, 0.07), new THREE.Vector2(0.23, 0.11), new THREE.Vector2(0.22, 0.115)], 18);
    g.push(painted(lathe.translate(0.2, top, -0.04), col('#c3c6ca')));
    for (let i = 0; i < 40; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * 0.18;
      const y = top + 0.08 + (0.18 - r) * 0.45 + rand() * 0.02;
      g.push(ball(0.03, 0.2 + Math.cos(a) * r, y, -0.04 + Math.sin(a) * r, rand() < 0.45 ? col('#e9e2d4') : col('#a8682f', 0.85 + rand() * 0.3), 7));
    }
    g.push(box(0.3, 0.04, 0.12, 0.72, top + 0.12, 0.0, 0, col('#5a3d26')), box(0.03, 0.12, 0.1, 0.59, top + 0.06, 0, 0, col('#5a3d26')), box(0.03, 0.12, 0.1, 0.85, top + 0.06, 0, 0, col('#5a3d26')));
    for (let i = 0; i < 4; i++) g.push(painted(new THREE.ConeGeometry(0.045, 0.18, 10).rotateX(Math.PI).translate(0.62 + i * 0.07, top + 0.2, 0.0), col('#f1ece2')));
    for (const y of [1.3, 1.65]) for (let i = 0; i < 6; i++) g.push(painted(new THREE.ConeGeometry(0.05, 0.16, 10).translate(-0.8 + i * 0.3, shelf(y) + 0.08, -D + 0.2), col('#f1ece2')));
    g.push(box(0.5, 0.25, 0.3, 0.4, 0.85 + 0.125, -D + 0.35, 0, col('#c9b48a')));
  } else {
    // Trays of baubles, candles of all sizes, wreaths on the back wall, baubles hanging in the opening.
    const tones = ['#9b1218', '#c49a45', '#c9ccd1', '#1f5a34', '#25438f', '#7a1218'];
    for (const tx of [-0.62, -0.18]) {
      g.push(box(0.4, 0.04, 0.3, tx, top + 0.02, -0.05, 0, col('#2a211b')));
      for (let i = 0; i < 12; i++) g.push(ball(0.036, tx - 0.15 + (i % 4) * 0.1, top + 0.075, -0.05 - 0.1 + Math.floor(i / 4) * 0.1, col(tones[(i + (tx < -0.4 ? 0 : 3)) % tones.length]), 10));
    }
    for (let i = 0; i < 9; i++) {
      const h = 0.08 + rand() * 0.2;
      const r = 0.022 + rand() * 0.02;
      g.push(cylinder(r, r, h, 0.3 + (i % 5) * 0.12, top, -0.12 + Math.floor(i / 5) * 0.14, i % 3 === 0 ? col('#a5161c') : i % 3 === 1 ? col('#efe6cf') : col('#e9dcc0')));
    }
    for (const x of [-0.5, 0.5]) {
      g.push(painted(new THREE.TorusGeometry(0.17, 0.055, 8, 18).translate(x, 1.55, -D + 0.09), col('#25402a')));
      g.push(box(0.1, 0.07, 0.03, x, 1.39, -D + 0.12, 0, col('#9b1218')));
    }
    for (const y of [1.25]) for (let i = 0; i < 8; i++) g.push(cylinder(0.03, 0.03, 0.12 + (i % 3) * 0.05, -0.85 + i * 0.24, shelf(y), -D + 0.2, i % 2 ? col('#efe6cf') : col('#a5161c')));
    for (let i = 0; i < 5; i++) {
      const x = -0.8 + i * 0.4;
      const drop = 0.12 + (i % 2) * 0.08;
      g.push(box(0.004, drop, 0.004, x, OPEN_TOP - drop / 2, 0.02, 0, col('#c9a24a')));
      g.push(ball(0.045, x, OPEN_TOP - drop - 0.04, 0.02, col(tones[i % tones.length]), 10));
    }
    g.push(box(0.6, 0.3, 0.35, 0.3, 0.85 + 0.15, -D + 0.35, 0, col('#5b2b22')));
  }
}

/** One chalet's parts, in its own frame. */
function chalet(spot: ChaletSpot, rand: () => number): Parts {
  const p: Parts = { outside: [], roof: [], inside: [], signs: [], garland: new FirCards(), bulbs: [] };
  const stain = '#3e2b1e';
  const hw = W / 2;
  // The floor on its sleepers, the back wall, the sides up to the roof (their boards follow the gable).
  p.outside.push(box(W + 0.06, 0.4, D + 0.06, 0, FLOOR - 0.2, -D / 2, 0, col('#2c1f16')));
  boards(p.outside, -hw, -D + 0.014, hw, -D + 0.014, FLOOR, () => EAVE - FLOOR, rand, stain);
  for (const s of [-1, 1]) {
    boards(p.outside, s * (hw - 0.014), 0, s * (hw - 0.014), -D, FLOOR, (t) => EAVE - FLOOR + (RIDGE - EAVE) * (1 - Math.abs(t - 0.5) * 2) - 0.03, rand, stain);
  }
  // The front: corner posts, boards under the counter, the counter, the fascia above the opening.
  for (const s of [-1, 1]) p.outside.push(box(0.1, EAVE - FLOOR, 0.1, s * (hw - 0.05), FLOOR + (EAVE - FLOOR) / 2, -0.05, 0, col('#2e2017')));
  boards(p.outside, -hw + 0.1, -0.014, hw - 0.1, -0.014, FLOOR, () => COUNTER - FLOOR - 0.03, rand, stain);
  p.outside.push(box(W + 0.12, 0.05, 0.5, 0, COUNTER, -0.03, 0, col('#5c4230')));
  p.outside.push(box(W, EAVE - OPEN_TOP, 0.04, 0, (EAVE + OPEN_TOP) / 2, -0.02, 0, col('#33241a')));
  // The sign stands on the front of the roof, over the garland, in a dark frame.
  const roofTop = RIDGE + 0.03 + 0.065 / Math.cos(PITCH) - (SIGN_Z + D / 2) * Math.tan(PITCH);
  p.outside.push(box(W - 0.1, 0.32, 0.05, 0, roofTop + 0.15, SIGN_Z - 0.025, 0, col('#2a1d14')));
  p.signs.push(signPlane(SIGN_OF[spot.goods], W - 0.2, (W - 0.2) / 8, 0, roofTop + 0.15, SIGN_Z + 0.002));
  if (spot.goods === 'decorations') {
    p.outside.push(box(0.84, 0.22, 0.02, 0, 0.66, 0.008, 0, col('#c9a24a', 0.7)));
    p.signs.push(signPlane(4, 0.8, 0.19, 0, 0.66, 0.02));
  }
  slab(p, true, rand);
  slab(p, false, rand);
  p.roof.push(box(W + OVER_SIDE * 2 + 0.02, 0.07, 0.18, 0, RIDGE + 0.1, -D / 2, 0, col('#2b231d')));
  // Inside: a lighter lining on the walls, the floor's boards, two shelves and a table at the back.
  const lining = '#8a6646';
  p.inside.push(box(W - 0.08, EAVE - FLOOR, 0.012, 0, FLOOR + (EAVE - FLOOR) / 2, -D + 0.036, 0, col(lining)));
  for (const s of [-1, 1]) p.inside.push(box(0.012, EAVE - FLOOR, D - 0.08, s * (hw - 0.036), FLOOR + (EAVE - FLOOR) / 2, -D / 2, 0, col(lining, 0.92)));
  p.inside.push(box(W - 0.08, 0.012, D - 0.08, 0, FLOOR + 0.006, -D / 2, 0, col('#5e4532')));
  for (const y of [1.3, 1.65]) p.inside.push(box(W - 0.12, 0.03, 0.26, 0, y, -D + 0.17, 0, col('#6e5038')));
  p.inside.push(box(W - 0.2, 0.04, 0.5, 0, 0.83, -D + 0.33, 0, col('#5c4230')), box(W - 0.3, 0.7, 0.03, 0, 0.47, -D + 0.56, 0, col('#4a3426')));
  goods(p, spot.goods, rand);
  // The garland along the front eave and up the front of each gable, and the string of lights under it.
  const edgeY = EAVE - OVER_FRONT * Math.tan(PITCH) - 0.05;
  const edgeZ = OVER_FRONT + 0.03;
  const a = new THREE.Vector3(-hw - OVER_SIDE + 0.02, edgeY, edgeZ);
  const b = new THREE.Vector3(hw + OVER_SIDE - 0.02, edgeY, edgeZ);
  rope(p.garland, a, b, 0.06, rand);
  for (const s of [-1, 1]) {
    const up = new THREE.Vector3(s * (hw + OVER_SIDE + 0.03), RIDGE - 0.02, -D / 2 + 0.05);
    const low = new THREE.Vector3(s * (hw + OVER_SIDE + 0.03), edgeY + 0.04, edgeZ - 0.03);
    rope(p.garland, low, up, 0.0, rand);
    stringOf(p.bulbs, low.clone().add(new THREE.Vector3(s * 0.04, -0.06, 0)), up.clone().add(new THREE.Vector3(s * 0.04, -0.07, 0)), 0.02);
  }
  stringOf(p.bulbs, a.clone().add(new THREE.Vector3(0, -0.08, 0.04)), b.clone().add(new THREE.Vector3(0, -0.08, 0.04)), 0.07);
  return p;
}

/** A fir garland from a to b, sagging by `sag` in the middle: cards round its line, turned every way. */
function rope(cards: FirCards, a: THREE.Vector3, b: THREE.Vector3, sag: number, rand: () => number): void {
  const along = new THREE.Vector3().subVectors(b, a);
  const length = along.length();
  along.normalize();
  const n = Math.round(length / 0.032);
  const base = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();
  const ref = Math.abs(along.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const across = new THREE.Vector3().crossVectors(along, ref).normalize();
  const tint = new THREE.Color();
  const centre = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const t = (i + rand() * 0.6) / n;
    base.copy(a).addScaledVector(along, length * t);
    base.y -= sag * 4 * t * (1 - t);
    centre.copy(base);
    const spin = rand() * Math.PI * 2;
    const tilt = 0.5 + rand() * 0.4;
    // Out from the rope's line at an angle, forward along it.
    const radial = across.clone().applyAxisAngle(along, spin);
    dir.copy(along).multiplyScalar(rand() < 0.5 ? 1 : -1).multiplyScalar(Math.cos(tilt)).addScaledVector(radial, Math.sin(tilt)).normalize();
    side.crossVectors(dir, radial).normalize();
    base.addScaledVector(radial, -0.02);
    const l = 0.13 + rand() * 0.06;
    tint.setRGB(0.95 + rand() * 0.1, 0.97 + rand() * 0.08, 0.92 + rand() * 0.1);
    cards.card(base, dir, side, l, l * 0.75, -0.02, [0.62, 1.0], tint, (q) => q.clone().sub(centre).addScaledVector(new THREE.Vector3(0, 1, 0), 0.04).normalize());
  }
}

/** Bulbs along a line from a to b, every 20 cm, sagging by `sag` between hooks a metre apart. */
function stringOf(out: THREE.Vector3[], a: THREE.Vector3, b: THREE.Vector3, sag: number): void {
  const length = a.distanceTo(b);
  const n = Math.max(1, Math.round(length / 0.2));
  const hooks = Math.max(1, Math.round(length / 1.1));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const u = (f * hooks) % 1;
    out.push(new THREE.Vector3().lerpVectors(a, b, f).add(new THREE.Vector3(0, -sag * 4 * u * (1 - u), 0)));
  }
}

/** A sign's face: a plane showing row `row` of the signs' picture (the small last one: its left half). */
function signPlane(row: number, w: number, h: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const small = row === SIGN_ROWS - 1;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (small ? 0.5 : 1), 1 - (row + 1) / SIGN_ROWS + uv.getY(i) / SIGN_ROWS);
  return g.translate(x, y, z);
}

/** The signs' picture: one board a row, painted cream letters on deep green or red, a gold edge and gold stars. */
function signTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIGN_PX.w;
  canvas.height = SIGN_PX.h * SIGN_ROWS;
  const c = canvas.getContext('2d')!;
  const starAt = (x: number, y: number, r: number) => {
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const rr = i % 2 ? r * 0.42 : r;
      c.lineTo(x + Math.sin(a) * rr, y - Math.cos(a) * rr);
    }
    c.closePath();
    c.fill();
  };
  SIGNS.forEach((text, i) => {
    const small = i === SIGN_ROWS - 1;
    const w = small ? SIGN_PX.w / 2 : SIGN_PX.w;
    const y0 = i * SIGN_PX.h;
    c.fillStyle = i % 2 ? '#6a1a1c' : '#1c3a29';
    c.fillRect(0, y0, w, SIGN_PX.h);
    // The wood's grain faintly through the paint.
    for (let k = 0; k < 40; k++) {
      c.fillStyle = `rgba(0, 0, 0, ${0.04 + ((k * 37) % 11) / 200})`;
      c.fillRect(0, y0 + ((k * 53) % SIGN_PX.h), w, 1 + (k % 3));
    }
    c.strokeStyle = '#c9a24a';
    c.lineWidth = 6;
    c.strokeRect(9, y0 + 9, w - 18, SIGN_PX.h - 18);
    c.fillStyle = '#d9b45a';
    if (!small) {
      starAt(58, y0 + SIGN_PX.h / 2, 24);
      starAt(w - 58, y0 + SIGN_PX.h / 2, 24);
    }
    c.fillStyle = '#f3e6c2';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    let size = small ? 64 : 76;
    const font = (s: number) => `italic bold ${s}px Georgia, 'Times New Roman', serif`;
    c.font = font(size);
    while (c.measureText(text).width > w - (small ? 60 : 180) && size > 30) c.font = font((size -= 2));
    c.fillText(text, w / 2, y0 + SIGN_PX.h / 2 + 4);
  });
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A standing table in a stretch cover, white or red, with a small lantern on it. */
function table(out: THREE.BufferGeometry[], x: number, z: number, y: number, red: boolean): void {
  const profile = [[0.3, 0], [0.27, 0.04], [0.13, 0.32], [0.09, 0.58], [0.12, 0.84], [0.36, 1.05], [0.42, 1.085], [0.42, 1.1], [0.0, 1.1]].map(([r, h]) => new THREE.Vector2(r, h));
  out.push(painted(new THREE.LatheGeometry(profile, 20).translate(x, y, z), red ? col('#7c1a1d') : col('#e6e1d6')));
  // The lantern: a base, four slim posts round its glass, a little roof; the flame (a glow) shows between them.
  const black = col('#1f1d1c');
  const turn = 0.4;
  out.push(box(0.12, 0.02, 0.12, x, y + 1.11, z, turn, black), box(0.12, 0.02, 0.12, x, y + 1.27, z, turn, black));
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const px = (u * Math.cos(turn) + v * Math.sin(turn)) * 0.05;
    const pz = (-u * Math.sin(turn) + v * Math.cos(turn)) * 0.05;
    out.push(box(0.012, 0.15, 0.012, x + px, y + 1.19, z + pz, turn, black));
  }
  out.push(painted(new THREE.ConeGeometry(0.09, 0.07, 4).rotateY(Math.PI / 4 + turn).translate(x, y + 1.315, z), black));
}

export interface Market {
  group: THREE.Group;
  /** The bulbs along the eaves and the lanterns' flames, in the world (christmas.ts draws them) */
  bulbs: THREE.Vector3[];
  lanterns: THREE.Vector3[];
  /** The inside's and the signs' glow at night: 0 by day to 1 */
  setGlow(k: number): void;
}

/**
 * The warm light on the ground at night in front of each counter and round each lantern, as the Zombies stall's
 * (world/stall.ts): no real light, a grid laid on the paving that adds a little warm colour, `bright` per corner as the
 * light falls from `from` (its angle, less with the distance squared), faded to nothing at the grid's edge.
 */
function pool(out: THREE.BufferGeometry[], from: THREE.Vector3, at: (u: number, v: number) => [number, number], nu: number, nv: number, gain: number, groundAt: (x: number, z: number) => number): void {
  const pos: number[] = [];
  const bright: number[] = [];
  const index: number[] = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const [x, z] = at(i / nu, j / nv);
      p.set(x, groundAt(x, z) + 0.02, z);
      pos.push(p.x, p.y, p.z);
      const l = from.clone().sub(p);
      const edge = Math.min(i / nu, 1 - i / nu, j / nv, 1 - j / nv) * 2;
      bright.push((gain * Math.max(0, l.y / l.length())) / (l.lengthSq() + 0.5) * THREE.MathUtils.smoothstep(edge, 0, 0.6));
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const c = a + nu + 1;
      index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('bright', new THREE.Float32BufferAttribute(bright, 1));
  g.setIndex(index);
  out.push(g);
}

const poolVertex = /* glsl */ `
  attribute float bright;
  varying float vBright;
  void main() {
    vBright = bright;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const poolFragment = /* glsl */ `
  uniform float strength;
  varying float vBright;
  void main() {
    gl_FragColor = vec4(vec3(1.0, 0.68, 0.38) * vBright * strength, 1.0);
  }`;

/** Build the market where its plan puts it, `groundAt` the ground's height. */
export function buildMarket(groundAt: (x: number, z: number) => number): Market {
  const rand = seeded(1712);
  const all = { outside: [] as THREE.BufferGeometry[], roof: [] as THREE.BufferGeometry[], inside: [] as THREE.BufferGeometry[], signs: [] as THREE.BufferGeometry[], garland: [] as THREE.BufferGeometry[] };
  const bulbs: THREE.Vector3[] = [];
  const pools: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  for (const spot of CHALETS) {
    const p = chalet(spot, rand);
    // The floor level with the highest corner of the ground under it.
    const fx = Math.sin(spot.face);
    const fz = Math.cos(spot.face);
    let y = -Infinity;
    for (const [u, v] of [[-1, 0], [1, 0], [-1, -1], [1, -1]]) y = Math.max(y, groundAt(spot.x + fz * u * (W / 2) + fx * v * D, spot.z - fx * u * (W / 2) + fz * v * D));
    m.makeRotationY(spot.face).setPosition(spot.x, y, spot.z);
    for (const k of ['outside', 'roof', 'inside', 'signs'] as const) for (const g of p[k]) all[k].push(g.applyMatrix4(m));
    all.garland.push(p.garland.geometry().applyMatrix4(m));
    for (const b of p.bulbs) bulbs.push(b.applyMatrix4(m));
    // The pool before the counter: from the lit inside and the bulbs over it, out to some 3 m.
    const light = new THREE.Vector3(0, 1.9, 0.3).applyMatrix4(m);
    pool(pools, light, (u, v) => {
      const across = (u - 0.5) * 3.4;
      const out = 0.25 + v * 3.0;
      return [spot.x + fz * across + fx * out, spot.z - fx * across + fz * out];
    }, 8, 8, 0.18, groundAt);
  }
  const lanterns: THREE.Vector3[] = [];
  TABLES.forEach((t, i) => {
    const y = groundAt(t.x, t.z);
    table(all.outside, t.x, t.z, y, i === 1);
    lanterns.push(new THREE.Vector3(t.x, y + 1.19, t.z));
    pool(pools, new THREE.Vector3(t.x, y + 1.19, t.z), (u, v) => [t.x + (u - 0.5) * 2.6, t.z + (v - 0.5) * 2.6], 6, 6, 0.08, groundAt);
  });
  const group = new THREE.Group();
  group.name = 'christmas-market';
  const outside = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 });
  const roof = snowy(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
  const glow = { value: 0 };
  const inside = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  inside.onBeforeCompile = (shader) => {
    // Lit from within at night: a warm glow in the surfaces' own colours, no real light.
    shader.uniforms.lampGlow = glow;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float lampGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.72, 0.42) * lampGlow;');
  };
  inside.customProgramCacheKey = () => 'marketInside';
  const signMap = signTexture();
  const signs = new THREE.MeshStandardMaterial({ map: signMap, roughness: 0.6, emissiveMap: signMap, emissive: new THREE.Color(1, 0.85, 0.65), emissiveIntensity: 0 });
  const meshes: [THREE.BufferGeometry[], THREE.Material][] = [
    [all.outside, outside],
    [all.roof, roof],
    [all.inside, inside],
    [all.signs, signs],
    [all.garland, firMaterial()],
  ];
  for (const [parts, material] of meshes) {
    const mesh = new THREE.Mesh(mergeGeometries(parts)!, material);
    for (const g of parts) g.dispose();
    mesh.userData.ignoreRay = true;
    group.add(mesh);
  }
  const poolMaterial = new THREE.ShaderMaterial({
    uniforms: { strength: { value: 0 } },
    vertexShader: poolVertex,
    fragmentShader: poolFragment,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const lit = new THREE.Mesh(mergeGeometries(pools)!, poolMaterial);
  for (const g of pools) g.dispose();
  lit.userData.ignoreRay = true;
  lit.userData.noAO = true;
  lit.raycast = () => {};
  lit.renderOrder = 60; // after the paving it lights
  group.add(lit);
  return {
    group,
    bulbs,
    lanterns,
    setGlow(k: number) {
      glow.value = 0.55 * k;
      signs.emissiveIntensity = 0.5 * k;
      poolMaterial.uniforms.strength.value = k;
      lit.visible = k > 0.02;
    },
  };
}
