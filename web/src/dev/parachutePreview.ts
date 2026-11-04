import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildSwat, swatReady, type Body, type Outfit } from '../net/swat';
import { PilotPose } from './parachutePilot';

/**
 * A separate page for the parachute's assets (web/parachute-preview.html, only on the dev server: the
 * build leaves it out). It loads the exported web/public/models/parachute.glb and the game's own player
 * figure, and plays the clips: deploy, glide, steering, flare, landing and stowing.
 *
 * The falling, gliding and steering here are a visual prototype to show the animations, not the game's
 * flight rules: in multiplayer the server will decide where a player is (docs/parachute/README.md).
 *
 * URL options: ?cam=fp|tp|ground  ?n=16 (parachutes)  ?q=low|high  ?lod=auto|0|1
 *              ?clip=<name>&t=<s> (freeze every parachute in one clip at one time)  ?pitch=<rad>  ?hud=0
 */

type Clip = 'Deploy' | 'Glide_Idle' | 'Glide_Left' | 'Glide_Right' | 'Flare' | 'Land_Collapse';
type State = 'fall' | 'deploy' | 'glide' | 'flare' | 'land' | 'down';
type Cam = 'fp' | 'tp' | 'ground';
const CLIPS: Clip[] = ['Deploy', 'Glide_Idle', 'Glide_Left', 'Glide_Right', 'Flare', 'Land_Collapse'];

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);

// The game's figures' outfits (net/avatars.ts) and a few player colours.
const OUTFITS: Outfit[] = [
  { main: '#4b4c3b', dark: '#25261f' },
  { main: '#5a4632', dark: '#2a241d' },
  { main: '#8a7a5a', dark: '#4a4232' },
  { main: '#3a3d42', dark: '#121212' },
];
const COLOURS = ['#e0733a', '#3a86e0', '#d64045', '#2fa36b', '#c9a227', '#8e5bd6', '#e05aa6', '#1fb3b8'];

// The visual prototype's numbers (not gameplay).
const START_ALT = 70;    // m
const FALL_TIME = 0.6;   // s packed before the canopy goes out
const GLIDE = 8.5;       // m/s forward
const SINK = 4.2;        // m/s down, more while turning
const TURN = 0.9;        // rad/s at full toggle
const FLARE_ALT = 3.2;   // m: flares on its own here unless the player flared already
const DEPLOY = 1.8;      // s, the Deploy clip
const LAND = 2.4;        // s, the Land_Collapse clip
/**
 * Everything the parachute's clips reach, from docs/parachute/manifest.json (glTF axes, m), so a skinned
 * mesh is culled by where it can be rather than by its rest pose.
 */
const REACH = new THREE.Box3(new THREE.Vector3(-3.8, 0, -4.1), new THREE.Vector3(3.8, 5.9, 2.4));
const LOD_FAR = { low: 15, high: 35 }; // m: beyond this, LOD1 (on Low's coarse pixels LOD0's thin lines break up sooner)
const GLOW = 0.28;       // the accent's emissive, colour x GLOW (docs/parachute/manifest.json)

// ---- Renderer and scene: the game's lights and tone mapping.
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
let quality: 'low' | 'high' = params.get('q') === 'high' ? 'high' : 'low';

const scene = new THREE.Scene();
scene.background = new THREE.Color('#a9c4dc');
scene.fog = new THREE.Fog('#c8d7e3', 180, 1100);
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2000);
const sun = new THREE.DirectionalLight('#fff1de', 3.2);
sun.position.set(-40, 80, 30);
sun.castShadow = true;
sun.shadow.camera.left = sun.shadow.camera.bottom = -14;
sun.shadow.camera.right = sun.shadow.camera.top = 14;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight('#dfe9f5', '#b9a487', 0.9));

function applyQuality(): void {
  renderer.setPixelRatio(quality === 'low' ? 0.55 : Math.min(2, devicePixelRatio));
  const size = quality === 'low' ? 1024 : 2048;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  resize();
}

