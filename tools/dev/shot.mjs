// A screenshot of the game from a given spot, headless (tools/dev/cdp.mjs).
//
//   node tools/dev/shot.mjs <out.png> [--url http://localhost:5200/] [--at x,z,feet,yaw,pitch] [--quality low]
//                           [--phone] [--village] [--fly] [--swiftshader] [--port 9340] [--wait 2000]
//
// --at teleports first (briel.teleport); --fly keeps the player in the air there; --quality applies a graphics
// preset (low, medium, high, ultra); --village waits for the village before the picture.
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', at: '', quality: '', phone: false, village: false, fly: false, swiftshader: false, port: '9340', wait: '2000' });
const out = o._[0];
if (!out) throw new Error('usage: node tools/dev/shot.mjs <out.png> [options]');
const b = await launch({ port: Number(o.port), swiftshader: o.swiftshader });
try {
  await startGame(b, o.url, { phone: o.phone, village: o.village });
  if (o.quality) await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)})`, false);
  if (o.at) {
    const [x, z, feet, yaw = 0, pitch = 0] = o.at.split(',').map(Number);
    await b.evaluate(`briel.teleport(${x}, ${z}, ${feet}, ${yaw}, ${pitch})${o.fly ? '; briel.player.flying = true' : ''}`, false);
  }
  await b.sleep(Number(o.wait));
  await b.screenshot(out);
  console.log('saved', out);
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
} finally {
  b.close();
}
