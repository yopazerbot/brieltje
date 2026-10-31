import { onLang } from '../i18n';

/**
 * Chat: messages bottom left, T (or Enter) to type, Enter to send, Esc to cancel. The game's own
 * lines are written again in another language when it changes; what players typed stays as it is.
 */
export class Chat {
  onSend: (text: string) => void = () => {};
  private log = document.getElementById('chat-log')!;
  private input = document.getElementById('chat-input') as HTMLInputElement;
  private texts = new WeakMap<Element, () => string>();
  enabled = false;

  constructor() {
    onLang(() => {
      for (const line of this.log.children) {
        const text = this.texts.get(line);
        if (text) line.textContent = text();
      }
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const text = this.input.value.trim();
        if (text) this.onSend(text);
        this.close();
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.close();
        e.preventDefault();
      }
      e.stopPropagation();
    });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || this.typing || e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyT' || e.code === 'Enter') {
        e.preventDefault();
        this.open();
      }
    });
  }

  get typing(): boolean {
    return document.activeElement === this.input;
  }

  open(): void {
    this.input.classList.add('show');
    this.input.value = '';
    this.input.focus();
    this.log.classList.add('active');
  }

  close(): void {
    this.input.blur();
    this.input.classList.remove('show');
    this.log.classList.remove('active');
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.log.style.display = on ? '' : 'none';
    if (!on) this.close();
  }

  /** A line from the game itself, made by `text` in the current language (as text, never as HTML). */
  system(text: () => string): void {
    const line = this.add('', '', text());
    this.texts.set(line, text);
  }

  /** Add a line; `from` empty means a system message. */
  add(from: string, color: string, text: string): HTMLElement {
    const line = document.createElement('div');
    line.className = 'line';
    if (from) {
      const who = document.createElement('b');
      who.textContent = `${from}: `;
      who.style.color = color;
      line.append(who);
    } else {
      line.classList.add('system');
    }
    line.append(text);
    this.log.append(line);
    while (this.log.children.length > 30) this.log.firstElementChild?.remove();
    setTimeout(() => line.classList.add('old'), 15000);
    return line;
  }
}
