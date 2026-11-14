// The music (web/src/music.ts) by numbers, for checks without ears: headless browsers play no sound, so the dev build
// renders it into an OfflineAudioContext in the page (window.brielMusic.render), with the same code that plays it live.
// For the start screen's theme and for a scripted Zombies run (a break, wave 1, wave 5 with a big one, wave 8 with
// another, the end: music.ts zombieRun), at the default Music setting (50 %) and before the master volume, it prints the
// peak, the RMS, the clipped samples, the longest silence, the most sources sounding at once and the RMS per 2 s; and
// the peak with Music and Volume both at 100 % (twice the default's: the bus is linear), which must stay at or under 0.3.
//
//   node tools/dev/music.mjs [--url http://localhost:5200/] [--port 9970] [--theme 40] [--zombies 80] [--out <folder>]
//
// --out writes each as a 48 kHz stereo WAV in that folder (keep it outside the repository), to listen to.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, options } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9970', theme: '40', zombies: '80', out: '' });
const RATE = 48000;
const PEAK_MAX = 0.25; // the music's bus at the default setting, before the master volume
const FULL_MAX = 0.3; // Music and Volume both at 100 %
const b = await launch({ port: Number(o.port), width: 800, height: 600 });
let failed = false;
const check = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failed = true;
};

/** Render `kind` for `secs` in the page; its numbers (and the WAV kept in the page when `wav`). */
const render = (kind, secs, wav) => b.evaluate(`(async () => {
  const { buffer, maxSources, notes } = await brielMusic.render(${JSON.stringify(kind)}, ${secs}, ${RATE});
  const ch = [...Array(buffer.numberOfChannels)].map((_, i) => buffer.getChannelData(i));
  const n = buffer.length, sr = buffer.sampleRate;
  let peak = 0, sum = 0, clipped = 0;
  for (const d of ch) for (let i = 0; i < n; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
    sum += d[i] * d[i];
  }
  // Silence: 10 ms pieces under -66 dBFS (RMS 0.0005), the longest run of them.
  const win = Math.round(sr / 100);
  let run = 0, longest = 0;
  for (let w = 0; w + win <= n; w += win) {
    let s = 0;
    for (const d of ch) for (let i = w; i < w + win; i++) s += d[i] * d[i];
    run = Math.sqrt(s / (win * ch.length)) < 0.0005 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const per2 = [], peak2 = [];
  for (let w = 0; w < n; w += 2 * sr) {
    let s = 0, k = 0, p = 0;
    for (const d of ch) for (let i = w; i < Math.min(n, w + 2 * sr); i++, k++) {
      s += d[i] * d[i];
      p = Math.max(p, Math.abs(d[i]));
    }
    per2.push(Math.sqrt(s / Math.max(1, k)));
    peak2.push(p);
  }
  if (${wav ? 'true' : 'false'}) {
    // 16-bit stereo WAV, as rendered (no normalising: the level the game plays it at, before the master volume).
    const bytes = new Uint8Array(44 + n * 4);
    const v = new DataView(bytes.buffer);
    const str = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 4, true);
    const L = ch[0], R = ch[1] ?? ch[0];
    for (let i = 0; i < n; i++) {
      v.setInt16(44 + i * 4, Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), true);
      v.setInt16(46 + i * 4, Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), true);
    }
    window.__musicWav = bytes;
  }
  return { seconds: n / sr, peak, rms: Math.sqrt(sum / (n * ch.length)), clipped, silence: longest / 100, per2, peak2, maxSources, notes };
})()`);

/** The WAV kept in the page, fetched in pieces (one message over the protocol stays small). */
async function fetchWav() {
  const size = await b.evaluate('window.__musicWav.length', false);
  const parts = [];
  for (let at = 0; at < size; at += 3_000_000) {
    parts.push(Buffer.from(await b.evaluate(`(() => { const u = window.__musicWav.subarray(${at}, ${at + 3_000_000}); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); })()`, false), 'base64'));
  }
  return Buffer.concat(parts);
}

const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
const show = (name, r) => {
  console.log(`${name}: ${r.seconds.toFixed(1)} s, ${r.notes} notes, at most ${r.maxSources} sources at once`);
  console.log(`  peak ${r.peak.toFixed(3)} (${db(r.peak)} dBFS), RMS ${r.rms.toFixed(4)} (${db(r.rms)} dBFS), clipped samples ${r.clipped}, longest silence ${r.silence.toFixed(2)} s`);
  console.log(`  RMS per 2 s: ${r.per2.map((x, i) => `${i * 2}:${x.toFixed(3)}`).join(' ')}`);
};
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);

try {
  await b.send('Page.navigate', { url: o.url });
  await b.waitFor('!!window.brielMusic', 120000);
  if (o.out) mkdirSync(o.out, { recursive: true });

  const theme = await render('theme', Number(o.theme), !!o.out);
  show('Start screen theme', theme);
  check(theme.clipped === 0, 'no clipped sample');
  check(theme.peak <= PEAK_MAX, `peak at most ${PEAK_MAX}`);
  check(theme.silence <= 2, 'no silence longer than 2 s');
  if (o.out) writeFileSync(join(o.out, 'theme.wav'), await fetchWav());

  const run = await render('zombies', Number(o.zombies), !!o.out);
  show('Zombies run (0-10 s break, 10-26 wave 1, 26-30 break, 30-46 wave 5 with a big one at 34, 46-50 break, 50-66 wave 8 with a big one at 54, then the end)', run);
  // Its parts, by the 2 s windows that lie wholly inside them (music.ts zombieRun).
  const part = (from, to) => mean(run.per2.slice(from / 2, to / 2));
  const parts = { break: part(2, 10), wave1: part(12, 24), wave5: part(32, 44), wave8: part(52, 64), end: part(68, 80) };
  const wave8Peak = Math.max(...run.peak2.slice(25, 33));
  console.log(`  mean RMS: break ${parts.break.toFixed(4)}, wave 1 ${parts.wave1.toFixed(4)}, wave 5 ${parts.wave5.toFixed(4)}, wave 8 ${parts.wave8.toFixed(4)}, the end ${parts.end.toFixed(4)}`);
  console.log(`  peak in wave 8 ${wave8Peak.toFixed(3)}; with Music and Volume at 100 %: whole run ${(run.peak * 2).toFixed(3)}, wave 8 ${(wave8Peak * 2).toFixed(3)}`);
  check(run.clipped === 0, 'no clipped sample');
  check(run.peak <= PEAK_MAX, `peak at most ${PEAK_MAX}`);
  check(run.peak * 2 <= FULL_MAX, `peak at most ${FULL_MAX} with Music and Volume at 100 %`);
  check(parts.break < parts.wave1 && parts.wave1 < parts.wave5 && parts.wave5 <= parts.wave8 * 1.05, 'the RMS rises from the break to wave 1 to wave 5 (and wave 8 at least as loud)');
  const tail = run.per2.slice(34); // the hit falls on the first bar line after 66 s
  const decays = tail.every((x, i) => i === 0 || x <= tail[i - 1] * 1.05);
  check(tail[0] > 0.005 && decays && tail[tail.length - 1] < tail[0] * 0.1, 'the end rings out: a hit, then dying away');
  if (o.out) writeFileSync(join(o.out, 'zombies.wav'), await fetchWav());
  if (o.out) console.log(`WAVs in ${o.out}`);
  const errors = b.logs.filter((l) => /^(error|exception)/.test(l));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
} finally {
  b.close();
}
process.exitCode = failed ? 1 : 0;
