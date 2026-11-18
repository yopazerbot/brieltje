// Attack and defend's two fields (server/assault.mjs keeps the rules, src/world/assaultCamp.ts draws the camps), shared
// by the server and the page. Yoshi, 18 Nov 2026: "the team v team with sparrenhof and church as base are too wide
// apart. Let's think about something else: we have a defender/attack scenario, once with the church as base, once as
// sparrenhof as base. And the attackers basically have to come steal the flag, the defenders should defend. The attackers
// should have some kind of 'mobile base camp' at a reasonable but far enough distance from the defenders base camp."
//
// Two rounds, one field each: round 1 at the church, round 2 at the Sparrenhof, the teams' roles swapped between them.
// Each field is a Steal the flag field (shared/flagFields.mjs FIELDS, the same shape): its blue side is always the
// defenders' base (the stand, their start places), its red side the attackers' camp (the camp's flag pole, where a
// capture counts, and their start places). Which team plays which side is the round's `swapped` (flagFields baseOf):
// the defenders blue, not swapped. The rest of the Steal the flag pages (the stands, the flags, the parked vehicles,
// the helicopters, the vehicles' owners) then works as it does there.
//
// Where the camps are (measured in the page on walkable public ground; Yoshi asked about 350 m, "about 1 min on foot,
// 20 s by car"). Round the Sparrenhof the map is a narrow strip along its road (the wood and the fields beyond are
// outside it) down to the hamlet south of it, built up from 300 to 380 m off (houses, sheds, gardens); the first open
// ground past it is the field at the hamlet's south-east end. So both camps are a little further than asked, the same in
// both rounds:
// - the church: in the meadow west of the village, south of the farm track that crosses it (no house within 70 m, no
//   tree within 35 m, nothing in between). Its flag is 401 m from the church's stand in a straight line, 472 m by the
//   road (west out of the village, then along the farm track).
// - the Sparrenhof: in the field at the hamlet's south-east end, between the fence on its north side and the fence and
//   hedge on its south side (its capture ring 2 m inside the north fence, its corner lamps 1.6 m inside the south one),
//   the meadow east of it for its vehicles. Its flag is 410 m from the Sparrenhof's stand in a straight line, 464 m by
//   the road (down to the hamlet, then 50 m across the grass).
// At a run that is a little over a minute, by car about 20 s. Neither camp is in or near a code-locked private home
// (shared/homes.mjs: the nearest 688 m off) nor on the school grounds (shared/zones.mjs): both checked in
// shared/assaultFields.test.mjs.
//
// Fair (Yoshi, 17 Nov 2026: "Make sure the ctf is fair"): both camps are one layout (CAMP, offsets from the camp's flag,
// its front to the defenders), the same crates, lamps, tents and start places, and the spawn truck, the helicopter and
// the two cars at the same distances from the flag. The defenders' bases are Steal the flag's (start places 12 to 22 m
// behind the stand), each with the same six crates in a row between the stand and the start places, two cars and a
// helicopter.

