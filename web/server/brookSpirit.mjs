// The Brook Spirit's fight when people play together (shared/brookSpirit.mjs runs it; this file feeds it and applies
// what it does). Made once for the open world, never for a room (Game's constructor), stepped from the game's tick.
//
// The server trusts no page here:
// - Who fights it is worked out each step from the server's own state alone (fighter): alive, armed, on foot (no car,
//   bike, horse or helicopter seat), not flying, in no parachute drop, past spawn protection, on no school ground and in
//   no home's inside, in the open world with no game running and no round break or freeze, within the leash of the grove
//   on the server's position for them. Only they are attacked, and only they can hurt it.
// - Its hits on players go through Game.npcDamage, as a strongman's do: the health, the death, the kill feed and the
//   respawn are the game's. A player it downed comes back at the wake spot on the lane (wakes, wakeSpot).
// - A page's `sphit` (hit) only says which parts its ray met with which gun; every check is the server's, cheapest
//   first: the shape, the sender a fighter, the gun carried and held (no rocket, no launcher), one clock per player at
//   70 % of the gun's delay (a refused message spends it too), the parts within reach of the server's positions, the
//   parts open or lit now (the simulation's own grace only). The damage is the gun's from shared/weapons.json, the name
//   the session's. Blasts are the server's own (blast, from Game.blast).
// - It sends `sp` to the pages within `wire.near` m of the grove and to the watch views (a change of mode to everyone),
//   `spe` for one-shot effects, and `system` lines with a `code`. Names go out as data, for textContent.
// Nothing is stored or logged: a restart brings it back asleep at once.
import { readFileSync } from 'node:fs';
import { blastSpirit, hurtSpirit, newSpirit, spiritPart, spiritWire, stepSpirit } from '../shared/brookSpirit.mjs';
import { SpiritLauncher } from './spiritLauncher.mjs';
import { trunkRadius } from '../shared/trees.mjs';
import { TICK_MS } from '../shared/wire.mjs';

export const DATA = JSON.parse(readFileSync(new URL('../shared/brookSpirit.json', import.meta.url), 'utf8'));
/** Who hurt a player, in the kill feed and the `hurt` message (src/i18n.ts whoName). */
export const BY = 'the brook spirit';
/** ms: at most one line (srv.spFly, srv.spFar) to a shooter this often */
export const TOLD_MS = 5000;
/** A `sphit` names at most this many parts */
export const MAX_PARTS = 3;
/** The share of a gun's delay one player's hits must keep apart (network jitter), as for hits on players and zombies */
const RATE = 0.7;
const fin = Number.isFinite;

/**
 * Test only: a shorter fight for tools/dev/spirit_ws_check.mjs, from the server's own environment: `SPIRIT_TEST_SCALE`
 * (0.01 to under 1) scales full health and the lights' health, `SPIRIT_TEST_BACK_S` (1 to under the data's) is the
 * return time. Never in production (NODE_ENV production, or any Railway variable at all), and nothing a page sends
 * reaches it. Null when nothing applies.
 */
export function testTuning(env = process.env) {
  if (!env || env.NODE_ENV === 'production' || Object.keys(env).some((k) => k.startsWith('RAILWAY_'))) return null;
  const out = {};
  const scale = Number(env.SPIRIT_TEST_SCALE);
  const back = Number(env.SPIRIT_TEST_BACK_S);
  if (fin(scale) && scale >= 0.01 && scale < 1) out.scale = scale;
  if (Number.isInteger(back) && back >= 1 && back < DATA.beaten.back) out.back = back;
  return Object.keys(out).length ? out : null;
}

/** The data with the test's tuning (testTuning), a copy; the data itself when there is none. */
function tuned(data, t) {
  if (!t) return data;
  const d = structuredClone(data);
  if (t.scale) {
    const k = (v) => Math.max(1, Math.round(v * t.scale));
    d.health.base = k(d.health.base);
    d.health.per = k(d.health.per);
    d.shell.lightHp = d.shell.lightHp.map(k);
    d.shell.lightPer = d.shell.lightPer.map(k);
  }
  if (t.back) d.beaten.back = t.back;
  return d;
}

