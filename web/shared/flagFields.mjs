// Steal the flag's two fields (server/flags.mjs keeps the rules, src/world/flags.ts draws the stands), shared by the
// server and the page. Blue's base is at the church in both (Yoshi, 16 Nov 2026: "Team blue base: at the church. Team
// red base: at Sparrenhof.").
//
// - `compact`: red by the Molenhoek portal, about 220 m along Smetlededorp from the church square: public street, a
//   straight way there and back, and the school's grounds (west of the church, where nobody shoots) nowhere near it.
//   The field's edge is a band round that street (`edge`: the two ends and its half width), so the school stays out.
// - `village`: red at the Sparrenhof, about 1.7 km away. The whole map is the field. Each base has cars in the team's
//   colour and bikes, enough seats for a team of 15 (2 a car, 1 a bike), parked on its square or forecourt for as long
//   as the game runs.
// - Both fields, every look (Yoshi, 17 Nov 2026: "Make flying also possible in team vs team but make sure both teams
//   have a heli spawned near their base"): a helicopter for each team (`heli`): blue the church's own on its deck, red
//   the house's machine set down near its base for the game.
//
// Each base: `stand` [x, z, y] (y the ground there), where the flag stands and where its team scores; `spawns` [x, z, y],
// where its players start and come back (game.mjs respawn, facing the stand); `rack` [x, z, y, yaw], the team's bazooka
// rack (server/flagBazooka.mjs), 4 to 8 m from the stand, its front to it (along the footpath at Molenhoek). Points are
// game metres, from the map.

import { makeBounds } from './bounds.mjs';

export const FLAG_TEAMS = ['blue', 'red'];
/** As the host's evening teams (server/host.mjs EVENING_TEAMS). */
export const FLAG_COLORS = { blue: '#4fa3e0', red: '#e5484d' };

// The church square: the stand on the open paving between the church's front and Smetlededorp, its start places round it.
const CHURCH = {
  stand: [522.1, -769.4, 4.75],
  spawns: [[525.6, -764.2, 4.93], [519.0, -765.3, 4.92], [516.4, -771.4, 4.72], [527.6, -770.6, 4.71], [523.6, -775.0, 4.62], [529.0, -761.0, 5.05]],
  // Towards the church's front, off the road across the square.
  rack: [522.4, -762.9, 5.0, 0.046],
};
// Molenhoek: on the footpath 8 m short of the portal's pad (the pad stays free), the start places on the footpath and the
// cycle lane on either side of it. Public street; no drive or front garden.
const MOLENHOEK = {
  stand: [739.95, -716.2, 7.1],
  spawns: [[744.8, -715.0, 7.4], [748.8, -714.4, 7.32], [745.5, -717.8, 6.99], [749.4, -717.0, 7.04], [735.1, -717.4, 7.11], [735.8, -720.1, 6.86]],
  // In the middle of the footpath west of the stand, along it (the start places on either side).
  rack: [733.0, -718.9, 7.05, -0.189],
};
// The Sparrenhof: on its forecourt between the café and the road (Oud-Smetlede), the start places round it.
const SPARRENHOF = {
  stand: [644.0, 957.0, -7.08],
  spawns: [[640.0, 961.0, -7.14], [647.5, 961.0, -7.03], [639.0, 953.5, -7.09], [647.0, 952.5, -6.97], [644.0, 964.0, -7.03], [641.5, 949.5, -7.01]],
  // On the forecourt's west side, towards the road.
  rack: [637.5, 958.5, -7.18, -1.344],
};
/** Blue's helicopter in both fields: the church's own, on its deck (shared/heli.json). */
const CHURCH_HELI = { id: 'church' };

/** A row of `n` bikes from (x, y, z), each (dx, dy, dz) further along, standing at `yaw`; ids `prefix` + 1, 2, ... */
function rack(prefix, n, [x, y, z], [dx, dy, dz], yaw) {
  const r = (v) => Math.round(v * 1000) / 1000;
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, x: r(x + dx * i), y: r(y + dy * i), z: r(z + dz * i), yaw }));
}

