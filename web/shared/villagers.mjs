// The villagers on a shared clock (Yoshi, 14 Nov 2026: "same villagers for everyone"), read by the game
// (src/world/villagers.ts draws them) and the server (server/game.mjs decides who is hit). Who walks where is
// worked out once from the paths (src/data/villagers.json) with a seeded dice, and where each one is now
// follows from the time alone, as the cats do it: every page and the server find the same villager in the
// same place without a position going over the network. The server only keeps who is down.
//
// A walker goes up and down a way of its own along the pavements (turning round at its ends, stopping now and
// then), with a dog, a child or a friend beside it; a cyclist rides a way one way and comes round again; a
// sitter is on its bench for a while and away for a while; a few stand about on each busy place.
//
// Only whole numbers go into the dice and only + - * / and square roots into the places, so two machines get
// the same answer.
import { noShoot } from './zones.mjs';

export const VKIND = { man: 0, woman: 1, elder: 2, teen: 3, child: 4, cyclist: 5, dog: 6 };
const MAN = 0, WOMAN = 1, ELDER = 2, TEEN = 3, CHILD = 4, BIKE = 5, DOG = 6;

/** How long a villager that fell stays away (s), and how long paint stays on one (s). */
export const VILLAGER_DOWN_S = 40;
export const VILLAGER_PAINT_S = 120;
/**
 * How many villagers one message may name: a blast catches a few, a shot fewer (a shotgun's pellets, a quarter of a
 * second of rifle fire). And how long between two messages (ms).
 */
export const VILLAGER_HIT_MAX = 6;
export const VILLAGER_SHOT_MAX = 3;
export const VILLAGER_HIT_MS = 250;
/** How far a shot may reach one (m), and how far a blast (m, on top of its radius). */
export const VILLAGER_RANGE = 160;

/** How much each kind of walk is used: the village's pavements, a country road's edge, a footpath. */
const WALK_WEIGHT = [1, 0.3, 0.45];
const BIKE_WEIGHT = [1, 0.6];
const SPOT_EVERY = 6; // m between a line's spots
/** Metres of (weighted) pavement to a group of walkers, and of cycle way to a cyclist. */
const WALK_M = 95;
const BIKE_M = 420;
/** People standing about on each busy place. */
export const HUB_PEOPLE = 7;
const SEED = 20261114;

/** A dice that gives the same throws everywhere (mulberry32). */
export function dice(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const far = (ax, az, bx, bz) => Math.sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz));

function line(flat) {
  const n = flat.length / 2;
  const x = [], z = [], s = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    x.push(flat[2 * i]);
    z.push(flat[2 * i + 1]);
    if (i) at += far(x[i], z[i], x[i - 1], z[i - 1]);
    s.push(at);
  }
  return { x, z, s, length: at, count: n };
}

/** The point at distance s on a line. */
function onLine(l, s) {
  const c = Math.max(0, Math.min(l.length, s));
  let i = 0;
  while (i < l.count - 2 && l.s[i + 1] <= c) i++;
  const len = l.s[i + 1] - l.s[i] || 1;
  const t = (c - l.s[i]) / len;
  return { x: l.x[i] + (l.x[i + 1] - l.x[i]) * t, z: l.z[i] + (l.z[i + 1] - l.z[i]) * t, i };
}

/**
 * A villager's way as times: `pts` its corners, `pause` how long it stands at each (s), `road` whether the
 * stretch after a corner crosses or follows a carriageway. Arriving at corner i at `ta[i]`, leaving at `td[i]`.
 */
