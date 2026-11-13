# @keyhole/askclaims

Logic for two features of the safe app: **Ask my safe** (B3) and **Claims** (B4). Library only, no screens. Browser-safe: `fetch`, WebCrypto and `@keyhole/*` only; `node:*` appears only in tests.

## What runs where

| Step | Where | Notes |
|---|---|---|
| Page text (OCR / text layer) | device | Input to this package; produced elsewhere |
| Retrieval for Ask (BM25-style scoring, page choice, 6000-character cap) | device | Pages that are not chosen never leave the device |
| Rule extractors (payslip, passport/ID incl. two-line MRZ, lease) | device | Regexes; MRZ check digits are computed |
| Prompt building, strict JSON parsing, citation and value validation | device | The model's reply is untrusted until it passes |
| Model call (`NearAiClient.chatE2ee`) | enclave | Attestation fetched and checked first, then end-to-end encrypted. Only the chosen pages (Ask) or the document pages (claims) are sent |
| Claim build, Ed25519 signing, offline check, disclosure count | device | Owner's claims seed never leaves the device |

## Privacy tiers

Every file-content message is marked `fileContent: true` and every call uses `ceiling: "private"`, so `NearAiClient` refuses a model that is not owned by `nearai` or marked "attested 3p", before any network call. Results carry `tier`:

- `private`: the Private model was called and answered (the answer may still be dropped by validation).
- `device`: the model was not used (nothing relevant found, empty question, or the call failed closed).

If attestation fails, the model is not Private, decryption fails, or the call errors, the result is a `no_answer` or a rules-only reading. Nothing falls back to a routed model or plain text. A transient 502/503 is retried with backoff (1.5 s, 3 s, 6 s) and the statuses retried are returned in `evidence.retried`.

## Ask: `askSafe(question, pages, { client })`

1. Score pages, keep the top few within 25% of the best score (max 5 pages, 6000 characters).
2. If no page matches at least half of the question's content words: `{status: "no_answer", reason: "nothing_relevant", message: "I can't find that in this safe.", tier: "device"}`, **model not called**.
3. Prompt: documents sit between random-boundary `<<<DOCUMENT ...>>>` markers (the boundary is stripped from document text so it cannot be forged), the system prompt states that document text is data and never an instruction, and the reply must be `{answer, citations:[{itemId,page,quote}]}`.
4. Validation: exactly those keys, answer at most 1200 characters, at least one citation, every citation names a page that was sent and its quote appears in that page after case, whitespace and quote-style normalisation. Any failure drops the whole answer (`reason`: `bad_shape`, `no_citations`, `unresolvable_citation`, `answer_too_long`, `model_found_nothing`, `model_error`).
5. Result: answer, citations with `passage_hash` (SHA-256 of the quote) and page, `tier`, `evidence` `{model_id, attestation_report_hash, enclave_signing_address, chat_signature, chat_signature_status, ...}`, and `sent` (exactly which pages left the device).

## Claims: grades

| Grade | Wording (fixed) | When |
|---|---|---|
| B | machine-read and owner-reviewed | rules and the Private model **agreed** on the needed field, and the owner reviewed |
| C | self-declared | the owner typed or edited the value (an edit equal to the agreed reading stays B) |
| A | not produced here | needs an issuer signature; none exists in this package |
| Proved | never produced | needs a zero-knowledge proof; we have none |

The word "verified" is not used for any claim. `verifyClaimOffline` returns `{ok, grade, wording, failures}`.

Flow: `extractRules` -> `crossCheck` (model; disagreements are reported per field, never merged; a model value not found verbatim in the source is discarded) -> owner review -> `buildClaim` -> `signClaim` -> `verifyClaimOffline`. Predicates: `monthly_gross >=`, `monthly_rent <=`, `age >=`, `not_expired`. A claim whose predicate is false is not issued. `DisclosureBudget` counts claims released per grant and refuses beyond the budget (re-releasing the same claim under the same grant costs nothing).

## What is and is not proven

Checked by tests (offline, with a clearly labelled MOCK model; plus live runs):
- A citation that is not a verbatim passage of a page that was sent drops the answer; a reply with a different shape, extra keys, or prose around the JSON is dropped; unselected pages are never in the prompt.
- Instructions inside a document did not change the output shape or cause a leak in the tests (MOCK obeying models and one live injection run). This is test evidence, not a guarantee against every prompt.
- Claim signature (Ed25519, domain `keyhole/v1/claim` 0x00 over canonical JSON): any changed field, wrong key, wrong grade basis, or bad source commitment fails; expired claims fail.
- A model value must appear verbatim in the source text; rule and model must agree for grade B.

**Not proven:**
- That a document is genuine. Grade B means a machine read it and the owner reviewed it. It is not issuer-signed and not a zero-knowledge proof.
- That the model read the document the owner says it read: the enclave signature covers request and response hashes, not what the document was.
- That the claim's source matches the chain: `verifyClaimOffline` checks the commitment structure only; comparing `item_merkle_root` with the on-chain blob is the caller's step (`verifyEvidence` in `@keyhole/ai` does it).
- The attestation is not complete: `attestation_complete` is false while checks such as TCB status are `not_performed` (see `@keyhole/ai`). Ask results report this flag.
- Budget enforcement here is the client-side count; the release service must enforce it for a recipient.
- Rule extractors are written for the synthetic document layouts in the tests; real documents will miss fields (they are then simply absent, never guessed).

## Where EvidenceRecord fits and where it does not

`claim.evidence.extractor` has the shape of `EvidenceRecord["extractor"]` and `extractor_digest` equals `extractorDigest(extractor)`, so the owner's review signature in an `EvidenceRecord` can bind it. It does not fit in two places: a record has one extractor, so the rule extractor (device) next to the model (enclave) is recorded only by `method: "rules+model"`; and the full record needs grant, scope, receipt and chain fields that exist only at disclosure time, so `evidence_ref` is a hash the app uses to assemble it. `chat_signature` is empty when the signature endpoint returned nothing that verified; `verifyEvidence` step 1 then fails for an enclave extractor, which is the intended fail-closed behaviour.

## Tests

`pnpm --filter @keyhole/askclaims test` (offline). Live: `KEYHOLE_LIVE=1 NODE_USE_ENV_PROXY=1 pnpm --filter @keyhole/askclaims test` (placeholder Authorization header; the proxy injects the credential).
