// B6: an owner allows a small question budget on a link; the recipient's questions are counted, sealed to the owner and
// readable only by the owner. Over real HTTP servers on the MOCK chain.
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FakeChain } from "@keyhole/chain";
import { bytesToHex, sig } from "@keyhole/crypto";
import { MemoryStore, StorageNode, createNodeServer } from "@keyhole/node";
import { HttpNodeApi } from "@keyhole/store";
import { MemoryGrantStore, ReleaseService, createReleaseServer } from "@keyhole/release";
import { identityFromSecrets } from "../src/lib/keys";
import { createSafe, unwrapBmk } from "../src/lib/safe";
import { addItem, loadManifest } from "../src/lib/upload";
import type { Ctx } from "../src/lib/upload";
import { planItem } from "../src/lib/files";
import type { Renderers } from "../src/lib/files";
import { askPages, decodeLink, giveAccess, logAnswer, openVisit, reserveQuestion } from "../src/lib/access";
import type { Services } from "../src/lib/access";
import { fetchFeed, readAskLog } from "../src/lib/visitors";

const id = identityFromSecrets(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), "passkey");
const te = new TextEncoder();
const renderers: Renderers = {
  async pdfPages() { return []; },
  async cleanImage(b) { return { mime: "image/png", bytes: b, w: 1, h: 1 }; },
};
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))); });
const listen = (s: Server) => new Promise<number>((r) => { servers.push(s); s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)); });

describe("B6 ask grants", () => {
  it("counts questions, refuses past the budget, and only the owner can read the log", async () => {
    const nodeSeed = new Uint8Array(32).fill(0x11), rsSeed = new Uint8Array(32).fill(0x22);
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
    const man = await loadManifest(ctx, box);
    const bytes = te.encode("The monthly rent is 1,250 pounds.");
    const plan = await planItem({ name: "lease.txt", mime: "text/plain", bytes }, renderers);
    const rec = (await addItem(ctx, man, (await chain.box(boxId))!, { name: "lease.txt", mime: "text/plain", kind: plan.kind, size: bytes.length, parts: plan.parts })).record;

    const g = await giveAccess({ id, reader: chain, writer, svc: services, boxId, bmk: ctx.bmk, epoch: 0, label: "Maria", items: [rec], durationMs: 3_600_000, maxSessions: 2, askBudget: 2, origin: "http://localhost/" });
    const p = decodeLink(g.link);
    expect(p.q?.budget).toBe(2);
    const v = await openVisit(p, chain, services);
    const pages = await askPages(v, services);
    expect(pages.map((x) => x.text)).toEqual(["The monthly rent is 1,250 pounds."]);

    const a = await reserveQuestion(v, services, "How much is the rent?");
    expect(a).toEqual({ n: 0, left: 1 });
    await logAnswer(v, services, 0, { answer: "1,250 pounds" });
    await reserveQuestion(v, services, "Second question");
    await expect(reserveQuestion(v, services, "Third question")).rejects.toThrow(/No questions are left/);

    const feed = await fetchFeed(id, chain, services, boxId);
    const log = readAskLog(id, feed);
    expect(log.map((r) => [r.question, r.answer, r.ok])).toEqual([["How much is the rent?", "1,250 pounds", true], ["Second question", null, true]]);
    // the service holds only ciphertext: neither question text appears in what it logged
    expect(JSON.stringify(feed)).not.toContain("rent?");
    // a different key cannot read it
    const other = identityFromSecrets(new Uint8Array(32).fill(7), new Uint8Array(32).fill(8), "passkey");
    expect(readAskLog(other, feed).every((r) => r.question === "(unreadable)" && !r.ok)).toBe(true);
  });

  it("a link without an ask policy refuses questions", async () => {
    const p = { v: 1, g: "a".repeat(32), s: "0".repeat(64), k: "0".repeat(64), l: "x", b: "b", ep: 0, exp: 0, items: [] };
    await expect(reserveQuestion({ payload: p } as never, {} as never, "hi")).rejects.toThrow("This access does not cover that.");
  });
});
