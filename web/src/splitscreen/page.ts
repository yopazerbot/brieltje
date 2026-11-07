/**
 * The split screen (/splitscreen, Yoshi, 7 Nov 2026): two to four players on one computer, each in a
 * copy of the game (an iframe of `/`) with a controller of their own, all playing together. Linked
 * from nowhere; Yoshi gives out the address.
 *
 * Four steps, readable from the couch and all of them doable with a controller (the D-pad or stick
 * moves, the lowest face button chooses, the right one goes back, Options goes on):
 * 1. How many players: 2, 3 or 4.
 * 2. The controllers: the first controller that presses a button is player 1, the next player 2, and
 *    so on, whatever the browser's own order. Its card lights up in the player's colour with the
 *    controller's kind and name, and the controller rumbles. Player 1 may take the keyboard and mouse.
 * 3. The names (typed, or picked from suggestions: on a controller the top face button gives another)
 *    and the PIN once (typed, or on the number pad on screen).
 * 4. Start: this page joins every seat itself, one after the other, with the seat in the X-Briel-Seat
 *    header: the server gives each seat a session cookie of its own (server/auth.mjs seatOf). Each
 *    card shows how its join went; a refusal (a wrong PIN, a name taken, the game full) shows on its
 *    card and is put right in step 3 without starting over. The PIN stays in this page, never in a
 *    URL or a frame, and is forgotten once every seat has joined.
 * Then the copies start one by one (each loads the whole world). A copy knows its seat from its frame
 * (src/seat.ts) and tells this page how it is doing by postMessage: only messages from our own
 * origin, and from one of our own frames, count. Every text goes in with textContent.
 */
import { btnOf, familyName, familyOf, type PadFamily } from '../controls/padFamily';
import { applyStatic, listOf, onLang, serverText, setLang, t, type Lang } from '../i18n';
import { SEAT_COLOURS } from '../seat';
import './page.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SEATS = 4;
const NAME_RE = /^[a-z0-9_-]{2,20}$/; // the server's own rule (server/auth.mjs); it checks again
/** How long a copy may take to start before the next one starts anyway. */
const NEXT_AFTER_MS = 15_000;
/** Each player's colour on the cards and on the tag in their view (the game gives its own colours to the figures). */
const COLOURS = SEAT_COLOURS;

interface Seat {
  n: number;
  /** The controller's index (Gamepad API) once it pressed a button; null while waiting */
  pad: number | null;
  /** Player 1 plays with the keyboard and mouse */
  kbm: boolean;
  name: string;
  state: 'wait' | 'joining' | 'joined' | 'error';
  error: string;
  /** Where in the suggested names this player is (step 3) */
  pick: number;
}

const seats: Seat[] = Array.from({ length: SEATS }, (_, i) => ({ n: i + 1, pad: null, kbm: false, name: '', state: 'wait', error: '', pick: i * 3 }));
let count = 2;
let step = 1;
const playing = () => seats.slice(0, count);

