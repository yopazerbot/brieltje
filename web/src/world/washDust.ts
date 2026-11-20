import * as THREE from 'three';
import { daylight } from './daylight';
import { reflectionSkips } from './reflections';
import { particleSheet } from './sprites';
import { windAt } from './wind';

/**
 * What a helicopter's rotor wash throws about (world/rotorWash.ts says where, how hard and over what): three things of
 * its own, drawn as big games draw it, so a machine pressing air down reads at a glance from 30 m.
 *
 * - The cloud: a few dozen big soft sprites (the shared sheet's puff and wisp, world/sprites.ts) that roll outward
 *   along the ground from under the disc, slow, curl up at the ring's edge and linger, drifting with the wind
 *   (world/wind.ts) for a few seconds after the machine has gone. Dust coloured by the ground under it, pale chaff
 *   haze over grass, white spray off wet ground and water, a white cloud off snow. Sorted back to front every frame
 *   (a few dozen: nothing pops), and each fades out towards the ground it rose from, so no straight cut shows where
 *   its square meets the ground. One draw.
 * - The bits: one instanced set of small flat flakes racing outward low and fast, skipping along the ground and
 *   fluttering: chaff, clippings and November's leaves off grass, grit off gravel and earth, drops off the wet, flakes
 *   off snow. Never under about two pixels on screen, so the stream shows from 30 m. Opaque (cut out), so no
 *   order matters. One draw.
 * - The sheen: on grass, a flat disc on the ground under each machine (two at most) where the pressed blades show
 *   their paler sides in streaks running outward; it reads from any distance and on Low, where no blades are drawn.
 *
 * Everything takes the day's light (dark at night). Low and phones: half as many sprites and bits, smaller.
 */

/** What the ground under a spot is, for the wash (world/rotorWash.ts). */
export type WashGround = 'snow' | 'water' | 'gravel' | 'earth' | 'grass' | 'paving' | 'bare';

const SPRITES = 88;
const SPRITES_LOW = 40;
const BITS = 420;
const BITS_LOW = 180;

const SPRITE_VERT = /* glsl */ `
attribute vec4 iPos;   // x, y, z, size (m across)
attribute vec4 iColor; // rgb, alpha
attribute vec4 iMisc;  // ground y, turn, sheet cell, width over height
varying vec2 vUv;
varying vec4 vColor;
varying float vFade;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(iMisc.y), s = sin(iMisc.y);
  vec2 k = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iPos.w * vec2(iMisc.w, 1.0);
  vec3 world = iPos.xyz + right * k.x + up * k.y;
  // Faded out towards the ground under it: no straight edge where the square would cut into it.
  vFade = smoothstep(0.0, max(0.4, iPos.w * 0.3), world.y - iMisc.x);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vec2 cell = vec2(mod(iMisc.z, 2.0), 1.0 - floor(iMisc.z / 2.0));
  vUv = (position.xy + 0.5 + cell) * 0.5;
  vColor = iColor;
}`;

