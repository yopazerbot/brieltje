import type { Horde, HordeEvent } from '../../shared/zombies.mjs';

/**
 * Alone, the admin's wave picker (the menu's admin tab, src/ui/zombieWave.ts): the horde in this page jumps
 * to the chosen wave, as the server's `zwave` does together (server/zombies.mjs selectWave). A chosen wave
 * makes the run custom, and a custom run never counts for the best wave kept in this browser: the same rule
 * as together, where a chosen wave never sets a record or reaches the board.
 */
export interface SoloRun {
  horde: Pick<Horde, 'selectWave'>;
  /** A wave was chosen in this run: it can't be a best. */
  custom: boolean;
  /** The best wave alone at this place so far. */
  best: number;
}

/** Jump `run` to wave `wave` (alone: one player). The horde's events (the old zombies gone, the wave begun), or null when refused. */
export function chooseSoloWave(run: SoloRun, wave: number, now: number): HordeEvent[] | null {
  const events = run.horde.selectWave(now, wave, 1);
  if (events) run.custom = true;
  return events;
}

/** Whether a run that ended at `wave` is a new best alone: never a run with a chosen wave. */
export function soloRecord(run: SoloRun, wave: number): boolean {
  return !run.custom && wave > run.best;
}
