import * as THREE from 'three';
import { sound } from '../sound';
import { COVER_GLSL, coverUniforms, type CoverMap } from './coverMap';
import { WASH_GLSL, washUniforms } from './washShader';
import { slant } from './shelterMap';
import { windAt } from './wind';

/**
 * Rain (world/weather.ts turns it on): streaks falling round the eye, splashes where it lands, drips off the eaves, and
 * its sound, made in code.
 *
 * The streaks are one set of short lines, one draw call. Each has a fixed spot in a box of BOX metres; the vertex
 * shader lets it fall and wraps it round the box that moves with the eye, so the drops stay put in the world as you
 * walk through them and never run out. The graphics chip only works out the line's pixels (a pixel wide), and the
 * count follows the preset: fewer on Low and on phones.
 *
 * They stop at what is over them (world/coverMap.ts: a map from above round the eye of the roofs, canopies, carports,
 * shelters and tree crowns): a drop under a roof is not drawn, so it stays dry under a carport or a bus shelter, and
 * from indoors the rain is seen falling outside the windows and the open door. Under a tree's crown the rain thins to
 * fewer, larger, slower drops shaken from the leaves. The wind (world/wind.ts) slants it, more in the gusts.
 *
 * Splashes: tiny crowns of spray flicking up on whatever the rain reaches first (the ground, a roof, a car port's roof,
 * not the dry ground under it), round the eye. Drips: from the edges where rain runs off a roof (the cover map finds
 * them), a drop every second or so, falling to the ground below and ticking there. Both one draw call each, a few
 * pixels a drop.
 *
 * The sound: a loop of noise through a band of the hiss of rain on leaves and paving, and a lower patter; indoors
 * muffled, as on the roof and the windows; under a canopy outdoors a closer drumming overhead. Now and then in a
 * downpour a far roll of thunder, low and slow, sound only (no flash).
 */

/** Metres across (x, z) and high (y) of the box of drops round the eye. */
const BOX = new THREE.Vector3(36, 18, 36);
/** Metres a second the drops fall; those shaken from a tree's leaves. */
const SPEED = 9.5;
const SLOW = 4.2;
/** A streak's length (the drop's way during about a twentieth of a second); a slow drop's. */
const LENGTH = 0.55;
const LENGTH_SLOW = 0.2;
/** How much of the wind's speed the drops are carried sideways with, and at most (m/s). */
const CARRY = 0.6;
const CARRY_MAX = 6;
/** The share of the drops that fall slowly under a crown, where there is one over them. */
const UNDER = 0.3;
/** Metres round the eye with splashes, and how many on each preset (phones take Low's). */
const SPLASH_REACH = 15;
const SPLASHES: Record<string, number> = { low: 220, medium: 600, high: 900, ultra: 1200 };
/** The most drips drawn at once (the nearest), on Low and phones, and above. */
const DRIPS_LOW = 40;
const DRIPS = 140;
/** Seconds between two far rolls of thunder in a downpour, at least and at most. */
const THUNDER_MIN = 55;
const THUNDER_MAX = 170;

