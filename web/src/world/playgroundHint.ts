import { t } from '../i18n';
import { keyName } from '../keys';
import { key, type Control } from '../shortcuts';

/**
 * The play tower's line at the bottom of the screen (world/playground.ts): at the ladder's foot how to climb it, on
 * it how to go up, down and let go. In the keys the player plays with: W and S by their place (Z and S on AZERTY),
 * the left stick on a controller, the left thumb on a phone.
 */
export function towerPrompt(hint: 'climb' | 'ladder', control: Control): string {
  const up = keyName('KeyW');
  if (hint === 'climb') return control === 'kbm' ? t('prompt.climb.kbm', { up }) : t(control === 'pad' ? 'prompt.climb.stick' : 'prompt.climb.thumb');
  const jump = key('jump', control);
  if (control === 'kbm') return t('prompt.ladder.kbm', { up, down: keyName('KeyS'), jump });
  return t(control === 'pad' ? 'prompt.ladder.stick' : 'prompt.ladder.thumb', { jump });
}
