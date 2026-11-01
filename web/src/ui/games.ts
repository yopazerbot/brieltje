import * as THREE from 'three';
import { listOf, onLang, plural, serverText, t } from '../i18n';

/**
 * Games in multiplayer (the admin starts them, the server keeps them): hide and seek, tag, a
 * treasure hunt, and the house against the bungalow (two teams). Here: the bar at the top with
 * the clock and your role or the score, the seeker's closed eyes while the others hide, the
 * coins, whom you can tag, and the choice of team in the menu.
 */

export type Team = 'house' | 'bungalow';
const TEAM_NAMES = { house: 'team.house', bungalow: 'team.bungalow' } as const;
const TITLES: Partial<Record<string, 'game.hide' | 'game.tag' | 'game.treasure' | 'game.teams'>> = { hide: 'game.hide', tag: 'game.tag', treasure: 'game.treasure', teams: 'game.teams' };

export interface ModeView {
  kind: 'free' | 'hide' | 'tag' | 'treasure' | 'teams';
  phase?: 'hiding' | 'seeking' | 'playing' | 'done';
  ms?: number;
  /** The game's name in English (this page names it by `kind`) */
  title?: string;
  seekers?: string[];
  it?: string;
  times?: Record<string, number>;
  coins?: { i: number; x: number; y: number; z: number }[];
  counts?: Record<string, number>;
  /** How it ended, in English; with its code and parameters for this page's language (src/i18n.ts serverText) */
  result?: string;
  resultCode?: unknown;
  resultArgs?: unknown;
  teams?: Record<string, Team>;
  score?: Record<Team, number>;
  goal?: number;
}

// Coins as big as a hand (0.35 m), turning and bobbing at chest height, each with a glint that keeps
// its size on screen, so it shows from across the garden. One texture and one material for all.
const COIN_LIFT = 0.6; // m: the coin's middle above where it lies
const coinGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.05, 28).rotateX(Math.PI / 2);
const coinMat = new THREE.MeshStandardMaterial({ color: '#f2c14e', metalness: 0.85, roughness: 0.25, emissive: '#5a3c00', emissiveIntensity: 0.5 });
const glintMat = new THREE.SpriteMaterial({ map: glintTexture(), color: '#fff4c2', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, sizeAttenuation: false });

