import type * as THREE from 'three';
import CARS from '../../shared/car.json';
import FC from '../../shared/football.json';
import type { Prism, Surroundings, VillageData } from './houseData';
import { houseIndex } from './houseIndex';
import { planSteps } from './housePlan';
import { plotSteps, type PlotInput } from './plots';
import { streetRuns } from './roadDetail';
import { terrain } from './terrain';

type Ring = [number, number][];

/** Development only: what the plots were planned from, as the page has it (tools/dev/houseSets.mjs reads it). */
export const plotInputs: PlotInput[] = [];

/**
 * The village's plots (world/plots.ts) from what main.ts has when it builds the village: `kept`, the village without
 * the landmarks and the houses our models replace, `drawn`, the same as its tiles draw it (its houses are looked up
 * once for the tiles too: world/houseIndex.ts), and the models (no way comes near their outlines and open ground).
 * Worked out in slices with `between()` after each, as the village's build. Returns the covers to add to `drawn` before
 * its covers are claimed.
 */
export async function villagePlots(kept: VillageData, drawn: Surroundings, models: THREE.Object3D[], ground: number, between: () => Promise<unknown>): Promise<Prism[]> {
  const groundAt = (x: number, z: number) => ground + terrain.height(x, z);
  const index = houseIndex(drawn, groundAt);
  const roads = (await import('../data/roads.json')).default as unknown as {
    boxes: [number, number, number][];
    signs: [number, number, ...unknown[]][];
    bikes: [number, number, number][];
    stops: [number, number, number, string, [number, number, number] | null, [number, number, number] | null][];
    parked: [number, number, number, ...number[]][];
  };
  // The small things standing about, each with a radius (m).
  const things: [number, number, number][] = [
    ...roads.boxes.map(([x, z]) => [x, z, 0.2] as [number, number, number]),
    ...roads.signs.map(([x, z]) => [x, z, 0.15] as [number, number, number]),
    ...roads.bikes.map(([x, z]) => [x, z, 0.9] as [number, number, number]),
    ...roads.stops.flatMap(([x, z, , , bin, shelter]) => [[x, z, 0.3], ...(bin ? [[bin[0], bin[1], 0.3]] : []), ...(shelter ? [[shelter[0], shelter[1], 1.6]] : [])] as [number, number, number][]),
    ...(kept.posts ?? []).map(([x, z]) => [x, z, 0.1] as [number, number, number]),
    ...(kept.poles ?? []).map((p) => [p.x, p.z, 0.2] as [number, number, number]),
  ];
  const cars: [number, number, number][] = [
    ...roads.parked.map(([x, z, yaw]) => [x, z, yaw] as [number, number, number]),
    ...Object.values(CARS.cars as Record<string, { village: boolean; park: { x: number; z: number; yaw: number } }>).filter((c) => c.village).map((c) => [c.park.x, c.park.z, c.park.yaw] as [number, number, number]),
  ];
  const input: PlotInput = {
    prisms: [...(drawn.prisms ?? [])],
    openings: drawn.openings ?? [],
    trees: kept.trees,
    dips: kept.dips ?? [],
    runs: [...streetRuns()],
    things,
    cars,
    keyAt: (x, z) => index.houses.at(x, z),
    keepOut: [FC.platform.ring as Ring, FC.plot as Ring],
    // The landmarks (the church, the school), the houses and streets our models stand for and their open ground.
    models: [
      ...(kept.landmarks ?? []).map((l) => l.p),
      ...models.flatMap((m) => [...((m.userData.replaces as Ring[] | undefined) ?? []), ...((m.userData.clear as Ring[] | undefined) ?? [])]),
    ],
    groundAt,
    stepOf: (o) => Math.max(0, ...planSteps(o, index.houses, groundAt).map((s) => s.to)),
  };
  if (import.meta.env?.DEV) plotInputs.push(input);
  const steps = plotSteps(input);
  let r = steps.next();
  while (!r.done) {
    await between();
    r = steps.next();
  }
  return r.value.covers;
}
