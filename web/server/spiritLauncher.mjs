// The grenade launcher the Brook Spirit leaves when people play together (server/brookSpirit.mjs makes it and steps it;
// shared/brookSpirit.json `launcher` has its numbers). Alone the page has its own (src/world/spiritFight.ts).
//
// - Beaten, the spirit leaves one launcher at the hover point nearest to where it came apart, lying `lie` s. For the
//   first `first` s only the sessions that hurt it in that fight may take it, then anyone.
// - One per win (21 Nov 2026): a holder keeps theirs when the spirit is beaten again; the new win lays a new one. One
//   lies at a time (a new one replaces one lying unclaimed), one per session in hand, at most MOST_HELD held.
// - Taken by walking into it: alive, armed, on foot (no car, bike, horse or helicopter seat), not flying, in no drop, no
//   game running, within `across` / 2 m (and the player's own half width) across and `high` m in height of it, where the
//   server has them. With `rounds` grenades, counted here. Nothing a page sends takes it.
// - Its holder is a session (its key), never a name: another connection under the same name gets nothing.
// - Lost when its last grenade is fired, when any game starts, or `lost` s after its holder's connection dropped unless
//   the same session is back by then. Dropped where its holder goes down, with its grenades left, lying `dropLie` s, for
//   anyone (gone instead when they go down inside a home: every page hears where a launcher lies).
//
// Guarded against (the attack table: DECISIONS.md, "The Brook Spirit"):
// - forged pickup and a teleport to the reward: no message takes it; the take is derived each tick from the positions
//   the server keeps (held to the movement budgets and the edge by game.mjs); the first claim is the fighters' sessions;
// - weapon and ammo forgery: `gl` fires only for the holder's session, with grenades left; every tick each player's
//   guns are put right (the launcher in the holder's hands only, out of everyone else's);
// - rate abuse and reconnecting to reset the reload: the reload clock is kept with the launcher, not the connection;
//   the flood guard of Game.handle on top;
// - blast placement forgery: a launcher's `boom` needs a shot of the server's own record (`p.thrown`, `lob`), 80 ms to
//   its flight plus 3 s old, and goes off only within what that shot could reach from where the server had the shooter:
//   along the ground the shot's speed times its age (and a little slack for the network), never past `range`, never
//   higher than the shot could climb; the blast is Game.blast's own, a hand grenade's;
// - hit forgery: the launcher has no bullets (Game.hit, server/zombies.mjs hit and server/vehicleDamage.mjs hit refuse
//   a weapon with `lob`, as the spirit's `sphit` does).
// Nothing here is stored or logged.

import { readFileSync } from 'node:fs';

const WEAPONS = JSON.parse(readFileSync(new URL('../shared/weapons.json', import.meta.url), 'utf8'));
const SPEC = WEAPONS.launcher;
const LOB = SPEC.lob;
/** ms between two shots of one launcher: its reload (one grenade a load), with room for network jitter (as a rocket's). */
export const RELOAD_MS = Math.max(SPEC.delay, SPEC.reload) * 800;
/** m: a shot's start the page names may be this far from where the server has the shooter's hand, else the server's. */
export const FROM_SLACK = 3;
/** ms: a launcher's grenade goes off no sooner than this after its shot, and no later than its flight plus LATE_MS. */
export const EARLY_MS = 80;
export const LATE_MS = 3000;
/** s and m of slack on a shot's reach along the ground, for the network between the shot's message and its blast's. */
export const SLACK_S = 0.3;
export const SLACK_M = 2;
/**
 * At most this many launchers held at once, one per win: a win beyond it lays none (nobody told: no line fits, and the
 * fight's own end says it was won). Over an evening's hall of 30, three holders is plenty and keeps the fights fair.
 */
export const MOST_HELD = 3;
/** m: a player's own half width, added to the launcher's half box for a take (as the page's take alone). */
const BODY = 0.35;
const GRAVITY = 9.81;
const fin = Number.isFinite;

/**
 * A `gl`'s velocity, held to an honest shot's: at most LOB.speed along any line plus LOB.lift up (the gun gives the
 * grenade its speed along the view, and a little lift). Null when the numbers are not all finite.
 */
