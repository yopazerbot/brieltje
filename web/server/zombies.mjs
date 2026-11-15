// The Zombies party game on the server (server/modes.mjs starts and stops it; shared/zombies.mjs
// runs the horde). Everyone is one team at the place the admin picked (shared/arenas.mjs): round the
// house and the bungalow, or by a portal in Smetlede, inside its edge; the zombies come in waves. The
// server keeps all of it: where every zombie is and what it does, its health, every hit
// on it and every swipe it lands. A page only says "my shot hit zombie 12" (zhit), and that is
// checked the way a hit on a strongman is (game.mjs clownhit): a weapon the player carries and
// holds, its fire rate, alive, armed, not on the school grounds, and here also a zombie that is up,
// within MAX_RANGE, and no more pellets than the gun fires. Blasts are set off on the server (a
// rocket) or checked there (a grenade), and hurt zombies through Horde.blast.
//
// At home the house and the bungalow are open as at any time together (in Smetlede every building is
// shut to the zombies, its walls theirs): the zombies follow the players in,
// up the stairs and through the doors (a shut one a zombie shoves open: game.zombieDoor, for every
// page) and through a pane that was shot out (panes). A swipe never goes through a wall, a floor, a
// whole pane or a shut door. Whoever stands where no zombie can get at them (a ledge, or a page that
// claims to hover or stand in a wall) is warned, and out of the wave if they stay (perch).
//
// Rewards (shared/loot.mjs): a beaten zombie sometimes leaves one (a bigger ammo pack, a scope, a
// claymore, a first-aid kit, an armour vest, extra grenades, a music box, a supply crate), and a big
// one a bundle of stakes and a turret too. The server keeps them: what lies where, who has
// what, every pickup (take: an item that is there, within reach of the server's position, useful to
// them; taken once), every claymore placed (place: carried, on a floor near the player, at most two
// down) and set off (each tick, by the zombies the server has; its blast only hurts zombies), every
// row of stakes planted (stakes: as a claymore) and worn through (each tick, by its zombies), and
// every turret set up (turret: as a claymore), its aim and its shots (each tick; zombies only). What
// is in the five newer ones is the server's too: the health a kit gives (on its own count of it), the
// vest that takes a swipe first (swipe), the spare grenades a throw may use (spareNade), where a
// music box plays and which zombies it slows (each tick), the gun in a crate. No page names any of it.
//
// Coins and the stall (shared/stall.mjs): a beaten zombie pays whoever beat it (beat), a beaten wave
// pays everyone who fights (bonus), and in the break a page may buy one of six things (buy: the page
// names only the thing). The coins are the server's count, told to each player's own page (zcoins).
//
// Who goes down waits for the end of the wave (their page shows it), then everyone comes back at
// the place's start (the house's outside start places, or by the portal), unless a teammate helps
// them up first: holding Use next to them for REVIVE_MS on the server's clock (help), they're up
// where they lie with part of their health. When everyone who fights is down at once, the game is
// over: the wave reached, each player's zombies beaten and the best wave ever at that place (kept in
// the database's meta table, as the rules are) show for DONE_MS.

import { BIG, bigOf, Horde } from '../shared/zombies.mjs';
import { Loot, LOOT } from '../shared/loot.mjs';
import { sold, Stall } from '../shared/stall.mjs';
import { zombieEntry } from '../shared/wire.mjs';
import { arenaOf } from '../shared/arenas.mjs';
import { homeAt } from '../shared/homes.mjs';

export const DONE_MS = 15_000;
/** ms after the last parachute is down before a wave may come (tick: the break holds while anyone drops) */
export const LANDED_MS = 4_000;
export const RECONNECT_MS = 15_000;
const BEST_KEY = 'zombies_best';
const MAX_RANGE = 100; // m from the shooter to the zombie, on the server's positions
const MAX_HITS = 8; // zombies one shot can claim (the shotgun's eight pellets)
/**
 * m: how far off the shot's line (from the shooter through the first zombie, on the server's
 * positions) the second zombie of a sniper's double may stand: its size and the time it moved while
 * the shot came here.
 */
const LINE_SLACK = 0.65;
/** ms a teammate holds Use next to a downed player to help them up; m apart on the server's positions (the page asks 1.5: room for its lag); the health they come back with */
const REVIVE_MS = 3000;
const REVIVE_REACH = 1.9;
const REVIVE_HP = 50;

