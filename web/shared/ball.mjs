// A football to kick (Yoshi, 7 Nov 2026): one on the school's playground in Smetlede, between two small
// goals, and one on the main house's back lawn. The same code runs on the server (server/football.mjs:
// together the server owns each ball) and in the page (src/world/football.ts: alone it runs here; together
// it runs ahead of the server's states, which correct it).
//
// Our own simple physics, as the rest of the game has (DECISIONS: "Own simple collision instead of a
// physics library"): a sphere with gravity and a little air drag that bounces off the ground (the relief,
// shared/terrain.mjs) and off what stands on its pitch, rolls to a stop on the ground's friction and goes to
// sleep when still. No spin. The pitch is its own small world, the same on both sides: the outline the ball
// stays inside (the playground's walls and fences, or the lawn's hedges and edges), posts (upright
// cylinders), bars (round rods between two points), panels (flat triangles: nets, the play tower's boards)
// and goals. A step is cut into substeps short enough that the ball never moves more than a third of its
// radius in one, so it can't pass through a post, a bar or a net however hard it was kicked; whatever
// happens, the ball's middle is never let outside the outline.
//
// Players push it by walking into it (a mover: an upright cylinder from where it was to where it is in the
// step), and kick it: a velocity where they look, harder when they run. A kick sets the ball's velocity
// (it never adds to it), so no number of kicks can make it faster than KICK.hard.

import PLAYGROUND from './playground.json' with { type: 'json' };
import FOOTBALL from './football.json' with { type: 'json' };

export const BALL = {
  r: 0.105, // m: a size 4 ball (youth football), 66 cm round
  g: 9.81,
  drag: 0.012, // 1/m: air drag, a = drag * |v| * v
  roll: 0.8, // m/s²: rolling resistance on concrete and short grass (a kick rolls 30 to 40 m, off a wall or two)
  ground: 0.68, // the share of the speed into the ground that bounces back
  settle: 0.5, // m/s: a bounce slower than this stays on the ground (rolling)
  scrub: 0.96, // the share of the speed along the ground kept at a bounce
  wall: 0.62, // the share bounced back from walls, posts and bars
  net: 0.12, // the share bounced back from a net
  body: 0.2, // the share bounced back from a player who walks into it (on top of their own speed)
  sleepSpeed: 0.05, // m/s: slower than this on the ground...
  sleepAfter: 0.5, // s: ...for this long, and it sleeps
  maxSpeed: 30, // m/s: never faster (a safety net: kicks are capped well under it)
  maxStep: 0.1, // s: longer steps (a frame after the page stood still) are cut to this; the time is lost
  netted: 1.6, // s in the net after a goal before it is back in the middle
};

export const KICK = {
  reach: 1.3, // m across from the player's middle to the ball's
  low: -0.6, // m: the ball's middle at least this far below the feet...
  high: 2.0, // ...and at most this far above them (a header)
  soft: 9, // m/s: a kick
  hard: 14, // m/s: a kick on the run
  run: 2.2, // m/s across: running at least this fast makes a kick a hard one
  aim: 0.3, // rad: the kick leaves this much above where you look (looking at the ball itself it stays low)
  maxLift: 0.75, // rad: at most this steep
  every: 200, // ms between one player's kicks
};

