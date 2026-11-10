// Step 2f: a named-account requester on testnet. The named account (the relayer account here) sends open_session ITSELF,
// then attaches the session to the real release service, which reads the receipt from the final transaction on the real RPC.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, hexToBytes, kdf, receipt, seal, sha256, sig, split, msgs } from "@keyhole/crypto";
import { ReleaseError, authBody, scopeHash } from "@keyhole/release";
import { DEPLOY_DIR, need, txLink } from "./lib.js";
import { check, checks, contractId, env, hex, owner, ownerAuth, ownerSeed, reader, relayer, rs, seedOf, setLabel, steps, storeBlob } from "./common.js";

const namedId = need(env, "RELAYER_ACCOUNT");
const namedSeed = seedOf(need(env, "RELAYER_PRIVATE_KEY"));
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ReleaseError ? `${e.status}:${e.code}` : String((e as Error).message); } };
const attachAuth = async (sessionId: string, pk: string, seed = namedSeed) => {
  const ts = await reader.finalTimeMs();
  const body = authBody("session-attach", hexToBytes(pk));
  return { ts, pk: bytesToHex(sig.publicKey(seed)), sig: bytesToHex(sig.sign(seed, msgs.rsPutMsg("testnet", hexToBytes(sessionId), body, ts))) };
};

const boxId = hex(16);
setLabel("create_box"); await owner.createBox({ boxId, kind: "Bound", wrappedBmk: new Uint8Array(randomBytes(48)), maxGrantMs: 3_600_000 });
const blob = await storeBlob(boxId, 1, "data blob");
const itemUid = hex(16);
const s1seed = new Uint8Array(randomBytes(32));
const sk = kdf.segmentKey(kdf.itemDek(kdf.epochKey(new Uint8Array(randomBytes(32)), 0), hexToBytes(itemUid)), 0);
const scope = { items: [{ item_uid: itemUid, blob_id: blob.blobId, segments: [{ s: 0, s2: bytesToHex(split.s2(sk, split.s1(s1seed, hexToBytes(itemUid), 0))) }] }] };
const grantId = hex(16);
setLabel("create_grant (named account)");
await owner.createGrant({ grantId, boxId, requester: { account: namedId }, mode: "View", notBeforeMs: await reader.finalTimeMs(), notAfterMs: (await reader.finalTimeMs()) + 1_800_000, maxSessions: 3, scopeHash: scopeHash(scope), policyHash: hex(32) });
const body = new TextEncoder().encode(JSON.stringify({ scope }));
await rs.putScope(grantId, body, await ownerAuth(grantId, sha256(body)));

const sessionId = hex(16);
const sessionSk = new Uint8Array(randomBytes(32));
const sessionPk = bytesToHex(seal.x25519PublicKey(sessionSk));
setLabel("open_session (by the named account itself)");
const tx = await relayer.openSession({ grantId, sessionId, sessionPk, tsMs: await reader.finalTimeMs() });
check("the named account's own open_session succeeded and emitted session_opened", tx.events.some((e) => e.event === "session_opened"));

const attach = { txHash: tx.txHash, grantId, sessionId, sessionPk };
check("the real RPC returns the receipt event for the final transaction", ((await reader.txEvents(tx.txHash, namedId)) ?? []).some((e) => e.event === "session_opened"));
const evilPk = hex(32);
check("attach is refused for a session key that is not the one in the on-chain receipt", (await code(rs.attachSession({ ...attach, sessionPk: evilPk }, await attachAuth(sessionId, evilPk)))) === "403:no_receipt");
check("attach is refused for a key that does not control the named account (the seller's key)", (await code(rs.attachSession(attach, await attachAuth(sessionId, sessionPk, ownerSeed)))) === "403:denied");
const res = await rs.attachSession(attach, await attachAuth(sessionId, sessionPk));
check("attach minted a token after reading the final receipt", !!res.token && res.seq === 1);
const [k] = await rs.release(res.token, itemUid, [0]);
const got = split.combine(split.s1(s1seed, hexToBytes(itemUid), 0), seal.openSealed(sessionSk, hexToBytes(k!.sealed)));
check("the named account recombined the real segment key", bytesToHex(got) === bytesToHex(sk));
const opened = (await reader.session(sessionId))!;
const c = receipt.commitment(hexToBytes(grantId), hexToBytes(sessionId), hexToBytes(sessionPk), receipt.requesterDigestAccount(namedId), opened.opened_at);
const box = (await reader.box(boxId))!;
check("receipt chain recomputed with the account digest equals the on-chain head", bytesToHex(receipt.recomputeChain([c])) === box.receipts_head && box.receipts_seq === 1);
check("a second attach of the same session is refused", (await code(rs.attachSession(attach, await attachAuth(sessionId, sessionPk)))) === "403:active_session");
setLabel("revoke_grant");
await owner.revokeGrant(grantId);
check("after revoke the release service refuses the next key", (await code(rs.release(res.token, itemUid, [0]))) === "403:denied");

writeFileSync(join(DEPLOY_DIR, "smoke-named-testnet.json"), JSON.stringify({
  contract: contractId, checks,
  transactions: steps.map((s) => ({ label: s.label, method: s.method, ok: s.ok, txHash: s.txHash, link: s.txHash ? txLink(s.txHash) : null, gasTgas: +(s.gasBurnt / 1e12).toFixed(2), submitToFinalMs: s.submitToFinalMs, error: s.error ?? null })),
}, null, 2) + "\n");
console.log(`\n${checks.length} checks passed; ${steps.length} transactions recorded in deploy/smoke-named-testnet.json`);
