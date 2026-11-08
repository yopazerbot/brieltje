import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Sky } from './sky';
import { warmSkyLight } from './warmShaders';

/**
 * Sky and sunlight from a real photographed sky (Poly Haven HDRI, CC0).
 * The sky image lights every surface softly; the sun itself is a directional
 * light that casts the sharp shadows, placed where the sun is in the photo.
 * The sky is turned so the sun comes from the side we want (house.sun).
 * Distance haze takes the sky's colour at the horizon. The sky seen is
 * drawn by world/sky.ts, where its clouds drift.
 *
 * The other skies of the weather (world/weather.ts: overcast, night) come through `loadSky` when they are first
 * chosen, prepared the same way, and swap in for this one without a shader of the world being compiled again.
 */

/** A photographed sky, ready to light the world and be seen. */
export interface SkyLook {
  /** The photo, equirectangular, for the background (world/sky.ts) */
  photo: THREE.DataTexture;
  /** Its light for every surface (the scene's environment) */
  env: THREE.Texture;
  /** How far it is turned round the vertical (radians, the scene's environment rotation) */
  turn: number;
  /** Where its brightest spot (the sun, the moon) is in the world, after the turn */
  bright: THREE.Vector3;
  /** The colour just above the horizon, all the way round (for the haze) */
  haze: THREE.Color;
  /** How much light it sends onto an upward-facing surface (the cosine-weighted mean of its upper half, luminance) */
  irradiance: number;
}

/** The sunny sky and the background drawn from it, once loaded (world/weather.ts swaps other skies in). */
export const environment: { sunny: SkyLook | null; sky: Sky | null; sunDir: THREE.Vector3 | null } = { sunny: null, sky: null, sunDir: null };

/**
 * Load and prepare a sky photo. `gain` scales its light (the night's photo is far brighter than a night); `width`:
 * a smaller photo is stretched to this many pixels across first, so its light maps come out the same size as the
 * sunny sky's (their size is part of every surface's shader: another size would compile them all again).
 * `wantedDir`: the compass direction its brightest spot is turned to.
 */
export async function loadSky(renderer: THREE.WebGLRenderer, url: string, wantedDir: THREE.Vector3, gain = 1, width = 0): Promise<SkyLook> {
  const loader = new HDRLoader().setDataType(THREE.FloatType);
  const hdr = await loader.loadAsync(url);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const { data, width: w, height: h } = hdr.image as { data: Float32Array; width: number; height: number };
  if (gain !== 1) for (let i = 0; i < data.length; i++) if ((i & 3) !== 3) data[i] *= gain;

  // Find the sun: the brightest pixel of the photo.
  let best = 0;
  let bestIndex = 0;
  for (let i = 0; i < w * h; i++) {
    const lum = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
    if (lum > best) {
      best = lum;
      bestIndex = i;
    }
  }
  const px = bestIndex % w;
  const py = Math.floor(bestIndex / w);
  const lon = ((px + 0.5) / w - 0.5) * Math.PI * 2;
  const lat = (0.5 - (py + 0.5) / h) * Math.PI;
  const photoSun = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));

  // The sky's light maps (and the background) are kept as half-precision floats, which end at
  // 65504. The sun's brightest pixels go past that (73216): an iPhone's graphics chip turns them
  // into infinity, and blurring the maps spreads it into every reflection, so every surface came
  // out black while the sky looked fine. Capped a little under; the sunlight itself comes from
  // the directional light.
  for (let i = 0; i < data.length; i++) if (data[i] > 60000) data[i] = 60000;

  // Turn the sky around the vertical axis so its sun sits at the wanted compass direction.
  const turn = Math.atan2(photoSun.z, photoSun.x) - Math.atan2(wantedDir.z, wantedDir.x);
  const bright = photoSun.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), turn).normalize();

  // Haze: far things fade into the colour of the sky just above the horizon (averaged all
  // the way round), so the ground's far edge and the distant houses melt into the sky.
  const haze = new THREE.Color(0, 0, 0);
  let n = 0;
  for (let y = Math.floor(h * 0.47); y < Math.floor(h * 0.495); y++) {
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      haze.r += data[i];
      haze.g += data[i + 1];
      haze.b += data[i + 2];
      n++;
    }
  }
  haze.multiplyScalar(1 / Math.max(1, n));
  // The light onto the ground: each row of the upper half by its height's cosine and its share of the sphere.
  let irr = 0;
  let weight = 0;
  for (let y = 0; y < h / 2; y++) {
    const a = (0.5 - (y + 0.5) / h) * Math.PI;
    const k = Math.sin(a) * Math.cos(a);
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      irr += (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) * k;
      weight += k;
    }
  }

  // The light maps are made from the photo stretched to the sunny sky's size (see above); the background keeps the
  // small photo, which is all the graphics memory it takes.
  const source = width && w < width ? stretch(hdr, width) : hdr;
  for (const t of new Set([hdr, source])) {
    // Older iPads (A12/A13 chips) can't filter 32-bit float textures smoothly, and WebGL then reads
    // the sky as black: the background and, through the light maps, every shaded surface with it.
    // Half floats filter everywhere, and after the cap above every value fits in one.
    if (!renderer.extensions.has('OES_texture_float_linear')) toHalf(t);
    // Turned, the photo's left and right edges meet somewhere in view (world/sky.ts): they must join, set before its first use.
    t.wrapS = THREE.RepeatWrapping;
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(source).texture;
  pmrem.dispose();
  if (source !== hdr) source.dispose();
  return { photo: hdr, env, turn, bright, haze, irradiance: irr / Math.max(1e-6, weight) };
}

