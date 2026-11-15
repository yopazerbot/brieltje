// The helicopters' landing deck on the church (tools/church_access.py, tools/church.py; shared/heli.json's church pad
// and its machine), in the real game, headless (tools/dev/cdp.mjs) on a running dev server, with the village in. It
// checks: the church's machine resting on its deck; a walk from the roof walk onto the deck, onto a net and back; the
// rails and the nets' edge holding a walker; boarding the machine there (E), a lift-off and a landing back on the deck,
// the pads' rings on the minimap while flying; getting out on the deck; a bump into the tower and, left where nobody
// can reach it, the machine back on its deck by itself; Zombies at the church starting while it stands there (no
// boarding, it stays) and while you fly it (you on your feet, it on its deck); no page errors. --out: pictures.
//
// Every shader program made after the start is named with the object that made it. Then: let down at eight headings
// (it lands on its skids, along the deck); two machines and one pad (held off over the other; a game starting and a
// machine left on a roof put each on its own pad, the other one first).
//
//   node tools/dev/heliPad.mjs --url http://localhost:5200/ --port 9800 [--quality low|medium|high] [--out <folder>] [--swiftshader]
//        [--start church|house: where play begins (the church: the start's warm-up sees the square's shadows)]
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeChurch } from '../../web/shared/church.mjs';
import { makeTerrain } from '../../web/shared/terrain.mjs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9800', quality: 'medium', out: '', swiftshader: false, start: 'church' });
const read = (p) => JSON.parse(readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8'));
const DATA = read('shared/church.json');
const terrain = makeTerrain(read('shared/terrain.json'));
const church = makeChurch(DATA, read('src/data/house_shell.json').ground + terrain.height(...DATA.origin));
const [OX, OZ] = DATA.origin;
const C = Math.cos(DATA.yaw), S = Math.sin(DATA.yaw);
/** The church's own frame (x to the choir, y north) from a spot in the world. */
const local = (x, z) => ({ x: C * (x - OX) - S * (z - OZ), y: -S * (x - OX) - C * (z - OZ) });
/** The yaw that faces local +x (the choir), +y (north), -x, -y. */
const FACE = { east: Math.atan2(-C, S), north: DATA.yaw, west: Math.atan2(C, -S), south: DATA.yaw - Math.PI };
const PAD = church.anchors.pad;
const DECK = PAD.y, NET = PAD.y - 0.3;

const b = await launch({ port: Number(o.port), width: 1280, height: 720, swiftshader: !!o.swiftshader && o.swiftshader !== 'false' });
let failed = false;
const check = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failed = true;
};
const r2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const shot = async (name) => {
  if (!o.out) return;
  mkdirSync(o.out, { recursive: true });
  await b.screenshot(join(o.out, `${name}.png`));
};
const CODES = { KeyE: ['e', 69], KeyC: ['c', 67], Space: [' ', 32] };
const key = (type, code) => b.send('Input.dispatchKeyEvent', { type, code, key: CODES[code][0], windowsVirtualKeyCode: CODES[code][1] });
const tap = async (code) => {
  await key('keyDown', code);
  await b.sleep(60);
  await key('keyUp', code);
};
let I = 1;
const M = () => `briel.helis.machines[${I}]`;
const state = () => b.evaluate(`(() => { const s = ${M()}.s; return { x: s.x, y: s.y, z: s.z, h: s.h, ground: s.ground, down: s.down, ev: s.ev, rotor: s.rotor }; })()`);
const until = async (expr, secs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    if (await b.evaluate(expr)) return true;
    await b.sleep(100);
  }
  return false;
};
const at = (x, y, h = 0) => church.point([x, y, h]);
const go = (x, y, feet, face) => {
  const p = at(x, y);
  return b.evaluate(`briel.teleport(${p.x}, ${p.z}, ${feet}, ${FACE[face]})`, false);
};
const walk = async (secs) => {
  const w = await b.evaluate(`briel.walk(${secs}, 0, 1)`);
  return { ...w, ...local(w.x, w.z) };
};
/** In the page: every frame's machine state, to find the touchdown (window.__prec). */
const record = () => b.evaluate(`(() => { const r = window.__prec = []; const go = () => { if (window.__prec !== r) return; const s = ${M()}.s; r.push([s.y, s.vy, s.ground ? 1 : 0, s.ev]); requestAnimationFrame(go); }; requestAnimationFrame(go); return true; })()`);
const recorded = () => b.evaluate('(() => { const r = window.__prec; window.__prec = null; return r; })()');

