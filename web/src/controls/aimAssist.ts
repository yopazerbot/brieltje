/**
 * A subtle aim assist for controller players, against zombies only (Yoshi: "maybe a subtle aim assist for
 * controller players?"). A thumb on a stick can't stop on a target as a hand on a mouse can, so:
 *
 * - Slowdown ("friction"): while the crosshair is on or close to a zombie that is up and in sight, the right
 *   stick turns the view slower: to half its speed on the middle of the body, easing back to full speed at
 *   the edge of a small cone about a body's width (a few degrees, wider close by). It only changes how much
 *   your own stick turns the view: with the stick still, nothing moves.
 * - A gentle snap when you start aiming down the sights (L2): for 150 ms the view eases part of the way
 *   towards the nearest zombie within a few degrees of the crosshair, never more than 3.5°, and only when
 *   nothing solid stands between you (world/collision.ts blocked).
 *
 * Weaker with the sniper rifle and further off, nothing beyond 60 m. Only while the controller is what you
 * play with (the last look input came from it): the mouse and touch never get it. Never players, clowns,
 * cats or villagers: the targets are the zombies' own hit boxes (world/zombies.ts `hits`).
 *
 * Purely the page shaping its own input. No message, nothing new on the server: the server still decides
 * every hit (zhit) with its own checks, as for a mouse player.
 *
 * The maths are plain functions (tested in aimAssist.test.mjs); the class keeps the state between frames.
 */

export interface Vec {
  x: number;
  y: number;
  z: number;
}

/** A zombie as the assist sees it: a vertical line from its hips' height to its head, and how wide it is. */
export interface Target {
  id: number;
  foot: Vec;
  top: Vec;
  /** Half its body's width (m) */
  radius: number;
}

const DEG = Math.PI / 180;

export const ASSIST = {
  /** How much slower the stick turns on the middle of a target: 0.5 is half speed */
  slow: 0.5,
  /** The sniper's: only a quarter slower */
  sniperSlow: 0.25,
  /** Full strength up to `near` metres, fading out to nothing at `far` */
  near: 25,
  far: 60,
  /** The cone round a target: its half width plus this margin, seen from where you are, within min..max */
  margin: 0.2,
  coneMin: 1 * DEG,
  coneMax: 6 * DEG,
  /** The snap: only a target this close to the crosshair (the sniper's: half), part of the way, at most this far */
  snapCone: 5 * DEG,
  share: 0.6,
  snapMax: 3.5 * DEG,
  sniperSnapMax: 1.5 * DEG,
  snapMs: 150,
  /** How long a line-of-sight answer stays good for the slowdown (ms) */
  sightMs: 250,
};

/** 1 up to `near` metres, down to 0 at `far`. */
export function rangeFade(dist: number): number {
  if (!(dist >= 0)) return 0;
  if (dist <= ASSIST.near) return 1;
  return Math.max(0, 1 - (dist - ASSIST.near) / (ASSIST.far - ASSIST.near));
}

/** The cone's half angle (radians) round a target `radius` wide at `dist` metres: about its body's width. */
export function coneAt(dist: number, radius: number): number {
  const a = Math.atan2(radius + ASSIST.margin, Math.max(0.1, dist));
  return Math.min(ASSIST.coneMax, Math.max(ASSIST.coneMin, a));
}

/**
 * How fast the stick turns the view (1: as usual) with the crosshair `angle` radians off a target `dist`
 * metres away: slowest on it, easing to 1 at the cone's edge, and less the further off it is.
 */
export function frictionScale(angle: number, dist: number, radius: number, sniper: boolean): number {
  const cone = coneAt(dist, radius);
  if (!(angle >= 0) || angle >= cone) return 1;
  const u = angle / cone;
  const ease = 1 - u * u * (3 - 2 * u); // smoothstep, 1 on the target to 0 at the edge
  return 1 - (sniper ? ASSIST.sniperSlow : ASSIST.slow) * ease * rangeFade(dist);
}

