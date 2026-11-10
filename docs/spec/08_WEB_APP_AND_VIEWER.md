# 08 Web app, viewer and request links

## 1. Shape
One web application, two experiences: the **owner app** (sign in, boxes, files, access, activity, deals) and the **recipient page** (request, viewer, claims). No SDK in the MVP: the link and request formats are documented in the README as the integration surface. The client is written in TypeScript; all cryptography runs in the browser.

## 2. Modules
| Module | Responsibility |
|---|---|
| `crypto` | Pure functions: HKDF, AEAD, sealed box, Merkle, padding, split keys, test vectors (02). No I/O. |
| `passkey` | WebAuthn create/get with PRF; fallback passphrase path; key derivation |
| `chain` | Contract client (view and call), NEP-366 signing, finality waits, event reading, receipt-chain verification |
| `store` | Vault Store client (nodes, tickets, ranged verified reads), FastFS client (Partial uploads, verified reads) |
| `rs` | Release service client (scope upload, sessions, keys, tickets, deal keys) |
| `ai` | AI relay client, attestation verification, E2EE helper |
| `docs` | pdf.js rendering, OCR, claims extraction and review |
| `ui` | Screens, state, copy |
Libraries: noble curves, ciphers and hashes (audited, small, no native code), near-api-js v7 or near-kit for transactions, pdf.js, tesseract.js, Playwright for end-to-end tests. No analytics, no third-party scripts, no CDN-loaded code at runtime (all bundled and hashed).

## 3. Sign-in and account creation
1. **Support check.** Detect WebAuthn and PRF support. If unavailable, show the passphrase path with its weaker-security label.
2. **Create.** `navigator.credentials.create` with `rp.id` fixed to the production domain (the PRF output depends on the credential and RP, so the domain can never change without losing keys), discoverable credential, user verification required, `extensions: { prf: {} }`. Then `get` with `prf.eval = { first: salt1, second: salt2 }` where salts are the byte strings in 02 (the browser and authenticator hash them with a fixed WebAuthn prefix) [TESTED in Chromium virtual authenticator].
3. **Derive** `prf1`, `prf2` into the account key and data root (02) in memory.
4. **Account.** The derived ed25519 public key's hex is a NEAR implicit account. The relayer sends a small sponsored amount (labelled "sponsored on testnet") which creates the account on first transfer; transactions afterwards use NEP-366 delegate actions so the relayer pays gas, while deposits for storage come from the account's own balance. The user sees none of this; the UI says "Your vault is ready".
5. **Unlock model.** Keys are derived on demand and held in memory; a tap (user verification) is required to unlock after a 5-minute idle or tab restore. Nothing secret is written to `localStorage` or IndexedDB (only ciphertext caches are).
6. **No recovery in the MVP beyond the platform's synced passkey and an optional recovery file** (data root encrypted under a passphrase with Argon2id, saved by the user). Copy states plainly that losing both means losing the data.
[UNVERIFIED U5: PRF on real devices, and on synced passkeys across devices.]

## 4. Owner screens
| Screen | Content | Notes |
|---|---|---|
| Home | Boxes as cards: name, kind badge (About me or Things), who has access now, last activity, revocation strength (Strong or Soft) | One primary action: New box |
| New box | Name, kind, storage mode explained in one line each (Erasable by default; Durable and Permanent behind "Advanced") | Kind Things is the default for deals |
| Box: Files | Folder view; drag and drop; per-file status chip; numbered index folders available as a template (00 Start here, 01…) | Upload stages: Preparing, Encrypting, Storing, Confirming |
| Box: Access | Active grants (recipient label, items, time left, opens used), Revoke, and Revoke and re-secure | Shows the human sentence for each grant |
| Box: Activity | Receipt timeline with Proof links; filter by recipient; cumulative claim disclosures per recipient | Verifies the hash chain on load and shows a clear Verified or Broken state |
| Box: Deal | Step bar Offer, Delivered, Funded, Waiting, Done; price and token; cancel window timer; actions per role | Hidden until a deal exists |
| Box: Money | Shown only if equipped; balance, deposit address, withdraw with delay and cancel; notice that balance and deposits are public | Equip Money is a button in Settings with the public-metadata warning |
| Box: Settings | Policy (max grant duration), storage modes, export (download encrypted archive and keys file for the owner), delete box | Delete explains what is erased and what is not |
| Requests inbox | Verified request cards: who, why, what, for how long; Approve (opens Give access prefilled) or Decline | See section 7 |
| Give access sheet | Who (label), what (items; pages if document), how long (1h, 2h, 3h, 24h chips, capped by the box), mode (View or Claims), sentence summary, preview as recipient, Create link | The sentence: "Maria can view 2 files for 2 hours. She cannot download. You can end it any time. Every open is recorded." |
| Link screen | Link, QR, copy, warning that anyone with the link has access | Stored encrypted in the box so it can be re-shown |
| Proof drawer | For any action: transaction link, receipt commitment, chain verification steps, for claims the evidence grade | Reveal button for receipt details |
| Re-secure | Progress for a re-key after revoke or after receiving a box | Blocks box actions until finished |

## 5. Recipient page
States: **Landing** (who shared it, what it contains, how long it lasts, what is recorded, a Continue button), **Opening securely** (receipt-first wait, a short spinner with text), **Viewing**, **Claims**, **Expired**, **Revoked**, **Rate limited**, **Error** (never says why beyond a code). Mobile first: single column, large tap targets. No account, no install. Language says "shared with you", never "NFT" or "blockchain".

