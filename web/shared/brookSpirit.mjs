// The Brook Spirit, the floating boss in the wood by the brook, shared by the server (which runs it in multiplayer with
// every fighter near) and the browser (which runs it when you play alone, with you as the only fighter): plain objects
// and plain functions, no three.js, no network, no clock and no dice of its own. Its numbers and its place are
// shared/brookSpirit.json.
//
// It sleeps over the brook until a fighter (alive, armed, on foot: the caller decides) comes within `wakeR` of the
// grove's middle. Awake, it attacks (a sweep of tendrils at the nearest, mist bolts at those it sees past the trunks,
// pools of mist from phase 2), then opens its heart for a few seconds: only shots on the open heart count, and one
// window takes at most a tenth of its health. At 66 % and at 33 % its health stops and a shell closes round it: lights
// among the trees must be shot out first (3, then the other 5), then the shell bursts and the heart is open for longer.
// From phase 2 it sinks into the ground and rises at another hover point, never next to a fighter. Left alone, or
// unhurt for a while, it goes back over the brook and mends; mended, or alone for long, it is as new and asleep.
// Beaten, it comes apart, harmless, and gathers again after `beaten.back` seconds.
//
// Every tell fixes where it lands when it starts and never follows anyone. Trunks are cover: a bolt needs a clear line
// when its tell starts, a sweep spares whoever has a trunk between. Times: `now` in ms, `dt` in seconds.

import { hurtBy } from './brutes.mjs';

/** The modes, in the order the wire numbers them. */
export const MODES = ['asleep', 'fight', 'mend', 'apart', 'gone'];
/** What it is doing, in the order the wire numbers them. */
export const ACTS = ['idle', 'drift', 'sweep', 'bolt', 'pool', 'open', 'pause', 'sink', 'under', 'rise', 'stun'];
/** The node of its rest over the brook in the hover points' graph (the hover points are 0 to 6). */
export const REST = -1;

const TELLS = new Set(['sweep', 'bolt', 'pool']);
const fin = Number.isFinite;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** A throw of the dice: a whole number from 0 to n - 1 (a broken dice counts as 0). */
const roll = (rand, n) => clamp(Math.floor((Number(rand()) || 0) * n), 0, n - 1);

/** Where the lights hang: `lightOff` m from each anchor tree's trunk towards the grove's middle, `up` over its foot. */
export function lightsOf(data) {
  return data.lights.map((l) => {
    const [x, z, y] = l.tree;
    const dx = data.grove.x - x;
    const dz = data.grove.z - z;
    const d = Math.hypot(dx, dz) || 1;
    return { x: x + (dx / d) * data.lightOff, y: y + l.up, z: z + (dz / d) * data.lightOff };
  });
}

/** A node's spot: the rest or a hover point, `up` over its ground. */
function nodeAt(d, n) {
  if (n === REST) return { x: d.rest.x, y: d.rest.y + d.up, z: d.rest.z };
  const [x, z, y] = d.hover[n];
  return { x, y: y + d.up, z };
}

/** The nodes linked to node `n`, clear of the trunks (the data's `links` and `rest.links`). */
function neighbours(d, n) {
  if (n === REST) return [...d.rest.links];
  const out = [];
  for (const [a, b] of d.links) {
    if (a === n) out.push(b);
    else if (b === n) out.push(a);
  }
  if (d.rest.links.includes(n)) out.push(REST);
  return out;
}

/** The shortest way along the links from node `a` to node `b` (without `a`), or null when there is none. */
function route(d, a, b) {
  if (a === b) return [];
  const nodes = [REST, ...d.hover.map((_, i) => i)];
  const dist = new Map(nodes.map((n) => [n, Infinity]));
  const prev = new Map();
  const open = new Set(nodes);
  dist.set(a, 0);
  while (open.size) {
    let u = null;
    for (const n of open) if (u === null || dist.get(n) < dist.get(u)) u = n;
    if (dist.get(u) === Infinity) break;
    open.delete(u);
    if (u === b) break;
    const pu = nodeAt(d, u);
    for (const v of neighbours(d, u)) {
      if (!open.has(v)) continue;
      const pv = nodeAt(d, v);
      const alt = dist.get(u) + Math.hypot(pv.x - pu.x, pv.z - pu.z);
      if (alt < dist.get(v)) {
        dist.set(v, alt);
        prev.set(v, u);
      }
    }
  }
  if (dist.get(b) === Infinity) return null;
  const path = [];
  for (let n = b; n !== a; n = prev.get(n)) path.unshift(n);
  return path;
}

/** Whether the line from (ax, az) to (bx, bz) passes clear of every trunk ({ x, z, r }). */
export function clearLine(ax, az, bx, bz, trunks) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  for (const t of trunks) {
    const u = len2 > 0 ? clamp(((t.x - ax) * dx + (t.z - az) * dz) / len2, 0, 1) : 0;
    if (Math.hypot(t.x - ax - dx * u, t.z - az - dz * u) < t.r) return false;
  }
  return true;
}

/** Full health for `count` fighters. */
const fullFor = (d, count) => d.health.base + d.health.per * (Math.max(1, Math.min(d.health.most, count)) - 1);

