import * as THREE from 'three';
import { SHADOW_LAYER } from './tiles';

/**
 * What the reflections leave out: the glass's picture of the street (world/glassLook.ts GlassProbe) and the puddles'
 * mirror (world/wetGround.ts WetMirror) are the scene drawn again, and small or near things cost as much there as in
 * the view itself while hardly showing in a 256-pixel cube face or a blurred puddle. So they are drawn without:
 *
 * - `objects`: the undergrowth, the street's loose things, the particles (each module adds its own group);
 * - `materials`: the hedges' sprigs and the near trees' full crowns and branches of leaf cards. Those trees show in
 *   the reflections as their lighter crowns instead: the stand-ins that throw their shadow (world/tiles.ts Piece
 *   `shadowOnly`, on SHADOW_LAYER), which the reflections' cameras see (`reflectionLayers`).
 */
export const reflectionSkips = { objects: new Set<THREE.Object3D>(), materials: new Set<THREE.Material>() };

/** The layers a reflection's camera sees: the eye's, and the near trees' lighter crowns (SHADOW_LAYER). */
export function reflectionLayers(eye: THREE.Layers, out: THREE.Layers): THREE.Layers {
  out.mask = eye.mask;
  out.enable(SHADOW_LAYER);
  return out;
}

// What was shown before a reflection is drawn, put back after (kept between frames: nothing new each frame).
const objects: THREE.Object3D[] = [];
const objectsShown: boolean[] = [];
const materials: THREE.Material[] = [];
const materialsShown: boolean[] = [];

/** Draw a reflection (`draw`) without the skipped things and without `hide` (the eye's own things, the rain round it). */
export function withoutDetail(hide: THREE.Object3D[], draw: () => void): void {
  objects.length = objectsShown.length = materials.length = materialsShown.length = 0;
  for (const o of hide) objects.push(o);
  for (const o of reflectionSkips.objects) objects.push(o);
  for (const m of reflectionSkips.materials) materials.push(m);
  for (const o of objects) {
    objectsShown.push(o.visible);
    o.visible = false;
  }
  for (const m of materials) {
    materialsShown.push(m.visible);
    m.visible = false;
  }
  try {
    draw();
  } finally {
    objects.forEach((o, i) => (o.visible = objectsShown[i]));
    materials.forEach((m, i) => (m.visible = materialsShown[i]));
  }
}
