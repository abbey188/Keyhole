# 07 Claims and private AI

## 1. Purpose
Let a recipient decide without receiving the file: they receive an owner-signed **claim** ("monthly income at least X", "rent at most Y", "over 18") under a grant whose policy lists exactly which claims may be disclosed and how many. Private AI is used where it helps and is never treated as proof of truth. This follows the data clean-room idea (answers, not files) but runs per person and per deal, with the owner in the loop.

## 2. Design change from earlier notes, and why
Earlier sketches had a live service run a model over a third party's request. That requires some component to decrypt the owner's documents at request time: if it is our service, our service sees plaintext, which breaks the core promise. The MVP design instead **extracts facts once, at upload, in the owner's browser**, keeps the owner in the loop, and discloses signed claims under policy. A live, free-text Check run by an enclave-hosted service is a later feature (section 11).

## 3. Claim object
Canonicalized with JCS (RFC 8785) before signing.
```
Claim {
  v: 1, claim_id (16 B), box_id, predicate_id, params, result,       // see 4
  source: { item_uid, manifest_seq, blob_id, leaf_range, source_commitment },
  evidence: { grade: "A"|"B"|"C", method, extractor?, issuer? },
  issued_at, expires_at, owner_account, owner_claims_pk,
  sig: Ed25519(claims_sk, domain "keyhole/v1/claim" || JCS(Claim without sig))
}
source_commitment = SHA-256("keyhole/v1/source" 0x00 || blob_id || u32 leaf_start || u32 leaf_end || DEK_commit_of_item)
```
A claim is stored as an item of kind `claim` in the box (one segment, Erasable) and disclosed through the same grant, session and key-release path as any other item. Claims are therefore receipted, rate-limited and revocable like documents.

## 4. Predicates: a small, versioned catalogue
Free-text questions are not supported in the MVP; predicates are typed so outputs are bounded and inference is limited.
| predicate_id | params | result type | Typical source |
|---|---|---|---|
| `income.monthly_gross.gte` | `amount, currency` | bool | payslip, bank statement |
| `income.monthly_gross.bucket` | `bucket_edges[]` | enum index | payslip |
| `employment.current` | none | bool | employment letter |
| `lease.rent_monthly.lte` | `amount, currency` | bool | lease |
| `lease.term_end.after` | `date` | bool | lease |
| `payments.arrears.none` | `months` | bool | ledger, statements |
| `id.age.gte` | `years` | bool | passport/ID |
| `id.name.matches` | `name_digest` | bool | ID |
| `doc.type` | none | enum | any |
Each predicate has a schema for its inputs, a rule for what extracted fields it needs, and a **result domain** (bool or a small enum). New predicates are added by publishing a new catalogue version; claims name their `predicate_id` and catalogue version.

