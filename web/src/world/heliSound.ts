import { sound } from '../sound';

/**
 * The helicopter's sound, made in code (nothing to download), from where the machine is (world/heli.ts). Simple and
 * subtle (Yoshi: "Ook simpel maar goed subtiel geluid tijdens vliegen heli"): it sits under the game, never over it.
 * Three layers, each following the rotor's speed, so the run-up and the run-down are the same sound rising and falling:
 *
 * - the rotor's pulse: low noise opened softly once per blade pass (four blades at 395 rpm: 26 a second at full speed),
 *   a rounded swell rather than a slap, with a little more body as the lever comes up (climbing, pulling up);
 * - the bed: the turbines and the air through the rotor, a quiet steady rush, low-passed under 1.2 kHz;
 * - the air over the cabin, a little more of it the faster it flies.
 *
 * All through one lowpass: open from behind, more closed from the pilot's seat (a touch muffled inside). Every level
 * and pitch eases to its new value, so nothing steps or clicks when you press or let go, start, stop or get out.
 * Through the world's sounds (sound.at): silent before play begins, muffled indoors, the game's volume and mute. It
 * stops once the rotor has run down. Another player's machine (later) is the same class at its own place: the panner's
 * distance makes it quieter with range, nothing else needed. Bumps keep their one-shots (a thump, a dull clang).
 */

let noise: AudioBuffer | null = null;
/** Two seconds of white noise, made once per sample rate (seeded: an offline render is the same each time). */
function noiseBuffer(c: BaseAudioContext): AudioBuffer {
  if (noise?.sampleRate === c.sampleRate) return noise;
  noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = noise.getChannelData(0);
  let seed = 12345;
  for (let i = 0; i < d.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    d[i] = (seed / 4294967296) * 2 - 1;
  }
  return noise;
}

/** The blade-pass rate at full rotor speed: four blades at 395 rpm (Hz). */
export const BLADE_HZ = (4 * 395) / 60;

/**
 * The three numbers to make it louder or softer (at the reference distance, before the game's volume): the pulse at a
 * hover, the bed at full rotor speed, and the air at top speed. Together they peak near 0.09, half the first version's,
 * with an RMS under the music's at its default.
 */
export const LEVELS = { pulse: 0.18, bed: 0.06, air: 0.07 };

/** What the machine is doing this frame, for its sound. */
export interface HeliNoise {
  x: number;
  y: number;
  z: number;
  /** 0 to 1 of full speed */
  rotor: number;
  /** the lever, 0 to 1 */
  coll: number;
  /** m/s down (> 0 sinking) */
  sink: number;
  /** m/s through the air */
  air: number;
  /** heard from the pilot's seat (a touch muffled) rather than from behind */
  inside: boolean;
}

interface Loop {
  out: AudioNode;
  pos: PannerNode | null;
  sources: AudioScheduledSourceNode[];
  lfo: OscillatorNode;
  pulse: GainNode;
  pulseDepth: GainNode;
  pulseTone: BiquadFilterNode;
  bed: GainNode;
  air: GainNode;
  airBand: BiquadFilterNode;
  muffle: BiquadFilterNode;
}

/** The loop's nodes into `out` on any audio context (live: a spot in the world; offline: the destination). */
function buildLoop(c: BaseAudioContext, out: AudioNode): Loop {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  src.loop = true;
  const gain = (v = 0) => {
    const g = c.createGain();
    g.gain.value = v;
    return g;
  };
  const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
    const b = c.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };
  // Everything through one lowpass: open from behind, closed a little from the cockpit; nothing above 3 kHz anyway.
  const muffle = filter('lowpass', 1600, 0.5);
  muffle.connect(filter('lowpass', 1600, 0.5)).connect(out); // two in a row: steep above it
  // The pulse: low noise through a gain that a sine at the blade-pass rate swells and eases, squared (a rounded swell,
  // no edge to click on). Its gain is 0 + depth x (0..1).
  const pulse = gain(0);
  const pulseDepth = gain(0);
  const lfo = c.createOscillator();
  lfo.frequency.value = BLADE_HZ;
  const shape = c.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < curve.length; i++) curve[i] = (i / (curve.length - 1)) ** 2; // the sine's -1..1 as 0..1, squared
  shape.curve = curve;
  lfo.connect(shape).connect(pulseDepth).connect(pulse.gain);
  const pulseTone = filter('lowpass', 220, 0.8);
  src.connect(pulseTone).connect(pulse).connect(muffle);
  // The bed: the turbines and the rotor's air, a steady rush under 1.2 kHz.
  const bed = gain(0);
  src.connect(filter('lowpass', 1200, 0.5)).connect(filter('highpass', 90, 0.5)).connect(bed).connect(muffle);
  // The air over the cabin with the speed.
  const airBand = filter('bandpass', 600, 0.6);
  const air = gain(0);
  src.connect(airBand).connect(air).connect(muffle);
  const sources = [src, lfo];
  for (const s of sources) s.start();
  return { out, pos: null, sources, lfo, pulse, pulseDepth, pulseTone, bed, air, airBand, muffle };
}

