import { sound } from '../sound';

/**
 * A car's sound, all made in code (nothing to download), from where the car is:
 *
 * - the electric motor's whine, two thin notes whose pitch follows the speed, louder on the pedal and a
 *   little when it slows down on the motor;
 * - the tyres rolling, a rushing that rises with speed and gets rougher off the paving;
 * - the wind round the body at high speed;
 * - a squeal while the tyres slide (world/carBody.ts: skid), a scrub instead on grass or gravel;
 * - a thump when it goes over a kerb or runs into something.
 *
 * The loop starts when the car first moves (after your first click or key: browsers keep sound off
 * until then) and runs while the car is in the game.
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

interface Loop {
  at: PannerNode;
  sources: AudioScheduledSourceNode[];
  whine: OscillatorNode;
  whine2: OscillatorNode;
  motor: GainNode;
  roll: BiquadFilterNode;
  road: GainNode;
  windBand: BiquadFilterNode;
  wind: GainNode;
  squeal: OscillatorNode;
  squealGain: GainNode;
  squeal2: OscillatorNode;
  squeal2Gain: GainNode;
  scrub: GainNode;
}

/** What the car is doing this frame, for its sound. */
export interface CarNoise {
  x: number;
  y: number;
  z: number;
  /** m/s, either way */
  speed: number;
  /** 0 to 1: how hard the motor pulls (the pedal, or for others' cars how fast it speeds up) */
  load: number;
  /** 0 to 1: how hard it slows down on the motor */
  regen: number;
  /** 0 to 1: how hard the tyres slide */
  skid: number;
  /** m/s the tyres slide over the ground (a locked wheel: about the car's speed); the screech rises with it */
  slide?: number;
  /** On grass, earth or gravel rather than paving */
  rough: boolean;
}

export class CarSound {
  private loop: Loop | null = null;

  /** Every frame the car is in the game. */
  update(n: CarNoise): void {
    if (!this.loop && n.speed < 0.5) return; // not before it first moves
    const c = sound.context();
    if (!c) return;
    const a = (this.loop ??= this.start(c, n));
    const t = c.currentTime;
    const v = n.speed;
    a.at.positionX.setTargetAtTime(n.x, t, 0.03);
    a.at.positionY.setTargetAtTime(n.y + 0.5, t, 0.03);
    a.at.positionZ.setTargetAtTime(n.z, t, 0.03);
    // The motor: about 80 Hz at a crawl to 1.5 kHz flat out, its second note a little off three times higher.
    const f = 80 + v * 26;
    a.whine.frequency.setTargetAtTime(f, t, 0.05);
    a.whine2.frequency.setTargetAtTime(f * 3.02, t, 0.05);
    const pull = 0.35 + 0.65 * Math.max(n.load, 0.6 * n.regen);
    a.motor.gain.setTargetAtTime(Math.min(0.035, 0.002 + v * 0.0012) * pull * (v > 0.3 ? 1 : 0), t, 0.08);
    // The tyres: a low rush that opens up with speed; off the paving louder and duller.
    a.roll.frequency.setTargetAtTime((n.rough ? 160 : 250) + v * (n.rough ? 45 : 70), t, 0.1);
    a.road.gain.setTargetAtTime(Math.min(n.rough ? 0.2 : 0.14, v * (n.rough ? 0.011 : 0.0065)), t, 0.1);
    // The wind: only at speed, rising with its square.
    a.windBand.frequency.setTargetAtTime(500 + v * 18, t, 0.2);
    a.wind.gain.setTargetAtTime(0.07 * Math.min(1, (v / 55) ** 2), t, 0.2);
    // Sliding: a squeal on paving, a scrub on grass or gravel. The faster the rubber slides over the road,
    // the louder it screeches and the lower and rougher it gets (a locked wheel's long howl), its upper note
    // coming in as it gets hard.
    const s = Math.min(1, Math.max(0, n.skid));
    const slide = Math.min(15, Math.max(0, n.slide ?? 3 * s));
    a.squeal.frequency.setTargetAtTime(880 - slide * 12 + v * 4, t, 0.08);
    a.squeal2.frequency.setTargetAtTime((880 - slide * 12 + v * 4) * 1.49, t, 0.08);
    a.squealGain.gain.setTargetAtTime(n.rough ? 0 : Math.min(0.13, (0.05 + 0.006 * slide) * s), t, s > 0 ? 0.03 : 0.08);
    a.squeal2Gain.gain.setTargetAtTime(n.rough ? 0 : 0.35 * Math.max(0, s - 0.4), t, 0.05);
    a.scrub.gain.setTargetAtTime(n.rough ? Math.min(0.3, (0.15 + 0.01 * slide) * s) : 0.05 * s, t, 0.05);
  }

