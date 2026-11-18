// Steal the flag's "Swap sides" on the host's screen (server/host.mjs `swap`, server/flags.mjs swap; Yoshi, 17 Nov 2026:
// "Swapping sides only at request of the admin"). Shown only while a flag game is played, next to Stop the game; it asks
// for a second click within 4 s, then POST /api/host { op: 'swap' } (the admin's session, same-origin JSON). The server
// checks it again: the admin only, the game played, at most once every 10 s. Reads the host page's view from its
// `hostview` event (host.js), sends nothing else. Text goes in with textContent only.
(() => {
  const stop = document.getElementById('stop');
  if (!stop) return;
  const btn = document.createElement('button');
  btn.className = 'btn ghost';
  btn.type = 'button';
  btn.id = 'swap-sides';
  btn.hidden = true;
  btn.textContent = 'Swap sides';
  stop.after(btn);
  let asking = 0;
  let busy = false;
  const label = (text, ms = 0) => {
    btn.textContent = text;
    if (ms) setTimeout(() => { if (!asking) btn.textContent = 'Swap sides'; }, ms);
  };
  document.addEventListener('hostview', (e) => {
    const m = e.detail?.mode;
    btn.hidden = !(m && m.kind === 'flag' && m.phase === 'playing' && !m.flag?.assault); // Attack and defend swaps the roles itself
  });
  btn.addEventListener('click', async () => {
    if (busy) return;
    if (Date.now() > asking) {
      asking = Date.now() + 4000;
      btn.classList.add('asking');
      label('Swap now? Click again');
      setTimeout(() => {
        if (Date.now() >= asking) {
          asking = 0;
          btn.classList.remove('asking');
          label('Swap sides');
        }
      }, 4100);
      return;
    }
    asking = 0;
    btn.classList.remove('asking');
    busy = true;
    try {
      const r = await fetch('/api/host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'swap' }) });
      const data = await r.json().catch(() => ({}));
      label(r.ok ? 'Sides swapped' : data.error || `Refused (${r.status})`, 3000);
    } catch {
      label('No answer from the server', 3000);
    } finally {
      busy = false;
    }
  });
})();
