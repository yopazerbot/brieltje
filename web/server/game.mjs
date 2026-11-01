// The shared house: the logged-in players over WebSocket (4 at once unless the admin allows more).
// Players send their position 20 times a second while they move (a few times a second standing
// still); twenty times a second the server sends every page what moved (shared/wire.mjs: players,
// cars, horses, strongmen), and forwards chat, door changes and shots. The admin can kick players.
// Pages from before protocol 2 (still open during a deploy) get the old full states ten times a
// second. Every two seconds the server pings each page and keeps the time there and back.
//
// Combat (players in Action mode only): the shooter's browser reports a hit,
// the server checks it is plausible and keeps health, kills, deaths, points,
// respawns and rounds. Players in Explore mode can't be hurt.
//
// The cars (shared/car.json: the Tesla and the Model 3 at home, a Model Y and a Model 3 by the
// church): one of each for everyone. One player at a time drives a car and one more can ride
// along as the passenger; the driver's position updates are the car's, so they (and the
// passenger, who moves with it) may move at the car's speed. A car stays where they leave it
// and is back in its parking spot when the server restarts.
//
// The portals (shared/portals.mjs): a player on one asks to travel to another, or types /church
// in the chat (when the admin allows it); the server checks it and moves them (see travel()).

import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { Modes, TEAM_COLORS } from './modes.mjs';
import { bruteDamage, hurtBy, newBrute, stepBrute } from '../shared/brutes.mjs';
import { makeTerrain } from '../shared/terrain.mjs';
import { CAR_REACH, PORTALS, portalNear, REACH } from '../shared/portals.mjs';
import { noShoot } from '../shared/zones.mjs';
import { bruteEntry, carFields, horseFields, playerFields, PROTO, TICK_MS } from '../shared/wire.mjs';

const MAX_PLAYERS = 16; // the most the admin can allow at once (every player's moves go to every other one)
const KEYFRAME = 20; // ticks: everything goes to every page at least this often (once a second), moved or not
const OLD_EVERY = 2; // ticks: pages from before protocol 2 get the full states every other tick (ten a second, as before)
const PING_MS = 2000;
// A page that sends nothing this long, not even the answer to a ping (a phone or tablet gone to sleep,
// Wi-Fi gone without a goodbye), is let go: its connection can stay open on our side for many minutes,
// and with it its place in the house, the car it drove and its part in a game ("it" in tag).
const SILENT_MS = 30_000;
/** The server's own clock for the ticks (ms): monotonic, unlike the wall clock. */
const mono = () => Math.round(performance.now());
const COLORS = ['#f2b33d', '#4fa3e0', '#e0614f', '#5cc28a', '#c77dff', '#ff8fab', '#7ae0e6', '#f4e04d', '#a0c4ff', '#ff9f43', '#b8e994', '#e66767', '#9aa5b1', '#d4a373', '#70d6ff', '#e9c46a'];

const shared = (file) => JSON.parse(readFileSync(new URL(`../shared/${file}`, import.meta.url), 'utf8'));
const SPAWNS = shared('spawns.json');
const WEAPONS = shared('weapons.json'); // damage, pellets and fire rate per weapon
const GRENADE = shared('grenade.json'); // how many each player carries, when one is back, fuse, blast
const PICKUPS = shared('pickups.json');
const CATS = shared('cats.json'); // cats walk on a shared clock; the server only keeps who is down
const CLOWNS = shared('clowns.json'); // clowns and strongmen too; the admin adds and removes them
const kindOf = (k) => (typeof k === 'string' && Object.hasOwn(CLOWNS.kinds, k) ? k : 'clown');
const FIGHT = CLOWNS.kinds.strongman.fight; // how the strongmen fight back (shared/brutes.mjs)

/** The relief of the surroundings (shared/terrain.mjs): heights above the flat ground. */
const TERRAIN = makeTerrain(JSON.parse(readFileSync(new URL('../shared/terrain.json', import.meta.url), 'utf8')));
/** Where anyone can be: the relief's grid (the house, the ring, the village of Smetlede and Molenhoek to its end, with a margin). */
const AREA = {
  x0: TERRAIN.x0, x1: TERRAIN.x0 + (TERRAIN.nx - 1) * TERRAIN.step,
  z0: TERRAIN.z0, z1: TERRAIN.z0 + (TERRAIN.nz - 1) * TERRAIN.step,
};
/** A position from a message, kept within the area (heights: from below the lowest ground to above the church tower). */
const where = (m) => ({ x: num(m.x, AREA.x0, AREA.x1), y: num(m.y, -20, 100), z: num(m.z, AREA.z0, AREA.z1) });

/**
 * Where a strongman has room to stand: a map of the ground in 1 m squares with every wall, hedge,
 * fence and house from the house data marked (anything from 0.4 to 2.5 m above the ground: on
 * the relief a house stands at the ground's height in its middle, a hedge or fence (d) follows it).
 * The house's blocks, the surroundings' and the village's (src/data/village.json); a lookup is one
 * array read, however many blocks there are.
 */
function groundMap() {
  const read = (file) => JSON.parse(readFileSync(new URL(`../src/data/${file}`, import.meta.url), 'utf8'));
  const HOUSE = read('house.json');
  const VILLAGE = read('village.json');
  const prisms = [...HOUSE.prisms, ...(HOUSE.surroundings?.prisms ?? []), ...(VILLAGE.prisms ?? [])];
  const ox = Math.floor(AREA.x0);
  const oz = Math.floor(AREA.z0);
  const nx = Math.ceil(AREA.x1) - ox;
  const nz = Math.ceil(AREA.z1) - oz;
  const blocked = new Uint8Array(nx * nz);
  const inside = (x, z, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  for (const p of prisms) {
    const ring = p.p[0];
    const lift = p.d ? 0 : TERRAIN.height(ring.reduce((a, v) => a + v[0], 0) / ring.length, ring.reduce((a, v) => a + v[1], 0) / ring.length);
    if (p.y1 - lift < 0.4 || p.y0 - lift > 2.5) continue;
    const xs = ring.map((v) => v[0]);
    const zs = ring.map((v) => v[1]);
    for (let x = Math.max(ox, Math.floor(Math.min(...xs))); x <= Math.min(ox + nx - 1, Math.ceil(Math.max(...xs))); x++) {
      for (let z = Math.max(oz, Math.floor(Math.min(...zs))); z <= Math.min(oz + nz - 1, Math.ceil(Math.max(...zs))); z++) {
        if (inside(x + 0.5, z + 0.5, ring) || inside(x, z, ring)) blocked[(x - ox) * nz + (z - oz)] = 1;
      }
    }
  }
  // A strongman is about 1.2 m wide: room means no marked square within a metre.
  return (x, z) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cx = Math.floor(x) + dx - ox;
        const cz = Math.floor(z) + dz - oz;
        if (cx < 0 || cz < 0 || cx >= nx || cz >= nz || blocked[cx * nz + cz]) return false;
      }
    }
    return true;
  };
}
const CARS = shared('car.json'); // the cars: where each is parked, its size and top speed
const HORSES = shared('horses.json'); // the horses: their walks on the shared clock, riding speeds
const FURNITURE = shared('furniture.json'); // planner catalogue: which items exist, how many may be placed
const FURNITURE_IDS = new Set(FURNITURE.items.map((i) => i.id));
const DEFAULT_FURNITURE = shared('default_furniture.json').pieces.map(([item, x, y, z, yaw]) => ({ item, x, y, z, yaw }));
const LAYOUT_VERSION = String(shared('default_furniture.json').version ?? 1);
// Bumped in the layout file to put the starting layout back once, even over changes (Yoshi, 31 Oct 2026: the furniture was gone).
const LAYOUT_RESTORE = String(shared('default_furniture.json').restore ?? 0);
/**
 * House rules the admin sets in the settings, with their defaults. `paintball` (child-friendly for
 * everyone) only changes what the pages show: Action as Paintball, with the same hits and scores.
 */
