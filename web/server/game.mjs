// The shared house: the logged-in players over WebSocket (16 at once unless the admin allows fewer).
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
// The bikes (shared/bike.json: one against the main house, one at the bungalow, racks by the
// portals): one player rides each at a time, and their position updates are the bike's, so they
// may move at a bike's speed while (and only while) they ride one. Like a car, a bike keeps its
// rider out of the fighting. Each bike stays where it is left until the server restarts.
//
// More Teslas are spawned with /tesla (at most PLACED.max, see placeCar): each is a car like
// the others, kept in the database where it was put, gone with the furniture's clear or reset.
//
// The portals (shared/portals.mjs): a player on one asks to travel to another, or types /church
// in the chat (when the admin allows it); the server checks it and moves them (see travel()).
// From the chat (or the menu's list) also to a street: /location kapellenhoek (shared/places.json).

import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { Modes, TEAM_COLORS } from './modes.mjs';
import { bruteDamage, hurtBy, newBrute, stepBrute } from '../shared/brutes.mjs';
import { makeTerrain } from '../shared/terrain.mjs';
import { loadBounds } from '../shared/bounds.mjs';
import { CAR_REACH, PORTALS, portalNear, REACH } from '../shared/portals.mjs';
import { HOMES, homeAt, homeOfDoor, inEndGarden, makePaneHomes, PANE_LIMIT, registerDoors } from '../shared/homes.mjs';
import { mergeHouse } from '../shared/insideData.mjs';
import { defaultLayout, housePacks, packFor } from './insides.mjs';
import { HomeGate } from './homeGate.mjs';
import { noShoot } from '../shared/zones.mjs';
import { boxesOverlap, boxPoints, clearOfPortals, makeIndoors, makeSolids } from '../shared/parking.mjs';
import { bikeFields, bruteEntry, carFields, horseFields, playerFields, PROTO, TICK_MS } from '../shared/wire.mjs';
import { houseAreas, makeNav, MAX_ADMIN_WAVE } from '../shared/zombies.mjs';
import { cycleTime, DEFAULT_CHOICE, isChoice, newCycle, runOf, seasonCycle, skipCycle, SPEEDS, winterAt, withSpeed } from '../shared/moods.mjs';
import { arenaEdge, arenaHome, arenaSpots, ARENAS, portalOf, villageGround } from '../shared/arenas.mjs';
import { churchPrisms, makeChurch } from '../shared/church.mjs';
import { cafePrisms, makeCafe } from '../shared/sparrenhof.mjs';
import { DROP, dropFrom, HOME_DROP } from '../shared/parachute.mjs';
import { Football } from './football.mjs';
import { blastPoint } from './grenade.mjs';

/** /parachute (manualDrop): once every CHUTE_MS, and not within HURT_CALM_MS of being hit. */
const CHUTE_MS = 60_000;
const HURT_CALM_MS = 10_000;
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
/** A position from a message, kept within the area (heights: from below the lowest ground to above the flying ceiling). */
const where = (m) => ({ x: num(m.x, AREA.x0, AREA.x1), y: num(m.y, -20, 200), z: num(m.z, AREA.z0, AREA.z1) });
/**
 * The edge of the game (tools/bounds.py, shared/bounds.mjs): the outline round the built-up area, the
 * one round the two houses while a game in the house runs, and the flying ceiling. Inside AREA.
 */
const BOUNDS = loadBounds(shared('bounds.json'));
/** The house data (src/data/): the house and its surroundings, and the village. */
const houseData = (file) => JSON.parse(readFileSync(new URL(`../src/data/${file}`, import.meta.url), 'utf8'));
// The house data is the shell plus the insides of the main house and the bungalow, when the private data holds them
// (server/insides.mjs). The server uses the insides for its own sums (walls, floors, the zombies); a page gets one only
// with the home's right (server/homes.mjs).
const PACKS = housePacks();
const HOUSE = mergeHouse(houseData('house_shell.json'), PACKS);
for (const p of PACKS) registerDoors(p.id, p.doors.map((d) => d.id));
const VILLAGE = houseData('village.json');
const CHURCH_DATA = shared('church.json');
const CHURCH = makeChurch(CHURCH_DATA, HOUSE.ground + TERRAIN.height(...CHURCH_DATA.origin));
const CAFE_DATA = shared('sparrenhof.json');
/** The café Sparrenhof's blocks with its stairs to the roofs, in place of its plain block (shared/sparrenhof.mjs) */
const CAFE = makeCafe(CAFE_DATA, HOUSE.ground + TERRAIN.height(...CAFE_DATA.origin));
/** A Zombies place's village ground (its blocks, hedges, trunks and areas): the same every game, made once per place. */
const villageGrounds = new Map();
const villageGroundOf = (arena, edge) => {
  if (!villageGrounds.has(arena.id)) villageGrounds.set(arena.id, villageGround(arena, edge, VILLAGE, CHURCH, CAFE));
  return villageGrounds.get(arena.id);
};
/** The least time between two starts or stops of a game in one room (any player in it). */
const ROOM_MODE_MS = 5000;
/**
 * A spot on every named street (tools/places.py): where /location kapellenhoek takes you, on foot
 * (`out`) or with the car (`car`). Only these: a trip never ends where the page says. A spot
 * outside the edge (the edge changed, places.json not made again) is left out.
 */
const PLACES = new Map(
  shared('places.json').places
    .filter((p) => BOUNDS.map.inside(p.x, p.z) && BOUNDS.map.inside(p.car[0], p.car[1]))
    .map((p) => [p.id, { id: p.id, street: true, out: [p.x, p.z, p.yaw], car: p.car }]),
);

/**
 * Where a strongman has room to stand: a map of the ground in 1 m squares with every wall, hedge,
 * fence and house from the house data marked (anything from 0.4 to 2.5 m above the ground: on
 * the relief a house stands at the ground's height in its middle, a hedge or fence (d) follows it).
 * The house's blocks, the surroundings' and the village's (src/data/village.json); a lookup is one
 * array read, however many blocks there are.
 */
function groundMap() {
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
/** The Teslas spawned with /tesla (shared/car.json): how many at most, the kinds (a car above in a paint of its own). */
const PLACED = CARS.placed;
/** A car's size and speeds: its own, or for a placed one its kind's base car's. */
const carSpec = (car) => CARS.cars[car.id] ?? CARS.cars[PLACED.kinds[car.kind]?.base];
const TESLA_MS = 400; // ms: at most one place, move or removal this often per player
const BIKES = shared('bike.json'); // the bikes: where each stands, its size and top speed (src/world/bike.ts)
const BELL_MS = 400; // ms: a rider's bell rings for the others at most this often
/**
 * Where a placed car can't stand: the blocks of the house, its surroundings, the street models'
 * walls and fences, and the village (the same as the page's collision), and the floors of the house
 * and the bungalow (indoors).
 */
const SOLIDS = makeSolids([
  ...HOUSE.prisms, ...(HOUSE.surroundings?.prisms ?? []), ...cafePrisms(churchPrisms(VILLAGE.prisms ?? [], CHURCH), CAFE),
  ...Object.values(houseData('homestreet.json').clusters).flatMap((c) => c.blocks ?? []),
], (x, z) => TERRAIN.height(x, z));
const INDOORS = makeIndoors([...HOUSE.prisms, ...(HOUSE.surroundings?.prisms ?? [])], HOUSE.rooms.map((r) => r.name));
/**
 * The Zombies game (server/zombies.mjs): what the zombies walk round and on (the house's blocks first,
 * so their glass keeps the page's numbers, then the surroundings' and the two portal streets': none
 * of the village's lie in the party area), with every floor of the house and the bungalow in a finer
 * grid of their own (HOUSE_AREAS) and their doors, open during the game as at any time together. The
 * cars are added at each start, where they stand then (nobody drives during the game).
 */
const ZOMBIE_PRISMS = [...HOUSE.prisms, ...(HOUSE.surroundings?.prisms ?? []), ...Object.values(houseData('homestreet.json').clusters).flatMap((c) => c.blocks ?? [])];
const HOUSE_AREAS = houseAreas(HOUSE.prisms);
/** Where the best wave at Zombies place `id` is kept (meta table): home's key from before the places, the others with their id. */
const bestKey = (id) => (id === 'house' ? 'zombies_best' : 'zombies_best_' + id);
/** The house data's doors: whether each stands open before anyone touched it (the page's default too). */
const DOOR_OPEN = Object.assign(Object.create(null), Object.fromEntries(HOUSE.doors.map((d) => [d.id, !!d.open])));
/**
 * Every door a page can swing: the house data's (the shell's and the insides' of the main house and the bungalow), the end
 * house's shell and its inside when the private data holds it. The village has no doors. A `door` message for any other id
 * is ignored, so nobody can fill the door table with made-up ids (it is never larger than this list).
 */
const KNOWN_DOORS = new Set([...HOUSE.doors, ...houseData('molenhoek_end_shell.json').doors, ...(packFor('molenhoek_end')?.doors ?? [])].map((d) => d.id));
/** Is `id` one of the doors of the game? */
export const knownDoor = (id) => KNOWN_DOORS.has(id);
// Which of the three code-locked homes a pane belongs to (shared/homes.mjs, server/homeGate.mjs).
const PANE_HOME = makePaneHomes({ prisms: HOUSE.prisms, doors: HOUSE.doors });
/**
 * The cars parked along the village's streets (src/data/roads.json, drawn by src/world/traffic.ts):
 * each a block of its model's size, as the page makes it (the sizes are in public/models/traffic.glb).
 * A placed car can't stand on one either.
 */
const PARKED = (() => {
  try {
    const glb = readFileSync(new URL('../public/models/traffic.glb', import.meta.url));
    const nodes = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')).nodes;
    const size = Object.fromEntries(nodes.filter((n) => n.extras?.length).map((n) => [n.name, n.extras]));
    const kinds = ['hatch', 'estate', 'van']; // as in traffic.ts
    return houseData('roads.json').parked.flatMap(([x, z, yaw, k]) => {
      const s = size[kinds[k]];
      return s ? [{ x, z, yaw, halfL: s.length / 2 - 0.05, halfW: s.width / 2 - 0.02 }] : [];
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'parked_cars_unread', error: String(e) }));
    return [];
  }
})();
const HORSES = shared('horses.json'); // the horses: their walks on the shared clock, riding speeds
const FURNITURE = shared('furniture.json'); // the catalogue: which items exist, how many may be placed
const FURNITURE_IDS = new Set(FURNITURE.items.map((i) => i.id));
// The starting layout is private data (the pieces stand inside the homes). Without it nothing is seeded and the stored
// furniture is left as it is.
const DEFAULT_FURNITURE = (defaultLayout?.pieces ?? []).map(([item, x, y, z, yaw]) => ({ item, x, y, z, yaw }));
const LAYOUT_VERSION = String(defaultLayout?.version ?? 1);
// Bumped in the layout file to put the starting layout back once, even over changes (Yoshi, 31 Oct 2026: the furniture was gone).
const LAYOUT_RESTORE = String(defaultLayout?.restore ?? 0);
/**
 * House rules the admin sets in the settings, with their defaults. `paintball` (child-friendly for
 * everyone) only changes what the pages show: Action as Paintball, with the same hits and scores.
 */
const RULES = { flying: true, spawn: false, names: true, maxPlayers: MAX_PLAYERS, guests: true, portals: true, travel: true, paintball: false, parachute: true };
/**
 * Spawning with /name (Yoshi, 2 Nov 2026: everyone may, unless the admin has it off, as it is at first):
 * how far from where the server has you a thing may appear (m), and how many each player may have out
 * at once (furniture; Teslas; clowns and strongmen). The admin isn't counted.
 */
const SPAWN_REACH = 8;
const SPAWN_EACH = 20;
const SPAWN_CARS = 2;
const SPAWN_CHARACTERS = 2;
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
const MAX_SPEED = 16; // m/s up or down: falling off the roof is about 13
// m/s across, on foot or flying: running at the real pace (1.4 m/s walking, 2.5 times that running,
// fixed together: src/main.ts REAL_WALK), with room for network jitter. Only a changed page goes faster.
const RUN_SPEED = 1.4 * 2.5 * 1.3;
const ADMIN_SPEED = 16 * 15; // m/s: the admin may move extremely fast (src/player.ts turbo)
// m/s across in a drop the server started (shared/parachute.mjs: the free fall's tracking at most), with room
// for network jitter as running has; and how far up a drop may go (m, refilling at `rate` m/s): next to nothing.
const DROP_SPEED = DROP.across * 1.3;
const DROP_RISE = { max: 0.6, rate: 0.5 };
const CAR_SPEED = Math.max(...Object.values(CARS.cars).map((c) => c.maxSpeed)) * 1.2; // m/s in a car, with room for network jitter
const HORSE_SPEED = HORSES.gallop * 1.3; // m/s on horseback
const BIKE_SPEED = BIKES.maxSpeed * 1.3; // m/s on a bike: its top speed (downhill), with room for network jitter
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
/** The home whose inside a furniture piece stands in, or null (shared/homes.mjs homeAt). */
const pieceHome = (f) => (f ? homeAt(f.x, f.z, f.y) : null);

