import * as THREE from 'three';
import { mood } from './mood';
import { terrain } from './terrain';
import { wind } from './wind';
import { reflectionSkips } from './reflections';
import type { GroundShadeUniforms } from './undergrowth';
import FC from '../../shared/football.json';

/**
 * Blades of grass round where you are (Yoshi, 11 Nov 2026: "do it all", the grass first on the list): the lawns,
 * verges and meadows were a flat green carpet. Now thin single blades stand on the grass round the eye, as tall as
 * the place they grow in (Yoshi, 14 Nov 2026: "take into account the actual context in which the grass surface
 * exists"; the ground shading's fourth channel says which kind, world/groundShade.ts): a garden mown in stripes 4 cm,
 * other gardens and verges 5.5, a little longer along paving, pasture short with taller clumps, rough grass along
 * fields, ditches and tracks to the shin; shorter and sparser under trees. None on the football pitch: its turf is
 * 3 cm and lies in the ground's own paint and stripes. They sway a little in the wind, are lit and coloured as the
 * ground at their foot (darker at the foot, so they grow out of it), and sink away as snow comes to lie.
 *
 * Only on Medium and up, never on phones. Two draw calls of real geometry: nothing cut out, nothing blended, so no
 * pixel is shaded twice for nothing. A dense near layer of small patches (40 blades) within about ten metres, a
 * sparser far one (16 blades) out to 20 to 32 metres that thins and widens with distance and fades out softly. The
 * patches are the same few thousand copies everywhere: each has a place in a square of tile metres and is drawn at
 * the copy of that square nearest the eye (worked out in the vertex shader), so the grass stands still as you walk
 * and nothing is gathered on the CPU. In the dev build `?oldgrass` shows the tufts as they were before.
 *
 * Where grass is: nothing in the data says it in one place (the lawn is the whole relief, with the roads, yards,
 * floors, fields and models laid over it). So the ground round the eye is drawn from above into two small images,
 * again after every few metres walked: the relief's height, and whether anything of the fixed world (not the
 * grass) lies within half a metre over it: a road, paving, a floor, a field, a hedge's foot, water. A tuft reads
 * both at its foot: it stands on the relief and shrinks to nothing where the ground is covered.
 *
 * Fallen leaves lie the same way (it is November): yellow, orange and brown, flat on whatever is there (the grass,
 * a road, a pavement: the second image also keeps how high the cover lies), where the sky is half hidden in the
 * ground's baked shade: under the crowns and along walls and hedges, where leaves gather. Not where it is fully
 * hidden (indoors, under a roof).
 */

/** In the dev build, `?oldgrass` shows the grass as it was before 14 Nov 2026, to compare (one star-shaped tuft mesh). */
const OLD = import.meta.env.DEV && new URLSearchParams(location.search).has('oldgrass');
/** Metres: the square the far patches' and the leaves' places repeat over (more than twice the furthest reach). */
const TILE = 72;
/** Metres: the square the near patches' places repeat over (more than twice their reach). */
const NEAR_TILE = 22;
/** Patches in their square at most (Ultra): the far ones, then the near ones; thinned with distance. */
const FAR_COUNT = 26000;
const NEAR_COUNT = 12000;
/** The old grass (?oldgrass): tufts in the square at most, and the blades of one tuft. */
const COUNT = 62000;
const BLADES = 7;
/** Fallen leaves in that square at most (shown only where leaves gather). */
const LEAVES = 40000;
/** Metres the eye may move before the images are drawn again; they reach this much further than the tufts. */
const STEP = 7;
const SIZE = 512;
const LAYER_GRASS = 29;
const LAYER_COVER = 30;

/**
 * A patch of grass: `blades` single blades, their feet on a jittered grid over a square of `side` metres round 0.
 * Each is a thin tapered blade of two triangles (3 to 8 mm wide at the foot), facing its own way and leaning a
 * little its own way, curved: the lean grows with the square of the height. Its height and lean are a unit blade's,
 * scaled in the vertex shader; its width is in metres (gtBlade.zw), widened there with distance. gtBlade.xy is the
 * blade's foot in the patch: each blade reads the ground at its own foot.
 */
