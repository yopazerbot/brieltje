import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, Triangle, Vector3 } from 'three';
import { makeChurch, churchPrisms } from './church.mjs';
import { makeTerrain } from './terrain.mjs';
import { loadBounds } from './bounds.mjs';
import { arenaOf, arenaEdge, arenaPrisms } from './arenas.mjs';
import { makeNav, Horde } from './zombies.mjs';
import { noShoot } from './zones.mjs';
import { heliExit, heliStart } from './heli.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const data = read('./church.json');
const house = read('../src/data/house_shell.json');
const village = read('../src/data/village.json');
const heliData = read('./heli.json');
const terrain = makeTerrain(read('./terrain.json'));
const height = (x, z) => terrain.height(x, z);
const church = makeChurch(data, house.ground+height(...data.origin));
const edge = arenaEdge(arenaOf('church'), loadBounds(read('./bounds.json')));
const nav = makeNav({ prisms: arenaPrisms(churchPrisms(village.prisms, church), edge), height,
  base: house.ground, edge, areas: [church.area], doors: [], shut: true, panes: 0 });
const seed = (p) => nav.seed(p.x, p.y, p.z);

test('the exported slate roof stays outside the tower stair void', () => {
  const glb=readFileSync(new URL('../public/models/church.glb',import.meta.url));
  assert.equal(glb.toString('ascii',0,4),'glTF');
  const jsonSize=glb.readUInt32LE(12), binStart=28+jsonSize;
  const model=JSON.parse(glb.toString('utf8',20,20+jsonSize));
  const node=model.nodes.find(n=>n.name==='church_slate');
  // The exporter bakes transforms and writes glTF's Y-up coordinates into the vertices.
  assert.ok(node && !node.matrix && !node.rotation && !node.translation && !node.scale);
  const voids=data.cuts.map(({box:[x0,n0,y0,x1,n1,y1]})=>
    new Box3(new Vector3(x0,y0,-n1),new Vector3(x1,y1,-n0)).expandByScalar(-.01));
  const nave=new Box3(new Vector3(-10.1,12.15,-.2),new Vector3(-9.9,12.5,.2));
  let checked=0, naveCovered=false;
  for(const primitive of model.meshes[node.mesh].primitives){
    const pos=model.accessors[primitive.attributes.POSITION], ids=model.accessors[primitive.indices];
    assert.equal(pos.componentType,5126);
    assert.equal(pos.type,'VEC3');
    const pv=model.bufferViews[pos.bufferView], iv=model.bufferViews[ids.bufferView];
    const po=binStart+(pv.byteOffset??0)+(pos.byteOffset??0), io=binStart+(iv.byteOffset??0)+(ids.byteOffset??0);
    const size=ids.componentType===5123?2:ids.componentType===5125?4:0;
    assert.ok(size,'expected unsigned short or integer indices');
    const vertex=(i)=>{
      const index=size===2?glb.readUInt16LE(io+i*size):glb.readUInt32LE(io+i*size);
      const off=po+index*(pv.byteStride??12);
      return new Vector3(glb.readFloatLE(off),glb.readFloatLE(off+4),glb.readFloatLE(off+8));
    };
    for(let i=0;i<ids.count;i+=3){
      const triangle=new Triangle(vertex(i),vertex(i+1),vertex(i+2));
      for(const box of voids)assert.ok(!box.intersectsTriangle(triangle),`slate triangle ${i/3} crosses the stair void`);
      naveCovered ||= nave.intersectsTriangle(triangle);
      checked++;
    }
  }
  assert.ok(checked>0);
  assert.ok(naveCovered,'the exterior nave roof must remain');
});

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

