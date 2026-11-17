// Steal the flag's bazookas (Yoshi, 17 Nov 2026: "make sure teams can get a bazooka in a fair way to shoot down enemy
// helicopters"): one launcher a team, on a rack at its own base (shared/flagFields.mjs `rack`), the same rules for both.
// Driven from server/flags.mjs (its step and its end); game.mjs asks `fire` before a rocket leaves.
//
// - A player of the rack's team takes it by walking into it: alive, armed, on foot (no car, bike, horse, helicopter,
//   drop or free flight), within TAKE m across and HIGH m in height of the rack, where the server has them. Only the
//   rack's own team; one holder a team.
// - It comes with ROCKETS rockets and no reload from anywhere else; the bazooka's own reload time stays between shots
//   (game.mjs rocket).
// - Back on the rack FIRED_MS after its last rocket, or LOST_MS after its holder goes down, leaves the game or changes
//   team. Nobody else may carry a bazooka while the game is played: the admin's own is out of their loadout too, and back
//   when it ends (`end`).
//
// Guarded against (the attack table: DECISIONS.md, "Steal the flag: a helicopter for each team"):
// - weapon and ammo forgery: no message takes, holds or fills a launcher. The pickup is derived each tick from the
//   positions the server keeps (held to the movement budgets, the field's edge and the seats by game.mjs); the rockets
//   are counted here; a rocket leaves only from the holder of their own team's launcher with rockets left (`fire`), on
//   top of game.mjs rocket's checks (the weapon carried and held, alive, not seated, off the school grounds, the reload);
// - position spoofing for the pickup: the same positions every flag event is derived from; a page's claim of where it
//   stands is never read here;
// - hit forgery: unchanged, a rocket hurts only through the server's own blast at the end of its flight (game.mjs).
// Nothing here is stored or logged.

import { readFileSync } from 'node:fs';
import { FLAG_TEAMS } from '../shared/flagFields.mjs';

const WEAPONS = JSON.parse(readFileSync(new URL('../shared/weapons.json', import.meta.url), 'utf8'));
/** The admin's own weapons (game.mjs ADMIN_WEAPONS): out of their hands while the game is played, back after it. */
const ADMIN_WEAPONS = Object.keys(WEAPONS).filter((w) => WEAPONS[w].admin);

/** Rockets in a launcher taken from the rack. */
export const ROCKETS = 3;
/** Between two rockets of one launcher: the bazooka's reload, with room for network jitter (as game.mjs rocket). */
const RELOAD_MS = WEAPONS.bazooka.reload * 800;
/** ms after its last rocket before a fresh launcher is on the rack. */
export const FIRED_MS = 45_000;
/** ms after its holder went down, left or changed team before it is back on the rack. */
export const LOST_MS = 20_000;
/** m across from the rack to a player's middle, and m in height between their feet and the rack's foot, for a take. */
export const TAKE = 1.6;
export const HIGH = 2.2;

export class FlagBazooka {
  /** `game`: the Game (server/game.mjs); `flags`: the FlagGame (server/flags.mjs), for its field, teams and touch rule. */
  constructor(game, flags) {
    this.game = game;
    this.flags = flags;
    /** team -> its launcher: on the 'rack', 'held' (by a name, `left` rockets) or 'away' (back at `until`) */
    this.racks = Object.fromEntries(FLAG_TEAMS.map((t) => [t, { at: 'rack', by: null, left: 0, until: 0 }]));
    /** Something every page sees changed (Modes.send on the next tick) */
    this.dirty = false;
    this.over = false;
  }

  /** The rack's spot of `team`: [x, z, y]. */
  spot(team) {
    return this.flags.field.bases[team].rack;
  }

  /** Whether `name` holds their team's launcher now, rockets or not. */
  holds(name) {
    return FLAG_TEAMS.some((t) => this.racks[t].at === 'held' && this.racks[t].by === name);
  }

  /** The launcher of `team` is away from its holder: back on the rack `ms` from now. */
  away(team, now, ms) {
    Object.assign(this.racks[team], { at: 'away', by: null, left: 0, until: now + ms });
    this.dirty = true;
  }

