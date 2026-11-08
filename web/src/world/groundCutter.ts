import type { Prism } from './houseData';
import { cutAsks, cutCovers, Cuts, groundLayers, packAsks, packCovers, setCoverCuts, type CoverAsk, type CoverGrid, type CutAsk, type GroundLayers } from './groundLayers';
import { coverAsk } from './houseMeshes';
import { terrain } from './terrain';

/**
 * The village's ground cuts (world/groundLayers.ts) worked out in a worker of their own (world/groundWorker.ts), on
 * another core, while the page goes on building: about a second and a half of the phone's loading before play
 * (Yoshi's review, 8 Nov 2026: click to play had grown 1 to 2 s slower on a phone). The worker has a copy of the
 * page's claims, sent in runs as they are made, and cuts with the claims made up to each ask, as the page would have
 * then: the same pieces, to the last digit. Without a worker (a browser that can't, or one that fails) each ask is cut
 * on the page, as before.
 */
export class GroundCutter {
  private worker: Worker | null = null;
  /** Claims sent to the worker so far */
  private sent = 0;
  private id = 0;
  private waiting = new Map<number, { resolve: (d: { out: Float64Array; starts?: Float64Array }) => void; work: () => { out: Float64Array; starts?: Float64Array } }>();

  constructor(private layers: GroundLayers = groundLayers) {
    try {
      this.worker = new Worker(new URL('./groundWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; out: Float64Array; starts?: Float64Array }>) => {
        const job = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        job?.resolve(e.data);
      };
      this.worker.onerror = () => this.fail();
    } catch {
      this.worker = null;
    }
  }

  /** Cut each polygon, in order, with every claim made up to now: their outcomes, read in the same order. */
  cut(asks: CutAsk[]): Promise<Cuts> {
    return this.cutPacked(packAsks(asks));
  }

  /** The same for polygons already packed (world/groundLayers.ts packAsks): many of them, without an object for each. */
  cutPacked(packed: Float64Array): Promise<Cuts> {
    return this.ask({ asks: packed }, () => ({ out: cutAsks(this.layers, packed) })).then((d) => new Cuts(d.out));
  }

  /**
   * Cut the draped covers' pieces (world/houseMeshes.ts drapedGeometry), each its own outcomes, with every claim made
   * up to now.
   */
  covers(covers: CoverAsk[], grid: CoverGrid): Promise<Cuts[]> {
    const packed = packCovers(covers, grid);
    return this.ask({ covers: packed }, () => cutCovers(this.layers, packed)).then(({ out, starts }) =>
      covers.map((_, i) => new Cuts(out, starts![i], i + 1 < covers.length ? starts![i + 1] : out.length)),
    );
  }

  /**
   * The cuts of the draped covers among `prisms` (a tile's), worked out ahead and given to them (world/groundLayers.ts
   * setCoverCuts): resolves once their build (world/houseMeshes.ts drapedGeometry) can read them instead of cutting.
   */
  coversOf(prisms: Prism[]): Promise<void> {
    const asks = prisms.flatMap((p) => {
      const ask = coverAsk(p);
      return ask ? [{ p, ask }] : [];
    });
    if (!asks.length) return Promise.resolve();
    return this.covers(asks.map((a) => a.ask), terrain).then((cuts) => cuts.forEach((c, i) => setCoverCuts(asks[i].p, c)));
  }

  /** Let the worker go (its copy of the claims with it). */
  close(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private ask(message: { asks?: Float64Array; covers?: Float64Array }, work: () => { out: Float64Array; starts?: Float64Array }): Promise<{ out: Float64Array; starts?: Float64Array }> {
    // On the page, at once, with the claims made up to now: as the worker would.
    if (!this.worker) return Promise.resolve(work());
    const claims = this.layers.claimsFrom(this.sent);
    this.sent = this.layers.size;
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve, work });
      this.worker!.postMessage({ id, claims, ...message }, [claims.pts.buffer, claims.ranks.buffer, claims.groupOf.buffer, claims.planes.buffer, claims.own.buffer]);
    });
  }

  /**
   * The worker failed: what it still had to cut is cut on the page, with the claims made since (none after the last
   * asks, the streets' and the covers'; and a model's surfaces give way only to the models', which come before).
   */
  private fail(): void {
    this.close();
    for (const [id, job] of this.waiting) {
      this.waiting.delete(id);
      job.resolve(job.work());
    }
  }
}

