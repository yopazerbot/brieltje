import * as THREE from 'three';
import { alongFace, type FacePoint, type Hole, type WallFace } from './housePlan';

/**
 * Holes in the open-data houses' walls for their windows and doors to sit back in (world/housePlan.ts `planReveals`
 * says which and where): the faces of a wall block that carry holes are cut again round them, with the sides and the
 * top of each hole (the reveal) going back to the frame in the wall's own brick, and a dark back behind the frame for
 * when the frames are too far off to be drawn. Under some sills a faint rain streak: the wall's colour a little darker
 * on a few corners of its own, so it costs no texture and no shader. All of it goes into the wall's own geometry: no
 * draw call is added.
 *
 * A face is cut row by row (a wall with a band at its foot has two rows of faces, which meet along the band's top), each
 * row an outline along its points with the holes in it, so no corner is added to an edge it shares with another face
 * (the corner of the house, the cap on top): no cracks. A door that crosses the band's top is a notch in both rows.
 * `faceShapes` is the cutting in numbers only (world/wallCut.test.mjs checks it); `cutWall` makes the geometry.
 */

/** A face's point with the heights of its foot and top there too (the drawn corners', to the last bit). */
export interface ExactPoint extends FacePoint {
  foot?: number;
  top?: number;
}

/** A corner of a cut face: s along the face, its height, and how much of its streak's darkness it takes (0 to 1). */
export interface Corner {
  s: number;
  y: number;
  dark: number;
  /** The streak it belongs to, if any */
  streak?: { dark: number };
}

interface Row {
  bottom: (q: ExactPoint) => number;
  top: (q: ExactPoint) => number;
}

/** The rows of faces up a wall: one, or the band and the wall over it. */
export function faceRows(f: WallFace): Row[] {
  const foot = (q: ExactPoint) => q.foot ?? f.foot;
  const top = (q: ExactPoint) => q.top ?? f.top;
  if (f.points[0].cut === null) return [{ bottom: foot, top }];
  return [{ bottom: foot, top: (q) => q.cut! }, { bottom: (q) => q.cut!, top }];
}

/** How a hole meets a row: not at all, inside it, or as a notch up from its bottom or down from its top. */
export function holeInRow(f: WallFace, row: Row, h: Hole): 'none' | 'inside' | 'bottom' | 'top' {
  const at = (s: number, g: (q: ExactPoint) => number) => alongFace(f.points, s, g);
  const mid = (h.s0 + h.s1) / 2;
  const [b, t] = [at(mid, row.bottom), at(mid, row.top)];
  if (h.y1 <= b || h.y0 >= t) return 'none';
  if (h.y0 > b && h.y1 < t) return 'inside';
  return h.y0 <= b ? 'bottom' : 'top';
}

/**
 * The triangles of each row of a face with its holes cut out (and the holes' streaks hanging under them as tabs of
 * their own, so their corners can be darker): three corners each, wound to face out.
 */
