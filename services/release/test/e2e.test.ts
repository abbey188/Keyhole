// End-to-end protocol loop across the real services and the client store module, on the MOCK chain.
// Covers the thin slice's access path: encrypt, store on three nodes, certify, give access, read and decrypt
// through the release service, revoke, and re-secure with erasure (spec 10: A1, A2, R1, S6).
import { describe, expect, it } from "vitest";
import { aead, bytesToHex, concatBytes, hexToBytes, kdf, merkle, msgs, padme, randomBytes, seal, sha256, sig, split } from "@keyhole/crypto";
import { FakeChain } from "@keyhole/chain";
import { MemoryStore, StorageNode, encodeTicket, signOwnerTicket } from "@keyhole/node";
import { NodeCallError, ReadFailed, prepareBlob, pushBlob, readLeaves } from "@keyhole/store";
import type { NodeApi } from "@keyhole/store";
import { MemoryGrantStore, ReleaseError, ReleaseService, scopeHash } from "../src/index.js";
import type { Scope } from "../src/index.js";
import { OWNER, OWNER_SEED, auth, hexN, pkHex, seed } from "./helpers.js";

const BOX = hexN(0xb1, 16);
const te = new TextEncoder();
const td = new TextDecoder();

async function world() {
  const chain = new FakeChain({ nodeKeys: [pkHex(11), pkHex(12), pkHex(13)], threshold: 2, rsKeys: [pkHex(2)] });
  chain.addFullAccessKey(OWNER, pkHex(3));
  const owner = chain.writer(OWNER);
  await owner.createBox({ boxId: BOX, kind: "Handover", wrappedBmk: new Uint8Array(8), maxGrantMs: 3_600_000 });
  const nodes = [0, 1, 2].map((i) => {
    const store = new MemoryStore();
    const node = new StorageNode({ reader: chain, store, idx: i, seed: seed(11 + i) });
    const api: NodeApi = {
      name: `node${i}`,
      putLeaf: (a) => node.putLeaf(a).catch(wrap),
      ack: (id) => node.ack(id).catch(wrap),
      getLeaves: (a) => node.getLeaves({ ticket: a.ticket, blobId: a.blobId, from: a.from, to: a.to }).catch(wrap),
    };
    return { node, store, api };
  });
  const svc = new ReleaseService({ reader: chain, relayer: chain.writer("relayer.testnet"), store: new MemoryGrantStore(), rsSeed: seed(2), rsIdx: 0 });
  return { chain, owner, nodes, svc };
}
function wrap(e: unknown): never {
  if (e && typeof e === "object" && "status" in e && "code" in e) throw new NodeCallError((e as { status: number }).status, (e as { code: string }).code);
  throw e;
}
type World = Awaited<ReturnType<typeof world>>;

interface StoredItem {
  itemUid: string;
  blobId: string;
  root: string;
  leaves: number;
  size: number;
  /** per segment: where its AEAD unit sits in the blob stream */
  table: { offset: number; len: number }[];
  segmentKeys: Uint8Array[];
}

/** Owner: encrypt pages into AEAD units (spec 02 section 3), build the stream, store it on the nodes, certify, activate. */
async function storeItem(w: World, pages: string[], bmk: Uint8Array, epoch: number): Promise<StoredItem> {
  const itemUid = bytesToHex(randomBytes(16));
  const dek = kdf.itemDek(kdf.epochKey(bmk, epoch), hexToBytes(itemUid));
  const segmentKeys = pages.map((_, s) => kdf.segmentKey(dek, s));
  const units = pages.map((p, s) => aead.seal(segmentKeys[s]!, padme.pad(te.encode(p)), aead.segAad(hexToBytes(BOX), hexToBytes(itemUid), s, pages.length, epoch)));
  const table: StoredItem["table"] = [];
  let off = 0;
  for (const u of units) {
    table.push({ offset: off, len: u.length });
    off += u.length;
  }
  const stream = new Uint8Array(Math.ceil(off / merkle.LEAF_SIZE) * merkle.LEAF_SIZE);
  stream.set(concatBytes(...units), 0);
  const blob = prepareBlob(stream);
  await w.owner.registerBlob({ blobId: blob.blobId, boxId: BOX, size: blob.size, days: 1 });
  const regId = (await w.chain.blob(blob.blobId))!.reg_id;
  const { acks } = await pushBlob({ nodes: w.nodes.map((n) => n.api), blob, regId, threshold: 2 });
  await w.chain.writer("relayer.testnet").certifyBlob(blob.blobId, acks);
  await w.owner.activateBlob(blob.blobId);
  return { itemUid, blobId: blob.blobId, root: blob.root, leaves: blob.leaves, size: blob.size, table, segmentKeys };
}

