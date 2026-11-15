// The scores in the pause menu (src/ui/leaderboard.ts): the boards of Zombies, the timed routes, the gnomes and the party
// games for everyone, and the fights' totals together.
import { api, errorText, type ZombieRun } from '../net/client';
import { lang, num, onLang, t, type PlainKey } from '../i18n';
import { paintball } from '../paintball';
import { ARENAS } from '../../shared/arenas.mjs';
import { cleanTime, formatTime } from '../../shared/goals.mjs';
import { onDevice } from '../world/goals';
import { ROUTE_LIST } from '../world/routes';

/** The places a Zombies game is played at (shared/arenas.mjs), for the board's filter. */
const PLACES = ARENAS.map((a) => a.id);
const placeName = (id: string) => (PLACES.includes(id) ? t(`portal.${id}` as PlainKey) : id);

type Tab = 'zombies' | 'races' | 'gnomes' | 'games' | 'fights';
const TABS: Tab[] = ['zombies', 'races', 'gnomes', 'games', 'fights'];
/** The party games on their board, each a column (server/store.mjs GAME_KINDS), headed by the game's own name. */
const GAMES = ['hide', 'tag', 'treasure', 'teams'] as const;
/** The routes' boards answer and your own lines are kept this long (ms): the server builds the boards every 15 s too. */
const KEEP_MS = 15_000;
/** A board shows at most this many rows (the server sends ten). */
const ROWS = 10;
/** The highest place or count shown: a whole number from 0 */
const BIG = 9999;

interface Boards {
  races: Map<string, { name: string; ms: number; at: string }[]>;
  gnomes: { name: string; n: number; at: string }[];
  games: ({ name: string; wins: number } & Record<(typeof GAMES)[number], number>)[];
  total: number;
}

interface Mine {
  /** False for a guest (the server's `{}`): no own lines */
  account: boolean;
  races: Map<string, { ms: number; place: number }>;
  gnomes: number | null;
  wins: number | null;
}

/** A whole number from `min` to `max`, else null. */
function whole(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** A player's name from the server: a string of 1 to 40 characters, else null (it goes in with textContent only). */
function name(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : null;
}

/** A day as the server writes it (YYYY-MM-DD), else ''. */
function day(v: unknown): string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, ROWS) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * GET /api/boards as the page uses it: only routes of the page's own list, only rows whose every field checks out (a
 * name, a time the game keeps, whole numbers in range, a day); anything else is left out.
 */
function readBoards(raw: unknown): Boards {
  const o = rec(raw);
  const races = new Map<string, { name: string; ms: number; at: string }[]>();
  const byRoute = rec(o.races);
  for (const r of ROUTE_LIST) {
    const rows: { name: string; ms: number; at: string }[] = [];
    for (const x of list(Object.hasOwn(byRoute, r.id) ? byRoute[r.id] : null)) {
      const v = rec(x);
      const n = name(v.username), ms = cleanTime(v.ms);
      if (n !== null && ms !== null && ms === v.ms) rows.push({ name: n, ms, at: day(v.at) });
    }
    races.set(r.id, rows);
  }
  const total = whole(o.gnomeTotal, 1, 200) ?? onDevice().total;
  const gnomes: Boards['gnomes'] = [];
  for (const x of list(o.gnomes)) {
    const v = rec(x);
    const n = name(v.username), found = whole(v.n, 1, total);
    if (n !== null && found !== null) gnomes.push({ name: n, n: found, at: day(v.at) });
  }
  const games: Boards['games'] = [];
  for (const x of list(o.games)) {
    const v = rec(x);
    const n = name(v.username), wins = whole(v.wins, 0, BIG);
    const each = GAMES.map((k) => whole(v[k], 0, BIG));
    if (n === null || wins === null || each.some((w) => w === null)) continue;
    games.push({ name: n, wins, hide: each[0]!, tag: each[1]!, treasure: each[2]!, teams: each[3]! });
  }
  return { races, gnomes, games, total };
}

/** GET /api/boards/mine, checked as the boards: `{}` (a guest) has no own lines. */
function readMine(raw: unknown): Mine {
  const o = rec(raw);
  const races = new Map<string, { ms: number; place: number }>();
  const byRoute = rec(o.races);
  for (const r of ROUTE_LIST) {
    const v = rec(Object.hasOwn(byRoute, r.id) ? byRoute[r.id] : null);
    const ms = cleanTime(v.ms), place = whole(v.place, 1, BIG);
    if (ms !== null && ms === v.ms && place !== null) races.set(r.id, { ms, place });
  }
  return { account: o.races !== undefined, races, gnomes: whole(o.gnomes, 0, BIG), wins: whole(rec(o.games).wins, 0, BIG) };
}

