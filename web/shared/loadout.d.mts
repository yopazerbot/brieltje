// Types for loadout.mjs (the weapons a player chooses to start with, shared with the server).

export const LOADOUT: {
  /** The guns that can be chosen, in the picker's order */
  choices: string[];
  /** How many of them at most */
  most: number;
  /** What a player gets who never chose */
  first: string[];
};

export function cleanPick(list: unknown): string[];
export function startingWeapons(pick: unknown, extra?: string[], zombies?: boolean): string[];