/** The rules' numbers (server/assault.mjs, src/world/assaultCamp.ts). */
export const ASSAULT = Object.freeze({
  /** ms a round lasts at most (the programme's minutes override it) */
  roundMs: 10 * 60_000,
  /** ms between the two rounds: everyone at their new places, the flag untouchable */
  breakMs: 20_000,
  /** m across from the camp's flag (its foot) for a capture on foot or on a bike, and a car's middle */
  campR: 8,
  campRCar: 10,
  /** m in height between the carrier's feet and the camp's ground for a capture */
  campHigh: 3,
  /**
   * m at least from the defenders' stand for the spawn truck to be a start place: a downed attacker coming back by the
   * truck has 120 m to run (about 20 s), never a step from the flag. The defenders come back 12 to 22 m from it.
   */
  truckMin: 120,
  /** ms the spawn truck must stand still (nobody at the wheel, not moved) before it is a start place */
  truckStillMs: 2000,
  /**
   * ms a destroyed spawn truck is gone after its wreck before it is back whole at its camp: 60 s in all with the wreck's
   * own 20 s (shared/vehicleDamage.json wreckMs)
   */
  truckGoneMs: 40_000,
  /** m across from a crate's middle to a player's middle, and m up or down, for a take (a step more than the page's prompt) */
  reach: 2.4,
  rise: 1.8,
  /**
   * m from a vehicle's box (the parked helicopter, the spawn truck, the camp's supply truck) for ammo from it. Further
   * than a seat's reach (car.json and heli.json reach, 1.5 m): close by, Use gets you in; a step back, it gives ammo.
   */
  vehicleReach: 3,
  /** ms each player waits between two of a kind: ammo and grenades, the first-aid kit and the vest, a heavy weapon, a claymore or the turret */
  wait: Object.freeze({ ammo: 20_000, med: 60_000, heavy: 30_000, trap: 20_000 }),
  /** Heavy weapons (a bazooka or a sniper rifle) a team holds at most at once */
  heavyMax: 2,
  /** ms after a heavy weapon's holder went down, left or ran out before its place is free again */
  heavyBackMs: 20_000,
  /** Rockets in a bazooka from the crate */
  rockets: 3,
  /** Claymores the defenders take from their crate in a round, all together; and per take */
  claymoresRound: 6,
  claymoresTake: 2,
  /** Turrets the defenders take in a round, all together */
  turretsRound: 2,
  /** A turret against players: m it sees, ms between shots, health a hit takes, rounds in it, the chance a shot misses */
  turretRange: 16,
  turretEvery: 400,
  turretDamage: 8,
  turretRounds: 80,
  turretMiss: 0.35,
  /** A claymore against players: m of its blast in front, the health it takes at its foot (half that at the edge) */
  mineBlast: 4.5,
  mineDamage: 85,
  /** ms the server waits between two supply messages of one player (on top of the message guard) */
  rateMs: 300,
});

/** What a crate gives, by its kind: ammo and grenades, a first-aid kit and a vest, a heavy weapon, a defender's trap. */
export const CRATE_KINDS = Object.freeze(['ammo', 'med', 'bazooka', 'sniper', 'claymore', 'turret']);
/** The wait (ASSAULT.wait) a kind counts against. */
export const WAIT_OF = Object.freeze({ ammo: 'ammo', med: 'med', bazooka: 'heavy', sniper: 'heavy', claymore: 'trap', turret: 'trap' });

/**
 * The camp, as offsets [across (to the right), along (to the front)] in metres from its flag, the front to the
 * defenders: two tents behind the flag, the supply truck (it gives ammo) between them, four crates in two pairs at the
 * front, four flood lamps at the corners, six start places round the flag; on the right the attackers' helicopter
 * (25 m off), the spawn truck's parking place (34 m) and the two cars (33 and 38 m).
 */
export const CAMP = Object.freeze({
  tents: [[-9, -5], [9, -5]],
  supply: [0, -7.5],
  crates: [['ammo', -6.6, 4], ['med', -5.2, 4], ['bazooka', 5.2, 4], ['sniper', 6.6, 4]],
  lamps: [[-13, -8], [13, -8], [-13, 6], [13, 6]],
  spawns: [[-4, -2.5], [4, -2.5], [-6.5, 0.5], [6.5, 0.5], [-2.5, 2], [2.5, 2]],
  heli: [25, -3],
  truck: [30, 16],
  cars: [[24, 23], [29, 24]],
});
/** The crates at the defenders' base, in a row from its first: who defends gets the traps too. */
export const BASE_CRATES = Object.freeze(['ammo', 'med', 'bazooka', 'sniper', 'claymore', 'turret']);

/** The spawn truck (a car of its own, built in code: src/world/truck.ts): its size and speeds, as shared/car.json's cars. */
export const TRUCK = Object.freeze({
  name: 'the spawn truck',
  model: 'proc:truck',
  length: 7.2,
  width: 2.5,
  height: 3.3,
  maxSpeed: 22,
  reverseSpeed: 5,
  metal: 0.2,
});
/** A spawn truck's kinds, one in each team's colour (shared/flagFields.mjs FLAG_COLORS; never in car.json's placed kinds: nobody spawns one). */
export const TRUCK_KINDS = Object.freeze(['truck-blue', 'truck-red']);
/** The spawn truck's size and speeds for a car of `kind`, or null: one of TRUCK_KINDS. */
export function truckSpec(kind) {
  return TRUCK_KINDS.includes(kind) ? TRUCK : null;
}

