// Rewards in the Zombies game, shared by the server (which keeps them together) and the page (which
// keeps them alone): plain objects and plain functions, no three.js, no network.
//
// A beaten zombie sometimes leaves one where it fell (LOOT.chance; a runner a little more often, a
// big one always, and the wave's last one when none fell in the wave yet), glowing on the ground for
// LOOT.life ms; walk over it to take it. Drops rather than a gift each wave: the rewards are out
// among the zombies, so going for one is a choice in the fight, and who fights finds them.
//
// - A bigger ammo pack: the weapon in your hands gets magazines half as big again for the rest of
//   the game, and a full one now.
// - A scope: on the rifle and the pistol, for the rest of the game; aiming looks through it as
//   through the sniper's.
// - A claymore (in paintball a paint mine): carry up to LOOT.carry, place it in front of you on the
//   ground (hold the grenade key). Armed after LOOT.armMs, it goes off when a zombie walks into the
//   arc in front of it, and its blast beats the zombies in that arc. It never hurts a player (one team).
//   At most LOOT.placed down per player.
//
// Who has what is a kit per player name (kits), kept for the game, a dropped connection included.

import { BIG, RUNNER } from './zombies.mjs';

export const LOOT = {
  /** How often a beaten zombie leaves something: a regular one, a runner, a big one */
  chance: 0.06,
  runnerChance: 0.1,
  bigChance: 1,
  /** Which reward, by weight */
  weights: [['ammo', 0.45], ['claymore', 0.35], ['scope', 0.2]],
  /** At most this many lying at once; ms each lies before it is gone */
  lying: 6,
  life: 45000,
  /** m: how close you must stand to take one, and how far above or below it at most */
  reach: 1.3,
  rise: 1.6,
  /** The bigger ammo pack: magazines this much bigger */
  bigMag: 1.5,
  /** The guns a scope goes on */
  scoped: ['rifle', 'pistol'],
  /** Claymores: carried and placed at most, per player; placed at most this far from your feet (m), this far above or below them, and this far from another */
  carry: 2,
  placed: 2,
  placeReach: 2.4,
  placeRise: 0.8,
  apart: 1,
  /** ms after placing it can go off; m in front of it a zombie sets it off, within this cosine of straight ahead (60 degrees each side) */
  armMs: 1200,
  trigger: 2.4,
  cone: 0.5,
  /** Its blast: m in front, within this cosine (about 70 degrees each side), every zombie this close whichever side, and how much health it takes */
  blast: 4.5,
  blastCone: 0.34,
  close: 1.2,
  damage: 420,
};

const r2 = (v) => Math.round(v * 100) / 100;

export class Loot {
  /** `nav`: the zombies' grid (shared/zombies.mjs makeNav): where a claymore may stand, and what its blast can't go through. */
  constructor(nav, rand = Math.random) {
    this.nav = nav;
    this.rand = rand;
    /** id -> { id, kind, x, y, z, until } */
    this.items = new Map();
    /** id -> { id, owner, x, y, z, yaw, armedAt } */
    this.mines = new Map();
    /** Player name -> { ammo: [weapons with the bigger magazines], scope, claymores (carried) } */
    this.kits = new Map();
    this.nextId = 1;
    /** Whether something fell in this wave yet (its last zombie leaves one if not) */
    this.dropped = false;
  }

  kit(name) {
    let k = this.kits.get(name);
    if (!k) this.kits.set(name, (k = { ammo: [], scope: false, claymores: 0 }));
    return k;
  }

  /** A new wave began. */
  wave() {
    this.dropped = false;
  }

  /** Zombie `z` was beaten: what it leaves where it fell, or null. `last`: the wave's last. */
  drop(z, now, last = false) {
    if (this.items.size >= LOOT.lying) return null;
    const p = z.kind === BIG ? LOOT.bigChance : z.kind === RUNNER ? LOOT.runnerChance : LOOT.chance;
    if (!(this.rand() < p) && !(last && !this.dropped)) return null;
    let r = this.rand();
    let kind = LOOT.weights[0][0];
    for (const [k, w] of LOOT.weights) {
      if (r < w) {
        kind = k;
        break;
      }
      r -= w;
    }
    const item = { id: this.nextId++, kind, x: r2(z.x), y: r2(z.y), z: r2(z.z), until: now + LOOT.life };
    this.items.set(item.id, item);
    this.dropped = true;
    return item;
  }

