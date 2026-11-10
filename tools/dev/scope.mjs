// The scope's picture, the crosshair and the recoil, headless (tools/dev/cdp.mjs):
//
//   node tools/dev/scope.mjs <out-folder> [--url http://localhost:5200/] [--phone] [--quality low] [--swiftshader] [--port 9344]
//
// Starts Zombies alone (guns in hand), then saves pictures: the rifle from the hip, the rifle after a
// burst (the crosshair opened up), the sniper rifle from the hip, through its scope, through it while
// turning (the dark edge creeps in) and through it holding your breath. Prints what the recoil did:
// the view's climb over a held burst, how much of it came back, and how far the reticle drifts with
// and without holding your breath. Exits 1 when a number is off.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', phone: false, quality: '', swiftshader: false, port: '9344' });
const out = o._[0];
if (!out) throw new Error('usage: node tools/dev/scope.mjs <out-folder> [options]');
mkdirSync(out, { recursive: true });
const b = await launch({ port: Number(o.port), width: o.phone ? 844 : 1600, height: o.phone ? 390 : 900, swiftshader: o.swiftshader });
let bad = 0;
const check = (ok, text) => {
  console.log(ok ? 'ok  ' : 'BAD ', text);
  if (!ok) bad++;
};
try {
  await startGame(b, o.url, { phone: o.phone });
  if (o.quality) await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)})`, false);
  await b.evaluate(`briel.zombiesSolo.start('house')`, false);
  await b.waitFor('briel.weapon.enabled', 90000);
  // Aiming and holding your breath by hand: the page's own update, with our say over the two inputs.
  await b.evaluate(`(() => {
    const w = briel.weapon;
    const update = w.update.bind(w);
    window.scopeTest = { aim: false, steady: false };
    w.update = (dt, moving, aiming, look) => update(dt, moving, window.scopeTest.aim, look && { ...look, steady: window.scopeTest.steady });
    for (const id of ['pistol', 'rifle', 'shotgun', 'sniper', 'bazooka']) w.give(id);
  })()`, false);
  const shot = (name) => b.screenshot(join(out, `${name}.png`));
  const look = (yaw, pitch) => b.evaluate(`briel.teleport(briel.player.x, briel.player.z, briel.player.feet, ${yaw}, ${pitch})`, false);

  // The rifle from the hip, then after a held burst.
  await b.evaluate(`briel.weapon.select('rifle')`, false);
  await look(0.6, 0);
  await b.sleep(1500);
  await shot('rifle-hip');
  const before = await b.evaluate('briel.player.pitch', false);
  const gapBefore = await b.evaluate(`getComputedStyle(document.getElementById('crosshair')).getPropertyValue('--gap')`, false);
  for (let i = 0; i < 12; i++) {
    await b.evaluate('briel.fire()', false);
    await b.sleep(100);
  }
  const peak = await b.evaluate('briel.player.pitch', false);
  const gapAfter = await b.evaluate(`getComputedStyle(document.getElementById('crosshair')).getPropertyValue('--gap')`, false);
  await shot('rifle-burst');
  await b.sleep(1500);
  const rest = await b.evaluate('briel.player.pitch', false);
  const climb = peak - before;
  const back = peak - rest;
  console.log(`rifle, 12 shots held: the view climbed ${(climb * 57.3).toFixed(2)} deg, ${(back * 57.3).toFixed(2)} deg came back; crosshair ${gapBefore} to ${gapAfter}`);
  check(climb > 0.03 && climb < 0.2, 'the burst climbs, and not out of hand');
  check(back > climb * 0.25 && back < climb * 0.7, 'about half of the climb comes back');
  check(parseFloat(gapAfter) > parseFloat(gapBefore), 'the crosshair opens up while firing');

  // The sniper rifle: from the hip, through the scope, turning, holding your breath.
  await b.evaluate(`briel.weapon.select('sniper')`, false);
  await look(0.6, 0);
  await b.sleep(1200);
  await shot('sniper-hip');
  await b.evaluate('window.scopeTest.aim = true', false);
  await b.sleep(1500);
  check(await b.evaluate('briel.weapon.scoped', false), 'aiming looks through the scope');
  await shot('scope');
  const drift = async (ms) => {
    let far = 0;
    for (let t = 0; t < ms; t += 100) {
      const v = await b.evaluate('briel.weapon.scopeView', false);
      far = Math.max(far, Math.hypot(v.x, v.y));
      await b.sleep(100);
    }
    return far;
  };
  const loose = await drift(4000);
  await b.evaluate('window.scopeTest.steady = true', false);
  await b.sleep(1200);
  const held = await drift(1500);
  await shot('scope-breath');
  // The breath lasts about four seconds; then you are out of it until half is back (so look for the moment, don't wait past it).
  const view = { winded: false };
  for (let t = 0; t < 12000 && !view.winded; t += 100) {
    view.winded = await b.evaluate('briel.weapon.scopeView.winded', false);
    await b.sleep(100);
  }
  console.log(`scope: the reticle drifts up to ${loose.toFixed(4)} of half the view's height, ${held.toFixed(4)} holding your breath; out of breath after 4 s: ${view.winded}`);
  check(loose > 0.004 && loose < 0.03, 'the reticle drifts, a little');
  check(held < loose * 0.4, 'holding your breath stills it');
  check(view.winded, 'the breath runs out');
  await b.evaluate('window.scopeTest.steady = false', false);
  // Turning: the dark edge creeps in from the side.
  for (let i = 0; i < 6; i++) {
    await look(0.6 + i * 0.05, 0);
    await b.sleep(16);
  }
  await shot('scope-turning');
  // Each gun up close, from the hip and with its sights at the eye: the surfaces, the sights, the rifle's red dot.
  await b.evaluate('window.scopeTest.aim = false', false);
  for (const w of ['pistol', 'rifle', 'shotgun', 'sniper', 'bazooka']) {
    await b.evaluate(`briel.weapon.select('${w}')`, false);
    await look(0.6, 0);
    await b.sleep(1200);
    await shot(`gun-${w}`);
    if (w === 'sniper') continue;
    await b.evaluate('window.scopeTest.aim = true', false);
    await b.sleep(900);
    await shot(`gun-${w}-aimed`);
    await b.evaluate('window.scopeTest.aim = false', false);
  }
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.join('\n'));
  check(!errors.length, 'no errors on the page');
} finally {
  b.close();
}
process.exit(bad ? 1 : 0);
