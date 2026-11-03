import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeChurch, churchPrisms } from './church.mjs';
import { makeTerrain } from './terrain.mjs';
import { loadBounds } from './bounds.mjs';
import { arenaOf, arenaEdge, arenaPrisms } from './arenas.mjs';
import { makeNav, Horde } from './zombies.mjs';
import { noShoot } from './zones.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const data = read('./church.json');
const house = read('../src/data/house.json');
const village = read('../src/data/village.json');
const terrain = makeTerrain(read('./terrain.json'));
const height = (x, z) => terrain.height(x, z);
const church = makeChurch(data, house.ground+height(...data.origin));
const edge = arenaEdge(arenaOf('church'), loadBounds(read('./bounds.json')));
const nav = makeNav({ prisms: arenaPrisms(churchPrisms(village.prisms, church), edge), height,
  base: house.ground, edge, areas: [church.area], doors: [], shut: true, panes: 0 });
const seed = (p) => nav.seed(p.x, p.y, p.z);

test('all 84 steps and firing bays join the outside ground, inside the church arena', () => {
  const entry = seed(church.anchors.entry);
  assert.ok(entry);
  const route = [...church.anchors.stairs, church.anchors.roof,
    ...[-7,-.5,6].flatMap((x) => [-1.25,0,1.25].map((y) => church.point([x,y,12.7])))];
  for (const p of route) {
    assert.ok(edge.inside(p.x, p.z));
    assert.ok(!noShoot(p.x, p.z));
    const node = seed(p);
    assert.ok(node, JSON.stringify(p));
    assert.ok(Math.abs(nav.y(node.node)-p.y) < .5);
    assert.ok(nav.joined(entry.node, node.node), JSON.stringify(p));
  }
  nav.field([seed(church.anchors.roof).node]);
  assert.ok(nav.distance(entry.node) < 110);
});

test('the round arena closes indoor corner floors too, including after pane updates', () => {
  for (const p of nav.floors()) if (p.open) assert.ok(edge.inside(p.x,p.z));
  nav.setPanes([]);
  for (const p of nav.floors()) if (p.open) assert.ok(edge.inside(p.x,p.z));
});

test('the old solid church is replaced without removing any other village blocks', () => {
  const blocks = churchPrisms(village.prisms, church);
  assert.equal(blocks.filter((p) => p.lm === 'church').length,0);
  for (const p of village.prisms) if (p.lm !== 'church') assert.ok(blocks.includes(p));
  assert.ok(church.prisms.every((p) => p.y1 > p.y0 && p.p.flat().flat().every(Number.isFinite)));
});

test('walls and floors block attacks, while an open roof firing lane stays open', () => {
  const a=church.point([-7,0,13.9]), b=church.point([-5,0,13.9]);
  assert.ok(nav.reach(a.x,a.y,a.z,b.x,b.y,b.z));
  const inside=church.point([-15.93,1.4,5]), outside=church.point([-15.93,3.2,5]);
  assert.equal(nav.reach(inside.x,inside.y,inside.z,outside.x,outside.y,outside.z),false);
  const low=church.point([-7,0,10]), high=church.point([-7,0,14]);
  assert.equal(nav.reach(low.x,low.y,low.z,high.x,high.y,high.z),false);
});

test('a real wave reaches a roof player without an unreachable-perch exemption', () => {
  let random=17;
  const rand=()=>{random=(random*1664525+1013904223)>>>0;return random/2**32;};
  const roof=church.anchors.roof;
  const horde=new Horde(nav,nav.spawnSpots(),{home:church.anchors.entry,rand});
  const player={name:'roof-test',...roof,alive:true,fighter:true,safe:false};
  horde.start(0);
  let hit=false,highest=-Infinity;
  for(let now=0;now<=180_000;now+=50){
    const events=horde.tick(now,.05,[player]);
    assert.ok(!events.some((e)=>e.type==='perch'||e.type==='perchOut'));
    if(events.some((e)=>e.type==='swipe')){hit=true;break;}
    for(const z of horde.zombies.values()) highest=Math.max(highest,z.y);
  }
  assert.ok(hit,`highest zombie ${highest}, roof ${roof.y}`);
});

test('a big zombie can also climb the tower and attack on the roof', () => {
  const horde=new Horde(nav,nav.spawnSpots(),{home:church.anchors.entry});
  const p=church.anchors.entry, roof=church.anchors.roof;
  horde.phase='wave'; horde.wave=5;
  horde.zombies.set(1,{id:1,kind:4,...p,node:seed(p).node,yaw:0,speed:0,top:.9,
    hp:100,max:100,damage:20,act:'walk',actAt:0,until:0,struck:false,next:0,downAt:0,target:null});
  let hit=false;
  for(let now=0;now<240_000;now+=50){
    const ev=horde.tick(now,.05,[{name:'roof-test',...roof,alive:true,fighter:true,safe:false}]);
    if(ev.some(e=>e.type==='swipe')){hit=true;break;}
  }
  assert.ok(hit,JSON.stringify(horde.zombies.get(1)));
});

test('hovering above the roof still triggers the existing unreachable-perch rule', () => {
  const horde=new Horde(nav,nav.spawnSpots(),{home:church.anchors.entry});
  horde.start(0);
  const p={name:'hover-test',...church.anchors.roof,y:church.anchors.roof.y+8,alive:true,fighter:true,safe:false};
  let warned=false,out=false;
  for(let now=0;now<=20_000;now+=50){
    const ev=horde.tick(now,.05,[p]);
    warned ||= ev.some(e=>e.type==='perch');out ||= ev.some(e=>e.type==='perchOut');
  }
  assert.ok(warned && out);
});