export function clampShot(vx, vy, vz) {
  if (![vx, vy, vz].every((v) => typeof v === 'number' && fin(v))) return null;
  let ux = vx;
  let uy = vy - LOB.lift;
  let uz = vz;
  const s = Math.hypot(ux, uy, uz);
  if (s > LOB.speed) {
    const k = LOB.speed / s;
    [ux, uy, uz] = [ux * k, uy * k, uz * k];
  }
  return { vx: ux, vy: uy + LOB.lift, vz: uz };
}

/**
 * Whether a launcher's grenade shot as `g` (from x, y, z at vx, vy, vz, the server's own record) may go off at `at`
 * `ageMs` after the shot: along the ground within its speed there times its age (with SLACK_S and SLACK_M), within
 * LOB.range of its start in all, and no higher than it could climb. Falling is not limited (from a roof, into a dip).
 */
export function inReach(g, at, ageMs) {
  if (!at || ![at.x, at.y, at.z].every((v) => typeof v === 'number' && fin(v))) return false;
  if (!(ageMs >= EARLY_MS && ageMs <= LOB.flight * 1000 + LATE_MS)) return false;
  const along = Math.hypot(at.x - g.x, at.z - g.z);
  const t = Math.min(ageMs / 1000, LOB.flight) + SLACK_S;
  if (along > Math.hypot(g.vx, g.vz) * t + SLACK_M) return false;
  if (Math.hypot(at.x - g.x, at.y - g.y, at.z - g.z) > LOB.range + SLACK_M) return false;
  const climb = Math.max(0, g.vy) ** 2 / (2 * GRAVITY) + 1;
  return at.y <= g.y + climb;
}

export class SpiritLauncher {
  /** `game`: the Game (server/game.mjs); `d`: shared/brookSpirit.json `launcher`. */
  constructor(game, d) {
    this.game = game;
    this.d = d;
    /** The launcher lying, or null: { at: 'lying', x, y, z, n, until, first: session keys or null, firstUntil }. One at most. */
    this.lying = null;
    /**
     * The launchers held, one per win (at most MOST_HELD): { at: 'held', key, name, n, next (ms: its next shot), away (ms:
     * when its holder's connection dropped, or 0) }. One per session.
     */
    this.held = [];
  }

  /** The launcher lying, else the first held, else null: the one launcher of a fight (the welcome's, the tests'). */
  get l() {
    return this.lying ?? this.held[0] ?? null;
  }

  /**
   * The spirit was beaten (BrookSpirit.onBeaten): a launcher lies at its drop, the fighters' sessions first. One per win:
   * whoever holds one from an earlier win keeps it (before, the new one took it out of their hands); one lying unclaimed
   * is replaced, not doubled; with MOST_HELD held already the win lays none (a server never fills with launchers).
   */
  drop(beaten) {
    const g = this.game;
    if (g.room || g.modes.active || !beaten?.drop || this.held.length >= MOST_HELD) return;
    const at = beaten.at;
    const first = new Set();
    for (const name of beaten.by ?? []) {
      const p = g.players.get(name);
      if (p && typeof p.key === 'string') first.add(p.key);
    }
    this.lie(beaten.drop, this.d.rounds, at, this.d.lie * 1000, first, at + this.d.first * 1000);
  }

  /** A launcher lies at `spot` with `n` grenades for `ms` (one lying before is gone); only sessions `first` may take it until `firstUntil`. */
  lie(spot, n, now, ms, first = null, firstUntil = 0) {
    this.lying = { at: 'lying', x: spot.x, y: spot.y, z: spot.z, n, until: now + ms, first, firstUntil };
    this.tell({ t: 'sgl', e: 'drop', x: spot.x, y: spot.y, z: spot.z, n, ms });
  }

  /**
   * A message about the launcher lying, to every page but the holders': their page takes its own launcher out of their
   * hands on any `drop` or `gone` (src/world/spiritFight.ts launcher, made for one launcher). A holder doesn't see one
   * lying (they can't take a second); told it when theirs is out of their hands (lose).
   */
  tell(msg) {
    const holders = new Set(this.held.map((h) => this.holder(h)?.p).filter(Boolean));
    if (!holders.size) return this.game.broadcast(msg);
    for (const [, p] of this.game.audience()) if (!holders.has(p)) this.game.send(p.ws, msg); // the watch views too, as broadcast
  }

  /** The launcher lying is gone (its time is up): every page but the holders' told. */
  lyingGone() {
    this.lying = null;
    this.tell({ t: 'sgl', e: 'gone' });
  }

