import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBounds } from '../shared/bounds.mjs';
import { Horde, makeNav, ZOMBIE } from '../shared/zombies.mjs';
import { Modes } from './modes.mjs';
import { ZombieGame } from './zombies.mjs';

const RECONNECT_MS=15_000;

const edge=makeBounds([[-40,-40],[40,-40],[40,40],[-40,40]]);
const nav=makeNav({prisms:[{y0:0,y1:3,p:[[[10,-25],[10.3,-25],[10.3,25],[10,25]]]}],height:()=>0,edge});
const roster=()=>['admin','guest'].map((name,i)=>({name,x:i,y:0,z:0,alive:true,fighter:true,safe:true}));

test('40 waves progress without a round limit, one survivor keeps playing, and both down ends it',()=>{
  let random=17;
  const h=new Horde(nav,nav.spawnSpots(),{home:{x:0,z:0},rand:()=>{random=(random*1664525+1013904223)>>>0;return random/2**32;}});
  const players=roster();h.start(0);
  let now=0,cleared=0;
  while(cleared<40&&now<3_600_000){
    const events=h.tick(now,.1,players);
    assert.ok(!events.some(e=>e.type==='over'));
    for(const z of h.zombies.values())if(z.act!=='down')h.hit(z.id,1e9,'admin',now);
    if(events.some(e=>e.type==='cleared'))cleared=h.wave;
    now=h.phase==='break'?Math.max(now+100,h.until):now+100;
  }
  assert.equal(cleared,40);
  players[0].alive=false;
  assert.ok(!h.tick(now,.1,players).some(e=>e.type==='over'));
  players[1].alive=false;
  assert.ok(h.tick(now+100,.1,players).some(e=>e.type==='over'&&e.wave===41));
});

function fixture(){
  const messages=[];
  const makePlayer=(name)=>({key:`session-${name}`,ws:{},state:{x:0,y:0,z:0,armed:true},alive:true,hp:100,protectedUntil:0});
  const game={players:new Map(['admin','guest'].map(name=>[name,makePlayer(name)])),zombieBests:{},
    broadcast:m=>messages.push(m),send:(_ws,m)=>messages.push(m),inCar:()=>false,calm:()=>false,
    zombieGround:()=>({nav,spots:nav.spawnSpots(),home:{x:0,z:0},edge}),saveZombieBest:()=>{},gather:()=>{}};
  const modes=new Modes(game),z=new ZombieGame(game,modes,['admin','guest'],1000);
  z.horde.selectWave(1000,16,2);
  modes.state={kind:'zombies',phase:'wave',until:0,z};
  const drop=(name,now)=>{const p=game.players.get(name);game.players.delete(name);modes.leave(name,p,now);return p;};
  return{game,modes,z,drop,messages,makePlayer};
}

test('two live players dropping their connections keep the same wave for a brief reconnect',()=>{
  const {game,modes,z,drop}=fixture();
  const admin=drop('admin',2000),guest=drop('guest',2000);
  assert.equal(modes.state.kind,'zombies');assert.equal(modes.state.z,z);
  modes.tick(3000,50);assert.equal(z.horde.wave,16);
  game.players.set('admin',admin);modes.join('admin');
  game.players.set('guest',guest);modes.join('guest');
  modes.tick(3100,50);
  assert.equal(modes.state.kind,'zombies');assert.equal(z.horde.phase,'wave');assert.equal(z.horde.wave,16);
});

test('a disconnected survivor gets a grace period when the connected teammate is down',()=>{
  const {game,modes,z,drop}=fixture();
  drop('guest',2000);
  game.players.get('admin').alive=false;z.downed('admin');
  modes.tick(2050,50);
  assert.equal(z.horde.phase,'wave');assert.equal(z.view(2050).reconnecting,true);
  const returning={key:'session-guest',ws:{},state:{x:0,y:0,z:0,armed:false},alive:true,hp:100};
  game.players.set('guest',returning);modes.join('guest');
  modes.tick(2100,50);assert.equal(z.horde.phase,'wave');
  returning.state.armed=true;modes.tick(2150,50);
  assert.equal(z.horde.phase,'wave');assert.equal(z.view(2150).reconnecting,false);
  returning.alive=false;z.downed('guest');modes.tick(2200,50);
  assert.equal(modes.state.phase,'done');
});

test('reconnecting cannot bring a downed player back to life',()=>{
  const {game,modes,z,drop,makePlayer}=fixture();
  game.players.get('guest').alive=false;z.downed('guest');drop('guest',2000);
  const guest=makePlayer('guest');game.players.set('guest',guest);modes.join('guest');
  assert.equal(guest.alive,false);assert.equal(guest.hp,0);assert.ok(z.down.has('guest'));
});

test('an empty abandoned game is cleaned up after the reconnect grace',()=>{
  const {modes,drop}=fixture();drop('admin',2000);drop('guest',2000);
  modes.tick(2000+RECONNECT_MS-1,50);assert.equal(modes.state.kind,'zombies');
  modes.tick(2000+RECONNECT_MS+1,50);assert.equal(modes.state.kind,'free');
});

test('an expired or different session cannot keep a defeated team waiting',()=>{
  for(const otherSession of[false,true]){
    const {game,modes,z,drop}=fixture();drop('guest',2000);
    game.players.get('admin').alive=false;z.downed('admin');
    if(otherSession)game.players.set('guest',{key:'another-session',state:{x:0,y:0,z:0,armed:false},alive:true});
    modes.tick(otherSession?2050:2000+RECONNECT_MS+1,50);
    assert.equal(modes.state.phase,'done');
  }
});
