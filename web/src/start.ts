/**
 * The page's entry: the start screen, which works before the world exists. The page brings only
 * this, the texts and the start picture, and asks the server who you are (/api/me). That covers
 * the language, your name, alone or together (joining with the PIN, the admin's login), the mode,
 * the graphics setting, the controller, and the Sound and Full screen buttons (the start screen's,
 * and the in-game menu's own in its header).
 *
 * The world (main.ts: three.js, the house, its textures, models, sky and sounds) is fetched only
 * when you pick how to play. The chosen start button shows how far it has loaded, and play begins
 * by itself once it is ready. Nothing in main.ts or the modules it imports runs before that click,
 * so a model or texture loaded the moment its module is read can't slip in early either.
 */
import { Input } from './controls/input';
import { loadMode, saveMode } from './graphics';
import { applyStatic, onLang, setLang, t, type Lang } from './i18n';
import { typing } from './keys';
import { api, errorText, type Me } from './net/client';
import { sound } from './sound';
import { Menu } from './ui/menu';

const $ = (id: string) => document.getElementById(id)!;

// Every text in the chosen language (src/i18n.ts); the buttons on the start screen and in the
// settings switch it at once.
applyStatic();
document.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang as Lang)));

export const input = new Input(document.getElementById('view') as HTMLCanvasElement);
export const menu = new Menu();
input.menuOpen = () => menu.open;
// Phones and tablets: Touch screen (offered on any touch screen), and the advice to use a laptop.
if (navigator.maxTouchPoints > 0) $('choose-touch').classList.remove('hidden');
if (matchMedia('(pointer: coarse)').matches) {
  // A phone or tablet: the note, and Touch screen first instead of keyboard and mouse.
  $('mobile-note').classList.remove('hidden');
  $('choose-kbm').classList.add('hidden');
  $('choose-touch').parentElement!.prepend($('choose-touch'));
}

// Sound on/off: the start screen's button (bottom right, top right on a touch screen), the icon in
// the in-game menu's header, or Shift+M.
const soundBtn = $('sound-btn');
const menuSound = $('menu-sound');
function showSound(): void {
  // Icon and word apart: a phone shows only the icon (style.css).
  soundBtn.children[0].textContent = sound.enabled ? '🔊' : '🔇';
  soundBtn.children[1].textContent = t(sound.enabled ? 'btn.sound' : 'btn.noSound');
  soundBtn.classList.toggle('off', !sound.enabled);
  menuSound.classList.toggle('off', !sound.enabled); // the crossed-out speaker
  menuSound.setAttribute('aria-pressed', String(sound.enabled));
}
function toggleSound(): void {
  sound.set(!sound.enabled);
  showSound();
}
soundBtn.addEventListener('click', () => {
  toggleSound();
  soundBtn.blur();
});
menuSound.addEventListener('click', toggleSound);
window.addEventListener('keydown', (e) => {
  // By the letter on the key, not its place (AZERTY); M alone opens the map (main.ts).
  if (e.key.toLowerCase() === 'm' && e.shiftKey && !e.repeat && !typing(e)) toggleSound();
});
showSound();

