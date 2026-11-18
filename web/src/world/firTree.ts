import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { snowy } from './snowCover';

/**
 * The Christmas tree on the church square as a real Nordmann fir, the tree Flemish villages put up on their square
 * (world/christmas.ts places it and lights it): a straight trunk to the tip, whorls of near-level branches that
 * droop a little and lift at their ends, longest at the bottom, each branch a flat fan of shoots thick with glossy
 * dark needles, lighter at the tips. It stands in a wooden box of boards.
 *
 * The needles are cards: small pictures of a fir's shoot seen from above, cut out (alpha-tested, nothing blended),
 * some 2000 of them laid along the branches, out to their sides and hanging a little below them, and a ring of dark
 * ones round the trunk so you can't see through the tree. The picture is painted here in code when the tree is
 * built (nothing to download): one shoot of 512 px, in colour. Its smaller copies (mipmaps) are made here too,
 * keeping as much of the shoot solid as up close, or a far tree would thin to a few specks (as world/leafCards.ts).
 * The garlands on the market's stalls (world/christmasMarket.ts) are the same cards on the same material.
 *
 * Each card corner carries a shade (darker deep in the crown and towards the trunk, lighter at the tips) and a
 * normal pointing out of the crown, not out of the card, so the light falls on the tree as one soft cone, the sun's
 * side lit. Snow lies on it in clumps where the cards face up (world/snowCover.ts, as the conifers).
 *
 * Draw calls: the needles (one, both sides), the trunk and its box (one), the baubles (two: glossy glass and matt).
 * Nothing in it is a real light; the bulbs on it are christmas.ts's glows.
 */

/** Pixels of the shoot's picture, square. */
const TEX = 512;
/** Where a card's picture is cut. */
const CUT = 0.5;

/** A small random number generator with a seed, so the tree is the same for everyone. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * A Nordmann fir's shoot seen from above, its base at the picture's top middle (v = 0) and its tip at the bottom
 * (v = 1): a twig down the middle, side shoots in a flat fan swept forward, a few small shoots off those, and on every
 * shoot flat needles in two combed rows, pointing out and a little forward, more over the twig. Dark glossy green,
 * the last few centimetres of each shoot (this year's growth) a little lighter.
 */
function paintShoot(rand: () => number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX;
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.lineCap = 'round';
  type Shoot = { pts: [number, number][]; width: number; needle: number };
  const shoots: Shoot[] = [];
  const bend = (x: number, y: number, a: number, len: number, curl: number, steps: number): [number, number][] => {
    const pts: [number, number][] = [[x, y]];
    for (let i = 0; i < steps; i++) {
      a += curl;
      x += Math.sin(a) * (len / steps);
      y += Math.cos(a) * (len / steps);
      pts.push([x, y]);
    }
    return pts;
  };
  const at = (pts: [number, number][], t: number): [number, number, number] => {
    const f = Math.min(pts.length - 1.001, t * (pts.length - 1));
    const i = Math.floor(f);
    const k = f - i;
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, Math.atan2(x1 - x0, y1 - y0)];
  };
  const main = bend(TEX / 2, 6, (rand() - 0.5) * 0.06, TEX * 0.94, (rand() - 0.5) * 0.008, 16);
  shoots.push({ pts: main, width: 4.5, needle: 1 });
  for (let i = 0; i < 12; i++) {
    const t = 0.05 + i * 0.07;
    const [x, y, a] = at(main, t);
    for (const side of [-1, 1]) {
      // The fan is widest two thirds out, and narrows to the leading shoot's tip.
      const reach = TEX * 0.43 * Math.pow(Math.sin(Math.PI * (0.1 + 0.78 * t)), 0.7) * (0.85 + rand() * 0.25);
      const s = bend(x, y, a + side * (0.82 + rand() * 0.2), reach, -side * 0.035, 8);
      shoots.push({ pts: s, width: 2.6, needle: 0.9 });
      if (reach > 90) {
        for (const u of [0.35, 0.65]) {
          const [sx, sy, sa] = at(s, u);
          shoots.push({ pts: bend(sx, sy, sa + side * (0.75 + rand() * 0.2), reach * (0.32 - u * 0.12), 0, 4), width: 1.6, needle: 0.72 });
        }
      }
    }
  }
  // The twigs first, a green-brown under the needles.
  for (const s of shoots) {
    c.strokeStyle = 'rgb(74, 66, 40)';
    c.lineWidth = s.width;
    c.beginPath();
    s.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.stroke();
  }
  // Then the needles: two combed rows out to the sides, and a shorter layer over the twig, pointing forward.
  const needle = (x: number, y: number, a: number, len: number, light: number, fresh: number) => {
    const r = Math.round((22 + 24 * light) * (1 + fresh * 0.45));
    const g = Math.round((54 + 42 * light) * (1 + fresh * 0.3));
    const b = Math.round((30 + 14 * light) * (1 + fresh * 0.05));
    const ex = x + Math.sin(a) * len;
    const ey = y + Math.cos(a) * len;
    c.strokeStyle = `rgb(${r}, ${g}, ${b})`;
    c.lineWidth = 3.4;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(ex, ey);
    c.stroke();
    // The gloss down one edge of the flat needle.
    c.strokeStyle = `rgba(${Math.min(255, r + 55)}, ${Math.min(255, g + 60)}, ${Math.min(255, b + 45)}, 0.55)`;
    c.lineWidth = 1.1;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * 0.8, y - Math.sin(a) * 0.8);
    c.lineTo(ex + Math.cos(a) * 0.8, ey - Math.sin(a) * 0.8);
    c.stroke();
  };
  for (const s of shoots) {
    const [x0, y0] = s.pts[0];
    const [x1, y1] = s.pts[s.pts.length - 1];
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(4, Math.round(length / 3));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const [x, y, a] = at(s.pts, t);
      const fresh = Math.max(0, (t - 0.72) / 0.28);
      const len = (20 + rand() * 7) * s.needle * (t > 0.92 ? 0.75 : 1);
      for (const side of [-1, 1]) needle(x, y, a + side * (1.05 + rand() * 0.3), len, 0.25 + rand() * 0.45, fresh);
    }
    for (let i = 0; i <= steps; i += 2) {
      const t = i / steps;
      const [x, y, a] = at(s.pts, t);
      const fresh = Math.max(0, (t - 0.72) / 0.28);
      for (const side of [-1, 1]) needle(x, y, a + side * (0.35 + rand() * 0.25), 12 * s.needle, 0.55 + rand() * 0.4, fresh);
    }
  }
  return c.getImageData(0, 0, TEX, TEX);
}