/** A player as the ball meets them: an upright cylinder. */
export const BODY = { r: 0.25, height: 1.8, maxSpeed: 6 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- the pitches
// The school's playground (tools/school.py draws it): on the long block's axes, v along its wall from the
// gate end (north) to the south, w across (negative: out on the playground). The same numbers as the model.
const C2 = [475.4, -796.68];
const L2 = Math.hypot(481.64 - C2[0], -840.06 - C2[1]);
const V2 = [(481.64 - C2[0]) / L2, (-840.06 - C2[1]) / L2];
const W2 = [-V2[1], V2[0]];
const Q = (v, w) => [C2[0] + V2[0] * v + W2[0] * w, C2[1] + V2[1] * v + W2[1] * w];
// The front wing's frame (tools/school.py P1), for the benches along its corridor.
const A1 = [446.99, -793.26];
const L1 = Math.hypot(470.45 - A1[0], -788.73 - A1[1]);
const U1 = [(470.45 - A1[0]) / L1, (-788.73 - A1[1]) / L1];
const N1 = [U1[1], -U1[0]];
const P1 = (u, n) => [A1[0] + U1[0] * u + N1[0] * n, A1[1] + U1[1] * u + N1[1] * n];
// The play tower (shared/playground.json, written by tools/school.py with the model): dv along the long block,
// dw across it from the ladder to the slide, from its foot's middle.
const TOWER = PLAYGROUND.tower;
const T = (dv, dw) => [TOWER.at[0] + TOWER.v[0] * dv + TOWER.w[0] * dw, TOWER.at[1] + TOWER.v[1] * dv + TOWER.w[1] * dw];
const { posts: tPost, platform: tPlat, boards: tBoard, ladder: tLad, slide: tSlide } = TOWER;
const tBoardAt = (tBoard.from + tBoard.to) / 2;

/**
 * A small goal (3 x 1.6 m, 0.9 m deep, the net sloping from the crossbar to a bar on the ground behind), its
 * mouth's middle at `at`, `inward` the way into it (unit, seen from above).
 */
function goal(id, at, inward, size = { half: 1.5, height: 1.6, depth: 0.9, post: 0.045 }) {
  return { id, at, inward, ...size };
}

// FC Smetlede's pitch (shared/football.json, tools/football_site.py; Yoshi, 8 Nov 2026): u along the pitch from the far
// end to the car park's, w across it to the buildings' side. Full-size goals (7.32 by 2.44 m, the net 2 m deep at the
// ground, tools/football.py builds them); the ball stays inside the spectators' rail.
const FC = FOOTBALL;
const F = (u, w) => [FC.centre[0] + FC.u[0] * u + FC.w[0] * w, FC.centre[1] + FC.u[1] * u + FC.w[1] * w];
const FULL = { half: 3.66, height: 2.44, depth: 2.0, post: 0.06 };

/** The pitches, as plain data: the server and the page each make their own with makePitch. */
export const PITCHES = [
  {
    id: 'school',
    // The playground (data/smetlede.json `yard`): the front wing, the long block, the fence by the sheds, the
    // sheds, the pavilion and the fence to the school garden; the passage to the gate is part of it, the gate
    // keeps the ball in.
    outline: [[449.7, -806.08], [472.79, -801.46], [472.15, -797.93], [475.5, -797.4], [481.64, -840.06], [481.9, -843], [468.9, -843.4],
      [468.83, -841.7], [467.12, -830.27], [462.27, -831.11], [462.41, -829.75], [459.32, -808.96], [452.56, -810.06]],
    lift: 0.03, // the playground's concrete over the relief (tools/school.py drape)
    // The goals along the middle of the playground's south part: the model's at the south end, ours at the gate end,
    // its net clear of the benches along the corridor.
    goals: [goal('north', Q(6.9, -6.5), [-V2[0], -V2[1]]), goal('south', Q(44.9, -6.5), [V2[0], V2[1]])],
    home: Q(25.0, -6.5), // about the middle between the two goals, clear of the play tower
    // What stands on it (tools/school.py): the play tower's posts, ladder, platform, boards and slide; the
    // balance posts and the beam; the benches along the corridor.
    posts: [
      ...[-tPost.at, tPost.at].flatMap((dv) => [-tPost.at, tPost.at].map((dw) => [...T(dv, dw), tPost.size * 0.7, tPost.top])),
      ...[0.3, 0.45, 0.6, 0.75, 0.6, 0.45, 0.3].map((h, k) => [...Q(24.5 + k * 0.55, -11.0), 0.11, h]),
      [...Q(24.0, -12.6), 0.07, 0.32], [...Q(28.0, -12.6), 0.07, 0.32],
      ...[18.2, 21.0].flatMap((u) => [-0.75, 0.75].map((du) => [...P1(u + du, 13.65), 0.1, 0.42])),
    ],
    bars: [
      [...Q(24.0, -12.6), 0.38, ...Q(28.0, -12.6), 0.38, 0.065],
      ...[-tLad.half, tLad.half].map((s) => [...T(s, tLad.foot), 0, ...T(s, tLad.top), tLad.rise, 0.04]),
    ],
    panels: [
      // The tower's platform and its two side boards.
      ...quad(T(-tPlat.half, -tPlat.half), T(tPlat.half, -tPlat.half), T(tPlat.half, tPlat.half), T(-tPlat.half, tPlat.half), ...Array(4).fill(tPlat.y1 - 0.02)),
      ...[-tBoardAt, tBoardAt].flatMap((dv) => quad(T(dv, -tPlat.half), T(dv, tPlat.half), T(dv, tPlat.half), T(dv, -tPlat.half), tPlat.y1, tPlat.y1, tBoard.y1, tBoard.y1)),
      // The slide, down towards the long block.
      ...quad(T(-tSlide.half, tSlide.top[0]), T(tSlide.half, tSlide.top[0]), T(tSlide.half, tSlide.bottom[0]), T(-tSlide.half, tSlide.bottom[0]),
        tSlide.top[1], tSlide.top[1], tSlide.bottom[1], tSlide.bottom[1]),
      // The benches' seats.
      ...[18.2, 21.0].flatMap((u) => quad(P1(u - 0.9, 13.43), P1(u + 0.9, 13.43), P1(u + 0.9, 13.87), P1(u - 0.9, 13.87), 0.45, 0.45, 0.45, 0.45)),
    ],
    near: 250, // m: players this close to the home spot are told about the ball
  },
  {
    id: 'lawn',
    // The main house's back lawn, out to its hedges and borders: the robot mower's wire (world/mower.ts) 35 cm out.
    outline: [[-2.5, -22.6], [11.4, -22.6], [11.4, -6.25], [4.4, -6.25], [4.25, -6.9], [4.1, -7.6], [3.8, -8.3], [3.3, -9.05],
      [2.75, -9.65], [2.15, -10.15], [1.55, -10.5], [1.55, -13.95], [1.42, -14.45], [1.2, -14.9], [0.8, -15.2], [0.15, -15.42],
      [-0.6, -15.52], [-1.4, -15.52], [-2.5, -15.45]],
    lift: 0,
    goals: [],
    home: [5.5, -18.0],
    posts: [],
    bars: [],
    panels: [],
    near: 200,
  },
  {
    id: 'fc',
    // The spectators' rail round the pitch (the dugouts stand in its line), 20 cm in.
    outline: [F(FC.rail.u0 + 0.2, FC.rail.w0 + 0.2), F(FC.rail.u1 - 0.2, FC.rail.w0 + 0.2), F(FC.rail.u1 - 0.2, FC.rail.w1 - 0.2), F(FC.rail.u0 + 0.2, FC.rail.w1 - 0.2)],
    lift: 0.02, // the pitch's grass over the levelled ground (world/footballGround.ts)
    goals: FC.goals.map((g) => goal(g.id, F(g.u, 0), [g.in * FC.u[0], g.in * FC.u[1]], FULL)),
    home: F(FC.length / 2 - 11, 0), // the penalty spot at the car park's end
    // The corner flags.
    posts: [-1, 1].flatMap((su) => [-1, 1].map((sw) => [...F((su * FC.length) / 2, (sw * FC.width) / 2), 0.02, 1.5])),
    bars: [],
    panels: [],
    near: 180,
  },
];

/** Two triangles for a four-cornered panel: corners (x, z) with their heights over the ground. */
function quad(a, b, c, d, ya, yb, yc, yd) {
  return [[...a, ya, ...b, yb, ...c, yc], [...a, ya, ...c, yc, ...d, yd]];
}

/**
 * A pitch ready to play on: `spec` one of PITCHES, `height(x, z)` the ground's height in the game (the
 * relief over the model's ground). Heights in the spec are over the ground; here they are the game's.
 */
export function makePitch(spec, height) {
  const ground = (x, z) => height(x, z) + spec.lift;
  const base = ground; // what the spec's heights are over
  const ring = spec.outline;
  const walls = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return { ax: a[0], az: a[1], bx: b[0], bz: b[1] };
  });
  const posts = spec.posts.map(([x, z, r, top]) => ({ x, z, r, y0: base(x, z) - 0.5, y1: base(x, z) + top }));
  const bars = spec.bars.map(([ax, az, ay, bx, bz, by, r]) => ({ a: [ax, base(ax, az) + ay, az], b: [bx, base(bx, bz) + by, bz], r }));
  const panels = spec.panels.map((p) => tri(p, base));
  const goals = spec.goals.map((g) => {
    const [mx, mz] = g.at;
    const [nx, nz] = g.inward;
    const ux = -nz, uz = nx; // along the mouth
    const gy = base(mx, mz); // the whole goal stands at its mouth's ground (as the model's)
    const P = (along, deep) => [mx + ux * along + nx * deep, mz + uz * along + nz * deep];
    const pt = (along, deep, y) => {
      const [x, z] = P(along, deep);
      return [x, gy + y, z];
    };
    for (const s of [-1, 1]) {
      const [px, pz] = P(s * g.half, 0);
      posts.push({ x: px, z: pz, r: g.post, y0: gy - 0.5, y1: gy + g.height });
      bars.push({ a: pt(s * g.half, 0, g.height), b: pt(s * g.half, g.depth, 0), r: 0.03 }); // the side frame, sloping back
      bars.push({ a: pt(s * g.half, 0, 0.02), b: pt(s * g.half, g.depth, 0.02), r: 0.03 });
      // The side net: from the post down to the back corner.
      panels.push(tri3(pt(s * g.half, 0, 0), pt(s * g.half, 0, g.height), pt(s * g.half, g.depth, 0), BALL.net));
    }
    bars.push({ a: pt(-g.half - 0.04, 0, g.height), b: pt(g.half + 0.04, 0, g.height), r: g.post }); // the crossbar
    bars.push({ a: pt(-g.half, g.depth, 0.02), b: pt(g.half, g.depth, 0.02), r: 0.03 });
    // The back net, sloping from the crossbar to the bar on the ground.
    panels.push(tri3(pt(-g.half, 0, g.height), pt(g.half, 0, g.height), pt(g.half, g.depth, 0), BALL.net));
    panels.push(tri3(pt(-g.half, 0, g.height), pt(g.half, g.depth, 0), pt(-g.half, g.depth, 0), BALL.net));
    return { id: g.id, mx, mz, nx, nz, ux, uz, half: g.half, height: g.height, depth: g.depth, y: gy };
  });
  // Few enough things to look through whole each substep; a box round each skips the far ones quickly.
  for (const bar of bars) bar.box = boxOf([bar.a, bar.b], bar.r + BALL.r);
  for (const t of panels) t.box = boxOf([t.a, t.b, t.c], BALL.r);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const [hx, hz] = spec.home;
  return { id: spec.id, ring, walls, posts, bars, panels, goals, ground, home: { x: hx, z: hz }, near: spec.near, box: { minX, minZ, maxX, maxZ } };
}

