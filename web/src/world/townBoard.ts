import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ARENAS } from '../../shared/arenas.mjs';
import { lang, onLang, t, type PlainKey } from '../i18n';
import { api, type ZombieRun } from '../net/client';
import type { World } from './collision';
import type { Prism } from './houseData';
import { mood } from './mood';

/**
 * The village notice board on the church square (Yoshi, 8 Nov 2026: "an in-game highscore board properly embedded
 * on the church square like a town board"): our own model (tools/town_board.py, public/models/town_board.glb), a
 * Flemish village board on two posts with a small roof, and behind its glass the best Zombies runs, the same list as
 * the pause menu's board (src/ui/leaderboard.ts, GET /api/scores: each account's best anywhere).
 *
 * It stands on the square's east side, at the corner of the corner house, by the bench and the planters: on the
 * paving where people walk, clear of the cars' way through the square, the parking bays, the shop's doors and its
 * open porch, turned to the square and the church's portal.
 *
 * The list is drawn on a canvas (1024 x 768, mipmaps, anisotropy) only when it or the language changes. It is
 * fetched when you come within NEAR m, at most once every REFRESH_MS, never from afar; the server keeps the
 * board 15 s itself. Offline or on a failed fetch it keeps the last list, or says there is nothing yet.
 * Player names are untrusted: they are drawn as text on the canvas (never HTML), without control or direction
 * characters, cut to the name length and to the column.
 *
 * Draw calls: two (the board, one material with its baked shade in the vertex colours as the square's furniture
 * has; the glass with the list). No real-time shadow, as the town's models. At dusk and at night the list lights
 * up softly from behind (emissive, at most 0.36: far under the half-float limit). Blocks for walking, driving and
 * shots, as the square's other furniture.
 */

/** Where it stands: its middle at ground level, and the way its glass faces (a unit vector on the plan). */
export const BOARD_AT = { x: 549.0, z: -761.0, face: [-0.8, -0.6] as [number, number] };
/** Fetch the list within this many metres, at most once a REFRESH_MS. */
const NEAR = 40;
const REFRESH_MS = 60_000;
/** Beyond this the board isn't drawn (the village's own small things go at about this distance). */
const DRAW = 260;
/** Use is offered within this many metres of the glass, looking roughly at it. */
const REACH = 2.6;
/** The canvas. */
const W = 1024;
const H = 768;
const ROWS = 10;
/** The longest name the server allows (server/auth.mjs NAME_RE). */
const NAME_MAX = 20;

/** A name as it may be drawn: no control, zero-width or direction characters, at most NAME_MAX characters. */
export function drawableName(name: unknown): string {
  return Array.from(String(name ?? ''))
    .filter((ch) => !hidden(ch.codePointAt(0) ?? 0))
    .slice(0, NAME_MAX)
    .join('')
    .trim();
}

/** Control characters, the soft hyphen, zero-width and direction marks and overrides, invisible operators, specials. */
function hidden(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xad || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)
    || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff || (c >= 0xfff0 && c <= 0xffff);
}

/** A count from the server as a whole number of at most four digits (anything else: 0). */
function count(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 9999) : 0;
}

const PLACES: string[] = ARENAS.map((a) => a.id);
const placeName = (id: string) => (PLACES.includes(id) ? t(`portal.${id}` as PlainKey) : '');

const FONT = '"Alegreya Sans", system-ui, sans-serif';
const INK = '#1d2326';
const PAPER = '#f3f0e6';
const BAND = '#22302a';
const RULE = '#d8d2c2';
const MEDALS = ['#c9a032', '#9aa3a8', '#b0703f'];

export class TownBoard {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly display: THREE.MeshStandardMaterial;
  private rows: ZombieRun[] | null = null;
  private failed = false;
  private fetchedAt = -Infinity;
  private fetching = false;
  private updated = '';
  private dirty = true;
  private readonly ground: number;
  private readonly yaw: number;

