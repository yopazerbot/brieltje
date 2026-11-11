import * as THREE from 'three';
import { mood } from './mood';
import { terrain } from './terrain';
import { wind } from './wind';
import { reflectionSkips } from './reflections';
import type { GroundShadeUniforms } from './undergrowth';

/**
 * Blades of grass round where you are (Yoshi, 11 Nov 2026: "do it all", the grass first on the list): the lawns,
 * verges and meadows were a flat green carpet. Now tufts of real blades stand on the grass within a few tens of
 * metres of the eye, short on a mown lawn, taller in rough grass (the ground shading's fourth channel says which,
 * world/groundShade.ts), swaying a little in the wind, lit and shaded as the ground at their foot, sinking away as snow comes to lie.
 *
 * Only on Medium and up, never on phones. One draw call of real geometry: nothing cut out, nothing blended, so no
 * pixel is shaded twice for nothing. The tufts are the same few thousand copies everywhere: each has a place in a
 * square of TILE metres and is drawn at the copy of that square nearest the eye (worked out in the vertex shader),
 * so the grass stands still as you walk and nothing is gathered on the CPU.
 *
 * Where grass is: nothing in the data says it in one place (the lawn is the whole relief, with the roads, yards,
 * floors, fields and models laid over it). So the ground round the eye is drawn from above into two small images,
 * again after every few metres walked: the relief's height, and whether anything of the fixed world (not the
 * grass) lies within half a metre over it: a road, paving, a floor, a field, a hedge's foot, water. A tuft reads
 * both at its foot: it stands on the relief and shrinks to nothing where the ground is covered.
 */

/** Metres: the square the tufts' places repeat over (more than twice the furthest reach). */
const TILE = 72;
/** Tufts in that square at most (about twelve to the square metre on Ultra; thinned with distance). */
const COUNT = 62000;
const BLADES = 7;
/** Metres the eye may move before the images are drawn again; they reach this much further than the tufts. */
const STEP = 7;
const SIZE = 512;
const LAYER_GRASS = 29;
const LAYER_COVER = 30;

