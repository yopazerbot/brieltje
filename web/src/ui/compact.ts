/**
 * A small view: a quarter or a half of the split screen (src/seat.ts), or any small window played
 * with the keyboard and mouse or a controller. The page then carries `body.compact` and the HUD
 * takes its compact layout (style.css, "A small view"): a smaller map, the current weapon only, no
 * wordmark, credit or online list, fewer and shorter-lived chat lines, short hints, the round's
 * messages in one stack between the place line and the map. Touch controls keep their own layout
 * (phones and tablets are small too), so a page with `body.touch` is never compact.
 *
 * A window narrower than 1000 px or lower than 540 px counts as small: a 1080p screen split in two
 * (960 wide) or four (about 960 × 540, less the gaps), a laptop split in two. A laptop's whole
 * browser (1280 × 650 and up) keeps the full HUD.
 */

const MIN_WIDTH = 1000;
const MIN_HEIGHT = 540;

let small = false;
const listeners: (() => void)[] = [];

function check(): void {
  const on = !document.body.classList.contains('touch') && (innerWidth < MIN_WIDTH || innerHeight < MIN_HEIGHT);
  if (on === small) return;
  small = on;
  document.body.classList.toggle('compact', on);
  for (const l of listeners) l();
}

/** The compact HUD is on. */
export function compactHud(): boolean {
  return small;
}

/** Called each time the compact HUD comes or goes. */
export function onCompact(fn: () => void): void {
  listeners.push(fn);
}

addEventListener('resize', check);
// Touch controls come and go with the way you play (src/controls/touch.ts sets body.touch).
new MutationObserver(check).observe(document.body, { attributes: true, attributeFilter: ['class'] });
check();
