import { sound } from '../sound';

/**
 * The helicopter's sound, all made in code (nothing to download), from where the machine is (world/heli.ts):
 *
 * - the blade slap: short bursts of low noise at the blade-pass rate, four blades at 395 rpm (26 a second at full
 *   speed, slower as the rotor runs up or down), louder with the lever and in a descent, and a little louder from the
 *   side the blades come towards you (the machine's right);
 * - the rotor's low rumble under it;
 * - the two turbines: thin notes near 3.2 and 5.1 kHz times the rotor's speed, quiet, and a rising whoosh at the start;
 * - the shrouded tail rotor: three detuned notes round 590 Hz, a soft chord rather than a siren;
 * - the wind over the cabin with the speed through the air;
 * - one-shots: a thump on a touchdown or a bump against something, a clang for a bump, a rattle for a rotor strike.
 *
 * Through the world's sounds (sound.at): silent before play begins and muffled while you are indoors, as every other
 * sound from out of doors. The loop starts when the rotor first turns and stops when it has run down, so nothing is
 * left playing after you get out. The same graph plays into an OfflineAudioContext for checks without ears (the dev
 * build's brielHeliSound.render, tools/dev/heli.mjs).
 */

let noise: AudioBuffer | null = null;
/** Two seconds of white noise, made once per sample rate (seeded, so an offline render is the same each time). */
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
  /** -1 to 1: from the advancing side (the machine's right, 1) or the retreating side (-1), as the listener sees it */
  side: number;
  /** 0 to 1: just started (the whoosh) */
  start: number;
}

interface Loop {
  at: AudioNode;
  pos: PannerNode | null;
  sources: AudioScheduledSourceNode[];
  pulse: OscillatorNode;
  slap: GainNode;
  slapDepth: GainNode;
  rumble: GainNode;
  turbine: OscillatorNode;
  turbine2: OscillatorNode;
  turbineGain: GainNode;
  tails: OscillatorNode[];
  tailGain: GainNode;
  windBand: BiquadFilterNode;
  wind: GainNode;
  whoosh: GainNode;
  whooshBand: BiquadFilterNode;
}

/** The loudest the loop gets at its reference distance (the blade slap at a full lever in a descent): kept under the car's thump. */
export const LOOP_MAX = 0.35;

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
  // The slap: low noise through a gain opened once per blade pass by a sharp pulse (a sawtooth shaped to a spike).
  const slap = gain(0);
  const slapDepth = gain(0);
  const pulse = osc('sawtooth', BLADE_HZ);
  const shape = c.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < curve.length; i++) curve[i] = (i / (curve.length - 1)) ** 4; // -1..1 in: a burst over the top sixth of each ramp
  shape.curve = curve;
  pulse.connect(shape).connect(slapDepth).connect(slap.gain);
  src.connect(filter('lowpass', 420, 0.9)).connect(filter('peaking', 110, 1.2)).connect(slap).connect(out);
  // The rumble under it.
  const rumble = gain(0);
  src.connect(filter('lowpass', 140, 0.7)).connect(rumble).connect(out);
  // The turbines.
  const turbineGain = gain(0);
  const turbine = osc('sine', 3200);
  const turbine2 = osc('sine', 5100);
  const tb = filter('bandpass', 4000, 0.7);
  turbine.connect(tb);
  turbine2.connect(gain(0.6)).connect(tb);
  tb.connect(turbineGain).connect(out);
  // The tail rotor: three notes a little apart.
  const tailGain = gain(0);
  const tails = [0.988, 1, 1.013].map((k) => {
    const o = osc('triangle', 590 * k);
    o.connect(tailGain);
    return o;
  });
  tailGain.connect(filter('lowpass', 1400, 0.6)).connect(out);
  // The wind and the start's whoosh.
  const windBand = filter('bandpass', 700, 0.6);
  const wind = gain(0);
  src.connect(windBand).connect(wind).connect(out);
  const whooshBand = filter('bandpass', 900, 1.4);
  const whoosh = gain(0);
  src.connect(whooshBand).connect(whoosh).connect(out);
  const sources = [src, pulse, turbine, turbine2, ...tails];
  for (const s of sources) s.start();
  return { at: out, pos: null, sources, pulse, slap, slapDepth, rumble, turbine, turbine2, turbineGain, tails, tailGain, windBand, wind, whoosh, whooshBand };
}

