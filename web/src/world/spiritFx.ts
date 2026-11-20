import * as THREE from 'three';
import type { SpiritData, SpiritView } from '../../shared/brookSpirit.mjs';
import { actLength } from '../../shared/brookSpirit.mjs';
import { PARTICLE, particleSheet } from './sprites';

/**
 * The Brook Spirit's fight drawn in the world (world/spiritFight.ts drives it): its tells, its pools, the lights
 * among the trees, the mist round the grove while it is awake, and the bursts. No rules here: what to draw comes
 * from the spirit's view (shared/brookSpirit.mjs spiritView alone, readSpirit together) and a few one-shot calls.
 *
 * Each attack has a shape and a motion of its own, so it reads without its colour (colour-blind players) and above
 * the ferns: every tell stands upright, 0.3 to 1.2 m over the ground.
 * - The sweep: a lane between two low walls of pale mist, running out from the creature along the strip it will
 *   strike, brightening to the strike and flashing as it lands. Step out of the lane.
 * - The bolt: a ring of rising motes round where it will land (its whole reach), with a second ring closing in on
 *   the middle as the bolt comes; the bolt itself flies from the heart as a bright ball. Walk out of the ring.
 * - A pool: motes spiral in to where it will spread, then slow green fire-mist fills its whole circle while it lasts.
 * - Rising elsewhere: a column of motes spiralling up where it will come out of the ground.
 * - The open heart: sparks circling it (the weak point, plain to see).
 *
 * Cheap on purpose (the graphics chip is the limit): one instanced draw of soft additive motes for all of it, one
 * draw for the sweep's two walls, one for the mist round the grove (a low band, only while awake and near), and
 * three small instanced draws and a line for the lights. No new render target, no full-screen pass, every colour far
 * under the half floats' 65504.
 */

const MOTE_VERT = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iCol;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vUv = position.xy * 2.0;
  vCol = iCol;
  vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
  // Right at the eye a mote would fill the screen: it fades out there.
  vCol.a *= smoothstep(0.5, 2.2, -mv.z);
  mv.xy += position.xy * iPos.w;
  gl_Position = projectionMatrix * mv;
}`;
const MOTE_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vCol;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float a = 1.0 - r2;
  a *= a;
  gl_FragColor = vec4(vCol.rgb * (vCol.a * a), 1.0);
}`;

/** Soft round glows facing the camera, all in one instanced additive draw. */
export class Motes {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly col: THREE.InstancedBufferAttribute;
  count = 0;

  constructor(readonly capacity: number) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.pos);
    this.geo.setAttribute('iCol', this.col);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({ vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    quiet(this.mesh);
  }

  begin(): void {
    this.count = 0;
  }

  /** One mote at (x, y, z), `size` m across, colour (r, g, b) times `a`. */
  put(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number): void {
    if (this.count >= this.capacity || a <= 0.002 || size <= 0) return;
    const i = this.count++ * 4;
    const p = this.pos.array as Float32Array;
    const c = this.col.array as Float32Array;
    p[i] = x;
    p[i + 1] = y;
    p[i + 2] = z;
    p[i + 3] = size;
    c[i] = r;
    c[i + 1] = g;
    c[i + 2] = b;
    c[i + 3] = Math.min(a, 8);
  }

  end(): void {
    this.geo.instanceCount = this.count;
    for (const a of [this.pos, this.col]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * 4);
      a.needsUpdate = true;
    }
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const PUFF_VERT = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iCol;
attribute vec2 iRot;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vCol = iCol;
  vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
  vCol.a *= smoothstep(0.6, 2.6, -mv.z);
  float cs = cos(iRot.x);
  float sn = sin(iRot.x);
  vec2 c = position.xy * iPos.w;
  mv.xy += vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
  gl_Position = projectionMatrix * mv;
  vec2 cell = vec2(mod(iRot.y, 2.0), 1.0 - floor(iRot.y / 2.0));
  vUv = (position.xy + 0.5 + cell) * 0.5;
}`;
const PUFF_FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vCol.rgb * (0.55 + 0.45 * t.rgb), t.a * vCol.a);
}`;

/** Soft puffs and wisps of mist from the game's own sprite sheet (world/sprites.ts), one instanced draw, blended as mist. */
class Puffs {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly col: THREE.InstancedBufferAttribute;
  private readonly rot: THREE.InstancedBufferAttribute;
  private n = 0;

