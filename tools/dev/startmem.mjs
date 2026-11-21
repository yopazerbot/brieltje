// What one start of the game holds in memory, headless (tools/dev/cdp.mjs): at the start's peak and `--secs` seconds
// into play. Run it before a push and compare against the last numbers, so a feature that makes the start heavier is
// seen before a phone's browser ends the page (21 Nov 2026: an iPhone ended it at 94 % of the bar).
//
//   node tools/dev/startmem.mjs --url http://localhost:5360/ [--phone] [--quality low|medium|high|ultra|auto]
//        [--start house|church] [--mood sunny] [--secs 20] [--json run.json] [--timeline] [--tag main] [--port 9460]
//        [--size 1920x1080] [--every 1] [--timeout 300]
//   node tools/dev/startmem.mjs --compare base.json new.json [--allow 40]
//
// One browser, one page, the same steps every run: the settings put in the page's storage before it loads (the preset,
// the start place, the weather, the feedback card held back), the start screen clicked through as tools/dev/cdp.mjs's
// startGame does
// (6 s after the button shows: the dev build attaches its handlers late), play waited for, then `--secs` more. --phone
// is the touch emulation of the other tools (844x390, touch); --quality defaults to low with --phone, high without.
// Needs the dev server (window.briel) only for the scene's geometry line; the rest works on any build on this computer.
//
// How it measures:
// - Every `--every` seconds (default 1) from opening the page, a forced collection (HeapProfiler.collectGarbage, the
//   page and its workers), then one sample of everything below. The peak is the sample with the highest total. The
//   collections add to the time to play (a few seconds on a phone start): compare times only between runs of this tool.
// - The chip's side is a ledger kept by wrapping WebGL's calls before the page's own scripts run: each texture's levels
//   as the chip stores them (RGB padded to 4 bytes, mipmaps a third more), render targets (textures drawn into:
//   shadow maps, the effects' targets), renderbuffers (times their samples), buffers by bufferData. Deleted ones leave
//   the ledger. The canvas's own drawing buffer is an estimate from its size and antialiasing.
// - In the page: 2D canvases (width x height x 4, those with a context), decoded images (natural size x 4), image
//   bitmaps, audio buffers (length x channels x 4), shader programs (made and not deleted), the scene's geometry arrays
//   (attributes, indices and instance matrices still held on the processor, each array once).
// - From Chromium: the live JS heap and the DOM's heap after the collection, and the array-buffer backing stores (typed
//   arrays, the geometry above among them; audio buffers may be counted there too).
// - --timeline: the 100 ms samples taken in the page from 75 % of the bar to play (between the page's own tasks; the JS
//   heap there is before any collection), with the collected samples between them, so a pile-up at the end shows.
//
// What the numbers are not:
// - Chrome's usedJSHeapSize at its highest is mostly garbage the collector has not taken yet (it swings by hundreds of
//   MB as a start loads): this tool reports the live heap after a collection, and that highest value only as a note.
// - A desktop Chromium acting as a phone is not an iPhone: Safari's engine, its collector and the chip's driver hold
//   different amounts, and nobody knows the phone's limit from here. The numbers compare builds, they are not the
//   phone's limit. On a phone the chip and the processor share one memory, hence one total over both.
// - Not counted: the browser's own memory, compiled code, the driver's copies, fonts, the network cache.
//
// --compare prints two runs side by side as a Markdown table with the differences, and exits 1 when the total at the
// peak or in play grew by more than --allow MB (default 40), so it can gate a push. Give the older run first.
// Measure twice: two runs of the same build agree within a few MB (see the spread in the report that brought this in).
import { writeFileSync, readFileSync } from 'node:fs';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({
  url: '', phone: false, quality: '', start: 'church', mood: 'sunny', secs: '20', json: '', timeline: false, tag: '', port: '9460',
  size: '1920x1080', every: '1', timeout: '300', compare: '', allow: '40',
});

/** The lines of the report, in order: key, label, whether it is a count rather than MB. */
const ROWS = [
  ['heapMB', 'JS heap (live, after a collection)'],
  ['domMB', 'DOM heap (live)'],
  ['arraysMB', 'typed arrays (array-buffer backing stores)'],
  ['geometryMB', '- of which the scene geometry'],
  ['workersMB', 'workers (their heaps and arrays)'],
  ['canvasMB', '2D canvases'],
  ['imagesMB', 'decoded images'],
  ['bitmapsMB', 'image bitmaps'],
  ['audioMB', 'audio buffers'],
  ['texMB', 'chip: textures'],
  ['rtMB', 'chip: render targets'],
  ['rbMB', 'chip: renderbuffers'],
  ['drawMB', 'chip: the canvas drawing buffer (estimate)'],
  ['bufMB', 'chip: vertex and index buffers'],
  ['chipMB', 'chip: all'],
  ['programs', 'shader programs (count)', true],
  ['totalMB', 'total'],
];
const SUMMED = ['heapMB', 'domMB', 'arraysMB', 'workersMB', 'canvasMB', 'imagesMB', 'bitmapsMB', 'audioMB', 'chipMB'];
const CHIP = ['texMB', 'rtMB', 'rbMB', 'drawMB', 'bufMB'];