function timed(d, pts, pause, road) {
  const n = pts.length / 2;
  const ta = [0], td = [pause[0]];
  for (let i = 1; i < n; i++) {
    ta.push(td[i - 1] + far(pts[2 * i], pts[2 * i + 1], pts[2 * i - 2], pts[2 * i - 1]) / d.pace);
    td.push(ta[i] + pause[i]);
  }
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[2 * i] / n;
    cz += pts[2 * i + 1] / n;
  }
  let r = 0;
  for (let i = 0; i < n; i++) r = Math.max(r, far(pts[2 * i], pts[2 * i + 1], cx, cz));
  d.pts = pts;
  d.road = road;
  d.ta = ta;
  d.td = td;
  d.span = td[n - 1];
  d.cx = cx;
  d.cz = cz;
  d.r = r + 2;
  return d;
}

function blank(id, kind, role, what, rank, pace) {
  return {
    id, kind, role, what, rank, pace, seed: (SEED ^ Math.imul(id + 1, 2654435761)) >>> 0,
    jog: false, lead: false, guards: false, talks: false, leader: -1, side: 0, ahead: 0, lat: 0, phase: 0, gap: 0,
    seat: -1, hub: -1, on: 0, period: 0, face: 0, gone: false, shootable: kind !== CHILD && kind !== DOG,
    pts: [0, 0], road: [false], ta: [0], td: [0], span: 0, cx: 0, cz: 0, r: 2,
  };
}

/**
 * Every villager there is: `data` the paths (src/data/villagers.json). The same list on every machine; a
 * villager's number is its place in `list`. The people on a busy place stand where `rebuildHub` puts them.
 */
