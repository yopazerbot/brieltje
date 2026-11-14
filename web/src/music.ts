/**
 * Music, made in code like every other sound in the game (no files): a quiet theme on the start screen, and music that
 * follows the Zombies game. The open world has none: there the countryside's own sounds stay alone.
 *
 * - The start screen's theme: a village on a calm morning. 70 beats a minute in F major, a soft pad and a plucked,
 *   bell-like melody over sixteen bars, with small changes on every pass (a note left out, a passing note, a phrase an
 *   octave up) so it doesn't loop audibly. It starts at the first click, key or touch on the start screen
 *   (src/start.ts) and fades out over 2.5 s as play begins.
 * - Zombies, alone and together (src/main.ts tells it what the page knows): in the break a low drone and a slow
 *   heartbeat; in a wave a driving beat in E minor (the trailer's, tools/dev/trailer/music.mjs: roots E E C D) that
 *   grows with the wave's number and thins out as the last few zombies are left; a low stab when a big one comes out;
 *   a last hit that rings out when the game ends. Changes wait for a bar line; starting and stopping crossfade.
 *
 * A look-ahead scheduler: every 100 ms a timer puts the notes of the next 300 ms on the audio clock, so the music
 * keeps time through a slow frame (and further ahead in a background tab, whose timers run late). At most about a
 * dozen sources sound at once; every node is let go once its note ends. Nothing is scheduled while the music is at 0
 * or the sound is off. The music has its own gain on the master volume (sound.ts musicOut), past the room's echo and
 * the walls' muffling: it is not in the world.
 *
 * The same pieces play onto any BaseAudioContext: `render` (the dev build's brielMusic, tools/dev/music.mjs) plays
 * them into an OfflineAudioContext, for checks without ears. No three.js here: the start screen uses this.
 */
import { sound } from './sound';

