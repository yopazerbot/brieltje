/**
 * Paintball: Action with paint guns, for everyone. Underneath it is Action (the same weapons,
 * hits, scores and server), only what you see and hear changes: bright toy markers with a paint
 * hopper, paintballs flying in an arc, a pop instead of a gunshot, paint splats that fade instead
 * of bullet holes, sparks or blood, paint balloons instead of grenades, a paint cannon instead of
 * the bazooka, and friendly words ("tagged", not "killed"). It follows your own choice of mode,
 * or the admin's "child-friendly for everyone" rule, so a child can play paintball beside others
 * in Action, each seeing their own. The modules ask `paintball.on` when they draw something and
 * listen with `onPaintball` for what is already on screen. No three.js here: the HUD's texts use it.
 */
import { t } from './i18n';

let on = false;
const listeners: ((on: boolean) => void)[] = [];

export const paintball = {
  get on(): boolean {
    return on;
  },
};

/** Switch the presentation; the page gets `paintball` on its body for the HUD's colours (style.css). */
export function setPaintball(next: boolean): void {
  if (next === on) return;
  on = next;
  document.body.classList.toggle('paintball', on);
  for (const fn of listeners) fn(on);
}

/** Call `fn` on every switch (not now: the modules read `paintball.on` when they start). */
export function onPaintball(fn: (on: boolean) => void): void {
  listeners.push(fn);
}

/** The paint colours: orange, lime, blue, purple, pink and yellow. */
export const PAINT = ['#ff7a1a', '#8fd61f', '#2f8cff', '#9d5cff', '#ff4fa3', '#ffd23f'];
/** Each gun's paint, the colour of the gun itself: orange pistol, lime rifle, blue shotgun, purple sniper, pink cannon. */
export const GUN_PAINT: Record<string, string> = { pistol: PAINT[0], rifle: PAINT[1], shotgun: PAINT[2], sniper: PAINT[3], bazooka: PAINT[4] };

/** One of the paint colours, at random. */
export function anyPaint(): string {
  return PAINT[Math.floor(Math.random() * PAINT.length)];
}

/** A weapon's name as it shows: "Pistol", or in paintball "Paint pistol". */
export function weaponName(w: 'pistol' | 'rifle' | 'shotgun' | 'sniper' | 'bazooka' | 'grenade'): string {
  return t(on ? `paint.${w}` : `weapon.${w}`);
}
