import * as THREE from 'three';
import HELIS from '../shared/heli.json';
import { AWAY, EV, HELI, heliBump, heliJump } from '../shared/heli.mjs';
import { homeAt, inEndGarden } from '../shared/homes.mjs';
import { DROP, jumpStart } from '../shared/parachute.mjs';
import type { FrameInput, Input } from './controls/input';
import { t } from './i18n';
import { key, type Control } from './shortcuts';
import { HeliHud } from './ui/heliHud';
import type { CrashHit, Obstacle } from './world/car';
import type { World } from './world/collision';
import { Heli, type Crown, type HeliView } from './world/heli';
import { groundPads, PADS, testDeck } from './world/heliPads';

const _dir = new THREE.Vector3();

/**
 * A machine in a server message (`heli`, `welcome.helis`), checked as it arrives: a string id, finite numbers (else 0),
 * angles within a turn, the rotor 0 to 1, four seats each a name or null. Names reach the screen only through the
 * figures' name tags (textContent). Null when it isn't one.
 */
export function heliView(v: unknown): HeliView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const n = (k: string, lo = -1e5, hi = 1e5) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? Math.max(lo, Math.min(hi, o[k] as number)) : 0);
  const seats = Array.isArray(o.seats) ? o.seats : [];
  return {
    id: o.id, x: n('x'), y: n('y'), z: n('z'), yaw: n('yaw', -10, 10), p: n('p', -1, 1), r: n('r', -1, 1), n: n('n', 0, 1), g: o.g === 1 ? 1 : 0,
    seats: [0, 1, 2, 3].map((i) => (typeof seats[i] === 'string' ? (seats[i] as string) : null)),
  };
}

/**
 * Flying the helicopter (world/heli.ts, shared/heli.mjs), for main.ts: which machine you are in, getting in and out,
 * the keys to the flight, the line at the bottom and the instruments (ui/heliHud.ts).
 *
 * The keys as the helicopters of open-world driving games have them (Yoshi, 15 Nov 2026), on the same flight. Keyboard: W and S (Z and
 * S on AZERTY) and the arrows up and down fly forward and back, A and D (Q and D) turn it, the arrows left and right fly
 * sideways, Space up, C or Ctrl down, I or B the pilot's view, E in, out or the jump; the mouse only looks round (the
 * view goes back behind it by itself). Controller: the left stick flies it (forward, back, sideways), L1 and R1 turn it,
 * the right stick looks, R2 up and L2 down as far as they are pressed (or ✕ and ○), R3 the view, △ in and out. Touch:
 * the stick flies forward and back and, pushed sideways, turns it; a drag on the right looks; Up, Down, View, Use.
 *
 * You may get out on a floor, or within 1.5 m of one and slow; higher up than DROP.jumpMin over the floor below the same
 * key jumps: out of the door, a short free fall and the parachute opens by itself (shared/parachute.mjs jumpStart, the
 * player's drop), while the machine climbs away and is back on its pad once out of sight (shared/heli.mjs AWAY).
 * Not during a game (Zombies, a party game): a game starting puts you on your feet.
 *
 * Together (`together`, from the server's welcome until the connection ends) the machines are the server's
 * (server/helis.mjs): it decides who sits where (seat 0 flies, three ride along), every boarding and leaving and the
 * flights home. The use key asks to board, and nothing starts before the server names you in a seat. At the stick your
 * page flies as alone and reports the pose in its states (stateFields); in a passenger seat the machine is drawn where
 * the ticks say (world/heli.ts follow), the camera behind it or from your seat, and the up key takes the stick while
 * nobody flies it. Getting out only once it is at rest: the jump together is not built yet, so in the air the line says
 * to land first. No longer named in your seat, you are out (on your feet beside it, or where it was in the air).
 */