function patch(blades: number, side: number, seed: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const across: number[] = [];
  const idx: number[] = [];
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cols = Math.round(Math.sqrt(blades));
  const rows = Math.ceil(blades / cols);
  const cells = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  for (let b = 0; b < blades; b++) {
    const cell = cells[b];
    const fx = (((cell % cols) + rnd()) / cols - 0.5) * side;
    const fz = ((Math.floor(cell / cols) + rnd()) / rows - 0.5) * side;
    const face = rnd() * Math.PI * 2;
    const [sx, sz] = [Math.cos(face), Math.sin(face)];
    const tilt = rnd() * Math.PI * 2;
    const [dx, dz] = [Math.cos(tilt), Math.sin(tilt)];
    const lean = 0.1 + 0.35 * rnd();
    const h = 0.6 + 0.4 * rnd();
    const w = 0.0025 + 0.0015 * rnd();
    const base = pos.length / 3;
    const verts: [number, number, number][] = [[0, 0, -w], [0, 0, w], [0.36, 0.6, 0.5 * w], [1, 1, 0]];
    for (const [out, up, wide] of verts) {
      pos.push(dx * lean * h * out, h * up, dz * lean * h * out);
      across.push(fx, fz, sx * wide, sz * wide);
      const c = up === 0 ? 0.72 : up < 1 ? 1.0 : 1.22;
      col.push(c, c, c);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('gtBlade', new THREE.Float32BufferAttribute(across, 4));
  g.setIndex(idx);
  return g;
}

/** The old grass (?oldgrass) — a tuft: blades leaning out from one foot, each a tapered strip of three triangles. */
function oldTuft(): THREE.BufferGeometry {
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

/** A fallen leaf: a pointed oval lying flat, a little cupped, paler along its midrib. */
function leaf(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0, 0.06, -0.3, 0.5, 0, 0, 0, 0.06, 0.3, 0, 0.02, 0], 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute([0.8, 0.8, 0.8, 0.95, 0.95, 0.95, 0.8, 0.8, 0.8, 0.95, 0.95, 0.95, 1.15, 1.15, 1.15], 3));
  g.setIndex([0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0]);
  return g;
}

export class GrassTufts {
  readonly group = new THREE.Group();
  /** The far patches (or the old tufts under ?oldgrass), and the near patches (none under ?oldgrass). */
  private mesh: THREE.Mesh;
  private near: THREE.Mesh | null = null;
  private leaves: THREE.Mesh;
  private heights = new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: true });
  private cover = new THREE.WebGLRenderTarget(SIZE, SIZE, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: true });
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 600);
  /** The images' centre x, z and half size; the height their heights are counted from. */
  private area = { value: new THREE.Vector3(0, 0, 1) };
  private base = { value: 0 };
  private reach = { value: 0 };
  private nearReach = { value: 0 };
  private tile = { value: TILE };
  private nearTile = { value: NEAR_TILE };
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
const scattered = (one: THREE.BufferGeometry, count: number, kind: 'tuft' | 'leaf', seed: number, tile = this.tile, reach = this.reach): THREE.Mesh => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', one.getAttribute('position'));
      g.setAttribute('color', one.getAttribute('color'));
      if (one.getAttribute('gtBlade')) g.setAttribute('gtBlade', one.getAttribute('gtBlade'));
      g.setIndex(one.getIndex());
      const place = new Float32Array(count * 4);
      const make = new Float32Array(count * 4);
      const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
      for (let i = 0; i < count; i++) {
        place.set([rnd() * tile.value, rnd() * tile.value, rnd() * Math.PI * 2, rnd()], i * 4);
        make.set([0.7 + 0.6 * rnd(), rnd(), rnd(), rnd()], i * 4);
      }
      g.setAttribute('gtPlace', new THREE.InstancedBufferAttribute(place, 4));
      g.setAttribute('gtMake', new THREE.InstancedBufferAttribute(make, 4));
      g.instanceCount = count;
      const mesh = new THREE.Mesh(g, this.material(shade, kind, tile, reach));
      mesh.frustumCulled = false; // placed round the eye in the vertex shader
      mesh.userData.ignoreRay = true;
      mesh.userData.noAO = true;
      mesh.raycast = () => {};
      mesh.visible = false;
      this.group.add(mesh);
      return mesh;
    };
    if (OLD) this.mesh = scattered(oldTuft(), COUNT, 'tuft', 99);
    else {
      this.mesh = scattered(patch(16, 0.7, 7), FAR_COUNT, 'tuft', 99);
      this.near = scattered(patch(40, 0.5, 31), NEAR_COUNT, 'tuft', 577, this.nearTile, this.nearReach);
    }
    this.leaves = scattered(leaf(), LEAVES, 'leaf', 4242);
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
          // Covered, and how high over the relief (the highest of what lies there is kept: the depth test).
          gl_FragColor = vec4(1.0, over + 0.5, 0.0, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    this.camera.up.set(0, 0, -1);
  }

  private material(shade: GroundShadeUniforms, kind: 'tuft' | 'leaf', tile: { value: number }, reach: { value: number }): THREE.MeshStandardMaterial {
    const tufts = kind === 'tuft';
    const blades = tufts && !OLD;
    const { centre, u, w, rail } = FC;
    // The lawn's own colour (its texture's mean times its tint), so the blades and the ground are one. Measured on
    // screen (14 Nov 2026), thin blades of that colour came out at about half the ground's brightness round them
    // (the ground's lighter patches and tussocks, GRASS in world/groundShade.ts, and the shading of the dense blades
    // by the ambient occlusion), so the blades take 2.2 times it.
    const lawn = new THREE.Color(0.086, 0.104, 0.021).multiplyScalar(blades ? 2.2 : 1);
    const m = new THREE.MeshStandardMaterial({ color: tufts ? lawn : new THREE.Color(1, 1, 1), vertexColors: true, roughness: 1, side: THREE.DoubleSide });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        gtArea: this.area, gtBase: this.base, gtReach: reach, gtTile: tile, gtSnow: this.snow,
        gtPitch: { value: new THREE.Vector2(centre[0], centre[1]) }, gtPitchU: { value: new THREE.Vector2(u[0], u[1]) },
        gtPitchW: { value: new THREE.Vector2(w[0], w[1]) }, gtRail: { value: new THREE.Vector4(rail.u0, rail.u1, rail.w0, rail.w1) },
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
          uniform float gtTile;
          uniform float gtSnow;
          uniform vec2 gtPitch;
          uniform vec2 gtPitchU;
          uniform vec2 gtPitchW;
          uniform vec4 gtRail;
          ${blades ? 'attribute vec4 gtBlade;' : ''}
          vec2 gtTurn(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(v.x * c - v.y * s, v.x * s + v.y * c); }
          float gtHash(vec2 p) { p = mod(p, 256.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float gtNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(gtHash(i), gtHash(i + vec2(1.0, 0.0)), f.x), mix(gtHash(i + vec2(0.0, 1.0)), gtHash(i + 1.0), f.x), f.y);
          }
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
          `// The tuft's foot: its place in the square, at the copy of the square nearest the eye (a blade: its own
          // foot in the patch, so each blade stands on the relief and stops at the paving by itself).
          vec2 gtRoot = gtPlace.xy + gtTile * floor((cameraPosition.xz - gtPlace.xy) / gtTile + 0.5);
${blades ? '          gtRoot += gtTurn(gtBlade.xy, gtPlace.z);\n' : ''}
          float gtFar = distance(gtRoot, cameraPosition.xz);
          vec2 gtUv = (gtRoot - gtArea.xy) / gtArea.z * 0.5 + 0.5;
          vec4 gtGround = textureLod(gtHeights, gtUv, 0.0);
          float gtY = gtGround.r;
          vec4 gtOver = textureLod(gtCover, gtUv, 0.0);
          float gtCovered = gtOver.r;
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
${blades ? `          float gtWild = clamp(1.0 - gs.a * 2.0, 0.0, 1.0);
          float gtMown = smoothstep(0.52, 0.6, gs.a); // a garden mown in stripes (0.6 to 1), not plain grass (0.5)
          float gtStripe = clamp((gs.a - 0.6) * 2.5, 0.0, 1.0);
          float gtSky = smoothstep(0.25, 0.6, gs.g);
          // How tall: a mown lawn 4 cm, plain grass 5.5, the edge along paving and pasture 7 to 9 (tussocks 12 to 14),
          // rough grass 18 to 30 (tussocks to 48), in clumps of a metre or two; shorter and thinner under trees;
          // sinking into snow.
          float gtShort = mix(0.055, 0.04, gtMown);
          float gtClump = smoothstep(0.55, 0.75, gtNoise(gtRoot / 1.3));
          float gtTall = (gtShort + (0.30 - gtShort) * gtWild * gtWild * gtWild) * mix(1.0, mix(0.7, 1.6, gtClump), smoothstep(0.12, 0.5, gtWild))
            * (0.85 + 0.3 * gtMake.w) * mix(0.75, 1.0, gtSky) * (1.0 - smoothstep(0.05, 0.45, gtSnow));
          // The football pitch: its turf is in the ground (world/footballGround.ts), no blades inside the rail.
          vec2 gtQ = vec2(dot(gtRoot - gtPitch, gtPitchU), dot(gtRoot - gtPitch, gtPitchW));
          float gtInPitch = min(min(gtQ.x - gtRail.x, gtRail.y - gtQ.x), min(gtQ.y - gtRail.z, gtRail.w - gtQ.y));
          // Shown: on grass, inside the images, within reach (fewer further off, growing in at the edge), not on the
          // pitch. Up to the edge of what covers the ground: the blades hang over a paving's edge.
          float gtShow = (1.0 - smoothstep(0.3, 0.75, gtCovered)) * step(0.9, gtGround.a)
            * step(max(abs(gtUv.x - 0.5), abs(gtUv.y - 0.5)), 0.49)
            * smoothstep(gtReach, gtReach * 0.6, gtFar)
            * step(gtPlace.w, mix(1.0, 0.3, smoothstep(gtReach * 0.25, gtReach * 0.9, gtFar)))
            * step(fract(gtPlace.w * 7.31), mix(0.6, 1.0, gtSky))
            * (1.0 - smoothstep(-0.25, 0.25, gtInPitch));
          // Wider further off: a blade a pixel wide or less flickers, and fewer of them have to cover as much.
          float gtWide = min(1.0 + gtFar / 8.0, 4.5);
          vec3 transformed = vec3(0.0, position.y * gtTall, 0.0);
          transformed.xz = gtTurn(position.xz, gtPlace.z) * gtTall + gtTurn(gtBlade.zw, gtPlace.z) * gtWide;
          transformed *= gtShow;
          // The wind: the tips lean with it, each blade in its own time.
          float gtSway = sin(windTime * 2.1 + gtRoot.x * 0.9 + gtRoot.y * 0.7) * 0.5 + sin(windTime * 3.7 + gtRoot.x * 2.3) * 0.25;
          transformed.xz += vec2(-0.998, 0.057) * gtSway * 0.35 * transformed.y * position.y * windStrength;
          transformed += vec3(gtRoot.x, gtY + gtBase, gtRoot.y);
          // Its colour: the ground's own, yellower or greener with the ground's slow variation, drier in rough grass,
          // each patch a little its own, lighter on a garden's light stripe as the ground is.
          vGtTint = mix(vec3(1.06, 1.0, 0.78), vec3(0.95, 1.02, 1.1), gs.b) * mix(vec3(1.0), vec3(1.25, 1.12, 0.7), gtWild * gtMake.y)
            * (0.92 + 0.16 * gtMake.z) * mix(vec3(1.0), vec3(1.15, 1.13, 1.08), gtStripe);
` : tufts ? `          float gtWild = clamp(1.0 - gs.a * 2.0, 0.0, 1.0);
          float gtMown = clamp(gs.a * 2.0 - 1.0, 0.0, 1.0);
          // How tall: a mown lawn a few centimetres, plain grass a hand, rough grass to the shin.
          float gtTall = mix(mix(0.12, 0.075, gtMown), 0.26, gtWild) * gtMake.x * (1.0 - smoothstep(0.05, 0.45, gtSnow));
          // Shown: on grass, inside the images, within reach (fewer further off, growing in at the edge).
          // Up to the edge of what covers the ground and a hand over it: the blades hang over a paving's edge, so no
          // lawn ends on a ruled line.
          float gtShow = (1.0 - smoothstep(0.3, 0.75, gtCovered)) * step(0.9, gtGround.a)
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
` : `          float gtInside = step(0.9, gtGround.a) * step(max(abs(gtUv.x - 0.5), abs(gtUv.y - 0.5)), 0.49);
          // Where leaves gather: the sky half hidden (under a crown, along a wall or a hedge), not fully (indoors).
          float gtGather = smoothstep(0.9, 0.5, gs.g) * smoothstep(0.1, 0.28, gs.g);
          float gtShow = gtInside * step(gtPlace.w, gtGather * 0.95) * smoothstep(gtReach, gtReach * 0.75, gtFar) * (1.0 - smoothstep(0.05, 0.3, gtSnow));
          float gtSize = (0.05 + 0.04 * gtMake.x) * gtShow;
          float gtC = cos(gtPlace.z), gtS = sin(gtPlace.z);
          vec3 transformed = vec3(position.x * gtC - position.z * gtS, position.y, position.x * gtS + position.z * gtC) * gtSize;
          // Flat on what is there, a little tipped, each a hair higher than the last so they don't fight.
          transformed.y += transformed.x * (gtMake.z - 0.5) * 0.5;
          float gtOn = gtCovered > 0.5 ? max(gtOver.g - 0.5, 0.0) : 0.0;
          transformed += vec3(gtRoot.x, gtY + gtBase + gtOn + 0.012 + 0.01 * gtMake.w, gtRoot.y);
          // Yellow, orange or brown.
          vGtTint = gtMake.y < 0.35 ? vec3(0.5, 0.34, 0.03) : gtMake.y < 0.65 ? vec3(0.42, 0.16, 0.025) : vec3(0.16, 0.085, 0.03);
          vGtTint *= 0.8 + 0.4 * gtMake.z;`}`,
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
    m.customProgramCacheKey = () => `grassTufts|${kind}|${OLD}`;
    return m;
  }

  /** The graphics preset: Medium and up, not on phones; further on the higher presets. */
  setQuality(quality: string, phone: boolean): void {
    const on = !phone && quality !== 'low';
    const pick = (medium: number, high: number, ultra: number) => (quality === 'medium' ? medium : quality === 'high' ? high : ultra);
    this.reach.value = pick(20, 27, 32);
    this.nearReach.value = pick(7, 9, 10);
    // The places are scattered evenly: the first so many of them are a thinner lawn.
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = OLD ? pick(26000, 46000, COUNT) : pick(12000, 18000, FAR_COUNT);
    if (this.near) (this.near.geometry as THREE.InstancedBufferGeometry).instanceCount = pick(5000, 9000, NEAR_COUNT);
    this.mesh.visible = on;
    if (this.near) this.near.visible = on;
    this.leaves.visible = on;
    (this.leaves.geometry as THREE.InstancedBufferGeometry).instanceCount = quality === 'medium' ? 20000 : LEAVES;
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
    this.mesh.visible = this.leaves.visible = false;
    if (this.near) this.near.visible = false;
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
    this.mesh.visible = this.leaves.visible = shown;
    if (this.near) this.near.visible = shown;
  }
}
