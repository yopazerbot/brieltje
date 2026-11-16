import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import HELIS from '../../shared/heli.json';
import { AWAY, awayInput, awayKeep, EV, HELI, heliBump, heliExit, heliHover, heliPlace, heliStart, heliStep, type HeliEnv, type HeliInput, type HeliState } from '../../shared/heli.mjs';
import { netClock, Track } from '../net/track';
import type { CrashHit, Obstacle } from './car';
import type { World } from './collision';
import { homeAt, inEndGarden } from '../../shared/homes.mjs';
import { HeliSound } from './heliSound';
import { padNear } from './heliPads';
import { mood } from './mood';
import { waterLevel } from './water';
import { windAt } from './wind';

/**
 * The helicopters (shared/heli.json; the flight is shared/heli.mjs): a light twin with a shrouded tail rotor, by the
 * main house for now. You get in with the use key and fly with a camera behind it (or from the pilot's seat). It rests
 * on whatever floor is under its skids, its fuselage stops against walls (the cabin, the tail boom and the stabiliser
 * as three boxes), its rotor disc touches what it reaches (eight points round its rim), tree crowns slow it and shake
 * leaves out, and a hard knock is a bump: sparks or dust, a clang, set down level, the engine off for a few seconds.
 * Never a fire, nobody hurt.
 *
 * The model is web/public/models/helicopter.glb (tools/helicopter.py; its contract as built: docs/helicopter/README.md).
 * The machine shows once the model is in (the start waits for it: main.ts getEverythingReady), so no stand-in is ever
 * swapped for it in sight; heliShape() stands in only when the file can't be loaded. At load the parts that never move
 * (the body, the closed doors, the sticks) are merged into one mesh per material, the four blades are drawn as one
 * instanced mesh per material, and the lamps and the gaps share the trim's and the lamps' draws (51 draws at rest in
 * the file, 19 here; see DECISIONS.md).
 */

export type HeliSpec = (typeof HELIS.machines)[number];
/**
 * A machine as the server has it (server/helis.mjs pub; a tick's entry through shared/wire.mjs readHeli): where, its
 * heading, pitch and roll (rad), rotor (0 to 1), `g` 1 at rest, and who sits in its four seats (seat 0 flies).
 */
export interface HeliView {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  p: number;
  r: number;
  n: number;
  g: number;
  seats: (string | null)[];
}
/** A tree from the world's list: its foot, its height and its crown's radius. */
export interface Crown {
  x: number;
  z: number;
  y: number;
  h: number;
  r: number;
}

const SIZE = HELIS.size;
const MODEL = '/models/helicopter.glb';
/** The player's system asks for less motion: no shudder, no wider view at speed. */
const CALM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const DRAW = 400; // m from the eye: further off it isn't drawn
/** s a machine left where nobody can reach it waits before it goes back to its pad. */
const LOST_AFTER = 20;
const DETAIL = 40; // m: the small parts go further off
const FAR = 90; // m: the simple copy from here (FAR_LOW on Low and phones)
const FAR_LOW = 45;
const RPM = (395 * 2 * Math.PI) / 60; // rad/s of the main rotor at full speed
const TAIL_RPM = (3530 * 2 * Math.PI) / 60;
const SPIN_STEP = 0.35; // rad: the most the rotor turns per frame on screen
const BLADES_UNTIL = 0.6; // the rotor's speed up to which its blades show (the disc from 0.45)
/** The parts that cast the machine's shadow (the small and the inner ones would be draws in the shadow pass for nothing). */
const SHADOW_PARTS = new Set(['Paint', 'PaintB', 'PaintC', 'Glass', 'Trim']);
/** The nodes that never move until doors open or sticks lean (package 4): merged per material at load. */
const STATIC = ['Body', 'Door_FL', 'Door_FR', 'Door_RL', 'Door_RR', 'Stick_Cyclic', 'Stick_Collective'];
/** The lamps' colours: their five materials become one draw, each lamp's colour in its vertices. */
const LAMPS: Record<string, string> = { LightRed: '#ff2a1a', LightGreen: '#20ff60', LightWhite: '#ffffff', LightBeacon: '#ff2010', LightLanding: '#fff2dc' };
/** Materials drawn with another's: the gaps (black) and the rubber with the trim, the lamps as one. */
const DRAWN_AS: Record<string, string> = { Gap: 'Trim', Rubber: 'Trim', ...Object.fromEntries(Object.keys(LAMPS).map((k) => [k, 'Lamp'])) };
const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** s without looking round before the view eases back behind the machine (or ahead from the seat) */
const LOOK_BACK = 2;
/** The pilot's head: rad up, down (a landing spot below stays in view: it isn't eased back) and to each side */
const HEAD = { up: 0.7, down: 1.05, yaw: 1.92 };
/** A passenger's view from their own seat: the eye this far over the seat's hip point (m), and at most 100 degrees to either side */
const SEAT_EYE = 0.76;
const SEAT_YAW = (100 * Math.PI) / 180;
const _eye = new THREE.Vector3();
const _seat = new THREE.Quaternion();
const _head = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const machines = new Set<Heli>();
let lowDetail = false;
/**
 * The graphics preset changed (main.ts applyQuality): on Low and on phones the simple copy from nearer and a plain
 * paint; on Medium and up the clear-coated paint the Teslas have (world/car.ts).
 */
export function setHeliDetail(low: boolean): void {
  lowDetail = low;
  for (const m of machines) m.dressPaint();
}

/**
 * The paint mirrors the ground below the horizon darker than the sky above it (as world/car.ts horizonReflection):
 * the sky's light map is bright all round, so without this the sides mirror one even grey.
 */
function horizonReflection(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <envmap_physical_pars_fragment>',
      THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
        /vec4 envMapColor = textureCubeUV\( envMap, envMapRotation \* reflectVec, roughness \);\s*return envMapColor\.rgb \* envMapIntensity;/,
        `vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
			vec3 skyVec = normalize( vec3( reflectVec.x, max( reflectVec.y, 0.15 ), reflectVec.z ) );
			vec3 sky = textureCubeUV( envMap, envMapRotation * skyVec, roughness ).rgb;
			float soft = 0.02 + 0.6 * roughness * roughness;
			float above = smoothstep( - soft, soft, reflectVec.y );
			vec3 seen = mix( envMapColor.rgb * 0.3, mix( sky, envMapColor.rgb, smoothstep( 0.15, 0.4, reflectVec.y ) ), above );
			seen *= 1.0 + 1.4 * exp( - pow( reflectVec.y / ( 0.04 + soft ), 2.0 ) ) * above;
			return seen * envMapIntensity;`,
      ),
    );
  };
  m.customProgramCacheKey = () => 'heli-paint-horizon';
  return m;
}

/** The model's shade is baked into its vertex colours (as the Teslas'): the opaque materials multiply it in. */
const shaded = { vertexColors: true } as const;
/** The lamps: one material, each lamp glowing in its own vertex colour, brighter at night (never over the car's light bar). */
function lampMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.6, roughness: 0.2, ...shaded });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;');
  };
  m.customProgramCacheKey = () => 'heli-lamp';
  return m;
}
/** The model's materials (helishots.mjs dresses it the same way for its pictures); the paint is each machine's own. */
const SHARED: Record<string, THREE.Material> = {
  Glass: new THREE.MeshStandardMaterial({ color: '#16201c', roughness: 0.04, metalness: 0.25, transparent: true, opacity: 0.38, depthWrite: false, envMapIntensity: 1.4 }),
  Trim: new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.6, ...shaded }),
  Metal: new THREE.MeshStandardMaterial({ color: '#8d9097', roughness: 0.38, metalness: 0.85, ...shaded }),
  Interior: new THREE.MeshStandardMaterial({ color: '#45484d', roughness: 0.8, ...shaded }),
  Screen: new THREE.MeshBasicMaterial({ ...shaded }),
  Lamp: lampMaterial(),
};
/** The stand-in's: plain colours (its boxes have no vertex colours, which would draw them black). */
const STAND: Record<string, THREE.Material> = {
  Glass: SHARED.Glass,
  Trim: new THREE.MeshStandardMaterial({ color: '#16171a', roughness: 0.6 }),
  Metal: new THREE.MeshStandardMaterial({ color: '#8d9097', roughness: 0.38, metalness: 0.85 }),
};
const gapLines = new THREE.LineBasicMaterial({ color: '#000000', transparent: true, opacity: 0.55, depthWrite: false });

