import { sound } from '../sound';

/**
 * The Brook Spirit's sounds, made in code (no files), heard from where they happen (sound.at: out of doors, or
 * muffled through the walls when you are inside, world/acoustics.ts). Every one is told apart by ear, never a scream:
 * - Its presence within about 35 m: a slow breath of filtered noise and a soft hum on two notes (196 and 294 Hz),
 *   louder and a little sharper awake; built when you come within 60 m, torn down when you leave.
 * - The tells: the sweep a rising whoosh; each bolt three climbing chimes; a pool low bubbling; a rise a shimmer.
 * - The heart opening one clear held bell note; a counted hit a glassy tick; the window's share reached two falling
 *   notes as it folds. The shell closing: rushing water and leaves. A light lit: a small chime from it; lit lights
 *   ping softly every 3 s (findable by ear); shot out: a bright crack falling away. The shell bursting: a noise crack
 *   with falling bell partials. Mending: a trickle and a slow rising note. A bolt landing: a soft thud.
 * - Beaten: a long major chord of bell partials over 4 s with sparkles.
 * At most 12 live nodes in all (a cue that would go over waits out, except the end); nothing is built far away.
 * `render(kind)` plays any of them into an OfflineAudioContext, for checks without ears (tools/dev/spirit_shots.mjs).
 */

export type SpiritCue = 'sweep' | 'bolt' | 'pool' | 'rise' | 'open' | 'hit' | 'cap' | 'shell' | 'chime' | 'ping' | 'out' | 'burst' | 'mend' | 'land' | 'end';

/** The most nodes alive at once (the presence's five, the panners, the cues). */
export const MAX_NODES = 12;
/** m: the presence is built within this, torn down past BUILD + 10 */
const BUILD = 60;

type Voice = (c: BaseAudioContext, out: AudioNode, t0: number, arg: number) => { nodes: number; secs: number };

const noiseOf = new WeakMap<BaseAudioContext, AudioBuffer>();
/** Two seconds of noise, once per context. */
function noise(c: BaseAudioContext): AudioBuffer {
  let b = noiseOf.get(c);
  if (!b) {
    b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = last * 0.6 + (Math.random() * 2 - 1) * 0.4; // a little darker than white
      d[i] = last * 1.6;
    }
    noiseOf.set(c, b);
  }
  return b;
}

function noiseSource(c: BaseAudioContext, t0: number, secs: number): AudioBufferSourceNode {
  const s = c.createBufferSource();
  s.buffer = noise(c);
  s.loop = true;
  s.start(t0, Math.random() * 1.5);
  s.stop(t0 + secs);
  return s;
}

function osc(c: BaseAudioContext, type: OscillatorType, f: number, t0: number, secs: number): OscillatorNode {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  o.start(t0);
  o.stop(t0 + secs);
  return o;
}

/** A struck envelope on `g`: up to `peak` in `a` s, down by e-folds of `tau` s. */
function strike(g: AudioParam, t0: number, peak: number, a: number, tau: number): void {
  g.setValueAtTime(0, t0);
  g.linearRampToValueAtTime(peak, t0 + a);
  g.setTargetAtTime(0, t0 + a, tau);
}

