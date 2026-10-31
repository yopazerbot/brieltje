import * as THREE from 'three';
import { anyPaint, paintball } from '../paintball';
import { sound } from '../sound';
import type { World } from './collision';
import SPEC from '../../shared/grenade.json';

/**
 * Hand grenades (G, or R1 on the controller). Everyone carries two; a thrown one is back
 * after `back` seconds (shared/grenade.json, the server keeps the same count). A grenade
 * flies in an arc, bounces off walls, floors, doors and the ground with a clunk, rolls to a
 * stop and goes off when its fuse runs out. A fast one breaks a window and flies on.
 * Your own grenades go off here (main.ts tells the server); other players' fly from their
 * throw and are taken away when their blast arrives.
 * In paintball (paintball.ts) each is a paint balloon in a bright colour that bounces with a
 * squelch, and its blast is a splash of paint (effects.ts); it flies and counts the same.
 */
export const GRENADE = SPEC as { carry: number; back: number; fuse: number; speed: number; radius: number; damage: number };

const R = 0.045; // m, radius of the ball it collides as
const BOUNCE = 0.32; // share of the speed into a surface that comes back
const SLIDE = 0.72; // share of the speed along a surface kept on each bounce

const body = new THREE.MeshStandardMaterial({ color: '#434a36', roughness: 0.55, metalness: 0.2 });
const steel = new THREE.MeshStandardMaterial({ color: '#8b8f92', roughness: 0.35, metalness: 0.85 });
let template: THREE.Group | null = null;

/** Olive egg with a steel fuse cap and lever, 11 cm tall. */
function model(): THREE.Group {
  if (!template) {
    template = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(R, 12, 9), body);
    shell.scale.set(1, 1.2, 1);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.022, 8), steel);
    cap.position.y = R * 1.2 + 0.006;
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.075, 0.006), steel);
    lever.position.set(0, R * 0.55, R + 0.003);
    lever.rotation.x = -0.15;
    template.add(shell, cap, lever);
    template.traverse((o) => {
      o.castShadow = true;
      o.userData.ignoreRay = true;
    });
  }
  return template.clone();
}

const balloonShape = new THREE.SphereGeometry(R * 1.25, 14, 10).scale(1, 1.15, 1);
const knotShape = new THREE.ConeGeometry(R * 0.28, R * 0.5, 8).rotateX(Math.PI);
const balloons = new Map<string, THREE.MeshStandardMaterial>();
/** Paintball: a water balloon full of paint, in one of the paint colours, its knot on top. */
function balloon(): THREE.Group {
  const color = anyPaint();
  let mat = balloons.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, roughness: 0.2 }); // shiny rubber
    balloons.set(color, mat);
  }
  const g = new THREE.Group();
  const knot = new THREE.Mesh(knotShape, mat);
  knot.position.y = R * 1.25 * 1.15 + R * 0.15;
  g.add(new THREE.Mesh(balloonShape, mat), knot);
  g.traverse((o) => {
    o.castShadow = true;
    o.userData.ignoreRay = true;
  });
  return g;
}

interface Live {
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  /** Whose it is; null for yours */
  by: string | null;
  still: boolean;
}

export class Grenades {
  readonly group = new THREE.Group();
  /** One of yours went off at `at`. */
  onExplode: (at: THREE.Vector3) => void = () => {};
  /** One of yours hit window pane `index` fast at `at`, coming from `from`: true when it broke (the grenade flies on). */
  onPane: (index: number, at: THREE.Vector3, from: THREE.Vector3) => boolean = () => false;
  private live: Live[] = [];
  /** When each of your grenades is back, on this clock (seconds); in your pocket once passed */
  private back: number[] = Array(GRENADE.carry).fill(0);
  private clock = 0;
  private next = new THREE.Vector3();
  private n = new THREE.Vector3();
  private t = new THREE.Vector3();

  constructor(private world: World) {}

  /** Grenades in your pocket. */
  get count(): number {
    return this.back.filter((t) => this.clock >= t).length;
  }

  /** Seconds until the next one is back (0 with all of them in your pocket). */
  get nextIn(): number {
    const waiting = this.back.filter((t) => t > this.clock);
    return waiting.length ? Math.min(...waiting) - this.clock : 0;
  }

  /** All of them back (after respawning). */
  refill(): void {
    this.back.fill(0);
  }