/** One call to our server, for seat `n`. */
async function call(n: number, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Briel-Seat': String(n), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

/** A refusal in this page's language (the server's code), else its English text. */
const refusal = (r: { status: number; data: Record<string, unknown> }) =>
  serverText(r.data.code, r.data.args, typeof r.data.error === 'string' && r.data.error ? r.data.error : t('err.status', { n: r.status }));

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const padsNow = () => (navigator.getGamepads ? navigator.getGamepads() : []);
const padAt = (i: number | null) => (i === null || i < 0 ? null : padsNow()[i] ?? null);
/** A controller's name without the browser's additions ("(STANDARD GAMEPAD Vendor: ...)"). */
const padName = (p: Gamepad) => (p.id.replace(/\s*\(.*$/, '').trim() || p.id).slice(0, 48);
const famOf = (s: Seat): PadFamily | null => {
  const p = padAt(s.pad);
  return p ? familyOf(p.id) : null;
};

// ---- The steps
function show(next: number): void {
  step = next;
  for (let i = 1; i <= 4; i++) $(`step-${i}`).hidden = i !== step;
  document.querySelectorAll<HTMLElement>('#steps li').forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle('current', s === step);
    li.classList.toggle('done', s < step);
    if (s === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  render();
  // Where the keyboard's and the controller's focus starts.
  const first = step === 1 ? document.querySelector<HTMLElement>(`[data-count="${count}"]`)
    : step === 2 ? $('step-2').querySelector<HTMLElement>('[data-next]')
    : step === 3 ? $('name-cards').querySelector<HTMLElement>('.chip')
    : $('start');
  first?.focus({ preventScroll: true });
}

function render(): void {
  document.querySelectorAll<HTMLElement>('.count').forEach((b) => {
    b.querySelector('span')!.textContent = t('split.countN', { n: Number(b.dataset.count) });
    b.classList.toggle('selected', Number(b.dataset.count) === count);
  });
  if (step === 2) renderPads();
  if (step === 3) renderNames();
  if (step === 4) renderStart();
}

/** The top of a player's card: the colour and "Player n". */
function cardOf(s: Seat, lit: boolean): HTMLElement {
  const card = el('div', `seat${lit ? ' on' : ''}`);
  card.style.setProperty('--c', COLOURS[s.n - 1]);
  card.append(el('p', 'who', t('split.player', { n: s.n })));
  return card;
}

/** Step 2: a card per player, waiting for a button, or showing its controller. */
function renderPads(): void {
  const cards = playing().map((s) => {
    const p = padAt(s.pad);
    const card = cardOf(s, s.kbm || !!p);
    if (s.kbm) {
      card.append(el('p', 'what', t('split.useKbm')), el('p', 'small muted', t('split.kbmNote')));
      const back = el('button', 'btn ghost small', t('split.padBtn'));
      back.type = 'button';
      back.addEventListener('click', () => {
        s.kbm = false;
        renderPads();
      });
      card.append(back);
    } else if (p) {
      card.append(el('p', 'what', familyName(familyOf(p.id))), el('p', 'small muted', padName(p)));
      const change = el('button', 'btn ghost small', t('split.change'));
      change.type = 'button';
      change.addEventListener('click', () => {
        s.pad = null; // the next controller to press a button takes this seat
        renderPads();
      });
      card.append(change);
    } else {
      card.append(el('p', 'what waiting', t('split.padWait')));
      if (s.n === 1) {
        const kbm = el('button', 'btn ghost small', t('split.kbmBtn'));
        kbm.type = 'button';
        kbm.addEventListener('click', () => {
          s.kbm = true;
          renderPads();
        });
        card.append(kbm);
      }
    }
    return card;
  });
  $('pad-cards').replaceChildren(...cards);
}

/** A controller pressed a button in step 2: it takes the first player still waiting, and rumbles. */
function assign(p: Gamepad): void {
  if (playing().some((s) => s.pad === p.index)) return;
  const s = playing().find((x) => !x.kbm && x.pad === null);
  if (!s) return;
  s.pad = p.index;
  $('pads-error').hidden = true;
  const act = p.vibrationActuator as { playEffect?: (t: string, o: object) => Promise<unknown> } | null | undefined;
  act?.playEffect?.('dual-rumble', { duration: 180, strongMagnitude: 0.6, weakMagnitude: 0.6 }).catch(() => {});
  renderPads();
  if (playing().every((x) => x.kbm || x.pad !== null)) $('step-2').querySelector<HTMLElement>('[data-next]')!.focus({ preventScroll: true });
}

/** The suggested names for this language, valid by the server's rule. */
const suggestions = () => t('split.names').split(',').map((s) => s.trim()).filter((s) => NAME_RE.test(s));
/** The next suggestion for seat `s` that no other player has. */
function nextName(s: Seat): string {
  const list = suggestions();
  const taken = new Set(playing().filter((x) => x !== s).map((x) => x.name));
  for (let i = 1; i <= list.length; i++) {
    const name = list[(s.pick + i) % list.length];
    if (!taken.has(name)) {
      s.pick = (s.pick + i) % list.length;
      return name;
    }
  }
  return s.name;
}
/** A player's controller asked for another name (its top face button), or a chip was picked. */
function setName(s: Seat, name: string): void {
  s.name = name;
  s.error = '';
  const input = document.getElementById(`name-${s.n}`) as HTMLInputElement | null;
  if (input) input.value = name;
  renderNames(document.activeElement?.id);
}

/** Step 3: a card per player with a name field and suggestions. */
function renderNames(keepFocus?: string): void {
  const list = suggestions();
  const cards = playing().map((s) => {
    const card = cardOf(s, true);
    const input = el('input');
    input.id = `name-${s.n}`;
    input.maxLength = 20;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = t('split.namePh');
    input.setAttribute('aria-label', t('split.player', { n: s.n }));
    input.value = s.name;
    input.addEventListener('input', () => {
      s.name = input.value;
      s.error = '';
      card.querySelector('.error')?.remove();
    });
    const chips = el('div', 'chips');
    const taken = new Set(playing().filter((x) => x !== s).map((x) => x.name));
    for (let i = 0, shown = 0; i < list.length && shown < 3; i++) {
      const name = list[(s.pick + i) % list.length];
      if (taken.has(name) || name === s.name) continue;
      shown++;
      const chip = el('button', 'chip', name);
      chip.type = 'button';
      chip.id = `chip-${s.n}-${shown}`;
      chip.addEventListener('click', () => setName(s, name));
      chips.append(chip);
    }
    const more = el('button', 'chip more', t('split.roll'));
    more.type = 'button';
    more.id = `more-${s.n}`;
    more.addEventListener('click', () => {
      s.pick = (s.pick + 3) % list.length;
      renderNames(more.id);
    });
    chips.append(more);
    card.append(input, chips);
    const fam = famOf(s);
    if (fam) card.append(el('p', 'small muted', t('split.rollPad', { btn: btnOf(fam, 'north') })));
    if (s.error) card.append(el('p', 'error', s.error));
    return card;
  });
  $('name-cards').replaceChildren(...cards);
  if (keepFocus) document.getElementById(keepFocus)?.focus({ preventScroll: true });
}

/** Step 4: a card per player with how its join is going. */
function renderStart(): void {
  const cards = playing().map((s) => {
    const card = cardOf(s, s.state === 'joined');
    const p = padAt(s.pad);
    card.append(el('p', 'what', s.name), el('p', 'small muted', s.kbm ? t('split.useKbm') : p ? familyName(familyOf(p.id)) : ''));
    const state = el('p', `state ${s.state}`, s.state === 'error' ? s.error : t(s.state === 'joining' ? 'split.joiningCard' : s.state === 'joined' ? 'split.joined' : 'split.waiting'));
    card.append(state);
    return card;
  });
  $('start-cards').replaceChildren(...cards);
}

// ---- Step 1: how many
document.querySelectorAll<HTMLButtonElement>('.count').forEach((b) =>
  b.addEventListener('click', () => {
    count = Number(b.dataset.count);
    remember();
    for (const s of seats.slice(count)) s.pad = null;
    show(2);
  }),
);

// ---- Back and Next
document.querySelectorAll<HTMLButtonElement>('[data-back]').forEach((b) => b.addEventListener('click', back));
document.querySelectorAll<HTMLButtonElement>('[data-next]').forEach((b) => b.addEventListener('click', next));
function back(): void {
  if (step > 1 && !busy) show(step - 1);
}
function next(): void {
  if (step === 1) return show(2);
  if (step === 2) {
    if (!playing().every((s) => s.kbm || s.pad !== null)) {
      $('pads-error').textContent = t('split.errPads');
      $('pads-error').hidden = false;
      return;
    }
    // Some suggestions for those without a name yet.
    for (const s of playing()) if (!s.name) s.name = nextName(s);
    return show(3);
  }
  if (step === 3) {
    if (checkNames()) show(4);
    return;
  }
  void start();
}

/** Step 3's checks: a valid name each, all different, the PIN, the age. The complaint where it belongs. */
function checkNames(): boolean {
  for (const id of ['pin-error', 'names-error']) $(id).hidden = true;
  let ok = true;
  const seen = new Set<string>();
  for (const s of playing()) {
    s.name = s.name.trim().toLowerCase();
    s.error = !s.name ? t('split.errNames') : !NAME_RE.test(s.name) ? t('srv.nameFormat') : seen.has(s.name) ? t('split.errSame') : s.error;
    if (s.error) ok = false;
    seen.add(s.name);
  }
  renderNames();
  if (!ok) {
    $('name-cards').querySelector<HTMLElement>('.error')?.closest('.seat')?.querySelector('input')?.focus();
    return false;
  }
  if (!$<HTMLInputElement>('pin').value) {
    pinError(t('err.pin'));
    return false;
  }
  if (!$<HTMLInputElement>('age').checked) {
    $('names-error').textContent = t('err.age');
    $('names-error').hidden = false;
    $('age').focus();
    return false;
  }
  return true;
}
function pinError(text: string): void {
  $('pin-error').textContent = text;
  $('pin-error').hidden = false;
}

// The number pad for the PIN: for a controller, or a touch screen.
{
  const pad = $('numpad');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0']) {
    const b = el('button', k === 'del' ? 'key del' : 'key', k === 'del' ? '⌫' : k);
    b.type = 'button';
    if (k === 'del') b.setAttribute('aria-label', t('split.del'));
    b.addEventListener('click', () => {
      const pin = $<HTMLInputElement>('pin');
      pin.value = k === 'del' ? pin.value.slice(0, -1) : (pin.value + k).slice(0, 12);
      $('pin-error').hidden = true;
    });
    pad.append(b);
  }
}
$('pin').addEventListener('input', () => ($('pin-error').hidden = true));

// ---- Step 4: joining, one seat after the other
let busy = false;
$('fix').addEventListener('click', () => show(3));
async function start(): Promise<void> {
  if (busy) return;
  busy = true;
  $<HTMLButtonElement>('start').disabled = true;
  $('fix').hidden = true;
  $('start-error').hidden = true;
  const pin = $<HTMLInputElement>('pin');
  for (const s of playing()) if (s.state !== 'joined') s.state = 'wait';
  renderStart();
  try {
    for (const s of playing()) {
      s.state = 'joining';
      renderStart();
      // Joined already as this name (a second try after a refusal, or playing on): kept. As another: that one leaves first.
      const me = await call(s.n, 'GET', '/api/me');
      if (me.ok && me.data.username === s.name) {
        s.state = 'joined';
        continue;
      }
      if (me.ok) await call(s.n, 'POST', '/api/logout', {});
      const r = await call(s.n, 'POST', '/api/join', { name: s.name, pin: pin.value, age: true });
      if (!r.ok) {
        // One refusal stops the rest (a wrong PIN is counted by the server like any other): it shows on this
        // card, and in step 3, where it is put right.
        s.state = 'error';
        s.error = refusal(r);
        renderStart();
        if (r.data.code === 'wrongPin' || r.data.code === 'pinChanged' || r.data.code === 'pinDevice') {
          pinError(s.error);
          s.error = '';
        }
        $('fix').hidden = false;
        $('fix').focus();
        return;
      }
      s.state = 'joined';
      renderStart();
    }
    pin.value = '';
    // Seats past the players' number leave, so no session of an earlier evening lingers.
    for (let n = count + 1; n <= SEATS; n++) if (joined.has(n)) await call(n, 'POST', '/api/logout', {});
    play();
  } catch {
    $('start-error').textContent = t('net.lost');
    $('start-error').hidden = false;
  } finally {
    busy = false;
    $<HTMLButtonElement>('start').disabled = false;
  }
}

// ---- Remembered in this browser: how many play.
const KEY = 'briel.split';
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}') as { count?: unknown };
  if (saved.count === 2 || saved.count === 3 || saved.count === 4) count = saved.count;
} catch {
  // storage blocked: the default
}
function remember(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ count }));
  } catch {
    // private window: for this visit
  }
}

