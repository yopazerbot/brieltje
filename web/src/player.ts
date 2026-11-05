import * as THREE from 'three';
import type { FrameInput } from './controls/input';
import type { Ground, World } from './world/collision';
import { DROP, dropGlide, dropSink } from '../shared/parachute.mjs';

const EYE = 1.65;          // m, eye height above the floor
const HEIGHT = 1.8;        // m, body height for head clearance
const RADIUS = 0.25;       // m, body radius
const STEP_UP = 0.5;       // m, highest edge you walk onto without jumping (two stair risers)
const SPRINT_FACTOR = 2.5; // sprint speed = walking speed x this
const GRAVITY = 9.81;      // m/s2
const JUMP_HEIGHT = 0.5;   // m
const FLY_HOLD = 0.25;     // s holding jump before you start flying
const FLY_SPEED = 3.0;     // m/s up or down while flying
const DOUBLE_TAP = 0.3;    // s between two jump presses that ends flying
const YAW_SPEED = 2.6;     // rad/s at full right stick
const PITCH_SPEED = 1.8;   // rad/s at full right stick
const MOUSE_SENS = 0.0022; // rad per pixel

export class Player {
  x: number;
  z: number;
  feet: number;
  yaw: number;
  pitch = 0;
  /** Walking speed in m/s; set from the settings (sprint is 2.5 times this) */
  walkSpeed = 1.4;
  /** Times faster, walking and flying: 1, or 15 for the admin who asks for it (src/main.ts). */
  turbo = 1;
  flying = false;
  /** Off when the admin has turned flying off in multiplayer */
  canFly = true;
  /** Holding C / Circle on the ground: lower, slower, steadier aim, quieter steps */
  crouching = false;
  private crouchT = 0;
  /** 0..1: lowers and tilts the view when you die */
  down = 0;
  /** Look settings: mouse and stick multipliers, inverted up/down, and a factor while zoomed in */
  mouseSens = 1;
  stickSens = 1;
  invertY = false;
  lookScale = 1;
  /** A footstep (speed in m/s) and landing after a fall (impact speed) */
  onStep: (speed: number) => void = () => {};
  onLand: (speed: number) => void = () => {};
  ground: Ground = { y: 0 };
  /** This frame you pushed against the edge of the game or flew into its ceiling (main.ts says so) */
  atEdge = false;
  /**
   * Under a parachute (shared/parachute.mjs): seconds since the drop began, or null on your feet. You
   * glide forward and steer left and right (or turn with the mouse); no jumping, flying or crouching.
   */
  chute: number | null = null;
  /** Your feet over the ground under you (m): for the parachute's flare */
  air = 0;
  /** Landed from a drop */
  onChuteLand: () => void = () => {};
  /**
   * The drop's camera (shared/parachute.mjs): the view looks down in the free fall, up as the canopy opens and
   * ahead for the glide, eased, until you look round yourself. It rolls into turns and swings a little under
   * the canopy (a pendulum: `roll` and `swing`, springs that settle by themselves after landing), and the knees
   * give on touchdown (`dip`). Only the camera: where you aim and what the others see don't change.
   */
  private autoLook = false;
  private steer = 0;
  private roll = 0;
  private rollV = 0;
  private swing = 0;
  private swingV = 0;
  private dip = -1;
  private lastVy = 0;
  private lastStep = 0;
  private vx = 0;
  private vz = 0;
  private vy = 0;
  private eyeY: number;
  private bob = 0;
  private stepDist = 0;
  private holdTime = 0;
  private lastJumpPress = -1;
  private clock = 0;

  constructor(private world: World, spawn: { x: number; z: number; yaw: number }) {
    this.x = spawn.x;
    this.z = spawn.z;
    this.yaw = spawn.yaw;
    this.feet = world.groundAt(this.x, this.z, 100, 0).y;
    this.eyeY = this.feet + EYE;
  }

  /** How fast you move across the plan (m/s): a grenade takes it along. */
  get velocity(): { x: number; z: number } {
    return { x: this.vx, z: this.vz };
  }

  /** Put the player somewhere directly, camera included (used by the dev test hook). */
  place(x: number, z: number, feet: number, yaw: number, pitch: number): void {
    Object.assign(this, { x, z, feet, yaw, pitch, vx: 0, vz: 0, vy: 0, eyeY: feet + EYE, flying: false, chute: null, roll: 0, rollV: 0, swing: 0, swingV: 0, dip: -1 });
  }

  /** Start a drop from where you are (place yourself up high first): the free fall, then the canopy. */
  startDrop(): void {
    Object.assign(this, { chute: 0, flying: false, vy: 0, vx: 0, vz: 0, steer: 0, autoLook: true, lastVy: 0, lastStep: performance.now() });
  }

