/**
 * The made-up details of each open-data house (world/houseTrim.ts and world/surroundings.ts build them): the colour of
 * its trim, whether it has a chimney, a plinth, lintels, shutters or roller shutters, and how they look. The open data
 * gives only outlines, heights and openings, so all of this is chosen by the house's key (world/facadeLook.ts `Houses`),
 * which comes from where the house stands in the model: every player sees the same house on every visit, and nothing
 * is a real house's look. One object per house, so its parts agree.
 *
 * The shares and colours below are Yoshi's to tune. Colours are sRGB hex. No imports, so node can test it
 * (houseStyle.test.mjs).
 */

// Trim (verge boards, flat roofs' edges, dormers): white, anthracite, brown, zinc. The shares add up to 1.
const TRIM: [string, number][] = [['#f1efe9', 0.45], ['#3a3c3f', 0.25], ['#4c3427', 0.15], ['#8f9396', 0.15]];

/** Of the houses with a gable or hip roof that can carry one, the share with a brick chimney on the ridge. */
export const CHIMNEY_SHARE = 0.6;
/** Of the chimneys, the share with one or two clay pots on top. */
export const CHIMNEY_POTS = 1 / 3;

// Plinths on brick houses: dark grey paint, grey cement, the same brick darker; the rest has none (a plain wall).
export const PLINTH_PAINT = 0.3;
export const PLINTH_CEMENT = 0.2;
export const PLINTH_BRICK = 0.25;
/** Plinths on rendered and white houses: tarred, a dark grey; the rest has none (a plain wall). */
export const PLINTH_TAR = 0.5;
const PAINT = '#343332';
const CEMENT = '#8f8c86';
const TAR = '#4b4845';
/** A brick plinth: the wall's own tint times this. */
export const PLINTH_BRICK_SHADE = 0.7;

// Lintels over the openings of brick houses: pale stone, a soldier course of the wall's brick; the rest has none.
export const LINTEL_STONE = 0.3;
export const LINTEL_SOLDIER = 0.3;
/** Lintels over the openings of rendered and white houses: pale stone; the rest has none. */
export const LINTEL_STONE_RENDERED = 0.2;

/** Of the houses with a pitched roof, the share with leaf shutters beside the ground floor's windows. */
export const LEAF_SHUTTERS = 0.08;
const LEAF_COLOURS = ['#2f4a3a', '#5a3d2b', '#6e2a24', '#efede6'];

/** Of the houses without leaf shutters, the share with roller shutters (drawn only where one is down). */
export const ROLLER_HOUSES = 0.33;
/** Of those houses' windows, the share with the shutter fully down, and the share with it partly down (30 to 70 %). */
export const ROLLER_DOWN = 0.05;
export const ROLLER_PART = 0.08;
const ROLLER_COLOURS = ['#ece9e2', '#d8ccb4', '#8c8f92', '#5b4535'];

/** Of the houses with a flat roof, the share with an edge trim round it in the house's trim colour. */
export const FLAT_EDGE = 0.6;

/** Of the village's gable roofs, the share with solar panels on the slope facing south. */
export const SOLAR_SHARE = 0.2;
/** Of the houses with rooms under the roof (3 m or more from eaves to ridge), the share with one or two roof windows. */
export const ROOF_WINDOWS = 0.25;
/** Of the houses with a dormer-worthy roof, the share with a dormer. */
export const DORMER_SHARE = 1 / 9;

// Flat roofs: the covering seen from above (gravel on bitumen, bare bitumen with its grit, a grey membrane; shares add
// up to 1), a low brick parapet round the free sides instead of the edge trim, a dome rooflight on a big enough one.
const FLAT_FINISH: [string, number][] = [['#8c867b', 0.45], ['#3d3b39', 0.4], ['#5f6163', 0.15]];
export const PARAPET_SHARE = 0.25;
export const DOME_SHARE = 0.3;

// By the front door: a wall lamp beside it (lit at night on most), a letterbox in the door, flower pots, a bench.
export const PORCH_LIGHT = 0.6;
/** Of the porch lights, the share switched on at night. */
export const PORCH_LIT = 0.75;
export const LETTERBOX = 0.7;
export const DOOR_POTS = 0.3;
export const DOOR_BENCH = 0.08;
// On the roof: a satellite dish (on a wall bracket under the eaves) or an old TV aerial by the chimney.
export const DISH_SHARE = 0.07;
export const AERIAL_SHARE = 0.12;

/** A number from 0 to 1 that depends only on the numbers given: the same as world/facadeLook.ts `stable`. */
export function stable(...v: number[]): number {
  let h = 2166136261;
  for (const x of v) h = Math.imul(h ^ Math.round(x * 1000), 16777619) ^ (h >>> 13);
  return ((h >>> 0) % 100003) / 100003;
}

