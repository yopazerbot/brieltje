import * as THREE from 'three';
import { sound } from '../sound';
import type { CrashHit } from './car';
import type { Particles, Spawn } from './particles';
import { PARTICLE } from './sprites';

/**
 * A car crashing into something (world/car.ts onCrash): what flies off and how it sounds, by what it hit.
 * Against metal (a fence, a pole, another car) sparks and a ringing crunch of panels; against brick,
 * plaster or concrete a cloud of dust and grit; into a tree bark and splinters, and leaves shaken down
 * from the crown; into a hedge a burst of leaves and twigs and a rustle. Harder hits throw more, and
 * above about 25 km/h a light's glass tinkles. All from the shared particle pools (world/particles.ts)
 * and made in code like the other sounds (nothing to download). Each page shows its own: the others'
 * cars from how they stop.
 */

type Surface = 'metal' | 'masonry' | 'wood' | 'hedge';

/** What a hit block or thing is, by its material, name or key. */
function surfaceOf(what: string): Surface {
  if (what === 'tree' || /wood|oak|walnut|cladding|timber|plank/.test(what)) return 'wood';
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

  hit(h: CrashHit): void {
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

  /** Leaves falling from (x, y, z): green and the browns of November, drifting, turning, slowly down. */
  private leaves(h: CrashHit, n: number, spread: number): void {
    const s = this.s;
    const k = Math.round(n * this.particles.budget);
    for (let i = 0; i < k; i++) {
      s.x = h.x + (Math.random() - 0.5) * spread * 2;
      s.y = h.y + (Math.random() - 0.3) * spread;
      s.z = h.z + (Math.random() - 0.5) * spread * 2;
      s.vx = h.nx * (0.5 + Math.random()) + (Math.random() - 0.5);
      s.vy = 0.4 + Math.random() * 0.8;
      s.vz = h.nz * (0.5 + Math.random()) + (Math.random() - 0.5);
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
