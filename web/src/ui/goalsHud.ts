import './goalsHud.css';

/**
 * The line at the top for the timed routes (world/goals.ts): near a start gate its name, how it is done and your best
 * time; during a run the clock, the next checkpoint, how far it is and an arrow towards it. In the slot of the games'
 * bar (#modebar), which shows only during a game, when this line is hidden. Text only through textContent.
 */
export class GoalsHud {
  readonly root = document.createElement('div');
  private clock = document.createElement('b');
  private text = document.createElement('span');
  private arrow = document.createElement('i');
  private last = '';
  private lastTurn = NaN;

  constructor(parent: HTMLElement) {
    this.root.id = 'goal-line';
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'off');
    this.arrow.setAttribute('aria-hidden', 'true');
    this.arrow.textContent = '↑';
    this.root.append(this.clock, this.text, this.arrow);
    parent.append(this.root);
  }

  /**
   * `clock`: the run's time as text, or '' for none; `text`: the rest; `turn`: the arrow's turn in radians (clockwise
   * on screen, 0 straight ahead), or null for no arrow. Everything empty: hidden.
   */
  set(clock: string, text: string, turn: number | null): void {
    const key = `${clock}\u0000${text}\u0000${turn === null ? '' : 'a'}`;
    if (key !== this.last) {
      this.last = key;
      this.root.hidden = !clock && !text;
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
