import * as THREE from 'three';
import { paintball } from '../paintball';
import { gunModel, gunsReady, type WeaponId } from '../weapon';

/**
 * A picture of each gun for the menus (the weapon picker, ui/loadout.ts): the game's own model, drawn once
 * from its right side, a little turned towards you, into a small off-screen picture and kept as a data URL.
 * Drawn with the game's renderer (no second one), under the sky the game has, so the metal looks as it does
 * in your hands. Paintball's toy colours give pictures of their own.
 */

const W = 720;
const H = 360;
const made = new Map<string, string>();
let loaded = false;
void gunsReady.then((ok) => (loaded = ok));

export function gunPicture(renderer: THREE.WebGLRenderer, sky: THREE.Texture | null, w: WeaponId): string {
  const key = `${w}${paintball.on ? ':paint' : ''}`;
  const had = made.get(key);
  if (had !== undefined) return had;
  if (!loaded) return ''; // the models aren't in yet: asked again next time
  const model = gunModel(w);
  const scene = new THREE.Scene();
  scene.environment = sky;
  scene.environmentIntensity = 1.1;
  scene.add(new THREE.HemisphereLight('#ffffff', '#3a4350', 1.6));
  const sun = new THREE.DirectionalLight('#fff4e0', 3.2);
  sun.position.set(1.5, 2.5, 1);
  scene.add(sun);
  // The barrel (-z) to the right, seen from the gun's right side, turned a little towards the eye and up.
  const turn = new THREE.Group();
  turn.add(model);
  turn.rotation.set(0.12, 0.38, 0, 'YXZ');
  scene.add(turn);
  turn.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(turn);
  const mid = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const half = Math.max(size.z / 2, (size.y / 2) * (W / H)) * 1.08;
  const camera = new THREE.OrthographicCamera(-half, half, half * (H / W), -half * (H / W), 0.01, 10);
  camera.position.set(mid.x + 3, mid.y, mid.z);
  camera.lookAt(mid);
  const target = new THREE.WebGLRenderTarget(W, H);
  const was = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), auto: renderer.autoClear };
  const pixels = new Uint8Array(W * H * 4);
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor('#000000', 0);
    renderer.autoClear = true;
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels);
  } finally {
    renderer.setRenderTarget(was.target);
    renderer.setClearColor(was.color, was.alpha);
    renderer.autoClear = was.auto;
    target.dispose();
  }
  // Onto a canvas the right way up, from the renderer's linear light to the screen's.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const image = g.createImageData(W, H);
  const curve = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.round(255 * Math.pow(i / 255, 1 / 2.2));
  for (let y = 0; y < H; y++) {
    const from = (H - 1 - y) * W * 4;
    const to = y * W * 4;
    for (let x = 0; x < W * 4; x += 4) {
      image.data[to + x] = curve[pixels[from + x]];
      image.data[to + x + 1] = curve[pixels[from + x + 1]];
      image.data[to + x + 2] = curve[pixels[from + x + 2]];
      image.data[to + x + 3] = pixels[from + x + 3];
    }
  }
  g.putImageData(image, 0, 0);
  const url = canvas.toDataURL('image/png');
  made.set(key, url);
  return url;
}
