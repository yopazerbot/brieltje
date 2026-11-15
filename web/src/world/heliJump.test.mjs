// A jump from the helicopter (src/heliPilot.ts) as a new way to arrive from above at a chosen spot: a possible way round
// the code-locked homes. The page's own collision (world/collision.ts) and player (src/player.ts) run here, with only the
// homes' walking barriers in the world (main.ts homeLocks.barrier, the server's rule homeAt) and, in one pass, a roof
// over each home's top band; in the other no roofs either, the worst case. However a jump comes in, hands off or steered
// hard at a home, slow or at speed: nobody is inside a home's inside (its bands) at any frame, nor touches down there
// (a drop sinks after it moves across: the barrier is asked again after the sink, src/player.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as THREE from 'three';
import { DROP, dropStep, jumpStart } from '../../shared/parachute.mjs';
import { barrierHeights, END_GARDEN, HOMES, homeAt, inEndGarden } from '../../shared/homes.mjs';

/** A module's code without its imports and exports, run with `deps` in scope; returns the names asked for. */
function load(file, deps, names) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import[^;]*;\s*$/gm, '')
    .replace(/^export (?=(class|function|const|interface|type) )/gm, '');
  const code = stripTypeScriptTypes(src, { mode: 'transform' });
  return new Function(...Object.keys(deps), `${code}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
}

// The ground: the end house's lawn round it (its floor is up the slope), elsewhere level.
const nearEnd = (x, z) => x > 1480 && x < 1540 && z > -380 && z < -320;
const terrain = { height: (x, z) => (nearEnd(x, z) ? END_GARDEN.y : 0) };
const { RoofField, climb } = load('./roofField.ts', {}, ['RoofField', 'climb']);
const { World } = load('./collision.ts', { terrain, RoofField, climb }, ['World']);
const { Player, HEIGHT, STEP_UP } = load('../player.ts', { THREE, DROP, dropStep, FLOAT: 1.35, wetGround: () => null }, ['Player', 'HEIGHT', 'STEP_UP']);

const NONE = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, mouseX: 0, mouseY: 0, sprint: false, jumpPressed: false, jumpHeld: false, downHeld: false };
const DT = 1 / 60;

for (const roofs of [true, false]) test(`no jump from the helicopter lands anyone inside a code-locked home, however it comes in (${roofs ? 'roofs' : 'no roofs'})`, () => {
  // A fourth home, as the one being added will be (its rule comes from the homes' data, not from a list).
  const ring = [[610.5, -358.6], [622.5, -358.6], [622.5, -346.6], [610.5, -346.6]];
  const fourth = { id: 'test_fourth', bands: [{ y0: -5, y1: 2.6, ring, box: [610.5, -358.6, 622.5, -346.6] }, { y0: 2.6, y1: 5.6, ring, box: [610.5, -358.6, 622.5, -346.6] }], box: [610.5, -358.6, 622.5, -346.6] };
  HOMES.push(fourth);
  try {
    // A roof: a slab over each home's top band, as the homes' blocks are (a drop lands on the block top).
    const world = new World(roofs ? HOMES.map((h) => ({ y0: Math.max(...h.bands.map((b) => b.y1)), y1: Math.max(...h.bands.map((b) => b.y1)) + 0.3, p: [h.bands[0].ring], n: 'roof', m: 'tiles' })) : [], 0);
    for (const h of HOMES) h.bands.forEach((b, i) => world.setMoving(`home-${h.id}-${i}`, b.ring, ...barrierHeights(b.y0, b.y1, STEP_UP, HEIGHT), true));
    const camera = new THREE.PerspectiveCamera();
    let jumps = 0, garden = 0, steps = 0, frames = 0;
    for (const h of HOMES) {
      const [x0, z0, x1, z1] = h.box;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const top = Math.max(...h.bands.map((b) => b.y1));
      for (let x = x0 - 6; x <= x1 + 6; x += 2.5) {
        for (let z = z0 - 6; z <= z1 + 6; z += 2.5) {
          for (const up of [DROP.jumpMin, 30]) {
            for (const [speed, steer] of [[0, false], [0, true], [12, true]]) {
              // Facing the home's middle; at speed coming at it from behind the spot (the machine's speed carried in).
              const yaw = Math.atan2(-(cx - x), -(cz - z)) || 0;
              const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
              const p = new Player(world, { x, z, yaw });
              const floor = terrain.height(x, z);
              p.place(x, z, Math.max(top, floor) + up, yaw, 0);
              p.startDrop(jumpStart(fx * speed, fz * speed, -2, [0, 0]));
              jumps++;
              let run = 0;
              for (let i = 0; i < 60 * 60 && p.chute !== null; i++) {
                let input = NONE;
                if (steer) {
                  // Hard at the middle: track there in the free fall, turn and glide there under the canopy.
                  const want = Math.atan2(-(cx - p.x), -(cz - p.z));
                  const turn = Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw));
                  input = { ...NONE, moveY: 1, moveX: p.canopy === null ? 0 : Math.max(-1, Math.min(1, -turn * 3)) };
                  if (p.canopy === null) p.yaw = want;
                }
                p.update(DT, input, camera);
                steps++;
                const inside = homeAt(p.x, p.z, p.feet);
                run = inside ? run + 1 : 0;
                if (inside) frames++;
                assert.ok(run === 0, `inside ${inside} at ${p.x.toFixed(2)}, ${p.feet.toFixed(2)}, ${p.z.toFixed(2)} for ${run} frames (jump over ${x}, ${z} from ${up} m at ${speed} m/s)`);
              }
              assert.equal(p.chute, null, 'every jump comes down');
              assert.equal(homeAt(p.x, p.z, p.feet), null, `touched down inside at ${p.x.toFixed(2)}, ${p.feet.toFixed(2)}, ${p.z.toFixed(2)}`);
              if (inEndGarden(p.x, p.z, p.feet)) garden++;
            }
          }
        }
      }
    }
    // The end house's garden has no barrier: a touchdown there is put out in front of the house in the same frame
    // (main.ts player.onChuteLand, the garden check), as for every drop. Counted, not refused here.
    assert.ok(jumps > 1500, `${jumps} jumps`);
    console.log(`# ${roofs ? 'roofs' : 'no roofs'}: ${jumps} jumps, ${steps} steps, none touched down inside a home, ${frames} frames inside; ${garden} touched down in the end house's garden (put out at once)`);
  } finally {
    HOMES.splice(HOMES.indexOf(fourth), 1);
  }
});
