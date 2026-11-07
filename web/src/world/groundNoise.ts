import * as THREE from 'three';

/**
 * A small seamless tile of soft noise (128 px, one channel), made once at the start (nothing to download),
 * for the ground covers' patches: the yards' wear (world/yards.ts) and the woods' floor (world/fields.ts).
 * Three octaves of smoothed random values on a wrapping grid.
 */

const SIZE = 128;
let tile: THREE.DataTexture | null = null;

export function groundNoise(): THREE.DataTexture {
  if (tile) return tile;
  let s = 7717;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = new Float32Array(SIZE * SIZE);
  let weight = 0;
  for (const [cells, amp] of [[4, 0.5], [8, 0.3], [16, 0.2]] as const) {
    const grid = Array.from({ length: cells * cells }, rand);
    const at = (i: number, j: number) => grid[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const fx = (x / SIZE) * cells;
        const fy = (y / SIZE) * cells;
        const i = Math.floor(fx);
        const j = Math.floor(fy);
        const u = fx - i;
        const v = fy - j;
        const su = u * u * (3 - 2 * u);
        const sv = v * v * (3 - 2 * v);
        const top = at(i, j) + (at(i + 1, j) - at(i, j)) * su;
        const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * su;
        out[y * SIZE + x] += (top + (bottom - top) * sv) * amp;
      }
    }
    weight += amp;
  }
  // Stretched to the full range, so a threshold in a shader means the same share of the ground everywhere.
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of out) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const data = new Uint8Array(SIZE * SIZE);
  for (let k = 0; k < data.length; k++) data[k] = Math.round(((out[k] - lo) / (hi - lo || weight)) * 255);
  tile = new THREE.DataTexture(data, SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
  tile.magFilter = THREE.LinearFilter;
  tile.minFilter = THREE.LinearMipmapLinearFilter;
  tile.generateMipmaps = true;
  tile.needsUpdate = true;
  return tile;
}
