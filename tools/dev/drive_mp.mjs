// Two players together on a throwaway game server, through a dev server whose proxy points at it
// (API_PORT=<server port> npx vite --port <n>): Alice drives the Tesla out onto the street in front of the
// house and does a handbrake turn; Bob, standing by the house, watches it. Checks that the server took every
// state (Alice's car ends where Bob sees it) and that Bob sees it move smoothly: no jumps in place or heading
// from frame to frame, its brake lights on while it slides.
//   node tools/dev/drive_mp.mjs --url http://localhost:5391/ --ports 9862,9863 [--out <folder>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5391/', ports: '9862,9863', out: '' });
localOnly(o.url, '--url'); // two players join and drive: a throwaway server on this computer only
const [pa, pb] = o.ports.split(',').map(Number);
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};

/** A page that joins the game together under `name`. */
async function player(port, name) {
  const b = await launch({ port, width: 800, height: 450 });
  console.log(name, 'browser PID:', b.pid);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','low');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');" });
  const url = new URL(o.url);
  url.searchParams.set('nobake', '');
  await b.send('Page.navigate', { url: url.href });
  await b.waitFor("!!document.querySelector('#choose-kbm')");
  await b.sleep(6000); // the dev build attaches the start screen's handlers late
  await b.evaluate(`(() => {
    const n = document.querySelector('#nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mp=multi]').click();
    const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
    document.querySelector('#choose-kbm').click();
  })()`, false);
  try {
    await b.waitFor('!!window.briel', 60000);
  } catch (e) {
    console.log(name, 'did not start:', JSON.stringify(await b.evaluate("document.getElementById('mp-msg')?.textContent ?? ''")));
    b.close();
    throw e;
  }
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  await b.waitFor('briel.cars.slice(0,2).every(c=>c.wheels.length===4)');
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  return b;
}