/**
 * The picture's smaller copies, down to one pixel. Colour averaged over what is covered; coverage scaled so that the
 * same share of each copy is solid as of the full picture (left to the chip, the shoot thins out with distance).
 * Uncovered pixels take the shoot's average colour, so nothing dark bleeds in at the outline.
 */
function mipmaps(img: ImageData): { data: Uint8Array; width: number; height: number }[] {
  const n = TEX * TEX;
  const src = img.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  let solid = 0;
  for (let k = 0; k < n; k++) {
    const a = src[k * 4 + 3] / 255;
    r += src[k * 4] * a;
    g += src[k * 4 + 1] * a;
    b += src[k * 4 + 2] * a;
    w += a;
    if (a > CUT) solid++;
  }
  const mean = [r / w, g / w, b / w];
  const share = solid / n;
  let level = { size: TEX, rgb: new Float32Array(n * 3), a: new Float32Array(n) };
  for (let k = 0; k < n; k++) {
    const a = src[k * 4 + 3] / 255;
    level.a[k] = a;
    for (let i = 0; i < 3; i++) level.rgb[k * 3 + i] = a > 0.02 ? src[k * 4 + i] : mean[i];
  }
  const out: { data: Uint8Array; width: number; height: number }[] = [];
  const pack = (l: typeof level, scale: number) => {
    const data = new Uint8Array(l.size * l.size * 4);
    for (let k = 0; k < l.size * l.size; k++) {
      data[k * 4] = l.rgb[k * 3];
      data[k * 4 + 1] = l.rgb[k * 3 + 1];
      data[k * 4 + 2] = l.rgb[k * 3 + 2];
      data[k * 4 + 3] = Math.min(255, Math.round(l.a[k] * scale * 255));
    }
    return { data, width: l.size, height: l.size };
  };
  out.push(pack(level, 1));
  while (level.size > 1) {
    const s = level.size / 2;
    const next = { size: s, rgb: new Float32Array(s * s * 3), a: new Float32Array(s * s) };
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        let wa = 0;
        const c = [0, 0, 0];
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const k = (y * 2 + dy) * level.size + (x * 2 + dx);
          const a = level.a[k] + 0.001;
          wa += level.a[k];
          for (let i = 0; i < 3; i++) c[i] += level.rgb[k * 3 + i] * a;
        }
        const q = y * s + x;
        const sum = wa + 0.004;
        for (let i = 0; i < 3; i++) next.rgb[q * 3 + i] = c[i] / sum;
        next.a[q] = wa / 4;
      }
    }
    level = next;
    // The scale that keeps the solid share: halve the range a dozen times.
    let lo = 1;
    let hi = 12;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      let count = 0;
      for (let k = 0; k < s * s; k++) if (level.a[k] * mid > CUT) count++;
      if (count / (s * s) < share) lo = mid;
      else hi = mid;
    }
    out.push(pack(level, (lo + hi) / 2));
  }
  return out;
}