/** A tuft: blades leaning out from one foot, each a tapered strip of three triangles, darker at the foot. */
function tuft(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + rnd() * 0.7;
    const [dx, dz] = [Math.cos(a), Math.sin(a)];
    const [sx, sz] = [-dz, dx]; // across the blade
    const off = 0.012 + 0.035 * rnd();
    const lean = 0.25 + 0.5 * rnd();
    const h = 0.7 + 0.3 * rnd();
    const w = 0.011 + 0.006 * rnd();
    const at = (t: number, side: number, wide: number): [number, number, number] => {
      const out = off + lean * h * t * t * 0.55;
      return [dx * out + sx * side * wide, h * t, dz * out + sz * side * wide];
    };
    const base = pos.length / 3;
    const rows: [number, number, number][] = [[0, -1, w], [0, 1, w], [0.55, -1, w * 0.7], [0.55, 1, w * 0.7], [1, 0, 0]];
    for (const [t, side, wide] of rows) {
      pos.push(...at(t, side, wide));
      const c = 0.8 + 0.75 * t;
      col.push(c, c, c);
    }
    idx.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export class GrassTufts {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private heights = new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: true });
  private cover = new THREE.WebGLRenderTarget(SIZE, SIZE, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: false });
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 600);
  /** The images' centre x, z and half size; the height their heights are counted from. */
  private area = { value: new THREE.Vector3(0, 0, 1) };
  private base = { value: 0 };
  private reach = { value: 0 };
  private snow = { value: 0 };
  private drawnAt = new THREE.Vector3(Infinity, 0, 0);
  private drawnWhen = 0;
  private heightPass: THREE.ShaderMaterial;
  private coverPass: THREE.ShaderMaterial;

  /**
   * `shade`: the ground's baked light (world/groundShade.ts); `grass`: the lawn's material; `fixed`: the roots of
   * the world that stands still (the house, the tiles): what of them lies on the ground keeps the tufts off.
   */
  constructor(shade: GroundShadeUniforms, private grass: THREE.Material, private fixed: () => THREE.Object3D[]) {
    const g = new THREE.InstancedBufferGeometry();
    const one = tuft();
    g.setAttribute('position', one.getAttribute('position'));
    g.setAttribute('color', one.getAttribute('color'));
    g.setIndex(one.getIndex());
    const place = new Float32Array(COUNT * 4);
    const make = new Float32Array(COUNT * 4);
    let seed = 99;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < COUNT; i++) {
      place.set([rnd() * TILE, rnd() * TILE, rnd() * Math.PI * 2, rnd()], i * 4);
      make.set([0.7 + 0.6 * rnd(), rnd(), rnd(), rnd()], i * 4);
    }
    g.setAttribute('gtPlace', new THREE.InstancedBufferAttribute(place, 4));
    g.setAttribute('gtMake', new THREE.InstancedBufferAttribute(make, 4));
    g.instanceCount = COUNT;
    this.mesh = new THREE.Mesh(g, this.material(shade));
    this.mesh.frustumCulled = false; // placed round the eye in the vertex shader
    this.mesh.userData.ignoreRay = true;
    this.mesh.userData.noAO = true;
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
    this.group.add(this.mesh);
    reflectionSkips.objects.add(this.group);

    // The two passes from above. Where a point lands in the image is worked out here, not by the camera (which
    // only says what is in view): x and z over the area.
    const head = /* glsl */ `
      uniform vec3 gtArea;
      uniform float gtBase;
      varying float vY;
      void main() {
        vec4 w = vec4(position, 1.0);
        #ifdef USE_INSTANCING
        w = instanceMatrix * w;
        #endif
        w = modelMatrix * w;
        vY = w.y - gtBase;
        gl_Position = vec4((w.xz - gtArea.xy) / gtArea.z, clamp(0.5 - vY / 400.0, 0.0, 1.0), 1.0);
      }`;
    this.heightPass = new THREE.ShaderMaterial({
      uniforms: { gtArea: this.area, gtBase: this.base },
      vertexShader: head,
      fragmentShader: 'varying float vY;\nvoid main() { gl_FragColor = vec4(vY, 0.0, 0.0, 1.0); }',
      side: THREE.DoubleSide,
    });
    this.coverPass = new THREE.ShaderMaterial({
      uniforms: { gtArea: this.area, gtBase: this.base, gtHeights: { value: this.heights.texture } },
      vertexShader: head,
      fragmentShader: /* glsl */ `
        uniform sampler2D gtHeights;
        varying float vY;
        void main() {
          float over = vY - texture2D(gtHeights, gl_FragCoord.xy / ${SIZE}.0).r;
          if (over > 0.5 || over < -0.5) discard;
          gl_FragColor = vec4(1.0);
        }`,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.camera.up.set(0, 0, -1);
  }

  private material(shade: GroundShadeUniforms): THREE.MeshStandardMaterial {
    // The lawn's own colour (its texture's mean times its tint), so the blades and the ground are one.
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.086, 0.104, 0.021), vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        gtArea: this.area, gtBase: this.base, gtReach: this.reach, gtSnow: this.snow,
        gtHeights: { value: this.heights.texture }, gtCover: { value: this.cover.texture },
        windTime: wind.time, windStrength: wind.strength,
        ugShade: shade.groundShade, ugShadeAll: shade.groundShadeAll, ugArea: shade.groundArea, ugAreaAll: shade.groundAreaAll,
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 gtPlace;
          attribute vec4 gtMake;
          uniform vec3 gtArea;
          uniform float gtBase;
          uniform float gtReach;
          uniform float gtSnow;
          uniform sampler2D gtHeights;
          uniform sampler2D gtCover;
          uniform float windTime;
          uniform float windStrength;
          uniform sampler2D ugShade;
          uniform sampler2D ugShadeAll;
          uniform vec3 ugArea;
          uniform vec3 ugAreaAll;
          varying vec2 vGtLight;
          varying vec3 vGtTint;`,
        )
        // Lit as the ground is: every blade's normal straight up.
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace(
          '#include <begin_vertex>',
          `// The tuft's foot: its place in the square, at the copy of the square nearest the eye.
          vec2 gtRoot = gtPlace.xy + ${TILE}.0 * floor((cameraPosition.xz - gtPlace.xy) / ${TILE}.0 + 0.5);
          float gtFar = distance(gtRoot, cameraPosition.xz);
          vec2 gtUv = (gtRoot - gtArea.xy) / gtArea.z * 0.5 + 0.5;
          vec4 gtGround = textureLod(gtHeights, gtUv, 0.0);
          float gtY = gtGround.r;
          float gtCovered = textureLod(gtCover, gtUv, 0.0).r;
          // The ground's light and the grass's kind at the foot (world/groundShade.ts).
          vec2 uvFine = (gtRoot - ugArea.xy) / ugArea.z * 0.5 + 0.5;
          vec2 uvAll = (gtRoot - ugAreaAll.xy) / ugAreaAll.z * 0.5 + 0.5;
          vec2 edgeFine = abs(uvFine - 0.5);
          float fine = smoothstep(0.5, 0.46, max(edgeFine.x, edgeFine.y));
          vec4 gs = vec4(1.0, 1.0, 0.5, 0.5);
          vec2 edgeAll = abs(uvAll - 0.5);
          if (fine < 1.0 && max(edgeAll.x, edgeAll.y) < 0.5) gs = textureLod(ugShadeAll, uvAll, 0.0);
          if (fine > 0.0) gs = mix(gs, textureLod(ugShade, uvFine, 0.0), fine);
          vGtLight = gs.rg;
          float gtWild = clamp(1.0 - gs.a * 2.0, 0.0, 1.0);
          float gtMown = clamp(gs.a * 2.0 - 1.0, 0.0, 1.0);
          // How tall: a mown lawn a few centimetres, plain grass a hand, rough grass to the shin.
          float gtTall = mix(mix(0.12, 0.075, gtMown), 0.26, gtWild) * gtMake.x * (1.0 - smoothstep(0.05, 0.45, gtSnow));
          // Shown: on grass, inside the images, within reach (fewer further off, growing in at the edge).
          float gtShow = (1.0 - smoothstep(0.04, 0.4, gtCovered)) * step(0.9, gtGround.a)
            * step(max(abs(gtUv.x - 0.5), abs(gtUv.y - 0.5)), 0.49)
            * smoothstep(gtReach, gtReach * 0.75, gtFar)
            * step(gtPlace.w, mix(1.0, 0.3, smoothstep(gtReach * 0.25, gtReach * 0.9, gtFar)));
          // Fewer, wider tufts further off cover as much.
          float gtWide = mix(1.0, 1.8, smoothstep(gtReach * 0.25, gtReach * 0.9, gtFar)) * mix(1.2, 1.3, gtWild);
          float gtC = cos(gtPlace.z), gtS = sin(gtPlace.z);
          vec3 transformed = vec3(position.x * gtC - position.z * gtS, position.y, position.x * gtS + position.z * gtC);
          transformed *= vec3(gtWide, gtTall, gtWide) * gtShow;
          // The wind: the tips lean with it, each tuft in its own time.
          float gtSway = sin(windTime * 2.1 + gtRoot.x * 0.9 + gtRoot.y * 0.7) * 0.5 + sin(windTime * 3.7 + gtRoot.x * 2.3) * 0.25;
          transformed.xz += vec2(-0.998, 0.057) * gtSway * 0.35 * transformed.y * position.y * windStrength;
          transformed += vec3(gtRoot.x, gtY + gtBase, gtRoot.y);
          // Its colour: yellower or greener with the ground's slow variation, drier in rough grass, each its own.
          vGtTint = mix(vec3(1.06, 1.0, 0.78), vec3(0.95, 1.02, 1.1), gs.b) * mix(vec3(1.0), vec3(1.25, 1.12, 0.7), gtWild * gtMake.y)
            * (0.85 + 0.3 * gtMake.z) * (1.0 + 0.14 * gtMown);
`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGtLight;\nvarying vec3 vGtTint;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGtTint;')
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif')
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          reflectedLight.directDiffuse *= vGtLight.x;
          reflectedLight.indirectDiffuse *= vGtLight.y;`,
        );
    };
    m.customProgramCacheKey = () => 'grassTufts';
    return m;
  }

  /** The graphics preset: Medium and up, not on phones; further on the higher presets. */
  setQuality(quality: string, phone: boolean): void {
    const on = !phone && quality !== 'low';
    this.reach.value = quality === 'medium' ? 20 : quality === 'high' ? 27 : 32;
    // The places are scattered evenly: the first so many of them are a thinner lawn.
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = quality === 'medium' ? 26000 : quality === 'high' ? 46000 : COUNT;
    this.mesh.visible = on;
    this.drawnAt.set(Infinity, 0, 0);
  }

  /** Each frame: the images drawn again once the eye has moved on (or every few seconds: a door, a car gone). */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, eye: THREE.Vector3, now: number): void {
    if (!this.mesh.visible) return;
    this.snow.value = mood.snow;
    if (Math.hypot(eye.x - this.drawnAt.x, eye.z - this.drawnAt.z) < STEP && now - this.drawnWhen < 15) return;
    this.drawnAt.copy(eye);
    this.drawnWhen = now;
    const half = this.reach.value + STEP + 3;
    // On whole texels, so the images don't shift under the tufts from one drawing to the next.
    const texel = (2 * half) / SIZE;
    const cx = Math.round(eye.x / texel) * texel;
    const cz = Math.round(eye.z / texel) * texel;
    this.area.value.set(cx, cz, half);
    this.base.value = terrain.height(cx, cz);
    this.camera.left = this.camera.bottom = -half;
    this.camera.right = this.camera.top = half;
    this.camera.position.set(cx, this.base.value + 300, cz);
    this.camera.lookAt(cx, this.base.value, cz);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    // Which meshes each pass draws: by layer (a mesh keeps its own layers too).
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.material === this.grass) mesh.layers.enable(LAYER_GRASS);
      else if (o.name.endsWith(' water')) mesh.layers.enable(LAYER_COVER);
    });
    for (const root of this.fixed()) {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.material !== this.grass) mesh.layers.enable(LAYER_COVER);
      });
    }
    const target = renderer.getRenderTarget();
    const color = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    const shadows = renderer.shadowMap.autoUpdate;
    const background = scene.background;
    const override = scene.overrideMaterial;
    const shown = this.mesh.visible;
    this.mesh.visible = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    scene.background = null;
    // The relief's height (its alpha says where there is any).
    scene.overrideMaterial = this.heightPass;
    this.camera.layers.set(LAYER_GRASS);
    renderer.setRenderTarget(this.heights);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.autoClear = false;
    renderer.render(scene, this.camera);
    // What lies on it.
    scene.overrideMaterial = this.coverPass;
    this.camera.layers.set(LAYER_COVER);
    renderer.setRenderTarget(this.cover);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.overrideMaterial = override;
    scene.background = background;
    renderer.shadowMap.autoUpdate = shadows;
    renderer.autoClear = autoClear;
    renderer.setClearColor(color, alpha);
    renderer.setRenderTarget(target);
    this.mesh.visible = shown;
  }
}