/**
 * What a room refuses (server/rooms.mjs): changes to the open world's furniture, Teslas, characters,
 * rules and weather, a new round, and anything that takes a player away from the room's place (start
 * places, the parachute, trips). The admin's other powers work in a room as anywhere.
 */
const ROOM_REFUSED = new Set(['furn', 'tesla', 'clown', 'rules', 'mood', 'moodskip', 'moodspeed', 'newround', 'spawn', 'chute', 'travel', 'team', 'tag', 'coin']);

/** The ids a `door` message may carry: the house data's and the end house's door ids (letters, digits, dots and dashes), at most 40 characters. */
export const DOOR_ID = /^[A-Za-z0-9.-]{1,40}$/;

export class Game {
  /** The three code-locked homes' gate (server/homeGate.mjs), made on first use. */
  get gate() {
    return (this._gate ??= new HomeGate({ homes: () => this.homes, paneHome: PANE_HOME }));
  }

  /**
   * `room`: a Zombies room (server/rooms.mjs, Yoshi, 7 Nov 2026): { id, owner, arena, edge }. A room is a
   * game of its own, with its own players, doors, panes and zombies; it and the open world never see
   * each other. Null for the open world.
   */
  constructor(auth, allowedHosts, room = null) {
    this.auth = auth;
    this.allowedHosts = allowedHosts;
    this.room = room;
    this.nextRoomMode = 0; // a room's game starts or stops at most once in ROOM_MODE_MS
    this.hub = null; // server/rooms.mjs: the open world and every room (kicks, a name in one place at a time)
    this.roles = new Map(); // username -> the role they played here with (a Zombies run counts for accounts only)
    this.homes = null; // the code-locked homes (server/homes.mjs), set by server.mjs: who has a code's grant
    // No compression: chat (typed by players) shares the connection with game state.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
    this.players = new Map(); // username -> { ws, role, color, state, lastChat }
    this.doors = Object.create(null); // door id -> open (no prototype: ids like toString are only ids)
    this.doorDir = Object.create(null); // door id -> 1 or -1: the way a double-action door swings
    this.rules = { ...RULES };
    this.mood = DEFAULT_CHOICE; // the weather and time of day for everyone (shared/moods.mjs), set by the admin
    // Its cycle when it is 'auto': every page works out the same weather from this and the server's clock (MoodCycle),
    // with snow in it only in winter by the server's Belgian date (moodSeason).
    this.moodCycle = newCycle(randomInt(0, 2 ** 32), Date.now(), winterAt(Date.now()));
    this.moodRun = runOf(this.moodCycle);
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
    /**
     * Who may take away what a player spawned (/remove): 'f12', 't p3', 'c7' (a piece, a Tesla, a
     * character) -> the session that spawned it. A session, not the name a piece shows (`by`): a guest's
     * name can be taken again once they leave, or picked to look like an owner tag ('layout'). Kept
     * here only, never sent (a session key is a secret); gone with a restart, after which only the
     * admin takes them away.
     */
    this.owners = new Map();
    this.cars = Object.fromEntries(Object.entries(CARS.cars).map(([id, c]) => [id, { id, ...c.park, s: 0, driver: null, passenger: null }]));
    this.placing = 0; // placed Teslas on their way into the database (they count towards the most)
    // Bikes: back at their racks at each start; one rider each.
    this.bikes = Object.fromEntries(Object.entries(BIKES.bikes).map(([id, k]) => [id, { id, ...k.park, rider: null }]));
    this.bikeAt = {}; // bike id -> when its pose was taken (the server's clock, ms)
    // Horses: on their walks until someone rides one; left where they are got off (until a restart).
    this.horses = HORSES.herd.map((_, i) => ({ i, x: 0, z: 0, yaw: 0, speed: 0, rider: null, parked: false }));
    this.modes = new Modes(this); // hide and seek, tag, treasure hunt, the teams, Zombies (the admin starts them)
    this.zombieBests = Object.create(null); // place id -> the best wave ever in the Zombies game there (loadRules, saveZombieBest)
    // The ticks (see snapshot): their count, and what each car, horse and strongman looked like in the
    // last one, kept here so the objects sent in 'car' and 'horse' messages stay as they are.
    this.tickNo = 0;
    this.sent = new Map(); // 'c' + car id, 'h' + horse, 'k' + bike id, 'b' + strongman id -> its fields in the last tick
    this.carAt = {}; // car id -> when its pose was taken (the server's clock, ms)
    this.horseAt = this.horses.map(() => 0);
    this.football = new Football((x, z) => HOUSE.ground + TERRAIN.height(x, z)); // the footballs (server/football.mjs)
    this.timers = [
      setInterval(() => this.tick(), TICK_MS).unref(),
      setInterval(() => this.moodSeason(Date.now()), 60_000).unref(), // winter begins or ends: snow on Auto or not
      // Sessions can end while connected (logout, password reset, account deleted or turned off,
      // kicked, expired): close those connections within a second.
      setInterval(() => {
        for (const [name, p] of this.players) {
          if (!this.auth.sessions.has(p.key)) p.ws.close(4002, 'Session ended');
        }
      }, 1000).unref(),
    ];
  }

  /** A room is closed (server/rooms.mjs): its clocks stop, its zombies go, anyone still in it is told. */
  close() {
    for (const t of this.timers) clearInterval(t);
    if (this.modes.state.kind === 'zombies') this.modes.state.z.stop();
    for (const p of this.players.values()) p.ws.close(4004, 'The room was closed');
    this.wss.close();
  }

  /**
   * A new room starts as the open world is now (server/rooms.mjs): the furniture, the placed Teslas, the
   * rules and the weather, copied, so a room's game changes none of it. The best waves are shared.
   */
  copyWorldFrom(main) {
    for (const [id, f] of main.furniture) this.furniture.set(id, f);
    this.furnitureEdited = main.furnitureEdited;
    for (const [id, c] of Object.entries(main.cars)) if (c.kind) this.cars[id] = { ...c, driver: null, passenger: null };
    this.rules = { ...main.rules, maxPlayers: this.room.max };
    this.mood = main.mood;
    this.moodCycle = main.moodCycle;
    this.moodRun = main.moodRun;
    this.zombieBests = main.zombieBests;
    this.homes = main.homes;
  }

  /** What a page in a room is told about it: its id, who opened it, its place. Null in the open world. */
  roomView() {
    return this.room ? { id: this.room.id, owner: this.room.owner, place: this.room.arena.id } : null;
  }

