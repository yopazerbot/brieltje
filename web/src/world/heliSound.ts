import { sound } from '../sound';

/**
 * The helicopter's sound, made in code (nothing to download), from where the machine is (world/heli.ts). It sits under
 * the game, never over it (Yoshi: "Ook simpel maar goed subtiel geluid tijdens vliegen heli"; its loudest stays well
 * under a rifle's shot: tools/dev/heliWash.mjs --sound measures both), but a machine is heard from far off, as in the
 * big games (Battlefield's: close and distant layers crossfaded with the distance, the turbine's whine filtered away
 * first, the blades carrying). Five layers, each following the rotor's speed, so the run-up and the run-down are the
 * same sound rising and falling:
 *
 * - the thump: low noise opened softly once per blade pass (four blades at 395 rpm: 26 a second at full speed), a
 *   rounded swell, more body with the lever up and in a descent; it carries furthest (heard to 400 m);
 * - the slap: a short bright crack of each blade through the air the one before it stirred, sharper as the lever comes
 *   up and in a descent, and louder as the machine comes towards you than as it goes (the noise of the blades meeting
 *   their own wake throws forward and down);
 * - the turbines' whine: two tones near 2 kHz and a hiss round them, heard close by only;
 * - the bed: the turbines and the air through the rotor, a steady rush under 1.2 kHz;
 * - the air over the cabin, a little more of it the faster it flies.
 *
 * Each layer falls off with the distance at its own rate, and the air takes the highs first (a lowpass closing with the
 * distance). The whole of it reaches you late, as sound does (343 m/s, a delay line): as the distance shrinks the delay
 * shortens and the pitch rises, as it grows the pitch falls, so a pass-by has its Doppler without anything worked out
 * for it. All through one more lowpass, more closed from the pilot's seat (a touch muffled inside). Every level and pitch
 * eases to its new value, so nothing steps or clicks. Through the world's sounds (sound.at, out of doors): silent before
 * play begins, muffled through the walls when you are indoors (world/acoustics.ts), the game's volume and mute; the
 * panner only places it (left, right, behind), the distance is this file's. It stops once the rotor has run down. Bumps
 * keep their one-shots (a thump, a dull clang).
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

/** m: the distance at which LEVELS are heard as they are */
export const REF = 8;

/**
 * The numbers to make it louder or softer (at the reference distance, before the game's volume): the thump at a hover,
 * the slap's crack, the turbines' whine, the bed at full rotor speed, and the air at top speed. Together they peak near
 * 0.13 at REF in a hard climb (0.09 the version before, which was too quiet from a distance); measured against a
 * rifle's shot in tools/dev/heliWash.mjs --sound.
 */
export const LEVELS = { thump: 0.34, slap: 0.06, whine: 0.0035, bed: 0.04, air: 0.06 };
/** How fast each layer falls off with the distance (the panner's "inverse" rolloff, per layer): the thump carries furthest. */
export const FALL = { thump: 0.2, slap: 0.6, whine: 1.6, bed: 1.0, air: 1.2 };
/** m/s: the speed of sound (the delay line: the Doppler) */
const SOUND_SPEED = 343;
/** s: the longest delay (some 500 m) */
const MAX_DELAY = 1.5;

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

/** Where it is heard from (the camera). */
export interface Ear {
  x: number;
  y: number;
  z: number;
}