  constructor(private readonly capacity: number) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.pos);
    this.geo.setAttribute('iCol', this.col);
    this.geo.setAttribute('iRot', this.rot);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({ vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG, uniforms: { map: { value: particleSheet() } }, transparent: true, depthWrite: false });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    quiet(this.mesh);
  }

  begin(): void {
    this.n = 0;
  }

  /** A puff at (x, y, z), `size` m across, turned `rot`, sheet cell `cell`, colour `c` times `glow` (over 1 glows), opacity `a`. */
  put(x: number, y: number, z: number, size: number, rot: number, cell: number, c: [number, number, number], glow: number, a: number): void {
    if (this.n >= this.capacity || a <= 0.004) return;
    const i = this.n++;
    (this.pos.array as Float32Array).set([x, y, z, size], i * 4);
    (this.col.array as Float32Array).set([c[0] * glow, c[1] * glow, c[2] * glow, Math.min(a, 1)], i * 4);
    (this.rot.array as Float32Array).set([rot, cell], i * 2);
  }

  end(): void {
    this.geo.instanceCount = this.n;
    for (const a of [this.pos, this.col, this.rot]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Never in a shot's way, never a ray's work: the fight's hit boxes are its own (world/spiritFight.ts). */
function quiet(o: THREE.Object3D): void {
  o.userData.ignoreRay = true;
  o.raycast = () => {};
}

const LANE_VERT = /* glsl */ `
varying vec2 vUv;
varying float vNear;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNear = smoothstep(0.6, 3.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const LANE_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uP;
uniform float uFlash;
uniform float uTime;
uniform float uLen;
uniform float uI;
uniform float uAlpha;
varying vec2 vUv;
varying float vNear;
void main() {
  float u = vUv.x;
  float v = vUv.y;
  float m = u * uLen;
  // Mist flowing out from the creature along the strip, in soft drifting patches.
  float n1 = texture2D(uNoise, vec2(m * 0.16 - uTime * 0.55, v * 0.55 + uTime * 0.05)).r;
  float n2 = texture2D(uNoise, vec2(m * 0.37 - uTime * 0.9, v * 1.1 - uTime * 0.12)).r;
  float n = smoothstep(0.3, 0.85, n1 * 0.65 + n2 * 0.35);
  float front = clamp(uP * 1.7, 0.0, 1.0);
  float fill = smoothstep(front + 0.02, front - 0.12, u);
  // Densest at the ground, thinning upward, no edge at its top or its ends.
  float body = smoothstep(0.04, 0.2, v) * exp(-v * 3.2) * smoothstep(1.0, 0.6, v);
  float ends = smoothstep(0.0, 0.08, u) * smoothstep(1.0, 0.88, u);
  float strike = smoothstep(0.65, 1.0, uP);
  float a = body * ends * (fill * (0.3 + 0.6 * uP + 0.4 * strike) * (0.12 + 0.88 * n * n) * 1.5 + uFlash * 0.9);
  vec3 c = vec3(0.78, 0.88, 1.0) * uI * (0.75 + 0.5 * n + 0.8 * strike + 1.2 * uFlash);
  gl_FragColor = vec4(c, clamp(a * uAlpha * vNear, 0.0, 1.0));
}`;

/** The sweep's lane: two low walls of mist along the strip's edges, one draw. */
class Lane {
  readonly mesh: THREE.Mesh;
  private readonly u = { uNoise: { value: null as THREE.Texture | null }, uP: { value: 0 }, uFlash: { value: 0 }, uTime: { value: 0 }, uLen: { value: 11 }, uI: { value: 1 }, uAlpha: { value: 1 } };
  private readonly positions: Float32Array;
  private readonly geo = new THREE.BufferGeometry();
  private key = '';

  constructor(noise: THREE.Texture, private readonly n = 20) {
    this.u.uNoise.value = noise;
    const verts = 2 * (n + 1) * 2;
    this.positions = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const index: number[] = [];
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i <= n; i++) {
        const k = (s * (n + 1) + i) * 2;
        uv.set([i / n, 0, i / n, 1], k * 2);
        if (i < n) index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
      }
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(index);
    const mat = new THREE.ShaderMaterial({ vertexShader: LANE_VERT, fragmentShader: LANE_FRAG, uniforms: this.u, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    quiet(this.mesh);
  }

  /** The lane from (fx, fz) to (tx, tz), `half` m either side, standing on the ground. */
  place(fx: number, fz: number, tx: number, tz: number, half: number, ground: (x: number, z: number) => number): void {
    const key = `${fx.toFixed(2)},${fz.toFixed(2)},${tx.toFixed(2)},${tz.toFixed(2)}`;
    if (key === this.key) return;
    this.key = key;
    const len = Math.hypot(tx - fx, tz - fz) || 1;
    this.u.uLen.value = len;
    const sx = (-(tz - fz) / len) * half;
    const sz = ((tx - fx) / len) * half;
    const n = this.n;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        const x = fx + (tx - fx) * f + sx * side;
        const z = fz + (tz - fz) * f + sz * side;
        const g = ground(x, z);
        const k = (s * (n + 1) + i) * 2 * 3;
        this.positions.set([x, g - 0.15, z, x, g + 1.8, z], k);
      }
    }
    const a = this.geo.getAttribute('position') as THREE.BufferAttribute;
    a.needsUpdate = true;
  }

  show(p: number, flash: number, time: number, intensity: number, alpha = 1): void {
    this.u.uAlpha.value = alpha;
    this.u.uP.value = p;
    this.u.uFlash.value = flash;
    this.u.uTime.value = time;
    this.u.uI.value = intensity;
    this.mesh.visible = p > 0 || flash > 0.01;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const BAND_VERT = /* glsl */ `
attribute vec4 iBand;
attribute vec4 iTint;
attribute float iSpeed;
varying vec2 vUv;
varying vec4 vTint;
varying float vSpeed;
varying float vArc;
varying float vFacing;
varying float vNear;
void main() {
  vUv = uv;
  vTint = iTint;
  vSpeed = iSpeed;
  vArc = uv.x * 6.2832 * iBand.z;
  vec3 p = vec3(iBand.x + position.x * iBand.z, iBand.w - 0.15 + position.y * 1.8, iBand.y + position.z * iBand.z);
  // Seen edge-on the wall would show a hard outline: it thins away there, as mist does.
  vFacing = abs(dot(normalize(vec3(position.x, 0.0, position.z)), normalize(cameraPosition - p)));
  vNear = smoothstep(0.6, 3.0, distance(cameraPosition, p));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const BAND_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying vec4 vTint;
varying float vSpeed;
varying float vArc;
varying float vFacing;
varying float vNear;
void main() {
  float v = vUv.y;
  // Soft patches of mist drifting round and rising through the wall at its own pace: wisps with gaps between them.
  float n1 = texture2D(uNoise, vec2(vArc * 0.15 + uTime * 0.04, v * 0.5 - uTime * vSpeed * 0.3)).r;
  float n2 = texture2D(uNoise, vec2(vArc * 0.38 - uTime * 0.07, v * 1.2 - uTime * vSpeed * 0.55)).r;
  float n = smoothstep(0.3, 0.85, n1 * 0.6 + n2 * 0.4);
  // Densest just above the ground (it starts under it: no seam there), thinning fast upward, no edge at its top.
  float body = smoothstep(0.04, 0.22, v) * exp(-v * 3.6) * smoothstep(1.0, 0.55, v);
  float a = body * (0.08 + 0.92 * n * n) * smoothstep(0.05, 0.6, vFacing) * vNear * vTint.a;
  gl_FragColor = vec4(vTint.rgb * (0.6 + 0.7 * n), clamp(a * 1.6, 0.0, 1.0));
}`;

/**
 * Upright rings of mist standing on the ground (a bolt's reach and the ring closing in, a pool's edge, where it rises):
 * a low curved wall of soft drifting patches, densest at the ground and thinning upward, all in one instanced draw.
 */
class Bands {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly band: THREE.InstancedBufferAttribute;
  private readonly tint: THREE.InstancedBufferAttribute;
  private readonly speed: THREE.InstancedBufferAttribute;
  private readonly u = { uNoise: { value: null as THREE.Texture | null }, uTime: { value: 0 } };
  private n = 0;

  constructor(noise: THREE.Texture, private readonly capacity = 16) {
    this.u.uNoise.value = noise;
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 64, 4, true).translate(0, 0.5, 0);
    this.geo.index = cyl.index;
    this.geo.setAttribute('position', cyl.getAttribute('position'));
    this.geo.setAttribute('uv', cyl.getAttribute('uv'));
    this.band = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.speed = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iBand', this.band);
    this.geo.setAttribute('iTint', this.tint);
    this.geo.setAttribute('iSpeed', this.speed);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({ vertexShader: BAND_VERT, fragmentShader: BAND_FRAG, uniforms: this.u, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    quiet(this.mesh);
  }

  begin(time: number): void {
    this.n = 0;
    this.u.uTime.value = time;
  }

  /** A ring of `r` m round (x, z) standing on `y`; colour `c` (brighter than 1 glows), opacity `a`; its mist rises at `speed`. */
  put(x: number, z: number, r: number, y: number, c: [number, number, number], a: number, speed: number, glow = 1): void {
    if (this.n >= this.capacity || a <= 0.003 || r <= 0.05) return;
    const i = this.n++;
    (this.band.array as Float32Array).set([x, z, r, y], i * 4);
    (this.tint.array as Float32Array).set([c[0] * glow, c[1] * glow, c[2] * glow, Math.min(a, 1)], i * 4);
    (this.speed.array as Float32Array)[i] = speed;
  }

  end(): void {
    this.geo.instanceCount = this.n;
    for (const a of [this.band, this.tint, this.speed]) a.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const RING_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const RING_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uOn;
uniform float uTime;
uniform vec3 uColor;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  float n1 = texture2D(uNoise, vec2(vUv.x * 9.0 + uTime * 0.012, vUv.y * 0.9 - uTime * 0.02)).r;
  float n2 = texture2D(uNoise, vec2(vUv.x * 23.0 - uTime * 0.02, vUv.y * 1.7 + uTime * 0.01)).r;
  float band = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.35, vUv.y);
  float a = uOn * band * (0.2 + 0.55 * n1 * n2 + 0.25 * n1);
  gl_FragColor = vec4(uColor, a * 0.62);
}`;

/** The wood closing round the grove while it is awake: a low band of slow mist at its edge, one draw. */
class MistRing {
  readonly mesh: THREE.Mesh;
  private readonly u = { uNoise: { value: null as THREE.Texture | null }, uOn: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color() } };
  on = 0;

  constructor(cx: number, cz: number, r: number, ground: (x: number, z: number) => number, noise: THREE.Texture) {
    const seg = 72;
    const pos: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      const g = ground(x, z);
      pos.push(x, g - 0.3, z, x, g + 3.2, z);
      uv.push(i / seg, 0, i / seg, 1);
      if (i < seg) index.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    this.u.uNoise.value = noise;
    const mat = new THREE.ShaderMaterial({ vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms: this.u, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 4;
    quiet(this.mesh);
  }

  /** `want` 1 awake, 0 asleep; eases over a few seconds. `day` 0 night to 1 sun. */
  update(dt: number, want: number, time: number, day: number, near: boolean): void {
    this.on += (want - this.on) * (1 - Math.exp(-dt * (want > this.on ? 0.9 : 0.6)));
    if (this.on < 0.005 && want === 0) this.on = 0;
    this.u.uOn.value = this.on;
    this.u.uTime.value = time;
    // Dark blue-grey at night, a pale grey mist by day: the wood round you dims either way.
    this.u.uColor.value.setRGB(0.03 + 0.2 * day, 0.04 + 0.22 * day, 0.06 + 0.24 * day);
    this.mesh.visible = near && this.on > 0.01;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.u.uNoise.value?.dispose(); // the noise is shared: the mist goes last (SpiritFx.dispose)
  }
}

/** A small tiling noise of soft blobs (value noise, two octaves; 8-bit, linear filtered: fine on every chip). */
function noiseTexture(): THREE.DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n);
  const octave = (cells: number, seed: number, x: number, y: number) => {
    const g = (i: number, j: number) => hash(((i + cells) % cells) * 131.7 + ((j + cells) % cells) * 17.3 + seed);
    const fx = (x / n) * cells;
    const fy = (y / n) * cells;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const sx = (fx - i) * (fx - i) * (3 - 2 * (fx - i));
    const sy = (fy - j) * (fy - j) * (3 - 2 * (fy - j));
    const a = g(i, j) + (g(i + 1, j) - g(i, j)) * sx;
    const b = g(i, j + 1) + (g(i + 1, j + 1) - g(i, j + 1)) * sx;
    return a + (b - a) * sy;
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = Math.round((octave(8, 1.3, x, y) * 0.65 + octave(16, 7.1, x, y) * 0.35) * 255);
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** A number from 0 to 1, the same for the same `n`. */
export function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const PATCH_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vC;
void main() {
  vUv = uv * 2.0 - 1.0;
  vC = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const PATCH_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vC;
void main() {
  float r = dot(vUv * vec2(1.0, 0.7), vUv * vec2(1.0, 0.7));
  float a = max(0.0, 1.0 - r);
  gl_FragColor = vec4(vC * a * a, 1.0);
}`;

/** The lights' colour: the spirit's cold green-white (world/brookSpirit.ts COLD), as a light (linear). */
const LIT = new THREE.Color('#c9ffe2');

/**
 * The lights among the trees: small will-o'-the-wisp lanterns hanging on a thread, 1 m from their trunk. Out: dark
 * glass, barely there. Lit: glowing through the bloom, gently swinging, with a soft patch of light on their trunk
 * (a glow on a quad, not a real light). Three instanced draws and a line for all eight.
 */
class Lanterns {
  readonly group = new THREE.Group();
  private readonly orbs: THREE.InstancedMesh;
  private readonly caps: THREE.InstancedMesh;
  private readonly patches: THREE.InstancedMesh;
  private readonly threads: THREE.LineSegments;
  private readonly threadPos: Float32Array;
  /** Where each hangs now (swinging), for the halo and the hit box */
  readonly at: THREE.Vector3[];
  /** 0 out to 1 lit, eased */
  private glow: number[];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private c = new THREE.Color();

  constructor(private readonly spots: { x: number; y: number; z: number }[], private readonly trees: [number, number, number][]) {
    const n = spots.length;
    this.at = spots.map((s) => new THREE.Vector3(s.x, s.y, s.z));
    this.glow = spots.map(() => 0);
    this.orbs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.15, 1), new THREE.MeshBasicMaterial(), n);
    this.caps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.09, 0.07, 8), new THREE.MeshStandardMaterial({ color: '#2a2a26', roughness: 0.6, metalness: 0.5 }), n);
    this.patches = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.7, 1.7), new THREE.ShaderMaterial({ vertexShader: PATCH_VERT, fragmentShader: PATCH_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), n);
    this.threadPos = new Float32Array(n * 6);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.threadPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.threads = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: '#3b3a33', transparent: true, opacity: 0.8 }));
    for (const o of [this.orbs, this.caps, this.patches, this.threads]) {
      o.frustumCulled = false;
      quiet(o);
    }
    this.orbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.patches.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    // The patches lie on the trunks' sides facing their lights.
    spots.forEach((s, i) => {
      const [tx, tz] = this.trees[i];
      const dx = s.x - tx;
      const dz = s.z - tz;
      const d = Math.hypot(dx, dz) || 1;
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), Math.atan2(dx, dz));
      this.m.compose(this.v.set(tx + (dx / d) * 0.37, s.y - 0.2, tz + (dz / d) * 0.37), this.q, new THREE.Vector3(1, 1, 1));
      this.patches.setMatrixAt(i, this.m);
    });
    this.group.add(this.threads, this.caps, this.orbs, this.patches);
  }

  /** Each frame: `mask` bit i lit; `time` s. */
  update(dt: number, mask: number, time: number, day: number): void {
    const one = new THREE.Vector3(1, 1, 1);
    this.spots.forEach((s, i) => {
      const lit = (mask >> i) & 1;
      this.glow[i] += (lit - this.glow[i]) * (1 - Math.exp(-dt * (lit ? 4 : 9)));
      const g = this.glow[i];
      // A gentle swing about the thread's top, livelier when lit.
      const sw = 0.03 + 0.07 * g;
      const ax = Math.sin(time * 1.3 + i * 1.9) * sw;
      const az = Math.sin(time * 0.9 + i * 2.7) * sw;
      const top = 1.3;
      const x = s.x + Math.sin(ax) * top;
      const z = s.z + Math.sin(az) * top;
      const y = s.y + top - Math.cos(ax) * Math.cos(az) * top;
      this.at[i].set(x, y, z);
      this.q.identity();
      this.m.compose(this.v.set(x, y, z), this.q, one);
      this.orbs.setMatrixAt(i, this.m);
      this.m.compose(this.v.set(x, y + 0.15, z), this.q, one);
      this.caps.setMatrixAt(i, this.m);
      this.threadPos.set([x, y + 0.18, z, s.x, s.y + top, s.z], i * 6);
      // Out: dark glass with a faint gleam. Lit: bright through the bloom, breathing a little.
      const pulse = 1 + 0.15 * Math.sin(time * 2.4 + i);
      const b = g * (3.2 + 4.5 * day) * pulse;
      this.c.setRGB(0.05 + LIT.r * b, 0.06 + LIT.g * b, 0.06 + LIT.b * b);
      this.orbs.setColorAt(i, this.c);
      const p = g * (0.22 + 0.25 * (1 - day)) * pulse;
      this.c.setRGB(LIT.r * p, LIT.g * p, LIT.b * p);
      this.patches.setColorAt(i, this.c);
    });
    this.orbs.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    this.orbs.instanceColor!.needsUpdate = true;
    this.patches.instanceColor!.needsUpdate = true;
    (this.threads.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.patches.visible = this.glow.some((g) => g > 0.01);
  }

  glowOf(i: number): number {
    return this.glow[i] ?? 0;
  }

  dispose(): void {
    for (const o of [this.orbs, this.caps, this.patches]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
      o.dispose();
    }
    this.threads.geometry.dispose();
    (this.threads.material as THREE.Material).dispose();
  }
}

