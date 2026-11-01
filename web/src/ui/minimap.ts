import type { Level, Prism, Room } from '../world/houseData';
import { dist, placeName } from '../i18n';

/**
 * Minimap, top right: the plan of the floor you are on, cut at 1.2 m above
 * that floor like a floor plan, over the big map's ground, turning with your view. Other
 * players are coloured dots (a ring when they are on another floor), cats
 * small orange dots and weapons lying around yellow diamonds. A portal is a ring in its
 * colour; the nearest one off the map is an arrow on the edge with how far it is. A waypoint set on
 * the big map is a yellow pin, or a yellow arrow on the edge with its distance, and the way to it
 * along the roads a blue line. The floor's name shows under it indoors only (outside it would say
 * "Ground floor" on the church square), and its words have a dark edge: the village's ground is light.
 */

const SIZE = 180; // px on screen
const SCALE = 7; // px per metre
const PAD = 40; // m of plan around the house drawn into each level image
const CUT = 1.2; // m above the floor
const GROUND = 128; // m: the piece of the big map's ground drawn around you, drawn again after moving 40 m

export interface Blip {
  x: number;
  z: number;
  y: number;
  color: string;
  kind: 'player' | 'cat' | 'item' | 'coin' | 'zombie';
}

export class Minimap {
  private canvas = document.getElementById('minimap') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d')!;
  private plans = new Map<string, HTMLCanvasElement>();
  private minX: number;
  private minZ: number;
  private ground: { paint: (g: CanvasRenderingContext2D, pxPerM: number) => void; version: () => number } | null = null;
  private groundImage: HTMLCanvasElement | null = null;
  private groundAt = { x: 0, z: 0, version: -1 };