interface Loop {
  out: AudioNode;
  pos: PannerNode | null;
  sources: AudioScheduledSourceNode[];
  lfo: OscillatorNode;
  pulseDepth: GainNode;
  pulseTone: BiquadFilterNode;
  slapDepth: GainNode;
  slapTone: BiquadFilterNode;
  whine: GainNode;
  whineTones: OscillatorNode[];
  whineBand: BiquadFilterNode;
  bed: GainNode;
  air: GainNode;
  airBand: BiquadFilterNode;
  absorb: BiquadFilterNode;
  muffle: BiquadFilterNode;
  delay: DelayNode;
  /** The delay last asked for (s), to tell a jump of the eye from a flight */
  late: number;
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
  // The way to you: the air takes the highs with the distance, the cockpit muffles, and it all arrives late.
  const delay = c.createDelay(MAX_DELAY);
  delay.delayTime.value = REF / SOUND_SPEED;
  delay.connect(out);
  const muffle = filter('lowpass', 20000, 0.5);
  muffle.connect(delay);
  const absorb = filter('lowpass', 3200, 0.5);
  absorb.connect(filter('lowpass', 3200, 0.5)).connect(muffle); // two in a row: steep above it
  const mix = gain(1);
  mix.connect(absorb);
  // One oscillator at the blade-pass rate drives the thump and the slap, so they keep time with each other.
  const lfo = c.createOscillator();
  lfo.frequency.value = BLADE_HZ;
  const shaper = (power: number) => {
    const s = c.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < curve.length; i++) curve[i] = (i / (curve.length - 1)) ** power; // the sine's -1..1 as 0..1, raised
    s.curve = curve;
    return s;
  };
  // The thump: low noise through a gain the sine swells and eases, squared (a rounded swell, no edge to click on).
  const pulse = gain(0);
  const pulseDepth = gain(0);
  lfo.connect(shaper(2)).connect(pulseDepth).connect(pulse.gain);
  const pulseTone = filter('lowpass', 220, 0.8);
  src.connect(pulseTone).connect(pulse).connect(mix);
  // The slap: brighter noise opened only at the sine's top (raised to the 12th: a few milliseconds a blade).
  const slap = gain(0);
  const slapDepth = gain(0);
  lfo.connect(shaper(12)).connect(slapDepth).connect(slap.gain);
  const slapTone = filter('bandpass', 1000, 1.1);
  src.connect(slapTone).connect(slap).connect(mix);
  // The whine: two tones of the turbines and a narrow hiss round them, under 3 kHz.
  const whine = gain(0);
  const whineTones = [1950, 2440].map((f, i) => {
    const o = c.createOscillator();
    o.frequency.value = f;
    o.connect(gain(i ? 0.5 : 1)).connect(whine);
    return o;
  });
  const whineBand = filter('bandpass', 2200, 4);
  src.connect(whineBand).connect(gain(1.5)).connect(whine);
  whine.connect(mix);
  // The bed: the turbines and the rotor's air, a steady rush under 1.2 kHz.
  const bed = gain(0);
  src.connect(filter('lowpass', 1200, 0.5)).connect(filter('highpass', 90, 0.5)).connect(bed).connect(mix);
  // The air over the cabin with the speed.
  const airBand = filter('bandpass', 600, 0.6);
  const air = gain(0);
  src.connect(airBand).connect(air).connect(mix);
  const sources = [src, lfo, ...whineTones];
  for (const s of sources) s.start();
  return { out, pos: null, sources, lfo, pulseDepth, pulseTone, slapDepth, slapTone, whine, whineTones, whineBand, bed, air, airBand, absorb, muffle, delay, late: REF / SOUND_SPEED };
}

/** How much of a layer is left at `d` m, falling off at `roll` (1 the panner's inverse law, from REF). */
export function falloff(d: number, roll: number): number {
  return REF / (REF + roll * Math.max(0, d - REF));
}

/**
 * The loop's levels for what the machine does, heard from `d` m off and coming nearer at `closing` m/s (negative: going
 * away), from time `t`; every one eases in (no steps, no clicks).
 */
function setLoop(a: Loop, n: HeliNoise, t: number, d: number, closing: number): void {
  const r = Math.max(0, Math.min(1, n.rotor));
  const lever = Math.max(0, Math.min(1, n.coll));
  const sink = Math.min(1, Math.max(0, n.sink) / 6);
  a.lfo.frequency.setTargetAtTime(Math.max(0.5, BLADE_HZ * r), t, 0.15);
  // The thump: from nothing at rest to its level at speed; a little more body with the lever up and in a descent.
  const body = 0.75 + 0.45 * lever + 0.15 * sink;
  a.pulseDepth.gain.setTargetAtTime(LEVELS.thump * r * r * body * falloff(d, FALL.thump), t, 0.25);
  a.pulseTone.frequency.setTargetAtTime(160 + 120 * lever, t, 0.3);
  // The slap: hardly any at idle, sharp with the lever up and in a descent; louder coming, softer going.
  const toward = Math.max(-1, Math.min(1, closing / 25));
  const approach = toward > 0 ? 1 + 0.8 * toward : 1 + 0.4 * toward;
  const crack = (0.35 + 0.8 * lever + 0.6 * sink) * approach;
  a.slapDepth.gain.setTargetAtTime(LEVELS.slap * r * r * r * crack * falloff(d, FALL.slap), t, 0.25);
  a.slapTone.frequency.setTargetAtTime(850 + 350 * lever, t, 0.3);
  // The whine: with the turbines' speed, close by only.
  const near = 1 - Math.min(1, Math.max(0, (d - 25) / 55));
  a.whine.gain.setTargetAtTime(LEVELS.whine * r * falloff(d, FALL.whine) * near, t, 0.3);
  const spin = 0.55 + 0.45 * r;
  a.whineTones[0].frequency.setTargetAtTime(1950 * spin, t, 0.4);
  a.whineTones[1].frequency.setTargetAtTime(2440 * spin, t, 0.4);
  a.whineBand.frequency.setTargetAtTime(2200 * spin, t, 0.4);
  a.bed.gain.setTargetAtTime(LEVELS.bed * r * r * (0.85 + 0.3 * lever) * falloff(d, FALL.bed), t, 0.3);
  const v = Math.max(0, n.air);
  a.airBand.frequency.setTargetAtTime(450 + v * 10, t, 0.4);
  a.air.gain.setTargetAtTime(LEVELS.air * Math.min(1, (v / 47) ** 2) * falloff(d, FALL.air), t, 0.4);
  // The air takes the highs: open close by, about 1.9 kHz at 80 m, 1 kHz at 250 m.
  a.absorb.frequency.setTargetAtTime(Math.max(350, 3600 / (1 + d / 90)), t, 0.2);
  a.muffle.frequency.setTargetAtTime(n.inside ? 700 : 20000, t, 0.2);
  // Late by the way sound takes: shrinking as it comes (higher), growing as it goes (lower). A jump of the eye (a
  // portal, a respawn) is set at once rather than heard as a swoop.
  const late = Math.min(MAX_DELAY, d / SOUND_SPEED);
  if (Math.abs(late - a.late) > 0.12) {
    a.delay.delayTime.cancelScheduledValues(t);
    a.delay.delayTime.setValueAtTime(late, t);
  } else a.delay.delayTime.setTargetAtTime(late, t, 0.05);
  a.late = late;
}

