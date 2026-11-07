// Check the bikes you can ride (web/src/world/bike.ts) in a fresh browser, on a running dev server: getting on with
// E by the main house, riding out of the side passage, the bell, braking, getting off; 25 km/h on the flat, leaning into
// a turn; with --village also the racks by the portals, up and down Molenhoek's street and along its cycle lane.
//
//   node tools/dev/bike.mjs --url http://localhost:5510/ --port 9613 [--village] [--quality low] [--phone] [--swiftshader] [--out dir]
//
// The physics checks run the bike's own code frame by frame inside one evaluate (so the game's loop can't step in between);
// the rides through the passage and along the lane are played with real key presses.
import assert from 'node:assert/strict';
import { PORTALS } from '../../web/shared/portals.mjs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5510/', port: '9613', village: false, quality: 'low', phone: false, swiftshader: false, out: '' });
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
  assert.deepEqual(b.logs.filter((l) => /^(error|exception)/.test(l)), []);
  console.log(JSON.stringify(report));
} finally {
  console.log('Browser errors:', b.logs.filter((l) => /^(error|exception)/.test(l)).slice(-10));
  b.close();
}
