# 06 Deals: handover, escrow and fair exchange

## 1. What a deal is
A deal moves a Handover box from a seller to a buyer in exchange for a price held in escrow. "Hand over" without a price (give a box to someone you trust, heirs) is the same machine with `price = 0`. Bound boxes cannot be in a deal.

## 2. The fair-exchange problem (why this is not trivially atomic)
We want: the buyer gets the keys if and only if the seller gets paid. The contract can make ownership and money atomic. It cannot make the delivery of a secret atomic with them, because a secret cannot be revealed conditionally by a contract without one party revealing first. This is the classical fair-exchange problem; the known result is that it cannot be solved without a trusted third party (Pagnia and Gärtner, 1999; cited from memory, to be checked). Standard escapes: a trusted third party, zero-knowledge contingent payment (a proof that the revealed key decrypts to data with a stated property), or an attested enclave acting as a neutral verifier.

Our choice for the MVP:
- **Ownership and money:** atomic in the contract (`complete_deal`).
- **Key delivery:** a split key where one half goes sealed to the buyer in advance and the other half is held by the release service (RS), which releases it only when the chain says the deal is Completed. RS is the third party for the secret; the contract is the third party for state and money. Trust in RS is explicit and bounded; the upgrade path is threshold RS, then enclave, then NEAR MPC key derivation.
- **Delivery correctness** (the seller could deliver garbage): reduced by pre-payment visibility (index preview, preview grants, claims), by a key commitment, and by an optional held-back tail with an arbiter. It is not eliminated; see section 8.

## 3. Pre-payment evaluation toolkit (the "information paradox" answer)
The buyer needs to judge value without taking the goods. Tools, in the order a buyer uses them:
1. **Index preview.** The manifest is encrypted under its own key `MK = HKDF(BMK, "manifest/" || epoch)`, independent of the item-key derivation. The seller may grant the manifest item to the buyer like any item. The buyer sees names, sizes, counts and each item's `dek_commit`, not content.
2. **Preview items.** Ordinary View grants on items the seller chooses; budgets and watermarks as usual.
3. **Claims.** Owner-signed claims (07) such as "rent ≥ X" or "no arrears" delivered as items, with evidence grades.
4. **Check of the deal's pinned content.** The buyer verifies every claim's `source_commitment` against the pinned manifest.
New grants to the buyer during a deal are permitted (section 5, rule R3), so the evaluation continues while the deal is open.

## 4. Deal record and states
```
Deal { id, box_id, seller, buyer, token: Near|Ft(id), price: u128,
       state, created_at, offer_expires_at, waiting_ms, waiting_until: Option<Ms>,
       manifest_blob: BlobId, manifest_seq: u64,            // pinned at creation; the box is frozen
       bmk_commit: [u8;32],                                 // SHA-256("keyhole/v1/bmk" 0x00 || BMK)
       envelope_blob: Option<BlobId>, s2_commit: Option<[u8;32]>,
       arbiter: Option<AccountId>, hold_back_bps: u16, dispute_until: Option<Ms>,
       funded_amount: u128, deposit: u128 }
```
```
             create_deal                 deliver_envelope               fund_deal / ft_on_transfer
 (none) ───────────────► OFFERED ─────────────────────────► READY ───────────────────────────► FUNDED
                           │ │                                 │ │                                  │ │
                           │ └─ expire_deal (offer_expires) ──┘ │                                  │ │ complete_deal (anyone, now ≥ waiting_until)
                           │                                    │                                  │ ▼
          cancel_deal (seller)  ◄───────── cancel_deal (seller or buyer) ◄───────────────────────┘ COMPLETED
                           ▼                                                                         │ (hold_back>0)
                       CANCELLED (box Open, refund if funded)                                        ▼
                                                                                              DISPUTE_WINDOW ─► SETTLED
```
| Transition | Who | Guards | Effects |
|---|---|---|---|
| `create_deal` | seller (box owner) | box Handover kind and Open; `buyer ≠ seller`; token allowed; `waiting_ms ∈ [MIN_WAIT, MAX_WAIT]`; `offer_expires_at > now`; manifest present; no other deal on the box | pin manifest; box state InDeal; store deal OFFERED; event |
| `deliver_envelope(deal, envelope_blob, s2_commit)` | seller | OFFERED; `envelope_blob` is COMPLETE or ACTIVE and Erasable; `s2_commit` present; RS has acknowledged B2 (see 5) | set READY |
| `fund_deal` or `ft_on_transfer` | buyer | READY; exact `price` of exact `token`; before `offer_expires_at` | `funded_amount = price`; `waiting_until = now + waiting_ms`; FUNDED |
| `cancel_deal` | seller (any time before COMPLETED), buyer (READY or FUNDED) | not COMPLETED | CANCELLED; refund buyer via promise with `claimable` fallback; box Open; RS told to delete B2 |
| `expire_deal` | anyone | OFFERED/READY and now > `offer_expires_at`; or FUNDED never reaching complete because `now > waiting_until + 7 days` and not completed | same as cancel |
| `complete_deal` | anyone | FUNDED; `now ≥ waiting_until`; gas ≥ requirement | owner := buyer; `key_epoch += 1`; box Open; wrapped_bmk cleared and `needs_rekey = true`; pay seller; NEP-171 transfer event; COMPLETED |
Rule R1: `complete_deal` is permissionless so neither party can stall at the last step. R2: a cancel by either party before completion is always allowed, so neither side is locked in; the waiting period is a security window, not a commitment device. R3: while a box is InDeal, content is frozen (no register, activate, retire or manifest change), `create_grant` is allowed only with `requester = Account(deal.buyer)`, and existing grants keep working until expiry; at completion, epoch bump kills all of them.