function stopLoop(a: Loop): void {
  for (const s of a.sources) s.stop();
  a.out.disconnect();
}

export class HeliSound {
  private loop: Loop | null = null;
  /** The distance last frame and how fast it shrinks (m/s), eased */
  private was = -1;
  private closing = 0;
  private stamp = 0;
  /**
   * A tab in the background draws no frames, so nothing would turn the loop down: it fades out over about a second
   * and stops, as the music does; in view again the next frame starts it as things are then.
   */
  private hide = (): void => {
    const a = this.loop;
    const c = sound.context();
    if (!document.hidden || !a || !c) return;
    this.loop = null;
    setLoop(a, { x: 0, y: 0, z: 0, rotor: 0, coll: 0, sink: 0, air: 0, inside: false }, c.currentTime, REF, 0);
    setTimeout(() => stopLoop(a), 2000);
  };
  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.hide);
  }
  /** Dev build: whether its loop runs now (nothing may be left playing after getting out). */
  get playing(): boolean {
    return !!this.loop;
  }

  /** Every frame the machine is in the game, heard from `ear` (the camera). */
  update(n: HeliNoise, ear: Ear): void {
    if ((!this.loop && n.rotor < 0.02) || document.hidden) return;
    if (this.loop && n.rotor < 0.005) {
      stopLoop(this.loop); // run down: its levels are at nothing already, so the stop doesn't click
      this.loop = null;
      return;
    }
    const c = sound.context();
    if (!c) return;
    if (!this.loop) {
      const at = sound.at(n.x, n.y + 2, n.z, REF) as PannerNode | null;
      if (!at) return;
      // The panner only places it; the distance is this file's (FALL, the delay).
      at.distanceModel = 'linear';
      at.rolloffFactor = 0;
      at.maxDistance = 10000;
      this.loop = buildLoop(c, at);
      this.loop.pos = at;
      this.was = -1;
    }
    const t = c.currentTime;
    const p = this.loop.pos!;
    p.positionX.setTargetAtTime(n.x, t, 0.03);
    p.positionY.setTargetAtTime(n.y + 2, t, 0.03);
    p.positionZ.setTargetAtTime(n.z, t, 0.03);
    const d = Math.hypot(n.x - ear.x, n.y + 2 - ear.y, n.z - ear.z);
    const dt = t - this.stamp;
    this.stamp = t;
    if (this.was >= 0 && dt > 0 && dt < 0.5 && Math.abs(d - this.was) < 40) this.closing += ((this.was - d) / dt - this.closing) * Math.min(1, dt * 4);
    else this.closing = 0;
    this.was = d;
    setLoop(this.loop, n, t, d, this.closing);
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
   * first start-up in play builds nothing new (the panner's HRTF, the noise, the shapers' curves).
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
 * does (default: a run-up, a hover, a climb, top speed, a descent and a run-down), heard from `ear` (default REF m off,
 * where LEVELS are as they are). With `above`, only what lies above that many hertz (four highpasses in a row after it:
 * 48 dB an octave), to measure what is left up there.
 */
export async function render(seconds = 30, rate = 48000, script?: (t: number) => HeliNoise, above = 0, ear: Ear = { x: 0, y: 2, z: REF }): Promise<{ buffer: AudioBuffer; rotor: Float32Array }> {
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
  let was = -1;
  for (let i = 0; i < rotor.length; i++) {
    const n = plan(i * step);
    rotor[i] = n.rotor;
    const d = Math.hypot(n.x - ear.x, n.y + 2 - ear.y, n.z - ear.z);
    const closing = was < 0 ? 0 : (was - d) / step;
    was = d;
    setLoop(loop, n, i * step, d, closing);
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

/**
 * A pass-by for the checks: at full speed `speed` m/s along x, `miss` m beside the ear and `height` m up, its middle at
 * `seconds` / 2 (heard from the ear at the origin).
 */
export function passBy(seconds: number, speed = 40, miss = 30, height = 40): (t: number) => HeliNoise {
  return (t) => ({ x: (t - seconds / 2) * speed, y: height, z: miss, rotor: 1, coll: 0.55, sink: 0, air: speed, inside: false });
}

if (import.meta.env.DEV) Object.assign(window, { brielHeliSound: { render, passBy, falloff, BLADE_HZ, LEVELS, FALL, REF } });