/**
 * A `sphit`'s `h`: 1 to MAX_PARTS pairs [part, hits], parts distinct whole numbers from 0 (the heart) to `lights`, hits
 * whole numbers from 1, all hits together at most `pellets`. The pairs, or null.
 */
export function readParts(h, lights, pellets) {
  if (!Array.isArray(h) || h.length < 1 || h.length > MAX_PARTS) return null;
  const seen = new Set();
  let sum = 0;
  for (const pair of h) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [part, n] = pair;
    if (!Number.isInteger(part) || part < 0 || part > lights || seen.has(part)) return null;
    if (!Number.isInteger(n) || n < 1) return null;
    seen.add(part);
    sum += n;
  }
  return sum <= pellets ? h.map(([part, n]) => [part, n]) : null;
}

export class BrookSpirit {
  /**
   * `trees`: the house data's trees round the grove ({ x, z, h }); the trunks within `trunks.reach` of its middle are its
   * cover. `rand`: the dice. `env`: where the test's tuning is read (testTuning).
   */
  constructor(game, { trees = [], data = DATA, env = process.env, rand = Math.random } = {}) {
    this.game = game;
    this.d = tuned(data, testTuning(env));
    const g = this.d.grove;
    this.trunks = (Array.isArray(trees) ? trees : [])
      .filter((t) => t && fin(t.x) && fin(t.z) && fin(t.h) && Math.hypot(t.x - g.x, t.z - g.z) < this.d.trunks.reach)
      .map((t) => ({ x: t.x, z: t.z, r: trunkRadius(t.h) }));
    this.rand = rand;
    this.s = newSpirit(this.d);
    this.at = 0; // the last step's time (ms)
    this.shown = this.key(); // what the last `sp` showed: mode, act, lit lights, phase
    this.shownMode = this.s.mode;
    this.sentAt = 0;
    this.clocks = new Map(); // session key -> when its next `sphit` may count (a reconnect keeps it)
    this.told = new WeakMap(); // player -> when last told why their shots fade
    this.downed = new WeakMap(); // player -> when the spirit downed them (wakes)
    this.ticks = 0;
    /** The last time it was beaten: { by (everyone who hurt it, most first), drop (the hover point nearest), at }. */
    this.beaten = null;
    /** The grenade launcher it leaves (server/spiritLauncher.mjs): stepped from tick, fired from game.mjs `gl` and `boom`. */
    this.launcher = new SpiritLauncher(game, this.d.launcher);
    /** Called with `beaten` when it is beaten: the launcher's drop. */
    this.onBeaten = (b) => this.launcher.drop(b);
  }

  key() {
    const s = this.s;
    return `${s.mode}|${s.act}|${spiritWire(s).s[10]}|${s.phase}`;
  }

  /**
   * Whether `p` (`name`) may fight it now, from the server's own state: in reach of the grove first (the cheap test that
   * leaves out nearly everyone), then everything else.
   */
  fighter(name, p, now) {
    const g = this.game;
    const st = p?.state;
    if (!st || !fin(st.x) || !fin(st.z)) return false;
    const G = this.d.grove;
    if (Math.hypot(st.x - G.x, st.z - G.z) > G.leash) return false;
    if (g.room || g.modes.active || g.roundOver) return false;
    if (p.guard || !p.alive || !st.armed || st.flying || now < p.protectedUntil) return false;
    if (g.inCar(name) || g.horseOf(name) || g.dropping(p, now) || g.calm(p) || g.host?.holds(p)) return false;
    return !g.gate.insideOf(p);
  }

  /** The fighters now, as the simulation takes them. */
  fighters(now) {
    const out = [];
    for (const [name, p] of this.game.players) if (this.fighter(name, p, now)) out.push({ name, x: p.state.x, y: p.state.y, z: p.state.z });
    return out;
  }

