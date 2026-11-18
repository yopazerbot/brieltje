// Attack and defend's supplies (Yoshi, 18 Nov 2026: crates at both camps "and on vehicles/helicopters"; walk up, Use; the
// server decides, with a wait per player): driven from server/assault.mjs. The crates stand where shared/assaultFields.mjs
// has them; the page only names the one it uses (`asup`: { id }).
//
// - Ammo and grenades, every ASSAULT.wait.ammo per player: from the ammo crates, the camp's supply truck, the spawn truck
//   standing still and each side's helicopter on the ground. Every grenade back at once (the server's count); the page
//   fills its magazines (they are the page's own, as ever).
// - A first-aid kit and an armour vest together, every ASSAULT.wait.med: LOOT.heal health back (to LOOT.health) and a vest
//   of LOOT.armor points, which takes a hit first (soak, from Game.damage). Refused when neither is needed.
// - A heavy weapon, every ASSAULT.wait.heavy: a bazooka (ASSAULT.rockets rockets, no more from anywhere) or a sniper rifle,
//   at most ASSAULT.heavyMax held by a team at once, one a player. In this game nobody else carries either: the sniper
//   is out of the starting guns and the admin's bazooka out of their hands until it ends (AssaultArms).
// - The defenders' traps, every ASSAULT.wait.trap: claymores (ASSAULT.claymoresTake a take, LOOT.carry carried) and one
//   turret, ASSAULT.claymoresRound and ASSAULT.turretsRound in a round for the whole team. Placed as in Zombies (hold the
//   grenade key, hold Use; shared/loot.mjs place and placeTurret: on a floor of the grid round their base, near their
//   feet), they go for the attackers: a claymore goes off when one walks into its arc (its blast hurts the attackers in
//   front of it, less at its edge); a turret turns to the nearest it sees within LOOT.turretRange and shoots it,
//   ASSAULT.turretDamage a hit, missing ASSAULT.turretMiss of its shots, ASSAULT.turretRounds rounds in all. Both
//   hurt through Game.damage, as their owner's, with every gate a player's hit has.
//
// Guarded against (DECISIONS.md, "Attack and defend"):
// - pickup forgery by reach: the take is measured from where the server has the player (their state, held to the
//   movement budgets) to where the crate is, or to the vehicle's box where the server has it; a page's claim of where it
//   stands is never read. Alive, on foot, not seated, not in a drop or in the air;
// - privilege escalation by side: a crate serves its side only (the defenders' base the defenders, the camp the
//   attackers), from the teams the server keeps; the traps the defenders only; nobody picks their team (Modes.choose);
// - rate abuse: one message in ASSAULT.rateMs per player on top of the message guard, the wait per player and kind kept
//   by name (a new connection keeps it), the team's limits counted here;
// - forged ids and values: the id is a short string matched against the round's own table (a Map: '__proto__' finds
//   nothing); nothing else in the message is read;
// - hit forgery: the traps' hits are the server's own, through Game.damage after the checks a player's hit has
//   (alive and armed, out of spawn protection, not seated, not calm, not hidden by a home's wall, not a teammate).
// Nothing here is stored or logged.

import { readFileSync } from 'node:fs';
import { LOOT, Loot } from '../shared/loot.mjs';
import { arenaOf } from '../shared/arenas.mjs';
import { ASSAULT, ROUND_FIELDS, WAIT_OF } from '../shared/assaultFields.mjs';
import { FIELDS, FLAG_TEAMS } from '../shared/flagFields.mjs';

const WEAPONS = JSON.parse(readFileSync(new URL('../shared/weapons.json', import.meta.url), 'utf8'));
/** The admin's own weapons (game.mjs ADMIN_WEAPONS): out of their hands while the game is played, back after it. */
const ADMIN_WEAPONS = Object.keys(WEAPONS).filter((w) => WEAPONS[w].admin);
/** Between two rockets of one launcher: the bazooka's reload, with room for network jitter (as game.mjs rocket). */
const RELOAD_MS = WEAPONS.bazooka.reload * 800;
const HEAVY = ['bazooka', 'sniper'];
const ID = /^[a-z][a-z0-9]{1,3}$/;
const other = (team) => (team === 'blue' ? 'red' : 'blue');