/**
 * The most one window may take: about what one sharp shooter deals in it, growing more slowly with the fighters
 * counted than full health does, so it stops crowds and sharpshooters while health carries the fight's length.
 */
export const windowCap = (s) => s.d.cap.window + s.d.cap.per * (Math.max(1, Math.min(s.d.health.most, s.seen.size)) - 1);

/** The spirit as new, asleep over the brook. `data`: shared/brookSpirit.json. */
export function newSpirit(data) {
  const s = { d: data, lights: lightsOf(data).map((p) => ({ ...p, hp: 0, lit: false, used: false })), now: 0 };
  reset(s, 0);
  return s;
}

/** Everything back as new and asleep over the brook. */
function reset(s, now) {
  const d = s.d;
  const at = nodeAt(d, REST);
  Object.assign(s, {
    mode: 'asleep', act: 'idle', since: now, until: 0, phase: 1,
    max: fullFor(d, 1), hp: fullFor(d, 1),
    x: at.x, y: at.y, z: at.z, tx: d.grove.x, tz: d.grove.z,
    node: REST, path: [], riseTo: null,
    seen: new Set(), hurt: new Map(), near: new Set(),
    left: 0, windows: 0, volley: 0, target: null, aim: null,
    budget: 0, graceUntil: 0, shell: null, shells: 0,
    bolts: [], pools: [], poolTick: 0, draw: [],
    lastFighter: now, lastDamage: now, hurtAt: -Infinity, woke: 0,
  });
  for (const l of s.lights) Object.assign(l, { hp: 0, lit: false, used: false });
}

function go(s, act, now, secs = 0) {
  s.act = act;
  s.since = now;
  s.until = now + secs * 1000;
}

const phaseOf = (s) => clamp(s.phase, 1, 3) - 1;

/** The fighters it counts: well formed and within the leash of the grove's middle. */
function fightersIn(s, fighters) {
  const g = s.d.grove;
  const out = [];
  if (!Array.isArray(fighters)) return out;
  for (const f of fighters) {
    if (!f || typeof f.name !== 'string' || !fin(f.x) || !fin(f.y) || !fin(f.z)) continue;
    if (Math.hypot(f.x - g.x, f.z - g.z) <= g.leash) out.push(f);
  }
  return out;
}

/** The trunks as circles, the bad ones left out. */
function trunksOf(trunks) {
  return Array.isArray(trunks) ? trunks.filter((t) => t && fin(t.x) && fin(t.z) && fin(t.r) && t.r > 0) : [];
}

/** Count new fighters: full health only ever goes up during a fight, and health keeps its share of it. */
function count(s, F) {
  for (const f of F) if (s.seen.size < 64) s.seen.add(f.name);
  const max = fullFor(s.d, s.seen.size);
  if (max > s.max) {
    s.hp = Math.round((s.hp / s.max) * max);
    s.max = max;
  }
}

/**
 * One step. `fighters`: who may fight it now ({ name, x, y, z }: alive, armed, on foot, not flying, past spawn
 * protection; the caller decides), the server's positions; those past the leash are left out here. `trunks`: the
 * trunks near ({ x, z, r }). `rand`: the dice. Returns what happened (SpiritEvent): the caller applies the hits.
 */
export function stepSpirit(s, fighters, now, dt, rand = Math.random, trunks = []) {
  const ev = [];
  if (!s || !fin(now)) return ev;
  dt = fin(dt) ? clamp(dt, 0, 0.5) : 0;
  s.now = now;
  const F = fightersIn(s, fighters);
  const T = trunksOf(trunks);
  s.near = new Set(F.map((f) => f.name));
  const d = s.d;
  if (s.mode === 'gone') {
    if (now >= s.until) {
      reset(s, now);
      ev.push({ type: 'back' });
    }
    return ev;
  }
  if (s.mode === 'apart') {
    if (now >= s.until) {
      s.mode = 'gone';
      go(s, 'idle', now, d.beaten.back);
    }
    return ev;
  }
  if (s.mode === 'asleep') {
    const g = d.grove;
    if (!F.some((f) => Math.hypot(f.x - g.x, f.z - g.z) <= g.wakeR)) return ev;
    s.mode = 'fight';
    s.woke = now;
    s.lastFighter = now;
    s.lastDamage = now;
    s.left = d.phases.attacks[0];
    s.windows = 0;
    count(s, F);
    drawShells(s, rand);
    go(s, 'idle', now, d.gap);
    ev.push({ type: 'wake' });
    return ev;
  }
  // Awake: fighting or mending.
  if (F.length) s.lastFighter = now;
  count(s, F);
  land(s, F, now, ev);
  if (now - s.lastFighter >= d.mend.reset * 1000) {
    reset(s, now);
    ev.push({ type: 'reset' });
    return ev;
  }
  if (s.mode === 'mend') stepMend(s, F, now, dt, rand, ev);
  else stepFight(s, F, now, dt, rand, T, ev);
  return ev;
}

