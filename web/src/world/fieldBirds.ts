import * as THREE from 'three';
import { sound } from '../sound';
import { terrain } from './terrain';

/**
 * Birds over the countryside, all made in code and moved by their vertex shader on one clock:
 *
 * - rooks and jackdaws wheeling over the fields in loose flocks, flapping and gliding;
 * - crows feeding on the bare fields (tools/countryside.py says where), pecking and looking round.
 *   Come within about 25 m and the group flies up cawing, circles a while and lands again;
 * - mallards on the ponds and the wider ditches, paddling slowly round, now and then upending to
 *   feed with their tails in the air, quacking when you are near.
 *
 * Each kind is one draw call. Only the crows need the processor: a few distance checks a frame and
 * the moment a group took off. Purely for the look, so each player's own clock.
 */

const CAW_GAP = 0.35;

/** Browsers keep sound off until the first click or key: no sounds (nor an audio context) before. */
export const awake = (): boolean => (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;

/** One bird, about 45 cm long and 85 cm across the wings: a body and two wings (a number per vertex: 0 body, 1 wing). */
function birdGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const wing: number[] = [];
  const tri = (a: number[], b: number[], c: number[], w: number) => {
    pos.push(...a, ...b, ...c);
    wing.push(w, w, w);
  };
  const nose = [0, 0, 0.2];
  const tail = [0, 0.01, -0.17];
  const top = [0, 0.045, 0.01];
  const belly = [0, -0.04, 0.02];
  for (const s of [-1, 1]) {
    const side = [s * 0.05, 0, 0.03];
    tri(nose, side, top, 0);
    tri(nose, belly, side, 0);
    tri(side, tail, top, 0);
    tri(side, belly, tail, 0);
    // The tail fan and the wing (root at the shoulder, tip swept back).
    tri(tail, [s * 0.06, 0.005, -0.27], [0, 0.005, -0.28], 0);
    tri([s * 0.04, 0.01, 0.08], [s * 0.42, 0.01, -0.06], [s * 0.04, 0.01, -0.08], 1);
    tri([s * 0.42, 0.01, -0.06], [s * 0.3, 0.01, -0.14], [s * 0.04, 0.01, -0.08], 1);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('wing', new THREE.Float32BufferAttribute(wing, 1));
  g.computeVertexNormals();
  return g;
}

const ROTATIONS = `
  mat3 bRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
  mat3 bRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
  mat3 bRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }`;

/** A shader for the birds in the air and on the ground: where each is comes from its numbers and the clock. */
function birdMaterial(time: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.55, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.birdTime = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float wing;
        attribute vec4 home; // flock: its middle and size; crow: where it feeds and which way it faces
        attribute vec4 bird; // its own number, flock (0) or crow (1), when it took off, its size
        uniform float birdTime;
        ${ROTATIONS}
        vec3 flockAt(float t, float s) {
          // The flock wheels round its middle and drifts; each bird keeps its own place in it, loosely.
          vec3 c = home.xyz + vec3(home.w * cos(t * 0.11), 5.0 * sin(t * 0.21), home.w * 0.7 * sin(t * 0.11))
            + vec3(40.0 * sin(t * 0.013), 0.0, 40.0 * cos(t * 0.017));
          return c + vec3(7.0 * sin(t * 0.5 + s * 6.3), 2.5 * sin(t * 0.7 + s * 3.1), 7.0 * cos(t * 0.43 + s * 4.7)) * (0.5 + s);
        }
        vec3 crowAt(float t, float s, out float air) {
          float f = t - bird.z;
          air = (f > 0.0 && f < 34.0) ? smoothstep(0.0, 2.5, f) * (1.0 - smoothstep(27.0, 34.0, f)) : 0.0;
          vec3 c = home.xyz + vec3(12.0 * cos(s * 6.0), 0.0, 12.0 * sin(s * 6.0));
          float a = f * 0.33 + s * 6.28;
          vec3 circling = c + vec3((16.0 + 8.0 * s) * cos(a), 9.0 + 4.0 * s, (16.0 + 8.0 * s) * sin(a));
          return mix(home.xyz, circling, air);
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        float s = bird.x;
        float air = 1.0;
        vec3 at, ahead;
        if (bird.y < 0.5) {
          at = flockAt(birdTime, s);
          ahead = flockAt(birdTime + 0.15, s);
        } else {
          float air2;
          at = crowAt(birdTime, s, air);
          ahead = crowAt(birdTime + 0.15, s, air2);
        }
        vec3 v = ahead - at;
        float flying = step(0.02, air);
        float yaw = flying > 0.5 ? atan(v.x, v.z) : home.w + 0.4 * sin(birdTime * 0.3 + s * 9.0);
        float climb = flying > 0.5 ? atan(v.y, length(v.xz) + 1e-3) : 0.0;
        // On the ground: quick pecks now and then.
        float peck = (1.0 - flying) * pow(max(0.0, sin(birdTime * 2.3 + s * 30.0)), 6.0) * 0.6;
        // Wings: flapping, with glides; folded along the body on the ground.
        float flap = (0.15 + 0.55 * smoothstep(-0.2, 0.3, sin(birdTime * 0.9 + s * 13.0))) * sin(birdTime * 11.0 + s * 40.0);
        mat3 bRot = bRotY(yaw) * bRotX(-climb + peck) * bRotZ(flying * -0.25 * sign(sin(s * 7.0)));
        float wingSide = sign(position.x);
        mat3 wRot = bRotZ(wingSide * flap * flying);
        objectNormal = bRot * (wing > 0.5 ? wRot * objectNormal : objectNormal);`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 local = position * bird.w;
        if (wing > 0.5) {
          vec3 root = vec3(wingSide * 0.04 * bird.w, 0.0, 0.0);
          vec3 w = wRot * (local - root) + root;
          // Folded: pulled in along the body, the tips back.
          vec3 folded = vec3(local.x * 0.14, local.y + 0.02 * bird.w, local.z - abs(local.x) * 0.45);
          local = mix(folded, w, flying);
        }
        vec3 transformed = bRot * local + at + vec3(0.0, 0.05 * bird.w * (1.0 - flying), 0.0);`,
      );
  };
  mat.customProgramCacheKey = () => 'birds';
  return mat;
}