  /** Throw one of yours from `from` at `vel` (m/s); false when you have none. */
  throw(from: THREE.Vector3, vel: THREE.Vector3): boolean {
    const i = this.back.findIndex((t) => this.clock >= t);
    if (i < 0) return false;
    this.back[i] = this.clock + GRENADE.back;
    this.add(from, vel, null);
    return true;
  }

  /** Someone else threw one. */
  thrown(by: string, from: THREE.Vector3, vel: THREE.Vector3): void {
    this.add(from, vel, by);
  }

  /** Their grenade went off: take it away (the oldest of theirs). */
  landed(by: string): void {
    const i = this.live.findIndex((g) => g.by === by);
    if (i >= 0) this.remove(i);
  }

  update(dt: number): void {
    this.clock += dt;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const g = this.live[i];
      g.age += dt;
      // Others' grenades wait for their blast from the server (at most 2 s more).
      if (g.age >= GRENADE.fuse + (g.by ? 2 : 0)) {
        const at = g.pos.clone();
        this.remove(i);
        if (!g.by) this.onExplode(at);
        continue;
      }
      if (!g.still) this.fly(g, dt);
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      g.mesh.rotation.z += g.spin.z * dt;
    }
  }

  private add(from: THREE.Vector3, vel: THREE.Vector3, by: string | null): void {
    const mesh = paintball.on ? balloon() : model();
    mesh.position.copy(from);
    this.group.add(mesh);
    const spin = new THREE.Vector3(-8 - Math.random() * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3);
    this.live.push({ mesh, pos: from.clone(), vel: vel.clone(), spin, age: 0, by, still: false });
  }

  private remove(i: number): void {
    this.live[i].mesh.removeFromParent();
    this.live.splice(i, 1);
  }

  /** Move one grenade by dt in steps of at most 4 cm, so it can't pass through a wall or a pane. */
  private fly(g: Live, dt: number): void {
    const steps = Math.min(30, Math.max(1, Math.ceil((g.vel.length() * dt) / 0.04)));
    const h = dt / steps;
    let floor = false;
    for (let s = 0; s < steps; s++) {
      g.vel.y -= 9.81 * h;
      this.next.copy(g.pos).addScaledVector(g.vel, h);
      const hit = this.world.collide(g.pos, this.next, R);
      if (!hit) {
        g.pos.copy(this.next);
        continue;
      }
      if (!g.by && hit.index >= 0 && g.vel.length() > 6 && this.onPane(hit.index, this.next, g.pos)) {
        g.vel.multiplyScalar(0.8);
        g.pos.copy(this.next);
        continue;
      }
      // Bounce (it stays where it was, which was free): part of the speed into the surface
      // comes back, sliding along it loses some. Slow ones just stop against it.
      this.n.set(hit.nx, hit.ny, hit.nz);
      const into = -g.vel.dot(this.n);
      if (into > 0) {
        if (into > 1.2) this.clunk(g.pos, Math.min(1, into / 8), hit.index === -1);
        this.t.copy(g.vel).addScaledVector(this.n, into).multiplyScalar(SLIDE);
        g.vel.copy(this.t).addScaledVector(this.n, into > 0.8 ? into * BOUNCE : 0);
        g.spin.multiplyScalar(0.6).add(this.t.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(into * 2));
      }
      if (hit.ny > 0.7) floor = true;
    }
    if (floor) {
      // Rolling on a floor: it slows down and comes to rest.
      const k = Math.exp(-dt * 2.2);
      g.vel.x *= k;
      g.vel.z *= k;
      g.spin.set(g.vel.z / R, g.spin.y * k, -g.vel.x / R).multiplyScalar(0.5);
      if (g.vel.lengthSq() < 0.04) {
        g.still = true;
        g.vel.set(0, 0, 0);
      }
    }
  }

  /** A dull knock with a little ring of metal; softer on grass. A paint balloon: a rubbery squelch, bending up in pitch. */
  private clunk(at: THREE.Vector3, loud: number, soft: boolean): void {
    const ctx = sound.context();
    const dest = ctx && sound.at(at.x, at.y, at.z, 2);
    if (!ctx || !dest) return;
    const t = ctx.currentTime;
    if (paintball.on) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(240, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.35 * loud, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.16);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.18);
      return;
    }
    for (const [f, len, gain] of soft ? [[140, 0.07, 0.25]] : [[190, 0.09, 0.3], [1250 + Math.random() * 200, 0.12, 0.05]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.6, t + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * loud, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + len);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + len + 0.02);
    }
  }
}
