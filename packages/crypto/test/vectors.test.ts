import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aead, bytesToHex as hx, hexToBytes as unhex, kdf, merkle, msgs, padme, receipt, seal, sha256, sig, split, utf8 } from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("../../../vectors/keyhole-v1.json", import.meta.url), "utf8"));
const h = (s: string) => unhex(s);

describe("cross-language vectors (Rust is the reference)", () => {
  it("key hierarchy", () => {
    const H = V.hierarchy;
    const prf1 = h(H.prf1);
    const prf2 = h(H.prf2);
    const dr = kdf.dataRoot(prf2);
    const boxId = new Uint8Array(16).fill(0xb0);
    const bmk = h(H.bmk);
    const bk0 = kdf.epochKey(bmk, 0);
    const itemUid = h(H.item_uid);
    const dek = kdf.itemDek(bk0, itemUid);
    expect(hx(kdf.accountSeed(prf1, 0))).toBe(H.account_seed_0);
    expect(hx(kdf.accountSeed(prf1, 1))).toBe(H.account_seed_1);
    expect(hx(dr)).toBe(H.data_root);
    expect(hx(kdf.boxWrapKey(dr, boxId))).toBe(H.box_wrap_key);
    expect(hx(kdf.x25519Secret(dr))).toBe(H.x25519_secret);
    expect(hx(kdf.claimsSeed(dr))).toBe(H.claims_seed);
    expect(hx(bk0)).toBe(H.epoch_key_0);
    expect(hx(kdf.epochKey(bmk, 1))).toBe(H.epoch_key_1);
    expect(hx(kdf.manifestKey(bmk, 0))).toBe(H.manifest_key_0);
    expect(hx(dek)).toBe(H.item_dek);
    expect(hx(kdf.segmentKey(dek, 0))).toBe(H.segment_key_0);
    expect(hx(kdf.segmentKey(dek, 1))).toBe(H.segment_key_1);
    expect(hx(kdf.dekCommit(dek))).toBe(H.dek_commit);
    expect(hx(kdf.bmkCommit(bmk))).toBe(H.bmk_commit);
  });

  it("segment AEAD with padding", () => {
    const S = V.segment;
    const sk0 = h(V.hierarchy.segment_key_0);
    const plaintext = h(S.plaintext);
    const padded = padme.pad(plaintext);
    expect(padded.length).toBe(S.padded_len);
    expect(hx(padded)).toBe(S.padded);
    const boxId = new Uint8Array(16).fill(0xb0);
    const itemUid = h(V.hierarchy.item_uid);
    const a = aead.segAad(boxId, itemUid, 0, 1, 0);
    expect(hx(a)).toBe(S.aad);
    const unit = aead.sealWithNonce(sk0, h(S.nonce), padded, a);
    expect(hx(unit)).toBe(S.unit);
    expect(hx(padme.unpad(aead.open(sk0, unit, a)))).toBe(S.plaintext);
  });

  it("padme lengths", () => {
    for (const p of V.padme) expect(padme.padmeLen(p.len)).toBe(p.padme);
  });

  it("merkle roots, proofs and blob ids", () => {
    for (const t of V.merkle) {
      const leaves = Array.from({ length: t.n }, (_, i) => merkle.leafHash(utf8(`${t.leaf_prefix}${i}`)));
      const r = merkle.root(leaves);
      expect(hx(r)).toBe(t.root);
      const path = merkle.auditPath(leaves, t.proof_index);
      expect(path.map(hx)).toEqual(t.proof);
      expect(merkle.verifyInclusion(leaves[t.proof_index] as Uint8Array, t.proof_index, t.n, path, r)).toBe(true);
      expect(hx(merkle.blobId(r, t.n * 65536, 65536, 1))).toBe(t.blob_id);
    }
  });

  it("split keys", () => {
    const S = V.split;
    const sk0 = h(V.hierarchy.segment_key_0);
    const itemUid = h(V.hierarchy.item_uid);
    const a = split.s1(h(S.seed), itemUid, 0);
    const b = split.s2(sk0, a);
    expect(hx(a)).toBe(S.s1);
    expect(hx(b)).toBe(S.s2);
    expect(hx(split.combine(a, b))).toBe(S.combined);
  });

  it("sealed box", () => {
    const S = V.seal;
    const sk = h(S.recipient_secret);
    expect(hx(seal.x25519PublicKey(sk))).toBe(S.recipient_public);
    const sealed = seal.sealWith(h(S.recipient_public), h(S.plaintext), utf8(S.info), h(S.ephemeral_secret), h(S.nonce));
    expect(hx(sealed)).toBe(S.sealed);
    expect(hx(seal.openSealed(sk, h(S.sealed), utf8(S.info)))).toBe(S.plaintext);
  });

  it("messages, signatures and the receipt chain", () => {
    const M = V.messages;
    const grantId = new Uint8Array(16).fill(0x61);
    const sessionId = new Uint8Array(16).fill(0x62);
    const spk = Uint8Array.from({ length: 32 }, (_, i) => (40 + i) & 0xff);
    const open = msgs.openMsg("testnet", "keyhole.testnet", grantId, sessionId, spk, 1_700_000_000_000);
    expect(hx(open)).toBe(M.open_msg);
    const reqSeed = h(M.requester_seed);
    expect(hx(sig.publicKey(reqSeed))).toBe(M.requester_pk);
    expect(hx(sig.sign(reqSeed, open))).toBe(M.open_sig);
    expect(sig.verify(h(M.requester_pk), open, h(M.open_sig))).toBe(true);
    const rd = receipt.requesterDigestBearer(h(M.requester_pk));
    expect(hx(rd)).toBe(M.requester_digest);
    const c1 = receipt.commitment(grantId, sessionId, spk, rd, 1_700_000_000_000);
    const c2 = receipt.commitment(grantId, new Uint8Array(16).fill(0x63), spk, rd, 1_700_000_100_000);
    expect(hx(c1)).toBe(M.commitment_1);
    expect(hx(c2)).toBe(M.commitment_2);
    const head1 = receipt.chainNext(receipt.GENESIS_HEAD, c1);
    expect(hx(head1)).toBe(M.head_1);
    expect(hx(receipt.chainNext(head1, c2))).toBe(M.head_2);
    expect(hx(receipt.recomputeChain([c1, c2]))).toBe(M.head_2);
    const blob = new Uint8Array(32).fill(0x77);
    const ack = msgs.ackMsg("testnet", "keyhole.testnet", 7, blob, 0, 1_800_000_000_000);
    expect(hx(ack)).toBe(M.ack_msg);
    const nodeSeed = h(M.node_seed);
    expect(hx(sig.publicKey(nodeSeed))).toBe(M.node_pk);
    expect(hx(sig.sign(nodeSeed, ack))).toBe(M.ack_sig);
    expect(hx(msgs.eraseMsg("testnet", "keyhole.testnet", 7, blob))).toBe(M.erase_msg);
    expect(hx(msgs.closeMsg("testnet", "keyhole.testnet", sessionId, new Uint8Array(32).fill(0x88), 1_700_000_200_000))).toBe(M.close_msg);
    expect(hx(msgs.ticketMsg(blob, sessionId, 1_700_000_300_000))).toBe(M.ticket_msg);
  });
});

