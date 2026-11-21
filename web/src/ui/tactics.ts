import * as THREE from 'three';
import { playerName, t } from '../i18n';
import { paintball } from '../paintball';
import { compactHud } from './compact';

export const LOOT_LABELS = { ammo: 'loot.ammo', scope: 'loot.scope', claymore: 'loot.claymore', stakes: 'loot.stakes', turret: 'loot.turret', medkit: 'loot.medkit', armor: 'loot.armor', nades: 'loot.nades', lull: 'loot.lull', gun: 'loot.gun', rifle: 'loot.rifle', laser: 'loot.laser' } as const;

/** A team game's name markers: only teammates this close (m), at most this many (a phone or a small view: the fewer). */
const TEAM_REACH = 25;
const TEAM_MOST = 6;
const TEAM_MOST_SMALL = 4;
/**
 * Where markers may go, in % of the view: clear of the minimap and the lists at the top right, the game's bar at the top,
 * the health and the ammo at the bottom; with touch controls clear of the stick on the left and the buttons on the right.
 */
const SAFE = {
  screen: { x0: 12, x1: 84, y0: 16, y1: 80 },
  touch: { x0: 24, x1: 66, y0: 18, y1: 72 },
};

/** Small world-space placement guides and screen-space cooperative markers. */
export class Tactics {
  readonly guide = new THREE.Group();
  private footprint: THREE.Mesh;
  private label = document.createElement('div');
  private markers = document.createElement('div');
  readonly ping = document.createElement('button');
  private calls = new Map<string, { x: number; y: number; z: number; until: number }>();
  private markerAt = 0;
  private nextCall = 0;

