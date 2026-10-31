import * as THREE from 'three';

/**
 * What the screens in the house show, drawn in code (no images, no logos): an indoor
 * ride on the bike's screen in the style of Zwift (road, rider, power and the riders
 * around you), a desktop and a code editor on the office screens, a framed print.
 */

const W = 512;
const H = 288;

/** One frame of the ride, `t` seconds in: the road runs, the numbers move. */
export function drawRide(g: CanvasRenderingContext2D, t: number): void {
  const horizon = H * 0.42;
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#5f9fd8');
  sky.addColorStop(1, '#d6ebf7');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, horizon);
  // Hills far away, then grass.
  g.fillStyle = '#8db66a';
  g.beginPath();
  g.moveTo(0, horizon);
  for (let x = 0; x <= W; x += 16) g.lineTo(x, horizon - 14 - 10 * Math.sin(x * 0.018 + 1) - 6 * Math.sin(x * 0.05));
  g.lineTo(W, horizon);
  g.fill();
  g.fillStyle = '#6a9b44';
  g.fillRect(0, horizon, W, H - horizon);

  // The road to the horizon, its centre dashes and the trees running past.
  const cx = W / 2;
  g.fillStyle = '#55585e';
  g.beginPath();
  g.moveTo(cx - 6, horizon);
  g.lineTo(cx + 6, horizon);
  g.lineTo(cx + 210, H);
  g.lineTo(cx - 210, H);
  g.fill();
  const run = (t * 0.9) % 1;
  const depth = (k: number) => horizon + (H - horizon) * k * k; // y on screen for 0 (far) .. 1 (near)
  g.fillStyle = '#f1d14b';
  for (let i = 0; i < 10; i++) {
    const a = (i + run) / 10;
    const b = (i + run + 0.45) / 10;
    const ya = depth(a);
    const yb = depth(Math.min(1, b));
    const wa = 1 + 4 * a;
    g.beginPath();
    g.moveTo(cx - wa / 2, ya);
    g.lineTo(cx + wa / 2, ya);
    g.lineTo(cx + (1 + 4 * b) / 2, yb);
    g.lineTo(cx - (1 + 4 * b) / 2, yb);
    g.fill();
  }
  for (let i = 0; i < 8; i++) {
    const k = (i + ((t * 0.45) % 1)) / 8;
    const y = depth(k);
    const spread = 14 + 230 * k * k;
    const size = 6 + 46 * k * k;
    for (const side of [-1, 1]) {
      const x = cx + side * (spread + size * 0.6);
      g.fillStyle = '#5a3f2b';
      g.fillRect(x - size * 0.06, y - size * 0.7, size * 0.12, size * 0.7);
      g.fillStyle = i % 2 ? '#3f7a34' : '#4a8a3a';
      g.beginPath();
      g.ellipse(x, y - size * 0.95, size * 0.42, size * 0.55, 0, 0, Math.PI * 2);
      g.fill();
    }
  }

  // You, from behind: wheels, legs going round, an orange jersey.
  const rx = cx;
  const ry = H * 0.83;
  const crank = t * 9;
  g.strokeStyle = '#141414';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(rx, ry + 30);
  g.lineTo(rx, ry - 4);
  g.stroke();
  g.fillStyle = '#141414';
  g.beginPath();
  g.ellipse(rx, ry + 18, 5, 22, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1d1d22';
  for (const s of [-1, 1]) {
    const ph = crank + (s > 0 ? Math.PI : 0);
    g.fillRect(rx + s * 7 - 3, ry - 14 + Math.sin(ph) * 6, 7, 24);
  }
  g.fillStyle = '#ef6a1c';
  g.beginPath();
  g.ellipse(rx, ry - 26, 15, 20, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1d1d22';
  g.fillRect(rx - 13, ry - 16, 26, 8);
  g.fillStyle = '#f4f4f4';
  g.beginPath();
  g.ellipse(rx, ry - 50, 9, 8, 0, 0, Math.PI * 2);
  g.fill();

  // Numbers: power, speed, heart rate and cadence on the left, the ride along the top.
  const watts = Math.round(236 + 22 * Math.sin(t * 0.7) + 9 * Math.sin(t * 2.3));
  const km = 12.4 + t * 0.0095;
  const secs = 38 * 60 + 21 + Math.floor(t);
  const panel = (x: number, y: number, w: number, h: number) => {
    g.fillStyle = 'rgba(16, 18, 24, 0.72)';
    g.fillRect(x, y, w, h);
  };
  panel(8, 8, 112, 92);
  g.fillStyle = '#ffffff';
  g.font = 'bold 38px Arial, sans-serif';
  g.fillText(String(watts), 16, 46);
  const wide = g.measureText(String(watts)).width;
  g.font = 'bold 15px Arial, sans-serif';
  g.fillText('w', 16 + wide + 3, 46);
  g.fillStyle = '#ef6a1c';
  g.fillText(`${(watts / 72).toFixed(1)} w/kg`, 16, 66);
  g.fillStyle = '#ff6b6b';
  g.fillText(`♥ ${Math.round(142 + 4 * Math.sin(t * 0.3))}`, 16, 88);
  g.fillStyle = '#dfe6ee';
  g.fillText(`${Math.round(88 + 3 * Math.sin(t))} rpm`, 64, 88);
  panel(W / 2 - 110, 8, 220, 34);
  g.fillStyle = '#ffffff';
  g.font = 'bold 17px Arial, sans-serif';
  g.textAlign = 'center';
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  g.fillText(`${km.toFixed(1)} km    ${clock}    +186 m`, W / 2, 31);
  g.fillText(`${(34 + 2 * Math.sin(t * 0.7)).toFixed(1)} km/h`, W / 2, 62);
  g.textAlign = 'left';

  // The riders around you, you in orange.
  panel(W - 132, 8, 124, 132);
  const riders = ['J. Peeters', 'A. Claes', 'You', 'M. Jacobs', 'S. Wouters', 'L. Maes'];
  g.font = '12px Arial, sans-serif';
  riders.forEach((name, i) => {
    const y = 26 + i * 20;
    if (name === 'You') {
      g.fillStyle = 'rgba(239, 106, 28, 0.85)';
      g.fillRect(W - 128, y - 13, 116, 18);
    }
    g.fillStyle = '#ffffff';
    g.fillText(name, W - 124, y);
    g.fillStyle = name === 'You' ? '#ffffff' : '#c7d0da';
    g.fillText(name === 'You' ? `${(watts / 72).toFixed(1)}` : (3.0 + ((i * 7) % 9) / 10).toFixed(1), W - 40, y);
  });

  // The climb ahead along the bottom, where you are on it.
  panel(8, H - 46, 220, 38);
  g.strokeStyle = '#f1d14b';
  g.lineWidth = 2;
  g.beginPath();
  for (let x = 0; x <= 204; x += 4) {
    const y = H - 16 - 14 * (0.5 + 0.5 * Math.sin(x * 0.03 + 0.6)) - 6 * Math.sin(x * 0.09);
    if (x) g.lineTo(16 + x, y);
    else g.moveTo(16 + x, y);
  }
  g.stroke();
  const at = 16 + ((t * 2) % 204);
  g.fillStyle = '#ef6a1c';
  g.beginPath();
  g.arc(at, H - 30, 4, 0, Math.PI * 2);
  g.fill();
}

/** The ultrawide screen: a mountain wallpaper at dusk and a taskbar. */
export function drawDesktop(g: CanvasRenderingContext2D): void {
  const w = g.canvas.width;
  const h = g.canvas.height;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#26324a');
  sky.addColorStop(0.55, '#8a6a74');
  sky.addColorStop(1, '#d59a72');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const ridge = (base: number, amp: number, color: string, seed: number) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 6) g.lineTo(x, base - amp * Math.abs(Math.sin(x * 0.011 + seed)) - amp * 0.35 * Math.sin(x * 0.043 + seed * 2));
    g.lineTo(w, h);
    g.fill();
  };
  ridge(h * 0.62, 60, '#4a4f63', 0.4);
  ridge(h * 0.74, 48, '#33384a', 1.7);
  ridge(h * 0.88, 30, '#1f2331', 2.9);
  g.fillStyle = 'rgba(20, 22, 28, 0.92)';
  g.fillRect(0, h - 14, w, 14);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = ['#4f8ff7', '#f1c84b', '#e2574c', '#7ac36a', '#c9d1db', '#9a7cf0', '#f08a4b', '#5fc4d8'][i];
    g.fillRect(w / 2 - 64 + i * 16, h - 11, 9, 8);
  }
}

