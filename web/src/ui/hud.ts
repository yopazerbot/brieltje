import { familyName, oddLayout } from '../controls/padFamily';
import { lang, t } from '../i18n';
import { paintball, weaponName } from '../paintball';
import type { WeaponId } from '../weapon';
import { ScopeView, type ScopePicture } from './scope';

/** On-screen text while playing: where you are, controller status, frame rate and (together) the ping. */
export class Hud {
  private place = document.getElementById('place')!;
  private fps = document.getElementById('fps')!;
  private pad = document.getElementById('pad')!;
  private toast = document.getElementById('toast')!;
  private prompt = document.getElementById('prompt')!;
  private ammo = document.getElementById('ammo')!;
  private nades = document.getElementById('nades')!;
  private crosshair = document.getElementById('crosshair')!;
  private ring = document.getElementById('ring')!;
  private ringArc = this.ring.querySelector('circle.arc') as SVGCircleElement;
  private scope = new ScopeView();
  private lastPlace = '';

  constructor() {
    // The crosshair's four ticks (style.css shows them with a gun in your hands).
    for (let i = 0; i < 4; i++) this.crosshair.appendChild(document.createElement('i'));
  }
  private toastTimer = 0;
  private frames = 0;
  private fpsTime = 0;

  /** Small hint under the crosshair, e.g. "E  Open door". Empty hides it. */
  /** `warn`: a refusal (red edge, may run over two lines). */
  setPrompt(text: string, warn = false): void {
    if (this.prompt.textContent !== text) this.prompt.textContent = text;
    this.prompt.classList.toggle('show', !!text);
    this.prompt.classList.toggle('warn', warn && !!text);
  }

  private slotsKey = '';
  /** The weapons you carry, bottom right: slot number and name, the one in your hands highlighted. */
  setSlots(slots: { id: WeaponId; slot: number; owned: boolean; current: boolean }[] | null): void {
    const key = slots ? lang() + paintball.on + slots.map((s) => `${s.slot}${s.owned ? 1 : 0}${s.current ? 1 : 0}`).join() : '';
    if (key === this.slotsKey) return;
    this.slotsKey = key;
    const box = document.getElementById('slots')!;
    box.replaceChildren(...(slots ?? []).filter((s) => s.owned).map((s) => {
      const d = document.createElement('div');
      d.className = s.current ? 'slot current' : 'slot';
      d.textContent = `${s.slot}  ${weaponName(s.id)}`;
      return d;
    }));
  }

  /** The ring round the crosshair filling up while you help a teammate up (0..1); null hides it. */
  setRing(progress: number | null): void {
    this.ring.classList.toggle('show', progress !== null);
    if (progress === null) return;
    const len = 2 * Math.PI * 18;
    this.ringArc.style.strokeDasharray = `${len}`;
    this.ringArc.style.strokeDashoffset = `${len * (1 - Math.max(0, Math.min(1, progress)))}`;
  }

  /** The picture through a scope (ui/scope.ts); `noCross` hides the crosshair too (driving, with the camera behind the car). */
  setScope(on: boolean, noCross = false, picture?: ScopePicture): void {
    this.scope.set(on, picture);
    this.crosshair.classList.toggle('hidden', on || noCross);
  }

  private gap = -1;
  private faint = -1;
  /**
   * The crosshair's ticks stand as far out as the next shot can land: `spread` in half view heights
   * (weapon.ts), so they open up when you run, jump or keep firing. `aim` (0..1): with the sights
   * at your eye the crosshair goes faint, the sights do the work.
   */
  setSpread(spread: number, aim: number): void {
    const gap = Math.round(Math.max(3, Math.min(90, spread * window.innerHeight / 2)));
    if (gap !== this.gap) {
      this.gap = gap;
      this.crosshair.style.setProperty('--gap', `${gap}px`);
    }
    const faint = Math.round(aim * 10);
    if (faint !== this.faint) {
      this.faint = faint;
      this.crosshair.style.opacity = faint ? `${(0.85 * (1 - 0.07 * faint)).toFixed(2)}` : '';
    }
  }

  setWeapon(armed: boolean, status: string): void {
    if (this.ammo.textContent !== status) this.ammo.textContent = status;
    this.crosshair.classList.toggle('gun', armed);
  }

  /** Grenades in your pocket, out of `carry`, and when the next is back; null hides the line. `mines`: claymores and stakes carried (Zombies), how to place them. */
  setGrenades(count: number | null, carry = 0, nextIn = 0, key = 'G', mines = ''): void {
    const text = count === null ? '' : `${key}  ${'●'.repeat(count)}${'○'.repeat(carry - count)}${count < carry ? `  ${Math.ceil(nextIn)} s` : ''}${mines ? `   ·   ${mines}` : ''}`;
    if (this.nades.textContent !== text) this.nades.textContent = text;
  }

  /** The FPS counter (Settings, or F / Create). */
  showFps(on: boolean): void {
    this.fps.classList.toggle('on', on);
  }

  private padText = '';
  private padLeft = 0;
  /**
   * The controller's line bottom left: its name for a few seconds once it connects (as the other
   * hints, Yoshi), and "no controller found" for as long as you play with one that isn't there.
   * The name comes with its kind (src/controls/padFamily.ts): "Xbox-style controller: Xbox 360
   * Controller"; the full name the browser gives is in the ?diag panel.
   */
  setPad(name: string | null, wanted: boolean): void {
    let text = '';
    if (name) text = t(oddLayout() ? 'hud.padOdd' : 'hud.pad', { family: familyName(), name: name.replace(/\s*\(.*\)\s*$/, '') });
    else if (wanted) text = t('hud.noPad');
    if (text !== this.padText) {
      this.padText = text;
      this.padLeft = name ? 4 : Infinity;
    }
    const shown = this.padLeft > 0 ? text : '';
    if (this.pad.textContent !== shown) this.pad.textContent = shown;
  }

  /** The location name, shown big for a few seconds when the floor changes, with the hamlet (`area`) under it. */
  setPlace(level: string, surface: string | undefined, area: string): void {
    const label = surface && surface.toLowerCase() !== level.toLowerCase() ? `${level} · ${surface}` : level;
    if (label === this.lastPlace) return;
    const levelChanged = !this.lastPlace.startsWith(level);
    this.lastPlace = label;
    this.place.textContent = label;
    if (levelChanged) {
      const small = document.createElement('small');
      small.textContent = area;
      this.toast.replaceChildren(level, small);
      this.toast.classList.add('show');
      this.toastTimer = 3;
    }
  }

  /** The big italic name for a few seconds, with a small line under it (where you arrived through a portal). */
  announce(big: string, small: string): void {
    const s = document.createElement('small');
    s.textContent = small;
    this.toast.replaceChildren(big, s);
    this.toast.classList.add('show');
    this.toastTimer = 3;
  }

  /** Every frame; `ping`: the time there and back to the server in multiplayer (ms), null alone. */
  tick(dt: number, drawCalls: number, scale = 1, quality = '', ping: number | null = null): void {
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) this.toast.classList.remove('show');
    this.padLeft -= dt;
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps.textContent = t('hud.fps', { fps: Math.round(this.frames / this.fpsTime), calls: drawCalls, quality, scale: Math.round(scale * 100) })
        + (ping === null ? '' : t('hud.ping', { ms: Math.round(ping) }));
      this.frames = 0;
      this.fpsTime = 0;
    }
  }
}