## 5. Key delivery in detail
Notation: `BMK` box master key; epoch keys and item keys derive from it (02).
1. **Seller prepares at offer time.**
   - Choose `B2 = random 32 bytes`; `B1 = BMK XOR B2`.
   - `envelope = seal(buyer_x25519_pk, B1 || deal_id)`; store it as a small Erasable blob; `deliver_envelope` records its id.
   - `PUT /v1/deals/{id}/s2` to RS with `B2`, authenticated by the seller's signature; `s2_commit = SHA-256("keyhole/v1/dealS2" 0x00 || deal_id || B2)` is posted on-chain so RS cannot later swap `B2`.
   - Buyer's X25519 public key: published by the buyer's app as part of the deal acceptance flow (a small signed message, verified against the buyer's account key) or fetched from a registry blob `x25519/<account>` the buyer's app writes (a Permanent blob signed by the account key).
2. **Before funding** the buyer can check that RS holds a value matching `s2_commit` (RS returns a signed acknowledgement `Sig_RS(deal_id, s2_commit)`; the buyer app verifies against `rs_keys`). The buyer cannot learn `B2`.
3. **After `complete_deal` is final**, the buyer calls `GET /v1/deals/{id}/key` signed with their account key. RS checks the chain at `final`: deal COMPLETED and caller is `deal.buyer`; checks `SHA-256(...B2) == s2_commit`; returns `B2` sealed to the buyer's key.
4. **Buyer finishes:** `B1` from the envelope, `BMK = B1 XOR B2`, verify `SHA-256("keyhole/v1/bmk" || BMK) == bmk_commit`, then decrypt the manifest.
5. **Buyer re-secures immediately (mandatory step in the app):** new `BMK'`, new epoch keys, re-encrypt every item into new Erasable blobs, register and certify and activate them, retire the old blobs so nodes erase the ciphertext the seller's `BMK` opens, then `set_wrapped_bmk` under the buyer's own key. Until this completes the box shows "Re-securing" and the seller still holds a working key to the old ciphertext.
6. **What the seller keeps:** their own memory and any ciphertext copies plus `BMK` they saved. A handover transfers control of the box, not the seller's knowledge. The README states this.

## 6. Escrow and stablecoins
- **Funding:** NEAR via `fund_deal` with an attached deposit equal to the price. FTs via `ft_transfer_call` from the buyer to the contract with `msg = {"deal":"<hex>"}`; `ft_on_transfer` validates `predecessor ∈ allowed_tokens`, `sender_id == deal.buyer`, `amount == price`, state READY, and returns `U128(0)` (nothing refunded) on success; on any failure it returns the full amount so the token contract refunds [DOCS: FT standard].
- **Registration:** the contract must be registered with each allowed token before it can hold that token. On NEP-141 tokens anyone can register another account by calling `storage_deposit` with `account_id` set to the contract and paying the deposit [DOCS: FT integration, storage registration], so the launch script does this for every allowed token and the launch checklist asserts `storage_balance_of(contract)` is non-null. The contract itself, having no keys, never needs to sign for this.
- **Payout:** on complete, effects first (state, ownership, accounting), then a promise `transfer` or `ft_transfer(seller, amount)` with 1 yoctoNEAR, then callback `on_payout`. If the promise fails (seller unregistered on the token, token paused), the callback credits `claimable[(seller, token)]`; the seller calls `claim(token)` after fixing registration. Refunds use `on_refund` the same way.
- **Conservation (C6):** for every deal, `funded_amount = paid_to_seller + refunded_to_buyer + credited + held_back`, each unit at most once. Re-entrancy cannot double-spend because state is final before promises are created.
- **Issuer risks:** a stablecoin issuer can freeze balances or pause transfers; a failed payout then sits in `claimable` and the state stays correct. Only allow-listed token contracts are accepted, fixed at init.
- **Decimals and price entry:** prices are integers in the token's smallest unit; the UI shows the human amount and asks the user to confirm.
- **Testnet:** if a testnet stablecoin is unavailable we deploy a test token contract and the UI labels it as a mock token; the contract logic is identical.

## 7. Optional dispute path (stretch; defined so the design is complete)
If `hold_back_bps > 0` and an `arbiter` is set at offer: at completion the seller receives `price * (10000 - hold_back_bps) / 10000`, the rest stays held until `dispute_until = now + dispute_ms`. In that window the buyer may call `dispute(deal)`; the arbiter then calls `resolve(deal, to_seller_bps)` and the held amount splits accordingly. If nobody disputes, or the arbiter is silent past `dispute_until + ARBITER_TIMEOUT`, the held amount releases to the seller. The contract never judges content; it enforces the arbiter's split and the timeouts. Evidence for the arbiter comes from the buyer's decrypted data and the seller-signed manifest (the seller signs the manifest with the claims key, so a garbage delivery leaves signed evidence).

## 8. Remaining risks in deals (stated plainly)
| Risk | Status |
|---|---|
| RS is a third party for `B2` | Accepted for the MVP; threshold RS or enclave removes it (05 section 8). If RS disappears after completion the buyer is paid-out but keyless |
| Seller delivers undecryptable or wrong data | Reduced by index preview, preview grants, claims, `bmk_commit`, `dek_commit`, optional held-back tail and arbiter; not eliminated. ZK contingent payment or an enclave verifier would close it (future) |
| Buyer previews everything and refuses to complete | Seller chooses how much preview to give; budgets and watermarks apply; it is a policy decision, not a protocol bug |
| Stolen seller key starts a deal to an attacker | The waiting period and cancel; the real owner is notified by the app (and watching events) and cancels |
| Stolen buyer key | Attacker can fund and complete; buyer loses funds; waiting period applies to buyer cancel too |
| Griefing by cancel at the last second | Allowed; costs nothing; seller re-offers; documented |
| Seller keeps `BMK` and old ciphertext | Acknowledged limit |
| Front-running at `complete_deal` | Anyone can complete; result is deterministic, no one gains by racing |

## 9. Formal model (to be model-checked, see 10)
State: `box_state ∈ {Open, InDeal}`, `owner`, `epoch`, `deal ∈ {None, Offered, Ready, Funded, Completed, Cancelled}`, `escrow`, `seller_credit`, `buyer_credit`, `rs_has_B2`, `rs_released`, `time` (discrete ticks), parties `{S, B, A}` where `A` can act only with a stolen key of `S` or `B` in some scenarios, and an RS that is `honest` or `faulty (releases early or never)`.
Actions: every contract method with its guards, plus time advance, plus RS release, plus payout success or failure.
Properties (must hold in all reachable states for an honest RS): (P1) `owner = B` implies money ≥ `price` credited or paid to S (or held back); (P2) `rs_released` implies `deal = Completed`; (P3) `escrow` is never negative and conserved; (P4) no deal state transition after Cancelled or Completed except settlement; (P5) after `Completed`, `epoch` increased and every earlier grant is invalid; (P6) a stolen-key `create_deal` can always be cancelled by the true owner before `waiting_until`; (P7) a box in a deal has constant manifest. For a faulty RS the checker reports which properties fail, documenting the trust exactly.
