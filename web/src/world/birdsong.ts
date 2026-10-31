import * as THREE from 'three';
import { sound } from '../sound';
import type { BirdKind } from './birds';
import { house } from './houseData';

/**
 * Birdsong round the main house and the bungalow, made in code (no sound files): a blackbird's
 * fluting phrases, a robin's thin warble, sparrows chirping, the wood pigeon's five-note coo,
 * starlings' chatter, a magpie's rattle, and from the trees and hedges a great tit and a
 * chiffchaff. A song every few seconds from somewhere near you: from a bird you can see sitting,
 * or one hidden in a tree or hedge. Softer and rarer when you are indoors. No graphics at all.
 */

type Song = (ctx: AudioContext, out: AudioNode, t: number) => void;

const r = (a: number, b: number) => a + Math.random() * (b - a);

/** One whistled note: a sine gliding from f0 to f1 with a quick rise and fall. */
function note(ctx: AudioContext, out: AudioNode, t: number, len: number, f0: number, f1: number, vol: number, type: OscillatorType = 'sine'): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.025, len * 0.3));
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + len + 0.02);
}

let noise: AudioBuffer | null = null;
/** A short burst of filtered noise (a magpie's rattle). */
function burst(ctx: AudioContext, out: AudioNode, t: number, len: number, freq: number, vol: number): void {
  if (!noise) {
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.25), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource();
  s.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 3;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random() * 0.15);
  s.stop(t + len + 0.02);
}

const SONGS: Record<string, Song> = {
  /** Rich, low fluting notes, then a squeaky twitter at the end. */
  blackbird(ctx, out, t) {
    for (let i = 0, n = Math.floor(r(4, 8)); i < n; i++) {
      const len = r(0.09, 0.26);
      const f = r(1300, 2500);
      note(ctx, out, t, len, f, f * r(0.82, 1.25), 0.22);
      t += len + r(0.03, 0.09);
    }
    for (let i = 0, n = Math.floor(r(2, 5)); i < n; i++) {
      const f = r(3500, 6000);
      note(ctx, out, t, 0.045, f, f * r(0.7, 1.3), 0.08);
      t += 0.06;
    }
  },
  /** High, thin, quick notes jumping about. */
  robin(ctx, out, t) {
    for (let i = 0, n = Math.floor(r(8, 15)); i < n; i++) {
      const len = r(0.05, 0.14);
      const f = r(2600, 7200);
      note(ctx, out, t, len, f, f * r(0.7, 1.4), 0.11);
      t += len + r(0.01, 0.05);
    }
  },
  /** Chirp, chirp: short buzzy notes rising and falling. */
  sparrow(ctx, out, t) {
    for (let i = 0, n = Math.floor(r(3, 7)); i < n; i++) {
      const f = r(3000, 3700);
      note(ctx, out, t, 0.04, f, f * 1.3, 0.1, 'triangle');
      note(ctx, out, t + 0.04, 0.05, f * 1.3, f * 0.85, 0.1, 'triangle');
      t += r(0.18, 0.32);
    }
  },
  /** The wood pigeon: coo-COO-coo, coo-coo. */
  pigeon(ctx, out, t) {
    const base = r(380, 430);
    for (const [len, lift, gap] of [[0.32, 1.0, 0.08], [0.52, 1.12, 0.1], [0.3, 1.0, 0.36], [0.3, 1.02, 0.1], [0.42, 0.95, 0]]) {
      note(ctx, out, t, len, base * lift * 0.94, base * lift, 0.3);
      t += len + gap;
    }
  },
  /** Starlings: clicks, whistles and wheezes all mixed up. */
  starling(ctx, out, t) {
    for (let i = 0, n = Math.floor(r(10, 20)); i < n; i++) {
      const len = r(0.03, 0.09);
      const f = r(1500, 6500);
      note(ctx, out, t, len, f, f * r(0.6, 1.6), 0.06, Math.random() < 0.3 ? 'sawtooth' : 'sine');
      t += len + r(0.0, 0.06);
    }
  },
  /** The magpie's dry rattle: chak-chak-chak. */
  magpie(ctx, out, t) {
    for (let i = 0, n = Math.floor(r(4, 8)); i < n; i++) {
      burst(ctx, out, t, 0.07, r(1600, 2000), 0.25);
      t += 0.11;
    }
  },
  /** The great tit's teacher-teacher. */
  tit(ctx, out, t) {
    for (let i = 0, n = Math.floor(r(3, 6)); i < n; i++) {
      note(ctx, out, t, 0.09, 5100, 4900, 0.09);
      note(ctx, out, t + 0.12, 0.1, 3800, 3600, 0.09);
      t += 0.34;
    }
  },
  /** The chiffchaff saying its name: two notes back and forth. */
  chiffchaff(ctx, out, t) {
    for (let i = 0, n = Math.floor(r(6, 11)); i < n; i++) {
      const f = i % 2 ? 4500 : 5700;
      note(ctx, out, t, 0.06, f * 1.05, f * 0.95, 0.07);
      t += r(0.3, 0.42);
    }
  },
};

