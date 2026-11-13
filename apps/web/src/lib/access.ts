// Giving access (owner) and opening a link (recipient). Spec 05.
//   S1 (half of each segment key) travels only in the link's fragment; S2 (the other half) goes to the release service,
//   which gives it out only while the chain says the grant is valid, after the open is final and recorded.
import { bytesToHex, hexToBytes, kdf, merkle, msgs, randomBytes, rs, seal, sha256, sig, split } from "@keyhole/crypto";
import { HttpNodeApi, readLeaves, rootMatchesBlobId } from "@keyhole/store";
import type { ChainReader, ChainWriter } from "@keyhole/chain";
import { decryptSegment, leafSpan } from "./vault";
import type { ItemRecord } from "./vault";
import type { Identity } from "./keys";

export interface Services {
  releaseUrl: string;
  nodeUrls: string[];
  chainId: string;
  contractId: string;
  fetch?: typeof fetch;
}

const b64u = {
  enc: (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
};

// ---------------------------------------------------------------- the link

export interface SharedSegment { s: number; o: number; n: number; m: string; p?: number; w?: number; h?: number }
export interface SharedItem { u: string; n: string; bl: string; r: string; ss: number; lv: number; t: number; segs: SharedSegment[] }
export interface LinkPayload {
  v: 1;
  /** grant id */ g: string;
  /** S1 seed (hex) */ s: string;
  /** recipient's signing seed (hex) */ k: string;
  /** label the owner chose for the recipient */ l: string;
  /** box id */ b: string;
  /** key epoch */ ep: number;
  /** grant end, ms */ exp: number;
  items: SharedItem[];
}

export const encodeLink = (origin: string, p: LinkPayload) => `${origin}#open=${b64u.enc(JSON.stringify(p))}`;
export function decodeLink(hashOrUrl: string): LinkPayload {
  const m = hashOrUrl.match(/#open=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("This is not a Keyhole link.");
  const p = JSON.parse(b64u.dec(m[1] as string)) as LinkPayload;
  if (p.v !== 1 || !/^[0-9a-f]{32}$/.test(p.g) || !/^[0-9a-f]{64}$/.test(p.s) || !/^[0-9a-f]{64}$/.test(p.k) || !Array.isArray(p.items)) throw new Error("This link is damaged.");
  return p;
}

// ---------------------------------------------------------------- owner: give access

export interface GiveInput {
  id: Identity;
  reader: ChainReader;
  writer: ChainWriter;
  svc: Services;
  boxId: string;
  bmk: Uint8Array;
  epoch: number;
  label: string;
  items: ItemRecord[];
  durationMs: number;
  maxSessions: number;
  origin: string;
}

/** Owner signature accepted by the release service (`rs_put_msg` with a body hash). */
export function ownerAuth(id: Identity, svc: Pick<Services, "chainId">, idHex: string, bodyHash: Uint8Array, ts: number) {
  const m = msgs.rsPutMsg(svc.chainId, hexToBytes(idHex), bodyHash, ts);
  return { "x-ts": String(ts), "x-pk": bytesToHex(sig.publicKey(id.accountSeed)), "x-sig": bytesToHex(sig.sign(id.accountSeed, m)) };
}

export async function giveAccess(a: GiveInput): Promise<{ link: string; grantId: string; txHash: string; payload: LinkPayload }> {
  const f = a.svc.fetch ?? fetch.bind(globalThis);
  if (a.items.length === 0 || a.items.some((i) => !i.shareable)) throw new Error("Choose files that can be shared.");
  const grantId = bytesToHex(randomBytes(16));
  const s1seed = randomBytes(32);
  const reqSeed = randomBytes(32);
  const scope: rs.Scope = { items: [] };
  const shared: SharedItem[] = [];
  for (const it of a.items) {
    const dek = kdf.itemDek(kdf.epochKey(a.bmk, a.epoch), hexToBytes(it.uid));
    const pages = it.segments.filter((s) => s.role === "page"); // originals and owner-only chunks are never put in a grant
    scope.items.push({
      item_uid: it.uid, blob_id: it.blobId,
      segments: pages.map((s) => ({ s: s.s, s2: bytesToHex(split.s2(kdf.segmentKey(dek, s.s), split.s1(s1seed, hexToBytes(it.uid), s.s))) })),
    });
    shared.push({
      u: it.uid, n: it.name, bl: it.blobId, r: it.root, ss: it.streamSize, lv: it.leaves, t: it.segments.length,
      segs: pages.map((s) => ({ s: s.s, o: s.offset, n: s.len, m: s.mime, ...(s.page !== undefined ? { p: s.page } : {}), ...(s.w ? { w: s.w } : {}), ...(s.h ? { h: s.h } : {}) })),
    });
  }
  const now = await a.reader.finalTimeMs();
  const tx = await a.writer.createGrant({
    grantId, boxId: a.boxId, requester: { bearer: bytesToHex(sig.publicKey(reqSeed)) }, mode: "View", notBeforeMs: now,
    notAfterMs: now + a.durationMs, maxSessions: a.maxSessions, scopeHash: rs.scopeHash(scope), policyHash: bytesToHex(new Uint8Array(32)),
  });
  const body = new TextEncoder().encode(JSON.stringify({ scope }));
  const ts = await a.reader.finalTimeMs();
  const res = await f(`${a.svc.releaseUrl}/v1/grants/${grantId}/scope`, { method: "PUT", headers: ownerAuth(a.id, a.svc, grantId, sha256(body), ts), body });
  if (!res.ok) throw new Error(`The release service refused the key halves (${res.status}).`);
  const payload: LinkPayload = { v: 1, g: grantId, s: bytesToHex(s1seed), k: bytesToHex(reqSeed), l: a.label, b: a.boxId, ep: a.epoch, exp: now + a.durationMs, items: shared };
  return { link: encodeLink(a.origin, payload), grantId, txHash: tx.txHash, payload };
}

export async function endAccess(a: { id: Identity; reader: ChainReader; writer: ChainWriter; svc: Services; grantId: string }): Promise<string> {
  const f = a.svc.fetch ?? fetch.bind(globalThis);
  const tx = await a.writer.revokeGrant(a.grantId); // authoritative: the chain
  const ts = await a.reader.finalTimeMs();
  // fast path: the release service drops the key halves at once (it re-checks the chain on every release anyway)
  await f(`${a.svc.releaseUrl}/v1/grants/${a.grantId}`, { method: "DELETE", headers: ownerAuth(a.id, a.svc, a.grantId, sha256(new Uint8Array()), ts) }).catch(() => undefined);
  return tx.txHash;
}

// ---------------------------------------------------------------- recipient

export class AccessEnded extends Error {}

export interface Visit {
  payload: LinkPayload;
  sessionId: string;
  token: string;
  leaseExp: number;
  seq: number;
  head: string;
  txHash: string;
  /** Last characters of the session id, baked into the watermark. */
  tail: string;
  sessionSk: Uint8Array;
}

async function call<T>(f: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const res = await f(url, init);
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) throw new AccessEnded("This access has ended or is not available.");
    throw new Error(j.error === "unavailable" ? "The service can't confirm this right now. Nothing was opened." : `Request failed (${res.status}).`);
  }
  return j as T;
}

