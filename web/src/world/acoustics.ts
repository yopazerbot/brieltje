import { sound } from '../sound';

/**
 * The echo of where you are, made in code (no sound files): out of doors none, a short one in a house's rooms, a long
 * one at the foot of the church tower (open to the nave), a middle one up the tower's stair. Each is a convolver on
 * the master volume (sound.ts) with an impulse response worked out at start-up: noise dying away, darker as it dies,
 * after a few early reflections off the walls. A change of place fades over half a second. Inside, the sounds of out
 * of doors (the wind, the birds, the cars, the bells from a house) come through the walls: muffled and quieter. In
 * the church tower the bells ring loud and long (world/bells.ts).
 *
 * On a phone the responses are shorter and mono: one convolution instead of two, and less of it.
 */

export type Room = 'outdoors' | 'room' | 'church' | 'tower';

interface Preset {
  /** s to die away by 60 dB; on a phone `phone` */
  seconds: number;
  phone: number;
  /** Hz: how bright the tail starts (it darkens to a quarter of this) */
  damp: number;
  /** the send into the echo */
  wet: number;
  /** s before the tail, and the early reflections (s) */
  pre: number;
  early: number[];
  /** how much the walls take off the sounds of out of doors, 0 to 1 */
  muffle: number;
}

export const PRESETS: Record<Exclude<Room, 'outdoors'>, Preset> = {
  room: { seconds: 0.45, phone: 0.35, damp: 5000, wet: 0.18, pre: 0.003, early: [0.004, 0.007, 0.011, 0.016], muffle: 1 },
  church: { seconds: 2.8, phone: 1.6, damp: 3200, wet: 0.38, pre: 0.022, early: [0.018, 0.031, 0.047, 0.063], muffle: 1 },
  tower: { seconds: 1.3, phone: 0.9, damp: 3800, wet: 0.28, pre: 0.006, early: [0.005, 0.009, 0.014, 0.021], muffle: 0.9 },
};

const FADE = 0.5; // s between two places
const HOLD = 0.3; // s a new place must last before the echo changes (no flicker on a doorstep)
const PHONE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** A small fixed random sequence, so every page makes the same echo. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The impulse response's samples, one array per channel: a few early reflections, then noise that dies away by 60 dB
 * over `seconds` and darkens from `damp` Hz to a quarter of it, peak 0.9. Pure, so it can be tested without a browser.
 */
export function impulse(rate: number, seconds: number, damp: number, channels: number, pre: number, early: number[]): Float32Array<ArrayBuffer>[] {
  const n = Math.max(1, Math.ceil(rate * (seconds + pre)));
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const rnd = random(0x5eed + ch * 977);
    const d = new Float32Array(n);
    const start = Math.floor(pre * rate);
    const ramp = Math.max(1, Math.floor(0.0015 * rate));
    let y = 0;
    for (let i = start; i < n; i++) {
      const t = (i - start) / rate;
      const k = t / seconds;
      const a = Math.exp((-2 * Math.PI * damp * Math.pow(0.25, k)) / rate);
      y = (1 - a) * (rnd() * 2 - 1) + a * y;
      d[i] = y * Math.exp(-6.91 * k) * Math.min(1, (i - start) / ramp);
    }
    // The first reflections off the walls, each channel a little apart (they widen the room).
    early.forEach((s, j) => {
      const i = Math.floor((s + (ch ? 0.0007 * (j + 1) : 0)) * rate);
      if (i < n) d[i] += (rnd() < 0.5 ? -1 : 1) * 0.6 * Math.pow(0.75, j);
    });
    out.push(d);
  }
  let peak = 0;
  for (const d of out) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (const d of out) for (let i = 0; i < d.length; i++) d[i] *= 0.9 / peak;
  return out;
}

export class Acoustics {
  /** Where the ears are now (the echo follows once it has lasted HOLD) */
  room: Room = 'outdoors';
  private heard: Room | null = null; // the echo playing in this audio context
  private ctx: AudioContext | null = null;
  private wanted: Room = 'outdoors';
  private held = 0;
  private buffers = new Map<Room, AudioBuffer>();
  private cos: number;
  private sin: number;

  /**
   * `church`: the church's place (shared/church.json: origin and yaw) and its ground height; `indoorsAt`: whether a
   * spot on the map is in a house (main.ts, it changes as insides come in).
   */
  constructor(private church: { origin: number[]; yaw: number; ground: number }, private indoorsAt: (x: number, z: number) => boolean) {
    this.cos = Math.cos(church.yaw);
    this.sin = Math.sin(church.yaw);
    sound.setIndoorSpot((x, y, z) => this.indoorsAt(x, z) || this.inTower(x, y, z) !== null);
  }

  /** In the church's tower (its doorway and the stair's shaft): 'church' at its foot, 'tower' up the stair; else null. */
  inTower(x: number, y: number, z: number): 'church' | 'tower' | null {
    const dx = x - this.church.origin[0];
    const dz = z - this.church.origin[1];
    // The inverse of shared/church.mjs point(): local x along the nave, north across it.
    const lx = this.cos * dx - this.sin * dz;
    const north = -this.sin * dx - this.cos * dz;
    const ly = y - this.church.ground;
    if (lx < -18.65 || lx > -13.9 || Math.abs(north) > 2.02 || ly < 0 || ly > 15.4) return null;
    return ly < 3.2 ? 'church' : 'tower';
  }

  /**
   * Each frame: `indoors` as the HUD has it (in a house's rooms or on stairs), `surface` what you stand on (a roof
   * named after its floor, "1st floor roof", counts as out of doors here), `ear` the camera.
   */
  update(dt: number, indoors: boolean, surface: string | undefined, ear: { x: number; y: number; z: number }): void {
    const inRoom = indoors && !/roof/i.test(surface ?? '');
    const place: Room = this.inTower(ear.x, ear.y, ear.z) ?? (inRoom ? 'room' : 'outdoors');
    if (place !== this.wanted) {
      this.wanted = place;
      this.held = 0;
    }
    this.held += dt;
    if (this.held >= HOLD) this.room = this.wanted;
    // Only once a click has let sound play (the context made before that stays shut).
    if (!sound.enabled || !(navigator.userActivation?.hasBeenActive ?? true)) return;
    const c = sound.context();
    if (!c) return;
    if (c !== this.ctx) {
      this.ctx = c;
      this.heard = null;
      this.buffers.clear();
    }
    if (this.room === this.heard) return;
    const room = (this.heard = this.room);
    const p = room === 'outdoors' ? null : PRESETS[room];
    sound.echo(room !== 'outdoors' ? this.buffer(c, room) : null, p?.wet ?? 0, FADE);
    sound.muffle(p?.muffle ?? 0);
    if (import.meta.env.DEV) console.debug(`[acoustics] ${this.room}`);
  }

  /** The room's impulse response for this context, made the first time it is needed. */
  private buffer(c: BaseAudioContext, room: Exclude<Room, 'outdoors'>): AudioBuffer {
    let b = this.buffers.get(room);
    if (!b) {
      const p = PRESETS[room];
      const data = impulse(c.sampleRate, PHONE ? p.phone : p.seconds, p.damp, PHONE ? 1 : 2, p.pre, p.early);
      b = c.createBuffer(data.length, data[0].length, c.sampleRate);
      data.forEach((d, ch) => b!.copyToChannel(d, ch));
      this.buffers.set(room, b);
    }
    return b;
  }
}

/** Set by main.ts once the world is in; world/bells.ts asks it where the ears are. */
export const acoustics: { now: Acoustics | null } = { now: null };
