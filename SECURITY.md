# Security

Keyhole is a hackathon prototype on NEAR testnet. It has had no external audit. Do not store real sensitive data in it.

- Threat model, residual risks and the list of what we do **not** claim: `docs/spec/09_THREAT_MODEL_AND_LIMITS.md`.
- Reporting a vulnerability: open a private security advisory on the repository, or contact the maintainers listed in the repository profile. We do not run a bug bounty.
- Known limits that matter most: the release service is a trusted third party for expiry and for deal keys; a recipient keeps whatever they saw; a stolen passkey is full compromise except for delayed sales; the contract has no upgrade path by design; screenshots cannot be prevented.

## Internal security review (2026-11-10/11)
A hostile read of the contract and services. Not an external audit. Fixed items have tests (see `CLAIMS.md`); the open items are known and unfixed.

| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | `delete_grant` refunded the stake of opened sessions while their records stayed, so the contract's balance carried the storage (a cheap way to lock it up) | High | **Fixed** in the v3 contract: used stakes are kept; init refuses a stake smaller than a session record |
| S2 | A sale offer was accepted with no proof the release service held the key half | Medium | **Fixed** in v3: `create_deal` verifies the release service's signed acknowledgement |
| S4 | `set_wrapped_bmk` could grow a record without paying | Low | **Fixed** in v3. A sale still grows the buyer's box list by 16 unpaid bytes |
| S5 | The node erased local data on a single "record missing" answer (a lagging RPC could cause data loss) | High | **Fixed**: erased only after the record stays missing for three sweeps over ten minutes of chain time |
| S7 | Anyone could lock a recipient out of a grant with bad-signature opens (grant ids are public) | Medium | **Fixed**: backoff is per caller and grant |
| S8 | Signed owner requests could be replayed for two minutes | Medium | **Fixed**: each signature is accepted once. The services still speak plain HTTP and need TLS in front |
| S13 | A close that failed on chain could not be retried | Low | **Fixed** |
| S14 | Owner read tickets had no maximum lifetime | Low | **Fixed**: ten minutes |
| S3 | Release-service and node keys are immutable in the contract; a leaked or lost key strands that deployment's boxes (no migration) | Medium, by design | Open |
| S6 | Services trust one RPC endpoint for state, time and access keys (first answer wins) | Medium | Open: needs agreement between independent RPCs and block-height pinning |
| S9 | The relayer's gas can be spent by an owner looping opens and closes | Medium on a paid network | **Mitigated** 2026-11-14: at most 60 relayed opens per box per hour (`relayedOpensPerBoxHour`, `services/release/test/ask.test.ts`); sponsored account creation is separately capped (`RS_SPONSOR_MAX`). Not a per-box funded budget |
| S10 | A read ticket covers a whole blob, so a recipient of one page can copy the ciphertext of the others | Low to medium | Open: tickets should carry a leaf range |
| S11 | Page-level logs and the owner's receipt feed were lost on restart | Medium for the product | Fixed 2026-11-13: records are saved encrypted by the service's store after every change and reloaded on start (`services/release/test/ask.test.ts`). Live visit sessions still end on restart |
| S12 | Per-IP limiting uses the socket address (wrong behind a proxy) | Low | **Fixed** 2026-11-14: with `TRUST_PROXY=1` the limiter uses the last `X-Forwarded-For` hop the proxy appended; the services still need TLS in front (S8) |
| S15 | Someone who sees a relayed open can submit it first; the recipient is then refused | Low | Open |
| S16 | Signature acceptance rules may differ between the services' library and the chain's host function | Low, unverified | Open: needs edge-case vectors |

| S17 | Saved access links (they hold key material) sat in browser storage in plaintext | Medium on a shared computer | **Fixed** 2026-11-14: encrypted under a key from the owner's data root; old copies converted (`apps/web/test/localvault.test.ts`). A stolen unlocked session still reads them |
| S18 | The AI relay (which carries the NEAR AI credential) was open to anyone who could reach it | High if hosted | **Fixed** 2026-11-14: needs an owner token (signed, box owners only) or a live visit on a grant with a question budget; 15 calls per question; 90 requests a minute overall (`services/release/test/relay-gate.test.ts`) |
| S19 | `pdfjs-dist` 5.x: code execution on opening a crafted PDF (GHSA-hq66-cqwq-w95j) | High | **Fixed** 2026-11-14: upgraded to 6.x; PDF flows re-run in a browser |

Web app review (2026-11-14): no `innerHTML`, `eval` or `dangerouslySetInnerHTML`; CSP `default-src 'self'` with no inline script; the link fragment never leaves the browser (`a3.mjs` checks requests); watermark baked into pixels. Dependencies: `pnpm audit --prod` clean; `cargo audit` has one advisory reachable only through test tooling (see `docs/EVIDENCE.md`, RUST-AUDIT). Not reviewed by anyone outside this project.
