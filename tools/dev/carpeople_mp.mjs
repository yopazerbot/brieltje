// The people in the Teslas together (world/carPeople.ts), two players on a throwaway game server, through a dev server
// whose proxy points at it (API_PORT=<server port> npx vite --port <n>), in Action. Alice drives the Model Y and Bob
// rides along: each page shows its own figure in its seat and the other's figure in the other seat (its hit boxes
// hidden, its name over its seat, the passenger's a line higher). Then Bob gets out (Alice stays seated on both pages),
// in again, Alice out (Bob stays seated), both out (the car empty and its glass dark on both). Bob claims a seat the
// server didn't give him (a state saying he is in a car, a get-in out of reach): nobody sits in it on Alice's page.
// Then they drive to the Model 3, Alice takes it and pulls away past Bob on foot; a shot of Bob's at her seated figure
// ends on the car and is no hit. Pictures of both pages on the way.
//   node tools/dev/carpeople_mp.mjs --url http://localhost:5461/ --ports 9725,9726 [--out <folder>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5461/', ports: '9725,9726', out: '' });
localOnly(o.url, '--url'); // two players join and drive: a throwaway server on this computer only
const [pa, pb] = o.ports.split(',').map(Number);
if (o.out) mkdirSync(o.out, { recursive: true });
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};

/** A page that joins the game together under `name`, in Action (a gun in hand). */
async function player(port, name) {
  const b = await launch({ port, width: 1000, height: 560 });
  console.log(name, 'browser PID:', b.pid);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','low');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','action');" });
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
  // What this page has: its own figure and seat, the other player's figure and where it sits, a car's glass; and every
  // message it sends, for the checks.
  await b.evaluate(`(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let m = null;
      try { m = JSON.parse(data); } catch {}
      if (m) {
        window.__sent.push(m);
        if (window.__forge && m.t === 'state') { m.d = true; data = JSON.stringify(m); } // claims to be in a car
      }
      return send.call(this, data);
    };
    const car = (id) => briel.cars.find((c) => c.id === id);
    window.__V3 = briel.cars[0].group.position.constructor; // three's Vector3 (the dev hook doesn't give three itself)
    window.__glass = (id) => { let v = null; car(id).group.traverse((m) => { if (v !== null || !m.isMesh || m.userData.part !== 'GlassDark') return; for (let p = m; p; p = p.parent) if (p.name === 'Far') return; v = m.material.opacity; }); return v; };
    window.__see = (other, id) => {
      const c = car(id);
      const name = [...briel.avatars.avatars.keys()].find((k) => k.toLowerCase() === other.toLowerCase());
      const a = name && briel.avatars.avatars.get(name);
      const seat = name ? briel.carPeople.seat(name) : null;
      const at = a ? a.body.root.getWorldPosition(new __V3()) : null;
      const tag = a ? a.tag.getWorldPosition(new __V3()) : null;
      const pt = seat ? new __V3(seat.x, seat.y, seat.z) : null;
      return {
        own: !!briel.carPeople.own?.root.visible, ownSeat: briel.carPeople.ownIn?.seat ?? null, ownCar: briel.carPeople.ownIn?.car.id ?? null,
        driver: c.driver, passenger: c.passenger, glass: __glass(id), occupied: briel.carPeople.occupied.has(c),
        other: a ? { seat: seat ? seat.tagUp : null, gap: seat ? at.distanceTo(new __V3(seat.root.x, seat.root.y, seat.root.z)) : null, shown: a.root.visible && a.body.root.visible,
          hits: a.body.hits.some((h) => h.visible), tagOver: pt ? Math.hypot(tag.x - pt.x, tag.z - pt.z) : null, tagUp: tag.y - c.y, d: !!a.latest?.d } : null,
      };
    };
  })()`, false);
  return b;
}

const tag = Math.random().toString(36).slice(2, 6); // names stay with whoever joined with them for the day
const A = `Alice${tag}`;
const B = `Bob${tag}`;
const alice = await player(pa, A);
const bob = await player(pb, B);
const see = async (b, other, id = 'tesla') => JSON.parse(JSON.stringify(await b.evaluate(`__see('${other}', '${id}')`)));
const shot = async (name) => {
  if (!o.out) return;
  await alice.screenshot(join(o.out, `${name}_alice.png`));
  await bob.screenshot(join(o.out, `${name}_bob.png`));
};
/** In car `id` (the driver's seat first, else the passenger's), from beside its door; asked again until the server says so. */
const getIn = async (b, id, passenger) => {
  for (let i = 0; i < 30 && !(await b.evaluate(`briel.askState().${passenger ? 'riding' : 'driving'}`)); i++) {
    await b.evaluate(`(() => { const c = briel.cars.find((c) => c.id === '${id}'); const at = c.exitSpot(${passenger}); briel.player.place(at.x, at.z, c.y, 0, 0); setTimeout(() => briel.getIn(), 200); })()`, false);
    await b.sleep(1500);
  }
  return b.evaluate(`briel.askState().${passenger ? 'riding' : 'driving'}`);
};
const out = async (b) => {
  await b.evaluate('briel.getOut()', false);
  await b.sleep(1500);
};

