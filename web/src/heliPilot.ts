import * as THREE from 'three';
import HELIS from '../shared/heli.json';
import { EV, HELI, heliBump } from '../shared/heli.mjs';
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
 * One idea for the keys: it moves as you move on foot, turns as you look round, and rises and sinks as flying on foot
 * does. Keyboard: W A S D (Z Q S D on AZERTY) and the arrows up and down fly it, the mouse or the arrows left and right
 * turn it, Space up, Ctrl or C down, I the pilot's view, E in and out. Controller: the left stick flies it, the right
 * stick turns it and tilts the camera, R2 up and L2 down as far as they are pressed (or ✕ and ○), R3 the view,
 * △ in and out. Touch: the stick flies it, a drag on the right turns it, the Up and Down buttons, View, Use.
 *
 * You may get out on a floor, or within 1.5 m of one and slow. Alone only for now: together the server will decide
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

  constructor(
    private world: World,
    private crowns: Crown[],
    skipCrown: (x: number, z: number) => boolean,
    hudParent: HTMLElement,
    onHit: (hit: CrashHit) => void,
    /** Put you on your feet at (x, z) on the floor `y`, facing `yaw`. */
    private placePlayer: (x: number, z: number, y: number, yaw: number) => void,
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
    return this.heli?.fovScale ?? 1;
  }

  /** The machine within reach of someone standing at (x, z) with their feet at `feet`, or null. */
  near(x: number, z: number, feet: number): Heli | null {
    for (const m of this.machines) if (m.distanceTo(x, z) < HELIS.reach && Math.abs(feet - m.s.y) < 1 && !m.pilot) return m;
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
      this.landHint = 2.5;
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
   * Out at once wherever it is (a respawn, a trip from the chat, joining others): the machine is set down on the floor
   * below (no bump), or with `home` on its own pad (a game starting: never inside a game's fence); you stand by it as on
   * getting out, else at its hub on its floor (with `home`, where you were, on the floor below you).
   */
  leaveNow(home = false): void {
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
    for (const m of this.machines) if (m.stranded) m.sendHome();
  }

  /**
   * A frame at the controls: `frame` the frame's input, `extras` the helicopter's own (controls/input.ts heli), `look`
   * what player.look made of the mouse and the right stick this frame (rad: the turn and the tilt). Returns how hard
   * it hit something (m/s).
   */
  fly(dt: number, frame: FrameInput, extras: Input['heli'] | null, look: [number, number], camera: THREE.PerspectiveCamera, others: Obstacle[]): number {
    const m = this.heli;
    if (!m) return 0;
    const ex = extras ?? { fwd: 0, side: 0, turn: 0, triggers: 0, view: false };
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    // The turn: as fast as the view would turn on foot (the mouse, the right stick), at most a hover's turn rate; the
    // arrow keys left and right in full. Eased a little, so a flick turns it and a still mouse flies straight.
    const rate = dt > 0 ? look[0] / dt : 0;
    const want = clamp(rate / HELI.YAW_SLOW + ex.turn);
    this.turnIn += (want - this.turnIn) * (1 - Math.exp(-Math.max(0, dt) * 10));
    const lift = clamp((frame.jumpHeld ? 1 : 0) - (frame.downHeld ? 1 : 0) + ex.triggers);
    if (ex.view || frame.scopePressed) m.view = m.view === 'chase' ? 'cockpit' : 'chase';
    const hit = m.fly(dt, { fwd: ex.fwd, side: ex.side, turn: Math.abs(this.turnIn) < 0.01 ? 0 : this.turnIn, lift }, others);
    if (m.s.ev & EV.LIFTOFF && !this.shownKeys) {
      this.shownKeys = true;
      this.hint = 5; // the flying keys, for the first seconds in the air (once a session)
    }
    if (m.view === 'cockpit') m.cockpit(camera, dt, look[1]);
    else m.chase(camera, dt, -look[1]);
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
    if (this.landHint > 0) return t('prompt.heliLand');
    if (!s.engine && s.ground) return t('prompt.heliStart', { up });
    if (s.engine && s.rotor < HELI.LIFT_RPM) return t('prompt.heliSpinning', { up });
    if (s.atCeiling) return t('prompt.heliCeiling');
    if (s.atEdge) return t('prompt.edge');
    // The keys for the first seconds in the air, one short line; on touch none (the buttons say what they do).
    if (this.hint > 0 && mode !== 'touch') return t('prompt.heliFlying', { up, down: key('heliDown', mode), view: key('heliView', mode), use: key('use', mode) });
    return '';
  }

  /** Every frame: the machines (the one you fly and those standing or running down) and the instruments (`shown`: playing, not in the menu). */
  update(dt: number, camera: THREE.Camera, shown: boolean): void {
    for (const m of this.machines) m.update(dt, camera.position);
    const m = this.heli;
    // Aboard, the line goes to the bottom of the screen, clear of the machine in the middle (its own element only).
    if (this.low !== !!m) {
      this.low = !!m;
      document.getElementById('prompt')?.classList.toggle('heli-low', this.low);
    }
    if (this.painting) return; // laid out and drawn unseen until play begins (prepaint)
    this.hud.update(shown && m ? { speed: Math.hypot(m.s.vx, m.s.vz), height: m.s.h, climb: m.s.vy, pitch: m.s.pitch, roll: m.s.roll, rotor: m.s.rotor, liftAt: HELI.LIFT_RPM } : null);
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
      return { ...m.s, view: m.view, sound: m.soundOn, flown: m.flown, ready: m.ready, draws: m.draws() };
    },
  };
}
