// Two players together on a throwaway game server, through a dev server whose proxy points at it
// (API_PORT=<server port> npx vite --port <n>): Alice drives the Tesla out onto the street in front of the
// house and does a handbrake turn; Bob, standing by the house, watches it. Checks that the server took every
// state (Alice's car ends where Bob sees it) and that Bob sees it move smoothly: no jumps in place or heading
// from frame to frame, its brake lights on while it slides. Then a normal stop on the brake (Bob sees the
// brake lights, no jump), and Bob, who plays on a phone (touch emulation), gets in beside her and rides
// along: the car carries him, and he sees neither the Brake nor the Handbrake button.
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

/** A page that joins the game together under `name`; with `phone`, as a phone held sideways, played by touch. */
async function player(port, name, phone = false) {
  const b = await launch({ port, width: 800, height: 450 });
  console.log(name, 'browser PID:', b.pid);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','low');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');" });
  if (phone) {
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  }
  const url = new URL(o.url);
  url.searchParams.set('nobake', '');
  await b.send('Page.navigate', { url: url.href });
  await b.waitFor("!!document.querySelector('#choose-kbm')");
  await b.sleep(6000); // the dev build attaches the start screen's handlers late
  await b.evaluate(`(() => {
    const n = document.querySelector('#nick'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-mp=multi]').click();
    const age = document.querySelector('#mp-age'); if (!age.checked) age.click();
    document.querySelector('${phone ? '#choose-touch' : '#choose-kbm'}').click();
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
const bob = await player(pb, `Bob${tag}`, true);
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

  // The street here is short and lined with trees: the rest is done on the open field about 120 m east of the
  // house (x 116 to 140, z -20 to 24). The car is moved there in hops the server allows (each within what a
  // car covers in half a second), held a moment after each.
  const pose = () => alice.evaluate('({ x: briel.currentCar().x, z: briel.currentCar().z, yaw: briel.currentCar().yaw, along: briel.currentCar().speed, kmh: Math.hypot(briel.currentCar().vx, briel.currentCar().vz) * 3.6 })');
  const hold = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  const moveTo = async (x, z, yaw) => {
    for (let i = 0; i < 14; i++) {
      const p = await pose();
      const d = Math.hypot(x - p.x, z - p.z);
      const k = Math.min(1, 15 / Math.max(d, 1e-6));
      await alice.evaluate(`(() => { const car = briel.currentCar(), x = ${p.x + (x - p.x) * k}, z = ${p.z + (z - p.z) * k}; car.place(x, briel.world.groundAt(x, z, car.y + 1, 0.3).y, z, ${yaw}); })()`, false);
      await step(hold, 1200);
      if (k === 1) break;
    }
  };
  /**
   * Frames of a car as a page drew it: the most it moved between two of them (m/s), and the most it turned
   * (rad/s) over a twentieth of a second at least (a headless page's uneven frame times don't count).
   */
  const smooth = (frames) => {
    let jump = 0;
    let spin = 0;
    let gap = 0;
    for (let i = 1, j = 0; i < frames.length; i++) {
      const dt = (frames[i].t - frames[i - 1].t) / 1000;
      gap = Math.max(gap, dt);
      if (dt > 0.004) jump = Math.max(jump, Math.hypot(frames[i].x - frames[i - 1].x, frames[i].z - frames[i - 1].z) / dt);
      const span = (frames[i].t - frames[j].t) / 1000;
      if (span < 0.05) continue;
      spin = Math.max(spin, Math.abs(Math.atan2(Math.sin(frames[i].yaw - frames[j].yaw), Math.cos(frames[i].yaw - frames[j].yaw))) / span);
      j = i;
    }
    return { jump, spin, gap };
  };
  // Alice's own car each frame, to set what Bob sees against.
  await alice.evaluate(`(() => {
    const car = briel.currentCar();
    window.__mine = [];
    const look = () => { window.__mine.push({ t: performance.now(), x: car.x, z: car.z, yaw: car.yaw }); requestAnimationFrame(look); };
    requestAnimationFrame(look);
  })()`, false);

  // Bob gets in beside her and rides along from here: his phone shows neither Brake nor Handbrake, and the car
  // carries him. A passenger's page draws the car from the server's ticks as a watcher's does, so the checks
  // below hold for what he sees.
  for (let i = 0; i < 40 && !(await bob.evaluate('briel.askState().riding')); i++) {
    await bob.evaluate(`(() => { const car = briel.cars.find((c) => c.id === 'tesla'); const at = car.exitSpot(true); briel.player.place(at.x, at.z, car.y, 0, 0); briel.getIn(); })()`, false);
    await bob.sleep(1500);
  }
  const riding = await bob.evaluate('briel.askState().riding');
  ok('Bob rides along', riding, JSON.stringify(await bob.evaluate(`(() => { const c = briel.cars.find((c) => c.id === 'tesla'); return { bob: { x: briel.player.x, z: briel.player.z, feet: briel.player.feet }, car: { x: c.x, y: c.y, z: c.z, driver: c.driver, passenger: c.passenger } }; })()`)));
  const shown = await bob.evaluate(`[...document.querySelectorAll('#touch .tbtn')].filter((e) => !e.classList.contains('hidden') && e.getBoundingClientRect().width > 0).map((e) => e.className.replace('tbtn ', '') + ':' + e.textContent)`);
  ok('Bob as the passenger sees neither Brake nor Handbrake', riding && !shown.some((s) => /t-brake|t-jump/.test(s)), JSON.stringify(shown));
  if (o.out) await bob.screenshot(join(o.out, 'bob-rides-along.png'));

  // On the field Alice's car has the grass taken as dry asphalt and nothing in its way (fences, posts, trees):
  // grip and walls are the page's own, the server checks neither, so the turns are as on an open road.
  await alice.evaluate(`(() => {
    const car = briel.currentCar(), real = car.world;
    const put = { groundAt: (...a) => ({ ...real.groundAt(...a), mat: 'asphalt', name: 'street' }), boxFree: () => true, touching: () => null };
    car.world = new Proxy(real, { get: (t, k) => put[k] || (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    car.trees = [];
  })()`, false);
  await moveTo(134, -18, Math.PI);
  {
    const from = await bob.evaluate('({ x: briel.player.x, z: briel.player.z })');
    await step({ throttle: 0.6, brake: 0, steer: 0, handbrake: false }, 1500);
    await step({ throttle: 0, brake: 1, steer: 0, handbrake: false }, 1500);
    await step(hold, 800);
    const car = await pose();
    const to = await bob.evaluate('({ x: briel.player.x, z: briel.player.z, riding: briel.askState().riding })');
    ok('the car carries Bob', to.riding && Math.hypot(to.x - from.x, to.z - from.z) > 1 && Math.hypot(to.x - car.x, to.z - car.z) < 1, `${Math.hypot(to.x - from.x, to.z - from.z).toFixed(1)} m, ${Math.hypot(to.x - car.x, to.z - car.z).toFixed(2)} m from the car`);
  }

  // A normal stop: across the field, then the brake held until it stands (then the handbrake, as a player lets
  // go of the brake), and it must stand, not roll on backwards.
  await moveTo(134, -18, Math.PI);
  await bob.evaluate('window.__seen.length = 0', false);
  await step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, 1800);
  const moving = await pose();
  await alice.evaluate(`(async () => {
    const car = briel.currentCar();
    window.__drive = { throttle: 0, brake: 1, steer: 0, handbrake: false };
    while (Math.hypot(car.vx, car.vz) > 0.05) await new Promise((r) => requestAnimationFrame(r));
    window.__stood = { x: car.x, z: car.z, along: car.speed };
    await new Promise((r) => setTimeout(r, 150));
    window.__stood.after = car.speed;
    window.__drive = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  })()`);
  const stopped = await alice.evaluate('window.__stood');
  await step(hold, 1500);
  const seenStop = await bob.evaluate('window.__seen.splice(0)');
  const lastStop = seenStop[seenStop.length - 1];
  const stopMotion = smooth(seenStop);
  console.log('a normal stop from', moving.kmh.toFixed(0), 'km/h:', JSON.stringify({ alice: stopped, bob: lastStop && { x: lastStop.x, z: lastStop.z, yaw: lastStop.yaw } }));
  ok('the brake stops it standing, not rolling back', stopped.along > -0.05 && stopped.after > -0.05, `${stopped.after.toFixed(2)} m/s 0.15 s after it stood`);
  ok('Bob sees it stop where Alice stopped', Math.hypot(stopped.x - lastStop.x, stopped.z - lastStop.z) < 0.3);
  ok('Bob sees its brake lights as it stops', seenStop.some((s) => s.braking));
  ok('no jumps for Bob as it stops', stopMotion.jump < 20, `fastest ${stopMotion.jump.toFixed(1)} m/s between frames`);

  // A handbrake turn half round: up to about 60 km/h, the wheel full over and the handbrake held 2.2 s.
  await moveTo(134, -18, Math.PI);
  await bob.evaluate('window.__seen.length = 0', false);
  await step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, 3300);
  const run = await pose();
  await alice.evaluate('window.__mine.length = 0', false);
  await step({ throttle: 0, brake: 0, steer: 1, handbrake: true }, 2200);
  await step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, 1200);
  await step(hold, 1500);
  const turned = await pose();
  const seenTurn = await bob.evaluate('window.__seen.splice(0)');
  const lastTurn = seenTurn[seenTurn.length - 1];
  const turnMotion = smooth(seenTurn);
  const ownMotion = smooth(await alice.evaluate('window.__mine.splice(0)'));
  const degrees = (Math.atan2(Math.sin(turned.yaw - run.yaw), Math.cos(turned.yaw - run.yaw)) * 180) / Math.PI;
  console.log('a handbrake turn from', run.kmh.toFixed(0), 'km/h:', JSON.stringify({ alice: turned, bob: { x: lastTurn.x, z: lastTurn.z, yaw: lastTurn.yaw }, degrees }));
  ok('the handbrake turns it about half round', Math.abs(degrees) > 150, `${degrees.toFixed(0)} degrees from ${run.kmh.toFixed(0)} km/h`);
  ok('Bob sees it end where Alice did', Math.hypot(turned.x - lastTurn.x, turned.z - lastTurn.z) < 0.3 && Math.abs(Math.atan2(Math.sin(turned.yaw - lastTurn.yaw), Math.cos(turned.yaw - lastTurn.yaw))) < 0.05);
  ok('Bob sees its brake lights in the turn', seenTurn.some((s) => s.braking));
  // No jumps or sudden turns: Bob's view moves and turns it no faster than about the car itself does on Alice's page.
  ok('no jumps or sudden turns for Bob in the half turn', turnMotion.jump < Math.max(20, 1.25 * ownMotion.jump) && turnMotion.spin < Math.max(4, 1.15 * ownMotion.spin), `fastest ${turnMotion.jump.toFixed(1)} m/s (on Alice's page ${ownMotion.jump.toFixed(1)}), turning at most ${turnMotion.spin.toFixed(2)} rad/s (on Alice's page ${ownMotion.spin.toFixed(2)}); the longest frame ${(turnMotion.gap * 1000).toFixed(0)} ms (Alice ${(ownMotion.gap * 1000).toFixed(0)} ms)`);

  // Everything at once for 15 s from 200 km/h, as the car's unit test does (full throttle, brake, the wheel side to
  // side, the handbrake on and off; it hits what is round the field too): the server must take every state, so
  // Bob sees the car end where Alice has it.
  await moveTo(134, -18, Math.PI);
  const abuse = await alice.evaluate(`(async () => {
    const car = briel.currentCar();
    Object.assign(car, { vx: 0, vz: 55.6, speed: 55.6, lastSpeed: 55.6 });
    let most = 0;
    for (let i = 0; i < 900; i++) {
      window.__drive = { throttle: i % 120 < 70 ? 1 : 0, brake: i % 300 > 280 ? 1 : 0, steer: i % 90 < 45 ? 1 : -1, handbrake: i % 50 < 22 };
      await new Promise((r) => requestAnimationFrame(r));
      most = Math.max(most, Math.hypot(car.vx, car.vz));
    }
    window.__drive = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    return { mostKmh: most * 3.6 };
  })()`);
  await step(hold, 2500);
  const after = await pose();
  await bob.sleep(1000);
  const seenAbuse = await bob.evaluate('window.__seen.splice(0)');
  const lastAbuse = seenAbuse[seenAbuse.length - 1];
  ok('the server takes every state of the abuse run', Math.hypot(after.x - lastAbuse.x, after.z - lastAbuse.z) < 0.3, `at most ${abuse.mostKmh.toFixed(0)} km/h; Alice at ${after.x.toFixed(1)}, ${after.z.toFixed(1)}, Bob sees ${lastAbuse.x.toFixed(1)}, ${lastAbuse.z.toFixed(1)}`);

  for (const [who, b] of [['Alice', alice], ['Bob', bob]]) ok(`${who}: no errors on the page`, !b.logs.some((l) => /^(error|exception)/.test(l)), JSON.stringify(b.logs.filter((l) => /^(error|exception)/.test(l)).slice(-3)));
} finally {
  alice.close();
  bob.close();
}
process.exitCode = failed ? 1 : 0;
