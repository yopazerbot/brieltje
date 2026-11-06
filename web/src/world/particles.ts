import * as THREE from 'three';
import { particleSheet } from './sprites';

/**
 * Soft particles for smoke, dust, fire, sparks and debris: camera-facing
 * squares cut from one sprite sheet (sprites.ts). All particles of one kind
 * of blending are a single instanced draw call, kept in fixed pools, so an
 * explosion costs no new objects and no extra draw calls. Sparks can be
 * stretched along their flight on screen. Each particle grows, changes colour
 * and fades over its life.
 */

export interface Spawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds */
  life: number;
  /** Size in metres at the start and the end */
  size0: number;
  size1: number;
  /** Colour at the start and the end (linear, may be brighter than 1 for fire) */
  c0: THREE.Color;
  c1: THREE.Color;
  alpha: number;
  /** Cell of the sprite sheet: PARTICLE.puff, glow, chip or wisp */
  cell: number;
  /** Slowing down per second (air drag) */
  drag: number;
  /** m/s2 downwards; negative rises */
  gravity: number;
  /** Turning speed, rad/s */
  spin: number;
  /** Stretch along the flight on screen (sparks), 0 for none */
  stretch: number;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec3 iSize;
attribute vec3 iVel;
attribute float iCell;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec2 corner = position.xy;
  vec2 c;
  if (iSize.z > 0.0) {
    // Sparks: long along their flight as seen on screen.
    vec2 d = (modelViewMatrix * vec4(iVel, 0.0)).xy;
    float l = length(d);
    vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
    c = dir * corner.x * iSize.x * (1.0 + iSize.z * l) + vec2(-dir.y, dir.x) * corner.y * iSize.x;
  } else {
    float cs = cos(iSize.y);
    float sn = sin(iSize.y);
    c = vec2(cs * corner.x - sn * corner.y, sn * corner.x + cs * corner.y) * iSize.x;
  }
  mv.xy += c;
  gl_Position = projectionMatrix * mv;
  // 2 x 2 sheet; the canvas's top row is the upper half of the texture.
  vec2 cell = vec2(mod(iCell, 2.0), 1.0 - floor(iCell / 2.0));
  vUv = (corner + 0.5 + cell) * 0.5;
  vColor = iColor;
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
}`;

class Pool {
  readonly mesh: THREE.Mesh;
  count = 0;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private size: Float32Array; // size0, size1
  private rot: Float32Array; // angle, spin
  private phys: Float32Array; // drag, gravity, stretch
  private c0: Float32Array;
  private c1: Float32Array;
  private alpha: Float32Array;
  private iPos: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute;
  private iSize: THREE.InstancedBufferAttribute;
  private iVel: THREE.InstancedBufferAttribute;
  private iCell: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;

  constructor(private capacity: number, map: THREE.Texture, additive: boolean) {
    const n = capacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.size = new Float32Array(n * 2);
    this.rot = new Float32Array(n * 2);
    this.phys = new Float32Array(n * 3);
    this.c0 = new Float32Array(n * 3);
    this.c1 = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const attr = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', (this.iPos = attr(3)));
    this.geo.setAttribute('iColor', (this.iColor = attr(4)));
    this.geo.setAttribute('iSize', (this.iSize = attr(3)));
    this.geo.setAttribute('iVel', (this.iVel = attr(3)));
    this.geo.setAttribute('iCell', (this.iCell = attr(1)));
    this.geo.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2; // after the window glass
    this.mesh.userData.ignoreRay = true;
    this.mesh.raycast = () => {}; // the base square sits at the origin; never hit it
  }

  spawn(s: Spawn): void {
    // Full: the oldest particle (slot 0) makes room.
    const i = this.count < this.capacity ? this.count++ : 0;
    this.pos.set([s.x, s.y, s.z], i * 3);
    this.vel.set([s.vx, s.vy, s.vz], i * 3);
    this.life[i] = this.max[i] = s.life;
    this.size.set([s.size0, s.size1], i * 2);
    this.rot.set([Math.random() * Math.PI * 2, s.spin], i * 2);
    this.phys.set([s.drag, s.gravity, s.stretch], i * 3);
    this.c0.set([s.c0.r, s.c0.g, s.c0.b], i * 3);
    this.c1.set([s.c1.r, s.c1.g, s.c1.b], i * 3);
    this.alpha[i] = s.alpha;
    this.iCell.array[i] = s.cell;
  }

  /** Move a particle from slot `from` to slot `to` (filling the gap of a dead one). */
  private move(from: number, to: number): void {
    const copy = (a: Float32Array, k: number) => a.copyWithin(to * k, from * k, from * k + k);
    copy(this.pos, 3);
    copy(this.vel, 3);
    copy(this.life, 1);
    copy(this.max, 1);
    copy(this.size, 2);
    copy(this.rot, 2);
    copy(this.phys, 3);
    copy(this.c0, 3);
    copy(this.c1, 3);
    copy(this.alpha, 1);
    copy(this.iCell.array as Float32Array, 1);
  }

  update(dt: number): void {
    for (let i = this.count - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) this.move(--this.count, i);
    }
    const p = this.iPos.array;
    const col = this.iColor.array;
    const sz = this.iSize.array;
    const v = this.iVel.array;
    for (let i = 0; i < this.count; i++) {
      const drag = Math.max(0, 1 - this.phys[i * 3] * dt);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - this.phys[i * 3 + 1] * dt;
      this.vel[i * 3 + 2] *= drag;
      for (let k = 0; k < 3; k++) {
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
        p[i * 3 + k] = this.pos[i * 3 + k];
        v[i * 3 + k] = this.vel[i * 3 + k];
      }
      const t = 1 - this.life[i] / this.max[i]; // 0 at birth, 1 at the end
      for (let k = 0; k < 3; k++) col[i * 4 + k] = this.c0[i * 3 + k] + (this.c1[i * 3 + k] - this.c0[i * 3 + k]) * t;
      col[i * 4 + 3] = this.alpha[i] * Math.min(1, t * 12) * (1 - t);
      this.rot[i * 2] += this.rot[i * 2 + 1] * dt;
      sz[i * 3] = this.size[i * 2] + (this.size[i * 2 + 1] - this.size[i * 2]) * Math.sqrt(t);
      sz[i * 3 + 1] = this.rot[i * 2];
      sz[i * 3 + 2] = this.phys[i * 3 + 2];
    }
    for (const [a, k] of [[this.iPos, 3], [this.iColor, 4], [this.iSize, 3], [this.iVel, 3], [this.iCell, 1]] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.count * k);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = this.count;
  }
}

export class Particles {
  readonly group = new THREE.Group();
  /** Fewer big smoke puffs on Low graphics (each one is many pixels to draw) */
  budget = 1;
  private normal: Pool;
  private additive: Pool;

  constructor() {
    const map = particleSheet();
    this.normal = new Pool(1500, map, false);
    this.additive = new Pool(800, map, true);
    this.group.add(this.normal.mesh, this.additive.mesh);
  }

  /** Add one particle: smoke, dust and debris blend normally; fire, sparks and glows add light. */
  spawn(s: Spawn, add = false): void {
    (add ? this.additive : this.normal).spawn(s);
  }

  update(dt: number): void {
    this.normal.update(dt);
    this.additive.update(dt);
  }
}