if (o.compare) process.exit(compare(o.compare, o._[0], Number(o.allow)));

if (!o.url) {
  console.error('--url http://localhost:<port>/ is needed (or --compare a.json b.json)');
  process.exit(2);
}
localOnly(o.url, '--url'); // a measurement of a build on this computer, never of the live site
const quality = o.quality || (o.phone ? 'low' : 'high');
if (!['low', 'medium', 'high', 'ultra', 'auto'].includes(quality)) {
  console.error(`--quality: low, medium, high, ultra or auto, not ${quality}`);
  process.exit(2);
}
if (!['sunny', 'overcast', 'rain', 'dusk', 'night', 'snow', 'auto'].includes(o.mood)) {
  console.error(`--mood: sunny, overcast, rain, dusk, night, snow or auto, not ${o.mood}`);
  process.exit(2);
}
if (!/^[a-z_]+$/.test(o.start)) {
  console.error(`--start: a start place's id (house, church), not ${o.start}`);
  process.exit(2);
}
const [width, height] = o.size.split('x').map(Number);
const every = Math.max(0.25, Number(o.every)) * 1000;

/**
 * Runs in the page before its own scripts (as a string): the WebGL ledger, the canvases, images, bitmaps and audio
 * buffers, the 100 ms samples and the moment play begins. Plain JavaScript: it is sent with Function.toString.
 */
