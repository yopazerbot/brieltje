// Scripted drives in the real game (world/car.ts, world/carGrip.ts) on a running dev server: hard stops from
// 50 km/h with the handbrake and with the brake, dry and in the rain, a handbrake turn at a junction, fast
// cornering and driving on grass. Prints the numbers; with --out, a screenshot of each run, and with --frames
// a picture every tenth of a second of the handbrake turn (for a GIF). With --phone: touch emulation, the
// stick to speed up and the BRAKE button (the handbrake) held until the car stands.
//   node tools/dev/drive.mjs --url http://localhost:5390/ --port 9860 [--out <folder>] [--frames] [--phone] [--quality low]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5390/', port: '9860', out: '', frames: false, phone: false, quality: 'low', width: '960', height: '540' });
const b = await launch({ port: Number(o.port), width: Number(o.width), height: Number(o.height) });
const shot = async (name) => {
  if (!o.out) return;
  mkdirSync(o.out, { recursive: true });
  await b.screenshot(join(o.out, `${name}.png`));
};
const kmh = 'Math.hypot(briel.currentCar().vx, briel.currentCar().vz) * 3.6';
const hand = { throttle: 0, brake: 0, steer: 0, handbrake: true };
const pedal = { throttle: 0, brake: 1, steer: 0, handbrake: false };
const stopRun = (input) => [
  { name: 'speed up', input: { throttle: 1, brake: 0, steer: 0, handbrake: false }, until: 'kmh', kmh: 50 },
  { name: 'stop', input, until: 'still' },
];
// A straight road out in the fields (the traffic's routes, src/data/roads.json): 200 m without a bend.
const road = { x: 636.6, z: 142.6, dx: 668.9 - 636.6, dz: 355.8 - 142.6 };
const putOnRoad = () => b.evaluate(`__put(${road.x}, ${road.z}, ${road.dx}, ${road.dz})`);

/** The game started, in the Tesla, the script's pedals ready (window.__run) and a way to put the car somewhere (window.__put). */
async function setUp() {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${o.quality}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');` });
  const url = new URL(o.url);
  url.searchParams.set('nobake', '');
  await startGame(b, url.href, { phone: o.phone });
  await b.waitFor('briel.cars.slice(0,2).every(c=>c.wheels.length===4)');
  await b.evaluate("document.getElementById('cc-close')?.click(); briel.getIn()", false);
  await b.waitFor('briel.driving()');
  // The hint the first seconds at the wheel: the speed, the handbrake's key and the way out.
  await b.sleep(300);
  console.log('hint:', JSON.stringify(await b.evaluate("document.getElementById('prompt')?.textContent ?? ''")));
  await shot(o.phone ? 'hint-phone' : 'hint');
  // The script's pedals instead of the keys: window.__drive (null: the player's own).
  await b.evaluate(`(() => {
    const car = briel.currentCar();
    const drive = car.drive;
    window.__drive = null;
    car.drive = function (dt, input, others) { return drive.call(this, dt, window.__drive ? { ...input, ...window.__drive } : input, others); };
    const kmh = () => Math.hypot(car.vx, car.vz) * 3.6;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    /** Steps of pedals, each held until a speed, until it stands, or for a time; where each began and ended. */
    window.__run = async (steps) => {
      const log = [];
      for (const s of steps) {
        window.__drive = s.input;
        const t0 = performance.now();
        const at = { x: car.x, z: car.z, yaw: car.yaw, kmh: kmh() };
        for (;;) {
          await frame();
          const t = (performance.now() - t0) / 1000;
          if ((s.until === 'kmh' && kmh() >= s.kmh) || (s.until === 'still' && kmh() < 0.2) || (s.until === 'time' && t >= s.s) || t > 30) break;
        }
        const end = { x: car.x, z: car.z, yaw: car.yaw, kmh: kmh(), s: (performance.now() - t0) / 1000 };
        log.push({ name: s.name, from: at, to: end, metres: Math.hypot(end.x - at.x, end.z - at.z), turnDeg: (Math.atan2(Math.sin(end.yaw - at.yaw), Math.cos(end.yaw - at.yaw)) * 180) / Math.PI, grip: [...car.grip] });
      }
      window.__drive = { throttle: 0, brake: 0, steer: 0, handbrake: true }; // held where it is (the brake would reverse once it stands)
      return log;
    };
    /** Put the car at (x, z) facing (dx, dz), standing, the camera behind it. */
    window.__put = (x, z, dx, dz) => {
      const g = briel.world.groundAt(x, z, 50, 0.3);
      car.place(x, g.y, z, Math.atan2(-dx, -dz));
      return { y: g.y, mat: g.mat ?? null, name: g.name };
    };
  })()`, false);
  await b.evaluate("briel.three.weather.setSolo('sunny'); briel.weatherAhead(3600)", false);
  await b.waitFor('briel.weatherState().wet < 0.02', 60000);
}

