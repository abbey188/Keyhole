// Step 2e: a real sale on testnet (TESTNET NEAR only): offer, key-half deposit with the release service, funding,
// early completion refused, completion after the (DEMO) waiting period, escrow payout, epoch bump killing an older grant,
// buyer key release and delivery checks, plus a second deal that is cancelled and refunded.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NearWriter } from "@keyhole/chain";
import { bytesToHex, concatBytes, hexToBytes, kdf, merkle, msgs, seal, sig, xor32 } from "@keyhole/crypto";
import { encodeTicket, signOwnerTicket } from "@keyhole/node";
import { prepareBlob, pushBlob, readLeaves } from "@keyhole/store";
import { authBody, dealAckMsg, dealS2Commit } from "@keyhole/release";
import { DEPLOY_DIR, RPC_URL, fmtNear, need, rpc, txLink } from "./lib.js";
import { bearer, check, checks, contractId, env, expectFail, hex, nodeApi, openReq, owner, ownerSeed, reader, relayer, rs, seedOf, setLabel, steps, storeBlob } from "./common.js";
import { relayer as _r } from "./common.js";
void _r;

const sellerId = need(env, "OWNER_ACCOUNT");
const buyerId = need(env, "RELAYER_ACCOUNT");
const buyerSeed = seedOf(need(env, "RELAYER_PRIVATE_KEY"));
// the buyer's writer, with deal methods
const buyer = new NearWriter({
  accountId: buyerId, secretKey: need(env, "RELAYER_PRIVATE_KEY"), rpcUrl: RPC_URL, contractId, reader,
  onTx: (m) => steps.push({ ...m, label: currentLabel }),
});
const seller = new NearWriter({
  accountId: sellerId, secretKey: need(env, "OWNER_PRIVATE_KEY"), rpcUrl: RPC_URL, contractId, reader,
  onTx: (m) => steps.push({ ...m, label: currentLabel }),
});
let currentLabel = "";
const L = (l: string) => { currentLabel = l; setLabel(l); };
const balance = async (id: string) => BigInt((await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: id })).amount);
const PRICE = 100_000_000_000_000_000_000_000n; // 0.1 NEAR (testnet)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newHandoverBox(): Promise<string> {
  const boxId = hex(16);
  L("create_box (Handover)");
  await seller.createBox({ boxId, kind: "Handover", wrappedBmk: new Uint8Array(randomBytes(48)), maxGrantMs: 3_600_000 });
  const manifest = await storeBlob(boxId, 1, "manifest blob");
  L("commit_manifest");
  await seller.commitManifest({ boxId, manifestBlob: manifest.blobId, seq: 1 });
  return boxId;
}

/** Seller: key halves (B1 in an envelope sealed to the buyer, B2 with the release service), envelope blob, offer. */
async function offer(boxId: string, dealId: string, buyerPk: Uint8Array) {
  const B1 = new Uint8Array(randomBytes(32));
  const B2 = new Uint8Array(randomBytes(32));
  const bmk = xor32(B1, B2);
  const envBytes = new Uint8Array(merkle.LEAF_SIZE);
  envBytes.set(seal.sealTo(buyerPk, concatBytes(B1, hexToBytes(dealId))), 0);
  const envBlob = prepareBlob(envBytes);
  L("envelope blob: register");
  await seller.registerBlob({ blobId: envBlob.blobId, boxId, size: envBlob.size, days: 1 });
  const reg = (await reader.blob(envBlob.blobId))!;
  const { acks } = await pushBlob({ nodes: [nodeApi], blob: envBlob, regId: reg.reg_id, threshold: 1 });
  L("envelope blob: certify");
  await relayer.certifyBlob(envBlob.blobId, acks);
  // the release service takes the key half first and acknowledges it; the contract requires that acknowledgement
  const put = await rs.putDealS2(dealId, bytesToHex(B2), await sign(ownerSeed, dealId, authBody("deal-put", B2)), boxId);
  L("create_deal");
  await seller.createDeal({
    dealId, boxId, buyer: buyerId, priceYocto: PRICE.toString(), waitingMs: 15_000, offerExpiresAtMs: (await reader.finalTimeMs()) + 3_600_000,
    bmkCommit: bytesToHex(kdf.bmkCommit(bmk)), envelopeBlob: envBlob.blobId, s2Commit: dealS2Commit(dealId, B2), rsIdx: put.rs_idx, rsAck: put.ack,
  });
  return { B2, bmk, envBlob, put };
}

