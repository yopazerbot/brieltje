// The parachute arrival (docs/parachute/README.md), shared by the page (src/player.ts moves you, src/world/
// parachutes.ts draws it) and the server (server/game.mjs: who drops, protection, how long).
//
// A drop starts high over the place the server picked (a respawn on open ground, a start place, the house's
// start, the Zombies game's places). First a free fall, straight down, then the canopy opens and brakes the
// fall, a short glide forward to the place, steered left and right, a flare near the ground, and on your feet.
// Coming down mostly straight keeps the whole drop close to its place: inside a Zombies arena's edge and clear
// of the houses round it. Across it moves no faster than running, so the server's movement budget holds it as
// it is; down, even the free fall stays under the server's limit (16 m/s).
export const DROP = {
  height: 80, // m over the landing place where the drop starts
  fall: 4, // s of free fall before the canopy goes out
  terminal: 14, // m/s: the free fall's top speed (the server allows 16 down)
  deploy: 1.8, // s the canopy takes to open (the Deploy clip)
  open: 0.55, // s into the deploy before the canopy starts to brake the fall (the bag and the lines go out first)
  brake: 1.5, // s the opening canopy takes to brake the fall to the glide's sink, eased in and out
  glide: 3.2, // m/s forward under the canopy (the server allows 4.55 across)
  sink: 4.2, // m/s down under the open canopy
  turn: 1.1, // rad/s at full steering
  flareAt: 3, // m over the ground: the flare slows the landing
  flareGlide: 1.5, // m/s forward in the flare
  flareSink: 1.2, // m/s down in the flare
  maxMs: 15000, // ms: a drop taking longer ends there (it takes about 11 s, see DROP.time)
  graceMs: 1200, // ms after the start before the page can end it (messages already on their way)
  // Measured by `fly` below when this file loads, so the page and the server always agree:
  reach: 0, // m a drop goes forward without steering, from where it starts to where it lands
  time: 0, // s a drop takes without steering, over flat ground
};

const G = 9.81;
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const freeFall = (t) => DROP.terminal * Math.tanh((G * t) / DROP.terminal); // m/s down, falling from rest

/**
 * How fast you fall (m/s, down) `t` s into a drop, your feet `air` m over the ground, falling `vy` m/s
 * (negative: down) the frame before, over `dt` s: the free fall (from rest towards DROP.terminal), the
 * canopy braking it (eased in and out, so there is no jolt), the glide's steady sink, and the flare's
 * slower one near the ground.
 */
export function dropSink(t, air, vy, dt) {
  const brakeAt = DROP.fall + DROP.open;
  if (t < brakeAt) return -freeFall(t);
  const u = (t - brakeAt) / DROP.brake;
  if (u < 1) return -(freeFall(brakeAt) + (DROP.sink - freeFall(brakeAt)) * smooth(u));
  const want = air < DROP.flareAt ? -DROP.flareSink : -DROP.sink;
  return vy + (want - vy) * (1 - Math.exp(-dt * 2.5));
}

/**
 * How fast you go forward (m/s) `t` s into a drop: nothing in the free fall, picking up speed once the canopy
 * is open (eased), slower in the flare. `push` (-1..1, the forward and back keys) nudges it by 8 %.
 */
export function dropGlide(t, air, push = 0) {
  if (air < DROP.flareAt) return DROP.flareGlide;
  const u = (t - DROP.fall - DROP.open - 0.3) / 1.6;
  return DROP.glide * smooth(u) * (1 + 0.08 * push);
}

/**
 * A drop without steering over flat ground, as the page flies it (src/player.ts: the same speeds, its
 * velocity eased the same way), `dt` s a step: how far forward it went, how long it took, how fast it went
 * at most down and across, and its height and distance to go each step (for drawing the others and the tests).
 */
export function fly(dt = 1 / 60, height = DROP.height) {
  let t = 0, y = height, vy = 0, v = 0, x = 0, down = 0, across = 0;
  const path = [];
  while (y > 0 && t < 60) {
    path.push({ t, y, x });
    vy = dropSink(t, y, vy, dt);
    v += (dropGlide(t, y) - v) * (1 - Math.exp(-12 * dt));
    y += vy * dt;
    x += v * dt;
    t += dt;
    down = Math.max(down, -vy);
    across = Math.max(across, v);
  }
  return { reach: x, time: t, down, across, path };
}

const nominal = fly();
DROP.reach = +nominal.reach.toFixed(2);
DROP.time = +nominal.time.toFixed(2);
const heights = nominal.path.filter((_, i) => i % 6 === 0).map((p) => [p.t, DROP.height - p.y]);

/**
 * How long a drop has been under way once it has come down `fallen` m (on its usual course): for a player
 * first seen in the middle of a drop, whose parachute is drawn as far along as they are.
 */
export function dropSince(fallen) {
  if (fallen <= 0) return 0;
  for (let i = 1; i < heights.length; i++) {
    const [t1, f1] = heights[i];
    if (f1 >= fallen) {
      const [t0, f0] = heights[i - 1];
      return t0 + ((t1 - t0) * (fallen - f0)) / Math.max(1e-6, f1 - f0);
    }
  }
  return heights.at(-1)[0];
}

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