const RULES = { flying: true, furniture: true, names: true, maxPlayers: 4, pin: true, portals: true, travel: true, paintball: false };
/** A valid value for a rule: on/off, or a number of players from 2 to MAX_PLAYERS. */
const ruleOk = (k, v) => (k === 'maxPlayers' ? Number.isInteger(v) && v >= 2 && v <= MAX_PLAYERS : typeof v === 'boolean');
/** Weapons only the admin carries (the bazooka), on top of the pistol everyone starts with. */
const ADMIN_WEAPONS = Object.keys(WEAPONS).filter((w) => WEAPONS[w].admin);
const loadout = (role) => new Set(['pistol', ...(role === 'admin' ? ADMIN_WEAPONS : [])]);
const PICKUP_MS = 20000; // a taken weapon comes back after this
const HEALTH = 100;
const POINTS = { kill: 100, headshot: 50 };
const KILL_LIMIT = 10; // first to this many kills wins the round
const RESPAWN_MS = 3000;
const PROTECT_MS = 2000; // can't be hurt just after respawning (ends when you shoot)
const ROUND_BREAK_MS = 8000;
const MAX_HIT_RANGE = 120; // m
const MAX_SPEED = 16; // m/s: sprinting is 10, falling off the roof about 13
const ADMIN_SPEED = 16 * 15; // m/s: the admin may move extremely fast (src/player.ts turbo)
const CAR_SPEED = Math.max(...Object.values(CARS.cars).map((c) => c.maxSpeed)) * 1.2; // m/s in a car, with room for network jitter
const HORSE_SPEED = HORSES.gallop * 1.3; // m/s on horseback
const TRAVEL_MS = 1500; // at most one trip through the portals this often
const TRAVEL_SLACK = 3; // m: the server's idea of where you are may lag a little behind yours

/** Where horse i is on its walk at time t (s, the shared clock): the same as horseOnLoop in horses.ts. */
function horseOnLoop(i, t) {
  const { loop, graze } = HORSES.herd[i];
  const legs = loop.map((p, k) => {
    const q = loop[(k + 1) % loop.length];
    return { from: p, to: q, time: Math.hypot(q[0] - p[0], q[1] - p[1]) / HORSES.speed };
  });
  const cycle = legs.reduce((sum, l) => sum + l.time + graze, 0);
  let u = (((t + i * 11) % cycle) + cycle) % cycle;
  for (const l of legs) {
    const heading = Math.atan2(l.to[0] - l.from[0], l.to[1] - l.from[1]);
    if (u < graze) return { x: l.from[0], z: l.from[1], heading };
    u -= graze;
    if (u < l.time) return { x: l.from[0] + ((l.to[0] - l.from[0]) * u) / l.time, z: l.from[1] + ((l.to[1] - l.from[1]) * u) / l.time, heading };
    u -= l.time;
  }
  return { x: loop[0][0], z: loop[0][1], heading: 0 };
}

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

export class Game {
  constructor(auth, allowedHosts) {
    this.auth = auth;
    this.allowedHosts = allowedHosts;
    // No compression: chat (typed by players) shares the connection with game state.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
    this.players = new Map(); // username -> { ws, role, color, state, lastChat }
    this.doors = {}; // door id -> open
    this.doorDir = {}; // door id -> 1 or -1: the way a double-action door swings
    this.rules = { ...RULES };
    this.broken = new Set(); // window pane numbers that are broken
    this.scores = new Map(); // username -> { kills, deaths, points }, kept over reconnects until the next round
    this.roundOver = null; // { winner, until } during the break after a round
    this.items = PICKUPS.map(() => ({ until: 0 })); // weapons lying around: taken until
    this.lastPos = new Map(); // username -> last position, so a reconnect is checked against it
    this.catsDown = CATS.cats.map(() => 0); // cat index -> down until
    // Clowns and strongmen: id -> { id, x, y, z, kind, until (down until) }; the starting ones, then the admin's (until a restart).
    this.clowns = this.startingClowns();
    this.free = groundMap(); // where the strongmen have room to walk
    this.rocks = []; // strongmen's rocks in the air: { id, to, at (lands at) }
    this.nextClown = CLOWNS.spots.length + 1;
    this.furniture = new Map(); // id -> placed piece (kept in the database)
    this.cars = Object.fromEntries(Object.entries(CARS.cars).map(([id, c]) => [id, { id, ...c.park, s: 0, driver: null, passenger: null }]));
    // Horses: on their walks until someone rides one; left where they are got off (until a restart).
    this.horses = HORSES.herd.map((_, i) => ({ i, x: 0, z: 0, yaw: 0, speed: 0, rider: null, parked: false }));
    this.modes = new Modes(this); // hide and seek, tag, treasure hunt (the admin starts them)
    // The ticks (see snapshot): their count, and what each car, horse and strongman looked like in the
    // last one, kept here so the objects sent in 'car' and 'horse' messages stay as they are.
    this.tickNo = 0;
    this.sent = new Map(); // 'c' + car id, 'h' + horse, 'b' + strongman id -> its fields in the last tick
    this.carAt = {}; // car id -> when its pose was taken (the server's clock, ms)
    this.horseAt = this.horses.map(() => 0);
    setInterval(() => this.tick(), TICK_MS).unref();
    // Sessions can end while connected (logout, password reset, user deleted,
    // kicked, expired): close those connections within a second.
    setInterval(() => {
      for (const [name, p] of this.players) {
        if (!this.auth.sessions.has(p.key)) p.ws.close(4002, 'Session ended');
      }
    }, 1000).unref();
  }