async function share(w: World, item: StoredItem, n: number, segs = [0, 1, 2]) {
  const s1seed = randomBytes(32);
  const reqSeed = seed(70 + n);
  const grantId = hexN(0xa0 + n, 16);
  const scope: Scope = {
    items: [{ item_uid: item.itemUid, blob_id: item.blobId, segments: segs.map((s) => ({ s, s2: bytesToHex(split.s2(item.segmentKeys[s]!, split.s1(s1seed, hexToBytes(item.itemUid), s))) })) }],
  };
  await w.owner.createGrant({
    grantId, boxId: BOX, requester: { bearer: pkHex(70 + n) }, mode: "View", notBeforeMs: w.chain.now(), notAfterMs: w.chain.now() + 1_800_000,
    maxSessions: 3, scopeHash: scopeHash(scope), policyHash: hexN(2, 32),
  });
  const body = te.encode(JSON.stringify({ scope }));
  await w.svc.putScope(grantId, body, auth(OWNER_SEED, grantId, sha256(body), w.chain.now()));
  return { grantId, s1seed, reqSeed };
}

/** Recipient: everything the viewer does for one page. */
async function viewPage(w: World, link: Awaited<ReturnType<typeof share>>, v: Visit, item: StoredItem, s: number, epoch = 0): Promise<string> {
  const [k] = await w.svc.release(v.token, item.itemUid, [s]);
  const sk = split.combine(split.s1(link.s1seed, hexToBytes(item.itemUid), s), seal.openSealed(v.sk, hexToBytes(k!.sealed)));
  const { ticket } = await w.svc.ticket(v.token, item.blobId);
  const { offset, len } = item.table[s]!;
  const first = Math.floor(offset / merkle.LEAF_SIZE);
  const last = Math.floor((offset + len - 1) / merkle.LEAF_SIZE);
  const leaves = await readLeaves({ nodes: w.nodes.map((n) => n.api), blobId: item.blobId, root: item.root, leaves: item.leaves, from: first, to: last + 1, ticket });
  const bytes = concatBytes(...leaves).subarray(offset - first * merkle.LEAF_SIZE, offset - first * merkle.LEAF_SIZE + len);
  return td.decode(padme.unpad(aead.open(sk, bytes, aead.segAad(hexToBytes(BOX), hexToBytes(item.itemUid), s, item.segmentKeys.length, epoch))));
}

interface Visit {
  token: string;
  sk: Uint8Array;
  sessionId: string;
}
async function visit(w: World, link: { grantId: string; reqSeed: Uint8Array }): Promise<Visit> {
  const sid = randomBytes(16);
  const sk = randomBytes(32);
  const pk = seal.x25519PublicKey(sk);
  const ts = w.chain.now();
  const s = sig.sign(link.reqSeed, msgs.openMsg("testnet", "keyhole.testnet", hexToBytes(link.grantId), sid, pk, ts));
  const r = await w.svc.openSession({ grantId: link.grantId, sessionId: bytesToHex(sid), sessionPk: bytesToHex(pk), ts, sig: bytesToHex(s) });
  return { token: r.token, sk, sessionId: bytesToHex(sid) };
}

const PAGES = ["page one: lease, rent 1,200 a month", "page two: guarantor details", "page three: signatures"];
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ReleaseError ? `${e.status}:${e.code}` : e instanceof ReadFailed ? "read_failed" : String(e);
  }
};

