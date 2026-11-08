/**
 * The page's entry: the start screen, which works before the world exists. The page brings only
 * this, the texts and the start picture, and asks the server who you are (/api/me). That covers
 * the language, the three steps (who you are: an account or a guest; alone or together; the mode),
 * the graphics setting, the controller, and the Sound and Full screen buttons (the start screen's,
 * and the in-game menu's own in its header).
 *
 * The world (main.ts: three.js, the house, its textures, models, sky and sounds) is fetched only
 * when you pick how to play. The chosen start button shows how far it has loaded, and play begins
 * by itself once it is ready. Nothing in main.ts or the modules it imports runs before that click,
 * so a model or texture loaded the moment its module is read can't slip in early either.
 */
// First: in the split screen it puts the seat's own settings in place before any module reads one.
import { seat, tellHost } from './seat';
import { Input } from './controls/input';
import { loadMode, saveMode } from './graphics';
import { applyStatic, onLang, setLang, t, type Lang } from './i18n';
import { typing } from './keys';
import { api, errorText, type KeptRun, type Me } from './net/client';
import { sound } from './sound';

// Xbox's Edge browser turns the controller into a mouse pointer unless the page says it reads the controller itself
// (Microsoft's gamepadInputEmulation); other browsers don't have the property and ignore it.
try {
  (navigator as Navigator & { gamepadInputEmulation?: string }).gamepadInputEmulation = 'gamepad';
} catch {
  // read-only or absent: nothing to do
}
import { Menu } from './ui/menu';
import { AccountCard } from './ui/account';
import { KeepRun } from './ui/keepRun';
import { PadNav } from './ui/padNav';
import { PadStart } from './ui/padStart';
import { StartFlow, type ZombieStart } from './ui/startFlow';

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
// the in-game menu's header, the switch in its Settings, or Shift+M.
const soundBtn = $('sound-btn');
const menuSound = $('menu-sound');
const startSound = $('start-sound'); // the start screen's, in its panel's header
const setSound = $('set-sound') as HTMLInputElement; // the switch in the menu's Settings, under Sound
function showSound(): void {
  setSound.checked = sound.enabled;
  // Icon and word apart: a phone shows only the icon (style.css).
  soundBtn.children[1].textContent = t(sound.enabled ? 'btn.sound' : 'btn.noSound');
  soundBtn.classList.toggle('off', !sound.enabled);
  for (const b of [menuSound, startSound]) {
    b.classList.toggle('off', !sound.enabled); // the crossed-out speaker
    b.setAttribute('aria-pressed', String(sound.enabled));
  }
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
startSound.addEventListener('click', toggleSound);
setSound.addEventListener('change', () => setSound.checked !== sound.enabled && toggleSound());
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
const startFull = $('start-full'); // and in the start screen's panel
const fullHint = $('full-hint');
const fsDoc = document as Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
const fsRoot = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
const fromHomeScreen = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const canFill = !!(document.fullscreenEnabled || fsDoc.webkitFullscreenEnabled);
const isFull = () => !!(document.fullscreenElement || fsDoc.webkitFullscreenElement);
if (matchMedia('(pointer: coarse)').matches && !fromHomeScreen) {
  fullBtn.classList.remove('hidden');
  menuFull.classList.remove('hidden');
  startFull.classList.remove('hidden');
}
function showFull(): void {
  fullBtn.classList.toggle('on', isFull());
  fullBtn.children[1].textContent = t(isFull() ? 'btn.exitFull' : 'btn.full');
  for (const b of [menuFull, startFull]) {
    b.title = t(isFull() ? 'btn.exitFull' : 'btn.full');
    b.setAttribute('aria-label', b.title);
    b.classList.toggle('on', isFull());
  }
}
showFull();
fullBtn.addEventListener('click', () => {
  fullBtn.blur();
  toggleFull();
});
menuFull.addEventListener('click', toggleFull);
startFull.addEventListener('click', toggleFull);
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

// ---- Who you are, and alone or together (src/ui/startFlow.ts: the start screen's three steps). Joining as a guest
// and logging in (src/ui/account.ts: players and the admin alike) are all HTTP, so they work on the start screen.
// The world (main.ts) follows `me` once it is there, and only then connects to the others.
//
// `session` is who the server knows this browser as (the session cookie): a guest, a player or the admin, alone
// too. `me` is who plays together: the session once Together is picked, null while playing alone.
export let me: Me | null = null;
let session: Me | null = null;
/** The message under the steps (start screen) and in the Together tab, as a function: drawn again in another language. */
let accountMsg: (() => string) | null = null;
/** That message is news, not a complaint (logged out): not in the complaint's colour. */
let accountMsgCalm = false;
const accountListeners: ((account: Me | null) => void)[] = [];
/** Call `fn` with the account now and on every change (null: playing alone). */
export function onAccount(fn: (account: Me | null) => void): void {
  accountListeners.push(fn);
  fn(me);
}
const sessionListeners: (() => void)[] = [];
/** Call `fn` now and on every change of the session (alone too): the admin tab's parts alone (src/main.ts). */
export function onSession(fn: () => void): void {
  sessionListeners.push(fn);
  fn();
}
/** The session is the admin's, alone too. Its role comes from the server (/api/me, the login's answer), never from this device. */
export const sessionAdmin = (): boolean => session?.role === 'admin';
/** The texts that depend on the account: the message, the note in the Together tab, joining there under the session. */
function showAccountText(): void {
  const message = accountMsg?.() ?? '';
  for (const id of ['mp-msg', 'mp-msg2']) {
    $(id).textContent = message;
    $(id).classList.toggle('bad', !!message && !me && !session && !accountMsgCalm);
  }
  const withRole = (account: Me) => (account.role === 'admin' ? t('role.admin', { name: account.username }) : account.username);
  $('mp-note').textContent = me ? t('tog.noteTogether', { name: withRole(me) }) : t('tog.noteAlone');
  // Playing alone with a session (an account, or a guest from before): together under it in one press.
  const under = !me && session ? session : null;
  $('mp-acct-row').classList.toggle('hidden', !under);
  document.querySelectorAll('.mp-guest-only').forEach((el) => el.classList.toggle('hidden', !!under));
  if (under) $('mp-join-acct').textContent = t('tog.joinAcct', { name: under.username });
}
/** The session alone (the start screen's login, or the cookie found on arrival): playing together waits for step 2. */
function setSession(account: Me | null, message: (() => string) | null = null, fromLogin = false): void {
  session = account;
  if (!account) me = null;
  accountMsg = message;
  accountMsgCalm = false;
  menu.setAccount(account?.username ?? null);
  // The admin's tab together, and alone too for the admin's session (its role from the server: /api/me or the login's answer).
  menu.setAdmin(me?.role === 'admin' || account?.role === 'admin');
  // "Your account": a new password, deleting it (src/ui/account.ts), for players logged in to their own.
  document.querySelectorAll('.acct-manage').forEach((b) => b.classList.toggle('hidden', account?.role !== 'player'));
  document.querySelectorAll('.acct-row').forEach((b) => b.classList.toggle('hidden', account?.role !== 'player'));
  if (account?.role !== 'guest') keepRun.clear();
  showAccountText();
  flow?.sessionChanged(fromLogin);
  for (const fn of sessionListeners) fn();
}
/** Play together as `account` (null: alone, and logged out): main.ts connects, or leaves the others. */
export function setAccount(account: Me | null, message: (() => string) | null = null): void {
  me = account;
  setSession(account, message);
  for (const fn of accountListeners) fn(account);
}
/**
 * "I'm 13 or older": asked where a guest joins together, ticked once for this device (localStorage
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
    flow?.draw();
  });
}

// Leaving must really end the session, also on a shared laptop or iPad at a meetup: a logout the
// server never got (out of reach) is remembered on this device and sent again on the next visit,
// before anyone is let back in. And a join or login answered after leaving is dropped and logged
// out again, so it can't sign you back in behind your back.
const LOGOUT = 'briel.logoutPending';
let accountGen = 0; // goes up on leaving
const logoutDone = () => {
  try {
    localStorage.removeItem(LOGOUT);
  } catch {}
};
function logoutForSure(): void {
  try {
    localStorage.setItem(LOGOUT, '1');
  } catch {}
  api.logout().then(logoutDone).catch(() => {});
}

/** A join on its way to the server: a second click (Join twice, or Join then a start button) waits for it instead of sending another. */
let joining: Promise<boolean> | null = null;
/** The server's refusals of a guest's name: on the start screen, back to step 1 where the name is. */
const NAME_CODES = /^name/;
/**
 * Play together as a guest (Yoshi, 7 Nov 2026: no PIN): your name is your name in the game. From the start
 * screen, or from the menu's Together tab while playing alone (`field`: the name's field there).
 * True once joined; false with the reason under the fields.
 */
function join(name = ($('nick') as HTMLInputElement).value.trim(), field: HTMLElement = $('nick')): Promise<boolean> {
  const onStart = field.id === 'nick';
  const refuse = (text: () => string, at?: HTMLElement) => {
    setAccount(null, text);
    if (onStart && at === field) {
      flow.show(1, false);
      flow.showCard('guest');
    }
    if (onStart && !at) flow.show(2, false);
    const where = at ?? (onStart ? $('mp-age') : undefined);
    where?.setAttribute('aria-invalid', 'true'); // outlined until typed in
    where?.focus(); // where to type next
    return Promise.resolve(false);
  };
  if (joining) return joining;
  if (!name || name === 'Guest') return refuse(() => t('err.nameFirst'), field);
  // Playing together, with its chat, is for 13 and over: ticked once, remembered on this device.
  if (!ageOk()) return refuse(() => t('err.age'));
  const gen = accountGen;
  joining = api
    .join(name, ageOk())
    .then((account) => {
      if (gen !== accountGen) {
        logoutForSure();
        return false;
      }
      logoutDone();
      // On the start screen the session for the next steps (playing together begins with the start button); from the
      // Together tab, playing together at once.
      if (onStart) setSession(account);
      else setAccount(account);
      return true;
    })
    .catch((e: unknown) => {
      const code = String((e as { code?: unknown }).code ?? '');
      if (NAME_CODES.test(code)) return refuse(errorText(e), field);
      if (code === 'age') return refuse(errorText(e));
      setAccount(null, errorText(e));
      return false;
    })
    .finally(() => (joining = null));
  return joining;
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
// Typing in a field that was complained about: the outline and the complaint go.
for (const id of ['nick', 'mp-nick2']) {
  $(id).addEventListener('input', () => {
    if ($(id).getAttribute('aria-invalid') !== 'true') return;
    $(id).removeAttribute('aria-invalid');
    if (!me) {
      accountMsg = null;
      showAccountText();
    }
  });
}
$('mp-age').addEventListener('change', () => $('mp-age').removeAttribute('aria-invalid'));
const joinHere = () => void join(($('mp-nick2') as HTMLInputElement).value.trim() || menu.nickname, $('mp-nick2'));
$('mp-join2').addEventListener('click', joinHere);
$('mp-nick2').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') joinHere();
});
// The Together tab while playing alone with a session: together under it.
$('mp-join-acct').addEventListener('click', () => session && setAccount(session));
/**
 * A login or sign-up is on its way (the start screen's login card, the account card, the phone): its answer,
 * unless the player left meanwhile. On the start screen it is the session for the next steps; in the game it
 * is playing together, as before.
 */