/** Which songs come from which birds you can see; hidden ones sing from the trees and hedges. */
const OF: Partial<Record<BirdKind, string>> = { sparrow: 'sparrow', blackbird: 'blackbird', robin: 'robin', pigeon: 'pigeon', starling: 'starling', magpie: 'magpie' };
const HIDDEN = ['robin', 'tit', 'chiffchaff', 'blackbird', 'tit', 'robin', 'sparrow'];

// The bungalow's walls (its roof's corners) and the main house's, for "indoors".
const BUNGALOW: [number, number][] = [[83.34, 197.19], [92.3, 186.43], [85.16, 180.48], [76.2, 191.23]];
function inside(x: number, z: number, ring: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

export class Birdsong {
  private wait = 3;
  private trees: THREE.Vector3[];
  private hedges: THREE.Vector3[] = [];

  constructor(private sitting: (at: THREE.Vector3, radius: number) => { pos: THREE.Vector3; kind: BirdKind }[], sites: THREE.Vector3[]) {
    // Song posts in the trees round both gardens (two thirds of the way up the crown), and along the main house's hedges.
    this.trees = (house.surroundings?.trees ?? [])
      .filter((t) => sites.some((s) => Math.hypot(t.x - s.x, t.z - s.z) < 140))
      .map((t) => new THREE.Vector3(t.x, t.y + t.h * 0.65, t.z));
    for (let z = -22; z < 16; z += 3) this.hedges.push(new THREE.Vector3(11.65, 1.4, z), new THREE.Vector3(-2.75, 1.4, z));
  }

  update(dt: number, eye: THREE.Vector3, awake: boolean): void {
    this.wait -= dt;
    if (this.wait > 0) return;
    const indoors = (eye.x > 0 && eye.x < 9.02 && eye.z > -3 && eye.z < 12.02 && eye.y < 9.5) || (inside(eye.x, eye.z, BUNGALOW) && eye.y < 6.5);
    this.wait = (indoors ? 4 : 1.6) + Math.random() * (indoors ? 8 : 3.5);
    if (!awake) return;
    const ctx = sound.context();
    if (!ctx || ctx.state !== 'running') return;
    let at: THREE.Vector3 | null = null;
    let song = '';
    const seen = this.sitting(eye, 35).filter((b) => OF[b.kind]);
    if (seen.length && Math.random() < 0.55) {
      const b = seen[Math.floor(Math.random() * seen.length)];
      at = b.pos;
      song = OF[b.kind]!;
    } else {
      const posts = [...this.trees, ...this.hedges].filter((p) => p.distanceTo(eye) < 40);
      if (!posts.length) return;
      at = posts[Math.floor(Math.random() * posts.length)];
      song = HIDDEN[Math.floor(Math.random() * HIDDEN.length)];
    }
    const out = sound.at(at.x, at.y, at.z, 4);
    if (!out) return;
    if (indoors) {
      // Through the glass: muffled and quieter.
      const glass = ctx.createBiquadFilter();
      glass.type = 'lowpass';
      glass.frequency.value = 1800;
      const g = ctx.createGain();
      g.gain.value = 0.35;
      glass.connect(g).connect(out);
      SONGS[song](ctx, glass, ctx.currentTime + 0.05);
    } else SONGS[song](ctx, out, ctx.currentTime + 0.05);
  }
}
