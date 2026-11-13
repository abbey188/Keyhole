// Owner gives access, a recipient opens the link: the whole path over real HTTP servers (release service and storage
// node code) on the MOCK chain. Nothing here talks to the network.
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FakeChain } from "@keyhole/chain";
import { bytesToHex, hexToBytes, sig } from "@keyhole/crypto";
import { MemoryStore, StorageNode, createNodeServer } from "@keyhole/node";
import { HttpNodeApi } from "@keyhole/store";
import { MemoryGrantStore, ReleaseService, createReleaseServer } from "@keyhole/release";
import { identityFromSecrets } from "../src/lib/keys";
import { createSafe, unwrapBmk } from "../src/lib/safe";
import { addItem, loadManifest } from "../src/lib/upload";
import type { Ctx } from "../src/lib/upload";
import { planItem } from "../src/lib/files";
import type { Renderers } from "../src/lib/files";
import { AccessEnded, closeVisit, decodeLink, endAccess, giveAccess, openVisit, viewSegment } from "../src/lib/access";
import type { Services } from "../src/lib/access";

const id = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const te = new TextEncoder();
const renderers: Renderers = {
  async pdfPages() { return [1, 2, 3].map((n) => ({ mime: "image/png", bytes: te.encode(`PAGE-${n}-PIXELS`), w: 10, h: 10 })); },
  async cleanImage(b) { return { mime: "image/png", bytes: b, w: 1, h: 1 }; },
};
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))); });
const listen = (s: Server) => new Promise<number>((r) => { servers.push(s); s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)); });

async function world() {
  const nodeSeed = new Uint8Array(32).fill(0x11);
  const rsSeed = new Uint8Array(32).fill(0x22);
  const chain = new FakeChain({ nodeKeys: [bytesToHex(sig.publicKey(nodeSeed))], rsKeys: [bytesToHex(sig.publicKey(rsSeed))], threshold: 1 });
  chain.addFullAccessKey(id.accountId, id.accountId);
  const node = new StorageNode({ reader: chain, store: new MemoryStore(), idx: 0, seed: nodeSeed });
  const nodePort = await listen(createNodeServer(node));
  const svc = new ReleaseService({ reader: chain, relayer: chain.writer("relayer.testnet"), store: new MemoryGrantStore(), rsSeed, rsIdx: 0 });
  const rsPort = await listen(createReleaseServer(svc));
  const services: Services = { releaseUrl: `http://127.0.0.1:${rsPort}`, nodeUrls: [`http://127.0.0.1:${nodePort}`], chainId: "testnet", contractId: "keyhole.testnet" };
  const writer = chain.writer(id.accountId);
  const { boxId } = await createSafe(id, writer);
  const box = (await chain.box(boxId))!;
  const ctx: Ctx = { id, reader: chain, writer, nodes: [new HttpNodeApi("node0", services.nodeUrls[0]!)], boxId, bmk: unwrapBmk(id, box), epoch: 0 };
  let man = await loadManifest(ctx, box);
  const add = async (name: string, mime: string, bytes: Uint8Array) => {
    const plan = await planItem({ name, mime, bytes }, renderers);
    const b = (await chain.box(boxId))!;
    const r = await addItem(ctx, man, b, { name, mime, kind: plan.kind, size: bytes.length, parts: plan.parts });
    man = r.manifest;
    return r.record;
  };
  return { chain, ctx, services, add };
}

