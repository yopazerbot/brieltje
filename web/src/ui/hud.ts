import { lang, t } from '../i18n';
import { paintball, weaponName } from '../paintball';
import type { WeaponId } from '../weapon';

/** On-screen text while playing: where you are, controller status and frame rate. */
export class Hud {
  private place = document.getElementById('place')!;
  private fps = document.getElementById('fps')!;
  private pad = document.getElementById('pad')!;
  private toast = document.getElementById('toast')!;
  private prompt = document.getElementById('prompt')!;
  private ammo = document.getElementById('ammo')!;
  private nades = document.getElementById('nades')!;
  private crosshair = document.getElementById('crosshair')!;
  private lastPlace = '';
  private toastTimer = 0;
  private frames = 0;
  private fpsTime = 0;

  /** Small hint under the crosshair, e.g. "E  Open WC door". Empty hides it. */
  setPrompt(text: string): void {
    if (this.prompt.textContent !== text) this.prompt.textContent = text;
    this.prompt.classList.toggle('show', !!text);
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

  /** The sniper's scope; `noCross` hides the crosshair too (driving, with the camera behind the car). */
  setScope(on: boolean, noCross = false): void {
    document.getElementById('scope')!.classList.toggle('show', on);
    this.crosshair.classList.toggle('hidden', on || noCross);
  }

  setWeapon(armed: boolean, status: string): void {
    if (this.ammo.textContent !== status) this.ammo.textContent = status;
    this.crosshair.classList.toggle('gun', armed);
  }

  /** Grenades in your pocket, out of `carry`, and when the next is back; null hides the line. */
  setGrenades(count: number | null, carry = 0, nextIn = 0, key = 'G'): void {
    const text = count === null ? '' : `${key}  ${'●'.repeat(count)}${'○'.repeat(carry - count)}${count < carry ? `  ${Math.ceil(nextIn)} s` : ''}`;
    if (this.nades.textContent !== text) this.nades.textContent = text;
  }

  /** The FPS counter (Settings, or F / Create). */
  showFps(on: boolean): void {
    this.fps.classList.toggle('on', on);
  }

  setPad(name: string | null, wanted: boolean): void {
    let text = '';
    if (name) text = t('hud.pad', { name: name.replace(/\s*\(.*\)\s*$/, '') });
    else if (wanted) text = t('hud.noPad');
    if (this.pad.textContent !== text) this.pad.textContent = text;
  }

  /** Big italic location name, shown for a few seconds when it changes. */
  setPlace(level: string, surface: string | undefined): void {
    const label = surface && surface.toLowerCase() !== level.toLowerCase() ? `${level} · ${surface}` : level;
    if (label === this.lastPlace) return;
    const levelChanged = !this.lastPlace.startsWith(level);
    this.lastPlace = label;
    this.place.textContent = label;
    if (levelChanged) {
      const small = document.createElement('small');
      small.textContent = 'Briel';
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

  tick(dt: number, drawCalls: number, scale = 1, quality = ''): void {
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) this.toast.classList.remove('show');
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps.textContent = t('hud.fps', { fps: Math.round(this.frames / this.fpsTime), calls: drawCalls, quality, scale: Math.round(scale * 100) });
      this.frames = 0;
      this.fpsTime = 0;
    }
  }
}
