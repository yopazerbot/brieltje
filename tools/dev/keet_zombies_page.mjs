// Zombies alone at the church, in a page (the dev server for window.briel): the zombies follow you into the café there.
// You stand in toilet 1 with both its doors shut: a zombie shoves them open on this page and swipes at you, and the perch
// rule never warns you. Then by the front door, looking out: a picture as the zombies come through it. Then the frame
// time with twenty zombies standing in the café's front and bar rooms against the same twenty on the square in front of
// it, from the same distance, alternated (the graphics chip is shared: compare within one run only).
//
//   node tools/dev/keet_zombies_page.mjs [--url http://localhost:5200/] [--port 9437] [--preset high|low] [--phone]
//        [--out <folder for the pictures>] [--rounds 3]
//
// Prints the times and the frame times; exits 1 when a check fails.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9437', preset: 'high', phone: false, out: '', rounds: '3' });
const shell = JSON.parse(readFileSync(new URL('../../web/src/data/keet_shell.json', import.meta.url), 'utf8'));
const { o: fo, a: fa, floor: F } = shell.frame;
const W = (u, v) => [fo[0] + u * Math.cos(fa) + v * Math.sin(fa), fo[1] - u * Math.sin(fa) + v * Math.cos(fa)];
let failed = 0;
const ok = (name, pass, extra = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
  if (!pass) failed++;
};
const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
console.log('browser PID:', b.pid);
const shot = async (name) => {
  if (!o.out) return;
  await b.screenshot(join(o.out, `${name}-${o.preset}${o.phone ? '-phone' : ''}.png`));
};
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${o.preset}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.playMode','action');localStorage.setItem('briel.feedback','later');` });
  await startGame(b, o.url, { phone: o.phone, village: true });
  await b.waitFor("briel.doors.doors.some((d) => d.spec.id === 'keet-gate')", 120000); // the café's rooms are in
  await b.evaluate("briel.zombiesSolo.start('church')");
  await b.waitFor('!!briel.zombiesSolo.state()?.horde', 120000);
  const doors = await b.evaluate('briel.zombiesSolo.state().horde.doors.map((d) => d.id)');
  ok('alone at the church the horde has the café\'s doors', doors.length === 8 && doors.every((id) => id.startsWith('keet-')), doors.join(' '));

  // 1. In toilet 1, both its doors shut, facing them.
  const [tx, tz] = W(2.12, 15.9);
  const [dx, dz] = W(2.13, 14.65);
  const face = (x, z, ax, az) => Math.atan2(-(ax - x), -(az - z));
  await b.evaluate(`(() => {
    briel.teleport(${tx}, ${tz}, ${F}, ${face(tx, tz, dx, dz)}, 0);
    for (const id of ['keet-toilets', 'keet-toilet1']) briel.doors.set(id, false);
    const s = briel.zombiesSolo.state();
    s.horde.selectWave(performance.now(), 2, 1);
  })()`, false);
  const t0 = Date.now();
  const hp0 = await b.evaluate('briel.combat.hp');
  let swipe = -1;
  let opened = {};
  let near = Infinity;
  let pictured = false;
  let warned = 0;
  while (Date.now() - t0 < 150000 && swipe < 0) {
    await b.sleep(250);
    const s = await b.evaluate(`(() => {
      const h = briel.zombiesSolo.state()?.horde;
      if (!h) return null;
      const p = briel.player;
      const zs = briel.zombies.states().filter((z) => !z.down);
      const d = Math.min(...zs.map((z) => Math.hypot(z.x - p.x, z.z - p.z)));
      return { hp: briel.combat.hp, warned: Object.keys(h.warned).length, toilets: briel.doors.isOpen('keet-toilets'), toilet1: briel.doors.isOpen('keet-toilet1'), d, up: zs.length };
    })()`);
    if (!s) break;
    if (s.toilets) opened.toilets ??= Date.now() - t0;
    if (s.toilet1) opened.toilet1 ??= Date.now() - t0;
    near = Math.min(near, s.d);
    if (!pictured && s.d < 2.6) {
      await shot('keet-toilet');
      pictured = true;
    }
    warned = Math.max(warned, s.warned);
    if (s.hp < hp0) swipe = Date.now() - t0;
  }
  ok('in the toilet: zombies shove both its doors open on this page', opened.toilets >= 0 && opened.toilet1 >= 0, JSON.stringify(opened));
  ok('in the toilet: a zombie swipes', swipe >= 0, `after ${(swipe / 1000).toFixed(1)} s (wave 2 picked at the start), nearest ${near.toFixed(2)} m`);
  ok('in the toilet: never warned the zombies cannot reach you', !warned, `${warned}`);

  // 2. By the front door, looking out, harmless zombies: a picture as one comes through.
  const [fx, fz] = W(4.73, 1.6);
  const [ox, oz] = W(4.73, -3);
  await b.evaluate(`(() => {
    briel.combat.hp = 100;
    briel.teleport(${fx}, ${fz}, ${F}, ${face(fx, fz, ox, oz)}, -0.05);
    briel.doors.set('keet-front', false);
  })()`, false);
  const t1 = Date.now();
  let through = -1;
  while (Date.now() - t1 < 90000 && through < 0) {
    await b.sleep(200);
    const d = await b.evaluate(`(() => {
      const h = briel.zombiesSolo.state()?.horde;
      for (const z of h?.zombies.values() ?? []) z.damage = 0;
      briel.combat.hp = 100;
      const [dx, dz] = [${W(4.73, 0.15)[0]}, ${W(4.73, 0.15)[1]}];
      return Math.min(...briel.zombies.states().filter((z) => !z.down).map((z) => Math.hypot(z.x - dx, z.z - dz)));
    })()`);
    if (d < 0.5) through = Date.now() - t1;
  }
  ok('by the front door: a zombie comes through the doorway', through >= 0, `after ${(through / 1000).toFixed(1)} s; the door open: ${await b.evaluate("briel.doors.isOpen('keet-front')")}`);
  await shot('keet-doorway');
  await b.sleep(1500);
  await shot('keet-doorway-after');

  // 3. Twenty zombies standing in the front and bar rooms, then the same twenty on the square in front, seen from as far.
  const spots = [];
  for (let v = 2.2; v <= 16.5 && spots.length < 20; v += 1.1) for (const u of v < 7.5 ? [0.9, 2.0, 3.4, 4.6] : [3.3, 4.6]) if (spots.length < 20 && !(v > 3.5 && v < 5.3 && u < 3.8)) spots.push([u, v]);
  const place = async (shift) => b.evaluate(`(() => {
    const s = briel.zombiesSolo.state();
    const h = s.horde;
    h.toSpawn = 0;
    h.bigs = 0;
    const list = [...h.zombies.values()].filter((z) => z.act !== 'down');
    while (list.length < 20) {
      const z = { ...list[0], id: h.nextId++ };
      h.zombies.set(z.id, z);
      list.push(z);
    }
    const spots = ${JSON.stringify(spots)};
    const [ox, oz, a] = [${fo[0]}, ${fo[1]}, ${fa}];
    let i = 0;
    for (const z of list) {
      const [u, v] = spots[i % spots.length];
      const x = ox + u * Math.cos(a) + (v + ${shift}) * Math.sin(a), zz = oz - u * Math.sin(a) + (v + ${shift}) * Math.cos(a);
      const node = h.nav.locate(x, ${F} + 0.3, zz, 0.6);
      Object.assign(z, { x, z: zz, node, y: node >= 0 ? h.nav.y(node, x, zz) : z.y, act: 'hurt', until: Infinity, damage: 0, yaw: Math.PI });
      i++;
      if (i >= 20) z.act = 'down';
    }
    briel.combat.hp = 100;
    return list.filter((z) => z.act !== 'down').length;
  })()`);
  const view = async (shift) => {
    const [px, pz] = W(4.6, 0.9 + shift);
    const [lx, lz] = W(2.6, 8 + shift);
    await b.evaluate(`briel.teleport(${px}, ${pz}, ${await b.evaluate(`briel.world.groundAt(${px}, ${pz}, ${F} + 0.6, 0).y`)}, ${face(px, pz, lx, lz)}, -0.08)`, false);
  };
  const SQ = -14; // the same layout 14 m out on the square
  const runs = { inside: [], square: [] };
  await place(0);
  await view(0);
  await b.sleep(1500);
  await b.evaluate('briel.bench(60)'); // warm-up: the shaders
  await shot('keet-twenty-inside');
  for (let r = 0; r < Number(o.rounds); r++) {
    for (const [name, shift] of [['inside', 0], ['square', SQ]]) {
      await place(shift);
      await view(shift);
      await b.sleep(1200);
      runs[name].push((await b.evaluate('briel.bench(120)')).msPerFrame);
      if (r === 0 && name === 'square') await shot('keet-twenty-square');
    }
  }
  const med = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
  console.log(`frame time, ${o.preset}${o.phone ? ', phone' : ''}: twenty in the café ${runs.inside.join(' / ')} ms (median ${med(runs.inside)}), on the square ${runs.square.join(' / ')} ms (median ${med(runs.square)})`);
  const errors = b.logs.filter((l) => /^(error|exception):/.test(l));
  ok('no errors on the page', !errors.length, errors.slice(0, 3).join(' | '));
} finally {
  b.close();
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
