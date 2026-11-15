// The helicopter's flight (shared/heli.json: the machines, their spots and their sizes), shared by the page
// (src/world/heli.ts flies it, draws it and keeps it out of the walls) and, later, the server (it reads the limits:
// V_CAP, CLIMB_MAX, SINK_CAP). Pure numbers: no three.js, no randomness, no clock, so the same inputs give the same
// flight on every page and in the tests (shared/heli.test.mjs; tools/dev/heliFly.mjs prints the tuning sheet).
//
// One way of flying (Yoshi, 15 Nov 2026: "Keep flying simpler, not 2 modes, only 1."): forward and sideways ask for
// a speed over the ground, up and down for a climb rate, the turn for a turn rate; let go of everything and the
// machine levels, brakes to a hover and holds it there, leaning into the wind. Near a floor the sink is capped, so a
// landing is soft by itself.
//
// Underneath, one step is semi-implicit Euler at about 120 a second (heliFly sub-steps a frame as the car does): the
// rotor's thrust along the mast, gravity, drag on each axis of the speed through the air, ground effect near a floor,
// translational lift with speed, the tail's pull of the nose into the flight path, and the attitude following its
// target as a damped spring, so the machine leans first and moves after: that delay is the weight you feel.
//
// On the ground the four skid points rest on whatever floor is under them (env.ground: a roof, a platform, the
// meadow). A touchdown under LAND_SOFT settles, under LAND_HARD bounces once, harder is a bump: no fire, nobody
// hurt; the machine is set down level, the engine stops and it flies again after DOWN_TIME.

