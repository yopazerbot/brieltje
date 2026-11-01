import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { terrain, terrainTexture } from './terrain';
import { blockMaterial } from './houseMeshes';
import type { GrassData } from './houseData';

/**
 * Light on the ground of the whole neighbourhood, worked out once when the sky
 * has loaded and kept in one texture: the sun's shadow of every house, hedge
 * and tree (the real-time sun shadow only covers the house), a soft darkening
 * where walls meet the ground and under trees, and a slow variation in colour
 * that breaks up the repeating grass texture.
 *
 * It renders the static scene into depth only (from the sun, and from straight
 * above, once with everything and once with only what stands on the ground), and
 * the surfaces the grass reacts to into a cover image, combines them into the
 * ground texture in one pass, and throws the rest away. The grass and the road
 * then read that texture once per pixel: sunlight is dimmed by the shadow, sky
 * light by the darkening. Near the house, where the real-time shadow works, it
 * lets the real-time shadow decide.
 *
 * Where walls, hedges, fences and sheds meet the ground a darker band lies round
 * their foot (contact shadow), wider the taller they are, so they stand on the
 * ground instead of on a hard line. It dims the sky light by up to four fifths and
 * the sunlight by up to half: real sunlight isn't dimmed there, but the eye reads
 * the band as weight, and on light paving in the sun a weaker band doesn't show.
 *
 * The fourth channel tells the grass what kind it is (see `apply`): the gardens
 * that are mown in stripes (their stripes are drawn in), the meadows (tools/crops.py),
 * and rough grass and weeds along the fields' edges, ditches, ponds and field
 * tracks, worked out from the cover image, with a ragged edge.
 *
 * The village has a texture of its own (bakeVillage), made once its tiles are
 * in, and so has Molenhoek's far stretch. The ground materials read one of them,
 * the one round where you are (follow): one texture read per pixel, as before the
 * village came. Beyond it they read a coarse one of the whole map (bakeAll), so the
 * fields between the areas and the rest of the map seen from the air have it too.
 */

const HALF = 240; // metres from the centre to the edge of the shaded area
const SIZE = 2048; // texels across the ground texture (about 23 cm each)