describe("give access and open a link", () => {
  it("a recipient with only the link reads exactly the shared pages; the original is never reachable", async () => {
    const { chain, ctx, services, add } = await world();
    const lease = await add("lease.pdf", "application/pdf", te.encode("%PDF-secret-original"));
    const g = await giveAccess({ id, reader: chain, writer: ctx.writer, svc: services, boxId: ctx.boxId, bmk: ctx.bmk, epoch: 0, label: "Maria", items: [lease], durationMs: 3_600_000, maxSessions: 2, origin: "http://localhost/" });
    expect(g.link).toContain("#open=");
    expect(g.link).not.toContain("secret");
    const payload = decodeLink(g.link);
    expect(payload.l).toBe("Maria");
    expect(payload.items[0]!.segs.length).toBe(3); // pages only: the original part is not in the link

    const v = await openVisit(payload, chain, services);
    expect(v.seq).toBe(1);
    const item = payload.items[0]!;
    for (const seg of item.segs) {
      expect(new TextDecoder().decode(await viewSegment(v, item, seg, services))).toBe(`PAGE-${seg.p}-PIXELS`);
    }
    // the original (segment 3) is outside the scope: the release service gives no key for it
    const orig = lease.segments.find((s) => s.role === "original")!;
    await expect(viewSegment(v, item, { s: orig.s, o: orig.offset, n: orig.len, m: orig.mime }, services)).rejects.toBeInstanceOf(AccessEnded);
    // the visit is on the owner's chain: one open
    expect((await chain.box(ctx.boxId))!.receipts_seq).toBe(1);
    await closeVisit(v, services);
    expect((await chain.box(ctx.boxId))!.receipts_seq).toBe(2);
  });

  it("ending access stops the next key at once; a damaged or foreign link opens nothing", async () => {
    const { chain, ctx, services, add } = await world();
    const note = await add("note.txt", "text/plain", te.encode("deposit 1,800"));
    const g = await giveAccess({ id, reader: chain, writer: ctx.writer, svc: services, boxId: ctx.boxId, bmk: ctx.bmk, epoch: 0, label: "Ben", items: [note], durationMs: 3_600_000, maxSessions: 3, origin: "http://localhost/" });
    const payload = decodeLink(g.link);
    const v = await openVisit(payload, chain, services);
    const seg = payload.items[0]!.segs[0]!;
    expect(new TextDecoder().decode(await viewSegment(v, payload.items[0]!, seg, services))).toBe("deposit 1,800");
    await endAccess({ id, reader: chain, writer: ctx.writer, svc: services, grantId: g.grantId });
    await expect(viewSegment(v, payload.items[0]!, seg, services)).rejects.toBeInstanceOf(AccessEnded);
    await expect(openVisit(payload, chain, services)).rejects.toBeInstanceOf(AccessEnded);

    expect(() => decodeLink("http://x/#open=%%%")).toThrow();
    expect(() => decodeLink("http://x/")).toThrow("not a Keyhole link");
    const other = await giveAccess({ id, reader: chain, writer: ctx.writer, svc: services, boxId: ctx.boxId, bmk: ctx.bmk, epoch: 0, label: "Cy", items: [note], durationMs: 3_600_000, maxSessions: 3, origin: "http://localhost/" });
    // a link with a wrong key half opens but decrypts nothing
    const bad = { ...decodeLink(other.link), s: bytesToHex(new Uint8Array(32).fill(5)) };
    const v2 = await openVisit(bad, chain, services);
    await expect(viewSegment(v2, bad.items[0]!, bad.items[0]!.segs[0]!, services)).rejects.toThrow();
    // a link with a different recipient key is refused (and the refusal backs this caller off, by design)
    const wrong = { ...decodeLink(other.link), k: bytesToHex(new Uint8Array(32).fill(9)) };
    await expect(openVisit(wrong, chain, services)).rejects.toBeInstanceOf(AccessEnded);
  });

  it("only shareable files can be given", async () => {
    const { chain, ctx, services, add } = await world();
    const audio = await add("memo.mp3", "audio/mpeg", new Uint8Array(1000));
    await expect(giveAccess({ id, reader: chain, writer: ctx.writer, svc: services, boxId: ctx.boxId, bmk: ctx.bmk, epoch: 0, label: "x", items: [audio], durationMs: 3_600_000, maxSessions: 1, origin: "http://localhost/" })).rejects.toThrow("can be shared");
  });
});
void hexToBytes;
