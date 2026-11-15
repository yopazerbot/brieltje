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
import { Heli, type Crown } from './world/heli';
import { groundPads, PADS, testDeck } from './world/heliPads';

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
 * Alone only for now: together the server will decide
 * who flies which machine (not built yet); until then the prompt says so. Not during a game (Zombies, a party game):
 * a game starting puts you on your feet.
 */
export class HeliPilot {
  readonly group = new THREE.Group();
  readonly machines: Heli[];
  /** The pads' paving, painted rings and letters (the grass keeps off them: main.ts grassTufts) */
  readonly pads: THREE.Object3D;
  /** The machine you fly, or null */
  heli: Heli | null = null;
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
  get fovScale(): number {
    return this.heli?.fovScale ?? this.fov;
  }

  /** The machine within reach of someone standing at (x, z) with their feet at `feet`, or null. */
  near(x: number, z: number, feet: number): Heli | null {
    for (const m of this.machines) if (m.distanceTo(x, z) < HELIS.reach && Math.abs(feet - m.s.y) < 1 && !m.pilot && m.away === null) return m;
    return null;
  }

  /** Into machine `m` (main.ts checks the reason it may not first: why()). */
  board(m: Heli): void {
    this.heli = m;
    this.turnIn = 0;
    this.hint = 0;
    m.enter();
  }

  /** Why you may not fly now, as a text key, or null: during a game, or together (for now). */
  why(game: boolean, together: boolean): 'prompt.heliGame' | 'prompt.heliAlone' | null {
    return game ? 'prompt.heliGame' : together ? 'prompt.heliAlone' : null;
  }

  /**
   * Out, if it is at rest (on a floor, or on its boom or cabin on something) or nearly on a floor; flying, a line says
   * to land. You stand by a step with room, else at its hub, on the floor it stands on (world/heli.ts exitSpot); where
   * that would be inside a private home or a fenced garden, you stay aboard and the line says to land elsewhere.
   */
  leave(cameraAt: THREE.Vector3): boolean {
    const m = this.heli;
    if (!m) return false;
    if (!m.canLeave) {
      if (!m.s.ground && m.s.h >= DROP.jumpMin) return this.jump(m);
      this.landHint = 2.5; // too low for the canopy: higher, or land
      return false;
    }
    const at = m.exitSpot();
    if (!at) {
      this.landHint = 2.5;
      return false;
    }
    m.leave();
    this.heli = null;
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
   */
  leaveNow(home = false): void {
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
    const at = home ? null : (m.exitSpot() ?? { x: m.s.x, y: m.s.y, z: m.s.z });
    if (at) this.placePlayer(at.x, at.z, at.y, yaw);
    else this.placePlayer(x, z, this.world.groundAt(x, z, y + 0.5, 0).y, yaw);
  }

  /** The village's blocks are in (main.ts): a machine still on its spot set on its floor there (the church's deck comes with them). */
  settle(): void {
    for (const m of this.machines) if (!m.flown && Math.hypot(m.s.x - m.park.x, m.s.z - m.park.z) < 1) m.place(m.park.x, this.world.groundAt(m.park.x, m.park.z, m.park.y + 2, 0).y, m.park.z, m.park.yaw);
  }

  /** A respawn, a game starting: every machine left where nobody can reach it back on its pad at once. */
  tidy(): void {
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

  /** The line at the bottom: aboard what to do now; beside a machine how to get in (or why not). */
  line(mode: Control, near: Heli | null, why: string | null): string {
    const m = this.heli;
    const up = key('heliUp', mode);
    if (!m) return near ? (why ? t(why as 'prompt.heliGame') : t('prompt.heli', { use: key('use', mode) })) : '';
    const s = m.s;
    if (s.down > 0) return t('prompt.heliDown', { n: Math.ceil(s.down) });
    if (this.landHint > 0) return t('prompt.heliLow', { n: DROP.jumpMin });
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
    this.hud.update(shown && m ? { speed: Math.hypot(m.s.vx, m.s.vz), height: m.s.h, climb: m.s.vy, pitch: m.s.pitch, roll: m.s.roll, rotor: m.s.rotor, liftAt: HELI.LIFT_RPM } : null);
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