const vertexShader = /* glsl */ `
  attribute vec3 seed;
  attribute float tail;
  uniform vec3 box;
  uniform vec3 eye;
  uniform vec3 move;
  uniform vec3 moveSlow;
  uniform vec3 streak;
  uniform vec3 streakSlow;
  varying float vAlpha;
  ${COVER_GLSL}
  ${WASH_GLSL}
  vec3 inBox(vec3 p) {
    vec3 corner = eye - box * 0.5;
    return corner + mod(p - corner, box);
  }
  void main() {
    // The drop's head, falling, wrapped into the box round the eye (so it keeps its place in the world).
    vec3 p = inBox(seed * box + move);
    p.xz += washRain(p); // a helicopter's rotor wash drives the drops under it outward (world/washShader.ts)
    vec4 c = coverOver(p.xz);
    // Not under what is over it (unknown cells: none indoors), and not in or under a tree's crown.
    float show = c.a > 0.5 ? step(c.r, p.y) * step(c.g, p.y) : 1.0 - coverAt.w;
    vec3 s = streak;
    float bright = 1.0;
    // Some drops fall slowly instead where they are under a crown: shaken from the leaves, larger, slower.
    if (fract(seed.x * 91.7 + seed.z * 13.3) < ${UNDER.toFixed(2)}) {
      vec3 q = inBox(seed.zxy * box + moveSlow);
      q.xz += washRain(q);
      vec4 d = coverOver(q.xz);
      if (d.a > 0.5 && q.y < d.g && q.y > d.r) {
        p = q;
        show = 1.0;
        s = streakSlow;
        bright = 1.7;
      }
    }
    vec3 world = p + s * tail;
    world.xz += washRain(world) - washRain(p); // the tail higher, pushed less: the streak slants outward
    // Fade out towards the box's sides and top, so drops don't pop in and out at its edges.
    vec2 off = abs(world.xz - eye.xz) / (box.xz * 0.5);
    float edge = 1.0 - smoothstep(0.65, 1.0, max(off.x, off.y));
    edge *= 1.0 - smoothstep(0.6, 1.0, abs(world.y - eye.y) / (box.y * 0.5));
    vAlpha = edge * (1.0 - tail * 0.85) * bright;
    gl_Position = show > 0.5 ? projectionMatrix * viewMatrix * vec4(world, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(color, min(1.0, vAlpha * opacity));
  }`;

/** A splash: placed anew each time round, on the top of what is there (the cover map), a ring of spray widening and fading. */
const splashVertex = /* glsl */ `
  attribute vec4 seed;
  uniform vec3 eye;
  uniform float time;
  uniform float amount;
  uniform float scale;
  varying float vAlpha;
  varying float vAge;
  ${COVER_GLSL}
  void main() {
    float period = 0.3 + 0.45 * seed.z;
    float cycle = time / period + seed.w * 17.0;
    float n = floor(cycle);
    float age = fract(cycle) * period / 0.16; // 0 to 1 over its 0.16 s, then gone till the next
    vec2 r = fract(sin(vec2(dot(seed.xy + n * 0.131, vec2(127.1, 311.7)), dot(seed.yx + n * 0.173, vec2(269.5, 183.3)))) * 43758.5453);
    vec2 xz = eye.xz + (r - 0.5) * ${(2 * SPLASH_REACH).toFixed(1)};
    vec4 c = coverOver(xz);
    float show = step(age, 1.0) * step(0.5, c.a) * step(seed.z, amount);
    // Fewer under a crown (the leaves take most of it).
    if (c.g > c.r) show *= step(fract(seed.x * 31.7), 0.25);
    vec4 view = viewMatrix * vec4(xz.x, c.r + 0.02 + 0.05 * age, xz.y, 1.0);
    float size = 0.09 * (0.45 + age) * scale / max(0.4, -view.z);
    float far = length(xz - eye.xz) / ${SPLASH_REACH.toFixed(1)};
    vAlpha = show * (1.0 - smoothstep(0.6, 1.0, far)) * clamp(size / 2.5, 0.25, 1.0);
    vAge = age;
    gl_PointSize = clamp(size, 2.0, 16.0);
    gl_Position = show > 0.5 ? projectionMatrix * view : vec4(0.0, 0.0, 2.0, 1.0);
  }`;

