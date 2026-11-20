// The Zombies horde as a group meets it, in numbers: scripted players fight it out at each Zombies place, much faster
// than real time, on the grid the server builds (server/game.mjs zombieGround) with the horde the server runs
// (shared/zombies.mjs Horde), so a rule's change shows per player count before it goes live.
//
// The players stand where the server puts them at the start (round the house's outside start places, or round the
// portal), or inside the café at the church (place `cafe`). Each is simple and follows its own seeded dice (--seed):
// it looks for the nearest zombie it can see within 40 m, takes a moment to aim, fires the rifle in bursts at a
// person's rate with a person's aim (fewer hits further off; a head shot now and then; a reload after 30 rounds),
// steps back from a zombie that comes too close, and wanders a little round its start. A swipe takes its health; at 0
// it is down until the wave is beaten (back at its start, as the server's revive), or helped up by a teammate close by
// when no zombie is near (at 50). When every player is down at once, the game is over. No stall, no rewards, no
// grenades: the same for every rule compared, so the difference is the horde's.
//
// What it reports, per place and player count, per wave and over the game (averaged over the seeds):
//   alive    zombies up at once (mean, and the most)
//   near     zombies within 15 m of a player and in that player's sight at once (mean, and the most)
//   view     zombies in some player's sight at once (within 40 m: what the group has to shoot at), mean
//   viewP    zombies one player has in sight at once, mean over the players up (how busy each is)
//   sight    s from where a zombie comes out until a player first sees it (median)
//   seen     s from where it comes out until a player first sees it within 15 m (median)
//   walk     s from where a zombie comes out until it first stands within a swipe of a player (median)
//   idle     share of the time a player up sees nothing to shoot at (no zombie in sight within 40 m)
//   len      s a wave lasts
//   downs    players down in the wave
//   group    zombies that come into the players' sight within 2.5 s of one another, on average (1: one at a time)
//   sides    share of the time with zombies in sight that they stand on more than one side (spread over more than a
//            quarter turn round the players)
//   spawnD   m from the nearest player where zombies come out (median); inSight: how many came out in a player's sight
//            (both outdoors: through a house's doors and windows this tool can't tell; in the Sparrenhof's wood the rule
//            lets them come out between the trees in sight)
//   stuck    zombies that stood still 5 s or more with no player within 3 m (behind a house, at a wall)
//   rehomed  zombies with no way to the players that the horde brought out afresh elsewhere (Horde.rehome)
//   wave     the wave the game ended in (the highest when --max-wave stopped it)
//   tick     ms the horde's own step took on average (this computer; the server runs it 20 times a second per room)
//
//   cd web && node ../tools/dev/horde_sim.mjs [--places church,house,bungalow,sparrenhof,cafe] [--players 1,4,8,15]
//        [--seeds 3] [--seed 1] [--max-wave 30] [--skill 1] [--horde <path to a zombies.mjs>] [--json <file>] [--waves]
// --horde: another version of the shared simulation to compare (for example main's: git show main:web/shared/zombies.mjs
//   > <scratch>/zombies_main.mjs); the grid is always this checkout's. --skill: the players' aim, 1 an average group.
// --waves: the table per wave too (else per game, and waves 1, 3, 5 and 10).
// --compare <before.json> <after.json> [--wave n]: two runs' --json side by side, before / after, per place and
//   player count (over the whole game, or wave n), as a Markdown table; nothing is simulated.
// Nothing leaves this computer; no server is started and nothing is written but --json.
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
if (args.includes('--compare')) {
  const i = args.indexOf('--compare');
  const [a, b] = [args[i + 1], args[i + 2]].map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const wave = opt('wave', null);
  const keys = [['reached', 'wave reached'], ['alive', 'alive'], ['view', 'in sight'], ['viewP', 'per player'], ['near', 'within 15 m'], ['sight', 's to sight'], ['walk', 's to a player'], ['idle', 'nothing to shoot'], ['len', 'wave s'], ['downs', 'downs'], ['group', 'group'], ['sides', '2+ sides'], ['spawnD', 'out at m']];
  console.log(`| place | players | ${keys.map((k) => k[1]).join(' | ')} |`);
  console.log(`|${'---|'.repeat(keys.length + 2)}`);
  for (const r of a.results) {
    const s = b.results.find((q) => q.place === r.place && q.players === r.players);
    if (!s) continue;
    const of = (x) => (wave ? x.perWave[wave] : x.summary) ?? {};
    const cell = (k) => {
      if (k === 'reached') return `${(r.reached.reduce((p, q) => p + q, 0) / r.reached.length).toFixed(1)} / ${(s.reached.reduce((p, q) => p + q, 0) / s.reached.length).toFixed(1)}`;
      return `${of(r)[k] ?? '-'} / ${of(s)[k] ?? '-'}`;
    };
    console.log(`| ${r.place} | ${r.players} | ${keys.map(([k]) => cell(k)).join(' | ')} |`);
  }
  process.exit(0);
}
const PLACES = opt('places', 'church,house,bungalow,sparrenhof,cafe').split(',');
const COUNTS = opt('players', '1,4,8,15').split(',').map(Number);
const SEEDS = Number(opt('seeds', 3));
const SEED0 = Number(opt('seed', 1));
const MAX_WAVE = Number(opt('max-wave', 30));
const SKILL = Number(opt('skill', 1));
const JSON_OUT = opt('json', null);
const PER_WAVE = args.includes('--waves');
const web = new URL('../../web/', import.meta.url);

