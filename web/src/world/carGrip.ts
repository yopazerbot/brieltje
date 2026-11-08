/**
 * How a car's tyres hold the ground (world/car.ts), as plain numbers so node can test it. The car is two
 * wheels, one per axle (a bicycle model): each tyre pushes back sideways as it is turned against the way it
 * rolls, up to what the ground lets it (its grip), and that grip is shared with braking and pulling away
 * (the friction circle). The weight goes to the front when braking and to the back when speeding up, so
 * the front grips more and the back less as you brake into a turn.
 *
 * What comes out of it:
 * - mild understeer at the limit: corner too fast and the front lets go first, the car runs wide;
 * - ABS: the brakes never lock, so you can steer while braking hard;
 * - the handbrake locks the rear wheels: they slide whichever way they go, so the car stops hard in a
 *   straight line, and with the wheel turned the back swings round (a handbrake turn);
 * - grip from the ground (surfaceGrip): asphalt, cobbles, gravel, grass; less when it is wet or snowy.
 *
 * Signs in the car's own frame: u forward, s to the right, r turning right (rad/s), the front wheels'
 * angle `delta` to the right.
 */

export const G = 9.81;
/** kg: a Model Y and a Model 3 are close enough to share it. */
export const MASS = 1950;
/** m: the front and the rear axle from the centre of mass (half the wheelbase each: about 50/50 on the axles). */
const A = 1.445;
const B = 1.445;
/** m: the centre of mass above the road (a Tesla's battery sits low). */
const H = 0.55;
/** kg m2: how hard it is to turn the car about its middle. */
export const YAW_INERTIA = MASS * A * B;
/** The tyre's curve (a simplified "magic formula"): stiffness and shape. It peaks at about 10 degrees of slip, then drops to about 85% sliding. */
const STIFF = 12;
const SHAPE = 1.33;
/** The slip angle (rad) at the peak of that curve. */
export const PEAK_SLIP = Math.tan(Math.PI / 2 / SHAPE) / STIFF;
/** m/s: under this the tyres' slip angles are worked out as if at this speed (they mean nothing at a crawl). */
const U_MIN = 3;
/** ABS and the traction control hold each axle's pull or braking to this much of its grip, so a wheel never locks or spins. */
export const ABS_CAP = 0.93;
/** A locked tyre sliding grips this much of a rolling one at its peak. */
const LOCKED = 0.7;

/**
 * How well the tyres grip (1 is dry asphalt, about 1 g) on the ground under them: the block's material
 * name, or none for the bare ground (grass). `wet` and `snow` 0 to 1 (world/mood.ts: mood.wet, mood.snow).
 */
const SURFACES: [RegExp, number, number][] = [
  // [the material, its grip dry, its grip wet]
  [/mud|sand/i, 0.4, 0.3],
  [/grass|lawn|meadow|field|earth|soil|garden|hedge|leaves|moss|forest|wood_floor/i, 0.55, 0.42],
  [/gravel|dirt|grit/i, 0.65, 0.55],
  [/cobble|sett|klinker|old_stone|brick|track/i, 0.85, 0.6],
];
export function surfaceGrip(mat: string | undefined, wet: number, snow: number): number {
  let dry = 0.55;
  let damp = 0.42;
  if (mat) {
    [dry, damp] = [1, 0.7]; // asphalt, concrete, paving
    for (const [re, d, w] of SURFACES) {
      if (re.test(mat)) {
        [dry, damp] = [d, w];
        break;
      }
    }
  }
  const k = Math.min(1, Math.max(0, Number.isFinite(wet) ? wet : 0));
  const white = Math.min(1, Math.max(0, Number.isFinite(snow) ? snow : 0));
  return (dry + (damp - dry) * k) * (1 - 0.45 * white);
}

export interface TyreIn {
  /** m/s along the car (> 0 forward) */
  u: number;
  /** m/s to the car's right */
  s: number;
  /** rad/s, turning right */
  r: number;
  /** rad: the front wheels, to the right */
  delta: number;
  /** N the motors ask for along the car (> 0 forward), split over the two axles */
  drive: number;
  /** N the brakes ask for (>= 0), against the way each wheel rolls; ABS shares it by the load on each axle */
  brake: number;
  /** The rear wheels locked by the handbrake */
  locked: boolean;
  /** The grip under the front and the rear wheels (surfaceGrip) */
  muF: number;
  muR: number;
  /** m/s2 the car speeds up along itself (last step's, smoothed): the weight moves to the back, or to the front braking */
  ax: number;
}