/** A caw, made in code: a hoarse, falling "kraa". */
function caw(at: THREE.Vector3, when = 0): void {
  if (!awake()) return;
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y, at.z, 8);
  if (!ctx || !dest) return;
  const t = ctx.currentTime + when;
  const len = 0.28 + Math.random() * 0.12;
  const f0 = 520 + Math.random() * 160;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f0 * 0.72, t + len);
  // Hoarseness: the tone's loudness rattles quickly.
  const rasp = ctx.createOscillator();
  rasp.type = 'square';
  rasp.frequency.value = 70 + Math.random() * 30;
  const raspGain = ctx.createGain();
  raspGain.gain.value = 0.45;
  const g = ctx.createGain();
  g.gain.value = 0.55;
  rasp.connect(raspGain).connect(g.gain);
  const throat = ctx.createBiquadFilter();
  throat.type = 'bandpass';
  throat.Q.value = 3;
  throat.frequency.value = 1300;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(0.45, t + 0.03);
  env.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(throat).connect(g).connect(env).connect(dest);
  o.start(t);
  rasp.start(t);
  o.stop(t + len + 0.05);
  rasp.stop(t + len + 0.05);
}

/** Calls from a spot: n caws in a row. */
export function caws(at: THREE.Vector3, n: number): void {
  for (let i = 0; i < n; i++) caw(at, i * (CAW_GAP + Math.random() * 0.25));
}

interface CrowGroup {
  at: THREE.Vector3;
  first: number;
  count: number;
  flushed: number;
}

export class Birds {
  readonly group = new THREE.Group();
  private time = { value: 0 };
  private groups: CrowGroup[] = [];
  private flocks: THREE.Vector3[] = [];
  private attr: THREE.InstancedBufferAttribute;
  private mesh: THREE.Mesh;
  private sphere = new THREE.Sphere();

