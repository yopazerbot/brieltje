import { sound } from '../sound';

/**
 * The play tower's sounds, made in code as the footsteps are (src/footsteps.ts): a wooden creak for each rung of
 * the ladder, a whoosh down the slide that follows the speed, and a short "whee" as you set off. Your own, from
 * the middle.
 */

let noise: AudioBuffer | null = null;

function noiseOf(ctx: AudioContext): AudioBuffer {
  if (!noise || noise.sampleRate !== ctx.sampleRate) {
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
}

/** A rung under your foot: a low knock and a short creak of timber (a buzzy tone bending down, through a narrow band). */
export function creak(): void {
  const ctx = sound.context();
  const dest = sound.out();
  if (!ctx || !dest) return;
  const t = ctx.currentTime;
  const vary = 0.85 + Math.random() * 0.3;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(190 * vary, t);
  o.frequency.exponentialRampToValueAtTime(120 * vary, t + 0.16);
  const wobble = ctx.createOscillator(); // the stick-slip of wood on wood
  wobble.frequency.value = 38 * vary;
  const depth = ctx.createGain();
  depth.gain.value = 25;
  wobble.connect(depth).connect(o.frequency);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 900 * vary;
  band.Q.value = 6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  o.connect(band).connect(g).connect(dest);
  // The knock of the foot on the rung.
  const k = ctx.createOscillator();
  k.frequency.setValueAtTime(110 * vary, t);
  k.frequency.exponentialRampToValueAtTime(70, t + 0.08);
  const kg = ctx.createGain();
  kg.gain.setValueAtTime(0.3, t);
  kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  k.connect(kg).connect(dest);
  for (const n of [o, wobble, k]) {
    n.start(t);
    n.stop(t + 0.25);
  }
}

/** A child's "whee": a voice-like tone rising and falling, through the formants of an "ee". */
function whee(ctx: AudioContext, dest: AudioNode): void {
  const t = ctx.currentTime + 0.15;
  const base = 330 + Math.random() * 60;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(base, t);
  o.frequency.exponentialRampToValueAtTime(base * 1.9, t + 0.25);
  o.frequency.exponentialRampToValueAtTime(base * 1.25, t + 0.7);
  const vib = ctx.createOscillator();
  vib.frequency.value = 6;
  const vd = ctx.createGain();
  vd.gain.value = base * 0.03;
  vib.connect(vd).connect(o.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.06);
  g.gain.setValueAtTime(0.12, t + 0.45);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
  for (const [f, q, gain] of [[320, 5, 1], [2700, 8, 0.6], [3300, 10, 0.3]] as const) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = q;
    const fg = ctx.createGain();
    fg.gain.value = gain;
    o.connect(bp).connect(fg).connect(g);
  }
  g.connect(dest);
  for (const n of [o, vib]) {
    n.start(t);
    n.stop(t + 0.8);
  }
}

/** The whoosh down the slide: a loop of noise through a band that opens and grows louder with the speed. */
export class SlideSound {
  private src: AudioBufferSourceNode | null = null;
  private band: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;

  /** Each frame: the speed down the slide (m/s), 0 off it. */
  update(speed: number): void {
    const ctx = sound.context();
    const dest = sound.out();
    if (!ctx || !dest || !(speed > 0)) {
      this.stop();
      return;
    }
    if (!this.src) {
      this.src = ctx.createBufferSource();
      this.src.buffer = noiseOf(ctx);
      this.src.loop = true;
      this.band = ctx.createBiquadFilter();
      this.band.type = 'bandpass';
      this.band.Q.value = 0.9;
      this.gain = ctx.createGain();
      this.gain.gain.value = 0.0001;
      this.src.connect(this.band).connect(this.gain).connect(dest);
      this.src.start();
      whee(ctx, dest);
    }
    const t = ctx.currentTime;
    const s = Math.min(1, speed / 4);
    this.band!.frequency.setTargetAtTime(500 + 1600 * s, t, 0.05);
    this.gain!.gain.setTargetAtTime(0.02 + 0.2 * s, t, 0.05);
  }

  private stop(): void {
    if (!this.src) return;
    const ctx = sound.context();
    const src = this.src;
    try {
      if (ctx && this.gain) {
        this.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.06);
        src.stop(ctx.currentTime + 0.4);
      } else src.stop();
    } catch {
      // the sound was switched off meanwhile: nothing left to stop
    }
    this.src = this.band = this.gain = null;
  }
}
