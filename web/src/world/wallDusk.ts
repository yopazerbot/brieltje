import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { blockMaterial, surfaceMaterial } from './houseMeshes';
import { halfSize } from './textureFiles';
import { CORNERS, CROWN, FADE_S, FLAT, FLAT_CAM, KEEP_MS, REPEATED, crownUniforms, duskFollowers, type DuskFollower, type DuskSource } from './duskShade';

/**
 * The sun's shadow on our own buildings' walls and roofs at dusk (world/bakedLight.ts). Their bake holds the noon sun's
 * shadow; at dusk the sun stands low on the same side (world/weather.ts) and the ground's shadows grow long
 * (world/duskShade.ts), but a wall kept noon's: lit where a neighbour's long shadow should lie on it, with noon's deep band
 * under its own eaves. Beyond the real-time shadow maps, and on Low and phones everywhere, the wall and the ground beside
 * it disagreed.
 *
 * So each light page gets a second picture of the sun's part alone, for dusk's sun, at half the page's size, made in the
 * background when a dusk is coming, after the ground's (one piece of work a frame, as open-world games refresh their
 * distant shadows over several frames): first a depth image from the low sun over the page's buildings and whatever
 * stands towards the sun from them (a few dozen meshes a frame), then the page itself, drawn in its own layout (each
 * texel the spot on the wall it stands for, its sun found in the depth image with nine taps, a tree's crown letting some
 * through as on the ground), then a few texels' margin round each piece of the layout so the seams don't light up. The
 * walls then blend from the noon shadow to the dusk one as the sun goes down (the same blend as the ground's), and in
 * over two seconds once a picture is new. Nothing is read or made away from dusk, and the night keeps noon's (the
 * moon's) shadows, as the ground does. The sky's light in the bake stays as it is: it doesn't follow the sun.
 *
 * Memory: one byte a texel and its smaller copies: about 9 MB for all pages on a computer, about 2.5 MB on a phone (its
 * pages are half size already); while a picture is made, for a second or two, its depth image (at most 9 MB, 3 on a
 * phone) and a working copy of the page (2 MB at most). Freed two minutes after a dusk, as the ground's. Made from a
 * cold start in about 8 s after the ground's, no step above about 1.5 ms of processor or chip time on this PC.
 */

/** Processor time the depth image's meshes may take a frame (ms), as the ground's (duskShade.ts). */
const BUDGET_MS = 0.7;
/** Triangles the depth image may take a frame (on this PC's chip at most about a millisecond; a phone a third). */
const TRI_BUDGET = halfSize ? 100_000 : 300_000;
/** Texels of the page's own pass a frame (nine taps each), and twice as many of the margin's pass. */
const TEXELS_PER_FRAME = halfSize ? 512 * 128 : 1024 * 160;
/** Metres towards the sun beyond a page's buildings that may still shade them: a 40 m tower's shadow at dusk is 150 m long. */
const REACH = 200;
/** Texels the depth image may have: 3 M on a computer (9 MB with its markers), 1 M on a phone. */
const DEPTH_TEXELS = halfSize ? 1 << 20 : 3 << 20;

const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
white.needsUpdate = true;

/** The uniforms a baked material reads for its page (bakedLight.ts): the dusk picture and how much of it to show. */
export interface DuskPageUniforms {
  bakeDuskMap: { value: THREE.Texture };
  bakeDuskK: { value: number };
}

interface Page {
  meshes: THREE.Mesh[];
  /** Texels across the dusk picture */
  size: number;
  u: DuskPageUniforms;
  done: THREE.WebGLRenderTarget | null;
  dir: THREE.Vector3;
  fade: number;
  job: Job | null;
}