  /** `flocks`: middles of the flocks over the fields; `crows`: where groups feed [x, z, how many]. */
  constructor(flocks: [number, number][], crows: [number, number, number][], ground: number) {
    const geometry = birdGeometry();
    const home: number[] = [];
    const bird: number[] = [];
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [x, z] of flocks) {
      const y = ground + terrain.height(x, z) + 34;
      this.flocks.push(new THREE.Vector3(x, y, z));
      for (let i = 0; i < 28; i++) {
        home.push(x, y, z, 50);
        bird.push(rand(), 0, -1000, 0.9 + rand() * 0.25);
      }
    }
    for (const [x, z, n] of crows) {
      const g: CrowGroup = { at: new THREE.Vector3(x, ground + terrain.height(x, z), z), first: bird.length / 4, count: n, flushed: -1000 };
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const d = 1 + rand() * 9;
        const cx = x + Math.cos(a) * d;
        const cz = z + Math.sin(a) * d;
        home.push(cx, ground + terrain.height(cx, cz), cz, rand() * Math.PI * 2);
        bird.push(rand(), 1, -1000, 1.05 + rand() * 0.15);
      }
      this.groups.push(g);
    }
    geometry.setAttribute('home', new THREE.InstancedBufferAttribute(new Float32Array(home), 4));
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(bird), 4);
    geometry.setAttribute('bird', this.attr);
    geometry.instanceCount = bird.length / 4;
    this.mesh = new THREE.Mesh(geometry, birdMaterial(this.time));
    this.mesh.frustumCulled = false; // placed by the shader; drawn when a flock or a group is in view (update)
    this.mesh.raycast = () => {};
    this.group.add(this.mesh);
  }

  /** Every frame: the clock, whether any birds are in view, and a group that you come near flies up. */
  update(eye: THREE.Vector3, frustum: THREE.Frustum): void {
    const now = performance.now() / 1000;
    this.time.value = now;
    // Where each flock is now (the shader's own sums for its middle), and the crows' fields.
    const inView = (c: THREE.Vector3, r: number, reach: number) => c.distanceTo(eye) < reach + r && frustum.intersectsSphere(this.sphere.set(c, r));
    const t = now;
    const flockAt = (h: THREE.Vector3) => new THREE.Vector3(h.x + 50 * Math.cos(t * 0.11) + 40 * Math.sin(t * 0.013), h.y + 5 * Math.sin(t * 0.21), h.z + 35 * Math.sin(t * 0.11) + 40 * Math.cos(t * 0.017));
    this.mesh.visible = this.flocks.some((h) => inView(flockAt(h), 25, 700)) || this.groups.some((g) => inView(g.at, 45, 350));
    const arr = this.attr.array as Float32Array;
    for (const g of this.groups) {
      if (now - g.flushed < 40 || Math.hypot(eye.x - g.at.x, eye.z - g.at.z) > 25 || eye.y - g.at.y > 20) continue;
      g.flushed = now;
      for (let i = 0; i < g.count; i++) arr[(g.first + i) * 4 + 2] = now + Math.random() * 0.6;
      this.attr.clearUpdateRanges();
      this.attr.addUpdateRange(g.first * 4, g.count * 4);
      this.attr.needsUpdate = true;
      caws(g.at.clone().setY(g.at.y + 2), 3 + Math.floor(Math.random() * 3));
    }
  }

  /** The groups' feeding spots (for calls from afar). */
  get spots(): THREE.Vector3[] {
    return this.groups.map((g) => g.at);
  }
}

/** A mallard, about 55 cm: body, neck and head, bill and tail, with a region number per vertex for its colours. */
function duckGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const region: number[] = [];
  const add = (pts: number[][], faces: number[][], r: number) => {
    for (const f of faces) for (const k of f) {
      pos.push(...pts[k]);
      region.push(r);
    }
  };
  // The body: a boat shape (front, back, sides, back line, keel).
  add([[0, 0.06, 0.2], [0, 0.1, -0.27], [-0.11, 0.06, 0], [0.11, 0.06, 0], [0, 0.15, -0.03], [0, -0.03, 0]],
    [[0, 2, 4], [0, 4, 3], [2, 1, 4], [3, 4, 1], [0, 5, 2], [0, 3, 5], [2, 5, 1], [3, 1, 5]], 0);
  // The breast, a little forward and low.
  add([[0, 0.1, 0.21], [-0.075, 0.07, 0.12], [0.075, 0.07, 0.12], [0, 0.0, 0.14]], [[0, 1, 2], [1, 3, 2], [0, 2, 3], [0, 3, 1]], 1);
  // Neck and head.
  add([[0, 0.25, 0.19], [-0.04, 0.2, 0.15], [0.04, 0.2, 0.15], [0, 0.18, 0.24], [0, 0.1, 0.16]], [[0, 1, 3], [0, 3, 2], [0, 2, 1], [1, 4, 3], [2, 3, 4], [1, 2, 4]], 2);
  // The bill.
  add([[-0.02, 0.2, 0.235], [0.02, 0.2, 0.235], [0, 0.18, 0.3], [0, 0.215, 0.23]], [[0, 2, 1], [0, 3, 2], [1, 2, 3]], 3);
  // The tail, turned up.
  add([[-0.04, 0.1, -0.24], [0.04, 0.1, -0.24], [0, 0.15, -0.33]], [[0, 1, 2], [0, 2, 1]], 4);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('region', new THREE.Float32BufferAttribute(region, 1));
  g.computeVertexNormals();
  return g;
}

