# 14 Naming, vocabulary and the box account (decided 2026-11-10, owner's direction)

## 1. Naming decisions
- **Product and space:** **Keyhole**. There is no separate "room" or "vault": signing in opens your Keyhole and you see your boxes. (Name subject to a domain and trademark check, not yet done; "Keyhole" has been used by other companies.)
- **Box** is the central object and is the NFT.
- **No "key" vocabulary** in the product. Access is **access** ("Give access", "End access"). The two-part secret is explained as **two locks**: "Every box has two locks: yours, and one that only opens while you allow it." Cryptographic secrets are never called keys in the UI: the passkey is "your passkey", the backup is "recovery file".
- Tagline candidates: "Show only what fits through the keyhole." and "Ask for proof, not files."

## 2. Public vocabulary
| Public term | Meaning | Internal object |
|---|---|---|
| Keyhole | The product and your space | App; the owner's account |
| Box | A container of files, answers and money | NFT token plus box account |
| About me / Things | The two kinds of box (cannot be handed over / can be handed over) | `Kind::Bound` / `Kind::Handover` |
| Files | Documents, recordings | Encrypted items |
| Answers | Signed facts about the files ("income ≥ X"), with a Source badge | Claims |
| Access | Time-limited, scoped permission for another person | Grant |
| Visit | One opening of an access | Session |
| Receipt | The record of a visit, with See proof | Receipt chain entry |
| End access / End access and re-lock | Revoke / revoke and re-key | `revoke_grant` / re-key |
| Money | What the box holds | Box account balance |
| Hand over / Sale | Move a box to another person, with or without a price | Deal |
| Held payment | Escrow during a sale | Deal escrow |
| Waiting period | Cancel window | `waiting_until` |
| Marked for Maria | Watermark | Viewer watermark |
| Box token | The NFT, shown only in details and the proof drawer | NEP-171 token |
| Box address | The box's NEAR account, shown only in details | Box account |
Optional metaphors (only if the owner wants them): a business's request link as a "Knock".

## 3. Hierarchy
```
Keyhole (product; your space = your account, passkey-controlled)
└─ Box  = one NFT in the Keyhole collection  +  one box account controlled by that NFT
   ├─ Files, Answers      encrypted items and signed claims (storage layer, 03)
   ├─ Access, Receipts    grants, sessions and the receipt chain (05)
   ├─ Money               the box account's balance (NEAR; test token stretch)
   └─ Handover            deal with held payment (06)
```
Only the box is a token. Access is not a token (it must be temporary, revocable and non-transferable); answers are signed files; receipts are chain commitments; your space is your account.

## 4. The box account (the NFT's role) is an optional module, equipped on demand
Decision 2026-11-10 (owner): a box is an NFT that works with data alone. If the owner wants money, they **equip** the Money module, which creates the box account at that moment. Boxes that never hold money have no account, no public balance and no extra cost. `create_box` stays a plain mint; `equip_money(box_id) payable` runs the account-creation batch below; `box_account_of(box_id)` returns `None` until equipped; withdrawals, deposits and the R4 rule apply only to equipped boxes. The UI shows a notice before equipping: "Balance and deposits are public on-chain." Removal (withdraw everything, then delete the account) is a later feature. Deals work the same either way; for an equipped box the money follows the NFT.

