// Steal the flag's two fields (server/flags.mjs keeps the rules, src/world/flags.ts draws the stands), shared by the
// server and the page. Blue's base is at the church in both (Yoshi, 16 Nov 2026: "Team blue base: at the church. Team
// red base: at Sparrenhof.").
//
// - `compact`: red by the Molenhoek portal, about 230 m along Smetlededorp from the church square: public street, a
//   straight way there and back. The field's edge is a band round that street (`edge`: the two ends and its half
//   width), each end 32 m past its team's stand, so both bases have the same room behind them (Yoshi, 17 Nov 2026: "Make
//   sure the ctf is fair"); its west end takes in part of the school's grounds, open to the fight in a team match
//   ("School zone ok to shoot in team v team").
// - `village`: red at the Sparrenhof, about 1.7 km away. The whole map is the field. Each base has cars in the team's
//   colour and bikes, enough seats for a team of 15 (2 a car, 1 a bike), parked on its square or forecourt for as long
//   as the game runs.
// - Both fields, every look (Yoshi, 17 Nov 2026: "Make flying also possible in team vs team but make sure both teams
//   have a heli spawned near their base"): a helicopter for each team (`heli`), set down on the ground for the game,
//   each the same walk from its team's start places (38.5 m blue, 36.9 m red at Molenhoek, 34.8 m at the
//   Sparrenhof), behind the base as seen from the other team and further than 14 m from either stand.
// - Fair (Yoshi, 17 Nov 2026): each stand on open paving, its start places 12 to 22 m behind it as seen from the other
//   team (the same spread at both bases of a field), the racks the same 6 m from their stands, the same vehicles each,
//   at alike distances; the village's own vehicles by a base that only one team would have (`off`: the church's two
//   Teslas, the bikes on the racks by the stands) are out of play while the game runs.
//
// Each base: `stand` [x, z, y] (y the ground there), where the flag stands and where its team scores; `spawns` [x, z, y],
// where its players start and come back (game.mjs respawn, facing the stand); `rack` [x, z, y, yaw], the team's bazooka
// rack (server/flagBazooka.mjs), 6 m from the stand to its side, its front to it. Points are game metres, from the map
// (measured in the page: walkable public ground, 0.8 m free round each start place). With the sides swapped (the
// host's `swap`, server/flags.mjs) blue plays from red's base and red from blue's: `baseOf`.

import { makeBounds } from './bounds.mjs';
import { ASSAULT_FIELDS } from './assaultFields.mjs';

export const FLAG_TEAMS = ['blue', 'red'];
/** As the host's evening teams (server/host.mjs EVENING_TEAMS). */
export const FLAG_COLORS = { blue: '#4fa3e0', red: '#e5484d' };

// The church square: the stand on the open paving of the square, clear of the church's corner (12.7 m free round it),
// the start places on the square west of it, 13 to 22 m off (mean 18.2).
const CHURCH = {
  stand: [528.1, -765.4, 4.89],
  spawns: [[509.0, -776.5, 4.60], [512.5, -775.0, 4.65], [512.0, -779.5, 4.59], [515.5, -777.5, 4.63], [519.0, -779.5, 4.70], [521.5, -776.5, 4.67]],
  // To the stand's side, towards the church's front.
  rack: [523.86, -761.16, 5.09, -0.785],
};
// Molenhoek: on the footpath 16 m further east than before (no house front or tree by it, 9.8 m free round it), the
// start places on the footpath and the cycle lane east of it, 13 to 24 m off (mean 18.6). Public street; no drive or
// front garden.
const MOLENHOEK = {
  stand: [755.95, -722.2, 7.07],
  spawns: [[768.5, -720.5, 7.21], [772.0, -720.0, 7.23], [776.0, -721.5, 7.34], [779.5, -719.5, 7.32], [771.0, -713.5, 7.32], [775.5, -712.8, 7.38]],
  // On the footpath to the stand's side.
  rack: [754.4, -716.4, 7.16, -0.261],
};
// The Sparrenhof: on the footpath at the forecourt's south end by the road (Oud-Smetlede), 15 m from the parked car
// there, the start places on the forecourt and in the wood behind it, 12 to 22 m off (mean 17.8).
const SPARRENHOF = {
  stand: [639.5, 946.5, -7.02],
  spawns: [[638.0, 958.5, -7.14], [636.0, 961.5, -7.18], [647.0, 962.5, -6.96], [637.5, 964.5, -7.12], [636.5, 967.5, -7.10], [641.5, 968.5, -6.99]],
  // On the forecourt to the stand's side.
  rack: [645.5, 946.5, -7.01, 1.5708],
};
/**
 * Blue's helicopter in both fields: the church's own (shared/heli.json), set down for the game on the paving west of the
 * church, off the traffic's lanes (17.8 m), its rotor 7.4 m clear, its nose to the base.
 */