/** The box round some points, `pad` wider on every side: [minX, minY, minZ, maxX, maxY, maxZ]. */
function boxOf(points, pad) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      box[k] = Math.min(box[k], p[k] - pad);
      box[k + 3] = Math.max(box[k + 3], p[k] + pad);
    }
  }
  return box;
}

const inBox = (b, box) => b.x >= box[0] && b.y >= box[1] && b.z >= box[2] && b.x <= box[3] && b.y <= box[4] && b.z <= box[5];

function tri(p, base) {
  const [ax, az, ay, bx, bz, by, cx, cz, cy] = p;
  return tri3([ax, base(ax, az) + ay, az], [bx, base(bx, bz) + by, bz], [cx, base(cx, cz) + cy, cz], BALL.wall);
}

function tri3(a, b, c, bounce) {
  return { a, b, c, bounce };
}

/** Whether (x, z) is inside the pitch's outline (even-odd). */
export function insidePitch(pitch, x, z) {
  const ring = pitch.ring;
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

// ---------------------------------------------------------------- the ball
/** A ball asleep in the middle of its pitch. */
export function newBall(pitch) {
  const b = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, asleep: true, still: 0, netted: 0, score: pitch.goals.map(() => 0), last: '' };
  return toHome(b, pitch);
}

/** Back in the middle, asleep on the ground. */
export function toHome(ball, pitch) {
  ball.x = pitch.home.x;
  ball.z = pitch.home.z;
  ball.y = pitch.ground(ball.x, ball.z) + BALL.r;
  ball.vx = ball.vy = ball.vz = 0;
  ball.asleep = true;
  ball.still = 0;
  ball.netted = 0;
  return ball;
}

