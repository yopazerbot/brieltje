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

import { homeAt, inEndGarden } from './homes.mjs';

/** Every number of the flight in one place (why they are what they are: DECISIONS.md, the helicopter's rows). */
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
  ATT_DAMP: 1, // its damping (1: no overshoot: the swing back past level after a turn)
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
  YAW_SLOW: 1.4, // rad/s: the turn at a hover at full turn (the turn key alone: on the spot) ...
  YAW_GO: 0.85, // rad/s: ... and with forward or back held full from a hover (picking up speed: a widening curve)
  YAW_FAST: 0.45, // rad/s: the most at speed (less when the bank can't hold it: BANK)
  YAW_BLEND0: 12, // m/s: from here the turn becomes a banked one ...
  YAW_BLEND1: 25, // m/s: ... and by here it is one
  YAW_RESP: 6, // 1/s: how fast the turn follows the key (the tail rotor) ...
  YAW_STOP: 18, // 1/s: ... and how firmly it stops when the key is let go (the nose coasts on about 4 degrees from a hover turn)
  TURN_SLOW: 0.35, // a held turn at speed asks for this much less speed (a full circle at cruise about 120 m across, not 300)
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
  REST: 0.5, // s still while the page holds it up (resting on its boom or cabin), before that counts as at rest
  RIDGE: 0.3, // m: a floor under the hub this far over the skids' plane (a roof's ridge through the cabin floor): no settling
  STRIKES: 3, // rotor strikes ...
  STRIKE_WINDOW: 3, // s: ... inside this long, or one faster than STRIKE_HARD, are a bump
  STRIKE_HARD: 6, // m/s
  BODY_HARD: 4, // m/s: the fuselage into a wall faster than this is a bump
  STEP_UP: 0.6, // m: a skid finds a floor up to this over it
  CAM_DIST: 11.5, // m: the chase camera behind the hub (14 before 15 Nov: the machine a twentieth of the screen) ...
  CAM_SPEED: 0.08, // s: ... and this much further per m/s
  CAM_UP: 2.6, // m: it looks at this over the origin
  CAM_SIDE: 1.2, // m: and stands this far to the right, so the livery shows, not only the tail fin
  CAM_PITCH: 0.26, // rad: down from behind (the ground ahead stays in view)
  CAM_FOLLOW: 3, // 1/s: how fast it comes round behind the nose
  CAM_LAND: [12, 0.6], // m, rad: low and slow, nearer and steeper
  MAGNET_R: 4, // m: within this of a pad's centre ...
  MAGNET_H: 6, // m: ... and this low over it, with the sticks let go ...
  MAGNET_V: 1, // m/s: ... the hover drifts to the centre at this
};

/** Where the skids rest on the ground: the model's x (right) and z (back) of the four contact points (docs/helicopter/README.md). */
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
    holdY: y, holdX: x, holdZ: z, holding: false, heightHeld: true, startHeld: 0, stopHeld: 0, still: 0, held: false,
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
    holdY: y, holdX: x, holdZ: z, holding: false, heightHeld: true, held: false, still: 0, rotor, engine: rotor >= HELI.LIFT_RPM, coll: 0, floor: y, h: 0 });
  return s;
}

/**
 * A steady hover at (x, y, z) facing `yaw`: still, level, the rotor at full speed and the engine on, holding that spot
 * and that height, the lever where a hover keeps it. Together, a passenger who takes the stick of a machine hanging in
 * the air, or a pilot whose step the server put back (src/heliPilot.ts), flies on from there.
 */
