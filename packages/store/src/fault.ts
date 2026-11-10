// TEST TOOL (spec 10 section 4: fault injection harness). Wraps a NodeApi and injects failures with seeded
// randomness so runs are reproducible. Not used in production paths.
import type { LeafWithProof, NodeApi } from "./api.js";
import { NodeCallError } from "./api.js";

export interface FaultPlan {
  /** Hard down: every call fails with a network error. */
  down?: boolean;
  /** Probability a call fails with a network error. */
  dropRate?: number;
  /** Probability a returned leaf has one flipped bit. */
  corruptRate?: number;
  /** Probability a read returns fewer leaves than asked. */
  truncateRate?: number;
  /** Extra latency per call (ms). */
  delayMs?: number;
}

/** mulberry32: small seeded PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FaultyNode implements NodeApi {
  readonly plan: FaultPlan;
  private readonly rnd: () => number;
  calls = 0;

  constructor(private readonly inner: NodeApi, seed: number, plan: FaultPlan = {}) {
    this.plan = plan;
    this.rnd = prng(seed);
  }
  get name() {
    return this.inner.name;
  }

  private async gate(): Promise<void> {
    this.calls++;
    if (this.plan.delayMs) await new Promise((r) => setTimeout(r, this.plan.delayMs));
    if (this.plan.down || this.rnd() < (this.plan.dropRate ?? 0)) throw new NodeCallError(0, "network");
  }

  async putLeaf(a: Parameters<NodeApi["putLeaf"]>[0]) {
    await this.gate();
    return this.inner.putLeaf(a);
  }
  async ack(blobId: string) {
    await this.gate();
    return this.inner.ack(blobId);
  }
  async getLeaves(a: Parameters<NodeApi["getLeaves"]>[0]): Promise<LeafWithProof[]> {
    await this.gate();
    let out = await this.inner.getLeaves(a);
    if (this.rnd() < (this.plan.truncateRate ?? 0)) out = out.slice(0, Math.max(0, out.length - 1));
    return out.map((l) => {
      if (this.rnd() >= (this.plan.corruptRate ?? 0)) return l;
      const piece = l.piece.slice();
      const at = Math.floor(this.rnd() * piece.length);
      piece[at] = (piece[at] as number) ^ (1 << Math.floor(this.rnd() * 8));
      return { ...l, piece };
    });
  }
}
