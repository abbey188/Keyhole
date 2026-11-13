import { describe, expect, it } from "vitest";
import { FakeChain } from "@keyhole/chain";
import { bytesToHex, msgs, sig } from "@keyhole/crypto";
import { MemoryStore, StorageNode } from "@keyhole/node";
import { NodeCallError } from "@keyhole/store";
import type { NodeApi } from "@keyhole/store";
import { identityFromSecrets } from "../src/lib/keys";
import { createSafe, unwrapBmk } from "../src/lib/safe";
import { addItem, loadManifest, readOriginal, readSegment } from "../src/lib/upload";
import type { Ctx } from "../src/lib/upload";
import { planItem } from "../src/lib/files";
import type { Renderers } from "../src/lib/files";

const id = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const te = new TextEncoder();
const fakeRenderers: Renderers = {
  async pdfPages(b) { return [1, 2].map((n) => ({ mime: "image/png", bytes: te.encode(`PNG page ${n} of ${b.length}`), w: 100, h: 200 })); },
  async cleanImage(b) { return { mime: "image/png", bytes: b.slice(0, 20), w: 5, h: 5 }; },
};

async function rig() {
  const nodeSeed = new Uint8Array(32).fill(0x11);
  const chain = new FakeChain({ nodeKeys: [bytesToHex(sig.publicKey(nodeSeed))], rsKeys: ["00".repeat(32)], threshold: 1 });
  chain.addFullAccessKey(id.accountId, id.accountId);
  const writer = chain.writer(id.accountId);
  const store = new MemoryStore();
  const node = new StorageNode({ reader: chain, store, idx: 0, seed: nodeSeed });
  const wrap = <T,>(p: Promise<T>) => p.catch((e) => { if (e && e.status && e.code) throw new NodeCallError(e.status, e.code); throw e; });
  const api: NodeApi = {
    name: "node0",
    putLeaf: (a) => wrap(node.putLeaf(a)), ack: (b) => wrap(node.ack(b)),
    getLeaves: (a) => wrap(node.getLeaves({ ticket: a.ticket, blobId: a.blobId, from: a.from, to: a.to })),
    getRoot: (b) => wrap(node.rootOf(b)),
  };
  const { boxId } = await createSafe(id, writer);
  const box = (await chain.box(boxId))!;
  const ctx: Ctx = { id, reader: chain, writer, nodes: [api], boxId, bmk: unwrapBmk(id, box), epoch: 0 };
  return { chain, ctx, store };
}

describe("adding files to a safe", () => {
  it("stores a PDF (pages plus the original), then a text file; both round-trip; the index is replaced and the old one erased", async () => {
    const { chain, ctx, store } = await rig();
    let box = (await chain.box(ctx.boxId))!;
    let man = await loadManifest(ctx, box);
    expect(man.items).toEqual([]);

    const pdfBytes = te.encode("%PDF-1.4 fake pdf body");
    const plan = await planItem({ name: "lease.pdf", mime: "application/pdf", bytes: pdfBytes }, fakeRenderers);
    expect(plan.kind).toBe("pdf");
    const a = await addItem(ctx, man, box, { name: "lease.pdf", mime: "application/pdf", kind: plan.kind, size: pdfBytes.length, parts: plan.parts });
    expect(a.txs.map((t) => t.step)).toEqual(["file: register", "file: certify", "file: activate", "index: register", "index: certify", "index: activate", "index: commit"]);

    box = (await chain.box(ctx.boxId))!;
    expect(box.manifest_seq).toBe(1);
    man = await loadManifest(ctx, box);
    expect(man.items.map((i) => i.name)).toEqual(["lease.pdf"]);
    const rec = man.items[0]!;
    expect(rec.shareable).toBe(true);
    expect(new TextDecoder().decode(await readSegment(ctx, rec, 0))).toBe(`PNG page 1 of ${pdfBytes.length}`);
    expect(await readOriginal(ctx, rec)).toEqual(pdfBytes);

    const note = te.encode("rent is 1,200 a month");
    const tplan = await planItem({ name: "note.txt", mime: "text/plain", bytes: note }, fakeRenderers);
    const oldIndex = box.manifest_blob!;
    const b = await addItem(ctx, man, box, { name: "note.txt", mime: "text/plain", kind: tplan.kind, size: note.length, parts: tplan.parts });
    expect(b.txs.at(-1)?.step).toBe("old index: retire");
    box = (await chain.box(ctx.boxId))!;
    man = await loadManifest(ctx, box);
    expect(man.items.map((i) => i.name)).toEqual(["lease.pdf", "note.txt"]);
    expect(new TextDecoder().decode(await readSegment(ctx, man.items[1]!, 0))).toBe("rent is 1,200 a month");
    expect(box.manifest_seq).toBe(2);
    expect((await chain.blob(oldIndex))?.state).toBe("Retired");
    // the node holds only ciphertext
    const held = [...store.blobs()].map((id) => store.getLeaf(id, 0)!).map((l) => new TextDecoder("latin1").decode(l)).join("");
    expect(held).not.toContain("rent is");
    expect(held).not.toContain("lease.pdf");
  });

  it("audio and unknown files are stored as owner-only chunks and read back exactly", async () => {
    const { chain, ctx } = await rig();
    const box = (await chain.box(ctx.boxId))!;
    const big = new Uint8Array(600_000).map((_, i) => (i * 31) & 255);
    const plan = await planItem({ name: "memo.mp3", mime: "audio/mpeg", bytes: big }, fakeRenderers);
    expect(plan.parts.map((p) => p.role)).toEqual(["chunk", "chunk", "chunk"]);
    const r = await addItem(ctx, await loadManifest(ctx, box), box, { name: "memo.mp3", mime: "audio/mpeg", kind: plan.kind, size: big.length, parts: plan.parts });
    expect(r.record.shareable).toBe(false);
    expect(await readOriginal(ctx, r.record)).toEqual(big);
  });

  it("a tampered stored file fails closed", async () => {
    const { chain, ctx, store } = await rig();
    const box = (await chain.box(ctx.boxId))!;
    const plan = await planItem({ name: "a.txt", mime: "text/plain", bytes: te.encode("hello") }, fakeRenderers);
    const r = await addItem(ctx, await loadManifest(ctx, box), box, { name: "a.txt", mime: "text/plain", kind: plan.kind, size: 5, parts: plan.parts });
    const leaf = store.getLeaf(r.record.blobId, 0)!;
    leaf[40] = leaf[40]! ^ 1;
    store.putLeaf(r.record.blobId, 0, leaf);
    await expect(readSegment(ctx, r.record, 0)).rejects.toThrow(); // the leaf no longer matches the root
  });

  it("refuses files over the limit and PDFs with too many pages", async () => {
    await expect(planItem({ name: "x.bin", mime: "", bytes: new Uint8Array(26 * 1024 * 1024) }, fakeRenderers)).rejects.toThrow("larger than");
    const many: Renderers = { ...fakeRenderers, pdfPages: async () => Array.from({ length: 41 }, () => ({ mime: "image/png", bytes: new Uint8Array(1) })) };
    await expect(planItem({ name: "x.pdf", mime: "application/pdf", bytes: new Uint8Array(10) }, many)).rejects.toThrow("pages");
  });
});
void msgs;