/** A burst of motes from a point: a light shot out, the shell bursting, a hit's glint, a bolt landing. */
interface Burst {
  x: number;
  y: number;
  z: number;
  t0: number;
  /** s it lasts */
  dur: number;
  n: number;
  /** m/s outward */
  speed: number;
  size: number;
  color: [number, number, number];
  /** 1: out in all directions; 0: flat, along the ground; -1: drifting upwards */
  shape: number;
  seed: number;
}

/** A bolt on its way: from the heart to where it lands. */
interface Flight {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  t1: number;
}

/** A bolt's ring on the ground: from its tell's start until it lands. */
interface Ring {
  x: number;
  z: number;
  t0: number;
  t1: number;
}

const PALE: [number, number, number] = [0.75, 0.88, 1.0];
const AMBER: [number, number, number] = [1.0, 0.82, 0.5];
const GREEN: [number, number, number] = [0.35, 1.0, 0.45];
const COLD: [number, number, number] = [LIT.r, LIT.g, LIT.b];

/** Everything above, for one spirit. Times in s on the caller's clock. */
export class SpiritFx {
  readonly group = new THREE.Group();
  readonly lanterns: Lanterns;
  private readonly motes: Motes;
  private readonly puffs: Puffs;
  private readonly lane: Lane;
  private readonly bands: Bands;
  private readonly mist: MistRing;
  private bursts: Burst[] = [];
  private flights: Flight[] = [];
  private rings: Ring[] = [];
  private laneFlash = 0;
  private lastAct = '';
  private seed = 1;
  low = false;
  /** The launcher lying where it came apart (alone): motes rising from its ring */
  drop: { x: number; y: number; z: number } | null = null;