const finite = (b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z) && Number.isFinite(b.vx) && Number.isFinite(b.vy) && Number.isFinite(b.vz);

/** Push the ball out along a contact normal (n, unit) by `depth`, and bounce off it with `bounce`. */
function contact(b, nx, ny, nz, depth, bounce, friction = 0.9) {
  b.x += nx * depth;
  b.y += ny * depth;
  b.z += nz * depth;
  const vn = b.vx * nx + b.vy * ny + b.vz * nz;
  if (vn >= 0) return 0;
  // The part along the surface loses a little; the part into it comes back as `bounce` of itself.
  const tx = b.vx - vn * nx, ty = b.vy - vn * ny, tz = b.vz - vn * nz;
  b.vx = tx * friction - vn * bounce * nx;
  b.vy = ty * friction - vn * bounce * ny;
  b.vz = tz * friction - vn * bounce * nz;
  return -vn;
}

/** The closest point on segment a-b to p (3D). */
function closestOnSegment(px, py, pz, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
  const len2 = ex * ex + ey * ey + ez * ez;
  const t = len2 > 0 ? clamp(((px - a[0]) * ex + (py - a[1]) * ey + (pz - a[2]) * ez) / len2, 0, 1) : 0;
  return [a[0] + ex * t, a[1] + ey * t, a[2] + ez * t];
}

