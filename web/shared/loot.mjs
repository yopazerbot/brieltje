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
// - Stakes: a big one always leaves a bundle (LOOT.bundle rows) beside its reward. Hold reload to
//   plant a row across where you look: a zombie that walks into it wades through at LOOT.slow of its
//   pace (a big one at LOOT.bigSlow), and a moment after. Each zombie that comes into a row wears it
//   (a big one more); its stakes fall one by one, and when it has held LOOT.hold it is gone. The
//   zombies don't walk round a row: it is meant for a gate, a doorway, a stair.
// - A turret: a big one leaves one too. Carry one; hold Use to set it up in front of you (one up per
//   player). After LOOT.turretArm it turns to the nearest zombie it can see within LOOT.turretRange
//   and shoots it, LOOT.turretDamage every LOOT.turretEvery ms: a helper, a sixth of a rifle. After
//   LOOT.turretRounds rounds it is spent and gone. It never hurts a player.
//
// Who has what is a kit per player name (kits), kept for the game, a dropped connection included.

import { BIG, RUNNER, ZOMBIE } from './zombies.mjs';

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
  /** Stakes: rows in a bundle; carried at most, down at most per player and in all; m between the middles of two rows */
  bundle: 4,
  stakesCarry: 8,
  stakesPlaced: 8,
  stakesAll: 32,
  stakesApart: 0.9,
  /** A row: m between its stakes, and at most this far each side of its middle (as far as the floor goes on) */
  stakeGap: 0.45,
  stakeHalf: 0.9,
  /** m in front of its line (the way the stakes lean) and behind it that a zombie is in it, with its own size */
  front: 0.75,
  back: 0.35,
  /** A zombie in a row walks at this share of its pace (a big one at bigSlow), and for slowMs after */
  slow: 0.35,
  bigSlow: 0.6,
  slowMs: 600,
  /** What a row holds: each zombie that comes into it wears it by 1, a big one by bigWear */
  hold: 10,
  bigWear: 4,
  /** Turrets: up at once in all (one per player); ms before it starts; m it sees; rounds in it */
  turretsAll: 8,
  turretArm: 1200,
  turretRange: 16,
  turretRounds: 100,
  /** ms between its shots, the health one takes, how fast it turns (rad/s) and how far off its aim it still shoots (rad) */
  turretEvery: 300,
  turretDamage: 12,
  turretTurn: 3.5,
  turretCone: 0.12,
};

const r2 = (v) => Math.round(v * 100) / 100;
/** How many stakes a row from `a` to `b` (m along it) has, and how many still stand after `wear`. */
const stakesOf = (a, b) => Math.round((b - a) / LOOT.stakeGap) + 1;
const standing = (r) => Math.max(1, Math.ceil(stakesOf(r.a, r.b) * (1 - r.wear / LOOT.hold)));

export class Loot {
  /** `nav`: the zombies' grid (shared/zombies.mjs makeNav): where a claymore may stand, and what its blast can't go through. */
  constructor(nav, rand = Math.random) {
    this.nav = nav;
    this.rand = rand;
    /** id -> { id, kind, x, y, z, until } */
    this.items = new Map();
    /** id -> { id, owner, x, y, z, yaw, armedAt } */
    this.mines = new Map();
    /** The rows of stakes down: id -> { id, owner, x, y, z, yaw, a, b (m along it each side), wear, up (stakes standing), in (zombie ids in it) } */
    this.rows = new Map();
    /** The turrets up: id -> { id, owner, x, y, z, set (its yaw as set up), yaw (where it aims), armedAt, rounds, next (ms: its next shot), target (zombie id or -1), at (its last tick) } */
    this.turrets = new Map();
    /** Player name -> { ammo: [weapons with the bigger magazines], scope, claymores, stakes (rows carried), turrets } */
    this.kits = new Map();
    this.nextId = 1;
    /** Whether something fell in this wave yet (its last zombie leaves one if not) */
    this.dropped = false;
  }

  kit(name) {
    let k = this.kits.get(name);
    if (!k) this.kits.set(name, (k = { ammo: [], scope: false, claymores: 0, stakes: 0, turrets: 0 }));
    return k;
  }

  /** A new wave began. */
  wave() {
    this.dropped = false;
  }