  constructor(world: World, groundAt: (x: number, z: number) => number) {
    const { x, z, face } = BOARD_AT;
    this.yaw = Math.atan2(face[0], face[1]);
    this.ground = groundAt(x, z);
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false; // glTF's UVs: v down the picture
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.display = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.16, metalness: 0, emissive: '#fff1dc', emissiveMap: this.texture, emissiveIntensity: 0 });
    this.group.position.set(x, this.ground, z);
    this.group.rotation.y = this.yaw;
    this.group.visible = false;
    world.addPrisms(this.blocks(groundAt));
    onLang(() => (this.dirty = true));
    // The page's font comes in with the page; until then the canvas would draw in the fallback.
    void document.fonts?.load(`800 40px ${FONT}`).then(() => document.fonts.load(`500 30px ${FONT}`)).then(() => (this.dirty = true)).catch(() => undefined);
  }

  /** Its blocks: the posts with the case between them up to the roof, and the roof; cars, players and shots stop at them. */
  private blocks(groundAt: (x: number, z: number) => number): Prism[] {
    const { x, z, face } = BOARD_AT;
    const [nx, nz] = face;
    const ax = -nz; // along the board
    const az = nx;
    const rect = (half: number, front: number, back: number): [number, number][] => [
      [x + ax * half + nx * front, z + az * half + nz * front],
      [x - ax * half + nx * front, z - az * half + nz * front],
      [x - ax * half - nx * back, z - az * half - nz * back],
      [x + ax * half - nx * back, z + az * half - nz * back],
    ];
    const low = Math.min(...rect(0.9, 0.3, 0.3).map(([px, pz]) => groundAt(px, pz)));
    return [
      { m: 'steel', y0: low - 0.4, y1: this.ground + 2.26, p: [rect(0.88, 0.15, 0.15)], n: 'town board' },
      { m: 'steel', y0: this.ground + 2.26, y1: this.ground + 2.46, p: [rect(0.88, 0.31, 0.27)], n: 'town board' },
    ];
  }

  /** Fetch the model once the village is in; the board shows from then on, its shaders compiled first (`compile`, main.ts). */
  async load(renderer: THREE.WebGLRenderer, compile: (root: THREE.Object3D) => Promise<unknown>): Promise<void> {
    const scene = (await new GLTFLoader().loadAsync('/models/town_board.glb')).scene;
    this.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = mesh.material as THREE.MeshStandardMaterial;
      if (mesh.name.startsWith('Display')) mesh.material = this.display;
      else mesh.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
      old.dispose();
      mesh.castShadow = mesh.receiveShadow = false;
    });
    this.draw();
    await compile(scene);
    this.group.add(scene);
    this.group.visible = true;
  }

  /** Each frame: the list when you are near, the light behind the glass by the dark, hidden from afar. */
  update(eye: THREE.Vector3): void {
    const d = Math.hypot(eye.x - BOARD_AT.x, eye.z - BOARD_AT.z);
    this.group.visible = this.group.children.length > 0 && d < DRAW;
    if (!this.group.visible) return;
    if (d < NEAR && !this.fetching && performance.now() - this.fetchedAt > REFRESH_MS) void this.fetch();
    // A little by day too, so the paper reads white in the board's shade; by night it is lit from behind.
    this.display.emissiveIntensity = 0.12 + 0.24 * Math.min(1, Math.max(0, mood.night));
    if (this.dirty) this.draw();
  }

  /** Close to the glass and in front of it: the use key opens the menu's board (main.ts). */
  near(x: number, z: number, feet: number): boolean {
    if (!this.group.visible || Math.abs(feet - this.ground) > 1.5) return false;
    const dx = x - BOARD_AT.x;
    const dz = z - BOARD_AT.z;
    const front = dx * BOARD_AT.face[0] + dz * BOARD_AT.face[1];
    return front > 0 && front < REACH && Math.abs(dx * -BOARD_AT.face[1] + dz * BOARD_AT.face[0]) < 1.4;
  }

  private async fetch(): Promise<void> {
    this.fetching = true;
    this.fetchedAt = performance.now();
    try {
      const { rows } = await api.scores();
      this.rows = Array.isArray(rows) ? rows.slice(0, ROWS) : [];
      this.failed = false;
      this.updated = new Date().toLocaleTimeString(lang() === 'nl' ? 'nl-BE' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
      this.failed = true; // keep the last list, if there is one
    } finally {
      this.fetching = false;
      this.dirty = true;
    }
  }

  /** A line of text cut with an ellipsis to fit `max` pixels. */
  private fit(text: string, max: number): string {
    const g = this.g;
    if (g.measureText(text).width <= max) return text;
    const chars = Array.from(text);
    while (chars.length > 1 && g.measureText(`${chars.join('')}…`).width > max) chars.pop();
    return `${chars.join('')}…`;
  }

  /** The poster behind the glass. */
  private draw(): void {
    this.dirty = false;
    const g = this.g;
    g.save();
    g.textBaseline = 'middle';
    // The paper, with a faint edge.
    g.fillStyle = PAPER;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#cfc8b6';
    g.lineWidth = 6;
    g.strokeRect(3, 3, W - 6, H - 6);
    // The band with the title.
    g.fillStyle = BAND;
    g.fillRect(0, 0, W, 100);
    g.fillStyle = '#7fb069';
    g.fillRect(0, 96, W, 6);
    g.fillStyle = '#f4f1e6';
    g.font = `800 60px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(this.fit(t('board.title'), W - 96), 44, 52);
    g.fillStyle = '#5b5f58';
    g.font = `500 28px ${FONT}`;
    g.fillText(this.fit(t('board.sub'), W - 88), 44, 130);
    // The columns.
    const COL = { rank: 70, name: 116, wave: 610, beaten: 762, place: 796 };
    const top = 186; // the first row's upper edge
    const step = 54;
    g.fillStyle = '#7a7d74';
    g.font = `800 22px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(t('lb.player').toUpperCase(), COL.name, top - 20);
    g.textAlign = 'right';
    g.fillText(t('lb.wave').toUpperCase(), COL.wave, top - 20);
    g.fillText(t('lb.beaten').toUpperCase(), COL.beaten, top - 20);
    g.textAlign = 'left';
    g.fillText(t('lb.place').toUpperCase(), COL.place, top - 20);
    g.fillStyle = INK;
    g.fillRect(40, top - 5, W - 80, 3);
    const rows = this.rows ?? [];
    if (!rows.length) {
      // Nothing yet, or no answer (yet): one friendly line in the middle.
      g.fillStyle = '#4a4f4a';
      g.font = `500 38px ${FONT}`;
      g.textAlign = 'center';
      const text = this.rows === null ? t(this.failed ? 'board.offline' : 'board.loading') : t('board.empty');
      this.wrap(text, W / 2, top + 250, W - 200, 50);
    }
    for (const [i, r] of rows.entries()) {
      const y = top + step * (i + 0.5);
      if (i % 2 === 1) {
        g.fillStyle = 'rgba(120, 110, 80, 0.08)';
        g.fillRect(40, y - step / 2, W - 80, step);
      }
      // The rank: a coloured disc for the first three.
      g.textAlign = 'center';
      if (i < 3) {
        g.fillStyle = MEDALS[i];
        g.beginPath();
        g.arc(COL.rank, y, 22, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ffffff';
      } else g.fillStyle = '#6b6f66';
      g.font = `800 30px ${FONT}`;
      g.fillText(String(i + 1), COL.rank, y + 1);
      g.textAlign = 'left';
      g.fillStyle = INK;
      g.font = `800 40px ${FONT}`;
      g.fillText(this.fit(drawableName(r.username) || '?', COL.wave - 100 - COL.name), COL.name, y);
      g.textAlign = 'right';
      g.fillStyle = '#9b2d24';
      g.fillText(String(count(r.wave)), COL.wave, y);
      g.fillStyle = INK;
      g.font = `500 34px ${FONT}`;
      g.fillText(String(count(r.kills)), COL.beaten, y);
      g.textAlign = 'left';
      g.fillStyle = '#4f544d';
      g.font = `500 30px ${FONT}`;
      g.fillText(this.fit(placeName(String(r.place)), W - 44 - COL.place), COL.place, y);
      if (i < rows.length - 1) {
        g.fillStyle = RULE;
        g.fillRect(40, y + step / 2 - 1, W - 80, 2);
      }
    }
    // The foot: who is on it, and when it was last brought up to date.
    g.fillStyle = '#7a7d74';
    g.font = `500 22px ${FONT}`;
    g.textAlign = 'left';
    g.fillText(this.fit(t('lb.accountsOnly'), W - 330), 44, H - 20);
    if (this.updated) {
      g.textAlign = 'right';
      g.fillText(t('board.updated', { time: this.updated }), W - 44, H - 20);
    }
    g.restore();
    this.texture.needsUpdate = true;
  }

  /** Centred text over as many lines as it takes. */
  private wrap(text: string, cx: number, cy: number, max: number, lead: number): void {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && this.g.measureText(next).width > max) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => this.g.fillText(l, cx, cy + (i - (lines.length - 1) / 2) * lead));
  }
}