/** The loop's levels for what the machine does, from time `t`; every one eases in (no steps, no clicks). */
function setLoop(a: Loop, n: HeliNoise, t: number): void {
  const r = Math.max(0, Math.min(1, n.rotor));
  const lever = Math.max(0, Math.min(1, n.coll));
  a.lfo.frequency.setTargetAtTime(Math.max(0.5, BLADE_HZ * r), t, 0.15);
  // The pulse: from nothing at rest to its level at speed; a little more body with the lever up and in a descent.
  const body = 0.75 + 0.45 * lever + 0.15 * Math.min(1, Math.max(0, n.sink) / 6);
  a.pulseDepth.gain.setTargetAtTime(LEVELS.pulse * r * r * body, t, 0.25);
  a.pulseTone.frequency.setTargetAtTime(160 + 120 * lever, t, 0.3);
  a.bed.gain.setTargetAtTime(LEVELS.bed * r * r * (0.85 + 0.3 * lever), t, 0.3);
  const v = Math.max(0, n.air);
  a.airBand.frequency.setTargetAtTime(450 + v * 10, t, 0.4);
  a.air.gain.setTargetAtTime(LEVELS.air * Math.min(1, (v / 47) ** 2), t, 0.4);
  a.muffle.frequency.setTargetAtTime(n.inside ? 700 : 1600, t, 0.2);
}

function stopLoop(a: Loop): void {
  for (const s of a.sources) s.stop();
  a.out.disconnect();
}

export class HeliSound {
  private loop: Loop | null = null;
  /**
   * A tab in the background draws no frames, so nothing would turn the loop down: it fades out over about a second
   * and stops, as the music does; in view again the next frame starts it as things are then.
   */
  private hide = (): void => {
    const a = this.loop;
    const c = sound.context();
    if (!document.hidden || !a || !c) return;
    this.loop = null;
    setLoop(a, { x: 0, y: 0, z: 0, rotor: 0, coll: 0, sink: 0, air: 0, inside: false }, c.currentTime);
    setTimeout(() => stopLoop(a), 2000);
  };
  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.hide);
  }
  /** Dev build: whether its loop runs now (nothing may be left playing after getting out). */
  get playing(): boolean {
    return !!this.loop;
  }

  /** Every frame the machine is in the game. */
  update(n: HeliNoise): void {
    if ((!this.loop && n.rotor < 0.02) || document.hidden) return;
    if (this.loop && n.rotor < 0.005) {
      stopLoop(this.loop); // run down: its levels are at nothing already, so the stop doesn't click
      this.loop = null;
      return;
    }
    const c = sound.context();
    if (!c) return;
    if (!this.loop) {
      const at = sound.at(n.x, n.y + 2, n.z, 8) as PannerNode | null;
      if (!at) return;
      this.loop = buildLoop(c, at);
      this.loop.pos = at;
    }
    const t = c.currentTime;
    const p = this.loop.pos!;
    p.positionX.setTargetAtTime(n.x, t, 0.03);
    p.positionY.setTargetAtTime(n.y + 2, t, 0.03);
    p.positionZ.setTargetAtTime(n.z, t, 0.03);
    setLoop(this.loop, n, t);
  }

  /** A thump from (x, y, z), `strength` about the speed of the knock in m/s (1 a soft touchdown, 10 a bump). */
  thump(x: number, y: number, z: number, strength: number): void {
    const c = sound.context();
    const at = sound.at(x, y + 0.5, z, 3);
    if (c && at && strength > 0) oneShot(c, at, 'thump', strength, c.currentTime);
  }

  /** A bump's clang (dull, under 3 kHz). */
  clang(x: number, y: number, z: number): void {
    const c = sound.context();
    const at = sound.at(x, y + 1, z, 4);
    if (c && at) oneShot(c, at, 'clang', 1, c.currentTime);
  }

  /** A rotor strike's rattle. */
  rattle(x: number, y: number, z: number): void {
    const c = sound.context();
    const at = sound.at(x, y, z, 4);
    if (c && at) oneShot(c, at, 'rattle', 1, c.currentTime);
  }

  /**
   * Before play (the warm-up behind the start screen, silent there): the loop's nodes made once and let go, so the
   * first start-up in play builds nothing new (the panner's HRTF, the noise, the shaper's curve).
   */
  warm(): void {
    const c = sound.context();
    if (!c || this.loop) return;
    noiseBuffer(c);
    const at = sound.at(0, -500, 0, 8);
    if (at) stopLoop(buildLoop(c, at));
  }

  dispose(): void {
    if (this.loop) stopLoop(this.loop);
    this.loop = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.hide);
  }
}

