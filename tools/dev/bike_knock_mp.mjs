// Two players together on a throwaway game server, through a dev server whose proxy points at it
// (API_PORT=<server port> npx vite --port <n>): Bob rides the bike by the main house out onto the street and leaves it
// standing across the road; Alice drives the Tesla into it at 40 km/h. Both pages must end with the bike lying in the same
// place on the same side (server/bikeHits.mjs, shared/bikeKnock.mjs), Alice's car driving on; Bob gets on the lying bike
// (it stands up on both pages), and Alice drives into him: a ridden bike stops the car and Bob stays on.
//   node tools/dev/bike_knock_mp.mjs --url http://localhost:5742/ --ports 9924,9925 [--out <folder>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5742/', ports: '9924,9925', out: '' });
localOnly(o.url, '--url'); // two players join and drive: a throwaway server on this computer only
const [pa, pb] = o.ports.split(',').map(Number);
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const shot = async (b, name) => {
  if (!o.out) return;
  mkdirSync(o.out, { recursive: true });
  await b.screenshot(join(o.out, `${name}.png`));
};

/** A page that joins the game together under `name` (as tools/dev/drive_mp.mjs). */
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
  await b.waitFor('!!window.briel', 60000);
  await b.waitFor("(() => { const p = document.getElementById('start-panel'); if (!p || p.offsetParent === null) return true; const s = getComputedStyle(p); return s.visibility === 'hidden' || Number(s.opacity) < 0.05; })()", 240000);
  await b.waitFor('briel.cars.slice(0,2).every(c=>c.wheels.length===4) && !!briel.bikes.rig');
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  return b;
}
const bikeOn = (b) => b.evaluate("JSON.stringify((() => { const k = briel.bikes.bikes.find((k) => k.id === 'house'); return { x: +k.x.toFixed(3), z: +k.z.toFixed(3), yaw: +k.yaw.toFixed(3), lie: k.lie, lean: +k.lean.toFixed(2), falling: !!k.fall, guess: k.guess, rider: k.rider }; })())").then(JSON.parse);
/** Ask again (the server lets a player move only at a run) until `done` holds. */
const until = async (b, ask, done, tries = 30) => {
  for (let i = 0; i < tries && !(await b.evaluate(done)); i++) {
    await b.evaluate(ask, false);
    await b.sleep(1500);
  }
  return b.evaluate(done);
};
const STREET = { x: 20, z: 17.9 }; // where Bob leaves the bike, across the road in front of the house

