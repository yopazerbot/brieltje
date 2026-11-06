// The insides of the three locked homes, from the private data (server/privateData.mjs), for the game server and the
// unlock call. Without them (no key, a plain clone, CI) the homes have a shell only: no inside, so nothing to walk in, and
// they stay locked. That is logged once, without a name of any file.
//
// Nothing here goes to a page except through `pack` (the unlock call and GET /api/home/:id/inside, checked for the right
// there) and `furniture` of the layout (the game server filters it per recipient).
import { privateData } from './privateData.mjs';
import { PACK_IDS, packOf } from '../shared/insideData.mjs';
import { homeAt } from '../shared/homes.mjs';

function readJson(name) {
  const b = privateData.get(name);
  if (!b) return null;
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    console.log(JSON.stringify({ event: 'private-data-unreadable' })); // never the name or the contents
    return null;
  }
}

const inside = readJson('house_inside.json');
const endInside = readJson('molenhoek_end_inside.json');

/** The starting layout of the furniture ({ version, restore, pieces: [item, x, y, z, yaw][] }), or null. */
const extras = readJson('extras.json'); // { layout, spawns, pickups }
export const defaultLayout = extras?.layout ?? null;

/**
 * home id -> its pack (only the homes whose inside is there). A pack also carries the starting pieces of its home (for a
 * page playing alone, which keeps its furniture itself) and the layout's restore number.
 */
const PACKS = new Map(PACK_IDS.flatMap((id) => {
  const pack = packOf(id, inside, endInside);
  if (!pack) return [];
  const furniture = (defaultLayout?.pieces ?? []).filter(([, x, y, z]) => homeAt(x, z, y) === id);
  return [[id, { ...pack, furniture, layoutRestore: defaultLayout?.restore ?? 0 }]];
}));
if (PACKS.size < PACK_IDS.length) console.log(JSON.stringify({ event: 'insides-missing', have: PACKS.size, of: PACK_IDS.length }));

/** One home's pack, or null. */
export const packFor = (id) => PACKS.get(id) ?? null;
/** The packs of the main house and the bungalow, for the server's own house data (shared/insideData.mjs mergeHouse). */
export const housePacks = () => [PACKS.get('house'), PACKS.get('bungalow')].filter(Boolean);
