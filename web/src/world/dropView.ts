import * as THREE from 'three';
import type { Body } from '../net/swat';

/**
 * Your own drop seen from behind (shared/parachute.mjs, docs/parachute/README.md): while you jump the camera
 * leaves your eyes and films your figure from behind and a little above, the map below (Yoshi: as in a
 * battle-royale skydive). Your figure is the one the others see (net/avatars.ts), posed by the parachute as
 * theirs are (world/parachutes.ts). The camera turns with you and your look (the mouse, the look stick or a
 * drag): where you look up and down swings it round you. It frames the figure in the free fall and backs off
 * for the canopy as it opens, stays clear of the ground, and on landing goes back into your eyes.
 *
 * Cheap: no extra pass and nothing on the graphics chip besides the figure and its parachute (one skinned
 * mesh each), and one ground look-up a frame.
 */

/** Seconds to leave your eyes at the start, and to come back into them after landing. */
const OUT_S = 0.9;
const IN_S = 0.6;
/** The point filmed, over your feet (m), and how far the camera is from it: in the free fall, under the canopy. */
const FALL = { height: 0.9, dist: 3.6 };
const CANOPY = { height: 3, dist: 7.5 };
/** The camera this much above the line it looks along (times its distance): the figure a little below the middle. */
const LIFT = 0.17;
/** At least this far over the ground under the camera (m). */
const CLEAR = 0.8;

const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();

export interface DropState {
  x: number;
  z: number;
  feet: number;
  yaw: number;
  pitch: number;
  /** In a drop (seconds since it began), or null */
  chute: number | null;
  /** Seconds since the canopy began to open, or null */
  canopy: number | null;
  /** Feet over the ground (m) */
  air: number;
  /** Under the canopy: the steering, -1 left .. 1 right */
  steer: number;
}

export class DropView {
  /** Round you by this much (rad) from straight behind: 0 in the game; the dev checks look from the side. */
  spin = 0;
  /** 0: your own eyes, 1: from behind (eased in and out) */
  private mix = 0;
  private height = FALL.height;
  private dist = FALL.dist;
  private roll = 0;
  private body: Body | null = null;
  private colour = '';

  /**
   * `figure` builds your figure in a colour (net/avatars.ts: the one the others see); `holder` is the group at
   * your feet that carries it and your parachute; `groundAt` the ground under a point, looking down from y.
   */
  constructor(
    private figure: (colour: string) => Body,
    private holder: THREE.Object3D,
    private groundAt: (x: number, z: number, y: number) => number,
  ) {}

  /** Seen from behind now (the figure shows; your eyes' parachute view doesn't). */
  get outside(): boolean {
    return this.mix > 0.45;
  }

  /**
   * Each frame after the player has set the camera in their eyes: films the drop from behind instead, or
   * eases between the two. Your figure shows while filmed from outside and `ready` (your parachute is there
   * to pose it, else it would stand upright in the sky).
   */
  update(dt: number, camera: THREE.PerspectiveCamera, s: DropState, ready: boolean): void {
    const dropping = s.chute !== null;
    this.mix = Math.max(0, Math.min(1, this.mix + (dropping ? dt / OUT_S : -dt / IN_S)));
    const b = ease(this.mix);
    if (b > 0) {
      // Framing: close behind the figure in the free fall, further back and higher for the canopy, a little
      // closer near the ground. Eased, so nothing jumps.
      const open = s.canopy === null ? 0 : ease(s.canopy / 1.6);
      const near = lerp(0.65, 1, Math.min(1, s.air / 12));
      const k = 1 - Math.exp(-dt * 3);
      this.height += (lerp(FALL.height, CANOPY.height, open) - this.height) * k;
      this.dist += (lerp(FALL.dist, CANOPY.dist, open) * (dropping ? near : 1) - this.dist) * k;
      this.roll += ((s.canopy === null ? 0 : -s.steer * 0.08) - this.roll) * k;
      const pitch = Math.max(-1.35, Math.min(0.6, s.pitch));
      const cp = Math.cos(pitch);
      const yaw = s.yaw + this.spin;
      const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
      _p.set(s.x - dx * this.dist, s.feet + this.height - dy * this.dist + LIFT * this.dist, s.z - dz * this.dist);
      _p.y = Math.max(_p.y, this.groundAt(_p.x, _p.z, _p.y + 2) + CLEAR);
      _q.setFromEuler(_e.set(pitch, yaw, this.roll));
      camera.position.lerp(_p, b);
      camera.quaternion.slerp(_q, b);
    } else {
      this.height = FALL.height;
      this.dist = FALL.dist;
      this.roll = 0;
    }
    if (this.body) this.body.root.visible = this.outside && ready;
  }

  /**
   * Your figure, for your parachute to pose: made at your first drop, made again in a new colour (a team's)
   * only between drops (a parachute holds on to the figure it poses). Null before the first drop.
   */
  own(colour: string, dropping: boolean): Body | null {
    if (dropping ? !this.body : this.body && colour !== this.colour && this.mix === 0) this.build(colour);
    return this.body;
  }

  /** Your figure in your colour, with nothing a ray could hit. */
  private build(colour: string): void {
    if (this.body) {
      this.body.root.removeFromParent();
      this.body.dispose?.();
      if (!this.body.shared) this.body.root.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
    }
    const body = this.figure(colour);
    // Never in the way of a shot or a look-up: no hit boxes (you can't be shot in a drop, and never by yourself).
    for (const h of body.hits) h.removeFromParent();
    body.hits.length = 0;
    body.root.traverse((o) => (o.userData.ignoreRay = true));
    body.root.visible = false;
    this.holder.add(body.root);
    this.body = body;
    this.colour = colour;
  }
}
