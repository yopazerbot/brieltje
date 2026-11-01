// The Zombies party game, shared by the server (which runs it in multiplayer) and the browser
// (which runs it when you play alone): plain objects and plain functions, no three.js, no network.
//
// The players are one team round the house and the bungalow (shared/bounds.json `party`). Zombies
// come in waves from the edge of that area, each wave bigger, a little faster and a little tougher
// than the last, with a break of BREAK_MS between them. A zombie goes for the nearest player who
// fights (Action or Paintball), round walls, fences, hedges, the houses and the parked cars: a
// distance field over a grid of CELL-metre squares (makeNav) is worked out from the players a few
// times a second, and each zombie steps downhill on it. Close by, with a clear line, it walks
// straight at them. Next to you it swipes (an attack you can step away from: the hit lands after a
// wind-up). Every fifth wave brings big ones, slow and tough, who pound the ground round them.
//
// Who is down waits for the end of the wave; when every player who fights is down at once, the
// game is over (Horde.tick says so). The caller keeps the players' health and the messages.

/** The four kinds of regular zombie (web/public/models/zombies.glb), then the big one. */
export const VARIANTS = ['shirt', 'hoodie', 'overall', 'farmer'];
export const BIG = 4;

export const ZOMBIE = {
  /** m: the side of a square of the grid */
  cell: 0.5,
  /** ms: the first wave comes after this, the next ones after BREAK */
  firstBreak: 8000,
  break: 15000,
  /** The most up at once, however many players */
  maxAlive: 30,
  /** m: a zombie's half width (they keep this far apart); the big one's */
  radius: 0.35,
  bigRadius: 0.8,
  /** m: from this close (middle to middle) a zombie swipes, and the swipe reaches this far when it lands */
  attackFrom: 1.15,
  reach: 1.55,
  bigFrom: 2.1,
  bigReach: 3.4,
  /** ms: from the start of a swipe (or a pound) to its hit, and to its end */
  impact: 450,
  attackMs: 900,
  bigImpact: 800,
  bigAttackMs: 1500,
  /** ms between two swipes of one zombie; a player hit can't be hit again this soon */
  swipeEvery: 1300,
  bigEvery: 2600,
  shield: 400,
  /** ms a hit zombie staggers; a fallen one lies this long before it is gone */
  hurtMs: 350,
  downMs: 3000,
  /** m: closer than this, in a clear line, a zombie walks straight at you */
  straight: 7,
  /** m along the way: the distance field reaches this far round the players */
  fieldReach: 110,
  /** ms between two distance fields */
  fieldEvery: 500,
  /** m: a zombie comes out of the edge at least this far from the nearest player, best about `spawnBest` and out of sight */
  spawnMin: 13,
  spawnBest: 26,
  spawnMax: 60,
};

const INF = 0xffff;

