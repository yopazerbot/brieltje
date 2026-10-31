import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { terrain, terrainTexture } from './terrain';

/**
 * Light on the ground of the whole neighbourhood, worked out once when the sky
 * has loaded and kept in one texture: the sun's shadow of every house, hedge
 * and tree (the real-time sun shadow only covers the house), a soft darkening
 * where walls meet the ground and under trees, and a slow variation in colour
 * that breaks up the repeating grass texture.
 *
 * It renders the static scene twice into depth only (from the sun, and from
 * straight above), combines both into the ground texture in one pass, and
 * throws the depth images away. The grass and the road then read that texture
 * once per pixel: sunlight is dimmed by the shadow, sky light by the
 * darkening. Near the house, where the real-time shadow works, it lets the
 * real-time shadow decide.
 *
 * The village has a texture of its own (bakeVillage), made once its tiles are
 * in. The ground materials read one of the two, the one round where you are
 * (follow): one texture read per pixel, as before the village came. The other
 * area is then far off in the haze.
 */

const HALF = 240; // metres from the centre to the edge of the shaded area
const SIZE = 2048; // texels across the ground texture (about 23 cm each)

const COMBINE = /* glsl */ `
uniform sampler2D sunDepth;
uniform sampler2D topDepth;
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
uniform float texel; // one texel of the depth images
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
void main() {
  vec2 xz = area.xy + (vUv * 2.0 - 1.0) * area.z;
  float base = ground + terrainAt(xz); // the ground here, on the relief
  vec3 p = vec3(xz.x, base + 0.06, xz.y);

  // Sun: is anything between this spot and the sun? Nine taps for a soft edge.
  float d;
  vec2 uv = project(sunMatrix, p, d);
  float lit = 0.0;
  for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
      lit += d - sunBias <= texture2D(sunDepth, uv + vec2(x, y) * texel * 1.5).r ? 1.0 : 0.0;
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

  // Slow variation in colour, in patches of several metres.
  float macro = noise(xz / 23.0) * 0.6 + noise(xz / 7.0) * 0.4;
  gl_FragColor = vec4(lit, ao, macro, 1.0);
}`;

const neutral = new THREE.DataTexture(new Uint8Array([255, 255, 128, 255]), 1, 1);
neutral.needsUpdate = true;

export class GroundShade {
  /** For the ground materials: the texture and where it lies (centre x, centre z, half size). */
  readonly uniforms = {
    groundShade: { value: neutral as THREE.Texture },
    groundArea: { value: new THREE.Vector3() },
  };
  private target: THREE.WebGLRenderTarget | null = null;
  private village: THREE.WebGLRenderTarget | null = null;
  private villageArea = new THREE.Vector3();
  private lastEye = new THREE.Vector3();
  private on = true;
  private inVillage = false;

  constructor(private center: THREE.Vector3) {
    this.uniforms.groundArea.value.set(center.x, center.z, HALF);
  }

  /** Off: plain ground again (for comparing). */
  set enabled(on: boolean) {
    this.on = on;
    this.pick();
  }

  /** Read the texture of the area nearer the eye: the house's or the village's. */
  follow(eye: THREE.Vector3): void {
    this.lastEye.copy(eye);
    const v = this.villageArea;
    const near = !!this.village && Math.hypot(eye.x - v.x, eye.z - v.y) < Math.hypot(eye.x - this.center.x, eye.z - this.center.z);
    if (near !== this.inVillage) {
      this.inVillage = near;
      this.pick();
    }
  }

  private pick(): void {
    const t = this.inVillage ? this.village : this.target;
    this.uniforms.groundShade.value = this.on && t ? t.texture : neutral;
    if (this.inVillage) this.uniforms.groundArea.value.copy(this.villageArea);
    else this.uniforms.groundArea.value.set(this.center.x, this.center.z, HALF);
  }

  /**
   * Make a ground material (grass, road) read the shading. `sheen` scales the sky's
   * reflection: grass seen towards the sun otherwise turns pale like sand.
   */
  apply(material: THREE.MeshStandardMaterial, sheen = 1): void {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec3 groundArea;\nvarying vec2 vGroundUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundUv = ((modelMatrix * vec4(transformed, 1.0)).xz - groundArea.xy) / groundArea.z * 0.5 + 0.5;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D groundShade;\nvarying vec2 vGroundUv;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          vec2 gsEdge = abs(vGroundUv - 0.5);
          vec4 gs = max(gsEdge.x, gsEdge.y) < 0.5 ? texture2D(groundShade, vGroundUv) : vec4(1.0, 1.0, 0.5, 1.0);
          diffuseColor.rgb *= mix(0.86, 1.1, gs.b);`,
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
   * The same for the village: `half` metres round `centre`, `size` texels across (2048, or 1024 on
   * a phone: 5 MB of graphics memory instead of 22).
   */
  bakeVillage(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, casters: THREE.Object3D[], ground: number, centre: THREE.Vector3, half: number, size: number): void {
    this.village?.dispose();
    this.village = this.render(renderer, scene, sun, casters, ground, centre, half, size);
    this.villageArea.set(centre.x, centre.z, half);
    this.inVillage = !this.inVillage; // pick() again whichever area it was
    this.follow(this.lastEye);
  }

  private render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, casters: THREE.Object3D[], ground: number,
    center: THREE.Vector3, half: number, size: number): THREE.WebGLRenderTarget {
    const depth = size; // texels across the two depth images
    const keep = new Map<THREE.Object3D, boolean>();
    const hide = (o: THREE.Object3D, v: boolean) => {
      if (!keep.has(o)) keep.set(o, o.visible); // remember how it was before the first change
      o.visible = v;
    };
    for (const o of scene.children) hide(o, false);
    for (const root of casters) {
      for (let p: THREE.Object3D | null = root; p && p !== scene; p = p.parent) hide(p, true);
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const m = o.material as THREE.Material;
        hide(o, !(m.transparent || m.alphaTest > 0 || o.userData.glassIndex !== undefined));
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
    const sunCam = new THREE.OrthographicCamera(-r, r, r, -r, 1, 1400);
    sunCam.position.copy(center).addScaledVector(dir, 700);
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

    const before = renderer.getRenderTarget();
    for (const [cam, target] of [[sunCam, sunTarget], [topCam, topTarget]] as const) {
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, cam);
    }
    scene.overrideMaterial = null;
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
          sunMatrix: { value: vp(sunCam) },
          topMatrix: { value: vp(topCam) },
          liveMatrix: { value: live },
          area: { value: new THREE.Vector3(center.x, center.z, half) },
          ground: { value: ground },
          sunBias: { value: 0.35 / (sunCam.far - sunCam.near) },
          topRange: { value: new THREE.Vector2(topY - topCam.near, topCam.far - topCam.near) },
          terrainMap: { value: relief },
          terrainArea: { value: new THREE.Vector3(terrain.x0, terrain.z0, terrain.step) },
          terrainSize: { value: new THREE.Vector2(terrain.nx, terrain.nz) },
          texel: { value: 1 / depth },
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
    sunTarget.dispose();
    topTarget.dispose();
    relief.dispose();
    out.texture.anisotropy = 4;
    return out;
  }
}
