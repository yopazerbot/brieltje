import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { looseProps, type Place } from './looseProps';
import type { V3 } from './rigid';
import { painted } from './yard';

/**
 * The waste containers put out along the village's streets (Yoshi: "research which ones are used in
 * Smetlede and model them exactly"). Lede's waste is collected by ILvA: one grey container for the
 * residual waste (240, 140 or 40 L) and one green one for GFT (140 or 40 L) per household, each weighed
 * by its chip; paper goes out in boxes and PMD in blue bags. Our own models at ILvA's published sizes
 * (tools/wheelie_bin.py, public/models/wheelie-bins.glb): the body and lid white, tinted here per
 * container.
 *
 * They stand by the letterbox at the front of one plot in four, on the verge, the handle turned to the
 * street as ILvA asks. Most are 140 L, grey or green; some households have the big grey 240 L, a few
 * the portable 40 L. Each is loose (world/looseProps.ts): a car knocks it over, you push it on foot.
 */

/** One letterbox in this many gets a container beside it (0: none). */
export const BIN_EVERY = 4;

/** The colours of ILvA's containers: grey for the residual waste, green for GFT (HDPE, satin). */
const GREY = '#50565b';
const GREEN = '#3d6b39';

interface Size {
  /** Its object in the GLB */
  model: string;
  /** Published outside measures (m): height, width, depth */
  h: number;
  w: number;
  d: number;
  /** Empty (kg) */
  mass: number;
  wheels: boolean;
}

const SIZES: Record<'bin240' | 'bin140' | 'bin40', Size> = {
  bin240: { model: 'Bin240', h: 1.06, w: 0.58, d: 0.72, mass: 13, wheels: true },
  bin140: { model: 'Bin140', h: 1.08, w: 0.51, d: 0.56, mass: 11, wheels: true },
  bin40: { model: 'Bin40', h: 0.51, w: 0.5, d: 0.34, mass: 4, wheels: false },
};
type Kind = keyof typeof SIZES;

/** Out of a hundred households: which container stands out, and its colour. */
const MIX: [number, Kind, string][] = [
  [16, 'bin240', GREY],
  [54, 'bin140', GREY],
  [93, 'bin140', GREEN],
  [97, 'bin40', GREY],
  [100, 'bin40', GREEN],
];

/** Where it touches the ground or a wall lying any way (its own frame, the handle's side +z): feet, wheels, handle, lid. */
function points(s: Size): V3[] {
  const { h, w, d } = s;
  const lid: V3[] = [[-w / 2, h, -d / 2 + 0.012], [w / 2, h, -d / 2 + 0.012], [-w / 2, h - 0.06, -d / 2], [w / 2, h - 0.06, -d / 2]];
  if (!s.wheels) {
    return [...lid, [-w / 2 + 0.04, 0, -d / 2 + 0.06], [w / 2 - 0.04, 0, -d / 2 + 0.06], [-w / 2 + 0.04, 0, d / 2 - 0.08], [w / 2 - 0.04, 0, d / 2 - 0.08],
      [-w / 2, h - 0.01, d / 2 - 0.03], [w / 2, h - 0.01, d / 2 - 0.03]];
  }
  // As tools/wheelie_bin.py builds them: 200 mm wheels 3 cm in from the sides, their axle 13 cm in from the handle.
  const xw = w / 2 - 0.0075;
  const za = d / 2 - 0.13;
  const zf = -(d / 2 - 0.018 - (s === SIZES.bin240 ? 0.07 : 0.055) - 0.07);
  const xf = w / 2 - 0.058 - 0.055;
  return [
    ...lid,
    [-xf, 0, zf], [xf, 0, zf], // the feet
    [-xw, 0, za], [xw, 0, za], [-xw, 0.1, za + 0.1], [xw, 0.1, za + 0.1], // the wheels
    [-(w / 2 - 0.035), h - 0.012, d / 2], [w / 2 - 0.035, h - 0.012, d / 2], // the handle's ends
    [-w / 2, h, d / 2 - 0.055], [w / 2, h, d / 2 - 0.055], // the lid at its hinge
  ];
}

let job: Promise<Map<string, THREE.BufferGeometry> | null> | null = null;

/** The three models as one geometry each (vertex colours), fetched once; null if they can't be. */
export function loadWheelieBins(): Promise<Map<string, THREE.BufferGeometry> | null> {
  return (job ??= new GLTFLoader().loadAsync('/models/wheelie-bins.glb').then(
    (gltf) => new Map(Object.values(SIZES).flatMap((s) => {
      const o = gltf.scene.getObjectByName(s.model);
      return o ? [[s.model, painted(o)] as [string, THREE.BufferGeometry]] : [];
    })),
    () => null,
  ));
}

/**
 * Put the containers out: beside one letterbox in BIN_EVERY (x, z, its slot's turn to the street), on
 * whichever side is clear, a little nearer the street than the letterbox. `groundAt`: the ground there.
 */
export function placeWheelieBins(models: Map<string, THREE.BufferGeometry> | null, boxes: [number, number, number][], groundAt: (x: number, z: number) => number): void {
  if (!models || !BIN_EVERY) return;
  const at = new Map<Kind, Place[]>();
  boxes.forEach(([x, z, yaw], i) => {
    if (i % BIN_EVERY !== 1) return;
    const roll = ((i * 2654435761) >>> 0) % 100;
    const [, kind, color] = MIX.find(([upTo]) => roll < upTo)!;
    const s = SIZES[kind];
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    // 0.8 m along the plot's front, 0.15 m towards the street (the letterbox stands 0.9 m in from it);
    // where neither side is clear there, as far back from the letterbox's line.
    const spots = [[1, 0.15], [-1, 0.15], [1, -0.15], [-1, -0.15]];
    const turn = yaw + (((i * 7919) % 13) / 13 - 0.5) * 0.3;
    const spot = spots.map(([side, out]) => [x + c * 0.8 * side + sn * out, z - sn * 0.8 * side + c * out])
      .find(([bx, bz]) => looseProps.free(bx, bz, turn, s.w + 0.06, s.d + 0.08, groundAt(bx, bz) + 0.15, groundAt(bx, bz) + s.h));
    if (!spot) return;
    let list = at.get(kind);
    if (!list) at.set(kind, (list = []));
    list.push({ x: spot[0], y: groundAt(spot[0], spot[1]), z: spot[1], yaw: turn, color });
  });
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 });
  for (const [kind, places] of at) {
    const s = SIZES[kind];
    const geometry = models.get(s.model);
    if (!geometry) continue;
    const pts = points(s);
    looseProps.add(kind, {
      // On its wheels it rolls more than it slides: pushed at a walk it goes, it doesn't tip.
      geometry, material, tag: 'plastic', mode: 'rigid', sound: 'plastic', mass: s.mass, push: 1, bounce: 0.3, friction: s.wheels ? 0.3 : 0.55, tinted: true,
      points: pts, edges: pts.filter((p) => p[1] > s.h - 0.1),
      // Its weight low, as an empty one's is (the floor, the wheels and the steel axle): its middle at 0.42 of its height.
      box: [[-s.w / 2, 0, -s.d / 2], [s.w / 2, s.h * 0.84, s.d / 2]],
    }, places);
  }
}
