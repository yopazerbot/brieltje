// The parachute arrival (docs/parachute/README.md), shared by the page (src/player.ts flies you, src/world/
// parachutes.ts draws it, src/world/dropView.ts films it) and the server (server/game.mjs: who drops, how fast
// they may move while dropping, protection, how long).
//
// A skydive (Yoshi: "this is how I want the parachute thing to work"). A drop starts high over the place the
// server picked (a respawn on open ground, a start place, the house's start, /parachute). First a free fall
// that you steer yourself: forward tracks forward and falls a little faster, back slows you, left and right
// slide, the mouse or the look stick turns you, and the dive key (crouch) puts your head down to fall fastest.
// You open the canopy yourself (the jump key or button), or it opens by itself DROP.openAt over the ground under
// you. Under the canopy left and right turn, forward glides faster and sinks faster, back brakes, and it flares
// by itself near the ground. You land wherever you steer to, inside the game's edge; roofs count as ground.
//
// Without steering a drop falls straight down, opens by itself and glides forward onto its place: it starts
// DROP.reach behind it (dropStart). Every speed stays inside what the server allows while (and only while) a
// drop lasts: across at most DROP.across, down under its limit (16 m/s), never up.
export const DROP = {
  height: 170, // m over the arrival place's ground where the drop starts
  // The free fall (m/s; forward and back along where you face, side to side across it)
  fallDown: 10.5, // down, lying flat (belly to earth)
  trackDown: 12, // down while tracking forward at full forward
  diveDown: 14.5, // down head first, holding the dive key (the server allows 16)
  track: 12, // forward at full forward
  backDrift: 2, // back at full back: braking the track
  slide: 6, // sideways at full left or right
  diveForward: 4, // forward in a dive
  fallEase: 1.1, // 1/s: how quickly the free fall's speed across follows the keys (it takes a moment to pick up)
  minFall: 1, // s into the drop before the canopy can be opened by hand (a held jump key from the ground doesn't open it)
  openAt: 45, // m over the ground under you: the canopy opens by itself here
  // The canopy opening (the Deploy clip)
  deploy: 1.8, // s the canopy takes to open
  open: 0.55, // s into the deploy before the canopy starts to brake the fall (the bag and the lines go out first)
  brake: 1.3, // s the opening canopy takes to brake the fall to the glide's sink, eased in and out
  // Under the canopy (m/s)
  glide: 5.5, // forward, hands off
  sink: 4.5, // down, hands off
  glideFast: 7.5, // forward at full forward
  sinkFast: 5.8, // down at full forward
  glideSlow: 2.5, // forward at full back (braking)
  sinkSlow: 3.2, // down at full back: the slowest legal descent
  turn: 1.2, // rad/s at full steering
  flareAt: 3, // m over the ground: the flare slows the landing
  flareGlide: 1.5, // forward in the flare
  flareSink: 1.2, // down in the flare
  // The server's side (server/game.mjs)
  across: 0, // m/s: the fastest a drop goes across (worked out below); the server allows 1.3 times it while dropping
  maxMs: 0, // ms: a drop ends here whatever the page says (worked out below: the slowest legal drop and a margin)
  graceMs: 1200, // ms after the start before the page can end it (messages already on their way)
  hoverMs: 4000, // ms: each stretch this long, a drop must come down at least
  hoverMin: 1.5, // m/s on average (the braked canopy does 3.2, the flare's last 3 m 1.2), else it ends: nobody hovers
  // Measured by `fly` below when this file loads, so the page, the server and the tests always agree:
  reach: 0, // m a drop goes forward without steering, from where it starts to where it lands
  time: 0, // s a drop takes without steering, over flat ground
};

DROP.across = Math.max(DROP.track, DROP.glideFast, Math.hypot(DROP.diveForward, DROP.slide));
// The slowest legal drop: opened by hand at once and braked all the way down, onto ground up to 25 m below the
// place's (the map isn't flat), plus the free fall before it, the opening and a few seconds to spare.
DROP.maxMs = Math.round(((DROP.height + 25) / DROP.sinkSlow + DROP.minFall + DROP.deploy + 5) * 1000);

const G = 9.81;
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const lerp = (a, b, u) => a + (b - a) * u;

/**
 * Where a drop wants to go now (m/s): `forward` along the facing, `side` to the right, `down`. `s.open`: seconds
 * since the canopy began to open, or null in the free fall; `s.air`: the feet over the ground under them (m).
 * `input`: moveX (-1 left .. 1 right), moveY (-1 back .. 1 forward), dive (the dive key held).
 */
export function dropWant(s, input) {
  const mx = clamp1(input.moveX || 0);
  const my = clamp1(input.moveY || 0);
  if (s.open === null) {
    if (input.dive) return { forward: DROP.diveForward * Math.max(0, my), side: 0, down: DROP.diveDown };
    let forward = my >= 0 ? DROP.track * my : -DROP.backDrift * -my;
    let side = DROP.slide * mx;
    const n = Math.hypot(forward, side);
    if (n > DROP.track) [forward, side] = [(forward * DROP.track) / n, (side * DROP.track) / n]; // diagonals no faster
    return { forward, side, down: lerp(DROP.fallDown, DROP.trackDown, Math.max(0, my)) };
  }
  if (s.air < DROP.flareAt) return { forward: DROP.flareGlide, side: 0, down: DROP.flareSink };
  return my >= 0
    ? { forward: lerp(DROP.glide, DROP.glideFast, my), side: 0, down: lerp(DROP.sink, DROP.sinkFast, my) }
    : { forward: lerp(DROP.glide, DROP.glideSlow, -my), side: 0, down: lerp(DROP.sink, DROP.sinkSlow, -my) };
}

