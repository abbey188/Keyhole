// Named-account requesters: the account opens the session itself, then attaches it to the release service.
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, kdf, randomBytes, seal, split } from "@keyhole/crypto";
import { ReleaseError, authBody, scopeHash } from "../src/index.js";
import type { Scope } from "../src/index.js";
import { ITEM, BLOB, BOX, OWNER_SEED, auth, giveAccess, hexN, openRequest, rig, seed, sha256 } from "./helpers.js";
import type { Rig } from "./helpers.js";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ReleaseError ? `${e.status}:${e.code}` : `other:${String(e)}`;
  }
};
const BOB = "bob.testnet";
const BOB_SEED = seed(4);

async function accountGrant(r: Rig, n = 1) {
  const s1seed = randomBytes(32);
  const dek = kdf.itemDek(kdf.epochKey(seed(99), 0), hexToBytes(ITEM));
  const sks = [0, 1].map((s) => kdf.segmentKey(dek, s));
  const scope: Scope = { items: [{ item_uid: ITEM, blob_id: BLOB, segments: sks.map((sk, s) => ({ s, s2: bytesToHex(split.s2(sk, split.s1(s1seed, hexToBytes(ITEM), s))) })) }] };
  const grantId = hexN(0xc0 + n, 16);
  await r.owner.createGrant({ grantId, boxId: BOX, requester: { account: BOB }, mode: "View", notBeforeMs: r.chain.now(), notAfterMs: r.chain.now() + 900_000, maxSessions: 3, scopeHash: scopeHash(scope), policyHash: hexN(2, 32) });
  const body = new TextEncoder().encode(JSON.stringify({ scope }));
  await r.svc.putScope(grantId, body, auth(OWNER_SEED, grantId, sha256(body), r.chain.now()));
  return { grantId, s1seed, sks };
}

/** The named account's own transaction. */
async function bobOpens(r: Rig, grantId: string, sessionId = hexN(0x71, 16)) {
  const sk = new Uint8Array(randomBytes(32));
  const pk = bytesToHex(seal.x25519PublicKey(sk));
  const tx = await r.chain.writer(BOB).openSession({ grantId, sessionId, sessionPk: pk, tsMs: r.chain.now() });
  return { sk, pk, sessionId, txHash: tx.txHash };
}
let tick = 0; // each request is signed with its own timestamp: a signed request is accepted only once
const attachAuth = (r: Rig, signer: Uint8Array, sessionId: string, pk: string, ts = r.chain.now() + ++tick) => auth(signer, sessionId, authBody("session-attach", hexToBytes(pk)), ts);