  /**
   * Held launcher `h` is gone (emptied, its holder away too long, or down inside a home): out of their hands; their page
   * told it is gone, or, with one lying, shown that one instead (lie's `drop` takes theirs out of their hands too).
   */
  lose(h) {
    this.held = this.held.filter((x) => x !== h);
    const q = this.holder(h);
    this.disarm(h);
    const l = this.lying;
    if (!l) return this.tell({ t: 'sgl', e: 'gone' });
    if (q) this.game.send(q.p.ws, { t: 'sgl', e: 'drop', x: l.x, y: l.y, z: l.z, n: l.n, ms: Math.max(0, l.until - Date.now()) });
  }

  /** Every launcher gone (a game starts): out of every holder's hands, every page told. */
  gone() {
    const held = this.held;
    this.lying = null;
    this.held = [];
    for (const h of held) this.disarm(h);
    this.game.broadcast({ t: 'sgl', e: 'gone' });
  }

  /** The holder's connection now (the same session, whatever its name), or null. */
  holder(h = this.l) {
    if (h?.at !== 'held') return null;
    const g = this.game;
    const p = g.players.get(h.name);
    if (p?.key === h.key && p.ws) return { name: h.name, p };
    for (const [name, q] of g.players) if (q.key === h.key && q.ws && !q.guard) return { name, p: q };
    return null;
  }

  /** Whether `p` (`name`) may take it now, from the server's own state. */
  mayTake(name, p, now) {
    const g = this.game;
    const st = p?.state;
    if (!st || p.guard || !p.alive || !st.armed || st.flying) return false;
    if (g.inCar(name) || g.horseOf(name) || g.dropping(p, now)) return false;
    return true;
  }

  /**
   * One tick (from the spirit's): a game starting takes it away; a lying one whose time is up is gone, one lying is taken
   * by the first (in a random order) to walk into it; a held one falls where its holder went down, or is gone once its
   * holder's connection has been away `lost` s. Then everyone's guns are put right.
   */
  step(now) {
    const g = this.game;
    if ((this.lying || this.held.length) && g.modes.active) this.gone();
    const l = this.lying;
    if (l) {
      if (now >= l.until) this.lyingGone();
      else this.takes(l, now);
    }
    for (const h of [...this.held]) {
      const c = this.holder(h);
      if (!c) {
        h.away ||= now;
        if (now - h.away >= this.d.lost * 1000) this.lose(h);
        continue;
      }
      h.away = 0;
      h.name = c.name;
      if (c.p.alive) continue;
      // Down inside a home: gone, so that no page learns where in it (every page hears of a launcher lying). Else it
      // falls where they went down (one lying before is gone: lie).
      if (g.gate?.insideOf(c.p)) {
        this.lose(h);
        continue;
      }
      this.held = this.held.filter((x) => x !== h);
      this.disarm(h);
      const st = c.p.state;
      this.lie({ x: st.x, y: st.y, z: st.z }, h.n, now, this.d.dropLie * 1000);
    }
    this.armAll();
  }

  /** The lying launcher `l` into the hands of the first to stand on it. */
  takes(l, now) {
    const g = this.game;
    const reach = this.d.across / 2 + BODY;
    const names = [...g.players.keys()].sort(() => Math.random() - 0.5);
    for (const name of names) {
      const p = g.players.get(name);
      const st = p?.state;
      if (!st || !fin(st.x) || Math.hypot(st.x - l.x, st.z - l.z) > reach || Math.abs(st.y - l.y) > this.d.high) continue;
      if (!this.mayTake(name, p, now) || typeof p.key !== 'string') continue;
      if (this.held.some((h) => h.key === p.key)) continue; // one in their hands already: one each
      if (l.first && now < l.firstUntil && !l.first.has(p.key)) continue; // the fighters' first claim
      this.held.push({ at: 'held', key: p.key, name, n: l.n, next: 0, away: 0 });
      this.lying = null;
      g.broadcast({ t: 'sgl', e: 'taken', name, n: l.n }, name); // the others (a holder's page: nothing lay there); the holder hears its count (arm)
      return;
    }
  }

  /** Each player's guns as they should be: a launcher in its holder's hands only. */
  armAll() {
    const mine = new Map();
    for (const h of this.held) {
      const c = this.holder(h);
      if (c) mine.set(c.p, h);
    }
    for (const p of this.game.players.values()) this.arm(p, mine.has(p), mine.get(p)?.n);
  }

