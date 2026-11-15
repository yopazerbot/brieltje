// The pets' dog (web/src/world/pets.ts) on its own, headless (tools/dev/cdp.mjs), on a running dev server: the module
// is imported into the page and a dog is put on the floor in front of the player, on a clock this check sets, so the
// pictures show it lying, getting up, walking its round and turning its head. No home and no pack: a made-up spot and
// coat. Also: a plain page asks for no dog.glb, two sets of pets on one clock stand in the same place, frame time with
// and without the dog (alternated), and the frame the dog first appears.
//
//   node tools/dev/dog.mjs <out folder> [--url http://localhost:5200/] [--quality high|low] [--phone] [--swiftshader]
//                          [--at x,z,feet,yaw] [--bench] [--prepare] [--port 9343]
// --prepare: the dog's shaders compiled in the background before it shows (the 'prepare' option of addPets).
import { mkdirSync } from 'node:fs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', quality: 'high', phone: false, swiftshader: false, at: '536.3,-771.6,4.7186,1.9', bench: false, prepare: false, port: '9343' });
const out = o._[0];
if (!out) throw new Error('usage: node tools/dev/dog.mjs <out folder> [options]');
mkdirSync(out, { recursive: true });
const tag = `${o.quality}${o.phone ? '-phone' : ''}${o.swiftshader ? '-swift' : ''}`;
const b = await launch({ port: Number(o.port), swiftshader: o.swiftshader });
// Every request the page makes (the resource timing buffer of the page fills up and drops entries).
const requests = [];
await b.send('Network.enable');
b.listeners.push((m) => m.method === 'Network.requestWillBeSent' && requests.push(m.params.request.url));
const dogAsked = () => requests.filter((u) => u.includes('/models/dog.glb')).length;
try {
  await startGame(b, o.url, { phone: o.phone });
  await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)}); briel.three.holdQuality(true)`, false);
  const [x, z, feet, yaw] = o.at.split(',').map(Number);
  await b.evaluate(`briel.teleport(${x}, ${z}, ${feet}, ${yaw}, -0.8)`, false);
  await b.sleep(3000);
  console.log(`${dogAsked() ? 'FAIL' : 'ok  '} a page without pets asks for no dog.glb (${requests.length} requests so far)`);

  // A dog 1.3 m ahead, side-on to the player; its round: a box of 1.4 by 2.4 m further on.
  const p = JSON.parse(await b.evaluate('JSON.stringify({ x: briel.player.x, z: briel.player.z, feet: briel.player.feet, yaw: briel.player.yaw })', false));
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  const pt = (f, r) => [+(p.x + fx * f + rx * r).toFixed(3), +(p.z + fz * f + rz * r).toFixed(3)];
  const [restX, restZ] = pt(1.3, 0);
  const spec = {
    kind: 'dog', scale: 1, coat: '#f1eee8', patch: '#7a4a2a', rest: [restX, p.feet, restZ, Math.atan2(rx, rz)], // side-on to the player
    loop: [pt(2.2, 1.2), pt(3.6, 1.2), pt(3.6, -1.2), pt(2.2, -1.2)],
  };
  await b.evaluate(`(async () => {
    const m = await import('/src/world/pets.ts');
    window.__dog = { t: 0, eye: briel.three.scene.position.clone(), far: false };
    const d = window.__dog;
    const eye = () => d.far ? d.eye.set(0, 0, 0) : d.eye.set(briel.player.x, briel.player.feet + 1.6, briel.player.z);
    // --prepare: the shaders made in the background first, as main.ts precompile does (for the composer's target).
    const r = briel.three.renderer, c = briel.three.composer;
    const prepare = ${o.prepare} ? (o) => { const was = r.getRenderTarget(); r.setRenderTarget(c.readBuffer); const p = r.compileAsync(o, c.passes[0].camera, briel.three.scene); r.setRenderTarget(was); return p; } : undefined;
    d.frames = [];
    d.t0 = performance.now();
    d.pets = m.addPets(briel.three.scene, [${JSON.stringify(spec)}], () => d.t, eye, { prepare });
    d.twin = m.addPets(briel.three.scene, [${JSON.stringify(spec)}], () => d.t, eye, { prepare });
    let last = performance.now();
    const tick = (now) => { d.frames.push([now, now - last]); d.pets.update((now - last) / 1000); d.twin.update(0.5); last = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);
  await b.waitFor("briel.three.scene.children.filter((c) => c.name === 'pets').length === 2", 30000);
  const loadMs = await b.evaluate('Math.round(performance.now() - __dog.t0)', false);
  console.log('dog.glb in and the dogs placed after', loadMs, 'ms; asked for', dogAsked(), 'time(s) for two sets');
  await b.sleep(2000);
  // The longest frame from the moment addPets was called until 2 s after the dogs showed.
  const frames = JSON.parse(await b.evaluate('JSON.stringify(__dog.frames.map(([, ms]) => +ms.toFixed(1)))', false));
  const sorted = [...frames].sort((a1, a2) => a1 - a2);
  console.log(`frames while the dog came (${o.prepare ? 'shaders made first' : 'no prepare'}): longest ${sorted.at(-1)} ms, median ${sorted[sorted.length >> 1]} ms, of ${frames.length}`);
  // Where the dog is over a whole cycle (both sets): its walk shows as movement.
  const track = JSON.parse(await b.evaluate(`(() => {
    const [a, c] = briel.three.scene.children.filter((o) => o.name === 'pets');
    const out = [];
    for (let t = 0; t < 120; t += 0.25) {
      __dog.t = t; __dog.pets.update(0); __dog.twin.update(0);
      const pa = a.children[0].position, pc = c.children[0].position;
      out.push([t, +pa.x.toFixed(3), +pa.z.toFixed(3), +Math.hypot(pa.x - pc.x, pa.y - pc.y, pa.z - pc.z).toFixed(4)]);
    }
    return JSON.stringify(out);
  })()`, false));
  const away = track.map(([, px, pz]) => Math.hypot(px - restX, pz - restZ) > 0.02);
  const apart = Math.max(...track.map((r) => r[3]));
  console.log(`${apart < 1e-3 ? 'ok  ' : 'FAIL'} two sets of pets on one clock stand in the same place (at most ${apart} m apart)`);
  // The walk's start and end (it may wrap round the cycle's end).
  const n = track.length;
  const start = away.findIndex((a, i) => a && !away[(i + n - 1) % n]);
  let len = 0;
  while (away[(start + len) % n]) len++;
  const w0 = track[start][0], w1 = w0 + len / 4;
  console.log(`walks from ${w0} s for ${len / 4} s of the 120 s cycle`);

  // The pictures: lying (the player near: it looks up), lying with nobody near, sitting up, standing, walking.
  const shot = async (name, t, far = false, settle = 1200) => {
    await b.evaluate(`__dog.t = ${t}; __dog.far = ${far}`, false);
    await b.sleep(settle);
    await b.screenshot(`${out}/dog-${name}-${tag}.png`);
  };
  await b.evaluate("briel.three.scene.children.filter((o) => o.name === 'pets')[1].visible = false", false);
  // Close up: the passes draw through a camera of this check's own, 1.1 m from the dog's spot, a little above it
  // (the player stays where it is: the dog still looks at the player's eye).
  const zoom = (on) => b.evaluate(`(() => {
    const passes = briel.three.composer.passes.filter((q) => q.camera);
    if (!__dog.cam0) __dog.cam0 = passes[0].camera;
    let cam = __dog.cam0;
    if (${on}) {
      cam = __dog.cam0.clone();
      cam.fov = 30;
      cam.position.set(${restX - fx * 0.95}, ${p.feet + 0.45}, ${restZ - fz * 0.95});
      cam.lookAt(${restX}, ${p.feet + 0.12}, ${restZ});
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    }
    for (const q of passes) q.camera = cam;
  })()`, false);
  // The head's turn: where the head points with nobody near and with the player near (the angle between, degrees).
  const headDir = async (far) => {
    await b.evaluate(`__dog.t = ${w0 - 20}; __dog.far = ${far}`, false);
    await b.sleep(1500);
    return JSON.parse(await b.evaluate(`(() => { const h = briel.three.scene.children.find((o) => o.name === 'pets').getObjectByName('Head'); const q = h.getWorldQuaternion(h.quaternion.clone()); const v = h.position.clone().set(0, 0, 1).applyQuaternion(q); return JSON.stringify([v.x, v.y, v.z]); })()`, false));
  };
  const [a1, a2] = [await headDir(true), await headDir(false)];
  const turned = (Math.acos(Math.max(-1, Math.min(1, a1[0] * a2[0] + a1[1] * a2[1] + a1[2] * a2[2]))) * 180) / Math.PI;
  console.log(`${turned > 10 ? 'ok  ' : 'FAIL'} the head turns to a player within 4 m (${turned.toFixed(0)} degrees)`);
  await zoom(true);
  await shot('lie-nobody', w0 - 20, true);
  await shot('lie-looks', w0 - 20, false);
  await shot('sit', w0 - 2.2);
  await shot('stand', w0 - 0.5, false, 700);
  // The walk from its spot, from the side: the clock running at its own pace.
  await b.evaluate(`__dog.t = ${w0 + 0.1}; __dog.run = setInterval(() => (__dog.t += 0.05), 50)`, false);
  await b.sleep(500);
  await b.screenshot(`${out}/dog-walking-${tag}.png`);
  await b.evaluate('clearInterval(__dog.run)', false);
  await zoom(false);
  await b.evaluate(`briel.teleport(${p.x}, ${p.z}, ${p.feet}, ${p.yaw}, -0.5)`, false);
  for (const f of [0.15, 0.4, 0.7]) await shot(`walk${Math.round(f * 100)}`, w0 + (w1 - w0) * f, false, 400);

  if (o.bench) {
    await b.evaluate(`__dog.t = ${w0 - 20}`, false);
    await b.evaluate('briel.bench(60)', false); // warm-up
    const runs = { with: [], without: [] };
    for (let k = 0; k < 4; k++) {
      for (const w of ['with', 'without']) {
        await b.evaluate(`briel.three.scene.children.filter((o) => o.name === 'pets')[0].visible = ${w === 'with'}`, false);
        await b.sleep(300);
        runs[w].push(JSON.parse(await b.evaluate('JSON.stringify(briel.bench(120))', false)).msPerFrame);
      }
    }
    console.log('bench ms/frame (the dog in view, lying)', JSON.stringify(runs));
  }
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
} finally {
  b.close();
}
