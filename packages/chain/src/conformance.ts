// Conformance scenario. The SAME script runs against the real contract (tools/testnet/src/conformance.ts) and
// against FakeChain (test/conformance.test.ts) and must produce the SAME trace: for every call, success or the
// contract's exact panic message, plus a small snapshot of observable state. The real run is committed as a golden
// file (deploy/conformance-testnet.json); FakeChain must reproduce it offline.
import { bytesToHex, hexToBytes, msgs, randomBytes, receipt, sig } from "@keyhole/crypto";
import { ChainUnavailable, ContractError } from "./chain.js";
import type { ChainReader, ChainWriter, DealApi } from "./chain.js";
import type { GrantArgs } from "./types.js";

type Actor = ChainWriter & DealApi;

export interface ConformanceEnv {
  reader: ChainReader;
  alice: Actor; // box owner and seller
  bob: Actor; // buyer, named requester, relayer
  mallory: Actor; // a third party
  accounts: { alice: string; bob: string; mallory: string };
  nodeSeed: Uint8Array;
  rsSeed: Uint8Array;
  /** Real chain: wait. Mock: advance the clock. */
  sleep(ms: number): Promise<void>;
}

export interface TraceEntry {
  step: string;
  /** "ok" or the contract's panic message */
  outcome: string;
  state?: Record<string, unknown>;
}

const id = (n: number) => bytesToHex(randomBytes(n));