  /** HTTP upgrade to WebSocket: only same-site pages with a valid session. */
  upgrade(req, socket, head) {
    const origin = String(req.headers.origin || '');
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      // no or invalid Origin header
    }
    const session = this.auth.session(req);
    if (!host || host !== req.headers.host || !session) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const already = this.players.has(session.username);
    if (!already && this.players.size >= this.rules.maxPlayers) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return socket.destroy();
    }
    // The page asks for the ticks it reads (/ws?v=2, shared/wire.mjs); without, it is from before them.
    const v = Number(new URL(req.url, 'http://local').searchParams.get('v'));
    const proto = v >= PROTO ? PROTO : 1;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.join(ws, session, req, proto));
  }

  join(ws, session, req, proto = 1) {
    const name = session.username;
    const old = this.players.get(name);
    if (old) old.ws.close(4000, 'Logged in somewhere else');
    this.releaseCar(name); // the replaced connection was driving
    this.releaseHorse(name);
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
    const now = Date.now();
    const score = this.scores.get(name) || { kills: 0, deaths: 0, points: 0 };
    this.scores.set(name, score);
    const player = {
      ws, key: session.key, role: session.role, color, state: null, lastChat: 0, msgs: 0, window: now, address: this.auth.addressOf(req),
      score, hp: HEALTH, alive: true, respawnAt: 0, protectedUntil: now + PROTECT_MS, nextHit: 0, weapons: loadout(session.role), joinTime: now, spawned: false,
      nades: Array(GRENADE.carry).fill(0), thrown: [],
      // The ticks: which the page reads, when its state was taken (`stamp`, the server's clock), whether
      // it sent one since the last tick, a counter of the server's moves (respawn, portal), the state
      // in the last tick, its turn in the keyframe, and the first tick with everything.
      proto, stamp: mono(), fresh: false, warp: 0, sentKey: '', slot: randomInt(KEYFRAME), full: true,
      states: 0, others: 0, pingN: 0, pingAt: 0, pingNext: mono() + 500, rtt: null, rttAvg: null, ctGap: null, ctAt: 0,
      heard: mono(), // the last message from the page (see SILENT_MS)
    };
    // Where the server believes they are: the replaced connection, their last visit, or
    // the street (where everyone starts). Their first update is limited like any other.
    const at = old?.state ?? this.lastPos.get(name) ?? SPAWNS[0];
    player.state = { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false };
    player.joinedAt = { x: at.x, z: at.z }; // a start place is only taken from here (see spawn)
    player.movedAt = now;
    player.budget = 0.5;
    this.players.set(name, player);
    this.auth.log('mp_join', req, { username: name });

    this.send(ws, {
      t: 'welcome', proto: PROTO, you: name, role: session.role, color, doors: this.doors, doorDir: this.doorDir, broken: [...this.broken], players: this.roster(),
      time: now, cats: this.catsDown.map((until) => Math.max(0, until - now)), clowns: this.clownList(now), furniture: [...this.furniture.values()], rules: this.rules,
      scores: this.scoreList(), limit: KILL_LIMIT, items: this.items.map((it) => now >= it.until), round: this.roundOver ? { winner: this.roundOver.winner, ms: this.roundOver.until - now } : null,
      cars: Object.values(this.cars), horses: this.horses, mode: this.modes.view(now),
    });
    this.broadcast({ t: 'join', name, color }, name);
    this.modes.join(name);
    this.broadcast({ t: 'scores', list: this.scoreList() }, name);

    ws.on('message', (raw) => this.receive(name, player, raw));
    ws.on('close', () => {
      if (this.players.get(name) === player) {
        if (player.state) this.lastPos.set(name, { x: player.state.x, y: player.state.y, z: player.state.z });
        this.players.delete(name);
        this.releaseCar(name);
        this.releaseHorse(name);
        this.modes.leave(name);
        this.broadcast({ t: 'leave', name });
        this.broadcast({ t: 'scores', list: this.scoreList() });
      }
    });
  }

  /** A clown or a strongman (who also gets the fight in him: health, where he is, what he does). */
  character(id, x, y, z, kind) {
    return { id, x, y, z, kind, until: 0, ...(kind === 'strongman' ? { brain: newBrute(id, x, y, z, FIGHT) } : {}) };
  }

  /** The strongmen for pages from before protocol 2: where each is, what he does, his health. */
  bruteList() {
    return [...this.clowns.values()]
      .filter((c) => c.brain)
      .map(({ id, brain: b }) => ({ id, x: +b.x.toFixed(2), z: +b.z.toFixed(2), yaw: +b.yaw.toFixed(3), speed: +b.speed.toFixed(2), act: b.act, hp: b.hp }));
  }

  /** The strongmen take a step; what they throw lands later, a stomp hurts at once. */
  stepBrutes(now) {
    const fighting = !this.roundOver && !this.modes.peaceful;
    const targets = fighting
      ? [...this.players].filter(([n, p]) => p.alive && p.state?.armed && !this.inCar(n) && now >= p.protectedUntil).map(([name, p]) => ({ name, x: p.state.x, y: p.state.y, z: p.state.z }))
      : [];
    for (const c of this.clowns.values()) {
      if (!c.brain) continue;
      if (now < c.until) continue; // down
      if (c.brain.hp <= 0) Object.assign(c.brain, newBrute(c.id, c.x, c.y, c.z, FIGHT)); // back, fresh, at his spot
      c.brain.y = c.y + TERRAIN.height(c.brain.x, c.brain.z); // on the relief: rocks leave and stomps land at his feet
      for (const e of stepBrute(c.brain, targets, now, TICK_MS / 1000, FIGHT, this.free)) {
        if (e.type === 'throw') {
          this.rocks.push({ id: c.id, to: e.to, at: now + e.ms });
          this.broadcast({ t: 'rock', ...e });
        } else {
          this.broadcast({ t: 'stomp', ...e });
          this.bruteHits(e.at, FIGHT.stompRadius, FIGHT.stompDamage, now);
        }
      }
    }
    for (const r of this.rocks.filter((q) => now >= q.at)) this.bruteHits(r.to, FIGHT.rockRadius, FIGHT.rockDamage, now);
    this.rocks = this.rocks.filter((q) => now < q.at);
  }

  /** A rock landing or a stomp: everyone near it who fights is hurt by distance. */
  bruteHits(at, radius, damage, now) {
    if (this.roundOver || this.modes.peaceful) return;
    for (const [name, p] of this.players) {
      if (!p.alive || !p.state?.armed || this.inCar(name) || now < p.protectedUntil) continue;
      const s = p.state;
      if (Math.abs(s.y - at.y) > 2.5) continue;
      this.npcDamage(name, p, hurtBy(Math.hypot(s.x - at.x, s.z - at.z), radius, damage), now);
    }
  }

  /** A strongman loses health; at nothing he goes down for everyone. */
  hurtBrute(c, name, amount, w, now) {
    c.brain.hp = Math.max(0, c.brain.hp - amount);
    if (c.brain.hp > 0) return;
    c.until = now + CLOWNS.respawnSeconds * 1000;
    this.broadcast({ t: 'clownhit', id: c.id, by: name, ms: CLOWNS.respawnSeconds * 1000, w });
  }

  /** Health taken by a strongman: like damage(), but nobody scores the kill. */
  npcDamage(targetName, target, amount, now) {
    if (!target.alive || amount <= 0 || this.calm(target)) return;
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp > 0) return this.send(target.ws, { t: 'hurt', hp: target.hp, by: 'a strongman' });
    target.alive = false;
    target.respawnAt = now + RESPAWN_MS;
    this.releaseCar(targetName);
    this.releaseHorse(targetName);
    target.score.deaths++;
    target.weapons = loadout(target.role); // dropped what they picked up
    this.broadcast({ t: 'kill', killer: 'a strongman', victim: targetName, head: false, w: 'strongman' });
    this.stats(targetName, { deaths: 1 });
    this.broadcast({ t: 'scores', list: this.scoreList() });
  }

  clownList(now = Date.now()) {
    return [...this.clowns.values()].map(({ id, x, y, z, kind, until }) => ({ id, x, y, z, kind, ms: Math.max(0, until - now) }));
  }

  roster() {
    return [...this.players.entries()].map(([name, p]) => ({ name, color: this.colorOf(name, p), role: p.role }));
  }

  /** What the admin's scoreboard (web/public/admin/scores/) shows: the scores, the round, the game being played. */
  board(now = Date.now()) {
    return {
      players: this.scoreList(), limit: KILL_LIMIT, points: POINTS,
      round: this.roundOver ? { winner: this.roundOver.winner, ms: Math.max(0, this.roundOver.until - now) } : null,
      mode: this.modes.view(now), peaceful: this.modes.peaceful,
    };
  }

  scoreList() {
    return [...this.players.entries()].map(([name, p]) => ({
      name, color: this.colorOf(name, p), kills: p.score.kills, deaths: p.score.deaths, points: p.score.points, alive: p.alive, armed: !!p.state?.armed,
    }));
  }

  /** A message from a player's browser. A mistake handling one is logged, never fatal to the server. */
  receive(name, player, raw) {
    player.heard = mono();
    try {
      this.handle(name, player, raw);
    } catch (e) {
      console.error(JSON.stringify({ event: 'message_failed', username: name, error: String(e) }));
    }
  }

  handle(name, player, raw) {
    // Flood guard: at most 80 messages a second per player, of which at most 30 states (a page sends
    // 20 while moving) and 40 of everything else (shots, hits, doors...).
    const now = Date.now();
    if (now - player.window > 1000) {
      player.window = now;
      player.msgs = player.states = player.others = 0;
    }
    if (++player.msgs > 80) return;
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'state' ? ++player.states > 30 : ++player.others > 40) return;
    if (this.modes.peaceful && ['hit', 'rocket', 'nade', 'boom'].includes(m.t)) return; // no fighting during a party game

    if (m.t === 'state') {
      const prev = player.state;
      const wasArmed = !!prev?.armed;
      const car = this.carOf(name);
      const driving = car?.driver === name;
      const inCar = !!car;
      const horse = this.horseOf(name);
      const next = {
        ...where(m),
        yaw: num(m.yaw, -100, 100), pitch: num(m.pitch, -2, 2), armed: !!m.armed, flying: !!m.flying && this.rules.flying && !inCar,
        w: player.weapons.has(m.w) ? m.w : 'pistol', c: !!m.c && !inCar, d: inCar, s: driving ? num(m.s, -1, 1) : 0,
      };
      // Never faster than anyone can move: a movement budget refills at MAX_SPEED (the car's
      // speed for its driver; at most half a second's worth stored) and each update spends it,
      // however often updates come. A faked jump only gets as far as running would; a lagging
      // player catches up.
      const speed = inCar ? CAR_SPEED : horse ? HORSE_SPEED : player.role === 'admin' ? ADMIN_SPEED : MAX_SPEED;
      const budget = Math.min(speed * 0.5 + 0.5, player.budget + (speed * (now - player.movedAt)) / 1000);
      const dx = next.x - prev.x, dy = next.y - prev.y, dz = next.z - prev.z;
      const dist = Math.hypot(dx, dy, dz);
      const step = Math.min(dist, budget);
      if (dist > step) Object.assign(next, { x: prev.x + (dx * step) / dist, y: prev.y + (dy * step) / dist, z: prev.z + (dz * step) / dist });
      player.budget = budget - step;
      player.movedAt = now;
      player.state = next;
      this.stampState(player, m.ct);
      if (driving) {
        Object.assign(car, { x: next.x, y: next.y, z: next.z, yaw: next.yaw, s: next.s });
        this.carAt[car.id] = player.stamp;
      }
      if (horse) {
        Object.assign(horse, { x: next.x, z: next.z, yaw: num(m.hy, -100, 100), speed: num(m.hs, -2, HORSES.gallop), jump: num(m.hj, 0, HORSES.jump.height) });
        this.horseAt[horse.i] = player.stamp;
      }
      if (player.state.armed !== wasArmed) this.broadcast({ t: 'scores', list: this.scoreList() });
    } else if (m.t === 'pong') {
      // The answer to the server's ping (see pings): only to the one asked, once.
      if (!player.pingN || m.n !== player.pingN) return;
      player.pingN = 0;
      player.rtt = mono() - player.pingAt;
      player.rttAvg = player.rttAvg === null ? player.rtt : player.rttAvg * 0.7 + player.rtt * 0.3;
    } else if (m.t === 'chat') {
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
      if (!text || now - player.lastChat < 700) return;
      player.lastChat = now;
      this.broadcast({ t: 'chat', from: name, color: player.color, text });
    } else if (m.t === 'door' && typeof m.id === 'string' && /^[a-z0-9-]{1,30}$/.test(m.id)) {
      if (!(m.id in this.doors) && Object.keys(this.doors).length >= 100) return;
      this.doors[m.id] = !!m.open;
      if (m.dir === 1 || m.dir === -1) this.doorDir[m.id] = m.dir;
      this.broadcast({ t: 'door', id: m.id, open: !!m.open, dir: this.doorDir[m.id] ?? 1, by: name }, name);
    } else if (m.t === 'glass' && Number.isInteger(m.i) && m.i >= 0 && m.i < 4000) { // house blocks, then door glass from 3000
      if (this.broken.size >= 200 || this.broken.has(m.i)) return;
      this.broken.add(m.i);
      this.broadcast({ t: 'glass', i: m.i, by: name }, name);
    } else if (m.t === 'repair') {
      if (now - (this.lastRepair || 0) < 2000) return;
      this.lastRepair = now;
      this.broken.clear();
      this.broadcast({ t: 'repair', by: name });
    } else if (m.t === 'shot') {
      if (this.calm(player)) return; // the school grounds (shared/zones.mjs)
      this.broadcast({
        t: 'shot', name, w: player.weapons.has(m.w) ? m.w : 'pistol',
        ...where(m),
      }, name);
    } else if (m.t === 'furn') {
      if (now < (player.nextFurn || 0)) return;
      player.nextFurn = now + 150;
      this.furnish(name, player, m).catch((e) => console.error('furniture failed', String(e)));
    } else if (m.t === 'clownhit' && this.clowns.has(m.id) && this.clowns.get(m.id).brain) {
      // A strongman takes a while to bring down: each shot (a shotgun blast counts once) takes health.
      // Bullets only: blasts are set off here on the server (blast()), so nobody can claim one.
      const c = this.clowns.get(m.id);
      const w = player.state?.w;
      if (m.w === 'grenade' || m.w === 'bazooka' || now < c.until || !player.alive || !player.state?.armed || !player.weapons.has(w)) return;
      if (this.calm(player)) return;
      if (now < (player.nextBrute || 0)) return;
      player.nextBrute = now + (WEAPONS[w]?.delay ?? 0.1) * 800;
      this.hurtBrute(c, name, bruteDamage(w, WEAPONS), w, now);
    } else if (m.t === 'clownhit' && this.clowns.has(m.id)) {
      // Like the cats: no points, at most one every 300 ms per player.
      const c = this.clowns.get(m.id);
      if (now < c.until || !player.alive || !player.state?.armed || now < (player.nextCat || 0)) return;
      player.nextCat = now + 300;
      c.until = now + CLOWNS.respawnSeconds * 1000;
      this.broadcast({ t: 'clownhit', id: m.id, by: name, ms: CLOWNS.respawnSeconds * 1000, w: m.w === 'grenade' ? 'grenade' : player.state.w }, name);
    } else if (m.t === 'clown' && player.role === 'admin') {
      // The admin places a clown (from the planner) or takes one away.
      if (m.op === 'add' && this.clowns.size < CLOWNS.max) {
        const x = num(m.x, AREA.x0, AREA.x1);
        const y = num(m.y, -20, 40);
        const z = num(m.z, AREA.z0, AREA.z1);
        const id = this.nextClown++;
        this.clowns.set(id, this.character(id, +x.toFixed(2), +y.toFixed(2), +z.toFixed(2), kindOf(m.kind)));
      } else if (m.op === 'remove' && this.clowns.has(m.id)) {
        this.clowns.delete(m.id);
      } else return;
      this.broadcast({ t: 'clowns', list: this.clownList(now) });
    } else if (m.t === 'cat' && Number.isInteger(m.i) && m.i >= 0 && m.i < CATS.cats.length) {
      // Just for fun: no points. At most one cat every 300 ms per player.
      if (now < this.catsDown[m.i] || !player.alive || !player.state?.armed || now < (player.nextCat || 0)) return;
      player.nextCat = now + 300;
      this.catsDown[m.i] = now + CATS.respawnSeconds * 1000;
      this.broadcast({ t: 'cat', i: m.i, by: name, ms: CATS.respawnSeconds * 1000, w: m.w === 'grenade' ? 'grenade' : player.state.w }, name);
    } else if (m.t === 'pickup' && Number.isInteger(m.i) && m.i >= 0 && m.i < PICKUPS.length) {
      const item = this.items[m.i];
      const spot = PICKUPS[m.i];
      const st = player.state;
      if (now < item.until || !player.alive || !st?.armed) return;
      if (Math.hypot(st.x - spot.x, st.z - spot.z) > 2.5 || Math.abs(st.y - spot.y) > 2) return;
      item.until = now + PICKUP_MS;
      player.weapons.add(spot.w);
      this.broadcast({ t: 'item', i: m.i, ready: false, by: name });
    } else if (m.t === 'car') {
      if (now < (player.nextCar || 0)) return;
      player.nextCar = now + 300;
      if (m.op === 'in' && Object.hasOwn(this.cars, m.id)) this.enterCar(name, player, this.cars[m.id]);
      else if (m.op === 'out') this.releaseCar(name);
    } else if (m.t === 'horse') {
      if (now < (player.nextCar || 0)) return;
      player.nextCar = now + 300;
      if (m.op === 'on' && Number.isInteger(m.i) && this.horses[m.i]) this.mountHorse(name, player, this.horses[m.i], now);
      else if (m.op === 'off') this.releaseHorse(name);
    } else if (m.t === 'rocket') {
      this.rocket(name, player, m, now);
    } else if (m.t === 'nade') {
      this.throwNade(name, player, m, now);
    } else if (m.t === 'boom') {
      this.boom(name, player, m, now);
    } else if (m.t === 'hit' && typeof m.target === 'string' && Object.hasOwn(WEAPONS, m.w)) {
      const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
      this.hit(name, player, m.target, m.w, count(m.body), count(m.head), now);
    } else if (m.t === 'mode' && player.role === 'admin' && typeof m.kind === 'string') {
      this.modes.start(m.kind, name);
    } else if (m.t === 'tag') {
      this.modes.tag(name, m.target);
    } else if (m.t === 'coin') {
      this.modes.coin(name, m.i);
    } else if (m.t === 'team') {
      this.modes.choose(name, m.team);
    } else if (m.t === 'newround' && player.role === 'admin') {
      if (now - (this.lastNewRound || 0) < 2000) return;
      this.lastNewRound = now;
      this.newRound(`${name} started a new round`, 'newRoundBy', { name });
    } else if (m.t === 'spawn' && typeof m.to === 'string') {
      this.spawn(name, player, m.to, now);
    } else if (m.t === 'travel' && typeof m.to === 'string') {
      this.travel(name, player, m.to, m.via === 'chat', now);
    } else if (m.t === 'rules' && player.role === 'admin') {
      this.setRules(m, name).catch((e) => console.error('rules failed', String(e)));
    } else if (m.t === 'kick' && player.role === 'admin' && typeof m.name === 'string' && m.name !== name) {
      this.kick(m.name, name).catch((e) => console.error('kick failed', String(e)));
    }
  }

  /**
   * A trip through the portals to portal `id`. From a portal: where the server has the player
   * must be on one (the car's middle on it for a driver). From the chat: only when the admin
   * allows it, and the admin always may. Never when down or on horseback, at most one trip every
   * TRAVEL_MS; a driver takes the car and its passenger along, a passenger can't go alone. The
   * end is always one of the fixed portals' spots, so a forged message gets no further than
   * walking onto a portal does (a position spoofing "teleport hack" can't pick its spot).
   */
  /**
   * Where a player starts, picked on the start screen: one of the portal places' arrival spots. The
   * page sends it once its world is in. Taken once, in the first 90 seconds, and only while the
   * player is still where the server put them on joining (within 30 m: their first updates may
   * cross it), alive, on foot, with the portals on. So it is a start, never a free trip later.
   */
  spawn(name, p, id, now) {
    const to = PORTALS.find((q) => q.id === id);
    const st = p.state;
    if (!to || p.spawned || !st || !p.joinedAt) return;
    p.spawned = true;
    // Refused: the page goes back to where the server has the player, so both agree.
    const no = () => this.send(p.ws, { t: 'spawn', ok: false, x: st.x, z: st.z });
    if (now - p.joinTime > 90_000 || !p.alive || this.carOf(name) || this.horseOf(name) || (!this.rules.portals && p.role !== 'admin')) return no();
    if (Math.hypot(st.x - p.joinedAt.x, st.z - p.joinedAt.z) > 30) return no();
    p.nextTravel = now + TRAVEL_MS;
    const [x, z] = to.out;
    Object.assign(p.state, { x, y: TERRAIN.height(x, z), z });
    p.budget = 0.5;
    p.movedAt = now;
    this.moved(p);
  }

  travel(name, p, id, chat, now) {
    const st = p.state;
    const to = PORTALS.find((q) => q.id === id);
    // The refusal's English text, and its code for a page in another language (src/i18n.ts).
    const no = (text = '', code = undefined) => this.send(p.ws, { t: 'travel', name, to: id, ok: false, text, code });
    if (!to || !st || !p.alive || now < (p.nextTravel || 0)) return no();
    if (chat && !this.rules.travel && p.role !== 'admin') return no('The admin has turned travelling from the chat off. Walk to a portal.', 'travelChatOff');
    if (!chat && !this.rules.portals) return no('The admin has turned the portals off.', 'travelPortalsOff');
    const car = this.carOf(name);
    if (car && car.driver !== name) return no('Only the driver can take the car through.', 'travelDriverOnly');
    if (this.horseOf(name)) return no('Get off the horse first.', 'travelHorse');
    if (!chat) {
      const on = portalNear(st.x, st.z, (car ? CAR_REACH : REACH) + TRAVEL_SLACK);
      if (!on || on === to) return no();
    }
    p.nextTravel = now + TRAVEL_MS;
    const [x, z, yaw] = car ? to.car : to.out;
    const y = TERRAIN.height(x, z); // near enough: the player's next update has their feet exactly
    const move = (q) => {
      Object.assign(q.state, { x, y, z });
      q.budget = 0.5;
      q.movedAt = now;
      this.moved(q);
    };
    move(p);
    if (car) {
      Object.assign(car, { x, y, z, yaw, s: 0 });
      this.carAt[car.id] = mono();
      const rider = car.passenger ? this.players.get(car.passenger) : null;
      if (rider?.state) move(rider);
    }
    this.broadcast({ t: 'travel', name, to: id, ok: true, car: car?.id ?? null });
    if (car) this.broadcast({ t: 'car', car });
  }

  /** Get in, when the player stands next to it, is alive and in no car yet: at the wheel if nobody drives, else in the passenger seat if it's free. */
  enterCar(name, p, car) {
    const st = p.state;
    if (this.carOf(name) || !p.alive || !st) return this.send(p.ws, { t: 'car', car });
    // Close to its outline: the middle of the car plus its half diagonal and the reach.
    const spec = CARS.cars[car.id];
    const near = Math.hypot(spec.length, spec.width) / 2 + CARS.reach + 0.5;
    if (Math.hypot(st.x - car.x, st.z - car.z) > near || Math.abs(st.y - car.y) > 1.5) return this.send(p.ws, { t: 'car', car });
    if (!car.driver) car.driver = name;
    else if (!car.passenger) car.passenger = name;
    else return this.send(p.ws, { t: 'car', car });
    this.broadcast({ t: 'car', car });
  }

  /** The driver or the passenger got out, left, died or respawned: the car stays where it is. */
  releaseCar(name) {
    const car = this.carOf(name);
    if (!car) return;
    if (car.driver === name) {
      car.driver = null;
      car.s = 0;
    } else car.passenger = null;
    this.broadcast({ t: 'car', car });
  }

  /** Get on a horse nobody rides, when the player stands next to it, is alive and in no car. */
  mountHorse(name, p, horse, now) {
    const st = p.state;
    if (horse.rider || this.carOf(name) || this.horseOf(name) || !p.alive || !st) return this.send(p.ws, { t: 'horse', horse });
    const at = horse.parked ? horse : horseOnLoop(horse.i, now / 1000);
    if (Math.hypot(st.x - at.x, st.z - at.z) > HORSES.reach + 1) return this.send(p.ws, { t: 'horse', horse });
    Object.assign(horse, { x: at.x, z: at.z, yaw: horse.parked ? horse.yaw : at.heading, speed: 0, rider: name, parked: false });
    this.broadcast({ t: 'horse', horse });
  }

  /** The rider got off, left, died or respawned: the horse stays where it is and grazes. */
  releaseHorse(name) {
    const horse = this.horseOf(name);
    if (!horse) return;
    Object.assign(horse, { rider: null, parked: true, speed: 0, jump: 0 });
    this.broadcast({ t: 'horse', horse });
  }

  horseOf(name) {
    return this.horses.find((h) => h.rider === name) ?? null;
  }

  /** The car a player is in (driving or riding along), if any. */
  carOf(name) {
    return Object.values(this.cars).find((c) => c.driver === name || c.passenger === name) ?? null;
  }

  /** In a car: out of reach of shots, and no firing from it. */
  inCar(name) {
    return !!this.carOf(name);
  }

  async kick(target, by) {
    const p = this.players.get(target);
    const ended = this.auth.kick(target, p?.address ? [p.address] : []); // memory first, so they are out right away
    this.auth.log('kick', null, { username: target, detail: `by ${by}` });
    if (p) {
      this.send(p.ws, { t: 'kicked' });
      p.ws.close(4001, 'Removed by the admin');
    }
    this.broadcast({ t: 'system', text: `${target} was removed by the admin`, code: 'kicked', args: { name: target } });
    await ended;
  }

  /** Furniture from the database, at start. */
  async loadFurniture() {
    const store = this.auth.store;
    let list = await store.listFurniture();
    // The starting layout: placed the first time, and replaced by a newer version of it as long
    // as nobody has placed, moved or removed anything (the 'furniture_edited' flag, kept since the
    // planner began).
    const seeded = await store.getMeta('furniture_seeded');
    this.furnitureEdited = (await store.getMeta('furniture_edited')) === '1';
    const restore = (await store.getMeta('furniture_restore')) !== LAYOUT_RESTORE;
    if (restore) {
      await store.setMeta('furniture_restore', LAYOUT_RESTORE);
      await store.setMeta('furniture_edited', '0');
      this.furnitureEdited = false;
    }
    if (restore || (!seeded && !list.length) || (seeded && seeded !== LAYOUT_VERSION && !this.furnitureEdited)) {
      await store.clearFurniture();
      for (const f of DEFAULT_FURNITURE) await store.addFurniture({ ...f, by: 'layout' });
      await store.setMeta('furniture_seeded', LAYOUT_VERSION);
      list = await store.listFurniture();
      console.log(JSON.stringify({ event: 'furniture_layout', version: LAYOUT_VERSION, replaced: seeded }));
    }
    for (const f of list) this.furniture.set(f.id, f);
  }

  /** House rules (flying, players moving furniture, names, how many may play, portals, travelling from the chat, child-friendly), kept across restarts. */
  async loadRules() {
    let saved = {};
    try {
      saved = JSON.parse((await this.auth.store.getMeta('rules')) || '{}');
    } catch {
      // unreadable: the defaults
    }
    for (const k of Object.keys(RULES)) if (ruleOk(k, saved[k])) this.rules[k] = saved[k];
  }

  /** The admin changed rules in the settings: store them and tell everyone. */
  async setRules(m, by) {
    const changed = Object.keys(RULES).filter((k) => ruleOk(k, m[k]) && m[k] !== this.rules[k]);
    if (!changed.length) return;
    for (const k of changed) this.rules[k] = m[k];
    await this.auth.store.setMeta('rules', JSON.stringify(this.rules));
    const label = { flying: 'flying', furniture: 'moving furniture', names: 'names above players', pin: 'joining with the PIN', portals: 'the portals', travel: 'travelling from the chat', paintball: 'child-friendly for everyone' };
    const text = changed.map((k) => (k === 'maxPlayers' ? `the limit to ${this.rules[k]} players` : `${label[k]} ${this.rules[k] ? 'on' : 'off'}`)).join(', ');
    this.auth.log('rules', null, { username: by, detail: text });
    this.broadcast({ t: 'rules', rules: this.rules });
    // With the rules that changed and their new values (checked by ruleOk), for the page to word in its language.
    const args = { name: by, ...Object.fromEntries(changed.map((k) => [k, this.rules[k]])) };
    this.broadcast({ t: 'system', text: `${by} turned ${text}`, code: 'rules', args });
  }

  /** Remember whether the furniture differs from the starting layout (see loadFurniture). */
  async markFurniture(edited) {
    if (this.furnitureEdited === edited) return;
    this.furnitureEdited = edited;
    await this.auth.store.setMeta('furniture_edited', edited ? '1' : '0');
  }

  /** Furniture planner: place or move ('put'), remove ('del'), or (admin) remove all ('clear'). */
  async furnish(name, player, m) {
    const store = this.auth.store;
    if (!this.rules.furniture && player.role !== 'admin') return; // the admin turned it off
    if (m.op === 'clear' || m.op === 'reset') {
      if (player.role !== 'admin') return;
      await store.clearFurniture();
      this.furniture.clear();
      if (m.op === 'reset') {
        for (const f of DEFAULT_FURNITURE) {
          const piece = { ...f, by: 'layout' };
          piece.id = await store.addFurniture(piece);
          this.furniture.set(piece.id, piece);
        }
        await store.setMeta('furniture_seeded', LAYOUT_VERSION);
      }
      await this.markFurniture(m.op === 'clear');
      this.broadcast({ t: 'furn', op: 'all', list: [...this.furniture.values()], by: name, reset: m.op === 'reset' });
      // The characters the admin placed with the planner go too: back to the starting clowns and strongmen.
      this.clowns = this.startingClowns();
      this.broadcast({ t: 'clowns', list: this.clownList(Date.now()) });
    } else if (m.op === 'del' && this.furniture.has(m.id)) {
      await store.deleteFurniture(m.id);
      this.furniture.delete(m.id);
      await this.markFurniture(true);
      this.broadcast({ t: 'furn', op: 'del', id: m.id });
    } else if (m.op === 'put' && FURNITURE_IDS.has(m.item)) {
      const f = { item: m.item, x: num(m.x, -60, 60), y: num(m.y, -1, 12), z: num(m.z, -60, 60), yaw: num(m.yaw, -7, 7), by: name };
      if (m.id !== undefined) {
        if (!this.furniture.has(m.id)) return;
        f.id = m.id;
        await store.updateFurniture(f.id, f);
      } else {
        if (this.furniture.size >= FURNITURE.max) return;
        f.id = await store.addFurniture(f);
      }
      this.furniture.set(f.id, f);
      await this.markFurniture(true);
      this.broadcast({ t: 'furn', op: 'put', f });
    }
  }

  /**
   * A shooter's browser says one shot of weapon `w` hit `targetName` with
   * `body` and `head` bullets (the shotgun fires 8 pellets). Apply it if it
   * is plausible: a weapon they carry, its fire rate, its pellet count, range.
   */
  hit(name, shooter, targetName, w, body, head, now) {
    const spec = WEAPONS[w];
    const target = this.players.get(targetName);
    if (spec.rocket) return; // rockets hurt through their blast (see rocket)
    if (!target || target === shooter || this.roundOver || !shooter.weapons.has(w) || shooter.state?.w !== w) return;
    if (this.modes.friends(name, targetName)) return; // the same team
    if (this.inCar(targetName) || this.inCar(name)) return; // in the car: out of reach, and no shooting from it
    if (body + head < 1 || body + head > spec.pellets) return;
    if (!shooter.alive || !target.alive || !shooter.state?.armed || !target.state?.armed) return;
    if (now < target.protectedUntil || now < shooter.nextHit) return; // one clock for all weapons
    const a = shooter.state;
    const b = target.state;
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > MAX_HIT_RANGE) return;
    if (this.calm(shooter) || this.calm(target)) return; // nobody shoots on the school grounds, in or out
    shooter.nextHit = now + spec.delay * 700; // 70% of the fire delay, for network jitter
    shooter.protectedUntil = 0; // shooting ends your own spawn protection
    this.damage(name, shooter, targetName, target, body * spec.body + head * spec.head, head > 0, w, now);
  }

  /**
   * Bazooka: the rocket flies from the shooter to where they aimed (`tx, ty, tz`) and the server
   * sets off the blast when it arrives, hurting everyone near it by distance (walls do not
   * shield, the shooter is spared). Everyone sees the rocket and the explosion.
   */
  rocket(name, shooter, m, now) {
    const spec = WEAPONS.bazooka;
    if (!shooter.weapons.has('bazooka') || shooter.state?.w !== 'bazooka' || !shooter.alive || this.roundOver) return;
    if (this.inCar(name)) return; // no firing from the car (as in hit)
    if (this.calm(shooter)) return;
    if (now < (shooter.nextRocket || 0)) return;
    shooter.nextRocket = now + spec.reload * 800; // one rocket per load, with room for network jitter
    shooter.protectedUntil = 0;
    const s = shooter.state;
    const from = { x: s.x, y: s.y + 1.5, z: s.z };
    // The target within the area, as positions are (it was ±400 m, which turned rockets fired in the village or on
    // Molenhoek's far stretch back towards the house).
    let to = { x: num(m.tx, AREA.x0, AREA.x1), y: num(m.ty, -20, 200), z: num(m.tz, AREA.z0, AREA.z1) };
    let dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    if (dist > spec.rocket.range) {
      const k = spec.rocket.range / dist;
      to = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k };
      dist = spec.rocket.range;
    }
    this.broadcast({ t: 'rocket', name, x: from.x, y: from.y, z: from.z, tx: to.x, ty: to.y, tz: to.z }, name);
    setTimeout(() => this.blast(name, to), (dist / spec.rocket.speed) * 1000);
  }

  /**
   * Grenades: everyone carries GRENADE.carry; a thrown one is back after GRENADE.back seconds.
   * The thrower's browser works out the flight (it bounces off the house) and sets it off;
   * the others see it fly from the throw.
   */
  throwNade(name, p, m, now) {
    if (!p.alive || !p.state?.armed || this.roundOver || this.inCar(name) || this.calm(p)) return; // none from the car or the school grounds
    const slot = p.nades.findIndex((t) => now >= t);
    if (slot < 0) return;
    p.nades[slot] = now + (GRENADE.back - 0.5) * 1000; // half a second early, for network jitter
    p.protectedUntil = 0;
    const s = p.state;
    let from = where(m);
    if (Math.hypot(from.x - s.x, from.y - s.y - 1.5, from.z - s.z) > 3) from = { x: s.x, y: s.y + 1.5, z: s.z };
    p.thrown.push({ at: now, ...from });
    if (p.thrown.length > GRENADE.carry) p.thrown.shift();
    const v = (k) => num(m[k], -40, 40);
    this.broadcast({ t: 'nade', name, ...from, vx: v('vx'), vy: v('vy'), vz: v('vz') }, name);
  }

  /**
   * The thrower's grenade went off at x, y, z. `cover`: players its browser saw behind a wall
   * or floor, spared (a browser can only spare people this way, never hurt more).
   */
  boom(name, p, m, now) {
    const i = p.thrown.findIndex((g) => now - g.at > (GRENADE.fuse - 1) * 1000 && now - g.at < (GRENADE.fuse + 3) * 1000);
    if (i < 0) return;
    const g = p.thrown.splice(i, 1)[0];
    const at = where(m);
    if (Math.hypot(at.x - g.x, at.y - g.y, at.z - g.z) > 60) return;
    const cover = new Set(Array.isArray(m.cover) ? m.cover.filter((n) => typeof n === 'string').slice(0, MAX_PLAYERS) : []);
    this.blast(name, at, 'grenade', cover);
  }

  /** A rocket's or grenade's blast: everyone near it is hurt by distance, the shooter spared. */
  blast(name, at, w = 'bazooka', cover = new Set()) {
    const { radius, damage } = w === 'grenade' ? GRENADE : WEAPONS.bazooka.rocket;
    const now = Date.now();
    // The thrower's browser has set off its own grenade already.
    this.broadcast({ t: 'blast', by: name, w, x: at.x, y: at.y, z: at.z }, w === 'grenade' ? name : undefined);
    const shooter = this.players.get(name);
    if (!shooter || this.roundOver) return;
    // Strongmen caught in it lose health too (less at the edge of the blast; they're big).
    for (const c of this.clowns.values()) {
      if (!c.brain || now < c.until) continue;
      const d = Math.hypot(c.brain.x - at.x, c.brain.z - at.z);
      if (d < radius + 1) this.hurtBrute(c, name, Math.round(bruteDamage(w, WEAPONS) * (1 - (0.5 * d) / (radius + 1))), w, now);
    }
    for (const [targetName, target] of [...this.players]) {
      if (target === shooter || cover.has(targetName) || !target.alive || !target.state?.armed || now < target.protectedUntil) continue;
      if (this.modes.friends(name, targetName)) continue; // the same team
      if (this.calm(target)) continue; // on the school grounds
      const s = target.state;
      const d = Math.hypot(s.x - at.x, s.y + 0.9 - at.y, s.z - at.z); // from the middle of the body
      if (d < radius) this.damage(name, shooter, targetName, target, Math.round(damage * (1 - d / radius)), false, w, now);
    }
  }

  /** The clowns and strongmen everyone starts with (shared/clowns.json), before the admin adds any. */
  startingClowns() {
    return new Map(CLOWNS.spots.map(([x, y, z, kind], i) => [i + 1, this.character(i + 1, x, y, z, kindOf(kind))]));
  }

  /** Whether a player stands where nobody shoots (the school grounds, shared/zones.mjs). */
  calm(p) {
    return !!(p?.state && noShoot(p.state.x, p.state.z));
  }

  /** Take `amount` health from a target; a kill scores for the shooter (and can end the round). */
  damage(name, shooter, targetName, target, amount, head, w, now) {
    if (!target.alive) return;
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp > 0) return this.send(target.ws, { t: 'hurt', hp: target.hp, by: name });

    target.alive = false;
    target.respawnAt = now + RESPAWN_MS;
    this.releaseCar(targetName);
    this.releaseHorse(targetName);
    target.score.deaths++;
    shooter.score.kills++;
    shooter.score.points += POINTS.kill + (head ? POINTS.headshot : 0);
    target.weapons = loadout(target.role); // dropped what they picked up
    this.broadcast({ t: 'kill', killer: name, victim: targetName, head, w });
    this.stats(name, { kills: 1, headshots: head ? 1 : 0 });
    this.stats(targetName, { deaths: 1 });
    this.broadcast({ t: 'scores', list: this.scoreList() });
    this.modes.scored(name, targetName);
    if (shooter.score.kills >= KILL_LIMIT && this.modes.state.kind !== 'teams') { // in the teams game the teams' score counts
      this.roundOver = { winner: name, until: now + ROUND_BREAK_MS };
      this.broadcast({ t: 'round', winner: name, ms: ROUND_BREAK_MS });
      this.auth.log('round_won', null, { username: name });
      this.stats(name, { wins: 1 });
    }
  }

  /** Back to full health at the spawn point furthest from the others (one of the best three, for variety). */
  respawn(name, p, now) {
    this.releaseCar(name);
    this.releaseHorse(name);
    p.hp = HEALTH;
    p.alive = true;
    p.weapons = loadout(p.role);
    p.nades.fill(0);
    p.protectedUntil = now + PROTECT_MS;
    // At the player's team's house in the teams game, else round the house; away from the others.
    const team = this.modes.teamOf(name) ?? 'house';
    const others = [...this.players].filter(([n, o]) => n !== name && o.alive && o.state).map(([, o]) => o.state);
    const ranked = SPAWNS.map((s, i) => ({
      i, team: s.team, d: others.length ? Math.min(...others.map((o) => Math.hypot(o.x - s.x, (o.y - s.y) * 2, o.z - s.z))) : Math.random(),
    })).filter((s, _, all) => s.team === team || !all.some((q) => q.team === team)).sort((x, y) => y.d - x.d);
    const spawn = ranked[Math.floor(Math.random() * Math.min(3, ranked.length))].i;
    // Until the player's own update arrives, they are at the spawn point (so the next pick avoids it).
    if (p.state) Object.assign(p.state, { x: SPAWNS[spawn].x, y: SPAWNS[spawn].y, z: SPAWNS[spawn].z });
    p.movedAt = now;
    p.budget = 0.5;
    this.moved(p);
    this.broadcast({ t: 'respawn', name, spawn });
  }

  /** Health at the start and after a respawn. */
  get fullHealth() {
    return HEALTH;
  }

  /** A player's colour: in the teams game their team's (their outfit with it), else their own. */
  colorOf(name, p) {
    const team = this.modes.teamOf(name);
    return team ? TEAM_COLORS[team] : p.color;
  }

  /**
   * Teams set, changed or over: everyone sees the new colours, and (`move`) the players named
   * start again at their team's house (not counted as a death).
   */
  teamsChanged(names, move = true) {
    const now = Date.now();
    if (move) {
      for (const name of names) {
        const p = this.players.get(name);
        if (p) this.respawn(name, p, now);
      }
    }
    this.broadcast({ t: 'colors', list: this.roster() });
    this.broadcast({ t: 'scores', list: this.scoreList() });
  }

  /** Scores back to zero; everyone who fights (or is dead) starts again at a spawn point. `code` and `args`: `text` for a page in another language. */
  newRound(text, code, args) {
    const now = Date.now();
    this.roundOver = null;
    this.scores.clear();
    for (const [name, p] of this.players) {
      p.score = { kills: 0, deaths: 0, points: 0 };
      this.scores.set(name, p.score);
    }
    this.broadcast({ t: 'newround', text, code, args });
    for (const [name, p] of this.players) if (p.state?.armed || !p.alive) this.respawn(name, p, now);
    this.broadcast({ t: 'scores', list: this.scoreList() });
  }

  tick() {
    const now = Date.now();
    this.items.forEach((item, i) => {
      if (item.until && now >= item.until) {
        item.until = 0;
        this.broadcast({ t: 'item', i, ready: true });
      }
    });
    if (this.roundOver && now >= this.roundOver.until) this.newRound(`New round: first to ${KILL_LIMIT} kills`, 'newRound', { n: KILL_LIMIT });
    for (const [name, p] of this.players) if (!p.alive && !this.roundOver && now >= p.respawnAt) this.respawn(name, p, now);
    this.modes.tick(now, TICK_MS);
    if (!this.players.size) return;
    this.stepBrutes(now);
    this.snapshot(now);
    this.pings();
  }

  /**
   * When a player's state was taken, on the server's clock: their page's own time for it (`ct`), lined
   * up by the smallest gap seen between its clock and ours (the quickest a message came), so jitter
   * on the way here doesn't show on the other pages. Always between half a second ago and now, and
   * after the last one. Only used to draw them smoothly elsewhere, never to check anything.
   */
  stampState(p, ct) {
    const t = mono();
    let at = t;
    if (typeof ct === 'number' && Number.isFinite(ct)) {
      const gap = t - ct;
      // The quickest so far, let go of slowly (2 ms a second) to follow a slower route; a jump of more
      // than a second (a page whose clock stood still while it slept) starts again.
      if (p.ctGap === null || gap < p.ctGap || gap - p.ctGap > 1000) p.ctGap = gap;
      else p.ctGap += Math.min(gap - p.ctGap, (t - p.ctAt) * 0.002);
      p.ctAt = t;
      at = ct + p.ctGap;
    }
    p.stamp = Math.min(t, Math.max(at, t - 500, p.stamp + 1));
    p.fresh = true;
  }

  /** The server moved a player (respawn, portal, start place): their figure jumps there on the other pages. */
  moved(p) {
    p.warp = (p.warp + 1) & 3;
    p.stamp = Math.max(mono(), p.stamp + 1);
  }

  /**
   * The tick (shared/wire.mjs) for every page: what moved or changed, and each thing in its turn of
   * the keyframe; everything for a page that just connected; each page's own player left out. Each
   * entry is written once and shared by the pages, so a tick costs about one line per thing plus one
   * list per page. Pages from before protocol 2 get the old full states every other tick.
   */
  snapshot(now) {
    const st = mono();
    const turn = this.tickNo++ % KEYFRAME;
    const entry = (id, at, fields) => `[${JSON.stringify(id)},${Math.min(999, Math.max(0, Math.round(st - at)))},${fields.slice(1)}`;
    const players = [];
    for (const [name, p] of this.players) {
      if (!p.state) continue;
      const fields = JSON.stringify(playerFields(p.state, p.alive, now < p.protectedUntil, p.warp));
      players.push({ name, json: entry(name, p.stamp, fields), due: p.fresh || fields !== p.sentKey || p.slot === turn });
      p.sentKey = fields;
    }
    // Cars, horses and strongmen: when their driver or rider sent something new, when they changed, in their turn.
    const things = { c: [], h: [], b: [] };
    const sent = new Map();
    const add = (list, key, slot, fields, json, fresh) => {
      things[list].push({ json, due: fresh || fields !== this.sent.get(key) || slot % KEYFRAME === turn });
      sent.set(key, fields);
    };
    Object.values(this.cars).forEach((c, i) => {
      const f = JSON.stringify(carFields(c));
      add('c', `c${c.id}`, i, f, entry(c.id, this.carAt[c.id] ?? 0, f), !!this.players.get(c.driver)?.fresh);
    });
    for (const h of this.horses) {
      const f = JSON.stringify(horseFields(h));
      add('h', `h${h.i}`, h.i + 5, f, entry(h.i, this.horseAt[h.i], f), !!this.players.get(h.rider)?.fresh);
    }
    // The strongmen every other tick (ten a second is plenty for their walk), keeping what was sent until then.
    const brutes = turn % 2 === 0;
    for (const c of this.clowns.values()) {
      if (!c.brain) continue;
      const key = `b${c.id}`;
      const json = JSON.stringify(bruteEntry(c.id, c.brain));
      if (brutes) add('b', key, c.id * 2, json, json, false);
      else {
        things.b.push({ json, due: false }); // only for a page that just connected
        if (this.sent.has(key)) sent.set(key, this.sent.get(key));
      }
    }
    this.sent = sent;
    for (const p of this.players.values()) p.fresh = false;

    const join = (list, all) => list.filter((e) => all || e.due).map((e) => e.json).join(',');
    const part = (k, text) => (text ? `,"${k}":[${text}]` : '');
    // The strongmen's list goes with every other tick even when empty: one left out of it stood still.
    const rest = (all) => part('c', join(things.c, all)) + part('h', join(things.h, all)) + (brutes || all ? `,"b":[${join(things.b, all)}]` : '');
    const changed = rest(false);
    let everything = null;
    let old = false;
    for (const [name, p] of this.players) {
      if (p.proto < PROTO) {
        old = true;
        continue;
      }
      if (p.ws.readyState !== p.ws.OPEN) continue;
      const all = p.full;
      p.full = false;
      if (all) everything ??= rest(true);
      const others = join(players.filter((e) => e.name !== name), all);
      p.ws.send(`{"t":"s","st":${st}${part('p', others)}${all ? everything : changed}}`);
    }
    if (old && turn % OLD_EVERY === 0) this.oldStates(now);
  }

  /** Pages from before protocol 2 (still open during a deploy): the strongmen and everyone's full state, as before. */
  oldStates(now) {
    const send = (msg) => {
      const data = JSON.stringify(msg);
      for (const p of this.players.values()) if (p.proto < PROTO && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    };
    send({ t: 'brutes', list: this.bruteList() });
    if (this.players.size < 2) return;
    const states = [];
    for (const [name, p] of this.players) if (p.state) states.push({ name, ...p.state, alive: p.alive, safe: now < p.protectedUntil });
    send({ t: 'states', players: states, cars: Object.values(this.cars), horses: this.horses });
  }

  /**
   * Every two seconds a ping to each page (protocol 2), carrying the last time there and back for it
   * to show. The answer counts only for the ping asked (a random number), once: a page can't make its
   * time look shorter, and unasked answers are dropped. A page that sent nothing for SILENT_MS is let
   * go (its 'close' frees what it held); it connects again when it wakes up, back where it was.
   */
  pings() {
    const t = mono();
    for (const p of this.players.values()) {
      if (p.proto < PROTO) continue;
      if (t - p.heard > SILENT_MS) {
        p.ws.terminate();
        continue;
      }
      if (t < p.pingNext) continue;
      p.pingNext = t + PING_MS;
      p.pingN = randomInt(1, 2 ** 31);
      p.pingAt = t;
      this.send(p.ws, { t: 'ping', n: p.pingN, rtt: p.rtt });
    }
  }

  /** A player's time there and back (ms, smoothed) for the admin's live view; null before the first answer or for an old page. */
  pingOf(name) {
    const r = this.players.get(name)?.rttAvg;
    return typeof r === 'number' ? Math.round(r) : null;
  }

  /** Add to someone's totals for the leaderboard (kept in the database). */
  stats(name, add) {
    this.auth.store.addStats(name, add).catch((e) => console.error('stats failed', String(e)));
  }

  send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const [name, p] of this.players) if (name !== except && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}