/** A one-shot into `out` at time `t`. */
function oneShot(c: BaseAudioContext, out: AudioNode, kind: 'thump' | 'clang' | 'rattle', strength: number, t: number): void {
  const loud = Math.min(1, strength / 8);
  if (kind === 'thump') {
    const o = c.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.03 + 0.2 * loud, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.34);
    return;
  }
  if (kind === 'clang') {
    // Struck metal, dull: a few notes that don't fit a scale, ringing out, all under 3 kHz.
    for (const [f, v, d] of [[523, 0.05, 0.8], [1347, 0.03, 0.5], [2290, 0.015, 0.3]]) {
      const o = c.createOscillator();
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + d + 0.02);
    }
  }
  // The rattle (and the clang's knock): short bursts of noise, each rising and falling (no clicks).
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = kind === 'rattle' ? 1800 : 800;
  band.Q.value = 1.2;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  const n = kind === 'rattle' ? 6 : 1;
  for (let i = 0; i < n; i++) {
    const at = t + i * 0.045;
    g.gain.setTargetAtTime(kind === 'rattle' ? 0.05 : 0.07, at, 0.003);
    g.gain.setTargetAtTime(0, at + 0.012, 0.01);
  }
  src.connect(band).connect(g).connect(out);
  src.start(t);
  src.stop(t + n * 0.045 + 0.2);
}

/**
 * Dev build, for checks without ears: the loop rendered offline for `seconds` while `script(t)` says what the machine
 * does (default: a run-up, a hover, a climb, top speed, a descent and a run-down). With `above`, only what lies above
 * that many hertz (four highpasses in a row after it: 48 dB an octave), to measure what is left up there.
 */
export async function render(seconds = 30, rate = 48000, script?: (t: number) => HeliNoise, above = 0): Promise<{ buffer: AudioBuffer; rotor: Float32Array }> {
  const c = new OfflineAudioContext(1, Math.ceil(seconds * rate), rate);
  let out: AudioNode = c.destination;
  if (above > 0) {
    for (let i = 0; i < 4; i++) {
      const h = c.createBiquadFilter();
      h.type = 'highpass';
      h.frequency.value = above;
      h.Q.value = 0.7;
      h.connect(out);
      out = h;
    }
  }
  const loop = buildLoop(c, out);
  const plan = script ?? defaultScript;
  const step = 0.05;
  const rotor = new Float32Array(Math.ceil(seconds / step));
  for (let i = 0; i < rotor.length; i++) {
    const n = plan(i * step);
    rotor[i] = n.rotor;
    setLoop(loop, n, i * step);
  }
  for (const s of loop.sources) s.stop(seconds);
  return { buffer: await c.startRendering(), rotor };
}

/** The default script: up from still over 6 s, a hover, a climb, top speed, a descent, a run-down over 8 s. */
function defaultScript(t: number): HeliNoise {
  const rotor = t < 6 ? t / 6 : t < 22 ? 1 : Math.max(0, 1 - (t - 22) / 8);
  const coll = t < 6 ? 0 : t < 10 ? 0.55 : t < 13 ? 0.9 : t < 17 ? 0.7 : t < 21 ? 0.3 : 0;
  return { x: 0, y: 0, z: 0, rotor, coll, sink: t > 17 && t < 21 ? 6 : 0, air: t > 13 && t < 17 ? 47 : 0, inside: false };
}

if (import.meta.env.DEV) Object.assign(window, { brielHeliSound: { render, BLADE_HZ, LEVELS } });