const r2 = (v) => Math.round(v * 100) / 100;
/** The game's yaw for a nose pointing along (fx, fz) (shared/car.json: a nose along -z at 0). */
const yawOf = (fx, fz) => Math.round(Math.atan2(-fx, -fz) * 10000) / 10000;

/**
 * A camp at its flag (x, z), its front along (fx, fz) (to the defenders), each of its things on the ground the page has
 * there: `ys`, by CAMP's names, a height or a list in CAMP's order (measured in the page: the church's meadow slopes a
 * metre across the camp, the Sparrenhof's is flat).
 */
function camp(x, z, [fx, fz], ys) {
  const n = Math.hypot(fx, fz);
  [fx, fz] = [fx / n, fz / n];
  const rx = fz, rz = -fx; // to the right
  const y = (key, i = 0) => (Array.isArray(ys[key]) ? ys[key][i] : ys[key]);
  const at = ([a, b], h) => [r2(x + rx * a + fx * b), r2(z + rz * a + fz * b), h];
  return {
    flag: [x, z, ys.flag],
    /** The game's yaw facing the front, and facing along the camp (the supply truck and the tents) */
    yaw: yawOf(fx, fz),
    side: yawOf(rx, rz),
    tents: CAMP.tents.map((o, i) => at(o, y('tents', i))),
    supply: at(CAMP.supply, y('supply')),
    crates: CAMP.crates.map(([kind, a, b], i) => ({ kind, at: at([a, b], y('crates', i)) })),
    lamps: CAMP.lamps.map((o, i) => at(o, y('lamps', i))),
    spawns: CAMP.spawns.map((o, i) => at(o, y('spawns', i))),
    heli: at(CAMP.heli, y('heli')),
    truck: at(CAMP.truck, y('truck')),
    cars: CAMP.cars.map((o, i) => at(o, y('cars', i))),
  };
}

/** The church square as in Steal the flag (shared/flagFields.mjs CHURCH): stand, start places, rack. */
const CHURCH = {
  stand: [528.1, -765.4, 4.89],
  spawns: [[509.0, -776.5, 4.60], [512.5, -775.0, 4.65], [512.0, -779.5, 4.59], [515.5, -777.5, 4.63], [519.0, -779.5, 4.70], [521.5, -776.5, 4.67]],
  rack: [523.86, -761.16, 5.09, -0.785],
};
/** The Sparrenhof as in Steal the flag (shared/flagFields.mjs SPARRENHOF). */
const SPARRENHOF = {
  stand: [639.5, 946.5, -7.02],
  spawns: [[638.0, 958.5, -7.14], [636.0, 961.5, -7.18], [647.0, 962.5, -6.96], [637.5, 964.5, -7.12], [636.5, 967.5, -7.10], [641.5, 968.5, -6.99]],
  rack: [645.5, 946.5, -7.01, 1.5708],
};
/** The church's camp: its front to the church's stand (east). */
const CHURCH_CAMP = camp(138, -859, [CHURCH.stand[0] - 138, CHURCH.stand[1] + 859], {
  flag: 1.38, tents: [1.78, 1.11], supply: 1.39, crates: [1.6, 1.53, 1.19, 1.13], lamps: [1.94, 0.98, 1.94, 0.91],
  spawns: [1.56, 1.28, 1.7, 1.19, 1.43, 1.31], heli: 0.66, truck: 0.51, cars: [0.65, 0.57],
});
/**
 * The Sparrenhof's camp: its front to the north (the stand is 18 degrees west of it): the field it stands in runs east to
 * west, between a fence and a hedge.
 */
const SPARRENHOF_CAMP = camp(770, 558, [0, 1], {
  flag: -3.56, tents: [-3.37, -3.58], supply: -3.48, crates: [-3.51, -3.53, -3.58, -3.58], lamps: [-3.46, -3.65, -3.42, -3.55],
  spawns: [-3.51, -3.52, -3.51, -3.55, -3.59, -3.54], heli: -3.8, truck: -3.8, cars: [-3.72, -3.69],
});

