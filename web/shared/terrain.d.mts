export interface TerrainData {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  /** Heights in whole centimetres, encoded (tools/terrain.py) */
  d: string;
}

export interface Terrain {
  x0: number;
  z0: number;
  step: number;
  /** Grid points along x */
  nx: number;
  /** Grid points along z */
  nz: number;
  /** Height (m) at grid point i (along x), j (along z) */
  at(i: number, j: number): number;
  /** Height (m) above or below the model's flat ground at (x, z) */
  height(x: number, z: number): number;
}

export function makeTerrain(data: TerrainData): Terrain;