export const FIELDS = {
  compact: {
    id: 'compact',
    /** The portal by red's base: its name in the chat's lines (src/i18n.ts portal.*). */
    red: 'molenhoek',
    bases: { blue: CHURCH, red: MOLENHOEK },
    edge: { from: [530, -766], to: [742, -716], half: 30 },
    /**
     * Each team's helicopter: blue the church's; red the house's machine, set down for the game on Molenhoek's road west
     * of the base, along the street (its rotor over the road, clear of the lamp posts, the front gardens and the trees).
     */
    heli: { blue: CHURCH_HELI, red: { id: 'house', x: 713.0, y: 6.65, z: -727.5, yaw: -1.76 } },
  },
  village: {
    id: 'village',
    red: 'sparrenhof',
    bases: { blue: CHURCH, red: SPARRENHOF },
    edge: null,
    vehicles: {
      // `kind`: a placed Tesla's (shared/car.json placed.kinds), in the team's colour.
      // On the square's marked bays, and the church's bike rack by the portal made longer.
      blue: {
        cars: [{ kind: 'modelY-blue', x: 535.5, y: 5.37, z: -753.0, yaw: 1.5708 }, { kind: 'modelY-blue', x: 535.5, y: 5.27, z: -755.6, yaw: 1.5708 }, { kind: 'modelY-blue', x: 535.5, y: 5.15, z: -758.2, yaw: 1.5708 }],
        bikes: rack('flagB', 9, [532.92, 4.74, -769.19], [0, 0.026, 0.75], 1.571),
      },
      // On the forecourt's south part, one behind the other along the road; the bikes along the café's front.
      red: {
        cars: [{ kind: 'modelY-red', x: 651.4, y: -7.03, z: 945.0, yaw: -0.4615 }, { kind: 'modelY-red', x: 654.5, y: -6.76, z: 939.1, yaw: -0.4615 }, { kind: 'modelY-red', x: 651.5, y: -6.76, z: 933.5, yaw: -0.4615 }],
        bikes: rack('flagR', 9, [651.11, -6.97, 957.35], [0.238, 0, -0.711], -1.895),
      },
    },
    /**
     * Each team's helicopter: blue the church's; red the house's machine (shared/heli.json), set down for the game in the
     * clearing across the road from the café, its rotor clear of every tree's crown, its nose to the café.
     */
    heli: { blue: CHURCH_HELI, red: { id: 'house', x: 613.0, y: -7.3, z: 944.0, yaw: -1.5708 } },
  },
};

/** The field `id`, or the compact one (an unknown or forged id). */
export function fieldOf(id) {
  return typeof id === 'string' && Object.hasOwn(FIELDS, id) ? FIELDS[id] : FIELDS.compact;
}

/** Every bike a field may park, by id (the page draws them from here, hidden until its game parks them). */
export const FLAG_BIKES = Object.fromEntries(Object.values(FIELDS).flatMap((f) => (f.vehicles ? FLAG_TEAMS.flatMap((t) => f.vehicles[t].bikes.map((k) => [k.id, { team: t, park: { x: k.x, y: k.y, z: k.z, yaw: k.yaw } }])) : [])));

/**
 * A field's edge (a Bounds): the band round the compact field's street, its round ends round each base, every point kept
 * 2 m inside the map's edge; the village field plays on the whole map (`edges`: { map }).
 */
export function fieldEdge(field, edges) {
  const e = field.edge;
  if (!e) return edges.map;
  const [ax, az] = e.from;
  const [bx, bz] = e.to;
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len, uz = (bz - az) / len;
  const ring = [];
  // Round the far end (b) from one side to the other, then round the near end (a): a capsule, counter-clockwise.
  for (const [cx, cz, from] of [[bx, bz, -Math.PI / 2], [ax, az, Math.PI / 2]]) {
    for (let k = 0; k <= 12; k++) {
      const t = from + (k / 12) * Math.PI;
      const dx = Math.cos(t) * ux - Math.sin(t) * uz, dz = Math.cos(t) * uz + Math.sin(t) * ux;
      let r = e.half;
      while (r > 5 && edges.map.depth(cx + dx * r, cz + dz * r) < 2) r -= 1;
      ring.push([Math.round((cx + dx * r) * 100) / 100, Math.round((cz + dz * r) * 100) / 100]);
    }
  }
  return makeBounds(ring);
}
