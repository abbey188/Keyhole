import { describe, expect, it, vi } from "vitest";
import { bytesToHex, hexToBytes, receipt, seal, sig } from "@keyhole/crypto";
import { ReleaseError, authBody, dealAckMsg, dealS2Commit, logHeadMsg } from "../src/index.js";
import { BLOB, BOX, ITEM, OWNER, OWNER_SEED, auth, giveAccess, hexN, openRequest, pkHex, recover, rig, seed, sha256, visit } from "./helpers.js";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ReleaseError ? `${e.status}:${e.code}` : `other:${String(e)}`;
  }
};

describe("happy path and the split key", () => {
  it("recipient opens a session, gets sealed S2, and recombines the real segment key", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    expect(v.seq).toBe(1);
    const keys = await r.svc.release(v.token, ITEM, [0, 2]);
    expect(keys.map((k) => k.seg)).toEqual([0, 2]);
    expect(bytesToHex(recover(link, v, 0, keys[0]!.sealed))).toBe(bytesToHex(link.segmentKeys[0]!));
    expect(bytesToHex(recover(link, v, 2, keys[1]!.sealed))).toBe(bytesToHex(link.segmentKeys[2]!));
  });

  it("S2 sealed to one session cannot be opened with another key", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    const [k] = await r.svc.release(v.token, ITEM, [0]);
    expect(() => seal.openSealed(seed(123), hexToBytes(k!.sealed))).toThrow();
  });
});

describe("A1: no key before the receipt is final", () => {
  it("while finality is held no token exists and nothing is released; after release the session works", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    r.chain.hold();
    const { req, sessionSk } = openRequest(r, link);
    let done: string | undefined;
    const p = r.svc.openSession(req).then((x) => (done = x.token));
    await new Promise((res) => setTimeout(res, 20));
    expect(done).toBeUndefined();
    expect(r.chain.headSession(req.sessionId)).not.toBeNull(); // included but not final
    expect(await r.chain.session(req.sessionId)).toBeNull();
    expect(await code(r.svc.release("0".repeat(64), ITEM, [0]))).toBe("403:denied");
    r.chain.release();
    await p;
    expect(done).toBeDefined();
    expect((await r.svc.release(done!, ITEM, [0])).length).toBe(1);
    void sessionSk;
  });

  it("a relayer that claims success without a real receipt yields no key", async () => {
    const r0 = await rig();
    const liar = { ...r0.chain.writer("liar.testnet"), account: "liar", openSession: async (a: { grantId: string; sessionId: string }) => ({ txHash: "x", events: [{ event: "session_opened", data: { session_id: a.sessionId, grant_id: a.grantId, seq: 1, head: "00", commitment: "00" } }] }) };
    const r = await rig({ relayer: liar as never });
    const link = await giveAccess(r);
    const { req } = openRequest(r, link);
    expect(await code(r.svc.openSession(req))).toBe("403:no_receipt");
  });

  it("a relayer that returns no event yields no key", async () => {
    const r0 = await rig();
    const silent = { ...r0.chain.writer("s"), account: "s", openSession: async () => ({ txHash: "x", events: [] }) };
    const r = await rig({ relayer: silent as never });
    const link = await giveAccess(r);
    expect(await code(r.svc.openSession(openRequest(r, link).req))).toBe("403:no_receipt");
  });
});