  private start(c: AudioContext, n: CarNoise): Loop {
    const at = sound.at(n.x, n.y + 0.5, n.z, 4) as PannerNode;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    src.loop = true;
    const gain = (v = 0) => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    const filter = (type: BiquadFilterType, f: number, q = 1) => {
      const b = c.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const osc = (type: OscillatorType, f: number) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      return o;
    };
    // The motor's two notes.
    const motor = gain();
    const whine = osc('triangle', 80);
    const whine2 = osc('sine', 240);
    const second = gain(0.25);
    whine.connect(motor);
    whine2.connect(second).connect(motor);
    motor.connect(at);
    // One noise for the tyres, the wind and the scrub, each through its own filter.
    const roll = filter('lowpass', 250, 0.7);
    const road = gain();
    src.connect(roll).connect(road).connect(at);
    const windBand = filter('bandpass', 600, 0.6);
    const wind = gain();
    src.connect(windBand).connect(wind).connect(at);
    const scrub = gain();
    src.connect(filter('bandpass', 1400, 0.9)).connect(scrub).connect(at);
    // The squeal: a sawtooth that wavers (a slow wobble on its pitch), through a narrow band.
    const squeal = osc('sawtooth', 850);
    const wobble = osc('sine', 6.3);
    const depth = gain(35);
    wobble.connect(depth).connect(squeal.frequency);
    const squealBand = filter('bandpass', 1150, 5);
    const squealGain = gain();
    squeal.connect(squealBand).connect(squealGain).connect(at);
    // Its upper note, a fifth over it and wavering the other way, mixed into the same squeal (only as it gets hard).
    const squeal2 = osc('sawtooth', 1270);
    const depth2 = gain(-50);
    wobble.connect(depth2).connect(squeal2.frequency);
    const squeal2Gain = gain();
    squeal2.connect(filter('bandpass', 1700, 6)).connect(squeal2Gain).connect(squealGain);
    const sources = [src, whine, whine2, squeal, squeal2, wobble];
    for (const s of sources) s.start();
    return { at, sources, whine, whine2, motor, roll, road, windBand, wind, squeal, squealGain, squeal2, squeal2Gain, scrub };
  }

  /** A thump from (x, y, z): `strength` about the speed of the knock (m/s), 1 a kerb, 10 a crash. */
  thump(x: number, y: number, z: number, strength: number): void {
    const c = sound.context();
    const at = sound.at(x, y + 0.5, z, 3);
    if (!c || !at || !(strength > 0)) return;
    const t = c.currentTime;
    const loud = Math.min(1, strength / 8);
    // The body's weight: a low note that drops.
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(75, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const og = c.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.05 + 0.5 * loud, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(og).connect(at);
    o.start(t);
    o.stop(t + 0.32);
    // The knock itself: a burst of dull noise.
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const low = c.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 180 + strength * 30;
    const g = c.createGain();
    g.gain.setValueAtTime(Math.min(1, 0.04 + strength / 8), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(low).connect(g).connect(at);
    src.start(t);
    src.stop(t + 0.4);
  }

  /** The car is taken away: the loop stops. */
  dispose(): void {
    if (!this.loop) return;
    for (const s of this.loop.sources) s.stop();
    this.loop.at.disconnect();
    this.loop = null;
  }
}
