// The trailer's music, made in code as the game's own sounds are (no samples, nothing downloaded): a low drone and
// a heartbeat under the intro, a hit on the title, a driving beat in E minor under the gameplay with a lift halfway,
// and a last hit that rings out under the outro. Writes a 48 kHz stereo WAV.
//
//   node tools/dev/trailer/music.mjs --out music.wav --intro 6.5 --hit 3.95 --body 36 --outro 7
import { writeFileSync } from 'node:fs';
import { options } from '../cdp.mjs';

const o = options({ out: 'music.wav', intro: '6.5', hit: '3.95', body: '36', outro: '7', bpm: '150' });
const SR = 48000;
const intro = Number(o.intro), body = Number(o.body), outro = Number(o.outro);
const total = intro + body + outro;
const N = Math.ceil(total * SR);
const L = new Float32Array(N), R = new Float32Array(N);
const beat = 60 / Number(o.bpm);

// A random source that is the same every run.
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

/** Adds a sound at `at` seconds: f(t, i) gives the sample `t` seconds in; pan -1 (left) to 1 (right). */
function add(at, dur, f, gain = 1, pan = 0) {
  const i0 = Math.round(at * SR);
  const n = Math.round(dur * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4), gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n; i++) {
    const k = i0 + i;
    if (k < 0 || k >= N) continue;
    const v = f(i / SR, i);
    L[k] += v * gl * Math.SQRT2;
    R[k] += v * gr * Math.SQRT2;
  }
}
const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));
const note = (semis) => 82.41 * 2 ** (semis / 12); // from E2

const kick = (at, g = 1) => add(at, 0.32, (t) => Math.sin(2 * Math.PI * (45 * t + (95 / 28) * (1 - Math.exp(-28 * t)))) * Math.exp(-9 * t) + (t < 0.004 ? 0.6 : 0), 0.95 * g);
const snare = (at, g = 1) => {
  let lp = 0;
  add(at, 0.22, (t) => { const n = rnd(); lp += (n - lp) * 0.35; return (n - lp) * Math.exp(-22 * t) * 0.9 + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-30 * t) * 0.5; }, 0.5 * g);
};
const hat = (at, g = 1, pan = 0.3) => { let p = 0; add(at, 0.05, (t) => { const n = rnd(); const v = n - p; p = n; return v * Math.exp(-90 * t); }, 0.16 * g, pan); };
const bass = (at, dur, semis, g = 1) => {
  let lp = 0, ph = 0;
  const f = note(semis - 12);
  add(at, dur, (t) => { ph += f / SR; const cut = 0.05 + 0.25 * Math.exp(-14 * t); lp += (saw(ph) + 0.5 * Math.sign(Math.sin(2 * Math.PI * ph)) - lp) * cut; return lp * Math.min(1, t * 400) * Math.exp(-3 * t / dur); }, 0.5 * g);
};
const stab = (at, dur, chord, g = 1) => {
  for (const [j, s] of chord.entries()) for (const d of [-0.006, 0.006]) {
    let ph = rnd(), lp = 0;
    const f = note(s + 12) * (1 + d);
    add(at, dur, (t) => { ph += f / SR; lp += (saw(ph) - lp) * (0.08 + 0.3 * Math.exp(-6 * t)); return lp * Math.min(1, t * 200) * Math.exp(-2.2 * t / dur); }, 0.085 * g, (j - 1) * 0.5 + d * 40);
  }
};
const arp = (at, semis, g = 1, pan = 0) => { let ph = 0; const f = note(semis + 24); add(at, 0.16, (t) => { ph += f / SR; return Math.sign(Math.sin(2 * Math.PI * ph)) * 0.5 * Math.exp(-18 * t); }, 0.07 * g, pan); };
const boom = (at, g = 1, len = 3) => {
  add(at, len, (t) => Math.sin(2 * Math.PI * (30 * t + (40 / 3) * (1 - Math.exp(-3 * t)))) * Math.exp(-1.6 * t), 0.9 * g);
  let lp = 0;
  add(at, 1.6, (t) => { lp += (rnd() - lp) * 0.12; return lp * Math.exp(-4 * t) * 2.2; }, 0.5 * g);
};
const riser = (at, dur, g = 1) => { let p = 0, lp = 0; add(at, dur, (t) => { const n = rnd(); const hp = n - p; p = n; const x = t / dur; lp += (hp - lp) * (0.02 + 0.6 * x * x); return lp * x * x; }, 0.3 * g); };
const drone = (at, dur, g = 1) => {
  for (const [f, pan] of [[41.2, -0.3], [41.5, 0.3], [61.7, 0], [82.6, 0.5]]) {
    add(at, dur, (t) => Math.sin(2 * Math.PI * f * t + 0.6 * Math.sin(2 * Math.PI * 0.11 * t)) * Math.min(1, t / 1.5) * Math.min(1, (dur - t) / 0.4), 0.11 * g, pan);
  }
};
const heart = (at, g = 1) => { for (const d of [0, 0.22]) add(at + d, 0.25, (t) => Math.sin(2 * Math.PI * (38 + 30 * Math.exp(-30 * t)) * t) * Math.exp(-14 * t), (d ? 0.45 : 0.7) * g); };