function resize(): void {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---- A plain landscape for scale: fields, a few houses and trees (three draws).
function landscape(): void {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: '#6f8a4a', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const rnd = mulberry(7);
  const houses = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#b5654a', roughness: 0.9 }), 40);
  const roofs = new THREE.InstancedMesh(new THREE.ConeGeometry(0.75, 1, 4), new THREE.MeshStandardMaterial({ color: '#4a4440', roughness: 0.9 }), 40);
  const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7), new THREE.MeshStandardMaterial({ color: '#3f5f2e', roughness: 1 }), 120);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let i = 0; i < 40; i++) {
    const x = (rnd() - 0.5) * 420;
    const z = -60 - rnd() * 260;
    const w = 7 + rnd() * 5;
    const d = 8 + rnd() * 4;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
    houses.setMatrixAt(i, m.compose(new THREE.Vector3(x, 3, z), q, new THREE.Vector3(w, 6, d)));
    roofs.setMatrixAt(i, m.compose(new THREE.Vector3(x, 7.5, z), q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4)), new THREE.Vector3(w * 1.05, 3, d * 1.05)));
  }
  for (let i = 0; i < 120; i++) {
    const x = (rnd() - 0.5) * 600;
    const z = 40 - rnd() * 420;
    const h = 7 + rnd() * 6;
    trees.setMatrixAt(i, m.compose(new THREE.Vector3(x, h / 2, z), q.identity(), new THREE.Vector3(h * 0.3, h, h * 0.3)));
  }
  for (const o of [houses, roofs, trees]) {
    o.castShadow = o.receiveShadow = true;
    scene.add(o);
  }
}

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const approach = (v: number, to: number, rate: number, dt: number) => v + (to - v) * (1 - Math.exp(-rate * dt));

// ---- One parachute with its pilot.
const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
const headBox = new THREE.SphereGeometry(0.15, 8, 6);
const bodyBox = new THREE.BoxGeometry(0.5, 1.45, 0.42);
const accents = new Map<string, THREE.Material>();

class Chute {
  readonly group = new THREE.Group();
  readonly rig: THREE.Object3D;
  readonly body: Body;
  readonly pilot: PilotPose;
  private mixer: THREE.AnimationMixer;
  private act: Record<Clip, THREE.AnimationAction>;
  private lods: THREE.Object3D[][] = [[], []];
  state: State = 'fall';
  t = 0;
  yaw = 0;
  steer = 0;
  steerIn = 0;
  fwd = 0;
  vy = 0;
  lod = 0;
  hideHead = false;
  private w = { deploy: 1, glide: 0, flare: 0, land: 0 };