export async function runScenario(env: ConformanceEnv): Promise<{ trace: TraceEntry[]; receiptChainsConsistent: boolean }> {
  const { reader, alice, bob, mallory } = env;
  const trace: TraceEntry[] = [];
  const who = (a: string | null | undefined) =>
    a === env.accounts.alice ? "alice" : a === env.accounts.bob ? "bob" : a === env.accounts.mallory ? "mallory" : a ?? null;

  const cfg = await reader.config();
  const nowMs = () => reader.finalTimeMs();

  async function snap(o: { box?: string; grant?: string; blob?: string; deal?: string }): Promise<Record<string, unknown>> {
    const s: Record<string, unknown> = {};
    if (o.box) {
      const b = await reader.box(o.box);
      s.box = b && {
        owner: who(b.owner), kind: b.kind, in_deal: b.in_deal !== null, key_epoch: b.key_epoch, manifest_seq: b.manifest_seq,
        manifest_set: b.manifest_blob !== null, receipts_seq: b.receipts_seq, live_grants: b.live_grants, live_blobs: b.live_blobs,
        has_wrapped_bmk: b.wrapped_bmk.length > 0,
      };
    }
    if (o.grant) {
      const g = await reader.grant(o.grant);
      s.grant = g && { sessions_used: g.sessions_used, revoked: g.revoked_at !== null, epoch: g.epoch, requester_kind: g.requester.split(":")[0] };
    }
    if (o.blob) {
      const b = await reader.blob(o.blob);
      s.blob = b && { state: b.state, leaves: b.leaves, ack_bitmap: b.ack_bitmap, erase_bitmap: b.erase_bitmap };
    }
    if (o.deal) {
      const d = await reader.deal(o.deal);
      s.deal = d && { state: d.state, buyer: who(d.buyer), seller: who(d.seller), funded: d.funded, price: d.price, has_waiting_until: d.waiting_until !== null };
    }
    return s;
  }

  async function step(name: string, fn: () => Promise<unknown>, o?: Parameters<typeof snap>[0]): Promise<void> {
    let outcome = "ok";
    try {
      await fn();
    } catch (e) {
      if (e instanceof ChainUnavailable || !(e instanceof ContractError)) throw e;
      outcome = e.message;
    }
    trace.push({ step: name, outcome, ...(o ? { state: await snap(o) } : {}) });
  }

  const grantArgs = async (boxId: string, req: GrantArgs["requester"], over: Partial<GrantArgs> = {}): Promise<GrantArgs> => {
    const now = await nowMs();
    return { grantId: id(16), boxId, requester: req, mode: "View", notBeforeMs: now, notAfterMs: now + 600_000, maxSessions: 3, scopeHash: id(32), policyHash: id(32), ...over };
  };
  const bearer = () => {
    const seed = new Uint8Array(randomBytes(32));
    return { seed, pk: bytesToHex(sig.publicKey(seed)) };
  };
  const openArgs = async (grantId: string, who: { seed: Uint8Array }, o: { ts?: number; sessionId?: string; sign?: boolean; tamper?: boolean } = {}) => {
    const sessionId = o.sessionId ?? id(16);
    const sessionPk = id(32);
    const ts = o.ts ?? (await nowMs());
    const msg = msgs.openMsg(reader.chainId, reader.contractId, hexToBytes(grantId), hexToBytes(sessionId), hexToBytes(sessionPk), ts);
    const reqSig = o.sign === false ? undefined : bytesToHex(sig.sign(who.seed, msg));
    return { grantId, sessionId, sessionPk: o.tamper ? id(32) : sessionPk, tsMs: ts, ...(reqSig ? { reqSig } : {}) };
  };

  // receipt chain bookkeeping: commitments per box, in order
  const chains = new Map<string, Uint8Array[]>();
  const keep = (boxId: string, c: Uint8Array) => chains.set(boxId, [...(chains.get(boxId) ?? []), c]);
  async function openOk(name: string, boxId: string, grantId: string, req: { seed?: Uint8Array; pk: string } | { account: string }, a: Awaited<ReturnType<typeof openArgs>>, by: Actor) {
    await step(name, async () => {
      await by.openSession(a);
      const s = (await reader.session(a.sessionId))!;
      const digest = "account" in req ? receipt.requesterDigestAccount(req.account) : receipt.requesterDigestBearer(hexToBytes(req.pk));
      keep(boxId, receipt.commitment(hexToBytes(grantId), hexToBytes(a.sessionId), hexToBytes(a.sessionPk), digest, s.opened_at));
    }, { box: boxId, grant: grantId });
  }
  const ack = async (blobId: string) => {
    const b = (await reader.blob(blobId))!;
    const m = msgs.ackMsg(reader.chainId, reader.contractId, b.reg_id, hexToBytes(blobId), b.mode, b.paid_until);
    return { idx: 0, sig: bytesToHex(sig.sign(env.nodeSeed, m)) };
  };
  const eraseSig = async (blobId: string, seed = env.nodeSeed) => {
    const b = (await reader.blob(blobId))!;
    return bytesToHex(sig.sign(seed, msgs.eraseMsg(reader.chainId, reader.contractId, b.reg_id, hexToBytes(blobId))));
  };
  const badSig = "00".repeat(64);
  /** register, certify and (optionally) activate a blob */
  async function makeBlob(boxId: string, name: string, upTo: "registered" | "complete" | "active"): Promise<string> {
    const blobId = id(32);
    await step(`${name}: register`, () => alice.registerBlob({ blobId, boxId, size: 65_536, days: 1 }), { blob: blobId });
    if (upTo === "registered") return blobId;
    await step(`${name}: certify`, async () => bob.certifyBlob(blobId, [await ack(blobId)]), { blob: blobId });
    if (upTo === "complete") return blobId;
    await step(`${name}: activate`, () => alice.activateBlob(blobId), { blob: blobId });
    return blobId;
  }

  // ================================================================== boxes
  const B1 = id(16);
  await step("create_box", () => alice.createBox({ boxId: B1, kind: "Bound", wrappedBmk: new Uint8Array(32).fill(7), maxGrantMs: 3_600_000 }), { box: B1 });
  await step("create_box: duplicate id", () => alice.createBox({ boxId: B1, kind: "Bound", wrappedBmk: new Uint8Array(1), maxGrantMs: 3_600_000 }));
  await step("create_box: ceiling below the minimum", () => alice.createBox({ boxId: id(16), kind: "Bound", wrappedBmk: new Uint8Array(1), maxGrantMs: 1000 }));

  // ================================================================== grants
  const r1 = bearer();
  const now0 = await nowMs();
  const gCeil = await grantArgs(B1, { bearer: r1.pk }, { notBeforeMs: now0, notAfterMs: now0 + 3_600_000, maxSessions: 5 });
  await step("create_grant: exactly the ceiling", () => alice.createGrant(gCeil), { box: B1, grant: gCeil.grantId });
  await step("create_grant: one ms over the ceiling", async () => alice.createGrant(await grantArgs(B1, { bearer: r1.pk }, { notBeforeMs: now0, notAfterMs: now0 + 3_600_001 })));
  await step("create_grant: not_after in the past", async () => alice.createGrant(await grantArgs(B1, { bearer: r1.pk }, { notBeforeMs: now0 - 120_000, notAfterMs: now0 - 60_000 })));
  await step("create_grant: not_after before not_before", async () => alice.createGrant(await grantArgs(B1, { bearer: r1.pk }, { notBeforeMs: now0 + 120_000, notAfterMs: now0 + 60_000 })));
  await step("create_grant: shorter than the minimum", async () => alice.createGrant(await grantArgs(B1, { bearer: r1.pk }, { notBeforeMs: now0, notAfterMs: now0 + 30_000 })));
  await step("create_grant: zero sessions", async () => alice.createGrant(await grantArgs(B1, { bearer: r1.pk }, { maxSessions: 0 })));
  await step("create_grant: too many sessions", async () => alice.createGrant(await grantArgs(B1, { bearer: r1.pk }, { maxSessions: 1001 })));
  await step("create_grant: duplicate id", async () => alice.createGrant(await grantArgs(B1, { bearer: r1.pk }, { grantId: gCeil.grantId })));
  await step("create_grant: not the owner", async () => mallory.createGrant(await grantArgs(B1, { bearer: r1.pk })));
  await step("create_grant: unknown box", async () => alice.createGrant(await grantArgs(id(16), { bearer: r1.pk })));

  // ================================================================== sessions
  const sOpen = await openArgs(gCeil.grantId, r1);
  await openOk("open_session: bearer", B1, gCeil.grantId, r1, sOpen, bob);
  await step("open_session: missing signature", async () => bob.openSession(await openArgs(gCeil.grantId, r1, { sign: false })));
  await step("open_session: bad signature", async () => bob.openSession(await openArgs(gCeil.grantId, r1, { tamper: true })));
  await step("open_session: signed by another key", async () => bob.openSession(await openArgs(gCeil.grantId, bearer())));
  await step("open_session: stale timestamp", async () => bob.openSession(await openArgs(gCeil.grantId, r1, { ts: (await nowMs()) - 120_000 })));
  await step("open_session: replayed session id", async () => bob.openSession(await openArgs(gCeil.grantId, r1, { sessionId: sOpen.sessionId })), { box: B1, grant: gCeil.grantId });
  await step("open_session: unknown grant", async () => bob.openSession(await openArgs(id(16), r1)));

  const rOne = bearer();
  const gOne = await grantArgs(B1, { bearer: rOne.pk }, { maxSessions: 1 });
  await step("create_grant: single session", () => alice.createGrant(gOne), { box: B1 });
  await openOk("open_session: the single session", B1, gOne.grantId, rOne, await openArgs(gOne.grantId, rOne), bob);
  await step("open_session: budget exhausted", async () => bob.openSession(await openArgs(gOne.grantId, rOne)), { grant: gOne.grantId });

  const rLater = bearer();
  const gLater = await grantArgs(B1, { bearer: rLater.pk }, { notBeforeMs: (await nowMs()) + 120_000, notAfterMs: (await nowMs()) + 720_000 });
  await step("create_grant: starts in the future", () => alice.createGrant(gLater));
  await step("open_session: grant not yet valid", async () => bob.openSession(await openArgs(gLater.grantId, rLater)));

  const gAcct = await grantArgs(B1, { account: env.accounts.bob });
  await step("create_grant: named account", () => alice.createGrant(gAcct), { grant: gAcct.grantId });
  await step("open_session: wrong account", async () => mallory.openSession({ grantId: gAcct.grantId, sessionId: id(16), sessionPk: id(32), tsMs: await nowMs() }));
  const acctOpen = { grantId: gAcct.grantId, sessionId: id(16), sessionPk: id(32), tsMs: await nowMs() };
  await step("open_session: the named account", async () => {
    await bob.openSession(acctOpen);
    const s = (await reader.session(acctOpen.sessionId))!;
    keep(B1, receipt.commitment(hexToBytes(gAcct.grantId), hexToBytes(acctOpen.sessionId), hexToBytes(acctOpen.sessionPk), receipt.requesterDigestAccount(env.accounts.bob), s.opened_at));
  }, { box: B1, grant: gAcct.grantId });

  await step("revoke_grant: not the owner", () => mallory.revokeGrant(gCeil.grantId));
  await step("revoke_grant: unknown grant", () => alice.revokeGrant(id(16)));
  await step("revoke_grant", () => alice.revokeGrant(gCeil.grantId), { grant: gCeil.grantId });
  await step("revoke_grant: twice", () => alice.revokeGrant(gCeil.grantId));
  await step("open_session: revoked grant", async () => bob.openSession(await openArgs(gCeil.grantId, r1)));

  // close_session (release-service signature)
  const closeFor = async (sessionId: string, seed: Uint8Array, over: { idx?: number; root?: string; at?: number } = {}) => {
    const root = over.root ?? id(32);
    const at = over.at ?? (await nowMs());
    const sg = bytesToHex(sig.sign(seed, msgs.closeMsg(reader.chainId, reader.contractId, hexToBytes(sessionId), hexToBytes(root), at)));
    return { sessionId, logRoot: root, closedAtMs: at, rsIdx: over.idx ?? 0, rsSig: sg };
  };
  await step("close_session: unknown session", async () => bob.closeSession(await closeFor(id(16), env.rsSeed)));
  await step("close_session: unknown key index", async () => bob.closeSession(await closeFor(sOpen.sessionId, env.rsSeed, { idx: 9 })));
  await step("close_session: wrong key", async () => bob.closeSession(await closeFor(sOpen.sessionId, new Uint8Array(32).fill(5))));
  const closeArgs = await closeFor(sOpen.sessionId, env.rsSeed);
  await step("close_session", async () => {
    await bob.closeSession(closeArgs);
    keep(B1, receipt.closeCommitment(hexToBytes(closeArgs.sessionId), hexToBytes(closeArgs.logRoot), closeArgs.closedAtMs));
  }, { box: B1 });
  await step("close_session: twice", async () => bob.closeSession(await closeFor(sOpen.sessionId, env.rsSeed)));

  // ================================================================== blobs
  const blobA = await makeBlob(B1, "blob A", "registered");
  await step("register_blob: duplicate id", () => alice.registerBlob({ blobId: blobA, boxId: B1, size: 65_536, days: 1 }));
  await step("register_blob: zero size", () => alice.registerBlob({ blobId: id(32), boxId: B1, size: 0, days: 1 }));
  await step("register_blob: zero days", () => alice.registerBlob({ blobId: id(32), boxId: B1, size: 65_536, days: 0 }));
  await step("register_blob: not the owner", () => mallory.registerBlob({ blobId: id(32), boxId: B1, size: 65_536, days: 1 }));
  await step("register_blob: unknown box", () => alice.registerBlob({ blobId: id(32), boxId: id(16), size: 65_536, days: 1 }));
  await step("activate_blob: before certification", () => alice.activateBlob(blobA));
  await step("certify_blob: bad signature", () => bob.certifyBlob(blobA, [{ idx: 0, sig: badSig }]));
  await step("certify_blob: unknown node", async () => bob.certifyBlob(blobA, [{ ...(await ack(blobA)), idx: 5 }]));
  await step("certify_blob: no signatures", () => bob.certifyBlob(blobA, []));
  await step("certify_blob: duplicate signature", async () => bob.certifyBlob(blobA, [await ack(blobA), await ack(blobA)]));
  await step("certify_blob", async () => bob.certifyBlob(blobA, [await ack(blobA)]), { blob: blobA });
  await step("certify_blob: twice", async () => bob.certifyBlob(blobA, [await ack(blobA)]));
  await step("activate_blob: not the owner", () => mallory.activateBlob(blobA));
  await step("activate_blob", () => alice.activateBlob(blobA), { blob: blobA, box: B1 });
  await step("commit_manifest: wrong sequence", () => alice.commitManifest({ boxId: B1, manifestBlob: blobA, seq: 5 }));
  const blobPending = await makeBlob(B1, "blob P", "complete");
  await step("commit_manifest: blob not active", () => alice.commitManifest({ boxId: B1, manifestBlob: blobPending, seq: 1 }));
  await step("commit_manifest: not the owner", () => mallory.commitManifest({ boxId: B1, manifestBlob: blobA, seq: 1 }));
  await step("commit_manifest", () => alice.commitManifest({ boxId: B1, manifestBlob: blobA, seq: 1 }), { box: B1 });
  await step("retire_blob: the current manifest", () => alice.retireBlob(blobA));
  await step("retire_blob: not the owner", () => mallory.retireBlob(blobPending));
  const blobM2 = await makeBlob(B1, "blob M2", "active");
  await step("commit_manifest: second", () => alice.commitManifest({ boxId: B1, manifestBlob: blobM2, seq: 2 }), { box: B1 });
  await step("retire_blob", () => alice.retireBlob(blobA), { blob: blobA, box: B1 });
  await step("retire_blob: twice", () => alice.retireBlob(blobA));
  await step("certify_blob: retired blob", async () => bob.certifyBlob(blobA, [await ack(blobA)]));
  await step("attest_erasure: bad signature", () => bob.attestErasure(blobA, 0, badSig));
  await step("attest_erasure: unknown node", async () => bob.attestErasure(blobA, 7, await eraseSig(blobA)));
  await step("attest_erasure: not retired", async () => bob.attestErasure(blobM2, 0, await eraseSig(blobM2)));
  const eraseA = await eraseSig(blobA);
  await step("attest_erasure: all nodes attested, record removed", () => bob.attestErasure(blobA, 0, eraseA), { blob: blobA, box: B1 });

  // ================================================================== deals
  const BH = id(16);
  await step("create_box: Handover", () => alice.createBox({ boxId: BH, kind: "Handover", wrappedBmk: new Uint8Array(32).fill(9), maxGrantMs: 3_600_000 }), { box: BH });
  const rOld = bearer();
  const gOld = await grantArgs(BH, { bearer: rOld.pk }, { maxSessions: 2 });
  await step("create_grant: before the sale", () => alice.createGrant(gOld), { box: BH, grant: gOld.grantId });
  const envBlob = await makeBlob(BH, "envelope", "complete");
  const offer = async (dealId: string, over: Partial<Parameters<Actor["createDeal"]>[0]> = {}) => ({
    dealId, boxId: BH, buyer: env.accounts.bob, priceYocto: "100000000000000000000000", waitingMs: cfg.min_wait_ms,
    offerExpiresAtMs: (await nowMs()) + 3_600_000, bmkCommit: id(32), envelopeBlob: envBlob, s2Commit: id(32), ...over,
  });
  await step("create_deal: box has no manifest yet", async () => alice.createDeal(await offer(id(16))));
  const manBlob = await makeBlob(BH, "manifest H", "active");
  await step("commit_manifest: handover box", () => alice.commitManifest({ boxId: BH, manifestBlob: manBlob, seq: 1 }), { box: BH });
  const envB1 = await makeBlob(B1, "envelope for the about-me box", "complete");
  await step("create_deal: about-me box", async () => alice.createDeal(await offer(id(16), { boxId: B1, envelopeBlob: envB1 })));
  await step("create_deal: buyer is the seller", async () => alice.createDeal(await offer(id(16), { buyer: env.accounts.alice })));
  await step("create_deal: waiting period too short", async () => alice.createDeal(await offer(id(16), { waitingMs: 1 })));
  await step("create_deal: offer already expired", async () => alice.createDeal(await offer(id(16), { offerExpiresAtMs: (await nowMs()) - 1000 })));
  await step("create_deal: unknown envelope", async () => alice.createDeal(await offer(id(16), { envelopeBlob: id(32) })));
  await step("create_deal: envelope of another box", async () => alice.createDeal(await offer(id(16), { envelopeBlob: envB1 })));
  await step("create_deal: not the owner", async () => mallory.createDeal(await offer(id(16))));
  const D1 = id(16);
  await step("create_deal", async () => alice.createDeal(await offer(D1)), { box: BH, deal: D1 });
  await step("create_deal: duplicate deal id", async () => alice.createDeal(await offer(D1)));
  await step("create_deal: box already in a deal", async () => alice.createDeal(await offer(id(16))));
  await step("create_grant: to a stranger during a deal", async () => alice.createGrant(await grantArgs(BH, { bearer: bearer().pk })));
  await step("register_blob: during a deal", () => alice.registerBlob({ blobId: id(32), boxId: BH, size: 65_536, days: 1 }));
  await step("retire_blob: during a deal", () => alice.retireBlob(envBlob));
  await step("fund_deal: not the buyer", () => mallory.fundDeal(D1, "100000000000000000000000"));
  await step("fund_deal: wrong price", () => bob.fundDeal(D1, "99999999999999999999999"));
  await step("expire_deal: not expired", () => mallory.expireDeal(D1));
  await step("complete_deal: not funded", () => bob.completeDeal(D1));
  await step("fund_deal", () => bob.fundDeal(D1, "100000000000000000000000"), { deal: D1 });
  await step("fund_deal: twice", () => bob.fundDeal(D1, "100000000000000000000000"));
  await step("complete_deal: waiting period not over", () => bob.completeDeal(D1));
  await step("cancel_deal: a third party", () => mallory.cancelDeal(D1));
  await step("cancel_deal: seller, funded", () => alice.cancelDeal(D1), { box: BH, deal: D1 });
  await step("cancel_deal: twice", () => alice.cancelDeal(D1));
  await step("fund_deal: cancelled", () => bob.fundDeal(D1, "100000000000000000000000"));
  await step("complete_deal: cancelled", () => bob.completeDeal(D1));
  await step("claim: nothing to claim", () => bob.claim());

  const D2 = id(16);
  await step("create_deal: second offer", async () => alice.createDeal(await offer(D2)), { box: BH, deal: D2 });
  await step("fund_deal: second offer", () => bob.fundDeal(D2, "100000000000000000000000"), { deal: D2 });
  await env.sleep(cfg.min_wait_ms + 1500);
  await step("complete_deal", () => mallory.completeDeal(D2), { box: BH, deal: D2 }); // anyone may complete
  await step("complete_deal: twice", () => bob.completeDeal(D2));
  await step("open_session: grant from before the sale", async () => bob.openSession(await openArgs(gOld.grantId, rOld)), { grant: gOld.grantId });
  await step("create_grant: the previous owner", async () => alice.createGrant(await grantArgs(BH, { bearer: bearer().pk })));
  await step("create_grant: the new owner", async () => bob.createGrant(await grantArgs(BH, { bearer: bearer().pk })), { box: BH });
  await step("set manifest: the previous owner", () => alice.commitManifest({ boxId: BH, manifestBlob: manBlob, seq: 2 }));

  // receipt chain on B1: recomputed from public data equals the on-chain head
  let consistent = true;
  for (const [boxId, cs] of chains) {
    const b = (await reader.box(boxId))!;
    consistent &&= bytesToHex(receipt.recomputeChain(cs)) === b.receipts_head && b.receipts_seq === cs.length;
  }
  trace.push({ step: "receipt chain recomputed from public data equals the on-chain head", outcome: consistent ? "ok" : "MISMATCH" });
  return { trace, receiptChainsConsistent: consistent };
}
