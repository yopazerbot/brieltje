/**
 * The view on foot moves with your body (Yoshi, 21 Nov 2026: "showing a bit of a dynamic movement while walking or
 * running instead of a steady screen"): the eye's path over the stride, a lean and a wider view when you sprint, a
 * lean into a start and a settle at a stop, a roll into a sidestep and a small give before a jump.
 *
 * Only the drawing moves. `draw` adds the offsets to the camera around the render and takes them off again after it,
 * so everything else in a frame (where a shot goes, hit tests, the minimap, what is sent to the server, the names over
 * the others) sees the camera where the game has it. The gun in your hands is a child of the camera and moves with the
 * eye; its own bob runs on the same stride (weapon.ts update, `stride`) against the eye's, so the two read as one body.
 * The crosshair is drawn where the shot goes in the moved picture (a few pixels off the middle as the view nods), so
 * it stays on its target and a shot lands on it.
 *
 * A setting, "Camera movement" (settings.ts motion): Off, Subtle (the default) or Full, 1.8 times Subtle. Off where the
 * device asks for less motion (prefers-reduced-motion). With touch controls about two thirds as much: a small screen
 * held in the hand takes less. Off keeps the view still: no stride, no leans, no wider view; the landing keeps a small
 * dip (player.ts) and the gun its own life. Aiming fades it out with the aim; through a scope none of it.
 * The view's own steps are what big shooters do (Xbox Accessibility Guideline 117 asks for such a setting, with a real
 * off): the eye's path is mostly up and down, side to side at half that rate, rotations of tenths of a degree.
 */
import * as THREE from 'three';

export type MotionLevel = 'off' | 'subtle' | 'full';
export const MOTION_LEVELS: readonly MotionLevel[] = ['off', 'subtle', 'full'];

const DEG = Math.PI / 180;

/**
 * Subtle on a computer (strength 1). Lengths in metres, angles in degrees, each the most either way (half the travel).
 * `walk` at 1.4 m/s, `sprint` at 3.5 m/s; in between eased from one to the other, slower than walking less.
 */
export const MOTION = {
  walk: { up: 0.012, side: 0.0045, roll: 0.3, nod: 0.2 },
  sprint: { up: 0.018, side: 0.0065, roll: 0.5, nod: 0.4 },
  /** Sprinting: the view leans forward (degrees) and widens (degrees at a 72 degree view, the player's own in scale) */
  lean: 0.8,
  fov: 4,
  /** A start leans in, a stop nods and settles (degrees per m/s of the speed's change still to come in, see `step`) */
  start: 0.32,
  stop: 0.2,
  /** A sidestep rolls into it: degrees at walking pace sideways, at most 1.5 times that */
  side: 0.7,
  /** The give before a jump: how far the eye dips (m) and nods (degrees), over GIVE seconds */
  give: 0.022,
  giveNod: 0.3,
};
const WALK = 1.4;
const SPRINT = 3.5;
/** Share of a step the eye's drop takes after the heel strikes; it rises over the rest. */
const DROP = 0.22;
const GIVE = 0.16;

/** Strength of a level: Off nothing, Full 1.8 times Subtle; with touch controls two thirds of it. */
export function motionStrength(level: MotionLevel, touch: boolean): number {
  const s = level === 'off' ? 0 : level === 'full' ? 1.8 : 1;
  return touch ? (s * 2) / 3 : s;
}

/** The default: Subtle, or Off where the device asks for less motion. */
export function defaultMotion(): MotionLevel {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'subtle';
  } catch {
    return 'subtle';
  }
}

/**
 * The eye's height over one step (phase in steps; a heel strikes at each whole number): -1 to 1, highest as the heel
 * strikes, down quickly to its lowest (DROP of the step), back up slowly over the rest. Smooth, and nought on average.
 */
export function strideUp(phase: number): number {
  const u = phase - Math.floor(phase);
  const w = u < DROP ? (0.5 * u) / DROP : 0.5 + (0.5 * (u - DROP)) / (1 - DROP);
  return Math.cos(2 * Math.PI * w);
}

/** Side to side over two steps (-1 left .. 1 right): over the foot that bears you, through the middle at each heel strike. */
export function strideSide(phase: number): number {
  return Math.sin(Math.PI * phase);
}

/** How much of the walking and of the sprinting gait at `speed` m/s: [size, 0 walking .. 1 sprinting]. */
export function gaitMix(speed: number): [number, number] {
  return [Math.min(1, speed / WALK), Math.max(0, Math.min(1, (speed - WALK) / (SPRINT - WALK)))];
}