try {
  ok('Alice drives the Model Y', await getIn(alice, 'tesla', false));
  ok('Bob rides along', await getIn(bob, 'tesla', true));
  await alice.sleep(2000);
  {
    const a = await see(alice, B);
    const b = await see(bob, A);
    console.log('  Alice sees', JSON.stringify(a), '\n  Bob sees', JSON.stringify(b));
    ok('Alice: her figure at the wheel', a.own && a.ownSeat === 0);
    ok('Alice: Bob in the passenger seat', a.other?.seat === 1 && a.other.shown && a.other.gap < 0.15 && !a.other.hits, `${a.other?.gap?.toFixed(3)} m from it`);
    ok('Bob: his figure in the passenger seat', b.own && b.ownSeat === 1);
    ok('Bob: Alice at the wheel', b.other?.seat === 0 && b.other.shown && b.other.gap < 0.15 && !b.other.hits, `${b.other?.gap?.toFixed(3)} m from it`);
    ok('each name over its seat, the passenger\'s higher', a.other.tagOver < 0.6 && b.other.tagOver < 0.6 && a.other.tagUp > b.other.tagUp + 0.15, `Bob's ${a.other.tagUp.toFixed(2)} m up, Alice's ${b.other.tagUp.toFixed(2)} m up`);
    ok('the lighter glass on both pages', a.glass === 0.82 && b.glass === 0.82);
    await shot('1_both_in');
  }

  await out(bob);
  {
    const a = await see(alice, B);
    const b = await see(bob, A);
    ok('Bob out: Alice still at the wheel on both pages', a.own && a.ownSeat === 0 && b.other?.seat === 0 && b.other.shown && !b.own, JSON.stringify({ a: a.own, b: b.other }));
    ok('Bob out: he stands beside the car on Alice\'s page', a.other?.seat === null && a.other.shown && !a.other.d && a.passenger === null);
    await shot('2_bob_out');
  }
  ok('Bob in again', await getIn(bob, 'tesla', true));
  await bob.sleep(1500);
  await out(alice);
  {
    const a = await see(alice, B);
    const b = await see(bob, A);
    ok('Alice out: Bob still in the passenger seat on both pages', b.own && b.ownSeat === 1 && a.other?.seat === 1 && a.other.shown && !a.own, JSON.stringify({ b: b.own, a: a.other }));
    ok('Alice out: nobody at the wheel', a.driver === null && b.driver === null && b.other?.seat === null);
    await shot('3_alice_out');
  }
  await bob.evaluate('briel.getOut()', false);
  await bob.sleep(1000);
  {
    const a = await see(alice, B);
    const b = await see(bob, A);
    ok('both out: the car empty, its glass dark on both pages within a second', !a.occupied && !b.occupied && a.glass === 0.96 && b.glass === 0.96 && !a.own && !b.own, JSON.stringify({ a: [a.occupied, a.glass], b: [b.occupied, b.glass] }));
  }

  // Bob claims a seat the server never gave him: his states say he is in a car, and he asks to get in from 12 m off.
  await bob.evaluate(`(() => { const c = briel.cars.find((c) => c.id === 'tesla'); briel.player.place(c.x + 12, c.z, c.y, 0, 0); window.__forge = true; })()`, false);
  await bob.sleep(4500); // the server lets him move no faster than a run: there by now
  await bob.evaluate('briel.getIn()', false);
  await bob.sleep(2500);
  {
    const a = await see(alice, B);
    ok('a forged seat shows nobody in the car on Alice\'s page', a.driver === null && a.passenger === null && !a.occupied && a.other?.seat === null && !a.other.d && a.glass === 0.96, JSON.stringify(a));
    await bob.evaluate('window.__forge = false', false);
    await shot('4_forged');
  }

  // To the Model 3 together in the Model Y (moved in hops the server allows), then Alice takes the Model 3.
  ok('Alice drives the Model Y again', await getIn(alice, 'tesla', false));
  ok('Bob rides along again', await getIn(bob, 'tesla', true));
  const m3 = await alice.evaluate("(() => { const c = briel.cars.find((c) => c.id === 'model3'); return { x: c.x, z: c.z, yaw: c.yaw }; })()");
  const hold = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  await alice.evaluate(`(() => {
    const car = briel.currentCar(), drive = car.drive;
    window.__drive = null;
    car.drive = function (dt, input, others) { return drive.call(this, dt, window.__drive ? { ...input, ...window.__drive } : input, others); };
    window.__drive = ${JSON.stringify(hold)};
  })()`, false);
  // 8 m behind the Model 3, facing its way.
  const [tx, tz] = [m3.x + Math.sin(m3.yaw) * 8, m3.z + Math.cos(m3.yaw) * 8];
  for (let i = 0; i < 40; i++) {
    const p = await alice.evaluate('({ x: briel.currentCar().x, z: briel.currentCar().z })');
    const d = Math.hypot(tx - p.x, tz - p.z);
    const k = Math.min(1, 15 / Math.max(d, 1e-6));
    await alice.evaluate(`(() => { const car = briel.currentCar(), x = ${p.x + (tx - p.x) * k}, z = ${p.z + (tz - p.z) * k}; car.place(x, briel.world.groundAt(x, z, car.y + 3, 0.3).y, z, ${m3.yaw}); })()`, false);
    await alice.sleep(1200);
    if (k === 1) break;
  }
  await out(bob);
  await out(alice);
  ok('Alice drives the Model 3', await getIn(alice, 'model3', false));
  // Bob on foot beside where it will pass: 3 m to its right and 5 m ahead, looking at it.
  await bob.evaluate(`(() => { const c = briel.cars.find((c) => c.id === 'model3'), fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw); const x = c.x + fx * 5 - fz * 3, z = c.z + fz * 5 + fx * 3; briel.player.place(x, z, briel.world.groundAt(x, z, c.y + 2, 0.3).y, Math.atan2(-(c.x - x), -(c.z - z)), -0.12); })()`, false);
  await bob.sleep(2500);
  {
    const b = await see(bob, A, 'model3');
    ok('Bob on foot: Alice at the wheel of the Model 3', b.other?.seat === 0 && b.other.shown && b.other.gap < 0.15, JSON.stringify(b.other));
  }
  // His shot at her seated figure, from the pavement: it ends on the car, and no hit is sent.
  await bob.evaluate(`(() => {
    const name = [...briel.avatars.avatars.keys()].find((k) => k.toLowerCase() === '${A}'.toLowerCase());
    const head = briel.avatars.avatars.get(name).body.root.getObjectByName('Head').getWorldPosition(new __V3());
    const p = briel.player, eye = { x: p.x, y: p.feet + 1.6, z: p.z };
    const dx = head.x - eye.x, dy = head.y - eye.y, dz = head.z - eye.z;
    briel.teleport(p.x, p.z, p.feet, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    briel.weapon.setEnabled(true);
  })()`, false);
  await bob.sleep(400);
  const aimed = JSON.parse(JSON.stringify(await bob.evaluate(`(() => {
    const cam = briel.three.composer.passes.find((q) => q.camera && q.camera.isPerspectiveCamera).camera;
    const ray = new briel.effects.ray.constructor(); // three's Raycaster
    ray.setFromCamera({ x: 0, y: 0 }, cam);
    const drawn = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const hit = ray.intersectObjects(briel.three.scene.children, true).find((h) => drawn(h.object) && !h.object.userData.ignoreRay);
    window.__sent.length = 0;
    briel.fire();
    return { part: hit?.object.userData.part ?? null, vehicle: !!hit?.object.userData.vehicle, player: hit?.object.userData.player ?? null, dist: hit?.distance };
  })()`)));
  await bob.sleep(800);
  const sent = await bob.evaluate("window.__sent.filter((m) => m.t === 'shot' || m.t === 'hit').map((m) => m.t)");
  ok('a shot at the seated driver ends on the car', aimed.vehicle && !aimed.player, JSON.stringify(aimed));
  ok('and no hit is sent', sent.includes('shot') && !sent.includes('hit'), JSON.stringify(sent));
  // She pulls away past him, the wheel a little to the left.
  await alice.evaluate(`(() => {
    const car = briel.currentCar(), drive = car.drive;
    window.__drive = { throttle: 0.35, brake: 0, steer: 0.5, handbrake: false };
    car.drive = function (dt, input, others) { return drive.call(this, dt, window.__drive ? { ...input, ...window.__drive } : input, others); };
  })()`, false);
  await alice.sleep(1300);
  await shot('5_model3_drives_past');
  await alice.evaluate(`window.__drive = ${JSON.stringify(hold)}`, false);
  await alice.sleep(1500);
  await out(alice);

  for (const [who, b] of [['Alice', alice], ['Bob', bob]]) ok(`${who}: no errors on the page`, !b.logs.some((l) => /^(error|exception)/.test(l)), JSON.stringify(b.logs.filter((l) => /^(error|exception)/.test(l)).slice(-3)));
} finally {
  alice.close();
  bob.close();
}
process.exitCode = failed ? 1 : 0;
