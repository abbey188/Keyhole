import { describe, expect, it } from "vitest";
import { bytesToHex, merkle, msgs, sig } from "@keyhole/crypto";
import { MemoryStore, NodeError, StorageNode, encodeTicket, signOwnerTicket, signRsTicket } from "../src/index.js";
import { BOX, NODE_SEED, OWNER, OWNER_SEED, RS_SEED, hexN, makeBlob, makeBox, newChain, openSession, registerBlob } from "./helpers.js";
import type { TestBlob } from "./helpers.js";

async function rig() {
  const { chain, owner } = newChain();
  await makeBox(owner);
  const store = new MemoryStore();
  const node = new StorageNode({ reader: chain, store, idx: 0, seed: NODE_SEED });
  return { chain, owner, store, node };
}

async function upload(node: StorageNode, chain: { blob(id: string): Promise<{ reg_id: number } | null> }, b: TestBlob, skip: number[] = []) {
  const reg = (await chain.blob(b.blobId))!.reg_id;
  for (let i = 0; i < b.pieces.length; i++) {
    if (skip.includes(i)) continue;
    await node.putLeaf({ blobId: b.blobId, regId: reg, root: b.root, index: i, piece: b.pieces[i]!, proof: b.proofs[i]! });
  }
  return reg;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof NodeError ? `${e.status}:${e.code}` : String(e);
  }
};

async function activeBlob(r: Awaited<ReturnType<typeof rig>>, n = 3, salt = 0) {
  const b = makeBlob(n, salt);
  await registerBlob(r.owner, b);
  await upload(r.node, r.chain, b);
  const a = await r.node.ack(b.blobId);
  await r.chain.writer("rl.testnet").certifyBlob(b.blobId, [{ idx: a.idx, sig: a.sig }]);
  await r.owner.activateBlob(b.blobId);
  return b;
}

describe("S7: a node accepts leaves only for registered blobs with a valid proof", () => {
  it("accepts a valid leaf and rejects every kind of bad one", async () => {
    const r = await rig();
    const b = makeBlob(3);
    // not registered yet
    expect(await code(r.node.putLeaf({ blobId: b.blobId, regId: 1, root: b.root, index: 0, piece: b.pieces[0]!, proof: b.proofs[0]! }))).toBe("404:not_registered");
    await registerBlob(r.owner, b);
    const base = { blobId: b.blobId, regId: 1, root: b.root, index: 0, piece: b.pieces[0]!, proof: b.proofs[0]! };
    expect(await code(r.node.putLeaf(base))).toBe("ok");
    expect(await code(r.node.putLeaf({ ...base, regId: 2 }))).toBe("409:reg_id");
    expect(await code(r.node.putLeaf({ ...base, root: bytesToHex(new Uint8Array(32).fill(9)) }))).toBe("400:root");
    expect(await code(r.node.putLeaf({ ...base, proof: b.proofs[1]! }))).toBe("400:proof");
    const bad = b.pieces[1]!.slice();
    bad[5] = bad[5]! ^ 1;
    expect(await code(r.node.putLeaf({ ...base, index: 1, piece: bad, proof: b.proofs[1]! }))).toBe("400:proof");
    expect(await code(r.node.putLeaf({ ...base, index: 1, piece: b.pieces[1]!.slice(0, 100), proof: b.proofs[1]! }))).toBe("400:bad_leaf");
    expect(await code(r.node.putLeaf({ ...base, index: 3, piece: b.pieces[0]!, proof: [] }))).toBe("400:bad_leaf");
    expect(r.store.leafCount(b.blobId)).toBe(1);
  });

  it("refuses leaves after the registration window", async () => {
    const r = await rig();
    const b = makeBlob(2);
    await registerBlob(r.owner, b);
    r.chain.advance(3_600_001);
    expect(await code(r.node.putLeaf({ blobId: b.blobId, regId: 1, root: b.root, index: 0, piece: b.pieces[0]!, proof: b.proofs[0]! }))).toBe("403:window");
  });

  it("a different blob cannot be smuggled in under a registered blob's id (root must match the id)", async () => {
    const r = await rig();
    const good = makeBlob(2, 0);
    const evil = makeBlob(2, 9);
    await registerBlob(r.owner, good);
    expect(await code(r.node.putLeaf({ blobId: good.blobId, regId: 1, root: evil.root, index: 0, piece: evil.pieces[0]!, proof: evil.proofs[0]! }))).toBe("400:root");
  });
});