type DiscMaterial = THREE.MeshBasicMaterial & { userData: { phase: { value: number } } };
/**
 * A rotor's blur: a flat ring, see-through, darker towards its tips with four faint sweeps that turn slowly (a few
 * shader lines: radius and angle from the position, no texture). The main disc lies in its local XZ plane, the tail's
 * in its local YZ plane (docs/helicopter/README.md): two programs. `opacity` follows the rotor's speed.
 */
/** The blur discs' colour in daylight; unlit, it is darkened with the light (Heli.update), so at night it is no paler than the sky. */
const DISC = new THREE.Color('#16181b');

function discMaterial(plane: 'xz' | 'yz', outer: number): DiscMaterial {
  const m = new THREE.MeshBasicMaterial({ color: DISC, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const phase = { value: 0 };
  m.userData.phase = phase;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.discPhase = phase;
    shader.uniforms.discOuter = { value: outer };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDisc;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvDisc = position.${plane};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDisc;\nuniform float discPhase;\nuniform float discOuter;')
      .replace('#include <opaque_fragment>', `float discR = length( vDisc ) / discOuter;
        float discA = atan( vDisc.y, vDisc.x );
        float sweep = 0.8 + 0.2 * sin( discA * 4.0 + discPhase );
        diffuseColor.a *= ( 0.45 + 0.55 * smoothstep( 0.1, 0.8, discR ) ) * sweep * ( 1.0 - smoothstep( 0.96, 1.0, discR ) );
        diffuseColor.a += 0.3 * opacity * ( smoothstep( 0.88, 0.93, discR ) - smoothstep( 0.96, 1.0, discR ) );
        #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => `heli-disc-${plane}`;
  return m as DiscMaterial;
}

/** The shadow's stand-in writes nothing in the views (no colour, no depth): only its shadow shows. */
const SHADOW_ONLY = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/**
 * The near model's shadow in one draw: its casters (the paint, the glass, the trim) merged, positions only, into one
 * mesh that casts the shadow and shows nothing itself; the parts cast none. Not on a layer of its own: three's shadow
 * pass tests the layers of the view's camera, not the light's, so a shadow-only layer would cast in reflections only.
 */
function shadowProxy(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.castShadow || o instanceof THREE.InstancedMesh) return;
    o.castShadow = false;
    if (!o.visible || !o.geometry.getAttribute('position')) return; // emptied by the merge (it only holds children)
    const src = o.geometry;
    const g = new THREE.BufferGeometry();
    const pos = src.getAttribute('position');
    g.setAttribute('position', new THREE.Float32BufferAttribute(Array.from({ length: pos.count * 3 }, (_, i) => pos.getComponent(Math.floor(i / 3), i % 3)), 3));
    g.setIndex(src.index ? Array.from(src.index.array) : Array.from({ length: pos.count }, (_, i) => i));
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    parts.push(g);
  });
  const merged = parts.length ? mergeGeometries(parts) : null;
  if (!merged) return;
  // With normals its shadow pass uses the depth program every other caster has (made at the start); without them it
  // needed one of its own, made at its first shadow on High (a 15 to 90 ms stall in the landing).
  merged.computeVertexNormals();
  const proxy = new THREE.Mesh(merged, SHADOW_ONLY);
  proxy.name = 'ShadowProxy';
  proxy.castShadow = true;
  proxy.userData.ignoreRay = true;
  proxy.raycast = () => {};
  root.add(proxy);
}

/** A placeholder material by the model's name, swapped for the game's (dress). */
const named = (name: string) => new THREE.MeshStandardMaterial({ name });

/**
 * The stand-in, only when the model can't be loaded: boxes and rings of the interface's sizes (heli.json `size`, as
 * built) with its node names and pivots, as carShape stands in for a car. Nose to -Z, origin on the ground under the hub.
 */
export function heliShape(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Scene';
  root.userData.standIn = true;
  const body = new THREE.Group();
  body.name = 'Body';
  const box = (w: number, h: number, l: number, x: number, y: number, z: number, mat: string) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), named(mat));
    m.position.set(x, y, z);
    body.add(m);
    return m;
  };
  const c = SIZE.cabin;
  const cabinL = c.z1 - c.z0;
  const shell = 2.45 - c.y0; // the shell's top (the cowling rises over it)
  // The cabin: a body box, the glass of the nose in front, the engines' cowling on its roof.
  box(c.halfX * 2, shell, cabinL - 1.3, 0, c.y0 + shell / 2, c.z0 + 1.3 + (cabinL - 1.3) / 2, 'Paint');
  box(c.halfX * 2 - 0.1, shell - 0.3, 1.3, 0, c.y0 + 0.2 + (shell - 0.3) / 2, c.z0 + 0.65, 'Glass');
  box(c.halfX * 2 - 0.12, 0.35, 1.3, 0, c.y0 + 0.17, c.z0 + 0.65, 'PaintB');
  box(1.2, 0.4, 1.68, 0, 2.65, 0.28, 'PaintB');
  box(c.halfX * 2 + 0.02, 0.5, 1.4, 0, 1.55, -0.6, 'Glass'); // the side windows of the doors
  // The tail boom, its fin, the stabiliser and the shroud round the tail rotor.
  const b = SIZE.boom;
  const tr = SIZE.tailRotor;
  box(0.45, 0.5, tr.z - b.z0 - 0.4, 0, 1.65, b.z0 + (tr.z - b.z0 - 0.4) / 2, 'Paint');
  box(0.16, b.y1 - 2.3, 0.9, 0, (b.y1 + 2.3) / 2, b.z1 - 0.5, 'Paint');
  const st = SIZE.stabiliser;
  box(st.halfX * 2, 0.06, st.z1 - st.z0 - 0.4, 0, 1.53, (st.z0 + st.z1) / 2, 'Paint');
  const shroud = new THREE.Mesh(new THREE.TorusGeometry(tr.r + 0.08, 0.12, 8, 24).rotateY(Math.PI / 2), named('Paint'));
  shroud.position.set(0, tr.y, tr.z);
  body.add(shroud);
  // The skids: two tubes, flat from z -2.11 to +0.71, on two cross tubes.
  const [[, z0], , [, z1]] = SIZE.skids;
  for (const x of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, z1 - z0 + 0.4, 8).rotateX(Math.PI / 2), named('Metal'));
    skid.position.set(x * SIZE.skids[1][0], 0.05, (z0 + z1) / 2);
    body.add(skid);
  }
  for (const z of [z0 + 0.6, z1 - 0.3]) {
    const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, SIZE.skids[1][0] * 2, 6).rotateZ(Math.PI / 2), named('Metal'));
    cross.position.set(0, 0.32, z);
    body.add(cross);
  }
  root.add(body);
  // The main rotor: a hub and four blades from their roots, on a mast leaning 5 degrees forward.
  const rotor = new THREE.Group();
  rotor.name = 'Rotor';
  rotor.position.set(0, SIZE.rotor.y, 0);
  rotor.rotation.x = -0.087;
  rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.35, 10), named('Metal')));
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Group();
    blade.name = `Blade_${i + 1}`;
    blade.rotation.y = (i * Math.PI) / 2;
    blade.add(new THREE.Mesh(new THREE.BoxGeometry(SIZE.rotor.r - 0.25, 0.04, 0.29).translate(0.25 + (SIZE.rotor.r - 0.25) / 2, 0, 0), named('Trim')));
    rotor.add(blade);
  }
  root.add(rotor);
  // The blur discs in the model's planes: the main one in its local XZ plane, the tail's in its local YZ plane.
  const disc = new THREE.Mesh(new THREE.RingGeometry(0.6, SIZE.rotor.r, 48, 1).rotateX(-Math.PI / 2), named('RotorBlur'));
  disc.name = 'RotorDisc';
  disc.position.copy(rotor.position);
  disc.rotation.x = rotor.rotation.x;
  root.add(disc);
  const tail = new THREE.Group();
  tail.name = 'TailRotor';
  tail.position.set(0, tr.y, tr.z);
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, tr.r * 2 - 0.05, 0.09), named('Metal'));
    m.rotation.x = (i * Math.PI) / 5;
    tail.add(m);
  }
  root.add(tail);
  const tailDisc = new THREE.Mesh(new THREE.RingGeometry(0.12, tr.r, 24, 1).rotateY(Math.PI / 2), named('RotorBlur'));
  tailDisc.name = 'TailDisc';
  tailDisc.position.copy(tail.position);
  root.add(tailDisc);
  // The points the game and the people aboard use (docs/helicopter/README.md).
  const empty = (name: string, x: number, y: number, z: number) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    root.add(o);
  };
  empty('Eye_Pilot', SIZE.eye[0], SIZE.eye[1], SIZE.eye[2]);
  empty('Step_L', SIZE.steps[0][0], 0, SIZE.steps[0][1]);
  empty('Step_R', SIZE.steps[1][0], 0, SIZE.steps[1][1]);
  for (const [i, [x, z]] of [[0.37, -1.28], [-0.37, -1.28], [0.37, 0.55], [-0.37, 0.55], [0.37, -0.5], [-0.37, -0.5]].entries()) empty(`Seat_${i}`, x, SIZE.seat, z);
  for (const name of ['Detail', 'Far']) {
    const o = new THREE.Group();
    o.name = name;
    root.add(o);
  }
  return root;
}

/** The model, fetched once: the real one (a binary glTF), else null (the stand-in is used). */
let model: Promise<THREE.Group | null> | null = null;
export function heliModel(): Promise<THREE.Group | null> {
  model ??= fetch(MODEL)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => {
      // A dev server answers a missing file with the page: only a binary glTF ("glTF") is the model.
      if (!buf || buf.byteLength < 12 || new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'glTF') return null;
      return new GLTFLoader().parseAsync(buf, '/models/').then((g) => g.scene);
    })
    .catch(() => null);
  return model;
}

/**
 * The meshes under `nodes` of `root`, merged into one geometry per material as it is drawn (DRAWN_AS), in `root`'s
 * frame, and taken off their nodes (the nodes stay, as anchors). The gaps go black and each lamp takes its colour in
 * its vertices, so they share the trim's and the lamps' draws.
 */
function mergeByMaterial(root: THREE.Object3D, meshes: THREE.Mesh[]): Map<string, THREE.BufferGeometry> {
  root.updateMatrixWorld(true);
  const into = root.matrixWorld.clone().invert();
  const parts = new Map<string, THREE.BufferGeometry[]>();
  for (const m of meshes) {
    const name = (m.material as THREE.Material).name;
    const as = DRAWN_AS[name] ?? name;
    const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(into, m.matrixWorld));
    const colour = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (colour && (name === 'Gap' || name in LAMPS)) {
      const c = new THREE.Color(name === 'Gap' ? '#000000' : LAMPS[name]);
      for (let i = 0; i < colour.count; i++) colour.setXYZ(i, c.r, c.g, c.b);
    }
    (parts.get(as) ?? parts.set(as, []).get(as)!).push(g);
    if (m.children.length) {
      // A node that carries anchors (a stick's grip): it stays, empty and hidden.
      m.geometry = new THREE.BufferGeometry();
      m.visible = false;
      m.userData.ignoreRay = true;
    } else m.removeFromParent();
  }
  const out = new Map<string, THREE.BufferGeometry>();
  for (const [as, list] of parts) {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (merged) out.set(as, merged);
  }
  return out;
}

/** A soft round shadow under the machine at any height, so the height shows without real-time shadows. */
function contactShadow(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, color: '#000000' });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
  m.userData.ignoreRay = true;
  return m;
}

export class Heli {
  /** It hit something (sparks, dust or leaves and a crunch by what it was: world/crash.ts via main.ts). */
  static onHit: (hit: CrashHit) => void = () => {};
  readonly group = new THREE.Group();
  readonly s: HeliState;
  /** Where it stands when nobody flies it */
  readonly park: { x: number; y: number; z: number; yaw: number };
  /** Someone else flies it (together: seat 0 as the server has it), or null */
  pilot: string | null = null;
  /** You fly it */
  flown = false;
  /**
   * Together (src/heliPilot.ts): the server's. Unless you fly it, it is drawn where the ticks say, a little behind the
   * server's clock (net/track.ts, as a car someone else drives): it neither falls nor goes home by itself here.
   */
  remote = false;
  /** You ride along in it (a passenger seat, together) */
  riding = false;
  /** At rest as the server has it (its `g`) */
  private rest = true;
  private track = new Track<number>([false, false, false, true, false, false, false], 30); // x, y, z, yaw, pitch, roll, rotor; the data: at rest
  private got = [0, 0, 0, 0, 0, 0, 0];
  /** s since you jumped out of it (it flies itself home: shared/heli.mjs AWAY), or null */
  away: number | null = null;
  /** After a jump and watched too long: flying off, away from `from` (the eye) and up through the ceiling (AWAY) */
  leaving = false;
  private from = new THREE.Vector3();
  private keep = { fwd: 0, side: 0 };
  /** Who sits in its four seats (Seat_0 the pilot's, 1 beside it, 2 and 3 behind): a name ('' for you alone) or null (world/heliPeople.ts) */
  readonly seats: (string | null)[] = [null, null, null, null];
  private seatAt = [0, 1, 2, 3].map((i) => new THREE.Vector3(i % 2 ? -0.37 : 0.37, SIZE.seat, i < 2 ? -1.28 : 0.55));
  /** In the game (drawn, solid, boardable): once its model is in (or, failing that, the stand-in) */
  ready = false;
  /** The view a little wider at speed (main.ts multiplies the field of view by it). */
  fovScale = 1;
  /** 'chase' behind it, or 'cockpit' from the pilot's seat */
  view: 'chase' | 'cockpit' = 'chase';
  private body = new THREE.Group();
  private shadow = contactShadow();
  private near: THREE.Object3D | null = null;
  private far: THREE.Object3D | null = null;
  private detail: THREE.Object3D | null = null;
  private rotor: THREE.Object3D | null = null;
  /** The blades' nodes (their transforms) and, on the model, their instanced meshes (one per material) */
  private blades: THREE.Object3D[] = [];
  private bladeMeshes: THREE.InstancedMesh[] = [];
  private tail: THREE.Object3D | null = null;
  private disc: THREE.Mesh | null = null;
  private tailDisc: THREE.Mesh | null = null;
  private discMat = discMaterial('xz', SIZE.rotor.r);
  private tailMat = discMaterial('yz', SIZE.tailRotor.r);
  private paint: Record<string, { fine: THREE.MeshStandardMaterial; plain: THREE.MeshStandardMaterial; stand: THREE.MeshStandardMaterial }> = {};
  private eye = new THREE.Vector3(...(SIZE.eye as [number, number, number]));
  /** The boarding steps on the plan (the model's Step_L and Step_R): x right, z back */
  private steps: [number, number][] = SIZE.steps.map(([x, z]) => [x, z] as [number, number]);
  private key: string;
  private noise = new HeliSound();
  private spin = 0;
  private tailSpin = 0;
  private strikes: number[] = [];
  private struckAt = 0;
  private leavesAt = 0;
  private clock = 0;
  private warmOn = false;
  // The camera.
  private camHeading = 0;
  private camTilt = 0;
  private camLand = 0;
  private lookIdle = 0;
  private lookPitch = 0;
  /** The look round (the mouse, the right stick, a drag): rad from straight behind it (chase) or ahead (the pilot's seat) */
  private lookYaw = 0;
  // The trees' crowns by 32 m square, built when the list grows.
  private crownCells = new Map<number, Crown[]>();
  private crownCount = -1;

  constructor(private world: World, private crowns: Crown[], readonly spec: HeliSpec, private skipCrown: (x: number, z: number) => boolean = () => false) {
    this.park = { ...spec.park };
    this.s = heliStart(spec.park);
    this.key = `heli-${spec.id}`;
    const colours = HELIS.paints[spec.paint as keyof typeof HELIS.paints] ?? HELIS.paints.evening;
    const paint = (c: string) => ({
      fine: horizonReflection(new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2, ...shaded })),
      plain: horizonReflection(new THREE.MeshStandardMaterial({ color: c, roughness: 0.18, envMapIntensity: 1.6, ...shaded })),
      stand: new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, envMapIntensity: 1.4 }),
    });
    this.paint = { Paint: paint(colours.paint), PaintB: paint(colours.paintB), PaintC: paint(colours.paintC) };
    this.group.add(this.body, this.shadow);
    this.group.userData.heli = spec.id;
    this.body.rotation.order = 'YXZ';
    machines.add(this);
    void heliModel().then((scene) => {
      this.dress(scene ? scene.clone() : heliShape());
      this.ready = true;
    });
    this.pose();
  }

  /** The model (or the stand-in) on the body with the game's materials; its moving parts found by name. */
  private dress(scene: THREE.Object3D): void {
    const stand = !!scene.userData.standIn;
    const far = scene.getObjectByName('Far') ?? null;
    if (far) far.removeFromParent();
    // The discs don't belong to the near model: they show with the far copy too.
    this.disc = (scene.getObjectByName('RotorDisc') as THREE.Mesh | undefined) ?? null;
    this.tailDisc = (scene.getObjectByName('TailDisc') as THREE.Mesh | undefined) ?? null;
    this.rotor = scene.getObjectByName('Rotor') ?? null;
    this.blades = [1, 2, 3, 4].map((i) => scene.getObjectByName(`Blade_${i}`)).filter((b): b is THREE.Object3D => !!b);
    for (const b of this.blades) b.userData.baseZ ??= b.rotation.z;
    if (!stand) {
      // The parts that don't move: one mesh per material (the doors' and sticks' nodes stay as anchors; open a door
      // later and its meshes come back from the file).
      const statics: THREE.Mesh[] = [];
      for (const name of STATIC) scene.getObjectByName(name)?.traverse((o) => o instanceof THREE.Mesh && statics.push(o));
      for (const [mat, g] of mergeByMaterial(scene, statics)) scene.add(Object.assign(new THREE.Mesh(g, named(mat)), { name: `Body_${mat}` }));
      // The rotor head: its own meshes (not the blades') merged likewise, the rubber with the trim.
      if (this.rotor) {
        const head = this.rotor.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
        for (const [mat, g] of mergeByMaterial(this.rotor, head)) this.rotor.add(Object.assign(new THREE.Mesh(g, named(mat)), { name: `Head_${mat}` }));
      }
      // The blades: they share one mesh in the file; drawn as one instanced mesh per material, placed from their nodes.
      const first = this.blades[0];
      if (first && this.rotor) {
        const meshes: THREE.Mesh[] = [];
        first.traverse((o) => o instanceof THREE.Mesh && meshes.push(o));
        this.bladeMeshes = meshes.map((m) => {
          const g = m.geometry.clone().applyMatrix4(m.matrix);
          const inst = new THREE.InstancedMesh(g, named((m.material as THREE.Material).name), this.blades.length);
          inst.frustumCulled = false;
          inst.name = `Blades_${(m.material as THREE.Material).name}`;
          return inst;
        });
        for (const b of this.blades) for (const m of [...b.children]) if (m instanceof THREE.Mesh) m.removeFromParent();
        for (const inst of this.bladeMeshes) this.rotor.add(inst);
      }
    }
    const prep = (root: THREE.Object3D) => root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const name = (o.material as THREE.Material).name;
        o.userData.part = name;
        if (name === 'RotorBlur') return;
        o.material = (name.startsWith('Paint') ? this.paintFor(name, stand) : stand ? STAND[name] ?? STAND.Trim : SHARED[name] ?? SHARED.Trim) as THREE.Material;
        o.castShadow = SHADOW_PARTS.has(name);
        o.userData.material = name === 'Glass' ? 'black_glass' : 'steel'; // bullets spark off it
        o.userData.vehicle = true;
        if (name === 'Glass') o.renderOrder = 1;
      } else if (o instanceof THREE.LineSegments) {
        o.material = gapLines;
        o.raycast = () => {};
      }
    });
    prep(scene);
    shadowProxy(scene);
    this.near = scene;
    this.body.add(scene);
    for (const [d, mat] of [[this.disc, this.discMat], [this.tailDisc, this.tailMat]] as const) {
      if (!d) continue;
      this.body.attach(d); // out of the near model, where it was
      d.material = mat;
      d.castShadow = false;
      d.renderOrder = 2;
      d.userData.ignoreRay = true;
    }
    this.far = far && far.children.length ? far : null;
    if (this.far) {
      prep(this.far);
      this.far.traverse((o) => (o.castShadow = false)); // from 45 or 90 m off: no shadow pass of its own (the contact shadow stays)
      this.far.visible = false;
      this.body.add(this.far);
    }
    this.detail = scene.getObjectByName('Detail') ?? null;
    this.tail = scene.getObjectByName('TailRotor') ?? null;
    const eye = scene.getObjectByName('Eye_Pilot');
    if (eye) this.eye.copy(eye.position);
    const steps = ['Step_L', 'Step_R'].map((n) => scene.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
    if (steps.length === 2) this.steps = steps.map((o) => [o.position.x, o.position.z]);
    this.seatAt.forEach((v, i) => v.copy(scene.getObjectByName(`Seat_${i}`)?.position ?? v));
  }

  /** The hip point of seat `i` (0 to 3) in the model's frame (world/heliPeople.ts). */
  seatPoint(i: number): THREE.Vector3 {
    return this.seatAt[i];
  }

  /** The model's frame in the world while its near model is drawn (the people aboard sit in it: world/heliPeople.ts), else null. */
  cabin(m: THREE.Matrix4): THREE.Matrix4 | null {
    if (!this.ready || !this.group.visible || !this.near?.visible) return null;
    this.body.updateMatrix();
    return m.multiplyMatrices(this.group.matrixWorld, this.body.matrix);
  }

  /** A paint material for the model's `name` (Paint, PaintB, PaintC), fine or plain for the preset; the stand-in's own. */
  private paintFor(name: string, stand: boolean): THREE.Material {
    const p = this.paint[name] ?? this.paint.Paint;
    return stand ? p.stand : lowDetail ? p.plain : p.fine;
  }

  /** The paint for the graphics preset (setHeliDetail). */
  dressPaint(): void {
    const stand = !!this.near?.userData.standIn;
    for (const root of [this.near, this.far]) root?.traverse((o) => {
      if (o instanceof THREE.Mesh && typeof o.userData.part === 'string' && o.userData.part.startsWith('Paint')) o.material = this.paintFor(o.userData.part, stand);
    });
  }

  private get forward(): [number, number] {
    return [-Math.sin(this.s.yaw), -Math.cos(this.s.yaw)];
  }

  /** How far a point on the plan is from the cabin's sides (0 inside), for getting in. */
  distanceTo(x: number, z: number): number {
    if (!this.ready) return Infinity;
    const [fx, fz] = this.forward;
    const c = SIZE.cabin;
    const mid = -(c.z0 + c.z1) / 2; // the cabin's middle ahead of the hub
    const dx = x - (this.s.x + fx * mid);
    const dz = z - (this.s.z + fz * mid);
    return Math.hypot(Math.max(0, Math.abs(dx * fx + dz * fz) - (c.z1 - c.z0) / 2), Math.max(0, Math.abs(-dx * fz + dz * fx) - SIZE.skidX));
  }

  /** Its outline on the plan: the cabin over the skids and the tail boom (the minimap, its block). */
  footprint(): [number, number][] {
    const [fx, fz] = this.forward;
    const [rx, rz] = [-fz, fx];
    const c = SIZE.cabin;
    const b = SIZE.boom;
    const w = SIZE.skidX;
    const at = (x: number, z: number): [number, number] => [this.s.x + rx * x - fx * z, this.s.z + rz * x - fz * z];
    return [at(-w, c.z0), at(w, c.z0), at(w, c.z1), at(b.halfX, c.z1), at(b.halfX, b.z1), at(-b.halfX, b.z1), at(-b.halfX, c.z1), at(-w, c.z1)];
  }

  /** At rest: on a floor, or resting on its boom or cabin (a roof's edge, a wall's top) held up there. Never a hover. */
  get atRest(): boolean {
    return this.s.ground || this.s.still > HELI.REST;
  }

  /**
   * Left where nobody can walk to it (main.ts can't reach it with the use key): at rest but not on a pad nor on open
   * ground, so on a roof, a wall's top, a deck, in water, or in a private home's garden.
   */
  get stranded(): boolean {
    const s = this.s;
    if (this.flown || this.pilot || !this.atRest) return false;
    if (!s.ground) return true; // resting on its boom or cabin (on a rail, a roof's edge): never left so, on a pad or not
    if (this.atHome) return false; // on its own pad; on another machine's it is away
    if (HELIS.pads.some((p) => Math.hypot(s.x - p.x, s.z - p.z) < 3 && Math.abs(s.y - p.y) < 1.5)) return true;
    const bare = this.world.groundAt(s.x, s.z, -1e4, 0).y; // the land itself, under anything built
    const water = waterLevel(s.x, s.z);
    return Math.abs(s.y - bare) > 1.2 || (water !== null && water > s.y - 0.3) || homeAt(s.x, s.z, s.y + 1) !== null || inEndGarden(s.x, s.z, s.y);
  }

  /** s it has been stranded (world/heli.ts update): after LOST_AFTER it goes back to its pad by itself. */
  private lost = 0;

  /** Within 3 m of its own pad, at its height. */
  get atHome(): boolean {
    return Math.hypot(this.s.x - this.park.x, this.s.z - this.park.z) < 3 && Math.abs(this.s.y - this.park.y) < 1.5;
  }

  /** Another machine on this one's own pad, or null. */
  private squatter(): Heli | null {
    for (const m of machines) if (m !== this && m.ready && Math.hypot(m.s.x - this.park.x, m.s.z - this.park.z) < 6 && Math.abs(m.s.y - this.park.y) < 3) return m;
    return null;
  }

  /**
   * Back on its own pad (its rotor running down there, so it sounds as it comes back). Not while someone stands there.
   * Another machine standing on that pad first goes to its own (the two swap when each is on the other's); one being
   * flown there, or one whose own pad is taken by a third, holds it back (it waits: false).
   */
  sendHome(eye: THREE.Vector3 | null = null): boolean {
    const p = this.park;
    if (eye && Math.hypot(eye.x - p.x, eye.z - p.z) < 7) return false;
    const other = this.squatter();
    if (other) {
      const theirs = other.squatter();
      if (other.flown || other.pilot || (theirs && theirs !== this)) return false;
      other.goHome();
    }
    this.goHome();
    return true;
  }

  private goHome(): void {
    const p = this.park;
    this.lost = 0;
    this.place(p.x, this.world.groundAt(p.x, p.z, p.y + 2, 0).y, p.z, p.yaw, Math.max(this.s.rotor, 0.8));
    this.s.engine = false;
  }

  /** Whether you may get out now: at rest on anything, or within 1.5 m of a floor and slow. */
  get canLeave(): boolean {
    return this.atRest || (this.s.h < 1.5 && Math.hypot(this.s.vx, this.s.vz) < 1.5 && Math.abs(this.s.vy) < 1.5);
  }

  /**
   * Where you stand after getting out (shared/heli.mjs heliExit): by a step, behind it, before or behind the machine, on
   * the floor it stands on and free; else at the hub on that floor. Never lower than that floor, never inside a private
   * home or the end house's garden. Null: nowhere (you stay aboard).
   */
  exitSpot(): { x: number; y: number; z: number } | null {
    const ground = (x: number, z: number, top: number) => this.world.groundAt(x, z, top, 0).y;
    const free = (x: number, z: number, feet: number) => this.world.boxFree(x, z, 0, 0.3, 0.3, feet + 0.4, feet + 1.8, this.key);
    return heliExit(this.s, this.steps, ground, free);
  }

  /** You got in: the camera starts behind it. */
  enter(name = ''): void {
    this.flown = true;
    this.riding = false;
    this.away = null;
    this.leaving = false;
    this.seats[0] = name;
    this.track.clear(); // together: its states from before are not drawn again once you get out
    this.ride();
  }

  /** In a passenger seat (together), or at the stick: the camera starts behind it. */
  ride(): void {
    if (!this.flown) this.riding = true;
    this.camHeading = this.s.yaw;
    this.camTilt = 0;
    this.lookPitch = 0;
    this.camLand = this.s.h < 15 ? 1 : 0;
    this.view = 'chase';
    this.lookYaw = 0;
  }

  /** Behind it, or the pilot's view: the look starts straight again (a cut, not an ease). */
  switchView(): void {
    this.view = this.view === 'chase' ? 'cockpit' : 'chase';
    this.lookYaw = 0;
    this.lookPitch = 0;
  }

  /** Dev: the look round (rad): yaw from straight behind or ahead, the pilot's tilt, seconds without a look. */
  get look(): { yaw: number; pitch: number; idle: number } {
    return { yaw: this.lookYaw, pitch: this.lookPitch, idle: this.lookIdle };
  }

  /**
   * The look round, a frame: `pan` and `tilt` (rad) from the mouse, the right stick or a drag; after LOOK_BACK s
   * without one it eases back, the ease itself eased in over a second (no jerk). Returns the share to ease back by.
   */
  private lookRound(d: number, pan: number, tilt: number): number {
    this.lookYaw = angle(this.lookYaw - pan);
    this.lookIdle = pan || tilt ? 0 : this.lookIdle + d;
    return 1 - Math.exp(-d * 1.5 * smooth(LOOK_BACK, LOOK_BACK + 1, this.lookIdle));
  }

  /**
   * You got out: the engine stops and the rotor runs down. Off a floor (just over one, or hovering when you are taken
   * out: a respawn, a join) it is set down on the floor below, without a bump; resting on its boom or cabin it stays
   * where it rests. `home`: back on its own pad (a game starting).
   */
  leave(home = false): void {
    this.flown = false;
    this.riding = false;
    this.seats[0] = null;
    this.track.clear(); // together: the server's next states start from here
    const s = this.s;
    const rotor = s.rotor;
    if (home && this.sendHome()) s.rotor = rotor; // its own pad (another machine there going to its own first)
    else if (!this.atRest) heliPlace(s, s.x, s.floor, s.z, s.yaw, s.rotor);
    s.engine = false;
    s.coll = 0;
    s.down = 0;
  }

  /**
   * You jumped out (src/heliPilot.ts): nobody aboard, it flies itself home (shared/heli.mjs AWAY): the engine keeps
   * running, it climbs away keeping the way it flew for a moment, then eases to a hover, still climbing, until the
   * pilot's code puts it back on its pad.
   */
  jumpedFrom(): void {
    this.flown = false;
    this.seats[0] = null; // nobody left seated (world/heliPeople.ts)
    this.away = 0;
    this.leaving = false;
    this.keep = awayKeep(this.s);
  }

  /** Flying off (AWAY): full forward and full up, the nose turned away from where `eye` was when it set off. */
  private flyOff(eye: THREE.Vector3): HeliInput {
    if (!this.from.lengthSq()) this.from.copy(eye);
    const want = Math.atan2(-(this.s.x - this.from.x), -(this.s.z - this.from.z));
    return { fwd: 1, lift: 1, turn: Math.max(-1, Math.min(1, -angle(want - this.s.yaw) * 2)) };
  }

  /** Watched too long after a jump: it flies off (AWAY), drawn out to AWAY.far. */
  flyAway(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.from.set(0, 0, 0);
  }

  /** Put somewhere (a dev hook): still on the floor at (x, y, z) facing `yaw`, its rotor at `rotor` (and running with it). */
  place(x: number, y: number, z: number, yaw: number, rotor = 0): void {
    this.away = null;
    this.leaving = false;
    heliPlace(this.s, x, y, z, yaw, rotor);
    this.camHeading = yaw;
    this.pose();
  }

  /** Together, out of it with nothing changed: it stays where it is and the server's next states move it. */
  release(): void {
    if (this.flown) this.track.clear(); // its states from before you took the stick are not drawn again
    this.flown = false;
    this.riding = false;
  }

  /** Who sits in its seats, from the server (a name, null for an empty seat); seat 0 flies it. */
  setSeats(seats: readonly (string | null)[]): void {
    for (let i = 0; i < this.seats.length; i++) this.seats[i] = seats[i] ?? null;
    this.pilot = this.seats[0];
  }

  /** Together: the floor the page has under a machine the server has at rest at height `y` (its skids on the page's own meadow, deck or roof). */
  private settled(x: number, y: number, z: number): number {
    const f = this.world.groundAt(x, z, y + 1, 0).y;
    return Math.abs(f - y) < 1 ? f : y;
  }

  /** A tick (together): where it was at the server's time `t`, and who sits in it. The machine you fly keeps its own flight. */
  sample(t: number, v: HeliView): void {
    this.setSeats(v.seats);
    this.rest = v.g === 1;
    if (this.flown) return;
    this.track.push(t, [v.x, v.y, v.z, v.yaw, v.p, v.r, v.n], v.g, false, !v.seats[0]);
  }

  /** There at once, as the server has it (joining, a flight home): at rest on the page's floor, else hanging there. */
  snap(v: HeliView): void {
    this.setSeats(v.seats);
    this.rest = v.g === 1;
    if (this.flown) return;
    this.track.clear();
    this.away = null;
    this.leaving = false;
    if (v.g === 1) heliPlace(this.s, v.x, this.settled(v.x, v.y, v.z), v.z, v.yaw, v.seats[0] ? v.n : 0);
    else heliHover(this.s, v.x, v.y, v.z, v.yaw);
    this.camHeading = v.yaw;
    this.pose();
  }

  /** Your flight from the server's pose (taking the stick, or the server put your step back): at rest standing there, else a steady hover. */
  takeOver(v: HeliView): void {
    if (v.g === 1) heliPlace(this.s, v.x, this.settled(v.x, v.y, v.z), v.z, v.yaw, this.s.rotor);
    else heliHover(this.s, v.x, v.y, v.z, v.yaw);
    this.pose();
  }

  /**
   * A frame of a machine somebody else flies, or nobody (together): its pose from the track; at rest as the server says,
   * its floor the page's (the shadow, the height for the sound and the camera), its speed from how it moved. The rotor
   * as its pilot has it; without one it runs down at rest and keeps turning while it hangs in the air.
   */
  private follow(dt: number): void {
    const s = this.s;
    if (this.track.at(netClock.time, this.got)) {
      const [x, y0, z, yaw, pitch, roll, rotor] = this.got;
      const rest = (this.track.shown ?? (this.rest ? 1 : 0)) === 1;
      const y = rest ? this.settled(x, y0, z) : y0;
      if (Math.hypot(x - s.x, y - s.y, z - s.z) > 30) s.vx = s.vy = s.vz = 0; // back on its pad, or just in sight: no speed from the jump
      else if (dt > 0) {
        const k = 1 - Math.exp(-dt * 8);
        s.vx += ((x - s.x) / dt - s.vx) * k;
        s.vy += ((y - s.y) / dt - s.vy) * k;
        s.vz += ((z - s.z) / dt - s.vz) * k;
      }
      Object.assign(s, { x, y, z, yaw, pitch, roll, ground: rest });
      if (this.pilot) s.rotor = rotor;
    } else s.vx = s.vy = s.vz = 0;
    if (!this.pilot) s.rotor = s.ground ? Math.max(0, s.rotor - Math.max(0, dt) / HELI.SPOOL_DOWN) : 1;
    s.floor = this.world.groundAt(s.x, s.z, s.y + HELI.STEP_UP, 0).y;
    s.h = Math.max(0, s.y - s.floor);
    s.coll = s.ground ? 0 : 0.5;
    s.engine = s.rotor > 0 && (!s.ground || !!this.pilot);
    this.pose();
  }

  /** The world round it for a step: floors (water and people's heads too), the ceiling, the wind, the edge, a pad. */
  private env(others: Obstacle[]): HeliEnv {
    const w = windAt(this.s.x, this.s.z);
    const ground = (x: number, z: number, top: number) => {
      let y = this.world.groundAt(x, z, top, 0).y;
      const water = waterLevel(x, z);
      if (water !== null && water > y && water <= top) y = water;
      // Nobody is landed on: over a person the floor is just above their head.
      for (const o of others) if (Math.hypot(o.x - x, o.z - z) < o.r + 0.4) y += 2.1;
      return y;
    };
    const edge = this.world.bounds?.nearest(this.s.x, this.s.z, HELI.EDGE_PAD) ?? null;
    const pad = padNear(this.s.x, this.s.z, HELI.MAGNET_R + 1);
    return { ground, ceiling: this.leaving ? Infinity : this.world.skyAt(this.s.x, this.s.z), wind: [w.x, w.z], edge, pad };
  }

  /**
   * One frame of flight (`input` from heliPilot.ts, or none when nobody flies it and it is still running down):
   * sub-steps at 120 a second with the fuselage against the walls each, then the rotor's rim and the tree crowns.
   * Returns how hard it hit something this frame (m/s), 0 if it didn't.
   */
  fly(dt: number, input: HeliInput, others: Obstacle[] = []): number {
    if (!(dt > 0) || !this.ready) return 0;
    const s = this.s;
    s.ev = 0;
    s.hit = 0;
    const env = this.env(others);
    const steps = Math.min(48, Math.max(1, Math.ceil(dt * 120)));
    const h = Math.min(dt, 0.4) / steps;
    let impact = 0;
    for (let i = 0; i < steps; i++) {
      const was = { x: s.x, y: s.y, z: s.z };
      heliStep(s, input, env, h);
      impact = Math.max(impact, this.walls(was));
    }
    this.clock += dt;
    impact = Math.max(impact, this.rim(dt), this.crownsAt(dt));
    if (s.ev & (EV.BUMP | EV.SETTLE | EV.BOUNCE)) impact = Math.max(impact, s.hit);
    this.events();
    this.pose();
    return impact;
  }

  /** The cabin's, the tail boom's and the stabiliser's boxes clear of the walls at (x, z) and its height now. */
  private free(x: number, z: number): boolean {
    const s = this.s;
    const [fx, fz] = this.forward;
    const box = (b: { halfX: number; z0: number; z1: number; y0: number; y1: number }, lift = true) => {
      const mid = -(b.z0 + b.z1) / 2;
      const rise = lift ? Math.sin(s.pitch) * -mid : 0; // nose down, the tail rises
      return this.world.boxFree(x + fx * mid, z + fz * mid, s.yaw, (b.z1 - b.z0) / 2, b.halfX, s.y + b.y0 + rise, s.y + b.y1 + rise, this.key);
    };
    return box(SIZE.cabin, false) && box(SIZE.boom) && box(SIZE.stabiliser);
  }

  /** After a step from `was`: against a wall it stops on that axis and bounces back a little; hard, a bump. */
  private walls(was: { x: number; y: number; z: number }): number {
    const s = this.s;
    s.held = false;
    // Up into a slab or a roof's underside over the rotor's head: the climb stops.
    const over = this.world.ceilingAbove(s.x, s.z, 1, was.y + SIZE.cabin.y1, s.y + SIZE.rotor.y + 0.4);
    if (over !== null && s.y + SIZE.rotor.y + 0.4 > over) {
      s.y = Math.min(s.y, over - SIZE.rotor.y - 0.4);
      s.vy = Math.min(0, s.vy);
    }
    if (this.free(s.x, s.z)) return 0;
    let impact: number;
    const [vx, vz] = [s.vx, s.vz];
    if (this.free(s.x, was.z)) {
      impact = Math.abs(vz);
      s.z = was.z;
      s.vz *= -0.3;
    } else if (this.free(was.x, s.z)) {
      impact = Math.abs(vx);
      s.x = was.x;
      s.vx *= -0.3;
    } else {
      impact = Math.hypot(vx, vz);
      s.x = was.x;
      s.z = was.z;
      s.vx *= -0.3;
      s.vz *= -0.3;
      if (!this.free(s.x, s.z)) {
        // It sank onto something its skids don't stand on (a roof under its boom, a wall's top under its cabin): it
        // rests there, still (shared/heli.mjs counts its time down and lets it start or be left).
        s.y = Math.max(s.y, was.y);
        s.vy = Math.max(0, s.vy);
        if (Math.hypot(s.vx, s.vz) < 0.5) s.vx = s.vz = 0;
        // On another machine it is held off, never at rest: nobody lands on a parked machine (nor gets out up there).
        s.held = !this.world.touching(s.x, s.z, s.y - 0.4, s.y + 0.4, 2.5, this.key)?.key?.startsWith('heli-');
      }
    }
    if (impact > 0.5) this.contact(vx, vz, impact);
    if (impact > HELI.BODY_HARD && s.down <= 0) heliBump(s, impact);
    return impact;
  }

  /** Where it touched going along (vx, vz), what is there, for the sparks or dust. */
  private contact(vx: number, vz: number, speed: number): void {
    const s = this.s;
    const v = Math.hypot(vx, vz) || 1;
    const [dx, dz] = [vx / v, vz / v];
    const x = s.x + dx * 2.4, z = s.z + dz * 2.4;
    const at = this.world.touching(x, z, s.y + 0.3, s.y + 3.5, 0.9, this.key);
    Heli.onHit({ x, y: s.y + 1.3, z, nx: -dx, nz: -dz, speed, what: at?.key ?? at?.mat ?? at?.name ?? '' });
    this.noise.thump(x, s.y, z, speed);
  }

  /** The rotor disc's rim against the world, eight points round it: pushed away, slowed, sparks; often or hard, a bump. */
  private rim(dt: number): number {
    const s = this.s;
    if (s.rotor < 0.3 || !this.ready) return 0;
    const [fx, fz] = this.forward;
    const [rx, rz] = [-fz, fx];
    const hubY = s.y + SIZE.rotor.y;
    const R = SIZE.rotor.r * 0.97;
    let hit: { x: number; y: number; z: number; what: string } | null = null;
    for (let k = 0; k < 8 && !hit; k++) {
      const a = (k * Math.PI) / 4;
      const ahead = Math.cos(a) * R, right = Math.sin(a) * R;
      const x = s.x + fx * ahead + rx * right;
      const z = s.z + fz * ahead + rz * right;
      const y = hubY - ahead * Math.sin(s.pitch) - right * Math.sin(s.roll);
      const t = this.world.touching(x, z, y - 0.2, y + 0.2, 0.4, this.key);
      if (t) hit = { x, y, z, what: t.key ?? t.mat ?? t.name ?? '' };
    }
    if (!hit) return 0;
    // Away from it, and 60 % of the speed towards it gone.
    let ax = s.x - hit.x, az = s.z - hit.z;
    const d = Math.hypot(ax, az) || 1;
    ax /= d;
    az /= d;
    const towards = -(s.vx * ax + s.vz * az);
    if (towards > 0) {
      s.vx += ax * towards * 1.6;
      s.vz += az * towards * 1.6;
    }
    s.x += ax * Math.min(0.2, 3 * dt);
    s.z += az * Math.min(0.2, 3 * dt);
    if (this.clock - this.struckAt < 0.4) return 0; // one strike per touch
    this.struckAt = this.clock;
    this.strikes = this.strikes.filter((t) => this.clock - t < HELI.STRIKE_WINDOW);
    this.strikes.push(this.clock);
    Heli.onHit({ x: hit.x, y: hit.y, z: hit.z, nx: ax, nz: az, speed: Math.max(3, towards), what: hit.what || 'steel' });
    this.noise.rattle(hit.x, hit.y, hit.z);
    if ((towards > HELI.STRIKE_HARD || this.strikes.length >= HELI.STRIKES) && s.down <= 0) {
      heliBump(s, towards);
      this.strikes = [];
    }
    return Math.max(2, towards);
  }

  /** The tree crowns (air, not blocks): inside one the speed bleeds away, it is pushed out and leaves fly. No bump. */
  private crownsAt(dt: number): number {
    const s = this.s;
    if (this.crownCount !== this.crowns.length) this.indexCrowns();
    const R = SIZE.rotor.r;
    let worst = 0;
    const i0 = Math.floor((s.x - R - 20) / 32), i1 = Math.floor((s.x + R + 20) / 32);
    const j0 = Math.floor((s.z - R - 20) / 32), j1 = Math.floor((s.z + R + 20) / 32);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const c of this.crownCells.get(i * 100003 + j) ?? []) {
          const d = Math.hypot(c.x - s.x, c.z - s.z);
          if (d > c.r + R * 0.85) continue;
          const lo = c.y + 0.35 * c.h, hi = c.y + c.h;
          // The rotor's height over the crown's middle, or the cabin's span across it.
          const inRotor = s.y + SIZE.rotor.y > lo && s.y + SIZE.rotor.y < hi + 0.2;
          const inCabin = d < c.r + 1.2 && s.y + 0.3 < hi && s.y + SIZE.cabin.y1 > lo;
          if (!inRotor && !inCabin) continue;
          if (this.skipCrown(c.x, c.z)) continue;
          const keep = Math.exp(-0.92 * dt); // 60 % a second
          s.vx *= keep;
          s.vz *= keep;
          const ax = (s.x - c.x) / (d || 1), az = (s.z - c.z) / (d || 1);
          s.x += ax * 2 * dt;
          s.z += az * 2 * dt;
          worst = Math.max(worst, 1);
          if (this.clock - this.leavesAt > 0.3) {
            this.leavesAt = this.clock;
            const px = s.x - ax * Math.min(d, R * 0.8), pz = s.z - az * Math.min(d, R * 0.8);
            Heli.onHit({ x: px, y: Math.min(hi - 0.5, s.y + SIZE.rotor.y), z: pz, nx: ax, nz: az, speed: 3 + Math.hypot(s.vx, s.vz) * 0.3, what: 'hedge' });
          }
        }
      }
    }
    return worst;
  }

  private indexCrowns(): void {
    this.crownCells.clear();
    for (const c of this.crowns) {
      const k = Math.floor(c.x / 32) * 100003 + Math.floor(c.z / 32);
      let cell = this.crownCells.get(k);
      if (!cell) this.crownCells.set(k, (cell = []));
      cell.push(c);
    }
    this.crownCount = this.crowns.length;
  }

  /** The step's events heard and seen: a touchdown's thump, a bump's clang and sparks. */
  private events(): void {
    const s = this.s;
    if (s.ev & (EV.SETTLE | EV.BOUNCE)) this.noise.thump(s.x, s.y, s.z, Math.max(1, s.hit));
    if (s.ev & EV.BUMP) {
      this.noise.clang(s.x, s.y, s.z);
      this.noise.thump(s.x, s.y, s.z, 10);
      if (s.ground) Heli.onHit({ x: s.x, y: s.y + 0.1, z: s.z, nx: 0, nz: 0, speed: Math.max(6, s.hit), what: 'steel' });
    }
  }

  /**
   * The camera behind it: from CAM_DIST behind (further with speed) and CAM_SIDE to the right, CAM_PITCH down, following the nose and, at
   * speed, the way it flies; looking up a little in a climb and down in a descent, so the landing spot comes into
   * view by itself. The horizon stays level (the machine is seen banking). Low and slow it comes nearer and steeper.
   * Walls and the tower pull it in; pulled in close it rises to look down on the machine. `tilt` and `pan` (rad) from
   * the mouse, the right stick or a drag swing it round the machine (looking round); it comes back behind by itself.
   */
  chase(camera: THREE.PerspectiveCamera, dt: number, tilt: number, pan = 0): void {
    const s = this.s;
    const d = Math.min(Math.max(dt, 0), 0.1);
    const speed = Math.hypot(s.vx, s.vz);
    const path = Math.atan2(-s.vx, -s.vz);
    const heading = s.yaw + 0.7 * smooth(10, 18, speed) * angle(path - s.yaw);
    this.camHeading += angle(heading - this.camHeading) * (1 - Math.exp(-d * HELI.CAM_FOLLOW));
    this.camTilt = Math.max(-0.25, Math.min(0.9, this.camTilt + tilt));
    const back = this.lookRound(d, pan, tilt);
    this.camTilt -= this.camTilt * back;
    this.lookYaw -= this.lookYaw * back;
    const low = s.h < 15 && speed < 8 ? 1 : 0;
    this.camLand += (low - this.camLand) * (1 - Math.exp(-d * 1.2));
    const climb = Math.max(-0.2, Math.min(0.2, -0.4 * Math.atan(s.vy / Math.max(speed, 4))));
    const [landDist, landPitch] = HELI.CAM_LAND;
    const dist = (HELI.CAM_DIST + HELI.CAM_SPEED * speed) * (1 - this.camLand) + landDist * this.camLand;
    let pitch = HELI.CAM_PITCH * (1 - this.camLand) + landPitch * this.camLand + climb + this.camTilt;
    const target = { x: s.x, y: s.y + HELI.CAM_UP, z: s.z };
    const h = this.camHeading + this.lookYaw;
    const side = HELI.CAM_SIDE * (1 - this.camLand); // a little to its right: its side and livery show, not only the fin
    const at = (p: number) => ({
      x: target.x + Math.sin(h) * Math.cos(p) * dist + Math.cos(h) * side,
      y: target.y + Math.sin(p) * dist,
      z: target.z + Math.cos(h) * Math.cos(p) * dist - Math.sin(h) * side,
    });
    let want = at(pitch);
    let k = this.world.clearance(target, want, this.key);
    if (k * dist < 5) {
      // Pulled in close (beside the tower): up, to look down on the machine rather than at the brick.
      pitch += (0.9 - pitch) * Math.min(1, (5 - k * dist) / 5);
      want = at(pitch);
      k = this.world.clearance(target, want, this.key);
    }
    k = Math.max(0.15, k - 0.3 / dist);
    camera.position.set(target.x + (want.x - target.x) * k, target.y + (want.y - target.y) * k, target.z + (want.z - target.z) * k);
    const floor = this.world.groundAt(camera.position.x, camera.position.z, camera.position.y, 0).y;
    if (camera.position.y < floor + 0.4) camera.position.y = floor + 0.4;
    camera.lookAt(target.x, target.y, target.z);
    if (!CALM && s.shake > 0.01) {
      const t = this.clock;
      camera.rotation.x += (Math.sin(t * 37) + Math.sin(t * 23)) * 0.004 * s.shake;
      camera.rotation.y += Math.sin(t * 29) * 0.004 * s.shake;
    }
    const wide = CALM ? 0 : smooth(20, 45, speed);
    this.fovScale += (1 + 0.12 * wide - this.fovScale) * (1 - Math.exp(-d * 1.5));
  }

  /**
   * The view from the pilot's seat (Eye_Pilot), turning and leaning with the machine; `tilt` and `pan` turn the head, up to
   * 40 degrees up, 60 down and 110 to each side (out of the side windows, down at a landing spot). Turned to the side it
   * comes back ahead by itself; looking down it stays (a landing from the seat with a still mouse). With `seat` (1 to 3,
   * a passenger together) from that seat instead: SEAT_EYE over its hip point, at most SEAT_YAW to either side.
   */
  cockpit(camera: THREE.PerspectiveCamera, dt: number, tilt: number, pan = 0, seat = 0): void {
    const d = Math.min(Math.max(dt, 0), 0.1);
    const side = seat > 0 ? SEAT_YAW : HEAD.yaw;
    this.lookPitch = Math.max(-HEAD.down, Math.min(HEAD.up, this.lookPitch + tilt));
    const back = this.lookRound(d, pan, tilt);
    this.lookYaw = Math.max(-side, Math.min(side, this.lookYaw));
    this.lookYaw -= this.lookYaw * back;
    this.body.updateMatrixWorld(true);
    const hip = seat > 0 ? this.seatAt[seat] : undefined;
    const at = hip ? _eye.set(hip.x, hip.y + SEAT_EYE, hip.z) : this.eye;
    camera.position.copy(at).applyMatrix4(this.body.matrixWorld);
    const s = this.s;
    // The head turns in the cabin: the machine's lean, then the look.
    _seat.setFromEuler(_euler.set(CALM ? 0 : -s.pitch, s.yaw, CALM ? 0 : -s.roll, 'YXZ'));
    camera.quaternion.copy(_seat).multiply(_head.setFromEuler(_euler.set(this.lookPitch, this.lookYaw, 0, 'YXZ')));
    this.fovScale += (1 - this.fovScale) * (1 - Math.exp(-Math.min(dt, 0.1) * 1.5));
    this.camHeading = s.yaw;
  }

  /** The machine's transform from its flight state. */
  private pose(): void {
    const s = this.s;
    this.body.position.set(s.x, s.y, s.z);
    this.body.rotation.set(-s.pitch, s.yaw, -s.roll, 'YXZ');
  }

  /** Dev and the warm-up: every part drawn (the discs, the blades, the far copy too) so their shaders are made before play. */
  warm(on: boolean): void {
    this.warmOn = on;
    if (on) {
      this.noise.warm(); // its sound's nodes made once too
      this.discMat.opacity = this.tailMat.opacity = 0.01;
      this.discMat.visible = this.tailMat.visible = true;
      if (this.far) this.far.visible = true;
    }
  }

  /**
   * Every frame: when nobody flies it and its rotor still turns (or it hangs in the air), it runs down by itself; then
   * the rotor, the discs, the far copy, the shadow, its block in the world and its sound. Drawn within DRAW m of `eye`.
   */
  update(dt: number, eye: THREE.Vector3): void {
    const s = this.s;
    if (this.remote && !this.flown) this.follow(dt); // together: where the server has it (it decides the flights home)
    else {
      if (this.away !== null && dt > 0) this.away += dt;
      if (!this.flown && dt > 0 && (s.rotor > 0 || !s.ground)) this.fly(dt, this.away === null ? {} : this.leaving ? this.flyOff(eye) : awayInput(this.away, this.keep));
      // Left where nobody can reach it: back on its pad after a while.
      this.lost = this.stranded ? this.lost + dt : 0;
      if (this.lost > LOST_AFTER) this.sendHome(eye);
    }
    const away = Math.hypot(s.x - eye.x, s.z - eye.z, s.y - eye.y);
    this.group.visible = this.ready && (away < (this.leaving ? AWAY.far : DRAW) || this.warmOn);
    const farOn = !!this.far && !this.warmOn && away > (lowDetail ? FAR_LOW : FAR) && !this.flown && !this.riding;
    if (this.far && this.near) {
      this.far.visible = farOn || this.warmOn;
      this.near.visible = !farOn;
    }
    if (this.detail) this.detail.visible = away < DETAIL || this.warmOn;
    // The rotor: its blades turn (no faster on screen than SPIN_STEP a frame), cone up with the thrust, droop at rest;
    // the disc's blur from 45 % of its speed, the blades gone by 60 %.
    const r = s.rotor;
    this.spin = (this.spin + Math.min(r * RPM * dt, SPIN_STEP)) % (Math.PI * 2);
    this.tailSpin = (this.tailSpin + Math.min(r * TAIL_RPM * dt, SPIN_STEP * 1.3)) % (Math.PI * 2);
    if (this.rotor) this.rotor.rotation.y = this.spin; // anticlockwise seen from above
    if (this.tail) this.tail.rotation.x = this.tailSpin;
    const cone = -0.052 + 0.096 * Math.min(1, r * r * (0.5 + s.coll));
    const showBlades = r < BLADES_UNTIL || this.warmOn;
    this.blades.forEach((b, i) => {
      b.rotation.z = (b.userData.baseZ as number) + cone;
      b.visible = showBlades;
      if (this.bladeMeshes.length) {
        b.updateMatrix();
        for (const m of this.bladeMeshes) m.setMatrixAt(i, b.matrix);
      }
    });
    for (const m of this.bladeMeshes) {
      m.instanceMatrix.needsUpdate = true;
      m.visible = showBlades;
    }
    if (this.tail) this.tail.visible = r < BLADES_UNTIL || this.warmOn;
    const blur = smooth(0.45, 0.75, r);
    if (!this.warmOn) {
      this.discMat.opacity = 0.55 * blur;
      this.tailMat.opacity = 0.6 * blur;
      this.discMat.visible = this.tailMat.visible = blur > 0.01;
    }
    this.discMat.userData.phase.value = (this.discMat.userData.phase.value + dt * 3) % (Math.PI * 2);
    // The discs follow the light (they are unlit): at night a faint dark blur, never a pale one against the sky.
    const light = 1 - 0.9 * mood.night;
    this.discMat.color.copy(DISC).multiplyScalar(light);
    this.tailMat.color.copy(DISC).multiplyScalar(light);
    // The lamps glow brighter as it darkens (never over the cars' light bars).
    (SHARED.Lamp as THREE.MeshStandardMaterial).emissiveIntensity = 0.6 + 1.4 * mood.night;
    // The shadow on the floor below, bigger and fainter the higher it is.
    const h = Math.max(0, s.y - s.floor);
    const size = 7 + h * 0.12;
    this.shadow.position.set(s.x, s.floor + 0.03, s.z);
    this.shadow.scale.set(size, 1, size);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.55 * Math.max(0.12, 1 - h / 60);
    this.shadow.visible = h < 120;
    // Its block: nobody walks through a machine that stands; while it flies it is no wall.
    this.world.setMoving(this.key, this.ready && s.ground ? this.footprint() : null, s.y, s.y + SIZE.boom.y1);
    // Its sound (world/heliSound.ts), a touch muffled from the pilot's seat.
    this.noise.update({ x: s.x, y: s.y, z: s.z, rotor: this.group.visible ? r : 0, coll: s.coll, sink: -s.vy, air: Math.hypot(s.vx, s.vz), inside: (this.flown || this.riding) && this.view === 'cockpit' });
  }

  /** Dev: whether its sound loop is running. */
  get soundOn(): boolean {
    return this.noise.playing;
  }

  /** Dev: the meshes it draws now (the near model, its far copy, the discs, the shadow), for the draw-call count. */
  draws(): number {
    let n = 0;
    this.group.traverseVisible((o) => {
      if ((o instanceof THREE.Mesh || o instanceof THREE.LineSegments) && (o.material as THREE.Material).visible !== false) n++;
    });
    return n;
  }

  dispose(): void {
    machines.delete(this);
    this.group.removeFromParent();
    this.world.setMoving(this.key, null);
    this.noise.dispose();
  }
}
