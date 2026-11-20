import * as THREE from 'three';
import { onLang, t } from '../i18n';
import type { Prism } from './houseData';

/**
 * The small wooden board on a post at the lane's verge by the Brook Spirit's wood (shared/brookSpirit.json `sign`),
 * with `spirit.sign` painted on both faces in the page's language ("Quiet! Something sleeps by the brook."). Drawn in
 * code on a canvas, again when the language changes. Two draws; its post is a block you walk round.
 */

const FONT = '"Alegreya Sans", system-ui, sans-serif';
const W = 512;
const H = 256;

export class SpiritSign {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;

  constructor(at: { x: number; z: number; yaw: number }, ground: number) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const wood = new THREE.MeshStandardMaterial({ color: '#5a4330', roughness: 0.9 });
    const face = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.85 });
    // The board: its two big faces carry the picture (+z and -z), its edges are plain wood.
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.56, 0.05), [wood, wood, wood, wood, face, face]);
    board.position.y = 1.35;
    board.rotation.z = 0.025; // hung by hand
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.75, 0.09), wood);
    post.position.set(0, 0.8, -0.06);
    this.group.add(board, post);
    this.group.position.set(at.x, ground, at.z);
    this.group.rotation.y = at.yaw;
    this.group.traverse((o) => {
      o.userData.ignoreRay = false;
      o.userData.material = 'wood'; // shots knock on it as on wood (weapon.ts impacts)
      o.castShadow = true;
    });
    this.draw();
    onLang(() => this.draw());
    void document.fonts?.load(`700 40px ${FONT}`).then(() => this.draw(), () => {});
  }

  /** The post as a block: you walk round it (world/collision.ts addPrisms). */
  block(): Prism {
    const p = this.group.position;
    const r = 0.12;
    return { m: 'wood', y0: p.y - 0.3, y1: p.y + 1.7, p: [[[p.x - r, p.z - r], [p.x + r, p.z - r], [p.x + r, p.z + r], [p.x - r, p.z + r]]] };
  }

  private draw(): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    // Weathered boards, darker at the edges, a few grain lines.
    g.fillStyle = '#7a5b3d';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 26; i++) {
      const y = (i * 37) % H;
      g.strokeStyle = i % 3 ? 'rgba(60,40,24,0.25)' : 'rgba(150,115,80,0.2)';
      g.lineWidth = 1 + (i % 3);
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(W * 0.3, y + 6, W * 0.6, y - 5, W, y + 3);
      g.stroke();
    }
    g.fillStyle = 'rgba(40,26,14,0.5)';
    g.fillRect(0, H / 2 - 2, W, 4); // where two boards meet
    const edge = g.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.62);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(25,15,8,0.55)');
    g.fillStyle = edge;
    g.fillRect(0, 0, W, H);
    // The words, painted in pale paint: split at the first full stop or exclamation mark, else in two halves.
    const text = t('spirit.sign');
    const cut = text.search(/[!.?]\s/);
    const lines = cut > 0 ? [text.slice(0, cut + 1), text.slice(cut + 2)] : split(text);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#efe6cf';
    lines.forEach((line, i) => {
      let px = i === 0 && lines.length > 1 ? 62 : 44;
      g.font = `700 ${px}px ${FONT}`;
      while (g.measureText(line).width > W - 50 && px > 18) g.font = `700 ${--px}px ${FONT}`;
      g.fillText(line, W / 2, lines.length > 1 ? H * (0.33 + i * 0.36) : H / 2);
    });
    this.texture.needsUpdate = true;
  }
}

function split(text: string): string[] {
  const words = text.split(' ');
  if (words.length < 4) return [text];
  const half = Math.ceil(words.length / 2);
  return [words.slice(0, half).join(' '), words.slice(half).join(' ')];
}
