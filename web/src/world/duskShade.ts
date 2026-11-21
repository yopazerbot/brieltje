import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { terrain, terrainTexture } from './terrain';
import { blockMaterial, surfaceMaterial } from './houseMeshes';
import { SPRUCE_WOOD } from './cardTrees';

/**
 * The ground's sun shadow at dusk (world/groundShade.ts). The ground's bake holds the noon sun's shadow of every
 * house, hedge and tree; at dusk the sun stands low on the same compass side (world/weather.ts DUSK_SUN) and its
 * shadows are about four times as long. Near the eye the real-time maps draw them so (world/sunShadow.ts), but the bake
 * kept the short noon ones: beyond the maps, and on Low and phones everywhere but round the house, the ground's
 * shadows were short while the figures' soft shadows (world/figureShadows.ts) and the maps' lay long.
 *
 * So each area's bake gets a second picture of the sun's part alone, for dusk's sun, made in the background while the
 * game runs, a little each frame (as open-world games refresh their distant shadows over several frames): first the
 * casters into a depth image from the low sun, a few dozen meshes a frame within about a millisecond, then the shadow
 * itself a band of rows a frame. It is made when a dusk is coming (on Auto minutes ahead; picked by hand, at once) and
 * kept until two minutes after it. The ground then blends from the noon picture to the dusk one as the sun goes down
 * (the weather's `sunLow`, as cached time-of-day states are blended), and in over two seconds once a picture is new,
 * so nothing jumps. With the sun at noon height nothing is read or made: no cost. That is every other mood, the night
 * too: its moon stands where the noon sun does (world/weather.ts), so its few, faint shadows are the noon picture's
 * and agree with the maps'; long hard ones would look wrong under a weak moon.
 *
 * Only the sun's dimming is made again; the sky light, the contact band, the grass's kind and the slow variation
 * don't change with the sun. The picture takes the place of the bake's second image (the contact band's share, in
 * its first channel, as it was) and holds in its second the sun's dimming times that share, as the bake's own first
 * channel does: the ground reads it in its place with no texture more (its shaders have only so many: 16).
 */

/** Seconds a new dusk picture takes to blend in. */
export const FADE_S = 2;
/** Milliseconds the pictures are kept after a dusk (on Auto the next is an hour or more away). */
export const KEEP_MS = 120_000;
/** Processor time the depth image's meshes may take a frame (ms). */
const BUDGET_MS = 0.7;
/** Triangles the depth image may take a frame (about half a millisecond of this PC's graphics chip at most). */
const TRI_BUDGET = 300_000;
/** Texels of the shadow pass a frame: a band of rows of the picture (about 0.3 ms of this PC's graphics chip). */
const TEXELS_PER_FRAME = 2048 * 96;

/** A full-screen pass's quad and camera, for compiling its shader ahead (as world/warmShaders.ts compileQuad). */
export const CORNERS = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
export const FLAT_CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** Flat ground covers: their own shadow is a kerb's, and at a low sun they would shade themselves (sunShadow.ts NOT_FAR). */
export const FLAT = /^(pave_|rd_|road|gravel|field_soil|paving|kerb)|^bike-Wheel/;

/** The depth from the sun, and in the colour whether the nearest thing there is a repeated shape (a crown, a trunk, a post). */
export const REPEATED = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying float vRepeated;
void main() {
  #include <batching_vertex>
  #include <skinbase_vertex>
  #include <morphinstance_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #ifdef USE_INSTANCING
  vRepeated = 1.0;
  #else
  vRepeated = 0.0;
  #endif
}`,
  fragmentShader: /* glsl */ `