describe("ack and certificate", () => {
  it("acks only when every leaf is held and the recomputed root matches; the chain accepts the ack", async () => {
    const r = await rig();
    const b = makeBlob(3);
    await registerBlob(r.owner, b);
    await upload(r.node, r.chain, b, [2]);
    expect(await code(r.node.ack(b.blobId))).toBe("409:incomplete");
    const reg = (await r.chain.blob(b.blobId))!.reg_id;
    await r.node.putLeaf({ blobId: b.blobId, regId: reg, root: b.root, index: 2, piece: b.pieces[2]!, proof: b.proofs[2]! });
    const a = await r.node.ack(b.blobId);
    await r.chain.writer("rl.testnet").certifyBlob(b.blobId, [a]);
    expect((await r.chain.blob(b.blobId))?.state).toBe("Complete");
  });

  it("bytes corrupted at rest are caught before signing", async () => {
    const r = await rig();
    const b = makeBlob(2);
    await registerBlob(r.owner, b);
    await upload(r.node, r.chain, b);
    const p = r.store.getLeaf(b.blobId, 1)!;
    p[10] = p[10]! ^ 0xff;
    r.store.putLeaf(b.blobId, 1, p);
    expect(await code(r.node.ack(b.blobId))).toBe("409:root");
  });

  it("an ack is bound to the registration: it does not certify a re-registered blob (S5)", async () => {
    const r = await rig();
    const b = makeBlob(1);
    await registerBlob(r.owner, b);
    await upload(r.node, r.chain, b);
    const a = await r.node.ack(b.blobId);
    const old = msgs.ackMsg("testnet", "keyhole.testnet", 1, Buffer.from(b.blobId, "hex"), 0, (await r.chain.blob(b.blobId))!.paid_until);
    expect(sig.verify(r.node.publicKey, old, Buffer.from(a.sig, "hex"))).toBe(true);
    const other = msgs.ackMsg("testnet", "keyhole.testnet", 2, Buffer.from(b.blobId, "hex"), 0, (await r.chain.blob(b.blobId))!.paid_until);
    expect(sig.verify(r.node.publicKey, other, Buffer.from(a.sig, "hex"))).toBe(false);
  });
});

