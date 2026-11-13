// R1: after "re-lock", cached keys open only what was already in hand; the old ciphertext is erased; the new copies need new keys.
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FakeChain } from "@keyhole/chain";
import { aead, bytesToHex, hexToBytes, kdf, sig } from "@keyhole/crypto";
import { MemoryStore, StorageNode, createNodeServer } from "@keyhole/node";
import { HttpNodeApi } from "@keyhole/store";
import { MemoryGrantStore, ReleaseService, createReleaseServer } from "@keyhole/release";
import { identityFromSecrets } from "../src/lib/keys";
import { createSafe, unwrapBmk } from "../src/lib/safe";
import { addItem, loadManifest, readOriginal, readSegment } from "../src/lib/upload";
import type { Ctx } from "../src/lib/upload";
import { planItem } from "../src/lib/files";
import type { Renderers } from "../src/lib/files";
import { endAccess, giveAccess, openVisit, viewSegment, AccessEnded } from "../src/lib/access";
import type { Services } from "../src/lib/access";
import { relock } from "../src/lib/relock";

const id = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const te = new TextEncoder();
const renderers: Renderers = { async pdfPages() { return [1, 2].map((n) => ({ mime: "image/png", bytes: te.encode(`PAGE-${n}`) })); }, async cleanImage(b) { return { mime: "image/png", bytes: b }; } };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))); });
const listen = (s: Server) => new Promise<number>((r) => { servers.push(s); s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)); });

describe("re-lock (R1)", () => {
  it("old keys and old copies stop working; new copies work only with the new key; open access is ended first", async () => {
    const nodeSeed = new Uint8Array(32).fill(0x11), rsSeed = new Uint8Array(32).fill(0x22);
    const chain = new FakeChain({ nodeKeys: [bytesToHex(sig.publicKey(nodeSeed))], rsKeys: [bytesToHex(sig.publicKey(rsSeed))], threshold: 1 });
    chain.addFullAccessKey(id.accountId, id.accountId);
    const store = new MemoryStore();
    const node = new StorageNode({ reader: chain, store, idx: 0, seed: nodeSeed });
    const nodePort = await listen(createNodeServer(node));
    const rsSvc = new ReleaseService({ reader: chain, relayer: chain.writer("relayer.testnet"), store: new MemoryGrantStore(), rsSeed, rsIdx: 0 });
    const rsPort = await listen(createReleaseServer(rsSvc));
    const svc: Services = { releaseUrl: `http://127.0.0.1:${rsPort}`, nodeUrls: [`http://127.0.0.1:${nodePort}`], chainId: "testnet", contractId: "keyhole.testnet" };
    const writer = chain.writer(id.accountId);
    const { boxId } = await createSafe(id, writer);
    let box = (await chain.box(boxId))!;
    const oldBmk = unwrapBmk(id, box);
    const ctx: Ctx = { id, reader: chain, writer, nodes: [new HttpNodeApi("n0", svc.nodeUrls[0]!)], boxId, bmk: oldBmk, epoch: 0 };

    const pdfBytes = te.encode("%PDF original bytes");
    const plan = await planItem({ name: "lease.pdf", mime: "application/pdf", bytes: pdfBytes }, renderers);
    const added = await addItem(ctx, await loadManifest(ctx, box), box, { name: "lease.pdf", mime: "application/pdf", kind: plan.kind, size: pdfBytes.length, parts: plan.parts });
    const oldRec = added.record;
    box = (await chain.box(boxId))!;

    // a recipient with live access keeps a key and a copy of the ciphertext (the honest soft case)
    const g = await giveAccess({ id, reader: chain, writer, svc, boxId, bmk: oldBmk, epoch: 0, label: "Eve", items: [oldRec], durationMs: 3_600_000, maxSessions: 3, origin: "http://x/" });
    const link = await import("../src/lib/access").then((m) => m.decodeLink(g.link));
    const v = await openVisit(link, chain, svc);
    expect(new TextDecoder().decode(await viewSegment(v, link.items[0]!, link.items[0]!.segs[0]!, svc))).toBe("PAGE-1");
    const cachedKey = kdf.segmentKey(kdf.itemDek(kdf.epochKey(oldBmk, 0), hexToBytes(oldRec.uid)), 0);
    const seg0 = oldRec.segments[0]!;
    const cachedUnit = store.getLeaf(oldRec.blobId, 0)!.slice(seg0.offset, seg0.offset + seg0.len);

    // re-lock
    const res = await relock({ ...ctx, bmk: oldBmk }, box, async () => { await endAccess({ id, reader: chain, writer, svc, grantId: g.grantId }); });
    box = (await chain.box(boxId))!;
    const newBmk = unwrapBmk(id, box);
    expect(bytesToHex(newBmk)).not.toBe(bytesToHex(oldBmk));
    expect(bytesToHex(res.bmk)).toBe(bytesToHex(newBmk));

    // access was ended first; the visitor's next key is refused
    await expect(viewSegment(v, link.items[0]!, link.items[0]!.segs[0]!, svc)).rejects.toBeInstanceOf(AccessEnded);
    // the old blobs are retired; after the node's sweep they are erased and unreadable
    for (const b of res.retired) expect((await chain.blob(b))?.state).toBe("Retired");
    await node.sweep(chain.writer("node0"));
    for (const b of res.retired) expect(store.leafCount(b)).toBe(0);

    // what was already in hand still decrypts with the old key (cannot be undone)...
    expect(new TextDecoder().decode(aead.open(cachedKey, cachedUnit, aead.segAad(hexToBytes(boxId), hexToBytes(oldRec.uid), 0, oldRec.segments.length, 0)).subarray(0, 6))).toBe("PAGE-1");
    // ...but the new copy does not open with it, or with the old box key
    const newCtx: Ctx = { ...ctx, bmk: newBmk };
    const man = await loadManifest(newCtx, box);
    expect(man.items.map((i) => i.name)).toEqual(["lease.pdf"]);
    const newRec = man.items[0]!;
    expect(newRec.uid).not.toBe(oldRec.uid);
    expect(newRec.blobId).not.toBe(oldRec.blobId);
    expect(new TextDecoder().decode(await readSegment(newCtx, newRec, 0))).toBe("PAGE-1");
    expect(await readOriginal(newCtx, newRec)).toEqual(pdfBytes);
    const newUnit = store.getLeaf(newRec.blobId, 0)!.slice(newRec.segments[0]!.offset, newRec.segments[0]!.offset + newRec.segments[0]!.len);
    expect(() => aead.open(cachedKey, newUnit, aead.segAad(hexToBytes(boxId), hexToBytes(newRec.uid), 0, newRec.segments.length, 0))).toThrow();
    await expect(loadManifest({ ...ctx, bmk: oldBmk }, box)).rejects.toThrow(); // the old box key cannot open the new index
  });
});