const COMBINE = /* glsl */ `
uniform sampler2D sunDepth;
uniform sampler2D topDepth;
uniform sampler2D solidDepth; // from above too, only what stands on the ground (no crowns, trunks or posts)
uniform sampler2D cover; // r fields, g tracks and paths, b water, a gardens' stripes (0.5 to 1) and meadows (0.2, 0.35)
uniform mat4 sunMatrix;
uniform mat4 topMatrix;
uniform mat4 liveMatrix;
uniform vec3 area; // centre x, centre z, half size
uniform float ground;
uniform float sunBias;
uniform vec2 topRange; // camera height, depth range
uniform sampler2D terrainMap; // the relief's heights (m)
uniform vec3 terrainArea; // its first point x, z, and the step
uniform vec2 terrainSize; // its number of points along x and z
uniform float sunTap; // metres between the sun's taps
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
vec2 project(mat4 m, vec3 p, out float depth) {
  vec4 q = m * vec4(p, 1.0);
  depth = q.z * 0.5 + 0.5;
  return q.xy * 0.5 + 0.5;
}
float terrainAt(vec2 xz) {
  return texture2D(terrainMap, ((xz - terrainArea.xy) / terrainArea.z + 0.5) / terrainSize).r;
}
float heightAt(vec2 xz) {
  float d;
  vec2 uv = project(topMatrix, vec3(xz.x, 0.0, xz.y), d);
  return topRange.x - texture2D(topDepth, uv).r * topRange.y;
}
/** The cover image here (drawn from above like the heights, so it lies the other way up from vUv). */
vec4 coverAt(vec2 xz) {
  float d;
  return texture2D(cover, project(topMatrix, vec3(xz.x, 0.0, xz.y), d));
}
/** How high what stands on the ground stands above it here. */
float solidAt(vec2 xz) {
  float d;
  vec2 uv = project(topMatrix, vec3(xz.x, 0.0, xz.y), d);
  return topRange.x - texture2D(solidDepth, uv).r * topRange.y - ground - terrainAt(xz);
}
void main() {
  vec2 xz = area.xy + (vUv * 2.0 - 1.0) * area.z;
  float base = ground + terrainAt(xz); // the ground here, on the relief
  vec3 p = vec3(xz.x, base + 0.06, xz.y);

  // Sun: is anything between this spot and the sun? Nine taps for a soft edge, each a spot of the ground of
  // its own round this one (a tap beside it in the sun's image would see the ground covers, the fields and
  // the pavers, standing higher or lower on a slope, and shade them in a fine hatch).
  float d;
  float lit = 0.0;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++) {
      vec2 tap = xz + vec2(x, y) * sunTap;
      vec2 uv = project(sunMatrix, vec3(tap.x, ground + terrainAt(tap) + 0.06, tap.y), d);
      lit += d - sunBias <= texture2D(sunDepth, uv).r ? 1.0 : 0.0;
    }
  lit /= 9.0;
  // Where the real-time shadow reaches, leave it to that one (it also sees people and furniture).
  float ld;
  vec2 live = abs(project(liveMatrix, p, ld) * 2.0 - 1.0);
  float edge = smoothstep(0.85, 0.98, max(live.x, live.y));
  lit = mix(1.0, lit, edge);

  // Sky light: how much of the surroundings stands up around this spot (walls, hedges, crowns).
  float occ = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.785398;
    vec2 dir = vec2(cos(a), sin(a));
    for (int r = 1; r <= 3; r++) {
      float dist = float(r * r) * 0.5;
      vec2 q = xz + dir * dist;
      float h = heightAt(q) - ground - terrainAt(q);
      occ += clamp(h / (dist * 2.5), 0.0, 1.0) / float(r);
    }
  }
  float above = heightAt(xz) - base; // under a crown or an overhang
  float ao = 1.0 - 0.5 * clamp(occ / 14.0, 0.0, 1.0) - (above > 1.5 ? 0.25 : 0.0);

  // Contact: in each of 16 directions out to 2 m the nearest wall, hedge, fence or shed, weighed by how close it is
  // against a reach that grows with its height (80 cm for a low fence, 2.3 m for a house wall). Half the
  // directions blocked, as along a straight wall, is the full band; a corner is no darker than that.
  float contact = 1.0; // under the eaves (or inside, where no one sees the ground)
  if (solidAt(xz) < 0.25) {
    float sum = 0.0;
    for (int k = 0; k < 16; k++) {
      float a = float(k) * 0.392699 + 0.1;
      vec2 dir = vec2(cos(a), sin(a));
      float best = 0.0;
      for (int r = 0; r < 7; r++) {
        float dist = 0.1 + float(r) * 0.2 + float(r * r) * 0.02; // 0.1 to 2 m, close enough not to step over a hedge
        float h = solidAt(xz + dir * dist);
        float reach = 0.5 + 0.6 * clamp(h, 0.0, 3.0);
        best = max(best, clamp((h - 0.15) / 0.9, 0.0, 1.0) * max(1.0 - dist / reach, 0.0));
      }
      sum += best;
    }
    contact = clamp(sum / 16.0 * 2.4, 0.0, 1.0);
  }

  // The grass: how near the fields, field tracks and water are, in 12 directions out to 2.5 m.
  vec4 here = coverAt(xz);
  float nearField = 0.0, nearTrack = 0.0, nearWater = 0.0, nearOpen = 0.0;
  for (int k = 0; k < 12; k++) {
    float a = float(k) * 0.523599 + 0.26;
    vec2 dir = vec2(cos(a), sin(a));
    for (int r = 1; r <= 5; r++) {
      float dist = float(r) * 0.5;
      vec4 c = coverAt(xz + dir * dist);
      nearField = max(nearField, c.r * (1.0 - dist / 2.9));
      nearTrack = max(nearTrack, c.g * (1.0 - dist / 1.3));
      nearWater = max(nearWater, c.b * (1.0 - dist / 2.9));
      nearOpen = max(nearOpen, (1.0 - c.r) * (1.0 - dist / 1.6));
    }
  }
  // Rough: on a field, weeds at its edge; on the grass, the unmown margins of fields, the banks of ditches
  // and ponds, the strip down a field track. Ragged, in clumps of a metre or so.
  float ragged = noise(xz / 2.3) * 0.5 + noise(xz / 0.9) * 0.5;
  float wild = here.r > 0.5 ? nearOpen * 0.9 : max(max(nearField, nearWater), nearTrack * 0.85);
  wild = smoothstep(0.2, 0.75, wild + (ragged - 0.5) * 0.75);
  float lawn = step(0.45, here.a); // a garden mown in stripes: mown up to its edge
  float meadow = here.a > 0.05 && here.a < 0.45 ? here.a * 2.0 * (0.7 + 0.6 * noise(xz / 9.0)) * (1.0 - here.r) : 0.0;
  wild = max(wild * (1.0 - lawn), meadow);
  float grass = wild > 0.004 ? 0.5 - 0.5 * wild : 0.5 + lawn * (here.a - 0.5);

  // Slow variation in colour, in patches of several metres.
  float macro = noise(xz / 23.0) * 0.6 + noise(xz / 7.0) * 0.4;
  gl_FragColor = vec4(lit * (1.0 - 0.5 * contact), ao * (1.0 - 0.8 * contact), macro, grass);
}`;