interface Job {
  phase: 'gather' | 'warm' | 'compile' | 'depth' | 'sun' | 'margin';
  src: DuskSource;
  /** The meshes still to be tested against the image's bounds, and the bounds */
  pool: THREE.Mesh[] | null;
  frustum: THREE.Frustum;
  /** Casters without bounds yet: drawn without being culled */
  unbounded: Set<THREE.Mesh>;
  casters: THREE.Mesh[];
  /** The groups the casters were found in */
  roots: THREE.Object3D[];
  tris: number[];
  next: number;
  chunk: number;
  cam: THREE.OrthographicCamera;
  depth: THREE.WebGLRenderTarget;
  /** The page's sun (r) and which texels the layout covers (g) */
  raw: THREE.WebGLRenderTarget;
  out: THREE.WebGLRenderTarget;
  row: number;
  /** Metres a depth texel spans */
  texel: number;
}

/** The page's sun at dusk, drawn in its layout (the second UV map): each texel the spot of the wall it stands for. */
const SUN = new THREE.ShaderMaterial({
  uniforms: {
    sunDepth: { value: null }, sunRepeated: { value: null }, sunMatrix: { value: new THREE.Matrix4() }, sunDir: { value: new THREE.Vector3() },
    sunRange: { value: 1 }, sunBias: { value: 0 }, texelM: { value: 0.1 },
    ground: { value: 0 }, terrainMap: { value: null }, terrainArea: { value: new THREE.Vector3() }, terrainSize: { value: new THREE.Vector2() },
  },
  vertexShader: /* glsl */ `
#ifndef USE_UV1
attribute vec2 uv1;
#endif
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  // The models are stored scaled unevenly (packed positions): a normal turns with the inverse's transpose.
  vNormal = transpose(inverse(mat3(modelMatrix))) * normal;
  gl_Position = vec4(uv1 * 2.0 - 1.0, 0.0, 1.0);
}`,
  fragmentShader: /* glsl */ `
uniform sampler2D sunDepth;
uniform sampler2D sunRepeated;
uniform mat4 sunMatrix;
uniform vec3 sunDir;
uniform float sunRange;
uniform float sunBias;
uniform float texelM;
varying vec3 vWorld;
varying vec3 vNormal;
${CROWN}
void main() {
  vec3 n = normalize(vNormal);
  float nl = dot(n, sunDir);
  // A little off the surface, the more the more it slants away from the sun: no surface shades itself.
  vec3 p = vWorld + n * texelM * (1.0 + 2.0 * (1.0 - abs(nl)));
  // Nine taps on the surface itself (a texel apart), each against its own depth: a wall the sun grazes doesn't
  // shade its own taps, as taps side by side in the image would.
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n, t1);
  float lit = 0.0;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++) {
      vec3 at = p + (t1 * float(x) + t2 * float(y)) * texelM;
      vec4 q = sunMatrix * vec4(at, 1.0);
      float d = q.z * 0.5 + 0.5;
      vec2 uv = q.xy * 0.5 + 0.5;
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
        lit += 1.0;
        continue;
      }
      float near = texture2D(sunDepth, uv).r;
      if (d - sunBias <= near) lit += 1.0;
      else if (texture2D(sunRepeated, uv).r > 0.5) lit += crownLight(at + sunDir * (d - near) * sunRange);
    }
  lit /= 9.0;
  // Turned away from the sun the light leaves it anyway: kept lit, as in the noon bake, so the smaller copies of
  // the picture don't darken the lit pieces of the layout beside it.
  lit = mix(1.0, lit, smoothstep(-0.02, 0.06, nl));
  gl_FragColor = vec4(lit, 1.0, 0.0, 1.0);
}`,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
});

/**
 * A margin of three texels round each piece of the layout, from the covered texels nearest it: a texel read at a
 * piece's edge blends with its neighbours, and they would be lit.
 */
const MARGIN = /* glsl */ `
uniform sampler2D raw;
uniform ivec2 rawSize;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 here = texelFetch(raw, c, 0);
  if (here.g > 0.5) {
    gl_FragColor = vec4(here.r, 0.0, 0.0, 1.0);
    return;
  }
  float sum = 0.0, weight = 0.0;
  for (int y = -3; y <= 3; y++)
    for (int x = -3; x <= 3; x++) {
      vec4 t = texelFetch(raw, clamp(c + ivec2(x, y), ivec2(0), rawSize - 1), 0);
      float w = t.g / float(1 + x * x + y * y);
      sum += t.r * w;
      weight += w;
    }
  gl_FragColor = vec4(weight > 0.0 ? sum / weight : 1.0, 0.0, 0.0, 1.0);
}`;