The rest of this section describes the module once equipped.
**Idea:** owning the box NFT means owning a real NEAR account with its own address and balance. This is the token-bound-account pattern known from Ethereum (ERC-6551, cited from memory), implemented with NEAR primitives:
- **Creation.** `equip_money` creates, in one atomic batch from the collection contract, creates a direct sub-account `b<random hex>.<collection>`, funds it, attaches the box-account contract by reference to a **global contract published by hash** (immutable), and calls its `init(collection, box_id)` [DOCS: sub-accounts, factories, global contracts]. The account is created with no keys, so it is locked: only its own code can act [DOCS: locked accounts].
- **Why by hash.** A global contract referenced by account id follows later code updates by its publisher (the docs warn that removing keys does not prevent that); by hash it is immutable [DOCS]. The collection and box account code hashes are published in the release manifest.
- **Control.** The box-account contract accepts calls only from the collection contract (`predecessor == collection`). It stores no owner. The collection's NFT owner is the sole authority, so there is no mirror to go stale at handover.
- **Box-account methods (tiny):** `init`; `send_near(to, amount)`; `send_ft(token, to, amount)`; `fastfs_write(receiver, bytes)` (to publish a Permanent or Durable artifact so that the **box account is the FastFS uploader**, giving the box its own public namespace `https://<box account>.fastfs.io/...`; this removes the owner's account from the artifact URL, but it does not make the box unlinkable, because the collection's public owner lookup still maps box to owner); `ft_on_transfer` (accept deposits); view `owner()` (asks the collection).
- **Money inside the box.** Anyone can send NEAR to the box address (a deposit, rent held, a gift). The owner withdraws through the collection: `request_withdrawal(box, to, amount)`, wait `WITHDRAW_DELAY`, `execute_withdrawal` (cancellable). This closes the stolen-passkey drain: an attacker needs the delay to pass unnoticed, and a Handover cannot be rushed either. Withdrawals are blocked while the box is in a deal (rule R4).
- **Handover.** `complete_deal` changes the NFT owner. Because control follows the NFT, the box's money, its address and its public namespace move with it automatically. This is the "money moves with the thing" demo.
- **Privacy (honest).** Box account ids are random and carry no label, but a box's owner, its balance, every deposit and withdrawal, and the senders of deposits are public on-chain, and the collection's owner lookup links each box account to its owner's account. Money inside a box therefore adds public metadata that the files themselves do not. The UI says so next to the Money tab; a readable vanity name is optional and public (a business may want it), off by default. The account's transactions are public like any account's.
- **Cost.** Creating an account costs a fixed 0.007 NEAR plus storage for its small state and the global-contract reference (about 0.01 NEAR per box in total, to be measured) [DOCS].

## 5. Why one box account and not several sub-accounts "inside" the NFT
We considered sub-accounts for each aspect (money, files, access, receipts) and per-recipient accounts for each access.
- Each account costs 0.007 NEAR, adds async cross-account calls and callbacks, and multiplies failure paths, without adding a security property that one account plus the collection's records does not already give.
- Per-recipient accounts would publish recipient names on-chain and clutter explorers.
- The aspects are therefore **tabs backed by one account and the collection's records**: Money is the account balance; Files and Answers live in storage; Access and Receipts live in the collection keyed by box id.
- Future option (not in the MVP): move each box's state into its own box account (one full box contract per box, via global contract) so that boxes shard naturally across NEAR and the receipt trail appears in the box account's own history. The state is already keyed by box id so the move is mechanical; it would make deals two-contract operations and is out of scope now.
- Another future option: deterministic (universal) accounts so that the box address is a hash of its code and initial state, which lets anyone verify a box's rules from its address alone (accounts of this kind are live on testnet and mainnet from protocol 88; the host functions have no SDK wrapper yet) [DOCS].

## 6. Contract changes (additions to 04)
- `create_box` stays a plain mint. New `equip_money(box_id) payable` is the batch (account creation, funding, global contract reference and `init`) with a callback that records the account or refunds on failure.
- New: `request_withdrawal`, `cancel_withdrawal`, `execute_withdrawal` (NEAR first; FT stretch); `box_account_of(box_id)`; rule R4 (no withdrawal during a deal).
- New invariants: C13 the box account accepts calls only from the collection; C14 funds in a box account follow NFT ownership at `complete_deal`; C15 no withdrawal executes before `WITHDRAW_DELAY` or after cancel; C16 no withdrawal executes while the box is in a deal; C17 the box account has no access keys.
- Tests: box account locked (no keys), unauthorized callers rejected, withdrawal delay and cancel, funds follow ownership across a deal (sandbox), deposits from arbitrary senders accepted and accounted, failure injection in account creation (refund path).

## 7. Spike
K12: create a sub-account from a contract with a by-hash global contract reference and `init` in one batch on testnet and in the sandbox; confirm the account is keyless, callable only by the collection, and measure total cost. Fallback if global-contract-by-hash from a contract is unavailable in the SDK: attach a tiny regular contract (a few KB) instead.