  constructor(gltf: GLTF, colour: string, outfit: Outfit, name: string) {
    // The repository's way: SkeletonUtils.clone gives each copy its own bones; geometry and the fabric
    // material stay shared. Each colour has one accent material.
    this.rig = SkeletonUtils.clone(gltf.scene);
    let accent = accents.get(colour);
    this.rig.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (mat.name === 'Parachute_Accent') {
        if (!accent) {
          const m = mat.clone();
          m.color.set(colour);
          m.emissive.set(colour).multiplyScalar(GLOW); // as the canopy: a little light through the fabric
          accents.set(colour, (accent = m));
        }
        mesh.material = accent;
      }
      mesh.castShadow = true;
      const s = new THREE.Sphere();
      REACH.getBoundingSphere(s);
      mesh.boundingSphere = s;
      mesh.boundingBox = REACH.clone();
      const lod = /LOD1/.test(mesh.name) || /LOD1/.test(mesh.parent?.name ?? '') ? 1 : 0;
      this.lods[lod].push(mesh);
    });
    this.body = buildSwat(name, colour, outfit, hitMaterial, headBox, bodyBox);
    this.body.root.traverse((o) => (o.castShadow = (o as THREE.Mesh).isMesh && (o as THREE.Mesh).material !== hitMaterial));
    this.group.add(this.rig, this.body.root);
    this.pilot = new PilotPose(this.group, this.rig, this.body.root);
    this.mixer = new THREE.AnimationMixer(this.rig);
    this.act = {} as Record<Clip, THREE.AnimationAction>;
    for (const c of CLIPS) {
      const clip = gltf.animations.find((a) => a.name === c);
      if (!clip) throw new Error(`parachute.glb has no clip ${c}`);
      const a = this.mixer.clipAction(clip);
      if (c === 'Deploy' || c === 'Flare' || c === 'Land_Collapse') {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      this.act[c] = a;
    }
    this.showLod(0);
  }

  showLod(l: number): void {
    this.lod = l;
    for (const m of this.lods[0]) m.visible = l === 0;
    for (const m of this.lods[1]) m.visible = l === 1;
  }

  /** Back to the start: packed, falling, high up. */
  reset(x: number, y: number, z: number, yaw: number): void {
    this.group.position.set(x, y, z);
    this.yaw = yaw;
    this.state = 'fall';
    this.t = 0;
    this.fwd = 6;
    this.vy = -6;
    this.steer = this.steerIn = 0;
    this.mixer.stopAllAction();
    this.w = { deploy: 1, glide: 0, flare: 0, land: 0 };
    this.act.Deploy.reset().play();
    this.act.Deploy.paused = true; // the first frame: everything in the pack
    this.weights();
  }

  /** Hold one clip at one time (for screenshots). */
  freeze(c: Clip, t: number): void {
    this.mixer.stopAllAction();
    for (const k of CLIPS) this.act[k].setEffectiveWeight(0);
    const a = this.act[c].reset().play();
    a.setEffectiveWeight(1);
    a.time = t;
    a.paused = true;
    this.state = c === 'Land_Collapse' ? 'land' : c === 'Deploy' ? 'deploy' : c === 'Flare' ? 'flare' : 'glide';
    this.mixer.update(0);
  }

  flare(): void {
    if (this.state !== 'glide') return;
    this.state = 'flare';
    this.t = 0;
    this.act.Flare.reset().play();
  }

  private weights(): void {
    const s = this.steer;
    const g = this.w.glide;
    this.act.Deploy.setEffectiveWeight(this.w.deploy);
    this.act.Glide_Idle.setEffectiveWeight(g * (1 - Math.abs(s)));
    this.act.Glide_Left.setEffectiveWeight(g * Math.max(0, -s));
    this.act.Glide_Right.setEffectiveWeight(g * Math.max(0, s));
    this.act.Flare.setEffectiveWeight(this.w.flare);
    this.act.Land_Collapse.setEffectiveWeight(this.w.land);
  }

  /** The visual prototype: fall, open, glide, steer, flare and land on flat ground at y = 0. */
  update(dt: number, frozen: boolean): void {
    this.t += dt;
    const p = this.group.position;
    if (!frozen) {
      this.steer = approach(this.steer, this.steerIn, 3, dt);
      switch (this.state) {
        case 'fall':
          this.vy = Math.max(-25, this.vy - 9.81 * dt);
          if (this.t >= FALL_TIME) {
            this.state = 'deploy';
            this.t = 0;
            this.act.Deploy.paused = false;
          }
          break;
        case 'deploy':
          this.vy = approach(this.vy, -SINK, 1.6, dt);
          this.fwd = approach(this.fwd, GLIDE, 1.2, dt);
          if (this.t >= DEPLOY - 0.2 && this.w.glide === 0) {
            for (const c of ['Glide_Idle', 'Glide_Left', 'Glide_Right'] as Clip[]) this.act[c].reset().play();
            this.w.glide = 0.001;
          }
          if (this.w.glide > 0) {
            this.w.glide = Math.min(1, this.w.glide + dt / 0.2);
            this.w.deploy = 1 - this.w.glide;
          }
          if (this.t >= DEPLOY) {
            this.state = 'glide';
            this.w = { deploy: 0, glide: 1, flare: 0, land: 0 };
          }
          break;
        case 'glide':
          this.yaw -= this.steer * TURN * dt;
          this.vy = approach(this.vy, -(SINK + 1.6 * Math.abs(this.steer)), 2, dt);
          this.fwd = approach(this.fwd, GLIDE, 1, dt);
          if (p.y < FLARE_ALT) this.flare();
          break;
        case 'flare':
          this.w.flare = Math.min(1, this.w.flare + dt / 0.2);
          this.w.glide = 1 - this.w.flare;
          this.fwd = approach(this.fwd, 2.5, 2.5, dt);
          this.vy = approach(this.vy, -1.2, 4, dt);
          if (p.y <= 0) {
            p.y = 0;
            this.state = 'land';
            this.t = 0;
            this.act.Land_Collapse.reset().play();
          }
          break;
        case 'land':
          this.w.land = Math.min(1, this.w.land + dt / 0.12);
          this.w.flare = 1 - this.w.land;
          this.w.glide = 0;
          this.fwd = approach(this.fwd, 0, 3.5, dt);
          this.vy = 0;
          if (this.t >= LAND) this.state = 'down';
          break;
        case 'down':
          this.fwd = this.vy = 0;
          break;
      }
      p.x -= Math.sin(this.yaw) * this.fwd * dt;
      p.z -= Math.cos(this.yaw) * this.fwd * dt;
      p.y = Math.max(0, p.y + this.vy * dt);
      if (this.state === 'glide' && p.y <= 0) this.flare();
      this.group.rotation.y = this.yaw;
      this.weights();
      this.mixer.update(dt);
    }
    this.group.updateMatrixWorld(true);
    this.pilot.apply(this.hideHead);
  }

  get altitude(): number {
    return this.group.position.y;
  }
}