export function heliHover(s, x, y, z, yaw) {
  const coll = clamp((1 / HELI.THRUST_MAX - HELI.LEVER_LOW) / (1 - HELI.LEVER_LOW), 0, 1);
  Object.assign(s, { x, y, z, yaw, vx: 0, vy: 0, vz: 0, pitch: 0, roll: 0, pitchRate: 0, rollRate: 0, yawRate: 0, ground: false, down: 0,
    holdY: y, holdX: x, holdZ: z, holding: true, heightHeld: true, held: false, still: 0, startHeld: 0, stopHeld: 0, rotor: 1, engine: true, coll });
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
  const resting = s.ground || s.still > H.REST; // on a floor, or at rest on its boom or cabin (never a hover: `still` counts only while held)
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
  // At a hover the turn key turns it on the spot; moving, no faster than the bank can carry the speed it has (so W with
  // a turn key from a hover flies a widening curve), and at speed a banked turn, the nose following the bank.
  const blend = smooth(H.YAW_BLEND0, H.YAW_BLEND1, air);
  const ground = Math.hypot(s.vx, s.vz);
  const carried = (G * Math.tan(H.BANK * 0.9)) / Math.max(1, ground);
  // Asking for speed from a hover (forward or back held) it turns less: a widening curve, not a spin on the spot.
  const going = Math.abs(fwdIn) * (1 - blend);
  let yawCmd = -turnIn * Math.min(H.YAW_SLOW - (H.YAW_SLOW - H.YAW_GO) * going, carried, H.YAW_SLOW + (H.YAW_FAST - H.YAW_SLOW) * blend);
  // The speed over the ground it asks for, in its own frame.
  // A held turn at speed asks for less speed, so the circle is tighter and the bank holds it.
  let tu = (fwdIn > 0 ? fwdIn * H.V_TOP : fwdIn * H.V_SLOW) * (1 - H.TURN_SLOW * Math.abs(turnIn) * blend);
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
    // A long deck's pull turns the nose to its line too, the nearer way round: the tail never rests on its end rails.
    if (pad.long && turnIn === 0) yawCmd = clamp(3 * wrap(pad.yaw + Math.PI * Math.round(wrap(s.yaw - pad.yaw) / Math.PI) - s.yaw), -H.YAW_SLOW, H.YAW_SLOW);
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
  // The turn carries the speed it has (not the speed asked for) round with the nose: from a hover W with a turn key
  // flies a widening curve, not a pirouette on the bank.
  const u = s.vx * fx + s.vz * fz, w = s.vx * rx + s.vz * rz;
  const turning = down ? 0 : yawCmd;
  const ffx = turning * (-u * rx + w * fx);
  const ffz = turning * (-u * rz + w * fz);
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
  // At speed the nose follows the bank it has (a co-ordinated turn: no slip to swing back from when you let go).
  // Only while turning or unwinding a turn: flying sideways or leaning into a crosswind turns nothing.
  const fwdSpeed = Math.max(0, u);
  const coord = -(G * Math.tan(s.roll)) / Math.max(5, fwdSpeed);
  const inTurn = Math.abs(yawCmd) > 1e-3 || Math.abs(s.yawRate) > 0.005;
  const aim = s.ground || !inTurn ? yawCmd : yawCmd + (coord - yawCmd) * smooth(H.YAW_BLEND0, H.YAW_BLEND1, fwdSpeed);
  const stopping = Math.abs(aim) < Math.abs(s.yawRate) - 1e-6;
  s.yawRate += (aim - s.yawRate) * ease(stopping ? H.YAW_STOP : H.YAW_RESP, dt);
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
    if (d < 0 && !s.ground) {
      // Outside (the edge moved in round it): back in, gently; standing (its pad outside a game's fence) it stays.
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

  contact(s, groundAt, lift, dt, floor);

  // A little shudder in the translational-lift band (15 to 50 km/h): felt in the camera and the sound.
  const band = smooth(H.ETL_V0 - 1.5, H.ETL_V0 + 1.5, air) * (1 - smooth(H.ETL_V1 - 2, H.ETL_V1 + 2, air));
  s.shake = s.ground ? 0 : 0.3 * band * smooth(0.2, 0.5, s.coll);
  // The time down counts once it has come to rest, wherever: on a floor, or on its boom or cabin on a roof or a wall's
  // top, so a bump never leaves it hanging. `held`: the page's walls hold it up there (world/heli.ts); a steady hover
  // is never at rest.
  s.still = s.held && Math.hypot(s.vx, s.vz) < 0.3 && Math.abs(s.vy) < 0.3 ? s.still + dt : 0;
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
function contact(s, groundAt, lift, dt, floor) {
  const H = HELI;
  // The floor under the hub over the skids' level there (a roof's ridge between them): it holds the cabin up, and the
  // machine doesn't settle on it.
  if (floor - s.y > H.RIDGE) {
    s.y = floor - H.RIDGE;
    s.vy = Math.max(s.engine ? 0.5 : 0, s.vy);
    if (s.engine) {
      s.holdY = Math.max(s.holdY, s.y + 0.6);
      s.heightHeld = true;
    }
    if (s.ground) s.ev |= EV.LIFTOFF;
    s.ground = false;
    return;
  }
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
  // The floor under the hub against the skids' plane there: a roof's ridge through the cabin floor.
  const front = (g[0] + g[1]) / 2, rear = (g[2] + g[3]) / 2;
  const planeAtHub = rear + (front - rear) * (SKIDS[2][1] / SKID_LENGTH);
  const ridge = floor - planeAtHub > H.RIDGE;
  if (slope > H.SLOPE_MAX || ridge) {
    // Half on and half off, a steep roof, or a ridge under the cabin: it does not settle. Over a ridge the cabin stays
    // clear of it; flying, it holds off a little (it doesn't hang against the tiles) until it is moved or lifted off.
    if (ridge) s.y = Math.max(s.y, floor - 0.25);
    s.vy = Math.max(s.engine ? 0.5 : 0, s.vy);
    if (s.engine) {
      s.holdY = Math.max(s.holdY, s.y + 0.6);
      s.heightHeld = true;
    }
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

/**
 * Where you stand after getting out (the page's exit; shared so a test can sweep it): by a step (the model's Step_L and
 * Step_R, `steps` as [x right, z back]), then behind them, then before and behind the machine, on the floor it stands on
 * (within 0.5 m) and free (`free(x, z, feet)`: room for a person there); with no room beside it, on that same floor at
 * the hub. Never lower than that floor (no dropping through a roof it stands on), and never inside a private home or the
 * end house's fenced garden (shared/homes.mjs, the homes' own data: a new home there is covered too). Null when there
 * is no such place: the pilot stays aboard. The floor it stands on: its skids' floor, or resting on its boom or cabin,
 * the floor under its hub.
 */
export function heliExit(s, steps, ground, free) {
  const stand = s.ground ? s.y : s.floor;
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
  const rx = -fz, rz = fx;
  const outside = (x, y, z) => homeAt(x, z, y) === null && !inEndGarden(x, z, y);
  const local = [...steps.map(([x, z]) => [x + Math.sign(x) * 0.15, z]), ...steps.map(([x, z]) => [x + Math.sign(x) * 0.15, z + 1.4]), [0, -4], [0, 8]];
  // The way there from the hub, every 5 cm: no floor higher than a step in it (a rail's top) and, every 25 cm, room for
  // a body (`free`: a wall of any height), so you never step out across a deck's rail onto the roof beside it (the
  // church's landing deck: shared/church.json) nor through a wall.
  const clear = (px, pz) => {
    const n = Math.ceil(Math.hypot(px - s.x, pz - s.z) / 0.05);
    for (let i = 1; i < n; i++) {
      const qx = s.x + ((px - s.x) * i) / n, qz = s.z + ((pz - s.z) * i) / n;
      if (num(ground(qx, qz, stand + 2)) > stand + 0.5 || (i % 5 === 0 && !free(qx, qz, stand))) return false;
    }
    return true;
  };
  for (const [x, z] of local) {
    const px = s.x + rx * x - fx * z, pz = s.z + rz * x - fz * z;
    const g = num(ground(px, pz, stand + 0.5));
    if (Math.abs(g - stand) > 0.5 || !outside(px, g, pz) || !free(px, pz, g) || !clear(px, pz)) continue;
    return { x: px, y: g, z: pz };
  }
  return outside(s.x, stand, s.z) ? { x: s.x, y: stand, z: s.z } : null;
}

/** A body frame point (x right, y up, z back, metres from the origin) of the machine `s` in the world, as world/heli.ts poses it. */
export function heliToWorld(s, x, y, z) {
  // The body's rotation is Euler (-pitch, yaw, -roll) in the order YXZ: R = Ry(yaw) Rx(-pitch) Rz(-roll).
  const cr = Math.cos(-s.roll), sr = Math.sin(-s.roll);
  const x1 = x * cr - y * sr, y1 = x * sr + y * cr, z1 = z;
  const cp = Math.cos(-s.pitch), sp = Math.sin(-s.pitch);
  const y2 = y1 * cp - z1 * sp, z2 = y1 * sp + z1 * cp, x2 = x1;
  const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
  return { x: s.x + x2 * cy + z2 * sy, y: s.y + y2, z: s.z - x2 * sy + z2 * cy };
}

/** A world point in the machine's body frame (the inverse of heliToWorld). */
export function heliToBody(s, x, y, z) {
  const dx = x - s.x, dy = y - s.y, dz = z - s.z;
  const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
  const x2 = dx * cy - dz * sy, z2 = dx * sy + dz * cy, y2 = dy;
  const cp = Math.cos(-s.pitch), sp = Math.sin(-s.pitch);
  const y1 = y2 * cp + z2 * sp, z1 = -y2 * sp + z2 * cp, x1 = x2;
  const cr = Math.cos(-s.roll), sr = Math.sin(-s.roll);
  return { x: x1 * cr + y1 * sr, y: -x1 * sr + y1 * cr, z: z1 };
}

/**
 * Where a jump from the helicopter starts (src/heliPilot.ts): out of the door on the side that is down (the pilot's,
 * the right, when it flies level), beside the step (its z), past the tail's stabiliser by a body's width and more, the
 * feet at the skids' level: so the fall goes away from the cabin and under the rotor's disc, and the tail passes
 * outside. `size`: heli.json's. Returns the feet's place, the side (1 right, -1 left) and the unit vector across, away
 * from the cabin, for the step out (shared/parachute.mjs jumpStart).
 */
export function heliJump(s, size) {
  // Flying sideways the machine would catch you up on that side (your fall keeps less of its speed): out of the other.
  const across = s.vx * Math.cos(s.yaw) - s.vz * Math.sin(s.yaw);
  const side = Math.abs(across) > 2 ? -Math.sign(across) : s.roll < 0 ? -1 : 1;
  const out = size.stabiliser.halfX + JUMP_CLEAR;
  const z = size.steps[side > 0 ? 1 : 0][1];
  const at = heliToWorld(s, side * out, 0, z);
  at.y = Math.min(at.y, s.y); // banked away from you, the door's side is high: you start no higher than the skids' level
  const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw); // the machine's right on the plan
  // Banked, a body standing upright there leans into the cabin with its head: further out, 10 cm at a time, until
  // it is clear by a body's radius.
  for (let i = 0; i < 30 && heliGap(s, size, at.x, at.y, at.z) < JUMP_CLEAR - 0.3; i++) {
    at.x += rx * side * 0.1;
    at.z += rz * side * 0.1;
  }
  return { x: at.x, y: at.y, z: at.z, side, push: [rx * side, rz * side] };
}
/** m: a jump starts this far out past the stabiliser's tip (a body's radius, 0.3, and as much again). */
export const JUMP_CLEAR = 0.6;

/**
 * Nobody aboard after a jump (world/heli.ts away): the machine flies itself home. It climbs away at full up at once
 * (never falling on you or the village) and keeps the way it flew for `keep` s, so it doesn't lean over onto you as it
 * would braking hard; then hands off it eases to a hover, still climbing (up to the ceiling, where it hovers); from
 * `home` s, once out of your sight, it is back on its pad (src/heliPilot.ts). Still watched at `latest` s, it flies off:
 * away from you and up through the ceiling, drawn out to `far` m, a speck in the haze; it is put home once out of sight
 * or that far off, or `leave` s later whatever. It never vanishes while drawn near.
 */
export const AWAY = { keep: 1, home: 3, latest: 45, leave: 60, far: 1500 };
/** The machine's sticks as it flew at the jump (`s`): forward and sideways for the speed it had, in its own frame. */
export function awayKeep(s) {
  const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
  const u = s.vx * fx + s.vz * fz, w = s.vx * -fz + s.vz * fx;
  return { fwd: clamp(u >= 0 ? u / HELI.V_TOP : u / HELI.V_SLOW, -1, 1), side: clamp(w / HELI.V_SLOW, -1, 1) };
}
/** The machine's input `t` s after a jump left it (`keep`: awayKeep at the jump). */
export const awayInput = (t, keep) => (t < AWAY.keep ? { ...keep, lift: 1 } : { lift: 1 });

/**
 * How far (m) a standing body (`r` round, from `feet` to `feet + height`, in the world) is from the machine `s`: its
 * cabin, skids, boom, fin, stabiliser and the rotor's disc as boxes in its own frame (heli.json's sizes). Under 0:
 * inside. For the jump's test: the jump never passes through any of them.
 */
export function heliGap(s, size, x, feet, z, r = 0.3, height = 1.8) {
  const c = size.cabin, b = size.boom, t = size.stabiliser;
  const boxes = [
    [-c.halfX, c.y0, c.z0, c.halfX, c.y1, c.z1], // the cabin and the cowling
    [-size.skidX, 0, SKIDS[0][1] - 0.4, size.skidX, c.y0, SKIDS[2][1] + 0.4], // the skids and their struts
    [-b.halfX, b.y0, b.z0, b.halfX, b.y1, b.z1], // the boom, the fin and the tail rotor
    [-t.halfX, t.y0, t.z0, t.halfX, t.y1, t.z1], // the stabiliser with its end plates
  ];
  let gap = Infinity;
  for (let i = 0; i <= 6; i++) {
    const p = heliToBody(s, x, feet + (height * i) / 6, z);
    for (const [x0, y0, z0, x1, y1, z1] of boxes) {
      const dx = Math.max(x0 - p.x, 0, p.x - x1), dy = Math.max(y0 - p.y, 0, p.y - y1), dz = Math.max(z0 - p.z, 0, p.z - z1);
      gap = Math.min(gap, Math.hypot(dx, dy, dz) - r);
    }
    // The rotor's disc: a slab 0.6 m thick round the mast at its height, out to the blades' tips.
    const out = Math.hypot(p.x, p.z) - size.rotor.r;
    const dy = Math.abs(p.y - size.rotor.y) - 0.3;
    gap = Math.min(gap, (out > 0 ? Math.hypot(out, Math.max(0, dy)) : Math.max(0, dy)) - r);
  }
  return gap;
}
