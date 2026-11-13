// A full handover on the MOCK chain with the real release-service and storage-node code over HTTP: offer, fund, complete,
// the previous owner's link dies, the new owner receives the key, re-locks, and the previous owner's key opens nothing stored.
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FakeChain } from "@keyhole/chain";
import { bytesToHex, sig } from "@keyhole/crypto";
import { MemoryStore, StorageNode, createNodeServer } from "@keyhole/node";
import { HttpNodeApi } from "@keyhole/store";
import { MemoryGrantStore, ReleaseService, createReleaseServer } from "@keyhole/release";
import { identityFromSecrets } from "../src/lib/keys";
import { createSafe, unwrapBmk } from "../src/lib/safe";
import { addItem, loadManifest, readOriginal } from "../src/lib/upload";
import type { Ctx } from "../src/lib/upload";
import { planItem } from "../src/lib/files";
import type { Renderers } from "../src/lib/files";
import { AccessEnded, decodeLink, giveAccess, openVisit } from "../src/lib/access";
import type { Services } from "../src/lib/access";
import { acceptAndFund, completeHandover, handoverAddress, offerHandover, parseAddress, parseDealCode, readDeal, receiveKey } from "../src/lib/handover";
import { relock } from "../src/lib/relock";

const seller = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const buyer = identityFromSecrets(new Uint8Array(32).fill(3), new Uint8Array(32).fill(4), "passkey");
const te = new TextEncoder();
const renderers: Renderers = { async pdfPages() { return [{ mime: "image/png", bytes: te.encode("PAGE-1") }]; }, async cleanImage(b) { return { mime: "image/png", bytes: b }; } };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))); });
const listen = (s: Server) => new Promise<number>((r) => { servers.push(s); s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)); });

describe("handover", () => {
  it("addresses and codes are parsed strictly", () => {
    expect(parseAddress(handoverAddress(buyer)).account).toBe(buyer.accountId);
    expect(() => parseAddress("nope")).toThrow("not valid");
    expect(() => parseDealCode("zz.yy")).toThrow("not valid");
    expect(parseDealCode(`${"a".repeat(32)}.${"b".repeat(32)}`).dealId).toBe("a".repeat(32));
  });

  it("offer, fund, complete: old access dies, the buyer rebuilds the key, re-locks, and the seller's key opens nothing stored", async () => {
    const nodeSeed = new Uint8Array(32).fill(0x11), rsSeed = new Uint8Array(32).fill(0x22);
    const chain = new FakeChain({ nodeKeys: [bytesToHex(sig.publicKey(nodeSeed))], rsKeys: [bytesToHex(sig.publicKey(rsSeed))], threshold: 1 });
    chain.addFullAccessKey(seller.accountId, seller.accountId);
    chain.addFullAccessKey(buyer.accountId, buyer.accountId);
    const store = new MemoryStore();
    const node = new StorageNode({ reader: chain, store, idx: 0, seed: nodeSeed });
    const nodePort = await listen(createNodeServer(node));
    const relayer = chain.writer("relayer.testnet");
    const rsPort = await listen(createReleaseServer(new ReleaseService({ reader: chain, relayer, store: new MemoryGrantStore(), rsSeed, rsIdx: 0 })));
    const svc: Services = { releaseUrl: `http://127.0.0.1:${rsPort}`, nodeUrls: [`http://127.0.0.1:${nodePort}`], chainId: "testnet", contractId: "keyhole.testnet" };
    const nodes = [new HttpNodeApi("n0", svc.nodeUrls[0]!)];

    const sw = chain.writer(seller.accountId);
    const { boxId } = await createSafe(seller, sw);
    let box = (await chain.box(boxId))!;
    const sellerBmk = unwrapBmk(seller, box);
    const sctx: Ctx = { id: seller, reader: chain, writer: sw, nodes, boxId, bmk: sellerBmk, epoch: 0 };
    const pdf = te.encode("%PDF the original lease");
    const plan = await planItem({ name: "lease.pdf", mime: "application/pdf", bytes: pdf }, renderers);
    const added = await addItem(sctx, await loadManifest(sctx, box), box, { name: "lease.pdf", mime: "application/pdf", kind: plan.kind, size: pdf.length, parts: plan.parts });
    // an access link the seller gave earlier
    const g = await giveAccess({ id: seller, reader: chain, writer: sw, svc, boxId, bmk: sellerBmk, epoch: 0, label: "Maria", items: [added.record], durationMs: 3_600_000, maxSessions: 3, origin: "http://x/" });
    expect((await openVisit(decodeLink(g.link), chain, svc)).seq).toBe(1);

    // seller offers (free handover) to the buyer's address
    const offer = await offerHandover({ ctx: sctx, writer: sw, svc, buyerAddress: handoverAddress(buyer), priceYocto: "0", waitingMs: 1000 });
    expect((await chain.box(boxId))!.in_deal).toBe(offer.dealId);
    const deal0 = (await readDeal(chain, offer.dealId))!;
    expect(deal0).toMatchObject({ state: "Ready", buyer: buyer.accountId, seller: seller.accountId, price: "0" });

    // buyer cannot get the key early
    const bw = chain.writer(buyer.accountId);
    await expect(receiveKey({ id: buyer, reader: chain, svc, nodes, deal: deal0 })).rejects.toThrow("not available yet");
    await acceptAndFund(bw, deal0);
    await expect(completeHandover(bw, offer.dealId)).rejects.toThrow("Waiting period");
    chain.advance(2000);
    await completeHandover(bw, offer.dealId);
    const deal = (await readDeal(chain, offer.dealId))!;
    expect(deal.state).toBe("Completed");
    box = (await chain.box(boxId))!;
    expect(box).toMatchObject({ owner: buyer.accountId, key_epoch: 1 });

    // the seller's earlier link no longer opens
    await expect(openVisit(decodeLink(g.link), chain, svc)).rejects.toBeInstanceOf(AccessEnded);

    // the buyer rebuilds the key (checked against the on-chain commitment) and re-locks into epoch 1 with a key only they hold
    const bmk = await receiveKey({ id: buyer, reader: chain, svc, nodes, deal });
    expect(bytesToHex(bmk)).toBe(bytesToHex(sellerBmk));
    const bctx: Ctx = { id: buyer, reader: chain, writer: bw, nodes, boxId, bmk, epoch: 0 };
    const res = await relock(bctx, box, async () => undefined, 1);
    box = (await chain.box(boxId))!;
    const buyerBmk = unwrapBmk(buyer, box);
    expect(bytesToHex(buyerBmk)).not.toBe(bytesToHex(sellerBmk));
    const after: Ctx = { ...bctx, bmk: buyerBmk, epoch: 1 };
    const man = await loadManifest(after, box);
    expect(await readOriginal(after, man.items[0]!)).toEqual(pdf);
    // the previous owner: not the owner any more, and the key they hold opens nothing that is stored
    await expect(loadManifest({ ...sctx, epoch: 1 }, box)).rejects.toThrow();
    await node.sweep(chain.writer("node0"));
    for (const b of res.retired) expect(store.leafCount(b)).toBe(0);
    await expect(sw.createGrant({ grantId: "ab".repeat(16), boxId, requester: { bearer: "cd".repeat(32) }, mode: "View", notBeforeMs: chain.now(), notAfterMs: chain.now() + 600_000, maxSessions: 1, scopeHash: "00".repeat(32), policyHash: "00".repeat(32) })).rejects.toThrow("Only the box owner");
  });
});