/** Every number of the flight in one place (heli-flight.md section 4; the changes from it are in DECISIONS.md). */
export const HELI = {
  ROTOR_R: 5.2, // m: the main rotor's radius
  ROTOR_Y: 3.2, // m: its hub over the ground under it (the model's origin)
  SPOOL_UP: 6, // s: the rotor from still to full speed with the engine on
  SPOOL_DOWN: 8, // s: and back to still with it off
  LIFT_RPM: 0.9, // the rotor's speed (of full) from which it lifts: below it the lever stays flat
  START_HOLD: 0.4, // s the up key is held on the ground to start the engine
  STOP_HOLD: 1.5, // s the down key is held on the ground to stop it
  THRUST_MAX: 1.45, // g: the rotor's thrust with the lever full up, at full speed, out of ground effect
  COLL_RATE: 2, // 1/s: the fastest the lever moves (full travel in half a second)
  LEVER_LOW: 0.2, // the thrust (of the most) with the lever all the way down: it stops a climb at 0.7 g
  TILT: 0.5, // rad (29 degrees): the most lean for speed
  BANK: 0.75, // rad (43 degrees): the most bank in a turn at speed
  ATT_FREQ: 4.5, // rad/s: how fast pitch and roll follow their targets (a damped spring)
  ATT_DAMP: 0.9, // its damping (1: no overshoot)
  DRAG_FWD: 0.0019, // 1/m: drag along the nose, with the square of the speed through the air
  DRAG_SIDE: 0.006, // 1/m: sideways
  DRAG_UP: 0.02, // 1/m: up and down (the disc's own drag)
  DRAG_LIN: 0.02, // 1/s: and a little in proportion to the speed on every axis
  V_TOP: 47, // m/s (169 km/h): the top speed, full forward
  V_SLOW: 15, // m/s (54 km/h): backwards and sideways
  V_CAP: 52, // m/s (187 km/h): never faster over the ground, whatever happens (a tail wind, a dive)
  CLIMB_MAX: 9, // m/s: the fastest climb (full up)
  SINK: 7, // m/s: the sink at full down
  SINK_CAP: 14, // m/s: never faster down
  VS_RESP: 2.5, // 1/s: how fast the climb rate follows the key
  HOLD_GAIN: 1.2, // 1/s: how firmly it holds its height with the keys let go
  SPEED_GAIN: 0.9, // 1/s: how fast its speed follows the stick
  POS_GAIN: 0.6, // 1/s: how firmly it holds the spot where it came to a stop
  YAW_SLOW: 1.4, // rad/s: the turn at a hover at full turn
  YAW_FAST: 0.45, // rad/s: the most at speed (less when the bank can't hold it: BANK)
  YAW_BLEND0: 12, // m/s: from here the turn becomes a banked one ...
  YAW_BLEND1: 25, // m/s: ... and by here it is one
  YAW_RESP: 6, // 1/s: how fast the turn follows the key (the tail rotor)
  GE_GAIN: 0.18, // ground effect: this much more thrust on the floor ...
  GE_HEIGHT: 5.2, // m: ... fading out by one rotor radius over it ...
  GE_FADE: 15, // m/s: ... and with speed
  ETL_GAIN: 0.12, // translational lift: this much more thrust ...
  ETL_V0: 4, // m/s: ... coming in from here ...
  ETL_V1: 14, // m/s: ... to here (the band shudders a little: felt, not costing height)
  WIND_PUSH: 0.7, // how much of the wind (world/wind.ts) moves the air the machine flies through
  CEIL_FADE: 15, // m: the thrust fades over the last metres under the ceiling
  EDGE_PAD: 40, // m: within this of the game's edge the speed towards it is scaled down to nothing
  LAND_SOFT: 2.5, // m/s: a touchdown slower than this settles
  LAND_HARD: 5, // m/s: slower than this it bounces once; faster is a bump
  LAND_SKID: 6, // m/s: sliding faster than this on touchdown is a bump
  LAND_TILT: 0.44, // rad (25 degrees): leaning further than this on a touchdown that comes down or slides is a bump
  SLOPE_SLIDE: 0.21, // rad (12 degrees): resting on more than this, it slides downhill
  SLOPE_MAX: 0.35, // rad (20 degrees): on more than this it does not settle
  DOWN_TIME: 6, // s on the floor after a bump before it can start again
  DOWN_SINK: 4, // m/s: after a bump in the air it sinks to the floor at least this fast (a third of its height a second, up to SINK_CAP: about 10 s from 60 m)
  REST: 0.5, // s still (anywhere: on a floor, or resting on its boom or cabin) before the time down counts
  STRIKES: 3, // rotor strikes ...
  STRIKE_WINDOW: 3, // s: ... inside this long, or one faster than STRIKE_HARD, are a bump
  STRIKE_HARD: 6, // m/s
  BODY_HARD: 4, // m/s: the fuselage into a wall faster than this is a bump
  STEP_UP: 0.6, // m: a skid finds a floor up to this over it
  CAM_DIST: 14, // m: the chase camera behind the hub ...
  CAM_SPEED: 0.08, // s: ... and this much further per m/s
  CAM_UP: 2, // m: it looks at this over the origin
  CAM_PITCH: 0.3, // rad: down from behind
  CAM_FOLLOW: 3, // 1/s: how fast it comes round behind the nose
  CAM_LAND: [12, 0.6], // m, rad: low and slow, nearer and steeper
  MAGNET_R: 4, // m: within this of a pad's centre ...
  MAGNET_H: 6, // m: ... and this low over it, with the sticks let go ...
  MAGNET_V: 1, // m/s: ... the hover drifts to the centre at this
};

/** Where the skids rest on the ground: the model's x (right) and z (back) of the four contact points (heli.md section 5). */
export const SKIDS = [[-0.95, -2.11], [0.95, -2.11], [-0.95, 0.71], [0.95, 0.71]];
const SKID_LENGTH = SKIDS[2][1] - SKIDS[0][1]; // the flat run of the skids, front to back
const SKID_TRACK = SKIDS[1][0] - SKIDS[0][0];

/** What happened in a step, or'ed into `s.ev` (the caller clears it each frame): for the sound and the shake. */
export const EV = { SETTLE: 1, BOUNCE: 2, BUMP: 4, START: 8, STOP: 16, LIFTOFF: 32, CEILING: 64, EDGE: 128 };

const G = 9.81;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const stick = (v) => clamp(num(v), -1, 1);
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

