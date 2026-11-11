// A local HTML page printed to PDF in the headless Chromium (the page's own @page size, backgrounds on, no header
// or footer). For lan/cheatsheet.html, the LAN night's cheat sheet.
//
//   node tools/dev/pdf.mjs lan/cheatsheet.html "lan/Start local game server.pdf"
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';

const [html, pdf] = process.argv.slice(2);
if (!html || !pdf) throw new Error('usage: node tools/dev/pdf.mjs <page.html> <out.pdf>');
const b = await launch({ port: 9361, width: 900, height: 1200 });
try {
  await b.send('Page.navigate', { url: pathToFileURL(resolve(html)).href });
  await b.waitFor('document.readyState === "complete"');
  await b.sleep(400); // fonts
  const r = await b.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
  const bytes = Buffer.from(r.data, 'base64');
  writeFileSync(pdf, bytes);
  console.log(`${pdf}: ${Math.round(bytes.length / 1024)} KB`);
} finally {
  b.close();
}
