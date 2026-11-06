import { api, errorText } from '../net/client';
import { num, onLang, t } from '../i18n';
import { paintball } from '../paintball';

/** All-time totals per account (kills, deaths, headshots, round wins), in the pause menu; in paintball's words while you play it. */
export class Leaderboard {
  private box = document.getElementById('leaderboard')!;
  private button = document.getElementById('leaderboard-btn')!;
  private open = false;

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
  }

  /** The button only makes sense when logged in. */
  show(loggedIn: boolean): void {
    this.button.classList.toggle('hidden', !loggedIn);
    if (!loggedIn) {
      this.open = false;
      this.box.replaceChildren();
      this.label();
    }
  }

  /** Reload when the menu opens again. */
  refresh(): void {
    if (this.open) void this.load();
  }

  private async load(): Promise<void> {
    try {
      const { rows } = await api.leaderboard();
      const head = document.createElement('tr');
      const titles = paintball.on ? (['lb.player', 'paint.tags', 'paint.taggedCol', 'paint.ratio', 'paint.bullseyes', 'lb.wins'] as const) : (['lb.player', 'lb.kills', 'lb.deaths', 'lb.kd', 'lb.headshots', 'lb.wins'] as const);
      for (const h of titles) {
        const th = document.createElement('th');
        th.textContent = t(h);
        head.append(th);
      }
      const body = rows
        .sort((a, b) => b.wins - a.wins || b.kills - a.kills || a.deaths - b.deaths)
        .map((r) => {
          const tr = document.createElement('tr');
          const kd = r.deaths ? num(r.kills / r.deaths, 2) : String(r.kills);
          for (const v of [r.username, r.kills, r.deaths, kd, r.headshots, r.wins]) {
            const td = document.createElement('td');
            td.textContent = String(v);
            tr.append(td);
          }
          return tr;
        });
      const table = document.createElement('table');
      table.append(head, ...body);
      const note = document.createElement('p');
      note.className = 'lb-note';
      note.textContent = t(rows.length ? 'lb.note' : paintball.on ? 'paint.lbEmpty' : 'lb.empty');
      this.box.replaceChildren(table, note);
    } catch (e) {
      this.box.textContent = errorText(e)();
    }
  }
}
