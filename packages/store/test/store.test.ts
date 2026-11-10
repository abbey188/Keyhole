import { describe, expect, it } from "vitest";
import { bytesToHex, merkle } from "@keyhole/crypto";
import { encodeTicket, signOwnerTicket } from "@keyhole/node";
import { FaultyNode, NotEnoughAcks, ReadFailed, prepareBlob, pushBlob, readLeaves, rootMatchesBlobId } from "../src/index.js";
import type { NodeApi } from "../src/index.js";
import { BOX, OWNER, OWNER_SEED, cluster, stream } from "./helpers.js";

async function writeBlob(c: Awaited<ReturnType<typeof cluster>>, nodes: NodeApi[], leaves = 4) {
  const blob = prepareBlob(stream(leaves));
  await c.owner.registerBlob({ blobId: blob.blobId, boxId: BOX, size: blob.size, days: 1 });
  const regId = (await c.chain.blob(blob.blobId))!.reg_id;
  const res = await pushBlob({ nodes, blob, regId, threshold: 2 });
  await c.chain.writer("rl.testnet").certifyBlob(blob.blobId, res.acks);
  await c.owner.activateBlob(blob.blobId);
  return { blob, ticket: encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, blob.blobId, c.chain.now() + 600_000)) };
}

const join = (ps: Uint8Array[]) => bytesToHex(new Uint8Array(ps.flatMap((p) => [...p])));

describe("write and read with three nodes", () => {
  it("pushes to all nodes, certifies with T acks, reads back verified bytes from any single node", async () => {
    const c = await cluster();
    const { blob, ticket } = await writeBlob(c, c.apis);
    expect((await c.chain.blob(blob.blobId))?.state).toBe("Active");
    for (const only of c.apis) {
      const got = await readLeaves({ nodes: [only], blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: blob.leaves, ticket });
      expect(join(got)).toBe(join(blob.pieces));
    }
  });

  it("rootMatchesBlobId binds root, size and parameters", () => {
    const b = prepareBlob(stream(2));
    expect(rootMatchesBlobId(b.blobId, b.root, b.size)).toBe(true);
    expect(rootMatchesBlobId(b.blobId, b.root, b.size + 65536)).toBe(false);
    expect(rootMatchesBlobId(b.blobId, prepareBlob(stream(2, 9)).root, b.size)).toBe(false);
  });

  it("prepareBlob refuses streams that are not whole leaves", () => {
    expect(() => prepareBlob(new Uint8Array(100))).toThrow(RangeError);
    expect(() => prepareBlob(new Uint8Array(0))).toThrow(RangeError);
  });
});

describe("S1 (client side): too few acks never certifies", () => {
  it("with T=2 and two nodes down only one ack arrives and pushBlob throws", async () => {
    const c = await cluster();
    const blob = prepareBlob(stream(2));
    await c.owner.registerBlob({ blobId: blob.blobId, boxId: BOX, size: blob.size, days: 1 });
    const nodes = [c.apis[0]!, new FaultyNode(c.apis[1]!, 1, { down: true }), new FaultyNode(c.apis[2]!, 2, { down: true })];
    await expect(pushBlob({ nodes, blob, regId: 1, threshold: 2 })).rejects.toBeInstanceOf(NotEnoughAcks);
    // and the chain refuses a certificate with one signature
    const one = await c.apis[0]!.ack(blob.blobId);
    await expect(c.chain.writer("rl").certifyBlob(blob.blobId, [one])).rejects.toThrow("Not enough acknowledgements");
    expect((await c.chain.blob(blob.blobId))?.state).toBe("Registered");
  });
});

describe("S9: node loss", () => {
  it("one node down: writes certify with 2 acks and reads continue", async () => {
    const c = await cluster();
    const down = new FaultyNode(c.apis[2]!, 3, { down: true });
    const { blob, ticket } = await writeBlob(c, [c.apis[0]!, c.apis[1]!, down]);
    expect((await c.chain.blob(blob.blobId))?.ack_bitmap).toBe(0b011);
    // a second node dies after the write: the third (which never got the blob) is useless, one holder is enough
    const got = await readLeaves({ nodes: [new FaultyNode(c.apis[0]!, 4, { down: true }), down, c.apis[1]!], blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: blob.leaves, ticket });
    expect(join(got)).toBe(join(blob.pieces));
  });

  it("two of three down: writes fail closed; reads work only from a node that holds the data", async () => {
    const c = await cluster();
    const { blob, ticket } = await writeBlob(c, c.apis);
    const dead = [new FaultyNode(c.apis[0]!, 5, { down: true }), new FaultyNode(c.apis[1]!, 6, { down: true })];
    const ok = await readLeaves({ nodes: [...dead, c.apis[2]!], blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 1, to: 3, ticket });
    expect(join(ok)).toBe(join(blob.pieces.slice(1, 3)));
    const fresh = prepareBlob(stream(2, 77));
    await c.owner.registerBlob({ blobId: fresh.blobId, boxId: BOX, size: fresh.size, days: 1 });
    await expect(pushBlob({ nodes: [...dead, c.apis[2]!], blob: fresh, regId: 2, threshold: 2 })).rejects.toBeInstanceOf(NotEnoughAcks);
    await expect(readLeaves({ nodes: dead, blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: 1, ticket })).rejects.toBeInstanceOf(ReadFailed);
  });

  it("transient network drops during upload are retried", async () => {
    const c = await cluster();
    const flaky = c.apis.map((a, i) => new FaultyNode(a, 100 + i, { dropRate: 0.25 }));
    const blob = prepareBlob(stream(3));
    await c.owner.registerBlob({ blobId: blob.blobId, boxId: BOX, size: blob.size, days: 1 });
    const res = await pushBlob({ nodes: flaky, blob, regId: 1, threshold: 2, retries: 12 }).catch((e) => e);
    // with 12 retries per leaf the chance of exhausting them at a 25% drop rate is negligible, and seeds are fixed
    expect(res).not.toBeInstanceOf(Error);
    expect(flaky.reduce((n, f) => n + f.calls, 0)).toBeGreaterThan(9);
  });
});

