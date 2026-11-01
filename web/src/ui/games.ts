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

const coinGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.03, 24).rotateX(Math.PI / 2);
const coinMat = new THREE.MeshStandardMaterial({ color: '#f2c14e', metalness: 0.85, roughness: 0.25, emissive: '#5a3c00', emissiveIntensity: 0.4 });
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

  constructor() {
    document.querySelectorAll<HTMLButtonElement>('#team-choice [data-team]').forEach((b) =>
      b.addEventListener('click', () => this.onSend({ t: 'team', team: b.dataset.team })),
    );
    onLang(() => this.showTeams()); // the bar and the blindfold follow each frame
  }

  set(view: ModeView): void {
    this.view = view ?? { kind: 'free' };
    this.ends = performance.now() + (this.view.ms ?? 0);
    const keep = new Set((this.view.coins ?? []).map((c) => c.i));
    for (const [i, mesh] of this.coins) {
      if (keep.has(i)) continue;
      mesh.removeFromParent();
      this.coins.delete(i);
    }
    for (const c of this.view.coins ?? []) {
      if (this.coins.has(c.i)) continue;
      const mesh = new THREE.Mesh(coinGeo, coinMat);
      mesh.position.set(c.x, c.y + 0.45, c.z);
      mesh.userData.ignoreRay = true;
      this.group.add(mesh);
      this.coins.set(c.i, mesh);
    }
    this.asked.clear();
    this.showTeams();
  }

  /** The menu's choice of team, while the teams game runs. */
  private showTeams(): void {
    const playing = this.view.kind === 'teams' && this.view.phase === 'playing';
    document.getElementById('team-pick')!.classList.toggle('hidden', !playing);
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
    const left = this.ends - performance.now();
    this.spin += dt * 2.4;
    for (const [i, mesh] of this.coins) {
      mesh.rotation.y = this.spin;
      mesh.position.y += Math.sin(this.spin * 1.3 + i) * 0.0015;
      if (v.kind === 'treasure' && v.phase === 'playing' && performance.now() - (this.asked.get(i) ?? -Infinity) > 500) {
        const c = mesh.position;
        if (Math.hypot(c.x - x, c.z - z) < 1.1 && Math.abs(c.y - 0.45 - feet) < 1.5) {
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
