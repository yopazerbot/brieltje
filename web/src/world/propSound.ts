import { sound } from '../sound';

/**
 * The street's loose things knocked about (world/looseProps.ts), made in code like the footsteps
 * (src/footsteps.ts): a hollow plastic bonk for a wheelie bin, a clank for a bike, a wooden knock for
 * a garden chair, and a steel post's twang that rings on as it wobbles. Each from where it happens;
 * `strength` about the speed of the knock (m/s).
 */

export type Knock = 'plastic' | 'metal' | 'wood' | 'post';

let noise: AudioBuffer | null = null;
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise?.sampleRate === c.sampleRate) return noise;
  noise = c.createBuffer(1, c.sampleRate / 2, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

/** A short burst of noise through a band at `freq`, `len` seconds, from `dest`. */
function burst(c: AudioContext, dest: AudioNode, t: number, freq: number, q: number, gain: number, len: number): void {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0005, t + len);
  src.connect(band).connect(g).connect(dest);
  src.start(t, Math.random() * 0.3);
  src.stop(t + len + 0.02);
}

/** A tone that falls a little, `len` seconds. */
function tone(c: AudioContext, dest: AudioNode, t: number, type: OscillatorType, freq: number, gain: number, len: number, fall = 0.85): void {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(freq * fall, t + len);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + len + 0.02);
}

export function knock(kind: Knock, x: number, y: number, z: number, strength: number): void {
  const c = sound.context();
  const dest = c && sound.at(x, y, z, 3);
  if (!c || !dest || !(strength > 0.3)) return;
  const t = c.currentTime;
  const loud = Math.min(1, strength / 7);
  const pitch = 0.9 + Math.random() * 0.2;
  switch (kind) {
    case 'plastic':
      // A hollow box of plastic: a low body and a dull rattle of its lid.
      tone(c, dest, t, 'sine', 125 * pitch, 0.45 * loud, 0.22, 0.7);
      burst(c, dest, t, 380 * pitch, 2.2, 0.5 * loud, 0.14);
      if (loud > 0.4) burst(c, dest, t + 0.05 + Math.random() * 0.04, 900 * pitch, 3, 0.18 * loud, 0.07);
      break;
    case 'metal':
      // Tubes and spokes: a clank of a few partials that don't fit together, and a rattle.
      for (const [f, g, l] of [[420, 0.12, 0.25], [1130, 0.07, 0.18], [2370, 0.04, 0.12]]) tone(c, dest, t, 'triangle', f * pitch, g * loud, l, 0.97);
      burst(c, dest, t, 2600, 1.5, 0.25 * loud, 0.09);
      break;
    case 'wood':
      tone(c, dest, t, 'triangle', 240 * pitch, 0.3 * loud, 0.09, 0.8);
      burst(c, dest, t, 1100 * pitch, 4, 0.3 * loud, 0.06);
      break;
    case 'post': {
      // A steel post struck: a knock, and a ring that wavers as it sways.
      burst(c, dest, t, 1800, 1.2, 0.35 * loud, 0.05);
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = 310 * pitch;
      const wobble = c.createOscillator();
      wobble.frequency.value = 2.2 + Math.random();
      const depth = c.createGain();
      depth.gain.value = 9;
      wobble.connect(depth).connect(o.frequency);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16 * loud, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(dest);
      for (const s of [o, wobble]) {
        s.start(t);
        s.stop(t + 0.95);
      }
      tone(c, dest, t, 'triangle', 870 * pitch, 0.05 * loud, 0.4, 0.99);
      break;
    }
  }
}
