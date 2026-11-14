import { priceOf, STALL, type StallKind, type StallView } from '../../shared/stall.mjs';
import { onLang, t } from '../i18n';
import { paintball } from '../paintball';
import { key, type Control } from '../shortcuts';
import './stall.css';

/**
 * The coins in the Zombies game (shared/stall.mjs): a small chip above your health with your coins, and in the
 * break that the stall is open. Buying is at the stall in the world (world/stall.ts): walk up, face a thing on its
 * table, and the prompt line names it and its price (line); Use buys it (main.ts). No card, no key of its own.
 * It builds its own chip (no markup in index.html) and writes every text with textContent. The coins and the
 * counts bought come from the server (zcoins; alone from the page's own Stall) and are checked before use; the
 * prices are worked out here from the shared table, for show only: the server charges its own.
 */

const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const INDEX = new Map(STALL.items.map(([kind], i) => [kind, i]));

export class StallChip {
  private have = 0;
  private counts: number[] = STALL.items.map(() => 0);
  private on = false;
  private brk = false;
  private shown = '';
  private chip = document.createElement('div');

  constructor() {
    const c = this.chip;
    c.id = 'stall-chip';
    c.hidden = true;
    document.body.append(c);
    onLang(() => {
      this.shown = '';
      this.paint();
    });
  }

  /** Your coins and what you bought ({ c, n }, from zcoins or the page's own Stall): taken only when both are whole numbers of 0 or more. */
  set(v: Partial<StallView> | { c?: unknown; n?: unknown }): void {
    const n: unknown = v.n;
    if (!count(v.c) || !Array.isArray(n) || n.length > STALL.items.length || !n.every(count)) return;
    this.have = v.c;
    this.counts = STALL.items.map((_, i) => (n[i] as number | undefined) ?? 0);
    this.paint();
  }

  /** Every frame: the chip while Zombies is on (`on`), saying the stall is open in the break (`brk`). */
  update(s: { on: boolean; brk: boolean }): void {
    this.on = s.on;
    this.brk = s.brk;
    this.paint();
  }

  /** The menu or the big map is up: the chip goes until the game is back (update). */
  hide(): void {
    this.on = false;
    this.paint();
  }

  /** Your coins, as last told. */
  get coins(): number {
    return this.have;
  }

  /** What `kind` costs you now (your own purchases of it counted). */
  price(kind: StallKind): number {
    return priceOf(kind, this.counts[INDEX.get(kind) ?? 0]);
  }

  /** The prompt line for the thing you face on the stall's table: with the Use key, or that you have too few coins. */
  line(kind: StallKind, mode: Control): string {
    const thing = t(({
      medkit: 'loot.medkit',
      nades: paintball.on ? 'loot.nadesPaint' : 'loot.nades',
      claymore: paintball.on ? 'loot.paintMine' : 'loot.claymore',
      armor: 'loot.armor',
      gun: 'loot.gun',
      turret: 'loot.turret',
    } as const)[kind]);
    const n = this.price(kind);
    return this.have >= n ? t('prompt.stall', { use: key('use', mode), thing, n }) : t('prompt.stallShort', { thing, n, c: this.have });
  }

  private paint(): void {
    if (this.chip.hidden === this.on) this.chip.hidden = !this.on;
    if (!this.on) return;
    const text = t(this.brk ? 'stall.open' : 'stall.coins', { n: this.have });
    if (text === this.shown) return;
    this.chip.textContent = this.shown = text;
    this.chip.classList.toggle('open', this.brk);
  }
}
