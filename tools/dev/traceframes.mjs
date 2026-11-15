// Reads a browser trace (tools/dev/loadtime.mjs --trace) round a moment: per thread (the page's, its compositor, the
// raster and image-decode workers, the GPU process's), the events of that window longer than --min ms, nested by
// what contains what, with their start from the mark and their length, and the details that tell them apart (how
// many elements a style recalculation touched, what a layout or a paint covered). For what fills a long frame that a
// CPU profile shows only as "(program)": style, layout, paint, raster, decoding, the GPU's work.
// --programs: instead, the GPU programs the browser built in the window (Chrome's Skia on Dawn names each one: its
// target, how it draws and what it fills with), and the GPU process's compile tasks and raster flushes over --min ms.
// A program built for the first time stalls the GPU process while it compiles (15 to 90 ms on this PC): the page's
// first drawing of something new, such as a large soft shadow.
//
//   node tools/dev/traceframes.mjs trace.json [--mark loadtime:play] [--from -50] [--to 400] [--min 2] [--depth 3]
//        [--threads CrRendererMain,Compositor,CrGpuMain,VizCompositorThread,Raster,ThreadPool] [--programs]
import { readFileSync } from 'node:fs';
import { options } from './cdp.mjs';

const o = options({ mark: 'loadtime:play', from: '-50', to: '400', min: '2', depth: '3', threads: 'CrRendererMain,Compositor,CrGpuMain,VizCompositorThread,Raster,ThreadPool,CrBrowserMain', programs: false });
const file = o._[0];
if (!file) throw new Error('give a trace file');
const raw = JSON.parse(readFileSync(file, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;

const threadName = new Map();
const processName = new Map();
for (const e of events) {
  if (e.ph !== 'M') continue;
  if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args.name);
  if (e.name === 'process_name') processName.set(e.pid, e.args.name);
}
const mark = events.find((e) => e.name === o.mark && e.ph !== 'M');
if (!mark) throw new Error(`no mark ${o.mark} in the trace`);
const t0 = mark.ts;
const from = t0 + Number(o.from) * 1000;
const to = t0 + Number(o.to) * 1000;
const min = Number(o.min) * 1000;
const wanted = o.threads.split(',');
const ms = (ts) => ((ts - t0) / 1000).toFixed(1).padStart(8);

if (o.programs) {
  const inWindow = (e) => e.ph !== 'M' && e.ts >= from && e.ts <= to;
  for (const e of events.filter((e) => inWindow(e) && e.name === 'createGraphicsPipeline')) console.log(`${ms(e.ts)} ms  program  ${e.args?.desc ?? ''}`);
  for (const name of ['DawnPlatformImpl::RunWorkerTask', 'RasterDecoderImpl::DoEndRasterCHROMIUM::Flush']) {
    for (const e of events.filter((e) => inWindow(e) && e.name === name && (e.dur ?? 0) >= min)) console.log(`${ms(e.ts)} ms ${((e.dur ?? 0) / 1000).toFixed(1).padStart(7)} ms  ${name}`);
  }
  process.exit(0);
}

// Complete events, B/E pairs made into one, per thread.
const byThread = new Map();
const open = new Map();
for (const e of events) {
  const k = `${e.pid}:${e.tid}`;
  let ev = null;
  if (e.ph === 'X') ev = { name: e.name, ts: e.ts, dur: e.dur ?? 0, args: e.args };
  else if (e.ph === 'B') (open.get(k) ?? open.set(k, []).get(k)).push(e);
  else if (e.ph === 'E') {
    const b = open.get(k)?.pop();
    if (b) ev = { name: b.name, ts: b.ts, dur: e.ts - b.ts, args: { ...b.args, ...e.args } };
  }
  if (!ev || ev.ts + ev.dur < from || ev.ts > to) continue;
  (byThread.get(k) ?? byThread.set(k, []).get(k)).push(ev);
}

/** The details worth a look, by event. */
function detail(e) {
  const a = e.args ?? {};
  const d = a.data ?? a.beginData ?? {};
  const bits = [];
  if (a.elementCount ?? d.elementCount) bits.push(`${a.elementCount ?? d.elementCount} elements`);
  if (a.beginData?.dirtyObjects) bits.push(`${a.beginData.dirtyObjects}/${a.beginData.totalObjects} objects`);
  if (d.width && d.height) bits.push(`${d.width}x${d.height}`);
  if (d.clip) bits.push(`clip ${d.clip.slice(0, 2).join(',')}..${d.clip.slice(4, 6).join(',')}`);
  if (d.url) bits.push(String(d.url).replace(/^.*\//, ''));
  if (d.nodeName) bits.push(d.nodeName);
  if (d.type && e.name === 'EventDispatch') bits.push(d.type);
  if (d.functionName) bits.push(d.functionName);
  if (a.endData?.layoutRoots) bits.push(`${a.endData.layoutRoots.length} roots`);
  return bits.length ? `  [${bits.join(', ')}]` : '';
}

for (const [k, list] of byThread) {
  const [pid] = k.split(':');
  const name = threadName.get(k) ?? k;
  if (!wanted.some((w) => name.startsWith(w))) continue;
  list.sort((a, z) => a.ts - z.ts || z.dur - a.dur);
  // Depth by containment.
  const stack = [];
  const rows = [];
  for (const e of list) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    const depth = stack.length;
    stack.push(e);
    if (e.dur >= min && depth < Number(o.depth)) rows.push({ e, depth });
  }
  if (!rows.length) continue;
  console.log(`\n== ${processName.get(Number(pid)) ?? pid} / ${name}`);
  for (const { e, depth } of rows) console.log(`${((e.ts - t0) / 1000).toFixed(1).padStart(8)} ms ${(e.dur / 1000).toFixed(1).padStart(7)} ms ${'  '.repeat(depth)}${e.name}${detail(e)}`);
}
