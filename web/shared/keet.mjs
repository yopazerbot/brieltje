// The café at the church (In de Oude Keet, the name on its sign board): a house everyone walks into, without a code. Its
// shell and its rooms are public data (src/data/keet_shell.json, keet_rooms.json, from tools/keet.py), read the same on
// the page and on the server. It is no home: it is in no list of shared/homes.mjs, its door ids start with `keet-` and
// belong to no home (homeOfDoor gives null), its panes have numbers of their own that no home's range holds. Nothing here
// knows the code-locked homes, so the café can never be taken for one, nor one for the café.

/** The café's pane numbers: its windows from `glass` (the shell's panes, in order), door glass from `doorGlass`. */
export const PUBLIC_WALK_INS = { keet: { glass: 8000, doorGlass: 8500, size: 500 } };
/** A café door's id: `keet-` and a short name */
export const KEET_DOOR = /^keet-[a-z0-9]{1,12}$/;

/**
 * The café in the world, from its two files: `outline`, `contains(x, z)` and `floor` (the game's heights), `doors` (world coordinates and
 * heights, as world/walkIn.ts places them), `prisms` (the walked-into blocks in the world, the panes as `m: 'glass'` with
 * their numbers), `area` (the outline's box and a metre round it), `doorIds`, `panes` (the pane numbers that exist:
 * windows and door glass), `publicPane(i)` (whether `i` is one of them) and `spots` (each room's middle, by name).
 * Throws when a door id is not a café door's.
 */
export function makeKeet(shell, rooms) {
  const { o, a, floor } = shell.frame;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const toWorld = ([x, z]) => [o[0] + x * c + z * s, o[1] - x * s + z * c]; // world/walkIn.ts loadWalkIn's toWorld
  const range = PUBLIC_WALK_INS.keet;
  let glassNo = range.doorGlass;
  const doorGlass = [];
  const doors = [...shell.doors, ...rooms.doors].map((d) => {
    if (typeof d.id !== 'string' || !KEET_DOOR.test(d.id)) throw new Error(`the café has a door that is not one of its own: ${d.id}`);
    return {
      id: d.id, name: d.name, open: !!d.open, y0: d.y0 + floor, y1: d.y1 + floor,
      panels: d.panels.map((p) => {
        const panel = { ...p, a: toWorld(p.a), b: toWorld(p.b) };
        if (p.glass) {
          panel.glassNo = glassNo++;
          doorGlass.push(panel.glassNo);
        }
        return panel;
      }),
    };
  });
  const world = (b, m) => ({ m, y0: b.y0 + floor, y1: b.y1 + floor, p: b.p.map((r) => r.map(toWorld)), ...(b.n ? { n: b.n } : {}) });
  const windows = shell.panes.map((p, i) => ({ ...world(p, 'glass'), glass: range.glass + i }));
  const prisms = [...rooms.prisms.filter((b) => b.s !== 0).map((b) => world(b, b.m === 'glassfix' ? 'glass' : b.m)), ...windows];
  const xs = shell.outline.map((q) => q[0]);
  const zs = shell.outline.map((q) => q[1]);
  const middle = (r) => [r.reduce((t, q) => t + q[0], 0) / r.length, r.reduce((t, q) => t + q[1], 0) / r.length];
  const spots = rooms.rooms.map((name) => {
    const f = rooms.prisms.find((b) => b.n === name && Math.abs(b.y1) < 1e-6);
    const [x, z] = toWorld(middle(f.p[0]));
    return { name, x, z, y: floor };
  });
  const panes = [...windows.map((w) => w.glass), ...doorGlass];
  const paneSet = new Set(panes);
  if (panes.length > range.size || doorGlass.length > range.size) throw new Error('the café has more panes than its range');
  const ring = shell.outline;
  /** Whether (x, z) lies inside the café's outline. */
  const contains = (x, z) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  return {
    outline: shell.outline,
    contains,
    floor,
    doors,
    prisms,
    area: { minX: Math.min(...xs) - 1, maxX: Math.max(...xs) + 1, minZ: Math.min(...zs) - 1, maxZ: Math.max(...zs) + 1 },
    doorIds: new Set(doors.map((d) => d.id)),
    panes,
    publicPane: (i) => Number.isInteger(i) && paneSet.has(i),
    spots,
  };
}
