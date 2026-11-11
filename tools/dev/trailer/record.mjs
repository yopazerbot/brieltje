// Records the footage for the Zombies trailer (Yoshi, 11 Nov 2026: "Record it ... show multiple players engaging
// zombies", then: "take some different angles, different guns"): four players that play by themselves (lib.mjs BOT)
// in a Zombies game on a throwaway game server, filmed by two cameras at once: the first player's own eyes, with
// the game's sound, and the admin's watch page, whose camera a director moves (lib.mjs CINE): over the players'
// shoulders, from the side, from the front, from above, circling, always turned to the fight.
// Each scene's frames land in <out>/<scene>/<eyes|watch>/, its sound in <out>/<scene>/sound.webm, and scenes.json
// says what was shot. tools/dev/trailer/edit.mjs cuts the trailer from them.
//
//   a game server on this computer (a build, or lan/compose.yaml) on <api port>, and a dev server in front of it:
//     API_PORT=8190 npx vite --port 5300 --strictPort          (in web/)
//   ADMIN_PASSWORD=... node tools/dev/trailer/record.mjs --out <folder> [--only dusk,snow] [--tag x]
//       [--url http://localhost:5300/] [--api http://localhost:8190]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options } from '../cdp.mjs';
import { admin, BOT, CINE, CLEAN_CSS, css, player, record, size, sleep } from './lib.mjs';

const o = options({ url: 'http://localhost:5300/', api: 'http://localhost:8190', out: '', only: '', ports: '9411', tag: '' });
localOnly(o.url, '--url');
localOnly(o.api);
if (!o.out) throw new Error('--out <folder> is needed');
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
mkdirSync(o.out, { recursive: true });

// The guns. Zombies starts everyone with the pistol; the server gives another gun only to who walks over one lying
// on the map (shared/pickups.json, by its number there), and the game's edge keeps players at the place. So each
// player fetches the place's gun as a game begins, in turn: one comes back 20 s after it was taken.
// `guns`: per player the pickup to take, or null for the pistol.
// `away`: the players' post from where the game puts them (metres east, south): off the portal's ring, on open
// ground with the place's landmark behind (scouted with a turn on the spot at each place).
const PLACES = {
  church: { guns: [4, 4, 4, 4], away: [-3.5, 7] }, // the rifle by the church; out on the square
  sparrenhof: { guns: [11, null, null, null], away: [7.5, 9] }, // a sniper rifle; the cafe's forecourt
  bungalow: { guns: [3, 3, null, null], away: [0, 0] }, // the shotgun
  house: { guns: [0, 0, 0, 0], away: [0, -6] }, // the rifle in the carport; the lawn behind the house
};
// How each gun is fired: the wait between shots (ms) and from how near (m), so the zombies come into the picture first.
const FIRE = { pistol: [330, 9], rifle: [170, 10], shotgun: [850, 7], sniper: [1500, 24] };
// The players stand together where the game put them (there the zombies come to them): these steps apart.
const STEPS = [[0, 0], [2.2, 0.8], [-2.2, 0.8], [0.3, 2.6]];
/**
 * The scenes: the place, the weather, the wave, `pistols` to leave the fetched guns slung, and `at`: what happens
 * during the take, seconds in: the director's camera ('over', 'side', 'front', 'high', 'orbit', or null for the
 * watch page's own view behind a player) and a grenade from the first player.
 */
const SCENES = [
  { name: 'dusk', place: 'church', mood: 'dusk', wave: 3, pistols: true, secs: 36, lead: 10, at: [[0, 'cine', 'over'], [9, 'cine', 'zombie'], [18, 'cine', 'side'], [27, 'cine', 'front']] },
  { name: 'runners', place: 'church', mood: 'sunny', wave: 6, secs: 38, lead: 9, at: [[0, 'cine', 'high'], [9, 'cine', 'over'], [18, 'cine', 'zombie'], [28, 'cine', 'orbit']] },
  { name: 'night', place: 'church', mood: 'night', wave: 10, secs: 40, lead: 9, at: [[0, 'cine', 'over'], [10, 'cine', 'zombie'], [14, 'grenade'], [20, 'cine', 'side'], [30, 'cine', 'orbit']] },
  { name: 'wood', place: 'sparrenhof', mood: 'overcast', wave: 6, secs: 40, lead: 10, at: [[0, 'cine', 'orbit'], [10, 'cine', 'over'], [20, 'cine', 'zombie'], [22, 'grenade'], [30, 'cine', 'high']] },
  { name: 'rain', place: 'bungalow', mood: 'rain', wave: 7, secs: 40, lead: 9, at: [[0, 'cine', 'over'], [10, 'cine', 'front'], [16, 'grenade'], [20, 'cine', 'zombie'], [30, 'cine', 'side']] },
  { name: 'snow', place: 'house', mood: 'snow', wave: 9, secs: 42, lead: 8, at: [[0, 'cine', 'high'], [9, 'cine', 'zombie'], [10, 'grenade'], [18, 'cine', 'over'], [22, 'grenade'], [28, 'cine', 'orbit'], [36, 'cine', 'front']] },
];
const only = o.only ? o.only.split(',') : null;