const ts = async () => reader.finalTimeMs();
const sign = async (seed: Uint8Array, idHex: string, body: Uint8Array) => {
  const t = await ts();
  return { ts: t, pk: bytesToHex(sig.publicKey(seed)), sig: bytesToHex(sig.sign(seed, msgs.rsPutMsg("testnet", hexToBytes(idHex), body, t))) };
};

// ================================================================== deal 1: complete
const buyerX = new Uint8Array(randomBytes(32));
const buyerPk = seal.x25519PublicKey(buyerX);
const boxId = await newHandoverBox();
console.log(`contract ${contractId}\nbox ${boxId}`);

// an earlier grant that the sale must kill
const old = bearer();
const oldGrant = hex(16);
L("create_grant");
await seller.createGrant({ grantId: oldGrant, boxId, requester: { bearer: old.pk }, mode: "View", notBeforeMs: await ts(), notAfterMs: (await ts()) + 1_800_000, maxSessions: 2, scopeHash: hex(32), policyHash: hex(32) });

const dealId = hex(16);
const { B2, bmk, envBlob, put } = await offer(boxId, dealId, buyerPk);
check("box is frozen in the deal", (await reader.box(boxId))?.in_deal === dealId);
await expectFail("a grant to a stranger is refused while the box is in a deal", seller.createGrant({ grantId: hex(16), boxId, requester: { bearer: old.pk }, mode: "View", notBeforeMs: await ts(), notAfterMs: (await ts()) + 600_000, maxSessions: 1, scopeHash: hex(32), policyHash: hex(32) }), "Box is in a deal");

L("create_deal (FAILED: no acknowledgement)");
await expectFail("an offer without the release service's acknowledgement is refused by the contract", seller.createDeal({ dealId: hex(16), boxId, buyer: buyerId, priceYocto: PRICE.toString(), waitingMs: 15_000, offerExpiresAtMs: (await reader.finalTimeMs()) + 3_600_000, bmkCommit: hex(32), envelopeBlob: hex(32), s2Commit: hex(32), rsIdx: 0, rsAck: "00".repeat(64) }), "acknowledgement is not valid");
const rsPk = hexToBytes((await reader.config()).rs_keys[0]!);
check("release service acknowledged the seller's key half; ack verifies against the contract's rs_keys", sig.verify(rsPk, dealAckMsg(dealId, put.s2_commit), hexToBytes(put.ack)));

const sellerBefore = await balance(sellerId);
const contractBefore = await balance(contractId);
L("fund_deal");
await buyer.fundDeal(dealId, PRICE.toString());
const funded = (await reader.deal(dealId))!;
check("deal is Funded and the escrow is held by the contract", funded.state === "Funded" && (await balance(contractId)) - contractBefore >= PRICE - 10n ** 22n);
await expectFail("complete before the waiting period is refused", buyer.completeDeal(dealId), "Waiting period has not passed");
const buyerAuthBefore = await sign(buyerSeed, dealId, authBody("deal-key", buyerPk));
let early = "";
try { await rs.getDealKey(dealId, bytesToHex(buyerPk), buyerAuthBefore); } catch (e) { early = String((e as Error).message); }
check("release service refuses the buyer's key half before Completed", early === "denied", early);

