// Scripted drives in the real game (world/car.ts, world/carGrip.ts) on a running dev server: hard stops from
// 50 km/h with the handbrake and with the brake, dry and in the rain, a handbrake turn at a junction, fast
// cornering and driving on grass. Prints the numbers; with --out, a screenshot of each run, and with --frames
// a picture every tenth of a second of the handbrake turn (for a GIF). With --phone: touch emulation, the
// stick to speed up, the Brake button held until the car stands, then the Handbrake button.
// With --feel, how the car drives, in numbers (world/car.ts "the feel of the drive"): the turning circle at
// 20 to 200 km/h with a full stick and with the keys W + A held (real key events), the stops from 50, 100
// and 200 km/h dry, wet and on snow, the brake held through the stop and pressed again at rest (when it
// reverses), handbrake turns from 40 and 60 km/h every quarter second (the heading, the slide, the speed and
// the camera's angle to the car), held on a slope, and a controller's stick and triggers (a fake pad).
// These runs start on the straight road out in the fields, with the ground's grip taken as dry asphalt and
// nothing in the car's way, as on an empty car park (--paved and --open, both on by default; `false` for the
// real ground and the real fences and trees). --json <file> keeps the numbers to compare a change with.
//   node tools/dev/drive.mjs --url http://localhost:5390/ --port 9860 [--out <folder>] [--frames] [--phone] [--feel [--only handbrake,wet]] [--json <file>] [--quality low]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5390/', port: '9860', out: '', frames: false, phone: false, feel: false, only: '', json: '', paved: 'true', open: 'true', quality: 'low', width: '960', height: '540' });
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

/**
 * Touch: the thumb pushes the stick up to 40 km/h, then the other holds the Brake button until the car stands
 * (and on: it reverses only once it has stood a moment); then again to 40 km/h, the stick to the right and the
 * Handbrake button held 0.8 s: the back swings round.
 */