/**
 * The heavy weapons (a FlagBazooka's place in the game: game.mjs asks `fire`, server/host.mjs `rack`, Modes `step`):
 * who holds which, and the places a team has free.
 */
export class AssaultArms {
  constructor(game, f) {
    this.game = game;
    this.f = f;
    /** name -> { team, w, left (rockets), next (ms: the next rocket) } */
    this.holders = new Map();
    /** team -> the times its places taken by a gone holder come free again */
    this.back = { blue: [], red: [] };
    this.over = false;
    this.dirty = false;
  }

  /** The heavy weapons `team` holds or has waiting to come back now. */
  count(team, now) {
    let n = 0;
    for (const h of this.holders.values()) if (h.team === team) n++;
    return n + this.back[team].filter((t) => t > now).length;
  }

  /** Whether `name` holds a bazooka now (the FlagBazooka's word, for those who ask). */
  holds(name) {
    return this.holders.get(name)?.w === 'bazooka';
  }

  /** `name` takes heavy weapon `w`: null, or why not ('have': one already; 'full': the team's places taken). */
  give(name, p, team, w, now) {
    if (this.over || !HEAVY.includes(w)) return 'full';
    if (this.holders.has(name)) return 'have';
    if (this.count(team, now) >= ASSAULT.heavyMax) return 'full';
    this.holders.set(name, { team, w, left: w === 'bazooka' ? ASSAULT.rockets : 0, next: 0 });
    this.dirty = true;
    this.arm(name, p);
    if (w === 'bazooka') {
      // Their team hears who has it (the other team gets no line); the holder how many rockets.
      for (const [n, q] of this.game.players) if (this.f.teams[n] === team) this.game.send(q.ws, { t: 'fbz', ev: 'taken', team, name, n: ASSAULT.rockets });
    }
    return null;
  }

  /** `name`'s heavy weapon gone (down, left, moved, out of rockets): its place free again `ms` from now. */
  release(name, now, ms = ASSAULT.heavyBackMs) {
    const h = this.holders.get(name);
    if (!h) return;
    this.holders.delete(name);
    if (ms > 0) this.back[h.team].push(now + ms);
    this.dirty = true;
    const p = this.game.players.get(name);
    if (p) this.arm(name, p);
  }

  /** The host moved `name` (or everyone, `name` null) to the other team: their heavy weapon gone at once, its place free. */
  rack(name = null) {
    for (const n of [...this.holders.keys()]) if (name === null || n === name) this.release(n, Date.now(), 0);
  }

  /** Player `name`'s guns as they should be: a bazooka or a sniper rifle only when they hold one. */
  arm(name, p) {
    if (!p.weapons) return;
    const h = this.over ? null : this.holders.get(name);
    const had = [...p.weapons].join();
    for (const w of HEAVY) {
      if (h?.w === w) p.weapons.add(w);
      else if (!this.over) p.weapons.delete(w);
    }
    if ([...p.weapons].join() === had) return;
    this.game.send(p.ws, { t: 'weapons', list: [...p.weapons] });
    if (h?.w === 'bazooka') this.game.send(p.ws, { t: 'fbz', ev: 'left', n: h.left });
  }

  /** One tick: holders gone, down or on the other team lose it; the places' clocks; everyone's guns. True: views changed. */
  step(now) {
    if (this.over) return false;
    for (const [name, h] of [...this.holders]) {
      const p = this.game.players.get(name);
      if (!p || !p.alive || this.f.teams[name] !== h.team) this.release(name, now);
    }
    for (const t of FLAG_TEAMS) {
      const before = this.back[t].length;
      this.back[t] = this.back[t].filter((at) => at > now);
      if (this.back[t].length !== before) this.dirty = true;
    }
    for (const [name, p] of this.game.players) this.arm(name, p);
    const dirty = this.dirty;
    this.dirty = false;
    return dirty;
  }

  /** A rocket of `name`'s may leave (game.mjs rocket, its own checks passed): only a held bazooka with rockets, at its pace. */
  fire(name, p, now) {
    const h = this.over ? null : this.holders.get(name);
    if (!h || h.w !== 'bazooka' || h.left < 1 || this.f.teams[name] !== h.team) return false;
    if (now < h.next) return false; // the reload kept with the launcher, not the connection (fire-rate forgery)
    h.next = now + RELOAD_MS;
    h.left--;
    this.game.send(p.ws, { t: 'fbz', ev: 'left', n: h.left });
    if (h.left === 0) this.release(name, now);
    return true;
  }

