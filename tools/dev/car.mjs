// Check the real car models and speedometer in a fresh browser, on a running dev server.
// node tools/dev/car.mjs --url http://localhost:5295/ --port 9441 [--phone] [--swiftshader] [--out view.png]
import assert from 'node:assert/strict';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5295/', port: '9441', phone: false, swiftshader: false, out: '' });
const b = await launch({ port: Number(o.port), swiftshader: o.swiftshader, extra: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
try {
  console.log('Browser PID:', b.pid);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('briel.graphics','low');localStorage.setItem('briel.lang','en');localStorage.setItem('briel.spawn','house');localStorage.setItem('briel.playMode','explore');" });
  const url = new URL(o.url);
  url.searchParams.set('nobake', '');
  url.searchParams.set('webp', '');
  await startGame(b, url.href, { phone: o.phone });
  await b.waitFor('briel.cars.slice(0,2).every(c=>c.wheels.length===4)');
  await b.evaluate("document.getElementById('cc-close')?.click(); briel.getIn()", false);
  await b.waitFor("!document.getElementById('speedometer').hidden");
  assert.equal(await b.evaluate("document.getElementById('speedometer').getAttribute('aria-valuenow')"), '0');
  // Freeze only the car's movement for a stable readout fixture; the game's normal HUD loop keeps running.
  await b.evaluate("window.__carDrive=briel.car.drive;window.__carSpeed=50;briel.car.drive=function(){this.speed=window.__carSpeed;return 0}", false);
  await b.waitFor("document.getElementById('speedometer').getAttribute('aria-valuenow')==='180'");
  const layout = await b.evaluate(`(() => {
    const meter=document.getElementById('speedometer'), r=meter.getBoundingClientRect();
    return { text:meter.textContent, label:meter.getAttribute('aria-label'), max:meter.getAttribute('aria-valuemax'),
      rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},
      controls:[...document.querySelectorAll('#touch .tbtn:not(.hidden),#map-btn')].filter(e=>e.getBoundingClientRect().width>0).map(e=>{
        const x=e.getBoundingClientRect();return {name:e.className,left:x.left,top:x.top,right:x.right,bottom:x.bottom};
      }) };
  })()`);
  assert.equal(layout.label, 'Speed');
  assert.equal(layout.max, '200');
  assert.equal(layout.text, '180km/h');
  if (o.phone) for (const r of layout.controls) {
    const a = layout.rect;
    assert.ok(a.right <= r.left || a.left >= r.right || a.bottom <= r.top || a.top >= r.bottom, `speedometer overlaps ${r.name}`);
  }
  if (o.phone) {
    for (const [width, height] of [[667, 375], [568, 320]]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await b.sleep(150);
      assert.deepEqual(await b.evaluate(`(() => {
        const a=document.getElementById('speedometer').getBoundingClientRect();
        return [...document.querySelectorAll('#touch .tbtn:not(.hidden),#map-btn')].filter(e=>{
          const r=e.getBoundingClientRect();return a.right>r.left && a.left<r.right && a.bottom>r.top && a.top<r.bottom;
        }).map(e=>e.className || e.id);
      })()`), [], `touch controls at ${width} x ${height}`);
    }
    await b.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
    await b.sleep(150);
  }
  if (!o.phone) assert.ok(await b.evaluate(`(() => {
    const toast=document.getElementById('toast');
    if (!toast.classList.contains('show')) return true;
    const a=document.getElementById('speedometer').getBoundingClientRect(),r=toast.getBoundingClientRect();
    return a.right<=r.left || a.left>=r.right || a.bottom<=r.top || a.top>=r.bottom;
  })()`), 'the arrival announcement must stay clear of the speedometer');
  if (o.out) await b.screenshot(o.out);
  await b.evaluate("window.__carSpeed=-5; briel.i18n.setLang('nl')", false);
  await b.waitFor("document.getElementById('speedometer').getAttribute('aria-valuenow')==='18' && document.getElementById('speedometer').getAttribute('aria-label')==='Snelheid'");
  await b.evaluate("briel.car.drive=window.__carDrive; briel.getOut(false)", false);
  await b.waitFor("document.getElementById('speedometer').hidden");
  assert.deepEqual(b.logs.filter(l => /^(error|exception)/.test(l)), []);
  console.log(JSON.stringify({ phone: o.phone, fourWheelsPerModel: true, readout: layout.text, reverseKmh: 18, dutchLabel: true, hiddenAfterExit: true }));
} finally {
  console.log('Browser errors:', b.logs.filter(l => /^(error|exception)/.test(l)).slice(-10));
  b.close();
}
