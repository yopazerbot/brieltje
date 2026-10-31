import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/**
 * Sky and sunlight from a real photographed sky (Poly Haven HDRI, CC0).
 * The sky image lights every surface softly; the sun itself is a directional
 * light that casts the sharp shadows, placed where the sun is in the photo.
 * The sky is turned so the sun comes from the side we want (house.sun).
 * Distance haze takes the sky's colour at the horizon.
 */
export async function loadEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  sun: THREE.DirectionalLight,
  wantedSunDir: THREE.Vector3,
): Promise<void> {
  const loader = new HDRLoader().setDataType(THREE.FloatType);
  const hdr = await loader.loadAsync('/env/sky_2k.hdr');
  hdr.mapping = THREE.EquirectangularReflectionMapping;

  // Find the sun: the brightest pixel of the photo.
  const { data, width, height } = hdr.image as { data: Float32Array; width: number; height: number };
  let best = 0;
  let bestIndex = 0;
  for (let i = 0; i < width * height; i++) {
    const lum = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
    if (lum > best) {
      best = lum;
      bestIndex = i;
    }
  }
  const px = bestIndex % width;
  const py = Math.floor(bestIndex / width);
  const lon = ((px + 0.5) / width - 0.5) * Math.PI * 2;
  const lat = (0.5 - (py + 0.5) / height) * Math.PI;
  const photoSun = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));

  // The sky's light maps (and the background) are kept as half-precision floats, which end at
  // 65504. The sun's brightest pixels go past that (73216): an iPhone's graphics chip turns them
  // into infinity, and blurring the maps spreads it into every reflection, so every surface came
  // out black while the sky looked fine. Capped a little under; the sunlight itself comes from
  // the directional light.
  for (let i = 0; i < data.length; i++) if (data[i] > 60000) data[i] = 60000;

  // Turn the sky around the vertical axis so its sun sits at the wanted compass direction.
  const turn = Math.atan2(photoSun.z, photoSun.x) - Math.atan2(wantedSunDir.z, wantedSunDir.x);
  scene.backgroundRotation.set(0, turn, 0);
  scene.environmentRotation.set(0, turn, 0);
  const sunDir = photoSun.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), turn).normalize();

  // Older iPads (A12/A13 chips) can't filter 32-bit float textures smoothly, and WebGL then reads
  // the sky as black: the background and, through the light maps, every shaded surface with it.
  // Half floats filter everywhere, and after the cap above every value fits in one.
  if (!renderer.extensions.has('OES_texture_float_linear')) {
    const half = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
    (hdr.image as { data: ArrayBufferView }).data = half;
    hdr.type = THREE.HalfFloatType;
  }

  scene.background = hdr;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  pmrem.dispose();

  sun.position.copy(sun.target.position).addScaledVector(sunDir, 60);
  sun.userData.direction = sunDir;

  // Haze: far things fade into the colour of the sky just above the horizon (averaged all
  // the way round), so the ground's far edge and the distant houses melt into the sky.
  const haze = new THREE.Color(0, 0, 0);
  let n = 0;
  for (let py = Math.floor(height * 0.47); py < Math.floor(height * 0.495); py++) {
    for (let x = 0; x < width; x += 4) {
      const i = (py * width + x) * 4;
      haze.r += data[i];
      haze.g += data[i + 1];
      haze.b += data[i + 2];
      n++;
    }
  }
  haze.multiplyScalar(1 / Math.max(1, n));
  scene.fog = new THREE.FogExp2(haze, 0.0019);
}