describe("A2: no release after revoke, expiry, epoch change, budget exhaustion", () => {
  it("revoke mid-session stops the very next release", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    expect((await r.svc.release(v.token, ITEM, [0])).length).toBe(1);
    await r.owner.revokeGrant(link.grantId);
    expect(await code(r.svc.release(v.token, ITEM, [1]))).toBe("403:denied");
    expect(await code(r.svc.renew(v.token))).toBe("403:denied");
    expect(await code(r.svc.ticket(v.token, BLOB))).toBe("403:denied");
  });

  it("revoked, expired, epoch-bumped and exhausted grants cannot open", async () => {
    const r = await rig();
    const a = await giveAccess(r, 1);
    await r.owner.revokeGrant(a.grantId);
    expect(await code(r.svc.openSession(openRequest(r, a).req))).toBe("403:denied");

    const b = await giveAccess(r, 2, { durationMs: 120_000 });
    r.chain.advance(121_000);
    expect(await code(r.svc.openSession(openRequest(r, b).req))).toBe("403:denied");

    const c = await giveAccess(r, 3);
    r.chain.completeDealFor(BOX, "buyer.testnet");
    expect(await code(r.svc.openSession(openRequest(r, c).req))).toBe("403:denied");
  });

  it("expiry is judged on chain time: a live session loses keys after not_after", async () => {
    const r = await rig();
    const link = await giveAccess(r, 1, { durationMs: 200_000 });
    const v = await visit(r, link);
    r.chain.advance(100_000);
    expect((await r.svc.release(v.token, ITEM, [0])).length).toBe(1);
    r.chain.advance(101_000);
    expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("403:lease");
  });

  it("epoch bump (deal completion) stops release in a running session", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    r.chain.completeDealFor(BOX, "buyer.testnet");
    expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("403:denied");
  });

  it("budget: max_sessions=1 allows one visit, even after close", async () => {
    const r = await rig();
    const link = await giveAccess(r, 1, { maxSessions: 1 });
    const v = await visit(r, link);
    await r.svc.close(v.token);
    expect(await code(r.svc.openSession(openRequest(r, link).req))).toBe("403:denied");
  });

  it("fast revoke path: DELETE removes the S2 vector and ends the lease here", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    await r.svc.deleteGrant(link.grantId, auth(OWNER_SEED, link.grantId, sha256(new Uint8Array()), r.chain.now()));
    expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("403:lease");
    expect(r.store.get(link.grantId)).toBeNull();
  });
});

describe("A3: neither half alone yields the key", () => {
  it("S1 and S2 look uniform and each differs from the key", async () => {
    const r = await rig();
    const link = await giveAccess(r, 1, { segs: 3 });
    const m = r.store.get(link.grantId)!;
    for (let s = 0; s < 3; s++) {
      expect(m.scope.items[0]!.segments[s]!.s2).not.toBe(bytesToHex(link.segmentKeys[s]!));
    }
    // chi-squared over S2 bytes from many independent grants' seeds (256 bins, 255 d.o.f.; 99.9% critical value ~ 330)
    const { split, kdf, randomBytes } = await import("@keyhole/crypto");
    const counts = new Array<number>(256).fill(0);
    const sk = kdf.segmentKey(seed(8), 0);
    const N = 2048;
    for (let i = 0; i < N; i++) for (const b of split.s2(sk, split.s1(randomBytes(32), hexToBytes(ITEM), 0))) counts[b] = (counts[b] ?? 0) + 1;
    const exp = (N * 32) / 256;
    const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(330);
  });
});

describe("A4/A5: forged opens, duplicates, budget, one active session per link", () => {
  it("a bad or tampered open is refused before the relayer is used, with backoff", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const { req } = openRequest(r, link);
    const before = r.chain.calls.length;
    expect(await code(r.svc.openSession({ ...req, sessionPk: hexN(9, 32) }))).toBe("403:denied"); // pk changed after signing
    expect(r.chain.calls.length).toBe(before);
    expect(await code(r.svc.openSession(req))).toBe("429:backoff"); // immediately after a failure
    r.chain.advance(10_000);
    expect(await code(r.svc.openSession(req))).toBe("ok");
  });

  it("a signature from the wrong key never opens (RS cannot open without the recipient key)", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const { req } = openRequest(r, { ...link, reqSeed: seed(200) });
    expect(await code(r.svc.openSession(req))).toBe("403:denied");
  });

  it("one active session per link; a new one is possible after close and consumes budget", async () => {
    const r = await rig();
    const link = await giveAccess(r, 1, { maxSessions: 3 });
    const v1 = await visit(r, link);
    expect(await code(r.svc.openSession(openRequest(r, link).req))).toBe("403:active_session");
    await r.svc.close(v1.token);
    const v2 = await visit(r, link);
    expect(v2.seq).toBe(3); // open, close, open
    expect((await r.chain.grant(link.grantId))?.sessions_used).toBe(2);
  });

  it("a replayed session id is rejected", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const { req } = openRequest(r, link);
    await r.svc.openSession(req);
    expect(await code(r.svc.openSession(req))).toBe("403:active_session");
  });

  it("concurrent opens on one grant: exactly one wins", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const out = await Promise.all([r.svc.openSession(openRequest(r, link).req), r.svc.openSession(openRequest(r, link).req)].map((p) => code(p)));
    expect(out.filter((x) => x === "ok").length).toBe(1);
  });
});

