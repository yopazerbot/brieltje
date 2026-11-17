// The host page's guards for Steal the flag, a test tool (server/flagGuards.mjs): per team how many (0 to 6) and how
// well they shoot. Drawn from the host page's own view (host.js sends it as the 'hostview' event, once a second); a
// change is one POST /api/host { op: 'guards', team, count, skill }, which the server checks again. Only numbers and
// fixed words go into the page, with textContent.
(() => {
  const $ = (id) => document.getElementById(id);
  const TEAMS = { blue: { name: 'Blue', color: '#4fa3e0' }, red: { name: 'Red', color: '#e5484d' } };
  const SKILLS = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
  let drawn = '';
  let note = '';

  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, val] of Object.entries(props)) {
      if (k === 'text') e.textContent = val;
      else if (k === 'on') for (const [ev, f] of Object.entries(val)) e.addEventListener(ev, f);
      else if (val !== undefined && val !== null && val !== false) e.setAttribute(k, val === true ? '' : val);
    }
    e.append(...kids.filter(Boolean));
    return e;
  };

  async function send(team) {
    const count = Number($(`guards-${team}-count`).value);
    const skill = $(`guards-${team}-skill`).value;
    try {
      const r = await fetch('/api/host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'guards', team, count, skill }) });
      const data = await r.json().catch(() => ({}));
      note = r.ok ? `${TEAMS[team].name}: ${count} guard${count === 1 ? '' : 's'}, ${SKILLS[skill].toLowerCase()}` : data.error || `Refused (${r.status})`;
    } catch {
      note = 'No answer from the server';
    }
    drawn = '';
  }

  function draw(v) {
    const g = v.guards;
    const box = $('guards');
    if (!box) return;
    if (!g) {
      box.replaceChildren(el('p', { class: 'muted small', text: 'Not available here.' }));
      return;
    }
    const key = JSON.stringify([g, note]);
    if (key === drawn || box.contains(document.activeElement)) return;
    drawn = key;
    const rows = Object.entries(TEAMS).map(([team, t]) => {
      const s = g[team];
      const count = el('select', { id: `guards-${team}-count`, 'aria-label': `${t.name} guards`, on: { change: () => send(team) } },
        ...Array.from({ length: g.max + 1 }, (_, n) => el('option', { value: String(n), selected: n === s.count, text: n ? String(n) : 'None' })));
      const skill = el('select', { id: `guards-${team}-skill`, 'aria-label': `${t.name} guards' skill`, on: { change: () => send(team) } },
        ...g.skills.map((k) => el('option', { value: k, selected: k === s.skill, text: SKILLS[k] ?? k })));
      const state = !s.count ? 'Off' : g.on ? `${s.here} walking` : 'When Steal the flag starts';
      const label = el('b', { text: t.name });
      label.style.color = t.color;
      return el('div', { class: 'guard-row' }, label, el('label', {}, 'Guards ', count), el('label', {}, 'Skill ', skill), el('small', { class: 'muted', text: state }));
    });
    box.replaceChildren(...rows, note ? el('p', { class: 'muted small', role: 'status', text: note }) : null);
  }

  document.addEventListener('hostview', (e) => draw(e.detail));
})();