// A guest's name stays taken for the day: --tag x makes them Vosx ...; without it the server must be a fresh one.
const NAMES = ['Vos', 'Uil', 'Das', 'Mus'].map((n) => n + o.tag);
const base = Number(o.ports);
const browsers = [];
const log = existsSync(join(o.out, 'scenes.json')) ? JSON.parse(readFileSync(join(o.out, 'scenes.json'), 'utf8')) : {};

try {
  // The players: the first is filmed through its own eyes (full picture, its sound recorded), the others small.
  const players = await Promise.all(NAMES.map((name, i) =>
    player({ url: o.url, port: base + i, name, sound: i === 0, graphics: i === 0 ? 'high' : 'low', ...(i === 0 ? { width: 1920, height: 1080 } : { width: 640, height: 360 }) })));
  browsers.push(...players);
  const eyes = players[0];
  await size(eyes, 1920, 1080);
  await css(eyes, CLEAN_CSS);
  for (const p of players) await p.evaluate(BOT, false);
  console.log('players in:', NAMES.join(', '), 'browser PIDs:', players.map((p) => p.pid).join(', '));

  // The watch page, under the admin's session: one view, its bar and pickers out of the picture.
  let a = await admin(o.api, password);
  const w = await launch({ port: base + 4, width: 1920, height: 1080, extra: ['--hide-scrollbars', '--force-device-scale-factor=1'] });
  browsers.push(w);
  console.log('watch page browser PID:', w.pid);
  await size(w, 1920, 1080);
  for (const c of a.cookie.split('; ')) {
    const i = c.indexOf('=');
    await w.send('Network.setCookie', { name: c.slice(0, i), value: c.slice(i + 1), url: o.url, httpOnly: true, sameSite: 'Strict' });
  }
  await w.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','high');localStorage.setItem('briel.lang','en');" });
  await w.send('Page.navigate', { url: new URL('/admin/watch/index.html', o.url).href });
  await w.waitFor("!!document.querySelector('iframe')", 60000);
  // The dev server answers /admin/watch/ with the game itself, so the page came in by its file's name; a view only
  // watches inside /admin/watch/ (src/watch.ts), so the address is put right and the view loaded again.
  await w.evaluate("history.replaceState(null, '', '/admin/watch/'); document.querySelector('iframe').contentWindow.location.reload()", false);
  await sleep(1500);
  await css(w, '#bar, .bar, .controls, .note { display: none !important; } .tiles, #tiles { inset: 0 !important; padding: 0 !important; gap: 0 !important; } .tile, iframe { border: 0 !important; border-radius: 0 !important; }');
  await w.waitFor("(() => { try { return !!document.querySelector('iframe').contentWindow.briel; } catch { return false; } })()", 240000);
  await w.evaluate(`(() => { const d = document.querySelector('iframe').contentDocument; const s = d.createElement('style'); s.textContent = ${JSON.stringify(CLEAN_CSS + ' #watch-tag { display: none !important; }')}; d.head.append(s); })()`, false);
  // The director, inside the view (the game's own page): it moves that page's camera just before each frame is drawn.
  console.log('director:', await w.evaluate(`document.querySelector('iframe').contentWindow.eval(${JSON.stringify(CINE)})`, false));
  const cine = (mode) => w.evaluate(`document.querySelector('iframe').contentWindow.__cine.mode = ${JSON.stringify(mode)}`, false);
  const follow = (name, mode) => w.evaluate(`(() => {
    const t = document.querySelector('.tile');
    const s = t.querySelector('select');
    const n = [...s.options].find((x) => x.value.startsWith(${JSON.stringify(name)}));
    if (n) { s.value = n.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
    t.querySelector('[data-mode=${mode}]').click();
    return !!n;
  })()`, false);

  let place = '';
  let homes = [];
  let guns = [];
  for (const sc of SCENES) {
    if (only && !only.includes(sc.name)) continue;
    console.log(`\n== ${sc.name}: ${sc.place}, ${sc.mood}, wave ${sc.wave}`);
    if (a.closed) a = await admin(o.api, password);
    if (place !== sc.place) {
      if (place) { a.free(); await sleep(3500); }
      a.zombies(sc.place);
      place = sc.place;
      await sleep(4000);
      // Where the game put the first player: everyone's post is a step or two from there.
      const at = await eyes.evaluate('({ x: briel.player.x, z: briel.player.z, feet: briel.player.feet })', false);
      const [ax, az] = PLACES[sc.place].away;
      homes = STEPS.map(([dx, dz]) => [at.x + ax + dx, at.z + az + dz, at.feet]);
      guns = [];
      for (const [i, p] of players.entries()) {
        const spot = PLACES[sc.place].guns[i];
        guns.push(spot === null ? 'pistol' : await p.evaluate(`(async () => {
          __bot.on = false;
          const s = briel.pickups.spots[${spot}];
          const o = () => briel.weapon.owned;
          const has = () => (o() instanceof Set ? o().has(s.w) : Array.isArray(o()) ? o().includes(s.w) : !!o()?.[s.w]);
          briel.weapon.setEnabled(true);
          for (let t = 0; t < 400 && !has(); t++) {
            if (t % 10 === 0) briel.teleport(s.x, s.z, s.y + 0.05, briel.player.yaw, 0);
            await new Promise((r) => setTimeout(r, 100));
          }
          briel.teleport(${homes[i][0]}, ${homes[i][1]}, ${homes[i][2]} + 0.3, briel.player.yaw, 0); // out of the next one's way
          return has() ? s.w : 'pistol';
        })()`));
      }
      console.log('guns:', guns.join(', '), 'posts round', homes[0].map((v) => Math.round(v)).join(', '));
    }
    a.send({ t: 'mood', mood: sc.mood });
    // Everyone to their post with their gun; the wave only then.
    const held = guns.map((g) => (sc.pistols ? 'pistol' : g));
    for (let i = 0; i < players.length; i++) {
      await players[i].evaluate(`(() => {
        briel.teleport(${homes[i][0]}, ${homes[i][1]}, ${homes[i][2]} + 0.3, briel.player.yaw, 0);
        briel.weapon.setEnabled(true);
        briel.weapon.select(${JSON.stringify(held[i])});
        Object.assign(__bot, { on: true, home: [${homes[i][0]}, ${homes[i][1]}], look: null, aim: ${held[i] === 'sniper'}, cadence: ${FIRE[held[i]][0]}, range: ${FIRE[held[i]][1]} });
      })()`, false);
    }
    await sleep(1500);
    if (sc.wave > 0) a.wave(sc.wave);
    await follow('Das', 'behind');
    await cine(null);
    await sleep(600);
    a.close();
    a.closed = true; // the admin stands in nobody's picture
    await sleep(sc.lead * 1000);

    const dir = join(o.out, sc.name);
    const stopEyes = await record(eyes, join(dir, 'eyes'), { quality: 88, everyNth: 2 });
    const stopWatch = await record(w, join(dir, 'watch'), { quality: 88, everyNth: 2 });
    const soundAt = await eyes.evaluate('window.__audio.start()', false);
    const t0 = Date.now();
    for (const [t, what, arg] of sc.at ?? []) {
      await sleep(Math.max(0, t * 1000 - (Date.now() - t0)));
      if (what === 'cine') await cine(arg);
      if (what === 'grenade') await eyes.evaluate('briel.throwGrenade()', false);
    }
    await sleep(Math.max(0, sc.secs * 1000 - (Date.now() - t0)));
    const sound = await eyes.evaluate('window.__audio.stop()');
    writeFileSync(join(dir, 'sound.webm'), Buffer.from(sound, 'base64'));
    const [e, v] = [await stopEyes(), await stopWatch()];
    const state = await eyes.evaluate(`({ alive: briel.combat.alive, hp: briel.combat.hp, aim: +(briel.weapon.aim?.toFixed?.(2) ?? 0), zs: [...briel.zombies.zs.values()].filter((z) => z.hp > 0).length, shots: __bot.shots, beaten: briel.combat.zombies?.beaten, down: briel.combat.zombies?.down })`, false);
    log[sc.name] = { ...sc, guns: held, eyes: e, watch: v, soundAt: soundAt / 1000, state };
    writeFileSync(join(o.out, 'scenes.json'), JSON.stringify(log, null, 1));
    console.log(`eyes ${e.frames} frames (${e.fps.toFixed(1)} a second), watch ${v.frames} (${v.fps.toFixed(1)}), guns ${held.join('/')}`, JSON.stringify(state));
  }
  if (a.closed) a = await admin(o.api, password);
  a.free();
  await sleep(500);
  a.close();
} finally {
  for (const b of browsers) b.close();
}
