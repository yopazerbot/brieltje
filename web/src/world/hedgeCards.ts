import * as THREE from 'three';
import type { Prism } from './houseData';
import { Spray, sprayRect } from './cardTrees';
import { cardsBuilt, leafCardMaterial } from './leafCards';
import { reflectionSkips } from './reflections';
import { terrain } from './terrain';

/**
 * Leaves sticking out of the clipped hedges on Medium and up: sprigs of the leaf cards (world/leafCards.ts) all
 * over their sides and along their tops, so a hedge's outline is ragged with leaves and its sides have depth,
 * instead of a box with a picture of leaves on it. The box stays, behind them, as the hedge's dense inside.
 *
 * Two small shapes, a patch of a hedge's side (a metre along and a metre up, its sprigs leaning out and up) and a
 * patch of its top (a metre along, the sprigs standing up out of it), each copied over every hedge: there are
 * kilometres of hedge, so the patches are drawn only in the tiles round the eye (world/tiles.ts Piece `lod`).
 */

const GREEN = new THREE.Color('#56602f');

let shapes: { side: THREE.BufferGeometry; top: THREE.BufferGeometry } | null = null;
const material = leafCardMaterial(0.04, 0.02, false, 0.35);
reflectionSkips.materials.add(material); // the reflections leave the sprigs out (world/reflections.ts)

const random = (seed: number) => {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
};

