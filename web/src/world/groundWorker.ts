/**
 * The ground's cutting worker (world/groundCutter.ts): a copy of the page's claims (world/groundLayers.ts), sent to it in
 * runs, and the cuts the page asks for, worked out here while the page builds the rest. Numbers only, in and out.
 */
import { cutAsks, cutCovers, GroundLayers, type Claims } from './groundLayers';

interface Ask {
  id: number;
  claims?: Claims;
  asks?: Float64Array;
  covers?: Float64Array;
}

const layers = new GroundLayers();
const post = (message: unknown, transfer: Transferable[]) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);

self.onmessage = (e: MessageEvent<Ask>) => {
  const m = e.data;
  if (m.claims) layers.addClaims(m.claims);
  if (m.asks) {
    const out = cutAsks(layers, m.asks);
    post({ id: m.id, out }, [out.buffer]);
  } else if (m.covers) {
    const { out, starts } = cutCovers(layers, m.covers);
    post({ id: m.id, out, starts }, [out.buffer, starts.buffer]);
  }
};
