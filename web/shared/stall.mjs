// The stall in the Zombies game: coins for every zombie you put down, a bonus when a wave is beaten,
// and six things to buy with them in the break between waves. Shared by the server (which keeps the
// coins together) and the page (which keeps them alone): plain objects and plain functions, no
// three.js, no network.
//
// - Coins go to whoever lands the last hit (as the kill count does): STALL.kill for a walker, a
//   runner, a big one. A player holds STALL.max at most.
// - When a wave is beaten, everyone who fights gets STALL.bonus + STALL.bonusStep per wave, at most
//   STALL.bonusMax; whoever is down gets STALL.downShare of it, rounded down.
// - STALL.items: what is sold, in the card's order, with its first price and how much each next one
//   of that thing costs more, STALL.steps times at most. A purchase hands over the same thing, with
//   the same refusals, as picking that reward up (Loot.give); a refused one costs nothing.
// - Buying is possible in the break only.
//
// The page sends only which thing it wants; the coins, the prices and the counts are kept here.

import { BIG, RUNNER } from './zombies.mjs';

export const STALL = Object.freeze({
  /** Coins for a beaten walker, runner and big one */
  kill: Object.freeze({ walker: 10, runner: 15, big: 100 }),
  /** Wave bonus: this, plus bonusStep per wave, bonusMax at most; whoever is down gets downShare of it */
  bonus: 20,
  bonusStep: 5,
  bonusMax: 100,
  downShare: 0.5,
  /** Coins a player holds at most */
  max: 99999,
  /** A price rises this many times at most */
  steps: 20,
  /** [Loot kind, first price, each next one costs this much more], in the card's order */
  items: Object.freeze([
    Object.freeze(['medkit', 100, 50]),
    Object.freeze(['nades', 120, 40]),
    Object.freeze(['claymore', 150, 50]),
    Object.freeze(['armor', 200, 100]),
    Object.freeze(['gun', 300, 150]),
    Object.freeze(['turret', 600, 300]),
  ]),
});

/** kind -> its index in STALL.items. A Map, so a page's string ('__proto__', 'constructor') finds nothing. */
const INDEX = new Map(STALL.items.map(([kind], i) => [kind, i]));

/** Whether `kind` is one of the things sold. */
export const sold = (kind) => typeof kind === 'string' && INDEX.has(kind);

/** The price of `kind` after `bought` purchases of it; 0 for something not sold. */
export function priceOf(kind, bought) {
  if (!sold(kind)) return 0;
  const [, price, step] = STALL.items[INDEX.get(kind)];
  const n = Number.isSafeInteger(bought) && bought > 0 ? Math.min(bought, STALL.steps) : 0;
  return price + step * n;
}

/** The bonus for beating wave `wave` (standing); 0 unless it is a whole number of 1 or more. */
export function bonusOf(wave) {
  if (!Number.isSafeInteger(wave) || wave < 1) return 0;
  return Math.min(STALL.bonusMax, STALL.bonus + STALL.bonusStep * wave);
}

export class Stall {
  constructor() {
    /** Player name -> coins */
    this.coins = new Map();
    /** Player name -> purchases of each thing, in STALL.items order */
    this.bought = new Map();
  }

  /** Coins of `name` (0 for someone new). */
  of(name) {
    return this.coins.get(name) ?? 0;
  }

  add(name, n) {
    this.coins.set(name, Math.min(STALL.max, this.of(name) + n));
  }

  /** `name` beat a zombie of `zombieKind`: its coins. Returns their new balance. */
  earn(name, zombieKind) {
    const k = STALL.kill;
    this.add(name, zombieKind === BIG ? k.big : zombieKind === RUNNER ? k.runner : k.walker);
    return this.of(name);
  }

  /**
   * Wave `wave` is beaten: the bonus to every name in `standing`, and the down share to every name in
   * `down` (once a name, standing first). Returns name -> what each got, for their chat line.
   */
  cleared(standing, down, wave) {
    const full = bonusOf(wave);
    const out = new Map();
    if (!full) return out;
    const half = Math.floor(full * STALL.downShare);
    for (const [names, n] of [[standing, full], [down, half]]) {
      for (const name of names ?? []) {
        if (typeof name !== 'string' || out.has(name)) continue;
        out.set(name, n);
        if (n > 0) this.add(name, n);
      }
    }
    return out;
  }

  /** `name`'s coins and purchases are gone (another session took the name). */
  forget(name) {
    this.coins.delete(name);
    this.bought.delete(name);
  }

  /** What `name`'s own page is told: { c: coins, n: purchases of each thing }. */
  view(name) {
    return { c: this.of(name), n: [...(this.bought.get(name) ?? STALL.items.map(() => 0))] };
  }

  /**
   * `name`, at `p` (as for Loot.take: position, weapon, health, guns), buys one `kind` in game phase
   * `phase`. One synchronous call: nothing is charged before the thing was given. Returns { got, price }
   * or { why }: 'kind' (not sold), 'shut' (not the break), 'short' (too few coins), 'full' (nothing in
   * it for them now).
   */
  buy(loot, name, p, kind, phase, now) {
    if (!sold(kind)) return { why: 'kind' };
    if (phase !== 'break') return { why: 'shut' };
    const i = INDEX.get(kind);
    const counts = this.bought.get(name) ?? STALL.items.map(() => 0);
    const price = priceOf(kind, counts[i]);
    if (!(this.of(name) >= price)) return { why: 'short' };
    const got = loot.give(name, p, kind, now);
    if (!got) return { why: 'full' };
    this.coins.set(name, this.of(name) - price);
    counts[i]++;
    this.bought.set(name, counts);
    return { got, price };
  }
}
