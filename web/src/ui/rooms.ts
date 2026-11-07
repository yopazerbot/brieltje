/**
 * Zombies rooms in the menu's Together tab (Yoshi, 7 Nov 2026; server/rooms.mjs): the rooms open now with
 * a Join button each, opening one (for players with an account and the admin; a guest is told how), and,
 * in a room, who opened it, Start and Stop, and the way back to the open world.
 *
 * Joining or leaving moves this page's connection (src/net/client.ts switchTo): the server's welcome then
 * puts the world as that place has it. The list is asked for while the Together tab shows. Names from the
 * server go in with textContent only.
 */
import { t, onLang, type PlainKey } from '../i18n';
import { api, errorText, type Me, type Net, type RoomEntry } from '../net/client';

const $ = (id: string) => document.getElementById(id)!;

export interface RoomsHooks {
  me: () => Me | null;
  /** The menu shows the Together tab right now (the list is asked for only then). */
  watching: () => boolean;
  /** A line in the chat. */
  say: (text: () => string) => void;
}

export class Rooms {
  /** The room this page plays in, from the server's welcome; null in the open world. */
  current: { id: string; owner: string; place: string } | null = null;
  private list: RoomEntry[] = [];
  private playing = false;
  private note: (() => string) | null = null;

  constructor(private net: Net, private hooks: RoomsHooks) {
    $('room-open-btn').addEventListener('click', () => void this.open());
    $('room-leave').addEventListener('click', () => this.leave());
    $('room-start').addEventListener('click', () => this.net.send({ t: 'mode', kind: 'zombies' }));
    $('room-stop').addEventListener('click', () => this.net.send({ t: 'mode', kind: 'free' }));
    net.onRoomGone = (why) => {
      this.current = null;
      this.hooks.say(() => t(why === 'full' ? 'room.fullBack' : 'room.gone'));
      this.draw();
    };
    // While the Together tab shows: the list every few seconds (who joined, which wave).
    setInterval(() => this.hooks.watching() && this.hooks.me() && void this.refresh(), 4000);
    onLang(() => this.draw());
  }

  /** Where this page plays, from the server's welcome (null: the open world). */
  setCurrent(room: { id: string; owner: string; place: string } | null | undefined): void {
    const was = this.current?.id ?? null;
    this.current = room ?? null;
    if (this.current && this.current.id !== was) {
      const r = this.current;
      this.hooks.say(() => t('room.joined', { name: r.owner, place: placeName(r.place) }));
    }
    this.draw();
  }

  /** A game runs in the room or not (the Start and Stop buttons follow). */
  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    this.draw();
  }

  /** Playing together started or ended: the list now, or nothing. */
  follow(account: Me | null): void {
    if (!account) {
      this.current = null;
      this.net.room = null; // alone: the next time together starts in the open world
      this.list = [];
    } else void this.refresh();
    this.draw();
  }

  async refresh(): Promise<void> {
    try {
      this.list = (await api.rooms()).rooms;
    } catch {
      return; // the server out of reach: the last list stays
    }
    this.draw();
  }

  private async open(): Promise<void> {
    try {
      const { room } = await api.openRoom(($('room-place') as HTMLSelectElement).value);
      this.note = null;
      this.net.switchTo(room.id);
    } catch (e) {
      this.note = errorText(e);
    }
    this.draw();
  }

  private join(id: string): void {
    this.note = null;
    this.net.switchTo(id);
  }

  private leave(): void {
    this.current = null;
    this.playing = false;
    this.net.switchTo(null);
    this.hooks.say(() => t('room.left'));
    this.draw();
  }

  private draw(): void {
    const me = this.hooks.me();
    $('rooms').classList.toggle('hidden', !me);
    const here = this.current;
    $('room-here').classList.toggle('hidden', !here);
    $('room-out').classList.toggle('hidden', !!here);
    if (here) {
      const place = placeName(here.place);
      $('room-in').textContent = here.owner === me?.username ? t('room.inMine', { place }) : t('room.in', { name: here.owner, place });
      // Anyone starts a game; only accounts and the admin stop one (server/game.mjs 'mode').
      $('room-start').classList.toggle('hidden', this.playing);
      $('room-stop').classList.toggle('hidden', !this.playing || me?.role === 'guest');
    }
    const canOpen = me?.role === 'player' || me?.role === 'admin';
    $('room-open').classList.toggle('hidden', !canOpen);
    $('room-guest').classList.toggle('hidden', canOpen || !me);
    const ul = $('room-list');
    ul.replaceChildren();
    if (!this.list.length) {
      const li = document.createElement('li');
      li.className = 'room-none';
      li.textContent = t('room.none');
      ul.append(li);
    }
    for (const r of this.list) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.className = 'room-what';
      const title = document.createElement('b');
      title.textContent = `${t('room.of', { name: r.owner })} · ${placeName(r.place)}`;
      const sub = document.createElement('span');
      sub.textContent = `${t('room.players', { n: r.players, max: r.max })} · ${r.playing ? t('room.wave', { n: r.wave }) : t('room.waiting')}`;
      what.append(title, sub);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'mini go';
      const full = r.players >= r.max;
      go.textContent = t(full ? 'room.full' : 'room.join');
      go.disabled = full;
      go.addEventListener('click', () => this.join(r.id));
      li.append(what, go);
      ul.append(li);
    }
    $('room-msg').textContent = this.note?.() ?? '';
    $('room-msg').classList.toggle('bad', !!this.note);
  }
}

/** A place's name in the page's language (the portal's), or the id as it came. */
function placeName(id: string): string {
  const key = `portal.${id}`;
  return KNOWN.has(id) ? t(key as PlainKey) : id;
}
const KNOWN = new Set(['house', 'bungalow', 'church', 'molenhoek', 'molenhoek_mid', 'molenhoek_end']);
