// The relief of the surroundings (tools/terrain.py writes terrain.json): heights in metres above
// or below the model's flat ground, on a grid every `step` metres, nx points along x and nz
// along z. Between the grid points the ground is two flat triangles per square, split along the
// diagonal from the square's lowest x and z corner; the browser draws it so, and this gives
// exactly that surface (shared by the browser and the server, the same formula as tools/terrain.py).

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ESCAPE = '~';
const BIAS = 1 << 17;

/**
 * The heights in whole centimetres from the string `d` (tools/terrain.py, `encode`): each point
 * is what is left over after guessing it from the one before it, the one above and the one
 * above that one, one character for -32 to 31 cm, or `~` and three characters.
 */
function decode(d, nx, nz) {
  const value = new Int8Array(128);
  for (let k = 0; k < DIGITS.length; k++) value[DIGITS.charCodeAt(k)] = k;
  const cm = new Int32Array(nx * nz);
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let r;
      if (d[k] === ESCAPE) {
        r = ((value[d.charCodeAt(k + 1)] << 12) | (value[d.charCodeAt(k + 2)] << 6) | value[d.charCodeAt(k + 3)]) - BIAS;
        k += 4;
      } else {
        r = value[d.charCodeAt(k)] - 32;
        k += 1;
      }
      const at = j * nx + i;
      const guess = i && j ? cm[at - 1] + cm[at - nx] - cm[at - nx - 1] : i ? cm[at - 1] : j ? cm[at - nx] : 0;
      cm[at] = guess + r;
    }
  }
  return cm;
}

/** A height function for the grid data: (x, z) -> metres relative to the flat ground. */
export function makeTerrain(data) {
  const { x0, z0, step, nx, nz } = data;
  const cm = decode(data.d, nx, nz);
  const at = (i, j) => cm[j * nx + i] / 100;
  const height = (x, z) => {
    const fx = Math.min(Math.max((x - x0) / step, 0), nx - 1.000001);
    const fz = Math.min(Math.max((z - z0) / step, 0), nz - 1.000001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h00 = at(i, j);
    const h11 = at(i + 1, j + 1);
    if (u >= v) {
      const h10 = at(i + 1, j);
      return h00 + u * (h10 - h00) + v * (h11 - h10);
    }
    const h01 = at(i, j + 1);
    return h00 + v * (h01 - h00) + u * (h11 - h01);
  };
  return { x0, z0, step, nx, nz, at, height };
}
