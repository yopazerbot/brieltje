// Screenshots of many spots in one browser session (tools/dev/cdp.mjs), for comparing a look before and after:
// one page load instead of one for every picture (tools/dev/shot.mjs).
//
//   node tools/dev/shots.mjs <folder> [--url http://localhost:5200/] [--quality high] [--mood sunny] [--phone]
//                            [--only kapellenhoek,church_down] [--spots "name:x:z:yaw:pitch;name:x:z:yaw:pitch"]
//                            [--port 9351]
//
// The built-in spots are streets and portals (src/places.ts), each along the street and looking down at its edge.
// --only keeps some of them (or none: --only none); --spots adds your own, in the model's metres and radians.
// The player is dropped from 40 m up and lands on whatever is there (a roof, if the spot is under one).
import path from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', quality: 'high', mood: 'sunny', only: '', spots: '', port: '9351', phone: false });
const folder = o._[0];
if (!folder) throw new Error('usage: node tools/dev/shots.mjs <folder> [options]');

// name, place id, turn (radians added to the place's own direction), pitch
const SPOTS = [
  ['kapellenhoek', 'street:kapellenhoek', 0, -0.12],
  ['kapellenhoek_down', 'street:kapellenhoek', 0.6, -0.55],
  ['briel', 'street:briel', 0, -0.12],
  ['briel_down', 'street:briel', 0.6, -0.55],
  ['home', 'house', 0, -0.1],
  ['church', 'church', 0, -0.1],
  ['church_down', 'church', 0.8, -0.5],
  ['school', 'school', 0, -0.1],
  ['molenhoek', 'molenhoek', 0, -0.1],
  ['molenhoek_street', 'street:molenhoek', 0, -0.12],
  ['smetlededorp', 'street:smetlededorp', 0, -0.12],
  ['smetlededorp_down', 'street:smetlededorp', 0.6, -0.55],
  ['schildekens', 'street:schildekensstraat', 0, -0.12],
  ['diepestraat', 'street:diepestraat', 0, -0.12],
  ['kerkhofstraat', 'street:kerkhofstraat', 0, -0.12],
  ['oordegemkouter', 'street:oordegemkouter', 0, -0.12],
  ['serskamp', 'street:serskampstraat', 0, -0.12],
  ['smetledestraat', 'street:smetledestraat', 0, -0.12],
];
const only = o.only ? new Set(o.only.split(',')) : null;
const list = SPOTS.filter(([name]) => !only || only.has(name));
for (const spot of o.spots ? o.spots.split(';') : []) {
  const [name, x, z, yaw = 0, pitch = 0] = spot.split(':');
  list.push([name, [Number(x), Number(z), Number(yaw)], 0, Number(pitch)]);
}

const b = await launch({ port: Number(o.port) });
try {
  await startGame(b, o.url, { phone: o.phone, village: true });
  await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)})`, false);
  await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(o.mood)})`, false);
  await b.sleep(9000); // a mood picked by hand blends in over 8 s (world/weather.ts PICK_MS)
  for (const [name, where, turn, pitch] of list) {
    const at = typeof where === 'string'
      ? await b.evaluate(`(() => { const d = briel.places.find((p) => p.id === ${JSON.stringify(where)}); return d ? JSON.stringify(d.out || [d.x, d.z, 0]) : ''; })()`, false)
      : JSON.stringify(where);
    if (!at) {
      console.log('no such place:', where);
      continue;
    }
    const [x, z, yaw = 0] = JSON.parse(at);
    await b.evaluate(`briel.player.flying = false; briel.teleport(${x}, ${z}, 40, ${yaw}, 0); briel.walk(4, 0, 0)`, false);
    await b.sleep(2500); // the tiles round the new spot, the grass's images
    await b.evaluate(`briel.teleport(briel.player.x, briel.player.z, briel.player.feet, briel.player.yaw + ${turn}, ${pitch})`, false);
    await b.sleep(2500);
    await b.screenshot(path.join(folder, `${name}.png`));
    console.log('saved', name);
  }
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
} finally {
  await b.close();
}