function pageProbe() {
  if (window.__sm || window.top !== window) return;
  const MiB = 1048576;
  const G = WebGL2RenderingContext;
  const SIZE = {
    RGBA8: 4, SRGB8_ALPHA8: 4, RGB8: 4, SRGB8: 4, RGBA: 4, RGB: 4, R8: 1, RG8: 2, LUMINANCE: 1, ALPHA: 1, LUMINANCE_ALPHA: 2,
    RED: 1, RG: 2, RGBA16F: 8, RGB16F: 8, RG16F: 4, R16F: 2, RGBA32F: 16, RGB32F: 16, RG32F: 8, R32F: 4, R11F_G11F_B10F: 4,
    RGB10_A2: 4, RGB9_E5: 4, RGB565: 2, RGBA4: 2, RGB5_A1: 2, RGBA8UI: 4, RGBA16UI: 8, RGBA32UI: 16, R8UI: 1, R16UI: 2,
    R32UI: 4, RG8UI: 2, RG16UI: 4, RG32UI: 8, R8I: 1, R16I: 2, R32I: 4, DEPTH_COMPONENT16: 2, DEPTH_COMPONENT24: 4,
    DEPTH_COMPONENT32F: 4, DEPTH24_STENCIL8: 4, DEPTH32F_STENCIL8: 8, DEPTH_COMPONENT: 4, DEPTH_STENCIL: 4, STENCIL_INDEX8: 1,
  };
  const fmtName = new Map();
  for (const n of Object.keys(SIZE)) if (G[n] !== undefined && !fmtName.has(G[n])) fmtName.set(G[n], n);
  const UNSIZED = new Set([G.RGBA, G.RGB]);
  const bpp = (fmt, type) => {
    if (UNSIZED.has(fmt) && type === G.HALF_FLOAT) return 8;
    if (UNSIZED.has(fmt) && type === G.FLOAT) return 16;
    return SIZE[fmtName.get(fmt)] ?? 4;
  };
  const fmtLabel = (fmt, type) => {
    const n = fmtName.get(fmt);
    if (!n) return '0x' + Number(fmt).toString(16) + ' (compressed)';
    return UNSIZED.has(fmt) && (type === G.HALF_FLOAT || type === G.FLOAT) ? n + (type === G.FLOAT ? '/FLOAT' : '/HALF_FLOAT') : n;
  };
  const FACE0 = G.TEXTURE_CUBE_MAP_POSITIVE_X, FACE5 = G.TEXTURE_CUBE_MAP_NEGATIVE_Z;
  const tot = { tex: 0, rt: 0, rb: 0, buf: 0 };
  const tex = new Map(), buf = new Map(), rb = new Map(), programs = new Set();
  const state = new WeakMap();
  const st = (gl) => {
    let s = state.get(gl);
    if (!s) state.set(gl, (s = { unit: 0, units: [], buffers: {}, rb: null }));
    return s;
  };
  const texOf = (gl, target) => {
    const s = st(gl);
    const u = s.units[s.unit] || {};
    return u[target >= FACE0 && target <= FACE5 ? G.TEXTURE_CUBE_MAP : target];
  };
  const resum = (r) => {
    const old = r.b;
    let b = 0;
    for (const v of Object.values(r.levels)) b += v;
    if (r.mip && !r.storage && Object.keys(r.levels).length <= (r.cube ? 6 : 1)) b *= 4 / 3;
    r.b = b;
    tot[r.rt ? 'rt' : 'tex'] += b - old;
  };
  const setLevel = (gl, target, level, fmt, type, w, h, d, bytes) => {
    const t = texOf(gl, target);
    const r = t && tex.get(t);
    if (!r) return;
    const face = target >= FACE0 && target <= FACE5 ? target : 0;
    if (face) r.cube = true;
    if (r.storage) return; // texStorage's size is fixed; texImage on it fails
    r.levels[level + ':' + face] = bytes;
    if (level === 0) Object.assign(r, { w, h, d, fmt, type });
    resum(r);
  };
  const srcSize = (s) => [s.naturalWidth || s.videoWidth || s.displayWidth || s.width || 0, s.naturalHeight || s.videoHeight || s.displayHeight || s.height || 0];
  const protos = [window.WebGL2RenderingContext, window.WebGLRenderingContext].filter(Boolean).map((c) => c.prototype);
  for (const P of protos) {
    const before = (name, fn) => {
      const orig = P[name];
      if (typeof orig !== 'function') return;
      P[name] = function (...a) {
        try {
          fn.call(this, a);
        } catch {
          // the ledger never stops the page's own call
        }
        return orig.apply(this, a);
      };
    };
    const after = (name, fn) => {
      const orig = P[name];
      if (typeof orig !== 'function') return;
      P[name] = function (...a) {
        const x = orig.apply(this, a);
        try {
          fn.call(this, x, a);
        } catch {
          // as above
        }
        return x;
      };
    };
    after('createTexture', (t) => t && tex.set(t, { b: 0, levels: {}, w: 0, h: 0, d: 1, fmt: 0, type: 0, mip: false, cube: false, storage: false, rt: false, layers: false }));
    before('deleteTexture', ([t]) => {
      const r = tex.get(t);
      if (r) tot[r.rt ? 'rt' : 'tex'] -= r.b;
      tex.delete(t);
    });
    before('activeTexture', function ([u]) { st(this).unit = u - G.TEXTURE0; });
    before('bindTexture', function ([target, t]) { const s = st(this); (s.units[s.unit] ||= {})[target] = t; });
    before('texImage2D', function (a) {
      let w, h, type;
      if (a.length >= 8) [w, h, type] = [a[3], a[4], a[7]];
      else [[w, h], type] = [srcSize(a[5]), a[4]];
      setLevel(this, a[0], a[1], a[2], type, w, h, 1, w * h * bpp(a[2], type));
    });
    before('texImage3D', function (a) {
      const [target, level, fmt, w, h, d] = a;
      setLevel(this, target, level, fmt, a[8], w, h, d, w * h * d * bpp(fmt, a[8]));
      const r = tex.get(texOf(this, target));
      if (r) r.layers = true;
    });
    before('copyTexImage2D', function ([target, level, fmt, , , w, h]) { setLevel(this, target, level, fmt, 0, w, h, 1, w * h * bpp(fmt)); });
    before('compressedTexImage2D', function (a) {
      const [target, level, fmt, w, h] = a;
      const data = a[6];
      setLevel(this, target, level, fmt, 0, w, h, 1, typeof data === 'number' ? data : data ? data.byteLength : 0);
    });
    before('compressedTexImage3D', function (a) {
      const [target, level, fmt, w, h, d] = a;
      const data = a[7];
      setLevel(this, target, level, fmt, 0, w, h, d, typeof data === 'number' ? data : data ? data.byteLength : 0);
    });
    const storage = (gl, target, levels, fmt, w, h, d) => {
      const r = tex.get(texOf(gl, target));
      if (!r) return;
      let bytes = 0, ww = w, hh = h, dd = d;
      for (let i = 0; i < levels; i++) {
        bytes += ww * hh * dd * bpp(fmt);
        ww = Math.max(1, ww >> 1);
        hh = Math.max(1, hh >> 1);
        if (target === G.TEXTURE_3D) dd = Math.max(1, dd >> 1);
      }
      if (target === G.TEXTURE_CUBE_MAP) {
        bytes *= 6;
        r.cube = true;
      }
      if (target === G.TEXTURE_2D_ARRAY || target === G.TEXTURE_3D) r.layers = true;
      Object.assign(r, { levels: { storage: bytes }, storage: true, w, h, d, fmt, type: 0, mip: levels > 1 });
      resum(r);
    };
    before('texStorage2D', function ([target, levels, fmt, w, h]) { storage(this, target, levels, fmt, w, h, 1); });
    before('texStorage3D', function ([target, levels, fmt, w, h, d]) { storage(this, target, levels, fmt, w, h, d); });
    before('generateMipmap', function ([target]) {
      const r = tex.get(texOf(this, target));
      if (r && !r.mip) {
        r.mip = true;
        resum(r);
      }
    });
    const attach = (t) => {
      const r = t && tex.get(t);
      if (!r || r.rt) return;
      tot.tex -= r.b;
      tot.rt += r.b;
      r.rt = true;
    };
    before('framebufferTexture2D', ([, , , t]) => attach(t));
    before('framebufferTextureLayer', ([, , t]) => attach(t));
    after('createBuffer', (x) => x && buf.set(x, { b: 0, kind: '' }));
    before('deleteBuffer', ([x]) => {
      const r = buf.get(x);
      if (r) tot.buf -= r.b;
      buf.delete(x);
    });
    before('bindBuffer', function ([target, x]) { st(this).buffers[target] = x; });
    before('bindBufferBase', function ([target, , x]) { st(this).buffers[target] = x; });
    before('bindBufferRange', function ([target, , x]) { st(this).buffers[target] = x; });
    before('bindVertexArray', function () { st(this).buffers[G.ELEMENT_ARRAY_BUFFER] = null; }); // each array object has its own
    before('bufferData', function (a) {
      const [target, data] = a;
      const r = buf.get(st(this).buffers[target]);
      if (!r) return;
      let b = 0;
      if (typeof data === 'number') b = data;
      else if (data) {
        const per = data.BYTES_PER_ELEMENT || 1;
        b = a.length >= 5 && a[4] ? a[4] * per : a.length >= 4 && a[3] ? data.byteLength - a[3] * per : data.byteLength;
      }
      tot.buf += b - r.b;
      r.b = b;
      r.kind = target === G.ELEMENT_ARRAY_BUFFER ? 'index' : target === G.ARRAY_BUFFER ? 'vertex' : target === G.UNIFORM_BUFFER ? 'uniform' : 'other';
    });
    after('createRenderbuffer', (x) => x && rb.set(x, { b: 0, w: 0, h: 0, fmt: 0, samples: 0 }));
    before('deleteRenderbuffer', ([x]) => {
      const r = rb.get(x);
      if (r) tot.rb -= r.b;
      rb.delete(x);
    });
    before('bindRenderbuffer', function ([, x]) { st(this).rb = x; });
    const rbSet = (gl, samples, fmt, w, h) => {
      const r = rb.get(st(gl).rb);
      if (!r) return;
      const b = w * h * bpp(fmt) * Math.max(1, samples);
      tot.rb += b - r.b;
      Object.assign(r, { b, w, h, fmt, samples });
    };
    before('renderbufferStorage', function ([, fmt, w, h]) { rbSet(this, 0, fmt, w, h); });
    before('renderbufferStorageMultisample', function ([, samples, fmt, w, h]) { rbSet(this, samples, fmt, w, h); });
    after('createProgram', (p) => p && programs.add(p));
    before('deleteProgram', ([p]) => programs.delete(p));
  }

  // Canvases with a context, images given a source, image bitmaps, audio buffers: held weakly, summed when sampled.
  const canvases = [], images = [], bitmaps = [], audio = [];
  const seen = new WeakSet();
  const hold = (list, x, extra) => {
    if (!x || seen.has(x)) return;
    seen.add(x);
    list.push({ ref: new WeakRef(x), ...extra });
  };
  for (const C of [window.HTMLCanvasElement, window.OffscreenCanvas].filter(Boolean)) {
    const gc = C.prototype.getContext;
    C.prototype.getContext = function (type, ...a) {
      const ctx = gc.call(this, type, ...a);
      if (ctx) hold(canvases, this, { type: String(type), ctx: new WeakRef(ctx) });
      return ctx;
    };
  }
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(v) { hold(images, this); src.set.call(this, v); } });
  const cib = window.createImageBitmap;
  if (cib) window.createImageBitmap = function (...a) { return cib.apply(this, a).then((x) => (hold(bitmaps, x), x)); };
  const AC = window.BaseAudioContext || window.AudioContext;
  if (AC) {
    const cb = AC.prototype.createBuffer;
    AC.prototype.createBuffer = function (...a) { const x = cb.apply(this, a); hold(audio, x); return x; };
    const dd = AC.prototype.decodeAudioData;
    AC.prototype.decodeAudioData = function (...a) { const p = dd.apply(this, a); if (p && p.then) p.then((x) => hold(audio, x), () => {}); return p; };
  }
  if (window.OfflineAudioContext) {
    const sr = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function () { return sr.call(this).then((x) => (hold(audio, x), x)); };
  }
  const live = (list) => {
    const out = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i].ref.deref();
      if (x) out.push([x, list[i]]);
      else list.splice(i, 1);
    }
    return out;
  };
  const cpuPixels = () => {
    let canvas = 0, draw = 0, img = 0, bmp = 0, n2d = 0;
    for (const [c, e] of live(canvases)) {
      const px = (c.width || 0) * (c.height || 0);
      if (/webgl/.test(e.type)) {
        const ctx = e.ctx.deref();
        const at = (ctx && ctx.getContextAttributes && ctx.getContextAttributes()) || {};
        const s = at.antialias ? 4 : 0;
        draw += px * (8 + 4 * s + (at.depth || at.stencil ? 4 * Math.max(1, s) : 0)); // front and back, the samples, depth
      } else {
        canvas += px * 4;
        n2d++;
      }
    }
    for (const im of document.images) hold(images, im);
    const imgs = live(images).filter(([i]) => i.complete && i.naturalWidth);
    for (const [i] of imgs) img += i.naturalWidth * i.naturalHeight * 4;
    const bms = live(bitmaps);
    for (const [b] of bms) bmp += (b.width || 0) * (b.height || 0) * 4;
    let au = 0;
    const aus = live(audio);
    for (const [a] of aus) au += a.length * a.numberOfChannels * 4;
    return { canvas, n2d, draw, img, nImg: imgs.length, bmp, nBmp: bms.length, au, nAu: aus.length };
  };
  const gone = () => {
    const p = document.getElementById('start-panel');
    if (!p || p.offsetParent === null) return true;
    const s = getComputedStyle(p);
    return s.visibility === 'hidden' || Number(s.opacity) < 0.05;
  };
  const r1 = (v) => Math.round(v * 10) / 10;
  const sm = (window.__sm = { clickAt: 0, playAt: 0, fine: [], rawHeapTop: 0 });
  // Every 100 ms after the click, between the page's tasks: the bar, the JS heap before any collection, the chip.
  setInterval(() => {
    if (!sm.clickAt) return;
    const now = performance.now();
    if (!sm.playAt && gone()) sm.playAt = now;
    if (sm.fine.length > 12000) return;
    const raw = performance.memory ? performance.memory.usedJSHeapSize / MiB : 0;
    sm.rawHeapTop = Math.max(sm.rawHeapTop, raw);
    const pct = parseInt((document.querySelector('[data-pct]') || { dataset: {} }).dataset.pct || '', 10);
    const c = cpuPixels();
    sm.fine.push([r1((now - sm.clickAt) / 1000), Number.isFinite(pct) ? pct : null, Math.round(raw), r1((tot.tex + tot.rt + tot.rb + tot.buf + c.draw) / MiB), r1((c.canvas + c.img + c.bmp) / MiB), programs.size, !!sm.playAt]);
  }, 100);
  /** One sample of the page's side (in MB), with the ten biggest chip allocations. */
  sm.snap = () => {
    const c = cpuPixels();
    let textures = 0, targets = 0;
    const big = [];
    for (const r of tex.values()) {
      if (r.rt) targets++;
      else textures++;
      big.push([r.b, `${r.w}x${r.h}${r.d > 1 ? 'x' + r.d : ''}${r.cube ? ' cube' : ''}${r.layers ? ' layers' : ''} ${fmtLabel(r.fmt, r.type)}${r.mip ? ' mips' : ''} ${r.rt ? 'target' : 'texture'}`]);
    }
    for (const r of rb.values()) big.push([r.b, `${r.w}x${r.h} ${fmtLabel(r.fmt, 0)}${r.samples ? ' x' + r.samples + ' samples' : ''} renderbuffer`]);
    big.sort((a, z) => z[0] - a[0]);
    const bufs = [...buf.values()].sort((a, z) => z.b - a.b).slice(0, 5).map((r) => `${r.kind} ${(r.b / MiB).toFixed(1)}`);
    let geometry = null;
    const scene = window.briel && window.briel.three && window.briel.three.scene;
    if (scene) {
      const arrays = new Set();
      const add = (a) => {
        const arr = a && (a.array || (a.data && a.data.array));
        if (arr && arr.byteLength) arrays.add(arr);
      };
      scene.traverse((x) => {
        const g = x.geometry;
        if (g) {
          for (const a of Object.values(g.attributes || {})) add(a);
          add(g.index);
          for (const list of Object.values(g.morphAttributes || {})) for (const a of list) add(a);
        }
        add(x.instanceMatrix);
        add(x.instanceColor);
      });
      geometry = 0;
      for (const arr of arrays) geometry += arr.byteLength;
      geometry /= MiB;
    }
    let village = null, quality = null, mood = null;
    try {
      village = window.briel && window.briel.village ? window.briel.village() : null;
      quality = window.briel && window.briel.three && window.briel.three.quality ? window.briel.three.quality() : null;
      const shown = window.briel && window.briel.weatherState ? window.briel.weatherState().shown : null;
      mood = shown && typeof shown === 'object' ? (shown.k ? `${shown.a} to ${shown.b}` : shown.a) : shown; // {a, b, k}: a blend from a to b
    } catch {
      // not there yet
    }
    return {
      t: sm.clickAt ? (performance.now() - sm.clickAt) / 1000 : null,
      pct: parseInt((document.querySelector('[data-pct]') || { dataset: {} }).dataset.pct || '', 10) || null,
      playing: !!sm.playAt,
      village, quality, mood,
      geometryMB: geometry,
      canvasMB: c.canvas / MiB, canvases: c.n2d, imagesMB: c.img / MiB, images: c.nImg, bitmapsMB: c.bmp / MiB, bitmaps: c.nBmp,
      audioMB: c.au / MiB, audioBuffers: c.nAu,
      texMB: tot.tex / MiB, textures, rtMB: tot.rt / MiB, targets, rbMB: tot.rb / MiB, renderbuffers: rb.size,
      drawMB: c.draw / MiB, bufMB: tot.buf / MiB, buffers: buf.size, programs: programs.size,
      top: big.slice(0, 10).map(([b, k]) => `${(b / MiB).toFixed(1)} MB  ${k}`),
      bufTop: bufs,
    };
  };
}

