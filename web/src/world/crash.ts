import * as THREE from 'three';
import { sound } from '../sound';
import type { CarFx, CarWater, CrashHit } from './car';
import type { Particles, Spawn } from './particles';
import type { Splashes } from './splashes';
import { PARTICLE } from './sprites';
import { windAt } from './wind';

/**
 * A car crashing into something (world/car.ts onCrash): what flies off and how it sounds, by what it hit.
 * Against metal (a fence, a pole, another car) sparks and a ringing crunch of panels; against brick,
 * plaster or concrete a cloud of dust and grit; into a tree bark and splinters, and leaves shaken down
 * from the crown; into a hedge a burst of leaves and twigs and a rustle. Harder hits throw more, and
 * above about 25 km/h a light's glass tinkles. All from the shared particle pools (world/particles.ts)
 * and made in code like the other sounds (nothing to download). Each page shows its own: the others'
 * cars from how they stop. A young tree is wood with its crown low; a car pushing through a hedge throws
 * leaves (brush), one in the water a splash and a bow wave (water), a crumpled bonnet steam (steam):
 * world/car.ts Car.fx, world/carDamage.ts.
 */

type Surface = 'metal' | 'masonry' | 'wood' | 'hedge';

/** What a hit block or thing is, by its material, name or key. */
function surfaceOf(what: string): Surface {
  if (what === 'tree' || what === 'sapling' || /wood|oak|walnut|cladding|timber|plank/.test(what)) return 'wood';
  if (/hedge|leaves|shrub|bush/.test(what)) return 'hedge';
  if (/^car-|^bike|steel|rail|alu|fence|metal|lamp|gate|glass/.test(what)) return 'metal'; // the village's poles are concrete: dust
  return 'masonry';
}

/** Dust per wall: red brick, yellow brick, render, concrete. */
function dustOf(what: string): string {
  if (/red|brick|nb_wall|claustra/.test(what)) return '#b98a72';
  if (/yellow|buff|old_brick/.test(what)) return '#d8c7a4';
  if (/white|render|plaster/.test(what)) return '#e2ddd3';
  return '#c4beb3';
}

/**
 * The dust a landing throws up, by the ground's material (none: the bare ground, earth and grass): gravel's grey,
 * earth's brown, a thinner pale one off grass; the bits thrown with it. None off paving.
 */
function landDust(mat: string): { color: string; bits: string; alpha: number } | null {
  if (/gravel|sand/i.test(mat)) return { color: '#bdb5a6', bits: '#8d877c', alpha: 0.5 };
  if (!mat || /earth|soil|mud|field|forest|leaves/i.test(mat)) return { color: '#9b8466', bits: '#5e4a35', alpha: 0.45 };
  if (/grass|lawn|meadow|moss/i.test(mat)) return { color: '#a89a78', bits: '#55662f', alpha: 0.3 };
  return null;
}

let noise: AudioBuffer | null = null;
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise?.sampleRate === c.sampleRate) return noise;
  noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

