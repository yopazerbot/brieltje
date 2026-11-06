import { MAX_ADMIN_WAVE } from '../../shared/zombies.mjs';
import type { ModeView } from './games';

/** The admin's wave picker; the server authorizes and applies every change. */
export class ZombieWaveControl {
  private root = document.getElementById('zombies-wave-admin') as HTMLFormElement;
  private input = document.getElementById('zombies-wave-number') as HTMLInputElement;
  private button = this.root.querySelector('button')!;
  private active = false;
  private dirty = false;
  private wave = -1;
  private next = 0;

  constructor(send: (wave: number) => void) {
    this.input.max = String(MAX_ADMIN_WAVE);
    this.input.addEventListener('input', () => { this.dirty = true; });
    this.root.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!this.active || performance.now() < this.next || !this.input.reportValidity()) return;
      this.next = performance.now() + 1000;
      this.dirty = false;
      this.button.disabled = true;
      send(this.input.valueAsNumber);
      window.setTimeout(() => { this.button.disabled = !this.active; }, 1000);
    });
  }

  update(view: ModeView, allowed: boolean): void {
    const active = allowed && view.kind === 'zombies' && (view.phase === 'break' || view.phase === 'wave');
    const wave = Math.max(1, view.zombies?.wave ?? 1);
    if (active && (!this.active || (this.wave !== wave && !this.dirty && document.activeElement !== this.input))) {
      this.input.value = String(wave);
      this.dirty = false;
    }
    this.active = active;
    this.wave = wave;
    this.root.classList.toggle('hidden', !active);
    this.button.disabled = !active || performance.now() < this.next;
  }
}
