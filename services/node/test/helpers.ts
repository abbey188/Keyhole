import { bytesToHex, merkle, msgs, sig } from "@keyhole/crypto";
import { FakeChain } from "@keyhole/chain";
import type { ChainWriter } from "@keyhole/chain";

export const seed = (n: number) => new Uint8Array(32).fill(n);
export const pkHex = (n: number) => bytesToHex(sig.publicKey(seed(n)));
export const hexN = (n: number, len: number) => bytesToHex(new Uint8Array(len).fill(n));

export const NODE_SEED = seed(1);
export const RS_SEED = seed(2);
export const OWNER_SEED = seed(3);
export const OWNER = "alice.testnet";
export const BOX = hexN(0xb1, 16);

export interface TestBlob {
  blobId: string;
  root: string;
  size: number;
  pieces: Uint8Array[];
  proofs: Uint8Array[][];
}

/** Deterministic pseudo-ciphertext of `n` full leaves (the node never looks inside). */
export function makeBlob(n: number, salt = 0): TestBlob {
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const p = new Uint8Array(merkle.LEAF_SIZE);
    for (let j = 0; j < p.length; j += 97) p[j] = (i * 31 + j + salt) & 0xff;
    p[0] = i & 0xff;
    p[1] = salt & 0xff;
    pieces.push(p);
  }
  const hashes = pieces.map(merkle.leafHash);
  const root = merkle.root(hashes);
  const size = n * merkle.LEAF_SIZE;
  return {
    blobId: bytesToHex(merkle.blobId(root, size, merkle.LEAF_SIZE, 1)),
    root: bytesToHex(root),
    size,
    pieces,
    proofs: pieces.map((_, i) => merkle.auditPath(hashes, i)),
  };
}

export function newChain(): { chain: FakeChain; owner: ChainWriter } {
  const chain = new FakeChain({ nodeKeys: [pkHex(1)], rsKeys: [pkHex(2)] });
  chain.addFullAccessKey(OWNER, pkHex(3));
  return { chain, owner: chain.writer(OWNER) };
}

export async function makeBox(owner: ChainWriter): Promise<void> {
  await owner.createBox({ boxId: BOX, kind: "Bound", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
}

export async function registerBlob(owner: ChainWriter, b: TestBlob): Promise<void> {
  await owner.registerBlob({ blobId: b.blobId, boxId: BOX, size: b.size, days: 1 });
}

/** Opens a bearer grant and a session on the fake chain; returns ids. */
export async function openSession(chain: FakeChain, owner: ChainWriter, n = 7) {
  const reqSeed = seed(40 + n);
  const grantId = hexN(0xa0 + n, 16);
  const sessionId = hexN(0x50 + n, 16);
  const sessionPk = hexN(0x70 + n, 32);
  await owner.createGrant({
    grantId, boxId: BOX, requester: { bearer: pkHex(40 + n) }, mode: "View", notBeforeMs: chain.now(), notAfterMs: chain.now() + 600_000,
    maxSessions: 3, scopeHash: hexN(1, 32), policyHash: hexN(2, 32),
  });
  const ts = chain.now();
  const reqSig = bytesToHex(sig.sign(reqSeed, msgs.openMsg("testnet", "keyhole.testnet", Buffer.from(grantId, "hex"), Buffer.from(sessionId, "hex"), Buffer.from(sessionPk, "hex"), ts)));
  await chain.writer("rl.testnet").openSession({ grantId, sessionId, sessionPk, tsMs: ts, reqSig });
  return { grantId, sessionId, sessionPk, reqSeed };
}