describe("properties", () => {
  const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

  it("AEAD round-trips random sizes and rejects any bit flip", () => {
    for (let i = 0; i < 100; i++) {
      const key = rnd(32);
      const pt = rnd(Math.floor(Math.random() * 3000));
      const aad = rnd(8);
      const u = aead.seal(key, pt, aad);
      expect(aead.open(key, u, aad)).toEqual(pt);
      const t = u.slice();
      t[Math.floor(Math.random() * t.length)] ^= 1 << Math.floor(Math.random() * 8);
      expect(() => aead.open(key, t, aad)).toThrow("invalid");
    }
  });

  it("AEAD AAD fields are all bound", () => {
    const key = rnd(32);
    const u = aead.seal(key, utf8("secret"), aead.segAad(new Uint8Array(16).fill(1), new Uint8Array(16).fill(2), 3, 10, 0));
    for (const other of [
      aead.segAad(new Uint8Array(16).fill(1), new Uint8Array(16).fill(2), 4, 10, 0),
      aead.segAad(new Uint8Array(16).fill(1), new Uint8Array(16).fill(2), 3, 11, 0),
      aead.segAad(new Uint8Array(16).fill(1), new Uint8Array(16).fill(2), 3, 10, 1),
      aead.segAad(new Uint8Array(16).fill(1), new Uint8Array(16).fill(9), 3, 10, 0),
      aead.segAad(new Uint8Array(16).fill(9), new Uint8Array(16).fill(2), 3, 10, 0),
    ])
      expect(() => aead.open(key, u, other)).toThrow("invalid");
  });

  it("padme round-trips and bounds overhead", () => {
    for (let n = 0; n < 3000; n++) {
      const m = rnd(n);
      expect(padme.unpad(padme.pad(m))).toEqual(m);
      expect(padme.padmeLen(n)).toBeGreaterThanOrEqual(n);
    }
    for (const n of [100, 1000, 12345, 1 << 20, (1 << 20) + 1]) expect(padme.padmeLen(n) - n).toBeLessThanOrEqual(Math.floor(n / 8) + 1);
    expect(() => padme.unpad(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it("merkle: every leaf of every size verifies; tampering fails", () => {
    for (let n = 1; n <= 40; n++) {
      const leaves = Array.from({ length: n }, (_, i) => merkle.leafHash(new Uint8Array([i, n])));
      const r = merkle.root(leaves);
      for (let i = 0; i < n; i++) {
        const p = merkle.auditPath(leaves, i);
        expect(merkle.verifyInclusion(leaves[i] as Uint8Array, i, n, p, r)).toBe(true);
        if (p.length > 0) {
          const bad = p.map((x) => x.slice());
          (bad[0] as Uint8Array)[0] ^= 1;
          expect(merkle.verifyInclusion(leaves[i] as Uint8Array, i, n, bad, r)).toBe(false);
        }
        expect(merkle.verifyInclusion(leaves[(i + 1) % n] as Uint8Array, i, n, p, r)).toBe(n === 1);
      }
    }
  });

  it("sealed box rejects wrong recipient, wrong info, tampering and low-order keys", () => {
    const sk = rnd(32);
    const pk = seal.x25519PublicKey(sk);
    const s = seal.sealTo(pk, utf8("half"));
    expect(seal.openSealed(sk, s)).toEqual(utf8("half"));
    expect(() => seal.openSealed(rnd(32), s)).toThrow();
    expect(() => seal.openSealed(sk, s, utf8("other"))).toThrow();
    const t = s.slice();
    t[t.length - 1] ^= 1;
    expect(() => seal.openSealed(sk, t)).toThrow();
    expect(() => seal.sealTo(new Uint8Array(32), utf8("x"))).toThrow();
  });

  it("receipt chain detects edits, removals and reordering", () => {
    const cs = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(i));
    const head = receipt.recomputeChain(cs);
    const edited = cs.map((c) => c.slice());
    (edited[2] as Uint8Array)[0] ^= 1;
    expect(receipt.recomputeChain(edited)).not.toEqual(head);
    expect(receipt.recomputeChain(cs.filter((_, i) => i !== 3))).not.toEqual(head);
    expect(receipt.recomputeChain([cs[1] as Uint8Array, cs[0] as Uint8Array, ...cs.slice(2)])).not.toEqual(head);
  });

  it("ed25519 RFC 8032 test vector 1", () => {
    const seed = unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    expect(hx(sig.publicKey(seed))).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    expect(hx(sig.sign(seed, new Uint8Array()))).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
  });

  it("sha256 NIST vector", () => {
    expect(hx(sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