// Names stay with whoever joined with them for the day: fresh ones each run.
const tag = Math.random().toString(36).slice(2, 6);
const alice = await player(pa, `Alice${tag}`);
const bob = await player(pb, `Bob${tag}`);
try {
  // Alice walks up to the Tesla's door (the server lets her move at a run, so it takes a moment), then gets in.
  console.log('Alice at', JSON.stringify(await alice.evaluate(`(() => {
    const car = briel.cars.find((c) => c.id === 'tesla');
    const at = car.exitSpot();
    briel.player.place(at.x, at.z, car.y, 0, 0);
    return { player: at, car: { x: car.x, z: car.z } };
  })()`)));
  // The server moves her no faster than a run from where she joined: ask again until it lets her in.
  for (let i = 0; i < 40 && !(await alice.evaluate('briel.driving()')); i++) {
    await alice.evaluate('briel.getIn()', false);
    await alice.sleep(1500);
  }
  await alice.waitFor('briel.driving()', 5000);
  ok('Alice drives the Tesla', true);
  await bob.waitFor(`(briel.cars.find((c) => c.id === 'tesla').driver ?? '').toLowerCase() === 'alice${tag}'`, 10000);
  ok('Bob sees Alice at the wheel', true);
  // Bob watches from the house's front, looking at the street.
  await bob.evaluate('briel.player.place(10, 10, briel.player.feet, Math.PI * 0.85, -0.05)', false);
  // Alice's pedals from the script.
  await alice.evaluate(`(() => {
    const car = briel.currentCar();
    const drive = car.drive;
    window.__drive = null;
    car.drive = function (dt, input, others) { return drive.call(this, dt, window.__drive ? { ...input, ...window.__drive } : input, others); };
  })()`, false);
  // The car put on the street in front of the house, facing along it (a few metres: within what the server lets
  // a car move in half a second), and held there while the server's ticks catch up.
  const step = (input, ms) => alice.evaluate(`(window.__drive = ${JSON.stringify(input)}, new Promise((r) => setTimeout(r, ${ms})))`);
  await alice.evaluate('(() => { const car = briel.currentCar(); car.place(28, briel.world.groundAt(28, 17.7, 5, 0.3).y, 17.7, Math.PI / 2); })()', false);
  await step({ throttle: 0, brake: 0, steer: 0, handbrake: true }, 2500);
  // Bob's view of the car, every frame.
  await bob.evaluate(`(() => {
    const car = briel.cars.find((c) => c.id === 'tesla');
    window.__seen = [];
    const look = () => { window.__seen.push({ t: performance.now(), x: car.x, z: car.z, yaw: car.yaw, braking: car.braking }); requestAnimationFrame(look); };
    requestAnimationFrame(look);
  })()`, false);
  const before = await alice.evaluate('({ x: briel.currentCar().x, z: briel.currentCar().z, yaw: briel.currentCar().yaw })');
  console.log('on the street at', JSON.stringify(before));
  // Along the street, then the handbrake with the wheel turned.
  await step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, 1700);
  const fast = await alice.evaluate('Math.hypot(briel.currentCar().vx, briel.currentCar().vz) * 3.6');
  await step({ throttle: 0, brake: 0, steer: -1, handbrake: true }, 400);
  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    await bob.screenshot(join(o.out, 'bob-sees-the-slide.png'));
    await alice.screenshot(join(o.out, 'alice-slides.png'));
  }
  await step({ throttle: 0, brake: 0, steer: -1, handbrake: true }, 1500);
  const end = await alice.evaluate('({ x: briel.currentCar().x, z: briel.currentCar().z, yaw: briel.currentCar().yaw })');
  await bob.sleep(1500); // the ticks arrive and are drawn a little behind
  const seen = await bob.evaluate('window.__seen.splice(0)');
  const last = seen[seen.length - 1];
  console.log('Alice ends at', JSON.stringify(end), 'from', fast.toFixed(0), 'km/h; Bob sees it at', JSON.stringify({ x: last.x, z: last.z, yaw: last.yaw }));
  ok('the server took every state: Bob sees the car where Alice left it', Math.hypot(end.x - last.x, end.z - last.z) < 0.3 && Math.abs(Math.atan2(Math.sin(end.yaw - last.yaw), Math.cos(end.yaw - last.yaw))) < 0.05);
  ok('it swung round', Math.abs(Math.atan2(Math.sin(end.yaw - before.yaw), Math.cos(end.yaw - before.yaw))) > 0.5, `${((end.yaw - before.yaw) * 57.3).toFixed(0)} degrees`);
  // Smooth for Bob: frame to frame no faster than the car can go (no jumps), and no sudden turn of its heading.
  let fastest = 0;
  let turn = 0;
  let accel = 0;
  for (let i = 2; i < seen.length; i++) {
    const [a, b, c] = [seen[i - 2], seen[i - 1], seen[i]];
    const dt = (c.t - b.t) / 1000;
    const dt0 = (b.t - a.t) / 1000;
    if (!(dt > 0.004) || !(dt0 > 0.004)) continue;
    const v1 = Math.hypot(c.x - b.x, c.z - b.z) / dt;
    const v0 = Math.hypot(b.x - a.x, b.z - a.z) / dt0;
    fastest = Math.max(fastest, v1);
    accel = Math.max(accel, Math.abs(v1 - v0) / dt);
    turn = Math.max(turn, Math.abs(Math.atan2(Math.sin(c.yaw - b.yaw), Math.cos(c.yaw - b.yaw))) / dt);
  }
  ok('no jumps for Bob', fastest < 20, `fastest ${fastest.toFixed(1)} m/s between frames, speed change at most ${accel.toFixed(0)} m/s2`);
  ok('no sudden turns for Bob', turn < 4, `at most ${turn.toFixed(2)} rad/s`);
  ok('Bob sees its brake lights while it slides', seen.some((s) => s.braking));
  console.log(JSON.stringify({ frames: seen.length, seconds: ((last.t - seen[0].t) / 1000).toFixed(1) }));
  for (const [who, b] of [['Alice', alice], ['Bob', bob]]) ok(`${who}: no errors on the page`, !b.logs.some((l) => /^(error|exception)/.test(l)), JSON.stringify(b.logs.filter((l) => /^(error|exception)/.test(l)).slice(-3)));
} finally {
  alice.close();
  bob.close();
}
process.exitCode = failed ? 1 : 0;