/** The portrait screen: a code editor. */
export function drawCode(g: CanvasRenderingContext2D): void {
  const w = g.canvas.width;
  const h = g.canvas.height;
  g.fillStyle = '#1e1f25';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#17181d';
  g.fillRect(0, 0, 34, h);
  g.fillStyle = '#2a2c34';
  g.fillRect(0, 0, w, 14);
  const colours = ['#c792ea', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#d6deeb', '#7f8696'];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 24, indent = 0; y < h - 6; y += 9) {
    if (rand() < 0.12) {
      indent = Math.max(0, indent + (rand() < 0.5 ? -1 : 1));
      continue;
    }
    let x = 42 + indent * 12;
    const words = 1 + Math.floor(rand() * 5);
    for (let k = 0; k < words && x < w - 10; k++) {
      const len = 8 + rand() * 34;
      g.fillStyle = colours[Math.floor(rand() * colours.length)];
      g.fillRect(x, y, len, 4);
      x += len + 5;
    }
  }
}

/** A framed photo of misty hills in grey, on a white mount. */
export function drawPrint(g: CanvasRenderingContext2D): void {
  const w = g.canvas.width;
  const h = g.canvas.height;
  g.fillStyle = '#f3f1ec';
  g.fillRect(0, 0, w, h);
  const m = 34;
  const sky = g.createLinearGradient(0, m, 0, h - m);
  sky.addColorStop(0, '#d9dadb');
  sky.addColorStop(1, '#8d9196');
  g.fillStyle = sky;
  g.fillRect(m, m, w - 2 * m, h - 2 * m);
  for (let i = 0; i < 4; i++) {
    g.fillStyle = `rgba(${70 - i * 12}, ${74 - i * 12}, ${80 - i * 12}, ${0.35 + i * 0.18})`;
    g.beginPath();
    g.moveTo(m, h - m);
    for (let x = m; x <= w - m; x += 4) g.lineTo(x, h * (0.45 + i * 0.1) - 18 * Math.sin(x * 0.03 + i * 1.7) - 10 * Math.sin(x * 0.07 + i));
    g.lineTo(w - m, h - m);
    g.fill();
  }
}

