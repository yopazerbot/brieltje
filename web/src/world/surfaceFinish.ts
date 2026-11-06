/** Keep small surface relief from reading as deep grooves across an entire street. */
const NORMAL_STRENGTH: Record<string, number> = {
  roof_tiles: 0.55,
  nb_brick: 0.65,
  gravel: 0.65,
  field: 0.5,
  grass: 0.45,
  pavers: 0.75,
  clinker: 0.7,
};

/** Authored material strengths take precedence; these are shared texture defaults. */
export const textureNormalScale = (texture: string): number => NORMAL_STRENGTH[texture] ?? 1;
