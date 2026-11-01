// The Zombies party game on the server (server/modes.mjs starts and stops it; shared/zombies.mjs
// runs the horde). Everyone is one team round the house and the bungalow; the zombies come in
// waves. The server keeps all of it: where every zombie is and what it does, its health, every hit
// on it and every swipe it lands. A page only says "my shot hit zombie 12" (zhit), and that is
// checked the way a hit on a strongman is (game.mjs clownhit): a weapon the player carries and
// holds, its fire rate, alive, armed, not on the school grounds, and here also a zombie that is up,
// within MAX_RANGE, and no more pellets than the gun fires. Blasts are set off on the server (a
// rocket) or checked there (a grenade), and hurt zombies through Horde.blast.
//
// The house and the bungalow are open as at any time together: the zombies follow the players in,
// up the stairs and through the doors (a shut one a zombie shoves open: game.zombieDoor, for every
// page) and through a pane that was shot out (panes). A swipe never goes through a wall, a floor, a
// whole pane or a shut door. Whoever stands where no zombie can get at them (a ledge, or a page that
// claims to hover or stand in a wall) is warned, and out of the wave if they stay (perch).
//
// Who goes down waits for the end of the wave (their page shows it), then everyone comes back at
// the house's outside start places. When everyone who fights is down at once, the game is over: the
// wave reached, each player's zombies beaten and the best wave ever (kept in the database's meta
// table, as the rules are) show for DONE_MS.

import { BIG, bigOf, Horde } from '../shared/zombies.mjs';
import { zombieEntry } from '../shared/wire.mjs';

export const DONE_MS = 15_000;
const BEST_KEY = 'zombies_best';
const MAX_RANGE = 100; // m from the shooter to the zombie, on the server's positions
const MAX_HITS = 8; // zombies one shot can claim (the shotgun's eight pellets)
/**
 * m: how far off the shot's line (from the shooter through the first zombie, on the server's
 * positions) the second zombie of a sniper's double may stand: its size and the time it moved while
 * the shot came here.
 */
const LINE_SLACK = 0.65;