export function faceShapes(f: WallFace): Corner[][][] {
  return faceRows(f).map((row) => {
    const at = (s: number, g: (q: ExactPoint) => number) => alongFace(f.points, s, g);
    const holes = f.holes.map((h) => ({ h, how: holeInRow(f, row, h) })).filter((x) => x.how !== 'none');
    // The outline: along the bottom and back along the top, with the notches.
    const chain = (side: 'bottom' | 'top'): Corner[] => {
      const notches = holes.filter((x) => x.how === side).map((x) => x.h).sort((u, v) => u.s0 - v.s0);
      const g = row[side];
      const out: Corner[] = [];
      let k = 0;
      for (const q of f.points) {
        while (k < notches.length && notches[k].s0 <= q.s) {
          const h = notches[k++];
          const y = side === 'bottom' ? h.y1 : h.y0;
          out.push({ s: h.s0, y: at(h.s0, g), dark: 0 }, { s: h.s0, y, dark: 0 }, { s: h.s1, y, dark: 0 }, { s: h.s1, y: at(h.s1, g), dark: 0 });
        }
        if (out.length && out[out.length - 1].s >= q.s) continue; // inside a notch
        out.push({ s: q.s, y: g(q), dark: 0 });
      }
      return out;
    };
    const contour = [...chain('bottom'), ...chain('top').reverse()];
    // The holes inside the row, each with its streaks as tabs down from its bottom edge.
    const inner = holes.filter((x) => x.how === 'inside').map(({ h }) => {
      const ring: Corner[] = [{ s: h.s0, y: h.y0, dark: 0 }];
      for (const k of [...h.streaks].sort((u, v) => u.s - v.s)) {
        ring.push({ s: k.s - k.half, y: k.top, dark: 0 }, { s: k.s - 0.8 * k.half, y: k.mid, dark: 0 }, { s: k.s, y: k.bottom, dark: 0 }, { s: k.s + 0.8 * k.half, y: k.mid, dark: 0 }, { s: k.s + k.half, y: k.top, dark: 0 });
      }
      ring.push({ s: h.s1, y: h.y0, dark: 0 }, { s: h.s1, y: h.y1, dark: 0 }, { s: h.s0, y: h.y1, dark: 0 });
      return ring;
    });
    const all = [...contour, ...inner.flat()];
    const v2 = (c: Corner) => new THREE.Vector2(c.s, c.y);
    const tris: Corner[][] = THREE.ShapeUtils.triangulateShape(contour.map(v2), inner.map((r) => r.map(v2))).map((t) => t.map((i) => all[i]));
    // The streaks' own triangles: a fan round a point down their middle.
    for (const { h } of holes) {
      if (holeInRow(f, row, h) !== 'inside') continue;
      for (const k of h.streaks) {
        const streak = { dark: k.dark };
        const c = (s: number, y: number, dark = 0): Corner => ({ s, y, dark, streak });
        // Darkest along the middle of its top (under the sill's front), fading out to its edges and down to its foot.
        const middle = c(k.s, k.mid, 0.6);
        const ring = [c(k.s - k.half, k.top), c(k.s - 0.4 * k.half, k.top, 1), c(k.s + 0.4 * k.half, k.top, 1), c(k.s + k.half, k.top), c(k.s + 0.8 * k.half, k.mid), c(k.s, k.bottom), c(k.s - 0.8 * k.half, k.mid)];
        ring.forEach((a, i) => tris.push([a, ring[(i + 1) % ring.length], middle]));
      }
    }
    // Wound counter-clockwise in (s, y): facing out (d x up = n).
    return tris
      .filter((t) => Math.abs(area2(t)) > 1e-9)
      .map((t) => (area2(t) > 0 ? t : [t[0], t[2], t[1]]));
  });
}

/** Twice the signed area of a triangle in (s, y). */
const area2 = (t: Corner[]) => (t[1].s - t[0].s) * (t[2].y - t[0].y) - (t[2].s - t[0].s) * (t[1].y - t[0].y);

/** The colour at the back of a hole, behind the frame (linear, a byte each): seen only once the frames are no longer drawn. */
const BACK = [22, 24, 27];
/** A hole's sides at the frame, and its top at the frame and at the wall's face, as a share of the wall's colour (less sky reaches in). */
const SIDE = 0.8;
const TOP = 0.7;
const TOP_EDGE = 0.9;

/**
 * A wall block's geometry (not indexed, as world/houseMeshes.ts `prismGeometry` and world/houseTrim.ts `bandedWalls`
 * make it, with its colour and render byte on) with its faces cut for their holes, the holes' reveals and backs added.
 * Every attribute of a new corner is taken from the drawn face where it lies, so the brick's courses, the band and the
 * damp run on as they were. A face whose triangles are not found is left as it is (and goes on `missed`).
 */
