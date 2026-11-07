// The café Sparrenhof and the wood round it, shared by the page and the server (Yoshi, 7 Nov 2026: a Zombies place
// where the horde comes out of the woods, with stairs up the café's roofs as a shooting base).
//
// - The café's blocks for walking into (tools/sparrenhof.py writes sparrenhof.json, heights above the ground at its
//   origin): its own walls and roofs in place of the open data's plain block, with three made-up outside stairs of
//   steel to its roofs (the annex's flat roof with a roof walk across the veranda, and the carport's roof). For
//   walking, shots and the zombies' grid alike; `area` is where that grid is finer and has every floor, so the zombies
//   follow the players up the stairs (shared/zombies.mjs makeNav, as in the church tower).
// - The wood: the trunks of the village's trees as thin blocks the zombies walk round, and the spots deep among them
//   where the horde comes out.

/** The café's data placed on the ground (`ground`: the game's height of the ground at its origin). */
export function makeCafe(data, ground) {
  const at = ([x, z, y]) => ({ x, z, y: y + ground });
  const [x0, z0, x1, z1] = data.area;
  return {
    prisms: data.blocks.map((p) => ({ ...p, lm: 'sparrenhof', y0: p.y0 + ground, y1: p.y1 + ground })),
    outlines: data.outlines,
    clear: data.clear,
    area: { minX: x0, minZ: z0, maxX: x1, maxZ: z1 },
    stairs: data.stairs.map((s) => ({ id: s.id, foot: at(s.foot), top: at(s.top), risers: s.risers, rise: s.rise, going: s.going })),
    roofs: data.roofs.map((r) => ({ id: r.id, at: at(r.at) })),
  };
}

/** Whether (x, z) lies inside the outline `ring`. */
function inside(ring, x, z) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Whether (x, z) lies inside the outline `ring` or within `slack` m of it. */
function near(ring, x, z, slack) {
  if (inside(ring, x, z)) return true;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    const dx = xj - xi;
    const dz = zj - zi;
    const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(xi + dx * t - x, zi + dz * t - z) <= slack) return true;
  }
  return false;
}

/** Even-odd across an outline and its holes. */
function insideRings(x, z, rings) {
  let hit = false;
  for (const ring of rings) if (inside(ring, x, z)) hit = !hit;
  return hit;
}

/**
 * The village's blocks with the café's own in place of its plain ones: a standing block (not draped on the ground,
 * as the forecourt's paving and the fences are) whose every corner lies on or within half a metre of an outline
 * of the café (`outlines`) goes. Every other block stays.
 */
export function cafePrisms(prisms, cafe) {
  const replaced = (p) => p.d === undefined && p.p[0].every(([x, z]) => cafe.outlines.some((ring) => near(ring, x, z, 0.5)));
  return [...prisms.filter((p) => p.lm !== 'sparrenhof' && !replaced(p)), ...cafe.prisms];
}

/** m: a trunk's half width for the zombies (a player bumps into 0.35: main.ts `trunks`) */
const TRUNK = 0.3;

/**
 * The trunks of the trees (village.json's) within `box` (minX, maxX, minZ, maxZ; 2 m more) as blocks on the ground:
 * zombies walk between them. Not those on the café's open ground, which the page drops (world/streetModel.ts
 * clearOpenGround: inside or within 1.5 m of its rings).
 */
export function woodTrunks(trees, cafe, box) {
  const out = [];
  for (const t of trees) {
    if (t.x < box.minX - 2 || t.x > box.maxX + 2 || t.z < box.minZ - 2 || t.z > box.maxZ + 2) continue;
    if (cafe.clear.some((ring) => near(ring, t.x, t.z, 1.5))) continue;
    const ring = [];
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * Math.PI * 2;
      ring.push([Math.round((t.x + Math.cos(a) * TRUNK) * 1000) / 1000, Math.round((t.z + Math.sin(a) * TRUNK) * 1000) / 1000]);
    }
    out.push({ m: 'oak', n: 'trunk', d: 1, y0: -0.3, y1: 6, p: [ring] });
  }
  return out;
}

/** m: how far in among the trees a spot must lie (every way round it still wood), and off the café's open ground */
export const WOOD_DEPTH = 3;
const OPEN_SLACK = 4;

/**
 * Of the places where zombies can come out (nav.spawnSpots), those deep in the wood: on the woods' ground (the
 * village's `forest` blocks, `prisms`) WOOD_DEPTH m in every way round, and clear of the café's open ground. Each is
 * marked `wood`: the horde (shared/zombies.mjs Horde.pick) may bring one out there in sight, far enough off, as if
 * from between the trees.
 */
export function woodSpots(spots, prisms, cafe) {
  const woods = prisms.filter((p) => p.m === 'forest');
  const inWood = (x, z) => woods.some((w) => insideRings(x, z, w.p));
  const out = [];
  for (const s of spots) {
    if (cafe.clear.some((ring) => near(ring, s.x, s.z, OPEN_SLACK))) continue;
    let deep = inWood(s.x, s.z);
    for (let k = 0; k < 8 && deep; k++) {
      const a = (k / 8) * Math.PI * 2;
      deep = inWood(s.x + Math.cos(a) * WOOD_DEPTH, s.z + Math.sin(a) * WOOD_DEPTH);
    }
    if (deep) out.push({ ...s, wood: true });
  }
  return out;
}