// ---- Seats that joined before (this page was reloaded): play on, or make room for new players.
const joined = new Map<number, string>(); // seat -> name
async function findJoined(): Promise<void> {
  for (let n = 1; n <= SEATS; n++) {
    const r = await call(n, 'GET', '/api/me').catch(() => null);
    if (r?.ok && typeof r.data.username === 'string') joined.set(n, r.data.username);
  }
  if (!joined.size) return;
  showAgain();
  $('again').hidden = false;
}
const showAgain = () => ($('again-text').textContent = t('split.again', { names: listOf([...joined.values()]) }));
$('go-on').addEventListener('click', () => {
  // The same players: their names kept, their controllers connected again in step 2.
  count = Math.max(2, ...joined.keys());
  for (const s of seats) {
    s.name = joined.get(s.n) ?? '';
    s.state = joined.has(s.n) ? 'joined' : 'wait';
  }
  show(2);
});
$('fresh').addEventListener('click', async () => {
  for (const n of joined.keys()) await call(n, 'POST', '/api/logout', {}).catch(() => null);
  joined.clear();
  for (const s of seats) {
    s.name = '';
    s.state = 'wait';
  }
  $('again').hidden = true;
  document.querySelector<HTMLElement>(`[data-count="${count}"]`)?.focus();
});