  /**
   * HTTP upgrade to WebSocket: only same-site pages with a valid session. `gone`: the page asked for a
   * room that isn't there (any more): told so in a message and a close of its own (server/rooms.mjs).
   */
  upgrade(req, socket, head, gone = false) {
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
    if (gone) {
      return this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.send(ws, { t: 'roomgone' });
        ws.close(4004, 'No such room');
      });
    }
    const already = this.players.has(session.username);
    // The page asks for the ticks it reads (/ws?v=2, shared/wire.mjs); without, it is from before them.
    const v = Number(new URL(req.url, 'http://local').searchParams.get('v'));
    const proto = v >= PROTO ? PROTO : 1;
    if (!already && this.full(session.role)) {
      // A browser can't read why an upgrade was refused (it only sees a dropped connection), so the page
      // is told in a message and a close of its own; it tries again later (src/net/client.ts).
      return this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.send(ws, { t: 'full', max: this.rules.maxPlayers });
        ws.close(4003, 'The house is full');
      });
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.join(ws, session, req, proto));
  }

  /**
   * No room for one more: as many as the admin allows play. The admin always gets in (up to
   * MAX_PLAYERS), since raising the limit or kicking someone is only done from inside the game.
   */
  full(role = 'guest') {
    if (this.room) return this.players.size >= this.room.max; // a room holds its few, the admin included
    return this.players.size >= (role === 'admin' ? MAX_PLAYERS : this.rules.maxPlayers);
  }

  join(ws, session, req, proto = 1) {
    const name = session.username;
    const old = this.players.get(name);
    if (old) old.ws.close(4000, 'Logged in somewhere else');
    this.releaseCar(name); // the replaced connection was driving
    this.releaseHorse(name);
    this.releaseBike(name);
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
    const now = Date.now();
    const score = this.scores.get(name) || { kills: 0, deaths: 0, points: 0 };
    this.scores.set(name, score);
    const player = {
      ws, key: session.key, role: session.role, color, state: null, lastChat: 0, msgs: 0, window: now, address: this.auth.addressOf(req),
      // The browser that joined (its guest cookie's id, kept with the session): what a kick keeps out
      // (server/auth.mjs). Never the cookie this connection happens to carry: that one proves nothing.
      device: session.device ?? null,
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
    // A place outside the edge that holds now (a game in the house began while they were away) is the street too.
    let at = old?.state ?? this.lastPos.get(name) ?? SPAWNS[0];
    if (!this.fence().inside(at.x, at.z)) at = SPAWNS[0];
    if (!this.gate.mayStand(player, at.x, at.y, at.z)) at = SPAWNS[0]; // last seen inside a home whose code this session has not typed
    player.state = { x: at.x, y: at.y, z: at.z, yaw: 0, pitch: 0, armed: false, flying: false, w: 'pistol', c: false };
    player.joinedAt = { x: at.x, z: at.z }; // a start place is only taken from here (see spawn)
    player.movedAt = now;
    player.budget = player.vbudget = 0.5;
    this.players.set(name, player);
    this.roles.set(name, session.role);
    this.hub?.joined(name, this, session); // one place at a time: a connection in the open world or another room ends
    this.auth.log('mp_join', req, { username: name, ...(this.room ? { detail: `room ${this.room.id}` } : {}) });

    this.send(ws, {
      t: 'welcome', proto: PROTO, you: name, role: session.role, color, doors: this.doorsFor(player), doorDir: this.doorDirFor(player), broken: this.brokenFor(player), homes: HOMES.filter((h) => player.role !== 'admin' && this.homes?.granted(player.key, h.id)).map((h) => h.id), players: this.roster(),
      time: now, cats: this.catsDown.map((until) => Math.max(0, until - now)), clowns: this.clownList(now), furniture: this.furnitureFor(player), rules: this.rules,
      scores: this.scoreList(), limit: KILL_LIMIT, items: this.items.map((it) => now >= it.until), round: this.roundOver ? { winner: this.roundOver.winner, ms: this.roundOver.until - now } : null,
      cars: Object.values(this.cars), horses: this.horses, bikes: Object.values(this.bikes), mode: this.modes.view(now), mood: this.mood, moodCycle: this.moodView(now),
      room: this.roomView(),
    });
    this.broadcast({ t: 'join', name, color }, name);
    this.modes.join(name);
    // In a room without a game on: at the place's start, on the ground (a game on puts them in itself: zombies.mjs join).
    if (this.room && !this.modes.zombies) this.gather([name], this.room.arena);
    this.broadcast({ t: 'scores', list: this.scoreList() }, name);

    ws.on('message', (raw) => this.receive(name, player, raw));
    ws.on('close', () => {
      if (this.players.get(name) === player) {
        if (player.state) this.lastPos.set(name, { x: player.state.x, y: player.state.y, z: player.state.z });
        this.players.delete(name);
        this.releaseCar(name);
        this.releaseHorse(name);
        this.releaseBike(name);
        this.modes.leave(name, player);
        this.broadcast({ t: 'leave', name });
        this.broadcast({ t: 'scores', list: this.scoreList() });
        if (player.role === 'admin') this.moodAdminLeft(Date.now());
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
    if (this.modes.state.kind === 'zombies') return; // they stand aside during the Zombies game (the pages hide them)
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
      this.npcDamage(name, p, hurtBy(Math.hypot(s.x - at.x, s.z - at.z), radius, damage), now, 'a strongman', at);
    }
  }

  /** A strongman loses health; at nothing he goes down for everyone. */
  hurtBrute(c, name, amount, w, now) {
    c.brain.hp = Math.max(0, c.brain.hp - amount);
    if (c.brain.hp > 0) return;
    c.until = now + CLOWNS.respawnSeconds * 1000;
    this.broadcast({ t: 'clownhit', id: c.id, by: name, ms: CLOWNS.respawnSeconds * 1000, w });
  }

  /** Health taken by a strongman (or a zombie, `by`): like damage(), but nobody scores the kill. */
  npcDamage(targetName, target, amount, now, by = 'a strongman', from) {
    if (!target.alive || amount <= 0 || this.calm(target)) return;
    target.hp = Math.max(0, target.hp - amount);
    target.hurtAt = now; // a teammate helping someone up lets go when hit (server/zombies.mjs help)
    if (target.hp > 0) return this.send(target.ws, { t: 'hurt', hp: target.hp, by, ...(from ? { from: { x: from.x, z: from.z } } : {}) });
    target.alive = false;
    // In the Zombies game whoever goes down waits for the end of the wave (server/zombies.mjs revive).
    const zombies = this.modes.zombies;
    target.respawnAt = zombies ? Infinity : now + RESPAWN_MS;
    this.releaseCar(targetName);
    this.releaseHorse(targetName);
    this.releaseBike(targetName);
    target.score.deaths++;
    target.weapons = loadout(target.role); // dropped what they picked up
    this.broadcast({ t: 'kill', killer: by, victim: targetName, head: false, w: by === 'a strongman' ? 'strongman' : 'zombie' });
    this.stats(targetName, { deaths: 1 });
    this.broadcast({ t: 'scores', list: this.scoreList() });
    zombies?.downed(targetName);
  }

  /** A zombie's swipe (or a big one's pound) landed on a player who fights, unless they're just back. */
  zombieHurt(name, p, amount, big, now, from) {
    if (!p.alive || !p.state?.armed || this.inCar(name) || now < p.protectedUntil) return;
    this.npcDamage(name, p, amount, now, big ? 'a big zombie' : 'a zombie', from);
  }

  /** A weapon's numbers (shared/weapons.json), or null for a name that isn't one. */
  weaponSpec(w) {
    return typeof w === 'string' && Object.hasOwn(WEAPONS, w) ? WEAPONS[w] : null;
  }

  /**
   * What the zombies walk on for a new game at `arena` (shared/arenas.mjs; server/zombies.mjs): at home
   * the grid over the party area with every floor of the two houses and their doors, with whether each
   * stands open now (a zombie shoves a shut one open: zombieDoor); in Smetlede the grid over its circle
   * with the village's blocks, hedges and fences, the buildings shut. The cars where they stand now,
   * the places over the open ground where zombies come out, where they go when nobody fights, and the
   * edge. About 40 ms at home, 5 in the village.
   */
  zombieGround(arena) {
    const edge = arenaEdge(arena, BOUNDS);
    const boxes = Object.values(this.cars).filter((c) => edge.inside(c.x, c.z)).map((c) => {
      const s = carSpec(c);
      return { x: c.x, z: c.z, yaw: c.yaw, halfL: s.length / 2, halfW: s.width / 2 };
    });
    const height = (x, z) => TERRAIN.height(x, z);
    // The village's part never changes per place: made once (a start no longer walks all the blocks again).
    const village = arena.center ? villageGroundOf(arena, edge) : null;
    const nav = village
      ? makeNav({ prisms: village.prisms, height, base: HOUSE.ground, edge, boxes, areas: village.areas, doors: [], shut: true, panes: 0 })
      : makeNav({ prisms: ZOMBIE_PRISMS, height, base: HOUSE.ground, edge, boxes, areas: HOUSE_AREAS, doors: HOUSE.doors, shut: false, panes: HOUSE.prisms.length });
    if (!arena.center) nav.setPanes(this.broken);
    return {
      nav, edge, spots: arenaSpots(arena, nav.spawnSpots(), VILLAGE, CAFE), home: arenaHome(arena), doors: arena.center ? [] : HOUSE.doors,
      doorOpen: (id) => this.doors[id] ?? DOOR_OPEN[id] ?? true,
    };
  }

  /**
   * A zombie shoved door `id` open (shared/zombies.mjs): for every page, as a player's toggle is. Only
   * the house data's doors; the horde shoves one door at most once in 1.5 s.
   */
  zombieDoor(id, dir) {
    if (!Object.hasOwn(DOOR_OPEN, id)) return;
    this.doors[id] = true;
    if (dir === 1 || dir === -1) this.doorDir[id] = dir;
    this.broadcastHome({ t: 'door', id, open: true, dir: this.doorDir[id] ?? 1, by: '' }, homeOfDoor(id));
  }

  /**
   * The best wave ever reached in the Zombies game at place `id` ({ wave, names, at }), kept with the
   * rules: home's under its first key (its record from before the places stays), the others' with their id.
   */
  saveZombieBest(id, best) {
    this.zombieBests[id] = best;
    this.auth.store.setMeta(bestKey(id), JSON.stringify(best)).catch((e) => console.error('zombies best failed', String(e)));
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
    if (this.modes.noShooting && ['hit', 'rocket', 'nade', 'boom', 'shot'].includes(m.t)) return; // no fighting during a party game
    // A room changes nothing of the open world and holds its players at its place (server/rooms.mjs).
    if (this.room && ROOM_REFUSED.has(m.t)) return;

    if (m.t === 'state') {
      const prev = player.state;
      const wasArmed = !!prev?.armed;
      const car = this.carOf(name);
      const driving = car?.driver === name;
      const inCar = !!car;
      const horse = this.horseOf(name);
      const bike = car || horse ? null : this.bikeOf(name);
      const next = {
        ...where(m),
        // No flying in the Zombies game: hovering over the zombies would be out of their reach for good.
        yaw: num(m.yaw, -100, 100), pitch: num(m.pitch, -2, 2), armed: !!m.armed, flying: !!m.flying && this.rules.flying && !inCar && !bike && !this.modes.zombies,
        w: player.weapons.has(m.w) ? m.w : 'pistol', c: !!m.c && !inCar && !bike, d: inCar, s: driving ? num(m.s, -1, 1) : 0, bk: !!bike,
        // In a drop, and its canopy out: only while the server has them dropping (a page can't claim one, see drop).
        chute: !!m.pc && this.dropping(player, now),
        open: !!m.pc && !!m.po && this.dropping(player, now),
      };
      // The page says it landed (not before its first messages from the sky can have come), or the drop took too long.
      if (player.drop && (!this.dropping(player, now) || (!m.pc && now - player.drop.from > DROP.graceMs))) this.landed(player, now);
      // Never faster than anyone can move: a movement budget refills at MAX_SPEED (the car's
      // speed for its driver; at most half a second's worth stored) and each update spends it,
      // however often updates come. A faked jump only gets as far as running would; a lagging
      // player catches up.
      // Across and up or down each have a budget: on foot running is held to the real pace while a fall
      // from the roof may still be fast (the admin's extremely fast walking keeps its own). In a drop the
      // server started (and only then) across goes up to the skydive's speed, down as fast as a fall, and
      // up next to nothing (stepping onto a roof's edge): nobody climbs in a drop.
      const drop = this.dropping(player, now);
      // On a bike only while the server has them riding one, never on a page's say (a forged ride state is no speed-hack).
      const speed = inCar ? CAR_SPEED : horse ? HORSE_SPEED : bike ? BIKE_SPEED : player.role === 'admin' ? ADMIN_SPEED : drop ? DROP_SPEED : RUN_SPEED;
      const vspeed = inCar || horse || player.role === 'admin' ? speed : MAX_SPEED;
      const secs = (now - player.movedAt) / 1000;
      const budget = Math.min(speed * 0.5 + 0.5, player.budget + speed * secs);
      const vbudget = Math.min(vspeed * 0.5 + 0.5, (player.vbudget ?? 0.5) + vspeed * secs);
      const dx = next.x - prev.x, dz = next.z - prev.z;
      let dy = next.y - prev.y;
      // (Not in its first moments: a state from before the page knew of the drop, on the ground, can still come.)
      if (drop && dy > 0 && player.role !== 'admin' && now - player.drop.from > DROP.graceMs) {
        const rise = Math.min(DROP_RISE.max, player.drop.rise + DROP_RISE.rate * secs);
        dy = Math.min(dy, rise);
        player.drop.rise = rise - dy;
        next.y = prev.y + dy;
      }
      const across = Math.hypot(dx, dz);
      const step = Math.min(across, budget);
      const vstep = Math.min(Math.abs(dy), vbudget);
      if (across > step) Object.assign(next, { x: prev.x + (dx * step) / across, z: prev.z + (dz * step) / across });
      if (Math.abs(dy) > vstep) next.y = prev.y + Math.sign(dy) * vstep;
      player.budget = budget - step;
      player.vbudget = vbudget - vstep;
      player.movedAt = now;
      // The edge of the game: a position outside it (only a changed page sends one) is put back just inside.
      // The ceiling too, but in a drop the one it started under (it starts over the flying ceiling).
      this.fenceIn(next, prev, drop ? player.drop.top : -Infinity);
      // The inside of the three code-locked homes (server/homeGate.mjs): never taken for a player without the right
      // (an open door of somebody else's is no way in); the page is told, and shuts the home to itself.
      const barred = this.gate.keepOut(player, prev, next);
      if (barred) {
        if (barred.put) this.putOut(player, next, barred.home, now);
        if (this.gate.tell(player, now)) this.send(player.ws, { t: 'homelock', id: barred.home });
      }
      // Down in the Zombies game: they lie where they went down (server/zombies.mjs fell), whatever a
      // changed page says (state spoofing while down: crawling somewhere to be helped up there).
      const fell = !player.alive ? this.modes.zombies?.fell.get(name) : null;
      if (fell) Object.assign(next, fell);
      player.state = next;
      if (drop) this.dropCheck(player, now); // on the ground, or not coming down: the drop ends
      this.stampState(player, m.ct);
      if (driving) {
        Object.assign(car, { x: next.x, y: next.y, z: next.z, yaw: next.yaw, s: next.s });
        this.carAt[car.id] = player.stamp;
      }
      if (horse) {
        Object.assign(horse, { x: next.x, z: next.z, yaw: num(m.hy, -100, 100), speed: num(m.hs, -2, HORSES.gallop), jump: num(m.hj, 0, HORSES.jump.height) });
        this.horseAt[horse.i] = player.stamp;
      }
      if (bike) {
        Object.assign(bike, { x: next.x, y: next.y, z: next.z, yaw: next.yaw });
        this.bikeAt[bike.id] = player.stamp;
      }
      if (player.state.armed !== wasArmed) this.broadcast({ t: 'scores', list: this.scoreList() });
    } else if (m.t === 'rally') {
      const state = player.state;
      if (!player.alive || !state?.armed || now - (player.lastRally ?? 0) < 3000) return;
      if (!['zombies', 'teams'].includes(this.modes.state.kind) || this.modes.state.phase === 'done') return;
      player.lastRally = now;
      for (const [who, other] of this.players) {
        if (!other.state?.armed) continue;
        if (!this.modes.friends(name, who)) continue;
        this.send(other.ws, { t: 'rally', name, x: state.x, y: state.y, z: state.z });
      }
    } else if (m.t === 'kickball') {
      // A football kicked (server/football.mjs checks reach, pace, rate and the kick itself).
      this.football.kick(name, player, m, now, this.onFoot(name));
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
    } else if (m.t === 'unstuck') {
      // Somebody in the end house's fenced garden without the code has no way out: the server puts them outside (the page can't, see putOut).
      if (now < (player.nextUnstuck || 0)) return;
      player.nextUnstuck = now + 1000;
      this.unstuck(name, player, now);
    } else if (m.t === 'door' && typeof m.id === 'string' && DOOR_ID.test(m.id) && KNOWN_DOORS.has(m.id)) {
      // Every page swings the door and plays its sound: at most five a second per player (a message
      // flood would slam doors on every page). Pressing E as fast as one can stays under it.
      if (now < (player.nextDoor || 0)) return;
      player.nextDoor = now + 200;
      if (!this.gate.door(player, m.id)) return; // one of the three code-locked homes' doors, and no right to it
      this.doors[m.id] = !!m.open;
      if (m.dir === 1 || m.dir === -1) this.doorDir[m.id] = m.dir;
      this.broadcastHome({ t: 'door', id: m.id, open: !!m.open, dir: this.doorDir[m.id] ?? 1, by: name }, homeOfDoor(m.id), name); // an inside door's state goes only to those with the right
    } else if (m.t === 'glass' && Number.isInteger(m.i) && m.i >= 0 && m.i < PANE_LIMIT && PANE_HOME.has(m.i)) { // only numbers that are a pane (shared/homes.mjs)
      if (this.broken.size >= 200 || this.broken.has(m.i) || !this.gate.glass(player, m.i)) return; // a code-locked home's pane needs the right too
      this.broken.add(m.i);
      this.broadcastHome({ t: 'glass', i: m.i, by: name }, PANE_HOME(m.i), name);
      this.modes.zombies?.panes(this.broken); // a way in for the zombies too
    } else if (m.t === 'repair') {
      if (now - (this.lastRepair || 0) < 2000) return;
      this.lastRepair = now;
      this.broken.clear();
      this.broadcast({ t: 'repair', by: name });
      this.modes.zombies?.panes(this.broken);
    } else if (m.t === 'shot') {
      // Every page plays each shot (a gunshot, smoke): only from someone who can fire, at most at the
      // weapon's rate (70% of its delay, as for hits). A page could otherwise send forty a second.
      if (this.calm(player)) return; // the school grounds (shared/zones.mjs)
      const w = player.weapons.has(m.w) ? m.w : 'pistol';
      if (!player.alive || !player.state?.armed || this.inCar(name) || now < (player.nextShot || 0)) return;
      player.nextShot = now + WEAPONS[w].delay * 700;
      this.broadcast({ t: 'shot', name, w, ...where(m) }, name);
    } else if (m.t === 'furn') {
      if (now < (player.nextFurn || 0)) return;
      player.nextFurn = now + 400; // each one a database write
      this.furnish(name, player, m).catch((e) => console.error('furniture failed', String(e)));
    } else if (m.t === 'clownhit' && this.modes.state.kind === 'zombies') {
      // The clowns and strongmen stand aside during the Zombies game (the pages hide them).
    } else if (m.t === 'zhit') {
      // A shot that hit zombies (server/zombies.mjs checks it as a hit on a strongman is checked).
      this.modes.zombies?.hit(name, player, m, now);
    } else if (m.t === 'zitem') {
      // Walking over a reward (server/zombies.mjs take: there, within reach, of use, taken once).
      this.modes.zombies?.take(name, player, m, now);
    } else if (m.t === 'claymore') {
      // Placing a claymore (server/zombies.mjs place: carried, on a floor near the player, two down at most).
      this.modes.zombies?.place(name, player, m, now);
    } else if (m.t === 'stakes') {
      // Planting a row of stakes (server/zombies.mjs stakes: carried, on a floor near the player, as a claymore).
      this.modes.zombies?.stakes(name, player, m, now);
    } else if (m.t === 'turret') {
      // Setting up a turret (server/zombies.mjs turret: carried, on a floor near the player; it aims and shoots on the server).
      this.modes.zombies?.turret(name, player, m, now);
    } else if (m.t === 'placement') {
      const game = this.modes.zombies;
      if (!game || !player.alive || !player.state?.armed || this.inCar(name) || this.calm(player) || now - (player.lastPreview ?? 0) < 150) return;
      if (!['claymore', 'stakes', 'turret'].includes(m.kind) || !Number.isSafeInteger(m.id) || m.id < 0 || m.id > 1000000000) return;
      if (![m.x, m.y, m.z, m.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      player.lastPreview = now;
      const result = game.loot.preview(m.kind, name, player.state, m, now);
      this.send(player.ws, { t: 'placement', id: m.id, ...result });
    } else if (m.t === 'revive') {
      // Helping a downed teammate up, or letting go (server/zombies.mjs help: the time on the server's clock).
      this.modes.zombies?.help(name, player, m, now);
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
    } else if (m.t === 'clown') {
      // A clown or a strongman spawned with /clown, /strongman, or one taken away with /remove: the admin
      // always and any; the others when the admin allows spawning, near themselves, SPAWN_CHARACTERS each,
      // and only their own taken away.
      if (now < (player.nextClown || 0)) return;
      player.nextClown = now + 400;
      const admin = player.role === 'admin';
      const no = (code, text) => this.send(player.ws, { t: 'system', text, code, args: { n: SPAWN_CHARACTERS } });
      if (m.op === 'add') {
        if (!admin && !this.rules.spawn) return no('spawnOff', 'The admin has turned spawning off.');
        if (this.clowns.size >= CLOWNS.max) return;
        let at;
        if (admin) at = { x: +num(m.x, AREA.x0, AREA.x1).toFixed(2), y: +num(m.y, -20, 40).toFixed(2), z: +num(m.z, AREA.z0, AREA.z1).toFixed(2) };
        else {
          at = this.spawnSpot(player, m);
          if (!at) return no('spawnFar', 'That is too far from you.');
          if (this.ownedBy(player, 'c') >= SPAWN_CHARACTERS) return no('spawnCharacters', `You have ${SPAWN_CHARACTERS} out already. Take one away with /remove.`);
        }
        const id = this.nextClown++;
        this.clowns.set(id, this.character(id, at.x, at.y, at.z, kindOf(m.kind)));
        this.owners.set(`c${id}`, player.key);
      } else if (m.op === 'remove' && this.clowns.has(m.id)) {
        if (!admin && this.owners.get(`c${m.id}`) !== player.key) return no('spawnNotYours', 'You can only take away what you spawned yourself.');
        this.clowns.delete(m.id);
        this.owners.delete(`c${m.id}`);
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
      // No driving in the Zombies game: a car is out of the zombies' reach, and nobody runs them over at a family game.
      if (m.op === 'in' && this.modes.zombies) return this.send(player.ws, { t: 'system', text: 'No driving during Zombies.', code: 'zNoCar' });
      if (m.op === 'in' && Object.hasOwn(this.cars, m.id)) this.enterCar(name, player, this.cars[m.id]);
      else if (m.op === 'out') this.releaseCar(name);
    } else if (m.t === 'tesla') {
      this.placeCar(name, player, m, now).catch((e) => console.error('tesla failed', String(e)));
    } else if (m.t === 'horse') {
      if (now < (player.nextCar || 0)) return;
      player.nextCar = now + 300;
      if (m.op === 'on' && this.modes.zombies) return this.send(player.ws, { t: 'system', text: 'No riding during Zombies.', code: 'zNoHorse' });
      if (m.op === 'on' && Number.isInteger(m.i) && this.horses[m.i]) this.mountHorse(name, player, this.horses[m.i], now);
      else if (m.op === 'off') this.releaseHorse(name);
    } else if (m.t === 'bike') {
      // On or off a bike: at most three times a second (shared with the cars and horses); on only with a known
      // id, and the server checks the rest (mountBike). Not during Zombies, as the cars and horses.
      if (now < (player.nextCar || 0)) return;
      player.nextCar = now + 300;
      if (m.op === 'on' && this.modes.zombies) return this.send(player.ws, { t: 'system', text: 'No cycling during Zombies.', code: 'zNoBike' });
      if (m.op === 'on' && typeof m.id === 'string' && Object.hasOwn(this.bikes, m.id)) this.mountBike(name, player, this.bikes[m.id], now);
      else if (m.op === 'off') this.releaseBike(name);
    } else if (m.t === 'bell') {
      // A bike's bell: only from its rider, at most every BELL_MS. The others ring it where the server has
      // that bike (the message carries no place of its own), so nobody rings it from somewhere else.
      const bike = this.bikeOf(name);
      if (!bike || now < (player.nextBell || 0)) return;
      player.nextBell = now + BELL_MS;
      this.broadcast({ t: 'bell', id: bike.id }, name);
    } else if (m.t === 'rocket') {
      this.rocket(name, player, m, now);
    } else if (m.t === 'nade') {
      this.throwNade(name, player, m, now);
    } else if (m.t === 'boom') {
      this.boom(name, player, m, now);
    } else if (m.t === 'hit' && typeof m.target === 'string' && Object.hasOwn(WEAPONS, m.w)) {
      const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
      this.hit(name, player, m.target, m.w, count(m.body), count(m.head), now);
    } else if (m.t === 'mode' && this.room && (m.kind === 'zombies' || m.kind === 'free')) {
      // In a room only Zombies, at the room's place. Anyone in it may start a game when none is on; stopping
      // one that runs is for players with an account and the admin (a guest can't end it for everyone).
      // Once a second per player, and once in ROOM_MODE_MS per room: several players starting and stopping in turn
      // can't make the server build the zombies' map over and over (denial of service).
      if (now < (player.nextMode || 0) || now < this.nextRoomMode) return;
      player.nextMode = now + 1000;
      const running = !!this.modes.zombies;
      if (m.kind === 'zombies' ? running : !running || player.role === 'guest') return;
      this.nextRoomMode = now + ROOM_MODE_MS;
      this.modes.start(m.kind, name, this.room.arena.id);
    } else if (m.t === 'mode' && !this.room && player.role === 'admin' && typeof m.kind === 'string') {
      // `place`: where Zombies is played (shared/arenas.mjs; an unknown one plays at home).
      this.modes.start(m.kind, name, typeof m.place === 'string' ? m.place.slice(0, 30) : 'house');
    } else if (m.t === 'zwave' && player.role === 'admin') {
      const zombies = this.modes.zombies;
      if (!zombies || now < (player.nextWave || 0) || !Number.isInteger(m.wave) || m.wave < 1 || m.wave > MAX_ADMIN_WAVE) return;
      player.nextWave = now + 1000;
      zombies.selectWave(m.wave, name, now);
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
    } else if (m.t === 'chute') {
      this.manualDrop(name, player, now);
    } else if (m.t === 'travel' && typeof m.to === 'string' && m.to.length <= 64) {
      // At most four asks a second (a page asks once a trip); more go unanswered, so a flood costs nothing.
      if (now < (player.nextTravelAsk || 0)) return;
      player.nextTravelAsk = now + 250;
      this.travel(name, player, m.to, m.via === 'chat', now);
    } else if (m.t === 'rules' && player.role === 'admin') {
      this.setRules(m, name).catch((e) => console.error('rules failed', String(e)));
    } else if (m.t === 'mood' && player.role === 'admin') {
      this.setMood(name, player, m.mood, now);
    } else if (m.t === 'moodskip' && player.role === 'admin') {
      this.skipMood(name, player, now);
    } else if (m.t === 'moodspeed' && player.role === 'admin') {
      this.moodSpeed(name, player, m.speed, now);
    } else if (m.t === 'kick' && player.role === 'admin' && typeof m.name === 'string' && m.name !== name) {
      (this.hub ? this.hub.kick(m.name, name) : this.kick(m.name, name)).catch((e) => console.error('kick failed', String(e)));
    }
  }

  /**
   * A trip through the portals to portal `id`. From a portal: where the server has the player
   * must be on one (the car's middle on it for a driver). From the chat: only when the admin
   * allows it, and the admin always may. Never when down or on horseback, at most one trip every
   * TRAVEL_MS; a driver takes the car and its passenger along, a passenger can't go alone. The
   * end is always one of the fixed portals' spots, so a forged message gets no further than
   * walking onto a portal does (a position spoofing "teleport hack" can't pick its spot).
   * A street's spot (PLACES, /location kapellenhoek) the same way, from the chat only (it has no
   * pad); an id that is neither is refused. The end must be inside the edge that holds now.
   */
  /**
   * Where a player starts, picked on the start screen: one of the portal places' arrival spots. The
   * page sends it once its world is in. Taken once, in the first 90 seconds, and only while the
   * player is still where the server put them on joining (within 30 m: their first updates may
   * cross it), alive, on foot, with the portals on. So it is a start, never a free trip later.
   */
  spawn(name, p, id, now) {
    if (id === 'home') return this.homeDrop(name, p, now);
    const to = PORTALS.find((q) => q.id === id);
    const st = p.state;
    if (!to || p.spawned || !st || !p.joinedAt) return;
    p.spawned = true;
    // Refused: the page goes back to where the server has the player, so both agree.
    const no = () => this.send(p.ws, { t: 'spawn', ok: false, x: st.x, z: st.z });
    if (now - p.joinTime > 90_000 || !p.alive || this.carOf(name) || this.horseOf(name) || this.bikeOf(name) || (!this.rules.portals && p.role !== 'admin')) return no();
    if (Math.hypot(st.x - p.joinedAt.x, st.z - p.joinedAt.z) > 30) return no();
    const [x, z, yaw] = to.out;
    if (!this.fence().inside(x, z)) return no(); // a game in the house: only a start near it
    p.nextTravel = now + TRAVEL_MS;
    const ground = TERRAIN.height(x, z);
    // Arriving by parachute (the admin's rule): over the start place, the page told so (it is there already, on the ground).
    // Never during Zombies (Yoshi, 7 Nov 2026): a late join walks in.
    const drop = this.rules.parachute && !this.modes.zombies;
    const from = drop ? this.dropFrom(x, z, yaw) : { x, z }; // behind the place: without steering it lands there
    Object.assign(p.state, { x: from.x, y: drop ? ground + DROP.height : ground, z: from.z });
    p.budget = p.vbudget = 0.5;
    p.movedAt = now;
    this.moved(p);
    if (drop) {
      this.startDrop(p, now);
      this.send(p.ws, { t: 'spawn', ok: true, drop: 1, x, z, yaw, sx: from.x, sz: from.z });
    }
  }

  /**
   * A fresh arrival at the house's start (the page's own start in the lane in front of the house, where the
   * server has everyone who joins): by parachute when the admin's rule is on, down the lane onto it
   * (HOME_DROP). Never a trip: taken once with the start places, in the first 90 seconds, alive, on foot, and
   * only while the server still has the player within 30 m of that start (a drop onto where they are, as a
   * fresh join is). Otherwise nothing changes: the page stays on its feet.
   */
  /**
   * /parachute in the chat (Yoshi): a skydive from high over where the player stands, flown freely from there. The
   * server decides it: the admin's rule on, alive, on foot, outdoors, not in a drop already, no game of the menu going
   * on (Zombies or a party game: a drop is out of every fight), not hit in the last HURT_CALM_MS (no escaping a fight
   * in the air, where nobody can be hurt), inside the game's edge, and at most once every CHUTE_MS. A refusal says
   * why with a code the page translates. It starts behind them facing their way (hands off, it lands where they
   * stand), or straight over them near the edge.
   */
  manualDrop(name, p, now) {
    const st = p.state;
    if (!st) return;
    const no = (code, args = {}) => this.send(p.ws, { t: 'chute', ok: false, code, args });
    if (!this.rules.parachute) return no('chuteOff');
    if (!p.alive || this.carOf(name) || this.horseOf(name) || this.bikeOf(name) || this.dropping(p, now) || this.modes.active) return no('chuteNotNow');
    if (now - (p.hurtAt ?? -Infinity) < HURT_CALM_MS) return no('chuteFight');
    if (now < (p.nextChute ?? 0)) return no('chuteWait', { s: Math.ceil((p.nextChute - now) / 1000) });
    if (INDOORS(st.x, st.z)) return no('chuteIndoors'); // go outside first
    if (!this.fence().inside(st.x, st.z)) return no('chuteNotNow');
    p.nextChute = now + CHUTE_MS;
    const x = st.x, z = st.z;
    const yaw = Number.isFinite(st.yaw) ? st.yaw : 0;
    const from = this.dropFrom(x, z, yaw);
    Object.assign(st, { x: from.x, y: HOUSE.ground + TERRAIN.height(x, z) + DROP.height, z: from.z });
    p.budget = p.vbudget = 0.5;
    p.movedAt = now;
    this.moved(p);
    this.startDrop(p, now);
    this.send(p.ws, { t: 'spawn', ok: true, drop: 1, x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, yaw, sx: from.x, sz: from.z });
  }

  homeDrop(name, p, now) {
    const st = p.state;
    if (p.spawned || !st) return;
    p.spawned = true;
    const { x, z, yaw } = HOME_DROP;
    if (!this.rules.parachute || this.modes.zombies || now - p.joinTime > 90_000 || !p.alive || this.carOf(name) || this.horseOf(name) || this.bikeOf(name)) return;
    if (Math.hypot(st.x - x, st.z - z) > 30 || !this.fence().inside(x, z)) return;
    const from = this.dropFrom(x, z, yaw); // behind the start, along the lane: without steering it lands there
    Object.assign(st, { x: from.x, y: HOUSE.ground + TERRAIN.height(x, z) + DROP.height, z: from.z });
    p.budget = p.vbudget = 0.5;
    p.movedAt = now;
    this.moved(p);
    this.startDrop(p, now);
    this.send(p.ws, { t: 'spawn', ok: true, drop: 1, x, z, yaw, sx: from.x, sz: from.z });
  }

  travel(name, p, id, chat, now) {
    const st = p.state;
    const to = PORTALS.find((q) => q.id === id) ?? PLACES.get(id);
    // The refusal's English text, and its code for a page in another language (src/i18n.ts).
    const no = (text = '', code = undefined) => this.send(p.ws, { t: 'travel', name, to: id, ok: false, text, code });
    if (!to || !st || !p.alive || now < (p.nextTravel || 0) || (to.street && !chat)) return no();
    if (this.fenced()) return no("You can't travel during the game.", 'travelGame'); // everyone stays near the house (see fence)
    if (chat && !this.rules.travel && p.role !== 'admin') return no('The admin has turned travelling from the chat off. Walk to a portal.', 'travelChatOff');
    if (!chat && !this.rules.portals) return no('The admin has turned the portals off.', 'travelPortalsOff');
    const car = this.carOf(name);
    if (car && car.driver !== name) return no('Only the driver can take the car through.', 'travelDriverOnly');
    if (this.horseOf(name)) return no('Get off the horse first.', 'travelHorse');
    if (this.bikeOf(name)) return no('Get off the bike first.', 'travelBike');
    if (!chat) {
      const on = portalNear(st.x, st.z, (car ? CAR_REACH : REACH) + TRAVEL_SLACK);
      if (!on || on === to) return no();
    }
    const [x, z, yaw] = car ? to.car : to.out;
    if (!this.fence().inside(x, z)) return no();
    p.nextTravel = now + TRAVEL_MS;
    const y = TERRAIN.height(x, z); // near enough: the player's next update has their feet exactly
    const move = (q) => {
      if (q.drop) this.landed(q, now);
      Object.assign(q.state, { x, y, z });
      q.budget = q.vbudget = 0.5;
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

  /**
   * Put a player out of a home they have no right to (they stood inside when their code ended): in front of it, where its
   * portal brings you out, on the ground, as a trip does (the page goes to the same spot), inside the game's edge, with
   * the movement budgets reset, and the others see a jump.
   */
  putOut(p, next, home, now) {
    let [x, z] = this.gate.outOf(home);
    const fence = this.fence();
    if (!fence.inside(x, z)) ({ x, z } = fence.putBack(x, z, 0.3) ?? SPAWNS[0]); // a game whose edge leaves the portal outside
    Object.assign(next, { x, y: TERRAIN.height(x, z), z });
    p.budget = p.vbudget = 0.5;
    p.movedAt = now;
    this.moved(p);
  }

  /**
   * The end house's garden is fenced and reached only through the house: a player in it without the code (they dropped
   * in) is put out at the portal, on the ground only: never in the air (falling, a parachute, flying), nor on the roof.
   */
  unstuck(name, p, now) {
    const st = p.state;
    if (!st || !p.alive || st.flying || this.dropping(p, now) || this.carOf(name) || this.horseOf(name) || this.bikeOf(name)) return;
    if (!inEndGarden(st.x, st.z, st.y) || this.gate.may(p, 'molenhoek_end')) return;
    this.putOut(p, st, 'molenhoek_end', now);
    this.send(p.ws, { t: 'unstuck', x: st.x, z: st.z });
  }

  /** Get in, when the player stands next to it, is alive and in no car yet: at the wheel if nobody drives, else in the passenger seat if it's free. */
  enterCar(name, p, car) {
    const st = p.state;
    if (this.carOf(name) || this.bikeOf(name) || !p.alive || !st) return this.send(p.ws, { t: 'car', car });
    // Close to its outline: the middle of the car plus its half diagonal and the reach.
    const spec = carSpec(car);
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
    if (horse.rider || this.carOf(name) || this.horseOf(name) || this.bikeOf(name) || !p.alive || !st) return this.send(p.ws, { t: 'horse', horse });
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

  /**
   * Get on a bike nobody rides (taking a ridden bike is refused), when the player is alive, on foot
   * (in no car, on no horse or bike, not flying or in a drop) and stands next to it: within its half
   * diagonal plus the reach, and at its height. A refusal tells the page the bike as it is.
   */
  mountBike(name, p, bike, now) {
    const st = p.state;
    if (bike.rider || this.carOf(name) || this.horseOf(name) || this.bikeOf(name) || !p.alive || !st || st.flying || this.dropping(p, now)) return this.send(p.ws, { t: 'bike', bike });
    const near = Math.hypot(BIKES.length, BIKES.width) / 2 + BIKES.reach + 0.5;
    if (Math.hypot(st.x - bike.x, st.z - bike.z) > near || Math.abs(st.y - bike.y) > 1.5) return this.send(p.ws, { t: 'bike', bike });
    bike.rider = name;
    this.broadcast({ t: 'bike', bike });
  }

  /** The rider got off, left, died or respawned: the bike stays where it is, on its stand. */
  releaseBike(name) {
    const bike = this.bikeOf(name);
    if (!bike) return;
    bike.rider = null;
    this.broadcast({ t: 'bike', bike });
  }

  /** The bike a player rides, if any. */
  bikeOf(name) {
    for (const k of Object.values(this.bikes ?? {})) if (k.rider === name) return k;
    return null;
  }

  /**
   * A game in the house is being played (not once its result shows): everyone stays near the two
   * houses and nobody travels. All four games are played round them (the teams start at their house).
   */
  fenced() {
    if (this.room) return true; // a room always keeps its players at its place, between games too
    return this.modes.active && this.modes.state.phase !== 'done';
  }

  /**
   * The edge that holds now (shared/bounds.json): round the two houses during a game in the house, or
   * round the place Zombies is played at (shared/arenas.mjs), else round the built-up area.
   */
  fence() {
    if (this.room) return this.modes.zombies?.edge ?? this.room.edge;
    return this.fenced() ? (this.modes.zombies?.edge ?? BOUNDS.party) : BOUNDS.map;
  }

  /**
   * A player's new state `s` (a driver's is the car's, a rider's the horse's) kept inside the edge
   * and under the flying ceiling, in place: a point outside goes to the nearest point 30 cm inside;
   * if none is found, back to `prev` (or the street when that is outside too). Against a page that
   * was changed to walk, drive or fly out of the game (position spoofing): the others, the hit and
   * pickup checks and the portals only ever see a place inside. Cheap: one look-up in a grid for a
   * point well inside, a few edges near the edge (shared/bounds.mjs).
   */
  fenceIn(s, prev, top = -Infinity) {
    const fence = this.fence();
    const back = fence.putBack(s.x, s.z, 0.3);
    const to = back ?? (prev && fence.inside(prev.x, prev.z) ? prev : SPAWNS[0]);
    s.x = to.x;
    s.z = to.z;
    s.y = Math.min(s.y, Math.max(TERRAIN.height(s.x, s.z) + BOUNDS.ceiling + 2, top)); // `top`: a drop's own ceiling (see startDrop)
  }

  /**
   * Every tick: anyone outside the edge that holds now (a game in the house began while they were
   * elsewhere) goes inside it, and their figure jumps there for the others. A car or horse they had
   * stays where it is (their page gets out too: src/main.ts). One grid look-up a player when all are inside.
   */
  fenceAll() {
    const fence = this.fence();
    for (const [name, p] of this.players) {
      const s = p.state;
      if (!s) continue;
      if (fence.inside(s.x, s.z)) continue;
      this.releaseCar(name);
      this.releaseHorse(name);
      this.releaseBike(name);
      this.fenceIn(s, null, this.dropping(p, Date.now()) ? p.drop.top : -Infinity);
      this.moved(p);
    }
  }

  /** The car a player is in (driving or riding along), if any. */
  carOf(name) {
    return Object.values(this.cars).find((c) => c.driver === name || c.passenger === name) ?? null;
  }

  /** In a car or on a bike: out of reach of shots, and no firing from it. */
  inCar(name) {
    return !!this.carOf(name) || !!this.bikeOf(name);
  }

  /** On their own feet: not driving, riding along or on a horse (who may kick a football). */
  onFoot(name) {
    return !this.carOf(name) && !this.horseOf(name);
  }

  async kick(target, by) {
    const p = this.players.get(target);
    // Memory first, so they are out right away; with the browser, address and cookies of their connection.
    const ended = this.auth.kick(target, p ? { devices: [p.device], addresses: [p.address] } : {});
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
    const restore = !!defaultLayout && (await store.getMeta('furniture_restore')) !== LAYOUT_RESTORE; // no layout (no private data): the stored furniture stays
    if (restore) {
      await store.setMeta('furniture_restore', LAYOUT_RESTORE);
      await store.setMeta('furniture_edited', '0');
      this.furnitureEdited = false;
    }
    if (defaultLayout && (restore || (!seeded && !list.length) || (seeded && seeded !== LAYOUT_VERSION && !this.furnitureEdited))) {
      await store.clearFurniture();
      for (const f of DEFAULT_FURNITURE) await store.addFurniture({ ...f, by: 'layout' });
      await store.setMeta('furniture_seeded', LAYOUT_VERSION);
      list = await store.listFurniture();
      console.log(JSON.stringify({ event: 'furniture_layout', version: LAYOUT_VERSION, replaced: seeded }));
    }
    for (const f of list) this.furniture.set(f.id, f);
    await this.loadPlaced();
  }

  /**
   * The spawned Teslas, from the database: each where it was put (as a car is back in
   * its parking spot after a restart). A row the catalogue no longer knows, or with a broken number,
   * is left out.
   */
  async loadPlaced() {
    for (const r of await this.auth.store.listCars()) {
      const spot = [r.x, r.y, r.z, r.yaw].map(Number);
      if (!Object.hasOwn(PLACED.kinds, r.kind) || !spot.every(Number.isFinite) || this.placedList().length >= PLACED.max) continue;
      const [x, y, z, yaw] = spot;
      this.cars[`p${r.id}`] = { id: `p${r.id}`, kind: r.kind, x, y, z, yaw, s: 0, driver: null, passenger: null, by: typeof r.by === 'string' ? r.by : '' };
    }
  }

  /** House rules (flying, players spawning things with /name, names, how many may play, portals, travelling from the chat, child-friendly), kept across restarts. */
  async loadRules() {
    let saved = {};
    try {
      saved = JSON.parse((await this.auth.store.getMeta('rules')) || '{}');
    } catch {
      // unreadable: the defaults
    }
    // The best wave ever in the Zombies game at each place (saveZombieBest): only a whole number and a short list of names.
    for (const { id } of ARENAS) {
      try {
        const best = JSON.parse((await this.auth.store.getMeta(bestKey(id))) || 'null');
        if (best && Number.isInteger(best.wave) && best.wave > 0) {
          this.zombieBests[id] = { wave: best.wave, names: (Array.isArray(best.names) ? best.names : []).filter((n) => typeof n === 'string').slice(0, 16), at: String(best.at ?? '').slice(0, 10) };
        }
      } catch {
        // unreadable: none yet
      }
    }
    for (const k of Object.keys(RULES)) if (ruleOk(k, saved[k])) this.rules[k] = saved[k];
    // The limit to start with went from 4 to 16 players (1 Nov 2026: 16 cost about 2% of a core). The
    // saved rules carry every rule, so a 4 saved before then is most likely the old default: raised
    // once. A limit the admin sets from now on stays.
    if ((await this.auth.store.getMeta('rules_limit16')) !== '1') {
      if (this.rules.maxPlayers === 4) this.rules.maxPlayers = MAX_PLAYERS;
      await this.auth.store.setMeta('rules', JSON.stringify(this.rules));
      await this.auth.store.setMeta('rules_limit16', '1');
    }
  }

  /** The admin changed rules in the settings: store them and tell everyone. */
  async setRules(m, by) {
    const changed = Object.keys(RULES).filter((k) => ruleOk(k, m[k]) && m[k] !== this.rules[k]);
    if (!changed.length) return;
    for (const k of changed) this.rules[k] = m[k];
    await this.auth.store.setMeta('rules', JSON.stringify(this.rules));
    const label = { flying: 'flying', spawn: 'spawning things with /name', names: 'names above players', guests: 'guests joining', portals: 'the portals', travel: 'travelling from the chat', paintball: 'child-friendly for everyone', parachute: 'arriving by parachute' };
    const text = changed.map((k) => (k === 'maxPlayers' ? `the limit to ${this.rules[k]} players` : `${label[k]} ${this.rules[k] ? 'on' : 'off'}`)).join(', ');
    this.auth.log('rules', null, { username: by, detail: text });
    this.broadcast({ t: 'rules', rules: this.rules });
    // With the rules that changed and their new values (checked by ruleOk), for the page to word in its language.
    const args = { name: by, ...Object.fromEntries(changed.map((k) => [k, this.rules[k]])) };
    this.broadcast({ t: 'system', text: `${by} turned ${text}`, code: 'rules', args });
    // "For everyone" means the rooms too (server/rooms.mjs): each takes the new rules, keeping its own limit.
    if (!this.room) this.hub?.rulesChanged(this.rules, { t: 'system', text: `${by} turned ${text}`, code: 'rules', args });
  }

  /**
   * The admin picked the weather and time of day for everyone (shared/moods.mjs): a mood, or 'auto'. Only the admin
   * comes here (handle); only a name from the fixed list is taken, at most one change a second per admin, and the
   * same choice again changes nothing and tells nobody. Kept in memory: a restarted server starts on 'auto' again,
   * with a new cycle. The cycle itself goes on whatever is chosen, so 'auto' again picks it up where it is.
   */
  setMood(by, player, mood, now) {
    if (!isChoice(mood) || now < (player.nextMood || 0)) return;
    player.nextMood = now + 1000;
    if (mood === this.mood) return;
    this.mood = mood;
    if (mood !== 'auto') this.moodCycle = withSpeed(this.moodCycle, now, 1); // a fixed mood: the cycle back to its own pace
    this.broadcast({ t: 'mood', mood, by, op: 'set', ...this.moodView(now) }); // nothing logged or stored
  }

  /**
   * The admin's "Next weather" (Yoshi: "Fast forward should also be possible for the admin in production"): on Auto,
   * the mood shown ends now and the usual blend into the next begins. Only the admin (handle), only on Auto, not while
   * a change is under way, at most one every five seconds per admin.
   */
  skipMood(by, player, now) {
    if (this.mood !== 'auto' || now < (player.nextMoodSkip || 0)) return;
    player.nextMoodSkip = now + 5000;
    const next = skipCycle(this.moodCycle, this.moodRun, now);
    if (!next) return;
    this.moodCycle = next;
    this.broadcast({ t: 'mood', mood: this.mood, by, op: 'skip', ...this.moodView(now) });
  }

  /** The admin's pace for the cycle on Auto: only one of SPEEDS, at most one change a second per admin. */
  moodSpeed(by, player, speed, now) {
    if (this.mood !== 'auto' || !SPEEDS.includes(speed) || now < (player.nextMood || 0)) return;
    player.nextMood = now + 1000;
    if (speed === this.moodCycle.speed) return;
    this.moodCycle = withSpeed(this.moodCycle, now, speed);
    this.broadcast({ t: 'mood', mood: this.mood, by, op: 'speed', ...this.moodView(now) });
  }

  /**
   * Winter began or ended (December to February by the server's Belgian date): a new cycle, with snow on Auto or
   * without, starting in the mood shown so nothing jumps; while a change is under way or the ground is wet or white
   * it waits for the next minute. Told to everyone as the server's own change (no name).
   */
  moodSeason(now) {
    const next = seasonCycle(this.moodCycle, this.moodRun, now, winterAt(now), randomInt(0, 2 ** 32));
    if (!next) return;
    this.moodCycle = next;
    this.moodRun = runOf(next);
    this.broadcast({ t: 'mood', mood: this.mood, op: 'season', ...this.moodView(now) });
  }

  /** The last admin left: the cycle back to its own pace (a fast cycle nobody can slow down again would stay). */
  moodAdminLeft(now) {
    if (this.moodCycle.speed === 1 || [...this.players.values()].some((p) => p.role === 'admin')) return;
    this.moodCycle = withSpeed(this.moodCycle, now, 1);
    this.broadcast({ t: 'mood', mood: this.mood, op: 'speed', ...this.moodView(now) });
  }

  /**
   * The weather's cycle for the pages: its timing (seed, its own clock and pace), the server's time, and where it is
   * now (the mood, the next, how far the blend is). The pages work it out from the first two, on the server's clock;
   * `cycleNow` says the same for whoever reads the messages.
   */
  moodView(now) {
    return { cycle: this.moodCycle, time: now, cycleNow: this.moodRun.at(cycleTime(this.moodCycle, now)) };
  }

  /** Remember whether the furniture differs from the starting layout (see loadFurniture). */
  async markFurniture(edited) {
    if (this.furnitureEdited === edited) return;
    this.furnitureEdited = edited;
    await this.auth.store.setMeta('furniture_edited', edited ? '1' : '0');
  }

  /** Furniture: spawn a piece ('put', with /name), take one away ('del'), or (admin) remove all ('clear') or put the starting layout back ('reset'). */
  async furnish(name, player, m) {
    const store = this.auth.store;
    // A refusal is said to the one who tried (it used to happen in silence: "nothing happens").
    const refuse = (code, text, args) => this.send(player.ws, { t: 'system', text, code, ...(args ? { args } : {}) });
    const admin = player.role === 'admin';
    if (m.op === 'clear' || m.op === 'reset') {
      if (player.role !== 'admin') return;
      await store.clearFurniture();
      this.furniture.clear();
      this.owners.clear(); // the characters and Teslas go below too: nothing spawned is left
      if (m.op === 'reset') {
        for (const f of DEFAULT_FURNITURE) {
          const piece = { ...f, by: 'layout' };
          piece.id = await store.addFurniture(piece);
          this.furniture.set(piece.id, piece);
        }
        await store.setMeta('furniture_seeded', LAYOUT_VERSION);
      }
      await this.markFurniture(m.op === 'clear');
      for (const [who, p] of this.players) { // each page gets the pieces it may see (those inside a home need its right)
        if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify({ t: 'furn', op: 'all', list: this.furnitureFor(p), by: name, reset: m.op === 'reset' }));
      }
      // The characters spawned go too: back to the starting clowns and strongmen.
      this.clowns = this.startingClowns();
      this.broadcast({ t: 'clowns', list: this.clownList(Date.now()) });
      await this.clearPlaced(); // and the Teslas (the four of the game stay)
    } else if (m.op === 'del' && this.furniture.has(m.id)) {
      // Taken away (/remove): the admin's any piece, everyone else's only what they spawned themselves.
      if (!admin && this.owners.get(`f${m.id}`) !== player.key) return refuse('spawnNotYours', 'You can only take away what you spawned yourself.');
      const home = pieceHome(this.furniture.get(m.id));
      await store.deleteFurniture(m.id);
      this.furniture.delete(m.id);
      this.owners.delete(`f${m.id}`);
      await this.markFurniture(true);
      this.broadcastHome({ t: 'furn', op: 'del', id: m.id }, home);
    } else if (m.op === 'put' && m.id === undefined && FURNITURE_IDS.has(m.item)) {
      // Spawned with /name (the planner, and moving pieces with it, is gone): the admin always, the others
      // when the admin allows it (off at first); in front of where the server has them, inside the game's edge.
      if (!admin && !this.rules.spawn) return refuse('spawnOff', 'The admin has turned spawning off.');
      const at = this.spawnSpot(player, m);
      if (!at) return refuse('spawnFar', 'That is too far from you.');
      if (this.furniture.size >= FURNITURE.max) return refuse('furnFull', `There is no room for more furniture (${FURNITURE.max} pieces). The admin can remove some.`, { n: FURNITURE.max });
      if (!admin && this.ownedBy(player, 'f') >= SPAWN_EACH) return refuse('spawnMany', `You have ${SPAWN_EACH} things out already. Take some away with /remove.`, { n: SPAWN_EACH });
      const f = { item: m.item, ...at, yaw: num(m.yaw, -7, 7), by: name };
      f.id = await store.addFurniture(f);
      this.furniture.set(f.id, f);
      this.owners.set(`f${f.id}`, player.key);
      await this.markFurniture(true);
      this.broadcastHome({ t: 'furn', op: 'put', f }, pieceHome(f));
    }
  }

  /** Everyone who may see home `home`'s inside gets `msg` (all pages when `home` is null), except `except`. */
  broadcastHome(msg, home, except) {
    if (!home) return this.broadcast(msg, except);
    const data = JSON.stringify(msg);
    for (const [name, p] of this.players) if (name !== except && p.ws.readyState === p.ws.OPEN && this.gate.may(p, home)) p.ws.send(data);
  }

  /** The door states a player may be told: no inside door of a home they have no right to. */
  doorsFor(player) {
    return Object.fromEntries(Object.entries(this.doors).filter(([id]) => this.gate.door(player, id)));
  }

  doorDirFor(player) {
    return Object.fromEntries(Object.entries(this.doorDir).filter(([id]) => this.gate.door(player, id)));
  }

  /** The broken panes a player may be told: none of a home they have no right to. */
  brokenFor(player) {
    return [...this.broken].filter((i) => this.gate.glass(player, i));
  }

  /** The furniture a player may be told: not the pieces inside a home they have no right to. */
  furnitureFor(player) {
    return [...this.furniture.values()].filter((f) => { const home = pieceHome(f); return !home || this.gate.may(player, home); });
  }

  /**
   * A player has just got the right to home `id` (server/homes.mjs): they are told the state of its inside (doors, panes, furniture)
   * that welcome and the broadcasts held back. Their page also fetches the inside itself (GET /api/home/:id/inside).
   */
  homeGranted(key, id) {
    for (const p of this.players.values()) {
      if (p.key !== key || p.ws.readyState !== p.ws.OPEN) continue;
      const doors = Object.fromEntries(Object.entries(this.doors).filter(([d]) => homeOfDoor(d) === id));
      const doorDir = Object.fromEntries(Object.entries(this.doorDir).filter(([d]) => homeOfDoor(d) === id));
      const broken = [...this.broken].filter((i) => PANE_HOME(i) === id);
      const furniture = [...this.furniture.values()].filter((f) => pieceHome(f) === id);
      this.send(p.ws, { t: 'inside', id, doors, doorDir, broken, furniture });
    }
  }

  /** How many things of a kind (`prefix`: 'f' furniture, 't' Teslas, 'c' characters) player `p`'s session has spawned and still has out. */
  ownedBy(p, prefix) {
    let n = 0;
    for (const [k, owner] of this.owners) if (owner === p.key && k[0] === prefix) n++;
    return n;
  }

  /**
   * Where something spawned with /name may stand (furniture, a character): numbers, within SPAWN_REACH
   * of where the server has the player and 3 m above or below them, inside the edge that holds now.
   * { x, y, z }, or null. Against a changed page placing things across the map or out of the game.
   */
  spawnSpot(player, m) {
    const s = player.state;
    if (!s || ![m.x, m.y, m.z].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    if (Math.hypot(m.x - s.x, m.z - s.z) > SPAWN_REACH || Math.abs(m.y - s.y) > 3 || !this.fence().inside(m.x, m.z)) return null;
    const home = homeAt(m.x, m.z, m.y);
    if (home && !this.gate.may(player, home)) return null; // not into a home whose code this session has not typed
    return { x: +m.x.toFixed(3), y: +m.y.toFixed(3), z: +m.z.toFixed(3) };
  }

  /** The spawned Teslas (not the four of the game). */
  placedList() {
    return Object.values(this.cars).filter((c) => c.kind);
  }

  /** Everyone's list of placed Teslas, after one was placed, moved or taken away. */
  sendPlaced() {
    this.broadcast({ t: 'teslas', list: this.placedList() });
  }

  /**
   * The spawned Teslas (shared/car.json: placed): one spawned ('put'), one moved ('put' with its id,
   * the admin's) or one taken away ('del'): the admin any, the others their own when the admin allows
   * spawning, and never one someone is in. The page checks the spot as it shows it, and the server
   * checks it again (parkingProblem): a changed page or a hand-written message gets no further than
   * the page would. Its own clock (TESLA_MS) on top of the flood guard: each one is a database write.
   * A refusal says why.
   */
  async placeCar(name, player, m, now) {
    if (now < (player.nextTesla || 0)) return;
    player.nextTesla = now + TESLA_MS;
    const no = ([code, text]) => this.send(player.ws, { t: 'system', text, code, args: { max: PLACED.max, n: SPAWN_CARS } });
    // Spawned with /tesla: the admin always (and only the admin moves one), the others when the admin
    // allows spawning, near where the server has them, SPAWN_CARS each; each takes away only their own.
    const admin = player.role === 'admin';
    const store = this.auth.store;
    const placed = typeof m.id === 'string' && Object.hasOwn(this.cars, m.id) && this.cars[m.id].kind ? this.cars[m.id] : null;
    if (m.op === 'del') {
      if (!placed) return;
      if (!admin && this.owners.get(`t${placed.id}`) !== player.key) return no(['spawnNotYours', 'You can only take away what you spawned yourself.']);
      if (placed.driver || placed.passenger) return no(['teslaBusy', 'Someone is in that car.']);
      delete this.cars[placed.id];
      delete this.carAt[placed.id];
      this.owners.delete(`t${placed.id}`);
      this.sendPlaced();
      await store.deleteCar(Number(placed.id.slice(1)));
      return;
    }
    if (m.op !== 'put' || typeof m.kind !== 'string' || !Object.hasOwn(PLACED.kinds, m.kind)) return;
    if (!admin && !this.rules.spawn) return no(['spawnOff', 'The admin has turned spawning off.']);
    if (!admin && m.id !== undefined) return; // moving one: the admin's
    if (m.id !== undefined && (!placed || placed.kind !== m.kind)) return; // a move: a placed car, of the kind it is
    if (![m.x, m.y, m.z, m.yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
    if (!admin && (!player.state || Math.hypot(m.x - player.state.x, m.z - player.state.z) > SPAWN_REACH + 3 || Math.abs(m.y - player.state.y) > 3)) return no(['spawnFar', 'That is too far from you.']);
    if (!admin && !placed && this.ownedBy(player, 't') >= SPAWN_CARS) return no(['spawnCars', `You have ${SPAWN_CARS} Teslas out already. Take one away with /remove.`]);
    if (placed && (placed.driver || placed.passenger)) return no(['teslaBusy', 'Someone is in that car.']);
    const r = (v, k) => Math.round(v * k) / k;
    const spot = { x: r(m.x, 100), y: r(m.y, 100), z: r(m.z, 100), yaw: r(Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw)), 1000) };
    const why = this.parkingProblem(m.kind, spot, placed?.id);
    if (why) return no(why);
    if (placed) {
      Object.assign(placed, spot, { s: 0 });
      this.carAt[placed.id] = mono();
      this.sendPlaced();
      await store.updateCar(Number(placed.id.slice(1)), { ...spot, by: name });
      return;
    }
    if (this.placedList().length + this.placing >= PLACED.max) return no(['teslaFull', `${PLACED.max} Teslas is the most.`]);
    this.placing++;
    let row;
    try {
      row = await store.addCar({ kind: m.kind, ...spot, by: name });
    } finally {
      this.placing--;
    }
    const id = `p${row}`;
    this.cars[id] = { id, kind: m.kind, ...spot, s: 0, driver: null, passenger: null, by: name };
    this.owners.set(`t${id}`, player.key);
    this.carAt[id] = mono();
    this.sendPlaced();
  }

  /**
   * Why a placed car of `kind` can't stand at `spot` (a refusal's code and English text), or null when
   * it can: inside the edge of the game (shared/bounds.mjs) and the server's area; off the portals'
   * pads and the spots where people and cars come out of them (shared/portals.mjs); on the ground (not
   * on a roof, upstairs or in the air); outdoors (not over a floor of the house or the bungalow); clear
   * of every wall, hedge, fence and house (shared/parking.mjs, the page's own test); not on a car
   * parked in the village's streets, another car of the game (`self`: the one being moved) or a player
   * standing there. The page also keeps clear of the gardens' small things, bales and furniture.
   */
  parkingProblem(kind, { x, y, z, yaw }, self) {
    const spec = CARS.cars[PLACED.kinds[kind].base];
    const halfL = spec.length / 2;
    const halfW = spec.width / 2;
    const room = ['teslaRoom', "There's no room for the car there."];
    if (x < AREA.x0 || x > AREA.x1 || z < AREA.z0 || z > AREA.z1 || !BOUNDS.map.boxInside(x, z, yaw, halfL, halfW)) {
      return ['teslaEdge', "That's past the edge of the game."];
    }
    if (!clearOfPortals({ x, z, yaw, halfL, halfW }, PORTALS, REACH)) return ['teslaPortal', 'The portals stay free.'];
    const ground = HOUSE.ground + TERRAIN.height(x, z);
    if (y < ground - 1.5 || y > ground + 0.5) return room; // the page puts it on paving or a kerb at most 0.3 m up
    if (boxPoints(x, z, yaw, halfL, halfW, 0.5).some(([px, pz]) => INDOORS(px, pz))) return ['teslaInside', 'Cars stay outdoors.'];
    if (!SOLIDS.boxFree(x, z, yaw, halfL, halfW, y + 0.3, y + spec.height)) return room; // 0.3: kerbs and paving don't count, as for driving
    const box = { x, z, yaw, halfL, halfW };
    if (PARKED.some((p) => boxesOverlap(box, p))) return room;
    for (const c of Object.values(this.cars)) {
      const s = carSpec(c);
      if (c.id !== self && boxesOverlap(box, { x: c.x, z: c.z, yaw: c.yaw, halfL: s.length / 2, halfW: s.width / 2 }, 0.1)) return room;
    }
    for (const [n, p] of this.players) {
      const st = p.state;
      if (st && !this.inCar(n) && Math.abs(st.y - y) < 2 && boxesOverlap(box, { x: st.x, z: st.z, yaw: 0, halfL: 0.35, halfW: 0.35 })) return room;
    }
    return null;
  }

  /**
   * The furniture's clear or reset: every placed Tesla goes. Whoever is in one gets out first (their
   * page puts them by the door, as when the server takes a car back), then the cars go, for everyone.
   */
  async clearPlaced() {
    const list = this.placedList();
    if (!list.length) return;
    for (const c of list) {
      if (c.driver) this.releaseCar(c.driver);
      if (c.passenger) this.releaseCar(c.passenger);
      delete this.cars[c.id];
      delete this.carAt[c.id];
      this.owners.delete(`t${c.id}`);
    }
    this.sendPlaced();
    await this.auth.store.clearCars();
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
    const v = (k) => num(m[k], -40, 40);
    // Where the blast may be (server/grenade.mjs): from where the server has the thrower, at the speed the throw carried.
    const vh = typeof m.vx === 'number' && typeof m.vz === 'number' ? Math.hypot(v('vx'), v('vz')) : undefined;
    p.thrown.push({ at: now, x: s.x, y: s.y + 1.5, z: s.z, vh });
    if (p.thrown.length > GRENADE.carry) p.thrown.shift();
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
    const at = blastPoint(g, where(m), GRENADE); // never further than the throw could reach
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
    // Zombies caught in it lose health (server/zombies.mjs), as the strongmen do.
    this.modes.zombies?.blast(name, at, radius, bruteDamage(w, WEAPONS), w, now); // on its floor (at.y)
    // Strongmen caught in it lose health too (less at the edge of the blast; they're big). Not during
    // the Zombies game, when they stand aside.
    for (const c of this.clowns.values()) {
      if (!c.brain || now < c.until || this.modes.state.kind === 'zombies') continue;
      const d = Math.hypot(c.brain.x - at.x, c.brain.z - at.z);
      if (d < radius + 1) this.hurtBrute(c, name, Math.round(bruteDamage(w, WEAPONS) * (1 - (0.5 * d) / (radius + 1))), w, now);
    }
    for (const [targetName, target] of [...this.players]) {
      if (target === shooter || cover.has(targetName) || !target.alive || !target.state?.armed || now < target.protectedUntil) continue;
      if (this.modes.friends(name, targetName)) continue; // the same team
      if (this.calm(target)) continue; // on the school grounds
      const s = target.state;
      const d = Math.hypot(s.x - at.x, s.y + (s.c ? 0.65 : 0.9) - at.y, s.z - at.z); // from the middle of the body (lower crouching)
      if (d < radius) this.damage(name, shooter, targetName, target, Math.round(damage * (1 - d / radius)), false, w, now);
    }
  }

  /** The clowns and strongmen everyone starts with (shared/clowns.json), before the admin adds any. */
  startingClowns() {
    return new Map(CLOWNS.spots.map(([x, y, z, kind], i) => [i + 1, this.character(i + 1, x, y, z, kindOf(kind))]));
  }

  /** Whether a player stands where nobody shoots (the school grounds, shared/zones.mjs). */
  calm(p) {
    return !!(p?.state && noShoot(p.state.x, p.state.z)) || this.dropping(p, Date.now());
  }

  /**
   * In a drop (shared/parachute.mjs): from a respawn, start or /parachute the server chose, until the page
   * says it landed, the server sees it on the ground or not coming down (dropCheck), or DROP.maxMs. Calm like
   * the school grounds (see calm): nobody shoots from the air and nobody, zombies and strongmen included,
   * hurts someone in it. Only meanwhile may they move as fast as a skydive (see the state's budgets).
   */
  dropping(p, now) {
    return !!p?.drop && now < p.drop.until;
  }

  /**
   * A drop begins, from where the player's state is now (high up): protected until it ends (see calm and
   * landed). `top`: its ceiling; `rise`: what is left of its tiny allowance to go up; `markY`, `markAt`: where it
   * was at the start of the stretch dropCheck measures; `low`: since when it is on the bare ground.
   */
  startDrop(p, now) {
    const y = p.state?.y ?? 0;
    p.drop = { from: now, until: now + DROP.maxMs, top: y + 0.5, rise: DROP_RISE.max, markY: y, markAt: now, low: 0 };
    p.protectedUntil = p.drop.until;
  }

  /**
   * Where a drop onto (x, z) facing `yaw` starts (shared/parachute.mjs dropFrom): DROP.reach behind it (it lands
   * there without steering) when that whole way in is inside `fence` (the edge that holds now, or a Zombies
   * place's about to hold), else straight over it.
   */
  dropFrom(x, z, yaw, fence = this.fence()) {
    return dropFrom(x, z, yaw, (a, b) => fence.inside(a, b));
  }

  /**
   * A drop ends when the server sees it over: the player on the bare ground under them for a second (a page
   * keeping its parachute flag on the ground stays protected no longer), or not coming down by DROP.hoverMin
   * m/s on average over DROP.hoverMs (nobody hovers: the slowest canopy sinks faster than that, and a roof
   * isn't the bare ground). Each state and each tick (a page gone quiet doesn't come down either).
   */
  dropCheck(p, now) {
    const d = p.drop;
    if (!d || !p.state || now - d.from <= DROP.graceMs) return;
    const { x, y, z } = p.state;
    if (y - (HOUSE.ground + TERRAIN.height(x, z)) < 0.5) {
      d.low ||= now;
      if (now - d.low >= 1000) return this.landed(p, now);
    } else d.low = 0;
    if (now - d.markAt >= DROP.hoverMs) {
      if (d.markY - y < (DROP.hoverMin * (now - d.markAt)) / 1000) return this.landed(p, now);
      d.markY = y;
      d.markAt = now;
    }
  }

  /** On the ground (or the drop took too long, or they travelled): the usual short protection after a respawn. */
  landed(p, now) {
    p.drop = null;
    p.protectedUntil = now + PROTECT_MS;
    if (p.state) p.state.chute = p.state.open = false;
  }

  /** Take `amount` health from a target; a kill scores for the shooter (and can end the round). */
  damage(name, shooter, targetName, target, amount, head, w, now) {
    if (!target.alive) return;
    target.hp = Math.max(0, target.hp - amount);
    target.hurtAt = now; // no parachute out of a fight (manualDrop)
    if (target.hp > 0) return this.send(target.ws, { t: 'hurt', hp: target.hp, by: name });

    target.alive = false;
    target.respawnAt = now + RESPAWN_MS;
    this.releaseCar(targetName);
    this.releaseHorse(targetName);
    this.releaseBike(targetName);
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

  /**
   * Back to full health at the spawn point furthest from the others (one of the best three, for
   * variety), or at `at` ({ spawn, x, y, z }: a place near spawn point `spawn`, see gather).
   */
  respawn(name, p, now, at = null, drop = false, fence = this.fence()) {
    this.releaseCar(name);
    this.releaseHorse(name);
    this.releaseBike(name);
    p.hp = HEALTH;
    p.alive = true;
    p.weapons = loadout(p.role);
    p.nades.fill(0);
    p.protectedUntil = now + PROTECT_MS;
    let spawn = at?.spawn;
    if (!at) {
      // At the player's team's house in the teams game, else round the house; away from the others.
      const team = this.modes.teamOf(name) ?? 'house';
      const others = [...this.players].filter(([n, o]) => n !== name && o.alive && o.state).map(([, o]) => o.state);
      const ranked = SPAWNS.map((s, i) => ({
        i, team: s.team, d: others.length ? Math.min(...others.map((o) => Math.hypot(o.x - s.x, (o.y - s.y) * 2, o.z - s.z))) : Math.random(),
      })).filter((s) => this.gate.mayStand(p, SPAWNS[s.i].x, SPAWNS[s.i].y, SPAWNS[s.i].z)) // never into a home without the right to it (the bungalow's team then starts outside)
        .filter((s, _, all) => s.team === team || !all.some((q) => q.team === team)).sort((x, y) => y.d - x.d);
      spawn = ranked[Math.floor(Math.random() * Math.min(3, ranked.length))].i;
    }
    const pos = at ?? SPAWNS[spawn];
    // By parachute (the admin's rule): only onto open ground, a place outside (never into a room).
    const fly = drop && this.rules.parachute && (at ? true : !!SPAWNS[spawn]?.outside);
    p.drop = null;
    // Until the player's own update arrives, they are at the spawn point (so the next pick avoids it).
    // A drop starts behind the place, facing it as the page does (the portal, else the house or the bungalow): without
    // steering it lands on it. Its whole way in inside `fence` (a Zombies place's edge for its gathering), else
    // straight over the place.
    const face = at?.face ?? (SPAWNS[spawn]?.team === 'bungalow' ? [83.5, 189.7] : [4.5, 6]);
    const from = fly ? this.dropFrom(pos.x, pos.z, Math.atan2(-(face[0] - pos.x), -(face[1] - pos.z)), fence) : pos;
    if (p.state) Object.assign(p.state, { x: from.x, y: pos.y + (fly ? DROP.height : 0), z: from.z, chute: false, open: false });
    if (fly) this.startDrop(p, now);
    p.movedAt = now;
    p.budget = p.vbudget = 0.5;
    this.moved(p);
    // In Smetlede (Zombies there) also the height to stand at and what to face: the spawn point is the house's.
    this.broadcast({
      t: 'respawn', name, spawn, ...(at ? { x: at.x, z: at.z } : {}), ...(at?.face ? { y: +at.y.toFixed(2), fx: at.face[0], fz: at.face[1] } : {}),
      ...(fly ? { drop: 1, sx: from.x, sz: from.z, ...(at && !at.face ? { y: +at.y.toFixed(2) } : {}) } : {}),
    });
  }

  /**
   * Everyone to the house in Briel for a party game (hide and seek, tag, the treasure hunt): spread
   * round its outside start places, each on open ground (no wall, hedge or fence within a metre, as
   * the strongmen need), clear of the cars and inside the game's edge (see fence), the places taken
   * in turn so the players share them out. As a respawn (out of cars, off horses, full health), not a
   * death. A nicer start than fenceAll alone, which only puts those outside the edge just inside it.
   * `drop`: by parachute, each drop starting over the place's edge with its whole way in inside it (respawn,
   * dropFrom). The edge keeps it there however it is steered (fenceIn: the game's fence is that edge as long
   * as the game runs). Zombies doesn't use it (Yoshi, 7 Nov 2026: no parachute drops in Zombies).
   */
  gather(names, arena = null, drop = false) {
    const now = Date.now();
    // The places to spread round: the house's outside start places, or, for Zombies started at another
    // portal (the bungalow's has no outside start places), where you come out of it, facing it.
    const portal = arena && arena.id !== 'house' ? portalOf(arena) : null;
    const outside = portal
      ? [{ i: SPAWNS.findIndex((s) => s.team === 'house' && s.outside), x: portal.out[0], z: portal.out[1], y: HOUSE.ground + TERRAIN.height(portal.out[0], portal.out[1]), face: [portal.x, portal.z] }]
      : SPAWNS.map((s, i) => ({ ...s, i })).filter((s) => s.team === 'house' && s.outside);
    const cars = Object.values(this.cars);
    const fence = arena ? arenaEdge(arena, BOUNDS) : this.fence();
    const spots = [];
    for (const [r, n] of [[0, 1], [1.6, 6], [3.2, 10], [4.8, 14]]) { // each place's middle, then rings round it
      for (let k = 0; k < n; k++) {
        for (const s of outside) {
          const x = s.x + r * Math.sin((k / n) * Math.PI * 2);
          const z = s.z + r * Math.cos((k / n) * Math.PI * 2);
          const y = portal ? HOUSE.ground + TERRAIN.height(x, z) : s.y;
          if (this.free(x, z) && fence.inside(x, z) && cars.every((c) => Math.hypot(x - c.x, z - c.z) > 3.5)) spots.push({ spawn: s.i, x: +x.toFixed(2), y, z: +z.toFixed(2), ...(s.face ? { face: s.face } : {}) });
        }
      }
    }
    [...names].sort(() => Math.random() - 0.5).forEach((name, k) => {
      const p = this.players.get(name);
      if (p) this.respawn(name, p, now, spots.length ? spots[k % spots.length] : null, drop, fence);
    });
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

  /** A new fighting round, as after a won round (and after the teams game, see Modes). */
  freshRound() {
    this.newRound(`New round: first to ${KILL_LIMIT} kills`, 'newRound', { n: KILL_LIMIT });
  }

  /**
   * Scores back to zero; everyone who fights (or is dead) starts again at a spawn point, except during
   * a party game, where nobody fights and a hider would be pulled out of their hiding place. `code` and
   * `args`: `text` for a page in another language.
   */
  newRound(text, code, args) {
    const now = Date.now();
    this.roundOver = null;
    this.scores.clear();
    for (const [name, p] of this.players) {
      p.score = { kills: 0, deaths: 0, points: 0 };
      this.scores.set(name, p.score);
    }
    this.broadcast({ t: 'newround', text, code, args });
    if (!this.modes.peaceful) for (const [name, p] of this.players) if (p.state?.armed || !p.alive) this.respawn(name, p, now);
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
    if (this.roundOver && now >= this.roundOver.until) this.freshRound();
    for (const [name, p] of this.players) {
      if (!p.alive && !this.roundOver && now >= p.respawnAt) this.respawn(name, p, now, null, true); // after a death: by parachute onto open ground
      else if (p.drop && !this.dropping(p, now)) this.landed(p, now); // a drop that took too long (a page gone quiet)
      else if (p.drop) this.dropCheck(p, now); // or not coming down
    }
    this.modes.tick(now, TICK_MS);
    if (!this.players.size) return;
    this.fenceAll();
    this.stepBrutes(now);
    this.football.tick(this.players, now, (n) => this.onFoot(n), (p, msg) => this.send(p.ws, msg));
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
    const things = { c: [], h: [], k: [], b: [], z: [] };
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
    Object.values(this.bikes).forEach((k, i) => {
      const f = JSON.stringify(bikeFields(k));
      add('k', `k${k.id}`, i + 9, f, entry(k.id, this.bikeAt[k.id] ?? 0, f), !!this.players.get(k.rider)?.fresh);
    });
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
    // The zombies of the Zombies game the same way, with the strongmen's ticks (each a line of about 30 bytes).
    const zombies = this.modes.state.kind === 'zombies' ? this.modes.state.z.entries() : null;
    for (const e of zombies ?? []) {
      const key = `z${e[0]}`;
      const json = JSON.stringify(e);
      if (brutes) add('z', key, e[0] * 2, json, json, false);
      else {
        things.z.push({ json, due: false });
        if (this.sent.has(key)) sent.set(key, this.sent.get(key));
      }
    }
    this.sent = sent;
    for (const p of this.players.values()) p.fresh = false;

    const join = (list, all) => list.filter((e) => all || e.due).map((e) => e.json).join(',');
    const part = (k, text) => (text ? `,"${k}":[${text}]` : '');
    // The strongmen's list goes with every other tick even when empty: one left out of it stood still. The zombies' too, while the game runs.
    const rest = (all) => part('c', join(things.c, all)) + part('h', join(things.h, all)) + part('k', join(things.k, all)) + (brutes || all ? `,"b":[${join(things.b, all)}]` : '')
      + (zombies && (brutes || all) ? `,"z":[${join(things.z, all)}]` : '');
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

  /** Add to someone's totals for the leaderboard (kept in the database): accounts only (Yoshi, 7 Nov 2026). */
  stats(name, add) {
    if (this.roles.get(name) !== 'player') return;
    this.auth.store.addStats(name, add).catch((e) => console.error('stats failed', String(e)));
  }

  /**
   * A Zombies game at `place` is over (server/zombies.mjs over, never a chosen wave): for each account in
   * it, the wave reached and the zombies they beat, kept when it beats their best there (the board).
   */
  zombieRun(place, names, wave, beaten) {
    for (const name of names) {
      if (this.roles.get(name) !== 'player') continue;
      this.auth.store.saveZombieRun(name, place, wave, beaten[name] ?? 0, names.length)
        .then((better) => better && this.hub?.scored())
        .catch((e) => console.error('zombie run failed', String(e)));
    }
  }

  send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const [name, p] of this.players) if (name !== except && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}
