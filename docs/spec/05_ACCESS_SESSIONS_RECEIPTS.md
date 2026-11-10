# 05 Access, sessions, receipts and the release service

## 1. The problem this layer solves
Give another person time-limited, scoped, revocable, observable access to encrypted items, where the party enforcing the limits (the release service) is not fully trusted, cannot read the data alone, cannot skip the record, and fails closed.

## 2. Objects
- **Grant** (on-chain, 04): who (bearer key or account), box, epoch, window, session budget, mode, `scope_hash`, `policy_hash`, status. The on-chain grant contains no item names or page numbers; `scope_hash` commits to the scope the owner gave RS.
- **Scope** (off-chain, owner to RS): `[(item_uid, segments[])]` plus per-segment S2 values, plus for Claims mode the allowed claim predicates and a disclosure budget. `scope_hash = SHA-256("keyhole/v1/scope" 0x00 || canonical(scope without S2 values))`. RS recomputes and refuses a scope whose hash differs from the grant's.
- **Link** (to the recipient): `https://<app>/o#<grant_id>.<S1seed>.<req_sk>.<label>` in the fragment. Nothing in the fragment reaches a server. `label` is a display name for the recipient's own notice and the watermark.
- **Session**: one viewing visit, opened on-chain, bounded by the grant window and a lease.
- **Lease**: RS releases keys only inside a lease of at most `MAX_LEASE_MS` (default 5 minutes), renewable while the grant stays valid. Revocation lag is therefore bounded by the lease plus finality.

## 3. Giving access (owner)
1. Owner chooses items and segments, a recipient label and mode, and a duration within the box ceiling.
2. Client generates `grant_id`, `S1seed`, `req_sk`/`req_pk`; computes `S2` for each shared segment (02 section 5) and `scope_hash`.
3. Client calls `create_grant` on the contract with `requester = Bearer(req_pk)` (or `Account(a)` for a named business), prepaying session stakes.
4. Client uploads `Scope` and `S2` vector to RS over TLS: `PUT /v1/grants/{grant_id}/scope`, authenticated by an owner signature over `("keyhole/v1/rs-put" || grant_id || sha256(body) || ts)`. RS verifies the signer is a full-access key of `box.owner` (view `get_box`, `view_access_key`, NEP-413-style [DOCS]) and that the on-chain grant exists with a matching `scope_hash`. Then RS stores the material.
5. Client displays the link once and offers copy and QR; the app also stores a copy encrypted in the box so the owner can re-show it. Anyone with the link can use it: bearer semantics are stated in the UI.

## 4. Opening (recipient), receipt-first
```
Recipient browser                      RS                                  Box contract C
 1. parse fragment: grant_id, S1seed, req_sk, label
 2. generate session keypair (session_sk, session_pk), session_id (16 random bytes)
 3. sig = Ed25519(req_sk, openmsg(grant_id, session_id, session_pk, ts))
 4. POST /v1/sessions {grant_id, session_id, session_pk, ts, sig}  ─►
                                        5. read grant at FINAL; precheck window, status, epoch
                                        6. relay open_session(...) from the RL account ─────────►
                                                                          7. verify sig, window, epoch, budget;
                                                                             store session; update receipt chain;
                                                                             emit session_opened
                                        8. wait until the tx is FINAL and the event is seen ◄─────
                                        9. mint session token; start lease; log event
 10. ◄─ {session token, lease_exp, head, seq, tx_hash}
 11. for each page p to display:
     GET /v1/sessions/{sid}/keys?item=&seg= (token)  ─►
                                        12. re-check grant at FINAL (cached for ≤ 5 s); lease valid;
                                            rate limit; append to signed log
 13. ◄─ sealed(S2_{i,p}) to session_pk
 14. SK = S1_{i,p} XOR S2_{i,p}; fetch the leaves from a node with a ticket; verify; decrypt; render
```
Rule: **RS releases no key before step 8.** If the receipt is not final on-chain, nothing is released ("no receipt, no key"). Because the contract itself verifies the recipient's signature, RS cannot fabricate opens, and because the contract is the only writer of the receipt chain, RS cannot hide opens without withholding keys, which blocks the recipient and is visible to the owner.
Latency budget [DESIGN, measure U7]: finality of one NEAR transaction is a few seconds. The viewer shows "Opening securely" during steps 4 to 10; later page requests need only RS round trips.

## 5. Revocation and expiry
- **Owner revokes:** `revoke_grant` on-chain (authoritative) then `DELETE /v1/grants/{id}` on RS (fast path; RS deletes the S2 vector). Even if the RS call is skipped, RS re-checks the chain at `final` on every key release, so release stops within `finality + cache TTL`.
- **Expiry:** RS compares the grant's `not_after` to the timestamp of the latest `final` block from RPC, never to its own clock (this prevents clock skew attacks and makes RS and nodes agree with the contract).
- **Lease:** a renewal returns a new lease only if the grant is still valid. A viewer mid-session therefore loses access at the next page or renewal after revoke, typically within seconds, at most within one lease if RS caching misbehaves.
- **Epoch bump:** all grants with older epochs fail `open_session` and release checks.
- **Beyond keys:** the segment keys already released to a recipient remain valid for the ciphertext they saw. Strong revocation needs a content re-key in Erasable storage (02 section 6, 03 section 11). The UI offers "Revoke and re-secure" which performs the re-key.

