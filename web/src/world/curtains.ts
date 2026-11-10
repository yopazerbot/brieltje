import * as THREE from 'three';
import { homeAt } from '../../shared/homes.mjs';

/**
 * Curtains behind the windows of a home that is locked for this player (world/homeLocks.ts). Its
 * inside is private and isn't on this page, so through the glass there was an empty white box.
 * Now each of its panes has a drawn curtain just behind it, on the home's side: pale linen in
 * soft folds. It shows nothing of the home, and reads as a house whose curtains are closed.
 *
 * A curtain hangs on its pane (it moves with a door's glass, and goes when the pane is broken) and
 * is taken down when the home opens: then the real inside is there to see. One material, one
 * picture drawn in code, a flat piece per pane.
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

export class Curtains {
  private hung = new Map<number, THREE.Mesh>();

  /**
   * `panes`: every breakable pane by its number; `homeOfPane`: the locked home a pane belongs to, or null;
   * `isOpen`: whether that home is open to this player.
   */
  constructor(private panes: Map<number, THREE.Mesh>, private homeOfPane: (i: number) => string | null, private isOpen: (home: string) => boolean) {}

  /** Hang a curtain behind each pane of a locked home, take down those of an open one. Call again when panes come or a lock changes. */
  sync(): void {
    for (const [i, pane] of this.panes) {
      const home = this.homeOfPane(i);
      const want = !!home && !this.isOpen(home);
      const have = this.hung.get(i);
      if (have && (!want || have.parent !== pane)) {
        have.removeFromParent();
        have.geometry.dispose();
        this.hung.delete(i);
      }
      if (want && !this.hung.has(i)) {
        const curtain = this.make(pane, home!);
        if (curtain) this.hung.set(i, curtain);
      }
    }
  }

  private make(pane: THREE.Mesh, home: string): THREE.Mesh | null {
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
    if (!side) return null; // no side of it is in the home (a pane of the garden's): left as it is
    const wide = thin === 'x' ? 'z' : 'x';
    const width = size[wide] * pane.scale[wide]; // m, in the world
    const curtain = new THREE.Mesh(new THREE.PlaneGeometry(size[wide], size.y), clothMaterial());
    // A fold about every 12 cm, whatever the window's width.
    const uv = curtain.geometry.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * Math.max(1, Math.round(width / 1.6)));
    curtain.position.copy(mid);
    curtain.position[thin] += side * (size[thin] / 2 + 0.06 / pane.scale[thin]);
    if (thin === 'x') curtain.rotation.y = Math.PI / 2;
    curtain.userData.ignoreRay = true;
    curtain.raycast = () => {};
    curtain.castShadow = false;
    curtain.name = 'curtain';
    pane.add(curtain);
    return curtain;
  }
}
