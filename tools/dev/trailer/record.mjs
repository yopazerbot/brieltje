// Records the footage for the Zombies trailer (Yoshi, 11 Nov 2026: "Record it ... show multiple players engaging
// zombies"): four players that play by themselves (lib.mjs BOT) in a Zombies game on a throwaway game server, filmed
// by two cameras at once: one player's own eyes, with the game's sound, and the admin's watch page behind another.
// Each scene's frames land in <out>/<scene>/<eyes|watch>/, its sound in <out>/<scene>/sound.webm, and scenes.json
// says what was shot. tools/dev/trailer/edit.mjs cuts the trailer from them.
//
//   a game server on this computer (a build, or lan/compose.yaml) on <api port>, and a dev server in front of it:
//     API_PORT=8190 npx vite --port 5300 --strictPort          (in web/)
//   ADMIN_PASSWORD=... node tools/dev/trailer/record.mjs --out <folder> [--only church_runners,finale]
//       [--url http://localhost:5300/] [--api http://localhost:8190]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, localOnly, options } from '../cdp.mjs';
import { admin, BOT, CLEAN_CSS, css, player, record, size, sleep } from './lib.mjs';

const o = options({ url: 'http://localhost:5300/', api: 'http://localhost:8190', out: '', only: '', ports: '9411', tag: '' });
localOnly(o.url, '--url');
localOnly(o.api);
if (!o.out) throw new Error('--out <folder> is needed');
const password = process.env.ADMIN_PASSWORD;
if (!password) throw new Error('ADMIN_PASSWORD is not set');
mkdirSync(o.out, { recursive: true });

// Where each place is fought: the middle of its arena (shared/arenas.mjs), the players round it.
// Molenhoek's end by default: there the zombies come up an open street to the players. On the church square they
// hang back round a corner, out of the picture.
const PLACES = { church: [548, -768], molenhoek_end: [1507, -365] };
/**
 * The scenes. `posts`: each player's spot from the place's middle (metres east, south); `weapons` by player;
 * `watch`: whom the watch page follows, and how; `at`: things done during the take, seconds in.
 */
