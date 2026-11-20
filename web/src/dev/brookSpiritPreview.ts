import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BloomPass } from '../bloom';
import { gradedOutput } from '../grade';
import { mood } from '../world/mood';
import { BrookSpirit, loadBrookSpirit, type SpiritLook } from '../world/brookSpirit';

/**
 * A separate page for the brook spirit's look (web/brook-spirit-preview.html, only on the dev server: the build
 * leaves it out). The creature floats over a patch of woodland by a brook, by day or at night, with the game's
 * tone mapping, colour grade and bloom; sliders and keys drive its inputs. No rules, no attacks.
 *
 * URL options: ?open= &shield= &anger= &fade= (0..1)  ?reach=1  ?night=1  ?q=low|high  ?dist=<m>  ?yaw=<rad>
 *              ?pitch=<rad>  ?move=1  ?hud=0
 * In the console (and for tools in the dev folder): spirit.set({open: 1}), spirit.hurt(), spirit.view(dist, yaw,
 * pitch), spirit.bench(frames), spirit.show(false) (the creature hidden, for a with-and-without measurement).
 */

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);
if (params.get('hud') === '0') document.body.classList.add('bare');

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.info.autoReset = false; // the draws of all passes together
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 800);
const sun = new THREE.DirectionalLight('#fff1de', 3.2);
sun.position.set(-20, 40, 15);
sun.castShadow = true;
sun.shadow.camera.left = sun.shadow.camera.bottom = -16;
sun.shadow.camera.right = sun.shadow.camera.top = 16;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight('#dfe9f5', '#b9a487', 0.9);
scene.add(hemi);

// The game's passes: the scene in half floats, the glow (Medium and up), the output with its grade.
const target = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType });
const composer = new EffectComposer(renderer, target);
composer.addPass(new RenderPass(scene, camera));
const bloom = new BloomPass();
composer.addPass(bloom);
composer.addPass(gradedOutput(bloom.output));

// ---- A patch of woodland by a brook: forest floor, a strip of water, trees in November, a few stones.
function random(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
function woodland(): void {
  const rnd = random(5);
  const ground = new THREE.PlaneGeometry(120, 120, 60, 60);
  const cols: number[] = [];
  const pos = ground.getAttribute('position');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // The brook's bed runs across at z = 6: the bank dips towards it.
    const bed = Math.exp(-(((-y - 6) / 2.2) ** 2));
    pos.setZ(i, -0.6 * bed + 0.15 * Math.sin(x * 0.7) * Math.sin(y * 0.5));
    c.set(rnd() < 0.5 ? '#4b3a26' : '#5a4a2c').lerp(new THREE.Color('#3f4a2a'), rnd() * 0.5).lerp(new THREE.Color('#2f3328'), bed);
    cols.push(c.r, c.g, c.b);
  }
  ground.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  ground.computeVertexNormals();
  const floor = new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const water = new THREE.Mesh(new THREE.PlaneGeometry(120, 2.2), new THREE.MeshStandardMaterial({ color: '#2a3a40', roughness: 0.08, metalness: 0.2 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -0.35, 6);
  scene.add(water);
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 1, 7).translate(0, 0.5, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#4a4038', roughness: 0.95 }), 46);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), 46);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const autumn = ['#6b5a2a', '#7c5a26', '#5b5f30', '#8a6a2c', '#4e5a34'].map((h) => new THREE.Color(h));
  let n = 0;
  while (n < 46) {
    const x = (rnd() - 0.5) * 70;
    const z = (rnd() - 0.5) * 70;
    if (Math.hypot(x, z) < 7 || Math.abs(z - 6) < 2) continue;
    const h = 8 + rnd() * 7;
    trunks.setMatrixAt(n, m.compose(new THREE.Vector3(x, 0, z), q.identity(), new THREE.Vector3(1 + rnd() * 0.5, h, 1 + rnd() * 0.5)));
    const r = 2.2 + rnd() * 1.6;
    crowns.setMatrixAt(n, m.compose(new THREE.Vector3(x, h * 0.92, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6), new THREE.Vector3(r, r * 1.2, r)));
    crowns.setColorAt(n, autumn[n % autumn.length]);
    n++;
  }
  trunks.castShadow = crowns.castShadow = true;
  scene.add(trunks, crowns);
  const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.4, 0), new THREE.MeshStandardMaterial({ color: '#6f7068', roughness: 0.9 }), 12);
  for (let i = 0; i < 12; i++) stones.setMatrixAt(i, m.compose(new THREE.Vector3((rnd() - 0.5) * 16, 0, 4.6 + rnd() * 3), q.identity(), new THREE.Vector3(0.6 + rnd(), 0.35 + rnd() * 0.3, 0.6 + rnd())));
  stones.receiveShadow = true;
  scene.add(stones);
}
woodland();

