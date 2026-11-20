/**
 * The Brook Spirit's one small line (world/spiritFight.ts decides what it says): under the game's bar, built like
 * the Zombies duel's (ui/duelLine.ts), shown only within 60 m of its wood. "Brook Spirit 72% · the heart is open!",
 * "Its shell is shut · shoot the lights among the trees: 2 left", and the like (the `spirit.*` and `sgl.*` keys). No
 * card over the game: the fight shows itself in the world first. Its text goes in with textContent only.
 */
export type SpiritTone = 'calm' | 'fight' | 'open' | 'shell' | 'gift';

export class SpiritLine {
  private el = document.getElementById('spirit-line');
  private text = '';
  private tone: SpiritTone | '' = '';

  /** The line's text, or null to hide it. */
  set(text: string | null, tone: SpiritTone = 'calm'): void {
    const el = this.el;
    if (!el) return;
    const show = !!text;
    if (show !== !el.classList.contains('hidden')) el.classList.toggle('hidden', !show);
    if (!show) return;
    if (text !== this.text) {
      this.text = text!;
      el.textContent = text;
    }
    if (tone !== this.tone) {
      this.tone = tone;
      el.dataset.tone = tone;
    }
  }
}
