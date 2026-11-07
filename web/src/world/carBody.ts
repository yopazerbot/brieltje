/**
 * How a car's body moves on its springs (world/car.ts), as plain numbers so node can test it. The body
 * pitches back when the car speeds up, dips when it brakes and rolls out of a turn; a kerb under a wheel
 * gives it a knock; then it settles on a damped spring, a little bouncy, as a heavy car does. It is only
 * drawn: every page works it out from the car's own motion (for a car someone else drives, from the
 * smoothed track), so nothing about it goes over the network.
 *
 * Signs as the car's group has them (nose along -z, right along +x): pitch > 0 lifts the nose, roll > 0
 * lifts the right side, heave > 0 lifts the body.
 */

/** The most the body pitches (rad, about 2.9 degrees) and rolls (about 4.3 degrees) from braking, speeding up and turning. */
export const PITCH_MAX = 0.05;
export const ROLL_MAX = 0.075;
/** Body angle per m/s2: about 2.5 degrees nose down when braking at 9 m/s2, about 3 degrees of roll at 0.8 g in a turn. */
const PITCH_GAIN = 0.005;
const ROLL_GAIN = 0.0068;
/** The springs: natural frequency (rad/s) and damping ratio. Under 1, so it overshoots once and settles. */
const PITCH_W = 9;
const ROLL_W = 8;
const HEAVE_W = 11;
const DAMP = 0.5;
/** The longest step the springs take at once (s); a longer frame is cut into these. */
const SUB = 1 / 120;
/** A frame longer than this (s, a tab in the background) only moves the springs this far. */
const DT_MAX = 0.1;

/** A target that saturates softly at ±max instead of being cut off. */
const soft = (x: number, max: number) => max * Math.tanh(x / max);

export class CarBody {
  pitch = 0;
  roll = 0;
  heave = 0;
  private vPitch = 0;
  private vRoll = 0;
  private vHeave = 0;

  /**
   * One frame: `along` the car's acceleration along its heading (m/s2, > 0 speeding up), `across` its
   * acceleration to the right (m/s2, > 0 in a right turn: speed times turn rate).
   */
  step(dt: number, along: number, across: number): void {
    if (!(dt > 0)) return;
    const pitchTo = soft((Number.isFinite(along) ? along : 0) * PITCH_GAIN, PITCH_MAX);
    // Turning right (pulled to the right, across > 0) the body leans out to the left: its right side comes up.
    const rollTo = soft((Number.isFinite(across) ? across : 0) * ROLL_GAIN, ROLL_MAX);
    const t = Math.min(dt, DT_MAX);
    const n = Math.ceil(t / SUB);
    const h = t / n;
    for (let i = 0; i < n; i++) {
      // Semi-implicit Euler: the speed first, then the angle with the new speed (stable for w*h < 2).
      this.vPitch += (PITCH_W * PITCH_W * (pitchTo - this.pitch) - 2 * DAMP * PITCH_W * this.vPitch) * h;
      this.pitch += this.vPitch * h;
      this.vRoll += (ROLL_W * ROLL_W * (rollTo - this.roll) - 2 * DAMP * ROLL_W * this.vRoll) * h;
      this.roll += this.vRoll * h;
      this.vHeave += (HEAVE_W * HEAVE_W * -this.heave - 2 * DAMP * HEAVE_W * this.vHeave) * h;
      this.heave += this.vHeave * h;
    }
    // Never further than twice the usual most, and never not a number.
    if (!Number.isFinite(this.pitch + this.roll + this.heave + this.vPitch + this.vRoll + this.vHeave)) this.reset();
    this.pitch = Math.max(-2 * PITCH_MAX, Math.min(2 * PITCH_MAX, this.pitch));
    this.roll = Math.max(-2 * ROLL_MAX, Math.min(2 * ROLL_MAX, this.roll));
    this.heave = Math.max(-0.08, Math.min(0.08, this.heave));
  }

  /** A knock from below (a kerb under a wheel): speeds given to the springs, in rad/s and m/s. */
  kick(pitch: number, roll: number, heave: number): void {
    if (!Number.isFinite(pitch + roll + heave)) return;
    this.vPitch += Math.max(-0.6, Math.min(0.6, pitch));
    this.vRoll += Math.max(-0.6, Math.min(0.6, roll));
    this.vHeave += Math.max(-0.4, Math.min(0.4, heave));
  }

  /** At rest at once (through a portal, back in the game). */
  reset(): void {
    this.pitch = this.roll = this.heave = this.vPitch = this.vRoll = this.vHeave = 0;
  }
}

/**
 * The ground's plane under the four wheels: how high each wheel's ground is above the car's own height
 * (m; front left, front right, rear left, rear right), the distance between the axles and between the
 * wheels. Returns the plane's pitch and roll (rad, signs as above), its height in the middle, and the
 * twist the plane can't follow, which each wheel's spring takes (front left and rear right up by it, the
 * other two down).
 */
export function groundPlane(h: readonly number[], wheelbase: number, track: number): { pitch: number; roll: number; lift: number; twist: number } {
  const [fl, fr, rl, rr] = h;
  return {
    pitch: Math.atan2((fl + fr - rl - rr) / 2, wheelbase),
    roll: Math.atan2((fr + rr - fl - rl) / 2, track),
    lift: (fl + fr + rl + rr) / 4,
    twist: (fl - fr - rl + rr) / 4,
  };
}

/**
 * How hard the tyres slide (0 to 1), for the marks they leave and their squeal: `speed` along the car
 * (m/s), `side` sideways (m/s), `along` and `across` its accelerations (m/s2), `handbrake` pulled (only
 * known for the car you drive). The rear tyres let go first.
 */
export function skid(speed: number, side: number, along: number, across: number, handbrake: boolean): { front: number; rear: number } {
  const v = Math.abs(speed);
  if (!(v > 2)) return { front: 0, rear: 0 };
  const clamp = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
  const slide = clamp((Math.abs(side) - 1.2) / 3);
  const turn = v > 6 ? clamp((Math.abs(across) - 9) / 6) : 0;
  // Only the hardest stops from 40 km/h up (it brakes at about 9 m/s2 flat out).
  const stop = v > 11 ?0.75 * clamp((-along * Math.sign(speed) - 7.5) / 2.5) : 0;
  const pulled = handbrake && v > 3 ? 0.9 * clamp(v / 10) : 0;
  return { front: Math.max(0.8 * turn, stop, 0.5 * slide), rear: Math.max(slide, turn, 0.8 * stop, pulled) };
}