  /** `p` carries a launcher (with `n` grenades) when `on`, else not; their page is told when that changed (the count first). */
  arm(p, on, n = 0) {
    if (!p.weapons || p.weapons.has('launcher') === on) return;
    if (on) {
      this.game.send(p.ws, { t: 'sgl', e: 'left', n }); // before the guns: the page gives it with this count
      p.weapons.add('launcher');
    } else {
      p.weapons.delete('launcher');
      if (p.state?.w === 'launcher') p.state.w = 'pistol';
    }
    this.game.send(p.ws, { t: 'weapons', list: [...p.weapons] });
  }

  /** The launcher `h` held is out of its holder's hands (it fell, or is gone). */
  disarm(h) {
    const q = this.holder(h);
    if (q) this.arm(q.p, false);
  }

  /**
   * A `gl` from `name`'s page: their launcher fires one grenade from (x, y, z) at (vx, vy, vz). Refused in silence unless
   * it could be true; the reason, for the tests: 'bad', 'holder', 'empty', 'fast', 'who', or 'ok'. Never throws.
   */
  fire(name, p, m, now) {
    const g = this.game;
    if (!p || !m || typeof m !== 'object' || !fin(now)) return 'bad';
    const l = this.held.find((h) => h.key === p.key) ?? null; // the one in this session's hands
    const vel = clampShot(m.vx, m.vy, m.vz);
    if (!vel || ![m.x, m.y, m.z].every((v) => typeof v === 'number' && fin(v))) return 'bad';
    if (!l || this.holder(l)?.p !== p) return 'holder';
    if (l.n < 1) return 'empty';
    const st = p.state;
    if (!st || !p.alive || !st.armed || st.flying || g.roundOver || g.modes.active || g.room) return 'who';
    if (!p.weapons?.has('launcher') || st.w !== 'launcher') return 'who';
    if (g.inCar(name) || g.horseOf(name) || g.fightCalm(p) || g.host?.holds?.(p)) return 'who';
    if (now < l.next) return 'fast';
    l.next = now + RELOAD_MS;
    l.n--;
    p.protectedUntil = 0;
    let from = { x: m.x, y: m.y, z: m.z };
    if (Math.hypot(from.x - st.x, from.y - st.y - 1.5, from.z - st.z) > FROM_SLACK) from = { x: st.x, y: st.y + 1.5, z: st.z };
    p.thrown.push({ at: now, ...from, ...vel, lob: true, act: g.sight(p) }); // who could see whom at the shot (mayBlast)
    if (p.thrown.length > 8) p.thrown.shift();
    g.broadcastFrom({ t: 'nade', name, ...from, ...vel, l: 1 }, p, name);
    g.send(p.ws, { t: 'sgl', e: 'left', n: l.n });
    if (l.n === 0) this.lose(l);
    return 'ok';
  }

  /**
   * A launcher's grenade of `name`'s went off at (x, y, z) (`boom` with `l`): the oldest of their shots that may have
   * gone off there now, through the game's own blast; `cover` as for a hand grenade's (it can only spare). The reason,
   * for the tests: 'bad', 'none', 'far' or 'ok'.
   */
  boom(name, p, m, now) {
    const g = this.game;
    if (!p || !m || typeof m !== 'object' || !Array.isArray(p.thrown)) return 'bad';
    const at = { x: m.x, y: m.y, z: m.z };
    if (![at.x, at.y, at.z].every((v) => typeof v === 'number' && fin(v))) return 'bad';
    const live = p.thrown.filter((s) => s.lob && now - s.at >= EARLY_MS && now - s.at <= LOB.flight * 1000 + LATE_MS);
    if (!live.length) return 'none';
    const shot = live.find((s) => inReach(s, at, now - s.at));
    if (!shot) return 'far';
    p.thrown.splice(p.thrown.indexOf(shot), 1);
    const cover = new Set(Array.isArray(m.cover) ? m.cover.slice(0, g.players.size).filter((n) => typeof n === 'string') : []); // never more names than are in
    g.blast(name, at, 'grenade', cover, shot.act);
    return 'ok';
  }

  /** `welcome.spirit.gl`: the one lying ({ x, y, z, n, ms }), else one held ({ name, n }), or null. */
  view(now) {
    const l = this.l;
    if (l?.at === 'lying') return { x: l.x, y: l.y, z: l.z, n: l.n, ms: Math.max(0, l.until - now) };
    if (l?.at === 'held') return { name: l.name, n: l.n };
    return null;
  }
}