/**
 * The painting over the sofa (render zithoek: a bright meadow of flowers on blue-green): our own,
 * made of dabs. A soft sky, a heap of pink, coral, yellow, lilac and white dabs, and green-blue
 * strokes rising from below. The same seed every time, so everyone sees the same picture.
 */
export function drawPainting(g: CanvasRenderingContext2D): void {
  const w = g.canvas.width;
  const h = g.canvas.height;
  let s = 20261030;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#a9d8d6');
  bg.addColorStop(0.55, '#5fb0b4');
  bg.addColorStop(1, '#3f8f98');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 260; i++) {
    // Stems and grass: thin strokes rising from the bottom.
    const x = rnd() * w;
    const y0 = h * (0.75 + rnd() * 0.25);
    g.strokeStyle = ['#2f8a7f', '#6fbf9a', '#1f6f73', '#9fd8c0'][Math.floor(rnd() * 4)];
    g.globalAlpha = 0.6;
    g.lineWidth = 1 + rnd() * 2;
    g.beginPath();
    g.moveTo(x, y0);
    g.lineTo(x + (rnd() - 0.5) * 14, y0 - h * (0.15 + rnd() * 0.3));
    g.stroke();
  }
  const flowers = ['#f06b8a', '#f7a35c', '#fbd36b', '#e85d75', '#b48ad0', '#ffffff', '#f39bb5', '#ff8a5b', '#d94f7c'];
  for (let i = 0; i < 1400; i++) {
    // Dabs heaped round a point above the middle, thinning out towards the edges.
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(-2 * Math.log(1 - rnd() * 0.999)) * 0.17;
    const x = w * (0.5 + r * Math.cos(a) * 1.1);
    const y = h * (0.42 + r * Math.sin(a) * 0.8);
    g.globalAlpha = 0.55 + rnd() * 0.45;
    g.fillStyle = flowers[Math.floor(rnd() * flowers.length)];
    g.beginPath();
    g.ellipse(x, y, 1.5 + rnd() * 3, 1.2 + rnd() * 2.2, rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

/**
 * The playroom's wall picture (the playroom render: a llama made of coloured triangles): our own
 * drawing, a llama standing side on, facing left, cut into triangles in the colours of a rainbow
 * with thin white seams. Transparent round it, so it sits on the wall like a sticker.
 */
export function drawLlama(g: CanvasRenderingContext2D): void {
  const w = g.canvas.width;
  const h = g.canvas.height;
  // The outline on a 10 x 13 grid: ears, head and snout, the long neck, back and tail, four legs.
  const outline = [[2.6, 0.2], [3.1, 1.3], [3.5, 0.3], [3.9, 1.5], [4.1, 2.6], [4.0, 5.2], [4.6, 5.9], [8.2, 5.9], [8.9, 5.2],
    [9.2, 6.0], [8.9, 7.1], [8.6, 8.6], [8.5, 12.6], [7.8, 12.6], [7.6, 9.2], [7.0, 9.4], [6.8, 12.6], [6.1, 12.6], [5.9, 9.4],
    [5.0, 9.3], [4.8, 12.6], [4.1, 12.6], [3.9, 9.0], [3.6, 12.6], [2.9, 12.6], [2.8, 8.4], [2.3, 6.8], [2.1, 3.4], [0.9, 3.1],
    [0.7, 2.4], [1.6, 1.6]];
  const sx = w / 10;
  const sy = h / 13;
  g.clearRect(0, 0, w, h);
  g.save();
  g.beginPath();
  outline.forEach(([x, y], i) => (i ? g.lineTo(x * sx, y * sy) : g.moveTo(x * sx, y * sy)));
  g.closePath();
  g.clip();
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const step = w / 7;
  g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  g.lineWidth = 1.5;
  for (let y = -step; y < h + step; y += step * 0.8) {
    for (let x = -step; x < w + step; x += step) {
      const o = (Math.round(y / (step * 0.8)) % 2) * step * 0.5;
      for (const flip of [0, 1]) {
        const p = flip ? [[x + o, y], [x + o + step, y], [x + o + step * 0.5, y + step * 0.8]] : [[x + o + step * 0.5, y + step * 0.8], [x + o + step * 1.5, y + step * 0.8], [x + o + step, y]];
        // Rainbow from the head (red, orange) down to the legs (blue, violet), each triangle its own shade.
        const hue = ((y / h) * 260 + (x / w) * 60 + rnd() * 40) % 360;
        g.fillStyle = `hsl(${hue}, ${70 + rnd() * 20}%, ${48 + rnd() * 14}%)`;
        g.beginPath();
        g.moveTo(p[0][0], p[0][1]);
        g.lineTo(p[1][0], p[1][1]);
        g.lineTo(p[2][0], p[2][1]);
        g.closePath();
        g.fill();
        g.stroke();
      }
    }
  }
  g.restore();
}

/** The warm light a strip under a shelf throws on the wall: strongest at the top, fading out. */
export function washTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const v = g.createLinearGradient(0, 0, 0, 64);
  v.addColorStop(0, 'rgba(255, 196, 120, 0.55)');
  v.addColorStop(0.35, 'rgba(255, 186, 110, 0.18)');
  v.addColorStop(1, 'rgba(255, 180, 100, 0)');
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 64);
  // Fade at both ends of the strip.
  g.globalCompositeOperation = 'destination-in';
  const u = g.createLinearGradient(0, 0, 64, 0);
  u.addColorStop(0, 'rgba(0,0,0,0)');
  u.addColorStop(0.15, 'rgba(0,0,0,1)');
  u.addColorStop(0.85, 'rgba(0,0,0,1)');
  u.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = u;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