  constructor(private readonly d: SpiritData, lights: { x: number; y: number; z: number }[], private readonly ground: (x: number, z: number) => number) {
    const noise = noiseTexture();
    this.motes = new Motes(900);
    this.puffs = new Puffs(260);
    this.lane = new Lane(noise);
    this.bands = new Bands(noise);
    this.mist = new MistRing(d.grove.x, d.grove.z, d.grove.r + 2, ground, noise);
    this.lanterns = new Lanterns(lights, d.lights.map((l) => l.tree));
    this.group.add(this.mist.mesh, this.lane.mesh, this.bands.mesh, this.puffs.mesh, this.lanterns.group, this.motes.mesh);
  }

  /** A bolt flies from `from` to `to` in `ms` (from now, `time` s). Its ring stays until it lands. */
  flight(from: THREE.Vector3, to: { x: number; y: number; z: number }, ms: number, time: number): void {
    const t1 = time + Math.max(0.1, ms / 1000);
    this.flights.push({ from: from.clone(), to: new THREE.Vector3(to.x, to.y, to.z), t0: time, t1 });
    const ring = this.rings.find((r) => Math.hypot(r.x - to.x, r.z - to.z) < 0.3 && r.t1 > time - 0.2);
    if (ring) ring.t1 = t1;
    else this.rings.push({ x: to.x, z: to.z, t0: time, t1 });
    if (this.flights.length > 8) this.flights.shift();
  }

