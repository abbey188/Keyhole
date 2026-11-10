import { bytesToHex, sig } from "@keyhole/crypto";
import { FakeChain } from "@keyhole/chain";
import { MemoryStore, NodeError, StorageNode } from "@keyhole/node";
import { NodeCallError } from "../src/index.js";
import type { NodeApi } from "../src/index.js";

export const seed = (n: number) => new Uint8Array(32).fill(n);
export const pkHex = (n: number) => bytesToHex(sig.publicKey(seed(n)));
export const OWNER = "alice.testnet";
export const OWNER_SEED = seed(30);
export const BOX = "b1".repeat(16);

/** In-process adaptor: a StorageNode behind the NodeApi interface. */
export class LocalNodeApi implements NodeApi {
  constructor(readonly name: string, readonly node: StorageNode, readonly store: MemoryStore) {}
  private async w<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof NodeError) throw new NodeCallError(e.status, e.code);
      throw e;
    }
  }
  putLeaf(a: Parameters<NodeApi["putLeaf"]>[0]) {
    return this.w(() => this.node.putLeaf(a));
  }
  ack(blobId: string) {
    return this.w(() => this.node.ack(blobId));
  }
  getLeaves(a: Parameters<NodeApi["getLeaves"]>[0]) {
    return this.w(() => this.node.getLeaves({ ticket: a.ticket, blobId: a.blobId, from: a.from, to: a.to }));
  }
}

/** N nodes, threshold T, an owner with a box. */
export async function cluster(n = 3, t = 2) {
  const chain = new FakeChain({ nodeKeys: Array.from({ length: n }, (_, i) => pkHex(1 + i)), threshold: t, rsKeys: [pkHex(2 + n)] });
  chain.addFullAccessKey(OWNER, pkHex(30));
  const owner = chain.writer(OWNER);
  await owner.createBox({ boxId: BOX, kind: "Bound", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
  const apis = Array.from({ length: n }, (_, i) => {
    const store = new MemoryStore();
    return new LocalNodeApi(`node${i}`, new StorageNode({ reader: chain, store, idx: i, seed: seed(1 + i) }), store);
  });
  return { chain, owner, apis };
}

export function stream(leaves: number, salt = 1): Uint8Array {
  const b = new Uint8Array(leaves * 65536);
  for (let i = 0; i < b.length; i += 13) b[i] = (i * 7 + salt) & 0xff;
  for (let l = 0; l < leaves; l++) b[l * 65536] = l;
  return b;
}
