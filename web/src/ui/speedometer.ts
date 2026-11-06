import { lang, t } from '../i18n';
import './speedometer.css';

/** A quiet, permanent speed readout while driving or riding along; metres per second in, km/h on screen. */
export class Speedometer {
  readonly root = document.createElement('div');
  private value = document.createElement('span');
  private unit = document.createElement('span');
  private fill = document.createElement('i');
  private last = '';

  constructor(parent: HTMLElement) {
    this.root.id = 'speedometer';
    this.root.hidden = true;
    this.root.setAttribute('role', 'meter');
    this.root.setAttribute('aria-valuemin', '0');
    this.value.className = 'speed-value';
    this.unit.className = 'speed-unit';
    const track = document.createElement('div');
    track.className = 'speed-track';
    track.setAttribute('aria-hidden', 'true');
    track.append(this.fill);
    this.root.append(this.value, this.unit, track);
    parent.append(this.root);
  }

  update(speed: number | null, maximum: number): void {
    this.root.hidden = speed === null;
    if (speed === null) return;
    const cap = Number.isFinite(maximum) && maximum > 0 ? maximum : 1;
    const kmh = Math.round((Number.isFinite(speed) ? Math.min(cap, Math.abs(speed)) : 0) * 3.6);
    const max = Math.round(cap * 3.6);
    const key = `${lang()}:${kmh}:${max}`;
    if (key === this.last) return;
    this.last = key;
    const unit = t('hud.kmh');
    this.value.textContent = String(kmh);
    this.unit.textContent = unit;
    this.root.setAttribute('aria-label', t('hud.speed'));
    this.root.setAttribute('aria-valuenow', String(kmh));
    this.root.setAttribute('aria-valuemax', String(max));
    this.root.setAttribute('aria-valuetext', `${kmh} ${unit}`);
    this.fill.style.transform = `scaleX(${kmh / Math.max(1, max)})`;
  }
}