// ---- Controllers on the steps: the D-pad or stick moves the focus, the lowest face button chooses,
// the right one goes back, Options (Menu, +) goes on. In step 2 a controller not yet taken takes a seat.
const before = new Map<number, boolean[]>();
let moveAt = 0;
function focusables(): HTMLElement[] {
  const root = $(`step-${step}`);
  return [...root.querySelectorAll<HTMLElement>('button, input, summary')].filter((e) => !(e as HTMLButtonElement).disabled && e.offsetParent !== null);
}
function moveFocus(by: number): void {
  const list = focusables();
  if (!list.length) return;
  const i = list.indexOf(document.activeElement as HTMLElement);
  list[i < 0 ? 0 : (i + by + list.length) % list.length].focus({ preventScroll: false });
}
function padLoop(now: number): void {
  if (!$('setup').hidden) {
    for (const p of padsNow()) {
      if (!p?.connected) continue;
      const pressed = p.buttons.map((b) => b.pressed);
      const was = before.get(p.index) ?? [];
      before.set(p.index, pressed);
      const edge = (i: number) => !!pressed[i] && !was[i];
      const fresh = pressed.some((v, i) => v && !was[i]);
      if (fresh) usePad(p);
      const mine = playing().find((s) => s.pad === p.index);
      if (step === 2 && !mine) {
        if (fresh) assign(p);
        continue;
      }
      if (step === 3 && mine && edge(3)) {
        setName(mine, nextName(mine));
        continue;
      }
      const x = p.axes[0] ?? 0;
      const y = p.axes[1] ?? 0;
      const stick = Math.abs(x) > 0.6 || Math.abs(y) > 0.6 ? (y > 0.6 || x > 0.6 ? 1 : -1) : 0;
      const dir = edge(12) || edge(14) ? -1 : edge(13) || edge(15) ? 1 : 0;
      if (dir) moveFocus(dir);
      else if (stick && now - moveAt > 230) {
        moveAt = now;
        moveFocus(stick);
      }
      if (edge(0)) (document.activeElement as HTMLElement | null)?.click();
      else if (edge(1)) back();
      else if (edge(9)) next();
    }
    // A controller that went away gives its seat back.
    if (step === 2) for (const s of playing()) if (s.pad !== null && !padAt(s.pad)?.connected) {
      s.pad = null;
      renderPads();
    }
  }
  requestAnimationFrame(padLoop);
}
/** Once a controller is used on the steps: the focus shows, with a line on how to use it. */
let navFamily: PadFamily | null = null;
function usePad(p: Gamepad): void {
  document.body.classList.add('pad-on');
  navFamily = familyOf(p.id);
  showPadNav();
}
const showPadNav = () => {
  if (navFamily) $('pad-nav').textContent = t('split.padNav', { a: btnOf(navFamily, 'south'), b: btnOf(navFamily, 'east') });
};
document.addEventListener('mousedown', () => document.body.classList.remove('pad-on'));
requestAnimationFrame(padLoop);

