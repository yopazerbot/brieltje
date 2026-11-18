import type * as THREE from 'three';
import { campModels } from './campModels';

/**
 * Attack and defend's spawn truck (server/assault.mjs): a four-wheeled army truck with a shelter body, our own Blender
 * model (tools/camp.py, in /models/camp.glb with the camp's tents and supply truck), sized by shared/assaultFields.mjs
 * TRUCK. It is made like the Teslas' models so world/car.ts drives and draws it as one of them (its "model" is
 * 'proc:truck'): its parts carry the cars' material names (Paint in the team's colour on the door panels, the band round
 * the shelter, the roof panel and the antenna's pennant; Drab, the olive body whose colour, shade and dirt are on its
 * corners; Trim, Glass, Interior, LightBar for the headlights, TailLight, Reflector, Chrome), its four wheels are pivots
 * named Wheel_FL ... Wheel_RR at their axles (the left ones turned round), and "Far" is its simple copy for far off. No
 * make, badge or insignia. Its nose is along -z, the ground at y = 0, as the cars' models.
 */

/** The spawn truck's model: a fresh copy each call, sharing the geometry (world/car.ts sets its own materials). */
export function truckModel(): Promise<THREE.Group> {
  return campModels().then((m) => m.spawnTruck.clone(true));
}
