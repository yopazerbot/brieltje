import * as THREE from 'three';

/**
 * Textures for effects, drawn in code once at start-up (no downloads): soft
 * particles for smoke, fire, sparks and debris; muzzle flashes; bullet
 * holes per surface; and paintball's paint splats. Everything is drawn white
 * or in its own colours on a canvas and tinted where it is used.
 */

/** A repeatable random sequence, so the drawings look the same every visit. */
function random(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft round spot: `inner` colour in the middle fading to transparent at radius r. */
function blob(g: CanvasRenderingContext2D, x: number, y: number, r: number, inner: string, alpha: number): void {
  const grad = g.createRadialGradient(x - r * 0.25, y - r * 0.3, 0, x, y, r);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.globalAlpha = alpha;
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;
}

/** Fade a square cell out towards its edge, so no sprite ever shows a hard corner. */
function vignette(g: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  g.save();
  // Clipped: 'destination-in' would otherwise clear the whole canvas outside the cell.
  g.beginPath();
  g.rect(x, y, size, size);
  g.clip();
  g.globalCompositeOperation = 'destination-in';
  const grad = g.createRadialGradient(x + size / 2, y + size / 2, size * 0.2, x + size / 2, y + size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(x, y, size, size);
  g.restore();
}

/**
 * Particle sheet, 2 x 2 cells: 0 a lumpy smoke puff (lit from above), 1 a glow
 * (fire, sparks, flashes), 2 a hard-edged chip (debris), 3 a thin ragged wisp.
 */
export const PARTICLE = { puff: 0, glow: 1, chip: 2, wisp: 3 } as const;
export function particleSheet(): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S * 2, S * 2);
  const rand = random(11);

  // Puff: overlapping soft lumps, lighter on top, darker underneath.
  g.save();
  g.beginPath();
  g.rect(0, 0, S, S);
  g.clip();
  for (let i = 0; i < 22; i++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * S * 0.2;
    const r = S * (0.13 + rand() * 0.13);
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    const shade = Math.round(205 + 50 * (1 - (y - S * 0.3) / (S * 0.4)));
    blob(g, x, y, r, `rgb(${shade},${shade},${shade})`, 0.5);
  }
  g.restore();
  vignette(g, 0, 0, S);

  // Glow: a hot core with a long soft falloff.
  const glow = g.createRadialGradient(S * 1.5, S / 2, 0, S * 1.5, S / 2, S / 2);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.15, 'rgba(255,255,255,0.85)');
  glow.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow;
  g.fillRect(S, 0, S, S);

  // Chip: an irregular shard with a lit and a shaded side.
  g.save();
  g.translate(S / 2, S * 1.5);
  g.beginPath();
  const corners = 7;
  for (let i = 0; i < corners; i++) {
    const a = (i / corners) * Math.PI * 2 + rand() * 0.4;
    const r = S * (0.22 + rand() * 0.2);
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  const face = g.createLinearGradient(-S * 0.3, -S * 0.3, S * 0.3, S * 0.3);
  face.addColorStop(0, '#ffffff');
  face.addColorStop(1, '#9a9a9a');
  g.fillStyle = face;
  g.fill();
  g.restore();

  // Wisp: a thinner, torn version of the puff.
  g.save();
  g.beginPath();
  g.rect(S, S, S, S);
  g.clip();
  for (let i = 0; i < 30; i++) {
    const x = S * 1.5 + (rand() - 0.5) * S * 0.6;
    const y = S * 1.5 + (rand() - 0.5) * S * 0.35;
    blob(g, x, y, S * (0.05 + rand() * 0.1), '#ffffff', 0.35);
  }
  g.restore();
  vignette(g, S, S, S);
  return texture(c);
}