  /** The game is over: every heavy weapon out of everyone's hands; the starting guns and the admin's own back. */
  end() {
    if (this.over) return;
    this.over = true;
    this.holders.clear();
    for (const p of this.game.players.values()) {
      if (!p.weapons) continue;
      const had = [...p.weapons].join();
      p.weapons.add('sniper');
      if (p.role === 'admin') for (const w of ADMIN_WEAPONS) p.weapons.add(w);
      else p.weapons.delete('bazooka');
      if ([...p.weapons].join() !== had) this.game.send(p.ws, { t: 'weapons', list: [...p.weapons] });
    }
  }

  /** Every page: how many heavy weapons each team has out of its ASSAULT.heavyMax. */
  view(now) {
    return { blue: this.count('blue', now), red: this.count('red', now) };
  }
}

export class AssaultSupply {
  /** `game`: the Game; `f`: the AssaultGame (server/assault.mjs): its field, round, teams and roles. */
  constructor(game, f) {
    this.game = game;
    this.f = f;
    /** name -> { ammo, med, heavy, trap }: when each wait ends */
    this.waits = new Map();
    for (const id of ROUND_FIELDS) this.nav(FIELDS[id].red); // both rounds' grids now, at the start
    this.round(Date.now());
  }

  /**
   * A new round (its field and roles): the waits, the traps and their counts start again; the claymores and turrets of
   * the last round go (every page told by the view).
   */
  round(now) {
    this.waits.clear();
    this.used = { claymores: 0, turrets: 0 };
    const nav = this.nav(this.f.field.red);
    this.loot = nav ? new Loot(nav) : null;
    this.table = this.sources();
    this.at = now;
  }

  /**
   * The Zombies grid of the defenders' place `id` (the church's or the Sparrenhof's, shared/arenas.mjs): where a trap may
   * stand and what a turret sees through. Made once per game: both places at its start (some 50 ms each), never in its
   * break, when 30 players are moved at once already.
   */
  nav(id) {
    this.navs ??= new Map();
    if (!this.navs.has(id)) this.navs.set(id, this.game.zombieGround ? this.game.zombieGround(arenaOf(id)).nav : null);
    return this.navs.get(id);
  }

  /**
   * The round's sources by id: the defenders' crates (d0..d5), the camp's (c0..c3), the camp's supply truck (cs), each
   * side's helicopter (hb the defenders', hr the attackers') and the spawn truck (tk). `side`: 'def' or 'att'.
   */
  sources() {
    const field = this.f.field;
    const a = field.assault;
    const out = new Map();
    a.crates.forEach((c, i) => out.set(`d${i}`, { side: 'def', kind: c.kind, at: c.at }));
    a.camp.crates.forEach((c, i) => out.set(`c${i}`, { side: 'att', kind: c.kind, at: c.at }));
    out.set('cs', { side: 'att', kind: 'ammo', at: a.camp.supply, box: { hx: 1.4, hz: 3.4 }, yaw: a.camp.side });
    out.set('hb', { side: 'def', kind: 'ammo', heli: field.heli.blue.id });
    out.set('hr', { side: 'att', kind: 'ammo', heli: field.heli.red.id });
    out.set('tk', { side: 'att', kind: 'ammo', car: a.truck });
    return out;
  }

  /** The defenders' team now, and the attackers'. */
  get def() {
    return this.f.defender();
  }

  /** Where `p` may put nothing: inside a home they may not see into (as in Zombies). */
  hiddenFor(p) {
    return (x, y, z) => this.game.gate.hidesAt(x, z, y, p);
  }

  /** A line for `p` only: `code` and its English `text` (src/i18n.ts srv.*), with `args`. */
  no(p, code, text, args) {
    this.game.send(p.ws, { t: 'system', text, code, ...(args ? { args } : {}) });
  }