// ---- Day and night, as the game's sunny and night moods (world/weather.ts) give them, roughly.
let night = params.get('night') === '1';
function applyTime(): void {
  mood.night = night ? 1 : 0;
  const sky = new THREE.Color(night ? '#0b1018' : '#a9c0d4');
  scene.background = sky;
  scene.fog = new THREE.FogExp2(night ? '#0d121a' : '#b9c8d4', night ? 0.03 : 0.012);
  sun.color.set(night ? '#a9bdff' : '#fff1de');
  sun.intensity = night ? 0.35 : 3.2;
  hemi.color.set(night ? '#3d4b6a' : '#dfe9f5');
  hemi.groundColor.set(night ? '#2e2e38' : '#b9a487');
  hemi.intensity = night ? 0.45 : 0.9;
  renderer.toneMappingExposure = night ? 1.8 : 0.9;
  document.getElementById('night')!.classList.toggle('on', night);
}

// ---- Quality: Medium and up ('high') with the glow and soft shadows, or Low.
let look: SpiritLook = params.get('q') === 'low' ? 'low' : 'high';
function applyLook(): void {
  renderer.setPixelRatio(look === 'low' ? 0.55 : Math.min(2, devicePixelRatio));
  bloom.setDivisor(look === 'low' ? 0 : 4);
  spirit?.setLook(look);
  document.getElementById('quality')!.textContent = look === 'low' ? 'Low' : 'High';
  resize();
}
function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---- The camera: orbits the creature; drag, wheel, pinch.
const HOVER = 3.4;
const view = { dist: num('dist', 7), yaw: num('yaw', 0.35), pitch: num('pitch', 0.12) };
function placeCamera(): void {
  const c = spirit ? spirit.group.position : new THREE.Vector3(0, HOVER, 0);
  const at = new THREE.Vector3(c.x, Math.max(1.6, c.y - 0.4), c.z);
  camera.position.set(at.x + Math.sin(view.yaw) * Math.cos(view.pitch) * view.dist, at.y + Math.sin(view.pitch) * view.dist, at.z + Math.cos(view.yaw) * Math.cos(view.pitch) * view.dist);
  camera.position.y = Math.max(0.4, camera.position.y);
  camera.lookAt(at);
}
const pointers = new Map<number, { x: number; y: number }>();
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
canvas.addEventListener('pointerup', (e) => pointers.delete(e.pointerId));
canvas.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    view.yaw -= (e.clientX - p.x) * 0.006;
    view.pitch = THREE.MathUtils.clamp(view.pitch + (e.clientY - p.y) * 0.004, -0.3, 1.3);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    p.x = e.clientX;
    p.y = e.clientY;
    const after = Math.hypot(a.x - b.x, a.y - b.y);
    view.dist = THREE.MathUtils.clamp(view.dist * (before / Math.max(1, after)), 2, 60);
    return;
  }
  p.x = e.clientX;
  p.y = e.clientY;
});
canvas.addEventListener('wheel', (e) => {
  view.dist = THREE.MathUtils.clamp(view.dist * Math.exp(e.deltaY * 0.001), 2, 60);
});

// ---- The creature and its inputs.
let spirit: BrookSpirit | null = null;
const inputs = { open: num('open', 0), shield: num('shield', 0), anger: num('anger', 0), fade: num('fade', 0) };
let reaching = params.get('reach') === '1';
let moving = params.get('move') === '1';
const reachAt = new THREE.Vector3();
const sliders = Object.keys(inputs) as (keyof typeof inputs)[];
for (const k of sliders) {
  const el = document.getElementById(k) as HTMLInputElement;
  el.value = String(inputs[k]);
  el.addEventListener('input', () => (inputs[k] = Number(el.value)));
}
const setSlider = (k: keyof typeof inputs, v: number) => {
  inputs[k] = v;
  (document.getElementById(k) as HTMLInputElement).value = String(v);
};
const toggle = (k: keyof typeof inputs) => setSlider(k, inputs[k] > 0.5 ? 0 : 1);
const press: Record<string, () => void> = {
  reach: () => (reaching = !reaching),
  hurt: () => spirit?.hurt(),
  move: () => (moving = !moving),
  night: () => {
    night = !night;
    applyTime();
  },
  quality: () => {
    look = look === 'low' ? 'high' : 'low';
    applyLook();
  },
  near: () => (view.dist = 4),
  far: () => (view.dist = 25),
};
for (const [id, fn] of Object.entries(press)) document.getElementById(id)!.addEventListener('click', fn);
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'o') toggle('open');
  else if (k === 's') toggle('shield');
  else if (k === 'a') toggle('anger');
  else if (k === 'f') toggle('fade');
  else if (k === 'r') press.reach();
  else if (k === 'h') press.hurt();
  else if (k === 'n') press.night();
  else if (k === 'q') press.quality();
  else if (k === 'm') press.move();
  else if (k === '1') press.near();
  else if (k === '2') press.far();
});

