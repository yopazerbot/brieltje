// The homes' data in two parts: the public shell (src/data/house_shell.json, molenhoek_end_shell.json) and the private
// inside (web/.private/house_inside.json, molenhoek_end_inside.json, opened by server/privateData.mjs). This module puts
// them together and cuts out one home's inside for the page. It holds no data of its own.
//
// An inside "pack" is one home's inside, as the unlock call and GET /api/home/:id/inside answer it:
//   { id, prisms, rooms?, doors, fixtures, props, panels?, names?, replaces? } for the main house and the bungalow, and
//   the end house's whole inside file (without its source note) for 'molenhoek_end'.
// `replaces`: keys (`k`) of shell blocks the pack's own blocks stand in for (a holed slab for a solid one).

/** The home ids that have a pack. */
export const PACK_IDS = ['house', 'bungalow', 'molenhoek_end'];

/**
 * One home's pack from the inside files (`inside`: house_inside.json, `end`: molenhoek_end_inside.json; either may be
 * null), or null when its inside is not there.
 */
export function packOf(id, inside, end) {
  if (id === 'molenhoek_end') {
    if (!end) return null;
    const { _source, ...rest } = end; // the note about where it was made stays on the server
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
