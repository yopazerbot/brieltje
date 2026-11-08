import * as THREE from 'three';

/**
 * The faces of the signs along the streets (world/roadside.ts), drawn in code on one canvas: the street
 * name plates, the traffic signs of the road agency's register (tools/roads.py) as the Belgian rules
 * draw them, the bus stop's plate and timetable, and each sign's plain grey back in its own outline.
 *
 * Each face asks for a cell (FaceSheet.add); `build` packs them into rows on a canvas 1024 wide and as
 * high as needed (a power of two, at most 1024; all cells smaller when they don't fit), and gives each cell's part of the picture. Round,
 * triangular and arrow-shaped signs are transparent round their outline (the material's alphaTest).
 */

/** A part of the picture: u, v, width, height (0..1, v up). */
export type Rect = [number, number, number, number];
type Draw = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;

const W = 1024;
const MAX_H = 1024; // 4 MB with its mipmaps' 1.3 MB more: the phones' graphics memory
const PAD = 4;

export class FaceSheet {
  private items = new Map<string, { w: number; h: number; draw: Draw }>();

  /** A cell of w x h pixels (at full size) drawn by `draw`, once per key. */
  add(key: string, w: number, h: number, draw: Draw): string {
    if (!this.items.has(key)) this.items.set(key, { w: Math.max(8, w), h: Math.max(8, h), draw });
    return key;
  }

  build(): { texture: THREE.CanvasTexture; rects: Map<string, Rect> } {
    const list = [...this.items].sort((a, b) => b[1].h - a[1].h || b[1].w - a[1].w);
    // Rows of cells, the tallest first; smaller all over when they don't fit.
    let scale = 1;
    let at = new Map<string, [number, number, number, number]>();
    let height = 0;
    for (;;) {
      at = new Map();
      let x = 0, y = 0, row = 0;
      for (const [key, it] of list) {
        const w = Math.min(W - PAD, Math.round(it.w * scale)), h = Math.round(it.h * scale);
        if (x + w + PAD > W) {
          x = 0;
          y += row + PAD;
          row = 0;
        }
        at.set(key, [x + PAD / 2, y + PAD / 2, w, h]);
        x += w + PAD;
        row = Math.max(row, h);
      }
      height = y + row + PAD;
      if (height <= MAX_H || scale < 0.3) break;
      scale *= 0.85;
    }
    const H = Math.min(MAX_H, 2 ** Math.ceil(Math.log2(Math.max(64, height))));
    const c = document.createElement('canvas');
    [c.width, c.height] = [W, H];
    const g = c.getContext('2d')!;
    const rects = new Map<string, Rect>();
    for (const [key, [x, y, w, h]] of at) {
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
      this.items.get(key)!.draw(g, x, y, w, h);
      g.restore();
      rects.set(key, [x / W, 1 - (y + h) / H, w / W, h / H]);
    }
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return { texture, rects };
  }
}

// ---------------------------------------------------------------- outlines

export type Outline = 'rect' | 'round' | 'triUp' | 'triDown' | 'oct' | 'diamond' | 'hex' | 'arrowL' | 'arrowR';

/** A sign's outline from its code and the register's shape (vorm): rh, dh, ro, wwl, wwr, zh. */
export function outlineOf(code: string, shape: string): Outline {
  if (code === 'B1') return 'triDown';
  if (code === 'B5') return 'oct';
  if (code === 'B9' || code === 'B11') return 'diamond';
  switch (shape) {
    case 'dh': return 'triUp';
    case 'ro': return 'round';
    case 'wwl': return 'arrowL';
    case 'wwr': return 'arrowR';
    case 'zh': return 'hex';
    case 'ac': case 'oh': return 'oct';
    case 'ru': return 'diamond';
    default: return 'rect';
  }
}

