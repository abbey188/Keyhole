// Attack lab: real attacks against the DEPLOYED contract on testnet. Each one is attempted and must be refused; the refusal's
// transaction (a failed transaction still has a hash) is recorded so anyone can open it. Output: deploy/attack-lab-testnet.json.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Account } from "near-api-js";
import { NearWriter } from "@keyhole/chain";
import { bytesToHex, hexToBytes } from "@keyhole/crypto";
import { DEPLOY_DIR, RPC_URL, need, provider, txLink } from "./lib.js";
import { bearer, contractId, direct, env, hex, openReq, owner, reader, relayer, steps, setLabel } from "./common.js";

interface Result { id: string; attack: string; how: string; expected: string; got: string; refused: boolean; txHash: string | null; link: string | null; gasTgas: number }
const results: Result[] = [];

async function attempt(id: string, attack: string, how: string, expected: string, fn: () => Promise<unknown>) {
  setLabel(`attack ${id}`);
  const before = steps.length;
  let got = "SUCCEEDED (not refused)";
  try { await fn(); } catch (e) { got = (e as Error).message.replace(/^Smart contract panicked: /, "").slice(0, 160); }
  const tx = steps.slice(before).find((s) => !s.ok && s.txHash) ?? null;
  const refused = got.includes(expected);
  results.push({ id, attack, how, expected, got, refused, txHash: tx?.txHash ?? null, link: tx?.txHash ? txLink(tx.txHash) : null, gasTgas: tx ? +(tx.gasBurnt / 1e12).toFixed(2) : 0 });
  console.log(`${refused ? "REFUSED" : "NOT REFUSED"}  ${id}  ${attack}  ->  ${got}`);
}

const boxId = hex(16);
await owner.createBox({ boxId, kind: "Handover", wrappedBmk: new Uint8Array(randomBytes(48)), maxGrantMs: 3_600_000 });
const r1 = bearer();
const now = await reader.finalTimeMs();
const g1 = hex(16);
await owner.createGrant({ grantId: g1, boxId, requester: { bearer: r1.pk }, mode: "View", notBeforeMs: now, notAfterMs: now + 1_800_000, maxSessions: 3, scopeHash: hex(32), policyHash: hex(32) });

// 1. forged open: a valid-looking request signed by someone who does not hold the link
const forger = bearer();
const f = openReq(g1, forger, await reader.finalTimeMs());
await attempt("A1", "Forged open", "open_session signed with a key that is not the grant's recipient key", "Bad signature", () => relayer.openSession(direct(f.req)));

// 2. replay: a real open, then the same session id again
const real = openReq(g1, r1, await reader.finalTimeMs());
await relayer.openSession(direct(real.req));
await attempt("A2", "Replayed open", "the same session id submitted a second time", "Session id already used", () => relayer.openSession(direct(real.req)));

// 3. stale request: a correctly signed open with an old timestamp
const old = openReq(g1, r1, (await reader.finalTimeMs()) - 10 * 60_000);
await attempt("A3", "Stale open", "a correctly signed open request that is 10 minutes old", "not fresh", () => relayer.openSession(direct(old.req)));

// 4. open after revoke
const g2 = hex(16);
const r2 = bearer();
await owner.createGrant({ grantId: g2, boxId, requester: { bearer: r2.pk }, mode: "View", notBeforeMs: await reader.finalTimeMs(), notAfterMs: (await reader.finalTimeMs()) + 1_800_000, maxSessions: 3, scopeHash: hex(32), policyHash: hex(32) });
await owner.revokeGrant(g2);
const afterRevoke = openReq(g2, r2, await reader.finalTimeMs());
await attempt("A4", "Open after revoke", "a valid recipient opens after the owner ended the grant", "Grant revoked", () => relayer.openSession(direct(afterRevoke.req)));

