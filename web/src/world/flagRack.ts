import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLAG_COLORS, baseOf, fieldOf } from '../../shared/flagFields.mjs';
import { GUN_PAINT, onPaintball, paintball } from '../paintball';
import type { FlagGameView, FlagTeam } from '../ui/flagHud';

/**
 * Steal the flag's bazooka racks in the world (server/flagBazooka.mjs decides who holds what; shared/flagFields.mjs has
 * where each rack stands): a low steel stand with a plate in the team's colour, the launcher lying across its two forks
 * while it is on the rack, and while it is away a small ring with the seconds until it is back over the empty rack. Our
 * own shapes, nothing to download. Lit by the sun like everything else, no light of its own, nothing emissive (fine on
 * Low, phones and half-float targets); four draw calls a rack at most. Shots go through it, and nobody bumps into it:
 * you take the launcher by walking into it.
 */

const TEAMS: FlagTeam[] = ['blue', 'red'];
const FORK_H = 0.95; // m: where the launcher lies
const TUBE_L = 1.25;

/** The stand: a foot plate, two posts and a fork on each, merged (one draw call). */
function standGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(1.3, 0.05, 0.42).translate(0, 0.025, 0)];
  for (const x of [-0.42, 0.42]) {
    parts.push(new THREE.BoxGeometry(0.05, FORK_H - 0.05, 0.05).translate(x, FORK_H / 2, 0));
    for (const z of [-0.07, 0.07]) parts.push(new THREE.BoxGeometry(0.035, 0.14, 0.035).translate(x, FORK_H + 0.02, z));
  }
  return mergeGeometries(parts)!;
}

/** The launcher lying across the forks: its tube, a sight, a grip and a wider back end. */
function launcherGeometry(): THREE.BufferGeometry {
  const tube = new THREE.CylinderGeometry(0.065, 0.065, TUBE_L, 12, 1, true).rotateZ(Math.PI / 2);
  const back = new THREE.CylinderGeometry(0.085, 0.07, 0.22, 12).rotateZ(Math.PI / 2).translate(-TUBE_L / 2 + 0.11, 0, 0);
  const grip = new THREE.BoxGeometry(0.05, 0.16, 0.05).translate(0.12, -0.12, 0);
  const sight = new THREE.BoxGeometry(0.12, 0.06, 0.03).translate(0.05, 0.09, 0);
  return mergeGeometries([tube, back, grip, sight])!.translate(0, FORK_H + 0.08, 0);
}

const standGeo = standGeometry();
const launcherGeo = launcherGeometry();
const plateGeo = new THREE.BoxGeometry(0.9, 0.012, 0.3).translate(0, 0.056, 0);
const steel = new THREE.MeshStandardMaterial({ color: '#5c5f63', metalness: 0.6, roughness: 0.45 });
const olive = '#4a5236';

/** The ring and seconds over an empty rack, drawn on a small canvas when the second changes. */
class Countdown {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private shown = -1;

  constructor(private color: string) {
    this.canvas.width = this.canvas.height = 64;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false }));
    this.sprite.scale.set(0.7, 0.7, 1);
    this.sprite.position.y = 1.55;
  }

  /** `ms` until it is back, of `full`. */
  draw(ms: number, full: number): void {
    const s = Math.ceil(ms / 1000);
    if (s === this.shown) return;
    this.shown = s;
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, 64, 64);
    g.beginPath();
    g.arc(32, 32, 28, 0, Math.PI * 2);
    g.fillStyle = 'rgba(15, 18, 24, 0.75)';
    g.fill();
    g.beginPath();
    g.arc(32, 32, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, ms / full)));
    g.strokeStyle = this.color;
    g.lineWidth = 6;
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = 'bold 24px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(s), 32, 34);
    this.tex.needsUpdate = true;
  }
}

/** One team's rack. */
class Rack {
  readonly root = new THREE.Group();
  readonly launcher: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly countdown: Countdown;
  /** The wait first seen for this absence (the ring's full turn), and whether one is being counted */
  full = 1;
  counting = false;