export class WallDusk implements DuskFollower {
  private pages = new Map<THREE.Texture, Page>();
  private margin: FullScreenQuad | null = null;
  private proxy = new THREE.Mesh(new THREE.BufferGeometry(), SUN);
  private last = performance.now();
  private wantedAt = -Infinity;
  private held = false;
  /** Development: the longest step's processor time (ms) and what it was, the pictures made, whether all are in. */
  readonly stats = { longest: 0, longestWhat: '', steps: 0, made: 0, ready: false };

  constructor() {
    this.proxy.frustumCulled = false;
    this.proxy.matrixAutoUpdate = false;
  }

  /** A light page's uniforms (bakedLight.ts reads them in its materials). */
  uniforms(light: THREE.Texture): DuskPageUniforms {
    return this.page(light).u;
  }

  /** The surfaces a light page lies on, for its dusk picture. */
  add(light: THREE.Texture, meshes: THREE.Mesh[]): void {
    const p = this.page(light);
    p.meshes = [...new Set([...p.meshes, ...meshes])];
    const w = (light.image as { width?: number } | null)?.width ?? 1024;
    p.size = Math.max(128, Math.round(w / 2));
    p.dir.set(0, 0, 0); // made again if it was made without these
  }

  private page(light: THREE.Texture): Page {
    let p = this.pages.get(light);
    if (!p) {
      p = { meshes: [], size: 512, u: { bakeDuskMap: { value: white }, bakeDuskK: { value: 0 } }, done: null, dir: new THREE.Vector3(), fade: 0, job: null };
      this.pages.set(light, p);
    }
    return p;
  }