/** What the page knows of the Zombies game (src/main.ts). `big`: how many big ones came out so far. */
export interface ZombieState {
  on: boolean;
  rest: boolean;
  over: boolean;
  wave: number;
  left: number;
  big: number;
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A random source that is the same every run, for the offline checks (live, a random seed). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sources at once: low notes (hats, the arpeggio, the melody's extras) are left out above SOFT, every note above HARD. */
const SOFT = 12;
const HARD = 14;

/**
 * Where the notes go: one per context. It keeps count of the sources that will sound (to keep under SOFT and HARD) and
 * lets every note's nodes go when its last source ends.
 */
class Sink {
  readonly noise: AudioBuffer;
  readonly bellWave: PeriodicWave;
  /** Sources started and not yet ended, and all the nodes of their notes */
  live = 0;
  nodes = 0;
  /** Notes scheduled since the start */
  notes = 0;
  /** Nothing new while true (the music at 0, the sound off) */
  mute = false;
  /** The notes' times on the audio clock, with how many sources each: [start, stop, n] */
  private spans: [number, number, number][] = [];
  /** Offline: every note's span, to find the most sources at once afterwards */
  log: [number, number, number][] | null = null;

  constructor(readonly c: BaseAudioContext, rnd: () => number) {
    const n = c.sampleRate;
    this.noise = c.createBuffer(1, n, n);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
    // The pluck: a fundamental with a few soft overtones, like a music box or a kalimba.
    const imag = new Float32Array([0, 1, 0.42, 0.16, 0.09, 0.04, 0.02]);
    this.bellWave = c.createPeriodicWave(new Float32Array(imag.length), imag);
  }

  /** Whether `n` more sources may sound from `start` to `stop` (`low`: a note that can be left out first). */
  room(start: number, stop: number, n: number, low = false): boolean {
    if (this.mute) return false;
    const cap = low ? SOFT : HARD;
    const at = (x: number) => this.spans.reduce((sum, [a, b, k]) => (a <= x && x < b ? sum + k : sum), 0);
    let most = at(start);
    for (const [a] of this.spans) if (a > start && a < stop) most = Math.max(most, at(a));
    return most + n <= cap;
  }

  /** Start and stop a note's sources; its nodes are let go when the last one ends. */
  play(sources: AudioScheduledSourceNode[], others: AudioNode[], start: number, stop: number): void {
    const span: [number, number, number] = [start, stop, sources.length];
    this.spans.push(span);
    this.log?.push(span);
    this.notes++;
    this.live += sources.length;
    this.nodes += sources.length + others.length;
    let left = sources.length;
    for (const s of sources) {
      s.onended = () => {
        if (this.ended.has(s)) return void this.twice++;
        this.ended.add(s);
        this.live--;
        if (--left > 0) return;
        for (const node of [...sources, ...others]) node.disconnect();
        this.nodes -= sources.length + others.length;
      };
      const offset = this.offsets.get(s);
      if (offset === undefined) s.start(start);
      else (s as AudioBufferSourceNode).start(start, offset);
      s.stop(stop);
    }
  }

  /** Forget the spans that ended before `now`. */
  prune(now: number): void {
    if (this.spans.length > 40) this.spans = this.spans.filter((s) => s[1] > now);
  }

  osc(type: OscillatorType, f: number, detune = 0): OscillatorNode {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    return o;
  }

  filter(type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode {
    const b = this.c.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  gain(): GainNode {
    const g = this.c.createGain();
    g.gain.value = 0;
    return g;
  }

  /** White noise from a random place in the buffer. */
  hiss(rnd: () => number): AudioBufferSourceNode {
    const s = this.c.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.loopStart = 0;
    s.loopEnd = this.noise.duration;
    this.offsets.set(s, rnd() * 0.5);
    return s;
  }
  /** The sources that ended, and how often one said so twice (Chrome does, now and then, live: seen 4 times in 900 notes) */
  private ended = new WeakSet<AudioScheduledSourceNode>();
  twice = 0;
  /** Where in the noise each hiss begins */
  private offsets = new WeakMap<AudioScheduledSourceNode, number>();
}

/** A fast rise to `peak`, then down to nothing at `end` (exponential, as a struck thing dies away). */
function strike(g: AudioParam, t: number, peak: number, end: number, attack = 0.004): void {
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(0.0004, end);
}

// ---- The instruments. Each puts one note on the clock at `t` into `out`, if there is room for it.

/** The theme's pad: a chord of soft triangles through a lowpass, swelling in, held for `dur`, then let go. */
function pad(s: Sink, out: AudioNode, t: number, dur: number, midis: number[], peak: number, rnd: () => number): void {
  const stop = t + dur + 2.2;
  if (!s.room(t, stop, midis.length)) return;
  const f = s.filter('lowpass', 1150, 0.4);
  const g = s.gain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + Math.min(1.6, dur * 0.5));
  g.gain.setValueAtTime(peak, t + dur);
  g.gain.setTargetAtTime(0, t + dur, 0.4);
  const oscs = midis.map((m) => s.osc('triangle', hz(m), (rnd() - 0.5) * 12));
  for (const o of oscs) o.connect(f);
  f.connect(g).connect(out);
  s.play(oscs, [f, g], t, stop);
}

/** A plucked, bell-like note: bright at first, mellowing as it rings. */
function bell(s: Sink, out: AudioNode, t: number, midi: number, peak: number, len: number, pan: number, low = false): void {
  if (!s.room(t, t + len, 1, low)) return;
  const o = s.c.createOscillator();
  o.setPeriodicWave(s.bellWave);
  o.frequency.value = hz(midi);
  const f = s.filter('lowpass', 5200, 0.5);
  f.frequency.setValueAtTime(5200, t);
  f.frequency.exponentialRampToValueAtTime(1100, t + 0.7);
  const g = s.gain();
  strike(g.gain, t, peak, t + len, 0.005);
  const p = s.c.createStereoPanner();
  p.pan.value = pan;
  o.connect(f).connect(g).connect(p).connect(out);
  s.play([o], [f, g, p], t, t + len);
}

/** The low drone under the break: E and B a fifth apart, deep, through a lowpass, faded in and out. */
function drone(s: Sink, out: AudioNode, t: number, dur: number, peak: number, rnd: () => number, cutoff = 240): void {
  if (!s.room(t, t + dur, 2)) return;
  const f = s.filter('lowpass', cutoff, 0.6);
  const g = s.gain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.9);
  g.gain.setValueAtTime(peak, t + dur - 0.9);
  g.gain.linearRampToValueAtTime(0, t + dur);
  const oscs = [s.osc('sawtooth', hz(28), (rnd() - 0.5) * 8), s.osc('sawtooth', hz(35), (rnd() - 0.5) * 8)];
  for (const o of oscs) o.connect(f);
  f.connect(g).connect(out);
  s.play(oscs, [f, g], t, t + dur);
}

/** One beat of a heart: a soft low thump, its pitch falling. */
function thump(s: Sink, out: AudioNode, t: number, peak: number): void {
  if (!s.room(t, t + 0.3, 1)) return;
  const o = s.osc('sine', 95);
  o.frequency.setValueAtTime(95, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  const g = s.gain();
  strike(g.gain, t, peak, t + 0.3, 0.006);
  o.connect(g).connect(out);
  s.play([o], [g], t, t + 0.3);
}

function kick(s: Sink, out: AudioNode, t: number, peak: number): void {
  if (!s.room(t, t + 0.32, 1)) return;
  const o = s.osc('sine', 150);
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(46, t + 0.08);
  const g = s.gain();
  strike(g.gain, t, peak, t + 0.32, 0.002);
  o.connect(g).connect(out);
  s.play([o], [g], t, t + 0.32);
}

function snare(s: Sink, out: AudioNode, t: number, peak: number, rnd: () => number): void {
  if (!s.room(t, t + 0.18, 2)) return;
  const n = s.hiss(rnd);
  const hp = s.filter('highpass', 1100, 0.6);
  const gn = s.gain();
  strike(gn.gain, t, peak, t + 0.18, 0.002);
  const o = s.osc('triangle', 190);
  const go = s.gain();
  strike(go.gain, t, peak * 0.6, t + 0.09, 0.002);
  n.connect(hp).connect(gn).connect(out);
  o.connect(go).connect(out);
  s.play([n, o], [hp, gn, go], t, t + 0.18);
}

function hat(s: Sink, out: AudioNode, t: number, peak: number, pan: number, rnd: () => number): void {
  if (!s.room(t, t + 0.05, 1, true)) return;
  const n = s.hiss(rnd);
  const hp = s.filter('highpass', 7200, 0.7);
  const g = s.gain();
  strike(g.gain, t, peak, t + 0.05, 0.001);
  const p = s.c.createStereoPanner();
  p.pan.value = pan;
  n.connect(hp).connect(g).connect(p).connect(out);
  s.play([n], [hp, g, p], t, t + 0.05);
}

function bass(s: Sink, out: AudioNode, t: number, dur: number, midi: number, peak: number): void {
  if (!s.room(t, t + dur, 1)) return;
  const o = s.osc('sawtooth', hz(midi));
  const f = s.filter('lowpass', 1400, 1.2);
  f.frequency.setValueAtTime(1400, t);
  f.frequency.exponentialRampToValueAtTime(220, t + 0.15);
  const g = s.gain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.004);
  g.gain.setValueAtTime(peak, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
  o.connect(f).connect(g).connect(out);
  s.play([o], [f, g], t, t + dur);
}

/** A chord of saws, struck: bright, closing down as it fades. Spread a little across left and right. */
function stab(s: Sink, out: AudioNode, t: number, dur: number, midis: number[], peak: number, rnd: () => number): void {
  if (!s.room(t, t + dur, midis.length)) return;
  const f = s.filter('lowpass', 2600, 0.8);
  f.frequency.setValueAtTime(2600, t);
  f.frequency.exponentialRampToValueAtTime(500, t + dur);
  const g = s.gain();
  strike(g.gain, t, peak, t + dur, 0.006);
  const nodes: AudioNode[] = [f, g];
  const oscs = midis.map((m, i) => {
    const o = s.osc('sawtooth', hz(m), (rnd() - 0.5) * 14);
    const p = s.c.createStereoPanner();
    p.pan.value = midis.length > 1 ? (i / (midis.length - 1) - 0.5) * 0.8 : 0;
    o.connect(p).connect(f);
    nodes.push(p);
    return o;
  });
  f.connect(g).connect(out);
  s.play(oscs, nodes, t, t + dur);
}

function arp(s: Sink, out: AudioNode, t: number, midi: number, peak: number, pan: number): void {
  if (!s.room(t, t + 0.14, 1, true)) return;
  const o = s.osc('square', hz(midi));
  const f = s.filter('lowpass', 3000, 0.5);
  const g = s.gain();
  strike(g.gain, t, peak, t + 0.14, 0.003);
  const p = s.c.createStereoPanner();
  p.pan.value = pan;
  o.connect(f).connect(g).connect(p).connect(out);
  s.play([o], [f, g, p], t, t + 0.14);
}

/** A deep hit: a falling sine and a dark rumble of noise. */
function boom(s: Sink, out: AudioNode, t: number, peak: number, len: number, rnd: () => number): void {
  if (!s.room(t, t + len, 2)) return;
  const o = s.osc('sine', 72);
  o.frequency.setValueAtTime(72, t);
  o.frequency.exponentialRampToValueAtTime(31, t + len * 0.5);
  const g = s.gain();
  strike(g.gain, t, peak, t + len, 0.004);
  const n = s.hiss(rnd);
  const lp = s.filter('lowpass', 380, 0.5);
  const gn = s.gain();
  strike(gn.gain, t, peak * 0.5, t + Math.min(len, 1.4), 0.004);
  o.connect(g).connect(out);
  n.connect(lp).connect(gn).connect(out);
  s.play([o, n], [g, lp, gn], t, t + len);
}

/** A big one is out: a low, dark stab of E with a falling sub under it. */
function lowStab(s: Sink, out: AudioNode, t: number, peak: number): void {
  const len = 1.3;
  if (!s.room(t, t + len, 3)) return;
  const f = s.filter('lowpass', 700, 1);
  f.frequency.setValueAtTime(700, t);
  f.frequency.exponentialRampToValueAtTime(140, t + len);
  const g = s.gain();
  strike(g.gain, t, peak, t + len, 0.005);
  const saws = [s.osc('sawtooth', hz(28)), s.osc('sawtooth', hz(40), 7)];
  for (const o of saws) o.connect(f);
  f.connect(g).connect(out);
  const sub = s.osc('sine', 80);
  sub.frequency.setValueAtTime(80, t);
  sub.frequency.exponentialRampToValueAtTime(36, t + 0.4);
  const gs = s.gain();
  strike(gs.gain, t, peak * 1.6, t + len * 0.8, 0.005);
  sub.connect(gs).connect(out);
  s.play([...saws, sub], [f, g, gs], t, t + len);
}

// ---- The pieces. Each steps along a grid (eighths in the theme, sixteenths in Zombies) on its own gain.

abstract class Piece {
  readonly gain: GainNode;
  /** The next step's number and its time on the audio clock */
  step = 0;
  time: number;
  /** When its fade-out ends (null: playing) */
  fadeEnd: number | null = null;
  private inFrom: number;
  private inTo: number;
  abstract readonly stepLen: number;
  abstract readonly peak: number;

  constructor(protected s: Sink, bus: AudioNode, now: number, fadeIn: number, protected rnd: () => number) {
    this.gain = s.c.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(bus);
    this.time = now + 0.06;
    this.inFrom = now;
    this.inTo = now + fadeIn;
  }

  /** Called once the subclass's fields are set: the fade in. */
  begin(): this {
    this.gain.gain.setValueAtTime(0, this.inFrom);
    this.gain.gain.linearRampToValueAtTime(this.peak, this.inTo);
    return this;
  }

  /** Fade out over `secs` from `now`; nothing new is put on the clock after that. */
  fade(now: number, secs: number): void {
    if (this.fadeEnd !== null) return;
    const v = this.peak * Math.min(1, Math.max(0, (now - this.inFrom) / Math.max(0.001, this.inTo - this.inFrom)));
    const g = this.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(v, now);
    g.linearRampToValueAtTime(0, now + secs);
    this.fadeEnd = now + secs;
  }

  /** Put the steps due before `until` on the clock. A step long gone (the clock jumped: a hitch, a sleeping tab) is passed over. */
  run(now: number, until: number): void {
    while (this.time < until && (this.fadeEnd === null || this.time < this.fadeEnd)) {
      if (this.time >= now - 0.02) this.play(this.step, this.time);
      else this.pass(this.step);
      this.step++;
      this.time += this.stepLen;
    }
  }

  /** Done and silent: its gain can go (the longest note rings 6 s). */
  gone(now: number): boolean {
    return this.fadeEnd !== null && now > this.fadeEnd + 6.5;
  }

  protected abstract play(step: number, t: number): void;
  /** A step passed over: keep track of the bars without playing. */
  protected pass(step: number): void {
    void step;
  }
}

// The theme: F major, a chord a bar. Pad voicings (MIDI) with a low root, kept soft and open.
const TCHORD: Record<string, number[]> = {
  F: [41, 57, 64],
  Dm: [38, 53, 60],
  Bb: [46, 57, 62],
  C: [36, 55, 64],
  Am: [45, 55, 60],
  Gm: [43, 58, 62],
};
/** A note of the melody: on which eighth of the bar, its pitch, and how many eighths it lasts. */
type Note = [number, number, number];
/** Four phrases of four bars: their chords and their melody. Played A, A2, B, D: sixteen bars, about 55 s. */
const PHRASES: { chords: string[]; tune: Note[][] }[] = [
  {
    chords: ['F', 'Dm', 'Bb', 'C'],
    tune: [
      [[0, 72, 3], [3, 74, 1], [4, 72, 2], [6, 69, 2]],
      [[0, 69, 3], [3, 72, 1], [4, 74, 4]],
      [[0, 74, 2], [2, 72, 1], [3, 70, 1], [4, 69, 2], [6, 65, 2]],
      [[0, 67, 3], [3, 69, 1], [4, 67, 4]],
    ],
  },
  {
    chords: ['F', 'Dm', 'Bb', 'C'],
    tune: [
      [[0, 72, 3], [3, 74, 1], [4, 76, 2], [6, 77, 2]],
      [[0, 76, 2], [2, 74, 2], [4, 72, 4]],
      [[0, 70, 2], [2, 69, 2], [4, 67, 2], [6, 69, 2]],
      [[0, 67, 4], [4, 64, 4]],
    ],
  },
  {
    chords: ['Dm', 'Am', 'Bb', 'F'],
    tune: [
      [[0, 74, 2], [2, 77, 2], [4, 76, 1], [5, 74, 1], [6, 72, 2]],
      [[0, 72, 3], [3, 69, 1], [4, 67, 4]],
      [[0, 70, 2], [2, 74, 2], [4, 72, 2], [6, 70, 2]],
      [[0, 69, 4], [4, 72, 4]],
    ],
  },
  {
    chords: ['Gm', 'C', 'F', 'F'],
    tune: [
      [[0, 70, 2], [2, 74, 2], [4, 77, 4]],
      [[0, 76, 3], [3, 74, 1], [4, 72, 4]],
      [[0, 69, 2], [2, 72, 2], [4, 65, 4]],
      [[4, 72, 4]],
    ],
  },
];
/** F major, for the passing notes. */
const SCALE = [60, 62, 64, 65, 67, 69, 70, 72, 74, 76, 77, 79, 81, 82, 84];
const above = (m: number) => SCALE.find((x) => x > m) ?? m + 2;

class Theme extends Piece {
  readonly stepLen = 60 / 70 / 2; // eighths at 70 beats a minute
  readonly peak = 1;
  /** This bar's notes, with this pass's changes: [eighth, pitch, length in s, loudness, low] */
  private bar: [number, number, number, number, boolean][] = [];

  protected play(step: number, t: number): void {
    const pos = step % 8;
    const barNo = Math.floor(step / 8);
    if (pos === 0) {
      const phrase = PHRASES[Math.floor(barNo / 4) % 4];
      const chord = TCHORD[phrase.chords[barNo % 4]];
      pad(this.s, this.gain, t, this.stepLen * 8, chord, 0.05, this.rnd);
      this.bar = this.vary(barNo);
    }
    for (const [at, midi, len, loud, low] of this.bar) {
      if (at === pos) bell(this.s, this.gain, t, midi, 0.2 * loud, len, (this.rnd() - 0.5) * 0.5, low);
    }
  }

  /** Bar `barNo`'s melody with this pass's small changes. */
  private vary(barNo: number): [number, number, number, number, boolean][] {
    const pass = Math.floor(barNo / 16);
    const phraseNo = Math.floor(barNo / 4) % 4;
    const notes = PHRASES[phraseNo].tune[barNo % 4];
    const r = this.rnd;
    // From the second pass on, the third phrase sometimes sings an octave higher.
    const up = pass > 0 && phraseNo === 2 && (barNo % 16 === 8 ? (this.upB = r() < 0.5) : this.upB) ? 12 : 0;
    const out: [number, number, number, number, boolean][] = [];
    notes.forEach(([at, midi, len], i) => {
      if (pass > 0 && i > 0 && r() < 0.12) return; // a note left out
      const secs = Math.min(2.4, 0.6 + len * this.stepLen);
      const loud = (at % 4 === 0 ? 1 : 0.8) * (0.85 + r() * 0.3);
      if (pass > 0 && len >= 2 && r() < 0.18) {
        // A passing note in the second half of a long one.
        out.push([at, midi + up, this.stepLen * len * 0.5 + 0.5, loud, false]);
        out.push([at + Math.floor(len / 2), above(midi) + up, secs * 0.7, loud * 0.75, true]);
        return;
      }
      out.push([at, midi + up, secs, loud, false]);
    });
    // Now and then a soft echo high up at the bar's end.
    if (r() < 0.14 && !out.some(([at]) => at === 7)) out.push([7, 84 - [0, 3, 5][Math.floor(r() * 3)], 1.6, 0.4, true]);
    return out;
  }
  private upB = false;
}

// Zombies: E minor at 140 beats a minute, bars of sixteen sixteenths. The roots go E E C D (the trailer's).
const ROOTS = [0, 0, -4, -2];
const ZCHORD = [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-2, 2, 5]];
const E2 = 40;
const E3 = 52;
type Section = 'none' | 'rest' | 'wave' | 'end';

class Zombies extends Piece {
  readonly stepLen = 60 / 140 / 4;
  readonly peak = 1;
  /** What the page says now; read on every bar line */
  state: ZombieState = { on: true, rest: true, over: false, wave: 0, left: 0, big: 0 };
  /** This bar's part and loudness (latched at the bar line) */
  section: Section = 'none';
  private intensity = 0;
  private sectionBar = 0;
  private wave = 0;
  private bigs = -1;
  private bigDue = false;

  /** How hard a wave drives: up with its number, down as its last few zombies are left. 0..1 */
  static intensity(wave: number, left: number): number {
    const base = Math.min(1, 0.35 + 0.13 * Math.max(0, wave - 1));
    return base * (0.55 + 0.45 * Math.min(1, left / 6));
  }

  private latch(barNo: number): boolean {
    const z = this.state;
    const next: Section = !z.on ? 'none' : z.over ? 'end' : z.rest ? 'rest' : 'wave';
    const before = this.section;
    const newWave = next === 'wave' && (before !== 'wave' || z.wave !== this.wave);
    if (next !== before) this.sectionBar = barNo;
    this.section = next;
    this.wave = z.wave;
    this.intensity = Zombies.intensity(z.wave, z.left);
    return newWave;
  }

  protected pass(step: number): void {
    if (step % 16 === 0) this.latch(Math.floor(step / 16));
    this.watchBigs();
  }

  private watchBigs(): void {
    const n = this.state.big;
    if (this.bigs >= 0 && n > this.bigs) this.bigDue = true;
    this.bigs = n;
  }

  protected play(step: number, t: number): void {
    const pos = step % 16;
    const barNo = Math.floor(step / 16);
    const before = this.section;
    const newWave = pos === 0 && this.latch(barNo);
    this.watchBigs();
    const s = this.s;
    const out = this.gain;
    const r = this.rnd;
    const barLen = this.stepLen * 16;
    const sec = this.section;
    if (sec === 'rest') {
      this.bigDue = false;
      if (pos === 0 && (barNo - this.sectionBar) % 2 === 0) drone(s, out, t, barLen * 2 + 0.9, 0.035, r, 320);
      if (pos === 0 || pos === 8) {
        thump(s, out, t, 0.2);
        thump(s, out, t + 0.22, 0.13);
      }
    } else if (sec === 'wave') {
      const i = this.intensity;
      const root = ROOTS[barNo % 4];
      const lift = 0.6 + 0.4 * i;
      if (newWave) boom(s, out, t, 0.14, 2.4, r);
      if (pos % 4 === 0) kick(s, out, t, 0.24 * (0.75 + 0.25 * i));
      if (i >= 0.75 && pos === 14 && barNo % 2 === 1) kick(s, out, t, 0.17);
      if (pos === 4 || pos === 12) {
        if (i >= 0.45) snare(s, out, t, 0.1 * lift, r);
        else hat(s, out, t, 0.04, 0, r);
      }
      if (pos % 2 === 0) hat(s, out, t, pos % 4 ? 0.016 : 0.024, pos % 4 ? -0.4 : 0.4, r);
      else if (i >= 0.7) hat(s, out, t, 0.01, 0.3, r);
      if (pos % 2 === 0) bass(s, out, t, this.stepLen * 1.8, E2 + root + (pos === 14 ? 12 : 0), 0.09 * lift);
      if (pos === 0) stab(s, out, t, this.stepLen * (i >= 0.8 ? 6 : 12), ZCHORD[barNo % 4].map((x) => E3 + x), 0.036 * lift, r);
      if (pos === 10 && i >= 0.8) stab(s, out, t, this.stepLen * 5, ZCHORD[barNo % 4].map((x) => E3 + x), 0.026, r);
      if (i >= 0.85) {
        const ch = ZCHORD[barNo % 4];
        arp(s, out, t, E3 + 24 + ch[pos % 3] + (pos % 4 === 3 ? 12 : 0), 0.018, pos % 2 ? 0.5 : -0.5);
      }
      if (this.bigDue && pos % 4 === 0) {
        this.bigDue = false;
        lowStab(s, out, t, 0.075);
      }
    } else if (sec === 'end' && pos === 0 && barNo === this.sectionBar && (before === 'wave' || before === 'rest')) {
      // The last hit, ringing out: a deep boom, a long open chord of E, and the drone once more, fading.
      boom(s, out, t, 0.22, 4, r);
      stab(s, out, t, 5.5, [E3, E3 + 7, E3 + 12, E3 + 15], 0.03, r);
      drone(s, out, t + 0.5, 5.5, 0.05, r, 200);
    }
  }
}

// ---- The player: the pieces wanted now, on one context.

class Player {
  readonly bus: GainNode;
  readonly s: Sink;
  theme: Theme | null = null;
  zombies: Zombies | null = null;
  private pieces: Piece[] = [];

  constructor(readonly c: BaseAudioContext, out: AudioNode, private rnd: () => number, level: number) {
    this.s = new Sink(c, rnd);
    this.bus = c.createGain();
    this.bus.gain.value = level;
    this.bus.connect(out);
  }

  setLevel(v: number, now: number): void {
    this.bus.gain.setTargetAtTime(v, now, 0.08);
  }

  want(theme: boolean, z: ZombieState | null, now: number): void {
    if (theme && !this.theme) this.pieces.push((this.theme = new Theme(this.s, this.bus, now, 2, this.rnd).begin()));
    if (!theme && this.theme) {
      this.theme.fade(now, 2.5);
      this.theme = null;
    }
    if (z?.on && !this.zombies) this.pieces.push((this.zombies = new Zombies(this.s, this.bus, now, 1, this.rnd).begin()));
    if (!z?.on && this.zombies) {
      this.zombies.fade(now, 1.2);
      this.zombies = null;
    }
    if (this.zombies && z) this.zombies.state = { ...z };
  }

  /** Put the notes due before `now + ahead` on the clock (none while `mute`); let finished pieces go. */
  tick(now: number, ahead: number, mute: boolean): void {
    this.s.mute = mute;
    this.s.prune(now);
    for (const p of this.pieces) p.run(now, now + ahead);
    for (const p of this.pieces.filter((q) => q.gone(now))) p.gain.disconnect();
    this.pieces = this.pieces.filter((q) => !q.gone(now));
  }

  get idle(): boolean {
    return this.pieces.length === 0;
  }

  /** Dev build: each piece's gain now, the ones fading out too. */
  gains(): number[] {
    return this.pieces.map((p) => Math.round(p.gain.gain.value * 1000) / 1000);
  }
}

// ---- The page's music: one player on the game's audio context, driven by a timer.

const TICK_MS = 100;
const AHEAD = 0.3;
const AHEAD_HIDDEN = 1.6; // a background tab's timers may run once a second
let player: Player | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let level = 0.5;
let allowed = true;
let wantTheme = false;
let wantZombies: ZombieState | null = null;

const wanted = () => wantTheme || !!wantZombies?.on;

/** The time the timer took on the page's thread (ms), and how often it ran: for the dev build's checks */
let tickMs = 0;
let ticks = 0;

function tick(): void {
  const t0 = performance.now();
  step();
  tickMs += performance.now() - t0;
  ticks++;
}

function step(): void {
  // Never the first to make the audio context: browsers start one only from a click, tap or key.
  if (!wanted() && !player) return;
  const out = allowed ? sound.musicOut() : null;
  if (!out) return;
  const c = out.context as AudioContext;
  if (!player || player.c !== c) player = new Player(c, out, Math.random, level);
  const now = c.currentTime;
  player.want(wantTheme, wantZombies, now);
  const ahead = typeof document !== 'undefined' && document.hidden ? AHEAD_HIDDEN : AHEAD;
  player.tick(now, ahead, level <= 0 || !sound.enabled || c.state !== 'running');
  if (!wanted() && player.idle && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function wake(): void {
  if (!allowed || (!wanted() && !player)) return;
  if (timer === null) timer = setInterval(tick, TICK_MS);
  tick();
}

export const music = {
  /** Whether this page plays music at all: not the watch page, and in the split screen only seat 1 (src/start.ts). */
  allow(on: boolean): void {
    allowed = on;
  },
  /** The Music setting, 0 (off) to 1 (src/settings.ts); 0.5 by default. */
  setLevel(v: number): void {
    level = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
    if (player) player.setLevel(level, player.c.currentTime);
    wake();
  },
  /** The start screen's theme: on from the first click there (src/start.ts), off as play begins (src/main.ts). */
  theme(on: boolean): void {
    if (on === wantTheme) return;
    wantTheme = on;
    if (on || player) wake();
  },
  /** The Zombies game as the page knows it now (src/main.ts, every frame): cheap when nothing changed. */
  zombies(z: ZombieState): void {
    const w = wantZombies;
    if (w && w.on === z.on && w.rest === z.rest && w.over === z.over && w.wave === z.wave && w.left === z.left && w.big === z.big) return;
    if (!w && !z.on) return;
    wantZombies = z.on ? { ...z } : null;
    if (player?.zombies) player.zombies.state = { ...z };
    wake();
  },
};

/** Render `seconds` of the theme, or of a scripted Zombies run, offline at `rate` (the checks: tools/dev/music.mjs). */
export async function render(kind: 'theme' | 'zombies', seconds: number, rate = 48000, at = 0.5): Promise<{ buffer: AudioBuffer; maxSources: number; notes: number; leftSources: number; leftNodes: number }> {
  const c = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const p = new Player(c, c.destination, seeded(20261114), at);
  p.s.log = [];
  for (let t = 0; t < seconds; t += TICK_MS / 1000) {
    p.want(kind === 'theme', kind === 'zombies' ? zombieRun(t) : null, t);
    p.tick(t, AHEAD, false);
  }
  const buffer = await c.startRendering();
  await new Promise((r) => setTimeout(r, 300)); // the last notes' ended events
  // The most sources at once: at some note's start.
  const log = p.s.log;
  let maxSources = 0;
  for (const [a] of log) maxSources = Math.max(maxSources, log.reduce((sum, [x, y, n]) => (x <= a && a < y ? sum + n : sum), 0));
  return { buffer, maxSources, notes: p.s.notes, leftSources: p.s.live, leftNodes: p.s.nodes };
}

/** The scripted Zombies run for the checks: a break, wave 1, a short break, wave 5 with a big one, the end. */
export function zombieRun(t: number): ZombieState {
  const z: ZombieState = { on: true, rest: false, over: false, wave: 0, left: 0, big: 0 };
  if (t < 10) return { ...z, rest: true };
  if (t < 26) return { ...z, wave: 1, left: Math.max(1, Math.ceil(8 - (t - 10) * 0.45)) };
  if (t < 30) return { ...z, rest: true, wave: 1 };
  if (t < 48) return { ...z, wave: 5, left: Math.max(1, Math.ceil(14 - (t - 30) * 0.7)), big: t >= 34 ? 1 : 0 };
  return { ...z, over: true, wave: 5, big: 1 };
}

/** Dev build: the music's state now, for the headless checks. */
function liveState(): Record<string, unknown> {
  const c = player?.c as AudioContext | undefined;
  return {
    ctx: c?.state ?? 'none',
    time: c?.currentTime ?? 0,
    level,
    allowed,
    theme: !!player?.theme,
    zombies: player?.zombies?.section ?? null,
    gains: player?.gains() ?? [],
    sources: player?.s.live ?? 0,
    nodes: player?.s.nodes ?? 0,
    notes: player?.s.notes ?? 0,
    twice: player?.s.twice ?? 0,
    tickMs,
    ticks,
    timer: timer !== null,
  };
}

if (import.meta.env.DEV) Object.assign(window, { brielMusic: { render, zombieRun, live: liveState, music } });
