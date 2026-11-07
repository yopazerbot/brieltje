// The footballs together (shared/ball.mjs): the server owns each ball. It runs the same steps as the page,
// with every player on foot near a ball walking into it from where the server last had them to where it has
// them now, and takes kicks from the pages ('kickball'). A kick is only a request: the server checks it
// against its own ball and its own idea of where the kicker is, and makes it fair before it applies it.
//
// - Remote kick forgery (kicking a ball from far away, or from the play tower): the kicker must be within
//   reach of the server's ball by the server's position of them (KICK.reach, with SLACK for the delay of
//   their updates), alive, on foot (not driving, riding or on a horse).
// - Impulse forgery (a ball fired at any speed, or down through the ground): a kick sets the ball's
//   velocity, never adds to it, capped at KICK.soft, or KICK.hard when the server saw them run (not when
//   the page says so), never down, never steeper than KICK.maxLift (shared/ball.mjs fairKick).
// - Flooding: at most one kick per KICK.every ms per player, on top of the server's per-player message
//   limits (server/game.mjs handle); a refused kick costs one lookup and is not answered.
// - Nothing from a page goes anywhere else: the ball's id must be one of ours (an own property of the map,
//   never the prototype), the kick's sequence number is a small whole number or 0.
//
// The ball's state goes to the players within its pitch's `near`, ten times a second while it moves, at once
// after a kick, a goal or a hard bounce, and once when it comes to rest; a player coming near gets it once.

import { BALL, fairKick, inReach, KICK, kickBall, makePitch, newBall, PITCHES, stepBall } from '../shared/ball.mjs';

/** m: how much further the server lets a kick reach than the page, for the delay of the kicker's updates. */
export const SLACK = 0.8;
const EVERY = 2; // ticks between states while it moves (ten a second)
const TRAIL = 4; // ticks a player's run is measured over (0.2 s): a hard kick needs that pace
const NEAR = 30; // m: players this close to a ball are walked into it
const TELEPORT = 2; // m in one tick: a portal or a respawn, not a walk through the ball
const SCORE_IDLE_MS = 10 * 60_000; // the score is back to 0-0 when nobody has touched the ball this long

const mono = () => Math.round(performance.now());
const round = (v, k) => Math.round(v * k) / k;

export class Football {
  /** `height(x, z)`: the ground's height in the game (the model's ground plus the relief). */
  constructor(height, clock = mono) {
    this.clock = clock;
    this.balls = new Map();
    for (const spec of PITCHES) {
      const pitch = makePitch(spec, height);
      this.balls.set(spec.id, { id: spec.id, pitch, ball: newBall(pitch), ticks: 0, dirty: false, rested: true, touched: 0, kicks: [], home: false });
    }
    this.last = clock();
    // Per player (the object for their connection, so a new connection starts fresh): their last positions,
    // one per tick, and which balls they have been told about.
    this.trail = new WeakMap();
    this.told = new WeakMap();
  }

  /** A ball by id (only our own: never anything from the map's prototype). */
  get(id) {
    return typeof id === 'string' && this.balls.has(id) ? this.balls.get(id) : null;
  }

  /** m/s across: how fast the server saw this player go over the last TRAIL ticks. */
  pace(p) {
    const t = this.trail.get(p);
    if (!t || t.length < 2) return 0;
    const a = t[0], b = t[t.length - 1];
    const secs = (b.at - a.at) / 1000;
    return secs > 0 ? Math.hypot(b.x - a.x, b.z - a.z) / secs : 0;
  }

  /**
   * A page asks to kick: `m` { b: ball id, v: [vx, vy, vz], q: its own count of kicks }. `onFoot`: not
   * driving, riding along or on a horse. True when the kick was applied.
   */
  kick(name, p, m, now, onFoot) {
    const e = this.get(m.b);
    const s = p.state;    if (!e || !s || !p.alive || !onFoot || s.flying || s.chute) return false;
    if (now - (p.kickedAt ?? -Infinity) < KICK.every) return false;
    if (!inReach(e.ball, s.x, s.y, s.z, SLACK)) return false;
    const max = this.pace(p) >= KICK.run ? KICK.hard : KICK.soft;
    const v = fairKick(m.v, max);
    if (!v || !kickBall(e.ball, v, name)) return false;
    p.kickedAt = now;
    e.kicks.push([name, Number.isInteger(m.q) && m.q >= 0 && m.q < 2 ** 31 ? m.q : 0]);
    e.touched = now;
    e.dirty = true;
    return true;
  }