const wait = Math.max(0, (funded.waiting_until ?? 0) - (await ts()) + 2000);
console.log(`waiting ${Math.round(wait / 1000)} s (DEMO waiting period)`);
await sleep(wait);
L("complete_deal");
await buyer.completeDeal(dealId);
const done = (await reader.deal(dealId))!;
const boxAfter = (await reader.box(boxId))!;
check("deal Completed; the buyer owns the box; the epoch moved", done.state === "Completed" && boxAfter.owner === buyerId && boxAfter.key_epoch === 1);
await sleep(4000); // let the payout receipt settle
const sellerAfter = await balance(sellerId);
check("the seller was paid the price from escrow (net of the seller's own gas)", sellerAfter - sellerBefore > PRICE - 5n * 10n ** 22n, `+${fmtNear(sellerAfter - sellerBefore)}`);
const ct = await balance(contractId);
check("the contract holds no leftover escrow", ct - contractBefore < 10n ** 22n, `delta ${fmtNear(ct - contractBefore)}`);
const stale = openReq(oldGrant, old, await ts());
L("open_session (FAILED: earlier epoch)");
await expectFail("a grant created before the sale no longer opens", relayer.openSession({ grantId: stale.req.grantId, sessionId: stale.req.sessionId, sessionPk: stale.req.sessionPk, tsMs: stale.req.ts, reqSig: stale.req.sig }), "earlier epoch");
await expectFail("the previous owner can no longer act on the box", seller.createGrant({ grantId: hex(16), boxId, requester: { bearer: old.pk }, mode: "View", notBeforeMs: await ts(), notAfterMs: (await ts()) + 600_000, maxSessions: 1, scopeHash: hex(32), policyHash: hex(32) }), "Only the box owner");

// delivery: buyer gets B2 from the release service and B1 from the envelope, rebuilds the key, checks the commitment
const got = await rs.getDealKey(dealId, bytesToHex(buyerPk), await sign(buyerSeed, dealId, authBody("deal-key", buyerPk)));
const B2got = seal.openSealed(buyerX, hexToBytes(got.sealed));
check("buyer received the second key half only after Completed", bytesToHex(B2got) === bytesToHex(B2));
const ticket = encodeTicket(signOwnerTicket(buyerSeed, buyerId, envBlob.blobId, (await ts()) + 120_000));
const [envLeaf] = await readLeaves({ nodes: [nodeApi], blobId: envBlob.blobId, root: envBlob.root, leaves: envBlob.leaves, from: 0, to: 1, ticket });
const opened = seal.openSealed(buyerX, envLeaf!.subarray(0, 32 + 24 + 48 + 16));
const B1got = opened.subarray(0, 32);
check("buyer rebuilt the box key and it matches the on-chain commitment (bmk_commit)", bytesToHex(kdf.bmkCommit(xor32(B1got, B2got))) === done.bmk_commit && bytesToHex(xor32(B1got, B2got)) === bytesToHex(bmk));
check("the sold box's wrapped key was cleared for the buyer to re-wrap (re-secure step is the app's job)", boxAfter.wrapped_bmk === "");

// ================================================================== deal 2: cancel and refund
const box2 = await newHandoverBox();
const deal2 = hex(16);
await offer(box2, deal2, buyerPk);
const b2before = await balance(buyerId);
L("fund_deal");
await buyer.fundDeal(deal2, PRICE.toString());
L("cancel_deal (by seller, funded)");
await seller.cancelDeal(deal2);
await sleep(4000);
const d2 = (await reader.deal(deal2))!;
const b2after = await balance(buyerId);
check("a cancelled funded deal is Cancelled, the box is unfrozen, and the buyer is refunded", d2.state === "Cancelled" && (await reader.box(box2))?.in_deal === null && b2before - b2after < 5n * 10n ** 22n, `buyer net ${fmtNear(b2after - b2before)} (gas only)`);

// ================================================================== record
const out = {
  contract: contractId,
  deal: dealId,
  checks,
  transactions: steps.map((s) => ({ label: s.label, method: s.method, ok: s.ok, txHash: s.txHash, link: s.txHash ? txLink(s.txHash) : null, gasTgas: +(s.gasBurnt / 1e12).toFixed(2), submitToFinalMs: s.submitToFinalMs, error: s.error ?? null })),
};
writeFileSync(join(DEPLOY_DIR, "smoke-deal-testnet.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`\n${checks.length} checks passed; ${steps.length} transactions recorded in deploy/smoke-deal-testnet.json`);