  /** One step from the game's tick: absent (reset, asleep) while any game runs. */
  tick(now) {
    if (++this.ticks % 200 === 0) for (const [k, t] of this.clocks) if (t <= now) this.clocks.delete(k);
    this.launcher.step(now); // a game starting takes it away too
    if (this.game.modes.active) {
      if (this.s.mode !== 'asleep') this.s = newSpirit(this.d);
      this.at = now;
      this.sync(now);
      return;
    }
    const dt = this.at ? Math.min(0.5, Math.max(0, (now - this.at) / 1000)) : TICK_MS / 1000;
    this.at = now;
    this.apply(stepSpirit(this.s, this.fighters(now), now, dt, this.rand, this.trunks), now);
    this.sync(now);
  }

  /** `sp` on every change of mode, act or lit lights, and `wire.hz` times a second while awake. */
  sync(now) {
    const s = this.s;
    const key = this.key();
    const awake = s.mode === 'fight' || s.mode === 'mend' || s.mode === 'apart';
    if (key === this.shown && !(awake && now - this.sentAt >= 1000 / this.d.wire.hz)) return;
    const msg = { t: 'sp', ...spiritWire(s, now) };
    const all = s.mode !== this.shownMode;
    this.shown = key;
    this.shownMode = s.mode;
    this.sentAt = now;
    if (all) this.game.broadcast(msg);
    else this.near(msg);
  }

  /** `msg` to the pages within `wire.near` m of the grove (the server's positions) and to the watch views. */
  near(msg) {
    const g = this.game;
    const G = this.d.grove;
    const r = this.d.wire.near;
    for (const [, p] of g.players) {
      const st = p.state;
      if (!p.guard && p.ws && st && Math.hypot(st.x - G.x, st.z - G.z) <= r) g.send(p.ws, msg);
    }
    for (const w of g.watchers) g.send(w.ws, msg);
  }

  /** What a step or a hit made happen: hits on players, one-shot effects, the end. */
  apply(events, now) {
    for (const e of events) {
      if (e.type === 'hit') this.strike(e, now);
      else if (e.type === 'bolt') this.near({ t: 'spe', e: 'bolt', from: e.from, to: e.to, ms: e.ms });
      else if (e.type === 'sweep') this.near({ t: 'spe', e: 'sweep', from: e.from, to: e.to });
      else if (e.type === 'light') this.near({ t: 'spe', e: 'light', i: e.i });
      else if (e.type === 'cap' || e.type === 'burst' || e.type === 'back') this.near({ t: 'spe', e: e.type });
      else if (e.type === 'beaten') this.beat(e, now);
    }
  }

  /** Its hit on a fighter: through the game's own path for a strongman's (health, death, kill feed, respawn). */
  strike(e, now) {
    const g = this.game;
    const p = g.players.get(e.name);
    if (!p || !this.fighter(e.name, p, now)) return;
    g.npcDamage(e.name, p, e.damage, now, BY, { x: e.x, z: e.z });
    if (!p.alive) this.downed.set(p, { at: now, respawnAt: p.respawnAt }); // this death: its own respawn time
  }

  beat(e, now) {
    const names = e.names.slice(0, this.d.beaten.names);
    this.beaten = { by: [...e.by], drop: { ...e.drop }, at: now };
    this.near({ t: 'spe', e: 'beaten', names });
    if (names.length) this.game.broadcast({ t: 'system', text: `${names.join(', ')} sent the Brook Spirit back into the mist!`, code: 'spBeaten', args: { names } });
    this.onBeaten?.(this.beaten);
  }

  /** A shooter who is no fighter because they fly or stand past the leash: told why, at most once every TOLD_MS. */
  tell(p, now) {
    const st = p?.state;
    if (!st || !p.ws || this.game.modes.active || (this.s.mode !== 'fight' && this.s.mode !== 'mend')) return;
    const G = this.d.grove;
    const code = st.flying ? 'spFly' : Math.hypot(st.x - G.x, st.z - G.z) > G.leash ? 'spFar' : null;
    if (!code || now - (this.told.get(p) ?? -Infinity) < TOLD_MS) return;
    this.told.set(p, now);
    const text = code === 'spFly' ? 'The mist swallows shots from the air. Fight it on foot.' : 'Too far away: your shots fade in the mist. Come closer, among the trees.';
    this.game.send(p.ws, { t: 'system', text, code });
  }

