import * as THREE from 'three';
import { sound } from '../sound';

/**
 * Rain (world/weather.ts turns it on): streaks falling round the eye, and its sound, made in code.
 *
 * The streaks are one set of short lines, one draw call. Each has a fixed spot in a box of BOX metres; the vertex
 * shader lets it fall and wraps it round the box that moves with the eye, so the drops stay put in the world as you
 * walk through them and never run out. The graphics chip only works out the line's pixels (a pixel wide), and the
 * count follows the preset: fewer on Low and on phones. Out of sight indoors (where the HUD says INSIDE), where
 * they would fall through the rooms.
 *
 * The sound: a loop of noise through a band of the hiss of rain on leaves and paving, and a lower patter; indoors
 * muffled, as on the roof and the windows.
 */

/** Metres across (x, z) and high (y) of the box of drops round the eye. */
const BOX = new THREE.Vector3(36, 18, 36);
/** Metres a second the drops fall. */
const SPEED = 9.5;
/** A streak's length (the drop's way during about a twentieth of a second). */
const LENGTH = 0.55;
/** The wind's slant: metres sideways for each metre down. */
const SLANT = new THREE.Vector2(0.08, 0.04);
/** The fall wraps round after this many metres: a whole number of boxes down, and sideways along the slant. */
const WRAP = 1800;

const vertexShader = /* glsl */ `
  attribute vec3 seed;
  attribute float tail;
  uniform vec3 box;
  uniform vec3 eye;
  uniform float fall;
  uniform vec3 streak;
  uniform vec2 slant;
  varying float vAlpha;
  void main() {
    // The drop's head, falling, wrapped into the box round the eye (so it keeps its place in the world).
    vec3 p = seed * box - vec3(slant.x, 1.0, slant.y) * fall;
    vec3 corner = eye - box * 0.5;
    p = corner + mod(p - corner, box);
    vec3 world = p + streak * tail;
    // Fade out towards the box's sides and top, so drops don't pop in and out at its edges.
    vec2 off = abs(world.xz - eye.xz) / (box.xz * 0.5);
    float edge = 1.0 - smoothstep(0.65, 1.0, max(off.x, off.y));
    edge *= 1.0 - smoothstep(0.6, 1.0, abs(world.y - eye.y) / (box.y * 0.5));
    vAlpha = edge * (1.0 - tail * 0.85);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(color, vAlpha * opacity);
  }`;

export class Rain {
  readonly mesh: THREE.LineSegments;
  private uniforms = {
    box: { value: BOX.clone() },
    eye: { value: new THREE.Vector3() },
    fall: { value: 0 },
    streak: { value: new THREE.Vector3(SLANT.x * LENGTH, LENGTH, SLANT.y * LENGTH) },
    slant: { value: SLANT.clone() },
    color: { value: new THREE.Color(0.55, 0.6, 0.66) },
    opacity: { value: 0 },
  };
  private geometry = new THREE.BufferGeometry();
  private count = 0;
  /** 0 to 1: how hard it rains (the weather's), and how much of it is seen (out of doors) */
  private amount = 0;
  private seen = 0;
  // The sound.
  private gain: GainNode | null = null;
  private hiss: BiquadFilterNode | null = null;
  private patter: BiquadFilterNode | null = null;

  constructor() {
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.LineSegments(this.geometry, material);
    this.mesh.name = 'rain';
    this.mesh.frustumCulled = false; // round the eye, wherever it is
    this.mesh.visible = false;
    this.mesh.renderOrder = 50;
    this.mesh.raycast = () => {}; // never in the way of a shot
    this.mesh.userData.noAO = true;
  }

  /** How many streaks: from the graphics preset (fewer on Low and on phones). */
  setCount(n: number): void {
    if (n === this.count) return;
    this.count = n;
    const seed = new Float32Array(n * 6);
    const tail = new Float32Array(n * 2);
    const position = new Float32Array(n * 6); // not read: three.js wants one for the draw count
    for (let i = 0; i < n; i++) {
      const s = [Math.random(), Math.random(), Math.random()];
      seed.set(s, i * 6);
      seed.set(s, i * 6 + 3);
      tail[i * 2 + 1] = 1;
    }
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.geometry.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
    this.geometry.setAttribute('tail', new THREE.BufferAttribute(tail, 1));
    this.mesh.geometry = this.geometry;
  }

  /** How hard it rains, 0 (dry) to 1. */
  set(amount: number): void {
    this.amount = amount;
  }

  /** Each frame: the eye, and whether it is indoors (no streaks there, and the sound muffled). */
  update(dt: number, eye: THREE.Vector3, indoors: boolean, brightness: number): void {
    this.seen += ((indoors ? 0 : this.amount) - this.seen) * (1 - Math.exp(-dt * 4));
    if (this.seen < 0.01 && !this.amount) this.seen = 0;
    this.mesh.visible = this.seen > 0.01;
    if (this.mesh.visible) {
      this.uniforms.eye.value.copy(eye);
      this.uniforms.fall.value = (this.uniforms.fall.value + dt * SPEED) % WRAP;
      this.uniforms.opacity.value = 0.42 * this.seen;
      this.uniforms.color.value.setRGB(0.55, 0.6, 0.66).multiplyScalar(brightness);
    }
    this.sound(indoors);
  }

  /** The rain's sound: started the first time it rains with sound on, then only its level changes. */
  private sound(indoors: boolean): void {
    const ctx = sound.context();
    if (!ctx || ctx.state !== 'running') return;
    if (!this.gain) {
      if (!this.amount) return;
      const out = sound.outside(); // muffled through the walls indoors (sound.ts)
      if (!out) return;
      const len = 4;
      const buffer = ctx.createBuffer(2, ctx.sampleRate * len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          // White noise with sparse brighter ticks (single drops close by).
          d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.0009 ? 4 : 1);
        }
        // Fade the loop's ends into each other, so it has no seam.
        const fade = ctx.sampleRate * 0.3;
        for (let i = 0; i < fade; i++) {
          const k = i / fade;
          d[i] = d[i] * k + d[d.length - fade + i] * (1 - k);
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.loopEnd = len - 0.3;
      this.hiss = ctx.createBiquadFilter();
      this.hiss.type = 'bandpass';
      this.hiss.frequency.value = 3200;
      this.hiss.Q.value = 0.5;
      this.patter = ctx.createBiquadFilter();
      this.patter.type = 'lowpass';
      this.patter.frequency.value = 7000;
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      src.connect(this.hiss).connect(this.patter).connect(this.gain).connect(out);
      src.start();
    }
    const t = ctx.currentTime;
    // Indoors: on the roof and the windows, lower and softer.
    this.gain.gain.setTargetAtTime(this.amount * (indoors ? 0.05 : 0.11), t, 0.5);
    this.hiss!.frequency.setTargetAtTime(indoors ? 900 : 3200, t, 0.4);
    this.patter!.frequency.setTargetAtTime(indoors ? 1600 : 7000, t, 0.4);
  }
}