export interface Offsets {
  /** metres up and to the right of the view */
  up: number;
  side: number;
  /** radians: up (pitch), and rolled (positive turns the view to the left, as three.js does) */
  pitch: number;
  roll: number;
  /** the view this much wider (a share of it: 0.05 is 5 percent) */
  fov: number;
}

/** The eye's offsets from the gait alone at `phase` and `speed` m/s, at strength 1 (for the tests and the plots too). */
export function gaitAt(phase: number, speed: number): Offsets {
  const [size, run] = gaitMix(speed);
  const mix = (k: 'up' | 'side' | 'roll' | 'nod') => size * (MOTION.walk[k] + (MOTION.sprint[k] - MOTION.walk[k]) * run);
  const up = strideUp(phase);
  const side = strideSide(phase);
  return { up: mix('up') * up, side: mix('side') * side, pitch: mix('nod') * DEG * up, roll: -mix('roll') * DEG * side, fov: 0 };
}

/** A critically damped spring towards `to` (exact over dt: no overshoot, no wobble). */
interface Spring { x: number; v: number }
function spring(s: Spring, to: number, w: number, dt: number): void {
  const d = s.x - to;
  const c = s.v + w * d;
  const e = Math.exp(-w * dt);
  s.x = to + (d + c * dt) * e;
  s.v = (s.v - w * c * dt) * e;
}

/** What the player gives each update on foot (player.ts). */
export interface GaitFeed {
  /** The stride's phase, in steps (player.ts stride) */
  phase: number;
  /** m/s across the ground, ahead along the view and to its right (the admin's turbo taken out) */
  speed: number;
  ahead: number;
  right: number;
  /** On the ground (not in a jump or a fall) */
  grounded: boolean;
  /** The sprint key held */
  sprint: boolean;
}

export class ViewMotion {
  /** 0 off, 1 Subtle on a computer (motionStrength); set by main.ts each frame */
  strength = 1;
  /** This frame's offsets, already scaled (read by the checks) */
  readonly out: Offsets = { up: 0, side: 0, pitch: 0, roll: 0, fov: 0 };
  private feedNow: GaitFeed | null = null;
  private last: GaitFeed = { phase: 0, speed: 0, ahead: 0, right: 0, grounded: true, sprint: false };
  private size = 0;
  private slow = 0;
  private fast = false;
  private sprinting: Spring = { x: 0, v: 0 };
  private lean: Spring = { x: 0, v: 0 };
  private tilt: Spring = { x: 0, v: 0 };
  private give = -1;
  private saved = { x: 0, y: 0, z: 0, rx: 0, rz: 0, fov: 0, sx: 1, sy: 1 };
  private shown = { x: 0, y: 0 };
  private markEl: HTMLElement | null | undefined;

  /** On foot this update (player.ts); not called flying, swimming, in a drop or on the play tower's ladder or slide. */
  feed(f: GaitFeed): void {
    this.feedNow = f;
  }

  /** A jump leaves the ground: the knees give a little first. */
  jumped(): void {
    this.give = 0;
  }

  /**
   * Once a frame (main.ts), before drawing. `allowed`: on foot in your own eyes (not watching, not a split-screen
   * seat, not in a vehicle, not dead). `aim` 0..1 fades it out; `scoped` stills it.
   */
  step(dt: number, allowed: boolean, aim: number, scoped: boolean): void {
    const f = allowed ? this.feedNow : null;
    this.feedNow = null;
    if (f) this.last = f;
    const g = this.last;
    // The gait's size follows the speed on the ground; in a jump it holds (the stride waits for the landing).
    const target = f ? g.speed : 0;
    if (!f || g.grounded) this.size += (target - this.size) * (1 - Math.exp(-dt * 8));
    // A start: the speed ahead runs ahead of a slower copy of it; the gap leans you in. A stop: the gap the other way
    // nods you forward a little (the head carries on), and both settle on a spring with no wobble.
    const ahead = f ? g.ahead : 0;
    this.slow += (ahead - this.slow) * (1 - Math.exp(-dt * 5));
    const gap = ahead - this.slow;
    spring(this.lean, -(Math.max(0, gap) * MOTION.start + Math.max(0, -gap) * MOTION.stop) * DEG, 14, dt);
    // A sidestep: rolled into it, a little.
    const sideways = f ? Math.max(-1.5, Math.min(1.5, g.right / WALK)) : 0;
    spring(this.tilt, -sideways * MOTION.side * DEG, 9, dt);
    // Sprinting: on, going ahead faster than walking (held through a jump); eased in over about 0.3 s, out a little quicker.
    const fast = !!f && (g.grounded ? g.sprint && g.speed > WALK * 1.6 && g.ahead > g.speed * 0.7 : this.fast);
    this.fast = fast;
    spring(this.sprinting, fast ? 1 : 0, fast ? 16 : 21, dt);
    // The give before a jump: down and back over GIVE seconds.
    let give = 0;
    if (this.give >= 0) {
      this.give += dt / GIVE;
      give = this.give < 1 ? Math.sin(Math.PI * this.give) : 0;
      if (this.give >= 1) this.give = -1;
    }

    const k = allowed ? this.strength * (scoped ? 0 : Math.max(0, 1 - aim / 0.85)) : 0;
    const o = gaitAt(g.phase, this.size);
    const s = Math.max(0, Math.min(1, this.sprinting.x));
    this.out.up = k * (o.up - give * MOTION.give);
    this.out.side = k * o.side;
    this.out.pitch = k * (o.pitch + this.lean.x - s * MOTION.lean * DEG - give * MOTION.giveNod * DEG);
    this.out.roll = k * (o.roll + this.tilt.x);
    this.out.fov = k * s * (MOTION.fov / 72);
    for (const key of ['up', 'side', 'pitch', 'roll', 'fov'] as const) if (Math.abs(this.out[key]) < 1e-7) this.out[key] = 0; // settled: none
  }

