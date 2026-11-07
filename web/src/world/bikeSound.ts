import { sound } from '../sound';

/**
 * A bike's sounds, all made in code (nothing to download), from where the bike is:
 *
 * - the bell: two quick strikes of a small dome bell, a bright note with the uneven overtones of
 *   struck metal, ringing out for half a second;
 * - the tyres on the road, a soft rush that rises with speed, rougher off the paving;
 * - the freewheel ticking while it rolls without pedalling, faster with the speed;
 * - a knock when it runs into something.
 *
 * The rolling sound starts when the bike first moves (after a first click or key: browsers keep
 * sound off until then).
 */

let noise: AudioBuffer | null = null;
/** A second of white noise, made once per sample rate. */
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise?.sampleRate === c.sampleRate) return noise;
  noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

/** The bell's partials: a dome's struck note and its inharmonic overtones, each with its share and how long it rings (s). */
const BELL: [number, number, number][] = [[1, 1, 0.55], [2.76, 0.45, 0.3], [5.4, 0.22, 0.16], [8.9, 0.1, 0.08]];
const BELL_HZ = 2350;

/** Ring a bell at (x, y, z): two strikes. */
export function ringBell(x: number, y: number, z: number): void {
  const c = sound.context();
  const at = sound.at(x, y, z, 3);
  if (!c || !at) return;
  const t0 = c.currentTime;
  for (const [k, strike] of [[0, 1], [0.13, 0.85]] as const) {
    const t = t0 + k;
    for (const [ratio, share, ring] of BELL) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(BELL_HZ * ratio * (1 + (Math.random() - 0.5) * 0.004), t);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09 * share * strike, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ring);
      o.connect(g).connect(at);
      o.start(t);
      o.stop(t + ring + 0.02);
    }
    // The clapper's tick on the dome.
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const band = c.createBiquadFilter();
    band.type = 'highpass';
    band.frequency.value = 3500;
    const g = c.createGain();
    g.gain.setValueAtTime(0.05 * strike, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    src.connect(band).connect(g).connect(at);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.03);
  }
}

/** What the bike is doing this frame, for its sound. */
export interface BikeNoise {
  x: number;
  y: number;
  z: number;
  /** m/s */
  speed: number;
  /** Rolling without pedalling: the freewheel ticks */
  coasting: boolean;
  /** On grass, earth or gravel rather than paving */
  rough: boolean;
}

interface Loop {
  at: PannerNode;
  src: AudioBufferSourceNode;
  roll: BiquadFilterNode;
  road: GainNode;
}

export class BikeSound {
  private loop: Loop | null = null;
  private tick = 0;

  /** Every frame the bike is in sight. */
  update(n: BikeNoise, dt: number): void {
    if (!this.loop && n.speed < 0.3) return; // not before it first moves
    const c = sound.context();
    if (!c) return;
    const a = (this.loop ??= this.start(c, n));
    const t = c.currentTime;
    const v = n.speed;
    a.at.positionX.setTargetAtTime(n.x, t, 0.03);
    a.at.positionY.setTargetAtTime(n.y + 0.3, t, 0.03);
    a.at.positionZ.setTargetAtTime(n.z, t, 0.03);
    a.roll.frequency.setTargetAtTime((n.rough ? 300 : 500) + v * (n.rough ? 60 : 110), t, 0.1);
    a.road.gain.setTargetAtTime(Math.min(n.rough ? 0.09 : 0.05, v * (n.rough ? 0.012 : 0.006)), t, 0.1);
    // The freewheel: a click per pawl passing, about six a metre, at most twenty-five a second.
    if (n.coasting && v > 0.8) {
      this.tick += dt * Math.min(25, v * 6);
      if (this.tick >= 1) {
        this.tick %= 1;
        this.click(c, a.at, v);
      }
    } else this.tick = 0;
  }

  /** A knock from (x, y, z): `strength` about the speed of the knock (m/s). */
  thump(x: number, y: number, z: number, strength: number): void {
    const c = sound.context();
    const at = sound.at(x, y + 0.4, z, 2);
    if (!c || !at || !(strength > 0)) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const low = c.createBiquadFilter();
    low.type = 'bandpass';
    low.frequency.value = 600 + strength * 80;
    low.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(Math.min(0.6, 0.05 + strength / 12), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(low).connect(g).connect(at);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.3);
  }

  /** Quiet again (out of sight, taken away). */
  stop(): void {
    if (!this.loop) return;
    this.loop.src.stop();
    this.loop.at.disconnect();
    this.loop = null;
  }

  private click(c: AudioContext, at: AudioNode, v: number): void {
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 4200;
    band.Q.value = 3;
    const g = c.createGain();
    g.gain.setValueAtTime(0.03 + Math.min(0.02, v * 0.002), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    src.connect(band).connect(g).connect(at);
    src.start(t, Math.random() * 0.9);
    src.stop(t + 0.015);
  }

  private start(c: AudioContext, n: BikeNoise): Loop {
    const at = sound.at(n.x, n.y + 0.3, n.z, 3) as PannerNode;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    src.loop = true;
    const roll = c.createBiquadFilter();
    roll.type = 'lowpass';
    roll.frequency.value = 500;
    roll.Q.value = 0.7;
    const road = c.createGain();
    road.gain.value = 0;
    src.connect(roll).connect(road).connect(at);
    src.start();
    return { at, src, roll, road };
  }
}