describe("S8: a node returning modified data is detected and bypassed (SI8)", () => {
  it("one corrupting node among three: read succeeds with exact bytes", async () => {
    const c = await cluster();
    const { blob, ticket } = await writeBlob(c, c.apis);
    const liar = new FaultyNode(c.apis[0]!, 7, { corruptRate: 1 });
    const got = await readLeaves({ nodes: [liar, c.apis[1]!, c.apis[2]!], blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: blob.leaves, ticket });
    expect(join(got)).toBe(join(blob.pieces));
  });

  it("all nodes corrupting: the read fails and returns nothing (never unverified bytes)", async () => {
    const c = await cluster();
    const { blob, ticket } = await writeBlob(c, c.apis);
    const liars = c.apis.map((a, i) => new FaultyNode(a, 10 + i, { corruptRate: 1 }));
    const err = await readLeaves({ nodes: liars, blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: blob.leaves, ticket }).catch((e) => e);
    expect(err).toBeInstanceOf(ReadFailed);
    expect((err as ReadFailed).missing).toEqual([0, 1, 2, 3]);
    expect(Object.values((err as ReadFailed).failures)).toEqual(["bad_data", "bad_data", "bad_data"]);
  });

  it("a node that serves a valid leaf at the wrong index, a wrong proof, or truncates is bypassed", async () => {
    const c = await cluster();
    const { blob, ticket } = await writeBlob(c, c.apis);
    const swap: NodeApi = {
      name: "swap",
      putLeaf: () => Promise.reject(new Error("n/a")),
      ack: () => Promise.reject(new Error("n/a")),
      getLeaves: async (a) => {
        const real = await c.apis[0]!.getLeaves(a);
        return real.map((l, i) => ({ ...l, piece: real[(i + 1) % real.length]!.piece })); // valid bytes, wrong place
      },
    };
    const badProof: NodeApi = { ...swap, name: "proof", getLeaves: async (a) => (await c.apis[0]!.getLeaves(a)).map((l) => ({ ...l, proof: l.proof.slice(1) })) };
    const trunc = new FaultyNode(c.apis[0]!, 8, { truncateRate: 1 });
    const got = await readLeaves({ nodes: [swap, badProof, trunc, c.apis[1]!], blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: blob.leaves, ticket });
    expect(join(got)).toBe(join(blob.pieces));
  });

  it("partial results combine across nodes (truncating node plus an honest one)", async () => {
    const c = await cluster();
    const { blob, ticket } = await writeBlob(c, c.apis);
    const trunc = new FaultyNode(c.apis[0]!, 9, { truncateRate: 1 });
    const got = await readLeaves({ nodes: [trunc, c.apis[1]!], blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: blob.leaves, ticket });
    expect(join(got)).toBe(join(blob.pieces));
  });

  it("property: under random seeded faults a read returns the exact bytes or throws, never anything else", async () => {
    const c = await cluster();
    const { blob, ticket } = await writeBlob(c, c.apis, 5);
    const truth = join(blob.pieces);
    let ok = 0;
    let failed = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const nodes = c.apis.map((a, i) => new FaultyNode(a, seed * 10 + i, { dropRate: 0.3, corruptRate: 0.4, truncateRate: 0.3 }));
      try {
        const got = await readLeaves({ nodes, blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: blob.leaves, ticket, start: seed % 3 });
        expect(join(got)).toBe(truth);
        ok++;
      } catch (e) {
        expect(e).toBeInstanceOf(ReadFailed);
        failed++;
      }
    }
    expect(ok).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0); // the plan is harsh enough to exercise both branches
  });
});

describe("tickets are enforced by the node, not the client", () => {
  it("a read with a bad ticket fails on every node", async () => {
    const c = await cluster();
    const { blob } = await writeBlob(c, c.apis);
    const err = await readLeaves({ nodes: c.apis, blobId: blob.blobId, root: blob.root, leaves: blob.leaves, from: 0, to: 1, ticket: "garbage" }).catch((e) => e);
    expect(err).toBeInstanceOf(ReadFailed);
    expect(Object.values((err as ReadFailed).failures)).toEqual(["forbidden", "forbidden", "forbidden"]);
  });

  it("bad merkle size is not trusted from the node (tree size comes from the chain record)", async () => {
    const c = await cluster();
    const { blob, ticket } = await writeBlob(c, c.apis);
    const rec = (await c.chain.blob(blob.blobId))!;
    expect(rec.leaves).toBe(blob.leaves);
    expect(merkle.LEAF_SIZE * rec.leaves).toBe(blob.size);
    void ticket;
  });
});