describe("A6: release only inside the scope", () => {
  it("unknown items, unlisted segments, mixed batches and bad input release nothing", async () => {
    const r = await rig();
    const link = await giveAccess(r, 1, { segs: 2 });
    const v = await visit(r, link);
    expect(await code(r.svc.release(v.token, hexN(7, 16), [0]))).toBe("403:denied");
    expect(await code(r.svc.release(v.token, ITEM, [5]))).toBe("403:denied");
    expect(await code(r.svc.release(v.token, ITEM, [0, 5]))).toBe("403:denied");
    expect(await code(r.svc.release(v.token, ITEM, []))).toBe("400:bad_request");
    expect(await code(r.svc.release(v.token, "zz", [0]))).toBe("400:bad_request");
    expect(await code(r.svc.release("nope", ITEM, [0]))).toBe("403:denied");
    const log = (await r.svc.boxEvents(BOX, auth(OWNER_SEED, BOX, authBody("box-events", hexToBytes(BOX)), r.chain.now())))[0]!.log;
    expect(log.filter((e) => e.action === "release").length).toBe(0);
  });
});

describe("A7: receipts and the signed log", () => {
  it("open and close extend the on-chain chain; owner feed matches and its log signature verifies", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    await r.svc.release(v.token, ITEM, [0, 1]);
    const closed = await r.svc.close(v.token);
    const feed = await r.svc.boxEvents(BOX, auth(OWNER_SEED, BOX, authBody("box-events", hexToBytes(BOX)), r.chain.now()));
    expect(feed.length).toBe(1);
    const rec = feed[0]!;
    expect(rec.log.map((e) => e.action)).toEqual(["open", "release", "release"]);
    // the raw inputs of the receipt are in the feed, and the close receipt (seq 2) carries the log root that was committed
    expect(rec.session_pk).toBe(v.sessionPk);
    expect(rec.close).toMatchObject({ seq: 2, log_root: closed.log_root });
    expect(rec.requester_digest).toBe(bytesToHex(receipt.requesterDigestBearer(sig.publicKey(link.reqSeed))));
    expect(rec.log_head).toBe(closed.log_root);
    expect(sig.verify(sig.publicKey(seed(2)), logHeadMsg(rec.session_id, hexToBytes(rec.log_head), rec.log.length), hexToBytes(rec.log_sig))).toBe(true);
    // chain: genesis -> open commitment -> close commitment
    const b = (await r.chain.box(BOX))!;
    expect(b.receipts_seq).toBe(2);
    const closeC = receipt.closeCommitment(hexToBytes(v.sessionId), hexToBytes(closed.log_root), (await r.chain.session(v.sessionId))!.closed_at!);
    expect(b.receipts_head).toBe(bytesToHex(receipt.recomputeChain([hexToBytes(rec.commitment), closeC])));
    // the session is closed: no more keys
    expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("403:denied");
  });

  it("the owner feed needs the owner's key", async () => {
    const r = await rig();
    await giveAccess(r);
    const body = authBody("box-events", hexToBytes(BOX));
    expect(await code(r.svc.boxEvents(BOX, auth(seed(4), BOX, body, r.chain.now())))).toBe("403:denied"); // bob's key
    expect(await code(r.svc.boxEvents(BOX, auth(seed(77), BOX, body, r.chain.now())))).toBe("403:denied");
    expect(await code(r.svc.boxEvents(BOX, auth(OWNER_SEED, BOX, body, r.chain.now() - 10 * 60_000)))).toBe("403:denied"); // stale
    expect(await code(r.svc.boxEvents(BOX, auth(OWNER_SEED, BOX, body, r.chain.now())))).toBe("ok");
  });
});

