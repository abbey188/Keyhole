// Step 2d: real smoke test against the deployed contract on testnet, using NearWriter, RpcReader, the real
// StorageNode and the real ReleaseService. Records every transaction with gas and submit-to-final time (spikes K4, K6).
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, hexToBytes, kdf, receipt, seal, sha256, split } from "@keyhole/crypto";
import { readLeaves } from "@keyhole/store";
import { ReleaseError, authBody, scopeHash } from "@keyhole/release";
import { DEPLOY_DIR, need, txLink } from "./lib.js";
import { bearer, check, checks, contractId, direct, env, expectFail, hex, node, nodeApi, openReq, owner, ownerAuth, reader, rec, relayer, rs, setLabel, steps, storeBlob, writer } from "./common.js";

let label = "";
const L = (l: string) => { label = l; setLabel(l); };
// ================================================================== run
const boxId = hex(16);
console.log(`contract ${contractId}\nbox ${boxId}`);
const cfg = await reader.config();
check("reader reads config at final", cfg.chain_id === "testnet" && cfg.threshold === 1);

L("create_box");
await owner.createBox({ boxId, kind: "Handover", wrappedBmk: new Uint8Array(randomBytes(48)), maxGrantMs: 3_600_000 });
check("box exists at final and is owned by the owner", (await reader.box(boxId))?.owner === need(env, "OWNER_ACCOUNT"));

const data = await storeBlob(boxId, 2, "data blob");
const manifest = await storeBlob(boxId, 1, "manifest blob");
check("blob is Active at final", (await reader.blob(data.blobId))?.state === "Active");
L("commit_manifest");
await owner.commitManifest({ boxId, manifestBlob: manifest.blobId, seq: 1 });
check("manifest committed", (await reader.box(boxId))?.manifest_seq === 1);

// ---------- direct path: a bearer grant opened by the relayer with the recipient's real signature
const r1 = bearer();
const g1 = hex(16);
L("create_grant");
await owner.createGrant({ grantId: g1, boxId, requester: { bearer: r1.pk }, mode: "View", notBeforeMs: await reader.finalTimeMs(), notAfterMs: (await reader.finalTimeMs()) + 1_800_000, maxSessions: 3, scopeHash: hex(32), policyHash: hex(32) });
const o1 = openReq(g1, r1, await reader.finalTimeMs());
L("open_session (direct)");
const open1 = await relayer.openSession(direct(o1.req));
const ev1 = open1.events.find((e) => e.event === "session_opened")!;
check("open_session emitted session_opened", !!ev1 && ev1.data.seq === 1);

// ---------- release-service path on the real chain (receipt-first)
const itemUid = hex(16);
const s1seed = new Uint8Array(randomBytes(32));
const dek = kdf.itemDek(kdf.epochKey(new Uint8Array(randomBytes(32)), 0), hexToBytes(itemUid));
const sks = [0, 1].map((s) => kdf.segmentKey(dek, s));
const scope = { items: [{ item_uid: itemUid, blob_id: data.blobId, segments: sks.map((sk, s) => ({ s, s2: bytesToHex(split.s2(sk, split.s1(s1seed, hexToBytes(itemUid), s))) })) }] };
const r2 = bearer();
const g2 = hex(16);
L("create_grant (scoped)");
await owner.createGrant({ grantId: g2, boxId, requester: { bearer: r2.pk }, mode: "View", notBeforeMs: await reader.finalTimeMs(), notAfterMs: (await reader.finalTimeMs()) + 1_800_000, maxSessions: 3, scopeHash: scopeHash(scope), policyHash: hex(32) });
const body = new TextEncoder().encode(JSON.stringify({ scope }));
await rs.putScope(g2, body, await ownerAuth(g2, sha256(body)));
check("release service accepted the owner's scope (owner key checked on chain)", true);

const t0 = performance.now();
const o2 = openReq(g2, r2, await reader.finalTimeMs());
L("open_session (via release service)");
const session = await rs.openSession(o2.req);
const openMs = Math.round(performance.now() - t0);
check("release service minted a token only after the receipt was final", !!session.token && session.seq === 2, `${openMs} ms from request to token`);
const [k0] = await rs.release(session.token, itemUid, [0]);
const sk0 = split.combine(split.s1(s1seed, hexToBytes(itemUid), 0), seal.openSealed(o2.sk, hexToBytes(k0!.sealed)));
check("recipient recombined the real segment key", bytesToHex(sk0) === bytesToHex(sks[0]!));
const { ticket } = await rs.ticket(session.token, data.blobId);
const leaves = await readLeaves({ nodes: [nodeApi], blobId: data.blobId, root: data.root, leaves: data.leaves, from: 0, to: 1, ticket });
check("node served a verified leaf against a release-service ticket (checked against the real chain)", leaves.length === 1);
L("close_session (release service)");
const closed = await rs.close(session.token);

