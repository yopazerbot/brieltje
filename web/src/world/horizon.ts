import * as THREE from 'three';
import { environment } from './environment';
import { FAR_LAND_GLSL, farLandUniforms } from './farLand';
import { terrain } from './terrain';
// The haze as seen from the air (patched into every material's haze; the ring's shader below uses it too).
import './airHaze';

/**
 * The horizon beyond the data, as flat Flanders shows it: low tree lines one behind the other, a hedgerow,
 * a row of poplars now and then and the odd farm roof among the trees, each line further off paler and
 * lower, all melting into the haze. Drawn once on a small canvas (nothing to download) and laid round a
 * ring 900 m from the eye that moves with it (main.ts), hiding the far edge of the ground from wherever
 * you are.
 *
 * The lines are a few metres high at 900 m (a tree line of about 15 m a kilometre or two off), so they sit
 * low on the horizon instead of standing up as hills. Their colour is mixed with the haze's own colour (the
 * scene's fog, which follows the sky), more towards their foot, so they read as far off whatever the
 * sky; below them the ring is the haze's colour all the way down.
 *
 * Seen from the air the ring rises with the eye, so the tree lines stay on the horizon instead of sinking
 * below it, and stands further out (1.9 km), behind the ground drawn round you. Its haze below the lines is
 * then the land beyond the ground: the far land's farmland (world/farLand.ts) where the line of sight would
 * meet the ground, behind as much haze as the air haze (world/airHaze.ts) puts there, turning towards the
 * lines into the colour of the sky just above the horizon that way. Land and sky meet in one colour instead
 * of at the edge of a pale wall. On the ground (below 8 m) all of this is off: the ring is as it was.
 *
 * One draw call. Its edges are soft (blended, not cut): one layer over a thin strip of the sky, about
 * what the old cut-out band cost.
 */

const W = 2048;
/** Canvas rows: half a metre each at the ring. */
const H = 64;
const RADIUS = 900;
/** Metres: how far out the ring stands from about 150 m up (inside the camera's far plane, 2 km). */
const FAR_OUT = 1900;
/** Metres: the height of the drawn band (the canvas), and of the haze below it. */
const BAND = H / 2;
const FOOT = 600;

