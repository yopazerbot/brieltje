// QR codes made on the server (Yoshi, 7 Nov 2026: logging in on a console with the phone, and the admin's
// two-step login), our own code: no package. Model 2, byte mode, error correction level M, versions 1 to 10
// (up to 213 bytes, enough for a link or an authenticator's otpauth address). The page gets an SVG path
// (`svgPath`) and draws it; nothing it shows is ever read back.
//
// The steps are the standard's: the data in byte mode with its length, padded to the version's size, split
// into blocks with Reed-Solomon error correction over GF(256), interleaved, laid in the zigzag between the
// fixed patterns (finders, timing, alignment, the format and version bits), with the mask that scores best.

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // level M, versions 1 to 10
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

// ---- GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** The generator polynomial of degree `n` (its coefficients after the leading 1). */
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g.slice(1);
}

/** The `n` error correction bytes of `data`. */
export function eccOf(data, n) {
  const g = generator(n);
  const rem = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] ^= mul(g[i], factor);
  }
  return rem;
}

/** Modules a version holds for data and error correction, in bits. */
function rawBits(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    r -= (25 * align - 10) * align - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataBytes = (ver) => Math.floor(rawBits(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

/** Where a version's alignment patterns are centred (rows and columns alike). */
function alignAt(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * The QR code of `text` (UTF-8): a square of booleans, true for dark, without the quiet zone. Throws when
 * it is too long for version 10.
 */
export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let ver = 1;
  while (ver <= MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataBytes(ver) * 8) ver++;
  if (ver > MAX_VERSION) throw new Error('Too long for a QR code here');
  const size = ver * 4 + 17;
  const cap = dataBytes(ver);

  // The bits: byte mode, the length, the bytes, a terminator, then whole bytes and the padding bytes.
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Blocks: the short ones first, each with its error correction; then interleaved.
  const blocks = BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawBits(ver) / 8);
  const shortLen = Math.floor(raw / blocks) - eccLen; // data bytes in a short block
  const shorts = blocks - (raw % blocks);
  const parts = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const len = shortLen + (i < shorts ? 0 : 1);
    const d = data.slice(at, at + len);
    at += len;
    parts.push({ d, e: eccOf(d, eccLen) });
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) for (const p of parts) if (i < p.d.length) out.push(p.d[i]);
  for (let i = 0; i < eccLen; i++) for (const p of parts) out.push(p.e[i]);

  // The fixed patterns, marked as such so the data goes round them.
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => {
    dark[y][x] = v;
    fixed[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = alignAt(ver);
  for (const ay of al) {
    for (const ax of al) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === al.at(-1)) || (ax === al.at(-1) && ay === 6)) continue; // under a finder
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const format = (mask) => {
    const v = mask; // level M is 00
    let rem = v;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((v << 10) | rem) ^ 0x5412;
    const bit = (i) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true); // the dark module
  };
  format(0); // reserves the format areas
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((v >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // The data, in the zigzag: two columns at a time from the right, up and down in turn, skipping column 6.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (fixed[y][x]) continue;
        dark[y][x] = i < out.length * 8 && ((out[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }

  // The mask that scores best (fewest long runs, blocks, finder look-alikes, and dark near half).
  let best = null;
  for (let m = 0; m < 8; m++) {
    const g = dark.map((row, y) => row.map((v, x) => (fixed[y][x] ? v : v !== MASKS[m](x, y))));
    const s = penalty(g);
    if (!best || s < best.s) best = { m, g, s };
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark[y][x] = best.g[y][x];
  format(best.m);
  return dark;
}

/** The standard's penalty for a masked symbol (lower is better). */
function penalty(g) {
  const n = g.length;
  let s = 0;
  let darkCount = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) s += run - 2;
        run = 1;
      }
    }
    if (run >= 5) s += run - 2;
    // Finder look-alikes: 1011101 with four light modules on either side.
    for (let i = 0; i + 7 <= n; i++) {
      const p = [1, 0, 1, 1, 1, 0, 1].every((b, k) => get(i + k) === (b === 1));
      if (!p) continue;
      const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !get(i - k));
      const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= n || !get(i + 7 + k));
      if (lightBefore || lightAfter) s += 40;
    }
  };
  for (let y = 0; y < n; y++) line((x) => g[y][x]);
  for (let x = 0; x < n; x++) line((y) => g[y][x]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (g[y][x] === g[y][x + 1] && g[y][x] === g[y + 1][x] && g[y][x] === g[y + 1][x + 1]) s += 3;
  for (const row of g) for (const v of row) if (v) darkCount++;
  s += Math.floor(Math.abs(darkCount * 20 - n * n * 10) / (n * n)) * 10;
  return s;
}

/**
 * The QR code of `text` as one SVG path in a square of `size` units (the code and a quiet zone of 4 modules
 * round it): { size, d }. The page puts `d` on a path, dark on light.
 */
export function svgPath(text) {
  const m = qrMatrix(text);
  const border = 4;
  let d = '';
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (!m[y][x]) continue;
      let w = 1;
      while (x + w < m.length && m[y][x + w]) w++;
      d += `M${x + border} ${y + border}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return { size: m.length + border * 2, d };
}