/**
 * One step of a drop, `dt` s, after `s.t` (seconds since it began) and `s.air` are current: opens the canopy when
 * asked (`input.open`, from DROP.minFall on) or by itself at DROP.openAt, and moves the velocity `s.vx, s.vz` (m/s
 * across, world) and `s.vy` (m/s, negative down) towards where it wants to go for the facing `yaw` (as a camera's:
 * 0 looks along -z). The free fall picks up speed as a falling body does (gravity against the air's drag); the
 * opening canopy brakes it eased in and out, with no jolt; under the canopy the speeds follow the keys gently.
 */
export function dropStep(s, input, yaw, dt) {
  if (s.open === null && ((input.open && s.t >= DROP.minFall) || s.air <= DROP.openAt)) s.open = 0;
  else if (s.open !== null) s.open += dt;
  const want = dropWant(s, input);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // forward
  const rx = Math.cos(yaw), rz = -Math.sin(yaw); // right
  const tx = fx * want.forward + rx * want.side;
  const tz = fz * want.forward + rz * want.side;
  let down = -s.vy;
  let across;
  if (s.open === null || s.open < DROP.open) {
    // Falling: up to the speed the posture allows as a body does (no faster than gravity), down to it more gently.
    if (s.open === null) {
      down = down < want.down ? Math.min(want.down, down + G * (1 - (down / want.down) ** 2) * dt + 1e-9) : down + (want.down - down) * (1 - Math.exp(-dt * 1.5));
    }
    across = s.open === null ? 1 - Math.exp(-dt * DROP.fallEase) : 0;
  } else {
    // The canopy brakes the fall: the pull rises eased over DROP.brake, then holds the glide's sink.
    const u = smooth((s.open - DROP.open) / DROP.brake);
    down += (want.down - down) * (1 - Math.exp(-dt * (0.4 + 3.2 * u)));
    across = 1 - Math.exp(-dt * (0.6 + 2.4 * u));
  }
  s.vy = -Math.max(0, down);
  s.vx += (tx - s.vx) * across;
  s.vz += (tz - s.vz) * across;
}

/**
 * A drop over flat ground, `dt` s a step, as the page flies it (src/player.ts: dropStep, the same steering
 * rate), with `input` held all the way (hands off by default) and `turn` (-1..1) on the steering: where it
 * went (`x` forward, `z` to the right of where it began facing), how long it took, its fastest speeds down and
 * across and its slowest average descent over DROP.hoverMs, its height each step. `openAt`: open by hand
 * this many seconds in (else by itself).
 */
export function fly(dt = 1 / 60, { height = DROP.height, input = {}, openAt = Infinity, turn = 0 } = {}) {
  const s = { t: 0, open: null, vx: 0, vz: 0, vy: 0, air: height };
  let yaw = 0, x = 0, z = 0, down = 0, across = 0;
  const path = [];
  while (s.air > 0 && s.t < 200) {
    path.push({ t: s.t, y: s.air, x: -z, side: x, open: s.open });
    dropStep(s, { ...input, open: s.t >= openAt }, yaw, dt);
    if (s.open !== null) yaw -= turn * DROP.turn * dt;
    s.air += s.vy * dt;
    x += s.vx * dt;
    z += s.vz * dt;
    s.t += dt;
    down = Math.max(down, -s.vy);
    across = Math.max(across, Math.hypot(s.vx, s.vz));
  }
  // The slowest average descent over any DROP.hoverMs before the landing (the server's hovering check).
  const w = DROP.hoverMs / 1000;
  let slowest = Infinity;
  for (let i = 0, j = 0; i < path.length; i++) {
    while (j < path.length && path[j].t - path[i].t < w) j++;
    if (j >= path.length) break;
    slowest = Math.min(slowest, (path[i].y - path[j].y) / (path[j].t - path[i].t));
  }
  return { reach: -z, side: x, time: s.t, down, across, slowest, path };
}

const nominal = fly();
DROP.reach = +nominal.reach.toFixed(2);
DROP.time = +nominal.time.toFixed(2);

/**
 * Where a drop starts so that, without steering, it lands on the place (x, z) facing `yaw` (as a
 * camera's yaw: 0 looks along -z): DROP.reach behind it. The server and the page both start it here.
 */
export function dropStart(x, z, yaw) {
  return { x: x + Math.sin(yaw) * DROP.reach, z: z + Math.cos(yaw) * DROP.reach };
}

/**
 * The house's start (the world's own start in front of the house, src/data/house.json's spawn): the drop for
 * a fresh arrival there lands on it coming along the lane from the west, clear of the houses across the lane
 * (yaw as a camera's: facing east, the house on your left).
 */
export const HOME_DROP = { x: 4.5, z: 19, yaw: -Math.PI / 2 };