export class ZombieGame {
  /**
   * A new game for the players `names` at `arena` (shared/arenas.mjs: home, or a portal in Smetlede;
   * gathered there by modes.start). Its `edge` holds while it runs (game.fence).
   */
  constructor(game, modes, names, now, arena = arenaOf('house')) {
    this.game = game;
    this.modes = modes;
    this.arena = arena;
    const { nav, spots, home, doors, doorOpen, edge, stall } = game.zombieGround(arena);
    this.edge = edge;
    /** Where the place's stall stands ({ x, y, z }; shared/stall.mjs STALL_SPOTS), or null: nothing is sold then */
    this.stallAt = stall ?? null;
    this.horde = new Horde(nav, spots, { home, doors, doorOpen });
    /** The rewards: what lies where, the claymores down, who has what */
    this.loot = new Loot(nav);
    /** Coins and the stall (shared/stall.mjs): per player name for the game, a dropped connection included */
    this.stall = new Stall();
    /** Player name -> the session (p.key) its coins belong to: another session under the name starts at 0 (join) */
    this.purses = new Map();
    /** Who fought (armed, on foot) when the wave began: only they get its bonus */
    this.waveFighters = new Set();
    this.horde.start(now);
    /** Who took part (any time in this game), and who is down until the wave is beaten */
    this.players = new Set(names);
    // Every page starts the game at 0 coins (not the last game's), told to it alone.
    for (const [name, p] of game.players) {
      this.purses.set(name, p.key);
      this.tell(name, p);
    }
    this.down = new Set();
    /** Player name -> times down in this game (the scoreboard's column) */
    this.downs = Object.create(null);
    this.best = game.zombieBests[arena.id] ?? null;
    this.record = false;
    this.custom = false; // Chosen waves never replace the normal best-wave record.
    /** Helper's name -> who they help up, since when (ms), and when the helper was last hurt then */
    this.helping = new Map();
    /** Player name -> where they went down ({ x, y, z }): they stay there (their page's moves are ignored) and get up there */
    this.fell = new Map();
    /** Who was put out of this wave for standing out of every zombie's reach: nobody can help them up (they come back at its end) */
    this.perchedOut = new Set();
    // Only the same authenticated session can reclaim a disconnected survivor's grace.
    this.away = new Map();
    this.reconnecting = false;
  }

  get phase() {
    return this.horde.phase === 'over' ? 'done' : this.horde.phase;
  }

  /** ms left of the break before the next wave (0 during a wave). */
  ms(now) {
    return this.horde.phase === 'break' ? Math.max(0, this.horde.until - now) : 0;
  }

  /** The players as the horde sees them: who fights (armed, on foot, there), who is up, who was just back. */
  roster(now) {
    const list = [];
    for (const [name, p] of this.game.players) {
      const s = p.state;
      if (!s) continue;
      list.push({ name, x: s.x, y: s.y, z: s.z, alive: p.alive, fighter: !!s.armed && !this.game.inCar(name), safe: now < p.protectedUntil || this.game.calm(p) });
    }
    return list;
  }

  /** What the game's bar and end screen show (part of Modes.view). */
  view(now) {
    const h = this.horde;
    const here = (n) => this.game.players.has(n);
    let fighters = 0;
    let standing = 0;
    for (const [, p] of this.game.players) {
      if (!p.state?.armed) continue;
      fighters++;
      if (p.alive) standing++;
    }
    const beaten = Object.create(null);
    for (const n of this.players) if (here(n) || h.beaten[n]) beaten[n] = h.beaten[n] ?? 0;
    return {
      wave: h.wave, left: h.left, big: h.bigWave, bigs: bigOf(h.wave), fighters, standing, beaten, ms: this.ms(now),
      down: [...this.down].filter(here), downs: { ...this.downs }, best: this.best, record: this.record, custom: this.custom, reconnecting: this.reconnecting, place: this.arena.id,
      ...this.loot.view(),
    };
  }

  /** The game's phase and clock in the modes' state (for its view, and the edge that holds: game.mjs fenced). */
  sync() {
    const s = this.modes.state;
    if (s.z !== this || s.phase === 'done') return;
    s.phase = this.phase;
    s.until = this.horde.until;
  }

  /** The admin replaces the wave immediately; equipment stays and downed teammates return. */
  selectWave(wave, by, now) {
    const events = this.horde.selectWave(now, wave, this.roster(now).filter((p) => p.fighter).length);
    if (!events) return false;
    this.custom = true;
    this.reconnecting = false;
    this.revive();
    for (const e of events) {
      if (e.type === 'gone') this.game.broadcast({ t: 'zgone', ids: e.ids });
      else if (e.type === 'wave') this.waveStarted(e);
    }
    this.sync();
    this.modes.say(`${by} selected wave ${wave}. This custom run does not set records.`, 'zWaveSelected', { name: by, n: wave });
    this.modes.send();
    return true;
  }

  waveStarted(e) {
    this.loot.wave();
    this.waveFighters = new Set([...this.game.players].filter(([n, p]) => this.fights(n, p)).map(([n]) => n));
    const code = e.bigs > 1 ? 'zWaveBigs' : e.big ? 'zWaveBig' : 'zWave';
    const more = e.bigs > 1 ? ' Big ones are with them!' : e.big ? ' A big one is with them!' : '';
    this.modes.say(`Wave ${e.wave}: ${e.count} zombies are coming!${more}`, code, { n: e.wave, count: e.count });
  }

