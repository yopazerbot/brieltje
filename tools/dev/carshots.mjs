// Photograph the two Teslas (the Model Y and the Model 3) in the game from fixed views, on a running dev server.
// Both are put on a straight road in the fields, nose to tail 14 m apart, and the camera is held at each view.
//
//   node tools/dev/carshots.mjs <outFolder> --url http://localhost:5251/ --port 9451
//     [--quality high|medium|low] [--mood sunny|overcast|rain|dusk|night|snow] [--lights] [--phone]
//     [--views all|shape|few|far|people|<name,name>] [--paint "#c4c7cc"] [--stats] [--eval "<script run before the pictures>"]
//     [--people none|driver|both] [--steer <-1..1>] [--glass <opacity>]
//
// --people: figures without a player in the seats (world/carPeople.ts), the driver in blue, the passenger in red.
// --steer: the wheel turned (1 full left). --glass: every window of both cars at this opacity (to see the figures' fit).
// The views `chase` (as the camera behind the car you drive) and `pavement` (as someone on foot beside it), `top`, and
// the set `people`: eight ways round 45 degrees apart (dir000 .. dir315), top, chase and pavement.
// --lights: both cars as if someone sits in them (headlights and tail lights at night). --paint: one colour for both
// (grey shows the shape best). --stats: meshes and triangles drawn per car, by material, into stats.json. Pictures are
// named my_<view>.png and m3_<view>.png. Pass your own --port: the default collides with other checks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5173/', port: '9350', quality: 'high', mood: 'sunny', views: 'all', lights: false, paint: '', stats: false, phone: false, eval: '', people: 'none', steer: '0', glass: '' });
const out = o._[0];
if (!out) {
  console.error('usage: node tools/dev/carshots.mjs <outFolder> --url <dev server> --port <debugging port> [options]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

// Views round a car: name, angle from its nose (0 = dead ahead, 90 = its right side), distance from its middle (m),
// eye height, the height looked at, field of view (degrees).
const ALL = [
  ['front', 0, 5.5, 1.0, 0.75, 30], ['front3q', 38, 7.0, 1.4, 0.7, 30], ['side', 90, 7.0, 1.0, 0.75, 30],
  ['rear3q', 142, 7.0, 1.4, 0.75, 30], ['rear', 180, 5.5, 1.0, 0.75, 30], ['high', 30, 6.5, 4.5, 0.8, 30],
  ['cabin', 75, 3.6, 1.8, 1.05, 30], ['low3q', 45, 5.5, 0.4, 0.55, 30], ['wheel', 0, 0, 0, 0, 30],
  // From 75 m, narrowed to the size of the near views: what a car looks like far off.
  ['far', 8, 75, 3, 0.7, 3],
  // The people inside: as the camera behind the car you drive, as someone on the pavement beside it, from right above.
  ['chase', 180, 6.3, 2.8, 1.4, 60], ['pavement', 110, 4.5, 1.65, 1.1, 45], ['top', 0, 0, 0, 0, 30],
  ...[0, 45, 90, 135, 180, 225, 270, 315].map((d) => [`dir${String(d).padStart(3, '0')}`, d, 4.8, 1.5, 0.9, 35]),
];
const SETS = {
  all: ALL.filter(([n]) => n !== 'far' && !/^(dir|chase|pavement|top)/.test(n)), shape: ['front3q', 'rear3q', 'side', 'front', 'rear', 'high'], few: ['front3q', 'rear3q'], far: ['front3q', 'far'],
  people: [0, 45, 90, 135, 180, 225, 270, 315].map((d) => `dir${String(d).padStart(3, '0')}`).concat(['top', 'chase', 'pavement']),
};
const pick = SETS[o.views] ?? o.views.split(',');
const views = ALL.filter(([n]) => (Array.isArray(pick) ? pick.map((p) => (typeof p === 'string' ? p : p[0])) : []).includes(n));

const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
console.log('browser pid', b.pid);
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');" });
  await startGame(b, o.url, { phone: o.phone });
  await b.waitFor('briel.cars.slice(0,2).every(c=>c.wheels.length===4)');
  await b.evaluate("document.getElementById('cc-close')?.click()", false);
  await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)}); briel.three.holdQuality?.(true)`, false);
  await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(o.mood)})`, false);
  // A straight road in the fields; the cars face along it.
  const road = { x: 636.6, z: 142.6, dx: 668.9 - 636.6, dz: 355.8 - 142.6 };
  const len = Math.hypot(road.dx, road.dz);
  const ux = road.dx / len;
  const uz = road.dz / len;
  // The camera is held where __look puts it: the game's own camera is set again just before each render.
  const cars = JSON.parse(await b.evaluate(`(() => {
    const res = [];
    for (let i = 0; i < 2; i++) {
      const x = ${road.x} + ${ux} * (20 + i * 14), z = ${road.z} + ${uz} * (20 + i * 14);
      const g = briel.world.groundAt(x, z, 50, 0.3);
      briel.cars[i].place(x, g.y, z, Math.atan2(${-ux}, ${-uz}));
      res.push({ x, y: g.y, z });
    }
    const comp = briel.three.composer;
    const cam = comp.passes.find((p) => p.camera && p.camera.isPerspectiveCamera)?.camera;
    window.__view = null;
    const render = comp.render.bind(comp);
    comp.render = (dt) => {
      const v = window.__view;
      if (v && cam) {
        cam.position.set(v[0], v[1], v[2]);
        cam.fov = v[6];
        cam.updateProjectionMatrix();
        cam.lookAt(v[3], v[4], v[5]);
        cam.updateMatrixWorld(true);
      }
      return render(dt);
    };
    window.__look = (cx, cy, cz, tx, ty, tz, fov = 30) => {
      const dx = tx - cx, dz = tz - cz;
      briel.teleport(cx, cz, cy - 1.65, Math.atan2(-dx, -dz), Math.atan2(ty - cy, Math.hypot(dx, dz)));
      briel.player.flying = true;
      window.__view = [cx, cy, cz, tx, ty, tz, fov];
    };
    return JSON.stringify(res);
  })()`, false));
  if (o.paint) await b.evaluate(`for (const c of briel.cars.slice(0, 2)) { c.paint.color.set(${JSON.stringify(o.paint)}); c.paint.metalness = 0.3; }`, false);
  if (o.lights) await b.evaluate("briel.cars[0].driver = 'Check'; briel.cars[1].driver = 'Check'", false);
  await b.evaluate('briel.player.chute = briel.player.canopy = null', false); // a start that began with a drop: its parachute out of the pictures
  if (o.people !== 'none') {
    await b.evaluate(`for (const c of briel.cars.slice(0, 2)) { briel.carPeople.dummy(c, 0, '#2f6fd8'); if (${o.people === 'both'}) briel.carPeople.dummy(c, 1, '#d8452f'); }`, false);
  }
  if (Number(o.steer)) await b.evaluate(`for (const c of briel.cars.slice(0, 2)) c.steer = 0.62 * ${Number(o.steer)}`, false);
  if (o.glass) {
    // Every window at one opacity, the lighter glass of a car with someone in it too (made once the figures sit).
    await b.sleep(500);
    await b.evaluate(`for (const c of briel.cars.slice(0, 2)) c.group.traverse((m) => { if (m.isMesh && /^Glass/.test(m.userData.part ?? '')) m.material.opacity = ${Number(o.glass)}; })`, false);
  }
  if (o.eval) await b.evaluate(o.eval, false); // a change to try out first, e.g. a material's setting  await b.evaluate(`__look(${cars[0].x + 6}, ${cars[0].y + 2}, ${cars[0].z}, ${cars[0].x}, ${cars[0].y}, ${cars[0].z})`, false);
  await b.evaluate("(() => { const st = document.createElement('style'); st.textContent = '#hud, #credit, #sound-btn, #map-btn, #touch { visibility: hidden !important; }'; document.head.appendChild(st); })()", false);
  await b.sleep(20000); // the mood blends in; the tiles round the spot load; the start's parachute is packed away

  if (o.stats) {
    // What each car draws near: its meshes (each a draw call) and triangles, by material.
    const stats = await b.evaluate(`(() => {
      const res = {};
      briel.cars.slice(0, 2).forEach((car, i) => {
        const parts = {};
        let meshes = 0, tris = 0;
        car.group.traverse((m) => {
          if (!m.isMesh || !m.userData.part) return;
          for (let p = m; p; p = p.parent) if (p.name === 'Far') return; // the copy for far off: not drawn near
          meshes++;
          const t = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
          tris += t;
          const p = (parts[m.userData.part] ??= { meshes: 0, tris: 0 });
          p.meshes++;
          p.tris += t;
        });
        res[i ? 'model3' : 'modelY'] = { meshes, tris, parts };
      });
      return JSON.stringify(res, null, 1);
    })()`, false);
    writeFileSync(join(out, 'stats.json'), stats);
    console.log(stats);
  }

  for (let i = 0; i < 2; i++) {
    const c = cars[i];
    const tag = i ? 'm3' : 'my';
    for (const [name, deg, dist, eye, look, fov] of views) {
      if (name === 'wheel') {
        // The front wheel on the car's right side, from in front and a little out.
        const wx = c.x + ux * 1.45, wz = c.z + uz * 1.45;
        const sx = -uz, sz = ux;
        await b.evaluate(`__look(${wx + sx * 3.2 + ux * 1.2}, ${c.y + 0.6}, ${wz + sz * 3.2 + uz * 1.2}, ${wx + sx * 0.9}, ${c.y + 0.36}, ${wz + sz * 0.9}, ${fov})`, false);
      } else if (name === 'top') {
        // Straight down from 7 m, the car lying across the picture, its nose to the left.
        const sx = -uz, sz = ux;
        await b.evaluate(`__look(${c.x + sx * 0.02}, ${c.y + 7}, ${c.z + sz * 0.02}, ${c.x}, ${c.y}, ${c.z}, ${fov})`, false);
      } else {
        // The car's nose points along (ux, uz); turn from it by the view's angle.
        const a = (deg * Math.PI) / 180;
        const fx = ux * Math.cos(a) - uz * Math.sin(a), fz = uz * Math.cos(a) + ux * Math.sin(a);
        await b.evaluate(`__look(${c.x + fx * dist}, ${c.y + eye}, ${c.z + fz * dist}, ${c.x}, ${c.y + look}, ${c.z}, ${fov})`, false);
      }
      await b.sleep(name === 'far' ? 3000 : 1500);
      await b.screenshot(join(out, `${tag}_${name}.png`));
    }
  }
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
} finally {
  b.close();
}