  /** Whether `name` (`p`) stands within reach of source `s` now, as the server has them. */
  reaches(p, s) {
    const g = this.game;
    const st = p.state;
    const vd = g.vehicleDamage;
    if (s.heli) {
      const h = g.helis?.machines.get(s.heli);
      // On the ground, whole, nobody flying it: a machine in the air or burning gives nothing.
      if (!h || vd.out('heli', h.id) || h.seats[0] || h.y - g.helis.floor(h.x, h.z) > 1.5) return false;
      return vd.reach('heli', h, st.x, st.y + 1, st.z) <= ASSAULT.vehicleReach;
    }
    if (s.car) {
      const c = Object.hasOwn(g.cars, s.car) ? g.cars[s.car] : null;
      if (!c || vd.out('car', s.car) || c.driver || !this.f.truckStill(Date.now())) return false;
      return vd.reach('car', c, st.x, st.y + 1, st.z) <= ASSAULT.vehicleReach;
    }
    const [x, z, y] = s.at;
    if (Math.abs(st.y - y) > ASSAULT.rise) return false;
    if (s.box) {
      // The supply truck: its box along the camp (`yaw`), the reach round it.
      const dx = st.x - x, dz = st.z - z;
      const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
      const lx = dx * c - dz * n, lz = dx * n + dz * c;
      return Math.hypot(Math.max(0, Math.abs(lx) - s.box.hx), Math.max(0, Math.abs(lz) - s.box.hz)) <= ASSAULT.vehicleReach;
    }
    return Math.hypot(st.x - x, st.z - z) <= ASSAULT.reach;
  }