  burst(at: { x: number; y: number; z: number }, kind: 'light' | 'shell' | 'glint' | 'land' | 'cap' | 'apart', time: number): void {
    const B: Record<typeof kind, Omit<Burst, 'x' | 'y' | 'z' | 't0' | 'seed'>> = {
      light: { dur: 0.9, n: 36, speed: 3.2, size: 0.28, color: COLD, shape: 1 },
      shell: { dur: 1.4, n: 90, speed: 6, size: 0.4, color: [1.0, 0.95, 0.8], shape: 1 },
      glint: { dur: 0.3, n: 7, speed: 2.5, size: 0.14, color: COLD, shape: 1 },
      land: { dur: 0.6, n: 34, speed: 4.5, size: 0.35, color: AMBER, shape: 0 },
      cap: { dur: 0.8, n: 26, speed: 3, size: 0.25, color: [0.6, 0.7, 0.8], shape: 0 },
      apart: { dur: 3.2, n: 110, speed: 1.6, size: 0.45, color: COLD, shape: -1 },
    };
    const b = B[kind];
    this.bursts.push({ ...b, n: this.low ? Math.ceil(b.n * 0.55) : b.n, x: at.x, y: at.y, z: at.z, t0: time, seed: this.seed++ });
    if (this.bursts.length > 24) this.bursts.shift();
  }

  /** Nothing in flight or bursting (a reset, a new runner). */
  clear(): void {
    this.bursts = [];
    this.flights = [];
    this.rings = [];
    this.laneFlash = 0;
    this.lane.hide();
  }