const beginLogin = (signup: boolean) => {
  const gen = accountGen;
  return (account: Me & { kept?: KeptRun }) => {
    if (gen !== accountGen) {
      logoutForSure();
      return false;
    }
    logoutDone();
    const kept = account.kept;
    const plain: Me = { username: account.username, role: account.role };
    const message = !signup ? null : kept ? () => t('acct.welcomeKept', { name: plain.username, n: kept.wave }) : () => t('acct.welcome', { name: plain.username });
    if (signup) keepRun.clear();
    if (menu.onStartScreen) setSession(plain, message, true);
    else setAccount(plain, message);
    return true;
  };
};
// Accounts (src/ui/account.ts): logging in and signing up answer like a join, so leaving meanwhile still wins.
new AccountCard({
  me: () => session,
  typedName: () => (session?.role === 'guest' ? session.username : session ? '' : ($('login-name') as HTMLInputElement).value.trim() || ($('nick') as HTMLInputElement).value.trim() || ($('mp-nick2') as HTMLInputElement).value.trim()),
  ageOk,
  begin: beginLogin,
  ended: (message) => {
    accountGen++;
    setAccount(null, message);
  },
});
// Leaving plays alone at once, without waiting for the server: with it out of reach the answer can
// take seconds. The logout itself is made sure of (see logoutForSure).
const leave = (message: (() => string) | null = null) => {
  accountGen++;
  setAccount(null, message);
  logoutForSure();
};
$('mp-logout').addEventListener('click', () => {
  leave(session?.role === 'guest' ? null : () => t('start.loggedOut'));
  accountMsgCalm = true;
  showAccountText();
});
$('mp-leave').addEventListener('click', () => leave());
// Keep this run (src/ui/keepRun.ts): a guest's good Zombies run, offered while it waits on the server.
export const keepRun = new KeepRun(() => session?.role === 'guest');
/**
 * What the start screen asks of the world once play begins (src/main.ts): Zombies alone at a place after the
 * landing, or a Zombies room to play in (joined, or opened just now), with the place to start at.
 */
