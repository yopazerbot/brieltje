// Places where nobody shoots, read by the game (src/main.ts: no firing or throwing there, and a
// notice) and the server (server/game.mjs: no hits, rockets, grenades or blast damage in or out).
// The school grounds in Smetlede: the outline round its buildings, fences and playground
// (src/data/village.json), 1.5 m wider. Points are game metres, x and z.

export const NO_SHOOT = [
  {
    id: 'school',
    poly: [[446, -792.1], [447.5, -800.8], [448.3, -805.3], [454.7, -832], [460, -843.3], [463.7, -844.1], [469, -845], [482.7, -844.4], [491.4, -839.9], [487.9, -786.7], [470.6, -787.2]],
  },
];

/** The no-shooting zone at (x, z), or null. */
export function noShoot(x, z) {
  for (const zone of NO_SHOOT) {
    let inside = false;
    const p = zone.poly;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if ((p[i][1] > z) !== (p[j][1] > z) && x < ((p[j][0] - p[i][0]) * (z - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
    }
    if (inside) return zone;
  }
  return null;
}
