// Two more takes for the trailer (Yoshi, 11 Nov 2026: "also include the parachute fall briefly in the video, and
// driving a car at high speed as well, just flashes"), alone on the dev server: the car flat out down Molenhoek,
// then a jump over the church square, each with the game's own sound. They land in <out>/car and <out>/drop as a
// scene's frames do (eyes/, sound.webm), and are added to <out>/scenes.json for edit.mjs.
//
//   node tools/dev/trailer/extras.mjs --out <record's folder> [--url http://localhost:5300/]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options, startGame } from '../cdp.mjs';
import { AUDIO_TAP, CLEAN_CSS, css, record, size } from './lib.mjs';

const o = options({ url: 'http://localhost:5300/', out: '', port: '9451' });
localOnly(o.url, '--url');
if (!o.out) throw new Error('--out <folder> is needed');
const log = existsSync(join(o.out, 'scenes.json')) ? JSON.parse(readFileSync(join(o.out, 'scenes.json'), 'utf8')) : {};
const b = await launch({ port: Number(o.port), width: 1920, height: 1080, extra: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--force-device-scale-factor=1'] });
console.log('browser PID:', b.pid);
/** One take: frames and sound while `during` runs. */
async function take(name, during) {
  const dir = join(o.out, name);
  const stop = await record(b, join(dir, 'eyes'), { quality: 88, everyNth: 2 });
  const soundAt = await b.evaluate('window.__audio.start()', false);
  const note = await during();
  const sound = await b.evaluate('window.__audio.stop()');
  writeFileSync(join(dir, 'sound.webm'), Buffer.from(sound, 'base64'));
  const eyes = await stop();
  log[name] = { name, eyes, soundAt: soundAt / 1000, note };
  writeFileSync(join(o.out, 'scenes.json'), JSON.stringify(log, null, 1));
  console.log(`${name}: ${eyes.frames} frames (${eyes.fps.toFixed(1)} a second)`, JSON.stringify(note));
}
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','high');localStorage.setItem('briel.lang','en');${AUDIO_TAP}` });
  await size(b, 1920, 1080);
  await startGame(b, o.url, { village: true });
  await css(b, CLEAN_CSS);
  await b.evaluate("document.getElementById('cc-close')?.click(); briel.three.weather.setSolo('sunny')", false);

  // The car: put on Molenhoek facing along it, the pedal down, a touch of steering to stay on the street.
  await b.waitFor('briel.cars.slice(0,2).every(c=>c.wheels.length===4)');
  await b.evaluate('briel.getIn()', false);
  await b.waitFor('briel.driving()');
  // The road into Smetlede from the south (the traffic's own route: tools/roads.py, data/roads.json), followed
  // by steering at a point some way ahead, the pedal down where it runs straight.
  const path = JSON.parse(readFileSync(new URL('../../../web/src/data/roads.json', import.meta.url), 'utf8')).routes[3].legs[0].p.slice(0, 700);
  const steerSign = await b.evaluate(`(async () => {
    const car = briel.currentCar();
    const drive = car.drive;
    window.__drive = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    car.drive = function (dt, input, others) { return drive.call(this, dt, { ...input, ...window.__drive }, others); };
    const P = ${JSON.stringify(path)};
    const g = briel.world.groundAt(P[0], P[1], 2, 0.3);
    car.place(P[0], g.y, P[1], Math.atan2(-(P[8] - P[0]), -(P[9] - P[1])));
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    // Which way the wheel turns the car: a short pull to one side at a crawl.
    window.__drive = { throttle: 0.5, brake: 0, steer: 0.4, handbrake: false };
    const y0 = car.yaw;
    for (let i = 0; i < 70; i++) await frame();
    const sign = wrap(car.yaw - y0) >= 0 ? 1 : -1;
    window.__drive = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    car.place(P[0], g.y, P[1], Math.atan2(-(P[8] - P[0]), -(P[9] - P[1])));
    let k = 0;
    window.__follow = false;
    const loop = () => {
      requestAnimationFrame(loop);
      if (!window.__follow) return;
      while (k + 2 < P.length && Math.hypot(P[k] - car.x, P[k + 1] - car.z) < 14) k += 2; // the point ahead
      const want = Math.atan2(-(P[k] - car.x), -(P[k + 1] - car.z));
      const e = wrap(want - car.yaw);
      const end = k + 2 >= P.length;
      window.__drive = { throttle: end ? 0 : Math.abs(e) < 0.12 ? 1 : 0.35, brake: end ? 1 : 0, steer: Math.max(-1, Math.min(1, e * 2.2)) * sign, handbrake: false };
    };
    loop();
    return sign;
  })()`);
  await b.sleep(1200);
  await take('car', async () => {
    await b.evaluate('window.__follow = true', false);
    let top = 0;
    for (let i = 0; i < 36; i++) {
      await b.sleep(500);
      top = Math.max(top, await b.evaluate('Math.hypot(briel.currentCar().vx, briel.currentCar().vz) * 3.6', false));
    }
    await b.evaluate('window.__follow = false; window.__drive = { throttle: 0, brake: 1, steer: 0, handbrake: false }', false);
    return { topKmh: Math.round(top), steerSign };
  });
  await b.sleep(2500);
  await b.evaluate('briel.getOut()', false);
  await b.sleep(800);

  // The jump: over the church square, filmed from behind the jumper as the game does.
  await b.evaluate("briel.three.weather.setSolo('dusk')", false);
  await b.sleep(1500);
  await take('drop', async () => {
    await b.evaluate('briel.beginDrop({ x: 536, z: -770, yaw: 2.68 })', false);
    await b.sleep(15000);
    return { feet: await b.evaluate('+briel.player.feet.toFixed(1)', false) };
  });
} finally {
  b.close();
}
