// Types for brookSpirit.mjs (the Brook Spirit's fight, shared with the server), its data (brookSpirit.json) and its
// messages. Distances in metres, model coordinates (x, z; y the game's heights), times in seconds in the data.

/** A spot in the game's heights. */
export interface Spot3 {
  x: number;
  y: number;
  z: number;
}

/** shared/brookSpirit.json: every number of the fight and its place. */
export interface SpiritData {
  /** The grove's middle (y its ground), its radius, the leash (past it nobody is a fighter) and the wake radius */
  grove: { x: number; z: number; y: number; r: number; leash: number; wakeR: number };
  /** How high the heart floats over the ground at the rest and at the hover points */
  up: number;
  /** Where it sleeps and mends, over the brook (y its ground); `links`: the hover points it drifts to from there */
  rest: { x: number; z: number; y: number; links: number[] };
  /** The hover points [x, z, ground]; the 6th (index 5) is on the far bank, reached only by sinking and rising */
  hover: [number, number, number][];
  /** Pairs of hover points it drifts between: lines clear of every trunk by `trunks.clear` */
  links: [number, number][];
  /** The lights' anchor trees ([x, z, foot]) and how high over the foot each light hangs */
  lights: { tree: [number, number, number]; up: number }[];
  /** How far each light hangs from its trunk, towards the grove's middle */
  lightOff: number;
  /** Where a fighter it downed comes back (on the lane) */
  wake: { x: number; z: number; y: number };
  /** The sign on the lane's verge; `yaw` as the game's (atan2(dx, dz)): facing +x, the lane */
  sign: { x: number; z: number; y: number; yaw: number };
  /** The trunks' radius, how clear a drift's line keeps of them, how far from the middle the caller passes them */
  trunks: { r: number; clear: number; reach: number };
  /** Full health: `base` for one fighter, `per` more for each further one counted, at most `most` counted */
  health: { base: number; per: number; most: number };
  /** By phase (1 to 3): health's marks (the shells), attacks before a window, window and pause (s), sink after every nth window (0 never) */
  phases: { marks: number[]; attacks: number[]; window: number[]; pause: number[]; sinkEvery: number[] };
  /** s between two attacks, and after a drift or a rise */
  gap: number;
  /** m/s along a link */
  drift: number;
  /**
   * The most a window (and mending) may take: `window` health for one fighter, `per` more for each further one counted
   * (slower than full health grows: it stops crowds and sharpshooters); the stun after a burst `stun` times that; s the
   * heart still takes hits after a window
   */
  cap: { window: number; per: number; stun: number; grace: number };
  /**
   * By shell (the first, the second): lights lit, each light's health for one fighter, and more for each further one
   * counted; s of the stun after a burst; s the shell takes to fade
   */
  shell: { lights: number[]; lightHp: number[]; lightPer: number[]; stun: number; fade: number };
  /**
   * s sinking, s gone, s the rise's tell; no fighter within `clear` m of where it rises, unless every point has one:
   * then after `wait` s more under it rises where they are farthest
   */
  sink: { down: number; gone: number; rise: number; clear: number; wait: number };
  /** Mending: after `noFighter` s without one or `noDamage` s unhurt (outside a shell); `rate` of full health a second; reset after `reset` s alone; the heart's openness */
  mend: { noFighter: number; noDamage: number; rate: number; reset: number; open: number };
  attacks: {
    /** The nearest within `range`: a strip `length` long, `half` either side, `high` up or down; tell and damage by phase */
    sweep: { range: number; length: number; half: number; high: number; tell: number[]; damage: number[] };
    /** At one it sees from `min` to `max` m; flies `speed` m/s plus `extra` s; `damage` in the middle of `radius`, 30 % at its edge; volleys by phase */
    bolt: { min: number; max: number; tell: number[]; speed: number; extra: number; radius: number; high: number; damage: number; volley: number[] };
    /** From `phase` on, by `chance` instead of a bolt: a pool of `radius` for `last` s, `most` at once, `damage` every `every` s inside */
    pools: { phase: number; chance: number; tell: number; radius: number; last: number; most: number; damage: number; every: number };
  };
  /** A downed fighter comes back after `back` s at the wake spot, when it downed them in the last `memory` s */
  down: { back: number; memory: number };
  /** Beaten: s coming apart, s before it gathers again, at most this many names in the message */
  beaten: { apart: number; back: number; names: number };
  /** The heart's hit box radius, the farthest a shot at a part counts from, the most one hit may count, a blast's largest radius */
  heart: { r: number; range: number; most: number; blast: number };
  /** The look: s the heart takes to open, anger by phase, anger more during a tell, s of a hit's pulse */
  look: { open: number; anger: number[]; tell: number; hurt: number };
  /** `sp` goes to pages within `near` m, `hz` times a second while awake */
  wire: { near: number; hz: number };
  /** The launcher it leaves: s it lies, s only those who hurt it may take it, grenades, s it lies when its holder goes down, s kept for a dropped connection, the take's box */
  launcher: { lie: number; first: number; rounds: number; dropLie: number; lost: number; across: number; high: number };
}