// ---------- recompute the receipt chain from events and compare with the box's on-chain head
const s1on = (await reader.session(o1.req.sessionId))!;
const s2on = (await reader.session(o2.req.sessionId))!;
const c1 = receipt.commitment(hexToBytes(g1), hexToBytes(o1.req.sessionId), hexToBytes(o1.req.sessionPk), receipt.requesterDigestBearer(hexToBytes(r1.pk)), s1on.opened_at);
const c2 = receipt.commitment(hexToBytes(g2), hexToBytes(o2.req.sessionId), hexToBytes(o2.req.sessionPk), receipt.requesterDigestBearer(hexToBytes(r2.pk)), s2on.opened_at);
check("event commitment equals the commitment recomputed from the request", ev1.data.commitment === bytesToHex(c1));
const c3 = receipt.closeCommitment(hexToBytes(o2.req.sessionId), hexToBytes(closed.log_root), (await reader.session(o2.req.sessionId))!.closed_at!);
const box = (await reader.box(boxId))!;
const recomputed = bytesToHex(receipt.recomputeChain([c1, c2, c3]));
check("receipt chain recomputed from public data equals the box's on-chain head", recomputed === box.receipts_head && box.receipts_seq === 3, `seq ${box.receipts_seq}`);
const feed = await rs.boxEvents(boxId, await ownerAuth(boxId, authBody("box-events", hexToBytes(boxId))));
check("owner feed lists the release-service session with a head matching the chain", feed.length === 1 && feed[0]!.commitment === bytesToHex(c2));

// ---------- revoke, then failures
L("open_session (via release service, 2nd visit)");
const ownerSession2 = openReq(g2, r2, await reader.finalTimeMs());
const live = await rs.openSession(ownerSession2.req);
await rs.release(live.token, itemUid, [1]);
L("revoke_grant");
await owner.revokeGrant(g2);
let denied = "";
try { await rs.release(live.token, itemUid, [0]); } catch (e) { denied = e instanceof ReleaseError ? `${e.status}:${e.code}` : String(e); }
check("after revoke the release service refuses the next key", denied === "403:denied", denied);
let nodeDenied = "";
try { await readLeaves({ nodes: [nodeApi], blobId: data.blobId, root: data.root, leaves: data.leaves, from: 0, to: 1, ticket: (await rs.ticket(live.token, data.blobId).catch(() => ({ ticket: ticket }))).ticket }); } catch (e) { nodeDenied = e instanceof Error ? e.name : String(e); }
check("after revoke the node refuses reads (checks the grant at final)", nodeDenied === "ReadFailed", nodeDenied);

L("open_session (FAILED: bad signature)");
const bad = openReq(g1, r1, await reader.finalTimeMs());
await expectFail("a forged open is rejected by the contract", relayer.openSession(direct(bad.req, { sessionPk: bytesToHex(randomBytes(32)) })), "Bad signature");
L("open_session (FAILED: revoked grant)");
const late = openReq(g2, r2, await reader.finalTimeMs());
await expectFail("an open on a revoked grant is rejected by the contract", relayer.openSession(direct(late.req)), "Grant revoked");
L("open_session (FAILED: duplicate session id)");
await expectFail("a replayed session id is rejected by the contract", relayer.openSession(direct(o1.req)), "Session id already used");

// ---------- retire and erase
L("retire_blob");
await owner.retireBlob(data.blobId);
check("node refuses a retired blob at once", await (async () => { try { await node.getLeaves({ ticket, blobId: data.blobId, from: 0, to: 1 }); return false; } catch { return true; } })());
const sweepWriter = writer(need(env, "RELAYER_ACCOUNT"), need(env, "RELAYER_PRIVATE_KEY"));
L("attest_erasure");
const report = await node.sweep(sweepWriter);
check("node erased and attested; the blob record is gone (N=1)", report.attested.length === 1 && (await reader.blob(data.blobId)) === null);

// ================================================================== record
const out = {
  contract: contractId,
  codeHash: rec.wasm.near_code_hash_base58,
  box: boxId,
  checks,
  transactions: steps.map((s) => ({ label: s.label, method: s.method, ok: s.ok, txHash: s.txHash, link: s.txHash ? txLink(s.txHash) : null, gasTgas: +(s.gasBurnt / 1e12).toFixed(2), submitToFinalMs: s.submitToFinalMs, error: s.error ?? null })),
  releaseServiceOpenRequestToTokenMs: openMs,
};
writeFileSync(join(DEPLOY_DIR, "smoke-testnet.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`\n${checks.length} checks passed; ${steps.length} transactions recorded in deploy/smoke-testnet.json`);