export class HeliPilot {
  readonly group = new THREE.Group();
  readonly machines: Heli[];
  /** The pads' paving, painted rings and letters (the grass keeps off them: main.ts grassTufts) */
  readonly pads: THREE.Object3D;
  /** The machine you are in (at the stick, or together in a passenger seat), or null */
  heli: Heli | null = null;
  /** Your seat in it: 0 at the stick, 1 to 3 riding along (together); null on your feet */
  seat: number | null = null;
  /** Playing together: the machines are the server's (join, apart) */
  together = false;
  /** How a message reaches the server (main.ts net.send); only used together */
  send: (m: Record<string, unknown>) => void = () => {};
  /** Your name together (the server's seats name you by it) */
  private you = '';
  /** When you last asked the server for a seat in each machine (performance.now() ms): its word starts the boarding */
  private asked = new Map<string, number>();
  private flyAsked = 0;
  private outSent = 0;
  private hushUntil = 0;
  private upWas = false;
  /** The machine the server last put you out of, and when: a flight home just after it gets a line (srv.heliHome) */
  private putOutOf: { id: string; at: number } | null = null;
  /** Riding along: where you look (rad), for your state and the minimap */
  facing: [number, number] = [0, 0];
  /** s the passenger's keys still show (the first ride of a session) */
  private rideHint = 0;
  private shownRide = false;
  private hud: HeliHud;
  private turnIn = 0;
  /** s the flying keys still show (after the lift-off), the "land first" and "no room" lines */
  private hint = 0;
  private landHint = 0;
  /** The flying keys show once a session, at the first lift-off */
  private shownKeys = false;
  /** The line under the machine, not over it (#prompt.heli-low, ui/heliHud.css) */
  private low = false;
  /** The view's width: the machine's while you fly, eased back to 1 after a jump (no snap) */
  private fov = 1;
  private frustum = new THREE.Frustum();
  private viewProj = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 8);

  constructor(
    private world: World,
    private crowns: Crown[],
    skipCrown: (x: number, z: number) => boolean,
    hudParent: HTMLElement,
    onHit: (hit: CrashHit) => void,
    /** Put you on your feet at (x, z) on the floor `y`, facing `yaw`. */
    private placePlayer: (x: number, z: number, y: number, yaw: number) => void,
    /**
     * The jump (the player's drop): `start` puts your feet at `at` facing its yaw and begins the drop with the jump's
     * speeds and its opening; `at` says where you are while a jump from here is still on (else null).
     */
    private jumper: { start: (at: { x: number; z: number; feet: number; yaw: number; side: number }, jump: ReturnType<typeof jumpStart>) => void; at: () => { x: number; z: number; feet: number } | null },
  ) {
    Heli.onHit = onHit;
    this.machines = HELIS.machines.map((spec) => new Heli(world, crowns, spec, skipCrown));
    for (const m of this.machines) {
      // Its spot's real ground (the data's height is the meadow's as measured).
      const g = world.groundAt(m.park.x, m.park.z, m.park.y + 2, 0).y;
      m.place(m.park.x, g, m.park.z, m.park.yaw);
      this.group.add(m.group);
    }
    this.pads = groundPads((x, z) => world.groundAt(x, z, 50, 0).y);
    this.group.add(this.pads);
    this.hud = new HeliHud(hudParent);
  }

  get aboard(): boolean {
    return this.heli !== null;
  }
  /** At the stick (alone always; together in seat 0) */
  get piloting(): boolean {
    return this.heli !== null && (this.seat ?? 0) === 0;
  }
  get fovScale(): number {
    return this.heli?.fovScale ?? this.fov;
  }
  /**
   * Together, from asking for a seat or the stick until the server's word (at most 1.5 s): no state goes out (main.ts).
   * One sent meanwhile reaches the server after it seated you, and would be taken as the pilot's: the machine would
   * move to where you stood and turn to where you looked.
   */
  get hush(): boolean {
    return performance.now() < this.hushUntil;
  }

  /**
   * The machine within reach of someone standing at (x, z) with their feet at `feet`, or null. Alone one nobody flies;
   * together one standing or hanging still (the server boards nobody into a machine on the move).
   */
  near(x: number, z: number, feet: number): Heli | null {
    for (const m of this.machines) {
      if (m.distanceTo(x, z) >= HELIS.reach || Math.abs(feet - m.s.y) >= 1 || m.away !== null) continue;
      if (this.together ? Math.hypot(m.s.vx, m.s.vy, m.s.vz) < 2 : !m.pilot) return m;
    }
    return null;
  }

  /** Into machine `m` at the stick (alone: main.ts checks the reason it may not first, why(); together on the server's word). */
  board(m: Heli): void {
    this.heli = m;
    this.seat = 0;
    this.turnIn = 0;
    this.hint = 0;
    this.hushUntil = 0;
    m.enter(this.together ? this.you : '');
  }

  /** Together, into a passenger seat of `m` (1 to 3) on the server's word: it flies you, the camera behind it. */
  ride(m: Heli, seat: number): void {
    this.heli = m;
    this.seat = seat;
    this.hushUntil = 0;
    this.upWas = true; // a key still held from boarding takes nothing
    m.ride();
    if (!this.shownRide) {
      this.shownRide = true;
      this.rideHint = 5; // the passenger's keys, once a session
    }
  }

  /** Use beside machine `m`: alone straight in; together the server is asked (its answer, a `heli` message, starts it: fromServer). */
  ask(m: Heli): void {
    if (!this.together) return this.board(m);
    const now = performance.now();
    const id = m.spec.id;
    if (now - (this.asked.get(id) ?? -Infinity) < 1000 || !m.seats.includes(null)) return;
    this.asked.set(id, now);
    this.hushUntil = now + 1500;
    this.send({ t: 'heli', op: 'in', id });
  }

  /** Why you may not fly now, as a text key, or null: during a game, or together with the admin's rule off. */
  why(game: boolean, off: boolean): 'prompt.heliGame' | 'prompt.heliOff' | null {
    return game ? 'prompt.heliGame' : off && this.together ? 'prompt.heliOff' : null;
  }

  /**
   * The server's welcome (after leaveNow): together from now on. Every machine is drawn where the server has it, with
   * who sits in it; a seat in your name (an old connection's) is given back.
   */
  join(list: readonly HeliView[], you: string): void {
    this.together = true;
    this.you = you;
    this.asked.clear();
    for (const m of this.machines) {
      m.remote = true;
      const v = list.find((q) => q.id === m.spec.id);
      if (v) m.snap(v);
      else m.setSeats([null, null, null, null]);
      if (v && you && v.seats.includes(you)) this.giveBack();
    }
  }

  /**
   * The connection ended: alone again. Out of a machine you were in (it is set down on the floor below, you beside
   * it), every machine the page's own again, nobody in it, one in the air set down on the floor below.
   */
  apart(): void {
    if (!this.together) return;
    this.together = false;
    for (const m of this.machines) m.remote = false;
    this.leaveNow(); // as alone: the machine set down below, you beside it
    for (const m of this.machines) {
      m.setSeats([null, null, null, null]);
      if (!m.atRest) m.leave();
    }
  }

  /**
   * A machine as the server has it (a `heli` message: someone got in or out, it went home, your answer, `fix`: the
   * server put your step back; or a tick's entry with `tick`). It starts your boarding when it names you in a machine
   * you asked for, puts you out when it no longer names you in yours, at the stick when it names you in seat 0. True
   * when it went home just after putting you out of it (a line in the chat: srv.heliHome).
   */
  fromServer(v: HeliView, { home = false, fix = false, tick = false, t = 0 } = {}): boolean {
    const m = this.machines.find((q) => q.spec.id === v.id);
    if (!m || !this.together) return false;
    const now = performance.now();
    const mine = this.you ? v.seats.indexOf(this.you) : -1;
    if (this.heli === m && mine < 0) {
      this.putOutOf = { id: v.id, at: now };
      this.out(); // the server put you out (nobody at the stick for too long, a game, the rule off, a respawn): from where it was
    }
    if (tick) m.sample(t, v);
    else if (home || Math.hypot(v.x - m.s.x, v.z - m.s.z) > 30) m.snap(v); // back on its pad, or far from where it was drawn: there at once
    else m.setSeats(v.seats);
    if (this.heli === m) {
      if (mine === 0 && this.seat !== 0) {
        m.takeOver(v); // you took the stick: from where it is, at rest or hanging there
        this.board(m);
      } else if (mine === 0 && fix) m.takeOver(v); // the server's pose wins
    } else if (mine >= 0 && !this.heli && now - (this.asked.get(v.id) ?? -Infinity) < 5000) {
      this.asked.delete(v.id);
      if (mine === 0) {
        m.takeOver(v);
        this.board(m);
      } else this.ride(m, mine);
    } else if (mine >= 0) this.giveBack(); // a seat you did not ask for (an old connection's), or one you left: given back
    const went = home && this.putOutOf?.id === v.id && now - this.putOutOf.at < 3000;
    if (went) this.putOutOf = null;
    return went;
  }

  /** Out of a seat you did not ask for: at most once a second (the server's gate is shared with the cars). */
  private giveBack(): void {
    const now = performance.now();
    if (now - this.outSent < 1000) return;
    this.outSent = now;
    this.send({ t: 'heli', op: 'out' });
  }

  /**
   * Together, out of the machine without a word to the server (it put you out, or a respawn, a trip or another session
   * does): at rest on your feet beside it, in the air where it is (you fall). The machine stays where the server has it.
   */
  private out(): void {
    const m = this.heli;
    if (!m) return;
    this.heli = null;
    this.seat = null;
    m.release();
    const at = m.atRest || m.s.h < 1.5 ? (m.exitSpot() ?? { x: m.s.x, y: m.s.y, z: m.s.z }) : { x: m.s.x, y: m.s.y, z: m.s.z };
    this.placePlayer(at.x, at.z, at.y, m.s.yaw);
  }

  /**
   * Together, your state's place and look (main.ts sends it): at the stick the machine's pose with its pitch, roll,
   * rotor and rest (`hp`, `hr`, `hn`, `hg`: server/helis.mjs moved holds them to the flight's caps); riding along the
   * machine's place (the server takes the machine's own anyway) and where you look. Null when not aboard together.
   */
  stateFields(): Record<string, number | boolean> | null {
    const m = this.heli;
    if (!m || !this.together) return null;
    const cm = (v: number) => Math.round(v * 100) / 100;
    const mrad = (v: number) => Math.round(v * 1000) / 1000;
    const s = m.s;
    const at = { x: cm(s.x), y: cm(s.y), z: cm(s.z), flying: false, c: false, d: true };
    if (this.piloting) return { ...at, yaw: mrad(s.yaw), pitch: 0, hp: mrad(s.pitch), hr: mrad(s.roll), hn: cm(s.rotor), hg: m.atRest ? 1 : 0 };
    return { ...at, yaw: mrad(this.facing[0]), pitch: mrad(this.facing[1]) };
  }

  /**
   * Out, if it is at rest (on a floor, or on its boom or cabin on something) or nearly on a floor; flying, a line says
   * to land. You stand by a step with room, else at its hub, on the floor it stands on (world/heli.ts exitSpot); where
   * that would be inside a private home or a fenced garden, you stay aboard and the line says to land elsewhere.
   * Together only at rest, at the stick or riding along (the server leaves it where it is: no step down to send first),
   * and no jump yet: in the air the line says to land first. The server is told.
   */
  leave(cameraAt: THREE.Vector3): boolean {
    const m = this.heli;
    if (!m) return false;
    if (this.together ? !m.atRest : !m.canLeave) {
      if (!this.together && !m.s.ground && m.s.h >= DROP.jumpMin) return this.jump(m);
      this.landHint = 2.5; // too low for the canopy: higher, or land (together: land first)
      return false;
    }
    const at = m.exitSpot();
    if (!at) {
      this.landHint = 2.5;
      return false;
    }
    if (this.piloting) m.leave();
    else m.release();
    this.heli = null;
    this.seat = null;
    if (this.together) {
      this.outSent = performance.now();
      this.send({ t: 'heli', op: 'out' });
    }
    this.placePlayer(at.x, at.z, at.y, Math.atan2(cameraAt.x - m.s.x, cameraAt.z - m.s.z));
    return true;
  }

  /**
   * The jump (E in the air, over DROP.jumpMin): out of the door on the side that is down, clear of the cabin, the tail and
   * the rotor's disc (shared/heli.mjs heliJump), with the machine's speed within the drop's limits; the machine flies
   * itself away and home.
   */
  /** The machine you last jumped out of: its pad is where a jump cut short puts you (leaveNow) */
  private jumpedOff: Heli | null = null;

  private jump(m: Heli): boolean {
    const j = heliJump(m.s, HELIS.size);
    const v = jumpStart(m.s.vx, m.s.vz, m.s.vy, j.push, m.s.h);
    this.fov = m.fovScale;
    m.jumpedFrom();
    this.jumpedOff = m;
    this.heli = null;
    this.jumper.start({ x: j.x, z: j.z, feet: j.y, yaw: m.s.yaw, side: j.side }, v);
    return true;
  }

  /**
   * Out at once wherever it is (a respawn, a trip from the chat, joining others): the machine is set down on the floor
   * below (no bump), or with `home` on its own pad (a game starting: never inside a game's fence); you stand by it as on
   * getting out, else at its hub on its floor (with `home`, where you were, on the floor below you). After a jump the
   * machine is back on its pad at once and a jump still going on ends: you stand on the floor below you (in a private
   * home or the end house's garden: beside the machine on its pad instead), so a session never begins in a jump.
   * Together the machine stays where the server has it: you are out (at rest beside it, in the air where it is) and the
   * server is told, in case it still has you in the seat.
   */
  leaveNow(home = false): void {
    if (this.together) {
      if (!this.heli) return;
      this.out();
      this.giveBack();
      return;
    }
    for (const a of this.machines) if (a.away !== null) a.sendHome();
    const fall = this.jumper.at();
    if (fall) {
      const y = this.world.groundAt(fall.x, fall.z, fall.feet, 0).y;
      const pad = this.jumpedOff ?? this.machines[0];
      const spot = homeAt(fall.x, fall.z, y) !== null || inEndGarden(fall.x, fall.z, y) ? (pad.exitSpot() ?? { x: pad.park.x + 3, y: pad.s.y, z: pad.park.z }) : { x: fall.x, y, z: fall.z };
      this.placePlayer(spot.x, spot.z, spot.y, pad.s.yaw);
    }
    const m = this.heli;
    if (!m) return;
    const x = m.s.x, y = m.s.y, z = m.s.z, yaw = m.s.yaw;
    m.leave(home);
    this.heli = null;
    this.seat = null;
    const at = home ? null : (m.exitSpot() ?? { x: m.s.x, y: m.s.y, z: m.s.z });
    if (at) this.placePlayer(at.x, at.z, at.y, yaw);
    else this.placePlayer(x, z, this.world.groundAt(x, z, y + 0.5, 0).y, yaw);
  }

  /** The village's blocks are in (main.ts): a machine still on its spot set on its floor there (the church's deck comes with them). */
  settle(): void {
    for (const m of this.machines) if (!m.flown && Math.hypot(m.s.x - m.park.x, m.s.z - m.park.z) < 1) m.place(m.park.x, this.world.groundAt(m.park.x, m.park.z, m.park.y + 2, 0).y, m.park.z, m.park.yaw);
  }

  /** A respawn, a game starting: every machine left where nobody can reach it back on its pad at once (alone: together the server does). */
  tidy(): void {
    if (this.together) return;
    for (const m of this.machines) if (m.stranded || m.away !== null) m.sendHome();
  }

  /**
   * A frame at the controls: `frame` the frame's input, `extras` the helicopter's own (controls/input.ts heli), `look`
   * what player.look made of the mouse, the right stick and a drag this frame (rad: right and up): the camera's only.
   * Returns how hard it hit something (m/s).
   */
  fly(dt: number, frame: FrameInput, extras: Input['heli'] | null, look: [number, number], camera: THREE.PerspectiveCamera, others: Obstacle[]): number {
    const m = this.heli;
    if (!m) return 0;
    const ex = extras ?? { fwd: 0, side: 0, turn: 0, triggers: 0, view: false };
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    // The turn: the turn keys (A and D, L1 and R1, the touch stick sideways), eased a little. The mouse doesn't turn it.
    this.turnIn += (clamp(ex.turn) - this.turnIn) * (1 - Math.exp(-Math.max(0, dt) * 10));
    const lift = clamp((frame.jumpHeld ? 1 : 0) - (frame.downHeld ? 1 : 0) + ex.triggers);
    if (ex.view || frame.scopePressed) m.switchView();
    const hit = m.fly(dt, { fwd: ex.fwd, side: ex.side, turn: Math.abs(this.turnIn) < 0.01 ? 0 : this.turnIn, lift }, others);
    if (m.s.ev & EV.LIFTOFF && !this.shownKeys) {
      this.shownKeys = true;
      this.hint = 5; // the flying keys, for the first seconds in the air (once a session)
    }
    if (m.view === 'cockpit') m.cockpit(camera, dt, look[1], look[0]);
    else m.chase(camera, dt, -look[1], look[0]);
    this.hint = Math.max(0, this.hint - dt);
    this.landHint = Math.max(0, this.landHint - dt);
    return hit;
  }

  /**
   * A frame in a passenger seat (together): no flight input. The view key switches between behind it and your own
   * seat's view; the up key (Space, R2 or ✕, the touch Up) asks for the stick while nobody flies it. `look` as for fly.
   */
  rideFrame(dt: number, frame: FrameInput, extras: Input['heli'] | null, look: [number, number], camera: THREE.PerspectiveCamera): void {
    const m = this.heli;
    if (!m) return;
    const ex = extras ?? { fwd: 0, side: 0, turn: 0, triggers: 0, view: false };
    if (ex.view || frame.scopePressed) m.switchView();
    const up = frame.jumpHeld || ex.triggers > 0.5;
    const now = performance.now();
    if (up && !this.upWas && !m.pilot && now - this.flyAsked > 500) {
      this.flyAsked = now;
      this.hushUntil = now + 1500;
      this.send({ t: 'heli', op: 'fly' });
    }
    this.upWas = up;
    if (m.view === 'cockpit') m.cockpit(camera, dt, look[1], look[0], this.seat ?? 1);
    else m.chase(camera, dt, -look[1], look[0]);
    camera.getWorldDirection(_dir);
    this.facing = [Math.atan2(-_dir.x, -_dir.z), Math.asin(Math.max(-1, Math.min(1, _dir.y)))];
    this.rideHint = Math.max(0, this.rideHint - dt);
    this.landHint = Math.max(0, this.landHint - dt);
  }

  /** The line at the bottom: aboard what to do now; beside a machine how to get in (or why not). */
  line(mode: Control, near: Heli | null, why: string | null): string {
    const m = this.heli;
    const up = key('heliUp', mode);
    const use = key('use', mode);
    if (!m) {
      if (!near) return '';
      if (why) return t(why as 'prompt.heliGame');
      // Together: the pilot's seat free, a seat beside the pilot free, or full.
      if (!this.together || !near.seats[0]) return t('prompt.heli', { use });
      return near.seats.includes(null) ? t('prompt.heliRide', { use }) : t('prompt.heliFull');
    }
    if (!this.piloting) {
      if (this.landHint > 0) return t('prompt.heliWait');
      if (!m.pilot) return t('prompt.heliTake', { up });
      if (this.rideHint > 0 && mode !== 'touch') return t('prompt.heliPassenger', { use, view: key('heliView', mode) });
      return '';
    }
    const s = m.s;
    if (s.down > 0) return t('prompt.heliDown', { n: Math.ceil(s.down) });
    if (this.landHint > 0) return this.together ? t('prompt.heliLand') : t('prompt.heliLow', { n: DROP.jumpMin });
    if (!s.engine && s.ground) return t('prompt.heliStart', { up });
    if (s.engine && s.rotor < HELI.LIFT_RPM) return t('prompt.heliSpinning', { up });
    if (s.atCeiling) return t('prompt.heliCeiling');
    if (s.atEdge) return t('prompt.edge');
    // The keys for the first seconds in the air, one short line; on touch none (the buttons say what they do).
    if (this.hint > 0 && mode !== 'touch') return t('prompt.heliFlying', { turn: key('heliTurn', mode), up, down: key('heliDown', mode), view: key('heliView', mode), use: key('use', mode) });
    return '';
  }

  /** Every frame: the machines (the one you fly and those standing or running down) and the instruments (`shown`: playing, not in the menu). */
  update(dt: number, camera: THREE.Camera, shown: boolean): void {
    for (const m of this.machines) m.update(dt, camera.position);
    // After a jump: back on its pad once out of your sight; watched too long, it flies off first (AWAY), never vanishing
    // while drawn near. The view's width eases back.
    for (const a of this.machines) {
      if (a.away === null || a.away < AWAY.home) continue;
      const off = Math.hypot(a.s.x - camera.position.x, a.s.z - camera.position.z, a.s.y - camera.position.y);
      if (!this.seen(a, camera) || a.away >= AWAY.latest + AWAY.leave || (a.leaving && off >= AWAY.far)) a.sendHome(camera.position);
      else if (a.away >= AWAY.latest) a.flyAway();
    }
    if (!this.heli) this.fov += (1 - this.fov) * (1 - Math.exp(-Math.max(0, dt) * 6));
    const m = this.heli;
    // Aboard, the line goes to the bottom of the screen, clear of the machine in the middle (its own element only).
    if (this.low !== !!m) {
      this.low = !!m;
      document.getElementById('prompt')?.classList.toggle('heli-low', this.low);
    }
    if (this.painting) return; // laid out and drawn unseen until play begins (prepaint)
    this.hud.update(shown && m && this.piloting ? { speed: Math.hypot(m.s.vx, m.s.vz), height: m.s.h, climb: m.s.vy, pitch: m.s.pitch, roll: m.s.roll, rotor: m.s.rotor, liftAt: HELI.LIFT_RPM } : null);
  }

  /** Whether the machine `m` is in the view (within its drawing distance). */
  private seen(m: Heli, camera: THREE.Camera): boolean {
    if (!m.group.visible) return false;
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    this.sphere.center.set(m.s.x, m.s.y + 2, m.s.z);
    return this.frustum.intersectsSphere(this.sphere);
  }

  /** The warm-up behind the start screen: every part of every machine drawn, the blur discs' and lamps' shaders made. */
  warm(on: boolean): void {
    for (const m of this.machines) m.warm(on);
  }

  private painting = false;
  /**
   * Until play (main.ts prepaint): the instruments shown in the unseen HUD behind the start screen, so their first
   * layout and drawing (the horizon's layer, the digits) are paid there, not at the first boarding.
   */
  prepaint(on: boolean): void {
    this.painting = on;
    this.hud.update(on ? { speed: 12, height: 34, climb: 1.5, pitch: 0.1, roll: -0.1, rotor: 0.5, liftAt: HELI.LIFT_RPM } : null);
  }

  /** Every pad as a ring for the minimap, while you fly. */
  padMarks(): { x: number; z: number; color: string }[] {
    return this.heli ? PADS.map((p) => ({ x: p.x, z: p.z, color: '#f2c230' })) : [];
  }

  /** Dev hooks (main.ts briel.helis). */
  readonly dev = {
    /** A machine put down at a pad ('house', 'church') or a spot, its rotor at `rotor` (0 to 1: running when at speed). */
    put: (where: string | { x: number; y?: number; z: number; yaw?: number }, rotor = 0, i = 0) => {
      const m = this.machines[i];
      const p = typeof where === 'string' ? HELIS.pads.find((q) => q.id === where) : where; // the planned ones too
      if (!m || !p) return null;
      const y = this.world.groundAt(p.x, p.z, (p.y ?? 0) + 1, 0).y;
      m.place(p.x, y, p.z, p.yaw ?? m.s.yaw, rotor);
      return { x: m.s.x, y: m.s.y, z: m.s.z };
    },
    /** A test deck of the church platform's size where it will be (until the church's own is in). */
    deck: () => !!testDeck(this.world, this.group),
    /** A bump now (to see and hear it). */
    bump: (i = 0) => void heliBump(this.machines[i].s, 8),
    /** The trees' crowns it knows (the house's and, once in, the village's). */
    crowns: () => this.crowns,
    state: (i = 0) => {
      const m = this.machines[i];
      return { ...m.s, view: m.view, sound: m.soundOn, flown: m.flown, ready: m.ready, draws: m.draws(), look: m.look };
    },
  };
}