const stats = document.getElementById('stats')!;
let shown = true;
const clock = new THREE.Clock();
let frames = 0;
let since = performance.now();
let t = 0;

function step(dt: number): void {
  t += dt;
  if (spirit) {
    // Moving: a slow figure of eight over the clearing, facing where it goes, so the mist and tendrils trail.
    const g = spirit.group;
    if (moving) {
      const x = Math.sin(t * 0.35) * 5;
      const z = Math.sin(t * 0.7) * 2.5;
      g.rotation.y = Math.atan2(Math.cos(t * 0.35) * 0.35 * 5, Math.cos(t * 0.7) * 0.7 * 2.5);
      g.position.set(x, HOVER, z);
    } else g.position.set(0, HOVER, 0);
    // The reach: a spot on the ground in front of it, moving a little.
    reachAt.set(Math.sin(t * 0.6) * 1.5, 0.3, 4.5).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.rotation.y).add(new THREE.Vector3(g.position.x, 0, g.position.z));
    spirit.open = inputs.open;
    spirit.shield = inputs.shield;
    spirit.anger = inputs.anger;
    spirit.fade = inputs.fade;
    spirit.reach = reaching ? reachAt : null;
    placeCamera();
    camera.updateMatrixWorld();
    spirit.update(dt, camera);
  } else placeCamera();
  for (const [id, on] of [['reach', reaching], ['move', moving]] as const) document.getElementById(id)!.classList.toggle('on', on);
}

function frame(): void {
  requestAnimationFrame(frame);
  step(Math.min(0.05, clock.getDelta()));
  renderer.info.reset();
  composer.render();
  frames++;
  const now = performance.now();
  if (now - since > 500) {
    const info = renderer.info.render;
    stats.textContent = `${((now - since) / frames).toFixed(1)} ms  ${info.calls} draws  ${info.triangles} triangles  ${look === 'low' ? 'Low' : 'High'}`;
    frames = 0;
    since = now;
  }
}

applyTime();
applyLook();
requestAnimationFrame(frame);

loadBrookSpirit().then((model) => {
  if (!model) {
    stats.textContent = 'The model did not load (npm run dev in web/, and public/models/brook-spirit.glb).';
    return;
  }
  spirit = new BrookSpirit(model, look);
  spirit.group.position.set(0, HOVER, 0);
  scene.add(spirit.group);
  // A few seconds on, so the mist is in place before the first picture.
  for (let i = 0; i < 90; i++) step(1 / 60);
  (window as unknown as { spiritReady: boolean }).spiritReady = true;
});

Object.assign(window, {
  spirit: {
    set(v: Partial<typeof inputs> & { reach?: boolean; night?: boolean; move?: boolean; look?: SpiritLook }) {
      for (const k of sliders) if (v[k] !== undefined) setSlider(k, v[k]!);
      if (v.reach !== undefined) reaching = v.reach;
      if (v.move !== undefined) moving = v.move;
      if (v.night !== undefined && v.night !== night) press.night();
      if (v.look !== undefined && v.look !== look) press.quality();
    },
    hurt: () => spirit?.hurt(),
    view(dist: number, yaw = view.yaw, pitch = view.pitch) {
      Object.assign(view, { dist, yaw, pitch });
    },
    /** Settle for a number of 60 fps frames (the easing and the mist's trail), without drawing. */
    settle(n = 60) {
      for (let i = 0; i < n; i++) step(1 / 60);
    },
    show(on: boolean) {
      shown = on;
      if (spirit) scene[on ? 'add' : 'remove'](spirit.group);
    },
    get shown() {
      return shown;
    },
    /** The creature itself, to look into from the console. */
    get creature() {
      return spirit;
    },
    /** Draw n frames back to back and report the time per frame, as briel.bench() in the game. */
    bench(n = 120) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        step(1 / 60);
        composer.render(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      const ms = (performance.now() - t0) / n;
      return { msPerFrame: +ms.toFixed(3), pixels: [renderer.domElement.width, renderer.domElement.height], calls: renderer.info.render.calls };
    },
  },
});
