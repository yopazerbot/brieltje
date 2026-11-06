import { HOMES, homeOfDoor, makePaneHomes } from '../../shared/homes.mjs';
import { t } from '../i18n';

/**
 * The page's side of the three homes that open only with a code (shared/homes.mjs, server/homes.mjs): the main house,
 * the bungalow and the end house at Molenhoek. A home is locked on every page load, alone and together, until its code
 * is typed here (or the player is the admin). While locked:
 * - its doors stay shut and Use at one asks for the code (src/ui/homeCode.ts);
 * - its panes cannot be broken by this player;
 * - a barrier the shape of its inside keeps this player from walking in (an open door left by somebody else is no way
 *   in). The game server holds the same line (server/homeGate.mjs), so a changed page gains nothing.
 *
 * The code goes to the server and is not kept. Together, the server remembers who typed it (that session, 8 hours);
 * this page's own unlocked state follows what the server says (`homelock`), and starts again with a new session.
 */
export interface LockDeps {
  /** Put one of a home's walking barriers (a ring for the heights `y0` to `y1`, one for each floor) up, or down (null) */
  barrier: (key: string, ring: [number, number][] | null, y0: number, y1: number) => void;
  /** A lock changed: the doors follow (outside doors of locked homes shut) */
  changed: () => void;
  /** A home was locked again: whoever stands inside is put out (a barrier alone would leave them in the wall) */
  relocked: () => void;
}

export class HomeLocks {
  private open = new Set<string>();
  private admin = false;
  private paneHome: (i: number) => string | null;
  private prisms: Parameters<typeof makePaneHomes>[0]['prisms'];
  private doors: Parameters<typeof makePaneHomes>[0]['doors'];

  constructor(private deps: LockDeps, prisms: Parameters<typeof makePaneHomes>[0]['prisms'], doors: Parameters<typeof makePaneHomes>[0]['doors']) {
    this.prisms = prisms;
    this.doors = doors;
    this.paneHome = makePaneHomes({ prisms, doors });
    this.sync();
  }

  /** An inside's blocks and doors have come: its panes and doors belong to the home too (shared/homes.mjs). */
  addData(prisms: Parameters<typeof makePaneHomes>[0]['prisms'], doors: Parameters<typeof makePaneHomes>[0]['doors']): void {
    this.prisms = [...this.prisms, ...prisms];
    this.doors = [...this.doors, ...doors];
    this.paneHome = makePaneHomes({ prisms: this.prisms, doors: this.doors });
  }

  /**
   * The home's code was right and the answer carried its inside (`pack`, see world/insides.ts), or the page is the
   * admin's, or the server said this session has the right: set by main.ts, which installs the inside.
   */
  onOpen: (id: string, pack: unknown) => void = () => {};

  /** May this player use home `id`? */
  isOpen(id: string): boolean {
    return this.admin || this.open.has(id);
  }

  /** The home whose lock holds door `id` shut, or null (open, or no home's door). */
  lockedOfDoor(doorId: string): string | null {
    const home = homeOfDoor(doorId);
    return home && !this.isOpen(home) ? home : null;
  }

  /** The home a pane belongs to (null: no home's), and whether that home is locked for this player. */
  homeOfPane(i: number): string | null {
    return this.paneHome(i);
  }

  /** The admin needs no codes. */
  setAdmin(on: boolean): void {
    if (this.admin === on) return;
    this.admin = on;
    this.sync();
    if (!on) this.deps.relocked();
    else for (const h of HOMES) this.onOpen(h.id, null); // the admin sees every inside
  }

  /** The code typed at a locked home: the reason it failed, or '' when the home is open now. */
  async unlock(id: string, code: string): Promise<string> {
    let r: Response;
    try {
      r = await fetch('/api/home/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, code }) });
    } catch {
      return t('home.error');
    }
    if (!r.ok) return t(r.status === 403 ? 'home.wrong' : r.status === 429 ? 'home.slow' : 'home.error');
    this.open.add(id);
    this.sync();
    const answer = (await r.json().catch(() => null)) as { inside?: unknown } | null;
    this.onOpen(id, answer?.inside ?? null); // the right code brings the home's inside with it
    return '';
  }

  /** The server says these homes are open to this session (its welcome): a rejoin keeps what was typed. */
  grant(ids: string[]): void {
    let any = false;
    const added: string[] = [];
    for (const h of HOMES) if (ids.includes(h.id) && !this.open.has(h.id)) (this.open.add(h.id), added.push(h.id), (any = true));
    if (any) this.sync();
    for (const id of added) this.onOpen(id, null); // the page fetches the inside itself
  }

  /** Every home shut again (a new session: the server has no grant for it). */
  lockAll(): void {
    if (!this.open.size) return;
    this.open.clear();
    this.sync();
    this.deps.relocked();
  }

  /** One home shut again (the server says this player has no right to it any more). */
  lock(id: string): void {
    if (!this.open.delete(id)) return;
    this.sync();
    this.deps.relocked();
  }

  private sync(): void {
    for (const h of HOMES) h.bands.forEach((b, i) => this.deps.barrier(`${h.id}-${i}`, this.isOpen(h.id) ? null : b.ring, b.y0, b.y1));
    this.deps.changed();
  }
}
