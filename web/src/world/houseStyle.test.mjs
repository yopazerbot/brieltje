import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ANTHRACITE, doorColour, GARAGE_MADE_UP, garageColour, luminance, houseStyle, rollerDown, stable, CHIMNEY_SHARE, FLAT_EDGE, LEAF_SHUTTERS, LINTEL_SOLDIER, LINTEL_STONE, LINTEL_STONE_RENDERED, PLINTH_BRICK,
  PLINTH_CEMENT, PLINTH_PAINT, PLINTH_TAR, ROLLER_DOWN, ROLLER_HOUSES, ROLLER_PART, ROOF_WINDOWS, SOLAR_SHARE,
} from './houseStyle.ts';

// The houses' own hash (world/houseKeys.ts): the copy here must give the same numbers.
import { stable as keyHash } from './houseKeys.ts';

const N = 10000;
// Keys as world/facadeLook.ts's Houses makes them: from a house's corner, in decimetres.
const keys = Array.from({ length: N }, (_, i) => stable(Math.round((i * 7.31) % 900) / 10, Math.round((i * 3.17) % 1200) / 10, 29 + Math.floor(i / 9000)));
const near = (got, want, what) => assert.ok(Math.abs(got - want) < 0.05, `${what}: ${got.toFixed(3)}, want about ${want.toFixed(3)}`);

test('the copy of the hash gives the same numbers as world/houseKeys.ts', () => {
  for (let i = 0; i < 2000; i++) {
    const v = [i * 0.37 - 40, i * 1.913, 41 + (i % 31)];
    assert.equal(stable(...v), keyHash(...v));
  }
  // And the numbers it gave when the copy was made.
  assert.equal(stable(0.5, 41), 0.08056758297251082);
  assert.equal(stable(123.4, -56.7, 29), 0.7691269261922142);
});

test('the same house gets the same style, every time', () => {
  for (const k of keys.slice(0, 200)) {
    assert.deepEqual(houseStyle(k, 'nb_red', false), houseStyle(k, 'nb_red', false));
    assert.deepEqual(houseStyle(k, 'nb_white', true, false), houseStyle(k, 'nb_white', true, false));
  }
  assert.equal(rollerDown(12.3, 4.5, -67.8), rollerDown(12.3, 4.5, -67.8));
});

test('the shares come out within 5 % over 10,000 houses', () => {
  const count = (list, f) => list.filter(f).length / list.length;
  const brick = keys.map((k) => houseStyle(k, 'nb_red', false));
  const pale = keys.map((k) => houseStyle(k, 'nb_white', true));
  near(count(brick, (s) => s.chimney), CHIMNEY_SHARE, 'chimneys');
  near(count(brick, (s) => s.trim === '#f1efe9'), 0.45, 'white trim');
  near(count(brick, (s) => s.plinth.kind === 'paint'), PLINTH_PAINT, 'painted plinths');
  near(count(brick, (s) => s.plinth.kind === 'cement'), PLINTH_CEMENT, 'cement plinths');
  near(count(brick, (s) => s.plinth.kind === 'brick'), PLINTH_BRICK, 'brick plinths');
  near(count(pale, (s) => s.plinth.kind === 'tar'), PLINTH_TAR, 'tarred plinths');
  assert.equal(count(pale, (s) => s.plinth.kind === 'paint' || s.plinth.kind === 'brick'), 0);
  near(count(brick, (s) => s.lintel === 'stone'), LINTEL_STONE, 'stone lintels');
  near(count(brick, (s) => s.lintel === 'soldier'), LINTEL_SOLDIER, 'soldier courses');
  near(count(pale, (s) => s.lintel === 'stone'), LINTEL_STONE_RENDERED, 'stone lintels on rendered houses');
  assert.equal(count(pale, (s) => s.lintel === 'soldier'), 0);
  near(count(brick, (s) => s.shutters), LEAF_SHUTTERS, 'leaf shutters');
  assert.equal(count(keys.map((k) => houseStyle(k, 'nb_red', false, false)), (s) => s.shutters), 0, 'no leaf shutters without a pitched roof');
  near(count(brick, (s) => s.rollers), (1 - LEAF_SHUTTERS) * ROLLER_HOUSES, 'roller shutters');
  assert.equal(count(brick, (s) => s.rollers && s.shutters), 0);
  near(count(brick, (s) => s.flatEdge), FLAT_EDGE, 'flat roofs with an edge trim');
  near(count(brick, (s) => s.solar), SOLAR_SHARE, 'solar panels');
  near(count(brick, (s) => s.roofWindows), ROOF_WINDOWS, 'roof windows');
  for (const s of brick) assert.ok((s.solar === 0 || (s.solar >= 4 && s.solar <= 8)) && s.roofWindows <= 2);
  for (const s of brick) assert.ok(s.plinth.height >= 0.35 && s.plinth.height <= 0.7);
});

test('roller shutters: few windows have theirs down', () => {
  const downs = Array.from({ length: N }, (_, i) => rollerDown((i * 1.37) % 700, 1 + (i % 9) * 0.7, (i * 2.11) % 900 - 450));
  near(downs.filter((d) => d === 1).length / N, ROLLER_DOWN, 'fully down');
  near(downs.filter((d) => d > 0 && d < 1).length / N, ROLLER_PART, 'partly down');
  for (const d of downs) assert.ok(d === 0 || d === 1 || (d >= 0.3 && d <= 0.7));
});

test('no door or garage door is drawn darker than anthracite; lighter ones keep their colour', () => {
  const village = JSON.parse(readFileSync(new URL('../data/village.json', import.meta.url), 'utf8'));
  const ring = JSON.parse(readFileSync(new URL('../data/house_shell.json', import.meta.url), 'utf8'));
  const colours = new Set([...village.openings, ...(ring.surroundings?.openings ?? [])].filter((o) => o.k !== 'w' && o.c).map((o) => o.c));
  assert.ok(colours.size > 10);
  const floor = luminance(ANTHRACITE);
  for (const c of [...colours, '#000000', '#111111']) {
    const drawn = doorColour(c);
    assert.ok(luminance(drawn) >= floor * 0.97, `${c} drawn as ${drawn}`);
    if (luminance(c) >= floor) assert.equal(drawn, c.toLowerCase());
  }
});

test('a made-up garage door agrees with its frame', () => {
  assert.equal(GARAGE_MADE_UP.length, 3);
  assert.equal(garageColour('#f1efe9'), '#ece8df'); // white with white
  assert.equal(garageColour('#3a3c3f'), ANTHRACITE); // anthracite with anthracite
  assert.equal(garageColour('#4c3427'), '#7a5a3e'); // wood with brown
  assert.equal(garageColour('#9b7653'), '#7a5a3e');
  assert.equal(garageColour('#2f4a3a'), ANTHRACITE); // the odd green frame: anthracite
});