/** The closest point on triangle a-b-c to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p, a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const at = (s, t) => [a[0] + ab[0] * s + ac[0] * t, a[1] + ab[1] * s + ac[1] * t, a[2] + ab[2] * s + ac[2] * t];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const den = 1 / (va + vb + vc);
  return at(vb * den, vc * den);
}

/** Against a point q: out along the line from q to the ball's middle when it is within `reach`. */
function againstPoint(b, q, reach, bounce) {
  const dx = b.x - q[0], dy = b.y - q[1], dz = b.z - q[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= reach * reach) return 0;
  const d = Math.sqrt(d2);
  if (d < 1e-9) return contact(b, 0, 1, 0, reach, bounce);
  return contact(b, dx / d, dy / d, dz / d, reach - d, bounce);
}

/** The ball's ground contact, pushing it up out of the ground; true when it is on it. */
function onGround(b, pitch, events) {
  const g = pitch.ground(b.x, b.z);
  if (b.y - BALL.r > g + 0.002) return false;
  b.y = Math.max(b.y, g + BALL.r);
  if (b.vy < 0) {
    const into = -b.vy;
    b.vy = into * BALL.ground;
    if (b.vy < BALL.settle) b.vy = 0;
    b.vx *= BALL.scrub;
    b.vz *= BALL.scrub;
    if (into > 1.5 && events) events.push({ kind: 'bounce', speed: into });
  }
  return b.vy <= 0.01;
}