/** Whether (x, z) is inside the outline `ring` ([x, z] points). */
function inside(x, z, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * How many zombies wave `n` (1, 2 ...) brings with `players` who fight: 3 + 2n, times 1 for one
 * player, 2.2 for four, 3.8 for eight, 5 for sixteen. The big ones come on top (bigOf).
 */
export function waveSize(n, players) {
  const p = Math.max(1, players);
  return Math.round((3 + 2 * n) * (0.6 + 0.4 * Math.min(p, 8) + 0.15 * Math.max(0, p - 8)));
}

/** Big zombies in wave `n`: one every fifth wave, two every tenth, at most three. */
export function bigOf(n) {
  return n % 5 === 0 ? Math.min(3, n / 5) : 0;
}

/** The most up at once: 11 alone, 20 for four, 30 from eight players. */
export function aliveCap(players) {
  return Math.min(ZOMBIE.maxAlive, 8 + 3 * Math.max(1, players));
}

/**
 * A zombie of wave `n`: how fast it walks (m/s: half the 1.4 of walking at first, about it by wave 13,
 * never as fast as the 3.5 of running; their walk clip's own pace is about 0.45 and their lurch's
 * about 0.95, so the walk is never played much faster than it was made), its health and its swipe.
 * The big one is slower, eight times as tough and hits much harder. `jitter` (0..1) spreads their
 * speeds a little.
 */
export function zombieStats(n, big, jitter = 0.5) {
  const k = n - 1;
  if (big) return { speed: Math.min(1.2, 0.6 + 0.03 * k), hp: 8 * (50 + 12 * k), damage: 30 };
  return { speed: Math.min(2.3, 0.65 + 0.06 * k) * (0.9 + 0.2 * jitter), hp: 50 + 12 * k, damage: Math.min(25, 10 + k) };
}

/** ms between two zombies coming out: quicker in later waves. */
export function spawnEvery(n) {
  return Math.max(250, 900 - 60 * n);
}

/**
 * Where a zombie can't stand on the ground of a house: its rooms and floors at ground level (the main
 * house's ground floor and the bungalow's rooms). The house and the bungalow stay shut during the
 * game, so zombies and players stay out of them; their roofs and upper floors don't count.
 */
export function makeIndoors(prisms) {
  const floors = prisms
    .filter((p) => typeof p.n === 'string' && p.y1 < 1 && (p.n === 'ground floor' || (/\(old house\)$/.test(p.n) && !/^driveway/i.test(p.n))))
    .map((p) => {
      const ring = p.p[0];
      const xs = ring.map((v) => v[0]);
      const zs = ring.map((v) => v[1]);
      return { ring, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    });
  return (x, z) => floors.some((f) => x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ && inside(x, z, f.ring));
}

/**
 * The grid the zombies walk on, over the area `edge` (shared/bounds.mjs: the party outline): a
 * square is closed when it lies outside the edge or in a house (`indoors`), or when a wall, hedge,
 * fence or house of `prisms` stands in it from 0.4 to 2.2 m above the ground (as the strongmen's map
 * in server/game.mjs, but every side of a block is drawn in too, so a fence 5 cm thick closes its
 * squares), or a car of `boxes` ({ x, z, yaw, halfL, halfW }). Those over 1.6 m also block sight.
 * `height(x, z)`: the relief (shared/terrain.mjs). About 155,000 squares for the party area.
 */
export function makeNav({ prisms, height, edge, indoors = () => false, boxes = [] }) {
  const C = ZOMBIE.cell;
  const x0 = Math.floor(edge.minX) - 1;
  const z0 = Math.floor(edge.minZ) - 1;
  const nx = Math.ceil((edge.maxX + 1 - x0) / C) + 1;
  const nz = Math.ceil((edge.maxZ + 1 - z0) / C) + 1;
  const n = nx * nz;
  const block = new Uint8Array(n);
  const tall = new Uint8Array(n);
  const near = new Uint8Array(n); // next to a closed square: a step costs more, so the way keeps off walls
  const dist = new Uint16Array(n).fill(INF);
  const cellAt = (x, z) => {
    const i = Math.floor((x - x0) / C);
    const j = Math.floor((z - z0) / C);
    return i < 1 || j < 1 || i >= nx - 1 || j >= nz - 1 ? -1 : i * nz + j;
  };
  const cx = (k) => x0 + (Math.floor(k / nz) + 0.5) * C;
  const cz = (k) => z0 + ((k % nz) + 0.5) * C;

  for (let k = 0; k < n; k++) {
    const i = Math.floor(k / nz);
    const j = k % nz;
    if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) block[k] = 1;
    else if (!edge.inside(cx(k), cz(k)) || indoors(cx(k), cz(k))) block[k] = 1;
  }
  const mark = (k, high) => {
    if (k < 0) return;
    block[k] = 1;
    if (high) tall[k] = 1;
  };
  for (const p of prisms) {
    const ring = p.p?.[0];
    if (!ring || ring.length < 2) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sx = 0, sz = 0;
    for (const [x, z] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      sx += x; sz += z;
    }
    if (maxX < x0 || minX > x0 + nx * C || maxZ < z0 || minZ > z0 + nz * C) continue;
    // Heights over the ground: a draped block (a hedge, a fence: `d`) follows the relief, a house stands at its middle's.
    const lift = p.d ? 0 : height(sx / ring.length, sz / ring.length);
    if (p.y1 - lift < 0.4 || p.y0 - lift > 2.2) continue;
    const high = p.y1 - lift > 1.6;
    const i0 = Math.max(1, Math.floor((minX - x0) / C)), i1 = Math.min(nx - 2, Math.floor((maxX - x0) / C));
    const j0 = Math.max(1, Math.floor((minZ - z0) / C)), j1 = Math.min(nz - 2, Math.floor((maxZ - z0) / C));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) if (inside(x0 + (i + 0.5) * C, z0 + (j + 0.5) * C, ring)) mark(i * nz + j, high);
    }
    // Its sides, every quarter of a square: a thin fence has no square's middle inside it.
    for (let a = 0; a < ring.length; a++) {
      const [ax, az] = ring[a];
      const [bx, bz] = ring[(a + 1) % ring.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (C / 4)));
      for (let s = 0; s <= steps; s++) mark(cellAt(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps), high);
    }
  }
  for (const b of boxes) {
    const r = Math.hypot(b.halfL, b.halfW) + C;
    const fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw); // the game's yaw: forward is -z at 0 (shared/parking.mjs)
    for (let x = b.x - r; x <= b.x + r; x += C / 2) {
      for (let z = b.z - r; z <= b.z + r; z += C / 2) {
        const dx = x - b.x, dz = z - b.z;
        const along = dx * fx + dz * fz;
        const across = dx * -fz + dz * fx;
        if (Math.abs(along) <= b.halfL + 0.15 && Math.abs(across) <= b.halfW + 0.15) mark(cellAt(x, z), false);
      }
    }
  }
  for (let k = 0; k < n; k++) {
    if (block[k]) continue;
    const i = Math.floor(k / nz);
    const j = k % nz;
    if (i < 1 || j < 1 || i >= nx - 1 || j >= nz - 1) continue;
    for (let di = -1; di <= 1 && !near[k]; di++) for (let dj = -1; dj <= 1; dj++) if (block[k + di * nz + dj]) near[k] = 1;
  }

  // The eight steps: their offset in the grid and cost (a square 2, a diagonal 3); a diagonal only when
  // both squares beside it are open (no cutting a wall's corner): SIDE_A and SIDE_B (0 for a straight step).
  const OFF = Int32Array.from([nz, -nz, 1, -1, nz + 1, nz - 1, -nz + 1, -nz - 1]);
  const COST = Uint8Array.from([2, 2, 2, 2, 3, 3, 3, 3]);
  const SIDE_A = Int32Array.from([0, 0, 0, 0, nz, nz, -nz, -nz]);
  const SIDE_B = Int32Array.from([0, 0, 0, 0, 1, -1, 1, -1]);
  const open = (k, s) => !block[k + OFF[s]] && (s < 4 || (!block[k + SIDE_A[s]] && !block[k + SIDE_B[s]]));
  const buckets = Array.from({ length: 8 }, () => []);
  // A distance counts only when stamped with the field's number: no clearing 155,000 squares each time.
  const stamp = new Uint16Array(n);
  let epoch = 0;
  const at = (k) => (stamp[k] === epoch ? dist[k] : INF);
  const want = new Uint8Array(n);
  // Which open squares join up (the same number): worked out once, so a spot the players can't be
  // reached from (a closed-off garden) is known without a field reaching it.
  const region = new Int32Array(n).fill(-1);
  {
    let label = 0;
    const queue = new Int32Array(n);
    for (let k0 = 0; k0 < n; k0++) {
      if (block[k0] || region[k0] >= 0) continue;
      let head = 0, tail = 0;
      queue[tail++] = k0;
      region[k0] = label;
      while (head < tail) {
        const k = queue[head++];
        for (let s = 0; s < 8; s++) {
          const q = k + OFF[s];
          if (region[q] < 0 && open(k, s)) {
            region[q] = label;
            queue[tail++] = q;
          }
        }
      }
      label++;
    }
  }
  /** The region of the open square at or next to (x, z), or -1. */
  const regionAt = (x, z) => {
    const k = cellAt(x, z);
    if (k < 0) return -1;
    if (!block[k]) return region[k];
    for (let s = 0; s < 8; s++) if (!block[k + OFF[s]]) return region[k + OFF[s]];
    return -1;
  };

  return {
    cell: C,
    x0, z0, nx, nz,
    /** Whether a zombie can stand at (x, z). */
    walkable(x, z) {
      const k = cellAt(x, z);
      return k >= 0 && !block[k];
    },
    /** Whether the line from a to b stays on open ground (`sight`: only the tall things count). */
    clear(ax, az, bx, bz, sight = false) {
      const grid = sight ? tall : block;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (C / 2)));
      for (let s = 1; s < steps; s++) {
        const k = cellAt(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
        if (k < 0 || grid[k]) return false;
      }
      return true;
    },
    /**
     * The distance field from `sources` ({ x, z }: the players), out to ZOMBIE.fieldReach along the
     * way: Dial's algorithm with buckets, as every step costs 2 or 3 (and 2 more next to a wall). With
     * `until` ({ x, z }: the zombies) it stops once each of their squares is settled: a step downhill
     * from a square only looks at squares settled before it, so the rest isn't needed (with the
     * zombies near the players, a fraction of the area).
     */
    field(sources, until = null) {
      if (++epoch > 0xfffe) {
        stamp.fill(0);
        epoch = 1;
      }
      const max = Math.round((ZOMBIE.fieldReach / C) * 2);
      let pending = 0;
      let wanted = 0;
      for (const u of until ?? []) {
        const k = cellAt(u.x, u.z);
        if (k >= 0 && !block[k] && !want[k]) {
          want[k] = 1;
          wanted++;
        }
      }
      for (const s of sources) {
        const k = cellAt(s.x, s.z);
        if (k < 0 || at(k) === 0) continue;
        dist[k] = 0;
        stamp[k] = epoch;
        buckets[0].push(k);
        pending++;
      }
      let d = 0;
      for (; pending > 0 && d <= max && (until === null || wanted > 0); d++) {
        const b = buckets[d & 7];
        while (b.length) {
          const k = b.pop();
          pending--;
          if (at(k) !== d) continue;
          if (want[k]) {
            want[k] = 0;
            wanted--;
          }
          for (let s = 0; s < 8; s++) {
            const q = k + OFF[s];
            if (!open(k, s)) continue;
            const nd = d + COST[s] + near[q] * 2;
            if (nd < at(q)) {
              dist[q] = nd;
              stamp[q] = epoch;
              buckets[nd & 7].push(q);
              pending++;
            }
          }
        }
      }
      for (const b of buckets) b.length = 0;
      // Zombies out of reach (or the search ended first) leave their marks: cleared for the next field.
      if (wanted > 0) for (const u of until) {
        const k = cellAt(u.x, u.z);
        if (k >= 0) want[k] = 0;
      }
    },
    /** How far along the way (m) from (x, z) to the nearest source of the last field; Infinity out of reach. */
    distance(x, z) {
      const k = cellAt(x, z);
      return k < 0 || at(k) === INF ? Infinity : (at(k) * C) / 2;
    },
    /** Whether a zombie at (x, z) can walk to (tx, tz) at all (the same open region; worked out once). */
    joined(x, z, tx, tz) {
      const a = regionAt(x, z);
      return a >= 0 && a === regionAt(tx, tz);
    },
    /** The middle of the next square downhill from (x, z) on the last field, or null (out of reach, or there). */
    next(x, z) {
      const k = cellAt(x, z);
      if (k < 0) return null;
      let best = at(k);
      let to = -1;
      for (let s = 0; s < 8; s++) {
        const q = k + OFF[s];
        if (!open(k, s)) continue;
        const v = at(q);
        if (v < best) [best, to] = [v, q];
      }
      return to < 0 ? null : { x: cx(to), z: cz(to) };
    },
    /**
     * Places along the edge where zombies come in: every `step` m along the outline, `inset` m inside
     * it, on open ground.
     */
    edgeSpots(ring, step = 3, inset = 1.5) {
      const out = [];
      for (let a = 0; a < ring.length; a++) {
        const [ax, az] = ring[a];
        const [bx, bz] = ring[(a + 1) % ring.length];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.01) continue;
        const nxv = -(bz - az) / len, nzv = (bx - ax) / len;
        for (let s = step / 2; s < len; s += step) {
          const px = ax + ((bx - ax) * s) / len, pz = az + ((bz - az) * s) / len;
          for (const side of [1, -1]) {
            const x = px + nxv * inset * side, z = pz + nzv * inset * side;
            if (edge.inside(x, z) && this.walkable(x, z)) {
              out.push({ x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 });
              break;
            }
          }
        }
      }
      return out;
    },
  };
}

