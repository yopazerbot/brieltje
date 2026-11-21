// The hall's screen after a team game, and its sounds (Yoshi, 21 Nov 2026: "Also think about what can improve in the
// team versus team, capture the flag"; on the merger's recommendations, a results moment with awards and a short sound
// from the hall's speakers: "Do what u think is best"). Shared by the two pages a game night projects: the watch page
// (/admin/watch, watch.js) and the scoreboard (/admin/scores, scores.js). Both are admin only.
//
// - The results moment (moment): for the 20 s the server shows a team game's result (server/awards.mjs RESULTS_MS),
//   over the page: the winner in its team's colour and how it was decided, the score, then the awards one by one (a
//   child's-words title, the player's name in their team's colour, the number behind it), then the evening's team
//   totals. Big type for the back of a hall; it comes in with a simple motion and goes by itself with free play.
//   Everything in it is the server's (the mode's `results`, chosen there from its own counts); names go in with
//   textContent only, one line each, cut short with an ellipsis and isolated from the text around them (a name with
//   right-to-left marks cannot turn the line round). Nothing else is shown: no addresses, no connection data.
// - The sounds (sound): a third family of stings beside Steal the flag's own two (src/ui/flagSounds.ts: a fanfare for
//   your side, an alarm for theirs). The hall has both teams in it, so these are neutral: a wooden mallet and a soft
//   bell, mid-range, short, never loud or shrill, no voice. A flag taken, a flag saved (home), a capture, the last
//   minute, the end, the results moment's start. Made in code (Web Audio), like every sound in the game; `sting` works
//   on any BaseAudioContext, so an OfflineAudioContext renders them for a check without ears.
// - A browser plays nothing before someone touched the page. The host starts the hall's screen with a click or a key
//   (F for full screen): that first touch switches the sound on, with a quiet two-note chime so the host hears the
//   speakers work. A small chip says the state ("Sound off: click or press S" until then); S or a click on it switches
//   it off and on. Switched off by the host, it stays off in this browser (localStorage briel.hall.sound, a convenience).
(() => {
  const WORDS = {
    nl: {
      won: '{team} wint!', draw: 'Gelijkspel', over: 'Afgelopen',
      dScore: '{a} – {b} in vlaggen', dTags: 'op tikken, {a} – {b}', dFar: 'de vlag het verst gebracht: {a}%', dDraw: 'gelijk in vlaggen en tikken',
      dTeams: '{a} – {b} in tikken', dTeamsDraw: '{a} – {b}: gelijk', aTime: 'de snelste verovering: {a} s', aOnly: 'de enige verovering: {a} s', aFar: 'de vlag het verst gebracht: {a}%', aTags: 'op tikken, {a} – {b}',
      awards: 'Prijzen', totals: 'Totaal vanavond', points: 'punten',
      blue: 'Blauw', red: 'Rood', green: 'Groen', purple: 'Paars', house: 'Huis', bungalow: 'Bungalow',
      soundOff: 'Geluid uit · klik of druk S', soundOn: 'Geluid aan · S zet het uit', soundMuted: 'Geluid uit · S zet het aan',
    },
    en: {
      won: '{team} wins!', draw: 'A draw', over: 'Over',
      dScore: '{a} – {b} in flags', dTags: 'on tags, {a} – {b}', dFar: 'got the flag furthest: {a}%', dDraw: 'level in flags and in tags',
      dTeams: '{a} – {b} in tags', dTeamsDraw: '{a} – {b}: level', aTime: 'the fastest capture: {a} s', aOnly: 'the only capture: {a} s', aFar: 'got the flag furthest: {a}%', aTags: 'on tags, {a} – {b}',
      awards: 'Awards', totals: "Tonight's totals", points: 'points',
      blue: 'Blue', red: 'Red', green: 'Green', purple: 'Purple', house: 'House', bungalow: 'Bungalow',
      soundOff: 'Sound off · click or press S', soundOn: 'Sound on · S turns it off', soundMuted: 'Sound off · S turns it on',
    },
  };
  // The awards (server/awards.mjs AWARDS): a title in a child's words, and the number behind it (one, other).
  const AWARD = {
    nl: {
      flagsIn: ['Meeste vlaggen binnen', '{n} vlag binnengebracht', '{n} vlaggen binnengebracht'],
      furthest: ['Verst met de vlag', '{n}% van de weg', '{n}% van de weg'],
      saver: ['Vlaggenredder', '{n} vlag teruggebracht', '{n} vlaggen teruggebracht'],
      wall: ['Muur van de basis', '{n} keer tegengehouden', '{n} keer tegengehouden'],
      helper: ['Beste helper', 'hielp bij {n} vlag', 'hielp bij {n} vlaggen'],
      tagger: ['Meeste tikken', '{n} tik', '{n} tikken'],
      streak: ['Moeilijkst te vangen', '{n} tik zonder zelf getikt te worden', '{n} tikken op rij zonder zelf getikt te worden'],
      teamPlayer: ['Teamspeler', '{n} tik samen met een teamgenoot', '{n} tikken samen met een teamgenoot'],
      neverGaveUp: ['Nooit opgegeven', '{n} keer teruggekomen', '{n} keer teruggekomen'],
    },
    en: {
      flagsIn: ['Most flags in', '{n} flag brought in', '{n} flags brought in'],
      furthest: ['Furthest with the flag', '{n}% of the way', '{n}% of the way'],
      saver: ['Flag saver', '{n} flag brought home', '{n} flags brought home'],
      wall: ['Wall of the base', 'kept them out {n} time', 'kept them out {n} times'],
      helper: ['Best helper', 'helped at {n} capture', 'helped at {n} captures'],
      tagger: ['Most tags', '{n} tag', '{n} tags'],
      streak: ['Hardest to catch', '{n} tag without being tagged', '{n} tags in a row without being tagged'],
      teamPlayer: ['Team player', '{n} tag side by side with a teammate', '{n} tags side by side with a teammate'],
      neverGaveUp: ['Never gave up', 'came back {n} time', 'came back {n} times'],
    },
  };
  const COLOURS = { blue: '#4fa3e0', red: '#e5484d', green: '#5cc28a', purple: '#c77dff', house: '#4fa3e0', bungalow: '#ff9f43' };
  const RESULTS_MS = 20_000; // server/awards.mjs
  const AWARDS_AT = 3000; // the awards come in after the winner has shown a while
  const STEP_MS = 700; // one after another
  const TOTALS_AT = 13_000;

  const fill = (s, args) => String(s).replace(/\{(\w+)\}/g, (_, a) => String(args?.[a] ?? ''));
  const say = (lang, k, args) => fill((WORDS[lang] ?? WORDS.en)[k] ?? WORDS.en[k] ?? k, args);
  const colour = (c, d = '#8a93b8') => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : d);
  const num = (n) => (Number.isFinite(n) ? n : 0);
  const str = (v, max = 40) => (typeof v === 'string' ? v.slice(0, max) : '');
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  /** An award's title and its number line, in `lang` (an id this page does not know: none). */
  function award(lang, id, n) {
    const a = (AWARD[lang] ?? AWARD.en)[id];
    if (!a) return null;
    return { title: a[0], line: fill(num(n) === 1 ? a[1] : a[2], { n: num(n) }) };
  }

  /** A team's name as the hall says it: the evening's (blue, red) or the game's own (house, bungalow). */
  function teamName(lang, team, mode) {
    if (team === 'house' || team === 'bungalow') team = mode?.names?.[team] ?? team;
    return WORDS[lang]?.[team] ? say(lang, team) : '';
  }

  /** The winner and how it was decided, from the server's result (server/modes.mjs finish, server/assault.mjs final). */
  function verdict(lang, m) {
    const a = m.resultArgs && typeof m.resultArgs === 'object' ? m.resultArgs : {};
    const team = typeof a.team === 'string' ? a.team : null;
    const named = team ? teamName(lang, team, m) : '';
    const code = m.resultCode;
    const head = named ? say(lang, 'won', { team: named }) : code === 'flagDraw' || code === 'teamsDraw' || code === 'assaultDraw' ? say(lang, 'draw') : say(lang, 'over');
    const two = { a: num(a.a), b: num(a.b) };
    const line = {
      flagWon: () => say(lang, 'dScore', { a: num(a.blue), b: num(a.red) }),
      flagTagsWon: () => say(lang, 'dTags', two), flagFarBlue: () => say(lang, 'dFar', two), flagFarRed: () => say(lang, 'dFar', two), flagDraw: () => say(lang, 'dDraw'),
      teamWon: () => say(lang, 'dTeams', { a: num(a.house), b: num(a.bungalow) }), teamsTime: () => say(lang, 'dTeams', { a: num(a.house), b: num(a.bungalow) }), teamsDraw: () => say(lang, 'dTeamsDraw', { a: num(a.house), b: num(a.bungalow) }),
      assaultTime: () => say(lang, 'aTime', two), assaultOnly: () => say(lang, 'aOnly', two), assaultFar: () => say(lang, 'aFar', two), assaultTags: () => say(lang, 'aTags', two),
    }[code];
    return { head, line: line ? line() : '', team };
  }

  /** The two sides and their score: [{ id, name, colour, score }] for the flag games and the team deathmatch. */
  function sides(lang, m) {
    const keys = m.kind === 'teams' ? ['house', 'bungalow'] : ['blue', 'red'];
    return keys.map((k) => {
      const shown = m.kind === 'teams' ? m.names?.[k] ?? k : k;
      return { id: shown, name: teamName(lang, k, m), colour: colour(m.colors?.[k], COLOURS[shown] ?? COLOURS[k]), score: num(m.score?.[k]) };
    });
  }

  // ------------------------------------------------------------------ the results moment

  let built = null; // { key, root, box, awards, totals }

  /**
   * The results moment over `root` (its own box, made here): `m` the mode as the server sends it (shown while a team
   * game's result shows, with its `results`), `msLeft` its time left now, `evening` the evening's board ({ teams }),
   * `lang` 'nl' or 'en'. Anything else: gone.
   */
  function moment(root, m, msLeft, evening, lang) {
    const on = !!m && (m.kind === 'flag' || m.kind === 'teams') && m.phase === 'done' && !!m.results && Array.isArray(m.results.awards);
    if (!on) {
      if (built) {
        const old = built.box;
        old.classList.add('leaving');
        setTimeout(() => old.remove(), 600);
        built = null;
      }
      return false;
    }
    const since = RESULTS_MS - Math.max(0, num(msLeft));
    const totals = (Array.isArray(evening?.teams) ? evening.teams : []).filter((x) => typeof x?.id === 'string' && COLOURS[x.id]);
    const key = JSON.stringify([m.resultCode, m.resultArgs, m.score, m.results.awards, totals.map((x) => [x.id, x.points]), lang]);
    if (built?.key !== key) {
      built?.box.remove();
      built = { key, ...build(m, totals, lang) };
      root.append(built.box);
      fitNames(built.box);
    }
    // The steps by the time since the end (a page opened midway shows what is due at once).
    built.box.classList.toggle('awards-on', since >= AWARDS_AT);
    built.box.classList.toggle('totals-on', since >= TOTALS_AT && totals.length > 0);
    return true;
  }

  /**
   * A long name on an award card (a name may have 20 letters, a card is a quarter of the screen): its type smaller,
   * step by step, until it fits, down to about half the size; longer still, it ends in an ellipsis (hall.css).
   */
  function fitNames(box) {
    for (const n of box.querySelectorAll('.hr-name')) {
      let size = parseFloat(getComputedStyle(n).fontSize);
      const least = size * 0.5;
      for (let i = 0; i < 12 && n.scrollWidth > n.clientWidth + 1 && size > least; i++) {
        size = Math.max(least, size * 0.9);
        n.style.fontSize = `${size.toFixed(1)}px`;
      }
    }
  }

  function build(m, totals, lang) {
    const box = el('section', 'hall-results');
    box.setAttribute('aria-live', 'off');
    const v = verdict(lang, m);
    const win = v.team ? sides(lang, m).find((s) => s.id === v.team) ?? null : null; // `team`: the name it played under
    box.style.setProperty('--win', win ? win.colour : '#f7b928');
    const head = el('div', 'hr-head');
    head.append(el('div', 'hr-win', v.head));
    if (v.line) head.append(el('div', 'hr-line', v.line));
    const score = el('div', 'hr-score');
    const [a, b] = sides(lang, m);
    for (const [s, right] of [[a, false], [b, true]]) {
      const t = el('div', `hr-side${right ? ' right' : ''}${win && win.id === s.id ? ' first' : ''}`);
      t.style.setProperty('--c', s.colour);
      t.append(el('span', 'hr-team', s.name), el('b', '', String(s.score)));
      if (right) score.append(el('i', 'hr-dash', '–'));
      score.append(t);
    }
    head.append(score);
    box.append(head);
    // The awards, one after another.
    const list = m.results.awards.slice(0, 4).map((x) => ({ x, w: award(lang, x?.id, x?.n) })).filter(({ x, w }) => w && str(x?.name));
    const awards = el('div', `hr-awards n${list.length}`);
    list.forEach(({ x, w }, i) => {
      const c = el('div', 'hr-award');
      c.style.setProperty('--c', colour(x.color, COLOURS[x.team]));
      c.style.setProperty('--i', String(i));
      c.style.animationDelay = `${i * STEP_MS}ms`;
      const name = el('div', 'hr-name', str(x.name));
      name.dir = 'auto';
      c.append(el('div', 'hr-title', w.title), name, el('div', 'hr-n', w.line));
      awards.append(c);
    });
    if (list.length) box.append(awards);
    // Tonight's totals (the evening's teams, server/host.mjs board).
    if (totals.length) {
      const t = el('div', 'hr-totals');
      t.append(el('div', 'hr-label', say(lang, 'totals')));
      const row = el('div', 'hr-trow');
      for (const x of totals) {
        const c = el('div', 'hr-total');
        c.style.setProperty('--c', COLOURS[x.id]);
        c.append(el('span', '', say(lang, x.id)), el('b', '', String(num(x.points))), el('small', '', say(lang, 'points')));
        row.append(c);
      }
      t.append(row);
      box.append(t);
    }
    return { box };
  }

  // ------------------------------------------------------------------ the hall's stings (made in code)

  // [kind of voice, frequency (Hz), start (s), length (s), loudness (0..1)]. 'm' a mallet (wood: a sine with its fourth
  // partial, a quick decay), 'b' a bell (soft inharmonic partials, a long decay), 'k' a woodblock tick (a short filtered
  // knock). Neutral for a hall with both teams: no rising fanfare of one side, no alarm; a pentatonic palette.
  const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, D6 = 1174.66, E6 = 1318.51, G4 = 392, C4 = 261.63, E4 = 329.63, A4 = 440;
  const STINGS = {
    taken: [['m', G5, 0, 0.35, 0.8], ['m', D6, 0.14, 0.5, 0.9]], // "something's on": two mallet notes up a fifth
    home: [['m', E6, 0, 0.3, 0.6], ['m', C6, 0.12, 0.3, 0.6], ['m', G5, 0.24, 0.6, 0.7]], // settled again: three down
    capture: [['m', C5, 0, 0.3, 0.7], ['m', E5, 0.1, 0.3, 0.75], ['m', G5, 0.2, 0.3, 0.8], ['m', C6, 0.3, 0.4, 0.9], ['b', C6, 0.42, 1.6, 0.75], ['b', G5, 0.42, 1.6, 0.4]], // a run up and a bell
    lastMinute: [['k', 1400, 0, 0.06, 0.7], ['k', 1050, 0.32, 0.06, 0.7], ['k', 1400, 0.64, 0.06, 0.7], ['b', A5, 0.96, 1.1, 0.55]], // tick, tock, tick, a bell
    end: [['b', C5, 0, 2.4, 0.8], ['b', E5, 0.05, 2.3, 0.55], ['b', G5, 0.1, 2.2, 0.5], ['m', C4, 0, 0.8, 0.6], ['b', C6, 0.5, 1.9, 0.4]], // one warm chord, held
    results: [['m', C5, 0, 0.2, 0.5], ['m', D5, 0.08, 0.2, 0.55], ['m', E5, 0.16, 0.2, 0.6], ['m', G5, 0.24, 0.2, 0.65], ['m', A5, 0.32, 0.2, 0.7], ['m', C6, 0.4, 0.25, 0.75], ['m', D6, 0.48, 0.3, 0.8], ['b', E6, 0.6, 1.4, 0.55], ['b', A4, 0.6, 1.4, 0.3]], // a quick climb to a chime
    hello: [['b', E4 * 2, 0, 0.7, 0.35], ['b', G4 * 2, 0.16, 0.9, 0.35]], // the sound switched on: a quiet two-note chime
  };
  // One voice at full loudness: rendered through the limiter, the stings peak at about -15 to -6 dBFS and sit within a
  // few dB of Steal the flag's own sounds on average (their notes are struck and die away; the flag's are held).
  const PEAK = 0.28;

  /** Plays sting `kind` into `out` from `t0` (seconds on `ctx`'s clock). Returns its length in seconds. */
  function sting(ctx, out, t0, kind) {
    const notes = STINGS[kind] ?? STINGS.taken;
    let end = 0;
    for (const [voice, f, at, len, level] of notes) {
      const start = t0 + at;
      end = Math.max(end, at + len + 0.05);
      const peak = PEAK * level;
      if (voice === 'k') {
        // A woodblock: a short burst of noise through a narrow band-pass at `f`.
        const n = Math.ceil(ctx.sampleRate * 0.08);
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let seed = 7;
        for (let i = 0; i < n; i++) {
          seed = (seed * 16807) % 2147483647;
          d[i] = (seed / 2147483647) * 2 - 1;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f;
        bp.Q.value = 9;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(peak * 3.2, start + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, start + len);
        src.connect(bp).connect(g).connect(out);
        src.start(start);
        src.stop(start + 0.08);
        continue;
      }
      // Mallet: the fundamental and its fourth partial (a marimba's bar), the partial dying first. Bell: partials at
      // 1, 2, 2.76 and 5.4 times the note, the higher ones quieter and shorter.
      const parts = voice === 'm' ? [[1, 1, len], [4, 0.18, len * 0.3]] : [[1, 1, len], [2, 0.32, len * 0.7], [2.76, 0.2, len * 0.5], [5.4, 0.07, len * 0.3]];
      for (const [ratio, amp, dur] of parts) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f * ratio, start);
        const g = ctx.createGain();
        const p = peak * amp;
        const attack = voice === 'm' ? 0.004 : 0.008;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(p, start + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(attack + 0.02, dur));
        o.connect(g).connect(out);
        o.start(start);
        o.stop(start + dur + 0.02);
      }
    }
    return end;
  }

  // ------------------------------------------------------------------ the sound on the page

  const KEY = 'briel.hall.sound';
  const kept = (() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  })();
  const sound = {
    /** The host switched it off (S, the chip): stays off until switched on again. */
    muted: kept === 'off',
    /** Someone touched the page: the browser lets it play. */
    unlocked: false,
    ctx: null,
    out: null,
    chip: null,
    lang: 'nl',
    hideAt: 0,
    get on() {
      return this.unlocked && !this.muted && !!this.ctx;
    },
    /** The first touch of the page (a click, a key): the audio starts, the sound on unless the host switched it off. */
    unlock() {
      if (this.unlocked) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        void this.ctx.resume?.();
        // Through a gentle limiter: a hall's amplifier never gets a sudden peak.
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        comp.connect(this.ctx.destination);
        this.out = comp;
        this.unlocked = true;
      } catch {
        return;
      }
      if (this.on) this.play('hello');
      this.draw(true);
    },
    toggle() {
      if (!this.unlocked) return this.unlock();
      this.muted = !this.muted;
      try {
        localStorage.setItem(KEY, this.muted ? 'off' : 'on');
      } catch {
        // storage blocked
      }
      if (this.on) this.play('hello');
      this.draw(true);
    },
    play(kind) {
      if (!this.on) return;
      try {
        void this.ctx.resume?.();
        sting(this.ctx, this.out, this.ctx.currentTime + 0.03, kind);
      } catch {
        // audio unavailable
      }
    },
    /** The chip: always while off; while on, a few seconds after a change or a movement of the mouse. */
    draw(flash = false) {
      if (!this.chip) return;
      const text = !this.unlocked ? say(this.lang, 'soundOff') : this.muted ? say(this.lang, 'soundMuted') : say(this.lang, 'soundOn');
      if (this.chip.textContent !== text) this.chip.textContent = text;
      this.chip.classList.toggle('on', this.on);
      this.chip.setAttribute('aria-pressed', String(this.on));
      if (flash) this.hideAt = performance.now() + 4000;
      this.chip.classList.toggle('shown', !this.on || performance.now() < this.hideAt);
    },
    /**
     * The chip on the page and the touches that switch the sound on (once per page). `where`: the element it goes in
     * (the page's body, in a corner, by default; the scoreboard puts it in its header, scores.css).
     */
    mount(lang = 'nl', where = document.body) {
      this.lang = lang;
      if (this.chip) {
        if (where && this.chip.parentNode !== where) where.append(this.chip);
        return this.draw();
      }
      const chip = el('button', 'hall-sound');
      chip.type = 'button';
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.unlocked) this.unlock();
        else this.toggle();
      });
      (where ?? document.body).append(chip);
      this.chip = chip;
      const first = () => this.unlock();
      addEventListener('pointerdown', first, { capture: true });
      addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
        if (e.key.toLowerCase() === 's' && !e.repeat) {
          e.preventDefault();
          if (this.unlocked) this.toggle();
          else this.unlock();
        } else first();
      }, { capture: true });
      addEventListener('mousemove', () => this.draw(true));
      setInterval(() => this.draw(), 500);
      this.draw();
    },
  };

  // ------------------------------------------------------------------ what the hall hears, from the server's state

  let last = null; // the last mode heard: { kind, phase, ms, flags, score, at }
  /**
   * The mode as a page read it (each second, or from the stream), compared with the last one: a sting for each change
   * a room wants to hear. Steal the flag and Attack and defend: a flag taken (home or on the ground to carried), saved
   * (back home without a point), brought in (a team's score up); every team game: the last minute, the end, and the
   * results moment's start (AWARDS_AT after the end).
   */
  function hear(m) {
    const now = performance.now();
    const team = !!m && (m.kind === 'flag' || m.kind === 'teams');
    const cur = team ? { kind: m.kind, phase: m.phase, ms: num(m.ms), flags: m.flag?.flags ?? null, score: { ...(m.score ?? {}) }, at: now, round: m.flag?.assault?.round ?? 0 } : null;
    const prev = last;
    last = cur;
    if (!cur || !prev || prev.kind !== cur.kind) return;
    if (prev.phase === 'playing' && cur.phase === 'done') {
      sound.play('end');
      setTimeout(() => last?.phase === 'done' && sound.play('results'), AWARDS_AT);
      return;
    }
    if (cur.phase !== 'playing' || prev.phase !== 'playing') return;
    let what = null;
    const up = Object.keys(cur.score).some((k) => num(cur.score[k]) > num(prev.score[k]));
    if (up && cur.kind === 'flag') what = 'capture';
    else if (cur.flags && prev.flags) {
      for (const t of ['blue', 'red']) {
        const a = prev.flags[t]?.at;
        const b = cur.flags[t]?.at;
        if (a !== 'carried' && b === 'carried') what ??= 'taken';
        if (a && a !== 'home' && b === 'home' && !up) what = what ?? 'home';
      }
    }
    // The last minute: the clock crossing 60 s (a round's in Attack and defend), not a game that starts under it.
    if (!what && prev.round === cur.round && prev.ms > 60_000 && cur.ms <= 60_000 && cur.ms > 50_000) what = 'lastMinute';
    if (what) sound.play(what);
  }

  window.BrielHall = { moment, hear, sound, sting, award, verdict, STINGS: Object.keys(STINGS), RESULTS_MS };
})();