// ---- The page: HUD, buttons, cameras.
const hud = document.getElementById('hud')!;
const stats = document.getElementById('stats')!;
if (params.get('hud') === '0') document.body.classList.add('bare');
let cam: Cam = (['fp', 'tp', 'ground'] as Cam[]).includes(params.get('cam') as Cam) ? (params.get('cam') as Cam) : 'tp';
let lodMode = params.get('lod') === '0' || params.get('lod') === '1' ? Number(params.get('lod')) : -1;
let count = Math.max(1, Math.min(32, Math.round(num('n', 1))));
const frozenClip = CLIPS.includes(params.get('clip') as Clip) ? (params.get('clip') as Clip) : null;
const frozenT = num('t', 0);
let lookYaw = 0;
let lookPitch = num('pitch', cam === 'fp' ? 1.0 : 0);
const groundEye = new THREE.Vector3();
let chutes: Chute[] = [];
let gltf: GLTF;
const keys = new Set<string>();
const held = { left: false, right: false };

function button(id: string, fn: () => void): HTMLButtonElement {
  const b = document.getElementById(id) as HTMLButtonElement;
  b.addEventListener('click', fn);
  return b;
}

function hold(id: string, side: 'left' | 'right'): void {
  const b = document.getElementById(id) as HTMLButtonElement;
  const on = (e: PointerEvent) => {
    held[side] = true;
    b.setPointerCapture?.(e.pointerId);
    b.classList.add('on');
  };
  const off = () => {
    held[side] = false;
    b.classList.remove('on');
  };
  b.addEventListener('pointerdown', on);
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, off);
}

hold('left', 'left');
hold('right', 'right');
button('flare', () => chutes[0]?.flare());
button('reset', () => resetAll());
button('cam', () => setCam(cam === 'fp' ? 'tp' : cam === 'tp' ? 'ground' : 'fp'));
const crowd = button('crowd', () => {
  count = count === 1 ? 16 : 1;
  build();
});
const lodBtn = button('lod', () => {
  lodMode = lodMode === -1 ? 0 : lodMode === 0 ? 1 : -1;
  label();
});
const qBtn = button('quality', () => {
  quality = quality === 'low' ? 'high' : 'low';
  applyQuality();
  label();
});

function label(): void {
  crowd.textContent = count === 1 ? 'x16' : 'x1';
  lodBtn.textContent = lodMode === -1 ? 'LOD auto' : `LOD${lodMode}`;
  qBtn.textContent = quality === 'low' ? 'Low' : 'High';
  (document.getElementById('cam') as HTMLButtonElement).textContent = cam === 'fp' ? 'First person' : cam === 'tp' ? 'Third person' : 'Ground';
}

function setCam(c: Cam): void {
  cam = c;
  lookYaw = 0;
  lookPitch = c === 'fp' ? 1.0 : 0;
  label();
}

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space' || e.code === 'KeyS') chutes[0]?.flare();
  if (e.code === 'KeyR') resetAll();
  if (e.code === 'Digit1') setCam('fp');
  if (e.code === 'Digit2') setCam('tp');
  if (e.code === 'Digit3') setCam('ground');
});
addEventListener('keyup', (e) => keys.delete(e.code));

// Drag on the view to look round.
let drag: { id: number; x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  lookYaw -= (e.clientX - drag.x) * 0.005;
  lookPitch = Math.max(-1.2, Math.min(1.45, lookPitch - (e.clientY - drag.y) * 0.005));
  drag.x = e.clientX;
  drag.y = e.clientY;
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => (drag = null));

function spot(i: number): [number, number, number, number] {
  if (i === 0) return [0, START_ALT, 60, 0];
  const r = mulberry(100 + i);
  const a = r() * Math.PI * 2;
  const d = 10 + r() * 22;
  return [Math.cos(a) * d, START_ALT - 18 + r() * 34, 60 + Math.sin(a) * d, (r() - 0.5) * 0.6];
}

function resetAll(): void {
  chutes.forEach((c, i) => {
    const [x, y, z, yaw] = spot(i);
    c.reset(x, y, z, yaw);
    if (frozenClip) {
      c.group.position.y = i === 0 ? 30 : c.group.position.y - 30;
      c.group.rotation.y = c.yaw;
      c.freeze(i === 0 ? frozenClip : CLIPS[i % CLIPS.length], i === 0 ? frozenT : (i * 0.37) % 1.6);
    }
  });
  // The ground camera stands to the side of where the first one comes down (straight glide, no wind).
  groundEye.set(26, 1.65, -40);
}