function drawLines(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const out = c.getContext('2d')!;
  let s = 4021;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  /** A smooth wobble along the canvas that wraps round seamlessly: `waves` whole waves across. */
  const wave = (x: number, waves: number, phase: number) => Math.sin((x / W) * Math.PI * 2 * waves + phase);
  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const g = scratch.getContext('2d')!;
  /**
   * One layer, drawn solid on a canvas of its own and then laid on at `alpha`: overlapping crowns
   * make one even silhouette instead of darker rings where they overlap.
   */
  const layer = (alpha: number, color: string, paint: () => void) => {
    g.clearRect(0, 0, W, H);
    g.fillStyle = color;
    paint();
    out.globalAlpha = alpha;
    out.drawImage(scratch, 0, 0);
    out.globalAlpha = 1;
  };
  /**
   * One tree line: crowns of about `size` px (half width) packed along it, their tops following a slow
   * envelope (up to `top` px above the hedgerow, in stretches that come and go: open fields between woods),
   * on a hedgerow `foot` px high that runs on through the gaps.
   */
  const line = (color: string, alpha: number, foot: number, top: number, size: number, gaps: number, seed: number) =>
    layer(alpha, color, () => {
      g.fillRect(0, H - foot - 2, W, foot + 2);
      for (let x = 0; x < W; ) {
        // How wooded this stretch is: 0 in an open field, 1 in a wood.
        const wood = 0.5 + 0.35 * wave(x, 5, seed) + 0.25 * wave(x, 13, seed * 2.1) + 0.15 * wave(x, 29, seed * 3.7);
        const r = size * (0.6 + rand() * 0.6);
        if (wood < gaps) {
          x += r * 1.4;
          continue;
        }
        const h = foot + top * Math.min(1, (wood - gaps) * 2.2) * (0.75 + rand() * 0.35);
        // A crown a little wider than tall, on a short stem down to the hedgerow; once more a canvas
        // width to either side, so what spills over one edge comes in at the other and no seam shows.
        for (const at of [x - W, x, x + W]) {
          g.beginPath();
          g.ellipse(at, H - h + r * 0.75, r, r * 0.8, 0, 0, Math.PI * 2);
          g.fill();
          g.fillRect(at - r * 0.7, H - h + r * 0.75, r * 1.4, h - r * 0.75);
        }
        x += r * (0.7 + rand() * 0.5);
      }
    });
  // Furthest: barely above the ground, close to the haze.
  line('#8a9792', 0.55, 1, 5, 5, 0.45, 1.3);
  // A few farm roofs, low among the middle line's trees.
  for (let k = 0; k < 7; k++) {
    layer(0.85, rand() < 0.5 ? '#6f625e' : '#5f6466', () => {
      const x = rand() * (W - 60) + 30;
      const w = 14 + rand() * 18;
      const h = 4 + rand() * 3;
      g.beginPath();
      g.moveTo(x, H - 1);
      g.lineTo(x, H - h);
      g.lineTo(x + w / 2, H - h - w * 0.22);
      g.lineTo(x + w, H - h);
      g.lineTo(x + w, H - 1);
      g.fill();
    });
  }
  // Two or three rows of poplars, slim and taller than the rest.
  layer(0.75, '#6c7b6b', () => {
    for (let k = 0; k < 3; k++) {
      let x = rand() * (W - 120) + 20;
      const n = 6 + Math.floor(rand() * 10);
      for (let i = 0; i < n; i++, x += 5 + rand() * 2) {
        const h = 17 + rand() * 6;
        g.beginPath();
        g.ellipse(x, H - h / 2 - 2, 2.2 + rand() * 0.8, h / 2, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
  line('#6a7a67', 0.85, 2, 9, 7, 0.4, 2.9);
  // Nearest: a little greener, the hedgerows along the fields in front.
  line('#55654d', 1, 3, 12, 9, 0.5, 4.4);
  return c;
}

/** The ring of the horizon (main.ts moves it with the eye across; it follows the eye up itself). */
export function buildHorizon(center: THREE.Vector3, ground: number): THREE.Object3D {
  const map = new THREE.CanvasTexture(drawLines());
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = 4;
  // Six times round: 940 m of horizon for each 2048 px, about half a metre a pixel, as high as wide.
  const repeat = 6;
  // The ring: its band from 0 to BAND (the canvas), and the haze below it down to -FOOT (v below 0).
  const segments = 128;
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const rows: [number, number][] = [[-FOOT, -FOOT / BAND], [0, 0], [BAND, 1]];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    for (const [y, v] of rows) {
      pos.push(Math.sin(a) * RADIUS, y, Math.cos(a) * RADIUS);
      uv.push((i / segments) * repeat, v);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let r = 0; r < rows.length - 1; r++) {
      const a = i * rows.length + r;
      const b = (i + 1) * rows.length + r;
      // Facing in, towards the eye.
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, fog: true });
  const fallback = { value: new THREE.Color('#c9d1d6') };
  // The sky as world/sky.ts shows it now (copied while the ring is drawn; until the sky is loaded its gain is 0: unused).
  const blank = new THREE.Texture();
  const skyNow = {
    hzSky: { value: blank }, hzSky2: { value: blank }, hzTurn: { value: 0 }, hzTurn2: { value: 0 }, hzGain: { value: 0 }, hzGain2: { value: 0 }, hzMix2: { value: 0 },
  };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.horizonHaze = fallback;
    Object.assign(shader.uniforms, skyNow, farLandUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D hzSky;
        uniform sampler2D hzSky2;
        uniform float hzTurn;
        uniform float hzTurn2;
        uniform float hzGain;
        uniform float hzGain2;
        uniform float hzMix2;
        varying vec3 vHzWorld;
        varying float vHzFoot;
        varying vec3 vHzAbove;
        // The sky photo a few degrees above the horizon round azimuth a, as world/sky.ts reads it (no drift: there its
        // clouds stand still), averaged over some 20 degrees: the sky's light that way, not its single clouds.
        vec3 hzPhoto(sampler2D photo, float a) {
          vec3 sum = vec3(0.0);
          for (int i = -2; i <= 2; i++) {
            float u = (a + float(i) * 0.08) * RECIPROCAL_PI2 + 0.5;
            sum += texture2D(photo, vec2(u, 0.5 + 0.012)).rgb + texture2D(photo, vec2(u, 0.5 + 0.025)).rgb;
          }
          return sum * 0.1;
        }`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vHzWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vHzFoot = modelMatrix[3].y;
        // Worked out at the ring's corners (every 2.8 degrees round), smooth in between.
        vHzAbove = vec3(0.0);
        if (hzGain + hzGain2 > 0.0) {
          vec2 hzTo = vHzWorld.xz - cameraPosition.xz;
          float hzA = atan(hzTo.y, hzTo.x);
          vHzAbove = hzPhoto(hzSky, hzA + hzTurn) * hzGain;
          if (hzMix2 > 0.0) vHzAbove = mix(vHzAbove, hzPhoto(hzSky2, hzA + hzTurn2) * hzGain2, hzMix2);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 horizonHaze;
        uniform float hzGain;
        uniform float hzGain2;
        varying vec3 vHzWorld;
        varying float vHzFoot;
        varying vec3 vHzAbove;
        ${FAR_LAND_GLSL}`)
      .replace(
        '#include <map_fragment>',
        `vec4 hzTexel = texture2D(map, vMapUv);
        // Below the band only haze: fully covered, the haze's colour.
        diffuseColor.a = mix(hzTexel.a, 1.0, step(vMapUv.y, 0.0));
        diffuseColor.rgb = hzTexel.rgb;`,
      )
      .replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
        vec3 hzFog = fogColor;
        #ifdef FOG_EXP2
        // From the air the ring stands well out and its haze is the land beyond the drawn ground: where the line of
        // sight through this point would meet the ground, as much of the land's colour as the haze lets through
        // there (world/airHaze.ts), so it runs on from the ground in front without a seam. On the ground none.
        float hzW = airHazeWeight();
        if (hzW > 0.0) {
          vec3 hzRay = vHzWorld - cameraPosition;
          float hzDown = max(-hzRay.y / length(hzRay), 1e-4);
          float hzLand = airHaze((cameraPosition.y - (${ground.toFixed(3)})) / hzDown, fogDensity) * hzW;
          // And towards the tree lines the haze becomes the sky just above the horizon that way (vHzAbove): at the
          // horizon land and sky meet in one colour, not at the edge of a pale wall.
          vec3 hzAbove = vHzAbove;
          float hzGroundY = ${ground.toFixed(3)};
          float hzToSky = smoothstep(0.0, 1.0, (vHzWorld.y - hzGroundY) / max(vHzFoot - hzGroundY, 1.0)) * hzW * step(1e-4, hzGain + hzGain2);
          // The land there: the far land's farmland (world/farLand.ts) where the line of sight meets the ground, lit
          // about as the ground is (the haze's colour stands for the light of the sky).
          vec2 hzAt = cameraPosition.xz + hzRay.xz * (cameraPosition.y - hzGroundY) / max(-hzRay.y, 1e-3);
          hzFog = mix(mix(fogColor, hzAbove, hzToSky), farLandAt(hzAt) * fogColor * 3.2, hzLand);
        }
        #endif
        #else
        vec3 hzFog = horizonHaze;
        #endif
        // Far off: under half the haze at the tops of the trees, all of it at their foot.
        gl_FragColor.rgb = mix(gl_FragColor.rgb, hzFog, mix(1.0, 0.4, smoothstep(0.0, 0.3, vMapUv.y)));`,
      );
  };
  material.customProgramCacheKey = () => 'horizon';
  const mesh = new THREE.Mesh(geometry, material);
  // Its foot below the lowest point of the relief's ground, so no gap shows under it from anywhere.
  let lowest = 0;
  for (let j = 0; j < terrain.nz; j++) for (let i = 0; i < terrain.nx; i++) lowest = Math.min(lowest, terrain.at(i, j));
  const base = ground + lowest - 1;
  mesh.position.set(center.x, base, center.z);
  mesh.renderOrder = -1; // the first of what is blended: behind everything
  mesh.frustumCulled = false;
  mesh.userData.ignoreRay = true;
  mesh.raycast = () => {};
  // Up in the air the ring rises with the eye: from 20 m up the tree lines stay a little over a degree below it, on
  // the horizon, from a jump or a flight. And it stands further out as the eye climbs (1.9 km from 150 m, the same
  // size to the eye), behind the ground drawn round you: its haze below the lines then carries on the land from where
  // the ground ends (see the shader above) instead of standing as a pale wall 900 m out.
  mesh.onBeforeRender = (_r, _s, camera) => {
    const sky = environment.sky?.uniforms;
    if (sky) {
      skyNow.hzSky.value = sky.sky.value;
      skyNow.hzSky2.value = sky.sky2.value;
      skyNow.hzTurn.value = sky.turn.value;
      skyNow.hzTurn2.value = sky.turn2.value;
      skyNow.hzGain.value = sky.gain.value;
      skyNow.hzGain2.value = sky.gain2.value;
      skyNow.hzMix2.value = sky.mix2.value;
    }
    const h = camera.position.y - base;
    const t = Math.min(1, Math.max(0, (h - 20) / 130));
    const scale = 1 + (FAR_OUT / RADIUS - 1) * t * t * (3 - 2 * t);
    const y = camera.position.y - Math.min(h, 20) * scale;
    if (mesh.position.y !== y || mesh.scale.x !== scale) {
      mesh.position.y = y;
      mesh.scale.setScalar(scale);
      mesh.updateMatrixWorld();
    }
  };
  return mesh;
}
