import { trunkPrisms, type TreeSpot } from '../../shared/trees.mjs';
import type { World } from './collision';
import { onTreesLeftOut, treeKey, treesLeftOut } from './surroundings';

/**
 * The drawn trees' trunks as blocks in the world (shared/trees.mjs): the ring's at the start, the village's and the
 * street models' conifers when they come. Every preset alike: they come from the data, not from the meshes drawn.
 * A tree left out round the house or the church (world/surroundings.ts treesLeftOut) has its block switched off, so
 * nothing stops against a trunk that isn't there.
 */
export class TrunkBlocks {
  /** Block numbers in the world by tree ("x,z", as treeKey) */
  private blocks = new Map<string, number[]>();

  constructor(private world: World) {
    onTreesLeftOut.add(() => this.prune());
  }

  /** A block for each of these trees. */
  add(trees: readonly TreeSpot[]): void {
    if (!trees.length) return;
    const first = this.world.addPrisms(trunkPrisms(trees));
    trees.forEach((t, i) => {
      const key = treeKey(t.x, t.z);
      const list = this.blocks.get(key);
      if (list) list.push(first + i);
      else this.blocks.set(key, [first + i]);
    });
    this.prune();
  }

  private prune(): void {
    for (const key of treesLeftOut) for (const i of this.blocks.get(key) ?? []) this.world.setSolid(i, false);
  }
}