  /**
   * `render` with the offsets on the camera (and the gun's drawing kept the same size in a wider view), then the
   * camera exactly as it was, its matrices too: nothing after the drawing sees the offsets. The crosshair (`mark`,
   * #crosshair) is drawn where the shot goes in the moved picture: on the point straight ahead of the camera as the
   * game has it, so it stays on its target while the view nods, and a shot lands on it.
   */
  draw(camera: THREE.PerspectiveCamera, gun: THREE.Object3D, render: () => void, crosshair?: HTMLElement | null): void {
    const mark = crosshair !== undefined ? crosshair : (this.markEl ??= typeof document === 'undefined' ? null : document.getElementById('crosshair'));
    const o = this.out;
    if (!o.up && !o.side && !o.pitch && !o.roll && !o.fov) {
      this.shift(mark, 0, 0);
      return render();
    }
    const s = this.saved;
    Object.assign(s, { x: camera.position.x, y: camera.position.y, z: camera.position.z, rx: camera.rotation.x, rz: camera.rotation.z, fov: camera.fov, sx: gun.scale.x, sy: gun.scale.y });
    AIM.set(0, 0, -AIM_AT).applyQuaternion(camera.quaternion).add(camera.position);
    const yaw = camera.rotation.y;
    camera.position.set(s.x + Math.cos(yaw) * o.side, s.y + o.up, s.z - Math.sin(yaw) * o.side);
    camera.rotation.x = s.rx + o.pitch;
    camera.rotation.z = s.rz + o.roll;
    if (o.fov) {
      camera.fov = s.fov * (1 + o.fov);
      camera.updateProjectionMatrix();
      // The gun is drawn the same size whatever the view (weapon.ts `wide`): as much bigger as the view is wider.
      const k = Math.tan((camera.fov * DEG) / 2) / Math.tan((s.fov * DEG) / 2);
      gun.scale.x = s.sx * k;
      gun.scale.y = s.sy * k;
    }
    if (mark) {
      // The camera's own matrices only (the renderer updates the gun's with them as it draws).
      camera.updateWorldMatrix(false, false);
      AIM.project(camera);
      this.shift(mark, (AIM.x * innerWidth) / 2, (-AIM.y * innerHeight) / 2);
    }
    try {
      render();
    } finally {
      camera.position.set(s.x, s.y, s.z);
      camera.rotation.x = s.rx;
      camera.rotation.z = s.rz;
      if (o.fov) {
        camera.fov = s.fov;
        camera.updateProjectionMatrix();
        gun.scale.x = s.sx;
        gun.scale.y = s.sy;
      }
      // The camera's own matrices (its world matrix and inverse), not the gun's 370 parts under it: the next drawing
      // works those out again as always, rays skip them (ignoreRay) and their places are read with getWorldPosition,
      // which starts from the camera.
      camera.updateWorldMatrix(false, false);
    }
  }

  /** The crosshair this many CSS pixels from the middle (written only when it changes by a third of a pixel). */
  private shift(mark: HTMLElement | null, x: number, y: number): void {
    if (!mark || (Math.abs(x - this.shown.x) < 0.33 && Math.abs(y - this.shown.y) < 0.33)) return;
    this.shown = { x, y };
    mark.style.translate = x || y ? `${x.toFixed(1)}px ${y.toFixed(1)}px` : '';
  }
}

/** How far ahead (m) the point is that the crosshair is kept on: where shots mostly land. */
const AIM_AT = 60;
const AIM = new THREE.Vector3();
