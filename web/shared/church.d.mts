import type { Prism } from '../src/world/houseData';
import type { Area } from './zombies.mjs';
export interface Church {
  prisms: Prism[];
  area: Area;
  point(p: number[]): { x: number; y: number; z: number };
  anchors: { entry: { x: number; y: number; z: number }; roof: { x: number; y: number; z: number };
    stairs: { x: number; y: number; z: number }[] };
}
export function makeChurch(data: unknown, ground: number): Church;
export function churchPrisms(prisms: Prism[], church: Church): Prism[];