/**
 * The game's waves and zombies. `nav`: the grid (makeNav); `spots`: where they come in (edgeSpots);
 * `height(x, z)`: the ground's height under a zombie (for whether it reaches someone above or below);
 * `home`: where they go when nobody fights.
 */
export class Horde {
  constructor(nav, spots, { height = () => 0, home = { x: 4.5, z: 6 }, rand = Math.random } = {}) {
    this.nav = nav;
    this.spots = spots;
    this.height = height;
    this.home = home;
    this.rand = rand;
    /** 'break' (counting down to the next wave), 'wave', or 'over' */
    this.phase = 'break';
    this.wave = 0;
    this.until = 0;
    this.toSpawn = 0;
    this.bigs = 0;
    this.bigAt = 0;
    this.cap = ZOMBIE.maxAlive;
    this.nextSpawn = 0;
    this.fieldAt = -Infinity;
    /** id -> zombie: { id, kind, x, z, yaw, speed, top, hp, max, damage, act, actAt, until, struck, next, downAt, target } */
    this.zombies = new Map();
    this.nextId = 1;
    /** Player name -> zombies they beat in this game */
    this.beaten = Object.create(null);
    this.shielded = Object.create(null); // player name -> hit until (no second hit that soon)
  }

  /** The first break before wave 1. */
  start(now) {
    this.phase = 'break';
    this.until = now + ZOMBIE.firstBreak;
  }

