import * as THREE from 'three';
import { sound } from '../sound';
import { awake, caws } from './fieldBirds';
import { wind } from './wind';

/**
 * The sounds of the countryside, all made in code (nothing to download):
 *
 * - the wind, a soft rushing that swells with the gusts the trees show, quieter indoors and in the
 *   lee of the houses round the plot;
 * - rooks and crows calling from the woods and the fields now and then, from somewhere 60 to 250 m
 *   away;
 * - a cock pheasant's harsh double call from a field, and the whirr of its wings, once in a while.
 *
 * They start after your first click or key (browsers keep sound off until then) and stop in the
 * village, where other sounds take over.
 */

const HOUSE = new THREE.Vector2(4.45, -3);
const RING = 560; // m from the plot: beyond it, the village's sounds

/** A pheasant's call: two hoarse, rising-and-falling notes and a burst of wingbeats. */
function pheasant(at: THREE.Vector3): void {
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y + 0.5, at.z, 25);
  if (!ctx || !dest) return;
  const t0 = ctx.currentTime;
  [[0, 0.13, 1250], [0.2, 0.2, 1100]].forEach(([when, len, f]) => {
    const t = t0 + when;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f * 0.8, t);
    o.frequency.linearRampToValueAtTime(f, t + len * 0.3);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, t + len);
    const throat = ctx.createBiquadFilter();
    throat.type = 'bandpass';
    throat.Q.value = 2;
    throat.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(throat).connect(g).connect(dest);
    o.start(t);
    o.stop(t + len + 0.02);
  });
  // Wingbeats: a rapid, rough flutter.
  const len = 0.7;
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * len), ctx.sampleRate);
  const d = buffer.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const s = i / ctx.sampleRate;
    d[i] = (Math.random() * 2 - 1) * Math.max(0, Math.sin(s * 2 * Math.PI * 16)) ** 3 * (1 - s / len);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.value = 0.45;
  src.connect(f).connect(g).connect(dest);
  src.start(t0 + 0.45);
}

export class Ambience {
  private started = false;
  private gain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private rooksIn = 4;
  private pheasantIn = 40;

  /** `woods`: the middles of the woods; `fields`: of the fields; `indoors`: whether you are in a house. */
  constructor(private woods: THREE.Vector3[], private fields: THREE.Vector3[], private indoors: () => boolean) {
    const go = () => {
      this.started = true;
      for (const e of ['pointerdown', 'keydown', 'touchstart']) removeEventListener(e, go);
    };
    if (awake()) go();
    else for (const e of ['pointerdown', 'keydown', 'touchstart']) addEventListener(e, go);
  }

  /** The wind: brown noise, through a filter that opens with the gusts. */
  private startWind(): void {
    const ctx = sound.context();
    const out = sound.out();
    if (!ctx || !out) return;
    const len = 6;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
    const d = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    // Fade the loop's ends into each other, so it has no seam.
    const fade = ctx.sampleRate * 0.5;
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      d[i] = d[i] * k + d[d.length - fade + i] * (1 - k);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopEnd = len - 0.5;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 500;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    src.connect(this.filter).connect(this.gain).connect(out);
    src.start();
  }

  update(dt: number, eye: THREE.Vector3): void {
    if (!this.started || !sound.enabled) return;
    if (!this.gain) this.startWind();
    const ctx = sound.context();
    if (!ctx || !this.gain || !this.filter) return;
    const fromHouse = Math.hypot(eye.x - HOUSE.x, eye.z - HOUSE.y);
    const out = fromHouse > RING;
    const inside = this.indoors();
    const gust = wind.gust(eye.x, eye.z);
    // Louder in the open and higher up; in the lee of the houses round the plot a little less.
    const open = Math.min(1, 0.55 + fromHouse / 300 + Math.max(0, eye.y - 2) / 40);
    const level = out ? 0 : (inside ? 0.25 : 1) * open * (0.25 + 0.75 * gust) * 0.11;
    const t = ctx.currentTime;
    this.gain.gain.setTargetAtTime(level, t, 0.6);
    this.filter.frequency.setTargetAtTime((inside ? 250 : 380) + gust * 600, t, 0.6);
    if (out || inside) return;
    // Rooks from the woods and the fields round about.
    this.rooksIn -= dt;
    if (this.rooksIn <= 0) {
      this.rooksIn = 6 + Math.random() * 14;
      const from = this.pick([...this.woods, ...this.fields], eye, 60, 250);
      if (from) caws(from.clone().setY(from.y + 8), 1 + Math.floor(Math.random() * 3));
    }
    this.pheasantIn -= dt;
    if (this.pheasantIn <= 0) {
      this.pheasantIn = 50 + Math.random() * 80;
      const from = this.pick(this.fields, eye, 70, 220);
      if (from) pheasant(from);
    }
  }

  /** A random spot from the list between `near` and `far` metres away, or null. */
  private pick(list: THREE.Vector3[], eye: THREE.Vector3, near: number, far: number): THREE.Vector3 | null {
    const ok = list.filter((p) => {
      const d = Math.hypot(p.x - eye.x, p.z - eye.z);
      return d > near && d < far;
    });
    return ok.length ? ok[Math.floor(Math.random() * ok.length)] : null;
  }
}
