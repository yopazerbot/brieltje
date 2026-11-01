import type { Score } from '../net/client';
import { anyPaint, onPaintball, paintball } from '../paintball';
import { sound } from '../sound';
import { onLang, t } from '../i18n';

/**
 * Multiplayer fighting on screen: health, red flash when hit, hit marker,
 * kill feed, death screen with respawn countdown, round banner and the
 * scoreboard (hold Tab or the touchpad). The server decides; this shows it.
 * In paintball (paintball.ts) it says it the friendly way: tagged, not
 * killed, a splash of paint at the edge of the screen instead of red, and
 * the health bar in paint (style.css colours it by the page's `paintball`).
 */

const RESPAWN_S = 3;
const FEED_S = 6;
const $ = (id: string) => document.getElementById(id)!;

function span(text: string, cls = '', color = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  if (cls) s.className = cls;
  if (color) s.style.color = color;
  return s;
}

export class Combat {
  hp = 100;
  alive = true;
  me = '';
  private limit = 10;
  private teams: { goal: number; score: { house: number; bungalow: number } } | null = null;
  private scores: Score[] = [];
  private active = false;
  private held = false;
  private roundLeft = 0;
  private respawnLeft = 0;
  private flash = 0;
  private marker = 0;
  private dirTime = 0;
  private feed: { el: HTMLElement; left: number }[] = [];
  private killer = '';
  private winner = '';

  constructor() {
    // Another language: the death screen's and the banner's titles and the scoreboard (the lines under them follow each frame).
    onLang(() => {
      this.drawTitles();
      this.drawBoard();
      for (const tag of document.querySelectorAll('#killfeed .hs')) tag.textContent = t(paintball.on ? 'paint.bullseyeTag' : 'combat.headshotTag');
    });
    onPaintball(() => {
      this.drawTitles();
      this.drawBoard();
    });
  }

  private drawTitles(): void {
    $('death-title').textContent = t(paintball.on ? 'paint.taggedBy' : 'combat.killedBy', { name: this.killer });
    $('banner-title').textContent = this.winner === this.me ? t('combat.youWin') : t('combat.wins', { name: this.winner });
  }

  /** Health and the death screen show while you carry a weapon in multiplayer. */
  setActive(on: boolean): void {
    this.active = on;
    this.drawHealth();
  }

  reset(scores: Score[], limit: number, round: { winner: string; ms: number } | null): void {
    this.limit = limit;
    this.respawned();
    this.setScores(scores);
    if (round) this.round(round.winner, round.ms);
    else this.endRound();
  }

  setScores(list: Score[]): void {
    this.scores = list;
    this.drawBoard();
  }

  hurt(hp: number): void {
    this.hp = hp;
    this.flash = 1;
    this.drawHealth();
    if (paintball.on) {
      document.body.style.setProperty('--paint', anyPaint()); // each hit its own colour at the edge of the screen
      this.splat();
    } else this.tone(110, 0.12, 0.35, 'sine');
  }

  died(killer: string, head: boolean): void {
    this.alive = false;
    this.hp = 0;
    this.flash = 1;
    this.respawnLeft = RESPAWN_S;
    this.killer = killer;
    this.drawTitles();
    $('death').dataset.head = head ? '1' : '';
    $('death').classList.remove('hidden');
    this.drawHealth();
    if (paintball.on) this.tone(620, 0.45, 0.3, 'sine', 210); // a cartoon "aww" sliding down
    else this.tone(70, 0.4, 0.5, 'triangle');
  }

  respawned(): void {
    this.alive = true;
    this.hp = 100;
    this.respawnLeft = 0;
    $('death').classList.add('hidden');
    this.drawHealth();
  }

  /**
   * A line in the kill feed, top right. In paintball it reads "X tagged Y" for a player and
   * "X splattered a strongman" for the game's own figures, with the weapon after it.
   */
  kill(killer: string, victim: string, head: boolean, weapon = ''): void {
    const color = (n: string) => this.scores.find((s) => s.name === n)?.color ?? '';
    const line = document.createElement('div');
    line.className = 'kf';
    if (killer === this.me || victim === this.me) line.classList.add('me');
    if (paintball.on) {
      const you = victim === t('char.you'); // alone, a strongman tagged you
      const figure = [t('char.strongman'), t('char.clown'), t('char.cat')].includes(victim);
      line.append(span(killer, '', color(killer)), span(` ${t(figure ? 'paint.splattered' : 'paint.tagged')} `, 'arrow'), span(you ? t('paint.you') : victim, '', color(victim)));
      if (weapon) line.append(span(` · ${weapon}`, 'arrow'));
    } else line.append(span(killer, '', color(killer)), span(weapon ? ` ${weapon} ` : ' ▸ ', 'arrow'), span(victim, '', color(victim)));
    if (head) line.append(span(t(paintball.on ? 'paint.bullseyeTag' : 'combat.headshotTag'), 'hs'));
    $('killfeed').append(line);
    this.feed.push({ el: line, left: FEED_S });
    if (this.feed.length > 5) this.feed.shift()?.el.remove();
    if (killer === this.me) {
      this.hitMarker(true);
      this.tone(880, 0.07, 0.25, 'sine');
      setTimeout(() => this.tone(1320, 0.1, 0.25, 'sine'), 80);
    }
  }