/** Ducks paddling round on a pond: where each is comes from its pond, its number and the clock. */
function duckMaterial(time: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.duckTime = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float region;
        attribute vec4 pond; // its middle, the water's height, the room on it
        attribute vec4 duck; // its own number, drake (1) or duck (0)
        uniform float duckTime;
        varying vec3 vDuckColor;
        ${ROTATIONS}
        vec2 paddle(float t, float s) {
          float turn = (s > 0.5 ? 1.0 : -1.0) * (0.05 + 0.05 * s);
          float a = t * turn + s * 6.28;
          float r = pond.w * (0.3 + 0.6 * (0.5 + 0.5 * sin(t * 0.031 + s * 17.0)));
          return pond.xz + r * vec2(cos(a), sin(a));
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        float s = duck.x;
        vec2 here = paddle(duckTime, s);
        vec2 next = paddle(duckTime + 0.5, s);
        float yaw = atan(next.x - here.x, next.y - here.y);
        // Now and then it upends to feed: tail up, head under.
        float upend = smoothstep(0.93, 0.97, sin(duckTime * 0.15 + s * 9.0));
        mat3 dRot = bRotY(yaw) * bRotX(upend * 1.75 + 0.03 * sin(duckTime * 1.9 + s * 4.0));
        objectNormal = dRot * objectNormal;
        // Colours: drake (grey body, chestnut breast, green head, yellow bill) or duck (mottled brown, orange bill).
        int rg = int(region + 0.5);
        bool drake = duck.y > 0.5;
        vDuckColor = rg == 0 ? (drake ? vec3(0.42, 0.42, 0.39) : vec3(0.3, 0.2, 0.11))
          : rg == 1 ? (drake ? vec3(0.22, 0.09, 0.04) : vec3(0.32, 0.22, 0.12))
          : rg == 2 ? (drake ? vec3(0.02, 0.17, 0.07) : vec3(0.26, 0.17, 0.09))
          : rg == 3 ? (drake ? vec3(0.75, 0.62, 0.08) : vec3(0.6, 0.32, 0.06))
          : (drake ? vec3(0.03, 0.03, 0.03) : vec3(0.22, 0.14, 0.08));`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = dRot * (position - vec3(0.0, 0.05, 0.0)) * 1.15 + vec3(here.x, pond.y + 0.03 + 0.008 * sin(duckTime * 1.7 + s * 5.0), here.y);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDuckColor;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vDuckColor;');
  };
  mat.customProgramCacheKey = () => 'ducks';
  return mat;
}

/** A quack, made in code: a short nasal buzz that drops. */
function quack(at: THREE.Vector3, when: number): void {
  if (!awake()) return;
  const ctx = sound.context();
  const dest = sound.at(at.x, at.y, at.z, 3);
  if (!ctx || !dest) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(420, t);
  o.frequency.exponentialRampToValueAtTime(250, t + 0.16);
  const nose = ctx.createBiquadFilter();
  nose.type = 'bandpass';
  nose.Q.value = 4;
  nose.frequency.setValueAtTime(1500, t);
  nose.frequency.exponentialRampToValueAtTime(900, t + 0.16);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(nose).connect(g).connect(dest);
  o.start(t);
  o.stop(t + 0.2);
}

export class Ducks {
  readonly group = new THREE.Group();
  private time = { value: 0 };
  private ponds: THREE.Vector3[] = [];
  private rooms: number[] = [];
  private mesh: THREE.Mesh;
  private sphere = new THREE.Sphere();
  private quackIn = 6;

  /** `ponds`: [x, z, room, water height, how many] each. */
  constructor(ponds: [number, number, number, number, number][]) {
    const geometry = duckGeometry();
    const pond: number[] = [];
    const duck: number[] = [];
    let seed = 5;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [x, z, room, y, n] of ponds) {
      this.ponds.push(new THREE.Vector3(x, y, z));
      this.rooms.push(room);
      // In pairs: a drake and a duck with nearly the same number keep together.
      for (let i = 0; i < n; i++) {
        const s = i % 2 ? duck[duck.length - 4] + 0.004 : rand();
        pond.push(x, y, z, room);
        duck.push(s, i % 2 ? 0 : 1, 0, 0);
      }
    }
    geometry.setAttribute('pond', new THREE.InstancedBufferAttribute(new Float32Array(pond), 4));
    geometry.setAttribute('duck', new THREE.InstancedBufferAttribute(new Float32Array(duck), 4));
    geometry.instanceCount = duck.length / 4;
    this.mesh = new THREE.Mesh(geometry, duckMaterial(this.time));
    this.mesh.frustumCulled = false; // placed by the shader; drawn when a pond is near and in view (update)
    this.mesh.raycast = () => {};
    this.group.add(this.mesh);
  }

  update(dt: number, eye: THREE.Vector3, frustum: THREE.Frustum): void {
    this.time.value = performance.now() / 1000;
    // Beyond about 160 m a duck is a pixel or two: only near ponds in view are drawn.
    this.mesh.visible = this.ponds.some((p, i) => p.distanceTo(eye) < 160 && frustum.intersectsSphere(this.sphere.set(p, this.rooms[i] + 1)));
    this.quackIn -= dt;
    if (this.quackIn > 0) return;
    this.quackIn = 7 + Math.random() * 14;
    const near = this.ponds.find((p) => p.distanceTo(eye) < 35);
    if (near) {
      const n = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) quack(near, i * (0.22 + i * 0.03));
    }
  }
}