/** A second connection to the page, for its workers (dedicated workers: the ground's cutter, the texture transcoder). */
async function workerWatch(port) {
  const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map(), sessions = new Set();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    } else if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'worker') sessions.add(m.params.sessionId);
    else if (m.method === 'Target.detachedFromTarget') sessions.delete(m.params.sessionId);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => waiting.has(n) && (waiting.delete(n), reject(new Error('no answer'))), 30000).unref?.();
    });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  return {
    /** The workers' live heaps and backing stores, after a collection in each, in bytes. */
    async measure() {
      let bytes = 0, n = 0;
      for (const s of [...sessions]) {
        try {
          await send('HeapProfiler.collectGarbage', {}, s);
          const h = await send('Runtime.getHeapUsage', {}, s);
          bytes += h.usedSize + (h.backingStorageSize ?? 0);
          n++;
        } catch {
          // the worker ended
        }
      }
      return { bytes, n };
    },
    close: () => ws.close(),
  };
}

const MiB = 1048576;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

const b = await launch({ port: Number(o.port), width, height, extra: ['--enable-precise-memory-info'] });
console.log(`browser pid ${b.pid}: ${o.url} ${o.phone ? 'phone' : 'computer'} ${quality} at ${o.start}, ${o.secs} s into play`);
let workers;
const samples = [];
let exit = 0;
try {
  workers = await workerWatch(Number(o.port));
  const settings = { 'briel.graphics': quality, 'briel.spawn': o.start, 'briel.feedback': 'later', 'briel.settings': JSON.stringify({ mood: o.mood }) };
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { for (const [k, v] of Object.entries(${JSON.stringify(settings)})) localStorage.setItem(k, v); } catch {}` });
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${pageProbe.toString()})();` });
  await b.send('HeapProfiler.enable');
  if (o.phone) {
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  }

  /** A forced collection in the page and its workers, then one sample of everything (MB). */
  const sample = async () => {
    await b.send('HeapProfiler.collectGarbage');
    const h = await b.send('Runtime.getHeapUsage');
    const w = await workers.measure();
    const p = await b.evaluate('window.__sm ? window.__sm.snap() : null', false);
    if (!p) return null;
    const s = { ...p, heapMB: h.usedSize / MiB, domMB: (h.embedderHeapUsedSize ?? 0) / MiB, arraysMB: (h.backingStorageSize ?? 0) / MiB, workersMB: w.bytes / MiB, workers: w.n };
    s.chipMB = CHIP.reduce((a, k) => a + s[k], 0);
    s.totalMB = SUMMED.reduce((a, k) => a + s[k], 0);
    for (const k of Object.keys(s)) if (typeof s[k] === 'number' && /MB$|^t$/.test(k)) s[k] = r1(s[k]);
    return s;
  };
  let stop = false;
  const poll = (async () => {
    while (!stop) {
      const t0 = Date.now();
      const s = await sample().catch(() => null);
      if (s && !stop) samples.push(s);
      await b.sleep(Math.max(50, every - (Date.now() - t0)));
    }
  })();

  const button = o.phone ? '#choose-touch' : '#choose-kbm';
  await b.send('Page.navigate', { url: o.url });
  await b.waitFor(`!!document.querySelector('${button}')`);
  await b.sleep(6000); // as startGame: the dev build attaches the start screen's handlers late
  await b.evaluate(`(() => { const n = document.querySelector('#nick'); if (n && !n.value) { n.value = 'Check'; n.dispatchEvent(new Event('input', { bubbles: true })); } window.__sm.clickAt = performance.now(); document.querySelector('${button}').click(); })()`, false);
  await b.waitFor('window.__sm.playAt > 0', Number(o.timeout) * 1000);
  const playS = r1(await b.evaluate('(window.__sm.playAt - window.__sm.clickAt) / 1000', false));
  console.log(`play after ${playS} s; waiting ${o.secs} s`);
  await b.sleep(Number(o.secs) * 1000);
  stop = true;
  await poll;
  await b.send('HeapProfiler.collectGarbage');
  await b.sleep(500);
  const play = await sample();
  samples.push(play);

  const peak = samples.reduce((a, s) => (s.totalMB > a.totalMB ? s : a));
  const max = {};
  for (const [k] of ROWS) max[k] = Math.max(...samples.map((s) => s[k] ?? 0));
  const villageAt = samples.find((s) => s.village === 'ready' && s.t != null);
  const errors = b.logs.filter((l) => l.startsWith('exception:'));
  const env = await b.evaluate("(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return { gpu: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '', rawHeapTopMB: Math.round(window.__sm.rawHeapTop) }; })()", false);
  const version = (await b.send('Browser.getVersion')).product;
  const fine = await b.evaluate('window.__sm.fine', false);
  const from = fine.findIndex((r) => r[1] != null && r[1] >= 75);
  const to = fine.findIndex((r) => r[6]);
  const tail = from >= 0 ? fine.slice(from, to >= 0 ? to + 5 : undefined) : [];
  const run = {
    tool: 'startmem', version: 1, tag: o.tag, when: new Date().toISOString(), url: o.url, phone: o.phone, quality, start: o.start,
    mood: o.mood, secs: Number(o.secs), size: o.phone ? '844x390' : o.size, every: every / 1000, browser: version, gpu: env.gpu,
    qualityInPlay: play.quality, moodInPlay: play.mood,
    playS, villageReadyS: villageAt ? villageAt.t : null, errors: errors.length, rawHeapTopMB: env.rawHeapTopMB,
    peak, play, max, collected: samples.map((s) => [s.t, s.pct, s.heapMB, s.arraysMB, s.geometryMB, s.chipMB, s.totalMB]),
    ...(o.timeline ? { fine: tail } : {}),
  };
  report(run);
  if (errors.length) console.log(`page errors: ${errors.length}; first: ${errors.slice(0, 3).join(' | ')}`);
  if (o.timeline) {
    console.log('\ntimeline from 75 % of the bar to play (s after the click; 100 ms samples in the page, the heap before any collection;');
    console.log('"collected" lines are the forced samples):');
    console.log('     s  bar  heap(uncollected)  chip  canvas+images  programs');
    const lines = tail.map((r) => [r[0], `  ${String(r[0]).padStart(5)} ${String(r[1] ?? (r[6] ? 'play' : '')).padStart(4)} ${String(r[2]).padStart(10)} MB ${String(r[3]).padStart(8)} ${String(r[4]).padStart(8)} ${String(r[5]).padStart(9)}`]);
    const t0 = tail.length ? tail[0][0] : 0, t1 = tail.length ? tail[tail.length - 1][0] : 0;
    for (const s of samples) if (s.t != null && s.t >= t0 && s.t <= t1) lines.push([s.t + 0.001, `  ${String(s.t).padStart(5)} collected: heap ${s.heapMB}, arrays ${s.arraysMB}, geometry ${s.geometryMB}, chip ${s.chipMB}, total ${s.totalMB} MB`]);
    for (const [, l] of lines.sort((a, z) => a[0] - z[0])) console.log(l);
  }
  if (o.json) {
    writeFileSync(o.json, JSON.stringify(run, null, 1) + '\n');
    console.log(`\nwritten: ${o.json}`);
  }
} catch (e) {
  console.error(e.message);
  exit = 2;
} finally {
  workers?.close();
  b.close();
}
process.exitCode = exit;

