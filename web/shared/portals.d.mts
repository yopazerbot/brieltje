export interface Portal {
  id: string;
  /** What the portal and its label are called */
  name: string;
  /** The village it is in, under the name when you arrive */
  sub: string;
  color: string;
  /** More words that find it in the chat */
  words: string[];
  /** In the village of Smetlede (src/data/village.json, loaded after the start screen) */
  village?: boolean;
  x: number;
  z: number;
  /** Which way its face looks (the game's yaw) */
  yaw: number;
  /** Where you come out on foot: x, z, yaw */
  out: [number, number, number];
  /** Where a car comes out: x, z, yaw */
  car: [number, number, number];
}

export const REACH: number;
export const CAR_REACH: number;
export const CAR_SLOW: number;
export const PORTALS: Portal[];
export function findPortal(word: string): Portal | null;
export function portalNear(x: number, z: number, reach?: number): Portal | null;