/** Draws a surface into the cover image in one of its channels, added to what is there. */
function coverMaterial(rgb: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `void main() { gl_FragColor = vec4(${rgb}, 0.0); }`,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** The gardens' stripes and the meadows into the cover image's fourth channel (a 1: a garden, its stripes worked out here). */
const grassCover = new THREE.ShaderMaterial({
  vertexShader: `attribute vec4 grass;
    varying vec4 vGrass;
    varying vec2 vXZ;
    void main() {
      vGrass = grass;
      vXZ = position.xz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `varying vec4 vGrass;
    varying vec2 vXZ;
    void main() {
      float a = vGrass.w;
      if (a > 0.9) a = 0.5 + 0.5 * smoothstep(-0.35, 0.35, sin(dot(vXZ, vec2(-vGrass.y, vGrass.x)) / vGrass.z * 3.14159));
      gl_FragColor = vec4(0.0, 0.0, 0.0, a);
    }`,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

const neutral = new THREE.DataTexture(new Uint8Array([255, 255, 128, 128]), 1, 1);
neutral.needsUpdate = true;

/**
 * The grass's detail: 2 all of it, 1 the stripes and the rough grass without the second read of the texture
 * (phones), 0 none (for comparing).
 */
export const grassDetail = { value: matchMedia('(pointer: coarse)').matches ? 1 : 2 };

export class GroundShade {
  /**
   * For the ground materials: the texture and where it lies (centre x, centre z, half size), and the coarse
   * one of the whole map (bakeAll) for the ground beyond it.
   */
  readonly uniforms = {
    groundShade: { value: neutral as THREE.Texture },
    groundArea: { value: new THREE.Vector3() },
    groundShadeAll: { value: neutral as THREE.Texture },
    groundAreaAll: { value: new THREE.Vector3(1e7, 1e7, 1) },
  };
  /** The grass's detail, to turn down or off (see grassDetail) */
  readonly grassDetail = grassDetail;
  private target: THREE.WebGLRenderTarget | null = null;
  private all: THREE.WebGLRenderTarget | null = null;
  /** The areas baked once the village is in (the village, Molenhoek's far stretch): texture, centre x, z and half size */
  private areas: { key: string; target: THREE.WebGLRenderTarget; area: THREE.Vector3 }[] = [];
  private lastEye = new THREE.Vector3();
  private on = true;
  /** Which area is read: -1 the house's, else one of `areas` */
  private reading = -1;
  /** The gardens and meadows known so far, as one flat mesh for the cover image */
  private grass = { pos: [] as number[], attr: [] as number[] };

  constructor(private center: THREE.Vector3) {
    this.uniforms.groundArea.value.set(center.x, center.z, HALF);
  }

  /** Off: plain ground again (for comparing). */
  set enabled(on: boolean) {
    this.on = on;
    this.pick();
  }

  /** Read the texture of the area whose middle is nearest the eye: the house's, the village's or the far stretch's. */
  follow(eye: THREE.Vector3): void {
    this.lastEye.copy(eye);
    let best = -1;
    let bestD = Math.hypot(eye.x - this.center.x, eye.z - this.center.z);
    this.areas.forEach(({ area }, i) => {
      const d = Math.hypot(eye.x - area.x, eye.z - area.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best !== this.reading) {
      this.reading = best;
      this.pick();
    }
  }

  private pick(): void {
    const a = this.reading >= 0 ? this.areas[this.reading] : null;
    const t = a ? a.target : this.target;
    this.uniforms.groundShade.value = this.on && t ? t.texture : neutral;
    this.uniforms.groundShadeAll.value = this.on && this.all ? this.all.texture : neutral;
    if (a) this.uniforms.groundArea.value.copy(a.area);
    else this.uniforms.groundArea.value.set(this.center.x, this.center.z, HALF);
  }

  /** Gardens and meadows for the bakes to come (the ring's at the start, the village's with it). */
  addGrass(data?: GrassData): void {
    if (!data) return;
    const put = (rings: [number, number][][], g: [number, number, number, number]) => {
      const contour = rings[0].map(([x, z]) => new THREE.Vector2(x, z));
      const holes = rings.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
      const all = [...contour, ...holes.flat()];
      for (const face of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        for (const k of face) {
          this.grass.pos.push(all[k].x, 0, all[k].y);
          this.grass.attr.push(...g);
        }
      }
    };
    for (const l of data.lawns) {
      const a = (l.a * Math.PI) / 180;
      put(l.p, [Math.cos(a), Math.sin(a), l.w, 1]);
    }
    for (const m of data.meadows) put(m.p, [0, 0, 1, m.k === 'fallow' ? 0.35 : 0.2]);
  }

  /**
   * Make a ground material (grass, road) read the shading. `sheen` scales the sky's
   * reflection: grass seen towards the sun otherwise turns pale like sand. `grass`: the
   * lawn itself, which also draws its kind (the texture's fourth channel): mown stripes in
   * the gardens, rough grass along fields, ditches and tracks, the meadows a little rougher.
   */
  apply(material: THREE.MeshStandardMaterial, sheen = 1, grass = false): void {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.uniforms.grassDetail = grassDetail;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec3 groundArea;\nuniform vec3 groundAreaAll;\nvarying vec2 vGroundUv;\nvarying vec2 vGroundUvAll;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec2 gsXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
          vGroundUv = (gsXZ - groundArea.xy) / groundArea.z * 0.5 + 0.5;
          vGroundUvAll = (gsXZ - groundAreaAll.xy) / groundAreaAll.z * 0.5 + 0.5;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D groundShade;\nuniform sampler2D groundShadeAll;\nuniform float grassDetail;\nvarying vec2 vGroundUv;\nvarying vec2 vGroundUvAll;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          // The fine texture round where you are, handing over to the whole map's near its edge.
          vec2 gsEdge = abs(vGroundUv - 0.5);
          float gsFine = smoothstep(0.5, 0.46, max(gsEdge.x, gsEdge.y));
          vec4 gs = vec4(1.0, 1.0, 0.5, 0.5);
          if (gsFine < 1.0) {
            vec2 gsAll = abs(vGroundUvAll - 0.5);
            if (max(gsAll.x, gsAll.y) < 0.5) gs = texture2D(groundShadeAll, vGroundUvAll);
          }
          if (gsFine > 0.0) gs = mix(gs, texture2D(groundShade, vGroundUv), gsFine);
          diffuseColor.rgb *= mix(0.86, 1.1, gs.b);
          ${grass ? GRASS : ''}`,
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= gs.r;
          reflectedLight.directSpecular *= gs.r;
          reflectedLight.indirectDiffuse *= gs.g;
          reflectedLight.indirectSpecular *= gs.g * ${sheen.toFixed(2)};`,
        );
    };
    if (grass) material.customProgramCacheKey = () => 'groundShade|grass';
    material.needsUpdate = true;
  }

  /**
   * Work it out round the house: `casters` are the groups whose meshes throw shadows (glass and
   * cut-out fences don't); everything else in the scene is hidden meanwhile.
   */
  bake(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, casters: THREE.Object3D[], ground: number): void {
    this.target?.dispose();
    this.target = this.render(renderer, scene, sun, casters, ground, this.center, HALF, SIZE);
    this.pick();
  }

  /**
   * The same for the village, or another area (`key`; baked again, it replaces the one of that key): `half`
   * metres round `centre`, `size` texels across (2048, or 1024 on a phone: 5 MB of graphics memory instead of 22).
   */
  bakeVillage(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, casters: THREE.Object3D[], ground: number, centre: THREE.Vector3, half: number, size: number,
    key = 'village'): void {
    const old = this.areas.findIndex((a) => a.key === key);
    if (old >= 0) this.areas.splice(old, 1)[0].target.dispose();
    this.areas.push({ key, target: this.render(renderer, scene, sun, casters, ground, centre, half, size), area: new THREE.Vector3(centre.x, centre.z, half) });
    this.reading = -2; // pick() again whichever area it was
    this.follow(this.lastEye);
  }

  /**
   * The whole map once more, coarse (a metre a texel, two on a phone), for the ground beyond the fine areas:
   * the fields between the ring round the house and the village, from the air the rest of the map.
   */
  bakeAll(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, casters: THREE.Object3D[], ground: number, size: number): void {
    const x1 = terrain.x0 + (terrain.nx - 1) * terrain.step;
    const z1 = terrain.z0 + (terrain.nz - 1) * terrain.step;
    const centre = new THREE.Vector3((terrain.x0 + x1) / 2, 0, (terrain.z0 + z1) / 2);
    centre.y = ground + terrain.height(centre.x, centre.z);
    const half = Math.max(x1 - terrain.x0, z1 - terrain.z0) / 2 + 8;
    this.all?.dispose();
    this.all = this.render(renderer, scene, sun, casters, ground, centre, half, size);
    this.uniforms.groundAreaAll.value.set(centre.x, centre.z, half);
    this.pick();
  }

  private render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, casters: THREE.Object3D[], ground: number,
    center: THREE.Vector3, half: number, size: number): THREE.WebGLRenderTarget {
    const depth = size; // texels across the depth images
    const keep = new Map<THREE.Object3D, boolean>();
    const hide = (o: THREE.Object3D, v: boolean) => {
      if (!keep.has(o)) keep.set(o, o.visible); // remember how it was before the first change
      o.visible = v;
    };
    for (const o of scene.children) hide(o, false);
    const shown: THREE.Mesh[] = [];
    for (const root of casters) {
      for (let p: THREE.Object3D | null = root; p && p !== scene; p = p.parent) hide(p, true);
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const m = o.material as THREE.Material;
        const solid = !(m.transparent || m.alphaTest > 0 || o.userData.glassIndex !== undefined);
        hide(o, solid);
        if (solid) shown.push(o);
      });
    }
    const background = scene.background;
    const fog = scene.fog;
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = new THREE.MeshDepthMaterial();
    const depthTarget = () => new THREE.WebGLRenderTarget(depth, depth, { depthTexture: new THREE.DepthTexture(depth, depth, THREE.FloatType) });

    // From the sun, far enough out to see the whole area at a slant.
    const dir = (sun.userData.direction as THREE.Vector3 | undefined) ?? sun.position.clone().sub(sun.target.position).normalize();
    const r = half * 1.5;
    const away = Math.max(700, half * 1.6); // the whole map is wider than the sun camera's usual reach
    const sunCam = new THREE.OrthographicCamera(-r, r, r, -r, 1, away * 2);
    sunCam.position.copy(center).addScaledVector(dir, away);
    sunCam.lookAt(center);
    sunCam.updateMatrixWorld();
    const sunTarget = depthTarget();
    // From straight above, for the heights (60 m over the area's own ground, a church tower too).
    const topY = center.y + 60;
    const topCam = new THREE.OrthographicCamera(-half, half, half, -half, 0.5, 80);
    topCam.position.set(center.x, topY, center.z);
    topCam.up.set(0, 0, -1);
    topCam.lookAt(center.x, center.y, center.z);
    topCam.updateMatrixWorld();
    const topTarget = depthTarget();
    const solidTarget = depthTarget();

    const before = renderer.getRenderTarget();
    for (const [cam, target] of [[sunCam, sunTarget], [topCam, topTarget]] as const) {
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, cam);
    }
    // Only what stands on the ground, for the contact shadow: the repeated shapes (tree crowns and trunks,
    // the hedges' leafy lumps, fence posts, lamps) are left out, so a crown doesn't darken a ring round its edge.
    const repeated = shown.filter((o) => o instanceof THREE.InstancedMesh);
    for (const o of repeated) o.visible = false;
    renderer.setRenderTarget(solidTarget);
    renderer.clear();
    renderer.render(scene, topCam);
    for (const o of repeated) o.visible = true;
    scene.overrideMaterial = null;

    // The cover image: the fields, the field tracks and paths, and the water, each in a channel of its own,
    // and the gardens and meadows in the fourth.
    const cover = new THREE.WebGLRenderTarget(size, size, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    const fields = blockMaterial('field_soil', renderer).material;
    const tracks = blockMaterial('gravel', renderer).material;
    const asCover = new Map<THREE.Material, THREE.ShaderMaterial>([[fields, coverMaterial('1.0, 0.0, 0.0')], [tracks, coverMaterial('0.0, 1.0, 0.0')]]);
    const waterCover = coverMaterial('0.0, 0.0, 1.0');
    // Nothing else is drawn: whatever shares a group with the casters (the furniture in the house's) is hidden too.
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const casting = new Set(shown);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite)) return;
      // The ponds' and ditches' water (world/surroundings.ts, waterMesh) lies in the scene itself.
      const as = mesh.isMesh && casting.has(mesh) ? asCover.get(mesh.material as THREE.Material) : mesh.isMesh && o.name.endsWith(' water') ? waterCover : undefined;
      if (!as) return hide(o, false);
      for (let p: THREE.Object3D | null = o; p && p !== scene; p = p.parent) hide(p, true);
      swapped.push([mesh, mesh.material]);
      mesh.material = as;
    });
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(cover);
    renderer.clear();
    renderer.autoClear = false;
    renderer.render(scene, topCam);
    let lawns: THREE.Mesh | null = null;
    if (this.grass.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.grass.pos, 3));
      g.setAttribute('grass', new THREE.Float32BufferAttribute(this.grass.attr, 4));
      lawns = new THREE.Mesh(g, grassCover);
      lawns.position.y = center.y;
      lawns.frustumCulled = false;
      renderer.render(lawns, topCam);
    }
    renderer.autoClear = autoClear;
    renderer.setClearColor(clearColor, clearAlpha);
    for (const [o, m] of swapped) o.material = m;
    for (const m of [...asCover.values(), waterCover]) m.dispose();
    lawns?.geometry.dispose();
    scene.background = background;
    scene.fog = fog;
    for (const [o, v] of keep) o.visible = v;

    // The real-time shadow's reach, to hand over to it near the house.
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    const live = new THREE.Matrix4().multiplyMatrices(sun.shadow.camera.projectionMatrix, sun.shadow.camera.matrixWorldInverse);
    const vp = (c: THREE.Camera) => new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);

    const out = new THREE.WebGLRenderTarget(size, size, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    const relief = terrainTexture();
    const quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          sunDepth: { value: sunTarget.depthTexture },
          topDepth: { value: topTarget.depthTexture },
          solidDepth: { value: solidTarget.depthTexture },
          cover: { value: cover.texture },
          sunMatrix: { value: vp(sunCam) },
          topMatrix: { value: vp(topCam) },
          liveMatrix: { value: live },
          area: { value: new THREE.Vector3(center.x, center.z, half) },
          ground: { value: ground },
          sunBias: { value: Math.max(0.35, (2.5 * r) / depth) / (sunCam.far - sunCam.near) }, // more where a texel is wide (the whole map's)
          topRange: { value: new THREE.Vector2(topY - topCam.near, topCam.far - topCam.near) },
          terrainMap: { value: relief },
          terrainArea: { value: new THREE.Vector3(terrain.x0, terrain.z0, terrain.step) },
          terrainSize: { value: new THREE.Vector2(terrain.nx, terrain.nz) },
          sunTap: { value: (1.5 * 2 * r) / depth }, // a texel and a half of the sun's image, as before
        },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: COMBINE,
      }),
    );
    renderer.setRenderTarget(out);
    quad.render(renderer);
    renderer.setRenderTarget(before);
    quad.dispose();
    (quad.material as THREE.Material).dispose();
    for (const t of [sunTarget, topTarget, solidTarget, cover]) t.dispose();
    relief.dispose();
    out.texture.anisotropy = 4;
    return out;
  }
}

/**
 * The lawn's own part (after the texture and the slow variation): its kind from the shading's fourth
 * channel, 0.5 plain grass, above it a garden's mown stripe, below it rough grass. The same texture once
 * more at 3.4 times the size breaks up its repeats and gives the rough grass its tussocks (not on phones).
 */
const GRASS = /* glsl */ `
#ifdef USE_MAP
if (grassDetail > 0.0) {
  float gsWild = clamp(1.0 - gs.a * 2.0, 0.0, 1.0);
  float gsStripe = clamp(gs.a * 2.0 - 1.0, 0.0, 1.0);
  float gsClump = 1.0;
  float gsFar = smoothstep(50.0, 80.0, length(vViewPosition)); // further off the texture's own repeats are lost anyway
  if (grassDetail > 1.5 && gsFar < 1.0) {
    vec3 gsBig = texture2D(map, vMapUv * 0.29 + vec2(0.37, 0.61)).rgb;
    gsClump = mix(clamp(dot(gsBig, vec3(0.299, 0.587, 0.114)) / 0.136, 0.45, 1.8), 1.0, gsFar); // around 1 (the texture's mean)
  }
  diffuseColor.rgb *= mix(1.0, gsClump, 0.35 + 0.4 * gsWild);
  // Patches a little yellower or greener, with the slow variation.
  diffuseColor.rgb *= mix(vec3(1.06, 1.0, 0.78), vec3(0.95, 1.02, 1.1), gs.b);
  // Rough grass: drier and paler on the tussocks, dark between them.
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * mix(vec3(0.62, 0.6, 0.45), vec3(1.22, 1.12, 0.72), smoothstep(0.7, 1.3, gsClump)), gsWild);
  // A mown stripe: the blades laid the other way catch more light.
  diffuseColor.rgb *= vec3(1.0 + 0.15 * gsStripe, 1.0 + 0.13 * gsStripe, 1.0 + 0.08 * gsStripe);
}
#endif`;
