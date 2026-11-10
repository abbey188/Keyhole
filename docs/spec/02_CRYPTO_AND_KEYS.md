# 02 Cryptography and keys

All of this is [DESIGN] unless tagged. Every construction uses standard primitives; we invent no cipher or protocol primitive. Implementations: TypeScript in the browser (noble libraries), Rust in services and contract (RustCrypto / near-sdk host functions). A shared set of test vectors (10) pins both to the same bytes.

## 1. Primitives and domain separation
| Use | Primitive |
|---|---|
| Hash, Merkle | SHA-256 (contract has `env::sha256_array`) |
| KDF | HKDF-SHA256 (RFC 5869) |
| AEAD | XChaCha20-Poly1305, 24-byte random nonce, 16-byte tag (same family as NEAR AI's wire format) |
| Key agreement and sealing | X25519 with ephemeral sender key, HKDF, XChaCha20-Poly1305 (sealed box) |
| Signatures | Ed25519 (NEAR keys, node acks, RS logs, claims) |
| MAC | HMAC-SHA256 |
Every hash or KDF input starts with an ASCII domain tag of the form `keyhole/v1/<purpose>` and a 0x00 byte, so no value can be replayed across purposes. Integers are little-endian, fixed width, unless stated.

## 2. Key hierarchy
```
Passkey (WebAuthn, RP ID fixed)
  PRF eval, two salts, one ceremony:
    prf1 = PRF("keyhole/v1/prf/account")   32 B
    prf2 = PRF("keyhole/v1/prf/data")      32 B
  |
  +-- prf1 --HKDF(info "near-ed25519/" || u32 index)--> NEAR ed25519 seed (index 0 = main account)
  |                                                    index = HKDF-derived per box in private mode
  +-- prf2 --HKDF(info "data-root")--> DR  (data root, 32 B, never leaves the browser)
        +-- HKDF(DR, "box-wrap/" || box_id)  --> W(box)      wraps that box's master key
        +-- HKDF(DR, "x25519/0")             --> owner X25519 keypair (receives handover envelopes)
        +-- HKDF(DR, "claims-ed25519/0")     --> claims signing key (signs claims)
        +-- HKDF(DR, "recovery-check")       --> checksum shown to the user for recovery files

Per box:  BMK  = 32 random bytes at creation
          BK_e = HKDF(BMK, "epoch/" || u32 e)                      epoch key
Per item: item_uid = 16 random bytes (new for every ciphertext)
          DEK  = HKDF(BK_e, "item/" || item_uid)
Per segment s of an item (page or fixed byte range):
          SK_s = HKDF(DEK, "seg/" || u32 s)
```
Why two PRF outputs: key separation. The NEAR signing key and the data root never derive from one another, so a flaw in one use cannot leak the other. Tatchi's SDK uses two PRF outputs for the same reason [CODE, web3-authn/sdk `handle_recover_keypair_from_passkey.rs`: account-specific HKDF over PRF output].

`wrapped_bmk = AEAD(W(box), BMK, aad = box_id || u32 epoch)` is stored on the box record. It is a symmetric ciphertext under a key derived from the passkey secret, so it survives harvest-now-decrypt-later and quantum threats as far as AES-class symmetric security does (Grover halves strength to about 128 bits). The X25519 envelopes below are transient and are the only asymmetric elements; none protects stored ciphertext.

PRF facts: [TESTED] deterministic 32 bytes in a Chromium virtual authenticator; [UNVERIFIED] on real iOS, Android and Windows Hello (U5), and whether synced passkeys (iCloud Keychain, Google Password Manager) return the same PRF on a second device. If a device or browser has no PRF, the app falls back to a passphrase path: Argon2id(passphrase, random salt stored with a recovery file) producing the same `prf1`/`prf2` roles. The fallback is clearly labelled weaker (guessable passphrase, offline attack on the recovery file).

Recovery: a fresh device with the same passkey recovers DR, lists boxes through the contract view `boxes_of(account)`, reads each `wrapped_bmk`, and unwraps. No server is involved. Lost passkey and no recovery file means lost data; the MVP has no guardian recovery.

## 3. Item encoding
### 3.1 Segments
An item is split into **segments**, the smallest independently keyed and releasable unit.
- Documents (PDF, images): the client renders each page to a bitmap (pdf.js), encodes WebP at a fixed target size, and each page is one segment. The original file is also stored as one `original` item with an owner-only key that is never placed in any grant.
- Audio, text, other: fixed-size segments of 256 KiB plaintext (before padding).
- Claims: one segment.

### 3.2 AEAD unit
Each segment becomes one AEAD unit:
```
unit = nonce(24, random) || ciphertext || tag(16)
ciphertext = XChaCha20-Poly1305(SK_s, nonce, plaintext_padded, aad)
aad = "keyhole/v1/seg" 0x00 || box_id(16) || item_uid(16) || u32 s || u32 total_segments || u32 epoch
```
The AAD binds the unit to its box, item, position, total count and epoch, so units cannot be reordered, spliced between items, truncated or replayed across epochs without the tag failing.

Padding: plaintext length is padded with the Padmé scheme (Nikitin et al., PoPETs 2019; cited from memory) to hide exact sizes with at most about 12% overhead, using ISO 7816-4 style padding (0x80 then zeros) inside the AEAD. The blob stream is then padded to a multiple of 64 KiB with an extra AEAD unit of random-looking padding bytes. [DESIGN] The residual leak is a size bucket, listed in 09.

### 3.3 Item record (inside the encrypted manifest)
```
ItemRecord { item_uid, kind, mime, name, plaintext_len, created_at,
             segments: [ { s, offset_in_blob, unit_len, kind(page|range), page_no?, width?, height? } ],
             blob_id, dek_commit }
dek_commit = SHA-256("keyhole/v1/dekc" 0x00 || DEK)
```
`dek_commit` is a key commitment. XChaCha20-Poly1305 is not key-committing (a ciphertext can be crafted to decrypt under two keys), which matters whenever a seller delivers keys to a buyer. Pinning each item to one DEK through a published commitment, and having the buyer check chunks against that DEK, removes the attack (see 06).

### 3.4 Manifest
`Manifest { version, box_id, epoch, items: [ItemRecord], created_at, seq }` encoded as CBOR, then AEAD under `BK_e` with aad `"keyhole/v1/manifest" || box_id || epoch || seq`. Stored as its own small Erasable blob. The contract holds only `manifest_blob_id` and `manifest_seq`. Filenames and structure are never public.

## 4. Blob stream and Merkle tree
A blob is the concatenation of AEAD units (in item order), padded to a multiple of 64 KiB.
- **Leaves:** fixed 64 KiB pieces of the stream. Leaf hash `= SHA-256(0x00 || piece)`; the final piece is a full 64 KiB due to padding.
- **Tree:** RFC 6962 shape: node hash `SHA-256(0x01 || left || right)`, splitting at the largest power of two below the count. Root is 32 bytes.
- **Blob ID:** `blob_id = SHA-256("keyhole/v1/blobid" 0x00 || root(32) || u64 stream_len || u32 leaf_size || u8 version)`. Binds the root to its length and parameters.
- **Transport blocks:** for FastFS writes the stream is cut into 1 MiB blocks (16 leaves each). Because the stream is already padded to 64 KiB, only the last block can be short; FastFS treats a short final part as zero-tailed, and we record the true length in the blob record so readers trim.
- **Range reads:** a reader fetching one page asks a node for the leaves covering `[offset, offset+len)` plus the sibling hashes up to the root. It verifies the range against the on-chain or manifest root without downloading the whole blob (verified streaming, same idea as BLAKE3 bao [DOCS, from memory]).

## 5. Split-key access (time-limited sharing)
Goal: give a recipient time-limited access to chosen segments such that neither the recipient nor the release service alone can decrypt, and the service releases only while the chain says the grant is valid.
```
Owner, per grant g and item i, for each shared segment s:
  S1seed_g = 32 random bytes                      (goes into the link fragment only)
  S1_{i,s} = HKDF(S1seed_g, "s1/" || item_uid || u32 s)
  S2_{i,s} = SK_{i,s} XOR S1_{i,s}                (uploaded to RS, keyed by (grant_id, item_uid, s))
Recipient:
  SK = S1_{i,s} XOR S2_{i,s}                      (S2 fetched from RS inside a session)
```
- XOR with a pseudorandom pad is a one-time-pad share: either share alone is uniformly random and reveals nothing.
- Per-grant `S1seed_g` makes shares per grant, so revoking one grant deletes only that grant's S2 vector.
- RS stores `32 bytes x segments` per grant (a 100-page document is 3.2 KB).
- Release is sealed: RS returns `S2` sealed to the session's ephemeral X25519 key `session_pk` (`[eph 32][nonce 24][ct+tag]`, info `keyhole/v1/seal`), so network intermediaries and RS logs never hold clear shares.
- The link fragment (`#...`) is never sent to any server by the browser. It carries `S1seed_g`, the recipient's ephemeral Ed25519 secret key `req_sk` (its public key is stored in the grant), and the grant id.

### Honest properties
- A recipient who legitimately received `SK_s` can decrypt that segment forever, using any copy of its ciphertext. Revocation prevents future release; it cannot un-share what was released. See 3-mode analysis (9) and the re-key operation below.
- RS plus a leaked link decrypts what the grant covers. RS alone, or the link alone, learns nothing. This is why RS compromise plus phishing is the real attack path, and why the threshold upgrade (05) matters.

## 6. Re-key and epoch bump (revocation with teeth)
| Operation | What changes | What it defeats |
|---|---|---|
| Revoke grant | Contract marks grant revoked; RS deletes the S2 vector | New releases to that grant |
| Epoch bump (`key_epoch += 1`) | All grants carry their epoch; any grant with an older epoch fails at the contract; RS drops those vectors | All existing grants at once (used on handover) |
| Content re-key | New `item_uid`, DEK, segment keys; re-encrypt every segment; register and certify the new blob; retire the old blob so nodes erase it | A recipient (or former owner) who cached keys can no longer decrypt the stored ciphertext, because it is gone |
Content re-key only has teeth in **Erasable** storage. In Durable or Permanent storage the old ciphertext remains public forever, so cached keys keep working. The UI shows each box's revocation strength: Strong (Erasable) or Soft (Durable).

## 7. Sealed box
`seal(pk_x25519, plaintext, info)`: ephemeral X25519 key `e`, `shared = X25519(e, pk)`, `key = HKDF-SHA256(shared, salt none, info)`, XChaCha20-Poly1305, output `e_pub(32) || nonce(24) || ct || tag`. Used for: page-key delivery (info `keyhole/v1/seal`), handover envelopes, and calls to NEAR AI (their info string `ed25519_encryption`, Ed25519 keys converted to X25519) [DOCS].

## 8. Requests and identity binding
- **Bearer links (default):** whoever holds the link is the recipient. The grant stores `requester_pk` (Ed25519). The recipient signs every open request with `req_sk`. Link sharing is possible by design; the watermark and the receipt label are the attribution tools.
- **Named requester:** the grant stores a NEAR `AccountId`; `open_session` must come from that account (`predecessor_account_id`), so the receipt names it. Used for businesses; the app verifies the business's domain (08).
- **Signed messages:** all off-chain signatures are over a canonical byte string beginning with a domain tag and the target contract id, chain id (`testnet`), and a timestamp or nonce, preventing replay across deployments and networks. For wallet-style user authentication we follow NEP-413 [DOCS].

## 9. Optional passkey verification on-chain
NEAR's runtime exposes `p256_verify` [CODE: near-sdk 5.30.1, signature `(sig[64], prehash[32], pubkey[33]) -> bool`], though P-256 is not an account key type [DOCS]. A contract could therefore verify a WebAuthn assertion (authenticatorData, clientDataJSON hash, P-256 signature) so a recipient could act with a passkey and no NEAR account. [UNVERIFIED on testnet: U1.] This is a stretch feature, not used by the MVP.

## 10. What we explicitly do not do
No custom cryptography; no secrets in `localStorage` (keys live in memory, derived on demand from the passkey; an in-memory session cache is cleared on tab close); no server-side key escrow; no key derived from anything the server can influence.

## 11. Implementation notes (added when the protocol crate was built, 2026-11-10)
- Domain tags are `keyhole/v1/<purpose>` plus a zero byte (renamed from the draft `vault/v1/`).
- Variable-length strings in signed messages (chain id, contract id) are length-prefixed with a u16 little-endian length; this prevents `("ab","c")` and `("a","bc")` from encoding identically.
- Merkle inclusion proofs do not authenticate the tree size; readers take the size from the blob record, whose `blob_id` binds the stream length.
- The crate `crates/keyhole-proto` passes RFC 5869 (HKDF), RFC 7748 (X25519), RFC 8032 (Ed25519) and NIST SHA-256 vectors, and its own cross-language vectors in `keyhole/vectors/keyhole-v1.json`.
