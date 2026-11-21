export type SmashKind = 'hedge' | 'fence' | 'sapling';

export interface SmashKindSpec {
  min: number;
  width: number;
  most: number;
  keep: number;
  lose: number;
}

export const SMASH: Record<SmashKind, SmashKindSpec> & {
  angle: number;
  reach: number;
  rate: number;
  burst: number;
  burstMs: number;
  cap: number;
  perPiece: number;
  mend: number;
  clear: number;
  late: number;
};
export const HOME_MARGIN: number;
export const FENCE_HIGH: number;
export const YOUNG: number;

export interface SmashPiece {
  /** null: two blocks share its key, never broken */
  kind: SmashKind | null;
  key: string;
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  half: number;
  thick: number;
  y0?: number;
  y1?: number;
  h?: number;
}

interface BlockLike {
  m: string;
  y0: number;
  y1: number;
  p: [number, number][][];
}

interface TreeLike {
  x: number;
  z: number;
  h: number;
}

export function nearHome(x: number, z: number): boolean;
export function blockKind(p: BlockLike): 'hedge' | 'fence' | null;
export function pieceKey(p: BlockLike): string;
export function treeKey(t: { x: number; z: number }): string;
export function smashPieces(sets: { prisms?: BlockLike[]; trees?: TreeLike[] }[]): SmashPiece[];
export function gapPoint(piece: SmashPiece, s: number): [number, number];
export function partRings(ring: [number, number][], piece: SmashPiece, gaps: { s: number; w: number }[]): [number, number][][];
export function gapWidth(piece: SmashPiece, yaw: number, halfL: number, halfW: number): number;