  /** Red arc around the crosshair pointing to where a hit came from (radians, 0 = ahead, positive = left). */
  hitFrom(angle: number): void {
    const el = $('hitdir');
    el.style.transform = `translate(-50%, -50%) rotate(${-angle}rad)`;
    this.dirTime = 1.2;
  }

  /** The X around the crosshair: white for a hit, red for a kill. */
  hitMarker(kill = false): void {
    this.marker = kill ? 0.45 : 0.2;
    $('hitmarker').classList.toggle('kill', kill);
    if (!kill) this.tone(1900, 0.03, 0.15, 'square');
  }

  round(winner: string, ms: number): void {
    this.roundLeft = ms / 1000;
    this.winner = winner;
    this.drawTitles();
    $('banner').classList.remove('hidden');
  }

  endRound(): void {
    this.roundLeft = 0;
    $('banner').classList.add('hidden');
  }

  showBoard(held: boolean): void {
    this.held = held;
  }

  tick(dt: number): void {
    this.flash = Math.max(0, this.flash - dt * 2.5);
    $('damage').style.opacity = String(this.alive ? this.flash : Math.max(0.55, this.flash));
    this.dirTime = Math.max(0, this.dirTime - dt);
    $('hitdir').style.opacity = String(Math.min(1, this.dirTime));
    this.marker = Math.max(0, this.marker - dt);
    $('hitmarker').style.opacity = String(Math.min(1, this.marker * 8));

    if (!this.alive) {
      this.respawnLeft = Math.max(0, this.respawnLeft - dt);
      const head = $('death').dataset.head ? t(paintball.on ? 'paint.bullseye' : 'combat.headshot') : '';
      const n = Math.ceil(this.respawnLeft);
      const text = head + (this.roundLeft > 0 ? t('combat.nextRound') : this.respawnLeft > 0 ? t(paintball.on ? 'paint.backIn' : 'combat.backIn', { n }) : t('combat.respawning'));
      if ($('death-sub').textContent !== text) $('death-sub').textContent = text;
    }
    if (this.roundLeft > 0) {
      this.roundLeft = Math.max(0, this.roundLeft - dt);
      const text = t('combat.newRoundIn', { n: Math.ceil(this.roundLeft) });
      if ($('banner-sub').textContent !== text) $('banner-sub').textContent = text;
    }
    for (const f of this.feed) {
      f.left -= dt;
      f.el.classList.toggle('old', f.left < 0);
    }
    while (this.feed.length && this.feed[0].left < -1) this.feed.shift()?.el.remove();
    $('scoreboard').classList.toggle('hidden', !(this.scores.length && (this.held || this.roundLeft > 0)));
  }

  private drawHealth(): void {
    const box = $('health');
    box.classList.toggle('hidden', !this.active);
    box.classList.toggle('low', this.hp <= 34);
    $('hp-value').textContent = String(this.hp);
    $('hp-fill').style.width = `${this.hp}%`;
  }

  /** The teams game (its goal and the teams' score) for the scoreboard's heading, or null outside it. */
  setTeams(teams: { goal: number; score: { house: number; bungalow: number } } | null): void {
    this.teams = teams;
    this.drawBoard();
  }

  private drawBoard(): void {
    const tm = this.teams;
    $('score-goal').textContent = tm
      ? t(paintball.on ? 'paint.teamsGoal' : 'combat.teamsGoal', { n: tm.goal, h: tm.score.house, b: tm.score.bungalow })
      : t(paintball.on ? 'paint.goal' : 'combat.goal', { n: this.limit });
    const head = document.createElement('tr');
    const titles = paintball.on ? (['combat.player', 'paint.tags', 'paint.taggedCol', 'combat.points'] as const) : (['combat.player', 'combat.kills', 'combat.deaths', 'combat.points'] as const);
    for (const h of titles) {
      const th = document.createElement('th');
      th.textContent = t(h);
      head.append(th);
    }
    const rows = [...this.scores]
      .sort((a, b) => b.points - a.points || b.kills - a.kills || a.deaths - b.deaths)
      .map((s) => {
        const tr = document.createElement('tr');
        if (s.name === this.me) tr.className = 'me';
        if (!s.alive) tr.classList.add('dead');
        const name = document.createElement('td');
        name.className = 'name';
        name.append(span(s.name, '', s.color));
        if (!s.armed) name.append(span(t('combat.exploring'), 'exploring'));
        else if (!s.alive) name.append(span(t(paintball.on ? 'paint.out' : 'combat.dead'), 'exploring'));
        const cells = [s.kills, s.deaths, s.points].map((n) => {
          const td = document.createElement('td');
          td.className = 'num';
          td.textContent = String(n);
          return td;
        });
        tr.append(name, ...cells);
        return tr;
      });
    $('score-table').replaceChildren(head, ...rows);
  }

  /** Paintball: hit by paint, a wet splat close by (noise falling in pitch). */
  private splat(): void {
    const ctx = sound.context();
    const out = sound.out();
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.25), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(3000, t);
    low.frequency.exponentialRampToValueAtTime(300, t + 0.25);
    const g = ctx.createGain();
    g.gain.value = 0.45;
    noise.connect(low).connect(g).connect(out);
    noise.start(t);
  }

  /** Short sounds made in code: hit tick, kill ding, getting hurt; `to` slides the pitch there. */
  private tone(freq: number, len: number, volume: number, type: OscillatorType, to = freq < 200 ? freq * 0.5 : 0): void {
    const ctx = sound.context();
    const out = sound.out();
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.02);
  }
}