describe("named-account requesters", () => {
  it("the account opens on chain, attaches, and then gets keys exactly like a bearer link", async () => {
    const r = await rig();
    const g = await accountGrant(r);
    const o = await bobOpens(r, g.grantId);
    const res = await r.svc.attachSession({ txHash: o.txHash, grantId: g.grantId, sessionId: o.sessionId, sessionPk: o.pk }, attachAuth(r, BOB_SEED, o.sessionId, o.pk));
    expect(res.seq).toBe(1);
    const [k] = await r.svc.release(res.token, ITEM, [1]);
    const sk = split.combine(split.s1(g.s1seed, hexToBytes(ITEM), 1), seal.openSealed(o.sk, hexToBytes(k!.sealed)));
    expect(bytesToHex(sk)).toBe(bytesToHex(g.sks[1]!));
    // revoke stops it like any other session
    await r.owner.revokeGrant(g.grantId);
    expect(await code(r.svc.release(res.token, ITEM, [0]))).toBe("403:denied");
  });

  it("only the named account's key can attach", async () => {
    const r = await rig();
    const g = await accountGrant(r);
    const o = await bobOpens(r, g.grantId);
    const req = { txHash: o.txHash, grantId: g.grantId, sessionId: o.sessionId, sessionPk: o.pk };
    expect(await code(r.svc.attachSession(req, attachAuth(r, seed(5), o.sessionId, o.pk)))).toBe("403:denied"); // seller.testnet's key
    expect(await code(r.svc.attachSession(req, attachAuth(r, seed(77), o.sessionId, o.pk)))).toBe("403:denied"); // unknown key
    expect(await code(r.svc.attachSession(req, attachAuth(r, BOB_SEED, o.sessionId, o.pk, r.chain.now() - 600_000)))).toBe("403:denied"); // stale
    expect(await code(r.svc.attachSession(req, attachAuth(r, BOB_SEED, o.sessionId, hexN(1, 32))))).toBe("403:denied"); // signed for another session key
  });

  it("the session key must be the one in the on-chain receipt, and the transaction must be this account's open of this grant", async () => {
    const r = await rig();
    const g = await accountGrant(r, 1);
    const g2 = await accountGrant(r, 2);
    const o = await bobOpens(r, g.grantId);
    const other = await bobOpens(r, g2.grantId, hexN(0x72, 16));
    const evil = hexN(0xee, 32); // an attacker's session key, signed for by the account (e.g. a confused client)
    const send = (txHash: string, grantId: string, sessionId: string, pk: string) => code(r.svc.attachSession({ txHash, grantId, sessionId, sessionPk: pk }, attachAuth(r, BOB_SEED, sessionId, pk)));
    expect(await send(o.txHash, g.grantId, o.sessionId, evil)).toBe("403:no_receipt"); // commitment does not match the key
    expect(await send(other.txHash, g.grantId, o.sessionId, o.pk)).toBe("403:no_receipt"); // another session's transaction
    expect(await send("nope-nope-nope", g.grantId, o.sessionId, o.pk)).toBe("403:no_receipt"); // unknown transaction
    expect(await send(o.txHash, g.grantId, hexN(0x99, 16), o.pk)).toBe("403:no_receipt"); // session id that was never opened
    // a transaction signed by someone else is looked up under the account and not found
    const alice = await r.chain.writer("alice.testnet").createBox({ boxId: hexN(0xb7, 16), kind: "Bound", wrappedBmk: new Uint8Array(1), maxGrantMs: 3_600_000 });
    expect(await send(alice.txHash, g.grantId, o.sessionId, o.pk)).toBe("403:no_receipt");
    expect(await send(o.txHash, g.grantId, o.sessionId, o.pk)).toBe("ok");
  });

  it("one attach per session, one active session per link, and not before the receipt is final", async () => {
    const r = await rig();
    const g = await accountGrant(r);
    const o = await bobOpens(r, g.grantId);
    const req = { txHash: o.txHash, grantId: g.grantId, sessionId: o.sessionId, sessionPk: o.pk };
    expect(await code(r.svc.attachSession(req, attachAuth(r, BOB_SEED, o.sessionId, o.pk)))).toBe("ok");
    expect(await code(r.svc.attachSession(req, attachAuth(r, BOB_SEED, o.sessionId, o.pk)))).toBe("403:active_session");
    const o2 = await bobOpens(r, g.grantId, hexN(0x73, 16));
    expect(await code(r.svc.attachSession({ ...req, txHash: o2.txHash, sessionId: o2.sessionId, sessionPk: o2.pk }, attachAuth(r, BOB_SEED, o2.sessionId, o2.pk)))).toBe("403:active_session");

    // finality held: the transaction is not final, so there is no receipt to attach to
    const r2 = await rig();
    const g2 = await accountGrant(r2);
    r2.chain.hold();
    const sk = new Uint8Array(randomBytes(32));
    const pk = bytesToHex(seal.x25519PublicKey(sk));
    const sid = hexN(0x74, 16);
    const pending = r2.chain.writer(BOB).openSession({ grantId: g2.grantId, sessionId: sid, sessionPk: pk, tsMs: r2.chain.now() });
    await new Promise((res) => setTimeout(res, 10));
    expect(await code(r2.svc.attachSession({ txHash: "fake-tx-99", grantId: g2.grantId, sessionId: sid, sessionPk: pk }, attachAuth(r2, BOB_SEED, sid, pk)))).toBe("403:no_receipt");
    r2.chain.release();
    const tx = await pending;
    expect(await code(r2.svc.attachSession({ txHash: tx.txHash, grantId: g2.grantId, sessionId: sid, sessionPk: pk }, attachAuth(r2, BOB_SEED, sid, pk)))).toBe("ok");
  });

  it("bearer grants cannot be attached, account grants cannot use the bearer open, and revoked or old-epoch grants are refused", async () => {
    const r = await rig();
    const link = await giveAccess(r);
    const o = await bobOpens(r, link.grantId).catch(() => null);
    expect(o).toBeNull(); // the contract refuses: wrong requester kind for this caller (bob is not the bearer)
    const bear = openRequest(r, link);
    expect(await code(r.svc.attachSession({ txHash: "fake-tx-1", grantId: link.grantId, sessionId: bear.req.sessionId, sessionPk: bear.req.sessionPk }, attachAuth(r, BOB_SEED, bear.req.sessionId, bear.req.sessionPk)))).toBe("403:denied");

    const g = await accountGrant(r, 3);
    const hex = hexN(0x75, 16);
    expect(await code(r.svc.openSession({ grantId: g.grantId, sessionId: hex, sessionPk: hexN(1, 32), ts: r.chain.now(), sig: "00".repeat(64) }))).toBe("400:unsupported_requester");

    const o2 = await bobOpens(r, g.grantId, hexN(0x76, 16));
    r.chain.completeDealFor(BOX, "buyer.testnet");
    expect(await code(r.svc.attachSession({ txHash: o2.txHash, grantId: g.grantId, sessionId: o2.sessionId, sessionPk: o2.pk }, attachAuth(r, BOB_SEED, o2.sessionId, o2.pk)))).toBe("403:denied");
  });
});
