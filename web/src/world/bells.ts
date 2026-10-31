import * as THREE from 'three';
import { sound } from '../sound';
import { audio } from './traffic';

/**
 * The bells of the church of Smetlede: at every full hour the hour bell strikes the hour (one to
 * twelve strokes), at the half hour a higher bell strikes once. Belgian time (Europe/Brussels) on
 * the server's shared clock, so everyone hears the same stroke; heard from the tower's belfry,
 * quieter and duller with distance (the air takes the highs first) and as late as sound travels
 * (343 m/s: about 2.5 s at our house).
 *
 * A stroke is made in code: a bell's partials (hum, prime, tierce, quint, nominal and the ones
 * above it, the hum and prime as slightly detuned pairs so they beat as a cast bell does), each
 * dying away at its own rate, and the clapper's knock.
 */

// Partials as a share of the prime: ratio, loudness, seconds to fade to about a third.
const PARTIALS: [number, number, number][] = [
  [0.5, 0.45, 5.5], [1.0, 0.55, 3.6], [1.183, 0.42, 3.0], [1.506, 0.2, 2.0], [2.0, 0.6, 2.4],
  [2.514, 0.22, 1.4], [2.662, 0.16, 1.2], [3.011, 0.16, 1.0], [4.07, 0.09, 0.7],
];
const HOUR_BELL = 196; // Hz, the prime (its strike note a G4)
const HALF_BELL = 294; // Hz (a D5)
const SPACING = 2.4; // s between strokes
const LOUD = 0.55; // at the reference distance
const HALF_HOUR = 30 * 60 * 1000;

export class Bells {
  private offset = Date.now() - performance.now(); // shared clock minus local, ms
  private slot = -1;
  private hours = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', hour: 'numeric', hourCycle: 'h23' });

  /** `belfry`: where the sound comes from (the tower's louvres). */
  constructor(private belfry: THREE.Vector3) {}

  /** Line up with the server's clock (ms since 1970). */
  setClock(serverMs: number): void {
    this.offset = serverMs - performance.now();
  }

  /** Every frame (cheap): ring when a full or half hour has just begun. `ear` is the camera. */
  update(ear: THREE.Vector3): void {
    const now = performance.now() + this.offset;
    const slot = Math.floor(now / HALF_HOUR);
    if (slot === this.slot) return;
    const first = this.slot < 0;
    this.slot = slot;
    // Not on joining, nor when the tab comes back long after the hour (Belgian hours begin on UTC's).
    if (first || now - slot * HALF_HOUR > 15000) return;
    const full = slot % 2 === 0;
    const hour = Number(this.hours.format(now)) % 12 || 12;
    this.ring(full ? hour : 1, full ? HOUR_BELL : HALF_BELL, ear);
  }

  /** Strike `count` times (also for trying it out), heard at `ear`. */
  ring(count: number, prime = HOUR_BELL, ear?: THREE.Vector3): void {
    const c = audio();
    if (!c || c.state !== 'running') return;
    const d = ear ? ear.distanceTo(this.belfry) : 50;
    // From the belfry: an own panner that carries further than the game's sounds, with the highs
    // taken off by the distance.
    const at = c.createPanner();
    at.panningModel = 'HRTF';
    at.distanceModel = 'inverse';
    at.refDistance = 25;
    at.rolloffFactor = 1;
    at.maxDistance = 5000;
    at.positionX.value = this.belfry.x;
    at.positionY.value = this.belfry.y;
    at.positionZ.value = this.belfry.z;
    const air = c.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = Math.max(1100, Math.min(16000, 16000 * Math.exp(-d / 380)));
    air.connect(at).connect(sound.out()!);
    const start = c.currentTime + 0.05 + d / 343;
    for (let k = 0; k < count; k++) this.stroke(c, air, start + k * SPACING, prime * (1 + (Math.random() - 0.5) * 0.002));
    setTimeout(() => at.disconnect(), (start - c.currentTime + count * SPACING + 8) * 1000);
  }

  private stroke(c: AudioContext, out: AudioNode, t: number, prime: number): void {
    const bus = c.createGain();
    bus.gain.value = LOUD;
    bus.connect(out);
    for (const [ratio, amp, fade] of PARTIALS) {
      // The two lowest partials as pairs a little apart: the slow beat of a real bell.
      for (const detune of ratio <= 1 ? [-0.35, 0.35] : [0]) {
        const o = c.createOscillator();
        o.frequency.value = prime * ratio + detune;
        const g = c.createGain();
        const a = amp / (ratio <= 1 ? 2 : 1);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(a, t + 0.004 + 0.01 / ratio);
        g.gain.setTargetAtTime(0.0001, t + 0.02, fade);
        o.connect(g).connect(bus);
        o.start(t);
        o.stop(t + fade * 4.5);
      }
    }
    // The clapper's knock: a short burst of noise round 2.4 kHz.
    const len = Math.floor(c.sampleRate * 0.05);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const knock = c.createBufferSource();
    knock.buffer = buf;
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400;
    band.Q.value = 1.5;
    const kg = c.createGain();
    kg.gain.value = 0.35;
    knock.connect(band).connect(kg).connect(bus);
    knock.start(t);
    setTimeout(() => bus.disconnect(), (t - c.currentTime + 25) * 1000);
  }
}