// 5. open after expiry (shortest allowed grant is 60 s from now)
const g3 = hex(16);
const r3 = bearer();
const t = await reader.finalTimeMs();
await owner.createGrant({ grantId: g3, boxId, requester: { bearer: r3.pk }, mode: "View", notBeforeMs: t, notAfterMs: t + 75_000, maxSessions: 3, scopeHash: hex(32), policyHash: hex(32) });
console.log("waiting for the 75 s grant to expire…");
await new Promise((r) => setTimeout(r, 90_000));
const late = openReq(g3, r3, await reader.finalTimeMs());
await attempt("A5", "Open after expiry", "a valid recipient opens after the grant's end time", "Grant expired", () => relayer.openSession(direct(late.req)));

// 6. someone else tries to give access to the owner's box
const stranger = new NearWriter({ accountId: need(env, "NODE_ACCOUNT"), secretKey: need(env, "NODE_ACCOUNT_PRIVATE_KEY"), rpcUrl: RPC_URL, contractId, reader, onTx: (m) => steps.push({ ...m, label: "attack" }) });
await attempt("A6", "Grant by a non-owner", "another account calls create_grant on the owner's box", "Only the box owner", () => stranger.createGrant({ grantId: hex(16), boxId, requester: { bearer: r1.pk }, mode: "View", notBeforeMs: Date.now(), notAfterMs: Date.now() + 600_000, maxSessions: 1, scopeHash: hex(32), policyHash: hex(32) }));

// 7. moving the NFT outside a handover
const ownerAcct = new Account(need(env, "OWNER_ACCOUNT"), provider(), need(env, "OWNER_PRIVATE_KEY") as never);
const raw = async (method: string, args: Record<string, unknown>) => {
  const before = steps.length;
  try { await ownerAcct.callFunctionRaw({ contractId, methodName: method, args, deposit: 1n, gas: 50n * 10n ** 12n, waitUntil: "FINAL" } as never); }
  catch (e: any) {
    const tr = e?.transactionResult;
    steps.push({ method, txHash: tr?.transaction?.hash ?? "", ok: false, gasBurnt: Number(tr?.transaction_outcome?.outcome?.gas_burnt ?? 0) + ((tr?.receipts_outcome ?? []) as any[]).reduce((n, r) => n + Number(r?.outcome?.gas_burnt ?? 0), 0), submitToFinalMs: 0, label: "attack" });
    throw new Error(String(tr?.status?.Failure ? JSON.stringify(tr.status.Failure) : e.message));
  }
  void before;
};
await attempt("A7", "Transfer the NFT directly", "the owner calls nft_transfer to move the safe to another account", "only through a deal", () => raw("nft_transfer", { receiver_id: need(env, "RELAYER_ACCOUNT"), token_id: boxId }));
await attempt("A8", "Transfer-and-call", "the owner calls nft_transfer_call", "only through a deal", () => raw("nft_transfer_call", { receiver_id: need(env, "RELAYER_ACCOUNT"), token_id: boxId, msg: "" }));

// 9. an offer without the release service's acknowledgement
const envBlob = hex(32);
await owner.registerBlob({ blobId: envBlob, boxId, size: 65536, days: 1 }).catch(() => undefined);
await attempt("A9", "Sale offer without proof the key half is held", "create_deal with an invalid release-service acknowledgement", "acknowledgement is not valid", async () => {
  const w = owner as unknown as { createDeal: (a: unknown) => Promise<unknown> };
  return w.createDeal({ dealId: hex(16), boxId, buyer: need(env, "RELAYER_ACCOUNT"), priceYocto: "1", waitingMs: 15_000, offerExpiresAtMs: Date.now() + 3_600_000, bmkCommit: hex(32), envelopeBlob: envBlob, s2Commit: hex(32), rsIdx: 0, rsAck: "00".repeat(64) });
});

const out = { contract: contractId, ranAt: new Date().toISOString(), allRefused: results.every((r) => r.refused), results };
writeFileSync(join(DEPLOY_DIR, "attack-lab-testnet.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`\n${results.filter((r) => r.refused).length} of ${results.length} attacks refused; recorded in deploy/attack-lab-testnet.json`);
void hexToBytes; void bytesToHex;