  /**
   * Zombie `z` was beaten: what it leaves where it fell (a list, often empty). `last`: the wave's last.
   * A big one leaves a bundle of stakes and a turret as well, either side of its reward (all where it
   * stood). `fighters`: who plays now; when every one of them has a scope, no scope falls (it would lie
   * there for nobody: walking over it did nothing).
   */
  drop(z, now, last = false, fighters = []) {
    const out = [];
    // `side` m to its right, `ahead` m in front of it (a zombie walks along sin, cos of its yaw).
    const leave = (kind, side, ahead = 0) => {
      const x = z.x + side * Math.cos(z.yaw) + ahead * Math.sin(z.yaw), zz = z.z - side * Math.sin(z.yaw) + ahead * Math.cos(z.yaw);
      const item = { id: this.nextId++, kind, x: r2(x), y: r2(z.y), z: r2(zz), until: now + LOOT.life };
      this.items.set(item.id, item);
      this.dropped = true;
      out.push(item);
    };
    const big = z.kind === BIG;
    if (big) {
      leave('stakes', 0.5);
      leave('turret', -0.5);
    }
    if (this.items.size >= LOOT.lying + (big ? 2 : 0)) return out;
    const p = big ? LOOT.bigChance : z.kind === RUNNER ? LOOT.runnerChance : LOOT.chance;
    if (!(this.rand() < p) && !(last && !this.dropped)) return out;
    const scoped = fighters.length > 0 && fighters.every((n) => this.kits.get(n)?.scope);
    const weights = LOOT.weights.filter(([k]) => !(k === 'scope' && scoped));
    let r = this.rand() * weights.reduce((sum, [, w]) => sum + w, 0);
    let kind = weights[0][0];
    for (const [k, w] of weights) {
      if (r < w) {
        kind = k;
        break;
      }
      r -= w;
    }
    leave(kind, 0, big ? 0.6 : 0);
    return out;
  }

  /**
   * Player `name`, standing at `p` ({ x, y, z } and `w` the weapon in hand), takes item `id`: what
   * they got ({ kind, w, kit }) or null (no such item, too far, or nothing in it for them: a second
   * scope, a claymore, stakes or a turret over what they can carry; it stays for someone else).
   */
  take(name, p, id, now) {
    const it = this.items.get(id);
    if (!it || now >= it.until) return null;
    if (Math.hypot(p.x - it.x, p.z - it.z) > LOOT.reach || Math.abs(p.y - it.y) > LOOT.rise) return null;
    const k = this.kit(name);
    if (it.kind === 'scope' && k.scope) return null;
    if (it.kind === 'claymore' && k.claymores >= LOOT.carry) return null;
    if (it.kind === 'stakes' && k.stakes >= LOOT.stakesCarry) return null;
    if (it.kind === 'turret' && k.turrets >= 1) return null;
    this.items.delete(id);
    if (it.kind === 'scope') k.scope = true;
    else if (it.kind === 'claymore') k.claymores++;
    else if (it.kind === 'stakes') k.stakes = Math.min(LOOT.stakesCarry, k.stakes + LOOT.bundle);
    else if (it.kind === 'turret') k.turrets = 1;
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
    const s = this.spot(p, at);
    if (!s) return { why: 'spot' };
    for (const m of this.mines.values()) if (Math.hypot(m.x - s.x, m.z - s.z) < LOOT.apart) return { why: 'spot' };
    k.claymores--;
    const mine = { id: this.nextId++, owner: name, x: r2(s.x), y: r2(s.y), z: r2(s.z), yaw: s.yaw, armedAt: now + LOOT.armMs };
    this.mines.set(mine.id, mine);
    return { mine };
  }

