// The homes' data in two parts: the public shell (src/data/house_shell.json and the walked-into houses' shells) and the
// private inside (web/.private/house_inside.json and the walked-into houses' files, WALK_IN_FILES, opened by
// server/privateData.mjs). This module puts them together and cuts out one home's inside for the page. It holds no data of
// its own.
//
// An inside "pack" is one home's inside, as the unlock call and GET /api/home/:id/inside answer it:
//   { id, prisms, rooms?, doors, fixtures, props, panels?, names?, replaces? } for the main house and the bungalow, and
//   a walked-into house's whole inside file (without its source note) for the others.
// `replaces`: keys (`k`) of shell blocks the pack's own blocks stand in for (a holed slab for a solid one).

/** The houses walked into (src/world/walkIn.ts): each one's inside file in the private data. */
export const WALK_IN_FILES = { molenhoek_end: 'molenhoek_end_inside.json', kapellenhoek_home: 'kapellenhoek_home_inside.json' };

/** The home ids that have a pack. */
export const PACK_IDS = ['house', 'bungalow', ...Object.keys(WALK_IN_FILES)];

/**
 * One home's pack from the inside files (`inside`: house_inside.json; `walkIns`: { [id]: that house's inside file };
 * any may be null or missing), or null when its inside is not there.
 */
export function packOf(id, inside, walkIns) {
  if (Object.hasOwn(WALK_IN_FILES, id)) {
    const file = walkIns?.[id];
    if (!file) return null;
    const { _source, ...rest } = file; // the note about where it was made stays on the server
    return { id, ...rest };
  }
  const part = id === 'house' || id === 'bungalow' ? inside?.[id] : null;
  if (!part) return null;
  const { innerFace, roofPanels, ...rest } = part; // innerFace only checks the split; roofPanels are `panels`
  return { id, ...rest, ...(roofPanels ? { panels: roofPanels } : {}) };
}

/**
 * The shell with the insides of the main house and the bungalow added (the server's data, and the tests'): the blocks the
 * packs replace leave the shell, the packs' blocks, doors, rooms, props and fixtures come after. `packs`: those that
 * are there (null entries are skipped). Without packs it is the shell with empty rooms and fixtures.
 */
export function mergeHouse(shell, packs) {
  const list = (packs ?? []).filter(Boolean);
  const replaced = new Set(list.flatMap((p) => p.replaces ?? []));
  return {
    ...shell,
    prisms: [...shell.prisms.filter((p) => !(p.k && replaced.has(p.k))), ...list.flatMap((p) => p.prisms ?? [])],
    doors: [...shell.doors, ...list.flatMap((p) => p.doors ?? [])],
    rooms: list.flatMap((p) => p.rooms ?? []),
    props: [...(shell.props ?? []), ...list.flatMap((p) => p.props ?? [])],
    fixtures: list.flatMap((p) => p.fixtures ?? []),
  };
}