const silence = console.log;
console.log = () => {}; // the server's start-up lines
const { Game } = await import(new URL('server/game.mjs', web));
const { arenaOf, portalOf } = await import(new URL('shared/arenas.mjs', web));
const SPAWNS = (await import(new URL('shared/spawns.json', web), { with: { type: 'json' } })).default;
const hordePath = opt('horde', null);
const Z = await import(hordePath ? pathToFileURL(hordePath).href : new URL('shared/zombies.mjs', web));
const game = new Game({ session: () => null }, []);
console.log = silence;
const { Horde, ZOMBIE, BIG } = Z;

/** mulberry32 */
function dice(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TICK = 0.05;
const SAMPLE = 0.25;
const RANGE = 40;
const NEAR = 15;
const RIFLE = { body: 26, head: 100, delay: 0.1, mag: 30, reload: 2.2 };

/** Where the players start: as server/game.mjs gather, round the house's outside start places or the portal's way out. */
function starts(place, nav, n, spots) {
  const arena = arenaOf(place === 'cafe' ? 'church' : place);
  let middles;
  if (place === 'cafe') {
    // Inside the café at the church: its ground floor's squares nearest the middle of it, joined to where zombies come
    // out, at least 0.8 m apart.
    const joined = new Set(spots.map((s) => nav.region(s.node)));
    const fl = nav.floors().filter((f) => f.open && f.links > 0 && f.y < 6.5 && joined.has(nav.region(f.node)) && Math.hypot(f.x - 541, f.z + 716.5) < 6);
    fl.sort((a, b) => Math.hypot(a.x - 541, a.z + 716.5) - Math.hypot(b.x - 541, b.z + 716.5));
    const out = [];
    for (const f of fl) if (out.length < n && out.every((q) => Math.hypot(q.x - f.x, q.z - f.z) >= 0.8)) out.push({ x: f.x, z: f.z, y: f.y, node: f.node });
    return Array.from({ length: n }, (_, i) => out[i % out.length]);
  } else if (place === 'house') middles = (SPAWNS.spawns ?? SPAWNS).filter((s) => s.team === 'house' && s.outside);
  else {
    const p = portalOf(arena);
    middles = [{ x: p.out[0], z: p.out[1] }];
  }
  const out = [];
  for (const [r, k] of [[0, 1], [1.6, 6], [3.2, 10], [4.8, 14]]) {
    for (let i = 0; i < k; i++) {
      for (const m of middles) {
        const x = m.x + r * Math.sin((i / k) * Math.PI * 2), z = m.z + r * Math.cos((i / k) * Math.PI * 2);
        const y = place === 'cafe' ? null : nav.ground(x, z);
        const node = y === null ? nav.locate(x, Infinity, z) : nav.locate(x, y, z, 0.6);
        if (node >= 0 && nav.open(node)) out.push({ x, z, y: nav.y(node, x, z), node });
      }
    }
  }
  return Array.from({ length: n }, (_, i) => out[i % out.length]);
}

function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/** One game at `place` with `n` players; its numbers per wave. */
function run(place, n, seed) {
  const arena = arenaOf(place === 'cafe' ? 'church' : place);
  const ground = game.zombieGround(arena);
  const { nav, spots, home, doors } = ground;
  const open = new Map();
  const rand = dice(seed * 7919 + 13);
  const horde = new Horde(nav, spots, { home, doors, doorOpen: (id) => open.get(id) ?? ground.doorOpen(id), rand });
  const at = starts(place, nav, n, spots);
  const players = at.map((s, i) => ({
    name: `p${i}`, x: s.x, y: s.y, z: s.z, node: s.node, sx: s.x, sz: s.z, sy: s.y, snode: s.node, hp: 100, alive: true, fighter: true, safe: false,
    rng: dice(seed * 104729 + i * 31 + 7), target: null, aimAt: 0, nextShot: 0, mag: RIFLE.mag, wx: s.x, wz: s.z, wanderAt: 0, downAt: 0,
  }));
  const seesCache = new Map();
  const sees = (p, z) => {
    const d = Math.hypot(z.x - p.x, z.z - p.z);
    if (d > RANGE || Math.abs(z.y - p.y) > 3) return false;
    const key = p.name + ':' + z.id;
    const c = seesCache.get(key);
    if (c !== undefined) return c;
    const inside = p.node >= nav.outdoor || z.node >= nav.outdoor;
    const v = inside ? nav.reach(p.x, p.y + 1.5, p.z, z.x, z.y + 1.2, z.z) : nav.clear(p.x, p.z, z.x, z.z, true);
    seesCache.set(key, v);
    return v;
  };
  const waves = [];
  let w = null;
  let now = 0;
  let tickMs = 0, ticks = 0;
  let sampleAt = 0;
  const born = new Map(); // zombie id -> { t, seenAt, reachAt, still, stillAt }
  const arrivals = [];
  const maxT = 7200;
  horde.start(0);
  let over = false;
  const newWave = (e) => {
    w = { wave: e.wave, count: e.count, start: now, alive: [], near: [], view: [], viewP: [], idle: [], sides: [], walk: [], seen: [], sight: [], downs: 0, spawnD: [], spawnSeen: 0, stuck: 0, arrivals: [], rehomed: horde.rehomed ?? 0 };
    waves.push(w);
  };
  for (; now < maxT && !over; now += TICK) {
    const ms = now * 1000;
    const t0 = performance.now();
    const ev = horde.tick(ms, TICK, players);
    tickMs += performance.now() - t0;
    ticks++;
    seesCache.clear();
    for (const e of ev) {
      if (e.type === 'wave') {
        if (e.wave > MAX_WAVE) {
          over = true;
          break;
        }
        newWave(e);
      } else if (e.type === 'spawn') {
        const z = horde.zombies.get(e.id);
        if (!z) continue;
        const rehome = born.has(e.id);
        born.set(e.id, { t: now, seenAt: null, viewAt: null, reachAt: null, stillFrom: null, stuck: false });
        if (w) {
          let d = Infinity, seen = false;
          for (const p of players) if (p.alive) {
            d = Math.min(d, Math.hypot(p.x - z.x, p.z - z.z));
            if (p.node < nav.outdoor && z.node < nav.outdoor && sees(p, z)) seen = true;
          }
          if (!rehome) w.spawnD.push(d);
          if (seen) w.spawnSeen++;
        }
      } else if (e.type === 'swipe') {
        const p = players.find((q) => q.name === e.name);
        if (!p || !p.alive) continue;
        p.hp -= e.damage;
        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;
          p.downAt = now;
          if (w) w.downs++;
        }
      } else if (e.type === 'door') open.set(e.id, true);
      else if (e.type === 'cleared') {
        if (w) w.len = now - w.start;
        for (const p of players) if (!p.alive) Object.assign(p, { alive: true, hp: 100, x: p.sx, y: p.sy, z: p.sz, node: p.snode, target: null });
      } else if (e.type === 'over') {
        over = true;
        if (w) w.len = now - w.start;
      }
    }
    if (over) break;
    // The players.
    const up = [...horde.zombies.values()].filter((z) => z.act !== 'down');
    for (const p of players) {
      if (!p.alive) {
        // Helped up: a teammate up within 10 m, no zombie within 6 m of them for 4 s.
        const mate = players.some((q) => q.alive && Math.hypot(q.x - p.x, q.z - p.z) < 10);
        const calm = !up.some((z) => Math.hypot(z.x - p.x, z.z - p.z) < 6);
        if (!(mate && calm)) p.helpFrom = null;
        else if ((p.helpFrom ??= now) && now - p.helpFrom >= 4) Object.assign(p, { alive: true, hp: 50, helpFrom: null });
        continue;
      }
      // Step back from one too close, else wander a little round the start.
      let close = null, cd = Infinity;
      for (const z of up) {
        const d = Math.hypot(z.x - p.x, z.z - p.z);
        if (d < cd && Math.abs(z.y - p.y) < 2) [close, cd] = [z, d];
      }
      let vx = 0, vz = 0;
      if (close && cd < (close.kind === BIG ? 4 : 2.4)) {
        const k = 3.5 / Math.max(cd, 0.1);
        vx = (p.x - close.x) * k;
        vz = (p.z - close.z) * k;
        // Not too far from the start (a group holds its place).
        const hx = p.sx - p.x, hz = p.sz - p.z, hd = Math.hypot(hx, hz);
        if (hd > 8) [vx, vz] = [vx * 0.4 + (hx / hd) * 2, vz * 0.4 + (hz / hd) * 2];
      } else {
        if (now >= p.wanderAt) {
          const a = p.rng() * Math.PI * 2, r = p.rng() * 3;
          [p.wx, p.wz, p.wanderAt] = [p.sx + Math.sin(a) * r, p.sz + Math.cos(a) * r, now + 3 + p.rng() * 5];
        }
        const dx = p.wx - p.x, dz = p.wz - p.z, d = Math.hypot(dx, dz);
        if (d > 0.3) [vx, vz] = [(dx / d) * 1.2, (dz / d) * 1.2];
      }
      const nx = p.x + vx * TICK, nz = p.z + vz * TICK;
      let k = nav.step(p.node, nx, nz);
      if (k >= 0 && nav.open(k)) [p.x, p.z, p.node] = [nx, nz, k];
      else if ((k = nav.step(p.node, nx, p.z)) >= 0 && nav.open(k)) [p.x, p.node] = [nx, k];
      else if ((k = nav.step(p.node, p.x, nz)) >= 0 && nav.open(k)) [p.z, p.node] = [nz, k];
      p.y = nav.y(p.node, p.x, p.z);
      // Aim and fire.
      const held = p.target && horde.zombies.get(p.target);
      if (!held || held.act === 'down' || !sees(p, held)) p.target = null;
      if (!p.target) {
        let best = null, bd = Infinity;
        for (const z of up) {
          const d = Math.hypot(z.x - p.x, z.z - p.z);
          if (d < bd && sees(p, z)) [best, bd] = [z, d];
        }
        if (best) [p.target, p.aimAt] = [best.id, now + 0.35 + p.rng() * 0.4];
      }
      if (!p.target || now < p.aimAt || now < p.nextShot) continue;
      const z = horde.zombies.get(p.target);
      const d = Math.hypot(z.x - p.x, z.z - p.z);
      horde.noise(p.x, p.z, 'rifle', ms, p.name);
      const chance = Math.max(0.12, Math.min(0.6, 0.6 - 0.013 * d)) * SKILL;
      if (p.rng() < chance) {
        const head = p.rng() < 0.1 * SKILL;
        horde.hit(z.id, head ? RIFLE.head : RIFLE.body, p.name, ms);
      }
      p.mag--;
      p.burst = (p.burst ?? 0) + 1;
      if (p.mag <= 0) [p.mag, p.nextShot, p.burst] = [RIFLE.mag, now + RIFLE.reload, 0];
      else if (p.burst >= 3 + Math.floor(p.rng() * 4)) [p.burst, p.nextShot] = [0, now + 0.4 + p.rng() * 0.8];
      else p.nextShot = now + RIFLE.delay * 1.15;
    }
    // The numbers.
    if (w && horde.phase === 'wave') {
      for (const z of up) {
        const b = born.get(z.id);
        if (!b) continue;
        let reached = false, seenNear = false, near3 = false, inView = false;
        for (const p of players) {
          if (!p.alive) continue;
          const d = Math.hypot(p.x - z.x, p.z - z.z);
          if (d < 3) near3 = true;
          if (d <= ZOMBIE.reach + 0.1 && Math.abs(p.y - z.y) < 2) reached = true;
          if (b.viewAt === null && !inView && sees(p, z)) inView = true;
          if (b.seenAt === null && !seenNear && d <= NEAR && sees(p, z)) seenNear = true;
        }
        if (inView) {
          b.viewAt = now;
          w.sight.push(now - b.t);
          w.arrivals.push(now);
        }
        if (seenNear) {
          b.seenAt = now;
          w.seen.push(now - b.t);
        }
        if (reached && b.reachAt === null) {
          b.reachAt = now;
          w.walk.push(now - b.t);
        }
        if (z.act === 'walk' && z.speed < 0.1 && !near3) {
          b.stillFrom ??= now;
          if (!b.stuck && now - b.stillFrom >= 5) {
            b.stuck = true;
            w.stuck++;
          }
        } else b.stillFrom = null;
      }
      if (now >= sampleAt) {
        sampleAt = now + SAMPLE;
        const live = players.filter((p) => p.alive);
        let near = 0, view = 0;
        const angles = [];
        let mx = 0, mz = 0;
        for (const p of live) [mx, mz] = [mx + p.x / live.length, mz + p.z / live.length];
        for (const z of up) {
          if (live.some((p) => Math.hypot(p.x - z.x, p.z - z.z) <= NEAR && sees(p, z))) near++;
          if (live.some((p) => sees(p, z))) {
            view++;
            angles.push(Math.atan2(z.x - mx, z.z - mz));
          }
        }
        w.alive.push(up.length);
        w.near.push(near);
        w.view.push(view);
        if (angles.length) {
          // From more than one side: the zombies in sight spread over more than a quarter turn round the players.
          angles.sort((a, b) => a - b);
          let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
          for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
          w.sides.push(2 * Math.PI - gap >= Math.PI / 2 ? 1 : 0);
        }
        for (const p of live) {
          let k = 0;
          for (const z of up) if (sees(p, z)) k++;
          w.idle.push(k ? 0 : 1);
          w.viewP.push(k);
        }
      }
    }
  }
  for (const v of waves) {
    v.rehomed = (horde.rehomed ?? 0) - v.rehomed;
    v.len ??= now - v.start;
    // Groups: arrivals within 2.5 s of the one before.
    const a = v.arrivals;
    const groups = [];
    for (let i = 0; i < a.length; i++) {
      if (i && a[i] - a[i - 1] <= 2.5) groups[groups.length - 1]++;
      else groups.push(1);
    }
    v.group = groups.length ? mean(groups) : NaN;
  }
  return { waves, overWave: horde.phase === 'over' ? horde.wave : null, tick: tickMs / ticks, simS: now };
}

