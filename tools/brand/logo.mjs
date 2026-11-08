// The Brieltje logo as SVG files (DECISIONS.md, 8 Nov 2026): the roof with its two lit windows over the
// name in Fredoka Bold. The letters are the font's own outlines, so the files look the same where the
// font can't load (an <img>, a favicon, a link preview). Writes into web/public/:
//   brand/logo.svg       the roof over BRIELTJE (headers, the loading screen)
//   brand/logo-row.svg   the roof beside "Brieltje", on one line (the menu's corner, the HUD)
//   brand/logo-mark.svg  the roof over a B on evening blue (the app icon), and favicon.svg (the same)
//   brand/logo-mark-square.svg  the same without rounded corners (tools/brand/images.mjs turns it into
//                        the home screen icons, which the phone rounds itself)
// and prints the symbols for web/index.html (the HUD and the menu draw the row logo from there).
//
// Fredoka Bold as a static TrueType file, SIL OFL (web/public/fonts/OFL-Fredoka.txt). Google Fonts sends
// one to browsers without WOFF2 support:
//   curl -A "Mozilla/4.0" "https://fonts.googleapis.com/css2?family=Fredoka:wght@700"   (the .ttf URL in it)
//
//   node tools/brand/logo.mjs <Fredoka-Bold.ttf>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(import.meta.dirname, '../../web/public');
const CHALK = '#fbf6ea';
const SUN = '#f7b928';
const EVENING = '#141d3a';
const NIGHT = '#0d1430';