/** A camp as a Steal the flag base: its flag the stand, its start places; its bazooka crate where a rack would be. */
const campBase = (c) => ({ stand: c.flag, spawns: c.spawns, rack: [...c.crates.find((k) => k.kind === 'bazooka').at, c.yaw] });
/** The defenders' crates: BASE_CRATES from (x, z), each `dx`, `dz` further, on the ground `y`. */
const row = (x, z, y, dx, dz) => BASE_CRATES.map((kind, i) => ({ kind, at: [r2(x + dx * i), r2(z + dz * i), y] }));
/** A camp's vehicles: the spawn truck first (its id `fr1`), then the two cars, in the attackers' colour (server/assault.mjs paints them). */
const campCars = (c) => [
  { kind: 'truck-red', x: c.truck[0], y: c.truck[2], z: c.truck[1], yaw: c.yaw },
  ...c.cars.map(([x, z, y]) => ({ kind: 'modelY-red', x, y, z, yaw: c.yaw })),
];
const campHeli = (c, id) => ({ id, x: c.heli[0], y: c.heli[2], z: c.heli[1], yaw: c.side });

/**
 * The fields: each the Steal the flag shape (bases, heli, vehicles, off) and `assault`: the camp (above), the spawn
 * truck's car id, and the defenders' crates in a row between their stand and their start places (open paving, 1.2 m
 * apart).
 */
export const ASSAULT_FIELDS = {
  assaultChurch: {
    id: 'assaultChurch',
    /** Where the defenders are (src/i18n.ts portal.*) */
    red: 'church',
    bases: { blue: CHURCH, red: campBase(CHURCH_CAMP) },
    edge: null,
    // The defenders' helicopter the church's own, where Steal the flag sets it down; the attackers' the house's, beside
    // the camp, its nose along it.
    heli: { blue: { id: 'church', x: 489.9, y: 4.72, z: -761.4, yaw: -1.5708 }, red: campHeli(CHURCH_CAMP, 'house') },
    vehicles: {
      // Two of Steal the flag's on the square's marked bays.
      blue: { cars: [{ kind: 'modelY-blue', x: 535.5, y: 5.37, z: -753.0, yaw: 1.5708 }, { kind: 'modelY-blue', x: 535.5, y: 5.27, z: -755.6, yaw: 1.5708 }], bikes: [] },
      red: { cars: campCars(CHURCH_CAMP), bikes: [] },
    },
    off: { cars: ['churchY', 'church3'], bikes: ['church1', 'church2', 'church3'] },
    assault: { camp: CHURCH_CAMP, truck: 'fr1', crates: row(512, -771, 4.76, 1.2, 0) },
  },
  assaultSparrenhof: {
    id: 'assaultSparrenhof',
    red: 'sparrenhof',
    bases: { blue: SPARRENHOF, red: campBase(SPARRENHOF_CAMP) },
    edge: null,
    // The defenders' helicopter the house's, where Steal the flag sets it down across the road from the café; the
    // attackers' the church's, beside the camp.
    heli: { blue: { id: 'house', x: 613.0, y: -7.3, z: 944.0, yaw: -1.5708 }, red: campHeli(SPARRENHOF_CAMP, 'church') },
    vehicles: {
      // Two of Steal the flag's on the forecourt's south part.
      blue: { cars: [{ kind: 'modelY-blue', x: 651.4, y: -7.03, z: 945.0, yaw: -0.4615 }, { kind: 'modelY-blue', x: 654.5, y: -6.76, z: 939.1, yaw: -0.4615 }], bikes: [] },
      red: { cars: campCars(SPARRENHOF_CAMP), bikes: [] },
    },
    off: { cars: ['churchY', 'church3'], bikes: ['sparrenhof1', 'sparrenhof2'] },
    assault: { camp: SPARRENHOF_CAMP, truck: 'fr1', crates: row(641.5, 954, -7.0, 1.2, 0) },
  },
};

/** The two rounds' fields, in order: the church first, then the Sparrenhof. */
export const ROUND_FIELDS = Object.freeze(['assaultChurch', 'assaultSparrenhof']);

/**
 * How far the flag at (x, z) got from the defenders' stand towards the camp's flag on `field`: 0 at the stand (or further
 * from the camp than the stand is), 1 at the camp. Straight lines: the same measure in both fields.
 */
export function progressOf(field, x, z) {
  const [sx, sz] = field.bases.blue.stand;
  const [cx, cz] = field.assault.camp.flag;
  const whole = Math.hypot(cx - sx, cz - sz);
  const left = Math.hypot(cx - x, cz - z);
  return Math.max(0, Math.min(1, 1 - left / whole));
}