/** Where you look: yaw turns left (forward is -z at yaw 0), pitch up. */
export function forward(yaw: number, pitch: number): Vec {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The crosshair against a target: the point of its line nearest to where you look, how far off that is
 * (`angle`, radians), how far away (`dist`, m), and the turn that would put the crosshair on it.
 */
export function aimError(eye: Vec, yaw: number, pitch: number, t: Target): { angle: number; dist: number; dYaw: number; dPitch: number; point: Vec } {
  const f = forward(yaw, pitch);
  // The nearest points of the view's ray and the target's line (clamped to the line's ends).
  const u = { x: t.top.x - t.foot.x, y: t.top.y - t.foot.y, z: t.top.z - t.foot.z };
  const w = { x: t.foot.x - eye.x, y: t.foot.y - eye.y, z: t.foot.z - eye.z };
  const a = u.x * u.x + u.y * u.y + u.z * u.z;
  const b = u.x * f.x + u.y * f.y + u.z * f.z;
  const d = u.x * w.x + u.y * w.y + u.z * w.z;
  const e = f.x * w.x + f.y * w.y + f.z * w.z;
  const den = a - b * b; // |f| = 1
  let s = den > 1e-9 ? (b * e - d) / den : 0;
  s = Math.min(1, Math.max(0, s));
  const point = { x: t.foot.x + u.x * s, y: t.foot.y + u.y * s, z: t.foot.z + u.z * s };
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return { angle: 0, dist: 0, dYaw: 0, dPitch: 0, point };
  const cos = (dx * f.x + dy * f.y + dz * f.z) / dist;
  const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
  const dYaw = wrap(Math.atan2(-dx, -dz) - yaw);
  const dPitch = Math.atan2(dy, Math.hypot(dx, dz)) - pitch;
  return { angle, dist, dYaw, dPitch, point };
}

/**
 * The snap's whole turn for a target off by (dYaw, dPitch) with the crosshair `angle` off it: part of the
 * way, at most snapMax (the sniper's less), less the further off; null when it is outside the snap's cone.
 */
export function snapPlan(angle: number, dist: number, dYaw: number, dPitch: number, sniper: boolean): { yaw: number; pitch: number } | null {
  const cone = sniper ? ASSIST.snapCone / 2 : ASSIST.snapCone;
  const fade = rangeFade(dist);
  if (!(angle < cone) || fade <= 0) return null;
  const size = Math.hypot(dYaw, dPitch);
  if (size < 1e-6) return null;
  const want = Math.min(size * ASSIST.share, (sniper ? ASSIST.sniperSnapMax : ASSIST.snapMax) * fade);
  return { yaw: (dYaw / size) * want, pitch: (dPitch / size) * want };
}

/** The look input the assist changes (src/controls/input.ts FrameInput). */
export interface LookInput {
  lookX: number;
  lookY: number;
  mouseX: number;
  mouseY: number;
  aimHeld: boolean;
  anyPadButton: boolean;
}

/** The hit boxes as world/zombies.ts keeps them: a group per zombie with its body box, then its head. */
interface HitMesh {
  visible: boolean;
  position: Vec;
  scale: Vec;
  userData: { zombie?: number };
}
export interface HitGroups {
  children: readonly { children: readonly unknown[] }[];
}

/** The view the assist turns (src/player.ts). */
export interface View {
  yaw: number;
  pitch: number;
}

export class AimAssist {
  /** What it did last frame, for the checks in the dev build: the stick's speed (1: as usual), the snap left (degrees) */
  last = { scale: 1, target: -1, snapLeft: 0 };
  private fromPad = false;
  private aiming = false;
  private snap: { yaw: number; pitch: number; t: number } | null = null;
  private sight = new Map<number, { at: number; clear: boolean }>();
  private list: Target[] = [];
  private hits: HitGroups;
  private clear: (a: Vec, b: Vec) => boolean;

  /** `clear(a, b)`: nothing solid between the two points. */
  constructor(hits: HitGroups, clear: (a: Vec, b: Vec) => boolean) {
    this.hits = hits;
    this.clear = clear;
  }

  /** The zombies up now, near enough, as lines (their hit boxes: a fallen one's are hidden). */
  private targets(eye: Vec): Target[] {
    const out = this.list;
    out.length = 0;
    const far2 = ASSIST.far * ASSIST.far;
    for (const g of this.hits.children) {
      const body = g.children[0] as HitMesh | undefined;
      const head = g.children[1] as HitMesh | undefined;
      if (!body?.visible || !head || body.userData.zombie === undefined) continue;
      const p = body.position;
      if ((p.x - eye.x) ** 2 + (p.z - eye.z) ** 2 > far2) continue;
      out.push({ id: body.userData.zombie, foot: { x: p.x, y: p.y + 0.35, z: p.z }, top: head.position, radius: 0.275 * body.scale.x });
    }
    return out;
  }

  private seen(id: number, eye: Vec, point: Vec, now: number, fresh: boolean): boolean {
    const s = this.sight.get(id);
    if (!fresh && s && now - s.at < ASSIST.sightMs) return s.clear;
    const clear = this.clear(eye, point);
    this.sight.set(id, { at: now, clear });
    if (this.sight.size > 64) for (const [k, v] of this.sight) if (now - v.at > ASSIST.sightMs) this.sight.delete(k);
    return clear;
  }

  /**
   * Shape this frame's look input before the player turns (src/main.ts, on foot): `on` when the assist may
   * work at all (the setting, the controller as the mode, the Zombies game, a gun in your hands), `sniper`
   * for the sniper rifle. Slows the stick over a zombie, and turns `view` a little at the start of aiming.
   */
  shape(input: LookInput, dt: number, view: View, eye: Vec, on: boolean, sniper: boolean, now = performance.now()): void {
    // The last look input decides: the mouse (or a drag on a touch screen) turns it off until the pad is used again.
    if (input.mouseX || input.mouseY) this.fromPad = false;
    else if (input.lookX || input.lookY || input.anyPadButton) this.fromPad = true;
    const live = on && this.fromPad;
    const started = input.aimHeld && !this.aiming;
    this.aiming = input.aimHeld;
    this.last.scale = 1;
    this.last.target = -1;
    if (!live || !input.aimHeld) this.snap = null;
    if (!live) {
      this.last.snapLeft = 0;
      return;
    }
    const stick = input.lookX !== 0 || input.lookY !== 0;
    if (!stick && !started && !this.snap) return; // nothing to shape: the view stays yours

    const targets = this.targets(eye);
    // Slowdown: the strongest of the targets in sight.
    if (stick) {
      let best = 1;
      for (const t of targets) {
        const err = aimError(eye, view.yaw, view.pitch, t);
        const s = frictionScale(err.angle, err.dist, t.radius, sniper);
        if (s < best && this.seen(t.id, eye, err.point, now, false)) [best, this.last.target] = [s, t.id];
      }
      if (best < 1) {
        // The stick's response is curved (src/player.ts look: speed goes with the push squared), so the push
        // shrinks by the root for the speed to shrink by `best`.
        const k = Math.sqrt(best);
        input.lookX *= k;
        input.lookY *= k;
        this.last.scale = best;
      }
    }
    // The snap: planned once, as you start aiming, towards the nearest zombie in its cone that you can see.
    if (started) {
      let pick: { yaw: number; pitch: number } | null = null;
      let nearest = Infinity;
      for (const t of targets) {
        const err = aimError(eye, view.yaw, view.pitch, t);
        const plan = snapPlan(err.angle, err.dist, err.dYaw, err.dPitch, sniper);
        if (plan && err.angle < nearest && this.seen(t.id, eye, err.point, now, true)) [pick, nearest] = [plan, err.angle];
      }
      this.snap = pick ? { ...pick, t: 0 } : null;
    }
    if (this.snap) {
      // Eased out over snapMs: most of the turn early, none of it after.
      const s = this.snap;
      const ease = (x: number) => 1 - (1 - x) * (1 - x);
      const t0 = s.t;
      s.t = Math.min(1, s.t + (dt * 1000) / ASSIST.snapMs);
      const k = ease(s.t) - ease(t0);
      view.yaw += s.yaw * k;
      view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch + s.pitch * k));
      this.last.snapLeft = (Math.hypot(s.yaw, s.pitch) * (1 - ease(s.t))) / DEG;
      if (s.t >= 1) this.snap = null;
    } else this.last.snapLeft = 0;
  }
}