export function buildVillagers(data) {
  const walks = data.walks.map(line);
  const bikes = data.bikes.map(line);
  const links = new Map();
  const link = (a, ai, l) => {
    const k = a * 65536 + ai;
    if (!links.has(k)) links.set(k, []);
    links.get(k).push(l);
  };
  for (const [a, ai, b, bi, road] of data.links) {
    link(a, ai, { to: b, idx: bi, road: !!road });
    link(b, bi, { to: a, idx: ai, road: !!road });
  }
  const hubBoost = (x, z) => {
    let w = 1;
    for (const [hx, hz, r] of data.hubs) {
      const d = far(x, z, hx, hz);
      if (d < r * 2.5) w += 2 * (1 - d / (r * 2.5));
    }
    return w;
  };
  const spotsOf = (lines, kinds, weights) => {
    const out = [];
    let total = 0;
    lines.forEach((l, i) => {
      for (let s = Math.min(2, l.length / 2); s < l.length; s += SPOT_EVERY) {
        const p = onLine(l, s);
        total += weights[kinds[i]] * hubBoost(p.x, p.z);
        out.push({ line: i, s, upTo: total });
      }
    });
    return { out, total };
  };
  const spotAt = (spots, u) => {
    let lo = 0, hi = spots.out.length - 1;
    const want = u * spots.total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spots.out[mid].upTo > want) hi = mid;
      else lo = mid + 1;
    }
    return spots.out[lo];
  };
  const list = [];
  const add = (kind, role, what, rank, pace) => {
    const d = blank(list.length, kind, role, what, rank, pace);
    list.push(d);
    return d;
  };

  /** A walk from a spot on a line, one way: corners and whether each stretch crosses a road, up to `want` metres. */
  const stroll = (r, from, s0, dir0, want) => {
    const pts = [], road = [];
    let l = from, dir = dir0, got = 0, came = -1;
    const start = onLine(walks[l], s0);
    pts.push(start.x, start.z);
    let i = dir > 0 ? start.i + 1 : start.i;
    for (let guard = 0; guard < 400 && got < want; guard++) {
      const L = walks[l];
      if (i < 0 || i >= L.count) break;
      const n = pts.length;
      const step = far(L.x[i], L.z[i], pts[n - 2], pts[n - 1]);
      if (step > 0.05) {
        pts.push(L.x[i], L.z[i]);
        road.push(false);
        got += step;
      }
      const end = dir > 0 ? i === L.count - 1 : i === 0;
      const ways = (links.get(l * 65536 + i) ?? []).filter((w) => w.to * 65536 + w.idx !== came);
      if (ways.length && (end || r() < (ways.some((w) => w.road) ? 0.18 : 0.3))) {
        const w = ways[Math.floor(r() * ways.length)];
        const B = walks[w.to];
        const idx = Math.min(w.idx, B.count - 1);
        const m = pts.length;
        const hx = pts[m - 2] - pts[m - 4], hz = pts[m - 1] - pts[m - 3];
        const cross = far(B.x[idx], B.z[idx], pts[m - 2], pts[m - 1]);
        if (cross > 0.05) {
          pts.push(B.x[idx], B.z[idx]);
          road.push(w.road);
          got += cross;
        }
        // Which way on the new line: as straight on as it can, now and then the other way.
        const j = Math.min(idx, B.count - 2);
        let nd = (B.x[j + 1] - B.x[j]) * hx + (B.z[j + 1] - B.z[j]) * hz >= 0 ? 1 : -1;
        if (r() < 0.3) nd = -nd;
        if (idx === 0) nd = 1;
        if (idx === B.count - 1) nd = -1;
        came = l * 65536 + i;
        l = w.to;
        dir = nd;
        i = idx + nd;
        continue;
      }
      if (end) break;
      i += dir;
    }
    return { pts, road };
  };

  /** A walker's way: a stroll both ways from its spot, joined. */
  const walkWay = (r, d, spot, want, endPause) => {
    const a = stroll(r, spot.line, spot.s, 1, want / 2);
    const b = stroll(r, spot.line, spot.s, -1, want / 2);
    const pts = [], road = [];
    for (let i = b.pts.length / 2 - 1; i >= 1; i--) {
      pts.push(b.pts[2 * i], b.pts[2 * i + 1]);
      road.push(b.road[i - 1]);
    }
    pts.push(...a.pts);
    road.push(...a.road, false);
    const n = pts.length / 2;
    const pause = [];
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) pause.push(endPause());
      else {
        // Now and then it stops to look round.
        const len = far(pts[2 * i], pts[2 * i + 1], pts[2 * i - 2], pts[2 * i - 1]);
        pause.push(r() < Math.min(0.4, len / (45 * d.pace)) ? 2 + r() * 5 : 0);
      }
    }
    timed(d, pts, pause, road);
    d.phase = r() * 2 * d.span;
    d.lat = 0.15 + r() * 0.3;
    if (n < 2) d.gone = true;
  };

  // ---- on foot: alone, jogging, with a dog, with a child or two, two friends
  const walkSpots = spotsOf(walks, data.wkind, WALK_WEIGHT);
  const groups = Math.round((walkSpots.total * SPOT_EVERY) / WALK_M);
  const WHAT = [['walker', 36], ['elder', 10], ['teen', 9], ['jog', 5], ['family', 9], ['dog', 7], ['chat', 8]];
  const whatSum = WHAT.reduce((a, w) => a + w[1], 0);
  for (let g = 0; g < groups; g++) {
    const r = dice(SEED + Math.imul(g + 1, 7919));
    const spot = spotAt(walkSpots, r());
    let u = r() * whatSum;
    let what = 'walker';
    for (const [name, w] of WHAT) {
      if ((u -= w) < 0) {
        what = name;
        break;
      }
    }
    const rank = r();
    const adult = () => (r() < 0.5 ? MAN : WOMAN);
    const span = (a, b) => a + r() * (b - a);
    const short = () => span(2, 7);
    if (what === 'walker') walkWay(r, add(adult(), 'walk', what, rank, span(1.2, 1.45)), spot, span(120, 320), short);
    else if (what === 'elder') walkWay(r, add(ELDER, 'walk', what, rank, span(0.8, 1.0)), spot, span(80, 200), short);
    else if (what === 'teen') walkWay(r, add(TEEN, 'walk', what, rank, span(1.3, 1.5)), spot, span(120, 320), short);
    else if (what === 'jog') {
      const d = add([MAN, WOMAN, TEEN][Math.floor(r() * 3)], 'walk', what, rank, span(2.4, 3.0));
      d.jog = true;
      walkWay(r, d, spot, span(300, 600), () => span(1, 3));
    } else if (what === 'dog') {
      const d = add(adult(), 'walk', what, rank, span(1.0, 1.25));
      d.lead = true;
      walkWay(r, d, spot, span(120, 300), short);
      const dog = add(DOG, 'follow', what, rank, d.pace);
      dog.leader = d.id;
      dog.side = span(0.35, 0.6);
      dog.ahead = span(1.2, 1.6);
    } else if (what === 'family') {
      // Someone who walks with a child is no target either.
      const d = add(adult(), 'walk', what, rank, span(1.0, 1.2));
      d.guards = true;
      d.shootable = false;
      walkWay(r, d, spot, span(100, 260), short);
      const kids = r() < 0.3 ? 2 : 1;
      for (let i = 0; i < kids; i++) {
        const c = add(CHILD, 'follow', what, rank, d.pace);
        c.leader = d.id;
        c.side = i ? -0.7 : 0.65;
        c.ahead = i ? 0.1 : -0.15;
      }
    } else {
      // Two friends: they walk side by side and stand talking at each end of their way.
      const kinds = [MAN, WOMAN, ELDER, TEEN];
      const ka = kinds[Math.floor(r() * 4)];
      const kb = kinds[Math.floor(r() * 4)];
      const d = add(ka, 'walk', what, rank, ka === ELDER || kb === ELDER ? span(0.8, 1.0) : span(1.1, 1.3));
      d.talks = true;
      walkWay(r, d, spot, span(60, 160), () => span(25, 60));
      const f = add(kb, 'follow', what, rank, d.pace);
      f.leader = d.id;
      f.talks = true;
      f.side = -0.8;
      f.ahead = 0;
    }
  }

  // ---- cyclists: one way along the cycle ways, round again after a while
  const bikeSpots = spotsOf(bikes, data.bkind, BIKE_WEIGHT);
  const riders = Math.round((bikeSpots.total * SPOT_EVERY) / BIKE_M);
  for (let g = 0; g < riders; g++) {
    const r = dice(SEED + 500009 + Math.imul(g + 1, 6151));
    const spot = spotAt(bikeSpots, r());
    const d = add(BIKE, 'ride', 'cyclist', r(), 3.6 + r() * 1.6);
    const want = 500 + r() * 700;
    const pts = [], road = [];
    let l = spot.line;
    const start = onLine(bikes[l], spot.s);
    pts.push(start.x, start.z);
    let i = start.i + 1, got = 0;
    for (let guard = 0; guard < 600 && got < want; guard++) {
      const L = bikes[l];
      if (i >= L.count) {
        const next = data.bnext[l];
        if (!next?.length) break;
        const [to, idx] = next[Math.floor(r() * next.length)];
        l = to;
        i = Math.min(idx, bikes[to].count - 1);
        continue;
      }
      const n = pts.length;
      const step = far(L.x[i], L.z[i], pts[n - 2], pts[n - 1]);
      if (step > 0.05) {
        pts.push(L.x[i], L.z[i]);
        road.push(data.bkind[l] === 1);
        got += step;
      }
      i++;
    }
    road.push(false);
    timed(d, pts, pts.map(() => 0).slice(0, pts.length / 2), road);
    d.gap = 6 + r() * 30;
    d.phase = r() * (d.span + d.gap);
    if (pts.length < 4) d.gone = true;
  }

  // ---- one on each bench, there for a while and away for a while
  const seats = [];
  data.seats.forEach(([x, z, face], i) => {
    const r = dice(SEED + 900001 + Math.imul(i + 1, 4409));
    const d = add([MAN, WOMAN, ELDER, ELDER, TEEN][Math.floor(r() * 5)], 'sit', 'sit', r(), 1);
    d.seat = i;
    d.face = face;
    d.on = 60 + r() * 90;
    d.period = d.on + 40 + r() * 80;
    d.phase = r() * d.period;
    d.pts = [x, z];
    d.cx = x;
    d.cz = z;
    seats.push(d.id);
  });

  // ---- the busy places: who stands about there (where, `rebuildHub` says)
  const hubBase = list.length;
  data.hubs.forEach(([x, z, rad, kind], h) => {
    for (let n = 0; n < HUB_PEOPLE; n++) {
      const r = dice(SEED + 1300021 + Math.imul(h * HUB_PEOPLE + n + 1, 3571));
      const k = kind === 1 ? [MAN, WOMAN, CHILD, CHILD][Math.floor(r() * 4)] : [MAN, WOMAN, ELDER, TEEN, MAN, WOMAN][Math.floor(r() * 6)];
      const d = add(k, 'hub', 'hub', r(), k === ELDER ? 0.8 + r() * 0.2 : 1.0 + r() * 0.3);
      d.hub = h;
      // At the school the grown-ups stand among the children: no target, as someone walking with a child is none.
      if (kind === 1) d.shootable = false;
      d.cx = x;
      d.cz = z;
      d.r = rad + 8;
      d.gone = true;
    }
  });
  // Whoever walks beside someone is where that one is.
  for (const d of list) {
    if (d.role !== 'follow') continue;
    const l = list[d.leader];
    d.cx = l.cx;
    d.cz = l.cz;
    d.r = l.r + 2;
    d.gone = l.gone;
  }
  const set = { list, hubBase, hubs: data.hubs, seats: data.seats };
  data.hubs.forEach((_, h) => rebuildHub(set, h, data.hubspots?.[h] ?? []));
  return set;
}

