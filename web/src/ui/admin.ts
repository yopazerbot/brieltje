import { api, errorText } from '../net/client';
import { t } from '../i18n';

/** The admin's tab in the menu: who is online (with a kick button) and the login log. */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

export class AdminPanel {
  private root = document.getElementById('admin')!;
  private me = '';

  show(me: string | null): void {
    this.me = me ?? '';
    if (me) void this.refresh();
  }

  private message(text: string, bad = false): void {
    const m = this.root.querySelector('.admin-msg');
    if (m) {
      m.textContent = text;
      m.classList.toggle('bad', bad);
    }
  }

  async refresh(): Promise<void> {
    const { players, max } = await api.players().catch((e) => {
      this.root.replaceChildren(el('p', t('adm.unavailable', { msg: errorText(e)() }), 'admin-msg bad'));
      throw e;
    });
    const online = el('div', '', 'admin-block');
    online.append(el('b', t('adm.online', { n: players.length, max })));
    for (const p of players) {
      const row = el('div', '', 'admin-row');
      const name = el('span', p.role === 'admin' ? t('role.admin', { name: p.name }) : p.name);
      name.style.color = p.color;
      row.append(name);
      if (p.name !== this.me) {
        const kick = el('button', t('adm.kick'), 'mini danger');
        kick.onclick = () => this.act(() => api.kick(p.name), t('adm.kicked', { name: p.name }));
        row.append(kick);
      }
      online.append(row);
    }

    const logBtn = el('button', t('adm.showLog'), 'mini');
    const logBox = el('div', '', 'admin-log hidden');
    logBtn.onclick = async () => {
      const open = !logBox.classList.toggle('hidden');
      logBtn.textContent = t(open ? 'adm.hideLog' : 'adm.showLog');
      if (open) {
        const { log } = await api.audit();
        logBox.replaceChildren(...log.map((e) => el('div', `${e.time}  ${e.event}  ${e.username ?? ''}  ${e.ip ?? ''}  ${e.detail ?? ''}`)));
      }
    };

    this.root.replaceChildren(online, logBtn, logBox, el('p', '', 'admin-msg'));
  }

  private async act(fn: () => Promise<unknown>, done: string): Promise<void> {
    try {
      await fn();
      await this.refresh();
      this.message(done);
    } catch (e) {
      this.message(errorText(e)(), true);
    }
  }
}
