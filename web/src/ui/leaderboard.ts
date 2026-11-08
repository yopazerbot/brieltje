// The scores in the pause menu (src/ui/leaderboard.ts): the best Zombies runs per account for everyone, and the fights' totals together.
import { api, errorText, type ZombieRun } from '../net/client';
import { num, onLang, t, type PlainKey } from '../i18n';
import { paintball } from '../paintball';
import { ARENAS } from '../../shared/arenas.mjs';

/** The places a Zombies game is played at (shared/arenas.mjs), for the board's filter. */
const PLACES = ARENAS.map((a) => a.id);
const placeName = (id: string) => (PLACES.includes(id) ? t(`portal.${id}` as PlainKey) : id);

/**
 * The scores in the pause menu (Yoshi, 7 Nov 2026: accounts only on the board). The best Zombies runs, for
 * everyone to see: each account's best anywhere, or the best at one place. Below, together only, the
 * fights' all-time totals per account (kills, deaths, headshots, round wins), in paintball's words while
 * you play it. Names from the server go in with textContent only.
 */
export class Leaderboard {
  private box = document.getElementById('leaderboard')!;
  private button = document.getElementById('leaderboard-btn')!;
  private open = false;
  private loggedIn = false;
  private place = '';

  constructor() {
    this.button.addEventListener('click', () => {
      this.open = !this.open;
      if (this.open) void this.load();
      else this.box.replaceChildren();
      this.label();
    });
    this.label();
    onLang(() => {
      this.label();
      this.refresh();
    });
  }

  private label(): void {
    this.button.querySelector('b')!.textContent = t(this.open ? 'lb.hide' : 'lb.button');
    this.button.querySelector('span')!.textContent = t('lb.zSub');
  }

  /** The button is always there; the fights' totals only while playing together (the server's answer needs a session). */
  show(loggedIn: boolean): void {
    this.button.classList.remove('hidden');
    if (loggedIn !== this.loggedIn) {
      this.loggedIn = loggedIn;
      this.refresh();
    }
  }

  /** Open the board and bring it into view (the notice board on the church square: world/townBoard.ts). */
  reveal(): void {
    if (!this.open) {
      this.open = true;
      this.label();
    }
    void this.load().then(() => this.button.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  /** Reload when the menu opens again. */
  refresh(): void {
    if (this.open) void this.load();
  }

  private cell(tr: HTMLElement, tag: 'th' | 'td', text: string | number): void {
    const c = document.createElement(tag);
    c.textContent = String(text);
    tr.append(c);
  }

  private async load(): Promise<void> {
    const parts: HTMLElement[] = [];
    // The best Zombies runs, at every place or one.
    const h = document.createElement('h3');
    h.className = 'lb-title';
    h.textContent = t('lb.zombies');
    const pick = document.createElement('select');
    pick.setAttribute('aria-label', t('lb.place'));
    for (const id of ['', ...PLACES]) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id ? placeName(id) : t('lb.allPlaces');
      pick.append(o);
    }
    pick.value = this.place;
    pick.addEventListener('change', () => {
      this.place = pick.value;
      void this.load();
    });
    parts.push(h, pick);
    try {
      const { rows } = await api.scores(this.place);
      parts.push(this.zombieTable(rows));
      const note = document.createElement('p');
      note.className = 'lb-note';
      note.textContent = t(rows.length ? 'lb.accountsOnly' : 'lb.zEmpty');
      parts.push(note);
    } catch (e) {
      const p = document.createElement('p');
      p.textContent = errorText(e)();
      parts.push(p);
    }
    // The fights' totals: together only.
    if (this.loggedIn) {
      const f = document.createElement('h3');
      f.className = 'lb-title';
      f.textContent = t('lb.fights');
      parts.push(f);
      try {
        parts.push(...this.fights((await api.leaderboard()).rows));
      } catch (e) {
        const p = document.createElement('p');
        p.textContent = errorText(e)();
        parts.push(p);
      }
    }
    if (this.open) this.box.replaceChildren(...parts);
  }

  private zombieTable(rows: ZombieRun[]): HTMLTableElement {
    const all = !this.place;
    const head = document.createElement('tr');
    for (const k of ['lb.player', 'lb.wave', 'lb.beaten', 'lb.team', ...(all ? ['lb.place'] : []), 'lb.date'] as PlainKey[]) this.cell(head, 'th', t(k));
    const table = document.createElement('table');
    table.append(head);
    for (const [i, r] of rows.entries()) {
      const tr = document.createElement('tr');
      this.cell(tr, 'td', `${i + 1}. ${r.username}`);
      this.cell(tr, 'td', r.wave);
      this.cell(tr, 'td', r.kills);
      this.cell(tr, 'td', r.team);
      if (all) this.cell(tr, 'td', placeName(r.place));
      this.cell(tr, 'td', r.at);
      table.append(tr);
    }
    return table;
  }

  private fights(rows: { username: string; kills: number; deaths: number; headshots: number; wins: number }[]): HTMLElement[] {
    const head = document.createElement('tr');
    const titles = paintball.on ? (['lb.player', 'paint.tags', 'paint.taggedCol', 'paint.ratio', 'paint.bullseyes', 'lb.wins'] as const) : (['lb.player', 'lb.kills', 'lb.deaths', 'lb.kd', 'lb.headshots', 'lb.wins'] as const);
    for (const k of titles) this.cell(head, 'th', t(k));
    const body = rows
      .sort((a, b) => b.wins - a.wins || b.kills - a.kills || a.deaths - b.deaths)
      .map((r) => {
        const tr = document.createElement('tr');
        const kd = r.deaths ? num(r.kills / r.deaths, 2) : String(r.kills);
        for (const v of [r.username, r.kills, r.deaths, kd, r.headshots, r.wins]) this.cell(tr, 'td', v);
        return tr;
      });
    const table = document.createElement('table');
    table.append(head, ...body);
    const note = document.createElement('p');
    note.className = 'lb-note';
    note.textContent = t(rows.length ? 'lb.note' : paintball.on ? 'paint.lbEmpty' : 'lb.empty');
    return [table, note];
  }
}
