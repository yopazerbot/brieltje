import './goalsHud.css';

/**
 * The line at the top for the timed routes (world/goals.ts): a race on offer with your best time; with a race asked
 * for, the way to its start gate; during a run the clock, the next checkpoint, how far it is and an arrow towards it.
 * In the slot of the games' bar (#modebar), which shows only during a game, when this line is hidden. While it offers
 * or shows a race a tap on it is the race key (touch controls: start or stop it). Text only through textContent.
 */
export class GoalsHud {
  readonly root = document.createElement('div');
  private clock = document.createElement('b');
  private text = document.createElement('span');
  private arrow = document.createElement('i');
  private last = '';
  private lastTurn = NaN;

  constructor(parent: HTMLElement, onTap: () => void) {
    this.root.id = 'goal-line';
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'off');
    this.arrow.setAttribute('aria-hidden', 'true');
    this.arrow.textContent = '↑';
    this.root.append(this.clock, this.text, this.arrow);
    // The touch controls' layer lies over the HUD and takes every touch (controls/touch.ts): the tap is caught on its way
    // down instead, before it starts a look round, and only on the line while it offers or shows a race.
    window.addEventListener('pointerdown', (e) => {
      if (!this.root.classList.contains('tap') || !document.body.classList.contains('touch')) return;
      const r = this.root.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      e.preventDefault();
      e.stopPropagation();
      onTap();
    }, true);
    parent.append(this.root);
  }

  /**
   * `clock`: the run's time as text, or '' for none; `text`: the rest; `turn`: the arrow's turn in radians (clockwise
   * on screen, 0 straight ahead), or null for no arrow; `tap`: a tap on it counts (it offers or shows a race).
   * Everything empty: hidden.
   */
  set(clock: string, text: string, turn: number | null, tap = false): void {
    const key = `${clock}\u0000${text}\u0000${turn === null ? '' : 'a'}\u0000${tap ? 't' : ''}`;
    if (key !== this.last) {
      this.last = key;
      this.root.hidden = !clock && !text;
      this.root.classList.toggle('tap', tap && !this.root.hidden);
      this.clock.textContent = clock;
      this.clock.hidden = !clock;
      this.text.textContent = text;
      this.arrow.hidden = turn === null;
    }
    if (turn !== null) {
      // Whole degrees: no new style for a change nobody sees.
      const deg = Math.round((turn * 180) / Math.PI);
      if (deg !== this.lastTurn) {
        this.lastTurn = deg;
        this.arrow.style.transform = `rotate(${deg}deg)`;
      }
    }
  }
}