/** The slope of the ground at (x, z): its rise per metre along x and along z. */
function slope(pitch, x, z) {
  const e = 0.25;
  return [(pitch.ground(x + e, z) - pitch.ground(x - e, z)) / (2 * e), (pitch.ground(x, z + e) - pitch.ground(x, z - e)) / (2 * e)];
}

/** The nearest wall of the outline to (x, z): its closest point and its distance. */
function nearestWall(pitch, x, z) {
  let best = Infinity, bx = x, bz = z;
  for (const w of pitch.walls) {
    const ex = w.bx - w.ax, ez = w.bz - w.az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? clamp(((x - w.ax) * ex + (z - w.az) * ez) / len2, 0, 1) : 0;
    const px = w.ax + ex * t, pz = w.az + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bx = px;
      bz = pz;
    }
  }
  return { x: bx, z: bz, d: best };
}

/**
 * Move a ball on for `dt` seconds. `movers`: players who were at (x0, z0) at the start of the step and are at
 * (x1, z1) at its end, feet at `feet` (each { x0, z0, x1, z1, feet, name }). Returns what happened:
 * { kind: 'goal', goal } when it went in (`goal`: the goal's number in pitch.goals), { kind: 'home' } when
 * it went back to the middle after a goal, { kind: 'bounce', speed } for a hard bounce, { kind: 'touch', name }
 * when a player walked into it.
 */