export type SpiritMode = 'asleep' | 'fight' | 'mend' | 'apart' | 'gone';
export type SpiritAct = 'idle' | 'drift' | 'sweep' | 'bolt' | 'pool' | 'open' | 'pause' | 'sink' | 'under' | 'rise' | 'stun';

/** Who may fight it now (alive, armed, on foot, not flying, not in a drop, past spawn protection): the server's positions. */
export interface SpiritFighter {
  name: string;
  x: number;
  y: number;
  z: number;
}

/** A trunk as a circle. */
export interface SpiritTrunk {
  x: number;
  z: number;
  r: number;
}

export interface SpiritLight extends Spot3 {
  hp: number;
  lit: boolean;
  /** Lit once in this fight: it never lights again */
  used: boolean;
}

/** The simulation's state (newSpirit): read it, change it only through the functions. Times in ms. */
export interface SpiritState {
  d: SpiritData;
  lights: SpiritLight[];
  /** The last time a step or a hit was given */
  now: number;
  mode: SpiritMode;
  act: SpiritAct;
  since: number;
  until: number;
  phase: 1 | 2 | 3;
  hp: number;
  max: number;
  x: number;
  y: number;
  z: number;
  /** Where it looks, or where the tell in progress lands */
  tx: number;
  tz: number;
  /** The node it is at (REST, or a hover point), null while drifting between two */
  node: number | null;
  path: number[];
  riseTo: number | null;
  /** The fighters counted in this fight (full health follows them, only upwards) */
  seen: Set<string>;
  /** Health taken by each fighter in this fight */
  hurt: Map<string, number>;
  /** The fighters of the last step: only they hurt it */
  near: Set<string>;
  left: number;
  windows: number;
  volley: number;
  target: string | null;
  aim: { x: number; y: number; z: number; fx?: number; fz?: number } | null;
  /** Health the open window (or stun, or mending) may still take */
  budget: number;
  graceUntil: number;
  /** The shell up now (0 the first, 1 the second), or null */
  shell: number | null;
  shells: number;
  /** The anchors each shell lights, drawn on waking */
  draw: number[][];
  bolts: (Spot3 & { at: number })[];
  pools: (Spot3 & { from: number; until: number })[];
  poolTick: number;
  lastFighter: number;
  lastDamage: number;
  hurtAt: number;
  woke: number;
}

/** What a step or a hit made happen. `ms`: how long until it lands or ends. */
export type SpiritEvent =
  | { type: 'wake' }
  | { type: 'tell'; kind: 'sweep'; target: string; x: number; z: number; fx: number; fz: number; ms: number }
  | { type: 'tell'; kind: 'bolt' | 'pool'; target: string; x: number; z: number; ms: number }
  /** A fighter hurt: the caller takes `damage` off their health (by 'the brook spirit'), from (x, z) */
  | { type: 'hit'; name: string; damage: number; kind: 'sweep' | 'bolt' | 'pool'; x: number; z: number }
  | { type: 'sweep'; from: { x: number; z: number }; to: { x: number; z: number }; hits: string[] }
  | { type: 'bolt'; from: Spot3; to: Spot3; ms: number }
  | { type: 'pool'; x: number; z: number; ms: number }
  | { type: 'open'; ms: number }
  | { type: 'close' }
  /** The window took its share: the heart folds */
  | { type: 'cap' }
  | { type: 'shell'; lights: number[] }
  /** Light `i` (part i + 1) lit */
  | { type: 'light'; i: number }
  /** Light `i` shot out */
  | { type: 'out'; i: number }
  | { type: 'burst'; ms: number }
  | { type: 'phase'; phase: number }
  | { type: 'sink'; x: number; z: number }
  /** `forced`: every point had a fighter close by, so after waiting it rose where they were farthest */
  | { type: 'rise'; x: number; z: number; ms: number; forced?: boolean }
  | { type: 'mend' }
  | { type: 'reset' }
  /** `names`: at most beaten.names, most damage first; `by`: all who hurt it (the launcher's first claim); `drop`: the hover point nearest */
  | { type: 'beaten'; names: string[]; by: string[]; drop: Spot3 }
  | { type: 'back' };

/** What a hit counted: health taken (0 when nothing), why not ('bad', 'mode', 'who', 'shut', 'out', 'cap'), what followed. */
export interface SpiritHurt {
  dealt: number;
  why?: 'bad' | 'mode' | 'who' | 'shut' | 'out' | 'cap';
  events: SpiritEvent[];
}

