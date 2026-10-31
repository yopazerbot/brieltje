// How the strongmen fight, shared by the server (which runs them in multiplayer) and the browser
// (which runs them when you play alone): plain objects and plain functions, no three.js, no
// network. A strongman roams his patch until an armed player comes into sight, then strides
// after them, throws a rock from a distance (after a wind-up you can see, so you can dodge) and
// stomps when you come close. He stays on his patch and out of walls.

/** A strongman standing at his spot, full of fight. */
export function newBrute(id, x, y, z, fight) {
  return { id, home: { x, z }, x, y, z, yaw: 0, speed: 0, hp: fight.hp, act: 'walk', until: 0, aim: null, nextThrow: 0, nextStomp: 0, wander: { x, z } };
}

/**
 * One step for a strongman who is up. `players`: who he may go for ({ name, x, y, z }: alive,
 * armed, not in a car, not just back in the game). `free(x, z)`: room for him there. Returns what
 * he did this step: { type: 'throw', id, from, to, ms } (the rock lands at `to` after `ms`) or
 * { type: 'stomp', id, at }.
 */
export function stepBrute(b, players, now, dt, fight, free, rand = Math.random) {
  const events = [];
  b.speed = 0;
  // A wind-up ends in the throw or the stomp.
  if (b.act === 'throw' || b.act === 'stomp') {
    if (now < b.until) return events;
    if (b.act === 'throw') {
      const from = { x: b.x + Math.sin(b.yaw) * 0.8, y: b.y + fight.hand, z: b.z + Math.cos(b.yaw) * 0.8 };
      const d = Math.hypot(b.aim.x - from.x, b.aim.z - from.z);
      events.push({ type: 'throw', id: b.id, from, to: b.aim, ms: Math.round((d / fight.rockSpeed + 0.35) * 1000) });
      b.nextThrow = now + fight.throwEvery * 1000;
    } else {
      events.push({ type: 'stomp', id: b.id, at: b.aim });
      b.nextStomp = now + fight.stompEvery * 1000;
    }
    b.act = 'walk';
    b.aim = null;
    return events;
  }
  // The nearest player he can see, if they aren't far beyond his patch.
  let target = null;
  let best = fight.sight;
  for (const p of players) {
    const d = Math.hypot(p.x - b.x, p.z - b.z);
    if (d < best && Math.hypot(p.x - b.home.x, p.z - b.home.z) < fight.leash + fight.throwMax) [target, best] = [p, d];
  }
  let goal = null;
  let speed = fight.roam;
  if (target) {
    b.yaw = Math.atan2(target.x - b.x, target.z - b.z);
    if (best < fight.stompRange && now >= b.nextStomp) {
      b.act = 'stomp';
      b.until = now + fight.stompWindup * 1000;
      b.aim = { x: b.x + Math.sin(b.yaw) * 2, y: b.y, z: b.z + Math.cos(b.yaw) * 2 };
      return events;
    }
    if (best > fight.throwMin && best < fight.throwMax && now >= b.nextThrow) {
      b.act = 'throw';
      b.until = now + fight.windup * 1000;
      b.aim = { x: target.x, y: target.y, z: target.z };
      return events;
    }
    if (best > fight.stompRange * 0.7) goal = target;
    speed = fight.chase;
  } else {
    if (Math.hypot(b.wander.x - b.x, b.wander.z - b.z) < 1) {
      const a = rand() * Math.PI * 2;
      const r = fight.roamRadius * Math.sqrt(rand());
      b.wander = { x: b.home.x + Math.sin(a) * r, z: b.home.z + Math.cos(a) * r };
    }
    goal = b.wander;
  }
  if (goal) {
    const dx = goal.x - b.x;
    const dz = goal.z - b.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.05) {
      if (!target) b.yaw = Math.atan2(dx, dz);
      const step = Math.min(d, speed * dt);
      const nx = b.x + (dx / d) * step;
      const nz = b.z + (dz / d) * step;
      if (Math.hypot(nx - b.home.x, nz - b.home.z) <= fight.leash && free(nx, nz)) {
        b.x = nx;
        b.z = nz;
        b.speed = step / dt;
      } else if (!target) b.wander = { x: b.x, z: b.z }; // somewhere else next step
    }
  }
  return events;
}

/** Health a landing rock or a stomp takes from someone `d` metres away. */
export function hurtBy(d, radius, damage) {
  return d < radius ? Math.round(damage * (1 - (0.7 * d) / radius)) : 0;
}

/** Health a hit takes from a strongman: a weapon's body damage, a shotgun blast all its pellets, blasts much more. */
export function bruteDamage(w, weapons) {
  if (w === 'grenade') return 150;
  if (w === 'bazooka') return 250;
  const spec = weapons[w];
  return spec ? spec.body * (spec.pellets > 1 ? spec.pellets * 0.6 : 1) : 25;
}
