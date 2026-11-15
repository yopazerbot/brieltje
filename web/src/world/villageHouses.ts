import * as THREE from 'three';

/**
 * The hand-made houses among the generated ones: each a Blender model of our own (tools/village_houses_b1.py, _b2,
 * _b3) at /models/<name>.glb, standing in for one generated house (its root's `replaces`: the outline of that house's
 * wall blocks, which stay in the data for walking into and for the server). A name is added here in the commit that
 * adds its file (villageHouses.test.mjs checks that every listed file is there and stands in properly): a missing file
 * would still leave the generated house standing, but every load would fetch it for nothing. Each is named by its
 * spot in the model's metres, never by an address.
 *
 * `reach`: metres within which it is drawn (Infinity: as far as its tiles; 350: as the far tiles out east). Its small
 * parts (the meshes whose names end `_small`: frames, gutters, gates) are drawn within SMALL m.
 */
export const VILLAGE_HOUSES: readonly (readonly [name: string, reach: number])[] = [
  ['vh_farm', Infinity], // x -326.9, z -896.6: a whitewashed farmhouse with its yard gate
  ['vh_gable_house', Infinity], // x -143.6, z -1092.0: a brick house of the 1930s with clipped gables
  ['vh_arch_villa', Infinity], // x -46.7, z -1089.5: a buff villa of the 1950s with arched windows
  ['vh_white_bungalow', Infinity], // x 39.7, z -1050.1: a white bungalow of the 1960s
  ['kapellenhoek_home', 350], // x 616.5, z -352.6: home 4, the brick house on Kapellenhoek (tools/kapellenhoek_home.py, world/walkIn.ts)
];

/** m: the houses' small parts are drawn within this */
const SMALL = 120;

/**
 * Hide a loaded model beyond its reach, as the village's tiles: a hand-made house by its reach in VILLAGE_HOUSES and
 * its small parts within SMALL m. False for any other model (the caller tracks it as before).
 */
export function trackVillageHouse(tiles: { track(object: THREE.Object3D, box?: THREE.Box3, reach?: number): void }, model: THREE.Object3D): boolean {
  const entry = VILLAGE_HOUSES.find(([name]) => name === model.userData.landmark);
  if (!entry) return false;
  model.updateWorldMatrix(true, true);
  tiles.track(model, undefined, entry[1]);
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name.endsWith('_small')) tiles.track(o, new THREE.Box3().setFromObject(o), Math.min(SMALL, entry[1]));
  });
  return true;
}
