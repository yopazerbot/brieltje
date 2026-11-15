// The sets the page really works the generated houses' roofs and plots out on (world/houseIndex.ts `plannedSets`,
// world/villagePlots.ts `plotInputs`: the village after our models took their houses out, the ring round the home),
// written to a JSON file, so world/roofPlan.test.mjs and world/plots.test.mjs can check them as the page draws them:
//
//   node tools/dev/houseSets.mjs <out.json> [--url http://localhost:5200/] [--port 9940]
//   HOUSE_SETS=<out.json> node --test web/src/world/roofPlan.test.mjs web/src/world/plots.test.mjs
//
// Needs the dev server (development only: the page keeps them only there). The file holds open data and the models'
// outlines only, but keep it outside the repository: it is large and made again in a minute.
import { writeFileSync } from 'node:fs';
import { launch, options, startGame } from './cdp.mjs';

const o = options({ url: 'http://localhost:5200/', port: '9940' });
const out = o._[0];
if (!out) throw new Error('usage: node tools/dev/houseSets.mjs <out.json> [--url ...] [--port ...]');
const b = await launch({ port: Number(o.port) });
try {
  await startGame(b, o.url, { village: true });
  await b.sleep(3000);
  const json = await b.evaluate(`(async () => {
    const { plannedSets } = await import('/src/world/houseIndex.ts');
    const plotInputs = (await import('/src/world/villagePlots.ts')).plotInputs ?? [];
    const pick = (s) => ({ roofs: s.roofs, prisms: s.prisms ?? [], openings: s.openings ?? [], solar: s.solar ?? [],
      unfiltered: s.unfiltered ? { roofs: s.unfiltered.roofs, prisms: s.unfiltered.prisms ?? [] } : null });
    const plots = plotInputs.map((p) => ({ ...p, keyAt: undefined, groundAt: undefined, stepOf: undefined, standing: undefined }));
    return JSON.stringify({ sets: plannedSets.map(pick), plots });
  })()`, true);
  writeFileSync(out, json);
  const parsed = JSON.parse(json);
  console.log(`${out}: ${parsed.sets.length} sets (${parsed.sets.map((s) => s.roofs.length + ' roofs').join(', ')}), ${parsed.plots.length} plot inputs`);
} finally {
  await b.close();
}