describe("end to end: store, share, read, revoke", () => {
  it("a recipient reads and decrypts pages through the release service and the nodes; the receipt chain records it", async () => {
    const w = await world();
    const item = await storeItem(w, PAGES, seed(99), 0);
    const link = await share(w, item, 1);
    const v = await visit(w, link);
    for (let s = 0; s < 3; s++) expect(await viewPage(w, link, v, item, s)).toBe(PAGES[s]);
    const box = (await w.chain.box(BOX))!;
    expect(box.receipts_seq).toBe(1);
    await w.svc.close(v.token);
    expect((await w.chain.box(BOX))!.receipts_seq).toBe(2);
  });

  it("the ciphertext on the nodes does not contain the plaintext", async () => {
    const w = await world();
    const item = await storeItem(w, PAGES, seed(99), 0);
    const all = concatBytes(...Array.from({ length: item.leaves }, (_, i) => w.nodes[0]!.store.getLeaf(item.blobId, i)!));
    expect(td.decode(all)).not.toContain("lease");
    expect(td.decode(all)).not.toContain("guarantor");
  });

  it("A2 end to end: after revoke nothing more flows, including node reads with a ticket issued earlier", async () => {
    const w = await world();
    const item = await storeItem(w, PAGES, seed(99), 0);
    const link = await share(w, item, 1);
    const v = await visit(w, link);
    expect(await viewPage(w, link, v, item, 0)).toBe(PAGES[0]);
    const { ticket } = await w.svc.ticket(v.token, item.blobId);
    await w.owner.revokeGrant(link.grantId);
    expect(await code(viewPage(w, link, v, item, 1))).toBe("403:denied");
    const direct = await code(readLeaves({ nodes: w.nodes.map((n) => n.api), blobId: item.blobId, root: item.root, leaves: item.leaves, from: 0, to: 1, ticket }));
    expect(direct).toBe("read_failed"); // the nodes check the grant at final too
    expect(await code(visit(w, link))).toBe("403:denied"); // re-open fails
  });
});

describe("R1/S6: revoke and re-secure in Erasable storage", () => {
  it("cached keys open only what was already in hand; the old ciphertext is gone and the new one needs new keys", async () => {
    const w = await world();
    const bmk = seed(99);
    const old = await storeItem(w, PAGES, bmk, 0);
    const link = await share(w, old, 1);
    const v = await visit(w, link);

    // The recipient (adversary) caches the key and a copy of the ciphertext for page 0 while access is live.
    const [k] = await w.svc.release(v.token, old.itemUid, [0]);
    const cachedSk = split.combine(split.s1(link.s1seed, hexToBytes(old.itemUid), 0), seal.openSealed(v.sk, hexToBytes(k!.sealed)));
    const { ticket } = await w.svc.ticket(v.token, old.blobId);
    const copy = await readLeaves({ nodes: w.nodes.map((n) => n.api), blobId: old.blobId, root: old.root, leaves: old.leaves, from: 0, to: old.leaves, ticket });
    const cachedStream = concatBytes(...copy);

    // Owner revokes and re-secures: new item (new uid, DEK, keys), new blob, then retire the old blob.
    await w.owner.revokeGrant(link.grantId);
    const fresh = await storeItem(w, PAGES, bmk, 0);
    await w.owner.retireBlob(old.blobId);
    for (const n of w.nodes) await n.node.sweep(w.chain.writer(`node-${n.api.name}`));

    // What was in hand still decrypts (honest limit: revocation cannot un-share).
    const { offset, len } = old.table[0]!;
    expect(td.decode(padme.unpad(aead.open(cachedSk, cachedStream.subarray(offset, offset + len), aead.segAad(hexToBytes(BOX), hexToBytes(old.itemUid), 0, 3, 0))))).toBe(PAGES[0]);
    // The old key does not open the new ciphertext.
    const newFirst = concatBytes(...(await readLeaves({
      nodes: w.nodes.map((n) => n.api), blobId: fresh.blobId, root: fresh.root, leaves: fresh.leaves, from: 0, to: fresh.leaves,
      ticket: encodeTicket(signOwnerTicket(OWNER_SEED, OWNER, fresh.blobId, w.chain.now() + 60_000)),
    })));
    expect(() => aead.open(cachedSk, newFirst.subarray(fresh.table[0]!.offset, fresh.table[0]!.offset + fresh.table[0]!.len), aead.segAad(hexToBytes(BOX), hexToBytes(fresh.itemUid), 0, 3, 0))).toThrow();
    // Ciphertext fetched after erasure is unavailable, with the old ticket or the owner's.
    expect(await code(readLeaves({ nodes: w.nodes.map((n) => n.api), blobId: old.blobId, root: old.root, leaves: old.leaves, from: 0, to: 1, ticket }))).toBe("read_failed");
    expect(w.nodes.every((n) => n.store.blobs().length === 1)).toBe(true); // only the new blob remains on each node
    expect(await w.chain.blob(old.blobId)).toBeNull(); // all three nodes attested, record removed
  });
});