export function cutWall(g: THREE.BufferGeometry, faces: WallFace[], missed?: WallFace[]): THREE.BufferGeometry {
  if (g.index) return g;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const names = Object.keys(g.attributes);
  const attrs = names.map((name) => g.attributes[name] as THREE.BufferAttribute);
  const drop = new Uint8Array(pos.count / 3);
  const added: number[][] = names.map(() => []);
  let any = false;
  for (const f0 of faces) {
    const [dx, dz] = f0.d;
    const [nx, nz] = f0.n;
    const O = f0.points[0];
    const end = f0.points[f0.points.length - 1].s;
    const sOf = (i: number) => (pos.getX(i) - O.x) * dx + (pos.getZ(i) - O.z) * dz;
    // The face's triangles: their corners on its plane and along it, facing out.
    const mine: number[] = [];
    for (let t = 0; t < pos.count; t += 3) {
      if (drop[t / 3]) continue;
      let on = true;
      for (let k = 0; k < 3 && on; k++) {
        const s = sOf(t + k);
        on = Math.abs((pos.getX(t + k) - O.x) * nx + (pos.getZ(t + k) - O.z) * nz) < 0.005 && s > -0.002 && s < end + 0.002;
      }
      if (!on) continue;
      const a = new THREE.Vector3().fromBufferAttribute(pos, t);
      const cross = new THREE.Vector3().fromBufferAttribute(pos, t + 1).sub(a).cross(new THREE.Vector3().fromBufferAttribute(pos, t + 2).sub(a));
      if (cross.length() < 1e-9 || (cross.x * nx + cross.z * nz) / cross.length() < 0.9) continue;
      mine.push(t);
    }
    if (!mine.length) {
      missed?.push(f0);
      if (import.meta.env?.DEV) console.warn('wallCut: no face at', O.x.toFixed(1), O.z.toFixed(1));
      continue;
    }
    const banded = O.cut !== null;
    const rowOf = (t: number) => (banded && ![0, 1, 2].some((k) => pos.getY(t + k) > f0.top - 1e-3) ? 0 : banded ? 1 : 0);
    // The face's points as drawn, to the last bit: where each stands, its foot, its cut and its top.
    const points: ExactPoint[] = f0.points.map((q) => {
      const near = (y: number) => {
        let best = -1;
        let miss = 0.003;
        for (const t of mine) {
          for (let k = 0; k < 3; k++) {
            const i = t + k;
            const m = Math.abs(sOf(i) - q.s) * 10 + Math.abs(pos.getY(i) - y);
            if (m < miss) {
              best = i;
              miss = m;
            }
          }
        }
        return best;
      };
      const [foot, top] = [near(f0.foot), near(f0.top)];
      const cut = banded ? near(q.cut!) : -1;
      const xz = foot >= 0 ? foot : top >= 0 ? top : -1;
      return {
        s: q.s,
        x: xz >= 0 ? pos.getX(xz) : q.x,
        z: xz >= 0 ? pos.getZ(xz) : q.z,
        cut: banded ? (cut >= 0 ? pos.getY(cut) : q.cut) : null,
        foot: foot >= 0 ? pos.getY(foot) : f0.foot,
        top: top >= 0 ? pos.getY(top) : f0.top,
      };
    });
    const f: WallFace = { ...f0, points };
    const xAt = (s: number) => alongFace(points, s, (q) => q.x);
    const zAt = (s: number) => alongFace(points, s, (q) => q.z);
    // Every attribute at (s, y) in a row, from the drawn triangle that holds it (or comes nearest).
    const byRow: number[][] = [[], []];
    for (const t of mine) byRow[rowOf(t)].push(t);
    const sample = (row: number, s: number, y: number): number[][] => {
      let best = byRow[row][0] ?? mine[0];
      let worst = -Infinity;
      // Plain numbers in the loop (it runs over every triangle of the face for every corner asked for): small arrays
      // there were the start's biggest maker of garbage, and a phone's start ran out of memory.
      let w0 = 1;
      let w1 = 0;
      let w2 = 0;
      const list = byRow[row].length ? byRow[row] : mine;
      for (let n = 0; n < list.length; n++) {
        const t = list[n];
        const s0 = sOf(t);
        const s1 = sOf(t + 1);
        const s2 = sOf(t + 2);
        const y0 = pos.getY(t);
        const y1 = pos.getY(t + 1);
        const y2 = pos.getY(t + 2);
        const det = (s1 - s0) * (y2 - y0) - (s2 - s0) * (y1 - y0);
        if (Math.abs(det) < 1e-12) continue;
        const b1 = ((s - s0) * (y2 - y0) - (s2 - s0) * (y - y0)) / det;
        const b2 = ((s1 - s0) * (y - y0) - (s - s0) * (y1 - y0)) / det;
        const b0 = 1 - b1 - b2;
        const least = Math.min(b0, b1, b2);
        if (least > worst) {
          best = t;
          worst = least;
          w0 = b0;
          w1 = b1;
          w2 = b2;
        }
      }
      const c = [Math.max(0, w0), Math.max(0, w1), Math.max(0, w2)];
      const sum = c[0] + c[1] + c[2] || 1;
      return attrs.map((a) => {
        const out: number[] = [];
        for (let j = 0; j < a.itemSize; j++) {
          let v = 0;
          for (let k = 0; k < 3; k++) v += (c[k] / sum) * a.array[(best + k) * a.itemSize + j];
          out.push(v);
        }
        return out;
      });
    };
    const iPos = names.indexOf('position');
    const iNor = names.indexOf('normal');
    const iCol = names.indexOf('color');
    const iUv = names.indexOf('uv');
    const iFacade = names.indexOf('facade');
    const put = (v: number[][]) => v.forEach((x, k) => added[k].push(...x));
    const at3 = (s: number, y: number, back = 0) => [xAt(s) - nx * back, y, zAt(s) - nz * back];
    /** A corner on the face (or `back` metres behind it), its attributes from row `row`, facing `normal`. */
    const corner = (row: number, s: number, y: number, normal: number[], back = 0) => {
      const v = sample(row, s, y);
      v[iPos] = at3(s, y, back);
      if (iNor >= 0) v[iNor] = normal;
      return v;
    };
    const face = [nx, 0, nz];
    faceShapes(f).forEach((tris, row) => {
      for (const t of tris) {
        for (const c of t) {
          const v = corner(row, c.s, c.y, face);
          if (c.streak && iCol >= 0) v[iCol] = v[iCol].map((x) => x * (1 - c.streak!.dark * c.dark));
          put(v);
        }
      }
    });
    // The holes' reveals (sides and top, in the wall's brick, back to the frame's face) and their dark backs.
    const rows = faceRows(f);
    const rowAt = (s: number, y: number) => (rows.length > 1 && y > alongFace(points, s, (q) => q.cut!) ? 1 : 0);
    /** Less of the sky reaches into a hole: its sides darker towards the frame, its top more (a byte or a float colour alike). */
    const shade = (v: number[][], k: number) => {
      if (iCol >= 0) v[iCol] = v[iCol].map((x) => x * k);
      return v;
    };
    const quad = (v: number[][][], normal: number[]) => {
      // Two triangles of four corners in order round them, wound to face `normal`.
      const p = v.map((x) => new THREE.Vector3(...x[iPos]));
      const n = p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0]));
      const order = n.x * normal[0] + n.y * normal[1] + n.z * normal[2] >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const k of order) put(v[k]);
    };
    for (const h of f.holes) {
      const sides: [number, number][] = [[h.s0, 1], [h.s1, -1]];
      for (const [s, sign] of sides) {
        const normal = [dx * sign, 0, dz * sign];
        const cut = banded ? alongFace(points, s, (q) => q.cut!) : NaN;
        const ys = banded && cut > h.y0 && cut < h.y1 ? [h.y0, cut, h.y1] : [h.y0, h.y1];
        for (let i = 0; i < ys.length - 1; i++) {
          const row = rowAt(s, (ys[i] + ys[i + 1]) / 2);
          // The brick runs on round the corner: its u goes on the way it went across the face.
          const du = iUv >= 0 ? Math.sign(sample(row, s + 0.05 * sign, ys[i])[iUv][0] - sample(row, s, ys[i])[iUv][0]) || 1 : 0;
          const ring = [corner(row, s, ys[i], normal), corner(row, s, ys[i + 1], normal), shade(corner(row, s, ys[i + 1], normal, h.depth), SIDE), shade(corner(row, s, ys[i], normal, h.depth), SIDE)];
          if (iUv >= 0) for (const k of [2, 3]) ring[k][iUv] = [ring[k][iUv][0] + du * h.depth, ring[k][iUv][1]];
          quad(ring, normal);
        }
      }
      const row = rowAt((h.s0 + h.s1) / 2, h.y1 - 0.01);
      const down = [0, -1, 0];
      const top = [corner(row, h.s0, h.y1, down), corner(row, h.s1, h.y1, down), shade(corner(row, h.s1, h.y1, down, h.depth), TOP), shade(corner(row, h.s0, h.y1, down, h.depth), TOP)];
      for (const k of [0, 1]) shade(top[k], TOP_EDGE);
      if (iUv >= 0) for (const k of [2, 3]) top[k][iUv] = [top[k][iUv][0], top[k][iUv][1] - h.depth];
      quad(top, down);
      // The back: behind the frame (which reaches 5 cm behind its face), dark, smooth.
      const back = [[h.s0, h.y0], [h.s1, h.y0], [h.s1, h.y1], [h.s0, h.y1]].map(([s, y]) => {
        const v = corner(rowAt((h.s0 + h.s1) / 2, (h.y0 + h.y1) / 2), s, y, face, h.depth + 0.06);
        if (iCol >= 0) v[iCol] = BACK.map((b) => (attrs[iCol].normalized ? b : b / 255));
        if (iFacade >= 0) v[iFacade] = [attrs[iFacade].normalized ? 255 : 1];
        return v;
      });
      quad(back, face);
    }
    for (const t of mine) drop[t / 3] = 1;
    any = true;
  }
  if (!any) return g;
  const out = new THREE.BufferGeometry();
  const kept = drop.reduce((n, d) => n + (d ? 0 : 3), 0);
  attrs.forEach((a, k) => {
    const size = a.itemSize;
    const total = kept + added[k].length / size;
    const Type = a.array.constructor as new (n: number) => THREE.TypedArray;
    const array = new Type(total * size);
    let w = 0;
    for (let t = 0; t < drop.length; t++) {
      if (drop[t]) continue;
      for (let j = 0; j < 3 * size; j++) array[w++] = a.array[t * 3 * size + j];
    }
    const integer = !(array instanceof Float32Array);
    const max = array instanceof Uint8Array ? 255 : array instanceof Uint16Array ? 65535 : Infinity;
    for (const x of added[k]) array[w++] = integer ? Math.max(0, Math.min(max, Math.round(x))) : x;
    out.setAttribute(names[k], new THREE.BufferAttribute(array, size, a.normalized));
  });
  g.dispose();
  return out;
}
