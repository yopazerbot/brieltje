// The parachute arrival (docs/parachute/README.md), shared by the page (src/player.ts moves you, src/world/
// parachutes.ts draws it) and the server (server/game.mjs: who drops, protection, how long).
//
// A drop starts high over the place the server picked (a respawn on open ground, the start place, the
// Zombies game's places): packed for a moment, then under the canopy, gliding forward and steered left
// and right, a flare near the ground, and on your feet. Across it moves no faster than running, so the
// server's movement budget holds it as it is; downwards well under the server's limit (16 m/s).
export const DROP = {
  height: 18, // m over the landing place where the drop starts
  fall: 0.6, // s packed, falling, before the canopy goes out
  deploy: 1.8, // s the canopy takes to open (the Deploy clip)
  glide: 4.0, // m/s forward under the canopy (the server allows 4.55 across)
  sink: 3.6, // m/s down under the open canopy
  turn: 1.1, // rad/s at full steering
  flareAt: 3, // m over the ground: the flare slows the landing
  maxMs: 8000, // ms: a drop taking longer ends there (it takes about 5 s)
  slack: 2, // s a page may lag behind sinking DROP.sink from the start (its messages' delay, the flare) before the server ends its drop
  graceMs: 1200, // ms after the start before the page can end it (messages already on their way)
  reach: 13, // m a drop goes forward without steering (measured in the game)
};

/**
 * Where a drop starts so that, without steering, it lands on the place (x, z) facing `yaw` (as a
 * camera's yaw: 0 looks along -z): DROP.reach behind it. The server and the page both start it here.
 */
export function dropStart(x, z, yaw) {
  return { x: x + Math.sin(yaw) * DROP.reach, z: z + Math.cos(yaw) * DROP.reach };
}
