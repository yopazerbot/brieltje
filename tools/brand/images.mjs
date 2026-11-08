// The brand's pictures, headless (tools/dev/cdp.mjs), from the SVGs tools/brand/logo.mjs writes:
//   web/public/favicon-32.png        the tab icon for browsers without SVG icons (rounded tile, clear corners)
//   web/public/apple-touch-icon.png  180 x 180, the iPhone and iPad home screen (square: iOS rounds it)
//   web/public/icon-192.png, icon-512.png  the web app manifest's icons (square, as before)
//   web/public/brand/og.png          1200 x 630, the link preview (tools/brand/og.html)
//
//   node tools/brand/images.mjs [--port 9340]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, options } from '../dev/cdp.mjs';

const o = options({ port: '9340' });
const PUB = resolve(import.meta.dirname, '../../web/public');
const scratch = mkdtempSync(join(tmpdir(), 'briel-brand-'));
// The og page reads the font and the logo next to it as files.
const b = await launch({ port: Number(o.port), width: 1200, height: 630, extra: ['--allow-file-access-from-files'] });

/** Load a page at w x h CSS pixels on a clear background, wait for its fonts and pictures, save it. */
async function shoot(url, w, h, out) {
  await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await b.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await b.send('Page.navigate', { url });
  await b.waitFor("document.readyState === 'complete'");
  await b.evaluate('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null)))).then(() => true)');
  await b.sleep(300);
  const r = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('saved', out);
}

/** An SVG drawn to fill a w x h page. */
function page(svg, w, h) {
  const file = join(scratch, `${w}.html`);
  writeFileSync(file, `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${w}px;height:${h}px}</style><img src="${pathToFileURL(join(PUB, svg))}">`);
  return pathToFileURL(file).href;
}

try {
  await shoot(page('favicon.svg', 32, 32), 32, 32, join(PUB, 'favicon-32.png'));
  await shoot(page('brand/logo-mark-square.svg', 180, 180), 180, 180, join(PUB, 'apple-touch-icon.png'));
  await shoot(page('brand/logo-mark-square.svg', 192, 192), 192, 192, join(PUB, 'icon-192.png'));
  await shoot(page('brand/logo-mark-square.svg', 512, 512), 512, 512, join(PUB, 'icon-512.png'));
  await shoot(pathToFileURL(resolve(import.meta.dirname, 'og.html')).href, 1200, 630, join(PUB, 'brand/og.png'));
} finally {
  b.close();
  rmSync(scratch, { recursive: true, force: true });
}