  /**
   * Each frame. `v`: the spirit's view (null: none to draw), `now` its clock in ms, `time` the same in s; `heart` where
   * its heart is drawn; `near`: you are close enough to see the grove; `day` 0 night to 1 sun.
   */
  update(dt: number, v: SpiritView | null, now: number, time: number, heart: THREE.Vector3, near: boolean, day: number): void {
    const m = this.motes;
    m.begin();
    this.puffs.begin();
    this.bands.begin(time);
    const k = 0.8 + 0.9 * day; // additive light washes out in the sun: brighter by day
    // The tells are mist: pale and fairly thick by day, thinner and glowing (bloom) at night.
    const gl = 1 + 1.6 * (1 - day);
    const ma = 0.55 + 0.3 * day;
    this.gl = gl;
    this.ma = ma;
    const few = this.low ? 0.55 : 1;
    const d = this.d;
    const awake = !!v && (v.mode === 'fight' || v.mode === 'mend');
    this.mist.update(dt, awake ? 1 : 0, time, day, near);
    this.lanterns.update(dt, v ? v.lights : 0, time, day);
    const drop = this.drop;
    if (drop && near) {
      // The launcher's ring: a slow column of motes over it, seen from across the grove.
      for (let i = 0; i < 14; i++) {
        const f = (time * 0.45 + hash(i * 3.9)) % 1;
        const a = hash(i * 7.3) * Math.PI * 2 + time * 0.6;
        m.put(drop.x + Math.cos(a) * 0.62, drop.y + 0.1 + f * 2.2, drop.z + Math.sin(a) * 0.62, 0.12, COLD[0], COLD[1], COLD[2], 1.2 * Math.sin(f * Math.PI) * k);
      }
      m.put(drop.x, drop.y + 0.15, drop.z, 1.4, COLD[0], COLD[1], COLD[2], 0.3 * k);
    }
    if (!v || !near) {
      this.lane.hide();
      m.end();
      this.puffs.end();
      this.bands.end();
      return;
    }
    const left = Math.max(0, (v.ms - (now - v.at)) / 1000);
    const len = actLength(d, v) || 1;
    const p = Math.min(1, Math.max(0, (len - left) / len));
    const gx = v.x;
    const gz = v.z;
    const gy = this.ground(gx, gz);

    // The sweep: the lane, filling then striking; a flash as it lands.
    if (awake && v.act === 'sweep') {
      this.lane.place(v.x, v.z, v.tx, v.tz, d.attacks.sweep.half, this.ground);
      this.lane.show(p, 0, time, gl, ma);
      this.streamLane(v, p, time, few);
    } else {
      if (this.lastAct === 'sweep') this.laneFlash = 1;
      this.laneFlash = Math.max(0, this.laneFlash - dt * 3);
      if (this.laneFlash > 0) this.lane.show(0, this.laneFlash, time, gl, ma);
      else this.lane.hide();
    }

    // The bolt's tell: its ring where it will land, the heart gathering light.
    if (awake && v.act === 'bolt') {
      const t0 = time - (len - left);
      const ring = this.rings.find((r) => Math.hypot(r.x - v.tx, r.z - v.tz) < 0.3 && r.t1 > time - 0.2);
      const guess = time + left + Math.hypot(v.tx - gx, v.tz - gz) / d.attacks.bolt.speed + d.attacks.bolt.extra;
      if (!ring) this.rings.push({ x: v.tx, z: v.tz, t0, t1: guess });
      for (let i = 0; i < 12 * few; i++) {
        const a = hash(i * 3.1) * Math.PI * 2 + time * 2;
        const f = (time * 1.4 + hash(i * 5.7)) % 1;
        const r = 1.6 * (1 - f);
        m.put(heart.x + Math.cos(a) * r, heart.y + Math.sin(a * 1.3) * r * 0.6, heart.z + Math.sin(a) * r, 0.18 + 0.2 * f, AMBER[0], AMBER[1], AMBER[2], (0.6 + 1.2 * p) * f * k);
      }
    }
    this.drawRings(time, k, few);
    this.drawFlights(time, k);

    // A pool's tell: motes spiralling in to where it spreads.
    if (awake && v.act === 'pool') {
      const r0 = d.attacks.pools.radius;
      const py = this.ground(v.tx, v.tz);
      // Mist drawn in, spiralling, to where it will spread; its edge already faintly there.
      for (let i = 0; i < 12 * few; i++) {
        const f = (time * 0.45 + hash(i * 2.3)) % 1;
        const a = hash(i * 9.1) * Math.PI * 2 + f * 2.5;
        const r = r0 * (1.15 - f * 0.9);
        this.puffs.put(v.tx + Math.cos(a) * r, py + 0.35 + 0.3 * hash(i * 4.4), v.tz + Math.sin(a) * r, 1.0 + 0.4 * f, a, PARTICLE.wisp, GREEN, gl, (0.15 + 0.45 * p) * Math.sin(f * Math.PI) * ma);
      }
      for (let i = 0; i < 10 * few; i++) {
        const f = (time * 0.7 + hash(i * 6.1)) % 1;
        const a = hash(i * 3.3) * Math.PI * 2 + f * 3;
        const r = r0 * (1 - f * 0.85);
        m.put(v.tx + Math.cos(a) * r, py + 0.25 + 0.8 * hash(i * 4.4), v.tz + Math.sin(a) * r, 0.11, GREEN[0], GREEN[1], GREEN[2], (0.3 + 0.7 * p) * k);
      }
      this.bands.put(v.tx, v.tz, r0, py, GREEN, 0.35 * p * ma, 0.3, gl);
    }
    for (const pool of v.pools) this.drawPool(pool.x, pool.z, pool.ms - (now - v.at), time, k, few);

    // Rising elsewhere: a column of motes spiralling up; sinking: drawn down.
    if (awake && (v.act === 'rise' || v.act === 'sink')) {
      const up = v.act === 'rise';
      for (let i = 0; i < 26 * few; i++) {
        const f = (time * (up ? 0.8 : -0.8) + hash(i * 1.7) + 10) % 1;
        const a = hash(i * 6.3) * Math.PI * 2 + f * 5;
        const r = 0.6 + 0.6 * (1 - f);
        m.put(gx + Math.cos(a) * r, gy + 0.2 + f * 3.4, gz + Math.sin(a) * r, 0.13, COLD[0], COLD[1], COLD[2], (up ? 0.4 + 1.2 * p : 1.2 * (1 - p)) * (1 - f * 0.6) * k);
      }
      // Mist welling up from the ground where it comes out, thickest at the foot.
      for (let i = 0; i < 9 * few; i++) {
        const f = (time * 0.5 + hash(i * 8.7)) % 1;
        const a = hash(i * 5.9) * Math.PI * 2 + time * 0.4;
        const w = up ? 0.3 + 0.7 * p : 1 - p;
        this.puffs.put(gx + Math.cos(a) * (0.5 + f * 0.6), gy + 0.3 + f * 1.8, gz + Math.sin(a) * (0.5 + f * 0.6), 1.1 + f * 0.9, a + f, PARTICLE.puff, COLD, gl, 0.5 * (1 - f) * w * ma);
      }
      if (up) this.bands.put(gx, gz, 1.4, gy, COLD, (0.25 + 0.5 * p) * ma, 1.4, gl);
    }

    // The open heart: sparks circling it, the weak point plain to see.
    const heartOpen = v.lights === 0 && ((v.mode === 'fight' && (v.act === 'open' || v.act === 'stun')) || (v.mode === 'mend' && v.act !== 'sink' && v.act !== 'under' && v.act !== 'rise'));
    if (heartOpen) {
      const n = v.mode === 'mend' ? 5 : 9;
      for (let i = 0; i < n; i++) {
        const a = time * 2.2 + (i / n) * Math.PI * 2;
        m.put(heart.x + Math.cos(a) * 0.95, heart.y + Math.sin(time * 3 + i) * 0.2, heart.z + Math.sin(a) * 0.95, 0.2, COLD[0], COLD[1], COLD[2], 1.6 * k);
      }
      m.put(heart.x, heart.y, heart.z, 2.2, COLD[0], COLD[1], COLD[2], 0.3 * k);
    }
    // Mending: drops of the brook drawn up into it.
    if (v.mode === 'mend' && v.act !== 'sink' && v.act !== 'under' && v.act !== 'rise') {
      for (let i = 0; i < 14 * few; i++) {
        const f = (time * 0.5 + hash(i * 7.7)) % 1;
        const a = hash(i * 2.9) * Math.PI * 2;
        const r = 1.2 * (1 - f);
        m.put(gx + Math.cos(a) * r, gy + f * (heart.y - gy), gz + Math.sin(a) * r, 0.16, 0.5, 0.75, 1.0, 0.9 * Math.sin(f * Math.PI) * k);
      }
    }
    // The lights' halos: findable from across the grove.
    this.lanterns.at.forEach((at, i) => {
      const g = this.lanterns.glowOf(i);
      if (g < 0.01) return;
      const pulse = 1 + 0.12 * Math.sin(time * 2.4 + i);
      m.put(at.x, at.y, at.z, (1.3 + 0.5 * day) * pulse, COLD[0], COLD[1], COLD[2], g * (0.55 + 0.4 * (1 - day)) * k);
      for (let j = 0; j < 3; j++) {
        const a = time * 1.1 + j * 2.1 + i;
        m.put(at.x + Math.cos(a) * 0.4, at.y + Math.sin(a * 1.7) * 0.3, at.z + Math.sin(a) * 0.4, 0.12, COLD[0], COLD[1], COLD[2], g * 1.3 * k);
      }
    });
    this.drawBursts(time, k);
    this.lastAct = awake ? v.act : '';
    m.end();
    this.puffs.end();
    this.bands.end();
  }