const VOICES: Record<SpiritCue, Voice> = {
  /** A rising whoosh over the tell (`arg` s), swishing as it strikes. */
  sweep(c, out, t0, tell) {
    const secs = tell + 0.4;
    const n = noiseSource(c, t0, secs);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(260, t0);
    f.frequency.exponentialRampToValueAtTime(2600, t0 + tell);
    f.frequency.exponentialRampToValueAtTime(700, t0 + secs);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.28, t0 + tell * 0.9);
    g.gain.linearRampToValueAtTime(0.6, t0 + tell + 0.03);
    g.gain.setTargetAtTime(0, t0 + tell + 0.05, 0.09);
    n.connect(f).connect(g).connect(out);
    return { nodes: 3, secs };
  },
  /** Three climbing chimes, one bolt's tell. */
  bolt(c, out, t0) {
    const o = osc(c, 'triangle', 659, t0, 1.3);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    [659, 831, 988].forEach((f, i) => {
      const t = t0 + i * 0.2;
      o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22 + i * 0.04, t + 0.006);
      g.gain.setTargetAtTime(0, t + 0.01, 0.12);
    });
    o.connect(g).connect(out);
    return { nodes: 2, secs: 1.3 };
  },
  /** Low bubbling over the pool's tell (`arg` s). */
  pool(c, out, t0, tell) {
    const secs = tell + 0.3;
    const o = osc(c, 'sine', 110, t0, secs);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    for (let t = 0; t < tell; t += 0.09 + Math.random() * 0.12) {
      const f = 80 + Math.random() * 90;
      o.frequency.setValueAtTime(f, t0 + t);
      o.frequency.exponentialRampToValueAtTime(f * 2.1, t0 + t + 0.06);
      g.gain.setValueAtTime(0, t0 + t);
      g.gain.linearRampToValueAtTime(0.2 + 0.25 * (t / tell), t0 + t + 0.01);
      g.gain.setTargetAtTime(0, t0 + t + 0.02, 0.03);
    }
    o.connect(g).connect(out);
    return { nodes: 2, secs };
  },
  /** A shimmer where it will rise (`arg` s). */
  rise(c, out, t0, secs) {
    const a = osc(c, 'triangle', 1568, t0, secs + 0.3);
    const b = osc(c, 'triangle', 1577, t0, secs + 0.3);
    a.frequency.linearRampToValueAtTime(1760, t0 + secs);
    b.frequency.linearRampToValueAtTime(1771, t0 + secs);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    for (let t = 0; t < secs; t += 0.07) g.gain.linearRampToValueAtTime((t / secs) * (0.05 + ((t * 14) % 2 < 1 ? 0.05 : 0)), t0 + t);
    g.gain.setTargetAtTime(0, t0 + secs, 0.08);
    a.connect(g);
    b.connect(g);
    g.connect(out);
    return { nodes: 3, secs: secs + 0.3 };
  },
  /** One clear bell note, held while the heart is open (`arg` s). */
  open(c, out, t0, secs) {
    const a = osc(c, 'sine', 880, t0, secs + 0.6);
    const b = osc(c, 'sine', 880 * 2.76, t0, secs + 0.6);
    const g = c.createGain();
    const h = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.3, t0 + 0.005);
    g.gain.setTargetAtTime(0.11, t0 + 0.01, 0.25);
    g.gain.setTargetAtTime(0, t0 + secs, 0.12);
    strike(h.gain, t0, 0.12, 0.004, 0.15);
    a.connect(g).connect(out);
    b.connect(h).connect(out);
    return { nodes: 4, secs: secs + 0.6 };
  },
  /** A glassy tick: a counted hit. */
  hit(c, out, t0) {
    const o = osc(c, 'sine', 2700, t0, 0.12);
    o.frequency.exponentialRampToValueAtTime(2150, t0 + 0.06);
    const g = c.createGain();
    strike(g.gain, t0, 0.22, 0.002, 0.022);
    o.connect(g).connect(out);
    return { nodes: 2, secs: 0.12 };
  },
  /** Two falling notes: the window took its share, the heart folds. */
  cap(c, out, t0) {
    const o = osc(c, 'sine', 659, t0, 0.8);
    o.frequency.setValueAtTime(494, t0 + 0.18);
    const g = c.createGain();
    strike(g.gain, t0, 0.24, 0.005, 0.08);
    g.gain.setValueAtTime(0, t0 + 0.18);
    g.gain.linearRampToValueAtTime(0.24, t0 + 0.185);
    g.gain.setTargetAtTime(0, t0 + 0.19, 0.16);
    o.connect(g).connect(out);
    return { nodes: 2, secs: 0.8 };
  },
  /** Rushing water and leaves closing round it: the shell. */
  shell(c, out, t0) {
    const n = noiseSource(c, t0, 1.6);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(5000, t0);
    f.frequency.exponentialRampToValueAtTime(600, t0 + 1.4);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.42, t0 + 0.35);
    g.gain.setTargetAtTime(0, t0 + 0.7, 0.25);
    n.connect(f).connect(g).connect(out);
    return { nodes: 3, secs: 1.6 };
  },
  /** A light lit: a small chime from it. */
  chime(c, out, t0) {
    const o = osc(c, 'sine', 2093, t0, 1);
    const g = c.createGain();
    strike(g.gain, t0, 0.2, 0.003, 0.22);
    o.connect(g).connect(out);
    return { nodes: 2, secs: 1 };
  },
  /** A lit light's soft ping, every 3 s. */
  ping(c, out, t0) {
    const o = osc(c, 'sine', 1760, t0, 0.7);
    const g = c.createGain();
    strike(g.gain, t0, 0.07, 0.004, 0.15);
    o.connect(g).connect(out);
    return { nodes: 2, secs: 0.7 };
  },
  /** A light shot out: a bright crack falling away. */
  out(c, out, t0) {
    const n = noiseSource(c, t0, 0.1);
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2200;
    const o = osc(c, 'triangle', 2400, t0, 0.6);
    o.frequency.exponentialRampToValueAtTime(600, t0 + 0.5);
    const g = c.createGain();
    strike(g.gain, t0, 0.26, 0.002, 0.12);
    n.connect(f).connect(g);
    o.connect(g);
    g.connect(out);
    return { nodes: 4, secs: 0.6 };
  },
  /** The shell bursts: a bright noise crack, falling bell partials. */
  burst(c, out, t0) {
    const n = noiseSource(c, t0, 0.25);
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1200;
    const a = osc(c, 'sine', 1319, t0, 2.2);
    const b = osc(c, 'sine', 1976, t0, 2.2);
    a.frequency.exponentialRampToValueAtTime(880, t0 + 1.8);
    b.frequency.exponentialRampToValueAtTime(1319, t0 + 1.8);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.26, t0 + 0.003);
    g.gain.setTargetAtTime(0.12, t0 + 0.01, 0.05);
    g.gain.setTargetAtTime(0, t0 + 0.3, 0.5);
    n.connect(f).connect(g);
    a.connect(g);
    b.connect(g);
    g.connect(out);
    return { nodes: 5, secs: 2.2 };
  },
  /** Mending: a trickle and a slow rising note. */
  mend(c, out, t0) {
    const n = noiseSource(c, t0, 2);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 5;
    f.frequency.setValueAtTime(900, t0);
    for (let t = 0; t < 1.8; t += 0.08) f.frequency.setValueAtTime(700 + Math.random() * 900, t0 + t);
    const o = osc(c, 'sine', 220, t0, 2);
    o.frequency.exponentialRampToValueAtTime(330, t0 + 1.8);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.16, t0 + 0.6);
    g.gain.setTargetAtTime(0, t0 + 1.3, 0.2);
    n.connect(f).connect(g);
    o.connect(g);
    g.connect(out);
    return { nodes: 4, secs: 2 };
  },
  /** A bolt landing: a soft thud and a puff. */
  land(c, out, t0) {
    const o = osc(c, 'sine', 140, t0, 0.4);
    o.frequency.exponentialRampToValueAtTime(52, t0 + 0.25);
    const n = noiseSource(c, t0, 0.3);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g = c.createGain();
    strike(g.gain, t0, 0.28, 0.004, 0.08);
    o.connect(g);
    n.connect(f).connect(g);
    g.connect(out);
    return { nodes: 4, secs: 0.4 };
  },
  /** Beaten: a long major chord of bell partials over 4 s, with sparkles. */
  end(c, out, t0) {
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.1, t0 + 0.02);
    g.gain.linearRampToValueAtTime(0.13, t0 + 1.0);
    g.gain.setTargetAtTime(0, t0 + 1.6, 0.9);
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => osc(c, 'sine', f, t0 + i * 0.22, 5.2 - i * 0.22).connect(g));
    const s = osc(c, 'triangle', 3000, t0, 4.2);
    const sg = c.createGain();
    sg.gain.setValueAtTime(0, t0);
    for (let t = 0.3; t < 3.8; t += 0.11 + Math.random() * 0.16) {
      s.frequency.setValueAtTime(2000 + Math.random() * 2400, t0 + t);
      sg.gain.setValueAtTime(0, t0 + t);
      sg.gain.linearRampToValueAtTime(0.05 * (1 - t / 4), t0 + t + 0.004);
      sg.gain.setTargetAtTime(0, t0 + t + 0.006, 0.03);
    }
    s.connect(sg).connect(out);
    g.connect(out);
    return { nodes: 7, secs: 5.2 };
  },
};

