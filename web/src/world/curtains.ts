import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { homeAt } from '../../shared/homes.mjs';

/**
 * Curtains behind the windows of a home that is locked for this player (world/homeLocks.ts). Its
 * inside is private and isn't on this page, so through the glass there was an empty white box.
 * Now each of its panes has a drawn curtain just behind it, on the home's side: pale linen in
 * soft folds. It shows nothing of the home, and reads as a house whose curtains are closed.
 *
 * They are taken down when the home opens: then the real inside is there to see. One material,
 * one picture drawn in code, a flat piece per pane. The pieces behind a home's still panes are
 * one mesh (one draw for a whole home, where each pane's own made 56 at the main house); only the
 * glass in a door that swings has a curtain of its own, hung on it. A broken pane loses its piece.
 */

let cloth: THREE.MeshStandardMaterial | null = null;
/** Linen in folds, drawn once: light and shade in upright bands of uneven width, a hem at the foot, a fine weave over it. */
function clothMaterial(): THREE.MeshStandardMaterial {
  if (cloth) return cloth;
  const W = 256;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const row = g.createImageData(W, 1);
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  // The folds: a few waves of different widths added up, so no two folds are alike; it repeats across the picture.
  const waves = [[5, 0.5], [9, 0.3], [14, 0.2]].map(([n, a]) => ({ n, a, p: rnd() * Math.PI * 2 }));
  for (let x = 0; x < W; x++) {
    let v = 0;
    for (const w of waves) v += w.a * Math.sin((x / W) * Math.PI * 2 * w.n + w.p);
    const light = 0.78 + 0.2 * v; // 0.58 in a fold's shade to 0.98 on its ridge
    row.data[x * 4] = 232 * light;
    row.data[x * 4 + 1] = 226 * light;
    row.data[x * 4 + 2] = 214 * light;
    row.data[x * 4 + 3] = 255;
  }
  for (let y = 0; y < H; y++) g.putImageData(row, 0, y);
  // A fine weave, and a darker hem along the foot.
  g.globalAlpha = 0.05;
  g.fillStyle = '#000';
  for (let y = 0; y < H; y += 2) g.fillRect(0, y, W, 1);
  g.globalAlpha = 1;
  const hem = g.createLinearGradient(0, H - 14, 0, H);
  hem.addColorStop(0, 'rgba(60, 52, 40, 0)');
  hem.addColorStop(1, 'rgba(60, 52, 40, 0.28)');
  g.fillStyle = hem;
  g.fillRect(0, H - 14, W, 14);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  cloth = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  cloth.name = 'Curtain';
  return cloth;
}

function ownless(mesh: THREE.Mesh): THREE.Mesh {
  mesh.userData.ignoreRay = true;
  mesh.raycast = () => {};
  mesh.castShadow = false;
  mesh.name = 'curtain';
  return mesh;
}

export class Curtains {
  /** A swinging pane's own curtain, hung on it */
  private hung = new Map<number, THREE.Mesh>();
  /** Per home: the one mesh for its still panes, and which panes it was made for */
  private still = new Map<string, { mesh: THREE.Mesh; key: string }>();
  /** Panes with no side in their home (a garden's glass): no curtain, and not tried again */
  private none = new Set<number>();

  /**
   * `panes`: every breakable pane by its number; `homeOfPane`: the locked home a pane belongs to, or null;
   * `isOpen`: whether that home is open to this player; `swings`: the pane is glass in a door's leaf (it moves);
   * `scene`: where the still panes' curtains go.
   */
  constructor(
    private panes: Map<number, THREE.Mesh>,
    private homeOfPane: (i: number) => string | null,
    private isOpen: (home: string) => boolean,
    private swings: (i: number) => boolean,
    private scene: THREE.Object3D,
  ) {}

  /** Hang a curtain behind each pane of a locked home, take down those of an open one. Call again when panes come or a lock changes. */
  sync(): void {
    const wanted = new Map<string, number[]>();
    for (const [i, pane] of this.panes) {
      const home = this.homeOfPane(i);
      const want = !!home && !this.isOpen(home) && !this.none.has(i);
      if (this.swings(i)) {
        const have = this.hung.get(i);
        if (have && (!want || have.parent !== pane)) {
          have.removeFromParent();
          have.geometry.dispose();
          this.hung.delete(i);
        }
        if (want && !this.hung.has(i)) {
          const piece = this.piece(pane, home!);
          if (!piece) this.none.add(i);
          else {
            const mesh = ownless(new THREE.Mesh(piece.geometry.applyMatrix4(piece.place), clothMaterial()));
            pane.add(mesh);
            this.hung.set(i, mesh);
          }
        }
      } else if (want && pane.visible) {
        const list = wanted.get(home!) ?? [];
        list.push(i);
        wanted.set(home!, list);
      }
    }
    // The still panes: one mesh per home, made again only when its panes changed (one broken, more come, the lock).
    for (const [home, have] of this.still) {
      if (wanted.get(home)?.join() === have.key) continue;
      have.mesh.removeFromParent();
      have.mesh.geometry.dispose();
      this.still.delete(home);
    }
    for (const [home, list] of wanted) {
      if (this.still.has(home)) continue;
      const parts: THREE.BufferGeometry[] = [];
      for (const i of list) {
        const pane = this.panes.get(i)!;
        const piece = this.piece(pane, home);
        if (!piece) this.none.add(i);
        else parts.push(piece.geometry.applyMatrix4(piece.place).applyMatrix4(pane.matrixWorld));
      }
      if (!parts.length) continue;
      const mesh = ownless(new THREE.Mesh(mergeGeometries(parts), clothMaterial()));
      for (const p of parts) p.dispose();
      this.scene.add(mesh);
      this.still.set(home, { mesh, key: list.join() });
    }
  }

  /** A pane's curtain: a flat piece its size, and where it hangs in the pane's own space (just behind it, on the home's side). Null with no such side. */
  private piece(pane: THREE.Mesh, home: string): { geometry: THREE.BufferGeometry; place: THREE.Matrix4 } | null {
    const geo = pane.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    // The pane's thin way is through the glass: the curtain hangs across the other two, on the home's side.
    const thin = size.x <= size.y && size.x <= size.z ? 'x' : size.z <= size.y ? 'z' : 'y';
    if (thin === 'y') return null; // a roof light: no curtain
    pane.updateWorldMatrix(true, false);
    const inside = (side: number) => {
      const p = mid.clone();
      p[thin] += side * (size[thin] / 2 + 0.3 / pane.scale[thin]);
      pane.localToWorld(p);
      return homeAt(p.x, p.z, p.y) === home;
    };
    const side = inside(1) ? 1 : inside(-1) ? -1 : 0;
    if (!side) return null; // no side of it is in the home
    const wide = thin === 'x' ? 'z' : 'x';
    const width = size[wide] * pane.scale[wide]; // m, in the world
    const geometry = new THREE.PlaneGeometry(size[wide], size.y);
    // A fold about every 12 cm, whatever the window's width.
    const uv = geometry.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * Math.max(1, Math.round(width / 1.6)));
    const at = mid.clone();
    at[thin] += side * (size[thin] / 2 + 0.06 / pane.scale[thin]);
    const place = new THREE.Matrix4().makeRotationY(thin === 'x' ? Math.PI / 2 : 0).setPosition(at);
    return { geometry, place };
  }
}
