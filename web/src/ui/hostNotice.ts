import { t } from '../i18n';

/**
 * What the host of a LAN night puts on every screen (server/host.mjs): an announcement across the top for a few seconds
 * ("Pizza is here"), with a countdown when it says the next game, and a freeze: the screen dims, "Everyone stands
 * still", and the page stops moving and shooting (main.ts reads `frozen`) until the host lets go. Looking round and the
 * menu still work. The host's words are put in with textContent only.
 */
export class HostNotice {
  frozen = false;
  private bar = document.createElement('div');
  private barText = document.createElement('b');
  private barSub = document.createElement('small');
  private veil = document.createElement('div');
  private veilSub = document.createElement('small');
  private hideAt = 0;
  private countTo = 0;
  private timer = 0;

  constructor(parent: HTMLElement = document.body) {
    this.bar.id = 'host-bar';
    this.bar.className = 'hidden';
    this.bar.setAttribute('role', 'status');
    this.bar.append(this.barText, this.barSub);
    this.veil.id = 'host-freeze';
    this.veil.className = 'hidden';
    const title = document.createElement('b');
    title.dataset.i18n = 'host.frozen';
    title.textContent = t('host.frozen');
    this.veil.append(title, this.veilSub);
    parent.append(this.bar, this.veil);
  }

  /**
   * An announcement: the host's own words, or (`code` nextGame) the next game by name with a countdown. An empty
   * one takes the bar away (a countdown called off).
   */
  announce(text: string, ms: number, next?: string, count = false): void {
    window.clearInterval(this.timer);
    if (!ms || (!text && !next)) {
      this.bar.classList.add('hidden');
      return;
    }
    this.barText.textContent = next ? t('host.next', { game: next }) : text;
    this.hideAt = performance.now() + Math.min(60_000, ms);
    this.countTo = count ? this.hideAt : 0;
    this.barSub.textContent = '';
    this.bar.classList.remove('hidden');
    const step = () => {
      const left = this.hideAt - performance.now();
      if (left <= 0) {
        window.clearInterval(this.timer);
        this.bar.classList.add('hidden');
        return;
      }
      if (this.countTo) this.barSub.textContent = t('host.startsIn', { n: Math.ceil(left / 1000) });
    };
    step();
    this.timer = window.setInterval(step, 200);
  }

  /** Frozen by the host, or let go; `text`: the host's reason, if any (else "The host paused the game"). */
  freeze(on: boolean, text = ''): void {
    this.frozen = on;
    this.veilSub.textContent = text || t('host.frozenSub');
    this.veil.classList.toggle('hidden', !on);
  }
}