const SCENES = [
  { name: 'dusk', mood: 'dusk', wave: 2, secs: 30, lead: 6, weapons: ['pistol', 'pistol', 'pistol', 'pistol'], watch: ['Das', 'behind'], at: [[15, 'watch', ['Uil', 'behind']]] },
  { name: 'runners', mood: 'sunny', wave: 4, secs: 32, lead: 5, weapons: ['rifle', 'rifle', 'rifle', 'rifle'], watch: ['Mus', 'behind'], at: [[11, 'watch', ['Uil', 'behind']], [22, 'watch', ['Das', 'eyes']]] },
  { name: 'big', mood: 'night', wave: 5, secs: 36, lead: 5, weapons: ['rifle', 'rifle', 'rifle', 'rifle'], watch: ['Das', 'behind'], at: [[12, 'grenade'], [13, 'watch', ['Mus', 'behind']], [25, 'watch', ['Uil', 'eyes']]] },
  { name: 'rain', mood: 'rain', wave: 8, secs: 34, lead: 5, weapons: ['rifle', 'rifle', 'rifle', 'rifle'], watch: ['Das', 'behind'], at: [[10, 'grenade'], [12, 'watch', ['Mus', 'behind']], [24, 'watch', ['Uil', 'eyes']]] },
  { name: 'snow', mood: 'snow', wave: 12, secs: 38, lead: 4, weapons: ['rifle', 'rifle', 'rifle', 'rifle'], watch: ['Uil', 'behind'], at: [[8, 'grenade'], [12, 'watch', ['Das', 'behind']], [18, 'grenade'], [26, 'watch', ['Mus', 'eyes']]] },
].map((sc) => ({ place: 'molenhoek_end', ...sc }));
const POSTS = [[0, 0], [4, 1], [-4, 1], [0, 5]]; // round the place's rifle: open street, the zombies come up it
// Zombies starts everyone with the pistol; the server gives another gun only to who walks over one lying on the map
// (shared/pickups.json, by its number there), and the game's edge keeps players at the place. So the players take
// the place's own rifle in turn as a game begins: it comes back 20 s after it was taken.
const RIFLE = { church: 4, molenhoek_end: 8 };
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
  const follow = (name, mode) => w.evaluate(`(() => {
    const t = document.querySelector('.tile');
    const s = t.querySelector('select');
    const n = [...s.options].find((x) => x.value.startsWith(${JSON.stringify(name)}));
    if (n) { s.value = n.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
    t.querySelector('[data-mode=${mode}]').click();
    return !!n;
  })()`, false);

  let place = '';
  for (const sc of SCENES) {
    if (only && !only.includes(sc.name)) continue;
    console.log(`\n== ${sc.name}: ${sc.place}, ${sc.mood}, wave ${sc.wave}`);
    if (a.closed) a = await admin(o.api, password);
    if (place !== sc.place) {
      if (place) { a.free(); await sleep(3500); }
      a.zombies(sc.place);
      place = sc.place;
      await sleep(4000);
      const got = [];
      for (const p of players) {
        got.push(await p.evaluate(`(async () => {
          __bot.on = false;
          const s = briel.pickups.spots[${RIFLE[sc.place]}];
          const o = () => briel.weapon.owned;
          const has = () => (o() instanceof Set ? o().has(s.w) : Array.isArray(o()) ? o().includes(s.w) : !!o()?.[s.w]);
          briel.weapon.setEnabled(true);
          for (let t = 0; t < 260 && !has(); t++) {
            if (t % 10 === 0) briel.teleport(s.x, s.z, s.y + 0.05, briel.player.yaw, 0);
            await new Promise((r) => setTimeout(r, 100));
          }
          briel.teleport(s.x + 3 + Math.random() * 3, s.z + 3, s.y + 0.05, briel.player.yaw, 0); // out of the next one's way
          return s.w + (has() ? '' : ' NOT TAKEN');
        })()`));
      }
      console.log('guns:', got.join(', '));
    }
    a.send({ t: 'mood', mood: sc.mood });
    // Everyone to their post, facing out, with their gun; the wave only then.
    const [cx, cz] = PLACES[sc.place];
    for (let i = 0; i < players.length; i++) {
      const [dx, dz] = (sc.posts ?? POSTS)[i];
      await players[i].evaluate(`(() => {
        const p = briel.player;
        briel.teleport(${cx + dx}, ${cz + dz}, p.feet + 0.2, p.yaw, 0);
        briel.weapon.setEnabled(true);
        briel.weapon.select(${JSON.stringify(sc.weapons[i])});
        Object.assign(__bot, { on: true, home: [${cx + dx}, ${cz + dz}], look: [${cx + dx * 8}, ${cz - 30}], cadence: ${{ rifle: 150, shotgun: 800, sniper: 1400, pistol: 380 }[sc.weapons[i]]} });
      })()`, false);
    }
    await sleep(1500);
    if (sc.wave > 0) a.wave(sc.wave);
    await follow(sc.watch[0], sc.watch[1]);
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
      if (what === 'watch') await follow(arg[0], arg[1]);
      if (what === 'grenade') await eyes.evaluate('briel.throwGrenade()', false);
    }
    await sleep(Math.max(0, sc.secs * 1000 - (Date.now() - t0)));
    const sound = await eyes.evaluate('window.__audio.stop()');
    writeFileSync(join(dir, 'sound.webm'), Buffer.from(sound, 'base64'));
    const [e, v] = [await stopEyes(), await stopWatch()];
    const state = await eyes.evaluate(`({ alive: briel.combat.alive, hp: briel.combat.hp, zs: [...briel.zombies.zs.values()].filter((z) => z.hp > 0).length, hps: [...briel.zombies.zs.values()].map((z) => z.hp).slice(0, 12), marks: [...document.querySelectorAll('#hud *')].filter((e) => !e.children.length && /\d m$/.test(e.textContent)).map((e) => e.className + '|' + e.parentElement.className + '|' + e.parentElement.id).slice(0, 3), shots: __bot.shots, z: briel.combat.zombies })`, false);
    log[sc.name] = { ...sc, eyes: e, watch: v, soundAt: soundAt / 1000, state };
    writeFileSync(join(o.out, 'scenes.json'), JSON.stringify(log, null, 1));
    console.log(`eyes ${e.frames} frames (${e.fps.toFixed(1)} a second), watch ${v.frames} (${v.fps.toFixed(1)}), sound ${(sound.length * 0.75 / 1024) | 0} KB`, JSON.stringify(state).slice(0, 300));
  }
  if (a.closed) a = await admin(o.api, password);
  a.free();
  await sleep(500);
  a.close();
} finally {
  for (const b of browsers) b.close();
}