/** A machine standing still on the ground at `at` (its origin: the ground under the hub), engine off. */
export function heliStart(at = { x: 0, y: 0, z: 0, yaw: 0 }) {
  const { x = 0, y = 0, z = 0, yaw = 0 } = at;
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, yaw, pitch: 0, roll: 0, pitchRate: 0, rollRate: 0, yawRate: 0,
    rotor: 0, coll: 0, engine: false, ground: true, down: 0,
    // Its memory: the height and the spot it holds, how long the start and stop keys are held.
    holdY: y, holdX: x, holdZ: z, holding: false, heightHeld: true, startHeld: 0, stopHeld: 0, still: 0,
    // For the instruments, the sound and the camera: height over the floor below, the floor, how hard it shakes,
    // the thrust (g), what happened (EV) and how hard (m/s), at the edge or the ceiling.
    h: 0, floor: y, shake: 0, thrust: 0, ev: 0, hit: 0, atEdge: false, atCeiling: false,
  };
}

/**
 * The machine set down level and still on the floor at (x, y, z) facing `yaw` (a dev hook), its rotor kept at `rotor`
 * (and the engine running with it when it is over the lift speed).
 */
export function heliPlace(s, x, y, z, yaw, rotor = s.rotor) {
  Object.assign(s, { x, y, z, yaw, vx: 0, vy: 0, vz: 0, pitch: 0, roll: 0, pitchRate: 0, rollRate: 0, yawRate: 0, ground: true, down: 0,
    holdY: y, holdX: x, holdZ: z, holding: false, heightHeld: true, rotor, engine: rotor >= HELI.LIFT_RPM, coll: 0, floor: y, h: 0 });
  return s;
}

/**
 * A bump (something hit hard: a wall, a tree, the ground; `speed` m/s): nobody is hurt and nothing breaks. The machine
 * stops, levels, its engine cuts out and it is down for DOWN_TIME once on the floor; in the air it first sinks there
 * by itself (at least DOWN_SINK, a third of its height a second). The caller shows the sparks and plays the clang.
 */
export function heliBump(s, speed = 0) {
  Object.assign(s, { vx: 0, vz: 0, vy: Math.min(0, s.vy * 0.2), pitchRate: 0, rollRate: 0, yawRate: 0, engine: false, down: HELI.DOWN_TIME, holding: false });
  s.pitch *= 0.3;
  s.roll *= 0.3;
  s.ev |= EV.BUMP;
  s.hit = Math.max(s.hit, num(speed));
  return s;
}

/**
 * One step of `dt` seconds (callers step at about 1/120 s: heliFly; longer steps are cut to 1/20 s).
 * `input`: fwd, side, turn, lift (each -1 to 1; turn > 0 to the right).
 * `env`: ground(x, z, top) the floor's height at a point (the highest under `top`), ceiling (the highest it may fly),
 * wind [x, z] (m/s), edge (the nearest point of the game's edge within EDGE_PAD and its inward direction: {x, z, nx, nz},
 * or null), pad (the nearest landing pad's centre {x, y, z}, or null: the magnet).
 */
