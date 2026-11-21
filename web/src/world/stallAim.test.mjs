// Which thing on the Zombies stall's table you face (world/stallAim.ts). The review found that from either end of the
// table all six lay within 0.1 rad of each other, so a hair of turning flipped the label and a purchase could land on
// the wrong thing, and that from 2.5 m a thing was offered over 102 degrees, up to 1.7 m past the table's end.
// Run: node --test src/world/stallAim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { STALL, STALL_SPOTS } from '../../shared/stall.mjs';
import { BEYOND, ITEM_X, ITEM_Z, itemAt, stallPick, TABLE_HALF } from './stallAim.ts';

const SPOTS = STALL_SPOTS.map(([id, x, z, yaw]) => ({ id, x, z, yaw }));
/** The world (x, z) of the stall's local (lx, lz): the front along -z, the table along x. */
const world = (s, lx, lz) => ({ x: s.x + lx * Math.cos(s.yaw) + lz * Math.sin(s.yaw), z: s.z - lx * Math.sin(s.yaw) + lz * Math.cos(s.yaw) });
/** The game's yaw that looks from `p` at `q`. */
const yawTo = (p, q) => Math.atan2(-(q.x - p.x), -(q.z - p.z));
/** Every yaw round the circle, a tenth of a degree apart. */
const YAWS = Array.from({ length: 3600 }, (_, i) => (i / 3600) * 2 * Math.PI - Math.PI);
/** Places to stand in front of the table and behind it, outside its walking barrier (0.6 m deep, 0.3 m for the body). */
function standing() {
  const out = [];
  for (const lz of [-0.95, -1.3, -1.8, -2.3, 0.95, 1.5, 2.2]) {
    for (let k = -10; k <= 10; k++) {
      const lx = (k / 10) * (TABLE_HALF + BEYOND - 0.01);
      if (Math.hypot(lx, lz) <= STALL.near - 0.05) out.push([lx, lz]);
    }
  }
  return out;
}

test('from in front and from behind, facing a thing picks that thing, at every place\'s stall', () => {
  for (const s of SPOTS) {
    for (const [lx, lz] of standing()) {
      const p = world(s, lx, lz);
      for (let i = 0; i < ITEM_X.length; i++) assert.equal(stallPick(s, p.x, p.z, yawTo(p, itemAt(s, i))), i, `${s.id} at ${lx.toFixed(1)}, ${lz}: thing ${i}`);
    }
  }
});

test('each thing is picked over a comfortable turn from anywhere in front or behind', () => {
  // The narrowest turn over which one thing stays picked (mouse, stick and touch alike must stop within it).
  let narrowest = Infinity;
  for (const s of SPOTS) {
    for (const [lx, lz] of standing()) {
      const p = world(s, lx, lz);
      const picks = YAWS.map((y) => stallPick(s, p.x, p.z, y));
      for (let i = 0; i < ITEM_X.length; i++) {
        let run = 0, best = 0;
        for (const k of [...picks, ...picks]) {
          run = k === i ? run + 1 : 0;
          best = Math.max(best, run);
        }
        narrowest = Math.min(narrowest, Math.min(best, picks.length) * (2 * Math.PI / YAWS.length));
      }
    }
  }
  console.log(`narrowest turn holding one thing: ${narrowest.toFixed(3)} rad`);
  assert.ok(narrowest >= 0.05, `a thing is held over at least 0.05 rad (3 degrees): ${narrowest.toFixed(3)}`);
});

test('from either end of the table nothing is offered, whichever way you look', () => {
  for (const s of SPOTS) {
    for (const side of [-1, 1]) {
      for (let lx = 1.45; lx <= STALL.near; lx += 0.1) {
        for (let lz = -0.6; lz <= 0.6; lz += 0.2) {
          const p = world(s, side * lx, lz);
          for (const y of YAWS) assert.equal(stallPick(s, p.x, p.z, y), -1, `${s.id}: at the end, ${side * lx}, ${lz}`);
        }
      }
    }
  }
});

test('from 2.5 m the offer is a narrow cone that ends at the table\'s end (and 0.1 m)', () => {
  let widest = 0;
  for (const s of SPOTS) {
    for (const [lx, lz] of [[0, -2.45], [0, 2.45], [1.0, -2.2], [-1.2, -2.15], [1.3, 2.1]]) {
      const p = world(s, lx, lz);
      let arc = 0;
      for (const y of YAWS) {
        if (stallPick(s, p.x, p.z, y) < 0) continue;
        arc += 360 / YAWS.length;
        // Where the view crosses the line the things lie on: on the table.
        const fx = -Math.sin(y - s.yaw), fz = -Math.cos(y - s.yaw); // the view in the stall's frame
        const t = (ITEM_Z - lz) / fz;
        assert.ok(t > 0, 'it lies ahead');
        assert.ok(Math.abs(lx + fx * t) <= TABLE_HALF + BEYOND + 1e-9, `${s.id} from ${lx}, ${lz}: the view crosses at ${(lx + fx * t).toFixed(2)}`);
      }
      widest = Math.max(widest, arc);
      assert.ok(arc <= 70, `${s.id} from ${lx}, ${lz}: offered over ${arc.toFixed(1)} degrees`);
    }
  }
  console.log(`widest offer from 2.1 to 2.45 m: ${widest.toFixed(1)} degrees (was 102)`);
});

test('looking away, too far, or inside the table: nothing', () => {
  const s = SPOTS[0];
  const p = world(s, 0, -1.5);
  assert.equal(stallPick(s, p.x, p.z, yawTo(p, itemAt(s, 2)) + Math.PI), -1, 'your back to it');
  assert.equal(stallPick(s, p.x, p.z, yawTo(p, itemAt(s, 0)) + 0.6), -1, 'well past the outer thing');
  const far = world(s, 0, -(STALL.near + 0.05));
  assert.equal(stallPick(s, far.x, far.z, yawTo(far, itemAt(s, 2))), -1, 'past STALL.near');
  const inside = world(s, 0, -0.2);
  assert.equal(stallPick(s, inside.x, inside.z, yawTo(inside, itemAt(s, 2))), -1);
  for (const bad of [NaN, Infinity]) assert.equal(stallPick(s, bad, p.z, 0), -1);
});

test('two things as near in angle: the nearer one', () => {
  for (const s of SPOTS) {
    // Standing a little left of the gap between things 2 and 3, looking halfway between them: the same angle to
    // each, thing 2 the nearer.
    const gap = (ITEM_X[2] + ITEM_X[3]) / 2;
    const p = world(s, gap + 0.15, -1.0);
    const a = yawTo(p, itemAt(s, 2)), b = yawTo(p, itemAt(s, 3));
    const mid = Math.atan2(Math.sin(a) + Math.sin(b), Math.cos(a) + Math.cos(b));
    assert.equal(stallPick(s, p.x, p.z, mid), 2, s.id);
    // Behind the table, mirrored: thing 3 the nearer.
    const q = world(s, gap - 0.15, 1.0);
    const c = yawTo(q, itemAt(s, 2)), d = yawTo(q, itemAt(s, 3));
    assert.equal(stallPick(s, q.x, q.z, Math.atan2(Math.sin(c) + Math.sin(d), Math.cos(c) + Math.cos(d))), 3, s.id);
  }
});