export function stepBall(ball, pitch, dt, movers = []) {
  const events = [];
  if (!(dt > 0)) return events;
  dt = Math.min(dt, BALL.maxStep);
  if (!finite(ball)) {
    toHome(ball, pitch);
    events.push({ kind: 'home' });
    return events;
  }
  if (ball.netted > 0) {
    ball.netted -= dt;
    if (ball.netted <= 0) {
      toHome(ball, pitch);
      events.push({ kind: 'home' });
      return events;
    }
  }
  // Someone close enough to walk into it wakes it.
  const reach = BODY.r + BALL.r;
  if (ball.asleep) {
    let near = false;
    for (const m of movers) {
      if (Math.min(Math.hypot(m.x1 - ball.x, m.z1 - ball.z), Math.hypot(m.x0 - ball.x, m.z0 - ball.z)) < reach + 0.5) near = true;
    }
    if (!near) return events;
  }
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz) + BODY.maxSpeed;
  const n = Math.min(400, Math.max(Math.ceil(dt / (1 / 240)), Math.ceil((speed * dt) / (BALL.r / 3))));
  const h = dt / n;
  const touched = new Set();
  for (let i = 0; i < n; i++) {
    const px = ball.x, py = ball.y, pz = ball.z;
    // Players walking into it: the ball goes ahead of them, a little faster than they walk.
    for (const m of movers) {
      const t = (i + 1) / n;
      const mx = m.x0 + (m.x1 - m.x0) * t, mz = m.z0 + (m.z1 - m.z0) * t;
      if (ball.y < m.feet - BALL.r || ball.y > m.feet + BODY.height + BALL.r) continue;
      const dx = ball.x - mx, dz = ball.z - mz;
      const d = Math.hypot(dx, dz);
      if (d >= reach) continue;
      let mvx = (m.x1 - m.x0) / dt, mvz = (m.z1 - m.z0) / dt;
      const ms = Math.hypot(mvx, mvz);
      if (ms > BODY.maxSpeed) {
        mvx *= BODY.maxSpeed / ms;
        mvz *= BODY.maxSpeed / ms;
      }
      const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
      ball.x += nx * (reach - d);
      ball.z += nz * (reach - d);
      const rel = (ball.vx - mvx) * nx + (ball.vz - mvz) * nz;
      if (rel < 0) {
        ball.vx -= (1 + BALL.body) * rel * nx;
        ball.vz -= (1 + BALL.body) * rel * nz;
      }
      ball.asleep = false;
      ball.still = 0;
      if (m.name && !touched.has(m.name)) {
        touched.add(m.name);
        ball.last = m.name;
        events.push({ kind: 'touch', name: m.name });
      }
    }
    if (ball.asleep) continue;
    // Gravity, air drag, then rolling on the ground.
    ball.vy -= BALL.g * h;
    const v = Math.hypot(ball.vx, ball.vy, ball.vz);
    const k = Math.max(0, 1 - BALL.drag * v * h);
    ball.vx *= k;
    ball.vy *= k;
    ball.vz *= k;
    const rolling = ball.y - BALL.r <= pitch.ground(ball.x, ball.z) + 0.003 && ball.vy <= 0.01;
    if (rolling) {
      ball.vy = Math.max(ball.vy, 0);
      const [sx, sz] = slope(pitch, ball.x, ball.z);
      ball.vx -= BALL.g * sx * h;
      ball.vz -= BALL.g * sz * h;
      const across = Math.hypot(ball.vx, ball.vz);
      const less = BALL.roll * h;
      if (across <= less) ball.vx = ball.vz = 0;
      else {
        ball.vx *= 1 - less / across;
        ball.vz *= 1 - less / across;
      }
    }
    ball.x += ball.vx * h;
    ball.y += ball.vy * h;
    ball.z += ball.vz * h;
    // What stands on the pitch.
    for (const p of pitch.posts) {
      if (ball.y < p.y0 - BALL.r || ball.y > p.y1 + BALL.r) continue;
      const q = [p.x, clamp(ball.y, p.y0, p.y1), p.z];
      const hit = againstPoint(ball, q, p.r + BALL.r, BALL.wall);
      if (hit > 1.5) events.push({ kind: 'bounce', speed: hit, post: true });
    }
    for (const bar of pitch.bars) {
      if (!inBox(ball, bar.box)) continue;
      const q = closestOnSegment(ball.x, ball.y, ball.z, bar.a, bar.b);
      const hit = againstPoint(ball, q, bar.r + BALL.r, BALL.wall);
      if (hit > 1.5) events.push({ kind: 'bounce', speed: hit, post: true });
    }
    for (const t of pitch.panels) {
      if (!inBox(ball, t.box)) continue;
      const q = closestOnTriangle([ball.x, ball.y, ball.z], t.a, t.b, t.c);
      const hit = againstPoint(ball, q, BALL.r, t.bounce);
      if (hit > 1.5 && t.bounce >= BALL.wall) events.push({ kind: 'bounce', speed: hit });
    }
    // The walls round the pitch: out of the ones it touches; its middle never outside.
    for (const w of pitch.walls) {
      const ex = w.bx - w.ax, ez = w.bz - w.az;
      const len2 = ex * ex + ez * ez;
      const s = len2 > 0 ? clamp(((ball.x - w.ax) * ex + (ball.z - w.az) * ez) / len2, 0, 1) : 0;
      const qx = w.ax + ex * s, qz = w.az + ez * s;
      const dx = ball.x - qx, dz = ball.z - qz;
      const d = Math.hypot(dx, dz);
      if (d >= BALL.r || d < 1e-9) continue;
      if (!insidePitch(pitch, ball.x, ball.z)) continue; // handled below
      const hit = contact(ball, dx / d, 0, dz / d, BALL.r - d, BALL.wall);
      if (hit > 1.5) events.push({ kind: 'bounce', speed: hit });
    }
    if (!insidePitch(pitch, ball.x, ball.z)) {
      // Through the outline (only a corner can do it): back to where it was this substep, bounced off the nearest wall.
      const q = nearestWall(pitch, px, pz);
      ball.x = px;
      ball.y = py;
      ball.z = pz;
      const dx = px - q.x, dz = pz - q.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-9) contact(ball, dx / d, 0, dz / d, 0, BALL.wall);
      else {
        ball.vx = -ball.vx * BALL.wall;
        ball.vz = -ball.vz * BALL.wall;
      }
      if (!insidePitch(pitch, ball.x, ball.z)) {
        // Never expected (the ball starts inside and only moves from inside): the middle, rather than anywhere else.
        toHome(ball, pitch);
        events.push({ kind: 'home' });
        return events;
      }
    }
    onGround(ball, pitch, events);
    // A goal: wholly over the line, between the posts and under the bar.
    if (ball.netted <= 0) {
      for (let gi = 0; gi < pitch.goals.length; gi++) {
        const g = pitch.goals[gi];
        const dx = ball.x - g.mx, dz = ball.z - g.mz;
        const deep = dx * g.nx + dz * g.nz;
        const along = dx * g.ux + dz * g.uz;
        if (deep > BALL.r && deep < g.depth && Math.abs(along) < g.half && ball.y - g.y < g.height) {
          ball.netted = BALL.netted;
          ball.score[gi] = (ball.score[gi] ?? 0) + 1;
          events.push({ kind: 'goal', goal: gi });
        }
      }
    }
    const fast = Math.hypot(ball.vx, ball.vy, ball.vz);
    if (fast > BALL.maxSpeed) {
      const s = BALL.maxSpeed / fast;
      ball.vx *= s;
      ball.vy *= s;
      ball.vz *= s;
    }
  }
  // Asleep once it has lain still for a moment.
  const g = pitch.ground(ball.x, ball.z);
  const resting = ball.y - BALL.r <= g + 0.003 && Math.hypot(ball.vx, ball.vy, ball.vz) < BALL.sleepSpeed;
  ball.still = resting ? ball.still + dt : 0;
  if (ball.still >= BALL.sleepAfter) {
    ball.asleep = true;
    ball.vx = ball.vy = ball.vz = 0;
    ball.y = g + BALL.r;
  }
  if (!finite(ball)) {
    toHome(ball, pitch);
    events.push({ kind: 'home' });
  }
  return events;
}