/** Receipt-first open: the open is recorded on chain and final before the release service gives out any key. */
export async function openVisit(payload: LinkPayload, reader: ChainReader, svc: Services): Promise<Visit> {
  const f = svc.fetch ?? fetch.bind(globalThis);
  const sessionSk = randomBytes(32);
  const sessionPk = seal.x25519PublicKey(sessionSk);
  const sessionId = randomBytes(16);
  const ts = await reader.finalTimeMs();
  const msg = msgs.openMsg(svc.chainId, svc.contractId, hexToBytes(payload.g), sessionId, sessionPk, ts);
  const r = await call<{ token: string; lease_exp: number; head: string; seq: number; tx_hash: string }>(f, `${svc.releaseUrl}/v1/sessions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_id: payload.g, session_id: bytesToHex(sessionId), session_pk: bytesToHex(sessionPk), ts, sig: bytesToHex(sig.sign(hexToBytes(payload.k), msg)) }),
  });
  return { payload, sessionId: bytesToHex(sessionId), token: r.token, leaseExp: r.lease_exp, seq: r.seq, head: r.head, txHash: r.tx_hash, tail: bytesToHex(sessionId).slice(-6), sessionSk };
}

export const renew = async (v: Visit, svc: Services): Promise<number> =>
  (await call<{ lease_exp: number }>(svc.fetch ?? fetch.bind(globalThis), `${svc.releaseUrl}/v1/sessions/${v.sessionId}/renew`, { method: "POST", headers: { authorization: `Bearer ${v.token}` } })).lease_exp;

export const closeVisit = async (v: Visit, svc: Services): Promise<void> => {
  await (svc.fetch ?? fetch.bind(globalThis))(`${svc.releaseUrl}/v1/sessions/${v.sessionId}/close`, { method: "POST", headers: { authorization: `Bearer ${v.token}` } }).catch(() => undefined);
};

/** Fetches, verifies and decrypts one shared segment. Plaintext exists only in memory. */
export async function viewSegment(v: Visit, item: SharedItem, seg: SharedSegment, svc: Services): Promise<Uint8Array> {
  const f = svc.fetch ?? fetch.bind(globalThis);
  const auth = { authorization: `Bearer ${v.token}` };
  const keys = await call<{ keys: { seg: number; sealed: string }[] }>(f, `${svc.releaseUrl}/v1/sessions/${v.sessionId}/keys?item=${item.u}&seg=${seg.s}`, { headers: auth });
  const k = keys.keys[0];
  if (!k) throw new AccessEnded("No key was released.");
  const sk = split.combine(split.s1(hexToBytes(v.payload.s), hexToBytes(item.u), seg.s), seal.openSealed(v.sessionSk, hexToBytes(k.sealed)));
  const { ticket } = await call<{ ticket: string }>(f, `${svc.releaseUrl}/v1/tickets`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ blob_id: item.bl }) });
  if (!rootMatchesBlobId(item.bl, item.r, item.ss)) throw new Error("This link does not match the stored file.");
  const { from, to, skip } = leafSpan({ offset: seg.o, len: seg.n });
  const nodes = svc.nodeUrls.map((u, i) => new HttpNodeApi(`node${i}`, u, f as never));
  const leaves = await readLeaves({ nodes, blobId: item.bl, root: item.r, leaves: item.lv, from, to, ticket });
  const joined = new Uint8Array(leaves.length * merkle.LEAF_SIZE);
  leaves.forEach((p, i) => joined.set(p, i * merkle.LEAF_SIZE));
  const unit = joined.subarray(skip, skip + seg.n);
  const record = { uid: item.u, segments: new Array(item.t).fill(null).map((_, i) => ({ s: i })) } as unknown as ItemRecord; // only the count matters for the AAD
  return decryptSegment({ bmk: new Uint8Array(0), epoch: v.payload.ep, boxId: v.payload.b, record, s: seg.s, unit, key: sk });
}