  constructor(team: FlagTeam) {
    const color = FLAG_COLORS[team];
    const stand = new THREE.Mesh(standGeo, steel);
    const plate = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
    this.launcher = new THREE.Mesh(launcherGeo, new THREE.MeshStandardMaterial({ color: olive, roughness: 0.7, metalness: 0.2 }));
    stand.castShadow = this.launcher.castShadow = true;
    this.countdown = new Countdown(color);
    this.root.add(stand, plate, this.launcher, this.countdown.sprite);
    this.root.traverse((o) => {
      o.userData.ignoreRay = true; // shots go through
      o.raycast = () => {};
    });
    this.root.visible = false;
  }

  /** The launcher's colour: olive, or the paint cannon's own in the child-friendly look. */
  paint(on: boolean): void {
    this.launcher.material.color.set(on ? GUN_PAINT.bazooka : olive);
  }
}

export class FlagRacks {
  readonly group = new THREE.Group();
  private racks = new Map<FlagTeam, Rack>();
  private view: FlagGameView | null = null;

  constructor() {
    this.group.name = 'flagRacks';
    for (const team of TEAMS) {
      const rack = new Rack(team);
      rack.paint(paintball.on);
      this.racks.set(team, rack);
      this.group.add(rack.root);
    }
    onPaintball((on) => this.racks.forEach((r) => r.paint(on)));
  }

  /** The game's view (null: no flag game, or it is over): each rack at its team's base now (sides swapped too), the launcher on it or not. */
  set(view: FlagGameView | null): void {
    this.view = view?.racks ? view : null;
    this.group.visible = !!this.view;
    for (const team of TEAMS) {
      const rack = this.racks.get(team)!;
      const state = this.view?.racks?.[team];
      rack.root.visible = !!state;
      if (!state || !this.view) continue;
      const [x, z, y, yaw] = baseOf(fieldOf(this.view.field), team, !!this.view.swapped).rack;
      rack.root.position.set(x, y, z);
      rack.root.rotation.set(0, yaw, 0);
      rack.launcher.visible = state.at === 'rack';
      rack.countdown.sprite.visible = state.at === 'out' && typeof state.ms === 'number';
      if (typeof state.ms !== 'number') rack.counting = false;
      else if (!rack.counting) [rack.full, rack.counting] = [Math.max(1, state.ms), true];
    }
  }

  /** Every frame: the countdowns tick on between the server's views. */
  update(dt: number): void {
    const v = this.view;
    if (!v?.racks) return;
    for (const team of TEAMS) {
      const state = v.racks[team];
      if (state.at !== 'out' || typeof state.ms !== 'number') continue;
      state.ms = Math.max(0, state.ms - dt * 1000);
      const rack = this.racks.get(team)!;
      rack.countdown.draw(state.ms, rack.full);
    }
  }

  /** Your team's rack on the maps (`team`: yours, or null for none): where it stands, `away` while the launcher is out. */
  marks(team: FlagTeam | null): { x: number; y: number; z: number; color: string; away: boolean }[] {
    const v = this.view;
    if (!v?.racks || !team) return [];
    const [x, z, y] = baseOf(fieldOf(v.field), team, !!v.swapped).rack;
    return [{ x, y, z, color: FLAG_COLORS[team], away: v.racks[team].at !== 'rack' }];
  }
}

/** A rack on a map (ui/minimap.ts, ui/bigmap.ts): a short launcher in the team's colour, `s` px long; faint while away. */
export function rackMark(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, away: boolean): void {
  g.save();
  g.globalAlpha = away ? 0.45 : 1;
  g.translate(x, y);
  g.rotate(-0.5);
  g.fillStyle = 'rgba(20, 20, 30, 0.95)';
  g.fillRect(-s / 2 - 1.5, -s * 0.16 - 1.5, s + 3, s * 0.32 + 3);
  g.fillStyle = color;
  g.fillRect(-s / 2, -s * 0.16, s, s * 0.32);
  g.fillStyle = 'rgba(20, 20, 30, 0.95)';
  g.fillRect(-s * 0.05, s * 0.16, s * 0.14, s * 0.28);
  g.restore();
}