## 6. Receipts
### 6.1 What exists
1. **On-chain:** the chain head and sequence in the box record, plus the `session_opened` event with the commitment (04).
2. **Receipt details:** a JSON record `{seq, grant_id, session_id, requester_digest, label, scope_labels, opened_at, lease_log_root, closed_at?, tx_hash}` stored encrypted in the box (an item of kind `receipt`) by the owner's client (it learns of opens from events or from RS's `GET /v1/boxes/{id}/events` and writes them).
3. **RS signed log:** per session, an append-only list `(t, session_id, item_uid, seg, action)` hash-chained and signed with RS's key; its root is the `log_root` in the optional `close_session`. This gives page-level analytics (which pages were viewed and for how long) that are cryptographically tied to key releases.
4. **Recipient copy:** the viewer lets the recipient save their own receipt (the same JSON) so they can prove what they opened.

### 6.2 Verification procedure (also the "proof drawer")
Given a receipt record: recompute `commitment`; recompute the chain from the previous `head` and compare to the on-chain head at that `seq` (the event or a stored head); check that all sequence numbers 1..seq are present in the owner's records, and that the final head equals `box.receipts_head`. A missing or altered receipt breaks the chain. The proof drawer shows each step with a link to the transaction.
Limit: if RS and the owner client both lose a receipt's details, the commitment remains but its meaning cannot be revealed; the chain still proves that "something" happened at that position. This is deliberate: privacy of the details costs recoverability of the details if nobody keeps them.

### 6.3 Privacy of receipts
On-chain data: box id, grant id, session id (random), sequence, commitment, block time, plus the transaction signer (RL account, not the recipient). The recipient's identity appears only as a digest; the label lives in the encrypted details. Residual leaks: timing and frequency of access to a pseudonymous box. See 09.

## 7. The release service
### 7.1 Responsibilities
Store S2 vectors; read final chain state; relay `open_session`; mint session tokens; release sealed S2 per request; issue node tickets; keep and sign the page-level log; rate-limit; delete material on revoke or expiry; expose `GET /v1/boxes/{id}/events` (owner-authenticated) to feed the owner's receipt store.
### 7.2 API (all TLS, JSON; errors never reveal why beyond a code)
| Endpoint | Auth | Purpose |
|---|---|---|
| `PUT /v1/grants/{id}/scope` | owner signature | store scope and S2 vector |
| `DELETE /v1/grants/{id}` | owner signature | delete material (fast revoke) |
| `POST /v1/sessions` | recipient signature (checked by the contract) | open a session (receipt-first) |
| `GET /v1/sessions/{sid}/keys` | session token | sealed S2 for requested segments, within scope and lease |
| `POST /v1/sessions/{sid}/renew` | session token | extend lease if grant still valid |
| `POST /v1/sessions/{sid}/close` | session token | end session; RS posts `close_session` |
| `POST /v1/tickets` | session token or owner signature | node tickets for blob reads in scope |
| `GET /v1/boxes/{id}/events` | owner signature | receipts and log summaries |
| `GET /v1/deals/{id}/key` | buyer signature | after Completed on-chain, release deal S2 (06) |
| `GET /v1/health`, `GET /v1/pubkeys` | none | liveness; RS and relayer public keys |
### 7.3 Storage and secrets at RS
Per grant: scope and S2 vector, encrypted at rest with a service key held in the host's secret store; session records; signed logs. The RS signing key and relayer key are separate, and their public keys are in the contract config (`rs_keys`) so anyone can verify RS signatures.
### 7.4 Abuse controls
Per-grant and per-IP rate limits on key releases (default 30 segments per minute); one active session per bearer link by default (a second open requires a new session and increments the budget); size limits; no key release outside the scope's listed segments; exponential backoff on invalid signatures. Rate limits also bound how fast a malicious recipient can drain a long document through the viewer, which meaningfully slows bulk exfiltration though it cannot stop a patient one.
### 7.5 Fail-closed rules
RPC unreachable or not at `final` ⇒ no release. Contract view disagrees with RS records (grant missing, scope hash mismatch, epoch mismatch) ⇒ no release. Clock is never consulted. RS restart loses only in-memory leases; recipients re-open (new session consumes budget, which the UI warns about).

## 8. Threshold upgrade of the release service (design, not MVP)
Replace one RS with R services, any `k` of which are needed.
- Owner splits each `S2` with Shamir secret sharing over GF(2^8) per byte (or a 256-bit prime field), one share per service; each service independently checks the chain and releases its share sealed to `session_pk`; the recipient reconstructs from `k` shares.
- `open_session` relay can be done by any one service; the others read the chain.
- Compromising `k-1` services reveals nothing; a malicious minority cannot extend access or skip receipts because each service checks `final` state itself.
- Costs: R round trips, owner uploads R shares per grant.
- Further upgrade paths: run each service in an attested enclave (dstack, Apache-2.0, used by NEAR AI [survey]); or replace services with NEAR's MPC network key derivation (CKD) gated by a contract call [UNVERIFIED; needs a spike]. Either removes "company holds a half" from the trust model.

## 9. Properties and tests
A1 No segment key is released unless `open_session` for that session is final on-chain. A2 No release after revoke, expiry, epoch change or budget exhaustion. A3 RS alone or link alone yields no plaintext (statistical test on shares). A4 Forged opens are rejected by the contract. A5 Duplicate session ids and over-budget opens rejected; one active session per link by default. A6 Release is limited to the scope. A7 Receipt chain recomputation matches the contract. A8 Rate limits hold. A9 Fail-closed on RPC loss. Test mapping in 10.