/** Bolts landing and pools stinging. */
function land(s, F, now, ev) {
  const b = s.d.attacks.bolt;
  for (const bolt of [...s.bolts]) {
    if (now < bolt.at) continue;
    s.bolts.splice(s.bolts.indexOf(bolt), 1);
    for (const f of F) {
      const dist = Math.hypot(f.x - bolt.x, f.z - bolt.z);
      const damage = Math.abs(f.y - bolt.y) <= b.high ? hurtBy(dist, b.radius, b.damage) : 0;
      if (damage > 0) ev.push({ type: 'hit', name: f.name, damage, kind: 'bolt', x: bolt.x, z: bolt.z });
    }
  }
  const p = s.d.attacks.pools;
  while (s.pools.length && s.poolTick && now >= s.poolTick) {
    const at = s.poolTick;
    const live = s.pools.filter((q) => q.until > at - 1e-6 && q.from <= at);
    for (const f of F) {
      const q = live.find((q) => Math.hypot(f.x - q.x, f.z - q.z) < p.radius && Math.abs(f.y - q.y) <= s.d.attacks.bolt.high);
      if (q) ev.push({ type: 'hit', name: f.name, damage: p.damage, kind: 'pool', x: q.x, z: q.z });
    }
    s.poolTick += p.every * 1000;
    s.pools = s.pools.filter((q) => q.until > s.poolTick - 1e-6);
  }
  if (!s.pools.length) s.poolTick = 0;
}

/** Fly towards spot `to` at the drift speed; true on arrival. */
function fly(s, to, dt) {
  const dx = to.x - s.x;
  const dz = to.z - s.z;
  const dist = Math.hypot(dx, dz);
  const step = s.d.drift * dt;
  s.tx = to.x;
  s.tz = to.z;
  if (dist <= step || dist < 1e-6) {
    s.x = to.x;
    s.y = to.y;
    s.z = to.z;
    return true;
  }
  s.x += (dx / dist) * step;
  s.z += (dz / dist) * step;
  s.y += clamp(to.y - s.y, -step, step);
  return false;
}

/** Along its path; on arrival at the last node, true. */
function drift(s, dt) {
  if (!s.path.length) return true;
  const n = s.path[0];
  if (!fly(s, nodeAt(s.d, n), dt)) return false;
  s.node = n;
  s.path.shift();
  return !s.path.length;
}

/** Face the nearest fighter (only where it looks: no tell follows anyone). */
function faceNearest(s, F) {
  let best = null;
  let bd = Infinity;
  for (const f of F) {
    const dist = Math.hypot(f.x - s.x, f.z - s.z);
    if (dist < bd) [best, bd] = [f, dist];
  }
  if (best) {
    s.tx = best.x;
    s.tz = best.z;
  }
}

function stepFight(s, F, now, dt, rand, T, ev) {
  const d = s.d;
  const sinking = s.act === 'sink' || s.act === 'under' || s.act === 'rise';
  // Alone too long, or unhurt too long outside a shell: back over the brook to mend.
  if (!sinking && (now - s.lastFighter >= d.mend.noFighter * 1000 || (s.shell === null && now - s.lastDamage >= d.mend.noDamage * 1000))) {
    startMend(s, F, now, rand, ev);
    return;
  }
  switch (s.act) {
    case 'idle':
      faceNearest(s, F);
      if (now >= s.until) attack(s, F, now, rand, T, ev);
      break;
    case 'drift':
      if (drift(s, dt)) go(s, 'idle', now, d.gap);
      break;
    case 'sweep':
    case 'bolt':
    case 'pool':
      if (now >= s.until) {
        resolve(s, F, now, T, ev);
        after(s, F, now, rand, T, ev);
      }
      break;
    case 'open':
    case 'stun':
      faceNearest(s, F);
      if (now >= s.until) close(s, now, ev, true);
      break;
    case 'pause':
      faceNearest(s, F);
      if (now >= s.until) move(s, F, now, rand, ev);
      break;
    default:
      stepSink(s, F, now, rand, ev);
  }
}

/** The nearest fighter within the sweep's reach, and those it sees between the bolt's distances. */
function choices(s, F, T) {
  const a = s.d.attacks;
  let near = null;
  let nd = a.sweep.range;
  const bolt = [];
  for (const f of F) {
    const dist = Math.hypot(f.x - s.x, f.z - s.z);
    if (dist <= nd) [near, nd] = [f, dist];
    if (dist >= a.bolt.min && dist <= a.bolt.max && clearLine(s.x, s.z, f.x, f.z, T)) bolt.push(f);
  }
  return { near, bolt };
}

/** The next attack: a sweep at the nearest close by, else bolts at one it sees or pools (phase 2 on), else on it goes. */
function attack(s, F, now, rand, T, ev) {
  const d = s.d;
  const a = d.attacks;
  if (!F.length) {
    go(s, 'idle', now, d.gap); // nobody to attack: it waits (and mends if nobody comes)
    return;
  }
  const { near, bolt } = choices(s, F, T);
  const pools = s.phase >= a.pools.phase && s.pools.length < a.pools.most;
  if (near) {
    startSweep(s, near, now, ev);
    return;
  }
  if (bolt.length && !(pools && (Number(rand()) || 0) < a.pools.chance)) {
    s.volley = a.bolt.volley[phaseOf(s)];
    startBolt(s, bolt[roll(rand, bolt.length)], now, ev);
    return;
  }
  if (pools) {
    // At the one it sees least well: the farthest (pools ignore the trunks).
    let far = F[0];
    for (const f of F) if (Math.hypot(f.x - s.x, f.z - s.z) > Math.hypot(far.x - s.x, far.z - s.z)) far = f;
    s.aim = { x: far.x, y: far.y, z: far.z };
    s.target = far.name;
    s.tx = far.x;
    s.tz = far.z;
    go(s, 'pool', now, a.pools.tell);
    ev.push({ type: 'tell', kind: 'pool', target: far.name, x: far.x, z: far.z, ms: Math.round(a.pools.tell * 1000) });
    return;
  }
  move(s, F, now, rand, ev, true); // nobody in sight: it goes elsewhere
}

