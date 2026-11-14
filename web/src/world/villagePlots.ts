import type * as THREE from 'three';
import FC from '../../shared/football.json';
import type { Prism, Surroundings, VillageData } from './houseData';
import { houseIndex } from './houseIndex';
import { planSteps } from './housePlan';
import { plotCovers } from './plots';
import { streetRuns } from './roadDetail';
import { terrain } from './terrain';

type Ring = [number, number][];

/**
 * The village's plots (world/plots.ts) from what main.ts has when it builds the village: `kept`, the village without
 * the landmarks and the houses our models replace (with its road blocks), `drawn`, the same as its tiles draw it (its
 * houses are looked up once for the tiles too: world/houseIndex.ts), and the models (their outlines and open ground
 * are kept out). Returns the covers to add to `drawn` before its covers are claimed.
 */
export async function villagePlots(kept: VillageData, drawn: Surroundings, models: THREE.Object3D[], ground: number): Promise<Prism[]> {
  const groundAt = (x: number, z: number) => ground + terrain.height(x, z);
  const index = houseIndex(drawn, groundAt);
  const roads = (await import('../data/roads.json')).default as unknown as { boxes: [number, number, number][] };
  const keepOut: Ring[] = [
    ...(kept.landmarks ?? []).map((l) => l.p),
    ...models.flatMap((m) => [...((m.userData.replaces as Ring[] | undefined) ?? []), ...((m.userData.clear as Ring[] | undefined) ?? [])]),
    FC.platform.ring as Ring,
    FC.plot as Ring,
  ];
  const shown = new Set(drawn.prisms ?? []);
  return plotCovers({
    prisms: kept.prisms ?? [],
    streetCovers: (kept.prisms ?? []).filter((p) => !shown.has(p)),
    openings: drawn.openings ?? [],
    trees: kept.trees,
    dips: kept.dips ?? [],
    runs: [...streetRuns()],
    boxes: roads.boxes,
    standing: index.bases.keys(),
    keyAt: (x, z) => index.houses.at(x, z),
    keepOut,
    groundAt,
    stepOf: (o) => Math.max(0, ...planSteps(o, index.houses, groundAt).map((s) => s.to)),
  }).covers;
}