/** The report of one run: a Markdown table of the peak, play and each line's own highest, then the biggest on the chip. */
function report(run) {
  const { peak, play, max } = run;
  console.log(`\n${run.tag ? run.tag + ': ' : ''}${run.phone ? 'phone' : 'computer'}, ${run.quality} (in play: ${run.qualityInPlay ?? '?'}), at ${run.start}, ${run.mood} (in play: ${run.moodInPlay ?? '?'}); ${run.gpu}`);
  console.log(`play ${run.playS} s after the click (with a collection every ${run.every} s); the village ready at ${run.villageReadyS ?? '-'} s`);
  console.log(`\n| | at the peak (${peak.t ?? '-'} s, bar ${peak.pct ?? (peak.playing ? 'play' : '-')}) | ${run.secs} s into play | own highest |`);
  console.log('|---|---:|---:|---:|');
  for (const [k, label, count] of ROWS) {
    const f = (v) => (v == null ? '-' : count ? String(v) : v.toFixed(1));
    console.log(`| ${label} | ${f(peak[k])} | ${f(play[k])} | ${f(max[k])} |`);
  }
  console.log(`\ncounts in play: ${play.textures} textures, ${play.targets} render targets, ${play.renderbuffers} renderbuffers, ${play.buffers} buffers, ${play.canvases} 2D canvases, ${play.images} images, ${play.bitmaps} bitmaps, ${play.audioBuffers} audio buffers, ${play.workers} workers`);
  console.log('the ten biggest on the chip in play:');
  for (const l of play.top) console.log(`  ${l}`);
  console.log(`the biggest buffers (MB): ${play.bufTop.join(', ')}`);
  console.log(`note: the JS heap before any collection reached ${run.rawHeapTopMB} MB (mostly garbage; not in the total)`);
}