## 5. Extraction pipeline (in the owner's browser)
1. **Render and OCR locally.** Pages are rendered (pdf.js); OCR (a WebAssembly OCR engine such as tesseract.js) produces text plus word boxes. Nothing leaves the device at this stage.
2. **Model extraction, end-to-end encrypted.** For each needed field set, the client sends the OCR text (not the image) to a NEAR AI Cloud **Private** text model with a strict JSON schema in the prompt, `temperature` 0, and the E2EE v2 protocol so the prompt and answer are encrypted to the attested model key [DOCS: near-ai-cloud E2EE]. The E2EE doc lists chat, completions, embeddings and image generation as supported; it does not list images as chat input or the audio and privacy endpoints, so a vision path is [UNVERIFIED U4] and text OCR is the baseline. Candidate model: a Private text model with a large context from the live `/v1/models` listing (the skill's table, which may drift, lists `Qwen/Qwen3-30B-A3B-Instruct-2507`, Private, 262K context, about $0.15 per million input tokens).
3. **Independent cross-check.** The same fields are also extracted by deterministic rules over the OCR text (regular expressions and table parsing). A field reaches grade B only if the rule extraction and the model extraction agree; disagreements are shown to the owner.
4. **Owner review.** The screen shows each extracted field beside the highlighted page region (from OCR boxes) and the exact claim that would be signed. The owner confirms, edits or drops. Any edit downgrades the field to grade C ("self-declared") unless the edit makes it match the rule extraction.
5. **Sign and store.** The client signs the claim with the claims key, stores it as an encrypted item, and records the model attestation material in `evidence.extractor`.

Injection controls: the schema fixes the output shape; the model is told the document is untrusted data; results outside the schema are discarded; the rule cross-check catches text that tries to steer the model; the owner review catches the rest.

## 6. Evidence grades (what each means, no more)
| Grade | Basis | What a verifier can conclude |
|---|---|---|
| A | An issuer's signature over the data (signed PDF, passport chip, verifiable credential, a bank API attestation), verified in the client | The issuer asserts the underlying fact; the claim is a faithful derivation of a signed record |
| B | Machine-read from an image or text, model and rule agree, owner reviewed | A TEE-attested model produced this extraction from some input; the owner, who signed it, vouches. Not proof the document is genuine |
| C | Owner-typed or edited | The owner asserts it |
The verifier (business) sets a minimum grade per request; the UI shows the grade in plain words. We deliberately do not claim that grade B proves the document is real.

### 6.1 What the model attestation does and does not prove
NEAR AI signs, inside the model TEE, the string `{model_id}:{request_hash}:{response_hash}` where the hashes are SHA-256 of the exact request body and response payload [DOCS: chat verification]. Under E2EE the request body contains ciphertext, so:
- The signature proves a TEE-attested model instance produced a response with that hash.
- If the owner reveals the ephemeral secret of that request, a verifier can decrypt the response and compare it to the claim's fields. They then learn the extraction output, not the prompt (the prompt is encrypted to the model key).
- It does **not** prove what document was in the prompt. That gap is why grade B is "machine-read and reviewed", not "verified", and why grade A needs an issuer.
Hardware attestation (NRAS for the GPU, Intel TDX quote for the CPU) binds the `signing_address` to genuine TEEs [DOCS: model verification]. TEE side-channel and physical attacks are out of scope and stated as such.

## 7. Disclosure policy and inference control
A Claims-mode grant carries `policy_hash` committing to: allowed `predicate_id`s with fixed params, a disclosure budget (default 3 claims), a minimum evidence grade, and an expiry no later than the grant's. RS enforces it at release: it knows the list (the owner uploaded it with the scope), counts released claims, and refuses beyond the budget.
Inference risks and controls:
- Bool and small-enum outputs bound leakage per claim; a sequence of threshold claims (`income ≥ 3000`, `≥ 4000`, `≥ 5000`) can narrow a value, so the budget and fixed params limit it, and the owner sees every disclosure in the receipt.
- Claims are fixed at upload time, not computed per request, so a recipient cannot craft adaptive queries.
- Residual: repeated grants to the same recipient can accumulate claims; the owner's receipt view shows cumulative disclosures per recipient label.

## 8. Recipient flow (claims mode)
1. Opens the link; sees the owner's display name, the allowed claims and time left.
2. Chooses a claim; session opens (receipt-first); RS releases the claim item's segment key; the client decrypts and shows: the claim in plain words, the grade, the issue and expiry dates, and a **Verify** button.
3. Verify performs offline checks: owner signature; claim not expired; `source_commitment` against the manifest root the recipient obtains through a chain read of `box.manifest_blob` and a Merkle proof if the owner provided one; for grade A the issuer signature; for grade B the model signature (if the owner revealed the request secret).
4. The recipient can save a "Check Receipt": the claim, evidence, the session receipt and the chain proof in one JSON file, verifiable with a small library.

## 9. Ask my box (owner only)
The owner's browser decrypts the box's items it needs, runs local OCR (cached as an encrypted text index item, one per document, with page and word-box references), and sends the relevant text to a Private model through the E2EE route. Small boxes fit entirely in the context (the Private text model listed has a 262K-token context [DOCS, may drift]), so no embedding index is needed; larger boxes use per-document summaries first and then the pages the summary points to.
- **Answers cite pages.** The prompt carries page tags; the answer must include `[doc, page]` references; the UI shows each as a link that opens the page and highlights the OCR box. An answer without a valid citation is shown with a warning.
- **Nothing is stored by default.** Questions and answers live in memory; the owner may save a note. Usage may be logged locally. The relay sees only ciphertext.
- **Tier is visible:** a badge "Private AI, attested" when attestation passed; the feature refuses to run on an Anonymised model for box contents.
- **Box summary and index suggestions** (what is in this box, suggested folder names, key dates) come from the same pipeline and appear at the top of a box.
- No recipient is involved and no policy applies; it is an owner convenience and the showcase of private inference.

## 9b. Redacted copies (stretch)
Purpose: give a recipient a copy with sensitive parts permanently removed, as existing data rooms offer (AI-assisted PII detection, review, then burn-in).
1. **Detect.** Local OCR gives word boxes. Candidates come from rules (account and card numbers, emails, phone numbers, national id patterns, dates of birth) and, when enabled, NEAR AI's `openai/privacy-filter` classify endpoint over the OCR text, which returns labelled character spans with confidence [DOCS: specialized endpoints]. That endpoint is documented as a dedicated endpoint (TLS terminating inside the TEE), not listed among the E2EE endpoints, so the UI labels this step accordingly and the rules-only mode stays available and fully local.
2. **Map and review.** Spans map to word boxes on the page. The owner sees every proposed redaction, can add custom terms and regions, and must approve each page.
3. **Burn in.** Black rectangles are drawn into the page bitmaps before encoding; text layers, OCR and metadata are not carried over (we render bitmaps, so there is nothing underneath to recover). The result is a new item (new `item_uid`, new keys) named "Redacted for <recipient>", encrypted and shared like any item; the original stays owner-only.
4. **Limits (stated):** detection misses items; OCR can miss text in noisy scans; layout and approximate text length remain visible; redaction hides content, it does not prove anything about the original. Owner review is mandatory and the UI says so.
Tests: Q9 redacted bitmaps contain no recoverable text (OCR the output and search for the redacted strings); Q10 original item keys never appear in the redacted item's grant; Q11 an unreviewed page cannot be shared.

## 10. NEAR AI Cloud integration details
- **Credentials.** An API key must never reach a browser. A small **AI relay** (part of RS) holds the key and forwards requests; with E2EE it forwards ciphertext only. Headers per the E2EE protocol: `X-Signing-Algo: ed25519`, `X-Client-Pub-Key`, `X-Encryption-Version: 2`, and via the gateway `X-Model-Pub-Key` [DOCS]. In the demo the key is ours and the UI says so; production would use the user's own key or staking-funded inference [survey: staking-for-inference].
- **Attestation and key authenticity.** The client must verify the model's attestation itself (a relay that could substitute the key would defeat E2EE). The report endpoint requires an API key [DOCS], so the relay fetches it, and the client verifies: nonce freshness, NRAS JWT claims, TDX quote, and that `signing_address` / `signing_public_key` match what is bound into the report data. We reuse the MIT-licensed verifier [CODE: nearai-cloud-verifier] in TypeScript. If full in-browser verification proves impractical (NRAS reachability from a browser, CORS, quote library size) the fallback is a pinned key fingerprint verified at build time with the full verifier and a clearly stated weaker trust. [UNVERIFIED U4b]
- **Fail closed.** If attestation fails or the key does not match, no data is sent.
- **Models.** Private models only; Anonymised models (Claude, GPT, Gemini via the gateway) see the prompt and are not used for owner documents. The UI shows the privacy tier.
- **Other endpoints** (audio transcription, PII classify) use TLS terminating inside the TEE; the E2EE doc does not list them as E2EE [DOCS], so we label them accordingly and use them only on explicit owner action (meeting-notes feature is out of the MVP).
- **Costs and limits.** Not yet measured (no key): token cost per claim extraction is small (a few thousand tokens), rate limits unknown (U8).

## 11. Later: live Check by an attested service
A service in an attested enclave (dstack-style) that holds both key halves for a "Check-only" grant, decrypts inside the enclave, calls the model, and returns a typed result with an enclave signature. The enclave's attested code identity, published, replaces "trust our service". It requires TEE hosting we do not have for the MVP.

## 12. Limits (stated in product copy)
Models can be wrong, so every claim is owner-reviewed. Extraction quality varies with scan quality; the demo uses clean synthetic documents. Grade B is not proof of authenticity. Claims leak a bounded amount. TEE hardware attacks are out of scope. Claims for sale-relevant documents (income, leases) are still the owner's statements until an issuer signs them.

## 13. Tests
Q1 Claim signature verifies; tampering with any field fails. Q2 Rule and model disagreement yields no grade B. Q3 An edit downgrades to C. Q4 Disclosure budget enforced at RS. Q5 Expired claims rejected by the verifier library. Q6 Fail closed on bad attestation (mock a wrong signing key). Q7 Injection corpus (documents containing instructions) never changes the output shape or sets grade B. Q8 Verifier library works offline on a saved Check Receipt.
