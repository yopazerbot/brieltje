// Do shots hit the zombies? A Zombies game alone at a place, headless (tools/dev/cdp.mjs, the dev server for
// window.briel): stand 6 m from the nearest zombie, look at its chest, fire, and see whether its health dropped.
//
//   node tools/dev/zombieHits.mjs [--url http://localhost:5200/] [--place house] [--shots 40] [--port 9342]
//
// Prints the shots, the hits and the zombies beaten. Nearly every shot should hit: none at all means the shots go
// through the zombies' hit boxes (world/rayShown.ts drawn, and its test). Exits 1 when no shot hit.
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', place: 'house', shots: '40', weapon: '', port: '9342' });
const b = await launch({ port: Number(o.port), width: 1280, height: 720 });
let hits = 0;
try {
  await startGame(b, o.url, { village: true });
  await b.evaluate(`briel.zombiesSolo.start(${JSON.stringify(o.place)})`, false);
  await b.waitFor('(briel.zombiesSolo.state()?.horde.zombies.size ?? 0) > 0', 90000);
  await b.sleep(3000); // the first wave on its way
  // --weapon sniper: with that gun (its bullet flies; from the hip it is wide, so fewer land).
  if (o.weapon) await b.evaluate(`briel.weapon.give(${JSON.stringify(o.weapon)}); briel.weapon.select(${JSON.stringify(o.weapon)})`, false);
  let shots = 0;
  let beaten = 0;
  // Aim and fire in one go (the zombie can't step aside in between); a press while reloading fires nothing and
  // doesn't count.
  for (let tries = 0; shots < Number(o.shots) && tries < Number(o.shots) * 4; tries++) {
    const aim = await b.evaluate(`(() => {
      const s = briel.zombiesSolo.state();
      const p = briel.player;
      const list = [...s.horde.zombies.values()].filter((z) => z.hp > 0);
      if (!list.length) return null;
      const z = list.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      const d = Math.hypot(z.x - p.x, z.z - p.z) || 1;
      const x = z.x - ((z.x - p.x) / d) * 6;
      const zz = z.z - ((z.z - p.z) / d) * 6;
      briel.teleport(x, zz, z.y, Math.atan2(-(z.x - x), -(z.z - zz)), Math.atan2(1.2 - 1.6, 6));
      const w = briel.weapon;
      const ammo = w.ammo[w.current];
      const hp = z.hp; // before the shot: a hit counts at once
      briel.fire();
      return { id: z.id, hp, fired: w.ammo[w.current] < ammo };
    })()`, false);
    if (!aim) break; // none left standing
    if (!aim.fired) {
      await b.sleep(500);
      continue;
    }
    shots++;
    await b.sleep(400);
    const hp = await b.evaluate(`briel.zombiesSolo.state().horde.zombies.get(${aim.id})?.hp ?? -1`, false);
    if (hp < aim.hp) hits++;
    if (hp <= 0) beaten++;
  }
  console.log(`${o.place}: ${shots} shots, ${hits} hits, ${beaten} beaten`);
} finally {
  b.close();
}
process.exitCode = hits > 0 ? 0 : 1;