  /** Zombies still to beat in this wave: those up and those still to come. */
  get left() {
    let n = this.toSpawn + this.bigs;
    for (const z of this.zombies.values()) if (z.act !== 'down') n++;
    return n;
  }

  /** Whether a big one is in this wave (still to come or up). */
  get bigWave() {
    return bigOf(this.wave) > 0;
  }

  /**
   * One step. `players`: { name, x, y, z, alive, fighter (fights: armed, on foot), safe (just back:
   * chased, not hit) }. Returns what happened: { type: 'wave', wave, count, big }, { type: 'spawn',
   * id }, { type: 'swipe', id, name, damage } (a player hit), { type: 'cleared', wave } (everyone
   * down comes back now), { type: 'gone', ids } (fallen zombies to take away) and { type: 'over', wave }.
   */
  tick(now, dt, players) {
    const ev = [];
    if (this.phase === 'over') {
      for (const z of this.zombies.values()) z.speed = 0;
      return ev;
    }
    const fighters = players.filter((p) => p.fighter);
    const targets = fighters.filter((p) => p.alive);
    if (this.phase === 'break' && now >= this.until) this.begin(now, fighters.length, ev);
    if (this.wave > 0 && fighters.length && !targets.length) {
      this.phase = 'over';
      ev.push({ type: 'over', wave: this.wave });
      return ev;
    }
    if (now - this.fieldAt >= ZOMBIE.fieldEvery) {
      // From the players (the house when nobody fights), as far as the zombies up need it.
      this.fieldAt = now;
      this.nav.field(targets.length ? targets : [this.home], [...this.zombies.values()].filter((z) => z.act !== 'down'));
    }
    if (this.phase === 'wave') this.spawn(now, targets, ev);
    this.move(now, dt, targets, ev);
    const gone = [];
    for (const z of this.zombies.values()) if (z.act === 'down' && now - z.downAt > ZOMBIE.downMs) gone.push(z.id);
    for (const id of gone) this.zombies.delete(id);
    if (gone.length) ev.push({ type: 'gone', ids: gone });
    if (this.phase === 'wave' && this.left === 0) {
      this.phase = 'break';
      this.until = now + ZOMBIE.break;
      ev.push({ type: 'cleared', wave: this.wave });
    }
    return ev;
  }