/** The outline's corners in the unit square (none for the round one). */
function corners(o: Outline, w: number, h: number): [number, number][] {
  const t = Math.min(0.3, (0.5 * h) / w); // an arrow's point
  switch (o) {
    case 'triUp': return [[0.5, 0.067], [1, 0.933], [0, 0.933]];
    case 'triDown': return [[0, 0.067], [1, 0.067], [0.5, 0.933]];
    case 'oct': return [[0.293, 0], [0.707, 0], [1, 0.293], [1, 0.707], [0.707, 1], [0.293, 1], [0, 0.707], [0, 0.293]];
    case 'diamond': return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
    case 'hex': return [[0.5, 0], [1, 0.25], [1, 0.75], [0.5, 1], [0, 0.75], [0, 0.25]];
    case 'arrowL': return [[0, 0.5], [t, 0], [1, 0], [1, 1], [t, 1]];
    case 'arrowR': return [[0, 0], [1 - t, 0], [1, 0.5], [1 - t, 1], [0, 1]];
    default: return [[0, 0], [1, 0], [1, 1], [0, 1]];
  }
}

/** Fill the outline in the box, `inset` pixels in from its edge. */
function fillOutline(g: CanvasRenderingContext2D, o: Outline, x: number, y: number, w: number, h: number, inset: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  if (o === 'round') {
    g.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2 - inset), Math.max(1, h / 2 - inset), 0, 0, Math.PI * 2);
  } else {
    const v = corners(o, w, h);
    const cx = v.reduce((s, p) => s + p[0], 0) / v.length, cy = v.reduce((s, p) => s + p[1], 0) / v.length;
    // Triangles shrink more than their box to keep the border even along the slanted sides.
    const k = o === 'triUp' || o === 'triDown' ? 2 : 1;
    const kx = 1 - (2 * inset * k) / w, ky = 1 - (2 * inset * k) / h;
    v.forEach(([px, py], i) => {
      const X = x + (cx + (px - cx) * kx) * w, Y = y + (cy + (py - cy) * ky) * h;
      if (i) g.lineTo(X, Y);
      else g.moveTo(X, Y);
    });
    g.closePath();
  }
  g.fill();
}

/** The back of a sign: plain grey in the outline (an arrow's back points the other way, as seen from behind). */
export function drawBack(o: Outline): Draw {
  const seen: Outline = o === 'arrowL' ? 'arrowR' : o === 'arrowR' ? 'arrowL' : o;
  return (g, x, y, w, h) => fillOutline(g, seen, x, y, w, h, 0, '#8c9298');
}

// ---------------------------------------------------------------- text

const RED = '#c8102e', BLUE = '#1d4f9c', WHITE = '#f5f5f0', BLACK = '#141414', GREEN = '#1f7a3a', YELLOW = '#ffd100', GREY = '#9a9c9e';
const font = (px: number, bold = true) => `${bold ? 'bold ' : ''}${Math.max(6, Math.round(px))}px Arial, Helvetica, sans-serif`;

/** Text centred at (cx, cy), at most `px` high and `maxW` wide. */
function text(g: CanvasRenderingContext2D, s: string, cx: number, cy: number, maxW: number, px: number, color: string, bold = true): void {
  if (!s) return;
  g.font = font(px, bold);
  const wide = g.measureText(s).width;
  if (wide > maxW) g.font = font((px * maxW) / wide, bold);
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(s, cx, cy);
}

/** Lines of text spread down the box. */
function lines(g: CanvasRenderingContext2D, ls: string[], x: number, y: number, w: number, h: number, color: string): void {
  if (!ls.length) return;
  const step = h / ls.length;
  ls.forEach((l, i) => text(g, l, x + w / 2, y + step * (i + 0.55), w, step * 0.72, color));
}

/** A plain plate: white, a black edge, its lines of text. */
function plain(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ls: string[], ink = BLACK): void {
  const e = Math.max(2, Math.min(w, h) * 0.05);
  fillOutline(g, 'rect', x, y, w, h, 0, ink);
  fillOutline(g, 'rect', x, y, w, h, e, WHITE);
  lines(g, ls, x + e * 2, y + e * 1.5, w - e * 4, h - e * 3, ink);
}

// ---------------------------------------------------------------- the signs