let shootTexture: THREE.DataTexture | null = null;
let material: THREE.MeshStandardMaterial | null = null;
let levels: ReturnType<typeof mipmaps> | null = null;

/** The shoot's picture painted ahead, its painting and its smaller copies in frames of their own (some 60 ms in all). */
export async function paintFir(): Promise<void> {
  if (levels || shootTexture) return;
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
  await frame();
  const image = paintShoot(seeded(2412));
  await frame();
  levels ??= mipmaps(image);
}

/** The fir's needle cards' material, the same for the tree and the stalls' garlands (painted now if not ahead). */
export function firMaterial(): THREE.MeshStandardMaterial {
  if (material) return material;
  if (!shootTexture) {
    levels ??= mipmaps(paintShoot(seeded(2412)));
    const t = new THREE.DataTexture(levels[0].data, TEX, TEX, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.mipmaps = levels;
    t.generateMipmaps = false;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = 4;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    shootTexture = t;
  }
  const m = new THREE.MeshStandardMaterial({ map: shootTexture, alphaTest: CUT, side: THREE.DoubleSide, vertexColors: true, roughness: 0.82 });
  m.onBeforeCompile = (shader) => {
    // The same normal on both sides of a card: the crown's, not the card's face turned to the eye.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\nnonPerturbedNormal = normal;\n#endif',
    );
  };
  m.customProgramCacheKey = () => 'firCards';
  material = snowy(m, { amount: 0.85, steep: true });
  return material;
}

