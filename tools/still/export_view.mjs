// Export one of the slideshow's views (views.json) for render_still.py, headless (tools/dev/cdp.mjs): through the
// start screen, the player near the view so the area round it is loaded, the view's weather (`mood`), and for a
// parachute view the drop itself; then export_scene.js in the page, which saves start_scene.glb and
// start_info.json into <out dir>.
//
//   node tools/still/export_view.mjs <view> <out dir> [--url http://localhost:5200/] [--port 9340]
//
// A view with `drop` is the player's own skydive (world/parachutes.ts): it starts over `drop.at`, opens the
// canopy, and once the canopy has been open `drop.hold` seconds the game is stopped (its animation loop) and
// the figure with its parachute is put at `drop.figure` ([x, feet, z]) facing `drop.heading`, so the picture
// doesn't depend on how the flight went. The camera is the view's own position and target; `house` (null in views.json)
// is the start screen's own camera (export_scene.js), with the player put by the road in front of the house.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch, options, startGame } from '../dev/cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9340' });
const [name, out] = o._;
const views = JSON.parse(readFileSync(new URL('./views.json', import.meta.url), 'utf8'));
const START = { position: [15.3, 5.9, 18.5], target: [4.45, 1.1, 0] }; // main.ts startCamera
const view = views[name] ?? null;
const at = view ?? START;
if (!(name in views) || (view && !view.position)) throw new Error(`usage: node tools/still/export_view.mjs <view> <out dir>; views with a camera: ${Object.keys(views).filter((k) => views[k]?.position).join(', ')}`);
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
for (const f of ['start_scene.glb', 'start_info.json']) if (existsSync(resolve(dir, f))) throw new Error(`${f} is already in ${dir}: the browser would save a copy under another name`);

const b = await launch({ port: Number(o.port), downloads: dir });
try {
  // Nothing of the players in a picture: the server's lists (the town board's best runs, accounts) stay unasked,
  // so the board shows its empty list whatever server the dev server's proxy reaches.
  await b.send('Network.enable');
  await b.send('Network.setBlockedURLs', { urls: ['*/api/*'] });
  // The High preset, whatever the graphics chip guesses: the leaf-card trees, the hedges' sprigs and the near
  // trees' full crowns (world/leafCards.ts), the rooms behind the windows. Set before the game starts.
  await b.send('Page.navigate', { url: o.url });
  await b.waitFor('document.readyState === "complete"');
  await b.evaluate("localStorage.setItem('briel.graphics', 'high')", false);
  await startGame(b, o.url, { village: true });
  const [px, py, pz] = at.position;
  const [tx, ty, tz] = at.target;
  // The player where the camera will be, flying, looking at the target: the area round it loads.
  const yaw = Math.atan2(-(tx - px), -(tz - pz));
  const pitch = Math.atan2(ty - py, Math.hypot(tx - px, tz - pz));
  await b.evaluate(`briel.player.flying = true; briel.teleport(${px}, ${pz}, ${py - 1.6}, ${yaw}, ${pitch}); briel.player.flying = true`, false);
  // The view's weather, sunny when it names none (Auto could be anything at that moment).
  await b.evaluate(`briel.three.weather.setSolo(${JSON.stringify(view?.mood ?? 'sunny')})`, false);
  await b.sleep(12000); // the tiles round the view, and a mood picked by hand blends in over 8 s (world/weather.ts)
  // The leaf cards come in once their pictures are painted, in idle slices after play has begun.
  await b.evaluate("import('/src/world/leafCards.ts').then((m) => { window.stillCards = m.cardsShown; })");
  await b.waitFor('window.stillCards()', 120000);
  await b.sleep(2000);
  if (view?.drop) {
    const d = view.drop;
    await b.evaluate(`briel.player.flying = false; briel.beginDrop({ x: ${d.at[0]}, z: ${d.at[1]}, yaw: ${d.heading} })`, false);
    await b.sleep(1500);
    await b.evaluate('briel.press({ jumpPressed: true })', false); // the canopy opens
    // Stop the game once the canopy has been open a while, between two frames.
    await b.evaluate(`new Promise((done) => { const tick = () => { const p = briel.player; if (p.canopy !== null && p.canopy >= ${d.hold}) { briel.three.renderer.setAnimationLoop(null); done(1); } else if (p.chute === null) done(0); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`);
    const moved = await b.evaluate(`(() => {
      const p = briel.player;
      const g = briel.three.scene.children.find((o) => o.isGroup && o.children.length >= 2 && Math.hypot(o.position.x - p.x, o.position.z - p.z) < 0.5 && Math.abs(o.position.y - p.feet) < 1);
      if (!g) return null;
      g.position.set(${d.figure[0]}, ${d.figure[1]}, ${d.figure[2]});
      g.rotation.y = ${d.heading};
      g.updateMatrixWorld(true);
      return g.children.length;
    })()`);
    if (!moved) throw new Error('the drop was over before the canopy had been open long enough, or its figure was not found');
  }
  await b.evaluate(`window.stillView = ${view ? JSON.stringify({ position: view.position, target: view.target, fov: view.fov, render: view.render }) : 'null'}`, false);
  console.log(await b.evaluate(readFileSync(new URL('./export_scene.js', import.meta.url), 'utf8')));
  // The two downloads, once they have stopped growing.
  for (let i = 0, last = -1; i < 240; i++) {
    await b.sleep(500);
    const files = ['start_scene.glb', 'start_info.json'].map((f) => resolve(dir, f));
    if (!files.every(existsSync)) continue;
    const size = files.reduce((s, f) => s + statSync(f).size, 0);
    if (size === last) break;
    last = size;
  }
  console.log('saved in', dir);
} finally {
  b.close();
}
