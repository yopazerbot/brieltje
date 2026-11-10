// Pictures of the villagers from close by, headless (tools/dev/cdp.mjs): one of each kind that is out, and the square.
//
//   node tools/dev/villagers.mjs <out-dir> [--url http://localhost:5200/] [--travel church] [--quality high] [--port 9344]
//
// Goes to a busy place, waits for the villagers, then stands 2.6 m in front of the nearest one of each kind and
// looks at it (briel.villagers.states(), briel.teleport). Prints how many are out and each one's clip.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', travel: 'church', quality: '', port: '9344' });
const dir = o._[0];
if (!dir) throw new Error('usage: node tools/dev/villagers.mjs <out-dir> [options]');
mkdirSync(dir, { recursive: true });
const b = await launch({ port: Number(o.port) });
try {
  await startGame(b, o.url, { village: true });
  if (o.quality) await b.evaluate(`briel.three.applyQuality(${JSON.stringify(o.quality)})`, false);
  await b.evaluate(`briel.travel(${JSON.stringify(o.travel)})`, false);
  let n = 0;
  for (let i = 0; i < 40 && n < 6; i++) {
    await b.sleep(1000);
    n = await b.evaluate('briel.villagers.states().filter((v) => v.fade > 0.9).length');
  }
  console.log('villagers out:', n);
  await b.screenshot(join(dir, 'square.png'));
  const kinds = ['man', 'woman', 'elder', 'teen', 'child', 'cyclist', 'dog'];
  for (const kind of kinds) {
    // The nearest one of this kind, and a place in front of it (it faces where it goes: we stand a little to its side).
    const at = await b.evaluate(`(() => {
      const p = briel.player;
      const all = briel.villagers.states().filter((v) => v.kind === ${JSON.stringify(kind)} && v.fade > 0.9);
      if (!all.length) return null;
      all.sort((a, c) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(c.x - p.x, c.z - p.z));
      const v = all[0];
      return { x: v.x, y: v.y, z: v.z, clip: v.clip, mode: v.mode };
    })()`);
    if (!at) {
      console.log(kind, 'none out');
      continue;
    }
    for (const [label, ang, far] of [['a', 0.6, 2.6], ['b', 2.4, 2.2]]) {
      const v = await b.evaluate(`(() => {
        const all = briel.villagers.states().filter((v) => v.kind === ${JSON.stringify(kind)} && v.fade > 0.9);
        all.sort((a, c) => Math.hypot(a.x - ${at.x}, a.z - ${at.z}) - Math.hypot(c.x - ${at.x}, c.z - ${at.z}));
        const v = all[0];
        const ex = v.x + Math.sin(${ang}) * ${far}, ez = v.z + Math.cos(${ang}) * ${far};
        briel.player.flying = true;
        briel.teleport(ex, ez, v.y + 0.25, Math.atan2(ex - v.x, ez - v.z), -0.02);
        return { x: v.x, z: v.z, clip: v.clip };
      })()`);
      await b.sleep(350);
      await b.screenshot(join(dir, `${kind}-${label}.png`));
      console.log(kind, label, v.clip);
    }
  }
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no errors on the page');
} finally {
  await b.close();
}