/** Cards of needles, each two segments (it can bend), gathered into one geometry. */
export class FirCards {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  /**
   * A card from `base` along `dir` (unit), `len` long and `width` wide, its face across `side` (unit, square to
   * dir); its tip bent by `bend` along the face's normal (negative: down). `shade` at the base and the tip, `out`
   * the normal for the light at each row (the crown's, see above).
   */
  card(base: THREE.Vector3, dir: THREE.Vector3, side: THREE.Vector3, len: number, width: number, bend: number, shade: [number, number], tint: THREE.Color, out: (p: THREE.Vector3) => THREE.Vector3): void {
    const n = new THREE.Vector3().crossVectors(side, dir).normalize();
    const first = this.pos.length / 3;
    const p = new THREE.Vector3();
    for (let row = 0; row < 3; row++) {
      const f = row / 2;
      const along = len * f;
      const drop = bend * f * f;
      const shadeAt = shade[0] + (shade[1] - shade[0]) * f;
      for (let col = 0; col < 2; col++) {
        const u = col;
        p.copy(base).addScaledVector(dir, along).addScaledVector(side, (u - 0.5) * width * (0.75 + 0.25 * f)).addScaledVector(n, drop);
        const o = out(p);
        this.pos.push(p.x, p.y, p.z);
        this.nor.push(o.x, o.y, o.z);
        this.uv.push(u, f);
        this.col.push(tint.r * shadeAt, tint.g * shadeAt, tint.b * shadeAt);
      }
    }
    for (let row = 0; row < 2; row++) {
      const a = first + row * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  get count(): number {
    return this.idx.length / 12;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** The tree's size: to the top of the leading shoot (the topper above it), and the crown's lowest branches. */
export const FIR_H = 8.2;
const CROWN_FROM = 0.78;
/** The box of boards round the foot: its radius (to the boards' outside) and height. */
export const BOX_R = 0.95;
const BOX_H = 0.58;

/** The crown's outline: its radius at a height above the ground (to the branch tips). */
export function firRadius(y: number): number {
  const f = (y - CROWN_FROM) / (FIR_H - CROWN_FROM);
  return f < 0 || f > 1 ? 0 : 2.3 * Math.pow(1 - f, 0.92) + 0.06;
}

/** Spots on the tree (in its own frame, the trunk's foot at the origin) for the lights and baubles. */
export interface FirSpots {
  /** Branch tips, outermost first along each branch: where a bulb or a bauble can hang */
  tips: THREE.Vector3[];
}

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = v3(0, 1, 0);

/** The crown's needle cards, in the tree's frame. */
function crown(rand: () => number, spots: FirSpots): THREE.BufferGeometry {
  const cards = new FirCards();
  const tint = new THREE.Color();
  // The light's normal: out of the cone and up, more up near the top.
  // The light's normal: out of the cone and up (more up near the top) on the branches' upper faces; flatter on the
  // side shoots and turned out and down on the hanging ones, which snow then leaves green (world/snowCover.ts).
  const facing = (up: number) => (p: THREE.Vector3) => {
    const r = Math.hypot(p.x, p.z) || 1;
    return v3((p.x / r) * 0.85, up + 0.3 * (p.y / FIR_H), (p.z / r) * 0.85).normalize();
  };
  const out = facing(0.5);
  const outSide = facing(0.12);
  const outLow = facing(-0.55);
  const tone = () => tint.setRGB(0.92 + rand() * 0.1, 0.95 + rand() * 0.1, 0.9 + rand() * 0.1);
  const dir = v3();
  const side = v3();
  const base = v3();
  const tip = v3();
  /** One branch from the trunk at height y, outwards at angle a, `reach` long, rising by `rise` at its tip. */
  const branch = (y: number, a: number, reach: number, rise: number, small: boolean) => {
    const out2 = v3(Math.cos(a), 0, Math.sin(a));
    const across = v3(-Math.sin(a), 0, Math.cos(a));
    const sag = reach * 0.1 * (1 - y / FIR_H);
    const at = (s: number, p: THREE.Vector3) => p.set(out2.x * reach * s, y + rise * s - sag * Math.sin(Math.PI * s), out2.z * reach * s);
    const n = Math.max(1, Math.round(reach / (small ? 0.32 : 0.26)));
    const cardLen = Math.min(0.5, Math.max(0.24, (reach / n) * 1.7));
    const deep = (s: number) => 0.5 + 0.5 * s; // darker towards the trunk
    const span = cardLen / reach;
    const last = Math.max(0.1, 1 - span);
    for (let i = 0; i < n; i++) {
      const s0 = n === 1 ? last : 0.1 + (last - 0.1) * (i / (n - 1));
      at(s0, base);
      at(Math.min(1, s0 + span), tip);
      dir.subVectors(tip, base).normalize();
      const roll = (rand() - 0.5) * 0.7;
      side.copy(across).applyAxisAngle(dir, roll);
      const s1 = s0 + span;
      const lift = y / FIR_H;
      cards.card(base, dir, side, cardLen, cardLen * (0.8 + rand() * 0.2), -0.05 - rand() * 0.06 + lift * 0.05, [deep(s0) * 0.78, deep(s1) * (1.0 + rand() * 0.12)], tone(), out);
      // Side shoots fanning out from the branch's outer part, a little lower.
      if (s0 > 0.25) {
        for (const k of [-1, 1]) {
          if (small && rand() < 0.5) continue;
          const turn = k * (0.55 + rand() * 0.35);
          dir.copy(out2).applyAxisAngle(UP, turn);
          const down = 0.12 + rand() * 0.25;
          dir.y = (rise / reach) * 0.5 - down;
          dir.normalize();
          side.crossVectors(UP, dir).normalize().applyAxisAngle(dir, (rand() - 0.5) * 0.8);
          at(s0 + 0.1 * rand(), base);
          const l = cardLen * (0.55 + rand() * 0.3);
          cards.card(base, dir, side, l, l * 0.85, -0.04, [deep(s0) * 0.72, deep(s1) * (0.95 + rand() * 0.12)], tone(), outSide);
        }
      }
      // Below the lower two thirds' branches, shoots hanging out and down: from the side the tree reads full.
      if (!small && s0 > 0.4 && y < FIR_H * 0.75 && rand() < 0.75) {
        dir.copy(out2).applyAxisAngle(UP, (rand() - 0.5) * 0.6);
        dir.y = -(0.55 + rand() * 0.45);
        dir.normalize();
        side.crossVectors(UP, dir).normalize();
        at(s0 + 0.05, base);
        const l = cardLen * (0.6 + rand() * 0.25);
        cards.card(base, dir, side, l, l * 0.9, 0.03, [deep(s0) * 0.62, deep(s1) * 0.9], tone(), outLow);
      }
    }
    at(0.97, tip);
    spots.tips.push(tip.clone());
  };
  // The whorls, a year's growth apart, five or six branches each and a few smaller ones between.
  let y = CROWN_FROM + 0.05;
  while (y < FIR_H - 0.55) {
    const top = y / FIR_H;
    const count = top > 0.85 ? 5 : 6 + (rand() < 0.5 ? 1 : 0);
    const turn = rand() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = turn + (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.4;
      const reach = firRadius(y) * (0.92 + rand() * 0.12);
      const rise = reach * (-0.16 + 0.75 * Math.pow(top, 1.4));
      branch(y, a, reach, rise, false);
    }
    const gap = 0.36 - top * 0.12 + (rand() - 0.5) * 0.05;
    for (let i = 0; i < 4; i++) {
      const yy = y + gap * (0.35 + rand() * 0.3);
      const reach = firRadius(yy) * (0.6 + rand() * 0.25);
      branch(yy, rand() * Math.PI * 2, reach, reach * (-0.1 + 0.6 * top), true);
    }
    // Dark shoots close round the trunk: nothing to see through.
    for (let i = 0; i < 6; i++) {
      const a = turn + ((i + 0.5) / 6) * Math.PI * 2;
      const r = firRadius(y) * (0.35 + rand() * 0.2);
      base.set(Math.cos(a) * r, y - 0.1, Math.sin(a) * r);
      dir.set(-Math.sin(a), 0, Math.cos(a));
      base.addScaledVector(dir, -0.3);
      const l = Math.max(0.3, Math.min(0.75, r * 1.2));
      cards.card(base, dir, side.set(0, 1, 0), l, Math.min(0.5, gap * 1.6), 0, [0.42, 0.5], tone(), outLow);
    }
    y += gap;
  }
  // The leading shoot: a few upright cards round the trunk's tip, under the topper.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.3;
    dir.set(Math.cos(a) * 0.18, 1, Math.sin(a) * 0.18).normalize();
    side.set(-Math.sin(a), 0, Math.cos(a));
    cards.card(base.set(0, FIR_H - 0.75, 0), dir, side, 0.75, 0.32, 0, [0.85, 1.12], tone(), out);
  }
  // Cut shoots laid in the box over the soil.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + rand() * 0.4;
    dir.set(Math.cos(a), -0.05, Math.sin(a)).normalize();
    side.set(-Math.sin(a), 0, Math.cos(a));
    cards.card(base.set(Math.cos(a) * 0.12, BOX_H - 0.03, Math.sin(a) * 0.12), dir, side, BOX_R * 0.85, 0.5, -0.06, [0.75, 1.0], tone(), out);
  }
  return cards.geometry();
}

/** A box with its corners' colours, as part of a merged geometry. */
export function box(w: number, h: number, d: number, x: number, y: number, z: number, ry: number, colour: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateY(ry);
  g.translate(x, y, z);
  return painted(g, colour);
}

/** A geometry with one colour on every corner, its texture coordinates dropped (for merging). */
export function painted(g: THREE.BufferGeometry, colour: THREE.Color): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([colour.r, colour.g, colour.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** The trunk and the box of boards it stands in. */
function wood(rand: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const bark = new THREE.Color('#4a3527');
  parts.push(painted(new THREE.CylinderGeometry(0.03, 0.14, FIR_H - 0.3, 10, 1).translate(0, (FIR_H - 0.3) / 2, 0), bark));
  // Eight sides of upright boards, a rim along their top, a post at each corner: boards stained a warm brown.
  const sides = 8;
  const apothem = BOX_R * Math.cos(Math.PI / sides);
  const sideW = 2 * BOX_R * Math.sin(Math.PI / sides);
  for (let i = 0; i < sides; i++) {
    const a = ((i + 0.5) / sides) * Math.PI * 2;
    const ry = -a + Math.PI / 2;
    const ox = Math.cos(a);
    const oz = Math.sin(a);
    const boards = 3;
    for (let k = 0; k < boards; k++) {
      const t = ((k + 0.5) / boards - 0.5) * sideW;
      const c = new THREE.Color('#6a4a30').multiplyScalar(0.82 + rand() * 0.3);
      parts.push(box(sideW / boards - 0.012, BOX_H, 0.035, ox * (apothem - 0.02) - oz * t, BOX_H / 2, oz * (apothem - 0.02) + ox * t, ry, c));
    }
    parts.push(box(sideW + 0.03, 0.05, 0.11, ox * (apothem - 0.03), BOX_H + 0.02, oz * (apothem - 0.03), ry, new THREE.Color('#4f3523')));
    const p = ((i + 1) / sides) * Math.PI * 2;
    parts.push(box(0.08, BOX_H + 0.08, 0.08, Math.cos(p) * (BOX_R - 0.02), (BOX_H + 0.08) / 2, Math.sin(p) * (BOX_R - 0.02), -p, new THREE.Color('#43301f')));
  }
  // The soil inside, mostly under the cut shoots.
  parts.push(painted(new THREE.CylinderGeometry(apothem - 0.07, apothem - 0.07, 0.04, sides, 1).translate(0, BOX_H - 0.06, 0), new THREE.Color('#2f241b')));
  return mergeGeometries(parts)!;
}

/** A five-pointed star with depth, gold: the topper. Its front faces +x. */
function star(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 ? 0.13 : 0.32;
    if (i === 0) shape.moveTo(Math.sin(a) * r, Math.cos(a) * r);
    else shape.lineTo(Math.sin(a) * r, Math.cos(a) * r);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.03, bevelSegments: 2 });
  g.translate(0, 0, -0.025);
  g.rotateY(Math.PI / 2);
  return g;
}

export interface Fir {
  group: THREE.Group;
  /** The topper's material (it glows at night) and where its middle is, in the tree's frame */
  starMaterial: THREE.MeshStandardMaterial;
  starAt: THREE.Vector3;
  spots: FirSpots;
}

/**
 * Build the fir in its own frame (the trunk's foot at the origin): crown, trunk and box, baubles and topper. `face`:
 * the angle (radians, about up) the topper faces, from +x.
 */
export function buildFir(seed: number, face: number): Fir {
  const rand = seeded(seed);
  const group = new THREE.Group();
  group.name = 'christmas-fir';
  const spots: FirSpots = { tips: [] };
  const needles = new THREE.Mesh(crown(rand, spots), firMaterial());
  const trunk = new THREE.Mesh(wood(rand), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 }));
  // Baubles: a modest number on the branch tips of the lower three quarters, big ones as on a village tree.
  // Glass: deep red and champagne, glossy; and matt gold and dark red.
  const glossy = new THREE.MeshStandardMaterial({ roughness: 0.14, metalness: 0.6 });
  const matt = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 });
  const ball = new THREE.SphereGeometry(1, 14, 10);
  const tips = spots.tips.filter((p) => p.y > 1.1 && p.y < FIR_H - 1.3);
  const chosen: THREE.Vector3[] = [];
  for (const p of tips) if (rand() < 0.42 && chosen.every((q) => q.distanceTo(p) > 0.55)) chosen.push(p);
  const glossyN = Math.ceil(chosen.length * 0.55);
  const glass = new THREE.InstancedMesh(ball, glossy, glossyN);
  const dull = new THREE.InstancedMesh(ball, matt, chosen.length - glossyN);
  const m = new THREE.Matrix4();
  const red = new THREE.Color('#7d0c12');
  const champagne = new THREE.Color('#cdbf9f');
  const gold = new THREE.Color('#b08a3e');
  const wine = new THREE.Color('#5e1016');
  chosen.forEach((p, i) => {
    const r = (0.06 + rand() * 0.025) * (1 + (1 - p.y / FIR_H) * 0.25);
    const pull = 0.92; // a little in from the very tip, under its needles
    m.makeScale(r, r, r).setPosition(p.x * pull, p.y - r - 0.06, p.z * pull);
    if (i < glossyN) {
      glass.setMatrixAt(i, m);
      glass.setColorAt(i, i % 3 === 2 ? champagne : red);
    } else {
      const k = i - glossyN;
      dull.setMatrixAt(k, m);
      dull.setColorAt(k, k % 4 === 3 ? wine : gold);
    }
  });
  // The topper: a gold star on the leading shoot.
  const starMaterial = new THREE.MeshStandardMaterial({ color: '#e9c46a', metalness: 0.65, roughness: 0.28, emissive: new THREE.Color('#ffb347'), emissiveIntensity: 0.1 });
  const topper = new THREE.Mesh(star(), starMaterial);
  const starAt = v3(0, FIR_H + 0.25, 0);
  topper.position.copy(starAt);
  topper.rotation.y = -face;
  for (const o of [needles, trunk, glass, dull, topper]) {
    o.userData.ignoreRay = true;
    o.castShadow = o === needles || o === trunk;
    o.receiveShadow = true;
    group.add(o);
  }
  return { group, starMaterial, starAt, spots };
}