/**
 * The people of busy place `h` stand about on `spots` (x, z, ...): each goes up and down a round of a few
 * spots near each other, standing a while at each. A page gives the spots that are free in its world; the
 * server takes them all (it only needs to know they are on the place).
 */
export function rebuildHub(set, h, spots) {
  const n = Math.floor(spots.length / 2);
  const [hx, hz, rad] = set.hubs[h];
  for (let k = 0; k < HUB_PEOPLE; k++) {
    const d = set.list[set.hubBase + h * HUB_PEOPLE + k];
    const r = dice(d.seed + 77);
    if (n < 2) {
      d.gone = true;
      continue;
    }
    let at = Math.floor(r() * n);
    const pts = [spots[2 * at], spots[2 * at + 1]];
    const stops = 5 + Math.floor(r() * 5);
    for (let s = 0; s < stops; s++) {
      // The next spot: one 3 to 14 m on, if there is one.
      const near = [];
      for (let i = 0; i < n; i++) {
        const dd = far(spots[2 * i], spots[2 * i + 1], spots[2 * at], spots[2 * at + 1]);
        if (dd > 3 && dd < 14) near.push(i);
      }
      at = near.length ? near[Math.floor(r() * near.length)] : Math.floor(r() * n);
      pts.push(spots[2 * at], spots[2 * at + 1]);
    }
    const pause = [];
    for (let i = 0; i < pts.length / 2; i++) pause.push(2 + r() * 10);
    timed(d, pts, pause, pause.map(() => false));
    d.phase = r() * 2 * d.span;
    d.gone = false;
    // Its bounds stay the place's own: the server and every page agree on those whatever spots they took.
    d.cx = hx;
    d.cz = hz;
    d.r = rad + 8;
  }
}