function build(): void {
  for (const c of chutes) {
    scene.remove(c.group);
    c.body.dispose?.();
  }
  chutes = [];
  for (let i = 0; i < count; i++) {
    const c = new Chute(gltf, COLOURS[i % COLOURS.length], OUTFITS[i % OUTFITS.length], `P${i}`);
    scene.add(c.group);
    chutes.push(c);
  }
  resetAll();
  label();
  const fit = chutes[0].pilot.fitError;
  console.log(`[parachute] guides vs figure at rest: ${(fit * 1000).toFixed(1)} mm`);
}

// ---- The loop.
const clock = new THREE.Clock();
const frameMs: number[] = [];
const cpuMs: number[] = [];
const tmp = new THREE.Vector3();
const tpOffset = new THREE.Vector3();

function tick(): void {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, clock.getDelta());
  const t0 = performance.now();
  const hero = chutes[0];
  if (!hero) return;
  hero.steerIn = (held.left || keys.has('ArrowLeft') || keys.has('KeyA') || keys.has('KeyQ') ? -1 : 0)
    + (held.right || keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0);
  chutes.forEach((c, i) => {
    if (i > 0 && !frozenClip) {
      c.steerIn = Math.sin(c.t * 0.35 + i) > 0.55 ? -1 : Math.sin(c.t * 0.35 + i) < -0.55 ? 1 : 0;
      if (c.state === 'down' && c.t > 2) {
        const [x, y, z, yaw] = spot(i);
        c.reset(x, y, z, yaw);
      }
    }
    c.hideHead = i === 0 && cam === 'fp';
    const far = c.group.position.distanceTo(camera.position);
    const l = lodMode >= 0 ? lodMode : far > LOD_FAR[quality] ? 1 : 0;
    if (l !== c.lod) c.showLod(l);
    c.update(dt, !!frozenClip);
  });
  // Cameras.
  const p = hero.group.position;
  if (cam === 'fp') {
    hero.pilot.eye(camera.position);
    camera.rotation.set(lookPitch, hero.yaw + lookYaw, 0, 'YXZ');
    camera.fov = 75;
  } else if (cam === 'tp') {
    tpOffset.set(0, 1.4, 8.5).applyAxisAngle(THREE.Object3D.DEFAULT_UP, hero.yaw + lookYaw);
    tmp.copy(p).add(tpOffset);
    tmp.y = Math.max(1.2, tmp.y + lookPitch * 6);
    camera.position.lerp(tmp, 1 - Math.exp(-dt * 6));
    if (camera.position.distanceTo(tmp) > 30) camera.position.copy(tmp);
    camera.lookAt(p.x, p.y + 2.6, p.z);
    camera.fov = 60;
  } else {
    camera.position.copy(groundEye);
    camera.lookAt(p.x, p.y + 2.2, p.z);
    camera.rotateY(lookYaw);
    camera.rotateX(lookPitch);
    camera.fov = 50;
  }
  camera.updateProjectionMatrix();
  sun.target.position.copy(p);
  sun.position.copy(p).add(tmp.set(-40, 80, 30));
  renderer.render(scene, camera);
  const t1 = performance.now();
  // Numbers.
  frameMs.push(dt * 1000);
  cpuMs.push(t1 - t0);
  if (frameMs.length > 120) {
    frameMs.shift();
    cpuMs.shift();
  }
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const info = renderer.info;
  const st = {
    fps: 1000 / avg(frameMs), frameMs: avg(frameMs), cpuMs: avg(cpuMs), calls: info.render.calls, triangles: info.render.triangles,
    geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0, parachutes: chutes.length,
  };
  window.parachuteStats = st;
  stats.textContent = `${st.fps.toFixed(0)} fps · frame ${st.frameMs.toFixed(1)} ms · cpu ${st.cpuMs.toFixed(1)} ms\n`
    + `${st.calls} draws · ${(st.triangles / 1000).toFixed(1)}k triangles · ${st.parachutes} parachute${st.parachutes > 1 ? 's' : ''} · ${quality}`;
  hud.textContent = `${hero.state} · ${hero.altitude.toFixed(1)} m · steer ${hero.steer.toFixed(2)} · LOD${hero.lod}`;
}

declare global {
  interface Window {
    parachuteStats?: Record<string, number>;
    parachute?: { setCam(c: Cam): void; resetAll(): void; chutes(): Chute[] };
  }
}
window.parachute = { setCam, resetAll, chutes: () => chutes };

landscape();
applyQuality();
label();
Promise.all([new GLTFLoader().loadAsync('/models/parachute.glb'), swatReady]).then(([g, ok]) => {
  if (!ok) throw new Error('swat.glb did not load');
  gltf = g;
  build();
  tick();
}).catch((e) => {
  hud.textContent = `Could not load: ${String(e)}`;
});
