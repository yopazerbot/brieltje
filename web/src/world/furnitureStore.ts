/**
 * The furniture played alone, and what of it this browser keeps (localStorage briel.furnitureAlone).
 *
 * The insides of the three code-locked homes are sealed: the server hands one out only after its code, and a home's
 * starting furniture comes with it (shared/homes.mjs, server/homes.mjs, src/world/insides.ts). So nothing of an inside
 * is ever written to the browser's storage, where the next person on a shared laptop or iPad could read it:
 * - a home's starting pieces, wherever they stand (some stand on a terrace or in the garden, outside the home's
 *   rooms), and any piece inside a home (shared/homes.mjs homeAt) are kept in memory for this visit only;
 * - the stored list holds only the other pieces, the ones a player put elsewhere (a chair on the church square);
 * - a home's starting pieces go in once a visit, when its inside comes while playing alone;
 * - `scrubFurniture` cleans the storage: at every page load and whenever the session ends (src/start.ts: a logout,
 *   the pending logout's later finish, a session ended elsewhere). A list from before this rule (briel.furniture,
 *   which held the starting pieces too) is moved over only if nothing shows it ever held an inside, else removed whole,
 *   with the old per-home restore numbers.
 *
 * What a player loses: furniture moved, added or taken away inside one of those homes (or a starting piece moved
 * about) while playing alone lasts for that visit; the next visit starts from the home's starting layout again.
 * Together the server keeps the furniture, as before.
 *
 * Only shared/homes.mjs is imported (no three.js), so the start screen can clean the storage before the world exists.
 */
import { homeAt } from '../../shared/homes.mjs';
import type { Piece } from './furnishing';

const KEY = 'briel.furnitureAlone';
/** From before: the list with the starting pieces in it, and each home's "restore" number of its layout. */
const OLD_KEY = 'briel.furniture';
const RESTORE_KEY = 'briel.furnitureRestore';

/** A home's starting furniture as its inside brings it (src/world/insides.ts layout). */
export interface Layout {
  id: string;
  pieces: readonly (readonly [string, number, number, number, number])[];
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
function valid(v: unknown): Piece | null {
  const p = v as Piece | null;
  if (!p || typeof p !== 'object' || !finite(p.id) || typeof p.item !== 'string' || ![p.x, p.y, p.z, p.yaw].every(finite)) return null;
  return { id: p.id, item: p.item, x: p.x, y: p.y, z: p.z, yaw: p.yaw };
}
/** The piece stands inside one of the code-locked homes. */
const inHome = (p: Pick<Piece, 'x' | 'y' | 'z'>): boolean => homeAt(p.x, p.z, p.y) !== null;
/** A stored list's pieces, or null (none, or unreadable). */
function parse(raw: string | null): Piece[] | null {
  if (raw === null) return null;
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.map(valid).filter((p): p is Piece => !!p) : null;
  } catch {
    return null;
  }
}

/** Take everything of the homes' insides out of this browser's storage. Safe to call any time. */
export function scrubFurniture(): void {
  try {
    const restoreKeys = Object.keys(localStorage).filter((k) => k === RESTORE_KEY || k.startsWith(`${RESTORE_KEY}.`));
    const old = parse(localStorage.getItem(OLD_KEY));
    // Moved over only when nothing shows a home's starting pieces ever went in (they bring the restore numbers, and
    // most of them stand inside the home); else the whole list goes, as its starting pieces outside can't be told apart.
    if (old && !restoreKeys.length && !old.some(inHome) && localStorage.getItem(KEY) === null) localStorage.setItem(KEY, JSON.stringify(old));
    localStorage.removeItem(OLD_KEY);
    for (const k of restoreKeys) localStorage.removeItem(k);
    const raw = localStorage.getItem(KEY);
    const list = parse(raw);
    if (raw !== null && !list) localStorage.removeItem(KEY);
    else if (list && list.some(inHome)) localStorage.setItem(KEY, JSON.stringify(list.filter((p) => !inHome(p))));
  } catch {
    // storage blocked: nothing stored
  }
}

/** The furniture played alone: the stored pieces, and this visit's of the homes (memory only). */
export class AloneFurniture {
  /** This visit only: pieces inside a home, and the homes' starting pieces wherever they stand */
  private kept: Piece[] = [];
  private fromLayout = new Set<number>();
  private seeded = new Set<string>();

  /** The pieces to play alone with, the starting pieces of `layouts` (the homes open now) in once a visit. */
  load(layouts: Layout[]): Piece[] {
    const stored = (parse(this.read()) ?? []).filter((p) => !inHome(p));
    this.seed([...stored, ...this.kept], layouts);
    return [...stored, ...this.kept];
  }

  /** Home `id`'s inside came while playing alone: its starting pieces, once a visit. `now`: the pieces now. Null: no change. */
  seedHome(id: string, layouts: Layout[], now: Piece[]): Piece[] | null {
    const mine = layouts.filter((l) => l.id === id && !this.seeded.has(l.id) && l.pieces.length);
    if (!mine.length) return null;
    this.kept = now.filter((p) => !this.storable(p));
    this.seed(now, mine);
    return [...now.filter((p) => this.storable(p)), ...this.kept];
  }

  /** The reset alone: the starting pieces of `layouts` only, nothing else. */
  reset(layouts: Layout[]): Piece[] {
    this.kept = [];
    this.fromLayout.clear();
    this.seeded.clear();
    this.seed([], layouts);
    return [...this.kept];
  }

  /** Keep `all` (alone): the pieces a player put outside the homes stored, the rest in memory. */
  save(all: Piece[]): void {
    this.kept = all.filter((p) => !this.storable(p));
    try {
      localStorage.setItem(KEY, JSON.stringify(all.filter((p) => this.storable(p)).map(valid)));
    } catch {
      // private window: the furniture lasts for this visit
    }
  }

  private storable(p: Piece): boolean {
    return !inHome(p) && !this.fromLayout.has(p.id);
  }

  private read(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  private seed(all: Piece[], layouts: Layout[]): void {
    let id = Math.min(-1, ...all.map((p) => p.id)) - 1;
    for (const l of layouts) {
      if (this.seeded.has(l.id)) continue;
      this.seeded.add(l.id);
      for (const [item, x, y, z, yaw] of l.pieces) {
        const p = { id: id--, item: String(item), x: Number(x), y: Number(y), z: Number(z), yaw: Number(yaw) };
        this.fromLayout.add(p.id);
        this.kept.push(p);
      }
    }
  }
}