/** Two runs side by side; 1 when a total grew by more than `allow` MB. */
function compare(fa, fb, allow) {
  if (!fa || !fb) {
    console.error('--compare a.json b.json');
    return 2;
  }
  const [a, b] = [fa, fb].map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const name = (r, f) => r.tag || f.replace(/^.*[\\/]/, '');
  const [na, nb] = [name(a, fa), name(b, fb)];
  for (const k of ['phone', 'quality', 'start', 'mood', 'secs', 'size']) if (a[k] !== b[k]) console.log(`warning: the runs differ in ${k} (${a[k]} against ${b[k]}): the numbers do not compare`);
  console.log(`${a.phone ? 'phone' : 'computer'}, ${a.quality}, at ${a.start}, ${a.secs} s into play; A = ${na}, B = ${nb}\n`);
  console.log(`| | A peak | B peak | change | A in play | B in play | change |`);
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  const f = (v, count) => (v == null ? '-' : count ? String(v) : v.toFixed(1));
  const d = (x, y, count) => (x == null || y == null ? '-' : (y - x > 0 ? '+' : '') + (count ? String(y - x) : (y - x).toFixed(1)));
  console.log(`| seconds to play | | | | ${f(a.playS)} | ${f(b.playS)} | ${d(a.playS, b.playS)} |`);
  for (const [k, label, count] of ROWS) console.log(`| ${label} | ${f(a.peak[k], count)} | ${f(b.peak[k], count)} | ${d(a.peak[k], b.peak[k], count)} | ${f(a.play[k], count)} | ${f(b.play[k], count)} | ${d(a.play[k], b.play[k], count)} |`);
  const grewPeak = b.peak.totalMB - a.peak.totalMB, grewPlay = b.play.totalMB - a.play.totalMB;
  if (grewPeak > allow || grewPlay > allow) {
    console.log(`\nFAIL: the total grew by ${grewPeak.toFixed(1)} MB at the peak and ${grewPlay.toFixed(1)} MB in play (allowed: ${allow} MB)`);
    return 1;
  }
  console.log(`\nok: the total changed by ${grewPeak.toFixed(1)} MB at the peak and ${grewPlay.toFixed(1)} MB in play (allowed: ${allow} MB)`);
  return 0;
}