/** The loop's levels for what the machine does, from time `t` (each eases in over a short moment). */
function setLoop(a: Loop, n: HeliNoise, t: number): void {
  const r = Math.max(0, Math.min(1.05, n.rotor));
  const on = r > 0.02 ? 1 : 0;
  a.pulse.frequency.setTargetAtTime(Math.max(0.5, BLADE_HZ * r), t, 0.05);
  // Louder with the lever and in a descent (the blades cut through their own wake), and from the advancing side.
  const load = 0.35 + 0.45 * Math.min(1, n.coll) + 0.2 * Math.min(1, Math.max(0, n.sink) / 6);
  const side = 1 + 0.18 * Math.max(-1, Math.min(1, n.side));
  const slap = 0.55 * r * r * load * side;
  a.slapDepth.gain.setTargetAtTime(slap * on, t, 0.08);
  a.rumble.gain.setTargetAtTime(0.025 * r * r * on, t, 0.1);
  a.turbine.frequency.setTargetAtTime(3200 * Math.max(0.2, r), t, 0.1);
  a.turbine2.frequency.setTargetAtTime(5100 * Math.max(0.2, r), t, 0.1);
  a.turbineGain.gain.setTargetAtTime(0.004 * Math.min(1, r * 1.5) * on, t, 0.2);
  a.tails.forEach((o, i) => o.frequency.setTargetAtTime(590 * [0.988, 1, 1.013][i] * Math.max(0.1, r), t, 0.08));
  a.tailGain.gain.setTargetAtTime(0.005 * r * on, t, 0.15);
  const v = Math.max(0, n.air);
  a.windBand.frequency.setTargetAtTime(500 + v * 16, t, 0.2);
  a.wind.gain.setTargetAtTime(0.06 * Math.min(1, (v / 50) ** 2), t, 0.2);
  a.whooshBand.frequency.setTargetAtTime(500 + 2500 * r, t, 0.2);
  a.whoosh.gain.setTargetAtTime(0.03 * Math.max(0, Math.min(1, n.start)), t, 0.2);
}

function stopLoop(a: Loop): void {
  for (const s of a.sources) s.stop();
  a.at.disconnect();
}

export class HeliSound {
  private loop: Loop | null = null;
  /** Dev build: whether its loop runs now (nothing may be left playing after getting out). */
  get playing(): boolean {
    return !!this.loop;
  }

  /** Every frame the machine is in the game. */
  update(n: HeliNoise): void {
    if (!this.loop && n.rotor < 0.02) return;
    if (this.loop && n.rotor < 0.005) {
      stopLoop(this.loop); // run down: quiet, and nothing left playing
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

  /** A bump's clang. */
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

  dispose(): void {
    if (this.loop) stopLoop(this.loop);
    this.loop = null;
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
    g.gain.exponentialRampToValueAtTime(0.04 + 0.3 * loud, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.34);
    return;
  }
  if (kind === 'clang') {
    // Struck metal: a few notes that don't fit a scale, ringing out.
    for (const [f, v, d] of [[523, 0.07, 0.9], [1347, 0.05, 0.6], [2290, 0.03, 0.4], [3110, 0.02, 0.3]]) {
      const o = c.createOscillator();
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + d + 0.02);
    }
  }
  // The rattle (and the clang's knock): short bursts of bright noise.
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = kind === 'rattle' ? 2400 : 900;
  band.Q.value = 1.2;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  const n = kind === 'rattle' ? 6 : 1;
  for (let i = 0; i < n; i++) {
    g.gain.setValueAtTime(kind === 'rattle' ? 0.08 : 0.12, t + i * 0.045);
    g.gain.setTargetAtTime(0, t + i * 0.045 + 0.005, 0.012);
  }
  src.connect(band).connect(g).connect(out);
  src.start(t);
  src.stop(t + n * 0.045 + 0.2);
}

/**
 * Dev build, for checks without ears: the loop rendered offline for `seconds` while `script(t)` says what the machine
 * does (default: a start-up, a hover, a climb, a dash, a descent and a shut-down), with a touchdown thump and a clang.
 */
export async function render(seconds = 30, rate = 48000, script?: (t: number) => HeliNoise): Promise<{ buffer: AudioBuffer; rotor: Float32Array }> {
  const c = new OfflineAudioContext(1, Math.ceil(seconds * rate), rate);
  const out = c.createGain();
  out.connect(c.destination);
  const loop = buildLoop(c, out);
  const plan = script ?? defaultScript;
  const step = 0.05;
  const rotor = new Float32Array(Math.ceil(seconds / step));
  for (let i = 0; i < rotor.length; i++) {
    const n = plan(i * step);
    rotor[i] = n.rotor;
    setLoop(loop, n, i * step);
  }
  oneShot(c, out, 'thump', 2, seconds * 0.5);
  oneShot(c, out, 'clang', 1, seconds * 0.55);
  oneShot(c, out, 'rattle', 1, seconds * 0.6);
  for (const s of loop.sources) s.stop(seconds);
  return { buffer: await c.startRendering(), rotor };
}

/** The default script: up from still over 6 s, a hover, a climb, a dash, a descent, a shut-down over 8 s. */
function defaultScript(t: number): HeliNoise {
  const rotor = t < 6 ? t / 6 : t < 22 ? 1 : Math.max(0, 1 - (t - 22) / 8);
  const coll = t < 6 ? 0 : t < 10 ? 0.55 : t < 13 ? 0.9 : t < 17 ? 0.6 : t < 21 ? 0.3 : 0;
  return { x: 0, y: 0, z: 0, rotor, coll, sink: t > 17 && t < 21 ? 6 : 0, air: t > 13 && t < 17 ? 45 : 0, side: Math.sin(t), start: t < 6 ? 1 - t / 6 : 0 };
}

if (import.meta.env.DEV) Object.assign(window, { brielHeliSound: { render, BLADE_HZ, LOOP_MAX } });