/** A soft four-pointed star on a small canvas, for the coins' glint. */
function glintTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.25, 'rgba(255,236,170,0.55)');
  glow.addColorStop(1, 'rgba(255,220,120,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (const [w, h] of [[3, 30], [30, 3]]) g.fillRect(32 - w / 2, 32 - h / 2, w, h); // the star's rays
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const REACH = { hide: 2.0, tag: 1.6 }; // a little less than the server allows: network delay

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class Games {
  view: ModeView = { kind: 'free' };
  me = '';
  readonly group = new THREE.Group();
  /** Send a message to the server */
  onSend: (msg: Record<string, unknown>) => void = () => {};
  private ends = 0;
  private coins = new Map<number, THREE.Mesh>();
  /** Coins asked for, and when (performance.now()) */
  private asked = new Map<number, number>();
  private bar = document.getElementById('modebar')!;
  private blind = document.getElementById('blindfold')!;
  private spin = 0;
  /** Playing in Explore (no weapon): out of the teams game's fight (see setExploring) */
  private exploring = false;
  /** The connection is down: the bar greyed, its clock stopped at `frozen` ms (see setOffline) */
  private offline = false;
  private frozen = 0;

  constructor() {
    document.querySelectorAll<HTMLButtonElement>('#team-choice [data-team]').forEach((b) =>
      b.addEventListener('click', () => this.onSend({ t: 'team', team: b.dataset.team })),
    );
    onLang(() => this.showTeams()); // the bar and the blindfold follow each frame
  }

  set(view: ModeView): void {
    this.view = view ?? { kind: 'free' };
    this.ends = performance.now() + (this.view.ms ?? 0);
    this.setOffline(false); // the server's word on the game, fresh
    const keep = new Set((this.view.coins ?? []).map((c) => c.i));
    for (const [i, mesh] of this.coins) {
      if (keep.has(i)) continue;
      mesh.removeFromParent();
      this.coins.delete(i);
    }
    for (const c of this.view.coins ?? []) {
      if (this.coins.has(c.i)) continue;
      const mesh = new THREE.Mesh(coinGeo, coinMat);
      mesh.position.set(c.x, c.y + COIN_LIFT, c.z);
      mesh.userData.ignoreRay = true;
      mesh.userData.y = c.y + COIN_LIFT; // where it bobs around
      const glint = new THREE.Sprite(glintMat);
      glint.position.y = 0.42;
      glint.scale.setScalar(0.05);
      glint.userData.ignoreRay = true;
      mesh.add(glint);
      this.group.add(mesh);
      this.coins.set(c.i, mesh);
    }
    this.asked.clear();
    this.showTeams();
  }

  /**
   * The connection is down (`off`), or back: the bar greys and its clock stops, since the server may
   * have ended the game meanwhile (a restart). The welcome after reconnecting brings the game as it is.
   */
  setOffline(off: boolean): void {
    if (off && !this.offline) this.frozen = this.ends - performance.now();
    this.offline = off;
    this.bar.classList.toggle('stale', off);
  }

  /** Playing in Explore or not: in the teams game an explorer is told how to take part (the menu's team picker). */
  setExploring(exploring: boolean): void {
    if (exploring === this.exploring) return;
    this.exploring = exploring;
    this.showTeams();
  }

  /** The coins still to find during a hunt, for the maps. */
  coinSpots(): { x: number; y: number; z: number }[] {
    if (this.view.kind !== 'treasure' || this.view.phase !== 'playing') return [];
    return [...this.coins.values()].map((m) => ({ x: m.position.x, y: m.userData.y - COIN_LIFT, z: m.position.z }));
  }

  /** A player's part shown on their figure: "it" in tag, a seeker in hide and seek (also while hiding), else none. */
  roleOf(name: string): 'it' | 'seeker' | null {
    const v = this.view;
    if (v.kind === 'tag' && v.phase === 'playing' && v.it === name) return 'it';
    if (v.kind === 'hide' && v.phase !== 'done' && v.seekers?.includes(name)) return 'seeker';
    return null;
  }

  /** The menu's choice of team, while the teams game runs; for an explorer, how to take part. */
  private showTeams(): void {
    const playing = this.view.kind === 'teams' && this.view.phase === 'playing';
    document.getElementById('team-pick')!.classList.toggle('hidden', !playing);
    document.getElementById('team-explore')!.classList.toggle('hidden', !playing || !this.exploring);
    if (playing) {
      const teams = Object.values(this.view.teams ?? {});
      document.querySelectorAll<HTMLButtonElement>('#team-choice [data-team]').forEach((b) => {
        const team = b.dataset.team as Team;
        const n = teams.filter((x) => x === team).length;
        b.classList.toggle('selected', this.team === team);
        b.querySelector('span')!.textContent = plural(n, 'games.teamCount.one', 'games.teamCount.other', { n, place: t(team === 'house' ? 'games.atHouse' : 'games.atBungalow') });
      });
    }
  }

  /** A game is on (not just its result showing). */
  get active(): boolean {
    return this.view.kind !== 'free';
  }

  /**
   * A game in the house is being played (any of the four; not once its result shows): everyone stays
   * near the two houses (shared/bounds.json `party`) and nobody travels. The server holds to it too.
   */
  get fenced(): boolean {
    return this.active && this.view.phase !== 'done';
  }

  /** A party game is on: no fighting (the teams game is a fight). */
  get peaceful(): boolean {
    return this.active && this.view.kind !== 'teams';
  }

  /** Your team in the teams game. */
  get team(): Team | null {
    return this.view.kind === 'teams' ? this.view.teams?.[this.me] ?? null : null;
  }

  /** On your team: not to be shot. */
  friend(name: string): boolean {
    return !!this.team && this.view.teams?.[name] === this.team;
  }

  get seeker(): boolean {
    return this.view.kind === 'hide' && !!this.view.seekers?.includes(this.me);
  }

  /** The seeker, eyes shut while the others hide: no moving, no looking. */
  get blindfolded(): boolean {
    return this.seeker && this.view.phase === 'hiding';
  }

  /** In hide and seek names over heads and dots on the map would give the hiders away. */
  get hideOthers(): boolean {
    return this.view.kind === 'hide' && this.view.phase !== 'done';
  }

  /** The player you could tag now (nearest within reach), if you may tag. */
  target(names: string[], at: (name: string) => THREE.Vector3 | null, x: number, feet: number, z: number): string | null {
    const v = this.view;
    let reach = 0;
    let who = names.filter((n) => n !== this.me);
    if (v.kind === 'hide' && v.phase === 'seeking' && this.seeker) {
      reach = REACH.hide;
      who = who.filter((n) => !v.seekers?.includes(n));
    } else if (v.kind === 'tag' && v.phase === 'playing' && v.it === this.me) reach = REACH.tag;
    if (!reach) return null;
    let best: string | null = null;
    let bestD = reach;
    for (const n of who) {
      const p = at(n);
      if (!p || Math.abs(p.y - feet) > 1.4) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) [best, bestD] = [n, d];
    }
    return best;
  }

  tag(name: string): void {
    this.onSend({ t: 'tag', target: name });
  }

  /** Every frame: the clock and your role at the top, the eyes shut, the coins turning and picked up. `use`: the key or button that tags, for the way you play. */
  update(dt: number, x: number, feet: number, z: number, use = 'E'): void {
    const v = this.view;
    const left = this.offline ? this.frozen : this.ends - performance.now();
    this.spin += dt * 2.4;
    glintMat.opacity = 0.55 + 0.45 * Math.sin(this.spin * 2.2); // the glints twinkle together
    for (const [i, mesh] of this.coins) {
      mesh.rotation.y = this.spin;
      mesh.position.y = mesh.userData.y + Math.sin(this.spin * 1.5 + i) * 0.08;
      if (v.kind === 'treasure' && v.phase === 'playing' && performance.now() - (this.asked.get(i) ?? -Infinity) > 500) {
        const c = mesh.position;
        if (Math.hypot(c.x - x, c.z - z) < 1.1 && Math.abs(mesh.userData.y - COIN_LIFT - feet) < 1.5) {
          // The server answers a yes by sending the coins left, and a no not at all: it may still have
          // you a step behind (running, jumping down). So again every half second while you stand on it.
          this.asked.set(i, performance.now());
          this.onSend({ t: 'coin', i });
        }
      }
    }
    this.blind.classList.toggle('show', this.blindfolded);
    if (this.blindfolded) {
      const text = t('games.blind', { n: Math.ceil(Math.max(0, left) / 1000) });
      if (this.blind.textContent !== text) this.blind.textContent = text;
    }
    this.bar.classList.toggle('show', this.active);
    if (!this.active) return;
    const titleKey = TITLES[v.kind];
    const title = titleKey ? t(titleKey) : v.title ?? '';
    let text = `${title} · ${clock(left)} · `;
    if (v.phase === 'done') text = `${title} · ${serverText(v.resultCode, v.resultArgs, v.result ?? '')}`;
    else if (v.kind === 'hide') {
      const seekers = v.seekers ?? [];
      if (v.phase === 'hiding') text += this.seeker ? t('games.youSeekHide') : plural(seekers.length, 'games.hide.one', 'games.hide.other', { names: listOf(seekers) });
      else text += this.seeker ? t('games.youSeek', { use }) : t('games.stayHidden');
    } else if (v.kind === 'teams') {
      const s = v.score ?? { house: 0, bungalow: 0 };
      text += t('games.teamsLine', { h: s.house, b: s.bungalow, goal: v.goal ?? '', team: this.team ? t(TEAM_NAMES[this.team]) : '–' });
    } else if (v.kind === 'tag') {
      const mine = Math.round(v.times?.[this.me] ?? 0);
      text += v.it === this.me ? t('games.youreIt', { n: mine, use }) : t('games.isIt', { name: v.it ?? '', n: mine });
    } else {
      const counts = v.counts ?? {};
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      text += t('games.coins', { n: v.coins?.length ?? 0, mine: counts[this.me] ?? 0 }) + (best && best[1] > 0 ? t('games.best', { name: best[0], n: best[1] }) : '');
    }
    if (this.bar.textContent !== text) this.bar.textContent = text;
  }
}