/** One `sp` state as a view, live (spiritView) or from the wire (readSpirit). `ms`: left of the act at time `at`. */
export interface SpiritView {
  mode: SpiritMode;
  phase: number;
  /** 0 to 1 of full health */
  hp: number;
  x: number;
  y: number;
  z: number;
  act: SpiritAct;
  ms: number;
  at: number;
  tx: number;
  tz: number;
  /** Lit lights: bit i is light i (part i + 1) */
  lights: number;
  pools: { x: number; z: number; ms: number }[];
  /** When the last counted heart hit landed (-Infinity: none known) */
  hurtAt: number;
}

/** What the look draws (world/brookSpirit.ts). */
export interface SpiritLook {
  x: number;
  y: number;
  z: number;
  facing: number;
  /** 0 folded to 1 open */
  open: number;
  /** 1 the shell shut */
  shield: number;
  anger: number;
  /** Where the sweep's strip ends or the bolt lands, during their tells */
  reach: { x: number; z: number } | null;
  /** 0 there, 1 gone */
  fade: number;
  /** The pulse of a counted heart hit, 1 down to 0 */
  hurt: number;
}

// ---- The messages. Pages check what they receive; the server checks what it receives.

/** `sp` and `welcome.spirit.s`: [mode, phase, health 0-1000, x, y, z, act, ms, tx, tz, lit lights' mask] (MODES, ACTS) */
export type SpiritWireState = [number, number, number, number, number, number, number, number, number, number, number];
/** A pool: [x, z, ms left] */
export type SpiritWirePool = [number, number, number];
export interface SpiritWire {
  s: SpiritWireState;
  p?: SpiritWirePool[];
}

/** Page to server: hits on the spirit's parts by gun `w`, up to 3 pairs [part, hits] (part 0 the heart, 1 to 8 a light). */
export interface SphitMsg {
  t: 'sphit';
  w: string;
  h: [number, number][];
}

/** Page to server: the launcher's holder fires, from (x, y, z) at (vx, vy, vz). */
export interface GlMsg {
  t: 'gl';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** The launcher as it is now: lying at (x, y, z) for `ms` more, or held by `name`; `n` grenades. */
export type SpiritLauncherWire = { x: number; y: number; z: number; n: number; ms: number } | { name: string; n: number } | null;

/** Server to page, unchecked as it arrives: readSpirit checks `s` and `p`; the others are checked where they are used. */
export type SpiritMsg =
  | { t: 'sp'; s: unknown; p?: unknown }
  | { t: 'spe'; e: 'bolt'; from: Spot3; to: Spot3; ms: number }
  | { t: 'spe'; e: 'sweep'; from?: { x: number; z: number }; to?: { x: number; z: number } }
  | { t: 'spe'; e: 'light'; i: number }
  | { t: 'spe'; e: 'cap' | 'burst' | 'back' }
  /** `names`: at most 8, for textContent only */
  | { t: 'spe'; e: 'beaten'; names: string[] }
  | { t: 'sgl'; e: 'drop'; x: number; y: number; z: number; n: number; ms: number }
  | { t: 'sgl'; e: 'taken'; name: string; n: number }
  /** To the holder alone */
  | { t: 'sgl'; e: 'left'; n: number }
  | { t: 'sgl'; e: 'gone' };

/** `welcome.spirit`: the spirit (as `sp`), and the launcher. Unchecked as it arrives. */
export interface SpiritWelcome {
  s: unknown;
  p?: unknown;
  gl?: unknown;
}

export const MODES: SpiritMode[];
export const ACTS: SpiritAct[];
/** The rest's node in the hover points' graph */
export const REST: -1;

export function lightsOf(data: SpiritData): Spot3[];
/** The most one window may take now, for the fighters counted. */
export function windowCap(s: SpiritState): number;
export function clearLine(ax: number, az: number, bx: number, bz: number, trunks: SpiritTrunk[]): boolean;
export function newSpirit(data: SpiritData): SpiritState;
/** One step: `now` ms, `dt` s, `rand` the dice. Returns what happened; the caller applies the hits. */
export function stepSpirit(s: SpiritState, fighters: SpiritFighter[], now: number, dt: number, rand?: () => number, trunks?: SpiritTrunk[]): SpiritEvent[];
export function hurtSpirit(s: SpiritState, who: unknown, part: unknown, damage: unknown, now: unknown): SpiritHurt;
export function blastSpirit(s: SpiritState, x: unknown, y: unknown, z: unknown, radius: unknown, damage: unknown, who: unknown, now: unknown): SpiritHurt & { parts: [number, number][] };
/** Part `part`'s spot while it takes hits now (the heart open, the light lit), else null. */
export function spiritPart(s: SpiritState, part: number, now?: number): Spot3 | null;
export function spiritWire(s: SpiritState, now?: number): SpiritWire;
export function readSpirit(m: unknown, now?: number): SpiritView | null;
export function spiritView(s: SpiritState, now?: number): SpiritView;
export function actLength(data: SpiritData, v: Pick<SpiritView, 'mode' | 'act' | 'phase'>): number;
export function spiritLook(v: SpiritView, now: number, data: SpiritData): SpiritLook;