// ---- The copies of the game
let players: Seat[] = [];
let frames: HTMLIFrameElement[] = [];
let nextTimer = 0;

function play(): void {
  players = playing();
  for (const s of players) joined.set(s.n, s.name);
  $('setup').hidden = true;
  const grid = $('grid');
  grid.replaceChildren();
  grid.dataset.count = String(players.length);
  grid.hidden = false;
  $('tools').hidden = false;
  frames = [];
  for (const s of players) {
    const cell = el('div', 'cell');
    const tag = el('span', 'tag', `${s.n} · ${s.name}`); // a name the server accepted, as text
    tag.style.setProperty('--c', COLOURS[s.n - 1]);
    cell.append(tag);
    grid.append(cell);
  }
  load(0);
}

/** Start copy `i`. Its seat goes on its frame before the frame loads (src/seat.ts reads it from there). */
function load(i: number): void {
  window.clearTimeout(nextTimer);
  const s = players[i];
  if (!s) return;
  const frame = document.createElement('iframe');
  frame.dataset.seat = String(s.n);
  frame.dataset.pad = s.kbm ? 'kbm' : String(s.pad);
  frame.dataset.views = String(players.length);
  frame.allow = 'autoplay; gamepad; fullscreen';
  frame.title = t('split.player', { n: s.n });
  frame.src = '/';
  frames[i] = frame;
  $('grid').children[i].prepend(frame);
  if (s.kbm) frame.addEventListener('load', () => frame.focus());
  nextTimer = window.setTimeout(() => load(i + 1), NEXT_AFTER_MS);
}