/** Muzzle flash sheet: left a star seen down the barrel, right the flame seen from the side. */
export function flashSheet(): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S * 2, S);
  const rand = random(5);
  const hot = (grad: CanvasGradient) => {
    grad.addColorStop(0, 'rgba(255,255,240,1)');
    grad.addColorStop(0.25, 'rgba(255,220,140,0.95)');
    grad.addColorStop(0.6, 'rgba(255,140,40,0.5)');
    grad.addColorStop(1, 'rgba(255,90,20,0)');
  };

  // Star: spikes of different lengths around a bright core.
  g.save();
  g.translate(S / 2, S / 2);
  const spikes = 7;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + rand() * 0.5;
    const len = S * (0.3 + rand() * 0.2);
    const w = 0.16 + rand() * 0.1;
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, len);
    hot(grad);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(Math.cos(a - w) * S * 0.06, Math.sin(a - w) * S * 0.06);
    g.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    g.lineTo(Math.cos(a + w) * S * 0.06, Math.sin(a + w) * S * 0.06);
    g.fill();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, S * 0.2);
  hot(core);
  g.fillStyle = core;
  g.beginPath();
  g.arc(0, 0, S * 0.2, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Side: a flame cone from the muzzle (left edge) outwards, with a few tongues.
  g.save();
  g.translate(S, S / 2);
  for (let i = 0; i < 6; i++) {
    const len = S * (0.55 + rand() * 0.4);
    const half = S * (0.08 + rand() * 0.1);
    const tilt = (rand() - 0.5) * 0.25;
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,250,230,1)');
    grad.addColorStop(0.3, 'rgba(255,200,110,0.85)');
    grad.addColorStop(1, 'rgba(255,110,30,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -S * 0.05);
    g.quadraticCurveTo(len * 0.4, -half + tilt * len, len, tilt * len);
    g.quadraticCurveTo(len * 0.4, half + tilt * len, 0, S * 0.05);
    g.fill();
  }
  g.restore();
  return texture(c);
}

/**
 * Bullet hole sheet, 3 x 2 cells: 0 plaster and brick, 1 wood, 2 metal,
 * 3 tiles and stone, 4 earth, 5 a scorch mark (rocket blast).
 */
export const HOLE = { plaster: 0, wood: 1, metal: 2, tile: 3, earth: 4, scorch: 5 } as const;
export function holeSheet(): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S * 3, S * 2);
  const rand = random(23);
  const cell = (i: number) => [(i % 3) * S + S / 2, Math.floor(i / 3) * S + S / 2] as const;
  /** An irregular ring of points around (x, y). */
  const ragged = (x: number, y: number, r: number, wobble: number, n = 16) => {
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 - wobble / 2 + rand() * wobble);
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
  };
  const cracks = (x: number, y: number, from: number, to: number, n: number, color: string, width: number) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    for (let i = 0; i < n; i++) {
      let a = rand() * Math.PI * 2;
      let px = x + Math.cos(a) * from;
      let py = y + Math.sin(a) * from;
      g.beginPath();
      g.moveTo(px, py);
      const steps = 4;
      const len = (to - from) * (0.5 + rand() * 0.5);
      for (let k = 0; k < steps; k++) {
        a += (rand() - 0.5) * 0.7;
        px += (Math.cos(a) * len) / steps;
        py += (Math.sin(a) * len) / steps;
        g.lineTo(px, py);
      }
      g.stroke();
    }
  };

  // Plaster and brick: pale chipped crater, grey inside, black core, hairline cracks.
  {
    const [x, y] = cell(HOLE.plaster);
    ragged(x, y, S * 0.36, 0.45, 20);
    g.fillStyle = 'rgba(236,230,218,0.75)';
    g.fill();
    ragged(x, y, S * 0.22, 0.35);
    g.fillStyle = 'rgba(120,112,102,0.95)';
    g.fill();
    cracks(x, y, S * 0.2, S * 0.48, 5, 'rgba(60,55,50,0.6)', 2);
    blob(g, x, y, S * 0.13, '#0b0b0b', 1);
    blob(g, x, y, S * 0.1, '#000000', 1);
  }
  // Wood: dark hole, light splinters along the grain.
  {
    const [x, y] = cell(HOLE.wood);
    for (let i = 0; i < 14; i++) {
      const dx = (rand() - 0.5) * S * 0.6;
      const w = S * (0.015 + rand() * 0.03);
      g.fillStyle = `rgba(${200 + rand() * 40},${160 + rand() * 30},${110 + rand() * 30},0.85)`;
      g.fillRect(x + dx * 0.4 - w / 2, y - S * (0.1 + rand() * 0.3), w, S * (0.2 + rand() * 0.5));
    }
    ragged(x, y, S * 0.15, 0.4);
    g.fillStyle = 'rgba(40,24,14,0.95)';
    g.fill();
    blob(g, x, y, S * 0.1, '#050302', 1);
  }
  // Metal: a bright dented ring around a dark hole.
  {
    const [x, y] = cell(HOLE.metal);
    const ring = g.createRadialGradient(x, y, S * 0.08, x, y, S * 0.3);
    ring.addColorStop(0, 'rgba(235,238,240,1)');
    ring.addColorStop(0.5, 'rgba(170,175,180,0.8)');
    ring.addColorStop(1, 'rgba(90,92,96,0)');
    g.fillStyle = ring;
    g.beginPath();
    g.arc(x, y, S * 0.3, 0, Math.PI * 2);
    g.fill();
    blob(g, x, y, S * 0.1, '#060606', 1);
  }
  // Tiles and stone: a white star of chips with long cracks.
  {
    const [x, y] = cell(HOLE.tile);
    cracks(x, y, S * 0.1, S * 0.5, 7, 'rgba(70,70,70,0.7)', 2.5);
    ragged(x, y, S * 0.27, 0.6, 12);
    g.fillStyle = 'rgba(250,250,248,0.9)';
    g.fill();
    ragged(x, y, S * 0.14, 0.4);
    g.fillStyle = 'rgba(140,140,138,1)';
    g.fill();
    blob(g, x, y, S * 0.08, '#0a0a0a', 1);
  }
  // Earth: a dark blotch with clods around it.
  {
    const [x, y] = cell(HOLE.earth);
    for (let i = 0; i < 18; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * S * 0.3;
      blob(g, x + Math.cos(a) * d, y + Math.sin(a) * d, S * (0.04 + rand() * 0.07), '#2a2014', 0.8);
    }
    blob(g, x, y, S * 0.2, '#1a130b', 1);
  }
  // Scorch: soot, darkest in the middle, with streaks thrown outwards.
  {
    const [x, y] = cell(HOLE.scorch);
    for (let i = 0; i < 40; i++) {
      const a = rand() * Math.PI * 2;
      const len = S * (0.25 + rand() * 0.22);
      const grad = g.createLinearGradient(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len);
      grad.addColorStop(0, 'rgba(15,12,10,0.5)');
      grad.addColorStop(1, 'rgba(15,12,10,0)');
      g.strokeStyle = grad;
      g.lineWidth = S * (0.01 + rand() * 0.03);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
    const soot = g.createRadialGradient(x, y, 0, x, y, S * 0.45);
    soot.addColorStop(0, 'rgba(8,6,5,0.95)');
    soot.addColorStop(0.5, 'rgba(20,16,12,0.7)');
    soot.addColorStop(1, 'rgba(30,24,18,0)');
    g.fillStyle = soot;
    g.beginPath();
    g.arc(x, y, S * 0.45, 0, Math.PI * 2);
    g.fill();
  }
  const t = texture(c);
  t.anisotropy = 4;
  return t;
}

