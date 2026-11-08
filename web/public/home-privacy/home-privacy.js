// brieltje.be/home-privacy: how the inside of a home stays private, shown to owners who think of adding theirs.
// Everything here runs in the visitor's browser and sends nothing: the window slider, the sealing demo (the same
// steps and file layout as server/privateCrypto.mjs, with a throwaway key made here), an example code, the guessing
// bars (from server/homes.mjs's limits) and the picture of what the server sends to whom. Text from the page's
// own fields goes in with textContent only. (A file of its own: the site's Content-Security-Policy allows no inline
// scripts.)
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  // ---- words made here (the rest of the page has both languages in its HTML)
  const W = {
    nl: {
      houseTitle: 'Een huis met twee ramen: links met meubels, rechts een lege ruimte, met dezelfde speler binnen.',
      netTitle: 'De server stuurt de binnenkant naar speler A met de code, en enkel de schil naar speler B zonder code.',
      size: (n, len, block) => `${n} bytes in totaal. Je tekst is ${len} bytes; opgevuld tot ${block} bytes, dus de grootte verraadt niets.`,
      more: (n) => ` … nog ${n} bytes`,
      noCrypto: 'Je browser kan deze demo niet uitvoeren (Web Crypto ontbreekt). De rest van de pagina werkt wel.',
      badName: 'Een bestandsnaam bestaat uit kleine letters, cijfers, punten, streepjes en liggende streepjes (maximaal 64).',
      opened: 'Geopend: het zegel klopt.',
      openedSub: 'Enkel de serversleutel kon dit. Dit is wat erin zat:',
      broken: 'Geweigerd: het zegel is gebroken.',
      tampered: (i) => `Byte ${i} is gewijzigd (roze). AES-GCM merkt dat meteen: de server zou dit bestand weigeren. Het origineel is niet aangeraakt.`,
      renamed: (a, b) => `Hetzelfde bestand, geopend als "${b}" in plaats van "${a}". De naam zit mee in het zegel, dus twee huizen verwisselen lukt niet.`,
      wrongKey: 'Een andere sleutel, zoals iemand die de openbare code heeft maar niet de serversleutel. Er komt niets uit.',
      sealed: 'Verzegeld. Probeer het nu te openen, of probeer het te breken.',
      curve: 'Je browser kent X25519 nog niet, dus deze demo gebruikt P-256, een andere curve met hetzelfde idee. De server gebruikt X25519.',
      bars: [
        { cls: 'pin', who: 'Een pincode van 4 cijfers', how: 'zonder limiet, 1.000 pogingen per seconde' },
        { cls: 'crowd', who: 'Een massa computers', how: 'samen ongeveer 3.900 pogingen per uur' },
        { cls: 'one', who: 'Eén computer', how: '30 pogingen per uur' },
        { cls: 'earth', who: 'Ter vergelijking', how: 'de leeftijd van de aarde' },
      ],
      dur: { s: 'seconden', min: 'minuten', h: 'uur', d: 'dagen', y: 'jaar', My: 'miljoen jaar', By: 'miljard jaar' },
      net: [
        { cls: 'inside', text: 'A typt de code aan de deur. De server controleert hem: juist. A krijgt een pas van 8 uur.' },
        { cls: 'inside', text: 'Server → A: de binnenkant van het huis, met de kamers, de trap en de meubels.' },
        { cls: 'shell', text: 'Server → B: enkel de schil. De binnenkant wordt nooit verstuurd.' },
        { cls: 'pos', text: 'A wandelt binnen rond. Die positie gaat ook naar B: B ziet A lopen, in een lege ruimte.' },
        { cls: 'deny', text: 'B probeert binnen te wandelen door de open deur. De server weigert die positie en zet B terug buiten.' },
        { cls: 'inside', text: 'A opent binnen een deur. Enkel wie toegang heeft, hoort daarvan.' },
      ],
      pk: { code: 'code ✓', inside: 'binnenkant', shell: 'schil', pos: 'positie', walk: 'binnen?', no: '✗ buiten', door: 'deur' },
    },
    en: {
      houseTitle: 'A house with two windows: furnished on the left, an empty space on the right, with the same player inside.',
      netTitle: 'The server sends the inside to player A, who has the code, and only the shell to player B, who has none.',
      size: (n, len, block) => `${n} bytes in all. Your text is ${len} bytes; padded to ${block} bytes, so the size gives nothing away.`,
      more: (n) => ` … ${n} more bytes`,
      noCrypto: "Your browser can't run this demo (Web Crypto is missing). The rest of the page works.",
      badName: 'A file name is lowercase letters, digits, dots, dashes and underscores (64 at most).',
      opened: 'Opened: the seal holds.',
      openedSub: 'Only the server key could do this. This is what was inside:',
      broken: 'Refused: the seal is broken.',
      tampered: (i) => `Byte ${i} was changed (pink). AES-GCM notices at once: the server would refuse this file. The original is untouched.`,
      renamed: (a, b) => `The same file, opened as "${b}" instead of "${a}". The name is part of the seal, so two homes can't be swapped.`,
      wrongKey: "Another key, like someone who has the public code but not the server key. Nothing comes out.",
      sealed: 'Sealed. Now try to open it, or try to break it.',
      curve: "Your browser doesn't know X25519 yet, so this demo uses P-256, another curve with the same idea. The server uses X25519.",
      bars: [
        { cls: 'pin', who: 'A 4-digit PIN', how: 'no limit, 1,000 tries a second' },
        { cls: 'crowd', who: 'A crowd of computers', how: 'about 3,900 tries an hour together' },
        { cls: 'one', who: 'One computer', how: '30 tries an hour' },
        { cls: 'earth', who: 'For comparison', how: 'the age of the Earth' },
      ],
      dur: { s: 'seconds', min: 'minutes', h: 'hours', d: 'days', y: 'years', My: 'million years', By: 'billion years' },
      net: [
        { cls: 'inside', text: 'A types the code at the door. The server checks it: right. A gets an 8-hour pass.' },
        { cls: 'inside', text: 'Server → A: the inside of the home, with the rooms, the stairs and the furniture.' },
        { cls: 'shell', text: 'Server → B: only the shell. The inside is never sent.' },
        { cls: 'pos', text: "A walks around inside. That position goes to B too: B sees A walking, in an empty space." },
        { cls: 'deny', text: 'B tries to walk in through the open door. The server refuses that position and puts B back outside.' },
        { cls: 'inside', text: 'Inside, A opens a door. Only players with access hear about it.' },
      ],
      pk: { code: 'code ✓', inside: 'inside', shell: 'shell', pos: 'position', walk: 'in?', no: '✗ outside', door: 'door' },
    },
  };
  let lang = 'nl';
  const t = () => W[lang];
  const redraw = []; // parts that draw text of their own, again on a language change

  const pick = () => {
    const asked = new URLSearchParams(location.search).get('lang');
    if (asked === 'nl' || asked === 'en') return asked;
    try {
      const saved = localStorage.getItem('briel.lang');
      if (saved === 'nl' || saved === 'en') return saved;
    } catch {
      // storage blocked: the browser's language
    }
    return /^en\b/i.test(navigator.language || '') ? 'en' : 'nl';
  };
  const setLang = (l) => {
    lang = l;
    document.documentElement.lang = l;
    for (const b of document.querySelectorAll('.langs button')) b.setAttribute('aria-pressed', String(b.dataset.set === l));
    const title = document.querySelector('title');
    if (title?.dataset[l]) document.title = title.dataset[l];
    for (const a of document.querySelectorAll('nav a')) {
      const u = new URL(a.href);
      u.searchParams.set('lang', l);
      a.href = u.pathname + u.search;
      if (a.dataset[l]) a.textContent = a.dataset[l];
    }
    const privacy = $('privacy-link');
    if (privacy) privacy.href = `/legal/privacy.html?lang=${l}#${l}-homes`;
    $('house-title').textContent = t().houseTitle;
    $('net-title').textContent = t().netTitle;
    for (const f of redraw) f();
  };
  for (const b of document.querySelectorAll('.langs button')) b.addEventListener('click', () => setLang(b.dataset.set));

  // ---- 1. the window slider
  (() => {
    const svg = $('house');
    const range = $('split');
    const left = $('clip-left-rect');
    const right = $('clip-right-rect');
    const divider = $('divider');
    const knob = $('knob');
    const arrows = $('knob-arrows');
    const show = () => {
      const x = (Number(range.value) / 100) * 800;
      left.setAttribute('width', String(x));
      right.setAttribute('x', String(x));
      right.setAttribute('width', String(800 - x));
      divider.setAttribute('x1', String(x));
      divider.setAttribute('x2', String(x));
      knob.setAttribute('cx', String(x));
      arrows.setAttribute('transform', `translate(${x - 400} 0)`);
    };
    range.addEventListener('input', show);
    let dragging = false;
    const follow = (e) => {
      const r = svg.getBoundingClientRect();
      range.value = String(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
      show();
    };
    svg.addEventListener('pointerdown', (e) => {
      dragging = true;
      svg.setPointerCapture(e.pointerId);
      follow(e);
    });
    svg.addEventListener('pointermove', (e) => dragging && follow(e));
    for (const ev of ['pointerup', 'pointercancel']) svg.addEventListener(ev, () => (dragging = false));
    show();
  })();

  // ---- 3. the sealing demo: server/privateCrypto.mjs's steps, in the browser
  (() => {
    const MAGIC = new TextEncoder().encode('BPD2');
    const CONTEXT = 'brieltje-private-v2|';
    const NAME_RE = /^[a-z0-9_.-]{1,64}$/;
    const BLOCK = 256; // the server pads to 16 KiB; small here so the whole file fits on screen
    const enc = new TextEncoder();
    const subtle = globalThis.crypto?.subtle;
    const plain = $('plain');
    const nameField = $('file-name');
    const hex = $('hex');
    const result = $('result');
    const buttons = ['open', 'tamper', 'rename', 'wrong-key'].map($);
    plain.value = JSON.stringify({
      home: 'demo-home',
      pieces: [
        { kind: 'sofa', x: 2.4, z: 1.1 },
        { kind: 'lamp', x: 4.0, z: 0.6 },
        { kind: 'stairs', x: 7.2, z: 3.0 },
        { kind: 'plant', x: 0.4, z: 0.3 },
      ],
    }, null, 2);

    let curve = null; // { gen, derive, import, rawLength }
    let server = null; // { keys, publicRaw }
    let sealed = null; // { name, bytes, length }
    let shown = null; // what the result box says, drawn again on a language change

    const concat = (...parts) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

    async function pickCurve() {
      try {
        await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
        return { gen: { name: 'X25519' }, derive: (pub) => ({ name: 'X25519', public: pub }), import: { name: 'X25519' }, x25519: true };
      } catch {
        const p = { name: 'ECDH', namedCurve: 'P-256' };
        return { gen: p, derive: (pub) => ({ name: 'ECDH', public: pub }), import: p, x25519: false };
      }
    }
    async function newServerKey() {
      const keys = await subtle.generateKey(curve.gen, true, ['deriveBits']);
      const publicRaw = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
      server = { keys, publicRaw };
      const id = toHex(new Uint8Array(await subtle.digest('SHA-256', publicRaw))).slice(0, 16);
      $('key-id').textContent = `id ${id}`;
    }
    async function aesKey(privateKey, otherPublic, ephRaw, serverRaw, name) {
      const secret = await subtle.deriveBits(curve.derive(otherPublic), privateKey, 256);
      const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
      return subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: concat(ephRaw, serverRaw), info: enc.encode(CONTEXT + name) },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      );
    }
    async function seal(name, content) {
      const total = Math.max(BLOCK, Math.ceil((4 + content.length) / BLOCK) * BLOCK);
      const padded = new Uint8Array(total);
      new DataView(padded.buffer).setUint32(0, content.length);
      padded.set(content, 4);
      const eph = await subtle.generateKey(curve.gen, true, ['deriveBits']);
      const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
      const key = await aesKey(eph.privateKey, server.keys.publicKey, ephRaw, server.publicRaw, name);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const out = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(CONTEXT + name) }, key, padded));
      const ct = out.subarray(0, out.length - 16);
      const tag = out.subarray(out.length - 16);
      return { bytes: concat(MAGIC, ephRaw, nonce, tag, ct), ephLength: ephRaw.length };
    }
    async function open(name, bytes, keys, publicRaw, ephLength) {
      if (MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('magic');
      let at = MAGIC.length;
      const ephRaw = bytes.slice(at, (at += ephLength));
      const nonce = bytes.slice(at, (at += 12));
      const tag = bytes.slice(at, (at += 16));
      const ct = bytes.slice(at);
      const ephPublic = await subtle.importKey('raw', ephRaw, curve.import, true, []);
      const key = await aesKey(keys.privateKey, ephPublic, ephRaw, publicRaw, name);
      const padded = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(CONTEXT + name) }, key, concat(ct, tag)));
      const length = new DataView(padded.buffer).getUint32(0);
      return new TextDecoder().decode(padded.subarray(4, 4 + length));
    }

    function drawHex(bytes, ephLength, flash = -1) {
      hex.replaceChildren();
      const ends = [MAGIC.length, MAGIC.length + ephLength, MAGIC.length + ephLength + 12, MAGIC.length + ephLength + 28];
      const classes = ['c-magic', 'c-eph', 'c-nonce', 'c-tag', 'c-ct'];
      const limit = Math.min(bytes.length, 1024);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < limit; i++) {
        const part = ends.findIndex((e) => i < e);
        const s = el('span', `b ${classes[part === -1 ? 4 : part]}${i === flash ? ' flash' : ''}`, bytes[i].toString(16).padStart(2, '0'));
        frag.append(s);
      }
      if (bytes.length > limit) frag.append(el('span', 'more', t().more(bytes.length - limit)));
      hex.append(frag);
      if (flash >= 0) hex.querySelector('.flash')?.scrollIntoView({ block: 'nearest' });
    }
    function say(state) {
      shown = state;
      if (!state) {
        result.hidden = true;
        return;
      }
      const w = t();
      result.hidden = false;
      result.className = `result${state.ok ? '' : ' bad'}`;
      result.replaceChildren();
      if (state.kind === 'sealed') result.append(el('b', '', w.sealed));
      else if (state.kind === 'opened') result.append(el('b', '', w.opened), el('span', '', w.openedSub), el('pre', '', state.text));
      else if (state.kind === 'name') result.append(el('b', '', w.badName));
      else {
        result.append(el('b', '', w.broken));
        if (state.kind === 'tampered') result.append(el('span', '', w.tampered(state.at)));
        if (state.kind === 'renamed') result.append(el('span', '', w.renamed(state.from, state.to)));
        if (state.kind === 'wrongKey') result.append(el('span', '', w.wrongKey));
      }
    }
    const sizeLine = () => {
      if (!sealed) return;
      $('size').textContent = t().size(sealed.bytes.length, sealed.length, sealed.bytes.length - MAGIC.length - sealed.ephLength - 28);
    };
    redraw.push(() => {
      say(shown);
      sizeLine();
      if (!curve?.x25519 && curve) $('curve-note').textContent = t().curve;
      if (!subtle) hex.textContent = t().noCrypto;
    });
    const enable = (on) => buttons.forEach((b) => (b.disabled = !on));

    if (!subtle) {
      for (const id of ['seal', 'new-key']) $(id).disabled = true;
      hex.textContent = t().noCrypto;
      return;
    }
    (async () => {
      curve = await pickCurve();
      if (!curve.x25519) {
        $('curve-note').hidden = false;
        $('curve-note').textContent = t().curve;
      }
      await newServerKey();
    })();

    $('new-key').addEventListener('click', async () => {
      await newServerKey();
      sealed = null;
      enable(false);
      say(null);
      $('size').textContent = '';
      hex.replaceChildren();
    });
    $('seal').addEventListener('click', async () => {
      const name = nameField.value.trim();
      if (!NAME_RE.test(name) || name === '.' || name === '..') return say({ ok: false, kind: 'name' });
      if (!server) return;
      const content = enc.encode(plain.value);
      const { bytes, ephLength } = await seal(name, content);
      sealed = { name, bytes, ephLength, length: content.length };
      drawHex(bytes, ephLength);
      sizeLine();
      enable(true);
      say({ ok: true, kind: 'sealed' });
    });
    const attempt = async (name, bytes, keys, publicRaw, failure) => {
      try {
        say({ ok: true, kind: 'opened', text: await open(name, bytes, keys, publicRaw, sealed.ephLength) });
      } catch {
        say({ ok: false, ...failure });
      }
    };
    $('open').addEventListener('click', () => {
      drawHex(sealed.bytes, sealed.ephLength);
      attempt(sealed.name, sealed.bytes, server.keys, server.publicRaw, { kind: 'broken' });
    });
    $('tamper').addEventListener('click', () => {
      const copy = sealed.bytes.slice();
      const start = MAGIC.length + sealed.ephLength + 28;
      const at = start + Math.floor(Math.random() * Math.min(sealed.length + 4, copy.length - start));
      copy[at] ^= 1 << Math.floor(Math.random() * 8);
      drawHex(copy, sealed.ephLength, at);
      attempt(sealed.name, copy, server.keys, server.publicRaw, { kind: 'tampered', at });
    });
    $('rename').addEventListener('click', () => {
      const other = sealed.name === 'neighbour-home.json' ? 'other-home.json' : 'neighbour-home.json';
      drawHex(sealed.bytes, sealed.ephLength);
      attempt(other, sealed.bytes, server.keys, server.publicRaw, { kind: 'renamed', from: sealed.name, to: other });
    });
    $('wrong-key').addEventListener('click', async () => {
      const keys = await subtle.generateKey(curve.gen, true, ['deriveBits']);
      const publicRaw = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
      drawHex(sealed.bytes, sealed.ephLength);
      attempt(sealed.name, sealed.bytes, keys, publicRaw, { kind: 'wrongKey' });
    });
  })();

  // ---- 4. the code: server/homes.mjs's alphabet and limits
  (() => {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
    const LENGTH = 10;
    const box = $('alphabet');
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') box.append(el('span', ALPHABET.includes(c) ? '' : 'out', c));
    const sample = () => {
      const r = crypto.getRandomValues(new Uint8Array(LENGTH)); // 256 is a multiple of 32: no bias
      $('sample-code').textContent = Array.from(r, (x) => ALPHABET[x % 32]).join('');
    };
    $('new-code').addEventListener('click', sample);
    sample();

    const combos = 32n ** 10n;
    const avg = Number(combos) / 2;
    const YEAR = 365.25 * 24 * 3600;
    const cases = [
      5000 / 1000, // a 4-digit PIN: half of 10,000 tries at 1,000 a second
      (avg / (300 + 3600)) * 3600, // past 300 an hour, the slow lane: about one a second
      (avg / 30) * 3600, // one sender: 30 an hour in all
      4.54e9 * YEAR,
    ];
    const DECADES = 20;
    const bars = $('bars');
    const fmt = (n, digits = 0) => n.toLocaleString(lang === 'nl' ? 'nl-BE' : 'en-GB', { maximumFractionDigits: digits });
    const duration = (s) => {
      const d = t().dur;
      const y = s / YEAR;
      if (y >= 1e9) return `${fmt(y / 1e9, 1)} ${d.By}`;
      if (y >= 1e6) return `${fmt(y / 1e6, 0)} ${d.My}`;
      if (y >= 2) return `${fmt(y)} ${d.y}`;
      if (s >= 2 * 86400) return `${fmt(s / 86400)} ${d.d}`;
      if (s >= 2 * 3600) return `${fmt(s / 3600)} ${d.h}`;
      if (s >= 120) return `${fmt(s / 60)} ${d.min}`;
      return `${fmt(s)} ${d.s}`;
    };
    let grown = false;
    const draw = () => {
      $('combos').textContent = fmt(Number(combos));
      bars.replaceChildren();
      t().bars.forEach((b, i) => {
        const row = el('div', `bar ${b.cls}`);
        const who = el('div', 'who');
        who.append(el('b', '', b.who), el('span', '', b.how));
        const track = el('div', 'track');
        const width = Math.max(2, Math.min(100, (Math.log10(Math.max(cases[i], 1)) / DECADES) * 100));
        const fill = el('div', 'fill', width >= 45 ? duration(cases[i]) : '');
        fill.style.width = grown || still.matches ? `${width}%` : '0';
        fill.dataset.width = String(width);
        track.append(fill);
        if (width < 45) track.append(el('span', 'out', duration(cases[i])));
        row.append(who, track);
        bars.append(row);
      });
    };
    redraw.push(draw);
    draw();
    const grow = () => {
      grown = true;
      for (const f of bars.querySelectorAll('.fill')) f.style.width = `${f.dataset.width}%`;
    };
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((seen) => {
        if (seen.some((s) => s.isIntersecting)) {
          requestAnimationFrame(grow);
          io.disconnect();
        }
      }, { threshold: 0.3 });
      io.observe(bars);
    } else grow();
  })();

  // ---- 5. what the server sends to whom
  (() => {
    const NS = 'http://www.w3.org/2000/svg';
    const layer = $('packets');
    const log = $('netlog');
    const A = 162;
    const S0 = 330;
    const S1 = 470;
    const B = 638;
    const COLOURS = { inside: '#f7b928', shell: '#c3c9e2', pos: '#38c6f4', deny: '#ff3d9a' };
    // Each step: which log line, and the packets' legs [from x, to x, word, colour, lane y].
    const STEPS = [
      { line: 0, legs: [[A, S0, 'code', 'inside', 135]] },
      { line: 1, legs: [[S0, A, 'inside', 'inside', 195]] },
      { line: 2, legs: [[S1, B, 'shell', 'shell', 195]] },
      { line: 3, legs: [[A, S0, 'pos', 'pos', 135], [S1, B, 'pos', 'pos', 135]] },
      { line: 4, legs: [[B, S1, 'walk', 'deny', 195], [S1, B, 'no', 'deny', 135]] },
      { line: 5, legs: [[A, S0, 'door', 'inside', 135]] },
    ];
    let step = 0;
    let shownLines = [];
    const drawLog = () => {
      log.replaceChildren(...shownLines.map((i) => el('li', t().net[i].cls, t().net[i].text)));
    };
    redraw.push(drawLog);
    const packet = (word, colour, y) => {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'pk');
      const r = document.createElementNS(NS, 'rect');
      const tx = document.createElementNS(NS, 'text');
      tx.setAttribute('y', '0.36em');
      tx.setAttribute('fill', '#0d1430');
      tx.textContent = t().pk[word];
      g.append(r, tx);
      g.setAttribute('transform', `translate(${A} ${y})`);
      layer.append(g);
      // The pill fits its word, at whatever size the page's styles give the text (bigger on a phone).
      const box = tx.getBBox();
      const h = box.height + 12;
      const w = box.width + 28;
      r.setAttribute('x', String(-w / 2));
      r.setAttribute('y', String(-h / 2));
      r.setAttribute('width', String(w));
      r.setAttribute('height', String(h));
      r.setAttribute('rx', String(h / 2));
      r.setAttribute('fill', COLOURS[colour]);
      r.setAttribute('filter', 'url(#glow)');
      return g;
    };
    const fly = (leg) => new Promise((done) => {
      const [from, to, word, colour, y] = leg;
      const g = packet(word, colour, y);
      const start = performance.now();
      const MS = 1100;
      const frame = (now) => {
        const k = Math.min(1, (now - start) / MS);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        g.setAttribute('transform', `translate(${from + (to - from) * e} ${y})`);
        g.setAttribute('opacity', String(k > 0.85 ? (1 - k) / 0.15 : 1));
        if (k < 1) requestAnimationFrame(frame);
        else {
          g.remove();
          done();
        }
      };
      requestAnimationFrame(frame);
    });
    let visible = false;
    let running = false;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    async function run() {
      if (running) return;
      running = true;
      while (visible && !still.matches) {
        const s = STEPS[step];
        shownLines = step === 0 ? [s.line] : [...shownLines, s.line];
        drawLog();
        for (const leg of s.legs) await fly(leg);
        await wait(step === STEPS.length - 1 ? 2600 : 700);
        step = (step + 1) % STEPS.length;
      }
      running = false;
    }
    const all = () => {
      shownLines = STEPS.map((s) => s.line);
      drawLog();
    };
    if (still.matches || !('IntersectionObserver' in window)) {
      all();
      return;
    }
    new IntersectionObserver((seen) => {
      visible = seen.some((s) => s.isIntersecting);
      if (visible) run();
    }, { threshold: 0.25 }).observe($('netsvg'));
    still.addEventListener?.('change', () => (still.matches ? all() : run()));
  })();

  setLang(pick());
})();