// Full screen on phones and tablets: the browser's own where it has one (Android, iPad). Safari on an
// iPhone has none for pages; there the game only fills the screen when started from the home screen
// (manifest.webmanifest), so the button says how. Started from the home screen, no button.
const fullBtn = $('full-btn');
const menuFull = $('menu-full'); // the same in the in-game menu's header
const fullHint = $('full-hint');
const fsDoc = document as Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
const fsRoot = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
const fromHomeScreen = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const canFill = !!(document.fullscreenEnabled || fsDoc.webkitFullscreenEnabled);
const isFull = () => !!(document.fullscreenElement || fsDoc.webkitFullscreenElement);
if (matchMedia('(pointer: coarse)').matches && !fromHomeScreen) {
  fullBtn.classList.remove('hidden');
  menuFull.classList.remove('hidden');
}
function showFull(): void {
  fullBtn.children[0].textContent = isFull() ? '⤡' : '⤢';
  fullBtn.children[1].textContent = t(isFull() ? 'btn.exitFull' : 'btn.full');
  menuFull.title = t(isFull() ? 'btn.exitFull' : 'btn.full');
  menuFull.setAttribute('aria-label', menuFull.title);
}
showFull();
fullBtn.addEventListener('click', () => {
  fullBtn.blur();
  toggleFull();
});
menuFull.addEventListener('click', toggleFull);
function toggleFull(): void {
  if (!canFill) {
    fullHint.classList.toggle('hidden');
    return;
  }
  if (isFull()) {
    if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
    else fsDoc.webkitExitFullscreen?.();
    return;
  }
  const entered = fsRoot.requestFullscreen ? fsRoot.requestFullscreen({ navigationUI: 'hide' }) : Promise.resolve(fsRoot.webkitRequestFullscreen?.());
  // Sideways where the browser allows locking it (Android); elsewhere the phone decides.
  const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  void entered.then(() => orientation.lock?.('landscape')).catch(() => {});
}
document.addEventListener('fullscreenchange', showFull);
document.addEventListener('webkitfullscreenchange', showFull);
document.addEventListener('pointerdown', (e) => {
  if (!(e.target instanceof Element && e.target.closest('#full-btn, #menu-full'))) fullHint.classList.add('hidden');
});
/** Starting with touch: full screen and sideways where the browser allows it (Android; an iPhone keeps its bars). Only from a tap. */
export function fillScreen(): void {
  document.documentElement.requestFullscreen?.().then(() => (screen.orientation as { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
}

// The graphics setting is only a setting until the world exists (main.ts takes this over then);
// Auto tests the graphics while the world loads.
menu.setGraphics(loadMode(), null, '');
menu.onGraphics = (next) => {
  saveMode(next);
  menu.setGraphics(next, null, '');
};

// ---- Alone or together: joining with the PIN, or the admin's login (the Admin link). It is all
// HTTP, so it works on the start screen. The world (main.ts) follows every change once it is there,
// and only then connects to the others.
export let me: Me | null = null;
/** The message under joining (start screen and Together tab), as a function: drawn again in another language. */
let accountMsg: (() => string) | null = null;
const accountListeners: ((account: Me | null) => void)[] = [];
/** Call `fn` with the account now and on every change (null: playing alone). */
export function onAccount(fn: (account: Me | null) => void): void {
  accountListeners.push(fn);
  fn(me);
}
/** "name", or "name (admin)" for the admin. */
const withRole = (account: Me) => (account.role === 'admin' ? t('role.admin', { name: account.username }) : account.username);
/** The texts that depend on the account: the name in the session box, the message, the note in the Together tab. */
function showAccountText(): void {
  $('mp-name').textContent = me ? withRole(me) : '';
  const message = accountMsg?.() ?? '';
  for (const id of ['mp-msg', 'mp-msg2']) {
    $(id).textContent = message;
    $(id).classList.toggle('bad', !!message && !me);
  }
  $('mp-note').textContent = me ? t('tog.noteTogether', { name: withRole(me) }) : t('tog.noteAlone');
}
export function setAccount(account: Me | null, message: (() => string) | null = null): void {
  me = account;
  accountMsg = message;
  menu.setAccount(account?.username ?? null);
  menu.setAdmin(account?.role === 'admin');
  $('mp-session').classList.toggle('hidden', !account);
  showAccountText();
  for (const fn of accountListeners) fn(account);
}
/**
 * "I'm 13 or older": asked where you join together, ticked once for this device (localStorage
 * briel.age13, every such tick box shows it), and sent with the join; the server refuses a join
 * without it.
 */
const AGE = 'briel.age13';
const ageBoxes = () => [...document.querySelectorAll<HTMLInputElement>('input[data-age13]')];
const ageOk = () => ageBoxes().some((b) => b.checked);
let ageSaved = false;
try {
  ageSaved = localStorage.getItem(AGE) === '1';
} catch {
  // storage blocked: asked again on every visit
}
for (const box of ageBoxes()) {
  box.checked = ageSaved;
  box.addEventListener('change', () => {
    for (const other of ageBoxes()) other.checked = box.checked;
    try {
      if (box.checked) localStorage.setItem(AGE, '1');
      else localStorage.removeItem(AGE);
    } catch {
      // private window: for this visit
    }
  });
}

/** The admin logs in under the name typed above, with the admin password. */
async function login(): Promise<void> {
  const user = ($('nick') as HTMLInputElement).value.trim();
  const pass = $('mp-pass') as HTMLInputElement;
  if (!user) return setAccount(null, () => t('err.nameFirst'));
  if (!pass.value) return setAccount(null, () => t('err.password'));
  try {
    const account = await api.login(user, pass.value);
    pass.value = '';
    setAccount(account);
  } catch (e) {
    setAccount(null, errorText(e));
  }
}
/**
 * Play together with the shared PIN: your name is your name in the game. From the start screen,
 * or from the menu's Together tab while playing alone (`name` then is the name you started with).
 */
async function join(name = ($('nick') as HTMLInputElement).value.trim(), pin = $('mp-pin') as HTMLInputElement): Promise<void> {
  if (!name || name === 'Guest') return setAccount(null, () => t('err.nameFirst'));
  if (!pin.value) return setAccount(null, () => t('err.pin'));
  // Playing together, with its chat, is for 13 and over: ticked once, remembered on this device.
  if (!ageOk()) return setAccount(null, () => t('err.age'));
  try {
    const account = await api.join(name, pin.value, ageOk());
    pin.value = '';
    setAccount(account);
  } catch (e) {
    setAccount(null, errorText(e));
  }
}
// Where to start (one of the portal places), remembered for the next visit; src/main.ts reads it.
{
  const spawn = $('spawn') as HTMLSelectElement;
  try {
    const saved = localStorage.getItem('briel.spawn');
    if (saved && [...spawn.options].some((o) => o.value === saved)) spawn.value = saved;
  } catch {
    // storage blocked: the main house
  }
  spawn.addEventListener('change', () => {
    try {
      localStorage.setItem('briel.spawn', spawn.value);
    } catch {
      // storage blocked: main.ts reads the select itself
    }
  });
}
// Alone or together on the start screen; the admin logs in with the admin password (the Admin link).
document.querySelectorAll<HTMLButtonElement>('[data-mp]').forEach((b) =>
  b.addEventListener('click', () => {
    const multi = b.dataset.mp === 'multi';
    document.querySelectorAll('[data-mp]').forEach((o) => o.classList.toggle('selected', o === b));
    $('mp-pin-row').classList.toggle('hidden', !multi);
    $('mp-age-row').classList.toggle('hidden', !multi);
    if (multi) {
      $('mp-login').classList.add('hidden');
      ($('mp-pin') as HTMLInputElement).focus();
    }
  }),
);
$('mp-join-btn').addEventListener('click', () => void join());
$('mp-pin').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void join();
});
const joinHere = () => void join(($('mp-nick2') as HTMLInputElement).value.trim() || menu.nickname, $('mp-pin2') as HTMLInputElement);
$('mp-join2').addEventListener('click', joinHere);
$('mp-pin2').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') joinHere();
});
$('mp-account').addEventListener('click', () => {
  const open = $('mp-login').classList.toggle('hidden') === false;
  if (open) {
    $('mp-pin-row').classList.add('hidden');
    ($('mp-pass') as HTMLInputElement).focus();
  }
});
$('mp-login-btn').addEventListener('click', () => void login());
$('mp-pass').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void login();
});
const leave = () => void api.logout().finally(() => setAccount(null));
$('mp-logout').addEventListener('click', leave);
$('mp-leave').addEventListener('click', leave);
api.me().then(setAccount).catch(() => setAccount(null));
// Another language: the texts made here that aren't drawn every frame (the modules redraw their own).
onLang(() => {
  showSound();
  showFull();
  showAccountText();
});

// The controller on the start screen: its name on the Controller button, ✕ starts with it, □
// changes the graphics, the D-pad the walking speed. From the first start on, the world's loop reads it.
function padLoop(): void {
  const frame = input.poll();
  menu.setPadState(input.padName);
  if (frame.confirmPressed) menu.resume('pad');
  else if (frame.squarePressed) menu.cycleGraphics();
  else if (frame.speedStep) menu.setSpeed(menu.walkSpeed + frame.speedStep * 0.2);
  if (menu.world === 'none') requestAnimationFrame(padLoop);
}
requestAnimationFrame(padLoop);

// ---- The first start fetches and builds the world (main.ts). What needs the click itself happens
// here: full screen on a touch screen, and the sound (browsers start audio only from a click, tap
// or key). Capturing the mouse waits for the world; if the browser no longer counts that as part
// of the click, "Click to look around" asks for one.
menu.onFirstStart = (mode) => {
  if (mode === 'touch') fillScreen();
  void sound.context()?.resume();
  import('./main').catch((e: unknown) => {
    console.error(e);
    menu.loadFailed();
  });
};

// Everything works now: show the start screen. The page keeps it hidden until here, so it never
// shows in the wrong language or with buttons that don't answer yet.
$('overlay').classList.remove('hidden');