function startSweep(s, f, now, ev) {
  const a = s.d.attacks.sweep;
  const dx = f.x - s.x;
  const dz = f.z - s.z;
  const dist = Math.hypot(dx, dz) || 1;
  const ux = dist > 1e-6 ? dx / dist : Math.sin(Math.atan2(s.tx - s.x, s.tz - s.z));
  const uz = dist > 1e-6 ? dz / dist : Math.cos(Math.atan2(s.tx - s.x, s.tz - s.z));
  s.aim = { fx: s.x, fz: s.z, y: s.y - s.d.up, x: s.x + ux * a.length, z: s.z + uz * a.length };
  s.target = f.name;
  s.tx = s.aim.x;
  s.tz = s.aim.z;
  const tell = a.tell[phaseOf(s)];
  go(s, 'sweep', now, tell);
  ev.push({ type: 'tell', kind: 'sweep', target: f.name, x: s.aim.x, z: s.aim.z, fx: s.aim.fx, fz: s.aim.fz, ms: Math.round(tell * 1000) });
}

function startBolt(s, f, now, ev) {
  const tell = s.d.attacks.bolt.tell[phaseOf(s)];
  s.aim = { x: f.x, y: f.y, z: f.z };
  s.target = f.name;
  s.tx = f.x;
  s.tz = f.z;
  s.volley--;
  go(s, 'bolt', now, tell);
  ev.push({ type: 'tell', kind: 'bolt', target: f.name, x: f.x, z: f.z, ms: Math.round(tell * 1000) });
}

/** A tell's end: the sweep strikes, the bolt flies, the pool spreads. */
function resolve(s, F, now, T, ev) {
  const d = s.d;
  const a = d.attacks;
  const aim = s.aim;
  if (!aim) return;
  if (s.act === 'sweep') {
    const ex = aim.x - aim.fx;
    const ez = aim.z - aim.fz;
    const len = Math.hypot(ex, ez) || 1;
    const hits = [];
    const damage = a.sweep.damage[phaseOf(s)];
    for (const f of F) {
      const u = ((f.x - aim.fx) * ex + (f.z - aim.fz) * ez) / len;
      const side = Math.abs((f.x - aim.fx) * ez - (f.z - aim.fz) * ex) / len;
      if (u < 0 || u > len || side > a.sweep.half || Math.abs(f.y - aim.y) > a.sweep.high) continue;
      if (!clearLine(aim.fx, aim.fz, f.x, f.z, T)) continue; // a trunk between: spared
      hits.push(f.name);
      ev.push({ type: 'hit', name: f.name, damage, kind: 'sweep', x: aim.fx, z: aim.fz });
    }
    ev.push({ type: 'sweep', from: { x: r2(aim.fx), z: r2(aim.fz) }, to: { x: r2(aim.x), z: r2(aim.z) }, hits });
  } else if (s.act === 'bolt') {
    const from = { x: r2(s.x), y: r2(s.y), z: r2(s.z) };
    const to = { x: r2(aim.x), y: r2(aim.y), z: r2(aim.z) };
    const ms = Math.round((Math.hypot(to.x - from.x, to.z - from.z) / a.bolt.speed + a.bolt.extra) * 1000);
    s.bolts.push({ x: aim.x, y: aim.y, z: aim.z, at: now + ms });
    ev.push({ type: 'bolt', from, to, ms });
  } else if (s.act === 'pool' && s.pools.length < a.pools.most) {
    s.pools.push({ x: aim.x, y: aim.y, z: aim.z, from: now, until: now + a.pools.last * 1000 });
    if (!s.poolTick) s.poolTick = now + a.pools.every * 1000;
    ev.push({ type: 'pool', x: r2(aim.x), z: r2(aim.z), ms: Math.round(a.pools.last * 1000) });
  }
  s.aim = null;
}

/** After an attack: the volley's next bolt, the next attack, or the window (none in a shell: it keeps casting). */
function after(s, F, now, rand, T, ev) {
  const d = s.d;
  if (s.act === 'bolt' && s.volley > 0) {
    const { bolt } = choices(s, F, T);
    const same = bolt.find((f) => f.name === s.target);
    const f = same ?? (bolt.length ? bolt[roll(rand, bolt.length)] : null);
    if (f) {
      startBolt(s, f, now, ev);
      return;
    }
  }
  s.volley = 0;
  s.target = null;
  s.left--;
  if (s.left > 0) go(s, 'idle', now, d.gap);
  else if (s.shell !== null) {
    s.left = d.phases.attacks[phaseOf(s)];
    go(s, 'idle', now, d.phases.pause[phaseOf(s)]);
  } else {
    s.budget = windowCap(s);
    go(s, 'open', now, d.phases.window[phaseOf(s)]);
    ev.push({ type: 'open', ms: Math.round(d.phases.window[phaseOf(s)] * 1000) });
  }
}