  /**
   * A page's Use at a source (`m.id`): every check above, then what it gives. The player is told what they got (`asup`)
   * or why not (a `system` line with its code). Waits start only when something was given.
   */
  use(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextSup || 0)) return;
    p.nextSup = now + ASSAULT.rateMs;
    if (typeof m.id !== 'string' || !ID.test(m.id)) return;
    const s = this.table.get(m.id);
    const team = this.f.teams[name];
    if (!s || !team || p.guard || this.f.over || g.host?.holds(p)) return; // frozen by the host: nothing taken either
    const side = team === this.def ? 'def' : 'att';
    if (s.side !== side) return this.no(p, 'asupSide', 'That is the other team\'s.');
    if (!this.f.canTouch(name, p, now) || g.bikeOf?.(name)) return this.no(p, 'asupFoot', 'On foot, to take from it.');
    if (!this.reaches(p, s)) return this.no(p, 'asupFar', 'Step up to it first.');
    const kind = s.kind;
    const wait = WAIT_OF[kind];
    let w = this.waits.get(name);
    if (!w) this.waits.set(name, (w = { ammo: 0, med: 0, heavy: 0, trap: 0 }));
    if (now < w[wait]) return this.no(p, 'asupWait', 'Not yet.', { n: Math.ceil((w[wait] - now) / 1000) });
    const why = this.give(name, p, team, kind, now);
    if (why) return this.no(p, why[0], why[1], why[2]);
    w[wait] = now + ASSAULT.wait[wait];
    g.send(p.ws, { t: 'asup', kind, ms: ASSAULT.wait[wait], ...(kind === 'med' ? { hp: p.hp } : {}), ...(this.loot ? { kit: this.loot.kit(name) } : {}) });
  }

  /** What `kind` gives `name`: null when given, else [code, text, args] for why not. */
  give(name, p, team, kind, now) {
    if (kind === 'ammo') {
      p.nades.fill(0); // every grenade back (game.mjs throwNade's own count)
      return null;
    }
    if (kind === 'med') {
      const kit = this.loot?.kit(name);
      const hurt = p.hp < LOOT.health;
      const bare = !!kit && kit.armor < LOOT.armor;
      if (!hurt && !bare) return ['asupFull', 'You have full health and a vest.'];
      if (hurt) p.hp = Math.min(LOOT.health, p.hp + LOOT.heal);
      if (kit) kit.armor = LOOT.armor;
      return null;
    }
    if (kind === 'bazooka' || kind === 'sniper') {
      const r = this.f.arms.give(name, p, team, kind, now);
      if (r === 'have') return ['asupHave', 'You carry a heavy weapon already.'];
      if (r === 'full') return ['asupHeavyFull', 'Your team has its heavy weapons out.', { n: ASSAULT.heavyMax }];
      return null;
    }
    // The defenders' traps (the side was checked: only theirs serve these).
    const kit = this.loot?.kit(name);
    if (!kit) return ['asupFar', 'Step up to it first.'];
    if (kind === 'claymore') {
      const room = Math.min(ASSAULT.claymoresTake, LOOT.carry - kit.claymores, ASSAULT.claymoresRound - this.used.claymores);
      if (ASSAULT.claymoresRound - this.used.claymores <= 0) return ['asupTrapsOut', 'Your team has had its claymores this round.'];
      if (room <= 0) return ['asupCarry', 'You carry as many as you can.'];
      kit.claymores += room;
      this.used.claymores += room;
      return null;
    }
    if (kind === 'turret') {
      if (ASSAULT.turretsRound - this.used.turrets <= 0) return ['asupTrapsOut', 'Your team has had its turrets this round.'];
      if (kit.turrets >= 1) return ['asupCarry', 'You carry as many as you can.'];
      for (const t of this.loot.turrets.values()) if (t.owner === name) return ['zTurretMax', 'Your turret is still going.'];
      kit.turrets = 1;
      this.used.turrets++;
      return null;
    }
    return ['asupFar', 'Step up to it first.'];
  }

  /**
   * A hit of `amount` on `name` (Game.damage): their vest takes what it can first; the rest, which goes on. Their page is
   * told the vest left when it changed.
   */
  soak(name, p, amount) {
    if (!this.loot) return amount;
    const before = this.loot.kits.get(name)?.armor ?? 0;
    if (!(before > 0)) return amount;
    const left = this.loot.soak(name, amount);
    this.game.send(p.ws, { t: 'zgift', kind: 'kit', kit: this.loot.kit(name) });
    return left;
  }

  /** A defender places a claymore they carry (game.mjs `claymore`), as in Zombies: their side, their kit, a floor near them. */
  place(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextMine || 0)) return;
    p.nextMine = now + 400;
    if (!this.loot || this.f.teams[name] !== this.def || !p.alive || !p.state?.armed || g.inCar(name) || g.fightCalm(p)) return;
    const s = p.state;
    const r = this.loot.place(name, { x: s.x, y: s.y, z: s.z }, { x: m.x, y: m.y, z: m.z, yaw: m.yaw }, now, this.hiddenFor(p));
    if (!r.mine) {
      const why = { none: ['zMineNone', 'You have no claymore.'], max: ['zMineMax', 'You have two down already.'], spot: ['zMineSpot', 'No room for it there.'] }[r.why];
      return this.no(p, why[0], why[1]);
    }
    g.send(p.ws, { t: 'zgift', kind: 'placed', kit: this.loot.kit(name) });
    g.modes.send();
  }

  /** A defender sets up the turret they carry (game.mjs `turret`), as a claymore is placed. */
  turret(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextTurret || 0)) return;
    p.nextTurret = now + 400;
    if (!this.loot || this.f.teams[name] !== this.def || !p.alive || !p.state?.armed || g.inCar(name) || g.fightCalm(p)) return;
    const s = p.state;
    const r = this.loot.placeTurret(name, { x: s.x, y: s.y, z: s.z }, { x: m.x, y: m.y, z: m.z, yaw: m.yaw }, now, this.hiddenFor(p));
    if (!r.turret) {
      const why = { none: ['zTurretNone', 'You have no turret.'], max: ['zTurretMax', 'Your turret is still going.'], all: ['zTurretAll', 'Enough turrets are up already.'], spot: ['zMineSpot', 'No room for it there.'] }[r.why];
      return this.no(p, why[0], why[1]);
    }
    r.turret.rounds = ASSAULT.turretRounds;
    g.send(p.ws, { t: 'zgift', kind: 'placed', kit: this.loot.kit(name) });
    g.modes.send();
  }

  /** Whether `owner`'s trap may hurt attacker `name` now: the gates a player's hit has (Game.hit, Game.blast). */
  fair(owner, op, name, q, now) {
    const g = this.game;
    return !!q && !q.guard && q !== op && this.f.teams[name] === other(this.def) && q.alive && !!q.state?.armed && now >= q.protectedUntil
      && !g.inCar(name) && !g.fightCalm(q) && g.gate.mayHurt(op, q) && !g.modes.friends(owner, name);
  }

  /**
   * Every tick of a live round: the traps against the attackers. A claymore whose owner left (or changed side) goes; one
   * an attacker walks into goes off; each turret shoots (shared/loot.mjs turretTick, with the attackers in the place of
   * zombies). True when every page needs the view again.
   */
  step(now) {
    const loot = this.loot;
    if (!loot || (!loot.mines.size && !loot.turrets.size)) return false;
    const g = this.game;
    let changed = false;
    const def = this.def;
    for (const m of [...loot.mines.values()]) {
      const op = g.players.get(m.owner);
      if (!op || this.f.teams[m.owner] !== def) {
        loot.mines.delete(m.id);
        changed = true;
        continue;
      }
      if (now < m.armedAt) continue;
      const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
      const hit = [...g.players].find(([n, q]) => this.fair(m.owner, op, n, q, now) && loot.inArc(m, q.state, fx, fz, LOOT.trigger, LOOT.cone));
      if (!hit) continue;
      loot.mines.delete(m.id);
      changed = true;
      g.broadcast({ t: 'zboom', id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, by: m.owner });
      for (const [n, q] of [...g.players]) {
        if (!this.fair(m.owner, op, n, q, now)) continue;
        const s = q.state;
        const d = Math.hypot(s.x - m.x, s.z - m.z);
        if (d > ASSAULT.mineBlast || !loot.inArc(m, s, fx, fz, ASSAULT.mineBlast, d < LOOT.close ? -1 : LOOT.blastCone)) continue;
        g.damage(m.owner, op, n, q, Math.round(ASSAULT.mineDamage * (1 - (0.5 * d) / ASSAULT.mineBlast)), false, 'claymore', now);
      }
    }
    if (loot.turrets.size) {
      // The attackers it may shoot, as the zombies' list is to it: a number each (their names stay here).
      const names = [];
      const up = [];
      for (const [n, q] of g.players) {
        if (this.f.teams[n] !== other(def) || !q.state) continue;
        names.push(n);
        up.push({ id: names.length - 1, x: q.state.x, y: q.state.y, z: q.state.z, kind: 'player', act: '' });
      }
      for (const t of [...loot.turrets.values()]) {
        const op = g.players.get(t.owner);
        if (!op || this.f.teams[t.owner] !== def) {
          loot.turrets.delete(t.id);
          changed = true;
        }
      }
      const shots = [];
      const spent = [];
      const fairUp = up.filter((u) => {
        const n = names[u.id];
        return [...loot.turrets.values()].some((t) => this.fair(t.owner, g.players.get(t.owner), n, g.players.get(n), now));
      });
      loot.turretTick(now, fairUp, shots, spent);
      if (spent.length) changed = true;
      const fire = [];
      for (const { turret: t, id } of shots) {
        const n = names[id];
        const q = g.players.get(n);
        const op = g.players.get(t.owner);
        fire.push([t.id, n, t.rounds]);
        if (!this.fair(t.owner, op, n, q, now) || Math.random() < ASSAULT.turretMiss) continue;
        g.damage(t.owner, op, n, q, ASSAULT.turretDamage, false, 'turret', now);
      }
      if (fire.length) g.broadcast({ t: 'afire', s: fire });
    }
    return changed;
  }

  /** Every tick: a vest is lost when its wearer goes down (as in Zombies); their page is told. */
  fallen() {
    if (!this.loot) return;
    for (const [name, k] of this.loot.kits) {
      if (!(k.armor > 0)) continue;
      const p = this.game.players.get(name);
      if (p && p.alive) continue;
      k.armor = 0;
      if (p) this.game.send(p.ws, { t: 'zgift', kind: 'kit', kit: this.loot.kit(name) });
    }
  }

  /** The traps for every page: the claymores down and the turrets up (as Zombies' view: shared/loot.mjs view). */
  view() {
    const v = this.loot ? this.loot.view() : { mines: [], turrets: [] };
    return { mines: v.mines, turrets: v.turrets, used: { ...this.used } };
  }

  /** The game or the round is over: every trap gone, every kit emptied (the vests too). */
  end() {
    if (!this.loot) return;
    for (const name of [...this.loot.kits.keys()]) {
      this.loot.kits.delete(name);
      const p = this.game.players.get(name);
      if (p) this.game.send(p.ws, { t: 'zgift', kind: 'kit', kit: { ammo: [], scope: false, claymores: 0, stakes: 0, turrets: 0, armor: 0, nades: 0 } });
    }
    this.loot.mines.clear();
    this.loot.turrets.clear();
  }
}