describe("A8: rate limits", () => {
  it("30 segments a minute per grant, measured on chain time", async () => {
    const r = await rig({ segmentsPerMinute: 30 });
    const link = await giveAccess(r, 1, { segs: 40 });
    const v = await visit(r, link);
    for (let i = 0; i < 30; i++) await r.svc.release(v.token, ITEM, [i]);
    expect(await code(r.svc.release(v.token, ITEM, [30]))).toBe("429:rate_limited");
    r.chain.advance(61_000);
    await r.svc.renew(v.token);
    expect(await code(r.svc.release(v.token, ITEM, [30]))).toBe("ok");
  });
});

describe("A9: fail closed", () => {
  it("RPC loss stops opens and releases", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    r.chain.setDown(true);
    expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("503:unavailable");
    expect(await code(r.svc.openSession(openRequest(r, link).req))).toBe("503:unavailable");
    r.chain.setDown(false);
    expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("ok");
  });

  it("the local clock is never consulted: shifting it by hours changes nothing", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5 * 3600_000);
      const v = await visit(r, link);
      expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("ok");
      vi.setSystemTime(Date.now() - 20 * 3600_000);
      expect(await code(r.svc.release(v.token, ITEM, [1]))).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lease: keys stop at lease end on chain time; renew extends while the grant is valid", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    r.chain.advance(250_000);
    const { lease_exp } = await r.svc.renew(v.token);
    expect(lease_exp).toBeGreaterThan(v.leaseExp);
    r.chain.advance(250_000);
    expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("ok");
    r.chain.advance(350_000);
    expect(await code(r.svc.release(v.token, ITEM, [0]))).toBe("403:lease");
  });
});

describe("scope upload (owner)", () => {
  it("rejects wrong signer, stale time, scope hash mismatch and malformed bodies", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const body = new TextEncoder().encode(JSON.stringify({ scope: link.scope }));
    const h = sha256(body);
    expect(await code(r.svc.putScope(link.grantId, body, auth(seed(4), link.grantId, h, r.chain.now())))).toBe("403:denied");
    expect(await code(r.svc.putScope(link.grantId, body, auth(OWNER_SEED, link.grantId, h, r.chain.now() - 600_000)))).toBe("403:denied");
    const tampered = structuredClone(link.scope);
    tampered.items[0]!.segments.pop();
    const tb = new TextEncoder().encode(JSON.stringify({ scope: tampered }));
    expect(await code(r.svc.putScope(link.grantId, tb, auth(OWNER_SEED, link.grantId, sha256(tb), r.chain.now())))).toBe("403:scope_hash");
    const bad = new TextEncoder().encode("{}");
    expect(await code(r.svc.putScope(link.grantId, bad, auth(OWNER_SEED, link.grantId, sha256(bad), r.chain.now())))).toBe("400:bad_request");
    // a signature over a different body does not authorize this one
    expect(await code(r.svc.putScope(link.grantId, body, auth(OWNER_SEED, link.grantId, sha256(bad), r.chain.now())))).toBe("403:denied");
    // grant that does not exist on chain
    expect(await code(r.svc.putScope(hexN(0xee, 16), body, auth(OWNER_SEED, hexN(0xee, 16), h, r.chain.now())))).toBe("403:denied");
  });

  it("an ex-owner key stops working after the box changes owner", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    r.chain.completeDealFor(BOX, "buyer.testnet");
    const body = new TextEncoder().encode(JSON.stringify({ scope: link.scope }));
    expect(await code(r.svc.putScope(link.grantId, body, auth(OWNER_SEED, link.grantId, sha256(body), r.chain.now())))).toBe("403:denied");
  });
});

