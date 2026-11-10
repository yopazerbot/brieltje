// Two players together on a throwaway game server, through a dev server whose proxy points at it
// (API_PORT=<server port> npx vite --port <n>): Alice takes the sniper rifle from the roof terrace and
// aims; Bob, 14 m off at her height, watches. Checks that Bob's page hears that she aims and that she stops (the
// `aim` flag, shared/wire.mjs), that her scope glints for him only while it points his way, that he sees
// the tracer of her shot, and
// saves a picture of her aiming as Bob sees her.
//   node tools/dev/aim_mp.mjs --url http://localhost:5391/ --ports 9864,9865 [--out <folder>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5391/', ports: '9864,9865', out: '' });
localOnly(o.url, '--url'); // two players join: a throwaway server on this computer only
const [pa, pb] = o.ports.split(',').map(Number);
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};

/** A page that joins the game together under `name`, in Action (a gun in hand). */
async function player(port, name) {
  const b = await launch({ port, width: 1000, height: 560 });
  console.log(name, 'browser PID:', b.pid);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','low');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');" });
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
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  await b.evaluate('briel.weapon.setEnabled(true)', false);
  return b;
}

const tag = Math.random().toString(36).slice(2, 6); // names stay with whoever joined with them for the day
const alice = await player(pa, `Alice${tag}`);
const bob = await player(pb, `Bob${tag}`);
try {
  /** What Bob's page has of Alice. */
  const seen = () => bob.evaluate(`(() => {
    const a = [...briel.avatars.avatars.values()][0];
    return a?.latest ? { aim: a.latest.aim, w: a.latest.w, armed: a.latest.armed, glint: !!a.glint?.visible, x: a.latest.x, y: a.latest.y, z: a.latest.z } : null;
  })()`, false);
  const until = async (what, test, ms = 20000) => {
    let s = null;
    for (let t = 0; t < ms; t += 250) {
      s = await seen();
      if (s && test(s)) return ok(what, true);
      await bob.sleep(250);
    }
    ok(what, false, JSON.stringify(s));
  };
  // Alice: onto the roof terrace, over the sniper rifle lying there (the server lets her move at a run, so ask until she has it).
  await alice.evaluate(`(() => {
    const w = briel.weapon;
    const update = w.update.bind(w);
    window.aimTest = false;
    w.update = (dt, moving, aiming, look) => update(dt, moving, window.aimTest, look);
  })()`, false);
  for (let i = 0; i < 30 && (await alice.evaluate('briel.weapon.current', false)) !== 'sniper'; i++) {
    await alice.evaluate(`(() => {
      const spot = briel.pickups.spots.find((s) => s.w === 'sniper');
      briel.player.place(spot.x, spot.z, spot.y, 0, 0);
      briel.weapon.select('sniper');
    })()`, false);
    await alice.sleep(1000);
  }
  ok('Alice has the sniper rifle', (await alice.evaluate('briel.weapon.current', false)) === 'sniper');
  await until('Bob sees her with it, not aiming', (s) => s.armed && s.w === 'sniper' && !s.aim);
  // Bob: 14 m off at her height (hovering, as the house rules allow), looking at her.
  const at = await alice.evaluate('({ x: briel.player.x, y: briel.player.feet, z: briel.player.z })', false);
  for (let i = 0; i < 30; i++) {
    await bob.evaluate(`briel.player.flying = true; briel.player.place(${at.x + 14}, ${at.z}, ${at.y}, Math.PI / 2, 0)`, false);
    await bob.sleep(700);
    const b = await bob.evaluate('({ x: briel.player.x, z: briel.player.z })', false);
    if (Math.abs(b.x - (at.x + 14)) < 1) break;
  }
  let b = await bob.evaluate('({ x: briel.player.x, y: briel.player.feet, z: briel.player.z })', false);
  // Alice aims, looking away from Bob: he hears of it, and sees no glint.
  await alice.evaluate(`briel.player.yaw = ${Math.atan2(-(b.x - at.x), -(b.z - at.z)) + Math.PI}; briel.player.pitch = 0; window.aimTest = true`, false);
  await until('Bob hears that she aims', (s) => s.aim);
  await bob.sleep(800);
  ok('no glint while her scope points away', !(await seen()).glint);
  // She turns her scope on him: it glints.
  await bob.sleep(1500);
  b = await bob.evaluate('({ x: briel.player.x, y: briel.player.feet, z: briel.player.z })', false); // where he stands now (he may have come down)
  const flat = Math.hypot(b.x - at.x, b.z - at.z);
  await alice.evaluate(`briel.player.yaw = ${Math.atan2(-(b.x - at.x), -(b.z - at.z))}; briel.player.pitch = ${Math.atan2(b.y - at.y, flat)}`, false); // eye to eye: both stand 1.65 m over their feet
  await until('her scope glints when it points at him', (s) => s.glint);
  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    await bob.evaluate(`briel.player.yaw = ${Math.atan2(-(at.x - b.x), -(at.z - b.z))}; briel.player.pitch = ${Math.atan2(at.y - b.y, flat)}`, false);
    await bob.sleep(600);
    await bob.screenshot(join(o.out, 'aim-glint.png'));
  }
  // She fires: Bob's page draws her bullet's tracer (the shot carries where it goes).
  await bob.evaluate('briel.weapon.setEnabled(true)', false); // armed: a bullet close by is his business
  await bob.evaluate(`(() => {
    window.tracers = 0;
    const draw = briel.effects.tracer.bind(briel.effects);
    briel.effects.tracer = (from, to) => { window.tracers++; window.tracerLine = { from: from.toArray(), to: to.toArray(), eye: briel.three.scene.getObjectByProperty('isCamera', true)?.getWorldPosition(from.clone()).toArray(), alive: briel.combat.alive, armed: briel.weapon.enabled }; draw(from, to); };
  })()`, false);
  await alice.evaluate('briel.fire()', false);
  await bob.sleep(1500);
  ok('Bob sees the tracer of her shot', (await bob.evaluate('window.tracers', false)) === 1);
  ok('the shot passing close made his view flinch', await bob.evaluate("!!document.getElementById('near-miss')", false), JSON.stringify(await bob.evaluate('window.tracerLine', false)));
  // She lowers the rifle: Bob hears that too, and the glint is gone.
  await alice.evaluate('window.aimTest = false', false);
  await until('Bob hears that she stopped aiming', (s) => !s.aim && !s.glint);
  for (const [name, p] of [['Alice', alice], ['Bob', bob]]) {
    const errors = p.logs.filter((l) => /^(error|exception)/.test(l));
    ok(`no errors on ${name}'s page`, !errors.length, errors.join(' | ').slice(0, 300));
  }
} finally {
  alice.close();
  bob.close();
}
process.exit(failed ? 1 : 0);