const tag = Math.random().toString(36).slice(2, 6);
const alice = await player(pa, `Alice${tag}`);
const bob = await player(pb, `Bob${tag}`);
try {
  // Bob: on the bike by the house, out of the passage onto the street (moved along at 6 m/s), off, and a few steps away.
  await bob.evaluate('briel.player.place(-1.6, 7.6, -0.05, -0.6, 0)', false);
  ok('Bob gets on the bike by the house', await until(bob, "briel.getOnBike('house')", "briel.bikes.mounted === 'house'"));
  await bob.evaluate(`(async () => {
    const k = briel.bikes.bikes.find((k) => k.id === 'house');
    for (const [x, z] of [[-0.5, ${STREET.z}], [${STREET.x}, ${STREET.z}]]) {
      for (let d = Math.hypot(x - k.x, z - k.z); d > 0.02; d = Math.hypot(x - k.x, z - k.z)) {
        const s = Math.min(d, 0.1);
        k.yaw = Math.atan2(-(x - k.x), -(z - k.z));
        k.x += ((x - k.x) / d) * s;
        k.z += ((z - k.z) / d) * s;
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
    k.yaw = 0; // across the road
  })()`);
  await bob.sleep(1500);
  await bob.evaluate('briel.getOffBike()', false);
  await bob.sleep(500);
  await bob.evaluate(`briel.player.place(${STREET.x - 4}, ${STREET.z - 4.5}, briel.player.feet, Math.atan2(-4, -4.5), -0.25)`, false);
  await alice.waitFor(`(() => { const k = briel.bikes.bikes.find((k) => k.id === 'house'); return !k.rider && Math.hypot(k.x - ${STREET.x}, k.z - ${STREET.z}) < 0.3; })()`, 10000);
  ok('Alice sees it standing on the street', true, JSON.stringify(await bikeOn(alice)));

  // Alice: into the Tesla, put on the street west of the bike facing it (two hops the server's budget allows, never over
  // the bike), held, then 40 km/h along the street through the bike.
  await alice.evaluate("(() => { const car = briel.cars.find((c) => c.id === 'tesla'); const at = car.exitSpot(); briel.player.place(at.x, at.z, car.y, 0, 0); })()", false);
  ok('Alice drives the Tesla', await until(alice, 'briel.getIn()', 'briel.driving()'));
  await alice.evaluate(`(() => {
    const car = briel.currentCar(), drive = car.drive;
    window.__want = -1; // km/h to hold; -1 the handbrake on
    car.drive = function (dt, input, others) {
      const kmh = Math.hypot(car.vx, car.vz) * 3.6, w = window.__want;
      return drive.call(this, dt, { ...input, steer: 0, brake: 0, handbrake: w < 0, throttle: w > 0 ? (kmh < w - 2 ? 1 : kmh < w ? 0.35 : 0) : 0 }, others);
    };
    window.__speeds = [];
    const nudge = car.nudge;
    car.nudge = function (v) { window.__speeds.push(Math.hypot(car.vx, car.vz) * 3.6); nudge.call(this, v); window.__speeds.push(Math.hypot(car.vx, car.vz) * 3.6); };
    const fallTo = briel.bikes.fallTo;
    window.__guesses = 0;
    briel.bikes.fallTo = function (k, to, ms, v, guess) { if (guess) window.__guesses++; return fallTo.call(this, k, to, ms, v, guess); };
    window.__put = (x, z) => car.place(x, briel.world.groundAt(x, z, 5, 0.3).y, z, -Math.PI / 2);
  })()`, false);
  await alice.evaluate('__put(-4, 14.5)', false);
  await alice.sleep(2000);
  await alice.evaluate(`__put(-12, ${STREET.z})`, false);
  await alice.sleep(2500);
  await alice.evaluate('window.__want = 40', false);
  await alice.waitFor(`briel.currentCar().x > ${STREET.x + 12}`, 20000);
  await bob.sleep(150);
  await shot(bob, 'bob-sees-it-fly');
  await alice.evaluate('window.__want = -1', false);
  await alice.sleep(2500);
  const [ka, kb] = [await bikeOn(alice), await bikeOn(bob)];
  const speeds = await alice.evaluate('window.__speeds');
  const guesses = await alice.evaluate('window.__guesses');
  console.log('Alice sees', JSON.stringify(ka), '; Bob sees', JSON.stringify(kb), '; Alice\'s car', JSON.stringify(speeds.map((v) => +v.toFixed(1))), 'km/h; page guesses', guesses);
  ok('the bike lies on both pages', ka.lie !== 0 && !ka.falling && kb.lie === ka.lie && !kb.falling);
  ok('in the same place on both pages', Math.hypot(ka.x - kb.x, ka.z - kb.z) < 0.02 && Math.abs(ka.yaw - kb.yaw) < 0.01, `${Math.hypot(ka.x - kb.x, ka.z - kb.z).toFixed(3)} m apart`);
  ok('thrown about 3 m', Math.hypot(ka.x - STREET.x, ka.z - STREET.z) > 2 && Math.hypot(ka.x - STREET.x, ka.z - STREET.z) < 3.8);
  ok('Alice\'s page guessed at once and the car drove on', guesses === 1 && speeds.length === 2 && speeds[1] > 35 && speeds[1] < speeds[0], JSON.stringify(speeds));
  await shot(bob, 'bob-sees-it-lie');

  // Bob walks up to the lying bike and gets on: it stands up, on Alice's page too.
  await bob.evaluate(`briel.player.place(${ka.x} + 1.2, ${ka.z}, briel.player.feet, 0, 0)`, false);
  ok('Bob gets on the lying bike', await until(bob, "briel.getOnBike('house')", "briel.bikes.mounted === 'house'"));
  await alice.sleep(1200);
  const [ra, rb] = [await bikeOn(alice), await bikeOn(bob)];
  ok('it stands up on both pages', ra.lie === 0 && rb.lie === 0 && Math.abs(ra.lean) < 0.3 && Math.abs(rb.lean) < 0.3 && /^bob/i.test(ra.rider ?? ''), `${JSON.stringify(ra)} ${JSON.stringify(rb)}`);

  // Alice drives into Bob on the bike at 30 km/h: the car stops at it, and Bob stays on.
  await alice.evaluate(`__put(${rb.x} - 30, ${rb.z})`, false);
  await alice.sleep(2500);
  await alice.evaluate('window.__speeds = []; window.__want = 30', false);
  await alice.sleep(5000);
  const stop = JSON.parse(await alice.evaluate('JSON.stringify({ x: briel.currentCar().x, kmh: Math.hypot(briel.currentCar().vx, briel.currentCar().vz) * 3.6, nudges: window.__speeds.length })'));
  const still = await bikeOn(bob);
  await alice.evaluate('window.__want = -1', false);
  ok('a ridden bike stops the car', stop.x < rb.x - 1 && stop.nudges === 0, JSON.stringify({ car: stop, bike: rb }));
  ok('and Bob is still on it, where he was', (await bob.evaluate("briel.bikes.mounted === 'house'")) && Math.hypot(still.x - rb.x, still.z - rb.z) < 0.3 && still.lie === 0, JSON.stringify(still));
  await shot(alice, 'alice-stopped-by-bob');
  for (const [who, b] of [['Alice', alice], ['Bob', bob]]) ok(`${who}: no errors on the page`, !b.logs.some((l) => /^(error|exception)/.test(l)), JSON.stringify(b.logs.filter((l) => /^(error|exception)/.test(l)).slice(-3)));
} finally {
  alice.close();
  bob.close();
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
