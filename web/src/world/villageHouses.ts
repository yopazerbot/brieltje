import * as THREE from 'three';

/**
 * The hand-made houses among the generated ones: each a Blender model of our own (tools/village_houses_b1.py, _b2,
 * _b3, _b4, _b5) at /models/<name>.glb, standing in for one generated house (its root's `replaces`: the outline of that house's
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
  ['vh_fermette', Infinity], // x 287.4, z -836.2: a villa in farmhouse style with a low dark wing (tools/village_houses_b2.py)
  ['vh_red_villa', Infinity], // x 316.4, z -821.9: a tall red villa of the 1920s with white bands and a bay window
  ['vh_terrace', Infinity], // x 342.7, z -838.9: an old worker's house on the pavement, its free gable rendered
  ['vh_fork_house', Infinity], // x 588.0, z -890.2: a brick house of the 1960s under a hipped roof, its garage in front
  ['vh_old_farm', 350], // x 677.6, z 308.9: an old brick farm, its house, barn and wing on the way to the Sparrenhof (tools/village_houses_b3.py)
  ['vh_seventies', 350], // x 695.0, z 418.9: a dark brick house of the 1970s and the narrow house joined to it
  ['vh_hedge_bungalow', 350], // x 695.4, z 590.7: a low bungalow of the 1970s behind a beech hedge
  ['vh_cottage', 350], // x 1629.1, z -364.2: an old rendered cottage with a round window in its gable, past Molenhoek's end
  ['vh_solar_house', 350], // x -200.2, z -1194.5: a modern buff house with solar panels, across from the football ground (tools/village_houses_b4.py)
  ['vh_steep_gable', 350], // x -201.2, z -1213.3: a red brick house under a steep gable with a chimney at its top
  ['vh_hip_bungalow', 350], // x -191.4, z -1164.7: a white bungalow of the 1970s under a hipped roof
  ['vh_tall_gable', 350], // x -147.0, z -1157.3: a tall rosy brick house with clipped gables and a front gable over a bay
  ['vh_hip_single', 350], // x 494.5, z -657.1: a buff bungalow under an orange-red hipped roof, behind the church (tools/village_houses_b5.py)
  ['vh_ivy_cottage', 350], // x 451.5, z -692.3: an ivy-grown cottage under pantiles and the white farm building behind it
  ['vh_white_modern', 350], // x 412.0, z -667.0: a modern white brick house, a dark brick band with its garage
  ['vh_buff_hip', 350], // x 428.6, z -678.9: a buff brick house of two storeys under a hipped roof
  ['vh_pale_gable', 350], // x 399.5, z -651.1: a pale brick house with a steep front gable
  ['vh_red_chimneys', 350], // x 376.8, z -590.2: a tall red brick house, its gable to the street, two chimneys
  ['kapellenhoek_home', 350], // x 616.5, z -352.6: home 4, the brick house on Kapellenhoek (tools/kapellenhoek_home.py, world/walkIn.ts)
  ['fb_stables_1255', 350], // x 1254.8, z -569.5: a cow stable of three halls with an open bay (tools/farm_buildings.py)
  ['fb_shed_31', 350], // x 30.5, z -956.4: a long machine shed with an open bay
  ['fb_barn_537', 350], // x 536.5, z 102.5: a dark red sheet barn
  ['fb_store_1399', 350], // x 1399.1, z 326.9: a tall storage hall on concrete push walls
  ['fb_pair_1170', 350], // x 1173.7, z 470.6: a cow stable and a machine shed across a yard
  ['fb_stable_m12', 350], // x -11.7, z -752.8: an older brick stable with a corrugated roof
  ['fb_hall_1030', 350], // x 1033.2, z 47.7: a storage hall, its lean-to and an older brick wing
  ['cemetery', 350], // x 420.1, z -625.6 (its gate): the village cemetery behind the church, standing in for no house (tools/cemetery.py)
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