  /** The next wave: its size for the players who fight, its big ones, how fast they come. */
  begin(now, players, ev) {
    this.phase = 'wave';
    this.wave++;
    this.players = Math.max(1, players);
    this.toSpawn = waveSize(this.wave, this.players);
    this.bigs = bigOf(this.wave);
    this.bigAt = Math.floor(this.toSpawn * 0.6); // the big ones come once a good part of the wave is out
    this.cap = aliveCap(this.players);
    this.nextSpawn = now + 400;
    ev.push({ type: 'wave', wave: this.wave, count: this.toSpawn + this.bigs, big: this.bigs > 0 });
  }

  /** Zombies out of the edge, one at a time, while there is room under the cap. */
  spawn(now, targets, ev) {
    if (now < this.nextSpawn || (!this.toSpawn && !this.bigs)) return;
    let up = 0;
    for (const z of this.zombies.values()) if (z.act !== 'down') up++;
    if (up >= this.cap) return;
    const big = this.bigs > 0 && (this.toSpawn <= this.bigAt || this.toSpawn === 0);
    const at = this.pick(targets);
    if (!at) {
      this.nextSpawn = now + 500;
      return;
    }
    if (big) this.bigs--;
    else this.toSpawn--;
    const s = zombieStats(this.wave, big, this.rand());
    const id = this.nextId++;
    const kind = big ? BIG : Math.floor(this.rand() * VARIANTS.length);
    const yaw = Math.atan2(this.home.x - at.x, this.home.z - at.z);
    this.zombies.set(id, {
      id, kind, x: at.x, z: at.z, yaw, speed: 0, top: s.speed, hp: s.hp, max: s.hp, damage: s.damage,
      act: 'walk', actAt: now, until: 0, struck: false, next: now + 800, downAt: 0, target: null,
    });
    this.nextSpawn = now + spawnEvery(this.wave) * (0.6 + 0.8 * this.rand());
    ev.push({ type: 'spawn', id });
  }