const splashFragment = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  varying float vAge;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    q.y *= 1.6; // a flattened crown, wider than high
    float r = length(q) * 2.0;
    float ring = 1.0 - smoothstep(0.0, 0.22, abs(r - 0.25 - 0.6 * vAge));
    float core = (1.0 - smoothstep(0.0, 0.45, r)) * (1.0 - vAge);
    float a = max(ring * 0.8, core) * (1.0 - vAge) * vAlpha * opacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(color, a);
  }`;

/** A drip off an eave: a drop that leaves the edge from rest and speeds up, then a short tick where it lands. */
const dripVertex = /* glsl */ `
  attribute vec4 drip;
  attribute float dseed;
  attribute float tail;
  uniform float time;
  uniform float amount;
  varying float vAlpha;
  void main() {
    float period = 0.55 + 0.9 * fract(dseed * 7.13);
    float t = mod(time + dseed * 11.0, period);
    float fall = max(0.05, drip.y - drip.w);
    float land = sqrt(fall / 4.9);
    float y = drip.y - 4.9 * t * t;
    float len = clamp(9.8 * t * 0.02, 0.03, 0.22);
    float on = step(fract(dseed * 3.7), amount * 1.15);
    float falling = step(t, land);
    float tick = step(land, t) * step(t, land + 0.06);
    vec3 p = falling > 0.5 ? vec3(drip.x, y + len * tail, drip.z) : vec3(drip.x, drip.w + 0.05 * tail, drip.z);
    vAlpha = on * max(falling, tick) * (1.0 - 0.6 * tail);
    gl_Position = vAlpha > 0.0 ? projectionMatrix * viewMatrix * vec4(p, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
  }`;

export class Rain {
  readonly mesh: THREE.LineSegments;
  /** The splashes and the drips (children of the streaks' mesh) */
  readonly splashes: THREE.Points;
  readonly drips: THREE.LineSegments;
  private cover = coverUniforms();
  private uniforms = {
    box: { value: BOX.clone() },
    eye: { value: new THREE.Vector3() },
    move: { value: new THREE.Vector3() },
    moveSlow: { value: new THREE.Vector3() },
    streak: { value: new THREE.Vector3(0, LENGTH, 0) },
    streakSlow: { value: new THREE.Vector3(0, LENGTH_SLOW, 0) },
    color: { value: new THREE.Color(0.55, 0.6, 0.66) },
    opacity: { value: 0 },
    ...this.cover,
    ...washUniforms,
  };
  private splashUniforms = {
    eye: this.uniforms.eye, time: { value: 0 }, amount: { value: 0 }, scale: { value: 800 },
    color: { value: new THREE.Color() }, opacity: { value: 0 }, ...this.cover,
  };
  private dripUniforms = { time: this.splashUniforms.time, amount: this.splashUniforms.amount, color: { value: new THREE.Color() }, opacity: { value: 0 } };
  private geometry = new THREE.BufferGeometry();
  private count = 0;
  private dripMax = DRIPS;
  private dripsSeen = -1;
  private map: CoverMap | null = null;
  /** 0 to 1: how hard it rains (the weather's), and how much of it is seen */
  private amount = 0;
  private seen = 0;
  /** m/s the drops are carried sideways now (eased towards the wind's) */
  private carry = new THREE.Vector2();
  private want = new THREE.Vector2();
  private size = new THREE.Vector2();
  // The sound.
  private gain: GainNode | null = null;
  private hiss: BiquadFilterNode | null = null;
  private patter: BiquadFilterNode | null = null;
  private thunderIn = THUNDER_MIN;
  private thunder: AudioBuffer | null = null;

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

    this.splashes = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.splashUniforms, vertexShader: splashVertex, fragmentShader: splashFragment, transparent: true, depthWrite: false, fog: false,
    }));
    this.drips = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms: this.dripUniforms, vertexShader: dripVertex, fragmentShader, transparent: true, depthWrite: false, fog: false,
    }));
    for (const [m, name] of [[this.splashes, 'rain splashes'], [this.drips, 'rain drips']] as const) {
      m.name = name;
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 50;
      m.raycast = () => {};
      m.userData.noAO = true;
    }
    // Children of the streaks: shown and hidden with them (a reflection that leaves the rain out leaves these out too).
    this.mesh.add(this.splashes, this.drips);
    this.setDrips(DRIPS);
  }

  /** The cover map the drops stop at (world/coverMap.ts). */
  setCover(map: CoverMap): void {
    this.map = map;
    this.cover.coverMap.value = map.texture;
    this.cover.coverAt.value = map.at.value;
  }

  /** How many streaks and splashes, and drips at most: from the graphics preset (fewer on Low and on phones). */
  setCount(n: number, quality = 'medium'): void {
    const low = quality === 'low';
    this.setSplashes(SPLASHES[quality] ?? SPLASHES.medium);
    this.setDrips(low ? DRIPS_LOW : DRIPS);
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

  private setSplashes(n: number): void {
    const g = this.splashes.geometry;
    if (g.getAttribute('seed')?.count === n) return;
    g.dispose();
    const next = new THREE.BufferGeometry();
    const seed = new Float32Array(n * 4);
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    next.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // not read: the draw count
    next.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    this.splashes.geometry = next;
  }

  private setDrips(n: number): void {
    if (n === this.dripMax && this.drips.geometry.getAttribute('drip')) return;
    this.dripMax = n;
    this.drips.geometry.dispose();
    const g = new THREE.BufferGeometry();
    const tail = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) tail[i * 2 + 1] = 1;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3)); // not read: the draw count
    g.setAttribute('drip', new THREE.BufferAttribute(new Float32Array(n * 8), 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('dseed', new THREE.BufferAttribute(new Float32Array(n * 2), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tail', new THREE.BufferAttribute(tail, 1));
    g.setDrawRange(0, 0);
    this.drips.geometry = g;
    this.dripsSeen = -1;
  }

  /** The drips near the eye into their buffer, when the cover map has found them anew. */
  private fillDrips(): void {
    const map = this.map;
    if (!map || map.dripsChanged === this.dripsSeen) return;
    this.dripsSeen = map.dripsChanged;
    const g = this.drips.geometry;
    const at = g.getAttribute('drip') as THREE.BufferAttribute;
    const sd = g.getAttribute('dseed') as THREE.BufferAttribute;
    const n = Math.min(this.dripMax, map.drips.length);
    const a = at.array as Float32Array, s = sd.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const d = map.drips[i];
      for (let v = 0; v < 2; v++) {
        a.set([d.x, d.top, d.z, d.bottom], (i * 2 + v) * 4);
        s[i * 2 + v] = d.seed;
      }
    }
    at.needsUpdate = sd.needsUpdate = true;
    g.setDrawRange(0, n * 2);
  }

  /** How hard it rains, 0 (dry) to 1. */
  set(amount: number): void {
    this.amount = amount;
  }

  /**
   * Each frame: the eye, whether it is indoors (where the cover map knows nothing yet the drops count as under a roof,
   * and the sound is muffled), the light on the drops, and the renderer (its height in pixels sets a splash's size).
   */
  update(dt: number, eye: THREE.Vector3, indoors: boolean, brightness: number, renderer?: THREE.WebGLRenderer): void {
    this.seen += (this.amount - this.seen) * (1 - Math.exp(-dt * 4));
    if (this.seen < 0.01 && !this.amount) this.seen = 0;
    const on = this.seen > 0.01;
    this.mesh.visible = on;
    this.splashes.visible = this.drips.visible = true;
    this.cover.coverAt.value.w = indoors ? 1 : 0;
    if (on) {
      const u = this.uniforms;
      u.eye.value.copy(eye);
      // Carried by the wind at the eye (world/wind.ts), eased so a gust leans the rain over in a moment.
      const w = windAt(eye.x, eye.z);
      const k = Math.min(CARRY_MAX, w.speed * CARRY) / Math.max(w.speed, 1e-3);
      this.carry.lerp(this.want.set(w.x * k, w.z * k), 1 - Math.exp(-dt * 2));
      const cx = this.carry.x, cz = this.carry.y;
      slant.rain.set(cx / SPEED, cz / SPEED); // the dry ground under a roof slants with it (world/shelterMap.ts)
      // The fall so far, each way kept within its box's side (the drops are wrapped round the box anyway).
      const m = u.move.value, ms = u.moveSlow.value;
      m.set((m.x + cx * dt) % BOX.x, (m.y - SPEED * dt) % BOX.y, (m.z + cz * dt) % BOX.z);
      ms.set((ms.x + cx * 0.15 * dt) % BOX.x, (ms.y - SLOW * dt) % BOX.y, (ms.z + cz * 0.15 * dt) % BOX.z);
      // The streak trails behind the drop: back up along the way it falls.
      u.streak.value.set(-cx / SPEED, 1, -cz / SPEED).multiplyScalar(LENGTH);
      u.streakSlow.value.set(-(cx * 0.15) / SLOW, 1, -(cz * 0.15) / SLOW).normalize().multiplyScalar(LENGTH_SLOW);
      u.opacity.value = 0.42 * this.seen;
      u.color.value.setRGB(0.55, 0.6, 0.66).multiplyScalar(brightness);
      const s = this.splashUniforms;
      s.time.value = (s.time.value + dt) % 1000;
      s.amount.value = Math.min(1, this.seen * 1.2);
      s.opacity.value = 0.55 * this.seen;
      s.color.value.setRGB(0.72, 0.76, 0.8).multiplyScalar(brightness);
      if (renderer) s.scale.value = renderer.getDrawingBufferSize(this.size).y / (2 * Math.tan((36 * Math.PI) / 180));
      this.dripUniforms.opacity.value = 0.45 * this.seen;
      this.dripUniforms.color.value.setRGB(0.66, 0.71, 0.77).multiplyScalar(brightness);
      this.fillDrips();
    }
    const top = this.map?.topAt(eye.x, eye.z);
    this.sound(dt, indoors, !indoors && top !== null && top !== undefined && top > eye.y + 0.2);
  }

  /** The rain's sound: started the first time it rains with sound on, then only its level changes. */
  private sound(dt: number, indoors: boolean, covered: boolean): void {
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
    // Indoors: on the roof and the windows, lower and softer. Under a canopy: drumming close overhead, lower and louder.
    this.gain.gain.setTargetAtTime(this.amount * (indoors ? 0.05 : covered ? 0.14 : 0.11), t, 0.5);
    this.hiss!.frequency.setTargetAtTime(indoors ? 900 : covered ? 1900 : 3200, t, 0.4);
    this.patter!.frequency.setTargetAtTime(indoors ? 1600 : covered ? 4200 : 7000, t, 0.4);
    // Now and then in a downpour, a far roll of thunder.
    if (this.amount > 0.7) {
      this.thunderIn -= dt;
      if (this.thunderIn <= 0) {
        this.thunderIn = THUNDER_MIN + Math.random() * (THUNDER_MAX - THUNDER_MIN);
        this.roll(ctx, indoors);
      }
    } else this.thunderIn = Math.max(this.thunderIn, THUNDER_MIN * 0.5);
  }

  /**
   * A far roll of thunder: low noise swelling in a few slow waves and dying away over some seconds, no crack (it is
   * kilometres off). Made once, each roll played a little faster or slower, louder or softer; muffled indoors.
   */
  private roll(ctx: AudioContext, indoors: boolean): void {
    const out = sound.outside();
    if (!out) return;
    if (!this.thunder) {
      const len = 7;
      const rate = ctx.sampleRate;
      const b = ctx.createBuffer(2, rate * len, rate);
      for (let c = 0; c < 2; c++) {
        const d = b.getChannelData(c);
        let y = 0, z = 0;
        const swells = [0.15, 0.9, 1.7, 2.9].map((s) => s + c * 0.05);
        let env = 0;
        for (let i = 0; i < d.length; i++) {
          const s = i / rate;
          // Brown noise, smoothed twice: a deep rumble.
          y = 0.985 * y + 0.015 * (Math.random() * 2 - 1);
          z = 0.97 * z + 0.03 * y;
          if (i % 128 === 0) {
            // The swells (worked out every few milliseconds: it changes slowly).
            env = 0;
            swells.forEach((at, j) => (env += Math.exp(-((s - at) ** 2) / (0.35 + j * 0.25)) * (1 - j * 0.18)));
            env *= Math.min(1, s / 0.4) * Math.exp(-s / 3.2);
          }
          d[i] = z * env;
        }
        let peak = 0;
        for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        for (let i = 0; i < d.length; i++) d[i] *= 0.9 / (peak || 1);
      }
      this.thunder = b;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.thunder;
    src.playbackRate.value = 0.8 + Math.random() * 0.35;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = indoors ? 160 : 260;
    const g = ctx.createGain();
    g.gain.value = (0.14 + Math.random() * 0.12) * this.amount;
    src.connect(low).connect(g).connect(out);
    src.start();
    src.onended = () => g.disconnect();
  }
}