/** The heart folds: its time is up (a short grace for shots on their way), or the window took its share. */
function close(s, now, ev, timeUp) {
  s.graceUntil = timeUp ? now + s.d.cap.grace * 1000 : 0;
  s.windows++;
  go(s, 'pause', now, s.d.phases.pause[phaseOf(s)]);
  ev.push({ type: 'close' });
}

/** On after a pause (or when it sees nobody): drifts to a linked hover point, or sinks and rises elsewhere. */
function move(s, F, now, rand, ev, blind = false) {
  const d = s.d;
  const every = d.phases.sinkEvery[phaseOf(s)];
  s.left = d.phases.attacks[phaseOf(s)];
  const next = s.node === null ? [] : neighbours(d, s.node).filter((n) => n !== REST);
  const sink = (every > 0 && !blind && s.windows % every === 0) || !next.length;
  if (sink && s.phase >= 2) {
    startSink(s, now, ev, null);
    return;
  }
  if (!next.length && s.node !== REST) {
    startSink(s, now, ev, null); // nowhere to drift (the far bank)
    return;
  }
  const to = next.length ? next[roll(rand, next.length)] : REST;
  s.path = [to];
  s.node = null;
  go(s, 'drift', now);
}

function startSink(s, now, ev, riseTo) {
  s.riseTo = riseTo;
  s.aim = null;
  s.volley = 0;
  go(s, 'sink', now, s.d.sink.down);
  ev.push({ type: 'sink', x: r2(s.x), z: r2(s.z) });
}

/** Where it may rise: of `wanted` (all hover points but its own), those with no fighter within `sink.clear`. */
function pickRise(s, F, rand, wanted) {
  const d = s.d;
  const ok = wanted.filter((n) => {
    const p = nodeAt(d, n);
    return F.every((f) => Math.hypot(f.x - p.x, f.z - p.z) > d.sink.clear);
  });
  return ok.length ? ok[roll(rand, ok.length)] : null;
}

/** Of `wanted`, the point whose nearest fighter is farthest away (the first of equals). */
function farthest(s, F, wanted) {
  let best = null;
  let bd = -1;
  for (const n of wanted) {
    const p = nodeAt(s.d, n);
    const near = F.reduce((m, f) => Math.min(m, Math.hypot(f.x - p.x, f.z - p.z)), Infinity);
    if (near > bd) [best, bd] = [n, near];
  }
  return best;
}

function stepSink(s, F, now, rand, ev) {
  const d = s.d;
  if (now < s.until) return;
  if (s.act === 'sink') {
    go(s, 'under', now, d.sink.gone);
    return;
  }
  if (s.act === 'under') {
    let n;
    const wanted = s.mode === 'mend' ? d.hover.map((_, i) => i).filter((i) => route(d, i, REST)) : d.hover.map((_, i) => i).filter((i) => i !== s.node);
    if (s.mode === 'mend') n = pickRise(s, F, rand, [REST]) ?? pickRise(s, F, rand, wanted);
    else n = pickRise(s, F, rand, wanted);
    // Every point has a fighter close by: it stays under and looks again, but not for ever (a crowd spread over the
    // grove would hold it under and the fight would stall): after `sink.wait` s it rises where they are farthest, its
    // rise's tell as long as ever.
    const forced = n === null;
    if (forced) {
      if (now - s.since < (d.sink.gone + d.sink.wait) * 1000) {
        s.until = now + 250;
        return;
      }
      n = farthest(s, F, s.mode === 'mend' ? [REST, ...wanted] : wanted);
    }
    const p = nodeAt(d, n);
    Object.assign(s, { x: p.x, y: p.y, z: p.z, node: n, path: [] });
    faceNearest(s, F);
    go(s, 'rise', now, d.sink.rise);
    ev.push({ type: 'rise', x: r2(p.x), z: r2(p.z), ms: Math.round(d.sink.rise * 1000), ...(forced ? { forced: true } : {}) });
    return;
  }
  // Risen.
  if (s.mode === 'mend') {
    s.path = route(d, s.node, REST) ?? [];
    go(s, 'drift', now);
  } else go(s, 'idle', now, d.gap);
}

/** Back over the brook to mend: along the links, or under the ground from where there are none. */
function startMend(s, F, now, rand, ev) {
  const d = s.d;
  s.mode = 'mend';
  s.aim = null;
  s.volley = 0;
  s.target = null;
  s.budget = windowCap(s);
  s.graceUntil = 0;
  ev.push({ type: 'mend' });
  const from = s.node ?? s.path[0];
  const way = route(d, from, REST);
  if (way === null) {
    startSink(s, now, ev, REST);
    return;
  }
  s.path = s.node === null ? [from, ...way] : way;
  go(s, 'drift', now);
}