describe("deal key release (spec 06 section 5)", () => {
  const DEAL = hexN(0xd1, 16);
  const B2 = new Uint8Array(32).fill(0x42);
  const deal = (state: "Ready" | "Funded" | "Completed", commit = dealS2Commit(DEAL, B2)) => ({
    deal_id: DEAL, box_id: BOX, seller: "seller.testnet", buyer: "buyer.testnet", price: "1", state, created_at: 0, offer_expires_at: 0,
    waiting_ms: 0, waiting_until: null, manifest_blob: hexN(1, 32), manifest_seq: 1, bmk_commit: hexN(2, 32), envelope_blob: hexN(3, 32), s2_commit: commit, funded: "0",
  });

  it("seller leaves B2 and gets a verifiable ack; buyer gets it sealed only after Completed", async () => {
    const r = await rig();
    r.chain.setDeal(deal("Funded"));
    const put = await r.svc.putDealS2(DEAL, bytesToHex(B2), auth(seed(5), DEAL, authBody("deal-put", B2), r.chain.now()));
    expect(sig.verify(sig.publicKey(seed(2)), dealAckMsg(DEAL, put.s2_commit), hexToBytes(put.ack))).toBe(true);

    const buyerSk = seed(150);
    const buyerPk = seal.x25519PublicKey(buyerSk);
    const reqKey = () => auth(seed(6), DEAL, authBody("deal-key", buyerPk), r.chain.now());
    expect(await code(r.svc.getDealKey(DEAL, bytesToHex(buyerPk), reqKey()))).toBe("403:denied"); // still Funded
    r.chain.setDeal(deal("Completed"));
    const got = await r.svc.getDealKey(DEAL, bytesToHex(buyerPk), reqKey());
    expect(bytesToHex(seal.openSealed(buyerSk, hexToBytes(got.sealed)))).toBe(bytesToHex(B2));
    // the seller (or anyone else) cannot fetch it, and a request for another key cannot be reused
    expect(await code(r.svc.getDealKey(DEAL, bytesToHex(buyerPk), auth(seed(5), DEAL, authBody("deal-key", buyerPk), r.chain.now())))).toBe("403:denied");
    const other = seal.x25519PublicKey(seed(151));
    expect(await code(r.svc.getDealKey(DEAL, bytesToHex(other), reqKey()))).toBe("403:denied");
  });

  it("RS refuses a B2 that does not match the on-chain commitment, and non-sellers", async () => {
    const r = await rig();
    r.chain.setDeal(deal("Ready"));
    const wrong = new Uint8Array(32).fill(0x43);
    expect(await code(r.svc.putDealS2(DEAL, bytesToHex(wrong), auth(seed(5), DEAL, authBody("deal-put", wrong), r.chain.now())))).toBe("403:s2_commit");
    expect(await code(r.svc.putDealS2(DEAL, bytesToHex(B2), auth(seed(6), DEAL, authBody("deal-put", B2), r.chain.now())))).toBe("403:denied");
  });

  it("a deal that completed but never got B2 releases nothing", async () => {
    const r = await rig();
    r.chain.setDeal(deal("Completed"));
    const pk = seal.x25519PublicKey(seed(150));
    expect(await code(r.svc.getDealKey(DEAL, bytesToHex(pk), auth(seed(6), DEAL, authBody("deal-key", pk), r.chain.now())))).toBe("403:denied");
  });
});

void OWNER;
void pkHex;