/** How long each cue lasts with the usual numbers (`arg`), for render(). */
const ARG: Partial<Record<SpiritCue, number>> = { sweep: 1.7, pool: 2.6, rise: 1.3, open: 5 };

/** The presence: breath and hum into one gain, five nodes with the panner (out). */
class Presence {
  readonly nodes = 4;
  private src: AudioBufferSourceNode;
  private band: BiquadFilterNode;
  private hum: OscillatorNode;
  private gain: GainNode;
  private next = 0;

  constructor(private c: BaseAudioContext, out: AudioNode) {
    this.src = c.createBufferSource();
    this.src.buffer = noise(c);
    this.src.loop = true;
    this.band = c.createBiquadFilter();
    this.band.type = 'bandpass';
    this.band.Q.value = 0.9;
    this.band.frequency.value = 420;
    // The hum's two notes as the 2nd and 3rd harmonics of 98 Hz: one oscillator, levels kept as given.
    const real = new Float32Array([0, 0, 0.11, 0.07]);
    this.hum = c.createOscillator();
    this.hum.setPeriodicWave(c.createPeriodicWave(real, new Float32Array(4), { disableNormalization: true }));
    this.hum.frequency.value = 98;
    this.gain = c.createGain();
    this.gain.gain.value = 0;
    this.src.connect(this.band).connect(this.gain);
    this.hum.connect(this.gain);
    this.gain.connect(out);
    const t = c.currentTime;
    this.src.start(t);
    this.hum.start(t);
  }

