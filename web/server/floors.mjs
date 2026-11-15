// The fastest an honest player can do a timed route (server/goals.mjs refuses a finish under it): the tightest line
// through its rings, and how fast each way of moving goes along it by the page's own numbers. Worked out once, at start.
//
// - On foot: running at the real pace (src/main.ts REAL_WALK: 1.4 m/s walking, 2.5 times that running).
// - By bike: src/world/bike.ts as a point: pedalling's pull and power, rolling and air, the slope of the ground;
//   pedalling adds nothing past pedalCap (25 km/h on the flat), downhill it rolls on to maxSpeed. No corner slows it:
//   a lower bound.
// - By car: src/world/car.ts as a point: the motor's pull (less towards the top speed), the brakes, and the tyres'
//   grip sideways on dry asphalt for every corner of the line, braking before it in time. The best grip there is.
//
// The page's numbers are copied here (the page's files are TypeScript the server doesn't load); server/floors.test.mjs
// reads them from the page's files and fails when they part.

import { pointsOf } from '../shared/goals.mjs';

export const G = 9.81;
/** src/world/bike.ts */
export const BIKE = { ACCEL: 2.2, POWER: 450, MASS: 95, ROLL: 0.05, DRAG: 0.0035 };
/** src/world/car.ts (TYRE times world/carGrip.ts surfaceGrip's best, dry asphalt: 1) */
export const CAR = { ACCEL: 6, BRAKE: 10.5, TYRE: 1.2 };
/** m/s running (src/main.ts REAL_WALK times 2.5) */
export const RUN = 1.4 * 2.5;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lengthOf = (pts) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
};

/**
 * The shortest line that comes into the gate's circle, touches each checkpoint's circle in order and the gate's again:
 * one point on each circle, moved round it until the whole line is as short as it gets (coordinate descent).
 */
export function cutPath(route) {
  const r = route.radius;
  const centres = [route.gate, ...pointsOf(route)];
  const ang = centres.map((c, i) => {
    const o = centres[Math.min(centres.length - 1, i + 1)], p = centres[Math.max(0, i - 1)];
    return Math.atan2((o[1] + p[1]) / 2 - c[1], (o[0] + p[0]) / 2 - c[0]);
  });
  const pt = (i) => [centres[i][0] + r * Math.cos(ang[i]), centres[i][1] + r * Math.sin(ang[i])];
  const around = (i) => {
    let s = 0;
    const q = pt(i);
    if (i > 0) { const a = pt(i - 1); s += Math.hypot(q[0] - a[0], q[1] - a[1]); }
    if (i < centres.length - 1) { const b = pt(i + 1); s += Math.hypot(q[0] - b[0], q[1] - b[1]); }
    return s;
  };
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < centres.length; i++) {
      for (const d of [0.3, 0.1, 0.03, 0.01, 0.003, 0.001]) {
        for (const s of [-1, 1]) {
          const keep = ang[i], before = around(i);
          ang[i] = keep + s * d;
          if (around(i) < before - 1e-9) moved = true;
          else ang[i] = keep;
        }
      }
    }
    if (!moved) break;
  }
  const pts = centres.map((_, i) => pt(i));
  return { pts, length: lengthOf(pts) };
}

/** Points along a line every `ds` m. */
function resample(pts, ds) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / ds));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

/** Seconds running a line flat out. */
export const footTime = (pts) => lengthOf(pts) / RUN;

/** Seconds riding a line flat out (`height(x, z)`: the ground), from a flying start at the pedalling speed. */
export function bikeTime(pts, height, { pedal, max }) {
  const cap = (slope) => pedal * (1 - clamp(slope * 8, -0.3, 0.35)); // bike.ts pedalCap
  const line = resample(pts, 1);
  let v = pedal, t = 0;
  for (let i = 1; i < line.length; i++) {
    const d = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    if (d < 1e-9) continue;
    const slope = clamp((height(line[i][0], line[i][1]) - height(line[i - 1][0], line[i - 1][1])) / d, -0.3, 0.3);
    let left = d;
    while (left > 1e-9) {
      const dt = Math.min(0.01, left / Math.max(v, 0.5));
      let a = -G * slope;
      const c = cap(slope);
      if (v < c + 0.15) a += Math.min(BIKE.ACCEL, BIKE.POWER / (BIKE.MASS * Math.max(v, 1))) * Math.min(1, (c + 0.15 - v) / 0.35);
      a -= BIKE.ROLL + BIKE.DRAG * v * v;
      v = clamp(v + a * dt, 0.5, max);
      left -= v * dt;
      t += dt;
    }
  }
  return t;
}

/**
 * Seconds driving a line flat out, the car as a point: through each corner no faster than the tyres hold it, braking
 * before it, pulling away after it, from a flying start at the top speed (the run starts in the gate).
 */
export function carTime(pts, { top }) {
  // The corners of a polyline through points on circles are sharp: rounded off a little, as a car takes them.
  let line = resample(pts, 4);
  for (let k = 0; k < 6; k++) line = line.map((q, i) => (i === 0 || i === line.length - 1 ? q : [(line[i - 1][0] + 2 * q[0] + line[i + 1][0]) / 4, (line[i - 1][1] + 2 * q[1] + line[i + 1][1]) / 4]));
  const n = line.length;
  const grip = CAR.TYRE * G;
  const v = line.map((p, i) => {
    if (i === 0 || i === n - 1) return top;
    const [ax, az] = line[i - 1], [bx, bz] = p, [cx, cz] = line[i + 1];
    const a = Math.hypot(bx - ax, bz - az), b = Math.hypot(cx - bx, cz - bz), c = Math.hypot(cx - ax, cz - az);
    const area = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
    return area < 1e-9 ? top : Math.min(top, Math.sqrt((grip * a * b * c) / (4 * area)));
  });
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    const pull = CAR.ACCEL * Math.max(0, 1 - 0.65 * (v[i - 1] / top) ** 2);
    v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * pull * d));
  }
  for (let i = n - 2; i >= 0; i--) {
    const d = Math.hypot(line[i][0] - line[i + 1][0], line[i][1] - line[i + 1][1]);
    v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * Math.min(CAR.BRAKE, grip) * d));
  }
  let t = 0;
  for (let i = 1; i < n; i++) t += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]) / ((v[i] + v[i - 1]) / 2);
  return t;
}

/**
 * The fastest honest time of each route (ms) and the tightest line's length. `slack`: on foot a little under the
 * model's (a runner can take nearly that line on the page, and the times have the network's play); by bike the model's
 * own (no corner slows it, and a bike can't take the line through the houses: the honest best clear of them is 5 % over
 * it); by car well under (the point model is rough, the car's route counts for tonight only). `models`: { height,
 * bike: { pedal, max }, car: { top } }.
 */
export function floors(routes, models, slack = { foot: 0.97, bike: 1, car: 0.9 }) {
  const out = {};
  for (const r of routes) {
    const cut = cutPath(r);
    const s = r.by === 'foot' ? footTime(cut.pts) : r.by === 'bike' ? bikeTime(cut.pts, models.height, models.bike) : carTime(cut.pts, models.car);
    out[r.id] = { ms: Math.ceil(s * 1000 * slack[r.by]), model: Math.round(s * 1000), length: cut.length };
  }
  return out;
}