/** A traffic sign's face: its code (the Belgian sign code), the register's shape and what it says ("|" between lines). */
export function drawSign(code: string, shape: string, said: string): Draw {
  const o = outlineOf(code, shape);
  const parts = said ? said.split('|') : [];
  return (g, x, y, w, h) => {
    const s = Math.min(w, h);
    const cx = x + w / 2;
    if (o === 'triUp' || o === 'triDown') {
      fillOutline(g, o, x, y, w, h, 0, RED);
      fillOutline(g, o, x, y, w, h, s * 0.075, WHITE);
      if (o === 'triUp') pictogram(g, code, cx, y + h * 0.63, s * 0.3);
      return;
    }
    if (o === 'oct') {
      fillOutline(g, o, x, y, w, h, 0, WHITE);
      fillOutline(g, o, x, y, w, h, s * 0.03, RED);
      text(g, 'STOP', cx, y + h / 2, w * 0.75, h * 0.3, WHITE);
      return;
    }
    if (o === 'diamond') {
      fillOutline(g, o, x, y, w, h, 0, WHITE);
      fillOutline(g, o, x, y, w, h, s * 0.12, '#f2b800');
      return;
    }
    if (o === 'round') return round(g, code, parts, x, y, w, h);
    if (o === 'arrowL' || o === 'arrowR') {
      const ink = code.startsWith('F34') ? RED : BLACK;
      fillOutline(g, o, x, y, w, h, 0, ink);
      fillOutline(g, o, x, y, w, h, h * 0.07, WHITE);
      const t = Math.min(0.3, (0.5 * h) / w) * w;
      lines(g, parts, x + (o === 'arrowL' ? t : h * 0.12), y + h * 0.08, w - t - h * 0.12, h * 0.84, ink);
      return;
    }
    if (o === 'hex') {
      // A walking route's marker: white, a green edge and a green arrow.
      fillOutline(g, o, x, y, w, h, 0, GREEN);
      fillOutline(g, o, x, y, w, h, s * 0.1, WHITE);
      g.fillStyle = GREEN;
      g.beginPath();
      g.moveTo(cx - s * 0.18, y + h * 0.3);
      g.lineTo(cx + s * 0.22, y + h * 0.5);
      g.lineTo(cx - s * 0.18, y + h * 0.7);
      g.closePath();
      g.fill();
      return;
    }
    rectSign(g, code, parts, x, y, w, h);
  };
}

