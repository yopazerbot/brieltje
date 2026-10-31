// How the shared house's moving things travel from the server to the page (protocol 2), shared by
// the server (which writes them) and the page (which reads them): plain functions, no three.js.
//
// Twenty times a second the server sends one tick, { t: 's', st, p, c, h, b }, as compact JSON:
//   st  the server's clock at the tick (ms, monotonic: the page draws everything on it)
//   p   players    [name, age, x, y, z, yaw, pitch, flags, weapon]
//   c   cars       [id, age, x, y, z, yaw, steer, driver, passenger]
//   h   horses     [i, age, x, z, yaw, speed, jump, rider, parked (0 or 1)]
//   b   strongmen  [id, x, z, yaw, speed, act, hp]
// `age`: how long before `st` that state was where it says (ms). A player's state carries the time
// their own page took it, lined up with the server's clock (game.mjs), so network jitter on the way
// in doesn't show as a stutter. Positions are rounded to the centimetre, angles to a milliradian.
//
// What is in a tick: a player, car or horse when its player sent something new or it changed, and
// each of them once a second whatever happened (spread over the ticks), so nobody waits long for the
// full picture. The strongmen go with every other tick (ten a second is plenty for their walk): the
// list is there even when empty, with those who changed; one left out of it stood still. A page that
// just connected gets everything in its first tick. Each page's own player is left out of its ticks,
// and empty lists of players, cars and horses are left out.

/** The protocol in this file. The page asks for it when it connects (/ws?v=2); older pages get the old messages. */
export const PROTO = 2;
/** How often the server sends a tick (ms). */
export const TICK_MS = 50;
/** A player's flags. */
export const FLAG = { armed: 1, flying: 2, crouch: 4, car: 8, alive: 16, safe: 32 };
/** Bits 6 and 7 of the flags: a counter that goes up when the server moves the player (respawn, portal, start place), so the page jumps the figure there instead of sliding it. */
const WARP = 64;

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
/** An angle between -pi and pi, to the milliradian (a player's own can wind up to any size). */
const angle = (a) => r3(Math.atan2(Math.sin(a), Math.cos(a)));
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A player's state without the name and age: [x, y, z, yaw, pitch, flags, weapon]. */
export function playerFields(s, alive, safe, warp) {
  const f = (s.armed ? FLAG.armed : 0) | (s.flying ? FLAG.flying : 0) | (s.c ? FLAG.crouch : 0) | (s.d ? FLAG.car : 0)
    | (alive ? FLAG.alive : 0) | (safe ? FLAG.safe : 0) | ((warp & 3) * WARP);
  return [r2(s.x), r2(s.y), r2(s.z), angle(s.yaw), Math.round(s.pitch * 100) / 100, f, s.w ?? 'pistol'];
}

/** A car without its id and age: [x, y, z, yaw, steer, driver, passenger]. */
export function carFields(c) {
  return [r2(c.x), r2(c.y), r2(c.z), angle(c.yaw), Math.round(n(c.s) * 100) / 100, c.driver ?? null, c.passenger ?? null];
}

/** A horse without its number and age: [x, z, yaw, speed, jump, rider, parked]. */
export function horseFields(h) {
  return [r2(h.x), r2(h.z), angle(h.yaw), r2(n(h.speed)), r2(n(h.jump)), h.rider ?? null, h.parked ? 1 : 0];
}

/** A strongman: [id, x, z, yaw, speed, act, hp]. */
export function bruteEntry(id, b) {
  return [id, r2(b.x), r2(b.z), angle(b.yaw), r2(b.speed), b.act, b.hp];
}

/** A player entry as the page uses it (the shape of the old 'states' list, plus the teleport counter). */
export function readPlayer(e) {
  const f = n(e[7]);
  return {
    name: String(e[0]), age: n(e[1]), x: n(e[2]), y: n(e[3]), z: n(e[4]), yaw: n(e[5]), pitch: n(e[6]),
    armed: !!(f & FLAG.armed), flying: !!(f & FLAG.flying), c: !!(f & FLAG.crouch), d: !!(f & FLAG.car), alive: !!(f & FLAG.alive), safe: !!(f & FLAG.safe),
    warp: Math.floor(f / WARP) & 3, w: typeof e[8] === 'string' ? e[8] : 'pistol',
  };
}

export function readCar(e) {
  return { id: String(e[0]), age: n(e[1]), x: n(e[2]), y: n(e[3]), z: n(e[4]), yaw: n(e[5]), s: n(e[6]), driver: e[7] ?? null, passenger: e[8] ?? null };
}

export function readHorse(e) {
  return { i: n(e[0]), age: n(e[1]), x: n(e[2]), z: n(e[3]), yaw: n(e[4]), speed: n(e[5]), jump: n(e[6]), rider: e[7] ?? null, parked: !!e[8] };
}

export function readBrute(e) {
  return { id: n(e[0]), x: n(e[1]), z: n(e[2]), yaw: n(e[3]), speed: n(e[4]), act: e[5] === 'throw' || e[5] === 'stomp' ? e[5] : 'walk', hp: n(e[6]) };
}