const CHURCH_HELI = { id: 'church', x: 489.9, y: 4.72, z: -761.4, yaw: -1.5708 };
/** The village's own vehicles by a base only one team would have: out of play while the game runs (server/flags.mjs park). */
const OFF_CARS = ['churchY', 'church3'];

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
    edge: { from: [496.7, -771.4], to: [787.4, -716.2], half: 30 },
    /**
     * Each team's helicopter: blue the church's; red the house's machine, set down for the game on Molenhoek's road east
     * of the base, along the street (no ground off the road there: the traffic waits for it without a honk, its rotor
     * 8 m clear of the lamp posts, the front gardens and the trees).
     */
    heli: { blue: CHURCH_HELI, red: { id: 'house', x: 807.8, y: 7.47, z: -711.0, yaw: 1.78 } },
    // Six bikes each, no cars (the church's Teslas out of play): blue's in a row on the square between the stand and the
    // start places, red's on the footpath between its stand and its start places.
    vehicles: {
      blue: { cars: [], bikes: rack('flagB', 6, [520.5, 4.68, -773.0], [0.75, 0, 0], 0) },
      red: { cars: [], bikes: rack('flagM', 6, [764.0, 7.35, -713.0], [0.75, 0, 0], 0) },
    },
    off: { cars: OFF_CARS, bikes: ['church1', 'church2', 'church3', 'molenhoek1', 'molenhoek2'] },
  },
  village: {
    id: 'village',
    red: 'sparrenhof',
    bases: { blue: CHURCH, red: SPARRENHOF },
    edge: null,
    vehicles: {
      // `kind`: a placed Tesla's (shared/car.json placed.kinds), in the team's colour.
      // On the square's marked bays (28 to 32 m from the start places); the bikes in a row on the square between the
      // stand and the start places (6 to 12 m).
      blue: {
        cars: [{ kind: 'modelY-blue', x: 535.5, y: 5.37, z: -753.0, yaw: 1.5708 }, { kind: 'modelY-blue', x: 535.5, y: 5.27, z: -755.6, yaw: 1.5708 }, { kind: 'modelY-blue', x: 535.5, y: 5.15, z: -758.2, yaw: 1.5708 }],
        bikes: rack('flagB', 9, [520.5, 4.68, -773.0], [0.75, 0, 0], 0),
      },
      // On the forecourt's south part, one behind the other along the road (22 to 33 m from the start places); the bikes
      // in a row on the forecourt by the start places (6 to 11 m).
      red: {
        cars: [{ kind: 'modelY-red', x: 651.4, y: -7.03, z: 945.0, yaw: -0.4615 }, { kind: 'modelY-red', x: 654.5, y: -6.76, z: 939.1, yaw: -0.4615 }, { kind: 'modelY-red', x: 651.5, y: -6.76, z: 933.5, yaw: -0.4615 }],
        bikes: rack('flagR', 9, [643.0, -7.07, 959.5], [0.75, 0.0105, 0], 0),
      },
    },
    off: { cars: OFF_CARS, bikes: ['church1', 'church2', 'church3', 'sparrenhof1', 'sparrenhof2'] },
    /**
     * Each team's helicopter: blue the church's; red the house's machine (shared/heli.json), set down for the game in the
     * clearing across the road from the café, its rotor clear of every tree's crown, its nose to the café.
     */
    heli: { blue: CHURCH_HELI, red: { id: 'house', x: 613.0, y: -7.3, z: 944.0, yaw: -1.5708 } },
  },
  // Attack and defend's two fields, one a round (shared/assaultFields.mjs): blue's side the defenders', red's the camp.
  ...ASSAULT_FIELDS,
};

/**
 * The base `team` plays from on `field`: its own, or with the sides swapped (the host's `swap`) the other team's. The
 * server and every page ask this, never `bases[team]` alone.
 */
export function baseOf(field, team, swapped = false) {
  return field.bases[swapped ? (team === 'blue' ? 'red' : 'blue') : team];
}

/**
 * The team a vehicle of `field` belongs to (`swapped`: with the sides swapped), or null: each team's helicopter (`heli`)
 * and the cars the game parks at its base (ids `fb1`.., `fr1`..). Its own team does it no damage (server/vehicleDamage.mjs
 * mayDamage; the page marks no hit on it, src/world/vehicleWear.ts).
 */
export function vehicleTeam(field, kind, id, swapped = false) {
  const side = kind === 'heli' ? FLAG_TEAMS.find((t) => field.heli?.[t]?.id === id) ?? null
    : kind === 'car' && typeof id === 'string' && /^f[br]\d+$/.test(id) ? (id[1] === 'b' ? 'blue' : 'red') : null;
  return side && swapped ? (side === 'blue' ? 'red' : 'blue') : side;
}

/** The field `id`, or the compact one (an unknown or forged id). */
export function fieldOf(id) {
  return typeof id === 'string' && Object.hasOwn(FIELDS, id) ? FIELDS[id] : FIELDS.compact;
}

/** Every bike a field may park, by id (the page draws them from here, hidden until its game parks them). */
export const FLAG_BIKES = Object.fromEntries(Object.values(FIELDS).flatMap((f) => (f.vehicles ? FLAG_TEAMS.flatMap((t) => f.vehicles[t].bikes.map((k) => [k.id, { team: t, park: { x: k.x, y: k.y, z: k.z, yaw: k.yaw } }])) : []))); // the compact field's blue bikes are the village's first six

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