  /**
   * A page says one shot of gun `m.w` hit the spirit's parts `m.h` ([part, hits], part 0 the heart, 1 to 8 a light).
   * Refused in silence unless it could be true (see the top of this file); the reason, for the tests: 'bad', 'who',
   * 'weapon', 'fast', 'far', 'shut', or what the simulation answered ('ok' when it counted). Never throws on any input.
   */
  hit(name, p, m, now) {
    const g = this.game;
    if (!p || typeof name !== 'string' || !fin(now)) return 'bad';
    const spec = m && typeof m === 'object' ? g.weaponSpec(m.w) : null;
    const parts = spec ? readParts(m.h, this.s.lights.length, spec.pellets) : null;
    // One clock per player, at the pace of the gun the server has them hold (never the one a message names): whatever
    // follows, a message spends its tick.
    const key = typeof p.key === 'string' ? p.key : `n:${name}`;
    const ready = now >= (this.clocks.get(key) ?? 0);
    const pace = g.weaponSpec(p.state?.w) ?? g.weaponSpec('pistol');
    if (ready) this.clocks.set(key, now + pace.delay * 1000 * RATE);
    if (!parts) return 'bad';
    if (!this.fighter(name, p, now)) {
      this.tell(p, now);
      return 'who';
    }
    if (spec.rocket || spec.lob || !p.weapons?.has?.(m.w) || p.state.w !== m.w) return 'weapon';
    if (!ready) return 'fast';
    const s = this.s;
    const st = p.state;
    for (const [part] of parts) {
      const at = part === 0 ? s : s.lights[part - 1];
      if (Math.hypot(at.x - st.x, at.y - st.y, at.z - st.z) > this.d.heart.range) return 'far';
    }
    for (const [part] of parts) if (!spiritPart(s, part, now)) return 'shut';
    const events = [];
    let dealt = 0;
    let why = null;
    for (const [part, n] of parts) {
      const r = hurtSpirit(s, name, part, n * spec.body, now);
      dealt += r.dealt;
      why ??= r.why ?? null;
      events.push(...r.events);
    }
    this.apply(events, now);
    this.sync(now);
    return dealt > 0 || events.length ? 'ok' : why ?? 'none';
  }

  /**
   * A blast of the server's own (Game.blast: a grenade or a rocket) at `at`, set off by `name` (`shooter`): the open
   * heart and the lit lights in reach take their share, when the thrower is a fighter now.
   */
  blast(name, shooter, at, w, radius, damage, now) {
    if ((w !== 'grenade' && w !== 'bazooka') || !at || !this.fighter(name, shooter, now)) return 0;
    const r = blastSpirit(this.s, at.x, at.y, at.z, radius, damage, name, now);
    this.apply(r.events, now);
    this.sync(now);
    return r.dealt;
  }

  /**
   * Whether `p`'s respawn now is at the wake spot: this death was its doing (a later death, after they were back some
   * other way, has a respawn time of its own), within `down.memory` s, and no game runs. Asked once per respawn.
   */
  wakes(p, now) {
    const d = this.downed.get(p);
    if (d === undefined) return false;
    this.downed.delete(p);
    return d.respawnAt === p.respawnAt && now - d.at <= this.d.down.memory * 1000 && !this.game.modes.active;
  }

  /** Where a fighter it downed comes back (Game.respawn's `at`): on the lane, facing the grove. */
  wakeSpot() {
    const w = this.d.wake;
    return { spawn: 0, x: w.x, y: w.y, z: w.z, face: [this.d.grove.x, this.d.grove.z] };
  }

  /** `welcome.spirit`: the spirit as `sp` carries it, and its launcher (`gl`). */
  view(now) {
    return { ...spiritWire(this.s, now), gl: this.launcher.view(now) };
  }
}