/** The pictures on the warning triangles (black, centred at cx, cy, about 2u across). */
function pictogram(g: CanvasRenderingContext2D, code: string, cx: number, cy: number, u: number): void {
  g.fillStyle = BLACK;
  g.strokeStyle = BLACK;
  g.lineCap = 'butt';
  if (code === 'B17') {
    // Crossroads, priority to the right: a black cross.
    g.lineWidth = u * 0.3;
    g.beginPath();
    g.moveTo(cx - u * 0.6, cy - u * 0.6);
    g.lineTo(cx + u * 0.6, cy + u * 0.6);
    g.moveTo(cx + u * 0.6, cy - u * 0.6);
    g.lineTo(cx - u * 0.6, cy + u * 0.6);
    g.stroke();
  } else if (code === 'B15') {
    g.fillRect(cx - u * 0.16, cy - u * 0.75, u * 0.32, u * 1.45);
    g.fillRect(cx - u * 0.6, cy - u * 0.25, u * 1.2, u * 0.12);
  } else if (code === 'A23') {
    // Children: a bigger and a smaller one walking.
    for (const [dx, k] of [[-0.32, 1], [0.34, 0.82]] as const) {
      const x = cx + dx * u, top = cy + u * 0.75 - u * 1.5 * k;
      g.beginPath();
      g.arc(x, top + u * 0.15 * k, u * 0.15 * k, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(x - u * 0.2 * k, top + u * 0.35 * k);
      g.lineTo(x + u * 0.2 * k, top + u * 0.35 * k);
      g.lineTo(x + u * 0.26 * k, top + u * 0.95 * k);
      g.lineTo(x - u * 0.26 * k, top + u * 0.95 * k);
      g.closePath();
      g.fill();
      g.lineWidth = u * 0.13 * k;
      g.beginPath();
      g.moveTo(x - u * 0.1 * k, top + u * 0.9 * k);
      g.lineTo(x - u * 0.22 * k, cy + u * 0.75);
      g.moveTo(x + u * 0.1 * k, top + u * 0.9 * k);
      g.lineTo(x + u * 0.24 * k, cy + u * 0.75);
      g.stroke();
    }
  } else if (code === 'A1a' || code === 'A1b') {
    // A bend to the left (A1a) or the right (A1b).
    const sgn = code === 'A1a' ? -1 : 1;
    g.lineWidth = u * 0.24;
    g.beginPath();
    g.moveTo(cx - sgn * u * 0.25, cy + u * 0.75);
    g.lineTo(cx - sgn * u * 0.25, cy + u * 0.05);
    g.quadraticCurveTo(cx - sgn * u * 0.25, cy - u * 0.4, cx + sgn * u * 0.2, cy - u * 0.4);
    g.stroke();
    g.beginPath();
    g.moveTo(cx + sgn * u * 0.65, cy - u * 0.4);
    g.lineTo(cx + sgn * u * 0.15, cy - u * 0.75);
    g.lineTo(cx + sgn * u * 0.15, cy - u * 0.05);
    g.closePath();
    g.fill();
  } else {
    // Another danger: an exclamation mark.
    g.fillRect(cx - u * 0.12, cy - u * 0.7, u * 0.24, u * 0.95);
    g.beginPath();
    g.arc(cx, cy + u * 0.55, u * 0.14, 0, Math.PI * 2);
    g.fill();
  }
}

/** The round signs: speed limits and bans (white, a red ring), parking bans (blue, a red ring), mandatory (blue). */
function round(g: CanvasRenderingContext2D, code: string, parts: string[], x: number, y: number, w: number, h: number): void {
  const s = Math.min(w, h), cx = x + w / 2, cy = y + h / 2;
  if (code.startsWith('D')) {
    fillOutline(g, 'round', x, y, w, h, 0, WHITE);
    fillOutline(g, 'round', x, y, w, h, s * 0.03, BLUE);
    // Keep left or right: a white arrow down to the side.
    g.strokeStyle = WHITE;
    g.fillStyle = WHITE;
    g.lineWidth = s * 0.1;
    const sgn = code.endsWith('b') ? 1 : -1;
    g.beginPath();
    g.moveTo(cx - sgn * s * 0.2, cy - s * 0.2);
    g.lineTo(cx + sgn * s * 0.12, cy + s * 0.12);
    g.stroke();
    g.beginPath();
    g.moveTo(cx + sgn * s * 0.26, cy + s * 0.26);
    g.lineTo(cx + sgn * s * 0.26, cy + s * 0.0);
    g.lineTo(cx + sgn * s * 0.0, cy + s * 0.26);
    g.closePath();
    g.fill();
    return;
  }
  if (code.startsWith('E') && !code.startsWith('E9')) {
    fillOutline(g, 'round', x, y, w, h, 0, RED);
    fillOutline(g, 'round', x, y, w, h, s * 0.11, BLUE);
    if (code === 'E5' || code === 'E7') text(g, code === 'E5' ? 'I' : 'II', cx, cy, s * 0.5, s * 0.42, WHITE);
    g.strokeStyle = RED;
    g.lineWidth = s * 0.1;
    g.beginPath();
    const r = s * 0.4;
    g.moveTo(cx - r * 0.7, cy - r * 0.7);
    g.lineTo(cx + r * 0.7, cy + r * 0.7);
    if (code === 'E3') {
      g.moveTo(cx + r * 0.7, cy - r * 0.7);
      g.lineTo(cx - r * 0.7, cy + r * 0.7);
    }
    g.stroke();
    return;
  }
  if (code === 'C1') {
    fillOutline(g, 'round', x, y, w, h, 0, RED);
    g.fillStyle = WHITE;
    g.fillRect(cx - s * 0.32, cy - s * 0.09, s * 0.64, s * 0.18);
    return;
  }
  fillOutline(g, 'round', x, y, w, h, 0, RED);
  fillOutline(g, 'round', x, y, w, h, s * 0.12, WHITE);
  if (code === 'C43') text(g, parts[0] || '50', cx, cy + s * 0.02, s * 0.56, s * 0.42, BLACK);
  else if (parts.length && code !== 'C3') text(g, parts[0], cx, cy, s * 0.56, s * 0.3, BLACK);
}

/** The rectangular signs: place names, zones, parking, dead ends, the cycle network's nodes and the plates under signs. */
function rectSign(g: CanvasRenderingContext2D, code: string, parts: string[], x: number, y: number, w: number, h: number): void {
  const s = Math.min(w, h), cx = x + w / 2;
  if (/^F(1|3|43)/.test(code)) {
    // The village's name (F1: the built-up area starts; F3: it ends, crossed out in red; F43: the name of the place).
    const e = s * 0.045;
    fillOutline(g, 'rect', x, y, w, h, 0, BLACK);
    fillOutline(g, 'rect', x, y, w, h, e, WHITE);
    text(g, parts[0] ?? '', cx, y + h * (parts.length > 1 ? 0.4 : 0.5), w * 0.84, h * 0.34, BLACK);
    if (parts[1]) text(g, parts[1], cx, y + h * 0.76, w * 0.6, h * 0.15, BLACK, false);
    if (code.startsWith('F3')) {
      g.strokeStyle = RED;
      g.lineWidth = h * 0.09;
      g.beginPath();
      g.moveTo(x + w * 0.08, y + h * 0.9);
      g.lineTo(x + w * 0.92, y + h * 0.1);
      g.stroke();
    }
    return;
  }
  if (code === 'F4a' || code === 'F4b') {
    // Zone 30 (F4a) and its end (F4b: greyed and crossed).
    const end = code === 'F4b';
    const ink = end ? GREY : BLACK;
    fillOutline(g, 'rect', x, y, w, h, 0, end ? '#b9bcbf' : '#2a2a2a');
    fillOutline(g, 'rect', x, y, w, h, s * 0.025, WHITE);
    text(g, 'ZONE', cx, y + h * 0.17, w * 0.8, h * 0.13, ink);
    const r = Math.min(w * 0.36, h * 0.26), cy = y + h * 0.58;
    g.fillStyle = end ? '#d9a3a8' : RED;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = WHITE;
    g.beginPath();
    g.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
    g.fill();
    text(g, parts[0] || '30', cx, cy + r * 0.04, r * 1.2, r * 0.95, ink);
    if (end) {
      g.strokeStyle = '#3a3a3a';
      g.lineWidth = s * 0.02;
      for (let k = -2; k <= 2; k++) {
        g.beginPath();
        g.moveTo(x + w * 0.1 + k * s * 0.05, y + h * 0.95);
        g.lineTo(x + w * 0.9 + k * s * 0.05, y + h * 0.05);
        g.stroke();
      }
    }
    return;
  }
  if (code === 'F45') {
    // A dead end: on blue, a white upright with a red bar across its top.
    fillOutline(g, 'rect', x, y, w, h, 0, WHITE);
    fillOutline(g, 'rect', x, y, w, h, s * 0.03, BLUE);
    g.fillStyle = WHITE;
    g.fillRect(cx - w * 0.11, y + h * 0.36, w * 0.22, h * 0.54);
    g.fillStyle = RED;
    g.fillRect(cx - w * 0.3, y + h * 0.2, w * 0.6, h * 0.16);
    return;
  }
  if (code.startsWith('E9')) {
    fillOutline(g, 'rect', x, y, w, h, 0, WHITE);
    fillOutline(g, 'rect', x, y, w, h, s * 0.03, BLUE);
    text(g, 'P', cx, y + h * 0.5, w * 0.7, h * 0.6, WHITE);
    return;
  }
  if (code === 'FtsRt') {
    // The cycle network's node signs: the node numbers in green on white (the region's name is too small to read).
    const nums = parts.filter((p) => /^\d+$/.test(p));
    fillOutline(g, 'rect', x, y, w, h, 0, GREEN);
    fillOutline(g, 'rect', x, y, w, h, s * 0.05, WHITE);
    if (nums.length) {
      g.fillStyle = GREEN;
      g.fillRect(x + w * 0.18, y + h * 0.1, w * 0.64, h * 0.3);
      text(g, nums[0], cx, y + h * 0.26, w * 0.55, h * 0.24, WHITE);
      if (nums.length > 1) text(g, nums.slice(1).join('  '), cx, y + h * 0.62, w * 0.8, h * 0.18, GREEN);
    }
    return;
  }
  if (/^GX/.test(code)) {
    // The arrows under a sign that say where its rule starts (Xa), goes on (Xb) or ends (Xd).
    plain(g, x, y, w, h, []);
    g.fillStyle = BLACK;
    const head = (up: boolean, at: number) => {
      g.beginPath();
      g.moveTo(cx, at);
      g.lineTo(cx - w * 0.3, at + (up ? 1 : -1) * w * 0.4);
      g.lineTo(cx + w * 0.3, at + (up ? 1 : -1) * w * 0.4);
      g.closePath();
      g.fill();
    };
    g.fillRect(cx - w * 0.08, y + h * 0.15, w * 0.16, h * 0.7);
    if (code !== 'GXd') head(true, y + h * 0.1);
    if (code !== 'GXa') head(false, y + h * 0.9);
    return;
  }
  if (code.startsWith('F34')) return plain(g, x, y, w, h, parts, RED);
  plain(g, x, y, w, h, parts);
}

// ---------------------------------------------------------------- plates and the bus stop

/** A street name plate: white on dark blue with a white edge. */
export function drawPlate(name: string): Draw {
  return (g, x, y, w, h) => {
    g.fillStyle = '#1e3b78';
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#f2f4f7';
    g.lineWidth = h * 0.05;
    g.strokeRect(x + h * 0.08, y + h * 0.08, w - h * 0.16, h - h * 0.16);
    text(g, name, x + w / 2, y + h / 2 + 2, w - h * 0.5, h * 0.53, '#f7f8fa');
  };
}

/** The bus stop's plate: yellow with a black edge, a bus in black and the stop's name (no operator's logo). */
export function drawStopPlate(name: string): Draw {
  return (g, x, y, w, h) => {
    fillOutline(g, 'rect', x, y, w, h, 0, BLACK);
    fillOutline(g, 'rect', x, y, w, h, w * 0.04, YELLOW);
    const cx = x + w / 2, bw = w * 0.56, bh = h * 0.36, by = y + h * 0.1;
    g.fillStyle = BLACK;
    g.fillRect(cx - bw / 2, by, bw, bh); // (no roundRect: older iPads' Safari lacks it)
    g.fillStyle = YELLOW;
    g.fillRect(cx - bw * 0.4, by + bh * 0.14, bw * 0.8, bh * 0.38); // the windscreen
    g.fillRect(cx - bw * 0.38, by + bh * 0.7, bw * 0.16, bh * 0.12); // the lights
    g.fillRect(cx + bw * 0.22, by + bh * 0.7, bw * 0.16, bh * 0.12);
    g.fillStyle = BLACK;
    g.fillRect(cx - bw * 0.4, by + bh, bw * 0.16, bh * 0.14); // the wheels
    g.fillRect(cx + bw * 0.24, by + bh, bw * 0.16, bh * 0.14);
    const words = name.split(' ');
    const ls = words.length > 1 ? [words.slice(0, -1).join(' '), words[words.length - 1]] : words;
    lines(g, ls, x + w * 0.08, y + h * 0.56, w * 0.84, h * 0.38, BLACK);
  };
}

/** The timetable in its case: white with grey lines of print, a black frame. */
export const drawTimetable: Draw = (g, x, y, w, h) => {
  g.fillStyle = '#2b2d30';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#f2f2ee';
  g.fillRect(x + w * 0.08, y + h * 0.06, w * 0.84, h * 0.88);
  g.fillStyle = YELLOW;
  g.fillRect(x + w * 0.08, y + h * 0.06, w * 0.84, h * 0.1);
  g.fillStyle = '#9ea2a6';
  for (let k = 0; k < 9; k++) g.fillRect(x + w * 0.14, y + h * (0.24 + k * 0.075), w * (k % 3 === 2 ? 0.45 : 0.72), h * 0.025);
};