  constructor(scene: THREE.Scene, send: () => void) {
    const material = new THREE.MeshBasicMaterial({ color: '#69f0ae', wireframe: true, depthTest: true });
    this.footprint = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    this.footprint.userData.ignoreRay = true;
    this.guide.add(this.footprint);
    this.guide.visible = false;
    scene.add(this.guide);
    this.label.className = 'placement-guide';
    this.markers.className = 'tactical-markers';
    this.ping.className = 'team-ping';
    this.ping.hidden = this.label.hidden = true;
    this.ping.type = 'button';
    const request = () => {
      if (this.ping.hidden || performance.now() < this.nextCall) return;
      this.nextCall = performance.now() + 3000;
      send();
    };
    this.ping.addEventListener('click', request);
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'KeyV' || event.repeat || this.ping.hidden || event.ctrlKey || event.altKey || event.metaKey) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable=true]')) return;
      event.preventDefault();
      request();
    });
    document.body.append(this.label, this.markers, this.ping);
  }

  placement(kind: 'claymore' | 'stakes' | 'turret' | null, at: { x: number; y: number; z: number } | null, yaw: number, valid: boolean, why?: string, span?: [number, number]): void {
    this.guide.visible = !!kind && !!at;
    this.label.hidden = !kind;
    if (!kind) return;
    const reason = valid ? 'tactics.place' : why === 'max' || why === 'all' ? 'tactics.limit' : why === 'none' ? 'tactics.empty' : 'tactics.blocked';
    this.label.textContent = t(reason, { item: t(kind === 'claymore' && paintball.on ? 'loot.paintMine' : LOOT_LABELS[kind]) });
    this.label.dataset.valid = String(valid);
    (this.footprint.material as THREE.MeshBasicMaterial).color.set(valid ? '#69f0ae' : '#ff8a80');
    if (at) this.guide.position.set(at.x, at.y, at.z);
    this.guide.rotation.y = yaw;
    const height = kind === 'stakes' ? .95 : kind === 'turret' ? .65 : .15;
    this.footprint.scale.set(kind === 'stakes' ? 1.8 : .45, height, kind === 'stakes' ? .35 : .4);
    this.footprint.position.x = kind === 'stakes' && span ? (span[0] + span[1]) / 2 : 0;
    if (kind === 'stakes' && span) this.footprint.scale.x = span[1] - span[0] + .3;
    this.footprint.position.y = height / 2 + .025;
  }

  called(name: string, x: number, y: number, z: number): void {
    this.calls.set(name, { x, y, z, until: performance.now() + 8000 });
  }

  /**
   * Every frame: the markers over `friends` (teammates, or in Zombies also the stall's things) and the teammates' calls.
   * `team`: a team game (the teams game, Steal the flag): only names within TEAM_REACH m and on screen, the nearest
   * TEAM_MOST (TEAM_MOST_SMALL on a phone or a small view), none for those behind you; `team.carrier`, a teammate carrying
   * a flag, always, held at the screen's edge when off it. Big team shooters do it so: names near the crosshair and
   * close by, the objective carrier marked wherever they are. Never over the touch buttons or the health bar (SAFE),
   * and none while the scoreboard shows.
   */
  update(camera: THREE.Camera, visible: boolean, friends: { name: string; x: number; y: number; z: number }[], canPing: boolean, team: { carrier: string | null } | null = null): void {
    this.ping.hidden = !canPing || !visible;
    this.ping.disabled = performance.now() < this.nextCall;
    const touch = document.body.classList.contains('touch');
    this.ping.textContent = t(this.ping.disabled ? 'tactics.sent' : 'tactics.ping') + (touch ? '' : ' · V');
    const board = !document.getElementById('scoreboard')?.classList.contains('hidden');
    this.markers.hidden = !visible || board;
    if (!visible) this.calls.clear();
    for (const [name, call] of this.calls) if (performance.now() > call.until) this.calls.delete(name);
    if (performance.now() - this.markerAt < 100) return;
    this.markerAt = performance.now();
    this.markers.replaceChildren();
    if (!visible || board) return;
    // Markers that would cover each other step down below the one already there (the nearest first
    // keeps its place). Sizes are guessed from the text: measuring would cost a layout per marker.
    const small = compactHud();
    const safe = touch ? SAFE.touch : SAFE.screen;
    const lineH = small || touch ? 20 : 24;
    const placed: { x: number; y: number; w: number }[] = [];
    const list: { text: string; x: number; y: number; d: number; keep: boolean }[] = [];
    const calls = [...this.calls].map(([name, at]) => ({ name: t('tactics.call', { name }), call: true, ...at }));
    for (const p of [...friends.map((f) => ({ ...f, call: false })), ...calls].slice(0, 40)) {
      const point = new THREE.Vector3(p.x, p.y + 2.1, p.z);
      const distance = point.distanceTo(camera.position);
      if (distance < 2) continue;
      const carrier = !!team && !p.call && p.name === team.carrier;
      // A team game: a call or the carrier always, the others only near.
      const keep = !team || p.call || carrier;
      if (!keep && distance > TEAM_REACH) continue;
      point.project(camera);
      const behind = point.z > 1;
      let x = (behind ? -point.x : point.x) * 50 + 50;
      let y = behind ? safe.y1 : -point.y * 50 + 50;
      const inside = !behind && x >= safe.x0 && x <= safe.x1 && y >= safe.y0 && y <= safe.y1;
      if (team && !keep && !inside) continue; // off screen, under a button or behind you: no marker
      x = Math.max(safe.x0, Math.min(safe.x1, x));
      y = Math.max(safe.y0, Math.min(safe.y1, y));
      const mark = carrier ? '⚑ ' : behind ? '↶ ' : '◆ ';
      list.push({ text: `${mark}${playerName(p.name)} · ${Math.round(distance)} m`, x, y, d: carrier ? -1 : distance, keep });
    }
    list.sort((a, b) => a.d - b.d);
    const most = team ? (small || touch ? TEAM_MOST_SMALL : TEAM_MOST) : Infinity;
    let names = 0;
    for (const m of list) {
      if (team && !m.keep && names >= most) continue;
      const x = (m.x / 100) * innerWidth;
      let y = (m.y / 100) * innerHeight;
      const w = Math.min(small || touch ? 130 : 180, m.text.length * (small || touch ? 6 : 7) + 14);
      for (let i = 0; i < 20; i++) {
        const hit = placed.find((o) => Math.abs(o.x - x) < (o.w + w) / 2 && Math.abs(o.y - y) < lineH);
        if (!hit) break;
        y = hit.y + lineH;
      }
      if (y > (safe.y1 / 100) * innerHeight + lineH / 2 && !m.keep) continue; // stepped down onto the buttons or the health
      if (team && !m.keep) names++;
      placed.push({ x, y, w });
      const el = document.createElement('span');
      el.textContent = m.text;
      if (m.text.startsWith('⚑')) el.className = 'carrier';
      el.style.left = `${m.x}%`;
      el.style.top = `${(y / innerHeight) * 100}%`;
      this.markers.append(el);
    }
  }
}