const SPRITE_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float light;
varying vec2 vUv;
varying vec4 vColor;
varying float vFade;
void main() {
  vec4 t = texture2D(map, vUv);
  float a = vColor.a * t.a * vFade;
  if (a < 0.004) discard;
  // The sheet's puff is lit from above; keep its shading but most of the dust's own colour.
  gl_FragColor = vec4(vColor.rgb * mix(vec3(1.0), t.rgb, 0.55) * light, a);
}`;

const BIT_VERT = /* glsl */ `
attribute vec4 iPos;   // x, y, z, size (m)
attribute vec4 iColor; // rgb, turn
uniform float pxScale; // pixels per metre at 1 m
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
  // Never under about two pixels: a stream of bits still shows from 30 m.
  float size = max(iPos.w, 2.0 * -mv.z / pxScale);
  // Fluttering: the flake turns, and its width swings as it tumbles.
  float c = cos(iColor.a), s = sin(iColor.a);
  vec2 k = vec2(position.x * (0.35 + 0.65 * abs(c)), position.y);
  k = vec2(c * k.x - s * k.y, s * k.x + c * k.y) * size;
  vec3 world = iPos.xyz + right * k.x + up * k.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vUv = position.xy * 2.0;
  vColor = iColor.rgb * (0.75 + 0.35 * abs(s)); // catching the light as it turns
}`;

const BIT_FRAG = /* glsl */ `
uniform float light;
varying vec3 vColor;
varying vec2 vUv;
void main() {
  if (dot(vUv, vUv) > 1.0) discard;
  gl_FragColor = vec4(vColor * light, 1.0);
}`;

const SHEEN_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SHEEN_FRAG = /* glsl */ `
uniform float time;
uniform float strength;
uniform float light;
uniform vec3 color;
varying vec2 vP;
void main() {
  float r = length(vP);
  if (r >= 1.0) discard;
  float a = atan(vP.y, vP.x);
  // Streaks of pressed blades running outward, uneven round the ring, strongest a third of the way out.
  float streak = 0.5 + 0.5 * sin(r * 22.0 - time * 9.0 + sin(a * 7.0 + time * 1.3) * 2.0 + sin(a * 23.0) * 1.2);
  float ring = smoothstep(0.04, 0.3, r) * (1.0 - smoothstep(0.45, 1.0, r));
  gl_FragColor = vec4(color * light, strength * ring * (0.45 + 0.55 * streak));
}`;

/** The colours: dust by ground, haze, spray, and the bits by kind (sRGB here, linear in use). */
const DUST: Record<WashGround, string> = {
  snow: '#f1f4f7', water: '#e8eef0', gravel: '#bdb4a3', earth: '#a68d6b', grass: '#cdc6a4', paving: '#b8b2a7', bare: '#cfcbc4',
};
const SPRAY = '#e6ecee';
const CHAFF = ['#d8c99c', '#c6b37e', '#e0d5ae', '#a89b62'];
const LEAVES = ['#7a5a14', '#6e3412', '#8a6a1c', '#4a2a10', '#9a7a2a'];
const CLIPPINGS = ['#8f9a4c', '#a6a85c'];
const GRIT = ['#8d877c', '#6e675d', '#a39c8f'];
const EARTH_GRIT = ['#6a5540', '#7d6a50', '#56463a'];
const DROPS = ['#dfe7e9', '#eef3f4'];
const FLAKES = ['#ffffff', '#eef3f8'];
const lin = (h: string) => new THREE.Color(h);
const C = {
  dust: Object.fromEntries(Object.entries(DUST).map(([k, v]) => [k, lin(v)])) as Record<WashGround, THREE.Color>,
  spray: lin(SPRAY),
  chaff: CHAFF.map(lin), leaves: LEAVES.map(lin), clippings: CLIPPINGS.map(lin), grit: GRIT.map(lin), earth: EARTH_GRIT.map(lin), drops: DROPS.map(lin), flakes: FLAKES.map(lin),
};
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

interface Sprite {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  age: number; life: number; size0: number; size1: number; alpha: number; ground: number;
  rot: number; spin: number; cell: number; curl: number; wide: number; r: number; g: number; b: number;
}
interface Bit {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  age: number; life: number; size: number; ground: number; rot: number; spin: number; gravity: number; drag: number; r: number; g: number; b: number;
}

/** One emission: from under a machine at (x, z), the ground there `ground` (y) of kind `kind`. */
export interface WashSpot {
  x: number;
  z: number;
  ground: number;
  kind: WashGround;
  /** the wash's strength (0 to about 1.2) */
  w: number;
  /** its reach (m) and the rotor's radius (m) */
  reach: number;
  rotor: number;
  /** the machine's height over the ground (m) */
  height: number;
  /** the ground wet (rain), autumn leaves about */
  wet: boolean;
  autumn: boolean;
  /** the machine's own speed over the ground (m/s) */
  vx: number;
  vz: number;
}

export class WashDust {
  readonly group = new THREE.Group();
  private sprites: Sprite[] = [];
  private bits: Bit[] = [];
  private spriteMesh: THREE.Mesh;
  private bitMesh: THREE.Mesh;
  private sAttr: { pos: THREE.InstancedBufferAttribute; color: THREE.InstancedBufferAttribute; misc: THREE.InstancedBufferAttribute };
  private bAttr: { pos: THREE.InstancedBufferAttribute; color: THREE.InstancedBufferAttribute };
  private sGeo = new THREE.InstancedBufferGeometry();
  private bGeo = new THREE.InstancedBufferGeometry();
  private light = { value: 1 };
  private pxScale = { value: 500 };
  private sheens: { mesh: THREE.Mesh; u: { time: { value: number }; strength: { value: number }; light: { value: number }; color: { value: THREE.Color } } }[] = [];
  private order: number[] = [];
  private depth = new Float32Array(SPRITES);
  private v = new THREE.Vector3();
  private size = new THREE.Vector2();
  /** Low and phones: fewer and smaller */
  low = false;

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const attr = (n: number, k: number) => new THREE.InstancedBufferAttribute(new Float32Array(n * k), k).setUsage(THREE.DynamicDrawUsage);
    for (const [g, n] of [[this.sGeo, SPRITES], [this.bGeo, BITS]] as const) {
      g.index = quad.index;
      g.setAttribute('position', quad.getAttribute('position'));
      g.instanceCount = 0;
      void n;
    }
    this.sAttr = { pos: attr(SPRITES, 4), color: attr(SPRITES, 4), misc: attr(SPRITES, 4) };
    this.sGeo.setAttribute('iPos', this.sAttr.pos);
    this.sGeo.setAttribute('iColor', this.sAttr.color);
    this.sGeo.setAttribute('iMisc', this.sAttr.misc);
    this.bAttr = { pos: attr(BITS, 4), color: attr(BITS, 4) };
    this.bGeo.setAttribute('iPos', this.bAttr.pos);
    this.bGeo.setAttribute('iColor', this.bAttr.color);
    this.spriteMesh = new THREE.Mesh(
      this.sGeo,
      new THREE.ShaderMaterial({ uniforms: { map: { value: particleSheet() }, light: this.light }, vertexShader: SPRITE_VERT, fragmentShader: SPRITE_FRAG, transparent: true, depthWrite: false }),
    );
    this.bitMesh = new THREE.Mesh(this.bGeo, new THREE.ShaderMaterial({ uniforms: { light: this.light, pxScale: this.pxScale }, vertexShader: BIT_VERT, fragmentShader: BIT_FRAG, side: THREE.DoubleSide }));
    this.bitMesh.onBeforeRender = (renderer, _s, camera) => {
      renderer.getDrawingBufferSize(this.size);
      this.pxScale.value = this.size.y / (2 * Math.tan((((camera as THREE.PerspectiveCamera).fov ?? 60) * Math.PI) / 360));
    };
    this.spriteMesh.renderOrder = 2;
    for (const m of [this.spriteMesh, this.bitMesh]) {
      m.frustumCulled = false;
      m.raycast = () => {};
      m.userData.ignoreRay = true;
      m.userData.noAO = true;
      this.group.add(m); // always in the scene: an empty draw costs nothing, and the warm-up makes its program before play

    }
    for (let i = 0; i < 2; i++) {
      const u = { time: { value: 0 }, strength: { value: 0 }, light: { value: 1 }, color: { value: lin('#e9ecd0') } };
      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
        new THREE.ShaderMaterial({ uniforms: u, vertexShader: SHEEN_VERT, fragmentShader: SHEEN_FRAG, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      );
      mesh.renderOrder = 1;
      mesh.frustumCulled = false; // parked far under the ground when unused (its program made in the warm-up)
      mesh.position.y = -1e4;
      mesh.raycast = () => {};
      mesh.userData.ignoreRay = true;
      mesh.userData.noAO = true;
      this.sheens.push({ mesh, u });
      this.group.add(mesh);
    }
    reflectionSkips.objects.add(this.group);
  }

  /** How many are alive now (dev). */
  get counts(): { sprites: number; bits: number } {
    return { sprites: this.sprites.length, bits: this.bits.length };
  }

  private sprite(s: Sprite): void {
    const cap = this.low ? SPRITES_LOW : SPRITES;
    if (this.sprites.length >= cap) this.sprites.shift(); // the oldest (most faded) makes room
    this.sprites.push(s);
  }

  private bit(b: Bit): void {
    const cap = this.low ? BITS_LOW : BITS;
    if (this.bits.length >= cap) this.bits.shift();
    this.bits.push(b);
  }

  /**
   * One frame's worth from under one machine: `dt` seconds of it, `far` 0 to 1 (fewer far off). The rates are at full
   * strength; all of it scales with the wash's strength, so it builds on the way down and clears as the machine settles.
   */
  emit(o: WashSpot, dt: number, far: number, acc: { cloud: number; bits: number }, sample: (x: number, z: number) => { y: number; kind: WashGround }): void {
    const w = Math.min(1.2, o.w);
    if (w < 0.03) return;
    const low = this.low ? 0.5 : 1;
    const R = o.rotor;
    const dusty = o.kind === 'gravel' || o.kind === 'earth' || o.kind === 'snow' || (o.kind === 'paving' && !o.wet);
    // The cloud: dusty ground rolls a dense ring; grass a light haze; wet ground and water a ring of spray.
    const cloudRate = (dusty ? 30 : o.kind === 'grass' && !o.wet ? 14 : o.kind === 'bare' && !o.wet ? 0 : 20) * w * far * low;
    acc.cloud += dt * cloudRate;
    while (acc.cloud >= 1) {
      acc.cloud -= 1;
      const a = Math.random() * Math.PI * 2;
      const core = dusty && Math.random() < 0.4; // some stays under the disc, round the skids
      const r = core ? R * Math.random() * 0.45 : R * (0.35 + Math.random() * 0.6) + o.height * 0.05;
      const x = o.x + Math.cos(a) * r;
      const z = o.z + Math.sin(a) * r;
      const g = sample(x, z);
      const wet = o.wet || g.kind === 'water';
      const kind = g.kind === 'bare' && !wet ? null : g.kind;
      if (!kind) continue;
      const dry = (kind === 'gravel' || kind === 'earth' || kind === 'snow' || kind === 'paving') && !wet;
      const strong = Math.min(1, w);
      const speed = (core ? 1 + Math.random() * 2 : 7 + 9 * strong) * (0.75 + Math.random() * 0.5);
      // Thickest low down (the skids half hidden at 2 m), thinner from higher up.
      const low2 = 1 - Math.min(1, Math.max(0, (o.height - 2) / 14)) * 0.5;
      const color = wet ? C.spray : C.dust[kind];
      const alpha = (wet ? 0.5 : dry ? (kind === 'paving' ? 0.45 : kind === 'snow' ? 0.8 : core ? 0.85 : 0.72) : 0.34) * (0.4 + 0.6 * strong) * low2;
      const big = dry ? 1 : wet ? 0.7 : 0.85;
      this.sprite({
        x, y: g.y + (core ? 0.8 : 0.4), z,
        vx: Math.cos(a) * speed + o.vx * 0.3, vy: core ? 0.2 + Math.random() * 0.3 : 0.05 + Math.random() * 0.15, vz: Math.sin(a) * speed + o.vz * 0.3,
        age: 0, life: (dry ? (core ? 2.4 : 2.8) + Math.random() * 1.6 : wet ? 1.4 + Math.random() * 0.8 : 2 + Math.random()) * (this.low ? 0.8 : 1),
        size0: (core ? 3 : 1.8) * big, size1: (dry ? (core ? 6 : 5) + Math.random() * 3 : 4 + Math.random() * 2) * big * (this.low ? 0.8 : 1),
        alpha, ground: g.y, rot: (Math.random() - 0.5) * 0.4, spin: (Math.random() - 0.5) * 0.3,
        cell: Math.random() < (dry ? 0.25 : 0.45) ? 3 : 0, curl: dry ? 0.8 + Math.random() * 0.8 : 0.3, wide: core ? 1.5 : 1.9, r: color.r, g: color.g, b: color.b,
      });
    }
    // The bits: a low sheet racing outward.
    const bitRate = (o.kind === 'bare' && !o.wet ? 0 : o.kind === 'grass' ? 170 : 70) * w * far * low;
    acc.bits += dt * bitRate;
    while (acc.bits >= 1) {
      acc.bits -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = R * (0.2 + Math.random() * 0.8);
      const x = o.x + Math.cos(a) * r;
      const z = o.z + Math.sin(a) * r;
      const g = sample(x, z);
      const wet = o.wet || g.kind === 'water';
      let list: THREE.Color[];
      let size = 0.06;
      let gravity = 7;
      let drag = 0.7;
      if (wet) [list, size, gravity, drag] = [C.drops, 0.035, 9, 0.5];
      else if (g.kind === 'snow') [list, size, gravity, drag] = [C.flakes, 0.05, 2.5, 1.6];
      else if (g.kind === 'grass') {
        const leaf = o.autumn && Math.random() < 0.35;
        [list, size, gravity, drag] = leaf ? [C.leaves, 0.1, 3, 1.4] : Math.random() < 0.8 ? [C.chaff, 0.06, 4, 1.1] : [C.clippings, 0.05, 4, 1.1];
      } else if (g.kind === 'earth') [list, size] = [C.earth, 0.04];
      else if (g.kind === 'bare') continue;
      else {
        const leaf = o.autumn && Math.random() < 0.2;
        [list, size, gravity, drag] = leaf ? [C.leaves, 0.1, 3, 1.4] : [C.grit, 0.035, 9, 0.5];
      }
      const c = pick(list);
      const speed = (8 + 9 * Math.min(1, w)) * (0.6 + Math.random() * 0.6);
      this.bit({
        x, y: g.y + 0.05 + Math.random() * 0.25, z,
        vx: Math.cos(a) * speed, vy: 0.6 + Math.random() * 2.2, vz: Math.sin(a) * speed,
        age: 0, life: 1.1 + Math.random() * 1.3, size: size * (0.7 + Math.random() * 0.6), ground: g.y, rot: Math.random() * 6.283,
        spin: (Math.random() - 0.5) * 30, gravity, drag, r: c.r, g: c.g, b: c.b,
      });
    }
  }

  /** The sheen on grass under machine `i` (0 or 1): at (x, y, z) on the ground, `reach` m, strength `k` (0: none). */
  sheen(i: number, x: number, y: number, z: number, reach: number, k: number): void {
    const s = this.sheens[i];
    if (!s) return;
    s.u.strength.value = 0;
    if (k <= 0.01) {
      s.mesh.position.y = -1e4;
      return;
    }
    s.mesh.position.set(x, y + 0.05, z);
    s.mesh.scale.set(reach, 1, reach);
    s.u.strength.value = Math.min(0.62, 0.6 * k);
  }

  /** Every frame: they move, age and go; sorted for drawing, back to front from `eye`. */
  update(dt: number, eye: THREE.Vector3, time: number): void {
    const d = Math.min(0.05, Math.max(0, dt));
    const light = daylight();
    this.light.value = light;
    for (const s of this.sheens) {
      s.u.time.value = time;
      s.u.light.value = light;
    }
    // The cloud: rolling out and slowing, curling up as it slows, then drifting with the wind.
    const sp = this.sprites;
    for (let i = sp.length - 1; i >= 0; i--) {
      const s = sp[i];
      s.age += d;
      if (s.age >= s.life) {
        sp.splice(i, 1);
        continue;
      }
      const wind = windAt(s.x, s.z);
      const k = 1 - Math.exp(-1.1 * d);
      const h0 = Math.hypot(s.vx, s.vz);
      s.vx += (wind.x - s.vx) * k;
      s.vz += (wind.z - s.vz) * k;
      const h1 = Math.hypot(s.vx, s.vz);
      // The speed lost along the ground turns upward at the ring's edge (the curl), up to about a metre a second.
      s.vy = Math.min(1.1, s.vy + Math.max(0, h0 - h1) * 0.08 * s.curl) * (1 - 0.5 * d);
      s.x += s.vx * d;
      s.y += s.vy * d;
      s.z += s.vz * d;
      s.rot += s.spin * d;
    }
    // The bits: thrown out, falling, skipping along the ground and slowing.
    const bt = this.bits;
    for (let i = bt.length - 1; i >= 0; i--) {
      const b = bt[i];
      b.age += d;
      if (b.age >= b.life) {
        bt.splice(i, 1);
        continue;
      }
      const k = Math.exp(-b.drag * d);
      b.vx *= k;
      b.vz *= k;
      b.vy = b.vy * k - b.gravity * d;
      b.x += b.vx * d;
      b.y += b.vy * d;
      b.z += b.vz * d;
      if (b.y < b.ground + 0.01) {
        b.y = b.ground + 0.01;
        b.vy = Math.abs(b.vy) * 0.3;
        b.vx *= 0.8;
        b.vz *= 0.8;
      }
      b.rot += b.spin * d;
    }
    // Back to front, so the soft cloud never pops.
    const n = sp.length;
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) {
      order[i] = i;
      this.depth[i] = this.v.set(sp[i].x - eye.x, sp[i].y - eye.y, sp[i].z - eye.z).lengthSq();
    }
    order.sort((a, b) => this.depth[b] - this.depth[a]);
    const P = this.sAttr.pos.array as Float32Array;
    const Q = this.sAttr.color.array as Float32Array;
    const M = this.sAttr.misc.array as Float32Array;
    for (let j = 0; j < n; j++) {
      const s = sp[order[j]];
      const t = s.age / s.life;
      const grow = 1 - Math.exp(-s.age * 1.1);
      const a = s.alpha * Math.min(1, s.age / 0.25) * (t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45);
      P.set([s.x, s.y, s.z, s.size0 + (s.size1 - s.size0) * grow], j * 4);
      Q.set([s.r, s.g, s.b, a], j * 4);
      M.set([s.ground, s.rot, s.cell, s.wide], j * 4);
    }
    const BP = this.bAttr.pos.array as Float32Array;
    const BC = this.bAttr.color.array as Float32Array;
    for (let j = 0; j < bt.length; j++) {
      const b = bt[j];
      BP.set([b.x, b.y, b.z, b.size], j * 4);
      BC.set([b.r, b.g, b.b, b.rot], j * 4);
    }
    for (const [a, count] of [[this.sAttr.pos, n], [this.sAttr.color, n], [this.sAttr.misc, n], [this.bAttr.pos, bt.length], [this.bAttr.color, bt.length]] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * 4);
      a.needsUpdate = true;
    }
    this.sGeo.instanceCount = n;
    this.bGeo.instanceCount = bt.length;
  }
}
