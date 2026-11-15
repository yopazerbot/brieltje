// The helicopter's tuning sheet (web/shared/heli.mjs), in Node only: no browser, no game. It flies the shared flight
// model over flat ground (a ceiling 120 m up, as the game's) through set manoeuvres and prints what came out: the
// rotor's run-up and the lift-off, a hover held for 20 s (in still air and in a 4.5 m/s wind), a climb to 60 m and
// back, a dash to top speed and the stop, a full turn at 30 m/s, a landing from 30 m. Change a number in HELI, run
// this, compare.
//
//   node tools/dev/heliFly.mjs
import { HELI, heliFly, heliStart } from '../../web/shared/heli.mjs';

const DT = 1 / 60; // a frame, sub-stepped at 120 a second as in the game
const flat = (wind = [0, 0]) => ({ ground: () => 0, ceiling: 120, wind, edge: null, pad: null });
const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const r2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const deg = (v) => r1((v * 180) / Math.PI);

/** A machine at a hover `y` m up, rotor at speed, its height held. */
export function hovering(y) {
  const s = heliStart({ x: 0, y: 0, z: 0, yaw: 0 });
  Object.assign(s, { y, holdY: y, ground: false, engine: true, rotor: 1, coll: 0.5 });
  for (let i = 0; i < 300; i++) heliFly(s, {}, flat(), DT);
  s.ev = 0;
  return s;
}
/** Run up to `secs` with `input(s, t)` giving each frame's input; `each(s, t)` sees every frame and ends it with true. */
function run(s, secs, input, env, each) {
  for (let t = 0; t < secs; t += DT) {
    heliFly(s, input(s, t), env, DT);
    const stop = each?.(s, t);
    s.ev = 0;
    if (stop) return t + DT;
  }
  return secs;
}