  /** Every tick (`dt` in ms): the horde's step, and what came of it. */
  tick(now, dt) {
    const g = this.game;
    const roster = this.roster(now);
    for (const [name, away] of this.away) {
      const p = g.players.get(name);
      if (now >= away.until || this.down.has(name) || (p && (p.key !== away.key || !p.alive || p.state?.armed))) this.away.delete(name);
    }
    const waiting = !roster.some((p) => p.fighter && p.alive) && this.away.size > 0;
    if (waiting !== this.reconnecting) {
      this.reconnecting = waiting;
      this.modes.send();
    }
    if (waiting) return; // A dropped connection is not a death; wait for its first armed state too.
    let changed = false;
    this.helpTick(now);
    // Nobody meets a wave in the air: while anyone is still coming down by parachute (the start, those back
    // between waves, a late join), the break holds, and ends LANDED_MS after the last one is down.
    // (A second at a time, so the bar's clock is sent once a second, not with every tick.)
    if (this.horde.phase === 'break' && this.horde.until < now + LANDED_MS - 1000 && roster.some((r) => g.dropping(g.players.get(r.name), now))) {
      this.horde.until = now + LANDED_MS;
      this.sync();
      changed = true;
    }
    const events = this.horde.tick(now, dt / 1000, roster);
    this.sync();
    for (const e of events) {
      if (e.type === 'wave') {
        // Everyone who fights is counted for the wave's size; the line says how many come.
        this.waveStarted(e);
        changed = true;
      } else if (e.type === 'swipe') {
        const p = g.players.get(e.name);
        if (p) this.swipe(e, p, now);
      } else if (e.type === 'door') {
        g.zombieDoor(e.id, e.dir);
      } else if (e.type === 'runners') {
        this.modes.say('Runners! Some zombies sprint at you. Dodge them!', 'zRunners');
      } else if (e.type === 'perch') {
        const p = g.players.get(e.name);
        const n = Math.round(e.ms / 1000);
        if (p) g.send(p.ws, { t: 'system', text: `The zombies can't reach you there. Come down within ${n} seconds, or you're out of this wave.`, code: 'zPerch', args: { n } });
      } else if (e.type === 'perchOut') {
        const p = g.players.get(e.name);
        if (p?.alive) {
          this.perchedOut.add(e.name); // no help up for them: that would undo it (penalty evasion)
          this.modes.say(`${e.name} stayed out of the zombies' reach and is out of this wave.`, 'zPerchOut', { name: e.name });
          g.npcDamage(e.name, p, p.hp, now, 'a zombie');
        }
      } else if (e.type === 'cleared') {
        const paid = this.bonus(e.wave); // before revive: who is down now gets the down share
        this.revive();
        const s = Math.round(e.ms / 1000); // the break the horde set (shared/zombies.mjs breakAfter)
        this.modes.say(`Wave ${e.wave} beaten! The next one comes in ${s} seconds.`, 'zCleared', { n: e.wave, s });
        this.paid(paid); // each one's bonus line after the wave's own
        changed = true;
      } else if (e.type === 'gone') {
        g.broadcast({ t: 'zgone', ids: e.ids });
      } else if (e.type === 'over') {
        this.over(now);
        return;
      }
    }
    // The rewards: items lying too long go; a claymore a zombie walked into goes off (zombies only); the
    // zombies in a row of stakes wade through it and wear it (a stake falls, or the row is gone).
    const { gone, booms, broke, worn, shots, spent, faded } = this.loot.tick(now, this.horde.zombies.values());
    if (gone.length || worn || spent.length || faded.length) changed = true;
    // The turrets' shots this tick: everyone sees each one fired at its zombie ([turret, zombie, rounds
    // left]), then it is hurt as by anyone's bullet, for the turret's owner.
    if (shots.length) g.broadcast({ t: 'zfire', s: shots.map(({ turret: t, id }) => [t.id, id, t.rounds]) });
    for (const { turret: t, id } of shots) this.damage(id, LOOT.turretDamage, t.owner, 'turret', now);
    for (const { mine: m, ids } of booms) {
      g.broadcastHome({ t: 'zboom', id: m.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, by: m.owner }, homeAt(m.x, m.z, m.y)); // inside a home: only with its right
      for (const id of ids) this.damage(id, LOOT.damage, m.owner, 'claymore', now);
      changed = true;
    }
    for (const r of broke) {
      g.broadcast({ t: 'zbroke', id: r.id });
      changed = true;
    }
    if (changed) this.modes.send();
  }

  /**
   * A page says its player walked over item `m.id`: theirs if it is there, within reach of where the
   * server has them, of use to them, and they fight (forged pickups and duplicates: taken once, by
   * one). Their page gets what they have now; everyone sees it gone.
   */
  /** Where player `p` may put nothing (shared/loot.mjs spot): inside a home they may not see into (server/homeGate.mjs). */
  hiddenFor(p) {
    return (x, y, z) => this.game.gate.hidesAt(x, z, y, p);
  }