  /**
   * Where the next zombie comes in: a spot on the edge the players can reach, out of their sight if
   * one is, about ZOMBIE.spawnBest m from the nearest of them (never closer than spawnMin); one of the
   * six best, at random. With nobody fighting, round the house.
   */
  pick(targets) {
    const from = targets.length ? targets : [this.home];
    const ranked = [];
    for (const s of this.spots) {
      let d = Infinity;
      let near = null;
      for (const p of from) {
        const e = Math.hypot(p.x - s.x, p.z - s.z);
        if (e < d) [d, near] = [e, p];
      }
      if (d < ZOMBIE.spawnMin) continue;
      if (!this.nav.joined(s.x, s.z, near.x, near.z)) continue; // a closed-off corner: they'd never get to them
      const far = d > ZOMBIE.spawnMax;
      const seen = !far && this.nav.clear(s.x, s.z, near.x, near.z, true);
      ranked.push({ s, score: Math.abs(d - ZOMBIE.spawnBest) + (seen ? 25 : 0) + (far ? 40 + d : 0) });
    }
    if (!ranked.length) return null;
    ranked.sort((a, b) => a.score - b.score);
    const s = ranked[Math.floor(this.rand() * Math.min(6, ranked.length))].s;
    for (let k = 0; k < 6; k++) {
      const x = s.x + (this.rand() - 0.5), z = s.z + (this.rand() - 0.5);
      if (this.nav.walkable(x, z)) return { x, z };
    }
    return { x: s.x, z: s.z };
  }

