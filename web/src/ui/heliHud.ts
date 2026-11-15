import { lang, t } from '../i18n';
import './heliHud.css';

/**
 * The helicopter's instruments (world/heli.ts), quiet and small in the speedometer's place (ui/speedometer.ts), only
 * while you fly: the speed in km/h with the speedometer's look, the height over the floor below in metres, the climb
 * or sink as a small arrow and m/s, a 44 px horizon (a two-tone disc turned by the roll and shifted by the pitch, CSS
 * transforms only), and while the rotor runs up, a bar under the speed for how far it is. Nothing opens over the game.
 * Redrawn only when a shown number changes.
 */
export interface HeliReading {
  /** m/s over the ground */
  speed: number;
  /** m over the floor below */
  height: number;
  /** m/s, > 0 climbing */
  climb: number;
  /** rad, positive nose down */
  pitch: number;
  /** rad, positive right side down */
  roll: number;
  /** 0 to 1 */
  rotor: number;
  /** the rotor's speed from which it lifts */
  liftAt: number;
}

export class HeliHud {
  readonly root = document.createElement('div');
  private speed = document.createElement('span');
  private unit = document.createElement('span');
  private height = document.createElement('span');
  private climb = document.createElement('span');
  private arrow = document.createElement('i');
  private horizon = document.createElement('div');
  private sky = document.createElement('i');
  private bar = document.createElement('div');
  private fill = document.createElement('i');
  private last = '';
  private lastHorizon = '';
  private size = 44;
  private viewAt = '';

  constructor(parent: HTMLElement) {
    this.root.id = 'heli-hud';
    this.root.hidden = true;
    this.root.setAttribute('role', 'group');
    this.horizon.className = 'heli-horizon';
    this.horizon.setAttribute('role', 'img');
    this.sky.className = 'heli-sky';
    const mark = document.createElement('b'); // the machine's own level line, fixed
    mark.className = 'heli-mark';
    this.horizon.append(this.sky, mark);
    const main = document.createElement('div');
    main.className = 'heli-main';
    this.speed.className = 'speed-value';
    this.unit.className = 'speed-unit';
    const top = document.createElement('div');
    top.append(this.speed, this.unit);
    this.bar.className = 'speed-track heli-rotor';
    this.bar.append(this.fill);
    const row = document.createElement('div');
    row.className = 'heli-row';
    this.arrow.className = 'heli-arrow';
    this.arrow.setAttribute('aria-hidden', 'true');
    this.climb.className = 'heli-climb';
    this.height.className = 'heli-height';
    row.append(this.arrow, this.climb, this.height);
    main.append(top, this.bar, row);
    this.root.append(this.horizon, main);
    parent.append(this.root);
  }

  /** Null: hidden (on foot, in the menu, when down). */
  update(r: HeliReading | null): void {
    // Only what changes is touched: a class on the page's body would restyle the whole page at the first boarding.
    if (this.root.hidden !== (r === null)) {
      this.root.hidden = r === null;
      document.getElementById('toast')?.classList.toggle('over-heli', r !== null);
    }
    if (r === null) return;
    const kmh = Math.round(Math.max(0, r.speed) * 3.6);
    const m = Math.round(Math.max(0, r.height));
    const climb = Math.round(r.climb * 2) / 2; // to half a metre a second
    const spun = r.rotor < r.liftAt ? Math.round((r.rotor / r.liftAt) * 20) : 20;
    const key = `${lang()}:${kmh}:${m}:${climb}:${spun}`;
    if (key !== this.last) {
      this.last = key;
      const unit = t('hud.kmh');
      this.speed.textContent = String(kmh);
      this.unit.textContent = unit;
      this.height.textContent = `${m} m`;
      const shown = Math.abs(climb) < 0.5 ? '0' : Math.abs(climb).toFixed(Math.abs(climb) < 10 ? 1 : 0);
      this.climb.textContent = `${shown} m/s`;
      this.arrow.dataset.way = climb >= 0.5 ? 'up' : climb <= -0.5 ? 'down' : 'level';
      this.bar.hidden = spun >= 20;
      this.fill.style.transform = `scaleX(${spun / 20})`;
      this.root.setAttribute('aria-label', t('hud.heli'));
      this.speed.setAttribute('aria-label', `${t('hud.speed')}: ${kmh} ${unit}`);
      this.height.setAttribute('aria-label', `${t('hud.height')}: ${m} m`);
      this.climb.setAttribute('aria-label', `${t('hud.climb')}: ${climb.toFixed(1)} m/s`);
      this.bar.setAttribute('aria-label', `${t('hud.rotor')}: ${Math.round(r.rotor * 100)} %`);
      this.horizon.setAttribute('aria-label', t('hud.horizon'));
    }
    // The horizon: the roll turns it the other way, the nose down lifts it (more ground shows), as in a real one.
    const roll = Math.round((-r.roll * 180) / Math.PI);
    // At most a quarter of the disc either way, so it never goes one colour (34 px on touch, 44 px elsewhere).
    const view = `${innerWidth}x${innerHeight}`;
    if (view !== this.viewAt && this.horizon.clientWidth) {
      this.viewAt = view;
      this.size = this.horizon.clientWidth;
    }
    const most = this.size * 0.25;
    const shift = Math.round(Math.max(-most, Math.min(most, -(r.pitch * 180) / Math.PI * 0.6)));
    const h = `${roll}:${shift}`;
    if (h !== this.lastHorizon) {
      this.lastHorizon = h;
      this.sky.style.transform = `rotate(${roll}deg) translateY(${shift}px)`;
    }
  }
}