function stepMend(s, F, now, dt, rand, ev) {
  const d = s.d;
  if (s.act === 'sink' || s.act === 'under' || s.act === 'rise') {
    stepSink(s, F, now, rand, ev);
    return;
  }
  // In a shell nothing mends: back to the fight as soon as a fighter comes.
  if (s.shell !== null && F.length) {
    resume(s, now);
    return;
  }
  if (s.act === 'drift') {
    if (drift(s, dt)) go(s, 'idle', now);
    return;
  }
  if (s.node !== REST) {
    s.path = route(d, s.node, REST) ?? [];
    if (s.path.length) go(s, 'drift', now);
    else startSink(s, now, ev, REST);
    return;
  }
  faceNearest(s, F);
  if (s.shell !== null) return;
  s.hp = Math.min(s.max, s.hp + d.mend.rate * s.max * dt);
  if (s.hp >= s.max) {
    reset(s, now);
    ev.push({ type: 'reset' });
  }
}

/** Back to the fight from mending (a heart hit, a light shot, a fighter back during a shell). */
function resume(s, now) {
  s.mode = 'fight';
  s.left = s.d.phases.attacks[phaseOf(s)];
  s.lastDamage = now;
  s.hp = Math.round(s.hp);
  if (s.act === 'drift' && s.node === null) {
    s.path = s.path.slice(0, 1); // finish the stretch first, then attack
    return;
  }
  s.path = [];
  go(s, 'idle', now, s.d.gap);
}

/** Whether the heart takes hits now: open in a window or the stun after a burst, while mending, or just after a window. */
function heartOpen(s, now) {
  if (s.shell !== null) return false;
  if (s.mode === 'fight') return s.act === 'open' || s.act === 'stun' || now <= s.graceUntil;
  if (s.mode === 'mend') return s.act !== 'sink' && s.act !== 'under' && s.act !== 'rise';
  return false;
}

/** Where part `part` is (0 the heart, 1 to 8 a light) while it takes hits now, else null. */
export function spiritPart(s, part, now = s?.now) {
  if (!s || !Number.isInteger(part) || !fin(now)) return null;
  if (s.mode !== 'fight' && s.mode !== 'mend') return null;
  if (part === 0) return heartOpen(s, now) ? { x: s.x, y: s.y, z: s.z } : null;
  const l = s.lights[part - 1];
  return l && l.lit ? { x: l.x, y: l.y, z: l.z } : null;
}

/** Health stops at the next mark until that shell is done. */
function nextMark(s) {
  const marks = s.d.phases.marks;
  return s.shells < marks.length ? Math.round(marks[s.shells] * s.max) : null;
}

/**
 * Which anchors each shell lights, drawn when it wakes (the dice are stepSpirit's): the first shell's at random, the
 * next one's from those still unused. A light shot out never lights again.
 */
function drawShells(s, rand) {
  const free = s.lights.map((_, i) => i);
  s.draw = s.d.shell.lights.map((n) => {
    const lit = [];
    while (lit.length < n && free.length) lit.push(free.splice(roll(rand, free.length), 1)[0]);
    return lit.sort((a, b) => a - b);
  });
}

function startShell(s, now, ev) {
  const d = s.d;
  s.shell = s.shells;
  const lit = (s.draw[s.shells] ?? []).filter((i) => !s.lights[i].used);
  s.shells++;
  // Each light as tough as the fighters counted make it: a group cannot clear the shell in a breath.
  const k = s.shell;
  const hp = d.shell.lightHp[k] + d.shell.lightPer[k] * (Math.max(1, Math.min(d.health.most, s.seen.size)) - 1);
  for (const i of lit) Object.assign(s.lights[i], { lit: true, used: true, hp });
  s.budget = 0;
  s.graceUntil = 0;
  ev.push({ type: 'shell', lights: lit });
  for (const i of lit) ev.push({ type: 'light', i });
  if (s.mode === 'mend') resume(s, now);
  else if (s.act === 'open' || s.act === 'stun' || s.act === 'pause') {
    s.left = d.phases.attacks[phaseOf(s)];
    go(s, 'idle', now, d.gap);
  }
  if (!lit.length) burst(s, now, ev);
}

function burst(s, now, ev) {
  const d = s.d;
  s.shell = null;
  s.phase = Math.min(3, s.phase + 1);
  s.windows = 0;
  s.aim = null;
  s.volley = 0;
  s.budget = Math.round(d.cap.stun * windowCap(s));
  if (s.mode === 'mend') s.mode = 'fight';
  s.path = []; // burst between two points: no node, so it sinks next (never drifts off a link)
  go(s, 'stun', now, d.shell.stun);
  ev.push({ type: 'burst', ms: Math.round(d.shell.stun * 1000) });
  ev.push({ type: 'phase', phase: s.phase });
}

function nearestNode(d, x, z) {
  let best = 0;
  for (let i = 1; i < d.hover.length; i++) if (Math.hypot(d.hover[i][0] - x, d.hover[i][1] - z) < Math.hypot(d.hover[best][0] - x, d.hover[best][1] - z)) best = i;
  return best;
}

