/**
 * Tints in our models' glTF extras that the game draws otherwise (main.ts gameTextures), without a new export of the
 * model: an export from Blender would lose the light layout and the bake the model carries. Each is changed only
 * while the model still has the tint named here; a model exported anew with a tint of its own keeps that one.
 *
 * - school_yard (tools/school.py): the playground's concrete was the terrace's slabs at #e3e1db, near white in the
 *   sun (about 85% brightness on the screen on a sunny day). Sunlit concrete reads at about two thirds, with its
 *   joints and aggregate showing.
 */
const TINTS: Record<string, [from: string, to: string]> = {
  school_yard: ['#e3e1db', '#a19e97'],
};

/** The tint a model's material `name` is drawn with, given the tint its extras name. */
export function modelTint(name: string, tint: string): string {
  const t = TINTS[name];
  return t && t[0] === tint.toLowerCase() ? t[1] : tint;
}