const rows = [];
// The run-up and lift-off: on the ground, engine off, the up key held.
{
  const s = heliStart({ x: 0, y: 0, z: 0, yaw: 0 });
  let off = null, at5 = null;
  run(s, 20, () => ({ lift: 1 }), flat(), (q, t) => {
    if (off === null && q.y > 0.3) off = t;
    if (off !== null && q.y > 5) at5 = t;
    return at5 !== null;
  });
  rows.push(['run-up and lift-off', `airborne after ${r1(off)} s (rotor ${HELI.SPOOL_UP} s to full, lifts from ${HELI.LIFT_RPM}); 5 m up at ${r1(at5)} s`]);
}
// A hover for 20 s, hands off, in still air and in a 4.5 m/s wind (the most world/wind.ts blows).
for (const wind of [[0, 0], [4.5, 0]]) {
  const s = hovering(30);
  const x0 = s.x, z0 = s.z;
  let drift = 0, dy = 0, lean = 0;
  run(s, 20, () => ({}), flat(wind), (q) => {
    drift = Math.max(drift, Math.hypot(q.x - x0, q.z - z0));
    dy = Math.max(dy, Math.abs(q.y - 30));
    lean = Math.max(lean, Math.abs(q.roll), Math.abs(q.pitch));
  });
  rows.push([`hover 20 s, wind ${wind[0]} m/s`, `drift ${r2(drift)} m, height ${r2(dy)} m off, leaning ${deg(lean)} deg into it`]);
}
// A climb from 30 to 60 m on full up, and back down on full down.
{
  const s = hovering(30);
  let best = 0, sink = 0;
  const tUp = run(s, 40, () => ({ lift: 1 }), flat(), (q) => ((best = Math.max(best, q.vy)), q.y >= 60));
  const tDown = run(s, 40, () => ({ lift: -1 }), flat(), (q) => ((sink = Math.max(sink, -q.vy)), q.y <= 30));
  rows.push(['climb 30 to 60 m and back', `up in ${r1(tUp)} s (${r1(best)} m/s, cap ${HELI.CLIMB_MAX}); down in ${r1(tDown)} s (${r1(sink)} m/s)`]);
  // Letting go of up at the full climb, and of down at the full sink: how far it goes on before it holds.
  const on = [];
  for (const lift of [1, -1]) {
    const q = hovering(60);
    run(q, 4, () => ({ lift }), flat());
    const y0 = q.y;
    let most = 0;
    run(q, 8, () => ({}), flat(), (p) => void (most = Math.max(most, Math.abs(p.y - y0))));
    on.push(`${lift > 0 ? 'up' : 'down'} ${r1(most)} m (held ${r1(Math.abs(q.y - y0))} m on)`);
  }
  rows.push(['let go of up / down', `goes on ${on.join(', ')}`]);
}
// A dash to top speed on full forward, then let go to a stop.
{
  const s = hovering(40);
  let top = 0, nose = 0, t90 = null;
  run(s, 40, () => ({ fwd: 1 }), flat(), (q, t) => {
    const v = Math.hypot(q.vx, q.vz);
    top = Math.max(top, v);
    nose = Math.max(nose, q.pitch);
    if (t90 === null && v > 0.9 * HELI.V_TOP) t90 = t;
  });
  const sx = s.x, sz = s.z, y0 = s.y;
  let up = 0, low = 0, back = 0;
  const tStop = run(s, 40, () => ({}), flat(), (q) => {
    up = Math.max(up, q.y - y0);
    low = Math.min(low, q.y - y0);
    back = Math.min(back, q.pitch);
    return Math.hypot(q.vx, q.vz) < 0.5;
  });
  rows.push(['dash on full forward', `${r1(top * 3.6)} km/h top (${r1(top)} m/s; cap ${HELI.V_CAP}); 90 % in ${r1(t90)} s; nose down ${deg(nose)} deg`]);
  rows.push(['stop (let go)', `${r1(tStop)} s and ${r1(Math.hypot(s.x - sx, s.z - sz))} m to under 0.5 m/s; height +${r1(up)} / ${r1(low)} m; nose up ${deg(-back)} deg`]);
}
// A full turn at 30 m/s, the turn key held.
{
  const s = hovering(40);
  const fwd = 30 / HELI.V_TOP;
  run(s, 20, () => ({ fwd }), flat(), (q) => Math.abs(Math.hypot(q.vx, q.vz) - 30) < 0.2);
  const y0 = s.y;
  let turned = 0, last = s.yaw, bank = 0, dy = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const t = run(s, 60, () => ({ fwd, turn: 1 }), flat(), (q) => {
    turned += Math.atan2(Math.sin(q.yaw - last), Math.cos(q.yaw - last));
    last = q.yaw;
    bank = Math.max(bank, Math.abs(q.roll));
    dy = Math.max(dy, Math.abs(q.y - y0));
    [minX, maxX, minZ, maxZ] = [Math.min(minX, q.x), Math.max(maxX, q.x), Math.min(minZ, q.z), Math.max(maxZ, q.z)];
    return Math.abs(turned) >= 2 * Math.PI;
  });
  rows.push(['full turn at 30 m/s', `${r1(t)} s, radius ${r1((maxX - minX + maxZ - minZ) / 4)} m, bank ${deg(bank)} deg, height within ${r2(dy)} m`]);
}
// Turning with the keys (the review's measures): W with a turn key from a hover, a full circle at cruise, the nose's
// coast after a hover turn, the bank's swing back past level after a turn at speed.
{
  const curve = (s, input, secs, until) => {
    let turned = 0, last = s.yaw, bank = 0, top = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const t = run(s, secs, () => input, flat(), (q) => {
      turned += Math.atan2(Math.sin(q.yaw - last), Math.cos(q.yaw - last));
      last = q.yaw;
      bank = Math.max(bank, Math.abs(q.roll));
      top = Math.max(top, Math.hypot(q.vx, q.vz));
      [minX, maxX, minZ, maxZ] = [Math.min(minX, q.x), Math.max(maxX, q.x), Math.min(minZ, q.z), Math.max(maxZ, q.z)];
      return until?.(turned);
    });
    return { t, r: (maxX - minX + maxZ - minZ) / 4, bank, top, turned };
  };
  const a = curve(hovering(40), { fwd: 1, turn: 1 }, 10);
  rows.push(['W + turn key from a hover, 10 s', `${r1((Math.abs(a.turned) * 180) / Math.PI / a.t)} deg/s on average, up to ${r1(a.top)} m/s, bank ${deg(a.bank)} deg, ${r1(a.r)} m across half`]);
  const c0 = hovering(40);
  run(c0, 30, () => ({ fwd: 1 }), flat());
  const c = curve(c0, { fwd: 1, turn: 1 }, 90, (turned) => Math.abs(turned) >= 2 * Math.PI);
  rows.push(['full circle at cruise (W + turn)', `${r1(c.t)} s, radius ${r1(c.r)} m, bank ${deg(c.bank)} deg, speed down to ${r1((2 * Math.PI * c.r) / c.t)} m/s`]);
  const h = hovering(40);
  run(h, 2, () => ({ turn: 1 }), flat());
  const y0 = h.yaw;
  run(h, 3, () => ({}), flat());
  rows.push(['hover turn, let go', `the nose coasts ${deg(Math.abs(Math.atan2(Math.sin(h.yaw - y0), Math.cos(h.yaw - y0))))} deg`]);
  const sideOf = Math.sign(c0.roll) || 1;
  let past = 0;
  run(c0, 6, () => ({ fwd: 1 }), flat(), (q) => void (past = Math.max(past, -sideOf * q.roll)));
  rows.push(['turn at cruise, let go', `the bank goes ${deg(past)} deg past level`]);
}
// The nose goes only where it is turned: sideways alone, forward in the strongest crosswind, backwards in a light one.
for (const [what, input, wind, secs] of [['D alone 8 s', { side: 1 }, [0, 0], 8], ['W 8 s, 4.5 m/s crosswind', { fwd: 1 }, [4.5, 0], 8], ['S 20 s, 2 m/s crosswind', { fwd: -1 }, [2, 0], 20]]) {
  const env = flat(wind);
  const s = hovering(40);
  const yaw0 = s.yaw, x0 = s.x, z0 = s.z;
  run(s, secs, () => input, env);
  const off = (Math.atan2(s.x - x0, -(s.z - z0)) * 180) / Math.PI; // the track's angle off the nose's line (the nose faces -z)
  rows.push([what, `nose turned ${deg(s.yaw - yaw0)} deg; ${r1(Math.hypot(s.vx, s.vz))} m/s; went ${r1(Math.hypot(s.x - x0, s.z - z0))} m, ${r1(s.x - x0)} m across the nose's line${input.side ? '' : ` (track ${r1(input.fwd > 0 ? off : 180 - Math.abs(off))} deg off it)`}`]);
}
// A landing from 30 m on full down.
{
  const s = hovering(30);
  let touch = null, how = '';
  const t = run(s, 60, () => ({ lift: -1 }), flat(), (q) => {
    if (q.ev & 4) how = 'BUMP';
    else if (q.ev & 2) how ||= 'bounced';
    if (q.ground && touch === null) touch = q;
    return q.ground;
  });
  rows.push(['landing from 30 m, full down', `${r1(t)} s; ${how || 'settled'}; last sink under ${r1(0.8)} m/s by the floor's cap (soft under ${HELI.LAND_SOFT})`]);
}
for (const [what, got] of rows) console.log(`  ${what.padEnd(30)} ${got}`);