function beaten(s, now, ev) {
  const d = s.d;
  const ranked = [...s.hurt.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const n = nearestNode(d, s.x, s.z);
  const [x, z, y] = d.hover[n];
  s.mode = 'apart';
  s.hp = 0;
  s.bolts = [];
  s.pools = [];
  s.poolTick = 0;
  s.aim = null;
  s.shell = null;
  for (const l of s.lights) l.lit = false;
  go(s, 'idle', now, d.beaten.apart);
  ev.push({ type: 'beaten', names: ranked.slice(0, d.beaten.names), by: ranked, drop: { x, y, z } });
}

const none = (why) => ({ dealt: 0, why, events: [] });

/**
 * Fighter `who` hit part `part` (0 the heart, 1 to 8 a light) for `damage` (the server's: hits times the gun's body
 * damage). Counts only for a fighter of the last step, on an open heart or a lit light, within the window's share;
 * bad input counts nothing and never throws. Returns what counted, why not, and what followed.
 */
export function hurtSpirit(s, who, part, damage, now) {
  if (!s || !s.d || typeof who !== 'string' || !Number.isInteger(part) || part < 0 || part > s.lights.length) return none('bad');
  if (typeof damage !== 'number' || !fin(damage) || damage <= 0 || typeof now !== 'number' || !fin(now)) return none('bad');
  if (s.mode !== 'fight' && s.mode !== 'mend') return none('mode');
  if (!s.near.has(who)) return none('who');
  const d = s.d;
  damage = Math.min(Math.round(damage), d.heart.most);
  if (damage <= 0) return none('bad');
  const ev = [];
  let dealt = 0;
  if (part === 0) {
    if (!heartOpen(s, now)) return none('shut');
    const take = Math.min(damage, s.budget, Math.ceil(s.hp));
    if (take <= 0) return none('cap');
    const mark = nextMark(s);
    const hp = s.hp - take;
    if (mark !== null && hp <= mark) {
      dealt = Math.max(0, s.hp - mark);
      s.hp = mark;
      s.budget -= dealt;
      startShell(s, now, ev);
    } else {
      dealt = take;
      s.hp = hp;
      s.budget -= dealt;
    }
    s.hurtAt = now;
  } else {
    const l = s.lights[part - 1];
    if (!l.lit) return none('out');
    dealt = Math.min(damage, l.hp);
    l.hp -= dealt;
    if (l.hp <= 0) {
      l.lit = false;
      ev.push({ type: 'out', i: part - 1 });
      if (!s.lights.some((q) => q.lit)) burst(s, now, ev);
    }
  }
  if (dealt <= 0 && !ev.length) return none('cap');
  s.now = Math.max(s.now, now);
  s.lastDamage = now;
  if (dealt > 0) s.hurt.set(who, (s.hurt.get(who) ?? 0) + dealt);
  if (s.mode === 'mend') resume(s, now);
  if (s.hp <= 0) beaten(s, now, ev);
  else if (part === 0 && s.budget <= 0 && s.shell === null && (s.act === 'open' || s.act === 'stun')) {
    ev.push({ type: 'cap' });
    close(s, now, ev, false);
  }
  return { dealt, events: ev };
}

/**
 * A blast (a grenade, a rocket: the server's own) of `radius` m and `damage` at its middle, set off by `who`: the open
 * heart and each lit light within reach take their share by distance, as from hurtSpirit (the same limits). The radius
 * counts up to `heart.blast` m. Returns the total counted, each part's share ([part, dealt]) and what followed.
 */
export function blastSpirit(s, x, y, z, radius, damage, who, now) {
  const out = { dealt: 0, parts: [], events: [] };
  if (!s || !s.d || typeof who !== 'string' || ![x, y, z, radius, damage, now].every((v) => typeof v === 'number' && fin(v))) return { ...out, why: 'bad' };
  if (radius <= 0 || damage <= 0) return { ...out, why: 'bad' };
  radius = Math.min(radius, s.d.heart.blast);
  for (let part = 0; part <= s.lights.length; part++) {
    const p = spiritPart(s, part, now);
    if (!p) continue;
    const share = hurtBy(Math.hypot(p.x - x, p.y - y, p.z - z), radius, damage);
    if (share <= 0) continue;
    const r = hurtSpirit(s, who, part, share, now);
    if (r.dealt <= 0 && !r.events.length) continue;
    out.dealt += r.dealt;
    out.parts.push([part, r.dealt]);
    out.events.push(...r.events);
  }
  return out;
}

/** The lit lights as a bit mask (bit i: light i, part i + 1). */
const maskOf = (s) => s.lights.reduce((m, l, i) => (l.lit ? m | (1 << i) : m), 0);

/**
 * The `sp` message's fields: `s` [mode, phase, health 0 to 1000, x, y, z, act, ms left of the act, tx, tz, lit
 * lights' mask] and the pools `p` [x, z, ms left] when there are any. `now`: the time it describes (the last step's).
 */
export function spiritWire(s, now = s.now) {
  const ms = Math.round(clamp(s.until - now, 0, 999999)) || 0;
  const w = { s: [MODES.indexOf(s.mode), s.phase, Math.round(clamp(s.hp / s.max, 0, 1) * 1000), r2(s.x), r2(s.y), r2(s.z), ACTS.indexOf(s.act), ms, r2(s.tx), r2(s.tz), maskOf(s)] };
  if (s.pools.length) w.p = s.pools.map((p) => [r2(p.x), r2(p.z), Math.round(clamp(p.until - now, 0, 999999))]);
  return w;
}

const POOLS_READ = 8;

/**
 * An `sp` message (or `welcome.spirit`) as a view for the look, checked field by field: null when anything is off.
 * `now`: when it arrived (the page's clock), so the look can count on from it.
 */
export function readSpirit(m, now = 0) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.s) || m.s.length !== 11) return null;
  if (!m.s.every((v) => typeof v === 'number' && fin(v)) || !fin(now)) return null;
  const [mode, phase, hp, x, y, z, act, ms, tx, tz, mask] = m.s;
  if (!Number.isInteger(mode) || mode < 0 || mode >= MODES.length) return null;
  if (!Number.isInteger(phase) || phase < 1 || phase > 3) return null;
  if (!Number.isInteger(act) || act < 0 || act >= ACTS.length) return null;
  if (!Number.isInteger(mask) || mask < 0 || mask > 255) return null;
  if (hp < 0 || hp > 1000 || ms < 0 || ms > 999999) return null;
  if (![x, y, z, tx, tz].every((v) => Math.abs(v) < 1e5)) return null;
  const pools = [];
  if (m.p !== undefined) {
    if (!Array.isArray(m.p) || m.p.length > POOLS_READ) return null;
    for (const p of m.p) {
      if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => typeof v === 'number' && fin(v) && Math.abs(v) < 1e6) || p[2] < 0) return null;
      pools.push({ x: p[0], z: p[1], ms: p[2] });
    }
  }
  return { mode: MODES[mode], phase, hp: hp / 1000, x, y, z, act: ACTS[act], ms, at: now, tx, tz, lights: mask, pools, hurtAt: -Infinity };
}

