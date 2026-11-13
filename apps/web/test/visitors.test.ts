import { describe, expect, it } from "vitest";
import { FakeChain } from "@keyhole/chain";
import { bytesToHex, hexToBytes, msgs, receipt, sig } from "@keyhole/crypto";
import { verifyLog } from "../src/lib/visitors";
import type { FeedRecord } from "../src/lib/visitors";

const seed = (n: number) => new Uint8Array(32).fill(n);
const hexN = (n: number, len: number) => bytesToHex(new Uint8Array(len).fill(n));

/** Builds a real chain history (2 sessions, one closed) and the matching feed the release service would give. */
async function history() {
  const rsSeed = seed(2);
  const chain = new FakeChain({ nodeKeys: [bytesToHex(sig.publicKey(seed(1)))], rsKeys: [bytesToHex(sig.publicKey(rsSeed))] });
  const owner = chain.writer("alice.testnet");
  const boxId = hexN(0xb1, 16);
  await owner.createBox({ boxId, kind: "Handover", wrappedBmk: new Uint8Array(4), maxGrantMs: 3_600_000 });
  const feed: FeedRecord[] = [];
  const reqSeed = seed(9);
  const reqPk = sig.publicKey(reqSeed);
  const gid = hexN(0xa1, 16);
  await owner.createGrant({ grantId: gid, boxId, requester: { bearer: bytesToHex(reqPk) }, mode: "View", notBeforeMs: chain.now(), notAfterMs: chain.now() + 600_000, maxSessions: 3, scopeHash: hexN(1, 32), policyHash: hexN(2, 32) });
  for (const [n, close] of [[1, true], [2, false]] as const) {
    const sid = hexN(0x50 + n, 16), spk = hexN(0x70 + n, 32);
    const ts = chain.now();
    const reqSig = bytesToHex(sig.sign(reqSeed, msgs.openMsg("testnet", "keyhole.testnet", hexToBytes(gid), hexToBytes(sid), hexToBytes(spk), ts)));
    const tx = await chain.writer("relayer").openSession({ grantId: gid, sessionId: sid, sessionPk: spk, tsMs: ts, reqSig });
    const ev = tx.events[0]!.data as { seq: number; head: string; commitment: string };
    const s = (await chain.session(sid))!;
    const rec: FeedRecord = { seq: ev.seq, grant_id: gid, session_id: sid, session_pk: spk, requester_digest: bytesToHex(receipt.requesterDigestBearer(reqPk)), commitment: ev.commitment, head: ev.head, opened_at: s.opened_at, tx_hash: tx.txHash, closed: false, close: null, log: [] };
    if (close) {
      const root = hexN(0x44, 32), at = chain.now();
      const cs = bytesToHex(sig.sign(rsSeed, msgs.closeMsg("testnet", "keyhole.testnet", hexToBytes(sid), hexToBytes(root), at)));
      const ctx = await chain.writer("relayer").closeSession({ sessionId: sid, logRoot: root, closedAtMs: at, rsIdx: 0, rsSig: cs });
      const ce = ctx.events[0]!.data as { seq: number; head: string; commitment: string };
      rec.closed = true;
      rec.close = { seq: ce.seq, head: ce.head, commitment: ce.commitment, closed_at: at, log_root: root, tx_hash: ctx.txHash };
    }
    feed.push(rec);
    chain.advance(1000);
  }
  return { chain, boxId, feed };
}

describe("visitor log verification", () => {
  it("an intact log is Verified: 3 receipts recomputed from the chain's own records equal the contract's head", async () => {
    const { chain, boxId, feed } = await history();
    const v = await verifyLog(feed, boxId, chain);
    expect(v).toMatchObject({ ok: true, reason: "", onChain: 3 });
    expect(v.rows.map((r) => `${r.seq}:${r.kind}`)).toEqual(["1:opened", "2:closed", "3:opened"]);
    expect(v.rows.every((r) => r.ok)).toBe(true);
  });

  it("deleting a row breaks it and names the missing receipt", async () => {
    const { chain, boxId, feed } = await history();
    const noClose = feed.map((r) => ({ ...r, close: null }));
    expect(await verifyLog(noClose, boxId, chain)).toMatchObject({ ok: false, reason: "Receipt 2 of 3 is missing from the log." });
    const noSecond = feed.slice(0, 1);
    expect((await verifyLog(noSecond, boxId, chain)).ok).toBe(false);
    expect((await verifyLog([], boxId, chain)).reason).toContain("Receipt 1 of 3");
  });

  it("editing a row breaks it", async () => {
    const { chain, boxId, feed } = await history();
    const edited = feed.map((r, i) => (i === 0 ? { ...r, session_pk: hexN(0x99, 32) } : r)); // someone changes what the receipt says
    expect(await verifyLog(edited, boxId, chain)).toMatchObject({ ok: false });
    expect((await verifyLog(edited, boxId, chain)).reason).toContain("altered");
    const forgedClose = feed.map((r) => (r.close ? { ...r, close: { ...r.close, commitment: hexN(7, 32) } } : r));
    expect((await verifyLog(forgedClose, boxId, chain)).ok).toBe(false);
    const swapped = [feed[1]!, feed[0]!]; // order does not matter, content does
    expect((await verifyLog(swapped, boxId, chain)).ok).toBe(true);
  });

  it("an extra receipt the contract does not have is caught", async () => {
    const { chain, boxId, feed } = await history();
    const extra: FeedRecord = { ...feed[1]!, seq: 9, session_id: hexN(0x55, 16) };
    expect((await verifyLog([...feed, extra], boxId, chain)).ok).toBe(false);
  });
});
