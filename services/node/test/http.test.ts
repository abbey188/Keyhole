import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { merkle } from "@keyhole/crypto";
import { MemoryStore, StorageNode, createNodeServer, encodeTicket, signOwnerTicket } from "../src/index.js";
import { NODE_SEED, OWNER, OWNER_SEED, makeBlob, makeBox, newChain, registerBlob } from "./helpers.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

describe("HTTP front", () => {
  it("put leaves, ack, certify, read with a ticket; errors reveal only a code", async () => {
    const { chain, owner } = newChain();
    await makeBox(owner);
    const node = new StorageNode({ reader: chain, store: new MemoryStore(), idx: 0, seed: NODE_SEED });
    server = createNodeServer(node);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const b = makeBlob(2);
    await registerBlob(owner, b);
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${base}/v1/blobs/${b.blobId}/leaves/${i}`, {
        method: "PUT",
        headers: { "x-reg-id": "1", "x-root": b.root, "x-proof": b.proofs[i]!.map((p) => Buffer.from(p).toString("hex")).join(",") },
        body: Buffer.from(b.pieces[i]!),
      });
      expect(res.status).toBe(200);
    }
    const bad = await fetch(`${base}/v1/blobs/${b.blobId}/leaves/0`, { method: "PUT", headers: { "x-reg-id": "9", "x-root": b.root, "x-proof": "" }, body: Buffer.from(b.pieces[0]!) });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toEqual({ error: "reg_id" });
    const ack = (await (await fetch(`${base}/v1/blobs/${b.blobId}/ack`, { method: "POST" })).json()) as { idx: number; sig: string };
    await chain.writer("rl.testnet").certifyBlob(b.blobId, [ack]);
    await owner.activateBlob(b.blobId);

    const ticket = encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, b.blobId, chain.now() + 60_000));
    const r = await fetch(`${base}/v1/blobs/${b.blobId}/leaves?from=0&to=2`, { headers: { "x-ticket": ticket } });
    const j = (await r.json()) as { leaves: { index: number; piece: string; proof: string[] }[] };
    expect(j.leaves.length).toBe(2);
    const l = j.leaves[1]!;
    expect(merkle.verifyInclusion(merkle.leafHash(Buffer.from(l.piece, "base64")), 1, 2, l.proof.map((h) => Buffer.from(h, "hex")), Buffer.from(b.root, "hex"))).toBe(true);

    expect((await fetch(`${base}/v1/blobs/${b.blobId}/leaves?from=0&to=2`)).status).toBe(403);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    chain.setDown(true);
    expect((await fetch(`${base}/v1/blobs/${b.blobId}/leaves?from=0&to=2`, { headers: { "x-ticket": ticket } })).status).toBe(503);
  });

  it("rejects oversized bodies", async () => {
    const { chain } = newChain();
    const node = new StorageNode({ reader: chain, store: new MemoryStore(), idx: 0, seed: NODE_SEED });
    server = createNodeServer(node);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const res = await fetch(`${base}/v1/blobs/${"ab".repeat(32)}/leaves/0`, { method: "PUT", body: Buffer.alloc(200_000) }).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
  });
});