export type PlinthKind = 'paint' | 'cement' | 'brick' | 'tar' | 'none';

export interface HouseStyle {
  /** Verge boards and edges (sRGB hex) */
  trim: string;
  /** A chimney on the ridge, or none: which end (0 at the ridge's start, 1 at its end), metres from that gable end, its size along and across the ridge, its rise above the ridge, its pots (0 to 2) */
  chimney: { end: 0 | 1; from: number; along: number; across: number; rise: number; pots: number } | null;
  /** The plinth: its kind, its colour (sRGB hex; null for the wall's own brick, darker), whether it is rendered, its height above the highest ground round the house */
  plinth: { kind: PlinthKind; colour: string | null; render: boolean; height: number };
  /** Lintels over the openings */
  lintel: 'stone' | 'soldier' | 'none';
  /** Leaf shutters' colour (sRGB hex), or none */
  shutters: string | null;
  /** Roller shutters' colour (sRGB hex), or none */
  rollers: string | null;
  /** An edge trim round its flat roofs */
  flatEdge: boolean;
  /** Solar panels on a slope facing south: how many panels across (4 to 8), or none */
  solar: number;
  /** Roof windows (0 to 2) on a roof with rooms under it */
  roofWindows: number;
  /** A dormer over the front door (change 7) */
  dormer: boolean;
  /** Its flat roofs: the covering's colour (sRGB hex), a brick parapet instead of the trim, a dome rooflight */
  flat: { finish: string; parapet: boolean; dome: boolean };
  /** By its front doors: a wall lamp (and whether it is on at night), a letterbox, flower pots, a bench */
  door: { lamp: boolean; lit: boolean; letterbox: boolean; pots: boolean; bench: boolean };
  /** On its roof: a satellite dish, an old TV aerial */
  dish: boolean;
  aerial: boolean;
}

/** Pick from a list of [value, share] by h (0 to 1). */
function share<T>(list: [T, number][], h: number): T {
  let sum = 0;
  for (const [v, s] of list) {
    sum += s;
    if (h < sum) return v;
  }
  return list[list.length - 1][0];
}

/**
 * The style of the house with key `key` (0 to 1), its brick `brick` (nb_red and so on) and whether its walls are
 * rendered. `pitched`: whether it has a pitched roof (leaf shutters go only on those).
 */
export function houseStyle(key: number, brick: string, rendered: boolean, pitched = true): HouseStyle {
  const pale = rendered || brick === 'nb_white';
  const trim = share(TRIM, stable(key, 41));
  const c = stable(key, 43);
  const chimney = c < CHIMNEY_SHARE
    ? {
      end: (stable(key, 43, 1) < 0.5 ? 0 : 1) as 0 | 1,
      from: 0.9 + 0.7 * stable(key, 43, 2),
      along: 0.45 + 0.15 * stable(key, 43, 3),
      across: 0.6 + 0.3 * stable(key, 43, 4),
      rise: 0.7 + 0.4 * stable(key, 43, 5),
      pots: stable(key, 43, 6) < CHIMNEY_POTS ? (stable(key, 43, 7) < 0.5 ? 1 : 2) : 0,
    }
    : null;
  const p = stable(key, 47);
  const kind: PlinthKind = pale
    ? (p < PLINTH_TAR ? 'tar' : 'none')
    : share<PlinthKind>([['paint', PLINTH_PAINT], ['cement', PLINTH_CEMENT], ['brick', PLINTH_BRICK], ['none', 1]], p);
  const plinth = {
    kind,
    colour: kind === 'paint' ? PAINT : kind === 'cement' ? CEMENT : kind === 'tar' ? TAR : null,
    render: kind === 'paint' || kind === 'cement' || kind === 'tar',
    height: 0.35 + 0.35 * stable(key, 47, 1),
  };
  const l = stable(key, 53);
  const lintel = pale
    ? (l < LINTEL_STONE_RENDERED ? 'stone' : 'none')
    : share<'stone' | 'soldier' | 'none'>([['stone', LINTEL_STONE], ['soldier', LINTEL_SOLDIER], ['none', 1]], l);
  const s = stable(key, 59);
  const shutters = pitched && s < LEAF_SHUTTERS ? LEAF_COLOURS[Math.floor(stable(key, 59, 1) * LEAF_COLOURS.length)] : null;
  const rollers = !shutters && stable(key, 61) < ROLLER_HOUSES ? ROLLER_COLOURS[Math.floor(stable(key, 61, 1) * ROLLER_COLOURS.length)] : null;
  return {
    trim,
    chimney,
    plinth,
    lintel,
    shutters,
    rollers,
    flatEdge: stable(key, 73) < FLAT_EDGE,
    solar: stable(key, 67) < SOLAR_SHARE ? 4 + Math.floor(stable(key, 67, 1) * 5) : 0,
    roofWindows: stable(key, 69) < ROOF_WINDOWS ? 1 + Math.floor(stable(key, 69, 1) * 2) : 0,
    dormer: stable(key, 71) < DORMER_SHARE,
    flat: { finish: share(FLAT_FINISH, stable(key, 83)), parapet: stable(key, 83, 1) < PARAPET_SHARE, dome: stable(key, 83, 2) < DOME_SHARE },
    door: {
      lamp: stable(key, 89) < PORCH_LIGHT,
      lit: stable(key, 89, 1) < PORCH_LIT,
      letterbox: stable(key, 89, 2) < LETTERBOX,
      pots: stable(key, 89, 3) < DOOR_POTS,
      bench: stable(key, 89, 4) < DOOR_BENCH,
    },
    dish: stable(key, 97) < DISH_SHARE,
    aerial: stable(key, 97, 1) < AERIAL_SHARE,
  };
}