export function heliStep(s, input, env, dt) {
  if (!(dt > 0)) return s;
  dt = Math.min(dt, 0.05);
  const H = HELI;
  const down = s.down > 0;
  const fwdIn = down ? 0 : stick(input?.fwd);
  const sideIn = down ? 0 : stick(input?.side);
  const turnIn = down ? 0 : stick(input?.turn);
  const liftIn = down ? 0 : stick(input?.lift);
  const groundAt = typeof env?.ground === 'function' ? env.ground : () => 0;
  const ceiling = typeof env?.ceiling === 'number' && !Number.isNaN(env.ceiling) ? env.ceiling : Infinity;

  // The machine's own frame on the plan: forward (the nose) and right.
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
  const rx = -fz, rz = fx;
  // The speed through the air: over the ground less the wind's push.
  const wx = H.WIND_PUSH * num(env?.wind?.[0]), wz = H.WIND_PUSH * num(env?.wind?.[1]);
  const ax0 = s.vx - wx, az0 = s.vz - wz;
  const uA = ax0 * fx + az0 * fz; // along the nose
  const wA = ax0 * rx + az0 * rz; // to the right
  const vA = s.vy;
  const air = Math.hypot(ax0, az0);

  // The floor under the hub (the platform, a roof, the meadow): the height for ground effect, the soft landing
  // and the instruments.
  const floor = num(groundAt(s.x, s.z, s.y + H.STEP_UP));
  const h = Math.max(0, s.y - floor);
  s.floor = floor;
  s.h = h;

  // The engine: started by holding up on the ground, stopped by holding down there (or by a bump).
  const resting = s.ground || s.still > H.REST; // on a floor, or at rest on its boom or cabin
  if (!s.engine && resting && !down && liftIn > 0.3) {
    s.startHeld += dt;
    if (s.startHeld >= H.START_HOLD) {
      s.engine = true;
      s.ev |= EV.START;
    }
  } else s.startHeld = 0;
  if (s.engine && resting && liftIn < -0.3) {
    s.stopHeld += dt;
    if (s.stopHeld >= H.STOP_HOLD) {
      s.engine = false;
      s.ev |= EV.STOP;
    }
  } else s.stopHeld = 0;
  if (s.engine) s.rotor = Math.min(1, s.rotor + dt / H.SPOOL_UP);
  else if (!(down && !s.ground)) s.rotor = Math.max(0, s.rotor - dt / H.SPOOL_DOWN); // bumped in the air: it keeps turning until set down
  // Running up, the lever stays flat until the rotor is fast enough to lift.
  const avail = s.engine && s.rotor < H.LIFT_RPM ? 0 : s.rotor * s.rotor;

  // Thrust per unit of lever: ground effect, translational lift, the ceiling.
  const ge = h < H.GE_HEIGHT ? 1 + H.GE_GAIN * (1 - h / H.GE_HEIGHT) ** 2 * Math.max(0, 1 - air / H.GE_FADE) : 1;
  const tl = 1 + H.ETL_GAIN * smooth(H.ETL_V0, H.ETL_V1, air);
  const roof = Number.isFinite(ceiling) ? clamp((ceiling - s.y) / H.CEIL_FADE, 0, 1) : 1;
  const perLever = H.THRUST_MAX * G * avail * ge * tl * roof;
  const cosTilt = Math.cos(s.pitch) * Math.cos(s.roll);
  const dragV = H.DRAG_LIN * vA + H.DRAG_UP * vA * Math.abs(vA);

  // The lever, for the climb rate asked for.
  let lever = 0;
  let needUp = G; // the upward pull the climb rate asked for takes (m/s2): the lean gets what is left
  if ((s.engine || down) && !(s.ground && liftIn <= 0.05)) {
    let want;
    if (down) want = -Math.max(H.DOWN_SINK, h / 3);
    else if (liftIn > 0.05) {
      want = liftIn * H.CLIMB_MAX;
      s.heightHeld = false;
    } else if (liftIn < -0.05) {
      want = liftIn * H.SINK;
      s.heightHeld = false;
    } else if (!s.heightHeld) {
      // Let go: the climb or the sink stops first (twice as firmly), then it holds the height where it stopped (no bobbing back).
      want = 0;
      if (Math.abs(vA) < 0.3) {
        s.heightHeld = true;
        s.holdY = s.y;
      }
    } else want = clamp(H.HOLD_GAIN * (s.holdY - s.y), -H.SINK, H.CLIMB_MAX);
    want = Math.max(want, -(0.8 + 0.5 * h)); // near a floor: a soft touchdown
    // Still too fast to land: it skims a metre over the floor (more as its lean lowers the skids' ends) until it has slowed.
    const skim = 1.2 + -SKIDS[0][1] * Math.abs(Math.sin(s.pitch)) + (SKID_TRACK / 2) * Math.abs(Math.sin(s.roll));
    if (!down && Math.hypot(s.vx, s.vz) > H.LAND_SKID * 0.7) want = Math.max(want, H.HOLD_GAIN * 2 * (skim - h));
    needUp = Math.max(G, G + H.VS_RESP * (want - vA) + dragV);
    const need = (G + (s.heightHeld || liftIn !== 0 ? H.VS_RESP : 2 * H.VS_RESP) * (want - vA) + dragV) / Math.max(0.3, cosTilt);
    lever = perLever > 1e-6 ? clamp((need / perLever - H.LEVER_LOW) / (1 - H.LEVER_LOW), 0, 1) : 0;
  }
  s.coll = clamp(s.coll + clamp(lever - s.coll, -H.COLL_RATE * dt, H.COLL_RATE * dt), 0, 1);
  const T = perLever * (H.LEVER_LOW + (1 - H.LEVER_LOW) * s.coll);
  s.thrust = T / G;

  // The turn: a turn rate at a hover, a banked turn at speed.
  const blend = smooth(H.YAW_BLEND0, H.YAW_BLEND1, air);
  const fast = Math.min(H.YAW_FAST, (G * Math.tan(H.BANK * 0.9)) / Math.max(1, air));
  let yawCmd = -turnIn * (H.YAW_SLOW + (fast - H.YAW_SLOW) * blend);
  // The speed over the ground it asks for, in its own frame.
  let tu = fwdIn > 0 ? fwdIn * H.V_TOP : fwdIn * H.V_SLOW;
  let tw = sideIn * H.V_SLOW;
  let tx = fx * tu + rx * tw;
  let tz = fz * tu + rz * tw;
  const idle = fwdIn === 0 && sideIn === 0;
  const pad = env?.pad;
  const overPad = pad && Math.hypot(pad.x - s.x, pad.z - s.z) < H.MAGNET_R && s.y - num(pad.y) < H.MAGNET_H && s.y - num(pad.y) > -1;
  if (down) tx = tz = tu = tw = 0;
  else if (idle && overPad) {
    // A pad's magnet: the hover drifts to its centre.
    const dx = pad.x - s.x, dz = pad.z - s.z;
    const d = Math.hypot(dx, dz) || 1;
    const v = Math.min(H.MAGNET_V, d * 0.8);
    tx = (dx / d) * v;
    tz = (dz / d) * v;
    s.holding = false;
  } else if (idle) {
    // Let go: hold the spot where it came to a stop.
    if (!s.holding && Math.hypot(s.vx, s.vz) < 1.5) {
      s.holding = true;
      s.holdX = s.x;
      s.holdZ = s.z;
    }
    if (s.holding) {
      tx = clamp(H.POS_GAIN * (s.holdX - s.x), -3, 3);
      tz = clamp(H.POS_GAIN * (s.holdZ - s.z), -3, 3);
    }
  } else s.holding = false;
  // What it takes: the speed's error, the target turning with the nose, and the drag at this speed.
  const dU = -(H.DRAG_LIN * uA + H.DRAG_FWD * uA * Math.abs(uA));
  const dW = -(H.DRAG_LIN * wA + H.DRAG_SIDE * wA * Math.abs(wA));
  const ffx = s.yawRate * (-tu * rx + tw * fx);
  const ffz = s.yawRate * (-tu * rz + tw * fz);
  const wantX = H.SPEED_GAIN * (tx - s.vx) + ffx - (fx * dU + rx * dW);
  const wantZ = H.SPEED_GAIN * (tz - s.vz) + ffz - (fz * dU + rz * dW);
  // Close over a floor it leans less, so the skids stay clear of it while it lifts off and lands.
  const low = 0.25 + 0.75 * smooth(0.5, 3, h);
  let pT = down ? 0 : clamp(Math.atan2(wantX * fx + wantZ * fz, G), -H.TILT * low, H.TILT * low);
  let rT = down ? 0 : clamp(Math.atan2(wantX * rx + wantZ * rz, G), -H.BANK * low, H.BANK * low);
  // Height first: lean only as far as the thrust left over from the climb asked for allows.
  if (perLever > 1e-6) {
    const most = Math.acos(clamp(needUp / perLever, 0, 0.995));
    const lean = Math.acos(clamp(Math.cos(pT) * Math.cos(rT), -1, 1));
    if (lean > most) {
      pT *= most / lean;
      rT *= most / lean;
    }
  }
  // On the skids it turns only with the rotor at speed (light on them).
  if (s.ground && s.rotor < H.LIFT_RPM) yawCmd = 0;
  // The nose goes only where the player turns it: no pull into the airflow (sideways flies sideways, a crosswind leans it).
  s.yawRate += (yawCmd - s.yawRate) * ease(H.YAW_RESP, dt);
  s.yaw = wrap(s.yaw + s.yawRate * dt);
  if (!s.ground) {
    const w2 = H.ATT_FREQ * H.ATT_FREQ;
    const c = 2 * H.ATT_DAMP * H.ATT_FREQ;
    s.pitchRate += (w2 * (pT - s.pitch) - c * s.pitchRate) * dt;
    s.rollRate += (w2 * (rT - s.roll) - c * s.rollRate) * dt;
    s.pitch += s.pitchRate * dt;
    s.roll += s.rollRate * dt;
  }

  // The forces: thrust along the mast, gravity, drag on each of its axes through the air.
  const sp = Math.sin(s.pitch), cp = Math.cos(s.pitch), sr = Math.sin(s.roll), cr = Math.cos(s.roll);
  const tH = T * cp * sr;
  const lift = T * cp * cr - G;
  s.vx += (T * sp * fx + tH * rx + fx * dU + rx * dW) * dt;
  s.vz += (T * sp * fz + tH * rz + fz * dU + rz * dW) * dt;
  s.vy += (lift - dragV) * dt;

  // The hard limits: the edge, the top speed, the climb and the sink.
  s.atEdge = false;
  const edge = env?.edge;
  if (edge && Number.isFinite(edge.nx) && Number.isFinite(edge.nz)) {
    const d = (s.x - num(edge.x)) * edge.nx + (s.z - num(edge.z)) * edge.nz;
    const out = -(s.vx * edge.nx + s.vz * edge.nz);
    const allowed = H.V_CAP * clamp(d / H.EDGE_PAD, 0, 1);
    if (out > allowed) {
      s.vx += edge.nx * (out - allowed);
      s.vz += edge.nz * (out - allowed);
      if (d < H.EDGE_PAD * 0.5) {
        s.atEdge = true;
        s.ev |= EV.EDGE;
      }
    }
    if (d < 0) {
      // Outside (the edge moved in round it): back in, gently.
      s.vx += edge.nx * Math.min(2, -d) * dt * 4;
      s.vz += edge.nz * Math.min(2, -d) * dt * 4;
    }
  }
  const gv = Math.hypot(s.vx, s.vz);
  if (gv > H.V_CAP) {
    s.vx *= H.V_CAP / gv;
    s.vz *= H.V_CAP / gv;
  }
  s.vy = clamp(s.vy, -H.SINK_CAP, H.CLIMB_MAX);
  s.x += s.vx * dt;
  s.z += s.vz * dt;
  s.y += s.vy * dt;
  s.atCeiling = false;
  if (s.y > ceiling) {
    s.y = ceiling;
    s.vy = Math.min(0, s.vy);
  }
  if (Number.isFinite(ceiling) && ceiling - s.y < H.CEIL_FADE && liftIn > 0.05) {
    s.atCeiling = true;
    s.ev |= EV.CEILING;
  }

  contact(s, groundAt, lift, dt);

  // A little shudder in the translational-lift band (15 to 50 km/h): felt in the camera and the sound.
  const band = smooth(H.ETL_V0 - 1.5, H.ETL_V0 + 1.5, air) * (1 - smooth(H.ETL_V1 - 2, H.ETL_V1 + 2, air));
  s.shake = s.ground ? 0 : 0.3 * band * smooth(0.2, 0.5, s.coll);
  // The time down counts once it has come to rest, wherever: on a floor, or on its boom or cabin on a roof or a wall's
  // top (the page's walls hold it there), so a bump never leaves it hanging.
  s.still = Math.hypot(s.vx, s.vz) < 0.3 && Math.abs(s.vy) < 0.3 ? s.still + dt : 0;
  if (s.down > 0 && (s.ground || s.still > H.REST)) s.down = Math.max(0, s.down - dt);

  // Never a broken state: anything not finite puts it level and still where it was holding.
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'roll', 'pitchRate', 'rollRate', 'yawRate', 'rotor', 'coll']) {
    if (!Number.isFinite(s[k])) s[k] = k === 'x' ? num(s.holdX) : k === 'z' ? num(s.holdZ) : k === 'y' ? num(s.holdY) : 0;
  }
  return s;
}