  /**
   * Player `name`, standing at `p` ({ x, y, z } and `w` the weapon in hand), takes item `id`: what
   * they got ({ kind, w, kit }) or null (no such item, too far, or nothing in it for them: a second
   * scope, a claymore over what they can carry; it stays for someone else).
   */
  take(name, p, id, now) {
    const it = this.items.get(id);
    if (!it || now >= it.until) return null;
    if (Math.hypot(p.x - it.x, p.z - it.z) > LOOT.reach || Math.abs(p.y - it.y) > LOOT.rise) return null;
    const k = this.kit(name);
    if (it.kind === 'scope' && k.scope) return null;
    if (it.kind === 'claymore' && k.claymores >= LOOT.carry) return null;
    this.items.delete(id);
    if (it.kind === 'scope') k.scope = true;
    else if (it.kind === 'claymore') k.claymores++;
    else if (!k.ammo.includes(p.w)) k.ammo.push(p.w);
    return { kind: it.kind, w: it.kind === 'ammo' ? p.w : undefined, kit: k };
  }

  /**
   * Player `name`, standing at `p`, places a claymore at `at` ({ x, y, z, yaw }: facing where they
   * look). On a floor the zombies walk (not in a wall, a hedge, a car or the air) near their feet, not
   * on another one. Returns { mine } or { why }: 'none' (none carried), 'max' (LOOT.placed down
   * already) or 'spot'.
   */
  place(name, p, at, now) {
    const k = this.kit(name);
    if (k.claymores < 1) return { why: 'none' };
    let down = 0;
    for (const m of this.mines.values()) if (m.owner === name) down++;
    if (down >= LOOT.placed) return { why: 'max' };
    const { x, y, z, yaw } = at ?? {};
    if (![x, y, z, yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) return { why: 'spot' };
    if (Math.hypot(x - p.x, z - p.z) > LOOT.placeReach || Math.abs(y - p.y) > LOOT.placeRise) return { why: 'spot' };
    const node = this.nav.locate(x, y + 0.3, z, 0.1);
    if (node < 0) return { why: 'spot' };
    const fy = this.nav.y(node, x, z);
    if (Math.abs(fy - y) > 0.4) return { why: 'spot' };
    for (const m of this.mines.values()) if (Math.hypot(m.x - x, m.z - z) < LOOT.apart) return { why: 'spot' };
    k.claymores--;
    const mine = { id: this.nextId++, owner: name, x: r2(x), y: r2(fy), z: r2(z), yaw: Math.round(Math.atan2(Math.sin(yaw), Math.cos(yaw)) * 1000) / 1000, armedAt: now + LOOT.armMs };
    this.mines.set(mine.id, mine);
    return { mine };
  }

  /** Whether zombie `q` is in front of mine `m` (facing fx, fz), within `r` m and `cone`, on its floor, with nothing between. */
  inArc(m, q, fx, fz, r, cone) {
    const dx = q.x - m.x, dz = q.z - m.z;
    const d = Math.hypot(dx, dz);
    if (d - (q.kind === BIG ? 0.8 : 0.35) > r || Math.abs(q.y - m.y) > 1.2) return false;
    if (d > 0.3 && (dx * fx + dz * fz) / d < cone) return false;
    return this.nav.reach(m.x, m.y + 0.4, m.z, q.x, q.y + 0.8, q.z);
  }

  /**
   * Every tick: items lying too long go (`gone`: their ids), and every armed mine a zombie walked into
   * goes off (`booms`: { mine, ids } with the zombies its blast catches: in the arc in front of it, or
   * right next to it). The caller hurts them (LOOT.damage) and tells everyone.
   */
  tick(now, zombies) {
    const gone = [];
    for (const it of this.items.values()) if (now >= it.until) gone.push(it.id);
    for (const id of gone) this.items.delete(id);
    const booms = [];
    if (!this.mines.size) return { gone, booms };
    const up = [];
    for (const q of zombies) if (q.act !== 'down') up.push(q);
    for (const m of [...this.mines.values()]) {
      if (now < m.armedAt) continue;
      const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw); // the game's yaw: forward is -z at 0
      if (!up.some((q) => this.inArc(m, q, fx, fz, LOOT.trigger, LOOT.cone))) continue;
      const ids = up.filter((q) => this.inArc(m, q, fx, fz, LOOT.blast, LOOT.blastCone) || this.inArc(m, q, fx, fz, LOOT.close, -1)).map((q) => q.id);
      this.mines.delete(m.id);
      booms.push({ mine: m, ids });
    }
    return { gone, booms };
  }

  /** What every page draws: the items lying, [id, kind, x, y, z]; the mines down, [id, x, y, z, yaw, owner]. */
  view() {
    return {
      items: [...this.items.values()].map((i) => [i.id, i.kind, i.x, i.y, i.z]),
      mines: [...this.mines.values()].map((m) => [m.id, m.x, m.y, m.z, m.yaw, m.owner]),
    };
  }

  clear() {
    this.items.clear();
    this.mines.clear();
  }
}
