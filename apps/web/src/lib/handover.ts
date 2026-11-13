// Handing a safe over (spec 06). The contract moves ownership and any payment together and bumps the key epoch, which ends every
// access link. The new owner then receives the box key (two halves: one sealed to them, one held by the release service until the
// handover is complete on chain) and re-locks the safe so the previous owner's keys open nothing that is stored.
import { bytesToHex, concatBytes, hexToBytes, kdf, merkle, randomBytes, rs, seal, sha256, xor32 } from "@keyhole/crypto";
import type { ChainReader, ChainWriter, DealApi, DealView } from "@keyhole/chain";
import { prepareBlob } from "@keyhole/store";
import { ownerAuth } from "./access";
import type { Services } from "./access";
import type { Identity } from "./keys";
import { putBlob, readOwn, trustedRoot } from "./upload";
import type { Ctx, Receipt } from "./upload";

type Writer = ChainWriter & DealApi;

/** What a buyer gives a seller: their account and their key-receiving public key. */
export const handoverAddress = (id: Identity) => `${id.accountId}.${bytesToHex(seal.x25519PublicKey(id.x25519Secret))}`;
export function parseAddress(s: string): { account: string; x25519: string } {
  const m = s.trim().match(/^([0-9a-f]{64})\.([0-9a-f]{64})$/);
  if (!m) throw new Error("That handover address is not valid. Ask the new owner to copy it from their Keyhole.");
  return { account: m[1] as string, x25519: m[2] as string };
}
/** What a seller gives a buyer. */
export const dealCode = (dealId: string, boxId: string) => `${dealId}.${boxId}`;
export function parseDealCode(s: string): { dealId: string; boxId: string } {
  const m = s.trim().match(/^([0-9a-f]{32})\.([0-9a-f]{32})$/);
  if (!m) throw new Error("That handover code is not valid.");
  return { dealId: m[1] as string, boxId: m[2] as string };
}

export interface Offer { dealId: string; code: string; txs: Receipt[] }

export async function offerHandover(a: { ctx: Ctx; writer: Writer; svc: Services; buyerAddress: string; priceYocto: string; waitingMs: number }): Promise<Offer> {
  const { ctx } = a;
  const f = a.svc.fetch ?? fetch.bind(globalThis);
  const buyer = parseAddress(a.buyerAddress);
  const dealId = bytesToHex(randomBytes(16));
  const b1 = randomBytes(32);
  const b2 = xor32(ctx.bmk, b1); // bmk = b1 xor b2
  const txs: Receipt[] = [];
  // the buyer's half, sealed to them, stored as a small blob the contract can point at
  const envBytes = new Uint8Array(merkle.LEAF_SIZE);
  envBytes.set(seal.sealTo(hexToBytes(buyer.x25519), concatBytes(b1, hexToBytes(dealId))), 0);
  const env = prepareBlob(envBytes);
  ctx.progress?.("Preparing the handover…");
  txs.push({ step: "key envelope: register", txHash: (await ctx.writer.registerBlob({ blobId: env.blobId, boxId: ctx.boxId, size: env.size, days: 30 })).txHash });
  const rec = await ctx.reader.blob(env.blobId);
  const { pushBlob } = await import("@keyhole/store");
  const { acks } = await pushBlob({ nodes: ctx.nodes, blob: env, regId: rec!.reg_id, threshold: 1 });
  txs.push({ step: "key envelope: certify", txHash: (await ctx.writer.certifyBlob(env.blobId, acks)).txHash });
  // the release service takes the other half and acknowledges it; the contract requires that acknowledgement in the offer
  const ts = await ctx.reader.finalTimeMs();
  const res = await f(`${a.svc.releaseUrl}/v1/deals/${dealId}/s2`, {
    method: "PUT", headers: { ...ownerAuth(ctx.id, a.svc, dealId, rs.authBody("deal-put", b2), ts), "content-type": "application/json" }, body: JSON.stringify({ b2: bytesToHex(b2), box_id: ctx.boxId }),
  });
  if (!res.ok) throw new Error(`The release service did not accept the key half (${res.status}).`);
  const ack = (await res.json()) as { ack: string; s2_commit: string; rs_idx: number };
  ctx.progress?.("Offering the safe…");
  txs.push({ step: "offer", txHash: (await a.writer.createDeal({
    dealId, boxId: ctx.boxId, buyer: buyer.account, priceYocto: a.priceYocto, waitingMs: a.waitingMs, offerExpiresAtMs: (await ctx.reader.finalTimeMs()) + 24 * 3_600_000,
    bmkCommit: bytesToHex(kdf.bmkCommit(ctx.bmk)), envelopeBlob: env.blobId, s2Commit: ack.s2_commit, rsIdx: ack.rs_idx, rsAck: ack.ack,
  })).txHash });
  return { dealId, code: dealCode(dealId, ctx.boxId), txs };
}

export const cancelHandover = async (writer: Writer, dealId: string) => (await writer.cancelDeal(dealId)).txHash;

export const readDeal = (reader: ChainReader, dealId: string): Promise<DealView | null> => reader.deal(dealId);

export async function acceptAndFund(writer: Writer, deal: DealView): Promise<string> {
  return (await writer.fundDeal(deal.deal_id, deal.price)).txHash;
}

/** Anyone may complete once the waiting period has passed; the contract refuses earlier. */
export async function completeHandover(writer: Writer, dealId: string): Promise<string> {
  return (await writer.completeDeal(dealId)).txHash;
}

/**
 * After completion: the new owner gets the second key half from the release service (only possible once the contract says the
 * deal is Completed, and only for the buyer), reads their sealed half from the envelope, rebuilds the box key and checks it
 * against the commitment on chain.
 */
export async function receiveKey(a: { id: Identity; reader: ChainReader; svc: Services; nodes: Ctx["nodes"]; deal: DealView }): Promise<Uint8Array> {
  const f = a.svc.fetch ?? fetch.bind(globalThis);
  const pk = bytesToHex(seal.x25519PublicKey(a.id.x25519Secret));
  const ts = await a.reader.finalTimeMs();
  const res = await f(`${a.svc.releaseUrl}/v1/deals/${a.deal.deal_id}/key?x25519=${pk}`, { headers: ownerAuth(a.id, a.svc, a.deal.deal_id, rs.authBody("deal-key", hexToBytes(pk)), ts) });
  if (!res.ok) throw new Error("The key half is not available yet. It is released only after the handover is complete.");
  const b2 = seal.openSealed(a.id.x25519Secret, hexToBytes(((await res.json()) as { sealed: string }).sealed));
  const rec = await a.reader.blob(a.deal.envelope_blob);
  if (!rec) throw new Error("The key envelope is missing.");
  const ctx = { id: a.id, reader: a.reader, nodes: a.nodes } as Ctx;
  const root = await trustedRoot(ctx, a.deal.envelope_blob, rec.leaves * merkle.LEAF_SIZE);
  const leaf = await readOwn(ctx, a.deal.envelope_blob, root, rec.leaves, 0, 1);
  const opened = seal.openSealed(a.id.x25519Secret, leaf.subarray(0, 32 + 24 + 48 + 16));
  if (bytesToHex(opened.subarray(32)) !== a.deal.deal_id) throw new Error("This envelope is for a different handover.");
  const bmk = xor32(opened.subarray(0, 32), b2);
  if (bytesToHex(kdf.bmkCommit(bmk)) !== a.deal.bmk_commit) throw new Error("The key does not match what the seller committed to on chain. Do not accept this safe.");
  return bmk;
}