  /** Every zombie that is up: a step towards the nearest player, or a swipe at them. */
  move(now, dt, targets, ev) {
    const list = [...this.zombies.values()].filter((z) => z.act !== 'down');
    // Apart: two zombies in one another are pushed out (m/s), so a crowd spreads round its player.
    const push = new Map(list.map((z) => [z, { x: 0, z: 0 }]));
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const p = list[a];
        const q = list[b];
        const r = (p.kind === BIG ? ZOMBIE.bigRadius : ZOMBIE.radius) + (q.kind === BIG ? ZOMBIE.bigRadius : ZOMBIE.radius);
        let dx = p.x - q.x;
        let dz = p.z - q.z;
        const d = Math.hypot(dx, dz);
        if (d >= r) continue;
        if (d < 1e-3) [dx, dz] = [Math.sin(p.id), Math.cos(p.id)];
        const f = ((r - d) / r) * 2.5 / Math.max(d, 1e-3);
        push.get(p).x += dx * f;
        push.get(p).z += dz * f;
        push.get(q).x -= dx * f;
        push.get(q).z -= dz * f;
      }
    }
    for (const z of list) this.step(z, now, dt, targets, push.get(z), ev);
  }

  step(z, now, dt, targets, push, ev) {
    const big = z.kind === BIG;
    let tgt = null;
    let td = Infinity;
    for (const p of targets) {
      const d = Math.hypot(p.x - z.x, p.z - z.z);
      if (d < td) [tgt, td] = [p, d];
    }
    z.target = tgt?.name ?? null;
    const ground = this.height(z.x, z.z);
    const level = (p) => p.y - ground > -0.6 && p.y - ground < 2.1; // within its reach, not on a roof
    if (z.act === 'hurt') {
      if (now < z.until) {
        z.speed = 0;
        return;
      }
      z.act = 'walk';
    }
    if (z.act === 'attack') {
      z.speed = 0;
      if (tgt) z.yaw = turn(z.yaw, Math.atan2(tgt.x - z.x, tgt.z - z.z), (big ? 1.5 : 4) * dt);
      if (!z.struck && now >= z.actAt + (big ? ZOMBIE.bigImpact : ZOMBIE.impact)) {
        z.struck = true;
        if (big) {
          // The pound: everyone close round it, less at the edge.
          for (const p of targets) {
            const d = Math.hypot(p.x - z.x, p.z - z.z);
            if (d <= ZOMBIE.bigReach && level(p)) this.hurt(p, z, Math.round(z.damage * (1 - (0.5 * d) / ZOMBIE.bigReach)), now, ev);
          }
        } else if (tgt && td <= ZOMBIE.reach && level(tgt)) this.hurt(tgt, z, z.damage, now, ev);
      }
      if (now >= z.until) z.act = 'walk';
      return;
    }
    if (tgt && td <= (big ? ZOMBIE.bigFrom : ZOMBIE.attackFrom) && now >= z.next && level(tgt)) {
      Object.assign(z, { act: 'attack', actAt: now, until: now + (big ? ZOMBIE.bigAttackMs : ZOMBIE.attackMs), struck: false, next: now + (big ? ZOMBIE.bigEvery : ZOMBIE.swipeEvery), speed: 0 });
      return;
    }
    // Where to: straight at the player close by in a clear line, else downhill on the field, else
    // towards them (or the house) as the crow flies.
    let gx = this.home.x;
    let gz = this.home.z;
    const step = this.nav.next(z.x, z.z);
    if (tgt && td < ZOMBIE.straight && this.nav.clear(z.x, z.z, tgt.x, tgt.z)) [gx, gz] = [tgt.x, tgt.z];
    else if (step) [gx, gz] = [step.x, step.z];
    else if (tgt) [gx, gz] = [tgt.x, tgt.z];
    const stop = tgt && td < (big ? ZOMBIE.bigFrom * 0.85 : ZOMBIE.attackFrom * 0.8);
    const want = Math.hypot(gx - z.x, gz - z.z) > 0.05 ? Math.atan2(gx - z.x, gz - z.z) : z.yaw;
    z.yaw = turn(z.yaw, want, (big ? 1.6 : 3.2) * dt);
    // Slower while still turning round: it shuffles round, rather than sliding sideways.
    const facing = Math.max(0, Math.cos(wrap(want - z.yaw)));
    const speed = stop ? 0 : z.top * (0.3 + 0.7 * facing);
    const vx = Math.sin(z.yaw) * speed + push.x;
    const vz = Math.cos(z.yaw) * speed + push.z;
    const nx = z.x + vx * dt;
    const nz = z.z + vz * dt;
    const bx = z.x;
    const bz = z.z;
    if (this.nav.walkable(nx, nz)) [z.x, z.z] = [nx, nz];
    else if (this.nav.walkable(nx, z.z)) z.x = nx;
    else if (this.nav.walkable(z.x, nz)) z.z = nz;
    z.speed = Math.hypot(z.x - bx, z.z - bz) / Math.max(dt, 1e-3);
  }

  /** A swipe or a pound lands on player `p` (unless they were hit a moment ago, or are just back). */
  hurt(p, z, damage, now, ev) {
    if (p.safe || damage <= 0 || now < (this.shielded[p.name] ?? 0)) return;
    this.shielded[p.name] = now + ZOMBIE.shield;
    ev.push({ type: 'swipe', id: z.id, name: p.name, damage });
  }

  /**
   * Zombie `id` takes `amount` of health from `by`: 'down' when that beat it (it counts for them),
   * 'hurt' when it took it (it staggers; the big one only from a heavy hit), null when it was down
   * already or there is no such zombie.
   */
  hit(id, amount, by, now) {
    const z = this.zombies.get(id);
    if (!z || z.act === 'down' || !(amount > 0)) return null;
    z.hp = Math.max(0, z.hp - amount);
    if (z.hp <= 0) {
      Object.assign(z, { act: 'down', downAt: now, speed: 0 });
      this.beaten[by] = (this.beaten[by] ?? 0) + 1;
      return 'down';
    }
    if (z.kind !== BIG || amount >= 60) Object.assign(z, { act: 'hurt', actAt: now, until: now + ZOMBIE.hurtMs, struck: true });
    return 'hurt';
  }

  /** A blast at (x, z): every zombie up within `radius` (plus its size) takes `amount`, less at the edge. Returns [id, result] for each one hit. */
  blast(x, z, radius, amount, by, now) {
    const out = [];
    for (const q of [...this.zombies.values()]) {
      if (q.act === 'down') continue;
      const r = radius + (q.kind === BIG ? ZOMBIE.bigRadius : ZOMBIE.radius);
      const d = Math.hypot(q.x - x, q.z - z);
      if (d >= r) continue;
      const res = this.hit(q.id, Math.round(amount * (1 - (0.5 * d) / r)), by, now);
      if (res) out.push([q.id, res]);
    }
    return out;
  }
}

/** An angle between -pi and pi. */
function wrap(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** From `a` towards `b` by at most `max` radians, the short way round. */
function turn(a, b, max) {
  const d = wrap(b - a);
  return wrap(a + Math.max(-max, Math.min(max, d)));
}
