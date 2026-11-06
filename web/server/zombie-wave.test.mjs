import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBounds } from '../shared/bounds.mjs';
import { Horde, makeNav, waveSize, bigOf, runnersOf, aliveCap, zombieStats, BIG, RUNNER, MAX_ADMIN_WAVE, ZOMBIE } from '../shared/zombies.mjs';
import { ZombieGame } from './zombies.mjs';
import { Game } from './game.mjs';

const nav=makeNav({prisms:[],height:()=>0,edge:makeBounds([[-40,-40],[40,-40],[40,40],[-40,40]])});
const makeHorde=()=>{
  let random=17;
  return new Horde(nav,nav.spawnSpots(),{home:{x:0,z:0},rand:()=>{random=(random*1664525+1013904223)>>>0;return random/2**32;}});
};

test('switching up, down or to the same wave immediately replaces the horde with the selected difficulty',()=>{
  const h=makeHorde();
  h.beaten.admin=7;
  h.nextId=42;
  for(const wave of[10,2,2,1,MAX_ADMIN_WAVE]){
    h.zombies.set(41,{id:41,act:'walk'});
    h.perch.admin=100;h.warned.admin=true;
    const events=h.selectWave(10_000,wave,4);
    assert.equal(h.wave,wave);assert.equal(h.phase,'wave');assert.equal(h.until,0);
    assert.equal(h.zombies.size,0);assert.equal(h.nextId,42);assert.equal(h.beaten.admin,7);
    assert.equal(h.left,waveSize(wave,4)+bigOf(wave));
    assert.equal(h.runners,runnersOf(wave,waveSize(wave,4)));
    assert.equal(h.cap,aliveCap(4));assert.ok(h.cap<=ZOMBIE.maxAlive);
    assert.deepEqual(Object.keys(h.perch),[]);assert.deepEqual(Object.keys(h.warned),[]);
    assert.deepEqual(events[0],{type:'gone',ids:[41]});
    assert.equal(events[1].type,'wave');assert.equal(events[1].wave,wave);
    assert.equal(events[1].bigs,bigOf(wave));
  }
});

test('invalid waves do not mutate the horde, and completed games cannot be resumed by a wave message',()=>{
  const h=makeHorde();
  for(const wave of[0,-1,1.5,'5',null,NaN,Infinity,{},[],MAX_ADMIN_WAVE+1,Number.MAX_SAFE_INTEGER]){
    assert.equal(h.selectWave(100,wave,1),null);
    assert.equal(h.wave,0);assert.equal(h.phase,'break');
  }
  h.phase='over';
  assert.equal(h.selectWave(100,1,1),null);
  assert.equal(h.phase,'over');
});

test('new zombies use new IDs and the selected wave stats, then normal progression continues',()=>{
  const h=makeHorde(),players=[{name:'admin',x:0,y:0,z:0,alive:true,fighter:true,safe:true}];
  h.nextId=42;
  h.selectWave(0,10,1);
  for(let now=0;now<30_000&&!h.zombies.size;now+=100)h.tick(now,.1,players);
  const zombie=[...h.zombies.values()][0];
  assert.ok(zombie);assert.equal(zombie.id,42);
  assert.equal(zombie.max,zombieStats(10,zombie.kind===BIG,0,zombie.kind===RUNNER).hp);
  h.selectWave(20_000,1,1);
  for(let now=20_000;now<50_000&&!h.zombies.size;now+=100)h.tick(now,.1,players);
  const easier=[...h.zombies.values()][0];
  assert.ok(easier.id>42);assert.equal(easier.max,50);
  h.zombies.clear();h.toSpawn=h.bigs=0;
  assert.ok(h.tick(33_000,0,players).some(e=>e.type==='cleared'&&e.wave===1));
  assert.ok(h.tick(33_000+ZOMBIE.break,0,players).some(e=>e.type==='wave'&&e.wave===2));
});