// ---- The roof's covering: which tile ----

/** The tiles' kinds (world/roofRelief.ts draws their relief): clay pantiles, flat interlocking tiles, slate, concrete tiles. */
export type TileKind = 'pantile' | 'flat' | 'slate' | 'concrete';

/**
 * Which tile a roof is covered with, from its look (world/facadeLook.ts `roofLook`): `gloss` 1 for glazed tiles, about
 * 0.7 for slate; `warm` whether its colour is a clay red or brown. Clay roofs are mostly pantiles (the old Boom pantile
 * and its kin), some flat clay tiles; glazed black ones half flat tiles (newer houses); matt dark ones concrete or flat
 * tiles; the rest pantiles, concrete or flat ones. Fixed by the house's key.
 */
export function roofTile(key: number, gloss: number, warm: boolean): TileKind {
  const h = stable(key, 79);
  if (gloss > 0.5 && gloss < 0.9) return 'slate';
  if (warm) return h < 0.75 ? 'pantile' : 'flat';
  if (gloss >= 0.9) return h < 0.45 ? 'pantile' : 'flat';
  return share<TileKind>([['pantile', 0.5], ['concrete', 0.3], ['flat', 0.2]], h);
}

// Doors and garage doors (world/surroundings.ts). tools/facades.py makes up the colour of an outbuilding's garage door
// (2.15 m high or less) from these three; a garage door seen from the road keeps the colour that was seen.
export const GARAGE_MADE_UP = ['#ece8df', '#3a3c3f', '#7a5a3e'];
/** RAL 7016, anthracite: a dark blue-grey, the darkest a door is painted here (never black). */
export const ANTHRACITE = '#383e42';
const WHITE_DOOR = '#ece8df';
const WOOD_DOOR = '#7a5a3e';

/** An sRGB hex colour in linear light, 0 to 1 a channel. */
function linear(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const c = (x: number) => (x / 255 <= 0.04045 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4);
  return [c((v >> 16) & 255), c((v >> 8) & 255), c(v & 255)];
}

/** Linear light back to sRGB hex. */
function hex(rgb: [number, number, number]): string {
  const c = (x: number) => Math.round(255 * Math.min(1, x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055));
  return `#${rgb.map((x) => c(x).toString(16).padStart(2, '0')).join('')}`;
}

/** How light a colour is (its relative luminance, 0 to 1). */
export function luminance(colour: string): number {
  const [r, g, b] = linear(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A door's colour as drawn: one darker than anthracite lifted to anthracite's lightness, keeping its hue. */
export function doorColour(colour: string): string {
  const l = luminance(colour);
  const floor = luminance(ANTHRACITE);
  if (l >= floor) return colour.toLowerCase();
  if (l < floor / 10) return ANTHRACITE; // black, or nearly: no hue to keep
  const k = floor / l;
  const [r, g, b] = linear(colour);
  return hex([r * k, g * k, b * k]);
}

/** A made-up garage door's colour, agreeing with its frame: white with a pale frame, wood with a brown one, else anthracite. */
export function garageColour(frame: string): string {
  const [r, , b] = linear(frame);
  if (luminance(frame) > 0.4) return WHITE_DOOR;
  return r > 1.4 * b ? WOOD_DOOR : ANTHRACITE;
}

/**
 * How far a window's roller shutter is down (0 up, 1 fully down), by the window's own place (x, y, z in the model),
 * on a house that has roller shutters.
 */
export function rollerDown(x: number, y: number, z: number): number {
  const h = stable(x, y, z, 61);
  if (h < ROLLER_DOWN) return 1;
  if (h < ROLLER_DOWN + ROLLER_PART) return 0.3 + 0.4 * stable(x, y, z, 62);
  return 0;
}
