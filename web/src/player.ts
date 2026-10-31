import * as THREE from 'three';
import type { FrameInput } from './controls/input';
import type { Ground, World } from './world/collision';

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
  flying = false;
  /** Off when the admin has turned flying off in multiplayer */
  canFly = true;
  /** Holding Ctrl / C / Circle on the ground: lower, slower, steadier aim, quieter steps */
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
    Object.assign(this, { x, z, feet, yaw, pitch, vx: 0, vz: 0, vy: 0, eyeY: feet + EYE, flying: false });
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
    this.clock += dt;

    const [turn, tilt] = this.look(dt, input);
    this.yaw -= turn;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + tilt));

    // Walking, relative to where you look. Crouching: slow, no sprint.
    this.crouching = !this.flying && input.downHeld;
    this.crouchT += ((this.crouching ? 1 : 0) - this.crouchT) * (1 - Math.exp(-dt * 12));
    const speed = this.crouching ? this.walkSpeed * 0.45 : this.walkSpeed * (input.sprint ? SPRINT_FACTOR : 1);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const tx = (-sin * input.moveY + cos * input.moveX) * speed;
    const tz = (-cos * input.moveY - sin * input.moveX) * speed;
    const blend = 1 - Math.exp(-12 * dt);
    this.vx += (tx - this.vx) * blend;
    this.vz += (tz - this.vz) * blend;

    // Move in small steps so fast movement can't skip through thin glass.
    const dist = Math.hypot(this.vx, this.vz) * dt;
    const steps = Math.max(1, Math.ceil(dist / 0.08));
    const pos = { x: this.x, z: this.z };
    for (let i = 0; i < steps; i++) {
      pos.x += (this.vx * dt) / steps;
      pos.z += (this.vz * dt) / steps;
      this.world.resolve(pos, this.feet, RADIUS, STEP_UP, HEIGHT);
      this.ground = this.world.groundAt(pos.x, pos.z, this.feet, STEP_UP);
      if (this.ground.y > this.feet && this.vy <= 0) this.feet = this.ground.y; // step up
    }
    this.x = pos.x;
    this.z = pos.z;

    this.vertical(dt, input);

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

    camera.position.set(this.x, this.eyeY - this.down * 1.3, this.z);
    camera.rotation.set(this.pitch, this.yaw, this.down * 0.5, 'YXZ');
  }

  /** Jumping, falling, and Minecraft-style flying (hold jump to rise, Ctrl/C or Circle to sink). */
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
      this.vy = (input.jumpHeld ? FLY_SPEED : 0) - (input.downHeld ? FLY_SPEED : 0);
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
    if (next <= this.ground.y) {
      next = this.ground.y;
      if (this.vy < -2.5) this.onLand(-this.vy);
      this.vy = 0;
      if (this.flying && input.downHeld) this.flying = false; // landed
    }
    this.feet = next;
  }
}
