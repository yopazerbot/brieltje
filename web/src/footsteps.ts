import { sound } from './sound';

/**
 * Footsteps made in code: a short burst of filtered noise (plus a low thump
 * on wood and tiles) that sounds different per floor. Your own steps play
 * from the middle; other players' steps come from where they walk.
 *
 * In a pond or ditch (world/water.ts) a step is a splash instead: a slosh of noise falling in pitch and a
 * few drips after it; afloat, a softer swish for each stroke.
 */

export type Surface = 'wood' | 'tile' | 'stone' | 'grass' | 'metal' | 'water' | 'swim';

const BY_MATERIAL: Record<string, Surface> = {
  floor_wood: 'wood', oak: 'wood', walnut: 'wood', stair: 'wood', cladding: 'wood',
  floor_tile: 'tile', floor_bath: 'tile', terrazzo: 'tile', rust_tile: 'tile', pink_tile: 'tile',
  ceramic: 'tile', stone: 'tile', pink: 'tile', terracotta: 'tile',
  concrete: 'stone', terrace: 'stone', paving: 'stone', roof: 'stone', road: 'stone', old_stone: 'stone', old_floor: 'tile', old_wood: 'wood',
  pave_light: 'stone', pave_warm: 'stone', pave_grey: 'stone', gravel: 'grass', track: 'grass', pool_water: 'tile',
  field_soil: 'grass', field_dark: 'grass', field_crop: 'grass', forest: 'grass',
  steel: 'metal', rail: 'metal', alu: 'metal', alu_out: 'metal', alu_in: 'metal', hedge: 'grass', nb_hedge: 'grass',
  water: 'water', swim: 'swim',
};

/** The floor you stand on, from its material (no material: the garden). */
export function surfaceOf(material?: string): Surface {
  if (!material) return 'grass';
  return BY_MATERIAL[material] ?? 'stone';
}

interface Voice {
  type: BiquadFilterType;
  freq: number;
  q: number;
  len: number;
  gain: number;
  thump?: number;
}

const VOICES: Record<Surface, Voice> = {
  wood: { type: 'lowpass', freq: 1100, q: 0.8, len: 0.09, gain: 0.5, thump: 85 },
  tile: { type: 'bandpass', freq: 2600, q: 1.4, len: 0.05, gain: 0.55, thump: 140 },
  stone: { type: 'bandpass', freq: 1500, q: 0.6, len: 0.08, gain: 0.45 },
  grass: { type: 'bandpass', freq: 900, q: 0.5, len: 0.16, gain: 0.35 },
  metal: { type: 'bandpass', freq: 3200, q: 6, len: 0.14, gain: 0.35, thump: 220 },
  water: { type: 'bandpass', freq: 1100, q: 0.9, len: 0.22, gain: 0.5 },
  swim: { type: 'lowpass', freq: 650, q: 0.7, len: 0.42, gain: 0.32 },
};

let noise: AudioBuffer | null = null;

/** A drop falling back into the water at `t`: a sine blip rising quickly in pitch, as a drip does. */
function drip(ctx: AudioContext, dest: AudioNode, t: number, peak: number): void {
  const o = ctx.createOscillator();
  const f = 900 + Math.random() * 1400;
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.03);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.06);
}

/** One step on `surface` at `volume` (0..1); `at` places it in the world. */
export function footstep(surface: Surface, volume: number, at?: { x: number; y: number; z: number }): void {
  const ctx = sound.context();
  if (!ctx) return;
  const dest = at ? sound.at(at.x, at.y, at.z, 1.5) : sound.out();
  if (!dest) return;
  if (!noise || noise.sampleRate !== ctx.sampleRate) {
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const v = VOICES[surface];
  const t = ctx.currentTime;
  const vary = 0.85 + Math.random() * 0.3;
  const len = v.len * vary;
  const peak = Math.max(0.0002, v.gain * volume);

  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = v.type;
  filter.frequency.value = v.freq * vary;
  filter.Q.value = v.q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(filter).connect(g).connect(dest);
  src.start(t, Math.random() * 0.8, len + 0.05);
  if (surface === 'water' || surface === 'swim') {
    // The slosh falls in pitch as the water closes; then a few drips (short blips), fewer afloat.
    filter.frequency.exponentialRampToValueAtTime(v.freq * vary * 0.45, t + len);
    const drips = surface === 'water' ? 2 + Math.floor(Math.random() * 3) : 1;
    for (let i = 0; i < drips; i++) drip(ctx, dest, t + 0.06 + Math.random() * 0.25, peak * (0.25 + Math.random() * 0.3));
  }

  if (v.thump) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(v.thump * vary, t);
    o.frequency.exponentialRampToValueAtTime(v.thump * 0.6, t + len);
    const og = ctx.createGain();
    og.gain.setValueAtTime(peak * 0.6, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + len + 0.02);
  }
}