  take(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextItem || 0)) return;
    p.nextItem = now + 250;
    if (!Number.isInteger(m.id) || !p.alive || !p.state?.armed || g.inCar(name) || this.horde.phase === 'over') return;
    const it = this.loot.items.get(m.id);
    if (it && g.gate.hidesAt(it.x, it.z, it.y, p)) return; // lying inside a home they may not see into: not through its wall
    const s = p.state;
    const got = this.loot.take(name, { x: s.x, y: s.y, z: s.z, w: s.w, hp: p.hp, guns: [...(p.weapons ?? [])] }, m.id, now);
    if (!got) return;
    this.handOver(name, p, got);
    this.modes.send(); // the item is gone for everyone
  }

  /** `name` (player `p`) got `got` (picked up, or bought at the stall): its effect on the server, and their page told. */
  handOver(name, p, got) {
    const g = this.game;
    // What is in it is the server's: health back on its own count, a gun into the guns it checks each hit with.
    if (got.kind === 'medkit') p.hp = Math.min(LOOT.health, p.hp + got.heal);
    else if (got.kind === 'gun' || got.kind === 'rifle') p.weapons.add(got.w);
    g.send(p.ws, { t: 'zgift', kind: got.kind, w: got.w, kit: got.kit, ...(got.kind === 'medkit' ? { hp: p.hp } : {}) });
  }

  /** Whether `name` (player `p`) fights as the horde counts it (roster): armed, on foot. */
  fights(name, p) {
    return !!p?.state?.armed && !this.game.inCar(name);
  }

  /** `name`'s own page (and no other) gets their coins and what they bought: { t: 'zcoins', c, n }. */
  tell(name, p = this.game.players.get(name)) {
    if (p) this.game.send(p.ws, { t: 'zcoins', ...this.stall.view(name) });
  }

  /**
   * Wave `wave` is beaten: the wave bonus (shared/stall.mjs) for who fought in it (a fighter as the horde
   * counts them when it began: arming at its last moment, or sitting in a car, earns nothing), the full one
   * for who stands and fights now, the down share for who is down. Returns name -> what each got (paid).
   */
  bonus(wave) {
    const standing = [];
    const down = [];
    for (const [name, p] of this.game.players) {
      if (!this.waveFighters.has(name)) continue;
      if (this.down.has(name)) down.push(name);
      else if (p.alive && this.fights(name, p)) standing.push(name);
    }
    return this.stall.cleared(standing, down, wave);
  }

  /** Each one their own bonus line (bonus), and their coins. */
  paid(got) {
    for (const [name, n] of got) {
      const p = this.game.players.get(name);
      if (!p) continue;
      this.game.send(p.ws, { t: 'system', text: `Wave bonus: +${n} coins. The stall is open until the next wave.`, code: 'zBonus', args: { n } });
      this.tell(name, p);
    }
  }

  /**
   * A page buys one thing at the stall: `m.k`, the kind, its only field (the page never names coins, a
   * price, a count or a player). Checked in this order: the rate (refused messages count too), who
   * (the socket's player: here, alive, armed, not down, not in a car), the kind (one of the six), the
   * break (the server's phase now), the reach (the server's own position for the player, p.state, at
   * the place's stall: stallReach; the message's other fields are never read), the coins (the server's
   * own count) and what it gives (Loot.give on the server's position, health and guns); charged only
   * when it gave something. Refusals from the break on get a word why; every answer goes to the buyer's
   * page alone.
   */
  buy(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextBuy || 0)) return;
    p.nextBuy = now + 300;
    if (!this.players.has(name) || !p.alive || !p.state?.armed || this.down.has(name) || g.inCar(name)) return;
    const k = m.k;
    if (!sold(k)) return;
    const s = p.state;
    const r = this.stall.buy(this.loot, name, { x: s.x, y: s.y, z: s.z, w: s.w, hp: p.hp, guns: [...(p.weapons ?? [])] }, k, this.horde.phase, now, this.stallAt);
    if (r.got) this.handOver(name, p, r.got); // nothing public changed: no view for everyone
    else {
      const why = { shut: ['zStallShut', 'The stall is shut during a wave.'], far: ['zStallFar', 'Walk up to the stall to buy.'], short: ['zStallShort', "You don't have enough coins for that."], full: ['zStallFull', 'You have enough of that.'] }[r.why];
      if (why) g.send(p.ws, { t: 'system', text: why[1], code: why[0] });
    }
    this.tell(name, p);
  }

  /**
   * A zombie's swipe (event `e`) lands on `p`, unless they're out of it as game.zombieHurt has it: their
   * vest takes it first (shared/loot.mjs soak), the rest goes on as any swipe. A swipe the vest took
   * whole still counts as a hit: a teammate helping someone up lets go, and the page shows where from.
   */
  swipe(e, p, now) {
    const g = this.game;
    const name = e.name;
    if (!p.alive || !p.state?.armed || g.inCar(name) || now < (p.protectedUntil || 0) || g.calm(p)) return;
    const z = this.horde.zombies.get(e.id);
    const big = z?.kind === BIG;
    const before = this.loot.kits.get(name)?.armor ?? 0;
    const left = this.loot.soak(name, e.damage);
    if ((this.loot.kits.get(name)?.armor ?? 0) !== before) g.send(p.ws, { t: 'zgift', kind: 'kit', kit: this.loot.kit(name) });
    if (left <= 0) {
      p.hurtAt = now;
      g.send(p.ws, { t: 'hurt', hp: p.hp, by: big ? 'a big zombie' : 'a zombie', ...(z ? { from: { x: z.x, z: z.z } } : {}) });
      return;
    }
    g.zombieHurt(name, p, left, big, now, z);
  }

  /**
   * game.throwNade found none of the regular grenades back: `name` throws a spare, if they carry one
   * (on the server's count) and their last throw was LOOT.nadeGap ago. Their page gets the count left.
   */
  spareNade(name, p, now) {
    if (this.horde.phase === 'over' || now - (p.lastNade ?? 0) < LOOT.nadeGap) return false;
    if (!this.loot.spare(name)) return false;
    this.game.send(p.ws, { t: 'zgift', kind: 'kit', kit: this.loot.kit(name) });
    return true;
  }

  /**
   * A page places a claymore its player carries at `m` ({ x, y, z, yaw }): on a floor near where the
   * server has them (shared/loot.mjs place). Refused with a word why; everyone sees it placed.
   */
  place(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextMine || 0)) return;
    p.nextMine = now + 400;
    if (!p.alive || !p.state?.armed || g.inCar(name) || g.calm(p) || this.horde.phase === 'over') return;
    const s = p.state;
    // Inside a home they may not see into, where it is asked for or where it lands: no room, whatever is in there.
    const r = this.loot.place(name, { x: s.x, y: s.y, z: s.z }, { x: m.x, y: m.y, z: m.z, yaw: m.yaw }, now, this.hiddenFor(p));
    if (!r.mine) {
      const why = { none: ['zMineNone', 'You have no claymore.'], max: ['zMineMax', 'You have two down already.'], spot: ['zMineSpot', 'No room for it there.'] }[r.why];
      return g.send(p.ws, { t: 'system', text: why[1], code: why[0] });
    }
    g.send(p.ws, { t: 'zgift', kind: 'placed', kit: this.loot.kit(name) });
    this.modes.send();
  }

  /**
   * A page plants a row of the stakes its player carries at `m` ({ x, y, z, yaw }), as a claymore is
   * placed (shared/loot.mjs placeStakes: how far it goes is the server's, not the page's).
   */
  stakes(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextStakes || 0)) return;
    p.nextStakes = now + 400;
    if (!p.alive || !p.state?.armed || g.inCar(name) || g.calm(p) || this.horde.phase === 'over') return;
    const s = p.state;
    const r = this.loot.placeStakes(name, { x: s.x, y: s.y, z: s.z }, { x: m.x, y: m.y, z: m.z, yaw: m.yaw }, this.hiddenFor(p));
    if (!r.row) {
      const why = { none: ['zStakesNone', 'You have no stakes.'], max: ['zStakesMax', 'Enough stakes are down already.'], spot: ['zStakesSpot', 'No room for them there.'] }[r.why];
      return g.send(p.ws, { t: 'system', text: why[1], code: why[0] });
    }
    g.send(p.ws, { t: 'zgift', kind: 'placed', kit: this.loot.kit(name) });
    this.modes.send();
  }

  /**
   * A page sets up the turret its player carries at `m` ({ x, y, z, yaw }), as a claymore is placed;
   * from then on it aims and shoots on the server alone (shared/loot.mjs turretTick).
   */
  turret(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextTurret || 0)) return;
    p.nextTurret = now + 400;
    if (!p.alive || !p.state?.armed || g.inCar(name) || g.calm(p) || this.horde.phase === 'over') return;
    const s = p.state;
    const r = this.loot.placeTurret(name, { x: s.x, y: s.y, z: s.z }, { x: m.x, y: m.y, z: m.z, yaw: m.yaw }, now, this.hiddenFor(p));
    if (!r.turret) {
      const why = { none: ['zTurretNone', 'You have no turret.'], max: ['zTurretMax', 'Your turret is still going.'], all: ['zTurretAll', 'Enough turrets are up already.'], spot: ['zMineSpot', 'No room for it there.'] }[r.why];
      return g.send(p.ws, { t: 'system', text: why[1], code: why[0] });
    }
    g.send(p.ws, { t: 'zgift', kind: 'placed', kit: this.loot.kit(name) });
    this.modes.send();
  }

  /** Everyone down comes back at the house's outside start places, as after a respawn (not a death). */
  revive() {
    for (const r of [...this.helping.keys()]) this.letGo(r, 'stop');
    this.fell.clear();
    this.perchedOut.clear();
    const names = [...this.down].filter((n) => this.game.players.get(n) && !this.game.players.get(n).alive);
    this.down.clear();
    if (names.length) this.game.gather(names, this.arena); // back at the start, on the ground (not a teammate's help: that is up where you fell)
  }

  /** Everyone who fights is down: the result, the best wave ever (kept), the end screen. */
  over(now) {
    for (const r of [...this.helping.keys()]) this.letGo(r, 'stop');
    this.fell.clear();
    const wave = this.horde.wave;
    const names = [...this.players].filter((n) => this.game.players.has(n) || this.horde.beaten[n]);
    if (!this.custom && (!this.best || wave > this.best.wave)) {
      this.best = { wave, names: names.slice(0, 16), at: new Date(now).toISOString().slice(0, 10) };
      this.record = true;
      this.game.saveZombieBest(this.arena.id, this.best);
    }
    // The board of best runs: accounts only, never a chosen wave (game.zombieRun).
    if (!this.custom) this.game.zombieRun?.(this.arena.id, names, wave, this.horde.beaten);
    this.modes.finish(`The zombies caught everyone at wave ${wave}.${this.record ? " That's a new best ever!" : ''}`, this.record ? 'zOverBest' : 'zOver', { n: wave, best: this.best?.wave ?? 0 });
  }

  /**
   * A player helps a downed teammate up (`m.on` true: holding Use next to them) or lets go (false).
   * Refused in silence unless it could be (forged or instant revives): the helper up, on foot and not
   * down, the other down in this game, both here, within REVIVE_REACH on the server's positions, and
   * nobody else helping them. The time runs on the server's clock (helpTick): a page can't make it
   * shorter, and only its "let go" ends it early. At most four of these a second per player.
   */
  help(name, p, m, now) {
    const g = this.game;
    if (now < (p.nextRevive || 0)) return;
    p.nextRevive = now + 250;
    if (m.on !== true) return this.letGo(name, 'stop');
    const target = typeof m.name === 'string' ? m.name : '';
    const q = g.players.get(target);
    if (!q || target === name || q.alive || !this.down.has(target) || this.perchedOut.has(target) || this.horde.phase === 'over') return;
    if (!this.canHelp(name, p, now) || !this.near(p, target)) return;
    if (this.helping.get(name)?.target === target) return;
    for (const h of this.helping.values()) if (h.target === target) return; // someone else is helping them
    this.letGo(name, 'stop');
    this.helping.set(name, { target, since: now, hurt: p.hurtAt ?? 0 });
    g.send(p.ws, { t: 'revive', op: 'start', name: target, ms: REVIVE_MS });
    g.send(q.ws, { t: 'revive', op: 'start', by: name, ms: REVIVE_MS });
  }

  /**
   * Whether `name` may help someone up (game-logic bypass): they took part in this game and fight as
   * the horde counts it (armed, on foot), they are up, not down, not in a car and not in their own
   * moment of spawn protection.
   */
  canHelp(name, p, now) {
    return this.players.has(name) && !!p.alive && !!p.state?.armed && !this.down.has(name) && !this.game.inCar(name) && now >= (p.protectedUntil || 0);
  }

  /** Helper `p` near enough to help `target` up: from where the server has the helper to where `target` went down. */
  near(p, target) {
    const a = p.state;
    const b = this.fell.get(target) ?? this.game.players.get(target)?.state;
    return !!a && !!b && Math.hypot(a.x - b.x, a.z - b.z) <= REVIVE_REACH && Math.abs(a.y - b.y) < 1.5;
  }

  /** `name` stops helping (let go, moved away, hit, gone): both pages are told (`op`). */
  letGo(name, op) {
    const h = this.helping.get(name);
    if (!h) return;
    this.helping.delete(name);
    const g = this.game;
    const p = g.players.get(name);
    const q = g.players.get(h.target);
    if (p) g.send(p.ws, { t: 'revive', op, name: h.target });
    if (q) g.send(q.ws, { t: 'revive', op, by: name });
  }

  /** Every tick: each help still holds (both here, the helper up, near and not hurt since, the other still down); after REVIVE_MS they're up. */
  helpTick(now) {
    const g = this.game;
    for (const [r, h] of [...this.helping]) {
      const p = g.players.get(r);
      const q = g.players.get(h.target);
      if (!p || !q || q.alive || !this.down.has(h.target) || !this.canHelp(r, p, h.since) || (p.hurtAt ?? 0) > h.hurt || !this.near(p, h.target)) {
        this.letGo(r, 'stop');
        continue;
      }
      if (now - h.since < REVIVE_MS) continue;
      this.helping.delete(r);
      this.up(h.target, q, r, now);
    }
  }

  /** Helped up: up where they went down, with part of their health and a moment's safety; everyone told. */
  up(name, q, by, now) {
    const at = this.fell.get(name);
    if (at && q.state) {
      Object.assign(q.state, at);
      this.game.moved(q);
    }
    this.fell.delete(name);
    Object.assign(q, { alive: true, hp: REVIVE_HP, respawnAt: 0, protectedUntil: now + 2000 });
    this.down.delete(name);
    // Helped up inside a home: the place only to those who may see in; the others learn only that it happened.
    const msg = { t: 'revived', name, by, hp: REVIVE_HP };
    const home = at ? homeAt(at.x, at.z, at.y) : null;
    if (at) this.game.broadcastHome({ ...msg, x: at.x, y: at.y, z: at.z }, home);
    if (!at || home) for (const [, q] of this.game.players) if (!at || !this.game.gate.may(q, home)) this.game.send(q.ws, msg);
    this.modes.say(`${by} helped ${name} up.`, 'zRevived', { name: by, target: name });
    this.modes.send();
  }

  /** A player went down (game.zombieHurt or a hit): they wait for the end of the wave. Their vest is gone. */
  downed(name) {
    this.down.add(name);
    const k = this.loot.kits.get(name);
    if (k?.armor) {
      k.armor = 0;
      const p = this.game.players.get(name);
      if (p) this.game.send(p.ws, { t: 'zgift', kind: 'kit', kit: k });
    }
    const s = this.game.players.get(name)?.state;
    if (s && !this.fell.has(name)) this.fell.set(name, { x: s.x, y: s.y, z: s.z });
    this.downs[name] = (this.downs[name] ?? 0) + 1;
    this.modes.send();
  }

  /**
   * A page says one shot of weapon `m.w` hit zombies: `m.hits` = [[id, body, head], ...] (pellets on
   * each). Refused, in silence, unless it could be true; see the top of this file. The sniper's bullet
   * goes through (spec.pierce): two zombies, one bullet each, the second behind the first on the line
   * from the shooter through the first, on the server's positions; else only the nearer counts. Both
   * beaten by it: a double, in everyone's kill feed.
   */
  hit(name, p, m, now) {
    const g = this.game;
    const w = m.w;
    const spec = g.weaponSpec(w);
    const pierce = spec?.pierce ?? 1;
    if (!spec || spec.rocket || !Array.isArray(m.hits) || !m.hits.length || m.hits.length > (pierce > 1 ? pierce : MAX_HITS)) return;
    if (!p.alive || !p.state?.armed || !p.weapons.has(w) || p.state.w !== w || g.inCar(name) || g.calm(p)) return;
    if (this.horde.phase === 'over' || now < (p.nextZombie || 0)) return;
    const seen = new Set();
    let pellets = 0;
    const hits = [];
    for (const h of m.hits) {
      // [id, body, head], and since the leg hits a fourth: how many of the body's landed on the legs (never more than them).
      if (!Array.isArray(h) || (h.length !== 3 && h.length !== 4)) return;
      const [id, body, head, legs = 0] = h;
      if (!Number.isInteger(id) || !Number.isInteger(body) || !Number.isInteger(head) || body < 0 || head < 0 || body + head < 1 || seen.has(id)) return;
      if (!Number.isInteger(legs) || legs < 0 || legs > body) return;
      seen.add(id);
      pellets += body + head;
      if (pierce > 1 && body + head !== 1) return; // one bullet through each
      const z = this.horde.zombies.get(id);
      if (!z || z.act === 'down') continue; // gone or down already (another player's shot came first): no harm in that
      if (g.gate.hidesAt(z.x, z.z, z.y ?? 0, p)) continue; // inside a home this player may not see into (server/homeGate.mjs)
      const d = Math.hypot(z.x - p.state.x, z.z - p.state.z);
      if (d > MAX_RANGE) continue;
      hits.push({ id, amount: body * spec.body + head * spec.head, z, d, legs });
    }
    if (pellets > spec.pellets * (pierce > 1 ? m.hits.length : 1)) return;
    if (pierce > 1 && hits.length > 1) {
      // The nearer first; the other must be behind it on the shot's line.
      hits.sort((a, b) => a.d - b.d);
      const [a, b] = hits;
      const ax = a.z.x - p.state.x, az = a.z.z - p.state.z;
      const bx = b.z.x - p.state.x, bz = b.z.z - p.state.z;
      const along = (bx * ax + bz * az) / Math.max(a.d, 1e-3);
      const off = Math.abs(bx * az - bz * ax) / Math.max(a.d, 1e-3);
      const size = (a.z.kind === BIG ? 0.8 : 0.35) + (b.z.kind === BIG ? 0.8 : 0.35);
      if (!(along > a.d && off <= size + LINE_SLACK && Math.abs(b.z.y - a.z.y) < 2.5)) hits.length = 1;
    }
    p.nextZombie = now + spec.delay * 700; // 70% of the fire delay, for network jitter (as for hits on players)
    p.protectedUntil = 0; // shooting ends your own spawn protection
    let downs = 0;
    for (const h of hits) {
      if (h.legs > 0) this.horde.lame(h.id); // it limps from now on (if it still stands after this)
      if (this.damage(h.id, h.amount, name, w, now, pierce > 1 && downs === 1)) downs++;
    }
  }

  /** `name` fired gun `w` (game.mjs, the 'shot' it already checked): the zombies within its earshot stir. */
  noise(name, p, w, now) {
    if (this.horde.phase === 'over' || !p.state) return;
    this.horde.noise(p.state.x, p.state.z, w, now, name);
  }

  /** A blast (a rocket's or a grenade's, set off by `name`): every zombie near it on its floor loses health. */
  blast(name, at, radius, amount, w, now) {
    if (this.horde.phase === 'over') return;
    for (const [id, res] of this.horde.blast(at.x, at.z, radius, amount, name, now, Number.isFinite(at.y) ? at.y : null)) if (res === 'down') this.beat(id, name, w);
  }

  /** The panes broken now (game.broken): the zombies come through those that are out. */
  panes(broken) {
    this.horde.nav.setPanes(broken);
  }

  /** Zombie `id` takes `amount` from `by`; true when that beat it. `double`: a second one beaten by the same bullet. A turret's shot (`w` turret) doesn't make it flinch. */
  damage(id, amount, by, w, now, double = false) {
    if (this.horde.hit(id, amount, by, now, w !== 'turret') !== 'down') return false;
    this.beat(id, by, w, double);
    return true;
  }

  /** Zombie `id` is beaten by `by`: the kill feed (in friendly words on a paintball page), and the count left. `double`: the second of a double. */
  beat(id, by, w, double = false) {
    this.players.add(by);
    const at = this.horde.zombies.get(id);
    this.game.broadcastEvent({ t: 'zdown', id, by, w, ...(double ? { double: true } : {}) }, at && { x: at.x, y: at.y ?? 0, z: at.z }, by); // inside a home: only with its right; from inside one: without the name for the others
    // Maybe a reward where it fell (the wave's last leaves one when none fell yet).
    const z = this.horde.zombies.get(id);
    if (z) {
      // Its coins to whoever beat it (the kill count's `by`: the shooter, or a turret's or claymore's owner).
      this.stall.earn(by, z.kind);
      this.tell(by);
    }
    const fighters = [...this.game.players].filter(([, p]) => p.state?.armed).map(([n]) => n);
    // Every fighter carries a rifle (the server's own record of their guns): no rifle falls for nobody.
    const rifled = fighters.length > 0 && fighters.every((n) => this.game.players.get(n)?.weapons?.has('rifle'));
    if (z) this.loot.drop(z, Date.now(), this.horde.left === 0, fighters, rifled);
    this.modes.send();
  }

  /** The zombies for a tick (shared/wire.mjs): [id, x, z, yaw, state, hp, y], those up and those lying down. */
  entries() {
    return [...this.horde.zombies.values()].map((z) => zombieEntry(z));
  }

  /** A connection dropped: allow a live fighter to reconnect briefly, without reviving anyone. */
  leave(name, p, now) {
    if (p?.alive && p.state?.armed && this.players.has(name) && !this.down.has(name)) {
      this.away.set(name, { key: p.key, until: now + RECONNECT_MS });
    }
    this.letGo(name, 'stop');
    for (const [helper, h] of this.helping) if (h.target === name) this.letGo(helper, 'stop');
  }

  /** Someone joined: they take part; down when they left, they wait for the wave as before (no coming back early by reconnecting). */
  join(name, p) {
    this.players.add(name);
    if (this.away.get(name)?.key !== p?.key) this.away.delete(name);
    // Coins belong to a session, not a name: another session under a name that left starts at 0.
    if (p && this.purses.has(name) && this.purses.get(name) !== p.key) this.stall.forget(name);
    if (p) this.purses.set(name, p.key);
    this.horde.fieldAt = -Infinity;
    // Out of the place (just joined, at the house's start places): to its start, not just inside its edge (maybe in a wall).
    if (p?.state && !this.edge.inside(p.state.x, p.state.z) && !this.down.has(name)) this.game.gather([name], this.arena);
    if (p && this.loot.kits.has(name)) this.game.send(p.ws, { t: 'zgift', kind: 'kit', kit: this.loot.kit(name) }); // back: what they had
    if (p) this.tell(name, p); // and their coins (0 when none: never the last game's)
    if (this.down.has(name) && this.horde.phase === 'wave' && p) {
      p.alive = false;
      p.hp = 0;
      p.respawnAt = Infinity;
      this.game.send(p.ws, { t: 'kill', killer: 'a zombie', victim: name, head: false, w: 'zombie' });
    }
  }

  /** The game ends (stopped, or the end screen is over): the zombies go, and whoever is down comes back. */
  stop() {
    for (const r of [...this.helping.keys()]) this.letGo(r, 'stop');
    this.loot.clear();
    this.fell.clear();
    this.perchedOut.clear();
    this.away.clear();
    this.reconnecting = false;
    this.game.broadcast({ t: 'zgone', ids: [...this.horde.zombies.keys()] });
    this.horde.zombies.clear();
    const now = Date.now();
    for (const [, p] of this.game.players) if (!p.alive) p.respawnAt = now;
    this.down.clear();
  }
}