  /** `level` 0 to 1 (by distance), `awake`, `anger` 0 to 1. Breathes over 5 s: scheduled half a second ahead. */
  set(level: number, awake: boolean, anger: number): void {
    const t = this.c.currentTime;
    if (t < this.next) return;
    this.next = t + 0.25;
    const breath = 0.55 + 0.45 * Math.sin((t / 5) * Math.PI * 2);
    const target = level * (awake ? 0.55 + 0.2 * anger : 0.22) * breath;
    this.gain.gain.setTargetAtTime(target, t, 0.3);
    this.band.frequency.setTargetAtTime(320 + 380 * breath + 300 * anger, t, 0.3);
    this.hum.detune.setTargetAtTime(awake ? anger * 25 : -30, t, 0.8);
  }

  stop(): void {
    const t = this.c.currentTime;
    this.gain.gain.setTargetAtTime(0, t, 0.15);
    this.src.stop(t + 0.6);
    this.hum.stop(t + 0.6);
  }
}

/** The live sounds of one spirit. */
export class SpiritSound {
  private presence: Presence | null = null;
  private pan: PannerNode | null = null;
  private live: { end: number; nodes: number }[] = [];

  /** Nodes alive now: the presence and its panner, the cues still sounding. */
  get nodes(): number {
    const c = sound.context();
    const now = c?.currentTime ?? 0;
    this.live = this.live.filter((v) => v.end > now);
    return (this.presence ? this.presence.nodes + 1 : 0) + this.live.reduce((s, v) => s + v.nodes, 0);
  }