describe("review fixes: lockout, replay, close retry, key half before the offer", () => {
  it("S7: bad opens from one caller do not lock the grant for another caller", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const bad = openRequest(r, { ...link, reqSeed: seed(201) }).req;
    for (let i = 0; i < 5; i++) await code(r.svc.openSession(bad, "attacker-ip"));
    expect(await code(r.svc.openSession(bad, "attacker-ip"))).toBe("429:backoff");
    expect(await code(r.svc.openSession(openRequest(r, link).req, "recipient-ip"))).toBe("ok");
  });

  it("S8: a signed owner request is accepted once; a captured copy is refused", async () => {
    const r = await rig();
    await giveAccess(r);
    const a = auth(OWNER_SEED, BOX, authBody("box-events", hexToBytes(BOX)), r.chain.now());
    expect(await code(r.svc.boxEvents(BOX, a))).toBe("ok");
    expect(await code(r.svc.boxEvents(BOX, a))).toBe("403:replay");
    expect(await code(r.svc.boxEvents(BOX, auth(OWNER_SEED, BOX, authBody("box-events", hexToBytes(BOX)), r.chain.now() + 1)))).toBe("ok");
  });

  it("S13: a close that fails on chain can be retried and then commits the same log root", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const v = await visit(r, link);
    await r.svc.release(v.token, ITEM, [0]);
    r.chain.setDown(true);
    expect(await code(r.svc.close(v.token))).toBe("503:unavailable");
    r.chain.setDown(false);
    const done = await r.svc.close(v.token);
    expect((await r.chain.session(v.sessionId))?.log_root).toBe(done.log_root);
    expect(await code(r.svc.close(v.token))).toBe("403:denied");
  });

  it("S2: the box owner leaves the key half before the offer exists and gets an acknowledgement the contract accepts", async () => {
    const r = await rig();
    const DEAL = hexN(0xd7, 16);
    const B2 = new Uint8Array(32).fill(0x55);
    const put = await r.svc.putDealS2(DEAL, bytesToHex(B2), auth(OWNER_SEED, DEAL, authBody("deal-put", B2), r.chain.now()), BOX);
    expect(put.s2_commit).toBe(dealS2Commit(DEAL, B2));
    expect(sig.verify(sig.publicKey(seed(2)), dealAckMsg(DEAL, put.s2_commit), hexToBytes(put.ack))).toBe(true);
    // not the owner of that box
    const other = new Uint8Array(32).fill(0x56);
    expect(await code(r.svc.putDealS2(hexN(0xd8, 16), bytesToHex(other), auth(seed(4), hexN(0xd8, 16), authBody("deal-put", other), r.chain.now()), BOX))).toBe("403:denied");
    // a different key half for the same deal id does not replace the first
    expect(await code(r.svc.putDealS2(DEAL, bytesToHex(other), auth(OWNER_SEED, DEAL, authBody("deal-put", other), r.chain.now() + 1), BOX))).toBe("403:s2_commit");
    // no deal and no box named: refused
    expect(await code(r.svc.putDealS2(hexN(0xd9, 16), bytesToHex(B2), auth(OWNER_SEED, hexN(0xd9, 16), authBody("deal-put", B2), r.chain.now() + 2)))).toBe("403:denied");
    // the fake contract accepts the offer only with this acknowledgement
    const blob = hexN(0xe1, 32);
    await r.owner.registerBlob({ blobId: blob, boxId: BOX, size: 65536, days: 1 });
    const rec = (await r.chain.blob(blob))!;
    const { msgs } = await import("@keyhole/crypto");
    await r.chain.writer("x").certifyBlob(blob, [{ idx: 0, sig: bytesToHex(sig.sign(seed(1), msgs.ackMsg("testnet", "keyhole.testnet", rec.reg_id, hexToBytes(blob), 0, rec.paid_until))) }]);
    await r.owner.activateBlob(blob);
    await r.owner.commitManifest({ boxId: BOX, manifestBlob: blob, seq: 1 });
    const seller = r.chain.writer(OWNER);
    const offer = { dealId: DEAL, boxId: BOX, buyer: "buyer.testnet", priceYocto: "1", waitingMs: 1000, offerExpiresAtMs: r.chain.now() + 60_000, bmkCommit: hexN(1, 32), envelopeBlob: blob, s2Commit: put.s2_commit, rsIdx: put.rs_idx };
    await expect(seller.createDeal({ ...offer, rsAck: "00".repeat(64) })).rejects.toThrow("acknowledgement is not valid");
    await seller.createDeal({ ...offer, rsAck: put.ack });
    expect((await r.chain.deal(DEAL))?.state).toBe("Ready");
  });
});

describe("sponsor (testnet)", () => {
  it("funds an implicit account once, refuses everything else, and caps the total", async () => {
    const r = await rig();
    const acct = "ab".repeat(32);
    const out = await r.svc.sponsor(acct);
    expect(out.amount).toBe("500000000000000000000000");
    expect(r.chain.calls.some((c) => c.method.startsWith(`transfer:${acct}`))).toBe(true);
    expect(await code(r.svc.sponsor(acct))).toBe("403:already_funded");
    expect(await code(r.svc.sponsor("alice.testnet"))).toBe("400:bad_request");
    expect(await code(r.svc.sponsor("zz".repeat(32)))).toBe("400:bad_request");
    const capped = await rig({ sponsorMax: 1 });
    await capped.svc.sponsor("cd".repeat(32));
    expect(await code(capped.svc.sponsor("ef".repeat(32)))).toBe("429:sponsor_cap");
  });
});