/**
 * The scores in the pause menu (Yoshi, 7 Nov 2026: accounts only on the board; 15 Nov: "klassement moet alles tonen,
 * ook de races enzo"). One board at a time, picked with the buttons above it: the best Zombies runs (each account's
 * best anywhere, or the best at one place), the best time on each timed route, the gnomes found, the party games won;
 * together only, the fights' all-time totals per account (kills, deaths, headshots, round wins), in paintball's words
 * while you play it. Under a board, your own line on it (together) and what this browser keeps ("on this device":
 * results set alone never go on a board). Fetched when the board opens, kept briefly; nothing before. Everything from
 * the server is checked and goes in with textContent only; route ids are matched to the page's own list.
 */
export class Leaderboard {
  private box = document.getElementById('leaderboard')!;
  private button = document.getElementById('leaderboard-btn')!;
  private open = false;
  private loggedIn = false;
  private place = '';
  private tab: Tab = 'zombies';
  private route = ROUTE_LIST[0]?.id ?? 'foot';
  /** The last boards and your own lines, when they came (performance.now), and whether the last try failed */
  private boards: Boards | null = null;
  private boardsAt = -Infinity;
  private boardsFailed = false;
  private mine: Mine | null = null;
  private mineAt = -Infinity;
  /** Each load counts up: an older answer that comes late is not drawn over a newer one */
  private loads = 0;

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
    this.button.querySelector('span')!.textContent = t('lb.allSub');
  }

  /** The button is always there; the fights' totals only while playing together (the server's answer needs a session). */
  show(loggedIn: boolean): void {
    this.button.classList.remove('hidden');
    if (loggedIn !== this.loggedIn) {
      this.loggedIn = loggedIn;
      this.mine = null; // another session: its own lines are fetched again
      this.mineAt = -Infinity;
      if (!loggedIn && this.tab === 'fights') this.tab = 'zombies';
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

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  private note(text: string): HTMLElement {
    return this.el('p', 'lb-note', text);
  }

  /** A row of buttons, one pressed: the boards, or the routes. */
  private picker<T extends string>(cls: string, items: { id: T; text: string }[], now: T, pick: (id: T) => void): HTMLElement {
    const row = this.el('div', `seg lb-pick ${cls}`);
    row.setAttribute('role', 'group');
    for (const it of items) {
      const b = this.el('button', `seg-btn${it.id === now ? ' selected' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(it.id === now));
      b.append(this.el('b', '', it.text));
      b.addEventListener('click', () => {
        if (it.id === now) return;
        pick(it.id);
        void this.load();
      });
      row.append(b);
    }
    return row;
  }

  private table(heads: string[], rows: (string | number)[][]): HTMLElement {
    const head = document.createElement('tr');
    for (const h of heads) this.cell(head, 'th', h);
    const table = document.createElement('table');
    table.append(head);
    for (const r of rows) {
      const tr = document.createElement('tr');
      for (const v of r) this.cell(tr, 'td', v);
      table.append(tr);
    }
    const wrap = this.el('div', 'lb-table');
    wrap.append(table);
    return wrap;
  }

  private async load(): Promise<void> {
    const n = ++this.loads;
    if (!this.loggedIn && this.tab === 'fights') this.tab = 'zombies';
    const tabs = TABS.filter((k) => k !== 'fights' || this.loggedIn);
    const parts: HTMLElement[] = [this.picker('lb-tabs', tabs.map((id) => ({ id, text: t(`lb.tab.${id}` as PlainKey) })), this.tab, (id) => (this.tab = id))];
    if (this.tab === 'zombies') parts.push(...(await this.zombies()));
    else if (this.tab === 'fights') parts.push(...(await this.fightsPart()));
    else {
      await this.fetchBoards();
      if (this.tab === 'races') parts.push(...this.races());
      else if (this.tab === 'gnomes') parts.push(...this.gnomes());
      else parts.push(...this.games());
    }
    if (this.open && n === this.loads) this.box.replaceChildren(...parts);
  }

  /** The boards and your own lines, fetched again when older than KEEP_MS; a failed fetch keeps the last. */
  private async fetchBoards(): Promise<void> {
    const now = performance.now();
    const jobs: Promise<void>[] = [];
    if (now - this.boardsAt > KEEP_MS) {
      jobs.push(api.boards().then(
        (b) => {
          this.boards = readBoards(b);
          this.boardsAt = performance.now();
          this.boardsFailed = false;
        },
        () => {
          this.boardsFailed = true;
          this.boardsAt = performance.now() - KEEP_MS + 3000; // tried again in a few seconds, not on every click
        },
      ));
    }
    if (this.loggedIn && now - this.mineAt > KEEP_MS) {
      jobs.push(api.boardsMine().then(
        (m) => {
          this.mine = readMine(m);
          this.mineAt = performance.now();
        },
        () => {
          this.mineAt = performance.now() - KEEP_MS + 3000; // the last, or none
        },
      ));
    }
    await Promise.all(jobs);
  }

  /** No boards (yet): a quiet line instead. */
  private unavailable(): HTMLElement[] {
    return [this.note(t('board.offline'))];
  }

  private time(ms: number): string {
    return formatTime(ms, lang() === 'nl');
  }

  private races(): HTMLElement[] {
    const route = ROUTE_LIST.find((r) => r.id === this.route) ?? ROUTE_LIST[0];
    const by = (id: string) => (id === 'bike' ? t('route.by.bike') : id === 'car' ? t('route.by.car') : t('route.by.foot'));
    const routeName = (id: string) => (id === 'bike' ? t('route.bike') : id === 'car' ? t('route.car') : t('route.foot'));
    const parts: HTMLElement[] = [
      this.el('h3', 'lb-title', t('lb.races')),
      this.picker('lb-routes', ROUTE_LIST.map((r) => ({ id: r.id, text: by(r.id) })), route.id, (id) => (this.route = id)),
      this.el('p', 'lb-sub', routeName(route.id)),
    ];
    const tonightOnly = route.id === 'car'; // the car route counts for tonight only (server/goals.mjs): its list stays empty
    if (!this.boards) parts.push(...this.unavailable());
    else {
      const rows = this.boards.races.get(route.id) ?? [];
      if (rows.length) parts.push(this.table([t('lb.player'), t('lb.time'), t('lb.date')], rows.map((r, i) => [`${i + 1}. ${r.name}`, this.time(r.ms), r.at])));
      else if (!tonightOnly) parts.push(this.note(t('lb.rEmpty')));
      if (this.boardsFailed) parts.push(this.note(t('board.offline')));
    }
    const own = this.mineLines();
    if (own && !tonightOnly) {
      const mine = own.races.get(route.id);
      parts.push(this.el('p', 'lb-mine', mine ? t('lb.mine', { time: this.time(mine.ms), n: mine.place }) : t('lb.mineNone')));
    }
    const device = onDevice().best[route.id];
    if (device !== undefined) parts.push(this.el('p', 'lb-mine', t('lb.device', { time: this.time(device) })));
    parts.push(this.note(t(tonightOnly ? 'lb.rTonight' : 'lb.rNote')));
    return parts;
  }

  private gnomes(): HTMLElement[] {
    const parts: HTMLElement[] = [this.el('h3', 'lb-title', t('lb.gnomes'))];
    const device = onDevice();
    const total = this.boards?.total ?? device.total;
    if (!this.boards) parts.push(...this.unavailable());
    else {
      const rows = this.boards.gnomes;
      if (rows.length) parts.push(this.table([t('lb.player'), t('lb.found'), t('lb.date')], rows.map((r, i) => [`${i + 1}. ${r.name}`, t('lb.count', { n: r.n, total }), r.at])));
      else parts.push(this.note(t('lb.gEmpty')));
      if (this.boardsFailed) parts.push(this.note(t('board.offline')));
    }
    const own = this.mineLines();
    if (own) parts.push(this.el('p', 'lb-mine', own.gnomes ? t('lb.gMine', { n: own.gnomes, total }) : t('lb.mineNone')));
    if (device.found > 0) parts.push(this.el('p', 'lb-mine', t('lb.gDevice', { n: device.found, total: device.total })));
    parts.push(this.note(t('lb.gNote')));
    return parts;
  }

  private games(): HTMLElement[] {
    const parts: HTMLElement[] = [this.el('h3', 'lb-title', t('lb.games'))];
    if (!this.boards) parts.push(...this.unavailable());
    else {
      const rows = this.boards.games;
      if (rows.length) {
        const heads = [t('lb.player'), t('lb.won'), ...GAMES.map((k) => t(`game.${k}` as PlainKey))];
        parts.push(this.table(heads, rows.map((r, i) => [`${i + 1}. ${r.name}`, r.wins, ...GAMES.map((k) => r[k])])));
      } else parts.push(this.note(t('lb.pEmpty')));
      if (this.boardsFailed) parts.push(this.note(t('board.offline')));
    }
    const own = this.mineLines();
    if (own) parts.push(this.el('p', 'lb-mine', own.wins ? t('lb.pMine', { n: own.wins }) : t('lb.mineNone')));
    parts.push(this.note(t('lb.accountsOnly')));
    return parts;
  }

  /** Your own lines, for an account or the admin playing together; null for a guest, alone, or before they came. */
  private mineLines(): Mine | null {
    return this.loggedIn && this.mine?.account ? this.mine : null;
  }

  private async zombies(): Promise<HTMLElement[]> {
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
    return parts;
  }

  /** The fights' totals: together only. */
  private async fightsPart(): Promise<HTMLElement[]> {
    const f = document.createElement('h3');
    f.className = 'lb-title';
    f.textContent = t('lb.fights');
    try {
      return [f, ...this.fights((await api.leaderboard()).rows)];
    } catch (e) {
      const p = document.createElement('p');
      p.textContent = errorText(e)();
      return [f, p];
    }
  }

  private zombieTable(rows: ZombieRun[]): HTMLElement {
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
    const wrap = this.el('div', 'lb-table');
    wrap.append(table);
    return wrap;
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
    const wrap = this.el('div', 'lb-table');
    wrap.append(table);
    const note = document.createElement('p');
    note.className = 'lb-note';
    note.textContent = t(rows.length ? 'lb.note' : paintball.on ? 'paint.lbEmpty' : 'lb.empty');
    return [wrap, note];
  }
}