function gameFixture(){
  const messages=[],saved=[],gathered=[];
  const game={players:new Map([
    ['admin',{state:{x:0,y:0,z:0,armed:true},alive:true,hp:75}],
    ['guest',{state:{x:1,y:0,z:0,armed:true},alive:false,hp:0}],
  ]),zombieBests:{},zombieGround:()=>({nav,spots:nav.spawnSpots(),home:{x:0,z:0},edge:nav.edge}),
  inCar:()=>false,calm:()=>false,broadcast:m=>messages.push(m),send:(_ws,m)=>messages.push(m),
  saveZombieBest:(id,best)=>saved.push({id,best}),gather:names=>{
    gathered.push(...names);for(const n of names){game.players.get(n).alive=true;game.players.get(n).hp=100;}
  }};
  const modes={state:{kind:'zombies',phase:'break'},say:(text,code,args)=>messages.push({code,args}),
    send:()=>messages.push({view:z.view(0)}),finish:()=>{modes.state.phase='done';}};
  const z=new ZombieGame(game,modes,['admin','guest'],0);
  modes.state.z=z;
  return{game,modes,z,messages,saved,gathered};
}

test('selecting a wave revives downed teammates, preserves equipment and scores, and synchronizes a custom run',()=>{
  const {game,modes,z,messages,gathered}=gameFixture();
  z.down.add('guest');z.fell.set('guest',{x:1,y:0,z:0});
  z.horde.beaten.admin=3;
  const kit=z.loot.kit('admin');kit.stakes=4;
  z.horde.zombies.set(9,{id:9,act:'walk'});
  assert.equal(z.selectWave(15,'admin',1_000),true);
  assert.equal(modes.state.phase,'wave');assert.equal(z.horde.wave,15);
  assert.deepEqual(gathered,['guest']);assert.equal(game.players.get('admin').hp,75);
  assert.equal(z.down.size,0);assert.equal(z.fell.size,0);
  assert.equal(z.loot.kit('admin').stakes,4);assert.equal(z.horde.beaten.admin,3);
  assert.equal(z.view(1_000).custom,true);
  assert.ok(messages.some(m=>m.t==='zgone'&&m.ids.includes(9)));
  assert.ok(messages.some(m=>m.code==='zWaveSelected'&&m.args.n===15));
  assert.ok(messages.some(m=>m.view?.wave===15&&m.view.custom));
});

test('chosen waves do not overwrite normal records, including when no record exists yet',()=>{
  for(const best of[null,{wave:8,names:['earlier'],at:'2026-11-01'}]){
    const {z,saved}=gameFixture();z.best=best;
    z.selectWave(25,'admin',1_000);z.horde.phase='over';z.over(2_000);
    assert.equal(z.best,best);assert.equal(z.record,false);assert.deepEqual(saved,[]);
  }
  const {z,saved}=gameFixture();z.horde.wave=2;z.horde.phase='over';z.over(2_000);
  assert.equal(z.record,true);assert.equal(saved[0].best.wave,2);
});

test('the server rejects guests, malformed or inactive wave requests and throttles the admin',()=>{
  const chosen=[];
  const server={modes:{noShooting:false,zombies:{selectWave:(...args)=>chosen.push(args)}}};
  const player=role=>({role,window:Date.now(),msgs:0,states:0,others:0});
  const send=(p,wave)=>Game.prototype.handle.call(server,'tester',p,JSON.stringify({t:'zwave',wave}));
  send(player('guest'),20);assert.equal(chosen.length,0);
  for(const wave of[null,'4',0,-1,2.5,{},[],MAX_ADMIN_WAVE+1])send(player('admin'),wave);
  assert.equal(chosen.length,0);
  const admin=player('admin');send(admin,20);send(admin,1);
  assert.equal(chosen.length,1);assert.equal(chosen[0][0],20);
  admin.nextWave=0;send(admin,1);assert.equal(chosen.length,2);assert.equal(chosen[1][0],1);
  server.modes.zombies=null;admin.nextWave=0;send(admin,10);assert.equal(chosen.length,2);
});
