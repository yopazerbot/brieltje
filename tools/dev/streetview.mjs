// A Street View link for a spot in the game, to look at the real street there (a reference only: nothing from
// it goes into the repository, AGENTS.md "Assets").
//
//   node tools/dev/streetview.mjs 585,-317 [258,-363 ...] [--heading 60] [--pitch -40] [--fov 90]
//
// Each argument is a spot in the model's metres: x,z (briel.player.x and z, or web/shared/places.json). Street
// View opens at the nearest image, which names its street: check that it is the one you meant.
//
// The model's frame against Lambert 72 is rebuilt from two points the tools already name: the plot's middle
// (tools/streets.py PLOT) and the church (tools/neighbours.py CHURCH). The turn between the two frames is fitted to
// those by eye, good to a couple of degrees: about 30 m at the map's edge, well within Street View's snap.
const PLOT_L72 = [118911.0, 184981.0];
const PLOT_MODEL = [4.45, -3];
const TURN = (138.5 * Math.PI) / 180; // Lambert 72 -> the model's (x, -z)

function modelToLambert(x, z) {
  const vx = x - PLOT_MODEL[0];
  const vy = -(z - PLOT_MODEL[1]);
  const c = Math.cos(-TURN);
  const s = Math.sin(-TURN);
  return [PLOT_L72[0] + vx * c - vy * s, PLOT_L72[1] + vx * s + vy * c];
}

/** Belgian Lambert 72 to WGS84 latitude and longitude in degrees (a three-parameter datum shift: a few metres). */
function lambertToWgs(x, y) {
  const n = 0.77164219, F = 1.81329763, fudge = 0.00014204, e = 0.08199189, a = 6378388, x0 = 150000.01256, y0 = 5400088.4378, lon0 = 0.07604294;
  const dx = x - x0;
  const dy = y0 - y;
  const rho = Math.hypot(dx, dy);
  const lon = lon0 + (Math.atan(dx / dy) + fudge) / n;
  let lat = 0;
  for (let i = 0; i < 8; i++) lat = 2 * Math.atan(Math.pow((F * a) / rho, 1 / n) * Math.pow((1 + e * Math.sin(lat)) / (1 - e * Math.sin(lat)), e / 2)) - Math.PI / 2;
  // On the Hayford ellipsoid: to Earth-centred coordinates, shifted, and back on WGS84's.
  const f1 = 1 / 297;
  const e1 = 2 * f1 - f1 * f1;
  const N = a / Math.sqrt(1 - e1 * Math.sin(lat) ** 2);
  const X = N * Math.cos(lat) * Math.cos(lon) - 125.8;
  const Y = N * Math.cos(lat) * Math.sin(lon) + 79.9;
  const Z = N * (1 - e1) * Math.sin(lat) - 100.5;
  const a2 = 6378137;
  const f2 = 1 / 298.257223563;
  const e2 = 2 * f2 - f2 * f2;
  const p = Math.hypot(X, Y);
  let la = Math.atan2(Z, p * (1 - e2));
  for (let i = 0; i < 6; i++) la = Math.atan2(Z + e2 * (a2 / Math.sqrt(1 - e2 * Math.sin(la) ** 2)) * Math.sin(la), p);
  return [(la * 180) / Math.PI, (Math.atan2(Y, X) * 180) / Math.PI];
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const heading = flag('heading', '');
const pitch = flag('pitch', '');
const fov = flag('fov', '90');
if (!args.length) throw new Error('usage: node tools/dev/streetview.mjs x,z [x,z ...] [--heading 60] [--pitch -40] [--fov 90]');
for (const spot of args) {
  const [x, z] = spot.split(',').map(Number);
  const [lat, lon] = lambertToWgs(...modelToLambert(x, z));
  const view = `&fov=${fov}${heading ? `&heading=${heading}` : ''}${pitch ? `&pitch=${pitch}` : ''}`;
  console.log(`${spot}  https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}${view}`);
}