/** From 50 km/h on the straight road to a stand with `input`: how far, how long, how hard. */
async function stop(name, input) {
  console.log(name, 'at', JSON.stringify(await putOnRoad()));
  await b.sleep(1500);
  const log = await b.evaluate(`__run(${JSON.stringify(stopRun(input))})`);
  const s = log[1];
  const g = s.from.kmh / 3.6 / s.to.s / 9.81;
  console.log(JSON.stringify({ run: name, fromKmh: +s.from.kmh.toFixed(1), metres: +s.metres.toFixed(1), seconds: +s.to.s.toFixed(2), g: +g.toFixed(2), turnDeg: +s.turnDeg.toFixed(1), grip: s.grip.map((x) => +x.toFixed(2)) }));
  await shot(name);
}

/** Touch: the thumb pushes the stick up to 40 km/h, then the other holds the BRAKE button (the handbrake) until the car stands. */
async function phone() {
  await putOnRoad();
  await b.sleep(1500);
  const btn = await b.evaluate("(() => { const e = document.querySelector('#touch .t-jump'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: e.textContent, shown: r.width > 0 }; })()");
  console.log('touch brake button:', JSON.stringify(btn));
  const touch = (type, points) => b.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const stick = { x: 170, y: 290, id: 1 };
  await touch('touchStart', [stick]);
  await touch('touchMove', [{ ...stick, y: stick.y - 90 }]);
  await b.waitFor(`${kmh} >= 40`, 20000);
  await touch('touchEnd', []);
  const from = await b.evaluate(`({ x: briel.currentCar().x, z: briel.currentCar().z, kmh: ${kmh}, t: performance.now() })`);
  await touch('touchStart', [{ x: btn.x, y: btn.y, id: 2 }]);
  await b.sleep(200);
  const held = await b.evaluate("({ down: document.querySelector('#touch .t-jump').classList.contains('down'), rearSliding: briel.currentCar().slideR > 1 })");
  await shot('phone-handbrake');
  await b.waitFor(`${kmh} < 0.3`, 20000);
  const to = await b.evaluate('({ x: briel.currentCar().x, z: briel.currentCar().z, t: performance.now() })');
  await touch('touchEnd', []);
  console.log(JSON.stringify({ run: 'phone-handbrake', fromKmh: +from.kmh.toFixed(1), metres: +Math.hypot(to.x - from.x, to.z - from.z).toFixed(1), seconds: +((to.t - from.t) / 1000).toFixed(2), held }));
  if (!held.down || !held.rearSliding) process.exitCode = 1;
}

