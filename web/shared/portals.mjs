/**
 * The portals round the map (Yoshi, 31 Oct 2026: the map got big): stand on a portal's pad, or
 * stop the car on it, and pick another to go there. The game draws them and the server checks
 * every trip. Positions are the model's (m); a yaw is the game's (0 looks along -z).
 *
 * Each portal: where it stands (x, z) and which way its face looks (yaw), where you come out on
 * foot (`out`, standing in front of it and looking at the place) and in a car (`car`, on the road
 * or a parking spot), its colour, and the words that find it in the chat (/church, /kerk ...).
 */

/** m from a portal's middle: standing on its pad */
export const REACH = 2.2;
/** m from a portal's middle to a car's middle, and the car must be nearly stopped: driving over it at speed does nothing */
export const CAR_REACH = 3.4;
export const CAR_SLOW = 3; // m/s

export const PORTALS = [
  {
    id: 'house', name: "Yoshi & Liesl's home", sub: 'Briel', color: '#4fc3f7', words: ['home', 'huis', 'thuis', 'main', 'briel', 'hoofdwoning', 'woning', 'yoshi', 'liesl'],
    x: -1.5, z: 24, yaw: -0.294, out: [-0.46, 20.5, -0.5], car: [12, 19.6, Math.PI / 2],
  },
  {
    id: 'bungalow', name: 'Bungalow', sub: 'Briel', color: '#ffb74d', words: ['bungalo', 'neighbours'],
    x: 100, z: 172.5, yaw: 2.448, out: [97.6, 175.4, 2.437], car: [90, 172.5, -2.256],
  },
  {
    id: 'church', name: 'Church', sub: 'Smetlede', color: '#b388ff', words: ['kerk', 'square', 'kerkplein', 'dorp', 'smetlede'], village: true,
    x: 538, z: -775, yaw: 2.634, out: [536.3, -771.6, 2.634], car: [528, -778, 1.75],
  },
  {
    id: 'school', name: 'School', sub: 'Smetlede', color: '#69f0ae', words: ['playground', 'speelplaats', 'basisschool'], village: true,
    x: 463.5, z: -809, yaw: -0.524, out: [465.2, -812, -0.524], car: [462, -786, 1.44],
  },
  {
    id: 'molenhoek', name: 'Molenhoek', sub: 'Smetlede', color: '#ff8a80', words: ['molen', 'mill'], village: true,
    x: 758, z: -709.5, yaw: -0.197, out: [758.9, -714.4, 1.373], car: [745, -720.5, 1.373],
  },
];

/** The portal a word in the chat names: its id or one of its words, else the first whose name starts with it. */
export function findPortal(word) {
  const w = String(word).toLowerCase();
  if (!w) return null;
  return PORTALS.find((p) => p.id === w || p.words.includes(w))
    ?? (w.length >= 2 ? PORTALS.find((p) => [p.id, ...p.words].some((k) => k.startsWith(w))) : undefined)
    ?? null;
}

/** The portal whose middle is within `reach` of (x, z), the nearest if more, or null. */
export function portalNear(x, z, reach = REACH) {
  let best = null;
  let bestD = reach;
  for (const p of PORTALS) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}
