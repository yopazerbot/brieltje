/**
 * The menu's Settings page (index.html, #page-settings) shows what applies to the way you play.
 * Its rows are grouped in the HTML (Display, Sound, Weather, Moving and looking, On screen, Language
 * and keyboard); this module only reads their marks:
 *
 * - data-needs="pad" (or "pad touch"): greyed and off, with the group's line saying why, unless a
 *   controller is connected (or you play by touch). The values stay stored and work once it is.
 * - data-default on an input that src/settings.ts doesn't keep (the walking speed): Back to defaults
 *   puts it back as well. src/settings.ts puts back its own values.
 *
 * Rows only for touch, or never with touch, are left to style.css (.only-touch, .not-touch and
 * data-hide-on, from body.touch), so they follow a language change or the child-friendly words too.
 */
import type { Control } from '../shortcuts';

/** Grey the rows that need what you don't use; called when the menu opens and when a controller comes or goes. */
export function showApplicable(control: Control, padConnected: boolean): void {
  document.querySelectorAll<HTMLElement>('#page-settings [data-needs]').forEach((row) => {
    const ok = row.dataset.needs!.split(' ').some((need) => (need === 'pad' ? padConnected || control === 'pad' : need === control));
    row.classList.toggle('na', !ok);
    row.querySelectorAll<HTMLInputElement>('input').forEach((i) => (i.disabled = !ok));
  });
}

/** Back to defaults, for the inputs with a data-default (their own listeners store them). */
export function resetDefaults(): void {
  document.querySelectorAll<HTMLInputElement>('#page-settings input[data-default]').forEach((i) => {
    if (i.disabled) return; // the walking speed while playing together: the real pace holds
    i.value = i.dataset.default!;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
