import * as THREE from 'three';
import { t } from '../i18n';
import { paintball } from '../paintball';
import { compactHud } from './compact';

export const LOOT_LABELS = { ammo: 'loot.ammo', scope: 'loot.scope', claymore: 'loot.claymore', stakes: 'loot.stakes', turret: 'loot.turret', medkit: 'loot.medkit', armor: 'loot.armor', nades: 'loot.nades', lull: 'loot.lull', gun: 'loot.gun' } as const;

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

  update(camera: THREE.Camera, visible: boolean, friends: { name: string; x: number; y: number; z: number }[], canPing: boolean): void {
    this.ping.hidden = !canPing || !visible;
    this.ping.disabled = performance.now() < this.nextCall;
    this.ping.textContent = t(this.ping.disabled ? 'tactics.sent' : 'tactics.ping') + (document.body.classList.contains('touch') ? '' : ' · V');
    this.markers.hidden = !visible;
    if (!visible) this.calls.clear();
    for (const [name, call] of this.calls) if (performance.now() > call.until) this.calls.delete(name);
    if (performance.now() - this.markerAt < 100) return;
    this.markerAt = performance.now();
    this.markers.replaceChildren();
    if (!visible) return;
    // Markers that would cover each other step down below the one already there (the nearest first
    // keeps its place). Sizes are guessed from the text: measuring would cost a layout per marker.
    const small = compactHud();
    const lineH = small ? 20 : 24;
    const placed: { x: number; y: number; w: number }[] = [];
    const list: { text: string; x: number; y: number; d: number }[] = [];
    for (const p of [...friends, ...[...this.calls].map(([name, at]) => ({ name: t('tactics.call', { name }), ...at }))].slice(0, 20)) {
      const point = new THREE.Vector3(p.x, p.y + 2.1, p.z);
      const distance = point.distanceTo(camera.position);
      if (distance < 2) continue;
      point.project(camera);
      const behind = point.z > 1;
      list.push({
        text: `${behind ? '↶ ' : '◆ '}${p.name} · ${Math.round(distance)} m`,
        x: Math.max(12, Math.min(88, (behind ? -point.x : point.x) * 50 + 50)),
        y: behind ? 80 : Math.max(16, Math.min(80, -point.y * 50 + 50)),
        d: distance,
      });
    }
    list.sort((a, b) => a.d - b.d);
    for (const m of list) {
      const x = (m.x / 100) * innerWidth;
      let y = (m.y / 100) * innerHeight;
      const w = Math.min(small ? 130 : 180, m.text.length * (small ? 6 : 7) + 14);
      for (let i = 0; i < 20; i++) {
        const hit = placed.find((o) => Math.abs(o.x - x) < (o.w + w) / 2 && Math.abs(o.y - y) < lineH);
        if (!hit) break;
        y = hit.y + lineH;
      }
      placed.push({ x, y, w });
      const el = document.createElement('span');
      el.textContent = m.text;
      el.style.left = `${m.x}%`;
      el.style.top = `${(y / innerHeight) * 100}%`;
      this.markers.append(el);
    }
  }
}