/** A wave's numbers in one row. */
function row(list) {
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const all = (k) => list.flatMap((v) => v[k]);
  return {
    alive: f(mean(all('alive'))), aliveMax: f(Math.max(...list.map((v) => Math.max(0, ...v.alive))), 0),
    near: f(mean(all('near'))), nearMax: f(Math.max(...list.map((v) => Math.max(0, ...v.near))), 0), view: f(mean(all('view'))), viewP: f(mean(all('viewP'))), sight: f(median(all('sight'))),
    walk: f(median(all('walk'))), seen: f(median(all('seen'))), idle: f(100 * mean(all('idle')), 0) + '%',
    len: f(mean(list.map((v) => v.len)), 0), downs: f(mean(list.map((v) => v.downs))), group: f(mean(list.map((v) => v.group).filter(Number.isFinite))),
    sides: f(100 * mean(all('sides')), 0) + '%', spawnD: f(median(all('spawnD'))), inSight: list.reduce((s, v) => s + v.spawnSeen, 0), stuck: list.reduce((s, v) => s + v.stuck, 0),
    rehomed: list.reduce((s, v) => s + v.rehomed, 0),
  };
}

const results = [];
const cols = ['alive', 'aliveMax', 'near', 'nearMax', 'view', 'viewP', 'sight', 'seen', 'walk', 'idle', 'len', 'downs', 'group', 'sides', 'spawnD', 'inSight', 'stuck', 'rehomed'];
const print = (label, r) => console.log(label.padEnd(18) + cols.map((c) => String(r[c]).padStart(c.length > 6 ? c.length + 1 : 7)).join(''));
console.log(`horde: ${hordePath ?? 'this checkout'}; seeds ${SEED0}..${SEED0 + SEEDS - 1}; skill ${SKILL}; up to wave ${MAX_WAVE}`);
for (const place of PLACES) {
  for (const n of COUNTS) {
    const runs = [];
    for (let s = 0; s < SEEDS; s++) runs.push(run(place, n, SEED0 + s));
    // The wave the game ended in; one still going at the end (--max-wave, or two hours) counts its last wave, with a +.
    const reached = runs.map((r) => r.overWave ?? r.waves.length);
    const label = runs.map((r) => (r.overWave ? `${r.overWave}` : `${r.waves.length}+`));
    console.log(`\n${place}, ${n} player${n > 1 ? 's' : ''}: game over at wave ${label.join(', ')} (mean ${mean(reached).toFixed(1)}); horde step ${mean(runs.map((r) => r.tick)).toFixed(2)} ms`);
    console.log(''.padEnd(18) + cols.map((c) => c.padStart(c.length > 6 ? c.length + 1 : 7)).join(''));
    const byWave = new Map();
    for (const r of runs) for (const v of r.waves) (byWave.get(v.wave) ?? byWave.set(v.wave, []).get(v.wave)).push(v);
    const all = runs.flatMap((r) => r.waves);
    const summary = row(all);
    print('all waves', summary);
    const shown = PER_WAVE ? [...byWave.keys()] : [1, 3, 5, 10].filter((k) => byWave.has(k));
    const perWave = {};
    for (const k of [...byWave.keys()].sort((a, b) => a - b)) {
      perWave[k] = row(byWave.get(k));
      if (shown.includes(k)) print(`wave ${k} (${byWave.get(k).length})`, perWave[k]);
    }
    results.push({ place, players: n, reached, summary, perWave, tick: mean(runs.map((r) => r.tick)) });
  }
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ horde: hordePath, seeds: SEEDS, skill: SKILL, maxWave: MAX_WAVE, results }, null, 1));
process.exit(0);
