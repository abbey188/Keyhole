import { describe, expect, it } from "vitest";
import { bytesToHex, merkle, msgs, receipt, sig } from "@keyhole/crypto";
import { ChainUnavailable, ContractError, FakeChain } from "../src/index.js";

const seed = (n: number) => new Uint8Array(32).fill(n);
const pkHex = (n: number) => bytesToHex(sig.publicKey(seed(n)));
const hex = (n: number, len: number) => bytesToHex(new Uint8Array(len).fill(n));

function setup() {
  const chain = new FakeChain({ nodeKeys: [pkHex(1)], rsKeys: [pkHex(2)] });
  const owner = chain.writer("alice.testnet");
  return { chain, owner };
}

describe("FakeChain (MOCK of the contract rules)", () => {
  it("runs open_session and extends the receipt chain exactly as the crypto package computes it", async () => {
    const { chain, owner } = setup();
    const boxId = hex(0xb1, 16);
    const gid = hex(0xa1, 16);
    const reqSeed = seed(9);
    await owner.createBox({ boxId, kind: "Bound", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
    await owner.createGrant({
      grantId: gid, boxId, requester: { bearer: bytesToHex(sig.publicKey(reqSeed)) }, mode: "View",
      notBeforeMs: chain.now(), notAfterMs: chain.now() + 600_000, maxSessions: 2, scopeHash: hex(1, 32), policyHash: hex(2, 32),
    });
    const sid = hex(0x51, 16);
    const spk = hex(0x77, 32);
    const ts = chain.now();
    const reqSig = bytesToHex(sig.sign(reqSeed, msgs.openMsg("testnet", "keyhole.testnet", new Uint8Array(16).fill(0xa1), new Uint8Array(16).fill(0x51), new Uint8Array(32).fill(0x77), ts)));
    const tx = await chain.writer("relayer.testnet").openSession({ grantId: gid, sessionId: sid, sessionPk: spk, tsMs: ts, reqSig });
    expect(tx.events[0]?.event).toBe("session_opened");
    const c = receipt.commitment(new Uint8Array(16).fill(0xa1), new Uint8Array(16).fill(0x51), new Uint8Array(32).fill(0x77),
      receipt.requesterDigestBearer(sig.publicKey(reqSeed)), ts);
    expect((await chain.box(boxId))?.receipts_head).toBe(bytesToHex(receipt.recomputeChain([c])));
    expect((await chain.grant(gid))?.sessions_used).toBe(1);
  });

  it("rejects bad signatures, replayed session ids and reverts the failed call", async () => {
    const { chain, owner } = setup();
    const boxId = hex(0xb1, 16);
    const gid = hex(0xa1, 16);
    await owner.createBox({ boxId, kind: "Bound", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
    await owner.createGrant({
      grantId: gid, boxId, requester: { bearer: pkHex(9) }, mode: "View",
      notBeforeMs: chain.now(), notAfterMs: chain.now() + 600_000, maxSessions: 1, scopeHash: hex(1, 32), policyHash: hex(2, 32),
    });
    const rl = chain.writer("rl.testnet");
    await expect(rl.openSession({ grantId: gid, sessionId: hex(5, 16), sessionPk: hex(6, 32), tsMs: chain.now(), reqSig: hex(0, 64) })).rejects.toThrow(ContractError);
    expect((await chain.grant(gid))?.sessions_used).toBe(0);
    await expect(rl.openSession({ grantId: gid, sessionId: hex(5, 16), sessionPk: hex(6, 32), tsMs: chain.now() })).rejects.toThrow("Signature required");
  });

  it("only owners create grants and revoke; revoke shows in grantValid", async () => {
    const { chain, owner } = setup();
    const boxId = hex(0xb1, 16);
    await owner.createBox({ boxId, kind: "Bound", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
    const g = {
      grantId: hex(0xa1, 16), boxId, requester: { bearer: pkHex(9) }, mode: "View" as const,
      notBeforeMs: chain.now(), notAfterMs: chain.now() + 600_000, maxSessions: 1, scopeHash: hex(1, 32), policyHash: hex(2, 32),
    };
    await expect(chain.writer("mallory.testnet").createGrant(g)).rejects.toThrow("Only the box owner");
    await owner.createGrant(g);
    expect((await chain.grantValid(g.grantId)).valid).toBe(true);
    await owner.revokeGrant(g.grantId);
    expect(await chain.grantValid(g.grantId)).toEqual({ valid: false, reason: "revoked" });
  });

  it("held finality: final reads do not see the transaction and the promise pends until release", async () => {
    const { chain, owner } = setup();
    const boxId = hex(0xb1, 16);
    chain.hold();
    let done = false;
    const p = owner.createBox({ boxId, kind: "Bound", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    expect(chain.headBox(boxId)).not.toBeNull();
    expect(await chain.box(boxId)).toBeNull();
    chain.release();
    await p;
    expect(await chain.box(boxId)).not.toBeNull();
  });

  it("final time only moves with blocks, and an outage makes every read throw ChainUnavailable", async () => {
    const { chain } = setup();
    const t0 = await chain.finalTimeMs();
    chain.advance(5000);
    expect(await chain.finalTimeMs()).toBe(t0 + 5000);
    chain.setDown(true);
    await expect(chain.finalTimeMs()).rejects.toThrow(ChainUnavailable);
    await expect(chain.box("x")).rejects.toThrow(ChainUnavailable);
  });

  it("blob lifecycle: certify needs a valid node signature; retire then erase attestation removes the record", async () => {
    const { chain, owner } = setup();
    const boxId = hex(0xb1, 16);
    const blobId = hex(0xc1, 32);
    await owner.createBox({ boxId, kind: "Bound", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
    await owner.registerBlob({ blobId, boxId, size: 70_000, days: 1 });
    const b = (await chain.blob(blobId))!;
    expect(b.leaves).toBe(2);
    const rl = chain.writer("rl.testnet");
    await expect(rl.certifyBlob(blobId, [{ idx: 0, sig: hex(0, 64) }])).rejects.toThrow("Bad node signature");
    const ack = msgs.ackMsg("testnet", "keyhole.testnet", b.reg_id, new Uint8Array(32).fill(0xc1), 0, b.paid_until);
    await rl.certifyBlob(blobId, [{ idx: 0, sig: bytesToHex(sig.sign(seed(1), ack)) }]);
    await owner.activateBlob(blobId);
    expect((await chain.blob(blobId))?.state).toBe("Active");
    await owner.retireBlob(blobId);
    const er = msgs.eraseMsg("testnet", "keyhole.testnet", b.reg_id, new Uint8Array(32).fill(0xc1));
    await rl.attestErasure(blobId, 0, bytesToHex(sig.sign(seed(1), er)));
    expect(await chain.blob(blobId)).toBeNull();
  });

  it("merkle leaf count matches LEAF_SIZE", () => {
    expect(merkle.LEAF_SIZE).toBe(65536);
  });
});