  /** Mist's glow and opacity this frame (by daylight). */
  private gl = 1;
  private ma = 0.7;

  /** The sweep's lane: low mist streaming out along it between its walls, faster as it comes. */
  private streamLane(v: SpiritView, p: number, time: number, few: number): void {
    const half = this.d.attacks.sweep.half;
    const len = Math.hypot(v.tx - v.x, v.tz - v.z) || 1;
    const ux = (v.tx - v.x) / len;
    const uz = (v.tz - v.z) / len;
    for (let i = 0; i < 14 * few; i++) {
      const f = (time * (0.35 + 0.6 * p) + hash(i * 4.1)) % 1;
      if (f > Math.min(1, p * 1.7)) continue;
      const s = (hash(i * 8.3) * 2 - 1) * half * 0.6;
      const x = v.x + ux * f * len - uz * s;
      const z = v.z + uz * f * len + ux * s;
      const h = hash(i * 3.3);
      this.puffs.put(x, this.ground(x, z) + 0.25 + 0.5 * h, z, 1.2 + 0.5 * h, i + time * 0.3, PARTICLE.wisp, PALE, this.gl, (0.2 + 0.4 * p) * (1 - h * 0.6) * Math.sin(f * Math.PI) * this.ma);
    }
  }

  private drawRings(time: number, k: number, few: number): void {
    const R = this.d.attacks.bolt.radius;
    this.rings = this.rings.filter((r) => time < r.t1 + 0.05);
    for (const r of this.rings) {
      const p = Math.min(1, Math.max(0, (time - r.t0) / Math.max(0.1, r.t1 - r.t0)));
      const y = this.ground(r.x, r.z);
      // The outer ring: its whole reach, a low wall of warm mist with puffs and sparks rising off it, thickest at the
      // ground; it glows more as the bolt comes.
      const gl = this.gl;
      const ma = this.ma;
      this.bands.put(r.x, r.z, R, y, AMBER, (0.45 + 0.35 * p) * ma, 1.0, gl * (1.25 + 0.6 * p));
      const n = Math.round(14 * few);
      for (let i = 0; i < n; i++) {
        const a = ((i + hash(i * 1.7) * 0.6) / n) * Math.PI * 2 + time * 0.08;
        const f = (time * 0.4 + hash(i * 2.7)) % 1;
        this.puffs.put(r.x + Math.cos(a) * R, y + 0.25 + f * 1.3, r.z + Math.sin(a) * R, 0.9 + 0.6 * f, a + f * 2, i % 2 ? PARTICLE.wisp : PARTICLE.puff, AMBER, gl, 0.55 * (1 - f) ** 1.5 * (0.6 + 0.4 * p) * ma);
      }
      for (let i = 0; i < Math.round(10 * few); i++) {
        const a = hash(i * 7.7) * Math.PI * 2;
        const f = (time * 0.8 + hash(i * 2.9)) % 1;
        m2(this.motes, r.x + Math.cos(a) * R, y + 0.2 + 1.2 * f, r.z + Math.sin(a) * R, 0.1, AMBER, (0.6 + 0.8 * p) * (1 - f) * k);
      }
      // The inner ring closing on the middle as it comes: where it lands is when it lands.
      this.bands.put(r.x, r.z, R * (1 - p), y, AMBER, (0.4 + 0.4 * p) * ma, 2.2, gl * (1.4 + p));
    }
  }