// What the copies say (src/seat.ts tellHost): only from our own origin and our own frames.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const i = frames.findIndex((f) => f.contentWindow === e.source);
  const m = e.data as { briel?: unknown; n?: unknown; state?: unknown };
  if (i < 0 || m?.briel !== 'seat' || m.n !== players[i]?.n) return;
  if ((m.state === 'playing' || m.state === 'alone') && !frames[i + 1]) load(i + 1); // the next one starts
  const tag = $('grid').children[i]?.querySelector<HTMLElement>('.tag');
  // Once it plays, the view shows its own tag top left (src/seat.ts), clear of its HUD: this one goes.
  if (tag && m.state === 'playing') tag.hidden = true;
  if (tag && m.state === 'ended') {
    tag.textContent = t('split.ended', { name: players[i].name });
    tag.classList.add('bad');
    tag.hidden = false;
  }
});

// ---- Full screen and stopping
$('full').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
});
let stopArmed = 0;
$('stop').addEventListener('click', async () => {
  // Twice, so a stray click doesn't end four games.
  if (performance.now() - stopArmed > 4000) {
    stopArmed = performance.now();
    $('stop').textContent = t('split.stopSure');
    window.setTimeout(() => {
      if (performance.now() - stopArmed >= 4000) $('stop').textContent = t('split.stop');
    }, 4100);
    return;
  }
  stopArmed = 0;
  $('stop').textContent = t('split.stop');
  window.clearTimeout(nextTimer);
  $('grid').replaceChildren(); // the copies close their connections
  frames = [];
  $('grid').hidden = true;
  $('tools').hidden = true;
  for (const s of players) await call(s.n, 'POST', '/api/logout', {}).catch(() => null);
  joined.clear();
  for (const s of seats) s.state = 'wait';
  $('again').hidden = true;
  $('setup').hidden = false;
  show(1);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
});

// ---- Language
document.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang as Lang)));
onLang(() => {
  document.title = t('split.title');
  $('numpad').querySelector('.del')?.setAttribute('aria-label', t('split.del'));
  showPadNav();
  if (joined.size) showAgain();
  render();
});
applyStatic();
document.title = t('split.title');
$('setup').hidden = false;
show(1);
void findJoined();