test('the outer stair rail stops crossings at every guarded tread and leaves the view above clear', () => {
  for (let k=1;k<82;k++) {
    const [x,z,y]=data.anchors.stairs[k], angle=Math.atan2(z,x+15.93);
    const across=(rise)=>{
      // Keep the swipe short: the nav samples attacks every 10 cm, wider than a rail.
      const a=church.point([-15.93+1.77*Math.cos(angle),1.77*Math.sin(angle),y+rise]);
      const b=church.point([-15.93+1.93*Math.cos(angle),1.93*Math.sin(angle),y+rise]);
      return nav.reach(a.x,a.y,a.z,b.x,b.y,b.z);
    };
    assert.equal(across(1),false,`missing guard at step ${k}`);
    assert.ok(across(1.5),`view blocked above step ${k}`);
  }
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

// The landing deck at the walk's end (tools/church_access.py "pad"): local x 8 to 14, y within 5, top 12.70; nets
// 0.30 lower out to y 6.5.
const ground0 = church.point([0, 0, 0]).y;
const at = (x, y, z) => church.point([x, y, z]);
const floorNode = (p) => {
  const n = seed(p);
  return n && Math.abs(nav.y(n.node) - p.y) < 0.1 ? n.node : null;
};

test('the walk runs on over its end onto the landing deck and its nets, at one level, without a jump', () => {
  const entry = seed(church.anchors.entry).node;
  const pad = church.anchors.pad;
  assert.ok(Math.abs(pad.y - (ground0 + 12.7)) < 1e-6);
  assert.ok(Math.abs(church.anchors.padYaw - (data.yaw - Math.PI)) < 1e-9);
  for (const p of [at(7.6, 0, 12.7), at(8.4, 0, 12.7), pad, at(13.6, 4.5, 12.7), at(8.4, -4.5, 12.7), at(11, 5.8, 12.4), at(11, -5.8, 12.4)]) {
    const n = floorNode(p);
    assert.ok(n !== null, `no floor at ${JSON.stringify(p)}`);
    assert.ok(nav.joined(entry, n), `not joined to the entry: ${JSON.stringify(p)}`);
    assert.ok(edge.inside(p.x, p.z) && !noShoot(p.x, p.z));
  }
});

test("the deck's rails and the nets' low edge stop a walker and keep the slates beside it apart", () => {
  const deck = floorNode(church.anchors.pad);
  // Beyond the east rail: the choir's ridge, 0.25 m lower (a step, were the rail not there).
  let ridge = 0;
  for (const p of [at(14.3, 0, 12.45), at(14.3, 0.1, 12.45), at(14.45, -0.1, 12.45)]) {
    const n = seed(p);
    if (!n || Math.abs(nav.y(n.node) - p.y) > 0.2) continue;
    ridge++;
    assert.ok(!nav.joined(deck, n.node), `the ridge past the east rail joins the deck: ${JSON.stringify(p)}`);
  }
  assert.ok(ridge > 0, 'the ridge past the east rail is a floor of its own');
  // A swipe through the rails at their heights is stopped; above them the view is open.
  for (const [a, b] of [[[13.8, 2, 13.2], [14.25, 2, 13.2]], [[8.2, 3, 13.2], [7.75, 3, 13.2]], [[11, 6.3, 12.9], [11, 6.75, 12.9]]]) {
    const p = at(...a), q = at(...b);
    assert.equal(nav.reach(p.x, p.y, p.z, q.x, q.y, q.z), false, `open between ${a} and ${b}`);
    assert.ok(nav.reach(p.x, p.y + 1.2, p.z, q.x, q.y + 1.2, q.z), `view blocked above ${a}`);
  }
});

test("every new solid of the deck lies inside the church's area and the Zombies circle; its drawing is no block", () => {
  const [x0, y0, x1, y1] = data.area;
  const pads = data.visible.filter((p) => p.n.startsWith('church-pad'));
  assert.ok(pads.length > 10);
  for (const p of pads) {
    for (const [x, y] of p.p[0]) {
      assert.ok(x >= x0 && x <= x1 && y >= y0 && y <= y1, `${p.n} outside the area at ${x}, ${y}`);
      const w = at(x, y, 0);
      assert.ok(edge.inside(w.x, w.z), `${p.n} outside the Zombies circle at ${x}, ${y}`);
    }
    assert.ok(p.y1 <= 12.7 + 1.05 + 1e-6, `${p.n} higher than the rails`);
  }
  assert.deepEqual([...new Set(pads.map((p) => p.n))].sort(), ['church-pad', 'church-pad-net', 'church-pad-rail']);
  assert.ok(data.pad && data.pad.lights.length >= 12 && data.anchors.pad);
});

for (const [name, spot] of [['the deck', () => church.anchors.pad], ['a net', () => at(11, -5.8, 12.4)]]) {
  test(`a real wave, and a big zombie, reach a player on ${name} without the unreachable-perch rule`, () => {
    let random = 23;
    const rand = () => { random = (random * 1664525 + 1013904223) >>> 0; return random / 2 ** 32; };
    const p = spot();
    const player = { name: 'pad-test', x: p.x, y: p.y, z: p.z, alive: true, fighter: true, safe: false };
    const horde = new Horde(nav, nav.spawnSpots(), { home: church.anchors.entry, rand });
    horde.start(0);
    let hit = false;
    for (let now = 0; now <= 240_000; now += 50) {
      const events = horde.tick(now, 0.05, [player]);
      assert.ok(!events.some((e) => e.type === 'perch' || e.type === 'perchOut'));
      if (events.some((e) => e.type === 'swipe')) { hit = true; break; }
    }
    assert.ok(hit, `no zombie reached ${name}`);
    const big = new Horde(nav, nav.spawnSpots(), { home: church.anchors.entry });
    const e = church.anchors.entry;
    big.phase = 'wave'; big.wave = 5;
    big.zombies.set(1, { id: 1, kind: 4, ...e, node: seed(e).node, yaw: 0, speed: 0, top: 0.9, hp: 100, max: 100, damage: 20, act: 'walk', actAt: 0, until: 0, struck: false, next: 0, downAt: 0, target: null });
    let bigHit = false;
    for (let now = 0; now < 300_000; now += 50) {
      if (big.tick(now, 0.05, [player]).some((ev) => ev.type === 'swipe')) { bigHit = true; break; }
    }
    assert.ok(bigHit, `the big zombie did not reach ${name}: ${JSON.stringify(big.zombies.get(1))}`);
  });
}

test('getting out of a helicopter on the deck puts you on the deck, a net or the walk, never across a rail onto the slates', () => {
  const inRing = (x, z, r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, zi] = r[i], [xj, zj] = r[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const inside = (x, z, p) => inRing(x, z, p.p[0]) && !p.p.slice(1).some((h) => inRing(x, z, h));
  const solids = churchPrisms(village.prisms, church);
  const near = solids.filter((p) => p.p[0].some(([x, z]) => Math.hypot(x - church.anchors.pad.x, z - church.anchors.pad.z) < 40));
  const floorAt = (x, z, top) => {
    let g = { y: house.ground + height(x, z), n: 'ground' };
    for (const p of near) if (p.y1 <= top && p.y1 > g.y && inside(x, z, p)) g = { y: p.y1, n: p.n };
    return g;
  };
  const ground = (x, z, top) => floorAt(x, z, top).y;
  const steps = heliData.size.steps;
  let outs = 0;
  for (let x = 9.0; x <= 13.0; x += 0.5) {
    for (let y = -4; y <= 4; y += 0.5) {
      for (let k = 0; k < 8; k++) {
        const hub = at(x, y, 12.7);
        const s = heliStart({ x: hub.x, y: hub.y, z: hub.z, yaw: church.anchors.padYaw + (k * Math.PI) / 4 });
        const out = heliExit(s, steps, ground, () => true);
        assert.ok(out, `stuck aboard at ${x}, ${y}, turned ${k}`);
        const f = floorAt(out.x, out.z, out.y + 0.01);
        assert.ok(['church-pad', 'church-pad-net', 'church-roof'].includes(f.n) && Math.abs(f.y - out.y) < 1e-6,
          `out onto ${f.n} at ${f.y - ground0} from ${x}, ${y}, turned ${k}`);
        outs++;
      }
    }
  }
  assert.ok(outs > 1000);
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