describe("reads need a valid ticket and a live blob (A6-adjacent, S8 support)", () => {
  it("serves leaves with proofs that verify against the root", async () => {
    const r = await rig();
    const b = await activeBlob(r);
    const t = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, b.blobId, r.chain.now() + 60_000));
    const got = await r.node.getLeaves({ ticket: t, blobId: b.blobId, from: 0, to: 3 });
    expect(got.length).toBe(3);
    for (const l of got) {
      expect(merkle.verifyInclusion(merkle.leafHash(l.piece), l.index, 3, l.proof, Buffer.from(b.root, "hex"))).toBe(true);
    }
  });

  it("owner ticket: must be a full-access key of the current box owner and unexpired", async () => {
    const r = await rig();
    const b = await activeBlob(r);
    const exp = r.chain.now() + 60_000;
    expect(await code(r.node.getLeaves({ ticket: undefined, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
    // key not registered on the account
    const stranger = encodeTicket(signOwnerTicket(new Uint8Array(32).fill(77), OWNER, b.blobId, exp));
    expect(await code(r.node.getLeaves({ ticket: stranger, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
    // right key, wrong account
    const wrongAcct = encodeTicket(signOwnerTicket(OWNER_SEED, "bob.testnet", b.blobId, exp));
    expect(await code(r.node.getLeaves({ ticket: wrongAcct, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
    // ticket for another blob
    const other = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, hexN(1, 32), exp));
    expect(await code(r.node.getLeaves({ ticket: other, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
    // expiry is judged by chain time, not the node's clock
    const ok = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, b.blobId, exp));
    expect(await code(r.node.getLeaves({ ticket: ok, blobId: b.blobId, from: 0, to: 1 }))).toBe("ok");
    r.chain.advance(61_000);
    expect(await code(r.node.getLeaves({ ticket: ok, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
  });

  it("release-service ticket: needs the RS key, a live session, and stops when the grant is revoked or the epoch moves", async () => {
    const r = await rig();
    const b = await activeBlob(r);
    const s = await openSession(r.chain, r.owner);
    const exp = r.chain.now() + 60_000;
    const good = encodeTicket(signRsTicket(RS_SEED, 0, b.blobId, s.sessionId, exp));
    expect(await code(r.node.getLeaves({ ticket: good, blobId: b.blobId, from: 0, to: 1 }))).toBe("ok");
    const forged = encodeTicket(signRsTicket(new Uint8Array(32).fill(5), 0, b.blobId, s.sessionId, exp));
    expect(await code(r.node.getLeaves({ ticket: forged, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
    const noSession = encodeTicket(signRsTicket(RS_SEED, 0, b.blobId, hexN(0x99, 16), exp));
    expect(await code(r.node.getLeaves({ ticket: noSession, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
    await r.owner.revokeGrant(s.grantId);
    expect(await code(r.node.getLeaves({ ticket: good, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
  });

  it("epoch bump stops RS-ticket reads of the previous owner's grants", async () => {
    const r = await rig();
    const b = await activeBlob(r);
    const s = await openSession(r.chain, r.owner);
    const t = encodeTicket(signRsTicket(RS_SEED, 0, b.blobId, s.sessionId, r.chain.now() + 60_000));
    expect(await code(r.node.getLeaves({ ticket: t, blobId: b.blobId, from: 0, to: 1 }))).toBe("ok");
    r.chain.completeDealFor(BOX, "buyer.testnet");
    expect(await code(r.node.getLeaves({ ticket: t, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
  });

  it("an RS ticket never reads a blob that is not ACTIVE; the owner can read COMPLETE", async () => {
    const r = await rig();
    const b = makeBlob(1);
    await registerBlob(r.owner, b);
    await upload(r.node, r.chain, b);
    const a = await r.node.ack(b.blobId);
    await r.chain.writer("rl.testnet").certifyBlob(b.blobId, [a]);
    const s = await openSession(r.chain, r.owner);
    const exp = r.chain.now() + 60_000;
    const rs = encodeTicket(signRsTicket(RS_SEED, 0, b.blobId, s.sessionId, exp));
    expect(await code(r.node.getLeaves({ ticket: rs, blobId: b.blobId, from: 0, to: 1 }))).toBe("404:not_found");
    const ow = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, b.blobId, exp));
    expect(await code(r.node.getLeaves({ ticket: ow, blobId: b.blobId, from: 0, to: 1 }))).toBe("ok");
  });

  it("range limits and bad ranges are rejected", async () => {
    const r = await rig();
    const b = await activeBlob(r);
    const t = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, b.blobId, r.chain.now() + 60_000));
    expect(await code(r.node.getLeaves({ ticket: t, blobId: b.blobId, from: 2, to: 2 }))).toBe("400:bad_request");
    expect(await code(r.node.getLeaves({ ticket: t, blobId: b.blobId, from: 0, to: 4 }))).toBe("400:bad_request");
    expect(await code(r.node.getLeaves({ ticket: t, blobId: b.blobId, from: 0, to: 9999 }))).toBe("400:bad_request");
  });

  it("fails closed with 503 when the chain is unreachable", async () => {
    const r = await rig();
    const b = await activeBlob(r);
    const t = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, b.blobId, r.chain.now() + 60_000));
    r.chain.setDown(true);
    expect(await code(r.node.getLeaves({ ticket: t, blobId: b.blobId, from: 0, to: 1 }))).toBe("503:unavailable");
    expect(await code(r.node.ack(b.blobId))).toBe("503:unavailable");
  });
});

describe("retire and erase (S4/S6 node side)", () => {
  it("stops serving the moment the chain says Retired, then erases and attests; the record disappears", async () => {
    const r = await rig();
    const b = await activeBlob(r);
    const t = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, b.blobId, r.chain.now() + 60_000));
    await r.owner.retireBlob(b.blobId);
    // not yet erased locally, but already refused
    expect(r.store.leafCount(b.blobId)).toBe(3);
    expect(await code(r.node.getLeaves({ ticket: t, blobId: b.blobId, from: 0, to: 1 }))).toBe("404:not_found");
    const rep = await r.node.sweep(r.chain.writer("node0.testnet"));
    expect(rep).toEqual({ erased: [b.blobId], attested: [b.blobId] });
    expect(r.store.blobs()).toEqual([]);
    expect(await r.chain.blob(b.blobId)).toBeNull(); // N=1: all attested, record removed
  });

  it("erases leftovers of abandoned registrations only after the record stays missing, and leaves live blobs alone", async () => {
    const r = await rig();
    const live = await activeBlob(r, 2, 1);
    const dead = makeBlob(2, 5);
    await registerBlob(r.owner, dead);
    await upload(r.node, r.chain, dead);
    expect((await r.node.sweep(r.chain.writer("n"))).erased).toEqual([]);
    // simulate the registration disappearing (abandon_blob after the window)
    r.chain.advance(3_700_000);
    (r.chain as any).head.blobs.delete(dead.blobId);
    (r.chain as any).finalize();
    expect((await r.node.sweep(r.chain.writer("n"))).erased).toEqual([]); // first sighting: keep
    r.chain.advance(300_000);
    expect((await r.node.sweep(r.chain.writer("n"))).erased).toEqual([]); // second: keep
    r.chain.advance(300_001);
    const rep = await r.node.sweep(r.chain.writer("n")); // third sweep, more than the grace later
    expect(rep).toEqual({ erased: [dead.blobId], attested: [] });
    expect(r.store.blobs()).toEqual([live.blobId]);
  });

  it("S5: one stale 'missing' answer from the RPC never erases a live blob", async () => {
    const r = await rig();
    const live = await activeBlob(r, 2, 1);
    let lie = true;
    const stale = new Proxy(r.chain, { get: (t, k) => (k === "blob" ? async (id: string) => (lie ? null : t.blob(id)) : (t as any)[k].bind?.(t) ?? (t as any)[k]) });
    const node = new StorageNode({ reader: stale as never, store: r.store, idx: 0, seed: NODE_SEED });
    for (let i = 0; i < 2; i++) {
      r.chain.advance(400_000);
      expect((await node.sweep(r.chain.writer("n"))).erased).toEqual([]);
    }
    lie = false; // the RPC catches up: the counter resets
    expect((await node.sweep(r.chain.writer("n"))).erased).toEqual([]);
    lie = true;
    r.chain.advance(700_000);
    expect((await node.sweep(r.chain.writer("n"))).erased).toEqual([]);
    expect(r.store.blobs()).toEqual([live.blobId]);
  });

  it("S14: an owner ticket valid for longer than ten minutes is refused", async () => {
    const r = await rig();
    const b = await activeBlob(r);
    const long = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, b.blobId, r.chain.now() + 3_600_000));
    expect(await code(r.node.getLeaves({ ticket: long, blobId: b.blobId, from: 0, to: 1 }))).toBe("403:forbidden");
  });
});
