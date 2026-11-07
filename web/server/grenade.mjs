// Where a thrown grenade may go off (server/game.mjs boom). The thrower's browser works out the flight (it bounces off
// the house) and says where it went off; the server keeps that point within what a throw can reach, so a forged
// message can't set off a grenade next to somebody far away.
//
// An honest throw leaves the hand at GRENADE.speed along the view, plus the thrower's own running speed and a little
// upwards (src/main.ts throwGrenade), and goes off after GRENADE.fuse seconds. Gravity, bounces and rolling only take
// speed away along the ground, so in that time it gets no further than its speed along the ground times the fuse.

/** Seconds on top of the fuse, for an odd frame on the thrower's computer. */
export const NADE_SLACK = 0.5;
const GRAVITY = 9.81;

/**
 * The blast point the server uses. `throwAt`: where the thrower stood at the throw, by the server's own count (x, y, z,
 * at the hand), and `vh`, the speed along the ground the throw message carried (or undefined); `at`: where the browser
 * says it went off; `spec`: shared/grenade.json. A point beyond the reach is pulled back to its edge, straight
 * towards the throw; one above the highest a throw can climb is lowered to it. Falling is not limited (from a roof).
 */
export function blastPoint(throwAt, at, spec) {
  const t = spec.fuse + NADE_SLACK;
  let reach = spec.speed * t;
  if (Number.isFinite(throwAt.vh)) reach = Math.min(reach, Math.max(0, throwAt.vh) * t + 1); // a slow throw lands near
  const dx = at.x - throwAt.x;
  const dz = at.z - throwAt.z;
  const d = Math.hypot(dx, dz);
  const k = d > reach ? reach / d : 1;
  const climb = (spec.speed + 2.2) ** 2 / (2 * GRAVITY) + 1; // thrown straight up, with the throw's lift
  return { x: throwAt.x + dx * k, y: Math.min(at.y, throwAt.y + climb), z: throwAt.z + dz * k };
}