export const startIntent: { zombies: 'solo' | 'room' | 'open' | null; place: string | null; room: string | null } = { zombies: null, place: null, room: null };
// The three steps (src/ui/startFlow.ts).
const flow: StartFlow = new StartFlow({
  join: () => join(),
  play: () => menu.play,
  setPlay: (play) => menu.setPlay(play),
  session: () => session,
  begin: () => beginLogin(false),
  logout: () => leave(),
  ageOk,
  start: (mode, from) => menu.begin(mode, from),
  say: (text) => {
    accountMsg = text;
    accountMsgCalm = false;
    showAccountText();
  },
});
let logoutPending = false;
try {
  logoutPending = localStorage.getItem(LOGOUT) === '1';
} catch {}
if (logoutPending) {
  setAccount(null);
  logoutForSure(); // left last time while the server was out of reach: finish that first
} else if (seat) {
  // A seat of the split screen (src/seat.ts): the page around it joined it already, so it starts
  // straight away, as that player, without the start screen's form. Its controller, or seat 1's
  // keyboard and mouse. Without its session (it ended, or was never made), the start screen as usual.
  let joined = false;
  onAccount((account) => {
    if (account) joined = true;
    else if (joined) tellHost('ended'); // left, removed, or the session ended: the split screen says so
  });
  api.me().then((account) => {
    document.body.classList.add('seat');
    setAccount(account);
    tellHost('ready');
    menu.begin(seat!.pad < 0 ? 'kbm' : 'pad');
  }).catch(() => {
    setAccount(null);
    tellHost('alone');
  });
} else {
  // A session from before (its cookie): the welcome back on step 1, and nothing joined until step 2 says so.
  api.me().then((account) => setSession({ username: account.username, role: account.role })).catch(() => setSession(null));
}
/** A name is needed to play, alone too (Yoshi, 1 Nov 2026): back to step 1, the field outlined and focused, the message under it. */
function nameMissing(): boolean {
  const nick = $('nick') as HTMLInputElement;
  const name = nick.value.trim();
  if (me || session || (name && name !== 'Guest' && name !== 'Gast')) return false;
  setAccount(null, () => t('err.nameFirst'));
  flow.show(1, false);
  flow.showCard('guest');
  nick.setAttribute('aria-invalid', 'true'); // outlined until typed in
  nick.focus();
  return true;
}
// A start button: alone at once; together under the session (an account, or a guest from before), or joining
// first as a guest under the name typed, and play starts only if that worked.
menu.beforeStart = () => {
  if (nameMissing()) return Promise.resolve(false);
  // A split-screen seat plays the page's game, never this browser's last Zombies start, nor its place (src/seat.ts).
  if (!seat) flow.armZombies(); // Zombies plays armed, also when Explore was picked in the game's menu since
  const z = seat ? null : flow.zombieStart();
  startIntent.zombies = null;
  startIntent.place = null;
  startIntent.room = null;
  if (z?.kind === 'solo') Object.assign(startIntent, { zombies: 'solo', place: z.place });
  if (!flow.together() || me) return true;
  return togetherNow(z);
};
/**
 * Start together: as the session (joining first as a new guest), in the Zombies room picked or a new one of the
 * account's at its place (server/rooms.mjs: who may open one, and how many, stays the server's to say).
 */
