import * as THREE from 'three';
import { BrookSpirit, loadBrookSpirit, prepareSpiritLight, spiritLightFits, type SpiritLook } from '../world/brookSpirit';

/**
 * Development only (window.briel.spiritLook in main.ts, inside its import.meta.env.DEV block, so the build leaves
 * this file out; briel.spirit is the fight's, world/spiritFight.ts): the brook spirit's look alone, standing in the
 * real world at its grove by the brook, its middle 3.8 m above the ground as the fight floats it, so pictures show it
 * as players will see it, among the real trees, undergrowth and brook, in the game's own light. No rules: it only
 * floats there and follows the inputs given to it.
 *
 *   await briel.spiritLook()                         // in place, facing south (towards +z)
 *   await briel.spiritLook({ open: 1, anger: 1 })    // and its inputs (open, shield, anger, fade, reach, look, yaw)
 *   briel.spiritLook({ hurt: 1 }); briel.spiritLook({ remove: true })
 *
 * It updates itself just before each picture of the scene is drawn (once per frame, whatever draws it), so nothing
 * in the game's loop changes for it.
 */

/** Its grove (world x, z) and how high its middle floats. */
export const GROVE = { x: -68, z: 488, hover: 3.8 };

export interface SpiritInWorld {
  open?: number;
  shield?: number;
  anger?: number;
  fade?: number;
  /** A point in the world its front tendrils reach for ([x, y, z]), or null. */
  reach?: [number, number, number] | null;
  look?: SpiritLook;
  /** Which way it faces (radians, 0 towards +z). */
  yaw?: number;
  hurt?: number;
  remove?: boolean;
  /** Only put its light in the scene (as the game would at its start), no creature yet. */
  lightOnly?: boolean;
}

interface Context {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  ground: (x: number, z: number) => number;
}

let spirit: BrookSpirit | null = null;
let hook: THREE.Mesh | null = null;

export async function standSpirit(ctx: Context, o: SpiritInWorld = {}): Promise<{ x: number; y: number; z: number; ground: number } | null> {
  if (o.lightOnly) {
    if (spiritLightFits(ctx.renderer)) prepareSpiritLight(ctx.scene);
    return null;
  }
  if (o.remove) {
    hook?.removeFromParent();
    spirit?.dispose();
    spirit = null;
    hook = null;
    return null;
  }
  if (!spirit) {
    const model = await loadBrookSpirit(undefined, ctx.renderer);
    if (!model) return null;
    // As the game would at its start: the shared light in the scene first, so the creature brings no light of its own.
    const lit = spiritLightFits(ctx.renderer);
    if (lit) prepareSpiritLight(ctx.scene);
    spirit = new BrookSpirit(model, o.look ?? 'high', lit);
    ctx.scene.add(spirit.group);
    // An invisible point that never fails the frustum test: its onBeforeRender moves the creature on.
    const point = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    hook = new THREE.Mesh(point, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hook.frustumCulled = false;
    hook.userData.ignoreRay = true;
    let last = performance.now();
    hook.onBeforeRender = () => {
      const now = performance.now();
      if (!spirit || now - last < 4) return;
      spirit.update(Math.min(0.1, (now - last) / 1000), ctx.camera);
      last = now;
    };
    ctx.scene.add(hook);
  }
  const ground = ctx.ground(GROVE.x, GROVE.z);
  spirit.group.position.set(GROVE.x, ground + GROVE.hover, GROVE.z);
  spirit.group.rotation.y = o.yaw ?? spirit.group.rotation.y;
  spirit.ground = ground;
  for (const k of ['open', 'shield', 'anger', 'fade'] as const) if (o[k] !== undefined) spirit[k] = o[k]!;
  if (o.reach !== undefined) spirit.reach = o.reach ? new THREE.Vector3(...o.reach) : null;
  if (o.look) spirit.setLook(o.look);
  if (o.hurt) spirit.hurt(o.hurt);
  return { x: GROVE.x, y: ground + GROVE.hover, z: GROVE.z, ground };
}

/** The creature itself, to look into from the console. */
export function spiritNow(): BrookSpirit | null {
  return spirit;
}