### 5.1 Viewer
- **Rendering path.** The client fetches only the leaves for the requested page's segment, verifies them, decrypts, decodes the WebP, and draws it into a `<canvas>`. Pages are decrypted one at a time with a small prefetch of the next page only.
- **Watermark.** After the page bitmap is drawn, the label, a time stamp and the last six characters of the session id are drawn diagonally in a repeating pattern into the canvas pixels (so a screenshot carries it), and a second faint DOM overlay repeats the pattern. The watermark identifies the session; it deters and traces, it does not prevent.
- **Lease and countdown.** A visible countdown to the lease or grant end; at expiry the canvas is cleared, keys are zeroed (best effort), and the page shows Expired.
- **Hygiene (cosmetic).** No download or print button; `@media print` hides content; context menu, drag and text selection disabled on the canvas; content hidden when the tab loses focus. These deter casual copying only. A screenshot or phone photo cannot be blocked, and the product says so.
- **Memory.** Decrypted bitmaps are released when the next page loads; no decrypted data is placed in storage or the service worker.
- **No third-party frames or scripts.** Strict CSP below.

## 6. Upload pipeline
1. File dropped; type detected.
2. Documents: render pages (pdf.js), encode WebP at a fixed target width; keep the original as an `original` item for the owner only.
3. Segment, pad (Padmé), encrypt units, build the blob stream, Merkle tree, `blob_id` (02).
4. `register_blob` (deposit), upload leaves to nodes in parallel with proofs, collect acks, `certify_blob`; for Durable also upload FastFS parts.
5. Build the new manifest, encrypt, upload as a blob, `activate_blob` with the new manifest blob id.
6. Optional claims extraction (07).
Each stage reports progress and is resumable: registered blobs not yet certified can be resumed within `REG_WINDOW`, otherwise abandoned and refunded. Failures show a plain message and a Retry; no partial state is ever shown as complete.
Performance targets [DESIGN, measure S7]: a 20-page PDF prepared and encrypted in a few seconds on a laptop; XChaCha20 and SHA-256 in noble run at tens to hundreds of MB/s, so encryption is not the bottleneck; rendering and OCR are.

## 7. Request links
A business creates a request without any server: a signed payload placed in a link fragment.
```
RequestPayload { v, requester_account, display_name, domain, purpose (<=200 chars),
                 items: [{ type: "income_proof"|"id"|"lease"|..., claims?: [predicate_id+params], view?: bool }],
                 duration_ms, min_grade?, nonce, expires_at, return_url? }
signature = Ed25519 by a full-access key of requester_account over "keyhole/v1/request" 0x00 || chain_id || JCS(payload)
```
The owner app verifies: signature, that the signing key is a full-access key on `requester_account` (RPC `view_access_key`, as NEP-413 verification does [DOCS]), freshness (`expires_at`), and the **domain claim**: it fetches `https://<domain>/.well-known/vault-requester.json` (a JSON list of NEAR account ids) and shows "Verified: landlord.example.com controls this account" or "Not verified". The approval screen shows purpose, items, time and the recipient identity in plain words, and creates a grant with `requester = Account(requester_account)` so the receipt names them. If the fetch fails because of CORS, the fetch goes through the RS (a plain proxy for that one public file). Impersonation of an unverified requester remains possible and is labelled.
For anonymous recipients the owner uses a bearer link instead.

## 8. Deal screens
Seller: Offer form (buyer account, price and token, waiting period shown with the demo shortened tag, preview choices, optional held-back percent and arbiter), steps with plain explanations, cancel button always visible until Done. Buyer: sees the offer, the index preview and any preview or claim grants, Fund button (NEAR, or token transfer with the right call), the waiting timer, then "Re-securing" after completion. Both sides see the same step bar. Mandatory confirm lines before irreversible actions: "This moves the box and releases the payment."

## 9. Content security and integrity of the app itself
- **CSP** (delivered as a response header on our host; as a `<meta>` fallback where headers cannot be set):
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src <contract RPC> <RS> <node hosts> <fastfs.io> <NEAR AI relay>; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'`. Subresource Integrity on every script and style tag. No inline scripts.
- **The web E2EE problem.** Whoever serves the JavaScript can ship code that steals keys. Mitigations: (a) open source and reproducible build; (b) a release manifest `{version, bundle_sha256 per file, commit, contract_id, rs_pubkeys, node_keys}` published as a Permanent FastFS file and referenced in the README, so anyone can compare what the site serves to what was published; (c) a `vault-verify-app` script that fetches the served files and checks them against the manifest; (d) stretch: serve the app itself from FastFS so changing it requires a visible on-chain transaction (limits: no control of response headers, CSP by meta only, and the RP ID would be the fastfs.io subdomain). This reduces but does not remove the risk; the README says so.
- **Dependency hygiene.** Lockfile, pinned versions, a small set of audited cryptographic libraries, a license check (the Papermark and similar repos are AGPL: we copy no code from them).
- **Cross-origin.** Cookies unused; no tokens in URLs except the fragment link; `Referrer-Policy: no-referrer`; the fragment never leaves the browser; the link page strips the fragment from history after parsing (`history.replaceState`).

## 10. Accessibility and polish
Keyboard navigable; labels for all controls; color not the only signal; readable contrast; reduced motion respected; copy in plain language, short sentences; one primary action per screen; honest states for every failure. The demo uses seeded synthetic data and a reset command.

## 11. Tests
W1 End to end with Playwright and a virtual authenticator: sign in, create box, upload, give access, open as recipient in a second browser context, revoke, see failure. W2 Receipt chain verification on load matches the contract. W3 Viewer never exposes decrypted bytes outside the canvas (inspection test). W4 CSP blocks injected inline script. W5 The fragment is not sent in any request (network log assertion). W6 Upload resume after an interrupted run. W7 Deal flow across two contexts, including cancel and complete. W8 Request link verification: tampered payload, wrong key, stale expiry, domain mismatch. Plus mobile viewport screenshots for the recipient page.
