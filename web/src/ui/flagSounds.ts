/**
 * Steal the flag's event sounds (ui/flagHud.ts plays them), made in code like every sound in the game: two families a
 * child tells apart without looking (Yoshi, 21 Nov 2026: what happens should be heard from your own side).
 *
 * - Good for your team: a short bright fanfare. Rising major steps (C, E, G, C) in a soft brass voice: two saws a hair
 *   apart through a low-pass, a quick attack.
 * - Bad for your team: a two-tone alarm. A falling fourth (A4 to E4, the old two-tone horn's interval) going back and
 *   forth, in a dull reed voice (a square through a low low-pass), a slower attack. Mid-range and soft: not shrill, not
 *   frightening; never looping.
 *
 * Inside each family every event keeps its own length and rhythm: taken (two notes, or the alarm twice), dropped (short),
 * home again (three), scored (the longest, with a held end). Under two seconds each. Watching (no team): the fanfares.
 * Works on any BaseAudioContext, so an OfflineAudioContext renders the same sounds for a check without ears.
 */

export type FlagSoundEvent = 'taken' | 'dropped' | 'returned' | 'safe' | 'captured';

/** [frequency (Hz), start (s), length (s), loudness (0..1 of the family's peak)] */
type Note = [number, number, number, number];

const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, E6 = 1318.5, G4 = 392;
const A4 = 440, E4 = 329.63, D4 = 293.66, A3 = 220, C4 = 261.63;

/** The fanfare for each event: good news for your team. */
const FANFARE: Record<FlagSoundEvent, Note[]> = {
  taken: [[G4, 0, 0.12, 0.8], [C5, 0.12, 0.34, 1]], // da-DAA
  dropped: [[E5, 0, 0.08, 0.7], [E5, 0.1, 0.08, 0.7], [G5, 0.2, 0.22, 0.85]], // ta-ta-TAA, quick
  returned: [[C5, 0, 0.1, 0.7], [E5, 0.1, 0.1, 0.75], [G5, 0.2, 0.32, 0.85]], // up the chord
  safe: [[C5, 0, 0.1, 0.7], [E5, 0.1, 0.1, 0.75], [G5, 0.2, 0.32, 0.85]],
  captured: [[C5, 0, 0.12, 0.8], [E5, 0.13, 0.12, 0.85], [G5, 0.26, 0.12, 0.9], [C6, 0.4, 0.7, 1], [G5, 0.4, 0.7, 0.55], [E6, 0.4, 0.7, 0.4]],
};

/** The two-tone alarm for each event: bad news for your team. */
const ALARM: Record<FlagSoundEvent, Note[]> = {
  taken: [[A4, 0, 0.2, 1], [E4, 0.21, 0.2, 1], [A4, 0.42, 0.2, 1], [E4, 0.63, 0.26, 1]], // the alarm twice: your flag is gone
  dropped: [[A4, 0, 0.16, 0.75], [E4, 0.17, 0.24, 0.75]], // once, short
  returned: [[E4, 0, 0.22, 0.8], [A3, 0.23, 0.36, 0.8]], // once, lower and slower
  safe: [[E4, 0, 0.22, 0.8], [A3, 0.23, 0.36, 0.8]],
  captured: [[A4, 0, 0.2, 1], [E4, 0.21, 0.2, 1], [A4, 0.42, 0.2, 1], [D4, 0.63, 0.2, 1], [C4, 0.84, 0.5, 1]], // and down at the end
};

/**
 * Peak loudness of each family's voice, beside the game's other short cues (the bazooka's clack 0.25, the calls these
 * replace 0.2): rendered, they sit 0 to 5 dB above those calls on average (they hold their notes) and within 2 dB of
 * them at the peak (the capture's fanfare the loudest, the alarms 6 to 9 dB under it at the peak).
 */
const FANFARE_PEAK = 0.08; // two saws together
const ALARM_PEAK = 0.08;

/**
 * Plays the event's sound into `out` from `t0` (seconds on `ctx`'s clock): the fanfare when `good`, the alarm when not.
 * Returns its length in seconds.
 */
export function playFlagSound(ctx: BaseAudioContext, out: AudioNode, t0: number, ev: FlagSoundEvent, good: boolean): number {
  const notes = (good ? FANFARE : ALARM)[ev] ?? FANFARE.taken;
  let end = 0;
  for (const [f, at, len, level] of notes) {
    const start = t0 + at;
    const stop = start + len;
    end = Math.max(end, at + len + 0.08);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    const g = ctx.createGain();
    const peak = (good ? FANFARE_PEAK : ALARM_PEAK) * level;
    const attack = good ? 0.012 : 0.03;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    g.gain.setValueAtTime(peak, Math.max(start + attack, stop - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0001, stop + 0.06);
    lp.connect(g).connect(out);
    if (good) {
      // Brass: the filter opens with the note and settles, as a horn's tone brightens and eases.
      lp.frequency.setValueAtTime(f * 2, start);
      lp.frequency.exponentialRampToValueAtTime(Math.min(5200, f * 4.5), start + 0.04);
      lp.frequency.exponentialRampToValueAtTime(Math.min(3600, f * 3), start + Math.min(0.2, len));
      for (const cents of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f, start);
        o.detune.setValueAtTime(cents, start);
        o.connect(lp);
        o.start(start);
        o.stop(stop + 0.08);
      }
    } else {
      // Reed: a square kept dull (its edge filtered off), a slight sag in pitch at each tone's end.
      lp.frequency.setValueAtTime(Math.min(1400, f * 3), start);
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(f, start);
      o.frequency.setValueAtTime(f, Math.max(start, stop - 0.05));
      o.frequency.linearRampToValueAtTime(f * 0.97, stop + 0.06);
      o.connect(lp);
      o.start(start);
      o.stop(stop + 0.08);
    }
  }
  return end;
}
