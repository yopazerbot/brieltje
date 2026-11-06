// The homes' insides in the running game, headless (tools/dev/cdp.mjs): alone, a home shows its shell only, the right code
// brings its inside, the admin has all of them. Pictures go to --out.
//
//   node tools/dev/homes_check.mjs --url http://localhost:5450/ --api http://localhost:8450 --out <folder> [--phone] [--quality low] [--admin]
//
// The admin's password is read from the environment (ADMIN_PASSWORD), never printed. The page must be the dev build
// (window.briel), with its /api proxied to --api (API_PORT=8450 npx vite --port 5450), the server a throwaway one on your own port.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5450/', api: 'http://localhost:8450', out: '', port: '9450', phone: false, quality: '', admin: false });
if (!o.out) throw new Error('usage: --out <folder>');
mkdirSync(o.out, { recursive: true });
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');

// The admin makes the codes (the page's own browser is not logged in: it plays alone).
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(o.api + path, { method, headers: { 'Content-Type': 'application/json', Origin: o.api, Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => null) };
};
const login = await call('POST', '/api/login', { username: 'admin', password });
const cookie = login.r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const codes = {};
for (const id of ['house', 'bungalow', 'molenhoek_end']) codes[id] = (await call('POST', `/api/admin/homes/${id}/code`, {}, cookie)).data.code;

const b = await launch({ port: Number(o.port) });
const ok = (name, pass, extra = '') => console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} ${extra}`);
try {
  await startGame(b, o.url, { phone: o.phone, village: true });
  if (o.quality) await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)})`, false);
  const ev = (e) => b.evaluate(e);
  const shot = async (name, x, z, feet, yaw, pitch = 0) => {
    await b.evaluate(`briel.teleport(${x}, ${z}, ${feet}, ${yaw}, ${pitch})`, false);
    await b.sleep(1500);
    await b.screenshot(join(o.out, name + '.png'));
  };
  // The spots come from the data, not from this file: a window of the shell, and rooms of the packs (the admin may fetch them).
  const shell = JSON.parse(readFileSync(new URL('../../web/src/data/house_shell.json', import.meta.url), 'utf8'));
  const endShell = JSON.parse(readFileSync(new URL('../../web/src/data/molenhoek_end_shell.json', import.meta.url), 'utf8'));
  const packOf = async (id) => (await call('GET', `/api/home/${id}/inside`, undefined, cookie)).data;
  const centroid = (ring) => [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length];
  const west = shell.prisms.filter((p) => p.m === 'glass' && p.y0 < 2).map((p) => ({ p, c: centroid(p.p[0]) })).sort((x, y) => x.c[0] - y.c[0])[0];
  const housePack = await packOf('house');
  const bungalowPack = await packOf('bungalow');
  const levelFloor = Object.fromEntries(shell.levels.map((l) => [l.id, l.floor]));
  const rooms = ['gf', 'f1'].map((level) => housePack.rooms.find((r) => r.level === level)).filter(Boolean);
  const bungalowFloor = bungalowPack.prisms.find((p) => /floor/.test(p.m) && p.m.startsWith('old_'));
  if (o.admin) {
    // The admin sees every inside without a code: the page logs in (the cookie is set for this page), then takes the admin's role.
    const body = JSON.stringify({ username: 'admin', password });
    const login2 = await ev(`fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(body)} }).then((r) => r.status)`);
    ok('the page logged in as the admin', login2 === 200, String(login2));
    await b.evaluate('briel.homeLocks.setAdmin(true)', false);
    await b.sleep(4000);
    ok('the admin has all three insides', (await ev('briel.insides.packs.size')) === 3, String(await ev('briel.insides.packs.size')));
    await shot('admin-house-inside', ...centroid(rooms[0].p[0]), levelFloor[rooms[0].level] + 0.05, 0.6, 0.0);
    const errs = b.logs.filter((l) => /^(error|exception)/.test(l));
    ok('no console errors', errs.length === 0, errs.slice(0, 5).join(' | '));
    process.exit(0);
  }
  // 1. Alone, nothing is open: no inside installed, the shell from outside.
  ok('no inside installed at the start', (await ev('briel.insides.packs.size')) === 0);
  await shot('house-outside', shell.spawn.x, shell.spawn.z, -0.1, 0, 0.05);
  await shot('house-window-locked', west.c[0] - 1.4, west.c[1], -0.1, -Math.PI / 2, 0.0);
  // 2. The right code of the main house installs its inside.
  const msg = await ev(`briel.homeLocks.unlock('house', ${JSON.stringify(codes.house)})`);
  ok('main house unlocked', msg === '', String(msg));
  await b.sleep(2500);
  ok('main house inside installed', (await ev("briel.insides.packs.has('house')")) === true);
  await shot('house-window-open', west.c[0] - 1.4, west.c[1], -0.1, -Math.PI / 2, 0.0);
  for (const r of rooms) {
    const [x, z] = centroid(r.p[0]);
    await shot(`house-inside-${r.level}`, x, z, levelFloor[r.level] + 0.05, 0.6, 0.0);
  }
  // 3. The bungalow, wrong code first.
  ok('wrong code refused', (await ev(`briel.homeLocks.unlock('bungalow', 'AAAAA-AAAAA')`)) !== '');
  ok('bungalow unlocked', (await ev(`briel.homeLocks.unlock('bungalow', ${JSON.stringify(codes.bungalow)})`)) === '');
  await b.sleep(2500);
  if (bungalowFloor) await shot('bungalow-inside', ...centroid(bungalowFloor.p[0]), bungalowFloor.y1 + 0.05, 0.8, 0.0);
  // 4. The end house.
  ok('end house unlocked', (await ev(`briel.homeLocks.unlock('molenhoek_end', ${JSON.stringify(codes.molenhoek_end)})`)) === '');
  await b.sleep(3000);
  await shot('end-house-outside', endShell.centre[0] + 3, endShell.centre[1] + 14, endShell.frame.floor - 0.1, 3.0, 0.05);
  await shot('end-house-inside', endShell.centre[0], endShell.centre[1], endShell.frame.floor + 0.1, 0.5, 0.0);
  // 5. The Zombies game alone starts at the house (its grid is built from the shell and the installed insides).
  await b.evaluate("briel.zombiesSolo.start('house')", false);
  await b.sleep(4000);
  ok('zombies started alone', (await ev('!!briel.zombiesSolo.state()')) === true);
  await b.evaluate('briel.zombiesSolo.stop()', false);
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  ok('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} finally {
  b.close();
}
