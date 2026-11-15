// Check the bikes you can ride (web/src/world/bike.ts) in a fresh browser, on a running dev server: getting on with
// E by the main house, riding out of the side passage, the bell, braking, getting off; 25 km/h on the flat, leaning into
// a turn; with --village also the racks by the portals, up and down Molenhoek's street and along its cycle lane.
// With --knock (shared/bikeKnock.mjs) also, alone: the Tesla driven into a bike standing across a straight road at 8, 40 and
// 100 km/h (the car's speed just before and after, the bike's path, where it lies and on which side), the same hit played
// twice frame by frame (the same place), getting on the lying bike (it stands up), the way back to its spot after the
// return time (shortened), and a bike knocked on a slope; with --out pictures of a slow tip and a fast throw.
//
//   node tools/dev/bike.mjs --url http://localhost:5510/ --port 9613 [--village] [--knock] [--quality low] [--phone] [--swiftshader] [--out dir]
//
// The physics checks run the bike's own code frame by frame inside one evaluate (so the game's loop can't step in between);
// the rides through the passage and along the lane are played with real key presses.
import assert from 'node:assert/strict';
import { PORTALS } from '../../web/shared/portals.mjs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5510/', port: '9613', village: false, knock: false, quality: 'low', phone: false, swiftshader: false, out: '' });
const b = await launch({ port: Number(o.port), swiftshader: o.swiftshader });
const slow = o.swiftshader ? 8 : 1; // software drawing: a few frames a second, and the game's time runs slower with them
const shot = async (name) => o.out && b.screenshot(`${o.out}/${name}.png`);
const key = (code, type) => b.send('Input.dispatchKeyEvent', { type, code, key: code === 'Space' ? ' ' : code.slice(3).toLowerCase(), windowsVirtualKeyCode: code === 'Space' ? 32 : code.charCodeAt(3) });
const tap = async (code) => {
  await key(code, 'keyDown');
  await b.sleep(120);
  await key(code, 'keyUp');
};
const ridden = () => b.evaluate('JSON.stringify(briel.bikes.ridden)').then((s) => JSON.parse(s));
const report = {};
const json = (expr) => b.evaluate(`JSON.stringify(${expr})`).then((s) => JSON.parse(s));

/**
 * A car knocks a bike (--knock), alone. The straight road out in the fields (as tools/dev/drive.mjs): the Tesla put at
 * its start, the house's bike standing across it 150 m on; the car's pedals the script's (held at a speed), real frames.
 */