/** A static TrueType font's outlines (glyf, cmap format 4): enough for a word of Latin letters. */
function font(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o), i16 = (o) => dv.getInt16(o), u32 = (o) => dv.getUint32(o);
  const tables = {};
  for (let i = 0; i < u16(4); i++) {
    const r = 12 + i * 16;
    tables[String.fromCharCode(buf[r], buf[r + 1], buf[r + 2], buf[r + 3])] = u32(r + 8);
  }
  const locFmt = i16(tables.head + 50);
  const numHM = u16(tables.hhea + 34);
  const ascent = i16(tables.hhea + 4);
  const advance = (g) => u16(tables.hmtx + 4 * Math.min(g, numHM - 1));
  let sub = -1;
  for (let i = 0; i < u16(tables.cmap + 2); i++) {
    const at = tables.cmap + 4 + i * 8;
    const off = tables.cmap + u32(at + 4);
    if ((u16(at) === 3 && u16(at + 2) === 1 || u16(at) === 0) && u16(off) === 4) sub = off;
  }
  const glyphOf = (code) => {
    const segX2 = u16(sub + 6), ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      if (code < u16(starts + 2 * s) || code > u16(ends + 2 * s)) continue;
      const delta = i16(deltas + 2 * s), ro = u16(ranges + 2 * s);
      if (!ro) return (code + delta) & 0xffff;
      const g = u16(ranges + 2 * s + ro + 2 * (code - u16(starts + 2 * s)));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const loca = (g) => (locFmt ? u32(tables.loca + 4 * g) : 2 * u16(tables.loca + 2 * g));
  /** A glyph's contours, each a list of points { x, y, on }, y up. */
  const contours = (g, m = [1, 0, 0, 1, 0, 0]) => {
    const start = tables.glyf + loca(g);
    if (start === tables.glyf + loca(g + 1)) return [];
    const nc = i16(start);
    const tf = (x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
    const out = [];
    if (nc >= 0) {
      let p = start + 10;
      const endPts = [];
      for (let i = 0; i < nc; i++, p += 2) endPts.push(u16(p));
      const np = endPts[nc - 1] + 1;
      p += 2 + u16(p); // past the instructions
      const flags = [];
      while (flags.length < np) {
        const f = buf[p++];
        flags.push(f);
        if (f & 8) for (let r = buf[p++]; r > 0; r--) flags.push(f);
      }
      const coords = (short, same) => {
        const v = [];
        let c = 0;
        for (const f of flags) {
          if (f & short) c += f & same ? buf[p++] : -buf[p++];
          else if (!(f & same)) { c += i16(p); p += 2; }
          v.push(c);
        }
        return v;
      };
      const xs = coords(2, 16), ys = coords(4, 32);
      let s = 0;
      for (const e of endPts) {
        const c = [];
        for (let i = s; i <= e; i++) c.push({ ...tf(xs[i], ys[i]), on: !!(flags[i] & 1) });
        out.push(c);
        s = e + 1;
      }
    } else {
      let p = start + 10, more = true;
      while (more) {
        const fl = u16(p), gi = u16(p + 2);
        p += 4;
        let dx, dy;
        if (fl & 1) { dx = i16(p); dy = i16(p + 2); p += 4; } else { dx = (buf[p] << 24) >> 24; dy = (buf[p + 1] << 24) >> 24; p += 2; }
        const f2 = (o) => i16(o) / 16384;
        let a = 1, b = 0, c = 0, d = 1;
        if (fl & 8) { a = d = f2(p); p += 2; } else if (fl & 0x40) { a = f2(p); d = f2(p + 2); p += 4; } else if (fl & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
        out.push(...contours(gi, [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * dx + m[2] * dy + m[4], m[1] * dx + m[3] * dy + m[5]]));
        more = !!(fl & 0x20);
      }
    }
    return out;
  };
  /** A word as one SVG path at `size` px per em, its baseline at y = 0, starting at x = 0; with its box. */
  const word = (text, size, tracking = 0) => {
    const k = size / u16(tables.head + 18);
    const n = (v) => Math.round(v * 100) / 100;
    let x = 0, d = '';
    const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const ch of text) {
      const g = glyphOf(ch.codePointAt(0));
      const P = (q) => {
        const px = (q.x + x) * k, py = -q.y * k;
        box.x0 = Math.min(box.x0, px); box.x1 = Math.max(box.x1, px); box.y0 = Math.min(box.y0, py); box.y1 = Math.max(box.y1, py);
        return `${n(px)} ${n(py)}`;
      };
      for (const c of contours(g)) {
        // Start on a point on the curve; two points off it in a row have one on it halfway between.
        const i0 = c.findIndex((q) => q.on);
        const first = i0 < 0 ? { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2, on: true } : c[i0];
        const rest = i0 < 0 ? c : [...c.slice(i0 + 1), ...c.slice(0, i0)];
        d += `M${P(first)}`;
        let ctrl = null;
        for (const q of [...rest, first]) {
          if (q.on) { d += ctrl ? `Q${P(ctrl)} ${P(q)}` : `L${P(q)}`; ctrl = null; }
          else if (ctrl) { d += `Q${P(ctrl)} ${P({ x: (ctrl.x + q.x) / 2, y: (ctrl.y + q.y) / 2 })}`; ctrl = q; }
          else ctrl = q;
        }
        d += 'Z';
      }
      x += advance(g) + tracking;
    }
    return { d, box, ascent: ascent * k };
  };
  return { word };
}

/** The roof (viewBox 0 0 120 70): one stroke for the two slopes, two windows under the ridge. */
const roof = (x, y, s) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><path d="M8 46 60 8l52 38" fill="none" stroke="${CHALK}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<rect x="47" y="40" width="11" height="13" rx="2" fill="${SUN}"/><rect x="62" y="40" width="11" height="13" rx="2" fill="${SUN}"/></g>`;
const r1 = (v) => Math.round(v * 10) / 10;
const svg = (w, h, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(w)} ${r1(h)}" role="img" aria-label="${label}">\n<!-- ${NOTE} -->\n${body}\n</svg>\n`;
const NOTE = 'Brieltje: the roof with two lit windows, the letters Fredoka Bold\'s outlines (SIL OFL). Made by tools/brand/logo.mjs.';

const ttf = process.argv[2];
if (!ttf) throw new Error('usage: node tools/brand/logo.mjs <Fredoka-Bold.ttf>');
const f = font(ttf);

// The stacked logo: the roof centred over BRIELTJE, as on the poster; a faint night-blue copy of the
// letters 4 % of the size lower gives them the poster's depth on the sunset.
{
  const size = 100;
  const w = f.word('BRIELTJE', size, 20);
  const pad = 4;
  const roofW = 141, s = roofW / 120;
  const width = w.box.x1 - w.box.x0 + 2 * pad;
  const roofX = (width - roofW) / 2, roofY = pad - 3 * s; // the stroke's top touches the padding
  const capTop = roofY + 53 * s + 22; // a little air under the windows
  const dx = pad - w.box.x0, dy = capTop - w.box.y0;
  const shadow = 4;
  const height = dy + w.box.y1 + shadow + pad;
  writeFileSync(`${OUT}/brand/logo.svg`, svg(width, height, 'Brieltje',
    `<path transform="translate(${r1(dx)} ${r1(dy + shadow)})" fill="${NIGHT}" fill-opacity=".55" d="${w.d}"/>\n` +
    `<path transform="translate(${r1(dx)} ${r1(dy)})" fill="${CHALK}" d="${w.d}"/>\n${roof(r1(roofX), r1(roofY), r1(s * 1000) / 1000)}`));
  console.log(`logo.svg ${r1(width)} x ${r1(height)}`);
}

// The row logo: the roof beside "Brieltje", its windows' sills on the baseline. Also as two <symbol>s
// for index.html: the page sets the letters' colour (currentColor) and an outline under them in the HUD.
{
  const size = 100;
  const w = f.word('Brieltje', size, 0);
  const s = 0.8 * size / 50; // the roof a little taller than the capitals (sill to stroke top: 50 roof units)
  const gap = 0.36 * size;
  const top = Math.min(w.box.y0, -53 * s + 3 * s);
  const pad = 6; // room for the HUD's outline
  const x0 = pad, y0 = pad - top;
  const textX = x0 + 114 * s + gap - w.box.x0; // the eaves' round ends reach from 3 to 117 roof units
  const width = textX + w.box.x1 + pad;
  const height = y0 + w.box.y1 + pad;
  const roofX = x0 - 3 * s, roofY = y0 - 53 * s;
  writeFileSync(`${OUT}/brand/logo-row.svg`, svg(width, height, 'Brieltje',
    `<path transform="translate(${r1(textX)} ${r1(y0)})" fill="${CHALK}" d="${w.d}"/>\n${roof(r1(roofX), r1(roofY), r1(s * 1000) / 1000)}`));
  const vb = `0 0 ${r1(width)} ${r1(height)}`;
  console.log(`logo-row.svg ${vb}`);
  console.log(`\n<symbol id="brand-row" viewBox="${vb}"><path transform="translate(${r1(textX)} ${r1(y0)})" d="${w.d}"/>` +
    `${roof(r1(roofX), r1(roofY), r1(s * 1000) / 1000).replaceAll(`stroke="${CHALK}"`, 'stroke="var(--brand-roof, currentColor)"')}</symbol>\n`);
}

// The mark: the roof over a B on an evening-blue tile (120 x 120), for the tab and the home screen.
for (const [file, rx] of [['brand/logo-mark.svg', 28], ['favicon.svg', 28], ['brand/logo-mark-square.svg', 0]]) {
  const b = f.word('B', 60, 0);
  const s = 0.86;
  const roofY = 12;
  const sill = roofY + 53 * s;
  const capTop = sill + 7;
  const dx = 60 - (b.box.x0 + b.box.x1) / 2, dy = capTop - b.box.y0;
  writeFileSync(`${OUT}/${file}`, svg(120, 120, 'Brieltje',
    `<rect width="120" height="120"${rx ? ` rx="${rx}"` : ''} fill="${EVENING}"/>\n${roof(60 - 60 * s, roofY, s)}\n<path transform="translate(${r1(dx)} ${r1(dy)})" fill="${CHALK}" d="${b.d}"/>`));
  if (!rx) console.log(`B from ${r1(capTop)} to ${r1(dy + b.box.y1)}`);
}