// The intro: the quiet evening, then the title's hit.
const hitAt = Number(o.hit);
drone(0, hitAt + 0.3, 1);
for (let t = 0.6; t < hitAt - 0.3; t += 1.1) heart(t, 0.6 + (t / hitAt) * 0.6);
riser(hitAt - 1.3, 1.3, 1);
boom(hitAt, 1, 2.6);
stab(hitAt, 2.4, [0, 7, 12], 1.6);
riser(intro - 1.0, 1.0, 0.8);

// The gameplay: bars of four beats; the roots go E E C D; from halfway the hats double and an arpeggio joins.
const ROOTS = [0, 0, -4, -2];
const CHORDS = [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-2, 2, 5]];
const bars = Math.floor(body / (beat * 4));
for (let bar = 0; bar < bars; bar++) {
  const t0 = intro + bar * beat * 4;
  const lift = bar >= Math.floor(bars / 2);
  const last = bar === bars - 1;
  const root = ROOTS[bar % 4];
  if (bar === Math.floor(bars / 2)) { boom(t0, 0.7, 2); }
  if (bar === Math.floor(bars / 2) - 1) riser(t0, beat * 4, 0.9);
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * beat;
    kick(t, 1);
    if (lift && b === 3 && bar % 2 === 1) kick(t + beat * 0.75, 0.8);
    if (b % 2 === 1) snare(t, 1);
    for (let h = 0; h < (lift ? 4 : 2); h++) hat(t + (h * beat) / (lift ? 4 : 2), h % 2 ? 0.6 : 1, h % 2 ? -0.4 : 0.4);
    for (let e = 0; e < 2; e++) bass(t + e * beat * 0.5, beat * 0.46, root + (e && b === 3 ? 12 : 0), e ? 0.8 : 1);
    if (lift) for (let a = 0; a < 4; a++) arp(t + a * beat * 0.25, CHORDS[bar % 4][(b * 4 + a) % 3] + (a === 3 ? 12 : 0), 1, a % 2 ? 0.6 : -0.6);
  }
  stab(t0, beat * (lift ? 1.5 : 3), CHORDS[bar % 4], lift ? 1.2 : 0.9);
  if (lift) stab(t0 + beat * 2.5, beat * 1.2, CHORDS[bar % 4], 0.9);
  if (last) { riser(t0 + beat * 2, beat * 2, 1); for (let r = 0; r < 8; r++) snare(t0 + beat * 2 + r * beat * 0.25, 0.5 + r * 0.07); }
}

// The outro: the last hit rings out.
const end = intro + bars * beat * 4;
boom(end, 1.1, 4);
stab(end, 5.5, [0, 7, 12, 15], 1.8);
drone(end + 0.5, total - end - 0.6, 0.8);
for (let t = end + 3.2; t < total - 1.2; t += 1.1) heart(t, 0.5);

// To a file: a gentle limiter, a fade at the very end.
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const g = 0.9 / Math.max(1, peak * 0.62);
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, (N - i) / (SR * 0.8));
  buf.writeInt16LE(Math.round(Math.tanh(L[i] * g) * fade * 32000), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.tanh(R[i] * g) * fade * 32000), 46 + i * 4);
}
writeFileSync(o.out, buf);
console.log(`${o.out}: ${total.toFixed(1)} s, the beat from ${intro} to ${end.toFixed(2)} s (${bars} bars)`);