try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('briel.graphics','${o.quality}');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','${o.start}');localStorage.setItem('briel.playMode','explore');localStorage.setItem('briel.feedback','later');` });
  await startGame(b, o.url, { village: true });
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  // Every shader program made from here on, with the object and material that made it (the last one drawn).
  await b.evaluate(`(() => {
    const r = briel.three.renderer; const made = window.__made = []; let last = null;
    const draw = r.renderBufferDirect.bind(r);
    r.renderBufferDirect = (cam, scene, geo, mat, obj, grp) => { last = [obj, mat, cam]; return draw(cam, scene, geo, mat, obj, grp); };
    const list = r.info.programs; const push = list.push.bind(list);
    // Ours: a helicopter's or the church's (the deck); anything else is reported but is not this check's.
    const ours = (o) => { for (let q = o; q; q = q.parent) if (q === briel.helis.group || q.userData?.landmark === 'church') return true; return false; };
    list.push = (...ps) => { for (const p of ps) { const [o, m, c] = last ?? []; const path = []; for (let q = o; q && path.length < 5; q = q.parent) path.push(q.name || q.type); made.push(p.cacheKey + '|' + (ours(o) ? '' : 'NOT OURS: ') + p.name + ' for ' + (m?.name || m?.type) + ' (side ' + m?.side + ') on ' + path.join(' < ') + (c?.isOrthographicCamera ? ', shadow pass' : '')); } return push(...ps); };
  })()`);
  await b.sleep(1500);
  console.log(`the church's landing deck, ${o.quality}: centre (${r2(PAD.x)}, ${r2(PAD.z)}), floor ${r2(DECK)}`);
  I = await b.evaluate("briel.helis.machines.findIndex((m) => m.spec.id === 'church')");
  check(I >= 0, `the church has its own machine (machine ${I}, paint ${await b.evaluate(`${M()}.spec.paint`)})`);
  const m0 = await state();
  check(m0.ground && Math.abs(m0.y - DECK) < 0.05 && Math.hypot(m0.x - PAD.x, m0.z - PAD.z) < 0.2, `it rests on its deck (${r2(Math.hypot(m0.x - PAD.x, m0.z - PAD.z))} m from the centre, floor ${r2(m0.y)})`);

  // On foot: along the roof walk over its end onto the deck, onto a net and back, and against each edge.
  const roof = church.anchors.roof;
  await b.evaluate(`briel.teleport(${roof.x}, ${roof.z}, ${roof.y}, ${FACE.east})`, false);
  let w = await walk(0.2);
  for (let i = 0; i < 100 && w.x < 9.2; i++) w = await walk(0.2);
  check(w.x > 9 && Math.abs(w.feet - DECK) < 0.05 && w.on === 'church-pad', `from the roof walk onto the deck: local x ${r2(w.x)}, feet ${r2(w.feet - DECK)} over the deck, on ${w.on}`);
  await shot('walk-onto-deck');
  await b.evaluate(`briel.teleport(${at(9.2, 1.5).x}, ${at(9.2, 1.5).z}, ${DECK}, ${FACE.north})`, false);
  w = await walk(3);
  check(w.y > 5 && w.y < 6.5 && Math.abs(w.feet - NET) < 0.05 && w.on === 'church-pad-net', `north onto the net and held by its edge: y ${r2(w.y)}, feet ${r2(w.feet - DECK)}, on ${w.on}`);
  await b.evaluate(`briel.teleport(${at(w.x, w.y).x}, ${at(w.x, w.y).z}, ${w.feet}, ${FACE.south})`, false);
  w = await walk(0.8);
  check(Math.abs(w.feet - DECK) < 0.05 && w.on === 'church-pad', `and back up onto the deck: feet ${r2(w.feet - DECK)}, on ${w.on}`);
  for (const [x, y, feet, face, ok] of [
    [13.0, 3.0, DECK, 'east', (q) => q.x < 13.8], [13.0, -3.0, DECK, 'east', (q) => q.x < 13.8],
    [8.8, 3.5, DECK, 'west', (q) => q.x > 8.2], [8.8, -3.5, DECK, 'west', (q) => q.x > 8.2],
    [12.5, -5.5, NET, 'south', (q) => q.y > -6.3], [12.5, 5.5, NET, 'north', (q) => q.y < 6.3],
    [13.5, 5.6, NET, 'east', (q) => q.x < 13.8], [8.5, -5.6, NET, 'west', (q) => q.x > 8.2],
  ]) {
    await go(x, y, feet, face);
    const q = await walk(2);
    check(ok(q) && Math.abs(q.feet - feet) < 0.05, `the ${feet === NET ? "net's edge" : 'rail'} holds, walking ${face} from (${x}, ${y}): stopped at (${r2(q.x)}, ${r2(q.y)}), feet ${r2(q.feet - DECK)}`);
  }

  // Boarding on the deck: beside the cabin, E.
  const m = await state();
  const yaw = await b.evaluate(`${M()}.s.yaw`);
  await b.evaluate(`briel.teleport(${m.x + Math.cos(yaw) * 1.7}, ${m.z - Math.sin(yaw) * 1.7}, ${m.y}, ${yaw + Math.PI / 2})`, false);
  await b.sleep(400);
  const line = await b.evaluate("document.getElementById('prompt')?.textContent ?? ''");
  for (let i = 0; i < 3 && !(await b.evaluate('briel.helis.aboard')); i++) {
    await tap('KeyE');
    await b.sleep(400);
  }
  check(await b.evaluate(`briel.helis.heli === ${M()}`), `in with E on the deck (the line beside it: "${line}")`);
  check((await b.evaluate('briel.helis.padMarks().length')) === 2, 'flying, the minimap shows both pads');
  const programs = await b.evaluate('(window.__progs = new Set(briel.three.renderer.info.programs.map((p) => p.cacheKey))).size');
  await key('keyDown', 'Space');
  const up = await until(`${M()}.s.h > 15`, 20);
  await key('keyUp', 'Space');
  check(up, `lift-off from the deck to ${r2((await state()).h)} m`);
  await b.sleep(1500);
  await shot('over-deck');
  await record();
  await key('keyDown', 'KeyC');
  await until(`${M()}.s.ground`, 25);
  await b.sleep(1500);
  await key('keyUp', 'KeyC');
  const frames = await recorded();
  const i = frames.findIndex((f, k) => k > 0 && f[2] === 1 && frames[k - 1][2] === 0);
  const sink = i > 0 ? -Math.min(...frames.slice(Math.max(0, i - 3), i).map((f) => f[1])) : NaN;
  const bump = frames.some((f) => f[3] & 4);
  const landed = await state();
  check(landed.ground && Math.abs(landed.y - DECK) < 0.1 && !bump, `landed back on the deck: touched at ${r2(sink)} m/s, ${bump ? 'BUMP' : 'no bump'}, ${r2(Math.hypot(landed.x - PAD.x, landed.z - PAD.z))} m from its centre, floor ${r2(landed.y - DECK)}`);
  const fresh = await b.evaluate(`briel.three.renderer.info.programs.filter((p) => !__progs.has(p.cacheKey)).map((p) => (window.__made.find((m) => m.startsWith(p.cacheKey + '|')) ?? '|' + p.name).split('|')[1])`);
  const theirs = fresh.filter((f) => f.startsWith('NOT OURS'));
  check(fresh.length === theirs.length, `no new shader programs in flight for the helicopters or the church (${programs}${fresh.length ? `; new: ${fresh.join(', ')}` : ''})`);
  await shot('landed-on-deck');
  await b.sleep(1000);
  await tap('KeyE');
  await b.sleep(400);
  const out = await b.evaluate('({ aboard: briel.helis.aboard, x: briel.player.x, z: briel.player.z, feet: briel.player.feet })');
  const ol = local(out.x, out.z);
  check(!out.aboard && Math.abs(out.feet - DECK) < 0.05 && ol.x > 8 && ol.x < 14 && Math.abs(ol.y) < 5, `out on the deck at (${r2(ol.x)}, ${r2(ol.y)}), feet ${r2(out.feet - DECK)}`);

  // Let down at eight headings from 4 m over the pad, C held: the pad turns the nose along the deck, the skids land.
  for (let k = 0; k < 8; k++) {
    await b.evaluate(`(() => { const m = ${M()}; briel.helis.leaveNow(); m.place(m.park.x, m.park.y, m.park.z, m.park.yaw + ${k} * Math.PI / 4, 1); Object.assign(m.s, { y: m.park.y + 4, holdY: m.park.y + 4, ground: false, heightHeld: true, coll: 0.5 }); briel.helis.board(m); })()`);
    await b.sleep(300);
    await key('keyDown', 'KeyC');
    await until(`${M()}.s.ground`, 15);
    await b.sleep(1500);
    await key('keyUp', 'KeyC');
    await b.sleep(500);
    const q = await b.evaluate(`(() => { const s = ${M()}.s; return { y: s.y, ground: s.ground, yaw: s.yaw, still: s.still }; })()`);
    const off = Math.abs(Math.atan2(Math.sin(2 * (q.yaw - church.anchors.padYaw)), Math.cos(2 * (q.yaw - church.anchors.padYaw)))) / 2;
    check(q.ground && Math.abs(q.y - DECK) < 0.05 && off < 0.09, `let down turned ${k * 45} degrees: on its skids ${r2(q.y - DECK)} m over the deck, ${r2((off * 180) / Math.PI)} degrees off its line`);
    if (k === 2) await shot('landed-turned-90');
  }
  await b.evaluate('briel.helis.leaveNow()');

  // A bump into the tower, from beside the roof walk; then, left there, it goes back to its deck.
  await b.sleep(400);
  for (let k = 0; k < 3 && !(await b.evaluate('briel.helis.aboard')); k++) {
    await tap('KeyE');
    await b.sleep(400);
  }
  const t = at(-6.5, 0, 12.7 + 2.5);
  await b.evaluate(`(() => { const m = ${M()}; m.place(${t.x}, ${t.y}, ${t.z}, ${FACE.west}, 1); Object.assign(m.s, { ground: false, holdY: ${t.y}, heightHeld: true, holding: false, coll: 0.5, vx: ${-(C * 7)}, vz: ${S * 7} }); })()`);
  await record();
  await b.sleep(2500);
  const f2 = await recorded();
  check(f2.some((f) => f[3] & 4), 'into the tower at 7 m/s: a bump');
  await b.evaluate('briel.helis.leaveNow()');
  const left = await state();
  const ll = local(left.x, left.z);
  console.log(`  left after the bump at (${r2(ll.x)}, ${r2(ll.y)}), ${r2(left.y - church.point([0, 0, 0]).y)} m over the church's ground`);
  await b.evaluate(`briel.teleport(${at(0, -40).x}, ${at(0, -40).z}, ${church.point([0, -40, 0]).y}, 0)`, false);
  const home = await until(`(() => { const s = ${M()}.s; return Math.hypot(s.x - ${PAD.x}, s.z - ${PAD.z}) < 0.5 && Math.abs(s.y - ${DECK}) < 0.05; })()`, 35);
  check(home, `left where nobody can walk to it, it is back on its deck by itself`);

  // Zombies at the church while it stands on its deck: it stays there, nobody boards it in the game.
  await b.evaluate("briel.zombiesSolo.start('church')").catch(() => {});
  await b.sleep(4000);
  const z = await state();
  check(!!(await b.evaluate('briel.zombiesSolo.state()')) && Math.hypot(z.x - PAD.x, z.z - PAD.z) < 0.5 && z.ground, 'Zombies at the church starts with the machine standing on its deck');
  const mz = await state();
  await b.evaluate(`briel.teleport(${mz.x + Math.cos(yaw) * 1.7}, ${mz.z - Math.sin(yaw) * 1.7}, ${mz.y}, ${yaw + Math.PI / 2})`, false);
  await b.sleep(400);
  await tap('KeyE');
  await b.sleep(400);
  const zl = await b.evaluate("document.getElementById('prompt')?.textContent ?? ''");
  check(!(await b.evaluate('briel.helis.aboard')), `no boarding in Zombies ("${zl}")`);
  await b.evaluate('briel.zombiesSolo.stop()').catch(() => {});
  await b.sleep(1500);
  // Zombies started while you fly it: you on your feet, it back on its deck.
  await b.evaluate(`briel.helis.board(${M()})`);
  const air = at(0, -45, 25);
  await b.evaluate(`(() => { const m = ${M()}; m.place(${air.x}, ${air.y}, ${air.z}, 0, 1); Object.assign(m.s, { ground: false, holdY: ${air.y}, heightHeld: true, coll: 0.5 }); })()`);
  await b.sleep(800);
  await b.evaluate("briel.zombiesSolo.start('church')").catch(() => {});
  await b.sleep(2000);
  const za = await state();
  check(!(await b.evaluate('briel.helis.aboard')) && Math.hypot(za.x - PAD.x, za.z - PAD.z) < 0.5 && Math.abs(za.y - DECK) < 0.05 && za.ground, `Zombies started while flying it: you on your feet, it on its deck (${r2(Math.hypot(za.x - PAD.x, za.z - PAD.z))} m from the centre)`);
  await b.evaluate('briel.zombiesSolo.stop()').catch(() => {});
  await b.sleep(1500);

  // Two machines, one pad. The house's machine (0) parked on the church's deck: the church's, flown from the square,
  // can't be set down on top of it (held off, never at rest up there).
  const HOUSE = await b.evaluate('briel.helis.machines[0].park');
  const both = () => b.evaluate(`[0, ${I}].map((i) => { const s = briel.helis.machines[i].s; return { x: s.x, y: s.y, z: s.z, ground: s.ground, down: s.down }; })`);
  const onPad = (q, p) => Math.hypot(q.x - p.x, q.z - p.z) < 0.5 && Math.abs(q.y - p.y) < 0.5 && q.ground && q.down === 0;
  await b.evaluate(`briel.helis.dev.put({ x: 536, z: -764.5, yaw: 0 }, 0, ${I})`);
  await b.evaluate(`briel.helis.dev.put('church', 0, 0)`);
  await b.evaluate(`(() => { const m = ${M()}; m.place(${PAD.x}, ${DECK}, ${PAD.z}, m.park.yaw, 1); Object.assign(m.s, { y: ${DECK + 7}, holdY: ${DECK + 7}, ground: false, heightHeld: true, coll: 0.5 }); briel.helis.board(m); })()`);
  await key('keyDown', 'KeyC');
  await b.sleep(7000);
  const held = await state();
  await tap('KeyE');
  await b.sleep(300);
  const stillIn = await b.evaluate('briel.helis.aboard');
  await key('keyUp', 'KeyC');
  check(!held.ground && held.y - DECK > 3 && stillIn, `let down onto the other machine: held off ${r2(held.y - DECK)} m over the deck, no getting out up there`);
  // Zombies started while flying it, the other machine on its pad: that one goes to its own pad first, no bump.
  await b.evaluate(`(() => { const m = ${M()}; m.place(536, ${church.point([0, -25, 0]).y + 30}, -764.5, 0, 1); Object.assign(m.s, { ground: false, holdY: m.s.y, heightHeld: true, coll: 0.5 }); })()`);
  await b.evaluate("briel.zombiesSolo.start('church')").catch(() => {});
  await b.sleep(2500);
  let [h0, h1] = await both();
  check(onPad(h1, { x: PAD.x, y: DECK, z: PAD.z }) && onPad(h0, HOUSE), `a game starting: the house's machine back on its own pad, the church's on its deck (${r2(Math.hypot(h0.x - HOUSE.x, h0.z - HOUSE.z))} and ${r2(Math.hypot(h1.x - PAD.x, h1.z - PAD.z))} m off)`);
  await b.evaluate('briel.zombiesSolo.stop()').catch(() => {});
  await b.sleep(25000);
  [h0, h1] = await both();
  check(onPad(h1, { x: PAD.x, y: DECK, z: PAD.z }) && onPad(h0, HOUSE), '25 s later both are still where they belong (no bump, no flight home)');
  // The church's machine left on a roof, the house's on the church's deck: after 20 s each is on its own pad.
  await b.evaluate(`briel.helis.dev.put('church', 0, 0)`);
  const naveRoof = at(-6.5, 3.6, 0);
  await b.evaluate(`(() => { const p = ${JSON.stringify(naveRoof)}; const g = briel.world.groundAt(p.x, p.z, 999, 0).y; briel.helis.dev.put({ x: p.x, y: g, z: p.z, yaw: 0 }, 0, ${I}); })()`);
  await b.evaluate(`briel.teleport(${at(0, -40).x}, ${at(0, -40).z}, ${church.point([0, -40, 0]).y}, 0)`, false);
  const swapped = await until(`(() => { const a = briel.helis.machines[0].s, c = ${M()}.s; return Math.hypot(a.x - ${HOUSE.x}, a.z - ${HOUSE.z}) < 0.5 && Math.hypot(c.x - ${PAD.x}, c.z - ${PAD.z}) < 0.5 && Math.abs(c.y - ${DECK}) < 0.05; })()`, 40);
  check(swapped, 'left on a roof while the other stood on its deck: after 20 s the other went to its own pad and it to its deck');

  const errors = b.logs.filter((l) => /^exception|^error/.test(l) && !/Failed to load resource/.test(l));
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 5).join(' | ')}` : ''}`);
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  b.close();
}
process.exit(failed ? 1 : 0);