const mod = (a, n) => ((a % n) + n) % n;

/**
 * Where villager `i` is at time `t` (s on the shared clock), into `out`:
 * x, z, yaw (the way it faces), hx and hz (the way it goes), speed (m/s; 0 standing), here (false: away for now), road (on a carriageway),
 * sit, talk (standing with its friend).
 */
export function villagerPose(set, i, t, out) {
  const d = set.list[i];
  out.sit = false;
  out.talk = false;
  out.road = false;
  out.speed = 0;
  out.here = !d.gone;
  out.hx = 0;
  out.hz = 1;
  if (d.role === 'follow') {
    villagerPose(set, d.leader, t, out);
    const fx = out.hx, fz = out.hz;
    out.x += -fz * d.side + fx * d.ahead;
    out.z += fx * d.side + fz * d.ahead;
    if (out.talk) {
      // Friends face each other while they stand.
      out.yaw = Math.atan2(-fz * -d.side, fx * -d.side);
    }
    return out;
  }
  if (d.role === 'sit') {
    out.x = d.pts[0];
    out.z = d.pts[1];
    out.yaw = d.face;
    out.sit = true;
    out.here = mod(t + d.phase, d.period) < d.on;
    return out;
  }
  if (d.gone) {
    out.x = d.cx;
    out.z = d.cz;
    out.yaw = 0;
    return out;
  }
  const n = d.pts.length / 2;
  let u;
  let back = false;
  if (d.role === 'ride') {
    u = mod(t + d.phase, d.span + d.gap);
    if (u >= d.span) {
      out.here = false;
      u = d.span;
    }
  } else {
    u = mod(t + d.phase, 2 * d.span);
    if (u > d.span) {
      u = 2 * d.span - u;
      back = true;
    }
  }
  // The corner it last came to (going out).
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (d.ta[mid] <= u) lo = mid;
    else hi = mid - 1;
  }
  const a = lo;
  const moving = u > d.td[a] && a < n - 1;
  // The stretch it is on, or (standing) the one it faces along.
  const seg = moving ? a : back ? Math.max(0, a - 1) : Math.min(n - 2, a);
  const ax = d.pts[2 * seg], az = d.pts[2 * seg + 1];
  const bx = d.pts[2 * seg + 2] ?? ax, bz = d.pts[2 * seg + 3] ?? az;
  const len = far(ax, az, bx, bz) || 1;
  let dx = (bx - ax) / len, dz = (bz - az) / len;
  if (moving) {
    const f = (u - d.td[a]) / (d.ta[a + 1] - d.td[a] || 1);
    out.x = ax + (bx - ax) * f;
    out.z = az + (bz - az) * f;
    out.speed = d.pace;
    out.road = !!d.road[a];
  } else {
    out.x = d.pts[2 * a];
    out.z = d.pts[2 * a + 1];
    out.talk = d.talks && (a === 0 || a === n - 1);
  }
  if (back) {
    dx = -dx;
    dz = -dz;
  }
  out.yaw = Math.atan2(dx, dz);
  out.hx = dx;
  out.hz = dz;
  // A little to the right of its way.
  out.x += -dz * d.lat;
  out.z += dx * d.lat;
  if (out.talk) out.yaw = Math.atan2(-dz * -0.8, dx * -0.8);
  return out;
}

const _pose = { x: 0, z: 0, yaw: 0, hx: 0, hz: 1, speed: 0, here: true, road: false, sit: false, talk: false };

/**
 * For the server: whether villager `i` can be hit at time `t` (s) by someone at (px, pz) reaching `reach`
 * metres. Its number must be one of the list, it must be a kind that can be hit (never a child, a dog or
 * someone with a child), out now, outside the places where nobody shoots, and near enough. `slack` covers
 * what a page may show differently: a villager that stopped to wave, the delay of the network.
 */
export function villagerHittable(set, i, t, px, pz, reach) {
  if (!Number.isInteger(i) || i < 0 || i >= set.list.length) return false;
  const d = set.list[i];
  if (!d.shootable || d.gone) return false;
  const p = villagerPose(set, i, t, _pose);
  if (!p.here) return false;
  if (d.role === 'hub') {
    // On a busy place a page picks the free spots itself: the server knows only that it is on the place.
    if (noShoot(d.cx, d.cz)) return false;
    return far(px, pz, d.cx, d.cz) <= reach + d.r;
  }
  if (noShoot(p.x, p.z)) return false;
  return far(px, pz, p.x, p.z) <= reach + 10;
}