export interface TyreOut {
  /** N along the car and to its right, and N m turning it right */
  fx: number;
  fy: number;
  mz: number;
  /** m/s each axle's tyres slide over the ground past what they grip (0 while they hold): for the marks and the squeal */
  slideF: number;
  slideR: number;
  /** N along the wheels from the motors and brakes alone (at a crawl, where the car simply follows its front wheels) */
  roll: number;
}

/** A tyre's sideways force for its slip angle `a` (rad) and the grip `d` (N) it has left sideways. */
const lateral = (a: number, d: number) => -d * Math.sin(SHAPE * Math.atan(STIFF * a));
/** The sideways slip (m/s) that is more than a tyre takes gripping: past 80% of the peak's slip angle. */
const past = (vt: number, vl: number) => Math.max(0, Math.abs(vt) - Math.max(Math.abs(vl), U_MIN) * Math.tan(0.8 * PEAK_SLIP));

/** The forces of the two axles' tyres on the car this step. */
export function tyreForces(t: TyreIn): TyreOut {
  const ok = (x: number) => (Number.isFinite(x) ? x : 0);
  const u = ok(t.u);
  const s = ok(t.s);
  const r = ok(t.r);
  const delta = ok(t.delta);
  const L = A + B;
  // The weight on each axle, moved by speeding up or braking, never all off one.
  const ax = Math.max(-1.5 * G, Math.min(1.5 * G, ok(t.ax)));
  const nf = Math.max(0.15 * MASS * G, (MASS * (G * B - ax * H)) / L);
  const nr = Math.max(0.15 * MASS * G, (MASS * (G * A + ax * H)) / L);
  const capF = Math.max(0, ok(t.muF)) * nf;
  const capR = Math.max(0, ok(t.muR)) * nr;
  const drive = ok(t.drive);
  const brake = Math.max(0, ok(t.brake));
  // ABS shares the braking by the load on each axle; the rear's goes to its locked wheels instead.
  const brakeF = (brake * nf) / (nf + nr);
  const brakeR = (brake * nr) / (nf + nr);
  let slideF = 0;
  let slideR = 0;

  // The front wheels, turned by delta: how they move along and across themselves.
  const c = Math.cos(delta);
  const sn = Math.sin(delta);
  const vfy = s + A * r;
  const vl = u * c + vfy * sn;
  const vt = -u * sn + vfy * c;
  const roll = (v: number) => (v > 0.05 ? 1 : v < -0.05 ? -1 : v / 0.05); // which way a wheel rolls (soft at a standstill)
  /**
   * A rolling axle (along vl, across vt, its grip cap, the pull or braking `want` along it): ABS and the
   * traction control hold the pull or braking under ABS_CAP of the grip, and the more the tyre is turned
   * against its way the less, so a braking car still steers. Its pull along, its push across, how it slides.
   */
  const axle = (vl: number, vt: number, cap: number, want: number) => {
    const a = Math.atan2(vt, Math.max(Math.abs(vl), U_MIN));
    const most = ABS_CAP * (1 - 0.35 * Math.min(1, Math.abs(a) / PEAK_SLIP)) * cap;
    const along = Math.max(-most, Math.min(most, want));
    const slide = past(vt, vl) + (Math.abs(want) > most && brake > 0 ? 0.12 * Math.abs(vl) : 0); // ABS working: a faint chirp
    return { along, across: lateral(a, Math.sqrt(Math.max(0, cap * cap - along * along))), slide };
  };
  const front = axle(vl, vt, capF, (t.locked ? 0 : drive / 2) - brakeF * roll(vl));
  const fl = front.along;
  const ft = front.across;
  slideF = front.slide;
  const fxF = fl * c - ft * sn;
  const fyF = fl * sn + ft * c;

  // The rear wheels: rolling, or locked and sliding against the way they go.
  const vrx = u;
  const vry = s - B * r;
  let fxR: number;
  let fyR: number;
  if (t.locked) {
    const v = Math.hypot(vrx, vry);
    const k = (LOCKED * capR * Math.min(1, v / 0.5)) / Math.max(v, 1e-6);
    fxR = -vrx * k;
    fyR = -vry * k;
    slideR = v;
  } else {
    const rear = axle(vrx, vry, capR, drive / 2 - brakeR * roll(vrx));
    fxR = rear.along;
    fyR = rear.across;
    slideR = rear.slide;
  }
  return { fx: fxF + fxR, fy: fyF + fyR, mz: A * fyF - B * fyR, roll: fl + fxR, slideF, slideR };
}
