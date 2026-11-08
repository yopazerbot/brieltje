// Frame time of the game, headless (tools/dev/cdp.mjs): a warm-up run (shader compiles, texture uploads),
// then a few measured runs of briel.bench(), per graphics preset.
//
//   node tools/dev/bench.mjs [--url http://localhost:5200/] [--quality low,medium,high,ultra] [--at x,z,feet,yaw,pitch]
//                            [--frames 120] [--runs 3] [--village] [--phone] [--igpu] [--port 9341] [--fixed]
//                            [--size 2560x1440] [--noglass] [--travel football]
//
// --igpu asks Chromium for the low-power graphics chip (this PC's integrated Radeon): a stand-in for weak machines.
// --fixed keeps the preset and the resolution as they are (no Auto drop, no dip of the resolution between the runs),
// so the numbers of a preset are that preset's at full resolution. --size: the window in pixels.
// --noglass: without the glass's picture of the street (world/glassLook.ts), to see what it costs. --travel: to a
// portal or street by its word first, as /location does.
//
// Other agents share the graphics chip: compare two versions by alternating them (A, B, A, B) in one session,
// and say the chip was shared when you report the numbers (AGENTS.md).
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', quality: 'low', at: '', frames: '120', runs: '3', village: false, phone: false, igpu: false, port: '9341', fixed: false, size: '1600x900', noglass: false, travel: '' });
const [width, height] = o.size.split('x').map(Number);
const b = await launch({ port: Number(o.port), width, height, extra: o.igpu ? ['--force_low_power_gpu'] : [] });
try {
  await startGame(b, o.url, { phone: o.phone, village: o.village });
  if (o.fixed) await b.evaluate('briel.three.holdQuality(true)', false);
  if (o.travel) {
    await b.evaluate(`briel.travel(${JSON.stringify(o.travel)})`, false);
    await b.sleep(1500);
  }
  if (o.at) {
    const [x, z, feet, yaw = 0, pitch = 0] = o.at.split(',').map(Number);
    await b.evaluate(`briel.teleport(${x}, ${z}, ${feet}, ${yaw}, ${pitch})`, false);
  }
  await b.sleep(2000);
  console.log('gpu:', await b.evaluate("(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); })()", false));
  for (const q of o.quality.split(',')) {
    await b.evaluate(`briel.three.applyQuality(${JSON.stringify(q)})`, false);
    if (o.noglass) await b.evaluate('briel.three.glassProbe.fine = false', false);
    await b.sleep(500);
    await b.evaluate(`briel.bench(${Number(o.frames)})`, false); // warm-up
    const runs = [];
    const sets0 = await b.evaluate('briel.three.glassProbe.sets', false);
    for (let i = 0; i < Number(o.runs); i++) runs.push(await b.evaluate(`briel.bench(${Number(o.frames)})`, false));
    const sets = (await b.evaluate('briel.three.glassProbe.sets', false)) - sets0;
    const ms = runs.map((r) => r.msPerFrame);
    const seconds = (ms.reduce((a, z) => a + z, 0) * Number(o.frames)) / 1000;
    console.log(`${q}: ${ms.join(', ')} ms per frame (${runs[0].pixels.join('x')} pixels); the glass's street drawn ${(sets / seconds).toFixed(1)} times a second`);
  }
} finally {
  b.close();
}
