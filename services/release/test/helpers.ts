import { bytesToHex, hexToBytes, kdf, msgs, randomBytes, rs, seal, sha256, sig, split } from "@keyhole/crypto";
import { FakeChain } from "@keyhole/chain";
import type { ChainWriter } from "@keyhole/chain";
import { MemoryGrantStore, ReleaseService, authBody, scopeHash } from "../src/index.js";
import type { Auth, GrantStore, Scope } from "../src/index.js";

export const seed = (n: number) => new Uint8Array(32).fill(n);
export const pkHex = (n: number) => bytesToHex(sig.publicKey(seed(n)));
export const hexN = (n: number, len: number) => bytesToHex(new Uint8Array(len).fill(n));

export const NODE_SEED = seed(1);
export const RS_SEED = seed(2);
export const OWNER_SEED = seed(3);
export const OWNER = "alice.testnet";
export const BOX = hexN(0xb1, 16);
export const ITEM = hexN(0x1a, 16);
export const BLOB = hexN(0xc1, 32);

export function auth(signerSeed: Uint8Array, idHex: string, bodyHash: Uint8Array, ts: number): Auth {
  const msg = msgs.rsPutMsg("testnet", hexToBytes(idHex), bodyHash, ts);
  return { ts, pk: bytesToHex(sig.publicKey(signerSeed)), sig: bytesToHex(sig.sign(signerSeed, msg)) };
}

export interface Rig {
  chain: FakeChain;
  owner: ChainWriter;
  relayer: ChainWriter;
  svc: ReleaseService;
  store: GrantStore;
}

export async function rig(opts: { relayer?: ChainWriter; store?: GrantStore; segmentsPerMinute?: number; sponsorMax?: number } = {}): Promise<Rig> {
  const chain = new FakeChain({ nodeKeys: [pkHex(1)], rsKeys: [pkHex(2)] });
  chain.addFullAccessKey(OWNER, pkHex(3));
  chain.addFullAccessKey("bob.testnet", pkHex(4));
  chain.addFullAccessKey("seller.testnet", pkHex(5));
  chain.addFullAccessKey("buyer.testnet", pkHex(6));
  const owner = chain.writer(OWNER);
  await owner.createBox({ boxId: BOX, kind: "Handover", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
  const relayer = opts.relayer ?? chain.writer("relayer.testnet");
  const store = opts.store ?? new MemoryGrantStore();
  const svc = new ReleaseService({ reader: chain, relayer, store, rsSeed: RS_SEED, rsIdx: 0, segmentsPerMinute: opts.segmentsPerMinute, sponsorMax: opts.sponsorMax });
  return { chain, owner, relayer, svc, store };
}

export interface Link {
  grantId: string;
  s1seed: Uint8Array;
  reqSeed: Uint8Array;
  segmentKeys: Uint8Array[];
  scope: Scope;
}

/** What the owner's client does to give access: grant on chain, then S2 vector to RS. */
export async function giveAccess(r: Rig, n = 1, o: { maxSessions?: number; segs?: number; durationMs?: number; policy?: { v: 1; ask?: { budget: number } } } = {}): Promise<Link> {
  const grantId = hexN(0xa0 + n, 16);
  const s1seed = randomBytes(32);
  const reqSeed = seed(60 + n);
  const dek = kdf.itemDek(kdf.epochKey(seed(99), 0), hexToBytes(ITEM));
  const nSegs = o.segs ?? 3;
  const segmentKeys = Array.from({ length: nSegs }, (_, s) => kdf.segmentKey(dek, s));
  const scope: Scope = {
    items: [{
      item_uid: ITEM, blob_id: BLOB,
      segments: segmentKeys.map((sk, s) => ({ s, s2: bytesToHex(split.s2(sk, split.s1(s1seed, hexToBytes(ITEM), s))) })),
    }],
  };
  await r.owner.createGrant({
    grantId, boxId: BOX, requester: { bearer: pkHex(60 + n) }, mode: "View", notBeforeMs: r.chain.now(),
    notAfterMs: r.chain.now() + (o.durationMs ?? 1_800_000), maxSessions: o.maxSessions ?? 3, scopeHash: scopeHash(scope), policyHash: o.policy ? rs.policyHash(o.policy) : hexN(2, 32),
  });
  const body = new TextEncoder().encode(JSON.stringify(o.policy ? { scope, policy: o.policy } : { scope }));
  await r.svc.putScope(grantId, body, auth(OWNER_SEED, grantId, sha256(body), r.chain.now()));
  return { grantId, s1seed, reqSeed, segmentKeys, scope };
}

export interface Visit {
  sessionId: string;
  sessionSk: Uint8Array;
  sessionPk: string;
  token: string;
  leaseExp: number;
  seq: number;
  head: string;
}

export function openRequest(r: Rig, link: Link, sid = randomBytes(16), sessionSk = randomBytes(32)) {
  const sessionPk = seal.x25519PublicKey(sessionSk);
  const ts = r.chain.now();
  const msg = msgs.openMsg("testnet", "keyhole.testnet", hexToBytes(link.grantId), sid, sessionPk, ts);
  return {
    sessionSk,
    req: { grantId: link.grantId, sessionId: bytesToHex(sid), sessionPk: bytesToHex(sessionPk), ts, sig: bytesToHex(sig.sign(link.reqSeed, msg)) },
  };
}

export async function visit(r: Rig, link: Link): Promise<Visit> {
  const { req, sessionSk } = openRequest(r, link);
  const res = await r.svc.openSession(req);
  return { sessionId: req.sessionId, sessionSk, sessionPk: req.sessionPk, token: res.token, leaseExp: res.lease_exp, seq: res.seq, head: res.head };
}

/** Recipient side: unseal S2 and recombine with S1 from the link. */
export function recover(link: Link, v: Visit, seg: number, sealedHex: string): Uint8Array {
  const s2 = seal.openSealed(v.sessionSk, hexToBytes(sealedHex));
  return split.combine(split.s1(link.s1seed, hexToBytes(ITEM), seg), s2);
}

export { authBody, sha256 };