/**
 * Paint splat sheet, 2 x 2 cells (paintball): four splats drawn white, tinted per splat where it
 * lands. Each is a lumpy middle with a few spikes and drops thrown round it, lighter and glossy in
 * the middle like wet paint. Everything stays inside 44% of its cell, so far-off mipmaps don't
 * bleed into the next one.
 */
export function splatSheet(): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S * 2, S * 2);
  const rand = random(37);
  for (let cell = 0; cell < 4; cell++) {
    const x = (cell % 2) * S + S / 2;
    const y = Math.floor(cell / 2) * S + S / 2;
    const R = S * (0.17 + rand() * 0.04);
    g.save();
    g.beginPath();
    g.rect(x - S / 2, y - S / 2, S, S);
    g.clip();
    g.fillStyle = '#ffffff';
    // The middle: points round a circle pushed in and out (some far out, the spikes), joined by curves.
    const n = 22;
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.15;
      const r = rand() < 0.22 ? R * (1.35 + rand() * 0.45) : R * (0.78 + rand() * 0.3);
      pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    g.beginPath();
    const mid = (i: number) => [(pts[i % n][0] + pts[(i + 1) % n][0]) / 2, (pts[i % n][1] + pts[(i + 1) % n][1]) / 2];
    g.moveTo(mid(0)[0], mid(0)[1]);
    for (let i = 1; i <= n; i++) g.quadraticCurveTo(pts[i % n][0], pts[i % n][1], mid(i)[0], mid(i)[1]);
    g.fill();
    // Drops thrown out round it, smaller further out.
    for (let i = 0; i < 16; i++) {
      const a = rand() * Math.PI * 2;
      const d = R * (1.25 + rand() * 1.1);
      const r = S * (0.008 + rand() * 0.03) * (1.6 - d / (R * 2.4));
      g.beginPath();
      g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.max(1.5, r), 0, Math.PI * 2);
      g.fill();
    }
    // Shading on the paint only: lighter in the middle, a little darker at the edges, and a glint.
    g.globalCompositeOperation = 'source-atop';
    const shade = g.createRadialGradient(x, y, R * 0.2, x, y, R * 2.2);
    shade.addColorStop(0, '#ffffff');
    shade.addColorStop(0.45, '#e6e6e6');
    shade.addColorStop(1, '#b4b4b4');
    g.fillStyle = shade;
    g.fillRect(x - S / 2, y - S / 2, S, S);
    blob(g, x - R * 0.3, y - R * 0.35, R * 0.35, '#ffffff', 0.9);
    g.restore();
  }
  const t = texture(c);
  t.anisotropy = 4;
  return t;
}
