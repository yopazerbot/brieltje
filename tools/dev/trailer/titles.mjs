// The trailer's intro and outro as frames: tools/dev/trailer/title.html, photographed 30 times a second of its own
// clock (seek), so nothing depends on how fast this computer draws. The game's logo comes out of web/index.html.
//
//   node tools/dev/trailer/titles.mjs --out <folder>        -> <folder>/intro/frame-000001.jpg ..., <folder>/outro/...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, options } from '../cdp.mjs';
import { size } from './lib.mjs';

const o = options({ out: '', fps: '30', port: '9421', captions: '' });
if (!o.out) throw new Error('--out <folder> is needed');
const here = dirname(fileURLToPath(import.meta.url));
const symbol = /<symbol id="brand-row"[\s\S]*?<\/symbol>/.exec(readFileSync(join(here, '../../../web/index.html'), 'utf8'))?.[0];
if (!symbol) throw new Error('the logo (symbol brand-row) is not in web/index.html');
const b = await launch({ port: Number(o.port), width: 1920, height: 1080, extra: ['--hide-scrollbars', '--force-device-scale-factor=1', '--allow-file-access-from-files'] });
try {
  await size(b, 1920, 1080);
  for (const scene of ['intro', 'outro']) {
    const dir = join(o.out, scene);
    mkdirSync(dir, { recursive: true });
    await b.send('Page.navigate', { url: `${pathToFileURL(join(here, 'title.html')).href}?scene=${scene}` });
    await b.waitFor('typeof window.seek === "function"');
    await b.evaluate(`document.getElementById('symbols').innerHTML = ${JSON.stringify(symbol)}`, false); // our own file's logo, not anyone's text
    await b.evaluate('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => 0)))).then(() => true)');
    await b.sleep(500);
    const n = Math.round((await b.evaluate('window.LENGTH', false)) * Number(o.fps));
    for (let i = 0; i < n; i++) {
      await b.evaluate(`window.seek(${i / Number(o.fps)})`, false);
      const r = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
      writeFileSync(join(dir, `frame-${String(i + 1).padStart(6, '0')}.jpg`), Buffer.from(r.data, 'base64'));
    }
    console.log(`${scene}: ${n} frames`);
  }
  // The words shown over the gameplay (--captions "They run.|Fight together."), each a see-through picture.
  const captions = o.captions ? o.captions.split('|') : [];
  if (captions.length) {
    mkdirSync(join(o.out, 'captions'), { recursive: true });
    await b.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const [i, text] of captions.entries()) {
      await b.send('Page.navigate', { url: `${pathToFileURL(join(here, 'title.html')).href}?scene=caption&text=${encodeURIComponent(text)}` });
      await b.waitFor('typeof window.seek === "function"');
      await b.evaluate('document.fonts.ready.then(() => true)');
      await b.sleep(300);
      const r = await b.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(o.out, 'captions', `caption-${i + 1}.png`), Buffer.from(r.data, 'base64'));
    }
    console.log(`captions: ${captions.length}`);
  }
} finally {
  b.close();
}
