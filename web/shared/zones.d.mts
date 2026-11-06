export interface Zone {
  id: string;
  /** The outline, game metres [x, z] */
  poly: [number, number][];
}
export const NO_SHOOT: Zone[];
/** The no-shooting zone at (x, z), or null. */
export function noShoot(x: number, z: number): Zone | null;
