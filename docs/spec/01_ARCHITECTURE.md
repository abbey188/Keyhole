# 01 Architecture

## 1. Purpose in one paragraph
A box is an NFT-represented container of encrypted items. Its owner gives scoped, time-limited access to others, every opening leaves a tamper-evident receipt, access can be taken back with teeth (keys stop and old ciphertext can be erased), and a box can be sold: a buyer's payment sits in escrow and the box, with its keys, changes owner atomically with the payment's release. Security means outsiders cannot read it. Privacy here means others learn only what the owner grants, for as long as granted. We do not provide anonymity (see 09).

## 2. Actors
| Actor | Who | Holds | Trusted for |
|---|---|---|---|
| Owner (O) | Person or business | Passkey; derived NEAR key; data root; all box keys | Everything about their own data |
| Recipient (R) | Landlord, buyer, lawyer, clinic; may have no account | Link fragment (their key half and an ephemeral signing key) | Nothing; assumed able to be malicious after seeing data |
| Release service (RS) | Our service (later threshold set, later enclave) | Second key half per grant; signing key for session logs | Honest enforcement of grant windows, receipt-first rule; availability |
| Storage nodes (SN) | N nodes we run in the demo (default N=3, T=2) | Ciphertext chunks | Availability and erasing on retire; never confidentiality |
| Box contract (C) | NEAR testnet contract, no admin | Box records, grants, receipt hash chain, blob lifecycle, deals, escrow | The only authority on state, time windows and money |
| Relayer (RL) | Part of RS in demo | A funded account that pays gas | Nothing but liveness; cannot forge (contract checks signatures) |
| Enclave model (EM) | NEAR AI Cloud private model | Plaintext during extraction, inside TEE | Not to leak; attested; hardware attacks out of scope |
| Indexer (IX) | Public fastfs.io, or self-hosted | Public copy of Durable/Permanent ciphertext | Nothing secret is in it |

## 3. Components and boundaries
```
                         +-----------------------+
   Owner browser  <----->|  Release service (RS) |<--- reads final state --- NEAR RPC
   (keys, crypto,        |  S2 shares, sessions, |                              |
    viewer, app)         |  signed session logs  |--- relays open/close ------->|
        |  \             +-----------+-----------+                              |
        |   \                        | tickets                                  v
        |    \--- encrypted chunks --+--> Storage nodes (SN1..SNn) <--- events --- Box contract C
        |                                    ^   (replicas, ack, erase)         (boxes, grants,
        |--- Durable/Permanent writes -------|----> FastFS (chain tx args)       receipts, blobs,
        |                                         read via fastfs.io             deals, escrow)
        |--- E2EE calls (extraction/ask) ------> NEAR AI Cloud private model
   Recipient browser: link -> viewer -> RS (open session, page keys) -> SN (chunks)
```
Trust boundaries: (1) browser vs everything else (plaintext lives only here and in EM); (2) RS vs C (RS never decides state; it reads final chain state); (3) SN vs C (nodes sign acks that C verifies; nodes obey chain events); (4) public ciphertext (FastFS) vs private ciphertext (SN).

## 4. Data classification
| Data | Where | Visible to |
|---|---|---|
| Plaintext items | Owner browser, recipient browser while viewing, EM during extraction | Owner, granted recipient |
| Item ciphertext | SN (Erasable/Durable); FastFS (Durable/Permanent) | SN operators, public if FastFS; useless without keys |
| Manifest (names, structure) | Encrypted blob; only its Merkle root is public | Owner, granted recipients as needed |
| Key halves | S1 in recipient link fragment; S2 at RS | See 02 |
| Box record, grants (windows, status, commitments), receipt chain head, blob lifecycle | Chain | Public |
| Receipt details | Encrypted item in the box; commitment on-chain | Owner; recipient copy |
| Deal terms, price, accounts | Chain | Public (accounts pseudonymous) |
| Claims | Encrypted items | Owner and granted recipient |

## 5. Primary flows (each specified fully in a later file)
1. **Create vault:** passkey ceremony yields two PRF outputs; derive NEAR ed25519 key and data root; fund account (sponsored); no wallet words. (02, 08)
2. **Add item:** render pages if document; encrypt chunks; compute Merkle root; register blob on C; upload chunks to SN with inclusion proofs; SN signs acks; submit certificate; activate with new manifest root. (03, 04)
3. **Give access:** owner derives per-grant material; writes grant on C; uploads S2 vector to RS; produces link with S1 seed and ephemeral recipient key. (05)
4. **Open:** recipient posts signed open request to RS; RS relays `open_session` to C; RS waits for final; releases page keys sealed to session key; SN serve chunks against tickets; viewer decrypts and renders with a watermark. (05, 08)
5. **Take back:** `revoke_grant` on C, RS deletes material, optional content re-key and erase. (05)
6. **Close a deal:** offer, evaluate (claims, sampled chunks), fund, wait, complete; ownership, payment and key release follow the chain state. (06)
7. **Claims:** owner client extracts facts in EM at upload, owner reviews and signs; claims are items disclosed under grant policy. (07)

## 6. Design principles (decide ties with these)
1. The chain is the single source of truth for authority and time; no service decides, each reads final state.
2. Fail closed: if RS, RPC or a node is unreachable, access stops; the owner's own access never depends on RS.
3. Put on-chain only what would let a dishonest operator, seller or buyer cheat if it were in our own database.
4. Plaintext never touches a server we operate; the only exception is the enclave, named as such.
5. Every claim in the product has a test; every limit is stated.
6. Parameterize trust: N and T for nodes, RS as set of services, lease lengths; the demo picks values, the spec supports growth.

## 7. Naming
Working name Keyhole (see 14 for the decided vocabulary: Keyhole is the product and your space; Box, Files, Answers, Access, Visit, Receipt, Money, Hand over, Held payment). Internal terms (grant, session, blob, epoch) stay out of the primary UI. The box NFT can optionally be equipped with Money (a box account).