async function phone() {
  const where = (sel) => b.evaluate(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: e.textContent, shown: r.width > 0 && !e.classList.contains('hidden') }; })()`);
  const brakeBtn = await where('#touch .t-brake');
  const hbBtn = await where('#touch .t-jump');
  console.log('touch buttons:', JSON.stringify({ brake: brakeBtn, handbrake: hbBtn }));
  if (!brakeBtn?.shown || !hbBtn?.shown) process.exitCode = 1;
  const touch = (type, points) => b.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const stick = { x: 170, y: 290, id: 1 };
  const up = { ...stick, y: stick.y - 90 };
  const car = (more = '') => b.evaluate(`(() => { const c = briel.currentCar(); return { x: c.x, z: c.z, yaw: c.yaw, kmh: ${kmh}, along: c.speed, t: performance.now(), lit: c.braking, rearSliding: c.slideR > 1${more} }; })()`);
  // The Brake button, held through the stop.
  await putOnRoad();
  await b.sleep(1500);
  await touch('touchStart', [stick]);
  await touch('touchMove', [up]);
  await b.waitFor(`${kmh} >= 40`, 20000);
  await touch('touchEnd', []);
  const from = await car();
  // Each frame in the page: when it stands, whether its brake lights are on then, and when it rolls back.
  await b.evaluate(`(() => {
    const c = briel.currentCar(), t0 = performance.now(), r = (window.__rec = { stoodAt: null, x: 0, z: 0, litStanding: null, backAt: null, least: 0 });
    const look = () => {
      const t = (performance.now() - t0) / 1000;
      if (r.stoodAt === null) { r.least = Math.min(r.least, c.speed); if (Math.hypot(c.vx, c.vz) < 0.05) Object.assign(r, { stoodAt: t, x: c.x, z: c.z }); }
      else if (r.litStanding === null && t > r.stoodAt + 0.1) r.litStanding = c.braking;
      if (r.backAt === null && c.speed < -0.2) r.backAt = t;
      if (t < 8 && r.backAt === null) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  })()`, false);
  await touch('touchStart', [{ x: brakeBtn.x, y: brakeBtn.y, id: 2 }]);
  await b.sleep(200);
  const held = { down: await b.evaluate("document.querySelector('#touch .t-brake').classList.contains('down')"), ...(await car()) };
  await shot('phone-brake');
  await b.waitFor('window.__rec.backAt !== null', 10000).catch(() => {});
  await touch('touchEnd', []);
  const rec = await b.evaluate('window.__rec');
  const brake = {
    run: 'phone-brake', fromKmh: +from.kmh.toFixed(1), metres: +Math.hypot(rec.x - from.x, rec.z - from.z).toFixed(1), seconds: rec.stoodAt === null ? null : +rec.stoodAt.toFixed(2),
    held: { down: held.down, lit: held.lit, rearSliding: held.rearSliding }, leastSpeedBeforeStanding: +rec.least.toFixed(2), litStanding: rec.litStanding,
    reversesAfterStandingS: rec.backAt === null || rec.stoodAt === null ? null : +(rec.backAt - rec.stoodAt).toFixed(2),
  };
  console.log(JSON.stringify(brake));
  if (!held.down || held.rearSliding || !rec.litStanding || rec.least < -0.05 || !(brake.reversesAfterStandingS >= 0.25)) process.exitCode = 1;
  // The Handbrake button with the stick to the right.
  await putOnRoad();
  await b.sleep(1500);
  await touch('touchStart', [stick]);
  await touch('touchMove', [up]);
  await b.waitFor(`${kmh} >= 40`, 20000);
  const side = { ...stick, x: stick.x + 90 };
  await touch('touchMove', [side]);
  const start = await car();
  await touch('touchStart', [side, { x: hbBtn.x, y: hbBtn.y, id: 2 }]);
  await b.sleep(300);
  const sliding = await car();
  await shot('phone-handbrake');
  await b.sleep(500);
  await touch('touchEnd', []);
  await b.sleep(1500);
  const end = await car();
  const turned = (Math.atan2(Math.sin(start.yaw - end.yaw), Math.cos(start.yaw - end.yaw)) * 180) / Math.PI;
  console.log(JSON.stringify({ run: 'phone-handbrake-turn', fromKmh: +start.kmh.toFixed(1), rearSliding: sliding.rearSliding, lit: sliding.lit, turnedDeg: +turned.toFixed(0), kmhEnd: +end.kmh.toFixed(0) }));
  if (!sliding.rearSliding || turned < 45) process.exitCode = 1;
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

// ---- --feel: how the car drives, in numbers.
const results = {};
const keep = (name, value) => {
  results[name] = value;
  console.log(name, JSON.stringify(value));
};
const none = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const r1 = (x, d = 1) => +x.toFixed(d);

/** The page's side: launch the car at a speed, drive it frame by frame and log what it does. */
async function feelHelpers() {
  await b.evaluate(`(() => {
    const car = briel.currentCar();
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const ang = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const deg = (r) => (r * 180) / Math.PI;
    const v = () => Math.hypot(car.vx, car.vz);
    // The angle between where the car points and where it goes (> 0: going to its right).
    const slip = () => {
      const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
      const u = car.vx * fx + car.vz * fz, s = -car.vx * fz + car.vz * fx;
      return v() > 0.5 ? Math.atan2(s, u) : 0;
    };
    // The camera sits behind the car at camHeading + camYaw and looks at it: its view's angle to the car's heading.
    const cam = () => ang(car.camHeading + car.camYaw - car.yaw);
    const real = car.world, trees = car.trees;
    window.__feel = {
      /**
       * \`paved\`: the ground under the car's wheels taken as dry asphalt (its height stays the real one); \`open\`: nothing
       * in its way (fences, hedges, trees, the game's edge), as on an empty car park. Both off: the real world again.
       */
      ground(paved, open) {
        const put = { groundAt: paved && ((...a) => ({ ...real.groundAt(...a), mat: 'asphalt', name: 'street' })), boxFree: open && (() => true), boxInBounds: open && (() => true), touching: open && (() => null) };
        car.world = paved || open ? new Proxy(real, { get: (t, k) => put[k] || (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : real;
        car.trees = open ? [] : trees;
      },
      /** Rolling straight ahead at kmh, now. */
      launch(kmh) {
        const s = kmh / 3.6, fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
        Object.assign(car, { vx: fx * s, vz: fz * s, speed: s, lastSpeed: s });
      },
      /**
       * Frames with \`input\` (merged over the player's own: leave a field out and the keys or the pad give it) for
       * \`s\` seconds or until it stands ('still') or rolls back ('back'); \`hold\` km/h: the throttle holds that speed;
       * \`pump\` s: the brake on and off. A row every \`every\` s: seconds, degrees turned (to the right), slide
       * angle, km/h, the camera's angle to the car; and the frames' speeds with \`frames\`.
       */
      async run({ input = {}, s = 30, hold = 0, pump = 0, until = '', every = 0.25, frames = false }) {
        const rows = [], speeds = [];
        const t0 = performance.now(), x0 = car.x, z0 = car.z;
        let last = car.yaw, turned = 0, next = every, stoodAt = null, backAt = null, gripAt = null, camBackAt = null, least = 0, lit = 0, standing = 0, camMost = 0, steerMost = 0, camRateMost = 0;
        let camLast = car.camHeading + car.camYaw, tLast = 0, airFrames = 0;
        const yawAt = [];
        for (;;) {
          const t = (performance.now() - t0) / 1000;
          const i = { ...input };
          if (hold) i.throttle = Math.max(0, Math.min(1, (hold / 3.6 - v()) * 0.8));
          if (pump) i.brake = Math.floor(t / pump) % 2 ? 0 : 1;
          window.__drive = Object.keys(i).length ? i : null;
          await frame();
          const tt = (performance.now() - t0) / 1000;
          turned -= ang(car.yaw - last);
          last = car.yaw;
          yawAt.push([tt, turned, v()]);
          camMost = Math.max(camMost, Math.abs(cam()));
          // How fast the camera itself swings round (a fast swing is what makes a player queasy), over a tenth of a
          // second at least so the frames' uneven times don't count.
          if (tt - tLast >= 0.1) {
            camRateMost = Math.max(camRateMost, Math.abs(ang(car.camHeading + car.camYaw - camLast)) / (tt - tLast));
            camLast = car.camHeading + car.camYaw;
            tLast = tt;
          }
          steerMost = Math.max(steerMost, Math.abs(car.steer));
          if (stoodAt === null && v() < 0.05) stoodAt = tt;
          // Gripping: the slide under 5 degrees either way along the car (half round it may roll on backwards) and the spin nearly gone.
          if (gripAt === null && Math.abs(Math.atan2(Math.sin(slip()), Math.abs(Math.cos(slip())))) < 0.087 && Math.abs(car.turn) < 0.15) gripAt = tt;
          if (camBackAt === null && Math.abs(cam()) < 0.35) camBackAt = tt;
          if (stoodAt !== null && backAt === null) { standing++; if (car.braking) lit++; }
          if (backAt === null && car.speed < -0.2) backAt = tt;
          if (stoodAt === null) least = Math.min(least, car.speed);
          if (frames) speeds.push([+tt.toFixed(3), +car.speed.toFixed(3)]);
          if (car.air) airFrames++; // off the ground (world/carBody.ts rideHeight): the tyres hold nothing
          if (tt >= next) { rows.push([+tt.toFixed(2), Math.round(deg(turned)), Math.round(deg(slip())), Math.round(v() * 3.6), Math.round(deg(cam()))]); next += every; }
          if (tt > s || (until === 'still' && v() < 0.05) || (until === 'back' && car.speed < -0.2)) break;
        }
        // The turn rate and speed over the last second: the circle it drives.
        const end = yawAt[yawAt.length - 1];
        const from = yawAt.find((p) => p[0] >= end[0] - 1) ?? yawAt[0];
        const span = yawAt.filter((p) => p[0] >= from[0]);
        const rate = (end[1] - from[1]) / Math.max(1e-3, end[0] - from[0]);
        const speed = span.reduce((a, p) => a + p[2], 0) / span.length;
        return {
          seconds: (performance.now() - t0) / 1000, metres: Math.hypot(car.x - x0, car.z - z0), turnedDeg: deg(turned), rateDeg: deg(rate),
          radius: Math.abs(rate) > 1e-3 ? speed / Math.abs(rate) : Infinity, kmh: v() * 3.6, along: car.speed, steer: car.steer, steerMost, camMostDeg: deg(camMost), camRateMostDeg: deg(camRateMost),
          slipDeg: deg(slip()), turnRate: car.turn, stoodAt, backAt, gripAt, camBackAt, least, litWhileStanding: standing ? lit / standing : null, rows, speeds,
          yawAt: yawAt.map((p) => [+p[0].toFixed(3), +deg(p[1]).toFixed(1)]), grip: [...car.grip], crashed: car.crashed, atEdge: car.atEdge, airFrames,
        };
      },
      state: () => ({ x: car.x, z: car.z, yaw: car.yaw, kmh: v() * 3.6, slip: deg(slip()), cam: deg(cam()), turn: car.turn, steer: car.steer }),
    };
  })()`, false);
  await b.evaluate(`__feel.ground(${o.paved !== 'false'}, ${o.open !== 'false'})`, false);
}
/** A fresh start on the straight road, standing, then rolling at kmh. */
async function rollAt(kmh) {
  await putOnRoad();
  await b.sleep(700);
  await b.evaluate(`__feel.launch(${kmh})`, false);
}
const run = (args) => b.evaluate(`__feel.run(${JSON.stringify(args)})`);
const key = (type, code) => {
  const k = { KeyW: ['w', 87], KeyA: ['a', 65], KeyS: ['s', 83], KeyD: ['d', 68], Space: [' ', 32] }[code];
  return b.send('Input.dispatchKeyEvent', { type, code, key: k[0], windowsVirtualKeyCode: k[1] });
};

/** The turning circle with a full stick and with W + A on the keys (real key events), the speed held by the throttle. */
async function circles() {
  for (const kmh of [20, 30, 50, 100, 200]) {
    await rollAt(kmh);
    const stick = await run({ input: { ...none, steer: -1 }, hold: kmh, s: 3 });
    await rollAt(kmh);
    await key('keyDown', 'KeyW');
    await key('keyDown', 'KeyA');
    const keys = await run({ input: { brake: 0, handbrake: false }, hold: kmh, s: 3 });
    await key('keyUp', 'KeyA');
    await key('keyUp', 'KeyW');
    // The heading after the first second: how quickly it turns in.
    const first = (r) => Math.abs(r.yawAt.find((p) => p[0] >= 1)?.[1] ?? 0);
    keep(`circle-${kmh}`, {
      stick: { radius: r1(stick.radius), rateDeg: r1(stick.rateDeg, 0), firstSecondDeg: r1(first(stick), 0), wheelDeg: r1(Math.abs(stick.steer) * 57.3), kmhEnd: r1(stick.kmh, 0), camMostDeg: r1(stick.camMostDeg, 0), camRateMostDeg: r1(stick.camRateMostDeg, 0), grip: stick.grip[0], crashed: stick.crashed || stick.atEdge, airFrames: stick.airFrames },
      keysWA: { radius: r1(keys.radius), rateDeg: r1(keys.rateDeg, 0), firstSecondDeg: r1(first(keys), 0), wheelDeg: r1(Math.abs(keys.steer) * 57.3), ofFullLock: r1(Math.abs(keys.steer / stick.steer), 2), kmhEnd: r1(keys.kmh, 0), crashed: keys.crashed || keys.atEdge, airFrames: keys.airFrames },
    });
  }
}

/** Stopping from 50, 100 and 200 km/h on the brake: dry, wet (the road soaked) and on snow. */
async function stops(weather) {
  for (const kmh of weather === 'dry' ? [50, 100, 200] : [50, 100]) {
    await rollAt(kmh);
    const r = await run({ input: { ...none, brake: 1 }, until: 'still' });
    keep(`stop-${weather}-${kmh}`, { metres: r1(r.metres), seconds: r1(r.seconds, 2), g: r1(kmh / 3.6 / r.seconds / 9.81, 2), grip: r1(r.grip[0], 2), airFrames: r.airFrames });
  }
}

/** The brake held through the stop, pressed again at rest, and pumped: when it goes backwards. */
async function reverse() {
  await rollAt(50);
  const held = await run({ input: { ...none, brake: 1 }, s: 4, frames: true });
  keep('reverse-held', {
    stoodAt: r1(held.stoodAt ?? -1, 2), reversingAt: r1(held.backAt ?? -1, 2), gap: r1((held.backAt ?? NaN) - (held.stoodAt ?? NaN), 2),
    leastSpeedBeforeStand: r1(held.least, 3), lightsOnWhileStanding: held.litWhileStanding === null ? null : r1(held.litWhileStanding, 2), speedEnd: r1(held.along, 2),
    speedsAroundTheStop: held.speeds.filter((p) => Math.abs(p[0] - (held.stoodAt ?? 0)) < 0.6).filter((p, i) => i % 3 === 0),
  });
  await rollAt(30);
  await run({ input: { ...none, brake: 1 }, until: 'still' });
  await run({ input: none, s: 0.3 });
  const again = await run({ input: { ...none, brake: 1 }, until: 'back', s: 3 });
  keep('reverse-new-press', { secondsToRollBack: r1(again.seconds, 2) });
  const forward = await run({ input: { ...none, throttle: 1 }, s: 0.25 });
  keep('forward-from-reverse', { alongAfterQuarterSecond: r1(forward.along, 2) });
  await rollAt(30);
  const pumped = await run({ input: none, pump: 0.12, s: 6, until: 'still' });
  keep('pumped-from-30', { leastSpeed: r1(pumped.least, 3), seconds: r1(pumped.seconds, 2) });
  await run({ input: none, s: 0.5 }); // standing, before the next run
}

/** The car's turn rate (degrees a second) over each tenth of a second at least. */
const rates = (r) => {
  const out = [];
  for (let i = 0, j = 0; j < r.yawAt.length; j++) {
    if (r.yawAt[j][0] - r.yawAt[i][0] < 0.1) continue;
    out.push(Math.abs(r.yawAt[j][1] - r.yawAt[i][1]) / (r.yawAt[j][0] - r.yawAt[i][0]));
    i = j;
  }
  return out.length ? out : [0];
};

/** Handbrake turns: the wheel full over and the handbrake held, then let go with a little throttle. */
async function handbrakeTurns(weather) {
  const sets = weather === 'dry' ? [[40, 0.8], [60, 1.0], [60, 1.6], [60, 5], [100, 5]] : weather === 'wet' ? [[60, 1.2], [60, 5]] : [[50, 1.2], [50, 5]];
  for (const [kmh, hold] of sets) {
    await rollAt(kmh);
    const held = await run({ input: { ...none, steer: 1, handbrake: true }, s: hold, every: 0.25 });
    const after = await run({ input: { ...none, throttle: 0.4 }, s: 2, every: 0.25 });
    // Gripping again: the slide under 5 degrees and the spin nearly gone, the first frame after letting go.
    const rows = [...held.rows, ...after.rows.map((r) => [r1(r[0] + held.seconds, 2), r[1] + Math.round(held.turnedDeg), r[2], r[3], r[4]])];
    const most = Math.max(...held.yawAt.map((p) => p[1]), ...after.yawAt.map((p) => p[1] + held.turnedDeg));
    keep(`handbrake-${weather}-${kmh}-${hold}s`, {
      turnedAtRelease: r1(held.turnedDeg, 0), turnedEnd: r1(held.turnedDeg + after.turnedDeg, 0), mostDeg: r1(most, 0),
      regripS: after.gripAt === null ? null : r1(after.gripAt, 2), camMostDeg: r1(Math.max(held.camMostDeg, after.camMostDeg), 0), camRateMostDeg: r1(Math.max(held.camRateMostDeg, after.camRateMostDeg), 0), carRateMostDeg: r1(Math.max(...rates(held), ...rates(after)), 0), camUnder20AfterS: after.camBackAt === null ? null : r1(after.camBackAt, 2),
      'rows [s, deg turned, slide deg, km/h, camera deg]': rows,
    });
  }
}

/** On a slope: held by the handbrake, then let go, standing; how far it moves. */
async function slope() {
  // The steepest even slope of open ground within 400 m of the house, 3 to 15 % (the same climb over 2 and 4 m, both
  // ways, nothing built on it): the bare ground's height under any blocks, then the ground the car would stand on.
  const at = await b.evaluate(`(() => {
    let best = null;
    const base = (x, z) => briel.world.groundAt(x, z, -1e4, 0).y;
    for (let x = -400; x <= 400; x += 6) for (let z = -400; z <= 400; z += 6) {
      const y0 = base(x, z), gx = base(x + 2, z) - y0, gz = base(x, z + 2) - y0;
      if (Math.abs(base(x + 4, z) - y0 - 2 * gx) > 0.03 || Math.abs(base(x, z + 4) - y0 - 2 * gz) > 0.03) continue;
      const s = Math.hypot(gx, gz) / 2;
      if (s < 0.03 || s > 0.15 || (best && s <= best.s)) continue;
      const g = briel.world.groundAt(x, z, y0 + 1, 0.3);
      if (g.y - y0 > 0.05 || !briel.world.boxFree(x, z, 0, 3, 1.5, y0 + 0.3, y0 + 2)) continue;
      best = { x, z, s, dx: -gx, dz: -gz, mat: g.mat ?? g.name };
    }
    return best;
  })()`);
  if (!at) return keep('slope', { found: false });
  await b.evaluate('__feel.ground(false, false)', false);
  await b.evaluate(`__put(${at.x}, ${at.z}, ${at.dx}, ${at.dz})`);
  await b.sleep(1200);
  const hb = await run({ input: { ...none, handbrake: true }, s: 2 });
  const free = await run({ input: none, s: 2 });
  keep('slope', { at: [at.x, at.z], gradientPercent: r1(at.s * 100), mat: at.mat, movedOnHandbrakeM: r1(hb.metres, 3), movedLetGoM: r1(free.metres, 3) });
  await b.evaluate(`__feel.ground(${o.paved !== 'false'}, ${o.open !== 'false'})`, false);
}

/** A controller (a fake pad: the browser's Gamepad API answered by the script): R2, the stick full right, L2, then Cross. */
async function controller() {
  await b.evaluate(`(() => {
    const k = () => ({ pressed: false, touched: false, value: 0 });
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, k), vibrationActuator: null };
    window.__pad = pad;
    navigator.getGamepads = () => [pad, null, null, null];
    window.__padSet = (axes, buttons) => { pad.axes = axes; for (const [i, v] of Object.entries(buttons)) { pad.buttons[i].value = v; pad.buttons[i].pressed = v > 0.5; } pad.timestamp++; };
  })()`, false);
  const pad = (axes, buttons) => b.evaluate(`__padSet(${JSON.stringify(axes)}, ${JSON.stringify(buttons)})`, false);
  await rollAt(30);
  await pad([1, 0, 0, 0], { 7: 0, 6: 0, 0: 0 });
  const full = await run({ input: {}, s: 1.5 });
  await rollAt(30);
  await pad([0.5, 0, 0, 0], {});
  const half = await run({ input: {}, s: 1.5 });
  await rollAt(50);
  await pad([0, 0, 0, 0], { 6: 1 });
  const l2 = await run({ input: {}, s: 4 });
  await pad([0, 0, 0, 0], { 6: 0 });
  await rollAt(50);
  await pad([-1, 0, 0, 0], { 0: 1 });
  const cross = await run({ input: {}, s: 0.8 });
  await pad([0, 0, 0, 0], { 0: 0 });
  keep('controller', {
    fullStickWheelDeg: r1(Math.abs(full.steer) * 57.3), halfStickWheelDeg: r1(Math.abs(half.steer) * 57.3), halfOfFull: r1(Math.abs(half.steer / full.steer), 2),
    l2StoodAt: r1(l2.stoodAt ?? -1, 2), l2ReversingAt: r1(l2.backAt ?? -1, 2), crossTurnedDeg: r1(cross.turnedDeg, 0), crossSlideDeg: r1(cross.slipDeg, 0),
  });
  await b.evaluate('navigator.getGamepads = () => [null, null, null, null]', false);
}

async function feel() {
  // --only circles,stops,reverse,handbrake,slope,controller,wet,snow: some of the runs.
  const only = o.only ? o.only.split(',') : null;
  const want = (name) => !only || only.includes(name);
  await feelHelpers();
  if (want('circles')) await circles();
  if (want('stops')) await stops('dry');
  if (want('reverse')) await reverse();
  if (want('handbrake')) await handbrakeTurns('dry');
  if (want('slope')) await slope();
  if (want('controller')) await controller();
  if (o.out) await shot('feel-dry');
  if (want('wet')) {
    await b.evaluate("briel.three.weather.setSolo('rain'); briel.weatherAhead(3600)", false);
    await b.waitFor('briel.weatherState().wet > 0.95', 90000);
    await stops('wet');
    await handbrakeTurns('wet');
    if (o.out) await shot('feel-wet');
  }
  if (want('snow')) {
    await b.evaluate("briel.three.weather.setSolo('snow'); briel.weatherAhead(3600)", false);
    try {
      await b.waitFor('briel.weatherState().snow > 0.8', 120000);
      await stops('snow');
      await handbrakeTurns('snow');
      if (o.out) await shot('feel-snow');
    } catch {
      keep('snow', { lying: await b.evaluate('briel.weatherState().snow') });
    }
  }
  await b.evaluate('__feel.ground(false, false)', false);
  if (o.json) writeFileSync(o.json, JSON.stringify(results, null, 1));
}

try {
  console.log('Browser PID:', b.pid);
  await setUp();
  if (o.phone) await phone();
  else if (o.feel) await feel();
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