// ---------------------------------------------------------------- kicking
/** Whether a player standing at (x, z) with their feet at `feet` can reach the ball (`slack`: m more, for the network's delay). */
export function inReach(ball, x, feet, z, slack = 0) {
  if (![x, feet, z].every(Number.isFinite)) return false;
  const up = ball.y - feet;
  return Math.hypot(ball.x - x, ball.z - z) <= KICK.reach + slack && up >= KICK.low - slack && up <= KICK.high + slack;
}

/** The kick a player gives looking at `yaw` and `pitch` (rad, up positive): where they look, a little above it, at `speed`. */
export function kickFrom(yaw, pitch, speed) {
  const lift = clamp(pitch + KICK.aim, 0, KICK.maxLift);
  const c = Math.cos(lift);
  return [-Math.sin(yaw) * c * speed, Math.sin(lift) * speed, -Math.cos(yaw) * c * speed];
}

/**
 * A kick as asked for (a velocity, m/s) made fair: numbers only, no faster than `max`, never down into the
 * ground, never steeper than KICK.maxLift. Null when it isn't a kick at all.
 */
export function fairKick(v, max) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  let [vx, vy, vz] = v;
  const across = Math.hypot(vx, vz);
  if (across < 1e-3) return null;
  vy = clamp(vy, 0, across * Math.tan(KICK.maxLift));
  const speed = Math.hypot(vx, vy, vz);
  if (speed > max) {
    const s = max / speed;
    vx *= s;
    vy *= s;
    vz *= s;
  }
  return [vx, vy, vz];
}

/** Kick the ball: it leaves with velocity `v` (already fair). Not while it lies in the net after a goal. */
export function kickBall(ball, v, by = '') {
  if (ball.netted > 0) return false;
  [ball.vx, ball.vy, ball.vz] = v;
  // Off the ground a little, so the first substep doesn't count it as rolling.
  if (v[1] > 0) ball.y += 0.002;
  ball.asleep = false;
  ball.still = 0;
  ball.last = by;
  return true;
}