async function togetherNow(z: ZombieStart | null): Promise<boolean> {
  if (!session && !(await join())) return false;
  const s = session;
  if (!s) return false;
  if (z?.kind === 'none') z = await flow.zombieStartNow(); // "Play again as before": the rooms weren't listed yet
  if (z?.kind === 'none') {
    if (flow.step !== 3) flow.show(3); // none to join: the list, to pick one or play otherwise
    accountMsg = () => t('zs.pickRoom');
    accountMsgCalm = false;
    showAccountText();
    return false;
  }
  if (z?.kind === 'open') {
    try {
      const { room } = await api.openRoom(z.place);
      Object.assign(startIntent, { zombies: 'open', place: room.place, room: room.id });
    } catch (e) {
      accountMsg = errorText(e);
      accountMsgCalm = false;
      showAccountText();
      return false;
    }
  }
  if (z?.kind === 'room') Object.assign(startIntent, { zombies: 'room', place: z.place, room: z.id });
  setAccount(s);
  return true;
}
// Another language: the texts made here that aren't drawn every frame (the modules redraw their own).
onLang(() => {
  showSound();
  showFull();
  showAccountText();
});

// The controller on the start screen (src/ui/padNav.ts walks the step showing): the D-pad or the left stick moves,
// ✕ presses (on the last step, with nothing chosen, it starts with the controller), ○ goes a step back, □ changes
// the graphics. Its name shows on the Controller button. From the first start on, the world's loop reads it.
const startNav = new PadNav(() => flow.page());
// Pad mode (src/ui/padStart.ts): a guest name ready, the phone's login in the card, the big focus and the button hints.
const padStart = new PadStart(flow, startNav, { session: () => session, begin: () => beginLogin(false) });
let padStep = 0; // the step the controller last saw: on a new one, its likely press gets the focus
function padLoop(): void {
  const frame = input.poll();
  menu.setPadState(input.padName);
  if (input.padName && !padStart.active && !seat) {
    // The controller came in: the press that brought it only shows where the focus is.
    padStart.enter();
    padStep = flow.step;
    startNav.focus(flow.defaultControl(true));
    if (menu.world === 'none') requestAnimationFrame(padLoop);
    return;
  }
  padStart.tick();
  if (padStart.active && !dialogOpen()) {
    // The page moved the focus itself (a field to fix, the age tick): the controller's ring follows it. And when the
    // focused control went (the session came in, a card closed): the step's likely press again.
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== startNav.focused() && el !== document.body && flow.page().contains(el)) startNav.focus(el);
    else if (!startNav.focused()) startNav.focus(flow.defaultControl(true));
  }
  if (padStep && padStep !== flow.step) {
    startNav.reset();
    startNav.focus(flow.defaultControl(true));
  }
  if (padStep) padStep = flow.step;
  if (frame.anyPadButton) padStep ||= flow.step;
  if (dialogOpen()) {
    // The account card is a dialog of its own: the keyboard (or a console's own) works there, the pad waits.
  } else if (frame.deletePressed && padStart.back()) {
    // ○ closed the phone's code (step 1)
  } else if (frame.deletePressed && flow.step > 1) {
    startNav.reset();
    flow.goBack();
  } else if (frame.confirmPressed) {
    if (!startNav.press()) {
      if (flow.step === 3) menu.begin('pad');
      else startNav.focus(flow.defaultControl(true));
    }
  } else if (frame.squarePressed) menu.cycleGraphics();
  else if (frame.tabStep) padStart.shoulder(frame.tabStep);
  else if (frame.navX || frame.navY) {
    if (!startNav.focused()) startNav.focus(flow.defaultControl(true));
    else if (!(frame.navX && startNav.adjust(frame.navX))) startNav.step(frame.navX, frame.navY);
  }
  if (menu.world === 'none') requestAnimationFrame(padLoop);
}
const dialogOpen = () => !!document.querySelector('dialog[open]');
requestAnimationFrame(padLoop);

// ---- The first start fetches and builds the world (main.ts). What needs the click itself happens
// on the click, before any joining: full screen on a touch screen, and the sound (browsers start
// audio only from a click, tap or key). Capturing the mouse waits for the world; if the browser no
// longer counts that as part of the click, "Click to look around" asks for one.
menu.onStartGesture = (mode) => {
  if (mode === 'touch') fillScreen();
  void sound.context()?.resume();
};
menu.onFirstStart = (mode) => {
  flow.remember(mode); // the next visit's "Play again as before" (src/ui/startFlow.ts)
  flow.close(); // its rooms' list is fetched no more
  import('./main').catch((e: unknown) => {
    console.error(e);
    menu.loadFailed();
  });
};

// Everything works now: show the start screen. The page keeps it hidden until here, so it never
// shows in the wrong language or with buttons that don't answer yet.
$('overlay').classList.remove('hidden');