/** A patch of sprigs: `n` cards from `foot()` along `lean()`, `size` across, normals leaning out of the hedge. */
function patch(n: number, seed: number, foot: (r: () => number) => THREE.Vector3, lean: (r: () => number, at: THREE.Vector3) => THREE.Vector3, size: number, normal: THREE.Vector3): THREE.BufferGeometry {
  const rand = random(seed);
  const [u0, v0, s] = sprayRect(Spray.Broad);
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const at = foot(rand);
    const along = lean(rand, at).normalize();
    const other = Math.abs(along.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const across = other.cross(along).normalize().applyAxisAngle(along, (rand() - 0.5) * 2.4);
    const k = size * (0.8 + rand() * 0.4);
    const half = across.multiplyScalar(k / 2);
    const tip = along.multiplyScalar(k);
    const corners = [at.clone().sub(half), at.clone().add(half), at.clone().add(half).add(tip), at.clone().sub(half).add(tip)];
    const uvs = [[u0, v0], [u0 + s, v0], [u0 + s, v0 + s], [u0, v0 + s]];
    const first = pos.length / 3;
    // Darker at the sprig's foot, deep in the hedge, and lower down.
    const tone = 0.85 + rand() * 0.3;
    corners.forEach((p, k2) => {
      pos.push(p.x, p.y, p.z);
      nor.push(normal.x, normal.y, normal.z);
      uv.push(uvs[k2][0], uvs[k2][1]);
      c.copy(GREEN).multiplyScalar(tone * (k2 < 2 ? 0.6 : 1) * (0.8 + 0.2 * Math.min(1, Math.max(0, p.y))));
      col.push(c.r, c.g, c.b);
    });
    idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * The two patches, in their own space: x along the hedge (0 to 1), y up, z out of its side (the side patch, y 0 to
 * 1 up the side) or across its top (the top patch, z -0.5 to 0.5 across, y 0 on the top).
 */
function patches(): { side: THREE.BufferGeometry; top: THREE.BufferGeometry } {
  shapes ??= {
    side: patch(16, 4711, (r) => new THREE.Vector3(r(), r() * 0.92, -0.1), (r) => new THREE.Vector3((r() - 0.5) * 0.6, 0.3 + r() * 0.4, 0.75 + r() * 0.3), 0.3, new THREE.Vector3(0, 0.35, 1).normalize()),
    top: patch(10, 815, (r) => new THREE.Vector3(r(), -0.12, (r() - 0.5) * 0.85), (r, at) => new THREE.Vector3((r() - 0.5) * 0.4, 0.9, at.z * 0.9 + (r() - 0.5) * 0.3), 0.34, new THREE.Vector3(0, 1, 0)),
  };
  return shapes;
}

/** The copies of the patches over a set of hedge blocks (their outline on the map, from y0 to y1, over the relief if draped). */
export function hedgeCardPlaces(prisms: Prism[]): { side: THREE.Matrix4[]; top: THREE.Matrix4[] } {
  const side: THREE.Matrix4[] = [];
  const top: THREE.Matrix4[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3();
  const z = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  for (const p of prisms) {
    const ring = p.p[0] as [number, number][];
    if (ring.length < 3) continue;
    const height = p.y1 - p.y0;
    if (height < 0.4) continue;
    // A block draped over the relief has its heights over the ground there (world/houseMeshes.ts).
    const lift = (x: number, z: number) => (p.d ? terrain.height(x, z) : 0);
    const cx = ring.reduce((s, q) => s + q[0], 0) / ring.length;
    const cz = ring.reduce((s, q) => s + q[1], 0) / ring.length;
    let longest = 0;
    let width = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      const len = Math.hypot(bx - ax, bz - az);
      longest = Math.max(longest, len);
      width = Math.min(width, len);
      if (len < 0.3) continue;
      // Out of the hedge: across the edge, away from its middle.
      z.set(bz - az, 0, -(bx - ax)).normalize();
      if (z.x * ((ax + bx) / 2 - cx) + z.z * ((az + bz) / 2 - cz) < 0) z.negate();
      x.crossVectors(up, z);
      const forward = x.x * (bx - ax) + x.z * (bz - az) > 0;
      const [sx, sz] = forward ? [ax, az] : [bx, bz];
      const n = Math.max(1, Math.round(len));
      const rows = Math.max(1, Math.round((height - 0.15) / 0.9));
      const l = len / n;
      const h = (height - 0.15) / rows;
      basis.makeBasis(x, up, z);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < rows; j++) {
          const m = basis.clone().scale(new THREE.Vector3(l, h, 1));
          const px = sx + x.x * l * i;
          const pz = sz + x.z * l * i;
          m.setPosition(px, p.y0 + 0.15 + h * j + lift(px + x.x * l * 0.5, pz + x.z * l * 0.5), pz);
          side.push(m);
        }
      }
    }
    // Along the top, down the middle of the hedge's long way.
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < longest - 1e-6) continue;
      x.set(bx - ax, 0, bz - az).normalize();
      z.crossVectors(x, up);
      // The middle line: from this long edge in by half the width, towards the hedge's middle.
      const inward = z.x * (cx - ax) + z.z * (cz - az) > 0 ? 1 : -1;
      const ox = ax + z.x * inward * (width / 2);
      const oz = az + z.z * inward * (width / 2);
      const n = Math.max(1, Math.round(len));
      const l = len / n;
      basis.makeBasis(x, up, z);
      for (let k = 0; k < n; k++) {
        const m = basis.clone().scale(new THREE.Vector3(l, 1, Math.max(0.3, width)));
        const px = ox + x.x * l * k;
        const pz = oz + x.z * l * k;
        m.setPosition(px, p.y1 + lift(px + x.x * l * 0.5, pz + x.z * l * 0.5), pz);
        top.push(m);
      }
      break;
    }
  }
  return { side, top };
}

/** The sprigs over these hedge blocks as instanced pieces for the tiles (drawn in the tiles round the eye). */
export function hedgeCardPieces(prisms: Prism[]): { material: THREE.Material; geometry: THREE.BufferGeometry; at: THREE.Matrix4[] }[] {
  const hedges = prisms.filter((p) => p.m === 'hedge' || p.m === 'nb_hedge');
  if (!hedges.length || !cardsBuilt()) return []; // never shown on a phone: not built there
  const { side, top } = hedgeCardPlaces(hedges);
  const shape = patches();
  return [
    ...(side.length ? [{ material, geometry: shape.side, at: side }] : []),
    ...(top.length ? [{ material, geometry: shape.top, at: top }] : []),
  ];
}

/** The same as one mesh of its own (the main house's hedges, outside the tiles). */
export function hedgeCardMesh(prisms: Prism[]): THREE.Object3D {
  const group = new THREE.Group();
  for (const { material: m, geometry, at } of hedgeCardPieces(prisms)) {
    const mesh = new THREE.InstancedMesh(geometry, m, at.length);
    at.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.receiveShadow = true;
    mesh.userData.material = 'hedge';
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