varying float vRepeated;
void main() { gl_FragColor = vec4(vRepeated, 0.0, 0.0, 1.0); }`,
});

/**
 * How much of the sun a tree's crown lets through where it stops the sun at `occ` (0 for anything else): a crown here
 * is a repeated shape (the bake's own test: high off the ground and above what stands solid there) at least 3.5 m up.
 * Shared with the walls' dusk pictures (world/wallDusk.ts).
 */
export const CROWN = /* glsl */ `
uniform float ground;
uniform sampler2D terrainMap;
uniform vec3 terrainArea;
uniform vec2 terrainSize;
const vec3 SPRUCE_WOOD = vec3(${SPRUCE_WOOD.map((v) => v.toFixed(1)).join(', ')});

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float terrainAt(vec2 xz) {
  return texture2D(terrainMap, ((xz - terrainArea.xy) / terrainArea.z + 0.5) / terrainSize).r;
}
float crownLight(vec3 occ) {
  if (occ.y - ground - terrainAt(occ.xz) < 3.5) return 0.0;
  float spruce = 0.86 * smoothstep(SPRUCE_WOOD.z + 10.0, SPRUCE_WOOD.z - 40.0, distance(occ.xz, SPRUCE_WOOD.xy));
  float gap = noise(occ.xz / 3.1) * 0.6 + noise(occ.xz / 1.3 + 7.0) * 0.4;
  return clamp(mix(0.42, 0.1, spruce) * (0.45 + 1.1 * gap), 0.0, 1.0);
}`;

/** The relief's heights as a texture, made once and kept (it doesn't change, and making it costs a few milliseconds). */
let relief: THREE.DataTexture | null = null;
export function reliefTexture(): THREE.DataTexture {
  return (relief ??= terrainTexture());
}

/** The crown's uniforms for a pass (CROWN), on the bake's ground height. */
export function crownUniforms(u: Record<string, THREE.IUniform>, ground: number): void {
  u.ground.value = ground;
  u.terrainMap.value = reliefTexture();
  u.terrainArea.value.set(terrain.x0, terrain.z0, terrain.step);
  u.terrainSize.value.set(terrain.nx, terrain.nz);
}

/**
 * The sun's dimming at dusk, times the contact band's share (the bake's second image). As the bake's (world/groundShade.ts
 * COMBINE): 25 taps on the ground round each spot, a tree's crown letting some of the sun through (CROWN).
 */
const SHADOW = /* glsl */ `
uniform sampler2D sunDepth;
uniform sampler2D sunRepeated;
uniform sampler2D contact;
uniform mat4 sunMatrix;
uniform vec3 area;
uniform float sunBias;
uniform float sunTap;
uniform vec3 sunDir;
uniform float sunRange;
varying vec2 vUv;
${CROWN}
void main() {
  vec2 xz = area.xy + (vUv * 2.0 - 1.0) * area.z;
  float lit = 0.0;
  for (int x = -2; x <= 2; x++)
    for (int y = -2; y <= 2; y++) {
      vec2 tap = xz + vec2(x, y) * (sunTap * 0.6);
      vec3 at = vec3(tap.x, ground + terrainAt(tap) + 0.06, tap.y);
      vec4 q = sunMatrix * vec4(at, 1.0);
      float d = q.z * 0.5 + 0.5;
      vec2 uv = q.xy * 0.5 + 0.5;
      float near = texture2D(sunDepth, uv).r;
      if (d - sunBias <= near) lit += 1.0;
      else if (texture2D(sunRepeated, uv).r > 0.5) lit += crownLight(at + sunDir * (d - near) * sunRange);
    }
  float band = texelFetch(contact, ivec2(gl_FragCoord.xy), 0).r;
  gl_FragColor = vec4(band, lit / 25.0 * band, 0.0, 1.0);
}`;

/** What a bake was made of, for its dusk picture. */
export interface DuskSource {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  casters: THREE.Object3D[];
  ground: number;
  centre: THREE.Vector3;
  half: number;
  size: number;
  /** The bake's contact band (its second image) */
  contact: THREE.Texture;
  /** What casts the bake's shadows in place of something cut out (groundShade.ts bakeStandIns) */
  standIns: Set<(on: boolean) => void>;
}

interface Job {
  /** Waiting for its shaders, the depth image from the sun, the picture */
  phase: 'warm' | 'compile' | 'depth' | 'shadow';
  meshes: THREE.Mesh[];
  /** Triangles each mesh draws */
  tris: number[];
  next: number;
  chunk: number;
  depth: THREE.WebGLRenderTarget;
  cam: THREE.OrthographicCamera;
  out: THREE.WebGLRenderTarget;
  row: number;
  bias: number;
  tap: number;
}

interface Sheet {
  src: DuskSource;
  /** The dusk picture, once made, and the sun it was made for */
  done: THREE.WebGLRenderTarget | null;
  dir: THREE.Vector3;
  /** 0 to 1: how far it has blended in since it was made */
  fade: number;
  job: Job | null;
}

/**
 * Who makes dusk pictures of their own from the same scene (the walls' and roofs', world/wallDusk.ts): called each frame
 * after the ground's step, `free` when the ground took no step (one piece of work a frame, the ground's first).
 */
export interface DuskFollower {
  /** `wanted` and `dir` as DuskShade.step; `low` the sun's height (0 noon to 1 dusk); `near` the area read now (its centre). */
  step(wanted: boolean, dir: THREE.Vector3, low: number, free: boolean, sources: () => DuskSource[], near: THREE.Vector3 | null): void;
}
export const duskFollowers = new Set<DuskFollower>();

export class DuskShade {
  private sheets = new Map<object, Sheet>();
  private pass: FullScreenQuad | null = null;
  private last = performance.now();
  /** The sun's height as last read (0 noon to 1 dusk: the weather's `sunLow`), for the followers */
  private low = 0;
  /** Whether a step of the ground's own work was taken this frame */
  private worked = false;
  /** When a dusk was last coming or showing, and whether any picture is made or being made */
  private wantedAt = -Infinity;
  private held = false;
  /** Development: the longest step's processor time (ms) and the steps taken, for checking the budget. */
  readonly stats = { longest: 0, longestWhat: '', steps: 0, made: 0 };
  /** Development: who follows it (their own stats) */
  readonly followers = duskFollowers;

  /** A bake (keyed by its render target) whose dusk picture may be wanted. */
  add(key: object, src: DuskSource): void {
    this.forget(key);
    this.sheets.set(key, { src, done: null, dir: new THREE.Vector3(), fade: 0, job: null });
  }

  /** A bake thrown away: its dusk picture and any work on it too. */
  forget(key: object): void {
    const s = this.sheets.get(key);
    if (!s) return;
    if (s.job) this.drop(s.job);
    s.done?.dispose();
    this.sheets.delete(key);
  }

  /** The dusk picture of a bake, and how much of it to show (0: none), for the ground's uniforms. */
  read(key: object | null, low: number): [THREE.Texture | null, number] {
    this.low = low;
    const s = key ? this.sheets.get(key) : undefined;
    if (!s?.done || low <= 0) return [null, 0];
    return [s.done.texture, low * s.fade * s.fade * (3 - 2 * s.fade)];
  }

  /**
   * Each frame: `wanted` when a dusk is coming or showing, `dir` towards dusk's sun. Makes one picture at a time, the
   * keys in `first` before the others (the area read and the whole map's).
   */
  step(wanted: boolean, dir: THREE.Vector3, first: (object | null)[]): boolean {
    this.worked = false;
    const dropped = this.groundStep(wanted, dir, first);
    if (duskFollowers.size) {
      const near = first[0] ? this.sheets.get(first[0])?.src.centre ?? null : null;
      for (const f of duskFollowers) f.step(wanted && dir.lengthSq() >= 0.5, dir, this.low, !this.worked, this.sources, near);
    }
    return dropped;
  }

  /** What each bake was made of (for the followers). */
  private sources = (): DuskSource[] => [...this.sheets.values()].map((s) => s.src);

  private groundStep(wanted: boolean, dir: THREE.Vector3, first: (object | null)[]): boolean {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    for (const s of this.sheets.values()) if (s.done && s.fade < 1) s.fade = Math.min(1, s.fade + dt / FADE_S);
    if (!wanted || dir.lengthSq() < 0.5) {
      // Long after a dusk, its pictures go (a few megabytes each); the next dusk makes them again.
      if (now - this.wantedAt < KEEP_MS || !this.held) return false;
      for (const s of this.sheets.values()) {
        if (s.job) this.drop(s.job);
        s.job = null;
        s.done?.dispose();
        s.done = null;
      }
      this.held = false;
      return true;
    }
    this.wantedAt = now;
    const t0 = performance.now();
    let working: Sheet | undefined;
    for (const s of this.sheets.values()) if (s.job) working = s;
    let what = 'start';
    if (!working) {
      const due = (s: Sheet | undefined) => !!s && (!s.done || s.dir.distanceToSquared(dir) > 1e-6);
      for (const k of first) if (!working && k && due(this.sheets.get(k))) working = this.sheets.get(k);
      for (const s of this.sheets.values()) if (!working && due(s)) working = s;
      if (!working) return false;
      working.job = this.start(working, dir); // a frame of its own: finding the meshes
      this.held = true;
    } else {
      what = working.job!.phase;
      this.work(working, working.job!);
    }
    this.worked = true;
    const ms = performance.now() - t0;
    this.stats.steps++;
    if (ms > this.stats.longest) {
      this.stats.longest = ms;
      this.stats.longestWhat = what;
    }
    return false;
  }

  private start(s: Sheet, dir: THREE.Vector3): Job {
    const { centre, half, size, casters } = s.src;
    s.dir.copy(dir);
    // The meshes the bake draws (groundShade.ts render: solid ones), less the flat ground covers.
    const flat = new Set<THREE.Material>();
    for (const name of ['field_soil', 'gravel', 'pave_light', 'pave_grey', 'road', 'rd_concrete', 'rd_asphalt', 'rd_tiles']) flat.add(blockMaterial(name, s.src.renderer).material);
    flat.add(surfaceMaterial('paving', s.src.renderer));
    const meshes: THREE.Mesh[] = [];
    const tris: number[] = [];
    for (const root of casters)
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const m = o.material as THREE.Material;
        if (Array.isArray(o.material) || m.transparent || m.alphaTest > 0 || o.userData.glassIndex !== undefined || m.userData?.noGroundShade) return;
        if (flat.has(m) || FLAT.test(o.name)) return;
        meshes.push(o);
        const g = o.geometry as THREE.BufferGeometry;
        tris.push((((g.index?.count ?? g.attributes.position?.count) || 0) / 3) * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1));
      });
    // From the low sun: as wide as the bake's, but only as tall as the area seen at a slant, so its texels lie on
    // the ground about as long as the noon picture's.
    const r = half * 1.5;
    const up = Math.max(0.05, dir.y);
    const v = Math.min(r, r * up + 25);
    const away = Math.max(700, half * 1.6);
    const cam = new THREE.OrthographicCamera(-r, r, v, -v, 1, away * 2);
    cam.position.copy(centre).addScaledVector(dir, away);
    cam.lookAt(centre);
    cam.updateMatrixWorld();
    const depth = new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthTexture: new THREE.DepthTexture(size, size, THREE.FloatType),
    });
    const out = new THREE.WebGLRenderTarget(size, size, { format: THREE.RGFormat, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    out.texture.anisotropy = 4;
    // A tap's own depth against the image's, along the sun: a texel and a half of slope at this slant.
    const texel = (2 * v) / size;
    const bias = Math.max(0.35, (1.5 * texel * Math.sqrt(1 - up * up)) / up);
    return { phase: 'warm', meshes, tris, next: 0, chunk: 8, depth, cam, out, row: 0, bias, tap: (1.5 * 2 * r) / size };
  }

  /** The pass that makes the picture (made once, kept: its uniforms are each job's own). */
  private shadowPass(): THREE.ShaderMaterial {
    this.pass ??= new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: {
        sunDepth: { value: null }, sunRepeated: { value: null }, contact: { value: null }, sunMatrix: { value: new THREE.Matrix4() },
        area: { value: new THREE.Vector3() }, ground: { value: 0 }, sunBias: { value: 0 }, terrainMap: { value: null },
        terrainArea: { value: new THREE.Vector3() }, terrainSize: { value: new THREE.Vector2() }, sunTap: { value: 1 },
        sunDir: { value: new THREE.Vector3() }, sunRange: { value: 1 },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: SHADOW,
      depthTest: false,
      depthWrite: false,
    }));
    return this.pass.material as THREE.ShaderMaterial;
  }

  /**
   * The job's shaders compiled in the background where the browser can (as world/warmShaders.ts): the depth image's
   * for each kind of mesh it draws, and the pass's. A first draw would wait for them, tens of milliseconds. The job
   * starts once they are ready.
   */
  private compile(renderer: THREE.WebGLRenderer, job: Job): void {
    job.phase = 'compile';
    const kinds = new Map<string, THREE.Mesh>();
    for (const m of job.meshes) {
      const i = m as THREE.InstancedMesh;
      const key = `${!!i.isInstancedMesh}|${!!i.instanceColor}|${!!(m as THREE.SkinnedMesh).isSkinnedMesh}|${!!m.morphTargetInfluences}|${!!(m as THREE.BatchedMesh).isBatchedMesh}`;
      if (!kinds.has(key)) kinds.set(key, m);
    }
    const before = renderer.getRenderTarget();
    const waits: Promise<unknown>[] = [];
    try {
      renderer.setRenderTarget(job.depth);
      for (const m of kinds.values()) {
        const own = m.material;
        const shown = m.visible;
        m.material = REPEATED;
        m.visible = true;
        try {
          waits.push(renderer.compileAsync(m, job.cam));
        } finally {
          m.material = own;
          m.visible = shown;
        }
      }
      renderer.setRenderTarget(job.out);
      waits.push(renderer.compileAsync(new THREE.Mesh(CORNERS, this.shadowPass()), FLAT_CAM));
    } finally {
      renderer.setRenderTarget(before);
    }
    void Promise.all(waits).then(() => {
      if (job.phase === 'compile') job.phase = 'depth';
    });
  }

  private drop(job: Job): void {
    job.depth.depthTexture?.dispose();
    job.depth.dispose();
    job.out.dispose();
  }

  private work(s: Sheet, job: Job): void {
    const { renderer } = s.src;
    const before = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    try {
      if (job.phase === 'warm') this.compile(renderer, job); // a frame of its own
      if (job.phase === 'warm' || job.phase === 'compile') return;
      if (job.phase === 'depth') this.depthStep(s, job);
      else this.shadowStep(s, job);
    } finally {
      renderer.setRenderTarget(before);
      renderer.autoClear = autoClear;
      renderer.setClearColor(clearColor, clearAlpha);
    }
  }

  /** The next meshes into the depth image from the sun, everything else hidden meanwhile (as the bake does it). */
  private depthStep(s: Sheet, job: Job): void {
    const { renderer, scene, casters } = s.src;
    const t0 = performance.now();
    renderer.setRenderTarget(job.depth);
    if (job.next === 0) {
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
    }
    // As many meshes as the last step's time allows, and not too many triangles for the graphics chip.
    let end = job.next;
    for (let tris = 0; end < job.meshes.length && end < job.next + job.chunk && (end === job.next || tris + job.tris[end] <= TRI_BUDGET); end++) tris += job.tris[end];
    const chunk = new Set(job.meshes.slice(job.next, end));
    const keep = new Map<THREE.Object3D, boolean>();
    const hide = (o: THREE.Object3D, v: boolean) => {
      if (!keep.has(o)) keep.set(o, o.visible);
      o.visible = v;
    };
    const background = scene.background;
    const fog = scene.fog;
    const override = scene.overrideMaterial;
    const autoMatrix = scene.matrixWorldAutoUpdate;
    for (const f of s.src.standIns) f(true);
    try {
      for (const o of scene.children) hide(o, false);
      for (const root of casters) {
        for (let p: THREE.Object3D | null = root; p && p !== scene; p = p.parent) hide(p, true);
        root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) hide(o, chunk.has(o as THREE.Mesh));
        });
      }
      scene.background = null;
      scene.fog = null;
      scene.overrideMaterial = REPEATED;
      // The whole scene's matrices are not worked out again for a few meshes that stand still (the frame's drawing does it).
      scene.matrixWorldAutoUpdate = false;
      if (chunk.size) renderer.render(scene, job.cam);
    } finally {
      scene.matrixWorldAutoUpdate = autoMatrix;
      scene.overrideMaterial = override;
      scene.background = background;
      scene.fog = fog;
      for (const [o, v] of keep) o.visible = v;
      for (const f of s.src.standIns) f(false);
    }
    job.next = end;
    // Within the budget: more meshes next time if this was quick, fewer if not.
    const ms = performance.now() - t0;
    job.chunk = Math.max(4, Math.min(160, Math.round(job.chunk * Math.min(1.4, Math.max(0.5, BUDGET_MS / Math.max(ms, 0.05))))));
    if (job.next >= job.meshes.length) job.phase = 'shadow';
  }

  /** A band of rows of the dusk picture; the last one makes its smaller copies, and the picture is in. */
  private shadowStep(s: Sheet, job: Job): void {
    const { renderer, ground, centre, half, size, contact } = s.src;
    const u = this.shadowPass().uniforms;
    const cam = job.cam;
    u.sunDepth.value = job.depth.depthTexture;
    u.sunRepeated.value = job.depth.texture;
    u.contact.value = contact;
    u.sunMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    u.area.value.set(centre.x, centre.z, half);
    crownUniforms(u, ground);
    u.sunBias.value = job.bias / (cam.far - cam.near);
    u.sunTap.value = job.tap;
    u.sunDir.value.copy(s.dir);
    u.sunRange.value = cam.far - cam.near;
    const rows = Math.max(16, Math.floor(TEXELS_PER_FRAME / size));
    const last = job.row + rows >= size;
    job.out.texture.generateMipmaps = last; // the smaller copies once, with the last band
    job.out.scissor.set(0, job.row, size, Math.min(rows, size - job.row));
    job.out.scissorTest = true;
    renderer.setRenderTarget(job.out);
    this.pass!.render(renderer);
    job.row += rows;
    if (!last) return;
    job.out.scissorTest = false;
    job.depth.depthTexture?.dispose();
    job.depth.dispose();
    s.done?.dispose();
    s.done = job.out;
    s.fade = 0;
    s.job = null;
    this.stats.made++;
  }
}