  /**
   * How far the mouse and right stick turn the view this frame (radians: right, up), with
   * the look settings. Stick response is curved so small movements stay precise.
   */
  look(dt: number, input: FrameInput): [number, number] {
    const curve = (v: number) => Math.sign(v) * v * v;
    const flip = this.invertY ? -1 : 1;
    const stick = this.stickSens * this.lookScale;
    const mouse = MOUSE_SENS * this.mouseSens * this.lookScale;
    return [curve(input.lookX) * YAW_SPEED * stick * dt + input.mouseX * mouse, flip * (curve(input.lookY) * PITCH_SPEED * stick * dt - input.mouseY * mouse)];
  }

  update(dt: number, input: FrameInput, camera: THREE.PerspectiveCamera): void {
    // A drop keeps to the clock, not to the frames: the server ends it after DROP.maxMs whatever the page
    // does, so slow frames (the village loading behind it, a slow phone) must not stretch it. Steps of at most 0.5 s.
    const wall = performance.now();
    if (this.chute !== null && dt > 0) dt = Math.min(0.5, Math.max(dt, (wall - this.lastStep) / 1000));
    if (dt > 0) this.lastStep = wall;
    this.clock += dt;

    const [turn, tilt] = this.look(dt, input);
    if (turn !== 0 || tilt !== 0) this.autoLook = false; // looking round yourself: the drop's camera lets go
    this.yaw -= turn;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + tilt));

    // Walking, relative to where you look. Crouching: slow, no sprint.
    this.crouching = !this.flying && input.downHeld;
    this.crouchT += ((this.crouching ? 1 : 0) - this.crouchT) * (1 - Math.exp(-dt * 12));
    const speed = (this.crouching ? this.walkSpeed * 0.45 : this.walkSpeed * (input.sprint ? SPRINT_FACTOR : 1)) * this.turbo;
    if (this.chute !== null) {
      // Left and right steer (the parachute turns, picking up the turn and letting go of it gently), forward
      // and back push the glide a little faster or slower.
      this.chute += dt;
      this.crouching = false;
      this.steer += (input.moveX - this.steer) * (1 - Math.exp(-dt * 4));
      this.yaw -= this.steer * DROP.turn * dt;
    } else this.steer = 0;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const glide = this.chute === null ? 0 : dropGlide(this.chute, this.air, input.moveY);
    const tx = this.chute === null ? (-sin * input.moveY + cos * input.moveX) * speed : -sin * glide;
    const tz = this.chute === null ? (-cos * input.moveY - sin * input.moveX) * speed : -cos * glide;
    const blend = 1 - Math.exp(-12 * dt);
    this.vx += (tx - this.vx) * blend;
    this.vz += (tz - this.vz) * blend;

    // Move in small steps so fast movement can't skip through thin glass. The edge of the game
    // stops you like a wall, after the walls (none of them can push you over it).
    this.atEdge = false;
    const dist = Math.hypot(this.vx, this.vz) * dt;
    const steps = Math.max(1, Math.ceil(dist / 0.08));
    const pos = { x: this.x, z: this.z };
    for (let i = 0; i < steps; i++) {
      pos.x += (this.vx * dt) / steps;
      pos.z += (this.vz * dt) / steps;
      this.world.resolve(pos, this.feet, RADIUS, STEP_UP, HEIGHT);
      if (this.world.keepIn(pos, RADIUS)) this.atEdge = true;
      this.ground = this.world.groundAt(pos.x, pos.z, this.feet, STEP_UP);
      if (this.ground.y > this.feet && this.vy <= 0) this.feet = this.ground.y; // step up
    }
    this.x = pos.x;
    this.z = pos.z;

    if (this.chute !== null) this.descend(dt);
    else this.vertical(dt, input);
    this.air = Math.max(0, this.feet - this.ground.y);

    // Camera: smooth the height so stairs feel like steps, not jolts.
    const moving = Math.hypot(this.vx, this.vz);
    const onFoot = !this.flying && this.feet <= this.ground.y + 0.01;
    this.bob += onFoot ? moving * dt * 5.5 : 0;
    // A footstep every stride: about 0.85 m walking, 1.2 m running.
    this.stepDist += onFoot && moving > 0.3 ? moving * dt : 0;
    if (this.stepDist > 0.65 + 0.15 * moving) {
      this.stepDist = 0;
      this.onStep(moving);
    }
    const target = this.feet + EYE - this.crouchT * 0.5 + Math.sin(this.bob) * 0.025 * Math.min(1, moving / 1.4);
    const follow = !onFoot || target < this.eyeY - 0.4 ? 1 : 1 - Math.exp(-dt * 16);
    this.eyeY += (target - this.eyeY) * follow;

    this.dropCamera(dt);
    // Touching down from a drop: the knees give a little and straighten again (0.45 s).
    let knees = 0;
    if (this.dip >= 0) {
      this.dip += dt / 0.45;
      knees = this.dip < 1 ? 0.3 * Math.sin(Math.PI * this.dip) * (1 - this.dip * 0.4) : 0;
      if (this.dip >= 1) this.dip = -1;
    }
    camera.position.set(this.x, this.eyeY - this.down * 1.3 - knees, this.z);
    camera.rotation.set(this.pitch + this.swing, this.yaw, this.down * 0.5 + this.roll, 'YXZ');
  }

  /**
   * The drop's camera, each frame: where it looks (until you look yourself), its roll into turns and its
   * swing, two lightly damped springs (a pendulum of about 2.4 s, as the pilot hangs under the canopy).
   * On your feet the springs only settle.
   */
  private dropCamera(dt: number): void {
    const t = this.chute;
    if (t !== null && this.autoLook) {
      // Down at the ground in the free fall, up at the canopy as it opens, then ahead and down to where you land.
      const opening = t >= DROP.fall + 0.2 && t < DROP.fall + DROP.deploy + 0.9;
      const look = t < DROP.fall + 0.2 ? -0.85 : opening ? 1.2 : this.air < DROP.flareAt * 2 ? -0.12 : -0.35;
      this.pitch += (look - this.pitch) * (1 - Math.exp(-dt * (opening ? 2.4 : 1.5)));
    }
    // The roll follows the steering (into the turn), the swing the canopy's pull as it opens and brakes the
    // fall (the pilot swings forward under it, then back).
    const ay = dt > 0 ? (this.vy - this.lastVy) / dt : 0;
    this.lastVy = this.vy;
    const open = t !== null && t > DROP.fall + DROP.open;
    const bank = open ? -this.steer * 0.16 : 0;
    const pull = open && t < DROP.fall + DROP.open + DROP.brake ? Math.max(-0.1, Math.min(0, -ay * 0.011)) : 0;
    const w = (2 * Math.PI) / 2.4; // rad/s: the pendulum
    const step = Math.min(dt, 1 / 30);
    this.rollV += (w * w * (bank - this.roll) - 2 * 0.35 * w * this.rollV) * step;
    this.roll += this.rollV * step;
    this.swingV += (w * w * (pull - this.swing) - 2 * 0.3 * w * this.swingV) * step;
    this.swing += this.swingV * step;
    if (t === null && Math.abs(this.roll) + Math.abs(this.swing) + Math.abs(this.rollV) + Math.abs(this.swingV) < 1e-4) this.roll = this.rollV = this.swing = this.swingV = 0;
  }

  /**
   * Under the parachute: falling packed, then sinking under the canopy, slower in the flare near the
   * ground; on your feet when you touch it (or when a drop takes far too long).
   */
  private descend(dt: number): void {
    const t = this.chute ?? 0;
    this.vy = dropSink(t, this.feet - this.ground.y, this.vy, dt);
    let next = this.feet + this.vy * dt;
    const sky = this.world.skyAt(this.x, this.z);
    if (next > sky) next = sky;
    if (next <= this.ground.y || t > DROP.maxMs / 1000) {
      if (next <= this.ground.y) this.dip = 0; // on your feet: the knees give
      next = Math.max(next, this.ground.y);
      this.vy = 0;
      this.chute = null;
      this.onChuteLand();
    }
    this.feet = next;
  }

  /** Jumping, falling, and Minecraft-style flying (hold jump to rise, C or Circle to sink). */
  private vertical(dt: number, input: FrameInput): void {
    const grounded = !this.flying && this.vy <= 0 && this.feet <= this.ground.y + 0.001;

    if (input.jumpPressed) {
      if (this.flying && this.clock - this.lastJumpPress < DOUBLE_TAP) {
        this.flying = false; // double tap: stop flying and drop
      } else if (grounded) {
        this.vy = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
      }
      this.lastJumpPress = this.clock;
    }
    this.holdTime = input.jumpHeld ? this.holdTime + dt : 0;
    if (!this.flying && this.canFly && this.holdTime > FLY_HOLD) this.flying = true;

    if (this.flying) {
      this.vy = ((input.jumpHeld ? FLY_SPEED : 0) - (input.downHeld ? FLY_SPEED : 0)) * Math.min(this.turbo, 8);
    } else {
      // Walking down stairs: stay on the steps. Only a real drop makes you fall.
      if (this.vy === 0 && this.feet - this.ground.y <= STEP_UP) {
        this.feet = this.ground.y;
        return;
      }
      this.vy -= GRAVITY * dt;
    }

    let next = this.feet + this.vy * dt;
    if (this.vy > 0) {
      // Head against a ceiling: stop rising.
      const ceiling = this.world.ceilingAbove(this.x, this.z, RADIUS, this.feet + HEIGHT, next + HEIGHT);
      if (ceiling !== null) {
        next = Math.max(this.feet, ceiling - HEIGHT - 0.01);
        this.vy = 0;
      }
    }
    // The ceiling over the game (shared/bounds.json): high enough to see the village from above.
    const sky = this.world.skyAt(this.x, this.z);
    if (next > sky) {
      if (this.vy > 0) this.atEdge = true;
      next = Math.max(this.ground.y, sky);
      this.vy = Math.min(this.vy, 0);
    }
    if (next <= this.ground.y) {
      next = this.ground.y;
      if (this.vy < -2.5) this.onLand(-this.vy);
      this.vy = 0;
      if (this.flying && input.downHeld) this.flying = false; // landed
    }
    this.feet = next;
  }
}