  step(wanted: boolean, dir: THREE.Vector3, low: number, free: boolean, sources: () => DuskSource[], near: THREE.Vector3 | null): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    for (const p of this.pages.values()) {
      if (p.done && p.fade < 1) p.fade = Math.min(1, p.fade + dt / FADE_S);
      const f = p.fade * p.fade * (3 - 2 * p.fade);
      p.u.bakeDuskK.value = p.done && low > 0 ? low * f : 0;
    }
    if (!wanted) {
      if (now - this.wantedAt < KEEP_MS || !this.held) return;
      for (const p of this.pages.values()) {
        if (p.job) this.drop(p.job);
        p.job = null;
        p.done?.dispose();
        p.done = null;
        p.dir.set(0, 0, 0);
        p.u.bakeDuskMap.value = white;
        p.u.bakeDuskK.value = 0;
      }
      this.held = false;
      this.stats.ready = false;
      return;
    }
    this.wantedAt = now;
    if (!free) return;
    const t0 = performance.now();
    let working: Page | undefined;
    for (const p of this.pages.values()) if (p.job) working = p;
    let what = 'start';
    if (!working) {
      // Not made yet for this sun (a page with nothing in the scene waits); the one nearest the area read first.
      const due = [...this.pages.values()].filter((p) => p.dir.distanceToSquared(dir) > 1e-6 && p.meshes.some(inScene));
      this.stats.ready = due.length === 0;
      if (!due.length) return;
      const src = sources()[0];
      if (!src) return;
      const at = near ?? src.centre;
      const away = (p: Page) => boxOf(p.meshes).distanceToPoint(at);
      due.sort((a, b) => away(a) - away(b));
      working = due[0];
      working.job = this.start(working, dir, src, sources()); // a frame of its own; null: nothing to draw, noon's kept
      this.held = true;
    } else {
      what = working.job!.phase;
      this.work(working, working.job!);
    }
    const ms = performance.now() - t0;
    this.stats.steps++;
    if (ms > this.stats.longest) {
      this.stats.longest = ms;
      this.stats.longestWhat = what;
    }
  }

  private start(p: Page, dir: THREE.Vector3, src: DuskSource, all: DuskSource[]): Job | null {
    p.dir.copy(dir);
    const box = boxOf(p.meshes.filter(inScene));
    if (box.isEmpty()) return null;
    // From the low sun, over the page's buildings and as far towards the sun as anything may shade them.
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 2 * radius + REACH + 1);
    cam.position.copy(centre).addScaledVector(dir, radius + REACH);
    cam.lookAt(centre);
    cam.updateMatrixWorld();
    const lo = new THREE.Vector2(Infinity, Infinity);
    const hi = new THREE.Vector2(-Infinity, -Infinity);
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(cam.matrixWorldInverse);
      lo.min(new THREE.Vector2(v.x, v.y));
      hi.max(new THREE.Vector2(v.x, v.y));
    }
    const w = hi.x - lo.x + 2;
    const h = hi.y - lo.y + 2;
    const texel = Math.max(0.06, w / 4096, h / 4096, Math.sqrt((w * h) / DEPTH_TEXELS));
    const W = Math.ceil(w / texel);
    const H = Math.ceil(h / texel);
    cam.left = lo.x - 1;
    cam.right = lo.x - 1 + W * texel;
    cam.bottom = lo.y - 1;
    cam.top = lo.y - 1 + H * texel;
    cam.updateProjectionMatrix();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const roots = new Set<THREE.Object3D>();
    for (const s of all) for (const r of s.casters) roots.add(r);
    const depth = new THREE.WebGLRenderTarget(W, H, {
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthTexture: new THREE.DepthTexture(W, H, THREE.UnsignedShortType), // 16 bits over a few hundred metres: a centimetre
    });
    const raw = new THREE.WebGLRenderTarget(p.size, p.size, { format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    const out = new THREE.WebGLRenderTarget(p.size, p.size, { format: THREE.RedFormat, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    out.texture.anisotropy = 4;
    return { phase: 'gather', src, pool: null, frustum, unbounded: new Set(), casters: [], roots: [...roots], tris: [], next: 0, chunk: 8, cam, depth, raw, out, row: 0, texel };
  }

  /**
   * What the depth image draws, found over a few frames: whatever the ground's bakes draw (duskShade.ts start) that
   * stands in the image, and the page's own surfaces. First the meshes in one frame, then as many tested against the
   * image's bounds a frame as the budget allows (the first test of a mesh works out its bounds).
   */
  private gather(p: Page, job: Job): void {
    const t0 = performance.now();
    if (!job.pool) {
      const flat = new Set<THREE.Material>();
      for (const name of ['field_soil', 'gravel', 'pave_light', 'pave_grey', 'road', 'rd_concrete', 'rd_asphalt', 'rd_tiles']) flat.add(blockMaterial(name, job.src.renderer).material);
      flat.add(surfaceMaterial('paving', job.src.renderer));
      const pool: THREE.Mesh[] = [];
      for (const root of job.roots)
        root.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const m = o.material as THREE.Material;
          if (Array.isArray(o.material) || m.transparent || m.alphaTest > 0 || o.userData.glassIndex !== undefined || m.userData?.noGroundShade) return;
          if (flat.has(m) || FLAT.test(o.name)) return;
          pool.push(o);
        });
      job.pool = pool;
      job.next = 0;
      return;
    }
    while (job.next < job.pool.length && performance.now() - t0 < BUDGET_MS) {
      const o = job.pool[job.next++];
      // A mesh never drawn yet has no bounds, and working them out for a large one takes many milliseconds: drawn
      // without the test (and without three's own, which would work them out too).
      const known = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).boundingSphere : o.geometry.boundingSphere;
      if (!known) job.unbounded.add(o);
      if (!known || job.frustum.intersectsObject(o)) job.casters.push(o);
    }
    if (job.next < job.pool.length) return;
    const own = new Set(job.casters);
    for (const m of p.meshes) if (inScene(m) && !own.has(m)) job.casters.push(m);
    job.tris = job.casters.map((o) => {
      const g = o.geometry as THREE.BufferGeometry;
      return (((g.index?.count ?? g.attributes.position?.count) || 0) / 3) * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
    });
    job.pool = null;
    job.next = 0;
    job.phase = 'warm';
  }

  private marginPass(): THREE.ShaderMaterial {
    this.margin ??= new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { raw: { value: null }, rawSize: { value: new THREE.Vector2() } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: MARGIN,
      depthTest: false,
      depthWrite: false,
    }));
    return this.margin.material as THREE.ShaderMaterial;
  }

  /** The job's shaders compiled in the background where the browser can (as duskShade.ts compile). */
  private compile(renderer: THREE.WebGLRenderer, p: Page, job: Job): void {
    job.phase = 'compile';
    const kinds = new Map<string, THREE.Mesh>();
    for (const m of job.casters) {
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
      renderer.setRenderTarget(job.raw);
      this.proxy.geometry = p.meshes[0].geometry;
      waits.push(renderer.compileAsync(this.proxy, FLAT_CAM));
      renderer.setRenderTarget(job.out);
      waits.push(renderer.compileAsync(new THREE.Mesh(CORNERS, this.marginPass()), FLAT_CAM));
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
    job.raw.dispose();
    job.out.dispose();
  }

  private work(p: Page, job: Job): void {
    const { renderer } = job.src;
    const before = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.autoClear = false;
    try {
      if (job.phase === 'gather') return this.gather(p, job);
      if (job.phase === 'warm') this.compile(renderer, p, job); // a frame of its own
      if (job.phase === 'warm' || job.phase === 'compile') return;
      if (job.phase === 'depth') this.depthStep(p, job);
      else if (job.phase === 'sun') this.sunStep(p, job);
      else this.marginStep(p, job);
    } finally {
      renderer.setRenderTarget(before);
      renderer.autoClear = autoClear;
      renderer.setClearColor(clearColor, clearAlpha);
    }
  }

  /** The next meshes into the depth image from the sun, everything else hidden meanwhile (as duskShade.ts depthStep). */
  private depthStep(p: Page, job: Job): void {
    const { renderer, scene } = job.src;
    const t0 = performance.now();
    renderer.setRenderTarget(job.depth);
    if (job.next === 0) {
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
    }
    let end = job.next;
    for (let tris = 0; end < job.casters.length && end < job.next + job.chunk && (end === job.next || tris + job.tris[end] <= TRI_BUDGET); end++) tris += job.tris[end];
    const chunk = job.casters.slice(job.next, end);
    const keep = new Map<THREE.Object3D, boolean>();
    const set = (o: THREE.Object3D, v: boolean) => {
      if (!keep.has(o)) keep.set(o, o.visible);
      o.visible = v;
    };
    const background = scene.background;
    const fog = scene.fog;
    const override = scene.overrideMaterial;
    const autoMatrix = scene.matrixWorldAutoUpdate;
    const culled = chunk.filter((m) => job.unbounded.has(m) && m.frustumCulled);
    for (const f of job.src.standIns) f(true);
    try {
      for (const m of culled) m.frustumCulled = false;
      // Only these meshes, in the groups they hang in as they are shown now (as the ground's: what is hidden stays
      // hidden); but the page's own surfaces are drawn even in a model hidden far off.
      const drawn = new Set(chunk);
      for (const o of scene.children) set(o, false);
      for (const root of job.roots) {
        for (let o: THREE.Object3D | null = root; o && o !== scene; o = o.parent) set(o, true);
        root.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) set(o, drawn.has(o as THREE.Mesh));
        });
      }
      for (const m of p.meshes) {
        if (!drawn.has(m)) continue;
        for (let o: THREE.Object3D | null = m; o && o !== scene; o = o.parent) {
          set(o, true);
          for (const c of o.parent?.children ?? []) if ((c as THREE.Mesh).isMesh && !drawn.has(c as THREE.Mesh)) set(c, false);
        }
      }
      scene.background = null;
      scene.fog = null;
      scene.overrideMaterial = REPEATED;
      scene.matrixWorldAutoUpdate = false;
      if (chunk.length) renderer.render(scene, job.cam);
    } finally {
      scene.matrixWorldAutoUpdate = autoMatrix;
      scene.overrideMaterial = override;
      scene.background = background;
      scene.fog = fog;
      for (const [o, v] of keep) o.visible = v;
      for (const m of culled) m.frustumCulled = true;
      for (const f of job.src.standIns) f(false);
    }
    job.next = end;
    const ms = performance.now() - t0;
    job.chunk = Math.max(4, Math.min(160, Math.round(job.chunk * Math.min(1.4, Math.max(0.5, BUDGET_MS / Math.max(ms, 0.05))))));
    if (job.next >= job.casters.length) job.phase = 'sun';
  }

  /** A band of rows of the page: each of its surfaces drawn in its layout, the sun found for each texel. */
  private sunStep(p: Page, job: Job): void {
    const { renderer } = job.src;
    const u = SUN.uniforms;
    const cam = job.cam;
    u.sunDepth.value = job.depth.depthTexture;
    u.sunRepeated.value = job.depth.texture;
    u.sunMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    u.sunDir.value.copy(p.dir);
    u.sunRange.value = cam.far - cam.near;
    // A tap's own depth against the image's: a texel and a half of slope at this slant, and a little more.
    const up = Math.max(0.05, p.dir.y);
    u.sunBias.value = (0.05 + (1.5 * job.texel * Math.sqrt(1 - up * up)) / up / 4) / (cam.far - cam.near);
    u.texelM.value = job.texel;
    crownUniforms(u, job.src.ground);
    const rows = Math.max(16, Math.floor(TEXELS_PER_FRAME / p.size));
    job.raw.scissor.set(0, job.row, p.size, Math.min(rows, p.size - job.row));
    job.raw.scissorTest = true;
    renderer.setRenderTarget(job.raw);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    for (const m of p.meshes) {
      if (!inScene(m) || !(m.geometry as THREE.BufferGeometry).attributes.uv1) continue;
      this.proxy.geometry = m.geometry;
      this.proxy.matrixWorld.copy(m.matrixWorld); // kept: the proxy's own matrix isn't applied (matrixAutoUpdate off)
      renderer.render(this.proxy, FLAT_CAM);
    }
    job.row += rows;
    if (job.row < p.size) return;
    job.raw.scissorTest = false;
    job.depth.depthTexture?.dispose();
    job.depth.dispose();
    job.row = 0;
    job.phase = 'margin';
  }

  /** A band of rows of the margin round the layout's pieces; the last makes the smaller copies, and the picture is in. */
  private marginStep(p: Page, job: Job): void {
    const { renderer } = job.src;
    const u = this.marginPass().uniforms;
    u.raw.value = job.raw.texture;
    u.rawSize.value.set(p.size, p.size);
    const rows = Math.max(16, Math.floor((TEXELS_PER_FRAME * 2) / p.size));
    const last = job.row + rows >= p.size;
    job.out.texture.generateMipmaps = last;
    job.out.scissor.set(0, job.row, p.size, Math.min(rows, p.size - job.row));
    job.out.scissorTest = true;
    renderer.setRenderTarget(job.out);
    this.margin!.render(renderer);
    job.row += rows;
    if (!last) return;
    job.out.scissorTest = false;
    job.raw.dispose();
    p.done?.dispose();
    p.done = job.out;
    p.u.bakeDuskMap.value = job.out.texture;
    p.fade = 0;
    p.job = null;
    this.stats.made++;
  }
}

/** Whether a mesh hangs in a scene (a model not yet placed, or taken out again, doesn't). */
function inScene(m: THREE.Object3D): boolean {
  let o: THREE.Object3D = m;
  while (o.parent) o = o.parent;
  return (o as THREE.Scene).isScene === true;
}

function boxOf(meshes: THREE.Mesh[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  return box;
}

/** The one maker of the walls' dusk pictures, following the ground's (duskShade.ts). */
export const wallDusk = new WallDusk();
duskFollowers.add(wallDusk);