  /**
   * One tick: a holder who went down, left or changed team loses it (back in LOST_MS), a launcher whose time is up is
   * back on its rack, one on its rack is taken by the first of its team to walk into it (in a random order, as the
   * flags), and everyone's guns are what they should be (a bazooka for the holders only). True when every page needs
   * the game's view again.
   */
  step(now) {
    if (this.over) return false;
    const g = this.game;
    const teams = this.flags.teams;
    for (const team of FLAG_TEAMS) {
      const r = this.racks[team];
      if (r.at === 'held') {
        const p = g.players.get(r.by);
        if (!p || !p.alive || teams[r.by] !== team) this.away(team, now, LOST_MS);
      } else if (r.at === 'away' && now >= r.until) {
        Object.assign(r, { at: 'rack', until: 0 });
        this.dirty = true;
      }
    }
    const names = [...g.players.keys()].sort(() => Math.random() - 0.5);
    for (const team of FLAG_TEAMS) {
      const r = this.racks[team];
      if (r.at !== 'rack') continue;
      const [x, z, y] = this.spot(team);
      for (const name of names) {
        const p = g.players.get(name);
        if (teams[name] !== team || !p.state?.armed || g.bikeOf?.(name) || !this.flags.canTouch(name, p, now)) continue; // on foot: a flag may be taken from a bike, the launcher not
        const st = p.state;
        if (Math.hypot(st.x - x, st.z - z) > TAKE || Math.abs(st.y - y) > HIGH) continue;
        Object.assign(r, { at: 'held', by: name, left: ROCKETS, until: 0, next: 0 });
        this.dirty = true;
        // Their team (its members only: the other team gets no line) hears who has it; the holder how many rockets (arm).
        for (const [n, q] of g.players) if (teams[n] === team) g.send(q.ws, { t: 'fbz', ev: 'taken', team, name, n: ROCKETS });
        this.arm(name, p, true);
        break;
      }
    }
    // Everyone's guns: a bazooka only in a holder's hands (the admin's own too, after a respawn or a join).
    for (const [name, p] of g.players) this.arm(name, p, this.holds(name));
    const dirty = this.dirty;
    this.dirty = false;
    return dirty;
  }

  /** Player `name` carries a bazooka when `on`, else none; their page is told when that changed. */
  arm(name, p, on) {
    if (!p.weapons || p.weapons.has('bazooka') === on) return;
    if (on) p.weapons.add('bazooka');
    else p.weapons.delete('bazooka');
    this.game.send(p.ws, { t: 'weapons', list: [...p.weapons] });
    // Back in a holder's hands after a new connection: their page is told the rockets left again.
    const r = on ? FLAG_TEAMS.map((t) => this.racks[t]).find((k) => k.at === 'held' && k.by === name) : null;
    if (r) this.game.send(p.ws, { t: 'fbz', ev: 'left', n: r.left });
  }

  /**
   * A rocket of `name`'s is about to leave (game.mjs rocket, its own checks passed): only from the holder of their own
   * team's launcher, a rocket left, the game still on. Counts it. After the last the launcher is gone from their hands
   * and a fresh one is on the rack FIRED_MS later. True when it may go.
   */
  fire(name, p, now) {
    if (this.over) return false;
    const team = this.flags.teams[name];
    const r = team ? this.racks[team] : null;
    if (!r || r.at !== 'held' || r.by !== name || r.left < 1) return false;
    // The reload is kept with the launcher, not only with the player's connection (game.mjs nextRocket): a holder who
    // reconnects gets a fresh player record, and would fire all three at once (fire-rate forgery).
    if (now < (r.next || 0)) return false;
    r.next = now + RELOAD_MS;
    r.left--;
    this.game.send(p.ws, { t: 'fbz', ev: 'left', n: r.left });
    if (r.left === 0) {
      this.away(team, now, FIRED_MS);
      this.arm(name, p, false);
    }
    return true;
  }

  /**
   * The game is over or stopped: every launcher out of everyone's hands, the racks gone, and the admin's own bazooka back
   * in their loadout (shared/loadout.mjs's rule outside the game).
   */
  end() {
    if (this.over) return;
    this.over = true;
    for (const t of FLAG_TEAMS) Object.assign(this.racks[t], { at: 'away', by: null, left: 0, until: 0 });
    for (const p of this.game.players.values()) {
      if (!p.weapons) continue;
      const had = [...p.weapons].join();
      if (p.role === 'admin') for (const w of ADMIN_WEAPONS) p.weapons.add(w);
      else p.weapons.delete('bazooka');
      if ([...p.weapons].join() !== had) this.game.send(p.ws, { t: 'weapons', list: [...p.weapons] });
    }
  }

  /** What every page gets (in the flag view): each rack 'rack' or 'out' (held or away; with `ms` until it is back when known). */
  view(now) {
    const out = {};
    for (const t of FLAG_TEAMS) {
      const r = this.racks[t];
      out[t] = r.at === 'rack' ? { at: 'rack' } : r.at === 'away' && r.until ? { at: 'out', ms: Math.max(0, r.until - now) } : { at: 'out' };
    }
    return out;
  }
}