  /**
   * Where a player at `p` may put something at `at` ({ x, y, z, yaw }): within reach of their feet, on a
   * floor the zombies walk (not in a wall, a hedge, a car or the air). { x, y (the floor's), z, yaw, node }, or null.
   */
  spot(p, at) {
    const { x, y, z, yaw } = at ?? {};
    if (![x, y, z, yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    if (Math.hypot(x - p.x, z - p.z) > LOOT.placeReach || Math.abs(y - p.y) > LOOT.placeRise) return null;
    const node = this.nav.locate(x, y + 0.3, z, 0.1);
    if (node < 0) return null;
    const fy = this.nav.y(node, x, z);
    if (Math.abs(fy - y) > 0.4) return null;
    return { x, y: fy, z, yaw: Math.round(Math.atan2(Math.sin(yaw), Math.cos(yaw)) * 1000) / 1000, node };
  }

  /**
   * Player `name`, standing at `p`, plants a row of the stakes they carry at `at` ({ x, y, z, yaw }:
   * across where they look, the stakes leaning that way). Its middle stands as a claymore would, not on
   * another row's; from there it goes on stake by stake to each side, LOOT.stakeHalf at most, as far as
   * a zombie could walk along it at that height (a doorway takes as many as fit). { row } or { why } as place.
   */
  placeStakes(name, p, at) {
    const k = this.kit(name);
    if (k.stakes < 1) return { why: 'none' };
    let down = 0;
    for (const r of this.rows.values()) if (r.owner === name) down++;
    if (down >= LOOT.stakesPlaced || this.rows.size >= LOOT.stakesAll) return { why: 'max' };
    const s = this.spot(p, at);
    if (!s) return { why: 'spot' };
    for (const r of this.rows.values()) if (Math.hypot(r.x - s.x, r.z - s.z) < LOOT.stakesApart) return { why: 'spot' };
    const ux = Math.cos(s.yaw), uz = -Math.sin(s.yaw); // along the row (the game's yaw: forward is -z at 0)
    const side = (dir) => {
      let d = 0;
      for (let t = LOOT.stakeGap; t <= LOOT.stakeHalf + 1e-6; t += LOOT.stakeGap) {
        const x = s.x + ux * t * dir, z = s.z + uz * t * dir;
        const end = this.nav.walk(s.node, s.x, s.z, x, z);
        if (end < 0 || Math.abs(this.nav.y(end, x, z) - s.y) > 0.35) break;
        d = t;
      }
      return r2(d);
    };
    k.stakes--;
    const row = { id: this.nextId++, owner: name, x: r2(s.x), y: r2(s.y), z: r2(s.z), yaw: s.yaw, a: -side(-1), b: side(1), wear: 0, up: 0, in: new Set() };
    row.up = standing(row);
    this.rows.set(row.id, row);
    return { row };
  }

  /**
   * Player `name`, standing at `p`, sets up the turret they carry at `at` ({ x, y, z, yaw }), where a
   * claymore could stand, a metre from another turret. One up per player (`max`), LOOT.turretsAll in
   * all (`all`). { turret } or { why }: 'none', 'max', 'all' or 'spot'.
   */
  placeTurret(name, p, at, now) {
    const k = this.kit(name);
    if (k.turrets < 1) return { why: 'none' };
    for (const t of this.turrets.values()) if (t.owner === name) return { why: 'max' };
    if (this.turrets.size >= LOOT.turretsAll) return { why: 'all' };
    const s = this.spot(p, at);
    if (!s) return { why: 'spot' };
    for (const t of this.turrets.values()) if (Math.hypot(t.x - s.x, t.z - s.z) < 1) return { why: 'spot' };
    k.turrets--;
    const turret = { id: this.nextId++, owner: name, x: r2(s.x), y: r2(s.y), z: r2(s.z), set: s.yaw, yaw: s.yaw, armedAt: now + LOOT.turretArm, rounds: LOOT.turretRounds, next: 0, target: -1, at: now };
    this.turrets.set(turret.id, turret);
    return { turret };
  }

  /**
   * Whether turret `t` sees zombie `q`: up, within its range, not far above or below, and nothing in
   * between from its head to the zombie's chest (the zombies' grid, as for a blast). Its distance, or -1.
   */
  sees(t, q) {
    if (q.act === 'down' || Math.abs(q.y - t.y) > 3) return -1;
    const d = Math.hypot(q.x - t.x, q.z - t.z);
    if (d > LOOT.turretRange) return -1;
    return this.nav.reach(t.x, t.y + 0.75, t.z, q.x, q.y + (q.kind === BIG ? 1.6 : 1.1), q.z) ? d : -1;
  }

  /**
   * Each turret up, every tick: it keeps to the zombie it shoots while it sees it, unless another comes
   * much nearer, else turns to the nearest it sees (a look at the nearest four at most, when it may
   * shoot); it shoots when it faces it. `shots` gets
   * { turret, id } for each shot (the caller hurts the zombie, LOOT.turretDamage); `spent` the turrets
   * out of rounds (gone now).
   */
  turretTick(now, up, shots, spent) {
    for (const t of [...this.turrets.values()]) {
      const dt = Math.min(0.25, Math.max(0, (now - t.at) / 1000));
      t.at = now;
      if (now < t.armedAt) continue;
      if (t.rounds <= 0) {
        this.turrets.delete(t.id);
        spent.push(t);
        continue;
      }
      let q = t.target >= 0 ? up.find((z) => z.id === t.target) : null;
      let qd = q ? this.sees(t, q) : -1;
      if (qd < 0) q = null;
      if (now >= t.next) {
        // When it may shoot: the nearest it sees, if it has none, or if that one is much nearer than its
        // own (one closing in). Found none: it looks again a shot later.
        const near = up.filter((z) => z !== q).map((z) => [z, Math.hypot(z.x - t.x, z.z - t.z)]).filter(([, d]) => d <= LOOT.turretRange).sort((a, b) => a[1] - b[1]);
        for (const [z, d] of near.slice(0, 4)) {
          if (q && d >= qd * 0.6) break;
          if (this.sees(t, z) < 0) continue;
          [q, qd] = [z, d];
          break;
        }
        if (!q) t.next = now + LOOT.turretEvery;
      }
      t.target = q ? q.id : -1;
      if (!q) continue;
      const want = Math.atan2(-(q.x - t.x), -(q.z - t.z)); // the game's yaw: forward is -z at 0
      const off = Math.atan2(Math.sin(want - t.yaw), Math.cos(want - t.yaw));
      const turn = LOOT.turretTurn * dt;
      const step = Math.max(-turn, Math.min(turn, off));
      t.yaw = Math.atan2(Math.sin(t.yaw + step), Math.cos(t.yaw + step));
      if (Math.abs(off) > LOOT.turretCone + turn || now < t.next) continue;
      t.next = now + LOOT.turretEvery;
      t.rounds--;
      shots.push({ turret: t, id: q.id });
    }
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
   * right next to it). The caller hurts them (LOOT.damage) and tells everyone. A zombie in a row of
   * stakes is slowed (its `slow` and `slowUntil`, which the horde walks by) and wears it: `broke` the
   * rows worn through (gone now), `worn` whether a stake fell in one (the view changed). And the
   * turrets shoot (`shots`: { turret, id }, the caller hurts the zombie; `spent`: turrets gone).
   */
  tick(now, zombies) {
    const gone = [];
    for (const it of this.items.values()) if (now >= it.until) gone.push(it.id);
    for (const id of gone) this.items.delete(id);
    const booms = [];
    const broke = [];
    const shots = [];
    const spent = [];
    let worn = false;
    if (!this.mines.size && !this.rows.size && !this.turrets.size) return { gone, booms, broke, worn, shots, spent };
    const up = [];
    for (const q of zombies) if (q.act !== 'down') up.push(q);
    this.turretTick(now, up, shots, spent);
    for (const r of [...this.rows.values()]) {
      const ux = Math.cos(r.yaw), uz = -Math.sin(r.yaw);
      const fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw); // its front: the way the stakes lean
      const was = r.in;
      r.in = new Set();
      for (const q of up) {
        if (Math.abs(q.y - r.y) > 1) continue;
        const big = q.kind === BIG;
        const size = (big ? ZOMBIE.bigRadius : ZOMBIE.radius) + 0.1;
        const dx = q.x - r.x, dz = q.z - r.z;
        const along = dx * ux + dz * uz, ahead = dx * fx + dz * fz;
        if (along < r.a - size || along > r.b + size || ahead > LOOT.front + size || ahead < -LOOT.back - size) continue;
        r.in.add(q.id);
        q.slow = big ? LOOT.bigSlow : LOOT.slow;
        q.slowUntil = now + LOOT.slowMs;
        if (!was.has(q.id)) r.wear += big ? LOOT.bigWear : 1;
      }
      if (r.wear >= LOOT.hold) {
        this.rows.delete(r.id);
        broke.push(r);
        continue;
      }
      const n = standing(r);
      if (n !== r.up) {
        r.up = n;
        worn = true;
      }
    }
    for (const m of [...this.mines.values()]) {
      if (now < m.armedAt) continue;
      const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw); // the game's yaw: forward is -z at 0
      if (!up.some((q) => this.inArc(m, q, fx, fz, LOOT.trigger, LOOT.cone))) continue;
      const ids = up.filter((q) => this.inArc(m, q, fx, fz, LOOT.blast, LOOT.blastCone) || this.inArc(m, q, fx, fz, LOOT.close, -1)).map((q) => q.id);
      this.mines.delete(m.id);
      booms.push({ mine: m, ids });
    }
    return { gone, booms, broke, worn, shots, spent };
  }

  /**
   * What every page draws: the items lying, [id, kind, x, y, z]; the mines down, [id, x, y, z, yaw, owner];
   * the rows of stakes, [id, x, y, z, yaw, a, b, stakes standing, owner]; the turrets up, [id, x, y, z,
   * yaw as set up, owner] (where they aim and their rounds go with each shot: the caller's zfire).
   */
  view() {
    return {
      items: [...this.items.values()].map((i) => [i.id, i.kind, i.x, i.y, i.z]),
      mines: [...this.mines.values()].map((m) => [m.id, m.x, m.y, m.z, m.yaw, m.owner]),
      stakes: [...this.rows.values()].map((r) => [r.id, r.x, r.y, r.z, r.yaw, r.a, r.b, r.up, r.owner]),
      turrets: [...this.turrets.values()].map((t) => [t.id, t.x, t.y, t.z, t.set, t.owner]),
    };
  }

  clear() {
    this.items.clear();
    this.mines.clear();
    this.rows.clear();
    this.turrets.clear();
  }
}
