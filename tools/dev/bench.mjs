// Frame time of the game, headless (tools/dev/cdp.mjs): a warm-up run (shader compiles, texture uploads),
// then a few measured runs of briel.bench(), per graphics preset.
//
//   node tools/dev/bench.mjs [--url http://localhost:5200/] [--quality low,medium,high,ultra] [--at x,z,feet,yaw,pitch]
//                            [--frames 120] [--runs 3] [--village] [--phone] [--port 9341]
//
// Other agents share the graphics chip: compare two versions by alternating them (A, B, A, B) in one session,
// and say the chip was shared when you report the numbers (AGENTS.md).
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', quality: 'low', at: '', frames: '120', runs: '3', village: false, phone: false, port: '9341' });
const b = await launch({ port: Number(o.port) });
try {
  await startGame(b, o.url, { phone: o.phone, village: o.village });
  if (o.at) {
    const [x, z, feet, yaw = 0, pitch = 0] = o.at.split(',').map(Number);
    await b.evaluate(`briel.teleport(${x}, ${z}, ${feet}, ${yaw}, ${pitch})`, false);
  }
  await b.sleep(2000);
  for (const q of o.quality.split(',')) {
    await b.evaluate(`briel.three.applyQuality(${JSON.stringify(q)})`, false);
    await b.sleep(500);
    await b.evaluate(`briel.bench(${Number(o.frames)})`, false); // warm-up
    const runs = [];
    for (let i = 0; i < Number(o.runs); i++) runs.push(await b.evaluate(`briel.bench(${Number(o.frames)})`, false));
    const ms = runs.map((r) => r.msPerFrame);
    console.log(`${q}: ${ms.join(', ')} ms per frame (${runs[0].pixels.join('x')} pixels)`);
  }
} finally {
  b.close();
}