/**
 * The skids against the floors under them: the plane through the four points' floors, resting on it (pitch and roll
 * eased to it), the touchdown by its sink speed, the slide down a slope, friction. `lift` is the thrust's upward pull
 * less gravity (m/s2): above zero it lifts off.
 */
function contact(s, groundAt, lift, dt) {
  const H = HELI;
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
  const rx = -fz, rz = fx;
  const sp = Math.sin(s.pitch), sr = Math.sin(s.roll);
  const g = [0, 0, 0, 0];
  let minC = Infinity;
  for (let i = 0; i < 4; i++) {
    const [lx, lz] = SKIDS[i];
    const ahead = -lz;
    const py = s.y - ahead * sp - lx * sr;
    g[i] = num(groundAt(s.x + rx * lx + fx * ahead, s.z + rz * lx + fz * ahead, py + H.STEP_UP));
    minC = Math.min(minC, py - g[i]);
  }
  const wasGround = s.ground;
  if (!(minC < 0 || (minC < 0.03 && s.vy <= 0.05 && wasGround))) {
    if (wasGround) s.ev |= EV.LIFTOFF;
    s.ground = false;
    return;
  }
  // The floor's plane under the skids (front left, front right, rear left, rear right).
  const pitchG = Math.atan2((g[2] + g[3] - g[0] - g[1]) / 2, SKID_LENGTH);
  const rollG = Math.atan2((g[0] + g[2] - g[1] - g[3]) / 2, SKID_TRACK);
  const slope = Math.acos(clamp(Math.cos(pitchG) * Math.cos(rollG), -1, 1));
  if (minC < 0) s.y -= minC; // out of the floor
  const sink = -s.vy;
  if (slope > H.SLOPE_MAX) {
    // Half on and half off (or on a steep roof): it does not settle; the lever holds it there or lifts it off.
    s.vy = Math.max(0, s.vy);
    if (wasGround) s.ev |= EV.LIFTOFF;
    s.ground = false;
    return;
  }
  if (!wasGround) {
    const slide = Math.hypot(s.vx, s.vz);
    const lean = Math.acos(clamp(Math.cos(s.pitch - pitchG) * Math.cos(s.roll - rollG), -1, 1));
    if (s.down <= 0 && (sink > H.LAND_HARD || slide > H.LAND_SKID || (lean > H.LAND_TILT && (sink > 1 || slide > 2)))) {
      heliBump(s, Math.max(sink, slide));
      s.ground = true;
      s.vy = 0;
      return;
    }
    if (sink > H.LAND_SOFT && s.down <= 0) {
      s.vy = sink / 3; // a bounce: a third back
      s.ev |= EV.BOUNCE;
      s.hit = Math.max(s.hit, sink);
      return;
    }
    if (sink > 0.2) {
      s.ev |= EV.SETTLE;
      s.hit = Math.max(s.hit, sink);
    }
  }
  if (lift > 0.3 && s.vy >= 0) {
    // The rotor carries it: off the skids.
    if (wasGround) s.ev |= EV.LIFTOFF;
    s.ground = false;
    return;
  }
  s.ground = true;
  s.vy = Math.max(0, s.vy);
  // Resting: its pitch and roll follow the floor; the skids hold it (less as the rotor takes its weight).
  const k = ease(12, dt);
  s.pitch += (pitchG - s.pitch) * k;
  s.roll += (rollG - s.roll) * k;
  s.pitchRate = s.rollRate = 0;
  s.holdY = s.y;
  s.heightHeld = true;
  s.holdX = s.x;
  s.holdZ = s.z;
  const weight = clamp(-lift / G, 0, 1);
  const v = Math.hypot(s.vx, s.vz);
  if (v > 0) {
    const keep = Math.max(0, v - (0.6 * G * weight + 2) * dt) / v;
    s.vx *= keep;
    s.vz *= keep;
  }
  if (slope > H.SLOPE_SLIDE) {
    // Too steep to stand on: it slides downhill, at most 2 m/s, until it is flatter.
    let dx = fx * Math.sin(pitchG) + rx * Math.sin(rollG);
    let dz = fz * Math.sin(pitchG) + rz * Math.sin(rollG);
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    const add = Math.max(0, 2 - (s.vx * dx + s.vz * dz)) * ease(3, dt);
    s.vx += dx * add;
    s.vz += dz * add;
  }
}

/** A frame of `dt` seconds in steps of about 1/120 s (at most 240 of them), as the page and the tests run it. */
export function heliFly(s, input, env, dt) {
  if (!(dt > 0)) return s;
  const steps = Math.min(240, Math.max(1, Math.ceil(dt * 120)));
  for (let i = 0; i < steps; i++) heliStep(s, input, env, dt / steps);
  return s;
}
