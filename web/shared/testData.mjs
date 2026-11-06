// The homes' data for the tests: the public shell, and the private inside when web/.private/ holds it (a development PC,
// not a cloud clone or CI). Tests that need the inside use `HAVE_PRIVATE` to skip with a message. Holds no data of its own.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerDoors } from './homes.mjs';
import { mergeHouse, packOf } from './insideData.mjs';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const privateFile = (name) => {
  const path = `${WEB}.private/${name}`;
  return existsSync(path) ? readJson(path) : null;
};

export const shell = readJson(`${WEB}src/data/house_shell.json`);
export const endShell = readJson(`${WEB}src/data/molenhoek_end_shell.json`);
export const inside = privateFile('house_inside.json');
export const endInside = privateFile('molenhoek_end_inside.json');
export const HAVE_PRIVATE = !!(inside && endInside);
export const SKIP = HAVE_PRIVATE ? false : 'web/.private/ is absent (cloud clone or CI): this check needs the private inside';

/** The packs as a page gets them. */
export const packs = ['house', 'bungalow', 'molenhoek_end'].map((id) => packOf(id, inside, endInside)).filter(Boolean);
for (const p of packs) registerDoors(p.id, p.doors.map((d) => d.id));

/** The shell with the main house's and the bungalow's insides (the server's house data). */
export const house = mergeHouse(shell, packs.filter((p) => p.id !== 'molenhoek_end'));
/** The end house: the shell, and its inside's doors, rooms and fixtures when there. */
export const end = { ...endShell, doors: [...endShell.doors, ...(endInside?.doors ?? [])], rooms: endInside?.rooms ?? [] };
/** What the private files hold besides the packs (spawns and pickups inside the homes). */
const extras = privateFile('extras.json');
export const spawnsInside = extras?.spawns ?? [];
export const pickupsInside = extras?.pickups ?? [];
