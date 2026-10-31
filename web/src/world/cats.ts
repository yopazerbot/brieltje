import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import CATS from '../../shared/cats.json';
import { sound } from '../sound';

/**
 * Cats wandering around the garden, the front lawn and the side path (the
 * animated "Cat" by Quaternius, CC0). Each walks a fixed loop on a shared
 * clock, so every player sees it in the same place without the server
 * sending positions. Shot, it yowls and falls over; it is back after 15 s.
 * They meow now and then.
 */

const HEIGHT = 0.42; // m
const HIT = new THREE.SphereGeometry(0.28, 8, 6);
const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });

type Point = [number, number];

interface Cat {
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current: string;
  hit: THREE.Mesh;
  /** Dead until this time (s on the shared clock) */
  deadUntil: number;
  meowIn: number;
}

/** Where a cat is at time t on its loop: walking between corners, pausing at each. */
function onLoop(loop: Point[], t: number): { x: number; z: number; heading: number; walking: boolean } {
  const legs = loop.map((p, i) => {
    const q = loop[(i + 1) % loop.length];
    return { from: p, to: q, time: Math.hypot(q[0] - p[0], q[1] - p[1]) / CATS.speed };
  });
  const cycle = legs.reduce((s, l) => s + l.time + CATS.pause, 0);
  let u = ((t % cycle) + cycle) % cycle;
  for (const l of legs) {
    const heading = Math.atan2(l.to[0] - l.from[0], l.to[1] - l.from[1]);
    if (u < CATS.pause) return { x: l.from[0], z: l.from[1], heading, walking: false };
    u -= CATS.pause;
    if (u < l.time) {
      const f = u / l.time;
      return { x: l.from[0] + (l.to[0] - l.from[0]) * f, z: l.from[1] + (l.to[1] - l.from[1]) * f, heading, walking: true };
    }
    u -= l.time;
  }
  return { x: loop[0][0], z: loop[0][1], heading: 0, walking: false };
}

/** A meow made in code: a gliding buzzy tone through a vowel-like filter. */
function meow(at: THREE.Vector3, angry = false): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 0.3, at.z, 2);
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const len = angry ? 0.7 : 0.45;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  const base = angry ? 320 : 520 + Math.random() * 120;
  o.frequency.setValueAtTime(base, t);
  o.frequency.linearRampToValueAtTime(base * 1.7, t + len * 0.35);
  o.frequency.linearRampToValueAtTime(base * 0.8, t + len);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 3;
  f.frequency.setValueAtTime(900, t);
  f.frequency.linearRampToValueAtTime(1800, t + len * 0.4);
  f.frequency.linearRampToValueAtTime(1000, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(angry ? 0.5 : 0.25, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(f).connect(g).connect(dest);
  o.start(t);
  o.stop(t + len + 0.05);
}

export class Cats {
  readonly group = new THREE.Group();
  private cats: Cat[] = [];
  private offset = 0; // shared clock minus local clock, in seconds

  constructor(private floorAt: (x: number, z: number) => number) {
    void new GLTFLoader().loadAsync('/models/cat.glb').then((gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const scale = HEIGHT / (box.max.y - box.min.y);
      const clips = new Map(gltf.animations.map((c) => [c.name.split('|').pop()!, c]));
      this.cats = CATS.cats.map((_, i) => {
        const model = SkeletonUtils.clone(gltf.scene) as THREE.Group;
        model.scale.setScalar(scale);
        model.position.y = -box.min.y * scale;
        model.traverse((o) => {
          o.userData.ignoreRay = true;
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.frustumCulled = false;
          }
        });
        const group = new THREE.Group();
        group.add(model);
        const hit = new THREE.Mesh(HIT, hitMaterial);
        hit.position.y = 0.22;
        hit.userData.cat = i;
        group.add(hit);
        this.group.add(group);
        const mixer = new THREE.AnimationMixer(model);
        const actions = new Map([...clips].map(([n, c]) => [n, mixer.clipAction(c)]));
        const death = actions.get('Death');
        if (death) {
          death.setLoop(THREE.LoopOnce, 1);
          death.clampWhenFinished = true;
        }
        return { group, mixer, actions, current: '', hit, deadUntil: 0, meowIn: 5 + Math.random() * 20 };
      });
    }, () => {});
  }

  private get now(): number {
    return performance.now() / 1000 + this.offset;
  }

  /** Line up with the server's clock (ms since 1970), so all players see the cats in the same place. */
  setClock(serverMs: number): void {
    this.offset = serverMs / 1000 - performance.now() / 1000;
  }

  /** Cats that are down when you join: seconds until each is back. */
  setDown(msLeft: number[]): void {
    msLeft.forEach((ms, i) => ms > 0 && this.down(i, ms / 1000));
  }

  /** Your bullet hit cat i: true if it was alive (then it goes down). */
  hit(i: number): boolean {
    const c = this.cats[i];
    if (!c || this.now < c.deadUntil) return false;
    this.down(i, CATS.respawnSeconds);
    meow(c.group.position, true);
    return true;
  }

  /** Someone else shot cat i, back in `seconds`. */
  down(i: number, seconds: number): void {
    const c = this.cats[i];
    if (c) c.deadUntil = this.now + seconds;
  }

  private play(c: Cat, name: string): void {
    if (c.current === name) return;
    const next = c.actions.get(name);
    if (!next) return;
    const prev = c.actions.get(c.current);
    next.reset().play();
    if (prev) {
      if (name === 'Death' || c.current === 'Death') prev.stop();
      else next.crossFadeFrom(prev, 0.25, true);
    }
    c.current = name;
  }

  /** Cats that are up within `radius` of a point (a rocket's blast). */
  near(p: THREE.Vector3, radius: number): number[] {
    const now = this.now;
    return this.cats.flatMap((c, i) => (now >= c.deadUntil && c.group.position.distanceTo(p) < radius ? [i] : []));
  }

  /** Cats that are up, for the minimap. */
  blips(): { x: number; y: number; z: number }[] {
    const now = this.now;
    return this.cats.filter((c) => now >= c.deadUntil).map((c) => ({ x: c.group.position.x, y: c.group.position.y, z: c.group.position.z }));
  }

  update(dt: number): void {
    const now = this.now;
    this.cats.forEach((c, i) => {
      const dead = now < c.deadUntil;
      const sinceDeath = CATS.respawnSeconds - (c.deadUntil - now);
      c.hit.visible = !dead;
      // Down: fall over, lie there two seconds, then gone until it comes back.
      c.group.visible = !dead || sinceDeath < 2.5;
      if (dead) {
        this.play(c, 'Death');
        c.mixer.update(dt);
        return;
      }
      const p = onLoop(CATS.cats[i] as Point[], now + i * 7);
      c.group.position.set(p.x, this.floorAt(p.x, p.z), p.z);
      c.group.rotation.y = p.heading;
      this.play(c, p.walking ? 'Walk' : 'Idle');
      c.mixer.update(dt);
      c.meowIn -= dt;
      if (c.meowIn <= 0) {
        c.meowIn = 8 + Math.random() * 25;
        meow(c.group.position);
      }
    });
  }
}