export class Crash {
  private s: Spawn = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.1, size1: 0.1,
    c0: new THREE.Color(), c1: new THREE.Color(), alpha: 1, cell: 0, drag: 0, gravity: 0, spin: 0, stretch: 0,
  };
  private last = 0;
  private lastLand = 0;

  constructor(private particles: Particles) {}

  /** `n` particles from (x, y, z) thrown out along (nx, 0, nz) and up, spread by `cone`, at about `speed` m/s. */
  private throw(h: CrashHit, n: number, speed: number, cone: number, up: number, set: (s: Spawn) => void, add = false): void {
    const s = this.s;
    const k = Math.round(n * this.particles.budget);
    for (let i = 0; i < k; i++) {
      const v = speed * (0.4 + Math.random() * 0.8);
      s.x = h.x + (Math.random() - 0.5) * 0.6;
      s.y = h.y + (Math.random() - 0.5) * 0.4;
      s.z = h.z + (Math.random() - 0.5) * 0.6;
      s.vx = (h.nx + (Math.random() - 0.5) * 2 * cone) * v;
      s.vy = (up + (Math.random() - 0.2) * cone) * v;
      s.vz = (h.nz + (Math.random() - 0.5) * 2 * cone) * v;
      s.spin = s.stretch = s.drag = s.gravity = 0;
      set(s);
      this.particles.spawn(s, add);
    }
  }

  /**
   * A car coming down on the ground (world/car.ts landed: `h.speed` m/s downwards, `h.what` the ground's material,
   * (nx, nz) the way it points): a puff of dust round its wheels off gravel, earth or grass, more the harder it
   * lands, and from about 6 m/s down a crunch, softer than a crash's. Nothing on paving but the thump the car makes.
   */
  land(h: CrashHit): void {
    const now = performance.now();
    if (now - this.lastLand < 150) return;
    this.lastLand = now;
    const k = Math.min(1, (h.speed - 1) / 7); // 0 a small hop .. 1 about a 3 m drop
    const dust = landDust(h.what);
    if (dust && h.speed > 1.5) {
      const s = this.s;
      const n = Math.round((6 + 18 * k) * this.particles.budget);
      const [rx, rz] = [-h.nz, h.nx]; // to the car's right
      for (let i = 0; i < n; i++) {
        // From under the four wheels (2.9 m apart, 1.6 m across), blown out sideways and along, low.
        const along = (i % 2 ? 1.45 : -1.45) + (Math.random() - 0.5) * 0.6;
        const across = (i % 4 < 2 ? 0.9 : -0.9) + (Math.random() - 0.5) * 0.4;
        const out = (0.8 + 1.6 * k) * (0.5 + Math.random());
        s.x = h.x + h.nx * along + rx * across;
        s.y = h.y + Math.random() * 0.15;
        s.z = h.z + h.nz * along + rz * across;
        s.vx = rx * Math.sign(across) * out + (Math.random() - 0.5);
        s.vy = 0.3 + Math.random() * (0.4 + 0.8 * k);
        s.vz = rz * Math.sign(across) * out + (Math.random() - 0.5);
        s.stretch = 0;
        Object.assign(s, { life: 1 + Math.random() * 1.2, size0: 0.25, size1: 1 + 1.2 * k, alpha: dust.alpha, cell: PARTICLE.puff, drag: 2.6, gravity: -0.1, spin: (Math.random() - 0.5) * 1.5 });
        s.c0.set(dust.color);
        s.c1.copy(s.c0).multiplyScalar(1.08);
        this.particles.spawn(s);
      }
      // Grit and bits of turf thrown up.
      this.throw({ ...h, nx: 0, nz: 0 }, 4 + 10 * k, 1.5 + 2 * k, 1, 0.8, (p) => {
        Object.assign(p, { life: 0.5 + Math.random() * 0.4, size0: 0.02 + Math.random() * 0.03, size1: 0.02, alpha: 1, cell: PARTICLE.chip, drag: 0.4, gravity: 9.8, spin: (Math.random() - 0.5) * 25 });
        p.c0.set(dust.bits);
        p.c1.copy(p.c0);
      });
    }
    // A hard landing sounds like a crash, a softer one and without breaking glass (the thump is the car's own,
    // world/carSound.ts).
    if (h.speed > 6) this.crunch({ ...h, speed: Math.min(7, 1.5 + (h.speed - 6) * 1.5) }, 'masonry');
  }

  hit(h: CrashHit): void {
    if (h.land) return this.land(h);
    const now = performance.now();
    if (now - this.last < 120) return; // one crash, not one per frame of scraping
    this.last = now;
    const surface = surfaceOf(h.what);
    const k = Math.min(1, (h.speed - 2) / 14); // 0 a nudge .. 1 about 60 km/h
    if (surface === 'metal' || (surface === 'masonry' && h.speed > 8)) {
      // Sparks: bright, stretched along their flight, falling.
      this.throw(h, (surface === 'metal' ? 16 : 6) + 44 * k, 4 + 7 * k, 0.9, 0.25, (s) => {
        Object.assign(s, { life: 0.25 + Math.random() * 0.4, size0: 0.032, size1: 0.012, alpha: 1, cell: PARTICLE.glow, gravity: 9.8, drag: 0.6, stretch: 0.1 });
        s.c0.setRGB(4, 2.6, 1);
        s.c1.setRGB(2.4, 0.6, 0.1);
      }, true);
      // The flash where metal meets.
      this.throw(h, 1, 0, 0, 0, (s) => {
        Object.assign(s, { life: 0.09, size0: 0.5 + 0.6 * k, size1: 0.3, alpha: 1, cell: PARTICLE.glow });
        s.c0.setRGB(3, 2.3, 1.5);
        s.c1.copy(s.c0);
      }, true);
    }
    if (surface === 'masonry') {
      const dust = new THREE.Color(dustOf(h.what));
      this.throw(h, 5 + 14 * k, 1.2 + 1.5 * k, 0.7, 0.3, (s) => {
        Object.assign(s, { life: 1.2 + Math.random() * 1.2, size0: 0.3, size1: 1.4 + k, alpha: 0.5, cell: PARTICLE.puff, drag: 2.4, gravity: -0.15, spin: (Math.random() - 0.5) * 1.5 });
        s.c0.copy(dust);
        s.c1.copy(dust).multiplyScalar(1.08);
      });
      this.throw(h, 6 + 20 * k, 2.5 + 3 * k, 0.8, 0.6, (s) => {
        Object.assign(s, { life: 0.6 + Math.random() * 0.5, size0: 0.02 + Math.random() * 0.03, size1: 0.02, alpha: 1, cell: PARTICLE.chip, drag: 0.4, gravity: 9.8, spin: (Math.random() - 0.5) * 25 });
        s.c0.copy(dust).multiplyScalar(0.8);
        s.c1.copy(s.c0);
      });
    }
    if (surface === 'wood') {
      this.throw(h, 6 + 16 * k, 2.5 + 3 * k, 0.8, 0.6, (s) => {
        Object.assign(s, { life: 0.8 + Math.random() * 0.6, size0: 0.04 + Math.random() * 0.05, size1: 0.035, alpha: 1, cell: PARTICLE.chip, drag: 0.5, gravity: 9.8, spin: (Math.random() - 0.5) * 30 });
        s.c0.set(Math.random() < 0.5 ? '#5a4632' : '#a8814f'); // bark and the wood under it
        s.c1.copy(s.c0);
      });
      if (h.what === 'tree') this.leaves({ ...h, y: h.y + 3.5 }, 6 + 22 * k, 1.8);
      if (h.what === 'sapling') this.leaves({ ...h, y: h.y + 1.8 }, 10 + 20 * k, 1); // a young tree shaken, its crown low
    }
    if (surface === 'hedge') {
      this.leaves(h, 10 + 24 * k, 0.6);
      this.throw(h, 4 + 8 * k, 2 + 2 * k, 0.8, 0.5, (s) => {
        Object.assign(s, { life: 0.6 + Math.random() * 0.4, size0: 0.03, size1: 0.025, alpha: 1, cell: PARTICLE.chip, drag: 0.6, gravity: 9.8, spin: (Math.random() - 0.5) * 20 });
        s.c0.set('#4b3b28');
        s.c1.copy(s.c0);
      });
    }
    // A light's glass, from a hard hit on anything firm.
    if (h.speed > 7 && surface !== 'hedge') {
      this.throw(h, 4 + 10 * k, 2 + 2 * k, 0.9, 0.5, (s) => {
        Object.assign(s, { life: 0.5 + Math.random() * 0.4, size0: 0.012 + Math.random() * 0.012, size1: 0.01, alpha: 0.9, cell: PARTICLE.chip, drag: 0.3, gravity: 9.8, spin: (Math.random() - 0.5) * 40 });
        s.c0.setRGB(0.85, 0.9, 0.95);
        s.c1.copy(s.c0);
      });
    }
    this.crunch(h, surface);
  }

  /**
   * A car pushing through a hedge (world/car.ts, every so often while it is in one; (nx, nz) the way it goes): leaves
   * and bits of twig thrown up and ahead off its front, more the faster. The rustle is the car's own (world/carSound.ts).
   */
  brush(h: CrashHit): void {
    const k = Math.min(1, h.speed / 10);
    this.leaves({ ...h, y: h.y + 0.4 }, 4 + 12 * k, 0.7);
    this.throw(h, 2 + 6 * k, 1.2 + 2.5 * k, 0.9, 0.7, (s) => {
      Object.assign(s, { life: 0.5 + Math.random() * 0.4, size0: 0.025, size1: 0.02, alpha: 1, cell: PARTICLE.chip, drag: 0.8, gravity: 9.8, spin: (Math.random() - 0.5) * 20 });
      s.c0.set(Math.random() < 0.5 ? '#4b3b28' : '#5b6b2e');
      s.c1.copy(s.c0);
    });
  }

  /**
   * A car in a pond or a ditch (world/car.ts): going in at speed, a burst from its nose and both sides (the splashes'
   * own, world/splashes.ts) and a heavy slosh; moving through it, a bow wave: water pushed up and out to both sides off
   * its nose, and a ring spreading behind it.
   */
  water(w: CarWater, splashes: Splashes): void {
    const nx = w.x + w.fx * w.halfL;
    const nz = w.z + w.fz * w.halfL;
    const [rx, rz] = [-w.fz, w.fx]; // to its right
    if (w.enter) {
      splashes.plunge(nx, nz, w.level, Math.min(12, w.speed));
      for (const side of [-1, 1]) splashes.plunge(w.x + rx * side * w.halfW, w.z + rz * side * w.halfW, w.level, Math.min(8, w.speed * 0.6));
      this.slosh(nx, w.level, nz, Math.min(1, w.speed / 10));
      return;
    }
    const k = Math.min(1, w.speed / 8);
    const s = this.s;
    const n = Math.round((3 + 9 * k) * this.particles.budget);
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const along = Math.random() * 0.6;
      const out = (1 + 2.5 * k) * (0.6 + Math.random() * 0.6);
      s.x = nx - w.fx * along + rx * side * (0.3 + Math.random() * (w.halfW - 0.3));
      s.y = w.level + 0.05;
      s.z = nz - w.fz * along + rz * side * (0.3 + Math.random() * (w.halfW - 0.3));
      s.vx = rx * side * out + w.fx * w.speed * 0.6;
      s.vy = 0.8 + Math.random() * (1 + 2 * k);
      s.vz = rz * side * out + w.fz * w.speed * 0.6;
      Object.assign(s, { life: 0.45 + Math.random() * 0.35, size0: 0.04 + Math.random() * 0.04, size1: 0.03, alpha: 0.75, cell: PARTICLE.chip, drag: 0.6, gravity: 9.8, spin: 0, stretch: 0.04 });
      s.c0.setRGB(0.78, 0.84, 0.84);
      s.c1.copy(s.c0);
      this.particles.spawn(s);
    }
    if (Math.random() < 0.5) splashes.ring(nx, w.level, nz, w.halfW * 2 * (0.7 + 0.8 * k), 1.6, 0.35);
  }

  private steamT = 0;
  /** Steam from under a crumpled bonnet at (x, y, z) (world/carDamage.ts), `k` 0 to 1 as it thins out over a minute: pale wisps rising. */
  steam(x: number, y: number, z: number, k: number, dt: number): void {
    this.steamT += dt * (1.5 + 6 * k) * this.particles.budget;
    const s = this.s;
    while (this.steamT >= 1) {
      this.steamT -= 1;
      s.x = x + (Math.random() - 0.5) * 0.5;
      s.y = y;
      s.z = z + (Math.random() - 0.5) * 0.5;
      s.vx = (Math.random() - 0.5) * 0.3;
      s.vy = 0.5 + Math.random() * 0.5;
      s.vz = (Math.random() - 0.5) * 0.3;
      Object.assign(s, { life: 2 + Math.random() * 1.2, size0: 0.2, size1: 1 + 0.6 * k, alpha: 0.06 + 0.14 * k, cell: PARTICLE.puff, drag: 1.2, gravity: -0.3, spin: (Math.random() - 0.5) * 1.2, stretch: 0 });
      s.c0.setRGB(0.93, 0.94, 0.95);
      s.c1.copy(s.c0);
      this.particles.spawn(s);
    }
  }

  /** What a car does in the world through this (world/car.ts Car.fx): leaves in a hedge, the water it throws, steam. */
  carFx(splashes: Splashes): CarFx {
    return { brush: (h) => this.brush(h), water: (w) => this.water(w, splashes), steam: (x, y, z, k, dt) => this.steam(x, y, z, k, dt) };
  }

  /** A car going into the water: a heavy slosh (low noise falling away) and the water's spatter after it. */
  private slosh(x: number, y: number, z: number, k: number): void {
    const c = sound.context();
    const dest = c && sound.at(x, y, z, 5);
    if (!c || !dest) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.7);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 + 0.5 * k, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 1);
    for (let i = 0; i < 8; i++) {
      const at = t + 0.15 + Math.random() * 0.7;
      const d = c.createBufferSource();
      d.buffer = noiseBuffer(c);
      const b = c.createBiquadFilter();
      b.type = 'bandpass';
      b.frequency.value = 1500 + Math.random() * 2500;
      b.Q.value = 4;
      const dg = c.createGain();
      dg.gain.setValueAtTime(0.0001, at);
      dg.gain.exponentialRampToValueAtTime(0.05 * (0.5 + k), at + 0.004);
      dg.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      d.connect(b).connect(dg).connect(dest);
      d.start(at, Math.random() * 0.8);
      d.stop(at + 0.06);
    }
  }

  /** Leaves falling from (x, y, z): green and the browns of November, drifting, turning, slowly down. */
  private leaves(h: CrashHit, n: number, spread: number): void {
    const s = this.s;
    const k = Math.round(n * this.particles.budget);
    const w = windAt(h.x, h.z); // carried off with the wind (world/wind.ts)
    for (let i = 0; i < k; i++) {
      s.x = h.x + (Math.random() - 0.5) * spread * 2;
      s.y = h.y + (Math.random() - 0.3) * spread;
      s.z = h.z + (Math.random() - 0.5) * spread * 2;
      s.vx = h.nx * (0.5 + Math.random()) + (Math.random() - 0.5) + w.x * 0.35;
      s.vy = 0.4 + Math.random() * 0.8;
      s.vz = h.nz * (0.5 + Math.random()) + (Math.random() - 0.5) + w.z * 0.35;
      Object.assign(s, { life: 2 + Math.random() * 2, size0: 0.05, size1: 0.045, alpha: 1, cell: PARTICLE.chip, drag: 2.6, gravity: 1.2, spin: (Math.random() - 0.5) * 6, stretch: 0 });
      s.c0.set(['#4f6b2e', '#6b7a33', '#9a7a35', '#8a5a2b'][i % 4]);
      s.c1.copy(s.c0).multiplyScalar(0.9);
      this.particles.spawn(s);
    }
  }

  /**
   * The crunch: a crumple of short noise grains (sheet metal folding), lower and grittier against masonry;
   * the panels' ring against metal; a crack and a rustle into a tree or a hedge; a tinkle of glass when hard.
   */
  private crunch(h: CrashHit, surface: Surface): void {
    const c = sound.context();
    const dest = c && sound.at(h.x, h.y, h.z, 4);
    if (!c || !dest) return;
    const t = c.currentTime;
    const loud = Math.min(1, (h.speed - 1.5) / 12);
    const grain = (at: number, freq: number, q: number, gain: number, len: number, type: BiquadFilterType = 'bandpass') => {
      const src = c.createBufferSource();
      src.buffer = noiseBuffer(c);
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      src.connect(f).connect(g).connect(dest);
      src.start(at, Math.random() * 0.8);
      src.stop(at + len + 0.02);
    };
    const ring = (at: number, freq: number, gain: number, len: number) => {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(freq, at);
      o.frequency.exponentialRampToValueAtTime(freq * 0.96, at + len);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g).connect(dest);
      o.start(at);
      o.stop(at + len + 0.02);
    };
    if (surface === 'hedge') {
      grain(t, 3200, 0.6, 0.35 * loud, 0.5, 'highpass'); // the rustle
      for (let i = 0; i < 3; i++) grain(t + Math.random() * 0.15, 2000 + Math.random() * 1500, 3, 0.2 * loud, 0.03); // twigs snapping
      return;
    }
    // The body folding: grains spread over a fifth of a second, more and louder the harder.
    const grains = 5 + Math.round(9 * loud);
    const low = surface === 'masonry' ? 0.55 : 1;
    for (let i = 0; i < grains; i++) {
      const at = t + Math.random() * (0.05 + 0.15 * loud);
      grain(at, (700 + Math.random() * 1900) * low, 1.2 + Math.random() * 2, (0.25 + 0.4 * Math.random()) * loud, 0.03 + Math.random() * 0.05);
    }
    if (surface === 'metal') for (const [f, g, l] of [[330, 0.12, 0.6], [870, 0.07, 0.45], [1460, 0.05, 0.35], [2210, 0.03, 0.25]]) ring(t, f * (0.92 + Math.random() * 0.16), g * loud, l);
    if (surface === 'masonry') for (let i = 0; i < 6; i++) grain(t + 0.08 + Math.random() * 0.4, 2500 + Math.random() * 2500, 4, 0.06 * loud, 0.025); // grit falling
    if (surface === 'wood') {
      grain(t, 260, 1.5, 0.5 * loud, 0.12, 'lowpass'); // the trunk's knock
      grain(t + 0.15, 3000, 0.6, 0.15 * loud, 0.8, 'highpass'); // the crown's leaves
    }
    if (h.speed > 7) for (let i = 0; i < 6 + Math.round(6 * loud); i++) ring(t + 0.03 + Math.random() * 0.35, 3000 + Math.random() * 4000, 0.03 * loud, 0.08 + Math.random() * 0.1);
  }
}
