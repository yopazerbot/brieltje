import * as THREE from 'three';
import FC from '../../shared/football.json';
import { mood } from './mood';
import { terrain } from './terrain';
import type { Prism, VillageData } from './houseData';

/**
 * FC Smetlede's football ground by the Wellebeek, at the end of Schildekensstraat (Yoshi, 8 Nov 2026: "make this a
 * hotspot that is really nice and lively"). shared/football.json (tools/football_site.py) has the plan; the model
 * (tools/football.py, models/football.glb) the buildings, goals, rails, fences, nets and floodlight masts; this the
 * rest:
 * - the pitch: lines at the real sizes, mowing stripes and worn goalmouths, painted once on a canvas and laid over the
 *   levelled lawn (tools/terrain.py levels the ground there) as one decal, a little lusher than the meadows round it;
 * - the car park (dark asphalt) and the lane from Schildekensstraat (light concrete) as village ground covers, draped
 *   on the relief and drawn in the village's tiles like the streets' (no cover of the open data lies there);
 * - the trees round the ground the laser saw, as the village's trees;
 * - the nets and the mesh fences: a mesh drawn in code, see-through;
 * - the floodlights, from dusk on (world/mood.ts `night`): the lamps' faces glow, a glow round each (the bloom
 *   picks it up) and the pitch is lit as one pool of light on the grass that brightens what is there (as the street
 *   lamps' pools: no real lights, so nothing else pays for it). Every value stays far under the half floats' end;
 * - a goal on its pitch (shared/ball.mjs 'fc') swells the net.
 * The training, the spectators and the sounds are world/footballLife.ts.
 */

type Site = typeof FC;
const S: Site = FC;
const U = S.u as [number, number];
const W = S.w as [number, number];
/** The game point (x, z) at (u, w) in the ground's frame. */
export function fcAt(u: number, w: number): [number, number] {
  return [S.centre[0] + U[0] * u + W[0] * w, S.centre[1] + U[1] * u + W[1] * w];
}
/** (u, w) of a game point. */
export function fcFrame(x: number, z: number): [number, number] {
  const dx = x - S.centre[0];
  const dz = z - S.centre[1];
  return [dx * U[0] + dz * U[1], dx * W[0] + dz * W[1]];
}
export const FC_SITE = S;

/** LED white, a little cool (linear). */
const LED = new THREE.Color(0.92, 0.96, 1.0);

const glowVertex = /* glsl */ `
  uniform float size;
  varying vec2 vUv;
  void main() {
    vUv = uv - 0.5;
    vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    centre.xy += position.xy * size;
    gl_Position = projectionMatrix * centre;
  }`;
const glowFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  varying vec2 vUv;
  void main() {
    float r = length(vUv) * 2.0;
    float glow = (exp(-r * r * 10.0) * 3.0 + exp(-r * r * 2.0) * 0.4) * (1.0 - smoothstep(0.6, 1.0, r));
    gl_FragColor = vec4(color * glow * strength, 1.0);
  }`;
// The pitch under the floodlights: what is drawn there times one plus the light (as the street lamps' pools).
const poolVertex = /* glsl */ `
  varying vec2 vUw;
  attribute vec2 uw;
  void main() {
    vUw = uw;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const poolFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  uniform vec4 box;
  uniform vec4 masts[4];
  varying vec2 vUw;
  void main() {
    // Even over the pitch, softer towards the rail and fading beyond it; a little more near each mast's aim.
    float inU = 1.0 - smoothstep(box.x, box.y, abs(vUw.x));
    float inW = 1.0 - smoothstep(box.z, box.w, abs(vUw.y));
    float hot = 0.0;
    for (int i = 0; i < 4; i++) {
      vec2 d = (vUw - masts[i].xy) / masts[i].zw;
      hot += exp(-dot(d, d));
    }
    float light = inU * inW * (0.72 + 0.28 * min(hot, 1.5));
    gl_FragColor = vec4(color * light * strength * 7.0, 1.0);
  }`;

/** A see-through mesh: `cell` metres a hole, wires `wire` metres thick, in `color`; one tile of the canvas is `tile` metres. */
function meshTexture(size: number, tile: number, cell: number, wire: number, color: string, diamond: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, size, size);
  g.strokeStyle = color;
  const k = size / tile;
  g.lineWidth = Math.max(1.2, wire * k);
  const n = Math.round(tile / cell);
  const step = size / n;
  g.beginPath();
  if (diamond) {
    for (let i = -n; i <= 2 * n; i++) {
      g.moveTo(i * step, 0);
      g.lineTo(i * step + size, size);
      g.moveTo(i * step, 0);
      g.lineTo(i * step - size, size);
    }
  } else {
    for (let i = 0; i <= n; i++) {
      g.moveTo(i * step, 0);
      g.lineTo(i * step, size);
      g.moveTo(0, i * step);
      g.lineTo(size, i * step);
    }
  }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / tile, 1 / tile);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The pitch's paint: lines, stripes and wear over the rail's rectangle, `k` pixels a metre. */
function pitchCanvas(k: number): HTMLCanvasElement {
  const { rail, length: L, width: Wd } = S;
  const c = document.createElement('canvas');
  c.width = Math.round((rail.u1 - rail.u0) * k);
  c.height = Math.round((rail.w1 - rail.w0) * k);
  const g = c.getContext('2d')!;
  const X = (u: number) => (u - rail.u0) * k;
  const Y = (w: number) => (w - rail.w0) * k;
  // Lusher than the meadows: a fresh green over the lawn, the run-off between the lines and the rail a little paler.
  g.fillStyle = 'rgba(60, 118, 34, 0.30)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(52, 112, 30, 0.16)';
  g.fillRect(X(-L / 2), Y(-Wd / 2), L * k, Wd * k);
  // Mowing stripes across the pitch, 5.5 m wide (twelve between the goal lines, eighteen... as the mower went).
  const stripe = L / 18;
  for (let i = 0; i < 18; i++) {
    g.fillStyle = i % 2 ? 'rgba(255, 255, 235, 0.075)' : 'rgba(0, 20, 0, 0.09)';
    g.fillRect(X(-L / 2 + i * stripe), Y(-Wd / 2 - 1.5), stripe * k, (Wd + 3) * k);
  }
  // Wear: bare, muddy goalmouths and the penalty spots, a worn strip along the halfway line, and the linesmen's run.
  const worn = (u: number, w: number, ru: number, rw: number, a: number) => {
    const grad = g.createRadialGradient(X(u), Y(w), 0, X(u), Y(w), 1);
    grad.addColorStop(0, `rgba(112, 92, 58, ${a})`);
    grad.addColorStop(0.55, `rgba(118, 100, 62, ${a * 0.55})`);
    grad.addColorStop(1, 'rgba(118, 100, 62, 0)');
    g.save();
    g.translate(X(u), Y(w));
    g.scale(ru * k, rw * k);
    g.translate(-X(u), -Y(w));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(X(u), Y(w), 1, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  for (const s of [-1, 1]) {
    worn((s * L) / 2 - s * 2.5, 0, 4.2, 6.5, 0.62);
    worn((s * L) / 2 - s * 6, 0, 6, 9, 0.28);
    worn((s * L) / 2 - s * 11, 0, 1.4, 1.4, 0.45);
    worn(0, s * (Wd / 2 + 0.9), 30, 0.9, 0.12);
  }
  worn(0, 0, 3.5, 3.5, 0.25);
  // Speckles of other greens and the odd clover, so the grass doesn't look painted.
  let seed = 17;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < (c.width * c.height) / 90; i++) {
    const x = rnd() * c.width;
    const y = rnd() * c.height;
    g.fillStyle = rnd() < 0.5 ? 'rgba(20, 60, 10, 0.10)' : 'rgba(170, 200, 110, 0.08)';
    g.fillRect(x, y, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  // The lines: 12 cm, white.
  g.strokeStyle = 'rgba(246, 246, 240, 0.96)';
  g.fillStyle = 'rgba(246, 246, 240, 0.96)';
  g.lineWidth = Math.max(2, 0.12 * k);
  const rect = (u0: number, u1: number, w0: number, w1: number) => g.strokeRect(X(u0), Y(w0), (u1 - u0) * k, (w1 - w0) * k);
  const arc = (u: number, w: number, r: number, a0: number, a1: number) => {
    g.beginPath();
    g.arc(X(u), Y(w), r * k, a0, a1);
    g.stroke();
  };
  rect(-L / 2, L / 2, -Wd / 2, Wd / 2);
  g.beginPath();
  g.moveTo(X(0), Y(-Wd / 2));
  g.lineTo(X(0), Y(Wd / 2));
  g.stroke();
  arc(0, 0, 9.15, 0, Math.PI * 2);
  const spot = (u: number) => {
    g.beginPath();
    g.arc(X(u), Y(0), Math.max(1.5, 0.12 * k), 0, Math.PI * 2);
    g.fill();
  };
  spot(0);
  for (const s of [-1, 1]) {
    const gl = (s * L) / 2;
    rect(Math.min(gl, gl - s * 16.5), Math.max(gl, gl - s * 16.5), -20.16, 20.16);
    rect(Math.min(gl, gl - s * 5.5), Math.max(gl, gl - s * 5.5), -9.16, 9.16);
    spot(gl - s * 11);
    // The arc outside the box: the part of the 9.15 m circle round the spot beyond 16.5 m.
    const a = Math.acos(5.5 / 9.15);
    if (s < 0) arc(gl + 11, 0, 9.15, -a, a);
    else arc(gl - 11, 0, 9.15, Math.PI - a, Math.PI + a);
    for (const t of [-1, 1]) {
      const cw = (t * Wd) / 2;
      const start = s < 0 ? (t < 0 ? 0 : -Math.PI / 2) : t < 0 ? Math.PI / 2 : Math.PI;
      arc(gl, cw, 1, start, start + Math.PI / 2);
    }
  }
  return c;
}

/** The goal nets' resting scale and their swell after a goal. */
interface Net {
  mesh: THREE.Object3D;
  at: number;
}

export class FootballGround {
  readonly group = new THREE.Group();
  private lampMat: THREE.MeshStandardMaterial | null = null;
  private glows: THREE.InstancedMesh | null = null;
  private pool: THREE.Mesh | null = null;
  private uniforms = { color: { value: LED.clone() }, strength: { value: 0 }, size: { value: 1.5 } };
  private poolUniforms = {
    color: { value: LED.clone() },
    strength: { value: 0 },
    box: { value: new THREE.Vector4(S.length / 2 - 1, S.length / 2 + 7, S.width / 2 - 1, S.width / 2 + 6) },
    masts: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 1, 1)) },
  };
  private nets = new Map<string, Net>();
  private clock = 0;
  /** How bright the floodlights are now, 0 to 1 (world/footballLife.ts reads it: the evening training). */
  lit = 0;
  /** The ground's level (the origin's ground, house.ground plus the relief there). */
  readonly y: number;

  constructor(private ground: number, private phone: boolean) {
    this.group.name = 'football ground';
    this.y = ground + terrain.height(S.centre[0], S.centre[1]);
    this.group.add(this.pitch());
  }

  /** Into the village's data before its tiles are built: the car park and the lane as ground covers, and the trees. */
  addToVillage(data: VillageData): void {
    const cover = (m: string, ring: number[][]): Prism => ({ m, y0: -0.16, y1: -0.08, d: 8, p: [ring.map(([x, z]) => [x, z] as [number, number])] });
    const prisms = (data.prisms ??= []);
    for (const r of S.surfaces.asphalt) prisms.push(cover('rd_asphalt', r));
    for (const r of S.surfaces.concrete) prisms.push(cover('rd_concrete', r));
    for (const t of S.trees) data.trees.push({ x: t.x, z: t.z, y: this.ground + terrain.height(t.x, t.z) + t.y + 0.1, h: t.h, r: t.r });
  }

  /** The model (tools/football.py) once loaded: the nets' and fences' mesh, the lamps. */
  dress(model: THREE.Object3D): void {
    const goalNet = meshTexture(this.phone ? 128 : 256, 1.2, 0.12, 0.012, '#f2f2ee', false);
    const fence = meshTexture(this.phone ? 128 : 256, 1.0, 0.05, 0.004, '#2f4a33', true);
    const ballNet = meshTexture(this.phone ? 128 : 256, 1.5, 0.125, 0.01, '#1e2420', false);
    const seeThrough = (map: THREE.Texture, color: string, opacity: number) =>
      new THREE.MeshStandardMaterial({ map, color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.9 });
    const byName: Record<string, THREE.Material> = {
      fb_net: seeThrough(goalNet, '#ffffff', 1),
      fb_fence: seeThrough(fence, '#ffffff', 0.95),
      fb_ballnet: seeThrough(ballNet, '#ffffff', 0.9),
    };
    const lamps: number[][] = (model.children.find((o) => o.userData.lamps)?.userData.lamps as number[][] | undefined) ?? [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      const swap = byName[m.name];
      if (swap) {
        mesh.material = swap;
        mesh.castShadow = false;
        mesh.renderOrder = 5;
        mesh.userData.noAO = true;
      }
      if (m.name === 'fb_lamp') {
        this.lampMat = m;
        m.emissive = LED.clone();
        m.emissiveIntensity = 0;
      }
      if (mesh.name.startsWith('fb_goalnet_')) this.nets.set(mesh.name.slice('fb_goalnet_'.length), { mesh, at: -1 });
    });
    // The glows round the lamps (their places in the model's frame, the model's origin on the ground).
    if (lamps.length) {
      const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false } as const;
      const glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: glowVertex, fragmentShader: glowFragment, ...additive }), lamps.length);
      const m4 = new THREE.Matrix4();
      lamps.forEach(([x, y, z, dx, dy, dz], i) => glows.setMatrixAt(i, m4.makeTranslation(model.position.x + x + dx * 0.12, model.position.y + y + dy * 0.12, model.position.z + z + dz * 0.12)));
      glows.frustumCulled = false;
      glows.raycast = () => {};
      glows.renderOrder = 60;
      glows.userData.noAO = true;
      this.glows = glows;
      this.group.add(glows);
      // Where each mast's lamps aim on the pitch, for the pool's brighter patches.
      const aims = lamps.map(([x, y, z, dx, dy, dz]) => {
        const t = dy < -0.05 ? y / -dy : 30;
        return fcFrame(model.position.x + x + dx * t, model.position.z + z + dz * t);
      });
      for (let i = 0; i < 4; i++) {
        const pair = aims.slice(i * 2, i * 2 + 2);
        if (!pair.length) continue;
        const u = pair.reduce((a, p) => a + p[0], 0) / pair.length;
        const w = pair.reduce((a, p) => a + p[1], 0) / pair.length;
        this.poolUniforms.masts.value[i].set(u, w, 22, 16);
      }
    }
  }

  /** A goal on the ground's pitch: that goal's net swells. */
  goal(id: string): void {
    const net = this.nets.get(id);
    if (net) net.at = this.clock;
  }

  /** Each frame. */
  update(dt: number): void {
    this.clock += dt;
    // On from dusk (the street lamps come on at the same ramp), full by night.
    const night = mood.night;
    const on = Math.min(1, Math.max(0, (night - 0.03) / 0.22));
    this.lit = on;
    this.uniforms.strength.value = on;
    this.poolUniforms.strength.value = on;
    if (this.pool) this.pool.visible = on > 0.01;
    if (this.glows) this.glows.visible = on > 0.01;
    if (this.lampMat) this.lampMat.emissiveIntensity = on * 6;
    for (const net of this.nets.values()) {
      const t = this.clock - net.at;
      let s = 1;
      if (net.at >= 0 && t < 1.6) s = 1 + 0.32 * Math.sin(Math.min(t / 0.12, 1) * Math.PI * 0.5) * Math.exp(-t * 3.2) * (t < 0.12 ? 1 : Math.cos((t - 0.12) * 11));
      net.mesh.scale.set(s, 1 + (s - 1) * 0.25, 1 + (s - 1) * 0.15);
    }
  }

  /** The pitch's decal over the lawn and the floodlights' pool over it. */
  private pitch(): THREE.Object3D {
    const { rail } = S;
    const out = new THREE.Group();
    const k = this.phone ? 10 : 20;
    const tex = new THREE.CanvasTexture(pitchCanvas(k));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 8;
    const quad = (u0: number, u1: number, w0: number, w1: number, lift: number, extra = false) => {
      const pos: number[] = [];
      const uv: number[] = [];
      const uw: number[] = [];
      const n = 8;
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          const u = u0 + ((u1 - u0) * i) / n;
          const w = w0 + ((w1 - w0) * j) / n;
          const [x, z] = fcAt(u, w);
          pos.push(x, this.ground + terrain.height(x, z) + lift, z);
          uv.push((u - rail.u0) / (rail.u1 - rail.u0), (w - rail.w0) / (rail.w1 - rail.w0));
          uw.push(u, w);
        }
      }
      const index: number[] = [];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = j * (n + 1) + i;
          index.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      if (extra) g.setAttribute('uw', new THREE.Float32BufferAttribute(uw, 2));
      g.setIndex(index);
      g.computeVertexNormals();
      // Facing up whichever way the frame turns.
      if ((g.attributes.normal as THREE.BufferAttribute).getY(0) < 0) {
        g.setIndex(index.map((_, i, a) => a[i - (i % 3) + [0, 2, 1][i % 3]]));
        g.computeVertexNormals();
      }
      return g;
    };
    const paint = new THREE.Mesh(
      quad(rail.u0, rail.u1, rail.w0, rail.w1, 0.012),
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    );
    paint.name = 'football pitch';
    paint.receiveShadow = true;
    paint.renderOrder = 2; // after the lawn under it
    paint.raycast = () => {};
    paint.userData.noAO = true;
    out.add(paint);
    const pool = new THREE.Mesh(
      quad(rail.u0 - 4, rail.u1 + 4, rail.w0 - 4, rail.w1 + 3, 0.02, true),
      new THREE.ShaderMaterial({
        uniforms: this.poolUniforms,
        vertexShader: poolVertex,
        fragmentShader: poolFragment,
        transparent: true,
        depthWrite: false,
        fog: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.DstColorFactor,
        blendDst: THREE.OneFactor,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -6,
      }),
    );
    pool.name = 'football floodlit';
    pool.renderOrder = 60;
    pool.raycast = () => {};
    pool.userData.noAO = true;
    pool.visible = false;
    this.pool = pool;
    out.add(pool);
    return out;
  }
}