async function knocks() {
  const out = {};
  const road = { x: 636.6, z: 142.6, dx: (668.9 - 636.6) / 215.6, dz: (355.8 - 142.6) / 215.6 };
  await b.evaluate("briel.getOffBike?.(false); briel.getIn()", false);
  await b.waitFor('briel.driving()');
  await b.evaluate(`(() => {
    const car = briel.currentCar(), B = briel.bikes, k = B.bikes.find((k) => k.id === 'house');
    const drive = car.drive;
    window.__want = null; // km/h to hold, or null: the player's own pedals
    car.drive = function (dt, input, others) {
      const kmh = Math.hypot(car.vx, car.vz) * 3.6;
      const mine = window.__want === null ? input : { ...input, steer: 0, handbrake: false, brake: window.__want === 0 && kmh > 0.5 ? 1 : 0,
        throttle: window.__want > 0 ? (kmh < window.__want - 2 ? 1 : kmh < window.__want ? 0.35 : 0) : 0 };
      return drive.call(this, dt, mine, others);
    };
    const nudge = car.nudge;
    window.__nudges = [];
    car.nudge = function (v) {
      const before = Math.hypot(car.vx, car.vz) * 3.6;
      nudge.call(this, v);
      window.__nudges.push({ before: +before.toFixed(2), after: +(Math.hypot(car.vx, car.vz) * 3.6).toFixed(2) });
    };
    /** The car at the road's start, the bike standing across the road \`ahead\` m on. */
    window.__set = (ahead = 150) => {
      const r = ${JSON.stringify(road)};
      const g = briel.world.groundAt(r.x, r.z, 50, 0.3);
      car.place(r.x, g.y, r.z, Math.atan2(-r.dx, -r.dz));
      const bx = r.x + r.dx * ahead, bz = r.z + r.dz * ahead;
      Object.assign(k, { x: bx, z: bz, y: briel.world.groundAt(bx, bz, 50, 0.3).y, yaw: Math.atan2(-r.dx, -r.dz) + Math.PI / 2, lie: 0, fall: null, guess: 0, speed: 0, fresh: true, knockedAt: -Infinity });
      k.track.clear();
      window.__nudges = [];
      return { x: bx, z: bz, y: k.y };
    };
    window.__bike = () => ({ x: +k.x.toFixed(3), y: +k.y.toFixed(3), z: +k.z.toFixed(3), yaw: +k.yaw.toFixed(3), lie: k.lie, lean: +k.lean.toFixed(3), falling: !!k.fall, hop: +k.hop.toFixed(3) });
  })()`, false);
  const hit = async (kmh, name) => {
    const at = await json(`__set(${kmh < 20 ? 12 : kmh < 60 ? 60 : 150})`);
    await b.evaluate(`window.__want = ${kmh}`, false);
    await b.waitFor('briel.bikes.bikes.find((k) => k.id === "house").fall || briel.bikes.bikes.find((k) => k.id === "house").lie', 60000 * slow);
    // The path, every tenth of a second, until it lies still.
    const path = [];
    for (let i = 0; i < 40; i++) {
      const p = await json('__bike()');
      path.push(p);
      if (!p.falling && p.lie) break;
      await b.sleep(100);
    }
    await b.evaluate('window.__want = 0', false);
    const rest = await json('__bike()');
    const nudges = await json('__nudges');
    const r = { kmh, nudge: nudges[0], from: at, rest, dist: +Math.hypot(rest.x - at.x, rest.z - at.z).toFixed(2), path: path.map((p) => [+(p.x - at.x).toFixed(2), +(p.z - at.z).toFixed(2), p.hop, p.lean]) };
    assert.ok(rest.lie === 1 || rest.lie === -1, `${kmh} km/h: lies on a side ${JSON.stringify(r)}`);
    assert.equal(nudges.length, 1, `${kmh} km/h: one knock`);
    assert.ok(r.nudge.after < r.nudge.before && r.nudge.after > r.nudge.before * 0.95 - 1.2, `${kmh} km/h: a little slower ${JSON.stringify(r.nudge)}`);
    assert.ok(r.dist <= 8.01 && (kmh < 10 ? r.dist <= 0.45 : r.dist > 2), `${kmh} km/h: ${r.dist} m`);
    await b.waitFor('Math.hypot(briel.currentCar().vx, briel.currentCar().vz) < 0.3', 30000 * slow);
    if (o.out && name) {
      // Out of the car, the car put 25 m back up the road, looking at the bike from 3.5 m.
      await b.evaluate('window.__want = null; briel.getOut()', false);
      await b.sleep(300);
      await b.evaluate(`(() => { const r = ${JSON.stringify(road)}, car = briel.currentCar(), x = car.x - r.dx * 25, z = car.z - r.dz * 25;
        car.place(x, briel.world.groundAt(x, z, 50, 0.3).y, z, car.yaw); })()`, false);
      await b.evaluate(`(() => { const k = ${JSON.stringify(rest)}; const a = 2.2; const x = k.x + Math.sin(a) * 3.5, z = k.z + Math.cos(a) * 3.5;
        briel.teleport(x, z, briel.world.groundAt(x, z, k.y + 2, 0.5).y, a, -0.35); })()`, false);
      await b.sleep(1200);
      await shot(name);
      await b.evaluate('briel.getIn()', false);
      await b.waitFor('briel.driving()');
    }
    return r;
  };
  out.slow = await hit(8, 'knock_tip');
  out.mid = await hit(40, 'knock_40');
  out.fast = await hit(100, 'knock_throw');
  // The same hit twice, frame by frame at 60 a second inside one evaluate (no frame times of the browser's): the same place.
  out.twice = await json(`(() => {
    const B = briel.bikes, k = B.bikes.find((k) => k.id === 'house'), car = briel.currentCar();
    const once = () => {
      const at = __set();
      const yaw = car.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const c = { id: car.id, spec: car.spec, y: at.y, yaw, x: at.x - fx * 8, z: at.z - fz * 8 + 0.3 };
      B.lastCar = null;
      for (let i = 0; i < 200 && !(k.lie && !k.fall); i++) {
        c.x += fx * (60 / 3.6) / 60;
        c.z += fz * (60 / 3.6) / 60;
        B.struck(c, 1 / 60, () => false);
        B.update(1 / 60, { x: c.x, y: 0, z: c.z, distanceTo: () => 1 });
      }
      return { x: k.x, z: k.z, yaw: k.yaw, lie: k.lie };
    };
    const a = once(), b2 = once();
    return { a, b: b2, same: a.x === b2.x && a.z === b2.z && a.yaw === b2.yaw && a.lie === b2.lie };
  })()`);
  assert.ok(out.twice.same && out.twice.a.lie, `the same hit, the same place: ${JSON.stringify(out.twice)}`);
  // Out of the car, up to the lying bike: the prompt, on (Use), and it stands; off again, it stays.
  await b.evaluate('briel.getOut()', false);
  await b.sleep(300);
  const lying = await json('__bike()');
  await b.evaluate(`briel.teleport(${lying.x} + 1.1, ${lying.z}, ${lying.y}, 0, -0.3)`, false);
  await b.sleep(400);
  await b.waitFor("/Ride the bike/.test(document.getElementById('prompt').textContent)", 10000);
  if (o.phone) await b.evaluate("document.querySelector('#touch .t-use').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))", false);
  else await tap('KeyE');
  await b.waitFor("briel.bikes.mounted === 'house'");
  await b.sleep(1000);
  out.mounted = await json('__bike()');
  assert.ok(out.mounted.lie === 0 && Math.abs(out.mounted.lean) < 0.3, `on it, it stands: ${JSON.stringify(out.mounted)}`);
  await tap('KeyE');
  await b.waitFor('briel.bikes.mounted === null');
  // Knocked again and left lying: after the return time (shortened to 3 s here) it is back on its spot.
  await b.evaluate('briel.bikes.homeMs = 3000; briel.getIn()', false);
  await b.waitFor('briel.driving()');
  const again = await hit(40, '');
  await b.sleep(3600);
  out.home = await json('__bike()');
  out.homeAfter = again.dist;
  assert.ok(Math.abs(out.home.x - -0.5) < 0.01 && Math.abs(out.home.z - 6.2) < 0.01 && out.home.lie === 0, `back on its spot: ${JSON.stringify(out.home)}`);
  // On a slope: the steepest bare ground (no block on it, under 1 in 2) round the fields' road; knocked frame by frame, then
  // where it lies against the ground (nothing floats or sinks; the picture shows the rest).
  out.slope = await json(`(() => {
    const B = briel.bikes, k = B.bikes.find((k) => k.id === 'house'), w = briel.world;
    B.homeMs = 3e9;
    let best = null;
    const bare = (x, z) => { const g = w.groundAt(x, z, 50, 0.3); return g.name === 'Garden' ? g.y : NaN; };
    for (let x = 400; x < 800; x += 5) for (let z = -100; z < 400; z += 5) {
      const s = Math.hypot(bare(x + 1.5, z) - bare(x - 1.5, z), bare(x, z + 1.5) - bare(x, z - 1.5)) / 3;
      if (s < 0.5 && (!best || s > best.s)) best = { x, z, s };
    }
    Object.assign(k, { x: best.x, z: best.z, y: w.groundAt(best.x, best.z, 50, 0.3).y, yaw: 0.4, lie: 0, fall: null, fresh: true, knockedAt: -Infinity });
    const c = { id: 'tesla', spec: briel.currentCar().spec, y: k.y, yaw: 0, x: best.x, z: best.z + 5 };
    B.lastCar = null;
    for (let i = 0; i < 200 && !(k.lie && !k.fall); i++) {
      c.z -= 30 / 3.6 / 60;
      B.struck(c, 1 / 60, () => false);
      B.update(1 / 60, { x: k.x, y: 0, z: k.z, distanceTo: () => 1 });
    }
    for (let i = 0; i < 60; i++) B.update(1 / 60, { x: k.x, y: 0, z: k.z, distanceTo: () => 1 });
    return { at: best, bike: { x: k.x, y: k.y, z: k.z, lie: k.lie, lean: k.lean, pitch: k.pitch }, ground: w.groundAt(k.x, k.z, k.y + 0.3, 0.3).y };
  })()`);
  assert.ok(Math.abs(out.slope.bike.y - out.slope.ground) < 0.02, `on the ground on a slope: ${JSON.stringify(out.slope)}`);
  if (o.out) {
    const s = out.slope.bike;
    await b.evaluate('window.__want = null; briel.getOut()', false);
    await b.sleep(300);
    await b.evaluate(`(() => { const a = 2.2; const x = ${s.x} + Math.sin(a) * 3.5, z = ${s.z} + Math.cos(a) * 3.5; briel.teleport(x, z, briel.world.groundAt(x, z, ${s.y} + 2, 0.5).y, a, -0.35); })()`, false);
    await b.sleep(1200);
    await shot('knock_slope');
  }
  return out;
}
try {
  console.log('Browser PID:', b.pid);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics',${JSON.stringify(o.quality)});localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');` });
  await startGame(b, o.url + '?nobake&webp', { phone: o.phone, village: o.village });
  await b.waitFor('!!briel.bikes.rig');
  await b.evaluate("document.getElementById('cc-close')?.click()", false);

  // By the main house: the prompt, then on with E (or the touch Use button).
  await b.evaluate('briel.teleport(-1.6, 7.6, -0.05, -0.6, -0.2)', false);
  await b.sleep(400);
  assert.equal(await b.evaluate("briel.bikes.nearest(briel.player.x, briel.player.z, briel.player.feet)?.id"), 'house');
  await b.waitFor("/Ride the bike/.test(document.getElementById('prompt').textContent)");
  await shot('bike_house');
  if (o.phone) await b.evaluate("document.querySelector('#touch .t-use').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))", false);
  else await tap('KeyE');
  await b.waitFor("briel.bikes.mounted === 'house'");
  await b.waitFor("!document.getElementById('speedometer').hidden");
  if (o.phone) {
    assert.equal(await b.evaluate("document.querySelector('#touch .t-jump').textContent"), 'Bell');
    assert.equal(await b.evaluate('document.body.dataset.touch'), 'car', 'laid out as in the car');
  }
  await b.sleep(600);
  await shot('bike_on');

  // Out of the side passage towards the street: turned round, pedalled with W.
  await b.evaluate("(() => { const k = briel.bikes.bikes.find((k) => k.id === 'house'); k.yaw = Math.PI; briel.bikes.camHeading = Math.PI; })()", false);
  await key('KeyW', 'keyDown');
  await b.waitFor('briel.bikes.ridden.z > 13', 30000 * slow);
  await key('KeyW', 'keyUp');
  report.passage = await ridden();
  assert.ok(Math.abs(report.passage.x + 0.5) < 0.6, `kept to the passage: ${JSON.stringify(report.passage)}`);
  await tap('Space'); // the bell
  await key('KeyS', 'keyDown');
  await b.waitFor('briel.bikes.ridden?.speed < 0.2', 20000 * slow).catch(async (e) => {
    console.log('braking:', await b.evaluate("JSON.stringify({ m: briel.bikes.mounted, r: briel.bikes.ridden, p: document.getElementById('prompt').textContent })"));
    throw e;
  });
  await key('KeyS', 'keyUp');
  await tap('KeyE');
  await b.waitFor('briel.bikes.mounted === null');
  const off = JSON.parse(await b.evaluate("JSON.stringify((() => { const k = briel.bikes.bikes.find((k) => k.id === 'house'); return { x: briel.player.x, z: briel.player.z, bx: k.x, bz: k.z, rider: k.rider }; })())"));
  assert.equal(off.rider, null);
  assert.ok(Math.hypot(off.x - off.bx, off.z - off.bz) < 2, `off beside it: ${JSON.stringify(off)}`);
  report.off = off;

  // The physics, frame by frame at 60 a second, on the flat lane in front of the house (each frame back at the
  // start, so it never runs into anything): pedalling reaches 25 km/h and holds it; steering right leans it right.
  report.flat = JSON.parse(await b.evaluate(`JSON.stringify((() => {
    briel.getOnBike('house');
    const B = briel.bikes, k = B.bikes.find((k) => k.id === 'house');
    const at = { x: 6, z: 22.5 };
    const y = briel.world.groundAt(at.x, at.z, 2, 0.3).y;
    Object.assign(k, { x: at.x, z: at.z, y, yaw: Math.PI / 2, speed: 0, fresh: true });
    const speeds = [];
    for (let i = 0; i < 900; i++) {
      B.ride(1 / 60, { throttle: 1, brake: 0, steer: 0 }, []);
      Object.assign(k, { x: at.x, z: at.z, yaw: Math.PI / 2 });
      if (i % 60 === 59) speeds.push(+(k.speed * 3.6).toFixed(1));
    }
    let lean = 0;
    const yaw0 = k.yaw;
    for (let i = 0; i < 90; i++) {
      B.ride(1 / 60, { throttle: 1, brake: 0, steer: 1 }, []);
      B.update(1 / 60, { x: at.x, y: 0, z: at.z, distanceTo: () => 1 });
      Object.assign(k, { x: at.x, z: at.z });
      lean = k.lean;
    }
    const turned = k.yaw - yaw0;
    // The brake: frames until it stands; held on, it is walked back, slowly.
    let stopFrames = 0;
    while (k.speed > 0.01 && stopFrames < 600) {
      B.ride(1 / 60, { throttle: 0, brake: 1, steer: 0 }, []);
      Object.assign(k, { x: at.x, z: at.z });
      stopFrames++;
    }
    for (let i = 0; i < 120; i++) B.ride(1 / 60, { throttle: 0, brake: 1, steer: 0 }, []);
    const back = k.speed;
    briel.getOffBike(false);
    return { speeds, lean: +lean.toFixed(3), turned: +turned.toFixed(3), stopSeconds: +(stopFrames / 60).toFixed(2), back: +back.toFixed(2) };
  })())`));
  const top = report.flat.speeds.at(-1);
  assert.ok(top > 24 && top < 26, `25 km/h on the flat: ${report.flat.speeds}`);
  assert.ok(report.flat.speeds[5] > 22.5, `about six seconds to get there: ${report.flat.speeds}`);
  assert.ok(report.flat.turned < -0.5 && report.flat.lean > 0.15, `steering right turns and leans right: ${JSON.stringify(report.flat)}`);
  assert.ok(report.flat.stopSeconds < 2.5, `the brake stops it: ${JSON.stringify(report.flat)}`);
  assert.ok(report.flat.back < 0 && report.flat.back >= -1.01, `held on, it is walked back slowly: ${JSON.stringify(report.flat)}`);

  if (o.village) {
    // Where every bike stands to begin with (shared/bike.json): in the game, on the ground, clear of walls and
    // of the portals' pads (the house bike was ridden off above: its spot is checked, not where it is now).
    report.racks = JSON.parse(await b.evaluate(`JSON.stringify(briel.bikes.bikes.map((k) => ({ id: k.id, ready: k.ready,
      x: k.park.x, z: k.park.z, dy: +(briel.world.groundAt(k.park.x, k.park.z, k.park.y + 0.5, 0.3).y - k.park.y).toFixed(2),
      free: briel.world.boxFree(k.park.x, k.park.z, k.park.yaw, 0.9, 0.3, k.park.y + 0.3, k.park.y + 1.2, k.key) })))`));
    for (const r of report.racks) {
      r.pad = +Math.min(...PORTALS.map((p) => Math.hypot(p.x - r.x, p.z - r.z))).toFixed(1);
      assert.ok(r.ready, `${r.id} in the game`);
      assert.ok(Math.abs(r.dy) < 0.12, `${r.id} on the ground: ${r.dy}`);
      assert.ok(r.free, `${r.id} clear of walls`);
      assert.ok(r.pad > 3, `${r.id} off the portal's pad: ${r.pad} m`);
    }
    // Up and down Molenhoek's street: the steepest stretch of its carriageway near the portal, ridden both ways.
    report.hill = JSON.parse(await b.evaluate(`JSON.stringify((() => {
      const w = briel.world, B = briel.bikes;
      let best = null;
      for (let x = 700; x < 880; x += 2) {
        const a = w.groundAt(x - 0.56, -721, 30, 0), c = w.groundAt(x + 0.56, -721, 30, 0);
        if (a.mat !== 'road' || c.mat !== 'road') continue;
        const s = (c.y - a.y) / 1.12;
        if (!best || Math.abs(s) > Math.abs(best.s)) best = { x, s };
      }
      const ride = (yaw) => {
        briel.getOnBike('molenhoek1');
        const k = B.bikes.find((k) => k.id === 'molenhoek1');
        const park = { ...k.park };
        Object.assign(k, { x: best.x, z: -721, y: w.groundAt(best.x, -721, 30, 0.3).y, yaw, speed: 0, fresh: true });
        for (let i = 0; i < 900; i++) {
          B.ride(1 / 60, { throttle: 1, brake: 0, steer: 0 }, []);
          Object.assign(k, { x: best.x, z: -721, yaw });
        }
        const v = k.speed * 3.6;
        Object.assign(k, park, { speed: 0, fresh: true });
        briel.getOffBike(false);
        return +v.toFixed(1);
      };
      // yaw -pi/2 rides towards +x
      const east = ride(-Math.PI / 2), west = ride(Math.PI / 2);
      return { x: best.x, slope: +best.s.toFixed(4), up: best.s > 0 ? east : west, down: best.s > 0 ? west : east };
    })())`));
    assert.ok(Math.abs(report.hill.slope) > 0.005, `a slope to ride: ${JSON.stringify(report.hill)}`);
    assert.ok(report.hill.up < 24.5 && report.hill.down > 25.5, `slower uphill, faster downhill: ${JSON.stringify(report.hill)}`);

    // Along the raised red cycle lane on the north side of Molenhoek's street, with real key presses: the lane's
    // inner edge (where the asphalt meets the lane's block) found every 5 m, a straight line through it, the bike set
    // 0.8 m out from it facing along it, and pedalled 25 m. Up the lane's kerb and along it, nothing stops it.
    const lane = JSON.parse(await b.evaluate(`JSON.stringify((() => {
      const w = briel.world, pts = [];
      for (let x = 735; x <= 775; x += 5) {
        for (let z = -722; z < -712; z += 0.05) {
          if (w.groundAt(x, z, 30, 0).mat === 'road' && w.groundAt(x, z + 0.05, 30, 0).mat === 'pave_light') { pts.push([x, z + 0.05]); break; }
        }
      }
      const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, mz = pts.reduce((s, p) => s + p[1], 0) / n;
      const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - mz), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
      return { n, a: mz - slope * mx, b: slope };
    })())`));
    assert.ok(lane.n >= 7, `the lane's edge found: ${JSON.stringify(lane)}`);
    const off = (x, z) => (z - (lane.a + lane.b * x)) / Math.hypot(1, lane.b); // m out from the edge, onto the lane
    await b.evaluate(`(() => {
      const x = 738, z = ${lane.a} + ${lane.b} * 738 + 0.8 * Math.hypot(1, ${lane.b});
      const yaw = Math.atan2(-1, -${lane.b});
      briel.teleport(x, z + 0.8, briel.world.groundAt(x, z + 0.8, 30, 0.3).y, yaw, 0);
      briel.getOnBike('molenhoek1');
      const k = briel.bikes.bikes.find((k) => k.id === 'molenhoek1');
      Object.assign(k, { x, z, y: briel.world.groundAt(x, z, 30, 0.3).y, yaw, speed: 0, fresh: true });
      briel.bikes.camHeading = yaw;
    })()`, false);
    await key('KeyW', 'keyDown');
    await b.waitFor('briel.bikes.ridden.x > 763', 40000 * slow);
    await shot('bike_lane');
    await key('KeyW', 'keyUp');
    report.lane = await ridden();
    report.lane.out = +off(report.lane.x, report.lane.z).toFixed(2);
    report.lane.ground = await b.evaluate(`briel.world.groundAt(${report.lane.x}, ${report.lane.z}, ${report.lane.y} + 0.3, 0.3).mat`);
    assert.ok(report.lane.out > 0.4 && report.lane.out < 1.3 && report.lane.ground === 'pave_light', `stayed on the lane: ${JSON.stringify(report.lane)}`);
    await tap('KeyE');
    await b.waitFor('briel.bikes.mounted === null');
    // The church rack from the portal.
    await b.evaluate('briel.teleport(536.3, -771.6, 4.72, 2.0, -0.18)', false);
    await b.sleep(1500);
    await shot('bike_church_rack');
  }
  if (o.knock) report.knock = await knocks();
  assert.deepEqual(b.logs.filter((l) => /^(error|exception)/.test(l)), []);
  console.log(JSON.stringify(report));
} finally {
  console.log('Browser errors:', b.logs.filter((l) => /^(error|exception)/.test(l)).slice(-10));
  b.close();
}