  /**
   * Every tick: each ball moves on (walked into by the players on foot near it), and the players near it
   * hear what it did. `players`: the game's map of name -> player; `onFoot(name)`; `send(p, msg)`.
   */
  tick(players, now, onFoot, send) {
    const t = this.clock();
    const dt = Math.min(BALL.maxStep, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    const movers = new Map(); // ball id -> its movers
    for (const [name, p] of players) {
      const s = p.state;
      if (!s) continue;
      let trail = this.trail.get(p);
      if (!trail) this.trail.set(p, (trail = []));
      const prev = trail[trail.length - 1];
      trail.push({ x: s.x, z: s.z, at: t });
      if (trail.length > TRAIL + 1) trail.shift();
      if (!prev || !p.alive || !onFoot(name) || s.flying || s.chute) continue;
      const jump = Math.hypot(s.x - prev.x, s.z - prev.z) > TELEPORT;
      if (jump) trail.splice(0, trail.length - 1); // a portal or a respawn: their pace starts again
      for (const e of this.balls.values()) {
        if (Math.hypot(s.x - e.ball.x, s.z - e.ball.z) > NEAR) continue;
        if (!movers.has(e.id)) movers.set(e.id, []);
        movers.get(e.id).push(jump ? { x0: s.x, z0: s.z, x1: s.x, z1: s.z, feet: s.y, name } : { x0: prev.x, z0: prev.z, x1: s.x, z1: s.z, feet: s.y, name });
      }
    }
    for (const e of this.balls.values()) {
      const b = e.ball;
      const wasAsleep = b.asleep;
      const events = dt > 0 ? stepBall(b, e.pitch, dt, movers.get(e.id) ?? []) : [];
      const goals = [];
      for (const ev of events) {
        if (ev.kind === 'goal') goals.push(ev.goal);
        if (ev.kind === 'home') e.home = true;
        if (ev.kind === 'touch') e.touched = now;
        if (ev.kind !== 'bounce' || ev.speed > 3) e.dirty = true;
      }
      if (b.score.some((n) => n > 0) && now - e.touched > SCORE_IDLE_MS && b.asleep) {
        b.score.fill(0);
        e.dirty = true;
      }
      if (!b.asleep || !wasAsleep) e.ticks++;
      const rest = b.asleep && !e.rested; // it came to rest: once more, so everyone has it lying where it lies
      e.rested = b.asleep;
      const due = e.dirty || rest || (!b.asleep && e.ticks % EVERY === 0);
      // Who is near enough to care: they get every state; who just came near gets this one whatever it is.
      const msg = this.state(e, t);
      const scored = goals.map((g) => ({ t: 'ballgoal', b: e.id, g, by: b.last, sc: b.score }));
      for (const [, p] of players) {
        const s = p.state;
        let told = this.told.get(p);
        if (!told) this.told.set(p, (told = new Set()));
        const near = !!s && Math.hypot(s.x - e.pitch.home.x, s.z - e.pitch.home.z) < e.pitch.near;
        if (!near) {
          told.delete(e.id);
          continue;
        }
        if (due || !told.has(e.id)) send(p, msg);
        told.add(e.id);
        for (const g of scored) send(p, g);
      }
      e.dirty = false;
      e.home = false;
      e.kicks = [];
    }
  }

  /** A ball's state for the pages: where, how fast, asleep, in the net, the score; the kicks since the last (who and their count). */
  state(e, t) {
    const b = e.ball;
    const msg = {
      t: 'ball', b: e.id, st: t,
      p: [round(b.x, 1000), round(b.y, 1000), round(b.z, 1000), round(b.vx, 100), round(b.vy, 100), round(b.vz, 100)],
      s: b.asleep ? 1 : 0, n: b.netted > 0 ? 1 : 0, sc: b.score,
    };
    if (e.kicks.length) msg.k = e.kicks;
    if (e.home) msg.r = 1;
    return msg;
  }
}