/** The live state as the same view (the page alone, the server's checks), at `now`. */
export function spiritView(s, now = s.now) {
  return {
    mode: s.mode, phase: s.phase, hp: clamp(s.hp / s.max, 0, 1), x: s.x, y: s.y, z: s.z, act: s.act,
    ms: clamp(s.until - now, 0, 999999), at: now, tx: s.tx, tz: s.tz, lights: maskOf(s),
    pools: s.pools.map((p) => ({ x: p.x, z: p.z, ms: Math.max(0, p.until - now) })), hurtAt: s.hurtAt,
  };
}

/** Seconds the act of view `v` lasts in all (0: as long as it takes, a drift). */
export function actLength(data, v) {
  if (v.mode === 'apart') return data.beaten.apart;
  if (v.mode === 'gone') return data.beaten.back;
  const p = clamp(v.phase, 1, 3) - 1;
  const a = data.attacks;
  switch (v.act) {
    case 'idle': return data.gap;
    case 'sweep': return a.sweep.tell[p];
    case 'bolt': return a.bolt.tell[p];
    case 'pool': return a.pools.tell;
    case 'open': return data.phases.window[p];
    case 'pause': return data.phases.pause[p];
    case 'sink': return data.sink.down;
    case 'under': return data.sink.gone;
    case 'rise': return data.sink.rise;
    case 'stun': return data.shell.stun;
    default: return 0;
  }
}

/**
 * What the look (world/brookSpirit.ts) needs at `now` from view `v` (readSpirit, spiritView): where it floats and
 * faces, how open its heart is (0 to 1), its shell (1 shut), its anger, where a tell will land (`reach`, during a sweep's
 * or a bolt's tell, else null), how faded it is (0 there, 1 gone) and the pulse of the last heart hit.
 */
export function spiritLook(v, now, data) {
  const L = data.look;
  const left = Math.max(0, (v.ms - (now - v.at)) / 1000);
  const t = Math.max(0, actLength(data, v) - left);
  const shell = v.lights !== 0;
  const under = v.act === 'sink' || v.act === 'under' || v.act === 'rise';
  let open = 0;
  let shield = 0;
  let anger = 0;
  let fade = 0;
  let reach = null;
  if (v.mode === 'apart') fade = clamp(t / data.beaten.apart, 0, 1);
  else if (v.mode === 'gone') fade = 1;
  else if (v.mode === 'fight' || v.mode === 'mend') {
    anger = L.anger[clamp(v.phase, 1, 3) - 1] + (TELLS.has(v.act) ? L.tell : 0);
    if (v.act === 'open' || v.act === 'stun') open = clamp(t / L.open, 0, 1);
    else if (v.act === 'pause' && !shell) open = clamp(1 - t / L.open, 0, 1);
    if (v.mode === 'mend' && !shell && !under) open = data.mend.open;
    if (shell) shield = 1;
    else if (v.act === 'stun') shield = clamp(1 - t / data.shell.fade, 0, 1);
    if (v.act === 'sink') fade = clamp(t / data.sink.down, 0, 1);
    else if (v.act === 'under') fade = 1;
    else if (v.act === 'rise') fade = clamp(1 - t / data.sink.rise, 0, 1);
    if (v.act === 'sweep' || v.act === 'bolt') reach = { x: v.tx, z: v.tz };
  }
  const facing = Math.hypot(v.tx - v.x, v.tz - v.z) > 0.01 ? Math.atan2(v.tx - v.x, v.tz - v.z) : 0;
  const hurt = fin(v.hurtAt) ? clamp(1 - (now - v.hurtAt) / (L.hurt * 1000), 0, 1) : 0;
  return { x: v.x, y: v.y, z: v.z, facing, open, shield, anger, reach, fade, hurt };
}