export class ZombieGame {
  /** A new game for the players `names` (gathered at the house by modes.start); `best`: the best wave ever so far. */
  constructor(game, modes, names, now) {
    this.game = game;
    this.modes = modes;
    const { nav, spots, home, doors, doorOpen } = game.zombieGround();
    this.horde = new Horde(nav, spots, { home, doors, doorOpen });
    this.horde.start(now);
    /** Who took part (any time in this game), and who is down until the wave is beaten */
    this.players = new Set(names);
    this.down = new Set();
    /** Player name -> times down in this game (the scoreboard's column) */
    this.downs = Object.create(null);
    this.best = game.zombieBest;
    this.record = false;
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
      down: [...this.down].filter(here), downs: { ...this.downs }, best: this.best, record: this.record,
    };
  }

  /** The game's phase and clock in the modes' state (for its view, and the edge that holds: game.mjs fenced). */
  sync() {
    const s = this.modes.state;
    if (s.z !== this || s.phase === 'done') return;
    s.phase = this.phase;
    s.until = this.horde.until;
  }

  /** Every tick (`dt` in ms): the horde's step, and what came of it. */
  tick(now, dt) {
    const g = this.game;
    let changed = false;
    const events = this.horde.tick(now, dt / 1000, this.roster(now));
    this.sync();
    for (const e of events) {
      if (e.type === 'wave') {
        // Everyone who fights is counted for the wave's size; the line says how many come.
        const code = e.bigs > 1 ? 'zWaveBigs' : e.big ? 'zWaveBig' : 'zWave';
        const more = e.bigs > 1 ? ' Big ones are with them!' : e.big ? ' A big one is with them!' : '';
        this.modes.say(`Wave ${e.wave}: ${e.count} zombies are coming!${more}`, code, { n: e.wave, count: e.count });
        changed = true;
      } else if (e.type === 'swipe') {
        const p = g.players.get(e.name);
        if (p) g.zombieHurt(e.name, p, e.damage, this.horde.zombies.get(e.id)?.kind === BIG, now);
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
          this.modes.say(`${e.name} stayed out of the zombies' reach and is out of this wave.`, 'zPerchOut', { name: e.name });
          g.npcDamage(e.name, p, p.hp, now, 'a zombie');
        }
      } else if (e.type === 'cleared') {
        this.revive();
        this.modes.say(`Wave ${e.wave} beaten! The next one comes in 15 seconds.`, 'zCleared', { n: e.wave });
        changed = true;
      } else if (e.type === 'gone') {
        g.broadcast({ t: 'zgone', ids: e.ids });
      } else if (e.type === 'over') {
        this.over(now);
        return;
      }
    }
    if (changed) this.modes.send();
  }

  /** Everyone down comes back at the house's outside start places, as after a respawn (not a death). */
  revive() {
    const names = [...this.down].filter((n) => this.game.players.get(n) && !this.game.players.get(n).alive);
    this.down.clear();
    if (names.length) this.game.gather(names);
  }

  /** Everyone who fights is down: the result, the best wave ever (kept), the end screen. */
  over(now) {
    const wave = this.horde.wave;
    const names = [...this.players].filter((n) => this.game.players.has(n) || this.horde.beaten[n]);
    if (!this.best || wave > this.best.wave) {
      this.best = { wave, names: names.slice(0, 16), at: new Date(now).toISOString().slice(0, 10) };
      this.record = true;
      this.game.saveZombieBest(this.best);
    }
    this.modes.finish(`The zombies caught everyone at wave ${wave}.${this.record ? " That's a new best ever!" : ''}`, this.record ? 'zOverBest' : 'zOver', { n: wave, best: this.best.wave });
  }

  /** A player went down (game.zombieHurt or a hit): they wait for the end of the wave. */
  downed(name) {
    this.down.add(name);
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
      if (!Array.isArray(h) || h.length !== 3) return;
      const [id, body, head] = h;
      if (!Number.isInteger(id) || !Number.isInteger(body) || !Number.isInteger(head) || body < 0 || head < 0 || body + head < 1 || seen.has(id)) return;
      seen.add(id);
      pellets += body + head;
      if (pierce > 1 && body + head !== 1) return; // one bullet through each
      const z = this.horde.zombies.get(id);
      if (!z || z.act === 'down') continue; // gone or down already (another player's shot came first): no harm in that
      const d = Math.hypot(z.x - p.state.x, z.z - p.state.z);
      if (d > MAX_RANGE) continue;
      hits.push({ id, amount: body * spec.body + head * spec.head, z, d });
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
    for (const h of hits) if (this.damage(h.id, h.amount, name, w, now, pierce > 1 && downs === 1)) downs++;
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

  /** Zombie `id` takes `amount` from `by`; true when that beat it. `double`: a second one beaten by the same bullet. */
  damage(id, amount, by, w, now, double = false) {
    if (this.horde.hit(id, amount, by, now) !== 'down') return false;
    this.beat(id, by, w, double);
    return true;
  }

  /** Zombie `id` is beaten by `by`: the kill feed (in friendly words on a paintball page), and the count left. `double`: the second of a double. */
  beat(id, by, w, double = false) {
    this.players.add(by);
    this.game.broadcast({ t: 'zdown', id, by, w, ...(double ? { double: true } : {}) });
    this.modes.send();
  }

  /** The zombies for a tick (shared/wire.mjs): [id, x, z, yaw, state, hp, y], those up and those lying down. */
  entries() {
    return [...this.horde.zombies.values()].map((z) => zombieEntry(z));
  }

  /** Someone joined: they take part; down when they left, they wait for the wave as before (no coming back early by reconnecting). */
  join(name, p) {
    this.players.add(name);
    if (this.down.has(name) && this.horde.phase === 'wave' && p) {
      p.alive = false;
      p.hp = 0;
      p.respawnAt = Infinity;
      this.game.send(p.ws, { t: 'kill', killer: 'a zombie', victim: name, head: false, w: 'zombie' });
    }
  }

  /** The game ends (stopped, or the end screen is over): the zombies go, and whoever is down comes back. */
  stop() {
    this.game.broadcast({ t: 'zgone', ids: [...this.horde.zombies.keys()] });
    this.horde.zombies.clear();
    const now = Date.now();
    for (const [, p] of this.game.players) if (!p.alive) p.respawnAt = now;
    this.down.clear();
  }
}