  private drawFlights(time: number, k: number): void {
    const keep: Flight[] = [];
    for (const f of this.flights) {
      const p = (time - f.t0) / Math.max(0.05, f.t1 - f.t0);
      if (p >= 1) {
        this.burst({ x: f.to.x, y: this.ground(f.to.x, f.to.z) + 0.4, z: f.to.z }, 'land', time);
        continue;
      }
      keep.push(f);
      for (let j = 0; j < 6; j++) {
        const q = Math.max(0, p - j * 0.025);
        const x = f.from.x + (f.to.x - f.from.x) * q;
        const z = f.from.z + (f.to.z - f.from.z) * q;
        const y = f.from.y + (f.to.y + 0.4 - f.from.y) * q + Math.sin(q * Math.PI) * 2.2;
        m2(this.motes, x, y, z, j === 0 ? 0.6 : 0.34 - j * 0.04, j === 0 ? [1, 0.92, 0.75] : AMBER, (j === 0 ? 3 : 1.2 - j * 0.18) * k);
      }
    }
    this.flights = keep;
  }

  private drawPool(x: number, z: number, msLeft: number, time: number, k: number, few: number): void {
    if (msLeft <= 0) return;
    const last = this.d.attacks.pools.last;
    const age = last - msLeft / 1000;
    const on = Math.min(1, age / 0.4) * Math.min(1, msLeft / 600);
    const r0 = this.d.attacks.pools.radius;
    const y = this.ground(x, z);
    // Slow green fire-mist over its whole circle, thickest at the ground, licking upward; its edge a low wall of it.
    const gl = this.gl;
    const ma = this.ma;
    for (let i = 0; i < 16 * few; i++) {
      const a = hash(i * 1.9 + x) * Math.PI * 2 + time * 0.05;
      const r = Math.sqrt(hash(i * 3.7 + z)) * r0 * 0.85;
      const f = (time * 0.22 + hash(i * 5.3)) % 1;
      this.puffs.put(x + Math.cos(a) * r, y + 0.2 + f * 1.0, z + Math.sin(a) * r, 1.3 + 0.5 * f, a + time * 0.15, i % 3 ? PARTICLE.puff : PARTICLE.wisp, GREEN, gl, 0.5 * (1 - f) ** 1.4 * on * ma);
    }
    for (let i = 0; i < 12 * few; i++) {
      const a = hash(i * 4.9 + x) * Math.PI * 2;
      const r = Math.sqrt(hash(i * 2.1 + z)) * r0 * 0.9;
      const f = (time * 0.45 + hash(i * 8.3)) % 1;
      m2(this.motes, x + Math.cos(a) * r, y + 0.15 + f * 1.2, z + Math.sin(a) * r, 0.1, GREEN, 0.9 * (1 - f) * on * k);
    }
    this.bands.put(x, z, r0, y, GREEN, 0.6 * on * ma, 0.35, gl);
  }

  private drawBursts(time: number, k: number): void {
    this.bursts = this.bursts.filter((b) => time - b.t0 < b.dur);
    for (const b of this.bursts) {
      const t = time - b.t0;
      const f = t / b.dur;
      for (let i = 0; i < b.n; i++) {
        const a = hash(b.seed * 13.1 + i * 1.3) * Math.PI * 2;
        const e = b.shape === 0 ? 0.15 * hash(i * 2.2 + b.seed) : b.shape < 0 ? 0.3 + 0.7 * hash(i * 2.2 + b.seed) : hash(i * 2.2 + b.seed) * 2 - 1;
        const sp = b.speed * (0.5 + 0.5 * hash(i * 4.9 + b.seed));
        const r = sp * t * (1 - 0.35 * f);
        const h = Math.sqrt(Math.max(0, 1 - e * e));
        const x = b.x + Math.cos(a) * h * r;
        const z = b.z + Math.sin(a) * h * r;
        const y = b.y + e * r + (b.shape < 0 ? t * 0.8 : 0);
        m2(this.motes, x, y, z, b.size * (1 - 0.4 * f), b.color, 1.6 * (1 - f) * k);
      }
      if (t < 0.15 && b.shape >= 0) m2(this.motes, b.x, b.y, b.z, b.size * 8, b.color, 2.5 * (1 - t / 0.15) * k);
    }
  }

  dispose(): void {
    this.motes.dispose();
    this.puffs.dispose();
    this.bands.dispose();
    this.lane.dispose();
    this.mist.dispose();
    this.lanterns.dispose();
  }
}

function m2(m: Motes, x: number, y: number, z: number, size: number, c: [number, number, number], a: number): void {
  m.put(x, y, z, size, c[0], c[1], c[2], a);
}