/** A float photo as half floats, in place. */
function toHalf(t: THREE.DataTexture): void {
  const data = (t.image as { data: Float32Array }).data;
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  (t.image as { data: ArrayBufferView }).data = half;
  t.type = THREE.HalfFloatType;
}

/** A photo stretched to `width` pixels across (and half that high), each pixel read between its four neighbours. */
function stretch(hdr: THREE.DataTexture, width: number): THREE.DataTexture {
  const { data, width: w, height: h } = hdr.image as { data: Float32Array; width: number; height: number };
  const W = width;
  const H = width / 2;
  const out = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = ((x + 0.5) * w) / W - 0.5;
      const x0 = (Math.floor(sx) + w) % w; // round the sphere: the left and right edges meet
      const x1 = (x0 + 1) % w;
      const fx = sx - Math.floor(sx);
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = data[(y0 * w + x0) * 4 + c] * (1 - fx) + data[(y0 * w + x1) * 4 + c] * fx;
        const b = data[(y1 * w + x0) * 4 + c] * (1 - fx) + data[(y1 * w + x1) * 4 + c] * fx;
        out[o + c] = a * (1 - fy) + b * fy;
      }
      out[o + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = hdr.mapping;
  t.colorSpace = hdr.colorSpace;
  t.minFilter = hdr.minFilter;
  t.magFilter = hdr.magFilter;
  t.generateMipmaps = hdr.generateMipmaps;
  t.flipY = hdr.flipY;
  t.needsUpdate = true;
  return t;
}

/** The sunny sky, at the start: the background, the light, the sun's direction and the haze. */
export async function loadEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  sun: THREE.DirectionalLight,
  wantedSunDir: THREE.Vector3,
): Promise<void> {
  // The light maps' shaders compile while the photo (2048 pixels across) downloads (world/warmShaders.ts).
  const warmed = warmSkyLight(renderer, 2048);
  const look = await loadSky(renderer, '/env/sky_2k.hdr', wantedSunDir).finally(warmed);
  scene.environmentRotation.set(0, look.turn, 0);
  const sunDir = look.bright;

  const sky = new Sky(look.photo, look.turn, sunDir);
  scene.add(sky.mesh);
  scene.environment = look.env;
  environment.sunny = look;
  environment.sky = sky;
  environment.sunDir = sunDir.clone();

  sun.position.copy(sun.target.position).addScaledVector(sunDir, 60);
  sun.userData.direction = sunDir;
  scene.fog = new THREE.FogExp2(look.haze.clone(), 0.0019);
}
