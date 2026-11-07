import * as THREE from 'three';
import type { World } from './collision';
import { mood } from './mood';
import type { Particles, Spawn } from './particles';
import { PARTICLE } from './sprites';
import { waterLevel } from './water';

/**
 * Spray from the tyres on a wet road (world/weather.ts: mood.wet, which it only reads): behind each
 * wheel of a car or a bike that goes faster than a walk, a fine grey mist drawn along after it and a
 * few drops thrown up from the tread. More the wetter it is and the faster it goes; a little on grass,
 * none through a ford (world/splashes.ts throws the water there). From the shared particle pools
 * (world/particles.ts), fewer on Low; the mist takes the day's light, so at night it is dark.
 */

const MIST = new THREE.Color('#ccd2d6');
const DROP = new THREE.Color('#dfe7e8');
/** Paved or not, by the material the ground under it is (as world/car.ts tells rough ground) */
const ROUGH = /grass|lawn|meadow|field|earth|soil|mud|gravel|sand|hedge|leaves|moss|forest/i;

interface Wheels {
  x: number;
  z: number;
  /** Seconds to the next look at the ground under it */
  look: number;
  rough: boolean;
  /** Particles owed from earlier frames (they come a fraction at a time) */
  owed: number;
}

export class TyreSpray {
  private seen = new Map<string, Wheels>();
  private s: Spawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
    c0: new THREE.Color(), c1: new THREE.Color(), alpha: 1, cell: 0, drag: 0, gravity: 0, spin: 0, stretch: 0,
  };

  constructor(private particles: Particles, private world: World) {}

  /**
   * Each frame for each vehicle near the eye (`key` tells them apart): its middle at (x, z) on the ground `y`,
   * turned `yaw`, its half length and half width; `bike`: one narrow wheel behind instead of four.
   */
  wheels(key: string, x: number, z: number, y: number, yaw: number, halfL: number, halfW: number, dt: number, bike = false): void {
    let w = this.seen.get(key);
    if (!w) this.seen.set(key, (w = { x, z, look: 0, rough: false, owed: 0 }));
    const vx = dt > 0 ? (x - w.x) / dt : 0;
    const vz = dt > 0 ? (z - w.z) / dt : 0;
    w.x = x;
    w.z = z;
    const wet = mood.wet;
    const speed = Math.hypot(vx, vz);
    if (wet < 0.15 || speed < 3 || speed > 70 || !(dt > 0)) {
      w.owed = 0;
      return;
    }
    if ((w.look -= dt) <= 0) {
      w.look = 0.3;
      w.rough = waterLevel(x, z) !== null || ROUGH.test(this.world.groundAt(x, z, y + 0.5, 0.3).mat ?? 'grass');
    }
    if (waterLevel(x, z) !== null) return; // a ford: world/splashes.ts
    const fast = Math.min(1, (speed - 3) / 17);
    // Per second over all its wheels: up to about 280 for a car flat out in a downpour, a quarter of it on grass.
    w.owed += dt * (bike ? 70 : 280) * wet * fast * (w.rough ? 0.25 : 1) * this.particles.budget;
    const n = Math.floor(w.owed);
    if (!n) return;
    w.owed -= n;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const s = this.s;
    for (let i = 0; i < n; i++) {
      // A wheel: the rear ones throw most, the front ones some; the bike's back wheel.
      const rear = bike || Math.random() < 0.7;
      const side = bike ? 0 : Math.random() < 0.5 ? -1 : 1;
      const along = rear ? -halfL * 0.62 : halfL * 0.62;
      // Spread over the stretch it covered this frame, so the mist is a trail, not a row of puffs.
      const lag = Math.random() * dt;
      const wx = x + fx * along - fz * side * halfW * 0.85 - vx * lag;
      const wz = z + fz * along + fx * side * halfW * 0.85 - vz * lag;
      const out = side * (0.3 + Math.random() * 0.7);
      // Written into the one spawn record (a new object per particle was garbage every frame).
      if (Math.random() < 0.75) {
        // The mist: carried along a little, rising off the road and spreading behind.
        s.x = wx - fx * 0.3;
        s.y = y + 0.15 + Math.random() * 0.15;
        s.z = wz - fz * 0.3;
        s.vx = vx * 0.3 - fx * speed * 0.12 - fz * out;
        s.vy = 0.4 + Math.random() * 0.9;
        s.vz = vz * 0.3 - fz * speed * 0.12 + fx * out;
        s.life = 0.4 + Math.random() * 0.5;
        s.size0 = bike ? 0.1 : 0.16;
        s.size1 = (bike ? 0.4 : 0.65) + speed * 0.02;
        s.alpha = (0.06 + 0.08 * fast) * wet;
        s.cell = PARTICLE.puff;
        s.drag = 2.4;
        s.gravity = 0.3;
        s.spin = (Math.random() - 0.5) * 2;
        s.stretch = 0;
        s.c0.copy(MIST);
        s.c1.copy(MIST);
      } else {
        // Drops off the tread, up and back, falling.
        s.x = wx - fx * 0.25;
        s.y = y + 0.25;
        s.z = wz - fz * 0.25;
        s.vx = vx * 0.6 - fx * (1 + Math.random() * 2) - fz * out;
        s.vy = 1.2 + Math.random() * 2.2;
        s.vz = vz * 0.6 - fz * (1 + Math.random() * 2) + fx * out;
        s.life = 0.3 + Math.random() * 0.25;
        s.size0 = 0.025;
        s.size1 = 0.015;
        s.alpha = 0.5 * wet;
        s.cell = PARTICLE.glow;
        s.drag = 0.8;
        s.gravity = 9.8;
        s.spin = 0;
        s.stretch = 0.04;
        s.c0.copy(DROP);
        s.c1.copy(DROP);
      }
      this.particles.spawn(s);
    }
  }
}