/** A handbrake turn at the junction by the church square: along the street at 40 km/h, then the handbrake and the wheel to the left. */
async function junction() {
  await b.evaluate('briel.loadVillage()');
  await b.waitFor("briel.village() === 'ready'", 240000);
  console.log('junction at', JSON.stringify(await b.evaluate('__put(538.3, -770.4, 0.96, 0.278)')));
  await b.sleep(2500);
  const steps = [
    { name: 'run up', input: { throttle: 1, brake: 0, steer: 0, handbrake: false }, until: 'kmh', kmh: 40 },
    { name: 'to the corner', input: { throttle: 0.3, brake: 0, steer: 0, handbrake: false }, until: 'time', s: 0.9 },
    { name: 'handbrake turn', input: { throttle: 0, brake: 0, steer: -1, handbrake: true }, until: 'time', s: 1 },
    { name: 'let go', input: { throttle: 0, brake: 0, steer: 0, handbrake: false }, until: 'time', s: 1.5 },
  ];
  const done = b.evaluate(`__run(${JSON.stringify(steps)}).then((l) => (window.__turn = l))`);
  if (o.frames && o.out) {
    // Pictures as it goes, about a tenth of a second apart, while the script drives.
    const frames = join(o.out, 'frames');
    mkdirSync(frames, { recursive: true });
    for (let i = 0; i < 45; i++) {
      await b.screenshot(join(frames, `turn-${String(i).padStart(3, '0')}.png`));
      await b.sleep(60);
    }
  }
  await done;
  const turn = await b.evaluate('window.__turn');
  console.log(JSON.stringify({ run: 'handbrake-turn', steps: turn.map((s) => ({ name: s.name, kmh: +s.to.kmh.toFixed(0), turnDeg: +s.turnDeg.toFixed(0), metres: +s.metres.toFixed(1) })) }));
  await shot('handbrake-turn');
}

/** Full lock at 80 km/h on the straight: how hard it pulls round (g) over the first second, and how much the front slides. */
async function corner() {
  await putOnRoad();
  await b.sleep(1500);
  const c = await b.evaluate(`(async () => {
    const car = briel.currentCar();
    await __run([{ name: 'speed up', input: { throttle: 1, brake: 0, steer: 0, handbrake: false }, until: 'kmh', kmh: 80 }]);
    window.__drive = { throttle: 0.6, brake: 0, steer: 1, handbrake: false };
    let most = 0, slide = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 1000) {
      await new Promise((r) => requestAnimationFrame(r));
      most = Math.max(most, Math.abs(car.ay) / 9.81);
      slide = Math.max(slide, car.slideF);
    }
    return { latG: most, slideF: slide, kmh: Math.hypot(car.vx, car.vz) * 3.6, grip: [...car.grip] };
  })()`);
  console.log(JSON.stringify({ run: 'corner-80', latG: +c.latG.toFixed(2), frontSlideMs: +c.slideF.toFixed(2), kmhAfter: +c.kmh.toFixed(0), grip: c.grip.map((x) => +x.toFixed(2)) }));
  await shot('corner-80');
  await b.evaluate('__run([{ name: "stop", input: { throttle: 0, brake: 1, steer: 0, handbrake: false }, until: "still" }])');
}

/** On the field beside the straight road (the bare ground): from 50 km/h to a stand on the brake. */
async function grass() {
  const n = Math.hypot(road.dx, road.dz);
  const at = { x: road.x + (road.dz / n) * 30, z: road.z - (road.dx / n) * 30 };
  console.log('field at', JSON.stringify(await b.evaluate(`__put(${at.x}, ${at.z}, ${road.dx}, ${road.dz})`)));
  await b.sleep(1500);
  const s = (await b.evaluate(`__run(${JSON.stringify(stopRun(pedal))})`))[1];
  console.log(JSON.stringify({ run: 'brake-grass', fromKmh: +s.from.kmh.toFixed(1), metres: +s.metres.toFixed(1), g: +(s.from.kmh / 3.6 / s.to.s / 9.81).toFixed(2), grip: s.grip.map((x) => +x.toFixed(2)) }));
  await shot('grass');
}

try {
  console.log('Browser PID:', b.pid);
  await setUp();
  if (o.phone) await phone();
  else {
    await stop('handbrake-dry', hand);
    await stop('brake-dry', pedal);
    await junction();
    await corner();
    await grass();
    // The rain: the road soaked (the weather moved on until it is), then the two stops again.
    await b.evaluate("briel.three.weather.setSolo('rain'); briel.weatherAhead(3600)", false);
    await b.waitFor('briel.weatherState().wet > 0.95', 90000);
    await stop('handbrake-wet', hand);
    await stop('brake-wet', pedal);
  }
  console.log('Browser errors:', JSON.stringify(b.logs.filter((l) => /^(error|exception)/.test(l)).slice(-10)));
} finally {
  b.close();
}