  /**
   * Each frame: `dist` from you to it (m), where it is, awake or not, its anger. The presence comes within 60 m and
   * goes past 70; it is heard within about 35 m.
   */
  update(dist: number, x: number, y: number, z: number, awake: boolean, anger: number, show: boolean): void {
    const c = sound.context();
    if (!c || c.state !== 'running' || !show || dist > BUILD + 10) {
      this.drop();
      return;
    }
    if (!this.presence && dist < BUILD) {
      this.pan = sound.at(x, y, z, 8) as PannerNode | null;
      if (!this.pan) return;
      this.presence = new Presence(c, this.pan);
    }
    if (!this.presence || !this.pan) return;
    const t = c.currentTime;
    this.pan.positionX.setTargetAtTime(x, t, 0.1);
    this.pan.positionY.setTargetAtTime(y, t, 0.1);
    this.pan.positionZ.setTargetAtTime(z, t, 0.1);
    this.presence.set(Math.min(1, Math.max(0, (35 - dist) / 20)), awake, anger);
  }

  /** A cue from the spirit itself (`at` null), or from a spot (a light, where a bolt lands). `arg`: its length in s. */
  cue(kind: SpiritCue, at: { x: number; y: number; z: number } | null = null, arg = ARG[kind] ?? 1): void {
    const c = sound.context();
    if (!c || c.state !== 'running' || !this.presence) return; // far off: nothing built, nothing heard
    const need = (at ? 1 : 0) + NEED[kind];
    const have = this.nodes;
    if (have + need > MAX_NODES) {
      if (kind !== 'end') return;
      this.drop(); // the end sounds over everything: the presence goes (it is torn down while it comes apart anyway)
    }
    const out = at ? sound.at(at.x, at.y, at.z, 6) : this.pan;
    if (!out) return;
    const v = VOICES[kind](c, out, c.currentTime + 0.01, arg);
    this.live.push({ end: c.currentTime + v.secs + 0.05, nodes: v.nodes + (at ? 1 : 0) });
  }

  /** Everything off (far away, a room, the sound off). */
  drop(): void {
    this.presence?.stop();
    this.presence = null;
    this.pan = null;
  }
}

/** Nodes each cue needs (its voice's own count). */
const NEED: Record<SpiritCue, number> = { sweep: 3, bolt: 2, pool: 2, rise: 3, open: 4, hit: 2, cap: 2, shell: 3, chime: 2, ping: 2, out: 4, burst: 5, mend: 4, land: 4, end: 7 };

/**
 * Render `kind` (a cue, or 'presence' awake for 8 s) into an OfflineAudioContext, for checks without ears: its
 * numbers (peak, RMS, seconds above -50 dBFS, nodes it needs with its panner) and the buffer.
 */
export async function render(kind: SpiritCue | 'presence', rate = 48000): Promise<{ buffer: AudioBuffer; peak: number; rms: number; audible: number; nodes: number }> {
  const secs = kind === 'presence' ? 8 : kind === 'end' ? 6 : (ARG[kind] ?? 1) + 1;
  const c = new OfflineAudioContext(2, Math.ceil(secs * rate), rate);
  const out = c.createGain(); // stands in for the panner
  out.connect(c.destination);
  let nodes = 1;
  if (kind === 'presence') {
    const p = new Presence(c, out);
    nodes += p.nodes;
    // Breathe as live: the gain's targets set every quarter second, the presence at full level.
    for (let t = 0; t < secs; t += 0.25) {
      const breath = 0.55 + 0.45 * Math.sin((t / 5) * Math.PI * 2);
      (p as unknown as { gain: GainNode }).gain.gain.setTargetAtTime(0.6 * breath, t, 0.3);
    }
  } else nodes += VOICES[kind](c, out, 0.05, ARG[kind] ?? 1).nodes;
  const buffer = await c.startRendering();
  let peak = 0;
  let sum = 0;
  let loud = 0;
  const win = Math.round(rate / 100);
  const d = buffer.getChannelData(0);
  for (let w = 0; w + win <= d.length; w += win) {
    let s = 0;
    for (let i = w; i < w + win; i++) {
      const a = Math.abs(d[i]);
      peak = Math.max(peak, a);
      s += d[i] * d[i];
    }
    sum += s;
    if (Math.sqrt(s / win) > 0.00316) loud++; // -50 dBFS
  }
  return { buffer, peak, rms: Math.sqrt(sum / d.length), audible: loud / 100, nodes };
}
