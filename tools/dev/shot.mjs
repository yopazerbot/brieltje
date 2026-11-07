// A screenshot of the game from a given spot, headless (tools/dev/cdp.mjs).
//
//   node tools/dev/shot.mjs <out.png> [--url http://localhost:5200/] [--at x,z,feet,yaw,pitch] [--quality low]
//                           [--travel church] [--turn 0.5] [--phone] [--village] [--fly] [--swiftshader] [--port 9340] [--wait 2000]
//
// --mood night (sunny, overcast, rain, dusk, night, snow, auto) sets this page's weather and waits for its blend;
// --ahead 600 then moves its clock on by that many seconds (briel.weatherAhead: the cycle on Auto, the snow lying).
// --at teleports first (briel.teleport); --travel goes to a portal or street by its word, as /location does, and
// --turn then turns the view by that many radians; --fly keeps the player in the air there; --quality applies a graphics
// preset (low, medium, high, ultra); --village waits for the village before the picture.
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', at: '', travel: '', turn: '', quality: '', phone: false, village: false, fly: false, swiftshader: false, mood: '', ahead: '', port: '9340', wait: '2000' });
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
  if (o.travel) {
    await b.evaluate(`briel.travel(${JSON.stringify(o.travel)})`, false);
    await b.sleep(1500);
  }
  if (o.mood) {
    await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(o.mood)})`, false);
    await b.sleep(9000); // a mood picked by hand blends in over 8 s (world/weather.ts PICK_MS)
  }
  if (o.ahead) {
    await b.evaluate(`briel.weatherAhead(${Number(o.ahead)})`, false);
    await b.sleep(500);
  }
  if (o.turn) await b.evaluate(`briel.teleport(briel.player.x, briel.player.z, briel.player.feet, briel.player.yaw + ${Number(o.turn)}, 0)`, false);
  await b.sleep(Number(o.wait));
  await b.screenshot(out);
  console.log('saved', out);
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
} finally {
  b.close();
}
