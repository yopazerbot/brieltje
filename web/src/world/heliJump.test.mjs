// The homes' access control on the page, from above and from the side: a jump from the helicopter (src/heliPilot.ts), a
// new way to arrive from above at a chosen spot, and every way of moving on foot (a fall, a jump, flying on foot). The page's own collision (world/collision.ts) and player (src/player.ts) run here, with only the
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
import { barrierHeights, HOMES, homeAt, inEndGarden } from '../../shared/homes.mjs';
import { makeTerrain } from '../../shared/terrain.mjs';
import { ViewMotion } from '../viewMotion.ts';

/** A module's code without its imports and exports, run with `deps` in scope; returns the names asked for. */
function load(file, deps, names) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import[^;]*;\s*$/gm, '')
    .replace(/^export (?=(class|function|const|interface|type) )/gm, '');
  const code = stripTypeScriptTypes(src, { mode: 'transform' });
  return new Function(...Object.keys(deps), `${code}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
}

// The ground: the game's own terrain (the end house and the fourth home stand up the slope).
const terrain = makeTerrain(JSON.parse(readFileSync(new URL('../../shared/terrain.json', import.meta.url), 'utf8')));
const { RoofField, climb } = load('./roofField.ts', {}, ['RoofField', 'climb']);
const { World } = load('./collision.ts', { terrain, RoofField, climb }, ['World']);
const { Player, HEIGHT, STEP_UP } = load('../player.ts', { THREE, DROP, dropStep, FLOAT: 1.35, wetGround: () => null, ViewMotion }, ['Player', 'HEIGHT', 'STEP_UP']);

const NONE = { moveX: 0, moveY: 0, lookX: 0, lookY: 0, mouseX: 0, mouseY: 0, sprint: false, jumpPressed: false, jumpHeld: false, downHeld: false };
const DT = 1 / 60;

/** The homes' world: their walking barriers (main.ts homeLocks.barrier) and, with `roofs`, a slab over each top band. */
function homesWorld(roofs) {
  const world = new World(roofs ? HOMES.map((h) => ({ y0: Math.max(...h.bands.map((b) => b.y1)), y1: Math.max(...h.bands.map((b) => b.y1)) + 0.3, p: [h.bands[0].ring], n: 'roof', m: 'tiles' })) : [], 0);
  for (const h of HOMES) h.bands.forEach((b, i) => world.setMoving(`home-${h.id}-${i}`, b.ring, ...barrierHeights(b.y0, b.y1, STEP_UP, HEIGHT), true));
  return world;
}

for (const roofs of [true, false]) test(`no jump from the helicopter lands anyone inside a code-locked home, however it comes in (${roofs ? 'roofs' : 'no roofs'})`, () => {
  assert.ok(HOMES.length >= 4, 'the four code-locked homes');
  {
    const world = homesWorld(roofs);
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
  }
});

for (const roofs of [true, false]) test(`on foot nobody is inside a code-locked home for a single frame: falling, jumping or flying at it (${roofs ? 'roofs' : 'no roofs'})`, () => {
  const world = homesWorld(roofs);
  const camera = new THREE.PerspectiveCamera();
  let tries = 0, steps = 0;
  for (const h of HOMES) {
    const [x0, z0, x1, z1] = h.box;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const top = Math.max(...h.bands.map((b) => b.y1));
    for (let x = x0 - 5; x <= x1 + 5; x += 2) {
      for (let z = z0 - 5; z <= z1 + 5; z += 2) {
        for (const way of ['fall', 'fall high', 'jump', 'fly']) {
          const p = new Player(world, { x, z, yaw: 0 });
          const ground = world.groundAt(x, z, 1e4, 0).y;
          const feet = way === 'fall' ? Math.max(top, ground) + 1 : way === 'fall high' ? Math.max(top, ground) + 6 : way === 'fly' ? Math.max(top, ground) + 3 : world.groundAt(x, z, ground + 0.1, 0).y;
          p.place(x, z, feet, 0, 0);
          if (way === 'fly') p.flying = true;
          if (homeAt(p.x, p.z, p.feet)) continue; // standing inside already (a start nobody gets): not a way in
          tries++;
          for (let i = 0; i < 240; i++) {
            // At the middle: walking or running at it, jumping every half second, or flying down at it.
            p.yaw = Math.atan2(-(cx - p.x), -(cz - p.z));
            const input = { ...NONE, moveY: 1, sprint: i % 2 === 0, jumpPressed: way === 'jump' && i % 30 === 0, jumpHeld: way === 'jump' && i % 30 < 10, downHeld: way === 'fly' };
            p.update(DT, input, camera);
            steps++;
            const inside = homeAt(p.x, p.z, p.feet);
            assert.equal(inside, null, `${way}: inside ${inside} at ${p.x.toFixed(2)}, ${p.feet.toFixed(2)}, ${p.z.toFixed(2)} (from ${x}, ${feet.toFixed(2)}, ${z}, frame ${i})`);
          }
        }
      }
    }
  }
  assert.ok(tries > 1500, `${tries} tries`);
  console.log(`# on foot, ${roofs ? 'roofs' : 'no roofs'}: ${tries} falls, jumps and flights at the ${HOMES.length} homes, ${steps} steps, none inside a home at any frame`);
});