  constructor(prisms: Prism[], private levels: Level[], rooms: Room[]) {
    this.canvas.width = this.canvas.height = SIZE * devicePixelRatio;
    const xs = prisms.flatMap((p) => p.p[0].map((v) => v[0])).filter((v) => Math.abs(v) < 60);
    const zs = prisms.flatMap((p) => p.p[0].map((v) => v[1])).filter((v) => Math.abs(v) < 60);
    this.minX = Math.min(...xs) - PAD;
    this.minZ = Math.min(...zs) - PAD;
    const w = (Math.max(...xs) + PAD - this.minX) * SCALE;
    const h = (Math.max(...zs) + PAD - this.minZ) * SCALE;
    for (const lv of levels) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      const path = (rings: [number, number][][]) => {
        g.beginPath();
        for (const r of rings) {
          r.forEach(([x, z], i) => (i ? g.lineTo : g.moveTo).call(g, (x - this.minX) * SCALE, (z - this.minZ) * SCALE));
          g.closePath();
        }
      };
      const cut = lv.floor + CUT;
      // Ground floor: the paving around the house (the garden and the rest come from the big map's ground).
      if (lv.id === 'gf') {
        for (const p of prisms) {
          if (p.y1 > 0.2 || !['paving', 'road', 'terrace', 'pave_light', 'pave_warm', 'gravel'].includes(p.m)) continue;
          g.fillStyle = 'rgba(150, 150, 145, 0.75)';
          path(p.p);
          g.fill('evenodd');
        }
      }
      // Floors of the rooms on this level.
      g.fillStyle = 'rgba(232, 222, 205, 0.85)';
      for (const r of rooms) {
        if (r.level !== lv.id) continue;
        path(r.p);
        g.fill('evenodd');
      }
      // Everything the cut goes through: walls, glass, furniture, hedges.
      for (const p of prisms) {
        if (p.y0 > cut || p.y1 < cut) continue;
        g.fillStyle = p.m === 'glass' ? 'rgba(120, 190, 230, 0.9)' : p.m === 'hedge' ? 'rgba(40, 70, 35, 0.9)' : 'rgba(25, 26, 30, 0.95)';
        path(p.p);
        g.fill('evenodd');
      }
      this.plans.set(lv.id, c);
    }
  }

  /**
   * The big map's ground (src/ui/bigmap.ts) under the plan: the minimap shows the fields, roads and
   * buildings wherever you are, the village too. Drawn into a piece of GROUND metres around you,
   * again only after moving on, so a frame costs one image copy.
   */
  setGround(paint: (g: CanvasRenderingContext2D, pxPerM: number) => void, version: () => number): void {
    this.ground = { paint, version };
  }

  private groundPiece(x: number, z: number): HTMLCanvasElement | null {
    if (!this.ground) return null;
    const at = this.groundAt;
    const version = this.ground.version();
    if (this.groundImage && version === at.version && Math.abs(x - at.x) < 40 && Math.abs(z - at.z) < 40) return this.groundImage;
    const k = Math.min(devicePixelRatio, 2);
    const c = this.groundImage ?? document.createElement('canvas');
    c.width = c.height = GROUND * SCALE * k;
    const g = c.getContext('2d')!;
    g.setTransform(k * SCALE, 0, 0, k * SCALE, k * SCALE * (GROUND / 2 - x), k * SCALE * (GROUND / 2 - z));
    g.fillStyle = '#c3c9b6';
    g.fillRect(x - GROUND / 2, z - GROUND / 2, GROUND, GROUND);
    this.ground.paint(g, SCALE);
    this.groundImage = c;
    this.groundAt = { x, z, version };
    return c;
  }

  /** The level whose floor you stand on (or above). */
  private levelAt(feet: number): Level {
    let lv = this.levels[0];
    for (const l of this.levels) if (feet >= l.floor - 0.3) lv = l;
    return lv;
  }

  draw(x: number, z: number, feet: number, yaw: number, blips: Blip[], shapes: { ring: [number, number][]; y: number }[] = [], portals: { x: number; z: number; color: string }[] = [], waypoint: { x: number; z: number } | null = null, route: { line: [number, number][]; length: number } | null = null, indoors = true): void {
    const g = this.ctx;
    const s = devicePixelRatio;
    const lv = this.levelAt(feet);
    g.setTransform(s, 0, 0, s, 0, 0);
    g.clearRect(0, 0, SIZE, SIZE);
    g.save();
    g.beginPath();
    g.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = 'rgba(12, 14, 18, 0.75)';
    g.fillRect(0, 0, SIZE, SIZE);
    // Turn the plan so that where you look is up.
    g.translate(SIZE / 2, SIZE / 2);
    g.rotate(yaw);
    const ground = this.groundPiece(x, z);
    if (ground) g.drawImage(ground, -(x - this.groundAt.x + GROUND / 2) * SCALE, -(z - this.groundAt.z + GROUND / 2) * SCALE, GROUND * SCALE, GROUND * SCALE);
    g.drawImage(this.plans.get(lv.id)!, -(x - this.minX) * SCALE, -(z - this.minZ) * SCALE);
    // Furniture outlines on this floor.
    g.fillStyle = 'rgba(160, 120, 80, 0.85)';
    for (const s of shapes) {
      if (this.levelAt(s.y).id !== lv.id) continue;
      g.beginPath();
      s.ring.forEach(([sx, sz], i) => (i ? g.lineTo : g.moveTo).call(g, (sx - x) * SCALE, (sz - z) * SCALE));
      g.closePath();
      g.fill();
    }
    for (const b of blips) {
      const bx = (b.x - x) * SCALE;
      const bz = (b.z - z) * SCALE;
      const other = this.levelAt(b.y).id !== lv.id;
      g.save();
      g.translate(bx, bz);
      g.rotate(-yaw);
      if (b.kind === 'item') {
        g.fillStyle = other ? 'rgba(242, 179, 61, 0.35)' : '#f2b33d';
        g.beginPath();
        g.moveTo(0, -4);
        g.lineTo(4, 0);
        g.lineTo(0, 4);
        g.lineTo(-4, 0);
        g.closePath();
        g.fill();
      } else if (b.kind === 'zombie') {
        // A zombie of the Zombies game: a small green dot with a dark edge, readable on grass and street.
        g.beginPath();
        g.arc(0, 0, 2.6, 0, Math.PI * 2);
        g.fillStyle = b.color;
        g.fill();
        g.strokeStyle = 'rgba(16, 24, 12, 0.9)';
        g.lineWidth = 1.2;
        g.stroke();
      } else if (b.kind === 'coin') {
        // A treasure hunt's coin: gold with a dark edge, faint on another floor.
        g.beginPath();
        g.arc(0, 0, 3.5, 0, Math.PI * 2);
        g.fillStyle = other ? 'rgba(242, 193, 78, 0.35)' : b.color;
        g.fill();
        g.strokeStyle = 'rgba(60, 40, 0, 0.8)';
        g.lineWidth = 1.2;
        g.stroke();
      } else {
        g.beginPath();
        g.arc(0, 0, b.kind === 'cat' ? 2.5 : 4.5, 0, Math.PI * 2);
        if (other) {
          g.strokeStyle = b.color;
          g.lineWidth = 2;
          g.stroke();
        } else {
          g.fillStyle = b.color;
          g.fill();
        }
      }
      g.restore();
    }
    const rim = SIZE / 2 - 9;
    let nearest: { bx: number; bz: number; d: number; color: string } | null = null;
    for (const p of portals) {
      const bx = (p.x - x) * SCALE;
      const bz = (p.z - z) * SCALE;
      const d = Math.hypot(bx, bz);
      if (d < rim) {
        g.strokeStyle = p.color;
        g.lineWidth = 2.5;
        g.beginPath();
        g.arc(bx, bz, 6, 0, Math.PI * 2);
        g.stroke();
      } else if (!nearest || d < nearest.d) nearest = { bx, bz, d, color: p.color };
    }
    if (waypoint && route && route.line.length > 1) {
      // The way to it, as a car's navigation draws it.
      g.beginPath();
      route.line.forEach(([rx, rz], i) => (i ? g.lineTo : g.moveTo).call(g, (rx - x) * SCALE, (rz - z) * SCALE));
      g.lineJoin = g.lineCap = 'round';
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      g.lineWidth = 7;
      g.stroke();
      g.strokeStyle = '#2f80ed';
      g.lineWidth = 4;
      g.stroke();
    }
    if (waypoint) {
      const bx = (waypoint.x - x) * SCALE;
      const bz = (waypoint.z - z) * SCALE;
      const d = Math.hypot(bx, bz);
      const a = Math.atan2(bz, bx);
      g.save();
      g.fillStyle = '#f2b33d';
      g.strokeStyle = '#11151b';
      g.lineWidth = 1.5;
      if (d < rim) {
        g.translate(bx, bz);
        g.rotate(-yaw);
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(-5, -9);
        g.arc(0, -10, 5, Math.PI, 0);
        g.closePath();
        g.fill();
        g.stroke();
      } else {
        g.translate(Math.cos(a) * rim, Math.sin(a) * rim);
        g.rotate(a);
        g.beginPath();
        g.moveTo(8, 0);
        g.lineTo(-4, -6);
        g.lineTo(-1, 0);
        g.lineTo(-4, 6);
        g.closePath();
        g.fill();
        g.stroke();
        g.rotate(-a);
        g.translate(-Math.cos(a) * 18, -Math.sin(a) * 18);
        g.rotate(-yaw);
        g.font = '700 10px Bahnschrift, Arial Narrow, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        const m = route ? route.length : d / SCALE;
        label(g, dist(m));
      }
      g.restore();
    }
    if (nearest) {
      const a = Math.atan2(nearest.bz, nearest.bx);
      g.save();
      g.translate(Math.cos(a) * rim, Math.sin(a) * rim);
      g.rotate(a);
      g.fillStyle = nearest.color;
      g.beginPath();
      g.moveTo(7, 0);
      g.lineTo(-4, -5.5);
      g.lineTo(-4, 5.5);
      g.closePath();
      g.fill();
      g.restore();
      g.save();
      g.translate(Math.cos(a) * (rim - 16), Math.sin(a) * (rim - 16));
      g.rotate(-yaw);
      g.fillStyle = 'rgba(244, 239, 230, 0.95)';
      g.font = '600 10px Bahnschrift, Arial Narrow, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const m = nearest.d / SCALE;
      label(g, dist(m));
      g.restore();
    }
    g.restore();
    // You: an arrow in the middle, pointing up (where you look), with a dark edge: the roads and the
    // church square are white on the map, and a white arrow on them was gone.
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(SIZE / 2, SIZE / 2 - 7);
    g.lineTo(SIZE / 2 + 5, SIZE / 2 + 5);
    g.lineTo(SIZE / 2, SIZE / 2 + 2);
    g.lineTo(SIZE / 2 - 5, SIZE / 2 + 5);
    g.closePath();
    g.strokeStyle = 'rgba(12, 14, 18, 0.9)';
    g.lineWidth = 2.5;
    g.lineJoin = 'round';
    g.stroke();
    g.fill();
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
    g.stroke();
    if (!indoors) return;
    g.fillStyle = 'rgba(244, 239, 230, 0.95)';
    g.font = '600 11px Bahnschrift, Arial Narrow, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    label(g, placeName(lv.name).toUpperCase(), SIZE / 2, SIZE - 12);
  }
}

/** Words on the map in the current fill colour, with a dark edge so they read on light ground too. */
function label(g: CanvasRenderingContext2D, text: string, x = 0, y = 0): void {
  g.save();
  g.strokeStyle = 'rgba(12, 14, 18, 0.85)';
  g.lineWidth = 3;
  g.lineJoin = 'round';
  g.strokeText(text, x, y);
  g.restore();
  g.fillText(text, x, y);
}
